# T46 — The plan carries the run's id

Status: Done (PR #6; the ticket's "seconds apart" is overstated in practice — `planFor` sits past the
guards, so the two clock reads landed 0–2ms apart on this run. The reasoning for keeping them
independent is unaffected.)
Type: AFK
Blocked by: none — can start immediately

<!--
The prefactor under [ticket 16](../16-what-the-tool-keeps-and-who-deletes-it.md)'s resolution. 16
ruled that a run log is an audit trail kept indefinitely, that rotation is deleted, and that each run
writes `<slug>-<runId>.log`. That filename has to carry the *same* id string the ledger row records —
otherwise a kept log joins to its run by timestamp proximity, which is an archive rather than a
record. Today the id is minted at row-write time, so a filename derived at plan time would be a
second clock read: verified on T41, the log's first line reads `16:27:33.661Z` where the row's
`startedAt` is `16:27:33.659Z`, 2ms apart, because `openRunLog` calls `DateTime.now` again.

This ticket makes the id a fact of the plan. It changes no logging and no file on disk — that is
T47. It is separate because it moves the ledger row's producer, and a change to the row deserves its
own green.
-->

## What to build

**The run id is minted once, when the plan is resolved, and the ledger row reads it off the plan.**

Today `runIdFor(slug, startedAt)` (`src/dispatch/run.ts:58`) has exactly one caller: `terminalRecord`
(`run.ts:125`), which re-derives the id at row-write time from the `startedAt` that `runInScope` read
(`run.ts:326`). Nothing else in the tool calls it.

The move:

- **`runIdFor` relocates to `src/dispatch/plan.ts`**, beside the other slug-keyed derivations, and
  stays pure. `plan.ts`'s header already says the derivations live in one place so a caller cannot
  key three of them off one slug and the fourth off another; the run id is the fifth.
- **`planFor` takes `startedAt: DateTime.Utc`** and sets `runId` on the plan it returns. `planFor`
  itself stays pure — it takes the clock read, it does not perform one.
- **`DispatchPlan` gains `runId: Schema.String`.**
- **`dispatch.ts` reads `DateTime.now` immediately before its `planFor` call** (around line 332) and
  passes it in.
- **`terminalRecord` uses `plan.runId`.** `runInScope`'s own `startedAt` read stays exactly where it
  is and keeps feeding the row's `startedAt` field.

### The decision this ticket makes, and it belongs in a comment

The id's epoch becomes **plan time**; the row's `startedAt` stays **lock-claim time**. Those are the
two ends of the preflight, so they can be seconds apart, and after this change neither is derivable
from the other. That is deliberate: the join key between a run and its artifacts is the id string
itself, and T47 needs that string to be fixed before anything is opened. Say so where `runIdFor`
lands — a later reader who finds the two timestamps disagreeing must find the reason there rather
than treating it as drift.

### Blast radius

Every `planFor` caller passes the new field: `dispatch.ts`, and the test call sites in `notify`,
`sandbox`, `sandbox-spec`, `signal-matrix`, `land`, `pr`, and `dispatch` (two). Mechanical. The two
`DispatchPlan` object literals in `test/dispatch.test.ts` — the plan equality around line 584 and the
`renderPlan` fixture around line 2242 — gain the field too.

No existing assertion pins a *produced* run id: `test/run-lock.test.ts:775` asserts only that the
row's `runId` is `Some`, and `test/dry-run.test.ts:93`'s `${BRANCH}-1786000000000` is a fixture row
handed *in*, not an id the code produced. So nothing about wall-clock ids moves.

`renderPlan` gains no row — the plan block does not print the id today and does not start here. T47's
log path will carry it.

## Effect wiring

No tag introduced, consumed, or moved; no layer composition changes. The clock read is `DateTime.now`
inside the existing `Effect.gen` in `dispatch.ts`, which already runs under the app layers.

## Acceptance criteria

- [ ] A dispatch's ledger row carries the same run id string the resolved plan carries — asserted
      through a dispatch, not at the schema.
- [ ] `runIdFor` has exactly one caller, `planFor`, and nothing derives a run id after the plan
      resolves.
- [ ] The row's `startedAt` still records the moment the run claimed the lock, not the moment the
      plan resolved.
- [ ] `PlanResolved` carries the id, so a plan event names the run's key before the run ends.
- [ ] The suite passes with no assertion changed except for the added field.

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package.
