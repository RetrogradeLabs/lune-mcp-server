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
import { createFakeKy, jsonReply } from "../support/fake-ky.js";
import type { FakeReply } from "../support/fake-ky.js";
import type { JsonValue } from "../../src/json.js";
import { cachedJson } from "../../src/api/cached-fetch.js";
import { TOOL_RESPONSE_CACHE } from "../../src/cache.js";

beforeEach(async () => {
  await TOOL_RESPONSE_CACHE.clear();
});

/** The body of the poisoned-entry test's `/search` response. */
type SearchBody = { results: string[] };

/** The reply modifiers `jsonReply` accepts, read off the seam so it cannot drift. */
type ReplyExtras = NonNullable<Parameters<typeof jsonReply>[1]>;

/** What a test reads back off a one-body ky double. */
interface FakeApi {
  ky: ReturnType<typeof createFakeKy>["ky"];
  readonly getCalls: number;
  readonly postCalls: number;
}

/**
 * A ky double answering every call with one body. `withHeaders: false` drops
 * the reply's `headers` member entirely, which is the "verb-level mock with no
 * headers" case `cached-fetch.ts`'s `hasHeaders` guard exists for; a `null`
 * `cacheControl` keeps the headers but leaves the directive absent.
 */
function fakeKy(opts: {
  body: JsonValue;
  cacheControl?: string | null;
  withHeaders?: boolean;
}): FakeApi {
  const extras: ReplyExtras = {};

  if (opts.cacheControl !== undefined && opts.cacheControl !== null) {
    extras.cacheControl = opts.cacheControl;
  }

  if (opts.withHeaders === false) extras.withoutHeaders = true;
  const reply: FakeReply = jsonReply(opts.body, extras);
  const { ky, calls } = createFakeKy(() => reply);

  return {
    ky,
    get getCalls() {
      return calls.filter((call) => call.method === "get").length;
    },
    get postCalls() {
      return calls.filter((call) => call.method === "post").length;
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

    const r = await cachedJson(f.ky, "post", "search", {
      json: { query: "x" },
    });

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

  it("caches an unmarked ALLOWLISTED path under defaultTtlMs when there is no Cache-Control header", async () => {
    const f = fakeKy({ body: { v: 1 }, cacheControl: null });
    await cachedJson(f.ky, "get", "conferences", { defaultTtlMs: 60_000 });

    const second = await cachedJson(f.ky, "get", "conferences", {
      defaultTtlMs: 60_000,
    });

    expect(second).toEqual({ v: 1 });
    expect(f.getCalls).toBe(1);
  });

  it("caches an unmarked ALLOWLISTED path under defaultTtlMs when the response has no headers accessor", async () => {
    const f = fakeKy({ body: { v: 9 }, withHeaders: false });
    await cachedJson(f.ky, "get", "conferences", { defaultTtlMs: 60_000 });

    const second = await cachedJson(f.ky, "get", "conferences", {
      defaultTtlMs: 60_000,
    });

    expect(second).toEqual({ v: 9 });
    expect(f.getCalls).toBe(1);
  });

  it("does NOT cache when neither an upstream TTL nor a defaultTtlMs is given", async () => {
    const f = fakeKy({ body: { v: 1 }, cacheControl: null });
    await cachedJson(f.ky, "get", "x");
    await cachedJson(f.ky, "get", "x");
    expect(f.getCalls).toBe(2);
  });

  it("does NOT cache an unmarked NON-allowlisted path", async () => {
    const f = fakeKy({ body: { v: 1 }, cacheControl: null });
    await cachedJson(f.ky, "get", "things", { defaultTtlMs: 60_000 });
    await cachedJson(f.ky, "get", "things", { defaultTtlMs: 60_000 });
    // No header + not on the allowlist => never stored, both calls hit upstream.
    expect(f.getCalls).toBe(2);
  });
});

describe("cachedJson: cache-key stability across searchParam shapes", () => {
  it("treats a plain object and the same object with reordered keys as one key", async () => {
    const f = fakeKy({ body: { v: 1 }, cacheControl: "public, max-age=300" });
    await cachedJson(f.ky, "get", "papers", {
      searchParams: { a: "1", b: "2" },
    });
    await cachedJson(f.ky, "get", "papers", {
      searchParams: { b: "2", a: "1" },
    });
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
});

describe("cachedJson: single-flight racy recheck", () => {
  it("serves a sibling-populated entry found only on the in-flight recheck", async () => {
    // First `get` (the pre-single-flight probe) misses; the second (the racy
    // recheck inside the leader) hits, as if a sibling process had filled it.
    const getSpy = vi
      .spyOn(TOOL_RESPONSE_CACHE, "get")
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ fromSibling: true });

    const { ky, calls } = createFakeKy(() => {
      throw new Error("network should not be hit");
    });

    const r = await cachedJson(ky, "get", "papers");
    expect(r).toEqual({ fromSibling: true });
    expect(calls).toHaveLength(0);
    expect(getSpy).toHaveBeenCalledTimes(2);
    getSpy.mockRestore();
  });

  it("collapses concurrent identical lookups onto a single upstream call", async () => {
    let calls = 0;

    // Every call is issued before any reply is read (the verb records
    // synchronously), so the three lookups genuinely overlap.
    const { ky } = createFakeKy(() => {
      calls++;

      return jsonReply({ v: calls }, { cacheControl: "public, max-age=300" });
    });

    const results = await Promise.all([
      cachedJson(ky, "get", "hot"),
      cachedJson(ky, "get", "hot"),
      cachedJson(ky, "get", "hot"),
    ]);

    expect(results).toEqual([{ v: 1 }, { v: 1 }, { v: 1 }]);
    expect(calls).toBe(1);
  });
});

describe("cachedJson: per-principal safety", () => {
  it("never stores a per-principal POST /search response, even if marked public", async () => {
    // Even a (wrong) public header must not cache search: it varies by the
    // caller's conference exclusions, and the cache key excludes the token.
    const f = fakeKy({
      body: { results: [] },
      cacheControl: "public, max-age=300",
    });

    await cachedJson(f.ky, "post", "search", {
      json: { query: "q" },
      defaultTtlMs: 60_000,
    });
    await cachedJson(f.ky, "post", "search", {
      json: { query: "q" },
      defaultTtlMs: 60_000,
    });
    expect(f.postCalls).toBe(2);
  });

  it("never stores a per-principal POST /search/batch response, even if marked public", async () => {
    // search/batch applies the caller's `excluded_conference_ids` like /search,
    // so a (wrong) public header must never populate the tokenless shared key.
    const f = fakeKy({
      body: {
        results: [],
        queries_run: 1,
        queries_failed: [],
        has_more: false,
      },
      cacheControl: "public, max-age=300",
    });

    await cachedJson(f.ky, "post", "search/batch", {
      json: { queries: ["q"] },
      defaultTtlMs: 60_000,
    });
    await cachedJson(f.ky, "post", "search/batch", {
      json: { queries: ["q"] },
      defaultTtlMs: 60_000,
    });
    expect(f.postCalls).toBe(2);
  });

  it("never stores a per-principal POST /claims/verify response, even if marked public", async () => {
    // claims/verify applies the caller's `excluded_conference_ids` to its
    // per-claim evidence search, so it is per-principal: two calls, two POSTs.
    const f = fakeKy({
      body: { verdicts: [], claims_processed: 1 },
      cacheControl: "public, max-age=300",
    });

    await cachedJson(f.ky, "post", "claims/verify", {
      json: { claims: ["q"] },
      defaultTtlMs: 60_000,
    });
    await cachedJson(f.ky, "post", "claims/verify", {
      json: { claims: ["q"] },
      defaultTtlMs: 60_000,
    });
    expect(f.postCalls).toBe(2);
  });

  it("never stores a per-principal POST /evidence/gather response, even if marked public", async () => {
    // evidence/gather applies the caller's `excluded_conference_ids` to its
    // per-query retrieval, so it is per-principal: two calls, two POSTs.
    const f = fakeKy({
      body: {
        requirements: [],
        evidence_spans: [],
        next_queries: [],
        stop_reason: "max_iterations",
        draft_support: null,
        queries_failed: [],
        iterations_run: 1,
        queries_run: 1,
        units_charged: 1,
      },
      cacheControl: "public, max-age=300",
    });

    await cachedJson(f.ky, "post", "evidence/gather", {
      json: { task: "t", queries: ["q"] },
      defaultTtlMs: 60_000,
    });
    await cachedJson(f.ky, "post", "evidence/gather", {
      json: { task: "t", queries: ["q"] },
      defaultTtlMs: 60_000,
    });
    expect(f.postCalls).toBe(2);
  });

  it("never stores a per-principal POST /papers/extract response, even if marked public", async () => {
    // extract_from_papers with source="workspace" resolves the caller's active
    // workspace, so it is per-active-workspace: two calls, two POSTs.
    const f = fakeKy({
      body: { rows: [], failures: [] },
      cacheControl: "public, max-age=300",
    });

    await cachedJson(f.ky, "post", "papers/extract", {
      json: {
        paper_ids: ["x"],
        fields: [],
        instruction: "i",
        source: "workspace",
      },
      defaultTtlMs: 60_000,
    });
    await cachedJson(f.ky, "post", "papers/extract", {
      json: {
        paper_ids: ["x"],
        fields: [],
        instruction: "i",
        source: "workspace",
      },
      defaultTtlMs: 60_000,
    });
    expect(f.postCalls).toBe(2);
  });

  it("does NOT single-flight-collapse concurrent /papers/extract calls", async () => {
    // The real cross-tenant leak: two principals sending an identical workspace
    // extract body must each hit upstream, not share one leader's extraction.
    let calls = 0;

    const { ky } = createFakeKy(() => {
      calls++;

      return jsonReply(
        { rows: [{ caller: calls }] },
        { cacheControl: "public, max-age=300" },
      );
    });

    const results = await Promise.all([
      cachedJson(ky, "post", "papers/extract", {
        json: {
          paper_ids: ["x"],
          fields: [],
          instruction: "i",
          source: "workspace",
        },
      }),
      cachedJson(ky, "post", "papers/extract", {
        json: {
          paper_ids: ["x"],
          fields: [],
          instruction: "i",
          source: "workspace",
        },
      }),
    ]);

    expect(calls).toBe(2);
    expect(results).toEqual([
      { rows: [{ caller: 1 }] },
      { rows: [{ caller: 2 }] },
    ]);
  });

  it("does NOT single-flight-collapse concurrent /evidence/gather calls", async () => {
    // The per-principal bypass must skip the in-flight single-flight too: two
    // principals would share one leader's exclusions. Contrast the GLOBAL test.
    let calls = 0;

    const { ky } = createFakeKy(() => {
      calls++;

      return jsonReply(
        { units_charged: calls },
        { cacheControl: "public, max-age=300" },
      );
    });

    const results = await Promise.all([
      cachedJson(ky, "post", "evidence/gather", {
        json: { task: "t", queries: ["q"] },
      }),
      cachedJson(ky, "post", "evidence/gather", {
        json: { task: "t", queries: ["q"] },
      }),
    ]);

    expect(calls).toBe(2);
    expect(results).toEqual([{ units_charged: 1 }, { units_charged: 2 }]);
  });

  it("never stores a research-guidance/search response (scope-gated + billable)", async () => {
    // research-guidance/search is principal-INVARIANT content on a scope-gated
    // (guidance:read) + billable route: storing it would bypass scope + meter.
    const f = fakeKy({ body: { results: [] }, cacheControl: null });
    await cachedJson(f.ky, "post", "research-guidance/search", {
      json: { query: "ablation design", limit: 5 },
      defaultTtlMs: 60_000,
    });
    await cachedJson(f.ky, "post", "research-guidance/search", {
      json: { query: "ablation design", limit: 5 },
      defaultTtlMs: 60_000,
    });
    expect(f.postCalls).toBe(2);
  });

  it("does NOT single-flight-collapse concurrent research-guidance/search calls", async () => {
    // Even concurrently, two callers issuing the same query must each reach the API
    // so each is scope-checked + metered (the leader-collapse would meter only one).
    let calls = 0;

    const { ky } = createFakeKy(() => {
      calls++;

      return jsonReply({ results: [{ caller: calls }] });
    });

    const results = await Promise.all([
      cachedJson(ky, "post", "research-guidance/search", {
        json: { query: "q", limit: 5 },
      }),
      cachedJson(ky, "post", "research-guidance/search", {
        json: { query: "q", limit: 5 },
      }),
    ]);

    expect(calls).toBe(2);
    expect(results).toEqual([
      { results: [{ caller: 1 }] },
      { results: [{ caller: 2 }] },
    ]);
  });

  it.each([
    "papers/abc/fulltext",
    "research-guidance/doc-1",
    "conferences/neurips/papers",
  ])(
    "does NOT single-flight-collapse concurrent scope-gated GET %s",
    async (path) => {
      // Stamped `private` (never STORED) but still single-flighted, so two
      // callers must each reach the API to be scope-checked and metered.
      let calls = 0;

      const { ky } = createFakeKy(() => {
        calls++;

        return jsonReply(
          { caller: calls },
          { cacheControl: "private, max-age=600" },
        );
      });

      const results = await Promise.all([
        cachedJson(ky, "get", path, { defaultTtlMs: 60_000 }),
        cachedJson(ky, "get", path, { defaultTtlMs: 60_000 }),
      ]);

      expect(calls).toBe(2);
      expect(results).toEqual([{ caller: 1 }, { caller: 2 }]);
    },
  );

  it("never stores citations or related (per-principal GETs)", async () => {
    const cit = fakeKy({
      body: { papers: [] },
      cacheControl: "private, max-age=120",
    });

    await cachedJson(cit.ky, "get", "papers/abc/citations", {
      defaultTtlMs: 60_000,
    });
    await cachedJson(cit.ky, "get", "papers/abc/citations", {
      defaultTtlMs: 60_000,
    });
    expect(cit.getCalls).toBe(2);

    const rel = fakeKy({ body: [], cacheControl: "private, max-age=120" });
    await cachedJson(rel.ky, "get", "papers/abc/related", {
      defaultTtlMs: 60_000,
    });
    await cachedJson(rel.ky, "get", "papers/abc/related", {
      defaultTtlMs: 60_000,
    });
    expect(rel.getCalls).toBe(2);
  });

  it("never SERVES a pre-existing (poisoned) entry for a per-principal path", async () => {
    // Seed the exact key cachedJson would compute, then confirm the
    // per-principal bypass skips it. Key: `METHOD path bodyHash spHash`.
    const cacheKey = `POST search ${JSON.stringify({ query: "q" })} `;
    await TOOL_RESPONSE_CACHE.set(cacheKey, { results: ["POISON"] }, 60_000);

    const f = fakeKy({
      body: { results: ["FRESH"] },
      cacheControl: "public, max-age=300",
    });

    const out = await cachedJson<SearchBody>(f.ky, "post", "search", {
      json: { query: "q" },
    });

    expect(out.results).toEqual(["FRESH"]);
    expect(f.postCalls).toBe(1);
  });
});
