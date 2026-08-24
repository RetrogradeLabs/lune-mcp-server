import express, { type Request, type Response, type Express } from "express";
import type { Server as HttpServer } from "node:http";
import { createHash } from "node:crypto";
import {
  createMcpHandler,
  PROTOCOL_VERSION_META_KEY,
  type McpHttpHandler,
} from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { makeServer, SERVER_VERSION } from "../server.js";
import { extractTokenHttp } from "../auth/token.js";
import {
  inspectAccessToken,
  type VerifiedOAuthIdentity,
} from "../auth/verify.js";
import { makeClient } from "../api/client.js";
import {
  analyticsEnabled,
  currentAnalyticsContext,
  flushAnalytics,
  withAnalyticsContext,
  type AnalyticsIdentity,
  type McpAnalyticsContext,
} from "../analytics.js";
import serverManifest from "../../server.json";

const SESSION_HEADER = "mcp-session-id";

export interface AnalyticsCredentialProbe {
  status: "valid" | "invalid" | "indeterminate";
  identity?: AnalyticsIdentity;
  suppressAnalytics?: boolean;
  captureAllowed?: boolean;
  workspaceCredential?: boolean;
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
    const context = await makeClient(token)
      .get("account/mcp-context", { timeout: 2500, retry: 0 })
      .json<{
        workspace?: boolean;
        analytics_user_id?: string | null;
        analytics_personless?: boolean;
        analytics_suppressed?: boolean;
        analytics_capture_allowed?: boolean;
      }>();
    return {
      status: "valid",
      ...(context.analytics_user_id
        ? {
            identity: {
              distinctId: context.analytics_user_id,
              personless: context.analytics_personless === true,
            },
          }
        : {}),
      suppressAnalytics: context.analytics_suppressed === true,
      captureAllowed: context.analytics_capture_allowed === true,
      workspaceCredential: context.workspace === true,
    };
  } catch (error) {
    const status = (error as { response?: { status?: number } }).response
      ?.status;
    return {
      status: status === 401 ? "invalid" : "indeterminate",
    };
  }
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
      // `extractTokenHttp` takes Express-shaped headers and `ctx.requestInfo` is
      // a web Request, so adapt rather than duplicating the parse. It throws on
      // a missing or malformed header, but the POST gate in front has already
      // rejected those, so a throw here is a real bug.
      const token = extractTokenHttp({
        authorization:
          ctx.requestInfo?.headers.get("authorization") ?? undefined,
      });
      return makeServer(() => makeClient(token), {
        // The Express layer entered the ALS scope before dispatching, so the
        // per-request context reaches `captureMcp` through its own fallback
        // read; this getter is what keeps `tools/list`'s workspace and capture
        // gates reading the same object.
        analyticsContext: () => currentAnalyticsContext() ?? {},
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
function protocolVersionOf(req: Request): string | undefined {
  const params = (req.body as { params?: unknown } | undefined)?.params as
    { protocolVersion?: unknown; _meta?: Record<string, unknown> } | undefined;
  const claimed =
    params?._meta?.[PROTOCOL_VERSION_META_KEY] ?? params?.protocolVersion;
  if (typeof claimed === "string" && claimed) return claimed;
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
  return {
    identity,
    ...(sessionId
      ? { sessionId: analyticsSessionIdOf(sessionId, identity.distinctId) }
      : {}),
    ...(protocolVersion ? { protocolVersion } : {}),
    ...(clientUserAgent ? { clientUserAgent } : {}),
  };
}

// MCP authorization (2025-06-18 spec, RFC 9728): the resource server publishes
// its own protected-resource metadata and points at the authorization server.
// Claude Desktop's remote-MCP connector hits POST /mcp anonymously, expects a
// 401 carrying `WWW-Authenticate: Bearer resource_metadata="…"`, then follows
// that URL to discover the AS. Without these two pieces, the connector reports
// "Couldn't reach the MCP server" even though the HTTP transport is healthy.
// The endpoint is mounted at the HOST ROOT (`MCP_PATHS`), so the resource
// identifier is the origin: any path on `MCP_PUBLIC_URL` (a stale task
// definition still passing `.../mcp`, a dev tunnel URL someone pasted with a
// suffix) is dropped rather than advertised as an identifier we do not serve.
// This also keeps the metadata URL and the resource on one origin by
// construction, which RFC 9728 §3.3 requires them to agree on.
const RESOURCE_ORIGIN = new URL(
  // `||`, not `??`: an EMPTY env var is meaningless here and would throw out of
  // `new URL` at import, crash-looping the task.
  process.env.MCP_PUBLIC_URL || "https://mcp.luneresearch.com",
).origin;
const AUTH_SERVER_URL =
  process.env.LUNE_AUTH_SERVER_URL?.replace(/\/+$/, "") ??
  "https://api.luneresearch.com";
const SUPPORTED_SCOPES = [
  "papers:read",
  "guidance:read",
  "subs:rw",
  "account:read",
];
const PROTECTED_RESOURCE_PATH = "/.well-known/oauth-protected-resource";
// The canonical JSON-RPC endpoint is the bare origin; `/mcp` (previous default)
// and `/v1/mcp` (early docs + marketing hero) stay as aliases so existing
// installs and cached docs keep working.
const MCP_PATHS = ["/", "/mcp", "/v1/mcp"];
const DOCS_URL = "https://luneresearch.com/docs/mcp";
const OPENAI_APPS_CHALLENGE_PATH = "/.well-known/openai-apps-challenge";
const SERVER_MANIFEST_PATHS = ["/.well-known/mcp/server.json", "/server.json"];
// Domain-ownership token issued by OpenAI's app directory; served verbatim
// as plain text so the verifier can fetch and compare. Override with
// `OPENAI_APPS_CHALLENGE_TOKEN` env var if rotated.
const OPENAI_APPS_CHALLENGE_TOKEN =
  process.env.OPENAI_APPS_CHALLENGE_TOKEN ??
  "Y83F79AVjQF9SsYsNflnuFc95_3EuQP5aZIOir-x0rw";

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

// Build the `WWW-Authenticate: Bearer ...` challenge. With no `error` this is
// the bare discovery challenge a NO-token request gets (RFC 6750 §3: omit the
// error code when the request carried no credentials); the connector follows
// `resource_metadata` to start OAuth. With `error="invalid_token"` it is the
// RFC 6750 §3.1 signal that an access token was supplied but is expired/invalid,
// which is what makes the MCP client refresh-then-retry instead of surfacing a
// failure to the model.
function challenge(
  alias: EndpointAlias,
  error?: string,
  description?: string,
): string {
  const metadata = `resource_metadata="${metadataUrlFor(alias)}"`;
  if (!error) return `Bearer ${metadata}`;
  const params = [`error="${error}"`];
  if (description) params.push(`error_description="${description}"`);
  params.push(metadata);
  return `Bearer ${params.join(", ")}`;
}

// Emit a transport-level 401 carrying the challenge in BOTH the `WWW-Authenticate`
// header and the JSON-RPC error `data._meta` (per the MCP authorization spec), so
// a client that parses either path can discover the AS / trigger refresh. `id`
// echoes the request id; `?? null` preserves a literal `0` id.
function sendUnauthorized(
  req: Request,
  res: Response,
  id: unknown,
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
  // Node collapses duplicate non-cookie headers into a comma-joined string,
  // so `req.headers['mcp-session-id']` is always `string | undefined` at
  // runtime; the `string[]` branch in `IncomingHttpHeaders` is a defensive
  // TS shape that never materialises here.
  const v = req.headers[SESSION_HEADER];
  /* v8 ignore next */
  if (Array.isArray(v)) return v[0];
  return v;
}

// Origins that browser-based MCP clients connect from. Must echo a specific
// origin (not `*`) when `Access-Control-Allow-Credentials: true` is set;
// without this, the connector's sign-in fetch is blocked by the browser
// before it ever reaches the JSON-RPC handler.
const ALLOWED_ORIGINS = new Set([
  "https://claude.ai",
  "https://claude.com",
  "https://chatgpt.com",
  "https://platform.openai.com",
  "https://luneresearch.com",
  "https://www.luneresearch.com",
  "http://localhost:3000",
  "http://localhost:1420",
]);

// Host allowlist for the JSON-RPC endpoints (DNS-rebinding / Host-spoofing
// guard). The SDK transport ships with no Host/Origin validation, and the CORS
// layer below only *sets* ACAO headers, it never *rejects*, so without this a
// disallowed-Origin browser request (or a rebound Host) still executes a
// state-changing tool call before the browser drops the response. Loopback is
// always allowed for local dev and tests; extra hosts via MCP_ALLOWED_HOSTS.
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
  // Absent Origin = a native/CLI MCP client or server-to-server call (no
  // ambient browser credentials to abuse); allowed, and authenticated by the
  // Bearer token. A present Origin must be on the allowlist; Node never arrays
  // this header, so an array is treated as malformed and rejected.
  if (origin === undefined) return true;
  if (Array.isArray(origin)) return false;
  return ALLOWED_ORIGINS.has(origin);
}

// Longest JSON-RPC batch this endpoint will dispatch. Batching left the spec in
// revision 2025-06-18 and the SDK refuses an array on the modern path, so the
// only senders are 2025-03-26-era clients, whose real batches are a handful of
// messages. 50 is far above any of those and ~340x below the 17,189 minimal
// messages that fit inside the 1mb body limit; measured, a 50-message
// `prompts/list` batch costs 129kb and 16ms, the 1mb one 44mb and 4.6s.
const MAX_BATCH_MESSAGES = 50;

/** Build the express app without binding it to a port. Useful for tests. */
export function buildHttpApp(options: HttpAppOptions = {}): Express {
  const app = express();
  // CORS must run before JSON parsing so OPTIONS preflights short-circuit
  // before they touch routes that require a body.
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (typeof origin === "string" && ALLOWED_ORIGINS.has(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader(
        "Access-Control-Allow-Methods",
        "GET, POST, DELETE, OPTIONS",
      );
      // `mcp-method` is MANDATORY on a 2026-07-28 request and `mcp-name`
      // accompanies a `tools/call`, so a browser MCP client without them in the
      // allowlist fails every modern call at preflight while its legacy calls
      // keep working. `mcp-session-id` stays: vestigial, but removing it would
      // break a legacy browser client that still sends one.
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
  app.disable("x-powered-by");

  app.get("/health", (_req: Request, res: Response) => {
    const buildId = process.env.LUNE_BUILD_ID?.trim();
    res.json({
      status: "ok",
      server: "lune-mcp",
      version: SERVER_VERSION,
      ...(buildId ? { build_id: buildId } : {}),
    });
  });

  // Public MCP Registry metadata. The body is the exact server.json validated
  // and published by mcp-publisher, exposed at the well-known discovery path
  // plus a root alias for crawlers that start from the MCP origin.
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

  // Favicon redirects so directory crawlers (Google s2 / Anthropic / OpenAI)
  // resolve our brand mark when they probe the MCP host instead of the apex.
  // The canonical asset lives at luneresearch.com/favicon.svg and is owned
  // by the marketing site; mirroring it here would only invite drift.
  app.get(
    ["/favicon.ico", "/favicon.svg", "/apple-touch-icon.png"],
    (_req: Request, res: Response) => {
      res.set("Cache-Control", "public, max-age=86400");
      res.redirect(302, "https://luneresearch.com/favicon.svg");
    },
  );

  // RFC 9728 protected-resource metadata. Public, no auth, cacheable. The
  // `resource` claim binds tokens to this server's URL; `authorization_servers`
  // points at the Lune API which exposes the full OAuth 2.1 + DCR machinery.
  // Derived, not re-spelled: one alias set, so adding a fourth endpoint path
  // cannot half-land by updating MCP_PATHS and forgetting the metadata routes.
  for (const alias of MCP_PATHS.map(aliasOfPath)) {
    app.get(
      `${PROTECTED_RESOURCE_PATH}${alias}`,
      (_req: Request, res: Response) => {
        sendProtectedResourceMetadata(res, resourceFor(alias));
      },
    );
  }

  // DNS-rebinding / CSRF guard, scoped to the JSON-RPC endpoints only: health,
  // well-known and favicon stay open for ALB checks and directory crawlers.
  // The ARRAY form matches exactly these three paths (plus sub-paths), it is NOT
  // the prefix catch-all that a bare `app.use("/")` would be, so an unknown path
  // still 404s without running the guard. Do not collapse MCP_PATHS to ["/"].
  // Rejects a spoofed/rebound Host or a present-but-disallowed browser Origin
  // BEFORE the request can execute a tool call.
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

  // A person (or a crawler) opening the CANONICAL endpoint in a browser: send
  // them to the docs instead of the transport's JSON-RPC error. Scoped to "/" on
  // purpose: `/mcp` and `/v1/mcp` are registered URLs that directory probes and
  // connector validators already hit, and they must keep their protocol response
  // rather than start returning marketing HTML. MCP clients ask for
  // `text/event-stream` on this verb, so they never take this branch.
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

  // The handler owns the modern leg's in-flight exchanges, so its lifetime is
  // the lifetime of the server serving them. Tying it to `listen` rather than to
  // `startHttpServer` is what stops each standalone `buildHttpApp()` (the suite
  // builds one per file) from leaving one behind with no way to reach it.
  // `close()` is idempotent, so the drain path can still force it early.
  const bindAndListen = app.listen.bind(app) as (
    ...args: unknown[]
  ) => HttpServer;
  app.listen = ((...args: unknown[]): HttpServer => {
    const server = bindAndListen(...args);
    server.on("close", () => void handler.close().catch(() => undefined));
    return server;
  }) as typeof app.listen;

  // POST is the only verb that can execute a tool, so it is the only one gated
  // on a credential: GET and DELETE were 2025 session operations and the
  // stateless handler answers both 405 without building a server instance.
  app.post(MCP_PATHS, async (req: Request, res: Response) => {
    // A batch is ONE POST (one credential probe, one API-side analytics claim)
    // but N dispatches and N PostHog events, so uncapped it is both a 40x
    // CPU/bandwidth amplifier and the one path where the API's per-request
    // accounting under-counts per-event work; `prompts/list` needs no upstream
    // call, so nothing else in the stack sees a flood (`.claude/rules/mcp.md`).
    // Checked ahead of the auth work so an abusive body buys no upstream call.
    // 400 + -32600 is the SDK's own answer to a malformed batch.
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
    } catch (e) {
      // RFC 6750 §3 + MCP authorization spec: the WWW-Authenticate header is
      // what triggers the connector's OAuth discovery + browser-based consent.
      sendUnauthorized(req, res, req.body?.id, (e as Error).message);
      return;
    }

    // Resource-server token validation (RFC 9728): an expired/invalid Lune OAuth
    // access token must yield a transport-level 401 + WWW-Authenticate so the
    // client's MCP OAuth layer SILENTLY refreshes (it holds a 90-day refresh
    // token) and retries, instead of the request reaching a tool, failing
    // upstream with 401, and being mapped to a tool-execution error the model
    // surfaces as "please reconnect" (errors.ts). Opaque PATs and JWKS-infra
    // failures pass through; the API stays their authority. [[accessTokenNeedsReauth]]
    const inspection = await inspectAccessToken(token);
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
    let analyticsProbe: AnalyticsCredentialProbe | undefined;
    if (analyticsEnabled()) {
      // Probed on EVERY request, never cached: a revoked credential has to
      // stop passing on its next call, and a cache here would be exactly the
      // cross-request state the stateless transport removed.
      analyticsProbe = await (options.credentialProbe ?? probeCredential)(
        token,
      );
      if (analyticsProbe.status === "invalid") {
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
      // An identity/analytics probe outage cannot become a product outage.
      // Tool endpoints still authorize the bearer themselves; the context
      // assembled below fails closed only for analytics and workspace hints.
    }
    // The probe's identity wins BEFORE the context is built, not after:
    // `$session_id` is derived from the distinct id, so a context assembled
    // against the locally-inferred identity and patched afterwards would group
    // one client's events under two different session ids.
    const requestAnalyticsContext = analyticsContextFor(
      req,
      analyticsProbe?.identity ??
        analyticsIdentityOf(token, inspection.verifiedIdentity),
    );
    if (analyticsProbe) {
      // The API reports the two reasons capture stops SEPARATELY, and they mean
      // different things: `analytics_suppressed` is the principal's own opt-out,
      // while `analytics_capture_allowed` also goes false when the shared daily
      // event budget is spent. Keep them apart here, because only the opt-out is
      // allowed to change the tool surface (`tools/index.ts`).
      requestAnalyticsContext.captureOptOut =
        analyticsProbe.suppressAnalytics === true;
      requestAnalyticsContext.captureEnabled =
        analyticsProbe.suppressAnalytics !== true &&
        analyticsProbe.captureAllowed === true;
      requestAnalyticsContext.workspaceCredential =
        analyticsProbe.workspaceCredential === true;
    }

    // Entering the ALS scope HERE is what carries the context through the node
    // adapter into the per-request server instance: `createMcpHandler`'s factory
    // never sees the Express request, so there is nothing to thread it through.
    // Lune emits no mid-call notifications, so the response completes inside it.
    await withAnalyticsContext(requestAnalyticsContext, () =>
      nodeHandler(req, res, req.body),
    );
  });

  // Every other verb on the endpoint is the handler's own answer: 405 under the
  // stateless posture, never the 404 that would tell a client its session died.
  app.all(MCP_PATHS, (req: Request, res: Response) => {
    // The parsed body MUST be passed as the third argument. Mounting
    // `nodeHandler` directly would hand Express's `next` as that argument, which
    // the adapter ignores rather than treating as a body, so it would then read
    // the Node stream that `express.json()` has already drained.
    void nodeHandler(req, res, req.body);
  });

  return app;
}

/** Start the HTTP server bound to `port`. Pass `0` for an OS-assigned port. */
export function startHttpServer(port: number): HttpServer {
  const app = buildHttpApp();
  const handler = app.locals.mcpHandler as McpHttpHandler;
  const server = app.listen(port, () => {
    const addr = server.address();
    const boundPort = typeof addr === "object" && addr ? addr.port : port;
    console.log(`Lune MCP HTTP listening on :${boundPort}`);
  });

  // Graceful drain on deploy / scale-in. ECS sends SIGTERM, then SIGKILL after
  // the task stopTimeout (30s default). Node's default action exits immediately
  // on SIGTERM, hard-cutting every in-flight tool call, and a heavy tool holds
  // its connection for up to 120s with nothing resumable about it. The ALB
  // deregisters the target first (300s drain, see `.claude/rules/mcp.md`), so
  // this handler covers the tail: whatever is still open when SIGTERM finally
  // lands, plus every local Ctrl-C. Stop accepting new connections and let
  // in-flight requests finish; after a bounded grace (under the 30s
  // stopTimeout) abort whatever is still streaming and exit.
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
