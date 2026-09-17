/**
 * Fuzzy resolver for conference identifiers in MCP tool arguments. Agents pass
 * abbreviated / oddly-cased names (`usenix sec`, `s&p`); the API wants the exact
 * canonical `short_name` and 404s on a near-miss. This resolves a confident match
 * to the canonical short_name, flags ambiguity, else passes input through to the
 * API's own error path. The numbered match stages live inline below.
 *
 * Strict-by-default: no Levenshtein / typo matching, since a false match (wrong
 * conference) is worse than no match.
 *
 * Ambiguity contract: when input ties multiple candidates, return
 * `{ kind: "ambiguous", candidates }` (never silently pick one) so the caller can
 * ask the agent to disambiguate (e.g. `usenix` -> USENIX Security + USENIX Privacy).
 */

const PUNCT = /[^a-z0-9 ]/g;

const WS = /\s+/g;

export function normalize(s: string): string {
  return s.toLowerCase().replace(PUNCT, " ").replace(WS, " ").trim();
}

export function tokens(s: string): string[] {
  const n = normalize(s);

  return n ? n.split(" ") : [];
}

/** A conference row as the catalog returns it. Declared as a type alias rather
 *  than an interface so it carries the implicit index signature that makes it a
 *  valid JSON body contract. */
export type ConferenceCandidate = {
  short_name: string;
  full_name?: string | null;
};

export type FuzzyMatchResult =
  | { kind: "match"; short_name: string }
  | { kind: "ambiguous"; candidates: string[] }
  | { kind: "none" };

interface Match {
  short_name: string;
  targetSize: number;
}

function tryStage(
  inputTokens: string[],
  candidates: readonly ConferenceCandidate[],
  selector: (c: ConferenceCandidate) => string,
): FuzzyMatchResult {
  const matches: Match[] = [];

  for (const c of candidates) {
    const targetTokens = tokens(selector(c));

    if (targetTokens.length === 0) continue;

    const allMatch = inputTokens.every((it) =>
      targetTokens.some((tt) => tt.startsWith(it)),
    );

    if (!allMatch) continue;
    matches.push({ short_name: c.short_name, targetSize: targetTokens.length });
  }

  if (matches.length === 0) return { kind: "none" };

  // Smallest target = most specific candidate; a tie at the minimum size is
  // genuine ambiguity ("usenix" -> USENIX Security and USENIX Privacy).
  let minSize = matches[0]!.targetSize;

  for (const m of matches) if (m.targetSize < minSize) minSize = m.targetSize;
  const tied = matches.filter((m) => m.targetSize === minSize);

  if (tied.length === 1)
    return { kind: "match", short_name: tied[0]!.short_name };

  return {
    kind: "ambiguous",
    candidates: tied.map((m) => m.short_name),
  };
}

/**
 * Resolve a fuzzy user-supplied conference name. See module docstring for
 * the algorithm. The caller distinguishes the three outcomes:
 *   • "match":      use `result.short_name`.
 *   • "ambiguous":  surface the candidate list to the agent.
 *   • "none":       pass the original input through; let the API answer.
 */
export function resolveConferenceShortName(
  input: string,
  candidates: readonly ConferenceCandidate[],
): FuzzyMatchResult {
  const inputN = normalize(input);

  if (!inputN) return { kind: "none" };

  // 1. Exact case-insensitive on short_name. Short_names are unique by
  //    construction so a hit here is unambiguous.
  for (const c of candidates) {
    if (normalize(c.short_name) === inputN) {
      return { kind: "match", short_name: c.short_name };
    }
  }

  // 2. Exact case-insensitive on full_name. Full_names should also be
  //    unique; defensively only return on a single hit.
  const fullExact = candidates.filter(
    (c) => c.full_name && normalize(c.full_name) === inputN,
  );

  if (fullExact.length === 1) {
    return { kind: "match", short_name: fullExact[0]!.short_name };
  }

  if (fullExact.length > 1) {
    return {
      kind: "ambiguous",
      candidates: fullExact.map((c) => c.short_name),
    };
  }

  // 3a. Token-prefix match against short_name only.
  const inputTokens = tokens(input);
  const shortStage = tryStage(inputTokens, candidates, (c) => c.short_name);

  if (shortStage.kind !== "none") return shortStage;

  // 3b. Widen to short_name ∪ full_name only when stage 3a found nothing.
  return tryStage(
    inputTokens,
    candidates,
    (c) => `${c.short_name} ${c.full_name ?? ""}`,
  );
}
