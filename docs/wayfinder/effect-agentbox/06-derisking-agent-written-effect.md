# 06 — De-risking agent-written Effect

Labels: `wayfinder:grilling`
Map: [MAP.md](MAP.md)
Blocked by: ~~02~~ (closed 2026-07-29) — **unblocked, on the frontier**
Assignee: agent session (claimed 2026-08-06)
Status: closed (2026-08-06)

## Question

The plan's leverage is agentbox dispatching AFK agents to build agentbox. The plan's biggest
cost is that Effect is where AFK agents produce plausible code that doesn't compile — Layer
variance, `R`-channel inference, generator ergonomics, and 3.x API churn mixing the training
data. Left unaddressed, this cost lands exactly where the leverage was supposed to come from.

Decide the mitigations, and decide how much they're worth:

- **Version pinning** — pin Effect exactly (not a range) so agents see one API. What's the
  upgrade ritual?
- **Package-local agent guidance** — a `CLAUDE.md`/`AGENTS.md` or a repo skill inside the package
  carrying the idioms, the current API shapes, and the known traps. What goes in it, and who
  keeps it current?
- **Hard gates in the review pass** — `tsc --noEmit` and lint as a verdict-break condition, so a
  non-compiling dispatch never reaches a PR. Confirmed against 04's review-pass design.
- **Tracer-bullet sizing** — whether Effect work needs smaller issues than the current
  "one reviewable concern, 20+ minutes means it bundles two" rule.
- **An early tripwire** — some concrete signal, during T1/T2, that says "agents can't write this
  productively, fall back to plain TS or reconsider." What is it, and what happens if it fires?

## Carried in from ticket 02

- **The v3/v4 boundary is now this ticket's hardest sub-question.** v3 is feature-frozen; `effect@4.0.0-beta` is live (beta since 2026-02-18); `main` no longer contains v3's platform/cli
  packages; CLI is "unstable" in v4. Pinning v3 buys API stability for agents but guarantees a
  migration; starting on the beta means agents write against an API their training data barely
  contains. Decide the line and the migration budget.
- **The official Effect language-service plugin targets exactly the bug classes we feared**
  (missing-Layer provision, `R`-channel mistakes). Evaluate wiring it into the review gate —
  mechanically it's the strongest mitigation found; quantitative evidence on LLM failure rates is
  thin and the findings doc says so.
- Scope gaps that agent guidance must cover as idioms: no SIGHUP handling by default,
  `runPromise` entrypoints bypass signal handling (always `NodeRuntime.runMain`), detached-child
  cleanup bug #5592, and Docker teardown always via explicit `docker rm -f` finalizer + startup
  reconciler.

## Carried in from ticket 04

- **The review-pass hard gate now has a mechanism.** 04 found that `pre-commit` on the package dir
  passes while checking nothing, and resolved it by adding a line to both prompts deferring to
  spec-named verification commands. So "`tsc --noEmit` and lint as a verdict-break condition" is
  expressed **per-issue in the spec**, not by editing the dispatcher. Confirm that this is a strong
  enough gate — the prompt line makes the spec's commands authoritative, but nothing forces an
  issue to name them.
- **Lint is a weaker mitigation than hoped.** Partial findings for ticket 11 show
  `oxlint-plugin-effect@0.6.0` ships 13 rules, all style/discipline, and **none detects a floating
  Effect** — verified by negative result on a fixture where the plugin was demonstrably active.
  oxlint's type-aware machinery works (`no-floating-promises` fires on real Promises) but no rule
  covers Effect values. This raises the weight on the **Effect language-service plugin** noted
  above: it is now the strongest mechanical mitigation identified, with no lint-rule backstop
  behind it.
- Toolchain context for the pinning question: npm, node 26, vitest + `@effect/vitest`, Effect
  pinned exactly (this ticket decides the version and the ritual).

## Answer

Resolved 2026-08-06 by grilling. Three facts checked at resolution time reshaped the question
before any decision was taken:

- `effect` `latest` is **3.22.1** (2026-07-30 — v3 is feature-frozen but still patched);
  `beta` is **4.0.0-beta.104** (2026-08-06). Still beta after ~6 months.
- `typescript` `latest` is **7.0.2** — the Go compiler is GA. `@effect/language-service`'s README
  now says: on TS ≥ 7, use **[`@effect/tsgo`](https://github.com/Effect-TS/tsgo)** instead
  (0.33.0, published 2026-08-06, "targets **Effect V4** primarily and also Effect V3").
- **The Effect diagnostics run in CI, and always could.** Two modes: patched-`tsc` (one typecheck,
  diagnostics emitted as ordinary TS diagnostics, exit code configurable per severity) or
  standalone `diagnostics --project` (no patch, structured output). The plugin option
  `includeSuggestionsInTsc` is documented verbatim as "useful to help steer **LLM** output".
  `overview` ("very useful for LLMs") and `layerinfo`, which prints a working **Suggested
  Composition** for a layer, are **editor-only language-service features, not CLI subcommands** —
  corrected 2026-08-10 after T2 tried to run one. `effect-tsgo`'s CLI is `patch`, `unpatch`,
  `get-exe-path`, `diagnostics`, `setup`, `config`. Only `diagnostics` and the `patch`-ed `tsc` are
  reachable from a script or a container.

### 1. Pin `effect@3.22.1` exactly; v4 is a post-move issue

v3, not the beta. Incubation **is** the experiment testing whether agents can write this
productively; running it against an API their weights barely contain confounds the one
measurement the map cares about. 02's counter-argument — v4's CLI is unstable — has already been
defused by 05, which demoted `@effect/cli` to parsing + `ConfigFile` and put clack in front, so
v4's CLI module is no longer the lever it was.

**Re-open trigger**: if `effect@4` reaches the `latest` dist-tag before T1 starts, this decision
reopens.

**Upgrade ritual: frozen for the whole incubation.** v3 is feature-frozen, so patch bumps buy
nearly nothing while each risks shifting the API surface `AGENTS.md` describes out from under it.
One exception — a bump that fixes a bug actually hit, taken deliberately, with `AGENTS.md`
reviewed in the same PR. No renovate/dependabot on `effect`. The v4 migration is its own issue in
the **post-move sequence** (ticket 09), not a dependency bump.

### 2. Toolchain bundle: `effect@3` + `typescript@7` + `@effect/tsgo`

Chosen over the alternative of staying on `typescript@5/6` with `@effect/language-service patch`
— the well-travelled v3 path, but it stands on a line the vendor has explicitly told you to leave
and forfeits the oxlint type-aware bridge. tsgo is where the rules, the bridge, and the
LLM-steering options are being developed, and TS 7 matches hae's client, which already runs tsgo.
Accepted cost: `effect@3` + tsgo is the less-travelled of tsgo's two supported combinations.

### 3. The gate: errors + warnings break, suggestions print — behind one `verify` script

**(a) Severity.** `ignoreEffectErrorsInTscExitCode: false`, `ignoreEffectWarningsInTscExitCode:
false`, `ignoreEffectSuggestionsInTscExitCode: true`, `includeSuggestionsInTsc: true`. Errors-only
is **not** enough: `scopeInLayerEffect` — `Layer.effect` where `Layer.scoped` was needed, i.e.
**silently dropped finalizers**, the exact bug class this port exists to eliminate — defaults to
*warning*. Suggestions still print, unfiltered, because the vendor built that flag to steer LLM
output.

**(b) Enforcement.** 04 left the gate expressed per-issue in the spec, with nothing forcing an
issue to name the commands. Closed without touching the dispatcher: the package ships a single
**`npm run verify`** (typecheck-with-diagnostics + lint + tests), and the package's **issue
template pre-fills its Verify section with that one command**. Skipping the gate now requires
deleting a line rather than merely forgetting one. This also closes 04's false-green trap, where
`pre-commit` on the package dir passes while checking nothing.

### 4. Guidance lives in `<package>/AGENTS.md`, and carries only what the gate cannot catch

**Form.** A committed `AGENTS.md` at the package root — **not** a repo skill. Skill bodies are
gitignored here (only `ai-skills.toml`, `tools/ai-skills/`, and `ai-skills/local/` are committed),
so a skill does not exist inside the task container's clone at all. `AGENTS.md` is read by the
agent in the container by proximity, by interactive sessions, and travels with the directory
through the `git filter-repo` move-out.

This is **our development surface only**. The prompts the tool ships to its own future users are
05's `PromptSource` tag and `project-context.md` fragment — a different surface.

**Selection rule — the file's whole editorial policy.** The gate puts ~50 diagnostics in front of
the agent, each firing at the exact line with its rule name. Anything with a rule name is
therefore already told to the agent, at the moment it is wrong, better than prose can — and
documenting it again is what `/writing-for-agents` calls a **cache of a cheap lookup**. So
`AGENTS.md` carries **only what no diagnostic can catch**:

- 05's decisions no rule knows — the `Sandbox` name (role not vendor), the **outcome-row test**
  for typed-error-vs-defect, `--dry-run` as a layer swap.
- Runtime gotchas with no static signal — SIGHUP tears down, detached-child cleanup bug #5592,
  Docker teardown via an explicit `docker rm -f` finalizer plus the startup reconciler.
- Pick-one rulings where **both options typecheck** — `Effect.Service` vs `Context.Tag`.

Cut: floating effects, missing layer/effect context, `scopeInLayerEffect`, the `Effect.gen`
adapter, `runEffectInsideEffect` — every one has a rule. Also cut: generated `overview` output,
which is a cache that goes stale the moment it lags the code; the agent can run the command.

**Phrasing.** No "do not reach for" list — `/writing-for-agents` names **negation** as a failure
mode, since a prohibition drags the banned behaviour into context and makes it *more* available.
State the positive target: "entrypoints use `NodeRuntime.runMain`", never "don't use
`runPromise`".

**Ownership.** The **review pass** owns the file: when a dispatch fails on an Effect problem, the
fix PR appends the trap — **but only if the gate could not have caught it**. If a rule exists and
was merely off, the fix is turning the rule on, not writing a paragraph.

**Authoring.** The issue that writes it invokes `/writing-for-agents`. `/ask-matt` is a
`disable-model-invocation: true` human-invoked router and, like every skill here, is unreachable
from inside the container — so it stays an interactive tool for the dev, never a reference *in*
the file.

### 5. Tracer-bullet sizing is unchanged; the spec hands over the wiring

No Effect-specific size rule. Agents fail on Effect at the **wiring** — composing layers, lining
up the requirements channel — not on volume of code, so splitting an issue in two does not reduce
wiring; it adds a seam and makes the dominant failure mode *more* frequent.

This also protects the ~100k smart window rather than spending it: layer-composition failures do
not burn tokens linearly, they spiral — a wall of inference errors, a fix, a different wall. The
spiral is what eats the window. So each Effect issue's spec **names the tag and pastes the
composition**, written out verbatim so the agent copies a working `Layer.provide` / `provideMerge`
order instead of deriving it.

> **Amended 2026-08-10.** This ruling originally said the composition was "generated mechanically by
> `effect-language-service layerinfo --name <Layer>`". There is no such command: `layerinfo` is an
> **editor-only** language-service feature, and `effect-tsgo`'s CLI ships `patch`, `unpatch`,
> `get-exe-path`, `diagnostics`, `setup`, and `config` — see the corrected finding in §0 above. T2's
> reviewer twice reported, correctly, that it could not produce the output, and both reports cost a
> review round against an impossible criterion.
>
> The ruling itself is unaffected and is load-bearing: **copy, do not derive.** Only the source
> changes — take the composition from the composition root (`src/app.ts`), which is the authority in
> any case. The general rule this exposed: **every acceptance criterion must name a command that runs
> inside the container.**
>
> "Sizing is unchanged" did not survive T3 either: it packed four services into one bullet and died,
> so the working guideline is now **one service per ticket** — [08](08-in-hae-sequence.md)'s
> amendment of the same date records the calibration.

### 6. Tripwire: a measured signal that surfaces a decision the user makes

Over the first ~8 dispatched issues, count those needing **≥2 redispatches whose failure was an
Effect type/diagnostic error** (not domain logic) — countable from the ledger, not a vibe.
Threshold: **more than half**.

Firing does not stop anything by itself. It escalates mitigation (suggestions promoted to errors,
`AGENTS.md` thickened with the observed traps) and re-measures over the next 8. **The user is the
final decider on stopping**; a second firing is the moment to say it likely should stop. The
fallback is **not** a plain-TS rewrite — that is a third rewrite nobody has costed. The map
already has a live alternative, so the bake-off resolves in **Bessemer's** favour and the Effect
port ends.

### Effects on other tickets

- **11 (lint/format)** — its negative result is **reopened**. `@effect/tsgo` "ships a way to emit
  additional **Oxlint Type Aware rules**" and has a `floatingEffect` rule; 11's finding that no
  rule detects a floating Effect was against `oxlint-plugin-effect`, a different thing. But the
  **bridge is declined here**: `verify` already gets the diagnostics from the single typecheck
  run, and a second path to the same findings means typechecking twice and two configs to drift.
  So the floating-Effect gap is closed by tsc-mode diagnostics, and 11 reverts to ordinary
  style/format criteria — confirming its own suspicion that it is now low-stakes.
- **12 (test strategy)** — tsgo ships `floatingEffectInVitest` ("Effects returned from
  non-Effect-aware Vitest callbacks"), which is directly in 12's territory.
- **08 (in-hae sequence)** — inherits three concrete T1 obligations: the `verify` script, the
  issue template with Verify pre-filled, and the `AGENTS.md` authoring issue.
- **09 (post-move sequence)** — inherits the **v4 migration** as an issue of its own.
