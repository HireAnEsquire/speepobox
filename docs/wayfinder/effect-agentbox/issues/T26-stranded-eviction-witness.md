# T26 — A stranded eviction witness must not wedge its slug forever

Status: Done
Type: AFK
Blocked by: T8

Sequence: [ticket 08](../08-in-hae-sequence.md). A correctness fix to code already on the branch,
recorded as a `Not-fixed` finding by T8's review, which scoped its own witness sweep to the half it
was licensed to reach. The other half needs `lock/witness.ts`, which T8 was not allowed to edit —
the same shape as [T21](T21-serialize-lock-eviction.md), which came out of T20's review for the same
reason.

**Land before [T25](T25-kept-checkout-is-not-wreckage.md), or after it.** Both edit the reconciler,
and that is where they collide. Neither collides with T11, T22, T23, or T24.

**Tracer: kill a dispatch in the instant between taking an eviction witness and removing the lock it
names, and the next dispatch of that branch still runs.**

## What to build

The one fact the reconciler is missing, and the sweep that uses it.

### 1. The wedge

T21's witness (`src/lock/witness.ts`) is a **hard link to the corpse lock file**, at
`<lockfile>.<deadowner>.evicting`. `link` refuses an existing destination, so `AlreadyExists` *is*
"another dispatch is already evicting this same corpse", decided by the kernel rather than by a read.
The witness is removed by the eviction that took it, on success, failure, and interrupt alike.

A dispatch killed between the link and the removal of the lock strands one. The state it leaves is a
lock with a dead owner **and** a witness beside it. From there:

- every later acquisition on that slug collides on the lock, reads the same dead owner, and links to
  the same witness path — `AlreadyExists`, forever, reported as a colleague's eviction in flight;
- the corpse is never removed, so its owner never changes, so the witness path never advances to a
  new generation.

The generation-keying in `witness.ts` was meant to keep an old witness from blocking a later corpse,
and it does — but only once the corpse has actually been replaced. Here it never is.

**The reconciler is wedged by this too, and that is what makes it permanent.** `reconcile.ts`'s
`reclaim` goes through `RunLock.acquire`, which is the very path that collides, so the pass that
exists to clear wreckage reports *"'`<slug>`' looked reclaimable, but its lock is not this
preflight's to take"* and moves on. Nothing on the host will ever clear it. That branch cannot be
dispatched again until a human deletes a file by hand.

### 2. Why T8 could not settle it

T8 sweeps a witness only when the lock it names is **gone** (`isDebris` in
`src/reconcile/wreckage.ts`: `!lockExists && !ownerIsAlive(owner)`). That is the half the evidence
reaches.

A witness lying *beside* its lock cannot be told from an eviction in flight, because **the witness
records the corpse's pid, never the evictor's** — it is a second name for the corpse file, so its
contents are the corpse's contents. There is no pid on disk anywhere naming the process that took it,
and an eviction in flight belongs to a dispatch that holds no lock yet by definition.

Sweeping on lock-presence alone would remove a live eviction's witness and hand the same corpse to
two dispatches at once, which is exactly what T21 exists to prevent.

### 3. The rule

**A witness whose evictor is not alive is debris, whether or not the lock it names is still there.**
Everything else is reported and left.

That needs a fact the disk does not currently carry, so this ticket adds it: **the evictor's identity
must be discoverable beside the witness, without disturbing the link.** The shape I expect is a
sibling marker naming the evictor's pid — created by the evictor before it takes the link, removed
with the witness, and read by the reconciler's sweep. A witness with no live evictor beside it is
debris; a witness with one is an eviction in flight and is left alone.

Refute that shape if it does not survive contact — the property in bold is the requirement, the
sibling marker is a proposal. Whatever you land, record the reasoning in `AGENTS.md` beside T20's and
T21's rulings, because this is the third correctness fix to the same primitive and the next reader
needs the set.

Fold T8's existing rule in rather than keeping two: a witness whose lock is gone and whose evictor is
gone is debris by the same sentence.

## 4. Shapes that look right and are not

**Do not put the evictor's pid in the witness path.** `<lockfile>.<deadowner>.<evictorpid>.evicting`
records exactly what is missing — and destroys the exclusivity that is the entire mechanism. Two
evictors would compute two different destinations, both links would succeed, and both would remove
the same corpse. The witness path must stay a pure function of the lock file and the dead owner.

**Do not write into the witness.** It is a hard link, so the witness and the lock are one file. A
write to the witness is a write to the lock, and `claim.ts` and the reconciler both read that lock's
contents as the owner.

**Do not make acquisition tolerate a colliding witness.** Treating `AlreadyExists` as "probably
stale, proceed anyway" un-serializes eviction and reinstates the double-remove T21 was written to
close.

**Do not settle it with a timeout you cannot justify.** An "old enough to be stale" witness is a
staleness heuristic of exactly the kind T20 replaced with an atomic primitive. If you conclude that a
bound on eviction duration is the only available answer, say so explicitly in `AGENTS.md` with the
bound's reasoning — do not slip one in as a constant.

## Not in scope

`gc`, the three liveness conditions, the kept-checkout narrowing
([T25](T25-kept-checkout-is-not-wreckage.md)), and every agent-facing service. T20's claim primitive
is correct and is not reopened.

## Read first

`src/lock/witness.ts` in full — the comments carry the reasoning this ticket extends —
`src/lock/claim.ts`, `src/lock/run-lock.ts`'s acquisition path, `src/lock/liveness.ts`
(`ownerIsAlive` is the shared predicate, T8), and the witness half of `src/reconcile/reconcile.ts`
with `isDebris`/`witnessLockName` in `src/reconcile/wreckage.ts`. In `test/run-lock.test.ts`,
`describe("the liveness predicate")` and the eviction cases; in `test/reconcile.test.ts`, the witness
sweep cases. `AGENTS.md`, and **SPEC §3 (lines 142–175) and §4 (176–249)** — those ranges,
not the whole file.

**Already on the branch — do not rewrite** T1–T11's, T20's, or T21's modules beyond what the rule in
§3 requires of `witness.ts` and the reconciler. **Do not touch hae files.**

## Effect wiring

- **Tags introduced**: none. **Tags consumed**: unchanged — `FileSystem` / `Path` directly, as both
  modules already take them.
- **Layer composition**: unchanged. `AppLive` and `AppBaseLive` are byte-unchanged.
- **Errors**: unchanged. A sweep that cannot read the lock directory reports and reclaims nothing; it
  never fails the dispatch it precedes.

## Acceptance criteria

- [ ] A witness stranded beside its lock by a killed evictor is swept, and the next acquisition on
      that slug succeeds
- [ ] A witness taken by a **live** evictor is left alone, asserted directly — the case that would
      hand one corpse to two dispatches
- [ ] The rule is one sentence covering both halves: T8's lock-is-gone case falls out of it rather
      than sitting beside it
- [ ] The witness path stays a pure function of the lock file and the dead owner, and nothing is
      written into the witness
- [ ] Acquisition still refuses on a colliding witness — T21's serialization is unchanged
- [ ] A reconcile that meets a wedged slug clears it, so the pass that exists to clear wreckage is no
      longer stopped by wreckage
- [ ] `AGENTS.md` records the mechanism and why the shapes in §4 were refused
- [ ] `AppLive` and `AppBaseLive` are byte-unchanged; no tag is introduced

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, grep bans, and fake-tier tests. `pre-commit` is not a
substitute and does not check this package.

The fake tier reaches all of this: the wedge is a state on disk, and the cases can write it directly
rather than racing for it. **Host-only**, run by the user before landing: create the stranded state
by hand under the runtime root — a lock naming a dead pid, plus its witness — then dispatch that
branch and confirm the run proceeds and says what it swept.
