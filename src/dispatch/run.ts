// The run's `Scope`, opened after every guard passes (SPEC §4) — T3's
// invariant that nothing is touched before the in-flight check is what decides
// where this begins. The scope holds `RunLock`, then the checkout, then the
// sandbox, in that order and inside one bracket rather than beside each other
// — so release keeps reversing acquisition for free.
//
// Two things hang off the lock, in this order and for this reason:
//   - the run log opens only after the lock is held, because a dispatch that
//     refuses on someone else's live run must not touch that run's log
//     (`run.sh:1210-1221` says the same thing about the same guard)
//   - exactly one terminal ledger row is written iff the lock was acquired
//     (SPEC §11), so the row is a finalizer registered here, right after the
//     lock — it reaches the ledger on success, on failure, and on interrupt
//     alike, and being registered second it runs after the two resources below
//     have released and before the lock does (T31)
import type { FileSystem, Path } from "@effect/platform";
import { Cause, Data, DateTime, Effect, Exit, Option, Ref, Schema, type Scope } from "effect";
import { AgentCli, type AgentPassFailed } from "../agent/agent-cli.ts";
import type { AgentCredential } from "../agent/credential.ts";
import type { PrContext } from "../agent/prompt.ts";
import type { PromptUnusable } from "../agent/prompt-source.ts";
import { outcomeFor, type ReviewVerdict } from "../agent/verdict.ts";
import { BessemerConfig } from "../config/config.ts";
import type { Forge, ForgeError } from "../forge/forge.ts";
import type { Git, GitError } from "../git/git.ts";
import type { RepoSlug } from "../git/repo-slug.ts";
import { RepoUrl } from "../git/repo-url.ts";
import { Ledger } from "../ledger/ledger.ts";
import {
  CURRENT_SCHEMA_VERSION,
  type Dispatcher,
  type IssueOutcome,
  type PullRequest,
  type RunIdentity,
  type RunRecord,
  type RunStage,
  type TerminalReason,
} from "../ledger/record.ts";
import { type LockError, type LockHeld, RunLock } from "../lock/run-lock.ts";
import { notifyTerminal, withStepNotifications } from "../notify/notifications.ts";
import type { Notifier } from "../notify/notifier.ts";
import { Reporter } from "../reporter.ts";
import { openRunLog } from "../run-log.ts";
import { Sandbox, SandboxError, type SandboxHandle } from "../sandbox/sandbox.ts";
import { sandboxSpecFor } from "../sandbox/spec.ts";
import { checkout } from "./checkout.ts";
import {
  boundaryIn,
  IMPLEMENT_FAILED,
  issueOutcomesFor,
  REVIEW_FAILED,
  withIssueOutcomes,
} from "./feature.ts";
import { prContextFor } from "./feedback.ts";
import { logPathOrNote, type DispatchPlan, type Task } from "./plan.ts";
import { reviewRounds } from "./review.ts";
import { runSetupHook } from "./setup-hook.ts";
import { type RunUsage, usageFields, withUsageTally } from "./usage.ts";

// The log's first line, as bash writes it (`run.sh:1222-1223`): which run,
// which branch, which diff boundary — and which mode, which since T76 has a
// second answer. A feature run names its selection here as well: the ids in
// T69's order are the whole of what the run set out to do, they are decided
// before the first pass, and a reader opening the log afterwards reads them
// against the outcomes the row carries.
export const runStartHeader = (plan: DispatchPlan): string =>
  `== bessemer [${plan.slug}] run start: mode=${modeNamed(plan.task)} branch=${plan.branch} boundary=${plan.mergeBaseSha}`;

// A spec run and an inline one are both `one-off` here, as they are on the
// plan block's own mode line (`render.ts`): what this header says is which
// *shape* the run has, and those two have one.
const modeNamed = (task: Task): string =>
  task._tag === "Feature"
    ? `feature issues=${task.selection.issues.map((issue) => issue.id).join(",")}`
    : "one-off";

// A typed failure and the stage the run had reached when it hit it. The stage
// rides *beside* the error rather than inside it: the same `GitError` is the
// clone's here and the land fetch-back's in T11, so which stage a `failed` row
// names is a fact about where the run was, not about which error it was.
// `runInScope` unwraps this again — the caller sees the typed error SPEC §3
// names, and only the ledger row reads the stage.
//
// Both are exported because one step cannot be staged in this file: the land
// is the `work` the scope is handed (T11), so it is staged where it is wired
// and unwrapped by the same `catchIf` every step below is. That is why the
// signature `Exclude`s this type from the work's error channel rather than
// passing it through — a work that stages itself still leaves as the typed
// error SPEC §3 names.
export class FailedAtStage extends Data.TaggedError("FailedAtStage")<{
  readonly stage: RunStage;
  readonly error: GitError | SandboxError | AgentPassFailed | PromptUnusable | ForgeError;
}> {}

export const atStage =
  (stage: RunStage) =>
  (error: GitError | SandboxError | AgentPassFailed | PromptUnusable | ForgeError): FailedAtStage =>
    new FailedAtStage({ stage, error });

// What the run's own work is handed, and both halves are things only the scope
// has (T12). The sandbox, because the last step of the work is an agent pass
// and it runs in *this* container — addressed by the id docker answered with,
// never by the name the plan derived. And the slot the PR reaches the ledger
// row through, for the reason the review verdict has one (AGENTS.md): the row
// is written from a finalizer of the scope, which sees how the run ended and
// not what it opened on the way.
export interface RunWork {
  readonly sandbox: SandboxHandle;
  readonly pr: Ref.Ref<Option.Option<PullRequest>>;
  // What each issue of a feature run came to, in the order the loop decided
  // them (T76), and empty on every other arm. It is here for the same reason
  // the PR slot is — the row is written from a finalizer — and for one more:
  // the land reads which issues approved, because approval is what gets a
  // `Status: Done` commit (T77).
  readonly outcomes: Ref.Ref<ReadonlyArray<IssueOutcome>>;
}

// Why the run stopped, read off the exit. A stage token appears only where the
// scope attached one, from the closed `RunStage` union in record.ts; a defect
// and an unstaged failure are both `Crashed`, which is what "we do not know
// which step this belongs to" honestly says.
const terminalReasonFor = (exit: Exit.Exit<unknown, unknown>): TerminalReason => {
  if (Exit.isSuccess(exit)) {
    return { _tag: "Completed" };
  }
  if (Cause.isInterruptedOnly(exit.cause)) {
    return { _tag: "Interrupted" };
  }
  const failure = Cause.failureOption(exit.cause);
  return Option.isSome(failure) && failure.value instanceof FailedAtStage
    ? { _tag: "Failed", stage: failure.value.stage }
    : { _tag: "Crashed" };
};

// The identity the row records, and the one thing a run adds to it (T76): on
// a feature arm, every selected id with what became of it — the outcomes the
// loop recorded, plus `not-attempted` for every issue after the stop. It is
// computed **here**, in the finalizer, rather than appended as the loop goes,
// so a run killed mid-pass still names what it never reached.
const identityFor = (plan: DispatchPlan, recorded: ReadonlyArray<IssueOutcome>): RunIdentity =>
  plan.task._tag === "Feature"
    ? withIssueOutcomes(plan.identity, issueOutcomesFor(plan.task.selection.issues, recorded))
    : plan.identity;

const terminalRecord = (
  plan: DispatchPlan,
  startedAt: DateTime.Utc,
  endedAt: DateTime.Utc,
  outcome: Option.Option<string>,
  issues: ReadonlyArray<IssueOutcome>,
  pr: Option.Option<PullRequest>,
  rescuedOnto: Option.Option<string>,
  discardedTip: Option.Option<string>,
  dispatcher: Option.Option<Dispatcher>,
  staleDispatcherOverridden: Option.Option<boolean>,
  usage: Option.Option<RunUsage>,
  exit: Exit.Exit<unknown, unknown>,
): RunRecord => ({
  schemaVersion: CURRENT_SCHEMA_VERSION,
  runId: Option.some(plan.runId),
  branch: plan.branch,
  // What the dispatch decided this run is, carried on the plan: a one-off, or
  // a `FeedbackResume` wrapping the identity a `--resume` recovered (T16).
  // Deriving it here instead would be this file guessing at a mode the
  // dispatch already read off a tag. What the *run* decided lands on it above
  // — the per-issue outcomes of a feature arm, and nothing else (T76).
  identity: identityFor(plan, issues),
  startedAt: Option.some(startedAt),
  endedAt,
  terminalReason: Option.some(terminalReasonFor(exit)),
  // The review verdict, and the two questions stay distinct (SPEC §10):
  // `terminalReason` says why the run stopped, this says what the review
  // decided. A run that crashed or failed before the rounds finished has the
  // first and not the second — which is why it arrives as an `Option` a
  // completed loop filled in, rather than being derived from the exit.
  outcome,
  base: { ref: plan.baseRef, sha: Option.some(plan.baseSha) },
  mergeBaseSha: Option.some(plan.mergeBaseSha),
  // Number and URL together, as the forge answered them, or absent (T12):
  // a run that opened no PR — nothing to land, a create the forge refused,
  // a run that never reached the step — records neither field rather than a
  // synthesized one.
  pr,
  // Where the release put the commits when they could not go home (T31), and
  // absent on every other path. It is the release that answers this, which is
  // why the row is written from a finalizer registered after the lock rather
  // than from an `onExit` on the work — see `runInScope` below.
  rescuedOnto,
  // The tip a `--hard-reset` discarded (T104), set by the checkout's acquire
  // only once its compare-and-set succeeded. Read off `plan.reset` instead, it
  // would name a discard on the row of a run whose reset never happened.
  discardedTip,
  // Which dispatcher ran this, and whether its source was dirty (T43) — a
  // host fact read once at the composition root and carried
  // straight through, never re-derived here or from the working directory.
  dispatcher,
  // Whether the preflight's freshness refusal had to be overridden for this
  // run to go (T44) — decided before the scope opened, exactly like
  // `dispatcher` above and unlike `outcome`/`pr`/`rescuedOnto`: nothing
  // inside the run decides it, so it is not a `Ref`.
  staleDispatcherOverridden,
  // What the run cost (T53): the four token counts, the passes they are over,
  // and the models those passes named. Six fields written together or not at
  // all, which is why they are spread from one derivation rather than mapped
  // one by one here — a run whose only pass was killed reported no usage and
  // carries none of them, because unmeasured is not free.
  ...usageFields(usage),
});

// The row, and the one degradation it is allowed (matrix row 20): a failing
// append is a typed `LedgerError` that is warned loudly and never fatal — the
// run already happened, and the log file still holds what it did.
//
// Then the telling (T13), from the same record and in that order: the durable
// answer is owed first, and a notification that fails is swallowed with a
// warning either way (matrix row 21). The two cannot disagree, because the
// notification reads the row rather than re-deriving what it says.
const recordTerminal = (
  plan: DispatchPlan,
  startedAt: DateTime.Utc,
  // The verdict the review loop reached, if it reached one. A `Ref` rather
  // than a return value because the row is written from a finalizer, which
  // sees how the run ended and not what it decided on the way.
  //
  // It stays `None` on a feature run: there is no single verdict there, and
  // the tally is per issue on the slot below (T76).
  outcome: Ref.Ref<Option.Option<string>>,
  // What each issue of a feature run came to, as the loop recorded it (T76) —
  // empty on every other arm, and empty too on a feature run killed before its
  // first issue decided anything. The `not-attempted` tail this is short of is
  // filled where the row is built and not here, so an interrupted run's row
  // still names every id it was dispatched for.
  outcomes: Ref.Ref<ReadonlyArray<IssueOutcome>>,
  // The PR the work opened or updated, by the same reasoning: the row is
  // written from a finalizer, and what a run *did* on the way is set where it
  // happened.
  pr: Ref.Ref<Option.Option<PullRequest>>,
  // Where the checkout's release put the commits, if it had to put them
  // anywhere but home (T31). This one is filled by a finalizer rather than by
  // the work, which is why the row is a finalizer too: registered after the
  // lock, it runs after the release that answers this.
  rescued: Ref.Ref<Option.Option<string>>,
  // The tip the hard reset discarded, if it ran (T104). Filled by the
  // checkout's acquire the moment its `update-ref` succeeds, never before.
  discarded: Ref.Ref<Option.Option<string>>,
  // Which dispatcher is running this (T43): a host fact resolved once before
  // the scope opened, never a `Ref` — unlike `outcome`, `pr`, and `rescued`,
  // nothing inside the run decides it.
  dispatcher: Option.Option<Dispatcher>,
  // Whether the preflight's stale-dispatcher refusal was overridden to let
  // this run start (T44) — the same kind of host fact as `dispatcher` above,
  // resolved before the scope opened and carried straight through.
  staleDispatcherOverridden: Option.Option<boolean>,
  // What this run's passes cost, folded off the event stream by the
  // subscriber `runInScope` installs (T53). A `Ref` for the reason `outcome`
  // is one: the row is written from a finalizer, and the passes happened on
  // the way.
  usage: Ref.Ref<Option.Option<RunUsage>>,
  exit: Exit.Exit<unknown, unknown>,
): Effect.Effect<void, never, Ledger | Reporter | Notifier | BessemerConfig> =>
  Effect.gen(function* () {
    const ledger = yield* Ledger;
    const reporter = yield* Reporter;
    const endedAt = yield* DateTime.now;
    const decided = yield* Ref.get(outcome);
    const perIssue = yield* Ref.get(outcomes);
    const opened = yield* Ref.get(pr);
    const onto = yield* Ref.get(rescued);
    const discardedTip = yield* Ref.get(discarded);
    const spent = yield* Ref.get(usage);
    const record = terminalRecord(
      plan,
      startedAt,
      endedAt,
      decided,
      perIssue,
      opened,
      onto,
      discardedTip,
      dispatcher,
      staleDispatcherOverridden,
      spent,
      exit,
    );
    yield* ledger.append(record).pipe(
      Effect.catchAll((error) =>
        reporter.emit({
          _tag: "Warned",
          detail: `ledger row not written for '${plan.branch}' (${error.detail}) — ${logPathOrNote(plan.logPath)} still holds what this run did`,
        }),
      ),
    );
    yield* notifyTerminal(plan, record);
  });

// The checkout's path through the branded parse (SPEC §9, invariant 2): the
// same door `checkout.ts` sends it through on the way to git, because a
// location crossing into a container is exactly the boundary `RepoUrl` exists
// to guard. The decode is here rather than inside the spec derivation so that
// module stays pure and this failure stays the sandbox's own.
const workspaceUrl = (checkoutPath: string): Effect.Effect<RepoUrl, SandboxError> =>
  Schema.decode(RepoUrl)(checkoutPath).pipe(
    Effect.mapError(
      (error) =>
        new SandboxError({
          detail: `'${checkoutPath}' is not a usable workspace location: ${error.message}`,
          // Nothing has been started yet, so there is no container to have
          // lost (T22).
          sandboxGone: false,
        }),
    ),
  );

// The run's third resource, acquired inside the same `Scope` as the other two
// and after the checkout it mounts — so release reverses acquisition for free
// and the container is gone before the clone it holds is fetched back.
const startSandbox = (
  plan: DispatchPlan,
  repoRoot: string,
  credential: AgentCredential,
): Effect.Effect<SandboxHandle, SandboxError, Scope.Scope | Sandbox | BessemerConfig | Reporter> =>
  Effect.gen(function* () {
    const config = yield* BessemerConfig;
    const sandbox = yield* Sandbox;
    const workspace = yield* workspaceUrl(plan.checkoutPath);
    return yield* sandbox.run(sandboxSpecFor({ plan, repoRoot, workspace, config, credential }));
  });

// What a run's passes *are*, on the two arms there now are — and the only
// difference between them, since everything around this is the same scope,
// the same container, and the same work below.
//
// **One implement pass and one set of review rounds** (T9, T10), for a run
// whose task is a spec or a line of text: the pass runs **once** and no
// `Schedule` wraps it (05 Q16R), a round that fails is the run's error, and
// what the rounds decided is the row's `outcome` — the same value bash passes
// to its ledger append (`run.sh:1494-1527`). Reaching the cap is not a failure
// (matrix row 12): the loop answers with the last round's verdict and the run
// carries on to the land below.
const onePassThenRounds = (
  handle: SandboxHandle,
  plan: DispatchPlan,
  prContext: Option.Option<PrContext>,
  outcome: Ref.Ref<Option.Option<string>>,
): Effect.Effect<void, FailedAtStage, AgentCli | BessemerConfig | Reporter> =>
  Effect.flatMap(AgentCli, (agent) =>
    // No issue on this arm (T75): a spec run and an inline one are one pass
    // for one task, and the loop that walks a selection is below.
    agent.implement(handle, plan, Option.none(), prContext),
  ).pipe(
    Effect.mapError(atStage("implement")),
    Effect.zipRight(
      reviewRounds(handle, plan, Option.none()).pipe(
        Effect.mapError(atStage("review")),
        Effect.flatMap((verdict) => Ref.set(outcome, Option.some(outcomeFor(verdict)))),
      ),
    ),
  );

// **And the same two, per issue, for a feature run** (T76, `run.sh:1740-1935`):
// the selection in T69's order inside the one scope, each issue beginning with
// the boundary the branch stands at and ending in an outcome on the `Ref` the
// row reads.
//
// Three stop conditions, and all three fall through to the work below rather
// than out of the run: a failed implement pass, a failed review pass, and a
// verdict that is not approval. **A failed pass here is an outcome, not the
// run's error** — 05 Q16R settles retry and not sequencing, and bash rules the
// sequencing: the failure stops the sequence, and the run goes on to land what
// the issues before it left. `PassFailed` is still emitted for the pass (T55);
// what is caught here is the typed error after it, once, and only that one —
// a `PromptUnusable` is the client's own file and stops the run at the stage
// the pass belonged to, exactly as on the arm above.
//
// A capped `fixed` stops as well, and that is the one stop that is not
// obvious: the final round's commits went unreviewed, so the next issue would
// be built on work nothing looked at (`run.sh:1868-1893`).
const featureIssues = (
  handle: SandboxHandle,
  plan: DispatchPlan,
  task: Extract<Task, { readonly _tag: "Feature" }>,
  prContext: Option.Option<PrContext>,
  outcomes: Ref.Ref<ReadonlyArray<IssueOutcome>>,
): Effect.Effect<void, FailedAtStage, AgentCli | Sandbox | BessemerConfig | Reporter> =>
  Effect.gen(function* () {
    const agent = yield* AgentCli;
    for (const issue of task.selection.issues) {
      // The SHA the branch stands at as this issue begins (`run.sh:1766`),
      // read in the container and staged with the pass it belongs to: a
      // sandbox that cannot answer is the run's failure at `implement`, which
      // is the step this read is the first half of.
      const boundary = yield* boundaryIn(handle, plan).pipe(Effect.mapError(atStage("implement")));
      const current = Option.some({ issue, boundary });
      const record = (outcome: string): Effect.Effect<void> =>
        Ref.update(outcomes, (recorded) => [...recorded, { issue: issue.id, outcome }]);

      const implemented = yield* agent.implement(handle, plan, current, prContext).pipe(
        Effect.as(true),
        Effect.catchTag("AgentPassFailed", () => Effect.as(record(IMPLEMENT_FAILED), false)),
        Effect.mapError(atStage("implement")),
      );
      if (!implemented) {
        return;
      }

      const verdict = yield* reviewRounds(handle, plan, current).pipe(
        Effect.map(Option.some),
        Effect.catchTag("AgentPassFailed", () =>
          Effect.as(record(REVIEW_FAILED), Option.none<ReviewVerdict>()),
        ),
        Effect.mapError(atStage("review")),
      );
      if (Option.isNone(verdict)) {
        return;
      }
      // The verdict is this issue's outcome whatever it was — `approved`
      // carries on to the next issue, and `needs-work` or a capped fix is
      // recorded and stops (`outcomeFor` is what renames the second).
      yield* record(outcomeFor(verdict.value));
      if (verdict.value !== "approved") {
        return;
      }
    }
  });

// One scope around the run: the lock, then the log, then the checkout, then
// the sandbox, then the setup hook the config declares — a step inside the
// scope rather than a fourth resource — then the run's passes, which are one
// implement pass and one set of review rounds (T9, T10) or T76's loop over a
// selection, then the run's own work, which is T11's land, T12's PR, and every
// later ticket's step after them, rather than a second scope beside this one.
//
// `repoRoot` is the host fact the checkout is cloned from and fetched back
// into, and `credential` is the other one (T23): what the agent CLI inside the
// container authenticates with, resolved by `agent/credential.ts` at the
// composition root and refused by a guard when the host has none. Both arrive
// as parameters for the same reason every other host read does (AGENTS.md):
// resolved once up there, never re-derived from wherever the process happened
// to start. The credential is required rather than optional because a run that
// reached this far has one — the refusal happened before the lock.
//
// The work is a **function of what the run holds** rather than a ready-made
// effect (T12): its last step runs an agent pass in the container this scope
// started, and a handle re-derived from `plan.containerId` would name a
// container by a name rather than by the id every docker call addresses.
// `dispatcherRevision` defaults to `Option.none()` — every caller that does
// not carry an opinion (nearly every test in this suite, none of them about
// T43) writes a row that renders as unknown, exactly as a pre-T43 row does.
// Only `dispatch.ts` supplies a real answer, resolved at the composition root
// and passed down like `credential`. `staleDispatcherOverridden` defaults to
// `false` for the identical reason: every caller that does not carry an
// opinion writes a row with no such key, exactly as an ordinary run's does
// (T44).
export const runInScope = <A, E, R>(
  plan: DispatchPlan,
  repoRoot: string,
  credential: AgentCredential,
  // Which repo the one forge question below asks about (T39), resolved once
  // at the composition root and passed down like `repoRoot` and `credential`
  // themselves.
  forgeRepo: RepoSlug,
  work: (context: RunWork) => Effect.Effect<A, E, R>,
  dispatcherRevision: Option.Option<Dispatcher> = Option.none(),
  staleDispatcherOverridden: boolean = false,
): Effect.Effect<
  A,
  | Exclude<E, FailedAtStage>
  | GitError
  | SandboxError
  | AgentPassFailed
  | PromptUnusable
  | ForgeError
  | LockHeld
  | LockError,
  | R
  | Git
  | Sandbox
  | AgentCli
  // The forge, for the one question a run asks it before the push (T17): what
  // the branch's PR says today, on a resume and best-effort.
  | Forge
  | RunLock
  | Ledger
  | Notifier
  | BessemerConfig
  | Reporter
  | FileSystem.FileSystem
  | Path.Path
> =>
  Effect.gen(function* () {
    const runLock = yield* RunLock;
    const startedAt = yield* DateTime.now;
    const outcome = yield* Ref.make(Option.none<string>());
    // What each issue of a feature run came to (T76), beside the verdict slot
    // rather than inside it: the two answer different questions, and a feature
    // run answers only the second. It is empty on the other two arms and never
    // written there.
    const outcomes = yield* Ref.make<ReadonlyArray<IssueOutcome>>([]);
    const pr = yield* Ref.make(Option.none<PullRequest>());
    // The third slot, and the only one a *finalizer* fills (T31): the
    // checkout's release is what learns whether the commits went home, and it
    // runs after the work has ended and before the row is written.
    const rescued = yield* Ref.make(Option.none<string>());
    // And the tip a `--hard-reset` discarded (T104): set by the checkout's
    // acquire once the reset has happened, so a run whose compare-and-set
    // failed, or that never reached it, leaves it `None`.
    const discarded = yield* Ref.make(Option.none<string>());
    // And the fourth (T53): what the run's passes cost, folded off the event
    // stream rather than re-parsed out of the log bash summed
    // (`run.sh:2188-2210`). It sits here beside `outcome` because the row is
    // written from a finalizer and every pass is behind it by then.
    const usage = yield* Ref.make(Option.none<RunUsage>());
    return yield* Effect.scoped(
      // The row is owed from the moment the lock is claimed, not from the
      // moment the work starts, so the stretch between them cannot be
      // interrupted: a Ctrl-C landing while the log opens would otherwise
      // release a lock that *was* acquired and write no row, which is the one
      // thing SPEC §11 forbids. `restore` hands the work back the
      // interruptibility it was called with, so matrix row 16 still reaches
      // the finalizer below.
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          yield* runLock.acquire(plan.slug);
          // Absent on a rehearsal's plan (T48): with no log path, the run's
          // reporter is the ambient console (and, at `notify = steps`, the
          // notifier) chain below, unchanged — there is nothing here to open.
          const runLog = yield* Option.match(plan.logPath, {
            onNone: () => Reporter,
            onSome: (logPath) => openRunLog(logPath, runStartHeader(plan)),
          });
          // And, at `notify = steps` alone, a third subscriber over the same
          // stream (T13): the console renders, the log records, and this one
          // raises the phase boundaries on the dispatcher's desktop. Below
          // `steps` it hands the log's subscriber straight back, so the run is
          // wired the same way at all three verbosities and no step of the
          // dispatch core knows a notifier exists.
          // And the tally over the same stream (T53), which renders nothing
          // and wakes nobody: it is the same tee the two subscribers above
          // are, so what a pass cost reaches the row the way every other
          // recorded fact does — as an event somebody folded (05).
          const reporter = withUsageTally(usage, yield* withStepNotifications(plan, runLog));
          // **The row is a finalizer of this scope, registered second** (T31),
          // and the ordering is the whole reason. Finalizers run in reverse of
          // registration, so a row registered after the lock's and before the
          // checkout's is written after the checkout has released and before
          // the lock does — which is where it belongs, because the checkout's
          // release is what decides where this run's commits ended up and the
          // row has to say so. An `Effect.onExit` on the work below runs
          // *before* the scope's finalizers, so the row it wrote could only
          // ever record the rescue as absent.
          //
          // SPEC §11's rule is unchanged and better served: the row is owed
          // from the lock, and this registration sits inside the lock's
          // bracket and inside the `uninterruptibleMask`'s protected stretch,
          // so a row exists iff the lock was acquired. The scope is closed
          // with the exit of the effect below, which is the work's own — the
          // stage a `checkout`- or `sandbox`-staged failure names is read off
          // exactly what an `onExit` read.
          //
          // The reporter is provided here rather than left ambient because
          // this finalizer is registered outside the `provideService` below:
          // the row's own warnings — a refused append, a notification that
          // did not send — belong on the run log, which is where a dispatcher
          // who did come back reads them.
          yield* Effect.addFinalizer((exit) =>
            recordTerminal(
              plan,
              startedAt,
              outcome,
              outcomes,
              pr,
              rescued,
              discarded,
              dispatcherRevision,
              staleDispatcherOverridden ? Option.some(true) : Option.none(),
              usage,
              exit,
            ).pipe(Effect.provideService(Reporter, reporter)),
          );
          return yield* restore(
            // Inside the same scope and after the lock, so the derived release
            // runs before the lock is dropped. It is inside the `onExit` below
            // too, because a clone that fails is a run that started: matrix
            // row 5 owes a `failed` row naming this stage, and matrix row 6
            // owes one naming the sandbox's.
            checkout(plan, repoRoot, rescued, discarded).pipe(
              Effect.mapError(atStage("checkout")),
              Effect.zipRight(
                startSandbox(plan, repoRoot, credential).pipe(Effect.mapError(atStage("sandbox"))),
              ),
              // The setup hook, inside the container and before the work: the
              // stage it fails at is its own (matrix row 7), and the three
              // resources it fails on top of release in reverse behind it.
              Effect.flatMap((handle) =>
                runSetupHook(handle, repoRoot).pipe(
                  Effect.mapError(atStage("setup")),
                  // Then the run's passes, on the same handle and staged where
                  // they happen (matrix rows 8-12): one implement pass and one
                  // set of review rounds, or T76's loop over the selection.
                  // Which of the two is the task's answer and the only thing
                  // that differs — everything around this line is the same
                  // scope, the same container, and the same work below.
                  Effect.zipRight(
                    prContextFor(plan, forgeRepo).pipe(
                      // What the pass is handed beyond its prompt (T17): on a
                      // resume, what the branch's PR says today,
                      // best-effort. It is gathered here, inside the run log's
                      // bracket, so the warning a failed view leaves is in the
                      // file a dispatcher reads afterwards — and **once**, for
                      // every issue of a feature run: it is a fact about the
                      // branch, not about an issue.
                      Effect.flatMap((prContext) =>
                        plan.task._tag === "Feature"
                          ? featureIssues(handle, plan, plan.task, prContext, outcomes)
                          : onePassThenRounds(handle, plan, prContext, outcome),
                      ),
                    ),
                  ),
                  // Then the work: T11's land, T12's PR after it, and every
                  // step a later ticket adds. It arrives already staged —
                  // `atStage` above is exported for it — because the stage a
                  // row names is a fact about where the run was, and the only
                  // place that knows where the work was is the work. It is
                  // handed this container, the slot the PR reaches the row
                  // through, and what each issue came to (T76), and it runs
                  // here, inside the same `flatMap`, so "all three resources
                  // are still held" is the shape of the code rather than a
                  // comment on it.
                  //
                  // **Every stop the loop above makes falls through to it**:
                  // an issue that failed or was not approved still leaves
                  // commits from the issues before it, and landing them is
                  // what a stop-and-land run is.
                  Effect.zipRight(work({ sandbox: handle, pr, outcomes })),
                ),
              ),
            ),
          ).pipe(
            // From here on the run log — and at `notify = steps` the notifier
            // above it — subscribes to the same stream the console renders:
            // one event, several renderers, never two paths. The checkout's
            // own events and its release's warning go through it.
            //
            // **The lock's two events stay off the log, both of them, on
            // purpose.** The log lives strictly inside the lock's bracket: it
            // is opened after the lock is held, so `lock: acquired` predates
            // the file, and it stops being the ambient reporter here, so
            // `lock: released` lands after the last line it could have
            // written. Widening this `provideService` does not change that —
            // `RunLock`'s finalizer closes over the reporter it was acquired
            // under — and opening the log earlier is forbidden outright: a
            // dispatch refused by `LockHeld` must not touch the live run's
            // log (AGENTS.md, `run.sh:1210-1221`). So the choice is *both
            // ends or neither*, and neither wins: a lone `lock: released`
            // with no `acquired` above it reads as a bug in the one file
            // someone opens to diagnose one. The console keeps the whole
            // ordered stream, the log's header line already marks the run
            // start, and SPEC §11's ordering invariant is asserted off the
            // test `Reporter`'s `Ref` rather than off this file.
            Effect.provideService(Reporter, reporter),
          );
        }),
      ),
    ).pipe(
      Effect.catchIf(
        (error): error is FailedAtStage => error instanceof FailedAtStage,
        // `Effect.fail` rather than the error value itself: a `Data.TaggedError`
        // is yieldable, but a *union* of two of them is not one effect type.
        (failed) => Effect.fail(failed.error),
      ),
    );
  });
