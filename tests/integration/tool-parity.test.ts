import { describe, it, expect } from "vitest";
import { listToolsResponse } from "../../src/tools/index.js";

describe("tool catalog parity", () => {
  it("exposes the 16 documented tools with stable names", () => {
    const r = listToolsResponse();
    const names = r.tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "get_subscription_updates",
        "subscribe_conference",
        "unsubscribe_conference",
        "get_conference_papers",
        "get_paper_citations",
        "get_paper_fulltext",
        "get_research_guidance_doc",
        "list_subscriptions",
        "list_conferences",
        "search_papers",
        "search_papers_many",
        "extract_from_papers",
        "verify_claims",
        "gather_evidence",
        "search_related_papers",
        "search_research_guidance",
      ].sort(),
    );
  });

  it("every tool has a JSON schema with type=object", () => {
    const r = listToolsResponse();
    for (const t of r.tools) {
      expect(t.inputSchema).toBeTypeOf("object");
      // zod-to-json-schema renders an object schema for z.object(...)
      const schema = t.inputSchema as { type?: string; properties?: unknown };
      expect(schema.type).toBe("object");
    }
  });

  it("descriptions are written for agent decision-making", () => {
    const r = listToolsResponse();
    // Sanity-check that the prose actually steers the agent (not just placeholders).
    const search = r.tools.find((t) => t.name === "search_research_guidance");
    expect(search?.description).toMatch(/BEFORE recommending experimental design/i);
    const drain = r.tools.find((t) => t.name === "get_subscription_updates");
    expect(drain?.description).toMatch(/cursor|next_cursor/i);
  });

  it("search_papers advertises the enriched default and paper_id agent hints", () => {
    const r = listToolsResponse();
    const search = r.tools.find((t) => t.name === "search_papers")!;
    // Hint 1: omitted `detail` returns the full abstract + matched `contexts`;
    // `detail: false` opts down to concise mode.
    expect(search.description).toMatch(/detail/);
    expect(search.description).toMatch(/abstract.*contexts|contexts.*abstract/i);
    expect(search.description).toMatch(/detail: false/i);
    // Hint 2: paper_id is for fetching full text, not for showing to the user.
    expect(search.description).toMatch(/get_paper_fulltext/);
    expect(search.description).toMatch(/not (meant to be|be) shown directly to the user/i);

    // The `detail` knob is exposed on the input schema as a boolean.
    const schema = search.inputSchema as {
      properties?: {
        detail?: { type?: string; description?: string };
        should_include_context?: { type?: string; description?: string };
      };
    };
    expect(schema.properties?.detail?.type).toBe("boolean");
    expect(schema.properties?.detail?.description).toMatch(/true \(default\).*contexts/i);
    expect(schema.properties?.detail?.description).toMatch(/false.*concise/i);
    // The deprecated alias was dropped pre-publish; it must NOT be advertised.
    expect(schema.properties?.should_include_context).toBeUndefined();
  });

  it("stdio and HTTP transports share the same tool catalog (single source of truth)", () => {
    // Both transports call registerAllTools() which delegates to listToolsResponse().
    // Calling it twice should be deterministic.
    const a = listToolsResponse();
    const b = listToolsResponse();
    expect(a.tools.map((t) => t.name)).toEqual(b.tools.map((t) => t.name));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("every result-bearing tool advertises an outputSchema (MCP 2025-06-18)", () => {
    const r = listToolsResponse();
    // get_paper_fulltext is the only tool whose response shape varies by
    // input (markdown text vs JSON sections), so it intentionally omits
    // outputSchema. Every other tool MUST declare one or the ChatGPT
    // connector UI raises a "missing output schema" recommendation.
    const exempt = new Set(["get_paper_fulltext"]);
    for (const t of r.tools) {
      const tool = t as { name: string; outputSchema?: { type?: string } };
      if (exempt.has(tool.name)) {
        expect(tool.outputSchema, `${tool.name} should not declare an outputSchema`).toBeUndefined();
        continue;
      }
      expect(tool.outputSchema, `${tool.name} is missing outputSchema`).toBeDefined();
      expect(tool.outputSchema?.type, `${tool.name} outputSchema must be an object`).toBe(
        "object",
      );
    }
  });
});
