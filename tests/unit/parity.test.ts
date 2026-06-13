import { describe, expect, it } from "vitest";
import {
  slimCitations,
  slimConferenceList,
  slimConferencePapers,
  slimRelated,
  slimSearchResponse,
} from "../../src/tools/_slim.js";
import {
  GetCitationsOutput,
  GetConferencePapersOutput,
  ListConferencesOutput,
  SearchPapersOutput,
  SearchRelatedOutput,
} from "../../src/tools/_outputs.js";
import { PAPER_TOOLS } from "../../src/tools/papers.js";

// Representative API fixtures mirroring the real backend response shapes.
const PAPER = {
  id: "p1",
  title: "A Paper",
  authors: ["A. One", "B. Two"],
  year: 2024,
  doi: "10.1/x",
  arxiv_id: "2401.00001",
  abstract: "Abstract text.",
  pdf_cdn_url: "https://cdn/x.pdf",
  citation_count: 12,
  conference: { short_name: "NeurIPS" },
};

describe("projector output matches the advertised outputSchema", () => {
  it("slimSearchResponse conforms to SearchPapersOutput in both modes", () => {
    const fixture = {
      results: [
        {
          ...PAPER,
          score: 0.77,
          matched_chunks: [
            { section_name: "Results", text: "gain", score: 0.77, chunk_id: "ch-1" },
          ],
        },
      ],
    };
    expect(() => SearchPapersOutput.parse(slimSearchResponse(fixture))).not.toThrow();
    expect(() => SearchPapersOutput.parse(slimSearchResponse(fixture, false))).not.toThrow();
  });

  it("slimCitations conforms to GetCitationsOutput (guards the H1 regression)", () => {
    const out = slimCitations({
      direction: "cited_by",
      papers: [
        { id: "c1", title: "Citing", authors: ["X"], citation_count: 3 },
        { id: null, title: "Ref only", authors: [], venue: "WS" },
      ],
    });
    expect(() => GetCitationsOutput.parse(out)).not.toThrow();
  });

  it("slimConferenceList conforms to ListConferencesOutput", () => {
    const out = slimConferenceList([
      { id: "c", short_name: "CCS", full_name: "ACM CCS", paper_count: 9, years: [2024] },
    ]);
    expect(() => ListConferencesOutput.parse(out)).not.toThrow();
  });

  it("slimConferencePapers conforms to GetConferencePapersOutput", () => {
    const out = slimConferencePapers({ papers: [PAPER], total: 1, page: 1, limit: 20 });
    expect(() => GetConferencePapersOutput.parse(out)).not.toThrow();
  });

  it("slimRelated conforms to SearchRelatedOutput", () => {
    const out = slimRelated([
      {
        ...PAPER,
        similarity: 0.83,
        matched_chunks: [
          { section_name: "Methods", text: "neighbor evidence", score: 0.71 },
        ],
      },
    ]);
    expect(() => SearchRelatedOutput.parse(out)).not.toThrow();
  });
});

describe("tool descriptions do not promise dropped fields (guards H3)", () => {
  it("no paper tool description names the removed AI enrichment fields", () => {
    const banned = [/AI TL;DR/i, /AI-extracted/i, /\bmethodology\b/i, /citation count descending/i];
    for (const tool of PAPER_TOOLS) {
      for (const re of banned) {
        expect(tool.description, `${tool.name} description must not match ${re}`).not.toMatch(re);
      }
    }
  });
});
