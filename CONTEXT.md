# Bessemer

An AFK coding-agent dispatcher: it takes a task, runs an agent against a repository inside a
sandbox, reviews the result, and lands it as a branch and a PR. It runs on the dispatching host and
serves repositories other than its own.

## Language

### Repositories and roles

**Served repo**:
The repository a dispatch runs against — whose branches, base, forge, config, credential, and runtime
state the dispatch uses. Named once per invocation and never inferred from where the operator's shell
is standing. Its directory is the repo root (`repoRoot`).
_Avoid_: client, target repo, host repo

**Package**:
Bessemer's own source tree — its code, its default prompts, its lockfile. What an adopter's shim clones
and runs; never a place a served repo's facts are read from or written to. Its directory is the
package root (`packageRoot`).
_Avoid_: tool root, install dir

**Adopter**:
A team that has installed Bessemer to serve its own repository. A role, not a directory.
_Avoid_: client, customer, consumer

**Self-hosted**:
A dispatch whose served repo is the repository the package itself lives in — the only case in which the
dispatcher's own revision is chosen by a branch of the served repo rather than pinned.
_Avoid_: dogfooding, incubation

**speepobox**:
The name of this repository (`HireAnEsquire/speepobox`), the public one releases are fetched from.
It was also the tool's own name until T63 renamed the tool `bessemer`, and in `docs/` it still means
the tool under that old name: `@hireanesquire/speepobox` is the old package and the `speepobox/`
directory inside hae is where it incubated, never this repository. Code and tests use the word only
in the release URL, never as a name for the tool.
_Avoid_: speepobox as a name for the tool

### Roots and locations

**Read location**:
A file a dispatch reads — the served repo's config, the credential, prompt overrides, specs, the setup
hook. Always resolved against the served repo's directory, never the runtime root.

**Write location**:
A place a dispatch writes state — checkouts, locks, logs, the ledger. Always resolved against the
runtime root.

**Runtime root** (`runtimeRoot`):
The directory write locations resolve against, one per served repo. Defaults to the bessemer
directory. Moving it moves writes only; every read location stays where it was.
_Avoid_: state dir, cache dir

**Bessemer directory** (`.bessemer/`):
The one directory Bessemer keeps inside a served repo: its committed configuration, the operator's
private settings and credential, prompt overrides, and — by default — its runtime state. Everything
Bessemer reads from or writes to a served repo lives here or is named by something here.
_Avoid_: `.agentbox/` (hae's bash dispatcher, a different tool)

### Installing into a served repo

**Scaffold**:
The files `init` writes into a served repo's bessemer directory — its committed config, its
`.gitignore`, its agent image's Dockerfile and input list, and an empty tasks directory. Each file
belongs to the served repo from the moment it is written; Bessemer never overwrites one.
_Avoid_: adapter, boilerplate

**Template**:
The package's copy of one scaffold file, which `init` writes from and `init --diff` measures the
scaffold against. Each is versioned, and every scaffold file but the config carries a stamp naming
the template version it came from. Not a prompt: a prompt is never a template.
_Avoid_: adapter, skeleton

**Drift**:
A scaffold file whose template has moved on since the file was written — *behind*, in `init --diff`'s
terms. An adopter's own edits to a file are not drift.
_Avoid_: out of date, stale (stale is the agent image's word)

**Shim**:
The one scaffold file that is executed rather than read: a small committed script in the served repo's
bessemer directory that fetches the pinned package and runs it, naming the served repo from where the
shim itself sits. How an adopter's operators run Bessemer; a self-hosted repo has none.
_Avoid_: wrapper, launcher, installer, binary

**Pin**:
The package revision a served repo runs, recorded as a full commit id in its committed config so every
operator of that repo runs the same one. Changed by a one-line edit to that file and by nothing else
on a dispatching host.
_Avoid_: version, tool version, lock

**Release**:
A package revision a human has marked fit to pin, by tagging a commit on the default branch whose CI
passed. Releases are numbered in order and carry no other meaning. A pin normally names a release;
one that does not is allowed, and said.
_Avoid_: version (semver is not implied), build, publish

**Package cache**:
The per-host directory where the shim keeps one prepared copy of the package per pin, shared by every
served repo on that host. Not the runtime root: nothing a dispatch writes goes there, and nothing in
it belongs to a served repo.
_Avoid_: runtime root, install dir, cache dir (the runtime root's avoided term)

### Tasks and how they are stated

**Task**:
What a dispatch is to do. Stated in one of three ways — as a spec, as an issue set, or inline on the
command line with `--task` — and the passes are told it the same way whichever it was. A dispatch
states exactly one.
_Avoid_: work order, job, prompt

**Spec**:
A task stated as a file in the served repo. A bare name resolves under the tasks directory; a path
is used as-is. Inert: nothing writes back to it.
_Avoid_: task file, ticket

**Feedback**:
Text the dispatcher adds to one dispatch beside its task, reaching every pass of that run and no
later one. On a resume whose spec has gone, it stands in as the task.
_Avoid_: instructions, notes, context

### Passes and what they say

**Pass**:
One single-shot run of the agent inside the sandbox, handed its prompt and the task, and ending with
one answer. A dispatch runs three kinds in order — implement, review, describe-pr — and never retries
one.
_Avoid_: session, turn, call

**Prompt**:
What every pass of one kind is told regardless of the task: one file per pass kind, shipped as a
package default and replaceable whole by a served repo. The run appends the task, the branch facts,
and any feedback below it; nothing is interpolated into it.
_Avoid_: template, playbook, skill, system prompt

**Narration**:
What a pass says while it runs — its prose and the tools it uses — arriving line by line as it
happens. Progress, not result: nothing is decided by reading it.
_Avoid_: output, stream, log lines

**Answer**:
The text a pass returns when it ends. The only thing a review verdict or a PR description is read
from; narration never joins it.
_Avoid_: output, result text, final message
