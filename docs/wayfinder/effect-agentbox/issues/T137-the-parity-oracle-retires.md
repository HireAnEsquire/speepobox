# T137 — The parity oracle retires

Status: Done (PR #96. A resume put the oracle's last present-tense mentions in SPEC, PARITY, config.toml and the Dockerfile in the past tense. Host-checked after merge: image rebuilt, node src/bin.ts doctor green. MAP.md's two links to .agentbox/ROADMAP.md are dead until the map closes.)
Type: AFK
Blocked by: the hae install gate (private archive) — the gate is the oracle's last reader.

<!--
Ruled 2026-10-08 as P7's G14 (09's comment of that date), carrying out PARITY.md's ruling: the
oracle copy stays as the reference while P7's gate runs, and is deleted once the gate passes, in the
same change as one AGENTS.md line that pins the `run.sh:N` citations.
-->

## What to build

This repo stops carrying hae's bash dispatcher. Every citation into it still resolves, because one
line in AGENTS.md names the commit where the dispatcher can still be read.

- **Delete every tracked file under `.agentbox/`.** `git ls-files .agentbox` lists them.
- **Remove what exists only because that directory does:**
  - the `.agentbox/**` entries in the formatter and linter ignore lists;
  - ban 8 in `scripts/check-bans.ts` (T93), together with its comment and helper. It forbids
    importing a directory that no longer exists;
  - the README paragraph that describes `.agentbox/` as the carried oracle;
  - the comment in `src/prompt/fuzzy.ts` saying the clack prototype goes when the oracle goes.
- **Leave every `run.sh:N`, `tasklib.py:N`, and `.agentbox/…` citation in `src/` and `test/`
  alone.** There are about 260 of them, and they are history, not links. Add **one** line near the
  top of `AGENTS.md` naming the commit they resolve against, `6f66e9ac891462de809d207822c77d8f27615663`
  on `main`, which holds `.agentbox/` unchanged:

  > `run.sh:N`, `tasklib.py:N`, and `.agentbox/…` citations here refer to the deleted parity oracle
  > as of `6f66e9ac891462de809d207822c77d8f27615663`; read them with
  > `git show 6f66e9ac891462de809d207822c77d8f27615663:.agentbox/run.sh`.

- **Leave a test alone when it uses an `.agentbox/…` string only as data**, such as a setup-hook
  path or an env-file path. Change one only where it asserts that the directory exists. Check the
  dispatcher-freshness test, which lists `.agentbox` among the tracked directories.

## Effect wiring

- **Tags introduced or consumed**: none.
- **Layer composition**: unchanged.

## Acceptance criteria

- [ ] `git ls-files .agentbox` prints nothing.
- [ ] `AGENTS.md` names `6f66e9ac891462de809d207822c77d8f27615663`, and `git show` of
      `.agentbox/run.sh` at it prints the file.
- [ ] `npm run lint` passes with ban 8 gone.

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package.

Host-only, after merge: run `node src/bin.ts doctor` under plain node, and it is still green.
