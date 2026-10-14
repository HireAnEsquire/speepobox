# T104 — The row records the discarded tip

Status: Done (PR #62)
Type: AFK
Blocked by: [T101](T101-hard-reset-resets-to-the-base-and-force-pushes.md) — the reset whose old tip this records.

<!--
P4 (09 Q5), decision D6 (the user, 2026-09-24, P4 quiz): a `--hard-reset` run's ledger row
records the tip it discarded. bash records nothing; its log header carries the mode
(`run.sh:1551`) and the discard count is printed once. Here the log is kept indefinitely (16), but
the row is what `status` and a later dispatcher read. Apart from the reflog, the discarded tip is
the only durable pointer to the work a reset threw away, and the reflog is per-clone and expires.
Split out of T101 on 2026-09-24 so that ticket fits one context.

**One field, the local tip, on purpose** (ruled 2026-09-24). The push discards origin's tip as
well, and T101's `BranchReset` event puts that tip in the run log, which is kept indefinitely.
The row does not grow a second field for it.
-->

## What to build

**A run that reset its branch says so on its ledger row: `discardedTip` is the full SHA the branch
stood at before the reset. A run that did not reset, including one that failed before its reset
ran, has no such key.**

### 1. The value travels as `rescued` does

The row is written by a finalizer registered right after the lock (T31), which sees how the run
ended and not what it did. So the tip reaches it through a `Ref`, exactly as `rescued` does today:

- `runInScope` (`dispatch/run.ts`) makes `Ref.make(Option.none<string>())` beside `rescued`, and
  hands it to `checkout(plan, repoRoot, rescued, …)` and to `recordTerminal`.
- `checkout.ts`'s acquire sets it to `Some(discardedTip)` **immediately after** T101's
  `updateRef` succeeds, and never before. A compare-and-set that failed discarded nothing and
  leaves it `None`.
- `recordTerminal` passes it to `terminalRecord` beside `rescuedOnto`.

Reading `plan.reset` in the finalizer instead typechecks, and it records a discard on the row of
a run whose reset never happened. That is the shape AGENTS.md's T31 bullet warns about, arriving
from the other side.

### 2. The record

- `record.ts`: `discardedTip: Schema.optionalWith(Schema.String, { as: "Option", nullable: true,
  exact: true })`, beside `rescuedOnto`, with a comment giving D6's reason.
  `CURRENT_SCHEMA_VERSION` stays `1`: every version-1 line on disk already satisfies an absent
  key (T31).
- `ledger/legacy.ts`: the legacy adapter sets `discardedTip: Option.none()`, as it does for
  `rescuedOnto`.
- SPEC §10: the field, and when it is present.

`status` does not render it; nothing in P4 asks for that.

### 3. Tests

- `test/ledger.test.ts`: the field round-trips, and `None` encodes to no key at all. A version-1
  line without the key decodes.
- `test/checkout.test.ts`, where `rescued`'s row cases live (verified 2026-09-24): a reset run's
  row carries the guard-read tip, a run without `--hard-reset` has no key, and a run whose
  compare-and-set failed has no key.
- A rehearsal writes no row at all, which is unchanged.

## Effect wiring

- **Tags introduced or consumed**: none new. `Ref` inside the run's scope.
- **Layer composition**: unchanged.

## Acceptance criteria

- [ ] A `--hard-reset` run's row has `discardedTip` equal to the tip the guards read.
- [ ] A run without the flag, and one whose reset failed, has no `discardedTip` key: not `null`,
      not `""`.
- [ ] Existing ledger lines decode unchanged, and the schema version is 1.
- [ ] SPEC §10 names the field.

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package.
