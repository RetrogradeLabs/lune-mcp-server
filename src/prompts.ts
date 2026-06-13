import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

/**
 * MCP Prompts: reusable, user-invokable research workflows (surfaced as slash
 * commands, e.g. `/literature_review`). Each prompt expands into a single user
 * message that frames a REAL researcher task and orchestrates the Lune tools
 * toward it, with the user's arguments interpolated.
 *
 * The set mirrors the workflow a working academic actually runs with an AI
 * research assistant: scope and survey a literature, position a contribution,
 * extract a structured comparison across papers, fact-check a draft against the
 * corpus, trace a citation lineage, and get grounded methodology advice. These
 * map onto the staged "scope -> screen -> extract -> claim-check -> synthesise"
 * loop that researchers use with tools like Elicit and Consensus, but grounded
 * in Lune's full-text peer-reviewed corpus.
 *
 * Prompts are deterministic and stateless: the same arguments always render the
 * same message. Required arguments are validated before rendering.
 */

interface PromptArg {
  name: string;
  description: string;
  required?: boolean;
}

interface PromptDef {
  name: string;
  title: string;
  description: string;
  arguments: PromptArg[];
  build: (args: Record<string, string>) => string;
}

/** True when an (optional) argument was supplied with non-blank text. */
function present(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

const CITE_RULE =
  "Cite every paper by title, authors, and venue/year (a paper_id is only your " +
  "fetch handle, never show it to me). Use Lune's tools, not web search.";

export const PROMPTS: PromptDef[] = [
  {
    name: "literature_review",
    title: "Literature review",
    description:
      "Survey the literature on a topic and synthesise it (themes, seminal vs recent " +
      "work, open gaps), grounded in Lune's peer-reviewed corpus.",
    arguments: [
      { name: "topic", description: "The research topic or question to review.", required: true },
      {
        name: "venues",
        description: "Optional comma-separated venues to scope to (e.g. \"NeurIPS, ICML\").",
      },
      { name: "since_year", description: "Optional earliest publication year (e.g. \"2021\")." },
    ],
    build: (a) => {
      const scope = [
        present(a.venues) ? `Scope it to these venues: ${a.venues}.` : "",
        present(a.since_year) ? `Focus on work from ${a.since_year} onward.` : "",
      ]
        .filter(Boolean)
        .join(" ");
      return [
        `I'm conducting a literature review on: ${a.topic}.`,
        scope,
        "",
        "Produce a grounded review:",
        "1. Call search_papers_many with 5 to 8 genuinely different angles on the topic " +
          "(rephrasings, sub-questions, competing approaches, key methods, alternate " +
          "terminology) so the merged results cover the field broadly. Pass any venue or " +
          "year scope above as the `venues` / `year_min` filters on that call (they are " +
          "shared across all variants), not only in prose.",
        "2. Triage the merged hits; for the handful of most relevant or most-cited papers, " +
          "call get_paper_fulltext to read the methods and results.",
        "3. Synthesise into: (a) the main themes and lines of work, (b) the foundational " +
          "papers and the recent advances, (c) open problems and gaps, (d) how the leading " +
          "approaches differ and trade off.",
        "",
        "Be explicit about how strong the evidence is, and say so when coverage is thin. " +
          CITE_RULE,
      ]
        .filter(Boolean)
        .join("\n");
    },
  },
  {
    name: "find_related_work",
    title: "Find related work",
    description:
      "Given your abstract or research idea, find and organise the prior work you should " +
      "cite and distinguish your contribution from.",
    arguments: [
      {
        name: "abstract",
        description: "Your paper's abstract, or a paragraph describing the idea/contribution.",
        required: true,
      },
      { name: "venues", description: "Optional comma-separated venues to scope to." },
    ],
    build: (a) => {
      const scope = present(a.venues) ? ` (restrict to ${a.venues})` : "";
      return [
        "Here is my paper's abstract / research idea:",
        a.abstract,
        "",
        "Find and organise the related work I should cite and compare against:",
        `1. Call search_papers with a rich natural-language query derived from my abstract${scope}` +
          (scope ? " (pass it as the `venues` filter, not only in prose)" : "") +
          ".",
        "2. For the 2 to 4 closest papers, call search_related_papers on their paper_id for " +
          "adjacent work, and get_paper_citations to surface what they build on and what " +
          "cites them.",
        "3. Group the results into themes. For each paper, note in one line how it relates " +
          "to my work and how mine differs.",
        "",
        "Output a related-work outline I could drop into the paper, and flag the closest " +
          "prior work I must explicitly distinguish from. " +
          CITE_RULE,
      ].join("\n");
    },
  },
  {
    name: "compare_papers",
    title: "Compare papers (extraction table)",
    description:
      "Build a structured comparison table across papers (you choose the columns), read " +
      "from each paper's full text.",
    arguments: [
      {
        name: "topic",
        description:
          "The topic to gather papers on, OR a list of specific paper titles to compare.",
        required: true,
      },
      {
        name: "columns",
        description:
          "Optional comma-separated columns to extract (e.g. \"dataset, task, method, key " +
          "metric, headline result\"). If omitted, choose the most informative columns.",
      },
    ],
    build: (a) => {
      const cols = present(a.columns)
        ? `Extract these columns for each paper: ${a.columns}.`
        : "Choose the most informative columns for this topic (e.g. dataset, task, method, " +
          "key metric, headline result, compute).";
      return [
        `Build a structured comparison table for: ${a.topic}.`,
        cols,
        "",
        "Steps:",
        "1. If I named specific papers, find them with search_papers; otherwise call " +
          "search_papers (or search_papers_many) to gather the most relevant papers.",
        "2. Call extract_from_papers over the chosen papers with one field per column " +
          "(snake_case names, a clear instruction, and `sections` like [\"Results\"] when it " +
          "helps focus the read). It reads each paper's full text and returns one row per paper.",
        "3. Present a markdown table, one row per paper. Treat any row flagged `truncated` as " +
          "partial, and list anything in `papers_failed` separately rather than guessing values.",
        "",
        CITE_RULE,
      ].join("\n");
    },
  },
  {
    name: "verify_draft",
    title: "Fact-check a draft",
    description:
      "Fact-check a paragraph or list of claims against the peer-reviewed corpus, with a " +
      "verbatim supporting quote per claim.",
    arguments: [
      {
        name: "draft",
        description: "The text or list of claims to verify before you rely on it.",
        required: true,
      },
    ],
    build: (a) =>
      [
        "Fact-check the following against the peer-reviewed literature before I rely on it:",
        "",
        a.draft,
        "",
        "Steps:",
        "1. Break the text into atomic, individually checkable claims (one assertion each).",
        "2. Call verify_claims with those claims (up to 25 per call). Each verdict is grounded " +
          "ONLY in retrieved passages and carries a server-verified verbatim quote.",
        "3. Report per claim: the verdict (supported / unsupported / insufficient_evidence), " +
          "the supporting quote and its paper, and the confidence. Clearly flag every claim " +
          "that is unsupported or has insufficient evidence so I can fix or hedge it.",
        "",
        "Do not assert anything from memory. " + CITE_RULE,
      ].join("\n"),
  },
  {
    name: "trace_citations",
    title: "Trace a citation lineage",
    description:
      "Trace the intellectual lineage of a paper or idea: its foundations, the work that " +
      "built on it, and adjacent developments.",
    arguments: [
      {
        name: "paper",
        description: "A paper title, or a precise description of the paper/idea to anchor on.",
        required: true,
      },
    ],
    build: (a) =>
      [
        `Trace the intellectual lineage of: ${a.paper}.`,
        "",
        "Steps:",
        "1. Find the anchor paper with search_papers (use the title or a precise description).",
        "2. Call get_paper_citations with direction=cites for the foundations it builds on, and " +
          "direction=cited_by for the work that builds on it.",
        "3. Call search_related_papers for adjacent work not necessarily linked by citations.",
        "",
        "Lay out the lineage as a short narrative: the foundational ideas, the key " +
          "developments, and the most influential recent follow-ups, and note where the line " +
          "of work is heading. " +
          CITE_RULE,
      ].join("\n"),
  },
  {
    name: "research_methodology",
    title: "Methodology advice",
    description:
      "Get grounded, citable advice on a research-process question (experiment design, " +
      "ablations, evaluation, reproducibility, rebuttals, venue choice, writing).",
    arguments: [
      {
        name: "question",
        description:
          "The methodology question, e.g. \"how should I design an ablation for X\" or \"how " +
          "do I respond to reviewer 2\".",
        required: true,
      },
    ],
    build: (a) =>
      [
        `I need grounded methodology advice (not opinions) on the following.`,
        a.question,
        "",
        "Steps:",
        "1. Call search_research_guidance FIRST with my question.",
        "2. If a guidance excerpt is relevant but partial, call get_research_guidance_doc for " +
          "its full text.",
        "3. If the question also needs examples from real papers (e.g. \"how do strong papers " +
          "ablate X\"), supplement with search_papers.",
        "",
        "Give concrete, actionable advice grounded in the guidance corpus, citing each " +
          "guidance entry (doc_id) and any papers you draw on. Be explicit when the corpus " +
          "does not cover part of the question.",
      ].join("\n"),
  },
];

/** Project the prompt set for `prompts/list` (drops the `build` closure). */
export function listPrompts(): {
  prompts: { name: string; title: string; description: string; arguments: PromptArg[] }[];
} {
  return {
    prompts: PROMPTS.map(({ name, title, description, arguments: args }) => ({
      name,
      title,
      description,
      arguments: args,
    })),
  };
}

/**
 * Resolve `prompts/get`: validate required arguments, then render the workflow
 * message. Throws (a JSON-RPC error to the client) on an unknown prompt name or
 * a missing required argument, matching how unknown tools are surfaced.
 */
export function getPromptResult(
  name: string,
  args: Record<string, string>,
): { description: string; messages: { role: "user"; content: { type: "text"; text: string } }[] } {
  const def = PROMPTS.find((p) => p.name === name);
  if (!def) throw new Error(`unknown prompt: ${name}`);
  for (const arg of def.arguments) {
    if (arg.required && !present(args[arg.name])) {
      throw new Error(`missing required argument: ${arg.name}`);
    }
  }
  return {
    description: def.description,
    messages: [{ role: "user", content: { type: "text", text: def.build(args) } }],
  };
}

/**
 * Wire the real `prompts/list` + `prompts/get` handlers. Call AFTER
 * `registerAllTools` (which no longer registers an empty prompts handler). The
 * `prompts: {}` capability is already declared in `makeServer`.
 */
export function registerPrompts(server: Server): void {
  server.setRequestHandler(
    ListPromptsRequestSchema,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async () => listPrompts() as any,
  );
  server.setRequestHandler(
    GetPromptRequestSchema,
    async (req: { params: { name: string; arguments?: Record<string, string> } }) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getPromptResult(req.params.name, req.params.arguments ?? {}) as any,
  );
}
