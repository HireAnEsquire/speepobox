# The agentbox port bake-off closes for speepobox, decided rather than scored

Date: 2026-08-20. Closes the open item [0007](0007-agentbox-effect-typescript-port.md) left when it
said *"This ADR does not decide the winner … its outcome is recorded in a future ADR 0008 in this
repo."* Form and content follow
[ticket 09's Q6](../wayfinder/effect-agentbox/09-post-move-sequence.md), which fixed where this ADR
lives and what it owes.

**Decision: speepobox — the Effect-TypeScript port of 0007 — is the tool.** Bessemer, the python
port of [0006](0006-agentbox-extraction-python-rewrite.md), is **retired, not deleted**.

**This was decided, not scored.** Q6 fixed two claims as the bake-off's criteria — Claim 1
(guaranteed cleanup under failure) and Claim 2 (dispatch-core test quality) — each to be scored
against evidence captured at each port's own milestone. **Neither claim was ever scored.** The
identical failure-injection kill list Q6 specified was never run against both ports, so no
comparison exists to report. The winner was chosen by the owner on preference and momentum. Q6
required that a bake-off closed by any route other than its own criteria say so plainly rather than
present itself as a comparison that did not happen; that requirement is honoured here, and it is the
main reason this ADR is short.

## State of both ports at the call

Recorded because retirement is reversible and a future reader restoring the fallback needs to know
what was actually there, not what the decision implies was there.

- **speepobox** — incubating in hae on the `tseff` branch under `speepobox/`. Thirty-eight
  implementation tickets in `docs/wayfinder/effect-agentbox/issues/`, T1 through T35 landed, T15,
  T37 and T38 in flight or awaiting merge at the time of writing. Self-hosting in the weak sense
  that its own tickets are dispatched by hae's bash agentbox, not by itself. The extraction has not
  happened: ticket 09's P1–P7 are all ahead.
- **Bessemer** — `HireAnEsquire/bessemer`, a standalone python repo with its own ADR set and five
  merged PRs, its issue 13 split into three slices, and its **F3 milestone artifacts committed**
  (`docs/f3-tracer-report.md`, `docs/f3-tracer-runbook.md`). Q6's scoring point was "T5 AND
  Bessemer F3, whichever is later", so the milestone side of the bake-off was at least partly
  reached. What was never produced on either side is the matched evidence: the same kill list, run
  against both.
- **Adopters** — as recorded in Q6, Bessemer had confirmed *future* outside adopters and none
  deployed. No migration cost falls out of this decision. What does fall out is the commitment
  below.

## Consequences

1. **The waiting teams are handed speepobox.** This is the commitment Q6 named as a consequence
   rather than a score, and it now binds.
2. **Bessemer is retired, not deleted.** Retirement means stop investing. The repo stays as a cold
   fallback — the standing escape hatch of Q6, preserved through Q9. Returning to it is expensive
   and never impossible.
3. **Preserve Bessemer's port source before the `agentbox` branch is deleted.** Bessemer pins its
   port source to hae commit `e194121f75f4` on hae's `agentbox` branch, and that branch is slated
   for deletion. Deleting it orphans the pin and makes the fallback harder to reconstruct than
   "expensive". Tag the commit before the branch goes.
4. **Ticket 09's abandon clause is void.** 09 sequenced P1–P7 conditionally: *"if Bessemer wins the
   sequence is abandoned outright."* That branch is now closed. P1 through P7 are unconditional
   work.
5. **0006's tripwire keeps its trigger and loses one option.** Q9 anticipated exactly this state: if
   the bake-off has already closed in TS's favour by P3, the tripwire's only live option is
   mitigation. It still escalates to the user, it still does not enter the bake-off's criteria — a
   moot restriction now — and consequence 2 remains its floor.
6. **The name is a separate act and stays open.** Q10 fixed the order — rename the python repo to
   free the name, *then* rename speepobox — and that order still binds if the rename happens.
   Whether speepobox takes the `bessemer` name or keeps its own is **not decided here**. It is due
   before P6, because 01's shim pins a URL and outside installs churn if the name moves after them.

## What this ADR does not touch

The security core of [0004](0004-agent-sandboxing-workflow.md) /
[0005](0005-agentbox-dispatch-branches-iteration.md) / 0006 — hardlink-free clone, in-container
throwaway DB, credential-less container, host-side push, human merge gate, no write-side git inside
the agent's clone, draft PRs only, no published ports — is unchanged and remains mandatory, exactly
as 0007 restated it. Losing the bake-off does not weaken anything 0006 fixed; 0007 already reversed
the one decision that needed reversing (its rejection of TypeScript/node).

For the record, hae's four landed bash-dispatcher hardening fixes have equivalents in the port and
need no back-port: no-published-ports is structural in `speepobox/src/sandbox/spec.ts` (there is no
ports field to set), the origin-URL credential strip is `speepobox/src/git/repo-url.ts`, issue state
on the ref is how the port already reads issues, and refuse-to-run-an-older-self is owed by P1.
