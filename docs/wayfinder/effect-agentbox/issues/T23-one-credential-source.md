# T23 — One source of truth for the agent credential

Status: Done
Type: AFK
Blocked by: T9

Sequence: [ticket 08](../08-in-hae-sequence.md). A correctness fix to code already on the branch,
recorded as a `Not-fixed` finding in T9's review and promoted out of the log in that ticket's
close-out, so it lands on its own rather than waiting on a feature ticket — the same shape as
[T20](T20-atomic-lock-claim.md), [T21](T21-serialize-lock-eviction.md), and
[T22](T22-sandbox-gone-from-the-daemon.md).

**Land [T22](T22-sandbox-gone-from-the-daemon.md) first if it is still open.** Both edit
`src/sandbox/sandbox.ts`, and that is where they collide.

**Tracer: a host whose credential is only where `doctor` told it to put one dispatches successfully —
and a host with no credential at all is refused before anything is acquired.**

## What to build

One resolver both readers use, and a guard in front of the run.

### 1. Two answers to one question

`doctor`'s probe 3 (`src/doctor/probes.ts`, `credentialProbe`) builds a provider from
`<packageRoot>/.env` **first**, falls back to `process.env`, and accepts **either**
`CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`. Its refusal names the file explicitly:

> run `claude setup-token`, put the token in CLAUDE_CODE_OAUTH_TOKEN in **.env beside config.toml**

The run reads somewhere else entirely. `allowedEnv()` in `src/internal/exec.ts` reads
`process.env[name]` for allowlisted names, the allowlist holds `CLAUDE_CODE_OAUTH_TOKEN` and not
`ANTHROPIC_API_KEY`, and `src/sandbox/spec.ts` forwards that name inward with `docker run -e NAME`.
**Nothing loads `.env` into the environment.** The probe's comment says it matches bash's
`set -a; source .env`, and bash genuinely sources it — here `fromDotEnv` builds a provider only the
probe consults.

So the probe over-reports on two independent axes:

| A host that | `doctor` says | The pass gets |
| --- | --- | --- |
| puts the token in `.env` only, as instructed | `ok` | nothing |
| exports `ANTHROPIC_API_KEY`, which the probe accepts | `ok` | nothing |

Both failures land **after** lock, checkout, and sandbox are acquired, as an agent CLI that cannot
authenticate — which T22 will report as an ordinary nonzero exit, because that is what it is.

### 1a. The run that proved it, 2026-08-13

Amended after this was watched happen, while running [T8](T8-reconciler.md)'s manual-testing step —
two concurrent dispatches, to exercise the reconciler against a live run. It reproduced twice, from
the same two terminals:

```
15:03:40  speepobox-tracer-b   Completed          (alone)
15:05:52  speepobox-live-a     Completed
15:06:06  speepobox-live-b     Failed  implement   overlapping live-a
15:06:38  speepobox-live-a     Completed
15:06:40  speepobox-live-b     Failed  implement   overlapping live-a
```

The whole of the failing run's log after the prompt:

```
agent > Not logged in · Please run /login
```

Container up, spec mounted, prompt delivered on stdin — only the credential missing. It read as a
concurrency limit and is not one: T10 and T8 dispatched **through bash** on 2026-08-12 and overlapped
for over an hour on that same token, four passes and ~30M tokens each. Two concurrent agent sessions
on one credential are fine.

The difference is where the token comes from. bash passes `--env-file "$BOX/.env"`
(`run.sh:1335`), so **docker reads the file** — every container, every shell. bessemer forwards
`docker run -e CLAUDE_CODE_OAUTH_TOKEN` with no value, so docker copies it from the `docker` child's
environment, which is `allowedEnv()`, which is `process.env` of the `node src/bin.ts` process.

So a bessemer dispatch authenticates **only from a shell that exported the variable**, and
`.bessemer/.env` — where `doctor` tells you to put it, and where it is — reaches nothing. The second
terminal had never sourced it. That is row 1 of §1's table, from the host it was written about.

Two consequences for this ticket, neither of which changes what §2 asks for:

- The failure surfaces as **an agent that is not logged in**, three resources and a container start
  after the question was answerable. §4's guard is what turns that into a refusal at the door.
- It makes parallel dispatch — the whole reason this tool exists — depend on undocumented shell
  state, while `doctor` reports `ok`. That is the cost of the duplication, not a separate defect.

### 2. The defect is the duplication, not either answer

Neither reader is wrong on its own. The defect is that **two places independently decide where a
credential comes from**, so whatever either one concludes is unverified by the other. Build one
resolver that answers *"is there a credential, under which name, and what is its value"*, and make
both the probe and the dispatch path read it. Then `doctor`'s green means the next dispatch can
authenticate, which is the only thing that row was ever for.

Keep the resolver's precedence as the probe already has it — `<runtimeRoot>/.env`, then the process
environment — because that is the documented advice and hosts already follow it. Keep both names
accepted, for the same reason: the probe promises `ANTHROPIC_API_KEY` works today, and silently
dropping it breaks a host that took it at its word. The resolver answers with the **name it found**,
so the container is handed the variable the agent CLI will actually look for.

### 3. Three traps, all of which typecheck

- **Do not mutate `process.env`.** Sourcing `.env` into the process hands the token to *every* child
  this package spawns, which is exactly what `extendEnv: false` and the one-variable-at-a-time
  allowlist exist to prevent (`internal/exec.ts`, `AGENTS.md`).
- **Do not render the value into argv.** T9 made `SandboxEnvVar.value` optional precisely so the
  credential crosses as `docker run -e NAME` and never as `-e NAME=value`: argv is readable by every
  process on the host and echoed by every command log we keep. Now that the value is in *our* hands
  rather than inherited, it must reach the `docker` child's **environment** and nowhere else.
- **Do not widen the process-env allowlist to cover this.** The allowlist forwards variables we did
  not read; this value we did. A second mechanism reaching the same child is one more place a secret
  can be spilled.

The plumbing between the composition root and the `docker` child is yours to choose. Whatever shape
it takes, host facts are **resolved once at the composition root and passed down** (`AGENTS.md`) —
the resolver runs there, not inside a command.

### 4. A missing credential is a guard's answer

A dispatch with no credential anywhere refuses **before the lock**, as a `GuardRefused`, carrying the
same advice probe 3 gives. This is the ruling T7 already established for the setup hook: *a missing
file is a guard's answer, not a container's*. Today the run acquires all three resources and dies at
the agent pass, which is three held resources and a container start spent on a question that was
answerable at the door.

No ledger row — SPEC §11's rule is that a row exists **iff** `RunLock` was acquired, and this refusal
happens before it.

## Not in scope

`SandboxEnvVar.value?: string` — T9's close-out flags that an *inline* secret still typechecks, and
making that unrepresentable by shape is a separate change with separate reasoning. Do not add a
second credential, a config key for one, or any provider abstraction. No `Schedule`, no retry.

## Read first

`src/doctor/probes.ts` (`credentialProbe` and the rows either side of it), `src/internal/exec.ts` —
the chokepoint, and the only file allowed to import `Command` — plus `src/sandbox/spec.ts`,
`src/dispatch/guards.ts`, `AGENTS.md`, and **SPEC §3 (lines 142–175), §6 (250–330), and
§11 (470–606)** — those ranges, not the whole file.

`guards.ts`'s `setupHookFound` is the worked example for §4: a config-declared thing that is not
there, refused before the container starts, with the advice in the refusal. Read that one guard and
its test rather than the module twice.

In `test/dispatch.test.ts`, `describe("dispatch preflight")` is where the new refusal belongs, beside
the dead-daemon, missing-image, and missing-setup-hook cases already there. In
`test/support/exec-fake.ts`, the `recorded` ref holds every word of argv every child ran — that is
how "the value is not in argv" becomes an assertion rather than an intention.

**Already on the branch — do not rewrite** T1–T9's, T20's, T21's, or T22's modules beyond what this
ticket names. Amend `AGENTS.md` only with a ruling you had to discover. **Do not touch hae files.**

## Effect wiring

- **Tags introduced**: none. The resolver is a module, not a tag — the same call the chokepoint makes
  (`internal/exec.ts`: "a tag here would recreate the `Shell.exec` anti-pattern").
- **Tags consumed**: `Sandbox`, `AgentboxConfig`, `Reporter` — unchanged.
- **Layer composition**: **unchanged — do not edit `src/app.ts`.** This adds no service.
- **Errors**: a missing credential at dispatch is a `GuardRefused` (typed, no row). `doctor` keeps
  reporting its own outcome as probe 3 and **must not start failing to build** — the read-only slice
  degrades rather than dies (`AGENTS.md`), so an unreadable `.env` is a probe result, never a defect.

## Checkpoint order

The resolver plus its own test is pure enough to reach `npm run verify` before either caller changes
— give it a `.env` fixture, an injected environment, and the absent case. Land it first. Rewiring
probe 3 onto it is the second checkpoint and should change no doctor test's expectations. The guard
and the value's path to the `docker` child are the third.

## Acceptance criteria

- [ ] One resolver answers where the credential comes from; `doctor`'s probe 3 and the dispatch path
      both read it, and no second place decides
- [ ] A credential present only in `<runtimeRoot>/.env` reaches the agent CLI inside the container
- [ ] A credential present only in the process environment still reaches it
- [ ] `ANTHROPIC_API_KEY` is honoured end to end, or accepted nowhere — the probe and the run agree
- [ ] The value never appears in argv, asserted through the exec fake's `recorded` ref
- [ ] `process.env` is never mutated, and the chokepoint's process-env allowlist gains no entry
- [ ] A dispatch with no credential anywhere refuses as `GuardRefused` before the lock, writes **no**
      ledger row, and carries probe 3's advice
- [ ] `doctor` still renders every row when `.env` is absent or unreadable, and never dies on it
- [ ] `src/app.ts` is unchanged

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, grep bans, and fake-tier tests. `pre-commit` is not a
substitute and does not check this package.

**Host-only**, run by the user before landing — the task container has no docker socket:

```
node src/bin.ts <spec> --branch <throwaway-branch>
```

Three ways, and the point of the ticket is the first:

1. with the credential **only** in `.bessemer/.env` and unset in the shell — the pass must
   authenticate,
2. with it **only** in the shell environment — the pass must still authenticate,
3. with it in neither — `node src/bin.ts doctor` must fail probe 3, and the dispatch must refuse at
   the guard, leaving no lock, no checkout, and no container.

Do not print the credential while testing, and do not paste `.env` into a terminal whose output is
captured.
