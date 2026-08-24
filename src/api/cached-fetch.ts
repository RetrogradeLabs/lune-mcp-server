/**
 * Cache-Control-aware fetch wrapper for MCP tools.
 *
 * Wraps a `ky` request and consults the shared `TOOL_RESPONSE_CACHE`. The
 * cache key is `<METHOD> <path> <stable-hash(body|searchParams)>` and does
 * NOT include the bearer token, so the wrapper enforces two layers of safety:
 *
 *   1. Per-principal paths (search, citations, related) bypass the cache
 *      entirely on BOTH read and write. Their responses vary by the caller
 *      (conference exclusions / identity), so a tokenless key could otherwise
 *      leak one principal's results to another.
 *   2. For everything else, a tri-state write decision: store only when the
 *      response is explicitly `public` (for its `max-age`), or when it carries
 *      no usable signal AND the path is on the principal-invariant allowlist
 *      (under `defaultTtlMs`). A `private` / `no-store` response, or an
 *      unmarked non-allowlisted path, is never stored (no `defaultTtlMs`
 *      fall-through).
 */

import type { KyInstance, Options as KyOptions } from "ky";

import { TOOL_RESPONSE_CACHE, TOOL_RESPONSE_SINGLEFLIGHT } from "../cache.js";

type Method = "get" | "post";

interface CachedFetchOptions extends KyOptions {
  /**
   * TTL (ms) used when the response has no usable `Cache-Control: max-age=…`.
   * Set to 0 (default) to refuse caching when the API doesn't say it's safe.
   */
  defaultTtlMs?: number;
}

function stableSearchParams(sp: KyOptions["searchParams"]): string {
  if (sp === undefined || sp === null) return "";
  if (typeof sp === "string") return sp;
  if (sp instanceof URLSearchParams) {
    const sorted = Array.from(sp.entries()).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    return new URLSearchParams(sorted).toString();
  }
  // Plain object: sort keys for stability.
  const entries = Object.entries(sp).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(entries);
}

// Paths whose response varies by the caller (conference exclusions / identity).
// They MUST bypass the shared cache on BOTH read and write: the cache key does
// not include the bearer token, so a stored entry would leak across principals.
const PER_PRINCIPAL_PATHS: RegExp[] = [
  /^search$/,
  // Per-principal like /search (caller `excluded_conference_ids`): bypass the
  // tokenless shared key so results can't leak across principals.
  /^search\/batch$/,
  // Per-principal like /search/batch: per-claim evidence search uses the caller's
  // excluded_conference_ids, so verdicts vary by principal.
  /^claims\/verify$/,
  // Per-principal like the others, but MUST also bypass the single-flight: even at
  // ttl 0, two principals with an identical body would otherwise collapse onto one
  // leader's response (the leader's exclusions), leaking across principals.
  /^evidence\/gather$/,
  // workspaces/search resolves the workspace from the caller's bearer
  // credential (its active_workspace_id), so its results are not just
  // per-principal but per-active-workspace. The tokenless shared key would
  // otherwise leak one user's private documents to another; this path MUST
  // bypass both the cache read/write AND the single-flight collapse.
  /^workspaces\/search$/,
  // Per-active-workspace exactly like workspaces/search (one document's full text
  // from the caller's active workspace); bypass cache + single-flight or private
  // document text leaks across users.
  /^workspaces\/document$/,
  // extract_from_papers with source="workspace" resolves the caller's active
  // workspace documents server-side, so its results are per-active-workspace
  // exactly like workspaces/search. It is a POST through cachedJson with a
  // TOKENLESS key, so even though it is never STORED (not global-cacheable), two
  // concurrent callers with an identical body would collapse onto one leader via
  // the single-flight and leak that leader's private extraction (and meter only
  // the leader). MUST bypass both the cache and the single-flight.
  /^papers\/extract$/,
  // ALL research-guidance/* (search POST + /{doc_id} GET): the content is
  // principal-INVARIANT (a global curated corpus), so this is NOT a tenant-leak
  // guard, but both API routes are scope-gated (`guidance:read` + forbid_session)
  // AND billable. Even when the response is `private` (never STORED), the tokenless
  // SINGLE-FLIGHT would collapse two concurrent identical requests onto one leader:
  // a caller lacking `guidance:read` (or over quota) attaches to an authorized
  // caller's in-flight promise and gets the result with NO API call of its own,
  // bypassing the per-caller scope + metering. Bypass cache + single-flight so each
  // request reaches the API to be scoped + metered.
  /^research-guidance\/[^/]+$/,
  // papers/{id}/fulltext + conferences/{id}/papers are scope/auth-gated + billable
  // GETs. They are stamped `private` (so never STORED), but were still on the
  // tokenless single-flight path, where a concurrent unauthorized / over-quota
  // caller could attach to an authorized leader's in-flight fetch and receive the
  // paid full text / conference papers without its own scoped + metered API call.
  // Bypass the single-flight too.
  /^papers\/[^/]+\/fulltext$/,
  /^conferences\/[^/]+\/papers$/,
  /^papers\/[^/]+\/citations$/,
  /^papers\/[^/]+\/related$/,
];

// ANONYMOUS principal-invariant paths safe to cache + single-flight GLOBALLY
// (shared across callers under a tokenless key). ONLY truly anonymous routes
// belong here: an auth-gated/billable route must NOT be shared pre-API even when
// its content is global, because the single-flight would serve a concurrent
// unauthorized/over-quota caller the authorized leader's response (scope + meter
// bypass) - those live on PER_PRINCIPAL_PATHS instead. The conferences LIST is in
// the API PUBLIC_PATHS (anonymous), so it is the only globally-shareable fetch.
// Anonymity is also what keeps ERROR bodies tenant-safe here: the single-flight
// shares a leader's REJECTION with its followers, and a 402 body carries the
// leader's tier / usage / credit balance (`quota.out_of_credits_payload`). A path
// on this list can never 402 because it never hydrates a principal; anything that
// can must stay off it.
const GLOBAL_CACHEABLE_PATHS: RegExp[] = [/^conferences$/];

function isPerPrincipalPath(path: string): boolean {
  return PER_PRINCIPAL_PATHS.some((re) => re.test(path));
}

function isGlobalCacheablePath(path: string): boolean {
  return GLOBAL_CACHEABLE_PATHS.some((re) => re.test(path));
}

type CacheDirective = "public" | "private" | "none";

/** Classify a `Cache-Control` header into the only three states we act on. */
function cacheControlDirective(cacheControl: string | null): CacheDirective {
  if (!cacheControl) return "none";
  if (/\b(no-store|private)\b/i.test(cacheControl)) return "private";
  if (/\bpublic\b/i.test(cacheControl)) return "public";
  return "none";
}

/** Extract `max-age` (ms) from a Cache-Control header, or null if absent. */
function maxAgeMs(cacheControl: string | null): number | null {
  if (!cacheControl) return null;
  const match = cacheControl.match(/max-age=(\d+)/i);
  return match ? Number.parseInt(match[1]!, 10) * 1000 : null;
}

export async function cachedJson<T = unknown>(
  api: KyInstance,
  method: Method,
  path: string,
  opts: CachedFetchOptions = {},
): Promise<T> {
  const { defaultTtlMs, ...kyOpts } = opts;

  // Per-principal paths bypass the shared cache entirely: no read, no
  // single-flight populate, no write. This is the primary correctness guard
  // and is independent of whatever Cache-Control the API sends.
  if (isPerPrincipalPath(path)) {
    const resp =
      method === "get"
        ? await api.get(path, kyOpts)
        : await api.post(path, kyOpts);
    return (await resp.json()) as T;
  }

  const bodyHash = JSON.stringify(kyOpts.json ?? null);
  const spHash = stableSearchParams(kyOpts.searchParams);
  const cacheKey = `${method.toUpperCase()} ${path} ${bodyHash} ${spHash}`;

  const hit = (await TOOL_RESPONSE_CACHE.get(cacheKey)) as T | undefined;
  if (hit !== undefined) return hit;

  return TOOL_RESPONSE_SINGLEFLIGHT.do(cacheKey, async () => {
    // Re-check inside the single-flight leader so a near-simultaneous SET by a
    // sibling MCP process (via Redis) is not overwritten.
    const racy = (await TOOL_RESPONSE_CACHE.get(cacheKey)) as T | undefined;
    if (racy !== undefined) return racy;

    const resp =
      method === "get"
        ? await api.get(path, kyOpts)
        : await api.post(path, kyOpts);
    const body = (await resp.json()) as T;

    // Headers are present on real ky responses but may be absent in tests that
    // mock the verbs directly; treat missing headers as "no signal".
    const cc =
      typeof (resp as { headers?: { get(name: string): string | null } })
        .headers?.get === "function"
        ? (
            resp as { headers: { get(name: string): string | null } }
          ).headers.get("cache-control")
        : null;

    // Tri-state write decision (no fall-through to defaultTtlMs on a
    // private/no-store or unknown-but-not-allowlisted response):
    //   private/no-store -> never store
    //   public+max-age   -> store globally for max-age
    //   no signal        -> store under defaultTtlMs ONLY if path is allowlisted
    const directive = cacheControlDirective(cc);
    let ttlMs = 0;
    if (directive === "public") {
      ttlMs = maxAgeMs(cc) ?? 0;
    } else if (directive === "none" && isGlobalCacheablePath(path)) {
      ttlMs = defaultTtlMs ?? 0;
    }
    if (ttlMs > 0) {
      await TOOL_RESPONSE_CACHE.set(cacheKey, body, ttlMs);
    }
    return body;
  });
}
