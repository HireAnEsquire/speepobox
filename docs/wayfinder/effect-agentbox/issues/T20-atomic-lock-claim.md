# T20 — Make the stale-lock claim atomic

Status: Done
Type: AFK
Blocked by: T6

Sequence: [ticket 08](../08-in-hae-sequence.md), re-sliced 2026-08-10. **Split out of
[T8](T8-reconciler.md) on 2026-08-11**, where it rode as §3a. It is a prefactor — make the change
easy, then make the easy change — and it is a correctness fix to code already on the branch, so it
lands on its own rather than depending on a feature ticket finishing. Numbered T20 rather than
renumbering, since the blocking edges are explicit and dependency order does not read off the number.

Blocked by [T6](T6-sandbox.md) only because T6 rewires `test/run-lock.test.ts`; land on top of it
rather than against it.

**Tracer: two dispatches that find the same dead lock, and exactly one of them gets the branch.**

## What to build

One primitive, used by one caller today and two after T8.

### 1. The race, as it stands

T4's reclamation is **remove-then-exclusive-create**, and T4's own pass reported the race rather than
hiding it: two dispatches that collide on the *same dead owner* can interleave — A removes, A
creates, B removes **A's fresh lock**, B creates — and both end up holding the branch. T4's
second-collision check catches only the other interleaving, where B's create is the one that loses.

The window is a few syscalls wide and needs both dispatches to have found the same corpse, which is
why T4 accepted it rather than fixing it under a ticket that did not ask for it.

### 2. The fix

Replace remove-then-create with an **atomic claim**: write the pid to a unique temp file in the same
directory and `link` it into place, where the link failing with `AlreadyExists` *is* the collision.
`fs.link` is on `@effect/platform`'s `FileSystem` — same tag, no new dependency. Unlink the temp file
on both paths.

`RunLock.acquire` takes the claim through that one primitive. T8's reconciler will take it through
the same one; **do not build a second caller here** — the reconciler does not exist yet.

Keep `LockHeld` and `LockError` exactly as they are. This changes how the claim is made, never what a
caller can branch on, and no test outside `run-lock` should need editing.

### 3. Why it lands before the reconciler

T8 reclaims dead locks across **all** slugs on every preflight, so it races the same way against any
dispatch acquiring at that moment — without the narrowing "same dead owner" condition that makes the
window small today. Fixing the primitive first means T8 inherits a claim it can just call.

## Not in scope

The reconciler itself, the liveness predicate's shape (it is already shared and correct), `gc`, and
every agent-facing service. Do not stub them. Do not add a second caller for the claim.

## Read first

`src/lock/run-lock.ts` and `src/lock/liveness.ts` — both small and both read whole — plus
`AGENTS.md` and **SPEC §4 (lines 176–249)**.

In `test/run-lock.test.ts`, the cases that pin current behaviour are in `describe("RunLock")`:
`"reclaims a lock whose owner is dead, reports it, and proceeds"`, `"reclaims a lock that records no
pid at all"`, `"fails as a typed LockHeld when a live pid owns the branch"`, and `"keeps a broken
lock path typed as LockError, never as LockHeld"`. Those four are the contract; they should still
pass, and the new case joins them.

**Already on the branch — do not rewrite** T1–T6's modules. `run-lock.ts` is the one file this ticket
edits on purpose. Amend `AGENTS.md` only with a ruling you had to discover. **Do not touch hae
files.**

## Effect wiring

- **Tags introduced**: none.
- **Tags consumed**: `RunLock`'s existing set, plus `FileSystem` / `Path` **directly, no wrappers**.
- **Layer composition**: **unchanged — do not edit `src/app.ts`.** This changes the body of an
  existing layer, not the graph.
- **Errors**: `LockHeld` and `LockError` keep their exact meanings. A `link` that fails with
  `AlreadyExists` is a *collision*, which is `LockHeld`; a `link` that fails any other way is
  `LockError`.

## Checkpoint order

The claim primitive plus its own test reaches `npm run verify` before `RunLock.acquire` is converted
to it. Land that first, then the conversion.

## Acceptance criteria

- [ ] The stale-lock claim is atomic — unique temp file plus `link`, with `AlreadyExists` treated as
      the collision
- [ ] The temp file is unlinked on both the success and the failure path, leaving no debris in the
      runtime root
- [ ] `RunLock.acquire` takes the claim through that one primitive; no second implementation of the
      claim exists
- [ ] `LockHeld` and `LockError` are unchanged as far as any caller can tell, and T4's four existing
      reclamation cases still pass unedited
- [ ] A test drives two claims against the same dead owner and asserts exactly one wins
- [ ] `src/app.ts` is unchanged

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, grep bans, and fake-tier tests. `pre-commit` is not a
substitute and does not check this package.

Nothing here is host-only — the claim is filesystem-level and the fake tier reaches all of it.

## Comments

**2026-08-11 — closed.** PR #4473, `APPROVED` at review round 1 — the first single-round approval in
the sequence. `npm run verify` green at the tip: 158 tests, and `test/run-lock.test.ts` is additions
only, so T4's four reclamation cases stand unedited as the ticket required.

The claim landed as `src/lock/claim.ts`, answering `"claimed" | "collided"` and leaving every other
failure a `PlatformError` in the error channel. Two things it got right that this ticket never
spelled out: the temp path is `<lock>.pid.<pid>.<serial>.claim`, which no `*.pid` scan can mistake for
a lock, and the pid is written before the name exists — under the old exclusive create there was a
one-syscall window where a reader saw an empty lock, which liveness reads as ownerless and the next
dispatch reclaims out from under a live run. That ruling is now a bullet in `AGENTS.md`.

**The review round found the half this ticket could not reach and correctly declined to fix it.**
`link` makes creation exclusive; eviction is still a bare `remove`, so two dispatches that read the
same corpse can both end up holding the branch, and the first one's release then deletes the second
one's lock. Closing it needs mechanism this ticket forbade, so it is
[T21](T21-serialize-lock-eviction.md), which now sits between this ticket and
[T8](T8-reconciler.md). The trace lives in the `review: round notes (T20)` commit body.

Sizing: 41 tool calls against the ~35 predicted, so the call-count model held. The seconds-per-call
constant did not — 781s over those 41 calls is 19s each, against T6's 10.4 fresh and 13.1 continuing,
and stripping the 40× flake loop still leaves ~17s. Both passes spent heavily proving the lock tests
were not flaky, which is proportionate here and is still budget. A cap should now be read as roughly
95–120 calls at 1800s rather than 170.
