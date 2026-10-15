# T148 — a branch checked out mid-run is named

Status: needs-triage
Type: AFK
Blocked by:

<!--
Ruled 2026-10-15, writing `docs/self-hosting.md`. A dispatcher who checks out the dispatch's branch
while the run is going breaks its land: git refuses to fetch into a branch checked out in any
worktree. The guard phase already refuses a branch checked out at the start (`branchNotCheckedOut`
in `src/dispatch/guards.ts`); nothing asks again later.

The commits are safe today. The land fails, the release's salvage tries the branch, which git
refuses too, and the commits go to `<branch>-from-run-<sha>` (T29). What is wrong is the
explanation: the run fails quoting git's raw refusal, and the rescue sentence says the commits
"would not go onto" the branch, which reads as diverged history. Neither one says *you checked it
out* or what to do next.

This ticket changes messages and skips one fetch that cannot succeed. Where the commits go does not
change: the rescue stays the release's, never the land's (T29).
-->

## What to build

### One question, three askers

`branchNotCheckedOut` already finds the worktree holding a branch. Extract that lookup into one
function, `Git.worktrees` plus the find, which answers the holder's path or none. The guard keeps
its refusals and calls the extracted function. The land and the salvage call it too. Do not write a
second lookup.

### The land asks before it fetches

In `src/dispatch/land.ts`, before `fetchBack`, ask whether `plan.branch` is checked out in any
worktree of `repoRoot`. If it is, the land fails, staged `land` as every land failure is, with a
`GitError` whose detail says:

- that `'<branch>'` was checked out at `<path>` during the run;
- that git does not fetch into a checked-out branch, so the work was not landed and nothing was
  pushed;
- that the commits are kept on a branch of the run's own, named below.

If the lookup fails, the land goes on to its fetch as today. The lookup is for a better sentence and
must never cost a land that would have succeeded.

### The salvage names the reason

The salvage in `src/dispatch/checkout.ts` already asks a question before it fetches onto the branch
(T107: a branch the repo cannot read goes straight to the rescue). Add the checked-out case beside
it:

- If the branch is checked out, the salvage makes no fetch onto it and goes straight to the rescue,
  as the `BranchUnread` arm does.
- A new `RescueReason` arm, `CheckedOut { path }`. `rescueBecause` renders it as
  `'<branch>' is checked out at <path>, and git does not fetch into a checked-out branch`.
- Every renderer that turns a rescue reason or a branch attempt into words handles the new arm.
  The compiler finds them; follow the type.
- Containment is still asked after the rescue's fetch (T38). Nothing about removal changes.

### The recovery the dispatcher is handed

When the reason is `CheckedOut`, the release's rescue sentence ends with the steps. The dispatcher
already has the branch checked out, so the first step is run right there:

```
  git -C <path> merge --ff-only <rescue>
  git -C <path> push origin <branch>
```

and one line saying the PR was not opened or updated, so they open it or re-dispatch with
`--resume <branch>`. Use the run's real values; no placeholders reach the screen.

If the lookup itself failed, the salvage behaves exactly as today.

## Effect wiring

- **Tags introduced or consumed**: `Git` (already consumed by all three callers). No new tag.
- **Layer composition**: unchanged.

## Acceptance criteria

- [ ] One function answers "which worktree holds this branch"; `branchNotCheckedOut`, the land, and
      the salvage all call it.
- [ ] A test: with the branch checked out in a worktree when the land runs, the land makes no
      `fetchBack`, fails staged `land`, and its detail names the branch and the worktree path.
- [ ] A test: the same situation at the release gives `Rescued` with `because` `CheckedOut`, makes
      no fetch onto the branch, and the rendered sentence holds both recovery commands with real
      values.
- [ ] A test: a worktree lookup that fails leaves the land and the salvage doing what they did before
      this ticket.
- [ ] Every existing land, checkout, and guard test passes without edits to what it asserts.

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package.

Also inside the container: `node src/bin.ts status` under plain node prints the status screen (or its
degraded form), not a crash.
