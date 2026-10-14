# T122 — Releases are a value

Status: Done (PR #85. src/git/releases.ts: the remote read asks origin, so TS holds no copy of the URL.)
Type: AFK
Blocked by: None — can start immediately.

<!--
P6, ruled 2026-10-02 (09's comment of that date, F11, F13, F15, F16). Terms: **release**, **pin**,
**package cache** (CONTEXT.md). Prefactor: its own green without a caller. Callers are T124
(`init`'s no-release warning), T128 (`upgrade`), and T129 (`doctor`'s upstream row), which share
this one reading of the release list.
-->

## What to build

What a release is, read the one way all three callers read it.

### The pure half

- **Which tags are releases** (F11): only names matching `^v[1-9][0-9]*$`. `v0`, `v01`, `v1.2`,
  `bessemer-port-source`, and `clack-picker-prototype` are ignored without comment.
- **Parsing `git ls-remote --tags` output** (F13) into releases: a tag name, its number, and its
  commit. The commit comes from the peeled `refs/tags/vN^{}` line, or from the bare `refs/tags/vN`
  line when there is no peeled one (a lightweight tag's line already names the commit). Non-release
  tags and their peeled lines are dropped.
- **What a pin is, against that list**: the release a full SHA is, or none. A commit carrying two
  releases counts as the **higher** number.
- **The move decision** `upgrade` (T128) makes, as a value: for a pin that is `vK` and a latest
  `vN`, *move to vN* when N > K and *current* when N = K. An untagged pin is its own answer. The
  comparison is **tag numbers, never ancestry** — the package cache entry is a depth-1 clone with no
  history to ask (F13).

### The read

`git ls-remote --tags origin`, run **in the package's own repo** — under the shim that is the
package cache entry, whose `origin` is the release URL (SPEC §6's contract, item 4), so TS holds no
second copy of the URL. It is a plain module beside `src/git/dispatcher-revision.ts`, **not** an
operation on `Git`: like that module and `dispatcher-freshness.ts`, it asks about the tool's own
source, not about a served repo. It takes `packageRepoRoot` as a parameter from `bin.ts`, which
already computes it (`findRepoRoot(packageRoot)`); `doctor.ts` may not import `packageRoot`
(SPEC §9), and this keeps the module from needing to.

- **10 s timeout** (F15), as `Effect.timeoutFail` over the chokepoint call, so the interrupt kills
  the child.
- **`GIT_TERMINAL_PROMPT=0` as a per-call constant** (F15), handed to that one child through
  `execUnder`'s `ChildVar`, the way T77 hands `GIT_INDEX_FILE`. The allowlist does not change: it
  already forwards `HOME` and `PATH`, which is how a private origin is reached today.
- **A timeout or a non-zero git** is a typed failure carrying git's own line (or *timed out after
  10 s*). What it means is the caller's: an `ok` row in `doctor`, a refusal in `upgrade`.

Also a second, **offline** read for T124: the releases among `git tag --points-at HEAD` in the
package's repo, through the same release predicate.

## Effect wiring

- **Tags introduced or consumed**: none new. `CommandExecutor` through `internal/exec.ts`.
- **Layer composition**: unchanged; nothing calls it yet.

## Acceptance criteria

- [ ] The predicate accepts `v1`, `v2`, `v10`, and refuses `v0`, `v01`, `v1.2`, `V1`,
      `bessemer-port-source` (test).
- [ ] A fixture `ls-remote` output with an annotated tag, a lightweight tag, a non-release tag, and
      two release tags on one commit parses to the expected releases, the commit taken from the
      peeled line where there is one (test).
- [ ] Two releases on one commit: the pin is the higher (test).
- [ ] The move decision answers *move*, *current*, and *untagged* for the three cases (test).
- [ ] The read, against a local bare repo with tags set as `origin` of a temp clone (no network),
      returns its releases; against an `origin` that does not exist it fails carrying git's line;
      the child it spawns has `GIT_TERMINAL_PROMPT=0` (test).
- [ ] The offline read finds a release on `HEAD` and none on an untagged `HEAD` (test).

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package.
