# T28 — A re-dispatch salvages and clears its own kept checkout

Status: Done
Type: AFK
Blocked by: T25, T29

Sequence: [ticket 08](../08-in-hae-sequence.md). A correctness fix to code
[T25](T25-kept-checkout-is-not-wreckage.md) is landing, recorded as a `Not-fixed` finding by its
review round 1 and ruled the dispatcher's call. The dispatcher has ruled. The same shape as
[T20](T20-atomic-lock-claim.md), [T21](T21-serialize-lock-eviction.md), and T25 itself — except that
this one closes a wedge T25 opens rather than one that was already there.

**Amended after [T29](T29-rescue-branch-for-commits-that-cannot-go-home.md) landed**, which changed
this ticket twice over: it made a kept checkout much rarer, and it replaced the remedy. What follows
is the amended ticket; where it disagrees with a reader's memory of the earlier one, this is the
version that counts.

**[T31](T31-a-rescued-run-says-so-on-its-row.md) is blocked behind this one** — both edit
`src/dispatch/checkout.ts`, and this one moves the code T31 reads from, so T31 carries this ticket
as a blocking edge. No collision with [T26](T26-stranded-eviction-witness.md) or
[T30](T30-the-image-declares-its-own-inputs.md): T26 edits the reconciler and T30 edits the probes.

**Tracer: a branch that kept a checkout is re-dispatchable without a human touching anything, and
the commits in it are somewhere named before the directory goes.**

## What to build

The salvage `checkout.ts` already runs on the way out, run once on the way in.

### 1. What T25 fixes, and what it costs

T25 is right: a checkout with no lock beside it is `Kept`, reported and never reclaimed, because the
lock is taken first and released last and a lone checkout proves the release ran. Sweeping it deletes
the only copy of a run's work, minutes later, on an unrelated dispatch of an unrelated branch.

T25's own review named the price:

> the kept checkout is never swept, so re-dispatching that same slug fails at `git clone` until a
> human removes it, and `gc` doesn't exist yet

That is worse than accumulation. `acquire` in `src/dispatch/checkout.ts` clones into
`plan.checkoutPath` unconditionally, and `git clone` refuses a destination that exists. So **a branch
whose land failed cannot be dispatched again at all** — not with a warning, not degraded, at all —
until a human finds the directory and removes it. The one branch you most want to re-run is the one
you cannot.

### 1b. What T29 changed, and what it left

T29 gave the release a second destination: the fetch home, then — when that is refused — a fetch onto
`<branch>-from-run-<short sha>`, a ref no commit holds yet, which git creates unconditionally. Only
when *neither* takes the commits is the directory kept.

That retires the common cause of a kept checkout. An agent that rebased inside the copy used to be
the routine way to wedge a branch; now it rescues and the directory goes. What survives is narrower,
and the two survivors are not the two this ticket originally sorted:

- **The removal failed.** The commits went home — or onto a rescue branch — and `fs.remove` then
  could not delete the tree. T29's `releaseClone` warns exactly this. The directory holds nothing
  irreplaceable and wedges the branch for no reason at all. **This is now the case T28 mostly exists
  for**, and it is untouched by T29.
- **Neither destination took the commits.** A broken repo or a broken disk rather than the routine
  rebase, since the rescue ref cannot refuse for the ordinary reason. Rare, and the copy really is
  the only place the work exists.

So T28 is not retired. But its remedy is: "clear it once the commits can go home" was written when
going home was the only door. There are two doors now, and the second one always opens.

### 2. Why the reconciler is the wrong place to fix it, and this is the right one

T25 §2's argument is about *whose* dispatch does the deleting. bash cleared a stale checkout only on
the next dispatch of **that same slug** (`run.sh:1161-1162`), so the person who lost the commits was
the person who chose to dispatch that branch again. T8 generalized that to every slug on every
preflight, and generalizing it is what made it dangerous.

So the fix is not to weaken T25. It is to give the slug's **own** re-dispatch back the authority bash
always gave it, and leave the sweep over other slugs exactly as T25 leaves it. The reconciler is not
edited by this ticket.

It also cannot be a guard. `guards.ts` says why, about this exact operation:

> `--base` is resolved, not fetched: `git fetch origin` is a write to this repo's remote-tracking
> refs and belongs to the checkout step (T18), on the far side of the guards.

A guard that writes is not a guard — matrix row 1 is that a refusal touches nothing. This belongs
inside the `Scope`, under the run's own lock, at the moment the path is about to be used, which is
also the only moment at which nothing else may be holding it.

### 3. The rule

**A kept checkout is cleared by the next dispatch of its own slug once its commits are somewhere
named — the branch, or a branch of the dead run's own.** Only a directory neither destination will
take refuses that dispatch, and then nothing is touched.

Before the clone, when `plan.checkoutPath` already exists, **run the release's own salvage against
it** — home, then the rescue, exactly as T29 wrote it — and then:

| The salvage | What happens |
| --- | --- |
| went home | the commits are on the branch; remove the directory, say so, and clone |
| rescued | the commits are on `<branch>-from-run-<short sha>`; remove the directory, name that branch, and clone |
| neither | the commits are still only in there — fail the run at stage `checkout`, naming the directory and that nothing was removed |

**This is one function, not two.** The salvage is currently a closure inside `checkout`; lift it to a
named function that both ends call, taking the plan and the repo root and answering *where the
commits ended up*. The two call sites differ only in what they do with that answer: the release
warns and swallows, because a finalizer that fails becomes a defect (rule 4, matrix row 18); the
acquire refuses, because a dispatch that cannot clear its own path has not started. **Copying the
two fetches into `acquire` is the failure mode this ticket is most likely to produce** — a second
salvage drifts from the first, and the one that drifts is the one nobody watches run.

This is not a new rule. It is `checkout.ts`'s own derived release (05 Q10) asked at the other end:
*keep-vs-delete falls out of what the fetches did, and there is no second answer.* The release asks
it about the run that is ending; this asks it about the run that already ended.

### 4. What each of the two causes does under it

T25 §4 established that two different runs leave a lone checkout and nothing on disk tells them
apart. Under this rule they still do not need to be told apart — the salvage separates them by
asking, and each gets the right answer. §1b's amended pair:

- **The removal failed** (T29's `releaseClone` warning: *"this run's commits are safely on
  `<branch>` … but its copy of the repository could not be cleaned up"*). The commits are already
  wherever the dead run put them, so the retried fetch home is a fast-forward over zero commits and
  succeeds. Removed, cloned, dispatched. **This is the case that wedges a branch for no reason at
  all**, and the one this mostly exists for.
- **Neither destination took the commits** (the kept-checkout warning). Both fetches refuse again,
  so the run refuses. Nothing is lost, and the human is told exactly which directory holds work and
  that it is why the dispatch stopped.

There is also a third, which only exists because this ticket runs after T29 rather than instead of
it: **a directory the dead run kept, whose commits a later state of the repo now accepts.** The
branch moved, or the disk recovered. The salvage sends them home or rescues them, the directory
goes, and the dispatch proceeds — a case the pre-T29 wording would have refused forever.

**This is strictly safer than bash**, which cleared unconditionally and would have destroyed the
second case. It is also strictly safer than the pre-T25 reconciler, for the same reason — and
strictly *less* obstructive than this ticket's own first draft, which refused every case the rescue
now clears.

## Shapes that look right and are not

**Do not add a flag, a marker, or a probe that decides deletion.** `checkout.ts` forbids the first in
terms — *"a flag is a second answer to 'did this run's work survive' that can disagree with the fetch
that actually knows"* — and an "is this directory a real repo" or "does it hold unpushed commits"
read is the same object in a different coat. There is one question and the fetch is how it is asked.

**Do not remove the directory before the salvage.** Both fetches read *from* it, and so does the
`rev-parse` that names the rescue; removing first destroys the answer along with the commits, and
turns every case into the disposable one.

**Do not write a second salvage.** §3. One named function, two call sites, differing only in what
they do with the answer.

**Do not rescue onto a name of this run's choosing.** The branch is named from the commits in the
directory (T29), which are the dead run's, not this one's. A name derived from the live dispatch —
its slug, its start time, its base — would put two different runs' work under one ref the second
time it happened.

**Do not make the refusal a guard.** §2. A guard holds nothing and writes nothing, and this writes.

**Do not extend this to other slugs.** The whole distinction is that a re-dispatch of this branch is
a human choosing this branch. A pass that clears a *neighbouring* slug's kept checkout is the
reconciler behaviour T25 exists to stop, rebuilt in a new place.

**A directory the fetch cannot read at all refuses, and that is deliberate.** Rubble from a clone
that died mid-write is indistinguishable here from a repo whose branch will not fast-forward, and the
safe direction is the one that keeps it. Say so in the refusal so the reader knows `rm -rf` is theirs
to run; P4's `gc` is where that stops being manual.

## Not in scope

The reconciler and `classify` — T25's rule stands unchanged and this ticket does not touch
`src/reconcile/`. The release's *behaviour* in `checkout.ts`, which is T29's and changes not at all
here: this ticket moves that code, it does not alter what it does. `gc` in any form, `--hard-reset`,
and the stopped container T25's review also leaves unreclaimed — that one is a resource-level partial
reclaim and is its own question. **Recording the rescue on the ledger row is
[T31](T31-a-rescued-run-says-so-on-its-row.md)**, not this: a salvage on the way *in* belongs to the
dead run, which has already written its terminal row and will never write another.

## Read first

`src/dispatch/checkout.ts` in full — both `acquire` and `release`, and the comments on each, which
carry the reasoning this extends — plus `src/dispatch/run.ts` for the order the three resources are
taken in and how a step inside the scope is staged, `src/git/git.ts`'s `clone` and `fetchBack`, and
`src/reconcile/wreckage.ts`'s `classify` **for context only, not to edit** — the `Kept` verdict there
is what this ticket assumes and preserves. `src/dispatch/guards.ts`'s comment on `resolveBaseSha` is
§2's citation. `AGENTS.md`, and **SPEC §4 (lines 176–249) and §11 (470–606)** — those
ranges, not the whole file.

`test/checkout.test.ts` holds T25's end-to-end case — a real `runInScope` with a failing fetch-back,
then the reconciler over the world it leaves — and it is the closest existing shape to what this
needs: the same setup, followed by a *second* dispatch of the same slug rather than a reconcile. It
also holds T29's three release cases, and `test/support/git-fake.ts`'s `homeFetchBackFails` and
`cloneTip` options are what drive the salvage down each arm — the fake already does everything this
ticket's cases need, and needs no new option.

**Already on the branch — do not rewrite** T1–T13's, T20–T22's, T25's, T27's, or T29's modules
beyond what §3 requires of `checkout.ts`. Amend `AGENTS.md` only with a ruling you had to discover.
**Do not touch hae files.**

## Effect wiring

- **Tags introduced**: none. **Tags consumed**: `Git`, `Reporter`, `FileSystem` — unchanged, all
  three already in `checkout`'s signature.
- **Layer composition**: unchanged. `AppLive` and `AppBaseLive` are byte-unchanged and `src/app.ts`
  is not edited.
- **Errors**: the refusal is a `GitError` failing the run at stage `checkout` — the stage the run is
  already in, through the path a refused `clone` already takes. **A ledger row is owed**: `RunLock`
  was acquired, so SPEC §11's rule applies and the row is `failed` at stage `checkout`. No new error
  type, and no `GuardRefused` — that one promises no row.

## Checkpoint order

**Lift the salvage first, changing nothing else.** One named function, called from the release,
answering where the commits ended up; `npm run verify` green with T29's three release cases
untouched and still passing. That refactor is the whole risk in this ticket, and it is worth
reaching a green gate on its own before a second caller exists.

Then the call from `acquire`, with its own cases — the salvage that goes home, the one that rescues,
the one that refuses, and the path that does not exist at all, which must run no salvage and ask no
git question. The end-to-end case that dispatches the same slug twice is the third checkpoint.

## Acceptance criteria

- [ ] The salvage is **one function**, called by both the release and the acquire, and T29's three
      release cases pass unchanged against it
- [ ] A dispatch whose `checkoutPath` does not exist behaves exactly as it does today, and asks no
      extra git question — asserted through the fake's recorded calls
- [ ] A kept checkout whose commits now fast-forward home is removed, reported by name with the fact
      that the commits reached the branch, and the run proceeds
- [ ] A kept checkout whose commits will not go home is **rescued onto a branch named from those
      commits**, then removed, and the run proceeds — with the rescue branch named in what the
      dispatcher is told
- [ ] A kept checkout neither destination will take fails the run at stage `checkout`, leaves the
      directory untouched, and names it
- [ ] That refusal writes a `failed` row at stage `checkout` — the lock was held, so the row is owed
- [ ] The wedged case round-trips: a run whose commits landed but whose removal failed is
      re-dispatchable without a human touching anything
- [ ] Two re-dispatches that each rescue leave **two** branches, for the reason T29 gives — the name
      is read from the directory's commits, never from the live run
- [ ] Nothing new is written to disk to decide any of it, and no probe other than the fetches decides
      removal
- [ ] `src/reconcile/` is unchanged — T25's `Kept` verdict and the sweep over other slugs both stand
- [ ] `AGENTS.md` records the ruling: the slug's own re-dispatch may salvage and clear its checkout,
      the sweep over other slugs may not, and the fetches are the only thing that decides
- [ ] `AppLive` and `AppBaseLive` are byte-unchanged; `src/app.ts` is unedited; no tag is introduced

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, grep bans, and fake-tier tests. `pre-commit` is not a
substitute and does not check this package.

The fake tier reaches all of it: both states are directories on disk and both can be written
directly, exactly as T25's cases write theirs.

**Host-only**, run by the user before landing. **Staging a kept checkout is harder than it was**, and
that is T29 working: committing to the branch in the host repo mid-run no longer keeps the
directory, it rescues and removes it. The two cases have to be staged at the removal instead.

1. **The wedged case, which is the one that matters.** Dispatch a throwaway branch. While it runs,
   make the checkout's parent directory unwritable (`chmod 500` on `.bessemer/checkouts/` — the
   runtime root defaults to the package's own root during incubation) so the release's `fs.remove`
   fails after its fetch succeeds. The run must end reporting *"could not be cleaned up"* with the
   directory still there. Restore the permissions, then dispatch that branch again: the run must
   salvage over zero commits, remove the directory, say so, and complete normally — with no human
   `rm -rf` anywhere in between.
2. **The rescue on the way in.** Same as 1, but also commit to the branch in the host repo before
   re-dispatching, so the salvage cannot go home. The run must put those commits on
   `<branch>-from-run-<short sha>`, name that branch in what it prints, remove the directory, and
   complete normally. `git branch --list '*-from-run-*'` shows it; `git log` on it shows the dead
   run's commits.
3. **The refusal.** `mkdir` a directory at the checkout path holding no git repo at all, then
   dispatch that branch. The run must refuse at stage `checkout`, name the directory, leave it
   untouched, and write a `failed` row at stage `checkout` — this is the "rubble is
   indistinguishable, and the safe direction keeps it" rule under Shapes, checked on a real host.
