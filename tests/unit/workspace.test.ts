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
import { callPaperTool } from "../../src/tools/papers.js";
import { listToolsResponse } from "../../src/tools/index.js";
import { SearchPapersOutput } from "../../src/tools/_outputs.js";
import { TOOL_RESPONSE_CACHE } from "../../src/cache.js";
import type { JsonValue } from "../../src/json.js";
import {
  callTo,
  createFakeKy,
  jsonBodyOf,
  jsonReply,
} from "../support/fake-ky.js";
import {
  jsonNumber,
  jsonObject,
  jsonObjects,
  jsonStrings,
  parseJsonObject,
} from "../support/json.js";

beforeEach(async () => {
  await TOOL_RESPONSE_CACHE.clear();
});

function recordingKy(response: JsonValue = { results: [] }) {
  return createFakeKy(() => jsonReply(response));
}

function contentText(
  result: Awaited<ReturnType<typeof callPaperTool>>,
): string {
  const content = result.content.at(0);

  if (content?.type !== "text")
    throw new Error("tool returned no text content");

  return content.text;
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
    const post = callTo(calls, "workspaces/search", "post");
    const body = jsonBodyOf(post);
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

    const payload = parseJsonObject(contentText(res));
    const hits = jsonObjects(payload.results, "results");
    expect(hits).toHaveLength(1);
    const hit = jsonObject(hits.at(0), "first result");
    expect(hit.paper_id).toBe("doc-1");
    expect(hit.title).toBe("Design Doc");
    expect(jsonStrings(hit.authors, "authors")).toEqual([]);
    // Both spans of the document become contexts; the hit keeps the strongest
    // rerank score, which also drives best_score.
    expect(jsonObjects(hit.contexts, "contexts")).toHaveLength(2);
    expect(jsonNumber(hit.rerank_score, "rerank_score")).toBe(0.91);
    expect(jsonNumber(payload.best_score, "best_score")).toBe(0.91);
    // Regression: PaperOut's year/conference are `.optional()` (absent or a
    // value, NEVER null), so a workspace doc must OMIT them, not emit null.
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

    const post = callTo(calls, "workspaces/document", "post");
    expect(jsonBodyOf(post)).toMatchObject({
      document_id: "doc-1",
      format: "markdown",
    });
    expect(contentText(res)).toContain("full text");
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
    const post = callTo(calls, "claims/verify");
    expect(jsonBodyOf(post).source).toBe("workspace");
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
    const post = callTo(calls, "papers/extract");
    expect(jsonBodyOf(post).source).toBe("workspace");
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
    const post = callTo(calls, "evidence/gather");
    expect(jsonBodyOf(post).source).toBe("workspace");
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
      const tool = tools.find((candidate) => candidate.name === name);

      if (!tool) throw new Error(`tool list is missing ${name}`);
      const schema = parseJsonObject(JSON.stringify(tool.inputSchema));
      const properties = jsonObject(schema.properties, `${name}.properties`);
      const source = jsonObject(properties.source, `${name}.source`);
      expect(jsonStrings(source.enum, `${name}.source.enum`)).toEqual([
        "corpus",
        "workspace",
      ]);
    }
  });
});
