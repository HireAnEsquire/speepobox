# T7 — `Sandbox.exec` and the setup hook

Status: Done
Type: AFK
Blocked by: T6

Sequence: [ticket 08](../08-in-hae-sequence.md), re-sliced 2026-08-10. **Narrowed on 2026-08-11**:
this ticket originally carried the signal matrix, the interrupt exit code, and live case 5 as well.
Those reach a different gate and are now [T19](T19-signal-matrix.md), which this ticket blocks —
T19's hold point is the setup hook built here.

**Tracer: a config-declared script runs inside the container, and its failure ends the run cleanly.**
Point the config at a host script, dispatch, and watch it mount read-only and execute through
`Sandbox.exec`. Point it at one that exits nonzero and the run releases sandbox, checkout, and lock
in reverse and records a `failed` row at stage `setup`.

## What to build

The step that holds the run open, and the seam it runs through.

### 1. `Sandbox.exec`

The third method on the tag T6 introduced, built here because this is where its first caller lands.
The agent pass runs `docker exec` in the **foreground** (SPEC §4) — Effect issue #5592
(detached-child cleanup) is sidestepped by never spawning detached children, since sandboxes are
dockerd-owned and teardown is an explicit `docker rm -f` finalizer.

### 2. The setup hook

**Generic and config-declared, not hae-specific**: config names a host script, it is mounted
read-only into the container, and it runs via `Sandbox.exec`. hae's own `.agentbox/setup-db.sh` is an
example **to read, never a thing to port or modify** — it becomes data at P7, and templates are P5.

Its failure is a typed `SandboxError` with the sandbox, checkout, and lock all released and a
`failed` row at stage `setup` (matrix row 7).

An **absent** hook is not a failure: config that names no script skips the step, and the run proceeds.
A config that names a script that is not there *is* a failure, and it is caught before the container
starts rather than inside it — a missing file is a guard's answer, not a container's.

## Not in scope

The signal matrix, the interrupt exit code, and live case 5 (all T19). The reconciler (T8) and every
agent-facing service. Do not stub them.

## Read first

T6's `Sandbox` module and its live-tier harness, `src/internal/exec.ts` — every subprocess goes
through it and it is the only file allowed to import `Command` — plus `src/config/config.ts`,
`src/dispatch/run.ts`, `src/ledger/record.ts`, `AGENTS.md`, and **SPEC §4 (lines 176–249)
and §11 (470–606)** — those ranges, not the whole file.

`.agentbox/setup-db.sh` as an example only, read once and not ported.

In `test/dispatch.test.ts`, `describe("dispatch preflight")` is where a config-names-a-missing-script
refusal belongs, beside the dead-daemon and missing-image cases already there.

**Already on the branch — do not rewrite** T1–T6's modules; amend `AGENTS.md` only with a ruling you
had to discover. **Do not touch hae files.**

## Effect wiring

- **Tags introduced**: none.
- **Tags consumed**: `Sandbox`, `Git`, `RunLock`, `Ledger`, `AgentboxConfig`, `Reporter`.
- **Not introduced**: `AgentCli`, `Forge`, `Notifier`, `PromptSource`, `Prompt`, `IssueStore`. Do not
  stub them.
- **Layer composition**: unchanged from T6 — a new method on an existing tag adds no layer. Copy,
  do not derive:

  ```ts
  export const AppLive: Layer.Layer<
    Sandbox | Git | RunLock | Ledger | AgentboxConfig | Reporter | NodeContext.NodeContext,
    ConfigError
  > = Layer.provideMerge(
    Layer.mergeAll(SandboxLive, GitLive, RunLockLive),
    Layer.provideMerge(LedgerLive, Layer.provideMerge(AgentboxConfigLive, PlatformAndReporterLive)),
  );
  ```

  **`AppBaseLive` is byte-unchanged.**
- **Errors**: a setup-hook failure is a typed `SandboxError` (SPEC §3).

## Checkpoint order

The config key for the hook, plus the guard that refuses a named-but-missing script, reaches
`npm run verify` on its own — before `Sandbox.exec` exists and before anything is wired into the run.
Land that first, then `exec`, then the hook step that consumes both.

## Acceptance criteria

- [ ] `Sandbox.exec` runs in the foreground, through the chokepoint, spawning no detached child
- [ ] The setup hook is config-declared, mounted read-only, and run through `Sandbox.exec`; no
      hae-specific path is baked into the package
- [ ] Config that names no hook skips the step and the run proceeds
- [ ] Config that names a script that does not exist refuses before the container starts, holding
      nothing
- [ ] A failing setup hook releases sandbox, checkout, and lock in reverse order and writes a
      `failed` row at stage `setup` (matrix row 7)
- [ ] Release ordering is asserted through the test `Reporter`'s event `Ref`, not by inspection
- [ ] `AppLive` and `AppBaseLive` are byte-unchanged

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, grep bans, and fake-tier tests. `pre-commit` is not a
substitute and does not check this package.

**Host-only**, run by the user before landing:

```
node src/bin.ts <spec> --branch <throwaway-branch>
```

Once with the config pointing at a working hook and once pointing at one that exits nonzero. The
second must record `failed` at stage `setup`, and both must leave `docker ps -a` by our labels empty,
with no lock and no checkout behind them.

## Comments

**2026-08-12 — closed.** PR #4474, merged. `APPROVED` at review round 3; `npm run verify` green at
the tip with 165 tests. The host tracer ran three ways and all three held: a working hook, a hook
exiting nonzero (`failed` at stage `setup`), and a **named-but-missing** hook, which refused from the
guard and wrote no ledger row at all — the SPEC §11 rule that a row exists iff the lock was acquired,
observed rather than asserted.

Two rulings the implement pass reached on its own and are worth keeping. The mount is the single
script at `/agentbox/<basename>`, never the host directory holding it, because that directory also
holds `.env` and other runs' state. And the hook runs as `bash <target>` rather than executing
directly, because the mount is read-only and carries the host file's mode, so a hook without its
execute bit would fail for a reason unrelated to what it does.

The narrowing held: the pass reported "`bin.ts` untouched; nothing here touches SIGHUP teardown or
the exit code (T19)", so nothing leaked in from the ticket's pre-split text.

**Review round 1 found a real coverage hole**: the guard had three refusal cases and no passing case,
and every other dispatch test named no hook, so inverting the check — refuse when the file *is*
present — turned the whole suite green. It added the passing case. Round 2 changed only a header
comment, which is what prompted the `approved` verdict now covering a round whose only edits cannot
change behaviour (`.agentbox/review-prompt.md`); under the old wording that round forced a third pass,
and a comment landing on the final round would have stamped the ticket `needs-work`.

**The PR body's manual-testing steps were the weakest artifact of the run.** They named a spec file
that has never existed (`tasks/T7-exec-and-setup-hook.md`; `tasks/` was empty), and they
mixed cwds between steps without that mattering to their pathspecs. T20's PR had the same class of
defect — a `grep` pipeline whose stated expectation its own filter removed. Nothing verifies a PR
body, so treat its steps as a draft to read rather than a script to run.

Sizing: implement 691s over 87 turns, review 1021s across three rounds, 24.6M tokens over five
passes — near 4× T20's. The T7/T19 split was load-bearing; the estimate of ~75 calls after the carve-out
fit the cap with room.
