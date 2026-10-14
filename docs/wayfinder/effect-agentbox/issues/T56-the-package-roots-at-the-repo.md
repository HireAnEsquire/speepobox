# T56 — The package roots at the repo

Status: Done (PR #16; the ticket's four path facts missed a fifth — `tasks/tracer.md`'s smoke test
wrote `tasks/TRACER_OK.md`, which would have recreated and committed, inside a served repo,
the directory the move deletes — and `tasks-dir` turned out to be the one fact no test pinned until
`0d7061a`)
Type: AFK
Blocked by: none — [T49](T49-the-freshness-question-names-its-source-set.md) (step 1) landed
2026-09-09. **Merge this with no dispatch in flight**: 18 §5 records that the move must not race
one, and a running dispatch resolves its lock, log, and checkout paths from a package directory
this ticket deletes.

<!--
[Ticket 18](../18-where-the-package-lives-and-what-it-is-called.md)'s resolution, step 2 of four
("Rooting — `git mv`, `tasks-dir`, the `.gitignore` move, `setup-hook.sh`'s path"). Step 1 was T49.
Steps 3 and 4 are T57–T63 and are blocked on this one.

What rooting is, in 18's words: the package "stops anchoring anything to its own directory". The
coupling that made the manifest call this one switchover was a single line —
`defaultConfig.runtimeRoot = packageRoot` — and T57 cuts it. This ticket only moves the files and
fixes the four facts that name the old path. **Nothing about roots, names, or `.bessemer/` is in
scope here.**

Two things 18 priced into rooting are deliberately *not* here, by the `/to-tickets` pass of
2026-09-14: the `speepobox/` path citations in `docs/` (18 §3 counted 209; they are swept once,
with the name, in T63), and the `.bessemer/` runtime-state move (T57). This ticket is the move and
what the move breaks.
-->

## What to build

**Every tracked entry of `speepobox/` sits at the repo root, and the four facts that named the old
path name the new one.** After this lands, `git ls-files` shows no path beginning with `speepobox/`,
`packageRoot` (three `dirname`s up from `src/config/paths.ts`) *is* the repo root, and
`findRepoRoot(packageRoot)` answers the same directory — with **no code change to either**: the
derivation was written to be right in a checkout and under the shim's cache clone alike, and rooted
is just another checkout.

### The move, as one commit of pure renames

`git mv` each tracked top-level entry of `speepobox/` to the repo root:

```
.gitignore  .oxfmtrc.json  .oxlintrc.json  AGENTS.md  ISSUE_TEMPLATE.md  config.toml
package.json  package-lock.json  prompts  scripts  src  tasks  test  tsconfig.json
vitest.config.ts  vitest.live.config.ts
```

A `git mv`, not a `--path-rename` and not a history rewrite (18 §1: the extraction has run, so this
rewrites nothing). Make the move its own commit with no content edits in it, so `git show --stat -M`
renders it as renames and a reviewer can read every content change in the commits that follow.

Untracked things under `speepobox/` (`node_modules/`, `.env`, `logs/`, `locks/`, `checkouts/`,
`runs.jsonl`, `.claude/`) are not git's to move and stay where they are. In the container that means
one thing you must do yourself — see *Inside the container* below. On the operator's host it is the
*After it merges* note at the end.

### The four path facts

1. **`config.toml`** — `tasks-dir = "tasks"` becomes `tasks-dir = "tasks"`. Its comment
   explains the value by the incubation nesting; rewrite it to the fact that holds now: relative to
   the repo root, which the package now sits at.
2. **`.gitignore`** — the moved file *is* the repo's first root `.gitignore`. Its entries stay
   (`.env`, `config.local.toml`, `node_modules/`, `logs/`, `locks/`, `checkouts/`, `runs.jsonl`);
   its comment "under the package's own root" is still literally true and T57 is what changes it.
3. **`setup-hook.sh`** — `PACKAGE="$WORKSPACE/bessemer"` goes; the hook `cd`s to `$WORKSPACE` and
   runs `npm ci` there. Its header names `speepobox/config.toml`; that is `config.toml` now.
4. **`.github/workflows/ci.yml`** — delete `working-directory: bessemer`;
   `cache-dependency-path` becomes `package-lock.json`.

Two templates say where to run the gate. `docs/wayfinder/effect-agentbox/issues/TEMPLATE.md`'s
Verify section reads *"Run from `speepobox/`"*; make it *"Run from the repo root"*. Check
`ISSUE_TEMPLATE.md` for the same line and fix it if it has one.

### Lint now scans the whole repo, and must not touch the oracle

`npm run lint` runs `oxlint` and `oxfmt --check .` from the package directory — which is now the repo
root. `.agentbox/proto-clack-picker/` holds five `.mjs` files and a `package.json`, and T40's standing
rule is that **`.agentbox/` gains no file of ours and is never edited** (it is the read-never-executed
parity oracle, 12). A formatter that rewrote or a linter that failed on it would be exactly that
edit.

Add `ignorePatterns` to both `.oxlintrc.json` and `.oxfmtrc.json` for `.agentbox/**`, `docs/**`,
`image/**`, and `.claude/**` (the last is untracked on the operator's host and would otherwise be
scanned there). `tsconfig.json`'s `include` and `vitest.config.ts`'s `include` are already scoped to
`src`, `test`, `scripts` and need nothing.

### The guard declares the repo root's own neighbours

T49's guard (`test/dispatcher-freshness.test.ts`, *"the package's tracked top-level entries"*) reads
`git ls-files` under `packageRoot` and fails the suite on a top-level entry that is neither in the
source set nor in the declared not-source list. Rooted, `packageRoot` is the repo root, so the
repo's own top-level entries become the package's — and **this is the guard doing its job**: it
forces this ticket to declare each one rather than let the freshness scope widen without anyone
saying so.

Declare, with a one-line reason each in the comment beside the list:

- `.agentbox` — hae's dispatcher, carried as the oracle; never run by a dispatch.
- `.github` — CI's declaration, not the dispatcher's source.
- `CONTEXT.md` — the glossary.
- `README.md` — the front door, written below.
- `docs` — the map and its tickets.
- `image` — the agent image's inputs; the image probe (T30) already tracks these on its own.
- `setup-hook.sh` — the served repo's hook, read from the working tree (19 §7), not the
  dispatcher's source.

`config.toml` stays declared; it is still a top-level entry after this ticket and T57 is what
replaces it with `.bessemer`. The source set itself (`src`, `prompts`, `package.json`,
`package-lock.json`, `tsconfig.json`, `scripts`) does not change.

**One hardening T49 left for this ticket**: the guard reads `git ls-files` without asserting its
exit code, so in a tree where git runs but `ls-files` errors it passes on an empty set — the
under-inclusion direction the guard exists to close. Assert exit 0 before reading `stdout`.

### A README at the root

Rooted, the repo root is the front door, and there is no README (18 §6). Write one — three short
paragraphs, not a manual:

1. What this repo is: an AFK coding-agent dispatcher (ADR 0007), the TypeScript port of the bash
   dispatcher it was incubated inside.
2. `.agentbox/` is hae's bash dispatcher, carried whole as the read-never-executed parity oracle
   (ticket 12); it is not this tool and is never edited here.
3. `.bessemer/` is everything bessemer keeps in this repo (19 §10's wording, superseding 18 §6's
   "runtime state"). The directory arrives with T57; the sentence is true the day it does and
   describes the ruled layout until then.

### Inside the container

The setup hook that ran before your pass is the one on the operator's host — the *old* one — and it
ran `npm ci` under `/workspace/speepobox/`. After the `git mv`, `node_modules/` is still there and
there is none at the root, so **run `npm ci` at the repo root before `npm run verify`**. Egress is
open (ADR 0005); it costs a cold install and nothing else. Do not `git mv` `node_modules/` — it is
untracked and gitignored, and an `npm ci` against the lockfile is the tree the gate is supposed to
report on.

### Not in this ticket

- The `speepobox/…` path citations across `docs/` — T63 sweeps them with the name.
- `.bessemer/`, the runtime-root default, the config search root — T57.
- The name — T63.
- Any file under `.agentbox/` or `docs/adr/`, or the extraction script and manifest.

### After it merges (operator, on the host — not this pass)

Pull with no dispatch running. Then, once: `mv speepobox/.env .env` (the root `.gitignore` already
ignores it — this is `mv`, never copy, and T58 moves it once more into `.bessemer/`); move
`speepobox/{logs,locks,checkouts,runs.jsonl}` to the root if the ledger history should stay visible
to `status` (T57 moves them again into `.bessemer/`, so waiting for T57 and moving once is also
fine); `rm -rf speepobox/` once nothing wanted is left in it; `npm ci` at the root.

## Effect wiring

- **Tags introduced or consumed**: none.
- **Layer composition**: unchanged. No source file under `src/` changes in this ticket.

## Acceptance criteria

- [ ] No tracked path begins with `speepobox/`, and the move commit is renames only — every content
      edit is in a later commit.
- [ ] `npm run verify` passes from the repo root, and `npm run lint` reports nothing under
      `.agentbox/`, `docs/`, or `image/`; `git status --porcelain .agentbox` is empty after it runs.
- [ ] `config.toml`'s `tasks-dir` resolves to `<repoRoot>/tasks`, and the tasks-dir probe finds it.
- [ ] `setup-hook.sh` runs `npm ci` in `/workspace`, and CI's job runs from the repo root with the
      lockfile at `package-lock.json`.
- [ ] Every tracked top-level entry of the repo is either in the source set or declared not-source,
      each declaration with its reason; an undeclared entry still fails the suite; a non-zero
      `git ls-files` exit fails the suite instead of passing on an empty set.
- [ ] `README.md` exists at the root and states the three facts above.
- [ ] `git diff --stat origin/main -- .agentbox docs/wayfinder/effect-agentbox/extraction docs/adr`
      is empty.
- [ ] The suite passes.

## Verify

```
npm run verify
```

Run from the **repo root** once the move has landed — after an `npm ci` there, because the setup
hook installed under `speepobox/`. This is the gate — typecheck (with Effect diagnostics: **errors
and warnings break the build**, suggestions print), lint, and tests. `pre-commit` is not a substitute
and does not check this package. `lint` is what runs `check-bans.ts`, and after this ticket it is
also what scans the repo root — the criterion about `.agentbox/` is checked by the same command.
