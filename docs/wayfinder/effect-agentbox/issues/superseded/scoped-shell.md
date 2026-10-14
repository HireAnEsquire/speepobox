# Superseded — Scoped shell: `RunLock` → checkout → `Sandbox`

Status: wontfix
Type: AFK
Blocked by: T2

> **Superseded 2026-08-10 — source material, not a live ticket.** This was the third of six tracer
> bullets from [ticket 08](../../08-in-hae-sequence.md). It was oversized — four services in one
> ticket — and its dispatch failed. It is replaced by the tickets from the single re-slicing pass
> over T3–T6 that [08's amended "Issue files" section](../../08-in-hae-sequence.md) calls for.
>
> **Read the design below; do not amend it and do not build from it directly.** The decomposition is
> what went wrong, not the analysis: the `RunLock`/checkout/`Sandbox` behaviour, the matrix rows, and
> the SIGHUP tracer are all still correct, and the re-slice draws on them.
>
> It lives here rather than beside the live tickets because `tasklib.py` takes an issue's number from
> its filename and keys issues by that number, so a new `T3-*.md` would collide with this file and
> silently win or lose on filename sort. A subdirectory is invisible to `load_issues`, which globs
> `*.md` non-recursively. The title no longer starts with `T3` for the same reason — the number falls
> back to the title when the filename has none. `Status: wontfix` is belt-and-braces: only `done`
> stops selection, so location is what actually takes this out of the dispatcher's reach.

**Tracer: all three resources released on Ctrl-C, on SIGHUP, and on success.** This is Claim 1's
evidence, and it is provable with no agent involvement at all — the leak `run.sh:1024-1027`
documents (macOS bash 3.2 not firing EXIT traps for a backgrounded function's subshell) becomes
structurally impossible rather than trapped. SIGHUP is **new behaviour**: bash leaks a container
silently when a terminal tab closes.

## What to build

The dispatch shell from guards through to a fully-acquired `Scope`, and back out again. **Not** the
agent loop, land, PR, or notify — 08 §1 split T3 from T4 along the boundary already in the design:
**T3 ends where the `Scope` is fully acquired.**

`dispatch` becomes a real command at T3, in its final surface (`<spec> --branch <name>`, SPEC §7),
and does its real work up to the point where an agent would run. It then tears down and exits.
T4 fills in the middle; it does not replace the entrypoint, and nothing built here is test-only
scaffolding to delete later.

### 1. Guards and preflight — before anything is held

Every guard is a typed failure with nothing acquired (matrix rows 1–2), preserving the inventory's
invariant that nothing is touched before the in-flight-run check. **No interactive prompting lands
at T3**: `Prompt`/clack stays out of the highest-risk bullet, and matrix row 1's "declined confirm"
arrives with the flags that need it (`--hard-reset`, P4; picker, P3).

Guards: `--branch` required and must already exist; `master`/`main` refused; the currently
checked-out branch refused; base equal to branch refused; the spec path resolves and exists (bare
name → `<tasks-dir>/<name>.md`, **anything with a slash used as-is**). All raise `GuardRefused`.

**`--base` default chain**: ledger's last recorded base for this branch → `origin/master`. This is
the first consumer of the query T2 landed without one — wire it, do not re-derive it.

Preflight covers **docker daemon reachable** and **image present**, typed. `gh` auth arrives with
`Forge` at T4; nothing here shells out to `gh`.

### 2. The reconciler

Runs on **every dispatch preflight** (05 Q11/Q14), generalizing bash's per-slug stale clear
(`run.sh:1161-1162`) to all slugs. It **auto-reclaims only the provably dead** and reports
everything else via `Reporter` — silently deleting a possibly-live run is how you kill a colleague's
dispatch.

*Provably dead* requires **all three**: labels match this repo, the lock's recorded PID is not
alive, and the sandbox is not running.

The liveness predicate and the classification are **pure functions with no tag** (SPEC §2) — the
same functions `gc` reuses at P4. Only the label filter's selectivity is live-tier. `gc` itself is
not built here; 08 §4 defers only its aggressive/interactive path, and the reconciler is what was
never deferred.

### 3. The `Scope`

One `Scope`, opened after every guard passes (SPEC §4). Release reverses acquisition automatically.

| Resource | Acquire | Release |
| --- | --- | --- |
| `RunLock` | write PID file | remove |
| checkout | `clone --no-hardlinks` | **derived** (below) |
| `Sandbox` | `docker run` + labels | `docker rm -f` |

**`RunLock` is a PID file, not a `Semaphore`** (05 Q17) — the real contention is two invocations in
two terminals, which a `Semaphore` cannot see. It lives under the runtime root (still the package's
own root during incubation, 05 Q19). Stale-lock reclamation is part of **acquisition**, using the
same liveness predicate as the reconciler.

**Checkout release is derived, not flagged** (05 Q10). The release always attempts the FF fetch-back
from the clone; keep-vs-delete falls out of whether the commits made it home. At T3 no commits exist,
so the fetch-back is a real fast-forward over zero commits and the checkout is deleted — the path is
fully built here, and T4 only makes the commits real. The failure direction (fetch-back fails →
**checkout kept, loudly**) is testable now with a failing fake `Git`.

**Finalizers never fail the scope** (SPEC §4, design rule 4). The checkout release logs loudly, keeps
the directory, and swallows its own failure; a failing Effect finalizer becomes a defect and would
mask the run's real error.

Slug, cid, and checkout-path derivation are **plain functions**, not a tag.

### 4. `Sandbox`

`Sandbox` is **scoped in the interface**, not at the call site (SPEC §2) — `run(spec)` / `exec` /
`remove`. Named for its role: the Docker implementation is `Sandbox.dockerLayer`, and no provider
abstraction is built (05 Q22).

The spec type is expressed in our vocabulary — **image reference, mounts, env allowlist, resource
limits, capabilities** — never as a `docker run` flag bag. Two invariants are **unrepresentable
rather than checked** (SPEC §9):

1. **No published ports** — the spec type has *no ports field at all*. Not a flag to misuse, not an
   escape hatch.
2. **No userinfo on any URL crossing into the sandbox** — `RepoUrl` is a branded parse whose
   constructor strips or refuses userinfo, and no string-typed URL crosses the boundary.

Both get `@ts-expect-error` **shape pins** (design rule 2): each asserts something stays impossible,
so a future edit adding a `ports` field must delete a test that names the invariant. `RepoUrl`'s
userinfo rejection is an ordinary Schema-decode test, not a pin.

**Ownership is declared, never inferred.** Every sandbox carries `agentbox.managed=true` +
`agentbox.repo=<hash of repo root>`. **Use the ownership-label module T2 introduced** — do not
re-derive the hash or the filter arguments. The two agreeing by construction is why that module
exists. A unit test asserts the renderer always attaches both labels (design rule 3).

Caps drop to none by default; any cap-add is config-declared, following bash's rule of adding back
only what the setup hook's root path demonstrably needs (`run.sh:1260`). The **env allowlist grows
one variable at a time, each with a note naming which child reads it** — T3 adds none it does not
need, and the agent credential arrives with `AgentCli` at T4.

### 5. The setup hook

**Generic and config-declared**, not hae-specific: config names a host script, it is mounted
read-only into the container, and it runs via `Sandbox.exec`. hae's own `.agentbox/setup-db.sh` is
an example to read, never a thing to port or modify — it becomes data at P7, and templates are P5.

Its failure is `SandboxError` with the sandbox, checkout, and lock all released (matrix row 7).

### 6. The ledger row

**A run writes exactly one terminal row iff `RunLock` was acquired** (SPEC §11). T2 landed `Ledger`
noting this corollary was not yet exercised; T3 is where it becomes true. Guard and preflight
refusals never started, so they write nothing.

T3's happy path has no land outcome to record, so its terminal reason names **the furthest stage
reached** — the scope completed with no agent work. That is honest, and T4 replaces it with real
land outcomes. Deferring the row to T4 instead would leave the invariant unexercised for the whole
bullet that introduces the lock it depends on.

The per-run **log file is a `Reporter` subscriber opened as a plain effect, not a resource** — logs
are never deleted, and log rotation is likewise a plain effect (SPEC §4).

### 7. Signals

| Path | Behaviour |
| --- | --- |
| Ctrl-C once | full teardown |
| SIGHUP (terminal/tab closed) | full teardown — **new**; bash leaks a container silently |
| Ctrl-C twice | hard exit; the next preflight's reconciler reclaims and reports |
| `kill -9` / power loss | uncatchable; reconciler reclaims |

`NodeRuntime.runMain` stays the only entrypoint idiom, and `Effect.runPromise` stays grep-banned.
Effect issue #5592 (detached-child cleanup) is sidestepped by **never spawning detached children** —
sandboxes are dockerd-owned, so teardown is an explicit `docker rm -f` finalizer.

## Tests

### Fake tier — `npm run verify`

The failure-point matrix (SPEC §11) **is the oracle**; it was authored once so six AFK bullets
cannot each invent contradictory-but-green answers. Each row is one `it.effect`. Do not re-derive
these outcomes — read them off the table.

- **T3 owns rows 1–7, 13, 16–20, 22.**
- **Rows 8–12, 14, 15, 21 wait for T4** — they need `AgentCli` or `Forge`. Do not stub either.

Row **22** (a defect anywhere in-scope: all released in reverse order, `crashed` row, defect
rethrown) is the Claim-1 case available at T3; row 11's review-pass variant is T4's.

Ordering assertions — "lock before checkout before sandbox, released in reverse" — run through the
test `Reporter` appending to a `Ref`, so they are plain value assertions (05 §4).

### Live tier — `npm run verify:live` (new here)

Host-only, tagged, against a real dockerd. **Deliberately not `it.skipIf(noDocker)` inside
`verify`**: skipped-is-green in exactly the environment that writes all the code is the false-green
shape ticket 04 already ate once. Wire the tag so live cases can never run under `verify` and can
never silently skip.

All five of SPEC §11's live cases land here — they are all `Sandbox` or reconciler:

1. **Leak under defect** — real `dockerLayer`, fake everything else, defect mid-scope, then
   `docker ps -a` filtered by our labels returns empty. "Our fake released" is not "dockerd has no
   container".
2. **The spec type renders to a `docker run` dockerd accepts** — caps, mounts, limits.
3. **No published ports, live** — one `docker port` assertion proves the renderer honors the shape.
4. **Label filter selectivity** — two real containers, one ours-labelled; the query matches exactly
   one, **in both directions**. Over-matching is the dangerous direction and the exact bug that
   retired the name prefix.
5. **The signal matrix** — Ctrl-C once, Ctrl-C twice, SIGHUP, `kill -9`, real processes, real
   signals, each asserting no leaked container, lock, or checkout.

**The hold point for case 5 is the setup hook**: it is already config-declared, so the live config
points it at a long-running script and the harness signals the child while all three resources are
held. No test-only flag on `dispatch`.

**Known and accepted**: the task container has no docker socket and `--cap-drop ALL`, so the agent
writing these tests cannot run them. Write them defensively and do not report them as passing — the
user runs `verify:live` on the host before landing, and breakage comes back as feedback.

## Already on the branch — do not rewrite

- **T1's chokepoint, config module, and `doctor`**; **T2's `Ledger`, `status`, and ownership-label
  module.** Consume them. The label module in particular exists so T3 and `status` agree by
  construction rather than by review.
- **`AGENTS.md`** — hand-authored. Amending it with a ruling you had to discover is in
  scope (08 §2 expects exactly that); rewriting it is not.
- **Do not touch hae files.** `.agentbox/` is read as an example by this bullet and modified by
  nothing.

## Effect wiring

- **Tags introduced**: `RunLock`, `Git`, `Sandbox`.
- **Tags consumed**: `AgentboxConfig`, `Reporter`, `Ledger`, plus `FileSystem` / `Path` / `Clock` /
  `CommandExecutor` **directly, no wrappers**.
- **Not introduced**: `AgentCli`, `Forge`, `Notifier`, `PromptSource`, `Prompt`, `IssueStore`. Do
  not stub them.
- **Layer composition**: the three new tags join the same single `AppLive` composed at the
  entrypoint (05 Q21) — not a per-command layer. Layer wiring is the top failure mode for
  agent-written Effect (06), so **copy this, don't derive it**:

  ```ts
  export const AppLive: Layer.Layer<
    Sandbox | Git | RunLock | Ledger | AgentboxConfig | Reporter | NodeContext.NodeContext,
    ConfigError
  > = Layer.provideMerge(
    Layer.mergeAll(SandboxLive, GitLive, RunLockLive),
    Layer.provideMerge(LedgerLive, Layer.provideMerge(AgentboxConfigLive, PlatformAndReporterLive)),
  );
  ```

  `AppBaseLive` is **unchanged** — `status` and `doctor` gain no dependency on a lock, a git binary,
  or a docker daemon. The two compositions stay the same expression differing only in config layer,
  as `app.ts` already notes.
- **Agent passes run once.** A failed pass ends the run (05 Q16R) — there is no retry anywhere in
  the port, so none arrives with `AgentCli` later either.
- **Errors follow the outcome-row test.** `SandboxError`, `GitError`, `LockHeld`, `GuardRefused`,
  `LedgerError` are typed; impossible states are defects. Cleanup is unaffected either way — `Scope`
  releases on both — so this decides reporting shape, not resource safety.

## Acceptance criteria

- [ ] `dispatch` runs guards → reconciler → lock → checkout → sandbox → setup hook → teardown, with
      no agent work, and exits 0
- [ ] Every guard failure holds nothing; no lock, checkout, container, or ledger row exists after one
- [ ] `--base` defaults through the ledger's last-recorded-base query before falling back to
      `origin/master`
- [ ] The reconciler runs on every dispatch preflight, reclaims only when all three liveness
      conditions hold, and reports everything else via `Reporter`
- [ ] Stale-lock reclamation happens **inside** `RunLock` acquisition, sharing one liveness predicate
      with the reconciler
- [ ] Checkout release attempts the FF fetch-back and derives keep-vs-delete from the result; a
      failed fetch-back keeps the directory loudly
- [ ] Finalizer failures are logged and swallowed; the run's own error is never masked
- [ ] The sandbox spec type has **no ports field**, and a `@ts-expect-error` pin fails if one is
      added; `RepoUrl` strips or refuses userinfo
- [ ] Every sandbox carries both ownership labels, applied through T2's module; no query anywhere
      matches on container name (the grep ban stays green)
- [ ] Exactly one terminal ledger row is written iff `RunLock` was acquired
- [ ] `AppLive` matches the composition above verbatim; `AppBaseLive` is byte-unchanged
- [ ] Matrix rows 1–7, 13, 16–20, 22 each have a test; rows needing `AgentCli`/`Forge` are absent,
      not stubbed
- [ ] `npm run verify:live` exists, cannot run under `verify`, and cannot silently skip
- [ ] **All three resources released on Ctrl-C, on SIGHUP, and on success** — the tracer, proved live

## Verify

```
npm run verify
```

Run from the repo root. The gate — typecheck (Effect diagnostics: **errors and warnings break the
build**, suggestions print), lint, grep bans, fake-tier suite. `pre-commit` is not a substitute and
does not check this package.

Then, by hand on the host, because `verify` cannot cover them:

```
npm run verify:live
node src/bin.ts <spec> --branch <throwaway-branch>
```

The second is both the tracer and the standing type-stripping check — vitest transforms source and
plain `node` does not, so a green suite says nothing about whether the distribution model still
works.

Finally the three tracer paths by hand, each followed by a labelled `docker ps -a`, a runtime-root
lock check, and a checkout-directory check, all of which must come back empty:

1. let it run to completion,
2. Ctrl-C once mid-setup-hook,
3. close the terminal (SIGHUP) mid-setup-hook.
