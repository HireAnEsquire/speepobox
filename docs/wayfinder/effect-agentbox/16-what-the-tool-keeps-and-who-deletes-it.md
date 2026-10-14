# 16 — What the tool keeps, and who deletes it

Labels: `wayfinder:grilling`
Map: [MAP.md](MAP.md)
Blocked by: — **unblocked 2026-08-21.** Was [09](09-post-move-sequence.md) P1, on the grounds that
this is worth deciding once the repo is its own. It now is: the extraction ran, and `doctor` reports
`runtime-root /Users/sbowles/bessemer/speepobox` — the tool's own root, not hae's `.agentbox/`, which
is the fact this ticket was waiting for. Retention can now be reasoned about against one runtime root
rather than two dispatchers sharing a host.
Assignee: Scott Bowles (claimed 2026-09-09)
Status: closed (resolved 2026-09-09)

## Question

A run leaves a log behind. What decides whether it is still there a month later — age, count, disk
budget, or something about the run it records — and which component does the deleting?

Downstream of that answer, and settled by it rather than before it: what a rotated log is named,
whether a rehearsal's log is its own class, and whether `--dry-run` should reach the log at all.

---

Surfaced 2026-08-20, reviewing T38. Not urgent: nothing is broken today, and the worst case is two
rehearsals of one branch costing one generation of that branch's log. It is here because the
decision that *was* made — [T38](issues/T38-a-removal-is-authorized-by-a-read.md)'s unit 3 — was
made against a two-option menu that left out what bash actually does, and the record now reads more
settled than it is.

## What is true today

`openRunLog` (`src/run-log.ts`) rotates by rename: an existing non-empty `<branch>.log`
becomes `<branch>.log.1`, and a fresh log is written. One generation, no more. That is bash parity —
`run.sh:1549` is `[ -s "$log" ] && mv -f "$log" "$log.1"` — inherited without being re-decided.

The log stands behind no tag, so the `--dry-run` layer swap does not reach it. A rehearsal therefore
rotates for real: it demotes that branch's last real log and overwrites whatever `.1` held. Two in a
row and the last real run's record of itself is gone.

**Bash does not do this.** Its `--dry-run` block derives the log path and *prints* it (`run.sh:2312`);
`dry_log` has exactly two uses in the script and neither opens or writes anything. Rotation lives
inside `run_task`, which a dry run exits before reaching. So the port's rehearsal is strictly more
destructive than the tool it ports, and SPEC §12 currently presents this as a known parity
divergence rather than as a regression. That line is corrected separately — it is a doc that is
wrong today, not a decision waiting on this ticket.

## What T38 decided, and the part of it that does not hold

T38's unit 3 chose **accept** over **put the log behind a tag**, and recorded the reasoning beside
`rotate`. One of its three arguments survives; two do not.

**Holds.** A rename has no postcondition, so no read closes this the way a containment question
closes an `rm -rf`. This is why the ticket could not solve it the way it solved the removals.

**Does not hold.** *"A rehearsal belongs in the log — `MutationRecorded` is a line this file renders
for no other reason, so a log the swap covered would leave the one event kind a rehearsal produces
with nowhere to land."* It lands on the console: `app.ts:60` renders `MutationRecorded`, which is
where bash puts a dry run's output too. The claim is true of the log file only.

The interesting part is that this argument is *right in a world where rotation does not destroy*. It
only fails against the clobbering rotation we have. Which is the shape of this whole ticket: the
rehearsal problem and the retention problem look like one problem because rotation fused them.

**Does not hold as stated.** *"The entrypoint cannot route around it, because `openRunLog` is called
after the lock, deliberately, so the one place allowed to know about the flag never sees this one."*
That is an argument about where the flag is *visible*, not about what is reachable. `scripts/check-bans.ts`
permits `--dry-run` in `app.ts`, `bin.ts`, `dispatch/command.ts`, and `src/dry-run/`; `dispatch/run.ts`
is not among them. So naming the flag at the call site is illegal — but that is not the only door.

## The three doors, and what each costs

**A tag.** `RunLog` joins SPEC §2's service list; the recording layer is a subscriber that writes
nothing. The lock ordering is untouched — the tag is provided in `app.ts` at composition time and
consumed at `run.ts:299`, exactly where the call is today.

The reason to want it is not the log. It is that SPEC §12 stops needing a caveat: "the swap covers
everything that writes" replaces "the swap covers everything except the filesystem, and here is the
list of what leaks." An invariant beats a list you have to maintain.

The reason to hesitate: the other seven tags bundle *operations*, and `openRunLog` returns a
`ReporterShape` — a subscriber the rest of the dispatch runs under. The tag would be the one entry
in §2 with a different shape, and every reader trips over it once.

**A different path for a rehearsal.** `dispatch/command.ts` may already name the flag and is what
composes the plan, so a rehearsal's plan can carry `logs/<slug>.dry.log`. `run.ts` gets zero
branches — the same code path, a different string, which is not the second dispatch path the swap
exists to delete. No tag, no §2 decision.

Its wrinkle: the plan block prints a `log path` row, and a dispatcher reads that block to see what a
*real* run would do. Showing the rehearsal's own path there is honest about the rehearsal and no
longer a preview of the run.

**Accept, once nothing is destroyed.** If rotation never overwrites, a rehearsal writing a log costs
nothing and bash not writing one becomes a difference rather than a defect. This is the cheapest
door and the only one that closes on the retention answer instead of preceding it.

## What this ticket has to settle

1. **The retention rule.** Age, count, disk budget, or a property of the run. This is the root: what
   the tool keeps determines what a filename has to encode, so deciding naming first pins the policy
   to whatever the name happens to carry.
2. **Whether an open PR exempts a log.** A branch still under review is the one whose log someone is
   most likely to want, and it is the one case where a count- or age-based rule deletes exactly the
   wrong file.
3. **Whether a rehearsal's log is its own class** with its own (shorter, or zero) life — which is
   the same question as door two above, arrived at from the other end.
4. **Which of the three doors**, given 1–3. The recorded leaning is **the tag**, for the invariant it
   buys rather than for the log. Not settled: building it before the retention answer risks doing the
   rotation work twice.
5. **Who deletes.** `gc` is the obvious home — [09](09-post-move-sequence.md)'s P4 already owns it,
   and "a human removes what the tool will not" is the posture `checkout.ts` and the reconciler
   already take. Open: whether `gc` needs to read `runs.jsonl` to answer 2, which would give it a
   dependency it does not have today.

## Notes

**[T36 — A failed run's log survives the next dispatch](issues/T36-a-failed-runs-log-survives.md) is
parked as this ticket's input.** Written before this one existed, it proposes a second timestamped
copy taken on every failing outcome and never cleaned up — which asserts answers to Q1 and Q5 for one
class of log. Its evidence is real and belongs here: a `529 Overloaded` ended a review pass on
`speepobox-t34` on 2026-08-18, and the log that would have answered "what exactly failed, and was it
retryable" had already rotated away. Two things to carry from it. Its mechanism is **redundant under
timestamped rotation** — preserving by not-deleting reaches the same place as preserving by copying,
with one mechanism rather than two, and its unresolved *"the copy contains the run's ending"* question
disappears because rotation runs at the start of the *next* dispatch on a file already finished. And
it is a live vote for **failure as the property that decides retention** (Q1's fourth option), which
is the one option this ticket's framing makes easiest to overlook.

**Naming, once the policy is known.** `rotate` already calls `fs.stat` for its `size > 0` check, and
that same `File.Info` carries `mtime` — so a timestamped rotated name costs no extra IO. `mtime` is
when the run stopped writing, which joins to `runs.jsonl`'s `timestamp`/`branch`/`pr_url` and lets a
reader match a log to its run and its PR. `.1` cannot do that after the second run. Two details if
this is taken: `@effect/platform` types `mtime` as `Option<Date>` for portability, so there is a
`None` arm to write that Node will never take; and two rotations inside one second collide.

**Keep `<branch>.log` stable whatever else changes.** It is the path a dispatcher can type from
memory and `tail -f` before a run starts. Only the *rotated* copy needs a unique name.

**The blast radius is one function.** `logPathFor` (`dispatch/plan.ts:33`) is the single derivation,
and every consumer — `render.ts`'s plan block, `notifications.ts`, `run.ts:189`, `agent-cli.ts:308` —
reads `plan.logPath` as a value. Nothing parses the filename and nothing globs the directory.

**Bash is not a constraint.** The two runtime roots (`.agentbox/logs/`, `.bessemer/logs/`) are
separate directories and neither side reads the other's. There is no handoff to preserve; at P7 the
old directory simply stops growing.

**Why post-P1.** This is a decision about a tool that is about to become its own repo, with its own
`gc` still unbuilt. Deciding it inside hae means deciding it against a runtime root that is
temporary.

---

## Resolution — 2026-09-09

**A run log is an audit trail, kept indefinitely, and nothing in the tool deletes one. Rotation is
deleted rather than repaired: each run writes `<slug>-<runId>.log`. A rehearsal writes no log.**

Four of the five questions dissolved rather than being answered on their own terms, and the door
that was taken is not one of the three this ticket listed.

### Q1 — the retention rule: keep, indefinitely

**The tool already had a written policy and this ticket did not cite it.** `tasklib.py:1085-1099`:
*"They're audit trail: never deleted, so there's nothing per-log for the dispatcher to decide"*, and
`gc` prints `— kept (audit trail, gc never deletes logs)`. `run-log.ts:1-4` agrees: *"logs are never
deleted, so there is nothing for a `Scope` to release."* So Q1's four-option menu — age, count, disk
budget, a property of the run — was open field only if that ruling was being re-decided. It is
ratified instead.

**But the same file contradicts itself**, which is the real reason the question felt open.
`run-log.ts:7-9` says *"One generation — the branch and the PR carry the durable history, this is
'what happened last run'."* Audit trail keeps forever; last-run scratch keeps one. The tool asserted
both, and `rotate` implemented the second.

**The contradiction breaks in favour of the audit trail, and disk is not why.** *The branch and the
PR carry the durable history* holds for every run except the ones anyone opens a log for. A failed
run leaves no commits and no PR — T41's row is
`{"terminalReason":{"_tag":"Failed","stage":"implement"},"outcome":null,"pr":null}` — so for exactly
the runs that need explaining, the log is the sole witness. That is what decides it.

Disk was checked and is not a factor either way: hae's `.agentbox/logs/` holds **4.1MB across 63
files over 34 days** of real dispatch (Jul 17 – Aug 20), largest single log 218KB. A disk-budget
rule would be machinery for a problem that does not exist at any plausible multiple of this rate.

### Q2 — open-PR exemption: dissolved

Nothing deletes, so nothing needs exempting.

### Q3 — a rehearsal's log: it writes none

**And this is not a new ruling — it restores what SPEC already said.** SPEC's CLI table specifies
`--dry-run` as *"Zero state: no lock, **log**, container, checkout, branch creation, or ledger
append."* The implementation diverged from that, and T38 then recorded the divergence in §12 without
noticing §12 contradicted the CLI table two hundred lines earlier.

Composed in `dispatch/command.ts`, which `scripts/check-bans.ts:31-35` already permits to name the
flag (`run.ts` is not permitted, which is why the plan carries the decision rather than the dispatch
op learning it is a rehearsal).

Two alternatives were weighed and refused. A rehearsal log kept like any other, and a marked
`.dry.log`, both **degrade the archive under Q2's answer**: `LedgerRecordingLive`
(`src/dry-run/ledger.ts:39-46`) swaps the ledger, so a rehearsal writes **no row** — its runId keys
nothing in `runs.jsonl`. Keeping the file means the archive has an orphan class and every reader
joining logs to runs learns the exception. Marking it makes the orphans greppable without making
them fewer.

What is lost is small and already covered: `MutationRecorded` renders to the console at `app.ts:60`,
which is where bash puts a rehearsal's output too. A rehearsal leaves no artifact because it did
nothing — not because it failed, which is the case Q1's answer exists to serve.

### Q4 — which of the three doors: none of them

The menu was a `RunLog` tag, a rehearsal-specific `logPath`, or accept-once-nothing-is-destroyed.
The answer is a fourth door the ticket did not have: **delete rotation.** Each run writes its own
path, so no rename exists and no clobber is reachable — by a re-dispatch, by a rehearsal, or by
anything else. `rotate` and `ROTATED_SUFFIX` leave `run-log.ts` entirely, along with the reopened-
decision comment block.

**The tag's prize is obtained without the tag.** The recorded leaning was the tag, and the ticket
was explicit that *"the reason to want it is not the log"* — it was the invariant, so that SPEC §12
could say *the swap covers everything that writes* instead of maintaining a list of what leaks. The
run log was the only item on that list; a rehearsal that opens no log empties it. §2's service list
is untouched and gains no odd-shaped `ReporterShape` entry.

**The name is `<slug>-<runId>.log`, and the runId is minted at plan time.** `runIdFor(slug,
startedAt)` (`run.ts:58`) is `runs.jsonl`'s own key, and `startedAt` is already in scope eighteen
lines above the `openRunLog` call (`run.ts:326` vs `run.ts:344`) — so the join from a kept log to
its run is **exact**, with no `fs.stat`, no `Option<Date>` arm, and no same-second collision.

This supersedes the naming plan in this ticket's Notes. `mtime` was chosen there because
`rotate`'s existing `fs.stat` carried it for free, but it joins `runs.jsonl` only by proximity:
verified on T41, the log's first line reads `16:27:33.661Z` where the row's `startedAt` is
`16:27:33.659Z` — **2ms apart**, because `openRunLog` calls `DateTime.now` again. Nothing derived
from a log's own mtime or content reproduces its runId. Under an audit-trail ruling, findability by
key *is* the retention feature; a log kept forever that can only be matched to its run by timestamp
proximity is an archive, not a record.

**The cost, stated plainly:** `<branch>.log` stops existing, so there is no path a dispatcher can
type from memory without a listing. The Notes justified keeping it stable on `tail -f` — which is
silent for the entire pass today (see the note on ticket 20 below), so the cost is near zero now and
becomes real if 20 lands streaming, at which point the plan block's printed path or a symlink is the
answer.

### Q5 — who deletes: nobody in the tool

A human with `rm`. `gc` reports and never removes, inherited from bash's `summarize_logs` — one
line, count and total size, never a row — and ratified by Q1. Recorded as an input to
[09](09-post-move-sequence.md)'s **P4**, whose only change is the glob: `*.log` and `*.log.1` become
`<slug>-*.log`. `gc` gains no dependency on `runs.jsonl`, since the question Q2 might have given it
— does an open PR exempt this log — no longer exists.

## Evidence, and what it does and does not support

**The clobber has never actually fired, and that is not reassurance.** hae's `runs.jsonl` holds 49
rows over 43 branches with a **maximum of 2 dispatches on any branch and none at 3**; ten `.log.1`
files exist and no branch reached a third dispatch. T36's own incident is a **near miss** — its text
says the log *"survived only because that branch happened to see exactly one more dispatch."*

The user's correction to this, and it inverts the reading: **the dispatch history to date is not
representative of normal development.** Feedback-resume re-dispatches *the same branch* once per
review round, so 3+ dispatches on one branch is the designed workflow, not an outlier. It has never
fired because feedback-resume is new and because the hazard was hand-routed around — T44's second
attempt went out as branch `speepobox-t44b`, a fresh name, a workaround wearing a normal dispatch's
clothes. So the zero is a fact about how these runs were driven, and normal use is the regime where
it starts to bite.

## Knock-ons

- **[T36](issues/T36-a-failed-runs-log-survives.md) closes**, on its own stated condition: *"close
  it if 16 makes rotation non-destructive."* This does more — rotation stops existing, so
  preservation is reached by not-deleting rather than by copying, and its unresolved *"does the copy
  contain the run's ending"* question disappears with the copy. Its live vote for **failure as the
  retention property** was heard and answered a wider way: failure is why the log matters (Q1), but
  every run is kept, so no class needs detecting.
- **SPEC amended**: §12's `--dry-run`-does-not-cover-the-run-log entry is **deleted from the
  divergence list** rather than reworded — parity is restored, so it is not a divergence — and the
  two paragraphs about it are replaced by the invariant. The `Scope` section's *"Log rotation is a
  plain effect, not a resource"* and §2's *"the rotated log file"* both lose their rotation.
- **The implementation is owed and unauthored.** It is **not** written as a ticket here: it is
  plausibly two slices — (A) the per-run path, where `logPath` stays a `string` and no consumer
  changes, and (B) the rehearsal writing none, where `logPath` goes optional and five readers move
  (`render.ts:43`, `notifications.ts:44,46`, `run.ts:220`, `agent-cli.ts:308`) — and mis-sizing that
  is precisely T41's failure. It goes through a `/to-issues` pass run against the current test
  layout, with the A/B split as an input rather than a decree.
- **Two comment blocks are wrong and are the implementation's to fix**, not this ticket's: the
  reopened-decision block beside `rotate` in `src/run-log.ts` (which the deletion removes outright),
  and `src/agent/agent-cli.ts:46-48`, which cites *"SPEC §12's expected-divergence list"* for an
  entry that does not exist — grep for `stream-filter`, `stream-json`, or `narration` in SPEC returns
  nothing. That citation is ticket 20's to correct.

## Landed — 2026-09-09

The `/to-issues` pass ran 2026-09-09 and came back with **three slices, not two**:
[T46](issues/T46-the-plan-carries-the-runs-id.md) (the run id becomes a field of the plan, so the
filename and the ledger row carry one string rather than two clock reads),
[T47](issues/T47-each-run-writes-its-own-log.md) (the per-run path, rotation deleted), and
[T48](issues/T48-a-rehearsal-opens-no-log.md) (`logPath` goes optional, seven readers move — two more
than the resolution counted). **All three landed 2026-09-09** (PRs #6, #7, #8), each approved in review
round 1, so this ruling is fully in the code: the live `logs/` directory holds per-run filenames
beside the old slug-named files, and the one surviving `.log.1` is a pre-T47 artifact nothing will
ever touch again.

Two things the implementation settled that the resolution left open: the two clock reads land
**0–2ms** apart rather than seconds, because `planFor` sits past the guards — which weakens the
ticket's motivating example without touching the reason to keep them independent; and the
rehearsal's absent path is rendered through one helper (`logPathOrNote`) rather than asserted at
seven sites, so no `Option.getOrThrow` and no path-shaped empty string reached a dispatcher-facing
message.

## Surfaced

**[20 — The agent pass narrates nothing until it ends](20-the-agent-pass-narrates-nothing.md)**,
unblocked. Found while asking whether keeping every log forever buys anything: for the runs Q1's
answer exists to serve, the kept file is 80 lines of prompt and scaffolding. It is a separate ticket
because 16 is what the tool keeps and 20 is what goes in it, and because its fix is genuinely
undetermined.
