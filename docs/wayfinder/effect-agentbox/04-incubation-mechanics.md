# 04 — Incubation mechanics inside hae

Labels: `wayfinder:grilling`
Map: [MAP.md](MAP.md)
Blocked by: —
Assignee: Scott Bowles
Status: **closed** (resolved 2026-08-05)

## Question

The TS package lives as a self-contained top-level dir in hae (decided during charting) and is
built by hae's *existing bash* agentbox dispatching agents at it. Pin down what that actually
requires.

- **Layout and toolchain** — dir name (`speepobox/`, settled by ticket 07), package
  manager (hae's image ships node 22 + corepack/yarn + npm; `client/package.json` uses yarn), TS
  config, test runner, lint/format config. Deliberately *not* a yarn workspace with `client/`.
- **Dispatch path** — what has to change in `.agentbox/Dockerfile`, `build-image.sh`, and
  `setup-db.sh` so a dispatched agent can install deps and run the TS test suite inside the
  container. Does the setup hook need a branch for TS-package tasks? Does the container have
  network for a package install, or must deps be baked into the image?
- **Review-pass gate** — what command the reviewer agent runs for TS work (typecheck + lint +
  tests) and how that is expressed given `review-prompt.md` is currently hae-shaped.
- **Isolation** — keeping the new package out of hae's pre-commit (`black`/`isort`/`oxlint`/
  `oxfmt` configured for `api/` and `client/`) and out of hae CI, so it can't break hae's gates
  and hae's gates can't dictate its style.
- **Issue location** — implementation issues go to `.agentbox/tasks/effect-agentbox/issues/`,
  which is gitignored (`tasks/*/`). Confirm that's acceptable for work that will be lifted to
  another repo, or decide otherwise.
- **Move-out plan, sketched** — `git subtree split` vs a fresh repo with history import; what
  else (prompts, ADRs, docs) travels with the package.

## Carried in from ticket 01

The chosen distribution model (clone-run shim executing TS source directly under Node type
stripping) sets a **node ≥ 24 floor** — but hae's agentbox image ships **node 22**.
Incubation has to resolve this:
bump the image to node 24 (affects hae's client tooling in the same image — check yarn/vitest
compatibility), or run the TS package under `tsx`/vitest during incubation and only require
node 24 at the shim boundary post-move. Decide here; the dispatched agents' test commands depend
on it.

## Answer

Resolved by grilling, 2026-08-05. The governing principle that decided most of it:
**hae's dispatcher is not modified to accommodate its guest.** The TS package incubates as a
guest in hae's client configuration and uses hae agentbox as it is. Ticket 03 established that
the dispatch core is agentbox's *untested* half — 618 lines with no oracle — so every edit to it
is risk taken against the very thing doing the dispatching. The one exception is the node bump,
which the package cannot run without.

The second principle, surfaced during the grill and worth carrying forward: **a client's stack is
the client's business.** Three surfaces were being blurred and are now separated —

1. **the client's project tests and package manager** — entirely the client's, reached through
   its setup hook and its spec's verify commands. A PHP client with no node at all is fine.
2. **the tool's own dependency install** — npm, because that lockfile is what the shim consumes.
3. **the tool's own tests** — node's stripper must accept *the tool's* source; a client's source
   never goes near it.

This also tightens ticket 01's node floor: **the tool runs on the dispatching host, not inside
the task container** (as `run.sh` does today — host-side orchestration, `docker exec` into the
container). Node ≥ 26 is a *dispatching-host* prerequisite; a task container may contain no node.

### 1. Node version — bump to 26

The image's node moves from 22 to **26**, matching hae CI, which already runs node 26. So the
bump is *less* speculative than staying: CI already proves the client hooks pass on 26.

Chosen over "stay on 22, run under tsx/vitest during incubation" because that option means the
novel, unproven half of ticket 01's answer — type stripping over Effect source — never executes
during the entire incubation, and first runs for real after the move, when the shim is also new.

Mechanical rider: the tag must track the **base image's Debian release**, since the Dockerfile
copies node's binaries into the api image and glibc has to match. `node:26-<debian>-slim`, not
blindly `bookworm`.

### 2. Dispatch path — no change to `run.sh`

- **Network**: `run.sh:1286` drops all capabilities but adds no `NET_*` and sets no
  `--network none`; ADR 0005 keeps egress open. Dependencies install at task time. **Nothing has
  to be baked into the image.**
- **Setup hook**: left exactly as it is. `run.sh:1321-1327` unconditionally runs the served repo's
  setup hook (settings, database, client install). All of it is dead weight for a TS-package task,
  and all of it stays. That waste is ~1–2 minutes of wall clock against tasks that run 10–60
  minutes.
- The agent runs `npm ci` in the package dir itself; the spec tells it to. No shared npm cache
  volume for now — if install time bites, that is one mount line and reversible.

Rejected: branching the setup on a task kind (invents a task-kind concept in bash that the TS port
will define properly anyway), and appending a dir-guarded `npm ci` line (still edits the setup path
and bakes the placeholder dir name into `run.sh`).

**The reason this is right, not just cheap**: hae's setup step is not the dispatcher's business —
it is *hae's client configuration*. In the finished product this is a per-repo setup hook that each
client owns. Post-move the new repo becomes its own client with its own setup, hardcoded first and
hook-driven once the hook exists. That keeps `setup script v1/v2` where the map already has it —
**out of scope** (Phase C).

### 3. Review-pass gate — one generic line in both prompts

This is the one place the incubation *does* edit shared files, because the alternative is unsafe.

`pre-commit run --files speepobox/...` **passes**, because hae's typecheck, lint, and format hooks are scoped to its own
code; only the generic whitespace and JSON hooks match. An agent obeying
`implement-prompt.md`'s "VERIFY (must pass before you commit)" would get a **green from a gate that
checked nothing** — no typecheck, no lint, no tests.

Fix: add one conditional sentence to `implement-prompt.md` and `review-prompt.md`, phrased
generically and **naming no directory** so it survives ticket 07's rename:

> If the spec names its own verification commands, those are the gate — run them in place of the
> Django/client commands above.

Inert for every hae task. Not a concession either: a spec that names its own gate should override
the default gate regardless of language.

What those commands *are* (typecheck + lint + tests) is stated per-issue by the spec, and lands in
ticket 08's T1 issue. The lint half depends on ticket 11.

### 4. Isolation — exclude the dir from pre-commit outright

hae CI reaches the dir only through its pre-commit config, so that is the **one lever**: exclude
it there.

Half the isolation is already free — hae's language-specific hooks are scoped to its own code and
cannot see a top-level dir. The unfree half is the global hooks, and CI fails the build if a hook
*rewrote* anything. Known immediate collision: `check-json` versus
`tsconfig.json`, which conventionally carries comments.

Resolution: add the package dir to the top-level `exclude:` regex at `.pre-commit-config.yaml:1`.
One line, and it is the only option satisfying the requirement in **both** directions — the package
cannot break hae's gates, and hae's gates cannot dictate its style. Package hygiene becomes its own
toolchain's job, enforced by the spec-named gate from §3.

Rejected: fixing collisions individually as they surface (concedes direction two, and each new
collision is found as a red CI run), and excluding-then-adding a scoped hook that runs the
package's suite (inverts direction one — hae PRs would then fail on the TS package's health).

**Rename touch-point**: that exclude line carries the placeholder dir name. Ticket 07 updates it;
move-out deletes it.

### 5. Issue location — tracked, under `docs/wayfinder/`

`.agentbox/tasks/effect-agentbox/issues/` is gitignored by `tasks/*/`
(`.agentbox/.gitignore:11`), whose rationale is sound for hae's own queues: "local per-dev queues —
`Status:` lines churn... derived state (ADR 0005)". But these issues are not a per-dev queue; they
are **this map's stated deliverable**, and the map's Notes require specs to be committed repo
markdown.

Two facts from `run.sh:125-134` made this easy:

- `--feature <folder>`: "anything with a slash is a path used as-is." A tracked location outside
  `.agentbox/tasks/` needs **no dispatcher change**.
- "issue files live outside the checkout" — the dir is mounted `:ro` at `/feature-issues` and
  `Status:` lines are rewritten **host-side**. The agent structurally cannot commit Status churn,
  which was the objection expected to be decisive.

So: T1–T4 issue files live at **`docs/wayfinder/effect-agentbox/issues/`**, tracked, co-located
with the map that produced them, dispatched via the slash-path form. `Status:` progression becomes
reviewable history for an effort where that history is the point. No gitignore surgery, and ADR
0005's rule stays intact for everything else.

**This revises the map** (Notes) and **ticket 08**, both of which named the `.agentbox/tasks/` path.

### 6. Move-out — `git filter-repo`, multi-path, copy not move

`git subtree split` takes **one** prefix, and the package dir is not the only thing that must
arrive. Use `git filter-repo` with multiple paths, preserving history for:

- the package dir itself
- `docs/wayfinder/effect-agentbox/` — map, tickets, research findings, and (per §5) the issues
- ADRs 0004, 0005, 0006 — 0006 especially, since this map's ADR is required to confront its
  argument head-on
- hae's sandboxing guide (not carried)
- `.agentbox/run.sh` and `.agentbox/tasklib.py` — **the behavior-spec oracle.** The map fixes these
  as the behavior source with no intermediate spec doc, and feature parity happens *after* the
  move, so without them the post-move parity work has no reference to work against.

**Not travelling**: hae's `implement-prompt.md`, `review-prompt.md`, `pr-prompt.md` — hae-shaped,
and ticket 01 already has the tool shipping its own package-default prompts as plain files inside
the cloned tree.

**Copy, not move.** hae keeps its originals and keeps running bash agentbox until the post-move
switchover deletes hae's `.agentbox` core. Nothing in hae breaks on move-out day.

Chosen over subtree-split-the-package-only (gives history to the least argumentative artifact and
drops it from the most — the new repo's inhabitants are agents, and they need the *why*, which
lives in the research docs and ADR 0006) and over a fresh no-history repo.

Remaining move-out mechanics — CI, release, and branch protection in the new repo — stay map fog
and sharpen at ticket 09.

### 7. Toolchain summary

| Concern        | Decision                                                                    |
| -------------- | --------------------------------------------------------------------------- |
| Dir name       | `speepobox/` — settled by ticket 07                                          |
| Package manager| **npm** — the committed lockfile is what ticket 01's shim consumes           |
| Node           | **26**, matching hae CI                                                      |
| Test runner    | **vitest + `@effect/vitest`**, plus a strip-safety smoke step (below)        |
| Lint / format  | **open — ticket 11**                                                         |
| TS config      | T1 detail; must stay within what node's stripper accepts (no enums/namespaces, no path-alias rewriting) |

**Test runner, in full.** Vitest does not use node's stripper — it transforms with its own
(esbuild/rolldown), which accepts constructs node rejects and rewrites path aliases node will not.
So a green vitest suite can ship source node cannot run. The gap is closed by a smoke step that
runs the CLI under **plain node**, and that step already exists in the plan: ticket 08's T1 tracer
is "`doctor` green." Run `doctor` under plain node and **the tracer *is* the strip-safety check** —
free, and it stays closed on every subsequent tracer.

Chosen over `node:test` under type stripping, which would close the gap by construction but give up
`@effect/vitest` (`it.effect`, `TestClock`/`TestContext` wiring, scoped tests) — a cost landing
directly on dispatch-core **test quality**, which ticket 02 named as one of the two things the
bake-off is scored on.

**Lint/format** was the one thing this ticket could not settle without facts, and it graduated to
research ticket [11](11-lint-format-toolchain.md). Partial findings already reverse its premise:
`oxlint-plugin-effect@0.6.0` exists (13 style/discipline rules) and oxlint's type-aware linting
works, but **no rule detects a floating Effect** — verified by negative result on a fixture where
the plugin was demonstrably active. The correctness argument that was meant to select the linter
has no oxlint implementation, so unless the eslint half turns one up, ticket 11 demotes to a T1
implementation detail. It also strengthens ticket 06's note that the **Effect language-service
plugin** is the strongest available mitigation for agent-authored Effect.
