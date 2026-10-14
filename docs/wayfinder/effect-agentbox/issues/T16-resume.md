# T16 — Resume recovery: `--resume` and `--last`

Status: Done
Type: AFK
Blocked by: T12

Sequence: [ticket 08](../08-in-hae-sequence.md), re-sliced 2026-08-10. First of the two tickets that
replace 08's T6 bullet. Changes no layer, so it runs in parallel with [T13](T13-notifier.md) and
[T14](T14-prompt-source.md).

**Tracer: re-dispatch a branch with nothing but `--resume`.** No spec argument, no `--base` — both
come back off the ledger, and the run proceeds exactly as the original did. `--last` does the same
for the most recent branch. The new run's row records a `FeedbackResume` identity wrapping what it
resumed.

## What to build

The recovery half of feedback-resume. The feedback itself is T17.

### 1. `Ledger.resolveResume`

The query SPEC §2 says arrives with `--resume`. It reads the newest record for a branch and hands
back what a dispatch needs to repeat: the identity and the base.

**Mode recovery is a tag read.** This is the entire point of T2's greenfield record: bash's
`resolve_resume` recovers the mode by checking which of `spec` / `feature` is non-null
(`tasklib.py:525-576`), and `src/ledger/record.ts` replaced that nullable pair with a tagged union
plus a `dispatchIdentity()` accessor that unwraps a `FeedbackResume`. **No code in this ticket may
null-check its way to a mode.** Repeated resumes compose because a resume's own row carries the
identity forward rather than re-deriving it.

**Only "this branch has no ledger record at all" is an error.** Every other degradation is expressed
as data on the returned value, not as a failure — bash carries that as `task_dir_exists=False`, and
the same discipline applies here. The ledger stays derived state.

### 2. `--resume <branch>` and `--last`

`--last` is **sugar on `--resume`** (SPEC §7), resolving to the most recently recorded branch. It is
not a second code path; if the ledger is empty it refuses with a typed error and a hint naming the
branches it does know about, as bash does.

On a resume, the spec argument and `--base` both come off the recovered record rather than from the
flags. `--branch` is implied by the resumed branch. T3's guards still all run.

### 3. The decision table

`resume_dispatch_action` (`tasklib.py:579-602`) is a **pure decision table, not a tag** — the same
kind of pure function SPEC §2 predicts, and one of the genuinely valuable cases translating out of
tasklib's suite.

Bash's four outcomes collapse to **three** before the move, because `--issues` and feature mode are
post-move (08 §3): the resumed spec still resolves → **normal**; it does not and there is feedback →
**feedback-only**; it does not and there is none → **refuse**. The fourth (`hard-error` on an
`--issues` argument) arrives with feature mode in ticket 09.

The table lands whole here because it is one pure decision and splitting a decision across tickets is
how contradictory answers get invented. **`feedback-only` is unreachable until T17 supplies the
feedback** — write it, test it as a pure function, and do not build a code path to it yet.

### 4. What the ledger records

A resume writes a `FeedbackResume` identity **wrapping** the resumed one, with `resumedRunId` present
when the resumed run had an id and **absent when it predates run ids** — never synthesized. Both
fields already exist in `src/ledger/record.ts`; use them as built.

## Not in scope

`--feedback`, `--feedback-edit`, and the feedback-only run path (T17). Feature mode, `--issues`, and
`IssueStore` stay deferred to ticket 09.

## Read first

`src/ledger/record.ts` and `src/ledger/ledger.ts` — especially `dispatchIdentity()` and
`lastBaseForBranch` — plus T3's guards and `--base` chain, `AGENTS.md`, and **SPEC §7
(lines 305–367) and §10 (421–469)** — those ranges, not the whole file. `tasklib.py:464-602` is the
behaviour source, read as a reference document and never executed.

In `test/dispatch.test.ts`, `describe("the --base default chain")` is the existing ledger-read path a
resume reuses, and `describe("the @effect/cli surface")` is where `--resume` and `--last` parsing
joins the flags already there.

**Already on the branch — do not rewrite** T1–T12's modules; amend `AGENTS.md` only with a ruling you
had to discover. **Do not touch hae files.**

## Effect wiring

- **Tags introduced**: none. `resolveResume` is a new query on T2's `Ledger`.
- **Tags consumed**: `Ledger`, `AgentboxConfig`, `Reporter`, and the dispatch services T3–T12 wired.
- **Not introduced**: `IssueStore`, `Prompt`. Do not stub them.
- **Layer composition**: **unchanged — do not edit `src/app.ts`.** This ticket adds a query to an
  existing tag. The shape below is `AppLive` as of T12; if T13 or T14 has landed first it will carry
  their layers too, and the rule is the same either way — leave it as you find it.

  ```ts
  export const AppLive: Layer.Layer<
    | AgentCli
    | Forge
    | Sandbox
    | Git
    | RunLock
    | Ledger
    | AgentboxConfig
    | Reporter
    | NodeContext.NodeContext,
    ConfigError
  > = Layer.provideMerge(
    AgentCliLive,
    Layer.provideMerge(
      Layer.mergeAll(SandboxLive, GitLive, RunLockLive, ForgeLive),
      Layer.provideMerge(LedgerLive, Layer.provideMerge(AgentboxConfigLive, PlatformAndReporterLive)),
    ),
  );
  ```

  **`AppBaseLive` is byte-unchanged.**
- **Errors**: a branch with no ledger record is a typed `GuardRefused` before anything is acquired —
  matrix row 1, and it writes no row. A ledger that cannot be read degrades resume the same way it
  degrades `status` and the `--base` chain.

## Acceptance criteria

- [ ] `resolveResume` recovers identity and base from the newest record for a branch, reading the
      mode off the union tag; no null-checking recovers a mode anywhere
- [ ] Repeated resumes compose — resuming a resumed run recovers the original dispatch identity
      through `dispatchIdentity()`
- [ ] A branch with no ledger record refuses with a typed error naming known branches, holding
      nothing and writing no row
- [ ] Every other ledger degradation is expressed as data on the resolved value rather than as a
      failure
- [ ] `--last` resolves to the most recent branch and is sugar on `--resume`, not a second path
- [ ] The decision table is a pure function covering all three reachable outcomes, with
      `feedback-only` written and tested but unreachable until T17
- [ ] A resumed run records a `FeedbackResume` identity wrapping the resumed one, with `resumedRunId`
      absent rather than synthesized when the original had none
- [ ] `src/app.ts` is unchanged

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, grep bans, and tests. `pre-commit` is not a substitute
and does not check this package.

**Host-only**, run by the user before landing:

```
node src/bin.ts <spec> --branch <throwaway-branch>
node src/bin.ts --resume <throwaway-branch>
node src/bin.ts --last
```

The second and third must run without a spec argument or a `--base`, against the same branch and
base as the first, and `runs.jsonl` must show a `FeedbackResume` row wrapping the original identity.
