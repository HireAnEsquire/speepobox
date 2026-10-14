# 09 P1 — the hae probe: findings

Run 2026-09-04. Source for [ticket 19](../19-the-tool-serves-a-repo-it-does-not-live-in.md) and
[T39](../issues/T39-the-forge-names-the-repo-it-opens-a-pr-on.md).

[09](../09-post-move-sequence.md) put an **early throwaway probe** in P1 to recover the
second-client signal that switching over last would otherwise lose: hae installs like an outside
team would, so nothing before P7 exercises the tool against a repo it does not live in — the shape
09 calls adopter #1 and P6's shim produces for everyone else.

This is that probe. **Every finding below is about the adopter shape, not about hae.**

## What was run

A one-off dispatch of hae's own `smoke-frontend` spec, from this repo, against `~/hae`:

```
AGENTBOX_PROBE_REPO_ROOT=/Users/sbowles/hae \
  node src/bin.ts smoke-frontend --branch probe/p1-adopter-shape
```

`AGENTBOX_PROBE_REPO_ROOT` is a throwaway override at `bin.ts`'s composition root, discarded with
the probe branch; finding 1 is why it had to exist. Alongside it, a gitignored `config.local.toml`
setting `tasks-dir = ".agentbox/tasks"`. `image` (`hae-agentbox`) and `base` (`origin/master`) are
already hae's, so the code defaults stood. **No `runtime-root` flip** — 09 is explicit — so locks,
logs, checkouts, and the ledger stayed under this package, which is finding 8's whole subject.

hae was checked out on `tseff`; see finding 5 for why that mattered. Per 09 the artifact was
discarded: branch deleted local and remote, override reverted, runtime state removed.

## The pipeline works

Six minutes, ledger row `approved`. The container started under `--cap-drop ALL` with no added caps
and no setup hook, the agent authenticated inside it, the implement pass made a real commit, the
review approved on round 1, the describe-pr pass wrote a PR body, the fetch-back landed both commits
in hae, and the push put the branch on hae's origin. `status`, pointed at hae, printed the row with
hae's spec path as its source.

So the question 09 asked has a yes. Everything below is what the yes is standing on.

## The one safety finding

### 1. The forge takes its repo from the operator's shell

`git` is scoped to a repo explicitly — `inRepo` renders `git -C <at> --git-dir=<at>/.git`
(`git/git.ts:301-308`), so no git call can drift. **`gh` is scoped by nothing.** The helper is
`exec(FORGE_CLI_BINARY, ...args)` (`forge/forge.ts:143`), `exec` and `execStreamed` take no working
directory at all (`internal/exec.ts`), and `prCreate` passes no `--repo` (`forge.ts:214-231`). So
`gh` resolves the repo from the **dispatching process's current directory**.

Measured, both ways:

```
$ gh repo view --json nameWithOwner,defaultBranchRef        # in ~/bessemer
{"defaultBranchRef":{"name":"main"},"nameWithOwner":"HireAnEsquire/bessemer"}

$ cd ~/hae && gh repo view --json nameWithOwner,defaultBranchRef
{"defaultBranchRef":{"name":"master"},"nameWithOwner":"<hae's repo>"}
```

The run was launched from this repo, so `gh pr create --draft --base master --head
probe/p1-adopter-shape` was aimed at **HireAnEsquire/bessemer**, which has neither ref. That is one
cause presenting as five clauses at once — `Head sha can't be blank`, `Base sha can't be blank`,
`Head ref must be a branch`, `Base ref must be a branch`, `No commits between master and
probe/p1-adopter-shape` — and it is the whole of why the run ended without a PR.

**It failed loudly by luck.** This repo has no `master` and no branch of that name. A repo that had
both would have taken a draft PR carrying another repo's work.

Invisible during incubation, because the directory a human dispatches from *is* the served repo. It
is the failure [`AGENTS.md`](../../../../AGENTS.md) argued out of existence for the repo root
— *make it unrepresentable rather than remembered*, "the working directory stopped mattering" — and
the forge is the one seam where the argument was not applied. Fix is determined, so it is
[T39](../issues/T39-the-forge-names-the-repo-it-opens-a-pr-on.md) and not part of 19.

## Where the tool looks, and where the repo is

These five share one cause: a resolution root that reads `packageRoot` or `runtimeRoot` where the
adopter shape needs `repoRoot`. They are [ticket 19](../19-the-tool-serves-a-repo-it-does-not-live-in.md).

### 2. The tool cannot name a foreign repo at all

`bin.ts` derived the repo root from its own package root, so the only repo it could serve was the
one it lives in. The probe needed a source edit to exist.

Under the shim this is not cosmetic: `node <cache>/src/cli.ts` makes `findRepoRoot(packageRoot)`
walk up from the cache clone and answer with the cache clone, never the adopter's repo. **P6 cannot
ship without a way to name the served repo.**

### 3. The credential resolves against the package

`bin.ts` and `doctor.ts` both read `<packageRoot>/.env`. `doctor` reported `ok credential` during
the probe only because *this repo's* `.env` holds a token — hae's `.agentbox/.env` was never
consulted.

Under the shim an adopter's token would have to be written into the tool's cache clone: a
git-managed directory the shim may re-clone at any repin, and one directory shared by every repo
that adopter serves.

### 4. The prompt override is dead for an adopter

`prompt-source.ts` resolves the client root as `config.runtimeRoot`, and `runtimeRoot` defaults to
`packageRoot`, so on a default config `clientIsPackage` is true and **the override branch never
runs**. The dry run and the real run both reported `assembled from the package default` for every
pass, while hae's own `implement-prompt.md`, `review-prompt.md`, and `pr-prompt.md` sat unread.

[T14](../14-done-conflates-approved-with-landed.md)'s neighbour ruling chose the runtime root over
`.agentbox/` and was right for incubation, where the package, the runtime state, and the served repo
are one directory. The adopter shape splits them into three. A prompt override is not a nicety: it
is how a repo tells the agent what its verify command is, and `project-context.md` — the fragment
the design offers *instead of* patching — is unreachable by the same line.

### 5. Working tree and base ref can disagree about where the tooling lives

`image-build-command` and `setup-hook` resolve against the repo root's **working tree**; the agent's
checkout forks from **base**. In hae those are different answers — the whole of `.agentbox/` exists
on `tseff` and not on `origin/master` — so with `master` checked out the build script the config
names is not on disk, while `--base origin/master` is still the correct base. Nothing warns.

### 6. The adopter's source lands inside the tool

`checkouts/`, `locks/`, `logs/`, and the ledger all sat under `speepobox/`, because they follow the
runtime root and the runtime root is the package. The probe's clone of hae was at
`.bessemer/checkouts/probe-p1-adopter-shape`.

Under the shim that is every adopter's working tree, and every adopter's run history, inside one
shared cache clone of the tool. It sharpens
[18](../18-where-the-package-lives-and-what-it-is-called.md) question 2 past *where does the tool
write*: it is whether one adopter's checkout can end up beside another's, and whether a repin that
re-clones the cache takes them with it.

## What a repo cannot tell the tool

### 7. No repo-declared container environment

hae's bash passes `--env-file "$BOX/.env.sandbox" --env-file "$BOX/.env"` (`run.sh:1690`). This
package forwards exactly one variable — the agent credential's name, no value (`sandbox/spec.ts`) —
and the allowlist grows "one variable at a time, each with a note naming which child reads it".

That discipline was written for variables *this package* needs and has no answer for variables the
*repo* needs. hae's `setup-db.sh` states it must agree with `.agentbox/.env.sandbox`
on its database connection variables, so the port cannot run hae's **backend** smoke spec as
written. That is why the probe ran the frontend one.

### 8. No repo-declared container storage

Bash gives its container three things this package has no shape for (`run.sh:1686,1711`): an
anonymous volume over `client/node_modules`, because a bind-mounted `node_modules` on macOS is the
slow path; a `/yarn-cache` volume shared across runs; and a root `docker exec … chown agent` on
both, which is what `CAP_CHOWN`/`DAC_OVERRIDE`/`FOWNER` in bash's cap-add list exist for.
`SandboxMount` has no mode field on purpose — the workspace is the only writable thing by shape —
which was right for a read-only spec file and leaves nowhere to put a cache.

**It did not bite this task**: `pre-commit`'s typescript hook ran and passed. The gap is real for
the general case and is not proven to block hae's frontend spec.

## Smaller notes

- **`--dry-run` writes a run log.** The usage string promises "no lock, no container, no checkout,
  no PR, no ledger row" and kept all five, but the rehearsal wrote a real log into the runtime root,
  which then took part in rotation when the real run started. Nothing was lost, and a rehearsal log
  is arguably the point — but under the adopter shape it means a dry run writes into the tool's
  cache.
- **No live narration during a pass.** Bash pipes the agent through `stream-filter.py`
  (`run.sh:1154`); that filter is hae's and is on [SPEC §12](../SPEC.md)'s expected-divergence list,
  so the log takes the verbatim prompt before a pass and the result after, and nothing between. With
  a 900s pass timeout an operator watching the log cannot tell working from hung. Known and accepted
  — recorded because the probe is the first time anyone sat through it. **It has since cost
  something**: T41's dispatch timed out at 900s having committed nothing, and the log holds the
  prompt, then fifteen minutes of silence, then the timeout — so the re-slice was reasoned from the
  ticket's shape rather than from any record of what the agent actually did.
- **`fatal: detected dubious ownership in repository at '/workspace'`** failed one pre-commit hook
  in both passes; the agent read it as environmental and correctly declined to fix it with a global
  git config change. **Open**: bash sets no `safe.directory` either, so hae's own runs may hit the
  same thing. Worth one check against a bash run before it is filed against the port.
- **Ownership labels were already right.** The container carried
  `agentbox.repo=8a10ae1fbd2b`, which is `sha256("/Users/sbowles/hae")[:12]` — the label scopes to
  the **served repo**, not to the tool. The one resolution root in the package that was built for
  this shape.
- **The container name still carries bash's prefix.** `agentbox-probe-p1-adopter-shape`
  (`CONTAINER_PREFIX`, `plan.ts`), and hae's bash dispatcher sweeps by that same **name** prefix, so
  a bash sweep can kill a container this package started. The reverse is safe — bash writes no
  `agentbox.managed` label, so this package's reconciler will not reclaim bash's containers. Open in
  both shapes, and during P7 the two dispatchers serve the same repo by design.
