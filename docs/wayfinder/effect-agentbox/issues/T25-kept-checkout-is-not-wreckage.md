# T25 — A checkout kept on purpose is not wreckage

Status: Done
Type: AFK
Blocked by: T8

Sequence: [ticket 08](../08-in-hae-sequence.md). A correctness fix to code already on the branch,
recorded as a `Not-fixed` finding by T8's own review round 2 and ruled the dispatcher's call rather
than a reviewer's. The dispatcher has now ruled, so it lands on its own — the same shape as
[T20](T20-atomic-lock-claim.md), [T21](T21-serialize-lock-eviction.md), and
[T24](T24-verdict-marker-precedence.md).

**Land before [T26](T26-stranded-eviction-witness.md), or after it.** Both edit the reconciler, and
that is where they collide. Neither collides with T11, T22, T23, or T24.

**Tracer: a checkout the run kept because its commits could not go home survives every later
dispatch.**

## What to build

One narrowing in `classify`, and the cases that pin it.

### 1. Two of the port's own behaviours contradict each other

`src/dispatch/checkout.ts`'s release always attempts the fetch-back, and reads keep-vs-delete off
whether it succeeded (05 Q10). When the fast-forward is refused, it keeps the directory and says so:

> the checkout's commits did not make it home (…) — leaving `<path>` for inspection; they are not on
> `'<branch>'`

Its comment is the whole reason the directory is still there: *"The commits are still in the
directory, which is the whole reason not to delete it."* At that moment the checkout holds the only
copy of the run's work — the fetch-back is the only path home, and there is no push until T11.

The lock is released **after** the checkout, by its own finalizer, unconditionally. So the run ends
leaving a checkout, no lock, and no container.

`src/reconcile/wreckage.ts`'s `classify` reads that state as `Reclaimable` — no lock to ask, no
running container to refuse — and `reconcile.ts`'s `removeCheckout` does the recursive removal. The
commits are gone, and no one asked.

### 2. This is not the parity it looks like

bash removes checkouts too (`run.sh:1245`), and T8 generalized that to all slugs on purpose. But
bash cleared a stale checkout **only on the next dispatch of that same slug**, so the person who lost
the commits was the person who chose to dispatch that branch again. The reconciler sweeps every slug
on every preflight, so an unrelated dispatch of an unrelated branch takes it, minutes later. This
sequence dispatches in parallel as a matter of course.

### 3. The rule

**A checkout with no lock beside it is reported, never reclaimed.**

The lock is the first resource a run takes and the last it releases, so a run killed at any point
leaves a lock beside its checkout. **A lone checkout is therefore proof that the release ran** — the
run ended in an orderly way and left that directory deliberately.

Genuine wreckage is unaffected: a checkout that still has its lock is classified exactly as it is
today, on the three conditions of §2, and the `kill -9` tracer still reclaims all three resources.

### 4. The second cause of a lone checkout, and why it does not change the rule

`checkout.ts` also leaves a lone checkout when the fetch-back **succeeded** and the removal then
failed — it warns *"could not remove the checkout at `<path>` … '`<branch>`' already has its
commits."* That directory really is disposable, and under this rule it is not reclaimed either.

Accept that. The two causes reach the same state on disk and nothing distinguishes them there, so the
choice is which way to be wrong: keep a disposable directory and report it every preflight, or delete
an irreplaceable one in silence. §2 of T8 already picks that direction for the resource case
("reported rather than reclaimed"), and this is the same call. P4's `gc` is where a human removes
what the reconciler will not, and T8's review already named it as the escape hatch for its other
unreclaimable case.

The report must say which directory and that nothing was touched, so `gc` has something to act on.

## Not in scope

`gc` itself, in any form. The derived release in `checkout.ts` — it is correct and this ticket does
not touch it. The three conditions in §2 of T8, the witness sweep ([T26](T26-stranded-eviction-witness.md)),
and the lock primitives.

## A shape that looks right and is not

**Do not add a keep flag.** `checkout.ts` forbids one in terms — *"There is no keep flag here and
there must never be one: a flag is a second answer to 'did this run's work survive' that can disagree
with the fetch that actually knows."* A marker file written by the keep path is that flag wearing a
hat, and it also fails on the path that matters most: a run killed before it could write the marker
leaves the checkout with no marker, which is the deletion this ticket exists to stop.

The evidence this rule reads — a lock, or its absence — is written by the lock's own finalizer and
needs nothing new on disk.

## Read first

`src/reconcile/wreckage.ts` (`classify`) and `src/reconcile/reconcile.ts` (`removeCheckout`, and the
loop that builds `RunWreckage`), `src/dispatch/checkout.ts` — the release in full, both branches —
and `src/dispatch/run.ts` for the order the three resources are acquired and released in.
`test/reconcile.test.ts` asserts "reclaims a checkout left on its own" today; that case is the one
this ticket inverts, and it should be rewritten rather than deleted. `AGENTS.md`, and
**SPEC §4 (lines 176–249) and §11 (470–606)** — those ranges, not the whole file.

**Already on the branch — do not rewrite** T1–T11's, T20's, or T21's modules. **Do not touch hae
files.**

## Effect wiring

- **Tags introduced**: none. **Tags consumed**: unchanged — this is a narrowing in a pure function
  and one arm of the loop that calls it.
- **Layer composition**: unchanged. `AppLive` and `AppBaseLive` are byte-unchanged.
- **Errors**: none. A reported checkout is a `Reporter` event, as every other reconciler finding is.

## Acceptance criteria

- [ ] A checkout with no lock is reported and left on disk, whatever the container state
- [ ] The report names the directory and says nothing was removed
- [ ] A checkout **with** a lock is classified exactly as before — the `kill -9` case still reclaims
      all three resources on the three conditions of T8 §2
- [ ] `test/reconcile.test.ts`'s "reclaims a checkout left on its own" is inverted, not deleted, and
      says in its name why a lone checkout is kept
- [ ] A case pins the whole path: a run whose fetch-back cannot fast-forward keeps its checkout, and
      a following dispatch's reconcile leaves that directory where it is
- [ ] `AGENTS.md` records the ruling — the lock is taken first and released last, so a lone checkout
      proves the release ran
- [ ] `AppLive` and `AppBaseLive` are byte-unchanged; no tag is introduced

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, grep bans, and fake-tier tests. `pre-commit` is not a
substitute and does not check this package.

**Host-only**, run by the user before landing:

Dispatch a throwaway branch, and while it runs commit to that same branch in the host repo so the
fetch-back cannot fast-forward. The run must end leaving the checkout, with the warning naming it.
Then dispatch a *different* throwaway branch and confirm the first checkout is reported and still
there — and that `docker ps -a` filtered by our labels is still empty, so the narrowing did not
weaken the container half.
