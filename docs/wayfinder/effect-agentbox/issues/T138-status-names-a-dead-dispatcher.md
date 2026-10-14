# T138 — `status` names a dead dispatcher

Status: Done (PR #98. `status`'s Running section has an OWNER column, answered by the reconciler's `classify`. Its lock read copies `reconcile.ts`'s `lockAt` rather than sharing it; the two read alike today.)
Type: AFK
Blocked by:

<!--
From the hae install gate (09's comment of 2026-10-12). Run 5's dispatcher was killed with
`kill -9`; until the re-dispatch reclaimed it, `status` listed `bessemer-p7-gate-5` under "Running"
with nothing to say its dispatcher was gone. The reconciler already knew: the lock's owner was not
alive.
-->

## What to build

`status`'s **Running** section says, for each container it lists, whether a dispatcher still owns
it. Today the section is `NAME` and `UPTIME` only, so a container whose dispatcher died reads
exactly like a live run, and the person looking at the screen cannot tell an orphan from work in
progress.

Each row gets a third column, `OWNER`, with one of three values:

- **`pid <N>`**: the slug's lock names a pid that is alive. This is a live run.
- **`dead — next dispatch reclaims`**: the slug's lock exists and its owner is not alive (or
  cannot be named). The reconciler reclaims this container on the next dispatch preflight in this
  repo, whichever branch that dispatch is for.
- **`no lock — reported only`**: no lock in this runtime root names the slug. The container may
  belong to a dispatcher this process cannot see, so the reconciler reports it and never removes
  it.

**The answer is the reconciler's, not a second one.** `liveness.ts` says it is the only place this
question is decided, and `wreckage.ts`'s `classify` is where the reconciler joins it to the lock and
the container. Build a `RunWreckage` per listed container and ask `classify`:

- the slug from `slugOfContainer(name)`;
- the lock read as `reconcile.ts`'s `lockAt` reads it: `lockPathFor(config.runtimeRoot, slug)`
  through `parsePid`, and a lock that is absent or unreadable is `Option.none()`;
- the sandbox as running, since `status` lists only running containers;
- the checkout as `Option.none()`. Both branches that apply here (a lock is present; a running
  container with no lock) return before `classify` reads the checkout, so it cannot change the
  answer.

Map `Live` with a lock to `pid <N>`, `Reclaimable` to the dead value, and `Live` with no lock to the
no-lock value. A different predicate here, even a correct one, is the drift `liveness.ts` exists to
prevent. If `classify`'s shape makes the mapping awkward, extract the shared part in `wreckage.ts`
so both callers use it; do not copy its branches into `status`.

**`status` keeps its guarantees** (SPEC §7): no docker state changes, no writes, no git. Reading
lock files is a filesystem read, as the ledger read already is. A lock read that fails is "no
lock", never an error: `status` never fails. When the container half is `ContainersUnavailable`,
nothing is read and the section renders as it does today.

The container's `OWNER` value is part of `StatusSnapshot` (on `RunningContainer`), not computed
by the renderer. The snapshot is the domain value and the renderer is a pure function over it
(SPEC §5).

Update SPEC §7's `status` row to say the Running section names each container's owner, and that
`status` reads the lock directory.

## Effect wiring

- **Tags introduced or consumed**: none introduced. `status` additionally consumes
  `BessemerConfig` (for `runtimeRoot`), `FileSystem.FileSystem`, and `Path.Path`.
- **Layer composition**: unchanged. `appBaseLiveFor` already provides all three: its config layer
  is `bessemerConfigTolerantLiveFor`, so a malformed `config.toml` still falls back to committed
  defaults and `status` still runs. `bin.ts`'s `status` case stays as it is:

  ```ts
  status({ repoRoot }).pipe(Effect.provide(appBaseLiveFor(repoRoot, stdinIsTTY)))
  ```

## Acceptance criteria

- [ ] A running container whose slug's lock holds a live pid renders `pid <N>` in `OWNER`.
- [ ] A running container whose slug's lock holds a dead pid (`2147483647`, as `test/gc.test.ts`
      uses) renders `dead — next dispatch reclaims`.
- [ ] A running container whose slug's lock holds no parsable pid (empty file) renders the dead
      value, matching `classify`.
- [ ] A running container with no lock file renders `no lock — reported only`.
- [ ] An unreadable lock path (for example a directory at the lock's path) renders the no-lock
      value, and `status` still exits 0.
- [ ] `ContainersUnavailable` renders as before, and no lock is read.
- [ ] The value comes from `classify` (or a helper both it and `status` call), pinned by a test
      that feeds the same facts to both and asserts they agree on all three cases.
- [ ] SPEC §7's `status` row is updated.

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package.

Host-only, after merge: `node src/bin.ts status` under plain node renders the Running section
(empty is fine) with the new column header when a container is up.
