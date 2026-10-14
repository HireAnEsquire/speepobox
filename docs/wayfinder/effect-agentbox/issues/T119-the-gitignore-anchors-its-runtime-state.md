# T119 — The .gitignore anchors its runtime state

Status: Done (PR #81. Anchors config.local.toml too, the same defect; .env stays unanchored on purpose.)
Type: AFK
Blocked by: None — can start immediately.

<!--
Graduated from MAP's Not yet specified (surfaced 2026-09-30 reviewing T113, PR #72). It lands
before P7 because a template bump is free only while no adopter holds a v1 stamp. Terms:
**scaffold**, **template**, **stamp**, **drift** (CONTEXT.md).
-->

## What to build

The scaffolded `.bessemer/.gitignore` ignores the runtime state at the bessemer directory's top
level only, so nothing under the tasks dir is ever ignored by accident.

Today `templates/.gitignore` (T113) lists `config.local.toml`, `logs/`, `locks/`, `checkouts/`, and
`runs.jsonl` without a leading `/`. A `.gitignore` pattern with no slash but a trailing one matches
at any depth, so `.bessemer/tasks/f/logs/x.md` is ignored. That breaks MAP's 2026-08-20 rule that
issue folders stay tracked (carried into P5 as E8). T113's `check-ignore` pin does not probe it.

### The template

- Anchor those five entries with a leading `/`: `/config.local.toml`, `/logs/`, `/locks/`,
  `/checkouts/`, `/runs.jsonl`. They name files the runtime root and the config layer write at
  the bessemer directory's top level, and nowhere else.
- **`.env` stays unanchored, on purpose.** A stray credential file anywhere under `.bessemer/` is
  never committed. Say so in the template's comment, one line.
- `/*-edit-*/` is already anchored. Leave it.

### The stamp

The template's text changes, so **bump `.gitignore` to version 2** in `TEMPLATE_VERSIONS`
(T113's rule).

### This repo's own .gitignore

`.bessemer/.gitignore` is stamped `v1` and edited (T112). Anchor the same five entries in it, keep
`.env` unanchored, and restamp its first line with v2 and the new template's body digest. Leave the
rest of the file alone. It must still read `current, edited`, never `pristine`.

## Effect wiring

- **Tags introduced or consumed**: none. This changes a template, a version constant, and this
  repo's copy.
- **Layer composition**: unchanged.

## Acceptance criteria

- [ ] `templates/.gitignore` anchors `config.local.toml`, `logs/`, `locks/`, `checkouts/`, and
      `runs.jsonl`, and leaves `.env` unanchored with a comment saying why.
- [ ] `TEMPLATE_VERSIONS[".gitignore"]` is `2`.
- [ ] The `check-ignore` pin in `test/init-stamp.test.ts` also asserts that these are **not**
      ignored: `.bessemer/tasks/f/logs/x.md`, `.bessemer/tasks/f/locks/x.md`,
      `.bessemer/tasks/f/checkouts/x.md`, `.bessemer/tasks/f/runs.jsonl`, and
      `.bessemer/tasks/f/config.local.toml`. It also asserts that these still **are** ignored:
      `.bessemer/locks/x`, `.bessemer/checkouts/x/y`, `.bessemer/runs.jsonl`,
      `.bessemer/config.local.toml`, and `.bessemer/tasks/f/.env`.
- [ ] This repo's `.bessemer/.gitignore` carries the same anchors and the v2 stamp.
      `node src/bin.ts init --diff` from the repo root reports it `current, edited`, reports
      `No drift.`, and exits 0.
- [ ] A test pins that a v1-stamped `.gitignore` reads `behind` against the v2 template, the
      upgrade an adopter scaffolded before this ticket will see. T118's Dockerfile case in
      `test/init.test.ts` is the worked example.

## Verify

```
npm run verify
```

Run from the repo root. This is the gate: typecheck (with Effect diagnostics: **errors and
warnings break the build**, suggestions print), lint, and tests. `pre-commit` is not a substitute
and does not check this package.

```
node src/bin.ts init --diff
```

Run from the repo root. It exits 0, and all three stamped files read `current, edited`.

```
git check-ignore -v .bessemer/logs/x .bessemer/runs.jsonl
```

Run from the repo root. Both lines still match, now on the anchored patterns. A host run of this
repo keeps its runtime state out of git.
