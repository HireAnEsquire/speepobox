# T60 — A dispatch names the repo it serves, and freshness knows when it is self-hosted

Status: Done (PR #21; the ticket asks for `path.resolve` only around the `selfHosted` predicate, and
review found `repoScope` (`src/ownership/labels.ts:28`) hashes the root as spelled — so
`--repo-root /srv/hae/` would label a dispatch's containers under a scope the same repo's `status`
and reconciler then filter past, a live run reported as nothing running. Fixed in `abff695`, with
`staleDispatcherOverridden` written straight off the flag in `faf71f5`)
Type: AFK
Blocked by: [T56](T56-the-package-roots-at-the-repo.md). Nothing in T57–T59 gates it, but it edits
`bin.ts` and `doctor.ts` alongside them, so dispatching it after T58 saves a merge.

<!--
[Ticket 19](../19-the-tool-serves-a-repo-it-does-not-live-in.md) §1 and §4, together because the
second is only observable through the first.

§1: "An explicit `--repo-root <dir>`, which the committed shim always passes, computed from its own
location … peeled off at the composition root (`bin.ts`) **before** the `argv[0]` switch, because
`status` and `doctor` never reach `@effect/cli` parsing. With no flag the fallback is
`findRepoRoot(packageRoot)` — the self-hosted case — so this repo needs no change." Rejected there:
walking up from the working directory (AGENTS.md: "the point is that the working directory stopped
mattering"), an `AGENTBOX_*` variable (the config provider's namespace), and a config key (config is
found *through* the repo root).

§4: pointed at hae, the freshness pathspec renders `../bessemer/speepobox/src` and git exits 128 —
read as `BaseUnresolvable`, so every adopter dispatch and `doctor` probe 10 print a false "git
fetch" warning. "Freshness applies only when self-hosted: `findRepoRoot(packageRoot) === repoRoot`.
The composition root decides the predicate once and passes it down as a value, so the preflight and
`doctor` cannot disagree." `packageRoot === repoRoot` was considered and rejected — it would skip a
committed nested copy, whose revision really is chosen by the served repo's branch.
-->

## What to build

**The served repo is named once, by `--repo-root`, at the composition root; whether this dispatch
is self-hosted is decided there too and travels as a value; and the freshness question is asked
only when it is.**

### `--repo-root`, peeled before anything else

A pure function in a new module `src/config/served-repo.ts` — `peelRepoRoot(argv)` — returns the
flag's value as an `Option` and the argv with the flag removed. Both spellings, `--repo-root <dir>`
and `--repo-root=<dir>`. A relative value is refused: resolving it would read the working directory,
which 19 §1 retired; the refusal is one line on stderr and exit 1, in the shape `reportFailure`
already gives. A value is taken as given — nothing walks up from it, because nothing infers the
served repo (19 §1).

`bin.ts`'s `main` calls it first, before the `argv[0]` switch: `repoRoot` is the flag's value or
`findRepoRoot(packageRoot)`, and the peeled argv is what the switch and `dispatchCli` see. `status`
and `doctor` therefore take it too — `bessemer --repo-root /srv/hae status` scopes by `/srv/hae`.
The usage block documents the flag with one line: the repo this invocation serves; the committed
shim passes it; without it, the repo the package lives in.

`bin.ts` runs the CLI on import and cannot be asserted from a test, which is why the peel is a
function in its own module: the module is tested, and `bin.ts` calls it in one line.

### Self-hosted, decided once

`selfHosted = resolve(findRepoRoot(packageRoot)) === resolve(repoRoot)` — `path.resolve` on both
sides so a trailing slash or a `..` segment in the flag's value does not make two spellings of one
directory look like two directories (`resolve` reads nothing for an absolute path). Computed in
`bin.ts` beside `repoRoot`, passed as a boolean to `doctor` (a new `DoctorHost` field) and to
`dispatchCli` (a new parameter, threaded to `dispatch` and `preflight` like `allowStaleDispatcher`).

Record 19 §4's caveat in a comment beside the predicate, so it is not rediscovered: if 01's fallback
(a bundled `npm publish`) is ever taken, a copy under `node_modules` would walk up to the served
repo's `.git` and this predicate has to be revisited then.

### The preflight

`preflight` runs the freshness block only when `selfHosted`. When not: no `rev-list`, no `Warned`,
no refusal — under the shim the dispatcher is a pinned SHA and no branch chooses it (09), so there
is nothing to be stale relative to. `--allow-stale-dispatcher` on a non-self-hosted dispatch has
nothing to override and does nothing; its help text can say so in a clause.

The ledger row's `dispatcher.revision` and `dirty` (T43) are untouched: they are read from the repo
enclosing `packageRoot`, which is the right repo in both cases.

### `doctor` probe 10

When not self-hosted, probe 10 emits one `ok` row: `not applicable — dispatcher pinned at <sha>`,
where the sha is the dispatcher's own revision (T43's `resolveDispatcherRevision`, which `bin.ts`
today resolves for the dispatch surface only). Resolve it for `doctor` too and pass it in
`DoctorHost` as the `Option` it already is; `None` renders `revision unknown` in the same row rather
than failing. No `rev-list` is spent. When self-hosted, the probe is exactly as today.

`bin.ts`'s comment on the dispatcher revision — "the two happen to be the same directory during
incubation … staying off that coincidence" — is rewritten around `selfHosted`, which is now the
name for that coincidence.

### SPEC §7 and AGENTS.md

- SPEC §7's flags table gains `--repo-root`; the paragraph on `status`/`doctor` being intercepted
  before parsing says the peel precedes the switch. The probes table lists nine; add row 10
  (dispatcher freshness, T42) if T42 left it out, with its two arms: self-hosted asks the question;
  otherwise `not applicable — dispatcher pinned at <sha>`.
- `AGENTS.md`, *Host reads live at the composition root*: `--repo-root` is the one argv read that
  precedes parsing, and `selfHosted` is decided there and never re-derived below.

## Effect wiring

- **Tags introduced or consumed**: none. The peel and the predicate are plain functions; the two
  values travel as parameters.
- **Layer composition**: unchanged. `appLayerFor(argv, repoRoot)` (T57) receives the peeled argv.
  `resolveDispatcherRevision` needs only a `CommandExecutor`, which `appBaseLiveFor` already
  provides, so `doctor`'s new input costs no layer change.

## Acceptance criteria

- [ ] `peelRepoRoot(["--repo-root", "/x", "doctor"])` yields `/x` and `["doctor"]`; the `=` spelling
      does the same; with no flag the argv is untouched and the value is `None`; a relative value is
      refused with one line and exit 1.
- [ ] `doctor` with `selfHosted: false` prints probe 10 as `ok` naming the pinned revision and runs
      no `rev-list`; with `selfHosted: true` its three arms are as today.
- [ ] A rehearsal with `selfHosted: false` runs no freshness check — no `rev-list`, no warning, no
      refusal, even when a scripted git would answer `Stale`; with `selfHosted: true` T44's refusal
      and T44's override are unchanged.
- [ ] `status` and `doctor` take the peeled root: the ownership scope and every probe that names a
      repo name the flag's value.
- [ ] The usage block documents `--repo-root`; SPEC §7 and AGENTS.md are amended as above.
- [ ] The suite passes.

## Verify

```
npm run verify
```

Run from the repo root — the package has sat there since T56. This is the gate — typecheck (with
Effect diagnostics: **errors and warnings break the build**, suggestions print), lint, and tests.
`pre-commit` is not a substitute and does not check this package.
