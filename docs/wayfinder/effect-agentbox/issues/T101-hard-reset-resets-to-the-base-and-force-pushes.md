# T101 — `--hard-reset` resets to the base and force-pushes

Status: Done (PR #60)
Type: AFK
Blocked by: none.

<!--
P4 (09 Q5). SPEC §7's `--hard-reset` row: *destructive: reset to base and redo; push becomes
`--force-with-lease`. Default is continue-from-tip.* The `--base` row: `BASE_SHA` is resolved once,
after the fetch, and is "the ref `--hard-reset` (P4) resets to". Decision 14, lesson 7:
`--hard-reset` makes the base the effective tip.

Oracle: `run.sh:156-159` (the flag's contract), `run.sh:1286-1312` (the discard count, the TTY
confirm, the reset, the merge-base), `run.sh:2104-2109` (the lease), and `run.sh:2305` (the
dry-run fork-point line). **One bash behaviour is not carried:** bash runs `git branch -f` *before*
it takes the lock (`run.sh:1302`). Here the guard phase holds nothing and writes nothing but the
fetch (matrix row 1, T70), so the reset happens under the lock.

Decisions (the user, 2026-09-24, P4 quiz):
- **D1 (A)**: the host branch is reset with a compare-and-set `update-ref` after the lock and
  before the clone, staged `checkout`. The clone, the land, the salvage, and `thisRun` then work
  unchanged. The cost: a run that fails after the reset leaves the branch rewound, and the old
  commits are on `origin` and in the reflog.
- **D3**: off a terminal, or with `--no-input`, the flag is the consent and the dispatch proceeds.
  That is this ticket's behaviour everywhere. The TTY confirm is T102.
- **D5**: `--resume` / `--last` with `--hard-reset` is refused, from the command line alone.
- **D6**: the ledger row records the discarded tip. That is split out to
  [T104](T104-the-row-records-the-discarded-tip.md) so this ticket fits one context; this ticket
  only leaves the tip where T104 can read it: in the reset event and on the plan.
- **D7**: the lease is pinned to where `origin/<b>` stood after the guard phase's fetch, and
  expects the ref **absent** when origin has no such branch.

**Placement found while slicing (2026-09-24), not in the quiz.** The reset cannot come before
`checkout()`. The acquire's clear-my-own-path (`clearKept`, `checkout.ts:463`) salvages a kept
copy of this slug first, and its fast-forward onto a branch that was just reset to the base would
put the old commits straight back, silently undoing the reset. So the reset goes **inside the
acquire**, after that salvage and before `repo.clone`. The compare-and-set against the guard-read
tip turns "the salvage just moved the branch" into a failed run at stage `checkout`, with the
salvaged commits safe on the branch, instead of a silent undo. The user approved this placement on
2026-09-24, and ruled that the failure says what happened and tells the dispatcher to run again
(§4).

The feature arm is T103's. This ticket refuses `--feature` with `--hard-reset` so it can land
without it.
-->

## What to build

**`bessemer <spec> --branch b --hard-reset` throws away the branch's commits since the base, runs
from the base, and force-pushes with a pinned lease. Without the flag, nothing changes.**

### 1. The flag

- `dispatch/command.ts`: declare `Options.boolean("hard-reset")` beside `allowStaleDispatcher`,
  with a description that says it is destructive. The request carries it as `hardReset`.
- The flag is **not a modifier** (bash counts only `--dry-run` and `--allow-stale-dispatcher`,
  `run.sh:716-717`), so `isModifiersOnly` does not change. It **is** a flag that is not a picker
  step, so `seedFor`'s `words` in `picker/seed.ts` carries `--hard-reset` through when it was
  typed, beside `--allow-stale-dispatcher`. The same sentence goes into SPEC §7's "the flags that
  are not steps" list.
- **D5**: beside `taskStatedOnce` in `dispatch/guards.ts`, in the same argv-only slot in
  `dispatch.ts` (ahead of the ledger), add the refusal for `--resume` or `--last` with
  `--hard-reset`. The detail says a resume continues a branch's recorded work and a hard reset
  discards it, so pick one. A `GuardRefused`, holding nothing.
- Also refuse `--feature` with `--hard-reset` in the same slot, saying the feature arm is not
  built yet. T103 deletes this refusal. Nothing else refers to it.

### 2. The guard phase decides the reset

In `dispatch.ts`, after `resolveBranchTip` and **before** anything reads `tipSha`, under
`hardReset`:

- `originTip`: `Git.revParse({ repo: repoRoot, rev: "refs/remotes/origin/<b>" })`, read after
  `originFetched`, so it is what origin holds now. A failure reads as **absent**. That is the safe
  direction: a lease expecting absence refuses to overwrite a remote branch that does exist.
- `discarding` counts **every commit the reset and the push discard, on both ends**: the commits
  reachable from the guard-read tip **or** from `originTip`, and not from `baseSha`. This is
  `git rev-list --count ^<baseSha> <tip> [<originTip>]`, one union. (Ruled 2026-09-24, from the
  implementing agent.) The reason: the pinned lease (D7) overwrites whatever `origin/<b>` held, so
  commits that exist only on origin are discarded too. That happens when the local branch is
  behind or beside its remote. A count of `base..tip` alone misses them, and can read 0 while the
  push destroys work, so T102 would ask nothing. bash has the same gap (`run.sh:1289` counts
  `$BASE_SHA..$BRANCH_REF`).

  `Git.countCommits` takes one `from..to` range today. Widen it, or add a read beside it, so that
  it takes one exclusion and several tips. Name the repo per T27. **Do not add two counts
  together**: `base..tip` plus `base..originTip` counts their shared history twice, and that
  shared history is the ordinary case, because a pushed branch and its remote share everything.
  With `originTip` absent, the union is `base..tip`.
- The **effective tip is `baseSha`** and the **merge-base is `baseSha`**. Everything below
  receives these, as bash sets `MERGE_BASE="$BASE_SHA"` (`run.sh:1300`). The tip the guards read
  is kept only as the reset's expected old value.

A `discarding` of 0 is still a hard reset. The branch may be *behind* or *beside* the base, and
it is still reset and lease-pushed, as bash does.

### 3. The plan carries it

- `DispatchPlan` gains `reset: Option<{ discardedTip, discarding, originTip: Option<string> }>`.
  `discarding` is the union count above,
  a `Schema.Option` like `logPath`. `planFor` takes it. `tipSha` and `mergeBaseSha` are the base
  under a reset.
- `renderPlan` (`dispatch/render.ts`) adds one row under a reset only, after `diff boundary`.
  For example: `fork point:     hard reset to <baseRef> — discards <n> commit(s) on '<b>' and
  origin/<b> (reflog-recoverable only)`. Name `origin/<b>` only when `originTip` is `Some`. With no reset, the plan block is byte-identical to today's.

### 4. The reset, under the lock

In `checkout.ts`'s `acquire`, **after** `if (kept) { yield* clearKept; }` and **before**
`repo.clone`, when `plan.reset` is `Some`:

- `Git.updateRef({ repo: repoRoot, ref: "refs/heads/<b>", to: plan.baseSha, from: discardedTip })`.
  Its failure is a `GitError`, staged `checkout` (matrix row 5's shape), and the run's row is
  owed. Nothing was cloned, so nothing is removed.
- **The failure's sentence says why the branch moved**, which means `clearKept` has to answer
  with the `Salvage` it got rather than `void`:
  - **After a salvage that answered `WentHome`**, the kept copy's commits went onto `'<b>'` a
    moment ago. The sentence names the branch and says that an earlier run's copy of it held
    commits and this dispatch just moved them onto `'<b>'`. Those are commits the discard count
    this dispatch printed never included. Nothing was reset and the commits are safe on the
    branch. **Run the dispatch again**: it will count them before it discards anything.
  - **Otherwise**, `'<b>'` moved after the guards read it at `<short discardedTip>`, and
    something other than this dispatch moved it. Nothing was reset. Run the dispatch again to
    count what is there now.

  Both sentences stay a `GitError`'s `detail`, and git's own words follow them.
- On success, emit a new `Reporter` event, for example `BranchReset { branch, from, originTip,
  to, discarding }`. It reaches the log, which is the audit trail, with **both** discarded tips
  as full SHAs: the local one and origin's, when there was one. The log is where origin's tip is
  recorded; T104's row field stays the local tip alone. It is
  **not** a step notification (AGENTS.md: a new event is not one by default).

### 5. The push

- `Git.push` gains an optional lease: absent means today's argv exactly, and present carries
  `expect: Option<string>`. Present renders `--force-with-lease=refs/heads/<b>:<sha>`, or
  `--force-with-lease=refs/heads/<b>:` when `expect` is `None`, which git reads as "must not
  exist".
- `land.ts` passes the lease when `plan.reset` is `Some`, with `expect` = `originTip`. Nothing
  else in `land` changes. `preTip` is read after the reset, so it is the base and `thisRun` counts
  this run's commits.
- `dry-run/git.ts`'s `recordingGit` records `updateRef` (it spreads the live tag today, so without
  an override a rehearsal would **reset the branch for real**) and records the lease in its `push`
  line. `IssueStoreLive` holds its own `Git`, so T77's status commit is unaffected.

### 6. SPEC and AGENTS

- SPEC §7: mark the `--hard-reset` row built (T101). Say where the reset happens and why (D1, and
  the salvage ordering above), that the lease is pinned (D7), the resume refusal (D5), and that
  off a TTY the flag is the consent (D3). State that the discard count is the union over the
  local tip and origin's.
- SPEC §12, the ported-with-divergence list: the discard count includes commits only on
  `origin/<b>`, which bash's `$BASE_SHA..$BRANCH_REF` misses.
- SPEC §11: add a failure-matrix row for "the reset's compare-and-set fails": released checkout
  (nothing cloned) and lock; `failed` (checkout); typed `GitError`, whose detail tells the
  dispatcher to run again (§4).
- AGENTS.md, *The checkout and the land*: one bullet for the placement. The reset stands after
  the acquire's salvage and before the clone, as a compare-and-set against the guard-read tip.
  The wrong shape that typechecks is a reset before `checkout()`, which the salvage silently
  undoes.

### 7. Tests

- `test/dispatch.test.ts`:
  - the plan under a reset (effective tip, merge-base, `reset`);
  - the discard count as a union, in three cases: the branch ahead of origin; the branch behind
    origin, where origin-only commits are counted; and no branch on origin. The shared history is
    counted once;
  - the D5 refusal and the temporary `--feature` refusal, each holding nothing;
  - with no flag, the plan is unchanged.
- `test/checkout.test.ts`:
  - the reset runs after the salvage and before the clone, in the order a recording `Git` sees;
  - a compare-and-set failure is `checkout`-staged;
  - a kept copy whose salvage moves the branch makes the compare-and-set fail, nothing is
    cloned, and the failure carries the salvage sentence from §4;
  - a compare-and-set failure with no kept copy carries the other sentence.
- `test/land.test.ts`: the lease argument for both `originTip` arms. A non-reset push's argv is
  unchanged.
- `test/git.test.ts`: `push`'s two lease renderings, and the union count's argv.
- `test/dry-run.test.ts`: a rehearsal records the reset and the leased push, and makes neither.
- The plan block's reset row, and its absence without a reset.

## Effect wiring

- **Tags introduced or consumed**: consumes `Git` (`countCommits`, `revParse`, `updateRef`,
  `push`) and `Reporter`. No new tag.
- **Layer composition**: unchanged. Rehearsal stays a layer swap: no op learns about `--dry-run`,
  and the recording `Git` answers for the reset.

## Acceptance criteria

- [ ] `--hard-reset` parses, rides through a seeded picker's words, and is refused with
      `--resume`, `--last`, or `--feature`, holding nothing.
- [ ] Under the flag, the plan's tip and diff boundary are `baseSha`, and the plan block has the
      fork-point row with the discard count. Without it, the plan block is byte-identical.
- [ ] The discard count is every commit reachable from the guard-read tip or `originTip` and not
      from `baseSha`, counted once. A branch behind its remote counts the origin-only commits.
- [ ] The reset event names both discarded tips, the local one and origin's when there was one.
- [ ] The host branch is moved to `baseSha` by one `update-ref` expecting the guard-read tip,
      after the acquire's salvage and before the clone. A mismatch fails the run at stage
      `checkout` and writes its row.
- [ ] The push is `--force-with-lease=refs/heads/<b>:<originTip>`, or the empty-expect form when
      origin had no branch. A dispatch without the flag pushes with today's argv.
- [ ] A compare-and-set failure after a `WentHome` salvage says the salvage moved commits onto
      the branch that the discard count never included, and says to run the dispatch again. With
      no kept copy, it says the branch moved since the guards read it.
- [ ] `--dry-run --hard-reset` records the reset and the leased push, and the branch does not
      move.
- [ ] SPEC and AGENTS.md are updated as in §6.

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package.

Host-only, after the gate, on a throwaway branch with commits past its base:

```
node src/bin.ts <spec> --branch <throwaway> --hard-reset --dry-run
```

The plan shows the discard count and `git rev-parse <throwaway>` is unchanged afterwards.
