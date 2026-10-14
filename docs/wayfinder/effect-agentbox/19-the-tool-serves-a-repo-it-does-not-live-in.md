# 19 — The tool serves a repo it does not live in

Labels: `wayfinder:grilling`
Map: [MAP.md](MAP.md)
Blocked by: —
Assignee: Scott Bowles
Status: closed (resolved 2026-09-10)

## Question

Every root the tool resolves against is its own: the repo it serves, the credential it
authenticates with, the prompts it assembles, and the state it writes all come from `packageRoot` or
from `runtimeRoot`, which defaults to it. Under the adopter shape those are three separate
directories. **Which roots belong to the served repo, and how does that repo declare what its
container needs?**

---

Surfaced 2026-09-04 by [09's P1 probe](research/09-p1-hae-probe-findings.md) — this dispatcher
pointed at `~/hae`, a repo it does not live in. The probe is exactly the second-client signal 09
bought the early throwaway run to get, and it paid: the pipeline works end to end against a foreign
repo, and every finding is about where the tool *looks*.

## Why this is unowned

09 named the probe and said what it was for; it did not pre-judge what the probe would find. The
findings are not in 09, not in [18](18-where-the-package-lives-and-what-it-is-called.md), and not in
any P-bullet — P6 is one line about a shim and a distribution story.

18 comes closest and stops short. Its question 2 asks *if the package roots at `/`, where does
runtime state go?*, and it reasons about the repo the tool **lives in**. The probe asks the same key
from the other side: `runtimeRoot` is also the root a *client* is allowed to speak from
(`prompt-source.ts`), so the answer 18 gives to "where does the tool write" silently decides "can an
adopter override a prompt". Those want deciding together, and only one of them is written down.

## What is true today

Six roots, and only one of them is the served repo's.

| What | Resolves against | Should be | Probe finding |
|---|---|---|---|
| Ownership label | `repoRoot` | — | correct already |
| The repo itself | `packageRoot` via `findRepoRoot` | `repoRoot` | 2 |
| Agent credential | `packageRoot` | probably `repoRoot` | 3 |
| Prompt override + `project-context.md` | `runtimeRoot`, defaulting to `packageRoot` | probably `repoRoot` | 4 |
| Checkouts, locks, logs, ledger | `runtimeRoot`, defaulting to `packageRoot` | **the open question** | 6 |
| Forge repo (`gh`) | the operator's shell cwd | `repoRoot` | 1, and it is [T39](issues/T39-the-forge-names-the-repo-it-opens-a-pr-on.md) |

The forge row is carved off deliberately: its fix is determined and needs no decision, so it is an
implementation ticket rather than part of this question. It is listed because it is the same cause
and because it is the one with a safety consequence — a `gh pr create` that lands wherever the
operator's shell happened to be.

Two further things the probe found are not roots at all but the same theme from the repo's side:
the served repo has **no way to declare container environment** (finding 7) and **no way to declare
container storage** (finding 8), where bash gives both through `--env-file` and volume flags.

## What has to be settled

**Questions 3 and 4 are answered — [18](18-where-the-package-lives-and-what-it-is-called.md) closed
2026-09-09 and this ticket inherits its ruling rather than deciding it a second time.** The
client-override root is **`repoRoot`**, not the runtime root: a prompt override and
`project-context.md` are read locations and facts about the served repo, which puts them on the rule
`paths.ts` already states in `resolveTasksDir` and which `tasks-dir` and `setup-hook` already obey.
And **`runtimeRoot` defaults to `<repoRoot>/.bessemer`**, so each served repo holds its own
checkouts, locks, logs and ledger and finding 6's shared-cache hazard does not arise. The two roots
have stopped being interchangeable, which is what question 3 said had to be decided with 18 rather
than after it. **Questions 1, 2, 5 and 6 are untouched and are this ticket's work.**

**Question 6 is no longer optional.** 18 roots the package at `/`, which makes `repoRoot` and
`packageRoot` byte-identical in this repo — so a root conflation stops being catchable here and an
adopter-shape probe becomes the only thing that can catch one.


1. **How a dispatch names the repo it serves.** A `--repo-root` flag, the shim passing its caller's
   directory, a config key, or some combination. `repoRoot` is already threaded as a required
   parameter everywhere downstream (`AGENTS.md`), so this is a question about the composition root
   and the shim's contract, not about plumbing.
2. **Where the credential lives.** Beside the repo it authenticates for, beside the tool, or found
   by a chain across both. Bears on `doctor`, whose green row currently means "*a* token exists",
   not "this repo can dispatch".
3. **Which root a client speaks from.** Today it is the runtime root, by a T14-adjacent ruling taken
   when all three directories were one. If a prompt override is a fact about the repo, this becomes
   `repoRoot` and the two roots stop being interchangeable — which is the part that has to be
   decided with 18 rather than after it.
4. **Where runtime state goes under the adopter shape.** 18 question 2 asks this for the incubation
   layout. The probe adds the constraint 18 could not see: with `runtimeRoot = packageRoot`, one
   shim cache holds every served repo's checkouts, locks, and ledger, and a repin that re-clones the
   cache takes them with it.
5. **How a repo declares what its container needs** — environment and storage. Bash's answer is
   `--env-file` plus volume flags plus a root `chown`. This package's sandbox is a typed spec with
   no mode on a mount and a one-variable allowlist, both of which were deliberate and both of which
   were designed for the tool's own needs rather than a client's. Whatever replaces them has to keep
   [SPEC §9](SPEC.md)'s two unrepresentable invariants intact.
6. **Whether `doctor` gains an adopter-shape probe.** Several findings here are conditions `doctor`
   could state — the served repo is named, its credential is reachable, its prompts are where it
   thinks. The probe's `doctor` run was green on nine probes while four of these were already true.

## Notes

**This does not block [16](16-what-the-tool-keeps-and-who-deletes-it.md)**, for 18's reason: 16
decides a retention policy, and `logPathFor` takes the runtime root as a parameter.

**It was entangled with [18](18-where-the-package-lives-and-what-it-is-called.md), and 18 went
first.** They shared question 4 and `runtimeRoot`'s default; 18 owned the key, so it ruled on both
with this ticket's client-override half in hand rather than blind, and the entanglement is spent. 18
is the incubation half, this is the adopter half — and the adopter half is now the larger of the
two, since 18's rooting removed this repo's ability to tell the roots apart on its own.

**Deadline is P6**, which is where the shim exists and where every one of these stops being
hypothetical. That is 09's own deadline for the rename, so the two land in the same window.

**The pipeline itself is not in question.** The probe's run went implement → review-approved →
fetch-back → push in six minutes against a foreign repo. Nothing here reopens that.

## Resolution — 2026-09-10

**The served repo is named once, at the composition root, and everything bessemer keeps in it lives
in one directory, `<repoRoot>/.bessemer/`.** The package keeps three things and no more: its code,
its default prompts, and its own revision. Every root the probe found reading `packageRoot` moves to
the served repo, and so do the two the table missed — the config search root and the freshness
pathspec. The vocabulary — the four roles, read and write locations, the runtime root, and the
bessemer directory — is in the new repo-root [`CONTEXT.md`](../../../CONTEXT.md).

### 1. A dispatch names its served repo; nothing infers it

**An explicit `--repo-root <dir>`, which the committed shim always passes, computed from its own
location.** The shim is committed inside the served repo, so where the shim file sits names that repo
for free — the same move `packageRoot` makes from `import.meta.url`. It is peeled off at the
composition root (`bin.ts`) **before** the `argv[0]` switch, because `status` and `doctor` never reach
`@effect/cli` parsing. With no flag the fallback is `findRepoRoot(packageRoot)` — the self-hosted
case — so this repo needs no change.

Rejected: walking up from the current directory, which brings back the input `AGENTS.md`'s repo-root
rule retired (*"the point is that the working directory stopped mattering"*); an `AGENTBOX_*`
environment variable, which is the config provider's namespace and would read as a config key; and a
config key, which is circular — config is found *through* the repo root.

Run with no flag from a global install, the fallback serves the package's own repo. Accepted: §8's
`doctor` roots row states which repo it resolved, and P6's shim is the fix.

### 2. `<repoRoot>/.bessemer/` holds everything bessemer keeps in a served repo

- **Committed**: `config.toml` — it carries `tool-sha`, which the shim reads before the tool exists,
  so it has to travel with the repo (SPEC §6) — and a `.gitignore`.
- **Ignored by that `.gitignore`**: `config.local.toml`, `.env`, `logs/`, `locks/`, `checkouts/`,
  `runs.jsonl`.
- **Prompt overrides and `project-context.md`**: `.bessemer/prompts/<name>.md`.

It is bash's `.agentbox/` layout under a new name, which is the shape hae already knows. **This repo
uses the same layout** — its `config.toml` moves into `.bessemer/` — so self-hosting is not a special
case. `runtime-root` stays configurable and defaults to the same directory, per 18.

A top-level `<repoRoot>/bessemer.toml` was considered and rejected for now: a new convention and a
second file for little gain. It may be worth revisiting as the main config file someday, and nothing
here forecloses that.

**This amends 18's path, not its root.** 18 put overrides at `<repoRoot>/prompts/<name>.md`; they move
to `<repoRoot>/.bessemer/prompts/<name>.md`. The root is still the served repo, so 18's ruling stands,
and bessemer stops claiming a top-level `prompts/` in an adopter's repo. **`prompt-source.ts`'s
`clientIsPackage` guard is deleted.** 18 said it survives, which was true only for 18's path:
`.bessemer/prompts/` is never the package's own `prompts/`, self-hosted or not.

### 3. The credential resolves against the served repo

**`<repoRoot>/.bessemer/.env`, then the process environment.** Nothing is read from the package
(probe finding 3: a repin re-clones the cache, and one cache serves every repo), and no user-level
file is added. The token belongs to a person, and a person who exports `CLAUDE_CODE_OAUTH_TOKEN` in
their shell profile already has the user-level answer. Not the repo's own `<repoRoot>/.env` either:
that file belongs to the application, and in any repo that is not hae it means something else.
`CREDENTIAL_ADVICE`'s *"beside config.toml"* stays true unedited.

T23's shape is untouched: one resolver, called at the composition root, the value `Redacted`,
forwarded by name. Only the root it is handed changes. `AGENTS.md`'s *Subprocesses and the
environment* says `<packageRoot>/.env` and is amended with it.

**Moving this repo's token is the operator's act, not a slice's.** `speepobox/.env` holds
`CLAUDE_CODE_OAUTH_TOKEN`. The operator moves it with `mv` — never copied, never read into any
agent's context, never touched by an AFK pass — and **only after `.bessemer/.gitignore` ignoring
`.env` has merged**, so no `git add -A` in the gap can commit it. Between the resolver change landing
and the move, dispatches are refused before the lock with probe 3's advice. That fails closed and is
acceptable.

### 4. Freshness is a self-hosted question

Verified: pointed at hae, `packagePathspec` renders `../bessemer/speepobox/src` and its siblings, and
`git -C ~/hae rev-list HEAD..origin/master -- ../…` exits 128 (`is outside repository`). That reads
as `BaseUnresolvable`, so **every adopter dispatch and `doctor` probe 10 print a false "git fetch"
warning.** The guard is off by accident, and the warning blames the base.

**Freshness applies only when self-hosted: `findRepoRoot(packageRoot) === repoRoot`.** The guard
exists because while the tool dispatches into itself, the checked-out branch decides which dispatcher
runs (09). Under the shim the dispatcher is a pinned SHA, and no branch chooses it. The composition
root decides the predicate once and passes it down as a value, so the preflight and `doctor` cannot
disagree. When not self-hosted the check is skipped, and `doctor`'s row reads *not applicable —
dispatcher pinned at `<sha>`*.

**`packageRoot === repoRoot` was considered and rejected.** It is false for this repo until rooting
lands (`speepobox/` against the repo root), so it would switch off the one case the guard exists for.
It would also skip a committed nested copy, whose revision really is chosen by the served repo's
branch. The case it was proposed against — a package under `node_modules`, where every pathspec is
gitignored and the check passes having checked nothing — cannot run: Node refuses to strip `.ts`
under `node_modules` ([01](01-ts-distribution-model.md)), and the shim's cache clone has its own
`.git`, so `findRepoRoot` stops there and freshness is correctly off. **One caveat, recorded so it is
not rediscovered:** if 01's fallback (a bundled `npm publish`) is ever taken, a copy under
`node_modules` would walk up to the served repo's `.git`, and this predicate has to be revisited then.

### 5. A repo declares its container environment with one key

**`sandbox-env-file`: optional, no default, a single path relative to the served repo, rendered as
`docker run --env-file <path>`.** hae needs it: it commits a sandbox env file its setup hook depends
on, which is why the probe could not run hae's backend spec.

- **Bessemer never opens the file; docker reads it.** That is *why* its values cannot reach argv, a
  log, or the ledger — the path may appear in any of them, the contents never. It is stated as the
  guarantee, not as an implementation detail.
- **An absolute value, or one whose normalized form leaves the served repo, is refused, not
  resolved.** This differs on purpose from `tasks-dir` and `setup-hook`, which accept absolute paths:
  this is the only key whose file's *contents* enter the sandbox, so the file stays inside the served
  repo, where review sees it.
- **A named file that does not exist is refused by a guard before the lock**, on the setup hook's
  rule (T7): a missing file is a guard's answer. No ledger row.
- **It is its own typed field on `SandboxSpec`**, separate from `env`, which stays bessemer's own
  one-variable-at-a-time allowlist. A single path, not a list, because list-valued keys merge per
  index across config layers.
- **The repo's `.env` is not passed wholesale** the way bash does; the credential stays on T23's
  name-only path.

Rejected: forwarding named host variables (an adopter would need every sandbox variable in the
dispatcher's own environment — the leak the allowlist exists to prevent), and literal values in
config (argv).

SPEC §9's two unrepresentable invariants — no ports field, no userinfo on a `RepoUrl` — are untouched.
Its `extendEnv: false` sentence is literally untouched too, since it governs what the docker CLI child
inherits from this process. A reader would still see a contradiction, so §9 gains one line drawing the
line this ruling draws: **the allowlist governs inherited parent environment, which stays banned; a
declared env file is the served repo's explicit act, carried in its own field.** Whatever the repo
puts in that file, the agent can read, and that is the repo's call (04).

### 6. Container storage: nothing is built

Probe finding 8 did not bite. This repo's hook runs `npm ci` into the bind-mounted workspace (T40),
and all three pieces bash had — the yarn cache, the macOS `client/node_modules` volume, the root
`chown` — were hae's, and the port already dropped them. A cache shared across runs is also a trust
edge, not a free feature: run N writes what run N+1 executes. So nothing is designed now. It goes to
the map's *Not yet specified* with the constraint any future design keeps: **docker-managed volumes
only, never a writable host directory, and `SandboxMount` stays mode-less.** It graduates when an
adopter's spec is shown to be blocked.

### 7. Tool configuration comes from the working tree; the code under work comes from base

This is probe finding 5, which this ticket's table left out. `config.toml`, `setup-hook` and
`image-build-command` resolve against the operator's working tree; the agent's checkout forks from
base. **Kept, written down, and nothing warns.** hae's disagreement came from the tool itself living on
a branch (`.agentbox/` existed only on `tseff`), a temporary state that P7 ends. Once `.bessemer/` is
on an adopter's default branch, the tree and base agree. Reading the hook from base (`git show`)
would give two answers, since config would still come from the tree, and a `doctor` warning would
fire on a state that stops existing.

### 8. What catches a root conflation

The ticket's question 6 as written — an adopter-shape `doctor` probe — cannot answer 18's worry.
Rooted, `repoRoot` and `packageRoot` are one directory here, so a probe run in this repo is as blind
as the code. The catch has to be structural, in three layers:

1. **A `check-bans` rule, and it is the load-bearing one: only `paths.ts`, `prompt.ts` and `bin.ts`
   may import `packageRoot`.** Each keeps a legitimate package read: `paths.ts` the definition and
   the freshness pathspec, `prompt.ts` the default prompts, `bin.ts` the no-flag fallback, the
   dispatcher revision and §4's predicate. `config.ts` (`:81`, `:153`), `doctor.ts` (`:101`) and
   `prompt-source.ts` (`:120`) lose their imports, so any new importer is a conflation by
   construction. This is the repo's house style: a mechanism a future edit trips.
2. **A composition test** that runs `doctor` and `--dry-run` with `repoRoot` at a scratch `git init`
   directory that is not `packageRoot`, and asserts that every served-repo read lands under it. It
   must not export `GIT_DIR` or any other git location variable: `GIT_DIR` plus `git init` rewrites
   the real `.git/config`.
3. **An informational `doctor` roots row** (`ok`): the served repo, the package's location and
   revision, the config path, and which source the credential came from. This is what would have made
   the probe's *green on nine probes* readable.

**One consequence: config loading takes `repoRoot` as a parameter.** The runtime-root default
`<repoRoot>/.bessemer` depends on the served repo, so it stops being a constant in `defaultConfig`.
That is the shape `resolveTasksDir` and `resolveSetupHookPath` already have.

### 9. Vocabulary

*Served repo*, *package*, *adopter*, *self-hosted*, *read location*, *write location*, *runtime
root* and the *bessemer directory* are defined in the new repo-root
[`CONTEXT.md`](../../../CONTEXT.md). The code names `repoRoot` and `packageRoot` ride inside *served
repo* and *package* rather than standing as terms of their own, and a moved runtime root is spelled
out there as moving writes only. *Client* stops appearing in new prose and survives only as the
existing prompt label (`PromptRoot = "client"`). `CONTEXT.md` is a glossary and nothing else.
`AGENTS.md`'s `## Naming` holds code conventions (role-not-vendor tags, the twelve-tag surface), not
domain terms, so nothing is defined in two places. `/domain-modeling` maintains the glossary, and
every grilling ticket on this map invokes it.

### 10. How it lands — not authored here

**Folded into the same `/to-tickets` pass as 18's step 3** ("the root rulings"), since this is the
same kind of change. 18's forced order is extended, not reopened. `sandbox-env-file` and the `doctor`
roots row do not depend on root placement and are free-standing slices. Nothing is carved out ahead
of the pass the way T49 was: every defect here shows up only for an adopter, and there is no adopter
before P6. **Deadline P6.** The implementation stays unauthored, following 16's and 18's precedent.

Inputs the pass must carry:

- **The `check-bans` slice lands last.** Written on its own, it is red on today's tree, because the
  four importers in §8 are exactly what the config, credential and prompt-source slices retire. So it
  is blocked by all three. Without that edge, a free-standing ban slice looks takeable and gets
  grabbed first.
- **T49's not-source list.** Step 2 (rooting) moves `config.toml` to the repo root, where it is
  already declared not-source. The step-3 slice that moves it into `.bessemer/` replaces that entry
  with `.bessemer`; the guard fails a slice that forgets. **`CONTEXT.md`** joins step 2's declarations
  beside `docs/`, `.agentbox/`, `image/` and `README.md`, since rooted it becomes a top-level entry.
- **18's README line** changes from *"`.bessemer/` is runtime state"* to *"`.bessemer/` is everything
  bessemer keeps in this repo"*.
- **The `.env` move is the operator's**, after `.bessemer/.gitignore` merges (§3).
- **The documents the pass amends**, since this ticket, like 18, edits none of them: SPEC §2
  (`SandboxSpec`'s env-file field), §6 (the config location, and the runtime-root default taking
  `repoRoot`), §7 (`--repo-root`, the roots row, probe 10's not-applicable arm), §8 (the prompt
  override path), §9 (the env-file line in §5), and `AGENTS.md`'s credential paragraph.

Left open on purpose: the default `tasks-dir` an adopter gets (P5's `init` writes it), and how the
shim reads `tool-sha` from `.bessemer/config.toml` (P6's implementation).

## Corrections to this ticket's own premises

- **Eight roots, not six.** The table missed two. The config search root: `configProviderChain` looks
  under `packageRoot` (`config.ts:153`), so under the shim an adopter can configure nothing, and the
  probe only ran because it wrote `config.local.toml` into the package. And the freshness pathspec
  (§4).
- **Probe finding 5 was left out** of the table, though the probe assigns it to this ticket (§7).
- **Question 6, as phrased, could not do its job** (§8).
- **Question 2's `doctor` worry dissolves** without a probe. The token belongs to a person, not a
  repo, so once `doctor` and `bin.ts` ask the one resolver with the same served-repo root, a green row
  carries T23's promise that this dispatch can authenticate.
- **The forge row** was already closed by
  [T39](issues/T39-the-forge-names-the-repo-it-opens-a-pr-on.md) (PR #5) before this ticket resolved.

## Surfaced

- **Repo-declared container storage** goes to the map's *Not yet specified*, with §6's constraint.
- **`docs/agents/domain.md` is a stale copy of hae's**: it describes hae's application, not this
  tool. Not this map's question. Flagged so nobody reads it beside `CONTEXT.md` as a second
  account of this domain.
