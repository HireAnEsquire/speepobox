# Agentbox: ticket-linked dispatch, user-owned branches, continue-by-default iteration

Date: 2026-07-20. Partially supersedes [0004](0004-agent-sandboxing-workflow.md) (dispatch
pipeline, branch naming, re-dispatch semantics, egress posture). The container/security core of
0004 — hardlink clone, in-container PostGIS, credential-less container, host-side push, human
merge gate — is unchanged and remains mandatory.

## Context

The wishlist for the AFK-agent workflow had four gaps against the built agentbox: no
ticket-to-agent path, iteration that discarded prior work (reset + force-push), no standardized
task sizing, and an undecided team-rollout posture. Before extending, a verified web survey
(2026-07-20, 23 sources, 25/25 claims confirmed) checked whether the ecosystem had obsoleted the
homegrown orchestrator. It had not: no hosted option (Claude Code GitHub Actions, Copilot cloud
agent, Docker Sandboxes, gh-aw, Anthropic Managed Agents) provides per-task database isolation
out of the box; Anthropic's own docs bless headless `claude -p` orchestration and the
credentials-outside-the-boundary push model agentbox already uses; and the June 2026 Microsoft
disclosure (prompt injection via issue comments hijacking the Claude Code GitHub Action,
exfiltrating CI secrets) validated the credential-less container + human-reviewed-input design.
Verdict: keep and extend.

## Decisions

- **Dispatch pipeline: Jira → PRD → local-markdown issues → spec = issue file.** Jira stays the
  team's planning tool; a Jira key in the issue header and branch name keeps the link. Feature
  work is broken down with the `to-issues` skill (tracer-bullet vertical slices, AFK/HITL typed)
  into markdown issue files under `.agentbox/tasks/<feature-slug>/` (gitignored — triage status
  lines churn; durable PRDs/design docs stay committed in `docs/`). The issue file **is** the
  dispatch spec — `run.sh` already takes any path. No render step, and the self-authored-spec
  security guarantee holds because the human quiz/approve step in `to-issues` is the authoring.
  Rejected: direct Jira/GitHub-issue dispatch (unreviewed third-party text as agent instructions
  — the demonstrated injection vector); a Jira adapter (agent-sized micro-issues would spam the
  team board). A `issue-tracker-jira.md` adapter remains possible later.
- **Sizing rubric = vertical slices that fit one implement pass.** A task is one coherent
  PR-able end-to-end slice with named acceptance tests, no overlap in files or migrations with
  other tasks in flight, and small enough to implement within the per-pass timeout (default
  900s). Oversized → split at `to-issues` time.
- **Branches are user-owned and mandatory: `--branch <name>` names THE working branch.** The
  agent's checkout forks from the branch tip; the host pushes results back to that same branch;
  the draft PR goes from it into `--base`. The branch must already exist (hard error if not —
  creating branches is the developer's act), and `master`/protected branches are refused as
  `--branch` (they are now push targets, unlike 0004's fork-point-only base — this is not a
  re-litigation of the 2026-07-20 "master as base is safe" call; the model changed). Supersedes
  auto-named `agent/<user>/<slug>` branches and slug-derived task identity: branch = task
  identity (container, lock, log keyed off it).
- **`--base` loses its fork-point role but stays, with three jobs.** The developer picks the fork
  point by creating the branch, so `--base` (default `origin/master`) is now only: (1) the PR
  target — required for stacked runs, since a branch's parent isn't recorded in git and
  auto-detecting it is fragile; (2) the diff boundary for the review and PR-description passes,
  computed as `merge-base(branch, base)` (the fork SHA is meaningless once branches pre-exist);
  (3) the reset target for `--hard-reset`. It is never pushed to and never forked from.
- **Per-feature run ledger + interactive base step.** The orchestrator appends one record per run
  (timestamp, branch, base, issues, per-issue outcomes, PR URL) to a machine-written file in the
  feature's task directory (`.agentbox/tasks/<feature>/runs.jsonl`, gitignored with the rest).
  The picker lists a feature's branches from the ledger most-recent-first (with last base, issues
  done, PR link) plus a "new branch" entry. When `--base` is omitted, the default chain is: the
  ledger's last base for the chosen branch → `master` — so a branch once stacked on another keeps
  defaulting to it. Interactive steps appear **only when stdin is a TTY**;
  backgrounded/scripted runs take the default chain silently and log the choice (a backgrounded
  script blocking on stdin would hang — the same TTY rule gates all interactive steps). One
  carve-out to branch-must-exist: the interactive picker may offer to create a missing branch
  behind an explicit y/N confirm — still the developer's act; the flag path
  stays a hard error so scripts never create branches silently. Picker shape (as built,
  2026-07-22): step 1 also accepts an **ad-hoc typed prompt**, materialized host-side into
  `.agentbox/tasks/ad-hoc/<timestamp>-<slug>.md` and mounted like any spec (never shell-inlined;
  rerunnable and ledgerable); the issue step **auto-skips** when a feature has exactly one issue
  and in one-off-spec/ad-hoc paths, and offers an **All / All unfinished** shortcut when several
  are ready; the branch step is a **curated menu** — this task's ledger branches (annotated with
  last base / issues done / PR link; the checked-out branch flagged undispatchable and listed
  last) plus a "New branch" entry and an "Other" fuzzy-finder over all local branches; creating
  a branch asks which ref to **branch off & PR into** (pinned as the run's base so the fork
  point can't diverge from what the y/N confirmed, and created `--no-track` so a later plain
  `git push` can't land on the base); the base step is **quiet-until-typed** — Enter takes the
  chain default, typing fuzzy-matches refs live (the list stays empty until the first
  keystroke), and any git-resolvable ref is accepted verbatim. Cancel is two-level: Esc in a
  sub-prompt (name entry, fuzzy find, create-base) returns to its parent menu; Esc/Ctrl-C at a
  top-level step aborts the picker. Every step prefers `gum` (menus, multi-select, confirms,
  input) and `fzf` (fuzzy finding, rendered inline via `--height`, never fullscreen) when on
  PATH, degrading independently per step to numbered-list/`input()` prompts — neither binary is
  ever required. The
  ledger is derived state: git stays the source of truth, and a stale or deleted ledger only
  degrades defaults, never correctness.
- **Iteration defaults to continue-on-branch.** Re-dispatch forks from the current branch tip
  and appends commits — no force-push. Feedback reaches the agent only through self-authored
  channels: edits to the spec/issue file or a `--feedback "…"` CLI argument. PR review comments
  are never auto-ingested (untrusted-text channel). `--hard-reset` restores the old semantics: reset
  to the base fork point and redo (force-with-lease push). The PR body is regenerated from the
  full diff on every landing; the existing open PR is updated, never duplicated.
- **CLI: one task per invocation.** `run.sh <spec> --branch <name> [--base ref] [--feedback …]
  [--hard-reset]`. Parallel waves = multiple invocations (backgrounded shells); the per-branch
  lockfiles + container-name check remain the duplicate-dispatch guard. `--jobs` is dropped —
  with one task per invocation and feature runs sequential in one container, per-invocation
  parallelism no longer exists (a repurposed global container cap was considered and rejected as
  a knob without a demonstrated need). Rejected: `spec:branch` pair syntax (kept the
  one-invocation wave but complicated the CLI for a solo workflow).
- **Feature-run mode: work a `to-issues` breakdown sequentially, PR shaping stays with the
  user.** `run.sh --feature <folder> [--issues 02,04] --branch <name>` runs the selected (default:
  all unblocked AFK) issues from `.agentbox/tasks/<feature>/issues/` in dependency order, in ONE
  container on the supplied branch — implement + review loop **per issue**, commits accumulating,
  PR body updated after each issue with a per-issue checklist. **Run = (selected issues, branch);
  one run = one branch = one PR.** PR granularity is composed across runs: re-running remaining
  issues with the same branch continues it and updates its PR; giving a different branch opens a
  second PR — so the developer decides how a ticket's slices split into PRs, run by run. Chaining
  across unmerged work uses existing levers only: create the new branch from the prior one and
  pass `--base <prior-branch>` for a clean stacked draft PR. Guards: every selected issue's
  `Blocked by:` must be `Status: Done` or selected earlier in the same run — otherwise refuse at
  dispatch. **Stop rule: stop and land what's done.** A review loop ending needs-work, a failing
  issue, or the next unblocked issue being typed HITL stops the sequence; completed issues are
  pushed and the draft PR opens/updates with the stop reason; `Status:` lines record per-issue
  outcomes (host-side — issue files live outside the checkout). Resume = another run on the same
  branch. Rejected: skip-and-continue independents (later slices silently assume the skipped
  slice's behavior); all-or-nothing landing (wastes completed work). **Selection UX: both** an
  interactive no-arg picker (feature folders → issues with Status / AFK-HITL / Blocked-by) and
  the explicit flags for scripted dispatch.
- **Review stays two layers.** In-container reviewer with verdict-break loop (cap 3), then the
  human on the draft PR. No second-model or pre-PR host-side review layer for now.
- **Egress stays open, with free hardening added.** The 0004 revisit trigger ("shared beyond
  one machine") was evaluated against the survey's findings and re-accepted at solo scope: an
  allowlist proxy would break `yarn install` binary downloads (GitHub Releases, nodejs.org),
  mid-task dependency self-serve, pre-commit hook-env rebuilds, and WebFetch documentation
  lookup — and its misses surface as AFK timeouts, the worst debugging position in the
  pipeline; meanwhile the supply-chain channel (npm postinstall) stays open regardless. Instead,
  adopt the zero-cost hardenings: `git clone --no-hardlinks` (closes the shared-object-corruption
  residual), and Anthropic's hardened `docker run` flags (`--cap-drop ALL`, pids/memory limits).
  Refined revisit triggers: a real secret enters the container, specs stop being self-authored,
  or a shared/central runner appears.
- **Rollout: solo for now.** Team sharing (the sixth wishlist item) is deferred until the new
  dispatch/iteration features stabilize; agentbox stays on the `agentbox` branch meanwhile. When
  it happens: merge to master, onboarding doc (build-image, `claude setup-token`,
  `.agentbox/.env`), pilot with 1–2 devs — and the egress question re-opens per the triggers
  above.

- **Hybrid implementation: bash spine, Python helper (decided 2026-07-21).** `run.sh` keeps
  what bash is proven at here — process lifecycle, docker, git, traps, the security-sensitive
  push path — and stays one readable file. The data/UI logic of feature-run, ledger, and picker
  (issue parsing, dependency ordering, JSONL, interactive menus) lands in a host-side
  stdlib-only Python helper (`.agentbox/tasklib.py`, subcommands; same pattern as
  `stream-filter.py`) that run.sh calls and consumes line-oriented output from. Rationale: those
  additions would roughly triple the bash with exactly the logic bash fails silently at
  (word-splitting, `set -u` array traps, subshell state); a full Python rewrite was rejected —
  the proven bash core would be churned for no gain and the "transparent script" premise still
  holds with one spine + one testable helper.

## Future direction (decided 2026-07-22, not yet built)

- **Codex/agent adapter: deferred to its first real consumer (reversed 2026-07-22).** The
  original plan was to build agent-agnosticism next; scoping revealed the dispatcher doesn't
  use Codex, doesn't hold its credentials, and couldn't test the result — while the teammates
  who do use Codex reach it through Cursor, whose headless story is unknown here. Building the
  adapter now would mean guessing a contract for consumers whose usage is unobserved — the
  same trap the library-extraction deferral avoids. Whoever first wants a non-Claude agent
  extends it; the shape agreed if/when built: sourced `.agentbox/agents/<name>.sh` adapter
  files (fixed contract: preflight, invoke-with-prompt-on-stdin, live-log filter, final-text
  capture, per-agent Dockerfile layer), API-key-only auth injected at `docker run`, and the
  credential stays in the already-accepted class — an LLM-API key that can spend money but
  cannot touch git, repo hosting, or infra. Any credential outside that class entering the
  container remains an egress-revisit trigger.
- **Library extraction deferred until a second consumer exists.** The engine (~80%) is already
  generic; the hae-specific parts are already isolated files (image, setup-db.sh, .env.sandbox,
  prompt VERIFY sections). Extracting an adapter contract now would mean guessing seams with one
  repo, one team, one agent — the Sandcastle lesson in reverse. When a second repo/team adopts,
  that adoption defines the real boundary. Until then, keep the seams tidy as issues touch them.
- **Picker UI: gum-first with the existing fallback** (same pattern as fzf) — optional brew
  binary, no pip deps, stdlib-only tasklib preserved. *Built 2026-07-22; the as-built shape is
  recorded in the ledger/picker decision above.*

## Consequences

- `run.sh` changes required: `--branch` (mandatory, existence + protected-branch checks),
  continue-vs-`--hard-reset` fork logic, `--feedback` prompt injection point (host-assembled, stdin),
  non-force push on continue, branch-keyed naming, `--no-hardlinks`, hardened `docker run`
  flags, single-task CLI.
- `setup-matt-pocock-skills` must be run to register the local-markdown tracker at
  `.agentbox/tasks/` and the triage label vocabulary; `to-issues`' default `.scratch/` location
  is overridden by that config.
- The host-push security rule from the 2026-07-20 audit is untouched and load-bearing: never run
  write-side git inside the agent's clone; fetch from the clone, push from the main repo.
- hae's sandboxing guide needs a rewrite of its dispatch/iteration sections against this
  ADR when the features land.
