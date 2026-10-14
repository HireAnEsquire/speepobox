# Run coding agents in two sandboxed lanes: native-sandbox interactive host + homegrown "agentbox" async parallel

> **Partially superseded 2026-07-20 by [0005](0005-agentbox-dispatch-branches-iteration.md):**
> dispatch pipeline (now ticket-linked local-markdown issues), branch naming (now user-owned
> mandatory `--branch`, no auto-slug branches), re-dispatch semantics (now continue-by-default,
> `--fresh` for reset), and egress posture (open re-accepted with cheap hardening). The
> container/security core below stands.

We ran Claude Code unsandboxed on the host, approving a permission prompt per shell command and
with no isolation boundary. We moved to a two-lane sandboxed workflow so interactive work stops
spamming prompts and unattended parallel work is contained. The operational guide was hae's
`docs/AGENT_SANDBOXING.md` (not carried).

The decisions:

- **Two lanes, not one.** Interactive/HITL and async/parallel are different workloads and get different
  isolation. Lane A stays on the host; Lane B runs containers.
- **Lane A — host + Claude Code native sandbox.** Enable the built-in OS sandbox (Seatbelt on macOS) with
  auto-allow so sandboxed bash runs without prompts; writes are confined to the repo, network is denied.
- **Lane A tests run via `docker exec` into the app's dev container, keeping the host env lint-only.**
  `docker` is incompatible with the sandbox, so `docker *` is an excluded (unsandboxed) command covered by an
  existing allow rule — the test command runs promptless but outside the sandbox boundary. We chose this over
  host-native tests so there is **no second, drift-prone native toolchain** to maintain; Docker remains the
  single maintained app/test runtime. The socket carve-out is accepted only in this supervised interactive
  lane; the autonomous Lane B keeps strong isolation with its own in-container database.
- **Lane B — homegrown orchestrator ("agentbox"), not a framework.** A ~150-line bash script
  (`.agentbox/run.sh`) runs one git worktree + one Docker container per task, headless
  (the app's test suite and `pre-commit` only — no live app services). Each container runs its own
  throwaway database, so migrations and test DBs are isolated by construction.
  - *We tried the framework first.* Lane B was originally built on `@ai-hero/sandcastle` (v0.12.0) and the
    pipeline was proven end-to-end with it (dispatch → container → tests green → branch → PR). We then
    replaced it: we used only a thin slice (`createSandbox`/`run` + docker provider), fought its abstractions
    repeatedly (`copyToWorktree` can't create nested paths, yarn PnP breakage, base64 env workarounds, an
    auto-merge template we had to gut), and its security model added nothing beyond our own (container
    isolation + human PR review). A transparent script the team can read and fix, with zero dependency churn,
    is the better bet for shared infra. All substantive assets (image, DB setup, env, prompts) carried over
    unchanged. If review ambition ever grows past a single bounded reviewer (multi-lens, adversarial,
    judge/escalation), reach for the Claude Agent SDK — not a return to Sandcastle.
- **Lane B image = one unified image built `FROM` the app's image**, adding a database server, Node, and the
  Claude CLI. Reusing the app's image keeps its dependencies in one place. Built with
  `--build-arg AGENT_UID=$(id -u)` so the in-container `agent` user matches the host owner of the
  bind-mounted worktree (macOS Docker Desktop masks a mismatch; Linux does not).
- **Lane B holds no real secrets.** The app's test suite mocks all outbound HTTP. Containers use a committed
  env file of dummy values plus a local database. The only real credential is the
  Claude OAuth token, injected at run from the per-user gitignored `.agentbox/.env`, never baked.
- **Lane B egress is open (revisit trigger defined).** We originally decided Anthropic-only egress via an
  iptables allowlist, then reversed: the container holds no real secrets beyond a rotatable Claude token, the
  code already lives on GitHub, the test suite mocks all external HTTP, and open egress lets tasks
  `yarn install` and fetch packages mid-run. A proxy/firewall is real infrastructure with little to protect
  here. **Revisit if** agentbox is shared beyond one user's machine or any real secret ever enters the
  container.
- **Frontend tooling installs per task, not baked.** `run.sh` runs `yarn install` in the worktree's `client/`
  during container setup, with a shared named Docker volume as the yarn cache (first run cold, subsequent runs
  ~a minute). Baking `node_modules` into the image was rejected: the bind-mounted worktree shadows it, and a
  baked layer goes stale against the worktree's own lockfile. The install runs unconditionally — even
  "backend" tasks may touch a client file and trigger the client pre-commit hooks.
- **Dispatch = spec files, not GitHub issues.** A task is a markdown spec in `.agentbox/tasks/` (or any path),
  passed to `run.sh` as an argument. Specs are referenced **by mounted path** inside the container — never
  inlined into the prompt (inlining via `$(cat …)` is a shell-injection hazard). One feature = one spec = one
  PR. GitHub Issues isn't the team's ticket system, so an issue-scan dispatcher was dropped along with the
  Sandcastle planner.
- **Implement, then review with a verdict-break loop.** After the implementer pass, a reviewer pass runs on
  the same branch and fixes findings inline; it emits `<verdict>approved</verdict>` when clean and the loop
  breaks, capped at 3 rounds. Fixed-N blind passes were rejected as wasteful on clean diffs and insufficient
  on dirty ones.
- **Merge-back is human-gated, via draft PRs.** Each task with commits produces a branch + **draft** PR; the
  dispatching developer reviews and flips it ready-for-review for the team. Nothing auto-merges.
- **Concurrency is capped per invocation (default 3), and a duplicate in-flight task fails fast.** Each task
  builds a full test DB; uncapped fan-out melts the host. The cap applies within one `run.sh` invocation —
  separate invocations are a deliberate act by the user and are not globally throttled. Dispatching a spec
  whose container is still running errors out instead of silently killing the running task.
- **Per-user config lives in `.agentbox/.env`** (gitignored, required anyway for the token): image name, base
  ref (default `origin/master`), jobs cap, branch prefix (default `agent/<git user.name>/…` derived from git
  identity). Precedence: CLI flags > `.env` > script defaults. No committed config file — the script defaults
  are the team defaults.

## Status

- Lane A: applied and validated.
- Lane B: pipeline proven end-to-end on the Sandcastle prototype; agentbox replacement accepted, being built.

## Consequences

- Interactive sessions gain a real trust boundary: bash is confined to the repo and the network is off, so
  broad auto-allow is safe. The live `docker compose` app stack is unaffected — bind-mount hot-reload keeps the
  UI iteration loop intact.
- Testing via `docker exec` into the app container is retained as the Lane A test path (outside the sandbox via
  `excludedCommands`, covered by an existing allow rule). Host-native testing remains a documented, working
  fallback but is deliberately not the daily path.
- Async runs are additive to the git flow: N tasks = N branches = N draft PRs the developer reviews at their
  pace. Two branches adding the same migration number produce two leaves, resolved normally with
  a migration merge. Specs that touch overlapping files or both add migrations should not be dispatched
  in the same wave.
- The app's test suite must run without a broker; that fix must be on the base ref.
- Owning the orchestrator means owning its bugs: worktree/container leaks on crash are handled with an EXIT
  trap, and per-task logs land in `.agentbox/logs/<slug>.log` for AFK debugging.
