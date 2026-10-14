# T130 — The adopter README

Status: Done (PR #92. README only. Latest-release pipeline checked against synthetic tags — picks v10 over v9, drops `v01`, `v3.1`, `^{}` — and against the real remote, which has no tags yet and prints nothing.)
Type: AFK
Blocked by: [T126](T126-the-shim-builds-the-package-cache.md) — the cache the README documents; [T127](T127-init-installs-the-shim.md) — the shim `init` writes; [T128](T128-bessemer-upgrade.md) — `upgrade`; [T129](T129-doctors-upstream-row.md) — the upstream row.

<!--
P6, ruled 2026-10-02 (09's comment of that date, F5 and F21; F4 for the credential). Terms:
**adopter**, **shim**, **pin**, **release**, **package cache** (CONTEXT.md). An adopter's first
install runs this README literally, so every command in it is one an adopter types as printed.
-->

## What to build

`README.md` gains the adopter's path. Today it describes this repo only; the self-hosted text
stays, below the adopter's.

1. **Prerequisites** (F21), on the dispatching host: node ≥ 26, docker, `gh auth login`, and `gh
   auth setup-git` — the shim clones a private repository through the operator's own git
   credential (F4), and adopters are members of the org. The task container needs no node (04).
2. **The bootstrap** (F5): clone the package at the **latest release**, `npm ci`, then
   `node <clone>/src/bin.ts init --repo-root "$PWD"` from the served repo's root. The README gives
   a command that **finds** the latest release — from `git ls-remote --tags` over the release URL,
   the highest `^v[1-9][0-9]*$` — and never a literal tag name. The clone's revision becomes the
   pin, and the hand clone can be deleted afterwards: from then on every command goes through the
   shim.
3. **The shim** (F2): every command is `.bessemer/bessemer …`, committed with the rest of
   `.bessemer/`. Nothing goes on the `PATH`. The first run on a host prepares the package cache and
   is slow; later runs are not.
4. **`upgrade`** (F13): `.bessemer/bessemer upgrade` to the newest release, `--to vN` for a named
   one or a rollback, then the `init --diff` it prints, and how to refresh a file `--diff` reports
   behind — the shim included — as T127's `--diff` prints it. `doctor`'s upstream row is where a
   new release shows up (F14).
5. **When the pin cannot be fetched**: the shim's empty and short refusals and their two remedies
   (F6, amended), in the README's words.
6. **The package cache** (F9, F10): where it is, `${XDG_CACHE_HOME:-$HOME/.cache}/bessemer/`, that
   it is shared by every served repo on the host and never pruned, that `gc` does not touch it, and
   that `rm -rf` of it (or of one `<sha>/`) is always safe — the next run rebuilds.

No Renovate (F21): it is untested against a private repo's tags, and `doctor` with `upgrade`
already does the job.

## Effect wiring

None: documentation only.

## Acceptance criteria

- [ ] The six sections above are in `README.md`, in the adopter's order, and every command is
      spelled as an adopter types it.
- [ ] The latest-release command contains no literal tag name, and on the host against the real
      remote it prints the highest `v<N>` (or nothing, before `v1`) and ignores the other tags.
- [ ] No mention of Renovate.

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package.

Host-only: the latest-release command against `https://github.com/HireAnEsquire/bessemer.git`.
