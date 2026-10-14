# 20 — The agent pass narrates nothing until it ends

Labels: `wayfinder:grilling`
Map: [MAP.md](MAP.md)
Blocked by: —
Assignee: Scott Bowles
Status: closed (resolved 2026-09-10)

## Question

The port dropped bash's `--output-format stream-json --verbose` and has no replacement for
`stream-filter.py`, so a pass emits nothing until it finishes and **a pass that is killed emits
nothing at all**. What does the port's filter become — and what is a `stream-json` event once it
reaches `AgentOutput`, the run log, and the console?

---

Surfaced 2026-09-09 while resolving
[16 — What the tool keeps, and who deletes it](16-what-the-tool-keeps-and-who-deletes-it.md). 16
ruled that a run log is an audit trail kept indefinitely, on the grounds that a failed run leaves no
commit and no PR and so the log is its only witness. This ticket is the question that ruling
provokes: for exactly those runs, the witness is nearly empty.

## What is true today

Bash runs the pass as (`run.sh:1466`):

```
claude --dangerously-skip-permissions -p --output-format stream-json --verbose | python3 /agentbox/stream-filter.py
```

The port runs it as (`src/agent/agent-cli.ts:54-58`):

```
claude --dangerously-skip-permissions -p
```

Both streaming flags are gone. `claude -p` without `--output-format stream-json` buffers and prints
its final text at exit, so there is nothing on stdout until the pass ends.

**The port's plumbing is not the problem.** `execStreamed` (`src/internal/exec.ts:145-152`) is
`Stream.runForEach` over `Stream.splitLines`, concurrent with the exit-code wait, so lines are
delivered as they arrive — there are simply none to deliver. The seam is right; the source is silent.

### The measured shape

Every run in this repo's `.bessemer/logs/`, counting `agent >` lines:

| Run | Outcome | Log lines | `agent >` lines |
| --- | --- | --- | --- |
| `speepobox-t41` | killed at the wall | 80 | **0** |
| `speepobox-t44` | killed at the wall | 80 | **0** |
| `speepobox-t44b` | killed at the wall | 80 | **0** |
| `speepobox-tracer` | completed | 260 | 31 |
| `speepobox-t45` | completed | 283 | 54 |
| `speepobox-t42` | completed | 393 | 73 |
| `speepobox-t43` | completed | 484 | 73 |
| `speepobox-t39` | completed | 495 | 84 |

The three killed runs are byte-identical in shape: run start, checkout acquired, sandbox acquired,
the verbatim prompt, sandbox released, checkout released. **Nothing about what the agent did, or how
far it got, or why it stopped.**

### This was seen once and parked, not decided

[T9](issues/T9-agent-implement-pass.md), under *"The `Not-fixed` findings that stand"*:

> `AgentOutput` arrives as one burst rather than narration, because `claude -p` without
> `--output-format stream-json` prints its final text at the end; the seam is right and only the
> liveness is missing.

It reached a closed implementation ticket's comment section and went no further — never a decision,
never SPEC. **The assessment is the part that does not hold.** *Only the liveness is missing* is
true of a pass that finishes. For a pass that is killed it is not liveness that is missing, it is the
whole record — which is the case ticket 16's ruling exists to serve, and three of this repo's eight
runs.

Two claims in the code assert the opposite and are this ticket's to correct:

- `src/agent/agent-cli.ts:46-48` — *"The lines the CLI prints are the events"*, true of bash's argv
  and false of the port's, and it cites **"SPEC §12's expected-divergence list"** for an entry that
  does not exist (grep SPEC for `stream-filter`, `stream-json`, or `narration`: nothing). The same
  block cites `run.sh:1154` for the filter where this ticket's own reading above cites `run.sh:1466`;
  one of the two is wrong and settling which is part of correcting the claim.
- `src/run-log.ts:15` names `tail -f` on a running dispatch as the log's use. It shows the prompt,
  then silence for the whole pass.

## What this ticket has to settle

1. **What replaces `stream-filter.py`.** It is hae's, it does not travel, and it is what turns a
   `stream-json` event into a readable line. This is the root: a `stream-json` event is structured
   JSON, not prose, so `AgentOutput { line }` carrying it raw would render
   `agent > {"type":"assistant",…}` in both the log and the console.
2. **Whether `AgentOutput` stays a line or becomes structured.** Deciding 1 in favour of a filter
   keeps the event shape; deciding for a typed event moves the rendering choice into
   `run-log.ts`'s `summarize` and `app.ts`'s console renderer, which are two different audiences
   (`run-log.ts` prints a record, `app.ts` prints screens).
3. **What a killed pass leaves.** The failure this ticket exists for. Streaming makes the record
   arrive incrementally, but whether that is *sufficient* — versus the pass's stderr, or the
   `AgentPassFailed` cause carrying something — is a separate question that streaming does not
   automatically answer.
4. **Bash's two behaviours with no port analogue.** `run.sh:1493` greps the live stream for tool use
   (`^claude > (Write|Edit|NotebookEdit):|^claude > Bash: …`); `run.sh:1505` heartbeats a long pass
   (`... claude pass still running (Nm, cap Mm)`). Ported, dropped, or replaced by something the
   event stream makes cheaper.
5. **What it costs the archive.** 16 committed to keeping every log indefinitely. Bash's *filtered*
   logs already reach 218KB; unfiltered `stream-json` is materially larger, and the answer to 1
   decides the multiple. 16's disk finding (4.1MB / 63 files / 34 days) is the baseline this moves.

## Notes

- **16's ruling does not depend on this one.** Audit-trail retention and the per-run
  `<slug>-<runId>.log` path stand whatever 20 decides; this decides whether the kept file is worth
  the keeping. **16's implementation landed 2026-09-09** (T46, T47, T48), so the code this ticket
  reads is the post-ruling code and every citation here has been re-resolved against it.
- **Three more runs, and the shape above is unchanged.** T46, T47, and T48 completed at 289/60,
  270/41, and 281/52 lines — inside the 260–495 and 31–84 bands the finished runs already set, so
  nothing about the ruling's cost estimate moves. Only T48 wrote under the new naming
  (`speepobox-t48-1788981972550.log`); T46's and T47's dispatchers predated their own tickets and
  wrote the old slug names, which is why the table above is still readable by branch.
- **One cost 16 accepted is refunded if this lands.** 16 removed `<branch>.log`, whose stated
  justification in `run-log.ts:15` was `tail -f`. That justification is hollow while the pass is
  silent and becomes real if narration returns — at which point this ticket owes an answer for how
  a dispatcher follows a running pass: the plan block already prints the exact path, and a symlink
  is the other option.
- **Not a flag flip, which is why it is a decision and not an issue.** T39 was carved out as an
  implementation ticket explicitly *because* its fix was determined. Questions 1–4 above are not.
- **Verify the flags before designing against them.** `run.sh:1466` is evidence of what worked for
  bash at the time it was written, not a guarantee of the CLI's current surface.

## Resolution — 2026-09-10

**Narration returns as typed `Reporter` events, parsed on the dispatching host from the CLI's
`stream-json`, and a pass's answer is the result event's text.** The filter is a pure TypeScript
module beside the `AgentCli` tag; nothing travels into the image. A failed pass writes its own line
into the log, carrying the usage it burned. Bash's no-write watch and heartbeat return as events. The
console restyles after Claude Code's own UI; the log keeps bash's line vocabulary. Terms — **pass**,
**narration**, **answer** — are in the repo-root [`CONTEXT.md`](../../../CONTEXT.md).

### 1. The filter is a pure host-side parser

**`src/agent/stream.ts`**: a fold over the JSONL lines the CLI prints, producing narration lines and,
at the end, the result. `AgentCliLive` is its only importer, so what the CLI prints stays behind the
tag exactly as its argv does (05 Q22). Tested against a hand-trimmed JSONL fixture, no docker.

Rejected: parsing inside `execStreamed`, which is the chokepoint for every child and knows none of
them; and carrying `stream-filter.py` into the image, which is hae's and could not run there anyway
— the port's image deliberately ships no python (`image/Dockerfile:15`).

**Verified on the host CLI (2.1.267, 2026-09-10)**: `claude -p --output-format stream-json --verbose`
works and `--verbose` is still required. Events observed: `system/{init, hook_started,
hook_response, thinking_tokens}`, `assistant` with `thinking` / `text` / `tool_use` blocks,
`user/tool_result`, `rate_limit_event`, `result`. A `thinking` block arrives with **empty** text and
a signature — which is why hae's 1604-line filtered log has 0 `claude ~` lines. The image installs
the CLI unpinned, so the implementation verifies the same on the image's CLI before the flip.

### 2. `AgentOutput` is structured

```
{ _tag: "AgentOutput", pass, kind: "text",     text }
{ _tag: "AgentOutput", pass, kind: "tool-use", tool, brief }
```

- **One event per line of a `text` block** — bash's shape, and the one-event-one-log-line invariant
  (AGENTS.md) holds without a second exception.
- **One event per `tool_use` block.** `brief` is bash's `brief_input` verbatim: the first present of
  `command`, `file_path`, `path`, `pattern`, `description`, `prompt`; whitespace collapsed; 160
  chars, `...` past 157. The parity oracle reads the same line.
- **A non-JSON line passes through as `text`**; an unknown event `type` or block type is ignored.
  Drift in the CLI degrades to noise or silence on one line, never to a dead pass.
- **Dropped**: `system/*`, `rate_limit_event`, `user/tool_result`, empty `thinking`,
  `thinking_tokens`. Same list bash drops. `rate_limit_event` was the one candidate to keep (its
  `overageStatus` says why a pass may die) and is dropped for parity; unknown types are ignored, so
  keeping it later costs nothing.

Renderers own the prefix. The log prints `agent | text` and `agent > Tool: brief` — bash's vocabulary
under the port's `agent` label, greppable. The console is §7.

### 3. The answer is the result event's text

`runPass` returns `result.result` — what plain `-p` would have printed, and the contract bash's
verdict and PR-body reads ran on. Narration text is events only and never joins the answer.

- **No `result` event** (stream ended, exit 0 or not) → `AgentPassFailed { reason: "exited" }` with
  the detail naming it, and the flags as a suspect. Bash's filter exits 1 here.
- **`is_error: true`** → the same, with the result text's first 300 chars in the detail.

### 4. A failed pass reaches the log

Today the log of a killed run ends `sandbox: released` / `checkout: released` and says nothing about
the kill: `AgentPassFailed` renders on stderr at exit (`bin.ts:49`), after the log's bracket has
closed, and no `Reporter` event exists for it. Streaming alone does not fix that.

**New event `PassFailed { pass, reason, detail, elapsed, usage: Option<PassUsage> }`**, emitted by
`runPass` on its error path — after the timeout and the `mapError`, so a kill and an error result
both produce it — before the error propagates. The log gets one line. The console gets one short
line (`implement pass failed: timed out at 900s`); the stderr exit line keeps the recovery sentence
unchanged, since it is what a dispatcher acts on and what sets the exit code. **Does not notify**:
the run's terminal notification already says it failed. Bash prints both too (`TIMED OUT` on the
console, then the terminal line).

`usage` is some when a `result` event arrived (the error-result pass is the expensive one worth
seeing — bash's filter emits usage for failed passes on the same grounds) and none on a kill.

### 5. Usage rides on the pass's two terminal events

`PassUsage { input, output, cacheWrite, cacheRead, turns, costUsd: Option<number>, models }` from
the result event: `usage.*`, `num_turns`, `total_cost_usd` (none when 0 or absent — subscription
auth reports nothing, and 0 would read as free), `models` from `modelUsage`'s keys falling back to
the `model` fields seen on assistant events. **`AgentPassFinished` gains `usage` and `elapsed`.**

The log renders `implement pass finished (12m) usage in=… out=… cache_write=… cache_read=… turns=…
[cost=…] models=…` — the greppable record bash's ledger sums from. **The ledger columns
(`tokens`, `passes`, `models`, SPEC §10) are their own issue**, [T53](issues/T53-the-ledger-row-records-what-a-run-cost.md):
a schema change and a `status` renderer change, one reviewable concern.

### 6. The watch and the heartbeat return as events

Both live as fibers inside `runPass` racing the exec — the pass owns its budget and already reads
`passTimeoutSeconds` there — reading a `Ref` the `onOutput` path updates. Bash's numbers as
constants, not config: 30s tick, 120s heartbeat, warn at budget/3.

- **`NoWritesYet { pass, elapsed, budget }`** — implement pass only, once, when a third of the
  budget has passed and no `tool-use` event was `Write`, `Edit`, `NotebookEdit`, or a `Bash` whose
  command matches bash's `cat >|tee |sed -i|git apply|git commit|patch ` (`run.sh:1493`). A typed
  fold over the tool and its `command`, not a regex over rendered prose. **Notifies**, as bash's
  `notify_step` does: it is the one advisory aimed at a dispatcher who walked away. Renders under
  `WARN` in the log with bash's sizing sentence.
- **`PassStillRunning { pass, elapsed, budget }`** — every 120s for any pass. Both renderers; the
  log's timestamps make it redundant there and seven lines per 15 minutes is the price of one rule.
  **Never notifies.** A single ten-minute test run narrates nothing, which is why "narration is the
  heartbeat now" was rejected.

### 7. The console reads like Claude Code; the log stays a record

Console rendering moves to **`src/agent/render.ts`**, beside `doctor/render.ts` and
`dispatch/render.ts`, pure functions over the events, tested as strings; `app.ts` only dispatches.

- Tool use as `⏺ Read(src/run-log.ts)`, `⏺ Bash(ls src)`; prose indented two spaces with no prefix,
  blank lines kept so a block reads as a paragraph. `*` for the glyph when stdout is not a TTY.
- **`picocolors` becomes a direct dependency** (already in the tree under clack; honours `NO_COLOR`
  and detects a TTY itself). Tool lines dim, prose normal, `✗` red on `PassFailed`, `⚠` yellow on
  `NoWritesYet` and `WARN`, heartbeat dim. Doctor rows and the plan block are not this ticket's.
- **Pass boundaries as rules**: `── implement pass ──` at `PromptAssembled`, `── implement pass
  finished · 12m · 1.2M tokens · claude-opus-5 ──` at the end, which is what `elapsed` on the two
  terminal events is for.
- Heartbeat is a plain dim line, not an in-place spinner: rewriting fights interleaved narration.
- Every tool use is shown; collapsing runs of reads needs state across events in a renderer that
  prints one at a time, and the no-write watch is about exactly what the agent reads.

### 8. Following a run is by path; stderr is collected, not streamed

- **No symlink, no `latest` alias.** The plan block prints the exact `<slug>-<runId>.log` path
  before the pass starts and the console narrates. 16 just deleted the name two runs contend for.
  `run-log.ts:15`'s `tail -f` justification becomes true again and is reworded to say the log is
  followed by the printed path.
- **The CLI's stderr stays collected** (`execStreamed`), never streamed into the log. On finished
  runs it is noise; on a kill the narration says where it got to. `PassFailed`'s detail carries its
  tail (bash: last line, 140 chars) for the one case it is the clue — a stream with no result and
  exit 0. Lost on a kill, accepted.

### 9. Drift

No `doctor` probe for the stream format — a probe needs a container. The parser's tolerance (§2) and
the "no result event" detail naming the flags are the guard. Pinning the CLI in the image is the
image's own recorded gap (`image-inputs.sh:22`), not decided here.

### 10. Vocabulary

**Pass**: one single-shot run of the agent CLI inside the sandbox — implement, review, describe-pr.
**Narration**: what a pass says while it runs — text and tool use — arriving as events.
**Answer**: the text a pass returns when it ends, what plain `-p` prints, the only thing a verdict or
a PR body is read from. "Output" meant both, which is how T9's review could call this gap
"liveness".

### 11. What it costs the archive

Nothing beyond bash. The filtered record is the same line vocabulary bash keeps, plus one usage line
and a handful of heartbeat lines per pass. The raw stream is ~100× the filtered lines — a probe pass
of two tool calls and one reply was 35.6KB raw against ~250 bytes filtered, `user/tool_result` alone
15KB, since it carries every tool's full output — which is why raw-to-log was never a candidate.
16's 4.1MB / 63 files / 34 days baseline stands.

### 12. How it lands

Six issues, each green on its own (T41's lesson):

1. [T50 — The stream parser reads what the agent CLI prints](issues/T50-the-stream-parser-reads-what-the-agent-cli-prints.md)
   — the pure module and its fixtures, with no caller. The expand step.
2. [T51 — The agent pass narrates as it runs](issues/T51-the-agent-pass-narrates-as-it-runs.md) —
   the argv flip, structured `AgentOutput`, the answer from the result, the dry-run result line,
   and the comment corrections. The migrate. Blocked by T50.
3. [T55 — A pass's end says what happened and what it cost](issues/T55-a-pass-end-says-what-happened-and-what-it-cost.md)
   — `PassFailed`, plus `elapsed` and `usage` on both terminal events, each on one log line.
   Blocked by T51.
4. [T52 — A long pass says it is still running, and a reading pass says it has not written](issues/T52-a-long-pass-says-it-is-still-running.md)
   — `NoWritesYet` and `PassStillRunning`, their timing in a pure `pass-watch.ts`. Blocked by T55.
5. [T53 — The ledger row records what a run cost](issues/T53-the-ledger-row-records-what-a-run-cost.md)
   — `tokens`, `passes`, and `models`; SPEC §10. Blocked by T55, parallel with T52.
6. [T54 — The console reads like Claude Code](issues/T54-the-console-reads-like-claude-code.md) —
   `agent/render.ts`, glyphs, colour, and rules. Blocked by T52.

T51, T55, and T52 render their events with plain sentences, so each is green before T54 restyles.

**Re-sliced 2026-09-11 by a `/to-tickets` review.** This session first authored five issues. The
review changed five things:

- **The split.** The first T51 held five interlocking pieces, and MAP's sizing record says that
  does not land. Its terminal-event half became T55.
- **Usage stays on one log line.** The first T51 rendered usage as a second line under the finish
  line. That contradicted §2 and §5 above and SPEC, so it now stays on one line.
- **T52 tests timing as values.** It was written to test timing through a forked fiber under
  `TestClock`, which `agent-cli.test.ts` records as a race. Its timing is now a pure function
  tested as values.
- **T53's edge.** Its blocking edge on T52 gated nothing, so it became a dispatcher's precondition.
- **T54's scope.** It no longer renders T52's events only "if T52 has landed".

## Corrections to this ticket's own premises

- **`run.sh:1466` is right; `agent-cli.ts:47`'s `run.sh:1154` is wrong** — 1154 is the
  `FEEDBACK_EDIT` editor block. T51 rewrites that comment.
- **Not only narration is missing from a killed log — the failure is too** (§4). The ticket assumed
  streaming would make the witness sufficient; it makes it *present*.
- **Bash's `claude ~` thinking lines never fired** on any current CLI: thinking blocks arrive empty.
  Dropping them costs nothing that existed.
- **The port already dropped bash's token accounting** without a ticket: `run.sh:2188` sums
  `claude $ usage` into ledger `tokens`/`passes`/`models` and `src/ledger/record.ts` has none of
  them. Question 5's "cost to the archive" was the wrong cost to ask about; the ledger gap is the
  one that had no witness at all. T53.
- **The multiple is ~100×, not "materially larger"** (§11).

## Surfaced

- **The image's CLI is unpinned** and this ticket's parser now depends on its output format. Already
  recorded as a known gap in `image-inputs.sh:22`; goes to the map's *Not yet specified* as a
  decision the stream dependency sharpens.
