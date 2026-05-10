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
  conference?: RawConference | string | null;
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

interface RawSearchResponse {
  results?: RawPaper[] | unknown;
}

export function slimSearchResponse(r: RawSearchResponse | unknown) {
  const obj = (r ?? {}) as RawSearchResponse;
  const results = Array.isArray(obj.results) ? obj.results : [];
  return { results: results.map((p) => slimPaper(p)) };
}

interface RawPaperDetail extends RawPaper {
  conference?: RawConference | string | null;
}

export function slimPaperDetail(p: RawPaperDetail) {
  return slimPaper(p);
}

interface RawCitation {
  cited_paper_id?: string | null;
  cited_title?: string | null;
  cited_doi?: string | null;
  cited_year?: number | null;
  cited_authors?: string[] | null;
  cited_venue?: string | null;
}

export function slimCitations(rows: unknown) {
  const arr = Array.isArray(rows) ? (rows as RawCitation[]) : [];
  return {
    citations: arr.map((c) => ({
      cited_paper_id: c.cited_paper_id ?? undefined,
      cited_title: c.cited_title ?? undefined,
      cited_doi: c.cited_doi ?? undefined,
      cited_year: c.cited_year ?? undefined,
      cited_authors: c.cited_authors ?? undefined,
      cited_venue: c.cited_venue ?? undefined,
    })),
  };
}

interface RawConferencePapers {
  papers?: RawPaper[];
  total?: number;
  page?: number;
  total_pages?: number;
}

export function slimConferencePapers(r: RawConferencePapers | unknown) {
  const obj = (r ?? {}) as RawConferencePapers;
  return {
    papers: (obj.papers ?? []).map((p) => slimPaper(p)),
    total: obj.total,
    page: obj.page,
    total_pages: obj.total_pages,
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

interface RawGuidanceDoc {
  id?: string;
  title?: string;
  author_name?: string | null;
  author_affiliation?: string | null;
  source_url?: string | null;
  tags?: string[] | null;
}

export function slimGuidanceDoc(r: RawGuidanceDoc | unknown) {
  const obj = (r ?? {}) as RawGuidanceDoc;
  return {
    doc_id: obj.id,
    title: obj.title,
    author: obj.author_name ?? undefined,
    author_affiliation: obj.author_affiliation ?? undefined,
    source_url: obj.source_url ?? undefined,
    tags: obj.tags ?? [],
  };
}
