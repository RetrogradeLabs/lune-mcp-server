/**
 * Resource-server validation of Lune OAuth access tokens.
 *
 * The MCP server is the OAuth 2.1 *resource server* (RFC 9728): when an access
 * token is expired or invalid it MUST answer with a transport-level 401 so the
 * client's MCP OAuth layer (Claude Desktop, Cursor, ...) silently refreshes the
 * token and retries the request. Before this gate the server forwarded any
 * Bearer straight to the Lune API and mapped the API's downstream 401 to a *tool
 * execution error* (`errors.ts`), which the model surfaced as "your
 * authorization expired, please reconnect" instead of the client ever
 * refreshing. Access tokens live one hour, so without this the user re-consented
 * roughly hourly. See `.claude/rules/mcp.md` (Remote-MCP OAuth).
 *
 * Scope: only Lune's own OAuth tokens (RS256 JWTs minted by
 * `api.luneresearch.com`) are validated here. Personal Access Tokens (`lune_*`,
 * opaque) and any non-RS256 bearer pass straight through, with the API as their
 * authority. JWKS fetch / availability failures FAIL OPEN (pass through) so a
 * transient inability to reach our own JWKS cannot brick every OAuth tool call.
 */
import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify } from "jose";
import type { JWTVerifyGetKey } from "jose";

// jose error `code`s that mean the TOKEN ITSELF is bad: expired, forged, signed
// by a rotated-out / unknown key, or carrying invalid claims (e.g. wrong issuer).
// These map to a 401 that triggers the client's silent refresh. Every other
// failure, notably JWKS fetch / timeout / malformed-response
// (ERR_JWKS_TIMEOUT / ERR_JWKS_INVALID) and raw network errors, FAILS OPEN: the
// request proceeds and the API stays the backstop authority, so a JWKS outage
// degrades to the pre-gate behavior rather than locking everyone out.
// `ERR_JWKS_NO_MATCHING_KEY` is a token problem, not an infra one: jose throws it
// only AFTER a JWKS was successfully fetched (and re-fetched, past its cooldown)
// and still genuinely lacks the token's `kid`.
const TOKEN_ERROR_CODES = new Set<string>([
  "ERR_JWT_EXPIRED",
  "ERR_JWS_SIGNATURE_VERIFICATION_FAILED",
  "ERR_JWKS_NO_MATCHING_KEY",
  "ERR_JWT_CLAIM_VALIDATION_FAILED",
  "ERR_JWS_INVALID",
  "ERR_JWT_INVALID",
]);

function authServerOrigin(): string {
  return (process.env.LUNE_AUTH_SERVER_URL ?? "https://api.luneresearch.com").replace(/\/+$/, "");
}

// Lazily build and memoise the remote JWKS resolver. `createRemoteJWKSet` caches
// keys in-process, re-fetches on an unknown `kid` (bounded by a cooldown), and
// tracks key rotation, so a network fetch happens about once per rotation, not
// per request. Re-created only when the auth-server origin changes (tests point
// it at a local JWKS server via `LUNE_AUTH_SERVER_URL`).
let jwksRef: { origin: string; resolve: ReturnType<typeof createRemoteJWKSet> } | null = null;
function remoteJwks(): ReturnType<typeof createRemoteJWKSet> {
  const origin = authServerOrigin();
  if (!jwksRef || jwksRef.origin !== origin) {
    jwksRef = {
      origin,
      // `timeoutDuration` caps the per-request wait when the JWKS endpoint hangs
      // (default 5s); on timeout jose throws `ERR_JWKS_TIMEOUT`, which is NOT a
      // token-error code, so the gate fails open. JWKS is co-located with the AS
      // (~ms healthy), so 3s only bites a real outage.
      resolve: createRemoteJWKSet(new URL(`${origin}/.well-known/jwks.json`), {
        timeoutDuration: 3000,
        cooldownDuration: 30_000,
        cacheMaxAge: 600_000,
      }),
    };
  }
  return jwksRef.resolve;
}

/**
 * True iff `token` is a Lune OAuth access token (RS256 JWT) that FAILED
 * verification for a token-level reason (expired, bad signature, unknown key,
 * bad claims). Opaque PATs, non-RS256 bearers, and JWKS-infra failures return
 * false (proceed; the API decides). A `false` here never grants access on its
 * own: the request still carries the bearer to the API, which re-validates it.
 *
 * `keyResolver` is injectable for tests; production uses the cached remote JWKS.
 */
export async function accessTokenNeedsReauth(
  token: string,
  keyResolver?: JWTVerifyGetKey,
): Promise<boolean> {
  let alg: string | undefined;
  try {
    alg = decodeProtectedHeader(token).alg;
  } catch {
    return false; // not a JWT (PAT / opaque bearer) -> defer to the API.
  }
  if (alg !== "RS256") return false; // not a Lune OAuth token (e.g. Supabase ES256).
  try {
    // Resolve the JWKS INSIDE the try so a malformed `LUNE_AUTH_SERVER_URL` (the
    // `new URL(...)` in `remoteJwks()` throwing) fails open like any other JWKS
    // infra fault, rather than 500-ing every request. Makes the fail-open
    // invariant total.
    const resolve = keyResolver ?? remoteJwks();
    // Verify signature + exp against the AS JWKS, pinned to RS256. We deliberately
    // do NOT also assert `iss`: a signature that verifies against the configured
    // JWKS is itself the provenance proof (only the AS holds the private key), so
    // a separate iss string/origin match adds no security while risking a FALSE
    // 401 on benign config drift (e.g. a trailing slash or CNAME on
    // LUNE_AUTH_SERVER_URL vs the API's `oauth_issuer`). A false 401 here would be
    // worse than the original bug: the refreshed token carries the same iss, so it
    // would 401 too and trip the client's "401 after successful auth" circuit
    // breaker, hard-breaking OAuth for everyone. The API stays the iss authority.
    await jwtVerify(token, resolve, { algorithms: ["RS256"] });
    return false; // signature + exp valid.
  } catch (e) {
    const code = (e as { code?: string }).code;
    return code !== undefined && TOKEN_ERROR_CODES.has(code);
  }
}
