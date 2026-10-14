# T97 — The reconciler's scan is a value

Status: Done (PR #59)
Type: AFK
Blocked by: none.

<!--
P4 (09 Q5), prefactor. SPEC §4 (the ownership paragraph) says `gc` keeps its path over **the same
pure classification functions** the reconciler uses, and `wreckage.ts` was written for that reuse
("P4's `gc` reuses them unchanged"). The classification is already pure. The *scan* is not
separable: `reconcile()` in `src/reconcile/reconcile.ts` reads the locks directory, sweeps
stranded witnesses, asks dockerd (`ownedSandboxes`), reads each checkout's `.git/HEAD`, and then
acts on each slug, all in one `Effect.gen`. `gc` has to list without acting (T99), and it has to
act differently on two of the three verdicts (T100), so the gathering has to come out as a value
first. This ticket has its own green: every reconciler test passes unchanged.
-->

## What to build

**Split `reconcile()` into a scan that returns what is on the host and an act that takes it.**
Behaviour does not change: same reports, same order, same removals.

### 1. The scan

Add an exported effect in `src/reconcile/reconcile.ts`, for example `scanWreckage(repoRoot)`. It
returns one value holding:

- every slug's `RunWreckage`, in the sorted order the loop uses today;
- the eviction witnesses and markers the sweep would act on. Today these are computed by `markers`
  and `stranded` from the lock-directory listing, `isEvictionWitness`, `evictorInMarkerName`, and
  `isDebris`;
- the daemon's answer. Today `ownedSandboxes` returns an `Option`, and `None` means "could not
  ask". Keep that distinction in the value; do not turn it into an empty list.

Everything the scan does today stays here. That includes `entriesIn`, `lockAt`, `checkoutAt`, and
`slugOfLockEntry`, and the rule that an unreadable directory is reported and skipped. The scan
removes nothing.

**Ordering note.** Today the witness sweep *removes* before dockerd is asked, and the daemon-down
arm returns early *after* the sweep. The act (below) must keep that order: sweep, then the
daemon-down early return, then the per-slug loop. Whether the scan gathers slugs before or after
the sweep does not change behaviour, because the sweep touches only `.evicting` witnesses and
`.evictor` markers, and `slugOfLockEntry` rejects both. Keep the gathering order as it is anyway,
so the diff reads as a move.

### 2. The act

`reconcile(repoRoot)` becomes the scan followed by what it does today, in the same order: the
marker and witness sweep, then the daemon-down report and early return, then the per-slug
`classify` switch that calls `reclaim`, `removeSandbox`, and `removeCheckout`. Its signature and
requirements do not change, and `dispatch.ts` still calls it once, in the same place.

Export the witness sweep as its own effect over the scan's value, because T100 runs the same
sweep. Leave `reclaim`, `removeSandbox`, `removeCheckout`, and `notElsewhere` private: `gc`
reclaims checkouts differently (T100), and that ticket decides what it shares.

### 3. Tests

- Every case in `test/reconcile.test.ts` passes unchanged. Do not edit its assertions.
- One new case: `scanWreckage` over the same fakes that the *"the reconciler on a dispatch
  preflight"* block uses. It returns the wreckage those cases act on and removes nothing: the fake
  filesystem, the recording `Sandbox`, and the `RunLock` fake all show zero writes.

## Effect wiring

- **Tags introduced or consumed**: none introduced. The scan needs `BessemerConfig`, `Reporter`
  (for its unreadable-directory reports), `CommandExecutor`, `FileSystem`, and `Path`. It does not
  need `Sandbox`, `RunLock`, or `Git`: those belong to the act.
- **Layer composition**: unchanged.

## Acceptance criteria

- [ ] `scanWreckage` is exported, returns the per-slug wreckage, the sweep candidates, and the
      daemon's `Option`, and performs no removal.
- [ ] Its requirements do not include `Sandbox`, `RunLock`, or `Git`.
- [ ] `reconcile`'s signature and every `test/reconcile.test.ts` case are unchanged and pass.
- [ ] The witness sweep is exported as its own effect over the scan's value.

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package.
