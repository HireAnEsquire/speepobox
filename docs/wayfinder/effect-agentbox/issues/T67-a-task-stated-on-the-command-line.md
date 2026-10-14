# T67 — A task stated on the command line

Status: Done (PR #27; the 40-char summary is cut again to 32 by status's own SOURCE column, so the banner and the cell still show different amounts — and the pre-parse --repo-root peel needed --task in VALUE_OPTION_NAMES, which §1 did not name)
Type: AFK
Blocked by: [T66](T66-the-task-is-one-union-and-resuming-is-the-identitys-fact.md) — the
`Inline` arm, the identity-keyed resuming framing, and the every-resume PR context this ticket
reaches through are built there. Nothing in this ticket waits on P2's feature mode or P3's picker;
the picker's third row is P3's to add when the picker exists (22 §2, 09's comment of 2026-09-21).

<!--
[Ticket 22](../22-a-dispatch-that-carries-a-prompt-and-no-spec.md), resolved 2026-09-21: a
dispatch may state its task on the command line, and that is a task like any other. The chart in
22 §6 is the specification; every row number below is a row of that chart. Constants from the same
section: `--branch` is required on every fresh dispatch and must exist; a resume implies it.
`--base` on a fresh dispatch is the ledger's last base then the configured base; on a resume it is
inherited. Feedback is never inherited.
-->

## What to build

**`bessemer --branch <b> --task "…"` runs the one-off path end to end — every guard, the lock, the
checkout, the three passes, the PR — with the text as what the passes are for, nothing mounted at
`/spec.md`, and the text recorded verbatim on the ledger row so `--resume` replays it.** Not a
mode, not an entrypoint, not an empty selection: one branch, one container, one PR, exactly as a
spec run is.

### 1. The flag (row 3)

`--task <text>`, optional at the parser and refused by guards (T3's rule: the parser parses, the
guards refuse). Its help line says what the glossary says: *the task, stated inline instead of as a
spec file; refused beside `<spec>`, `--resume`/`--last`, or `--feedback`*.

**The text is never a word of any command line.** It reaches the agent on the stdin prompt pipe as
`--feedback` does (T17's property), so quotes, backticks, and `$(…)` arrive literally. It is trimmed
and emptiness-filtered **once**, at the door beside `feedbackGiven`, so "was a task stated" has one
answer everywhere below.

### 2. The four refusals (rows 10–13)

Each is a `GuardRefused` before the lock, holding nothing and writing no ledger row (SPEC §11,
matrix row 1), in the guard sequence at the point `specGiven` runs today:

| Row | Spelling | Refuses because |
| --- | --- | --- |
| 10 | `--task "x" my-spec --branch b` | two tasks — a spec and inline text; state one |
| 11 | `--task "x" --resume b` (and `--last`) | a resume replays its record (15); a new task on that branch is a fresh dispatch on `--branch` |
| 12 | `--task "x" --feedback "y" --branch b` | two texts — the task already says what to do; feedback is for a spec or a resume |
| 13 | `--task "" --branch b` (or whitespace) | an empty task, refused as such — **not** as "a spec is required", which would send a dispatcher who typed the flag to look for a file |

`specGiven`'s own message widens to name the third spelling: *a task is required — pass `<spec>`,
`--task "…"`, or `--resume <branch>`*. `--feature` is untouched: its tasks are issues (P2).

### 3. The plan and the identity

A fresh `--task` dispatch resolves to `Inline { text, feedback: none }` on the plan and a **third
`DispatchIdentity` arm** carrying the text verbatim on the ledger row — recommended name
`InlineTask { task: string }`; not `Task` (the plan union) and not `OneOff` with an optional field
(the nullable pair T2 deleted). The row is written by the finalizer whatever the outcome, as every
row is.

`CURRENT_SCHEMA_VERSION` **stays 1** (T31's rule): every version-1 line already on disk still reads
as itself, because a union grew an arm and no existing line's shape changed. `FeedbackResume.resumed`
admits the new arm through the union it already wraps; the legacy adapter is untouched, since bash
never wrote one. The one thing the unchanged number does not buy is the other direction: a row
carrying the new arm fails to decode under a bessemer older than this ticket, which bites only a
rollback of the tool against a ledger it has since written to — accepted, and named here so nobody
reads the constant as a promise about older readers.

### 4. Resume replays it (rows 8–9)

`resumedSpec` (`dispatch/resume.ts`) becomes the read of the recorded *task*: a `OneOff` still goes
through T16's decision table (is the spec on disk; was feedback given); an `InlineTask` goes
straight to `Inline { text: <recorded>, feedback }` — the text cannot be gone from disk, so the
table's *gone* arm never fires for it and 15's feedback-only derivation is unreachable on this arm.
`--feedback` on that resume is appended, exactly as on a spec resume. A `Feature` is refused as
today. The identity written is `FeedbackResume { InlineTask }`, and T66's resuming sentence and PR
context arrive through the identity with nothing added here.

### 5. What the screen says

- **`status`** (`status/render.ts`): the source cell for an `InlineTask` reads `task: <summary>`, where
  the summary is the text's first line cut to about 40 characters with an ellipsis when cut; a resume
  keeps its `resume:` prefix. The full text stays on the row and in the run log.
- **The plan render** (`dispatch/render.ts`): the banner names the task the way the cell does —
  the spec path on `Spec`, the summary on `Inline` — and the block gains the **mode line SPEC §7:428
  has specified and nothing has rendered**: *one-off (spec)*, *one-off (inline task)*, *resume
  (spec)*, *resume (inline task)*, and *resume (feedback stands in for the missing spec)* for row 6,
  which the renderer can tell from row 8 by the identity underneath the `FeedbackResume`. §7 names
  a sixth, *feature*; that one is P2's and this ticket prints nothing for it, since no `Feature`
  plan reaches the renderer until P2 exists. **One
  summary function, two call sites** — the cell and the banner must not drift on how much of the
  text they show.
- **`--dry-run --task "…"`** rehearses the whole dispatch and writes nothing (T15/T48): the plan
  block with the mode line, the assembled prompts logged to the console with the text in the task
  section, no ledger row.

### 6. Docs that follow

- SPEC §7 already carries the `--task` row and the mode-line sentence with its six spellings (22's
  deliverable 2, amended in the `/to-tickets` pass of 2026-09-21). The renderer prints the first
  five verbatim; §7 is what this ticket is checked against and is not the round's to amend.
- `AGENTS.md`, under *Guards*: one bullet for the four refusals, ending `(T67)`, naming the shape
  that typechecks and is wrong — an empty `--task` falling through to *a spec is required*. Under
  *The agent passes and the review*: the ledger arm carries the text and the version does not bump,
  with T31's rule as the reason.
- `CONTEXT.md` needs nothing: *Task*, *Spec*, *Feedback*, and *Prompt* were written by 22.

## Effect wiring

- **Tags introduced or consumed**: none introduced. `Ledger` writes and reads the new identity arm
  through `RunRecord` as it does the others; `Forge` is consumed on a resume by T66's predicate.
- **Layer composition**: unchanged. `app.ts` is not touched. The `@effect/cli` command in
  `dispatch/command.ts` gains one `Options.text("task")` beside `feedback`, and `DispatchRequest`
  one `task: Option<string>` field.

## Acceptance criteria

- [ ] `--branch b --task "x"` (row 3) runs the one-off path: every guard, the lock, the checkout, the
      three passes, the PR; nothing is mounted at `/spec.md`; the implement, review, and describe-PR
      messages carry `x` in the task section and no resuming sentence; the fake forge records no
      `prView` call; the ledger row's identity is the inline arm carrying `x` verbatim.
- [ ] A task containing quotes, backticks, and `$(…)` reaches the agent's stdin byte for byte and
      appears in no command the fake `CommandExecutor` records.
- [ ] Rows 10, 11 (both `--resume` and `--last`), 12, and 13 each refuse with a `GuardRefused` naming
      the collision in the table's words, before the lock, with no ledger row and no log file.
- [ ] `--branch b` with neither `<spec>` nor `--task` refuses naming all three spellings.
- [ ] `--resume b` where `b` last ran `--task` (row 8) replays the recorded text: the plan is
      `Inline { text }`, the identity `FeedbackResume { InlineTask }`, the messages carry the text,
      the resuming sentence, and the PR context section when the view succeeds. With `--feedback`
      (row 9) the feedback section follows the task section.
- [ ] A row written before this ticket (every fixture in `test/status.test.ts` and
      `test/ledger.test.ts`) decodes unchanged, and `CURRENT_SCHEMA_VERSION` is still `1`.
- [ ] `status` shows `task: <summary>` for an inline run and `resume:task: <summary>` for its resume,
      with a multi-line task cut to its first line and an over-long first line cut with an ellipsis.
- [ ] `--dry-run --task "x"` prints the plan block with a mode line reading *one-off (inline task)*
      and writes nothing under the runtime root; `--dry-run` of a spec run prints *one-off (spec)*;
      a rehearsed row-6 resume prints the feedback-stands-in spelling.
- [ ] `node src/bin.ts --help` lists `--task` with the help line in §1.

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package.

```
node src/bin.ts --help | grep -- "--task"
```

Plain node, no vitest transform — the distribution-model check the gate cannot make (06).
