# T133 — Every git read outside the tag names its git dir

Status: Done (PR #94. One `repoArgs` in `src/git/repo-args.ts`, resolved inside `Effect.suspend`; `git.ts` uses it too, so `grep '"-C"' src` finds only its definition. Checked by hand: a worktree whose `.git` is a gitfile reads fine through the pair, and `doctor` under plain node is green on the git, freshness, and upstream rows.)
Type: AFK
Blocked by: [T132](T132-the-release-fetch-authenticates-through-gh.md) — both edit `src/git/releases.ts`.

<!--
Found 2026-10-05 by research/09-shim-fetch-auth-findings.md (Q4), and widened by a repo-wide grep
for `"-C"` in src/. The rule is T32's (AGENTS.md, "`-C` names a directory, and a directory is not a
repository").
-->

## What to build

T32 made every operation on `Git` name the repository as well as the directory
(`-C <repo> --git-dir=<repo>/.git`), so a path holding no repository fails naming that path instead
of answering for the nearest enclosing one. Five calls outside the tag still spell bare `-C`:

- `src/git/releases.ts` — `readRemoteReleases`'s `ls-remote` and `readHeadReleases`'s helper;
- `src/git/dispatcher-revision.ts` — both reads in `resolveDispatcherRevision`;
- `src/dispatch/guards.ts` — the guards' `git` helper;
- `src/doctor/probes.ts` — the git probe's `--is-inside-work-tree`, and the dispatcher-freshness
  read.

The package-root ones matter most: a package cache entry lives under `$HOME/.cache`, and on a host
whose `$HOME` is itself a git repository, a cache entry missing its `.git` would answer with
`$HOME`'s revision and tags.

Give all five the spelling `git.ts` already uses (`repoArgs`, with the path resolved absolute
first, as T32's note on `inRepo` explains), from **one** shared definition rather than a second
copy. After this, `grep -rn '"-C"' src` finds only that definition.

## Effect wiring

- **Tags introduced or consumed**: none.
- **Layer composition**: unchanged.

## Acceptance criteria

- [ ] No bare `-C` remains in `src/` outside the shared definition.
- [ ] A test per changed module: pointed at a directory that holds no repository but sits inside
      one, the read fails (or, for the probe, reports not-a-repo) instead of answering for the
      enclosing repo.
- [ ] Existing behaviour against a real repo root is unchanged.

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package.
