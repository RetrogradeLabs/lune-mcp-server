/**
 * Unit coverage for the MCP Prompts (research workflows). Asserts the public
 * `prompts/list` projection, `prompts/get` rendering + argument handling, and
 * that each prompt actually orchestrates the Lune tools its workflow needs
 * (a non-vacuous guard so a prompt can't silently drift into empty guidance).
 */
import { describe, expect, it } from "vitest";
import { PROMPTS, getPromptResult, listPrompts, registerPrompts } from "../../src/prompts.js";

const text = (name: string, args: Record<string, string>) =>
  getPromptResult(name, args).messages[0]!.content.text;

describe("listPrompts", () => {
  it("projects every prompt with name, title, description, and arguments", () => {
    const { prompts } = listPrompts();
    expect(prompts).toHaveLength(PROMPTS.length);
    for (const p of prompts) {
      expect(p.name).toMatch(/^[a-z_]+$/);
      expect(p.title.length).toBeGreaterThan(0);
      expect(p.description.length).toBeGreaterThan(0);
      expect(Array.isArray(p.arguments)).toBe(true);
    }
  });

  it("exposes exactly the six research workflows", () => {
    expect(listPrompts().prompts.map((p) => p.name).sort()).toEqual(
      [
        "compare_papers",
        "find_related_work",
        "literature_review",
        "research_methodology",
        "trace_citations",
        "verify_draft",
      ].sort(),
    );
  });
});

describe("getPromptResult rendering", () => {
  it("returns a single user/text message", () => {
    const res = getPromptResult("verify_draft", { draft: "Transformers were introduced in 2017." });
    expect(res.messages).toHaveLength(1);
    expect(res.messages[0]!.role).toBe("user");
    expect(res.messages[0]!.content.type).toBe("text");
  });

  it("interpolates required and optional arguments", () => {
    const t = text("literature_review", {
      topic: "mixture-of-experts routing",
      venues: "NeurIPS, ICLR",
      since_year: "2022",
    });
    expect(t).toContain("mixture-of-experts routing");
    expect(t).toContain("NeurIPS, ICLR");
    expect(t).toContain("2022");
  });

  it("omits optional clauses cleanly when not supplied (no stray placeholders)", () => {
    const t = text("literature_review", { topic: "graph neural networks for molecules" });
    expect(t).toContain("graph neural networks for molecules");
    expect(t).not.toMatch(/\bundefined\b/);
    expect(t).not.toMatch(/\[(venues|scope|since)/i);
    // The scope sentence (venues / year) is absent.
    expect(t).not.toContain("Scope it to these venues");
    expect(t).not.toContain("Focus on work from");
  });

  it("falls back to default columns when compare_papers omits them", () => {
    const withCols = text("compare_papers", { topic: "x", columns: "dataset, accuracy" });
    const without = text("compare_papers", { topic: "x" });
    expect(withCols).toContain("dataset, accuracy");
    expect(without).toContain("most informative columns");
  });
});

describe("getPromptResult validation", () => {
  it("throws on an unknown prompt", () => {
    expect(() => getPromptResult("does_not_exist", {})).toThrow(/unknown prompt/);
  });

  it("throws when a required argument is missing or blank", () => {
    expect(() => getPromptResult("verify_draft", {})).toThrow(/missing required argument: draft/);
    expect(() => getPromptResult("verify_draft", { draft: "   " })).toThrow(/missing required/);
  });
});

describe("each workflow orchestrates the tools it needs", () => {
  // The whole value of a prompt is steering the agent to the right multi-tool
  // workflow; assert the load-bearing tool names are present in each.
  const EXPECT: Record<string, string[]> = {
    literature_review: ["search_papers_many", "get_paper_fulltext"],
    find_related_work: ["search_papers", "search_related_papers", "get_paper_citations"],
    compare_papers: ["extract_from_papers"],
    verify_draft: ["verify_claims"],
    trace_citations: ["get_paper_citations", "search_related_papers"],
    research_methodology: ["search_research_guidance"],
  };
  for (const [name, tools] of Object.entries(EXPECT)) {
    it(`${name} references ${tools.join(", ")}`, () => {
      // Fill every required arg with a placeholder so rendering succeeds.
      const def = PROMPTS.find((p) => p.name === name)!;
      const args: Record<string, string> = {};
      for (const a of def.arguments) if (a.required) args[a.name] = "placeholder";
      const t = text(name, args);
      for (const tool of tools) expect(t).toContain(tool);
    });
  }
});

describe("registerPrompts", () => {
  it("wires the prompts/list and prompts/get handlers", () => {
    const handlers: unknown[] = [];
    const server = {
      setRequestHandler: (_schema: unknown, handler: unknown) => handlers.push(handler),
    };
    registerPrompts(server as unknown as Parameters<typeof registerPrompts>[0]);
    expect(handlers).toHaveLength(2);
  });

  it("the registered prompts/get handler defaults missing arguments to {}", async () => {
    const captured: ((req: unknown) => Promise<unknown>)[] = [];
    const server = {
      setRequestHandler: (_s: unknown, h: unknown) =>
        captured.push(h as (req: unknown) => Promise<unknown>),
    };
    registerPrompts(server as unknown as Parameters<typeof registerPrompts>[0]);
    const getHandler = captured[1]!;
    // research_methodology's only arg is required, so omitting arguments must throw.
    await expect(getHandler({ params: { name: "research_methodology" } })).rejects.toThrow(
      /missing required argument: question/,
    );
  });
});
