/**
 * Zod output schemas for every MCP tool. Mirrors the shapes returned by the
 * projectors in `_slim.ts`. Each tool's `outputSchema` is exported so the
 * MCP `tools/list` response advertises the contract, and so the call handler
 * can populate `structuredContent` matching that contract per the MCP
 * 2025-06-18 spec.
 *
 * Top-level output MUST be an object (MCP spec: `outputSchema.type` must be
 * `"object"`). Tools that conceptually return arrays wrap them in a single
 * named field (`conferences`, `citations`, `subscriptions`, etc.).
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
  id: z.string().describe("Conference UUID; pass into subscription tools."),
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
    .describe("True if paper_id is set (the edge resolves to an indexed paper)."),
  title: z.string().optional(),
  authors: z.array(z.string()).optional(),
  year: z.number().int().optional(),
  doi: z.string().optional(),
  venue: z.string().optional(),
  citation_count: z.number().int().optional(),
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

const SubscriptionOut = z.object({
  id: z.string().describe("Subscription UUID; pass into the cursor-based check tool."),
  conference_id: z.string(),
  created_at: z.string(),
});

const DrainPaperOut = PaperOut.extend({
  occurred_at: z.string().optional().describe("Timestamp the paper was indexed."),
});

const MatchedContextOut = z.object({
  section: z
    .string()
    .optional()
    .describe("Section the chunk came from (e.g. Methods, Results)."),
  text: z.string().describe("The exact matched text span from the paper."),
  score: z.number().optional().describe("Retriever relevance score for the chunk."),
  chunk_id: z
    .string()
    .optional()
    .describe("Stable id of the source chunk; deep-links the exact matched span."),
});

// Search hits default to an enriched shape with the abstract plus non-abstract
// matched `contexts`; `detail: false` returns a concise shape (title, authors,
// year, venue, citations, score, and a single grounding `snippet`). Every field
// beyond the shared `PaperOut` core is optional so both modes validate against
// one schema.
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
    .describe("True when more results exist past this page; re-call with offset += limit."),
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

// Batch (multi-query) search reuses the per-hit `SearchHitOut` shape and adds
// `matched_queries`: the provenance of which input variants surfaced this paper,
// each with its 1-based rank in that variant's own ranked list. The envelope
// reports how many variants ran, which ones failed, and `has_more` (always
// false: fusion ranks a bounded merged shortlist with no stable cursor).
const BatchSearchHitOut = SearchHitOut.extend({
  matched_queries: z
    .array(
      z.object({
        query: z.string().describe("The input query variant that surfaced this paper."),
        rank: z
          .number()
          .int()
          .describe("1-based rank of this paper within that variant's ranked list."),
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
    .describe("How many of the submitted query variants completed successfully."),
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

// Related neighbours are a search-style discovery result: each hit carries
// metadata, abstract, one nearest non-abstract matched chunk when available,
// and the embedding `similarity` to the seed paper.
const RelatedPaperOut = z.object({
  paper_id: z
    .string()
    .optional()
    .describe(
      "Lune paper UUID. A fetch handle for get_paper_fulltext; do not show it " +
        "to the user. Cite by title, authors, and venue.",
    ),
  title: z.string(),
  authors: z.array(z.string()),
  year: z.number().int().optional(),
  doi: z.string().optional(),
  arxiv_id: z.string().optional(),
  abstract: z.string().optional(),
  url: z.string().optional(),
  pdf_cdn_url: z.string().optional(),
  citation_count: z.number().int(),
  conference: z.string().optional().describe("Conference short name (e.g. NeurIPS)."),
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
    .describe("True when more edges exist past this page; re-call with offset += limit."),
  citations: z.array(CitationOut),
});

export const ListConferencesOutput = z.object({
  conferences: z.array(ConferenceOut),
});

export const GetConferencePapersOutput = z.object({
  // Same PaperOut shape, but the projector omits the abstract on a browse page
  // to keep venue pages light. `abstract` is already optional on PaperOut, so
  // a page without it still validates.
  papers: z.array(PaperOut),
  total: z
    .number()
    .int()
    .optional()
    .describe("Total papers at this venue matching the filters (paging count)."),
  has_more: z
    .boolean()
    .optional()
    .describe("True when more papers exist past this page; re-call with offset += limit."),
});

export const SearchGuidanceOutput = z.object({
  results: z.array(GuidanceHitOut),
});

export const GetGuidanceDocOutput = GuidanceDocOut;

export const ListSubscriptionsOutput = z.object({
  subscriptions: z.array(SubscriptionOut),
});

export const SubscribeOutput = SubscriptionOut;

export const UnsubscribeOutput = z.object({
  ok: z.literal(true),
  subscription_id: z.string(),
});

export const CheckUpdatesOutput = z.object({
  papers: z.array(DrainPaperOut),
  next_cursor: z.string().nullable(),
});

// Structured extraction returns one compact row per successfully extracted
// paper plus a per-paper failure list. `fields` is the caller-defined field
// schema realised as a typed object, so the value bag is an open record (its
// keys are the requested field names). Every input id is accounted for by
// exactly one `rows` or `papers_failed` entry, so
// `papers_processed === rows.length + papers_failed.length`.
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

// Claim verification returns one grounded verdict per input claim. The product
// guarantee (enforced server-side in code, not trusted from the model) is that
// `verbatim_quote` is copied from a retrieved passage (or null) and every
// `supporting_paper_ids` entry is a retrieved candidate, so the agent can cite
// the exact grounded text. `claims_processed` always equals verdicts.length.
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
              "verdict, or null when none could be quoted (always null for an " +
              "insufficient_evidence verdict). Verified server-side to be a " +
              "substring of a retrieved passage, so it is safe to quote directly.",
          ),
        confidence: z
          .number()
          .describe("The judge's confidence in this verdict, 0..1."),
        reasoning: z
          .string()
          .describe("Short justification for the verdict, grounded in the passages."),
      }),
    )
    .describe("One grounded verdict per input claim, in input order."),
  claims_processed: z
    .number()
    .int()
    .describe("Total claims judged; equals verdicts.length."),
});

// gather_evidence returns the sufficiency state: per-requirement coverage with a
// code-checked verbatim `supporting_quote`, the `evidence_spans` the judge saw,
// `next_queries` for gaps, a `stop_reason`, optional per-sentence `draft_support`,
// the `queries_failed` provenance, and metering (`queries_run` actual vs
// `units_charged` ceiling). Null-valued API fields use `.nullable()` so the
// pass-through structuredContent validates.
const EvidenceSpanOut = z.object({
  span_id: z.string(),
  source: z.literal("papers"),
  span_kind: z.enum(["chunk", "abstract"]),
  paper_id: z
    .string()
    .describe("Lune paper UUID; a fetch handle for get_paper_fulltext, not for display."),
  chunk_id: z.string().nullable(),
  title: z.string(),
  authors: z.array(z.string()),
  year: z.number().int().nullable(),
  conference: z.string().nullable(),
  section: z.string(),
  quote: z.string().describe("The exact retrieved text (matched chunk or abstract floor)."),
  score: z.number(),
  rerank_score: z.number().nullable(),
  matched_queries: z.array(z.object({ query: z.string(), rank: z.number().int() })),
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
    .describe("The spans the judge evaluated; every supporting_span_id points here."),
  next_queries: z
    .array(z.string())
    .describe("Suggested follow-up search angles for partial / missing requirements."),
  stop_reason: z.enum([
    "sufficient",
    "max_iterations",
    "max_total_queries",
    "no_progress",
    "judge_unavailable",
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
    .describe("Per-sentence support for a supplied draft, or null when no draft was sent."),
  queries_failed: z
    .array(z.object({ query: z.string(), reason: z.string() }))
    .describe("Per-query failures (non-CircuitBreaker); a systemic outage 503s instead."),
  iterations_run: z.number().int(),
  queries_run: z.number().int().describe("Actual searches run (<= units_charged)."),
  units_charged: z
    .number()
    .int()
    .describe("Billed ceiling (max_total_queries, default len(queries), cap 25)."),
});
