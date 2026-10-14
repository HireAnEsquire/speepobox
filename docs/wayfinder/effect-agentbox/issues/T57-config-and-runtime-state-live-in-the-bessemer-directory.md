# T57 — Config and runtime state live in the bessemer directory

Status: Done (PR #17; the ticket's "root `.gitignore` drops the six entries" is wrong for `.env` and
it was kept — `resolveCredential` still read `<repoRoot>/.env` until T58, so dropping the entry
would have left a live token file unignored in exactly the gap 19 §3 orders closed)
Type: AFK
Blocked by: [T56](T56-the-package-roots-at-the-repo.md). This ticket is written against the rooted
tree: `packageRoot` is the repo root, `config.toml` sits at the root, and the guard's not-source
list already declares it.

<!--
[Ticket 18](../18-where-the-package-lives-and-what-it-is-called.md)'s step 3 ("the root rulings"),
§2, with [19](../19-the-tool-serves-a-repo-it-does-not-live-in.md) §2 and the consequence 19 §8
names: "config loading takes `repoRoot` as a parameter. The runtime-root default
`<repoRoot>/.bessemer` depends on the served repo, so it stops being a constant in `defaultConfig`."

This is the anchor 18 found: `defaultConfig.runtimeRoot = packageRoot` (`config.ts:81`) was the one
line that made the manifest's three acts look like one switchover. Cut it, and rooting (T56), the
roots (this and T58–T60), and the name (T63) stop holding each other up. It is also the two roots
19's table missed: the config search root (`config.ts:153` — under the shim an adopter can
configure nothing, because the chain looks under the package) and the runtime root (probe finding
6 — one shim cache accumulates every adopter's checkouts and ledger, and a repin carries them off).

Three pieces: the loader and layers take `repoRoot`; this repo's own layout moves into `.bessemer/`;
SPEC §6 says so. The credential (T58) and the prompt override (T59) are the same kind of move and
are their own tickets.
-->

## What to build

**Everything bessemer reads from or writes to a served repo lives in `<repoRoot>/.bessemer/`, and
the code finds that directory from the served repo it was handed — never from its own location.**
`CONTEXT.md` already defines the term (*bessemer directory*) and the two kinds of location; this
ticket makes the code match it for config and for runtime state.

### One derivation, in the pure module

`src/config/paths.ts` gains `BESSEMER_DIRNAME = ".bessemer"` and
`bessemerDir(repoRoot: string): string` — `join(repoRoot, BESSEMER_DIRNAME)`. Every reader below
takes the directory from this function; nothing spells `.bessemer` twice.

### Config is found under the served repo

`configProviderChain` reads `sources?.root ?? packageRoot` (`config.ts:153`). The default becomes
`bessemerDir(repoRoot)`, and `repoRoot` arrives as a parameter: `loadConfig(repoRoot, sources?)` and
`configProviderChain(repoRoot, sources?)`. `sources.root` may stay as the test-only override the
config tests already use, or the tests may write their fixtures under `<tmp>/.bessemer/` and drop
it — either is fine, provided nothing in `src/` passes `root`.

The files are `config.toml` and `config.local.toml` under that directory, unchanged in name and
format. Precedence is unchanged.

### The runtime root defaults to the same directory, and a relative one resolves against the repo

`defaultConfig.runtimeRoot` (`config.ts:81`) stops existing as a constant. The shape:

- `defaultConfig` keeps every field but `runtimeRoot` — its type becomes the config shape minus that
  key — so the tests that spread it (`{ ...defaultConfig, runtimeRoot: X }` — twenty-two test files
  reference it) keep typechecking. Tests that used it bare as a whole config take `defaultConfigFor(repoRoot)`.
- `defaultConfigFor(repoRoot): AgentboxConfigShape` adds `runtimeRoot: bessemerDir(repoRoot)`. It is
  also what the tolerant layer degrades to on a failed decode.
- The descriptor is built per root — `descriptorFor(repoRoot)` — so `runtime-root`'s `withDefault`
  reads `bessemerDir(repoRoot)`, and a configured value that is relative resolves against
  `repoRoot` (absolute taken as-is). Today a relative `runtime-root` is used unresolved, which
  means "against the working directory", and 19 §1 retired the working directory from every
  answer this tool gives. `resolveTasksDir` is the precedent; `resolveRuntimeRoot(repoRoot, value)`
  beside it in `paths.ts` is the shape.

`config.ts` then imports nothing from `paths.ts` but `bessemerDir` and `resolveRuntimeRoot` — **its
`packageRoot` import is gone**, which is one of the four T62's ban needs retired.

### The layers take the served repo

`AgentboxConfigLive` is a constant layer over `loadConfig()`; it becomes
`agentboxConfigLiveFor(repoRoot)`. The tolerant layer in `app.ts` becomes
`agentboxConfigTolerantLiveFor(repoRoot)`. The three compositions follow: `appLiveFor(repoRoot)`,
`appBaseLiveFor(repoRoot)`, `appDryRunLiveFor(repoRoot)`, and `appLayerFor(argv)` becomes
`appLayerFor(argv, repoRoot)`. `bin.ts` already holds `repoRoot` at the top of `main` and passes it
to each. `doctor.ts` calls `loadConfig()` directly for probe 7; it passes `host.repoRoot`.

AGENTS.md's T27 paragraph rejects `GitLive(repoRoot)` — "a host fact inside a layer `status`
composes without ever asking git anything". That objection does not reach here: the config layer
*already* reads the host filesystem at a root, every command that composes it reads the config it
decodes, and the root it reads at is a fact about the served repo, which is the whole point. Say so
in one sentence beside the layer, so the next reader does not take T27 as forbidding this.

### `doctor`'s runtime-root row

`runtimeRootProbe` renders `<dir> is not writable — … fix its permissions` for a directory that does
not exist as well as one that cannot be written. `.bessemer/` exists in this repo once
`config.toml` is committed there, but an adopter's may not; tell the two apart in the row's detail
(missing — `mkdir` it; present but unwritable — permissions). `run-log.ts` and `run-lock.ts` create
their own subdirectories, `git clone` creates the checkout's, `reconcile.ts` treats a missing
directory as "not dispatched yet"; the ledger appends to `<runtimeRoot>/runs.jsonl` directly, which
is fine once the directory exists. Nothing else needs a `mkdir`.

### This repo's own layout

The same layout, because self-hosting is not a special case (19 §2):

- `git mv config.toml .bessemer/config.toml`. Its trailing comment ("Runtime root intentionally NOT
  set here … flipped at switchover") is replaced by the fact: not set, so it defaults to this
  directory; set it only to move *writes* somewhere else. Its header's ".env beside this file" and
  `CREDENTIAL_ADVICE`'s "beside config.toml" stay true as written — T58 moves the read.
- `.bessemer/.gitignore`, committed, ignoring `config.local.toml`, `.env`, `logs/`, `locks/`,
  `checkouts/`, `runs.jsonl` — with a comment naming each as the operator's private settings, the
  credential, or runtime state. **This file must exist before T58 lands**: 19 §3 orders the
  operator's `.env` move after it, so that no `git add -A` in the gap can commit a token.
- The root `.gitignore` keeps `node_modules/` and drops the six entries above.
- T49's guard: `.bessemer` replaces `config.toml` in the not-source list. There is no top-level
  `config.toml` any more, so leaving the old entry is harmless but wrong; the guard fails a slice
  that forgets the new one.
- `test/config.test.ts`'s `defaults` block, both cases:
  - *"the runtime root defaults to the package's own root, not `.agentbox/`"* asserts
    `config.runtimeRoot === packageRoot` **and** `config.runtimeRoot === findRepoRoot(packageRoot)`
    — T56 replaced the old `packageRoot.endsWith("bessemer")` line with the second of those, so
    there is no `endsWith` left to drop. **This ticket falsifies both**: it is the test that pins
    the line being cut. Rewrite it as the new ruling — with no `runtime-root` declared,
    `runtimeRoot` is `bessemerDir(repoRoot)`, a directory *inside* the repo root and equal to
    neither. The test's name states the old ruling and goes with it.
  - *"the committed config.toml travels with the repo and carries the tool SHA key"* reads the
    committed file by path (`join(packageRoot, "config.toml")`) and copies it into a temp root;
    that path becomes `.bessemer/config.toml` under the repo root. Change only that path. The rest
    of the case still holds: its image-tag assertion reaches `image/build-image.sh` through
    `config.imageBuildCommand`, which stays relative to the repo root; the `resolveTasksDir` block
    T56 added asserts `tasks-dir` resolves to `<repoRoot>/tasks`, which this ticket does not move;
    and `findRepoRoot(packageRoot)` is a package read this ticket leaves alone.
- `setup-hook.sh`'s header comment names `config.toml` after T56; it names `.bessemer/config.toml`
  now. T63's sweep matches `bessemer`, so a stale path here would outlive it.

### SPEC §6

Replace the paragraph *"Runtime-root default (05 Q19)"* with the ruling: config is
`<repoRoot>/.bessemer/config.toml` and `config.local.toml`, secrets in `.bessemer/.env` (T58 makes
the code read it), the runtime root defaults to `.bessemer/` and takes `repoRoot`, a relative
`runtime-root` resolves against the repo, and the search root is the served repo's — never the
package's, because under the shim the package is a cache clone every served repo shares. The
sentence *"During incubation, point it at the package's own root"* is what this ticket deletes.

### After it merges (operator, on the host — not this pass)

Move runtime state once: `mv logs locks checkouts runs.jsonl .bessemer/` (or from the repo root if
they were left there after T56). `.env` stays at the root until T58.

## Effect wiring

- **Tags introduced or consumed**: `AgentboxConfig`, unchanged in shape. No new tag: the served repo
  is a parameter of the layer, as `appLayerFor(argv)` already takes argv.
- **Layer composition** — what `app.ts` ends up with, types as today:

```ts
const agentboxConfigTolerantLiveFor = (repoRoot: string) =>
  Layer.effect(
    AgentboxConfig,
    loadConfig(repoRoot).pipe(Effect.orElseSucceed(() => defaultConfigFor(repoRoot))),
  );

export const appBaseLiveFor = (repoRoot: string) =>
  Layer.provideMerge(
    Layer.mergeAll(LedgerLive, GitLive),
    Layer.provideMerge(agentboxConfigTolerantLiveFor(repoRoot), PlatformAndReporterLive),
  );

export const appLiveFor = (repoRoot: string) =>
  Layer.provideMerge(
    AgentCliLive,
    Layer.provideMerge(
      Layer.mergeAll(SandboxLive, GitLive, RunLockLive, ForgeLive, NotifierLive, PromptSourceLive),
      Layer.provideMerge(
        LedgerLive,
        Layer.provideMerge(agentboxConfigLiveFor(repoRoot), PlatformAndReporterLive),
      ),
    ),
  );
```

`appDryRunLiveFor(repoRoot)` is the same expression as `appLiveFor` with the recording layers in
place of the mutating ones, exactly as `AppDryRunLive` is today. `bin.ts`:

```ts
case "status":
  return status({ repoRoot }).pipe(Effect.provide(appBaseLiveFor(repoRoot)));
case "doctor":
  return doctor({ nodeVersion: process.versions.node, repoRoot }).pipe(
    /* unchanged */
    Effect.provide(appBaseLiveFor(repoRoot)),
  );
default:
  /* unchanged */ Effect.provide(appLayerFor(argv, repoRoot)),
```

## Acceptance criteria

- [ ] With `repoRoot` a temporary directory holding `.bessemer/config.toml`, `loadConfig(repoRoot)`
      decodes it; the same file at `<repoRoot>/config.toml` or under `packageRoot` is not read.
- [ ] A config naming no `runtime-root` decodes `runtimeRoot` as `<repoRoot>/.bessemer`; a relative
      value resolves against `repoRoot`; an absolute value is taken as-is.
- [ ] `doctor` on this repo: probe 7 ok, and probe 9 names `<repoRoot>/.bessemer` as writable; a
      missing runtime root and an unwritable one render different advice.
- [ ] A dry run's plan shows the checkout path and the log path under `<repoRoot>/.bessemer/`, and
      the rehearsal's real log file lands there.
- [ ] `git check-ignore` accepts `.bessemer/.env`, `.bessemer/config.local.toml`, and a file under
      each of `.bessemer/logs/`, `locks/`, `checkouts/`; `.bessemer/config.toml` and
      `.bessemer/.gitignore` are tracked.
- [ ] The guard declares `.bessemer` not-source and the suite fails if that declaration is removed.
- [ ] `src/config/config.ts` no longer imports `packageRoot`.
- [ ] SPEC §6 is amended as above.
- [ ] The suite passes.

## Verify

```
npm run verify
```

Run from the repo root — the package has sat there since T56. This is the gate — typecheck (with
Effect diagnostics: **errors and warnings break the build**, suggestions print), lint, and tests.
`pre-commit` is not a substitute and does not check this package.
