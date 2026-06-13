/**
 * OAuth discovery (RFC 9728) over the Streamable-HTTP transport.
 *
 * Claude Desktop's remote-MCP connector hits POST /mcp anonymously, expects a
 * `401 + WWW-Authenticate: Bearer resource_metadata="..."`, then fetches that
 * absolute URL to discover the authorization server. Both pieces are required
 * (see .claude/rules/mcp.md "Remote-MCP OAuth discovery"); missing either
 * surfaces to the user as a generic "Couldn't reach the MCP server".
 *
 * These tests drive the same `buildHttpApp()` + `app.listen(0)` + `fetch`
 * harness as http-app.test.ts. The metadata constants in streamableHttp.ts are
 * resolved at module import time, so we assert the deployed defaults
 * (mcp.luneresearch.com / api.luneresearch.com) rather than mutating env after
 * import (which would be a no-op).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server as HttpServer } from 'node:http';
import { buildHttpApp } from '../../src/transport/streamableHttp.js';

type Json = Record<string, unknown>;

// Deployed defaults (code defaults in streamableHttp.ts; wired in infra/mcp.ts).
const RESOURCE = 'https://mcp.luneresearch.com/mcp';
const RESOURCE_ORIGIN = 'https://mcp.luneresearch.com';
const AUTH_SERVER = 'https://api.luneresearch.com';
const METADATA_URL = `${RESOURCE_ORIGIN}/.well-known/oauth-protected-resource`;

describe('oauth discovery', () => {
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

  it('serves RFC 9728 protected-resource metadata with concrete values', async () => {
    const r = await fetch(`http://127.0.0.1:${port}/.well-known/oauth-protected-resource`);

    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('application/json');

    const body = (await r.json()) as Json;

    // `resource` MUST be the absolute MCP endpoint URL the token is bound to.
    expect(body.resource).toBe(RESOURCE);
    expect(() => new URL(body.resource as string)).not.toThrow();

    // `authorization_servers` MUST be a non-empty array of absolute AS URLs.
    expect(Array.isArray(body.authorization_servers)).toBe(true);
    const authServers = body.authorization_servers as string[];
    expect(authServers.length).toBeGreaterThan(0);
    expect(authServers).toEqual([AUTH_SERVER]);
    expect(authServers[0]!).toMatch(/^https:\/\//);

    // `scopes_supported` MUST advertise the read scopes (papers:read at least).
    const scopes = body.scopes_supported as string[];
    expect(Array.isArray(scopes)).toBe(true);
    expect(scopes).toContain('papers:read');
    expect(scopes).toContain('guidance:read');

    // Bearer token delivery is header-only (no query/body token methods).
    expect(body.bearer_methods_supported).toEqual(['header']);
  });

  it('serves identical metadata at the /mcp and /v1/mcp suffixed well-known paths', async () => {
    // Sequential (not Promise.all): concurrent fetches against express on an
    // ephemeral port intermittently ECONNRESET under load in CI.
    const paths = [
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-protected-resource/mcp',
      '/.well-known/oauth-protected-resource/v1/mcp',
    ];
    const bodies: Json[] = [];
    for (const path of paths) {
      const r = await fetch(`http://127.0.0.1:${port}${path}`);
      expect(r.status).toBe(200);
      bodies.push((await r.json()) as Json);
    }

    const [root, mcp, v1] = bodies;
    expect(root!.resource).toBe(RESOURCE);
    // The suffixed alias paths MUST serve the exact same document as the root.
    expect(mcp).toEqual(root);
    expect(v1).toEqual(root);
  });

  it('rejects anonymous POST /mcp with a 401 carrying the resource_metadata pointer', async () => {
    const r = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });

    expect(r.status).toBe(401);

    // The connector keys off this exact header to start OAuth discovery; the
    // resource_metadata value MUST be the absolute well-known URL.
    const wwwAuth = r.headers.get('www-authenticate');
    expect(wwwAuth).toBe(`Bearer resource_metadata="${METADATA_URL}"`);

    // The JSON-RPC error body MUST echo that same header so a client that only
    // parses the body (not headers) can still discover the AS.
    const body = (await r.json()) as Json;
    expect(body.jsonrpc).toBe('2.0');
    // `id` echoes the request id (here 1), per the 401 handler.
    expect(body.id).toBe(1);
    const error = body.error as Json;
    expect(error.code).toBe(-32001);
    const data = error.data as Json;
    const meta = data._meta as Json;
    const echoed = meta['mcp/www_authenticate'];

    // The header and the body-echoed value MUST be the identical string (same
    // value served in two places). Assert byte-for-byte equality directly, not
    // just that each independently matches the expected literal: a regression
    // that desynced the two (e.g. recomputing the URL differently) would slip
    // past per-side literal checks but is caught here.
    expect(typeof echoed).toBe('string');
    expect(echoed).toBe(wwwAuth);
    expect(echoed).toStrictEqual(wwwAuth);
    expect((echoed as string).length).toBe((wwwAuth as string).length);
    // And the shared value carries the absolute metadata URL.
    expect(echoed).toContain(`resource_metadata="${METADATA_URL}"`);
  });

  it('rejects anonymous POST /v1/mcp the same way as /mcp (alias shares the handler)', async () => {
    const r = await fetch(`http://127.0.0.1:${port}/v1/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list', params: {} }),
    });

    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toBe(
      `Bearer resource_metadata="${METADATA_URL}"`,
    );
    const body = (await r.json()) as Json;
    expect(body.id).toBe(7);
  });
});
