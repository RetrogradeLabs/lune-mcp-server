/**
 * Cache-Control–aware fetch wrapper for MCP tools.
 *
 * Wraps a `ky` request and consults the shared `TOOL_RESPONSE_CACHE` *before*
 * issuing the HTTP call. On a fresh response, parses the upstream
 * `Cache-Control` header to pick a TTL; refuses to store anything not
 * explicitly marked `public`, so auth-scoped data (no header, or `private` /
 * `no-store`) is never cached. This mirrors how HTTP intermediaries (browsers,
 * CDNs) decide cacheability, keeping the policy in one place.
 *
 * Cache key is `<METHOD> <path> <stable-hash(body|searchParams)>`. We do *not*
 * include the bearer token: the policy above guarantees we only ever store
 * responses the API has labelled as `public`, which by definition do not vary
 * by principal. If a tool ever needs to cache per-token (e.g. `account/me`),
 * thread the token hash in via the `keyExtra` parameter.
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

function parseMaxAgeMs(cacheControl: string | null): number | null {
  if (!cacheControl) return null;
  const isPublic = /\bpublic\b/i.test(cacheControl);
  const blocked = /\b(no-store|private)\b/i.test(cacheControl);
  if (!isPublic || blocked) return null;
  const match = cacheControl.match(/max-age=(\d+)/i);
  if (!match) return null;
  return Number.parseInt(match[1]!, 10) * 1000;
}

export async function cachedJson<T = unknown>(
  api: KyInstance,
  method: Method,
  path: string,
  opts: CachedFetchOptions = {},
): Promise<T> {
  const { keyExtra, defaultTtlMs, ...kyOpts } = opts;

  const bodyHash = JSON.stringify(kyOpts.json ?? null);
  const spHash = stableSearchParams(kyOpts.searchParams);
  const cacheKey = `${method.toUpperCase()} ${path} ${bodyHash} ${spHash} ${keyExtra ?? ""}`;

  const hit = (await TOOL_RESPONSE_CACHE.get(cacheKey)) as T | undefined;
  if (hit !== undefined) return hit;

  // Single-flight collapses concurrent identical lookups onto one upstream
  // call. With Redis backing, this is mostly a latency win; duplicate
  // calls would race to populate the same key but only one upstream fetch
  // is needed.
  return TOOL_RESPONSE_SINGLEFLIGHT.do(cacheKey, async () => {
    // Re-check inside the single-flight leader so a near-simultaneous
    // SET by a sibling MCP process (via Redis) is not overwritten.
    const racy = (await TOOL_RESPONSE_CACHE.get(cacheKey)) as T | undefined;
    if (racy !== undefined) return racy;

    const resp =
      method === "get" ? await api.get(path, kyOpts) : await api.post(path, kyOpts);
    const body = (await resp.json()) as T;

    // Headers are available on real ky responses but may be absent in tests
    // that mock the verbs directly. Treat missing headers as "no upstream
    // signal" and fall back to defaultTtlMs.
    const cc =
      typeof (resp as { headers?: { get(name: string): string | null } }).headers?.get ===
      "function"
        ? (resp as { headers: { get(name: string): string | null } }).headers.get(
            "cache-control",
          )
        : null;
    const upstreamTtlMs = parseMaxAgeMs(cc);
    const ttlMs = upstreamTtlMs ?? defaultTtlMs ?? 0;
    if (ttlMs > 0) {
      await TOOL_RESPONSE_CACHE.set(cacheKey, body, ttlMs);
    }
    return body;
  });
}
