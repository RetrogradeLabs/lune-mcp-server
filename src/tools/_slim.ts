/**
 * Response projectors. Every MCP tool funnels its API response through one
 * of these so the agent only sees fields it can act on. Internal IDs,
 * dashboard-only delivery prefs, processing-status enums, AI fields that
 * are always null post-pivot, and other low-signal noise are dropped to
 * keep the agent's context window tight.
 *
 * Projection happens on the MCP boundary, not at the API, so the dashboard
 * can keep depending on the full schema.
 */

import {
  isJsonBoolean,
  isJsonNumber,
  isJsonString,
  type JsonInput,
} from "../json.js";

/**
 * View an unvalidated API payload as the shape this module expects of it.
 *
 * Nothing below trusts a field's runtime type: every read goes through a guard or
 * a default (`?? 0`, `|| undefined`, the `isJson*` predicates, the `has*`
 * predicates). That is deliberate, and it is the contract these projectors owe
 * the agent: an imperfect upstream response must still yield a usable result,
 * never a failed tool call. So this view can widen the payload without being able
 * to introduce a throw, and a schema parse here would trade that totality away.
 */
function optimisticView<T>(payload: JsonInput): T {
  // SAFETY: downstream field guards make this optimistic cast degrade to
  // defaults.
  return (payload ?? {}) as T;
}

/** `conference` arrives either as a short name or as a nested object. */
function isConferenceName(
  value: string | RawConference | null | undefined,
): value is string {
  return typeof value === "string";
}

/** A row whose `text` arrived as a usable string. */
function hasText<T extends { text?: string | null }>(
  row: T | null | undefined,
): row is T & { text: string } {
  return (
    row !== null &&
    row !== undefined &&
    isJsonString(row.text) &&
    row.text.length > 0
  );
}

/** Provenance that carries both halves. `rank` is 1-based, so a missing one has
 *  no meaningful default and the row is dropped rather than fabricated. */
function hasQueryAndRank<
  T extends { query?: string | null; rank?: number | null },
>(row: T | null | undefined): row is T & { query: string; rank: number } {
  return (
    row !== null &&
    row !== undefined &&
    isJsonString(row.query) &&
    isJsonNumber(row.rank)
  );
}

function hasQuery<T extends { query?: string | null }>(
  row: T | null | undefined,
): row is T & { query: string } {
  return row !== null && row !== undefined && isJsonString(row.query);
}

interface RawConference {
  id?: string;
  short_name?: string;
  full_name?: string;
  description?: string;
  category?: string | null;
  paper_count?: number;
  years?: number[];
}

export function slimConference(c: RawConference) {
  return {
    id: c.id,
    short_name: c.short_name,
    full_name: c.full_name,
    description: c.description || undefined,
    category: c.category || undefined,
    paper_count: c.paper_count ?? 0,
    years: c.years ?? [],
  };
}

export function slimConferenceList(list: JsonInput) {
  const arr = Array.isArray(list) ? list : [];

  return {
    conferences: arr
      .filter(Boolean)
      .map((c) => slimConference(optimisticView<RawConference>(c))),
  };
}

interface RawMatchedChunk {
  section_name?: string | null;
  text?: string | null;
  score?: number | null;
  chunk_id?: string | null;
}

interface RawPaper {
  id?: string;
  paper_id?: string;
  title?: string;
  authors?: string[];
  year?: number | null;
  doi?: string | null;
  arxiv_id?: string | null;
  abstract?: string;
  pdf_cdn_url?: string | null;
  url?: string | null;
  citation_count?: number;
  score?: number | null;
  rerank_score?: number | null;
  conference?: RawConference | string | null;
  matched_chunks?: RawMatchedChunk[] | null;
}

export function slimPaper(p: RawPaper) {
  return {
    paper_id: p.paper_id ?? p.id,
    title: p.title,
    authors: p.authors ?? [],
    year: p.year ?? undefined,
    doi: p.doi ?? undefined,
    arxiv_id: p.arxiv_id ?? undefined,
    abstract: p.abstract || undefined,
    pdf_cdn_url: p.pdf_cdn_url ?? undefined,
    url: p.url ?? undefined,
    citation_count: p.citation_count ?? 0,
    conference: isConferenceName(p.conference)
      ? p.conference
      : p.conference?.short_name,
  };
}

function isAbstractSection(section: string | null | undefined): boolean {
  return section?.trim().toLowerCase() === "abstract";
}

/**
 * Project the API's per-hit `matched_chunks` (the actual text spans inside the
 * paper that matched the query, scored by the hybrid retriever) into the slim
 * `contexts` shape surfaced to the agent. The paper abstract is returned as its
 * own field in the enriched search shape, so abstract-section chunks are
 * dropped here to avoid duplicating the same evidence twice.
 */
function slimContexts(chunks: RawMatchedChunk[] | null | undefined) {
  if (!Array.isArray(chunks)) return [];

  return chunks.flatMap((chunk) =>
    hasText(chunk) && !isAbstractSection(chunk.section_name)
      ? [
          {
            section: chunk.section_name || undefined,
            text: chunk.text,
            score: isJsonNumber(chunk.score) ? chunk.score : undefined,
            chunk_id: chunk.chunk_id || undefined,
          },
        ]
      : [],
  );
}

interface RawSearchResponse {
  results?: RawPaper[];
  has_more?: boolean;
}

// Abstain only on calibrated rerank_score, never boosted score; without
// reranking there is no calibrated basis for the floor.
const LOW_CONFIDENCE_THRESHOLD = 0.3;

// Build the search-envelope abstention tail: best of the numeric `rerank_score`s
// (null when none reranked), `low_confidence` when it falls below the floor.
function withAbstention<T extends { rerank_score?: number | null | undefined }>(
  results: T[],
  hasMore: boolean,
) {
  const rerankScores = results.flatMap((hit) => {
    const score = hit.rerank_score;

    return isJsonNumber(score) ? [score] : [];
  });

  const bestScore = rerankScores.length ? Math.max(...rerankScores) : null;

  return {
    results,
    has_more: hasMore,
    best_score: bestScore,
    low_confidence: bestScore !== null && bestScore < LOW_CONFIDENCE_THRESHOLD,
  };
}

const SNIPPET_MAX = 280;

const CONCISE_AUTHOR_LIMIT = 6;

// Prefer top non-abstract context, then a truncated abstract, so concise hits
// stay grounded.
function bestSnippet(p: RawPaper): string | undefined {
  const chunks = slimContexts(p.matched_chunks);

  if (chunks.length > 0) return chunks[0]!.text;
  const abstract = p.abstract || "";

  if (!abstract) return undefined;

  return abstract.length > SNIPPET_MAX
    ? `${abstract.slice(0, SNIPPET_MAX)}...`
    : abstract;
}

// Preserve boosted score and optional rerank_score; detail:false drops heavy
// fields, trims authors, and adds one snippet.
function projectHit(p: RawPaper, detail: boolean) {
  const base = slimPaper(p);
  const score = isJsonNumber(p.score) ? p.score : undefined;

  const rerank_score = isJsonNumber(p.rerank_score)
    ? p.rerank_score
    : undefined;

  if (detail) {
    return {
      ...base,
      score,
      rerank_score,
      contexts: slimContexts(p.matched_chunks),
    };
  }

  const authors = base.authors ?? [];

  return {
    paper_id: base.paper_id,
    title: base.title,
    authors: authors.slice(0, CONCISE_AUTHOR_LIMIT),
    et_al_count: Math.max(0, authors.length - CONCISE_AUTHOR_LIMIT),
    year: base.year,
    conference: base.conference,
    citation_count: base.citation_count,
    score,
    rerank_score,
    snippet: bestSnippet(p),
  };
}

/**
 * Slim the hybrid-search response. The envelope's `best_score` / `low_confidence`
 * derive from `rerank_score` ONLY (Cohere Rerank v3.5, calibrated 0..1), never the
 * boosted `score`; when no hit was reranked (keyword / BM25 queries) `best_score`
 * is null and `low_confidence` false (no calibrated basis to abstain). Per-hit
 * shape is `projectHit` (enriched default vs `detail: false` concise).
 */
export function slimSearchResponse(r: JsonInput, detail = true) {
  const obj = optimisticView<RawSearchResponse>(r);
  const results = Array.isArray(obj.results) ? obj.results : [];
  const projected = results.map((p) => projectHit(p, detail));

  // The API reports whether more results exist past this window; default to
  // false when the field is absent (a pre-deploy API) so the agent stops here.
  return withAbstention(
    projected,
    isJsonBoolean(obj.has_more) ? obj.has_more : false,
  );
}

interface RawWorkspaceSpan {
  document_id?: string | null;
  chunk_id?: string | null;
  filename?: string | null;
  title?: string | null;
  section_name?: string | null;
  text?: string | null;
  score?: number | null;
  rerank_score?: number | null;
}

interface RawWorkspaceSearchResponse {
  results?: RawWorkspaceSpan[];
}

type WorkspaceHit = {
  paper_id: string;
  title: string;
  authors: string[];
  // Omit absent workspace year and conference because the output schema permits
  // values or absence, not null.
  citation_count: number;
  score: number | undefined;
  rerank_score: number | undefined;
  contexts: {
    section?: string | undefined;
    text: string;
    score?: number | undefined;
    chunk_id?: string | undefined;
  }[];
};

/**
 * Slim the workspace search response into the SAME hit shape as corpus search
 * (`slimSearchResponse`), so `search_papers(source="workspace")` returns a
 * uniform result the agent reads identically. The API returns flat reranked
 * spans; we GROUP them by document into one hit per document (preserving the
 * reranked order of first appearance), each span becoming a `contexts` entry. A
 * workspace document carries no bibliographic metadata, so authors / year /
 * venue / doi are empty and `paper_id` is the document id (for citing + reading
 * via `get_paper_fulltext(source="workspace")`). `best_score` / `low_confidence`
 * derive from `rerank_score` exactly as for the corpus.
 */
export function slimWorkspaceSearchAsHits(r: JsonInput) {
  const obj = optimisticView<RawWorkspaceSearchResponse>(r);
  const spans = Array.isArray(obj.results) ? obj.results : [];
  const byDoc = new Map<string, WorkspaceHit>();

  for (const sp of spans) {
    if (!hasText(sp)) continue;
    const docId = sp.document_id ? String(sp.document_id) : "";

    if (!docId) continue;
    const score = isJsonNumber(sp.score) ? sp.score : undefined;
    const rerank = isJsonNumber(sp.rerank_score) ? sp.rerank_score : undefined;
    let hit = byDoc.get(docId);

    if (!hit) {
      hit = {
        paper_id: docId,
        title: sp.title || sp.filename || "Untitled document",
        authors: [],
        citation_count: 0,
        score,
        rerank_score: rerank,
        contexts: [],
      };
      byDoc.set(docId, hit);
    } else {
      // Keep the document's strongest span scores at the hit level.
      if (
        score !== undefined &&
        (hit.score === undefined || score > hit.score)
      ) {
        hit.score = score;
      }

      if (
        rerank !== undefined &&
        (hit.rerank_score === undefined || rerank > hit.rerank_score)
      ) {
        hit.rerank_score = rerank;
      }
    }

    hit.contexts.push({
      section: sp.section_name || undefined,
      text: sp.text,
      score,
      chunk_id: sp.chunk_id || undefined,
    });
  }

  const results = [...byDoc.values()];

  return withAbstention(results, false);
}

interface RawMatchedQuery {
  query?: string | null;
  rank?: number | null;
}

interface RawBatchHit extends RawPaper {
  matched_queries?: RawMatchedQuery[] | null;
}

interface RawBatchFailure {
  query?: string | null;
  reason?: string | null;
}

interface RawBatchSearchResponse {
  results?: RawBatchHit[];
  queries_run?: number;
  queries_failed?: RawBatchFailure[];
  has_more?: boolean;
}

/**
 * Slim the multi-query (batch) search response. Each hit runs through the SAME
 * per-hit `projectHit` projector as single search (so `detail: false` drops the
 * heavy abstract / ids and attaches one grounding `snippet`), then ALWAYS keeps
 * its `matched_queries` provenance (which input variants surfaced it, each with
 * a 1-based rank). The envelope keeps `queries_run`, `queries_failed`, and
 * `has_more` regardless of detail. Unlike single search there is no
 * `best_score` / `low_confidence`: the API fuses N ranked lists by RRF, so a
 * single calibrated rerank floor across the merge is not meaningful.
 */
export function slimSearchManyResponse(r: JsonInput, detail = true) {
  const obj = optimisticView<RawBatchSearchResponse>(r);
  const results: RawBatchHit[] = Array.isArray(obj.results) ? obj.results : [];

  const projected = results.map((p) => ({
    ...projectHit(p, detail),
    matched_queries: Array.isArray(p.matched_queries)
      ? p.matched_queries
          // Drop malformed provenance rather than fabricate a rank: `rank` is a
          // 1-based position, so a missing one has no meaningful default.
          .flatMap((query) =>
            hasQueryAndRank(query)
              ? [{ query: query.query, rank: query.rank }]
              : [],
          )
      : [],
  }));

  const failed: RawBatchFailure[] = Array.isArray(obj.queries_failed)
    ? obj.queries_failed
    : [];

  return {
    results: projected,
    queries_run: isJsonNumber(obj.queries_run) ? obj.queries_run : 0,
    queries_failed: failed.flatMap((failure) =>
      hasQuery(failure)
        ? [{ query: failure.query, reason: failure.reason ?? "" }]
        : [],
    ),
    // The API ranks a bounded merged shortlist, so `has_more` is always false;
    // default to false when absent (e.g. a pre-deploy API).
    has_more: isJsonBoolean(obj.has_more) ? obj.has_more : false,
  };
}

interface RawRelatedPaper {
  paper_id?: string | null;
  id?: string | null;
  title?: string | null;
  authors?: string[] | null;
  year?: number | null;
  doi?: string | null;
  arxiv_id?: string | null;
  abstract?: string | null;
  url?: string | null;
  pdf_cdn_url?: string | null;
  citation_count?: number | null;
  conference?: RawConference | string | null;
  similarity?: number | null;
  matched_chunks?: RawMatchedChunk[] | null;
}

/** Project the related-papers list (a bare array) into a named field. Related
 * search mirrors paper search's enriched default: abstract plus non-abstract
 * matched chunks are included so the agent can evaluate neighbours without a
 * separate hydration call. */
export function slimRelated(rows: JsonInput) {
  const arr = Array.isArray(rows) ? rows : [];

  return {
    papers: arr.map((raw) => {
      const p = optimisticView<RawRelatedPaper>(raw);

      return {
        ...slimPaper(optimisticView<RawPaper>(raw)),
        contexts: slimContexts(p.matched_chunks),
        similarity: isJsonNumber(p.similarity) ? p.similarity : undefined,
      };
    }),
  };
}

interface RawCitationContext {
  section?: string | null;
  text?: string | null;
}

interface RawCitedPaper {
  id?: string | null;
  title?: string | null;
  authors?: string[] | null;
  year?: number | null;
  doi?: string | null;
  venue?: string | null;
  citation_count?: number | null;
  contexts?: (RawCitationContext | null)[] | null;
}

function slimCitationContexts(
  contexts: (RawCitationContext | null)[] | null | undefined,
) {
  if (!Array.isArray(contexts)) return undefined;

  return contexts.filter(hasText).map((context) => ({
    section: isJsonString(context.section) ? context.section : "",
    text: context.text,
  }));
}

interface RawCitationsResponse {
  paper_id?: string;
  direction?: "cited_by" | "cites";
  papers?: RawCitedPaper[];
  total?: number;
  has_more?: boolean;
}

export function slimCitations(r: JsonInput) {
  const obj = optimisticView<RawCitationsResponse>(r);
  const papers = Array.isArray(obj.papers) ? obj.papers : [];

  return {
    direction: obj.direction,
    // Keep paging optional for older APIs; total counts visible edges and
    // has_more signals later pages.
    total: isJsonNumber(obj.total) ? obj.total : undefined,
    has_more: isJsonBoolean(obj.has_more) ? obj.has_more : undefined,
    citations: papers.map((c) => ({
      // id means corpus-resolved and fetchable; in_corpus distinguishes it from
      // display-only references.
      paper_id: c.id ?? undefined,
      in_corpus: c.id != null,
      title: c.title ?? undefined,
      authors: c.authors ?? undefined,
      year: c.year ?? undefined,
      doi: c.doi ?? undefined,
      venue: c.venue ?? undefined,
      citation_count: c.citation_count ?? undefined,
      contexts: slimCitationContexts(c.contexts),
    })),
  };
}

interface RawConferencePapers {
  papers?: RawPaper[];
  total?: number;
  page?: number;
  limit?: number;
  total_pages?: number;
}

// Omit abstracts and compute has_more from request offset plus returned count;
// API page loses non-multiple offsets through floor division.
export function slimConferencePapers(r: JsonInput, offset = 0) {
  const obj = optimisticView<RawConferencePapers>(r);
  const total = obj.total ?? 0;

  const papers = (obj.papers ?? []).map((p) => {
    const { abstract: _abstract, ...rest } = slimPaper(p);

    return rest;
  });

  return {
    papers,
    total: obj.total,
    has_more: offset + papers.length < total,
  };
}

interface RawGuidanceHit {
  doc_id?: string;
  doc_title?: string;
  doc_source_url?: string | null;
  section_name?: string;
  content?: string;
}

interface RawGuidanceSearchResponse {
  results?: RawGuidanceHit[];
}

export function slimGuidanceSearch(r: JsonInput) {
  const obj = optimisticView<RawGuidanceSearchResponse>(r);

  return {
    results: (obj.results ?? []).map((h) => ({
      doc_id: h.doc_id,
      doc_title: h.doc_title,
      source_url: h.doc_source_url ?? undefined,
      section: h.section_name,
      excerpt: h.content,
    })),
  };
}

interface RawGuidanceSection {
  heading?: string | null;
  text?: string | null;
}

interface RawGuidanceDoc {
  id?: string;
  title?: string;
  author_name?: string | null;
  author_affiliation?: string | null;
  source_url?: string | null;
  tags?: string[] | null;
  content?: string | null;
  sections?: RawGuidanceSection[] | null;
}

export function slimGuidanceDoc(r: JsonInput) {
  const obj = optimisticView<RawGuidanceDoc>(r);

  const sections = Array.isArray(obj.sections)
    ? obj.sections
        .filter(hasText)
        .map((s) => ({ heading: s.heading || "Body", text: s.text }))
    : [];

  return {
    doc_id: obj.id,
    title: obj.title,
    author: obj.author_name ?? undefined,
    author_affiliation: obj.author_affiliation ?? undefined,
    source_url: obj.source_url ?? undefined,
    tags: obj.tags ?? [],
    // content is the reassembled document; sections repeats it by heading for
    // structured callers.
    content: obj.content ?? undefined,
    sections,
  };
}
