# T98 — The salvage takes a checkout, not a plan

Status: Done (PR #58)
Type: AFK
Blocked by: none.

<!--
P4 (09 Q5), prefactor. SPEC §7's `gc` row says checkouts are salvaged before removal "by the
release's own two-destination rule (T29)", and AGENTS.md says the salvage is **one function, two
call sites** (T28): a second copy of the two fetches drifts. `gc --force` (T100) is the third call
site. It cannot call `salvage` today: `salvage(plan: DispatchPlan, repoRoot)` in
`src/dispatch/checkout.ts:305` takes a whole plan, and gc has no plan, only a directory under
`checkouts/` and the branch its `.git/HEAD` names. Verified 2026-09-24: `salvage` reads exactly two
plan fields, `plan.branch` and `plan.checkoutPath` (lines 312-382). This ticket has its own green:
the two existing callers and every test are unchanged.
-->

## What to build

**Narrow `salvage`'s first parameter to the two facts it reads.**

### 1. The parameter

Change the first parameter of `salvage` to a value naming a copy on disk and the branch it is for.
It can be `Pick<DispatchPlan, "branch" | "checkoutPath">`, or a small named interface with those
two fields. A `DispatchPlan` must still satisfy it, so both existing calls stay as they are:

- `checkout.ts:464`, the acquire's clear-my-own-path;
- `checkout.ts:650`, the release.

Do not change what `salvage` does. Keep the fetch order, the containment reads after each fetch,
the rescue name from `rescueBranch`, and the `Salvage` / `Unmoved` unions exactly as they are.

### 2. The sentences

`nothingLanded` takes a `DispatchPlan` but reads only `plan.branch`. `rescueDidNotLand` takes one
and reads none of it (verified 2026-09-24). Narrow the first to the branch and drop the unused
parameter from the second. After that, a later caller can explain a `Kept` answer without building
a plan.
Leave `deadRunKeptItBecause` and `thisRunKeptItBecause` as they are. They are the acquire's and the
release's own sentences, and T100 writes gc's.

### 3. Tests

No new behaviour, so no new case is required. If `test/checkout.test.ts` has a helper that builds
a full plan only to call `salvage`, it may pass the narrower value instead. Assertions stay as
they are.

## Effect wiring

- **Tags introduced or consumed**: none. `salvage` still requires only `Git`.
- **Layer composition**: unchanged.

## Acceptance criteria

- [ ] `salvage`'s first parameter type names only `branch` and `checkoutPath`, and a
      `DispatchPlan` is assignable to it.
- [ ] Both call sites in `checkout.ts` compile unchanged.
- [ ] Every case in `test/checkout.test.ts`, `test/land.test.ts`, `test/dispatch.test.ts`, and
      `test/dry-run.test.ts` passes, with no assertion edited.

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package.
