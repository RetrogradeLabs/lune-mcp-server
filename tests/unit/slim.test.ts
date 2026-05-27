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
  slimPaperDetail,
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

  it("drops matched_chunks by default (includeContexts unset)", () => {
    const r = slimSearchResponse({
      results: [
        { id: "p1", matched_chunks: [{ section_name: "Methods", text: "x", score: 1 }] },
      ],
    });
    expect("contexts" in r.results[0]!).toBe(false);
  });

  it("surfaces matched_chunks as contexts when includeContexts is true", () => {
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
    const r = slimSearchResponse({ results: [{ id: "p1" }] }, true);
    const hit = r.results[0]! as { contexts: unknown[] };
    expect(hit.contexts).toEqual([]);
  });
});

describe("slimPaperDetail", () => {
  it("delegates to slimPaper", () => {
    expect(slimPaperDetail({ id: "p1", title: "Foo" }).paper_id).toBe("p1");
  });
});

describe("slimCitations", () => {
  it("maps populated citation rows", () => {
    const r = slimCitations([
      {
        cited_paper_id: "p9",
        cited_title: "Cited",
        cited_doi: "10.2/y",
        cited_year: 2020,
        cited_authors: ["Z"],
        cited_venue: "ICML",
      },
    ]);
    expect(r.citations[0]).toEqual({
      cited_paper_id: "p9",
      cited_title: "Cited",
      cited_doi: "10.2/y",
      cited_year: 2020,
      cited_authors: ["Z"],
      cited_venue: "ICML",
    });
  });

  it("coerces every null field to undefined", () => {
    const r = slimCitations([
      {
        cited_paper_id: null,
        cited_title: null,
        cited_doi: null,
        cited_year: null,
        cited_authors: null,
        cited_venue: null,
      },
    ]);
    expect(r.citations[0]).toEqual({
      cited_paper_id: undefined,
      cited_title: undefined,
      cited_doi: undefined,
      cited_year: undefined,
      cited_authors: undefined,
      cited_venue: undefined,
    });
  });

  it("returns an empty list for a non-array input", () => {
    expect(slimCitations(null)).toEqual({ citations: [] });
  });
});

describe("slimConferencePapers", () => {
  it("maps papers and forwards pagination fields", () => {
    const r = slimConferencePapers({
      papers: [{ id: "p1" }],
      total: 100,
      page: 2,
      total_pages: 10,
    });
    expect(r.papers[0]!.paper_id).toBe("p1");
    expect(r).toMatchObject({ total: 100, page: 2, total_pages: 10 });
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
  it("renames id → doc_id and passes through author metadata", () => {
    expect(
      slimGuidanceDoc({
        id: "d1",
        title: "Doc",
        author_name: "Researcher",
        author_affiliation: "Lab",
        source_url: "https://src",
        tags: ["repro"],
      }),
    ).toEqual({
      doc_id: "d1",
      title: "Doc",
      author: "Researcher",
      author_affiliation: "Lab",
      source_url: "https://src",
      tags: ["repro"],
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
});
