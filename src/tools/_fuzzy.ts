/**
 * Fuzzy resolver for conference identifiers in MCP tool arguments.
 *
 * Agents sometimes pass abbreviated, lowercased, or oddly-cased conference
 * names like `usenix sec`, `neurips`, `cvpr`, `s&p`. The API expects the exact
 * canonical `short_name` and 404s on a near-miss, which surfaces to the
 * agent as a confusing error rather than the result it asked for. This
 * module resolves the user's input to the canonical short_name when
 * there's a confident match, flags ambiguity when the input is consistent
 * with multiple candidates, and otherwise passes the input through so
 * the API's own error path handles it.
 *
 * Match strategy (first hit wins):
 *   1. Exact, case-insensitive match on `short_name`.
 *   2. Exact, case-insensitive match on `full_name`.
 *   3a. Token-prefix match against `short_name` only. Every input token must
 *       be a prefix of some target token. Most-specific candidate (smallest
 *       target token set) wins. Ties → ambiguous.
 *   3b. If 3a found NO candidates (not "ambiguous"), widen to
 *       `short_name + full_name` and apply the same prefix rule. This
 *       handles full-name queries like "machine learning" → ICML without
 *       letting a single-letter "S" leak into NeurIPS via its "Systems"
 *       full_name token.
 *
 * Strict-by-default: typos are out of scope. We never match on Levenshtein
 * distance because false matches (subscribing to the wrong conference) are
 * worse than no match.
 *
 * Ambiguity contract: when stage 3a sees multiple candidates tied at the
 * minimum target size, return `{ kind: "ambiguous", candidates }` instead
 * of silently picking one. The caller surfaces this to the agent so it can
 * disambiguate with a more specific input, e.g. `usenix` against a corpus
 * containing "USENIX Security" + "USENIX Privacy" returns both names so
 * the agent retries with `USENIX Security` or `USENIX Privacy`.
 */

const _PUNCT = /[^a-z0-9 ]/g;
const _WS = /\s+/g;

export function _normalize(s: string): string {
  return s.toLowerCase().replace(_PUNCT, " ").replace(_WS, " ").trim();
}

export function _tokens(s: string): string[] {
  const n = _normalize(s);
  return n ? n.split(" ") : [];
}

export interface ConferenceCandidate {
  short_name: string;
  full_name?: string | null;
}

export type FuzzyMatchResult =
  | { kind: "match"; short_name: string }
  | { kind: "ambiguous"; candidates: string[] }
  | { kind: "none" };

interface _Match {
  short_name: string;
  targetSize: number;
}

function _tryStage(
  inputTokens: string[],
  candidates: readonly ConferenceCandidate[],
  selector: (c: ConferenceCandidate) => string,
): FuzzyMatchResult {
  const matches: _Match[] = [];
  for (const c of candidates) {
    const targetTokens = _tokens(selector(c));
    if (targetTokens.length === 0) continue;
    const allMatch = inputTokens.every((it) =>
      targetTokens.some((tt) => tt.startsWith(it)),
    );
    if (!allMatch) continue;
    matches.push({ short_name: c.short_name, targetSize: targetTokens.length });
  }
  if (matches.length === 0) return { kind: "none" };

  // Smallest target tokens = most specific candidate. Ties at the minimum
  // size mean genuine ambiguity (e.g. "usenix" → USENIX Security + USENIX
  // Privacy both at size 2).
  let minSize = matches[0]!.targetSize;
  for (const m of matches) if (m.targetSize < minSize) minSize = m.targetSize;
  const tied = matches.filter((m) => m.targetSize === minSize);
  if (tied.length === 1) return { kind: "match", short_name: tied[0]!.short_name };
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
  const inputN = _normalize(input);
  if (!inputN) return { kind: "none" };

  // 1. Exact case-insensitive on short_name. Short_names are unique by
  //    construction so a hit here is unambiguous.
  for (const c of candidates) {
    if (_normalize(c.short_name) === inputN) {
      return { kind: "match", short_name: c.short_name };
    }
  }
  // 2. Exact case-insensitive on full_name. Full_names should also be
  //    unique; defensively only return on a single hit.
  const fullExact = candidates.filter(
    (c) => c.full_name && _normalize(c.full_name) === inputN,
  );
  if (fullExact.length === 1) {
    return { kind: "match", short_name: fullExact[0]!.short_name };
  }
  if (fullExact.length > 1) {
    return { kind: "ambiguous", candidates: fullExact.map((c) => c.short_name) };
  }

  // 3a. Token-prefix match against short_name only. `inputN` is already
  // confirmed non-empty above, so `_tokens(input)` always returns ≥ 1
  // token; the empty-array branch is defensive belt-and-suspenders.
  const inputTokens = _tokens(input);
  /* v8 ignore next */
  if (inputTokens.length === 0) return { kind: "none" };

  const shortStage = _tryStage(inputTokens, candidates, (c) => c.short_name);
  if (shortStage.kind !== "none") return shortStage;

  // 3b. Widen to short_name ∪ full_name only when stage 3a found nothing.
  return _tryStage(
    inputTokens,
    candidates,
    (c) => `${c.short_name} ${c.full_name ?? ""}`,
  );
}
