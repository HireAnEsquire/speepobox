# T47 — Each run writes its own log, and rotation is deleted

Status: Done (PR #7; `app.ts:183` and AGENTS.md were rewritten rather than merely de-asserted, since
the dry-run-costs-a-generation claim stopped being true along with the rotation)
Type: AFK
Blocked by: [T46](T46-the-plan-carries-the-runs-id.md) — the filename is the run id, and T46 is what
makes that id a fact of the plan rather than a second clock read.

<!--
[Ticket 16](../16-what-the-tool-keeps-and-who-deletes-it.md)'s ruling, implemented: a run log is an
audit trail, kept indefinitely, and nothing in the tool deletes one. SPEC is already amended (§5,
§12) and says each run writes its own file; this is the code catching up.

The clobber has never fired — 49 rows over 43 branches, max 2 dispatches on any branch — and that is
not reassurance. Feedback-resume re-dispatches the *same* branch once per review round, so 3+
dispatches on one branch is the designed workflow. It has not fired because feedback-resume is new
and because the hazard was hand-routed around: T44's second attempt went out as `speepobox-t44b`, a
fresh name, a workaround wearing a normal dispatch's clothes.
-->

## What to build

**Two dispatches of one branch leave two logs, and nothing in the tool renames or removes either.**

- **`logPathFor` keys off the run id** rather than the slug: the file is the run id plus `.log`,
  under the same `logs/` directory.
- **`rotate` and `ROTATED_SUFFIX` leave `src/run-log.ts` entirely**, with the comment block above
  `rotate` that records the reopened decision. `openRunLog` still creates the directory, still writes
  the header, and still degrades to console-only with a warning when the file cannot be opened —
  that arm is untouched.
- **`run-log.ts`'s file header keeps its first sentence and loses its second.** *"Logs are never
  deleted, so there is nothing for a `Scope` to release"* is the ruling. *"One generation — the branch
  and the PR carry the durable history, this is 'what happened last run'"* is the claim 16 broke:
  a failed run leaves no commits and no PR, so for exactly the runs anyone opens a log for, the log
  is the sole witness.
- **AGENTS.md's bullet on what the swap cannot reach** (*"what that still costs is one log
  generation"*, around line 84) describes behaviour that stops existing here. It is finished by T48;
  this ticket must at minimum stop it asserting a rotation that is gone.

### The filename, and the trap in how SPEC writes it

`runIdFor` returns `` `${slug}-${epochMillis}` ``. So the file is `` `${runId}.log` ``, which renders
as `speepobox-t3-1786000000000.log`. SPEC §5 and §12 write this shape as `<slug>-<runId>.log`,
describing the rendered name — **read literally it concatenates the slug twice**. The slug appears
once.

### What this costs, and what not to build

`<branch>.log` stops existing, so there is no path a dispatcher can type from memory without a
listing. 16 accepted that: the justification for a stable path was `tail -f`, which is silent for the
entire pass today ([ticket 20](../20-the-agent-pass-narrates-nothing.md)). **Do not add a symlink, a
`latest` alias, or a "most recent log" lookup** — that is a decision for whoever lands 20, not an
implementation detail of this ticket.

### Tests

- `test/run-log.test.ts`'s two rotation cases (*"rotates the previous log aside rather than
  truncating it"*, *"does not rotate when there is no previous log to keep"*) go. What replaces them
  is one case that opens two logs for one branch under one runtime root and asserts both files exist,
  each holding its own header and neither holding the other's.
- Three sites carry a literal path or a `logPathFor` call and move with the signature:
  `test/dispatch.test.ts` around lines 584, 2021 (*"keys the container, checkout, log, and lock off
  the same slug"* — the log no longer does), and 2242.
- Every other test reads `plan.logPath` as a value and needs no change. Keep it that way: nothing
  parses a log's filename and nothing globs the directory.

## Effect wiring

No tag introduced or consumed; no layer composition changes. `openRunLog` remains a plain effect over
`FileSystem` returning a `ReporterShape`, called after the lock is acquired, exactly where it is
called today.

## Acceptance criteria

- [ ] Two dispatches of one branch leave two log files, both readable, neither renamed and neither
      truncated.
- [ ] A log's filename contains its run's id exactly as the ledger row records it, so a log joins to
      its row by string equality — no timestamp arithmetic, no `fs.stat`, no `mtime`.
- [ ] The slug appears once in a log's name.
- [ ] `rotate`, `ROTATED_SUFFIX`, and every `.log.1` string are gone from `src/` and `test/`.
- [ ] The plan block's `log path` row prints the file the run will actually write.
- [ ] A log that cannot be opened still degrades the run to console-only with a warning rather than
      failing it.
- [ ] The suite passes.

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package.
