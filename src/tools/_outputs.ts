/**
 * Zod output schemas for every MCP tool. Mirrors the shapes returned by the
 * projectors in `_slim.ts`. Each tool's `outputSchema` is exported so the
 * MCP `tools/list` response advertises the contract, and so the call handler
 * can populate `structuredContent` matching that contract.
 *
 * Current tools use object envelopes, although MCP 2026-07-28 permits any JSON
 * value in structured output.
 */
import { z } from "zod";

const PaperOut = z.object({
  paper_id: z
    .string()
    .describe(
      "Lune paper UUID. An internal handle for fetching a paper's FULL TEXT via " +
        "get_paper_fulltext; do NOT show it " +
        "to the user. Cite papers by title, authors, and venue instead.",
    ),
  title: z.string(),
  authors: z.array(z.string()),
  year: z.number().int().optional(),
  doi: z.string().optional(),
  arxiv_id: z.string().optional(),
  abstract: z.string().optional(),
  pdf_cdn_url: z.string().optional(),
  url: z.string().optional(),
  citation_count: z.number().int(),
  conference: z
    .string()
    .optional()
    .describe("Conference short name (e.g. NeurIPS, CCS)."),
});

const ConferenceOut = z.object({
  id: z.string().describe("Conference UUID."),
  short_name: z.string(),
  full_name: z.string(),
  description: z.string().optional(),
  category: z.string().optional(),
  paper_count: z.number().int(),
  years: z
    .array(z.number().int())
    .describe("Distinct years for which this conference has indexed papers."),
});

const CitationOut = z.object({
  paper_id: z
    .string()
    .optional()
    .describe(
      "Lune paper UUID when this edge resolves to a paper in the corpus; " +
        "absent for a parsed-only reference. Fetch full text with get_paper_fulltext.",
    ),
  in_corpus: z
    .boolean()
    .describe(
      "True if paper_id is set (the edge resolves to an indexed paper).",
    ),
  title: z.string().optional(),
  authors: z.array(z.string()).optional(),
  year: z.number().int().optional(),
  doi: z.string().optional(),
  venue: z.string().optional(),
  citation_count: z.number().int().optional(),
  contexts: z
    .array(z.object({ section: z.string(), text: z.string() }))
    .optional()
    .describe(
      "The citing paper's own sentences that cite the other paper, each with " +
        "its section, so you can see how the work is used without fetching " +
        "full text. Absent when the edge predates sentence extraction; empty " +
        "when the paper lists the work without citing it in its text.",
    ),
});

const GuidanceHitOut = z.object({
  doc_id: z.string(),
  doc_title: z.string(),
  source_url: z.string().optional(),
  section: z.string(),
  excerpt: z.string(),
});

const GuidanceDocOut = z.object({
  doc_id: z.string(),
  title: z.string(),
  author: z.string().optional(),
  author_affiliation: z.string().optional(),
  source_url: z.string().optional(),
  tags: z.array(z.string()),
  content: z
    .string()
    .optional()
    .describe(
      "The full guidance document text, reassembled from its sections. Use " +
        "this to quote a passage or follow a checklist end to end (vs the " +
        "matched excerpt from search_research_guidance).",
    ),
  sections: z
    .array(
      z.object({
        heading: z.string(),
        text: z.string(),
      }),
    )
    .optional()
    .describe("The same body split by section heading, in document order."),
});

const MatchedContextOut = z.object({
  section: z
    .string()
    .optional()
    .describe("Section the chunk came from (e.g. Methods, Results)."),
  text: z.string().describe("The exact matched text span from the paper."),
  score: z
    .number()
    .optional()
    .describe("Retriever relevance score for the chunk."),
  chunk_id: z
    .string()
    .optional()
    .describe(
      "Stable id of the source chunk; deep-links the exact matched span.",
    ),
});

// One schema covers enriched and detail:false hits; only the shared PaperOut
// core is required, while contexts and concise projection fields stay optional.
const SearchHitOut = PaperOut.extend({
  score: z
    .number()
    .optional()
    .describe(
      "Final ranking score (higher is better). Folds a citation/freshness " +
        "boost into the base rank, so it is NOT a calibrated relevance and can " +
        "exceed 1.0. Use it to order results, not to threshold or abstain.",
    ),
  rerank_score: z
    .number()
    .optional()
    .describe(
      "Raw Cohere Rerank v3.5 relevance, calibrated 0..1. Present only when the " +
        "reranker ran; omitted for short keyword / BM25-dominated queries that " +
        "skip it. This is the value to threshold on and the basis for " +
        "best_score / low_confidence.",
    ),
  snippet: z
    .string()
    .optional()
    .describe(
      "Concise-mode grounding: the top matched span, or a truncated abstract.",
    ),
  et_al_count: z
    .number()
    .int()
    .optional()
    .describe("Authors beyond the first 6 (concise mode trims the list)."),
  contexts: z
    .array(MatchedContextOut)
    .optional()
    .describe(
      "Present by default and in detail mode: the non-abstract matched span(s) " +
        "inside this paper (at most one per paper today). Use to ground an " +
        "answer; for full text call get_paper_fulltext.",
    ),
});

export const SearchPapersOutput = z.object({
  results: z.array(SearchHitOut),
  has_more: z
    .boolean()
    .describe(
      "True when more results exist past this page; re-call with offset += limit.",
    ),
  best_score: z
    .number()
    .nullable()
    .describe(
      "The highest per-hit rerank_score (calibrated 0..1), or null when no hit " +
        "was reranked (keyword / BM25-dominated query) or there were no results.",
    ),
  low_confidence: z
    .boolean()
    .describe(
      "True when the best rerank_score fell below the relevance floor: treat " +
        "results as weak and consider broadening the query or abstaining. False " +
        "when no hit was reranked (no calibrated basis to abstain) or a hit " +
        "cleared the floor.",
    ),
});

// Batch hits reuse SearchHitOut with per-query ranks and run/failure counts;
// has_more stays false because the fused shortlist has no stable cursor.
const BatchSearchHitOut = SearchHitOut.extend({
  matched_queries: z
    .array(
      z.object({
        query: z
          .string()
          .describe("The input query variant that surfaced this paper."),
        rank: z
          .number()
          .int()
          .describe(
            "1-based rank of this paper within that variant's ranked list.",
          ),
      }),
    )
    .describe(
      "Which of the input queries surfaced this paper, with each variant's " +
        "1-based rank. Use it to see which fan-out variants paid off.",
    ),
});

export const SearchPapersManyOutput = z.object({
  results: z
    .array(BatchSearchHitOut)
    .describe(
      "One deduped, RRF-merged ranked list across all query variants; each hit " +
        "carries `matched_queries` provenance.",
    ),
  queries_run: z
    .number()
    .int()
    .describe(
      "How many of the submitted query variants completed successfully.",
    ),
  queries_failed: z
    .array(
      z.object({
        query: z.string(),
        reason: z.string().describe("Why this variant's pipeline failed."),
      }),
    )
    .describe(
      "Variants whose pipeline raised; recorded here instead of sinking the " +
        "whole batch. Empty when every variant ran.",
    ),
  has_more: z
    .boolean()
    .describe(
      "Always false: the merged shortlist is bounded, so there is no cursor to " +
        "page past it. Widen the query set or filters for more coverage.",
    ),
});

// Related hits add nearest non-abstract context and embedding similarity to
// paper metadata.
const RelatedPaperOut = PaperOut.extend({
  paper_id: z
    .string()
    .optional()
    .describe(
      "Lune paper UUID. A fetch handle for get_paper_fulltext; do not show it " +
        "to the user. Cite by title, authors, and venue.",
    ),
  conference: z
    .string()
    .optional()
    .describe("Conference short name (e.g. NeurIPS)."),
  contexts: z
    .array(MatchedContextOut)
    .describe(
      "Nearest non-abstract matched chunk(s) from this related paper, " +
        "currently at most one. Empty when no parsed chunk is available.",
    ),
  similarity: z
    .number()
    .optional()
    .describe(
      "Embedding cosine similarity to the seed paper (higher is nearer, ~1 is " +
        "almost identical). Use it to gauge how related each neighbour is.",
    ),
});

export const SearchRelatedOutput = z.object({
  papers: z
    .array(RelatedPaperOut)
    .describe(
      "Semantically nearest papers by embedding distance (NOT citation links), " +
        "ordered nearest-first; empty when none were found.",
    ),
});

export const GetCitationsOutput = z.object({
  direction: z.enum(["cited_by", "cites"]).optional(),
  total: z
    .number()
    .int()
    .optional()
    .describe("Total visible citation edges in this direction (paging count)."),
  has_more: z
    .boolean()
    .optional()
    .describe(
      "True when more edges exist past this page; re-call with offset += limit.",
    ),
  citations: z.array(CitationOut),
});

export const ListConferencesOutput = z.object({
  conferences: z.array(ConferenceOut),
});

export const GetConferencePapersOutput = z.object({
  // Browse pages reuse PaperOut but omit optional abstracts to keep results
  // light.
  papers: z.array(PaperOut),
  total: z
    .number()
    .int()
    .optional()
    .describe(
      "Total papers at this venue matching the filters (paging count).",
    ),
  has_more: z
    .boolean()
    .optional()
    .describe(
      "True when more papers exist past this page; re-call with offset += limit.",
    ),
});

export const SearchGuidanceOutput = z.object({
  results: z.array(GuidanceHitOut),
});

export const GetGuidanceDocOutput = GuidanceDocOut;

// Extraction fields are caller-defined open records; each input id lands in
// rows or papers_failed, matching papers_processed.
export const ExtractOutput = z.object({
  rows: z
    .array(
      z.object({
        paper_id: z
          .string()
          .describe("Lune paper UUID this row was extracted from."),
        fields: z
          .record(z.string(), z.unknown())
          .describe(
            "The requested fields as a typed object, keyed by the `name` you " +
              "asked for. A field the model could not ground in the text may be " +
              "absent or null.",
          ),
        truncated: z
          .boolean()
          .describe(
            "True when the paper's full text overflowed the char budget and the " +
              "tail was dropped before extraction; treat the row as " +
              "partial-context rather than authoritative.",
          ),
      }),
    )
    .describe("One row per successfully extracted paper."),
  papers_processed: z
    .number()
    .int()
    .describe(
      "Total papers attempted; equals rows.length + papers_failed.length.",
    ),
  papers_failed: z
    .array(
      z.object({
        paper_id: z.string(),
        reason: z
          .string()
          .describe(
            "Why this paper yielded no row: `no_fulltext` (nothing parsed), " +
              "`extraction_failed` (the model returned no valid row), or an " +
              "exception class name.",
          ),
      }),
    )
    .describe(
      "Papers that yielded no row; recorded here instead of sinking the batch. " +
        "Empty when every paper extracted.",
    ),
});

// The server checks quotes and paper ids against retrieved candidates;
// claims_processed always matches verdicts.length.
export const VerifyOutput = z.object({
  verdicts: z
    .array(
      z.object({
        claim: z.string().describe("The input claim this verdict judges."),
        verdict: z
          .enum(["supported", "unsupported", "insufficient_evidence"])
          .describe(
            "`supported`: a retrieved passage directly substantiates the claim. " +
              "`unsupported`: a retrieved passage directly contradicts it. " +
              "`insufficient_evidence`: the corpus passages neither confirm nor " +
              "deny it (also the safe degrade when verification was unavailable).",
          ),
        supporting_paper_ids: z
          .array(z.string())
          .describe(
            "Lune paper UUIDs of the retrieved passages the verdict relied on " +
              "(a subset of the candidates retrieved for this claim, never " +
              "invented). Fetch full text with get_paper_fulltext.",
          ),
        verbatim_quote: z
          .string()
          .nullable()
          .describe(
            "Text copied verbatim from a retrieved passage that grounds the " +
              "verdict, or null when none could be quoted. Verified server-side " +
              "against a passage from one of supporting_paper_ids (compared with " +
              "whitespace normalised), " +
              "so it is safe to quote directly. A supported/unsupported verdict " +
              "failing that check is downgraded to insufficient_evidence with " +
              "the quote dropped, so those two are always citable.",
          ),
        confidence: z
          .number()
          .describe("The judge's confidence in this verdict, 0..1."),
        reasoning: z
          .string()
          .describe(
            "Short justification for the verdict, grounded in the passages.",
          ),
      }),
    )
    .describe("One grounded verdict per input claim, in input order."),
  claims_processed: z
    .number()
    .int()
    .describe("Total claims judged; equals verdicts.length."),
});

// Preserve gap, failure, stop, draft, and metering state; nullable API fields
// must stay nullable for structuredContent validation.
const EvidenceSpanOut = z.object({
  span_id: z.string(),
  source: z.literal("papers"),
  span_kind: z.enum(["chunk", "abstract"]),
  paper_id: z
    .string()
    .describe(
      "Lune paper UUID; a fetch handle for get_paper_fulltext, not for display.",
    ),
  chunk_id: z.string().nullable(),
  title: z.string(),
  authors: z.array(z.string()),
  year: z.number().int().nullable(),
  conference: z.string().nullable(),
  section: z.string(),
  quote: z
    .string()
    .describe("The exact retrieved text (matched chunk or abstract floor)."),
  score: z.number(),
  rerank_score: z.number().nullable(),
  matched_queries: z.array(
    z.object({ query: z.string(), rank: z.number().int() }),
  ),
});

export const GatherEvidenceOutput = z.object({
  requirements: z
    .array(
      z.object({
        key: z.string(),
        description: z.string(),
        status: z.enum(["covered", "partial", "missing"]),
        supporting_span_ids: z.array(z.string()),
        supporting_quote: z
          .string()
          .nullable()
          .describe(
            "Verbatim quote from a supporting span (verified server-side); null " +
              "for a missing requirement.",
          ),
        confidence: z.number(),
        reasoning: z.string(),
      }),
    )
    .describe("One coverage row per requirement: covered / partial / missing."),
  evidence_spans: z
    .array(EvidenceSpanOut)
    .describe(
      "The spans the judge evaluated; every supporting_span_id points here.",
    ),
  next_queries: z
    .array(z.string())
    .describe(
      "Suggested follow-up search angles for partial / missing requirements.",
    ),
  // Keep this enum aligned with the API, including time_budget partial results
  // from the 75-second wall-clock guard.
  stop_reason: z.enum([
    "sufficient",
    "max_iterations",
    "max_total_queries",
    "no_progress",
    "judge_unavailable",
    "time_budget",
  ]),
  draft_support: z
    .array(
      z.object({
        sentence: z.string(),
        status: z.enum(["supported", "unsupported", "insufficient_evidence"]),
        verbatim_quote: z.string().nullable(),
        supporting_paper_ids: z.array(z.string()),
        supporting_span_ids: z.array(z.string()),
      }),
    )
    .nullable()
    .describe(
      "Per-sentence support for a supplied draft, or null when no draft was sent.",
    ),
  queries_failed: z
    .array(z.object({ query: z.string(), reason: z.string() }))
    .describe(
      "Per-query failures (non-CircuitBreaker); a systemic outage 503s instead.",
    ),
  iterations_run: z.number().int(),
  queries_run: z
    .number()
    .int()
    .describe("Actual searches run (<= units_charged)."),
  units_charged: z
    .number()
    .int()
    .describe(
      "Billed ceiling (max_total_queries, default len(queries), cap 25).",
    ),
});

/**
 * One design reference. The analysis fields are the point of the tool: they are
 * what an agent can act on without spending context on the image.
 */
const FigureOut = z.object({
  figure_id: z.string(),
  paper_id: z
    .string()
    .describe(
      "Lune paper UUID. A fetch handle for get_paper_fulltext or " +
        "get_paper_figures; do NOT show it to the user.",
    ),
  paper_title: z.string(),
  paper_authors: z.array(z.string()),
  year: z.number().int().nullable().optional(),
  venue: z.string().nullable().optional(),
  doi: z.string().nullable().optional(),
  label: z.string().describe('The figure number as printed, e.g. "3".'),
  caption: z.string(),
  page_number: z.number().int().nullable().optional(),
  image_url: z
    .string()
    .nullable()
    .optional()
    .describe(
      "Public CDN URL of the cropped figure. Safe to show the user, and the " +
        "citation to put beside it is the paper's title, authors and venue.",
    ),
  width_px: z.number().int().nullable().optional(),
  height_px: z.number().int().nullable().optional(),
  role: z
    .string()
    .nullable()
    .optional()
    .describe("The rhetorical job it does."),
  communicates: z
    .string()
    .describe("One sentence on what this figure does for its paper."),
  composition: z
    .string()
    .describe("Panel arrangement and reading order. Borrow this."),
  visual_devices: z
    .array(z.string())
    .describe("Reusable techniques the figure uses, each stated concretely."),
  text_load: z.string().nullable().optional(),
  color_strategy: z.string().describe("What each hue encodes, or monochrome."),
  reuse_notes: z
    .string()
    .describe("How to adapt this composition to a different paper."),
  why_it_works: z.string().describe("The decision doing the most work."),
  score: z.number(),
});

export const SearchFiguresOutput = z.object({
  query: z.string(),
  total: z.number().int(),
  results: z.array(FigureOut),
});

export const GetPaperFiguresOutput = z.object({
  paper_id: z.string(),
  total: z.number().int(),
  figures: z.array(
    FigureOut.extend({
      is_design_reference: z
        .boolean()
        .describe(
          "True when this figure is in the reference corpus. False means it was " +
            "extracted but judged not worth learning a design from.",
        ),
    }),
  ),
});
