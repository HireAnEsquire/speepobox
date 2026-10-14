# T87 — An empty `--feature` is refused as empty

Status: Done (PR #42)
Type: AFK
Blocked by: none.

<!--
Split out of T78 on 2026-09-22: one of the two findings from reviewing T73 that T78 carried
because both sat in `featureStatedOnce`'s `onNone` arm. This one has nothing to do with a resume
and goes green on its own; T88 then edits the same arm for the resume's subset rule, which is why
this lands first.
-->

## What to build

**`--feature` given only whitespace is refused because it is empty, naming `--feature`. It is not
refused with the sentence that tells the dispatcher to pass the flag they just passed.**

`stated()` filters `--feature`, so `--feature '  ' --issues all` falls into
`featureStatedOnce`'s `onNone` arm. There it is refused with *`--issues` names the issues of a
feature or narrows a resume — pass `--feature <folder>` beside it*. T67 ruled out exactly that
shape for `--task ""`, and the comment over `featureStatedOnce` claims to avoid it: the refusal has
to be about the emptiness.

Read `--feature` **as typed** beside the filtered value. The `onSome` arm already makes this split
for `--issues`, and `taskStatedOnce` makes it for `--task`. The refusal must fire whatever else is
on the command line: `--feature '  '` alone, beside `--issues`, and beside `--resume` are all a
flag that named no folder. Keep its place in the order T73 set — decided from the command line
alone, ahead of anything this phase asks of the world.

## Effect wiring

- **Tags introduced or consumed**: none.
- **Layer composition**: unchanged.

## Acceptance criteria

- [ ] `--feature '  ' --issues all --branch b` refuses with a sentence about the empty
      `--feature` value, and does not tell the dispatcher to pass `--feature`.
- [ ] `--feature ''` alone and `--feature '  ' --resume b` refuse the same way, before any
      ledger or git read.
- [ ] Every existing `featureStatedOnce` case passes unchanged.

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package.
