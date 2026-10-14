# T5 — `Git`, `RepoUrl`, and the worktree-aware branch guard

Status: Done
Type: AFK
Blocked by: T4

Sequence: [ticket 08](../08-in-hae-sequence.md), re-sliced 2026-08-10. Draws on the design in
[`superseded/scoped-shell.md`](superseded/scoped-shell.md), which is source material and not a live
ticket.

> **Re-sliced 2026-08-11, after this ticket timed out.** It originally carried a prefactor, the `Git`
> tag, *and* the checkout resource. The prefactor landed on its own
> (`eaaeed34ce`, PR #4469) and the pass then spent nine minutes building the rest and lost all of it
> to the 20-minute cap, because none of it could pass `npm run verify` until every file was in. The
> checkout resource now lives in [T18](T18-checkout-resource.md), which this ticket blocks. What is
> left here is the half with consumers that already exist, so it reaches the gate on its own.

**Tracer: a branch checked out in *another* worktree is refused by the guard, not by preflight.**
`git worktree add ../wt-demo -b demo-target`, then dispatch against `demo-target`: today the guard
waves it through and the run dies later at the docker probe. After this ticket it refuses up front,
with the branch and the worktree path named, before anything is touched.

## What to build

The `Git` tag and the two things that already have callers for it. **The checkout resource is not
here** — it is T18's, and building it is what made this ticket fail once already.

### 1. `RepoUrl`

**A branded parse whose constructor strips or refuses userinfo** (SPEC §9, invariant 2), so that **no
string-typed URL can cross into a checkout or a sandbox** once T18 and T6 exist. Its rejection is an
ordinary `Schema`-decode test, not a shape pin.

`doctor`'s existing probe already asks this question through a private `urlEmbedsUserinfo` in
`src/doctor/probes.ts`. Point it at `RepoUrl`'s predicate so the rule is decided in one place — a
**pure import, not a new tag**, so `doctor` still depends on no git binary.

Invariant 3's hardened `upload-pack` is upstream git behavior inherited by using the same
fetch-from-clone path — do not "reimplement" it.

### 2. `Git`

Domain-shaped over branded types (SPEC §2), not a `git` flag bag. **Build only the operations this
ticket consumes**: `revParse`, and the worktree query §3 needs. `clone` and the fetch-back are T18's,
`push` is T11's — a method with no consumer is a layer, not a tracer bullet, and that rule is what
keeps this ticket the size it now is.

A nonzero exit from the chokepoint is a *result*, not a failure — `exec` hands back the code and both
streams, and `Git` decides which codes are `GitError` (`src/internal/exec.ts` states this).

### 3. The worktree hole in `branchNotCheckedOut`

**Handed forward from T3's review**, recorded there as deliberately not-fixed, and this is the ticket
that owns it. `branchNotCheckedOut` asks `git symbolic-ref HEAD`, which sees only the *current*
worktree. git also refuses a fetch into a branch checked out in **another** worktree, and that case
currently sails past the guard and stops at preflight instead.

bash has the identical hole (`run.sh:983-985`), so closing it is a deliberate improvement over
parity, not a drift fix. Make it here, where `Git` owns the question, and **note it in SPEC §12 as an
intentional divergence** — that entry is part of this ticket, not a follow-up.

This is the guard that gives `Git` its first consumer, which is why the two ship together.

## Not in scope

The checkout resource and its derived release (T18), `Git.clone`, the fetch-back, `Git.push`,
`Sandbox`, the setup hook, and every agent-facing service. Do not stub them. `--hard-reset` is
deferred past the move.

## Read first

`src/internal/exec.ts` — every subprocess goes through it and it is the only file allowed to import
`Command` — plus `src/dispatch/guards.ts`, `src/doctor/probes.ts`, `src/app.ts`,
`src/config/config.ts`, T4's `RunLock` and scope module, `AGENTS.md`, and SPEC §§2, 3, 9,
12.

**Already on the branch — do not rewrite** T1's, T2's, T3's, and T4's modules; amend `AGENTS.md` only
with a ruling you had to discover. **Do not touch hae files.**

**The prefactor this ticket used to carry is already landed** — `eaaeed34ce` anchored relative spec
paths and a relative `tasks-dir` to the repo root, and corrected `doctor`'s probe 8 along with it. Do
not redo it. Read it (`git show eaaeed34ce`) before touching `paths.ts` or the guards.

**Land `RepoUrl` first, as its own commit.** It is a pure module with its own decode tests and no
dependency on the `Git` tag, so it reaches `npm run verify` alone. The tag and the guard interlock
with each other; `RepoUrl` does not. The previous attempt at this ticket lost nine minutes of
finished work for want of exactly this.

## Effect wiring

- **Tags introduced**: `Git`.
- **Tags consumed**: `AgentboxConfig`, `Reporter`, plus `CommandExecutor` **directly, no wrappers**.
- **Not introduced**: `Sandbox`, `AgentCli`, `Forge`, `Notifier`, `PromptSource`, `Prompt`,
  `IssueStore`. Do not stub them.
- **Layer composition**: `Git` joins the same single `AppLive` (05 Q21). `GitLive` and `RunLockLive`
  are independent of each other, so they merge at the same level. Copy this, do not derive it:

  ```ts
  export const AppLive: Layer.Layer<
    Git | RunLock | Ledger | AgentboxConfig | Reporter | NodeContext.NodeContext,
    ConfigError
  > = Layer.provideMerge(
    Layer.mergeAll(GitLive, RunLockLive),
    Layer.provideMerge(LedgerLive, Layer.provideMerge(AgentboxConfigLive, PlatformAndReporterLive)),
  );
  ```

  **`AppBaseLive` is byte-unchanged** — `status` and `doctor` gain no dependency on a git binary, and
  sharing `RepoUrl`'s predicate with probe 9 must not change that.
- **Errors**: `GitError` is typed (SPEC §3).

## Acceptance criteria

- [ ] `RepoUrl` is a branded parse that strips or refuses userinfo, with decode tests, and it is the
      only place that rule is written
- [ ] `doctor`'s userinfo probe asks `RepoUrl`'s predicate rather than its own copy, without gaining
      a tag or a git dependency
- [ ] `Git` exposes only `revParse` and the worktree query — no `clone`, no fetch-back, no `push`
- [ ] `branchNotCheckedOut` refuses a branch checked out in **another** worktree, naming the branch
      and that worktree's path, before preflight runs
- [ ] The divergence from bash is recorded in SPEC §12 as intentional
- [ ] `AppLive` matches the composition above verbatim; `AppBaseLive` is byte-unchanged

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, grep bans, and tests. `pre-commit` is not a substitute
and does not check this package.

**Host-only**, run by the user before landing — the tracer needs a second worktree, and the guard it
exercises sits upstream of the docker preflight that always fails in the task container:

```
git worktree add ../wt-demo -b demo-target
node src/bin.ts <spec> --branch demo-target
git worktree remove ../wt-demo && git branch -D demo-target
```

Expect the refusal to name `demo-target` and the worktree path, and to arrive **before** any docker
probe runs.
