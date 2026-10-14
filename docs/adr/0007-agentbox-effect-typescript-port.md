# Agentbox port to Effect TypeScript: incubate in hae, extract as speepobox

Date: 2026-08-06. **Reverses one decision in [0006](0006-agentbox-extraction-python-rewrite.md)**
— its explicit rejection of TypeScript/node — and supersedes 0006's UI posture (gum-only, fzf
retired, Textual rejected). Everything else 0006 fixed is either restated here in TS terms
(distribution model, two-layer config, prompt overrides, setup-hook contract, ops-as-library) or
unchanged (the parallel-run acceptance gate, the Go/Rust and Agent-SDK rejections).

The security core of [0004](0004-agent-sandboxing-workflow.md) /
[0005](0005-agentbox-dispatch-branches-iteration.md) / 0006 — hardlink-free clone, in-container
throwaway DB, credential-less container, host-side push, human merge gate, zero write-side git
inside the agent's clone, draft PRs only, no published ports — is **unchanged and remains
mandatory**. See "Security invariants" below for the port's obligations against each.

**This ADR does not decide the winner.** 0006's python port (*Bessemer*) proceeds independently and
in parallel. A bake-off with fixed criteria decides which tool the confirmed adopting teams are
eventually handed; its outcome is recorded in a future ADR 0008 in this repo. This ADR fixes
language, distribution, config, layering, UI, and the two build sequences for the TS side only.

**Disambiguation for readers of the inherited ADRs.** 0004 is titled "two sandboxed lanes"; this
ADR names the port's container service `Sandbox`. They are different referents: 0004's is a hae
workflow lane (native-sandbox interactive host vs. async parallel dispatch), which this tool never
implements. Post-extraction, *sandbox* has exactly one meaning — the task container.

## Context

0006 was decided 2026-07-24 with one day of pressure-testing and no working alternative in hand.
Since then, a wayfinding map (`docs/wayfinder/effect-agentbox/`, nine resolved tickets plus four
research findings docs) took the TS question seriously enough to answer it, and several facts moved
under it:

- **The two Effect claims were verified against a real release**, not assumed
  (`effect@3.22.0` / `@effect/cli@0.76.0` / `@effect/platform-node@0.108.0`). `Scope`/
  `acquireRelease` releases on success, failure, defect, and interruption, with four named residual
  gaps. `Layer`/`Context` enables tests that subprocess mocks structurally cannot express — but
  only if services are domain-shaped.
- **The behavior surface was inventoried with `file:line` anchors** — a 1779-line bash spine over a
  2325-line python data layer, 14 shell-out points, centre of mass at `run_task`
  (`run.sh:1028-1645`), four resources released by one 18-line `trap cleanup EXIT` whose exact shape
  exists because macOS bash 3.2 silently skips EXIT traps for backgrounded subshells and leaked a
  container after every completed run.
- **The npm ecosystem moved.** npm v12 (2026-07-08) blocks git dependencies and install/`prepare`
  scripts by default, including under `npx` — killing the two `npx github:#sha` distribution forms
  that looked cheapest. Node 26 deleted `--experimental-transform-types`, making erasable-only TS
  permanent law, and Node still refuses to strip `.ts` under `node_modules`.
- **TypeScript 7 went GA** and `@effect/language-service` now redirects TS ≥ 7 users to
  `@effect/tsgo`, whose diagnostics ride an ordinary typecheck and whose options are documented
  verbatim as being for steering LLM output.
- **`@clack/prompts` 1.7.0** (2026-07-03) shipped `autocomplete` / `autocompleteMultiselect`,
  which closes the fuzzy-selection gap that `@effect/cli` prompts leave open.
- **There are still no deployed outside adopters** — confirmed future ones, none installed — and hae
  has **no organic agentbox traffic**: the only current workload is building the tool. So the
  switching cost is at its lifetime minimum on both sides, and there is nothing to soak.

## Decisions

### The language decision, against 0006's argument

- **The port is TypeScript on Node, written in Effect.** 0006 rejected this in one sentence:
  *"half the system is already tested python; port-to-python rewrites only the untested half,
  port-to-TS rewrites everything including the proven half. For a working system with security
  invariants, that asymmetry decides it."* That argument is correct on its own terms and is the
  reason this ADR exists rather than a preference note. It is answered, not routed around:

  **The counter-argument.** The asymmetry is real but smaller than it reads, and it is measured in
  the wrong unit. 0006 counts *lines and tests carried*; the thing actually at risk is *dispatch
  correctness under failure*, which lives entirely in the untested half. Concretely:

  - The "proven half" is 2325 lines of `tasklib.py` with 337 tests, of which **49% of the code and
    41% of the tests are the picker** — a surface both roadmaps rewrite anyway (Bessemer at F5 with
    a homegrown stdlib-ANSI prompts module, this port at P3 with clack). Carrying it forward buys
    one sequence bullet of runway, not permanent value.
  - The tests that *do* carry real value test data logic — issue parsing, dependency ordering,
    ledger, gc classification. In this design those become **plain functions with no service tag at
    all**, so they translate as ordinary unit tests. What does not translate is the *shape* of
    tasklib's subprocess mocks, and that shape is the point: a subprocess mock cannot express
    "make the reviewer pass die with a defect, assert the container was removed." A `Layer`-faked
    `Sandbox` can, because the fake carries its own `acquireRelease`.
  - So `Layer`/`Context` turns the rewrite of the proven half into an **upgrade of its test
    quality** rather than a loss of it — which is the specific claim 0006 did not have in front of
    it, because in July the alternative on the table was plain TypeScript, not Effect.

  **What is still lost, stated honestly and not minimised:**

  - 337 passing tests and a working 2325-line python module are discarded. They do not come back.
  - Two rewrites of the same tool are now in flight in one quarter. Whichever loses the bake-off,
    that work is spent.
  - Python is already a hard host dependency (`tasklib.py` needs 3.14); **node ≥ 26 is a new host
    prerequisite** this port adds and 0006's port does not.
  - There is no TS equivalent of `uv` fetching the interpreter. The adopter installs Node
    themselves.
  - The top cost is unmeasured: **AFK agents writing Effect**. Layer variance, `R`-channel
    inference, and 3.x API churn in training data are where agents emit plausible non-compiling
    code — and this plan's entire leverage is agentbox dispatching agents to build agentbox. The
    evidence that mitigations work is mechanistic, not quantitative. See the tripwire below.

- **The load-bearing rationale is exactly two claims**, and the bake-off scores only these:

  1. **Scoped resources plus a typed error channel.** Container teardown, lock release, and
     checkout cleanup become type-enforced properties of the program rather than a `trap`
     convention, deleting the `set -e`/EXIT-trap bug class 0006 itself named as bash's worst. The
     canonical target is the macOS bash 3.2 container leak: structurally impossible under `Scope`.
  2. **`Layer`/`Context` as the ops-as-library seam.** 0006 committed to ops-as-library as a
     *convention* ("operations return data, the CLI renders it"). Here it is structure: the seam is
     a tag, a second frontend consumes the same `Schema` values and the same event stream, and
     rehearsal modes are layer swaps instead of second implementations.

- **`@effect/cli`, `@clack/prompts`, and the author's own fluency are reinforcing, not
  justifying.** They lower the cost of the decision; they do not carry it. If the two claims above
  fail to show up in the evidence, ergonomics do not rescue the choice — that is what makes the
  bake-off falsifiable.

### Name, ownership, distribution

- **Name: `speepobox`.** Package `@hireanesquire/speepobox`, bin `speepobox`, directory
  `speepobox/`, repo `HireAnEsquire/speepobox`. It was the only shortlist candidate free on **both**
  npm and GitHub; the drydock/offhand/nightshift shortlist is entirely dead (dormant npm squats plus
  GitHub *user*-account collisions). Availability stopped being decisive once the package went
  scoped — the distribution model never resolves a name from the registry — so unscoped `speepobox`
  is deliberately left unreserved. **Owned by the org, not personally**: the package is extracted
  from this repo's history either way, so employer ownership avoids a later IP question.
- **`bessemer` is the bake-off prize, not a collision.** If TS wins, the python port is retired
  first and this repo renames into the vacated name, in a fixed order: rename the python repo to
  `bessemer-python`, then rename `speepobox` to `bessemer`, then `package.json` name + bin, then
  repin the shim URL. Step order is load-bearing — retirement means "stop investing", not "delete",
  so the name is occupied until it is explicitly vacated.
- **Distribution: a committed clone-run shim, not any `npx` form.** A ~40-line shim in the
  consuming repo shallow-clones the tool repo at a SHA pinned in `.agentbox/config`, runs
  `npm ci --omit=dev --ignore-scripts` once into a user cache, and executes the TS source directly
  under Node's stable type stripping. This reproduces all four properties 0006 got from uvx —
  committed reviewable pin, core never enters the consuming repo, no build anywhere, one-line
  upgrade — **plus** full transitive determinism from the tool's committed lockfile, which `npx`
  cannot give even under an exact pin. Effect consumer code was verified strip-safe
  (`tsc --erasableSyntaxOnly` clean, ~68 ms strip overhead).
  - **Costs, accepted:** the shim and its cache are ours to build and scaffold; the node ≥ 26 floor
    is the adopter's to satisfy.
  - **Node ≥ 26 is a *dispatching-host* prerequisite, not a container one.** The tool runs on the
    host and `docker exec`s in. An adopter's task container may contain no node at all.
  - **Release is nothing to build.** The shim pins a SHA and never resolves a version, so there is
    no publish, semver, tag, changelog, or release workflow. It is replaced by a one-line repin
    discipline: a SHA is fit to pin when it is on the default branch with CI green.
  - **Fallback if the shim proves wrong:** scoped `npm publish` of a bundled dep-free artifact plus
    `npx --yes pkg@exact` under OIDC trusted publishing.
- **Package manager is npm, and the committed `package-lock.json` is a shipped artifact** — the
  shim consumes it. This is decided against dev-side taste (pnpm is the nicer experience) by the
  standing preference to minimise adopter onboarding friction.

### Config, prompts, setup hook

- **Config format is TOML**, via `@effect/cli`'s `ConfigFile`, in 0006's two layers: committed
  `config.toml` for team facts (image, base, the pinned tool SHA, tasks dir) plus gitignored
  `config.local.toml` for dev-owned values, local winning. Secrets stay in a gitignored `.env`.
- **Effect owns sourcing; we own shape.** A `ConfigProvider` stack expresses the precedence chain
  **flags > env > local > committed > auto-detect/defaults**, and **one layer decodes it once**
  into a typed `AgentboxConfig` record provided as a tag. Per-call-site `Config` reads are
  rejected: config would then fail deep inside a dispatch instead of at startup, and the shape
  would be written down nowhere. Decode-once also matches the invariant that nothing is touched
  before guards pass.
- **Prompts: package defaults, per-repo whole-file overrides, plus one fragment.** Unchanged from
  0006 in effect, with two refinements. Resolution goes behind a `PromptSource` tag that returns
  the resolved text **and which root won** (a client needs to see their override take, and the
  assembled prompt is logged verbatim). Override granularity is **whole-file replacement only**,
  plus a separate small `project-context.md` fragment the default prompts interpolate — the narrow
  common case (a client's test command, setup notes) that survives the defaults improving
  underneath them. Fragment-patching a template was rejected as a mini-templating-language. Under
  the clone-run model, prompts and other non-JS assets are just files in the cloned tree — there is
  no bundling problem.
- **Setup hook is unchanged from 0006**: `.agentbox/setup.sh`, scaffolded once, idempotent,
  non-interactive, nonzero exit aborts the dispatch with the log. **A client's stack is the
  client's business** — its tests, package manager, and language are reached only through that hook
  and its spec's verify commands. The tool never has an opinion.

### Layering posture

- **Twelve domain-shaped services carry `Context.Tag`s:** `Sandbox`, `Git`, `Forge`, `AgentCli`,
  `Ledger`, `IssueStore`, `Notifier`, `RunLock`, `PromptSource`, `Reporter`, `AgentboxConfig`,
  `Prompt`. Effect's own `FileSystem` / `Path` / `Clock` / `CommandExecutor` are used directly, with
  no wrappers. Pure logic — prompt assembly, slug/cid/path derivation, issue ordering, table
  rendering, gc classification, config decoding, liveness predicates — stays plain functions with
  no tag, because a fake buys nothing.
- **The container service is `Sandbox`, not `Docker` — role, not vendor.** The name steers what
  agents write into the interface, and its spec type is expressed in our vocabulary (image
  reference, mounts, env allowlist) rather than as a `docker run` flag bag. **No provider
  abstraction is built** (YAGNI): the tag *is* the seam, and an interface generalised from one
  implementation generalises wrong.
- **Error channel splits on the outcome-row test.** If the run still writes a ledger row and a
  human-readable failure, it is a **typed error** (`SandboxError`, `GitError`, `ForgeError`,
  `AgentPassFailed`, `LockHeld`, `LedgerError`, `ConfigError`, `GuardRefused`; preflight failures
  are typed — they are today's exit-1-with-message path). If the tool's own invariants are
  violated, it is a **defect** (impossible states, an unparseable ledger line we just wrote,
  `Command.runInShell` reached, a missing tag at runtime). Cleanup is unaffected either way, so
  this decides reporting shape, not resource safety.
- **One `Scope`, opened after every guard passes.** Acquisition order `RunLock` → checkout →
  sandbox; release reverses automatically. **Checkout release is derived, not flagged**: the
  release always attempts the FF fetch-back and keep-vs-delete falls out of whether the commits
  made it home. **Finalizers never fail the scope** — the checkout release logs loudly, keeps the
  directory, and swallows its own failure, because a failing Effect finalizer becomes a defect and
  would mask the run's real error.
- **SIGHUP now tears down**, which is a deliberate behavior change from bash (today a closed
  terminal tab leaks a container silently). Ctrl-C once tears down; Ctrl-C twice hard-exits and the
  reconciler reclaims; `kill -9` is uncatchable and the reconciler reclaims. `NodeRuntime.runMain`
  is the only entrypoint idiom. Detached-child cleanup (Effect issue #5592) is sidestepped by never
  spawning detached children — sandboxes are dockerd-owned, so teardown is an explicit
  `docker rm -f` finalizer and the agent pass runs `docker exec` in the foreground.
- **A reconciler runs on every dispatch preflight** — a component the bash spine never had. It
  **auto-reclaims only the provably dead** (labels match this repo AND the lock's recorded PID is
  not alive AND the sandbox is not running) and reports everything else, because silently deleting
  a possibly-live run is how you kill a colleague's dispatch.
- **Ownership of runtime resources is declared, never inferred.** Every sandbox is labelled
  `agentbox.managed=true` + `agentbox.repo=<hash of repo root>`, and every reconcile/gc query filters
  on both. Today's `agentbox-` name prefix matches anyone's unrelated container and — worse —
  matches agentbox running in a *second repo on the same host*. Prefix sweeping is retired
  everywhere including `gc`; the name survives for human readability only.
- **Retry lives in the dispatch core, not in `AgentCli`.** `AgentCli.implement` stays single-shot
  and honest; the core wraps it in a `Schedule` with an early abort when the sandbox is gone. A fake
  `AgentCli` can then fail twice and succeed on the third without simulating its own retries.
- **`RunLock` stays a PID file, not a `Semaphore`.** The real contention is two invocations in two
  terminals; an in-process primitive is the wrong tool however idiomatic. Stale-lock reclamation
  becomes part of acquisition, using the same liveness predicate as the reconciler.
- **Every operation returns a `Schema`-defined domain value** (`DispatchOutcome`, `StatusSnapshot`,
  `GcPlan`, `IssueSelection`), so JSON for a future dashboard is free and the CLI is pure render
  functions. **In-flight progress is a `Reporter` event stream, not a log file** — the rotated log
  becomes a `Reporter` *implementation* rather than a parallel path. This is what makes "a second
  frontend without a rewrite" true rather than aspirational; the cost is one tag in the `R` channel
  of most ops.
- **`--dry-run` is a layer swap**, not a second code path. Today it is 78 lines
  (`run.sh:1647-1724`) that re-derive slug/cid/checkout/log with duplicated expressions and
  re-implement the `gh pr view` probe — an implementation free to drift. In the port it is the same
  dispatch effect run against a layer whose mutating services are recording no-ops: same guards,
  same derivation, same ordering, one code path. Caveat recorded: a no-op layer rehearses *our*
  logic, not docker's, so a dry run still cannot prove `docker run` would have succeeded — exactly
  as today.
- **Ledger breaks compatibility.** `runs.jsonl` is gitignored, local, and per-repo, and the bake-off
  scores cleanup and test quality rather than history comparison, so back-compat earns little
  against three real flaws: `spec`/`feature` are a nullable pair encoding a mode, `issues`-vs-
  `outcome` repeats that discriminant unenforced, and there is no run id, start/end, duration, or
  exit reason. The new record is a tagged union for run identity (one-off / feature /
  feedback-resume) with `schemaVersion`, run id, start + end, terminal reason, base and merge-base
  SHAs, and PR number alongside URL. A tolerant read-time adapter decodes old lines and is deleted
  at switchover. The record is **designed to be derivable from the `Reporter` event stream**, so
  promoting events to source-of-truth later is additive; event-log-as-truth itself is deferred as
  architecture spent on a consumer that does not exist.
- **One `AppLive` layer** is wired at the entrypoint and provided to every subcommand, with services
  acquired lazily inside their own scoped constructors. Per-subcommand layers were rejected: they
  multiply the `provide`-vs-`provideMerge` confusion that is the top LLM failure mode in Effect, and
  this port's leverage is agents writing the code.

**Five design rules, stated as rules because each is a claim a test should be able to fail:**

1. Services are **domain-shaped**, never mechanism-shaped. A `Shell.exec` tag scores no better than
   tasklib's subprocess mocks.
2. Security invariants are **unrepresentable if violated**, not reviewed by eye.
3. Ownership of runtime resources is **declared** (labels), never inferred (names).
4. Finalizers never fail the scope.
5. Rehearsal modes are **layer swaps**, never second implementations.

### UI posture (supersedes 0006)

- **`@clack/prompts` for all interactive prompting**, behind a narrow `Prompt` tag. `@effect/cli` is
  retained for **argument parsing and `ConfigFile` only**. Mixing the two prompt systems would put
  two visual languages in one tool, so it is one or the other.
  - clack's `autocomplete` / `autocompleteMultiselect` close the fuzzy gap that
    `@effect/cli` prompts leave open — **no homegrown filter prompt and no optional fzf**, which
    also retires 0006's "fzf's remaining use moves to `gum filter`". `taskLog`, `spinner`, and
    `progress` cover the 30s heartbeat and agent-pass output natively, so 0006's gum dependency goes
    too: **zero optional external binaries**, and the `gum`/`fzf` doctor probes are dropped.
    *Verified with one nuance (ticket 13):* clack's **default** filter is unranked substring, not
    fuzzy — fzf-grade behavior needs the options-as-function getter, a **vendored ~45-line pure
    scorer**, and an **explicit pass-through `filter`** (without it the wrapper silently re-applies
    its substring default *after* the getter's ranking — works on most queries, isn't fuzzy). Still
    no prompt component and no subprocess; the claim holds in spirit, not in letter.
  - It decouples the UI from `@effect/cli`, which is an *unstable* module in the v4 line — worth
    real money while the v3/v4 boundary is live.
  - **Costs, accepted — repriced by ticket 13:** a Promise boundary, but the bracket is **not** a
    hand-rolled `acquireRelease` restoring raw mode — measured under fiber interrupt, that shape
    restores the terminal while leaving a zombie prompt attached to stdin, still consuming keys.
    The required shape is **interrupt-signal passthrough**: `Effect.promise((signal) => …)` handing
    the fiber's signal to clack's own `signal` option, which unwinds cleanly (sentinel resolved,
    zero leaked listeners). Cancel is a sentinel via `isCancel` rather than a rejection, and clack
    collapses Esc and Ctrl-C into that one sentinel — resolved by **adopting clack-native cancel**
    (both keys abort) with wizard back-navigation as a **visible `← Back` option row**, the pattern
    the gum menus already used. Focus-preservation across backspace-clear (clack keeps the focused
    item; fzf resets to top) is accepted as-is. The `Prompt` tag is where the signal boundary lives
    and what lets picker flows be driven headlessly in tests.
  - **Status: verified against a running prompt on real repo data** (map ticket 13, 2026-08-07) —
    confirmed with the amendments above. Reversal remains one dependency line.
- **Default presentation** for a dispatch: agent-pass output through `taskLog` (continuous output,
  last lines visible, cleared on success), review and land steps through `spinner`. This is a
  renderer choice over the event stream, not new architecture.
- **0006's standing UX requirement is met rather than approximated.** It asked for "the cohesive
  clack-style polish of vite/sveltekit-class CLIs" and planned to reach it by hand-rolling stdlib
  ANSI under a stdlib-first posture. Here it is the actual library. This asymmetry is **reported
  alongside the bake-off and explicitly not scored** — it follows from the language choice, not
  from either side's execution.
- **Still rejected, unchanged from 0006:** Textual and a localhost web UI. No trigger has fired, and
  a dispatch-triggering web UI would need its own security grill (loopback-bound, token-gated,
  DNS-rebinding/CSRF).

### Effect version, toolchain, and de-risking agent-written Effect

- **`effect@3.22.1` pinned exact and frozen for the whole incubation.** The v4 beta is refused:
  incubation *is* the experiment measuring whether agents can write this productively, and running
  it against an API their weights barely contain confounds the one measurement that matters. v3 is
  feature-frozen but still patched, so patch bumps buy nearly nothing while each risks shifting the
  API surface the agent guidance describes. One exception: a bump that fixes a bug actually hit,
  taken deliberately, with the guidance reviewed in the same PR. No renovate/dependabot on `effect`.
  - **Reopen trigger:** if `effect@4` reaches the `latest` dist-tag before T1 starts.
  - **The v4 migration is conditional and escalated, never taken silently.** If 4.0 is on `latest`
    at move-out it becomes the *first* post-move bullet, when the codebase is at its minimum
    (T1–T6 only). If it is not GA — the likely case, since v4 has been beta ~6 months — it drops
    past the finish line as a follow-on issue. Parity, switchover, and adopter install do not wait
    on someone else's release train. Adopters are insulated either way: the shim pins a SHA.
- **Toolchain: `typescript@7` + `@effect/tsgo`.** TS 7 is GA and `@effect/language-service`
  explicitly redirects TS ≥ 7 users here. Accepted cost: `effect@3` + tsgo is the less-travelled of
  tsgo's two supported combinations. Also npm, node 26, `vitest` + `@effect/vitest`, and
  **`oxlint` + `oxfmt`, both pinned exact, `typeAware` off** — matching this repo's client, and
  matching what the Effect repo itself does (oxlint with tsgo in the *typecheck* path, not the lint
  path, and `typeAware` off).
- **The gate is one command, and warnings break it.** The package ships a single `npm run verify`
  = typecheck-with-Effect-diagnostics + lint + tests, and the package's issue template pre-fills its
  Verify section with exactly that, so skipping the gate requires deleting a line rather than
  forgetting one. Effect diagnostics ride the **single** typecheck as ordinary TS diagnostics:
  **errors and warnings both break the build, suggestions print**. Errors-only is not acceptable —
  `scopeInLayerEffect` (`Layer.effect` where `Layer.scoped` was needed, i.e. **silently dropped
  finalizers**, the exact bug class this port exists to eliminate) defaults to *warning*. The
  oxlint type-aware bridge to the same diagnostics is **declined**: one typecheck, one config.
- **Agent guidance is a committed `AGENTS.md` at the package root, not a repo skill** — skill bodies
  are gitignored here, so a skill does not exist inside the task container's clone at all. It
  carries **only what no diagnostic can catch**: the rulings above that no rule knows (the `Sandbox`
  name, the outcome-row test, `--dry-run` as a layer swap), runtime gotchas with no static signal
  (SIGHUP tears down, #5592, `docker rm -f` plus the reconciler), and pick-one calls where both
  options typecheck. Anything with a rule name is deliberately cut — documenting it again is a
  cache of a cheap lookup, and the diagnostic fires at the exact line. Phrased positively rather
  than as prohibitions. The **review pass owns the file**: when a dispatch fails on an Effect
  problem, the fix PR appends the trap *only if* the gate could not have caught it; if a rule
  existed and was merely off, the fix is turning the rule on.
- **Issue sizing is unchanged** — one reviewable concern, no Effect-specific size rule. Agents fail
  on Effect at the **wiring** (composing layers, lining up the requirements channel), not on volume,
  so splitting an issue adds a seam and makes the dominant failure mode *more* frequent. Instead,
  each Effect issue's spec **names the tag and pastes the layer composition**, taken verbatim from
  the composition root (`speepobox/src/app.ts`).

  > **Corrected 2026-08-10.** This said the composition was "generated mechanically by
  > `effect-language-service layerinfo`". `layerinfo` is an editor-only language-service feature with
  > **no CLI**, so nothing could have generated it mechanically and no issue may ask an agent to run
  > it. The mitigation is unaffected and load-bearing — **copy, do not derive** — only its source
  > changes. Same correction as wayfinder ticket 06 §0, whose research finding this inherited.

- **Tripwire, with a number.** Over the first ~8 dispatched issues, count those needing **≥2
  redispatches whose failure was an Effect type/diagnostic error** (not domain logic) — countable
  from the ledger. Threshold: **more than half**. Firing does not stop anything by itself; it
  escalates mitigation and re-measures over the next 8, and **the user is the final decider**. The
  fallback is **not** a third rewrite in plain TS — it is the bake-off resolving in Bessemer's
  favour. ~~Arithmetic note: the in-hae sequence is six issues, so the count completes at P3, deep
  in the post-move sequence, where abandoning is far more expensive than the threshold was
  originally priced.~~ The escape hatch survives regardless (see "retire ≠ delete").

  > **Amended 2026-08-10 — the arithmetic no longer holds, in the threshold's favour.** The in-hae
  > sequence is no longer six issues. The 2026-08-10 re-slice replaced 08's T3–T6 bullets with
  > fifteen tickets, so the sequence is **seventeen** and the first ~8 complete at **T8, before
  > move-out** rather than at P3 after it. The concession the note recorded — that the count lands
  > where abandoning costs far more than the threshold was priced for — is retired: it now lands
  > while the escape hatch is still cheap. This was a side effect of re-slicing for ticket size, not
  > a change made to the tripwire, and the threshold itself is untouched.
  >
  > One caveat the finer slicing introduces: eight *tickets* is less work than eight *bullets*, so
  > the count now completes over a smaller sample. Read a firing tripwire as a prompt to re-measure
  > over the next 8, which is what the rule already says, rather than as a verdict on the port.

  > **Result, recorded 2026-08-21: the count across all seventeen in-hae tickets is `0`.** Not
  > "did not fire" — zero, against a threshold of nine. Every T1–T17 issue that took more than one
  > dispatch has a non-Effect cause on the record: an Anthropic session limit (T3), wall-clock
  > overruns (T5, T6, T15), and review rounds that kept finding real defects (T17). Independently:
  > no `error TS`, `not assignable to type`, or `Type 'Effect` anywhere in the surviving dispatch
  > logs. Evidence and its two limits — the ledger records outcome but never cause, and bash keeps
  > only one log generation — are in
  > [T17's `## Comments`](../wayfinder/effect-agentbox/issues/T17-feedback.md).
  >
  > It decides nothing: [ADR 0008](0008-agentbox-port-bakeoff-closes-for-speepobox.md) closed the
  > bake-off first, and the tripwire's only fallback was Bessemer winning it. Recorded because 08 §6
  > gate 4 asks for it as the incubation's one quantitative result, and because an unevaluated
  > threshold is weaker evidence than one evaluated at zero.
  >
  > **It is narrower than it looks.** Three of the four multi-dispatch failures were wall-clock, which
  > is a *sizing* result — priced separately from the type-system risk this tripwire watches. The
  > honest reading is that the risk 06 named did not materialise across seventeen issues, not that the
  > port was easy.

### Incubation, extraction, and the two sequences

- **The package incubates as a self-contained top-level `speepobox/` directory in hae** — its own
  `package.json`, tsconfig, lint/format config, and test runner; no workspace coupling in either
  direction.
- **hae's dispatcher is not modified to accommodate its guest.** The dispatch core is agentbox's
  *untested* half, so every edit to it is risk taken against the very thing doing the dispatching.
  `run.sh` is unchanged; hae's hae-shaped setup step runs as dead weight for TS tasks (~1–2 minutes
  against 10–60-minute tasks); the agent runs `npm ci` itself, since egress is open per 0005 and
  nothing needs baking into the image. **One exception**: `.agentbox/Dockerfile` moves from node 22
  to **node 26**, matching hae CI — so incubation exercises the real type-stripping path the whole
  distribution model rests on, rather than deferring its first real run to after the move.
- **Three edits outside the package, and only three.** A generic, directory-name-free line in both
  agentbox prompts (*"if the spec names its own verification commands, those are the gate"*) —
  without it, `pre-commit` on the package directory **passes while checking nothing**, handing the
  agent a false green; the package directory added to pre-commit's top-level `exclude:`, so hae's
  generic hooks cannot dictate the package's style and the package cannot break hae's gates; and
  the node bump above.
- **Implementation issues live tracked at `docs/wayfinder/effect-agentbox/issues/`.** `--feature`
  takes a slash path as-is and `Status:` lines are rewritten host-side, so no dispatcher change is
  needed and the agent structurally cannot commit status churn. This is a deliberate exception to
  0005's gitignored-issues rule: these are a planning deliverable, not a per-dev queue.
- **Runtime state roots are separated during incubation.** Two dispatchers on one host, both
  resolving repo root to hae and both defaulting to `.agentbox/` for ledger, locks, and checkouts,
  is a data race — two tools writing one lock directory with different staleness rules. The runtime
  root is a config value, so this is a **default flipped at switchover**, not a structural cost.
- **Move-out is `git filter-repo`, multi-path, copy not move** — `subtree split` takes one prefix
  and the package is not the only thing that must travel. Carried with history: the package,
  `docs/wayfinder/effect-agentbox/` including its issues, ADRs 0004–0006, hae's sandboxing guide,
  and **`run.sh` + `tasklib.py` as the parity oracle** — parity work happens after the move, and the
  map fixes those two files as the behavior spec, so without them the parity work has no reference.
  hae keeps its originals and keeps running bash agentbox until switchover deletes its core. hae's
  `implement-`/`review-`/`pr-prompt.md` do **not** travel; the tool ships its own package defaults.
- **Two sequences, recorded in `.agentbox/ROADMAP.md`** and specified in
  `docs/wayfinder/effect-agentbox/SPEC.md`:
  - **In hae, to the move-out bar:** T1 skeleton (`doctor` green under plain `node`) · T2 ledger +
    status · T3 scoped shell (lock → checkout → sandbox → setup hook + reconciler; all three
    released on Ctrl-C, SIGHUP, and success) · T4 agent loop + land (dispatches a one-off task on
    itself) · T5 `--dry-run` as a layer swap · T6 feedback-resume. **Every bullet is AFK-dispatched
    from T1** through hae's bash agentbox — only *self*-dispatch is gated, and that is T4's tracer.
    Hand-seeded carve-outs: `AGENTS.md`, the issue template, and the three hae-side edits.
  - **After the move, to the finish line:** P1 repo bootstrap + a throwaway hae probe · P2
    `IssueStore` + feature-mode · P3 picker · P4 `gc` force paths + `--hard-reset` · P5 `init` +
    templates + `init --diff` · P6 shim + adopter distribution + docs · P7 hae switchover. P1 and P7
    are hand-done; **P2–P6 are self-hosted** — speepobox dispatching agents at speepobox.
- **`IssueStore` and feature-mode leave the pre-move sequence entirely.** Nothing before the
  move-out bar reads an issue file: one-off dispatch is a positional spec plus `--branch`, and
  feedback-resume is `--resume` plus feedback text. That is ~520 lines and ~40% of tasklib's
  existing tests deferred to P2 on evidence rather than by taste.
- **CI in the new repo is one workflow** running `npm run verify` on PRs, with branch protection
  requiring it and no direct pushes to default. The case is specific: every line is written by an
  AFK agent that runs verify *inside its own container, on its own say-so*, then opens the PR. CI is
  the only gate the dispatching agent cannot skip, misreport, or have silently pass on a broken
  environment — a failure already caught once in hae. **The agent never merges its own PRs.** Human
  merge is terminal; "agentbox builds agentbox" means dispatch, build, verify, PR.
- **hae is adopter #1, not a bespoke port.** At switchover hae runs `init` the way an outside team
  would, and its `.agentbox` core is deleted because `init`'s output replaced it. This deletes a
  whole bespoke work item and proves `init` — the one deliverable with no self-hosting exercise,
  since the tool's own repo is set up hardcoded — before any outsider touches it. The lost
  second-client signal is recovered by P1's early throwaway probe: a hand-written config pointed at
  hae, one real hae issue dispatched one-off, purely to discover what is client-shaped that
  self-hosting never reveals. Artifact discarded; findings feed `init`'s design.

### Security invariants

Every invariant from 0004/0005/0006 is **unchanged and mandatory**: zero git credentials in the
container; no write-side git inside the agent's clone (the host fetches *from* the clone and pushes
from the main repo); push only to the user-owned `--branch`, never to base; `master`/`main` and the
checked-out branch refused as working branch; draft PRs only with the human as merge gate; PR review
comments never enter prompts; credential checks report presence only, never a value; gc never
deletes logs; FF-only salvage before any checkout removal; liveness re-checked immediately before
every deletion; task containers publish no ports; hardened `docker run` flags and `--no-hardlinks`.

Two findings from the behavior inventory, and their current status:

1. **"Task containers publish no ports" was, at inventory time, unenforced** — it held purely
   because no `-p` appeared in the `docker run`. It has since been fixed in hae's bash spine
   (`run.sh`, commit `e2bcc3d0`): a post-start `docker port` check aborts the dispatch if anything
   comes back, and fails closed if the check itself cannot run. **The port does better by
   construction**: the sandbox spec type has *no ports field at all* — not a flag to misuse, not an
   escape hatch, unrepresentable.
2. **The origin URL flowing into the agent-readable clone carried a token** whenever a dev's remote
   was HTTPS-with-userinfo. Severity was conditional, not live (this machine uses SSH). Also since
   fixed in bash (`run.sh`, commit `d914fc75`): a `strip_url_userinfo` helper on the write path plus
   a `doctor` warning. **The port does better by construction**: `RepoUrl` is a branded parse whose
   constructor strips or refuses userinfo, so no string-typed URL crosses into the sandbox.

Both were repaired in bash while this map was open, which removes the "the port is the only fix"
argument and leaves the real one: in bash both repairs are checks that a future edit can bypass; in
the port both are shapes a future edit cannot express. That difference *is* design rule 2, and it is
what the port claims.

**Invariant 3's hardened `upload-pack` is upstream git behavior, not a flag agentbox sets.** Stated
explicitly so nobody later "reimplements" a guarantee that was never local — the port inherits it by
using the same fetch-from-clone path.

**One new enforced property**: the subprocess chokepoint is a single internal module (not a tag —
a tag there would recreate the `Shell.exec` anti-pattern that makes Layer-based testing worthless).
It is the only file allowed to import `Command`, enforced by a CI/lint grep alongside bans on
`Command.runInShell`, `Effect.runPromise`, and container-name-based ownership queries. It sets
`shell: false` and **`extendEnv: false` with an explicit allowlist** — the default inherits
`process.env` and would leak the parent environment into agent containers.

### The bake-off

- **Scored on exactly the two load-bearing claims** — guaranteed cleanup under failure, and
  dispatch-core test quality. **Not** ergonomics, line count, or UI. Criteria are not widened later:
  a bake-off whose criteria grow to cover whatever the loser is missing stops being falsifiable.
- **Scored at: our T5 complete AND Bessemer at F3, whichever lands later**, and **decoupled from
  move-out** — neither gates the other. The reasoning is from the roadmaps, not preference:
  Bessemer's F3 is our T4 bullet-for-bullet and is the only exact parity point in either sequence
  (their F4 merges feature-mode with resume, which we pushed post-move); Claim 1 completes exactly
  at T4, because the checkout release is *derived* from the land step's FF fetch-back; and Claim 2's
  best exhibit is T5's layer swap. The asymmetry that we have T5 and they do not (their dry-run is
  F5) is **recorded rather than hidden** — Claim 2 is a claim about structure and the exhibit stands
  alone, but the comparison is T1–T5 against F1–F3 and says so.
- **Evidence is captured at each port's own milestone, not reconstructed at comparison time** —
  otherwise the bake-off quietly becomes a vibe check. Each port commits two artifacts when it
  reaches its milestone: (1) a **failure-injection matrix**, the *same* kill list against both
  (Ctrl-C once, Ctrl-C twice, SIGHUP, `kill -9`, agent-CLI crash mid-run), each asserting no leaked
  container, lock, or checkout — meaningful only if identical; and (2) a **dispatch-core test
  inventory** — what is covered, and what is provable only because of the architecture.
- **Closes as ADR 0008 in this repo** — not in either port's repo. hae is the shared parent and the
  shared client, and where 0006 and this ADR live; a winner's-repo ADR is a self-assessment and the
  loser's repo gets an obituary nobody reads.
- **The second exit is recorded in the same ADR.** If the tripwire fires first and resolves the
  question in Bessemer's favour, 0008 says exactly that — closed on the agent-productivity axis,
  Claims 1 and 2 never scored — rather than dressing it up as a comparison that did not happen. The
  tripwire deliberately **does not** enter the bake-off's scored criteria.
- **Retire ≠ delete.** The loser's repo is kept as a cold fallback; retirement means stop investing.
  That is the standing escape hatch, and it is what makes "abandon" a real option at any point.
- **Adopters are a commitment, not a score.** Bessemer has confirmed future adopters and no deployed
  ones, so there is no migration cost on the scoreboard — but the bake-off decides what those
  waiting teams are eventually handed.

### The hae switchover gate

0006's parallel-run acceptance gate is **adopted as written** — read-only commands (`status`,
`doctor`, `gc` list, `--dry-run`) validated side-by-side any time; dispatch gate = one feature-mode
multi-issue run, one one-off, one resume-with-feedback, one failure path handled correctly; outcome
parity, not byte-identical logs. Because hae has no organic traffic, the four dispatch runs are
**manufactured** (real hae work chosen by the user; the failure path induced deliberately). Three
additions it does not survive contact without:

1. **The gate runs with runtime roots still separate.** Flipping the root to `.agentbox/` before the
   gate reintroduces the two-tools-one-lock-directory race at the worst possible moment. **The
   flip, the legacy-adapter deletion, and the bash-core deletion are one atomic commit** at the end.
2. **Read-only side-by-side runs through the legacy import adapter** — split roots mean split
   ledgers, so `status` would otherwise compare two different worlds. This fixes the adapter's
   deletion point precisely: **after** the gate passes.
3. **An expected-divergence list, written before the gate runs.** "Outcome parity" is untestable
   unless the intentional differences are named in advance: SIGHUP now tears down; ownership by
   label not name prefix; greenfield ledger schema; `--dry-run` as a layer swap; retry in the
   dispatch core; and — load-bearing — **the prompts differ**, since hae's do not travel. Different
   prompts mean different agent output, so parity **cannot** mean the same diff. It can only mean
   same terminal state, same ledger outcome, same resources released, PR opened.

**Feature parity is a written checklist over the behavior inventory, not a feeling.** Every
inventory item carries exactly one mark: *ported*, *ported-with-divergence* (pointing at the
deciding ticket — the divergence list above is this set), *not core* (hae adapter or scaffold
template; hae's three prompt files land here), *transitional* (carried only to serve the gate, then
deleted — the legacy ledger adapter), *dropped* (with a reason), or *deferred* (with a reason).
Parity is reached when no item is unmarked. Otherwise it gets declared by feel the moment someone
wants to start the switchover.

## Rejected alternatives

- **Plain TypeScript without Effect.** Then 0006's asymmetry argument wins outright: the rewrite of
  the proven half becomes a pure loss, and the untested half gains nothing structural over bash's
  `trap`. Effect is what makes the trade positive; without it there is no case. It is also
  explicitly **not** the fallback if the tripwire fires — that would be a third rewrite nobody has
  costed.
- **`effect@4.0.0-beta` now.** Would avoid a known migration, but incubation *is* the experiment
  measuring agent productivity, and the beta confounds it. Deferred with a placement rule rather
  than avoided.
- **`npx github:org/repo#<sha>`, with a committed `dist/` or with a `prepare` build.** Both looked
  cheapest and both now fail cold under npm v12's defaults (`allow-git=none`, install scripts
  blocked, explicitly including under `npx`) until every adopter weakens their security defaults.
- **JSR.** npm-compatibility tarballs still lack `bin` and there is no npx equivalent — both open
  issues since 2024.
- **`bun build --compile`.** Drifts into the Go/Rust binary posture 0006 rejected, whose costs (CI
  cross-compilation, release infra, binaries in git) are fixed and immediate while its benefits
  amortise over user counts we do not have.
- **`@effect/cli` prompts for the picker.** No fuzzy filter, and the picker is the richest surface
  in the tool and where it is actually used. Handing it the weaker option to save one
  `acquireRelease` bracket is the wrong trade.
- **gum / fzf / a homegrown filter prompt.** All three exist to fill gaps clack does not have.
- **`Shell.exec` as a service tag.** Recreates exactly the subprocess-mock shape whose weakness is
  the argument for this port in the first place.
- **A provider abstraction for the container runtime, now.** An interface generalised from one
  implementation generalises wrong; the tag is already the seam.
- **Event-log-as-truth for the ledger, now.** Architecture spent on a consumer that does not exist.
  The record is designed derivable from the event stream so the promotion stays additive.
- **Per-subcommand layers.** Multiply the `provide`-vs-`provideMerge` confusion that is the top LLM
  failure mode in Effect.
- **eslint + prettier** (plugin graph to maintain; `@effect/eslint-plugin` is dead, last published
  2025-04-24), **biome** (a third toolchain for zero gain over oxc), and **dprint** (Effect's own
  choice, and the runner-up — taken only if matching Effect's code shape beat matching this repo's
  client, which it does not).
- **Bridging Effect diagnostics into oxlint's type-aware rules.** Available, but means typechecking
  twice and two rule configs to drift. One typecheck, one config.
- **Branching hae's setup hook on a task kind**, or appending a directory-guarded `npm ci` line to
  it. Both edit the dispatch path — the untested half — to accommodate a guest, and bake a
  placeholder into `run.sh`.
- **`git subtree split` for extraction.** Takes one prefix, and would give history to the least
  argumentative artifact while dropping it from the most: the new repo's inhabitants are agents, and
  they need the *why*.
- **Unchanged from 0006 and not revisited:** Go/Rust binary, the Claude Agent SDK, Textual, a
  localhost web UI, plain tool-on-PATH, vendored-copy-with-hash-guarded-sync.

## Consequences

- **Two ports of the same tool are in flight simultaneously**, deliberately. One of them is
  discarded work; which one is decided by evidence at a fixed moment against fixed criteria. This is
  the cost of reversing 0006 rather than the cost being hidden.
- hae keeps running the bash hybrid untouched through the entire incubation and the entire post-move
  sequence. The only hae-side changes before switchover are the node bump, one line in each of two
  prompts, and one `exclude:` line.
- **Node ≥ 26 becomes a dispatching-host prerequisite** for anyone who installs the TS tool. It is
  not a container prerequisite: an adopter's task container may contain no node at all.
- **Adopter onboarding**: install Node ≥ 26, add the committed shim plus a pinned SHA, run
  `speepobox init`, edit the scaffolded Dockerfile and setup hook. No global install, no build step,
  no registry account.
- **No release infrastructure exists or will be built.** Upgrading is a reviewed one-line SHA repin
  against a commit that is on default with CI green. The acknowledged trade from 0006 carries over:
  a repin does not show the core diff in the consuming repo's PR, so read the upstream diff before
  bumping.
- **Supply-chain surface grows** relative to 0006's stdlib-first python. The runtime tree is
  `effect` + `@effect/platform-node` + `@effect/cli` + `@clack/prompts` (four small deps, no native)
  on a credential-adjacent tool that pushes code. Mitigations: exact pins, a committed lockfile that
  is itself the shipped artifact, `npm ci --omit=dev --ignore-scripts` in the shim (so no install
  script from any dependency ever runs on an adopter machine), and no auto-update bot on `effect`.
  Judged worth it because the dependencies are the load-bearing rationale, not conveniences — but it
  is a real regression against stdlib-first and is not dressed up as free.
- **T1 is front-loaded.** The skeleton carries the toolchain pins, the verify gate, the config
  decode-once layer, the subprocess chokepoint with its grep bans, nine `doctor` probes, and the
  strip-safety tracer. That is deliberate: every one of them is a decision already taken, and the
  alternative is discovering the distribution model does not work after four bullets of code exist.
- **`doctor` gains two probes and loses two.** New: config decodes, runtime root writable. Dropped:
  `gum` and `fzf`. Changed: host `node` ≥ 26 replaces host `python` ≥ 3.14.
- **The ledger is not backward compatible**, and `status` shows half the world during incubation
  because the runtime roots are split. Both are accepted and temporary; both end at switchover's
  atomic commit.
- **If Bessemer wins the bake-off, the post-move sequence is abandoned rather than completed**, and
  ADR 0008 records that outcome in the same form. That exit is written down here so it does not have
  to be argued for later.
- hae's sandboxing guide and `.agentbox/ROADMAP.md` need updating at switchover, when the bash
  core they document is deleted.
