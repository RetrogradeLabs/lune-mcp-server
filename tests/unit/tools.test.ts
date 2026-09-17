import type { JsonObject, JsonValue } from "../../src/json.js";
import { describe, it, expect, beforeEach } from "vitest";
import {
  createFakeKy,
  httpErrorReply,
  jsonBodyOf,
  jsonReply,
  queryRecordOf,
  searchParamsOf,
  timeoutOf,
  EMPTY_REPLY,
  type FakeReply,
} from "../support/fake-ky.js";
import { callPaperTool } from "../../src/tools/papers.js";
import { HEAVY_TOOL_TIMEOUT_MS } from "../../src/api/client.js";
import { callGuidanceTool } from "../../src/tools/guidance.js";
import { listToolsResponse } from "../../src/tools/index.js";
import { TOOL_RESPONSE_CACHE } from "../../src/cache.js";
import { toolText, wireJson } from "../support/tool-result.js";

/**
 * The payload shapes these tests read back. Annotated at the `JSON.parse` rather
 * than asserted onto the result, so the shape is the test's stated contract and
 * `wireJson` has already proved both channels agree.
 */
interface DetailPayload {
  results: Array<{ abstract: string; contexts: JsonObject[] }>;
}

interface ConcisePayload {
  results: JsonObject[];
}

interface ContextsPayload {
  results: Array<{ contexts: JsonValue[] }>;
}

// The tool cache is a module singleton, so tests would otherwise share state
// (a paper id cached as 200 short-circuits a 401 test using the same id).
beforeEach(async () => {
  await TOOL_RESPONSE_CACHE.clear();
});

/**
 * A stateful ky double over the shared `createFakeKy`: `setResponse` and
 * `setError` swap what every subsequent verb answers, which is how these tests
 * drive one handler through its success and its failure arm.
 */
function fakeKy() {
  let reply: FakeReply = EMPTY_REPLY;
  const { ky, calls } = createFakeKy(() => reply);

  return {
    ky,
    calls,
    setResponse(data: JsonValue) {
      reply = jsonReply(data);
    },
    setError(status: number, body: JsonValue = {}) {
      reply = httpErrorReply(status, body, { requestId: "req-test" });
    },
  };
}

describe("paper tools", () => {
  it("search_papers POSTs to /search with mapped body", async () => {
    const { ky, calls, setResponse } = fakeKy();
    setResponse({ results: [{ id: "p1" }] });

    const r = await callPaperTool(ky, "search_papers", {
      query: "transformer attention",
      conference: "NeurIPS",
      limit: 5,
    });

    // The fuzzy resolver does a `GET /conferences` first; the shared fake
    // answers every call, and a non-array body is treated as no candidates.
    const c = calls.find((x) => x.url === "search")!;
    expect(c.method).toBe("post");
    expect(jsonBodyOf(c)).toEqual({
      query: "transformer attention",
      conference_short_name: "NeurIPS",
      limit: 5,
      offset: 0,
      sort_by: "relevance",
    });

    // Search defaults to the enriched projection. This hit has no calibrated
    // `rerank_score`, so nothing to abstain on: best_score null, flag false.
    const expected = {
      results: [
        { paper_id: "p1", authors: [], citation_count: 0, contexts: [] },
      ],
      has_more: false,
      best_score: null,
      low_confidence: false,
    };

    expect(JSON.parse(r.content[0]!.text)).toEqual(expected);
    // MCP 2025-06-18: a tool with `outputSchema` MUST also surface the result
    // via `structuredContent` so clients validate instead of re-parsing text.
    expect(r.structuredContent).toEqual(expected);
  });

  it("get_paper_fulltext returns body text directly when format=markdown", async () => {
    const { ky, setResponse } = fakeKy();
    setResponse({ body: "# Title\n…" });
    const r = await callPaperTool(ky, "get_paper_fulltext", { paper_id: "p1" });
    expect(r.content[0]!.text).toBe("# Title\n…");
  });

  it("get_paper_fulltext returns JSON when format=json", async () => {
    const { ky, setResponse } = fakeKy();
    setResponse({ sections: [{ name: "intro", text: "..." }] });

    const r = await callPaperTool(ky, "get_paper_fulltext", {
      paper_id: "p1",
      format: "json",
    });

    expect(JSON.parse(r.content[0]!.text)).toEqual({
      sections: [{ name: "intro", text: "..." }],
    });
  });

  it("get_paper_citations passes direction param", async () => {
    const { ky, calls, setResponse } = fakeKy();
    setResponse({ citations: [] });
    await callPaperTool(ky, "get_paper_citations", {
      paper_id: "p1",
      direction: "cites",
    });
    expect(searchParamsOf(calls[0]!)).toEqual({
      direction: "cites",
      limit: "25",
      offset: "0",
    });
  });

  it("list_conferences omits category when not provided", async () => {
    const { ky, calls, setResponse } = fakeKy();
    setResponse([]);
    await callPaperTool(ky, "list_conferences", {});
    expect(queryRecordOf(calls[0]!)).toEqual({});
  });

  it("get_conference_papers includes year, limit, offset", async () => {
    const { ky, calls, setResponse } = fakeKy();
    setResponse({ papers: [] });
    await callPaperTool(ky, "get_conference_papers", {
      conference: "CCS",
      year: 2025,
      limit: 30,
    });
    // Skip past the fuzzy resolver's `GET /conferences` probe; the
    // assertion target is the actual conference-papers fetch.
    const c = calls.find((x) => x.url === "conferences/CCS/papers")!;
    expect(c).toBeDefined();
    expect(searchParamsOf(c)).toEqual({
      limit: "30",
      offset: "0",
      sort: "recency",
      year: "2025",
    });
  });

  it("keeps low-level handlers strict before the MCP boundary maps the error", async () => {
    // The category handler remains strict. registerAllTools owns the MCP
    // contract that converts this class of failure into an isError result.
    const { ky } = fakeKy();
    await expect(
      callPaperTool(ky, "search_papers", { query: "" }),
    ).rejects.toThrow();
  });

  it("surfaces a 401 from the API as an isError tool result (not a throw)", async () => {
    // Upstream API failures are Tool Execution Errors: the agent must see the
    // actionable message, so the handler returns isError instead of throwing.
    const { ky, setError } = fakeKy();
    setError(401, { detail: "expired" });

    const r = await callPaperTool(ky, "get_paper_citations", {
      paper_id: "p1",
    });

    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/unauthorized|rotate|lune login/i);
  });

  it("surfaces a 429 (L1 concurrency) as a retryable isError tool result", async () => {
    const { ky, setError } = fakeKy();
    setError(429, { error: "rate_limited", retry_after_seconds: 1 });

    const r = await callPaperTool(ky, "search_papers", {
      query: "diffusion guidance",
    });

    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/rate limited/i);
    expect(r.content[0]!.text).toContain("retry_after_seconds=1");
    // Must not be mistaken for a quota block: this one clears on its own.
    expect(r.content[0]!.text).toContain("burst guard");
  });

  it("surfaces a 402 (quota/credits exhausted) as an isError tool result with buy-credits guidance", async () => {
    const { ky, setError } = fakeKy();
    setError(402, {
      error: "out_of_credits",
      tier: "free",
      units_required: 1,
      daily_limit: 10,
      used_today: 10,
      remaining_today: 0,
      credits_remaining: 0,
      resets_at: "2026-08-16T00:00:00Z",
      upgrade_hint:
        "A higher plan raises the daily allowance: Pro 300/day, Max 600/day.",
      upgrade_url: "https://lune/dashboard/settings/billing",
      buy_credits_url: "https://lune/dashboard/settings/billing",
    });

    const r = await callPaperTool(ky, "search_papers", {
      query: "side channels",
    });

    expect(r.isError).toBe(true);
    const text = r.content[0]!.text;
    expect(text).toContain("Lune quota exhausted");
    expect(text).toContain("10/10 requests used in today's allowance");
    expect(text).toContain("resets at 2026-08-16T00:00:00Z");
    expect(text).toContain("Pro 300/day, Max 600/day");
    expect(text).toContain(
      "buy_credits_url=https://lune/dashboard/settings/billing",
    );
  });

  it("search_papers includes non-abstract contexts by default", async () => {
    const { ky, setResponse } = fakeKy();
    setResponse({
      results: [
        {
          id: "p1",
          title: "Foo",
          abstract: "We study training.",
          matched_chunks: [
            {
              section_name: "Abstract",
              text: "We study training.",
              score: 0.95,
            },
            { section_name: "Methods", text: "we trained", score: 0.9 },
          ],
        },
      ],
    });

    const r = await callPaperTool(ky, "search_papers", {
      query: "training tricks",
    });

    const parsed: DetailPayload = JSON.parse(toolText(r));
    expect(parsed.results[0]!.abstract).toBe("We study training.");
    expect(parsed.results[0]!.contexts).toEqual([
      { section: "Methods", text: "we trained", score: 0.9 },
    ]);
  });

  it("search_papers omits contexts when detail is false", async () => {
    const { ky, setResponse } = fakeKy();
    setResponse({
      results: [
        {
          id: "p1",
          title: "Foo",
          matched_chunks: [
            { section_name: "Methods", text: "we trained", score: 0.9 },
          ],
        },
      ],
    });

    const r = await callPaperTool(ky, "search_papers", {
      query: "training tricks",
      detail: false,
    });

    const parsed: ConcisePayload = JSON.parse(toolText(r));
    expect(parsed.results[0]!.snippet).toBe("we trained");
    expect("contexts" in parsed.results[0]!).toBe(false);
  });

  it("search_papers returns matched contexts when detail is true", async () => {
    const { ky, setResponse } = fakeKy();
    setResponse({
      results: [
        {
          id: "p1",
          title: "Foo",
          matched_chunks: [
            {
              section_name: "Methods",
              text: "we trained on 8 GPUs",
              score: 0.91,
            },
            { section_name: "", text: "", score: 0 }, // empty chunk dropped
          ],
        },
      ],
    });

    const r = await callPaperTool(ky, "search_papers", {
      query: "training setup",
      detail: true,
    });

    const parsed: ContextsPayload = JSON.parse(toolText(r));
    expect(parsed.results[0]!.contexts).toEqual([
      { section: "Methods", text: "we trained on 8 GPUs", score: 0.91 },
    ]);
    // structuredContent mirrors the text content for schema-validating clients.
    const sc: ContextsPayload = JSON.parse(wireJson(r));
    expect(sc.results[0]!.contexts).toHaveLength(1);
  });

  it("does NOT forward the detail flag to the API request body", async () => {
    // The API's SearchRequest is extra=forbid; `detail` is an MCP-side
    // projection knob, so it must never reach the upstream body.
    const { ky, calls, setResponse } = fakeKy();
    setResponse({ results: [] });
    await callPaperTool(ky, "search_papers", {
      query: "x",
      detail: true,
    });
    const c = calls.find((x) => x.url === "search")!;
    const body = jsonBodyOf(c);
    expect("detail" in body).toBe(false);
  });
});

describe("search_papers_many tool", () => {
  it("appears in tools/list with an object outputSchema", () => {
    const tool = listToolsResponse().tools.find(
      (t) => t.name === "search_papers_many",
    );

    expect(tool).toBeDefined();
    expect(tool!.outputSchema?.type).toBe("object");
  });

  it("POSTs to search/batch and surfaces matched_queries + envelope via structuredContent", async () => {
    const { ky, calls, setResponse } = fakeKy();
    setResponse({
      results: [
        {
          id: "p1",
          title: "Foo",
          abstract: "We study X.",
          matched_chunks: [
            { section_name: "Methods", text: "we trained", score: 0.9 },
          ],
          matched_queries: [
            { query: "x methods", rank: 1 },
            { query: "x training", rank: 3 },
          ],
        },
      ],
      queries_run: 2,
      queries_failed: [{ query: "x broken", reason: "boom" }],
      has_more: false,
    });

    const r = await callPaperTool(ky, "search_papers_many", {
      queries: ["x methods", "x training", "x broken"],
      limit: 5,
    });

    const c = calls.find((x) => x.url === "search/batch")!;
    expect(c.method).toBe("post");
    // `detail` is an MCP-side projection knob; the API body must omit it and
    // carry only `queries` + the shared filters + `limit`.
    expect(jsonBodyOf(c)).toEqual({
      queries: ["x methods", "x training", "x broken"],
      limit: 5,
    });

    // Enriched by default: the hit keeps its abstract + contexts AND its
    // matched_queries provenance; the envelope keeps run/failed/has_more.
    const expected = {
      results: [
        {
          paper_id: "p1",
          title: "Foo",
          authors: [],
          citation_count: 0,
          abstract: "We study X.",
          contexts: [{ section: "Methods", text: "we trained", score: 0.9 }],
          matched_queries: [
            { query: "x methods", rank: 1 },
            { query: "x training", rank: 3 },
          ],
        },
      ],
      queries_run: 2,
      queries_failed: [{ query: "x broken", reason: "boom" }],
      has_more: false,
    };

    expect(r.structuredContent).toEqual(expected);
    expect(JSON.parse(r.content[0]!.text)).toEqual(expected);
  });

  it("maps `conference` onto the wire `conference` body field (NOT conference_short_name)", async () => {
    // The batch request's actual field is `conference`; unlike single search
    // there is no rename. The fuzzy resolver canonicalises the name first.
    const { ky, calls, setResponse } = fakeKy();
    setResponse({
      results: [],
      queries_run: 1,
      queries_failed: [],
      has_more: false,
    });
    await callPaperTool(ky, "search_papers_many", {
      queries: ["x"],
      conference: "NeurIPS",
    });
    const c = calls.find((x) => x.url === "search/batch")!;
    const body = jsonBodyOf(c);
    expect(body.conference).toBe("NeurIPS");
    expect("conference_short_name" in body).toBe(false);
  });

  it("uses the concise shape when detail is false but always keeps matched_queries", async () => {
    const { ky, setResponse } = fakeKy();
    setResponse({
      results: [
        {
          id: "p1",
          title: "Foo",
          matched_chunks: [
            { section_name: "Methods", text: "we trained", score: 0.9 },
          ],
          matched_queries: [{ query: "x", rank: 1 }],
        },
      ],
      queries_run: 1,
      queries_failed: [],
      has_more: false,
    });

    const r = await callPaperTool(ky, "search_papers_many", {
      queries: ["x"],
      detail: false,
    });

    const many: ConcisePayload = JSON.parse(wireJson(r));
    const hit = many.results[0]!;
    expect(hit.snippet).toBe("we trained");
    expect("contexts" in hit).toBe(false);
    expect(hit.matched_queries).toEqual([{ query: "x", rank: 1 }]);
  });

  it("rejects an empty queries array via zod (thrown protocol error)", async () => {
    const { ky } = fakeKy();
    await expect(
      callPaperTool(ky, "search_papers_many", { queries: [] }),
    ).rejects.toThrow();
  });
});

describe("extract_from_papers tool", () => {
  it("appears in tools/list with an object outputSchema", () => {
    const tool = listToolsResponse().tools.find(
      (t) => t.name === "extract_from_papers",
    );

    expect(tool).toBeDefined();
    expect(tool!.outputSchema?.type).toBe("object");
  });

  it("POSTs the body to papers/extract and returns the envelope via structuredContent", async () => {
    const { ky, calls, setResponse } = fakeKy();

    const envelope = {
      rows: [
        {
          paper_id: "p1",
          fields: { dataset: "ImageNet", accuracy: 0.92 },
          truncated: true,
        },
      ],
      papers_processed: 2,
      papers_failed: [{ paper_id: "p2", reason: "no_fulltext" }],
    };

    setResponse(envelope);

    const r = await callPaperTool(ky, "extract_from_papers", {
      paper_ids: ["p1", "p2"],
      fields: [
        { name: "dataset", type: "string", description: "eval set" },
        { name: "accuracy", type: "number" },
      ],
      instruction: "Extract the dataset and accuracy.",
      sections: ["Results"],
    });

    const c = calls.find((x) => x.url === "papers/extract")!;
    expect(c.method).toBe("post");
    // The fields map 1:1 onto the API body (paper_ids, fields, instruction,
    // sections); there is no rename and no projection knob.
    expect(jsonBodyOf(c)).toEqual({
      paper_ids: ["p1", "p2"],
      fields: [
        { name: "dataset", type: "string", description: "eval set" },
        { name: "accuracy", type: "number" },
      ],
      instruction: "Extract the dataset and accuracy.",
      sections: ["Results"],
      source: "corpus",
    });
    // Rows are already compact, so the structured envelope passes straight
    // through (no slim projection).
    expect(r.structuredContent).toEqual(envelope);
    expect(JSON.parse(r.content[0]!.text)).toEqual(envelope);
  });

  it("omits sections from the body when not provided", async () => {
    const { ky, calls, setResponse } = fakeKy();
    setResponse({ rows: [], papers_processed: 1, papers_failed: [] });
    await callPaperTool(ky, "extract_from_papers", {
      paper_ids: ["p1"],
      fields: [{ name: "x", type: "string" }],
      instruction: "extract x",
    });
    const body = jsonBodyOf(calls.find((x) => x.url === "papers/extract")!);
    expect("sections" in body).toBe(false);
  });

  it("rejects 51 paper_ids via zod (thrown protocol error)", async () => {
    const { ky } = fakeKy();
    await expect(
      callPaperTool(ky, "extract_from_papers", {
        paper_ids: Array.from({ length: 51 }, (_, i) => `p${i}`),
        fields: [{ name: "x", type: "string" }],
        instruction: "extract x",
      }),
    ).rejects.toThrow();
  });

  it("rejects an unknown field type via zod (thrown protocol error)", async () => {
    const { ky } = fakeKy();
    await expect(
      callPaperTool(ky, "extract_from_papers", {
        paper_ids: ["p1"],
        fields: [{ name: "x", type: "integer" }],
        instruction: "extract x",
      }),
    ).rejects.toThrow();
  });
});

describe("verify_claims tool", () => {
  it("appears in tools/list with an object outputSchema", () => {
    const tool = listToolsResponse().tools.find(
      (t) => t.name === "verify_claims",
    );

    expect(tool).toBeDefined();
    expect(tool!.outputSchema?.type).toBe("object");
  });

  it("POSTs the body to claims/verify and returns the envelope via structuredContent", async () => {
    const { ky, calls, setResponse } = fakeKy();

    const envelope = {
      verdicts: [
        {
          claim: "Transformers scale to long sequences.",
          verdict: "supported",
          supporting_paper_ids: ["p1"],
          verbatim_quote: "self-attention handles long context",
          confidence: 0.8,
          reasoning: "Passage [1] substantiates the claim.",
        },
      ],
      claims_processed: 1,
    };

    setResponse(envelope);

    const r = await callPaperTool(ky, "verify_claims", {
      claims: ["Transformers scale to long sequences."],
      context: "Survey of sequence models.",
    });

    const c = calls.find((x) => x.url === "claims/verify")!;
    expect(c.method).toBe("post");
    // The fields map 1:1 onto the API body (claims, context, + shared filters);
    // there is no rename and no projection knob.
    expect(jsonBodyOf(c)).toEqual({
      claims: ["Transformers scale to long sequences."],
      context: "Survey of sequence models.",
      source: "corpus",
    });
    // The verdict envelope passes straight through (no slim projection).
    expect(r.structuredContent).toEqual(envelope);
    expect(JSON.parse(r.content[0]!.text)).toEqual(envelope);
  });

  it("maps `conference` onto the wire `conference` body field (NOT conference_short_name)", async () => {
    // Like search_papers_many, verify's field is `conference`: no rename.
    // The fuzzy resolver runs first (no list mocked, so the name passes).
    const { ky, calls, setResponse } = fakeKy();
    setResponse({ verdicts: [], claims_processed: 1 });
    await callPaperTool(ky, "verify_claims", {
      claims: ["x"],
      conference: "NeurIPS",
    });
    const c = calls.find((x) => x.url === "claims/verify")!;
    const body = jsonBodyOf(c);
    expect(body.conference).toBe("NeurIPS");
    expect("conference_short_name" in body).toBe(false);
  });

  it("omits context from the body when not provided", async () => {
    const { ky, calls, setResponse } = fakeKy();
    setResponse({ verdicts: [], claims_processed: 1 });
    await callPaperTool(ky, "verify_claims", { claims: ["x"] });
    const body = jsonBodyOf(calls.find((x) => x.url === "claims/verify")!);
    expect("context" in body).toBe(false);
    expect(body).toEqual({ claims: ["x"], source: "corpus" });
  });

  it("rejects 26 claims via zod (thrown protocol error)", async () => {
    const { ky } = fakeKy();
    await expect(
      callPaperTool(ky, "verify_claims", {
        claims: Array.from({ length: 26 }, (_, i) => `claim ${i}`),
      }),
    ).rejects.toThrow();
  });

  it("rejects an empty claims array via zod (thrown protocol error)", async () => {
    const { ky } = fakeKy();
    await expect(
      callPaperTool(ky, "verify_claims", { claims: [] }),
    ).rejects.toThrow();
  });
});

describe("guidance tools", () => {
  it("search_research_guidance POSTs query + limit", async () => {
    const { ky, calls, setResponse } = fakeKy();
    setResponse({ chunks: [] });
    await callGuidanceTool(ky, "search_research_guidance", {
      query: "ablation",
      limit: 3,
    });
    expect(calls[0]!.url).toBe("research-guidance/search");
    expect(jsonBodyOf(calls[0]!)).toEqual({
      query: "ablation",
      limit: 3,
    });
  });

  it("get_research_guidance_doc GETs by ID", async () => {
    const { ky, calls, setResponse } = fakeKy();
    setResponse({ id: "doc1", body: "..." });
    await callGuidanceTool(ky, "get_research_guidance_doc", { doc_id: "doc1" });
    expect(calls[0]!.url).toBe("research-guidance/doc1");
  });
});

describe("heavy tools get an elevated per-call timeout", () => {
  // These four fan out MULTIPLE server-side LLM + search calls and run past
  // the 30s default, so they pass HEAVY_TOOL_TIMEOUT_MS per call.
  const HEAVY: Array<[string, JsonValue, string]> = [
    ["search_papers_many", { queries: ["x"] }, "search/batch"],
    [
      "extract_from_papers",
      {
        paper_ids: ["p1"],
        fields: [{ name: "f", type: "string" }],
        instruction: "i",
      },
      "papers/extract",
    ],
    ["verify_claims", { claims: ["x"] }, "claims/verify"],
    ["gather_evidence", { task: "t", queries: ["q"] }, "evidence/gather"],
  ];

  it.each(HEAVY)(
    "%s forwards HEAVY_TOOL_TIMEOUT_MS to ky",
    async (tool, args, path) => {
      const { ky, calls, setResponse } = fakeKy();
      setResponse({
        results: [],
        rows: [],
        comparisons: [],
        verdicts: [],
        requirements: [],
        evidence_spans: [],
        next_queries: [],
        draft_support: null,
        stop_reason: "max_iterations",
        queries_run: 1,
        queries_failed: [],
        papers_processed: 0,
        papers_failed: [],
        iterations_run: 1,
        has_more: false,
      });
      await callPaperTool(ky, tool, args);
      const c = calls.find((x) => x.url === path)!;
      expect(timeoutOf(c)).toBe(HEAVY_TOOL_TIMEOUT_MS);
    },
  );

  it("light tools keep the default client timeout (no per-call override)", async () => {
    const { ky, calls, setResponse } = fakeKy();
    setResponse({ results: [] });
    await callPaperTool(ky, "search_papers", { query: "x" });
    const c = calls.find((x) => x.url === "search")!;
    expect(timeoutOf(c)).toBeUndefined();
  });
});
