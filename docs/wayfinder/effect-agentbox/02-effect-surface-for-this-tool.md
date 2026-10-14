# 02 — Effect's surface for a subprocess/resource orchestrator

Labels: `wayfinder:research`
Map: [MAP.md](MAP.md)
Blocked by: —
Assignee: research subagent (charting session, 2026-07-29)
Status: **closed** 2026-07-29 — findings at `research/02-effect-surface-findings.md`

## Question

The map's Effect rationale rests on two claims. Verify both against the current Effect release,
and surface what they cost.

**Claim 1 — scoped resources + typed errors.** Does `Scope`/`Effect.acquireRelease` actually
guarantee release across the failure modes this tool has: process exit, SIGINT/SIGTERM, an
uncaught defect, a killed child process? Container teardown, lock release, and checkout cleanup
all depend on it. Report the finalizer-on-interrupt story and any gaps.

**Claim 2 — Layer/Context as the ops-as-library seam.** How do services get defined, composed,
and swapped for tests today (`Context.Tag` / `Effect.Service` / `Layer`)? What does faking a
Docker or git service in a test actually look like versus mocking a subprocess?

Also inventory, with current API shapes:

- `@effect/platform` `Command` / `CommandExecutor` — argv/env control, stdout/stderr streaming,
  exit codes, timeouts, killing children. This is meant to be the single typed chokepoint that
  replaces bash's shell-interpolation surface.
- `@effect/cli` — command/flag parsing, and its built-in prompts: what they look and feel like,
  whether they are testable, and whether they plausibly retire `gum` + `fzf` and close the
  clack-polish gap.
- `@effect/vitest` — testing ergonomics for Effect code.
- `Effect.Config` and `@effect/schema` (or `effect/Schema`) — fit for two-layer file config with
  a precedence chain, and whether TOML/JSON/YAML parsing is in or out of scope for them.
- Concurrency primitives relevant to per-branch locking and future parallel dispatch.

**Costs, reported honestly**: current major version and how much API churn has landed recently;
how much of the public API renamed in the 3.x line; bundle/dependency footprint of
`effect` + `@effect/platform-node` + `@effect/cli`; and — most important for this plan — the
known failure modes when an LLM writes Effect (Layer variance, `R`-channel inference, generator
ergonomics, mixed-version training data). Cite real examples where you can find them.

## Answer

Full findings at [`research/02-effect-surface-findings.md`](research/02-effect-surface-findings.md),
verified against `effect@3.22.0` / `@effect/cli@0.76.0` / `@effect/platform-node@0.108.0`.

**Claim 1 (Scope/acquireRelease) — holds, with four named gaps.** Finalizers run on success,
failure, defects, and interruption; `NodeRuntime.runMain` converts SIGINT/SIGTERM into fiber
interruption (source quoted in the doc). Gaps: no SIGHUP handler (matters for AFK runs over
SSH/tmux); a second Ctrl-C hard-kills mid-teardown; `runPromise` entrypoints get no signal
handling at all; and Effect-TS/effect#5592 — `Command` children spawn `detached` and the v3
finalizer skips process-group cleanup when the child died to a signal. One non-Effect truth on
record: Docker containers are dockerd-owned, so teardown must be an explicit `docker rm -f`
finalizer plus a startup reconciler regardless of language. Net: the guarantee is real where
bash's was fictional, and the residual obligations are enumerable.

**Claim 2 (Layer/Context seam) — holds; strongest part of the case.**
`Effect.Service`/`Context.Tag` + `Layer.provide` are current idiom. A faked Docker service is a
`Layer.succeed` value whose own `acquireRelease` lets a test assert "reviewer pass dies → log ends
in `rm c1`" — a class of test tasklib's subprocess mocks cannot express. Caveat: the win depends
on domain-shaped services, not a thin `Shell.exec` tag (feeds ticket 05 directly).

**Most important cost — the v3/v4 boundary.** `effect@4.0.0-beta.102` is live (beta since
2026-02-18); v3 is in feature freeze; `main` no longer contains v3's platform/cli packages; CLI is
an "unstable" module in v4. Adopting now means pinning a frozen line and budgeting a known
migration.

**Bonus findings:** `@effect/cli` prompts retire gum but **not** fzf (no fuzzy filter — the
picker's branch selection needs another answer); its `ConfigFile` module ships TOML/YAML/JSON
support, which reopens TOML as the config format despite TS lacking stdlib TOML; LLM-failure-mode
evidence is mechanistically strong (the official Effect language-service plugin targets exactly
the bug classes we feared) but quantitatively unmeasured — the doc says so plainly.
