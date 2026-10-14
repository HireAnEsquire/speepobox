# T81 — No args on a TTY picks a spec and a branch

Status: Done (PR #40; hands-on Verify passed 2026-09-22 — ranking, focus across a backspace, Esc and Ctrl-C. §5's zero-`data`-listener criterion is unmeetable: node's keypress decoder installs one per stream and never removes it, so the test pins it as constant across prompts. Nothing asserts `maxItems` reaches clack. A bare `bessemer` on a terminal in a repo with no tasks dir now refuses rather than printing usage. The review found and fixed two clack behaviours the ticket did not foresee: Enter on a query with no enabled match resolved `undefined` as the branch, and a row value allocated per keystroke lost focus on every edit)
Type: AFK
Blocked by: [T80](T80-the-fuzzy-scorer-is-a-pure-module.md) — the ranking the branch step types against.

<!--
P3 (09 Q5), the picker's spine and the package's **first TTY surface**: no `isTTY`, no stdin read,
no `@clack` import exists in `src/` today (`@clack/prompts 1.7.0` is pinned in `package.json` and
unused). 13's verdict is the build constraint, not a suggestion: options getter + pass-through
`filter` (T80's scorer), clack-native cancel with `← Back` rows, and the interrupt bracket as
`Effect.promise((signal) => …)` into clack's `signal` option — AGENTS.md's *The TTY* section
already carries all three.

The picker's 138 bash tests were ruled untranslated (12). This ticket is where the package learns
to test a prompt: the wizard runs on a scripted `Prompt` fake in the fake tier, and the one thing
the fake cannot hold — that the live bracket unwinds on interrupt — is a fake-tier test too,
because clack takes `input`/`output` streams (`@clack/core`'s `CommonOptions`), so the prototype's
`wedge.mjs` scenario C runs over a `PassThrough` under `npm run verify`. What stays hands-on is
feel: ranking, keyboard, and the raw-mode wedge on a real terminal (13).

What the picker produces is **argv**, never a plan: bash's `key=value` lines land in the same
variables the flag loop sets (`run.sh:744-771`), and the port does the same by handing the words
to `dispatchCli`, so every guard, the `--repo-root` peel, and `VALUE_OPTION_NAMES` are untouched.
A `DispatchRequest` built by hand typechecks and skips the parser — AGENTS.md gets that line.

ADR 0005's carve-out — the picker may create a missing branch — is **deliberately unexercised**
(decided 2026-09-22): SPEC §7 says `--branch` must exist, the port has no creation path, every
hand-off already opens with `git branch --no-track`, and a host write before the lock is exactly
what matrix row 1 forbids. The prototype's `+ create` row is not ported; §12 records why.
-->

## What to build

**`bessemer` with no arguments on a TTY asks which spec, then which branch, shows the equivalent
command line, and on `Dispatch` runs it through `dispatchCli` exactly as if typed. Off a TTY it
prints usage as today. `bessemer --dry-run` alone does the same and rehearses.**

### 1. The `Prompt` tag (SPEC §2)

`src/prompt/prompt.ts`. `PromptShape` in our vocabulary, not clack's: `select`, `autocomplete`
(options as a **getter** of the query — the caller ranks and orders, the tag never filters),
`multiselect` (with a preselected set), `confirm`, `text`, and `note`. Every ask returns
`Effect<A, PromptCancelled>`; `PromptCancelled` is a `Data.TaggedError` and is the one way Esc
and Ctrl-C come back — one sentinel, per 13. A row is `{ value, label, hint?, disabled? }`.

`PromptClackLive` (`src/prompt/clack.ts`) wraps each call as `Effect.promise((signal) =>
clack.x({ ...options, signal }))`, maps `isCancel` to `PromptCancelled`, and for `autocomplete`
passes `filter: () => true` beside the getter. That file is the **only** importer of
`@clack/prompts` and, with `ReporterConsoleLive`, the only writer to stdout in `src/`; the
`check-bans` script gains the import ban. The layer is provided to the picker only — `appLiveFor`
and `appBaseLiveFor` are unchanged, so no dispatch, `status`, or `doctor` acquires a prompt.

`scriptedPrompt(answers)` in `test/support/prompt-fake.ts` answers asks in order, records every
question (message and the rows it offered, so a test asserts what was disabled and in what order),
and answers `Cancel` where the script says so. A script that runs out fails the test.

### 2. The gate and the entry

`Terminal.isTTY` from `@effect/platform` — already in `dispatchCli`'s requirements and stubbed in
three tests — is the gate; no `process.stdin` read anywhere. The `case undefined:` arm in
`src/bin.ts` (usage today) becomes: on a TTY, run the picker and hand its argv to the dispatch arm;
otherwise usage, unchanged. An argv that is **only** `--dry-run` counts as no args (bash's
modifier rule, `run.sh:752`), and the word rides through to `dispatchCli` — the picker module never
spells it, by `check-bans`' existing rule for that token. Everything but the switch lives in an
importable module (`src/picker/picker.ts`): AGENTS.md's rule that nothing in `bin.ts` is
assertable.

### 3. The steps

Source: one `select` — every `*.md` under the tasks dir (`resolveTasksDir`; host `FileSystem`,
the spec is inert and mounts from the host, SPEC §7) as a bare name, newest-modified first. First
step, so no `← Back`; Esc aborts. Feature rows are T83's; task and resume rows are T85's.

Branch: one `autocomplete` over **all** local branches — 13's shape, not bash's curated two-tier
menu. `Git` gains `branches({ repo })` → `{ name, committedAt }` from one `for-each-ref` over
`refs/heads/` (a sibling of `forEachRef`, which carries no dates). At rest the order is recency,
newest first; while typing it is `rankFuzzy`'s order with ties toward recency. Every branch any
worktree has checked out (`Git.worktrees`, the guard's own source) and every protected name
(`master`, `main`) is a **disabled** row prefixed `⛔ CHECKED OUT — ` / `⛔ PROTECTED — ` — 13's
accepted divergence: disabled, not pickable-then-refused. The hint is the age, and for a branch the
ledger knows (`Ledger.recent`), its newest row's outcome and PR number. `← Back` is the first row
at rest.

`rankFuzzy` returns **every** in-order match, with no score floor and no cap (T80's review): over a
few hundred local branches a two- or three-letter query matches most of them, and the order among
the weak matches is noise. Bounding what the step shows is this ticket's call — clack's
`maxItems` bounds the visible rows without changing the ranking, and a floor would change what
`rankFuzzy` means for every caller, so a floor belongs in T80's module and its tests, not here.
The marquee case is also thin: `tsf` puts `tseff` first by one point, so a scorer tweak that
reorders it is a red test rather than a judgement call.

Summary: a `note` with the choices and the **equivalent command line** — `bessemer <spec>
--branch <b>` (`--dry-run` appended by the entry when it was given), shell-quoted, bash's
copy-paste parity (`run.sh:48`) — then a `select`: `Dispatch` / `← Back` / `Abort`. Base is not
asked here (T82); the run takes the default chain as a flag invocation would.

`Dispatch` calls `dispatchCli` with those words. Every refusal after that is the dispatch's, printed
as today; the picker does not re-open (T86 is where flags and refusals re-enter steps).

### 4. Cancel

`PromptCancelled` anywhere, or `Abort`, prints `!! picker cancelled` to stderr and exits 1
(`tasklib.py`'s line; `run.sh:756` exits 1 on it). Not 130: clack holds raw mode while a prompt is
open, so Ctrl-C arrives as the sentinel and not as a signal.

### 5. The bracket's test

`test/prompt-clack.test.ts`: `PromptClackLive` with a `PassThrough` `input` and `output`, a
`select` forked, the fiber interrupted: the effect ends interrupted rather than hanging, and the
input stream has zero `keypress` and `data` listeners afterwards — the prototype's scenario C, and
the regression that would otherwise be silent and terminal-wedging. The raw-mode wedge on a real
tty is the hands-on Verify line below.

### 6. Docs

- SPEC §7's dispatch-forms table, the *no args on a TTY* row: strike **P3**; the picker's spine
  ships here, feature/task/resume rows follow (T83, T85).
- SPEC §2's `Prompt` row: built (T81); the tag's operations and the argv-not-plan rule in one
  sentence.
- SPEC §12's divergence list gains three: the checked-out and protected branches are **disabled
  rows** rather than refused after the pick; focus survives a backspace-clear (13); **ADR 0005's
  create-a-branch carve-out is deliberately unexercised**, with the four reasons in the comment
  above, marked `dropped`.
- `AGENTS.md`, *The TTY*: one bullet ending `(T81)` — **the picker's product is argv handed to
  `dispatchCli`, never a `DispatchRequest` built in place**; the built one typechecks and skips
  the parser's peel, `VALUE_OPTION_NAMES`, and every argv guard.

## Effect wiring

- **Tags introduced or consumed**: `Prompt` introduced (`src/prompt/prompt.ts`), live layer
  `PromptClackLive`, fake `scriptedPrompt`. `Git` gains `branches`; `Git`, `Ledger`, `Terminal`,
  `FileSystem` consumed by the picker.
- **Layer composition**: `appLiveFor` / `appBaseLiveFor` unchanged. The picker runs under
  `Layer.provideMerge(PromptClackLive, appBaseLiveFor(repoRoot))` in `bin.ts` — the read-only
  slice, since it reads the ledger and git and acquires nothing — and its argv then runs under
  `appLayerFor(argv, repoRoot)` as any dispatch does. Tests provide `scriptedPrompt(...)` beside
  `fakeGit` (with `worktrees` and the new `branches` option), the `Ledger` fake, and a
  `Terminal` stub with `isTTY: true`.

## Acceptance criteria

- [ ] On the fake tier with `isTTY` true and a script answering `T3` then `bessemer-t3` then
      `Dispatch`: the words `["T3", "--branch", "bessemer-t3"]` reach `dispatchCli`, the summary
      note carried that command line, and the recorded branch rows were in recency order with the
      worktree's branch and `main` disabled.
- [ ] With `isTTY` false, no prompt is asked and usage prints, as today.
- [ ] A script answering `Cancel` at any step: `!! picker cancelled`, exit 1, no call to
      `dispatchCli`, nothing under the runtime root.
- [ ] `--dry-run` alone on a TTY: the picker runs and `--dry-run` is among the words handed on.
- [ ] `PromptClackLive` over a `PassThrough`: an interrupted prompt ends and leaves no listener on
      the input (§5).
- [ ] `check-bans` refuses `@clack/prompts` imported outside `src/prompt/clack.ts`.
- [ ] Every existing dispatch, status, and doctor test passes unchanged; `appLiveFor` and
      `appBaseLiveFor` are byte-unchanged.

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package.

Host-only, hands-on (13's remaining checks): `node src/bin.ts` on a terminal — typing `tsf`-style
queries ranks rather than substring-matches; Esc and Ctrl-C each print the cancel line and leave
the terminal usable; Ctrl-C **during** a prompt leaves no zombie prompt eating keys.
