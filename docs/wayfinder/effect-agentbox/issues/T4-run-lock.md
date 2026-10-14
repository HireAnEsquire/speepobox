# T4 — `RunLock`, the `Scope`, the run log, and the terminal ledger row

Status: Done
Type: AFK
Blocked by: T3

Sequence: [ticket 08](../08-in-hae-sequence.md), re-sliced 2026-08-10. Draws on the design in
[`superseded/scoped-shell.md`](superseded/scoped-shell.md), which is source material and not a live
ticket.

**Tracer: two invocations, two terminals, one branch — the second refuses.** Start a dispatch, leave
it holding the lock, and start another against the same branch: it fails with a typed `LockHeld` and
holds nothing. Kill the first with `kill -9`, run again, and the dead lock is reclaimed *during
acquisition* with the reclaim reported. Ctrl-C a run and the lock file is gone.

## What to build

The first resource in the run's `Scope`, and the run-lifecycle bookkeeping that hangs off it.

### 1. The `Scope`

**One `Scope`, opened after every guard passes** (SPEC §4), preserving T3's invariant that nothing is
touched before the in-flight check. Release reverses acquisition automatically. At this ticket the
scope holds one resource; T5 and T6 add the other two inside the same scope rather than beside it.

### 2. `RunLock`

**A PID file, not a `Semaphore`** (05 Q17). The real contention is two invocations in two terminals,
which an in-process primitive cannot see. The lock lives under the **runtime root** — the package's
own root during incubation (05 Q19), already a config value since T1 — keyed by the slug T3 derives.

- acquire: write the PID · release: remove
- **stale-lock reclamation is part of acquisition**, not a step beside it, using a liveness predicate
  that is a **pure function with no tag** (SPEC §2). T8's reconciler reuses that same predicate, and
  P4's `gc` reuses it again — so it lands here as a shared pure function, not as a method
- a lock held by a live PID is a typed `LockHeld` with nothing acquired (matrix row 3)
- a lock whose PID is dead is reclaimed, the run proceeds, and the reclaim is reported via `Reporter`
  (matrix row 4)

### 3. The run log

**A `Reporter` subscriber opened as a plain effect, not a resource** (SPEC §4). Logs are never
deleted, so they are not scope-managed; **rotation is likewise a plain effect** (`mv` the previous
log aside, as `run.sh:1155` does). The console subscriber in `src/app.ts` stays exactly as it is —
this is a second subscriber over the same event stream, not a parallel output path.

### 4. The terminal ledger row

**A run writes exactly one terminal row iff `RunLock` was acquired** (SPEC §11). T2 landed `Ledger`
noting this corollary was unexercised; this is where it becomes true. Guard and preflight refusals
never started, so they still write nothing — T3's assertion stays green.

This ticket's happy path has no agent work and no land outcome to record, so its terminal reason
names the **furthest stage reached**: the scope completed with nothing to do. That is honest, and
later tickets replace it with real stages from the closed `RunStage` union already in
`src/ledger/record.ts`. Deferring the row until there is an outcome to write would leave the
invariant unexercised through the whole bullet that introduces the lock it depends on.

**A failing ledger append is not fatal** (matrix row 20): everything releases, the failure is a typed
`LedgerError`, and it is warned loudly because the log file still holds the truth.

### 5. Interruption, so far

Ctrl-C and SIGHUP release the lock and write an `interrupted` row (matrix row 16, at the one-resource
depth available here). The full four-path signal matrix and its live proof are T7's, once there is a
container to leak and a setup hook to hold the run open. `NodeRuntime.runMain` stays the only
entrypoint idiom and `Effect.runPromise` stays grep-banned.

**Two mechanisms, so you do not have to find them in `node_modules`** (06's copy-do-not-derive rule
is not only about layers — it covers any shape you would otherwise reverse-engineer from a
dependency's internals):

- **Interrupt already reaches your finalizers, and you add no signal handler.** `NodeRuntime.runMain`
  installs the SIGINT/SIGHUP handling and interrupts the main fiber; `bin.ts` has used it since T1.
  An `Effect.acquireRelease` finalizer therefore runs on Ctrl-C for free. What you owe is a release
  that cannot fail (design rule 4) and the `interrupted` row, written from the finalizer — not a
  `process.on("SIGINT", …)`, which would be a second, racing teardown path.

  > **Corrected 2026-08-10, by the pass that built this ticket.** The bullet above is wrong about
  > SIGHUP. `runMain` registers **SIGINT and SIGTERM only** — measured against
  > `@effect/platform-node-shared`'s `runtime.js`, where the two `process.on` calls are the whole
  > list. On a hangup node's default action kills the process, no finalizer runs, and the lock
  > survives: the exact leak SPEC §4 says the port closes. `bin.ts` therefore re-raises SIGHUP as
  > SIGINT (`93126a305b`), which keeps the bullet's *ruling* intact — one teardown path, reached the
  > same way Ctrl-C reaches it — while fixing its premise. The rest of the bullet stands.
- **`LockHeld` comes from an exclusive create, not from a stat-then-write.** Checking for the PID
  file and then writing it is a TOCTOU race two dispatches can both win. Open the file with the
  exclusive-create flag and let the collision *be* the answer: `@effect/platform`'s `FileSystem`
  surfaces it as a `SystemError` whose `reason` is `AlreadyExists`, which you map to `LockHeld`. Any
  other failure stays a `LedgerError`-style typed failure; do not flatten them together.

## Not in scope

Checkout, `Sandbox`, the setup hook, the reconciler over all slugs, and every agent-facing service.
Do not stub them.

## Read first

`src/app.ts`, `src/bin.ts`, `src/config/config.ts`, `src/ledger/ledger.ts`, `src/ledger/record.ts`,
`src/reporter.ts`, T3's dispatch module, `AGENTS.md`, and SPEC §§3, 4, 10, 11.

**Already on the branch — do not rewrite** T1's and T2's modules; amend `AGENTS.md` only with a
ruling you had to discover. **Do not touch hae files.**

**Land the run log first, as its own commit, before `RunLock` exists.** The rest of this ticket is
one interlocking change — the lock, the scope, the wiring in `app.ts`, the test world — and none of
it passes `npm run verify` until all of it is in, so a pass interrupted partway commits nothing and
delivers nothing. The run-log module is the piece that goes green alone: it writes and rotates a file
under the runtime root, has no dependency on the lock, and carries its own tests. Land it, then build
the lock on top. A first commit inside the first ten minutes is the goal, not a nicety — the previous
attempt at this ticket wrote six files over twelve minutes, was interrupted, and left nothing behind.

## Effect wiring

- **Tags introduced**: `RunLock` — scoped `acquire` over a PID file (SPEC §2).
- **Tags consumed**: `AgentboxConfig` (runtime root), `Reporter`, `Ledger`, plus `FileSystem` /
  `Path` / `Clock` **directly, no wrappers**.
- **Not introduced**: `Sandbox`, `Git`, `AgentCli`, `Forge`, `Notifier`, `PromptSource`, `Prompt`,
  `IssueStore`. Do not stub them.
- **Layer composition**: `RunLock` joins the same single `AppLive` (05 Q21) — not a per-command
  layer. Copy this, do not derive it:

  ```ts
  export const AppLive: Layer.Layer<
    RunLock | Ledger | AgentboxConfig | Reporter | NodeContext.NodeContext,
    ConfigError
  > = Layer.provideMerge(
    RunLockLive,
    Layer.provideMerge(LedgerLive, Layer.provideMerge(AgentboxConfigLive, PlatformAndReporterLive)),
  );
  ```

  **`AppBaseLive` is byte-unchanged** — `status` and `doctor` gain no dependency on a lock.
- **Errors**: `LockHeld` and `LedgerError` are typed (SPEC §3). Ordering assertions run through the
  test `Reporter` appending to a `Ref`, so they are plain value assertions (05 §4).

## Acceptance criteria

- [ ] The lock is a PID file under the runtime root, acquired inside the run's `Scope` and removed on
      release — on success, on typed failure, and on interrupt
- [ ] A lock held by a live PID fails as typed `LockHeld` with nothing acquired (matrix row 3)
- [ ] A stale lock is reclaimed **inside acquisition** and the reclaim is reported; the run proceeds
      (matrix row 4)
- [ ] The liveness predicate is a pure function with no tag, and is the only place liveness is decided
- [ ] Exactly one terminal ledger row is written iff the lock was acquired; T3's guard failures still
      write none
- [ ] A failed ledger append releases everything, warns loudly, and is a non-fatal typed
      `LedgerError` (matrix row 20)
- [ ] The per-run log file is a `Reporter` subscriber opened as a plain effect, and rotation is a
      plain effect; no log is ever deleted
- [ ] Ctrl-C releases the lock and records an `interrupted` row (matrix row 16 at one-resource depth)
- [ ] `AppLive` matches the composition above verbatim; `AppBaseLive` is byte-unchanged

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, grep bans, and tests. `pre-commit` is not a substitute
and does not check this package.

Plus, separately, the tracer under plain `node` — which `verify` cannot cover because `vitest`
transforms:

```
node src/bin.ts <spec> --branch <throwaway-branch>
```

**Host-only**, run by the user before landing: two terminals against the same branch (second must
refuse), then `kill -9` the holder and re-run (lock must be reclaimed and reported), then Ctrl-C a
run and confirm the runtime root holds no `.pid` file afterwards.
