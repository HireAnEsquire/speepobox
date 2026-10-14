# T6 — `Sandbox`: the container resource, its spec type, and the live tier

Status: Done
Type: AFK
Blocked by: T18

Sequence: [ticket 08](../08-in-hae-sequence.md), re-sliced 2026-08-10. Draws on the design in
[`superseded/scoped-shell.md`](superseded/scoped-shell.md), which is source material and not a live
ticket.

**Tracer: a container is created and torn down, and `docker ps -a` filtered by our labels comes back
empty.** Dispatch, watch the container appear with both ownership labels, watch the scope release it,
and confirm dockerd holds nothing afterwards — on success and on failure alike.

## What to build

The third and last resource in the `Scope`, plus the test tier that can see dockerd.

### 1. `Sandbox`

**Scoped in the interface, not at the call site** (SPEC §2). This ticket builds `run(spec)` and
`remove`; **`exec` is not built here** — its first caller is T7's setup hook, and a method with no
consumer is a layer rather than a tracer bullet.

Named for its role: the Docker implementation is `Sandbox.dockerLayer`, and **no provider abstraction
is built** — the tag is the seam (05 Q22).

### 2. The spec type

Expressed in our vocabulary — **image reference, mounts, env allowlist, resource limits,
capabilities** — never as a `docker run` flag bag. Two invariants are **unrepresentable rather than
checked** (SPEC §9):

1. **No published ports** — the spec type has *no ports field at all*. Not a flag to misuse, not an
   escape hatch. Bash added a post-start `docker port` check that fails closed; that is a check a
   future edit can bypass, and this is a shape a future edit cannot express.
2. **No userinfo crossing the boundary** — `RepoUrl` already carries this from T5; the sandbox spec
   takes the branded type, never a string.

**The ports invariant gets a `@ts-expect-error` shape pin** (design rule 2): adding a `ports` field
must turn the pin into a hard error, forcing the edit to delete a test that names the invariant.
`RepoUrl`'s rejection stays an ordinary decode test — nothing whose only job is re-proving the
compiler.

Caps drop to none by default; any cap-add is **config-declared**, following bash's rule of adding
back only what the setup hook's root path demonstrably needs (`run.sh:1260`). The **env allowlist
grows one variable at a time, each with a note naming which child reads it** (`AGENTS.md`,
`src/internal/exec.ts`). This ticket adds none it does not need; the agent credential arrives with
`AgentCli` in T9.

### 3. Ownership

**Declared, never inferred** (design rule 3). Every sandbox carries `agentbox.managed=true` +
`agentbox.repo=<hash of repo root>`, applied through **T2's `src/ownership/labels.ts`** — do not
re-derive the hash or the filter arguments. That module exists so creation and query agree by
construction rather than by review, and the repo root arrives as a parameter from the composition
root because it is a host fact (`AGENTS.md`). A unit test asserts the renderer always attaches both
labels. The grep ban on container-name-based ownership queries stays green.

### 4. The live tier — `npm run verify:live`

**New here.** T1 and T2 touched no dockerd, so the ticket that introduces `Sandbox.dockerLayer` owes
the script along with its first live cases (SPEC §11).

Host-only, tagged, against a real dockerd. **Deliberately not `it.skipIf(noDocker)` inside `verify`**:
skipped-is-green in exactly the environment that writes all the code is the false-green shape ticket
04 already ate once. Wire the tag so live cases can never run under `verify` and can never silently
skip.

Three of SPEC §11's five live cases land here:

1. **Leak under defect** — real `dockerLayer`, fake everything else, defect mid-scope, then
   `docker ps -a` filtered by our labels returns empty. "Our fake released" is not "dockerd has no
   container" (matrix row 22).
2. **The spec type renders to a `docker run` dockerd accepts** — caps, mounts, limits. A fake accepts
   any garbage.
3. **No published ports, live** — the type makes the violation unrepresentable, but it only
   constrains our renderer; one `docker port` assertion proves the renderer honors it.

Live case 4 (label filter selectivity) belongs to T8's reconciler; live case 5 (the signal matrix)
belongs to T7, which builds the hold point that makes it possible.

**Known and accepted**: the task container has no docker socket and runs `--cap-drop ALL`, so the
agent writing these tests cannot run them. Write them defensively and **do not report them as
passing** — the user runs `verify:live` on the host before landing, and breakage comes back as
feedback.

### 5. What the ledger records

A sandbox start failure — daemon, image, or caps — is a typed `SandboxError` with checkout and lock
released and a `failed` row at stage `sandbox` (matrix row 6). A sandbox or lock **finalizer** that
fails is reported via `Reporter` and swallowed; it becomes the reconciler's problem and never masks
the run's own error (matrix row 19).

## Not in scope

`Sandbox.exec`, the setup hook, the reconciler, and every agent-facing service. Do not stub them.

## Read first

`src/ownership/labels.ts`, `src/internal/exec.ts`, `src/status/status.ts` (how the docker CLI is
already queried by label), `src/app.ts`, `src/ledger/record.ts`, T5's `Git` and T18's checkout
module, `AGENTS.md`, and SPEC §§2, 3, 4, 9, 11.

**Already on the branch — do not rewrite** T1–T5's and T18's modules; amend `AGENTS.md` only with a
ruling you had to discover. **Do not touch hae files** — `.agentbox/` is read as an example and
modified by nothing.

## Effect wiring

- **Tags introduced**: `Sandbox`.
- **Tags consumed**: `AgentboxConfig`, `Reporter`, `Ledger`, `RunLock`, `Git`, plus `CommandExecutor`
  **directly, no wrappers**.
- **Not introduced**: `AgentCli`, `Forge`, `Notifier`, `PromptSource`, `Prompt`, `IssueStore`. Do not
  stub them.
- **Layer composition**: `Sandbox` joins the same single `AppLive` (05 Q21). Copy this, do not derive
  it:

  ```ts
  export const AppLive: Layer.Layer<
    Sandbox | Git | RunLock | Ledger | AgentboxConfig | Reporter | NodeContext.NodeContext,
    ConfigError
  > = Layer.provideMerge(
    Layer.mergeAll(SandboxLive, GitLive, RunLockLive),
    Layer.provideMerge(LedgerLive, Layer.provideMerge(AgentboxConfigLive, PlatformAndReporterLive)),
  );
  ```

  **`AppBaseLive` is byte-unchanged** — `status` and `doctor` gain no dependency on a docker daemon.
  The two compositions stay the same expression differing only in config layer, as `app.ts` notes.
- **Errors**: `SandboxError` is typed (SPEC §3). Cleanup is unaffected by the choice — `Scope`
  releases on typed failures and defects alike — so this decides reporting shape, not resource safety.

## Acceptance criteria

- [ ] The sandbox is acquired inside the same `Scope`, after the checkout, and released before it;
      ordering is asserted through the test `Reporter`'s event `Ref`
- [ ] The spec type has **no ports field**, and a `@ts-expect-error` shape pin turns into a hard error
      if one is added
- [ ] The spec type is expressed as image / mounts / env allowlist / limits / capabilities, and takes
      the branded `RepoUrl`, never a string
- [ ] Caps drop to none by default and any cap-add is config-declared; the env allowlist gains nothing
      this ticket does not need
- [ ] Every sandbox carries both ownership labels, applied through `src/ownership/labels.ts`; no query
      anywhere matches on container name and the grep ban stays green
- [ ] A sandbox start failure is a typed `SandboxError`, releases checkout and lock, and writes a
      `failed` row at stage `sandbox` (matrix row 6)
- [ ] A failing sandbox or lock finalizer is reported and swallowed, leaving the run's own error
      unmasked (matrix row 19)
- [ ] `npm run verify:live` exists, cannot run under `verify`, and cannot silently skip
- [ ] `AppLive` matches the composition above verbatim; `AppBaseLive` is byte-unchanged

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, grep bans, and fake-tier tests. `pre-commit` is not a
substitute and does not check this package.

**Host-only**, run by the user before landing — the task container has no docker socket, so the agent
must write these and must not claim they pass:

```
npm run verify:live
node src/bin.ts <spec> --branch <throwaway-branch>
```

Then `docker ps -a` with the ownership label filter, which must come back empty. Run it from the real
checkout rather than a worktree: `repoScope` hashes the repo-root path, so a worktree hashes to a
different scope (T2's comment).

## Comments

**2026-08-11 — closed.** PR #4472, merged. `npm run verify:live` passed on the host against a real
dockerd, so all three live cases are confirmed, not merely written; the capability-spelling risk the
final review flagged (`ALL` / `CHOWN` versus a daemon echoing `CAP_CHOWN`) did not materialise.

Two dispatches. The first timed out at 1200s with §§1–3 and 5 landed across three commits and §4
untouched — a wall-clock overrun, **not** an Effect error, so the ADR 0007 tripwire stays at 0. The
second ran §4 alone in 630s of a 1800s cap and reviewed three rounds, landing as
`capped-unreviewed-fix`: every round found something real, so none returned `APPROVED`. The
unreviewed commit is `104b1c1d72`, which adds `test/live-tier-tag.test.ts` — the fake-tier assertion
that the live tier's two gates exist, since both were enforced by construction and asserted nowhere.

The timeout produced the sizing data that re-sliced T7 into T7 + [T19](T19-signal-matrix.md) and
lifted §3a of T8 out into [T20](T20-atomic-lock-claim.md): work is ~10.5s per tool call, so a cap is
a tool-call budget, and this ticket wanted ~140 against the 114 that 1200s buys.
