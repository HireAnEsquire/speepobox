# T123 — The running revision carries its full SHA

Status: Done (PR #84. toDispatcher strips the full SHA, so ledger rows keep the short form.)
Type: AFK
Blocked by: None — can start immediately.

<!--
P6, ruled 2026-10-02 (09's comment of that date, F6 and F14). Prefactor with its own green:
T124 writes the full SHA as the pin, and T129 compares the running revision with the pin.
-->

## What to build

`resolveDispatcherRevision` (`src/git/dispatcher-revision.ts`, T43) reads `rev-parse --short HEAD`
in the package's repo. P6 needs the **full** SHA as well:

- `init` pins `rev-parse HEAD`, not the short revision it writes today (F6) — the shim fetches by
  SHA, and GitHub serves a fetch only for a full one.
- `doctor`'s upstream row says when the running revision is not the pin (F14), and the pin is
  full.

`DispatcherRevision` gains the full SHA beside the short `revision`. **The ledger and every
display keep the short form** (F6): the record's field, `status`, the roots row, and probe 10's
not-applicable row are unchanged. Read both from one `git` call if that is simple (`rev-parse
HEAD` and shorten it with git's own abbreviation, or two calls); either way the short form must
stay what `--short` gives today, since rows already on disk carry it.

The `None` case is unchanged: a read that came back empty is `None`, never a fabricated value.

## Effect wiring

- **Tags introduced or consumed**: none.
- **Layer composition**: unchanged.

## Acceptance criteria

- [ ] In a temp repo, the resolved revision carries a 40-hex SHA equal to `git rev-parse HEAD` and
      a short revision equal to `git rev-parse --short HEAD` (test).
- [ ] The ledger record, `status`, and `doctor` render the short form exactly as before (existing
      tests unchanged).

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package.
