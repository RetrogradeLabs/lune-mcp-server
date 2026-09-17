/**
 * Branch coverage for the tool-handler dispatch bodies.
 *
 * `tools.test.ts` covers the happy paths; this file targets the remaining
 * branches: the fuzzy conference-argument resolver (`match` / `ambiguous`
 * / `none` / unreachable-endpoint) and the `unknown tool` default arms
 * of every handler.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  callAt,
  callTo,
  createFakeKy,
  type FakeKy,
  jsonBodyOf,
  jsonReply,
  queryOf,
  searchParamsOf,
} from "../support/fake-ky.js";
import type { JsonValue } from "../../src/json.js";
import {
  jsonBoolean,
  jsonNumber,
  jsonObject,
  jsonObjects,
  jsonString,
  parseJsonObject,
} from "../support/json.js";
import { callPaperTool } from "../../src/tools/papers.js";
import { callGuidanceTool } from "../../src/tools/guidance.js";
import { LuneErrorCode } from "../../src/errors.js";
import { TOOL_RESPONSE_CACHE } from "../../src/cache.js";

beforeEach(async () => {
  await TOOL_RESPONSE_CACHE.clear();
});

/**
 * Route-aware ky double on top of the shared `createFakeKy` seam: dispatches
 * each verb+url to a registered body so one test can return a real conferences
 * list for the fuzzy resolver and a different body for the downstream call.
 */
type Routes = {
  get?: Record<string, JsonValue>;
  post?: Record<string, JsonValue>;
  getThrows?: Set<string>;
};

function routedKy(routes: Routes): FakeKy {
  return createFakeKy((call) => {
    if (call.method === "get" && routes.getThrows?.has(call.url)) {
      return {
        kind: "thrown",
        cause: new Error(`simulated failure for GET ${call.url}`),
      };
    }

    const table = call.method === "get" ? routes.get : routes.post;

    return jsonReply(table?.[call.url] ?? {});
  });
}

type PaperToolResult = Awaited<ReturnType<typeof callPaperTool>>;

function structuredContentOf(result: PaperToolResult) {
  const serialized = JSON.stringify(result.structuredContent);

  if (serialized === undefined) throw new Error("tool returned no structure");

  return parseJsonObject(serialized, "structured tool content");
}

function firstSearchHit(result: PaperToolResult) {
  const content = structuredContentOf(result);

  return jsonObject(
    jsonObjects(content.results, "results").at(0),
    "results[0]",
  );
}

const CONFERENCES = [
  { short_name: "NeurIPS", full_name: "Neural Information Processing Systems" },
  { short_name: "USENIX Security", full_name: "USENIX Security Symposium" },
  { short_name: "USENIX Privacy", full_name: "USENIX Privacy Conference" },
];

describe("resolveConferenceArg via search_papers", () => {
  it("canonicalises a fuzzy conference name to its short_name", async () => {
    const { ky, calls } = routedKy({
      get: { conferences: CONFERENCES },
      post: { search: { results: [] } },
    });

    await callPaperTool(ky, "search_papers", {
      query: "side channels",
      conference: "neurips",
    });
    const searchCall = callTo(calls, "search");
    expect(jsonBodyOf(searchCall).conference_short_name).toBe("NeurIPS");
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
    const searchCall = callTo(calls, "search");
    expect(jsonBodyOf(searchCall).conference_short_name).toBe(
      "totally-unknown-venue",
    );
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
    const searchCall = callTo(calls, "search");
    expect(jsonBodyOf(searchCall).conference_short_name).toBe("neurips");
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
    const searchCall = callTo(calls, "search");
    expect(jsonBodyOf(searchCall).conference_short_name).toBe("neurips");
  });
});

describe("resolveConferenceArg via get_conference_papers", () => {
  it("canonicalises the conference before fetching its papers", async () => {
    const { ky, calls } = routedKy({
      get: {
        conferences: CONFERENCES,
        "conferences/NeurIPS/papers": { papers: [] },
      },
    });

    await callPaperTool(ky, "get_conference_papers", { conference: "neurips" });
    expect(calls.some((c) => c.url === "conferences/NeurIPS/papers")).toBe(
      true,
    );
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

    const relatedCall = callTo(calls, "papers/seed-1/related");
    expect(relatedCall.method).toBe("get");
    expect(searchParamsOf(relatedCall)).toEqual({ limit: "2" });
    const sc = structuredContentOf(res);
    const papers = jsonObjects(sc.papers, "papers");
    expect(papers.map((paper) => jsonString(paper.paper_id))).toEqual([
      "n1",
      "n2",
    ]);
    const firstPaper = jsonObject(papers.at(0), "papers[0]");
    expect(firstPaper.abstract).toBe("Neighbor abstract");
    expect(jsonObjects(firstPaper.contexts, "papers[0].contexts")).toEqual([
      { section: "Methods", text: "nearest chunk", score: 0.8 },
    ]);
  });

  it("defaults limit to 6 when omitted", async () => {
    const { ky, calls } = routedKy({
      get: { "papers/seed-1/related": [] },
    });

    await callPaperTool(ky, "search_related_papers", { paper_id: "seed-1" });
    const relatedCall = callTo(calls, "papers/seed-1/related");
    expect(searchParamsOf(relatedCall)).toEqual({ limit: "6" });
  });
});

describe("Task 8: paging / sort / filter passthrough", () => {
  it("search_papers forwards sort_by, offset, year range onto the body", async () => {
    const { ky, calls } = routedKy({
      post: { search: { results: [], has_more: false } },
    });

    await callPaperTool(ky, "search_papers", {
      query: "graphs",
      limit: 5,
      offset: 10,
      sort_by: "citations",
      year_min: 2018,
      year_max: 2024,
    });
    const body = jsonBodyOf(callTo(calls, "search"));
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
    const body = jsonBodyOf(callTo(calls, "search"));
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
    const body = jsonBodyOf(callTo(calls, "search"));
    expect(body.venues).toEqual(["NeurIPS"]);
  });

  it("search_papers surfaces has_more from the response", async () => {
    const { ky } = routedKy({
      post: { search: { results: [], has_more: true } },
    });

    const res = await callPaperTool(ky, "search_papers", { query: "x" });
    expect(jsonBoolean(structuredContentOf(res).has_more, "has_more")).toBe(
      true,
    );
  });

  it("get_paper_citations forwards limit and offset as searchParams", async () => {
    const { ky, calls } = routedKy({});
    await callPaperTool(ky, "get_paper_citations", {
      paper_id: "p1",
      limit: 50,
      offset: 25,
    });
    expect(searchParamsOf(callAt(calls, 0))).toEqual({
      direction: "cited_by",
      limit: "50",
      offset: "25",
    });
  });

  it("get_paper_citations surfaces total and has_more from the response", async () => {
    const { ky } = routedKy({
      get: {
        "papers/p1/citations": {
          direction: "cited_by",
          papers: [],
          total: 42,
          has_more: true,
        },
      },
    });

    const res = await callPaperTool(ky, "get_paper_citations", {
      paper_id: "p1",
    });

    const sc = structuredContentOf(res);
    expect(jsonNumber(sc.total, "total")).toBe(42);
    expect(jsonBoolean(sc.has_more, "has_more")).toBe(true);
  });

  it("get_paper_fulltext forwards sections as repeated searchParams", async () => {
    const { ky, calls } = routedKy({});
    await callPaperTool(ky, "get_paper_fulltext", {
      paper_id: "p1",
      format: "json",
      sections: ["Methods", "Results"],
    });
    const sp = queryOf(callAt(calls, 0));
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
    const papersCall = callTo(calls, "conferences/NeurIPS/papers");
    expect(searchParamsOf(papersCall)).toMatchObject({ sort: "citations" });
  });
});

describe("unknown-tool default arms", () => {
  it("callPaperTool throws for an unknown paper tool name", async () => {
    const { ky } = routedKy({});
    await expect(callPaperTool(ky, "not_a_paper_tool", {})).rejects.toThrow(
      /unknown paper tool/,
    );
  });

  it("callGuidanceTool throws for an unknown guidance tool name", async () => {
    const { ky } = routedKy({});
    await expect(
      callGuidanceTool(ky, "not_a_guidance_tool", {}),
    ).rejects.toThrow(/unknown guidance tool/);
  });
});

describe("optional-argument default fallbacks", () => {
  it("search_papers forwards an explicit year onto the request body", async () => {
    const { ky, calls } = routedKy({ post: { search: { results: [] } } });
    await callPaperTool(ky, "search_papers", { query: "x", year: 2024 });
    const body = jsonBodyOf(callAt(calls, 0));
    expect(body.year).toBe(2024);
  });

  it("omits year (no default) but keeps the zod-defaulted limit when unset", async () => {
    // `year` is purely optional, so it is absent when unset; `limit` carries
    // `.default(10)`, which zod 4 materialises even under `.optional()`.
    const { ky, calls } = routedKy({ post: { search: { results: [] } } });
    await callPaperTool(ky, "search_papers", { query: "x" });
    const body = jsonBodyOf(callAt(calls, 0));
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
                {
                  section_name: "Results",
                  text: "a span",
                  score: 0.7,
                  chunk_id: "ch-1",
                },
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

    const hit = firstSearchHit(res);
    expect("contexts" in hit).toBe(true);
    expect(jsonObjects(hit.contexts, "contexts").at(0)).toMatchObject({
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
              matched_chunks: [
                { section_name: "Results", text: "a span", score: 0.7 },
              ],
            },
          ],
        },
      },
    });

    const res = await callPaperTool(ky, "search_papers", { query: "x" });
    const hit = firstSearchHit(res);
    expect("snippet" in hit).toBe(false);
    expect(jsonObjects(hit.contexts, "contexts").at(0)).toMatchObject({
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
              matched_chunks: [
                { section_name: "Results", text: "a span", score: 0.7 },
              ],
            },
          ],
        },
      },
    });

    const res = await callPaperTool(ky, "search_papers", {
      query: "x",
      detail: false,
    });

    const hit = firstSearchHit(res);
    expect(hit.snippet).toBe("a span");
    expect("contexts" in hit).toBe(false);
  });

  it("get_paper_fulltext defaults the format to markdown when omitted", async () => {
    const { ky, calls } = routedKy({});
    await callPaperTool(ky, "get_paper_fulltext", { paper_id: "p1" });
    // searchParams is a URLSearchParams (built from pairs so `sections` repeats).
    const sp = queryOf(callAt(calls, 0));
    expect(sp.get("format")).toBe("markdown");
    expect(sp.getAll("sections")).toEqual([]);
  });

  it("get_paper_citations defaults direction=cited_by, limit=25, offset=0 when omitted", async () => {
    const { ky, calls } = routedKy({});
    await callPaperTool(ky, "get_paper_citations", { paper_id: "p1" });
    expect(searchParamsOf(callAt(calls, 0))).toEqual({
      direction: "cited_by",
      limit: "25",
      offset: "0",
    });
  });

  it("get_conference_papers defaults limit=20, offset=0, sort=recency when omitted", async () => {
    const { ky, calls } = routedKy({
      get: {
        conferences: CONFERENCES,
        "conferences/NeurIPS/papers": { papers: [] },
      },
    });

    await callPaperTool(ky, "get_conference_papers", { conference: "neurips" });
    const papersCall = callTo(calls, "conferences/NeurIPS/papers");
    expect(searchParamsOf(papersCall)).toEqual({
      limit: "20",
      offset: "0",
      sort: "recency",
    });
  });

  it("search_research_guidance defaults limit=5 when omitted", async () => {
    const { ky, calls } = routedKy({
      post: { "research-guidance/search": { results: [] } },
    });

    await callGuidanceTool(ky, "search_research_guidance", {
      query: "ablation",
    });
    const body = jsonBodyOf(callAt(calls, 0));
    expect(body.limit).toBe(5);
  });
});
