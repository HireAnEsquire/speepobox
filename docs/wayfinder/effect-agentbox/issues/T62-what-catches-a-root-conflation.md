# T62 — What catches a root conflation

Status: Done (PR #22; the ban reads import clauses, so a namespace import — `import * as paths` then
`paths.packageRoot` — passes it, and `packagePathspec` is a second, unbanned route to
package-relative paths that no rule names. Neither is fixed; SPEC §9 records on 2026-09-18 that the
ban catches the spelling rather than every route, so a green `verify` is not read as a proof)
Type: AFK
Blocked by: [T57](T57-config-and-runtime-state-live-in-the-bessemer-directory.md),
[T58](T58-the-credential-resolves-against-the-served-repo.md),
[T59](T59-a-prompt-override-lives-in-the-bessemer-directory.md),
[T60](T60-a-dispatch-names-the-repo-it-serves.md). **This edge is load-bearing** (19 §10): the ban
below is red on any tree where `config.ts`, `doctor.ts`, or `prompt-source.ts` still imports
`packageRoot`, and those three imports are exactly what T57, T58 and T59 retire. Written on its own
it looks takeable and gets grabbed first. T60 supplies `doctor`'s dispatcher revision and the
`selfHosted` value the roots row prints and the composition test drives.

<!--
[Ticket 19](../19-the-tool-serves-a-repo-it-does-not-live-in.md) §8, all three layers. The ticket's
own question 6 — an adopter-shape `doctor` probe — could not answer 18's worry: rooted (T56),
`repoRoot` and `packageRoot` are one directory here, so a probe run in this repo is as blind as the
code. "The catch has to be structural": a `check-bans` rule a future edit trips, a composition test
that serves a repo that is not the package, and a `doctor` row that makes the roots readable — what
would have made the probe's "green on nine probes" mean something.

19 §10 called the roots row free-standing. The `/to-tickets` pass of 2026-09-14 folded it in here
instead: it prints values T57 and T58 move, it may not import `packageRoot` under this ticket's own
ban, and it is the observable the composition test asserts on. Three pieces, one ticket, last of
step 3.
-->

## What to build

**Three layers, each catching what the other two cannot: a row that shows the roots, a test that
serves a foreign repo and reads the row, and a ban that makes the next conflation a lint error.**

### 1. The `doctor` roots row

One informational `ok` row, emitted **first** — before the docker probe — because it says what every
row after it is about. Probe name `roots`; detail on one line, in this order: the served repo, the
package's location and revision, the config file, the credential's source, and whether this is
self-hosted. For example:

```
serving /srv/hae; package /home/me/.cache/bessemer/abc123 at abc123; config
/srv/hae/.bessemer/config.toml; credential from /srv/hae/.bessemer/.env; not self-hosted
```

Every value is a parameter or derived from one. `DoctorHost` gains `packageRoot: string` and
`credential: Option<AgentCredential>` beside the `dispatcherRevision` and `selfHosted` T60 added,
all resolved in `bin.ts`. **`doctor.ts` may not import `packageRoot`** — that is the ban below —
so the package's location arrives as a value, the way the node version does and for the same
reason (AGENTS.md, *Host reads live at the composition root*). Probe 3 then reports on the
credential it is handed rather than resolving it again: one resolver call for the whole `doctor`
run, which is T23's rule taken one step further. The config path is `bessemerDir(host.repoRoot)`
joined to `config.toml`; the credential source is the `source` field T58 added (or *none* when the
`Option` is empty — probe 3 still says why). Self-hosted is T60's boolean.

The row never prints a value, only names and paths.

SPEC §7's probes table lists this row at its head, before probe 1, without renumbering the rest.

### 2. The composition test

`test/roots.test.ts`. Build a scratch served repo in a temporary directory that is **not**
`packageRoot`: `git init`, one commit, a branch to dispatch, a second branch checked out (the branch guard
refuses the one that is checked out), an `origin` remote URL (the forge guard reads it; nothing fetches),
`.bessemer/config.toml` naming an image and `base = "main"` (a local ref — the scratch repo has no
remote-tracking refs and `resolveBaseSha` refuses an unresolvable base), `.bessemer/.env` with a
throwaway token, `.bessemer/prompts/implement.md`, and `tasks/<spec>.md`. Docker and `gh` are
scripted through the executor `test/doctor.test.ts` already builds; git and the filesystem are
real — `test/dispatcher-freshness.test.ts` spawns real git in a scratch repo and is the precedent.

**Never export `GIT_DIR`, `GIT_WORK_TREE`, `GIT_COMMON_DIR`, `GIT_INDEX_FILE`, or any other git
location variable, in the test or in a helper it calls.** `GIT_DIR` plus `git init` rewrites the real
`.git/config` of whatever repo the process is standing in. Address the scratch repo with `-C` and
paths, as every other test here does.

Run two things against it:

- `doctor({ repoRoot: scratch, packageRoot, selfHosted: false, … })` composed as
  `test/doctor.test.ts` composes its layer — real `GitLive`, real filesystem, the scripted executor,
  a ref-backed reporter — plus `agentboxConfigLiveFor(scratch)`. Assert the roots row names the scratch
  directory as served, the real `packageRoot` as the package, `<scratch>/.bessemer/config.toml`,
  `<scratch>/.bessemer/.env`, and *not self-hosted*; that probe 8 names `<scratch>/tasks`; that
  probe 9 names `<scratch>/.bessemer`; that probe 10 reads *not applicable*.
- `dispatchCli([spec, "--branch", branch, "--dry-run"], scratch, credential, revision, forge,
  false)` under `appDryRunLiveFor(scratch)` with the scripted executor provided over it, as
  `test/dry-run.test.ts` provides its own. Assert the plan's checkout path and log path are under
  `<scratch>/.bessemer/`; the rehearsal's real log file exists there and nowhere under
  `packageRoot`; `PromptAssembled` reports the override as the client root; the recorded sandbox
  line mounts the spec from `<scratch>/tasks/` and nothing from `packageRoot`; and no freshness
  `rev-list` ran.

The positive form is the assertion — every served-repo read lands under the scratch directory —
because "nothing read from the package" cannot be asserted directly and is false anyway: the
package's own default prompts are a legitimate package read, and so is the dispatcher revision.

### 3. The ban

`scripts/check-bans.ts` already parses import clauses (`IMPORT_RE`) for the `Command` rule; this is
a sixth entry, not new machinery. **In `src/`, an import clause that names `packageRoot` is a
violation unless the file is `src/config/paths.ts` (the definition), `src/agent/prompt.ts` (the
default prompts), or `src/bin.ts` (the no-flag fallback, the dispatcher revision, and the
`selfHosted` predicate).** Scoped to `src/` like the `--dry-run` rule: tests import `packageRoot`
legitimately to build expectations. The message says why: *a served-repo read resolves against
`repoRoot`; `packageRoot` is the package's own location and may be read only where the package
reads itself (19 §8)*. Add it to the numbered list in the script's header and to SPEC §9's grep-ban
list.

Prove it trips: add a `packageRoot` import to `src/config/config.ts`, run `npm run lint`, read the
message, revert. Say in the PR that you did.

## Effect wiring

- **Tags introduced or consumed**: none.
- **Layer composition**: unchanged. The test composes `appBaseLiveFor` and `appDryRunLiveFor` from
  `app.ts` with the scripted `CommandExecutor` provided over them, the way `test/dry-run.test.ts`
  and `test/doctor.test.ts` already compose theirs.

## Acceptance criteria

- [ ] `doctor` prints a `roots` row first, `ok`, naming the served repo, the package and its revision,
      the config file, the credential's source, and self-hosted or not — and no value.
- [ ] `doctor` resolves the credential once, at the composition root; probe 3 reports the value it
      is handed.
- [ ] The composition test serves a scratch repo that is not `packageRoot`, and every served-repo
      path in the roots row, the probes, the plan, and the rehearsal's recorded lines is under it.
- [ ] `git grep -n 'GIT_DIR\|GIT_WORK_TREE\|GIT_COMMON_DIR\|GIT_INDEX_FILE' test/` matches nothing
      but comments.
- [ ] A `packageRoot` import anywhere in `src/` outside the three named files fails `npm run lint`
      with a message naming the rule; the tree as landed passes it.
- [ ] `src/doctor/doctor.ts` takes the package's location as a parameter.
- [ ] SPEC §7 (the row) and §9 (the ban) are amended.
- [ ] The suite passes.

## Verify

```
npm run verify
```

Run from the repo root — the package has sat there since T56. This is the gate — typecheck (with
Effect diagnostics: **errors and warnings break the build**, suggestions print), lint, and tests.
`pre-commit` is not a substitute and does not check this package. `lint` is what runs
`check-bans.ts`.
