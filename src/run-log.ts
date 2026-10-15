// The per-run log file: a second `Reporter` subscriber over the same event
// stream (SPEC §4/§5), opened as a plain effect and never as a resource —
// logs are never deleted, so there is nothing for a `Scope` to release. The
// console subscriber in app.ts is untouched; this one tees.
//
// The log is opened *after* the lock is acquired, not before: a dispatch that
// refuses because another run holds the branch must not touch that run's log.
import { FileSystem, Path } from "@effect/platform";
import { DateTime, Duration, Effect, Either, Option } from "effect";
import { promptRootLabel } from "./agent/prompt-source.ts";
import type { PassUsage } from "./agent/stream.ts";
import { shortSha, taskNamed } from "./dispatch/plan.ts";
import { Reporter, type ReporterEvent, type ReporterShape } from "./reporter.ts";

// How long a pass took, at the resolution a reader of a pass wants: whole
// minutes once there is a minute to say, seconds below that (T55). A pass is a
// twenty-minute thing and its budget is set in minutes, so the seconds inside
// one are noise — and a pass that ended in forty is a pass whose seconds are
// the whole story. Exported because the console already renders the same
// figure (`app.ts`) and keeps it through T54's restyle, and because the
// watch's still-running line reads both of its durations through it (T52).
const MINUTE_MS = 60_000;
const SECOND_MS = 1_000;

export const renderElapsed = (elapsed: Duration.Duration): string => {
  const millis = Duration.toMillis(elapsed);
  return millis >= MINUTE_MS
    ? `${Math.floor(millis / MINUTE_MS)}m`
    : `${Math.floor(millis / SECOND_MS)}s`;
};

// What the pass cost, on one line and under the token bash's `claude $ usage`
// line was (`run.sh`): `usage in=` is what a reader greps a log for, so it
// stays the first field and keeps no `agent` prefix — this is the run's own
// line about a pass, not something the agent said.
//
// `cost=` appears only when the CLI reported one, because a zero there is a
// rehearsal's or a plan whose price is not itemized, and four decimals is the
// resolution a pass is priced at. Empty `models` renders `-` rather than
// nothing at all: a field that vanishes is a field a reader has to notice is
// missing.
export const renderPassUsage = (usage: PassUsage): string =>
  `usage in=${usage.input} out=${usage.output} cache_write=${usage.cacheWrite} cache_read=${usage.cacheRead} turns=${usage.turns}${Option.match(
    usage.costUsd,
    { onNone: () => "", onSome: (cost) => ` cost=${cost.toFixed(4)}` },
  )} models=${usage.models.length === 0 ? "-" : usage.models.join(",")}`;

// Which issue a pass was for, after the pass's name and before the prompt it
// was handed (T75) — nothing at all on a run that has none, so a spec run's and
// an inline run's log lines are the ones T9 wrote, byte for byte.
const issueNote = (issue: Option.Option<string>): string =>
  Option.match(issue, { onNone: () => "", onSome: (id) => ` (issue ${id})` });

// And the same fact in front of a line rather than inside a marker (T76,
// `run.sh:1803, 1847`): the three events a feature run repeats per issue — the
// two ends of a pass and each round's verdict — open with which issue they are
// about, so a reader scanning a log finds one issue's stretch by its first
// column. **One spelling, three renderers**: the console's two files render
// the same events (`app.ts`, `agent/render.ts`), and a prefix that differed
// between them would be one issue named two ways on two screens about one run.
// Empty on a spec run and an inline one, which leaves their lines byte for
// byte what they were.
export const issuePrefix = (issue: Option.Option<string>): string =>
  Option.match(issue, { onNone: () => "", onSome: (id) => `issue ${id} ` });

// The land's pushed line, one spelling for both renderers (`app.ts`): the
// counts are what the push carried, and when T77's status commit is one of
// them the line says so, so a count one past what the agent made reads as
// accounted for rather than as a miscount (T90).
export const renderPushed = (
  event: Extract<ReporterEvent, { readonly _tag: "CommitsPushed" }>,
): string =>
  `pushed: ${event.thisRun} new commit(s) this run${
    event.statusCommit ? " (one of them the status commit)" : ""
  }, ${event.sinceBoundary} total since the boundary`;

// And the status commit's own line (T90), for the same two renderers.
export const renderStatusCommitted = (
  event: Extract<ReporterEvent, { readonly _tag: "StatusCommitted" }>,
): string => `status commit: marked ${event.stems.join(" ")} Done on '${event.branch}'`;

// The setup hook's lines (T90), under a `setup` label so a reader never takes
// `npm ci`'s output for the agent's: `|` for stdout as the agent's prose has,
// `!` for stderr. One spelling for both renderers (`app.ts`).
export const renderSetupOutput = (
  event: Extract<ReporterEvent, { readonly _tag: "SetupOutput" }>,
): string => `setup ${event.stream === "stdout" ? "|" : "!"} ${event.line}`;

// `docker build`'s lines under `image build` (T111), under a `build` label for
// the same reason. One spelling for both renderers, though only the console
// ever sees one: the command opens no run log.
export const renderImageBuildOutput = (
  event: Extract<ReporterEvent, { readonly _tag: "ImageBuildOutput" }>,
): string => `build | ${event.line}`;

// The hard reset's line (T101), one spelling for both renderers (`app.ts`):
// every SHA in full, because this line is the audit trail a dispatcher
// recovers the discarded commits from — the reflog holds the local tip, and
// nothing but this line holds origin's.
export const renderBranchReset = (
  event: Extract<ReporterEvent, { readonly _tag: "BranchReset" }>,
): string =>
  `hard reset: '${event.branch}' moved from ${event.from} to ${event.to}${Option.match(
    event.originTip,
    { onNone: () => "", onSome: (tip) => `; origin/${event.branch} was at ${tip}` },
  )} — ${event.discarding} commit(s) discarded`;

// The empty hard reset's push (T105), one spelling for both renderers. The
// full origin tip is already on the `BranchReset` line above it; this one
// says the push that discarded it went out.
export const renderResetPushed = (
  event: Extract<ReporterEvent, { readonly _tag: "ResetPushed" }>,
): string =>
  `reset pushed: origin/${event.branch} moved from ${shortSha(event.originTip)} to the base (nothing new to land)`;

// A detail written somewhere else, folded into the one line this file holds
// every event but the verbatim prompt to (AGENTS.md). Nothing is dropped — a
// reader grepping the log for a path or a command still finds it — the block
// just stops being one.
const folded = (detail: string): string => detail.replace(/\s*\n\s*/g, " ");

// One line per event, with the one deliberate exception spelled out below. The
// console renderer prints screens; this one prints a record, so it stays
// single-line and timestamped — a run is followed with `tail -f` on the path
// the plan block printed, and the pass narrates into it *as it runs* (ticket
// 20): until T51 the log held nothing the agent said until the pass was over.
// A wrapped plan block there would hide the lines around it.
const summarize = (event: ReporterEvent): string => {
  switch (event._tag) {
    case "ProbeChecked":
      return `probe ${event.probe}: ${event.status} — ${event.detail}`;
    // Folded, because a warning may carry a multi-line recovery for the
    // console (`app.ts`) and every event but the verbatim prompt summarizes to
    // one line here (AGENTS.md).
    case "Warned":
      return `WARN  ${folded(event.detail)}`;
    // `status` runs on appBaseLiveFor and opens no run log, so this arm exists
    // for exhaustiveness rather than for a reader.
    case "StatusReported":
      return `status: ${event.snapshot.containers._tag}, ${event.snapshot.ledger._tag}`;
    // `gc` opens no run log either (T99).
    case "GcReported":
      return `gc: ${event.snapshot.slugs.length} slugs, ${event.snapshot.witnesses.length} witnesses`;
    // Nor does `init` (T114).
    case "InitReported":
      return event.snapshot._tag === "Write"
        ? `init: ${event.snapshot.files.map((file) => `${file.action} ${file.path}`).join(", ")}`
        : `init --diff: ${event.snapshot.files.length} files`;
    // Nor does `upgrade` (T128).
    case "UpgradeReported":
      return event.snapshot._tag === "Pinned"
        ? `upgrade: pinned ${event.snapshot.to.tag}`
        : `upgrade: ${event.snapshot.release.tag} unchanged`;
    // Nor does `stop` (T152).
    case "RunStopping":
      return `stop: SIGINT to pid ${event.pid} for '${event.branch}'`;
    case "RunStopped":
      return `stop: '${event.branch}' stopped`;
    case "PlanResolved":
      return `plan: ${taskNamed(event.plan.task)} on '${event.plan.branch}' | base ${event.plan.baseRef} | boundary ${event.plan.mergeBaseSha}`;
    case "ResourceAcquired":
      return `${event.resource}: acquired`;
    case "BranchReset":
      return renderBranchReset(event);
    // The rehearsal's line (T15). A dry run reaches this file — the log is a
    // plain effect over `FileSystem` rather than a service, so the layer swap
    // does not cover it (AGENTS.md) — and what it would have done belongs in
    // the record beside what it really did.
    case "MutationRecorded":
      return `would ${event.detail}`;
    case "ResourceReleased":
      return `${event.resource}: released`;
    // **The one event that is deliberately not one line** (T9): the prompt is
    // logged *verbatim* before the pass, which is what makes "what exactly was
    // this agent told" answerable from the log alone (`run.sh:1144-1149`) and
    // what T17's `--feedback` delivery is verified from. Summarizing it would
    // keep the format and lose the only thing it is for; the markers are what
    // a reader scans past instead.
    //
    // The open marker says which issue the pass was for when it was for one
    // (T75), beside the root the template came from: a feature run's log holds
    // three prompts per issue, and which issue a block belongs to is what a
    // reader scanning for one greps.
    case "PromptAssembled":
      return `-- ${event.pass}${issueNote(event.issue)} prompt (${promptRootLabel(event.root)}) --\n${event.prompt}\n-- end prompt --`;
    // bash's two narration shapes under the port's own `agent` label
    // (ticket 20): prose after `|`, a tool use after `>`. Greppable, one line
    // each, and the prefix is this renderer's — the event carries the shape,
    // not the wording. An empty text line keeps its trailing space, the way a
    // blank line inside a paragraph the agent wrote always has.
    case "AgentOutput":
      return event.kind === "text"
        ? `agent | ${event.text}`
        : `agent > ${event.tool}: ${event.brief}`;
    // The setup step's two ends and what it said between them (T90). The
    // failure is folded like `PassFailed`'s, because its detail carries the
    // hook's stderr verbatim, and it is the line a failed setup's log ends on
    // before the releases.
    case "SetupOutput":
      return renderSetupOutput(event);
    case "ImageBuildOutput":
      return renderImageBuildOutput(event);
    case "SetupFinished":
      return `setup hook finished (${renderElapsed(event.elapsed)})`;
    case "SetupFailed":
      return `setup hook failed (${renderElapsed(event.elapsed)}): ${folded(event.detail)}`;
    // The watch's two lines (T52). The heartbeat is the one place the log is
    // the less useful of the two renderers — every line here is timestamped,
    // so a reader can already see where the wall time went — and it is written
    // all the same: the log is what a dispatcher reads after the fact to find
    // the gap, and a pass with no lines between two timestamps is a pass
    // nobody can tell was alive.
    case "PassStillRunning":
      return `... ${event.pass} pass still running (${renderElapsed(event.elapsed)}, cap ${renderElapsed(event.budget)})`;
    // Bash's two sentences (`run.sh:1495-1497`) folded onto one line, the way
    // a warning's recovery is: the log is a record of single lines, and the
    // second sentence is the one that says what to do about the first.
    case "NoWritesYet":
      return `WARN  no file written after ${renderElapsed(event.elapsed)} of a ${renderElapsed(event.budget)} budget — still reading; usually a sizing problem: the ticket is too large, or it points at sources to consult instead of carrying the decisions and code shapes the agent needs`;
    // The close of the block `PromptAssembled` opened, and the marker a reader
    // scanning a long log lands on to find where one pass stopped and the next
    // began. What it cost rides on the same line (T55) — bash's
    // `claude $ usage`, which the port had dropped — so one `grep 'usage in='`
    // over a log answers what the run spent, pass by pass.
    case "AgentPassFinished":
      return `${issuePrefix(event.issue)}${event.pass} pass finished (${renderElapsed(event.elapsed)}) ${renderPassUsage(event.usage)}`;
    // **The line a killed run's log did not have** (ticket 20): the pass ended
    // and this is how. The reason is the taxonomy's word and the detail is the
    // error's own, so a reader who has the log and a dispatcher who has the
    // stderr line are reading the same sentence. The usage is between the
    // elapsed and the reason when there is one, keeping `usage in=` greppable
    // across both terminal lines.
    //
    // Folded like a warning's, because one of the four details is not already
    // one line: a pass that lost its sandbox or exited nonzero carries the
    // child's stderr verbatim (`sandbox/sandbox.ts`'s `failed`), and the
    // agent CLI dying says so over several lines. The stderr line the exit
    // renders (`dispatch/render.ts`) is the error's own string and is
    // untouched — this fold is the log's, and only the log's.
    case "PassFailed":
      return `${issuePrefix(event.issue)}${event.pass} pass failed (${renderElapsed(event.elapsed)})${Option.match(
        event.usage,
        { onNone: () => "", onSome: (usage) => ` ${renderPassUsage(usage)}` },
      )}: ${event.reason} — ${folded(event.detail)}`;
    // `run.sh:1365` writes this same line per round, and it is what makes the
    // ledger's `outcome` readable back out of the log a human opens.
    case "ReviewVerdictReached":
      return `${issuePrefix(event.issue)}review round ${event.round.index}/${event.round.of}: ${event.verdict}`;
    // The land's two ends, one line each and the same line the console gets:
    // both already summarize, and "did this run's work go home" is the
    // question someone opens the log for after the fact.
    case "CommitsPushed":
      return renderPushed(event);
    case "StatusCommitted":
      return renderStatusCommitted(event);
    case "NothingToLand":
      return "nothing to land — no commits past the diff boundary";
    case "ResetPushed":
      return renderResetPushed(event);
    // Same line as the console's: the URL is the whole of what a reader wants
    // out of the log afterwards, and the number is in the ledger row.
    case "PullRequestReady":
      return event.action === "created"
        ? `draft PR opened: ${event.pr.url}`
        : `PR updated: ${event.pr.url}`;
  }
};

export const renderLogLine = (at: DateTime.Utc, event: ReporterEvent): string =>
  `${DateTime.formatIso(at)} ${summarize(event)}`;

// Opens the file and returns the subscriber to run the rest of the dispatch
// under. A log we cannot open degrades the run to console-only with a warning
// rather than failing it: nothing in SPEC §3's taxonomy makes a missing log an
// outcome, and killing a run over its own logging would be worse than the
// silence it prevents.
export const openRunLog = (
  logPath: string,
  header: string,
): Effect.Effect<ReporterShape, never, Reporter | FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const reporter = yield* Reporter;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const opened = yield* Effect.either(
      Effect.gen(function* () {
        yield* fs.makeDirectory(path.dirname(logPath), { recursive: true });
        const at = yield* DateTime.now;
        yield* fs.writeFileString(logPath, `${DateTime.formatIso(at)} ${header}\n`, { flag: "w" });
      }),
    );
    if (Either.isLeft(opened)) {
      yield* reporter.emit({
        _tag: "Warned",
        detail: `run log unavailable at ${logPath} (${opened.left.message}) — progress goes to the console only`,
      });
      return reporter;
    }

    const append = (event: ReporterEvent): Effect.Effect<void> =>
      DateTime.now.pipe(
        Effect.flatMap((at) =>
          fs.writeFileString(logPath, `${renderLogLine(at, event)}\n`, { flag: "a" }),
        ),
        // A write that fails says so on the console, where the event already
        // went — warning into the file we just failed to write would be the
        // one place the message cannot land.
        Effect.catchAll((error) =>
          reporter.emit({
            _tag: "Warned",
            detail: `run log write failed at ${logPath} (${error.message})`,
          }),
        ),
      );

    return { emit: (event) => reporter.emit(event).pipe(Effect.zipRight(append(event))) };
  });
