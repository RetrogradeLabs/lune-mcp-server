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
});
