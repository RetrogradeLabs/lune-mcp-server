import { describe, it, expect } from "vitest";
import { listToolsResponse } from "../../src/tools/index.js";
import { jsonObject } from "../support/json.js";

const PUBLIC_TOOL_NAMES = [
  "get_conference_papers",
  "get_paper_citations",
  "get_paper_fulltext",
  "get_research_guidance_doc",
  "list_conferences",
  "search_papers",
  "search_papers_many",
  "extract_from_papers",
  "verify_claims",
  "gather_evidence",
  "search_related_papers",
  "search_research_guidance",
];

const FIGURES_RELEASED = { figures: true };

describe("tool catalog parity", () => {
  it("exposes the 12 public tools with stable names", () => {
    const r = listToolsResponse();
    const names = r.tools.map((t) => t.name).sort();
    expect(names).toEqual([...PUBLIC_TOOL_NAMES].sort());
  });

  it("adds the two figure tools, 14 in all, only where Figures is released", () => {
    const names = listToolsResponse(true, FIGURES_RELEASED)
      .tools.map((t) => t.name)
      .sort();

    expect(names).toEqual(
      [
        ...PUBLIC_TOOL_NAMES,
        "search_figure_references",
        "get_paper_figures",
      ].sort(),
    );
  });

  it("every tool has a JSON schema with type=object", () => {
    const r = listToolsResponse(true, FIGURES_RELEASED);

    for (const t of r.tools) {
      const schema = jsonObject(t.inputSchema, `${t.name} input schema`);
      expect(schema.type).toBe("object");
    }
  });

  it("descriptions are written for agent decision-making", () => {
    const r = listToolsResponse();
    // Sanity-check that the prose actually steers the agent (not just placeholders).
    const search = r.tools.find((t) => t.name === "search_research_guidance");
    expect(search?.description).toMatch(
      /BEFORE recommending experimental design/i,
    );
  });

  it("search_papers advertises the enriched default and paper_id agent hints", () => {
    const r = listToolsResponse();
    const search = r.tools.find((t) => t.name === "search_papers");

    if (!search) throw new Error("search_papers is missing from the catalog");
    // Hint 1: omitted `detail` returns the full abstract + matched `contexts`;
    // `detail: false` opts down to concise mode.
    expect(search.description).toMatch(/detail/);
    expect(search.description).toMatch(
      /abstract.*contexts|contexts.*abstract/i,
    );
    expect(search.description).toMatch(/detail: false/i);
    // Hint 2: paper_id is for fetching full text, not for showing to the user.
    expect(search.description).toMatch(/get_paper_fulltext/);
    expect(search.description).toMatch(
      /not (meant to be|be) shown directly to the user/i,
    );

    // The `detail` knob is exposed on the input schema as a boolean.
    const schema = jsonObject(search.inputSchema, "search_papers input schema");
    const properties = jsonObject(schema.properties, "schema properties");
    const detail = jsonObject(properties.detail, "detail property");
    expect(detail.type).toBe("boolean");
    expect(detail.description).toMatch(/true \(default\).*contexts/i);
    expect(detail.description).toMatch(/false.*concise/i);
    // The deprecated alias was dropped pre-publish; it must NOT be advertised.
    expect(properties.should_include_context).toBeUndefined();
  });

  it("stdio and HTTP transports share the same tool catalog (single source of truth)", () => {
    // Both transports call registerAllTools() which delegates to listToolsResponse(),
    // so the published catalog must match the documented tool set exactly.
    const names = listToolsResponse()
      .tools.map((t) => t.name)
      .sort();

    expect(names).toEqual([...PUBLIC_TOOL_NAMES].sort());
  });

  it("every result-bearing tool advertises an outputSchema (MCP 2025-06-18)", () => {
    const r = listToolsResponse(true, FIGURES_RELEASED);
    // get_paper_fulltext is the only tool whose response shape varies by input
    // (markdown vs JSON sections); every other tool MUST declare outputSchema.
    const exempt = new Set(["get_paper_fulltext"]);

    for (const t of r.tools) {
      if (exempt.has(t.name)) {
        expect(
          t.outputSchema,
          `${t.name} should not declare an outputSchema`,
        ).toBeUndefined();
        continue;
      }

      const output = jsonObject(t.outputSchema, `${t.name} output schema`);
      expect(output.type, `${t.name} outputSchema must be an object`).toBe(
        "object",
      );
    }
  });
});
