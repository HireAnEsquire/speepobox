# T129 — `doctor`'s upstream row

Status: Done (PR #87. Smoke-tested against the real origin from an outside checkout: no release upstream yet.)
Type: AFK
Blocked by: [T121](T121-the-pin-is-read-by-one-grammar.md) — the pin reader; [T122](T122-releases-are-a-value.md) — the release list and the `ls-remote` read; [T123](T123-the-running-revision-carries-its-full-sha.md) — the running revision's full SHA.

<!--
P6, ruled 2026-10-02 (09's comment of that date, F14 and F15; SPEC §7's probe 11). Terms: **pin**,
**release** (CONTEXT.md). AGENTS.md's *unchecked check* rule decides the register of every row
here: `ok`, never `warn`.
-->

## What to build

How an adopter learns upstream moved: `doctor` gains probe 11, **upstream**, after probe 10.

- **The row**: `pinned vK (<short>); latest vN`, from T122's `ls-remote` — the same read `upgrade`
  makes — and the pin read through T121's module from `.bessemer/config.toml`. An untagged pin is
  `pinned <short> (no release); latest vN`. A pin T121 refuses is named by its refusal kind in the
  same row; probe 7 and the shim already say what to do about it.
- **The running revision** (F14): when it is not the pin — under a hand clone the two differ,
  which is why both readers exist — the row says so in the same register: *running `<short>`, not
  the pin*. The running revision is T123's full SHA, compared with the pin in full.
- **Always `ok`, never `warn`** (F14). Offline, timed out (10 s), or any git failure is an `ok` row
  saying nothing was compared, quoting git's line (F15). A `doctor` exit code never changes because
  of this row.
- **Not applicable self-hosted** (F8): one `ok` row saying so, and no `ls-remote` is spent — the
  checked-out branch chooses this repo's dispatcher, and there is no pin to read.
- **`doctor`-only.** It never joins the dispatch preflight, which reuses `doctor`'s probes
  (`dispatch/preflight.ts`): no dispatch waits on the network for advice, and there is no
  per-dispatch nudge (F14).

`doctor.ts` may not import `packageRoot` (SPEC §9), so `packageRepoRoot` arrives on `DoctorHost`
from `bin.ts`, which already computes it for `resolveDispatcherRevision`. Update SPEC §7's probe
table opening (*Eleven, in dependency order* already counts this row) only if what shipped differs.

## Effect wiring

- **Tags introduced or consumed**: `FileSystem`, `CommandExecutor` (T122's module). No new tag.
- **Layer composition**: unchanged. `DoctorHost` gains `packageRepoRoot: string`, set in `bin.ts`'s
  `doctor` case beside `packageRoot`. Put the resulting `DoctorHost` literal in the PR description.

## Acceptance criteria

Tests use a temp served repo and a temp package repo whose `origin` is a local bare repo with tags.

- [ ] Pin at `v1`, `v2` upstream: `ok  pinned v1 (<short>); latest v2`.
- [ ] Pin at the latest: the same row with K = N.
- [ ] Untagged pin: names it as no release.
- [ ] Running revision not the pin: the row says so, still `ok`.
- [ ] Unreachable `origin`: an `ok` row saying nothing was compared, quoting git; `doctor`'s exit
      code is what the other probes make it.
- [ ] Self-hosted: not applicable, and no `ls-remote` child is spawned.
- [ ] A dispatch's preflight spawns no `ls-remote` (assert on the dispatch test's recorded
      commands).

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package.

Host-only: `node src/bin.ts doctor` under plain node in this repo prints probe 11 as not applicable.
