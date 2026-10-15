# T145 — init refreshes what nobody edited

Status: ready-for-agent
Type: AFK
Blocked by:

<!--
Ruled 2026-10-15: amends E4 (09). E4 says `init` writes only absent files and never overwrites one,
so an adopter refreshes a behind file by deleting it and running `init` again, one file at a time,
and the shim by a three-step `mv` dance. That keeps an adopter's edits safe, and it is also the
whole cost of an upgrade. A file that is behind and pristine is one `init` wrote and nobody touched:
its text hashes to its own stamp, so overwriting it loses nothing. Those are the files the dance
exists for, and this ticket lets one command take them.

E4's guarantee stands for everything else: an edited file, an unstamped file, and `config.toml` are
never overwritten. There is still no `--force`.

Surfaced 2026-10-15 re-pinning hae to v4, where three of five scaffold files had to be deleted by
hand before `init` would write them.
-->

## What to build

### `init --refresh`

A new bare flag on `init`. It does everything `init` does (writes absent files, reports `wrote` and
`kept`), and also **overwrites every stamped file that is behind and pristine**:

- **behind**: the file's stamp version is lower than the template's (`TEMPLATE_VERSIONS`);
- **pristine**: the file has a stamp, and its body digest equals that stamp's digest (`bodyDigest`).

`diff.ts` already sorts each file this way. Reuse that one classification; do not write a second.

A refreshed file gets the current template's stamped text, exactly as `init` writes an absent one.
The report line is `refreshed  <path>  (v<old> → v<new>)`.

Every other file present stays as it is, and is reported:

- **current** (pristine or edited): `kept`, as today.
- **behind and edited**, including **unstamped** (no stamp counts as edited, as in `diff.ts`):
  `kept  <path>  (behind, edited — see init --diff)`. Never overwritten.
- `config.toml`: `kept`, as today. It is not stamped.

### Safe writes

- **Every refusal comes before any write**, as `init` already does. The classification is made once,
  up front, over every file.
- **Each overwrite is atomic**: write the new text to a temp file in the same directory, set its
  mode, then `rename` it over the old file. A failure leaves the old file whole. A failed write
  refuses naming the path; files already refreshed stay refreshed and the report says which.
- **The shim is refreshed in place, mode 0755.** This is safe while the shim is the program
  running `init`: the shim ends in `exec node …` (`templates/speepobox`), so no shell is still
  reading the file, and the rename leaves the old inode with anyone who has it open. The `mv`
  dance stays only for an *edited* behind shim.

### Flags

- `--refresh` with `--diff` is refused, as `--base`/`--image` with `--diff` are now.
- `--refresh` with `--base` or `--image` is allowed: those still apply only when `config.toml` is
  absent.
- `--refresh` given twice is refused, like every other flag.
- On a self-hosted repo `--refresh` refuses, as `init` does (E9).

### `init --diff` points at it

In `render.ts`, the fix line for a **behind and pristine** file (the shim included) becomes:

```
To refresh it: .speepobox/speepobox init --refresh
```

For a **behind and edited** file, keep today's lines (`rm … && … init`, or the shim's `mv`
dance), and add one line before them: `This file has your edits: merge the diff above by hand, or
take the template and lose them with:`.

When at least one file is behind and pristine, `--diff` ends with one summary line:
`init --refresh takes the <N> pristine file(s) above in one step.`

### Docs

- `SPEC.md` §7, the `init` row: replace "never overwrites" with the rule above. Say `--refresh`
  overwrites behind-and-pristine stamped files only, atomically, and reports `refreshed`. Keep "no
  `--force`" and "no `--dry-run`".
- `README.md`'s upgrading section: the usual path is now `upgrade`, then `init --diff`, then
  `init --refresh`, then merge any edited file by hand. The `rm` and `mv` lines move under "a file
  you edited".
- `src/init/init.ts`'s header comment: E4 as amended by this ticket.
- `INIT_USAGE` gains `--refresh`.
- Do not edit `09-post-move-sequence.md`. It is a frozen history doc; this ticket records the
  amendment.

## Effect wiring

- **Tags introduced or consumed**: none new. `FileSystem`, `Path`, `Reporter`, and `Git` as `init`
  already uses them.
- **Layer composition**: unchanged.

## Acceptance criteria

- [ ] `init --refresh` overwrites a behind, pristine stamped file with the current template, and
      reports `refreshed` with both versions.
- [ ] A behind, edited file and an unstamped file are left byte-identical, and reported as behind
      and edited.
- [ ] `config.toml` and every current file are left byte-identical.
- [ ] A behind, pristine shim is refreshed in place and is mode 0755 afterwards.
- [ ] Absent files are still written, as plain `init` writes them.
- [ ] A write that fails leaves that file's old text whole (a test makes the rename fail).
- [ ] `--refresh` with `--diff`, `--refresh` twice, and `--refresh` on a self-hosted repo each
      refuse with nothing written.
- [ ] `init --diff` prints `init --refresh` for a behind, pristine file, the warning line plus the
      old command for a behind, edited one, and the summary line when any file is pristine and
      behind.
- [ ] Running `init --refresh` and then `init --diff` on a repo whose files are all pristine
      reports no drift.

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package.

Also inside the container: `node src/bin.ts init` with no further words, under plain node, still
prints the self-hosted refusal (not a crash), and `node src/bin.ts init --refresh` prints the same
refusal.

Host-only, after merge: in a throwaway repo, run `init`. Lower the version on `.gitignore`'s stamp
line by one, which leaves it pristine and behind, since the digest skips the stamp line. Add a
line to `image/inputs` and lower its stamp too, which leaves it edited and behind. Then
`init --diff` should offer `--refresh` for `.gitignore` only, and `init --refresh` should rewrite
`.gitignore` and keep `inputs`.
