# T107 — A branch that cannot be read sends the salvage to the rescue

Status: Done (PR #69. Host check 2026-09-30: a `--task` run on `hc-107` was killed with `kill -9` after the agent's first commit, and `hc-107` was then deleted. `gc --force` removed the checkout with the `BranchUnread` sentence. Only `hc-107-from-run-<short>` existed afterwards, holding the agent's commit.)
Type: AFK
Blocked by: none.

<!--
MAP.md's *Not yet specified*, "The salvage onto a branch that no longer exists" (D11), ruled by the
user on 2026-09-29.

The gap. `salvage` (`dispatch/checkout.ts:307`) fetches `refs/heads/<b>:refs/heads/<b>` first, and
git creates an absent destination unconditionally (AGENTS.md, T29). So when a human has deleted
`<b>` since the copy was made, the salvage brings the branch back, answers `WentHome`, and the
caller removes the copy. It is reachable at two of the three call sites:
- **the release**, for the whole length of a run;
- **the acquire's clear-my-own-path**, only through a race: `branchExists` runs before the lock,
  and nothing holds the ref in between.

T100's `gc --force` took the conservative arm instead: it reads `refs/heads/<b>` first and skips a
copy whose branch is gone, loudly (`gc/force.ts:107-122`, `absentBranchNotice`).

Decisions (the user, 2026-09-29):
- **A branch that cannot be read is not a destination.** The salvage reads `refs/heads/<b>` in the
  served repo **before** its first fetch. **Any** failed read, not only absence, goes straight to
  the rescue `<b>-from-run-<short>`. The containment read after that fetch still authorizes the
  removal (T38), unchanged.
- **`Rescued` says why.** Every rescue sentence says the commits "would not go onto `<b>`", which
  is false when `<b>` is not there. `Rescued` gains
  `because: { _tag: "Refused" } | { _tag: "BranchUnread"; detail }`, with `detail` in git's words,
  and every rendering branches on it.
- **One function, three call sites** (T28). `gc --force` drops its skip and calls `salvage` like the
  release and the acquire do. `absentBranchNotice` and `absentBranchRecovery` are deleted.
- **The ledger is unchanged.** The row keeps `rescuedOnto` alone. The reason changes only how the
  run log renders it, so `CURRENT_SCHEMA_VERSION` does not move (T31).
- **The read-then-fetch window is accepted.** A branch deleted between the read and the fetch is
  still recreated. That window is human-deletion timescale, and closing it would need a primitive
  git does not have.
- **Out of scope**: the land's own fetch onto `<b>` (`land.ts:95`), which recreates a branch deleted
  mid-run. Recorded in MAP.md's *Out of scope*. T29: the rescue lives in the release, never the
  land.
-->

## What to build

**The salvage never recreates a branch the served repo cannot read. It sends the commits to a
rescue branch named from the commits, removes the copy only when a read proves they landed there,
and every sentence about the rescue says why the branch was not used.**

### 1. `salvage`

In `dispatch/checkout.ts`, at the top of `salvage`, before `home`:

```ts
const branchRead = yield* Effect.either(
  repo.revParse({ repo: repoRoot, rev: `refs/heads/${plan.branch}` }),
);
```

- **`Right`**: everything below runs as today. A rescue reached from here carries
  `because: { _tag: "Refused" }`.
- **`Left(error)`**: skip the fetch home and the containment read on `<b>` entirely. They would
  create the branch, or ask about a ref that is not there. Read the copy's tip as today, name the
  rescue from it, fetch onto the rescue, and ask the rescue's containment question as today.
  - Landed: `{ _tag: "Rescued", onto, because: { _tag: "BranchUnread", detail: error.detail } }`.
  - Not landed: the existing `RescueUnverified` arm.
  - Rescue fetch refused, or no tip: `Kept`. The `Unmoved` arms `RescueUnverified` and `Refused`
    currently carry `home: GitError`, which was the branch fetch's refusal. On this path there was
    no branch fetch, so widen `home` to say what happened to the branch attempt:
    `Refused { home: GitError } | Unread { detail }`. Pick the smallest shape that lets each
    sentence quote the right git error. Do **not** invent a fake `GitError` for a fetch that never
    ran.

Update the long comment above `salvage` to say the destination is asked about before it is
fetched onto, and why: an absent destination is created unconditionally.

### 2. `Rescued` carries its reason

```ts
export type RescueReason =
  | { readonly _tag: "Refused" }
  | { readonly _tag: "BranchUnread"; readonly detail: string };

| { readonly _tag: "Rescued"; readonly onto: string; readonly because: RescueReason }
```

One helper renders the clause, for example `rescueBecause(branch, because)`:

- `Refused`: `its commits would not go onto '<b>'` (today's words).
- `BranchUnread`: `'<b>' could not be read here (<detail>), so its commits were not sent there`.

Use it at all three sentences that say "would not go onto" today:

- `checkout.ts` clearKept's `Warned` (around `:529`);
- `releaseClone`'s rescue `Warned` (around `:694`). `releaseClone` takes `Option<string>` today.
  Pass the reason alongside, or pass the `Rescued` value;
- `gc/notices.ts`'s `rescuedLine`.

`Ref.set(rescued, Option.some(salvaged.onto))` is unchanged. The row records where the commits
are, not why.

### 3. `gc --force`

In `gc/force.ts`'s `salvageCheckout`, delete the `revParse` pre-read and the `absentBranchNotice`
arm. A copy with a branch name goes straight to `salvage`. Delete `absentBranchNotice` and
`absentBranchRecovery` from `gc/notices.ts`, along with the D11 comments that explain the skip.
Replace them with one line saying the salvage itself never recreates a branch (T107).

### 4. SPEC and AGENTS.md

- SPEC §7's `gc` row: replace T100's D11 sentence (*a checkout whose branch the served repo no
  longer has is skipped, never recreated*) with: the salvage sends such a copy to a rescue branch,
  and never recreates the branch (T107).
- SPEC, wherever the release's two-destination rule is stated (search for `-from-run-`): add that
  a branch the repo cannot read is not a destination.
- AGENTS.md, *The checkout and the land*, first bullet (the T29 one): add one sentence — *A branch
  the served repo cannot read is not a destination: the salvage asks before it fetches, because the
  fetch would create it, and goes straight to the rescue (T107).*

### 5. Tests

- `test/checkout.test.ts`, on the `Git` fake:
  - The branch read fails: **no `fetchBack` onto `<b>`**. Assert on the recorded calls. There is
    one onto `<b>-from-run-<short>`, and `Rescued` has `because: BranchUnread` carrying git's
    words.
  - The branch read fails and the rescue does not land: `Kept` with `RescueUnverified`, and the
    directory stays.
  - The branch read fails and the rescue fetch is refused: `Kept`, and the sentence quotes the
    rescue's git error and the read's, with no mention of a branch fetch.
  - The existing refused-fast-forward case now has `because: Refused`, and its sentence is
    unchanged.
  - The release and the acquire each render the `BranchUnread` clause.
- `test/gc.test.ts`: the old absent-branch case asserted *no* `fetchBack`. It now asserts a rescue
  fetch, removal on landing, and the `BranchUnread` sentence. Delete what referred to
  `absentBranchNotice`.

## Effect wiring

- **Tags introduced or consumed**: `Git`, which `salvage` already requires. No new tag.
- **Layer composition**: unchanged.

## Acceptance criteria

- [ ] `salvage` reads `refs/heads/<b>` in the served repo before it fetches. On any failed read it
      never fetches onto `<b>`.
- [ ] On a failed read the commits go to `<b>-from-run-<short>`, and the copy is removed only
      when the containment read on that ref says they landed.
- [ ] `Rescued` carries `because`, and every rescue sentence at the release, the acquire, and `gc
      --force` says why, in git's words for `BranchUnread`.
- [ ] `gc --force` calls `salvage` for every copy with a branch. `absentBranchNotice` is gone.
- [ ] The ledger record and `CURRENT_SCHEMA_VERSION` are unchanged.
- [ ] SPEC and AGENTS.md say it.

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package.

Host-only, after the gate, by the dispatcher: dispatch a `--task` run on a throwaway branch
`<b>`, and `kill -9` it after the agent's first commit. Delete `<b>` with `git branch -D <b>`, then
run `node src/bin.ts gc --force`. The checkout must be removed. `git branch --list '<b>*'` must
show `<b>-from-run-<short>` holding the agent's commit and no `<b>`. The sentence must say `'<b>'`
could not be read.
