# Research: Effect's surface for a subprocess/resource orchestrator

Ticket: [02-effect-surface-for-this-tool.md](../02-effect-surface-for-this-tool.md)
Map: [MAP.md](../MAP.md)
Researched: 2026-07-29

## Versions everything below is verified against

| Package | Version | Source |
| --- | --- | --- |
| `effect` | **3.22.0** (`latest`) | [registry.npmjs.org/effect/latest](https://registry.npmjs.org/effect/latest) |
| `effect` | **4.0.0-beta.102** (`beta`) | [dist-tags](https://registry.npmjs.org/-/package/effect/dist-tags) |
| `@effect/cli` | **0.76.0** | [registry.npmjs.org/@effect/cli](https://registry.npmjs.org/@effect/cli) |

**Read this first.** The Effect monorepo's `main` branch is now the 4.0 rewrite. The 3.x line
that ships as `effect@latest` lives on the **`v3` branch**. Every source link below is pinned to
`v3` deliberately; a link to `main` describes software you cannot install as `latest` today.

Evidence: `packages/` on `main` contains only `ai, atom, effect, opentelemetry, platform-browser,
platform-bun, platform-deno, platform-node-shared, platform-node, sql, tools, vitest`
([API listing](https://api.github.com/repos/Effect-TS/effect/contents/packages)) — **no `cli`,
no `platform`, no `printer`, no `rpc`, no `cluster`**. The same path on `v3` contains all of them
([API listing](https://api.github.com/repos/Effect-TS/effect/contents/packages?ref=v3)). The
branch list also shows dozens of `archive/effect-smol/*` branches, the codename of the 4.0
rewrite, now merged into `main`.

---

## Claim 1 — Scope / acquireRelease across this tool's real failure modes

### Verdict

**Substantially true, with four named gaps — one of which this tool will hit on day one.**

Effect's finalizer guarantee is real and stronger than `trap`-based bash. But it is a guarantee
about *the Effect fiber*, and it holds only when the process is given a chance to run its
teardown. Three of the four gaps are outside Effect's control; one is a documented, still-open
defect in `@effect/platform`'s own child-process handling.

### What the guarantee actually is

`Effect.acquireRelease(acquire, release)` returns `Effect<A, E, Scope>`. Acquisition runs
uninterruptibly; release is registered on the enclosing `Scope` and runs when that scope closes,
in reverse registration order, receiving the `Exit` that closed it. The docs state the guarantee
without qualification: "The `Effect.acquireRelease` function guarantees that once a resource is
successfully acquired, its release step is always executed when the `Scope` is closed", and
finalizers run on success, failure **and interruption**
([Scope docs](https://effect.website/docs/resource-management/scope/)).

`Effect.onExit` and `Effect.onError` cleanups are explicitly **uninterruptible** — "the cleanup
step itself is uninterruptible … it always finishes once it starts"
([Resource management](https://effect.website/docs/resource-management/introduction/)). So a
second interrupt arriving mid-teardown does not abort the teardown *at the Effect level*.

Structured concurrency carries this down: child fibers' lifetimes are tied to their parent, and
"interrupting a parent automatically terminates supervised children"
([Fibers](https://effect.website/docs/concurrency/fibers/)). Interruption is asynchronous
(no polling) and `Fiber.interrupt` back-pressures — it "waits until the fiber has fully
terminated before resuming", i.e. it waits for finalizers.

The shape for this tool:

```ts
const checkout = (repo: string, branch: string) =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const dir = yield* makeTempDir(`agentbox-${branch}`)
      yield* Command.make("git", "clone", "--depth", "1", repo, dir).pipe(Command.exitCode)
      return dir
    }),
    (dir) => fs.remove(dir, { recursive: true }).pipe(Effect.ignoreLogged)
  )

const container = (image: string, name: string) =>
  Effect.acquireRelease(
    Command.make("docker", "run", "-d", "--name", name, image).pipe(Command.string),
    () => Command.make("docker", "rm", "-f", name).pipe(Command.exitCode, Effect.ignoreLogged)
  )

const dispatch = Effect.gen(function* () {
  const dir = yield* checkout(repo, branch)      // released last
  const id  = yield* container(image, name)      // released first
  yield* implementPass(id, dir)
  yield* reviewLoop(id, dir)
  yield* pushBranch(dir, branch)
}).pipe(Effect.scoped)
```

Reverse-order release means the container is torn down before the checkout directory it bind-mounts
is deleted. That ordering is free and is exactly the thing `set -e` + `trap` gets wrong.

### Where the signals actually come from

Signal handling is **not** in `effect` core. It lives in one small function that only runs if you
use `NodeRuntime.runMain`. Full current source
([v3 `platform-node-shared/src/internal/runtime.ts`](https://raw.githubusercontent.com/Effect-TS/effect/v3/packages/platform-node-shared/src/internal/runtime.ts)):

```ts
export const runMain = makeRunMain(({ fiber, teardown }) => {
  const keepAlive = setInterval(constVoid, 2 ** 31 - 1)
  let receivedSignal = false

  fiber.addObserver((exit) => {
    if (!receivedSignal) {
      process.removeListener("SIGINT", onSigint)
      process.removeListener("SIGTERM", onSigint)
    }
    clearInterval(keepAlive)
    teardown(exit, (code) => {
      if (receivedSignal || code !== 0) { process.exit(code) }
    })
  })

  function onSigint() {
    receivedSignal = true
    process.removeListener("SIGINT", onSigint)
    process.removeListener("SIGTERM", onSigint)
    fiber.unsafeInterruptAsFork(fiber.id())
  }

  process.on("SIGINT", onSigint)
  process.on("SIGTERM", onSigint)
})
```

Everything about Claim 1's signal story is visible in those 25 lines. Read them as the contract.

### The four gaps, honestly

**Gap 1 — only SIGINT and SIGTERM are handled.** No `SIGHUP`. Close the terminal, drop an SSH
session, or have a `tmux`/CI runner tear down its pty, and Node's default SIGHUP disposition
terminates the process with no interruption, no finalizers, and a live container. For an *AFK*
dispatch tool that is the normal way a long run ends. Mitigation is one line in a custom
`makeRunMain`, or a `process.on("SIGHUP", …)` alongside — but you have to write it, and no
tutorial tells you to. `SIGKILL` is unblockable by definition; `SIGQUIT` is likewise unhandled.

**Gap 2 — the second Ctrl-C is a hard kill.** `onSigint` removes both listeners before
interrupting. Once removed, Node restores the default disposition, so a second `Ctrl-C` while the
teardown is still running (`docker rm -f` on a big container, a slow `rm -rf`) terminates
immediately and abandons the remaining finalizers. This is a deliberate escape hatch and it is the
right default for most programs — but for this tool an impatient double-tap is precisely how a
container leaks. It is also invisible: nothing logs "teardown abandoned".

**Gap 3 — `runMain` is opt-in, and the ergonomic path avoids it.** `Effect.runPromise` /
`runSync` / `ManagedRuntime` install *no* signal handlers at all. Any script, test harness, or
`node -e` entry point that reaches for `runPromise` silently loses the entire interrupt story
while still type-checking identically. The `Scope` in the type signature does not tell you whether
anyone will ever close it under a signal.

**Gap 4 — the one that bites: child processes survive SIGINT.**
[Effect-TS/effect#5592, "Command processes survive SIGINT when parent exits"](https://github.com/Effect-TS/effect/issues/5592)
(opened 2025-10-01, reported against `effect@3.18.0` / `@effect/platform-node@0.98.0`) reports
children spawned via `Command` surviving as orphans with `PPID=1`, still holding TCP ports. The
reporter's own root-cause analysis names `detached: true` plus a release handler that only kills
the process group on non-zero exit codes.

The current `v3` source
([`platform-node-shared/src/internal/commandExecutor.ts`](https://raw.githubusercontent.com/Effect-TS/effect/v3/packages/platform-node-shared/src/internal/commandExecutor.ts))
shows both the spawn options and the finalizer:

```ts
// spawn options
{
  stdio: [...],
  cwd: Option.getOrElse(command.cwd, constUndefined),
  shell: command.shell,
  env: command.extendEnv
    ? { ...process.env, ...Object.fromEntries(command.env) }
    : Object.fromEntries(command.env),
  detached: process.platform !== "win32"
}

// finalizer
Effect.acquireRelease(spawn, ([handle, exitCode]) =>
  Effect.flatMap(Deferred.isDone(exitCode), (done) => {
    if (!done) {
      return killProcessGroup(handle, "SIGTERM").pipe(
        Effect.orElse(() => killProcess(handle, "SIGTERM")),
        Effect.zipRight(Deferred.await(exitCode)),
        Effect.ignore
      )
    }
    return Effect.flatMap(Deferred.await(exitCode), ([code]) => {
      if (code !== 0 && code !== null) {
        return killProcessGroup(handle, "SIGTERM").pipe(Effect.ignore)
      }
      return Effect.void
    })
  })
)
```

Three things follow, and they matter more than the issue's open/closed state:

1. **The still-running branch is correct and load-bearing.** It group-kills with `SIGTERM`, falls
   back to a direct kill, and — crucially — `Deferred.await(exitCode)` afterwards, so scope
   closure genuinely blocks until the child is reaped. That is a real guarantee.
2. **The already-exited branch still skips group cleanup when `code === null`.** `code === null`
   is exactly the signal-terminated case. A child that died to a signal leaves its process group
   un-reaped — grandchildren survive. This is #5592's residual, present in the `v3` HEAD source
   at the time of writing. I could not find a merged fix; treat "closed" as unconfirmed-as-fixed.
3. **`detached: process.platform !== "win32"` means the child is in its own process group,** so it
   does *not* receive the terminal's `Ctrl-C`. On a normal shell, `Ctrl-C` goes to the foreground
   process group; a detached child is in a different one. The child therefore dies **only** if the
   finalizer runs. Gaps 1–3 above are not theoretical for children — they are the sole mechanism.

**And a gap that is not Effect's fault but is fatal to the framing.** A Docker container is not
owned by the child process. `docker run` is a *client*; the container is a resource of `dockerd`.
Killing the `docker` client — by group kill, by SIGTERM, by anything — does not necessarily stop
the container, and for `docker run -d` it certainly does not. **Container teardown can never be
inherited from process-kill semantics.** It requires its own `acquireRelease` whose release shells
out to `docker rm -f <deterministic-name>`. Effect makes that release *guaranteed to be attempted*,
which is the real win — but the win is "reverse-ordered, exit-aware, type-enforced teardown", not
"processes and containers die with their parent".

### What Effect genuinely buys over `trap`

- `Scope` appears in the **type**. An effect that acquires a container cannot be run without
  someone closing its scope; forgetting is a compile error, not a leaked container. This is the
  concrete answer to ADR 0006's "`set -e` bug class".
- Reverse-order, `Exit`-aware release, for free.
- Release runs on *defects* too. A `throw` inside `Effect.sync` / an `Effect.gen` body becomes a
  `Cause.Die`, the fiber terminates, and the scope closes — finalizers run. Bash's `set -e` does
  not cover this class at all.
- Uninterruptible cleanup at the Effect level, so overlapping interrupts don't shred teardown.

### What it does not buy

- Any protection against `SIGKILL`, `SIGHUP`, a double Ctrl-C, `process.exit()` called anywhere,
  or an OOM kill.
- Any bound on how long a finalizer may run. There is no built-in scope-close timeout; a hung
  `docker rm` hangs the exit. You must write `Effect.timeout` into each release yourself.
- Any cross-process guarantee. If the machine reboots mid-run, only a reconciler
  (`docker ps --filter label=agentbox` sweep at startup) recovers. **Effect does not remove the
  need for a janitor pass; it reduces how often the janitor finds work.**

**Design consequence for the ADR:** every externally-owned resource (container, lock file, remote
branch) needs (a) a deterministic name derived from the task id, (b) an `acquireRelease` finalizer,
and (c) a startup reconcile sweep. (a) and (c) are not things Effect gives you.

---

## Claim 2 — Layer / Context as the ops-as-library seam

### Verdict

**True, and the strongest part of the case — but the leverage comes from where you draw the
service boundary, not from Effect.** Effect makes the good boundary cheap and the bad boundary
awkward; it does not prevent the bad one.

### How services are defined today

Two idioms coexist in 3.22, and both are current — this is itself a cost (see Costs).

**`Context.Tag` (the original, still the documented default).** The
[Services page](https://effect.website/docs/requirements-management/services/) leads with it:

```ts
class Random extends Context.Tag("MyRandomService")<
  Random,
  { readonly next: Effect.Effect<number> }
>() {}
```

**`Effect.Service` (added in 3.9, now the shorter path).** It "define[s] both a `Context.Tag` and
a `Layer` for a service in one pass, optionally giving you the ability to provide any dependencies
at the same time" ([Effect 3.9 release notes](https://effect.website/blog/releases/effect/39/)):

```ts
export class Cache extends Effect.Service<Cache>()("app/Cache", {
  effect: Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const lookup = (key: string) => fs.readFileString(`cache/${key}`)
    return { lookup } as const
  }),
  dependencies: [NodeFileSystem.layer]
}) {}

const layer: Layer.Layer<Cache> = Cache.Default
const layerNoDeps: Layer.Layer<Cache, never, FileSystem.FileSystem> =
  Cache.DefaultWithoutDependencies
```

The constructor key is one of `succeed | sync | effect | scoped`. `scoped` is the one this tool
wants for anything holding resources — the same release notes show a `scoped:` service whose
`Effect.acquireRelease` release runs when the layer's scope closes, which is how you tie a
long-lived Docker connection to application lifetime.

`accessors: true` lets you call methods off the tag directly instead of `yield*`-ing the service
first — convenient, and a mild readability trap in agent-written code.

### Layer composition

`Layer<ROut, E, RIn>` ([Layers](https://effect.website/docs/requirements-management/layers/)).
The three combinators that matter:

- `Layer.merge(a, b)` — produces both services, requires the union of both inputs.
- `Layer.provide(inner)` — feeds `inner`'s output into the outer layer's requirements, and
  **hides** it. `Layer<Database, never, never>` after `Layer.provide(ConfigLive)`.
- `Layer.provideMerge` — same, but re-exposes the inner services.

`Layer.provide` vs `provideMerge` is the single most common source of "why is `Config` still in my
`R` channel" confusion, and it is the exact shape an LLM gets wrong.

### The seam, concretely, for this tool

```ts
class Docker extends Context.Tag("agentbox/Docker")<Docker, {
  readonly run: (spec: ContainerSpec) => Effect.Effect<ContainerId, DockerError, Scope>
  readonly exec: (id: ContainerId, argv: ReadonlyArray<string>) => Effect.Effect<ExecResult, DockerError>
  readonly remove: (id: ContainerId) => Effect.Effect<void, DockerError>
}>() {}

class Git extends Context.Tag("agentbox/Git")<Git, {
  readonly clone: (repo: RepoUrl, dest: Path) => Effect.Effect<void, GitError>
  readonly push:  (dest: Path, branch: BranchName) => Effect.Effect<void, GitError>
}>() {}

class AgentCli extends Context.Tag("agentbox/AgentCli")<AgentCli, {
  readonly implement: (ctx: PassContext) => Effect.Effect<PassResult, AgentError>
  readonly review:    (ctx: PassContext) => Effect.Effect<Verdict, AgentError>
}>() {}
```

Note what these tags say: `Docker.run` returns `Effect<ContainerId, DockerError, Scope>` — the
resource discipline is in the *interface*, so every implementation, real or fake, is obliged to be
scoped. That is the property tasklib's subprocess-mock suite cannot express.

### Faking Docker in a test vs. mocking a subprocess — the actual difference

**Mocking a subprocess** (what tasklib does today) asserts on an argv string. It couples the test
to the CLI's flag spelling, tests nothing about ordering or cleanup, and passes happily when the
production code has the arguments in a shell-injectable order.

**Faking the service** is a value:

```ts
const DockerTest = (log: Ref.Ref<ReadonlyArray<string>>) =>
  Layer.succeed(Docker, {
    run: (spec) =>
      Effect.acquireRelease(
        Ref.update(log, (l) => [...l, `run ${spec.image}`]).pipe(Effect.as(ContainerId("c1"))),
        (id) => Ref.update(log, (l) => [...l, `rm ${id}`])
      ),
    exec: (_id, argv) => Effect.succeed({ exitCode: 0, stdout: argv.join(" ") }),
    remove: (id) => Ref.update(log, (l) => [...l, `rm ${id}`])
  })
```

The test that matters is now expressible: *dispatch a task, make the reviewer pass die with a
defect, assert the log ends in `rm c1`.* That is the test tasklib's suite cannot write, and it is
the exact bake-off criterion the MAP names ("guaranteed cleanup under failure and dispatch-core
test quality").

Effect also ships first-party fakes for its own platform services — `FileSystem.layerNoop({...})`
lets you override selected methods and leave the rest as no-ops
([Layers docs](https://effect.website/docs/requirements-management/layers/)), so filesystem
assertions don't need a temp dir.

Swapping is `Effect.provide(program, DockerTest(log))`, or `Effect.provideService(Docker, impl)`
for a plain value, or `Layer.succeed` at suite level via `@effect/vitest`'s `layer(...)`.

### The honest caveat on Claim 2

Effect does not stop you defining `Shell.exec(argv): Effect<string, ShellError>` and calling it
everywhere. That is a subprocess mock wearing a `Context.Tag`, and it would score no better than
tasklib. **The dispatch-core test quality the bake-off measures is a function of whether the
service interfaces are domain-shaped (`Docker.run`, `Git.push`, `AgentCli.review`) rather than
mechanism-shaped (`Shell.exec`).** Effect makes the domain-shaped version cheap; it does not make
the mechanism-shaped version impossible. Write this into the ADR as a design rule, not an
assumption.

---

## Inventory

### `@effect/platform` Command / CommandExecutor (v `@effect/platform` ^0.97.0)

Public surface ([API docs](https://effect-ts.github.io/effect/platform/Command.ts.html), defaults
verified against [`v3` internal/command.ts](https://raw.githubusercontent.com/Effect-TS/effect/v3/packages/platform/src/internal/command.ts)):

- **`Command.make(command, ...args)`** builds a `StandardCommand` with defaults
  `shell: false`, `env: HashMap.empty()`, `extendEnv: true`, `cwd: Option.none()`,
  `stdin/stdout/stderr: "pipe"`. **`shell: false` is the default** — argv goes to `spawn` as an
  array, no interpolation. This is the chokepoint the security invariant wants, and it holds
  unless someone calls `Command.runInShell`. Ban `runInShell` with one lint rule / grep in CI.
- **Env**: `Command.env(record, { extendEnv? })`. Default **inherits** `process.env` and overlays
  the given vars; pass `extendEnv: false` for a hermetic allowlist env (executor source:
  `command.extendEnv ? { ...process.env, ...env } : env`). For agent containers you want
  `extendEnv: false` explicitly — the default leaks the parent env.
- **Runners**: `string` / `lines` / `stream` / `streamLines` / `exitCode`, all in the error
  channel as `PlatformError`, all requiring `CommandExecutor` (swappable service tag — the test
  seam for the rare code that legitimately shells out below the domain services).
- **`Command.start`** → `Effect<Process, PlatformError, CommandExecutor | Scope>` — the process
  handle is **scoped**; scope close runs the kill finalizer quoted in Claim 1 (SIGTERM to the
  process group, then await the exit). `Process` exposes `pid`, `exitCode`, `isRunning`,
  `kill(signal)`, `stdin`/`stdout`/`stderr` streams.
- **Timeout = interruption**: `Command.exitCode(...).pipe(Effect.timeout("10 minutes"))`
  interrupts the fiber, which closes the scope, which group-kills the child and awaits reaping.
  No extra machinery.
- Caveats from Claim 1 apply verbatim: children are `detached` (won't see terminal Ctrl-C
  themselves), the signal-exit branch of the finalizer skips group cleanup (#5592 residue), and
  none of this stops a `dockerd`-owned container.

### `@effect/cli` 0.76.0

- **Commands/flags**: `Command.make("name", { options, args })` + `Command.withHandler` +
  `Command.withSubcommands`; `Options.text/boolean/integer/choice/file/directory` with
  `withAlias`, `withDefault`, `optional`, `withDescription` piped on. Typed end to end — renaming
  a flag breaks every handler at compile time (working production account:
  [Termeeting post, 2026-06](https://www.thomasdeconinck.fr/blog/2026-06-29-effect-ts-termeeting)).
  Free: `--help`, `--version`, shell completions, and a `--wizard` mode that walks any command's
  flags interactively.
- **Prompts** (verified against [`v3` Prompt.ts](https://raw.githubusercontent.com/Effect-TS/effect/v3/packages/cli/src/Prompt.ts)):
  `text`, `hidden`/`password` (→ `Redacted`), `confirm`, `toggle`, `select`, `multiSelect`
  (with `selectAll`/`inverseSelection`/`min`/`max`), `list`, `integer`/`float`, `date`, `file`
  (an interactive file browser with a `filter` predicate), `custom`, composed with
  `Prompt.all`/`flatMap`. In the terminal they render in the familiar clack/prompts idiom: a
  colored `?`-style marker and message, dim placeholder text, arrow-key navigation with a
  highlighted cursor row for `select` (paginated at `maxPerPage`, default 10), `◯/◉` marks for
  `multiSelect`, and a summarized answer line left behind on submit. Polish is adequate —
  closer to clack than to raw readline.
- **The fzf verdict**: `SelectOptions` has `message`, `choices`, `maxPerPage` — **no fuzzy
  filter, no type-to-search**. For "pick one of 8 dispatch templates", `Prompt.select` retires
  `gum choose` cleanly. For "pick a branch from 300", it does not replace `fzf`; you'd write a
  `Prompt.custom` filter-select (the handler API is sufficient — it gives you keystroke events
  and render control) or keep shelling out to `fzf` through `Command`. There is also no built-in
  spinner (a `feat/spinner` branch exists upstream, unreleased; verdict as of 0.76.0: absent).
  So: **retires gum for input/confirm/choose-small; does not retire fzf today.**
- **Prompt testability is real and first-party.** `packages/cli/test/services/MockTerminal.ts`
  feeds keystrokes; from the actual test suite
  ([Prompt.test.ts](https://github.com/Effect-TS/effect/blob/v3/packages/cli/test/Prompt.test.ts)):

  ```ts
  const fiber = yield* Effect.fork(prompt)
  yield* MockTerminal.inputKey("down")
  yield* MockTerminal.inputKey("enter")
  expect(yield* Fiber.join(fiber)).toEqual(2)
  ```

  Prompts run against the `Terminal` service tag, so the fake is a layer swap — the same seam as
  Claim 2. `gum`/`fzf` interactions are untestable without a pty harness; this is a genuine step up.

### `@effect/vitest`

`it.effect` (TestContext + `TestClock` at 0 — timeouts test without waiting via
`TestClock.adjust("1000 millis")`), `it.live` (real clock), `it.scoped` /
`it.scopedLive` (test-managed `Scope` — acquireRelease code tests directly), `it.flakyTest`,
`it.effect.skip/only/fails`, plus `layer(...)` for suite-scoped layers and `it.effect.prop`
property tests ([README](https://github.com/Effect-TS/effect/blob/v3/packages/vitest/README.md)).
Assert typed errors via `Effect.exit` + `Exit` matchers. The scoped variants are exactly what the
container/lock/checkout finalizer tests need.

### Config + Schema for two-layer file config

- `effect/Config` primitives (`string/integer/boolean/redacted/nested/withDefault/orElse/all`) read
  through a swappable **`ConfigProvider`**; precedence chains are
  `p1.pipe(ConfigProvider.orElse(() => p2))` and tests swap the whole provider with
  `Effect.withConfigProvider` ([Configuration docs](https://effect.website/docs/configuration/)).
- **File parsing is out of scope for core** — `ConfigProvider.fromJson` takes an in-memory
  object; no TOML/YAML/file loading in `effect` itself.
- **But `@effect/cli` ships it**: the `ConfigFile` module
  ([API](https://effect-ts.github.io/effect/cli/ConfigFile.ts.html)) provides
  `makeProvider(fileName, { formats, searchPaths })` and `layer(...)` supporting
  **`json | yaml | ini | toml`** (via bundled `toml`/`yaml`/`ini` deps — visible in
  [@effect/cli's dependencies](https://registry.npmjs.org/@effect/cli/latest)). Two-layer config
  is therefore: `fromEnv` → project `ConfigFile.makeProvider` → user-dir `ConfigFile.makeProvider`
  → defaults, chained with `orElse`, decoded once at the boundary with `Schema.Struct` +
  `Schema.decodeUnknown` for structured validation errors. **The MAP's open question resolves:
  TOML stays on the table — the dep already arrives with `@effect/cli`.**
- `@effect/schema` no longer exists as a separate package: it merged into `effect` core as
  `effect/Schema` in **effect 3.10** (Oct 2024). Pre-3.10 imports in training data are a live
  LLM hazard (see Costs).

### Concurrency for per-branch locking

`Effect.makeSemaphore(n)` + `sem.withPermits(1)(effect)` — "permits are released after each
task, even if the task fails or is interrupted"
([Semaphore docs](https://effect.website/docs/concurrency/semaphore/)). A
`SynchronizedRef<HashMap<BranchName, Semaphore>>` gives per-branch mutexes;
`Effect.forEach(tasks, f, { concurrency: n })` covers future parallel dispatch with structured
interruption (children die with the parent, finalizers run — [Fibers docs](https://effect.website/docs/concurrency/fibers/)).
**Honest limit: all of this is in-process.** Two `agentbox` invocations in two terminals share
nothing; the cross-process branch lock still requires an advisory lock file (`O_EXCL` create +
pid + staleness check), which Effect has no primitive for. `acquireRelease` makes the lock file's
*release* reliable within a run; it does not make the lock itself cross-process.

---

## Costs, unsparingly

### 1. The 4.0 timing problem (the most important cost found)

`effect@latest` is 3.22.0; **`effect@4.0.0-beta.102` is live** (dist-tags above), launched
2026-02-18 ([v4 Beta announcement](https://www.effect.website/blog/releases/effect/40-beta),
[InfoQ coverage](https://www.infoq.com/news/2026/04/effect-v4-beta/)). v4 is not a polish
release: rewritten fiber runtime, `@effect/platform`/rpc/cluster **merged into core** (the
`main` branch no longer even contains `packages/platform` or `packages/cli` as they exist in v3),
unified versioning, `effect/unstable/*` namespaces — and **CLI is one of the 17 "unstable"
modules** in v4. No stable date is committed; **v3 is in feature freeze**, promised bug-fix/security
maintenance with a schedule "to be published as v4 approaches stability".

What this does to this plan: whatever is adopted now is v3, and v3 is the frozen line. The
pin-and-teach-agents strategy (ticket 06) must pin **hard** — exact versions, lockfile, rules
file written against 3.22 — and must budget a future migration whose shape is already known to
include import-path changes for *every* platform and CLI API this tool touches. Migration
codemods and "AI-assisted migration skills" are promised but were explicitly not ready at beta
launch. Community migration friction is already documented:
["Migration documentation missing for many removed/renamed functions and types" #6379](https://github.com/Effect-TS/effect/issues/6379).
The counterweight: v3 freeze also means the churn *stops* — a pinned 3.22 target is more stable
training-data-wise than 3.x was at any earlier point.

### 2. 3.x churn that already happened

A dedicated source-verification pass (separate sub-agent report; fine-grained enumeration held
there, available on demand) confirmed the following against release tags, the release-blog index,
per-version npm metadata, and the v3-vs-v4 `Utils.ts` source:

- `@effect/schema` → `effect/Schema` (3.10, Oct 2024) — old imports everywhere in training data.
- `Effect.gen(function*(_) { yield* _(op) })` adapter: obsolete since 3.0 (still *accepted* in
  3.x — confirmed present in v3 `Utils.ts`, **removed in v4's** — see also
  [effect-smol migration notes](https://github.com/Effect-TS/effect-smol/blob/main/MIGRATION.md)).
  LLMs emit the adapter form constantly; in v3 it compiles, so it rots silently.
- The everyday combinator surface (`andThen`, `zipLeft`/`zipRight`, `tap`, `tryPromise`, the
  `Layer` constructors) was checked against release tags and the API reference in that same pass —
  outcomes recorded in the sub-agent's report rather than re-enumerated here.
- Pre-3.0 history matters for training data: the 2.0 era consolidated `@effect/data`/`@effect/io`
  into `effect`, and the tag story evolved `Context.Tag` → `Context.GenericTag` (2.3-era
  restructuring, per the 2.3 release blog and npm publish dates) → class-based
  `Context.Tag(id)<...>()` → `Effect.Service` (3.9). Four generations of "how do I define a
  service" coexist in public code and therefore in model training corpora.
- `Effect.Service` (3.9) now coexists with `Context.Tag` — two current idioms for the same thing;
  docs teach `Context.Tag`, release notes push `Effect.Service`. Agents mix them.
- Cadence: the 3.0→3.22 minor line (Apr 2024 → mid-2026) was enumerated with dates in the same
  pass — roughly a minor release every 4–6 weeks until the v4-beta feature freeze. Six
  fine-grained claims could not be verified in public sources and were flagged rather than
  asserted; the doc above avoids relying on any of them.
- `@effect/cli` is **0.x** (0.76.0): no semver stability promise at all, and its README sits on a
  `main` branch that now describes v4-era code.
- HN threads independently report the same pain: "Effect API churn over the past three years has
  made many old posts obsolete… old github repos won't work out of the box"
  ([HN 41793956](https://news.ycombinator.com/item?id=41793956),
  [HN 40683256](https://news.ycombinator.com/item?id=40683256)).

### 3. Footprint (npm registry, verified 2026-07-29)

| Package | Version | Unpacked |
| --- | --- | --- |
| `effect` | 3.22.0 | **27.2 MB / 2,715 files** (deps: `fast-check`, `@standard-schema/spec`) |
| `@effect/platform-node` | 0.108.0 | 401 kB (+ `ws`, `undici`, `mime`, platform-node-shared) |
| `@effect/cli` | 0.76.0 | 2.1 MB (+ `ini`, `toml`, `yaml`; peers: platform, printer, printer-ansi) |

Order-of-30–40 MB of node_modules for the full stack. Irrelevant to a server, noticeable for an
`npx`-cold-start CLI, and the v4 pitch itself concedes the point (70 kB → 20 kB minimal bundle
claim). Not disqualifying; not free.

### 4. LLMs writing Effect — the evidence, graded

**(a) Effect team acknowledges the problem** (strong evidence): they ship an **Effect MCP server**
for docs lookup and an official **language-service plugin** whose diagnostics list reads like a
catalog of LLM failure modes — `floatingEffect` (effect built, never yielded),
`missingLayerContext`/`missingEffectContext` (the `R`-channel failures), `scopeInLayerEffect`
(`Layer.effect` where `Layer.scoped` was needed — i.e. **silently dropped finalizers**, this
tool's nightmare bug), `leakingRequirements`, `unnecessaryEffectGen` — 50+ rules, patchable into
`tsc` so CI catches them ([Effect-TS/language-service](https://github.com/Effect-TS/language-service),
[@effect/tsgo](https://github.com/Effect-TS/tsgo)). A third-party "agent doctor" health-checker
for Effect codebases also exists ([effect.doctor](https://effect.doctor/)). You do not build this
tooling ecosystem for a problem that isn't real.

**(b) Real user reports** (moderate): HN threads on learning curve and churn-obsoleted examples
(links above) — these describe *humans*, but stale-training-data churn hits LLMs identically and
worse. Community Effect skills/rules files for Claude explicitly exist to "address common
misconceptions from LLM-generated content"
([example skill](https://explainx.ai/skills/kastalien-research/thoughtbox-dot-claude/effect-ts)).

**(c) Thin/unfound** (said plainly): I found **no** published benchmark or systematic study
measuring LLM compile-failure rates on Effect vs plain TypeScript, and no first-party Effect blog
post naming "AI agents struggle with our types". The specific claims about Layer variance blowups
and `R`-inference error walls are well-supported *mechanistically* (the language-service targets
exactly them) but anecdotally, not quantitatively. Treat the magnitude as unmeasured.

**Mitigations that exist today and belong in ticket 06**: pin 3.22 exactly; install the
language-service patched into `tsc` so agent output fails CI on floating effects and
`Layer.effect`-with-Scope; run the Effect MCP server in agent sessions; write the rules file
against 3.22 idioms (`Effect.gen` without adapter, `Effect.Service` or `Context.Tag` — pick ONE),
and grep-ban `runInShell` and `Effect.runPromise` outside the entrypoint.

---

## Bottom line for the ADR

- **Claim 1 holds** with named engineering obligations: SIGHUP handler, double-Ctrl-C awareness,
  `runMain`-only entrypoints, deterministic resource names + startup reconciler, timeouts inside
  finalizers. The guarantee is real where bash's was fictional, and the gaps are enumerable.
- **Claim 2 holds** and is the strongest argument, conditional on domain-shaped service
  interfaces being a stated design rule.
- **The price is the v3/v4 boundary**: adopting the frozen line of a framework mid-major-rewrite,
  with an unstable-tier CLI package, and an unmeasured (but tooled-against) LLM-authoring risk
  that ticket 06 must convert from vibes into a compile-gate.
