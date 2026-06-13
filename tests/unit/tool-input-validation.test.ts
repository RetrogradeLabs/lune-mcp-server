/**
 * Per-tool input-validation matrix.
 *
 * Goal: every documented zod constraint on every tool's input schema is
 * exercised by at least one test. Catches a category of regressions where a
 * widening zod schema accidentally accepts garbage that then 4xx's on the
 * API or, worse, silently no-ops because the API ignores the unknown
 * field. Pairs with `tools.test.ts` (which covers happy paths and the API
 * → MCP error translation).
 *
 * Convention:
 *   • `it("rejects …")` checks zod throws BEFORE any HTTP call goes out
 *     (the fake ky's `calls` array stays empty).
 *   • `it("accepts …")` confirms the boundary value is allowed and a
 *     request is dispatched.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type { KyInstance } from "ky";
import { callPaperTool } from "../../src/tools/papers.js";
import { callGuidanceTool } from "../../src/tools/guidance.js";
import { callSubsTool } from "../../src/tools/subscriptions.js";
import { TOOL_RESPONSE_CACHE } from "../../src/cache.js";

beforeEach(async () => {
  await TOOL_RESPONSE_CACHE.clear();
});

/** Minimal ky double: records calls, returns whatever you set. */
function fakeKy(): {
  ky: KyInstance;
  calls: Array<{ method: string; url: string; opts?: unknown }>;
  setResponse: (data: unknown) => void;
} {
  const calls: Array<{ method: string; url: string; opts?: unknown }> = [];
  let response: unknown = {};
  const make = (method: string) => (url: string, opts?: unknown) => {
    calls.push({ method, url, opts });
    return {
      json: async () => response,
    } as unknown as Promise<unknown>;
  };
  return {
    ky: {
      get: make("GET"),
      post: make("POST"),
      delete: make("DELETE"),
      put: make("PUT"),
    } as unknown as KyInstance,
    calls,
    setResponse: (d) => {
      response = d;
    },
  };
}

/** Confirm zod rejected before any HTTP went out. */
async function expectZodReject(
  fn: () => Promise<unknown>,
  calls: Array<{ method: string; url: string; opts?: unknown }>,
): Promise<void> {
  await expect(fn()).rejects.toThrow();
  expect(calls, "tool must reject before issuing HTTP").toHaveLength(0);
}

// ─── search_papers ──────────────────────────────────────────────────────────

describe("search_papers input validation", () => {
  it("rejects empty query", async () => {
    const { ky, calls } = fakeKy();
    await expectZodReject(
      () => callPaperTool(ky, "search_papers", { query: "" }),
      calls,
    );
  });

  it("rejects missing query (undefined)", async () => {
    const { ky, calls } = fakeKy();
    await expectZodReject(
      () => callPaperTool(ky, "search_papers", {} as unknown as { query: string }),
      calls,
    );
  });

  it("rejects non-string query", async () => {
    const { ky, calls } = fakeKy();
    await expectZodReject(
      () =>
        callPaperTool(ky, "search_papers", {
          query: 123 as unknown as string,
        }),
      calls,
    );
  });

  it("rejects limit > 50 (server-side enforced ceiling)", async () => {
    const { ky, calls } = fakeKy();
    await expectZodReject(
      () =>
        callPaperTool(ky, "search_papers", { query: "transformer", limit: 51 }),
      calls,
    );
  });

  it("rejects negative limit", async () => {
    const { ky, calls } = fakeKy();
    await expectZodReject(
      () =>
        callPaperTool(ky, "search_papers", { query: "transformer", limit: -1 }),
      calls,
    );
  });

  it("rejects zero limit", async () => {
    const { ky, calls } = fakeKy();
    await expectZodReject(
      () => callPaperTool(ky, "search_papers", { query: "x", limit: 0 }),
      calls,
    );
  });

  it("accepts limit=1 (lower boundary)", async () => {
    const { ky, calls, setResponse } = fakeKy();
    setResponse({ results: [] });
    await callPaperTool(ky, "search_papers", { query: "x", limit: 1 });
    expect(calls).toHaveLength(1);
  });

  it("accepts limit=50 (upper boundary)", async () => {
    const { ky, calls, setResponse } = fakeKy();
    setResponse({ results: [] });
    await callPaperTool(ky, "search_papers", { query: "x", limit: 50 });
    expect(calls).toHaveLength(1);
  });

  it("rejects out-of-range year (before printing press)", async () => {
    const { ky, calls } = fakeKy();
    await expectZodReject(
      () =>
        callPaperTool(ky, "search_papers", { query: "x", year: 1000 }),
      calls,
    );
  });

  it("rejects far-future year", async () => {
    const { ky, calls } = fakeKy();
    await expectZodReject(
      () =>
        callPaperTool(ky, "search_papers", { query: "x", year: 9999 }),
      calls,
    );
  });

  it("rejects a non-boolean detail flag", async () => {
    const { ky, calls } = fakeKy();
    await expectZodReject(
      () =>
        callPaperTool(ky, "search_papers", {
          query: "x",
          detail: "yes" as unknown as boolean,
        }),
      calls,
    );
  });

  it("accepts detail=true", async () => {
    const { ky, calls, setResponse } = fakeKy();
    setResponse({ results: [] });
    await callPaperTool(ky, "search_papers", {
      query: "x",
      detail: true,
    });
    expect(calls).toHaveLength(1);
  });
});

// ─── search_related_papers ───────────────────────────────────────────────────

describe("search_related_papers input validation", () => {
  it("rejects missing paper_id", async () => {
    const { ky, calls } = fakeKy();
    await expectZodReject(
      () =>
        callPaperTool(
          ky,
          "search_related_papers",
          {} as unknown as { paper_id: string },
        ),
      calls,
    );
  });

  it("rejects zero limit", async () => {
    const { ky, calls } = fakeKy();
    await expectZodReject(
      () => callPaperTool(ky, "search_related_papers", { paper_id: "p1", limit: 0 }),
      calls,
    );
  });

  it("accepts the max limit", async () => {
    const { ky, calls, setResponse } = fakeKy();
    setResponse([]);
    await callPaperTool(ky, "search_related_papers", { paper_id: "p1", limit: 20 });
    expect(calls).toHaveLength(1);
  });
});

// ─── get_paper_fulltext ─────────────────────────────────────────────────────

describe("get_paper_fulltext input validation", () => {
  it("rejects unknown format", async () => {
    const { ky, calls } = fakeKy();
    await expectZodReject(
      () =>
        callPaperTool(ky, "get_paper_fulltext", {
          paper_id: "abc",
          format: "xml" as unknown as "markdown",
        }),
      calls,
    );
  });

  it("accepts format=markdown", async () => {
    const { ky, calls, setResponse } = fakeKy();
    setResponse("# title");
    await callPaperTool(ky, "get_paper_fulltext", {
      paper_id: "abc",
      format: "markdown",
    });
    expect(calls).toHaveLength(1);
  });

  it("accepts format=json", async () => {
    const { ky, calls, setResponse } = fakeKy();
    setResponse({ sections: [] });
    await callPaperTool(ky, "get_paper_fulltext", {
      paper_id: "abc",
      format: "json",
    });
    expect(calls).toHaveLength(1);
  });
});

// ─── get_paper_citations ────────────────────────────────────────────────────

describe("get_paper_citations input validation", () => {
  it("rejects unknown direction value", async () => {
    const { ky, calls } = fakeKy();
    await expectZodReject(
      () =>
        callPaperTool(ky, "get_paper_citations", {
          paper_id: "abc",
          direction: "sideways" as unknown as "cited_by",
        }),
      calls,
    );
  });

  it("accepts direction=cited_by|cites", async () => {
    const { ky, calls, setResponse } = fakeKy();
    setResponse({ citations: [] });
    for (const d of ["cited_by", "cites"] as const) {
      await callPaperTool(ky, "get_paper_citations", {
        paper_id: "abc",
        direction: d,
      });
    }
    expect(calls).toHaveLength(2);
  });
});

// ─── list_conferences ───────────────────────────────────────────────────────

describe("list_conferences input validation", () => {
  it("accepts no args", async () => {
    const { ky, calls, setResponse } = fakeKy();
    setResponse({ conferences: [] });
    await callPaperTool(ky, "list_conferences", {});
    expect(calls).toHaveLength(1);
  });

  it("accepts a category filter", async () => {
    const { ky, calls, setResponse } = fakeKy();
    setResponse({ conferences: [] });
    await callPaperTool(ky, "list_conferences", { category: "ml" });
    expect(calls).toHaveLength(1);
  });
});

// ─── get_conference_papers ──────────────────────────────────────────────────

describe("get_conference_papers input validation", () => {
  it("rejects empty conference name", async () => {
    const { ky, calls } = fakeKy();
    await expectZodReject(
      () =>
        callPaperTool(ky, "get_conference_papers", {
          conference: "",
        }),
      calls,
    );
  });

  it("rejects out-of-range year", async () => {
    const { ky, calls } = fakeKy();
    await expectZodReject(
      () =>
        callPaperTool(ky, "get_conference_papers", {
          conference: "NeurIPS",
          year: 1000,
        }),
      calls,
    );
  });

  it("rejects negative offset", async () => {
    const { ky, calls } = fakeKy();
    await expectZodReject(
      () =>
        callPaperTool(ky, "get_conference_papers", {
          conference: "NeurIPS",
          offset: -1,
        }),
      calls,
    );
  });

  it("accepts year in valid range + offset=0", async () => {
    const { ky, calls, setResponse } = fakeKy();
    // get_conference_papers fuzzy-resolves the conference short name via
    // a list_conferences pre-call, so a successful invocation is ≥1 call,
    // not exactly 1. The point of this test is "boundary value accepted,
    // a request was issued".
    setResponse({ conferences: [{ short_name: "NeurIPS" }], papers: [] });
    await callPaperTool(ky, "get_conference_papers", {
      conference: "NeurIPS",
      year: 2025,
      offset: 0,
      limit: 20,
    });
    expect(calls.length).toBeGreaterThanOrEqual(1);
  });
});

// ─── search_research_guidance ───────────────────────────────────────────────

describe("search_research_guidance input validation", () => {
  it("rejects empty query", async () => {
    const { ky, calls } = fakeKy();
    await expectZodReject(
      () => callGuidanceTool(ky, "search_research_guidance", { query: "" }),
      calls,
    );
  });

  it("rejects limit > 20", async () => {
    const { ky, calls } = fakeKy();
    await expectZodReject(
      () =>
        callGuidanceTool(ky, "search_research_guidance", {
          query: "ablation",
          limit: 21,
        }),
      calls,
    );
  });

  it("accepts limit boundary 1 and 20", async () => {
    const { ky, calls, setResponse } = fakeKy();
    setResponse({ chunks: [] });
    await callGuidanceTool(ky, "search_research_guidance", {
      query: "x",
      limit: 1,
    });
    await callGuidanceTool(ky, "search_research_guidance", {
      query: "x",
      limit: 20,
    });
    expect(calls).toHaveLength(2);
  });
});

// ─── create_subscription ────────────────────────────────────────────────────

describe("create_subscription input validation", () => {
  it("rejects missing conference", async () => {
    const { ky, calls } = fakeKy();
    await expectZodReject(
      () =>
        callSubsTool(
          ky,
          "subscribe_conference",
          {} as unknown as { conference: string },
        ),
      calls,
    );
  });

  it("rejects empty conference", async () => {
    const { ky, calls } = fakeKy();
    await expectZodReject(
      () => callSubsTool(ky, "subscribe_conference", { conference: "" }),
      calls,
    );
  });

  it("accepts notify_email + notify_in_app booleans", async () => {
    const { ky, calls, setResponse } = fakeKy();
    setResponse({ id: "sub_1" });
    await callSubsTool(ky, "subscribe_conference", {
      conference: "CCS",
      notify_email: true,
      notify_in_app: false,
    });
    expect(calls).toHaveLength(1);
  });

  it("rejects non-boolean notify_email", async () => {
    const { ky, calls } = fakeKy();
    await expectZodReject(
      () =>
        callSubsTool(ky, "subscribe_conference", {
          conference: "CCS",
          notify_email: "yes" as unknown as boolean,
        }),
      calls,
    );
  });
});

// ─── delete_subscription / drain_subscription ───────────────────────────────

describe("subscription mutators input validation", () => {
  it("delete_subscription rejects missing id", async () => {
    const { ky, calls } = fakeKy();
    await expectZodReject(
      () =>
        callSubsTool(
          ky,
          "unsubscribe_conference",
          {} as unknown as { subscription_id: string },
        ),
      calls,
    );
  });

  it("delete_subscription rejects empty id", async () => {
    const { ky, calls } = fakeKy();
    await expectZodReject(
      () =>
        callSubsTool(ky, "unsubscribe_conference", { subscription_id: "" }),
      calls,
    );
  });

  it("get_subscription_updates accepts empty args (no cursor, no id)", async () => {
    const { ky, calls, setResponse } = fakeKy();
    setResponse({ papers: [], next_cursor: null });
    await callSubsTool(ky, "get_subscription_updates", {});
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("subscriptions/updates");
  });
});
