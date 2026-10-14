# T95 — The editor opens on a line of its own

Status: Done (PR #55.)
Type: AFK
Blocked by: none.

<!--
From the P3 picker walk-through, 2026-09-23. `templateFor` (`prompt/editor.ts`) writes the
commented header first, and the blank lines last. An editor opens with the cursor on line 1, so a
dispatcher who starts typing writes onto the first comment line: `tidy the docs# feedback for
'b'`. `stripComments` drops only lines that *start* with `#`, so it keeps that whole line, and the
header's text reaches the agent inside the task. bash writes the same order (`run.sh:1164`).
`git commit` avoids this by putting an empty line first, above its comments.
-->

## What to build

**The editor's file starts with an empty line, above the commented header, as `git commit`'s
does.** Whatever the dispatcher types first lands on a line of its own.

### 1. The template

`templateFor` puts one empty line before the header. It drops the trailing blank lines it adds
today, because they are no longer where the dispatcher types. Every other line keeps its words
and order: the header behind `# `, a bare `#`, and the stripping notice.

`stripComments` is unchanged. It already trims the leading blank line.

The comment above `templateFor` says the blank comment line puts *the dispatcher's cursor under
prose that says what happens to what they type*. That was never true, because editors open at
line 1. Rewrite the comment to say that the text goes above the comments, as it does in
`git commit`.

### 2. Tests

In `test/editor.test.ts`, *says what the text is for and what happens to a # line* asserts the
template line by line. Change it to the new order. Keep its assertion that an untouched template
strips to `""`.

The test *says what an empty text does when the caller names it* reads the notice at index 2,
which moves to index 3.

Add one case: text typed on the first line of the template, with every comment line left in
place, strips to exactly that text.

### 3. Docs

This is a deliberate difference from bash. Add it to SPEC §12's *Known ported-with-divergence
set*: **the editor's file opens on an empty line above its comments**, citing `run.sh:1164` and
T95.

## Effect wiring

- **Tags introduced or consumed**: none.
- **Layer composition**: unchanged.

## Acceptance criteria

- [ ] The template's first line is empty, and its second is the first header comment.
- [ ] An untouched template strips to `""`.
- [ ] `x` typed on the template's first line, with every comment left in place, strips to `"x"`.
- [ ] SPEC §12's divergence set names the change.

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package.
