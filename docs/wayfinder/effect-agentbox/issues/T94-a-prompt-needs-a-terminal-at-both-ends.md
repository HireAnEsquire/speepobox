# T94 — A prompt needs a terminal at both ends

Status: Done (PR #57. The stdin fact is read in `bin.ts` and threaded through every composition; `test/terminal.test.ts` pins the override order. The manual `</dev/null` check passed on a terminal 2026-09-23.)
Type: AFK
Blocked by: none.

<!--
From the P3 picker walk-through, 2026-09-23. `node src/bin.ts --branch some-branch </dev/null`
opened the picker at the source step. It should have printed `specGiven`'s refusal and exited 1,
as T86's PR claimed in its manual step 3, which nobody had run. bash gates every prompt on
`[ -t 0 ]` (`run.sh:752`, `run.sh:1296`): whether stdin is a terminal. The port's gate is
`Terminal.isTTY`, and `@effect/platform-node-shared`'s terminal answers that from
`stdout.isTTY` alone. So a redirected stdin with the screen still attached reads as a terminal.
-->

## What to build

**A prompt opens only when stdin and stdout are both terminals.** With stdin redirected, the
picker asks nothing and `--feedback-edit` refuses, exactly as they do today with stdout
redirected.

### 1. The gate answers for both ends

The two gates stay as they are: `pickerArgv`'s (`picker/picker.ts`) and `--feedback-edit`'s
(`dispatch/guards.ts`). Both ask `Terminal.isTTY`, and every test stubs that tag. What changes
is what the live tag answers.

- `bin.ts` reads `process.stdin.isTTY` once. This is a host read, and it lives at the composition
  root (AGENTS.md, *Host reads live at the composition root*).
- The value reaches `app.ts` as a parameter. `PlatformAndReporterLive` becomes a function of it.
  That function replaces `NodeContext.layer`'s `Terminal` with one whose `isTTY` is the platform's
  answer **and** the stdin fact. Every other member of the platform's `Terminal` is passed
  through unchanged.
- Every composition built on `PlatformAndReporterLive` gains the parameter:
  - `appBaseLiveFor`, `appLiveFor`, and the rehearsal composition in `app.ts`;
  - every call site in `bin.ts`, including `picked`.
- Put the resulting `app.ts` compositions in the PR description.

No `process.stdin` read goes anywhere except `bin.ts`. Keep the gates asking the tag: threading a
boolean into `pickerArgv` and the guard also typechecks, but it leaves one question with two
answers.

### 2. Pin it

Build `PlatformAndReporterLive` over a stdin fact of `false` and assert that `Terminal.isTTY`
answers `false`. Do the same with `true` and assert it answers what the platform says. A test
file can build the layer directly without running the CLI.

These tests catch a real risk. If the layer is composed the wrong way round, the platform's
`Terminal` wins, the override does nothing, and the code still typechecks.

### 3. Docs

- SPEC §7's *no args on a TTY* row says *The gate is `Terminal.isTTY`, and no `process.stdin`
  read exists anywhere*. Change it to say that the gate is `Terminal.isTTY`, which the composition
  root answers from both stdin and stdout, as bash's `[ -t 0 ]` answers from stdin. Change the
  `--feedback-edit` row's `TTY-only (Terminal.isTTY …)` to match.
- `bin.ts`'s comment above `picked` and `picker.ts`'s comment above `pickerArgv` both say that no
  `process.stdin` read exists. Correct both.

## Effect wiring

- **Tags introduced or consumed**: none introduced. `Terminal` is overridden, not added.
- **Layer composition**: `PlatformAndReporterLive` becomes a function of the stdin fact, and
  every composition over it takes the fact. Quote the result in the PR.

## Acceptance criteria

- [ ] With the stdin fact `false`, the live layer's `Terminal.isTTY` answers `false`.
- [ ] With the stdin fact `true`, it answers what the platform's does.
- [ ] `process.stdin` is read in `src/bin.ts` and nowhere else in `src/`.
- [ ] The PR lists a manual check for the reviewer, who has a terminal:
      `node src/bin.ts --branch some-branch </dev/null; echo "exit=$?"` is expected to print
      `specGiven`'s refusal and `exit=1`, with no prompt drawn.
- [ ] Every existing test passes unchanged.

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package.
