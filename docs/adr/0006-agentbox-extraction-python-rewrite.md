# Agentbox extraction: standalone repo, pure-Python rewrite, uvx-pinned distribution

Date: 2026-07-24. Extends [0005](0005-agentbox-dispatch-branches-iteration.md) (keep-and-extend
verdict, dispatch semantics — all unchanged) and partially supersedes the implementation posture
of [0004](0004-agent-sandboxing-workflow.md)/0005: the bash-spine + python-tasklib hybrid was
right for incubation inside hae; it is not the shape the tool leaves home in. The security core
— hardlink clone, in-container throwaway DB, credential-less container, host-side push, human
merge gate, zero write-side git inside the agent's clone — is unchanged and remains mandatory.

## Context

Agentbox is being extracted into its own repository: adoption is confirmed by multiple outside
teams. Their constraints, gathered 2026-07-24: heterogeneous stacks (Django/React, Node/Next/
SvelteKit, PHP — the core may assume nothing about language or test tooling), not all have a
compose-built image to base on, issue locations vary, and main/master is mixed. All adopter
machines have node; all have some python3.

The tool currently has no users other than ourselves. If a rewrite is ever warranted, this is
the cheapest moment it will ever have. That question was pressure-tested rather than assumed
away, including against alternatives (TypeScript on node, Go/Rust binary, Claude Agent SDK,
Textual, a localhost web UI).

## Decisions

- **Extraction IS the rewrite: the new repo starts life as a pure-Python-stdlib port of the
  bash spine.** One migration instead of two, and the port is validated against a living
  reference: hae keeps running the current hybrid untouched until the port passes a
  parallel-run comparison on real dispatches, then installs the new tool as first adopter and
  deletes the old core. Rationale for python over keeping bash: python is already a hard host
  dependency (tasklib), so bash adds a second language while removing no requirement; the bash
  half is the untested half (all 234 tests cover tasklib — every recent bug class was
  bash-specific: `set -e` AND-list semantics, quoting hazards); and the growth direction
  (config, provider abstraction, resume recovery, setup wizard) is data-shaped, not pipe-shaped.
  Security surface shrinks: one subprocess wrapper controls every child's argv and env — no
  shell-interpolation surface. tasklib carries over largely intact with its test suite.
- **Rejected: TypeScript/node.** Viable now that all adopters have node (node 22 type-stripping
  even removes the build step), and greenfield-from-zero it would be a real contest. But half
  the system is already tested python; port-to-python rewrites only the untested half,
  port-to-TS rewrites everything including the proven half. For a working system with security
  invariants, that asymmetry decides it.
- **Rejected: Go/Rust binary.** Its benefits (no interpreter dependency, exact signed
  artifacts, Windows) amortize over large user counts; its costs (CI cross-compilation,
  release infra, no vendoring — binaries don't belong in git) are fixed and immediate. Wrong
  trade for single-digit adopting teams. Revisit only if adoption scales an order of magnitude.
- **Rejected: building on the Claude Agent SDK.** Wrong layer: agentbox deliberately
  orchestrates the `claude` CLI as a credential-isolated subprocess, and multi-provider
  support (codex/cursor) is on the roadmap — coupling the spine to one vendor's SDK fights
  both.
- **Python 3.14 via `requires-python`; no compatibility floor.** Under uvx the host
  interpreter is not the adopter's problem — uv reads `requires-python` and fetches the
  interpreter itself, so the version is a language-feature choice, not an adoption
  constraint (a lower floor would buy nothing and cost tasklib syntax churn).
- **Stdlib-first is posture, not necessity.** uv makes dependencies mechanically free for
  adopters (one pyproject line, resolved and locked invisibly), so the remaining argument
  is supply-chain surface on a credential-adjacent tool that pushes code. Default is
  stdlib; exceptions are judged on need and audit cost, with uv lock/hash pinning
  mitigating.
- **Distribution: uvx pinned from git, core never enters the consuming repo.** The committed
  `config.toml` pins a source ref (tag or commit SHA); a two-line repo shim runs
  `uvx --from git+<source>@<pinned-ref> agentbox ...`. uv resolves, caches, and supplies the
  interpreter; no PyPI publishing required. Every teammate runs the exact team-pinned version
  (the pin lives in a committed file, so the within-team version skew that killed plain
  tool-on-PATH cannot occur); upgrading is a one-line reviewable ref bump. `.agentbox/` in a
  consuming repo holds ONLY adapter files — Dockerfile (scaffolded from a template carrying
  just agentbox's needs: agent user, agent CLI, sudo'd setup hook), setup hook, config,
  prompt overrides, task content, runtime state — written by `init` once and never touched
  by any update path, so there is no clobber surface at all.
  Rejected alternatives: plain tool-on-PATH (within-team skew, install infra on day one);
  vendored-copy-with-hash-guarded-sync (shadcn/cruft/copier-style — workable, but it means
  building and maintaining installer + sync + drift machinery that uvx makes unnecessary).
  Acknowledged trade: a ref bump doesn't show
  the core diff in the consuming repo's PR the way a vendored update would — mitigated by
  pinning SHAs and reading the upstream diff before bumping. Scaffold improvements don't
  auto-propagate; a read-only `init --diff` shows adapter drift against current templates
  for apply-by-hand.
- **Config: two-layer TOML plus secrets env.** Committed `.agentbox/config.toml` for
  team-level facts (image, base, the source pin, tasks_dir when a team keeps shared issues
  in-repo); gitignored `.agentbox/config.local.toml` for dev-owned values (notify, model,
  provider, tasks_dir under the local-issues model, machine limits) — any key valid at
  either layer, local wins. Secrets stay in gitignored `.env` only. Precedence: CLI flags >
  `AGENTBOX_*` env vars > local > committed > auto-detect (base branch from
  `origin/HEAD`) / defaults.
- **Prompts: package defaults, per-repo overrides.** Prompt templates ship inside the
  package; a same-named file under `.agentbox/prompts/` wins at read time. Users edit
  freely without forking; un-overridden defaults keep improving with the pin; doctor
  reports the override count so drift is visible.
- **Setup hook: `.agentbox/setup.sh`, scaffolded once, contract not convention.**
  Idempotent, non-interactive, nonzero exit aborts the dispatch with the log. The image
  template keeps today's single-sudoers-line pattern granting root for exactly this hook
  (one auditable, human-committed file; also what lets the agent legally revive a dead
  service mid-task); the scaffold's header explains dropping the grant when the stack
  needs no root.
- **UI stays gum-only, optional; fzf retired.** gum is a single optional binary with a tested
  numbered-prompt fallback (doctor WARNs, never requires). fzf's remaining use (branch
  selection) moves to `gum filter`. Rejected Textual: a full app framework to serve a
  picker that is menus, an input, and a confirm — weight and supply-chain surface without
  need (under uvx a dependency's mechanical cost is nil, so need is the whole test; if the
  parked dashboard's trigger fires, a framework becomes needed and Textual's case is
  strong). Standing UX requirement recorded: prompt flows should aim for the cohesive
  clack-style polish of vite/sveltekit-class CLIs — achievable in stdlib ANSI without a
  framework; the picker port evaluates a small internal prompt-rendering module that may
  retire gum entirely. Rejected building the localhost web UI now: no parity target for the
  port's validation, and its trigger (parallel-run monitoring pain) hasn't fired.
- **Operations as library, frontends thin.** The port keeps every operation (dispatch, status,
  gc, ledger, selection) as functions returning data, with the CLI as a renderer over them —
  so a future dashboard (Textual or stdlib-http localhost web, decided when its trigger
  fires) is a frontend choice, not a rewrite. A localhost server that can trigger dispatches
  will need its own security grill (loopback-bound, token-gated, DNS-rebinding/CSRF).

## Consequences

- hae's `.agentbox/` keeps working unchanged through the port; the switchover is a deliberate,
  reversible install of the new tool once parallel-run passes.
- The new repo's design (name, package layout, config format, setup-hook contract for
  non-postgres stacks, parallel-run protocol) continues in the extraction grill; this ADR
  fixes language, distribution model, UI posture, and layering so that work has a floor.
- Adopter onboarding cost: install uv (one curl), run `agentbox init`, edit the scaffolded
  Dockerfile/setup hook. No pip, no venv, no interpreter management — uv handles the
  python side entirely.
- The parallel-run acceptance gate before hae switches (single current user, so
  lightweight): read-only commands (`status`, `doctor`, `gc` list, `--dry-run`) validated
  side-by-side any time; dispatch gate = one feature-mode multi-issue run, one one-off,
  one resume-with-feedback, one failure path handled correctly — outcome parity (branch,
  PR, ledger, Status writes), not byte-identical logs. Old core stays in hae until all
  four land clean.
