# T142 — The README says how to dispatch

Status: Done (PR #101. README §4 "Dispatching": branch prep, every form and flag, what a run does, status/doctor/gc, recovery, and eight config keys with code defaults. Upgrading and later sections renumbered.)
Type: AFK
Blocked by:

<!--
Found by T140's audit (2026-10-14). The README covers installing and upgrading, and says nothing
about running a task: no `--feature`, `--resume`, `--last`, `--dry-run`, or picker appears in it.
The only user manual is `docs/AGENT_SANDBOXING.md`, Lane B, which describes the deleted bash
dispatcher in hae's paths, and the public seed drops it. This ticket writes bessemer's own.
-->

## What to build

A **Dispatching** section in `README.md`, under "Using bessemer in your repo", placed after "3. The
shim" and before "4. Upgrading" (renumber the sections after it). It is for an adopter who has
finished the bootstrap and wants to run a task.

### Sources

- **Outline**: `docs/AGENT_SANDBOXING.md`, Lane B (`:160-713`). Use it for *which topics* a
  dispatcher needs and in what order. Do not copy it: it describes bash, and hae's paths and setup.
- **Truth**: `node src/bin.ts --help`, the parser and guards under `src/dispatch/`, SPEC.md §7 (the
  command table and the dispatch rules), and `CONTEXT.md` for the vocabulary. Where bash and
  bessemer differ (PARITY.md lists the divergences), describe bessemer. Every statement in the
  section must be true of the code at this commit.

### What it covers

- **Before a dispatch**: the branch must already exist, and bessemer never creates one. Show
  `git branch --no-track <name> origin/<base>`. Explain which branches are refused.
- **The forms**, each with one example command:
  - a spec file (a bare name resolves under the tasks dir);
  - `--task "…"`;
  - `--feature <folder> --issues …`;
  - `--resume <branch>`, with `--feedback "…"` or `--feedback-edit`;
  - `--last`;
  - no arguments on a terminal, which opens the picker.
- **The other flags**: `--base`, `--dry-run`, `--hard-reset`, `--allow-stale-dispatcher`, and
  `--no-input`. Say what each does and when to use it.
- **What a run does**, in order: the guards, the lock, the checkout, the container, the setup hook,
  the implement pass, the review rounds, the land, the PR, and the notification. Say where the run
  log is and that the plan block prints its path.
- **Watching and cleaning up**: `status` (including the OWNER column), `doctor`, and `gc` (listing,
  then `--force`).
- **When a run goes wrong**: a kept checkout, a `<branch>-from-run-<sha>` rescue branch, a dead
  dispatcher's run reclaimed by the next dispatch, and how to read the ledger. Keep this short and
  practical.
- **Configuration**: name the `.bessemer/config.toml` keys a dispatcher is most likely to change,
  with one line each: `pass-timeout`, `max-review-rounds`, `setup-timeout`, `notify`, `setup-hook`,
  `cap-add`, `memory`, and `pids-limit`. The keys are the ones `src/config/config.ts` reads; take
  each default from there. Point at `templates/config.toml`'s comments for the rest.

Every command is spelled `.bessemer/bessemer …`, as the rest of the README is. Link no file the
public seed drops: `docs/AGENT_SANDBOXING.md`, `extraction/`, T131, T134.

## Effect wiring

- **Tags introduced or consumed**: none. README only.
- **Layer composition**: unchanged.

## Acceptance criteria

- [ ] The README has a Dispatching section between the shim and upgrading sections, and the
      sections after it are renumbered.
- [ ] Every dispatch flag `node src/bin.ts --help` lists is explained in the section. The
      parser's built-ins (`--help`, `--version`, `--wizard`, `--completions`, `--log-level`) are
      not dispatch flags.
- [ ] Every command example is spelled `.bessemer/bessemer …`.
- [ ] Every config key the section names is read by `src/config/config.ts`, spelled as it is
      there, with the default given there.
- [ ] Nothing in the section is copied from bash's behaviour where bessemer differs, and no
      dropped file is linked.
- [ ] No file other than `README.md` changes.

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package.

Also inside the container. It prints nothing when every dispatch flag is in the README:

```
node src/bin.ts --help 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -oE -- '^--[a-z-]+' | grep -vxE -- '--(help|version|wizard|completions|log-level)' | sort -u | while read -r flag; do grep -qF -- "$flag" README.md || echo "missing: $flag"; done
```
