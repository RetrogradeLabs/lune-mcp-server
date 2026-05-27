import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startHttpServer } from '../../src/transport/streamableHttp.js';
import type { Server as HttpServer } from 'node:http';

describe('HTTP transport', () => {
  let server: HttpServer;
  let port: number;

  beforeAll(async () => {
    server = startHttpServer(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no port assigned');
    port = addr.port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('/health returns 200', async () => {
    const r = await fetch(`http://localhost:${port}/health`);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toMatchObject({ status: 'ok', server: 'lune-mcp' });
  });

  it('rejects POST /mcp without Authorization', async () => {
    const r = await fetch(`http://localhost:${port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {},
      }),
    });
    expect(r.status).toBe(401);
    // The remote-MCP connector keys off this header to start OAuth discovery.
    // Without it Claude Desktop reports "Couldn't reach the MCP server" even
    // though the transport itself is healthy.
    const wa = r.headers.get('www-authenticate');
    expect(wa).toMatch(/^Bearer\s/);
    expect(wa).toContain('resource_metadata="');
    expect(wa).toContain('/.well-known/oauth-protected-resource"');
    const body = (await r.json()) as {
      id: number;
      error: { code: number; data: { _meta: { 'mcp/www_authenticate': string } } };
    };
    expect(body.id).toBe(1);
    expect(body.error.code).toBe(-32001);
    expect(body.error.data._meta['mcp/www_authenticate']).toBe(wa);
  });

  it('exposes RFC 9728 protected-resource metadata', async () => {
    const r = await fetch(`http://localhost:${port}/.well-known/oauth-protected-resource`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      resource: string;
      authorization_servers: string[];
      scopes_supported: string[];
      bearer_methods_supported: string[];
    };
    expect(body.resource).toBe('https://mcp.luneresearch.com/mcp');
    expect(body.authorization_servers.length).toBeGreaterThan(0);
    expect(body.authorization_servers[0]).toMatch(/^https?:\/\//);
    expect(body.scopes_supported).toContain('papers:read');
    expect(body.bearer_methods_supported).toContain('header');
  });

  it('exposes path-specific protected-resource metadata for /mcp', async () => {
    const r = await fetch(`http://localhost:${port}/.well-known/oauth-protected-resource/mcp`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      resource: string;
      authorization_servers: string[];
      scopes_supported: string[];
    };
    expect(body.resource).toBe('https://mcp.luneresearch.com/mcp');
    expect(body.authorization_servers).toContain('https://api.luneresearch.com');
    expect(body.scopes_supported).toContain('papers:read');
  });

  it('exposes canonical resource metadata for the /v1/mcp alias', async () => {
    const r = await fetch(`http://localhost:${port}/.well-known/oauth-protected-resource/v1/mcp`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      resource: string;
      authorization_servers: string[];
    };
    expect(body.resource).toBe('https://mcp.luneresearch.com/mcp');
    expect(body.authorization_servers).toContain('https://api.luneresearch.com');
  });

  it('rejects POST /mcp with non-Bearer scheme', async () => {
    const r = await fetch(`http://localhost:${port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'Basic xx',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    expect(r.status).toBe(401);
  });

  it('rejects request with stale session ID and non-initialize method', async () => {
    const r = await fetch(`http://localhost:${port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer fake_token',
        'mcp-session-id': 'definitely-not-a-real-session',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(r.status).toBe(400);
  });

  it('rejects a POST /mcp with no session ID and a non-initialize method', async () => {
    // No `mcp-session-id` header and the body is `tools/list`, not
    // `initialize` — the transport refuses to mint a session.
    const r = await fetch(`http://localhost:${port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer fake_token',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list', params: {} }),
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: { code: number; message: string } };
    expect(body.error.code).toBe(-32000);
    expect(body.error.message).toMatch(/no valid session/i);
  });

  it('serves the OpenAI Apps domain-ownership challenge as plain text', async () => {
    const r = await fetch(`http://localhost:${port}/.well-known/openai-apps-challenge`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/text\/plain/);
    const token = await r.text();
    expect(token.length).toBeGreaterThan(10);
  });

  it('redirects favicon probes to the marketing asset', async () => {
    for (const path of ['/favicon.ico', '/favicon.svg', '/apple-touch-icon.png']) {
      const r = await fetch(`http://localhost:${port}${path}`, { redirect: 'manual' });
      expect(r.status).toBe(302);
      expect(r.headers.get('location')).toBe('https://luneresearch.com/favicon.svg');
    }
  });

  it('echoes CORS headers for an allowed browser origin', async () => {
    const r = await fetch(`http://localhost:${port}/health`, {
      headers: { origin: 'https://claude.ai' },
    });
    expect(r.status).toBe(200);
    expect(r.headers.get('access-control-allow-origin')).toBe('https://claude.ai');
    expect(r.headers.get('access-control-allow-credentials')).toBe('true');
    expect(r.headers.get('vary')).toBe('Origin');
  });

  it('omits CORS headers for a non-allowlisted origin', async () => {
    const r = await fetch(`http://localhost:${port}/health`, {
      headers: { origin: 'https://evil.example.com' },
    });
    expect(r.status).toBe(200);
    expect(r.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('short-circuits an OPTIONS preflight with 204', async () => {
    const r = await fetch(`http://localhost:${port}/mcp`, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://chatgpt.com',
        'access-control-request-method': 'POST',
      },
    });
    expect(r.status).toBe(204);
    expect(r.headers.get('access-control-allow-methods')).toContain('POST');
  });

  it('handles an initialize → tools/list → DELETE session lifecycle', async () => {
    // Parse the SSE-framed JSON-RPC body the Streamable HTTP transport emits.
    const parseSse = (raw: string): Record<string, unknown> => {
      const dataLine = raw
        .split('\n')
        .find((l) => l.startsWith('data:'));
      if (!dataLine) throw new Error(`no SSE data frame in: ${raw}`);
      return JSON.parse(dataLine.slice(5).trim()) as Record<string, unknown>;
    };

    // 1. initialize: mints a new session, returns the id in a response header.
    const initRes = await fetch(`http://localhost:${port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer lune_fake_session_token',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'vitest', version: '0.0.0' },
        },
      }),
    });
    expect(initRes.status).toBe(200);
    const sessionId = initRes.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();
    const initBody = parseSse(await initRes.text()) as {
      result: { serverInfo: { name: string } };
    };
    expect(initBody.result.serverInfo.name).toBe('lune-research');

    // 2. tools/list on the established session: no API call, fully local.
    const listRes = await fetch(`http://localhost:${port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer lune_fake_session_token',
        'mcp-session-id': sessionId!,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    });
    expect(listRes.status).toBe(200);
    const listBody = parseSse(await listRes.text()) as {
      result: { tools: Array<{ name: string }> };
    };
    expect(listBody.result.tools.length).toBe(12);

    // 3. GET /mcp opens the standalone SSE stream for the live session.
    const streamRes = await fetch(`http://localhost:${port}/mcp`, {
      method: 'GET',
      headers: {
        accept: 'text/event-stream',
        authorization: 'Bearer lune_fake_session_token',
        'mcp-session-id': sessionId!,
      },
    });
    expect(streamRes.status).toBe(200);
    // Cancel the long-lived stream so the test can proceed.
    await streamRes.body?.cancel();

    // 4. DELETE /mcp tears the session down.
    const delRes = await fetch(`http://localhost:${port}/mcp`, {
      method: 'DELETE',
      headers: {
        authorization: 'Bearer lune_fake_session_token',
        'mcp-session-id': sessionId!,
      },
    });
    expect([200, 204]).toContain(delRes.status);

    // 5. Re-using the now-deleted session id is rejected.
    const afterDelete = await fetch(`http://localhost:${port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer lune_fake_session_token',
        'mcp-session-id': sessionId!,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }),
    });
    expect(afterDelete.status).toBe(400);
  });

  it('GET /mcp without a session id returns 400', async () => {
    const r = await fetch(`http://localhost:${port}/mcp`, {
      method: 'GET',
      headers: { accept: 'text/event-stream' },
    });
    expect(r.status).toBe(400);
    expect(await r.text()).toMatch(/invalid or missing session/i);
  });

  it('DELETE /mcp for an unknown session is a 204 no-op', async () => {
    const r = await fetch(`http://localhost:${port}/mcp`, {
      method: 'DELETE',
      headers: { 'mcp-session-id': 'never-existed' },
    });
    expect(r.status).toBe(204);
  });

  it('DELETE /mcp with no session id header is a 204 no-op', async () => {
    // Exercises the `sid ? ... : undefined` branch with no header at all.
    const r = await fetch(`http://localhost:${port}/mcp`, { method: 'DELETE' });
    expect(r.status).toBe(204);
  });

  it('the 401 body id defaults to null when the request body carries no id', async () => {
    const r = await fetch(`http://localhost:${port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      // No `id` field → `req.body?.id ?? null` falls to null.
      body: JSON.stringify({ jsonrpc: '2.0', method: 'initialize', params: {} }),
    });
    expect(r.status).toBe(401);
    const body = (await r.json()) as { id: number | null };
    expect(body.id).toBeNull();
  });

  it('the 401 body id is null when there is no JSON body at all', async () => {
    const r = await fetch(`http://localhost:${port}/mcp`, {
      method: 'POST',
      headers: { accept: 'application/json, text/event-stream' },
    });
    expect(r.status).toBe(401);
    const body = (await r.json()) as { id: number | null };
    expect(body.id).toBeNull();
  });

  it('dispatches a real tools/call through the per-request client factory', async () => {
    // A genuine `tools/call` over HTTP exercises the `makeClient` closure
    // and the live-token getter on the session entry. `getBaseUrl()` is
    // read per request, so we point it at a guaranteed-closed local port:
    // the tool's upstream fetch fails fast (connection refused, no real
    // network), but the token-rotation closures have already executed.
    const savedBaseUrl = process.env.LUNE_API_BASE_URL;
    process.env.LUNE_API_BASE_URL = 'http://127.0.0.1:1';
    const parseSse = (raw: string): Record<string, unknown> => {
      const dataLine = raw.split('\n').find((l) => l.startsWith('data:'));
      if (!dataLine) throw new Error(`no SSE data frame in: ${raw}`);
      return JSON.parse(dataLine.slice(5).trim()) as Record<string, unknown>;
    };

    try {
      const initRes = await fetch(`http://localhost:${port}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: 'Bearer lune_toolcall_token',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'vitest', version: '0.0.0' },
          },
        }),
      });
      const sessionId = initRes.headers.get('mcp-session-id')!;

      const callRes = await fetch(`http://localhost:${port}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: 'Bearer lune_toolcall_token',
          'mcp-session-id': sessionId,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'get_paper', arguments: { paper_id: 'p-nonexistent' } },
        }),
      });
      expect(callRes.status).toBe(200);
      const body = parseSse(await callRes.text()) as {
        id: number;
        result?: unknown;
        error?: { message: string };
      };
      expect(body.id).toBe(2);
      // Either an MCP error or an error-flagged result is fine; the point
      // is the request round-tripped through the token-rotation closures.
      expect(body.result ?? body.error).toBeDefined();

      // Clean up the session.
      await fetch(`http://localhost:${port}/mcp`, {
        method: 'DELETE',
        headers: {
          authorization: 'Bearer lune_toolcall_token',
          'mcp-session-id': sessionId,
        },
      });
    } finally {
      if (savedBaseUrl === undefined) delete process.env.LUNE_API_BASE_URL;
      else process.env.LUNE_API_BASE_URL = savedBaseUrl;
    }
  });
});
