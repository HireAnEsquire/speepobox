# T27 — Every git read names the repo it reads

Status: Done
Type: AFK
Blocked by: T11

Sequence: [ticket 08](../08-in-hae-sequence.md). A correctness fix to code already on the branch,
recorded as a `Not-fixed` finding by T11's review, which named it precisely and declined it for the
right reason: the fix is T3-wide and T5-wide, and T11 was told not to rewrite either. The same shape
as [T20](T20-atomic-lock-claim.md), [T21](T21-serialize-lock-eviction.md),
[T22](T22-sandbox-gone-from-the-daemon.md), and [T25](T25-kept-checkout-is-not-wreckage.md).

**Collides with [T23](T23-one-credential-source.md) in `src/dispatch/guards.ts`.** Land one, then the
other. No collision with T12, T24, T25, or T26.

**Tracer: a dispatch launched from a working directory outside the repo behaves exactly as one
launched from the repo root.**

## What to build

The repo, named at every git read, the way it is already named at every git write.

### 1. Two answers to "which repo is this", and nothing makes them agree

The package resolves the repo root deliberately and once. `src/bin.ts:48` calls
`findRepoRoot(packageRoot)`, and `src/config/paths.ts` says why in terms:

> It is a host read, so it is called from the composition root and reaches commands as a parameter.

That value is what `fetchBack` receives as `into`, what `push` receives as `from`, and what
`src/ownership/labels.ts` hashes into `agentbox.repo` — the label every container and every
reconciler query is filtered on.

Four git **reads** ignore it and answer from the process's working directory instead:

| Read | Where | Who calls it |
| --- | --- | --- |
| `Git.revParse` | `src/git/git.ts` | `resolveBaseSha` (guards), `land.ts`'s `preTip` |
| `Git.worktrees` | `src/git/git.ts` | the branch guard, `guards.ts` |
| `Git.countCommits` | `src/git/git.ts` (T11) | `land.ts`, twice |
| `git("merge-base", …)` | `src/dispatch/guards.ts` | `resolveMergeBase` — straight through the chokepoint, not on the tag |

`git.ts`'s own comment states the rule the code follows:

> `-C <into>` rather than the working directory: this is the one git command that *writes* a ref into
> the dispatching repo, and which repo that is was resolved at the composition root

That reasoning is right about writes and silent about reads, and a read that answers for a different
repo than the write is the same defect as a write to the wrong one — it just fails later and quieter.

### 2. Why this is one ticket and not four

It is the **disagreement** that is the defect, not any single call. Adding `-C` to `countCommits`
alone would make `land` internally inconsistent, because it reads `preTip` through `revParse` two
lines above the count. Adding it to the tag's three but not to `resolveMergeBase` would leave the
diff boundary — the SHA the ledger row carries and every review round is scoped to — as the one
answer still coming from somewhere else. The rule is only worth anything without exceptions.

This is [T23](T23-one-credential-source.md)'s argument about a different fact: *two places
independently decide where something comes from, so whatever either concludes is unverified by the
other.* Same defect, same fix — one answer, passed down.

### 3. What goes wrong today, and what will go wrong later

Nothing is broken on the host this was written on: `speepobox/` sits inside hae, so a walk up from
the package and a walk up from the working directory land on the same repo. The bug is that they are
not made to.

The reachable case now is a **misleading refusal**. Launch a dispatch from anywhere that is not
inside the repo and `resolveBaseSha` fails, so the guard refuses with

> `--base '<ref>' does not resolve to a commit — fetch it first, or pass a ref that exists`

which blames the ref for a working-directory problem and sends the reader to fetch something that is
already there.

The worse case is **silent divergence**. The checkouts under `<runtimeRoot>/checkouts/<slug>` are
real clones. A read answering from inside one, while `repoRoot` still names the host repo, resolves
`--base` and the merge-base against the agent's clone — so the diff boundary written to the ledger,
handed to the agent's prompt, and used by every review round is a commit from a different repository,
and the ownership labels still say hae. Nothing reports a conflict, because nothing compares them.

Both of these arrive for real at **P1's hae probe and P6's adopter distribution**, where the package
stops living inside the repo it dispatches for. Fixing it now costs a mechanical change; fixing it
then costs it plus whatever was diagnosed wrongly first.

### 4. The rule

**Every git operation names the repo it runs in, reads no less than writes.** After this ticket there
is no git call in the package whose answer depends on where the process happened to start.

Make it unrepresentable rather than remembered: a read that can be spelled without a repo is one a
later ticket will spell that way. The writes already show the shape — `FetchBackOptions.into`,
`PushOptions.from` — so the reads growing the same required field is the smallest change that makes
forgetting a type error.

`resolveMergeBase` moves onto the `Git` tag as it goes. `guards.ts`'s own header licenses this: it
says the guards ask git "through the `Git` tag where it has the operation and through the subprocess
chokepoint where it does not", so giving the tag the operation is the path that comment describes.
It is also the last read outside the tag, and leaving it out is exactly the exception §2 rules out.

## A shape that looks right and is not

**Do not parameterize the layer.** `GitLive(repoRoot)` would capture the value once and read well,
and it changes `src/app.ts`'s graph — which every ticket in this sequence has kept byte-unchanged
because the graph is the thing reviews can no longer check by eye. It also puts a host fact inside a
layer that `status` composes without ever asking git anything (SPEC §7).

**Do not make the repo optional with a default.** A defaulted parameter is the current behaviour
wearing a type, and the one call site that forgets it is the one this ticket exists to prevent.

**Do not resolve the repo inside `git.ts`.** `findRepoRoot` is a host read and belongs to the
composition root (`config/paths.ts` says so). A second resolution inside the tag would be a third
answer to §1's question.

## Not in scope

`findRepoRoot`'s own walk, and whether it should consult `git rev-parse --show-toplevel` — it
deliberately does not, because `status` runs no git commands and the ownership label hashes its
result. The ownership labels, the reconciler, and every agent-facing service. Do not add a guard that
refuses a working directory outside the repo: the point of this change is that the working directory
stops mattering, and a guard about it would re-introduce the dependency as a check.

## Read first

`src/git/git.ts` in full — it is short, and its comments carry the write-side reasoning this ticket
extends to reads — plus `src/dispatch/guards.ts` (`resolveBaseSha`, `resolveMergeBase`, and the
branch guard around line 114), `src/dispatch/land.ts` (T11, all four reads in one function),
`src/config/paths.ts`'s `findRepoRoot`, and `src/bin.ts`'s composition root where `repoRoot` is
resolved. `AGENTS.md`, and **SPEC §2 (lines 92–141), §3 (142–175), and §7** — those ranges,
not the whole file.

`test/git.test.ts` and `test/support/git-fake.ts` are where the argv of every call is already
asserted; in `test/support/exec-fake.ts` the `recorded` ref holds every word of argv every child ran,
which is how "the repo is named" becomes an assertion rather than an intention. `test/dispatch.test.ts`
covers the guards, and `test/land.test.ts` (T11) covers the four reads that sit closest together.

**Already on the branch — do not rewrite** T1–T11's, T20's, T21's, or T22's modules beyond what §4
requires of the git reads and their call sites. Amend `AGENTS.md` only with a ruling you had to
discover. **Do not touch hae files.**

## Effect wiring

- **Tags introduced**: none. `resolveMergeBase` gains an operation on the existing `Git` tag and
  loses its direct `CommandExecutor` requirement — that is a narrowing of its signature, not a new
  service.
- **Tags consumed**: `Git` — unchanged everywhere else.
- **Layer composition**: unchanged. **`AppLive` and `AppBaseLive` are byte-unchanged, and
  `src/app.ts` is not edited.**
- **Errors**: unchanged. A read that fails is the `GitError` it is today; a guard that refuses
  refuses with the same `GuardRefused`. No refusal's wording changes except where §3 names one as
  misleading, and that one may improve.

## Checkpoint order

The tag's three reads plus their call sites reach `npm run verify` on their own — `git.ts`,
`land.ts`, and the two guards, with `resolveMergeBase` still shelling out. Land that first. Moving
merge-base onto the tag is the second checkpoint, and it is the one that changes a signature outside
`git.ts`.

## Acceptance criteria

- [ ] Every git operation in the package names the repo it runs in; no call's answer depends on the
      process's working directory
- [ ] The repo comes from the composition root's `repoRoot`, passed down — it is resolved in exactly
      one place, as it is today
- [ ] A read cannot be spelled without a repo: omitting it is a type error, not a convention
- [ ] `resolveMergeBase` is an operation on the `Git` tag and no longer requires `CommandExecutor`
      directly
- [ ] `land.ts`'s four git calls all name the same repo, asserted directly — the internal
      inconsistency T11's review named is gone
- [ ] The argv of each read is asserted through the fakes' `recorded` ref, including the repo it
      names
- [ ] A dispatch whose process starts outside the repo resolves the same base SHA, the same merge
      base, and the same worktree list as one started at the repo root
- [ ] `AGENTS.md` records the rule — the repo is a host fact resolved once and passed down, and reads
      are not an exception to that
- [ ] `AppLive` and `AppBaseLive` are byte-unchanged; `src/app.ts` is unedited; no tag is introduced

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, grep bans, and fake-tier tests. `pre-commit` is not a
substitute and does not check this package.

The fake tier reaches all of this — every assertion is about argv, and the fakes already record it.

**Host-only**, run by the user before landing. Run a dispatch of a throwaway branch **from a working
directory outside the repo entirely**, giving `node` an absolute path to `src/bin.ts`. It must
resolve the same base and boundary, clone, run, land, and push exactly as it does from the repo root,
and leave no lock, no checkout, and no container. Then run `node <abs>/src/bin.ts status` from the
same place and confirm it renders the same rows — it asks git nothing, and this change must keep it
that way.
