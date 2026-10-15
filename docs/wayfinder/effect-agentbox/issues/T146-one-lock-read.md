# T146 — one lock read

Status: Done (PR #4. `readLockOnDisk` in `src/reconcile/lock-on-disk.ts` is the one lock-file read; the reconciler, `status`, and — found in review — `gc`'s `lockIsLive` all call it.)
Type: AFK
Blocked by:

<!--
From T138's Done line: `status`'s lock read copies `reconcile.ts`'s `lockAt` rather than sharing
it, and "the two read alike today". Today is the only promise the copy makes. T138's ticket asked
for the answer to be the reconciler's, not a second one; the classification is shared through
`classify`, and the read that feeds it should be too.
-->

## What to build

There is one lock-file read, and both the reconciler and `status` call it.

Today there are two copies of the same body:

- `src/reconcile/reconcile.ts`, `lockAt(file)`: a closure inside the reconciler's `Effect.gen`.
- `src/status/status.ts`, `lockFor(runtimeRoot, container)`: it turns the container's name into a
  lock path, then repeats `lockAt`'s body.

Both do `fs.readFileString(file)`, map the contents to `{ path: file, owner: parsePid(contents) }`
as `Option.some<LockOnDisk>`, and turn any failure into `Option.none()`.

**Extract one exported function**, for example `readLockOnDisk(file)`, with this type:

```ts
(file: string) => Effect.Effect<Option.Option<LockOnDisk>, never, FileSystem.FileSystem>
```

- It keeps `lockAt`'s behaviour exactly: an absent or unreadable file is `Option.none()`, and an
  empty or truncated one is `Option.some` with `owner: Option.none()` (through `parsePid`).
- Put it beside the type it returns, but **not in `wreckage.ts`**: that module's header says
  nothing in it reads the filesystem, and it stays pure. A small module of its own under
  `src/reconcile/` is the expected home. Move `lockAt`'s comment (a scan is a snapshot, so an entry
  that vanished drops out) onto the new function.
- `reconcile.ts` calls it where it called `lockAt`, and the closure goes.
- `status.ts` keeps only the part that is its own: the slug from `slugOfContainer`, and the path
  from `lockPathFor(runtimeRoot, slug)`. It then calls the shared read. Its comment stops saying
  "read as the reconciler's `lockAt` reads it" and says it uses the same read.

Nothing else changes. `status` still never fails over a lock, still makes no writes, and still runs
no git (SPEC §7). The reconciler's output is unchanged.

## Effect wiring

- **Tags introduced or consumed**: none new. The shared read requires `FileSystem.FileSystem`, which
  both callers already have in context.
- **Layer composition**: unchanged.

## Acceptance criteria

- [ ] One function reads a lock file into `Option<LockOnDisk>`; `grep -rn "parsePid(contents)" src`
      finds it in that one place.
- [ ] `reconcile.ts` has no `lockAt`, and `status.ts` has no copy of the read's body.
- [ ] The new module does not live in `wreckage.ts`, and `wreckage.ts` still imports nothing that
      reads the filesystem.
- [ ] A test of the shared read covers: an absent file (`None`), a file holding a pid
      (`Some`, owner `Some(pid)`), an empty file (`Some`, owner `None`), and a directory at the path
      (`None`).
- [ ] Every existing reconciler and `status` test passes without edits to what it asserts.

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package.

Also inside the container: `node src/bin.ts status` under plain node prints the status screen (or its
degraded form), not a crash.
