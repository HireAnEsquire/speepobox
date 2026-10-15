# T152 — `stop` ends a branch's live run

Status: Done (PR #10. `stop <branch>` in `src/stop/`, on the read-only slice. The host calls (`ps -o etime=` and `process.kill(pid, "SIGINT")`) are a `StopHost` built in `bin.ts`. The host-only check is still to run.)
Type: AFK
Blocked by:

<!--
Ruled 2026-10-15, beside T151. A run started in the background has no terminal to press Ctrl-C
in. Today the way to stop one is to read its pid off `status`'s OWNER column and `kill -INT` it.
That works, because `NodeRuntime.runMain` treats SIGINT as an interrupt and the run tears down
cleanly: the container goes, the commits are fetched back, and the row records the run as
interrupted. But it asks the dispatcher to handle a pid.

The lock file holds a pid and nothing else (`lock/liveness.ts`). A pid can be reused by the OS
after its process dies. `ownerIsAlive` accepts that risk for the reconciler, which only removes
lock files. `stop` sends a signal, so it must not accept it: interrupting an unrelated process is
worse than refusing.
-->

## What to build

### `speepobox stop <branch>`

`stop <branch>` interrupts the branch's live run, waits for it to tear down, and says so.

1. **Find the owner.** The slug is `slugFor(branch)`. Read the slug's lock (`lockPathFor`) through
   `readLockOnDisk`, and ask `ownerIsAlive`, exactly as `status` does. Write no second liveness
   rule.
2. **Prove it is the run.** Before signalling, check that the live pid is the process that wrote
   the lock, not a later process that reused the pid:
   - Read the process's elapsed time with `ps -o etime= -p <pid>`, through the exec chokepoint
     (`src/internal/exec.ts`). `etime` is POSIX, so it reads the same on macOS and Linux. Its format
     is `[[dd-]hh:]mm:ss`.
   - The process's start is now minus that elapsed time. Read the lock file's mtime.
   - The owner wrote the lock after it started, so its start is at or before the mtime. A process
     that reused the pid started after the owner died, which is after the mtime. Allow 2 seconds of
     slack for `etime`'s one-second resolution.
   - A start after the mtime plus the slack is a refusal: the pid is no longer the run's, and the
     lock is a dead run's. Do not signal. The next dispatch's reconciler clears it.
   - If `ps` fails or its output does not parse, refuse. Do not signal a process whose identity
     could not be checked.
3. **Signal.** Send SIGINT to the pid, once. Never SIGKILL: a killed dispatcher skips its
   finalizers and strands its lock and container, which is the case this tool exists to prevent.
4. **Wait.** Print `stopping '<branch>' (pid <N>)`. Then poll about once a second until the run is
   no longer live, by the same question as step 1. Then print `stopped '<branch>'` and exit 0.
   Teardown fetches the commits back and removes the container, so it can take tens of seconds.
5. **Too slow.** If the run is still live after 120 seconds, print that it was sent SIGINT and is
   still tearing down, name `status` to check on it, and exit 1. Send nothing further.

Refusals go through the usual renderer, with exit 1:

- no branch given: name the usage line;
- no lock, or an owner that is not alive: `no live run for '<branch>'`;
- the pid failed the identity check: say the lock names a pid that now belongs to another process,
  and that the run itself is gone;
- the signal itself failed (for example EPERM, a process owned by another user): quote the error.

### Where the host calls go

`stop` sends a real signal, and tests must not signal real processes. So the signal sender and the
elapsed-time read reach `stop` as parameters (or a small interface), with the real ones supplied in
`bin.ts`. Tests pass fakes that record the signal and script the elapsed time. Keep the logic in its
own module (for example `src/stop/stop.ts`), not in `bin.ts`.

### Where it sits

Intercept `stop` in `bin.ts`'s `argv[0]` switch, beside `status` and `gc`, with
`appBaseLiveFor(repoRoot, stdinIsTTY)`. It needs `FileSystem`, the config's `runtimeRoot`, and the
exec chokepoint for `ps`. It holds no lock, writes no file, and writes no ledger row; the run it
interrupts writes its own.

`stop` does not prompt for confirmation. Typing the branch is the confirmation, and the commits are
kept either way.

### Docs

- The `usage` text in `bin.ts`: an entry for `speepobox stop <branch>`.
- README, "Watching and cleaning up": after `status`, say how to stop a run with
  `.speepobox/speepobox stop <branch>`, and that the commits are kept and the row records the run
  as interrupted.

## Effect wiring

- **Tags introduced or consumed**: none new. `FileSystem` and `SpeepoboxConfig` from the read-only
  slice; `ps` through `internal/exec.ts`.
- **Layer composition**: unchanged. `stop` gets `appBaseLiveFor`, as `status` does.

## Acceptance criteria

- [ ] `stop <branch>` with a live owner that passes the identity check sends exactly one SIGINT to
      that pid, waits until the owner is gone, prints `stopped`, and exits 0.
- [ ] A test: a live pid whose start (from `etime`) is after the lock's mtime plus 2 seconds is
      refused, and no signal is sent.
- [ ] A test: `ps` failing or unparseable output is refused, and no signal is sent.
- [ ] A test: no lock, and a lock whose owner is dead, are both refused with `no live run`.
- [ ] A test: an owner still live after the timeout gives exit 1, and only the one SIGINT was sent.
- [ ] A test: `etime` in each of its three forms (`mm:ss`, `hh:mm:ss`, `dd-hh:mm:ss`) parses.
- [ ] No code path sends any signal other than SIGINT.
- [ ] The usage text and README name the command.

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package.

Also inside the container: `node src/bin.ts stop no-such-branch` under plain node prints the
refusal, not a crash.

Host-only, after merge and a release: in hae, start a dispatch in one terminal, and run
`.speepobox/speepobox stop <branch>` in another. The run tears down, its log ends with the
interruption, `status` shows its row as interrupted, and its commits are on the branch.
