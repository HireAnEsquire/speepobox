# T116 — `init --diff` reports drift

Status: Done (PR #79, merged over T115's values: they ride on the snapshot's `Write` arm. Not fixed: no `\ No newline at end of file` marker, and a stamp above the template's version reads `current`.)
Type: AFK
Blocked by: [T113](T113-the-templates-and-their-stamps.md) — stamps and template versions; [T114](T114-init-writes-the-scaffold.md) — `init`'s intercept and argv module, which this adds a flag to.

<!--
P5, ruled 2026-09-30 (09's comment of that date, E5, E6, E9). T115 also edits `src/init/`; the two
can run side by side, but expect a merge.
-->

## What to build

`bessemer init --diff` tells an adopter which scaffold files a newer package would change, and it
never counts their own edits as drift. It is read-only. It writes nothing and is allowed on a
**self-hosted** repo, where `init` itself refuses (E9). That makes this repo, once T112 has
stamped its files, the first real reader of the output.

For each **stamped** scaffold file (`.gitignore`, `image/Dockerfile`, `image/inputs`), it reads
the file and `readStamp`s it (T113), then reports one state:

| State | Meaning |
| --- | --- |
| **missing** | no such file; `init` would write it |
| **current** | stamp version equals the template's |
| **behind** | stamp version is below the template's — **or the file has no stamp**, which counts as version 0 |

A file that is present is also **pristine**, when its `bodyDigest` equals its stamp digest, or
**edited** otherwise. An unstamped file is edited.

- For a **behind** file, `--diff` prints a unified diff of the **current template** against the
  file, under a heading that says the diff includes the adopter's own edits. The template the
  file was stamped from is not kept, because the shim clones one SHA (E6). It then prints the
  refresh command: `rm <path> && bessemer init`. For a file that is **pristine and behind**, it
  adds that nothing of theirs is lost by taking the template.
- **`config.toml`** is checked for presence only (*missing* or *present*). Probe 7 judges what is
  in it, and a file of adopter-owned values has no drift.
- The tasks dir is not checked here. Probe 8 does that.
- A stamp naming a different template than the path it sits at (a copied file) is reported as
  edited and behind, with the name mismatch stated.

**Exit status**: 0 only when nothing is *missing* or *behind*, otherwise 1, so the command works
in CI. *edited* alone is not drift and never fails.

The diff is computed in-process, not by spawning `diff` or `git diff`, which would be one more
child and one more host binary. Keep it a small pure line-diff in `src/init/`, or use a
dependency the package already has. **Do not add a dependency** without surfacing it in the PR
description.

The report is `init`'s own snapshot event (T114), carrying a diff variant rather than a second
event family.

## Effect wiring

- **Tags introduced or consumed**: `Reporter`, `FileSystem`, `Path`. No new tag.
- **Layer composition**: unchanged. It is the same `bin.ts` case as T114/T115. `--diff` is a word
  `src/init/argv.ts` now accepts, and `init` branches on the parsed args. Refuse `--diff` combined
  with `--base` or `--image`, because those configure a write that `--diff` never makes.

## Acceptance criteria

- [ ] In a repo freshly written by `init`, `--diff` reports every stamped file as *current,
      pristine* and `config.toml` as present, and exits 0.
- [ ] After a body edit to the Dockerfile, it reports *current, edited* and exits 0.
- [ ] With a template version raised above a file's stamp, that file is *behind*. The diff and
      the `rm … && bessemer init` line print, and the exit is 1. A pristine behind file also
      carries the "nothing of yours is lost" line.
- [ ] A deleted `.gitignore` is *missing*, with exit 1. A file with its stamp line removed is
      *behind, edited*, with exit 1.
- [ ] A self-hosted invocation of `--diff` runs, while self-hosted `init` still refuses, and a
      *behind* file there names its template's path instead of printing `rm … && bessemer init`.
- [ ] `--diff --base x` is refused.
- [ ] Nothing under the served repo changes during any `--diff` run (compare the tree listing and
      contents before and after).

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package.
