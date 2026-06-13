/**
 * Cache-Control-aware fetch wrapper for MCP tools.
 *
 * Wraps a `ky` request and consults the shared `TOOL_RESPONSE_CACHE`. The
 * cache key is `<METHOD> <path> <stable-hash(body|searchParams)>` and does
 * NOT include the bearer token, so the wrapper enforces two layers of safety:
 *
 *   1. Per-principal paths (search, citations, related, subscriptions) bypass
 *      the cache entirely on BOTH read and write. Their responses vary by the
 *      caller (conference exclusions / identity), so a tokenless key could
 *      otherwise leak one principal's results to another.
 *   2. For everything else, a tri-state write decision: store only when the
 *      response is explicitly `public` (for its `max-age`), or when it carries
 *      no usable signal AND the path is on the principal-invariant allowlist
 *      (under `defaultTtlMs`). A `private` / `no-store` response, or an
 *      unmarked non-allowlisted path, is never stored (no `defaultTtlMs`
 *      fall-through).
 *
 * If a tool ever needs to cache per-token (e.g. `account/me`), thread the
 * token hash in via the `keyExtra` parameter.
 */

import type { KyInstance, Options as KyOptions } from "ky";

import { TOOL_RESPONSE_CACHE, TOOL_RESPONSE_SINGLEFLIGHT } from "../cache.js";

type Method = "get" | "post";

interface CachedFetchOptions extends KyOptions {
  /** Extra cache-key fragment, e.g. a token hash for per-principal caching. */
  keyExtra?: string;
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
    const sorted = Array.from(sp.entries()).sort(([a], [b]) => a.localeCompare(b));
    return new URLSearchParams(sorted).toString();
  }
  // Plain object: sort keys for stability.
  const entries = Object.entries(sp).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(entries);
}

// Paths whose response varies by the caller (conference exclusions / identity).
// They MUST bypass the shared cache on BOTH read and write: the cache key does
// not include the bearer token, so a stored entry would leak across principals.
// `subscriptions*` is belt-and-suspenders (those tools call ky directly today).
const PER_PRINCIPAL_PATHS: RegExp[] = [
  /^search$/,
  // Batch search applies the SAME caller `excluded_conference_ids` as /search,
  // so its results vary by principal and must bypass the tokenless shared key
  // for the same reason. (Today it also stores nothing: search sets no
  // Cache-Control and batch is not in GLOBAL_CACHEABLE_PATHS, so ttlMs=0. This
  // makes the per-principal guarantee correct-by-construction, not incidental.)
  /^search\/batch$/,
  // claims/verify applies the SAME caller `excluded_conference_ids` to the
  // per-claim evidence search, so its verdicts vary by principal and must
  // bypass the tokenless shared key for the same reason as /search/batch.
  // (It also stores nothing today: the route sets no Cache-Control and is not
  // in GLOBAL_CACHEABLE_PATHS, so ttlMs=0; this guard makes the per-principal
  // guarantee correct-by-construction, not incidental.)
  /^claims\/verify$/,
  // evidence/gather applies the SAME caller `excluded_conference_ids` to its
  // per-query retrieval, so its coverage / spans vary by principal. It MUST
  // bypass both the tokenless shared cache AND the in-flight single-flight: with
  // ttl 0 it stores nothing, but without this bypass two principals issuing an
  // identical body concurrently would collapse onto one leader's response (whose
  // exclusions are the leader's), leaking results across principals.
  /^evidence\/gather$/,
  /^papers\/[^/]+\/citations$/,
  /^papers\/[^/]+\/related$/,
  /^subscriptions(\/|$)/,
];

// Principal-invariant paths that are safe to cache GLOBALLY under `defaultTtlMs`
// when the API sends no usable `public` cache-control header. Anything not here
// and not explicitly `public` is not stored.
const GLOBAL_CACHEABLE_PATHS: RegExp[] = [
  /^conferences$/,
  /^conferences\/[^/]+\/papers$/,
  /^papers\/[^/]+$/,
  /^papers\/[^/]+\/fulltext$/,
  /^research-guidance\/search$/,
  /^research-guidance\/[^/]+$/,
];

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
  const { keyExtra, defaultTtlMs, ...kyOpts } = opts;

  // Per-principal paths bypass the shared cache entirely: no read, no
  // single-flight populate, no write. This is the primary correctness guard
  // and is independent of whatever Cache-Control the API sends.
  if (isPerPrincipalPath(path)) {
    const resp =
      method === "get" ? await api.get(path, kyOpts) : await api.post(path, kyOpts);
    return (await resp.json()) as T;
  }

  const bodyHash = JSON.stringify(kyOpts.json ?? null);
  const spHash = stableSearchParams(kyOpts.searchParams);
  const cacheKey = `${method.toUpperCase()} ${path} ${bodyHash} ${spHash} ${keyExtra ?? ""}`;

  const hit = (await TOOL_RESPONSE_CACHE.get(cacheKey)) as T | undefined;
  if (hit !== undefined) return hit;

  return TOOL_RESPONSE_SINGLEFLIGHT.do(cacheKey, async () => {
    // Re-check inside the single-flight leader so a near-simultaneous SET by a
    // sibling MCP process (via Redis) is not overwritten.
    const racy = (await TOOL_RESPONSE_CACHE.get(cacheKey)) as T | undefined;
    if (racy !== undefined) return racy;

    const resp =
      method === "get" ? await api.get(path, kyOpts) : await api.post(path, kyOpts);
    const body = (await resp.json()) as T;

    // Headers are present on real ky responses but may be absent in tests that
    // mock the verbs directly; treat missing headers as "no signal".
    const cc =
      typeof (resp as { headers?: { get(name: string): string | null } }).headers?.get ===
      "function"
        ? (resp as { headers: { get(name: string): string | null } }).headers.get(
            "cache-control",
          )
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
