# T106 — A branch that does not contain its remote is refused

Status: Done (PR #67. Host check 2026-09-30: a `--hard-reset` run killed with `kill -9` after its `hard reset:` line, and before any `reset pushed`, left local `hc-reset` at the base and `origin/hc-reset` ahead. After `gc --force`, a plain dispatch refused with the *behind* sentence and held nothing. After `git branch -f`, the dispatch passed the guard. A diverged branch, one commit on each side, refused with the *diverged* sentence and no `branch -f`, both plain and under `--dry-run`.)
Type: AFK
Blocked by: none.

<!--
MAP.md's *Not yet specified*, "A hard reset whose agent commits nothing never pushes", ruled by
the user on 2026-09-29. T105 closes that item's empty-run arm. This ticket closes what T105 does
not reach, and closes it in general.

A `--hard-reset` run that fails, or is killed, after the checkout's compare-and-set leaves local
`<b>` at the base while `origin/<b>` still holds everything the reset meant to discard. The next
plain dispatch of `<b>` then clones from the local tip, does all its work, and fails at the
**push**, because the push is not a fast-forward. The same happens whenever local `<b>` falls
behind or beside its remote for any other reason: another host dispatched it, a reviewer's
suggestion was committed from the GitHub UI, or someone pushed by hand. bash has the same late
failure.

Decisions (the user, 2026-09-29):
- **A general guard after the fetch**: every dispatch except `--hard-reset` refuses when local
  `<b>` does not contain `origin/<b>`. That covers `--resume`/`--last` and `--dry-run` too. It is
  read-only, and a rehearsal's reads are real (T15).
- **Passes** when `origin/<b>` is absent (the first push creates it), or when local is at or ahead
  of origin (the push is a fast-forward, for example a run killed between the land's fetch and its
  push).
- **A `GuardRefused`, before the lock**, so no ledger row (SPEC §11). A guard may *ask* through
  `Git` but maps a `GitError` onto its own refusal (T5).
- **Two sentences, and each way out says what it does.**
  - *Behind* (local is an ancestor of origin): `'<b>' is N behind origin/<b>. To take origin's
    commits: git branch -f <b> origin/<b>. To discard them: --hard-reset.` Here `git branch -f`
    is a fast-forward and loses nothing. This is also the killed-after-reset case.
  - *Diverged* (commits on both sides): names both counts and offers merging or rebasing by hand,
    or `--hard-reset` to discard both. It **never** prints `git branch -f`, which there would
    silently throw away the local commits. Advice that destroys work is not printed where it would.
- **Under `--hard-reset` it is skipped by construction**, not run and ignored: the reset discards
  both sides, and T101's union count already says how much.
- A deliberate divergence from bash, recorded in SPEC §12: bash fails late, at the push, after the
  agent's work.
-->

## What to build

**A dispatch of `<b>` whose local branch does not contain `origin/<b>` is refused after the fetch,
before anything is acquired, with a sentence that says which of two states the branch is in and
what each way out does.**

### 1. The guard

In `dispatch/guards.ts`, add `branchContainsItsRemote`, next to `hardResetDecided` and in the same
style (it requires `Git`, and every call names `repoRoot`, T27):

```ts
export const branchContainsItsRemote = (fields: {
  readonly repoRoot: string;
  readonly branch: string;
  readonly tipSha: string;
}): Effect.Effect<void, GuardRefused, Git>
```

1. Read `refs/remotes/${ORIGIN}/<b>` with `repo.revParse`, exactly as `hardResetDecided` does. A
   failed read is **absent**, and absent passes.
2. `repo.branchContains({ repo, branch, commit: originTip })`. `true` passes. This covers equal
   tips and local ahead.
3. Otherwise count both sides with `repo.countCommits`: `behind = tipSha..originTip` and
   `ahead = originTip..tipSha`.
   - `ahead === 0`: refuse with the *behind* sentence.
   - Otherwise: refuse with the *diverged* sentence.
4. A `GitError` from `branchContains` or either count is a `GuardRefused` quoting git's detail.
   The sentence says the check could not be made, not that it passed. A check that could not be
   made is not a clean sheet (T72's rule).

Export the two sentences as functions (`branchBehindItsRemote`, `branchDivergedFromItsRemote`) so
tests assert against them rather than retyping them:

- Behind: `'<b>' is N behind origin/<b>. To take origin's commits: git branch -f <b> origin/<b>. To
  discard them: --hard-reset.`
- Diverged: `'<b>' and origin/<b> have diverged — L commit(s) only here, R only on origin. Merge
  or rebase them by hand, or discard both with --hard-reset.` The wording is yours, but it must
  name both counts, must offer `--hard-reset`, and must not contain `branch -f`.

### 2. Where it runs

In `dispatch/dispatch.ts`, straight after `guardTip` is resolved and before `hardResetDecided`:

```ts
if (!request.hardReset) {
  yield* branchContainsItsRemote({ repoRoot, branch, tipSha: guardTip });
}
```

This is after the guard phase's fetch, so `origin/<b>` is what origin holds now, and before the
reset's count, the confirm, the issue set, and the lock. Nothing is held or written but the fetch
(matrix row 1). No other call site: the picker hands its argv to `dispatchCli` (T81), so a picked
dispatch reaches this line too.

### 3. SPEC

- §7 dispatch steps: add the check to step 4's list, or as its own sentence beside it: the branch
  must contain `origin/<b>` unless `--hard-reset`, and the two refusals are as above (T106).
- §12's deliberate-divergence list: add **a branch behind or beside its remote is refused before
  the lock** (bash fails at the push, after the agent's work — T106).
- §11 row 1's refusal list, if it enumerates guard refusals: add this one.

### 4. Tests

In `test/dispatch.test.ts`, on the existing `Git` fake, driving `dispatch` as the other guard cases
do:

- Origin absent: the dispatch proceeds.
- Local equal to origin, and local ahead: proceeds.
- Local behind: refuses with `branchBehindItsRemote`, holding nothing (no lock, no clone, no row),
  as the other row-1 cases assert.
- Diverged: refuses with `branchDivergedFromItsRemote`, and the detail contains no `branch -f`.
- Behind, with `--hard-reset`: proceeds, and `branchContains` is **never asked** about origin's tip
  for this purpose. Assert the call is absent rather than ignored.
- `branchContains` fails: refuses with git's words.
- A `--resume` of a behind branch refuses. So does a `--dry-run`.

Pure tests of the two sentence functions go in the same file or beside `hardResetConfirmed`'s.

## Effect wiring

- **Tags introduced or consumed**: consumes `Git`, which the dispatch already requires. No new tag.
- **Layer composition**: unchanged.

## Acceptance criteria

- [ ] Every dispatch except `--hard-reset` refuses, before the lock and with no ledger row, when
      local `<b>` does not contain `origin/<b>`.
- [ ] Origin absent, equal, or behind local: no refusal.
- [ ] The *behind* refusal names N, `git branch -f <b> origin/<b>` as taking origin's commits, and
      `--hard-reset` as discarding them.
- [ ] The *diverged* refusal names both counts and `--hard-reset`, and never `branch -f`.
- [ ] Under `--hard-reset` the check is not made.
- [ ] A git failure in the check refuses with git's words.
- [ ] SPEC §7 and §12 say it.

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package.

**Host-only: the dispatcher runs these after merge.** The agent has no docker socket and no forge,
so none of this is an acceptance criterion. Record the results on the `Status:` line.

1. **Killed after the reset.** On a throwaway branch `<b>` that is pushed and has commits past the
   base, run `node src/bin.ts --task "…" --branch <b> --hard-reset --no-input`. Once the log shows
   the `BranchReset` line, `kill -9` the dispatch. Run `node src/bin.ts gc --force` to clear the
   slug. Local `<b>` is now at the base, and `origin/<b>` is not.
2. Run a plain dispatch of `<b>`. It must refuse with the *behind* sentence, before any lock or
   container: `node src/bin.ts gc` lists nothing new for the slug, and `status` shows no new row.
3. Run `git branch -f <b> origin/<b>` as the sentence says, and dispatch again. It must pass the
   guard.
4. **Diverged.** Make a local commit on `<b>`, and push a different commit to `origin/<b>` from
   another clone. Then `git fetch`, and dispatch `<b>` plainly. It must refuse with the *diverged*
   sentence, naming 1 and 1, with no `branch -f` in it.
5. Dispatch the same diverged branch with `--dry-run`. It must refuse the same way.
