# T18 — The checkout resource, with a derived release

Status: Done
Type: AFK
Blocked by: T5

Sequence: [ticket 08](../08-in-hae-sequence.md), re-sliced 2026-08-10. Draws on the design in
[`superseded/scoped-shell.md`](superseded/scoped-shell.md), which is source material and not a live
ticket.

> **Split out of [T5](T5-git-checkout.md) on 2026-08-11.** T5 originally carried a prefactor, the
> `Git` tag, and this resource. The prefactor landed alone (`eaaeed34ce`, PR #4469); the pass then
> built most of this in nine minutes and lost every line of it to the 20-minute cap, because none of
> it reaches `npm run verify` until all of it is in. Numbered T18 rather than renumbering T6–T17,
> since the blocking edges are explicit and dependency order does not read off the number.

**Tracer: the checkout appears, the fetch-back runs, and the directory is gone afterwards.** Dispatch
against a real branch: a clone lands under the runtime root, the release attempts a fast-forward
fetch-back from it, and because there is nothing to fetch the fast-forward trivially succeeds and the
directory is deleted. Point the run at a `Git` that fails the fetch-back and the directory is
**kept, loudly**, with the run's own error unmasked.

## What to build

The second resource in T4's `Scope`, and the two `Git` operations it consumes.

### 1. `Git.clone` and the fetch-back

The operations T5 deliberately left unbuilt, landing here with the caller that needs them. Both take
`RepoUrl`, which T5 already branded — **no string-typed URL crosses into a checkout**. `push` is
still not built: it has no caller until T11.

### 2. The checkout resource

- acquire: `git clone --no-hardlinks --branch <branch>` from the repo root into the runtime root
- release: **derived, not flagged** (05 Q10)

**Derived means the release always attempts the FF fetch-back from the clone, and keep-vs-delete
falls out of whether the commits made it home.** This is the rule `run.sh:1176-1182` already
implements, minus the mutable state. At this ticket no commits exist, so the fetch-back is a real
fast-forward over zero commits and the checkout is deleted — the path is fully built here, and T11
only makes the commits real. There is no `keep` flag anywhere; if you find yourself adding one, the
release has stopped being derived.

**Finalizers never fail the scope** (SPEC §4, design rule 4). The checkout release logs loudly, keeps
the directory, and **swallows its own failure**: a failing Effect finalizer becomes a defect and would
mask the run's real error (matrix row 18).

Acquisition order is `RunLock` → checkout, and release reverses it. That ordering is asserted through
the test `Reporter` appending to a `Ref`, so it is a plain value assertion (05 §4).

### 3. What the ledger records

A clone failure is a typed `GitError` with the lock released and a `failed` row naming stage
`checkout` (matrix row 5) — `RunStage` already carries that token in `src/ledger/record.ts`; use the
type rather than inventing a string. A failed fetch-back at land is stage `land` (matrix row 13);
testable now with a failing fake `Git`, and exercised for real in T11.

## Not in scope

`Git.push`, `Sandbox`, the setup hook, the reconciler, and every agent-facing service. Do not stub
them. `--hard-reset` (which would make push `--force-with-lease`) is deferred past the move.

## Read first

T5's `Git` module and `RepoUrl`, `src/internal/exec.ts` — every subprocess goes through it and it is
the only file allowed to import `Command` — plus `src/app.ts`, `src/config/config.ts`,
`src/ledger/record.ts`, T4's `RunLock` and scope module, `AGENTS.md`, and SPEC §§2, 3, 4,
9, 11.

**Already on the branch — do not rewrite** T1–T5's modules; amend `AGENTS.md` only with a ruling you
had to discover. **Do not touch hae files.**

**Land the fake `Git` and the test scaffolding first, as their own commit.** A fake that satisfies
T5's tag, plus whatever event helper the ordering assertion needs, compiles and passes `npm run
verify` before the resource exists — and the resource, its wiring into `run.ts`, `app.ts`, and the
rewritten ordering assertions are one interlocking change that reaches the gate only when all of it
lands. That is the shape that cost the previous attempt nine minutes of finished work. Get something
green committed before you start it.

## Effect wiring

- **Tags introduced**: none — `Git` is T5's.
- **Tags consumed**: `Git`, `RunLock`, `Ledger`, `AgentboxConfig`, `Reporter`, plus `FileSystem` /
  `Path` **directly, no wrappers**.
- **Not introduced**: `Sandbox`, `AgentCli`, `Forge`, `Notifier`, `PromptSource`, `Prompt`,
  `IssueStore`. Do not stub them.
- **Layer composition**: unchanged from T5 — a new resource inside an existing scope adds no layer,
  and two new methods on an existing tag add none either. Copy, do not derive:

  ```ts
  export const AppLive: Layer.Layer<
    Git | RunLock | Ledger | AgentboxConfig | Reporter | NodeContext.NodeContext,
    ConfigError
  > = Layer.provideMerge(
    Layer.mergeAll(GitLive, RunLockLive),
    Layer.provideMerge(LedgerLive, Layer.provideMerge(AgentboxConfigLive, PlatformAndReporterLive)),
  );
  ```

  **`AppBaseLive` is byte-unchanged.**
- **Errors**: `GitError` is typed (SPEC §3). A nonzero exit from the chokepoint is a *result*, not a
  failure.

## Acceptance criteria

- [ ] The checkout is acquired inside the same `Scope` as the lock, after it, and released before it
- [ ] `clone --no-hardlinks` is what creates it, from the repo root, on the named branch, through a
      `RepoUrl` rather than a string
- [ ] The release **always** attempts the FF fetch-back and derives keep-vs-delete from the result;
      no keep/delete flag exists anywhere in the code
- [ ] A failed fetch-back keeps the directory, says so loudly, and does not fail the scope; the run's
      own error is unmasked (matrix rows 13, 18)
- [ ] A clone failure is a typed `GitError`, releases the lock, and writes a `failed` row at stage
      `checkout` (matrix row 5)
- [ ] Acquisition and release ordering is asserted through the test `Reporter`'s event `Ref`
- [ ] `AppLive` and `AppBaseLive` are byte-unchanged

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, grep bans, and tests. `pre-commit` is not a substitute
and does not check this package.

Plus, separately, the tracer under plain `node`:

```
node src/bin.ts <spec> --branch <throwaway-branch>
```

**Host-only**, run by the user before landing. `git` is present in the task container, but that is
not sufficient: T3's preflight probes the docker daemon and the image *before* any guard downstream
of it runs, and the task container has no docker socket, so every happy-path dispatch stops at
preflight there whatever else is installed. Run this from the repo root on a host with a working
daemon. Afterwards the checkout directory under the runtime root must be **absent** and the lock file
gone.
