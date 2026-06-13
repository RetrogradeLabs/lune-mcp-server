import { describe, expect, it } from "vitest";

import {
  slimConference,
  slimConferenceList,
  slimConferencePapers,
  slimDrainResponse,
  slimRelated,
  slimSubscription,
  slimSubscriptionList,
} from "../../src/tools/_slim.js";

/**
 * Direct unit coverage for the projectors that `slim.test.ts` does not touch
 * and that the handler suites only exercise indirectly through full API
 * payloads. These are pure functions with branch logic worth pinning at the
 * boundary: falsy-field guards, defaulting, enriched related-search payloads,
 * the `.filter(Boolean)` list guards, and the optional-paging passthrough.
 */

describe("slimConference", () => {
  it("keeps populated description/category and fills paper_count/years defaults", () => {
    const out = slimConference({
      id: "c1",
      short_name: "NeurIPS",
      full_name: "Conference on Neural Information Processing Systems",
      description: "ML venue",
      category: "ml",
    });
    expect(out).toEqual({
      id: "c1",
      short_name: "NeurIPS",
      full_name: "Conference on Neural Information Processing Systems",
      description: "ML venue",
      category: "ml",
      paper_count: 0,
      years: [],
    });
  });

  it("drops an empty-string description and null category via the falsy guards", () => {
    const out = slimConference({
      id: "c2",
      short_name: "CCS",
      full_name: "ACM CCS",
      description: "",
      category: null,
      paper_count: 12,
      years: [2024, 2025],
    });
    expect(out.description).toBeUndefined();
    expect(out.category).toBeUndefined();
    expect(out.paper_count).toBe(12);
    expect(out.years).toEqual([2024, 2025]);
  });
});

describe("slimConferenceList", () => {
  it("projects each entry and drops falsy holes in the array", () => {
    const out = slimConferenceList([
      { id: "a", short_name: "A", full_name: "Alpha" },
      null,
      undefined,
      { id: "b", short_name: "B", full_name: "Beta", paper_count: 3 },
    ]);
    expect(out.conferences).toHaveLength(2);
    expect(out.conferences.map((c) => c.id)).toEqual(["a", "b"]);
    expect(out.conferences[1]!.paper_count).toBe(3);
  });

  it("returns an empty list when given a non-array", () => {
    expect(slimConferenceList("nope")).toEqual({ conferences: [] });
    expect(slimConferenceList(null)).toEqual({ conferences: [] });
  });
});

describe("slimRelated", () => {
  it("wraps a bare array of papers under a papers field", () => {
    const out = slimRelated([
      { id: "p1", title: "One" },
      { paper_id: "p2", title: "Two" },
    ]);
    expect(out.papers.map((p) => p.paper_id)).toEqual(["p1", "p2"]);
  });

  it("keeps abstract and non-abstract contexts for each related result", () => {
    const out = slimRelated([
      {
        id: "p1",
        title: "One",
        abstract: "The abstract",
        matched_chunks: [
          { section_name: "Abstract", text: "The abstract", score: 0.9 },
          { section_name: "Results", text: "The result", score: 0.8 },
        ],
      },
    ]);
    expect(out.papers[0]!.abstract).toBe("The abstract");
    expect(out.papers[0]!.contexts).toEqual([
      { section: "Results", text: "The result", score: 0.8, chunk_id: undefined },
    ]);
  });

  it("returns an empty papers array for a non-array input", () => {
    expect(slimRelated(null)).toEqual({ papers: [] });
    expect(slimRelated({ not: "an array" })).toEqual({ papers: [] });
  });
});

describe("slimConferencePapers", () => {
  it("projects papers (no abstract) and reports total + has_more", () => {
    const out = slimConferencePapers({
      papers: [{ id: "p1", title: "One", abstract: "dropped on a browse page" }],
      total: 42,
      page: 2,
      limit: 20,
    });
    expect(out.papers).toHaveLength(1);
    expect(out.papers[0]!.paper_id).toBe("p1");
    // Browse pages stay light: the abstract is not surfaced.
    expect("abstract" in out.papers[0]!).toBe(false);
    expect(out.total).toBe(42);
    // page 2 of 20 covers 40 < 42, so one more paper remains.
    expect(out.has_more).toBe(true);
  });

  it("reports has_more=false on the last page", () => {
    const out = slimConferencePapers({
      papers: [{ id: "p1", title: "One" }],
      total: 40,
      page: 2,
      limit: 20,
    });
    expect(out.has_more).toBe(false);
  });

  it("defaults papers to an empty array and has_more=false", () => {
    const out = slimConferencePapers({});
    expect(out.papers).toEqual([]);
    expect(out.total).toBeUndefined();
    expect(out.has_more).toBe(false);
  });
});

describe("slimSubscription + slimSubscriptionList", () => {
  it("projects the subscription id/conference/created_at triple", () => {
    expect(
      slimSubscription({
        id: "s1",
        conference_id: "c1",
        created_at: "2026-01-01T00:00:00Z",
      }),
    ).toEqual({
      id: "s1",
      conference_id: "c1",
      created_at: "2026-01-01T00:00:00Z",
    });
  });

  it("projects a list and drops falsy holes", () => {
    const out = slimSubscriptionList([
      { id: "s1", conference_id: "c1", created_at: "t1" },
      null,
      { id: "s2", conference_id: "c2", created_at: "t2" },
    ]);
    expect(out.subscriptions.map((s) => s.id)).toEqual(["s1", "s2"]);
  });

  it("returns an empty subscriptions list for a non-array", () => {
    expect(slimSubscriptionList(undefined)).toEqual({ subscriptions: [] });
  });
});

describe("slimDrainResponse", () => {
  it("merges occurred_at onto each slimmed paper and passes next_cursor", () => {
    const out = slimDrainResponse({
      papers: [{ id: "p1", title: "One", occurred_at: "2026-02-02T00:00:00Z" }],
      next_cursor: "cursor-xyz",
    });
    expect(out.papers).toHaveLength(1);
    expect(out.papers[0]!.paper_id).toBe("p1");
    expect(out.papers[0]!.occurred_at).toBe("2026-02-02T00:00:00Z");
    expect(out.next_cursor).toBe("cursor-xyz");
  });

  it("defaults papers to empty and next_cursor to null", () => {
    const out = slimDrainResponse({});
    expect(out.papers).toEqual([]);
    expect(out.next_cursor).toBeNull();
  });

  it("coerces an absent next_cursor (null) rather than leaving it undefined", () => {
    const out = slimDrainResponse({ papers: [], next_cursor: undefined });
    expect(out.next_cursor).toBeNull();
  });
});
