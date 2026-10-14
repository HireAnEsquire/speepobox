# T96 — A seeded branch that does not exist is refused

Status: Done (PR #56. `noSuchBranch` is shared by `branchExists` and the picker's `seededBranchRefusal`.)
Type: AFK
Blocked by: none. T91 changed the same issues step and has landed.

<!--
From the P3 picker walk-through, 2026-09-23. `node src/bin.ts --dry-run --feature <folder>
--branch some-branch`, with no branch named `some-branch`, opened the picker at the issues step.
The step's `git.revParse` of `refs/heads/some-branch` then failed, and the picker ended on git's
raw line: `'refs/heads/some-branch' does not resolve: fatal: Needed a single revision`. A typed
dispatch refuses the same branch with `branchExists`'s sentence (`dispatch/guards.ts`). The
unseeded picker cannot reach this, because its branch step lists only local branches.
-->

## What to build

**A seed whose `--branch` names no local branch is refused before the first question, with the
sentence a typed dispatch uses: `branch '<b>' doesn't exist — create it first: git branch '<b>'
[<start>]`.**

### 1. One sentence, two callers

Move the sentence in `branchExists` into an exported function beside it in `dispatch/guards.ts`,
for example `noSuchBranch(branch)`. `branchExists` uses it. The picker imports it. Keep the words
exactly as they are.

### 2. The picker checks the seed against the world it already reads

`pickerArgv` reads `readBranchWorld` once, before the first question. Immediately after that
read, if the seed carries a branch and `world.branches` has no branch of that name, refuse with a
`GuardRefused` carrying the shared sentence. This needs no new git call: the world is the list
the branch step offers, so a branch missing from it is one the step could never offer.

Keep this rule in the picker's pure half, as a function of the seed and the world, beside the
other seed functions.

This ticket covers existence only. A seeded branch that is checked out elsewhere or protected
still reaches the dispatch's own guards, which refuse it after the picker with their own words.
The issues step does not depend on those two facts, so they do not crash it.

### 3. Tests

In `test/picker.test.ts`, under *flags seed the wizard (T86)*:

- A seed of `--feature <folder> --branch <absent>` asks nothing and refuses with the shared
  sentence.
- A seed of `--branch <absent>` alone refuses the same way. It would otherwise reach the summary
  and be refused by the dispatch. One answer for both is simpler than explaining why they differ.
- A seed naming a branch that does exist is unchanged: every existing T86 test passes.

## Effect wiring

- **Tags introduced or consumed**: none introduced.
- **Layer composition**: unchanged.

## Acceptance criteria

- [ ] `--feature f --branch absent` on a TTY: no prompt is asked, and the refusal is
      `branch 'absent' doesn't exist — create it first: git branch 'absent' [<start>]`.
- [ ] `--branch absent` alone on a TTY: the same refusal, with no prompt asked.
- [ ] `branchExists`'s refusal is word for word what it was.
- [ ] Every T81–T86 and T91 test passes unchanged.

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package.
