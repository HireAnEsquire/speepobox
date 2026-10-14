# T92 — A feedback resume keeps the recorded set

Status: Done (PR #53)
Type: AFK
Blocked by: [T86](T86-flags-seed-the-wizard.md). Both change `dispatch/dispatch.ts`, so they run one
at a time.

<!--
P2 follow-up, from T89's Status (PR #48). T89 §1 set a feedback-only resume's identity to
`FeedbackResume { resumed: Feature { feature, issues: [] } }`. The row's `issues` hold the newest
run's outcomes (T76's overlay, `withIssueOutcomes`), and a run on the inline arm has none to
overlay. So the branch's latest row forgets the set: a later `--resume <b> --issues <id>` refuses
with *not recorded on '<b>' … the recorded set of '<f>' is* followed by nothing, and a bare
`--resume <b>` says every issue is approved when the row lists none.

The option considered and rejected: teaching `resumedTask` to read an empty `issues` under a
`FeedbackResume` as "exhausted, look further back". The ledger answers a resume from the newest
row alone (SPEC §10), and a second rule for reading an empty list is what that design avoids.
-->

## What to build

**A resume of an exhausted feature run records the set it resumed, unchanged, so the branch's
latest row still says which issues the branch holds and that all of them are approved.**

### 1. The identity carries the recorded outcomes forward

In `dispatch/dispatch.ts`'s `resumedDispatch`, the `FeedbackStandsIn` arm builds the identity with
`issues: []`. Make it carry the resumed row's `issues` instead, exactly as recorded: every one is
`approved`, because that is what selected this arm. The `FeedbackStandsIn` case of `ResumedTask`
in `resume.ts` gains the recorded outcomes beside `folder` and `text`, so `dispatch.ts` does not
read the identity a second time.

This does not claim work the run did not do: the run works no issue, and the outcomes are the ones
the ledger already recorded for this branch. `plan.ts`'s rule, that a plan's identity holds no
outcomes of its own, stands. Record that exception in the comment on the arm.

`withIssueOutcomes` needs no change. The inline arm never reaches the feature loop, so nothing
overlays the carried outcomes.

### 2. What the next resume says

With the set carried forward:

- A bare `--resume <b>` refuses with T78's *every issue of '<f>' recorded on '<b>' is approved*,
  and that sentence is now true of a set that exists.
- `--resume <b> --feedback "y"` takes the inline arm again, with the same identity.
- `--resume <b> --issues <id>`, for a recorded id, refuses naming it under *already approved*, not
  *not recorded*.

### 3. Docs

- T89's Status: the finding it records is closed by T92.
- SPEC §7's `--resume` row, or its eighth mode-line spelling: one clause saying the feedback-only
  resume records the resumed set unchanged (T92).

## Effect wiring

- **Tags introduced or consumed**: none introduced.
- **Layer composition**: unchanged.

## Acceptance criteria

- [ ] A resume of an exhausted feature row with `--feedback "x"` writes a row whose identity is
      `FeedbackResume { Feature { feature, issues: <the resumed row's issues, all approved> } }`.
- [ ] A bare `--resume` on that branch next refuses with the all-approved sentence.
- [ ] `--resume <b> --issues <recorded id>` next refuses with *already approved*, naming the id.
- [ ] `--resume <b> --feedback "y"` next runs the inline arm again, with the same identity.
- [ ] Every T78, T88, and T89 test passes unchanged, except T89's identity assertion, which
      changes to the set it now carries.

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package.
