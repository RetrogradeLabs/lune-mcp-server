import { z } from "zod";

// Reject "." and "..": encoding leaves them intact and URL normalization could
// silently rewrite the API endpoint.
export const pathSegmentId = (description: string) =>
  z
    .string()
    .min(1)
    .refine((s) => s !== "." && s !== "..", {
      message: "must be a real id, not '.' or '..'",
    })
    .describe(description);

// Reuse one corpus|workspace selector; the API binds workspace to the credential
// and rejects ordinary credentials, so callers never pass a workspace id.
const SOURCE_FIELD = z
  .enum(["corpus", "workspace"])
  .default("corpus")
  .optional()
  .describe(
    'Where to operate: "corpus" (default) = the public Lune corpus; ' +
      '"workspace" = the user\'s OWN uploaded workspace documents (the active ' +
      "workspace is bound to your session; only available to a workspace " +
      'session, an ordinary credential gets a 400). When "workspace", any id ' +
      "argument is a workspace document id (from search_papers source=workspace), " +
      "not a corpus paper_id.",
  );

export const SearchInput = z.object({
  query: z
    .string()
    .min(1)
    .max(500)
    .describe(
      "Full natural-language research query; phrase it the way you would ask " +
        "a human research assistant. Long, descriptive questions outperform " +
        "short keyword bags: the server detects conceptual / natural-language " +
        "intent and automatically rewrites the query into a hypothetical " +
        "abstract (HyDE) plus paraphrases before vector retrieval, so the " +
        "richer the input, the better the recall. " +
        'Good: "methods for retrieval-augmented generation that reduce ' +
        'hallucination on long-form QA". ' +
        'Less optimal: "RAG hallucination".',
    ),
  source: SOURCE_FIELD,
  conference: z
    .string()
    .optional()
    .describe('Filter by conference short name, e.g. "CCS", "NeurIPS".'),
  year: z.number().int().min(1990).max(2100).optional(),
  limit: z.number().int().min(1).max(50).default(10).optional(),
  offset: z
    .number()
    .int()
    .min(0)
    .default(0)
    .optional()
    .describe(
      "Pagination offset over the ranked results. Re-call with offset += limit " +
        "while the response `has_more` is true. offset + limit must stay <= 50.",
    ),
  sort_by: z
    .enum(["relevance", "date", "citations"])
    .default("relevance")
    .optional()
    .describe(
      "Result ordering within the ranked shortlist: `relevance` (default), " +
        "`date` (newest first), or `citations` (most-cited first).",
    ),
  year_min: z
    .number()
    .int()
    .min(1990)
    .max(2100)
    .optional()
    .describe("Only include papers published in this year or later."),
  year_max: z
    .number()
    .int()
    .min(1990)
    .max(2100)
    .optional()
    .describe("Only include papers published in this year or earlier."),
  venues: z
    .array(z.string().min(1))
    .optional()
    .describe(
      'Restrict to these conference short names (e.g. ["NeurIPS", "ICML"]).',
    ),
  detail: z
    .boolean()
    .default(true)
    .optional()
    .describe(
      "true (default): include the full abstract, ids, and contexts[] " +
        "non-abstract matched spans for grounding. false: concise hits (title, " +
        "authors, year, venue, citations, score, and a single grounding " +
        "snippet) for token-saving triage. For the complete paper text call " +
        "get_paper_fulltext.",
    ),
});

export const SearchManyInput = z.object({
  queries: z
    .array(z.string().min(1).max(2000))
    .min(1)
    .max(25)
    .describe(
      "1 to 25 query variants to run in ONE call. Phrase each the way you " +
        "would ask a human research assistant (full natural-language questions " +
        "beat keyword bags). Supply genuinely different angles on the topic " +
        "(rephrasings, sub-questions, alternate terminology) so the merged list " +
        "covers more of the literature than any single query would. The server " +
        "runs each variant through the full hybrid pipeline and RRF-fuses the " +
        "ranked lists into one deduped result set.",
    ),
  conference: z
    .string()
    .optional()
    .describe(
      "Shared across every query: filter to this conference short name, e.g. " +
        '"CCS", "NeurIPS".',
    ),
  year: z
    .number()
    .int()
    .min(1990)
    .max(2100)
    .optional()
    .describe(
      "Shared across every query: restrict to a single publication year.",
    ),
  year_min: z
    .number()
    .int()
    .min(1990)
    .max(2100)
    .optional()
    .describe(
      "Shared across every query: only papers published in this year or later.",
    ),
  year_max: z
    .number()
    .int()
    .min(1990)
    .max(2100)
    .optional()
    .describe(
      "Shared across every query: only papers published in this year or earlier.",
    ),
  venues: z
    .array(z.string().min(1))
    .optional()
    .describe(
      "Shared across every query: restrict to these conference short names " +
        '(e.g. ["NeurIPS", "ICML"]).',
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(10)
    .describe(
      "Max papers in the merged, deduped result list (default 10, max 50).",
    ),
  detail: z
    .boolean()
    .default(true)
    .describe(
      "true (default): include the full abstract, ids, and contexts[] " +
        "non-abstract matched spans for grounding. false: concise hits (title, " +
        "authors, year, venue, citations, score, and a single grounding " +
        "snippet) for token-saving triage. `matched_queries` provenance is " +
        "always present. For the complete paper text call get_paper_fulltext.",
    ),
});

export const FullTextInput = z.object({
  paper_id: pathSegmentId(
    "A corpus paper UUID, from a search_papers / search_papers_many / " +
      "search_related_papers / get_paper_citations result.",
  ),
  source: SOURCE_FIELD,
  format: z
    .enum(["markdown", "json"])
    .default("markdown")
    .optional()
    .describe(
      "`markdown` returns one rendered document, ready to read or quote inline. " +
        "`json` returns a structured section list, useful when you want to " +
        "navigate by section name (methods / results / related work).",
    ),
  sections: z
    .array(z.string().min(1))
    .optional()
    .describe(
      "Return only these sections (case-insensitive heading match), " +
        'e.g. ["Methods", "Results"]. Omit to return the whole document.',
    ),
});

export const CitationsInput = z.object({
  paper_id: pathSegmentId(
    "A corpus paper UUID, taken from a `search_papers` or `search_related_papers` " +
      "result.",
  ),
  direction: z
    .enum(["cited_by", "cites"])
    .default("cited_by")
    .optional()
    .describe(
      "`cited_by`: indexed papers that cite this one (forward, follow-up work). " +
        "`cites`: this paper's parsed references (back, what it built on).",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(25)
    .optional()
    .describe("Max citation edges to return per page (default 25, max 100)."),
  offset: z
    .number()
    .int()
    .min(0)
    .default(0)
    .optional()
    .describe(
      "Pagination offset; re-call with offset += limit while the response " +
        "`has_more` is true. The response also reports `total`.",
    ),
});

export const RelatedInput = z.object({
  paper_id: pathSegmentId(
    "A corpus paper UUID (from a paper search) to find neighbors for.",
  ),
  limit: z.number().int().min(1).max(20).default(6).optional(),
});

export const ExtractInput = z.object({
  paper_ids: z
    .array(z.string().min(1))
    .min(1)
    .max(50)
    .describe(
      "1 to 50 corpus paper UUIDs to extract from in ONE call, from a " +
        "search_papers / search_papers_many / search_related_papers / " +
        "get_paper_citations result.",
    ),
  source: SOURCE_FIELD,
  fields: z
    .array(
      z.object({
        name: z
          .string()
          .min(1)
          .describe(
            "snake_case identifier; becomes the key for this field on every row " +
              "(e.g. `dataset`, `headline_accuracy`).",
          ),
        type: z
          .enum(["string", "number", "boolean", "string[]"])
          .describe("Wire type the extracted value is coerced to."),
        description: z
          .string()
          .max(2000)
          .optional()
          .describe("What to pull for this field; sharpens the extraction."),
      }),
    )
    .min(1)
    .max(12)
    .describe(
      "1 to 12 fields to extract per paper. Each becomes a typed column on every " +
        "row, keyed by its `name`.",
    ),
  instruction: z
    .string()
    .min(1)
    .max(2000)
    .describe(
      'Natural-language guidance for the extraction (e.g. "Pull the primary ' +
        'evaluation dataset and the headline accuracy"). The model is told to use ' +
        "only what the paper states.",
    ),
  sections: z
    .array(z.string().min(1))
    .optional()
    .describe(
      "Restrict extraction to these sections (case-insensitive heading match), " +
        'e.g. ["Results", "Experiments"]. Omit to consider the whole paper.',
    ),
});

export const VerifyInput = z.object({
  claims: z
    .array(z.string().min(1).max(2000))
    .min(1)
    .max(25)
    .describe(
      "1 to 25 natural-language factual claims to fact-check against the corpus " +
        "in ONE call. Phrase each as a complete, self-contained assertion (e.g. " +
        '"LoRA fine-tuning matches full fine-tuning on GLUE while training far ' +
        'fewer parameters"), not a keyword bag. Each claim is retrieved and ' +
        "judged independently, so you get one grounded verdict per claim.",
    ),
  source: SOURCE_FIELD,
  context: z
    .string()
    .optional()
    .describe(
      "Optional shared framing passed to the judge for every claim, e.g. the " +
        "surrounding paragraph or the question the claims answer. Use it to " +
        "disambiguate terse claims; it does not change what is retrieved.",
    ),
  conference: z
    .string()
    .optional()
    .describe(
      'Restrict the evidence search to this conference short name, e.g. "CCS", ' +
        '"NeurIPS". Shared across every claim.',
    ),
  year: z
    .number()
    .int()
    .min(1990)
    .max(2100)
    .optional()
    .describe("Restrict the evidence search to a single publication year."),
  year_min: z
    .number()
    .int()
    .min(1990)
    .max(2100)
    .optional()
    .describe(
      "Restrict the evidence search to this publication year or later. Shared across every claim.",
    ),
  year_max: z
    .number()
    .int()
    .min(1990)
    .max(2100)
    .optional()
    .describe(
      "Restrict the evidence search to this publication year or earlier. Shared across every claim.",
    ),
  venues: z
    .array(z.string().min(1))
    .optional()
    .describe(
      "Restrict the evidence search to these conference short names " +
        '(e.g. ["NeurIPS", "ICML"]). Shared across every claim.',
    ),
});

export const GatherEvidenceInput = z.object({
  task: z
    .string()
    .min(1)
    .max(2000)
    .describe(
      "The research goal in prose: what you are trying to establish. Drives " +
        "requirement decomposition and the sufficiency judgment.",
    ),
  queries: z
    .array(z.string().min(1).max(2000))
    .min(1)
    .max(25)
    .describe(
      "Your initial search angles (full natural-language questions). One corpus " +
        "search runs per angle; they are billed like search_papers_many.",
    ),
  source: SOURCE_FIELD,
  requirements: z
    .array(
      z.object({
        key: z
          .string()
          .min(1)
          .describe("snake_case id for this evidence slot."),
        description: z
          .string()
          .min(1)
          .max(2000)
          .describe("What evidence this slot needs."),
      }),
    )
    .min(1)
    .max(12)
    .optional()
    .describe(
      "Optional explicit evidence slots; omit to let the server derive them from `task`.",
    ),
  draft: z
    .string()
    .max(8000)
    .optional()
    .describe(
      "Optional current draft. Each sentence is checked for support against the " +
        "gathered spans (no extra searches). The tool never rewrites your draft.",
    ),
  max_iterations: z
    .number()
    .int()
    .min(1)
    .max(5)
    .default(1)
    .describe(
      "Sufficiency rounds. Default 1 is a one-shot advisor. Set >1 (with " +
        "max_total_queries>len(queries)) to authorize bounded server-side follow-up searches.",
    ),
  max_total_queries: z
    .number()
    .int()
    .min(1)
    .max(25)
    .optional()
    .describe(
      "Total search budget across all iterations (the billed ceiling). Defaults " +
        "to len(queries). Must exceed len(queries) only when max_iterations>1.",
    ),
  conference: z
    .string()
    .optional()
    .describe('Filter to this conference short name, e.g. "NeurIPS".'),
  year: z.number().int().min(1990).max(2100).optional(),
  year_min: z.number().int().min(1990).max(2100).optional(),
  year_max: z.number().int().min(1990).max(2100).optional(),
  venues: z
    .array(z.string().min(1))
    .optional()
    .describe("Restrict to these conference short names."),
});

export const ListConfsInput = z.object({
  category: z
    .string()
    .optional()
    .describe(
      "Optional research-area filter, matched case-insensitively against the " +
        "conference's field. Accepts short codes (`ai`, `ml`, `nlp`, `cv`, " +
        "`security`, `databases`, `software`, `systems`) or any substring of the " +
        "field name. Omit to list every conference.",
    ),
});

export const ConfPapersInput = z.object({
  conference: pathSegmentId(
    'Conference short name, e.g. "NeurIPS", "CCS", "ICLR".',
  ),
  // Year range mirrors `SearchInput.year` so a malformed input fails the
  // same way across the two paper-listing tools.
  year: z
    .number()
    .int()
    .min(1990)
    .max(2100)
    .optional()
    .describe("Restrict to a single year (e.g. 2024). Omit to span all years."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20)
    .optional()
    .describe("Max papers to return per page (default 20, max 100)."),
  offset: z
    .number()
    .int()
    .min(0)
    .default(0)
    .optional()
    .describe("Pagination offset; use to fetch subsequent pages."),
  sort: z
    .enum(["recency", "citations"])
    .default("recency")
    .optional()
    .describe(
      "`recency` (newest first, default) or `citations` (most-cited first).",
    ),
});

/** SearchInput without the workspace selector, for credentials without workspace access. */
export const SearchInputExternal = SearchInput.omit({ source: true });

/** FullTextInput without the workspace selector, for credentials without workspace access. */
export const FullTextInputExternal = FullTextInput.omit({ source: true });

/** ExtractInput without the workspace selector, for credentials without workspace access. */
export const ExtractInputExternal = ExtractInput.omit({ source: true });

/** VerifyInput without the workspace selector, for credentials without workspace access. */
export const VerifyInputExternal = VerifyInput.omit({ source: true });

/** GatherEvidenceInput without the workspace selector, for credentials without workspace access. */
export const GatherEvidenceInputExternal = GatherEvidenceInput.omit({
  source: true,
});
