import { describe, it, expect, vi, beforeEach } from "vitest";
import type { KyInstance } from "ky";
import { callPaperTool } from "../../src/tools/papers.js";
import { callGuidanceTool } from "../../src/tools/guidance.js";
import { callSubsTool } from "../../src/tools/subscriptions.js";
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
    });
    // The MCP slim projector renames `id` → `paper_id` and adds
    // default `authors: []` + `citation_count: 0` so agents can rely on a
    // stable shape across all paper-returning tools.
    const expected = {
      results: [{ paper_id: "p1", authors: [], citation_count: 0 }],
    };
    expect(JSON.parse(r.content[0]!.text)).toEqual(expected);
    // MCP 2025-06-18: tools with `outputSchema` MUST also surface the
    // result via `structuredContent` so clients can validate against the
    // declared schema instead of re-parsing the text content.
    expect(r.structuredContent).toEqual(expected);
  });

  it("get_paper hits GET /papers/{id}", async () => {
    const { ky, calls, setResponse } = fakeKy();
    setResponse({ id: "p1", title: "Foo" });
    await callPaperTool(ky, "get_paper", { paper_id: "p1" });
    expect(calls[0]!.url).toBe("papers/p1");
    expect(calls[0]!.method).toBe("GET");
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
    const r = await callPaperTool(ky, "get_paper", { paper_id: "p1" });
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

  it("search_papers omits contexts by default (should_include_context unset)", async () => {
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
    const r = await callPaperTool(ky, "search_papers", { query: "training tricks" });
    const parsed = JSON.parse(r.content[0]!.text) as {
      results: Array<Record<string, unknown>>;
    };
    expect(parsed.results[0]!.paper_id).toBe("p1");
    expect("contexts" in parsed.results[0]!).toBe(false);
  });

  it("search_papers returns matched contexts when should_include_context is true", async () => {
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
      should_include_context: true,
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

  it("does NOT forward should_include_context to the API request body", async () => {
    // The API's SearchRequest is extra=forbid; the flag is an MCP-side
    // projection knob, so it must never reach the upstream body.
    const { ky, calls, setResponse } = fakeKy();
    setResponse({ results: [] });
    await callPaperTool(ky, "search_papers", {
      query: "x",
      should_include_context: true,
    });
    const c = calls.find((x) => x.url === "search")!;
    const body = (c.opts as { json: Record<string, unknown> }).json;
    expect("should_include_context" in body).toBe(false);
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
  it("list_conference_update_subscriptions GETs /subscriptions", async () => {
    const { ky, calls, setResponse } = fakeKy();
    setResponse([]);
    await callSubsTool(ky, "list_conference_update_subscriptions", {});
    expect(calls[0]!.url).toBe("subscriptions");
    expect(calls[0]!.method).toBe("GET");
  });

  it("subscribe_to_conference_updates posts conference_id + flags", async () => {
    const { ky, calls, setResponse } = fakeKy();
    setResponse({ id: "sub1" });
    await callSubsTool(ky, "subscribe_to_conference_updates", {
      conference_id: "conf-uuid",
      notify_email: false,
    });
    expect(calls[0]!.url).toBe("subscriptions");
    // zod 4 evaluates `.default(true)` even on `.optional()` fields, so the
    // tool now sends notify_in_app=true explicitly when the caller omits it.
    // Both fields end up on the wire; the API's own default would otherwise
    // apply, but this is unambiguous.
    expect((calls[0]!.opts as { json: Record<string, unknown> }).json).toEqual({
      conference_id: "conf-uuid",
      notify_email: false,
      notify_in_app: true,
    });
  });

  it("unsubscribe_from_conference_updates DELETEs by ID and returns ok", async () => {
    const { ky, calls } = fakeKy();
    const r = await callSubsTool(ky, "unsubscribe_from_conference_updates", {
      subscription_id: "sub1",
    });
    expect(calls[0]!.method).toBe("DELETE");
    expect(calls[0]!.url).toBe("subscriptions/sub1");
    expect(JSON.parse(r.content[0]!.text)).toEqual({ ok: true, subscription_id: "sub1" });
  });

  it("check_for_conference_updates forwards since cursor", async () => {
    const { ky, calls, setResponse } = fakeKy();
    setResponse({ papers: [], next_cursor: "abc" });
    await callSubsTool(ky, "check_for_conference_updates", {
      subscription_id: "sub1",
      since: "2026-01-01T00:00:00Z",
    });
    expect((calls[0]!.opts as { searchParams: Record<string, unknown> }).searchParams).toEqual({
      limit: 20,
      since: "2026-01-01T00:00:00Z",
    });
  });
});

// Silence unused-import warning if present
vi.fn();
