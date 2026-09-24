import express, {
  type ErrorRequestHandler,
  type Express,
  type Request,
  type Response,
} from "express";
import type { Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import {
  createMcpHandler,
  PROTOCOL_VERSION_META_KEY,
  type McpHttpHandler,
} from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { makeServer, SERVER_VERSION } from "../server.js";
import { messageOf } from "../cause.js";
import { isJsonString, type JsonObject, type JsonValue } from "../json.js";
import { extractTokenHttp } from "../auth/token.js";
import {
  inspectAccessToken,
  type VerifiedOAuthIdentity,
} from "../auth/verify.js";
import { makeClient } from "../api/client.js";
import {
  factsOf,
  fetchMcpContext,
  refusesCredential,
  RememberedAnswers,
  viewOf,
} from "../api/mcp-context.js";
import {
  analyticsEnabled,
  currentAnalyticsContext,
  flushAnalytics,
  withAnalyticsContext,
  type AnalyticsIdentity,
  type McpAnalyticsContext,
} from "../analytics.js";
import serverManifest from "../../server.json";
import {
  answeredView,
  PUBLIC_RELEASES,
  PUBLIC_VIEW,
  type Releases,
  type ReleaseView,
} from "../releases.js";
import { runtimeSetting, runtimeSiteUrl } from "../runtime-config.js";
import { requiredScopeForTool } from "../tools/index.js";

const SESSION_HEADER = "mcp-session-id";

export interface AnalyticsCredentialProbe {
  status: "valid" | "invalid" | "indeterminate";
  identity?: AnalyticsIdentity;
  suppressAnalytics?: boolean;
  captureAllowed?: boolean;
  workspaceCredential?: boolean;
  releases?: Releases;
}

type AnalyticsCredentialProbeFn = (
  token: string,
) => Promise<AnalyticsCredentialProbe>;

interface HttpAppOptions {
  credentialProbe?: AnalyticsCredentialProbeFn;
}

async function probeCredential(
  token: string,
): Promise<AnalyticsCredentialProbe> {
  try {
    const context = await fetchMcpContext(makeClient(token));
    const probe: AnalyticsCredentialProbe = { status: "valid" };

    if (context.analytics_user_id) {
      probe.identity = {
        distinctId: context.analytics_user_id,
        personless: context.analytics_personless === true,
      };
    }

    const facts = factsOf(context);
    probe.suppressAnalytics = context.analytics_suppressed === true;
    probe.captureAllowed = context.analytics_capture_allowed === true;
    probe.workspaceCredential = facts.workspace;
    probe.releases = facts.releases;

    return probe;
  } catch (cause) {
    // Anything but a refusal leaves the probe indeterminate, so an identity
    // outage degrades analytics instead of blocking traffic.
    return { status: refusesCredential(cause) ? "invalid" : "indeterminate" };
  }
}

/**
 * The per-request probe, or `undefined` where none runs (a test app built with
 * no injected probe). Asked on every request, never cached: a revoked credential
 * has to stop passing on its next call. Only an `invalid` answer refuses the
 * request; an outage degrades analytics to off and the tool surface to the last
 * answer the API gave (`credentialView`) instead of becoming a product outage.
 */
async function probeRequestCredential(
  options: HttpAppOptions,
  token: string,
): Promise<AnalyticsCredentialProbe | undefined> {
  const shouldProbe =
    options.credentialProbe !== undefined ||
    analyticsEnabled() ||
    process.env.NODE_ENV !== "test";

  if (!shouldProbe) return undefined;

  return (options.credentialProbe ?? probeCredential)(token);
}

/**
 * One handler serves BOTH protocol eras: 2026-07-28 requests on the modern path,
 * 2025-era ones through the default `legacy: 'stateless'` fallback (which also
 * answers GET and DELETE with 405 and ignores a stale `mcp-session-id`). The
 * factory runs per request, so the Bearer is read from that request rather than
 * held on a session, which is what removes the in-process session map.
 *
 * Do NOT hoist the `makeServer(...)` call out of the factory body: per-request
 * instances are what keep one client's envelope attribution out of the next
 * request (see `attributeFromEnvelope`).
 */
function mcpHandler(): McpHttpHandler {
  return createMcpHandler(
    (ctx) => {
      // `ctx.requestInfo` is a web Request, so adapt rather than reparse. The POST
      // gate already rejected a bad header, so a throw here is a real bug.
      const token = extractTokenHttp({
        authorization:
          ctx.requestInfo?.headers.get("authorization") ?? undefined,
      });

      return makeServer(() => makeClient(token), {
        // Express entered the ALS scope before dispatch, so this getter keeps
        // `tools/list`'s workspace and capture gates on the same object.
        analyticsContext: () => currentAnalyticsContext() ?? {},
        releases: currentAnalyticsContext()?.releases ?? PUBLIC_VIEW,
      });
    },
    { onerror: (err) => console.error(`[mcp/http] ${err.message}`) },
  );
}

export function analyticsIdentityOf(
  token: string,
  verifiedIdentity?: VerifiedOAuthIdentity,
): AnalyticsIdentity {
  if (verifiedIdentity) {
    return { distinctId: verifiedIdentity.distinctId, personless: false };
  }

  return {
    distinctId: `credential:${createHash("sha256").update(token).digest("hex")}`,
    personless: true,
  };
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * The revision this request declares, envelope FIRST. The SDK classifies a
 * request as modern from the `_meta` envelope claim, not from the header
 * (`classifyRequestBody`), and `MCP-Protocol-Version` is optional alongside
 * that claim, so reading the header first reports no version at all for a
 * conforming header-less modern client. A legacy `initialize` carries the
 * revision as a plain param; every other legacy request has only the header.
 */
type ProtocolVersionEnvelope = {
  params?: {
    protocolVersion?: JsonValue;
    _meta?: JsonObject;
  };
};

function protocolVersionOf(req: Request): string | undefined {
  const body: ProtocolVersionEnvelope | undefined = req.body;
  const params = body?.params;

  const claimed =
    params?._meta?.[PROTOCOL_VERSION_META_KEY] ?? params?.protocolVersion;

  if (isJsonString(claimed) && claimed) return claimed;

  return headerValue(req.headers["mcp-protocol-version"]);
}

/**
 * The `$session_id` PostHog groups a request's events under.
 *
 * `mcp-session-id` is chosen by the CLIENT and nothing server-minted survives
 * the stateless transport, so emitting the header verbatim lets any caller
 * assert another principal's id and land its events in that principal's
 * grouping. Binding the digest to the resolved distinct id keeps grouping exact
 * WITHIN a principal (same header + same identity is the whole input, so the
 * value is stable across its requests and across tasks) while sending a
 * borrowed id to a different bucket. Hashing the JSON framing rather than a
 * joined string is what keeps `("a", "b:c")` and `("a:b", "c")` distinct, which
 * is a live case because a personless distinct id is itself `credential:<hex>`.
 */
export function analyticsSessionIdOf(
  sessionId: string,
  distinctId: string,
): string {
  return createHash("sha256")
    .update(JSON.stringify([sessionId, distinctId]))
    .digest("hex")
    .slice(0, 32);
}

function analyticsContextFor(
  req: Request,
  identity: AnalyticsIdentity,
): McpAnalyticsContext {
  const sessionId = readSessionId(req);
  const protocolVersion = protocolVersionOf(req);
  const clientUserAgent = headerValue(req.headers["user-agent"]);
  const context: McpAnalyticsContext = { identity };

  if (sessionId) {
    context.sessionId = analyticsSessionIdOf(sessionId, identity.distinctId);
  }

  if (protocolVersion) context.protocolVersion = protocolVersion;

  if (clientUserAgent) context.clientUserAgent = clientUserAgent;

  return context;
}

// RFC 9728 requires resource and metadata on one origin, with host root as ID.
// Strip any MCP_PUBLIC_URL path so stale `/mcp` values cannot advertise a bad ID.
const RESOURCE_ORIGIN = new URL(runtimeSetting("MCP_PUBLIC_URL")).origin;

const AUTH_SERVER_URL = runtimeSetting("LUNE_AUTH_SERVER_URL").replace(
  /\/+$/,
  "",
);

const SUPPORTED_SCOPES = ["papers:read", "guidance:read", "account:read"];

const PROTECTED_RESOURCE_PATH = "/.well-known/oauth-protected-resource";

// Bare origin is canonical; keep `/mcp` and `/v1/mcp` for existing installs.
const MCP_PATHS = ["/", "/mcp", "/v1/mcp"];

const DOCS_URL = runtimeSetting("MCP_DOCS_URL");

const FAVICON_URL = runtimeSiteUrl("/favicon.svg");

const OPENAI_APPS_CHALLENGE_PATH = "/.well-known/openai-apps-challenge";

const SERVER_MANIFEST_PATHS = ["/.well-known/mcp/server.json", "/server.json"];

const OPENAI_APPS_CHALLENGE_TOKEN = runtimeSetting(
  "OPENAI_APPS_CHALLENGE_TOKEN",
);

/**
 * The endpoint aliases, as RFC 9728 resource-identifier suffixes. `""` is the
 * canonical bare origin. RFC 9728 §3.3 makes these path-aware and NOT
 * interchangeable: the `resource` a metadata document returns MUST be identical
 * to the identifier the well-known suffix was inserted into, and (when the
 * client reached the document through a `WWW-Authenticate resource_metadata`
 * URL) identical to the URL it used to reach the resource server. A conforming
 * client MUST discard metadata that fails either check, so serving the origin
 * from `/.well-known/oauth-protected-resource/mcp` would break OAuth for a
 * strict client on the legacy URL. Path-awareness also means an already-connected
 * `/mcp` client keeps its ORIGINAL identifier: no re-binding, no refresh churn.
 */
type EndpointAlias = "" | "/mcp" | "/v1/mcp";

function aliasOfPath(path: string): EndpointAlias {
  const p = path.replace(/\/+$/, "");

  return p === "/mcp" || p === "/v1/mcp" ? p : "";
}

function resourceFor(alias: EndpointAlias): string {
  return `${RESOURCE_ORIGIN}${alias}`;
}

function metadataUrlFor(alias: EndpointAlias): string {
  return `${RESOURCE_ORIGIN}${PROTECTED_RESOURCE_PATH}${alias}`;
}

function sendProtectedResourceMetadata(res: Response, resource: string): void {
  res.set("Cache-Control", "public, max-age=3600");
  res.json({
    resource,
    authorization_servers: [AUTH_SERVER_URL],
    scopes_supported: SUPPORTED_SCOPES,
    bearer_methods_supported: ["header"],
    resource_documentation: DOCS_URL,
  });
}

// Omit error for no-token discovery; invalid_token makes clients refresh.
// Both challenges include resource metadata and scopes per RFC 6750/9728.
function challenge(
  alias: EndpointAlias,
  error?: string,
  description?: string,
  scopes: readonly string[] = SUPPORTED_SCOPES,
): string {
  const metadata = `resource_metadata="${metadataUrlFor(alias)}"`;
  const scope = `scope="${scopes.join(" ")}"`;

  if (!error) return `Bearer ${metadata}, ${scope}`;
  const params = [`error="${error}"`];

  if (description) params.push(`error_description="${description}"`);
  params.push(metadata, scope);

  return `Bearer ${params.join(", ")}`;
}

/** The two fields the scope gate reads off one JSON-RPC message. */
type ScopedRequestMessage = {
  method?: JsonValue;
  params?: { name?: JsonValue };
};

/**
 * The JSON-RPC id to echo on an error response. Read straight off an
 * unvalidated body, so any JSON value can arrive; `?? null` at each use site is
 * what keeps a literal `0` while turning an absent id into the spec's `null`.
 */
type JsonRpcId = JsonValue | undefined;

function requiredToolScopes(req: Request, releases: Releases): string[] {
  const body: ScopedRequestMessage | ScopedRequestMessage[] | undefined =
    req.body;

  const messages = Array.isArray(body) ? body : [body];

  return [
    ...new Set(
      messages.flatMap((message) => {
        const toolName = message?.params?.name;

        if (message?.method !== "tools/call" || !isJsonString(toolName)) {
          return [];
        }

        const scope = requiredScopeForTool(toolName, releases);

        return scope ? [scope] : [];
      }),
    ),
  ];
}

function sendInsufficientScope(
  req: Request,
  res: Response,
  id: JsonRpcId,
  requiredScopes: readonly string[],
): void {
  const scopeLabel = requiredScopes.join(" ");

  const authenticate = challenge(
    aliasOfPath(req.path),
    "insufficient_scope",
    `The ${scopeLabel} scope is required for this request.`,
    requiredScopes,
  );

  res.set("WWW-Authenticate", authenticate);
  res.status(403).json({
    jsonrpc: "2.0",
    error: {
      code: -32001,
      message: `Forbidden: missing ${scopeLabel} scope`,
      data: { _meta: { "mcp/www_authenticate": authenticate } },
    },
    id: id ?? null,
  });
}

// Send the auth challenge in both HTTP and JSON-RPC paths for client compatibility.
// Echo the request id with `??` so a literal `0` survives.
function sendUnauthorized(
  req: Request,
  res: Response,
  id: JsonRpcId,
  message: string,
  opts?: { error?: string; description?: string },
): void {
  // Point the client at the metadata document for the endpoint IT called, not a
  // fixed one (RFC 9728 §3.3, second paragraph).
  const authenticate = challenge(
    aliasOfPath(req.path),
    opts?.error,
    opts?.description,
  );

  res.set("WWW-Authenticate", authenticate);
  res.status(401).json({
    jsonrpc: "2.0",
    error: {
      code: -32001,
      message,
      data: { _meta: { "mcp/www_authenticate": authenticate } },
    },
    id: id ?? null,
  });
}

/**
 * The client's self-reported `mcp-session-id`. Protocol sessions no longer
 * exist, so this is read for ONE reason: PostHog groups a conversation's events
 * by `$session_id`, and 2025-era clients keep sending the header. It is an
 * unverified claim, so it never reaches PostHog raw: [[analyticsSessionIdOf]].
 */
function readSessionId(req: Request): string | undefined {
  // Node collapses duplicate non-cookie headers into one comma-joined string, so
  // `IncomingHttpHeaders`'s `string[]` branch never materialises here.
  const v = req.headers[SESSION_HEADER];

  /* v8 ignore next */
  if (Array.isArray(v)) return v[0];

  return v;
}

function allowedOrigins(): Set<string> {
  const raw = runtimeSetting("MCP_ALLOWED_ORIGINS");

  const parsed: unknown = JSON.parse(raw);

  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    parsed.some((origin) => origin !== String(origin))
  ) {
    throw new Error(
      "MCP_ALLOWED_ORIGINS must be a non-empty JSON string array",
    );
  }

  return new Set(parsed);
}

// Credentialed browser requests require an echoed allowed origin; `*` is invalid.
const ALLOWED_ORIGINS = allowedOrigins();

// Reject spoofed Host values before tools run; CORS only controls response access.
// Loopback supports dev/tests, and MCP_ALLOWED_HOSTS adds explicit deployments.
const ALLOWED_HOSTS = new Set<string>([
  new URL(RESOURCE_ORIGIN).host,
  ...(process.env.MCP_ALLOWED_HOSTS?.split(",")
    .map((h) => h.trim())
    .filter(Boolean) ?? []),
]);

export function hostIsAllowed(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  const host = hostHeader.toLowerCase();
  const hostname = host.replace(/:\d+$/, "");

  if (ALLOWED_HOSTS.has(host) || ALLOWED_HOSTS.has(hostname)) return true;

  return (
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]"
  );
}

export function originIsAllowed(
  origin: string | string[] | undefined,
): boolean {
  // No Origin means a native or server-to-server client with no ambient browser
  // credentials to abuse; a present one must be allowlisted, an array is bogus.
  if (origin === undefined) return true;

  if (Array.isArray(origin)) return false;

  if (ALLOWED_ORIGINS.has(origin)) return true;

  try {
    const url = new URL(origin);

    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      (url.hostname === "localhost" ||
        url.hostname === "127.0.0.1" ||
        url.hostname === "[::1]")
    );
  } catch {
    return false;
  }
}

// Only legacy clients batch; cap at 50 to bound one POST's dispatch and memory.
// Modern SDK rejects arrays, and real legacy batches are far smaller.
const MAX_BATCH_MESSAGES = 50;

/** The one field of a body-parser failure the JSON error handler branches on. */
interface BodyParserFailure {
  status?: number;
}

/** `/health` response body. `build_id` is present only on deployed builds. */
type HealthBody = {
  status: "ok";
  server: "lune-mcp";
  version: string;
  build_id?: string;
};

/** Build the express app without binding it to a port. Useful for tests. */
/** Credentials whose last answer a task keeps; far above one task's active set. */
const REMEMBERED_CREDENTIALS = 10_000;

interface CredentialView {
  view: ReleaseView;
  /** Undefined where no probe ran, so `tools/list` asks for itself. */
  workspace: boolean | undefined;
}

/**
 * What this request may rely on about its credential: the probe's answer, which
 * is remembered, or while the API cannot be asked the last answer it gave for
 * this credential. With neither, only the public surface is listed and a call
 * to a released tool goes on to the API, whose gate decides it: a released
 * user's already-listed tool must not turn unknown because one probe failed.
 */
function credentialView(
  token: string,
  probe: AnalyticsCredentialProbe | undefined,
  remembered: RememberedAnswers,
): CredentialView {
  if (probe === undefined) return { view: PUBLIC_VIEW, workspace: undefined };

  if (probe.status === "valid") {
    const facts = {
      releases: probe.releases ?? PUBLIC_RELEASES,
      workspace: probe.workspaceCredential === true,
    };

    remembered.remember(token, facts);

    return { view: answeredView(facts.releases), workspace: facts.workspace };
  }

  const recalled = remembered.recall(token);

  return { view: viewOf(recalled), workspace: recalled?.workspace === true };
}

export function buildHttpApp(options: HttpAppOptions = {}): Express {
  const app = express();
  const remembered = new RememberedAnswers(REMEMBERED_CREDENTIALS);
  // CORS must run before JSON parsing so OPTIONS preflights short-circuit
  // before they touch routes that require a body.
  app.use((req, res, next) => {
    const origin = req.headers.origin;

    if (origin !== undefined && originIsAllowed(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader(
        "Access-Control-Allow-Methods",
        "GET, POST, DELETE, OPTIONS",
      );
      // `mcp-method` is mandatory on a 2026-07-28 request, so a browser client
      // without it fails every modern call. `mcp-session-id` stays for legacy.
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Authorization, Content-Type, Accept, mcp-session-id, mcp-protocol-version, last-event-id, mcp-method, mcp-name",
      );
      res.setHeader(
        "Access-Control-Expose-Headers",
        "mcp-session-id, WWW-Authenticate",
      );
      res.setHeader("Access-Control-Max-Age", "86400");
    }

    if (req.method === "OPTIONS") {
      res.status(204).end();

      return;
    }

    next();
  });
  app.use(express.json({ limit: "1mb" }));

  const jsonBodyError: ErrorRequestHandler = (error, _req, res, next) => {
    const bodyError: BodyParserFailure = error;

    if (bodyError.status !== 400 && bodyError.status !== 413) {
      next(error);

      return;
    }

    const tooLarge = bodyError.status === 413;
    res.set({
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    res.status(tooLarge ? 413 : 400).json({
      jsonrpc: "2.0",
      error: {
        code: tooLarge ? -32600 : -32700,
        message: tooLarge
          ? "Invalid Request: JSON body exceeds 1 MB"
          : "Parse error: request body is not valid JSON",
      },
      id: null,
    });
  };

  app.use(jsonBodyError);
  app.disable("x-powered-by");

  app.get("/health", (_req: Request, res: Response) => {
    const buildId = process.env.LUNE_BUILD_ID?.trim();

    const body: HealthBody = {
      status: "ok",
      server: "lune-mcp",
      version: SERVER_VERSION,
    };

    if (buildId) body.build_id = buildId;
    res.json(body);
  });

  // The exact server.json that mcp-publisher validated and published, served at
  // the well-known path plus a root alias for crawlers starting at the origin.
  app.get(SERVER_MANIFEST_PATHS, (_req: Request, res: Response) => {
    if (!res.hasHeader("Access-Control-Allow-Origin")) {
      res.set("Access-Control-Allow-Origin", "*");
    }

    res.set({
      "Cache-Control": "public, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    });
    res.json(serverManifest);
  });

  // OpenAI Apps domain-ownership challenge. Public, no auth, cached briefly.
  // The verifier fetches the path and expects the raw token in the body.
  app.get(OPENAI_APPS_CHALLENGE_PATH, (_req: Request, res: Response) => {
    res.set("Cache-Control", "public, max-age=86400");
    res.type("text/plain").send(OPENAI_APPS_CHALLENGE_TOKEN);
  });

  // Directory crawlers probe the MCP host, not the apex, so point them at the
  // marketing site's canonical mark; mirroring it here would only invite drift.
  app.get(
    ["/favicon.ico", "/favicon.svg", "/apple-touch-icon.png"],
    (_req: Request, res: Response) => {
      res.set("Cache-Control", "public, max-age=86400");
      res.redirect(302, FAVICON_URL);
    },
  );

  // RFC 9728 metadata: public and cacheable. Derived from the one alias set, so
  // adding a fourth endpoint path cannot half-land in MCP_PATHS alone.
  for (const alias of MCP_PATHS.map(aliasOfPath)) {
    app.get(
      `${PROTECTED_RESOURCE_PATH}${alias}`,
      (_req: Request, res: Response) => {
        sendProtectedResourceMetadata(res, resourceFor(alias));
      },
    );
  }

  // DNS-rebinding guard, scoped to the JSON-RPC paths so health and well-known
  // stay open. The ARRAY form is exact, not a prefix: never collapse it to "/".
  app.use(MCP_PATHS, (req: Request, res: Response, next) => {
    if (!hostIsAllowed(req.headers.host)) {
      res.status(403).json({
        jsonrpc: "2.0",
        error: { code: -32003, message: "Forbidden: host not allowed" },
        id: null,
      });

      return;
    }

    if (!originIsAllowed(req.headers.origin)) {
      res.status(403).json({
        jsonrpc: "2.0",
        error: { code: -32003, message: "Forbidden: origin not allowed" },
        id: null,
      });

      return;
    }

    next();
  });

  // A browser opening the canonical endpoint gets the docs, not a JSON-RPC error.
  // Scoped to "/": /mcp and /v1/mcp must keep answering registered probes.
  app.get("/", (req: Request, res: Response, next) => {
    if (req.accepts(["text/event-stream", "text/html"]) === "text/html") {
      res.redirect(302, DOCS_URL);

      return;
    }

    next();
  });

  const handler = mcpHandler();
  app.locals.mcpHandler = handler;

  const nodeHandler = toNodeHandler(handler, {
    onerror: (err) => console.error(`[mcp/http] adapter: ${err.message}`),
  });

  // Handler lifetime follows the listening server so standalone test apps close it.
  // SAFETY: The wrapper forwards typed listen calls unchanged, adding only cleanup.
  const bindAndListen = app.listen.bind(app) as (
    ...args: unknown[]
  ) => HttpServer;

  app.listen = (...args: unknown[]): HttpServer => {
    const server = bindAndListen(...args);
    server.on("close", () => void handler.close().catch(() => undefined));

    return server;
  };

  // POST is the only verb that can execute a tool, so it is the only one gated on
  // a credential; GET and DELETE answer 405 without building a server.
  app.post(MCP_PATHS, async (req: Request, res: Response) => {
    // A batch is one POST but N dispatches and N events, so uncapped it is a 40x
    // amplifier. Checked before the auth work so an abusive body buys no call.
    if (Array.isArray(req.body) && req.body.length > MAX_BATCH_MESSAGES) {
      res.status(400).json({
        jsonrpc: "2.0",
        error: {
          code: -32600,
          message: `Bad Request: JSON-RPC batch exceeds ${MAX_BATCH_MESSAGES} messages`,
        },
        id: null,
      });

      return;
    }

    let token: string;

    try {
      token = extractTokenHttp(req.headers);
    } catch (cause) {
      // RFC 6750 §3 + MCP authorization spec: the WWW-Authenticate header is
      // what triggers the connector's OAuth discovery + browser-based consent.
      sendUnauthorized(req, res, req.body?.id, messageOf(cause));

      return;
    }

    // An expired Lune OAuth token must get a transport 401 + WWW-Authenticate so
    // the client silently refreshes, rather than failing inside a tool call.
    const inspection = await inspectAccessToken(
      token,
      undefined,
      resourceFor(aliasOfPath(req.path)),
      protocolVersionOf(req) !== "2026-07-28",
    );

    if (inspection.needsReauth) {
      sendUnauthorized(
        req,
        res,
        req.body?.id,
        "Access token expired or invalid; re-authenticate to continue.",
        {
          error: "invalid_token",
          description: "The access token is expired or invalid.",
        },
      );

      return;
    }

    const analyticsProbe = await probeRequestCredential(options, token);

    if (analyticsProbe?.status === "invalid") {
      sendUnauthorized(
        req,
        res,
        req.body?.id,
        "Access token is invalid; re-authenticate to continue.",
        {
          error: "invalid_token",
          description: "The access token is invalid.",
        },
      );

      return;
    }

    // Resolved before the scope gate so an unlisted tool fails it exactly as an
    // unknown one does, instead of demanding a scope for a tool not listed.
    const credential = credentialView(token, analyticsProbe, remembered);
    const requiredScopes = requiredToolScopes(req, credential.view.listed);

    const missingScopes = inspection.verifiedIdentity
      ? requiredScopes.filter(
          (scope) => !inspection.verifiedIdentity!.scopes.includes(scope),
        )
      : [];

    if (missingScopes.length > 0) {
      sendInsufficientScope(req, res, req.body?.id, missingScopes);

      return;
    }

    // The probe's identity must win before the context is built: `$session_id`
    // derives from the distinct id, so patching later would split one client.
    const requestAnalyticsContext = analyticsContextFor(
      req,
      analyticsProbe?.identity ??
        analyticsIdentityOf(token, inspection.verifiedIdentity),
    );

    if (analyticsProbe) {
      // `analytics_suppressed` is the opt-out; capture also stops when the shared
      // budget is spent. Only the opt-out may reshape the tool surface.
      requestAnalyticsContext.captureOptOut =
        analyticsProbe.suppressAnalytics === true;
      requestAnalyticsContext.captureEnabled =
        analyticsProbe.suppressAnalytics !== true &&
        analyticsProbe.captureAllowed === true;
    }

    if (credential.workspace !== undefined) {
      requestAnalyticsContext.workspaceCredential = credential.workspace;
    }

    requestAnalyticsContext.releases = credential.view;

    // Entering the ALS scope here is what carries the context through the node
    // adapter: the handler factory never sees the Express request.
    await withAnalyticsContext(requestAnalyticsContext, () =>
      nodeHandler(req, res, req.body),
    );
  });

  // Every other verb on the endpoint is the handler's own answer: 405 under the
  // stateless posture, never the 404 that would tell a client its session died.
  app.all(MCP_PATHS, (req: Request, res: Response) => {
    // The parsed body must be the THIRD argument: mounted directly, Express's
    // `next` lands there and the adapter re-reads a stream express.json() drained.
    void nodeHandler(req, res, req.body);
  });

  return app;
}

/** `address()` is a string for a pipe or unix socket, and null before binding. */
function isBoundAddress(
  address: string | AddressInfo | null,
): address is AddressInfo {
  return typeof address === "object" && address !== null;
}

/** Start the HTTP server bound to `port`. Pass `0` for an OS-assigned port. */
export function startHttpServer(port: number): HttpServer {
  const app = buildHttpApp();
  const handler: McpHttpHandler = app.locals.mcpHandler;

  const server = app.listen(port, () => {
    const addr = server.address();
    const boundPort = isBoundAddress(addr) ? addr.port : port;
    console.log(`Lune MCP HTTP listening on :${boundPort}`);
  });

  // The orchestrator sends SIGTERM, then SIGKILL after its stop timeout; Node's
  // default exit would cut every in-flight tool call, so drain in that window.
  let draining = false;

  const drain = (signal: string): void => {
    if (draining) return;
    draining = true;
    console.log(`Lune MCP received ${signal}; draining in-flight requests`);
    server.close(() => {
      void flushAnalytics(2000).finally(() => {
        console.log("Lune MCP drained cleanly; exiting");
        process.exit(0);
      });
    });

    const force = setTimeout(() => {
      console.warn(
        "Lune MCP drain grace elapsed; aborting in-flight exchanges",
      );
      void handler
        .close()
        .catch(() => undefined)
        .finally(
          () => void flushAnalytics(1000).finally(() => process.exit(0)),
        );
    }, 24_000);

    force.unref();
  };

  // Named handlers detached on close so repeated startHttpServer() calls (the
  // integration tests spin up many) don't leak process-level listeners.
  const onSigterm = (): void => drain("SIGTERM");
  const onSigint = (): void => drain("SIGINT");
  process.on("SIGTERM", onSigterm);
  process.on("SIGINT", onSigint);
  server.on("close", () => {
    process.removeListener("SIGTERM", onSigterm);
    process.removeListener("SIGINT", onSigint);
  });

  return server;
}
