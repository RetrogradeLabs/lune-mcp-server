import { describe, it, expect, vi, beforeEach } from "vitest";
import type { KyInstance } from "ky";
import { callPaperTool } from "../../src/tools/papers.js";
import { callGuidanceTool } from "../../src/tools/guidance.js";
import { callSubsTool } from "../../src/tools/subscriptions.js";
import { listToolsResponse } from "../../src/tools/index.js";
import { TOOL_RESPONSE_CACHE } from "../../src/cache.js";

// The tool cache is module-singleton, so tests would otherwise share state
// (a paper-id cached as 200 in one test would short-circuit a 401 test using
// the same id). Reset before each test to keep them independent.
beforeEach(async () => {
  await TOOL_RESPONSE_CACHE.clear();
});

/** Build a fake KyInstance whose verbs return a thenable {json} matcher. */
function fakeKy(): {
  ky: KyInstance;
  calls: Array<{ method: string; url: string; opts?: unknown }>;
  setResponse: (data: unknown) => void;
  setError: (status: number, body?: unknown) => void;
} {
  const calls: Array<{ method: string; url: string; opts?: unknown }> = [];
  let response: unknown = {};
  let errorStatus: number | null = null;
  let errorBody: unknown = {};

  const make = (method: string) => (url: string, opts?: unknown) => {
    calls.push({ method, url, opts });
    return {
      json: async () => {
        if (errorStatus !== null) {
          throw {
            response: {
              status: errorStatus,
              headers: new Headers({ "x-request-id": "req-test" }),
              json: async () => errorBody,
            },
          };
        }
        return response;
      },
    } as unknown as Promise<unknown>;
  };

  const ky = {
    get: make("GET"),
    post: make("POST"),
    delete: make("DELETE"),
    put: make("PUT"),
  } as unknown as KyInstance;

  return {
    ky,
    calls,
    setResponse: (data) => {
      response = data;
      errorStatus = null;
    },
    setError: (status, body = {}) => {
      errorStatus = status;
      errorBody = body;
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
    // The fuzzy resolver does a `GET /conferences` lookup before issuing
    // the search. The shared fake returns the same response for every
    // call; the resolver gracefully treats a non-array body as
    // "no candidates" and passes the input through unchanged.
    const c = calls.find((x) => x.url === "search")!;
    expect(c.method).toBe("POST");
    expect((c.opts as { json: Record<string, unknown> }).json).toEqual({
      query: "transformer attention",
      conference_short_name: "NeurIPS",
      limit: 5,
      offset: 0,
      sort_by: "relevance",
    });
    // Search defaults to the enriched projection: `id` -> `paper_id`, default
    // `authors: []` + `citation_count: 0`, and a predictable `contexts: []`
    // even when no chunk matched. The envelope carries `best_score` +
    // `low_confidence`; this hit has no calibrated `rerank_score`, so there is
    // no basis to abstain: best_score is null and low_confidence is false.
    const expected = {
      results: [{ paper_id: "p1", authors: [], citation_count: 0, contexts: [] }],
      has_more: false,
      best_score: null,
      low_confidence: false,
    };
    expect(JSON.parse(r.content[0]!.text)).toEqual(expected);
    // MCP 2025-06-18: tools with `outputSchema` MUST also surface the
    // result via `structuredContent` so clients can validate against the
    // declared schema instead of re-parsing the text content.
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
    const r = await callPaperTool(ky, "get_paper_fulltext", { paper_id: "p1", format: "json" });
    expect(JSON.parse(r.content[0]!.text)).toEqual({ sections: [{ name: "intro", text: "..." }] });
  });

  it("get_paper_citations passes direction param", async () => {
    const { ky, calls, setResponse } = fakeKy();
    setResponse({ citations: [] });
    await callPaperTool(ky, "get_paper_citations", { paper_id: "p1", direction: "cites" });
    expect((calls[0]!.opts as { searchParams: Record<string, unknown> }).searchParams).toEqual({
      direction: "cites",
      limit: 25,
      offset: 0,
    });
  });

  it("list_conferences omits category when not provided", async () => {
    const { ky, calls, setResponse } = fakeKy();
    setResponse([]);
    await callPaperTool(ky, "list_conferences", {});
    expect((calls[0]!.opts as { searchParams: Record<string, unknown> }).searchParams).toEqual({});
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
    expect((c.opts as { searchParams: Record<string, unknown> }).searchParams).toEqual({
      limit: 30,
      offset: 0,
      sort: "recency",
      year: 2025,
    });
  });

  it("rejects invalid input via zod (stays a thrown protocol error)", async () => {
    // Malformed input is a Protocol Error per the MCP spec: the zod parse
    // throws before any API call, so it propagates as a JSON-RPC error
    // rather than an isError tool result.
    const { ky } = fakeKy();
    await expect(callPaperTool(ky, "search_papers", { query: "" })).rejects.toThrow();
  });

  it("surfaces a 401 from the API as an isError tool result (not a throw)", async () => {
    // Upstream API failures are Tool Execution Errors: the agent must see the
    // actionable message in-context, so the handler returns isError instead
    // of throwing a JSON-RPC protocol error the client would discard.
    const { ky, setError } = fakeKy();
    setError(401, { detail: "expired" });
    const r = await callPaperTool(ky, "get_paper_citations", { paper_id: "p1" });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/unauthorized|rotate|lune login/i);
  });

  it("surfaces a 429 (L1 concurrency) as a retryable isError tool result", async () => {
    const { ky, setError } = fakeKy();
    setError(429, { error: "rate_limited", retry_after_seconds: 1 });
    const r = await callPaperTool(ky, "search_papers", { query: "diffusion guidance" });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/rate limited/i);
    expect(r.content[0]!.text).toContain("retry_after_seconds=1");
  });

  it("surfaces a 402 (quota/credits exhausted) as an isError tool result with buy-credits guidance", async () => {
    const { ky, setError } = fakeKy();
    setError(402, {
      error: "out_of_credits",
      buy_credits_url: "https://lune/dashboard/settings/billing",
    });
    const r = await callPaperTool(ky, "search_papers", { query: "side channels" });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("Quota exhausted");
    expect(r.content[0]!.text).toContain("buy_credits_url=https://lune/dashboard/settings/billing");
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
            { section_name: "Abstract", text: "We study training.", score: 0.95 },
            { section_name: "Methods", text: "we trained", score: 0.9 },
          ],
        },
      ],
    });
    const r = await callPaperTool(ky, "search_papers", { query: "training tricks" });
    const parsed = JSON.parse(r.content[0]!.text) as {
      results: Array<{ abstract: string; contexts: Array<Record<string, unknown>> }>;
    };
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
          matched_chunks: [{ section_name: "Methods", text: "we trained", score: 0.9 }],
        },
      ],
    });
    const r = await callPaperTool(ky, "search_papers", {
      query: "training tricks",
      detail: false,
    });
    const parsed = JSON.parse(r.content[0]!.text) as {
      results: Array<Record<string, unknown>>;
    };
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
            { section_name: "Methods", text: "we trained on 8 GPUs", score: 0.91 },
            { section_name: "", text: "", score: 0 }, // empty chunk dropped
          ],
        },
      ],
    });
    const r = await callPaperTool(ky, "search_papers", {
      query: "training setup",
      detail: true,
    });
    const parsed = JSON.parse(r.content[0]!.text) as {
      results: Array<{ contexts: Array<Record<string, unknown>> }>;
    };
    expect(parsed.results[0]!.contexts).toEqual([
      { section: "Methods", text: "we trained on 8 GPUs", score: 0.91 },
    ]);
    // structuredContent mirrors the text content for schema-validating clients.
    const sc = r.structuredContent as { results: Array<{ contexts: unknown[] }> };
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
    const body = (c.opts as { json: Record<string, unknown> }).json;
    expect("detail" in body).toBe(false);
  });
});

describe("search_papers_many tool", () => {
  it("appears in tools/list with an object outputSchema", () => {
    const tool = listToolsResponse().tools.find(
      (t) => t.name === "search_papers_many",
    ) as { outputSchema?: { type?: string } } | undefined;
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
          matched_chunks: [{ section_name: "Methods", text: "we trained", score: 0.9 }],
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
    expect(c.method).toBe("POST");
    // `detail` is an MCP-side projection knob; the API body must omit it and
    // carry only `queries` + the shared filters + `limit`.
    expect((c.opts as { json: Record<string, unknown> }).json).toEqual({
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
    setResponse({ results: [], queries_run: 1, queries_failed: [], has_more: false });
    await callPaperTool(ky, "search_papers_many", {
      queries: ["x"],
      conference: "NeurIPS",
    });
    const c = calls.find((x) => x.url === "search/batch")!;
    const body = (c.opts as { json: Record<string, unknown> }).json;
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
          matched_chunks: [{ section_name: "Methods", text: "we trained", score: 0.9 }],
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
    const hit = (
      r.structuredContent as { results: Array<Record<string, unknown>> }
    ).results[0]!;
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
    ) as { outputSchema?: { type?: string } } | undefined;
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
    expect(c.method).toBe("POST");
    // The fields map 1:1 onto the API body (paper_ids, fields, instruction,
    // sections); there is no rename and no projection knob.
    expect((c.opts as { json: Record<string, unknown> }).json).toEqual({
      paper_ids: ["p1", "p2"],
      fields: [
        { name: "dataset", type: "string", description: "eval set" },
        { name: "accuracy", type: "number" },
      ],
      instruction: "Extract the dataset and accuracy.",
      sections: ["Results"],
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
    const body = (
      calls.find((x) => x.url === "papers/extract")!.opts as {
        json: Record<string, unknown>;
      }
    ).json;
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
    ) as { outputSchema?: { type?: string } } | undefined;
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
    expect(c.method).toBe("POST");
    // The fields map 1:1 onto the API body (claims, context, + shared filters);
    // there is no rename and no projection knob.
    expect((c.opts as { json: Record<string, unknown> }).json).toEqual({
      claims: ["Transformers scale to long sequences."],
      context: "Survey of sequence models.",
    });
    // The verdict envelope passes straight through (no slim projection).
    expect(r.structuredContent).toEqual(envelope);
    expect(JSON.parse(r.content[0]!.text)).toEqual(envelope);
  });

  it("maps `conference` onto the wire `conference` body field (NOT conference_short_name)", async () => {
    // Like search_papers_many, the verify request's actual field is
    // `conference`; there is no rename. The fuzzy resolver canonicalises first
    // (no conferences list mocked here, so an unresolved name passes through).
    const { ky, calls, setResponse } = fakeKy();
    setResponse({ verdicts: [], claims_processed: 1 });
    await callPaperTool(ky, "verify_claims", {
      claims: ["x"],
      conference: "NeurIPS",
    });
    const c = calls.find((x) => x.url === "claims/verify")!;
    const body = (c.opts as { json: Record<string, unknown> }).json;
    expect(body.conference).toBe("NeurIPS");
    expect("conference_short_name" in body).toBe(false);
  });

  it("omits context from the body when not provided", async () => {
    const { ky, calls, setResponse } = fakeKy();
    setResponse({ verdicts: [], claims_processed: 1 });
    await callPaperTool(ky, "verify_claims", { claims: ["x"] });
    const body = (
      calls.find((x) => x.url === "claims/verify")!.opts as {
        json: Record<string, unknown>;
      }
    ).json;
    expect("context" in body).toBe(false);
    expect(body).toEqual({ claims: ["x"] });
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
    await callGuidanceTool(ky, "search_research_guidance", { query: "ablation", limit: 3 });
    expect(calls[0]!.url).toBe("research-guidance/search");
    expect((calls[0]!.opts as { json: Record<string, unknown> }).json).toEqual({
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

describe("subscriptions tools", () => {
  it("list_subscriptions GETs /subscriptions", async () => {
    const { ky, calls, setResponse } = fakeKy();
    setResponse([]);
    await callSubsTool(ky, "list_subscriptions", {});
    expect(calls[0]!.url).toBe("subscriptions");
    expect(calls[0]!.method).toBe("GET");
  });

  it("subscribe_conference maps `conference` onto the wire `conference_id` + flags", async () => {
    const { ky, calls, setResponse } = fakeKy();
    setResponse({ id: "sub1" });
    // The agent passes a name in `conference`; the tool forwards it as the
    // API's `conference_id` field, which resolves a short name server-side.
    await callSubsTool(ky, "subscribe_conference", {
      conference: "NeurIPS",
      notify_email: false,
    });
    expect(calls[0]!.url).toBe("subscriptions");
    // zod 4 evaluates `.default(true)` even on `.optional()` fields, so the
    // tool now sends notify_in_app=true explicitly when the caller omits it.
    // Both fields end up on the wire; the API's own default would otherwise
    // apply, but this is unambiguous.
    expect((calls[0]!.opts as { json: Record<string, unknown> }).json).toEqual({
      conference_id: "NeurIPS",
      notify_email: false,
      notify_in_app: true,
    });
  });

  it("unsubscribe_conference DELETEs by ID and returns ok", async () => {
    const { ky, calls } = fakeKy();
    const r = await callSubsTool(ky, "unsubscribe_conference", {
      subscription_id: "sub1",
    });
    expect(calls[0]!.method).toBe("DELETE");
    expect(calls[0]!.url).toBe("subscriptions/sub1");
    expect(JSON.parse(r.content[0]!.text)).toEqual({ ok: true, subscription_id: "sub1" });
  });

  it("get_subscription_updates forwards since cursor", async () => {
    const { ky, calls, setResponse } = fakeKy();
    setResponse({ papers: [], next_cursor: "abc" });
    await callSubsTool(ky, "get_subscription_updates", {
      since: "2026-01-01T00:00:00Z",
    });
    expect(calls[0]!.url).toBe("subscriptions/updates");
    expect((calls[0]!.opts as { searchParams: Record<string, unknown> }).searchParams).toEqual({
      limit: 20,
      since: "2026-01-01T00:00:00Z",
    });
  });
});

// Silence unused-import warning if present
vi.fn();
