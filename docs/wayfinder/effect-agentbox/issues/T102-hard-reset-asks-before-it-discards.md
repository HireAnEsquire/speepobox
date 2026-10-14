# T102 — `--hard-reset` asks before it discards

Status: Done (PR #64. TTY confirm checked on the host 2026-09-25: answering no, and Esc, each refused with "--hard-reset aborted" and left the branch tip, the locks directory, and the containers unchanged.)
Type: AFK
Blocked by: [T101](T101-hard-reset-resets-to-the-base-and-force-pushes.md) — the flag, the discard count, and the reset this confirms.

<!--
P4 (09 Q5). Oracle: `run.sh:1290-1298`. When a hard reset would discard commits, bash prints
`!! --hard-reset: DISCARDING <n> commit(s) on '<b>' (recoverable via reflog only)`, and on a TTY
asks `Type yes to proceed:`. Any other answer is `aborted — branch untouched`, exit 1. Scripted
runs proceed ("the explicit flag is the consent, and blocking on stdin would hang a backgrounded
invocation"). `--dry-run` never asks. SPEC §11's matrix row 1 already lists "declined confirm" as
a `GuardRefused` with nothing held.

Decisions (the user, 2026-09-24, P4 quiz):
- **D2 (a)**: the dispatch gets `Prompt`. `PromptClackLive` joins `appLiveFor`, and SPEC §2's
  "provided to the picker alone, so no dispatch … acquires one" is amended in this ticket. The
  alternative was a typed hand-back to `bin.ts` with a hidden consent word; it was not taken.
- **D3**: off a terminal, or with `--no-input`, there is no prompt and the dispatch proceeds. T101
  already behaves that way everywhere; this ticket only adds the terminal arm.
- **D4**: a rehearsal does not ask. The rehearsal composition gets a recording `Prompt` that
  answers `true` and records what it would have asked. No dispatch op learns it is a rehearsal
  (T15).

Split from T101 on purpose, and approved that way: between T101 and this ticket landing, a
`--hard-reset` on a terminal proceeds without asking.
-->

## What to build

**On a terminal, a hard reset that would discard commits says how many and asks. Declining holds
nothing.**

### 1. The guard

In `dispatch/guards.ts`, add a guard that takes the branch, the discard count, and the request's
`noInput`. It runs in `dispatch.ts` immediately after T101 computes `discarding`, which is after
the fetch and before `reconcile`, so a refusal holds nothing and has written nothing but the fetch
(matrix row 1, T70).

- The count is T101's union: every commit reachable from the local tip or from `origin/<b>` and
  not from the base (ruled 2026-09-24). A branch that is behind its remote therefore asks here,
  where bash would have asked nothing.
- `discarding === 0`: no prompt, no line (bash's `if [ "$discarding" -gt 0 ]`).
- Otherwise, emit a `Warned` with bash's discard sentence in this tool's words, naming the count,
  the branch, and that the commits are recoverable from the reflog only. The console shows it, and
  so does a run that proceeds off a terminal.
- Then, only if `Terminal.isTTY` answers true and `noInput` is false, call `Prompt.confirm`.
  `Terminal.isTTY` is the same gate `--feedback-edit` asks (`guards.ts:321-325`), which T94 made
  answer for stdin and stdout together. The message names the count and the branch.
  - `false`, or `PromptCancelled` (Esc and Ctrl-C are one sentinel, 13): a `GuardRefused` saying
    the dispatch was aborted and the branch was not touched.
  - `true`: proceed.

### 2. The reset's failure names the confirm

T101's compare-and-set failure after a `WentHome` salvage says the salvage moved commits onto the
branch that the discard count never included, and tells the dispatcher to run again. Once there
is a confirm, a dispatcher may have answered it. So the sentence also says that the confirm never
asked about those commits, and that running again asks about them too. The user ruled this on
2026-09-24. The sentence for "the branch moved some other way" is unchanged.

### 3. The rehearsal's `Prompt`

Add `src/dry-run/prompt.ts`, with `PromptRecordingLive: Layer<Prompt, never, Reporter>`.
`confirm` records the question through `dry-run/record.ts`'s `recorded` (a `MutationRecorded`)
and answers `true`. The dispatch surface asks nothing else, so every other member dies with a
message naming that invariant: a dispatch asking one would be our own broken invariant.

### 4. SPEC

- SPEC §2's `Prompt` row: `PromptClackLive` is provided to the picker **and to the dispatch**, for
  `--hard-reset`'s confirm (T102). `status`, `doctor`, and `gc` still acquire none.
- SPEC §7's `--hard-reset` row: the confirm, and the no-prompt arms (D3, D4).

### 5. Tests

In `test/dispatch.test.ts`, on a scripted `Prompt` fake and a `Terminal` stub:

- TTY with yes, which proceeds;
- TTY with no, which is refused holding nothing;
- TTY cancelled, refused the same way;
- off a terminal, which proceeds with no prompt asked;
- `--no-input` on a TTY, which proceeds with no prompt asked;
- zero to discard, which asks nothing and warns nothing;
- a local branch level with the base but behind its remote, which asks, naming the origin-only
  commits in the count.

In `test/checkout.test.ts`: T101's salvage-moved-the-branch case asserts the widened sentence.

In `test/dry-run.test.ts`: a rehearsal with commits to discard asks nothing, records the question,
and proceeds.

## Effect wiring

- **Tags introduced or consumed**: consumes `Prompt`, `Terminal`, and `Reporter`. No new tag.
- **Layer composition**: copy, do not derive. In `app.ts`, both compositions gain one term in
  their `Layer.mergeAll`, and nothing else moves. Widen each return type with `| Prompt`.

  ```ts
  // appLiveFor
  Layer.mergeAll(
    SandboxLive,
    GitLive,
    RunLockLive,
    ForgeLive,
    NotifierLive,
    IssueStoreLive,
    promptSourceLiveFor(repoRoot),
    PromptClackLive,
  ),

  // appDryRunLiveFor
  Layer.mergeAll(
    SandboxRecordingLive,
    GitRecordingLive,
    RunLockRecordingLive,
    ForgeRecordingLive,
    NotifierRecordingLive,
    IssueStoreRecordingLive,
    promptSourceLiveFor(repoRoot),
    PromptRecordingLive,
  ),
  ```

  `PromptRecordingLive` needs `Reporter`, which the stack under the merge provides, as it does for
  the other recording layers. `appBaseLiveFor` is byte-unchanged. The picker's own
  `PromptClackLive` provide in `bin.ts` is unchanged. Put the resulting `app.ts` compositions in
  the PR description.

## Acceptance criteria

- [ ] On a terminal, `--hard-reset` with commits to discard prints the count and asks. "No" and
      Esc/Ctrl-C refuse with nothing held and nothing written but the fetch.
- [ ] Off a terminal, or with `--no-input`, the count is printed, nothing is asked, and the
      dispatch proceeds.
- [ ] Zero to discard: no line and no question.
- [ ] `--dry-run --hard-reset` on a terminal asks nothing and records the question.
- [ ] `appBaseLiveFor` is byte-unchanged, and `status`, `doctor`, and `gc` acquire no `Prompt`.
- [ ] After a `WentHome` salvage, the reset's compare-and-set failure says the confirm never asked
      about the commits the salvage moved, and that running again will.
- [ ] SPEC §2 and §7 are updated as in §4.

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package.

Host-only, owed by hand on a throwaway branch with commits past its base:
`node src/bin.ts <spec> --branch <throwaway> --hard-reset`. Answer no, and check that
`git rev-parse <throwaway>` is unchanged and no lock file exists. Do not re-run it with `</dev/null`
to check the other arm: under D3 that is a real dispatch that resets the branch. The fake tier
covers that arm.
