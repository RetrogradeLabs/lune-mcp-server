/**
 * End-to-end coverage for all tool handlers via callPaperTool /
 * callGuidanceTool / callSubsTool, driven by a mocked ky double.
 *
 * `tool-handlers.test.ts` covers the fuzzy-resolver branches, paging/sort
 * passthrough, and the unknown-tool default arms. This file is the
 * complementary half: for EVERY tool it asserts (a) the projected/slim
 * payload the agent actually receives (real field values, not just "no
 * throw"), and (b) that an upstream ky `HTTPError` (404 / 402 / 429)
 * surfaces as an `{ isError: true }` Tool Execution Result carrying the
 * actionable message from `errors.ts:httpErrorToToolResult`, NOT a thrown
 * JSON-RPC protocol error. Includes related search happy path and unknown-id
 * 404 coverage.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { KyInstance } from "ky";
import { callPaperTool } from "../../src/tools/papers.js";
import { callGuidanceTool } from "../../src/tools/guidance.js";
import { callSubsTool } from "../../src/tools/subscriptions.js";
import { TOOL_RESPONSE_CACHE } from "../../src/cache.js";

beforeEach(async () => {
  await TOOL_RESPONSE_CACHE.clear();
});

// ─── ky doubles ────────────────────────────────────────────────────────────

/**
 * Route-aware ky double. Each verb+url resolves to its registered body via a
 * `.json()` thenable, matching how `cachedJson` and the bare `api.get(...)`
 * calls consume responses in the handlers.
 */
function routedKy(routes: {
  get?: Record<string, unknown>;
  post?: Record<string, unknown>;
  delete?: Record<string, unknown>;
}): {
  ky: KyInstance;
  calls: Array<{ method: string; url: string; opts?: unknown }>;
} {
  const calls: Array<{ method: string; url: string; opts?: unknown }> = [];
  const make =
    (method: "get" | "post" | "delete") => (url: string, opts?: unknown) => {
      calls.push({ method, url, opts });
      const table =
        method === "get"
          ? routes.get
          : method === "post"
            ? routes.post
            : routes.delete;
      return {
        json: async () => table?.[url] ?? {},
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

/**
 * A ky `HTTPError`-shaped object: the value `errors.ts:asKyHttpError` narrows
 * on (anything with a `.response` exposing `status`, `headers`, and an async
 * `json()`). `cachedJson` / the handler bodies reject with this; the handler's
 * catch funnels it through `httpErrorToToolResult`.
 */
function httpError(
  status: number,
  body: Record<string, unknown> | null,
  headers: Record<string, string> = {},
): unknown {
  return {
    response: {
      status,
      headers: new Headers(headers),
      json: async () => {
        if (body === null) throw new Error("no json body");
        return body;
      },
    },
  };
}

/**
 * A ky double whose EVERY verb rejects with the given HTTPError. Lets each
 * error-path test exercise the handler's catch arm regardless of which verb
 * the tool happens to call.
 */
function throwingKy(err: unknown): KyInstance {
  const make = () => () => ({
    json: async () => {
      throw err;
    },
  });
  // `delete` is awaited directly (no `.json()`) in the subscriptions handler,
  // so it must reject as a thenable too.
  const rejectingDelete = () => ({
    then: (
      _ok: (v: unknown) => unknown,
      bad: (e: unknown) => unknown,
    ) => bad(err),
    json: async () => {
      throw err;
    },
  });
  return {
    get: make(),
    post: make(),
    delete: rejectingDelete,
    put: make(),
  } as unknown as KyInstance;
}

/** Assert a result is an actionable Tool Execution Error carrying `text`. */
function expectToolError(
  res: { isError?: boolean; content?: Array<{ type: string; text?: string }> },
  expected: { contains: string[] },
) {
  expect(res.isError).toBe(true);
  const text = res.content?.[0]?.text ?? "";
  for (const needle of expected.contains) expect(text).toContain(needle);
}

// ─── search_papers ──────────────────────────────────────────────────────────

describe("search_papers", () => {
  it("returns enriched hits plus best_score / low_confidence envelope", async () => {
    const { ky } = routedKy({
      post: {
        search: {
          results: [
            {
              id: "p1",
              title: "Attention Is All You Need",
              authors: ["A", "B", "C", "D", "E", "F", "G", "H"],
              year: 2017,
              citation_count: 99999,
              conference: { short_name: "NeurIPS" },
              score: 1.05,
              rerank_score: 0.91,
              matched_chunks: [{ section_name: "Abstract", text: "self-attention", score: 0.9 }],
            },
          ],
          has_more: false,
        },
      },
    });
    const res = await callPaperTool(ky, "search_papers", { query: "transformers" });
    const sc = res.structuredContent as {
      results: Array<Record<string, unknown>>;
      best_score: number;
      low_confidence: boolean;
      has_more: boolean;
    };
    const hit = sc.results[0]!;
    expect(hit.paper_id).toBe("p1");
    expect(hit.title).toBe("Attention Is All You Need");
    expect(hit.conference).toBe("NeurIPS");
    expect(hit.citation_count).toBe(99999);
    // The boosted ranking `score` and the calibrated `rerank_score` are distinct.
    expect(hit.score).toBe(1.05);
    expect(hit.rerank_score).toBe(0.91);
    // Default mode keeps full metadata and filters abstract chunks out of contexts.
    expect((hit.authors as string[]).length).toBe(8);
    expect("et_al_count" in hit).toBe(false);
    expect("snippet" in hit).toBe(false);
    expect(hit.contexts).toEqual([]);
    // best_score / low_confidence derive from rerank_score, not the boosted score.
    expect(sc.best_score).toBe(0.91);
    expect(sc.low_confidence).toBe(false);
    expect(sc.has_more).toBe(false);
  });

  it("flags low_confidence when the top rerank_score is below the floor", async () => {
    const { ky } = routedKy({
      post: { search: { results: [{ id: "p1", title: "weak", score: 0.2, rerank_score: 0.1 }] } },
    });
    const res = await callPaperTool(ky, "search_papers", { query: "x" });
    const sc = res.structuredContent as { best_score: number; low_confidence: boolean };
    expect(sc.best_score).toBe(0.1);
    expect(sc.low_confidence).toBe(true);
  });

  it("surfaces a 402 quota error as an isError tool result with the buy-credits URL", async () => {
    const res = await callPaperTool(
      throwingKy(httpError(402, { buy_credits_url: "https://lune/buy" })),
      "search_papers",
      { query: "x" },
    );
    expectToolError(res, {
      contains: ["Quota exhausted", "https://lune/buy", "buy_credits_url=https://lune/buy", "http_status=402"],
    });
  });
});

// ─── get_paper_fulltext ───────────────────────────────────────────────────────

describe("get_paper_fulltext", () => {
  it("returns the markdown body as a plain-text content block", async () => {
    const { ky } = routedKy({
      get: { "papers/p1/fulltext": { body: "# Methods\nWe trained a model." } },
    });
    const res = await callPaperTool(ky, "get_paper_fulltext", { paper_id: "p1" });
    expect(res.content?.[0]?.type).toBe("text");
    expect(res.content?.[0]?.text).toBe("# Methods\nWe trained a model.");
  });

  it("returns the structured section list verbatim for format=json", async () => {
    const { ky } = routedKy({
      get: {
        "papers/p1/fulltext": {
          sections: [{ heading: "Methods", text: "We trained a model." }],
        },
      },
    });
    const res = await callPaperTool(ky, "get_paper_fulltext", {
      paper_id: "p1",
      format: "json",
    });
    const sc = res.structuredContent as { sections: Array<{ heading: string }> };
    expect(sc.sections[0]!.heading).toBe("Methods");
  });

  it("surfaces a 404 as an isError tool result", async () => {
    const res = await callPaperTool(
      throwingKy(httpError(404, { detail: "No full text" })),
      "get_paper_fulltext",
      { paper_id: "p1" },
    );
    expectToolError(res, { contains: ["No full text", "http_status=404"] });
  });
});

// ─── get_paper_citations ──────────────────────────────────────────────────────

describe("get_paper_citations", () => {
  it("projects citations with in_corpus derived from a present id", async () => {
    const { ky } = routedKy({
      get: {
        "papers/p1/citations": {
          direction: "cited_by",
          total: 2,
          has_more: false,
          papers: [
            { id: "c1", title: "Cites Me", year: 2020, venue: "ICML", citation_count: 5 },
            { title: "Parsed Only Reference", year: 1999 },
          ],
        },
      },
    });
    const res = await callPaperTool(ky, "get_paper_citations", { paper_id: "p1" });
    const sc = res.structuredContent as {
      direction: string;
      total: number;
      citations: Array<Record<string, unknown>>;
    };
    expect(sc.direction).toBe("cited_by");
    expect(sc.total).toBe(2);
    expect(sc.citations[0]!.paper_id).toBe("c1");
    expect(sc.citations[0]!.in_corpus).toBe(true);
    expect(sc.citations[0]!.venue).toBe("ICML");
    // No id => a parsed-only reference: paper_id absent, in_corpus false.
    expect(sc.citations[1]!.paper_id).toBeUndefined();
    expect(sc.citations[1]!.in_corpus).toBe(false);
    expect(sc.citations[1]!.title).toBe("Parsed Only Reference");
  });

  it("surfaces a 429 rate-limit as an isError tool result with retry seconds", async () => {
    const res = await callPaperTool(
      throwingKy(httpError(429, { retry_after_seconds: 30, upgrade_hint: "Upgrade for more." })),
      "get_paper_citations",
      { paper_id: "p1" },
    );
    expectToolError(res, {
      contains: ["Rate limited", "Retry after 30s", "Upgrade for more.", "retry_after_seconds=30", "http_status=429"],
    });
  });
});

// ─── list_conferences ─────────────────────────────────────────────────────────

describe("list_conferences", () => {
  it("projects the conference list and forwards the category filter", async () => {
    const { ky, calls } = routedKy({
      get: {
        conferences: [
          {
            id: "conf-1",
            short_name: "CCS",
            full_name: "ACM Conference on Computer and Communications Security",
            category: "security",
            paper_count: 1200,
            years: [2023, 2024],
          },
        ],
      },
    });
    const res = await callPaperTool(ky, "list_conferences", { category: "security" });
    expect((calls[0]!.opts as { searchParams: Record<string, string> }).searchParams).toEqual({
      category: "security",
    });
    const sc = res.structuredContent as { conferences: Array<Record<string, unknown>> };
    expect(sc.conferences[0]!.id).toBe("conf-1");
    expect(sc.conferences[0]!.short_name).toBe("CCS");
    expect(sc.conferences[0]!.paper_count).toBe(1200);
    expect(sc.conferences[0]!.years).toEqual([2023, 2024]);
  });

  it("surfaces a 429 rate-limit as an isError tool result", async () => {
    const res = await callPaperTool(
      throwingKy(httpError(429, { retry_after_seconds: 12 })),
      "list_conferences",
      {},
    );
    expectToolError(res, { contains: ["Rate limited", "Retry after 12s", "http_status=429"] });
  });
});

// ─── get_conference_papers ────────────────────────────────────────────────────

describe("get_conference_papers", () => {
  it("returns the slim papers list plus total + has_more", async () => {
    const { ky } = routedKy({
      get: {
        conferences: [{ short_name: "NeurIPS" }],
        "conferences/NeurIPS/papers": {
          papers: [
            {
              id: "p1",
              title: "A NeurIPS Paper",
              year: 2024,
              citation_count: 7,
              abstract: "dropped on a browse page",
            },
          ],
          total: 1,
          page: 1,
          limit: 20,
        },
      },
    });
    const res = await callPaperTool(ky, "get_conference_papers", { conference: "NeurIPS" });
    const sc = res.structuredContent as {
      papers: Array<Record<string, unknown>>;
      total: number;
      has_more: boolean;
    };
    expect(sc.papers[0]!.paper_id).toBe("p1");
    expect(sc.papers[0]!.title).toBe("A NeurIPS Paper");
    // Browse pages omit the abstract to keep venue pages light.
    expect("abstract" in sc.papers[0]!).toBe(false);
    expect(sc.total).toBe(1);
    // 1 paper, page 1 of 20 -> nothing more.
    expect(sc.has_more).toBe(false);
  });

  it("surfaces a 404 (unknown conference) as an isError tool result", async () => {
    const res = await callPaperTool(
      throwingKy(httpError(404, { detail: "Conference not found" })),
      "get_conference_papers",
      { conference: "NotARealVenue" },
    );
    expectToolError(res, { contains: ["Conference not found", "http_status=404"] });
  });
});

// ─── search_related_papers ────────────────────────────────────────────────────

describe("search_related_papers", () => {
  it("returns enriched related hits from a bare array response", async () => {
    const { ky, calls } = routedKy({
      get: {
        "papers/seed/related": [
          {
            id: "n1",
            title: "Neighbor One",
            abstract: "Neighbor abstract",
            citation_count: 3,
            matched_chunks: [
              { section_name: "Results", text: "related result", score: 0.6 },
            ],
          },
          { id: "n2", title: "Neighbor Two", citation_count: 8 },
        ],
      },
    });
    const res = await callPaperTool(ky, "search_related_papers", { paper_id: "seed", limit: 2 });
    expect(calls[0]!.url).toBe("papers/seed/related");
    const sc = res.structuredContent as { papers: Array<Record<string, unknown>> };
    expect(sc.papers).toHaveLength(2);
    expect(sc.papers.map((p) => p.paper_id)).toEqual(["n1", "n2"]);
    expect(sc.papers[0]!.title).toBe("Neighbor One");
    expect(sc.papers[0]!.abstract).toBe("Neighbor abstract");
    expect(sc.papers[0]!.contexts).toEqual([
      { section: "Results", text: "related result", score: 0.6 },
    ]);
    expect(sc.papers[1]!.citation_count).toBe(8);
  });

  it("surfaces an unknown paper_id (404) as an isError tool result", async () => {
    const res = await callPaperTool(
      throwingKy(httpError(404, { detail: "Paper not found" })),
      "search_related_papers",
      { paper_id: "missing" },
    );
    expectToolError(res, { contains: ["Paper not found", "call search_papers first", "http_status=404"] });
  });
});

// ─── search_research_guidance ─────────────────────────────────────────────────

describe("search_research_guidance", () => {
  it("projects guidance hits, renaming doc_source_url -> source_url and content -> excerpt", async () => {
    const { ky, calls } = routedKy({
      post: {
        "research-guidance/search": {
          results: [
            {
              doc_id: "g1",
              doc_title: "How to Design an Ablation",
              doc_source_url: "https://lune/guide/ablation",
              section_name: "Ablations",
              content: "Vary one factor at a time.",
            },
          ],
        },
      },
    });
    const res = await callGuidanceTool(ky, "search_research_guidance", { query: "ablation" });
    expect(calls[0]!.url).toBe("research-guidance/search");
    const sc = res.structuredContent as { results: Array<Record<string, unknown>> };
    const hit = sc.results[0]!;
    expect(hit.doc_id).toBe("g1");
    expect(hit.doc_title).toBe("How to Design an Ablation");
    expect(hit.source_url).toBe("https://lune/guide/ablation");
    expect(hit.section).toBe("Ablations");
    expect(hit.excerpt).toBe("Vary one factor at a time.");
  });

  it("surfaces a 429 rate-limit as an isError tool result", async () => {
    const res = await callGuidanceTool(
      throwingKy(httpError(429, { retry_after_seconds: 5 })),
      "search_research_guidance",
      { query: "x" },
    );
    expectToolError(res, { contains: ["Rate limited", "Retry after 5s", "http_status=429"] });
  });
});

// ─── get_research_guidance_doc ────────────────────────────────────────────────

describe("get_research_guidance_doc", () => {
  it("projects the guidance doc, mapping id -> doc_id and author_name -> author", async () => {
    const { ky, calls } = routedKy({
      get: {
        "research-guidance/g1": {
          id: "g1",
          title: "Reproducibility Checklist",
          author_name: "Jane Researcher",
          author_affiliation: "MIT",
          source_url: "https://lune/guide/repro",
          tags: ["reproducibility", "checklist"],
        },
      },
    });
    const res = await callGuidanceTool(ky, "get_research_guidance_doc", { doc_id: "g1" });
    expect(calls[0]!.url).toBe("research-guidance/g1");
    const sc = res.structuredContent as Record<string, unknown>;
    expect(sc.doc_id).toBe("g1");
    expect(sc.title).toBe("Reproducibility Checklist");
    expect(sc.author).toBe("Jane Researcher");
    expect(sc.author_affiliation).toBe("MIT");
    expect(sc.source_url).toBe("https://lune/guide/repro");
    expect(sc.tags).toEqual(["reproducibility", "checklist"]);
  });

  it("surfaces a 404 as an isError tool result", async () => {
    const res = await callGuidanceTool(
      throwingKy(httpError(404, { detail: "Doc not found" })),
      "get_research_guidance_doc",
      { doc_id: "missing" },
    );
    expectToolError(res, { contains: ["Doc not found", "http_status=404"] });
  });
});

// ─── list_subscriptions ─────────────────────────────────────

describe("list_subscriptions", () => {
  it("projects the subscription list down to id / conference_id / created_at", async () => {
    const { ky, calls } = routedKy({
      get: {
        subscriptions: [
          { id: "sub-1", conference_id: "conf-1", created_at: "2026-01-01T00:00:00Z" },
        ],
      },
    });
    const res = await callSubsTool(ky, "list_subscriptions", {});
    expect(calls[0]!.url).toBe("subscriptions");
    const sc = res.structuredContent as { subscriptions: Array<Record<string, unknown>> };
    expect(sc.subscriptions[0]!.id).toBe("sub-1");
    expect(sc.subscriptions[0]!.conference_id).toBe("conf-1");
    expect(sc.subscriptions[0]!.created_at).toBe("2026-01-01T00:00:00Z");
  });

  it("surfaces a 429 rate-limit as an isError tool result", async () => {
    const res = await callSubsTool(
      throwingKy(httpError(429, { retry_after_seconds: 8 })),
      "list_subscriptions",
      {},
    );
    expectToolError(res, { contains: ["Rate limited", "Retry after 8s", "http_status=429"] });
  });
});

// ─── subscribe_conference ──────────────────────────────────────────

describe("subscribe_conference", () => {
  it("posts the create body and returns the slim subscription", async () => {
    const { ky, calls } = routedKy({
      post: {
        subscriptions: {
          id: "sub-9",
          conference_id: "conf-1",
          created_at: "2026-02-02T00:00:00Z",
        },
      },
    });
    const res = await callSubsTool(ky, "subscribe_conference", {
      conference: "NeurIPS",
    });
    // notify_email / notify_in_app default to true from zod and are always sent.
    // The agent's `conference` maps onto the API's `conference_id` field.
    const body = (calls[0]!.opts as { json: Record<string, unknown> }).json;
    expect(body.conference_id).toBe("NeurIPS");
    expect(body.notify_email).toBe(true);
    expect(body.notify_in_app).toBe(true);
    const sc = res.structuredContent as Record<string, unknown>;
    expect(sc.id).toBe("sub-9");
    expect(sc.conference_id).toBe("conf-1");
    expect(sc.created_at).toBe("2026-02-02T00:00:00Z");
  });

  it("surfaces a 402 quota error as an isError tool result", async () => {
    const res = await callSubsTool(
      throwingKy(httpError(402, { buy_credits_url: "https://lune/buy" })),
      "subscribe_conference",
      { conference: "NeurIPS" },
    );
    expectToolError(res, { contains: ["Quota exhausted", "https://lune/buy", "http_status=402"] });
  });
});

// ─── unsubscribe_conference ──────────────────────────────────────

describe("unsubscribe_conference", () => {
  it("DELETEs the subscription and echoes { ok: true, subscription_id }", async () => {
    const { ky, calls } = routedKy({ delete: {} });
    const res = await callSubsTool(ky, "unsubscribe_conference", {
      subscription_id: "sub-1",
    });
    expect(calls[0]!.method).toBe("delete");
    expect(calls[0]!.url).toBe("subscriptions/sub-1");
    const sc = res.structuredContent as { ok: boolean; subscription_id: string };
    expect(sc.ok).toBe(true);
    expect(sc.subscription_id).toBe("sub-1");
  });

  it("surfaces a 404 as an isError tool result", async () => {
    const res = await callSubsTool(
      throwingKy(httpError(404, { detail: "Subscription not found" })),
      "unsubscribe_conference",
      { subscription_id: "missing" },
    );
    expectToolError(res, { contains: ["Subscription not found", "http_status=404"] });
  });
});

// ─── get_subscription_updates ─────────────────────────────────────────────

describe("get_subscription_updates", () => {
  it("returns the merged updates (with occurred_at) and the next_cursor", async () => {
    const { ky, calls } = routedKy({
      get: {
        "subscriptions/updates": {
          papers: [
            {
              id: "p1",
              title: "Freshly Indexed",
              year: 2026,
              citation_count: 0,
              occurred_at: "2026-03-03T00:00:00Z",
            },
          ],
          next_cursor: "cursor-abc",
        },
      },
    });
    // No subscription_id: the aggregate feed covers every subscription.
    const res = await callSubsTool(ky, "get_subscription_updates", {});
    expect(calls[0]!.url).toBe("subscriptions/updates");
    const sc = res.structuredContent as {
      papers: Array<Record<string, unknown>>;
      next_cursor: string | null;
    };
    expect(sc.papers[0]!.paper_id).toBe("p1");
    expect(sc.papers[0]!.title).toBe("Freshly Indexed");
    expect(sc.papers[0]!.occurred_at).toBe("2026-03-03T00:00:00Z");
    expect(sc.next_cursor).toBe("cursor-abc");
  });

  it("forwards the since cursor as a searchParam when provided", async () => {
    const { ky, calls } = routedKy({
      get: { "subscriptions/updates": { papers: [], next_cursor: null } },
    });
    await callSubsTool(ky, "get_subscription_updates", {
      since: "cursor-prev",
    });
    expect(calls[0]!.url).toBe("subscriptions/updates");
    const sp = (calls[0]!.opts as { searchParams: Record<string, unknown> }).searchParams;
    expect(sp).toEqual({ limit: 20, since: "cursor-prev" });
  });

  it("surfaces an upstream error as an isError tool result", async () => {
    const res = await callSubsTool(
      throwingKy(httpError(402, { detail: "Quota exhausted" })),
      "get_subscription_updates",
      {},
    );
    expectToolError(res, { contains: ["Quota exhausted", "http_status=402"] });
  });
});

// ─── error-body edge cases shared across handlers ─────────────────────────────

describe("upstream error projection edge cases", () => {
  it("falls back to a generic 404 message when the error body has no detail", async () => {
    const res = await callPaperTool(throwingKy(httpError(404, null)), "search_related_papers", {
      paper_id: "x",
    });
    expectToolError(res, { contains: ["Not found", "call search_papers first", "http_status=404"] });
  });

  it("defaults the 429 retry window to 60s when the body omits retry_after_seconds", async () => {
    const res = await callPaperTool(throwingKy(httpError(429, {})), "search_papers", {
      query: "x",
    });
    expectToolError(res, { contains: ["Rate limited", "Retry after 60s", "retry_after_seconds=60"] });
  });

  it("derives the 429 retry window from the Retry-After header when the body omits it", async () => {
    const res = await callPaperTool(
      throwingKy(httpError(429, {}, { "retry-after": "45" })),
      "search_papers",
      { query: "x" },
    );
    expectToolError(res, { contains: ["Retry after 45s", "retry_after_seconds=45"] });
  });
});
