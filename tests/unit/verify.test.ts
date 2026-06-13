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
import { describe, it, expect } from 'vitest';
import {
  SignJWT,
  generateKeyPair,
  errors as joseErrors,
  type JWTVerifyGetKey,
  type KeyLike,
} from 'jose';
import { accessTokenNeedsReauth } from '../../src/auth/verify.js';

const ISSUER = 'https://api.luneresearch.com';

// Wrap a public key as the getKey resolver jwtVerify expects (jose calls it with
// the token's protected header; a fixed key ignores that, like a one-key JWKS).
const keyResolver = (key: KeyLike): JWTVerifyGetKey => () => key;

async function makeKeys() {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  return { publicKey, privateKey };
}

function sign(
  privateKey: KeyLike,
  opts: { expSecondsFromNow: number; issuer?: string; kid?: string },
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ org_id: 'org-1', scopes: ['papers:read'] })
    .setProtectedHeader({ alg: 'RS256', kid: opts.kid ?? 'k1' })
    .setIssuer(opts.issuer ?? ISSUER)
    .setSubject('user-1')
    .setIssuedAt(now - 60)
    .setExpirationTime(now + opts.expSecondsFromNow)
    .sign(privateKey);
}

describe('accessTokenNeedsReauth', () => {
  it('passes a valid Lune OAuth access token (signature + exp OK)', async () => {
    const { publicKey, privateKey } = await makeKeys();
    const token = await sign(privateKey, { expSecondsFromNow: 3600 });
    expect(await accessTokenNeedsReauth(token, keyResolver(publicKey))).toBe(false);
  });

  it('flags an EXPIRED Lune OAuth access token for reauth (the reported bug)', async () => {
    const { publicKey, privateKey } = await makeKeys();
    const token = await sign(privateKey, { expSecondsFromNow: -3600 });
    expect(await accessTokenNeedsReauth(token, keyResolver(publicKey))).toBe(true);
  });

  it('flags a token whose signature does not verify (forged / wrong key)', async () => {
    const { privateKey } = await makeKeys();
    const { publicKey: otherPublic } = await makeKeys();
    const token = await sign(privateKey, { expSecondsFromNow: 3600 });
    // Verify against an unrelated public key -> ERR_JWS_SIGNATURE_VERIFICATION_FAILED.
    expect(await accessTokenNeedsReauth(token, keyResolver(otherPublic))).toBe(true);
  });

  it('accepts a correctly-signed token regardless of iss (signature is the proof; API enforces iss)', async () => {
    // We intentionally do NOT enforce `iss` at this gate (see verify.ts): a valid
    // signature against the configured JWKS already proves provenance, and a
    // separate iss match would risk false 401s on config drift. A token signed by
    // our key but carrying a foreign iss still verifies here; the API rejects it.
    const { publicKey, privateKey } = await makeKeys();
    const token = await sign(privateKey, { expSecondsFromNow: 3600, issuer: 'https://evil.example.com' });
    expect(await accessTokenNeedsReauth(token, keyResolver(publicKey))).toBe(false);
  });

  it('flags a token whose signing key is absent from the JWKS (unknown kid)', async () => {
    const { privateKey } = await makeKeys();
    const token = await sign(privateKey, { expSecondsFromNow: 3600 });
    // A resolver that has fetched the JWKS but lacks the kid -> token problem.
    const resolver: JWTVerifyGetKey = () => {
      throw new joseErrors.JWKSNoMatchingKey();
    };
    expect(await accessTokenNeedsReauth(token, resolver)).toBe(true);
  });

  it('FAILS OPEN when the JWKS cannot be fetched (infra error, not a token error)', async () => {
    const { privateKey } = await makeKeys();
    const token = await sign(privateKey, { expSecondsFromNow: 3600 });
    // Timeout / network failure reaching our own JWKS must not 401 a possibly
    // valid token: proceed and let the API stay the authority.
    const timeout: JWTVerifyGetKey = () => {
      throw new joseErrors.JWKSTimeout();
    };
    expect(await accessTokenNeedsReauth(token, timeout)).toBe(false);

    const generic: JWTVerifyGetKey = () => {
      throw new TypeError('fetch failed'); // raw network error, no jose code.
    };
    expect(await accessTokenNeedsReauth(token, generic)).toBe(false);
  });

  it('passes an opaque PAT through untouched (not a JWT)', async () => {
    // PATs are validated by the API (DB lookup), never locally; they also have
    // no refresh token, so there is nothing for a 401 to trigger here. The
    // resolver is never reached (decodeProtectedHeader throws first).
    expect(await accessTokenNeedsReauth('lune_pat_abc123')).toBe(false);
    expect(await accessTokenNeedsReauth('not.a.jwt')).toBe(false);
    expect(await accessTokenNeedsReauth('fake')).toBe(false);
  });

  it('passes a non-RS256 JWT through (e.g. a Supabase ES256 session)', async () => {
    const { privateKey } = await generateKeyPair('ES256');
    const now = Math.floor(Date.now() / 1000);
    const es = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256' })
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(privateKey);
    // Not a Lune OAuth token: we do not adjudicate it (alg gate short-circuits
    // before the resolver), the API does.
    expect(await accessTokenNeedsReauth(es)).toBe(false);
  });

  it('FAILS OPEN when LUNE_AUTH_SERVER_URL is malformed (no 500 on misconfig)', async () => {
    // The default JWKS resolver is built inside the verify try, so a bad env
    // (the `new URL(...)` throwing) must fail open like any JWKS infra fault,
    // never propagate a 500 to every POST /mcp. Exercises the no-resolver path.
    const { privateKey } = await makeKeys();
    const token = await sign(privateKey, { expSecondsFromNow: 3600 });
    const prev = process.env.LUNE_AUTH_SERVER_URL;
    process.env.LUNE_AUTH_SERVER_URL = 'not-a-valid-url';
    try {
      await expect(accessTokenNeedsReauth(token)).resolves.toBe(false);
    } finally {
      if (prev === undefined) delete process.env.LUNE_AUTH_SERVER_URL;
      else process.env.LUNE_AUTH_SERVER_URL = prev;
    }
  });
});
