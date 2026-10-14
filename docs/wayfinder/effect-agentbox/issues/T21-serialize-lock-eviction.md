# T21 — Serialize stale-lock eviction

Status: Done
Type: AFK
Blocked by: T20

Sequence: [ticket 08](../08-in-hae-sequence.md), re-sliced 2026-08-10. **Split out of
[T8](T8-reconciler.md) on 2026-08-11**, and the second prefactor in front of it after
[T20](T20-atomic-lock-claim.md). T20's review round found this, traced it precisely, and left it
deliberately — its ticket prescribed the claim and nothing else. Like T20 it is a correctness fix to
code already on the branch, so it lands on its own rather than waiting on a feature ticket.

**Tracer: two dispatches that find the same dead lock, and the loser never removes the winner's
lock.**

## What to build

One more use of `link`, in the one place T20 could not reach.

### 1. What T20 closed, and what it left

T20 made **creation** exclusive: `src/lock/claim.ts` writes a pid to a unique temp file and `link`s it
into place, so two claims on a free path resolve through the kernel and exactly one wins.

**Eviction is still a bare `remove`.** In `src/lock/run-lock.ts`, `acquireFile` reads the owner, finds
it dead, and unconditionally removes the file before claiming. Both dispatches can be inside that
sequence at once:

1. A and B both collide, both read the same dead pid P.
2. A removes the corpse, links its own lock, holds the branch.
3. B — whose read happened before A's remove — removes **A's fresh lock** and links its own.
4. Both hold the branch. Worse: A's release is a force-remove of its own path, so when A finishes it
   deletes **B's** lock while B is still running.

`link` cannot help here. It makes creation exclusive, and by step 3 the path is not free — it holds a
live lock, and the claim that lands on it is a claim on a lock somebody else just wrote.

### 2. The shape that looks right and is not

Renaming the corpse aside instead of removing it reads like the same trick applied to eviction, and it
does not work. At step 3 the path holds A's *live* lock, so B's rename moves that aside just as
happily as it would have moved the corpse. POSIX offers no unlink-if-this-is-still-the-file-I-read,
and no rename-if-unchanged either. **Do not spend a checkpoint rediscovering this.**

### 3. The fix: an eviction witness, keyed by the dead owner

Before removing the corpse, take an exclusive claim **on the right to remove it**, using the corpse
itself as the link source:

- link the corpse to a witness path derived from the lock path and the dead pid you read
- **`AlreadyExists` means another dispatch is already evicting that same corpse** — this run lost the
  eviction, holds nothing, and answers `LockHeld` with the wording `acquireFile` already uses for
  losing a reclaim
- the winner removes the corpse, claims through T20's primitive, and removes the witness

Two properties make this the right mechanism, and both are why it beats a separate reclaim lock:

- **The witness is keyed to a generation, not to a path.** It names the pid that was found dead, so a
  later eviction of a later corpse takes a different witness path and is never blocked by an older
  one.
- **It introduces no timeout.** A reclaim lock guarding the critical section would need one — the run
  holding it can die — and a timeout is a second staleness rule over the same lock directory, which
  is exactly what SPEC §6's runtime-root note refuses.

The witness is removed on the success path, the failure path, and interruption, through the
`Effect.ensuring` discipline `claim.ts` already uses for its temp file. What survives that is a
`kill -9` between the link and the remove, which leaves one witness file and no lock — ordinary
wreckage, and T8's reconciler is the component that reclaims it.

### 4. Release removes only a lock this run owns

Independent of the race, and cheap: `releaseFile` force-removes its recorded path without looking at
what is there. Read the pid first and remove only when it is this process's. A run that lost its lock
to any interleaving then leaves the live holder alone, and warns rather than deleting.

This narrows the damage of every window in this area, including ones nobody has found yet.

## Not in scope

The reconciler, `gc`, the liveness predicate's shape (already shared and correct), and every
agent-facing service. Do not stub them. Do not add a second caller for the claim or the witness — the
reconciler does not exist yet.

## Read first

`src/lock/claim.ts` and `src/lock/run-lock.ts` — both small, both read whole — plus
`src/lock/liveness.ts`, `AGENTS.md`, and **SPEC §4 (lines 176–249)**.

`claim.ts` is the worked example for everything this ticket does: the unique-name discipline, the
`AlreadyExists`-is-the-answer reading, and the `Effect.ensuring` cleanup are all there, and the
witness should look like a sibling of it rather than a new idea.

In `test/run-lock.test.ts`, `describe("RunLock")` holds T4's four reclamation cases and T20's
same-dead-owner tracer, and `describe("the atomic claim")` holds T20's primitive's own cases. All of
them should still pass; the new cases join them.

**Already on the branch — do not rewrite** T1–T7's or T20's modules. `run-lock.ts` and a witness
beside `claim.ts` are the files this ticket edits on purpose. Amend `AGENTS.md` only with a ruling you
had to discover. **Do not touch hae files.**

## Effect wiring

- **Tags introduced**: none.
- **Tags consumed**: `RunLock`'s existing set, plus `FileSystem` / `Path` **directly, no wrappers**.
- **Layer composition**: **unchanged — do not edit `src/app.ts`.** This changes the body of an
  existing layer, not the graph.
- **Errors**: `LockHeld` and `LockError` keep their exact meanings. Losing the witness is a
  *collision*, which is `LockHeld`; any other failure of the link is `LockError`.

## Checkpoint order

The witness primitive plus its own test reaches `npm run verify` before `acquireFile` is rewired to
it, exactly as T20 landed its claim before its conversion. The release-side ownership check in §4 is
independent of both and goes green on its own — land it first if you want the cheapest checkpoint.

## Acceptance criteria

- [ ] Eviction of a dead lock is exclusive: two dispatches that read the same dead owner produce
      exactly one remover, decided by the kernel and not by a read this process took a moment ago
- [ ] The loser of an eviction removes nothing and fails as `LockHeld`
- [ ] The witness is keyed to the dead pid, so evicting a later corpse is never blocked by an earlier
      witness
- [ ] The witness is removed on the success path, the failure path, and interruption
- [ ] No timeout, age check, or second staleness rule is introduced anywhere in the lock directory
- [ ] `releaseFile` removes the lock only when it records this run's pid, and warns rather than
      removing when it does not
- [ ] T4's four reclamation cases and T20's cases still pass unedited
- [ ] A test drives two evictions of the same corpse and asserts one holder, one `LockHeld`, and one
      file left in the locks directory
- [ ] `src/app.ts` is unchanged

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, grep bans, and fake-tier tests. `pre-commit` is not a
substitute and does not check this package.

Nothing here is host-only — the eviction is filesystem-level and the fake tier reaches all of it.

## Comments

**2026-08-12 — closed.** PR #4476. `APPROVED` at review round 2; `npm run verify` green at the tip
with 181 tests, confirmed in a throwaway worktree at `c707e39a60`. `src/lock/witness.ts` is 103 lines
new, `run-lock.ts` +79, and `test/run-lock.test.ts` is **298/0** — so T4's four reclamation cases and
T20's claim cases are untouched rather than merely still passing. `merge-tree` against
`speepobox-t9` returns clean despite both branches editing `AGENTS.md`.

**The pass found a hole in this ticket's own prescription.** §3 said: link the corpse to a witness
keyed by the dead owner, and `AlreadyExists` means you lost. That is incomplete. A dispatch whose
read predates another's *whole* eviction finds the witness path free again by the time it links, so
its link succeeds — on the winner's **live** lock, minutes into that run's work. The fix is reading
the pid back out of the witness and refusing any generation other than the one this run found dead.
It is sound because the witness is a second name for the exact inode the link caught, and T20's claim
writes the pid before the name exists, so there is no empty-file window to misread. Round 2 recorded
the reasoning on the branch rather than leaving round 3 to re-derive it.

The second ruling is the bracket. `Effect.ensuring` around the eviction typechecks and is wrong: it
leaves the link interruptible, so a Ctrl-C landing mid-link strands a witness with no finalizer to
remove it — and a stranded witness refuses *every* later eviction of that corpse until T8's
reconciler exists. `Effect.acquireUseRelease` takes the link uninterruptibly and delivers the
interrupt to the eviction instead. Round 1 made this fix and **round 2 verified it by mutation** —
restoring the pre-fix file fails exactly one test and nothing else, which is stronger evidence than
re-reading the diff, and worth copying in later reviews.

No timeout and no age check anywhere, so SPEC §6's refusal of a second staleness rule over the lock
directory holds.

**One residual, deliberately not fixed here.** `releaseFile` now reads the owner before removing, and
`ownerOf` maps `NotFound` to `Option.none()` — so a lock file that is *already gone* at release takes
the else branch, emitting `Warned` and **no `ResourceReleased`**. Before T21 the force-remove
succeeded and the event fired. The new behaviour is the more honest one (this run released nothing,
and saying otherwise is the class of lie T21 exists to stop), but it is untested, unrecorded in
`AGENTS.md`, and its warning reads oddly for a file that does not exist: *"is no longer this run's —
it records no live pid, so it is left alone."* It does not affect T19, whose signal scenarios all
have the lock present at teardown. Pick it up whenever `run-lock.test.ts` is next open.

Sizing: 4 passes, 7 commits, 10.3M tokens — under half of T7's — with two review rounds, the second
changing nothing. The three
`Not-fixed` findings it settled — link `NotFound` typed as `LockError`, `isCollision` duplicated
across `claim.ts` and `witness.ts`, and `kill -9` wreckage left to T8 — all stand.
