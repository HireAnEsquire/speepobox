# T8 — The reconciler

Status: Done
Type: AFK
Blocked by: T21

Sequence: [ticket 08](../08-in-hae-sequence.md), re-sliced 2026-08-10. Runs in parallel with
[T7](T7-setup-hook.md). **Narrowed on 2026-08-11**: the atomic stale-lock claim it carried as §3a is
now [T20](T20-atomic-lock-claim.md), and the eviction race T20's review then found is
[T21](T21-serialize-lock-eviction.md). Both are prefactors this ticket sits on top of — correctness
fixes to shipped code that should not depend on a feature ticket finishing. T21 is blocked by T20, so
naming it here names the whole chain.

**Tracer: `kill -9` a dispatch, run another, and the wreckage is reclaimed and reported.** The
uncatchable path T7 documents leaves a container, a lock, and a checkout behind; the next dispatch's
preflight finds them, proves they are dead, reclaims them, and says what it did. A run that is still
alive is reported and **never touched**.

## What to build

The component the bash spine never had (05 Q11/Q14).

### 1. When it runs

On **every dispatch preflight**, generalizing bash's per-slug stale clear (`run.sh:1161-1162`) to all
slugs. It runs after T3's guards and before the `Scope` opens — it is preflight, not a resource.

### 2. What it may reclaim

It **auto-reclaims only the provably dead** and reports everything else via `Reporter`. Silently
deleting a possibly-live run is how you kill a colleague's dispatch.

*Provably dead* requires **all three**:

1. labels match this repo,
2. the lock's recorded PID is not alive,
3. the sandbox is not running.

Anything failing any of the three is reported, not reclaimed.

### 3. What it is made of

**The liveness predicate and the classification are pure functions with no tag** (SPEC §2). The
liveness predicate is **T4's** — the same one `RunLock` acquisition already uses. Do not write a
second one; if the shape needs adjusting to serve both, adjust the shared function.

These are the same pure functions `gc` reuses at P4. **`gc` itself is not built here**: 08 §4 defers
only its aggressive/interactive path, and the reconciler is the part that was never deferred.

### 3a. Reclaim through T20's claim and T21's eviction

Two primitives already exist for this and you call both rather than writing either again. T20's
**atomic claim** — unique temp file plus `link`, where `AlreadyExists` *is* the collision — decides
who creates a lock. T21's **eviction witness** decides who is allowed to remove a dead one. The
reconciler reclaims across **all** slugs on every preflight, so it races against any dispatch
acquiring at that moment without the narrowing "same dead owner" condition that kept both windows
small in a single dispatch's acquisition path. **Call the two primitives; write no third.**

One piece of wreckage is yours because those primitives leave it: a run killed between taking a
witness and removing the corpse leaves a witness file and no lock. Sweep it the way you sweep any
other orphan — the witness names the pid it was taken against, so the same liveness predicate settles
it, and a witness whose lock is gone and whose pid is dead is debris. A lock directory that
accumulates witnesses is one where eviction eventually wedges.

### 3b. One id-trimming asymmetry, handed forward from T6's review

T6's review round 1 found and deliberately did not fix it, because T6's own cases are scoped so
narrowly it cannot bite there. In `test/live/live.ts`, the live tier's two container queries parse
docker's output differently:

- `ownedContainers` maps `.trim()` over the rows, **then** filters the empties out
- `sweepOwned` filters on `id.trim() !== ""` but passes the **untrimmed** id to `docker rm -fv`

So `sweepOwned` tests one value and uses another. T6 is safe because every live case gets a throwaway
repo root, so its sweep can only ever reach one container it started a moment earlier — but you are
adding live case 4 to that same harness, and the reconciler you are building does exactly this kind
of label-filtered sweep in production, where the ids come from a daemon this process did not populate.

**Parse once.** Whatever reads container ids out of docker's stdout should be one function that both
queries call, trimming before it filters. If you touch `live.ts` to add case 4, close the asymmetry
while you are there; either way, do not reproduce it in the reconciler.

**Only the label filter's selectivity is live-tier.** Ownership queries go through T2's
`src/ownership/labels.ts` — creation and query read from one list so they agree by construction. The
grep ban on name-based ownership queries stays green; prefix sweeping of `agentbox-*` is retired
everywhere.

### 3c. A ledger row does not mean the run finished

Handed forward from [T19](T19-signal-matrix.md), which proved it against real signals. A run
interrupted mid-teardown writes its `Interrupted` row **before** it releases the lock, so it can be
killed with a row already on disk and all three resources still on the host. SPEC §11's rule is that
a row exists **iff `RunLock` was acquired** — full stop, not "and the run reached its end."

So the classification never consults the ledger. Liveness is the three conditions in §2 and nothing
else; a wreck with an `Interrupted` row is reclaimed on exactly the same evidence as one with no row
at all. Reading a row as "this run finished" would leave the interrupted case's container, lock, and
checkout on the host permanently — and that case is the *common* one, because it is what Ctrl-C at a
bad moment produces.

T19's own test made this mistake in comment form, restating §11 with the extra clause, and it
typechecked and stayed green. If you write the rule down here, write §11's version.

### 4. Live case 4

**Label filter selectivity** (SPEC §11): two real containers, one carrying our labels; the
reconciler's query matches exactly one, **in both directions**. Over-matching is the dangerous
direction and the exact bug that retired the name prefix. The reconciler's liveness *logic* stays
pure and fake-tier.

Add it to the `verify:live` script T6 introduced. **The task container has no docker socket** — write
it defensively and do not report it as passing.

### 5. What it writes

Nothing to the ledger. A reclaim is a `Reporter` event, and the run that triggered it writes its own
row on its own terms. Matrix row 17's second half — "the next preflight's reconciler reclaims and
reports" — is this ticket's, and it is the only place the hard-exit path gets closure.

## Not in scope

`gc`'s aggressive and interactive paths, `--hard-reset`, and every agent-facing service. Do not stub
them.

## Read first

T4's liveness predicate and `RunLock` — including T20's claim primitive and T21's eviction witness,
which you call rather than reimplement — plus T6's `Sandbox` and its live-tier harness,
`src/ownership/labels.ts`,
`src/status/status.ts` (an existing label-filtered docker query), `src/dispatch/preflight.ts`,
`src/reporter.ts`, `AGENTS.md`, and **SPEC §2 (lines 92–141), §4 (176–249), and §11
(470–606)** — those ranges, not the whole file.

In `test/dispatch.test.ts`, `describe("dispatch preflight")` is where the reconciler's cases join the
dead-daemon and missing-image ones. In `test/run-lock.test.ts`, `describe("the liveness predicate")`
is the pure function you share rather than duplicate.

**Already on the branch — do not rewrite** T1–T7's, T20's, or T21's modules; the liveness predicate may be
adjusted where it has to serve both callers, and that is the only edit to shipped code this ticket
licenses. Amend `AGENTS.md` only with a ruling you had to discover. **Do not touch hae files.**

## Effect wiring

- **Tags introduced**: none.
- **Tags consumed**: `Sandbox`, `RunLock`, `AgentboxConfig`, `Reporter`, plus `FileSystem` / `Path`
  **directly, no wrappers**.
- **Not introduced**: `AgentCli`, `Forge`, `Notifier`, `PromptSource`, `Prompt`, `IssueStore`. Do not
  stub them.
- **Layer composition**: unchanged from T9 — the reconciler is pure functions plus calls on existing
  tags, so it adds no layer. Copy, do not derive:

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

  <!-- Amended 2026-08-12: this ticket was written before T9 landed and pasted the T6-era
  composition, which omits `AgentCliLive`. Copying that verbatim would have removed `AgentCli`
  from `AppLive`. -->


  **`AppBaseLive` is byte-unchanged.**
- **Errors**: a reconcile that cannot query dockerd degrades and reports; it does not fail the
  dispatch it is preflighting unless the daemon check T3 already owns has failed.

## Checkpoint order

The classification and liveness logic are pure functions with no tag, so they and their tests reach
`npm run verify` before anything is wired into preflight. Land them first, then the preflight step
that calls them.

## Acceptance criteria

- [ ] The reconciler runs on every dispatch preflight, over all slugs, before the `Scope` opens
- [ ] It reclaims only when all three liveness conditions hold, and reports everything else via
      `Reporter` (matrix row 17's reclaim half)
- [ ] It shares T4's liveness predicate — one pure function, no second implementation
- [ ] It reclaims through T20's atomic claim and T21's eviction witness; no second implementation of
      either exists
- [ ] A witness left behind by a killed evictor is swept as debris, so eviction cannot wedge (§3a)
- [ ] Classification never reads the ledger: a wreck carrying an `Interrupted` row is reclaimed on
      the same three conditions as one carrying no row (§3c)
- [ ] Classification is a pure function with no tag, shaped so P4's `gc` can reuse it unchanged
- [ ] Every query filters on both ownership labels through `src/ownership/labels.ts`; the grep ban on
      name-based ownership stays green
- [ ] Container ids are parsed out of docker's stdout by one function that trims before it filters —
      no query tests a trimmed value and then uses the untrimmed one (§3b)
- [ ] A live run's resources are reported and left untouched, asserted directly
- [ ] Live case 4 exists under `verify:live` and asserts selectivity in **both** directions
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
npm run verify:live
```

Then the tracer: start a dispatch, `kill -9` it while the container is up, and run another dispatch.
The second must report and reclaim the first's container, lock, and checkout, and `docker ps -a`
filtered by our labels must come back empty afterwards.
