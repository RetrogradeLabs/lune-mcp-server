/**
 * Resource-server validation of Lune OAuth access tokens.
 *
 * The MCP server is the OAuth 2.1 *resource server* (RFC 9728): an expired/invalid
 * access token MUST get a transport-level 401 so the client's MCP OAuth layer
 * (Claude Desktop, Cursor, ...) silently refreshes and retries. Without this gate
 * the API's downstream 401 mapped to a tool error the model surfaced as "reconnect"
 * (no refresh), forcing roughly hourly re-consent (1h token TTL). See
 * the MCP server design notes (Remote-MCP OAuth).
 *
 * Scope: only Lune's own OAuth tokens (RS256 JWTs minted by
 * `api.luneresearch.com`) are validated here. Personal Access Tokens (`lune_*`,
 * opaque) and any non-RS256 bearer pass straight through, with the API as their
 * authority. JWKS fetch / availability failures FAIL OPEN (pass through) so a
 * transient inability to reach our own JWKS cannot brick every OAuth tool call.
 */
import {
  createRemoteJWKSet,
  decodeJwt,
  decodeProtectedHeader,
  jwtVerify,
} from "jose";
import type { JWTPayload, JWTVerifyGetKey } from "jose";

import { isJsonNumber, isJsonString, type JsonObject } from "../json.js";
import { runtimeSetting } from "../runtime-config.js";

// Allow 30 seconds of clock skew without forcing reauth on a one-hour token.
const CLOCK_TOLERANCE_S = 30;

// Only token-invalid jose codes trigger reauth; JWKS/network failures fail open
// to the API. NO_MATCHING_KEY follows a successful refresh, so it is token-invalid.
const TOKEN_ERROR_CODES = new Set<string>([
  "ERR_JWT_EXPIRED",
  "ERR_JWS_SIGNATURE_VERIFICATION_FAILED",
  "ERR_JWKS_NO_MATCHING_KEY",
  "ERR_JWT_CLAIM_VALIDATION_FAILED",
  "ERR_JWS_INVALID",
  "ERR_JWT_INVALID",
]);

function authServerOrigin(): string {
  return runtimeSetting("LUNE_AUTH_SERVER_URL").replace(/\/+$/, "");
}

function resourceServerOrigin(): string {
  return new URL(runtimeSetting("MCP_PUBLIC_URL")).origin;
}

const MCP_RESOURCE_PATHS = new Set(["/", "/mcp", "/v1/mcp"]);

function isMcpResourceAlias(value: string): boolean {
  try {
    const resource = new URL(value);
    const path = resource.pathname.replace(/\/+$/, "") || "/";

    return (
      resource.origin === resourceServerOrigin() &&
      !resource.search &&
      !resource.hash &&
      MCP_RESOURCE_PATHS.has(path)
    );
  } catch {
    return false;
  }
}

function acceptedAudiences(expected: string): string[] {
  if (!isMcpResourceAlias(expected)) return [expected];
  const origin = resourceServerOrigin();

  return [origin, `${origin}/mcp`, `${origin}/v1/mcp`];
}

/** A single-valued `aud`, as opposed to the array form or an absent claim. */
function isSingleAudience(
  audience: string | string[] | undefined,
): audience is string {
  return typeof audience === "string";
}

function audienceMatches(
  audience: string | string[] | undefined,
  expected: string,
): boolean {
  const accepted = new Set(acceptedAudiences(expected));

  return isSingleAudience(audience)
    ? accepted.has(audience)
    : Array.isArray(audience) && audience.some((value) => accepted.has(value));
}

/**
 * A JWT payload viewed as the JSON object it is. jose types unrecognised claims
 * as `unknown` because it cannot know a token's schema; every read below still
 * goes through a predicate, so nothing here trusts a claim's type.
 */
function claimsOf(payload: JWTPayload): JsonObject {
  // SAFETY: jose decoded and parsed this payload as JSON; predicates still
  // establish every claim's type.
  return payload as JsonObject;
}

interface CodedError extends Error {
  code: string;
}

/** jose stamps a string `code` on the errors that mean the token itself is bad.
 *  A thrown value need not be an Error at all, let alone carry one. */
function isCodedError(cause: unknown): cause is CodedError {
  return (
    cause instanceof Error && "code" in cause && typeof cause.code === "string"
  );
}

// Memoize jose's rotating JWKS resolver per auth origin so unknown kids refresh
// keys without fetching on every request.
let jwksRef: {
  origin: string;
  resolve: ReturnType<typeof createRemoteJWKSet>;
} | null = null;

function remoteJwks(): ReturnType<typeof createRemoteJWKSet> {
  const origin = authServerOrigin();

  if (!jwksRef || jwksRef.origin !== origin) {
    jwksRef = {
      origin,
      // A hanging JWKS fails open after 3s. A 5s cooldown, not jose's 30s, limits
      // how long a new key is refused; forged kids still cannot force a fetch.
      resolve: createRemoteJWKSet(new URL(`${origin}/.well-known/jwks.json`), {
        timeoutDuration: 3000,
        cooldownDuration: 5_000,
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
export interface VerifiedOAuthIdentity {
  distinctId: string;
  orgId?: string;
  scopes: string[];
}

export interface AccessTokenInspection {
  needsReauth: boolean;
  verifiedIdentity?: VerifiedOAuthIdentity;
}

function decodedAlgorithm(token: string): string | undefined {
  try {
    return decodeProtectedHeader(token).alg;
  } catch {
    return undefined;
  }
}

function decodedPayload(token: string): ReturnType<typeof decodeJwt> | null {
  try {
    return decodeJwt(token);
  } catch {
    return null;
  }
}

function legacyAudienceOf(
  payload: JWTPayload,
  allowLegacyClientAudience: boolean,
): string | undefined {
  if (!allowLegacyClientAudience || !isSingleAudience(payload.aud)) {
    return undefined;
  }

  return /^lune_oauth_[A-Za-z0-9_-]+$/.test(payload.aud)
    ? payload.aud
    : undefined;
}

function targetsResource(
  payload: JWTPayload,
  expectedAudience: string,
  legacyAudience: string | undefined,
): boolean {
  return (
    payload.iss === authServerOrigin() &&
    (audienceMatches(payload.aud, expectedAudience) ||
      legacyAudience !== undefined)
  );
}

function verificationAudiences(
  expectedAudience: string,
  legacyAudience: string | undefined,
): string[] {
  const audiences = acceptedAudiences(expectedAudience);

  return legacyAudience === undefined
    ? audiences
    : [...audiences, legacyAudience];
}

function verifiedIdentityOf(
  payload: JWTPayload,
): VerifiedOAuthIdentity | undefined {
  const claims = claimsOf(payload);
  const subject = claims.sub;

  if (!isJsonString(subject) || !subject) return undefined;

  const verifiedIdentity: VerifiedOAuthIdentity = {
    distinctId: subject,
    scopes: Array.isArray(claims.scopes)
      ? claims.scopes.filter(isJsonString)
      : [],
  };

  const orgId = claims.org_id;

  if (isJsonString(orgId) && orgId) verifiedIdentity.orgId = orgId;

  return verifiedIdentity;
}

function isTokenFailure(cause: unknown): boolean {
  return isCodedError(cause) && TOKEN_ERROR_CODES.has(cause.code);
}

function isExpiredPayload(payload: JWTPayload): boolean {
  const exp = claimsOf(payload).exp;

  return isJsonNumber(exp) && exp < Date.now() / 1000 - CLOCK_TOLERANCE_S;
}

/**
 * Inspect a bearer without changing the resource-server decision contract.
 * Only a successfully verified Lune RS256 token yields an analytics identity;
 * every fail-open path remains admissible but anonymous until the API decides.
 */
export async function inspectAccessToken(
  token: string,
  keyResolver?: JWTVerifyGetKey,
  expectedAudience = resourceServerOrigin(),
  allowLegacyClientAudience = false,
): Promise<AccessTokenInspection> {
  const alg = decodedAlgorithm(token);

  if (alg !== "RS256") return { needsReauth: false };
  const unverified = decodedPayload(token);

  if (unverified === null) return { needsReauth: true };

  try {
    const legacyAudience = legacyAudienceOf(
      unverified,
      allowLegacyClientAudience,
    );

    if (!targetsResource(unverified, expectedAudience, legacyAudience)) {
      return { needsReauth: true };
    }

    // Resolved inside the try so a malformed LUNE_AUTH_SERVER_URL fails open
    // like any other JWKS fault instead of 500-ing: fail-open is then total.
    const resolve = keyResolver ?? remoteJwks();

    // The unverified audience check above is what keeps audience rejection
    // fail-closed during a JWKS outage; the API re-verifies regardless.
    const { payload } = await jwtVerify(token, resolve, {
      algorithms: ["RS256"],
      issuer: authServerOrigin(),
      audience: verificationAudiences(expectedAudience, legacyAudience),
      clockTolerance: CLOCK_TOLERANCE_S,
    });

    const verifiedIdentity = verifiedIdentityOf(payload);

    if (verifiedIdentity === undefined) return { needsReauth: true };

    return { needsReauth: false, verifiedIdentity };
  } catch (cause) {
    // On the fail-open path a token past its own `exp` would dead-end as an API
    // 401; challenge instead. An unverified decode only forces a refresh.
    return {
      needsReauth: isTokenFailure(cause) || isExpiredPayload(unverified),
    };
  }
}

export async function accessTokenNeedsReauth(
  token: string,
  keyResolver?: JWTVerifyGetKey,
  expectedAudience?: string,
  allowLegacyClientAudience?: boolean,
): Promise<boolean> {
  return (
    await inspectAccessToken(
      token,
      keyResolver,
      expectedAudience,
      allowLegacyClientAudience,
    )
  ).needsReauth;
}
