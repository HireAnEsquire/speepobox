# T125 — The shim runs a cached pin

Status: Done (PR #89. Shim template v1, not yet in STAMPED_TEMPLATES (T127). The warm-path contract case carries a 60 s budget: a cold start of the CLI timed out at 5 s on CI.)
Type: AFK
Blocked by: [T121](T121-the-pin-is-read-by-one-grammar.md) — the TS grammar and the fixture lines the shim's `sed` is held to.

<!--
P6, ruled 2026-10-02 (09's comment of that date, F2, F3, F4, F6, F7, F17, F18, F19, with F6 and F18
as amended the same day). Terms: **shim**, **pin**, **package cache**, **release** (CONTEXT.md).
The shim's warm path only: building a cache entry is T126, and `init` writing the shim is T127.
Every test here runs offline with no mirror, because nothing here clones.
-->

## What to build

The **shim** template, `templates/bessemer`: a POSIX `sh` script (F3) that reads the served
repo's pin and runs the package cache entry for it. It is a template like the other four —
stamped, versioned at **v1** in `TEMPLATE_VERSIONS` — but it is not yet in `STAMPED_TEMPLATES`,
because `init` and `--diff` iterate that list and writing the shim is T127's. Its stamp goes after
the shebang, which `stamp`'s `leadingLines` already allows for (T113).

Every run, in this order, each failure one line on stderr naming its fix, exit 1:

1. **Prerequisites** (F3). `node` is on the `PATH` and its major version is 26 or later; `git` and
   `npm` are on the `PATH`. `doctor`'s probe 4 stays, but an old node fails here, before `doctor`
   could run at all. Each failure names what to install.
2. **The served repo, from where the shim sits** (F2, 19 §1): the directory above the shim's own
   `.bessemer/`, made absolute. Never the working directory, and nothing walks up to find a shim:
   that is the inference 19 rejected.
3. **The pin** (F6), read from `<repo>/.bessemer/config.toml` only — never `config.local.toml`,
   never the environment, no override (F6: a local override is the skew 01's property (a) forbids).
   One `sed` over SPEC §6's grammar. **Use `[[:blank:]]`, not `[ \t]`**: BSD `sed` does not read
   `\t` inside a bracket expression, and T121's tab fixture is there to catch it. The verdicts are
   T121's — pin, *no line*, *malformed*, *duplicated*, *empty*, *short* — and the refusals name the
   same fixes. *Empty* and *short* name, first, `git ls-remote --tags
   https://github.com/HireAnEsquire/bessemer.git` and copying a release's `vN^{}` full SHA onto the
   line; second, `upgrade --to vN` run from a hand clone the way the README's bootstrap runs `init`.
   The shim cannot run `upgrade` on a pin it cannot fetch (F6, amended).
4. **The cache entry** (F9): `${XDG_CACHE_HOME:-$HOME/.cache}/bessemer/<sha>/`. If that directory
   exists, it is complete — T126 guarantees only a complete entry ever has that name — and the
   shim runs it:

   ```sh
   exec node "$entry/src/bin.ts" --repo-root "$repo" "$@"
   ```

   That line *is* SPEC §6's contract (F17), items 1 and 2: the entry is `node <cache>/src/bin.ts`,
   `--repo-root <absolute>` comes first, and the rest of argv passes verbatim. Until T126 lands, a
   missing entry is a one-line refusal; T126 replaces that branch with the build.

The release URL, `https://github.com/HireAnEsquire/bessemer.git`, is one constant at the top of the
shim (F4). A fork edits it, which `--diff` reports as edited. The shim reads no token.

### The contract test (F18)

A test runs the shim's **warm path** against the current package: a fixture directory holding the
shim under test at `.bessemer/bessemer` and a `.bessemer/config.toml` whose pin is this checkout's
full `git rev-parse HEAD`, and a cache (`XDG_CACHE_HOME` in a temp dir) whose `<sha>` entry is a
**symlink to this checkout**. It runs `.bessemer/bessemer init --diff` and asserts the output
names the fixture's files — which proves `--repo-root` reached the package. No network, no docker,
no writes. Not `doctor`, which T129 sends to the network. `--diff` asks the served repo no git
question, so a plain directory serves.

It runs the **current** template and every **released** shim template kept under the test
fixtures. A shim template's text is kept as a fixture only for a version that appeared in a
`v<N>` (F18, amended), so before `v1` that set is empty. Say the rule where the next person to bump
the shim will read it — beside the shim's entry in `TEMPLATE_VERSIONS` and in the fixture
directory: *bumping a released shim template: copy its text here first, named by version.* A
package release never stops accepting a call an earlier released shim makes (F17).

### The shim's own warm-path tests (F7, F19)

The child is spawned from the test with `node:child_process` and its environment written out in
full — `PATH`, `HOME`, `XDG_CACHE_HOME`, and nothing inherited (T126 adds `GIT_CONFIG_*` and
`npm_config_offline`). That is a second exception to the chokepoint, beside AGENTS.md's live case
5, and **not for case 5's reason**: these children run to completion, and nothing here holds a
live pid. The reason is a test-only environment the chokepoint has no spelling for — `execUnder`
carries one variable, and growing `src/` a way to hand a child a whole environment, for tests
alone, is the wrong trade. Add the shim tests to that AGENTS.md paragraph by name, with that
reason. Nothing in `src/` may do this.

A stub package for these: a cache entry whose `src/bin.ts` prints its argv and its own location.

- **Agreement (F7)**: every T121 fixture line, as the fixture repo's `config.toml`, gives the same
  verdict from the shim as from T121's module — the same SHA for a pin (the stub's location names
  the entry it ran), the same refusal kind otherwise. Make the refusal lines carry their kind in a
  form the test can read.
- **Argv passthrough**: arguments with spaces, quotes, `$(…)`, an empty string, and `--` arrive at
  the stub verbatim, after `--repo-root <absolute repo>`.
- **Short, empty, and malformed pins** refuse in one line naming their fix (covered by the
  agreement fixtures; assert the remedy text for empty and short).
- **Node too old**: a fake `node` first on a `PATH` that still holds the real `git` and `npm`
  refuses in one line naming node 26. Missing `git` and missing `npm` likewise.
- **Run from elsewhere**: invoked by absolute path from a different working directory, the
  `--repo-root` is still the fixture repo.

## Effect wiring

- **Tags introduced or consumed**: none. The shim is shell; the package side is unchanged.
- **Layer composition**: unchanged.

## Acceptance criteria

- [ ] `templates/bessemer` exists, is POSIX `sh` (`sh -n` passes; no bashisms), starts with a
      shebang, and carries a stamp `readStamp` accepts once stamped; `TEMPLATE_VERSIONS` names it
      at v1.
- [ ] The contract test passes: the warm path runs `init --diff` from the current package against
      the fixture repo and its output names the fixture's files.
- [ ] The agreement test passes over every T121 fixture.
- [ ] The passthrough, node-too-old, missing-git, missing-npm, and run-from-elsewhere cases pass.
- [ ] The empty and short refusals name `git ls-remote --tags <release URL>` before `upgrade --to
      vN` from a hand clone.
- [ ] AGENTS.md's chokepoint exception names the shim tests, with the hand-written-environment
      reason rather than case 5's live pid.

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package.

Host-only, and worth doing on macOS: the agreement test under the host's BSD `sed` and `/bin/sh`,
since the container's are GNU and dash.
