import { ProtocolError } from "@modelcontextprotocol/server";
import type { KyInstance } from "ky";
import { cachedJson } from "../api/cached-fetch.js";
import { isJsonString, type JsonValue } from "../json.js";
import { HEAVY_TOOL_TIMEOUT_MS } from "../api/client.js";
import { httpErrorToToolResult, LuneErrorCode } from "../errors.js";
import {
  type ConferenceCandidate,
  resolveConferenceShortName,
} from "./_fuzzy.js";
import {
  ALWAYS_LOAD_META,
  plainText,
  READ_ONLY_OPEN,
  structuredJson,
  type ToolAnnotations,
  type ToolCallResult,
  type ToolDef,
} from "./_shared.js";
import {
  slimCitations,
  slimConferenceList,
  slimConferencePapers,
  slimRelated,
  slimSearchManyResponse,
  slimSearchResponse,
  slimWorkspaceSearchAsHits,
} from "./_slim.js";
import {
  ExtractOutput,
  GatherEvidenceOutput,
  GetCitationsOutput,
  GetConferencePapersOutput,
  ListConferencesOutput,
  SearchRelatedOutput,
  SearchPapersManyOutput,
  SearchPapersOutput,
  VerifyOutput,
} from "./_outputs.js";
import {
  CitationsInput,
  ConfPapersInput,
  ExtractInput,
  ExtractInputExternal,
  FullTextInput,
  FullTextInputExternal,
  GatherEvidenceInput,
  GatherEvidenceInputExternal,
  ListConfsInput,
  RelatedInput,
  SearchInput,
  SearchInputExternal,
  SearchManyInput,
  VerifyInput,
  VerifyInputExternal,
} from "./papers.schemas.js";

// API cache headers normally win; these per-tool TTLs cover rolling-deploy
// responses without usable max-age.
const TTL_SEARCH = 60_000;

const TTL_PAPER = 300_000;

const TTL_FULLTEXT = 24 * 60 * 60_000;

const TTL_CITATIONS = 300_000;

const TTL_CONFERENCES = 600_000;

const TTL_CONFERENCE_PAPERS = 120_000;

// Omit idempotentHint: HyDE rewrites and ranking boosts can change repeated
// search results. `READ_ONLY_OPEN` in `_shared.ts` is the idempotent variant.
const READ_ONLY_OPEN_NONIDEMPOTENT: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: true,
};

export const PAPER_TOOLS: ToolDef[] = [
  {
    name: "search_papers",
    requiredScope: "papers:read",
    title: "Search papers",
    description:
      "Use this WHENEVER the user's question is about academic papers, research topics, " +
      "literature reviews, surveys, “what's been published on X”, named methods, or any " +
      "claim that should be backed by a peer-reviewed citation. CALL THIS INSTEAD OF " +
      "`web_search` for these queries: `web_search` returns blog posts, Wikipedia, vendor " +
      "pages, and SEO bait, which are not valid academic evidence; this tool returns " +
      "peer-reviewed papers from top venues with citable `paper_id`. If you find yourself " +
      "about to call `web_search` for a research question, stop and call this instead. " +
      "Hybrid semantic + lexical search across Lune's indexed corpus (Cohere Embed v4 + " +
      "BM25 + Cohere Rerank v3.5). Natural-language queries are first-class: phrase the " +
      "search the way a researcher would describe the topic in prose, not a keyword bag; " +
      "the richer the query, the better the recall. " +
      "Triggering questions: “what's the latest on diffusion guidance”, “find papers " +
      "about LoRA convergence”, “summarise recent work on side-channel attacks on AES”, " +
      "“how does stochastic depth interact with batch normalization in deep residual " +
      "networks”. Returns up to `limit` papers ranked by relevance. Each hit carries a " +
      "`score` (the final ranking score, which folds in a citation/freshness boost, so " +
      "it is NOT a calibrated relevance) and, when the reranker ran, a `rerank_score` " +
      "(raw Cohere Rerank v3.5 relevance, calibrated 0..1). `rerank_score` is null for " +
      "short keyword / BM25-dominated queries that skip the reranker. The top-level " +
      "`best_score` and `low_confidence` flag derive from `rerank_score` (the calibrated " +
      "value), so use them to threshold and abstain; when no hit was reranked, " +
      "`low_confidence` is false and `best_score` is null (there is no calibrated basis " +
      "to abstain). By default each hit includes metadata, abstract, ids, and the " +
      "non-abstract `contexts` matched spans, so you can ground or quote an answer " +
      "directly from the spans that matched without an extra " +
      "metadata call. Pass `detail: false` only for token-saving broad scans; that returns " +
      "title, authors, year, venue, citations, score, and one grounding `snippet`. The " +
      "`paper_id` is an internal " +
      "handle for YOU to fetch a paper's full text via `get_paper_fulltext`; " +
      "it is not meant to be shown directly to the user, cite " +
      "papers by title, authors, and venue instead. " +
      "Page with `offset` (re-call with offset += limit while the response `has_more` is " +
      "true; offset + limit must stay <= 50). Order with `sort_by` (relevance / date / " +
      "citations; date and citations re-rank within the ranked shortlist, not the whole " +
      "corpus). Narrow with `year_min` / `year_max` / `venues`.",
    inputSchema: SearchInput,
    externalInputSchema: SearchInputExternal,
    outputSchema: SearchPapersOutput,
    annotations: READ_ONLY_OPEN_NONIDEMPOTENT,
    meta: ALWAYS_LOAD_META,
  },
  {
    name: "search_papers_many",
    requiredScope: "papers:read",
    title: "Search papers (multi-query)",
    description:
      "Use this for a LITERATURE SWEEP or survey: a research question broad enough to need " +
      'several angles, e.g. "what\'s been done on X", a related-work section, or a ' +
      "state-of-the-field summary. Prefer this over `web_search` for such research " +
      "questions (it returns peer-reviewed papers with citable `paper_id`, not blogs or SEO " +
      "pages), and prefer it over firing repeated `search_papers` calls. For a single " +
      "focused question, use `search_papers` instead. " +
      "Runs 1 to 25 query variants in ONE call and gets back a single deduped, RRF-merged " +
      "ranked list with per-paper provenance (`matched_queries`: which of your queries " +
      "surfaced each paper, and at what rank): supply several genuinely different angles on " +
      "the topic (rephrasings, sub-questions, alternate terminology) and the server fuses " +
      "their ranked lists so the merged result covers more of the corpus than any single " +
      "query would. Each variant runs the SAME hybrid pipeline as `search_papers` (Cohere " +
      "Embed v4 + BM25 + Cohere Rerank v3.5). Filters (`conference`, `year`, `year_min`, " +
      "`year_max`, `venues`) are SHARED across all queries. The envelope reports " +
      "`queries_run` and, for any variant whose pipeline failed, `queries_failed` (so one " +
      "bad variant never sinks the batch). `has_more` is always false: the merged shortlist " +
      "is bounded; widen the query set or filters for more coverage. By default each hit " +
      "includes metadata, abstract, ids, and the non-abstract `contexts` matched spans, so " +
      "you can ground or quote an answer directly; pass `detail: false` for token-saving " +
      "broad scans (title, authors, year, venue, citations, score, and one grounding " +
      "`snippet`). `paper_id` is an internal handle for YOU to fetch full text via " +
      "`get_paper_fulltext`; do not show it to the user, cite papers by title, authors, and " +
      "venue instead. Billing: each query variant counts as one search against your quota " +
      "(an 8-query call costs 8), since the server runs a full search pipeline per variant; " +
      "prefer a focused set of genuinely distinct angles over padding the list.",
    inputSchema: SearchManyInput,
    outputSchema: SearchPapersManyOutput,
    annotations: READ_ONLY_OPEN_NONIDEMPOTENT,
    meta: ALWAYS_LOAD_META,
  },
  {
    name: "get_paper_fulltext",
    requiredScope: "papers:read",
    title: "Get paper full text",
    description:
      "Use this when the user asks “what does the methods/results section say”, wants " +
      "to quote a specific section, or when the abstract isn't enough to verify a claim. " +
      "Heavy: only call once a paper looks relevant from `search_papers`, " +
      "`search_related_papers`, or `get_paper_citations`. " +
      "`format=markdown` returns " +
      "one rendered document; `format=json` returns a structured section list. Pass " +
      '`sections` (case-insensitive headings, e.g. ["Methods"]) to fetch only those ' +
      "sections instead of the whole document.",
    inputSchema: FullTextInput,
    externalInputSchema: FullTextInputExternal,
    // No outputSchema: response shape varies by `format` (markdown text vs
    // structured sections). Declaring one would mismatch one of the branches.
    annotations: READ_ONLY_OPEN,
  },
  {
    name: "get_paper_citations",
    requiredScope: "papers:read",
    title: "Get paper citations",
    description:
      "Use this when the user asks “what does this paper build on”, “what built on " +
      "this”, traces influence chains, asks for follow-up work, or wants the lineage of " +
      "an idea. `direction=cited_by` returns indexed papers that cite this one; " +
      "`direction=cites` returns this paper's parsed references (which may or may not be " +
      "in the corpus). Each edge carries `contexts`, the citing sentences with their " +
      "section, which show HOW a work is used (baseline, method borrowed, result " +
      "disputed). Page with `limit` / `offset`; the response reports `total` and " +
      "`has_more` so you can walk a large citation set.",
    inputSchema: CitationsInput,
    outputSchema: GetCitationsOutput,
    annotations: READ_ONLY_OPEN,
  },
  {
    name: "list_conferences",
    title: "List conferences",
    description:
      "Use this when the user asks “what conferences does Lune track”, “is venue X " +
      "covered”, or wants a category-level browse (e.g. AI/ML, security, databases, " +
      "software/systems). Pass `category` as a keyword (`ai`, `security`, ...) to " +
      "narrow; it matches the conference's research area.",
    inputSchema: ListConfsInput,
    outputSchema: ListConferencesOutput,
    annotations: { ...READ_ONLY_OPEN, openWorldHint: false },
  },
  {
    name: "get_conference_papers",
    title: "Get conference papers",
    description:
      "Use this when the user asks for papers from a specific conference (optionally a " +
      "year), e.g. “most-cited NeurIPS 2024 papers”, “show me CCS 2025 accepted papers”, " +
      "or “what's new in security at IEEE S&P this year”. `sort` is `recency` (newest " +
      "first, default) or `citations` (most-cited first); page with `limit` / `offset`.",
    inputSchema: ConfPapersInput,
    outputSchema: GetConferencePapersOutput,
    annotations: READ_ONLY_OPEN,
  },
  {
    name: "search_related_papers",
    requiredScope: "papers:read",
    title: "Search related papers",
    description:
      "Given a paper_id, return the most semantically similar papers by embedding " +
      "distance, NOT by citation links. Use for “more papers like this one” / " +
      "“adjacent work on the same topic”. For papers this one cites or that cite " +
      "it, use `get_paper_citations` instead. Each hit carries metadata, " +
      "abstract, the closest non-abstract matched chunk as `contexts`, and a " +
      "`similarity` score (0..1, higher is nearer). Returns up to `limit` papers; " +
      "an unknown paper_id is an error, an empty list means no neighbors were found.",
    inputSchema: RelatedInput,
    outputSchema: SearchRelatedOutput,
    annotations: READ_ONLY_OPEN,
  },
  {
    name: "extract_from_papers",
    requiredScope: "papers:read",
    title: "Extract structured fields from papers",
    description:
      "Pull a structured table out of up to 50 papers in ONE call: you define the " +
      "columns (`fields`: each a snake_case `name`, a `type`, and an optional " +
      "`description`) and an `instruction`, and the server reads each paper's full " +
      "text and returns one typed row per paper. Use this when you need the SAME " +
      'facts across many papers, e.g. "dataset, model size, and reported accuracy ' +
      'for each of these papers", instead of reading each full text yourself and ' +
      "transcribing by hand. Pass `sections` (case-insensitive headings, e.g. " +
      '["Results"]) to focus extraction and cut noise. The model is instructed to ' +
      "use only what each paper states, not to infer; a field it can't ground may " +
      "be absent or null. Each row carries `truncated` (true when the paper's text " +
      "overflowed the budget and the tail was dropped, so treat it as partial). A " +
      "paper with no parsed full text, or one the model couldn't extract, is " +
      "reported in `papers_failed` (with a `reason`) instead of sinking the batch, " +
      "so `papers_processed` == rows + failures. Heavy: one model call per paper, so " +
      "extract only papers you already judged relevant from a search or citation " +
      "result. For the raw text of a single paper, use get_paper_fulltext instead.",
    inputSchema: ExtractInput,
    externalInputSchema: ExtractInputExternal,
    outputSchema: ExtractOutput,
    annotations: READ_ONLY_OPEN,
  },
  {
    name: "verify_claims",
    requiredScope: "papers:read",
    title: "Verify claims against the corpus",
    description:
      "Fact-check 1 to 25 natural-language claims against Lune's peer-reviewed " +
      "corpus in ONE call. For each claim the server retrieves the most relevant " +
      "passages and an LLM judges the claim ONLY against those passages (never " +
      "outside knowledge), returning one verdict per claim: `supported`, " +
      "`unsupported`, or `insufficient_evidence`. Use this to ground a draft " +
      "before you assert it, to vet a user's claim, or to check your own answer " +
      "against the literature instead of stating things from memory. Every verdict " +
      "carries a `verbatim_quote` copied EXACTLY from a retrieved passage (or null " +
      "when nothing could be quoted, e.g. an insufficient_evidence verdict) plus " +
      "`supporting_paper_ids` (the corpus papers the verdict relied on); both are " +
      "verified server-side, the quote is guaranteed to be a real substring of a " +
      "retrieved passage and the ids are guaranteed to be real retrieved " +
      "candidates, so you can cite the quote directly without re-checking. Also " +
      "returns a `confidence` (0..1) and short `reasoning` per claim. Filters " +
      "(`conference`, `year`, `year_min`, `year_max`, `venues`) scope the evidence " +
      "search and are shared across every claim; `context` is optional shared " +
      "framing for the judge. " +
      "`paper_id`s are fetch handles for get_paper_fulltext, not for showing to " +
      "the user, cite papers by title, authors, and venue.",
    inputSchema: VerifyInput,
    externalInputSchema: VerifyInputExternal,
    outputSchema: VerifyOutput,
    // Omit idempotentHint: retrieval and per-claim LLM judgment can change
    // evidence and verdicts between calls.
    annotations: READ_ONLY_OPEN_NONIDEMPOTENT,
  },
  {
    name: "gather_evidence",
    requiredScope: "papers:read",
    title: "Gather evidence and judge sufficiency",
    description:
      "Use for a multi-part research task when you need to know whether your " +
      "gathered evidence is SUFFICIENT, what is still MISSING, and what to " +
      "search next, without the tool writing the answer. Pass the goal in `task` " +
      "and your first search angles in `queries`; the server runs one corpus " +
      "search per angle, decomposes the task into evidence requirements (or use " +
      "your own via `requirements`), and returns each requirement as covered / " +
      "partial / missing with the exact `evidence_spans` (verbatim quotes) that " +
      "support it, plus `next_queries` for the gaps. Default `max_iterations=1` " +
      "is a one-shot assessment billed len(queries); set `max_iterations>1` AND " +
      "`max_total_queries>len(queries)` to authorize bounded server-side " +
      "follow-up searches (billed `max_total_queries`, capped at 25). Optionally " +
      "pass a `draft` to get per-sentence support checks against the gathered " +
      "spans. Every covered requirement and supported draft sentence carries a " +
      "verbatim quote verified server-side, so you can cite it directly. You " +
      "write the answer; cite papers by title, authors, and venue, not by paper_id.",
    inputSchema: GatherEvidenceInput,
    externalInputSchema: GatherEvidenceInputExternal,
    outputSchema: GatherEvidenceOutput,
    annotations: READ_ONLY_OPEN_NONIDEMPOTENT,
  },
];

// Filters and conference resolution

/**
 * Fetch the conferences list (cached on the API side for 10 min and
 * cached again on this side via `cachedJson`) and use it to canonicalise
 * a user-supplied conference identifier.
 *
 *   • Exact / unique fuzzy match → return the canonical `short_name`.
 *   • Ambiguous → throw `LuneErrorCode.InvalidParams` with the candidate
 *     list so the agent can retry with a more specific input.
 *   • No match / endpoint unreachable → return the raw input unchanged
 *     and let the downstream call's 404 surface as the agent's signal.
 */
async function resolveConferenceArg(
  api: KyInstance,
  raw: string,
): Promise<string> {
  let list: ConferenceCandidate[] | null = null;

  try {
    const r = await cachedJson<ConferenceCandidate[]>(
      api,
      "get",
      "conferences",
      { defaultTtlMs: TTL_CONFERENCES },
    );

    if (Array.isArray(r)) list = r;
  } catch {
    // Unreachable conferences endpoint shouldn't break the tool; fall
    // through and let the downstream call surface its own error.
  }

  if (!list) return raw;

  const result = resolveConferenceShortName(raw, list);

  switch (result.kind) {
    case "match":
      return result.short_name;
    case "ambiguous":
      throw new ProtocolError(
        LuneErrorCode.InvalidParams,
        `Conference "${raw}" is ambiguous, matches: ${result.candidates.join(
          ", ",
        )}. Retry with a more specific name.`,
        { input: raw, candidates: result.candidates },
      );
    case "none":
      return raw;
  }
}

/**
 * Resolve the shared corpus filters (conference, year, year_min, year_max,
 * venues) onto a request `body`. The conference filter's body key differs by
 * route: single search writes `conference_short_name`, the batch / verify /
 * gather routes write `conference`. Conference and each venue are canonicalised
 * through the fuzzy resolver so a near-miss short name reaches the API as the
 * value it expects.
 */
/**
 * The corpus filter fields `applySharedFilters` may set. Every consuming route is
 * `extra="forbid"` server-side, so this field set is a wire contract rather than a
 * convenience: a name the route does not declare 422s the whole request. Both
 * `conference` and `conference_short_name` appear because single search renames it
 * and the batch, verify and gather routes do not; the caller picks via `conferenceKey`.
 */
type SharedFilterTarget = {
  conference?: string | undefined;
  conference_short_name?: string | undefined;
  year?: number | undefined;
  year_min?: number | undefined;
  year_max?: number | undefined;
  venues?: string[] | undefined;
};

/**
 * Request bodies for the corpus routes. Each API route is `extra="forbid"`, so the
 * field set below is the wire contract: adding a name the route does not declare
 * turns every call into a 422, and no test in this repo posts to a real API. They are
 * `type` rather than `interface` on purpose, because only a type alias carries the
 * implicit index signature that makes it assignable to the JSON body contract.
 *
 * Fields that zod fills from a `.default()` stay optional here: absent and present
 * are equivalent on the wire, since the API applies the same defaults.
 */
type SearchRequestBody = {
  query: string;
  limit?: number | undefined;
  offset?: number | undefined;
  sort_by?: string | undefined;
  conference?: string | undefined;
  conference_short_name?: string | undefined;
  year?: number | undefined;
  year_min?: number | undefined;
  year_max?: number | undefined;
  venues?: string[] | undefined;
};

type SearchManyRequestBody = {
  queries: string[];
  limit?: number | undefined;
  conference?: string | undefined;
  conference_short_name?: string | undefined;
  year?: number | undefined;
  year_min?: number | undefined;
  year_max?: number | undefined;
  venues?: string[] | undefined;
};

type ExtractRequestBody = {
  paper_ids: string[];
  fields: { name: string; type: string; description?: string | undefined }[];
  instruction?: string | undefined;
  source: string;
  sections?: string[] | undefined;
};

type VerifyRequestBody = {
  claims: string[];
  source: string;
  context?: string | undefined;
  conference?: string | undefined;
  conference_short_name?: string | undefined;
  year?: number | undefined;
  year_min?: number | undefined;
  year_max?: number | undefined;
  venues?: string[] | undefined;
};

type GatherEvidenceRequestBody = {
  task: string;
  queries: string[];
  source: string;
  requirements?: { key: string; description: string }[] | undefined;
  draft?: string | undefined;
  max_iterations?: number | undefined;
  max_total_queries?: number | undefined;
  conference?: string | undefined;
  conference_short_name?: string | undefined;
  year?: number | undefined;
  year_min?: number | undefined;
  year_max?: number | undefined;
  venues?: string[] | undefined;
};

type WorkspaceDocumentRequestBody = {
  document_id: string;
  format: string;
  sections?: string[] | undefined;
};

/**
 * A response body that carries either a rendered document or its sections. The
 * fields are `JsonValue` because nothing has validated the upstream payload yet.
 */
type DocumentResponse = {
  body?: JsonValue;
  sections?: JsonValue;
  title?: JsonValue;
};

/**
 * `URLSearchParams` stringifies an `undefined` value to the literal "undefined",
 * which reaches FastAPI as a real argument and 422s. Omit the key instead.
 */
function setIfPresent(
  params: URLSearchParams,
  key: string,
  value: string | number | undefined,
): void {
  if (value !== undefined) params.set(key, String(value));
}

function citationParams(a: {
  direction?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}): URLSearchParams {
  const params = new URLSearchParams();
  setIfPresent(params, "direction", a.direction);
  setIfPresent(params, "limit", a.limit);
  setIfPresent(params, "offset", a.offset);

  return params;
}

async function applySharedFilters(
  api: KyInstance,
  body: SharedFilterTarget,
  filters: SharedFilterTarget,
  conferenceKey: "conference" | "conference_short_name",
): Promise<void> {
  if (filters.conference) {
    body[conferenceKey] = await resolveConferenceArg(api, filters.conference);
  }

  if (filters.year) body.year = filters.year;

  if (filters.year_min !== undefined) body.year_min = filters.year_min;

  if (filters.year_max !== undefined) body.year_max = filters.year_max;

  if (filters.venues && filters.venues.length > 0) {
    body.venues = await Promise.all(
      filters.venues.map((v) => resolveConferenceArg(api, v)),
    );
  }
}

// Per-tool handlers

type SearchArgs = ReturnType<typeof SearchInput.parse>;

type FullTextArgs = ReturnType<typeof FullTextInput.parse>;

/**
 * search_papers with source="workspace": the API runs the same HyDE + rerank
 * pipeline over the user's documents, returning flat reranked spans; group them
 * into corpus-shaped doc hits so the agent reads the result identically to a
 * corpus search. Corpus-only filters (conference/year/venues/sort_by/offset/
 * detail) do not apply. `workspaces/search` is per-active-workspace
 * (PER_PRINCIPAL_PATHS), so cachedJson bypasses the shared cache. The active
 * workspace is bound to the credential server-side.
 */
async function workspaceSearch(
  api: KyInstance,
  a: SearchArgs,
): Promise<ToolCallResult> {
  const wr = await cachedJson(api, "post", "workspaces/search", {
    json:
      a.limit === undefined
        ? { query: a.query }
        : { query: a.query, limit: a.limit },
  });

  return structuredJson(slimWorkspaceSearchAsHits(wr));
}

async function handleSearchPapers(
  api: KyInstance,
  args: JsonValue,
): Promise<ToolCallResult> {
  const a = SearchInput.parse(args);

  if (a.source === "workspace") return workspaceSearch(api, a);
  // Enriched by default; `detail: false` opts down to the concise shape.
  const detail = a.detail ?? true;

  // Body field is `conference_short_name`; the agent sees `conference`. zod
  // materialises the nested `.default()`, so these optional fields are set.
  const body: SearchRequestBody = {
    query: a.query,
    limit: a.limit,
    offset: a.offset,
    sort_by: a.sort_by,
  };

  await applySharedFilters(api, body, a, "conference_short_name");

  // `detail` is an MCP-boundary projection knob, not an API field: the
  // response already carries matched_chunks, and SearchRequest is extra=forbid.
  const r = await cachedJson(api, "post", "search", {
    json: body,
    defaultTtlMs: TTL_SEARCH,
  });

  return structuredJson(slimSearchResponse(r, detail));
}

async function handleSearchPapersMany(
  api: KyInstance,
  args: JsonValue,
): Promise<ToolCallResult> {
  const a = SearchManyInput.parse(args);
  // Enriched by default; `detail: false` opts down to the concise shape.
  const detail = a.detail ?? true;

  // The batch body field is literally `conference` (server-side,
  // `conference_short_name` is derived), so no rename here, unlike search.
  const body: SearchManyRequestBody = {
    queries: a.queries,
    limit: a.limit,
  };

  await applySharedFilters(api, body, a, "conference");

  // `detail` is an MCP-boundary projection knob, not an API field: the
  // batch response carries matched_chunks, and the body is extra=forbid too.
  const r = await cachedJson(api, "post", "search/batch", {
    json: body,
    defaultTtlMs: TTL_SEARCH,
    timeout: HEAVY_TOOL_TIMEOUT_MS,
  });

  return structuredJson(slimSearchManyResponse(r, detail));
}

/**
 * get_paper_fulltext with source="workspace": read one of the user's uploaded
 * documents by its workspace document id. The active workspace is bound to the
 * credential server-side and the API re-checks the document belongs to it.
 * `workspaces/document` is per-active-workspace (PER_PRINCIPAL_PATHS), so
 * cachedJson bypasses the shared cache. Same markdown/json contract as the
 * corpus full text.
 */
async function workspaceDocument(
  api: KyInstance,
  a: FullTextArgs,
): Promise<ToolCallResult> {
  const wbody: WorkspaceDocumentRequestBody = {
    document_id: a.paper_id,
    format: a.format ?? "markdown",
  };

  if (a.sections && a.sections.length > 0) wbody.sections = a.sections;

  const wr = await cachedJson<DocumentResponse>(
    api,
    "post",
    "workspaces/document",
    {
      json: wbody,
    },
  );

  if ((a.format ?? "markdown") === "markdown" && isJsonString(wr.body)) {
    return plainText(wr.body);
  }

  return structuredJson(wr);
}

async function handleFullText(
  api: KyInstance,
  args: JsonValue,
): Promise<ToolCallResult> {
  const a = FullTextInput.parse(args);

  if (a.source === "workspace") return workspaceDocument(api, a);
  // Pairs, not an object: Ky CSV-joins an array value, and FastAPI's
  // `list[str]` would then receive one comma-joined string, not a list.
  const sp = new URLSearchParams();

  if (a.format !== undefined) sp.set("format", a.format);

  for (const s of a.sections ?? []) sp.append("sections", s);

  const r = await cachedJson<DocumentResponse>(
    api,
    "get",
    `papers/${encodeURIComponent(a.paper_id)}/fulltext`,
    {
      searchParams: sp,
      defaultTtlMs: TTL_FULLTEXT,
    },
  );

  // Markdown response carries a `body` field; JSON form carries `sections`.
  if (a.format === "markdown" && isJsonString(r.body)) return plainText(r.body);

  return structuredJson(r);
}

async function handleCitations(
  api: KyInstance,
  args: JsonValue,
): Promise<ToolCallResult> {
  const a = CitationsInput.parse(args);

  // `limit` / `offset` carry zod `.default()`s, so they are defined at
  // runtime; the assertions narrow the `.optional()` `| undefined`.
  const r = await cachedJson(
    api,
    "get",
    `papers/${encodeURIComponent(a.paper_id)}/citations`,
    {
      searchParams: citationParams(a),
      defaultTtlMs: TTL_CITATIONS,
    },
  );

  return structuredJson(slimCitations(r));
}

async function handleListConferences(
  api: KyInstance,
  args: JsonValue,
): Promise<ToolCallResult> {
  const a = ListConfsInput.parse(args);
  const sp: Record<string, string> = {};

  if (a.category) sp.category = a.category;

  const r = await cachedJson(api, "get", "conferences", {
    searchParams: sp,
    defaultTtlMs: TTL_CONFERENCES,
  });

  return structuredJson(slimConferenceList(r));
}

async function handleConferencePapers(
  api: KyInstance,
  args: JsonValue,
): Promise<ToolCallResult> {
  const a = ConfPapersInput.parse(args);
  const conference = await resolveConferenceArg(api, a.conference);
  const sp = new URLSearchParams();
  setIfPresent(sp, "limit", a.limit);
  setIfPresent(sp, "offset", a.offset);
  setIfPresent(sp, "sort", a.sort);
  setIfPresent(sp, "year", a.year);

  const r = await cachedJson(
    api,
    "get",
    `conferences/${encodeURIComponent(conference)}/papers`,
    {
      searchParams: sp,
      defaultTtlMs: TTL_CONFERENCE_PAPERS,
    },
  );

  return structuredJson(slimConferencePapers(r, a.offset ?? 0));
}

async function handleRelated(
  api: KyInstance,
  args: JsonValue,
): Promise<ToolCallResult> {
  const a = RelatedInput.parse(args);
  const sp = new URLSearchParams();
  setIfPresent(sp, "limit", a.limit);

  const r = await cachedJson(
    api,
    "get",
    `papers/${encodeURIComponent(a.paper_id)}/related`,
    { searchParams: sp, defaultTtlMs: TTL_PAPER },
  );

  return structuredJson(slimRelated(r));
}

async function handleExtract(
  api: KyInstance,
  args: JsonValue,
): Promise<ToolCallResult> {
  const a = ExtractInput.parse(args);

  // Fields map 1:1 onto the API's ExtractRequest and the rows are already
  // compact, so no projection. `papers/extract` is on PER_PRINCIPAL_PATHS.
  const body: ExtractRequestBody = {
    paper_ids: a.paper_ids,
    fields: a.fields,
    instruction: a.instruction,
    source: a.source ?? "corpus",
  };

  if (a.sections && a.sections.length > 0) body.sections = a.sections;

  const r = await cachedJson(api, "post", "papers/extract", {
    json: body,
    defaultTtlMs: 0,
    timeout: HEAVY_TOOL_TIMEOUT_MS,
  });

  return structuredJson(r);
}

async function handleVerify(
  api: KyInstance,
  args: JsonValue,
): Promise<ToolCallResult> {
  const a = VerifyInput.parse(args);

  // Fields map 1:1 onto VerifyRequest; `conference` is a real body field
  // there, but still fuzzy-resolved so a near-miss short name reaches the API.
  const body: VerifyRequestBody = {
    claims: a.claims,
    source: a.source ?? "corpus",
  };

  if (a.context) body.context = a.context;

  // Corpus filters do not apply to source="workspace" (the API ignores
  // them), so skipping keeps an unknown venue from 422-ing a workspace verify.
  if (a.source !== "workspace") {
    await applySharedFilters(api, body, a, "conference");
  }

  const r = await cachedJson(api, "post", "claims/verify", {
    json: body,
    defaultTtlMs: 0,
    timeout: HEAVY_TOOL_TIMEOUT_MS,
  });

  return structuredJson(r);
}

async function handleGatherEvidence(
  api: KyInstance,
  args: JsonValue,
): Promise<ToolCallResult> {
  const a = GatherEvidenceInput.parse(args);

  // `conference` is a real body field here (like search_papers_many), still
  // fuzzy-resolved. evidence/gather is per-principal, so ttl 0 re-runs it.
  const body: GatherEvidenceRequestBody = {
    task: a.task,
    queries: a.queries,
    source: a.source ?? "corpus",
  };

  if (a.requirements) body.requirements = a.requirements;

  if (a.draft) body.draft = a.draft;
  body.max_iterations = a.max_iterations;

  if (a.max_total_queries !== undefined)
    body.max_total_queries = a.max_total_queries;

  // Corpus filters do not apply to source="workspace" (API ignores them).
  if (a.source !== "workspace") {
    await applySharedFilters(api, body, a, "conference");
  }

  const r = await cachedJson(api, "post", "evidence/gather", {
    json: body,
    defaultTtlMs: 0,
    timeout: HEAVY_TOOL_TIMEOUT_MS,
  });

  return structuredJson(r);
}

// Dispatcher

export async function callPaperTool(
  api: KyInstance,
  name: string,
  args: JsonValue,
): Promise<ToolCallResult> {
  try {
    switch (name) {
      case "search_papers":
        return await handleSearchPapers(api, args);
      case "search_papers_many":
        return await handleSearchPapersMany(api, args);
      case "get_paper_fulltext":
        return await handleFullText(api, args);
      case "get_paper_citations":
        return await handleCitations(api, args);
      case "list_conferences":
        return await handleListConferences(api, args);
      case "get_conference_papers":
        return await handleConferencePapers(api, args);
      case "search_related_papers":
        return await handleRelated(api, args);
      case "extract_from_papers":
        return await handleExtract(api, args);
      case "verify_claims":
        return await handleVerify(api, args);
      case "gather_evidence":
        return await handleGatherEvidence(api, args);
      default:
        throw new Error(`unknown paper tool: ${name}`);
    }
  } catch (e) {
    // Upstream API failures (401/402/403/404/429/5xx) resolve to an
    // `{ isError: true }` tool result; the rest re-throw as protocol errors.
    return await httpErrorToToolResult(e, name);
  }
}
