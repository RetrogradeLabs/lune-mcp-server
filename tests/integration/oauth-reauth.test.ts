/**
 * Auto-reauth wiring: an expired Lune OAuth access token on POST /mcp must get a
 * transport-level 401 + `WWW-Authenticate: Bearer error="invalid_token", ...`,
 * which is what makes the MCP client (Claude Desktop, Cursor, ...) silently
 * refresh its access token and retry. Before this gate the expired token was
 * forwarded to the API, whose 401 came back as a tool-execution error the model
 * surfaced as "your authorization expired, please reconnect" (see
 * .claude/rules/mcp.md and src/auth/verify.ts).
 *
 * Drives the real `buildHttpApp()` against a local JWKS server that stands in for
 * api.luneresearch.com's `/.well-known/jwks.json`. `src/auth/verify.ts` reads
 * `LUNE_AUTH_SERVER_URL` lazily (per request), so pointing it at the local server
 * in beforeAll is enough even though streamableHttp's own metadata constants were
 * frozen to the deployed defaults at import (hence resource_metadata still points
 * at mcp.luneresearch.com, which we assert).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server as HttpServer } from 'node:http';
import http from 'node:http';
import { SignJWT, exportJWK, generateKeyPair, type KeyLike } from 'jose';
import { buildHttpApp } from '../../src/transport/streamableHttp.js';

const KID = 'reauth-test-1';
const METADATA_URL = 'https://mcp.luneresearch.com/.well-known/oauth-protected-resource';

function initBody(id: number) {
  return {
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'reauth-test', version: '1.0.0' },
    },
  };
}

async function post(port: number, headers: Record<string, string>, body: unknown) {
  return fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(body),
  });
}

describe('oauth auto-reauth (expired access token -> 401 -> silent refresh)', () => {
  let app: HttpServer;
  let jwks: HttpServer;
  let port: number;
  let privateKey: KeyLike;
  let issuer: string;
  const prevEnv = process.env.LUNE_AUTH_SERVER_URL;

  beforeAll(async () => {
    const keys = await generateKeyPair('RS256');
    privateKey = keys.privateKey;
    const jwk = { ...(await exportJWK(keys.publicKey)), kid: KID, alg: 'RS256', use: 'sig' };

    // Local JWKS endpoint standing in for api.luneresearch.com. `Connection: close`
    // keeps undici from pooling the socket so the server closes cleanly in teardown.
    jwks = http.createServer((req, res) => {
      if (req.url?.startsWith('/.well-known/jwks.json')) {
        res.setHeader('content-type', 'application/json');
        res.setHeader('Connection', 'close');
        res.end(JSON.stringify({ keys: [jwk] }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    jwks.listen(0);
    await new Promise<void>((resolve) => jwks.once('listening', resolve));
    issuer = `http://127.0.0.1:${(jwks.address() as AddressInfo).port}`;
    process.env.LUNE_AUTH_SERVER_URL = issuer;

    app = buildHttpApp().listen(0);
    await new Promise<void>((resolve) => app.once('listening', resolve));
    port = (app.address() as AddressInfo).port;
  });

  afterAll(async () => {
    if (prevEnv === undefined) delete process.env.LUNE_AUTH_SERVER_URL;
    else process.env.LUNE_AUTH_SERVER_URL = prevEnv;
    jwks.closeAllConnections?.();
    await new Promise<void>((resolve) => app.close(() => resolve()));
    await new Promise<void>((resolve) => jwks.close(() => resolve()));
  });

  function mint(expSecondsFromNow: number) {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ org_id: 'org-1', scopes: ['papers:read'] })
      .setProtectedHeader({ alg: 'RS256', kid: KID })
      .setIssuer(issuer)
      .setSubject('user-1')
      .setIssuedAt(now - 120)
      .setExpirationTime(now + expSecondsFromNow)
      .sign(privateKey);
  }

  it('returns 401 with an invalid_token challenge for an EXPIRED access token', async () => {
    const expired = await mint(-3600);
    const r = await post(port, { authorization: `Bearer ${expired}` }, initBody(1));

    expect(r.status).toBe(401);

    // The MCP client refreshes-then-retries off this exact header shape: an
    // explicit `error="invalid_token"` (RFC 6750 §3.1) plus the resource_metadata
    // pointer (RFC 9728). Without the error code a client may treat it as a fresh
    // consent rather than a refresh.
    const wa = r.headers.get('www-authenticate')!;
    expect(wa).toContain('error="invalid_token"');
    expect(wa).toContain(`resource_metadata="${METADATA_URL}"`);

    const body = (await r.json()) as {
      id: number;
      error: { code: number; data: { _meta: { 'mcp/www_authenticate': string } } };
    };
    expect(body.id).toBe(1);
    expect(body.error.code).toBe(-32001);
    // Header and body-echoed challenge are the identical string.
    expect(body.error.data._meta['mcp/www_authenticate']).toBe(wa);
  });

  it('lets a VALID access token through the gate (reaches the transport, mints a session)', async () => {
    const valid = await mint(3600);
    const r = await post(port, { authorization: `Bearer ${valid}` }, initBody(2));

    expect(r.status).toBe(200);
    // A real initialize handshake assigns a session id; proves we passed the gate
    // and executed, not just skipped the 401.
    expect(r.headers.get('mcp-session-id')).toBeTruthy();
  });

  it('lets an opaque PAT through the gate (validated downstream, not here)', async () => {
    const r = await post(port, { authorization: 'Bearer lune_pat_fake123' }, initBody(3));
    // PATs are not JWTs: the gate must not 401 them. (Their validity is the API's
    // call; an initialize needs no upstream call, so this succeeds locally.)
    expect(r.status).not.toBe(401);
  });

  it('still answers a NO-token request with the bare discovery challenge (no regression)', async () => {
    const r = await post(port, {}, initBody(4));
    expect(r.status).toBe(401);
    const wa = r.headers.get('www-authenticate')!;
    // Anonymous discovery: bare challenge, NO error code (RFC 6750 §3).
    expect(wa).toBe(`Bearer resource_metadata="${METADATA_URL}"`);
    expect(wa).not.toContain('error=');
  });
});
