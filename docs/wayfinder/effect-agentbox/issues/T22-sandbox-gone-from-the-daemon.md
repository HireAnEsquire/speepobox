# T22 — The sandbox-gone answer comes from the daemon, not from its prose

Status: Done
Type: AFK
Blocked by: T9

Sequence: [ticket 08](../08-in-hae-sequence.md). A correctness fix to code already on the branch,
found by T9's host tracer on 2026-08-12 and recorded in that ticket's close-out, so it lands on its
own rather than waiting on a feature ticket — the same shape as [T20](T20-atomic-lock-claim.md) and
[T21](T21-serialize-lock-eviction.md).

**Land [T19](T19-signal-matrix.md) first if it is still open.** Both tickets add a case to the
live-tier file, and that is the one place they collide.

**Tracer: a pass whose container is killed mid-exec is named as a lost sandbox, and a pass whose
agent dies inside a container that is still running is not.**

## What to build

One question to the daemon, on the failure path only, replacing a regex over English.

### 1. What T9 built, and what its own tracer disproved

`src/agent/agent-cli.ts` decides matrix row 10 by matching the *text* of a `SandboxError`:

```ts
const SANDBOX_GONE = /is not running|no such container/i;
export const agentPassReason = (detail: string): AgentPassReason =>
  SANDBOX_GONE.test(detail) ? "sandbox-gone" : "exited";
```

That only ever matches docker's refusal to exec against an **already**-dead container. T9's review
recorded the gap as `Not-fixed` and named the live gate as where to settle it. The gate ran. A
container killed *during* the exec produced:

```
'claude --dangerously-skip-permissions -p' exited 137 in the sandbox 'agentbox-speepobox-t9-tracer'
```

**No daemon text at all** — the exec'd process took a SIGKILL and docker reported its exit code, not
a refusal. So there is no string to widen the pattern with, and matrix row 10 is reported as row 8.

### 2. The correction the code's own comment needs

`agent-cli.ts` argues against asking a second question:

> by the time a pass fails, "is it still there" answered from a fresh `docker inspect` is a different
> container's answer as often as it is this one's

That holds for a container addressed by **name**. `Sandbox.exec` addresses `handle.id`
(`src/sandbox/sandbox.ts`), and **container ids are never reused**, so `docker inspect <handle.id>`
is authoritative about that exact container and cannot answer for another. The reasoning, not the
conclusion, is what was wrong — and it is why this is a small ticket rather than an open question.

### 3. The answer is a typed field, and `AgentCli` stops reading prose

`AgentCli` knowing docker's error vocabulary is mechanism through the seam — the same objection
`sandbox/sandbox.ts` already makes to a domain tag whose methods ask for a `CommandExecutor`.
`Sandbox` is the only thing in this package that may speak docker, and it is the only thing that can
ask this question.

So `SandboxError` carries the answer:

```ts
export class SandboxError extends Data.TaggedError("SandboxError")<{
  readonly detail: string;
  // Whether the container this error came from is still there. Only `exec`
  // ever answers `true` — it is the one operation that can fail *because* the
  // sandbox went away underneath it (T22).
  readonly sandboxGone: boolean;
}> {}
```

`agentPassReason` then reads the field. **Delete the regex and the string parameter** — a predicate
over English is the defect, not the pattern it holds. A three-way enum here would duplicate
`AgentPassReason`, which is `AgentCli`'s vocabulary and not the sandbox's; the boolean is the whole
of what `Sandbox` knows.

`run` and `remove` set `false`. A failed start has no container to have lost, and a `remove` that
fails is already reported and swallowed by the finalizer (design rule 4).

### 4. What the inspect asks, and the one thing it cannot answer

Ask only when `exec` is about to fail. **The success path grows no docker call.**

`docker inspect -f '{{.State.Running}}' <handle.id>`, read three ways:

| Result | `sandboxGone` |
| --- | --- |
| a nonzero exit (`No such object`) | `true` — removed outright |
| `false` | `true` — still known to the daemon, no longer running |
| `true` | `false` — the container is alive, so the child died on its own |

**The shape that looks right and is not**: reading `.State.OOMKilled` to name an out-of-memory kill.
That flag is the **container's** OOM state. An agent CLI OOM-killed *inside* a container that keeps
running leaves it `false`, and that is exactly the case this ticket is trying to tell apart from a
dead sandbox. This ticket separates gone from not-gone and **does not identify OOM** — a 137 in a
live container is an ordinary nonzero exit here. Do not build OOM detection.

A container removed between the failed exec and the inspect answers `true`, which is true. Nothing
needs to defend against that window.

## Not in scope

`SandboxEnvVar.value?: string` — T9's close-out flags that an inline secret still typechecks, and
making that unrepresentable is a separate change with separate reasoning. The reconciler's container
listing (T8) is also a `Sandbox` observation and will want its own read; **do not build it here and
do not generalize this method for it**. No new tag, no provider abstraction, no `Schedule`.

## Read first

`src/agent/agent-cli.ts` and `src/sandbox/sandbox.ts` — both small, both read whole — plus
`AGENTS.md` and **SPEC §2 (lines 92–141) and §3 (142–175)**.

In `test/agent-cli.test.ts`, the case at `describe`-level named *"fails a pass whose sandbox
disappeared, naming that as the reason"* is the existing daemon-refusal path; it must keep passing,
now through the field rather than the string. The two rows either side of it are rows 8 and 9.

`test/support/exec-fake.ts` matches scripted commands **by rendered argv prefix**, so
`docker inspect` is scripted by adding one key — no fake needs widening.

**Already on the branch — do not rewrite** T1–T9's, T20's, or T21's modules. Amend `AGENTS.md` only
with a ruling you had to discover. **Do not touch hae files.**

## Effect wiring

- **Tags introduced**: none.
- **Tags consumed**: `Sandbox`, `AgentboxConfig`, `Reporter` — unchanged from T9.
- **Layer composition**: **unchanged — do not edit `src/app.ts`.** This changes the body of two
  existing modules and the shape of one error, not the graph.
- **Errors**: `SandboxError` and `AgentPassFailed` keep their meanings and their kinds. Both stay
  typed by the outcome-row test; a lost sandbox still writes `failed` at stage `implement`.

## Checkpoint order

The `SandboxError` field plus `exec`'s inspect reaches `npm run verify` on its own, with the sandbox
tests updated for the new construction sites and `agentPassReason` still holding its regex. Land that
first. Converting `agentPassReason` to the field and deleting the pattern is the second checkpoint,
and it is where the row-8/row-10 tests change.

## Acceptance criteria

- [ ] A pass whose container is killed **mid-exec** fails with reason `sandbox-gone`, not `exited`
- [ ] A pass whose child exits nonzero in a container that is still running fails with reason
      `exited`, including exit 137
- [ ] The already-dead-container path (docker's own refusal) still reports `sandbox-gone`, now
      without matching on the message text
- [ ] No regular expression over a docker message survives anywhere in `src/agent/`
- [ ] `docker inspect` runs only when `exec` is failing; a successful pass spawns exactly the docker
      commands it spawned before, asserted through the exec fake's `recorded` ref
- [ ] Nothing reads `.State.OOMKilled`, and no code claims to identify an out-of-memory kill
- [ ] All three failures still produce typed `AgentPassFailed`, a `failed` row at stage `implement`,
      and all three resources released in reverse
- [ ] `src/app.ts` is unchanged

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, grep bans, and fake-tier tests. `pre-commit` is not a
substitute and does not check this package.

Add a live case to the `verify:live` script, following the ones already there: start a pass, remove
its container mid-exec, and assert the reason is `sandbox-gone`. **The task container has no docker
socket**, so write it defensively and **do not report it as passing**.

**Host-only**, run by the user before landing:

```
node src/bin.ts <spec> --branch <throwaway-branch>
```

Twice — once removing the container mid-pass, which must now report **lost its sandbox**; once
letting the pass fail on its own inside a live container, which must still report an ordinary
nonzero exit. Both write `failed` at stage `implement` and leave `docker ps -a` by our labels empty.
