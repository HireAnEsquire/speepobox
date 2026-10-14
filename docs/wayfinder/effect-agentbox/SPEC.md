# bessemer — implementation spec

Companion to [ADR 0007](../../adr/0007-agentbox-effect-typescript-port.md). The ADR records *what
was decided and why*; this spec records *the shape an implementing session builds against*. Where
they disagree, the ADR wins and this file is wrong.

**Behavior source of truth was `.agentbox/run.sh` + `.agentbox/tasklib.py`, read directly.** No
intermediate language-neutral behavior document existed or was written — that was decided during
charting. The inventory at [`research/03-behavior-inventory.md`](research/03-behavior-inventory.md)
is the index into those two files (`file:line` anchors throughout); use it to navigate, not as a
substitute. Both files travelled to the new repo as the parity oracle, and T137 deleted them; read
them as of `6f66e9ac891462de809d207822c77d8f27615663` with
`git show 6f66e9ac891462de809d207822c77d8f27615663:.agentbox/run.sh`.

**Every decision below traces to a resolved map ticket**, cited inline as (05 Q7) etc. The tickets
carry the argument; this file carries the result.

**Reconciled against built code through T2** (2026-08-10). Sections describing shipped work — §1's
layout, §2's boundaries, §3's taxonomy, §6, §7's `doctor`, §9, §10 — were checked line by line
against `src` and now carry what T1 and T2 actually built, cited as (T1)/(T2) where the
build refined a ticket's ruling. **Where this file and the code disagree about shipped work, the code
wins.** Everything past T2 remains proposed.

Sizes as of 2026-08-06: `run.sh` 1779 lines, `tasklib.py` 2325, `test_tasklib.py` 3703 / 337 tests.

---

## 1. Package layout and toolchain

```
<repo root>/                <- the package roots at the repo (18)
  package.json
  package-lock.json        <- shipped artifact; the shim runs `npm ci` against it
  tsconfig.json
  .oxlintrc.json           <- standalone; nothing above it to inherit from
  .oxfmtrc.json            <- standalone
  AGENTS.md                <- hand-seeded; agent guidance, not user-facing prompts
  ISSUE_TEMPLATE.md        <- Verify section pre-filled with `npm run verify`
  scripts/check-bans.ts    <- the §9 grep bans, run by `npm run lint`
  src/
    bin.ts                 <- the only entrypoint; NodeRuntime.runMain
    app.ts                 <- appLiveFor / appBaseLiveFor, the composition root; see §2
    reporter.ts            <- the Reporter tag and its event union
    config/                <- BessemerConfig tag, schema, provider chain, repo/package roots
    internal/exec.ts       <- the subprocess chokepoint; only file importing Command
    ownership/labels.ts    <- the label pair; creation and query read from one list
    doctor/  ledger/  status/
    ...
  test/
```

| Concern | Decision | Ticket |
| --- | --- | --- |
| Package name / bin | `@hireanesquire/bessemer` / `bessemer` | 07, 18 |
| Package manager | **npm** — the lockfile is what the shim consumes | 04 |
| Node | **≥ 26**, `engines` enforced. A **dispatching-host** prerequisite; the task container may have no node | 04 |
| `effect` | **`3.22.1` exact**, no `^`; v4 is a post-move decision, not a bump | 06 |
| `typescript` | `7` | 06 |
| `@effect/tsgo` | latest — **typecheck path only**, never the lint path | 06, 11 |
| `@effect/cli` | latest — **argument parsing + `ConfigFile` only**, not prompts | 05 |
| `@clack/prompts` | `1.7.0` — all interactive prompting | 05 |
| Test runner | `vitest` + `@effect/vitest` | 04 |
| Lint / format | `oxlint` + `oxfmt`, **both pinned exact**, `typeAware` **off** | 11 |

**TS config must stay inside what Node's stripper accepts**: no enums, namespaces, parameter
properties, or decorators in emitted output, and no path-alias rewriting. Vitest transforms with its
own pipeline and will happily accept source Node cannot run — the tracer below is what closes that
gap.

### `npm run verify` — the one gate

```
verify = typecheck && lint && test
```

- **typecheck** — `tsc` with `@effect/tsgo` patched in, so Effect diagnostics arrive as ordinary TS
  diagnostics on the **single** typecheck. Severity, non-negotiable (06):
  `ignoreEffectErrorsInTscExitCode: false`, `ignoreEffectWarningsInTscExitCode: false`,
  `ignoreEffectSuggestionsInTscExitCode: true`, `includeSuggestionsInTsc: true`. **Errors and
  warnings both break the build; suggestions print.** Errors-only would let `scopeInLayerEffect`
  (silently dropped finalizers) through.
- **lint** — `oxlint` then `oxfmt --check`, plus the grep bans in §9.
- **test** — `vitest`.

The package's `ISSUE_TEMPLATE.md` pre-fills its Verify section with `npm run verify` so that
skipping the gate requires deleting a line rather than forgetting one (06).

**Separately, and not coverable by `verify`:** `node src/bin.ts doctor` under **plain node**, no
transform. This is T1's tracer and stays a permanent gate — it is the type-stripping path the entire
distribution model rests on (01, 04).

---

## 2. Service boundaries

Twelve tags. Anything not listed is a plain function (05 §1).

| Tag | Interface shape | Why it earns a tag |
| --- | --- | --- |
| `Sandbox` | scoped `run(spec)` / `exec` / `remove`, and `build` for `image build` (P5, E10; no-op in the recording layer) | the resource whose leak the inventory documents; **scoped in the interface**, not at the call site |
| `Git` | `clone` / `fetch` (the dispatch's `origin` round trip, T70) / `fetchBack` / `push` / `revParse` over branded types | domain-shaped; the branded `RepoUrl` carries the userinfo invariant |
| `Forge` | `prView` / `prCreate` / `prEdit` | swappable, and the one network surface with no local oracle |
| `AgentCli` | `implement` / `review` / `describePr` — **single-shot** | the future provider seam, prepared for free |
| `Ledger` | `append` / `recent` / `lastBaseForBranch` (built, T2). `resolveResume` joins it with `--resume` in T16; `newestBranchForIssue` — where an issue was last worked on, the in-progress witness's hint (T74) | the durable outcome record |
| `IssueStore` | `issues` (T71) / `landedElsewhere` (T72) / `markLanded` (T77) | tasklib's issue half. **Post-move only** (P2). Reads a **ref**, never the working tree — see below. Selection is a pure function beside it (T69), not a method on it |
| `Notifier` | `notify` | trivially fakeable; keeps notifications out of the core |
| `RunLock` | scoped `acquire` over a PID file | cross-process claim; see §4 |
| `PromptSource` | `get(name)` → text **plus which root won** | the client-facing extension point; see §8 |
| `Reporter` | structured in-flight events | the second-frontend seam; see §5 |
| `BessemerConfig` | one decoded record | see §6 |
| `Prompt` | `select` / `autocomplete` (options as a **getter** of the query; the caller ranks, the tag never filters) / `multiselect` / `confirm` / `text` / `note`, every ask `Effect<A, PromptCancelled>` — **built** (T81) | the Promise boundary — fiber interrupt passes through as clack's `signal` option, never a manual raw-mode restore (13); see §7. `PromptClackLive` is the one importer of `@clack/prompts` (§9's bans) and is provided to the picker **and to the dispatch**, for `--hard-reset`'s confirm (T102); `status`, `doctor`, and `gc` still acquire none. A rehearsal's dispatch gets `PromptRecordingLive` instead, which records the confirm and answers yes. **What a picker produces is argv handed to `dispatchCli`, never a `DispatchRequest` built in place** |

Effect's `FileSystem` / `Path` / `Clock` / `CommandExecutor` are used **directly**, no wrappers.

**The composition root is `src/app.ts`, and it holds two layers, not one** (T1/T2, refining 05 Q21).
`appLiveFor` is the single layer every dispatch-surface subcommand receives. `appBaseLiveFor` is the same
expression differing in **one** term — a tolerant config layer that degrades a failed decode to the
committed defaults — and it is what `status`, `doctor`, and `gc` run on. Q21's ruling against
*per-subcommand* layers stands; this is the read-only/dispatch split §7 already requires, since the
three intercepted commands must work when the config they inspect is malformed. Every bullet from T3
extends `appLiveFor` and leaves `appBaseLiveFor` byte-unchanged: the read-only slice gains no dependency on
a lock, a git binary, or a docker daemon.

**`IssueStore` reads a ref and writes a commit** (ticket 14, 2026-08-14). It never touches the host
working tree, whose contents depend on whichever branch the dev left checked out — not a fact about
any issue. `issues` reads the set out of the **branch tip**, because the checkout forks from the
tip and the tip is therefore the ref whose content the agent actually sees; gating on `--base` would
gate on a ref the run never touches and would forbid stacking a branch on an unmerged blocker.
`landedElsewhere` (T72) is the derived half of the paragraph below: the selected issues, the tip
they were read at, and every **other** ref whose copy of one of their files says `Done` — one
`for-each-ref` and one batched `cat-file`, so the number of git processes is two whatever the ref
count. Only the tip is excluded, and by what a ref points at rather than by the name it carries; a
ref whose tree lacks the file and a copy that does not parse each contribute nothing, because the
scan is a witness. It takes the selected `Issue`s rather than their ids: the copy it reads at
another ref is `<folder>/issues/<stem>.md`, and an id names no file.
`markLanded` — deliberately not `setStatus` — writes `Status: Done` on **approval only**, as a
commit on the run branch, so it reaches a base in the same merge as the code it describes.
As built (T77): `markLanded({ repo, branch, folder, stems, index })` → `Option<sha>` resolves
`refs/heads/<branch>` to a SHA once, reads each `<folder>/issues/<stem>.md` at it, rewrites its
status with `withStatus`, and builds one commit — `read-tree` of that SHA into the scratch
`index` the land names under the runtime root's `locks/`, `hash-object -w`, `update-index
--cacheinfo`, `write-tree`, `commit-tree` with that SHA as parent, `update-ref` expecting it as
the old value — in the served repo, never the clone, with no working tree and no hooks. The index
is removed whether the write succeeded or not, and a branch that moved during the write fails the
move rather than losing the commit that moved it. The subject is
`docs(issues): mark <stems> Done`; `None` means no file matched and nothing was written. The land
calls it after the fetch-back and before the push, when the run approved at least one issue and
made commits of its own, and a failure is a `Warned` rather than the run's outcome. The recording
layer overrides it — the store carries its own `GitLive`, so the `Git` swap does not reach it.

`Status: Done` therefore carries exactly one meaning: **landed on this ref**. `needs-work` is a
ledger verdict and is never written to an issue file; "running" is the `RunLock` claim;
"approved-awaiting-merge" is derived — some other ref's copy says `Done` and that ref is unmerged
into tip, answered by `for-each-ref` + one batched `cat-file` (measured 0.62s over 339 refs × 8
issues, no branch-naming convention). No `merge-base --is-ancestor` guard exists or is wanted: it is
the wrong question and breaks under squash-merge, which the file-rides-the-merge design does not.

Two knock-ons this creates outside P2: the `RunLock` claim must carry its **issue set** (today it is
keyed by branch slug alone, §4, so "is issue N running" is unanswerable when one run holds several),
and the P3 picker asks for **branch before issues** — the frontier is a function of the tip, and
`--branch` must already exist, so the branch list is knowable with no issue chosen. Full ruling:
[`docs/agents/issue-tracker.md`](../../agents/issue-tracker.md).

**Host facts are resolved at the composition root and passed in** (T2). The repo root above all: it
is a filesystem path walk rather than `git rev-parse` because `status` may run no git commands, and
`repoScope` hashes it, so a worktree hashes to a different scope than its checkout.

**Plain functions, no tag** — prompt assembly and interpolation, slug/cid/checkout-path derivation,
topological issue ordering, table rendering, fuzzy ranking, gc classification, config decoding,
liveness predicates. Pure; a fake buys nothing. These are where the bulk of tasklib's genuinely
valuable tests translate.

**Naming**: the container service is `Sandbox`, not `Docker` — role, not vendor. The Docker
implementation is `Sandbox.dockerLayer`. Its spec type is expressed in our vocabulary (image
reference, mounts, env allowlist, the env file a served repo may declare), **not** as a `docker run`
flag bag. No provider abstraction is built; the tag is the seam (05 Q22).

**Rule, not preference**: services are domain-shaped, never mechanism-shaped. A `Shell.exec` tag
scores no better than tasklib's subprocess mocks, and that comparison is the whole argument for the
port.

---

## 3. Error taxonomy

**The outcome-row test** (05 Q2): if the run still writes a ledger row and a human-readable failure,
it is a **typed error**. If the tool's own invariants are violated, it is a **defect**. Cleanup is
unaffected either way — `Scope` releases on both — so this decides *reporting shape*, not resource
safety.

**Typed errors**

| Error | Raised by |
| --- | --- |
| `SandboxError` | container create / exec / remove failures |
| `GitError` | clone, fetch-back, push, rev-parse |
| `ForgeError` | `gh` PR view / create / edit |
| `AgentPassFailed` | an agent pass exiting nonzero or timing out |
| `LockHeld` | another live run owns this branch |
| `LedgerError` | append or decode failure on a well-formed path |
| `ConfigError` | malformed or schema-violating config, at startup |
| `GuardRefused` | protected branch, self-base, declined confirm, unsatisfied blocker |
| `AnswerMissing` | a dispatch answer left off the command line — no source, no `--branch`, `--feature` without `--issues`. Rendered as `GuardRefused` is; on a terminal, the picker catches it (T86) |

Preflight failures (no docker, no `gh` auth, no image) are **typed** — they are today's
exit-1-with-message path.

**`ExecError` is the chokepoint's own error and sits below this table** (T1). It means the subprocess
did not run at all — missing binary, spawn failure. **A nonzero exit is a result, not a failure**:
`exec` returns the exit code alongside both output streams, and the caller decides whether that code
is a `SandboxError`, a `GitError`, an `AgentPassFailed`, or an expected answer. A probe reading "no
such container" gets exit code 1 and a clean value, not an error to catch.

**Defects** — impossible states (a slug-derivation mismatch, an unparseable ledger line we just
wrote), `Command.runInShell` reached, a missing tag at runtime.

---

## 4. Scope seams and run lifecycle

**One `Scope`, opened after every guard passes** (05 §3), preserving the inventory's invariant that
nothing is touched before the in-flight-run check.

```
guards (all typed failures, no resources held)
  └─ Scope
       ├─ RunLock       acquire: write PID file      release: remove
       ├─ checkout      acquire: clone --no-hardlinks release: derived (below)
       └─ Sandbox       acquire: docker run + labels release: docker rm -f
```

Release reverses acquisition automatically. **The run log is a plain effect, not a resource** —
logs are never deleted, and each run writes its own file (`<slug>-<runId>.log`), so there is nothing
for a `Scope` to release and no rename that could displace an earlier run's record (ticket 16).

**Checkout release is derived, not flagged** (05 Q10). The release always attempts the FF fetch-back
from the clone; keep-vs-delete falls out of whether the commits made it home. This is the rule
`run.sh:1176-1182` already implements, minus the mutable state.

**Finalizers never fail the scope.** The checkout release logs loudly, keeps the directory, and
swallows its own failure — a failing Effect finalizer becomes a defect and would mask the run's real
error.

**Two leaks close for free**, both untrapped windows in bash: the agent-pass scratch file
(`run.sh:1091`) and the `--feedback-edit` temp file (`run.sh:920`–`1189`). The second one has
landed: `prompt/editor.ts` acquires and releases it inside the dispatch's own `Scope`, so a Ctrl-C
in the editor, a refusal on the way out, and an ordinary save all remove it on the same path (T84).

### Signals

| Path | Behavior | vs. bash |
| --- | --- | --- |
| Ctrl-C once | full teardown | same |
| SIGHUP (terminal/tab closed) | full teardown | **new** — bash leaks a container silently |
| Ctrl-C twice | hard exit; reconciler reclaims | same |
| `kill -9` / power loss | uncatchable; reconciler reclaims | same |

`NodeRuntime.runMain` is the **only** entrypoint idiom; `Effect.runPromise` is banned by grep.
Effect issue #5592 (detached-child cleanup) is sidestepped by never spawning detached children —
sandboxes are dockerd-owned, so teardown is an explicit `docker rm -f` finalizer and the agent pass
runs `docker exec` in the foreground.

### Reconciler

Runs on **every dispatch preflight** (05 Q11/Q14), generalizing bash's per-slug stale clear
(`run.sh:1161-1162`) to all slugs. It **auto-reclaims only the provably dead** and reports everything
else — silently deleting a possibly-live run is how you kill a colleague's dispatch.

*Provably dead* requires all three:

1. labels match this repo,
2. the lock's recorded PID is not alive,
3. the sandbox is not running.

**Ownership is declared, never inferred.** Every sandbox is labelled `bessemer.managed=true` +
`bessemer.repo=<hash of repo root>`, and every reconcile/gc query filters on **both**. Unlabelled
containers are invisible regardless of name. Prefix sweeping (`agentbox-*`) is retired everywhere
including `gc`; the container name survives for human readability only.

`gc` lists by default and `--force` reclaims, over the **same pure classification functions** the
reconciler uses — its listing is the reconciler's own scan (T97, T99). There is **no interactive
mode** and no per-item confirm (D9): gc stays scriptable, bash's reasoning at `run.sh:541-544`.

### Pass failure and locking

- **A failed agent pass ends the run** (05 Q16R). `AgentCli.implement` is single-shot and the
  dispatch core runs it once; no `Schedule` wraps it. Failures at this seam are systematic —
  credentials exhausted, config wrong, container gone — so a second attempt re-pays a cold session
  against an unchanged condition. The agent checkpoints its commits as it works, so a failed pass
  keeps what it finished and a human reads the log. **What the caller makes of the failure is the
  caller's**: inside a feature run's loop it is that issue's outcome and the sequence's stop, never
  the run's error, and the run still lands what the issues before it left (T76 — §11 rows 23-24,
  §12).
- **`RunLock` is a PID file, not a `Semaphore`** (05 Q17). The real contention is two invocations in
  two terminals. Stale-lock reclamation is part of *acquisition*, using the same liveness predicate
  as the reconciler. **At P2 the claim must also carry its issue set** (ticket 14): it is keyed by
  branch slug alone today, so "is issue N running" — one of the five states `IssueStore` renders — is
  unanswerable when a single run holds several issues.

---

## 5. Ops as library, CLI as renderer

- **Every operation returns a `Schema`-defined domain value**: `DispatchOutcome`, `StatusSnapshot`,
  `GcPlan`, `IssueSelection`. JSON for a future frontend is free; the CLI is pure render functions
  over these values.
- **In-flight progress is the `Reporter` event stream, not a log file** (05 §4). Ops emit structured
  events; the CLI subscribes and renders; the run log becomes a `Reporter`
  *implementation*, not a parallel path. Cost: one tag in the `R` channel of most ops. Benefit
  beyond the second frontend — the test `Reporter` appends to a `Ref`, which turns ordering
  assertions ("lock before checkout before sandbox; released in reverse") into plain value
  assertions.
- **`--dry-run` is a layer swap** (05 Q20), replacing 78 lines of re-derivation
  (`run.sh:1647-1724`). Same dispatch effect, run against a layer whose mutating services are
  recording no-ops: same guards, same derivation, same ordering, one code path. **Caveat to state in
  any write-up**: a no-op layer rehearses *our* logic, not docker's — a dry run still cannot prove
  `docker run` would have succeeded, exactly as today.
- **One `appLiveFor` layer**, wired at the entrypoint and provided to every subcommand, with services
  acquired **lazily inside their own scoped constructors** — so `status` provides `Sandbox` but opens
  nothing until it queries (05 Q21). Per-subcommand layers are rejected. The read-only slice's
  `appBaseLiveFor` is not an exception to this; see §2.
- **Each issue's spec pastes the layer composition** the issue ends at, **written out verbatim** so
  the agent copies rather than derives `provide` vs. `provideMerge` order (06 §5). Take it from
  `src/app.ts` — the composition root is the authority, and an issue must never ask the agent to run
  `layerinfo`, which is an editor-only language-service feature with no CLI. **Every acceptance
  criterion names a command that runs inside the container.**

---

## 6. Config

**Effect owns sourcing; we own shape** (05 Q7).

- A `ConfigProvider` stack expresses the precedence chain
  **flags > env (`BESSEMER_*`) > `config.local.toml` > `config.toml` > auto-detect / defaults**.
- **One layer decodes it once** into a typed `BessemerConfig` record provided as a tag. Per-call-site
  `Config` reads are rejected: config would fail deep inside a dispatch instead of at startup, and
  the shape would be written down nowhere. Decode-once matches the guard invariant — a malformed
  config fails before the run exists.
- **Format is TOML** via `@effect/cli`'s `ConfigFile` (05 Q4): `config.toml` committed,
  `config.local.toml` gitignored, local wins. Secrets stay in a gitignored `.env` only.
- The **committed** file carries the pin, `tool-sha`, which the shim reads before the package
  exists — so it must travel with the repo. It is **not a config key**: it is outside the four-layer
  chain and `BessemerConfig` does not decode it (09, P6 F7). One line grammar reads it,
  `^tool-sha[ \t]*=[ \t]*"([^"]*)"[ \t]*$`, exactly one matching line, its value a full 40-hex
  SHA (F6). The shim's `sed` and the one TS module `upgrade` and `doctor` share both implement it,
  and one test holds them to the same answers. A pin the shim cannot fetch (empty or short) refuses
  naming `git ls-remote --tags <release URL>` first — copy a release's `vN^{}` SHA onto the line —
  and `upgrade --to vN` from a hand clone second; the shim cannot run `upgrade` itself on such a pin.
- Tests provide config as `Layer.succeed` over an object literal, cheaper than building provider
  maps.

**The repin discipline (09 Q4, amended by P6 F11).** There is nothing to build or publish: the shim
fetches the SHA pinned in an adopter's config and never resolves a version from a registry, so there
is no semver and no changelog. A **release** is an annotated `v<N>` tag — only `^v[1-9][0-9]*$`
counts — cut by hand on a commit that is fit to pin, and the agent never cuts one. The tag records
the human's check; the pin stays the full SHA, so a moved tag cannot change what an adopter runs.
Underneath, one rule — **a SHA is fit to pin when it is on default with CI green.** Both halves are load-bearing and neither is checkable by the
tool: *on default* is what makes the pin reachable to anyone who did not write it, and *CI green* is
the only signal an AFK-built commit cannot self-report, since the dispatching agent runs verify
inside its own container on its own say-so (09 Q4's whole case for CI). A SHA that is green on a
branch is not fit; a SHA on default whose CI did not run is not fit. Pushes to default are not gated
before they land, so default can carry a red commit, which is why the
check is a human's tag rather than "the tip of main".

**The shim–package contract (P6 F17).** An upgraded package is run by the adopter's old shim until
`init --diff` brings the shim up to date, so the call between them is an interface across versions:

1. the entry is `node <cache>/src/bin.ts`;
2. `--repo-root <absolute>` comes first, and the rest of argv is passed verbatim;
3. `npm ci --omit=dev --ignore-scripts` prepares the tree;
4. the package cache entry is a git repository with `HEAD` at the pin and `origin` set to the
   release URL, and **the package reads nothing else from it**.

A package release never stops accepting a call an earlier shim template makes. A change is additive
and bumps the shim template's version. A test runs every shim template version that appeared in a
release, on its warm path, against the current package (F18).

**The package cache (F9, F10)** is `${XDG_CACHE_HOME:-$HOME/.cache}/bessemer/<sha>/`, shared by every
served repo on the host and never a runtime root. An entry is prepared in `<sha>.tmp.<pid>/` and
renamed into place with `fs.renameSync`, never `mv`, which nests a directory when the target exists.
Dead-pid temp directories are swept by the pid in their name; entries are never pruned, and `gc` does
not look there.

**The bessemer directory (T57, 19 §2).** Everything the tool reads from or writes to a served repo
lives in `<repoRoot>/.bessemer/`. The committed layer is `.bessemer/config.toml`, the operator's is
`.bessemer/config.local.toml`, and secrets are `.bessemer/.env` (T58 moved the read there). **The
search root is the served repo's, never the package's**: under the clone-run shim the package is a
cache clone every served repo shares, so a chain that looked beside it would read one repo's config
for all of them — and an adopter, whose checkout is not the package's, could configure nothing at
all. Config loading therefore takes `repoRoot` as a parameter, and so do the layers that decode it.

**The runtime root defaults to that same directory**, which is why it is not a constant: it cannot
be answered without being told which repo is served. A declared `runtime-root` moves the writes —
checkouts, locks, logs, the ledger — and nothing else; a relative one resolves against the served
repo, an absolute one is taken as-is. Self-hosting is not a special case: this repo's own layout is
the adopter's layout.

Keys carried over from bash (`run.sh:202-221`): image, base, max review rounds, pass timeout, pids
limit, memory, notify verbosity, tasks dir, runtime root, plus the pinned SHA.

**`sandbox-env-file`** (T61, 19 §5): optional, no default, **a single path relative to the served
repo**, rendered as `docker run --env-file <path>`. It is the one path key that is *refused* rather
than resolved when it is absolute or leaves the repo after normalization — this is the only key
whose file's *contents* enter the sandbox, so the file stays inside the served repo, where review
sees it. A declared file that is not on this host refuses before the lock, on the setup hook's rule.
A single path and not a list, because a list-valued key merges per index across the layers.
**Bessemer never opens the file; docker reads it.**

**Containment is lexical, and that is the limit of it** (T61, PR #20). `resolveSandboxEnvFile`
(`src/config/paths.ts`) joins the declared value onto `repoRoot` and compares string prefixes with
no `realpath`, so normalization catches the *spelling* that leaves the repo — an absolute path, a
`../` — and not the filesystem: a symlink sitting inside the repo and pointing out of it satisfies
the guard. Left as it is, because the property this key rests on is that the file is a committed,
reviewable part of the served repo, and a repo that symlinks its env file out of itself has made
that choice in its own tree where review sees it.

---

## 7. CLI surface

Ported from the inventory (`run.sh:60-180`). **Semantics are unchanged** except where the
expected-divergence list in ADR 0007 says otherwise.

**Dispatch forms**

| Form | Meaning |
| --- | --- |
| `<spec>` | one-off. Bare name → `<tasks-dir>/<name>.md`; **anything with a slash is a path used as-is**. Mutually exclusive with `--feature` |
| `--feature <folder>` | feature run over `<folder>/issues/*.md`, one container, one branch, implement → review per issue in dependency order, commits accumulating. **Requires `--issues`** — see below. Refused with `<spec>` and with `--task` (two tasks), and with `--resume`/`--last` (two runs — a resume replays the work set its record holds), each from the command line alone and before the ledger is read (T73). The loop runs the selection inside the one scope and stops at the first issue that does not approve, landing what approved either way; the row carries every selected id's outcome (T76) |
| `--task "…"` | one-off whose task is stated **inline** (22). The same run as `<spec>` — every guard, the lock, the checkout, the three passes, the PR — with nothing mounted at `/spec.md` and the text as what the passes are for. Recorded verbatim on the ledger row, so `--resume` replays it. Refused with `<spec>` (two tasks), with `--resume`/`--last` (a resume replays its record), with `--feedback` (two texts), and when empty. The picker offers it as the source step's `Task typed inline` row, entered through `--feedback-edit`'s editor bracket (T85) |
| `--issues a,b\|all` | feature mode only; comma list of issue ids — each matched by id, never by prefix: exact and case-insensitive, or a bare number against the id's digits (`37` selects `T37`, T68) — or the literal `all`. **There is no default** — `--feature` without `--issues` refuses (15); on a terminal, the picker asks instead (T86). `all` selects every `ready-for-agent` AFK issue whose blockers are done or also selected (T69, amending 15's *AFK, not-yet-Done*), expanded against the fork commit in the post-fetch guard phase. On a `--resume` of a feature run it only narrows (T88): `all` is refused, having two readings — its unambiguous second spelling is `--feature <folder> --issues all --branch <same branch>` — and enumerated ids must be a **subset** of the recorded set and, within that, not recorded `approved`. Beside a resume of a spec or `--task` run, which records no set, it is refused |
| `--resume <branch>` | ledger-keyed re-dispatch. Recovers mode, base, PR, branch identity, and the **recorded issue set** filtered by recorded outcomes — never a fresh scan of the recorded `task_dir` (15). Does not recover feedback |
| `--last` | sugar on `--resume` |
| no args on a TTY | the picker (T81, T82, T83, T85): four steps in order — **source** (one `select` of four kinds of row: a `[feature] <folder>` row per directory holding an `issues/` under the tasks dir, newest issue file first, above the spec rows — a host listing and a hint only — then `Task typed inline` and `Resume a run`. The task row opens the editor bracket and is handed on as `--task "<text>"`, one word; an empty editor is the source step again, not a cancel. The resume row is a `select` over `Ledger.recent`'s newest record per branch, newest first, at most ten, labelled `<branch> — <source> <outcome> <age>` through `status`' cells, and `← Back`; an empty ledger is one `no runs recorded yet` row back to the source step. Then `Add feedback?` — a `confirm`, and yes opens the same editor, whose empty result is no feedback — and the words are `--resume <branch> [--feedback "<text>"]`: **a resume asks no branch, issues, or base step**, and its summary's only edit row is `Edit source`), **branch** (one `autocomplete` over every local branch), **issues** (a feature's only, **read at the tip**: `Git.revParse` of `refs/heads/<branch>` once, then `IssueStore.issues` there; a `select` of `All ready (n): <ids>` when T69's `all` answers a set — handed on as `--issues all`, the named predicate, never the ids — `Choose…`, and `← Back`; `Choose…` is a `multiselect` over every issue in `orderIssues`' order, `Done` and `HITL` disabled, the ready set preselected, at least one required, handed on as the ids in that order; a folder the tip lacks or a file there that does not parse shows T73's sentence and returns to the branch step; a folder with no issue that can be picked there — every one `Done` or `HITL` — asks nothing, shows a note naming the folder and the branch, and does the same), **base** (the `--base` row below) — then a summary carrying the **equivalent command line**, and `Dispatch` / `Edit <step>` / `← Back` / `Abort`. An `Edit` re-runs that step and every step derived from it, in order (`DOWNSTREAM_STEPS`: source → branch, issues, base; branch → issues, base), pre-answered with the previous choice, and returns to the summary; `← Back` on the summary re-enters base, and `← Back` on a step re-enters the step before it and runs forward to where the pass was going. A feature's summary carries an `issues` line and `Edit issues`, and its words are `--feature <folder> --issues all|<ids> --branch …`. The gate is `Terminal.isTTY`, which the composition root answers from both stdin and stdout, as bash's `[ -t 0 ]` answers from stdin (T94). An argv of nothing but modifiers (`--dry-run`) counts as no args — bash's rule at `run.sh:752` — and the modifier rides through onto the words handed on and onto the printed command line. Off a terminal nothing is asked and nothing changes: a bare invocation prints usage as before, and a modifier-only one falls through to the dispatch and is refused there, which is where bash's own fall-through lands. A cancel anywhere — Esc, Ctrl-C, or `Abort` — is `!! picker cancelled` and exit 1, never 130: clack holds raw mode, so Ctrl-C arrives as its sentinel and nothing is signalled. |

**Flags seed the wizard** (T86). On a terminal, a command line that leaves a dispatch's answer
out opens the picker with every flag it did give already answered, and the picker asks only
for what is missing. It softens 15's *refuse, don't prompt* for exactly that case, and for
nothing else:

- **Only a missing answer opens the picker.** A dispatch has four: the **source** (`<spec>`,
  `--feature`, `--task`, `--resume`/`--last`), the **branch**, a feature's **issues**, and the
  base, which always has its default and so is never missing. Three refusals mean an answer is
  missing: no source (including `--issues` with nothing it could narrow), no `--branch`, and
  `--feature` without `--issues`. Each one becomes an `AnswerMissing`, which names the step and
  carries the words today's refusal prints. The picker **never** opens for any other kind of
  refusal:
  - A command line that states two of something (two tasks, two runs, two texts) is refused, as
    T67 and T73 already rule.
  - A flag typed with nothing in it is refused as the empty flag (T67).
  - `--last` never opens it, because it names its own branch.
  - A complete command line that turns out wrong (a feature folder the branch tip does not
    carry, a protected branch, the witnesses T74 checks) is refused as today, after the fetch.
    A **wrong** answer still gets a refusal, not a question.
- **Every refusal that is only about what was typed still runs first, and no git runs before
  the picker decides to open.** `--task "x" T3 --branch b` is refused as two tasks and asks
  nothing, because a question offering to drop one of them would decide for the dispatcher.
- **The flags fill in answers; they do not lock them.** The wizard runs from the top and skips
  every step a flag answered, then always shows the summary, so a mistyped flag is visible
  before a container starts. `Edit` and `← Back` can walk into a step a flag answered, with
  the cursor on the typed value. The source step hides every row the typed flags would make
  the dispatch refuse: typed `--issues` leaves only the feature rows; typed `--branch` or
  `--base` hides `Resume a run`, whose base comes from the record; and typed `--feedback` or
  `--feedback-edit` hides `Task typed inline`, since a task and feedback are two texts.
- **The words the picker hands on are rebuilt, not appended to.** The source, branch, issues
  and base words come from the picker's answers, so a flag value edited in the picker appears
  once, as edited. The flags that are not steps (`--feedback`, `--feedback-edit`,
  `--allow-stale-dispatcher`, `--hard-reset`, and the `--dry-run` modifier) go through as typed. The rebuilt
  argv goes to `dispatchCli` for a second full parse, as T81 already requires.
- **Off a terminal, or with `--no-input`, nothing changes.** `AnswerMissing` renders exactly as
  today's `GuardRefused` does: the same line and exit 1. A dispatch running in the background
  still cannot answer a prompt, which is the ground 09 settled unit 1 on. `--no-input` is a
  boolean flag, and because it is not a modifier, `bessemer --no-input` alone is the refused
  dispatch rather than usage.

**Flags**

| Flag | Semantics |
| --- | --- |
| `--branch` | **required**; the working branch and the task's identity. Must already exist; `master`/`main` and the currently checked-out branch are refused. Checkout forks from the tip; commits push back to it |
| `--base` | PR target, review/PR-description diff boundary (`merge-base(branch, base)`), and `--hard-reset` target. Never pushed to, and **never forked from**: the checkout forks from the **branch tip** (the `--branch` row above, 14 §"Why the gate is the branch tip"). Default chain: ledger's last base for this branch → `origin/master`. **Resolved once, after the fetch** (T70): one authoritative `BASE_SHA`, which is the diff boundary's other end, the ref `--hard-reset` (P4) resets to, and what the run records and prints. **Interactive (T82)**: the picker's base step is quiet until typed — at rest only `← Back` and `[default] <chain>`, which Enter takes; typing ranks every `refs/heads/` and `refs/remotes/` short name, and a query no ref matches is offered as-is iff `git rev-parse --verify <q>^{commit}` resolves it. The step pins nothing, and the words it hands on carry `--base` **only when the choice is not the chain default** (bash's `BASE_EXPLICIT`), so a run that took the default is the run a flag invocation without `--base` is |
| `--hard-reset` | destructive: reset to base and redo; push becomes `--force-with-lease`. Default is continue-from-tip. **Built (T101).** The guard phase decides it, after the fetch and before anything reads the tip: `origin/<b>` is read as it stands now (a failed read is *absent*), and the discard count is **one union** — every commit reachable from the guard-read tip or from origin's and not from `BASE_SHA` (`rev-list --count ^<base> <tip> [<originTip>]`), because the leased push discards origin-only commits too. The plan's tip and diff boundary are then `BASE_SHA`, and the guard-read tip survives only as the reset's expected old value; the plan block prints a `fork point` row with the count. **The reset happens under the lock** (D1): one compare-and-set `update-ref` of `refs/heads/<b>` from the guard-read tip to the base, inside the checkout's acquire, **after** its salvage of a kept copy and **before** the clone — the salvage fast-forwards a kept copy's commits onto the branch, and a reset taken before it would be silently undone; a salvage (or anything else) that moved the branch fails the compare-and-set, and the run fails at stage `checkout` saying which moved it and to run again. The push's lease is **pinned** (D7): `--force-with-lease=refs/heads/<b>:<originTip>`, or `refs/heads/<b>:` (must not exist) when origin had no branch. A run whose agent adds nothing still pushes the reset under the same lease when origin had the branch at a commit other than the base — a reset is a reset on both ends — and the land still records `nothing-to-land` and opens no PR; a `ResetPushed` event says the push went out (T105). Refused beside `--resume`/`--last` (D5), from the command line alone — a resume continues what the reset discards, and a feature resume is a resume. **The feature arm reads the set at the base** (14 §7, T103): the base is the effective tip, so an issue `Done` only on the discarded commits is not `Done` for this run, and the landed-elsewhere witness leaves out the branch's own `refs/heads/<b>` and `refs/remotes/origin/<b>` **by name** — the reset discards the first and the lease push overwrites the second, and counting them would refuse an issue over work this dispatch is throwing away, where 15 calls the witness self-correcting after a reset. By name and not by SHA, because another branch standing at the discarded tip keeps those commits and is still a witness. **The confirm (T102)**: straight after the count, still in the guard phase, a count above zero emits a `Warned` naming the count, the branch, and that the commits are recoverable from the reflog only; zero says and asks nothing. Then, on a TTY (`Terminal.isTTY`, both ends) without `--no-input`, `Prompt.confirm` asks, naming the count and the branch — no, Esc, or Ctrl-C is a `GuardRefused` (*aborted — the branch was not touched*) holding nothing and having written nothing but the fetch (§11 row 1). Off a TTY, or with `--no-input`, the flag is the consent and nothing is asked (D3); `--dry-run` never asks either — its recording `Prompt` records the question and answers yes (D4). After a salvage that went home, row 5a's failure also says the confirm never asked about the commits the salvage moved, and that running again will. The discarded tips (local and origin's) reach the log in the `BranchReset` event, and the local one is also recorded on the run's ledger row as `discardedTip` (T104, §10). |
| `--feedback "…"` | extra dispatcher instructions appended to implement, review, and PR-description prompts. Rides the stdin prompt pipe, so quotes/backticks/`$(…)` arrive literally |
| `--feedback-edit` | **ships** (T84). Editor flow for `--feedback`, git-commit-style: the editor is `git var GIT_EDITOR` in the served repo, so `core.editor`, `GIT_EDITOR`, `VISUAL`, `EDITOR`, and the `vi` fallback resolve as git resolves them; the commented header is stripped and an empty result aborts before anything is claimed. **The file lives under the runtime root and dies with the scope** — `<runtime-root>/feedback-edit-XXXXXX/feedback-edit.txt`, its directory minted per session by `FileSystem` so no two sessions share one, created and removed by a finalizer, which is the untrapped window §4 closes for free. It runs where `--feedback`'s value is read, above the fetch and above every git call but the editor lookup, so a refusal holds nothing and writes no row. TTY-only (`Terminal.isTTY`, which the composition root answers from both stdin and stdout, as bash's `[ -t 0 ]` answers from stdin (T94); bash's line verbatim off a pipe); mutually exclusive with `--feedback`, and with `--task` for the reason `--feedback` is. **A rehearsal opens it too**: the text is the dispatcher's input rather than a mutation, so the plan carries it as `--feedback`'s would — the printed block has no feedback row yet, for either flag (T84's Status) |
| `--dry-run` | resolve and print the full plan, start nothing. **Every guard still runs and fails for real.** Zero state: no lock, log, container, checkout, branch creation, or ledger append. **The step-2 fetch is not on that list, and a rehearsal makes it for real** (T70): it holds nothing and has no release, so row 1 is not dented — and the base the printed plan is resolved from comes out of what it brought back, so a recorded one would print a plan the run would not use. TTY-independent |
| `--repo-root <dir>` | the repo this invocation serves (19 §1). **Peeled off the argv at the composition root, before the `argv[0]` switch**, so `status` and `doctor` take it as well — they never reach the parser. The committed shim always passes it, computed from its own location. **Absolute only**: a relative value is refused with one line rather than resolved against the working directory, which this flag exists to retire. Without it the fallback is `findRepoRoot(packageRoot)` — the self-hosted case, which is this repo |
| `--no-input` | the scriptability escape hatch (T86): a command line missing an answer is refused as it is off a terminal, and the picker never opens. A boolean flag, not a modifier |

**Guards run in two phases, split by what they ask** (15). **Steps 1–4 ship** (T70, T73, T74). Nothing is
validated twice, and nothing is validated against a tree the run will not use.

**Step 2 was new capability rather than a reordering** (T70): the port had never fetched origin, the
`Git` tag had no operation for it (`fetchBack` is land's clone→repo direction and stays its own
operation), and `resolveBaseSha` refused an unresolvable `--base` with *"fetch it first"* — pushing
the job onto the dispatcher. What shipped is the `Git` operation in §2, this placement in
`dispatch.ts` — once, after the last local guard and before the preflight's freshness read — and
that advice replaced by what is now true: *`--base '<x>' does not resolve to a commit after fetching
origin — pass a ref that exists`*. A fetch that cannot run is a `GuardRefused` carrying git's own
line, because nothing is held and the dispatcher's next move is to fix the host; bash dies here
under `set -e` (`run.sh:1268`).

**Step 4 reads the set at the branch tip** (T73), which the step resolves first and puts on the plan
as `tipSha` — for every arm, not only a feature one. That is 15's *fork commit*: the checkout clones
the tip, so the tip is the ref whose content the agent sees (14), and `BASE_SHA` is the diff
boundary's other end and never what a set is read at. It goes through `IssueStore`, so no working
tree is read and none is needed — a read of one typechecks and answers for whichever branch the dev
left checked out. The landed-elsewhere ref scan and the in-progress-elsewhere ledger hint are the
two witnesses (T74) and sit in this step under the opposite override: both run under the wide
`--issues all`, and an enumerated `--issues` **skips them outright** rather than running and
ignoring them. They degrade differently, because they are asked of different things — git's answer
is truth and refuses, the ledger's is derived state (§10) and a `LedgerError` is a `Warned` the
check passes through. Nothing here writes: reads and a pure function, so row 1 holds through the
phase.

1. **Local guards** — ref-shaped and host-shaped facts only: `--branch` exists / not protected / not
   checked out in any worktree, docker, gh, agent credential, setup-hook path. No network, and **no
   repo content** — a typo'd `--branch` costs no round trip.
2. `git fetch origin`. Remote-tracking refs and nothing else: no `--prune`, no tags, no refspec into
   `refs/heads`.
3. **The authoritative `--base` resolve** → one `BASE_SHA`, taken here and nowhere else;
   `resolveMergeBase` sits with it, because the diff boundary must be taken against the base the run
   actually resolved.
4. **Content guards** — the issue set is expanded and validated **once**, here, against the fork
   commit: `all` evaluates its predicate, an enumerated set is checked for existence, `Type: AFK`,
   not-already-Done-on-this-ref, and blockers Done-or-selected. The landed-elsewhere ref scan and the
   in-progress-elsewhere ledger hint run here too. Reads blobs with `cat-file`, so no working tree is
   needed and this still precedes the checkout. **The branch must contain `origin/<b>`** unless
   `--hard-reset` (T106), asked before any of these: an absent `origin/<b>` passes (the first push
   creates it), and so does a branch at or ahead of it; *behind* refuses naming the count, `git
   branch -f <b> origin/<b>` as taking origin's commits and `--hard-reset` as discarding them;
   *diverged* refuses naming both counts and `--hard-reset`, and never prints `branch -f`, which
   there would throw the local commits away. Under `--hard-reset` it is not asked at all.
5. Lock → checkout → sandbox.

**Row 1 of the failure-point matrix is unaffected.** Its invariant is *nothing acquired* — no lock, no
clone, no container, no ledger row — and that holds through step 4. A fetch mutates remote-tracking
refs but holds nothing and has no release.

**Mount sources differ by what the file is** (15). `/spec.md` mounts from the **host**: a spec is
inert, nothing writes back to it, and drafting one and dispatching it uncommitted is the normal
workflow. `/feature-issues` mounts from **inside the checkout**: an issue is read *and* written — the
dispatcher parses its headers to select, then stamps `Status: Done` as a commit on the run branch
(§2, `markLanded`) — so gate and agent must read the same tree. This relies on the port requiring
tracked issue folders; bash mounts the host path only because `.agentbox/tasks/*/` is untracked.

**The resolved-plan render names the mode on its own line**, carrying both facts the passes are
framed by — what the task is, and whether the run resumes — in eight spellings: *one-off (spec)*,
*one-off (inline task)*, *resume (spec)*, *resume (inline task)*, *resume (feedback stands in for
the missing spec)*, *feature*, *resume (feature)*, and *resume (feedback stands in for the exhausted
issue set)*. The first five are T67's; *feature* is T73's; *resume (feature)* is T78's, a resume of
a feature row replaying its recorded set; and the eighth is T89's, a resume of a feature row whose
recorded ids are all approved, run on `--feedback` as an inline task, whose row records the resumed
set unchanged (T92). *feature* and *resume
(feature)* gain an `issues` row beside the mode — the selected (or replayed) ids in T69's order
on one line, with their count. The line is there rather than leaving the mode inferable from the absence of an issue list. Feedback-only has no flag: it is
derived from a resume whose recorded set is exhausted plus `--feedback` present (15). An inline task
and a feedback-only resume are one arm of what the passes are for — text rather than a file — and the
*resuming* framing comes from the run's identity, not from the arm (22).

**Subcommands**

| Command | Notes |
| --- | --- |
| `status` | one screen: what's running, what just finished, where the PRs are. The Running section names each container's owner — `pid <N>`, `dead — next dispatch reclaims`, or `no lock — reported only` — as the reconciler's `classify` answers it, so `status` reads the lock directory (a filesystem read, as the ledger's is; an unreadable lock is no lock) (T138). No docker state changes, no writes, no git. Degrades to ledger-only if the daemon is down, and then reads no lock |
| `doctor` | pass/fail preflight, read-only, never repairs. Exit 0 on warnings-only, exit 1 on any FAIL |
| `gc` | list by default (touches nothing, exit 0); `--force` reclaims after re-verifying liveness. **Logs are never deleted.** Checkouts are salvaged before removal, by the release's own two-destination rule (T29): FF home, else onto a branch of the run's own, named from the commits — and a branch the served repo cannot read is not a destination, because the fetch would create it (T107). A checkout neither destination takes is skipped loudly, never discarded. A checkout whose branch the served repo no longer has goes to a rescue branch, and the branch is never recreated (T107). Daemon down → listing works with a warning, `--force` refuses. A `config.toml` that does not decode → listing works on the committed defaults, `--force` refuses (D8). Beside containers, checkouts, locks, and witnesses it lists three leftovers a kill can strand, each judged by a witness its name carries and never by age: a claim temp file `<slug>.pid.<pid>.<attempt>.claim` (dead when its pid is not alive), a scratch index `locks/<slug>.index` (dead when the slug holds no lock with a live owner — it is only written under that lock), and an editor session directory `<purpose>-edit-<pid>-XXXXXX` at the runtime root (dead when its pid is not alive; one from before the pid was in the name is listed as unwitnessed and left for a human). Live ones are not listed. The reconciler does **not** sweep them — they block nothing, and an editor directory is the dispatcher's text (T108). `--force` removes the dead ones after re-asking their witness — a claim or an editor directory by the pid in its name, right before the removal — removes an index only under its slug's lock (inside that slug's reclaim when it has one, under a lock of its own when not, and a lock it cannot take skips it), and leaves a pid-less editor directory to a human, printing its `rm -rf` (T109). Listing **built (T99, T108)**; `--force` **built (T100, T109)** |
| `init` | writes the **scaffold** into the served repo from the package's **templates** (`<packageRoot>/templates/`, handed in as a parameter): `.bessemer/config.toml`, `.bessemer/.gitignore`, `.bessemer/image/Dockerfile`, `.bessemer/image/inputs`, and `.bessemer/tasks/` with the config's `tasks-dir` pointing there. It writes no setup hook, no sandbox env file, and no prompt file. It **does** write the shim, `.bessemer/bessemer`, stamped and mode 0755 (P6 F1); `--diff` reports a shim without its executable bit as *not executable*, apart from drift. A behind shim's fix is not delete-and-rerun, which would run the file it deleted: it is `mv .bessemer/bessemer .bessemer/bessemer.old && .bessemer/bessemer.old init && rm .bessemer/bessemer.old`, printed with the restore line `mv .bessemer/bessemer.old .bessemer/bessemer` (P6, amended). It writes **only files that are absent**, never overwrites, reports each file as `wrote`/`kept`, and has no `--force` and no `--dry-run`. `base` comes from `refs/remotes/origin/HEAD`, or else `--base`, or else a refusal — and, like every config value, is worked out only when `init` will write `config.toml`; a kept config asks nothing. `image` comes from `--image` (default `<dir>-bessemer`, lowercased). `tool-sha` is the running revision as a full SHA, left empty with a warning when the package is dirty, and with a warning when it carries no release (F6, F16). Placeholders are substituted in `config.toml` only. It refuses on a self-hosted repo and ends by printing next steps, every one spelled `.bessemer/bessemer …` (F2). Every scaffold file but `config.toml` carries a stamp line `# bessemer-template: <name> v<N> sha256:<12>` (the template's digest, stamp line excluded; a hand-stamped file carries the template's digest, never its own), `.gitignore` included. The `.gitignore` template ignores by name only, plus the anchored `/*-edit-*/`, and never ignores the tasks dir (tested with `git check-ignore`). **`init --diff`** is read-only and allowed self-hosted. It sorts each stamped file into missing / current / behind (template version) and, when present, pristine / edited (digest). An unstamped present file is version 0, so behind. For a behind file it prints the current template against the file plus the delete-and-rerun command. `config.toml` is checked for presence only. Exit 0 iff nothing is missing or behind. **P5** (09, 2026-09-30, E1–E9) |
| `image build` | builds the image `config.toml`'s `image` names, through `Sandbox.build`. The context is `.bessemer/image/`, never the repo root. The inputs are the Dockerfile (implicit, first) plus `.bessemer/image/inputs`: one exact repo-relative path per line, `#` comments and blank lines ignored, no globs, and a missing path refuses. It stamps `bessemer.inputs` and `bessemer.inputs.digest` with **the same function probe 2 recomputes with** (one recipe). The uid and gid are read at the composition root, and there is no `--dry-run`. A repo whose build needs more wraps it and names the wrapper in `image-build-command`. **P5** (E10) |
| `upgrade` | moves the pin to the newest release. Runs `git ls-remote --tags origin` in the package cache entry (10 s timeout, `GIT_TERMINAL_PROMPT=0`), takes each release's commit from its `^{}` line or else its bare line, and compares **tag numbers, never ancestry** — the entry is a depth-1 clone. A pin `vK` points at moves only to `vN` with N > K (two releases on one commit count as the higher); N = K is current; an untagged pin refuses and names `--to vN`, which also pins a release explicitly, rollbacks included. Reads and rewrites only the `tool-sha` line through the shared grammar, prints `.bessemer/bessemer init --diff` without running it, commits nothing, and refuses self-hosted. A network failure refuses with git's line and writes nothing. **P6** (F13, F15) |

**`status`, `doctor`, and `gc` are intercepted before flag parsing and before any preflight**,
deliberately, because they must work when the thing they inspect is broken (03 §1.1). **The
`--repo-root` peel precedes that switch** — it is the one argv read that happens before parsing at
all, because a flag the parser read would be a flag two of those three commands could never see.
**`init` is intercepted beside them** (E9): it runs before a config exists, so it decodes none.

### `doctor` probes

Eleven, in dependency order, each a distinct effect with a **typed** failure, rendered by a thin CLI,
under one informational row that takes no number and is not one of them (T62): it checks nothing, it
names the roots the eleven report against. The credential it names is resolved **once**, at the
composition root, and probe 3 reports on that same value rather than asking again.

| # | Probe | Change from bash |
| --- | --- | --- |
| — | `roots`: the served repo, the package's location and revision, the config file, the credential's source, and self-hosted or not | **new** (T62, 19 §8) — informational and always `ok`, emitted **first** because it says what every row below it is about. Names and paths, never a value; *credential none* when there is none, and probe 3 still says what to do about it. `doctor.ts` may not import `packageRoot` (§9), so the package's location arrives as a parameter, as the node version does |
| 1 | docker CLI present + daemon reachable | as-is |
| 2 | image present + staleness | as-is |
| 3 | credential presence — **presence reported, never the value** | as-is |
| 4 | host `node` ≥ 26 | **replaces** host python ≥ 3.14 |
| 5 | git work tree + `origin` present | as-is |
| 6 | `gh` present + authenticated | as-is |
| 7 | config decodes and satisfies the schema | **new** — makes decode-once failure visible before a dispatch |
| 8 | spec/tasks dir present | as-is |
| 9 | runtime root writable | **new** — it is a fresh default |
| 10 | dispatcher freshness: is this dispatcher's own source missing commits its configured base already has? | **new** (T42) — **self-hosted only** (T60): when `--repo-root` names another repo the question is not asked, no `rev-list` is spent, and the row reads `not applicable — dispatcher pinned at <sha>`, naming the dispatcher's own revision (`revision unknown` when that read came back empty). Self-hosted, its three verdicts are current / missing commits / base unresolvable, and the last two `warn` |
| 11 | upstream: `pinned vK (<short>); latest vN`, from the same `ls-remote` as `upgrade`, and whether the running revision is the pin the shared grammar reads | **new** (P6 F14) — always `ok`, never `warn`; offline or timed out (10 s) it is an `ok` row saying nothing was compared, quoting git. Not applicable self-hosted. **`doctor`-only: it never joins the dispatch preflight**, so no dispatch waits on the network |

**Dropped: the `gum` and `fzf` probes** — clack replaces both, so there is no external prompt binary
to check for.

`doctor`'s probes call the subprocess chokepoint **directly**; they do not go through `Sandbox`
(which does not exist until T6).

---

## 8. Prompt packaging

- **`PromptSource` tag** (05 Q6/Q9). It earns a tag on the **precedence logic** (a served repo's
  `<repoRoot>/.bessemer/prompts/*.md` beats package defaults, and `project-context.md` lives there
  beside them — T59, 19 §2) and on being the surface a served repo extends — not on file reading,
  which `FileSystem.layerNoop` already fakes.
- It returns the resolved text **and which root won**. The assembled prompt is logged verbatim
  before each pass, and a client needs to see their override actually take.
- **Override granularity is whole-file replacement only**, plus a separate small
  **`project-context.md` fragment** the default prompts interpolate. The fragment is the narrow
  common case (a client's test command, setup notes) and survives the defaults improving underneath
  them; whole-file override is the escape hatch. Fragment-patching a template was rejected as a
  mini-templating-language.
- **Interpolation stays a pure function.**
- **Dispatcher feedback is per-dispatch** (17, upholding 15's non-inheritance on resume). The prompt
  is assembled fresh each run from the templates plus *this* dispatch's `--feedback`; nothing carries
  a previous round's feedback forward, no store holds its text, and the agent never reads its own PR.
  Do not add a cross-round carry — the accumulation has no revocation vocabulary, so a prohibition
  the dispatcher later reverses keeps steering the work.
- Under the clone-run model, prompts are just files in the cloned tree — no bundling problem (01).
- **This is a different surface from `AGENTS.md`**, which is our own development guidance and never
  ships to users (06 §4).

---

## 9. The subprocess chokepoint and security invariants

**`src/internal/exec.ts` is an internal module, not a tag** (05 Q3) — a tag there would recreate the
`Shell.exec` anti-pattern that makes Layer-based testing worthless. It is the **only** file allowed
to import `Command`.

It sets `shell: false` (already the default) and **`extendEnv: false` with an explicit allowlist** —
the default inherits `process.env` and would leak the parent environment into agent containers. This
is a security property, not tidiness.

**That allowlist governs inherited parent environment, which stays banned; a declared
`sandbox-env-file` is the served repo's own explicit act, carried in its own field on the spec and
handed to docker as `--env-file`** (T61, 19 §5). Bessemer never opens that file — docker reads it —
so the path may appear in argv, a log, the ledger, or an event and the contents never do. Whatever
the repo puts in it, the agent can read, and that is the repo's call (04).

**Grep bans, wired into `verify` or CI from T1** — while there is nothing to fix:

- `Command` imported outside `src/internal/exec.ts`
- `Command.runInShell`
- `Effect.runPromise` (`NodeRuntime.runMain` is the only entrypoint idiom)
- container-name-based ownership queries
- `@clack/prompts` imported outside `src/prompt/clack.ts` (T81) — the live `Prompt` layer is the one
  file that speaks to the terminal library, so every other module speaks the tag a scripted fake
  stands in at, and cancel, filtering, and the interrupt bracket have one implementation each
- `packageRoot` imported anywhere in `src/` but `src/config/paths.ts` (the definition, the
  freshness pathspec, and the templates root `init` is handed), `src/agent/prompt.ts` (the default
  prompts), and `src/bin.ts` (the no-flag fallback, the dispatcher revision, and the `selfHosted`
  predicate) — T62, 19 §8. A served-repo read resolves against `repoRoot`; `packageRoot` is the
  package's own location and may be read only where the package reads itself. Rooted, the two are
  one directory here, so the rule is what catches the conflation a probe run in this repo is blind to

**The `packageRoot` ban catches the spelling, not every route** (T62, PR #22). It reads import
clauses, so a namespace import — `import * as paths` and then `paths.packageRoot` — passes it; and
`packagePathspec` returns the same package-relative paths by a second route that no rule names.
Neither is fixed. The ban is a tripwire for the conflation a probe run in this repo cannot see, not
a proof of its absence, and a reader who takes it for the latter will trust a green `verify` further
than it goes.

**Two invariants become unrepresentable rather than checked:**

1. **No published ports** — the sandbox spec type has *no ports field at all*. Not a flag to misuse,
   not an escape hatch. (Bash has since added a post-start `docker port` check that aborts the
   dispatch and fails closed; that is a check a future edit can bypass, and this is a shape a future
   edit cannot express.)
2. **No userinfo on any URL crossing into the sandbox** — `RepoUrl` is a branded parse whose
   constructor strips or refuses userinfo. No string-typed URL crosses the boundary. (Bash has since
   added a `strip_url_userinfo` helper plus a `doctor` warning; same distinction.)

**Invariant 3's hardened `upload-pack` is upstream git behavior, not a flag agentbox sets.** The port
inherits it by using the same fetch-from-clone path. Do not "reimplement" it.

Everything else in ADR 0007's security section is carried unchanged and is not restated here.

---

## 10. Ledger

**Greenfield record, with no import of bash's lines** (05 Q18R, T135). `runs.jsonl` is gitignored,
local, and per-repo, so back-compat earns little against three real flaws in today's schema:
`spec`/`feature` are a nullable pair encoding a mode, `issues`-vs-`outcome` repeats that discriminant
unenforced, and there is no run id, start/end, duration, or exit reason.

New record, **as built in T2** (`src/ledger/record.ts` is the authority; this is its gist):

- **tagged union for run identity**, replacing the nullable pair. `DispatchIdentity` is `OneOff |
  Feature`; `FeedbackResume` **wraps** one of those rather than repeating its fields, so a resume is
  still a one-off or a feature underneath and mode recovery is always a tag read. A
  `dispatchIdentity()` accessor unwraps it — call sites never null-check
- explicit `schemaVersion` — `1` on every record this package writes, and the only value the
  schema admits. There is no stamp `0`: a line with no `schemaVersion` is not a bessemer record and
  is skipped with a warning (T135)
- run id, never synthesized
- start and end timestamps
- **terminal reason** (`Completed` / `Failed(stage)` / `Crashed` / `Interrupted`), distinct from
  `outcome`, which is the review verdict. A crashed run has the first and not the second. `stage` is
  a closed literal union — `checkout` `sandbox` `setup` `implement` `review` `land` `pr` — and it is
  the same vocabulary as §11's failure-point matrix, so a slice writing a matrix row uses this type
  rather than inventing a token
- **base as a `{ref, sha}` pair**, plus a separate merge-base SHA. The **ref** is what
  `lastBaseForBranch` hands the `--base` default chain — returning a SHA there would pin the next run
  to a stale commit — and the SHA records what that ref resolved to for this run
- PR number **alongside** URL, so no call site parses it back out
- per-issue outcomes on the `Feature` arm alone. The outcome token is an **open string**: bash's own
  renderer passes an unrecognized token through, and dropping a real row because a token grew is
  worse than rendering one we do not recognize
- **what the run cost** (20, T53): the four token counts — `tokensIn`, `tokensOut`, `cacheWrite`,
  `cacheRead`, each summed over every pass that reported usage — plus `passes` and `models` (union,
  first-seen order). Bash's three fields (`run.sh:2188`), except that its single pre-summed
  `tokens` is kept as its components: cache reads run ~98% of a real total, so the sum alone cannot
  say what a run burned, and `status` adds them back at render time. Derived from
  `AgentPassFinished` / `PassFailed` rather than re-parsed from the log. Optional; a run with no
  usage-bearing event writes none of them, never zeros
- **the tip a `--hard-reset` discarded** (P4 D6, T104): `discardedTip`, the full SHA the local
  branch stood at before the reset — present only when the reset's compare-and-set succeeded, and
  an absent key on every other row, including a reset run that failed before or at its reset. It
  reaches the finalizer through a `Ref` the checkout's acquire sets, never off `plan.reset`. Beside
  the per-clone, expiring reflog it is the one durable pointer to the discarded work; origin's
  discarded tip is not a second field, since `BranchReset` puts it in the run log. `status` does
  not render it

**Queries** (T2): `append`, `recent(limit)` newest-first for `status`, and `lastBaseForBranch`.
`resolveResume` arrives with `--resume` in T16.

**The record is designed to be derivable from the `Reporter` event stream**, so promoting events to
source-of-truth later is additive rather than a rewrite. Event-log-as-truth itself is deferred —
architecture spent on a consumer that does not exist.

**A line is native when it says so**: the reader dispatches on the presence of `schemaVersion` and
skips everything else with a warning, rather than sniffing which fields exist.

**Legacy read adapter**: deleted by T135, since the side-by-side comparison it served will never run.

Ledger remains **derived state**: a missing or corrupt ledger degrades the `--base` default chain
and `status`, and never fails a run.

---

## 11. Test strategy

Resolved by ticket [12](12-test-strategy.md) (2026-08-06).

### Runner and gate

- **Runner**: `vitest` + `@effect/vitest` (`it.effect`, `TestClock`/`TestContext` wiring, scoped
  tests). Chosen over `node:test`-under-stripping because the cost of losing `@effect/vitest` lands
  directly on dispatch-core test quality (04 §7).
- **Vitest's transform gap is closed by the tracer, not by the suite**: vitest accepts constructs
  Node rejects and rewrites path aliases Node will not, so a green suite can ship source Node cannot
  run. `node src/bin.ts doctor` under plain node is the check, and it stays green on every
  subsequent bullet.
- **`floatingEffectInVitest`** (a test that constructs an Effect and never runs it, so it passes
  while asserting nothing) is caught by the tsgo diagnostics already inside `verify` — assume it
  rather than re-deriving the gap (06).

### Two tiers

T1–T6 are AFK-dispatched into hae's task container, which has no docker socket and
`--cap-drop ALL` — so the agent writing the code can never reach a live dockerd. The split follows
that fact:

- **`npm run verify`** — the one gate (06), agent-runnable, entirely Layer-faked. Typecheck +
  tsgo diagnostics + fake-tier suite. Everything the agent is scored on lives here.
- **`npm run verify:live`** — **not yet built**; T1 and T2 touch no dockerd, so the bullet that
  introduces `Sandbox.dockerLayer` owes the script along with its first live case — post-re-slice
  that is **T6**, which also owns live cases 1–3; T7 owns case 5 and T8 owns case 4. Host-only,
  tagged tests against a real dockerd, run by the user
  before landing any bullet that touches `Sandbox.dockerLayer` (T6 onward). Deliberately **not** an
  `it.skipIf(noDocker)` inside `verify`: skipped-is-green in exactly the environment that writes
  all the code is the false-green shape 04 already ate once. Not wired into hae CI (hae CI has no
  npm job for the package at all — the only contact is pre-commit's `exclude:`, owed by T1).
  Post-move CI runs `verify`; adopting `verify:live` there (GitHub runners have dockerd) is a
  P-sequence option, not a decision here.

**Admission rule for the live tier**: a case earns it only if a fake could pass while dockerd
disagrees. Everything else is a unit test. Current live set:

1. **Leak under defect** — real `dockerLayer`, fake everything else, defect mid-scope, then
   `docker ps -a` filtered by our labels returns empty. "Our fake released" is not "dockerd has no
   container".
2. **The spec type renders to a `docker run` dockerd accepts** — caps, mounts, limits. A fake
   accepts any garbage.
3. **No published ports, live** — rule 2 makes the violation unrepresentable, but the type only
   constrains our renderer; one `docker port` assertion proves the renderer honors it.
4. **Label filter selectivity** — two real containers, one ours-labelled; the reconciler's query
   matches exactly one, in both directions. The dangerous direction is over-matching — the exact
   bug that retired the name prefix (05 Q11). The reconciler's liveness *logic* stays pure and
   fake-tier; only filter selectivity is live.
5. **The signal matrix** — Ctrl-C once, Ctrl-C twice, SIGHUP, `kill -9`, agent-CLI crash mid-run,
   each asserting no leaked container, lock, or checkout (real processes, real signals). These are
   **regression tests first**: SIGHUP-teardown, second-Ctrl-C, and reconciler reclaim are new or
   changed behavior with no bash equivalent, and untested signal paths are exactly what bash had.
   ADR 0007's failure-injection evidence *borrows* this suite if the comparison happens; nothing
   here is shaped for comparability, and no shared cross-port harness is built — running the same
   case list against `run.sh` by hand once is an afternoon, not architecture.

### The dispatch-core failure-point matrix (fake tier)

The dispatch core is the untested half — there is no oracle to port against (03). This table **is
the oracle**: authored here, once, so six AFK-dispatched bullets cannot each invent
contradictory-but-green answers. Each row is one `it.effect` test; the three observables are the
fake `Reporter`'s event `Ref` (acquisition/release ordering), the fake `Ledger` (which row), and
the failure channel (typed vs defect, per §3's outcome-row test).

**Ledger row rule: a run writes exactly one terminal row iff `RunLock` was acquired.** The ledger
records runs that claimed the branch; guard and preflight refusals never started.

| # | Failure point | Released (in order) | Ledger row | Error |
| --- | --- | --- | --- | --- |
| 1 | Guard refused (protected branch, self-base, declined confirm, blocker, branch behind or beside its remote) | nothing held | none | typed `GuardRefused` |
| 2 | Preflight fails (no docker, no `gh` auth, no image) | nothing held | none | typed |
| 3 | Lock held by a live run | nothing | none | typed `LockHeld` |
| 4 | Stale lock, owner provably dead | — (reclaimed during acquisition; run proceeds; reclaim reported via `Reporter`) | — | — |
| 5 | Clone fails | lock | `failed` (checkout) | typed `GitError` |
| 5a | `--hard-reset`'s compare-and-set fails — the branch moved after the guards read it, by the acquire's own salvage or by anything else (T101) | checkout (nothing cloned, so nothing removed), lock | `failed` (checkout) | typed `GitError`, whose detail says what moved the branch and tells the dispatcher to run again |
| 6 | Sandbox start fails (daemon, image, caps) | checkout, lock | `failed` (sandbox) | typed `SandboxError` |
| 7 | In-container setup fails | sandbox, checkout, lock | `failed` (setup) | typed `SandboxError` |
| 8 | Implement pass exits nonzero | sandbox, checkout, lock | `failed` (implement) | typed `AgentPassFailed` |
| 9 | Implement pass times out | sandbox, checkout, lock | `failed` (implement) | typed `AgentPassFailed`, timeout cause |
| 10 | Container dies mid-pass | sandbox (idempotent), checkout, lock | `failed` (implement) | typed `AgentPassFailed`, sandbox-gone cause |
| 11 | Review pass dies with a defect (**the canonical Claim-1 case**) | sandbox, checkout, lock | `crashed` | defect, rethrown after release |
| 12 | Review-round cap hit | not a failure — proceeds to land, unapproved state recorded | terminal row from land | — |
| 13 | FF fetch-back fails at land | sandbox, lock; then the release tries a branch of its own — straight away when the served repo cannot read the branch, which is not a destination (T107) — **checkout released** once a rescue lands, **kept** loudly only when that is refused too (derived release, 05 Q10, T29) | `failed` (land) | typed `GitError` |
| 14 | Push fails | sandbox, checkout (FF succeeded), lock | `failed` (land) | typed `GitError` |
| 15 | PR create/edit fails (commits already pushed) | all | `failed` (pr) | typed `ForgeError` |
| 16 | Ctrl-C once / SIGHUP | all, reverse order | `interrupted` | — |
| 17 | Ctrl-C twice / `kill -9` | none (hard exit); next preflight's reconciler reclaims and reports | none (reconciler may annotate later) | — |
| 18 | Checkout finalizer itself fails | logs loudly, keeps the directory, **swallows** (rule 4) | run's own outcome, unchanged | run's own error, unmasked |
| 19 | Sandbox/lock finalizer fails | reported via `Reporter`, swallowed; reconciler's problem | run's own outcome | run's own error |
| 20 | Ledger append itself fails | all (post-scope) | none — that *is* the failure; warn loudly, log file still holds truth | typed `LedgerError`, non-fatal |
| 21 | Notify fails | all | run's own row | swallowed, `Reporter` warning |
| 22 | Defect anywhere in-scope (impossible state, §3) | all, reverse order | `crashed` | defect, rethrown |
| 23 | **Feature**: implement pass fails on issue *n* of *m* (T76) | nothing yet — the loop stops and the run falls through to the land, then all three in reverse | `Completed`; `issues` carries `implement-failed` for *n* and `not-attempted` for every id after it; `outcome` absent | — (`PassFailed` is emitted for the pass; the typed error is caught and becomes the issue's outcome) |
| 24 | **Feature**: a review pass fails on issue *n* | as row 23 | `Completed`; `review-failed` for *n*, `not-attempted` after it | — |
| 25 | **Feature**: issue *n* is not approved — capped `needs-work`, or a capped fixing round | as row 23 | `Completed`; `needs-work` or `capped-unreviewed-fix` for *n*, `not-attempted` after it | — |
| 26 | **Feature**: Ctrl-C with issue *n* in flight | all, reverse order; the land never runs | `interrupted`; every id with no recorded outcome is `not-attempted`, *n* included — nothing landed for it and the resume replays it (T78) | — |

Rows 23-25 are the three stop conditions of the feature loop, and they are one row three times over:
**the sequence stops, the run lands what the issues before it left, opens its PR, and records
`Completed`**. The run did what a feature run does; what happened to each issue is on the row and in
the PR (T79). Row 26 is row 16 seen from the same arm, and its tail is why the `not-attempted` fill
is computed in the finalizer rather than appended as the loop stops: no code after the kill ran.

Ordering assertions ("lock before checkout before sandbox, released in reverse") run through the
test `Reporter` appending to a `Ref`, so they are plain value assertions (05 §4). Config precedence
is tested with `Layer.succeed` over object literals, not provider maps.

### Design-rule enforcement

Each of §2/§4's five rules maps to a mechanism a future edit trips:

| Rule | Enforced by |
| --- | --- |
| 1. Domain-shaped services | not testable at runtime — review property; the chokepoint grep bans (§9) are the nearest mechanical proxy |
| 2. Unrepresentable invariants | a **small** `@ts-expect-error` file pinning shapes where a future edit could silently add capability (`SandboxSpec` gains a `ports` field → the pin turns hard error, forcing the edit to delete a test that names the invariant); `RepoUrl` userinfo rejection is an ordinary Schema-decode test. Nothing whose only job is re-proving the compiler |
| 3. Ownership declared (labels) | live case 4 (filter selectivity) + a unit test that the renderer always attaches both labels |
| 4. Finalizers never fail the scope | matrix rows 18–19 |
| 5. Rehearsal = layer swap | `--dry-run` provides swapped layers to the **same** dispatch entry; a fake-`Reporter` test asserts dry-run emits the same event-sequence shape as a real dispatch, and a grep ban keeps a second dispatch path from appearing |

### Case translation from tasklib's 337

- **Picker (138 tests, 41%)**: not translated. The picker is rewritten against clack post-move
  (P3, prototyped by 13); its tests are written fresh there. The gum/fzf/`shutil.which` fallback
  machinery they defend does not exist in the port.
- **Ledger/resume (75)**: mostly die — the schema is greenfield (05). Behaviors carry as intent;
  cases are written fresh against the new record. Real `runs.jsonl` lines from hae served as data
  fixtures for the legacy import adapter until T135 deleted the adapter and its fixtures (below).
- **Status render, gc classification, naming/path, issue parsing (~113)**: translate per-bullet as
  each area lands (T2 takes status render; gc goes to P4; issue parsing to P2) — these are the
  plain-function tests §2 predicts, and the genuinely valuable half.
- **Subprocess-mock shape tests** (argv construction, exit-code mapping): die untranslated — they
  test the mock's shape, which is the thesis.
- No dedicated translation pass; each bullet carries its own.

### The oracle posture

`run.sh` + `tasklib.py` travel to the new repo as **reference documents — read, never executed**
(revises 04's "parity oracle" to its real strength: source material, not a gold standard). No
python toolchain in the new repo, ever. The one differential comparison that matters is 09's
switchover gate — a parallel run on real dispatches against the expected-divergence list — and it
already exists; no second harness is built earlier. The **legacy ledger import adapter**, once tested
against frozen lines of hae's actual `runs.jsonl`, was deleted with those fixtures by T135, ahead of
the switchover gate: the side-by-side comparison it served will never run. The copies are deleted
after the switchover gate passes (P7), not at parity: [`PARITY.md`](PARITY.md) is fully marked, and
the copies stay as the reference while the gate's differences are diagnosed.

---

## 12. Sequences and parity

The two tracer-bullet sequences are recorded in `.agentbox/ROADMAP.md` as of
`6f66e9ac891462de809d207822c77d8f27615663`. That path, the `run.sh:N`, `tasklib.py:N`, and
`.agentbox/…` citations, and the commit SHAs and PR numbers in `docs/`, refer to the **private
archive repository**, readable by org members only; every rule states its claim in place. The
sequences are derived in tickets [08](08-in-hae-sequence.md) (in-hae, T1–T6) and
[09](09-post-move-sequence.md) (post-move, P1–P7). Issue files land in
[`issues/`](issues/) — [`TEMPLATE.md`](issues/TEMPLATE.md), the landed
[`T1`](issues/T1-skeleton.md) and [`T2`](issues/T2-ledger-status.md), and **T3–T17**, which replace
08's T3–T6 bullets after the 2026-08-10 re-slice (mapping table in 08). Predecessor knowledge is
carried by each landed ticket's `## Comments` section, written at close and read at slice time.

**Feature parity is a written checklist over the behavior inventory**, not a feeling (09 Q8). Every
inventory item carries exactly one mark:

| Mark | Meaning |
| --- | --- |
| **ported** | behavior reproduced |
| **ported-with-divergence** | reproduced differently on purpose, pointing at the deciding ticket |
| **not core** | belongs to the hae adapter or a scaffold template; never in the tool |
| **transitional** | carried only to serve the switchover gate, then deleted in P7 |
| **dropped** | deliberately not carried, with a reason |
| **deferred** | Phase C or post-finish-line, with a reason |

Parity is reached when no item is unmarked. The checklist is [`PARITY.md`](PARITY.md) and is a
precondition for P7.

**Known ported-with-divergence set** (this is also the switchover gate's expected-divergence list):
SIGHUP tears down · ownership by label rather than name prefix · greenfield ledger schema ·
`--dry-run` as a layer swap · **the checked-out-branch guard is worktree-aware** · **the plan
block's short SHAs are a fixed 10 characters** · **the spec mount is stated by the dispatcher, never asserted
by a template** · **`all` selects on the triage status** (`ready-for-agent`, where bash takes every
AFK issue that is not yet Done) · **an enumerated issue that is already Done is refused** (where bash
re-runs it — `select_issues` filters no status off a requested set, and the feature loop's only
per-issue check is the HITL one) · **a HITL issue is refused before the lock** (where bash writes
`blocked (HITL)` to the issue **file's** `Status:` header and `blocked-hitl` to the row's outcomes,
mid-run, then stops the sequence; the port writes no status to an issue file but `Done`) ·
**a feature run's per-issue boundary is read in the container** (where bash reads `git -C "$wt"
rev-parse HEAD` on the host, in the clone the agent has been writing to — T76 §1) · **a failed pass
inside a feature run is caught and becomes that issue's outcome** (bash assigns the pass through an
`if` for the same reason, after a 529 on round 1 took a whole run down with implement's commits
already on the branch; the port's difference is that the catch is a typed error in the loop rather
than a shell exit status, and `PassFailed` is still emitted — T76 §1) · **no status is written into
the mounted issue set mid-run** (bash stamps `Done`/`needs-work` into its materialized copy as each
issue ends, `run.sh:1866`; here the mount is read-only and the only status write is the land's
commit on the run branch — T75 §1, T77) ·
**the picker shows a branch it would refuse as a disabled row** rather than taking the pick and
refusing it afterwards (13's accepted divergence, T81: `⛔ CHECKED OUT — ` for a branch any worktree
holds, `⛔ PROTECTED — ` for `master`/`main`) · **focus survives a backspace-clear** in a picker
list, where fzf snaps to the top (13: clack's cursor recovery keeps the focused item wherever it
lands in the restored list, no override exists in 1.7.0, and forcing one would be out-of-model
hackery) ·
**the picker's feature folder list is a host listing** (the hint a human names a folder from, read
before any branch is chosen; the set itself is read at the tip, and every refusal about it is T73's
— T83) · **no one-issue auto-skip** in the picker's issues step (bash skips it; here the human names
the set, and one row is one keypress — T83) ·
**`--hard-reset`'s discard count includes commits only on `origin/<b>`** (bash counts
`$BASE_SHA..$BRANCH_REF`, `run.sh:1289`, which misses what the lease-forced push destroys on a
branch behind or beside its remote — T101) · **`--hard-reset` moves the branch under the lock**,
after the checkout's salvage (bash runs `git branch -f` before it takes the lock, `run.sh:1302`;
here the guard phase holds nothing and writes nothing but the fetch — T101) ·
**a branch behind or beside its remote is refused before the lock** (bash fails at the push, after
the agent's work — T106) ·
**the editor's file opens on an empty line above its comments**, as `git commit`'s does (bash
writes the comments first, `run.sh:1164`, so text typed at line 1 joins the header's first line and
reaches the agent — T95) ·
**prompts differ** (hae's do not travel; the tool ships package defaults). The last
is load-bearing: different prompts mean different agent output, so outcome parity **cannot** mean the
same diff — only same terminal state, same ledger outcome, same resources released, PR opened.

**The plan block abbreviates SHAs itself, at a fixed width** (T3's review, closed by T15). bash
prints `git rev-parse --short "$BASE_SHA"`, which honours `core.abbrev` — a dispatcher who set it to
12 gets 12 there and 10 here. `renderPlan` is a pure function over the `DispatchPlan`, and the two
ways to close the gap both cost more than the divergence: asking git inside a renderer makes the
plan block a subprocess call, and putting the abbreviation on the plan makes a cosmetic host setting
a field the ledger row's producer has to carry. The full SHA is on the plan and in the ledger row
either way; this is the width of one printed line.

**ADR 0005's carve-out letting the picker create a missing branch is deliberately unexercised**
— `dropped`, decided 2026-09-22 with T81. Four reasons, and any one of them is enough: §7 says
`--branch` must already exist; the port has no creation path anywhere, so this would be new
capability rather than parity; every hand-off in this repo already opens with `git branch
--no-track`; and a host write before the lock is exactly what row 1 of the failure-point matrix
forbids. The prototype's `+ create '<query>'` row is not ported — the free-text query is still
`fzf --print-query` parity there, and here it would be a branch nobody asked for.

**`--dry-run`'s reach is the tag surface, and nothing is left out** (T15, narrowed by T38,
closed by [ticket 16](16-what-the-tool-keeps-and-who-deletes-it.md)). The swap covers every service
in §2 — no container, no `gh` write, no push, no clone, no PID file, no ledger row, no notification.
`FileSystem` is used directly and wrapped in nothing (§2), so a write that does not go through a tag
would happen in a rehearsal as in a run; the run log was the one such write, and **a rehearsal now
opens no log at all**. The decision is composed in `dispatch/command.ts`, which `check-bans` already
permits to name the flag, so the plan a rehearsal carries says there is no log rather than a
dispatch op learning it is a rehearsal.

This is why the entry above is gone from the divergence list rather than reworded. It had been
recorded as *"`--dry-run` does not cover the run log, and rotates one where bash rotates none"* — a
regression wearing a divergence's clothes, since bash's `--dry-run` derives the log path and merely
*prints* it (`run.sh:2312`). Parity is restored, and §12 states an invariant — **the swap covers
everything that writes** — instead of maintaining a list of what leaks. Ticket 16 took that
invariant as the reason to want the `RunLog` tag, then obtained it without one.

**Ticket 16 also removed the rotation the entry was about.** A log is an audit trail, kept
indefinitely, and nothing in the tool deletes one; each run writes `<slug>-<runId>.log`, so there is
no rename and no clobber reachable by any path — a re-dispatch, a rehearsal, or otherwise. See §5
and the ticket for the ruling.

**The agent pass narrates as it runs, and its answer is the result event's text** — [ticket
20](20-the-agent-pass-narrates-nothing.md), resolved 2026-09-10. Bash runs `claude
--dangerously-skip-permissions -p --output-format stream-json --verbose | python3
/agentbox/stream-filter.py` (`run.sh:1466`); the port ran plain `-p` until T51, so the CLI printed
one blob at exit and a killed pass left an 80-line log with zero agent lines and no line about the
kill. The ruling: the same flags; the filter is this package's own **`agent/stream.ts`**, a pure fold
on the dispatching host (the image ships no python, and hae's filter does not travel); `AgentOutput`
is **structured** (`text` per line, `tool-use` with bash's 160-char brief) and each renderer owns its
prefix — the log keeps bash's `agent | ` / `agent > ` vocabulary, the console restyles after Claude
Code (T54); the pass's **answer** is the `result` event's text, so a stream with no result or an
error result is `AgentPassFailed { exited }`; a failed pass emits **`PassFailed`** into the log
before its error propagates, carrying elapsed and, when a result arrived, usage; `AgentPassFinished`
carries elapsed and usage, rendered on its own finish line as a greppable `usage in=… out=… …
models=…` field, so the verbatim prompt stays the log's one multi-line event; bash's
no-write watch and heartbeat return as **`NoWritesYet`** (notifies, implement only, budget/3) and
**`PassStillRunning`** (120s, never notifies); `system`, `user`, `rate_limit_event`, and empty
`thinking` are dropped as bash drops them, and unknown types are ignored so CLI drift degrades
rather than kills. The ledger's token counts, `passes` and `models` — bash's, and silently dropped
by the port — return in T53 (§10), with bash's single summed `tokens` kept as its four components.
No symlink to the latest log: the plan block prints the path. T50–T55.

**The pass's budget is the dispatcher's, and the container carries a backstop past it** (T139).
The pass runs `timeout -k 30 <passTimeoutSeconds + 60> claude …` — the argv above, prefixed — while
`Effect.timeoutFail` over `Sandbox.exec` stays the budget and decides every live pass's outcome
(T9). The 60-second grace means the backstop never ends a live pass; it is there for a dispatcher
that died (`kill -9`), and for the process a killed `docker exec` client leaves running inside the
container. Exit 124 surfaces as a stream with no result, with no reason of its own. The image must
provide `timeout` (coreutils or busybox).


The two `rm -rf`s that clear a *dead* run's leftovers — `dispatch/checkout.ts`'s
clear-my-own-path and `reconcile/reconcile.ts`'s sweep — are plain `FileSystem` calls too, and no
longer turn on anything a rehearsal can produce: **a removal is authorized by a read** (T38), and a
recording layer keeps its reads real, so a fetch-back that recorded rather than fetched fails the
containment question and the directory stays. Nothing there is conditional on the flag — no op
learns a rehearsal is in progress, which is what `scripts/check-bans.ts` refuses. A rehearsal
cannot reach a **live** run's checkout either, because the recording `RunLock` refuses a branch a
live pid owns before the scope opens.

**The worktree-aware guard is a deliberate improvement over parity, not drift** (T5). Bash asks
`git symbolic-ref HEAD` (`run.sh:983-985`), which sees only the worktree the dispatch was typed in;
git refuses a fetch into a branch checked out in **any** worktree of the repo, so a branch held by a
linked worktree waves past bash's guard and dies later, at the docker preflight. The port asks
`Git.worktrees` instead and refuses up front, naming the branch and the worktree holding it, with
nothing acquired. The two tools therefore refuse a *different set* of dispatches — every one of them
a dispatch bash would have failed anyway, later and with a worse message.

**The spec mount is a dispatcher fact here and template prose in bash** (T37). Each of bash's three
prompt files opens by asserting the spec is mounted at `/spec.md`, and its feedback-only block
corrects only the feature-mode case (`pr-prompt.md`) — so a run whose recorded spec is gone still
hands two of its three passes a sentence sending them after a file that is not in the container. The
port's shipped templates name no file; where the spec is, is said by the generated dispatcher's
message, which is the side that knows whether one was mounted, and said in each pass's own register.
On a feedback-only run the messages say nothing about a spec, because `specMount` mounted nothing.
One sentence is held in reserve on that arm as a backstop (`NO_SPEC_MOUNTED`): prompts are the
client's to write (`PromptSource`), and an overridden template is free to assert the mount the
defaults no longer do. **It fires only under such a template** — the assembler tests the template
that won for `SPEC_TARGET` rather than assuming an assertion is there to retract, so against the
shipped defaults it never fires and a feedback-only run's three prompts contain no occurrence of the
path at all. A feedback-only pass therefore reads a *different prompt* under the two tools — bash's
points at a path with no file behind it, this one mentions a spec only when there is one.

---

## 13. Open items this spec does not close

| Item | Owner |
| --- | --- |
| clack verified against real branch/issue data — fuzzy fidelity, the TTY bracket under fiber interrupt, `taskLog` under real volume | **resolved** — ticket [13](13-prototype-clack-picker.md) confirmed clack with three amendments: options-getter + vendored pure scorer + explicit pass-through filter (the wrapper silently re-applies its substring default otherwise); clack-native cancel (Esc/Ctrl-C both abort) with visible `← Back` rows; interrupt bracket is `signal` passthrough. Focus-preservation on backspace-clear accepted as a divergence from fzf |
| Non-macOS/Linux host posture | map fog; the port inherits the bash spine's host assumptions until someone needs otherwise |
| v4 migration | conditional; ADR 0007's placement rule, escalated to the user at move-out |
| Bake-off outcome | ADR 0008 in hae, written when it resolves |
