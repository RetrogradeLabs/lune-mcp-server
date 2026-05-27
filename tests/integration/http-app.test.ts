/**
 * Coverage for `buildHttpApp` (used standalone in tests) and
 * `startHttpServer`'s bind callback, plus the `/v1/mcp` alias path and the
 * array-valued `mcp-session-id` header branch.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server as HttpServer } from 'node:http';
import { buildHttpApp, startHttpServer } from '../../src/transport/streamableHttp.js';

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
    // "first-id, second-id" as one unknown id and the request 400s.
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
    expect(r.status).toBe(400);
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
