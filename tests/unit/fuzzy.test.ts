/**
 * Unit tests for the conference-name fuzzy resolver.
 *
 * Pins four contracts:
 *   1. Common abbreviations / casing variants resolve to the canonical
 *      `short_name` (`usenix sec` → `USENIX Security`).
 *   2. The matcher is strict: typos and over-broad single-letter inputs do
 *      NOT silently subscribe an agent to the wrong conference.
 *   3. When multiple candidates tie at the most-specific match level, we
 *      flag `ambiguous` and surface the candidate list (e.g. `usenix`
 *      against a corpus that contains both `USENIX Security` and
 *      `USENIX Privacy`).
 *   4. Unmatched inputs return `kind: "none"` so the caller can pass the
 *      raw input through and let the API surface its own error.
 */
import { describe, expect, it } from "vitest";

import {
  resolveConferenceShortName,
  type ConferenceCandidate,
} from "../../src/tools/_fuzzy.js";

const CONFERENCES: ConferenceCandidate[] = [
  { short_name: "ICML", full_name: "International Conference on Machine Learning" },
  { short_name: "ICLR", full_name: "International Conference on Learning Representations" },
  { short_name: "NeurIPS", full_name: "Neural Information Processing Systems" },
  { short_name: "ACL", full_name: "Annual Meeting of the Association for Computational Linguistics" },
  { short_name: "CVPR", full_name: "IEEE/CVF Conference on Computer Vision and Pattern Recognition" },
  { short_name: "NDSS", full_name: "Network and Distributed System Security Symposium" },
  { short_name: "CCS", full_name: "ACM Conference on Computer and Communications Security" },
  { short_name: "S&P", full_name: "IEEE Symposium on Security and Privacy" },
  { short_name: "USENIX Security", full_name: "USENIX Security Symposium" },
];

describe("resolveConferenceShortName: exact + abbreviated matches", () => {
  it("returns the exact short_name unchanged", () => {
    expect(resolveConferenceShortName("CVPR", CONFERENCES)).toEqual({
      kind: "match",
      short_name: "CVPR",
    });
    expect(resolveConferenceShortName("USENIX Security", CONFERENCES)).toEqual({
      kind: "match",
      short_name: "USENIX Security",
    });
  });

  it("is case-insensitive on short_name", () => {
    expect(resolveConferenceShortName("cvpr", CONFERENCES)).toEqual({
      kind: "match", short_name: "CVPR",
    });
    expect(resolveConferenceShortName("Cvpr", CONFERENCES)).toEqual({
      kind: "match", short_name: "CVPR",
    });
    expect(resolveConferenceShortName("neurips", CONFERENCES)).toEqual({
      kind: "match", short_name: "NeurIPS",
    });
  });

  it("matches abbreviated tokens via prefix (USENIX SEC → USENIX Security)", () => {
    expect(resolveConferenceShortName("USENIX SEC", CONFERENCES)).toEqual({
      kind: "match", short_name: "USENIX Security",
    });
    expect(resolveConferenceShortName("usenix sec", CONFERENCES)).toEqual({
      kind: "match", short_name: "USENIX Security",
    });
  });

  it("strips punctuation in both directions (S&P, sp, S P)", () => {
    expect(resolveConferenceShortName("S&P", CONFERENCES)).toEqual({
      kind: "match", short_name: "S&P",
    });
    expect(resolveConferenceShortName("s&p", CONFERENCES)).toEqual({
      kind: "match", short_name: "S&P",
    });
    expect(resolveConferenceShortName("S P", CONFERENCES)).toEqual({
      kind: "match", short_name: "S&P",
    });
  });

  it("widens to full_name when no short_name match (machine learning → ICML)", () => {
    expect(resolveConferenceShortName("machine learning", CONFERENCES)).toEqual({
      kind: "match", short_name: "ICML",
    });
  });

  it("token order is irrelevant", () => {
    expect(resolveConferenceShortName("Security USENIX", CONFERENCES)).toEqual({
      kind: "match", short_name: "USENIX Security",
    });
  });

  it("single-letter input is ambiguous when multiple short_names share the prefix", () => {
    // 'S' is a prefix of 'S&P' (tokenises as ['s','p']) AND of 'USENIX
    // Security' (whose 'security' token starts with 's'). Both short_names
    // tokenise to size 2 → tied at the most-specific level → ambiguous.
    // Better than silently picking one; the agent should be told.
    const result = resolveConferenceShortName("S", CONFERENCES);
    expect(result.kind).toBe("ambiguous");
    if (result.kind === "ambiguous") {
      expect(result.candidates.sort()).toEqual(["S&P", "USENIX Security"]);
    }
  });
});

describe("resolveConferenceShortName: ambiguity", () => {
  it("flags ambiguity when two candidates share an input prefix in their short_name", () => {
    // The exact case the user raised: introduce a USENIX Privacy alongside
    // USENIX Security. `usenix` alone is consistent with both; silently
    // picking one would subscribe the agent to the wrong venue.
    const corpus: ConferenceCandidate[] = [
      ...CONFERENCES,
      { short_name: "USENIX Privacy", full_name: "USENIX Privacy Conference" },
    ];
    const result = resolveConferenceShortName("usenix", corpus);
    expect(result.kind).toBe("ambiguous");
    if (result.kind === "ambiguous") {
      // Both must be reported. Order doesn't matter; agents render this
      // back to the user / chooses one.
      expect(result.candidates.sort()).toEqual(["USENIX Privacy", "USENIX Security"]);
    }
  });

  it("ambiguity scope is limited to equally-specific candidates", () => {
    // Three USENIX-prefixed venues with different specificities. The
    // 2-token short_names ("USENIX Security", "USENIX Privacy") are tied
    // at the most-specific level. Adding a 3-token candidate doesn't
    // change the ambiguity (it's strictly less specific, not in the tie).
    const corpus: ConferenceCandidate[] = [
      { short_name: "USENIX Security", full_name: "USENIX Security Symposium" },
      { short_name: "USENIX Privacy", full_name: "USENIX Privacy Conference" },
      { short_name: "USENIX ATC HotOS", full_name: "USENIX Annual Technical Conference HotOS" },
    ];
    const result = resolveConferenceShortName("usenix", corpus);
    expect(result.kind).toBe("ambiguous");
    if (result.kind === "ambiguous") {
      expect(result.candidates.sort()).toEqual(["USENIX Privacy", "USENIX Security"]);
    }
  });

  it("more specific input (USENIX SEC) disambiguates the same corpus", () => {
    const corpus: ConferenceCandidate[] = [
      ...CONFERENCES,
      { short_name: "USENIX Privacy", full_name: "USENIX Privacy Conference" },
    ];
    expect(resolveConferenceShortName("USENIX SEC", corpus)).toEqual({
      kind: "match", short_name: "USENIX Security",
    });
    expect(resolveConferenceShortName("usenix priv", corpus)).toEqual({
      kind: "match", short_name: "USENIX Privacy",
    });
  });
});

describe("resolveConferenceShortName: non-matches", () => {
  it("returns kind:none for arbitrary typos", () => {
    expect(resolveConferenceShortName("usnix sec", CONFERENCES)).toEqual({
      kind: "none",
    });
  });

  it("returns kind:none when nothing matches", () => {
    expect(resolveConferenceShortName("OOPSLA", CONFERENCES)).toEqual({ kind: "none" });
    expect(resolveConferenceShortName("totally-fake", CONFERENCES)).toEqual({ kind: "none" });
  });

  it("handles empty / whitespace input", () => {
    expect(resolveConferenceShortName("", CONFERENCES)).toEqual({ kind: "none" });
    expect(resolveConferenceShortName("   ", CONFERENCES)).toEqual({ kind: "none" });
  });

  it("handles candidates with null full_name", () => {
    const candidates: ConferenceCandidate[] = [
      { short_name: "FOO", full_name: null },
      { short_name: "BAR" },
    ];
    expect(resolveConferenceShortName("foo", candidates)).toEqual({
      kind: "match", short_name: "FOO",
    });
    expect(resolveConferenceShortName("BAR", candidates)).toEqual({
      kind: "match", short_name: "BAR",
    });
  });
});

describe("resolveConferenceShortName: full_name exact match", () => {
  it("returns the short_name on an exact, case-insensitive full_name hit", () => {
    // Stage 2: the input matches a full_name verbatim (not a short_name).
    expect(
      resolveConferenceShortName(
        "neural information processing systems",
        CONFERENCES,
      ),
    ).toEqual({ kind: "match", short_name: "NeurIPS" });
  });

  it("flags ambiguity when two candidates share an identical full_name", () => {
    // Stage 2 with a duplicate full_name → `fullExact.length > 1`.
    const corpus: ConferenceCandidate[] = [
      { short_name: "AAA", full_name: "Shared Long Name" },
      { short_name: "BBB", full_name: "Shared Long Name" },
    ];
    const result = resolveConferenceShortName("shared long name", corpus);
    expect(result.kind).toBe("ambiguous");
    if (result.kind === "ambiguous") {
      expect(result.candidates.sort()).toEqual(["AAA", "BBB"]);
    }
  });
});

describe("resolveConferenceShortName: degenerate candidates", () => {
  it("skips a candidate whose short_name tokenises to nothing in stage 3a", () => {
    // The input misses stages 1 + 2, so it reaches the prefix stage. The
    // first candidate's short_name is pure punctuation → zero target
    // tokens → `continue`d. The real prefix match still wins.
    const corpus: ConferenceCandidate[] = [
      { short_name: "!!!", full_name: "@@@" },
      { short_name: "ICML", full_name: "International Conference on Machine Learning" },
    ];
    expect(resolveConferenceShortName("icm", corpus)).toEqual({
      kind: "match",
      short_name: "ICML",
    });
  });

  it("widens to stage 3b and tolerates a null full_name in the combined selector", () => {
    // `repres` matches no short_name token (stage 3a finds nothing), so
    // stage 3b builds `${short_name} ${full_name ?? ""}` for each
    // candidate. The `?? ""` arm fires for the null-full_name entry.
    const corpus: ConferenceCandidate[] = [
      { short_name: "ZZZ", full_name: null },
      {
        short_name: "ICLR",
        full_name: "International Conference on Learning Representations",
      },
    ];
    expect(resolveConferenceShortName("repres", corpus)).toEqual({
      kind: "match",
      short_name: "ICLR",
    });
  });

  it("picks the most-specific candidate when a later match is smaller", () => {
    // `lin` prefix-matches both "Computational Linguistics Workshop" (3
    // tokens) and "Linguistics" (1 token). The smaller target wins, which
    // forces the `m.targetSize < minSize` update on a later iteration.
    const corpus: ConferenceCandidate[] = [
      { short_name: "Computational Linguistics Workshop", full_name: "x" },
      { short_name: "Linguistics", full_name: "y" },
    ];
    expect(resolveConferenceShortName("lin", corpus)).toEqual({
      kind: "match",
      short_name: "Linguistics",
    });
  });
});
