# T109 — `gc --force` removes dead leftovers

Status: Done (PR #70. Host check 2026-09-30: `gc --force` removed a planted index. An editor directory left by a dispatch killed with `kill -9` while its editor was open was listed as `remove` and removed. A pid-less `feedback-edit-abc123` was kept, with an `rm -rf` printed. Two P5 dispatches in flight throughout were untouched.)
Type: AFK
Blocked by: [T107](T107-a-branch-that-cannot-be-read-sends-the-salvage-to-the-rescue.md) — it rewrites `gc/force.ts`'s salvage arm; [T108](T108-gc-lists-runtime-root-leftovers.md) — the listing, `GcLeftover`, and `editorDirPid` this acts on.

<!--
MAP.md's *Not yet specified*, "Runtime-root leftovers that `gc` does not see" (D10), ruled by the
user on 2026-09-29. T108 lists them. This ticket removes them.

Decisions (the user, 2026-09-29):
- `gc --force` removes dead claims, dead indexes, and dead editor directories.
- Liveness is **re-verified immediately before each removal**, which is SPEC §7's "`--force`
  reclaims after re-verifying liveness", as T100 does for slugs. T108's listing is a snapshot.
- **A pid-less editor directory is never removed.** It predates T108, carries no witness, and holds
  the dispatcher's own text. `--force` prints the `rm -rf` for a human.
- **No age rule** (T20, T26).

**Where the index goes.** An index is only stranded by a `kill -9` while its slug's lock is held,
so the lock is almost always stranded beside it, and that slug is in T100's per-slug loop. The
index is therefore removed **under that slug's `RunLock`**, inside the loop's scope after the
checkout and before the lock releases. This makes the liveness re-check structural rather than
a second read. An index whose slug is not in the loop can occur when `markLanded`'s own removal
failed on a run that then released normally. It gets its own `RunLock.acquire(slug)` scope, and
`LockHeld` or `LockError` skips it loudly, exactly as T100's step 1 does.
-->

## What to build

**`bessemer gc --force` removes every leftover T108 lists as `remove`, each only after its
witness is asked again. For a pid-less editor directory it prints the `rm -rf` instead.**

### 1. Claims and editor directories

After T97's witness sweep and the per-slug loop, for each `GcLeftover` of kind `claim` or
`editor`:

- **`dead`**: ask again, right before removing. For a claim, `isProcessAlive` on the pid in its
  name. For an editor directory, on `editorDirPid(name)`. Still dead:
  `fs.remove(path, { recursive: true, force: true })` (recursive only for the directory), then
  print `removed <kind> <path>`. Alive now: print `skip <path> — its process (pid N) is running`.
- **`unwitnessed`** (a pid-less editor directory): print one notice saying the directory predates
  pid-named editor directories, so gc cannot tell whether a dispatcher is still editing in it, and
  giving `rm -rf <path>`. Remove nothing.

### 2. Indexes, under the slug's lock

- **Slug in the per-slug loop**: inside that slug's `Effect.scoped`, after the checkout step and
  before the scope closes, remove `statusIndexPathFor(runtimeRoot, slug)` if it exists. Print
  `removed index <path>`.
- **Slug not in the loop**: `RunLock.acquire(slug)` in its own `Effect.scoped`, then remove it
  there. `LockHeld` or `LockError` means `skip <slug> — <detail>`, and the index stays.

Never remove an index outside its slug's lock.

### 3. Failure and exit code

A removal that fails prints the path and the `rm -rf` for a human, and counts as a failed removal
under T100 §5's rule: exit 1 when any removal failed, exit 0 when items were only skipped. The
pid-less notice is a skip, not a failure.

### 4. What stays untouched

Logs, as T100 pins. Anything T108 did not list. A live leftover.

### 5. SPEC

SPEC §7's `gc` row: `--force` removes dead leftovers after re-asking their witness, removes an index
only under its slug's lock, and leaves a pid-less editor directory to a human (T109).

### 6. Tests

`test/gc.test.ts`, on a temp runtime root and the existing fakes:

- A dead claim is removed. A claim whose pid is alive at removal time (its name uses this
  process's pid, planted between the listing and the force) is skipped.
- A dead editor directory is removed with its contents.
- A pid-less editor directory is kept, and the notice contains `rm -rf <path>`.
- An index for a slug in the loop is removed inside that slug's lock. Assert the acquire happened
  and the index is gone.
- An index for a slug with no other wreckage gets its own acquire. `LockHeld` there leaves it
  and skips loudly.
- A failed removal exits 1.
- Logs are untouched, as before.

## Effect wiring

- **Tags introduced or consumed**: `RunLock`, `FileSystem`, `Path`, `BessemerConfig`, `Reporter`,
  already in T100's `gc` composition. No new tag.
- **Layer composition**: unchanged from T100's `gc` case.

## Acceptance criteria

- [ ] `gc --force` removes dead claims and dead editor directories, each after asking its pid
      again right before the removal.
- [ ] An index is removed only under its slug's `RunLock`. A held lock skips it.
- [ ] A pid-less editor directory is never removed, and `--force` prints its `rm -rf`.
- [ ] Exit codes follow T100 §5.
- [ ] SPEC §7's `gc` row says it.

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package.

Host-only, after the gate, by the dispatcher:

1. On a terminal, run `node src/bin.ts --resume <b> --feedback-edit` for a branch with a
   recorded run, so the editor opens. While it is open, `kill -9` the dispatch from another
   terminal.
2. `node src/bin.ts gc` must list the `edit-dir` as `remove`. `node src/bin.ts gc --force` must
   remove it, and a second `gc` must list nothing.
3. `mkdir .bessemer/feedback-edit-abc123`, then run `gc --force`. It must be kept, with an
   `rm -rf` printed. Remove it by hand.
