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

export function slimConferenceList(list: unknown) {
  const arr = Array.isArray(list) ? list : [];
  return {
    conferences: arr
      .filter(Boolean)
      .map((c) => slimConference(c as RawConference)),
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
    conference:
      typeof p.conference === "string"
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
  return chunks
    .filter(
      (c) =>
        c &&
        typeof c.text === "string" &&
        c.text.length > 0 &&
        !isAbstractSection(c.section_name),
    )
    .map((c) => ({
      section: c.section_name || undefined,
      text: c.text as string,
      score: typeof c.score === "number" ? c.score : undefined,
      chunk_id: c.chunk_id || undefined,
    }));
}

interface RawSearchResponse {
  results?: RawPaper[] | unknown;
  has_more?: boolean;
}

// Cohere Rerank v3.5 `rerank_score` is a calibrated 0..1 relevance. This floor
// is a pragmatic "nothing strong matched" abstention signal. It is applied to
// `rerank_score` ONLY (never the boosted `score`, which is not a calibrated
// relevance): when no hit was reranked we have no calibrated basis to abstain.
const LOW_CONFIDENCE_THRESHOLD = 0.3;

const SNIPPET_MAX = 280;
const CONCISE_AUTHOR_LIMIT = 6;

// Pick the single grounding snippet for a concise hit: prefer the top
// non-abstract matched span, else fall back to a truncated abstract so the
// agent always has something to skim in token-saving mode.
function bestSnippet(p: RawPaper): string | undefined {
  const chunks = slimContexts(p.matched_chunks);
  if (chunks.length > 0) return chunks[0]!.text;
  const abstract = p.abstract || "";
  if (!abstract) return undefined;
  return abstract.length > SNIPPET_MAX
    ? `${abstract.slice(0, SNIPPET_MAX)}...`
    : abstract;
}

// Project one hit. Always carries the final ranking `score` (which folds in a
// citation/freshness boost, so it is NOT a calibrated relevance) and, when the
// reranker ran, the raw `rerank_score` (Cohere Rerank v3.5, calibrated 0..1);
// `rerank_score` is omitted for keyword / BM25-dominated queries that skip the
// reranker. The default enriched shape returns the full paper (abstract, ids,
// pdf link) plus its `contexts` array (the non-abstract matched
// `matched_chunks` spans). `detail: false` opts down to a concise shape that
// drops the heavier fields, trims the author list, and attaches a single
// grounding `snippet` for cheap triage.
function projectHit(p: RawPaper, detail: boolean) {
  const base = slimPaper(p);
  const score = typeof p.score === "number" ? p.score : undefined;
  const rerank_score =
    typeof p.rerank_score === "number" ? p.rerank_score : undefined;
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
 * Slim the hybrid-search response. Each hit carries the final ranking `score`
 * (boosted, NOT a calibrated relevance) and, when the reranker ran, the raw
 * `rerank_score` (Cohere Rerank v3.5, calibrated 0..1). The envelope adds
 * `best_score` and `low_confidence`, BOTH derived from `rerank_score` (the
 * calibrated value), so a consumer can threshold and abstain. When NO hit has a
 * numeric `rerank_score` (keyword / BM25-dominated queries that skip the
 * reranker), `best_score` is null and `low_confidence` is false: there is no
 * calibrated basis to abstain. By default each hit additionally carries the
 * abstract and a `contexts` array (its non-abstract `matched_chunks` from the
 * API: the exact matched text spans). Pass `detail: false` to opt down to the
 * concise snippet shape for very broad exploratory scans.
 */
export function slimSearchResponse(
  r: RawSearchResponse | unknown,
  detail = true,
) {
  const obj = (r ?? {}) as RawSearchResponse;
  const results = Array.isArray(obj.results) ? obj.results : [];
  const projected = results.map((p) => projectHit(p, detail));
  // Abstention is keyed on the CALIBRATED rerank score only. A query that
  // skipped the reranker (no numeric rerank_score on any hit) yields a null
  // best_score and low_confidence=false: the boosted `score` is a different
  // family (it can exceed 1.0) and must never feed the 0..1 abstention cut-off.
  const rerankScores = projected
    .map((h) => h.rerank_score)
    .filter((s): s is number => typeof s === "number");
  const bestScore = rerankScores.length ? Math.max(...rerankScores) : null;
  return {
    results: projected,
    // The API pages search after the rerank/boost and reports whether more
    // results exist past this window. Default to false when the field is
    // absent (e.g. a pre-deploy API) so the agent never pages off the end.
    has_more: typeof obj.has_more === "boolean" ? obj.has_more : false,
    best_score: bestScore,
    low_confidence:
      bestScore !== null && bestScore < LOW_CONFIDENCE_THRESHOLD,
  };
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
  results?: RawBatchHit[] | unknown;
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
export function slimSearchManyResponse(
  r: RawBatchSearchResponse | unknown,
  detail = true,
) {
  const obj = (r ?? {}) as RawBatchSearchResponse;
  const results: RawBatchHit[] = Array.isArray(obj.results) ? obj.results : [];
  const projected = results.map((p) => ({
    ...projectHit(p, detail),
    matched_queries: Array.isArray(p.matched_queries)
      ? p.matched_queries
          // Drop malformed provenance rather than fabricate a rank: `rank` is a
          // 1-based position, so a missing one has no meaningful default.
          .filter(
            (mq) => mq && typeof mq.query === "string" && typeof mq.rank === "number",
          )
          .map((mq) => ({ query: mq.query as string, rank: mq.rank as number }))
      : [],
  }));
  const failed: RawBatchFailure[] = Array.isArray(obj.queries_failed)
    ? obj.queries_failed
    : [];
  return {
    results: projected,
    queries_run: typeof obj.queries_run === "number" ? obj.queries_run : 0,
    queries_failed: failed
      .filter((f) => f && typeof f.query === "string")
      .map((f) => ({ query: f.query as string, reason: f.reason ?? "" })),
    // The API ranks a bounded merged shortlist, so `has_more` is always false;
    // default to false when absent (e.g. a pre-deploy API).
    has_more: typeof obj.has_more === "boolean" ? obj.has_more : false,
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
export function slimRelated(rows: unknown) {
  const arr = Array.isArray(rows) ? rows : [];
  return {
    papers: arr.map((raw) => {
      const p = raw as RawRelatedPaper;
      return {
        paper_id: p.paper_id ?? p.id,
        title: p.title,
        authors: p.authors ?? [],
        year: p.year ?? undefined,
        doi: p.doi ?? undefined,
        arxiv_id: p.arxiv_id ?? undefined,
        abstract: p.abstract || undefined,
        url: p.url ?? undefined,
        pdf_cdn_url: p.pdf_cdn_url ?? undefined,
        citation_count: p.citation_count ?? 0,
        conference:
          typeof p.conference === "string"
            ? p.conference
            : p.conference?.short_name,
        contexts: slimContexts(p.matched_chunks),
        similarity: typeof p.similarity === "number" ? p.similarity : undefined,
      };
    }),
  };
}

interface RawCitedPaper {
  id?: string | null;
  title?: string | null;
  authors?: string[] | null;
  year?: number | null;
  doi?: string | null;
  venue?: string | null;
  citation_count?: number | null;
}

interface RawCitationsResponse {
  paper_id?: string;
  direction?: "cited_by" | "cites";
  papers?: RawCitedPaper[];
  total?: number;
  has_more?: boolean;
}

export function slimCitations(r: RawCitationsResponse | unknown) {
  const obj = (r ?? {}) as RawCitationsResponse;
  const papers = Array.isArray(obj.papers) ? obj.papers : [];
  return {
    direction: obj.direction,
    // Paging metadata: `total` is the visible-edge count, `has_more` says
    // whether more edges exist past this page. Both optional so a pre-deploy
    // API that omits them still validates.
    total: typeof obj.total === "number" ? obj.total : undefined,
    has_more: typeof obj.has_more === "boolean" ? obj.has_more : undefined,
    citations: papers.map((c) => ({
      // `id` present => the edge resolved to a paper in our corpus, so the
      // agent can fetch it. Absent => a parsed-only reference (display fields
      // only). `in_corpus` makes that distinction explicit and actionable.
      paper_id: c.id ?? undefined,
      in_corpus: c.id != null,
      title: c.title ?? undefined,
      authors: c.authors ?? undefined,
      year: c.year ?? undefined,
      doi: c.doi ?? undefined,
      venue: c.venue ?? undefined,
      citation_count: c.citation_count ?? undefined,
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

// Conference browse: a lean per-paper shape WITHOUT the abstract, because a
// page of N venue papers should stay light. Pagination is reported as `total`
// + `has_more`, the same vocab every other paged tool uses (the API's
// page/total_pages is collapsed away).
export function slimConferencePapers(r: RawConferencePapers | unknown) {
  const obj = (r ?? {}) as RawConferencePapers;
  const page = obj.page ?? 1;
  const limit = obj.limit ?? 0;
  const total = obj.total ?? 0;
  return {
    papers: (obj.papers ?? []).map((p) => {
      const { abstract: _abstract, ...rest } = slimPaper(p);
      return rest;
    }),
    total: obj.total,
    has_more: limit > 0 && page * limit < total,
  };
}

interface RawSubscription {
  id?: string;
  conference_id?: string;
  created_at?: string;
}

export function slimSubscription(s: RawSubscription) {
  return {
    id: s.id,
    conference_id: s.conference_id,
    created_at: s.created_at,
  };
}

export function slimSubscriptionList(list: unknown) {
  const arr = Array.isArray(list) ? list : [];
  return {
    subscriptions: arr
      .filter(Boolean)
      .map((s) => slimSubscription(s as RawSubscription)),
  };
}

interface RawDrainPaper extends RawPaper {
  occurred_at?: string;
}

interface RawDrainResponse {
  papers?: RawDrainPaper[];
  next_cursor?: string | null;
}

export function slimDrainResponse(r: RawDrainResponse | unknown) {
  const obj = (r ?? {}) as RawDrainResponse;
  return {
    papers: (obj.papers ?? []).map((p) => ({
      ...slimPaper(p),
      occurred_at: p.occurred_at,
    })),
    next_cursor: obj.next_cursor ?? null,
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

export function slimGuidanceSearch(r: RawGuidanceSearchResponse | unknown) {
  const obj = (r ?? {}) as RawGuidanceSearchResponse;
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

export function slimGuidanceDoc(r: RawGuidanceDoc | unknown) {
  const obj = (r ?? {}) as RawGuidanceDoc;
  const sections = Array.isArray(obj.sections)
    ? obj.sections
        .filter((s) => s && typeof s.text === "string" && s.text.length > 0)
        .map((s) => ({ heading: s.heading || "Body", text: s.text as string }))
    : [];
  return {
    doc_id: obj.id,
    title: obj.title,
    author: obj.author_name ?? undefined,
    author_affiliation: obj.author_affiliation ?? undefined,
    source_url: obj.source_url ?? undefined,
    tags: obj.tags ?? [],
    // The reassembled full document body (the whole point of this tool, vs
    // the matched excerpt from search_research_guidance). `sections` carries
    // the same text split by heading for callers that want structure.
    content: obj.content ?? undefined,
    sections,
  };
}
