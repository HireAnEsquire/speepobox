// fzf-grade ranking for the picker's lists (13, amendment 1). clack's default
// filter is case-insensitive **substring** with no ranking, which is why `tsf`
// finds `tseff` in fzf and finds nothing in a clack prompt left on its
// defaults: the amendment is an options-getter, an explicit pass-through
// `filter`, and this scorer — a vendored pure module, not a dependency.
//
// Plain functions, no tag (SPEC §2): pure over a query and a string, so a fake
// would buy nothing and the queries 13 ranked by hand are the whole test.
import { Option } from "effect";

// What counts as the start of a segment — the separators a branch name, a path,
// and an issue stem are built out of.
const BOUNDARY = /[-_/. ]/;

// Score `query` against `text`; higher is better, `Option.none()` is not a
// match at all. Every query character must appear in `text`, in order and
// case-insensitively — the subsequence rule fzf ranks on and a substring filter
// cannot express.
//
// The weights are the prototype's, and their order is the whole behaviour: a
// consecutive run beats a match at the start of the string, which beats a match
// just after a segment boundary, which beats a match anywhere else. Distance
// travelled to reach a character costs, up to a cap — so a scattered match
// still ranks, just below a tight one — and a long candidate pays a mild
// penalty so a short name with the same shape wins.
//
// The empty query scores every candidate 0: at rest, nothing is ranked and the
// caller's own order stands.
export const fuzzyScore = (query: string, text: string): Option.Option<number> => {
  if (query === "") {
    return Option.some(0);
  }
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let score = 0;
  // Where the next character may be found, and where the previous one ended —
  // before the first match there is no previous end, and `-1` sits below every
  // position a match can be found at, so nothing can look consecutive with it.
  let cursor = 0;
  let previousEnd = -1;
  for (const character of q) {
    const found = t.indexOf(character, cursor);
    if (found === -1) {
      return Option.none();
    }
    if (found === previousEnd) {
      score += 8; // consecutive run
    } else if (found === 0) {
      score += 6; // start of string
    } else if (BOUNDARY.test(t[found - 1] ?? "")) {
      score += 5; // segment boundary
    } else {
      score += 1;
    }
    score -= Math.min(found - cursor, 6); // gap penalty, capped
    previousEnd = found + character.length;
    cursor = previousEnd;
  }
  return Option.some(score - Math.floor(t.length / 8)); // mild long-candidate penalty
};

// Rank `items` against `query`, dropping the non-matches. `textOf` is what each
// item ranks on, so a branch row and an issue row rank on their label without
// being copied into a list of strings first.
//
// **Stable for ties**: equal scores come out in input order, which is what
// makes the caller's at-rest order — recency, for the branch step — the
// tiebreaker. The index rides along rather than being left to the sort so the
// rule is stated here rather than inherited.
export const rankFuzzy = <A>(
  query: string,
  items: ReadonlyArray<A>,
  textOf: (item: A) => string,
): ReadonlyArray<A> =>
  items
    .flatMap((item, index) =>
      Option.match(fuzzyScore(query, textOf(item)), {
        onNone: (): ReadonlyArray<{ item: A; index: number; score: number }> => [],
        onSome: (score) => [{ item, index, score }],
      }),
    )
    .toSorted((left, right) => right.score - left.score || left.index - right.index)
    .map((scored) => scored.item);
