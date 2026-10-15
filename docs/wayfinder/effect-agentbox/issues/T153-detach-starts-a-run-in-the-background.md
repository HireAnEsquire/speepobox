# T153 — `--detach` starts a run in the background

Status: needs-triage
Type: AFK
Blocked by: T151

<!--
Ruled 2026-10-15 by a grill, beside T151 and T152. An agent asked to "get started on <ticket>" has
to start a dispatch and hand it back without waiting 10 to 30 minutes for it. Today that needs a
perl line: `bin.ts` re-raises SIGHUP as SIGINT, so a run dies with the shell that started it, and
`nohup` does not help, because our own SIGHUP handler still fires. Only a process in a new session
survives. The hae skill `hae-speepobox-dispatch` carries that perl line and a step that finds the
log by the slug rule. This ticket replaces both with one flag.

Decisions:
1. The parent starts the child at once and waits for one of two things: the child holds the lock
   (print the start line, exit 0) or the child exits (relay its output, exit 1). The guards run once,
   in the child. No second guard pass in the parent.
2. The parent relays the child's output up to the lock, so whoever ran the command (a person, or an
   agent's tool call) sees the plan, the warnings, or the refusal. After the lock, the run log is
   what anyone watches (`logs --follow`, T151). The child's console goes to one file per branch,
   which exists only to catch a crash. The run log still opens at the lock, never earlier (T4): a
   log means a run happened, and a refused dispatch must not become the newest log `logs` finds.
3. The child inherits the parent's whole environment. It is speepobox itself, and it resolves the
   credential and applies the allowlist to its own children. Starting it with the allowlist would
   drop a credential that comes from the shell environment, since the allowlist carries none (T23).
4. `--detach` implies `--no-input`. It is refused with `--dry-run` and with `--hard-reset`.
5. Until the parent prints the start line, the run belongs to the parent. On a 120-second timeout,
   or Ctrl-C during the wait, the parent sends the child SIGINT and waits for it to exit. No orphan.
-->

## What to build

### `--detach`

`speepobox <form> --branch <branch> --detach` starts the dispatch in a new process, waits until it
holds the lock, prints where to watch it, and exits 0. The run keeps going after the terminal or
the agent session that started it is gone.

Every dispatch form takes it: a spec, `--task`, `--resume … --feedback`, `--feature … --issues`.

### Refusals, from the command line alone

Through the usual renderer, exit 1, before any child starts:

- `--detach` with `--dry-run`: a rehearsal holds no lock, so there is nothing to wait for. Rehearse
  in the foreground.
- `--detach` with `--hard-reset`: it asks for confirmation, and a detached run cannot be asked.
- A command line missing an answer (no source, no `--branch`): the usual refusal. `--detach` never
  opens the picker, because it implies `--no-input`.

### The child

- **The command.** The same entrypoint the parent is running, with the same words minus `--detach`,
  plus `--no-input`, and `--repo-root` as the parent peeled it. The node binary, the script path, and
  the node flags are host reads, so they come from `bin.ts` as parameters (AGENTS.md, "Host reads
  live at the composition root").
- **A new session.** Spawn it with node's `detached: true` (a new session on POSIX) and `unref` it
  once it has started. A hangup to the parent's terminal then never reaches it. Leave `bin.ts`'s
  SIGHUP handler as it is: it is still right for a foreground run.
- **Stdin** is `/dev/null`.
- **Stdout and stderr** both go to `<runtimeRoot>/detached/<slug>.out`. The parent creates the
  directory, truncates the file, and passes it to the child. The next detach of the same branch
  overwrites it. It stays outside `logs/`, so `logs/` keeps one file per run.
- **The environment** is the parent's whole environment. See "The exception" below.

### The wait

The parent polls about every 200 ms. On each poll, it asks:

1. **Has the child exited?** Then it was refused or failed before the lock. Print what it wrote to
   the `.out` file that the parent has not yet printed, and exit 1.
2. **Does the slug's lock name the child's pid?** Read it through `readLockOnDisk`, as `status` does.
   When it does, find the run's log with T151's newest-log rule, and wait for a log whose number is
   at or after the spawn time (the log opens just after the lock). Then print the rest of the `.out`
   file up to that point, and then:

   ```
   started '<branch>' (pid <N>)
   log: <log path>
   watch: .speepobox/speepobox logs <branch> --follow
   ```

   Exit 0.

While it waits, the parent prints each new line of the `.out` file as it appears, so the plan block
and any warnings reach the terminal as they do on a foreground run.

**Timeout: 120 seconds.** Before the lock, the child only reads git, fetches, and checks docker. If
none of the two answers has come in 120 seconds, something is hung (the network, the daemon):

- Send the child SIGINT, once. It holds nothing yet, so this is safe.
- Wait up to 30 seconds for it to exit, printing its output.
- Exit 1 with `'<branch>' did not start within 120s`.

**Ctrl-C** on the parent during the wait does the same: SIGINT to the child, wait for it to exit,
then exit as an interrupted command does (`exit-code.ts`). Model this as a finalizer of the wait's
scope that signals the child unless the start line was printed. Do not use a `process.on` handler.

**The race.** If the child takes the lock just as the timeout or Ctrl-C fires, the SIGINT tears the
run down cleanly: the commits are kept and the row records the run as interrupted. After the child
exits, the parent says which case it was: the child never held the lock, or it held the lock and was
then stopped.

The parent signals only its own child, through the handle it spawned. A child the parent has not
reaped keeps its pid, so no pid identity check is needed here (unlike T152's `stop`).

### The exception

Add the spawn to `src/internal/exec.ts` as a new entry (for example `execDetached`). It is the one
entry that does not run its child to completion and does not apply the allowlist:

- It takes the parent's environment whole, as a parameter that `bin.ts` supplies from
  `process.env`. The child is speepobox, which resolves the credential through
  `agent/credential.ts` and applies the allowlist to every child it spawns. With the allowlist, a
  credential exported in the shell would be lost, because the allowlist carries no credential, by
  rule (T23).
- It returns a handle: the pid, a way to send SIGINT, and the exit. It sends no other signal.
- Its only caller is the detach module, and the command it runs is the package's own entrypoint.

Write this into AGENTS.md, "Subprocesses and the environment", as the one exception in `src/`, next
to the two in `test/`. Say why the allowlist would be wrong for this child, and that nothing else in
`src/` may spawn with an inherited environment. Update the "Nothing in `src/` may do either" sentence
to match.

### Where it sits

The logic lives in its own module (for example `src/detach/detach.ts`), not in `bin.ts`. The spawner
and the lock read reach it as parameters, so tests use a fake child and a scripted lock. `bin.ts`
recognizes `--detach` among a dispatch's words and hands the words to the module, instead of
running the dispatch itself.

The parent holds no lock, writes no ledger row, and writes nothing under `logs/`. Its writes are the
`detached/` directory and the `.out` file.

### Docs

- The `usage` text in `bin.ts`: `--detach` on the dispatch line.
- README, "Dispatching": a short section on running in the background. Show `--detach`, the start
  line, watching with `logs --follow`, stopping with `stop` (once T152 ships), and that the `.out`
  file is only for diagnosing a crash.

## Effect wiring

- **Tags introduced or consumed**: none new. `FileSystem` and `SpeepoboxConfig` from the read-only
  slice. The spawn goes through the new `internal/exec.ts` entry.
- **Layer composition**: the parent runs on `appBaseLiveFor(repoRoot, stdinIsTTY)`. It needs no
  dispatch layer, since the child does the dispatch.

## Acceptance criteria

- [ ] `--detach` with a child that takes the lock prints the relayed output, then the three start
      lines with the pid and log path, and exits 0.
- [ ] A test: a child that exits before the lock (a refusal) has its output relayed, and the parent
      exits 1.
- [ ] A test: a child that neither locks nor exits within 120 seconds gets exactly one SIGINT. The
      parent waits for its exit and exits 1 with `did not start within 120s`.
- [ ] A test: interrupting the parent during the wait sends the child exactly one SIGINT.
- [ ] A test: a child that took the lock as the timeout fired is reported as started and then
      stopped, not as never started.
- [ ] A test: `--detach` with `--dry-run`, and with `--hard-reset`, is refused before any spawn.
- [ ] A test: the child's words are the parent's minus `--detach`, plus `--no-input`.
- [ ] No code path sends the child any signal other than SIGINT.
- [ ] AGENTS.md names the exception in `src/`. The usage text and README name the flag.

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package.

Also inside the container: `node src/bin.ts --task x --branch b --detach --dry-run` under plain node
prints the refusal, not a crash.

Host-only, after merge and a release: in hae, start a dispatch with `--detach` and close the
terminal tab. The run keeps going. `logs <branch> --follow` in a new tab shows it, `status` shows
its row when it ends, and the desktop notification arrives. Repeat with an agent starting it from a
Claude Code session, then end that session.
