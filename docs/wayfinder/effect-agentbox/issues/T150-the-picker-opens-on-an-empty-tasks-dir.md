# T150 — the picker opens on an empty tasks dir

Status: needs-triage
Type: AFK
Blocked by:

<!--
Found 2026-10-15 in hae, right after the v5 upgrade. `.speepobox/speepobox` with no arguments
printed `!! no specs under '<repo>/.speepobox/tasks' — write one there, or dispatch a path` and
asked nothing. The tasks dir was empty, and the ledger held six runs.

The refusal in `pickerArgv` (`src/picker/picker.ts`) predates T85. Its comment says why it was
right then: "the dispatcher's next move is to write a spec or to type a path, and neither is
something a list of no rows can say." T85 added two rows that need no tasks dir: the typed task and
the resume. So the list is never empty any more, and the refusal now hides both. An adopter who
dispatches by `--task` or by path, and keeps nothing in the tasks dir, can never open the picker.
-->

## What to build

### No refusal for an empty tasks dir

In `pickerArgv`, remove the refusal that fires when the tasks dir holds no specs and no features.
The picker then opens as it does today, with the source step listing the rows that remain: the
typed-task row and the resume row (`ENTRY_ROWS`), after `seededSourceRows` has filtered them for a
seed.

- The resume row over an empty ledger already has its own dead-end row that says why. Keep it.
- Keep the second refusal, the one after the seed filter (`no features under …`). Typed `--issues`
  over a tasks dir with no features still leaves no row, and that refusal still says the right
  thing.
- Keep the refusal for a tasks dir that cannot be read at all (`… cannot be read`). A missing or
  unreadable dir is a configuration fault, and `doctor` reports it; this ticket does not change it.
- Rewrite the comment above the removed check: an empty tasks dir lists no spec or feature rows,
  and the typed-task and resume rows are still offered.

### Tests

Replace the test `refuses by naming the directory rather than opening an empty list` in
`test/picker.test.ts`. That refusal is the behaviour this ticket removes, so this is the one
existing assertion that changes. New tests:

- An empty tasks dir and no seed: the picker opens, and the source step offers the typed-task row
  and the resume row and nothing else. Picking the task row and answering the following steps ends
  in `--task "<text>" --branch <name>` words, as for a tasks dir that holds specs.
- An empty tasks dir with a seeded `--branch`: the source step offers the typed-task row only (the
  seed filter removes the resume row, as today).
- An empty tasks dir with a seeded `--issues`: still refused with `no features under`.

## Effect wiring

- **Tags introduced or consumed**: none new.
- **Layer composition**: unchanged.

## Acceptance criteria

- [ ] With an empty tasks dir, the picker opens and offers the typed-task and resume rows.
- [ ] The three tests above exist and pass.
- [ ] The `no features under` and `cannot be read` refusals are unchanged, and their tests pass
      without edits to what they assert.
- [ ] Every other picker test passes without edits to what it asserts.

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package.

Also inside the container: `node src/bin.ts < /dev/null` under plain node (no arguments, off a
terminal) prints the usage text, not a crash.

Host-only, after merge and a release: in hae, with `.speepobox/tasks/` empty, run
`.speepobox/speepobox` on a terminal. The picker opens on the source step, offering a typed task and
a resume.
