# T147 — refresh leaves no stray file

Status: Done (PR #5. `init --refresh` removes each stamped target's `<file>.refresh` before it writes, a `removed` line each; `.gitignore` v4 ignores `*.refresh`. Left as is: a refusal after a removal does not name the removed file, and a dangling symlink at the temp path is skipped silently.)
Type: AFK
Blocked by:

<!--
From T145's Done line: "the temp file has a fixed name, `<file>.refresh`, so a kill mid-refresh can
strand one." `replaceFile` in `src/init/init.ts` writes the new text to `<file>.refresh`, sets its
mode, and renames it over the file. A kill between the write and the rename leaves, for example,
`.speepobox/speepobox.refresh`. `.speepobox/.gitignore` does not match it, so it shows in the
adopter's `git status` as an untracked file nobody can explain, and a `git add -A` commits it.

Ruled 2026-10-15: keep the fixed name. A known name is what lets the next refresh find and remove a
leftover; a unique name would strand files nothing can identify. T149 makes `upgrade` run
`init --refresh` every time, so this case gets more common, not less.
-->

## What to build

### The template `.gitignore` ignores a leftover

Add one entry to `templates/.gitignore`, with a comment in the file's style saying what writes it:

```
# A refresh's temp file, `<file>.refresh`, left only if a refresh was
# killed between its write and its rename. Unanchored, so one under image/
# matches too.
*.refresh
```

Bump `.gitignore` in `TEMPLATE_VERSIONS` (`src/init/stamp.ts`) so `init --diff` reports it behind and
`init --refresh` brings it to adopters. Follow the comment beside `TEMPLATE_VERSIONS` for anything a
bump owes, such as fixtures.

### `init --refresh` removes leftovers

Before it writes anything, `init --refresh` removes `<target>.refresh` for each stamped scaffold
target (`STAMPED_TEMPLATES`) where one exists.

- Only those exact paths. Never a glob, and never anything else in `.speepobox/`.
- Only a regular file. Anything else at that path (a directory, say) is left alone and reported as a
  warning.
- Each removal is reported with a line of its own, in the same form as the other report lines:
  `removed  .speepobox/<file>.refresh  (left by an interrupted refresh)`.
- A removal that fails is a warning, not a refusal: the refresh goes on, and `replaceFile`'s own
  write then overwrites the leftover anyway.
- Plain `init` (no `--refresh`) and `init --diff` do not remove anything; they never create the
  file.

## Effect wiring

- **Tags introduced or consumed**: none new. `FileSystem` and `Reporter`, which `init` already has.
- **Layer composition**: unchanged.

## Acceptance criteria

- [ ] `templates/.gitignore` has the `*.refresh` entry, and its version is bumped.
- [ ] A test: with `.speepobox/speepobox.refresh` and `.speepobox/image/Dockerfile.refresh` present,
      `init --refresh` removes both and reports a `removed` line for each.
- [ ] A test: a directory at `.speepobox/speepobox.refresh` is not removed, the refresh still runs,
      and a warning names the path.
- [ ] A test: plain `init` leaves a `<file>.refresh` in place.
- [ ] Every existing `init` test passes without edits to what it asserts, except where the `.gitignore`
      version bump changes an expected version number.

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package.

Also inside the container: `node src/bin.ts init --diff` under plain node prints its listing, not a
crash. (Self-hosted, it lists; it does not refuse.)
