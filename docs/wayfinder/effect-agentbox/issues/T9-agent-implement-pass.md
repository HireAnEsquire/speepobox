# T9 — `AgentCli`: one implement pass

Status: Done
Type: AFK
Blocked by: T7

Sequence: [ticket 08](../08-in-hae-sequence.md), re-sliced 2026-08-10. First of the four tickets that
replace 08's T4 bullet.

**Tracer: an agent pass runs inside the sandbox and its commits are in the checkout.** Dispatch a
one-off spec, let the implement pass run, and after teardown the checkout's branch carries the
commits the agent made. Nothing is pushed and no PR exists yet — that is T11 and T12.

## What to build

The agent seam, and exactly one pass through it.

### 1. `AgentCli`

**Single-shot** (SPEC §2). This ticket builds `implement`; `review` is T10's and `describePr` is
T12's, each landing with its caller.

**A failed agent pass ends the run** (05 Q16R). `AgentCli.implement` is single-shot and the dispatch
core runs it once. **No `Schedule` wraps it, anywhere, ever** — failures at this seam are systematic
(credentials exhausted, config wrong, container gone), so a second attempt re-pays a cold session
against an unchanged condition. What makes that affordable is checkpointing: the agent commits each
coherent piece as it works, so a failed pass keeps what it finished and a human reads the log.

Named for its role, not its vendor (`AgentCli`, not Claude) — the tag is the future provider seam and
no provider abstraction is built behind it.

### 2. How a pass runs

- through `Sandbox.exec`, in the **foreground** — never a detached child (SPEC §4)
- **the prompt travels on stdin, never as a shell string**, so quotes, backticks, and `$(…)` in it
  arrive literally (`run.sh:1098-1100`). This is the property `--feedback` depends on in T17, and it
  is built in from the start rather than retrofitted
- **the assembled prompt is logged verbatim** before the pass, as `run.sh:1096` does — self-authored
  and secret-free
- output streams through `Reporter` events; the console subscriber renders them. A
  `process.stdout.write` inside the pass typechecks and is wrong
- the pass timeout is the existing `passTimeoutSeconds` config value

### 3. Prompts, for now

The implement prompt is a **package default file** plus a **pure interpolation function**
(SPEC §8 — interpolation stays pure). The `PromptSource` tag, its precedence chain, and the
`project-context.md` fragment are **T14's**; there is no client to override anything until then, and
a precedence chain with one root is a layer rather than a slice. Put the default prompt where T14 can
make it the package-root arm of the chain without moving it.

### 4. The agent credential

This is the one env-allowlist entry this ticket needs. **Grow the allowlist one variable at a time,
each with a note naming which child reads it** (`src/internal/exec.ts`, `AGENTS.md`). Presence only
ever reported, never the value — `doctor`'s probe 3 already sets that rule.

### 5. What the ledger records

| Failure | Row | Error |
| --- | --- | --- |
| pass exits nonzero (matrix row 8) | `failed` (implement) | typed `AgentPassFailed` |
| pass times out (matrix row 9) | `failed` (implement) | typed `AgentPassFailed`, timeout cause |
| container dies mid-pass (matrix row 10) | `failed` (implement) | typed `AgentPassFailed`, sandbox-gone cause |

All three release sandbox, checkout, and lock in reverse. The sandbox-gone predicate survives as a
**cause on the failure**, not as an abort condition on a schedule that does not exist (05 Q16R).
`RunStage` already carries `implement`; use the type.

## Not in scope

The review loop (T10), push and land (T11), `Forge` and the PR description (T12), `Notifier` (T13),
`PromptSource` (T14). Do not stub them. No retry, no `Schedule`, no second attempt.

## Read first

T7's setup-hook and `Sandbox.exec` work, `src/internal/exec.ts`, `src/config/config.ts`,
`src/reporter.ts`, `src/ledger/record.ts`, `AGENTS.md`, and **SPEC §2 (lines 92–141), §3
(142–175), §4 (176–249), §8 (368–386), and §11 (470–606)** — those ranges, not the whole file.
`run.sh:1090-1130` is the behaviour source, read as a reference document and never executed.

`Sandbox.exec` is the one thing here you must read closely; the setup hook beside it is the worked
example of calling it, and reading that one call site is worth more than reading the module twice.

**Already on the branch — do not rewrite** T1–T8's modules; amend `AGENTS.md` only with a ruling you
had to discover. **Do not touch hae files.**

## Effect wiring

- **Tags introduced**: `AgentCli`.
- **Tags consumed**: `Sandbox`, `Ledger`, `AgentboxConfig`, `Reporter`.
- **Not introduced**: `Forge`, `Notifier`, `PromptSource`, `Prompt`, `IssueStore`. Do not stub them.
- **Layer composition**: `AgentCli` runs its passes through `Sandbox`, so `AgentCliLive` is provided
  **after** the merged resource layer rather than inside it. Copy this, do not derive it:

  ```ts
  export const AppLive: Layer.Layer<
    AgentCli | Sandbox | Git | RunLock | Ledger | AgentboxConfig | Reporter | NodeContext.NodeContext,
    ConfigError
  > = Layer.provideMerge(
    AgentCliLive,
    Layer.provideMerge(
      Layer.mergeAll(SandboxLive, GitLive, RunLockLive),
      Layer.provideMerge(LedgerLive, Layer.provideMerge(AgentboxConfigLive, PlatformAndReporterLive)),
    ),
  );
  ```

  **`AppBaseLive` is byte-unchanged.**
- **Errors**: `AgentPassFailed` is typed (SPEC §3) — the run writes a row and reports a
  human-readable failure, which is the outcome-row test's positive case.

## Checkpoint order

The implement prompt file and its interpolation function are pure and tagless, so they reach
`npm run verify` with a test while `AgentCli` does not yet exist. Land that first, and the env
allowlist entry with it — one line and its note, green on its own.

The tag, its layer, and `app.ts` cannot be split: a composition naming a tag that does not exist does
not typecheck, so they are one commit. The three failure rows follow it, each with its ledger
assertion.

## Acceptance criteria

- [ ] `AgentCli.implement` is single-shot; no `Schedule`, retry, or second attempt exists anywhere
- [ ] The pass runs through `Sandbox.exec` in the foreground, with the prompt on **stdin**, never as
      a shell string
- [ ] The assembled prompt is logged verbatim before the pass, through a `Reporter` event
- [ ] A nonzero exit, a timeout, and a sandbox that disappears each produce typed `AgentPassFailed`
      with a distinguishable cause, a `failed` row at stage `implement`, and all three resources
      released in reverse (matrix rows 8–10)
- [ ] The pass honours `passTimeoutSeconds` from config, read from the `AgentboxConfig` tag
- [ ] The env allowlist gains exactly one entry, the agent credential, with a note naming which child
      reads it; no credential value is ever logged or reported
- [ ] The implement prompt is a package file plus a pure interpolation function, positioned so T14
      can make it the package-root arm without moving it
- [ ] `AppLive` matches the composition above verbatim; `AppBaseLive` is byte-unchanged

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, grep bans, and fake-tier tests. `pre-commit` is not a
substitute and does not check this package.

**Host-only**, run by the user before landing — the task container has no docker socket, so the
tracer cannot run inside it:

```
node src/bin.ts <spec> --branch <throwaway-branch>
```

Then `git log` the checkout's branch before teardown, or the branch after T11 lands. The pass must
have committed; the run must have released all three resources; `docker ps -a` by our labels must be
empty.

## Comments

**2026-08-12 — closed.** PR #4478. `APPROVED` at review round 3; `npm run verify` green with 187
tests. The largest dispatch of the sequence so far — 37.3M tokens over 5 passes, roughly 1.5× T7 —
which is what a ticket that introduces a tag, a layer, a prompt file, and a second chokepoint entry
point costs. 25 files, +1152/−49.

**The credential crosses by name and never by value.** `sandbox/spec.ts` made `SandboxEnvVar.value`
optional, and an absent value renders as `docker run -e NAME` — docker reads it from its own
environment, which is the chokepoint's allowlist and nothing else. So the token is never a word of
argv, never in `ps`, and never in a command log. The two allowlists compose deliberately: the
chokepoint lets the `docker` child read `CLAUDE_CODE_OAUTH_TOKEN`, and the spec forwards that name
inward. This is the best thing in the diff and it was self-derived.

Its one soft spot: the property is a *convention*, not a shape. `value?: string` still permits an
inline secret and it typechecks — unlike the no-ports and `SandboxMount`-has-no-mode invariants
beside it, which a future edit cannot express. Worth closing the same way if this file is opened
again.

**The host tracer settled the open question from review.** Round 2 recorded, and rounds 3 let stand:

> A container killed *mid-exec* answers 137 with no daemon message and is read as `exited` … matrix
> row 10's live gate is where the real string can be read.

The gate ran. The real string is `'claude --dangerously-skip-permissions -p' exited 137 in the
sandbox '…'` — **no daemon text at all**, so `SANDBOX_GONE` has nothing to match and the predicate
cannot be widened. The ledger row was `{"_tag":"Failed","stage":"implement"}`, all three resources
released in reverse, and the sandbox finalizer lost its `rm` to the manual one and reported through
`Warned` without failing the run (design rule 4). Everything behaved; only the *naming* is narrower
than this ticket claimed.

So record the narrowing: **matrix row 10 is distinguishable only in its daemon-refusal flavour** —
`docker exec` against an already-dead container — which is what `agent-cli.test.ts:297` fakes. A
container killed *during* the exec is reported as an ordinary nonzero exit, and this ticket's
acceptance criterion asked for more than that.

**The way to close it, which the code's own reasoning missed.** `agent-cli.ts` argues against asking
a second question because "a fresh `docker inspect` is a different container's answer as often as it
is this one's." That would hold for a container addressed by *name*. `Sandbox.exec` addresses
`handle.id`, and container ids are never reused — so `docker inspect <handle.id>` on the failure path
is authoritative about that exact container. It would also separate the case hiding underneath: 137
from the kernel OOM-killer against the `--memory` limit, in a container that is still alive. Those
two report identically today and call for opposite responses. Follow-up, not a reopen.

**The `Not-fixed` findings that stand.** `AgentOutput` arrives as one burst rather than narration,
because `claude -p` without `--output-format stream-json` prints its final text at the end; the seam
is right and only the liveness is missing. `renderFailure` has no `AgentPassFailed` case in the
renderer's test list. The console arm of the prompt split is untested because `renderConsoleEvent` is
private to the file the ticket says to copy rather than edit.

**One worth promoting out of the log**, because it is a live trap rather than a gap: the credential
reaches the container only from `process.env`, but `doctor`'s probe 3 reads it from
`<runtimeRoot>/.env` first and also accepts `ANTHROPIC_API_KEY`. **A host that follows the probe's
own advice gets an `ok` row and a pass that cannot authenticate.** Correctly out of scope here — §4
is exactly one allowlist entry, and sourcing `.env` is a new mechanism at the composition root — but
it should not wait for someone to hit it.
