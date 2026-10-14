# T3 — `dispatch` guards, preflight, and the resolved plan

Status: Done (reviewed 2026-08-10: round 3's 326cf4876a)
Type: AFK
Blocked by:

Sequence: [ticket 08](../08-in-hae-sequence.md), re-sliced 2026-08-10. First of the fifteen tickets
that replace 08's T3–T6 bullets; see that ticket's re-slice table. Predecessors: [T1](T1-skeleton.md),
[T2](T2-ledger-status.md).

**Tracer: `dispatch` refuses every bad input and holds nothing.** Run it against a protected branch,
a branch that does not exist, a spec path that does not resolve, and a base equal to the branch —
each exits nonzero with a typed `GuardRefused`, and afterwards there is no lock, no checkout, no
container, and no ledger row. Run it against valid input and it prints the fully resolved plan and
stops there.

## What to build

The front half of the dispatch command: argument parsing, every guard, preflight, and the derivation
that produces a resolved plan value. **Nothing is acquired.** The `Scope` and its three resources
arrive in T4–T6.

### 1. The command surface

`dispatch` takes positional `<spec>` plus `--branch <name>` (SPEC §7). This is its final surface, not
a placeholder: T4 onward fills in what happens after the guards pass, and nothing built here is
test-only scaffolding to delete later.

`@effect/cli` does the argument parsing — that is one of the two jobs it is retained for (SPEC §1).
**`status` and `doctor` stay intercepted before flag parsing**, exactly as `bin.ts` does today
(03 §1.1): they must work when the thing they inspect is broken, so they must not be reachable only
through a parser that can itself refuse. The dispatch surface is what goes through `@effect/cli`, and
it is the first consumer of `AppLive` rather than `AppBaseLive` — a malformed config kills a dispatch
at startup and degrades the read-only commands, and that difference is the point.

### 2. Guards

Every one is a typed `GuardRefused` with nothing held (matrix row 1), preserving the inventory's
invariant that nothing is touched before the in-flight-run check.

- `--branch` is required, and the branch must already exist
- `master` / `main` are refused
- the currently checked-out branch is refused
- a base equal to the branch is refused
- the spec path resolves and exists — a **bare name** becomes `<tasks-dir>/<name>.md`, and
  **anything with a slash is used as-is** (SPEC §7)

**No interactive prompting lands here.** `Prompt`/clack is a post-move surface (P3); matrix row 1's
"declined confirm" arrives with the flags that need it, and none of those are in this sequence.

### 3. The `--base` default chain

Ledger's last recorded base for this branch → `origin/master`. **This is the first consumer of
`lastBaseForBranch`, which T2 landed without one — wire it, do not re-derive it.** It returns the
*ref*, not a SHA, and the ref is what the chain wants; a SHA there would pin the next run to a stale
commit (`src/ledger/record.ts` says so on `BaseRef`). A ledger that cannot be read degrades this
chain to the fallback and never fails the run.

### 4. Preflight

**Docker daemon reachable** and **image present**, both typed (matrix row 2). `doctor` already probes
both in `src/doctor/probes.ts` against the same chokepoint — reuse those effects rather than writing
a second pair that can drift. If a probe has to be lifted or parameterized to be callable from two
places, do that as a prefactor first, in its own commit, before any dispatch code exists.

`gh` auth is **not** preflighted here; it arrives with `Forge` in T12, and nothing in this ticket
shells out to `gh`.

### 5. The resolved plan

Slug, container id, checkout path, and log path derivation are **plain functions, not a tag**
(SPEC §2). They produce one `Schema`-defined `DispatchPlan` value — spec, branch, base ref, resolved
base SHA, merge-base SHA, slug, container id, checkout path — emitted as a `Reporter` event with the
renderer as a subscriber, matching `doctor` and `status`. A `process.stdout.write` inside the command
typechecks and is wrong.

This value is what T15's `--dry-run` prints. Deriving it once, here, is what stops `--dry-run` from
becoming the second implementation that `run.sh:1647-1724` is (05 Q20).

## Not in scope

`--hard-reset`, `--feedback`, `--feedback-edit`, `--resume`, `--last`, the picker, `--feature` and
`IssueStore`, and `gc`. Do not stub `Sandbox`, `Git`, `RunLock`, `AgentCli`, `Forge`, `Notifier`,
`PromptSource`, or `Prompt`.

## Read first

`src/bin.ts`, `src/app.ts`, `src/config/config.ts`, `src/config/paths.ts`, `src/doctor/probes.ts`,
`src/ledger/ledger.ts`, `src/ledger/record.ts`, `AGENTS.md`, and SPEC §§3, 4, 7, 11.

**Already on the branch — do not rewrite**: T1's chokepoint, config module and `doctor`; T2's
`Ledger`, `status` and ownership-label module. `AGENTS.md` may be *amended* with a ruling you had to
discover (08 §2 invites that); it may not be rewritten. **Do not touch hae files.**

## Effect wiring

- **Tags introduced**: none.
- **Tags consumed**: `AgentboxConfig`, `Reporter`, `Ledger`.
- **Not introduced**: `Sandbox`, `Git`, `RunLock`, `AgentCli`, `Forge`, `Notifier`, `PromptSource`,
  `Prompt`, `IssueStore`. Do not stub them.
- **Layer composition**: unchanged. `dispatch` is the first subcommand to receive `AppLive` rather
  than `AppBaseLive`; both already exist in `src/app.ts` and both stay byte-identical. Copy, do not
  derive:

  ```ts
  export const AppLive: Layer.Layer<
    Ledger | AgentboxConfig | Reporter | NodeContext.NodeContext,
    ConfigError
  > = Layer.provideMerge(
    LedgerLive,
    Layer.provideMerge(AgentboxConfigLive, PlatformAndReporterLive),
  );
  ```

- **Errors follow the outcome-row test** (SPEC §3, `AGENTS.md`): `GuardRefused` and the preflight
  failures are typed, and both write **no ledger row** — the run never claimed the branch. That is
  matrix rows 1–2, and it is why the row rule waits for T4's lock.

## Acceptance criteria

- [ ] `dispatch <spec> --branch <name>` parses through `@effect/cli`; `status` and `doctor` are still
      intercepted before flag parsing and still run on `AppBaseLive`
- [ ] Each guard — branch missing, branch absent, protected branch, currently-checked-out branch,
      base equal to branch, unresolvable spec — fails as a typed `GuardRefused`
- [ ] Bare spec names resolve under the tasks dir; anything containing a slash is used as-is
- [ ] `--base` defaults through `lastBaseForBranch` before `origin/master`, and an unreadable ledger
      degrades to the fallback rather than failing
- [ ] Preflight reports docker-daemon and image failures as typed errors, reusing `doctor`'s probes
      rather than a second copy
- [ ] After any guard or preflight failure, no lock, checkout, container, or ledger row exists —
      asserted, not just intended (matrix rows 1–2)
- [ ] The resolved plan is a `Schema`-defined value emitted as a `Reporter` event; no command writes
      to stdout directly
- [ ] `AppLive` and `AppBaseLive` are byte-unchanged

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, grep bans, and tests. `pre-commit` is not a substitute
and does not check this package.

Plus, separately, the tracer — which `verify` cannot cover because `vitest` transforms:

```
node src/bin.ts <spec> --branch <existing-branch>
node src/bin.ts <spec> --branch master
```

The first prints the resolved plan; the second refuses. Both under plain `node`, which is also the
standing type-stripping check.
