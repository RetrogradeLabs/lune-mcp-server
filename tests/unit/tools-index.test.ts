/**
 * Unit coverage for the tool-registration layer (`src/tools/index.ts`).
 *
 * Exercises `getAllToolDefinitions`, the `dispatchToolCall` router (all four
 * branches), and `registerAllTools` (every `setRequestHandler` wiring plus
 * the handler bodies themselves: tools/list, tools/call, and the empty
 * resources/prompts probes).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KyInstance } from "ky";
import {
  dispatchToolCall,
  getAllToolDefinitions,
  listToolsResponse,
  registerAllTools,
} from "../../src/tools/index.js";
import { TOOL_RESPONSE_CACHE } from "../../src/cache.js";
import { GatherEvidenceOutput } from "../../src/tools/_outputs.js";

beforeEach(async () => {
  await TOOL_RESPONSE_CACHE.clear();
});

/** Records every verb call and returns a thenable `{ json }` matcher. */
function fakeKy(response: unknown = {}): KyInstance {
  const make = () => () => ({ json: async () => response }) as unknown as Promise<unknown>;
  return {
    get: make(),
    post: make(),
    delete: make(),
    put: make(),
  } as unknown as KyInstance;
}

/** ky double whose verbs throw a ky-shaped HTTPError with the given status. */
function erroringKy(status: number, body: unknown): KyInstance {
  const make = () => () =>
    ({
      json: async () => {
        throw {
          response: {
            status,
            headers: new Headers(),
            json: async () => body,
          },
        };
      },
    }) as unknown as Promise<unknown>;
  return {
    get: make(),
    post: make(),
    delete: make(),
    put: make(),
  } as unknown as KyInstance;
}

describe("getAllToolDefinitions", () => {
  it("returns the union of paper, guidance, and subscription tools", () => {
    const defs = getAllToolDefinitions();
    expect(defs.length).toBe(16);
    const names = defs.map((d) => d.name);
    expect(names).toContain("search_papers");
    expect(names).toContain("search_papers_many");
    expect(names).toContain("extract_from_papers");
    expect(names).toContain("verify_claims");
    expect(names).toContain("gather_evidence");
    expect(names).toContain("search_related_papers");
    expect(names).toContain("search_research_guidance");
    expect(names).toContain("get_subscription_updates");
    // Paper metadata is included in search results; these are no longer tools.
    expect(names).not.toContain("get_paper");
    expect(names).not.toContain("get_papers");
    expect(names).not.toContain("find_related_papers");
  });

  it("every definition carries the platform metadata fields", () => {
    for (const d of getAllToolDefinitions()) {
      expect(d.title.length).toBeGreaterThan(0);
      expect(d.annotations).toBeTypeOf("object");
      expect(Array.isArray(d.scopes)).toBe(true);
    }
  });
});

describe("alwaysLoad entry tools (tool-selection: get picked over web_search)", () => {
  // The cold-start entry tools carry `_meta["anthropic/alwaysLoad"]` so clients
  // that run MCP tool search (Claude Code) keep them un-deferred; their full
  // descriptions (which carry the "use this for research, not web_search"
  // trigger) are then in context from session start, not behind a ToolSearch
  // hop. Every OTHER tool stays deferrable so context isn't burned. One entry
  // per cold-start research intent: single-question, literature sweep,
  // methodology. See .claude/rules/mcp.md (tool selection).
  const ENTRY_TOOLS = ["search_papers", "search_papers_many", "search_research_guidance"];

  function alwaysLoad(t: { _meta?: unknown }): boolean {
    return (t._meta as Record<string, unknown> | undefined)?.["anthropic/alwaysLoad"] === true;
  }

  it("marks exactly the three entry tools as always-loaded, and no others", () => {
    const tools = listToolsResponse().tools as Array<{ name: string; _meta?: unknown }>;
    const flagged = tools.filter(alwaysLoad).map((t) => t.name).sort();
    expect(flagged).toEqual([...ENTRY_TOOLS].sort());
    // Non-entry tools must not emit `_meta` at all (no accidental spread).
    for (const t of tools) {
      if (!ENTRY_TOOLS.includes(t.name)) expect(t._meta).toBeUndefined();
    }
  });

  it("search_papers_many leads with the literature-sweep trigger and disambiguates from search_papers", () => {
    const t = getAllToolDefinitions().find((d) => d.name === "search_papers_many")!;
    // Front-loaded intent + the prefer-over-web_search trigger survive Claude
    // Code's 2KB description truncation only if they are near the start.
    expect(t.description.slice(0, 400)).toMatch(/literature sweep/i);
    expect(t.description.slice(0, 400)).toContain("web_search");
    // Cross-reference that routes single questions to the cheaper entry tool.
    expect(t.description).toContain("use `search_papers` instead");
  });
});

describe("dispatchToolCall", () => {
  it("routes paper-tool names to the paper handler", async () => {
    const r = await dispatchToolCall(fakeKy({ results: [] }), "search_papers", {
      query: "x",
    });
    expect(r.content[0]!.type).toBe("text");
  });

  it("routes guidance-tool names to the guidance handler", async () => {
    const r = await dispatchToolCall(
      fakeKy({ results: [] }),
      "search_research_guidance",
      { query: "ablation" },
    );
    expect(r.structuredContent).toEqual({ results: [] });
  });

  it("routes subscription-tool names to the subscription handler", async () => {
    const r = await dispatchToolCall(
      fakeKy([]),
      "list_subscriptions",
      {},
    );
    expect(r.structuredContent).toEqual({ subscriptions: [] });
  });

  it("gather_evidence posts to evidence/gather and passes through a schema-valid response", async () => {
    // Includes the null-valued fields (chunk_id, year, conference, rerank_score,
    // draft_support) so this pins that the advertised output schema accepts the
    // pass-through structuredContent rather than rejecting JSON nulls.
    const response = {
      requirements: [
        {
          key: "answer_task",
          description: "d",
          status: "covered",
          supporting_span_ids: ["s1"],
          supporting_quote: "q",
          confidence: 0.9,
          reasoning: "r",
        },
      ],
      evidence_spans: [
        {
          span_id: "s1",
          source: "papers",
          span_kind: "abstract",
          paper_id: "p1",
          chunk_id: null,
          title: "T",
          authors: ["A"],
          year: null,
          conference: null,
          section: "Abstract",
          quote: "q",
          score: 1,
          rerank_score: null,
          matched_queries: [{ query: "a", rank: 1 }],
        },
      ],
      next_queries: [],
      stop_reason: "sufficient",
      draft_support: null,
      queries_failed: [],
      iterations_run: 1,
      queries_run: 1,
      units_charged: 1,
    };
    expect(() => GatherEvidenceOutput.parse(response)).not.toThrow();

    let postedPath: string | undefined;
    const recordingKy = {
      get: () => ({ json: async () => response }),
      post: (path: string) => {
        postedPath = path;
        return { json: async () => response };
      },
      delete: () => ({ json: async () => response }),
      put: () => ({ json: async () => response }),
    } as unknown as KyInstance;

    const r = await dispatchToolCall(recordingKy, "gather_evidence", {
      task: "t",
      queries: ["a"],
    });
    expect(postedPath).toBe("evidence/gather");
    expect(r.structuredContent).toEqual(response);
  });

  it("throws for an unknown tool name", async () => {
    await expect(
      dispatchToolCall(fakeKy(), "definitely_not_a_tool", {}),
    ).rejects.toThrow(/unknown tool/);
  });
});

describe("registerAllTools", () => {
  /** Captures handlers keyed by the schema object passed to setRequestHandler. */
  function captureServer(): {
    server: { setRequestHandler: (schema: unknown, handler: unknown) => void };
    handlers: Map<unknown, (req: unknown) => Promise<unknown>>;
  } {
    const handlers = new Map<unknown, (req: unknown) => Promise<unknown>>();
    return {
      server: {
        setRequestHandler: (schema, handler) => {
          handlers.set(schema, handler as (req: unknown) => Promise<unknown>);
        },
      },
      handlers,
    };
  }

  it("wires three request handlers onto the server", () => {
    // tools/list, tools/call, resources/list. The prompts/list + prompts/get
    // handlers are wired separately by registerPrompts (see prompts.test.ts).
    const { server, handlers } = captureServer();
    registerAllTools(
      server as unknown as Parameters<typeof registerAllTools>[0],
      () => fakeKy(),
    );
    expect(handlers.size).toBe(3);
  });

  it("the tools/list handler returns the full tool catalog", async () => {
    const { server, handlers } = captureServer();
    registerAllTools(
      server as unknown as Parameters<typeof registerAllTools>[0],
      () => fakeKy(),
    );
    // The first registered handler is tools/list.
    const [listToolsHandler] = [...handlers.values()];
    const res = (await listToolsHandler!({})) as ReturnType<typeof listToolsResponse>;
    expect(res.tools.map((t) => t.name).sort()).toEqual(
      listToolsResponse().tools.map((t) => t.name).sort(),
    );
  });

  it("the tools/call handler builds a client per request and dispatches", async () => {
    const { server, handlers } = captureServer();
    const makeClient = vi.fn(() => fakeKy({ results: [] }));
    registerAllTools(
      server as unknown as Parameters<typeof registerAllTools>[0],
      makeClient,
    );
    const callHandler = [...handlers.values()][1]!;
    const res = (await callHandler({
      params: { name: "search_papers", arguments: { query: "x" } },
    })) as { content: Array<{ type: string }> };
    expect(makeClient).toHaveBeenCalledTimes(1);
    expect(res.content[0]!.type).toBe("text");
  });

  it("the tools/call handler returns an isError result on a 429 (does not crash the session)", async () => {
    // End-to-end through the registered tools/call handler: an upstream 429
    // must come back as a resolved { isError: true } tool result, never a
    // thrown JSON-RPC error. A throw here would surface to the client as a
    // protocol error the model never sees (and could abort the turn).
    const { server, handlers } = captureServer();
    registerAllTools(
      server as unknown as Parameters<typeof registerAllTools>[0],
      () => erroringKy(429, { error: "rate_limited", retry_after_seconds: 1 }),
    );
    const callHandler = [...handlers.values()][1]!;
    const res = (await callHandler({
      params: { name: "search_papers", arguments: { query: "x" } },
    })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/rate limited/i);
    expect(res.content[0]!.text).toContain("retry_after_seconds=1");
  });

  it("the tools/call handler returns an isError result on a 402 with buy-credits guidance", async () => {
    const { server, handlers } = captureServer();
    registerAllTools(
      server as unknown as Parameters<typeof registerAllTools>[0],
      () =>
        erroringKy(402, {
          error: "out_of_credits",
          buy_credits_url: "https://lune/dashboard/settings/billing",
        }),
    );
    const callHandler = [...handlers.values()][1]!;
    const res = (await callHandler({
      params: { name: "search_papers", arguments: { query: "x" } },
    })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("Quota exhausted");
    expect(res.content[0]!.text).toContain("buy_credits_url=");
  });

  it("the tools/call handler defaults missing arguments to an empty object", async () => {
    const { server, handlers } = captureServer();
    registerAllTools(
      server as unknown as Parameters<typeof registerAllTools>[0],
      () => fakeKy([]),
    );
    const callHandler = [...handlers.values()][1]!;
    const res = (await callHandler({
      params: { name: "list_subscriptions" },
    })) as { structuredContent: unknown };
    expect(res.structuredContent).toEqual({ subscriptions: [] });
  });

  it("the resources/list handler returns an empty array", async () => {
    const { server, handlers } = captureServer();
    registerAllTools(
      server as unknown as Parameters<typeof registerAllTools>[0],
      () => fakeKy(),
    );
    // tools/list (0), tools/call (1), resources/list (2).
    const resourcesHandler = [...handlers.values()][2]!;
    expect(await resourcesHandler({})).toEqual({ resources: [] });
  });
});
