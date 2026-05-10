import express, { type Request, type Response, type Express } from 'express';
import type { Server as HttpServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { makeServer, SERVER_VERSION } from '../server.js';
import { extractTokenHttp } from '../auth/token.js';
import { makeClient } from '../api/client.js';

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  /** Mutable Bearer; updated on every request to handle OAuth refresh mid-session. */
  token: string;
}

const SESSION_HEADER = 'mcp-session-id';

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

function readSessionId(req: Request): string | undefined {
  const v = req.headers[SESSION_HEADER];
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

  // Session registry. Cleared on transport close (DELETE /mcp or transport error).
  const sessions = new Map<string, SessionEntry>();

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
      const authenticate = `Bearer resource_metadata="${metadataUrl()}"`;
      res.set('WWW-Authenticate', authenticate);
      res.status(401).json({
        jsonrpc: '2.0',
        error: {
          code: -32001,
          message: (e as Error).message,
          data: {
            _meta: {
              'mcp/www_authenticate': authenticate,
            },
          },
        },
        id: req.body?.id ?? null,
      });
      return;
    }

    const existingId = readSessionId(req);
    let entry: SessionEntry | undefined = existingId ? sessions.get(existingId) : undefined;

    if (!entry) {
      // Only an `initialize` request may create a new session. Other methods on
      // an unknown sessionId are rejected per MCP spec.
      if (existingId !== undefined || !isInitializeRequest(req.body)) {
        res.status(400).json({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'No valid session ID provided' },
          id: null,
        });
        return;
      }

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

      entry = { transport, token };
      // Replace the closure ref with one that follows `entry.token`.
      Object.defineProperty(tokenRef, 'current', {
        get: () => entry!.token,
      });

      transport.onclose = () => {
        if (createdSessionId) sessions.delete(createdSessionId);
        else if (transport.sessionId) sessions.delete(transport.sessionId);
      };

      // Run the request; this will trigger onsessioninitialized synchronously.
      await transport.handleRequest(req, res, req.body);
      const sid = createdSessionId ?? transport.sessionId;
      if (sid) sessions.set(sid, entry);
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
      res.status(400).send('Invalid or missing session ID');
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
  const server = app.listen(port, () => {
    const addr = server.address();
    const boundPort = typeof addr === 'object' && addr ? addr.port : port;
    console.log(`Lune MCP HTTP listening on :${boundPort}`);
  });
  return server;
}
