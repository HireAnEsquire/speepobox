# T127 — `init` installs the shim, and its printed commands work as printed

Status: Done (PR #91. Shim joins STAMPED_TEMPLATES, written 0755; config.toml template now v3. A self-hosted repo's absent shim is listed by design and counts toward no drift, so `init --diff` here exits 0.)
Type: AFK
Blocked by: [T125](T125-the-shim-runs-a-cached-pin.md) — the shim template this writes.

<!--
P6, ruled 2026-10-02 (09's comment of that date, F1 and F2, and its two amendments of the same
day: the shim's refresh fix, and init working out config values only when it writes config.toml).
Terms: **shim**, **scaffold**, **template**, **drift** (CONTEXT.md). T124 also edits `src/init/`
and `templates/config.toml`; the two can run side by side, but expect a merge, as T115 and T116
had. This is T117's finish line: the commands `init` prints work as printed.
-->

## What to build

`init` writes the shim, `--diff` keeps it honest, and every command `init` and `--diff` print for
an adopter to run is spelled `.bessemer/bessemer …`.

### 1. The shim joins the scaffold (F1)

- `bessemer` (T125's template) joins `STAMPED_TEMPLATES`, so `init` writes it to
  `.bessemer/bessemer` and `--diff` measures it like the other stamped files.
- **Mode 0755.** Written through `FileSystem` with the exclusive create `init` already uses, and
  the mode set on that write. Only absent files are written (E4), so a kept shim's mode is never
  touched.
- **`--diff` reports a lost executable bit as its own condition, *not executable*,** apart from
  drift: a shim that is present and lacks the owner's execute bit says so, with `chmod +x
  .bessemer/bessemer` as its fix. A lost bit is the adopter's change, not drift, so it does not
  make the file *behind* — but it does count toward `--diff`'s exit 1, since the shim cannot run.
  Only the shim is asked; no other scaffold file is executed.

### 2. A behind shim's fix is not delete-and-rerun (09, amended)

E6's fix for a behind file is `rm <file> && bessemer init`. For the shim that runs the file it
just deleted. **For the shim only**, `--diff` prints:

```
mv .bessemer/bessemer .bessemer/bessemer.old && .bessemer/bessemer.old init && rm .bessemer/bessemer.old
```

and, beside it, the restore line for an `init` that fails partway:

```
mv .bessemer/bessemer.old .bessemer/bessemer
```

It works because the shim names the repo from its own directory, still `.bessemer/`; `init` sees
the shim as absent and writes the new one from the running pin's templates, which after an
`upgrade` are the new ones (F17's promised call); `mv` keeps the mode; and the shim `exec`s node,
so no `sh` is still reading the file when it moves. A hand clone running `init`, as the README's
bootstrap does, is named as the fallback only. A leftover `.old` is not ignored by the
`.gitignore`, so `git status` shows it — leave it that way. Every other stamped file keeps E6's
fix.

### 3. `init` works out its config values only when it will write `config.toml` (09, amended)

Today `init` resolves `base` before it writes anything, even when `config.toml` is present and
will be kept — so on a repo with no `origin/HEAD`, the shim refresh above refuses with *pass
`--base`* over a value it will not use. A kept file asks nothing (E4): resolve `base`, `image`, and
`tool-sha` only when `config.toml` is absent, the same rule the `tool-sha` warning already follows
(`configWritten`). The snapshot's values, and the `wrote` line that shows them, exist only when the
config was written; shape the snapshot so a kept config cannot carry values.

### 4. Printed commands read `.bessemer/bessemer …` (F2)

Every command `init` and `--diff` print for an adopter to run:
- the next steps (`render.ts`): `.bessemer/bessemer image build`, `.bessemer/bessemer doctor`, and
  a step to commit `.bessemer/` that now includes the shim;
- `--diff`'s refresh for a behind non-shim file: `rm <file> && .bessemer/bessemer init`;
- `templates/config.toml`'s `image-build-command` default: `.bessemer/bessemer image build`, which
  `doctor` and the preflight print when the image is missing or stale. Bump `config.toml`'s
  template version; if T124 has already bumped it, take the next number.

Not changed: usage synopses (`bessemer gc [--force]`, `INIT_USAGE`, `IMAGE_USAGE`) name the
program, not a command to paste. Self-hosted output is unchanged — this repo has no shim, and its
own `image-build-command` is `node src/bin.ts image build` (E12).

## Effect wiring

- **Tags introduced or consumed**: `FileSystem`, as today. No new tag.
- **Layer composition**: unchanged.

## Acceptance criteria

- [ ] In an empty temp served repo, `init` writes `.bessemer/bessemer` with mode 0755 and a stamp
      `readStamp` accepts, beside the other files (test).
- [ ] A second `init` keeps it and reports `kept`.
- [ ] `--diff` with the shim `chmod -x`'d reports *not executable* with the `chmod +x` fix, exits 1,
      and does not call it behind (test).
- [ ] `--diff` with a shim stamped below the template's version prints the `mv … .old` fix and the
      restore line, and not `rm`; a behind `.gitignore` still prints `rm … && .bessemer/bessemer
      init` (tests).
- [ ] With `config.toml` present and no `origin/HEAD` and no `--base`, `init` writes the absent
      shim and refuses nothing; no `Git` read for the base is made (test, against the fake).
- [ ] The next steps and the config template's `image-build-command` say `.bessemer/bessemer …`.
- [ ] End to end in a temp served repo: after `init`, running the written shim's refresh sequence
      from T125's warm path (symlinked cache entry, as in its contract test) leaves a current,
      executable shim and no `.old` (test).

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package.

Host-only: `node src/bin.ts init --diff` under plain node in this repo lists the shim as absent and
not written here, as it does the other stamped files.
