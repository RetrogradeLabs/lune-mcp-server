/**
 * Streamable HTTP transport guard + session-transition coverage.
 *
 * Complements `full-http.test.ts` and `http-app.test.ts` rather than repeating
 * them. The additive assertions here are:
 *   - a follow-up POST (the `notifications/initialized` notification) on a freshly
 *     issued `mcp-session-id` is accepted (202), proving session reuse on a path
 *     full-http does not exercise (it reuses via `tools/list`);
 *   - an unknown-session POST is served statelessly (200; see
 *     orphaned-session.test.ts for the full contract), and the GET stream for
 *     the same id is declined with 405 (not 404 = session death);
 *   - a no-session non-initialize POST mints NO `mcp-session-id` header
 *     (400 / -32000);
 *   - host guard BOTH directions: deny on GET (403 / -32003) and admit (the
 *     configured public host AND loopback) far enough to reach session
 *     handling (200 / 405, anything but 403), proving the guard sits upstream
 *     of session handling;
 *   - origin guard BOTH directions: deny (403 / -32003), admit https://claude.ai
 *     to session handling (200), and admit an absent Origin (initialize succeeds);
 *   - CORS preflight: an allowed origin yields 204 with ACAO echoed and
 *     Allow-Credentials: true, while a disallowed origin omits ACAO.
 *
 * Host/Origin cannot be set through WHATWG `fetch`, so these drive a raw
 * `http.request` (the same approach as `http-app.test.ts`); CORS preflight uses
 * `fetch` since it sets only Origin + request-method headers.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server as HttpServer } from 'node:http';
import http from 'node:http';
import { buildHttpApp } from '../../src/transport/streamableHttp.js';

interface RawResponse {
  status: number | undefined;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function rawRequest(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method,
        headers: {
          ...(data === undefined
            ? {}
            : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }),
          ...headers,
        },
      },
      (res) => {
        let chunks = '';
        res.on('data', (c) => (chunks += c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: chunks }));
      },
    );
    req.on('error', reject);
    if (data !== undefined) req.write(data);
    req.end();
  });
}

type JsonRpcError = { error?: { code?: number; message?: string } };

// JSON-RPC error bodies arrive either as a plain JSON object (the guard and
// no-session branches use `res.json(...)`) or as a single SSE frame
// (`event: message\ndata: {...}`) when the transport answers. Accept both.
function parseJsonRpc(raw: string): JsonRpcError {
  const dataLine = raw.split(/\r?\n/).find((line) => line.startsWith('data:'));
  const payload = dataLine ? dataLine.slice('data:'.length).trim() : raw.trim();
  return JSON.parse(payload) as JsonRpcError;
}

const ACCEPT = 'application/json, text/event-stream';
const AUTH = 'Bearer lune_fake_transport_token';

function initBody(): unknown {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'vitest', version: '0.0.0' },
    },
  };
}

function toolsListBody(id: number): unknown {
  return { jsonrpc: '2.0', id, method: 'tools/list', params: {} };
}

let server: HttpServer;
let port: number;

beforeAll(async () => {
  const app = buildHttpApp();
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('http transport: session creation and reuse', () => {
  it('mints a session id on initialize, then accepts a follow-up notification on that id (202)', async () => {
    const init = await rawRequest(port, 'POST', '/mcp', { accept: ACCEPT, authorization: AUTH }, initBody());
    expect(init.status).toBe(200);
    const sessionId = init.headers['mcp-session-id'];
    expect(typeof sessionId).toBe('string');
    expect((sessionId as string).length).toBeGreaterThan(0);

    // A second request that reuses the issued id must resolve against the live
    // session. The `initialized` notification carries no id, so a found session
    // replies 202 Accepted; a missing/unknown one would 404. This proves reuse
    // without duplicating full-http's initialize -> tools/list reuse path.
    const followUp = await rawRequest(
      port,
      'POST',
      '/mcp',
      { accept: ACCEPT, authorization: AUTH, 'mcp-session-id': sessionId as string },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
    );
    expect(followUp.status).toBe(202);
  });
});

describe('http transport: unknown session id', () => {
  it('serves an unknown-session POST statelessly instead of 404', async () => {
    // Orphaned ids (idle eviction, LRU eviction, task restart) get a fresh
    // stateless transport per request; the Anthropic managed-agents client
    // never re-initializes after a 404, so a 404 here bricked dashboard
    // follow-up turns (2026-06-10). Full contract: orphaned-session.test.ts.
    const res = await rawRequest(
      port,
      'POST',
      '/mcp',
      { accept: ACCEPT, authorization: AUTH, 'mcp-session-id': 'definitely-not-real' },
      toolsListBody(2),
    );
    expect(res.status).toBe(200);
    expect(parseJsonRpc(res.body).error).toBeUndefined();
  });

  it('declines an unknown-session GET stream with 405 (not 404 = session death)', async () => {
    const res = await rawRequest(port, 'GET', '/mcp', {
      accept: 'text/event-stream',
      authorization: AUTH,
      'mcp-session-id': 'definitely-not-real',
    });
    expect(res.status).toBe(405);
  });
});

describe('http transport: no-session non-initialize POST', () => {
  it('rejects with 400 / -32000 and mints no session id', async () => {
    const res = await rawRequest(
      port,
      'POST',
      '/mcp',
      { accept: ACCEPT, authorization: AUTH },
      toolsListBody(7),
    );
    expect(res.status).toBe(400);
    // No id header is issued: a non-initialize call may not mint a session.
    expect(res.headers['mcp-session-id']).toBeUndefined();
    const body = parseJsonRpc(res.body);
    expect(body.error?.code).toBe(-32000);
    expect(body.error?.message ?? '').toMatch(/no valid session/i);
  });
});

describe('http transport: host guard (both directions)', () => {
  it('rejects a disallowed Host on the GET stream with 403 / -32003', async () => {
    const res = await rawRequest(port, 'GET', '/mcp', {
      accept: 'text/event-stream',
      authorization: AUTH,
      host: 'attacker.example.com',
      'mcp-session-id': 'x',
    });
    expect(res.status).toBe(403);
    const body = parseJsonRpc(res.body);
    expect(body.error?.code).toBe(-32003);
    expect(body.error?.message ?? '').toMatch(/host not allowed/i);
  });

  it('admits the configured public host past the guard to session handling (200, not 403)', async () => {
    const res = await rawRequest(
      port,
      'POST',
      '/mcp',
      { accept: ACCEPT, authorization: AUTH, host: 'mcp.luneresearch.com', 'mcp-session-id': 'x' },
      toolsListBody(3),
    );
    // Reaching the stateless orphan handler proves the guard let the request
    // through; a 403 here would mean the allowlisted host was wrongly rejected.
    expect(res.status).toBe(200);
  });

  it('admits a loopback Host past the guard to session handling (405, not 403)', async () => {
    const res = await rawRequest(port, 'GET', '/mcp', {
      accept: 'text/event-stream',
      authorization: AUTH,
      host: '127.0.0.1:9',
      'mcp-session-id': 'x',
    });
    expect(res.status).toBe(405);
  });
});

describe('http transport: origin guard (both directions)', () => {
  it('rejects a present, disallowed Origin with 403 / -32003', async () => {
    const res = await rawRequest(
      port,
      'POST',
      '/mcp',
      { accept: ACCEPT, authorization: AUTH, origin: 'https://evil.example.com' },
      toolsListBody(4),
    );
    expect(res.status).toBe(403);
    const body = parseJsonRpc(res.body);
    expect(body.error?.code).toBe(-32003);
    expect(body.error?.message ?? '').toMatch(/origin not allowed/i);
  });

  it('admits the allowed https://claude.ai Origin past the guard to session handling (200)', async () => {
    const res = await rawRequest(
      port,
      'POST',
      '/mcp',
      { accept: ACCEPT, authorization: AUTH, origin: 'https://claude.ai', 'mcp-session-id': 'x' },
      toolsListBody(5),
    );
    expect(res.status).toBe(200);
  });

  it('admits a request with no Origin header (initialize succeeds and a session is minted)', async () => {
    const res = await rawRequest(port, 'POST', '/mcp', { accept: ACCEPT, authorization: AUTH }, initBody());
    expect(res.status).toBe(200);
    expect(typeof res.headers['mcp-session-id']).toBe('string');
  });
});

describe('http transport: CORS preflight (both directions)', () => {
  it('answers an allowed-origin OPTIONS with 204, ACAO echoed, and Allow-Credentials: true', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://claude.ai',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type,authorization,mcp-session-id',
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://claude.ai');
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
    expect(res.headers.get('access-control-allow-methods') ?? '').toContain('POST');
  });

  it('does not echo Access-Control-Allow-Origin for a disallowed preflight origin', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example.com', 'access-control-request-method': 'POST' },
    });
    // The preflight still short-circuits (204), but with no allow-origin grant
    // the browser blocks the cross-origin response.
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});
