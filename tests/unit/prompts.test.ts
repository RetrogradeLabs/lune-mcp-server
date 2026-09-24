/**
 * Unit coverage for the MCP Prompts (research workflows). Asserts the public
 * `prompts/list` projection, `prompts/get` rendering + argument handling, and
 * that each prompt actually orchestrates the Lune tools its workflow needs
 * (a non-vacuous guard so a prompt can't silently drift into empty guidance).
 */
import { ProtocolError } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { messageOf } from "../../src/cause.js";
import {
  createRecordingServer,
  createServerContext,
} from "../support/mcp-server.js";
import {
  PROMPTS,
  getPromptResult,
  listPrompts,
  registerPrompts,
} from "../../src/prompts.js";
import {
  answeredView,
  fixedReleases,
  UNANSWERED_VIEW,
  type ReleaseView,
} from "../../src/releases.js";

const text = (name: string, args: Record<string, string>) =>
  getPromptResult(name, args).messages[0]!.content.text;

const FIGURES_RELEASED = { figures: true };

describe("listPrompts", () => {
  it("projects every prompt with name, title, description, and arguments", () => {
    const { prompts } = listPrompts(FIGURES_RELEASED);
    expect(prompts).toHaveLength(PROMPTS.length);

    for (const p of prompts) {
      expect(p.name).toMatch(/^[a-z_]+$/);
      expect(p.title.length).toBeGreaterThan(0);
      expect(p.description.length).toBeGreaterThan(0);
      expect(Array.isArray(p.arguments)).toBe(true);
    }
  });

  it("exposes exactly the six public research workflows", () => {
    expect(
      listPrompts()
        .prompts.map((p) => p.name)
        .sort(),
    ).toEqual(
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

  it("adds design_figure, first, only for a credential Figures was released to", () => {
    expect(listPrompts(FIGURES_RELEASED).prompts.map((p) => p.name)).toEqual([
      "design_figure",
      "literature_review",
      "find_related_work",
      "compare_papers",
      "verify_draft",
      "trace_citations",
      "research_methodology",
    ]);
  });
});

describe("getPromptResult rendering", () => {
  it("returns a single user/text message", () => {
    const res = getPromptResult("verify_draft", {
      draft: "Transformers were introduced in 2017.",
    });

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
    const t = text("literature_review", {
      topic: "graph neural networks for molecules",
    });

    expect(t).toContain("graph neural networks for molecules");
    expect(t).not.toMatch(/\bundefined\b/);
    expect(t).not.toMatch(/\[(venues|scope|since)/i);
    // The scope sentence (venues / year) is absent.
    expect(t).not.toContain("Scope it to these venues");
    expect(t).not.toContain("Focus on work from");
  });

  it("falls back to default columns when compare_papers omits them", () => {
    const withCols = text("compare_papers", {
      topic: "x",
      columns: "dataset, accuracy",
    });

    const without = text("compare_papers", { topic: "x" });
    expect(withCols).toContain("dataset, accuracy");
    expect(without).toContain("most informative columns");
  });
});

describe("getPromptResult validation", () => {
  it("throws on an unknown prompt", () => {
    try {
      getPromptResult("does_not_exist", {});
      throw new Error("expected getPromptResult to throw");
    } catch (error) {
      expect(error).toMatchObject({ code: -32602 });
      expect(messageOf(error)).toMatch(/unknown prompt/i);
    }
  });

  it("answers an unreleased prompt exactly like an unknown one", () => {
    const failureOf = (name: string): ProtocolError => {
      try {
        getPromptResult(name, { figure: "a three-stage pipeline" });
      } catch (error) {
        if (error instanceof ProtocolError) return error;
      }

      throw new Error(`expected ${name} to be refused as unknown`);
    };

    const unreleased = failureOf("design_figure");
    const unknown = failureOf("does_not_exist");
    expect(unreleased.code).toBe(unknown.code);
    expect(unreleased.message).toBe("Unknown prompt: design_figure");
    expect(unknown.message).toBe("Unknown prompt: does_not_exist");

    expect(
      getPromptResult(
        "design_figure",
        { figure: "a three-stage pipeline" },
        FIGURES_RELEASED,
      ).messages[0]!.content.text,
    ).toContain("search_figure_references");
  });

  it("throws when a required argument is missing or blank", () => {
    expect(() => getPromptResult("verify_draft", {})).toThrow(
      /missing required argument: draft/i,
    );
    expect(() => getPromptResult("verify_draft", { draft: "   " })).toThrow(
      /missing required/i,
    );
  });
});

describe("each workflow orchestrates the tools it needs", () => {
  // The whole value of a prompt is steering the agent to the right multi-tool
  // workflow; assert the load-bearing tool names are present in each.
  const EXPECT = {
    literature_review: ["search_papers_many", "get_paper_fulltext"],
    find_related_work: [
      "search_papers",
      "search_related_papers",
      "get_paper_citations",
    ],
    compare_papers: ["extract_from_papers"],
    verify_draft: ["verify_claims"],
    trace_citations: ["get_paper_citations", "search_related_papers"],
    research_methodology: ["search_research_guidance"],
  } satisfies Record<string, string[]>;

  for (const [name, tools] of Object.entries(EXPECT)) {
    it(`${name} references ${tools.join(", ")}`, () => {
      // Fill every required arg with a placeholder so rendering succeeds.
      const def = PROMPTS.find((p) => p.name === name)!;
      const args: Record<string, string> = {};

      for (const a of def.arguments)
        if (a.required) args[a.name] = "placeholder";
      const t = text(name, args);

      for (const tool of tools) expect(t).toContain(tool);
    });
  }
});

describe("registerPrompts", () => {
  it("wires the prompts/list and prompts/get handlers", () => {
    const server = createRecordingServer();
    registerPrompts(server);
    expect(() => server.handler("prompts/list")).not.toThrow();
    expect(() => server.handler("prompts/get")).not.toThrow();
  });

  it("the registered prompts/get handler defaults missing arguments to {}", async () => {
    const server = createRecordingServer();
    registerPrompts(server);
    // research_methodology's only arg is required, so omitting arguments must throw.
    await expect(
      server.handler("prompts/get")(
        { method: "prompts/get", params: { name: "research_methodology" } },
        createServerContext({ method: "prompts/get" }),
      ),
    ).rejects.toMatchObject({
      code: -32602,
      message: "Missing required argument: question",
    });
  });

  it("serves the prompt set of the releases it was registered with", async () => {
    const listed = async (view?: ReleaseView) => {
      const server = createRecordingServer();
      registerPrompts(server, undefined, view && fixedReleases(view));

      const res = await server.handler("prompts/list")(
        { method: "prompts/list" },
        createServerContext({ method: "prompts/list" }),
      );

      return res.prompts.map((prompt) => prompt.name);
    };

    expect(await listed()).not.toContain("design_figure");
    expect(await listed(answeredView(FIGURES_RELEASED))).toContain(
      "design_figure",
    );
    // No API gate stands behind a prompt, so one the API could not confirm
    // stays unlisted.
    expect(await listed(UNANSWERED_VIEW)).not.toContain("design_figure");

    const server = createRecordingServer();
    registerPrompts(server);

    await expect(
      server.handler("prompts/get")(
        {
          method: "prompts/get",
          params: {
            name: "design_figure",
            arguments: { figure: "a three-stage pipeline" },
          },
        },
        createServerContext({ method: "prompts/get" }),
      ),
    ).rejects.toMatchObject({
      code: -32602,
      message: "Unknown prompt: design_figure",
    });
  });
});
