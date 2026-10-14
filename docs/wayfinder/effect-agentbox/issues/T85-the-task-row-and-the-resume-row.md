# T85 — The task row and the resume row

Status: Done (PR #47. "Every T81–T84 test passes unchanged" holds but for two source-row assertions that gained the two new labels. Both editors write a fixed filename under the runtime root, as `--feedback-edit` already did, so two concurrent pickers on one host share the file and the first to close removes it — a per-process name is the fix, unticketed; AGENTS.md still calls `--feedback-edit` the one write a rehearsal makes there. `Edit source` on a task reopens the editor empty. A walk through both rows on a real terminal is the hands-on check still owed)
Type: AFK
Blocked by: [T83](T83-the-feature-row-and-the-issues-step-read-at-the-tip.md), [T84](T84-the-editor-bracket-feedback-edit.md)

T83 is the source step's final shape and the edit rows; T84 the bracket both rows type into.

<!--
P3 (09 Q5). 22 ruled that a task typed inline is the picker's third row beside *pick a spec* and
*pick a feature*, entered through `--feedback-edit`'s editor bracket — one bracket, not two — and
T67 shipped the flag and left the row to P3. bash's fourth source entry is *Resume a run*
(`pick_resume`, `tasklib.py:1441`): a ledger submenu, then feedback. The port's resume inherits
its base (SPEC §7, 22's constants), so a resume pass has **no** branch, issues, or base step.
-->

## What to build

**The source step gains `Task typed inline` and `Resume a run`. The first opens the editor and
emits `--task "<text>"`; the second lists the ledger's newest run per branch, asks for optional
feedback through the same editor, and emits `--resume <branch> [--feedback "<text>"]`.**

### 1. The task row

Below the feature and spec rows. `editText` (T84) with a header saying the text is the task the
passes are for and that it is recorded verbatim on the ledger row (22). `EditorCancelled` returns to
the source step — a sub-prompt's cancel, bash's rule for exactly this entry — rather than aborting
the picker; every other cancel is still the one sentinel. The text is one argv word after `--task`;
the echoed command line quotes it. Then branch and base as for a spec; no issues step.

### 2. The resume row

1. `Ledger.recent` → newest record per branch, newest first, capped at ten
   (`_latest_per_branch`). A `select` with one row per record: `<branch> — <source> <outcome>
   <age>`, through `status/render.ts`'s cells so it reads as `status` does; `← Back`. An empty
   ledger is a row that says `no runs recorded yet` and returns to the source step (bash).
2. `Add feedback?` — a `confirm`; yes opens `editText` with the feedback header; an empty result is
   *no feedback*, not a cancel (bash's one deliberate exception, `pick_resume`'s docstring).
3. Words: `--resume <branch>`, plus `--feedback "<text>"` when there is one. No `--branch`, no
   `--base`: the resume recovers both (SPEC §7).

The summary shows the resumed branch and the feedback; its edit rows are `Edit source` only — no
branch, issues, or base step ran. Everything after `Dispatch` is T16's and T78's: the recorded set
filtered by outcomes, the feedback-only run when it is exhausted, every refusal in their words.

### 3. Docs

- SPEC §7's `--task` row: *At P3 the picker offers it as a third row* → ships (T85).
- SPEC §7's *no args on a TTY* row: the four source rows, complete.
- `AGENTS.md`, *The TTY*: one bullet ending `(T85)` — **a resume pass asks no branch, issues, or
  base step**; a picker that re-asks the base for a resume typechecks and emits a `--base` the
  resume arm then overrides in silence.

## Effect wiring

- **Tags introduced or consumed**: none introduced. `Ledger.recent`, `editText`'s requirements.
- **Layer composition**: unchanged from T81.

## Acceptance criteria

- [ ] Script: `Task typed inline`, scripted editor writing `add the missing guard`, branch `b`,
      Enter on base, `Dispatch` — words `["--task", "add the missing guard", "--branch", "b"]`; the
      note's command line quoted the text.
- [ ] Script: `Task typed inline`, editor left empty — the source step runs again.
- [ ] Script: `Resume a run` over a fake ledger with three rows on two branches — two rows offered,
      newest first, the branch with two rows shown once with its newer record; choosing one and
      declining feedback emits `["--resume", "<branch>"]`; accepting and writing text emits
      `--feedback` with it; accepting and leaving it empty emits no `--feedback`.
- [ ] Script: `Resume a run` over an empty ledger — the *no runs* row, and the source step again.
- [ ] A resume pass's summary offers `Edit source` and no other edit row.
- [ ] Every T81–T84 test passes unchanged.

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package.
