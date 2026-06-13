/**
 * Branch coverage for the tool-handler dispatch bodies.
 *
 * `tools.test.ts` covers the happy paths; this file targets the remaining
 * branches: the fuzzy conference-argument resolver (`match` / `ambiguous`
 * / `none` / unreachable-endpoint), the optional-field assembly in
 * `subscribe_conference`, and the `unknown tool` default arms
 * of every handler.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { KyInstance } from "ky";
import { callPaperTool } from "../../src/tools/papers.js";
import { callGuidanceTool } from "../../src/tools/guidance.js";
import { callSubsTool } from "../../src/tools/subscriptions.js";
import { LuneErrorCode } from "../../src/errors.js";
import { TOOL_RESPONSE_CACHE } from "../../src/cache.js";

beforeEach(async () => {
  await TOOL_RESPONSE_CACHE.clear();
});

/**
 * Route-aware ky double: dispatches each verb+url to a registered handler
 * so a single test can return a real conferences list for the fuzzy
 * resolver and a different body for the downstream call.
 */
function routedKy(routes: {
  get?: Record<string, unknown>;
  post?: Record<string, unknown>;
  getThrows?: Set<string>;
}): {
  ky: KyInstance;
  calls: Array<{ method: string; url: string; opts?: unknown }>;
} {
  const calls: Array<{ method: string; url: string; opts?: unknown }> = [];
  const make =
    (method: "get" | "post" | "delete") => (url: string, opts?: unknown) => {
      calls.push({ method, url, opts });
      return {
        json: async () => {
          if (method === "get" && routes.getThrows?.has(url)) {
            throw new Error(`simulated failure for GET ${url}`);
          }
          const table = method === "get" ? routes.get : routes.post;
          return table?.[url] ?? {};
        },
      } as unknown as Promise<unknown>;
    };
  return {
    ky: {
      get: make("get"),
      post: make("post"),
      delete: make("delete"),
      put: make("get"),
    } as unknown as KyInstance,
    calls,
  };
}

const CONFERENCES = [
  { short_name: "NeurIPS", full_name: "Neural Information Processing Systems" },
  { short_name: "USENIX Security", full_name: "USENIX Security Symposium" },
  { short_name: "USENIX Privacy", full_name: "USENIX Privacy Conference" },
];

describe("_resolveConferenceArg via search_papers", () => {
  it("canonicalises a fuzzy conference name to its short_name", async () => {
    const { ky, calls } = routedKy({
      get: { conferences: CONFERENCES },
      post: { search: { results: [] } },
    });
    await callPaperTool(ky, "search_papers", {
      query: "side channels",
      conference: "neurips",
    });
    const searchCall = calls.find((c) => c.url === "search")!;
    expect(
      (searchCall.opts as { json: Record<string, unknown> }).json
        .conference_short_name,
    ).toBe("NeurIPS");
  });

  it("throws InvalidParams when the conference name is ambiguous", async () => {
    const { ky } = routedKy({
      get: { conferences: CONFERENCES },
      post: { search: { results: [] } },
    });
    await expect(
      callPaperTool(ky, "search_papers", {
        query: "x",
        conference: "usenix",
      }),
    ).rejects.toMatchObject({
      code: LuneErrorCode.InvalidParams,
    });
  });

  it("passes an unmatched conference name through unchanged", async () => {
    const { ky, calls } = routedKy({
      get: { conferences: CONFERENCES },
      post: { search: { results: [] } },
    });
    await callPaperTool(ky, "search_papers", {
      query: "x",
      conference: "totally-unknown-venue",
    });
    const searchCall = calls.find((c) => c.url === "search")!;
    expect(
      (searchCall.opts as { json: Record<string, unknown> }).json
        .conference_short_name,
    ).toBe("totally-unknown-venue");
  });

  it("passes the raw input through when the conferences endpoint is unreachable", async () => {
    const { ky, calls } = routedKy({
      getThrows: new Set(["conferences"]),
      post: { search: { results: [] } },
    });
    await callPaperTool(ky, "search_papers", {
      query: "x",
      conference: "neurips",
    });
    const searchCall = calls.find((c) => c.url === "search")!;
    expect(
      (searchCall.opts as { json: Record<string, unknown> }).json
        .conference_short_name,
    ).toBe("neurips");
  });

  it("passes the raw input through when the conferences endpoint returns a non-array", async () => {
    const { ky, calls } = routedKy({
      get: { conferences: { not: "an array" } },
      post: { search: { results: [] } },
    });
    await callPaperTool(ky, "search_papers", {
      query: "x",
      conference: "neurips",
    });
    const searchCall = calls.find((c) => c.url === "search")!;
    expect(
      (searchCall.opts as { json: Record<string, unknown> }).json
        .conference_short_name,
    ).toBe("neurips");
  });
});

describe("_resolveConferenceArg via get_conference_papers", () => {
  it("canonicalises the conference before fetching its papers", async () => {
    const { ky, calls } = routedKy({
      get: {
        conferences: CONFERENCES,
        "conferences/NeurIPS/papers": { papers: [] },
      },
    });
    await callPaperTool(ky, "get_conference_papers", { conference: "neurips" });
    expect(calls.some((c) => c.url === "conferences/NeurIPS/papers")).toBe(true);
  });
});

describe("subscribe_conference field assembly", () => {
  it("includes the email override on the request body when provided", async () => {
    const { ky, calls } = routedKy({ post: { subscriptions: { id: "s1" } } });
    await callSubsTool(ky, "subscribe_conference", {
      conference: "NeurIPS",
      email: "override@example.com",
    });
    const body = (calls[0]!.opts as { json: Record<string, unknown> }).json;
    expect(body.email).toBe("override@example.com");
  });

  it("omits the email field entirely when not provided", async () => {
    const { ky, calls } = routedKy({ post: { subscriptions: { id: "s1" } } });
    await callSubsTool(ky, "subscribe_conference", {
      conference: "NeurIPS",
    });
    const body = (calls[0]!.opts as { json: Record<string, unknown> }).json;
    expect("email" in body).toBe(false);
  });
});

describe("search_related_papers handler", () => {
  it("GETs papers/<id>/related with the limit and returns enriched related hits", async () => {
    const { ky, calls } = routedKy({
      get: {
        "papers/seed-1/related": [
          {
            id: "n1",
            abstract: "Neighbor abstract",
            matched_chunks: [
              { section_name: "Methods", text: "nearest chunk", score: 0.8 },
            ],
          },
          { id: "n2", matched_chunks: [] },
        ],
      },
    });
    const res = await callPaperTool(ky, "search_related_papers", {
      paper_id: "seed-1",
      limit: 2,
    });
    const relatedCall = calls.find((c) => c.url === "papers/seed-1/related")!;
    expect(relatedCall.method).toBe("get");
    expect(
      (relatedCall.opts as { searchParams: Record<string, unknown> }).searchParams,
    ).toEqual({ limit: 2 });
    const sc = res.structuredContent as {
      papers: Array<{ paper_id: string; abstract?: string; contexts: unknown[] }>;
    };
    expect(sc.papers.map((p) => p.paper_id)).toEqual(["n1", "n2"]);
    expect(sc.papers[0]!.abstract).toBe("Neighbor abstract");
    expect(sc.papers[0]!.contexts).toEqual([
      { section: "Methods", text: "nearest chunk", score: 0.8 },
    ]);
  });

  it("defaults limit to 6 when omitted", async () => {
    const { ky, calls } = routedKy({
      get: { "papers/seed-1/related": [] },
    });
    await callPaperTool(ky, "search_related_papers", { paper_id: "seed-1" });
    const relatedCall = calls.find((c) => c.url === "papers/seed-1/related")!;
    expect(
      (relatedCall.opts as { searchParams: Record<string, unknown> }).searchParams,
    ).toEqual({ limit: 6 });
  });
});

describe("Task 8: paging / sort / filter passthrough", () => {
  it("search_papers forwards sort_by, offset, year range onto the body", async () => {
    const { ky, calls } = routedKy({ post: { search: { results: [], has_more: false } } });
    await callPaperTool(ky, "search_papers", {
      query: "graphs",
      limit: 5,
      offset: 10,
      sort_by: "citations",
      year_min: 2018,
      year_max: 2024,
    });
    const body = (calls.find((c) => c.url === "search")!.opts as {
      json: Record<string, unknown>;
    }).json;
    expect(body).toMatchObject({
      query: "graphs",
      limit: 5,
      offset: 10,
      sort_by: "citations",
      year_min: 2018,
      year_max: 2024,
    });
  });

  it("search_papers defaults offset=0 and sort_by=relevance when omitted", async () => {
    const { ky, calls } = routedKy({ post: { search: { results: [] } } });
    await callPaperTool(ky, "search_papers", { query: "x" });
    const body = (calls.find((c) => c.url === "search")!.opts as {
      json: Record<string, unknown>;
    }).json;
    expect(body.offset).toBe(0);
    expect(body.sort_by).toBe("relevance");
  });

  it("search_papers canonicalises venues via the fuzzy resolver before sending", async () => {
    const { ky, calls } = routedKy({
      get: { conferences: CONFERENCES },
      post: { search: { results: [] } },
    });
    await callPaperTool(ky, "search_papers", {
      query: "x",
      venues: ["neurips"],
    });
    const body = (calls.find((c) => c.url === "search")!.opts as {
      json: Record<string, unknown>;
    }).json;
    expect(body.venues).toEqual(["NeurIPS"]);
  });

  it("search_papers surfaces has_more from the response", async () => {
    const { ky } = routedKy({ post: { search: { results: [], has_more: true } } });
    const res = await callPaperTool(ky, "search_papers", { query: "x" });
    expect((res.structuredContent as { has_more: boolean }).has_more).toBe(true);
  });

  it("get_paper_citations forwards limit and offset as searchParams", async () => {
    const { ky, calls } = routedKy({});
    await callPaperTool(ky, "get_paper_citations", {
      paper_id: "p1",
      limit: 50,
      offset: 25,
    });
    expect(
      (calls[0]!.opts as { searchParams: Record<string, unknown> }).searchParams,
    ).toEqual({ direction: "cited_by", limit: 50, offset: 25 });
  });

  it("get_paper_citations surfaces total and has_more from the response", async () => {
    const { ky } = routedKy({
      get: { "papers/p1/citations": { direction: "cited_by", papers: [], total: 42, has_more: true } },
    });
    const res = await callPaperTool(ky, "get_paper_citations", { paper_id: "p1" });
    const sc = res.structuredContent as { total?: number; has_more?: boolean };
    expect(sc.total).toBe(42);
    expect(sc.has_more).toBe(true);
  });

  it("get_paper_fulltext forwards sections as repeated searchParams", async () => {
    const { ky, calls } = routedKy({});
    await callPaperTool(ky, "get_paper_fulltext", {
      paper_id: "p1",
      format: "json",
      sections: ["Methods", "Results"],
    });
    const sp = (calls[0]!.opts as { searchParams: URLSearchParams }).searchParams;
    expect(sp.get("format")).toBe("json");
    expect(sp.getAll("sections")).toEqual(["Methods", "Results"]);
  });

  it("get_conference_papers forwards the sort enum", async () => {
    const { ky, calls } = routedKy({
      get: {
        conferences: CONFERENCES,
        "conferences/NeurIPS/papers": { papers: [] },
      },
    });
    await callPaperTool(ky, "get_conference_papers", {
      conference: "neurips",
      sort: "citations",
    });
    const papersCall = calls.find((c) => c.url === "conferences/NeurIPS/papers")!;
    expect(
      (papersCall.opts as { searchParams: Record<string, unknown> }).searchParams,
    ).toMatchObject({ sort: "citations" });
  });
});

describe("unknown-tool default arms", () => {
  it("callPaperTool throws for an unknown paper tool name", async () => {
    const { ky } = routedKy({});
    await expect(
      callPaperTool(ky, "not_a_paper_tool", {}),
    ).rejects.toThrow(/unknown paper tool/);
  });

  it("callGuidanceTool throws for an unknown guidance tool name", async () => {
    const { ky } = routedKy({});
    await expect(
      callGuidanceTool(ky, "not_a_guidance_tool", {}),
    ).rejects.toThrow(/unknown guidance tool/);
  });

  it("callSubsTool throws for an unknown subscription tool name", async () => {
    const { ky } = routedKy({});
    await expect(
      callSubsTool(ky, "not_a_subs_tool", {}),
    ).rejects.toThrow(/unknown subscription tool/);
  });
});

describe("optional-argument default fallbacks", () => {
  it("search_papers forwards an explicit year onto the request body", async () => {
    const { ky, calls } = routedKy({ post: { search: { results: [] } } });
    await callPaperTool(ky, "search_papers", { query: "x", year: 2024 });
    const body = (calls[0]!.opts as { json: Record<string, unknown> }).json;
    expect(body.year).toBe(2024);
  });

  it("omits year (no default) but keeps the zod-defaulted limit when unset", async () => {
    // `year` is purely optional → absent from the body when unset. `limit`
    // carries `.default(10)`, which zod 4 materialises even on an
    // `.optional()` field, so the tool forwards limit=10 explicitly.
    const { ky, calls } = routedKy({ post: { search: { results: [] } } });
    await callPaperTool(ky, "search_papers", { query: "x" });
    const body = (calls[0]!.opts as { json: Record<string, unknown> }).json;
    expect("year" in body).toBe(false);
    expect(body.limit).toBe(10);
  });

  it("emits the matched contexts on a hit when detail is true", async () => {
    const { ky } = routedKy({
      post: {
        search: {
          results: [
            {
              id: "p1",
              title: "T",
              matched_chunks: [
                { section_name: "Results", text: "a span", score: 0.7, chunk_id: "ch-1" },
              ],
            },
          ],
        },
      },
    });
    // detail: true keeps the enriched output: the hit carries `contexts`.
    const res = await callPaperTool(ky, "search_papers", {
      query: "x",
      detail: true,
    });
    const hit = (
      res.structuredContent as { results: Array<Record<string, unknown>> }
    ).results[0]!;
    expect("contexts" in hit).toBe(true);
    expect((hit.contexts as Array<Record<string, unknown>>)[0]).toMatchObject({
      section: "Results",
      text: "a span",
      chunk_id: "ch-1",
    });
    expect("snippet" in hit).toBe(false);
  });

  it("defaults search hits to the enriched shape when no flag is set", async () => {
    const { ky } = routedKy({
      post: {
        search: {
          results: [
            {
              id: "p1",
              title: "T",
              matched_chunks: [{ section_name: "Results", text: "a span", score: 0.7 }],
            },
          ],
        },
      },
    });
    const res = await callPaperTool(ky, "search_papers", { query: "x" });
    const hit = (
      res.structuredContent as { results: Array<Record<string, unknown>> }
    ).results[0]!;
    expect("snippet" in hit).toBe(false);
    expect((hit.contexts as Array<Record<string, unknown>>)[0]).toMatchObject({
      section: "Results",
      text: "a span",
    });
  });

  it("search hits use the concise shape when detail is false", async () => {
    const { ky } = routedKy({
      post: {
        search: {
          results: [
            {
              id: "p1",
              title: "T",
              matched_chunks: [{ section_name: "Results", text: "a span", score: 0.7 }],
            },
          ],
        },
      },
    });
    const res = await callPaperTool(ky, "search_papers", { query: "x", detail: false });
    const hit = (
      res.structuredContent as { results: Array<Record<string, unknown>> }
    ).results[0]!;
    expect(hit.snippet).toBe("a span");
    expect("contexts" in hit).toBe(false);
  });

  it("get_paper_fulltext defaults the format to markdown when omitted", async () => {
    const { ky, calls } = routedKy({});
    await callPaperTool(ky, "get_paper_fulltext", { paper_id: "p1" });
    // searchParams is a URLSearchParams (built from pairs so `sections` repeats).
    const sp = (calls[0]!.opts as { searchParams: URLSearchParams }).searchParams;
    expect(sp.get("format")).toBe("markdown");
    expect(sp.getAll("sections")).toEqual([]);
  });

  it("get_paper_citations defaults direction=cited_by, limit=25, offset=0 when omitted", async () => {
    const { ky, calls } = routedKy({});
    await callPaperTool(ky, "get_paper_citations", { paper_id: "p1" });
    expect(
      (calls[0]!.opts as { searchParams: Record<string, unknown> }).searchParams,
    ).toEqual({ direction: "cited_by", limit: 25, offset: 0 });
  });

  it("get_conference_papers defaults limit=20, offset=0, sort=recency when omitted", async () => {
    const { ky, calls } = routedKy({
      get: {
        conferences: CONFERENCES,
        "conferences/NeurIPS/papers": { papers: [] },
      },
    });
    await callPaperTool(ky, "get_conference_papers", { conference: "neurips" });
    const papersCall = calls.find((c) => c.url === "conferences/NeurIPS/papers")!;
    expect(
      (papersCall.opts as { searchParams: Record<string, unknown> }).searchParams,
    ).toEqual({ limit: 20, offset: 0, sort: "recency" });
  });

  it("search_research_guidance defaults limit=5 when omitted", async () => {
    const { ky, calls } = routedKy({
      post: { "research-guidance/search": { results: [] } },
    });
    await callGuidanceTool(ky, "search_research_guidance", { query: "ablation" });
    const body = (calls[0]!.opts as { json: Record<string, unknown> }).json;
    expect(body.limit).toBe(5);
  });

  it("get_subscription_updates defaults limit=20 and omits since when no cursor", async () => {
    const { ky, calls } = routedKy({});
    await callSubsTool(ky, "get_subscription_updates", {});
    expect(calls[0]!.url).toBe("subscriptions/updates");
    const sp = (calls[0]!.opts as { searchParams: Record<string, unknown> })
      .searchParams;
    expect(sp).toEqual({ limit: 20 });
  });

  it("list_subscriptions tolerates undefined args", async () => {
    const { ky, calls } = routedKy({ get: { subscriptions: [] } });
    // The handler does `Empty.parse(args ?? {})`; passing `undefined`
    // exercises the `?? {}` fallback.
    await callSubsTool(
      ky,
      "list_subscriptions",
      undefined as unknown as Record<string, unknown>,
    );
    expect(calls[0]!.url).toBe("subscriptions");
  });
});
