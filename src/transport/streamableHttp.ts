import express, { type Request, type Response, type Express } from "express";
import type { Server as HttpServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { makeServer, SERVER_VERSION } from "../server.js";
import { extractTokenHttp } from "../auth/token.js";
import { accessTokenNeedsReauth } from "../auth/verify.js";
import { makeClient } from "../api/client.js";
import {
  SessionStore,
  SESSION_SWEEP_INTERVAL_MS,
  type SessionEntry,
} from "./session-store.js";

export { SessionStore, type SessionEntry } from "./session-store.js";

const SESSION_HEADER = "mcp-session-id";

/**
 * Serve an orphaned session id (present but unknown: idle/LRU-evicted or lost on
 * restart) via the SDK stateless pattern, ignoring the id. Lune tools are stateless
 * per request (Bearer per request, no server-initiated notifications) so this is
 * safe; do NOT 404 (managed-agents clients never re-init after a 404).
 * See .claude/rules/mcp.md.
 */
async function handleOrphanedSessionRequest(
  req: Request,
  res: Response,
  token: string,
): Promise<void> {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  const server = makeServer(() => makeClient(token));
  res.on("close", () => {
    void Promise.resolve(transport.close()).catch(() => undefined);
    void Promise.resolve(server.close()).catch(() => undefined);
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}

// MCP authorization (2025-06-18 spec, RFC 9728): the resource server publishes
// its own protected-resource metadata and points at the authorization server.
// Claude Desktop's remote-MCP connector hits POST /mcp anonymously, expects a
// 401 carrying `WWW-Authenticate: Bearer resource_metadata="…"`, then follows
// that URL to discover the AS. Without these two pieces, the connector reports
// "Couldn't reach the MCP server" even though the HTTP transport is healthy.
const RESOURCE_URL =
  process.env.MCP_PUBLIC_URL?.replace(/\/+$/, "") ??
  "https://mcp.luneresearch.com/mcp";
const RESOURCE_ORIGIN = new URL(RESOURCE_URL).origin;
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
const OPENAI_APPS_CHALLENGE_PATH = "/.well-known/openai-apps-challenge";
// Domain-ownership token issued by OpenAI's app directory; served verbatim
// as plain text so the verifier can fetch and compare. Override with
// `OPENAI_APPS_CHALLENGE_TOKEN` env var if rotated.
const OPENAI_APPS_CHALLENGE_TOKEN =
  process.env.OPENAI_APPS_CHALLENGE_TOKEN ??
  "Y83F79AVjQF9SsYsNflnuFc95_3EuQP5aZIOir-x0rw";

function metadataPathForEndpoint(endpointPath: "/mcp" | "/v1/mcp"): string {
  return `${PROTECTED_RESOURCE_PATH}${endpointPath}`;
}

function metadataUrl(): string {
  return `${RESOURCE_ORIGIN}${PROTECTED_RESOURCE_PATH}`;
}

function sendProtectedResourceMetadata(res: Response, resource: string): void {
  res.set("Cache-Control", "public, max-age=3600");
  res.json({
    resource,
    authorization_servers: [AUTH_SERVER_URL],
    scopes_supported: SUPPORTED_SCOPES,
    bearer_methods_supported: ["header"],
    resource_documentation: "https://luneresearch.com/docs/mcp",
  });
}

// Build the `WWW-Authenticate: Bearer ...` challenge. With no `error` this is
// the bare discovery challenge a NO-token request gets (RFC 6750 §3: omit the
// error code when the request carried no credentials); the connector follows
// `resource_metadata` to start OAuth. With `error="invalid_token"` it is the
// RFC 6750 §3.1 signal that an access token was supplied but is expired/invalid,
// which is what makes the MCP client refresh-then-retry instead of surfacing a
// failure to the model.
function challenge(error?: string, description?: string): string {
  if (!error) return `Bearer resource_metadata="${metadataUrl()}"`;
  const params = [`error="${error}"`];
  if (description) params.push(`error_description="${description}"`);
  params.push(`resource_metadata="${metadataUrl()}"`);
  return `Bearer ${params.join(", ")}`;
}

// Emit a transport-level 401 carrying the challenge in BOTH the `WWW-Authenticate`
// header and the JSON-RPC error `data._meta` (per the MCP authorization spec), so
// a client that parses either path can discover the AS / trigger refresh. `id`
// echoes the request id; `?? null` preserves a literal `0` id.
function sendUnauthorized(
  res: Response,
  id: unknown,
  message: string,
  opts?: { error?: string; description?: string },
): void {
  const authenticate = challenge(opts?.error, opts?.description);
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
 * Stable identity a session is bound to. An OAuth RS256 JWT binds to its `sub`
 * claim (survives token refresh: same user, new token); an opaque PAT binds to
 * a hash of the token (the token IS the identity). Decode only (the token was
 * already adjudicated by accessTokenNeedsReauth upstream); binding never trusts
 * an unverified claim for AUTH, only for "is this the same principal as before".
 */
export function subjectOf(token: string): string {
  const parts = token.split(".");
  if (parts.length === 3) {
    try {
      const payload = JSON.parse(
        Buffer.from(parts[1]!, "base64url").toString(),
      ) as {
        sub?: unknown;
        org_id?: unknown;
      };
      if (typeof payload.sub === "string" && payload.sub) {
        // Bind to sub AND org_id: a Lune OAuth token for the SAME user but a
        // DIFFERENT org shares the sub yet bills + authorizes a different org, so
        // it must not reuse this session (would swap the session's org context).
        // org_id is stable across token refresh, so refresh still reuses. A JWT
        // without org_id (non-Lune) falls back to sub alone (still refresh-stable).
        const org =
          typeof payload.org_id === "string" && payload.org_id
            ? `:${payload.org_id}`
            : "";
        return `jwt:${payload.sub}${org}`;
      }
    } catch {
      /* not a JWT we can decode; fall through to the opaque-token hash */
    }
  }
  return `pat:${createHash("sha256").update(token).digest("hex")}`;
}

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

/**
 * True iff the request's bearer resolves to the session's bound principal.
 * GET (attach to the SSE stream) and DELETE (tear the session down) act on a
 * live session by id; without this a LEAKED session id alone (plus any, or no,
 * bearer) could attach or teardown another principal's session. A missing /
 * invalid bearer or a different subject returns false, so those verbs match the
 * POST path's subject binding. (An unknown session id is handled by the callers
 * as before, preserving orphan-session recovery.)
 */
function sessionMatchesBearer(req: Request, entry: SessionEntry): boolean {
  let token: string;
  try {
    token = extractTokenHttp(req.headers);
  } catch {
    return false;
  }
  return subjectOf(token) === entry.subject;
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
  new URL(RESOURCE_URL).host,
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

/** Build the express app without binding it to a port. Useful for tests. */
export function buildHttpApp(): Express {
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
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Authorization, Content-Type, Accept, mcp-session-id, mcp-protocol-version, last-event-id",
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
    res.json({ status: "ok", server: "lune-mcp", version: SERVER_VERSION });
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
  app.get(PROTECTED_RESOURCE_PATH, (_req: Request, res: Response) => {
    sendProtectedResourceMetadata(res, RESOURCE_URL);
  });

  app.get(metadataPathForEndpoint("/mcp"), (_req: Request, res: Response) => {
    sendProtectedResourceMetadata(res, RESOURCE_URL);
  });

  app.get(
    metadataPathForEndpoint("/v1/mcp"),
    (_req: Request, res: Response) => {
      sendProtectedResourceMetadata(res, RESOURCE_URL);
    },
  );

  // DNS-rebinding / CSRF guard, scoped to the JSON-RPC endpoints only: health,
  // well-known and favicon stay open for ALB checks and directory crawlers.
  // Rejects a spoofed/rebound Host or a present-but-disallowed browser Origin
  // BEFORE the request can execute a tool call.
  app.use(["/mcp", "/v1/mcp"], (req: Request, res: Response, next) => {
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

  // Session registry with idle eviction. Cleared on transport close (DELETE
  // /mcp or transport error) and by the periodic sweep in startHttpServer.
  const sessions = new SessionStore();
  app.locals.sessionStore = sessions;

  // `/v1/mcp` was the path advertised in early docs and on the marketing
  // hero. The canonical path is `/mcp`; the alias keeps existing installs
  // and any cached docs functional.
  app.post(["/mcp", "/v1/mcp"], async (req: Request, res: Response) => {
    let token: string;
    try {
      token = extractTokenHttp(req.headers);
    } catch (e) {
      // RFC 6750 §3 + MCP authorization spec: the WWW-Authenticate header is
      // what triggers the connector's OAuth discovery + browser-based consent.
      sendUnauthorized(res, req.body?.id, (e as Error).message);
      return;
    }

    // Resource-server token validation (RFC 9728): an expired/invalid Lune OAuth
    // access token must yield a transport-level 401 + WWW-Authenticate so the
    // client's MCP OAuth layer SILENTLY refreshes (it holds a 30-day refresh
    // token) and retries, instead of the request reaching a tool, failing
    // upstream with 401, and being mapped to a tool-execution error the model
    // surfaces as "please reconnect" (errors.ts). Opaque PATs and JWKS-infra
    // failures pass through; the API stays their authority. [[accessTokenNeedsReauth]]
    if (await accessTokenNeedsReauth(token)) {
      sendUnauthorized(
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

    const existingId = readSessionId(req);
    let entry: SessionEntry | undefined = existingId
      ? sessions.get(existingId)
      : undefined;

    if (!entry) {
      if (!isInitializeRequest(req.body)) {
        // A present-but-unknown session id (idle-evicted, LRU-evicted, or
        // lost to a task restart) is served through an ephemeral stateless
        // transport instead of the spec's 404: see
        // [[handleOrphanedSessionRequest]] for why a 404 permanently breaks
        // the Anthropic managed-agents client. 400 stays reserved for a
        // request carrying NO session id that also isn't an `initialize`
        // (the only method allowed to mint one).
        if (existingId !== undefined) {
          await handleOrphanedSessionRequest(req, res, token);
          return;
        }
        res.status(400).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "No valid session ID provided" },
          id: null,
        });
        return;
      }
      // An initialize request always mints a fresh session, even when it
      // arrives with a stale session header from a client recovering after an
      // eviction or restart (out-of-spec for the client, harmless to accept).

      // Create a new transport + server pair. The closure over `entry.token`
      // means each tool call reads the latest rotated token.
      // Initialise as undefined; assigned right after to satisfy TS.
      let createdSessionId: string | undefined;
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          createdSessionId = sid;
          // entry is created below, then registered once we know the sid.
        },
      });

      // The factory closure reads the live `entry.token`, defaulting to the
      // current request's token until `entry` is assigned.
      const tokenRef = { current: token };
      const server = makeServer(() => makeClient(tokenRef.current));
      await server.connect(transport);

      entry = {
        transport,
        token,
        subject: subjectOf(token),
        lastSeen: Date.now(),
        inFlight: 0,
      };
      // Replace the closure ref with one that follows `entry.token`.
      Object.defineProperty(tokenRef, "current", {
        get: () => entry!.token,
      });

      transport.onclose = () => {
        // `onsessioninitialized` fires synchronously inside `handleRequest`,
        // before any path that triggers `onclose`, so both `createdSessionId`
        // and `transport.sessionId` are populated together. The
        // `transport.sessionId` fallback is here only for the pathological
        // case where the transport closes before `onsessioninitialized` set
        // our captured id but after the SDK generated its own.
        if (createdSessionId) sessions.delete(createdSessionId);
        /* v8 ignore next */
        else if (transport.sessionId) sessions.delete(transport.sessionId);
      };

      // Run the request; this will trigger onsessioninitialized synchronously.
      await transport.handleRequest(req, res, req.body);
      const sid = createdSessionId ?? transport.sessionId;
      if (sid) sessions.register(sid, entry);
      return;
    }

    // Reject cross-principal reuse of a live session id: a bearer that resolves
    // to a DIFFERENT subject must never bind to this transport (session hijack
    // via a guessed id + any valid bearer) nor have a concurrent dispatch read
    // its token swapped into the shared slot. Serve it through the stateless
    // orphan path (its own per-request token, no shared state) so a legit client
    // that happens to reuse an id still works, without ever sharing a session.
    if (subjectOf(token) !== entry.subject) {
      await handleOrphanedSessionRequest(req, res, token);
      return;
    }
    // Same principal: refresh the token (OAuth refresh mid-conversation) and
    // dispatch. Same-subject token churn is benign (both are valid for them).
    // Track in-flight so a long heavy-tool response isn't picked as the LRU
    // eviction victim while it runs (see SessionEntry.inFlight).
    entry.token = token;
    entry.inFlight += 1;
    try {
      await entry.transport.handleRequest(req, res, req.body);
    } finally {
      entry.inFlight -= 1;
    }
  });

  // GET /mcp opens the standalone SSE stream for server-initiated notifications.
  app.get(["/mcp", "/v1/mcp"], async (req: Request, res: Response) => {
    const sid = readSessionId(req);
    let entry = sid ? sessions.get(sid) : undefined;
    // Only the session's OWN principal may attach to its stream: a leaked id
    // with a foreign/absent bearer is treated as unknown (405), never attached.
    if (entry && !sessionMatchesBearer(req, entry)) entry = undefined;
    if (!entry) {
      // Present-but-unknown session id → 405 ("no standalone SSE stream
      // offered at this endpoint", legal at any time per the Streamable-HTTP
      // spec), NOT 404: 404 declares the session terminated, which the
      // managed-agents client cannot recover from, while its POSTs on the
      // same orphaned id are still served statelessly. We emit no
      // server-initiated notifications, so there is nothing to stream
      // anyway. A truly-absent id → 400.
      if (sid !== undefined) {
        res
          .set("Allow", "POST, DELETE")
          .status(405)
          .send("SSE stream not available for this session");
      } else {
        res.status(400).send("Invalid or missing session ID");
      }
      return;
    }
    await entry.transport.handleRequest(req, res);
  });

  // DELETE /mcp tears down the session.
  app.delete(["/mcp", "/v1/mcp"], async (req: Request, res: Response) => {
    const sid = readSessionId(req);
    const entry = sid ? sessions.get(sid) : undefined;
    // Only the session's OWN principal may tear it down: a leaked id with a
    // foreign/absent bearer is a benign no-op (204), never a teardown of
    // someone else's live session (it idle-evicts on its own anyway).
    if (!entry || !sessionMatchesBearer(req, entry)) {
      res.status(204).end();
      return;
    }
    await entry.transport.handleRequest(req, res);
    if (sid) sessions.delete(sid);
  });

  return app;
}

/** Start the HTTP server bound to `port`. Pass `0` for an OS-assigned port. */
export function startHttpServer(port: number): HttpServer {
  const app = buildHttpApp();
  // Periodically evict idle sessions so leaked/abandoned sessions can't grow
  // the in-process Map without bound. `unref` keeps the timer from holding the
  // process open; it is cleared when the server closes.
  const store = app.locals.sessionStore as SessionStore;
  const sweep = setInterval(() => store.sweep(), SESSION_SWEEP_INTERVAL_MS);
  sweep.unref();
  const server = app.listen(port, () => {
    const addr = server.address();
    const boundPort = typeof addr === "object" && addr ? addr.port : port;
    console.log(`Lune MCP HTTP listening on :${boundPort}`);
  });
  server.on("close", () => clearInterval(sweep));

  // Graceful drain on deploy / scale-in. ECS sends SIGTERM, then SIGKILL after
  // the task stopTimeout (30s default). Node's default action exits immediately
  // on SIGTERM, hard-cutting every in-flight tool call; with this service pinned
  // to one task there is no sibling to absorb them. Stop accepting new
  // connections and let in-flight requests finish; after a bounded grace (under
  // the 30s stopTimeout) close any lingering idle SSE sessions and exit.
  let draining = false;
  const drain = (signal: string): void => {
    if (draining) return;
    draining = true;
    console.log(`Lune MCP received ${signal}; draining in-flight requests`);
    clearInterval(sweep);
    server.close(() => {
      console.log("Lune MCP drained cleanly; exiting");
      process.exit(0);
    });
    const force = setTimeout(() => {
      console.warn("Lune MCP drain grace elapsed; closing remaining sessions");
      store.sweep(0); // ttl 0: close + drop every remaining session
      process.exit(0);
    }, 25_000);
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
