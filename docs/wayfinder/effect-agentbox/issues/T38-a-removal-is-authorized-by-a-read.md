# T38 — A removal is authorized by a read, not by a write's return value

Status: Done
Type: AFK
Blocked by: T15

Sequence: [ticket 08](../08-in-hae-sequence.md). One correctness fix to code already on the branch,
plus one decision T15 deferred. The same shape as
[T32](T32-the-salvage-verifies-what-it-reports.md) — and it is T32's own ruling, applied to the path
T32 did not reach.

**Collides with T15 in `docs/wayfinder/effect-agentbox/SPEC.md` §12 and `AGENTS.md`,** both
of which T15 amended and this narrows. Sequence them: T15 first, then this.

**Tracer: a checkout is removed only after a read says its commits are somewhere else, and a fetch
that reports success without moving anything removes nothing.**

## Context

### The rule already exists, on half the paths

T32 ruled that **the salvage says "these commits are on X" only after reading X**, and added the
ancestry question to `salvage` (`src/dispatch/checkout.ts`). Read where it sits:

```ts
const home = yield* Effect.either(fetchOnto(plan.branch));
if (Either.isRight(home)) {
  return { _tag: "WentHome" };
}
// ... the tip read, then branchContains, then the rescue
```

The read runs **only after the fetch refused**. T32's subject was a refused fast-forward being
mistaken for homeless commits, so that is the path it fixed. On the path where `fetchBack` returns
success, `salvage` reports `WentHome` on the strength of the return value alone — and the caller
then removes the directory those commits were in.

That is the same defect T32 named, one branch over. `fetchBack` returning success and the commits
being reachable in the destination repo are two different propositions. The second is the one an
irreversible `rm -rf` depends on, and nothing reads it.

This is not hypothetical hardening. A partial fetch, a refspec that lands somewhere unexpected, a
future change to `fetchBack`, or any bug in the live `Git` layer all produce a success return with
the commits still only in the copy — and the next line deletes them. The failure is silent and total:
the run reports `WentHome`, the release reports the resource freed, and the commits are gone.

### T15 made the failing case routine

T15's `--dry-run` is a layer swap: the seven mutating services record instead of acting. `Git` is one
of them, so on a rehearsal `fetchBack` **records and returns success** — the exact input this defect
needs. The removals do not stand behind a tag (`FileSystem` is used directly, SPEC §2), so they run
for real.

A rehearsal therefore deletes a dead run's leftover checkout on the strength of a rescue that never
happened. T15 documented this rather than fixing it, in `AGENTS.md`:

> the two `rm -rf`s that clear a *dead* run's leftovers … still run, **on the strength of a
> fetch-back that recorded rather than fetched**.

Deleting unpushed commits is the one outcome `--dry-run` exists to guarantee against, and the flag is
what makes a dispatcher comfortable running it.

### The three removal sites

| Site | Authorized by | Today |
| --- | --- | --- |
| `src/dispatch/checkout.ts` — clear-my-own-path, on the way in | `salvage` → `WentHome` | the fetch's return value |
| `src/dispatch/checkout.ts` — `releaseClone`, on every exit path | `salvage` → `WentHome` | the fetch's return value |
| `src/reconcile/reconcile.ts` — `removeCheckout`, the preflight sweep | nothing in that path | asserts it in prose |

The third is worth reading closely. Its own failure message says *"its commits are already home, so it
is safe to delete by hand"* — a claim about a repository, made where nothing read one.

## The ruling

**A removal is authorized by a read.** No directory is removed on the strength of a write's return
value; before every `rm -rf` of a checkout, a read confirms the commits are reachable from a ref
somewhere else. Where a read cannot confirm it, the directory stays and the run says why — the
`Kept` answer that already exists.

The question is the one T32 chose and for the reason T32 gave: **ancestry, asked in the destination,
about a tip read in the copy.** Equality is the wrong test — the branch standing ahead of the copy is
the ordinary case after any earlier fetch home.

**The dry-run consequence falls out; do not build for it.** Reads stay real in the recording layers
by design, so a recorded fetch fails the containment read, `salvage` answers `Kept`, and nothing is
removed — with no operation anywhere learning that a rehearsal is in progress. If this ticket adds a
branch on `--dry-run` inside an op it has failed, and `scripts/check-bans.ts` will say so.

**Cost.** One extra read per run on the path that previously took none. T32's comment already settled
the shape of this trade for the failure path — *"one more read on the path where that already failed
costs nothing anyone will notice"* — and the success path is one read against a clone, a container
start, and an agent pass.

## What to build

### 1. The containment read on the success path

`salvage` verifies before it answers `WentHome`, on both paths that can produce that answer, and the
two callers in `checkout.ts` inherit it unchanged.

Reuse what T32 built — the tip read and `branchContains` — rather than adding a second way to ask.
Restructure so the question is asked once, after either fetch attempt, instead of being duplicated
into the success arm.

Sharpen the reporting while you are there: a fetch that returned success but did not move the
commits is a **different** situation from a refused fast-forward, and the human-facing text should
not describe it as one. `Kept`'s message already tells a reader where to look and what to run; make
sure what it says is true for this arrival path too.

### 2. The reconciler's sweep

`removeCheckout` removes a dead run's checkout with no containment read at all, while its own error
text asserts the commits are home. Give that path the same authorization the other two get, or — if
reading the wreckage scan establishes it is already unreachable — say so in a comment naming what
establishes it. What must not survive is a sentence asserting a fact nothing read.

### 3. Decide and record: the run log

`openRunLog` (`src/run-log.ts`) rotates by `mv` — an existing non-empty log becomes `<branch>.log.1`
and a fresh one is written. It is not behind a tag, so a rehearsal does it for real: dry-running a
branch demotes that branch's last real run log and overwrites whatever `.1` held. Two rehearsals and
the last real run's log is gone.

Unlike the removals, **there is no postcondition to check** — rotation is a plain mutation with no
fact to verify — so no read fixes it. The entrypoint cannot route around it either: `openRunLog` is
called from `dispatch/run.ts:299`, deliberately after the lock, so the one place allowed to know
about `--dry-run` never sees it.

That leaves a real decision, and this ticket's job is to **make it and write it down, not to build
it**:

- **Put the run log behind a tag**, so the swap reaches it. Correct and uniform, and it closes SPEC
  §12's remaining `--dry-run` divergence — but introducing a tag to SPEC §2 is an issue-level
  decision and its own ticket, not a unit of this one.
- **Accept it**, on the grounds that one generation of one log file is a small stake and a rehearsal
  arguably belongs in the log.

Say which, and why, in `src/run-log.ts` beside `rotate`, and leave SPEC §12's divergence entry
describing exactly what is left after units 1 and 2 land. If the answer is the tag, open the
follow-up ticket rather than building it here — this ticket is sized to land in one pass and T15 did
not.

## Effect wiring

- **Tags introduced**: none. Unit 3 decides whether a later ticket introduces one.
- **Tags consumed**: `Git` only, and only operations that already exist — `revParse` and
  `branchContains`, both already used by `salvage`.
- **Layer composition**: unchanged. `src/app.ts` is not edited, and neither `AppLive` nor
  `AppDryRunLive` moves.

## Acceptance criteria

- [ ] A `fetchBack` that reports success without moving the commits leaves the checkout in place and
      the run reports where they still are — asserted with a `Git` fake, not reasoned about
- [ ] Both `checkout.ts` removal sites are reached only through that verified answer
- [ ] The reconciler's sweep either reads containment before removing, or names in a comment what
      already establishes it — and no message asserts a repository fact nothing in that path read
- [ ] The ordinary paths are unchanged: a real run that fetches home still removes its checkout, and
      a genuinely refused fast-forward still rescues exactly as T32 left it
- [ ] A `--dry-run` over a scratch world holding a leftover checkout removes nothing, and the
      checkout is still there afterwards
- [ ] No operation names `--dry-run`; `node scripts/check-bans.ts` exits 0
- [ ] The run-log decision is recorded in `src/run-log.ts`, and SPEC §12's `--dry-run` divergence
      entry describes only what actually remains

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package.

```
node scripts/check-bans.ts
```

Expected: exit 0.

**Host-only.** The end-to-end rehearsal needs a docker socket, which this container does not have.
Write it, leave it unrun, and name it in your final message:

```
git branch t38-leftover-check tseff
# stage a leftover: a checkout directory for that branch holding a commit that is not on it
node src/bin.ts <a spec> --branch t38-leftover-check --dry-run
```

Expected: the rehearsal refuses or reports the checkout kept, the directory is still on disk
afterwards, and its commit is still only in there.

## Notes

**Sizing.** T15 spent its whole 30-minute budget and tripped the dispatcher's *no file written after
10m* warning. This ticket is deliberately smaller: one read moved onto one more path, one audit, one
decision written down. Units 1 and 2 are each a green checkpoint on their own — land unit 1 with its
test before starting unit 2.

**Read T32 first.** It carries the ancestry-not-equality reasoning, the table of what a refused
fast-forward actually means, and the evidence from a real host on 2026-08-17. This ticket does not
restate it and does not overturn any of it.
