# T135 — The legacy read adapter retires

Status: Done (PR #95. `legacy.ts` and `LEGACY_SCHEMA_VERSION` gone; an unversioned line is skipped with a warning naming its line. The resume brought AGENTS.md's T31 and T67 rules, SPEC §10 and its oracle paragraph, and CONTEXT.md in line with the deletion. Host-checked: `node src/bin.ts status` reads this repo's ledger with no `skipped` warning.)
Type: AFK
Blocked by: None — can start immediately.

<!--
Ruled 2026-10-08 as P7's G3 (09's comment of that date). The adapter existed for one job: the
read-only, side-by-side `status` comparison in 09 Q7. Bash never reached hae's master and its
history was dropped, so that comparison will never happen. PARITY row 3.9 marks the adapter
transitional.
-->

## What to build

`status` and every other reader of the ledger see only bessemer's own records. If a line in
`runs.jsonl` carries no `schemaVersion`, it is skipped with a `Warned` that names `file:line` and
says why, for example *"no schemaVersion — not a bessemer record"*. That is the same path any other
undecodable line already takes. Today such a line is decoded as a bash row instead.

Underneath that behaviour:

- Delete the legacy adapter module in `src/ledger/` and its cases in the ledger tests (the bash-line
  fixtures and the adapter's `describe` block).
- Drop `LEGACY_SCHEMA_VERSION` from the record schema, leaving `schemaVersion` with the single
  literal `CURRENT_SCHEMA_VERSION`.
- **Do not narrow `RunRecord`'s optional fields** (`runId`, `startedAt`, and the others whose
  comments say "absent on legacy lines"). A version-1 line may encode them as null, so narrowing
  them is a schema change under T31's rule, not a deletion.
  - Reword those comments only where they name a reader that no longer exists.
  - `CURRENT_SCHEMA_VERSION` does not move.
- Mark PARITY row 3.9 retired here, and replace SPEC §10's legacy-adapter paragraph with one
  sentence saying T135 deleted it.

## Effect wiring

- **Tags introduced or consumed**: none. `Ledger`'s shape is unchanged; only its line decoder loses
  an arm.
- **Layer composition**: unchanged.

## Acceptance criteria

- [ ] A ledger test covers a line with no `schemaVersion`: it is skipped with a `Warned` naming its
      line, and the version-1 lines around it still decode.
- [ ] `git grep -n 'decodeLegacyLine\|LEGACY_SCHEMA_VERSION'` finds nothing in `src/`, `test/`, or
      `scripts/`.

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package.

Host-only, after merge: `node src/bin.ts status` reads this repo's `.bessemer/runs.jsonl` with no
`skipped` warning, because every line there carries `schemaVersion`.
