import { describe, it, expect } from "vitest";
import { listToolsResponse } from "../../src/tools/index.js";

describe("tool catalog parity", () => {
  it("exposes the 12 documented tools with stable names", () => {
    const r = listToolsResponse();
    const names = r.tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "check_for_conference_updates",
        "subscribe_to_conference_updates",
        "unsubscribe_from_conference_updates",
        "get_conference_papers",
        "get_paper",
        "get_paper_citations",
        "get_paper_fulltext",
        "get_research_guidance_doc",
        "list_conference_update_subscriptions",
        "list_conferences",
        "search_papers",
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
    const drain = r.tools.find((t) => t.name === "check_for_conference_updates");
    expect(drain?.description).toMatch(/cursor|next_cursor/i);
  });

  it("search_papers advertises the should_include_context + paper_id agent hints", () => {
    const r = listToolsResponse();
    const search = r.tools.find((t) => t.name === "search_papers")!;
    // Hint 1: should_include_context true returns the matched text chunks.
    expect(search.description).toMatch(/should_include_context/);
    expect(search.description).toMatch(/contexts|matched text chunks/i);
    // Hint 2: paper_id is for fetching full text, not for showing to the user.
    expect(search.description).toMatch(/get_paper_fulltext/);
    expect(search.description).toMatch(/not (meant to be|be) shown directly to the user/i);

    // The flag is also exposed on the input schema with a default of false.
    const schema = search.inputSchema as {
      properties?: { should_include_context?: { type?: string; default?: boolean; description?: string } };
    };
    const flag = schema.properties?.should_include_context;
    expect(flag?.type).toBe("boolean");
    expect(flag?.default).toBe(false);
    expect(flag?.description).toMatch(/matched text chunks|exact contexts/i);
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
