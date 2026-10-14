# T80 — The fuzzy scorer is a pure module

Status: Done (PR #36; the fourth criterion holds by fact and not by rule — nothing under `src/` imports `.agentbox/`, and `scripts/check-bans.ts` has no ban that keeps it so; `rankFuzzy` has no floor and no cap, and `tsf` puts `tseff` first by one point, both recorded on T81 §3; and `src/prompt/` — the TTY prompts — sits beside `src/agent/prompt.ts`, the pass templates, so *prompt* names two things in `src/`)
Type: AFK
Blocked by:

<!--
P3 (09 Q5), the picker, first slice. Ticket 13 settled clack with three amendments; amendment 1
is that fzf-grade ranking needs an options getter, an explicit pass-through `filter`, and a
**vendored pure scorer** — the prototype's `fuzzy.mjs`, the one module 13 called liftable. It has
its own green with no TTY, no tag, and no consumer: the prototype supplies the test corpus. So it
lands alone, and T81's wizard reads as pure addition on top of it (the rule T68 and T69 followed).

The prototype is tracked in this repo at `.agentbox/proto-clack-picker/` (eight files, identical
to hae's `proto/clack-picker` branch). Read `fuzzy.mjs`; port, do not import — the prototype dir
is 13's exhibit and is deleted with the oracle, and `.agentbox/` is never a source of `src/`.
-->

## What to build

**`src/prompt/fuzzy.ts`: `fuzzyScore(query, text)` and `rankFuzzy(query, items, textOf)`, the
prototype's scorer in TypeScript, under `verify`, with the queries 13 ranked by hand as its tests.**

### 1. The scorer

The prototype's algorithm, unchanged in behaviour: every query character must appear in order
(case-insensitive); consecutive runs score highest, then a match at the start of the string, then a
match after a segment boundary (`-`, `_`, `/`, `.`, space); a gap costs up to a cap; a long
candidate pays a mild penalty; a non-subsequence is `Option.none()` rather than the prototype's
`null`. An empty query scores every candidate `0`.

`rankFuzzy` maps, filters the non-matches, and sorts by score descending — **stable** for ties, so
the caller's at-rest order (recency, in T81) is what breaks them. It takes a `textOf` accessor so a
branch row and an issue row rank on their label without copying.

Both are plain functions, no tag (SPEC §2's *plain functions* row) — a fake buys nothing, and the
tests below are the plain-function kind 12 said translate.

### 2. The tests

`test/fuzzy.test.ts`. The three queries 13 verified by hand against the real branch list are the
acceptance bar, with a fixture list carrying the names they ranked against: `tsf` ranks `tseff`
first, `hard` ranks `agentbox-hardening` first, `sfb` ranks `resume-feedback` first. Beside them:
a query that is not a subsequence is dropped; ties keep input order; the empty query returns the
input unchanged; case is ignored. The prototype's `substringFilter` is **not** ported — it existed
for the A/B comparison and clack's default is what T81 must never fall back to.

### 3. Docs

- SPEC §2's *plain functions* row: add *fuzzy ranking* to the list.
- SPEC §13's clack row already records the amendment; no change.

## Effect wiring

- **Tags introduced or consumed**: none.
- **Layer composition**: unchanged.

## Acceptance criteria

- [ ] `rankFuzzy("tsf", branches)` puts `tseff` first, `rankFuzzy("hard", …)` puts
      `agentbox-hardening` first, `rankFuzzy("sfb", …)` puts `resume-feedback` first, against a
      fixture list that also holds the names those queries substring-match.
- [ ] A query whose characters do not all appear in order is absent from the result.
- [ ] Two candidates with equal scores come out in input order; an empty query returns every
      candidate in input order.
- [ ] Nothing under `src/` imports from `.agentbox/`.

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package.
