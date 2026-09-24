/**
 * Unit coverage for the tool-registration layer (`src/tools/index.ts`).
 *
 * Exercises `getAllToolDefinitions`, the `dispatchToolCall` router (all three
 * branches), and `registerAllTools` (every `setRequestHandler` wiring plus
 * the handler bodies themselves: tools/list, tools/call, and the empty
 * resources/prompts probes).
 */
import {
  createRecordingServer,
  createServerContext,
} from "../support/mcp-server.js";
import { createFakeKy, httpErrorReply, jsonReply } from "../support/fake-ky.js";
import { callResult, toolText } from "../support/tool-result.js";
import {
  isJsonObject,
  type JsonObject,
  type JsonValue,
} from "../../src/json.js";
import type { MetaObject } from "@modelcontextprotocol/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KyInstance } from "ky";
import {
  dispatchToolCall,
  getAllToolDefinitions,
  listToolsResponse,
  registerAllTools,
  requiredScopeForTool,
} from "../../src/tools/index.js";
import {
  answeredView,
  fixedReleases,
  PUBLIC_RELEASES,
  UNANSWERED_VIEW,
} from "../../src/releases.js";
import { registerResources } from "../../src/resources.js";
import { TOOL_RESPONSE_CACHE } from "../../src/cache.js";
import { GatherEvidenceOutput } from "../../src/tools/_outputs.js";

beforeEach(async () => {
  await TOOL_RESPONSE_CACHE.clear();
});

/** Records every verb call and answers each one with `response`. */
function fakeKy(response: JsonValue = {}): KyInstance {
  return createFakeKy(() => jsonReply(response)).ky;
}

/** ky double whose verbs throw a ky-shaped HTTPError with the given status. */
function erroringKy(status: number, body: JsonValue): KyInstance {
  return createFakeKy(() => httpErrorReply(status, body)).ky;
}

const FIGURES_RELEASED = { figures: true };

const PUBLIC_TOOL_ORDER = [
  "search_papers",
  "search_papers_many",
  "get_paper_fulltext",
  "get_paper_citations",
  "list_conferences",
  "get_conference_papers",
  "search_related_papers",
  "extract_from_papers",
  "verify_claims",
  "gather_evidence",
  "search_research_guidance",
  "get_research_guidance_doc",
];

describe("getAllToolDefinitions", () => {
  it("returns the union of paper, figure and guidance tools", () => {
    const defs = getAllToolDefinitions();
    expect(defs.length).toBe(14);
    const names = defs.map((d) => d.name);
    expect(names).toContain("search_papers");
    // Workspace retrieval is folded into the corpus tools' source="workspace"
    // selector, so there are NO dedicated workspace tools in the public list.
    expect(names).not.toContain("search_workspace");
    expect(names).not.toContain("get_workspace_document");
    expect(names).toContain("search_papers_many");
    expect(names).toContain("extract_from_papers");
    expect(names).toContain("verify_claims");
    expect(names).toContain("gather_evidence");
    expect(names).toContain("search_related_papers");
    expect(names).toContain("search_research_guidance");
    expect(names).toContain("search_figure_references");
    expect(names).toContain("get_paper_figures");
    // Paper metadata is included in search results; these are no longer tools.
    expect(names).not.toContain("get_paper");
    expect(names).not.toContain("get_papers");
    expect(names).not.toContain("find_related_papers");
  });

  it("every definition carries the platform metadata fields", () => {
    for (const d of getAllToolDefinitions()) {
      expect(d.title.length).toBeGreaterThan(0);
      expect(d.annotations).toBeTypeOf("object");
    }
  });

  it("declares the API authorization scope for every gated tool", () => {
    const scopes = Object.fromEntries(
      getAllToolDefinitions().map((definition) => [
        definition.name,
        definition.requiredScope,
      ]),
    );

    expect(scopes).toEqual({
      search_papers: "papers:read",
      search_papers_many: "papers:read",
      get_paper_fulltext: "papers:read",
      get_paper_citations: "papers:read",
      list_conferences: undefined,
      get_conference_papers: undefined,
      search_related_papers: "papers:read",
      extract_from_papers: "papers:read",
      verify_claims: "papers:read",
      gather_evidence: "papers:read",
      search_research_guidance: "guidance:read",
      get_research_guidance_doc: "guidance:read",
      search_figure_references: "papers:read",
      get_paper_figures: "papers:read",
    });
  });
});

describe("credential-aware tools/list (workspace source hiding)", () => {
  const SOURCE_TOOLS = [
    "search_papers",
    "get_paper_fulltext",
    "extract_from_papers",
    "verify_claims",
    "gather_evidence",
  ];

  /** The advertised JSON Schema's `properties` map, or {} when it declares none. */
  function props(tool: { inputSchema: JsonValue }): JsonObject {
    const schema = tool.inputSchema;

    if (!isJsonObject(schema)) return {};
    const properties = schema["properties"];

    return isJsonObject(properties) ? properties : {};
  }

  it("exposes the source selector to a workspace credential", () => {
    const tools = listToolsResponse(true).tools;

    for (const name of SOURCE_TOOLS) {
      const t = tools.find((x) => x.name === name)!;
      expect("source" in props(t), `${name} should expose source`).toBe(true);
    }
  });

  it("strips the source selector entirely for a non-workspace credential", () => {
    const tools = listToolsResponse(false).tools;

    for (const name of SOURCE_TOOLS) {
      const t = tools.find((x) => x.name === name)!;
      expect(
        "source" in props(t),
        `${name} must NOT expose source externally`,
      ).toBe(false);
    }

    // Same tool set either way; only the source property differs.
    expect(tools.length).toBe(listToolsResponse(true).tools.length);
  });

  it("leaves non-source tools byte-identical regardless of credential", () => {
    const a = listToolsResponse(true).tools.find(
      (t) => t.name === "get_paper_citations",
    )!;

    const b = listToolsResponse(false).tools.find(
      (t) => t.name === "get_paper_citations",
    )!;

    expect(JSON.stringify(a.inputSchema)).toBe(JSON.stringify(b.inputSchema));
  });

  it("the non-workspace catalog mentions 'workspace' NOWHERE; the workspace one does", () => {
    // The whole point of the gate: an external client sees zero trace of the
    // workspace surface (no tool, no param, no describe); a workspace one does.
    expect(
      JSON.stringify(listToolsResponse(false)).toLowerCase(),
    ).not.toContain("workspace");
    expect(JSON.stringify(listToolsResponse(true)).toLowerCase()).toContain(
      "workspace",
    );
  });
});

describe("alwaysLoad entry tools (tool-selection: get picked over web_search)", () => {
  // Entry tools carry `_meta["anthropic/alwaysLoad"]` so a client running MCP
  // tool search keeps them un-deferred. Why three: the MCP server design notes.
  const ENTRY_TOOLS = [
    "search_papers",
    "search_papers_many",
    "search_research_guidance",
  ];

  function alwaysLoad(tool: { _meta?: MetaObject | undefined }): boolean {
    return tool._meta?.["anthropic/alwaysLoad"] === true;
  }

  it("marks exactly the three entry tools as always-loaded, and no others", () => {
    const { tools } = listToolsResponse();

    const flagged = tools
      .filter(alwaysLoad)
      .map((t) => t.name)
      .sort();

    expect(flagged).toEqual([...ENTRY_TOOLS].sort());

    // Non-entry tools must not emit `_meta` at all (no accidental spread).
    for (const t of tools) {
      if (!ENTRY_TOOLS.includes(t.name)) expect(t._meta).toBeUndefined();
    }
  });

  it("search_papers_many leads with the literature-sweep trigger and disambiguates from search_papers", () => {
    const t = getAllToolDefinitions().find(
      (d) => d.name === "search_papers_many",
    )!;

    // Front-loaded intent + the prefer-over-web_search trigger survive Claude
    // Code's 2KB description truncation only if they are near the start.
    expect(t.description.slice(0, 400)).toMatch(/literature sweep/i);
    expect(t.description.slice(0, 400)).toContain("web_search");
    // Cross-reference that routes single questions to the cheaper entry tool.
    expect(t.description).toContain("use `search_papers` instead");
  });
});

describe("deterministic tools/list ordering", () => {
  it("returns the public tools in a deterministic order across calls", () => {
    // 2026-07-28 SHOULD: a stable order lets clients cache the catalogue and is
    // the precondition for the `tools/list` hint, so pin the order itself.
    expect(listToolsResponse(true).tools.map((t) => t.name)).toEqual(
      PUBLIC_TOOL_ORDER,
    );
  });

  it("slots the figure tools in before guidance once Figures is released", () => {
    expect(
      listToolsResponse(true, FIGURES_RELEASED).tools.map((t) => t.name),
    ).toEqual([
      "search_papers",
      "search_papers_many",
      "get_paper_fulltext",
      "get_paper_citations",
      "list_conferences",
      "get_conference_papers",
      "search_related_papers",
      "extract_from_papers",
      "verify_claims",
      "gather_evidence",
      "search_figure_references",
      "get_paper_figures",
      "search_research_guidance",
      "get_research_guidance_doc",
    ]);
  });
});

describe("per-credential releases", () => {
  it("hides an unreleased tool from the scope gate, as it would an unknown one", () => {
    expect(
      requiredScopeForTool("search_figure_references", PUBLIC_RELEASES),
    ).toBeUndefined();
    expect(requiredScopeForTool("definitely_not_a_tool", PUBLIC_RELEASES)).toBe(
      undefined,
    );
    expect(
      requiredScopeForTool("search_figure_references", FIGURES_RELEASED),
    ).toBe("papers:read");
    expect(requiredScopeForTool("search_papers", PUBLIC_RELEASES)).toBe(
      "papers:read",
    );
  });

  it.each(["search_figure_references", "get_paper_figures"])(
    "refuses unreleased %s exactly like an unknown tool, before any upstream call",
    async (name) => {
      const upstream = createFakeKy(() => jsonReply({}));

      await expect(
        dispatchToolCall(upstream.ky, name, { query: "x", paper_id: "p" }),
      ).rejects.toMatchObject({
        code: -32602,
        message: `Unknown tool: ${name}`,
      });
      expect(upstream.calls).toEqual([]);
    },
  );

  it("dispatches a figure tool once Figures is released", async () => {
    const upstream = createFakeKy(() =>
      jsonReply({ query: "pipeline", total: 0, results: [] }),
    );

    const result = await dispatchToolCall(
      upstream.ky,
      "search_figure_references",
      { query: "pipeline" },
      true,
      FIGURES_RELEASED,
    );

    expect(upstream.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "post figures/search",
    ]);
    expect(result.structuredContent).toEqual({
      query: "pipeline",
      total: 0,
      results: [],
    });
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

  it("gather_evidence posts to evidence/gather and passes through a schema-valid response", async () => {
    // Includes the null-valued fields, so this pins that the advertised output
    // schema accepts the pass-through structuredContent rather than rejecting.
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
          future_nested_field: "preserved",
        },
      ],
      next_queries: [],
      stop_reason: "sufficient",
      draft_support: null,
      queries_failed: [],
      iterations_run: 1,
      queries_run: 1,
      units_charged: 1,
      future_additive_field: "preserved",
    };

    expect(() => GatherEvidenceOutput.parse(response)).not.toThrow();

    const recording = createFakeKy(() => jsonReply(response));

    const r = await dispatchToolCall(recording.ky, "gather_evidence", {
      task: "t",
      queries: ["a"],
    });

    expect(recording.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "post evidence/gather",
    ]);
    expect(r.structuredContent).toEqual(response);
  });

  it("throws for an unknown tool name", async () => {
    await expect(
      dispatchToolCall(fakeKy(), "definitely_not_a_tool", {}),
    ).rejects.toMatchObject({
      code: -32602,
      message: "Unknown tool: definitely_not_a_tool",
    });
  });

  it("returns model-readable errors for invalid tool arguments", async () => {
    const result = await dispatchToolCall(fakeKy(), "search_papers", {
      query: "",
    });

    expect(result.isError).toBe(true);
    expect(toolText(result)).toContain("query");
    expect(toolText(result)).toContain("Correct the named arguments");
  });

  it.each([
    ["search_papers", { query: "x".repeat(501) }, "query"],
    ["search_papers_many", { queries: ["x".repeat(2001)] }, "queries"],
    ["search_research_guidance", { query: "x".repeat(501) }, "query"],
    [
      "extract_from_papers",
      {
        paper_ids: ["paper-1"],
        fields: [{ name: "dataset", type: "string" }],
        instruction: "x".repeat(2001),
      },
      "instruction",
    ],
    ["verify_claims", { claims: ["x".repeat(2001)] }, "claims"],
    ["gather_evidence", { task: "x".repeat(2001), queries: ["valid"] }, "task"],
    [
      "gather_evidence",
      { task: "valid", queries: ["valid"], draft: "x".repeat(8001) },
      "draft",
    ],
  ])("mirrors the API length bound for %s", async (name, args, field) => {
    const result = await dispatchToolCall(fakeKy(), name, args);
    expect(result.isError).toBe(true);
    expect(toolText(result)).toContain(field);
  });

  it("rejects arguments excluded by the advertised additionalProperties contract", async () => {
    const result = await dispatchToolCall(fakeKy(), "search_papers", {
      query: "valid",
      invented: true,
    });

    expect(result.isError).toBe(true);
    expect(toolText(result)).toContain("additional properties");
  });

  it("returns a model-readable error when successful output violates outputSchema", async () => {
    const result = await dispatchToolCall(fakeKy({}), "extract_from_papers", {
      paper_ids: ["paper-1"],
      fields: [{ name: "dataset", type: "string" }],
      instruction: "Extract the dataset.",
    });

    expect(result.isError).toBe(true);
    expect(toolText(result)).toContain("structuredContent");
    expect(toolText(result)).toContain("Stop retrying");
    expect(toolText(result)).toContain("error_type=output_schema_violation");
  });
});

describe("registerAllTools", () => {
  it("wires two request handlers onto the server", () => {
    // registerAllTools owns tools/list + tools/call only; resources/list comes
    // from registerResources and the prompts pair from registerPrompts.
    const server = createRecordingServer();
    // Diffed against the SDK's own constructor-time registrations, so the
    // assertion states what registerAllTools adds rather than what Server has.
    const before = new Set(server.registeredMethods());
    registerAllTools(server, () => fakeKy());

    const added = server
      .registeredMethods()
      .filter((method) => !before.has(method));

    expect(added.sort()).toEqual(["tools/call", "tools/list"]);
  });

  it("the tools/list handler returns the public catalog by default", async () => {
    const server = createRecordingServer();
    registerAllTools(server, () => fakeKy());

    const res = await server.handler("tools/list")(
      { method: "tools/list" },
      createServerContext({ method: "tools/list" }),
    );

    expect(res.tools.map((t) => t.name)).toEqual(PUBLIC_TOOL_ORDER);
  });

  it("the tools/list handler adds the figure tools for a released credential", async () => {
    const server = createRecordingServer();
    registerAllTools(
      server,
      () => fakeKy(),
      undefined,
      fixedReleases(answeredView(FIGURES_RELEASED)),
    );

    const res = await server.handler("tools/list")(
      { method: "tools/list" },
      createServerContext({ method: "tools/list" }),
    );

    expect(res.tools).toHaveLength(14);
    expect(res.tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(["search_figure_references", "get_paper_figures"]),
    );
  });

  it("the tools/call handler refuses an unreleased figure tool as unknown", async () => {
    const server = createRecordingServer();

    const upstream = createFakeKy(() =>
      jsonReply({ query: "x", total: 0, results: [] }),
    );

    registerAllTools(server, () => upstream.ky);

    await expect(
      server.handler("tools/call")(
        {
          method: "tools/call",
          params: {
            name: "search_figure_references",
            arguments: { query: "x" },
          },
        },
        createServerContext(),
      ),
    ).rejects.toMatchObject({
      code: -32602,
      message: "Unknown tool: search_figure_references",
    });
    expect(upstream.calls).toEqual([]);
  });

  it("the handlers list the public surface but let a figure call reach the API while the API cannot be asked", async () => {
    const server = createRecordingServer();

    const upstream = createFakeKy(() =>
      jsonReply({ query: "x", total: 0, results: [] }),
    );

    registerAllTools(
      server,
      () => upstream.ky,
      () => ({ workspaceCredential: false }),
      fixedReleases(UNANSWERED_VIEW),
    );

    const listed = await server.handler("tools/list")(
      { method: "tools/list" },
      createServerContext({ method: "tools/list" }),
    );

    expect(listed.tools.map((t) => t.name)).toEqual(PUBLIC_TOOL_ORDER);

    const called = callResult(
      await server.handler("tools/call")(
        {
          method: "tools/call",
          params: {
            name: "search_figure_references",
            arguments: { query: "a three-stage pipeline" },
          },
        },
        createServerContext(),
      ),
    );

    expect(called.isError).not.toBe(true);
    expect(upstream.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "post figures/search",
    ]);
  });

  it("the tools/call handler builds a client per request and dispatches", async () => {
    const server = createRecordingServer();
    const makeClient = vi.fn(() => fakeKy({ results: [] }));
    registerAllTools(server, makeClient);
    const callHandler = server.handler("tools/call");

    const res = callResult(
      await callHandler(
        {
          method: "tools/call",
          params: { name: "search_papers", arguments: { query: "x" } },
        },
        createServerContext(),
      ),
    );

    expect(makeClient).toHaveBeenCalledTimes(1);
    expect(res.content[0]!.type).toBe("text");
  });

  it("validates calls against the non-workspace schema it advertised", async () => {
    const server = createRecordingServer();
    registerAllTools(
      server,
      () => fakeKy({ results: [] }),
      () => ({ workspaceCredential: false }),
    );
    const callHandler = server.handler("tools/call");

    const result = callResult(
      await callHandler(
        {
          method: "tools/call",
          params: {
            name: "search_papers",
            arguments: { query: "valid", source: "corpus" },
          },
        },
        createServerContext(),
      ),
    );

    expect(result.isError).toBe(true);
    expect(toolText(result)).toContain("additional properties");
  });

  it("the tools/call handler returns an isError result on a 429 (does not crash the session)", async () => {
    // End-to-end through the registered handler: an upstream 429 must resolve
    // to `{ isError: true }`, never a thrown protocol error the model misses.
    const server = createRecordingServer();
    registerAllTools(server, () =>
      erroringKy(429, { error: "rate_limited", retry_after_seconds: 1 }),
    );
    const callHandler = server.handler("tools/call");

    const res = callResult(
      await callHandler(
        {
          method: "tools/call",
          params: { name: "search_papers", arguments: { query: "x" } },
        },
        createServerContext(),
      ),
    );

    expect(res.isError).toBe(true);
    expect(toolText(res)).toMatch(/rate limited/i);
    expect(toolText(res)).toContain("retry_after_seconds=1");
  });

  it("the tools/call handler returns an isError result on a 402 with buy-credits guidance", async () => {
    const server = createRecordingServer();
    registerAllTools(server, () =>
      erroringKy(402, {
        error: "out_of_credits",
        buy_credits_url: "https://lune/dashboard/settings/billing",
      }),
    );
    const callHandler = server.handler("tools/call");

    const res = callResult(
      await callHandler(
        {
          method: "tools/call",
          params: { name: "search_papers", arguments: { query: "x" } },
        },
        createServerContext(),
      ),
    );

    expect(res.isError).toBe(true);
    expect(toolText(res)).toContain("Lune quota exhausted");
    expect(toolText(res)).toContain("buy_credits_url=");
  });

  it("the tools/call handler defaults missing arguments to an empty object", async () => {
    const server = createRecordingServer();
    registerAllTools(server, () => fakeKy([]));
    const callHandler = server.handler("tools/call");

    const res = callResult(
      await callHandler(
        {
          method: "tools/call",
          params: { name: "list_conferences" },
        },
        createServerContext(),
      ),
    );

    expect(res.structuredContent).toEqual({ conferences: [] });
  });

  it("registerResources wires empty resource and template discovery handlers", async () => {
    const server = createRecordingServer();
    registerResources(server);
    const ctx = createServerContext();
    expect(
      await server.handler("resources/list")({ method: "resources/list" }, ctx),
    ).toEqual({ resources: [] });
    expect(
      await server.handler("resources/templates/list")(
        { method: "resources/templates/list" },
        ctx,
      ),
    ).toEqual({ resourceTemplates: [] });
    await expect(
      server.handler("resources/read")(
        { method: "resources/read", params: { uri: "lune://missing" } },
        ctx,
      ),
    ).rejects.toMatchObject({ code: -32602, data: { uri: "lune://missing" } });
  });
});
