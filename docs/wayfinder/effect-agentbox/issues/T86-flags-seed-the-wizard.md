# T86 — Flags seed the wizard

Status: Done (PR #51. `AnswerMissing` subclasses `GuardRefused` and keeps its `_tag`, caught in `bin.ts` by `instanceof` rather than standing as SPEC §3's separate error: it renders as a refusal with no extra code, and a `catchTag("GuardRefused")` placed ahead of `bin.ts` would swallow it and stop the picker opening. None exists. The error's `step` field is set and never read. Two gaps the PR leaves: a seed drops an empty `--base ""`, and after `← Back` a step a flag answered is asked again. The PR's manual TTY checks 3–5 are the hands-on walk-through still owed)
Type: AFK
Blocked by: none. T85, the last step it pre-answers, is done.

<!--
P3 (09 Q5), last. 09's comment of 2026-08-07 recorded this as P3 design input after close:
*partial-args*. Every flag given pre-answers its wizard step, the wizard runs each step
skip-if-answered, every run lands on the summary, and the TTY gate plus a `--no-input` escape
hatch keep the command scriptable. 15 §1 deferred softening *refuse, don't prompt* until the
picker existed, and 22 read it the same way.

Triaged 2026-09-23 with the operator. SPEC §7's **Flags seed the wizard** paragraph, the
`--no-input` flags row, the `--issues` row's T86 clause, and the `AnswerMissing` row in §3's
error table were written during triage and are the contract. Four rulings changed the draft:
(1) only a *missing* answer opens the picker. The draft's re-entry on T73 §3's folder-not-on-branch
refusal is dropped: that refusal fires after the fetch, on a command line that was complete, and
the picker's issues step already shows the same sentence whenever `--issues` was left out.
(2) The step words are rebuilt from the answers, not appended to what was typed, since a flag
answer edited in the picker would otherwise appear twice. (3) The source step hides rows the typed
flags would make the dispatch refuse. (4) `--last` names its own branch (`resume.ts`), so it never
opens the picker.
-->

## What to build

**On a terminal, a command line missing an answer opens the picker with every typed flag already
answered, and asks only what is missing. Off a terminal, or with `--no-input`, every refusal
stays as it is today.** SPEC §7's *Flags seed the wizard* paragraph states the whole rule. This
section says where each part goes.

### 1. `AnswerMissing`

The three refusals that mean an answer is missing become a new typed error, `AnswerMissing`. It
carries the step it wants (`source`, `branch`, or `issues`), the parsed request, and `detail`, the
exact line today's refusal prints:

- **source**: `specGiven`'s refusal (nothing says what the run is for), and `featureStatedOnce`'s
  arm where `--issues` stands alone with no feature or resume for it to narrow.
- **branch**: `branchGiven`'s refusal, on a dispatch that is not a resume.
- **issues**: `featureStatedOnce`'s arm where `--feature` has no `--issues`.

Every other refusal stays a `GuardRefused`, word for word: each two-of-something collision, each
flag typed with nothing in it (T67, T87), and everything after the fetch. Apply the outcome-row
test (AGENTS.md): `AnswerMissing` is raised before the lock and writes no row. Where it is not
caught, `renderFailure` (`dispatch/render.ts`) renders it exactly as a `GuardRefused`, so it
prints the same line and exits 1.

No git and no editor may run before any `AnswerMissing`. Today, `--feedback-edit` opens its editor
between `branchGiven` and `specGiven`. Decide that no source is missing before the editor opens.
`specGiven` reads only argv, so it can move up to sit beside `branchGiven`.

### 2. The entrypoint catches it

The dispatch surface's arm in `bin.ts` catches `AnswerMissing` and hands its request to the
picker. Off a terminal the picker answers `None`, as T81's gate already does, and that `None`
reports the refusal the error carried. Keep this logic out of `bin.ts` itself, since nothing
there can be asserted (AGENTS.md): the decision belongs in `picker/picker.ts`, or in a module
beside it, and the `picked` wiring only needs to accept a seed. With `--no-input`, the error is
reported and the picker is never asked. The flag is `Options.boolean("no-input")` in
`dispatch/command.ts`, so it rides on the request. It is not a modifier, so `isModifiersOnly`
stays unchanged.

The picker's layers stay where T81 put them, provided in `picked` and nowhere else.
`appLiveFor`, `appBaseLiveFor`, and `dispatchCli`'s requirements do not gain `Prompt`.

### 3. The seeded wizard

`PickRequest` gains an optional seed, built from the parsed request. It is the source (a spec,
a feature folder, or a typed task), the branch, the issues, and the base, as typed. From it:

- **The starting draft**: each typed answer fills its step. A feature seed is the
  `FeatureSource` row for that folder, so an edit finds it again with `===`. A spec or folder
  that has no row in the list (a path given outside the tasks dir) still reaches the words
  unchanged.
- **Skipping answered steps**: the first pass runs every step that `applies` and that the seed
  did not answer. Later edits and `← Back` behave as T82 built them: they re-run a step, even one
  a flag answered, with the cursor on the answer it had.
- **Filtering the source rows**: typed `--issues` leaves only the feature rows; typed `--branch`
  or `--base` hides `Resume a run`; typed `--feedback` or `--feedback-edit` hides
  `Task typed inline`.
- **The base**: a typed `--base` stays in the words even when it equals the default the ledger
  and config would pick (`chainFor`), because the dispatcher typed it.
- **The words**: `argvFor` and `resumeArgvFor` build the step words from the draft, as they do
  now. Then the flags that are not steps are added back, rendered from the request:
  `--feedback`, `--feedback-edit`, `--allow-stale-dispatcher`, and `--dry-run`, which becomes a
  modifier, so `appCompositionFor` still sees it. The result goes to `dispatchWords` for a
  second full parse.

### 4. Docs

- `AGENTS.md`, under *The TTY*: add one bullet ending `(T86)`. It says that **only a missing
  answer opens the picker; two of something and a wrong value are refused, never asked about.**
  The wrong shapes, which both typecheck, are a question offering to drop one of two tasks, and
  catching a `GuardRefused` by matching its `detail` text instead of raising `AnswerMissing`.
- 09's P2 paragraph and 15 §1 each get a one-line comment: the softening landed in T86, and the
  refusal off a terminal is unchanged.
- SPEC §7 already carries the rule. Change it only if the build contradicts it, and say so in the
  PR.

## Effect wiring

- **Tags introduced or consumed**: none introduced. `AnswerMissing` is an error, not a tag.
- **Layer composition**: unchanged. The picker keeps
  `Layer.provideMerge(Layer.merge(PromptClackLive, IssueStoreLive), appBaseLiveFor(repoRoot))`,
  as `bin.ts`'s `picked` has it now. Quote the resulting `bin.ts` wiring in the PR description.

## Acceptance criteria

- [ ] `T3` alone on a TTY: the branch step opens and nothing before it runs. The summary shows
      `T3`, and the words carry `T3` once. Off a TTY: `branchGiven`'s refusal, verbatim, exit 1.
- [ ] `--branch b` alone on a TTY: the picker opens at the source step, skips the branch step,
      and the summary shows `b`. The words carry `--branch b` once.
- [ ] `--feature f --branch b` on a TTY: the issues step opens at `b`'s tip. Off a TTY, or with
      `--no-input`, T73's *name the set* refusal, verbatim.
- [ ] `--issues 01 --branch b` on a TTY: the source step lists only feature rows.
- [ ] `--base x --branch b` on a TTY: the source step has no `Resume a run` row, and the words
      carry `--base x` even when `x` is the default.
- [ ] `--feedback "y" --branch b` on a TTY: no `Task typed inline` row, and the words carry
      `--feedback y` once.
- [ ] `Edit branch` from a summary reached with `--branch b` re-runs the branch step with the
      cursor on `b`. Picking `c` there gives words carrying `--branch c` and no `--branch b`.
- [ ] `--dry-run --branch b` seeded and dispatched: the words carry `--dry-run`, and the
      rehearsal composition runs.
- [ ] `--task "x" T3 --branch b` on a TTY: refused as two tasks, with no prompt asked.
- [ ] `--feature f --issues all --branch b`, where `b`'s tip lacks `f`, on a TTY: T73 §3's
      refusal, with no prompt asked.
- [ ] `--feedback-edit` with no source, on a TTY: the picker opens before any editor does.
- [ ] Every missing answer on a TTY with `--no-input`: today's refusal, verbatim, with no prompt
      and no git call.
- [ ] Every T81–T85 test and every existing dispatch test passes unchanged.

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package.
