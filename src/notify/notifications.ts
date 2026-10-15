// What a run tells the dispatcher, and where from (T13). Two places, and the
// split is the whole of the `notify` key's three values:
//
//   - **`end`** — one notification where the terminal ledger row is written,
//     carrying the same outcome and the same PR that row does. It is derived
//     from the record rather than beside it, so "the notification said
//     approved and the ledger says crashed" is unrepresentable.
//   - **`steps`** — the phase boundaries as well, as a **second subscriber to
//     the `Reporter` event stream** (SPEC §5) exactly as the run log is. A
//     `notifier.notify` call inside an op typechecks and is the wrong shape:
//     new user-visible progress goes through a `Reporter` event (AGENTS.md),
//     and this file is a renderer of those events like `app.ts` and
//     `run-log.ts` are.
//   - **`off`** — neither, and the notifier is not invoked at all.
//
// **A failure here is never the run's** (matrix row 21). Every send below is
// caught, warned through `Reporter`, and discarded: a dispatch that landed a
// PR did not fail because nobody was told about it, and the row, the exit
// status, and the event stream are the same either way.
import { Effect, Option } from "effect";
import { SpeepoboxConfig } from "../config/config.ts";
import { stoppedAt } from "../dispatch/feature.ts";
import { logPathOrNote, type DispatchPlan } from "../dispatch/plan.ts";
import { dispatchIdentity, type RunRecord, type TerminalReason } from "../ledger/record.ts";
import { Reporter, type ReporterEvent, type ReporterShape } from "../reporter.ts";
import { issuePrefix, renderElapsed } from "../run-log.ts";
import { type Notification, Notifier, type NotifierShape } from "./notifier.ts";

// bash's title, verbatim (`run.sh:1750`): the tool that dispatched, and the
// branch it dispatched — which is the task's identity, so it is the whole of
// what a notification needs to be attributable at a glance.
export const notificationTitleFor = (branch: string): string => `speepobox: ${branch}`;

// What a *feature* run says instead of a verdict (T76, `run.sh:2168-2172`):
// there is no single verdict on that arm, and what a dispatcher wants first is
// whether the sequence finished or stopped — and on which issue. It is read
// off the row's own outcomes, so the sentence and the row cannot disagree.
const featureHead = (record: RunRecord): Option.Option<string> => {
  const dispatch = dispatchIdentity(record.identity);
  if (dispatch._tag !== "Feature" || dispatch.issues.length === 0) {
    return Option.none();
  }
  return Option.some(
    Option.match(stoppedAt(dispatch.issues), {
      onNone: () => "all selected issues completed",
      onSome: (stop) => `stopped: issue ${stop.issue} — ${stop.outcome}`,
    }),
  );
};

// The run's last sentence, read off the row it is written beside. `outcome`
// answers what the review decided and `terminalReason` why the run stopped
// (SPEC §10), so a completed run leads with its verdict and every other one
// leads with how it ended and where to read about it.
const terminalHead = (reason: TerminalReason, record: RunRecord, plan: DispatchPlan): string => {
  switch (reason._tag) {
    // The verdict, as bash sends it (`run.sh:1743`). A run that completed
    // without one is a feature run, whose answer is per issue (T76), or one
    // that never reached the review rounds — the shape T16's resume has and
    // this one does not.
    case "Completed":
      return Option.getOrElse(record.outcome, () =>
        Option.getOrElse(featureHead(record), () => "completed"),
      );
    case "Failed":
      return `failed: ${reason.stage} — see ${logPathOrNote(plan.logPath)}`;
    case "Crashed":
      return `crashed — see ${logPathOrNote(plan.logPath)}`;
    case "Interrupted":
      return "interrupted";
  }
};

// Where the work is now readable, on every path that has an answer. The
// no-PR half is only said of a *completed* run, and it is true rather than
// assumed: the PR step is skipped exactly when the land found nothing past
// the diff boundary (`dispatch.ts`), and a step that ran and failed leaves the
// run `Failed` at stage `pr` rather than `Completed`. On a failed or crashed
// run "no PR" would instead mean "it never got that far", which the head above
// already says better.
//
// The rescue is on the same footing as the PR URL (T31), and for the same
// reason: it is where the work is now readable. It is the one answer a
// dispatcher cannot guess — `failed: land — see <log>` is true and tells them
// only the thing they already feared — so it is said whether or not a PR
// exists rather than being an arm of the same choice. A run whose commits are
// still in a kept checkout carries no rescue and says nothing here: a
// directory is not something to merge from, and the loud warning in the log is
// what that case has always had.
const terminalTail = (reason: TerminalReason, record: RunRecord): string => {
  const rescue = Option.match(record.rescuedOnto, {
    onNone: () => "",
    onSome: (onto) => ` — commits on '${onto}'`,
  });
  if (Option.isSome(record.pr)) {
    return ` — PR: ${record.pr.value.url}${rescue}`;
  }
  if (rescue !== "") {
    return rescue;
  }
  return reason._tag === "Completed" ? " — no commits to land" : "";
};

export const terminalNotificationFor = (plan: DispatchPlan, record: RunRecord): Notification => {
  // A row with no terminal reason cannot come from a run — `run.ts` always
  // writes one — so this is a hand-assembled row, and "crashed" is the
  // honest reading of a run that never said why it stopped.
  const reason = Option.getOrElse(record.terminalReason, (): TerminalReason => ({
    _tag: "Crashed",
  }));
  return {
    title: notificationTitleFor(plan.branch),
    body: `${terminalHead(reason, record, plan)}${terminalTail(reason, record)}`,
  };
};

// Which events are a *step*, and the rule is what makes the list short: **a
// step notification means a phase ended and there is still waiting to do; the
// terminal notification means it is over.** Everything that happens after the
// last pass — the push, the PR, the empty-branch case — is the end of the run
// said early, and the terminal notification says all of it in one sentence
// carrying the verdict *and* the PR URL. Sending them here too is the same
// news twice, seconds apart, which is what a dispatcher who walked away reads
// as two runs finishing.
//
// **The list is not bash's, in both directions.** `notify_step` also fires at
// setup complete and at the landing (`run.sh:1377`, `:1750`); neither survives
// the rule. Setup complete lands while the dispatch command is still on
// screen, so it tells a dispatcher who has not left yet something they are
// watching happen — and one that arrives *after* they left is one they read as
// the end. The landing pair is the duplication above. Going the other way, the
// implement pass finishing is a boundary bash has no notification for at all,
// and it is the longest wait in the run.
//
// The rest are left out for the reasons they always were: the narration events
// (`AgentOutput`, `PromptAssembled`) would put a desktop notification on every
// line an agent prints; the pre-lock and read-only events (`PlanResolved`,
// `ProbeChecked`, `StatusReported`) never reach this subscriber, which is
// installed inside the run's scope; `Warned` is where this file's own failures
// land, so notifying about it would be a notification about a notification
// that failed; and `ResourceReleased` is teardown, after the terminal
// notification has already said how it went.
export const stepNotificationBodyFor = (event: ReporterEvent): Option.Option<string> => {
  switch (event._tag) {
    // The longest single wait in a run ending — and bash has no equivalent,
    // which is the one place this list is *wider* than `notify_step`. The
    // review pass is left out because the round's own verdict lands a moment
    // later and says the same boundary with the answer attached; the implement
    // pass has no such follow-up, so without this the run goes quiet from the
    // container coming up until the first round decides.
    //
    // It names the issue when the pass was for one (T76): a feature run
    // reaches this boundary once per issue, and the same two notifications
    // arriving three times with no id in them read as one run stuttering. No
    // *new* event notifies — these are the two boundaries AGENTS.md already
    // admits, said once per issue.
    case "AgentPassFinished":
      return event.pass === "implement"
        ? Option.some(
            `${issuePrefix(event.issue)}implement pass finished — the review rounds start now`,
          )
        : Option.none();
    // **The one event that notifies mid-pass** (T52), and the only addition to
    // this list that is not a boundary at all. It passes the rule the other
    // way round: a pass that has read for a third of its budget without
    // writing has the *most* waiting still to do, and the advisory is about
    // the ticket that was dispatched — which is a thing a dispatcher who
    // walked away can act on now, and cannot act on once the run has ended.
    // bash sends the same one (`run.sh:1498`), with the same text.
    case "NoWritesYet":
      return Option.some(`still reading at ${renderElapsed(event.elapsed)} — check ticket size`);
    // `run.sh:1654`, which is the one step notification bash sends per round —
    // and `run.sh:1847`, which is the same line with the issue on it.
    case "ReviewVerdictReached":
      return Option.some(
        `${issuePrefix(event.issue)}review round ${event.round.index}/${event.round.of}: ${event.verdict}`,
      );
    // **A failed pass is the end of the run, not a step** (T55): the terminal
    // notification is already on its way and says the run failed, so a send
    // here would be the same news twice — and the rule is that a step means
    // there is still waiting to do.
    case "PassFailed":
    // The heartbeat is the opposite of news: it says nothing has happened yet,
    // and a desktop notification every two minutes for the length of a pass is
    // not a verbosity anyone asked for (T52).
    case "PassStillRunning":
    case "ResourceAcquired":
    // The hard reset (T101) happens while the dispatch is still on screen,
    // and a new event is not a step notification by default (AGENTS.md).
    case "BranchReset":
    case "CommitsPushed":
    case "StatusCommitted":
    case "NothingToLand":
    // The empty hard reset's push (T105) is the end of the run said seconds
    // before the terminal notification says it.
    case "ResetPushed":
    case "PullRequestReady":
    case "ProbeChecked":
    case "Warned":
    case "StatusReported":
    // gc is not a run (T99): nobody is waiting on it.
    case "GcReported":
    // Nor is init (T114).
    case "InitReported":
    // Nor is upgrade (T128).
    case "UpgradeReported":
    // Nor is reading a log (T151).
    case "LogOpened":
    case "LogLine":
    // Nor is stop (T152): the run it interrupts sends its own terminal one.
    case "RunStopping":
    case "RunStopped":
    // Nor is `--detach`'s parent (T153): the run it starts notifies for itself.
    case "DetachedOutput":
    case "DetachedStarted":
    case "DetachedStopped":
    case "PlanResolved":
    case "ResourceReleased":
    case "PromptAssembled":
    case "AgentOutput":
    // The setup step (T90): its lines and its finish are progress a dispatcher
    // who has not walked away is watching happen, and its failure ends the
    // run, which the terminal notification already says.
    case "SetupOutput":
    case "SetupFinished":
    case "SetupFailed":
    // `image build` is not a run (T111): nobody is waiting on its lines.
    case "ImageBuildOutput":
    // A recorded mutation is a run that is not running (T15): there is no
    // waiting on either side of it, and a new event is not a step
    // notification by default (AGENTS.md).
    case "MutationRecorded":
      return Option.none();
  }
};

// The send, and the whole of its failure handling: one warning through the
// reporter the run is already writing to, and nothing in anybody's error
// channel (matrix row 21). The warning goes to the *given* subscriber rather
// than to the `Notifier` again, which is what keeps a failing notifier from
// notifying about itself.
const send = (
  notifier: NotifierShape,
  reporter: ReporterShape,
  notification: Notification,
): Effect.Effect<void> =>
  notifier.notify(notification).pipe(
    Effect.catchAll((error) =>
      reporter.emit({
        _tag: "Warned",
        detail: `notification not sent (${error.detail}) — the run is unaffected`,
      }),
    ),
  );

// The `end` notification, called where the terminal row is written and after
// it: the durable record is owed first, and the telling is what a dispatcher
// who walked away gets instead of watching the terminal.
export const notifyTerminal = (
  plan: DispatchPlan,
  record: RunRecord,
): Effect.Effect<void, never, Notifier | SpeepoboxConfig | Reporter> =>
  Effect.gen(function* () {
    const config = yield* SpeepoboxConfig;
    // `off` is "the notifier is never invoked", not "the notifier does
    // nothing": the gate is here, at the call site, so a `Notifier` that
    // counts its calls sees zero.
    if (config.notify === "off") {
      return;
    }
    const notifier = yield* Notifier;
    const reporter = yield* Reporter;
    yield* send(notifier, reporter, terminalNotificationFor(plan, record));
  });

// The `steps` subscriber, and it is the run log's shape (`run-log.ts`): it
// takes the subscriber underneath it, returns one that tees, and every event
// still reaches the console and the log first. Below `steps` it hands the
// given subscriber straight back, so the wiring at the call site is the same
// expression at all three verbosities.
export const withStepNotifications = (
  plan: DispatchPlan,
  next: ReporterShape,
): Effect.Effect<ReporterShape, never, Notifier | SpeepoboxConfig> =>
  Effect.gen(function* () {
    const config = yield* SpeepoboxConfig;
    if (config.notify !== "steps") {
      return next;
    }
    const notifier = yield* Notifier;
    const title = notificationTitleFor(plan.branch);
    return {
      emit: (event) =>
        next.emit(event).pipe(
          Effect.zipRight(
            Option.match(stepNotificationBodyFor(event), {
              onNone: () => Effect.void,
              onSome: (body) => send(notifier, next, { title, body }),
            }),
          ),
        ),
    };
  });
