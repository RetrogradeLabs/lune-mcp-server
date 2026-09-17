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
import { stableJson, type JsonValue } from "../json.js";

type Method = "get" | "post";

interface CachedFetchOptions extends KyOptions {
  /** Narrowed from ky's `unknown` so the cache key can be derived without an assertion. */
  json?: JsonValue;
  /**
   * TTL (ms) used when the response has no usable `Cache-Control: max-age=…`.
   * Set to 0 (default) to refuse caching when the API doesn't say it's safe.
   */
  defaultTtlMs?: number;
}

/** ky accepts a pre-serialized query string as well as a record or a
 *  URLSearchParams, and a string is already stable. */
function isRawQuery(sp: KyOptions["searchParams"]): sp is string {
  return typeof sp === "string";
}

/**
 * A ky response carries headers; a test that mocks the verbs directly may not.
 * Missing headers read as "no cache signal" rather than as an error.
 */
type MaybeHeaders = { headers?: { get?: (name: string) => string | null } };

function hasHeaders(
  resp: MaybeHeaders,
): resp is { headers: { get(name: string): string | null } } {
  return typeof resp.headers?.get === "function";
}

function stableSearchParams(sp: KyOptions["searchParams"]): string {
  if (sp === undefined || sp === null) return "";

  if (isRawQuery(sp)) return sp;

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

/**
 * Paths that MUST bypass the shared cache on BOTH read and write AND the
 * single-flight collapse. Two reasons put a path here:
 *
 *   Per-principal content. The cache key carries no bearer token, so a stored
 *   entry leaks across principals, and even at ttl 0 two callers with an
 *   identical body would share one leader's response: its conference
 *   exclusions, its active workspace, its private documents.
 *
 *   Scope-gated and billable content. The body may be principal-INVARIANT (a
 *   global corpus), but stamping it `private` only stops the STORE. The
 *   tokenless single-flight still lets a caller lacking the scope, or over
 *   quota, attach to an authorized leader's in-flight promise and be served
 *   the paid result with no API call, and no meter, of its own.
 */
const PER_PRINCIPAL_PATHS: RegExp[] = [
  /^search$/,
  // Per-principal like /search (caller `excluded_conference_ids`): bypass the
  // tokenless shared key so results can't leak across principals.
  /^search\/batch$/,
  // Per-principal like /search/batch: per-claim evidence search uses the caller's
  // excluded_conference_ids, so verdicts vary by principal.
  /^claims\/verify$/,
  // Per-principal, and the single-flight matters even at ttl 0: two callers
  // with an identical body must not collapse onto one leader's exclusions.
  /^evidence\/gather$/,
  // Per-ACTIVE-WORKSPACE: the workspace is resolved from the caller's bearer
  // credential, so sharing hands one user another's private documents.
  /^workspaces\/search$/,
  // Per-active-workspace like workspaces/search: one document's full text.
  /^workspaces\/document$/,
  // source="workspace" resolves the caller's active workspace server-side, so
  // one caller's extraction, and its meter, must never be shared.
  /^papers\/extract$/,
  // Search POST and /{doc_id} GET: the content is global, but both routes
  // are scope-gated (`guidance:read` + forbid_session) and billable.
  /^research-guidance\/[^/]+$/,
  /* Per-principal like /search: figure retrieval applies the caller's
     `excluded_conference_ids`, so a shared leader hands a second caller results
     filtered for an org they are not in, unmetered. */
  /^figures\/search$/,
  // Scope-gated, billable GETs. They are stamped `private`, so the store was
  // never the problem; the single-flight was.
  /^papers\/[^/]+\/fulltext$/,
  /^papers\/[^/]+\/figures$/,
  /^conferences\/[^/]+\/papers$/,
  /^papers\/[^/]+\/citations$/,
  /^papers\/[^/]+\/related$/,
];

// Only anonymous routes may share cache and single-flight globally; auth-gated
// paths or 402 errors can leak a leader's scope or quota state.
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

export async function cachedJson<T extends JsonValue = JsonValue>(
  api: KyInstance,
  method: Method,
  path: string,
  opts: CachedFetchOptions = {},
): Promise<T> {
  const { defaultTtlMs, ...kyOpts } = opts;

  // Per-principal paths bypass the cache entirely (no read, no single-flight,
  // no write). The primary guard, independent of the API's Cache-Control.
  if (isPerPrincipalPath(path)) {
    const resp =
      method === "get"
        ? await api.get(path, kyOpts)
        : await api.post(path, kyOpts);

    const direct: T = await resp.json();

    return direct;
  }

  const bodyHash = stableJson(kyOpts.json);
  const spHash = stableSearchParams(kyOpts.searchParams);
  const cacheKey = `${method.toUpperCase()} ${path} ${bodyHash} ${spHash}`;

  const cached = await TOOL_RESPONSE_CACHE.get(cacheKey);

  if (cached !== undefined) {
    // SAFETY: this key includes method, path, body, and query; its sole writer
    // stores the same T that this request reads.
    return cached as T;
  }

  return TOOL_RESPONSE_SINGLEFLIGHT.do(cacheKey, async () => {
    // Re-check inside the single-flight leader so a near-simultaneous SET by a
    // sibling MCP process (via Redis) is not overwritten.
    const racy = await TOOL_RESPONSE_CACHE.get(cacheKey);

    if (racy !== undefined) {
      // SAFETY: same key, same single writer as the read above.
      return racy as T;
    }

    const resp =
      method === "get"
        ? await api.get(path, kyOpts)
        : await api.post(path, kyOpts);

    const body: T = await resp.json();

    // Headers are present on real ky responses but may be absent in tests that
    // mock the verbs directly; treat missing headers as "no signal".
    const cc = hasHeaders(resp) ? resp.headers.get("cache-control") : null;

    // Tri-state, with no fall-through to defaultTtlMs: private/no-store never
    // stores; public stores for max-age; no signal only if path-allowlisted.
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
