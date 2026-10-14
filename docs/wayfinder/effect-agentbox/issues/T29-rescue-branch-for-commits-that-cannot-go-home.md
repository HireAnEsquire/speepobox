# T29 — Commits that cannot go home get a branch, not a directory

Status: Done
Type: AFK
Blocked by: T25, T27

Sequence: [ticket 08](../08-in-hae-sequence.md). A usability fix that turns out to be a correctness
simplification, raised by the dispatcher while reviewing [T25](T25-kept-checkout-is-not-wreckage.md)'s
messages: the run tells a human that its commits are stranded in a directory and then asks them to
perform a git operation to get them out. The tool can perform that operation itself, and the reason it
did not is that nobody asked whether the *destination* had to be the branch the run was given.

**Collides with [T28](T28-redispatch-clears-its-own-kept-checkout.md) in `src/dispatch/checkout.ts`** —
T28 edits `acquire`, this edits `release`. Sequence them; do not run them concurrently. **Read
[§6](#6-what-this-does-to-t28) before dispatching T28**, which this ticket demotes.

Light collision with [T26](T26-stranded-eviction-witness.md) in `src/reconcile/`: T26 edits
`reconcile.ts`'s witness sweep, this edits one string in `wreckage.ts`'s `keptCheckoutNotice`.
Different functions, but land one before the other.

**Tracer: a run's work ends up somewhere a human can merge from, every time, without being told how.**

## What to build

### 1. What happens today

The release attempts one fetch, `refs/heads/<branch>:refs/heads/<branch>`, fast-forward only. When the
agent tidied its own commits before finishing — a rebase, an amend, a reset, all of which are ordinary
things for a run to do — that refspec cannot fast-forward, so the fetch refuses. The release then
keeps the whole clone and warns, because the clone is the only copy of the commits.

T25 made that safe: the reconciler reports such a directory rather than sweeping it. T28 makes the
branch re-dispatchable. Both are correct, and both are working around the same thing — that the
commits are sitting in a directory instead of in the repository.

The cost is paid three times over. The directory stays (`.agentbox/checkouts/speepobox-t11` measured
**1.0G**), and nothing but a human removes it. A lone checkout means two different things — a refused
fetch, or a successful one whose `fs.remove` failed — and nothing on disk tells them apart, so T25's
notice has to hand the reader a diagnostic procedure. And the reader must be taught what a checkout
*is* before any of it makes sense.

### 2. The observation

`git fetch` refuses a non-fast-forward update. It does **not** refuse to create a ref that does not
exist yet — the fast-forward check applies only to refs already present. So the exact case that
refuses `refs/heads/<branch>:refs/heads/<branch>` succeeds unconditionally as
`refs/heads/<branch>:refs/heads/<branch>-from-run-<short>`.

The commits go into the repository. The clone becomes disposable and is removed by the ordinary path.
The human gets a branch, and `git log`, `git diff`, `git merge`, and `git cherry-pick` all work on it
with no explanation of anything.

### 3. The rule

**The release's salvage tries the branch it was given, then a branch of its own, and keeps the clone
only when neither works.**

| The release's fetch | What happens |
| --- | --- |
| `<branch>` fast-forwards | unchanged from today: the commits are home, remove the clone |
| refused, and the rescue ref takes them | remove the clone, and report **which branch holds them** |
| refused, and the rescue also fails | keep the clone and warn, as today, saying both were tried |

This is the derived release (05 Q10) with one more question in the chain, not a new kind of answer:
keep-vs-delete still falls out of what the fetches did, there is still no flag, and nothing above the
release records an opinion for it to read. The third row is what keeps the finalizer honest — the
release still never fails the scope (design rule 4, matrix row 18), and a rescue that cannot be
written is exactly as loud as a fetch that could not go home is today.

**The rescue ref is named from the commits, not from the clock.** `<branch>-from-run-<short sha>`,
where the SHA is the clone's `HEAD`. Two consecutive failed runs on one branch leave two rescue
branches, which is right — they are different work. A rerun that somehow produced the same tip finds
the ref already at that SHA and the fetch is a no-op, so the operation is idempotent rather than
collision-prone.

### 4. The `Git` surface

`fetchBack` currently hard-codes the destination as the source:

```
git("-C", into, "fetch", from, `refs/heads/${branch}:refs/heads/${branch}`)
```

Generalize the destination rather than adding a second method or an optional field. One operation,
one refspec, and the two call sites differ only in where they are sending the commits:

- `FetchBackOptions` gains `onto: string` — the branch to land them on.
- The home fetch passes `onto: branch`. The rescue passes `onto: <branch>-from-run-<short>`.
- **No `+`, no `--force`, on either.** The home case must stay fast-forward-only, and the rescue
  destination does not exist, so it needs no force. If a rescue ref somehow *does* exist and is not an
  ancestor, the fetch refuses — which is the right answer, because clobbering a previous rescue is the
  one way this design can lose work.
- The failure detail names both ends. `could not fast-forward '<onto>' from <from>` already reads
  correctly for both, because `onto` is what could not move.

`Git.revParse` reads the clone's `HEAD`, which is why this is blocked by
[T27](T27-every-git-read-names-its-repo.md): `revParse` runs with no `-C` today and answers about
whichever repo the process happens to be sitting in. Reading the clone's tip through it before T27
lands is writing the bug T27 exists to remove.

### 5. What the human sees

The long notice T25 shipped becomes the rare path. The common one is one line:

> this run's commits could not go onto `'speepobox-t25'`, so they are on
> `'speepobox-t25-from-run-a1b2c3d'` — merge or cherry-pick from there whenever you like. Nothing was
> lost, and the run's copy of the repository has been cleaned up.

The kept-clone warning stays as written in T25, with one clause added saying the rescue branch was
attempted too and why it did not work. `keptCheckoutNotice` in `src/reconcile/wreckage.ts` needs the
same clause: a lone checkout no longer means "the fetch would not fast-forward", it means "neither
destination would take them, or the removal failed".

**The run's outcome does not change.** The land already failed at stage `land`
([T11](T11-land-push.md)), the ledger row already says so, and the exit code is already nonzero. The
rescue decides where the commits live, never whether the run succeeded — a run whose work did not
reach the branch it was given has not done what it was asked, and saying otherwise because the commits
were parked somewhere is the one way this ticket could make things worse.

### 6. What this does to T28

T28 exists because a kept checkout wedges its own branch: `acquire` clones unconditionally and `git
clone` refuses a destination that exists, so a branch whose land failed cannot be dispatched again
until a human removes the directory.

Under this rule the release keeps a directory only when *both* destinations refused, which is a broken
repo or a broken disk rather than the routine rebase. T28's machinery — a retried fetch-back before the
clone, a refusal at stage `checkout`, a ledger row for it — is then a fair amount of surface for a case
that should approach never.

T28 is **not** cancelled by this ticket, and this ticket does not touch `acquire`. But it should be
re-read after this lands, and it is a live candidate for **Out of scope** on the map. That is the
dispatcher's call, not this agent's: do not edit, close, or reference T28 as decided.

## Shapes that look right and are not

**Do not move the rescue into the land.** T11 ruled why the land and the release both fetch: the
land's fetch asks the question at the one point where the answer is an *outcome*, and the release's is
the salvage every exit path gets. A rescue is salvage. Putting it in the land makes a failed land
partially succeed, which is §5's error in a different place.

**Do not force into a fixed `<branch>-from-run`.** It typechecks, it is shorter, and two consecutive
failed runs on one branch silently destroy the first one's commits — the exact loss this whole ticket
exists to prevent.

**Do not reach for the clock to make the name unique.** Host reads live at the composition root
(`AGENTS.md`), so a timestamp would have to be threaded from `bin.ts` into a finalizer. The SHA is
already in the repository, needs no plumbing, and makes the operation idempotent, which a timestamp
does not.

**Do not skip the home fetch and rescue every time.** The overwhelmingly common case is a clean
fast-forward onto the branch the human asked for, and that is where they want the work. The rescue is
what happens when that is impossible, never instead of it.

**Do not remove the clone before the rescue fetch.** It reads *from* the clone. Removing first
destroys the commits along with the answer.

**Do not hide the rescue refs under `refs/bessemer/…` or any other namespace.** It keeps `git branch`
tidy and defeats the entire purpose: a ref the human does not see is a ref they will not merge. This
is a branch, in `refs/heads/`, on purpose.

**Do not let a failed rescue fail the scope.** A failing Effect finalizer becomes a defect and masks
the run's own error (design rule 4, matrix row 18). The third row of §3's table warns and swallows,
exactly as the second row does today.

## Not in scope

`acquire` and the re-dispatch clearing — T28's, untouched here. `classify` and the `Kept` verdict —
T25's rule stands unchanged; the only edit in `src/reconcile/` is the wording of
`keptCheckoutNotice`. Cleaning up rescue branches, in any form: they are cheap refs, `git branch -d`
removes one, and an automatic sweep of branches holding unmerged work is a much worse version of the
problem this ticket is solving. `gc` in any form. The stopped container T25's review leaves
unreclaimed.

## Read first

`src/dispatch/checkout.ts` in full — `release` is what this edits and its comments carry the derived-
release reasoning this extends. `src/git/git.ts`'s `fetchBack`, `revParse`, and `clone`.
`src/dispatch/land.ts` for the *other* fetch and why it is not this one. `src/reconcile/wreckage.ts`'s
`keptCheckoutNotice` — one string, and `classify` beside it **for context only, not to edit**.
`AGENTS.md`, and **SPEC §4 (lines 176–249) and §11 (470–606)** — those ranges, not the whole
file.

`test/checkout.test.ts` holds the release's cases in both directions, including an end-to-end
`runInScope` with a failing fetch-back followed by a reconcile over the world it leaves. Every case
this needs is a variation on those, and `test/support/git-fake.ts` already writes a `.git/HEAD` on
clone.

**Already on the branch — do not rewrite** T1–T11's, T20's, T21's, T22's, or T25's modules beyond what
§3 and §4 require of `checkout.ts`, `git.ts`, and the one string in `wreckage.ts`. Amend `AGENTS.md`
only with a ruling you had to discover. **Do not touch hae files.**

## Effect wiring

- **Tags introduced**: none. **Tags consumed**: `Git`, `Reporter`, `FileSystem` — unchanged, all three
  already in `checkout`'s signature. `Git` gains no method; `FetchBackOptions` gains a field.
- **Layer composition**: unchanged. `AppLive` and `AppBaseLive` are byte-unchanged and `src/app.ts` is
  not edited.
- **Errors**: no new error type. The rescue's failure is a `GitError` the release **swallows into a
  `Warned`**, as the home fetch's already is — it must not reach the scope. **No new ledger row and no
  change to the existing one**: the land already wrote `failed` at stage `land`, and where the commits
  were parked afterwards is not an outcome.

## Checkpoint order

The `onto` generalization in `git.ts` lands first, with both call sites passing `onto: branch` and no
behaviour change anywhere — `npm run verify` green on a pure refactor. Then the release's second
fetch, with its three cases. Then the messages and the `wreckage.ts` clause. The end-to-end case that
walks a run from a refused land to a merged rescue branch is the last checkpoint.

## Acceptance criteria

- [ ] A release whose home fetch fast-forwards behaves exactly as today: clone removed, one
      `ResourceReleased`, no second fetch attempted — asserted through the fake's recorded calls
- [ ] A release whose home fetch is refused fetches the same commits onto `<branch>-from-run-<short>`,
      removes the clone, and reports the rescue branch **by name**
- [ ] The rescue ref is derived from the clone's `HEAD`, so two failed runs on one branch leave two
      distinct rescue branches and neither overwrites the other
- [ ] Neither fetch passes `+` or `--force`, and a rescue ref that exists at a conflicting commit is a
      refusal rather than a clobber
- [ ] A release where both fetches fail keeps the clone, warns, names both destinations it tried, and
      **does not fail the scope** — the run's own error still reaches the caller unmasked
- [ ] The run's outcome is untouched in every case: a land that failed still writes `failed` at stage
      `land` and still exits nonzero, whether or not a rescue branch was written
- [ ] `keptCheckoutNotice` says a kept copy now means both destinations refused or the removal failed
- [ ] `classify` and the rest of `src/reconcile/` are unchanged, and `checkout.ts`'s `acquire` is
      untouched — this ticket edits `release` only
- [ ] `AGENTS.md` records the ruling: the salvage tries the branch it was given, then one of its own,
      and the clone is kept only when neither takes the commits
- [ ] `AppLive` and `AppBaseLive` are byte-unchanged; `src/app.ts` is unedited; no tag is introduced

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, grep bans, and fake-tier tests. `pre-commit` is not a
substitute and does not check this package.

The fake tier reaches all three rows of §3's table: `git-fake.ts` already fails a fetch on demand, and
failing only the *first* refspec is one more option on it.

**Host-only**, run by the user before landing, because only a real git refuses a real non-fast-forward.
Dispatch a throwaway branch and commit to that same branch in the host repo while it runs, so the
commits cannot go home. Then check that:

1. the run fails at stage `land` and exits nonzero, exactly as it does today;
2. `git branch --list '*-from-run-*'` shows one new branch, and `git log` on it holds the run's commits;
3. `.agentbox/checkouts/<slug>` is **gone** — no directory, no notice about one;
4. merging that branch into the original is an ordinary merge with no further instructions;
5. dispatching the same branch again works immediately, with no human cleanup in between.
