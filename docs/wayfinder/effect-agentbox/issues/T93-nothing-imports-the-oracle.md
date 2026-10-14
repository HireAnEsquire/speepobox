# T93 — Nothing imports the oracle

Status: Done (PR #52. The matcher is keyed to the load keyword, not to comments, so a comment spelling an import of a `.agentbox/` path also trips it)
Type: AFK
Blocked by: none.

<!--
From T80's Status (PR #36): the criterion that nothing under `src/` imports `.agentbox/` holds only
because nobody has done it yet. `scripts/check-bans.ts` has no ban that keeps it true.
-->

## What to build

**`npm run lint` fails on any import in `src/` or `test/` whose specifier reaches into
`.agentbox/`.**

`.agentbox/` is hae's bash dispatcher and its prototypes, kept here as the **parity oracle**
(AGENTS.md, and the comment at the top of `image/Dockerfile`): something to compare against,
never something to build from. An import from it makes the package depend on code that is not
the package, and `verify` neither typechecks nor tests that code.

### 1. The ban

Add an eighth ban to `scripts/check-bans.ts`, and document it in the file's header list the way
the other seven are. It checks each import that `IMPORT_RE` already finds. A specifier with
`.agentbox` as one of its path segments trips the ban, whether written relatively
(`../.agentbox/x`) or from the root. Also match `export … from` and `import("…")`, since both
load a module as much as an `import` does. If `IMPORT_RE` does not already cover those forms,
add a separate matcher for this ban rather than widening the one the other bans rely on.

The ban covers imports only. A string that names a `.agentbox/` path as data (a setup-hook path
in a test fixture, such as `test/dispatch.test.ts`'s `.agentbox/setup.sh`) is a path the code
under test handles, not a dependency, and stays legal.

The ban's message names the oracle and says to port the logic rather than import it.

### 2. Proof

A throwaway file with a relative import from `.agentbox/` fails `npm run lint` with the new
message. Put the output of that check in the PR description. Remove the file before committing.

## Effect wiring

- **Tags introduced or consumed**: none. This is a lint rule.
- **Layer composition**: unchanged.

## Acceptance criteria

- [ ] An `import`, an `export … from`, or a dynamic `import()` of a `.agentbox/` path in `src/`
      or `test/` fails `npm run lint` with the new message.
- [ ] A `.agentbox/` path in a string literal that is not a module specifier passes.
- [ ] The header comment lists the ban as number 8.
- [ ] `npm run verify` is green on the tree as it is.

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package.
