# 05 — Effect architecture: services, error channel, Scope seams

Labels: `wayfinder:grilling`
Map: [MAP.md](MAP.md)
Blocked by: ~~02~~, ~~03~~ (both closed 2026-07-29) — **unblocked, on the frontier**
Assignee: Scott Bowles (claimed 2026-08-06)
Status: closed (2026-08-06)

## Question

Design the layering that carries the map's two load-bearing claims. Uses 02's verified Effect
surface and 03's behavior inventory.

- **Service boundaries** — what is a service and what is a plain function. Candidates from the
  inventory: Docker, Git, Gh/forge, filesystem, clock, ledger, task store, config, notifier,
  prompt loader, locks. Each one is a seam that must earn its place; a service per subprocess is
  not automatically right.
- **Error channel** — which failures are typed errors versus defects. What the taxonomy is, and
  where the boundary sits between "the dispatch failed, clean up and report" and "the tool is
  broken".
- **Scope seams** — where `acquireRelease` brackets sit so that container, lock, and checkout are
  released on every exit path, including interrupt. This is the claim the bake-off is scored on;
  it has to be structural, not a `try/finally` habit.
- **Ops-as-library / CLI-as-renderer split** — the concrete shape: operations return data, the
  CLI renders it. What the return types look like, and what a second frontend (a future
  dashboard) would consume without a rewrite.
- **The single subprocess chokepoint** — how every child process's argv and env flows through one
  wrapper, and how the credential-isolation invariants become enforced-by-construction rather
  than reviewed-by-eye.

## Carried in from ticket 02

- **Services must be domain-shaped, not a `Shell.exec` tag** — the findings doc is explicit that
  Claim 2's testing win evaporates behind a thin subprocess service. The service list above should
  be judged against that bar.
- **Signal/teardown obligations to design in**: SIGHUP handler (AFK over SSH/tmux),
  second-Ctrl-C behavior, `NodeRuntime.runMain` as the only entrypoint idiom, detached-child
  cleanup (#5592), and — since containers are dockerd-owned — an explicit `docker rm -f`
  finalizer **plus a startup reconciler** that sweeps orphans from prior crashed runs. The
  reconciler is a new component the bash spine never had; place it.
- **Config**: `@effect/cli`'s `ConfigFile` ships TOML/YAML/JSON — decide format and how it maps
  onto the two-layer precedence chain (flags > env > local > committed > auto-detect).
- **Picker**: `@effect/cli` prompts have no fuzzy filter — decide the branch-selection UX
  (small homegrown filter prompt vs optional fzf vs no fuzzy).

## Carried in from ticket 03

Two invariant gaps in the bash spine that the port must close **by construction**, not by
convention — they are concrete tests of whether the "enforced-by-construction" claim above is
real:

1. **"Task containers publish no ports" is unenforced** — it holds only because no `-p` appears in
   `run.sh:1249-1263`. The Docker service's container-spawn API should make published ports
   unrepresentable, or at minimum type-gated behind an explicit escape hatch.
2. **Origin URL flows into the agent-readable clone** (`run.sh:959` → `run.sh:1205`), carrying a
   token whenever a dev's remote is HTTPS-with-userinfo. The port should strip or refuse userinfo
   on any URL crossing into the sandbox — a natural job for a parsed, validated remote type rather
   than a string.

Also note: invariant 3's "hardened `upload-pack`" is upstream git behavior, not a flag agentbox
sets — so the port inherits it rather than implementing it. Worth stating explicitly so nobody
later "reimplements" a guarantee that was never local.

Design pressure from the same ticket: the dispatch core's four resources (lock, rotated log,
checkout, container) are released by one 18-line `trap cleanup EXIT`, shaped around a real macOS
bash 3.2 bug that leaked a container after every completed run. That leak is the canonical example
the `Scope` claim is meant to make structurally impossible — use it as the worked example when
designing the bracket seams.

## Answer

Resolved 2026-08-06 by grilling. Twenty-two decisions, grouped by the ticket's five areas.

### 1. Service boundaries

**Services (own `Context.Tag`):**

| Tag | Shape | Why it earns a tag |
| --- | --- | --- |
| `Sandbox` | scoped `run(spec)` / `exec` / `remove` | the resource whose leak 03 documents; scoped in the *interface* |
| `Git` | clone / fetch / push / rev-parse over branded types | domain-shaped, and the branded `RepoUrl` carries invariant 2 |
| `Forge` | `gh` PR view / create / edit | swappable, and the one network surface with no local oracle |
| `AgentCli` | `implement` / `review` / `describePr`, **single-shot** | the Phase-C provider seam, prepared for free |
| `Ledger` | append / resolve-last / resolve-resume | the durable outcome record |
| `IssueStore` | parse / select / set-status | tasklib's issue half |
| `Notifier` | notify | trivially fakeable, keeps notifications out of the core |
| `RunLock` | scoped acquire over a PID file | cross-process claim; see §3 |
| `PromptSource` | `get(name)` returning text **plus which root won** | client-facing extension point; see §5 |
| `Reporter` | structured in-flight events | the second-frontend seam; see §4 |
| `AgentboxConfig` | one decoded record | see §5 |
| `Prompt` | interactive prompting behind clack | Promise/TTY bracket boundary; see §5 |

Effect's own `FileSystem` / `Path` / `Clock` / `CommandExecutor` are used directly — no wrappers.

**Plain functions, no tag:** prompt assembly and interpolation, slug/cid/checkout-path derivation,
topological issue ordering, table rendering, gc classification, config decoding, liveness
predicates. Pure — a fake buys nothing.

**Naming (Q22).** The container service is `Sandbox`, not `Docker` — role, not vendor, because the
name steers what agents write into the interface and this port's top cost is agents writing
Effect. Docker implementation is `Sandbox.dockerLayer`. **No provider abstraction is built**
(YAGNI): the tag *is* the seam, and an interface generalized from one implementation generalizes
wrong. Two cheap costs paid now instead: the role name, and a spec type expressed in our
vocabulary (image reference, mounts, env allowlist) rather than as a `docker run` flag bag.

The term collides in hae — ADR 0004 is titled "two sandboxed lanes: native-sandbox interactive
host + homegrown agentbox async parallel" — but the other referent is a hae workflow concern this
tool never implements, and 0004 is already partially superseded. Post-move, *sandbox* has exactly
one referent. **The ADR carries one disambiguating line** for readers of the inherited ADRs.

### 2. Error channel

**Rule (Q2): the outcome-row test.** If the run still writes a ledger row and a human-readable
failure, it is a typed error. If the tool's own invariants are violated, it is a defect. Cleanup is
unaffected either way — `Scope` releases on both — so this decides *reporting shape*, not resource
safety.

- **Typed:** `SandboxError`, `GitError`, `ForgeError`, `AgentPassFailed`, `LockHeld`, `LedgerError`,
  `ConfigError`, `GuardRefused` (protected branch, self-base, declined confirm, blocker). Preflight
  failures (no docker, no `gh` auth, no image) are typed — they are today's exit-1-with-message path.
- **Defects:** impossible states (slug-derivation mismatch, an unparseable ledger line we just
  wrote), `Command.runInShell` reached, a missing tag at runtime.

### 3. Scope seams

**One `Scope`, opened after every guard passes** — preserving 03's stated invariant that nothing is
touched before `check_no_inflight_run`. Acquisition order `RunLock` → checkout → sandbox; release
reverses automatically. Log rotation is a plain effect, not a resource (logs are never deleted).

**Checkout release is derived, not flagged (Q10).** The release always attempts the FF fetch-back;
keep-vs-delete falls out of whether the commits made it home — which is the rule `run.sh:1176-1182`
already implements, minus the mutable state. **The release swallows its own failure**: logs loudly,
keeps the directory, never fails the scope, because an Effect finalizer that fails becomes a defect
and would mask the run's real error.

Two of 03's leak gaps close for free: `claude_pass`'s scratch file (`run.sh:1091`, leaks on
interrupt) and the `--feedback-edit` temp file (untrapped window between `run.sh:920` and `1189`)
are both bracketed. This is the Claim-1 evidence the bake-off is scored on.

**A failed agent pass ends the run (Q16R).** `AgentCli.implement` is single-shot, and the dispatch
core runs it once. Nothing wraps it in a `Schedule`.

Q16 asked only *where* retry lives, taking retry itself as inherited from bash. That premise expired
on 2026-08-10, when bash agentbox removed retry outright (`306f1bf14d`, 16:16). The evidence was that
morning's dispatch of the superseded T3: attempt 1 ran 26 minutes and died on exhausted credits, and
attempts 2 and 3 then each died in 30 seconds against the same exhausted quota
(`.agentbox/logs/speepobox-t3.log.1`, 10:49–11:17). Every failure at this seam is systematic rather than flaky —
credentials exhausted, config wrong, container gone — so a second attempt buys a fresh cold session
against an unchanged condition. What makes that affordable is checkpointing: the agent commits each
coherent piece as it goes, so a failed pass keeps whatever it finished, and the useful response is a
human reading the log.

Q16's stated testability benefit — a fake `AgentCli` failing twice then succeeding — goes with the
behaviour it was testing. The sandbox-gone predicate survives as a *cause* on the pass failure, not
as an abort condition on a schedule that no longer exists.

**`RunLock` is a PID file, not a `Semaphore` (Q17).** The real contention is two `agentbox`
invocations in two terminals; an in-process primitive is the wrong tool however idiomatic. Scoped
acquire writes the PID, release removes it, and a lock whose PID is dead is reclaimable using the
same predicate the reconciler uses — stale-lock handling becomes part of acquisition rather than an
afterthought.

**Signals (Q13R / Q15).** Four interruption paths, one behavior change:

| Path | Behavior | vs today |
| --- | --- | --- |
| Ctrl-C once | full teardown | same |
| terminal/SSH drop (SIGHUP) | full teardown | **new** — today leaks a container silently |
| Ctrl-C twice | hard exit, reconciler reclaims | same |
| `kill -9` / power loss | uncatchable, reconciler reclaims | same |

SIGHUP is justified on "closed the terminal tab", **not** on SSH/tmux — verified: no tmux, nohup,
SSH-dispatch, or SIGHUP handling exists anywhere in `run.sh` or the agentbox docs, so 02's
"AFK over SSH" framing overstated current usage. `NodeRuntime.runMain` is the only entrypoint idiom
(`runPromise` banned by the same CI grep as `runInShell`). Effect bug #5592 is sidestepped by never
spawning detached children: sandboxes are dockerd-owned, so the finalizer is `docker rm -f` and the
agent pass runs `docker exec` in the foreground.

**Reconciler (Q11 / Q14) — the component the bash spine never had.** Runs on every dispatch
preflight, generalizing the per-slug stale clear at `run.sh:1161-1162` to all slugs. It
**auto-reclaims only the provably dead** and reports everything else; silent deletion of a possibly
live run is how you kill a colleague's dispatch. `gc` keeps the aggressive/interactive path over the
same pure classification functions.

*Provably dead* requires all three: labels match this repo, the lock's recorded PID is not alive, the
sandbox is not running. **Ownership stops being inferred from the container name.** Today it is the
`agentbox-` prefix (`run.sh:1167`, `tasklib.py:724`), which matches anyone's unrelated container and
— worse — matches agentbox running in a *second repo on the same host*. The port labels every
sandbox `agentbox.managed=true` + `agentbox.repo=<hash of repo root>` and filters every reconcile
query on both. Unlabeled containers are invisible regardless of name; the name survives for human
readability only. Prefix sweeping is retired, including in `gc`.

### 4. Ops-as-library / CLI-as-renderer

**Final values (Q12):** every operation returns a `Schema`-defined domain value — `DispatchOutcome`,
`StatusSnapshot`, `GcPlan`, `IssueSelection` — so JSON serialization for a future dashboard is free
and the CLI is pure render functions over them.

**In-flight progress is a `Reporter` service, not a log file** — ops emit structured events; the CLI
subscribes and renders; a dashboard later subscribes to the same stream. The rotated log file becomes
a `Reporter` *implementation*, not a parallel path. This is what makes "a second frontend without a
rewrite" true rather than aspirational: under the log-file-only shape a dashboard re-parses text the
CLI already had structured. Cost is one tag in the `R` channel of most ops; tests get a `Reporter`
that appends to a `Ref`, which is also how dispatch ordering gets asserted.

**Default CLI presentation:** agent-pass output renders through clack's `taskLog` (continuous output,
last lines visible, cleared on success — the Claude Code behavior), review and land steps through
`spinner`. A renderer choice over the event stream, not new architecture.

**`--dry-run` becomes a layer swap (Q20).** Today it is 78 lines (`run.sh:1647-1724`) that re-derive
slug/cid/checkout/log with *duplicated* expressions and re-implement the `gh pr view` probe — a
second implementation free to drift. In the port it is the same dispatch effect run against a layer
whose mutating services are no-ops that record intent: same guards, same derivation, same ordering,
one code path. **This is the cleanest demonstration of Claim 2 in the whole port.** Caveat for the
ADR: a no-op layer rehearses *our* logic, not docker's — a dry run still cannot prove `docker run`
would have succeeded, exactly as today.

**Entrypoint (Q21):** one `AppLive` layer wired at the entrypoint and provided to every subcommand,
with services acquired lazily inside their own scoped constructors — so `status` provides `Sandbox`
but opens nothing until it queries. Per-subcommand layers were rejected: they multiply the
`provide`-vs-`provideMerge` confusion 02 names as the top LLM failure mode, and this port's leverage
is agents writing the code.

**Ledger (Q18R): greenfield record, tolerant legacy import.** `runs.jsonl` is gitignored, local, and
per-repo — not a shipped artifact — and the bake-off is scored on cleanup and test quality, not on
comparing histories, so backward compatibility earns little. Three flaws in today's schema justify
the break: `spec`/`feature` are a nullable pair encoding a mode (`resolve_resume` recovers the mode
by checking which field is non-null), `issues`-vs-`outcome` repeats that same discriminant
unenforced, and there is no run id, no start/end, no duration, no exit reason — every "why did that
run take 40 minutes" is unanswerable. The new record: tagged union for run identity (one-off /
feature / feedback-resume), explicit `schemaVersion`, run id, start + end, terminal reason, base and
merge-base SHAs, PR number alongside URL. A read-time adapter decodes old lines, deleted at
switchover. **The record is designed to be derivable from the `Reporter` event stream**, so promoting
events to source-of-truth later is additive, not a rewrite — event-log-as-truth was considered and
deferred as architecture spent on a consumer that does not exist yet.

### 5. The subprocess chokepoint, and the surfaces around it

**Chokepoint is an internal module, not a tag (Q3)** — a tag here would recreate the `Shell.exec`
anti-pattern 02 warns about. One file is the only place allowed to import `Command`, enforced by
lint/CI grep, alongside bans on `Command.runInShell`, `Effect.runPromise`, and container-name-based
ownership queries. It sets `shell: false` (already the default) and **`extendEnv: false` with an
explicit allowlist** — the default inherits `process.env` and would leak the parent env into agent
containers.

**03's two invariant gaps close by construction, not by review:**

1. **No published ports** — the sandbox spec type has *no ports field at all*. Not a flag to misuse,
   not an escape hatch: unrepresentable.
2. **Origin URL userinfo** — `RepoUrl` is a branded parse whose constructor strips or refuses
   userinfo. No string-typed URL crosses into the sandbox.

Invariant 3's hardened `upload-pack` is **inherited upstream git behavior, not a flag agentbox sets**
— stated explicitly so nobody later "reimplements" a guarantee that was never local.

**Config (Q7): Effect owns sourcing, we own shape.** A `ConfigProvider` stack expresses the
precedence chain (flags > env > local > committed > defaults); **one layer decodes it once** into a
typed `AgentboxConfig` record provided as a tag. Rejected alternatives: pure per-call-site `Config`
reads (config fails deep inside a dispatch instead of at startup, and the shape is written down
nowhere), and hand-rolled sourcing (reimplements what Effect ships). The decode-once shape matches
03's invariant that nothing is touched before guards pass — a malformed config fails before the run
exists. Tests are `Layer.succeed` over an object literal, cheaper than building provider maps.

**Format (Q4): TOML** via `@effect/cli`'s `ConfigFile` — `.agentbox/config.toml` committed,
`.agentbox/config.local.toml` gitignored. Ticket 01's pinned tool SHA lives in the committed layer;
it must travel with the repo.

**Prompts (Q6 / Q9): `PromptSource` tag, whole-file override plus a fragment.** It earns a tag on the
precedence logic (client `.agentbox/prompts/*.md` beats package defaults, unchanged from ADR 0006 and
unproblematic under 01's clone-run shim) and on being the surface clients extend — not on file
reading, which `FileSystem.layerNoop` already fakes. It returns the resolved text **and which root
won**, because run.sh logs the assembled prompt verbatim and a client needs to see their override
actually take. Interpolation stays a pure function.

Override granularity is **whole-file replacement only**, plus a separate small `project-context.md`
fragment the default prompts interpolate — for the narrow, common case (a PHP client's test command,
setup notes). The fragment is what 90% of clients want and it survives the default prompts improving
underneath them; whole-file override is the escape hatch. Fragment-patching a template was rejected
as a mini-templating-language.

**Prompting UI (Q8 / Q5): clack for all interactive prompting**, behind a narrow `Prompt` tag;
`@effect/cli` retained for argument parsing and `ConfigFile` only. Mixing both would mean two visual
languages in one tool, so it is one or the other.

- clack (`@clack/prompts` 1.7.0, released 2026-07-03, four small deps, no native) ships
  `autocomplete` / `autocompleteMultiselect`, closing the fuzzy gap 02 found — **no homegrown filter
  prompt, no optional fzf**. Also `taskLog`, `spinner`, `progress`, matching run.sh's 30s heartbeat
  and 120s console line.
- It decouples the UI from `@effect/cli`, which 02 flags as **unstable in v4** — worth real money
  while the v3/v4 boundary is live fog.
- Costs, accepted: a Promise boundary, so every prompt needs an `acquireRelease` restoring TTY raw
  mode (abandon a clack promise on an external fiber interrupt and the terminal wedges); cancel is a
  sentinel via `isCancel`, not a rejection. The `Prompt` tag is where that bracket lives and what
  lets picker flows be driven headlessly in tests.

Rationale: the picker is 1139 lines of tasklib today — the richest surface in the tool, and where it
is actually used. Handing it the weaker option to save a bracket is the wrong trade.

**Incubation runtime state (Q19): separate root.** At the move-out bar ("TS agentbox dispatches a
one-off task on itself") two dispatchers exist on one host, both resolving repo root to hae and both
defaulting to `.agentbox/` for ledger, locks, and checkouts — one unproven, one the daily driver.
Two tools writing one lock directory with different staleness rules is a data race. Since the runtime
root is a config value (Q7), this is a **default in the committed config, flipped at switchover** —
no structural cost. Q14's labels already split sandbox ownership in one direction; this closes the
other. `status` showing half the world during incubation is accepted and temporary.

Note this is *only* about self-dispatch: hae dispatching TS-port work through bash agentbox is
ordinary usage, and agentbox knows nothing about what it is building.

### Design rules for the ADR

1. Services are **domain-shaped**, never mechanism-shaped. A `Shell.exec` tag scores no better than
   tasklib's subprocess mocks (02's explicit caveat) — write this as a rule, not an assumption.
2. Security invariants are **unrepresentable-if-violated**, not reviewed-by-eye.
3. Ownership of runtime resources is **declared** (labels), never inferred (names).
4. Finalizers never fail the scope.
5. Rehearsal modes are **layer swaps**, never second implementations.
