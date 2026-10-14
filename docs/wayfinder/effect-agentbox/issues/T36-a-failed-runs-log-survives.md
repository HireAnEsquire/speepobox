# T36 — A failed run's log survives the next dispatch

Status: closed — superseded 2026-09-09 by
[ticket 16](../16-what-the-tool-keeps-and-who-deletes-it.md)'s ruling
Type: AFK
Blocked by: —

> **Parked 2026-08-20 — the evidence below is live, the mechanism is a proposal 16 rules on.**
> Do not dispatch this. It was written before
> [16 — What the tool keeps, and who deletes it](../16-what-the-tool-keeps-and-who-deletes-it.md)
> existed, and it answers two of that ticket's five questions — the retention rule and who deletes —
> for one class of log, by asserting them rather than by deciding them.
>
> **This ticket exists only because rotation clobbers.** The Context below says so: one generation, so
> the failing log becomes `.1` and the next dispatch pushes it out. 16 records that a timestamped
> *rotated* name costs no extra IO — `rotate` already calls `fs.stat` for its `size > 0` check and the
> same `File.Info` carries `mtime`. Rule that way and every log is already preserved under a name
> nothing else writes, which is this ticket's whole deliverable reached by not-deleting instead of by
> copying. The hardest thing left open here goes with it: AC4's *"contains the run's ending"* and the
> "terminal row or error channel" question both evaporate, because rotation runs at the **start of the
> next dispatch**, on a file already completely written.
>
> **Nothing can bite before 16 rules.** The 2026-08-18 incident below happened under **bash**, whose
> `cleanup` already has the timestamped-copy fix. The port's rotation only matters when *bessemer* is
> the dispatcher, and inside hae it never is — every sequence-1 dispatch ran `run.sh`. Self-hosting
> starts at [09](../09-post-move-sequence.md)'s P2; 16 resolves at P1.
>
> **What survives either way**, and is not new work: preservation never fails a run. `openRunLog`
> already degrades to a `Warned` event (`src/run-log.ts`).
>
> Reopen as `ready-for-agent` if 16 keeps one-generation `.1` rotation and hands retention to `gc`;
> close it if 16 makes rotation non-destructive.

> **Closed 2026-09-09 on this ticket's own condition** — *"close it if 16 makes rotation
> non-destructive."* 16 did more: **rotation is deleted, not repaired.** Each run writes
> `<slug>-<runId>.log`, so nothing is ever renamed and no dispatch can displace an earlier run's
> record. Preservation is reached by not-deleting, which is this ticket's whole deliverable with one
> mechanism instead of two, and AC4's *"the preserved copy contains the run's ending"* disappears
> along with the copy.
>
> **The evidence below was heard.** Its vote for *failure as the property that decides retention* —
> the option 16 said its own framing made easiest to overlook — is what carried Q1: a failed run
> leaves no commits and no PR, so its log is the sole witness, and that is why the log is an audit
> trail rather than last-run scratch. The ruling is wider than the vote, though: **every** run is
> kept, so nothing has to detect which ones failed.
>
> **One correction to the account below.** The 2026-08-18 `529 Overloaded` on `speepobox-t34` was a
> **near miss, not a loss** — this ticket's own text says the log *"survived only because that branch
> happened to see exactly one more dispatch."* It reads as a loss and was not one. That does not
> weaken the case: hae's ledger shows no branch ever reached a third dispatch, and feedback-resume
> makes 3+ dispatches on one branch the designed workflow, so the hazard was ahead of the traffic
> rather than behind it.
>
> The implementation is unauthored and goes through a `/to-issues` pass — see 16's resolution for
> the likely A/B split. Do not dispatch this ticket.

Not on the move-out path. It runs beside T15/T17 rather than after them, and touches one file plus
its test.

**Tracer: a dispatch that fails leaves a log no later dispatch can remove, and `bessemer status`
can still be pointed at it.**

## Context

Log rotation is one generation deep. `src/run-log.ts:86-96` renames `<slug>.log` to `<slug>.log.1`
and the new run writes a fresh file — the bash rule it was ported from
(`[ -s "$log" ] && mv -f "$log" "$log.1"`), quoted in its own comment.

One generation is enough for "what happened last run". It is not enough for a failure, because the
response to a failure is to dispatch again: the failing log becomes `.1`, the next dispatch pushes it
out, and the evidence is gone after two runs.

This is not hypothetical. On 2026-08-18 a server-side `529 Overloaded` ended a review pass on
`speepobox-t34`. The report that reached the dispatcher was "an API error killed a run" with no log
behind it, and answering "what exactly failed, and was it retryable" needed a log that had already
been rotated away. It survived only because that branch happened to see exactly one more dispatch.
The bash dispatcher now copies a failed run's log aside under a timestamped name nothing else writes
(`.agentbox/run.sh`, `cleanup`); this ticket is the port's half.

Note what is **not** wrong here: bessemer already writes a terminal ledger row on every exit path
(`src/dispatch/dispatch.ts:274-283`, "a terminal row is owed"), including failures. Bash did not, and
that was a separate defect. Only the log half is missing.

## What to build

When a dispatch ends in a failure, the run log is preserved under a name the rotation cannot reach,
in the same directory as the log itself.

**Timestamped, not numbered.** A second generation (`.2`) only buys one more dispatch and re-creates
the same cliff further out. A name derived from the run's own start time is written by nothing else,
so no later run can rotate, rename, or overwrite it.

**Every failing outcome, not a chosen subset.** The point is to have the evidence when the question
arrives, and which failures turn out to be interesting is exactly what is not known at the time. A
run that ends clean leaves nothing extra.

**Not cleaned up.** These are rare, gitignored, and outliving the runs is the whole feature. Say so
in a comment so a later tidying pass does not read the growth as an oversight.

**Preservation never fails a run.** `openRunLog` already degrades an unopenable log to a warning
rather than an outcome, on the reasoning that killing a run over its own logging is worse than the
silence it prevents (`src/run-log.ts:98-102`). A copy that cannot be written takes the same route: a
`Warned` event, not a failure.

Decide and record: whether the preserved copy is taken from the terminal row's outcome or from the
dispatch's error channel. The row is the more honest source — it is what the rest of the system
treats as the run's ending — but it is assembled late, so check it is available where the copy has
to happen, and say which you used and why in the comment.

## Effect wiring

- **Tags introduced**: none.
- **Tags consumed**: `FileSystem.FileSystem`, `Path.Path`, `Reporter` — all three are already in
  `openRunLog`'s signature, so no layer changes. `src/app.ts` is unchanged.
- **Layer composition**: unchanged. If the copy ends up in the dispatch's release path rather than in
  `run-log.ts`, it runs inside the scope `runInScope` already provides and still adds no requirement.

## Acceptance criteria

- [ ] A dispatch that ends in a failure leaves the run's log under a second, timestamped name in the
      log directory, in addition to whatever rotation does
- [ ] A dispatch that ends cleanly leaves exactly what it leaves today — no extra file
- [ ] Two failing dispatches on one branch leave two preserved logs; neither removes the other, and
      neither is removed by a third dispatch
- [ ] The preserved copy contains the run's ending, not just the part written before the failure
- [ ] A preserved copy that cannot be written emits a `Warned` event and does not change the run's
      outcome or exit code
- [ ] The rotation to `.1` still happens exactly as it does today

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package.

Add tests beside the existing rotation tests: a failing run preserves, a clean run does not, a third
dispatch removes neither preserved copy, and an unwritable target warns instead of failing. Drive
them through the same in-memory/temp-directory `FileSystem` the run-log tests already use rather than
through a real dispatch.

**Host-only**, and not required for the gate: after a failing dispatch, `ls .bessemer/logs/` shows
the preserved copy beside `<slug>.log` and `<slug>.log.1`.
