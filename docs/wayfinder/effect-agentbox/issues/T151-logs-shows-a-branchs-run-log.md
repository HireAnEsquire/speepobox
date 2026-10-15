# T151 — `logs` shows a branch's run log

Status: Done (PR #9. `logs <branch> [--follow]` in `src/logs/`, on the read-only slice. The newest log is chosen by `newestLogFor`, off the name alone; output goes through two new `ReporterEvent`s, `LogOpened` and `LogLine`. Ctrl-C during `--follow` is untested; the host-only check is still to run.)
Type: AFK
Blocked by:

<!--
Ruled 2026-10-15, planning a hae skill that starts a dispatch from a Jira ticket. The skill starts
the run in the background, so the dispatcher needs a way to watch it. The run log has everything,
at `<runtimeRoot>/logs/<runId>.log`, but nothing hands a dispatcher that path for a branch: `status`
does not show it, and a run ID is `<slug>-<epoch ms>` (T47), which nobody types. Today the way to
find it is `ls -t`.

A new read-only command, beside `status`. It reads files; it runs no git, no docker, and no ledger
read.
-->

## What to build

### `speepobox logs <branch> [--follow]`

`logs <branch>` prints the newest run log of that branch to stdout, then exits 0.

- **Which file.** The slug is `slugFor(branch)` (`src/dispatch/plan.ts`). A file under
  `<runtimeRoot>/logs/` belongs to that slug when its name is `<slug>-<digits>.log` exactly. Parse
  the name: strip the trailing `-<digits>.log` and compare what remains to the slug. A prefix match
  is wrong, because slug `foo` would then claim `foo-bar-1791813203269.log`.
- **Which run.** The newest is the largest `<digits>`, which is the run's start time in epoch ms.
  Read it off the name, never off the file's mtime.
- **The path first.** Before the contents, print one line naming the file, so a reader can open it
  elsewhere.
- **No log.** A branch with no matching file is a refusal through the usual renderer, exit 1:
  `no run log for '<branch>' under <runtimeRoot>/logs`. A rehearsal writes no log (T48), so a branch
  that was only ever rehearsed gets this refusal too.
- **No branch.** `logs` with no branch is a refusal naming the usage line. It does not open the
  picker.

### `--follow`

With `--follow`, after printing the file, `logs` keeps printing what is appended to it while the run
is live, the way `tail -f` does.

- **Live** means: the slug's lock (`lockPathFor`) exists, and its owner is alive. Ask exactly as
  `status` asks, through `readLockOnDisk` (`src/reconcile/lock-on-disk.ts`) and `ownerIsAlive`
  (`src/lock/liveness.ts`). Do not write a second liveness rule.
- **Polling.** Poll the file about once a second, and print the bytes past what was already printed.
  On each poll, ask liveness too.
- **The end.** When the run is not live, read the file one last time, print the rest, and exit 0.
  The run log closes before the lock is released (AGENTS.md, "The run log opens after the lock"), so
  a log whose lock is gone is complete.
- **Not live at the start.** `--follow` on a finished run prints the file and exits, as plain `logs`
  does.
- **Ctrl-C.** It ends `logs` and only `logs`. It touches no lock, no container, and no file, and it
  exits as an interrupted command does (`exit-code.ts`).
- **A newer run.** If a newer run of the same branch starts while `logs` is following, `logs` keeps
  following the file it chose. Stopping at the old run's end is correct.

### Where it sits

`logs` belongs to the read-only slice, beside `status`. Intercept it in `bin.ts`'s `argv[0]`
switch, and give it `appBaseLiveFor` as `status` gets it. A malformed `config.toml` falls back to
the committed defaults there, so `logs` still works when the config is broken.

It needs `FileSystem` and the config's `runtimeRoot` and nothing else. Its logic lives in its own
module (for example `src/logs/logs.ts`), not in `bin.ts`, because nothing in `bin.ts` can be
asserted (AGENTS.md).

### Docs

- The `usage` text in `bin.ts`: one entry for `speepobox logs <branch> [--follow]`, beside `status`.
- README, "Watching and cleaning up": a short paragraph and the command, after `status`. Say that a
  background dispatch is watched with `.speepobox/speepobox logs <branch> --follow`.

## Effect wiring

- **Tags introduced or consumed**: none new. `FileSystem` and `SpeepoboxConfig`, which the read-only
  slice already provides.
- **Layer composition**: unchanged. `logs` gets `appBaseLiveFor(repoRoot, stdinIsTTY)`, as `status`
  does.

## Acceptance criteria

- [ ] `logs <branch>` prints the path line and then the contents of the newest
      `<slug>-<digits>.log`, and exits 0.
- [ ] A test: with `foo-100.log`, `foo-200.log`, and `foo-bar-300.log` in `logs/`, `logs foo` prints
      `foo-200.log`. The newest is chosen by the number in the name, and slug `foo` does not claim
      `foo-bar-…`.
- [ ] A test: a branch with no log is refused with `no run log for '<branch>'` and exit 1.
- [ ] A test: `--follow` with a live owner prints lines appended after it started, and exits 0 once
      the lock is gone, having printed everything in the file.
- [ ] A test: `--follow` with no live owner prints the file and exits without waiting.
- [ ] `logs` works with a malformed `config.toml`, as `status` does.
- [ ] The usage text and README name the command.

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package.

Also inside the container: `node src/bin.ts logs no-such-branch` under plain node prints the refusal,
not a crash.

Host-only, after merge and a release: in hae, start a dispatch in one terminal, and run
`.speepobox/speepobox logs <branch> --follow` in another. Lines appear as the run writes them, and
`logs` exits when the run ends.
