# T32 — The salvage verifies what it reports

Status: Done
Type: AFK
Blocked by: T31

Sequence: [ticket 08](../08-in-hae-sequence.md). Two correctness fixes to code already on the branch,
both found by running [T28](T28-redispatch-clears-its-own-kept-checkout.md)'s host-only Verify steps
on a real host (2026-08-17) — the steps the agent could not run and both review rounds handed back to
the dispatcher. The same shape as [T20](T20-atomic-lock-claim.md), [T21](T21-serialize-lock-eviction.md),
[T22](T22-sandbox-gone-from-the-daemon.md) and T28 itself.

**Neither defect was introduced by T28.** The home fetch arrived with
[T29](T29-rescue-branch-for-commits-that-cannot-go-home.md); the `-C` idiom with
[T27](T27-every-git-read-names-its-repo.md). T28 lifted the salvage into one function both ends call,
which is what made both reachable on the way *in* as well as on the way out — wider blast radius, same
bugs.

**Collides with [T31](T31-a-rescued-run-says-so-on-its-row.md) in `src/dispatch/checkout.ts`.** T31
reads the salvage's answer to put it on the ledger row; this changes which answer it gives. Sequence
them — T31 first, then this.

**Tracer: the salvage says "these commits are on X" only after reading X, and a path that is not a
repository is reported as a path that is not a repository.**

## What to build

### 1. Two reads the salvage does not make

Both defects share one shape: the salvage states a fact about a repository it did not read.

#### A. A refused fast-forward is not proof the commits are homeless

`salvage` (`src/dispatch/checkout.ts`) fetches `refs/heads/<branch>:refs/heads/<branch>` into the host
repo, fast-forward only, and treats **any** failure as "the branch would not take them" — falling
straight through to the rescue.

Fast-forward-only refuses two different situations, and only one of them wants a rescue:

| The copy's tip, relative to the branch | git refuses because | What is true | What happens today |
| --- | --- | --- | --- |
| diverged | histories disagree | the commits exist only in the copy | rescue — correct |
| **already an ancestor** | the fetch would rewind the branch | **the commits are already on the branch** | rescue — wrong |

The second row is ordinary, not exotic: T29's release already fetched the commits home, so anything
that then moves the branch forward — a merge, a hand commit, the dispatcher's own `Status: Done`
commit once the port writes one — puts the branch ahead of the copy it came from.

Observed, running T28's Verify step 3 on 2026-08-17:

```
git log --oneline t28-wedge-check..t28-wedge-check-from-run-adc0415
```

Empty. The rescue branch held nothing; `adc0415946` was already on `t28-wedge-check`.

Two things go wrong when this fires. Rescue refs accumulate holding nothing anyone needs to look at,
and — worse, because it is what a human acts on — the refusal and the kept-checkout notice both say
the commits *would not go onto* the branch while they are sitting on it.

hae's bash dispatcher carried the identical defect in `cleanup()`'s salvage fetch, where it made every
successful run report a diverged branch. Fixed 2026-08-17 in `8f3f513ee0` by asking the ancestry
question before falling back to the fetch. Same shape, same fix, different language.

#### B. `-C` names a directory, and a directory is not a repository

`inRepo` in `src/git/git.ts` is `git("-C", repo, ...)`. `-C` changes directory; git then **discovers**
the repository by walking up. So a checkout path that holds no repository resolves to the nearest
enclosing one — and `checkouts/` lives inside the host repo's working tree, so that is always the host
repo.

Observed, running T28's Verify step 4 on 2026-08-17. The refusal proposed
`t28-rubble-check-from-run-df9ed13` for a directory containing one empty file. `df9ed134c4` is the host
repo's `refs/heads/t28-rubble-check`:

```
git -C .bessemer/checkouts/t28-rubble-check rev-parse --short refs/heads/t28-rubble-check
df9ed134c4
```

The comment above that call states the property it is meant to have:

> The tip is read in the clone and not in the repo (T27): the repo's copy of this branch is a
> different commit, and it is the copy's tip that names the branch these commits are going onto.

It read the repo's copy. The message then says the rescue is "named after the commits" while naming a
commit from an unrelated branch.

The consequence is contained **today** — the fetches fail anyway, so nothing is created, and the cost
is a message that lies. The reason to fix it is that T27's invariant is weaker than it reads: "every
git read names its repo" is implemented as naming a *path*, and every `inRepo` call against a path
that might not be a repository inherits the hole. The salvage on the way in is exactly such a call, by
design — the whole point is that it runs before anyone knows what is there.

### 2. The rule

**The salvage reads before it reports.** Two properties, and each maps to one defect:

1. **Already-contained commits went home.** Before minting a rescue, ask whether the copy's tip is
   already reachable from the branch in the host repo. When it is, the answer is `WentHome` — no
   rescue ref, no warning, nothing for a human to merge.
2. **Every read against the checkout path names the repository.** A path holding no repository fails
   as a path holding no repository, and the failure never resolves to a different repo.

### 3. The `Git` surface

The ancestry question is asked **in the host repo**, about a commit that reached it via the home
fetch — so on the path that matters the object is present. Handle the case where it is absent as
**not contained**: a tip the host repo has never seen is exactly a tip whose commits are only in the
copy, which is the rescue's case.

Add one member to `GitShape` for the containment question rather than composing it out of `mergeBase`
at the call site: the salvage's decision is the one answer this ticket exists to make honest, and the
tag is where T27 put every other question of this kind. `GitLive` stays
`Layer.Layer<Git, never, CommandExecutor.CommandExecutor>` — no new requirement.

## Shapes that look right and are not

**Ask ancestry after the fetch fails, not instead of it.** The fetch is what actually moves the
commits in the common case, and it is one round trip. Keep it first; the new read runs only on the
failure path, where a second git call costs nothing anyone will notice.

**Compare the two tips for equality rather than ancestry.** Equal tips are one case of contained;
branch-is-ahead is the case that bit us, and equality misses it.

**Ask the containment question in the copy.** The copy cannot know what the host repo has. Read the
tip in the copy — that part of T27's rule is right and stays — and ask about containment in the host.

**Fence the discovery walk with `GIT_CEILING_DIRECTORIES`.** `exec.ts`'s allowlist is
`extendEnv: false` with a comment requiring one note per variable saying which child reads it; a
per-call environment variable is a change to that seam, for a property git will assert directly if
asked.

**Widen the `Salvage` union with a fourth arm for "already there".** It is the same outcome as
`WentHome` for every consumer — the commits are on the branch, the copy is finished with, there is
nothing to tell a human. T31 reads this union; a fourth arm is a ledger value that means the same as
an existing one.

## Not in scope

**The rescue refs already on this host.** `t28-wedge-check-from-run-adc0415` and any sibling are
manual-testing residue, deleted by hand.

**Whether a redundant rescue ref should be pruned later.** This ticket stops minting them. Cleaning up
refs that already exist is a separate question, and nobody has asked it yet.

## Read first

- `src/dispatch/checkout.ts` — `salvage`, and both callers (`acquire`'s pre-clone salvage,
  `release`'s).
- `src/git/git.ts` — `GitShape`, `inRepo`, `revParse`, `mergeBase`.
- [T29](T29-rescue-branch-for-commits-that-cannot-go-home.md) §3 for the rescue-naming rule, which
  this ticket leaves intact, and §5 for the human-facing text these answers feed.
- [T27](T27-every-git-read-names-its-repo.md) for the invariant defect B weakens.

**Already on the branch — do not rewrite** T1–T13's, T18's, T20–T31's modules beyond what these two
fixes need.

## Effect wiring

- **Tags introduced or consumed**: `Git` (consumed; one member added to `GitShape` and `GitLive`).
- **Layer composition**: unchanged. `GitLive` keeps its existing signature and the entrypoint's
  composition is untouched:

```ts
Layer.Layer<Git, never, CommandExecutor.CommandExecutor>
```

## Acceptance criteria

- [ ] A copy whose tip is already reachable from the branch answers `WentHome`, mints no rescue ref,
      and emits no warning — asserted by a test that moves the branch ahead of the copy.
- [ ] A copy whose tip has diverged from the branch still answers `Rescued`, on a ref named by T29's
      existing rule.
- [ ] A copy whose tip is unknown to the host repo answers `Rescued`, not an error.
- [ ] A git read against a path holding no repository fails naming that path, and resolves to no other
      repository — asserted by a test whose fixture path sits inside a repository.
- [ ] The refusal and kept-checkout texts are reached only on the paths that are still true of them;
      no text asserts commits are absent from a branch that has them.
- [ ] `npm run verify` green, with the test count above T28's 362.

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package.

**Host-only**, run by the dispatcher before landing, because only a real git refuses a real
fast-forward. Both replay a T28 Verify step whose outcome this ticket changes.

1. **The branch-is-ahead case now goes home.** From the repo root, with a tracer dispatch already
   landed on a throwaway branch:
   ```
   git commit --allow-empty -m "move the branch ahead"
   ```
   Re-dispatch that branch from the repo root and confirm the run reports the commits went home, mints
   no `-from-run-` ref, and removes the copy:
   ```
   git branch --list '*-from-run-*'
   ```
   Lists nothing new.

2. **A non-repository is reported as itself.** Replay T28's Verify step 4 — a directory holding one
   ordinary file at the checkout path — and confirm the refusal names that path and proposes no ref
   named after a commit from the host repo:
   ```
   git branch --list '*-from-run-*'
   ```
   Lists nothing new, and the refusal text names no `-from-run-` branch at all.
