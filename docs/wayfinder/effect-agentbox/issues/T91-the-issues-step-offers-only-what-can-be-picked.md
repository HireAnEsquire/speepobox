# T91 — The issues step offers only what can be picked

Status: Done (PR #54)
Type: AFK
Blocked by: [T86](T86-flags-seed-the-wizard.md). Both change `picker/picker.ts`, so they run one at a
time.

<!--
P3 cleanup. Three leftovers from P3's review notes: T83's Status (the `Choose…` dead end, and the
source step asking *Which spec?* over feature, task, and resume rows), and a comment line in
`bin.ts` at 101 columns, recorded when PR #49 was reviewed.
-->

## What to build

**A feature folder with nothing that can be picked says so and returns to the branch step,
instead of opening a list where nothing can be ticked. The source step's question fits every row
it offers.**

### 1. No `Choose…` when nothing can be picked

`issueRows` disables every `Done` and every `HITL` issue. When no row is left enabled, `Choose…`
opens a `multiselect` with `required: true` and nothing to tick, and the only way out is Esc,
which cancels the whole picker. That is a dead end, which 13's back-navigation rule forbids.

When no row is enabled, the issues step asks nothing. Instead it shows a note under the issues
title, naming the folder and the branch and saying that every issue there is `Done` or `HITL`,
and returns `BACK` to the branch step, as it already does for a folder the tip does not carry.
When at least one row is enabled, the menu is unchanged: `All ready` when T69's predicate selects
a set, then `Choose…`, then `← Back`. The rule depends only on the rows, so the check belongs in
`picker/picker.ts`'s pure half, beside `issuesMenuRows`.

### 2. The source step's question

`SPEC_MESSAGE` is *Which spec?*, but since T83 and T85 the step also offers feature folders, a
typed task, and a resume. Rename the constant for what the step asks, and change the text to
*What should the run work on?*. Update the tests that assert the old text.

### 3. `bin.ts`'s long comment

If a comment line in `src/bin.ts` is still longer than 100 columns after T86, rewrap it. Change
only the wrapping, not the words.

### 4. Docs

SPEC §7's *no args on a TTY* row: after the sentence that says a folder the tip lacks returns to
the branch step, add that a folder with no issue that can be picked does the same. Clear the
leftover from T83's Status.

## Effect wiring

- **Tags introduced or consumed**: consumes `Prompt`. None introduced.
- **Layer composition**: unchanged.

## Acceptance criteria

- [ ] A folder whose every issue is `Done` or `HITL`, at the chosen tip: the issues step asks no
      `select`, shows one note naming the folder and branch, and the wizard is next at the branch
      step.
- [ ] A folder with one enabled issue and no ready set: the menu is `Choose…` and `← Back`, as
      today.
- [ ] The source step's message is *What should the run work on?*.
- [ ] No line in `src/bin.ts` is longer than 100 columns.

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package.
