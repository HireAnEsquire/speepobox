# T42 — `doctor` asks whether the dispatcher is stale

Status: Done
Type: AFK
Blocked by: None — can start immediately.

<!--
First of three from the 2026-09-08 re-slice of T41, whose dispatch timed out at 900s having committed
nothing. Full design and the evidence behind the rule:
docs/wayfinder/effect-agentbox/issues/superseded/dispatcher-freshness.md. Read it for the *why*; this
ticket is self-sufficient for the *what*.

This slice is the one that goes green on its own with a real consumer. It builds the question and one
caller that only reports. T44 adds the caller that refuses.
-->

## What to build

`doctor` gains a tenth probe: **is this dispatcher missing commits its configured base already has?**

The question is about the dispatcher's own source, so it is scoped to the **package directory** —
this repo also holds `docs/`, and a whole-repo check would go amber every time a doc commit landed
on the base. Scope is derived, not configured: it is a fact about where the dispatcher's source
sits, the package already knows it, and it stays correct on its own if
[18](../18-where-the-package-lives-and-what-it-is-called.md) moves the package.

**Correction:** the claim in the paragraph above — that the scope stays correct on its own once 18
moves the package — was disproved by 18 and fixed by
[T49](T49-the-freshness-question-names-its-source-set.md). The scope was never really "the package
directory"; that was a coincidence of nesting. It is a named source set stated once in
`src/config/paths.ts`, and rooting the package (18) would otherwise have widened it to the whole repo.

### The question lives in a pure module, because it has two callers that cannot share a tag

T44 asks the identical question in `dispatch/preflight.ts`, through the `Git` tag. This probe
**cannot** use that tag: `probes.ts` states the rule at the top of the file — probes call the
subprocess chokepoint directly, because doctor must work when the thing it inspects is broken — and
`gitProbe` is the worked example, shelling out through `exec("git", "-C", repoRoot, …)`.

So the shared part is not an operation, it is the **question**: which path to scope to, what argv
asks it, and how to read the answer. Put that in a pure module under `src/git/`, the way
`repo-url.ts` already is — a module `probes.ts` imports directly and deliberately, without gaining a
git dependency. `resolveTasksDir` names the reason this is one definition and not two:

> One definition because two callers need the same answer … and a bare name resolving somewhere
> doctor never looked is exactly the drift a second copy buys.

A doctor that answered a slightly different question than the preflight is that drift with a worse
consequence, because the operator would have run doctor precisely to find out.

The module owns three things and touches no service:

- **The scope.** The package directory as a pathspec relative to the repo root, derived from
  `packageRoot`. This belongs in `src/config/paths.ts` beside `resolveTasksDir` and
  `resolveSetupHookPath` — same shape, same anchoring, same file.
- **The argv.** The commits a range holds under a path, listed rather than counted. `countCommits`
  cannot serve: it renders `rev-list --count <from>..<to>` with no pathspec and answers with a
  number, where both callers need the SHA to name.
- **The verdict.** Reading that output into the three answers a caller can act on: current, stale
  with these commits missing, or the base could not be resolved.

### Probe ten warns; it does not fail

A `warn`, never a `fail`. `doctor` reports and the preflight refuses (T44) — different jobs, and a
`fail` here would take doctor red for a dev sitting on a feature branch that is merely behind, which
is the ordinary state of a repo mid-stack. Exit stays 0 on warnings, as it already does.

The unresolvable base is also a `warn`, naming `git fetch`, for the same division: an unfetched
clone is the operator's to fix and not a broken toolchain. **The probe issues no fetch and no other
network call** — it resolves the base as this clone already has it. `--base` in this package names a
remote-tracking ref (`guards.ts`), so reading `origin/main` here is still a local read.

`bin.ts`'s usage string says `doctor  read-only preflight: nine probes` and moves to ten with it.

## Effect wiring

- **Tags introduced or consumed**: none introduced. The probe consumes `CommandExecutor` only, like
  every probe beside it. **No `Git`** — see above; that tag arrives in T44 for the other caller.
- **Layer composition**: unchanged. `doctor`'s signature keeps its
  `Effect.Effect<number, never, Reporter | CommandExecutor | FileSystem.FileSystem | Path.Path>`, and
  the new probe follows `gitProbe`'s shape exactly: a `(repoRoot, base) => Effect<ReadonlyArray<ProbeRow>, …, CommandExecutor>`
  wired through the existing `check(…)` helper. The base comes off the already-decoded config, which
  `doctor` reads once up front and degrades to `defaultConfig` on failure — so a config that decodes
  to an empty `base` is a row this probe writes, not a crash.

## Acceptance criteria

- [ ] `doctor` prints a tenth row reporting whether the dispatcher's package directory is missing
      commits its configured base already has.
- [ ] A dispatcher whose package directory is current with its base reports `ok`.
- [ ] A dispatcher missing a package commit the base has reports `warn`, names at least one missing
      commit, and `doctor` still exits 0.
- [ ] A base holding commits that touch nothing under the package directory reports `ok`.
- [ ] Uncommitted edits under the package directory do not change the row on their own.
- [ ] A base ref this clone cannot resolve reports `warn` naming `git fetch`, not `fail`.
- [ ] The probe issues no fetch and no other network call.
- [ ] `bin.ts`'s usage string names the same number of probes `doctor` prints.
- [ ] The scope and the verdict are one definition, imported by the probe rather than restated in
      it, so T44's second caller can ask the identical question.

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package.

All of it is testable against a fake `CommandExecutor` and a temp repo — the ancestry cases are
fixtures, not host facts. Cover the offline criterion the way it will actually regress: **assert the
rendered argv**, so a `fetch` added later fails the test rather than merely slowing doctor down.
