# T84 — The editor bracket: `--feedback-edit`

Status: Done (PR #37; the first criterion's *`--dry-run` prints it* is unmet — the plan carries the text, but `renderPlan` has no feedback row for this flag or for `--feedback`, so SPEC §7's *the printed plan carries it as `--feedback`'s would* is true only because neither prints; and a rehearsal on a host whose runtime root does not exist yet makes the directory to hold the file and leaves it behind when the file goes, against T48's *writes nothing to the runtime root at all*)
Type: AFK
Blocked by:

<!--
P3 (09 Q5). T17 deferred `--feedback-edit` to the post-move sequence — *TTY-only, so an AFK dispatch
cannot exercise it* — and left a note for whoever picks it up: its temp file is one of the two
untrapped windows SPEC §4 says close for free under `Scope`. 22 then ruled that the picker's task
row enters through **this** bracket, one editor flow for both, and the resume row's feedback (T85)
rides it too. So the bracket lands first, as a flag with its own green, and T85 consumes it.

TTY-gated like T81 (`Terminal.isTTY`), but not a prompt: it spawns the editor with the terminal
inherited. Every entry in the exec chokepoint captures output today, so this ticket adds the one
that does not — inside `src/internal/exec.ts`, where `Command` may be named, and nowhere else.
-->

## What to build

**`bessemer <spec> --branch <b> --feedback-edit` opens the dispatcher's git editor on a
commented template, strips the comments, and dispatches with the text as `--feedback` — refused
with `--feedback` (two texts), refused off a TTY, and aborted before anything is held when the text
is empty.**

### 1. The flag

`Options.boolean("feedback-edit")` in `dispatch/command.ts`; `DispatchRequest` gains
`feedbackEdit: boolean`. Argv-only refusals in `taskStatedOnce`'s slot, before anything asks the
world: beside `--feedback` — *two texts; state one* (T67 row 12's shape); beside `--task` — the
same, since `--task` refuses `--feedback` already. Not a value option, so `VALUE_OPTION_NAMES` is
untouched.

Off a TTY the refusal is bash's line verbatim (`run.sh:740`): `--feedback-edit requires a TTY (it
opens an editor) — non-interactive dispatch: use --feedback <text> instead`. A `GuardRefused`; the
gate is `Terminal.isTTY`.

### 2. The bracket

`editText({ header, filename }): Effect<string, EditorCancelled | ExecError, Git | FileSystem |
CommandExecutor | Terminal | Scope>` in `src/prompt/editor.ts`, reused by T85:

1. The editor is `git var GIT_EDITOR` in the served repo — a `Git` operation, `editor({ repo })`,
   so `core.editor`, `GIT_EDITOR`, `VISUAL`, `EDITOR`, and git's `vi` fallback resolve as git
   resolves them, not as a hand-rolled chain would.
2. The file is under the runtime root (`<runtimeRoot>/<filename>`), created and **removed by a
   `Scope` finalizer** — T17's note: the leak bash has is closed by construction, and the finalizer
   never fails the scope (design rule 4).
3. It is pre-filled with the header, every line prefixed `# `, git-commit style: what the text is
   for (`feedback for '<branch>'`), and that lines starting with `#` are stripped and an empty
   result aborts.
4. The editor runs through a new `execInteractive` in the chokepoint with stdin, stdout, and stderr
   **inherited** — the one entry that does — and its non-zero exit is `EditorCancelled`.
5. The text is read back, `#` lines dropped, trimmed. Empty is `EditorCancelled` too.

`EditorCancelled` is a `GuardRefused` at the dispatch: *empty feedback — aborted before any
container started* (bash's rule). It runs where `--feedback`'s value is read — before the fetch,
before any git call but the editor lookup — so nothing is held and no row exists.

`--dry-run --feedback-edit` opens the editor: the text is the dispatcher's input, and the printed
plan carries it as `--feedback`'s would.

### 3. Docs

- SPEC §7's `--feedback-edit` row: ships (T84); the file lives under the runtime root and dies
  with the scope.
- `AGENTS.md`, *The TTY*: one bullet ending `(T84)` — **the editor is the one child that inherits
  the terminal**, through `execInteractive` and nothing else; a captured-output entry with the
  editor's argv typechecks and hangs on a terminal nobody is shown.

## Effect wiring

- **Tags introduced or consumed**: none introduced. `Git` gains `editor`; `CommandExecutor`
  gains one call site in `exec.ts`; `Terminal`, `FileSystem` consumed.
- **Layer composition**: unchanged. Tests script the editor as a `scriptedExecutor` entry that
  writes the file it is handed as its last argument, with the `Terminal` stub's `isTTY` true.

## Acceptance criteria

- [ ] `--feedback-edit` on a TTY with a scripted editor that writes two comment lines and
      `use the smaller diff`: the plan's feedback is `use the smaller diff`, the temp file is
      gone after the run, and `--dry-run` prints it.
- [ ] A scripted editor that leaves only the header: refused with the empty-feedback line, no lock,
      no row, no log, file gone.
- [ ] A scripted editor exiting non-zero: refused, file gone.
- [ ] Off a TTY: bash's sentence, before any git call.
- [ ] `--feedback-edit --feedback x` and `--feedback-edit --task "…"` each refuse from argv alone.
- [ ] `git var GIT_EDITOR` is what the fake `Git` was asked; no `EDITOR` read exists in `src/`.

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package.

Host-only, hands-on: `node src/bin.ts T3 --branch <b> --dry-run --feedback-edit` on a terminal
opens your editor; save with text → plan printed with it; quit without text → the abort line.
