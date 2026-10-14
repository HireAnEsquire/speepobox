# T132 — The release fetch authenticates through gh

Status: Done (PR #93. Shim template v3; v1's shim kept as `test/fixtures/shim/bessemer.v2`. `releases.ts` expands `origin` before choosing a credential, so an `insteadOf` rewrite is honoured. Host-checked on an SSH-only gh host: README lookup and `gh repo clone`, shim cold path fetched v1 through gh, global git config untouched. Resume fixed a macOS-only test hang: Homebrew's system `osxkeychain` helper answered the fallback cases' `store` with a modal.)
Type: AFK
Blocked by: None — can start immediately.

<!--
F4 amended 2026-10-05 (09's comment of that date), from
research/09-shim-fetch-auth-findings.md — read its Q2 and Q5 (b) before starting; the measured
forms and gh's own source are there. Terms: **shim**, **pin**, **release**, **package cache**
(CONTEXT.md).
-->

## What to build

A host whose git reaches GitHub over SSH, with no HTTPS credential helper, can bootstrap, run the
shim cold, `upgrade`, and read `doctor`'s upstream row, without running `gh auth setup-git` and
without anything written to its git config.

### The pair

Every git call that reaches the release URL runs first with gh as its credential, for that call
only:

```
-c credential.https://github.com.helper=
-c 'credential.https://github.com.helper=!gh auth git-credential'
```

The empty value is the scoped reset and is load-bearing: without it git also sends gh's token to
the operator's own helpers to `store`. gh adds this same pair to its own fetches (findings, Q1).

- **Only when `gh` is on the `PATH`.** No F3 check is added: `doctor` must stay reachable on a host
  without gh.
- **gh first, then the operator's chain.** When gh is absent, or the gh attempt fails, the call runs
  again exactly as today. A refusal quotes both attempts' git lines and names `gh auth login`, then
  `gh auth setup-git`.

### Where

1. **The shim** (`templates/bessemer`): the cold path's fetch. Resolve gh once with `command -v`
   and quote its path inside the helper value, as the findings' (b) shows. Keep
   `GIT_TERMINAL_PROMPT=0` on both attempts.
2. **`src/git/releases.ts`**: `readRemoteReleases`'s `ls-remote`, which serves `upgrade` and
   `doctor`'s upstream row, gets the same pair and the same fallback, both inside the existing
   10 s budget (F15). Bare `gh` here, resolved on the forwarded `PATH`.
3. **The empty and short pin refusals** (the shim's `unfetchable`, and `src/pin/pin.ts`'s
   `unfetchableRemedy`, which stay one sentence) name
   `gh api --paginate repos/HireAnEsquire/bessemer/tags --jq '.[] | "\(.commit.sha) \(.name)"'`
   in place of `git ls-remote --tags <url>`. `/tags` is pre-peeled, so the `vN^{}` instruction
   goes. `upgrade --to vN` from a hand clone stays second.
4. **README**, *Using bessemer in your repo*: drop `gh auth setup-git` from the prerequisites; the
   release lookup becomes the `gh api` command above (still printing the highest `v<N>`, or nothing,
   with no literal tag); the clone becomes
   `gh repo clone HireAnEsquire/bessemer "$clone" -- --depth 1 --branch "v$latest"`; §5's manual
   remedy mirrors the refusal.

**The environment allowlist does not change.** The pair is argv; git spawns the helper with the
`HOME` and `PATH` already forwarded. Adding `GH_TOKEN`, `GH_HOST`, or `GH_CONFIG_DIR` is a second
route to a credential (T23).

### The shim template

`v1` shipped shim template v2. **Before editing `templates/bessemer`, copy its current text to
`test/fixtures/shim/bessemer.v2`** (unstamped, exactly as the template holds it — the fixture
README says how). Then bump `TEMPLATE_VERSIONS.bessemer` to 3. The F18 contract test then runs both.

### Tests

- F19's mirror rewrite bypasses any helper, so the existing cold-path cases stand.
- **A fake `gh`** on the child's `PATH`, a script that answers `auth git-credential get` from a
  canned credential and logs its argv: pins that the pair is passed and that the fake is asked.
  A case with **no `gh` on the `PATH`** still builds the entry.
- The same two cases for `readRemoteReleases`, through the chokepoint.
- `test/shim.test.ts`'s refusal case that asserts `git ls-remote --tags` and `vN^{}` moves to the
  `gh api` wording.

## Effect wiring

- **Tags introduced or consumed**: none new. `releases.ts` keeps its existing `CommandExecutor`
  requirement.
- **Layer composition**: unchanged.

## Acceptance criteria

- [ ] `test/fixtures/shim/bessemer.v2` holds v1's shim text byte for byte; `TEMPLATE_VERSIONS.bessemer`
      is 3.
- [ ] The shim's fetch and `readRemoteReleases` pass the pair when gh is present and fall back to
      the plain call when it is absent or fails; a refusal names both attempts.
- [ ] No change to the env allowlist, and no `gh auth token` anywhere.
- [ ] The refusal text, `pin.ts`, and the README name the `gh api … /tags` command; the README no
      longer names `gh auth setup-git` as a prerequisite.

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package.

Host-only, on a host whose gh reports `Git operations protocol: ssh` and whose git has no
github.com helper: the README's release lookup and bootstrap clone as printed; then, in a scratch
served repo, the shim's cold path with an empty `XDG_CACHE_HOME`; then `git config --global
--get-regexp credential` prints nothing new.
