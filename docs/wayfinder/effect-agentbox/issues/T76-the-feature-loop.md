# T76 — The feature loop

Status: Done (PR #38; `boundaryIn` reads a container that printed nothing as a rehearsal and answers the plan's tip — true of the recording `Sandbox`, and on a live run only as long as a zero-exit `git rev-parse HEAD` always prints, so a live answer lost between the exec and the `Ref` would hand issue two onward the fork commit as its boundary, silently rather than as a failure; the plan already knows whether this is a rehearsal, but reading that in the op is the branch T15's swap deletes, so it stands as written. `FEATURE_MODE_UNIMPLEMENTED` outlives the scope door in `resume.ts`, where its words are now false — recorded on T78 §4)
Type: AFK
Blocked by: [T75](T75-the-passes-are-told-which-issue-they-are-for.md) — the mount and the
per-issue messages this loop hands each pass.

<!--
P2 (09 Q5), the orchestration bash keeps in `run.sh:1740-1935` and tests nowhere (03 §6). One
container, one branch, one lock; for each selected issue in T69's order, an implement pass then
review rounds; three stop conditions, each landing what is already done; the unreached recorded
`not-attempted`; per-issue outcomes on the `Feature` row the ledger schema has carried since T2.

Deleted here: T73's temporary refusal at the scope's door.
-->

## What to build

**A `Feature` plan runs its selection in order inside the one scope a spec run uses — per issue,
implement then review rounds — stops at the first issue that does not approve, lands and opens the
PR for what approved, and writes one `Feature` row whose `issues` carry every selected id's
outcome.**

### 1. The loop, in the scope

Where `runInScope` runs *one* implement pass and *one* `reviewRounds` today, a `Feature` plan
runs, for each issue in `selection.issues`:

1. **The boundary**: `git rev-parse HEAD` inside the container through `Sandbox.exec`, collecting
   its one line — the SHA the branch stands at as this issue begins (`run.sh:1766`). **Not host git
   in the clone**, read-only or otherwise: the agent owns the clone's `.git/config`, and a
   `core.fsmonitor` there runs a command on read-only operations too, with the dispatcher's
   credentials — `run.sh`'s standing rule at its land step, and decision 2 of 09's comment of
   2026-09-21. The boundary is the `CurrentIssue.boundary` T75's messages read.
2. **Implement** (`AgentCli.implement` with the `CurrentIssue`). `AgentPassFailed` here is the
   issue's outcome `implement-failed` and the loop's stop (`run.sh:1786-1796`) — not the run's
   error. 05 Q16R settles *retry*, not sequencing: the pass is single-shot with nothing wrapping it
   in a `Schedule`, and a multi-issue run is outside what it contemplated. This ticket rules the
   sequencing, following bash: the failure stops the sequence, and the run goes on to land what
   earlier issues left. `PassFailed` is still emitted for the
   pass (T55); the error is caught here, once, and becomes an outcome.
3. **Review rounds** (`reviewRounds` with the `CurrentIssue`; `maxReviewRounds` as today). A
   pass failure is `review-failed` and stops. `approved` continues to the next issue. `needs-work`
   and `fixed` (→ `capped-unreviewed-fix`, `outcomeFor`) record and stop (`run.sh:1868-1893`):
   a capped fix stops as well, because the final round's commits went unreviewed.
4. After the loop, every issue after the stop is `not-attempted` (`run.sh:1896-1901`).

Three stop conditions — implement failed, review failed, not approved — and all three land what
is done: the loop falls through to `work` (land, PR) exactly as the spec path does.

**The PR pass takes no `CurrentIssue`, and this is the one place the seam's shape misleads**
(T75): `describePr` accepts `current` so a caller reads all three passes the same way, but what
it describes is the branch, whose commits span every issue the run reached, so its message names
the whole selection off the plan and names no issue at all. `openPullRequest` keeps passing
`Option.none()`. Handing it the issue in flight changes no prompt and still logs `-- describe-pr
(issue Tnn) prompt --` over a prompt that never names it.

### 2. The row

Outcomes fold into a `Ref<ReadonlyArray<IssueOutcome>>` beside `outcome`, `pr`, `rescued`, and
`usage` (T31's shape: what a finalizer needs travels in a `Ref`). `recordTerminal` overlays them
onto the plan's `Feature { issues: [] }` — or onto the `Feature` under a `FeedbackResume` (T78) —
and fills the tail: every selected id with no recorded outcome is `not-attempted`, computed in the
finalizer so a run killed mid-pass still names what it never reached. The issue in flight when a
run is interrupted is therefore `not-attempted` too: nothing landed for it, and the resume replays
it (T78). `outcome` (the review verdict) stays `None` on a feature row; the tally is per issue and
`status` already renders it (`status/render.ts`, `issuesCell`). The vocabulary is bash's minus
`blocked-hitl` (T69): `approved`, `needs-work`, `capped-unreviewed-fix`, `implement-failed`,
`review-failed`, `not-attempted`. Usage folds across every pass of every issue as it does across
three passes today (T53).

`RunWork` gains the outcomes `Ref`, so T77's land can read which issues approved.

### 3. Events

`ReviewVerdictReached`, `AgentPassFinished`, and `PassFailed` gain `issue: Option<string>`; the
console and log renderers prefix `issue <id>` when present (`run.sh:1803, 1847`). The step
notifications already sent for the per-round verdict and the implement pass finishing carry the id
in their body — the same two boundaries AGENTS.md admits, now once per issue; no new event notifies.
`runStartHeader` prints `mode=feature` and the id list where it prints `mode=one-off`.

### 4. Exit and terminal reason

A feature run that stopped on a failed or unapproved issue still lands, opens its PR, and records
`Completed`: the run did what a feature run does, and what happened to each issue is on the row and
in the PR (T79). The exit code follows the terminal reason as today. The terminal notification's
body names the stop reason when there is one (`run.sh:1889`).

### 5. Docs

- SPEC §11's failure-point matrix gains the feature rows: implement-failed on issue *n* of *m*,
  review-failed, not approved, interrupted mid-issue — each with what the row carries.
- `AGENTS.md`, under *The agent passes and the review*: **a per-issue boundary is read in the
  container, never by host git in the clone** `(T76)`, and **a failed pass in a feature run is an
  outcome, not the run's error** `(T76)`, each naming the shape that typechecks and is wrong.
- SPEC §12: the sandbox-read boundary, the caught pass failure, and the dropped mid-run stamp join
  the divergence list.

## Effect wiring

- **Tags introduced or consumed**: none introduced. `Sandbox.exec` consumed for the boundary read;
  the sandbox fake answers a scripted SHA.
- **Layer composition**: unchanged.

## Acceptance criteria

- [ ] A three-issue selection with the fake agent approving each: three implement passes and three
      review rounds in T69's order, each `CurrentIssue` carrying the SHA the fake sandbox answered
      for that issue, one land, one PR, a `Feature` row with three `approved`.
- [ ] Issue 2 needs-work after the cap: issue 1 `approved`, 2 `needs-work`, 3 `not-attempted`; land
      and PR still run; terminal reason `Completed`.
- [ ] Issue 1's implement pass fails: `implement-failed`, 2 and 3 `not-attempted`, `PassFailed`
      emitted once, land runs (and reports nothing to land when nothing was committed), the run
      exits as a completed run.
- [ ] Issue 2's review pass fails: `review-failed`, the rest `not-attempted`.
- [ ] Interrupted during issue 2's implement pass: row `Interrupted`, issue 1 `approved`, 2 and 3
      `not-attempted`.
- [ ] The fake `Git` records no call whose repo is the checkout path during the loop.
- [ ] Every spec and inline dispatch test passes unchanged; T73's temporary refusal is gone.
- [ ] `status` renders the tally for a row this ticket wrote as it does for a legacy feature row.

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package.
