# T78 — A resume runs some of what it ran before

Status: Done (PR #44. Both stopgaps sit in `resume.ts`, and T88 and T89 replace them. The `--issues` refusal reads the flag as typed, so `--issues ''` beside a feature resume refuses too. The branch-moved refusal ends *did not approve it* even when it lists several ids — wording only. The comment at `featureStatedOnce`'s `onNone` arm already names T88)
Type: AFK
Blocked by: [T76](T76-the-feature-loop.md) — the loop a resumed selection runs through.

<!--
P2 (09 Q5). 15's rule in one sentence: **a resume can only ever run some of what it ran before.**
The 2026-08-19 incident — `--resume speepobox-t37 --feedback "…"` meant as feedback-only ran a
two-issue feature run, because bash recovered `task_dir` off the row and rescanned the folder — is
closed by replaying the recorded set rather than the folder. `resume.ts` has refused a `Feature`
identity since T16; this ticket is the arm.

Split on 2026-09-22 — T77, written at this size, spent its whole 30-minute implement pass and
needed a resume. This ticket is the replay alone. The rest was split out:
- `--issues` narrowing a resume: [T88](T88-issues-on-a-resume-only-narrows.md).
- the exhausted set taking `--feedback`: [T89](T89-an-exhausted-resume-takes-feedback-as-its-task.md).
- the empty-`--feature` refusal: [T87](T87-an-empty-feature-flag-is-refused-as-empty.md).
Two stopgap refusals below hold those two resume cases until their tickets land. Each is
replaced there, never widened.
-->

## What to build

**`--resume <b>` of a branch whose newest row is a feature run replays the recorded issue set,
filtered by recorded outcomes, and never rescans the folder. The mode line says it resumes.**

### 1. What the record says

`resolveResume` already hands back the dispatch identity through `dispatchIdentity`, so a
`FeedbackResume` wrapping a `Feature` answers the `Feature` row it wrapped — and that row's
`issues` are the newest run's outcomes (T76 overlays this run's outcomes onto the wrapped identity,
so the chain composes: run 1 leaves `[A approved, B needs-work, C not-attempted]`, the resume
replays `[B, C]`, its row wraps `Feature { issues: [B approved, C needs-work] }`, the next resume
replays `[C]`).

**Recoverable** is every outcome but `approved`. The recoverable ids are then re-read at the
branch tip through T73's content guards (`issuesSelected`) as an `Enumerated` request — so a
blocker that landed elsewhere since, or an id that has since been marked `Done` on this branch by
hand, refuses as it would on a fresh dispatch. `AlreadyDone` for an id the record says was not
approved is the one case that reads as *the branch moved under the record*, and it is refused with
that sentence.

### 2. The plan

A resumed feature dispatch is `Feature { folder: <recorded>, selection, feedback }` with identity
`FeedbackResume { resumed: Feature { feature, issues: [] }, resumedRunId }`; `resumedTask`'s
`Feature` case returns the folder and the recoverable ids instead of refusing. Base, PR, and
branch inherit as they do for every resume; feedback is never inherited.

That refusal is the last use of `FEATURE_MODE_UNIMPLEMENTED` (T76 retired the scope door's), and
since T76 its words — *feature mode is not implemented yet* — are false: feature mode runs, and
only its resume is refused. Removing the refusal removes the constant with it; nothing else in
`src/` imports it (T76's review).

### 3. The mode line

SPEC §7 says the mode line carries *whether the run resumes*, and `render.ts`'s `modeNamed` prints
a bare `feature` for every `Feature` plan — true until now only because every one was fresh (the
comment above it says so). A resumed feature plan prints **`resume (feature)`**, keyed off
`isResume(plan.identity)` as the spec arm's is. A fresh one still prints `feature`. The `issues`
row is unchanged: it lists the replayed ids.

### 4. Two stopgaps

Each holds a case a later ticket owns, refused rather than run wrong:

- **`--issues` beside `--resume` of a feature row refuses**, saying narrowing a resume is not
  built yet. The guard lets it through today (`featureStatedOnce`'s `onNone` arm), so without this
  the flag would be dropped in silence: a dispatcher who asked for `C` would get `[B, C]`.
  [T88](T88-issues-on-a-resume-only-narrows.md) replaces it with the subset rule. `OneOff` and
  `InlineTask` rows are T88's too; leave them as they are.
- **An exhausted set refuses** — every recorded id `approved`, nothing recoverable — with or
  without `--feedback`, in these words: *every issue of '<folder>' recorded on '<b>' is approved;
  say what to do with `--feedback`, or dispatch the folder afresh with `--feature … --issues …`*.
  [T89](T89-an-exhausted-resume-takes-feedback-as-its-task.md) makes the `--feedback` arm run.

### 5. Docs

SPEC §7's mode-line sentence gains `resume (feature)` — seven spellings.

## Effect wiring

- **Tags introduced or consumed**: none introduced.
- **Layer composition**: unchanged.

## Acceptance criteria

- [ ] `--resume b` over a row `[A approved, B needs-work, C not-attempted]` plans `[B, C]` in T69's
      order, reads the tip through the fake `IssueStore`, runs the loop over both, and writes
      `FeedbackResume { Feature { issues: [B …, C …] } }`; a second resume over that row plans
      what it left.
- [ ] `--resume b` where `B` is now `Done` at the tip refuses as the branch having moved under the
      record.
- [ ] `--dry-run --resume b` prints `resume (feature)` and the replayed ids, and writes nothing.
      A fresh `--feature` dispatch still prints `feature`.
- [ ] `--resume b --issues C` over a feature row refuses (§4); `--resume b` where every id is
      approved refuses with §4's words, with and without `--feedback`.
- [ ] `FEATURE_MODE_UNIMPLEMENTED` no longer exists.

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package.
