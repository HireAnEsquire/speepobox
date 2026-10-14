# T90 — The setup step and the land say what they did

Status: Done (PR #50. `docker exec` now omits `-i` when no stdin is given, which no live run had exercised at merge. A failed hook's stderr reaches the log twice, as `setup !` lines and inside `SetupFailed`'s detail. `notifications.ts` gained the four new events as silent cases, which its exhaustive switch requires)
Type: AFK
Blocked by: none.

<!--
Found by P2's first live feature run, 2026-09-23 (MAP). A dispatch sat at `sandbox: acquired` for
nine minutes while `npm ci` in the setup hook stalled on a slow registry, then failed at stage
`setup`. The log said nothing between `sandbox: acquired` and `sandbox: released`: no hook output
and no reason. The run that then succeeded logged `pushed: 3 new commit(s) this run` for a push that
carried four, and T77's status commit, the fourth, left no line at all.
-->

## What to build

**The setup hook's output and its failure reach the run log. The setup step has a time limit. The
land logs the status commit it made and counts every commit it pushed.**

### 1. The setup hook's output is logged

`runSetupHook` (`dispatch/setup-hook.ts`) calls `Sandbox.exec` with no options, so nothing receives
what the hook prints. Pass `onOutput` and `onStderr`, the streaming half `boundaryIn` and the agent
pass already use, and emit what arrives as `Reporter` events. A reader of the log sees each line of
the hook's output (`npm ci`'s included), prefixed so it reads as the hook's rather than the agent's.
The console shows the same lines on the same terms as a pass's output (`AgentOutput`).

Add a line when the hook finishes, with how long it took. That is the one place a dispatcher
watching the console learns the run has moved from setup to the first pass.

### 2. A failed setup says why, in the log

A failed hook ends the run at stage `setup` with a `SandboxError`, and its detail (the command,
the exit code, stderr) is printed on stderr at exit, after the log's bracket has closed. The log
stops at `sandbox: released` and never says why. This is the gap T55 closed for passes with
`PassFailed`. Emit one event for the failure before the scope releases, carrying the error's detail,
so the log's last word before the releases is the reason. It is **not** a step notification
(AGENTS.md, *A step notification means…*): the failure ends the run, and the terminal notification
already says so.

### 3. The setup step has a time limit

Only agent passes have a budget (`pass-timeout`). Add a config key, `setup-timeout`, in seconds,
default **600**, decoded in `BessemerConfig` beside `pass-timeout`. The run reads the key through the
tag, never through a `Config.*` read at the call site (AGENTS.md). Cap the hook's exec with
`Effect.timeoutFail`, as the agent pass does (AGENTS.md, *The pass budget is the caller's timeout*):
the interrupt closes the exec's scope and kills the docker child, and nothing inside the container
wraps the command in `timeout`. A timeout fails the run at stage `setup` with a typed error whose
message names the limit and the key. It reaches the log through §2's event like any other failure.
The case is live-clock (`it.scopedLive`), for the reason T9 gives.

Mention `setup-timeout` in `.bessemer/config.toml`'s comment on the setup hook, where a reader looks
for how long the hook may run.

### 4. The land logs the status commit and counts what it pushed

In `dispatch/land.ts`, T77's status commit is made between the fetch-back and the push, and only
its failure emits anything (a `Warned`). When it succeeds, emit an event naming the stems it marked
`Done` and the branch, so the log records a commit the dispatcher's own identity authored.

`CommitsPushed` is emitted after the push, but its `thisRun` was counted before the status commit
existed, so the line undercounts what went out by one whenever the commit was made. Count what the
push carried: agent commits and the status commit together, with the status commit said separately
in the line or in the event above. Keep the pre-status count where it gates the status commit
(T77's `thisRun > 0`, 14 lesson 5). That gate is about agent work, and it must not start counting
bookkeeping.

## Effect wiring

- **Tags introduced or consumed**: consumes `Sandbox`, `Reporter`, `BessemerConfig`. No tag
  introduced. The new events are `ReporterEvent` cases, rendered by `app.ts`'s console renderer and
  `run-log.ts`. `notifications.ts` gains no case.
- **Layer composition**: unchanged.

## Acceptance criteria

- [ ] A setup hook that prints lines has each one in the run log, marked as the hook's, and a
      finishing line with its duration.
- [ ] A setup hook that exits nonzero leaves a log whose last event before the releases carries the
      exit code and the hook's stderr. The row is `Failed` at stage `setup`, as today.
- [ ] A setup hook that runs past `setup-timeout` is interrupted, the docker child is killed, and the
      run fails at stage `setup` with a message naming the limit and `setup-timeout`. Live-clock.
- [ ] `setup-timeout` decodes from `config.toml`, the environment, and flags like `pass-timeout`,
      and defaults to 600.
- [ ] A feature run that approved issues logs the status commit's stems and branch, and its pushed
      line accounts for every commit the push carried.
- [ ] A run whose status commit fails still logs the `Warned` and pushes, as today, and its pushed
      line counts only what went out.
- [ ] `stepNotificationBodyFor` is unchanged.

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package.
