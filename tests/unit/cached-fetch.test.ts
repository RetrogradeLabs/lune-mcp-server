/**
 * Unit coverage for the Cache-Control-aware fetch wrapper
 * (`src/api/cached-fetch.ts`).
 *
 * Pins: cache-key stability across searchParam shapes, the `Cache-Control`
 * parsing policy (only `public` + `max-age` is honoured; `private` /
 * `no-store` and missing headers are not), the cache-hit short-circuit,
 * and the single-flight racy-recheck path.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KyInstance } from "ky";
import { cachedJson } from "../../src/api/cached-fetch.js";
import { TOOL_RESPONSE_CACHE } from "../../src/cache.js";

beforeEach(async () => {
  await TOOL_RESPONSE_CACHE.clear();
});

/**
 * Build a ky double whose responses optionally carry a `headers.get`
 * accessor (real ky responses do; verb-level mocks may not).
 */
function fakeKy(opts: {
  body: unknown;
  cacheControl?: string | null;
  withHeaders?: boolean;
}): { ky: KyInstance; getCalls: number; postCalls: number } {
  let getCalls = 0;
  let postCalls = 0;
  const buildResp = () => {
    const resp: Record<string, unknown> = { json: async () => opts.body };
    if (opts.withHeaders !== false) {
      resp.headers = {
        get: (name: string) =>
          name.toLowerCase() === "cache-control"
            ? (opts.cacheControl ?? null)
            : null,
      };
    }
    return resp;
  };
  const ky = {
    get: () => {
      getCalls++;
      return buildResp() as unknown as Promise<unknown>;
    },
    post: () => {
      postCalls++;
      return buildResp() as unknown as Promise<unknown>;
    },
  } as unknown as KyInstance;
  return {
    ky,
    get getCalls() {
      return getCalls;
    },
    get postCalls() {
      return postCalls;
    },
  };
}

describe("cachedJson: HTTP dispatch", () => {
  it("issues a GET and returns the parsed body", async () => {
    const f = fakeKy({ body: { ok: 1 } });
    const r = await cachedJson(f.ky, "get", "papers/1");
    expect(r).toEqual({ ok: 1 });
    expect(f.getCalls).toBe(1);
  });

  it("issues a POST and returns the parsed body", async () => {
    const f = fakeKy({ body: { results: [] } });
    const r = await cachedJson(f.ky, "post", "search", { json: { query: "x" } });
    expect(r).toEqual({ results: [] });
    expect(f.postCalls).toBe(1);
  });
});

describe("cachedJson: Cache-Control policy", () => {
  it("caches and short-circuits on a public max-age response", async () => {
    const f = fakeKy({
      body: { v: 1 },
      cacheControl: "public, max-age=300",
    });
    await cachedJson(f.ky, "get", "conferences");
    // Second call must be served from cache: no second HTTP request.
    const second = await cachedJson(f.ky, "get", "conferences");
    expect(second).toEqual({ v: 1 });
    expect(f.getCalls).toBe(1);
  });

  it("does NOT cache when Cache-Control is private", async () => {
    const f = fakeKy({
      body: { v: 1 },
      cacheControl: "private, max-age=300",
    });
    await cachedJson(f.ky, "get", "account/me");
    await cachedJson(f.ky, "get", "account/me");
    expect(f.getCalls).toBe(2);
  });

  it("does NOT cache when Cache-Control is no-store", async () => {
    const f = fakeKy({ body: { v: 1 }, cacheControl: "no-store" });
    await cachedJson(f.ky, "get", "x");
    await cachedJson(f.ky, "get", "x");
    expect(f.getCalls).toBe(2);
  });

  it("does NOT cache when public is present but max-age is absent", async () => {
    const f = fakeKy({ body: { v: 1 }, cacheControl: "public" });
    await cachedJson(f.ky, "get", "x");
    await cachedJson(f.ky, "get", "x");
    expect(f.getCalls).toBe(2);
  });

  it("does NOT cache when max-age is present but public is not", async () => {
    const f = fakeKy({ body: { v: 1 }, cacheControl: "max-age=300" });
    await cachedJson(f.ky, "get", "x");
    await cachedJson(f.ky, "get", "x");
    expect(f.getCalls).toBe(2);
  });

  it("falls back to defaultTtlMs when there is no Cache-Control header", async () => {
    const f = fakeKy({ body: { v: 1 }, cacheControl: null });
    await cachedJson(f.ky, "get", "x", { defaultTtlMs: 60_000 });
    const second = await cachedJson(f.ky, "get", "x", { defaultTtlMs: 60_000 });
    expect(second).toEqual({ v: 1 });
    expect(f.getCalls).toBe(1);
  });

  it("falls back to defaultTtlMs when the response has no headers accessor", async () => {
    const f = fakeKy({ body: { v: 9 }, withHeaders: false });
    await cachedJson(f.ky, "get", "x", { defaultTtlMs: 60_000 });
    const second = await cachedJson(f.ky, "get", "x", { defaultTtlMs: 60_000 });
    expect(second).toEqual({ v: 9 });
    expect(f.getCalls).toBe(1);
  });

  it("does NOT cache when neither an upstream TTL nor a defaultTtlMs is given", async () => {
    const f = fakeKy({ body: { v: 1 }, cacheControl: null });
    await cachedJson(f.ky, "get", "x");
    await cachedJson(f.ky, "get", "x");
    expect(f.getCalls).toBe(2);
  });
});

describe("cachedJson: cache-key stability across searchParam shapes", () => {
  it("treats a plain object and the same object with reordered keys as one key", async () => {
    const f = fakeKy({ body: { v: 1 }, cacheControl: "public, max-age=300" });
    await cachedJson(f.ky, "get", "papers", { searchParams: { a: "1", b: "2" } });
    await cachedJson(f.ky, "get", "papers", { searchParams: { b: "2", a: "1" } });
    expect(f.getCalls).toBe(1);
  });

  it("hashes a string searchParams value", async () => {
    const f = fakeKy({ body: { v: 1 }, cacheControl: "public, max-age=300" });
    await cachedJson(f.ky, "get", "papers", { searchParams: "a=1&b=2" });
    await cachedJson(f.ky, "get", "papers", { searchParams: "a=1&b=2" });
    expect(f.getCalls).toBe(1);
  });

  it("hashes a URLSearchParams value with sorted entries", async () => {
    const f = fakeKy({ body: { v: 1 }, cacheControl: "public, max-age=300" });
    await cachedJson(f.ky, "get", "papers", {
      searchParams: new URLSearchParams([
        ["b", "2"],
        ["a", "1"],
      ]),
    });
    await cachedJson(f.ky, "get", "papers", {
      searchParams: new URLSearchParams([
        ["a", "1"],
        ["b", "2"],
      ]),
    });
    expect(f.getCalls).toBe(1);
  });

  it("incorporates keyExtra into the cache key", async () => {
    const f = fakeKy({ body: { v: 1 }, cacheControl: "public, max-age=300" });
    await cachedJson(f.ky, "get", "papers", { keyExtra: "tokenA" });
    // Different keyExtra → different key → a fresh HTTP call.
    await cachedJson(f.ky, "get", "papers", { keyExtra: "tokenB" });
    expect(f.getCalls).toBe(2);
  });
});

describe("cachedJson: single-flight racy recheck", () => {
  it("serves a sibling-populated entry found only on the in-flight recheck", async () => {
    // First `get` (the pre-single-flight probe) misses; the second `get`
    // (the racy recheck inside the single-flight leader) hits, simulating
    // a sibling MCP process having populated the shared cache in between.
    // The upstream verbs must never be touched.
    const getSpy = vi
      .spyOn(TOOL_RESPONSE_CACHE, "get")
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ fromSibling: true });
    let calls = 0;
    const ky = {
      get: () => {
        calls++;
        throw new Error("network should not be hit");
      },
      post: () => {
        throw new Error("unused");
      },
    } as unknown as KyInstance;
    const r = await cachedJson(ky, "get", "papers");
    expect(r).toEqual({ fromSibling: true });
    expect(calls).toBe(0);
    expect(getSpy).toHaveBeenCalledTimes(2);
    getSpy.mockRestore();
  });

  it("collapses concurrent identical lookups onto a single upstream call", async () => {
    let calls = 0;
    const ky = {
      get: () => {
        calls++;
        return {
          json: async () => {
            await new Promise((r) => setTimeout(r, 10));
            return { v: calls };
          },
          headers: { get: () => "public, max-age=300" },
        } as unknown as Promise<unknown>;
      },
      post: () => {
        throw new Error("unused");
      },
    } as unknown as KyInstance;
    const results = await Promise.all([
      cachedJson(ky, "get", "hot"),
      cachedJson(ky, "get", "hot"),
      cachedJson(ky, "get", "hot"),
    ]);
    expect(results).toEqual([{ v: 1 }, { v: 1 }, { v: 1 }]);
    expect(calls).toBe(1);
  });
});

// keep vi referenced for lint parity with the other tool tests
vi.fn();
