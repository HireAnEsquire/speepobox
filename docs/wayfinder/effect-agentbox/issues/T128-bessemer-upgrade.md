# T128 — `bessemer upgrade`

Status: Done (PR #88. withPin in src/pin/pin.ts rewrites the one line; src/upgrade/ holds argv, snapshot, render.)
Type: AFK
Blocked by: [T121](T121-the-pin-is-read-by-one-grammar.md) — the pin reader and line locator; [T122](T122-releases-are-a-value.md) — the release list, the move decision, and the `ls-remote` read.

<!--
P6, ruled 2026-10-02 (09's comment of that date, F13 and F15, with F6 as amended the same day;
SPEC §7's `upgrade` row). Terms: **pin**, **release**, **package cache** (CONTEXT.md).
-->

## What to build

`bessemer upgrade` moves the served repo's pin to the newest release, and `upgrade --to vN` pins a
named one. It rewrites one line and commits nothing.

**Where it sits.** Intercepted in `bin.ts`'s switch beside `init`, before any config decode: it
reads the pin by T121's grammar, never through `BessemerConfig` (T120). It parses its own words in
its own argv module, as `gc` and `init` do. Its words are `--to vN`, and nothing else: anything
else is refused with the usage line, `--dry-run` included.

**What it does, in order, writing nothing until the last step:**

1. **Refuses self-hosted** (F13, F8), before reading anything: the checked-out branch chooses this
   repo's dispatcher, and there is no pin.
2. **Reads `.bessemer/config.toml`** and T121's verdict on it.
   - Plain `upgrade` needs a pin. *Empty* and *short* refuse the way an untagged pin does (below).
     *No line*, *malformed*, and *duplicated* refuse with T121's sentence.
   - `--to vN` needs **a line the grammar matches, not a valid value in it** (F6, amended): a pin,
     *empty*, or *short* all have a line to rewrite. *No line*, *malformed*, and *duplicated* refuse
     — there is no one line it is safe to rewrite.
   - `--to` with a value that is not a release name (`^v[1-9][0-9]*$`) refuses before the network.
3. **Reads the releases** through T122's `ls-remote` in the package's own repo (`packageRepoRoot`
   from `bin.ts`) — under the shim, the cache entry, whose `origin` is the release URL. A timeout
   (10 s) or a git failure refuses quoting git's line, with nothing written (F15).
4. **Decides** (F13, by tag number, never ancestry):
   - **plain**: an untagged pin — including one from a hand clone, and an empty or short one —
     refuses with *pin `<short>` is no release; `upgrade --to vN` pins one explicitly*. A pin that
     is `vK`: `vN` with N > K moves; N = K says the pin is current and writes nothing (exit 0). Two
     releases on one commit count as the higher. No release upstream at all refuses, saying so.
   - **`--to vN`**: `vN` must be in the list, or it refuses naming the latest. Any `vN` is allowed,
     lower ones included — `--to` is how a rollback is made deliberate. Pinning the commit already
     pinned says so and writes nothing.
5. **Rewrites only the `tool-sha` line** (T121's locator), to `tool-sha = "<full sha>"`. Every other
   byte of the file is unchanged, including line endings and the trailing newline.
6. **Prints** what moved — `pinned vN (<short>), was vK (<short>)`, or `was <short> (no release)` —
   and then `.bessemer/bessemer init --diff` as a command to run, **without running it**: the next
   shim call runs the *new* pin, whose templates are the ones to diff against. It commits nothing.

Render through a `Reporter` event and a pure renderer, as `init` and `gc` do. Exit 1 on every
refusal.

## Effect wiring

- **Tags introduced or consumed**: `Reporter`, `FileSystem`, `CommandExecutor` (through T122's
  module). No new tag.
- **Layer composition**: `app.ts` is unchanged. `upgrade` takes the read-only slice, as `init` does,
  with `packageRepoRoot` and `selfHosted` passed in from `bin.ts`:

  ```ts
  case "upgrade":
    return upgrade({ repoRoot, argv: argv.slice(1), selfHosted, packageRepoRoot }).pipe(
      Effect.provide(appBaseLiveFor(repoRoot, stdinIsTTY)),
      Effect.catchAll(reportFailure),
    );
  ```

  Put the resulting `bin.ts` case in the PR description. Add `upgrade` to `usage`.

## Acceptance criteria

Tests run against a temp served repo and a temp package repo whose `origin` is a local bare repo
carrying tags — no network.

- [ ] A pin at `v1` with `v2` upstream: the line becomes `v2`'s full SHA, the rest of the file is
      byte-identical, and the output names both and prints `.bessemer/bessemer init --diff`.
- [ ] A pin at the latest release: *current*, nothing written, exit 0.
- [ ] A pin on a commit tagged `v2` and `v3`: read as `v3`.
- [ ] An untagged full pin, an empty pin, and a short pin: plain `upgrade` refuses naming `--to
      vN`; nothing written.
- [ ] `--to v1` from `v2` rewrites to `v1`; `--to v1` over an empty or short line rewrites it;
      `--to v9` (absent) refuses naming the latest; `--to 1` refuses before the network.
- [ ] *No line*, *malformed*, and *duplicated* files refuse both forms; nothing written.
- [ ] An unreachable `origin` refuses quoting git; nothing written.
- [ ] Self-hosted refuses before reading anything.
- [ ] No `git commit` is run; the served repo's `git status` shows only the config change.

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package.

Host-only: `node src/bin.ts upgrade` under plain node in this repo refuses as self-hosted.
