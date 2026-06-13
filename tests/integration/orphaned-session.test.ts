/**
 * Orphaned-session resilience: a POST bearing a present-but-unknown
 * `mcp-session-id` must be SERVED, not 404'd.
 *
 * Why: the in-process SessionStore loses sessions on idle eviction (30-min
 * TTL), LRU-cap eviction, and every ECS task restart/deploy, while clients
 * legitimately hold a session id for much longer. The Anthropic Managed
 * Agents MCP client (dashboard Assistant/Critique) keeps ONE id for the
 * lifetime of a managed session (24h) and does NOT re-initialize after a 404:
 * it surfaces "server terminated the MCP session" and every later tool call
 * in that managed session fails (prod incident 2026-06-10: turn 0 succeeded,
 * the follow-up 64 min later failed 3/3 tool calls). Lune's tools are
 * stateless per request (Bearer auth arrives on every request; no
 * subscriptions, sampling, or server-initiated notifications), so the HTTP
 * session carries no semantic state worth refusing over: orphaned requests
 * are served through an ephemeral per-request stateless transport (the MCP
 * SDK's documented stateless pattern) and the client keeps using its id.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server as HttpServer } from 'node:http';
import type { Express } from 'express';
import http from 'node:http';
import { buildHttpApp, SessionStore } from '../../src/transport/streamableHttp.js';

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

// Responses arrive as a single SSE frame (`event: message\ndata: {...}`) when
// the transport answers, or as plain JSON from the guard branches.
function parseJsonRpc(raw: string): {
  result?: { tools?: Array<{ name: string }> };
  error?: { code?: number; message?: string };
} {
  const dataLine = raw.split(/\r?\n/).find((line) => line.startsWith('data:'));
  const payload = dataLine ? dataLine.slice('data:'.length).trim() : raw.trim();
  return JSON.parse(payload);
}

const ACCEPT = 'application/json, text/event-stream';
const AUTH = 'Bearer lune_fake_orphan_token';

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

async function listen(app: Express): Promise<{ server: HttpServer; port: number }> {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  return { server, port: (server.address() as AddressInfo).port };
}

let app: Express;
let server: HttpServer;
let port: number;

beforeAll(async () => {
  app = buildHttpApp();
  ({ server, port } = await listen(app));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('orphaned session id: POST is served statelessly', () => {
  it('serves tools/list on a never-seen session id and is repeatable', async () => {
    const sid = 'orphan-never-initialized';
    for (const id of [1, 2]) {
      const res = await rawRequest(
        port,
        'POST',
        '/mcp',
        { accept: ACCEPT, authorization: AUTH, 'mcp-session-id': sid },
        toolsListBody(id),
      );
      expect(res.status).toBe(200);
      const tools = parseJsonRpc(res.body).result?.tools ?? [];
      expect(tools.length).toBeGreaterThan(0);
      // Stateless handling mints nothing: the client keeps its own id.
      expect(res.headers['mcp-session-id']).toBeUndefined();
    }
  });

  it('keeps a conversation working after its session is idle-evicted (the prod regression)', async () => {
    const init = await rawRequest(
      port,
      'POST',
      '/mcp',
      { accept: ACCEPT, authorization: AUTH },
      initBody(),
    );
    expect(init.status).toBe(200);
    const sid = init.headers['mcp-session-id'] as string;
    expect(sid).toBeTruthy();

    // A ttl=0 sweep "from one ms in the future" evicts every live session:
    // exactly what the 30-min idle TTL does between a turn and a
    // >30-min-later follow-up. (The +1 keeps the strict `now - lastSeen > 0`
    // eviction comparison deterministic when the initialize above landed in
    // the same millisecond as the sweep.)
    const store = app.locals.sessionStore as SessionStore;
    expect(store.sweep(0, Date.now() + 1)).toBeGreaterThan(0);

    const followUp = await rawRequest(
      port,
      'POST',
      '/mcp',
      { accept: ACCEPT, authorization: AUTH, 'mcp-session-id': sid },
      toolsListBody(2),
    );
    expect(followUp.status).toBe(200);
    expect((parseJsonRpc(followUp.body).result?.tools ?? []).length).toBeGreaterThan(0);
  });

  it('keeps a conversation working across a process restart (fresh app, old id)', async () => {
    const init = await rawRequest(
      port,
      'POST',
      '/mcp',
      { accept: ACCEPT, authorization: AUTH },
      initBody(),
    );
    const sid = init.headers['mcp-session-id'] as string;

    const fresh = await listen(buildHttpApp());
    try {
      const res = await rawRequest(
        fresh.port,
        'POST',
        '/mcp',
        { accept: ACCEPT, authorization: AUTH, 'mcp-session-id': sid },
        toolsListBody(3),
      );
      expect(res.status).toBe(200);
      expect((parseJsonRpc(res.body).result?.tools ?? []).length).toBeGreaterThan(0);
    } finally {
      await new Promise<void>((resolve) => fresh.server.close(() => resolve()));
    }
  });

  it('round-trips an orphaned tools/call through the per-request client (the incident shape)', async () => {
    // The prod failure was tools/call, not tools/list. Point the upstream at a
    // guaranteed-closed local port: the tool's fetch fails fast (connection
    // refused), but only after the request has flowed through the ephemeral
    // server and the per-request `makeClient(token)` factory.
    const savedBaseUrl = process.env.LUNE_API_BASE_URL;
    process.env.LUNE_API_BASE_URL = 'http://127.0.0.1:1';
    try {
      const res = await rawRequest(
        port,
        'POST',
        '/mcp',
        { accept: ACCEPT, authorization: AUTH, 'mcp-session-id': 'orphan-tools-call' },
        {
          jsonrpc: '2.0',
          id: 9,
          method: 'tools/call',
          params: { name: 'search_papers', arguments: { query: 'orphaned follow-up' } },
        },
      );
      expect(res.status).toBe(200);
      const body = parseJsonRpc(res.body) as { result?: unknown; error?: unknown };
      // Either an error-flagged tool result or a JSON-RPC error is fine; the
      // point is the call was served instead of 404'd.
      expect(body.result ?? body.error).toBeDefined();
    } finally {
      if (savedBaseUrl === undefined) delete process.env.LUNE_API_BASE_URL;
      else process.env.LUNE_API_BASE_URL = savedBaseUrl;
    }
  });

  it('accepts a notification on an orphaned session id (202)', async () => {
    const res = await rawRequest(
      port,
      'POST',
      '/mcp',
      { accept: ACCEPT, authorization: AUTH, 'mcp-session-id': 'orphan-notification' },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
    );
    expect(res.status).toBe(202);
  });

  it('still requires auth on the orphaned path (401 + WWW-Authenticate)', async () => {
    const res = await rawRequest(
      port,
      'POST',
      '/mcp',
      { accept: ACCEPT, 'mcp-session-id': 'orphan-no-auth' },
      toolsListBody(4),
    );
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toMatch(/^Bearer\s/);
  });
});

describe('orphaned session id: recovery edges', () => {
  it('initialize with a stale session id mints a fresh session instead of 404', async () => {
    const res = await rawRequest(
      port,
      'POST',
      '/mcp',
      { accept: ACCEPT, authorization: AUTH, 'mcp-session-id': 'stale-from-before-restart' },
      initBody(),
    );
    expect(res.status).toBe(200);
    const minted = res.headers['mcp-session-id'];
    expect(typeof minted).toBe('string');
    expect(minted).not.toBe('stale-from-before-restart');
  });

  it('GET with an unknown session id declines the stream with 405, not session death', async () => {
    // 405 = "no standalone SSE stream offered" (spec-legal at any time); 404
    // would tell the client its session was terminated, which is exactly the
    // signal the managed-agents client cannot recover from.
    const res = await rawRequest(port, 'GET', '/mcp', {
      accept: 'text/event-stream',
      authorization: AUTH,
      'mcp-session-id': 'orphan-get-stream',
    });
    expect(res.status).toBe(405);
  });

  it('a POST with NO session id that is not initialize still 400s (orphan path needs a present id)', async () => {
    const res = await rawRequest(
      port,
      'POST',
      '/mcp',
      { accept: ACCEPT, authorization: AUTH },
      toolsListBody(5),
    );
    expect(res.status).toBe(400);
    expect(parseJsonRpc(res.body).error?.code).toBe(-32000);
  });
});
