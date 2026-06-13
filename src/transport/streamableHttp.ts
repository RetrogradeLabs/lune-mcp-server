import express, { type Request, type Response, type Express } from 'express';
import type { Server as HttpServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { makeServer, SERVER_VERSION } from '../server.js';
import { extractTokenHttp } from '../auth/token.js';
import { accessTokenNeedsReauth } from '../auth/verify.js';
import { makeClient } from '../api/client.js';

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  /** Mutable Bearer; updated on every request to handle OAuth refresh mid-session. */
  token: string;
  /** Epoch ms of the last request on this session; drives idle eviction. */
  lastSeen: number;
}

// Idle sessions are evicted so a client that opens `initialize` sessions and
// walks away cannot leak transports until the (pinned, single-task) process
// OOMs. Touch-on-access keeps live conversations alive; the sweep closes the
// rest. Overridable for ops via MCP_SESSION_IDLE_TTL_SEC.
const SESSION_IDLE_TTL_MS = (Number(process.env.MCP_SESSION_IDLE_TTL_SEC) || 30 * 60) * 1000;
const SESSION_SWEEP_INTERVAL_MS = 60_000;
// Hard ceiling on concurrently live sessions. Idle eviction only fires after
// SESSION_IDLE_TTL_MS, so without a cap a burst of cheap `initialize` calls
// (each creates a transport + server + client, with no upstream auth check)
// accumulates up to one TTL window of sessions and OOMs the pinned single task
// before the sweep prunes anything. The task is sized for ~50 concurrent
// sessions; the default leaves headroom while bounding burst growth. Override
// via MCP_MAX_SESSIONS.
const SESSION_MAX = Math.max(1, Number(process.env.MCP_MAX_SESSIONS) || 256);

/**
 * In-process session registry with idle eviction. `get` touches `lastSeen`, so
 * any POST/GET/DELETE on a session keeps it alive; `sweep` closes and drops the
 * ones idle past the TTL. Single-task only (per mcp.md): a multi-task rollout
 * still needs a shared store.
 */
export class SessionStore {
  private readonly sessions = new Map<string, SessionEntry>();

  constructor(private readonly maxSize: number = SESSION_MAX) {}

  get size(): number {
    return this.sessions.size;
  }

  get(id: string): SessionEntry | undefined {
    const entry = this.sessions.get(id);
    if (entry) entry.lastSeen = Date.now();
    return entry;
  }

  register(id: string, entry: SessionEntry): void {
    // Bound the live-session count so a burst of `initialize` calls can't grow
    // the Map without limit and OOM the pinned task before idle eviction kicks
    // in. At the cap, drop the least-recently-used session (oldest lastSeen):
    // normal concurrency stays well under the cap, so this only bites an
    // abnormal flood, where evicting the oldest (most likely abandoned) entry
    // is the right victim.
    if (!this.sessions.has(id) && this.sessions.size >= this.maxSize) {
      this.evictOldest();
    }
    this.sessions.set(id, entry);
  }

  /** Close and drop the least-recently-used session to make room at the cap. */
  private evictOldest(): void {
    let oldestId: string | undefined;
    let oldestSeen = Infinity;
    for (const [id, entry] of this.sessions) {
      if (entry.lastSeen < oldestSeen) {
        oldestSeen = entry.lastSeen;
        oldestId = id;
      }
    }
    if (oldestId !== undefined) {
      const victim = this.sessions.get(oldestId)!;
      void Promise.resolve(victim.transport.close()).catch(() => undefined);
      this.sessions.delete(oldestId);
    }
  }

  delete(id: string): void {
    this.sessions.delete(id);
  }

  /** Close and drop every session idle longer than `ttlMs`. Returns the count evicted. */
  sweep(ttlMs: number = SESSION_IDLE_TTL_MS, now: number = Date.now()): number {
    let evicted = 0;
    for (const [id, entry] of this.sessions) {
      if (now - entry.lastSeen > ttlMs) {
        void Promise.resolve(entry.transport.close()).catch(() => undefined);
        this.sessions.delete(id);
        evicted += 1;
      }
    }
    return evicted;
  }
}

const SESSION_HEADER = 'mcp-session-id';

/**
 * Serve one JSON-RPC POST through a fresh stateless transport + server pair,
 * ignoring the (orphaned) session id it arrived with.
 *
 * The in-process SessionStore loses sessions on idle eviction (30-min TTL),
 * LRU-cap eviction, and every task restart/deploy, but clients hold ids much
 * longer: the Anthropic Managed Agents MCP client (dashboard Assistant +
 * Critique) keeps ONE id for the lifetime of a managed session (24h) and does
 * NOT re-initialize after a 404. A spec-correct "Session not found" therefore
 * bricked every later tool call in the managed session ("server terminated
 * the MCP session" / "server URL not found", prod 2026-06-10). Every Lune
 * tool is stateless per request (the Bearer arrives on each request; no
 * subscriptions, no sampling, no server-initiated notifications), so the
 * session carries no semantic state worth refusing over: handle the request
 * exactly like the SDK's documented stateless pattern and let the client keep
 * using its remembered id. No session is registered and no id header is
 * echoed; the pair is torn down when the response closes.
 */
async function handleOrphanedSessionRequest(
  req: Request,
  res: Response,
  token: string,
): Promise<void> {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const server = makeServer(() => makeClient(token));
  res.on('close', () => {
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
  process.env.MCP_PUBLIC_URL?.replace(/\/+$/, '') ?? 'https://mcp.luneresearch.com/mcp';
const RESOURCE_ORIGIN = new URL(RESOURCE_URL).origin;
const AUTH_SERVER_URL =
  process.env.LUNE_AUTH_SERVER_URL?.replace(/\/+$/, '') ?? 'https://api.luneresearch.com';
const SUPPORTED_SCOPES = ['papers:read', 'guidance:read', 'subs:rw', 'account:read'];
const PROTECTED_RESOURCE_PATH = '/.well-known/oauth-protected-resource';
const OPENAI_APPS_CHALLENGE_PATH = '/.well-known/openai-apps-challenge';
// Domain-ownership token issued by OpenAI's app directory; served verbatim
// as plain text so the verifier can fetch and compare. Override with
// `OPENAI_APPS_CHALLENGE_TOKEN` env var if rotated.
const OPENAI_APPS_CHALLENGE_TOKEN =
  process.env.OPENAI_APPS_CHALLENGE_TOKEN ?? 'Y83F79AVjQF9SsYsNflnuFc95_3EuQP5aZIOir-x0rw';

function metadataPathForEndpoint(endpointPath: '/mcp' | '/v1/mcp'): string {
  return `${PROTECTED_RESOURCE_PATH}${endpointPath}`;
}

function metadataUrl(): string {
  return `${RESOURCE_ORIGIN}${PROTECTED_RESOURCE_PATH}`;
}

function sendProtectedResourceMetadata(res: Response, resource: string): void {
  res.set('Cache-Control', 'public, max-age=3600');
  res.json({
    resource,
    authorization_servers: [AUTH_SERVER_URL],
    scopes_supported: SUPPORTED_SCOPES,
    bearer_methods_supported: ['header'],
    resource_documentation: 'https://luneresearch.com/docs/mcp',
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
  return `Bearer ${params.join(', ')}`;
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
  res.set('WWW-Authenticate', authenticate);
  res.status(401).json({
    jsonrpc: '2.0',
    error: { code: -32001, message, data: { _meta: { 'mcp/www_authenticate': authenticate } } },
    id: id ?? null,
  });
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

// Origins that browser-based MCP clients connect from. Must echo a specific
// origin (not `*`) when `Access-Control-Allow-Credentials: true` is set;
// without this, the connector's sign-in fetch is blocked by the browser
// before it ever reaches the JSON-RPC handler.
const ALLOWED_ORIGINS = new Set([
  'https://claude.ai',
  'https://claude.com',
  'https://chatgpt.com',
  'https://platform.openai.com',
  'https://luneresearch.com',
  'https://www.luneresearch.com',
  'http://localhost:3000',
  'http://localhost:1420',
]);

// Host allowlist for the JSON-RPC endpoints (DNS-rebinding / Host-spoofing
// guard). The SDK transport ships with no Host/Origin validation, and the CORS
// layer below only *sets* ACAO headers, it never *rejects*, so without this a
// disallowed-Origin browser request (or a rebound Host) still executes a
// state-changing tool call before the browser drops the response. Loopback is
// always allowed for local dev and tests; extra hosts via MCP_ALLOWED_HOSTS.
const ALLOWED_HOSTS = new Set<string>([
  new URL(RESOURCE_URL).host,
  ...(process.env.MCP_ALLOWED_HOSTS?.split(',').map((h) => h.trim()).filter(Boolean) ?? []),
]);

export function hostIsAllowed(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  const host = hostHeader.toLowerCase();
  const hostname = host.replace(/:\d+$/, '');
  if (ALLOWED_HOSTS.has(host) || ALLOWED_HOSTS.has(hostname)) return true;
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

export function originIsAllowed(origin: string | string[] | undefined): boolean {
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
    if (typeof origin === 'string' && ALLOWED_ORIGINS.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader(
        'Access-Control-Allow-Headers',
        'Authorization, Content-Type, Accept, mcp-session-id, mcp-protocol-version, last-event-id',
      );
      res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id, WWW-Authenticate');
      res.setHeader('Access-Control-Max-Age', '86400');
    }
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });
  app.use(express.json({ limit: '1mb' }));
  app.disable('x-powered-by');

  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', server: 'lune-mcp', version: SERVER_VERSION });
  });

  // OpenAI Apps domain-ownership challenge. Public, no auth, cached briefly.
  // The verifier fetches the path and expects the raw token in the body.
  app.get(OPENAI_APPS_CHALLENGE_PATH, (_req: Request, res: Response) => {
    res.set('Cache-Control', 'public, max-age=86400');
    res.type('text/plain').send(OPENAI_APPS_CHALLENGE_TOKEN);
  });

  // Favicon redirects so directory crawlers (Google s2 / Anthropic / OpenAI)
  // resolve our brand mark when they probe the MCP host instead of the apex.
  // The canonical asset lives at luneresearch.com/favicon.svg and is owned
  // by the marketing site; mirroring it here would only invite drift.
  app.get(['/favicon.ico', '/favicon.svg', '/apple-touch-icon.png'], (_req: Request, res: Response) => {
    res.set('Cache-Control', 'public, max-age=86400');
    res.redirect(302, 'https://luneresearch.com/favicon.svg');
  });

  // RFC 9728 protected-resource metadata. Public, no auth, cacheable. The
  // `resource` claim binds tokens to this server's URL; `authorization_servers`
  // points at the Lune API which exposes the full OAuth 2.1 + DCR machinery.
  app.get(PROTECTED_RESOURCE_PATH, (_req: Request, res: Response) => {
    sendProtectedResourceMetadata(res, RESOURCE_URL);
  });

  app.get(metadataPathForEndpoint('/mcp'), (_req: Request, res: Response) => {
    sendProtectedResourceMetadata(res, RESOURCE_URL);
  });

  app.get(metadataPathForEndpoint('/v1/mcp'), (_req: Request, res: Response) => {
    sendProtectedResourceMetadata(res, RESOURCE_URL);
  });

  // DNS-rebinding / CSRF guard, scoped to the JSON-RPC endpoints only: health,
  // well-known and favicon stay open for ALB checks and directory crawlers.
  // Rejects a spoofed/rebound Host or a present-but-disallowed browser Origin
  // BEFORE the request can execute a tool call.
  app.use(['/mcp', '/v1/mcp'], (req: Request, res: Response, next) => {
    if (!hostIsAllowed(req.headers.host)) {
      res.status(403).json({
        jsonrpc: '2.0',
        error: { code: -32003, message: 'Forbidden: host not allowed' },
        id: null,
      });
      return;
    }
    if (!originIsAllowed(req.headers.origin)) {
      res.status(403).json({
        jsonrpc: '2.0',
        error: { code: -32003, message: 'Forbidden: origin not allowed' },
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
  app.post(['/mcp', '/v1/mcp'], async (req: Request, res: Response) => {
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
      sendUnauthorized(res, req.body?.id, 'Access token expired or invalid; re-authenticate to continue.', {
        error: 'invalid_token',
        description: 'The access token is expired or invalid.',
      });
      return;
    }

    const existingId = readSessionId(req);
    let entry: SessionEntry | undefined = existingId ? sessions.get(existingId) : undefined;

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
          jsonrpc: '2.0',
          error: { code: -32000, message: 'No valid session ID provided' },
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

      entry = { transport, token, lastSeen: Date.now() };
      // Replace the closure ref with one that follows `entry.token`.
      Object.defineProperty(tokenRef, 'current', {
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

    // Existing session: refresh token (handles OAuth refresh mid-conversation)
    // and dispatch through the transport.
    entry.token = token;
    await entry.transport.handleRequest(req, res, req.body);
  });

  // GET /mcp opens the standalone SSE stream for server-initiated notifications.
  app.get(['/mcp', '/v1/mcp'], async (req: Request, res: Response) => {
    const sid = readSessionId(req);
    const entry = sid ? sessions.get(sid) : undefined;
    if (!entry) {
      // Present-but-unknown session id → 405 ("no standalone SSE stream
      // offered at this endpoint", legal at any time per the Streamable-HTTP
      // spec), NOT 404: 404 declares the session terminated, which the
      // managed-agents client cannot recover from, while its POSTs on the
      // same orphaned id are still served statelessly. We emit no
      // server-initiated notifications, so there is nothing to stream
      // anyway. A truly-absent id → 400.
      if (sid !== undefined) {
        res.set('Allow', 'POST, DELETE').status(405).send('SSE stream not available for this session');
      } else {
        res.status(400).send('Invalid or missing session ID');
      }
      return;
    }
    await entry.transport.handleRequest(req, res);
  });

  // DELETE /mcp tears down the session.
  app.delete(['/mcp', '/v1/mcp'], async (req: Request, res: Response) => {
    const sid = readSessionId(req);
    const entry = sid ? sessions.get(sid) : undefined;
    if (!entry) {
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
    const boundPort = typeof addr === 'object' && addr ? addr.port : port;
    console.log(`Lune MCP HTTP listening on :${boundPort}`);
  });
  server.on('close', () => clearInterval(sweep));
  return server;
}
