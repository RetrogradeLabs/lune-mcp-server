/**
 * Coverage for `buildHttpApp` (used standalone in tests) and
 * `startHttpServer`'s bind callback, plus the `/v1/mcp` alias path and the
 * array-valued `mcp-session-id` header branch.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server as HttpServer } from 'node:http';
import http from 'node:http';
import {
  buildHttpApp,
  startHttpServer,
  SessionStore,
  hostIsAllowed,
  originIsAllowed,
} from '../../src/transport/streamableHttp.js';

// Raw HTTP POST so the test can set Host/Origin, which the WHATWG `fetch`
// implementation forbids as request headers.
function rawPost(
  port: number,
  path: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<{ status: number | undefined; body: string }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(data),
          ...headers,
        },
      },
      (res) => {
        let chunks = '';
        res.on('data', (c) => (chunks += c));
        res.on('end', () => resolve({ status: res.statusCode, body: chunks }));
      },
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

describe('buildHttpApp standalone', () => {
  let server: HttpServer;
  let port: number;

  beforeAll(async () => {
    // buildHttpApp returns an un-bound express app; bind it ourselves.
    const app = buildHttpApp();
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('serves /health from an app built without a port binding', async () => {
    const r = await fetch(`http://localhost:${port}/health`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { status: string };
    expect(body.status).toBe('ok');
  });

  it('serves protected-resource metadata for the /v1/mcp alias path', async () => {
    const r = await fetch(
      `http://localhost:${port}/.well-known/oauth-protected-resource/v1/mcp`,
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as { resource: string };
    expect(body.resource).toBe('https://mcp.luneresearch.com/mcp');
  });

  it('rejects POST /v1/mcp without Authorization (alias shares the handler)', async () => {
    const r = await fetch(`http://localhost:${port}/v1/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toMatch(/^Bearer\s/);
  });

  it('GET /v1/mcp without a session id returns 400', async () => {
    const r = await fetch(`http://localhost:${port}/v1/mcp`, {
      method: 'GET',
      headers: { accept: 'text/event-stream' },
    });
    expect(r.status).toBe(400);
  });

  it('tolerates a repeated mcp-session-id header', async () => {
    // Node collapses duplicated inbound headers into a single comma-joined
    // string (only `set-cookie` is ever arrayed), so `readSessionId` sees
    // "first-id, second-id" as one present-but-unknown id, which is served
    // statelessly like any other orphaned session id.
    const r = await fetch(`http://localhost:${port}/mcp`, {
      method: 'POST',
      headers: [
        ['content-type', 'application/json'],
        ['accept', 'application/json, text/event-stream'],
        ['authorization', 'Bearer fake'],
        ['mcp-session-id', 'first-id'],
        ['mcp-session-id', 'second-id'],
      ],
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(r.status).toBe(200);
  });

  it('serves an orphaned session id on POST and declines its GET stream with 405', async () => {
    // A server-evicted / expired session id is "present but unknown". POSTs
    // are served through an ephemeral stateless transport (a 404 would tell
    // the Anthropic managed-agents client its session died, and it never
    // re-initializes; see orphaned-session.test.ts); the optional standalone
    // GET stream is declined with 405, which is spec-legal at any time and
    // does NOT signal session termination.
    const post = await rawPost(
      port,
      '/mcp',
      { 'accept': 'application/json, text/event-stream', authorization: 'Bearer fake', 'mcp-session-id': 'gone-123' },
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
    );
    expect(post.status).toBe(200);

    const get = await fetch(`http://localhost:${port}/mcp`, {
      method: 'GET',
      headers: { accept: 'text/event-stream', 'mcp-session-id': 'gone-123' },
    });
    expect(get.status).toBe(405);
  });

  it('rejects POST /mcp from a disallowed Origin with 403 (before any tool runs)', async () => {
    const r = await rawPost(
      port,
      '/mcp',
      { authorization: 'Bearer fake', origin: 'https://evil.example.com' },
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
    );
    expect(r.status).toBe(403);
    expect(r.body).toMatch(/origin not allowed/);
  });

  it('rejects POST /mcp with a spoofed/rebound Host with 403', async () => {
    const r = await rawPost(
      port,
      '/mcp',
      { host: 'attacker.example.com', authorization: 'Bearer fake' },
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
    );
    expect(r.status).toBe(403);
    expect(r.body).toMatch(/host not allowed/);
  });

  it('admits an allowlisted Origin through the guard (then 401 on auth)', async () => {
    // claude.ai is allowlisted, so the guard passes and the request reaches the
    // handler, which rejects the fake token. Proves the guard does not block
    // legitimate browser clients.
    const r = await rawPost(
      port,
      '/mcp',
      { origin: 'https://claude.ai', accept: 'application/json, text/event-stream' },
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    );
    expect(r.status).toBe(401);
  });
});

describe('startHttpServer', () => {
  it('binds to an OS-assigned port and logs the bound port', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const server = startHttpServer(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    // The listen callback runs synchronously after `listening`; give it a tick.
    await new Promise((r) => setTimeout(r, 0));
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringMatching(/Lune MCP HTTP listening on :\d+/),
    );
    await new Promise<void>((resolve) => server.close(() => resolve()));
    logSpy.mockRestore();
  });
});

describe('SessionStore idle eviction', () => {
  function fakeEntry(lastSeen: number) {
    const close = vi.fn().mockResolvedValue(undefined);
    return {
      entry: { transport: { close } as never, token: 't', lastSeen },
      close,
    };
  }

  it('closes and drops sessions idle past the TTL, keeps fresh ones', () => {
    const store = new SessionStore();
    const now = 1_000_000;
    const stale = fakeEntry(now - 10_000);
    const fresh = fakeEntry(now - 100);
    store.register('stale', stale.entry);
    store.register('fresh', fresh.entry);

    const evicted = store.sweep(5_000, now);

    expect(evicted).toBe(1);
    expect(stale.close).toHaveBeenCalledOnce();
    expect(fresh.close).not.toHaveBeenCalled();
    expect(store.size).toBe(1);
    expect(store.get('fresh')).toBeDefined();
  });

  it('get() touches lastSeen so an active session survives the next sweep', () => {
    const store = new SessionStore();
    const now = 2_000_000;
    store.register('s', fakeEntry(now - 10_000).entry);
    // A request on the session refreshes lastSeen to "real" now (>> the test's
    // synthetic `now`), so it is no longer stale relative to `now`.
    store.get('s');
    expect(store.sweep(5_000, now)).toBe(0);
    expect(store.size).toBe(1);
  });

  it('caps live sessions, evicting the least-recently-used at the limit', () => {
    // Idle eviction alone can't stop a burst (sessions are only sweep-eligible
    // after the TTL), so register enforces a hard cap: at the limit it closes
    // and drops the oldest-by-lastSeen entry before admitting the new one,
    // bounding memory regardless of the init rate.
    const store = new SessionStore(2);
    const a = fakeEntry(1_000); // oldest
    const b = fakeEntry(2_000);
    const c = fakeEntry(3_000); // newest
    store.register('a', a.entry);
    store.register('b', b.entry);
    expect(store.size).toBe(2);

    store.register('c', c.entry); // over the cap -> evict LRU ('a')
    expect(store.size).toBe(2);
    expect(a.close).toHaveBeenCalledOnce();
    expect(store.get('a')).toBeUndefined();
    expect(store.get('b')).toBeDefined();
    expect(store.get('c')).toBeDefined();
  });
});

describe('host/origin allowlist', () => {
  it('allows the configured host and loopback, rejects others', () => {
    expect(hostIsAllowed('mcp.luneresearch.com')).toBe(true);
    expect(hostIsAllowed('localhost:8787')).toBe(true);
    expect(hostIsAllowed('127.0.0.1:3000')).toBe(true);
    expect(hostIsAllowed('attacker.example.com')).toBe(false);
    expect(hostIsAllowed(undefined)).toBe(false);
  });

  it('allows absent and allowlisted origins, rejects others', () => {
    expect(originIsAllowed(undefined)).toBe(true);
    expect(originIsAllowed('https://claude.ai')).toBe(true);
    expect(originIsAllowed('https://evil.example.com')).toBe(false);
    expect(originIsAllowed(['https://claude.ai', 'x'])).toBe(false);
  });
});
