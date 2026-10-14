# T89 — An exhausted resume takes `--feedback` as its task

Status: Done (PR #48. The run's row records `Feature { issues: [] }` as §1 says, so the branch's latest row no longer carries the set: a later `--resume <b> --issues <id>` refuses naming an empty recorded set, and a bare `--resume <b>` says every issue is approved over none. Closed by T92: the row now carries the resumed set forward)
Type: AFK
Blocked by: [T78](T78-a-resume-runs-some-of-what-it-ran-before.md) — the replay whose exhausted case this runs.

<!--
P2. Split out of T78 on 2026-09-22 (T78 says why). T78 refuses every exhausted set as a stopgap,
`--feedback` or not; this ticket makes the `--feedback` arm run. It shares `resume.ts` and
`dispatch.ts` with T88: dispatch the two one at a time, in either order.
-->

## What to build

**A resume of a feature run whose recorded ids are all `approved` runs `--feedback` as an inline
task on the branch. Without `--feedback` it is still refused.**

This is 15's feedback-only resume. It has no flag of its own: an exhausted recorded set plus
`--feedback` present is what selects it (SPEC §7).

### 1. With `--feedback`

The task is `Inline { text: <feedback>, feedback: none }` — T66's arm, chart row 6's shape. The run
is one implement pass, review rounds, land, and PR, against the branch's PR context (T66 §4).

- Identity: `FeedbackResume { resumed: Feature { feature, issues: [] }, resumedRunId }`.
- The mode line prints *resume (feedback stands in for the exhausted issue set)*. That is SPEC §7's
  eighth spelling; T78 added the seventh, `resume (feature)`.
- The plan has no `issues` row: the task is on the inline arm.

### 2. Without `--feedback`

Unchanged from T78's stopgap, which stays as this arm: *every issue of '<folder>' recorded on '<b>'
is approved; say what to do with `--feedback`, or dispatch the folder afresh with `--feature …
--issues …`*.

### 3. Docs

SPEC §7's mode-line sentence gains the eighth spelling.

## Effect wiring

- **Tags introduced or consumed**: none introduced.
- **Layer composition**: unchanged.

## Acceptance criteria

- [ ] `--resume b --feedback "x"` where every recorded id is approved runs the inline arm: one
      implement pass on `x`, the mode line's eighth spelling, the PR context section in the
      implement prompt, and a row with identity `FeedbackResume { Feature { issues: [] } }`.
- [ ] The same without `--feedback` refuses with §2's words.
- [ ] `--dry-run --resume b --feedback "x"` prints the eighth spelling and writes nothing.
- [ ] SPEC §7's mode-line sentence lists eight spellings.

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package.
