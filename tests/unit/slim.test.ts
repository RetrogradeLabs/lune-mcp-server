/**
 * Unit coverage for the response projectors in `src/tools/_slim.ts`.
 *
 * These are pure functions on the MCP boundary that strip low-signal noise
 * from API responses. Each test pins both the populated and the
 * absent-field paths so the `?? default` and `|| undefined` fallbacks are
 * all exercised.
 */
import { describe, expect, it } from "vitest";
import {
  slimCitations,
  slimConference,
  slimConferenceList,
  slimConferencePapers,
  slimDrainResponse,
  slimGuidanceDoc,
  slimGuidanceSearch,
  slimPaper,
  slimRelated,
  slimSearchResponse,
  slimSubscription,
  slimSubscriptionList,
} from "../../src/tools/_slim.js";

describe("slimConference", () => {
  it("passes through populated fields", () => {
    expect(
      slimConference({
        id: "c1",
        short_name: "NeurIPS",
        full_name: "Neural Information Processing Systems",
        description: "the big one",
        category: "ml",
        paper_count: 42,
        years: [2023, 2024],
      }),
    ).toEqual({
      id: "c1",
      short_name: "NeurIPS",
      full_name: "Neural Information Processing Systems",
      description: "the big one",
      category: "ml",
      paper_count: 42,
      years: [2023, 2024],
    });
  });

  it("defaults missing description / category / counts", () => {
    expect(
      slimConference({ id: "c2", short_name: "CCS", full_name: "ACM CCS" }),
    ).toEqual({
      id: "c2",
      short_name: "CCS",
      full_name: "ACM CCS",
      description: undefined,
      category: undefined,
      paper_count: 0,
      years: [],
    });
  });

  it("coerces an empty-string description and null category to undefined", () => {
    const r = slimConference({
      id: "c3",
      short_name: "X",
      full_name: "X full",
      description: "",
      category: null,
    });
    expect(r.description).toBeUndefined();
    expect(r.category).toBeUndefined();
  });
});

describe("slimConferenceList", () => {
  it("maps an array and drops falsy entries", () => {
    const r = slimConferenceList([
      { id: "c1", short_name: "A", full_name: "A full" },
      null,
      undefined,
    ]);
    expect(r.conferences).toHaveLength(1);
    expect(r.conferences[0]!.short_name).toBe("A");
  });

  it("returns an empty list for a non-array input", () => {
    expect(slimConferenceList("not an array")).toEqual({ conferences: [] });
    expect(slimConferenceList(undefined)).toEqual({ conferences: [] });
  });
});

describe("slimPaper", () => {
  it("renames id → paper_id and fills stable defaults", () => {
    expect(slimPaper({ id: "p1", title: "Foo" })).toEqual({
      paper_id: "p1",
      title: "Foo",
      authors: [],
      year: undefined,
      doi: undefined,
      arxiv_id: undefined,
      abstract: undefined,
      pdf_cdn_url: undefined,
      url: undefined,
      citation_count: 0,
      conference: undefined,
    });
  });

  it("prefers an explicit paper_id over id", () => {
    expect(slimPaper({ paper_id: "explicit", id: "fallback" }).paper_id).toBe(
      "explicit",
    );
  });

  it("keeps a string conference verbatim", () => {
    expect(slimPaper({ id: "p", conference: "ICLR" }).conference).toBe("ICLR");
  });

  it("projects a nested conference object down to its short_name", () => {
    expect(
      slimPaper({ id: "p", conference: { short_name: "CVPR" } }).conference,
    ).toBe("CVPR");
  });

  it("coerces null conference / empty abstract to undefined", () => {
    const r = slimPaper({ id: "p", conference: null, abstract: "" });
    expect(r.conference).toBeUndefined();
    expect(r.abstract).toBeUndefined();
  });

  it("passes through populated optional metadata", () => {
    const r = slimPaper({
      id: "p",
      title: "T",
      authors: ["A", "B"],
      year: 2024,
      doi: "10.1/x",
      arxiv_id: "2401.0001",
      abstract: "abs",
      pdf_cdn_url: "https://cdn/p.pdf",
      url: "https://lune/p",
      citation_count: 9,
    });
    expect(r).toMatchObject({
      authors: ["A", "B"],
      year: 2024,
      doi: "10.1/x",
      arxiv_id: "2401.0001",
      abstract: "abs",
      pdf_cdn_url: "https://cdn/p.pdf",
      url: "https://lune/p",
      citation_count: 9,
    });
  });
});

describe("slimSearchResponse", () => {
  it("maps the results array", () => {
    const r = slimSearchResponse({ results: [{ id: "p1" }, { id: "p2" }] });
    expect(r.results.map((p) => p.paper_id)).toEqual(["p1", "p2"]);
  });

  it("returns an empty results array when results is missing or non-array", () => {
    expect(slimSearchResponse({}).results).toEqual([]);
    expect(slimSearchResponse({ results: "bad" }).results).toEqual([]);
    expect(slimSearchResponse(undefined).results).toEqual([]);
  });

  it("surfaces non-abstract matched_chunks as contexts by default", () => {
    const r = slimSearchResponse({
      results: [
        { id: "p1", matched_chunks: [{ section_name: "Methods", text: "x", score: 1 }] },
      ],
    });
    const hit = r.results[0]! as { contexts: Array<Record<string, unknown>> };
    expect(hit.contexts).toEqual([{ section: "Methods", text: "x", score: 1 }]);
  });

  it("filters abstract chunks from contexts because abstract is its own field", () => {
    const r = slimSearchResponse({
      results: [
        {
          id: "p1",
          abstract: "the abstract text",
          matched_chunks: [
            { section_name: "Abstract", text: "the abstract text", score: 0.9 },
            { section_name: "Results", text: "we observe", score: 0.8 },
          ],
        },
      ],
    });
    const hit = r.results[0]! as { abstract: string; contexts: Array<Record<string, unknown>> };
    expect(hit.abstract).toBe("the abstract text");
    expect(hit.contexts).toEqual([
      { section: "Results", text: "we observe", score: 0.8 },
    ]);
  });

  it("surfaces matched_chunks as contexts when detail is true", () => {
    const r = slimSearchResponse(
      {
        results: [
          {
            id: "p1",
            matched_chunks: [
              { section_name: "Results", text: "we observe", score: 0.8 },
              { section_name: null, text: "", score: null }, // empty text dropped
              { text: "no section, no score" }, // section/score optional
            ],
          },
        ],
      },
      true,
    );
    const hit = r.results[0]! as { contexts: Array<Record<string, unknown>> };
    expect(hit.contexts).toEqual([
      { section: "Results", text: "we observe", score: 0.8 },
      { section: undefined, text: "no section, no score", score: undefined },
    ]);
  });

  it("emits an empty contexts array when a hit has no matched_chunks", () => {
    const r = slimSearchResponse({ results: [{ id: "p1" }] });
    const hit = r.results[0]! as { contexts: unknown[] };
    expect(hit.contexts).toEqual([]);
  });

  it("surfaces the per-hit score/rerank_score and derives best_score + low_confidence from rerank_score", () => {
    const r = slimSearchResponse({
      results: [
        { id: "p1", score: 1.1, rerank_score: 0.82 },
        { id: "p2", score: 0.5, rerank_score: 0.41 },
      ],
    });
    // The boosted ranking score and the calibrated rerank score are both surfaced.
    expect(r.results[0]!.score).toBe(1.1);
    expect(r.results[0]!.rerank_score).toBe(0.82);
    // best_score / low_confidence key on rerank_score (the calibrated value).
    expect(r.best_score).toBe(0.82);
    // 0.82 is a strong top rerank score, so not low-confidence.
    expect(r.low_confidence).toBe(false);
  });

  it("flags low_confidence when the best rerank_score is below the floor", () => {
    const r = slimSearchResponse({ results: [{ id: "p1", score: 0.4, rerank_score: 0.18 }] });
    expect(r.best_score).toBe(0.18);
    expect(r.low_confidence).toBe(true);
  });

  it("does not abstain when a hit has only a boosted score and no rerank_score", () => {
    // Keyword / BM25-dominated path: the reranker was skipped, so there is no
    // calibrated basis to abstain even though the boosted score is present.
    const r = slimSearchResponse({ results: [{ id: "p1", score: 1.5 }] });
    expect(r.results[0]!.score).toBe(1.5);
    expect(r.best_score).toBeNull();
    expect(r.low_confidence).toBe(false);
  });

  it("reports null best_score and low_confidence false for an empty result set", () => {
    // No hits => no calibrated rerank score => no basis to abstain.
    const r = slimSearchResponse({ results: [] });
    expect(r.best_score).toBeNull();
    expect(r.low_confidence).toBe(false);
  });

  it("carries has_more from the response and defaults it to false when absent", () => {
    expect(slimSearchResponse({ results: [], has_more: true }).has_more).toBe(true);
    expect(slimSearchResponse({ results: [] }).has_more).toBe(false);
  });
});

describe("slimSearchResponse concise vs detail", () => {
  const hit = {
    id: "p1",
    title: "Paper",
    authors: ["A", "B", "C", "D", "E", "F", "G"],
    year: 2024,
    conference: { short_name: "NeurIPS" },
    abstract: "x".repeat(600),
    doi: "10.1/x",
    arxiv_id: "2401.1",
    pdf_cdn_url: "https://cdn/x.pdf",
    citation_count: 5,
    score: 0.7,
    matched_chunks: [
      {
        section_name: "Results",
        text: "we observe a 3 point gain",
        score: 0.7,
        chunk_id: "ch-1",
      },
    ],
  };

  it("default detail returns the abstract, ids, and contexts with chunk_id", () => {
    const r = slimSearchResponse({ results: [hit] });
    const h = r.results[0]! as Record<string, unknown>;
    expect(h.abstract).toHaveLength(600);
    expect(h.doi).toBe("10.1/x");
    const ctx = (h.contexts as Array<Record<string, unknown>>)[0]!;
    expect(ctx).toMatchObject({
      section: "Results",
      text: "we observe a 3 point gain",
      chunk_id: "ch-1",
    });
  });

  it("detail false returns a snippet, trims authors, and omits heavy fields", () => {
    const r = slimSearchResponse({ results: [hit] }, false);
    const h = r.results[0]! as Record<string, unknown>;
    expect(h.snippet).toBe("we observe a 3 point gain");
    expect(h.authors).toHaveLength(6);
    expect(h.et_al_count).toBe(1);
    expect("abstract" in h).toBe(false);
    expect("contexts" in h).toBe(false);
    expect("doi" in h).toBe(false);
  });

  it("detail mode filters an abstract matched chunk from contexts", () => {
    const abstractHit = {
      ...hit,
      matched_chunks: [
        {
          section_name: "Abstract",
          text: "abstract duplicate",
          score: 0.9,
          chunk_id: "abs-1",
        },
      ],
    };
    const r = slimSearchResponse({ results: [abstractHit] }, true);
    const h = r.results[0]! as Record<string, unknown>;
    expect(h.abstract).toHaveLength(600);
    expect(h.contexts).toEqual([]);
  });

  it("concise snippet falls back to a truncated abstract when no chunk matched", () => {
    const noChunk = { ...hit, matched_chunks: [] };
    const r = slimSearchResponse({ results: [noChunk] }, false);
    const h = r.results[0]! as Record<string, unknown>;
    expect((h.snippet as string).length).toBeLessThanOrEqual(283); // 280 + ellipsis
    expect((h.snippet as string).endsWith("...")).toBe(true);
  });
});

describe("slimCitations", () => {
  it("reads response.papers and maps CitedPaper edges (the H1 fix)", () => {
    const raw = {
      paper_id: "seed-1",
      direction: "cited_by",
      papers: [
        {
          id: "c1",
          title: "In-corpus Citing Paper",
          authors: ["X. Author"],
          year: 2024,
          doi: "10.1/abc",
          citation_count: 7,
        },
        {
          id: null,
          title: "Parsed-only Reference",
          authors: ["Y. Author"],
          year: 2019,
          venue: "Some Workshop",
        },
      ],
    };
    const out = slimCitations(raw);
    expect(out.direction).toBe("cited_by");
    expect(out.citations).toHaveLength(2);
    // Resolved edge: paper_id present, in_corpus true, fields carried.
    expect(out.citations[0]).toMatchObject({
      paper_id: "c1",
      in_corpus: true,
      title: "In-corpus Citing Paper",
      citation_count: 7,
    });
    // Parsed-only edge: no paper_id, in_corpus false, venue carried.
    expect(out.citations[1]!.paper_id).toBeUndefined();
    expect(out.citations[1]!.in_corpus).toBe(false);
    expect(out.citations[1]!.venue).toBe("Some Workshop");
  });

  it("returns an empty list (never throws) for an empty or malformed response", () => {
    expect(slimCitations({ papers: [] }).citations).toEqual([]);
    expect(slimCitations(undefined).citations).toEqual([]);
    expect(slimCitations({}).citations).toEqual([]);
  });

  it("carries total and has_more when present, leaves them undefined when absent", () => {
    const withPaging = slimCitations({
      direction: "cited_by",
      papers: [],
      total: 12,
      has_more: true,
    });
    expect(withPaging.total).toBe(12);
    expect(withPaging.has_more).toBe(true);
    const without = slimCitations({ direction: "cites", papers: [] });
    expect(without.total).toBeUndefined();
    expect(without.has_more).toBeUndefined();
  });
});

describe("slimRelated", () => {
  it("wraps a bare papers array into a named field", () => {
    const out = slimRelated([{ id: "n1" }, { id: "n2" }]);
    expect(out.papers.map((p) => p.paper_id)).toEqual(["n1", "n2"]);
  });

  it("carries similarity, abstract, venue, and non-abstract contexts", () => {
    const out = slimRelated([
      {
        paper_id: "n1",
        title: "Neighbor",
        abstract: "Related abstract",
        conference: { id: "c", short_name: "ICML", full_name: "ICML" },
        matched_chunks: [
          { section_name: "Abstract", text: "Related abstract", score: 0.9 },
          { section_name: "Methods", text: "Matched method span", score: 0.8 },
        ],
        similarity: 0.87,
      },
    ]);
    const hit = out.papers[0]!;
    expect(hit.similarity).toBe(0.87);
    expect(hit.conference).toBe("ICML");
    expect(hit.abstract).toBe("Related abstract");
    expect(hit.contexts).toEqual([
      { section: "Methods", text: "Matched method span", score: 0.8, chunk_id: undefined },
    ]);
  });

  it("returns an empty papers array for a non-array input", () => {
    expect(slimRelated(undefined)).toEqual({ papers: [] });
    expect(slimRelated({ not: "an array" })).toEqual({ papers: [] });
  });
});

describe("slimConferencePapers", () => {
  it("maps papers and reports total + has_more", () => {
    const r = slimConferencePapers({
      papers: [{ id: "p1" }],
      total: 100,
      page: 2,
      limit: 20,
    });
    expect(r.papers[0]!.paper_id).toBe("p1");
    // page 2 of 20 covers 40 < 100, so more remain.
    expect(r).toMatchObject({ total: 100, has_more: true });
  });

  it("defaults papers to an empty array when absent", () => {
    expect(slimConferencePapers({}).papers).toEqual([]);
    expect(slimConferencePapers(undefined).papers).toEqual([]);
  });
});

describe("slimSubscription", () => {
  it("projects the three subscription fields", () => {
    expect(
      slimSubscription({ id: "s1", conference_id: "c1", created_at: "2026-01-01" }),
    ).toEqual({ id: "s1", conference_id: "c1", created_at: "2026-01-01" });
  });
});

describe("slimSubscriptionList", () => {
  it("maps an array and drops falsy entries", () => {
    const r = slimSubscriptionList([{ id: "s1" }, null]);
    expect(r.subscriptions).toHaveLength(1);
  });

  it("returns an empty list for a non-array input", () => {
    expect(slimSubscriptionList({})).toEqual({ subscriptions: [] });
  });
});

describe("slimDrainResponse", () => {
  it("maps drain papers with their occurred_at timestamp", () => {
    const r = slimDrainResponse({
      papers: [{ id: "p1", occurred_at: "2026-02-02" }],
      next_cursor: "cur-2",
    });
    expect(r.papers[0]).toMatchObject({
      paper_id: "p1",
      occurred_at: "2026-02-02",
    });
    expect(r.next_cursor).toBe("cur-2");
  });

  it("defaults papers to [] and next_cursor to null", () => {
    expect(slimDrainResponse({})).toEqual({ papers: [], next_cursor: null });
    expect(slimDrainResponse(undefined)).toEqual({
      papers: [],
      next_cursor: null,
    });
  });

  it("coerces a null next_cursor to null", () => {
    expect(slimDrainResponse({ next_cursor: null }).next_cursor).toBeNull();
  });
});

describe("slimGuidanceSearch", () => {
  it("renames API fields to the agent-facing shape", () => {
    const r = slimGuidanceSearch({
      results: [
        {
          doc_id: "d1",
          doc_title: "Title",
          doc_source_url: "https://src",
          section_name: "Methods",
          content: "an excerpt",
        },
      ],
    });
    expect(r.results[0]).toEqual({
      doc_id: "d1",
      doc_title: "Title",
      source_url: "https://src",
      section: "Methods",
      excerpt: "an excerpt",
    });
  });

  it("coerces a null source_url to undefined and defaults missing results", () => {
    const r = slimGuidanceSearch({
      results: [{ doc_id: "d1", doc_source_url: null }],
    });
    expect(r.results[0]!.source_url).toBeUndefined();
    expect(slimGuidanceSearch({}).results).toEqual([]);
    expect(slimGuidanceSearch(undefined).results).toEqual([]);
  });
});

describe("slimGuidanceDoc", () => {
  it("renames id → doc_id, passes through metadata, and carries full text", () => {
    expect(
      slimGuidanceDoc({
        id: "d1",
        title: "Doc",
        author_name: "Researcher",
        author_affiliation: "Lab",
        source_url: "https://src",
        tags: ["repro"],
        content: "## Intro\n\nbody text",
        sections: [{ heading: "Intro", text: "body text" }],
      }),
    ).toEqual({
      doc_id: "d1",
      title: "Doc",
      author: "Researcher",
      author_affiliation: "Lab",
      source_url: "https://src",
      tags: ["repro"],
      content: "## Intro\n\nbody text",
      sections: [{ heading: "Intro", text: "body text" }],
    });
  });

  it("coerces null author / affiliation / source_url and defaults tags", () => {
    const r = slimGuidanceDoc({
      id: "d2",
      title: "Doc2",
      author_name: null,
      author_affiliation: null,
      source_url: null,
      tags: null,
    });
    expect(r.author).toBeUndefined();
    expect(r.author_affiliation).toBeUndefined();
    expect(r.source_url).toBeUndefined();
    expect(r.tags).toEqual([]);
    expect(slimGuidanceDoc(undefined).tags).toEqual([]);
  });

  it("omits content when absent and drops empty/whitespace-only sections", () => {
    const r = slimGuidanceDoc({
      id: "d3",
      title: "Doc3",
      sections: [
        { heading: "Keep", text: "real" },
        { heading: "Drop", text: "" },
      ],
    });
    expect(r.content).toBeUndefined();
    expect(r.sections).toEqual([{ heading: "Keep", text: "real" }]);
  });
});
