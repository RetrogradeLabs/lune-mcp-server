/**
 * Resource-server token validation (`auth/verify.ts`).
 *
 * `accessTokenNeedsReauth` decides, for a Bearer arriving on POST /mcp, whether
 * the MCP server should answer 401 (so the client silently refreshes) or let the
 * request through. It is the gate that converts an expired Lune OAuth access
 * token into a refresh-triggering 401 instead of a "please reconnect" tool error.
 *
 * These tests sign REAL RS256 JWTs with jose and verify against the matching
 * public key (an injected key resolver), so the only thing mocked is the network
 * JWKS fetch; the crypto path is exactly production's. The contract under test:
 *   - expired / forged / unknown-key Lune OAuth JWT  -> true  (401, triggers refresh)
 *   - valid Lune OAuth JWT                           -> false (proceed)
 *   - opaque PAT, non-RS256 bearer, JWKS-infra error -> false (proceed; API decides)
 */
import { describe, it, expect } from "vitest";
import {
  SignJWT,
  generateKeyPair,
  errors as joseErrors,
  type CryptoKey,
  type JWTVerifyGetKey,
} from "jose";
import {
  accessTokenNeedsReauth,
  inspectAccessToken,
} from "../../src/auth/verify.js";

const ISSUER = "https://api.luneresearch.com";

const AUDIENCE = "https://mcp.luneresearch.com";

// Wrap a public key as the getKey resolver jwtVerify expects (jose calls it with
// the token's protected header; a fixed key ignores that, like a one-key JWKS).
const keyResolver =
  (key: CryptoKey): JWTVerifyGetKey =>
  () =>
    key;

async function makeKeys() {
  const { publicKey, privateKey } = await generateKeyPair("RS256");

  return { publicKey, privateKey };
}

function sign(
  privateKey: CryptoKey,
  opts: {
    expSecondsFromNow: number;
    issuer?: string;
    audience?: string;
    kid?: string;
  },
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);

  return new SignJWT({ org_id: "org-1", scopes: ["papers:read"] })
    .setProtectedHeader({ alg: "RS256", kid: opts.kid ?? "k1" })
    .setIssuer(opts.issuer ?? ISSUER)
    .setAudience(opts.audience ?? AUDIENCE)
    .setSubject("user-1")
    .setIssuedAt(now - 60)
    .setExpirationTime(now + opts.expSecondsFromNow)
    .sign(privateKey);
}

describe("accessTokenNeedsReauth", () => {
  it("passes a valid Lune OAuth access token (signature + exp OK)", async () => {
    const { publicKey, privateKey } = await makeKeys();
    const token = await sign(privateKey, { expSecondsFromNow: 3600 });
    expect(await accessTokenNeedsReauth(token, keyResolver(publicKey))).toBe(
      false,
    );
  });

  it("returns an analytics identity only for a cryptographically verified Lune OAuth token", async () => {
    const { publicKey, privateKey } = await makeKeys();
    const token = await sign(privateKey, { expSecondsFromNow: 3600 });
    await expect(
      inspectAccessToken(token, keyResolver(publicKey)),
    ).resolves.toEqual({
      needsReauth: false,
      verifiedIdentity: {
        distinctId: "user-1",
        orgId: "org-1",
        scopes: ["papers:read"],
      },
    });
  });

  it("flags an EXPIRED Lune OAuth access token for reauth (the reported bug)", async () => {
    const { publicKey, privateKey } = await makeKeys();
    const token = await sign(privateKey, { expSecondsFromNow: -3600 });
    expect(await accessTokenNeedsReauth(token, keyResolver(publicKey))).toBe(
      true,
    );
  });

  it("flags a token whose signature does not verify (forged / wrong key)", async () => {
    const { privateKey } = await makeKeys();
    const { publicKey: otherPublic } = await makeKeys();
    const token = await sign(privateKey, { expSecondsFromNow: 3600 });
    // Verify against an unrelated public key -> ERR_JWS_SIGNATURE_VERIFICATION_FAILED.
    expect(await accessTokenNeedsReauth(token, keyResolver(otherPublic))).toBe(
      true,
    );
  });

  it("rejects a correctly-signed token from the wrong issuer", async () => {
    const { publicKey, privateKey } = await makeKeys();

    const token = await sign(privateKey, {
      expSecondsFromNow: 3600,
      issuer: "https://evil.example.com",
    });

    expect(await accessTokenNeedsReauth(token, keyResolver(publicKey))).toBe(
      true,
    );
  });

  it("rejects a correctly-signed token for another resource", async () => {
    const { publicKey, privateKey } = await makeKeys();

    const token = await sign(privateKey, {
      expSecondsFromNow: 3600,
      audience: "https://api.luneresearch.com",
    });

    expect(await accessTokenNeedsReauth(token, keyResolver(publicKey))).toBe(
      true,
    );
  });

  it.each([
    ["https://mcp.luneresearch.com", "https://mcp.luneresearch.com/mcp"],
    ["https://mcp.luneresearch.com/mcp", "https://mcp.luneresearch.com/v1/mcp"],
    ["https://mcp.luneresearch.com/v1/mcp", "https://mcp.luneresearch.com"],
  ])(
    "accepts the %s audience on the equivalent %s endpoint alias",
    async (audience, expectedAudience) => {
      const { publicKey, privateKey } = await makeKeys();

      const token = await sign(privateKey, {
        expSecondsFromNow: 3600,
        audience,
      });

      expect(
        await accessTokenNeedsReauth(
          token,
          keyResolver(publicKey),
          expectedAudience,
        ),
      ).toBe(false);
    },
  );

  it.each([
    "https://mcp.luneresearch.com/org/mcp",
    "https://other.example.com/mcp",
    "https://mcp.luneresearch.com/mcp?tenant=other",
  ])("rejects the non-alias audience %s", async (audience) => {
    const { publicKey, privateKey } = await makeKeys();

    const token = await sign(privateKey, {
      expSecondsFromNow: 3600,
      audience,
    });

    expect(
      await accessTokenNeedsReauth(
        token,
        keyResolver(publicKey),
        "https://mcp.luneresearch.com/mcp",
      ),
    ).toBe(true);
  });

  it("accepts a client-id audience only on the explicit legacy bridge", async () => {
    const { publicKey, privateKey } = await makeKeys();

    const token = await sign(privateKey, {
      expSecondsFromNow: 3600,
      audience: "lune_oauth_legacy-client",
    });

    expect(await accessTokenNeedsReauth(token, keyResolver(publicKey))).toBe(
      true,
    );
    expect(
      await accessTokenNeedsReauth(
        token,
        keyResolver(publicKey),
        AUDIENCE,
        true,
      ),
    ).toBe(false);
  });

  it("flags a token whose signing key is absent from the JWKS (unknown kid)", async () => {
    const { privateKey } = await makeKeys();
    const token = await sign(privateKey, { expSecondsFromNow: 3600 });

    // A resolver that has fetched the JWKS but lacks the kid -> token problem.
    const resolver: JWTVerifyGetKey = () => {
      throw new joseErrors.JWKSNoMatchingKey();
    };

    expect(await accessTokenNeedsReauth(token, resolver)).toBe(true);
  });

  it("FAILS OPEN when the JWKS cannot be fetched (infra error, not a token error)", async () => {
    const { privateKey } = await makeKeys();
    const token = await sign(privateKey, { expSecondsFromNow: 3600 });

    // Timeout / network failure reaching our own JWKS must not 401 a possibly
    // valid token: proceed and let the API stay the authority.
    const timeout: JWTVerifyGetKey = () => {
      throw new joseErrors.JWKSTimeout();
    };

    expect(await accessTokenNeedsReauth(token, timeout)).toBe(false);

    const generic: JWTVerifyGetKey = () => {
      throw new TypeError("fetch failed"); // raw network error, no jose code.
    };

    expect(await accessTokenNeedsReauth(token, generic)).toBe(false);
    await expect(inspectAccessToken(token, timeout)).resolves.toEqual({
      needsReauth: false,
    });
  });

  it("challenges an EXPIRED token even under a JWKS infra fault (exp decoded locally)", async () => {
    // A token plainly past its own exp should trigger a refresh (transport 401)
    // rather than dead-end as a tool error; an unverified decode never grants.
    const { privateKey } = await makeKeys();

    const timeout: JWTVerifyGetKey = () => {
      throw new joseErrors.JWKSTimeout();
    };

    const expired = await sign(privateKey, { expSecondsFromNow: -3600 });
    expect(await accessTokenNeedsReauth(expired, timeout)).toBe(true);
    // A still-valid token under the SAME fault stays fail-open (must not loop).
    const valid = await sign(privateKey, { expSecondsFromNow: 3600 });
    expect(await accessTokenNeedsReauth(valid, timeout)).toBe(false);
  });

  it("passes an opaque PAT through untouched (not a JWT)", async () => {
    // PATs are validated by the API, never locally, and have no refresh token,
    // so the resolver is never reached (decodeProtectedHeader throws first).
    expect(await accessTokenNeedsReauth("lune_pat_abc123")).toBe(false);
    expect(await accessTokenNeedsReauth("not.a.jwt")).toBe(false);
    expect(await accessTokenNeedsReauth("fake")).toBe(false);
  });

  it("challenges an RS256-shaped token with an undecodable payload", async () => {
    const header = Buffer.from(
      JSON.stringify({ alg: "RS256", kid: "k1" }),
    ).toString("base64url");

    expect(await accessTokenNeedsReauth(`${header}.not-json.signature`)).toBe(
      true,
    );
  });

  it("passes a non-RS256 JWT through (e.g. a Supabase ES256 session)", async () => {
    const { privateKey } = await generateKeyPair("ES256");
    const now = Math.floor(Date.now() / 1000);

    const es = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256" })
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(privateKey);

    // Not a Lune OAuth token: we do not adjudicate it (alg gate short-circuits
    // before the resolver), the API does.
    expect(await accessTokenNeedsReauth(es)).toBe(false);
    await expect(inspectAccessToken(es)).resolves.toEqual({
      needsReauth: false,
    });
  });

  it("fails closed when LUNE_AUTH_SERVER_URL does not match the token issuer", async () => {
    const { privateKey } = await makeKeys();
    const token = await sign(privateKey, { expSecondsFromNow: 3600 });
    const prev = process.env.LUNE_AUTH_SERVER_URL;
    process.env.LUNE_AUTH_SERVER_URL = "not-a-valid-url";

    try {
      await expect(accessTokenNeedsReauth(token)).resolves.toBe(true);
    } finally {
      if (prev === undefined) delete process.env.LUNE_AUTH_SERVER_URL;
      else process.env.LUNE_AUTH_SERVER_URL = prev;
    }
  });
});
