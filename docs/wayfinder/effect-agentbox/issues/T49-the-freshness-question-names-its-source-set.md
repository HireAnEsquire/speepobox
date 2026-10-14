# T49 — The freshness question names its source set

Status: Done (PR #9, two review rounds; the guard reads `git ls-files` without asserting its exit
code, so in a tree where git runs but `ls-files` errors it passes on an empty set — the
under-inclusion direction this ticket is built on, left as a one-line hardening for the pass that
takes 18's step 2, which has to touch the not-source list anyway)
Type: AFK
Blocked by: none — can start immediately, and it must land before anything else in
[18](../18-where-the-package-lives-and-what-it-is-called.md)'s sweep.

<!--
[Ticket 18](../18-where-the-package-lives-and-what-it-is-called.md)'s resolution, step 1 of four, and
the only one of the four that stands on its own merits. 18 found it while pricing the move and
recorded it as **a pre-existing defect, not a cost of rooting**:

> Ten tracked files inside the package are not the dispatcher's source.

`tasks/` is tracked and holds real specs, so today a one-off spec marks the dispatcher
`dirty` in every ledger row it writes (T43), and a spec landing on the base makes the dispatcher
`Stale` and refuses the dispatch outright (T44). Both are already live.

18 also corrected a claim T42's ticket made and `paths.ts` still carries — *"it stays correct on its
own if ticket 18 moves the package."* It does not, and the code says why at `config/paths.ts:32-37`:
rooted, `relative(repoRoot, packageRoot)` is `""` and the function returns `"."`, so the pathspec
becomes the whole repo and **every** dispatch refuses on any docs commit. 9 of the last 30 commits on
`main` touch no `speepobox/` file. That is why this must precede the `git mv` rather than ride along
with it.
-->

## What to build

**The freshness question scopes to a named set of source paths rather than to the package
directory** — stated once, in the pure module both callers already share.

The set, from 18's ruling:

```
src  prompts  package.json  package-lock.json  tsconfig.json  scripts
```

`prompts/` is in it because a prompt ships with the tool and is consumed by every pass — a changed
prompt is a changed dispatcher. `test/` is not; nothing in a dispatch runs it. Neither is
`tasks/`, which is the defect above. Neither is `config.toml`: config is the **served repo's**
declaration, not the tool's source, and under P6's shim the served repo's `config.toml` is not in the
dispatcher's clone at all.

### One asymmetry to leave alone

`scripts/` holds only `check-bans.ts`, which runs at `npm run lint` and never inside a dispatch — so
by the rule that excludes `test/` it would be out. It stays in, per 18, and the reason is the
direction of the failure: **over-inclusion fails loudly and under-inclusion fails silently.** A
source path that should not be in the set produces a refusal with a message the dispatcher reads; one
that should be in and is not runs a stale dispatcher and says nothing. Do not trim the set.

### Where it lands

`src/config/paths.ts`. `packagePathspec` becomes a function returning the set as pathspecs relative
to the repo root — each entry the package's location joined to one source name — so it renders
`speepobox/src` today and `src` once 18's rooting lands, with no arm for either case.

**The `"."`-versus-`""` arm goes with it**, along with the comment block that explains it: entries
are named, so none can be empty and git can never be handed an empty pathspec. That whole hazard
stops existing rather than being handled.

The comment above it asserting the function *"stays correct on its own if ticket 18 moves the
package"* is the claim 18 disproved. Replace it with what is true — the scope was never the package
directory, that was a coincidence of nesting.

### The two callers, and what each costs

- `src/git/dispatcher-freshness.ts:31-36` — `dispatcherFreshnessArgs` puts the set after `--`. Both
  its own call sites already spread its return (`doctor/probes.ts:409`, `git/git.ts:409`), so the
  array simply gets longer and neither changes.
- `src/git/dispatcher-revision.ts:56` — `git status --porcelain -- <pathspec>` passes one pathspec
  inline and becomes a spread.

Nothing else consumes it.

### Blast radius in test, and it is mechanical

Nine sites build an expected command string by calling the function rather than by hardcoding a
path, which is what makes this a signature change and not a rewrite: `dispatch.test.ts:702`,
`dispatcher-revision.test.ts:16`, `dispatcher-freshness.test.ts:21,244`, `doctor.test.ts:56`,
`dry-run.test.ts:886`, and `git.test.ts:330,343,357,378`. Each renders the set into the argv the
same way the code does.

`config.test.ts:376-382` is the exception — it pins the two rendering cases by hand, including
`expect(packagePathspec(packageRoot)).toBe(".")`. That case is the arm being deleted; what replaces
it is the rooted rendering, bare names with no prefix.

### The guard, which is the point of the ticket

18 named the failure mode: **a new top-level source directory silently drops out of scope.** That is
the unsafe direction, so it wants a test that fails when one appears — not a test that pins today's
list twice.

Assert that every tracked top-level entry of the package is either in the source set or in an
explicitly declared not-source list, so an entry in neither fails. Read the entries rather than
writing them out: `git ls-files` under the package root, first path segment, deduplicated —
`test/dispatcher-freshness.test.ts` already spawns real git in a scratch repo, so a test that shells
out to git is precedented here.

The not-source list today is `.gitignore`, `.oxfmtrc.json`, `.oxlintrc.json`, `AGENTS.md`,
`config.toml`, `ISSUE_TEMPLATE.md`, `tasks`, `test`, `vitest.config.ts`, and `vitest.live.config.ts`.
**It is a declaration, not a snapshot** — each entry is a claim that the file is not the dispatcher's
source, and the test's job is to make adding a new one a deliberate act.

This guard is also what makes 18's step 2 honest: rooted, the repo root's own neighbours (`docs/`,
`.agentbox/`, `image/`, `README.md`) become top-level entries, and the guard forces that ticket to
declare each one rather than let the scope widen unnoticed.

### Wording that stops being true

The scope is a set of paths, not a directory, so the operator-facing phrase *"the package directory"*
misdescribes it at three sites a dispatcher actually reads:

- `src/dispatch/preflight.ts:59` — T44's refusal message.
- `src/doctor/probes.ts:401,414,419` — probe ten's three rows.
- `src/dispatch/command.ts:109` — the override flag's help text.

Say "this dispatcher's source" instead. Comments elsewhere that use the phrase to explain the T42/T43
scope want the same correction where they assert it as a fact; a comment merely narrating history
does not.

### The record

Append one line to [T42](T42-doctor-asks-whether-the-dispatcher-is-stale.md) noting that its
*"stays correct on its own if 18 moves the package"* claim was disproved by 18 and corrected here.
The ticket is closed; the correction belongs beside the claim, not only in this file.

## Effect wiring

- **Tags introduced or consumed**: none. `dispatcher-freshness.ts` and `paths.ts` are plain modules
  with no `Git` import, deliberately (`dispatcher-freshness.ts:1-13`), and stay that way.
- **Layer composition**: unchanged. `Git`'s `dispatcherFreshness` operation and `probes.ts`'s
  subprocess call are both untouched — only the argv they already spread grows.

## Acceptance criteria

- [ ] A commit that touches only `tasks/` leaves the dispatcher `Current` and its ledger
      row clean — the defect this ticket exists for, asserted against real git.
- [ ] A commit under each of the six source paths still makes the dispatcher `Stale` against a base
      that has it.
- [ ] An uncommitted edit under `test/` does not mark a row dirty; one under `src/` still does.
- [ ] A tracked top-level entry that is in neither the source set nor the declared not-source list
      fails the suite.
- [ ] The scope is stated in exactly one place, and both callers read it from there.
- [ ] No pathspec the code can produce is an empty string, and nothing branches on whether the
      package sits at the repo root.
- [ ] The refusal a dispatcher sees describes the dispatcher's source rather than a directory.
- [ ] The suite passes.

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package. `lint` is what runs `check-bans.ts`.
