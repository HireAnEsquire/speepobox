# T17 — `--feedback` and the feedback-only run

Status: Done
Type: AFK
Blocked by: T16, T14

Sequence: [ticket 08](../08-in-hae-sequence.md), re-sliced 2026-08-10. Last of the fifteen tickets,
and it carries **08's original T6 tracer**.

**Tracer: a PR iterated with no manual step.** Take a PR the tool opened, run
`--resume <branch> --feedback "…"`, and the agent reads the feedback as its work order, revises,
pushes, and updates the same PR. Nothing is done by hand between the two runs. This is **move-out
gate 2** (08 §6), and with it the move-out bar is met.

## What to build

The half of feedback-resume that carries instructions, on top of T16's recovery.

### 1. `--feedback "…"`

Extra dispatcher instructions appended to the implement, review, and PR-description prompts
(SPEC §7). **It rides the stdin prompt pipe**, which T9 built in from the start, so quotes,
backticks, and `$(…)` arrive literally and are never interpreted by a shell. Do not re-open that
question: if feedback text ever reaches a command line, the property is gone.

All three prompts resolve through **T14's `PromptSource`**, and the assembled prompt is still logged
verbatim with the winning root named.

### 2. The feedback-only run

T16 wrote the decision table's `feedback-only` outcome and left it unreachable. This is what reaches
it: a resume whose recorded spec no longer resolves, but which carries feedback, runs anyway with the
feedback as its work order (run.sh's `FEEDBACK_ONLY` resolution, and the feedback-only implement
prompt it reaches — cited by name because run.sh's line numbers shift on every hardening change, and
following stale ones sent a review round into `notify`).

It **always takes the single-pass branch**, and its implement prompt is built from:

- the implement prompt, plus framing that says **the feedback is the work order**
- the merge-base
- **a best-effort `Forge.prView` for the PR's title and body** — best-effort meaning a failure here
  degrades the prompt and never fails the run

Its **review criteria are swapped** (the `FEEDBACK_ONLY` arm of run.sh's review-round prompt): the
question is whether the feedback was
addressed, not whether a spec was implemented.

### 3. What the ledger records

T16 already carries the identity forward through `FeedbackResume`. Nothing here re-derives a mode or
a spec from the filesystem — a feedback-only run's own row is what a later resume reads.

### 4. `--feedback-edit` is deferred

The `$EDITOR` flow (`git var GIT_EDITOR`, commented header stripped, empty aborts before any
container starts) is **not built here**. It is TTY-only, so an AFK dispatch cannot exercise it, and
nothing in the move-out bar touches it — `--feedback "…"` is what self-dispatch and hand-testing use.
It joins the picker, `--hard-reset`, `gc`, `init`, and `IssueStore` in ticket 09's post-move
sequence. Do not build it and do not stub it.

Note for whoever picks it up there: its temp file is one of the two untrapped windows SPEC §4 says
close **for free** under `Scope` (`run.sh:920`–`1189`), so it arrives with its leak already fixed by
construction.

## Not in scope

`--feedback-edit`, the picker and `Prompt`/clack, feature mode, `IssueStore`, `gc`, `init`, and
`--hard-reset` — all post-move. Do not stub them.

## Read first

T16's resume recovery and decision table, T14's `PromptSource`, T9's implement pass and stdin prompt
pipe, T10's review loop, T12's `Forge`, `src/ledger/record.ts`, `AGENTS.md`, and **SPEC §7
(lines 305–367), §8 (368–386), and §10 (421–469)** — those ranges, not the whole file.
run.sh's `FEEDBACK_ONLY` resolution and the prompt blocks it reaches (the implement prompt, the
review round's swapped criteria, and the PR-description pass) are the behaviour source, read as
reference documents and never executed. Search for `FEEDBACK_ONLY` rather than seeking a line range.

**This ticket sits on the largest codebase in the sequence and touches the most of it.** Read T16's
decision table and T14's `PromptSource` closely, since this ticket completes both. Everything else —
the implement pass, the review loop, `Forge` — you are calling unchanged, so read the interface and
one call site each, not the implementations.

**Already on the branch — do not rewrite** T1–T16's modules; amend `AGENTS.md` only with a ruling you
had to discover. **Do not touch hae files.**

## Effect wiring

- **Tags introduced**: none.
- **Tags consumed**: `PromptSource`, `AgentCli`, `Forge`, `Ledger`, plus the rest of the dispatch
  surface.
- **Not introduced**: `Prompt`, `IssueStore`. Do not stub them.
- **Layer composition**: **unchanged — do not edit `src/app.ts`.** The shape below is `AppLive` as of
  T14, which is this ticket's blocker; leave it exactly as you find it.

  ```ts
  export const AppLive: Layer.Layer<
    | AgentCli
    | PromptSource
    | Forge
    | Notifier
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
      Layer.mergeAll(
        SandboxLive,
        GitLive,
        RunLockLive,
        ForgeLive,
        NotifierLive,
        PromptSourceLive,
      ),
      Layer.provideMerge(
        LedgerLive,
        Layer.provideMerge(AgentboxConfigLive, PlatformAndReporterLive),
      ),
    ),
  );
  ```

  **`AppBaseLive` and `AppDryRunLive` are byte-unchanged.**

- **Errors**: a failed `prView` while assembling the feedback-only prompt is degraded and warned,
  never fatal. Everything else keeps the taxonomy T3–T12 established.

## Acceptance criteria

- [ ] `--feedback "…"` reaches the implement, review, and PR-description prompts, resolved through
      `PromptSource` and logged verbatim
- [ ] Feedback text travels on stdin and is never interpreted — quotes, backticks, and `$(…)` arrive
      literally, asserted directly
- [ ] A resume whose recorded spec no longer resolves but which carries feedback takes the
      feedback-only path; without feedback it still refuses (T16's table, now fully reachable)
- [ ] The feedback-only run is single-pass, frames the feedback as the work order, and includes the
      merge-base
- [ ] Its prompt includes the PR title and body on a best-effort basis; a `prView` failure degrades
      the prompt with a warning and does not fail the run
- [ ] Review criteria for a feedback-only run ask whether the feedback was addressed
- [ ] The run's row carries the identity forward; nothing re-derives a mode or spec from the
      filesystem
- [ ] `--feedback-edit` does not exist and is not stubbed
- [ ] `src/app.ts` is unchanged

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, grep bans, and tests. `pre-commit` is not a substitute
and does not check this package.

**Host-only**, run by the user — this is the move-out gate and it cannot run in the task container:

```
node src/bin.ts <spec> --branch <throwaway-branch>
node src/bin.ts --resume <throwaway-branch> --feedback "<a real change to make>"
```

The second run must revise the work, push to the same branch, and update the same PR, with no manual
step in between. Record the result in this ticket's `## Comments`, along with the running
Effect-error redispatch count across T1–T17 — move-out checklist item 4 is the only quantitative
result this experiment produces.

## Comments

**Move-out gate 4 — the Effect-error redispatch count across T1–T17 is `0`.** Recorded 2026-08-21,
late: the tickets closed without it and the number appeared nowhere in MAP, 08, 09, or ADR 0007. ADR
0008 had already closed the bake-off by then, so this can no longer decide anything — it is recorded
because 08 §6 asks for it as the incubation's only quantitative result, and because a threshold
nobody ever evaluated is worse evidence than a threshold evaluated at zero.

**Zero is a measured result, not an absent one.** Every T1–T17 issue that took more than one dispatch
has a cause on the record, and none of them is an Effect type or diagnostic error:

| Issue | Dispatches | Cause of the first failure |
| --- | --- | --- |
| T1 | 1 | — approved first pass (`T1 ## Comments`) |
| T2 | 1 | — three defects found in review, all "fabricated-absence", none in Effect typing or layer wiring (`T2:200`) |
| T3 | 2 | **Anthropic session limit** — `You've hit your session limit`, three retry attempts, `nothing to land` (`speepobox-t3.log.1`) |
| T5 | 2 | **Wall-clock** — `TIMED OUT at 1200s after 20m` (`speepobox-t5.log.1`) |
| T6 | 2 | **Wall-clock** — 1200s overrun, §4 untouched; already recorded as "not an Effect error, so the ADR 0007 tripwire stays at 0" (`T6:182`) |
| T15 | 1 | **Wall-clock** — `TIMED OUT at 1800s after 30m` (`speepobox-t15.log`) |
| T17 | 1 | `capped-unreviewed-fix` — review rounds kept finding real defects, so none returned `APPROVED` |
| T4, T7–T14, T16 | 1 each | approved first pass |

Corroborated independently of the causes above: `error TS`, `not assignable to type`, `Type 'Effect`,
`has no exported member`, and `Argument of type` return **zero matches across every surviving
`speepobox-t*` log**, rotations included.

**Two limits on this number, both worth stating rather than discovering later.**

1. **The ledger cannot answer the question by itself**, though the tripwire says "countable from the
   ledger". `.agentbox/runs.jsonl` records an outcome (`implement-failed`, `capped-unreviewed-fix`,
   `needs-work`, `approved`) and never a cause, so the Effect-vs-everything-else split came from the
   logs and from `## Comments`. Anyone re-deriving this needs both.
2. **Log coverage is one generation deep.** bash keeps `.log` plus `.log.1`, so a third dispatch would
   have clobbered the first one's evidence. No T1–T17 issue took three, so coverage happens to be
   complete here — this held by luck, and it is the same clobbering that
   [T36](T36-a-failed-runs-log-survives.md) is parked on.

**What the number does not say.** It is not a claim that agents wrote Effect fluently. The failures
that *did* happen were wall-clock overruns on three separate issues, which is a sizing result, and 06
priced sizing separately from the type-system risk this tripwire watches. Read it as: *the risk 06
named did not materialise across seventeen issues*, not as *the port was easy*.

**Still owed on this ticket:** the host-only two-run feedback exercise above (gate 2) was recorded as
Done without its result written here. The gate itself is met — T17's dispatch is in the ledger and the
ticket is closed — but the transcript of the resume-plus-feedback round is not on the record.
