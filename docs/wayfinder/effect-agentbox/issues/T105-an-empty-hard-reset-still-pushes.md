# T105 — An empty hard reset still pushes

Status: Done (PR #66. Host check 2026-09-30: a `--hard-reset` whose agent committed nothing logged `hard reset:`, `nothing to land`, and `reset pushed` naming the old tip, and `origin/hc-reset` moved to the base. GitHub closed the open PR (#73) when its head reached the base; the next plain dispatch pushed as a fast-forward and opened a new draft PR (#74) rather than reopening #73. On `hc-local`, never pushed, the same reset pushed nothing and created no remote branch.)
Type: AFK
Blocked by: none.

<!--
MAP.md's *Not yet specified*, "A hard reset whose agent commits nothing never pushes", ruled by
the user on 2026-09-29.

The gap. The land gates on `sinceBoundary` (`dispatch/land.ts:112`, `run.sh:1589-1592`). Under
`--hard-reset` the boundary is the base, so a run whose agent adds nothing returns
`nothing-to-land` before the leased push at `land.ts:184`. The local branch now stands at the
base, but origin still holds everything the plan counted as discarded:
- `BranchReset` says `N commit(s) discarded`, and N includes origin's commits (`guards.ts:341`,
  the union count), which were never touched;
- T103 leaves `refs/remotes/origin/<b>` out of the landed-elsewhere witness *because* the lease
  push overwrites it. With no push, the next `--issues all` dispatch reads origin's stale `Done`;
- the local branch and `origin/<b>` have diverged, so the next plain dispatch does all its work
  and then fails at the push.

bash has the same shape (its `MERGE_BASE` is `BASE_SHA` too).

Decisions (the user, 2026-09-29):
- **A reset is a reset on both ends.** The empty run does the leased push anyway. The flag's
  description already promises it (`command.ts:179`), and so do the union count and T103's
  exclusion.
- **Only when `originTip` is some and is not the base.** An absent origin branch would be
  *created* at the base, which is not a reset of anything. An origin already at the base would make
  `ResetPushed` claim a push that moved nothing.
- **The land still returns `nothing-to-land`.** The PR step stays skipped (GitHub refuses a PR with
  no commits), and the row's outcome is unchanged. A new event says the reset was pushed.
- **Not a step notification** (AGENTS.md): it happens seconds before the terminal notification.
- **A run that fails or is killed after the reset is not this ticket's.** It leaves the same
  divergence, and T106's guard is what catches it on the next dispatch.

A rehearsal cannot reach this path: its `updateRef` is recorded, so the land reads the un-reset
branch and pushes (recorded). That is the cost of recording writes over real reads (T15). It is
not something to fix here, and `test/dry-run.test.ts` should not be bent to show it.
-->

## What to build

**Under `--hard-reset`, a run whose agent committed nothing still overwrites `origin/<b>` with the
base, under the same pinned lease, and says so. Without the flag, or when origin has nothing to
overwrite, nothing changes.**

### 1. The land

In `dispatch/land.ts`, inside the `sinceBoundary === 0` arm, after `NothingToLand` is emitted and
before the return:

- If `plan.reset` is `Some(reset)`, **and** `reset.originTip` is `Some(originTip)`, **and**
  `originTip !== plan.mergeBaseSha` (under a reset, the base), then call `repo.push` with the same
  arguments the pushed path uses: `from: repoRoot`, `branch: plan.branch`,
  `lease: { expect: originTip }`. Then emit `ResetPushed`.
- Otherwise do nothing more.
- Return `"nothing-to-land"` either way.

Build the push arguments once and use them on both paths rather than spelling the lease twice. A
failed push (a lease that no longer matches) propagates exactly as it does on the pushed path,
with the same stage.

No status commit on this path: `thisRun` is 0, so the existing gate already holds.

### 2. The event

`reporter.ts`: add

```ts
| { readonly _tag: "ResetPushed"; readonly branch: string; readonly originTip: string }
```

with a comment saying it is emitted only by the land's empty arm under `--hard-reset`, and that it
is the run log's record that origin's `originTip` was overwritten.

- `run-log.ts` and `app.ts` each render one line, for example
  `reset pushed: origin/<b> moved from <short originTip> to the base (nothing new to land)`. Use
  the same short-SHA helper the `BranchReset` line uses.
- `notify/notifications.ts`: add it to the silent cases. It is **not** a step notification.

### 3. SPEC

In SPEC §7's `--hard-reset` row, after the lease sentence, add: a run whose agent adds nothing
still pushes the reset under the same lease when origin had the branch at a commit other than the
base, and the land still records `nothing-to-land` and opens no PR (T105).

### 4. Tests

In `test/land.test.ts`, on the existing `Git` fake:

- A reset plan with `originTip` some and not the base, and nothing past the boundary: one `push`
  with the pinned lease, `NothingToLand` then `ResetPushed` in that order, and the land returns
  `"nothing-to-land"`.
- `originTip` none: no push, no `ResetPushed`.
- `originTip` equal to the base: no push, no `ResetPushed`.
- No reset and nothing past the boundary: no push, as today.
- The empty reset's push fails its lease: the land fails the way the pushed path's failed push
  does.

## Effect wiring

- **Tags introduced or consumed**: consumes `Git` and `Reporter`, which `land` already requires.
  No new tag.
- **Layer composition**: unchanged. `app.ts` gains only the render case.

## Acceptance criteria

- [ ] Under `--hard-reset`, with nothing past the boundary and `origin/<b>` at a commit other than
      the base, the land pushes with `--force-with-lease=refs/heads/<b>:<originTip>` and emits
      `ResetPushed`.
- [ ] With origin absent or already at the base, no push and no `ResetPushed`.
- [ ] The land returns `nothing-to-land` on every empty arm, so no PR is opened and the row's
      outcome is unchanged.
- [ ] `ResetPushed` renders in the run log and on the console, and notifies nobody.
- [ ] SPEC §7's `--hard-reset` row says it.

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package.

**Host-only: the dispatcher runs these after merge.** The agent has no docker socket and no forge,
so none of this is an acceptance criterion. Record the results on the `Status:` line.

1. Pick a throwaway branch `<b>` that has commits past the base, is pushed to origin, and has an
   open PR. Note `git rev-parse origin/<b>` and the base SHA.
2. Run `node src/bin.ts --task "Make no changes and commit nothing." --branch <b> --hard-reset
   --no-input`.
3. Check the run log. It has the `BranchReset` line, then the nothing-to-land line, then the
   `reset pushed` line naming the old origin tip.
4. After `git fetch origin`, check that `git rev-parse origin/<b>` equals the base SHA.
5. Check what GitHub did with the open PR (closed it, or kept it open with no diff), and record
   which on the `Status:` line.
6. Run a plain dispatch of `<b>` (no `--hard-reset`) with a small task. It must pass T106's guard
   if T106 has merged, and it must push as a fast-forward and open or update the PR. Record what
   the PR path did.
7. Repeat step 2 on a branch that exists locally but not on origin. There must be no push and no
   `reset pushed` line, and `origin/<b>` must still not exist.
