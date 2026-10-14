# T126 — The shim builds the package cache

Status: Done (PR #90. Shim template v2. The race case pins the outcome, not that the lost-race arm ran; green six runs in a row under macOS `/bin/sh`.)
Type: AFK
Blocked by: [T125](T125-the-shim-runs-a-cached-pin.md) — the shim's warm path, whose missing-entry branch this replaces.

<!--
P6, ruled 2026-10-02 (09's comment of that date, F4, F9, F10, F17, F19). Terms: **package cache**,
**shim**, **pin** (CONTEXT.md). The package cache is not the runtime root: nothing a dispatch
writes goes there, and `gc` does not look there.
-->

## What to build

The shim's **cold path**: when `${XDG_CACHE_HOME:-$HOME/.cache}/bessemer/<sha>/` does not exist,
build it, then run it exactly as the warm path does. Bump the shim template's version for the
change; nothing has been released yet, so no fixture is kept (F18, amended).

### Building an entry (F9)

1. **Sweep dead temp directories** (F10). Every `<anything>.tmp.<pid>` in the cache root whose pid
   is not alive is removed, judged by the pid in its name and **never by age** (T20, T26). `kill -0`
   answering *no such process* is dead; a permission error is someone else's live process, so
   alive. Only the slow path sweeps — the warm path touches nothing.
2. **Prepare in `<sha>.tmp.<pid>/`**, `$$` being the shim's pid: `git init`, `origin` set to the
   release URL, fetch the one SHA at depth 1, and check it out detached, so `HEAD` is the pin and
   `origin` is the release URL — SPEC §6's contract item 4. Then `npm ci --omit=dev
   --ignore-scripts` (item 3).
3. **Move it into place with `rename(2)`**, through `node -e` and `fs.renameSync`. **Not `mv`**:
   when the target already exists as a directory, `mv` moves the temp directory *into* it and
   succeeds, nesting `<sha>/<sha>.tmp.<pid>/` (verified on macOS; BSD `mv` has no `-T`).
   `rename(2)` onto a non-empty directory fails with `ENOTEMPTY` (or `EEXIST`) on Linux and macOS:
   that is the lost race, and the loser removes its own temp directory and runs the winner's entry.
   Any other rename failure is a refusal.
4. **An interrupted build leaves only a temp directory**, which never counts as an entry and is
   swept by the next slow path once its pid is dead. Remove the temp directory on the shim's own
   failure paths too (`trap`), but correctness does not depend on it.

Nothing prunes old entries: the cache is shared across served repos, and another repo may pin an
old SHA (F10).

### Credentials (F4)

The repository is private. The shim reads no token: it uses the operator's git credential chain,
with `GIT_TERMINAL_PROMPT=0` on the fetch so a missing credential fails instead of hanging. A
failed fetch is one line quoting git's error and naming `gh auth setup-git` (an authenticated `gh`
is already a preflight prerequisite, probe 6), and also says that the SHA may not exist upstream —
a pin nobody pushed fails the same way.

### Tests (F19)

The cold path runs in verify against a **fixture mirror**, offline by construction:

- The mirror is a local git repo holding a stub package — an empty lockfile (`npm ci` with no
  dependencies) and a `src/bin.ts` that prints its argv — at a known commit.
- The shim's hard-coded URL reaches it through a `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_0` /
  `GIT_CONFIG_VALUE_0` `url.<mirror>.insteadOf=https://github.com/HireAnEsquire/bessemer.git`
  rewrite, set **on the child only**. `origin` in the entry still reads as the release URL, which
  is what item 4 of the contract requires.
- `XDG_CACHE_HOME` points at a temp directory, `npm_config_offline=true`, and the child's
  environment is written out in full, as T125's are.

Cases:

- **Cold run**: an empty cache builds `<sha>/`, the stub prints the argv, and the entry's `HEAD`
  is the pin and its `origin` the release URL.
- **Warm run with the mirror deleted**: the second run succeeds with no source to fetch from.
- **Two concurrent first runs**: both succeed, both run the stub, exactly one `<sha>/` exists, and
  there is no `<sha>/<sha>.tmp.*` and no leftover `*.tmp.*`.
- **A dead temp directory** (`<sha>.tmp.<a pid that is not alive>`) is swept by the next cold run;
  a temp directory named for a live pid (the test's own) is left alone.
- **An unreachable source** (the rewrite pointed at a path that is not a repo) fails in one line
  naming `gh auth setup-git`, and leaves no `<sha>/`.

## Effect wiring

- **Tags introduced or consumed**: none. Shell only.
- **Layer composition**: unchanged.

## Acceptance criteria

- [ ] The five cases above pass in `npm run verify` with no network.
- [ ] The cold path never names a directory `<sha>` before it is complete, and uses no `mv`.
- [ ] The shim template's version is bumped, and no contract fixture is added.

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package.

Host-only, and worth doing on macOS: the concurrent case under the host's `/bin/sh`.
