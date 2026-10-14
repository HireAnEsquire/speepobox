# T19 — The signal matrix, the interrupt exit code, and live case 5

Status: Done
Type: AFK
Blocked by: T7

Sequence: [ticket 08](../08-in-hae-sequence.md), re-sliced 2026-08-10. **Split out of
[T7](T7-setup-hook.md) on 2026-08-11**, which carried both the setup hook and this; the hook
reaches its own gate and this reaches a different one, and together they overran a 20-minute pass.
Numbered T19 rather than renumbering T8–T18, since the blocking edges are explicit and dependency
order does not read off the number.

This ticket carries **08's original T3 tracer**.

**Tracer: all three resources released on Ctrl-C, on SIGHUP, and on success.** This is Claim 1's
evidence and it needs no agent involvement at all: the leak `run.sh:1024-1027` documents — macOS bash
3.2 not firing EXIT traps for a backgrounded function's subshell — becomes structurally impossible
rather than trapped. **SIGHUP is new behaviour**: bash leaks a container silently when a terminal tab
closes.

## What to build

Nothing acquires a resource here. What this ticket owes is proof that the release path already built
covers every way a run can end, plus the one exit code that is wrong today.

### 1. The signal matrix

| Path | Behaviour | Exit |
| --- | --- | --- |
| Ctrl-C once | full teardown (matrix row 16) | 130 |
| SIGHUP — terminal or tab closed | full teardown — **new**; bash leaks a container silently | 130, via the re-raise |
| Ctrl-C twice | hard exit; the next preflight's reconciler reclaims and reports (matrix row 17) | node's default; not asserted |
| `kill -9` / power loss | uncatchable; the reconciler reclaims | 137; nothing to assert |

The reconciler itself is T8's. What this ticket owes is that rows 16 and 17 behave as the table says
and that the two uncatchable paths leave state the reconciler can recognize.

`NodeRuntime.runMain` stays the only entrypoint idiom and `Effect.runPromise` stays grep-banned.

### 2. Ctrl-C must exit 130, and today it exits 0

`bin.ts`'s `teardown` maps a non-interrupt failure to 1 and everything else to
`process.exitCode ?? 0`, so an interrupted run — released and recorded correctly — still reports
success to the shell. Pre-existing since T1. Add the interrupt branch (128 + SIGINT's 2), keeping
`doctor`'s `process.exitCode` honored on every non-interrupt path.

Bash exits 130 here by default because the signal kills the script outright, so this is parity, not a
new behaviour — and an AFK dispatcher wrapped in a script is exactly the caller that a silent 0
misleads.

### 3. Live case 5

**The hold point is T7's setup hook**, which is why this ticket is blocked by it rather than by T6:
the hook is config-declared, so the live config points it at a long-running script and the harness
signals the child while all three resources are held. **No test-only flag on `dispatch`.**

Live case 5 (SPEC §11) — Ctrl-C once, Ctrl-C twice, SIGHUP, `kill -9`, real processes, real signals,
each asserting no leaked container, no leaked lock, and no leaked checkout. These are **regression
tests first**: SIGHUP-teardown and second-Ctrl-C are new behaviour with no bash equivalent, and
untested signal paths are exactly what bash had.

**Known and accepted**: the task container has no docker socket, so the agent writing these cannot
run them. Add them to the `verify:live` script T6 introduced, write them defensively, and **do not
report them as passing**.

## Not in scope

`Sandbox.exec` and the setup hook (both T7), the reconciler (T8), and every agent-facing service. Do
not stub them.

## Read first

T7's setup hook and its live-tier harness, `src/bin.ts`, `src/dispatch/run.ts`, `AGENTS.md`,
and **SPEC §4 (lines 176–249) and §11 (470–606)** — those ranges, not the whole file.

In `test/run-lock.test.ts`, the `describe("the run's scope")` block is the shape to follow: it
already asserts the interrupt path at one-resource depth through the test `Reporter`'s event `Ref`.

**Already on the branch — do not rewrite** T1–T7's modules; amend `AGENTS.md` only with a ruling you
had to discover. **Do not touch hae files.**

**There is exactly one teardown path already, and you add none — that is the point of this ticket,
not a gap in it.** `NodeRuntime.runMain` registers **SIGINT and SIGTERM** and interrupts the main
fiber; `bin.ts` has used it since T1, so every `Effect.acquireRelease` finalizer in the scope already
runs on Ctrl-C. **SIGHUP is not on that list** — measured in T4 against
`@effect/platform-node-shared`'s `runtime.js` — so `bin.ts` re-raises SIGHUP as SIGINT (`93126a305b`)
and the hangup arrives at the same single handler. Both shims are on the branch before you start.

What this ticket proves is that the *existing* release path covers all four signal paths at
three-resource depth. A `process.on("SIGINT", …)` or a SIGHUP handler that tears down itself both
typecheck and both add a second teardown racing the first; they are the thing to keep out. `kill -9`
is the one path no finalizer can serve, which is why it is the reconciler's job in T8.

T4 carries the same note for the one-resource case, with the correction that produced it; this is the
ticket where it is load-bearing.

## Effect wiring

- **Tags introduced**: none.
- **Tags consumed**: `Sandbox`, `Git`, `RunLock`, `Ledger`, `AgentboxConfig`, `Reporter`.
- **Not introduced**: `AgentCli`, `Forge`, `Notifier`, `PromptSource`, `Prompt`, `IssueStore`. Do not
  stub them.
- **Layer composition**: **unchanged — do not edit `src/app.ts`.** This ticket adds no service and no
  method. Leave the composition exactly as T7 left it.
- **Errors**: an interrupt is neither a typed error nor a defect — it releases in reverse and records
  `interrupted`.

## Checkpoint order

The exit-code branch in `bin.ts` and its test reach `npm run verify` on their own, before any
three-resource signal assertion is written. Land that first.

## Acceptance criteria

- [ ] Ctrl-C once tears down sandbox, checkout, and lock in reverse order and records `interrupted`
      (matrix row 16)
- [ ] SIGHUP tears down all three the same way — the divergence from bash, asserted rather than
      assumed
- [ ] An interrupted run exits **130**, and every non-interrupt path still honors the
      `process.exitCode` `doctor` sets
- [ ] Ctrl-C twice hard-exits and writes no row, leaving state a reconciler can recognize
      (matrix row 17)
- [ ] Release ordering is asserted through the test `Reporter`'s event `Ref`, not by inspection
- [ ] No second teardown path exists — no `process.on` handler that releases anything
- [ ] Live case 5 exists under `verify:live`, uses T7's setup hook as its hold point, and requires no
      test-only flag on `dispatch`
- [ ] `src/app.ts` is unchanged

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, grep bans, and fake-tier tests. `pre-commit` is not a
substitute and does not check this package.

**Host-only**, run by the user before landing:

```
npm run verify:live
```

Then the three tracer paths by hand, each followed by a labelled `docker ps -a`, a runtime-root lock
check, and a checkout-directory check, all of which must come back empty:

1. let it run to completion,
2. Ctrl-C once mid-setup-hook,
3. close the terminal (SIGHUP) mid-setup-hook.

## Comments

**2026-08-12 — closed.** PR #4479. 8 files, +869/−12, the smallest of the recent dispatches. The
review pass left one commit unreviewed (`08544d969d`, two `AGENTS.md` rulings, 4 inert lines);
inspected by hand at merge and correct. `npm run verify` green at 207 tests, `verify:live` green at 7
after the fix below.

**This was dispatched in spec mode by mistake** — `<spec> --branch` rather than
`--feature effect-agentbox --issues 19` — so the run wrote `issues: {}` and never stamped the ticket.
The work is unaffected; only the bookkeeping was, and it was done by hand. Feature mode is the
default for anything with a ticket.

**Three of four live signal cases passed against real signals on the first try**, including SIGHUP
teardown, which is new behaviour with no bash equivalent and the reason §1 asked for the live tier at
all. The fourth was red, and the defect was in this ticket.

**Criterion defect: "Ctrl-C twice hard-exits and writes no row" is unsatisfiable as written, because
it names a point on a race.** The live case delivers the second interrupt 25 ms after the first. By
then the first interrupt's teardown has often already written its `Interrupted` row and not yet
released the lock — so "no row" is true only if the second signal wins a race no test can fix, and
tightening the delay just moves the coin-flip. Worse, the test's own comment had restated SPEC §11 as
"a row exists iff the lock was acquired **and the run reached its end**." SPEC §11 says iff `RunLock`
was acquired, full stop. The test had silently strengthened the spec and then asserted the stronger
form.

Production was correct throughout. The assertion now says what is actually invariant: **at most one
row, and if there is one it is `Interrupted`.** `Completed` or `Failed` there would be the real
defect — a run claiming it reached its own end while leaving all three resources on the host.

Two things to carry forward. **T8 inherits the consequence**: the reconciler will meet runs that have
an `Interrupted` row *and* a live-looking lock, container, and checkout, so it must not read "a row
exists" as "this run finished." That line is now in T8's ticket. And **a test comment that restates
the spec is a place the spec can drift** — this one strengthened §11 by a clause, typechecked, and
stayed green for as long as the race happened to fall its way.

**Live-tier cost, measured.** 7 tests, 15.5 s. The four signal cases are 13 s of it at ~3.2 s each,
uniform because the cost is fixed per case: a real `node src/bin.ts` child (cold start plus
type-stripping the whole module graph, since the distribution model runs TS source), a clone, a real
`docker run`, the hold-marker poll, the signal, and teardown. `sandbox-spec` and `sandbox-leak` in
the same run are ~500 ms per test because they talk to dockerd without spawning a dispatch. Against
the fake tier's 207 tests in 2.4 s that is ~250× per test, which is why `verify`, not `verify:live`,
is the gate. It grows linearly — T8's live case 4 and T22's case each add ~3 s — and the four signal
cases cannot be parallelised, because the label scope is the host's real repo and concurrent cases
would see each other's containers.
