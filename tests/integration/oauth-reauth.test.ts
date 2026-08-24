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
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server as HttpServer } from "node:http";
import http from "node:http";
import { SignJWT, exportJWK, generateKeyPair, type CryptoKey } from "jose";
import { buildHttpApp } from "../../src/transport/streamableHttp.js";
import { inspectAccessToken } from "../../src/auth/verify.js";

const KID = "reauth-test-1";
// These requests hit the legacy `/mcp` alias, and the challenge is path-aware
// (RFC 9728 §3.3), so it points at that alias's metadata document.
const METADATA_URL =
  "https://mcp.luneresearch.com/.well-known/oauth-protected-resource/mcp";

function initBody(id: number) {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "reauth-test", version: "1.0.0" },
    },
  };
}

async function post(
  port: number,
  headers: Record<string, string>,
  body: unknown,
  path = "/mcp",
) {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe("oauth auto-reauth (expired access token -> 401 -> silent refresh)", () => {
  let app: HttpServer;
  let jwks: HttpServer;
  let port: number;
  let privateKey: CryptoKey;
  let issuer: string;
  const prevEnv = process.env.LUNE_AUTH_SERVER_URL;

  beforeAll(async () => {
    const keys = await generateKeyPair("RS256");
    privateKey = keys.privateKey;
    const jwk = {
      ...(await exportJWK(keys.publicKey)),
      kid: KID,
      alg: "RS256",
      use: "sig",
    };

    // Local JWKS endpoint standing in for api.luneresearch.com. `Connection: close`
    // keeps undici from pooling the socket so the server closes cleanly in teardown.
    jwks = http.createServer((req, res) => {
      if (req.url?.startsWith("/.well-known/jwks.json")) {
        res.setHeader("content-type", "application/json");
        res.setHeader("Connection", "close");
        res.end(JSON.stringify({ keys: [jwk] }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    jwks.listen(0);
    await new Promise<void>((resolve) => jwks.once("listening", resolve));
    issuer = `http://127.0.0.1:${(jwks.address() as AddressInfo).port}`;
    process.env.LUNE_AUTH_SERVER_URL = issuer;

    app = buildHttpApp().listen(0);
    await new Promise<void>((resolve) => app.once("listening", resolve));
    port = (app.address() as AddressInfo).port;
  });

  afterAll(async () => {
    if (prevEnv === undefined) delete process.env.LUNE_AUTH_SERVER_URL;
    else process.env.LUNE_AUTH_SERVER_URL = prevEnv;
    jwks.closeAllConnections?.();
    await new Promise<void>((resolve) => app.close(() => resolve()));
    await new Promise<void>((resolve) => jwks.close(() => resolve()));
  });

  function mint(
    expSecondsFromNow: number,
    audience = "https://mcp.luneresearch.com/mcp",
  ) {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ org_id: "org-1", scopes: ["papers:read"] })
      .setProtectedHeader({ alg: "RS256", kid: KID })
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject("user-1")
      .setIssuedAt(now - 120)
      .setExpirationTime(now + expSecondsFromNow)
      .sign(privateKey);
  }

  it("returns 401 with an invalid_token challenge for an EXPIRED access token", async () => {
    const expired = await mint(-3600);
    const r = await post(
      port,
      { authorization: `Bearer ${expired}` },
      initBody(1),
    );

    expect(r.status).toBe(401);

    // The MCP client refreshes-then-retries off this exact header shape: an
    // explicit `error="invalid_token"` (RFC 6750 §3.1) plus the resource_metadata
    // pointer (RFC 9728). Without the error code a client may treat it as a fresh
    // consent rather than a refresh.
    const wa = r.headers.get("www-authenticate")!;
    expect(wa).toContain('error="invalid_token"');
    expect(wa).toContain(`resource_metadata="${METADATA_URL}"`);

    const body = (await r.json()) as {
      id: number;
      error: {
        code: number;
        data: { _meta: { "mcp/www_authenticate": string } };
      };
    };
    expect(body.id).toBe(1);
    expect(body.error.code).toBe(-32001);
    // Header and body-echoed challenge are the identical string.
    expect(body.error.data._meta["mcp/www_authenticate"]).toBe(wa);
  });

  it("lets a VALID access token through the gate (reaches the transport)", async () => {
    const valid = await mint(3600);
    const r = await post(
      port,
      { authorization: `Bearer ${valid}` },
      initBody(2),
    );

    expect(r.status).toBe(200);
    // Stateless serving mints no session id, so the handshake's own result is
    // what proves we passed the gate and executed rather than skipped the 401.
    expect(await r.text()).toContain("lune-research");
  });

  it("accepts every equivalent MCP audience on every mounted endpoint alias", async () => {
    const aliases = ["", "/mcp", "/v1/mcp"];
    let id = 20;
    for (const audienceAlias of aliases) {
      const token = await mint(
        3600,
        `https://mcp.luneresearch.com${audienceAlias}`,
      );
      for (const endpointAlias of aliases) {
        const r = await post(
          port,
          { authorization: `Bearer ${token}` },
          initBody(id++),
          endpointAlias || "/",
        );
        expect(
          r.status,
          `${audienceAlias || "/"} -> ${endpointAlias || "/"}`,
        ).toBe(200);
      }
    }
  });

  it("returns a transport 403 naming the one missing tool scope", async () => {
    const papersOnly = await mint(3600);
    const r = await post(
      port,
      { authorization: `Bearer ${papersOnly}` },
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: {
          name: "search_research_guidance",
          arguments: { query: "ablation design" },
        },
      },
    );
    expect(r.status).toBe(403);
    const challenge = r.headers.get("www-authenticate")!;
    expect(challenge).toContain('error="insufficient_scope"');
    expect(challenge).toContain('scope="guidance:read"');
    expect(challenge).not.toContain("papers:read");
  });

  it("applies scope step-up to tools/call inside a JSON-RPC batch", async () => {
    const papersOnly = await mint(3600);
    const r = await post(port, { authorization: `Bearer ${papersOnly}` }, [
      {
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: {
          name: "search_research_guidance",
          arguments: { query: "ablation design" },
        },
      },
    ]);
    expect(r.status).toBe(403);
    expect(r.headers.get("www-authenticate")).toContain(
      'scope="guidance:read"',
    );
  });

  it("lets an opaque PAT through the gate (validated downstream, not here)", async () => {
    const r = await post(
      port,
      { authorization: "Bearer lune_pat_fake123" },
      initBody(3),
    );
    // PATs are not JWTs: the gate must not 401 them. (Their validity is the API's
    // call; an initialize needs no upstream call, so this succeeds locally.)
    expect(r.status).not.toBe(401);
  });

  it("still answers a NO-token request with the bare discovery challenge (no regression)", async () => {
    const r = await post(port, {}, initBody(4));
    expect(r.status).toBe(401);
    const wa = r.headers.get("www-authenticate")!;
    // Anonymous discovery: bare challenge, NO error code (RFC 6750 §3).
    expect(wa).toBe(
      `Bearer resource_metadata="${METADATA_URL}", ` +
        'scope="papers:read guidance:read account:read"',
    );
    expect(wa).not.toContain("error=");
  });
});

/**
 * A key rotation must not make an otherwise valid token intermittently 401.
 *
 * jose re-fetches the JWKS on an unknown `kid` only once the cached set is past
 * `cooldownDuration`; inside that window it throws `ERR_JWKS_NO_MATCHING_KEY`,
 * which `TOKEN_ERROR_CODES` reads as a token fault and answers with a 401
 * `invalid_token`. The client then refreshes, gets a token carrying the SAME new
 * kid, and 401s again, which is what trips its "401 after successful auth"
 * circuit breaker. Each task holds its own cache, so at `max: 6` the same token
 * works on one call and fails on the next.
 *
 * Both sides of the window are asserted because the value is a tradeoff, not a
 * safe-by-default: no cooldown at all lets a burst of forged kids drive one JWKS
 * fetch per request. `LUNE_AUTH_SERVER_URL` moves to a fresh port here, which is
 * what gives this group its own resolver (`remoteJwks` rebuilds per origin).
 */
describe("JWKS cooldown after a signing-key rotation", () => {
  let jwks: HttpServer;
  let issuer: string;
  let served: Array<Record<string, unknown>> = [];

  async function keyFor(kid: string) {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwk = {
      ...(await exportJWK(publicKey)),
      kid,
      alg: "RS256",
      use: "sig",
    };
    return { jwk, privateKey };
  }

  function mintWith(privateKey: CryptoKey, kid: string, subject: string) {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ org_id: "org-1", scopes: ["papers:read"] })
      .setProtectedHeader({ alg: "RS256", kid })
      .setIssuer(issuer)
      .setAudience("https://mcp.luneresearch.com")
      .setSubject(subject)
      .setIssuedAt(now - 120)
      .setExpirationTime(now + 3600)
      .sign(privateKey);
  }

  beforeAll(async () => {
    jwks = http.createServer((req, res) => {
      if (req.url?.startsWith("/.well-known/jwks.json")) {
        res.setHeader("content-type", "application/json");
        res.setHeader("Connection", "close");
        res.end(JSON.stringify({ keys: served }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    jwks.listen(0);
    await new Promise<void>((resolve) => jwks.once("listening", resolve));
    issuer = `http://127.0.0.1:${(jwks.address() as AddressInfo).port}`;
    vi.stubEnv("LUNE_AUTH_SERVER_URL", issuer);
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
    jwks.closeAllConnections?.();
    await new Promise<void>((resolve) => jwks.close(() => resolve()));
  });

  it("accepts a token signed by a rotated-in key within seconds, not half a minute", async () => {
    const oldKey = await keyFor("rotation-old");
    const newKey = await keyFor("rotation-new");
    served = [oldKey.jwk];

    // Warm the cache with the pre-rotation key set, which is what starts the
    // cooldown clock; only `Date` is faked, so the real fetch still works.
    const before = await mintWith(
      oldKey.privateKey,
      "rotation-old",
      "user-old",
    );
    await expect(inspectAccessToken(before)).resolves.toMatchObject({
      needsReauth: false,
      verifiedIdentity: { distinctId: "user-old" },
    });

    // Rotate. The AS keeps the previous key live (`oauth_keys.py:all_pubkeys`
    // yields current + previous), so tokens minted BEFORE the flip keep working
    // and only freshly minted ones can land on an unknown kid.
    served = [newKey.jwk, oldKey.jwk];
    const warmedAt = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    const after = await mintWith(newKey.privateKey, "rotation-new", "user-new");

    vi.setSystemTime(warmedAt + 3_000);
    await expect(inspectAccessToken(after)).resolves.toEqual({
      needsReauth: true,
    });

    vi.setSystemTime(warmedAt + 6_000);
    await expect(inspectAccessToken(after)).resolves.toMatchObject({
      needsReauth: false,
      verifiedIdentity: { distinctId: "user-new" },
    });
    vi.useRealTimers();
  });
});
