/**
 * Workspace retrieval is folded into the corpus tools via a `source="workspace"`
 * selector (there are NO dedicated workspace tools). This suite pins the
 * load-bearing routing of that selector through `callPaperTool`:
 *
 *  - `search_papers(source="workspace")` POSTs to `workspaces/search` with only
 *    `{query, limit}` (NEVER a workspace id, which is bound to the credential
 *    server-side) and the flat spans are grouped into corpus-shaped doc hits.
 *  - `get_paper_fulltext(source="workspace")` POSTs to `workspaces/document`.
 *  - `verify_claims` / `extract_from_papers` / `gather_evidence` send `source` in
 *    the request body so the API branches the evidence base.
 *  - corpus stays the default (search_papers -> `search`), and no `search_workspace`
 *    / `get_workspace_document` tool is advertised in the public list.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { KyInstance } from "ky";
import { callPaperTool } from "../../src/tools/papers.js";
import { listToolsResponse } from "../../src/tools/index.js";
import { SearchPapersOutput } from "../../src/tools/_outputs.js";
import { TOOL_RESPONSE_CACHE } from "../../src/cache.js";

beforeEach(async () => {
  await TOOL_RESPONSE_CACHE.clear();
});

/** Records every verb call and returns a thenable `{ json }` matcher. */
function recordingKy(response: unknown = { results: [] }): {
  ky: KyInstance;
  calls: Array<{ method: string; url: string; opts?: { json?: unknown } }>;
} {
  const calls: Array<{
    method: string;
    url: string;
    opts?: { json?: unknown };
  }> = [];
  const make =
    (method: "get" | "post" | "delete") => (url: string, opts?: unknown) => {
      calls.push({ method, url, opts: opts as { json?: unknown } });
      return { json: async () => response } as unknown as Promise<unknown>;
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

const WS_SPANS = {
  results: [
    {
      document_id: "doc-1",
      chunk_id: "chunk-1",
      filename: "design.pdf",
      title: "Design Doc",
      section_name: "Methods",
      text: "the relevant span",
      score: 0.82,
      rerank_score: 0.91,
    },
    {
      document_id: "doc-1",
      chunk_id: "chunk-2",
      filename: "design.pdf",
      title: "Design Doc",
      section_name: "Results",
      text: "a second span from the same doc",
      score: 0.5,
      rerank_score: 0.4,
    },
  ],
};

describe("search_papers source=workspace routing", () => {
  it("POSTs workspaces/search with only {query, limit} (no workspace id)", async () => {
    const { ky, calls } = recordingKy(WS_SPANS);
    await callPaperTool(ky, "search_papers", {
      query: "ablation",
      limit: 7,
      source: "workspace",
      // A model that tries to smuggle a workspace id must not get it on the wire.
      workspace_id: "someone-elses-workspace",
    });
    const post = calls.find((c) => c.method === "post");
    expect(post?.url).toBe("workspaces/search");
    const body = (post?.opts?.json ?? {}) as Record<string, unknown>;
    expect(body).toMatchObject({ query: "ablation", limit: 7 });
    expect("workspace_id" in body).toBe(false);
    // Never touches the corpus search endpoint.
    expect(calls.some((c) => c.url === "search")).toBe(false);
  });

  it("groups flat spans into corpus-shaped doc hits (contexts per document)", async () => {
    const { ky } = recordingKy(WS_SPANS);
    const res = await callPaperTool(ky, "search_papers", {
      query: "x",
      source: "workspace",
    });
    const payload = JSON.parse(res.content[0]!.text as string);
    expect(payload.results).toHaveLength(1);
    const hit = payload.results[0];
    expect(hit.paper_id).toBe("doc-1");
    expect(hit.title).toBe("Design Doc");
    expect(hit.authors).toEqual([]);
    // Both spans of the document become contexts; the hit keeps the strongest
    // rerank score, which also drives best_score.
    expect(hit.contexts).toHaveLength(2);
    expect(hit.rerank_score).toBe(0.91);
    expect(payload.best_score).toBe(0.91);
    // Regression: the workspace hit MUST validate against the advertised
    // outputSchema. PaperOut's year/conference are `.optional()` (absent or a
    // value, NEVER null), so a workspace doc (no bibliographic metadata) must
    // OMIT them; emitting null made a schema-aware client drop the result.
    expect(hit.year).toBeUndefined();
    expect(hit.conference).toBeUndefined();
    expect(SearchPapersOutput.safeParse(res.structuredContent).success).toBe(
      true,
    );
  });

  it("defaults to the corpus search endpoint when source is omitted", async () => {
    const { ky, calls } = recordingKy({ results: [], has_more: false });
    await callPaperTool(ky, "search_papers", { query: "x" });
    expect(calls.some((c) => c.url === "search")).toBe(true);
    expect(calls.some((c) => c.url === "workspaces/search")).toBe(false);
  });
});

describe("get_paper_fulltext source=workspace routing", () => {
  it("POSTs workspaces/document with the document_id (markdown body passthrough)", async () => {
    const { ky, calls } = recordingKy({
      body: "# Design Doc\n\nfull text",
      title: "Design Doc",
    });
    const res = await callPaperTool(ky, "get_paper_fulltext", {
      paper_id: "doc-1",
      source: "workspace",
    });
    const post = calls.find((c) => c.method === "post");
    expect(post?.url).toBe("workspaces/document");
    expect(post?.opts?.json).toMatchObject({
      document_id: "doc-1",
      format: "markdown",
    });
    expect(res.content[0]!.text).toContain("full text");
  });

  it("defaults to the corpus fulltext endpoint when source is omitted", async () => {
    const { ky, calls } = recordingKy({ body: "x" });
    await callPaperTool(ky, "get_paper_fulltext", {
      paper_id: "11111111-1111-1111-1111-111111111111",
    });
    expect(
      calls.some((c) => c.method === "get" && c.url.includes("/fulltext")),
    ).toBe(true);
  });
});

describe("analytical tools forward source in the request body", () => {
  it("verify_claims sends source", async () => {
    const { ky, calls } = recordingKy({ verdicts: [], claims_processed: 0 });
    await callPaperTool(ky, "verify_claims", {
      claims: ["c"],
      source: "workspace",
    });
    const post = calls.find((c) => c.url === "claims/verify");
    expect(
      (post?.opts?.json as Record<string, unknown> | undefined)?.source,
    ).toBe("workspace");
  });

  it("extract_from_papers sends source", async () => {
    const { ky, calls } = recordingKy({
      rows: [],
      papers_processed: 0,
      papers_failed: [],
    });
    await callPaperTool(ky, "extract_from_papers", {
      paper_ids: ["doc-1"],
      fields: [{ name: "x", type: "string" }],
      instruction: "pull x",
      source: "workspace",
    });
    const post = calls.find((c) => c.url === "papers/extract");
    expect(
      (post?.opts?.json as Record<string, unknown> | undefined)?.source,
    ).toBe("workspace");
  });

  it("gather_evidence sends source", async () => {
    const { ky, calls } = recordingKy({
      requirements: [],
      evidence_spans: [],
      next_queries: [],
      stop_reason: "sufficient",
      draft_support: null,
      queries_failed: [],
      iterations_run: 1,
      queries_run: 1,
    });
    await callPaperTool(ky, "gather_evidence", {
      task: "t",
      queries: ["q"],
      source: "workspace",
    });
    const post = calls.find((c) => c.url === "evidence/gather");
    expect(
      (post?.opts?.json as Record<string, unknown> | undefined)?.source,
    ).toBe("workspace");
  });
});

describe("no dedicated workspace tools are advertised", () => {
  it("the public tool list has neither search_workspace nor get_workspace_document", () => {
    const names = listToolsResponse().tools.map((t) => t.name);
    expect(names).not.toContain("search_workspace");
    expect(names).not.toContain("get_workspace_document");
  });

  it("the 5 unified tools expose a source enum (corpus|workspace)", () => {
    const tools = listToolsResponse().tools;
    for (const name of [
      "search_papers",
      "get_paper_fulltext",
      "extract_from_papers",
      "verify_claims",
      "gather_evidence",
    ]) {
      const tool = tools.find((t) => t.name === name)!;
      const schema = tool.inputSchema as {
        properties?: Record<string, { enum?: string[] }>;
      };
      const source = schema.properties?.source;
      expect(source, `${name} should have a source field`).toBeDefined();
      expect(source?.enum).toEqual(["corpus", "workspace"]);
    }
  });
});
