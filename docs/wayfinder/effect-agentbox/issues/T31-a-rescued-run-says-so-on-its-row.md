# T31 — A rescued run says so on its row

Status: Done
Type: AFK
Blocked by: T13, T28, T29

Sequence: [ticket 08](../08-in-hae-sequence.md). A correctness fix to code
[T29](T29-rescue-branch-for-commits-that-cannot-go-home.md) has landed, found by the dispatcher
while reading that ticket's own PR. The same shape as [T20](T20-atomic-lock-claim.md),
[T21](T21-serialize-lock-eviction.md), [T25](T25-kept-checkout-is-not-wreckage.md),
[T27](T27-every-git-read-names-its-repo.md), and [T30](T30-the-image-declares-its-own-inputs.md) —
except that this one closes a gap T29 opened rather than one that was already there.

**Collides with T30 in no file.** It touches `src/ledger/record.ts`, `src/dispatch/run.ts`,
`src/dispatch/checkout.ts`, `src/status/render.ts`, and `src/notify/notifications.ts`. T30 is in
`src/doctor/probes.ts` and its two callers.

**[T28](T28-redispatch-clears-its-own-kept-checkout.md) is a blocker for ordering, not for
compilation** — the same shape as T30's on T27. T28 lifts the release's salvage out of `checkout.ts`
into a named function, and this ticket reads its answer. Built first, this ticket would read the
closure instead and T28 would then have to move code this one had just changed.

**Tracer: a dispatcher who walked away learns from `status` — and from the notification — that the
run's commits are on a branch of the run's own, without opening the log.**

## What to build

T29 gave a refused release somewhere to put the commits. It did not give the run anywhere to say so.

A rescue is the one outcome in the whole matrix where the work survived but is **not where anybody
was told to look for it**. Today the only durable record of that fact is a `Warned` line in the run
log. The ledger row does not carry it, so `status` — the screen SPEC §7 says is the AFK
dispatcher's screen — never mentions it. And the terminal notification T13 derives *from that row*
cannot mention it either: the dispatcher gets `failed: land — see <log>`, which is true, and
tells them the one thing they already feared while withholding the one thing that would settle it.

The row gains a field, `status` renders it, and the terminal notification says it.

## The ordering problem, which is the whole of this ticket

The obvious change does not work, and it is worth knowing why before writing anything.

`recordTerminal` runs in an `Effect.onExit` on the **work** (`run.ts`). The checkout is an
`Effect.acquireRelease` in the run's `Scope`, and scope finalizers run when the scope closes —
which is *after* the work's `onExit`. So the release's rescue, and therefore the answer this
ticket wants to record, happens **strictly after the row has already been appended**.

The release order today, and it is correct, is: work exits → row appended → sandbox released →
checkout released (the rescue is here) → lock released.

So the row has to move. Register `recordTerminal` as a scope finalizer immediately after
`runLock.acquire`, rather than as an `onExit` on the work. Finalizers run in reverse of
registration, so a row registered second — after the lock and before the checkout — releases
after the checkout's and before the lock's, which is exactly where it belongs. SPEC §11's rule is
unchanged and better served: the row is owed **from the lock**, and now it is written from the
lock too.

Two things this must not break, both already pinned by tests:

- **A row exists iff `RunLock` was acquired** (SPEC §11). The append still sits inside the lock's
  bracket and inside the `uninterruptibleMask`'s protected stretch.
- **The stage on a failed row.** Matrix rows 5 and 6 owe a `failed` row naming `checkout` and
  `sandbox` respectively, and today the exit the row reads is the work's. A scope finalizer is
  handed the scope's exit; check that it carries the same failure before assuming it does, and if
  it does not, thread the work's exit through a `Ref` rather than changing what the row says.

## A shape that looks right and is not

- **A second ledger line for the rescue.** SPEC §11 says a run writes *exactly one* terminal row.
  A second line makes `lastBaseForBranch`, the `status` grouping, and every count in the ledger
  ambiguous about how many runs happened, to record a field.
- **A `Ref` the release writes and the row reads.** It typechecks. It is also the ordering bug
  restated: the row reads the `Ref` before the release writes it, and the field is silently always
  absent — the failure mode a test using a *successful* release would never catch.
- **Releasing the checkout outside the `Scope` so it runs before the row.** This is the design
  rule (three resources, one scope, reverse order) traded away for a field. A checkout released
  outside the scope is not released on the paths the scope exists to cover.
- **Bumping `CURRENT_SCHEMA_VERSION` to 2 and stopping there.** Version-1 lines are already on the
  dispatcher's disk from every run so far, and none of them carry this key. `Schema.OptionFromNullOr`
  wants the key present-and-nullable, not absent. Whatever spelling makes an absent key decode as
  `Option.none` is the requirement; the version bump on its own does not supply it, and a `status`
  that skips every row written before today is a worse bug than the one being fixed.

## Not in scope

- **`gc`.** SPEC §7 line 338 now describes `gc` salvaging by the release's two-destination rule.
  `gc` is P4 and unbuilt; this ticket does not start it.
- **Listing or cleaning up rescue branches.** A rescue branch is an ordinary branch and `git branch`
  already lists it. bessemer does not garbage-collect the human's refs.
- **The reconciler.** A rescued run leaves no checkout, so `wreckage.ts` has nothing to say about
  it — which T29 already asserted.

## Read first

`src/dispatch/run.ts` — `recordTerminal` and the `uninterruptibleMask`/`Effect.scoped` structure
it sits in, which is what this ticket rearranges. `src/dispatch/checkout.ts` — the release's
`releaseClone`, which already knows the rescue branch's name and today only warns it.
`src/ledger/record.ts` — `RunRecord` and the two schema-version constants.
`src/status/render.ts` — `outcomeCell` and the row-to-cells mapping.
`src/notify/notifications.ts` — `terminalTail`, which is where "where the work is now readable"
is already decided for the PR case and is the same question.

`test/checkout.test.ts` holds T29's three release cases, including the rescue.
`test/dispatch.test.ts` and `test/signal-matrix.test.ts` pin the terminal row's existence and its
stage across the matrix, and `test/ledger.test.ts` pins the decode — those are the tests the
reordering has to keep green, and any of them going red is a real finding rather than an
expectation to update. `test/status.test.ts` is where the rendered line is asserted.

**Already on the branch — do not rewrite** T1–T13's or T20–T30's modules beyond what this ticket
requires. Amend `AGENTS.md` only with a ruling you had to discover. **Do not touch hae
files.**

## Effect wiring

- **Tags introduced**: none. **Tags consumed**: unchanged.
- **Layer composition**: unchanged. `AppLive` and `AppBaseLive` are byte-unchanged.
- **Errors**: no new error type. A rescue that happened is a recorded fact, never a failure — the
  run's outcome is what it already was, and T29's rule that the rescue decides *where the commits
  live, never whether the run succeeded* still holds.
- **Schema**: one optional field on `RunRecord`, absent on every line written before this ticket.

## Acceptance criteria

- [ ] A run whose home fetch is refused and whose rescue lands writes a terminal row carrying the
      rescue branch's name.
- [ ] A run that went home writes a row carrying no rescue, and the field is absent rather than
      empty-string or the branch's own name.
- [ ] A run where **neither** destination took the commits writes a row carrying no rescue — the
      commits are in the kept checkout, which is not a branch, and the existing loud warning is
      still the whole of what that case says.
- [ ] `status` shows where a rescued run's commits are, on the same line as that run.
- [ ] The terminal notification names the rescue branch, on the same footing as the PR URL.
- [ ] Every ledger line written before this ticket still decodes and still renders — asserted with
      a fixture line that omits the new key, not by inspection.
- [ ] The terminal row is still written iff the lock was acquired, and still names the stage a
      `checkout`- or `sandbox`-staged failure failed at.
- [ ] `npm run verify` is green.

## Verify

1. **Fake tier.** `npm run verify`.
2. **Host-only, the rescue on the row.** In a scratch clone, dispatch a throwaway branch, let the
   agent commit, then amend that branch's tip in the host repo so the fetch home cannot
   fast-forward. Expected: the run fails at `land`, the release reports the rescue, the checkout
   directory is gone, `git branch --list '*-from-run-*'` shows the branch — and `node src/bin.ts
   status` names it on that run's line.
3. **Host-only, the notification.** With `notify = "end"` (the default), the same run's desktop
   notification names the rescue branch rather than only the log path.
4. **Host-only, the old lines.** Run `status` against a ledger that still holds rows from before
   this change. Expected: every one of them renders, with no rescue column content and no warning
   about a skipped line.
