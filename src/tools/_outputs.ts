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
        "get_paper_fulltext (or richer metadata via get_paper); do NOT show it " +
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
  cited_paper_id: z.string().optional(),
  cited_title: z.string().optional(),
  cited_doi: z.string().optional(),
  cited_year: z.number().int().optional(),
  cited_authors: z.array(z.string()).optional(),
  cited_venue: z.string().optional(),
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
});

// Search hits optionally carry `contexts` (the matched text chunks inside the
// paper) when the caller passes `should_include_context: true`. The field is
// optional so the default (contexts-off) response still validates.
const SearchHitOut = PaperOut.extend({
  contexts: z
    .array(MatchedContextOut)
    .optional()
    .describe(
      "Present only when should_include_context is true: the exact matched " +
        "text spans inside this paper. Use these to ground an answer; for the " +
        "complete text, call get_paper_fulltext with the paper_id.",
    ),
});

export const SearchPapersOutput = z.object({
  results: z.array(SearchHitOut),
});

export const GetPaperOutput = PaperOut;

export const GetCitationsOutput = z.object({
  citations: z.array(CitationOut),
});

export const ListConferencesOutput = z.object({
  conferences: z.array(ConferenceOut),
});

export const GetConferencePapersOutput = z.object({
  papers: z.array(PaperOut),
  total: z.number().int().optional(),
  page: z.number().int().optional(),
  total_pages: z.number().int().optional(),
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
