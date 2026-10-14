// `dispatch`: every guard, the `--base` default chain, preflight, and the
// derivation that produces the resolved plan — then the run's `Scope`, which
// opens only once all of that has passed. Nothing is acquired before it: a
// refusal leaves no lock, no log, and no ledger row behind (SPEC §11, matrix
// rows 1-2). The scope holds `RunLock` today; the checkout and the sandbox
// join it in T18 and T6.
//
// It is the first consumer of `appLiveFor` rather than `appBaseLiveFor`: a malformed
// config kills a dispatch at startup and only degrades the read-only commands.
import type { FileSystem, Path, Terminal } from "@effect/platform";
import type { CommandExecutor } from "@effect/platform/CommandExecutor";
import { DateTime, Effect, Option } from "effect";
import type { AgentCli, AgentPassFailed } from "../agent/agent-cli.ts";
import type { AgentCredential } from "../agent/credential.ts";
import type { PromptUnusable } from "../agent/prompt-source.ts";
import { SpeepoboxConfig } from "../config/config.ts";
import { resolveTasksDir } from "../config/paths.ts";
import type { DockerUnavailable, GhUnavailable, ImageUnavailable } from "../doctor/probes.ts";
import type { Forge, ForgeError } from "../forge/forge.ts";
import type { Git, GitError } from "../git/git.ts";
import type { RepoSlug } from "../git/repo-slug.ts";
import type { IssueStore } from "../issues/issue-store.ts";
import type { SelectionRequest } from "../issues/selection.ts";
import { Ledger } from "../ledger/ledger.ts";
import type { Dispatcher, RunIdentity } from "../ledger/record.ts";
import type { LockError, LockHeld, RunLock } from "../lock/run-lock.ts";
import type { Notifier } from "../notify/notifier.ts";
import type { Prompt } from "../prompt/prompt.ts";
import { reconcile } from "../reconcile/reconcile.ts";
import { Reporter } from "../reporter.ts";
import type { Sandbox, SandboxError } from "../sandbox/sandbox.ts";
import {
  baseNotBranch,
  branchExists,
  branchGiven,
  branchContainsItsRemote,
  branchNotCheckedOut,
  branchNotProtected,
  credentialFound,
  type FeatureRequested,
  featureStatedOnce,
  feedbackEdited,
  feedbackEditOnATty,
  forgeRepoFound,
  GuardRefused,
  hardResetConfirmed,
  hardResetDecided,
  hardResetStatedAlone,
  issueSetAt,
  issuesSelected,
  notInProgressElsewhere,
  notLandedElsewhere,
  originFetched,
  resolveBaseSha,
  resolveBranchTip,
  resolveMergeBase,
  sandboxEnvFileFound,
  setupHookFound,
  specGiven,
  specLocated,
  specResolved,
  taskStatedOnce,
} from "./guards.ts";
import { land } from "./land.ts";
import {
  type DispatchPlan,
  featureDispatch,
  featureFolderFor,
  inlineDispatch,
  planFor,
  resumedFeatureDispatch,
  specDispatch,
  type Task,
} from "./plan.ts";
import { openPullRequest } from "./pr.ts";
import { preflight, type StaleDispatcher } from "./preflight.ts";
import {
  type ResumedRun,
  type ResumedTask,
  resumeDispatchAction,
  resumeResolved,
  resumedTask,
  resumeTargetFor,
} from "./resume.ts";
import { atStage, runInScope } from "./run.ts";

// The surface `@effect/cli` parses into (SPEC §7). `<spec>` and `--branch` are
// both required of an ordinary dispatch, but their absence is a guard rather
// than a parser error, so every refusal in this command has one shape — and a
// resume supplies both off the ledger, which is why neither can be the
// parser's business.
export interface DispatchRequest {
  readonly spec: Option.Option<string>;
  readonly branch: Option.Option<string>;
  readonly base: Option.Option<string>;
  // `--resume <branch>` and its sugar `--last` (T16).
  readonly resume: Option.Option<string>;
  readonly last: boolean;
  // `--feedback "…"` (T17): extra dispatcher instructions for this run, and on
  // a resume whose spec is gone, what stands in as the task. It never reaches
  // a command line — it travels on the stdin prompt pipe T9 built (SPEC §7).
  readonly feedback: Option.Option<string>;
  // `--feedback-edit` (T84): the same text, written in the dispatcher's editor
  // instead of on the command line. It is the flag and not the text — what
  // they wrote is read below, where `--feedback`'s own value is read, and
  // everything past that line sees one `feedback` whichever way it arrived.
  readonly feedbackEdit: boolean;
  // `--task "…"` (T67): the task stated inline rather than as a spec file, and
  // the whole of what this run's passes are for. It reaches a command line no
  // more than `--feedback` does — the stdin prompt pipe carries it — and the
  // four spellings it is refused in are `taskStatedOnce`'s (`guards.ts`).
  readonly task: Option.Option<string>;
  // `--feature <folder>` and `--issues a,b|all` (T73): the folder whose
  // `issues/` this run works through, and the set of them it names. Both
  // optional at the parser and refused by `featureStatedOnce` (T3's rule), and
  // neither is a dispatch without the other — `--feature` alone would have the
  // dispatcher compute a work set the command did not name (15).
  readonly feature: Option.Option<string>;
  readonly issues: Option.Option<string>;
  // `--allow-stale-dispatcher` (T44): proceed anyway when the preflight's
  // freshness check would otherwise refuse, with a warning and a row that
  // records the override. `false` is the ordinary dispatch's answer, on
  // every arm — a resume included, since the flag is a fact about *this*
  // invocation and not something the ledger recovers.
  readonly allowStaleDispatcher: boolean;
  // `--hard-reset` (T101): discard the branch's commits since the base, run
  // from the base, and push under a pinned lease. `false` is every other
  // dispatch, and off a terminal the flag is its own consent (D3).
  readonly hardReset: boolean;
  // Whether this run's plan carries a log path at all (T48). `--dry-run`
  // decided this at the parser, one of the four sites `check-bans.ts` permits
  // to name the flag, and hands down a fact about the run rather than the
  // flag itself — `planFor` is the only reader, so nothing below this line
  // learns a rehearsal is in progress. `true` is the ordinary dispatch's
  // answer, on every arm.
  readonly keepsLog: boolean;
  // `--no-input` (T86): a command line missing an answer is refused as it is
  // off a terminal, and the picker never opens. Nothing in the dispatch reads
  // it. It rides here so the `AnswerMissing` that carries this request tells
  // the entrypoint whether to ask. Absent is `false`.
  readonly noInput?: boolean;
}

// What the dispatcher actually said, if they said anything. Trimmed and
// emptiness-filtered once, at the door, the way `--branch` and `--resume` are:
// a flag holding nothing but a newline is a dispatch that said nothing, and it
// must not turn a resume whose spec is gone into a run with an empty task.
const stated = (text: Option.Option<string>): Option.Option<string> =>
  Option.filter(
    Option.map(text, (value) => value.trim()),
    (value) => value !== "",
  );

// `--feedback ''` is a dispatch that said nothing.
export const feedbackGiven = (feedback: Option.Option<string>): Option.Option<string> =>
  stated(feedback);

// And `--task` gets the identical filter at the identical door (T67), so "was
// a task stated" has one answer everywhere below this line — and so that
// `--task "$(cat note.md)"`, which a shell hands over with the file's trailing
// newline on it, is the same task as the one typed by hand. The *refusal* for
// an empty one belongs to `taskStatedOnce`, which reads the flag as typed:
// after this filter, `--task ""` and no `--task` are one value.
export const taskGiven = (task: Option.Option<string>): Option.Option<string> => stated(task);

// The literal that spells the wide form (SPEC §7), matched case-insensitively
// — `ALL`, `All`, and `all` are one dispatcher typing one word.
export const ALL_ISSUES = "all";

// What `--issues` named, trimmed and emptiness-filtered **once, here** (T69
// §1), as `--task` and `--feedback` are: `--issues 'T70, ,'` is `["T70"]`, so
// the selection never sees a blank id and no rule below has to ask about one.
//
// `None` is a flag that named nothing at all — empty, whitespace, or nothing
// but separators. That is a *refusal* rather than a selection of nothing, and
// `featureStatedOnce` is where it becomes one: it reads the flag as typed
// beside this value, exactly as `taskStatedOnce` reads `--task`.
export const issuesRequested = (issues: Option.Option<string>): Option.Option<SelectionRequest> =>
  Option.flatMap(stated(issues), (value) => {
    if (value.toLowerCase() === ALL_ISSUES) {
      return Option.some<SelectionRequest>({ _tag: "All" });
    }
    const ids = value
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id !== "");
    return ids.length === 0
      ? Option.none<SelectionRequest>()
      : Option.some<SelectionRequest>({ _tag: "Enumerated", ids });
  });

// The `--base` default chain (SPEC §7): this branch's last recorded base in
// the ledger, then the configured default (`origin/master`). T2 landed
// `lastBaseForBranch` without a consumer; this is it, and it hands back the
// *ref* — a SHA would pin this run to whatever the last one resolved.
//
// Ledger content is derived state (SPEC §10): a ledger that cannot be read
// degrades the chain to the fallback and never fails the run.
const defaultBase = (
  branch: string,
): Effect.Effect<string, never, Ledger | SpeepoboxConfig | Reporter> =>
  Effect.gen(function* () {
    const config = yield* SpeepoboxConfig;
    const ledger = yield* Ledger;
    const reporter = yield* Reporter;
    const recorded = yield* ledger.lastBaseForBranch(branch).pipe(
      Effect.catchAll((error) =>
        reporter
          .emit({
            _tag: "Warned",
            detail: `--base omitted and the ledger could not be read (${error.detail}) — defaulting to ${config.base}`,
          })
          .pipe(Effect.as(Option.none<string>())),
      ),
    );
    return Option.getOrElse(recorded, () => config.base);
  });

// What a resumed run dispatches, decided by the table and by nothing else
// (`tasklib.py:579-602`). The recorded spec is put through the same resolution
// a typed one gets — a bare name and the path this package resolved both land
// on the same file — and whether it is *there*, plus what `--feedback` said, are the
// table's only two inputs (T17).
//
// Nothing here re-derives a mode or a spec from the filesystem: the identity
// carried forward is the one `Ledger.resolveResume` read off the row's tag, and
// the question asked of disk is only "does this recorded spec still resolve".
//
// A feature row is the one arm that cannot finish here, for a fresh feature
// dispatch's reason (T78): the replayed set is re-read at the branch tip, which
// is below the fetch. So it leaves as `Pending`, with the folder the row
// recorded — already repo-relative, so nothing re-resolves it — and the ids the
// record left — or the subset of them `--issues` narrowed it to (T88) — as an
// `Enumerated` request. The folder is never rescanned.
//
// An exhausted feature row with `--feedback` is not pending at all (T89): its
// task is the feedback, on the inline arm with nothing appended under it, and
// its identity still wraps the recorded `Feature`. It is the one plan whose
// identity carries outcomes (T92): not its own — this run works no issue of the
// set — but the resumed row's, unchanged and all `approved`, so the branch's
// newest row still says which issues it holds. The inline arm never reaches the
// feature loop, so nothing overlays them.
const resumedDispatch = (
  resumed: ResumedRun,
  repoRoot: string,
  tasksDir: string,
  feedback: Option.Option<string>,
  issues: Option.Option<string>,
): Effect.Effect<Dispatched, GuardRefused, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const recorded = yield* resumedTask(
      resumed.branch,
      resumed.identity,
      Option.map(issues, () => issuesRequested(issues)),
      feedback,
    );
    if (recorded._tag === "FeedbackStandsIn") {
      return resolvedAs({
        task: { _tag: "Inline", text: recorded.text, feedback: Option.none() },
        identity: {
          _tag: "FeedbackResume",
          resumed: { _tag: "Feature", feature: recorded.folder, issues: recorded.issues },
          resumedRunId: resumed.resumedRunId,
        },
      });
    }
    if (recorded._tag === "Feature") {
      return {
        _tag: "Pending",
        folder: recorded.folder,
        request: { _tag: "Enumerated", ids: recorded.ids },
        resumed: Option.some(resumed),
      } as const;
    }
    const task = yield* resumedSingleTask(recorded, repoRoot, tasksDir, feedback);
    return resolvedAs({
      task,
      identity: {
        _tag: "FeedbackResume",
        resumed: resumed.identity,
        resumedRunId: resumed.resumedRunId,
      },
    });
  });

// The two arms whose task is decided above the fetch: a recorded text, and a
// recorded spec put through T16's table.
const resumedSingleTask = (
  recorded: Extract<ResumedTask, { readonly _tag: "Spec" | "Inline" }>,
  repoRoot: string,
  tasksDir: string,
  feedback: Option.Option<string>,
): Effect.Effect<Task, GuardRefused, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    // The task this branch was dispatched with, replayed off the row (T67,
    // chart row 8). The decision table has nothing to ask of it: text cannot be
    // *gone from disk*, so the table's gone arm never fires on this arm and
    // 15's feedback-only derivation is unreachable from it. `--feedback` on the
    // resume is appended under the task, exactly as on a spec resume (row 9).
    if (recorded._tag === "Inline") {
      return { _tag: "Inline", text: recorded.text, feedback };
    }
    const action = resumeDispatchAction({
      spec: recorded.spec,
      resolved: yield* specLocated(repoRoot, tasksDir, recorded.spec),
      feedback,
    });
    switch (action._tag) {
      case "Normal":
        return { _tag: "Spec", path: action.spec, feedback };
      case "Refuse":
        return yield* new GuardRefused({ detail: action.detail });
      // The run T17 built and T66 re-homed (run.sh's `FEEDBACK_ONLY`
      // resolution): the recorded spec is gone and the dispatcher said what to
      // do anyway, so what they said **is** this run's task and it travels as
      // text. The recorded spec does not ride along — it names a file nothing
      // on this run reads, mounts, or is told about, and the identity the row
      // carries forward still says what the branch was dispatched for.
      case "FeedbackStandsIn":
        return { _tag: "Inline", text: action.text, feedback: Option.none() };
    }
  });

// What the dispatch knows about its task once the command line and the ledger
// have been read, and what it does not know yet (T73). Two arms, because a
// feature run's task is its *selection* and a selection is read at the branch
// tip — SPEC §7's step 4, below the fetch — while every other arm is decided
// from what was typed and what the ledger recorded, above it.
//
// `Pending.resumed` is the run a resume recovered, on the one resume arm that
// is pending (T78) — the selection it completes into is a replay, and its
// identity wraps the recorded `Feature` rather than starting a fresh one.
type Dispatched =
  | { readonly _tag: "Resolved"; readonly task: Task; readonly identity: RunIdentity }
  | {
      readonly _tag: "Pending";
      readonly folder: string;
      readonly request: SelectionRequest;
      readonly resumed: Option.Option<ResumedRun>;
    };

// What the command line named as the run's source, before anything but the
// ledger has been read (T86): a recovered run, a feature's folder and set, an
// inline task, or a spec as typed.
type Source =
  | { readonly _tag: "Resume"; readonly run: ResumedRun }
  | { readonly _tag: "Feature"; readonly asked: FeatureRequested }
  | { readonly _tag: "Inline"; readonly text: string }
  | { readonly _tag: "Spec"; readonly spec: string };

const resolvedAs = (pair: { readonly task: Task; readonly identity: RunIdentity }): Dispatched => ({
  _tag: "Resolved",
  ...pair,
});

// `repoRoot` is a host fact resolved at the composition root and passed in
// (AGENTS.md): it anchors every relative read location — the tasks dir and a
// slash-form spec path alike — the way bash's `cd "$REPO_ROOT"` does.
//
// `dispatcherRevision` is the same kind of fact (T43): which revision of the
// dispatcher's own source ran, and whether that source was dirty, read once
// at the composition root from the repo enclosing the package —
// never from `repoRoot`, which under P6's shim names the served repo instead.
//
// `forgeRepo` is the same kind of fact again (T39): which repo every `gh`
// call this run makes will name, resolved once at the composition root from
// `repoRoot`'s `origin` remote — `None` when that could not be read or does
// not name an owner/repo, which `forgeRepoFound` below turns into a refusal
// before anything is held.
//
// `selfHosted` is that same coincidence named (T60): whether `repoRoot` is the
// repo the package itself lives in. It is decided at the composition root and
// passed through to the preflight, which is the only thing below here that
// reads it — `doctor` is handed the identical value, so the freshness question
// cannot be asked one way on the screen and another way on a dispatch.
export const dispatch = (
  request: DispatchRequest,
  repoRoot: string,
  selfHosted: boolean,
  credential: Option.Option<AgentCredential>,
  dispatcherRevision: Option.Option<Dispatcher>,
  forgeRepo: Option.Option<RepoSlug>,
): Effect.Effect<
  DispatchPlan,
  | GuardRefused
  | DockerUnavailable
  | ImageUnavailable
  | GhUnavailable
  | StaleDispatcher
  | LockHeld
  | LockError
  | GitError
  | SandboxError
  | AgentPassFailed
  | PromptUnusable
  | ForgeError,
  | SpeepoboxConfig
  | Ledger
  | RunLock
  | Git
  // The issue set the content guards read at the branch tip (T73). It is
  // consumed here rather than introduced: T71 built the tag and put it in both
  // compositions, and this is its first caller.
  | IssueStore
  | Sandbox
  | AgentCli
  | Forge
  | Notifier
  | Reporter
  | CommandExecutor
  | FileSystem.FileSystem
  | Path.Path
  // The one question a dispatch puts to the terminal (T84): is anyone there.
  // `--feedback-edit` asks it to refuse rather than to behave differently, and
  // `--hard-reset` asks it to decide whether to confirm (T102) — both in the
  // guard phase, so nothing past the lock branches on a terminal, which is
  // what keeps a piped dispatch and a dispatch on a desk the same run.
  | Terminal.Terminal
  // And the one question a dispatch puts to the dispatcher (T102): a hard
  // reset with commits to discard asks before it discards them, on a terminal
  // and only there.
  | Prompt
> =>
  Effect.gen(function* () {
    const config = yield* SpeepoboxConfig;
    const reporter = yield* Reporter;

    const tasksDir = resolveTasksDir(repoRoot, config.tasksDir);

    // The dispatcher's own words, filtered once before anything reads them:
    // the decision table, the task, and every prompt below take this one value,
    // so "was there feedback" has a single answer (T17). On `--feedback-edit`
    // it is the editor's, read a few lines down — the flag is refused beside
    // the text, so exactly one of the two arms ever carries anything.
    const typedFeedback = feedbackGiven(request.feedback);
    // And the task, if the dispatcher stated one inline, through the same
    // filter at the same door (T67).
    const inlineTask = taskGiven(request.task);

    // The four spellings `--task` is refused in (22 §6 rows 10-13), ahead of
    // every guard below and ahead of the resume itself: they are decided from
    // the command line alone, and a ledger read taken first would answer a
    // collision with a refusal about the ledger (`guards.ts`).
    yield* taskStatedOnce(request);
    // And `--hard-reset`'s collision, in the same slot (T101): beside a
    // resume, which continues what it would discard (D5). Ahead of
    // `featureStatedOnce`, as it always stood.
    yield* hardResetStatedAlone(request);
    // And the four `--feature`/`--issues` spellings beside them, in the same
    // slot and decided the same way — from the command line alone (T73). What
    // comes back is the pair when there was one: the folder as typed, and the
    // request T69 selects with.
    const featureRequested = yield* featureStatedOnce(request, issuesRequested(request.issues));
    // And the one thing `--feedback-edit` asks of the world rather than of
    // argv, in the same slot and for the same reason (T84): whether anyone is
    // there to drive an editor. It is a fact about this invocation, so a
    // resume resolved first would answer a piped dispatch with a refusal about
    // the ledger — and it runs ahead of every git call, the editor lookup
    // included.
    yield* feedbackEditOnATty(request.feedbackEdit);

    // The resume, before every other guard, because it is what *supplies* the
    // three things they are asked about: `--resume`/`--last` recover the
    // branch, the spec, and the base off the newest record for the branch
    // rather than taking them from the flags (SPEC §7). Everything below runs
    // identically either way — a resume is the same dispatch with its inputs
    // read from the ledger.
    const target = yield* resumeTargetFor(request);
    const resumed = yield* Option.match(target, {
      onNone: () => Effect.succeedNone,
      onSome: (value) => Effect.asSome(resumeResolved(value)),
    });

    // Guards first, in bash's order (run.sh:859-982), so a dispatcher who
    // fixes one refusal meets the next one in the same sequence they would
    // have on the tool this replaces.
    const branch = yield* Option.match(resumed, {
      onNone: () => branchGiven(request),
      onSome: (run) => Effect.succeed(run.branch),
    });
    // Which of the four sources this dispatch names, decided here beside the
    // branch because it reads argv alone (T86). Both are an `AnswerMissing`
    // when absent, and the editor below is not opened until neither is.
    const source = yield* Option.match(resumed, {
      onSome: (run) => Effect.succeed<Source>({ _tag: "Resume", run }),
      onNone: () =>
        Option.match(featureRequested, {
          onSome: (asked) => Effect.succeed<Source>({ _tag: "Feature", asked }),
          onNone: () =>
            Option.match(inlineTask, {
              onSome: (text) => Effect.succeed<Source>({ _tag: "Inline", text }),
              onNone: () =>
                Effect.map(specGiven(request), (spec): Source => ({ _tag: "Spec", spec })),
            }),
        }),
    });
    // And the dispatcher's own words, on whichever arm they arrived by (T84):
    // typed on the command line, or written in the editor this opens now. It
    // is here rather than further up because the header says which branch the
    // text is for, and a resume learns that from the ledger — and it is here
    // rather than further down because everything below reads `feedback`, and
    // because a dispatcher who quits the editor must have held nothing (matrix
    // row 1): the only git this has run is the lookup that asked which editor
    // to open.
    const feedback = request.feedbackEdit
      ? Option.some(yield* feedbackEdited({ repoRoot, runtimeRoot: config.runtimeRoot, branch }))
      : typedFeedback;
    // What this run's passes are for, and what its row records — decided
    // together, on the same arm (T66). An ordinary dispatch resolves its spec,
    // rides the `Spec` arm with whatever `--feedback` said, and takes the
    // `OneOff` identity built from that same path; a dispatch that stated its
    // task inline rides the `Inline` arm with the text and takes the
    // `InlineTask` identity built from that same text (T67), which is what a
    // later `--resume` replays; a resume takes the arm T16's decision table
    // picked and the `FeedbackResume` **wrapping** the identity it recovered —
    // which is already the underlying dispatch, so a resumed resume wraps the
    // original one-off rather than a chain — carrying the resumed run's id when
    // it had one and nothing when it predates run ids (SPEC §10).
    //
    // A **feature** dispatch is the one arm that cannot finish here (T73): its
    // task *is* its selection, and the selection is read at the branch tip in
    // §7's step 4, which is below the fetch. So this resolves the folder — a
    // pure derivation — and the pair is completed after the boundary, where
    // the tip is in hand. The `Pending` arm exists rather than an `Option`
    // beside a pair because "which of the three is this" has exactly one
    // answer, and two fields that can disagree about it is how a run ends up
    // with both a spec and a folder.
    const sourceDispatched = (
      named: Source,
    ): Effect.Effect<Dispatched, GuardRefused, FileSystem.FileSystem> => {
      switch (named._tag) {
        case "Resume":
          return resumedDispatch(named.run, repoRoot, tasksDir, feedback, request.issues);
        case "Feature":
          return Effect.succeed({
            _tag: "Pending",
            folder: featureFolderFor(repoRoot, tasksDir, named.asked.folder),
            request: named.asked.request,
            resumed: Option.none(),
          });
        case "Inline":
          return Effect.succeed(resolvedAs(inlineDispatch(named.text)));
        case "Spec":
          return specResolved(repoRoot, tasksDir, named.spec).pipe(
            Effect.map((resolved) => resolvedAs(specDispatch(resolved, feedback))),
          );
      }
    };
    const dispatched: Dispatched = yield* sourceDispatched(source);
    // On a resume the base comes off the record, not off `--base`; a record
    // that carried none falls through to the same default chain a fresh
    // dispatch takes, because that degradation is data rather than a failure.
    const givenBase = Option.match(resumed, {
      onNone: () => request.base,
      onSome: (run) => run.base,
    });
    const baseRef = yield* Option.match(givenBase, {
      onNone: () => defaultBase(branch),
      onSome: (value) => Effect.succeed(value),
    });
    yield* branchExists(repoRoot, branch);
    yield* branchNotProtected(branch);
    yield* baseNotBranch(branch, baseRef);
    yield* branchNotCheckedOut(branch, repoRoot);
    // Last of the guards, and the one bash has no equivalent of: its setup
    // step is a hard-coded script, ours is whatever the config names. A
    // declared hook that is not on this host refuses here rather than inside
    // the container that would have run it (T7).
    yield* setupHookFound(repoRoot, config.setupHook);
    // And the file docker will read the container's environment out of
    // (T61), which is the same question asked of the other config-declared
    // path — with one more arm: a value that is absolute, or that leaves the
    // served repo once normalized, is refused rather than resolved, because
    // this is the only declared file whose contents cross into the sandbox.
    yield* sandboxEnvFileFound(repoRoot, config.sandboxEnvFile);
    // And the credential the agent CLI will authenticate with (T23), the last
    // of the "does this run have what it needs" questions and the cheapest:
    // the answer was resolved at the composition root, so this asks the host
    // nothing at all. It belongs above the preflight for the reason every
    // guard does — a refusal holds nothing — and a dispatch that reached the
    // container without it spent a lock, a clone, and a container start on a
    // question that was answerable at the door.
    const agentCredential = yield* credentialFound(credential);
    // And the repo every `gh` call this run makes will name (T39), resolved
    // at the composition root like the credential above it — a refusal here
    // is the same shape and holds the same nothing.
    const forgeRepoSlug = yield* forgeRepoFound(repoRoot, forgeRepo);

    // The last local guard has passed, so this is where the dispatch goes to
    // the network (T70, SPEC §7 step 2): one `git fetch origin`, before
    // anything below reads a remote-tracking ref. Everything above it is
    // ref-shaped and host-shaped and costs no round trip — a typo'd `--branch`
    // still refuses without one, which is `run.sh`'s cheap-local-validation-
    // first invariant kept rather than borrowed.
    //
    // It holds nothing and has no release, so matrix row 1 is untouched: the
    // guards below it refuse exactly as they did, against refs that are now
    // current rather than against whatever the last hand-run fetch left.
    yield* originFetched(repoRoot);

    // Then preflight — the dispatcher's own freshness against `baseRef`
    // (T44, on a self-hosted dispatch only, T60), the daemon, the image, and
    // `gh`'s auth (T12), still holding nothing. `baseRef` is already resolved
    // above, and the fetch has just moved the remote-tracking ref it names, so
    // the freshness check compares against what `origin` holds now rather than
    // against a ref the dispatcher last updated by hand.
    yield* preflight(
      config.image,
      repoRoot,
      config.imageBuildCommand,
      baseRef,
      selfHosted,
      request.allowStaleDispatcher,
      Option.some(forgeRepoSlug),
    );

    // The authoritative `BASE_SHA` and the diff boundary taken from it (SPEC
    // §7 step 3), resolved once, here, out of what the fetch above brought
    // back — they did not move, the fetch moved in front of them.
    const baseSha = yield* resolveBaseSha(repoRoot, baseRef);
    // Under `--hard-reset` the base is the effective tip, so the boundary is
    // the base too (14, lesson 7) — bash's `MERGE_BASE="$BASE_SHA"`
    // (`run.sh:1300`). Nothing is asked of git about a merge-base the reset is
    // about to make trivially true.
    const mergeBaseSha = request.hardReset
      ? baseSha
      : yield* resolveMergeBase(repoRoot, baseSha, branch);

    // SPEC §7 step 4 — the content guards, after the boundary and still before
    // the lock (T73). The tip is resolved first and for every arm, because it
    // is a fact of every dispatch: the checkout forks from it, so it is the
    // ref whose content the agent will see (15's fork commit, 14's branch
    // tip), and `baseSha` above is the boundary's other end and never what a
    // set is read at.
    const guardTip = yield* resolveBranchTip(repoRoot, branch);
    // A branch that does not contain what origin holds now would do all its
    // work and fail at the push (T106), so it is refused here instead, before
    // anything is held. Under `--hard-reset` it is skipped by construction:
    // the reset discards both sides, and its union count says how much.
    if (!request.hardReset) {
      yield* branchContainsItsRemote({ repoRoot, branch, tipSha: guardTip });
    }
    // `--hard-reset` decides here, after the fetch and before anything reads
    // the tip (T101): what origin holds now, and what the reset and the leased
    // push discard between them. The tip the guards read survives only as the
    // reset's expected old value; everything below receives the base as the
    // tip, because after the reset that is where the branch stands.
    const reset = request.hardReset
      ? Option.some(yield* hardResetDecided({ repoRoot, branch, baseSha, tipSha: guardTip }))
      : Option.none();
    // And says what that costs, asking on a terminal (T102) — still before the
    // reconciler, so a declined confirm holds nothing and has written nothing
    // but the fetch (matrix row 1).
    if (Option.isSome(reset)) {
      yield* hardResetConfirmed({
        branch,
        discarding: reset.value.discarding,
        noInput: request.noInput ?? false,
      });
    }
    const tipSha = request.hardReset ? baseSha : guardTip;
    // And then, on the feature arm alone, the set at that tip, the selection
    // over it, and the two witnesses (T74): reads and a pure function, nothing
    // written and nothing held, so matrix row 1 holds through this phase. The
    // folder was resolved above; what happens here is the part that needs the
    // world.
    const { task, identity } = yield* dispatched._tag === "Resolved"
      ? Effect.succeed(dispatched)
      : Effect.gen(function* () {
          const issues = yield* issueSetAt({ repoRoot, branch, tipSha, folder: dispatched.folder });
          // A resume's replay is selected here too, as the `Enumerated` ids its
          // record left (T78): a blocker that landed elsewhere since, or an id
          // marked `Done` on this branch by hand, refuses as it would on a
          // fresh dispatch — the latter as the branch moving under the record.
          const selection = yield* issuesSelected({
            issues,
            request: dispatched.request,
            folder: dispatched.folder,
            tipSha,
            replaying: Option.map(dispatched.resumed, (run) => run.branch),
          });
          // And then T74's two witnesses for *someone else already has this
          // issue*, in this order and **under `all` alone**: `all` consents to
          // wideness and not to contents (15), so enumerating is the override
          // for both. They are skipped rather than run and ignored — the scan
          // is two git processes over every ref, and a check whose answer is
          // discarded is a check a reader will one day believe was made.
          //
          // git first, because it is the one that is truth: a copy that says
          // `Done` on another ref refuses whatever the ledger holds, and
          // neither witness is asked something it cannot know.
          if (selection.request._tag === "All") {
            yield* notLandedElsewhere({
              repoRoot,
              branch,
              folder: dispatched.folder,
              issues: selection.issues,
              tipSha,
              resetting: Option.isSome(reset),
            });
            yield* notInProgressElsewhere({
              branch,
              folder: dispatched.folder,
              issues: selection.issues,
            });
          }
          return Option.match(dispatched.resumed, {
            onNone: () => featureDispatch(dispatched.folder, selection, feedback),
            onSome: (run) =>
              resumedFeatureDispatch(dispatched.folder, selection, feedback, run.resumedRunId),
          });
        });

    // Then the reconciler, over **every** slug rather than this run's alone
    // (05 Q11/Q14): the container, lock, and checkout a hard-killed dispatch
    // leaves are nobody's finalizer's, so the next preflight is the only place
    // matrix row 17 gets closure. It is preflight rather than a resource — it
    // holds nothing when it is done — and it takes each dead run's own lock
    // before touching anything of that run's. It sits below *every* guard,
    // including the two `--base` reads above, because a refusal touches
    // nothing (matrix row 1) and this pass is the first thing here that would.
    // It reports rather than fails: the check that *can* refuse a dispatch on
    // the daemon is the preflight above.
    yield* reconcile(repoRoot);

    // Plan time, taken immediately before the id is minted from it (T46):
    // the run's id is a fact of the plan, not of the lock claim `runInScope`
    // reads its own clock for below.
    const startedAt = yield* DateTime.now;
    const plan = planFor({
      task,
      identity,
      branch,
      baseRef,
      baseSha,
      mergeBaseSha,
      tipSha,
      reset,
      runtimeRoot: config.runtimeRoot,
      startedAt,
      keepsLog: request.keepsLog,
    });

    // The plan is a `Reporter` event with the renderer as a subscriber,
    // matching `doctor` and `status`. A process.stdout.write here typechecks
    // and is wrong.
    yield* reporter.emit({ _tag: "PlanResolved", plan });

    // Everything above this line holds nothing. Below it the lock is claimed,
    // the log is opened, the checkout is cloned, the sandbox is started, the
    // setup hook runs, the run's passes run — one implement pass (T9) and the
    // review rounds until approval or the cap (T10), or T76's loop over the
    // selection, issue by issue — and a terminal row is owed.
    // The work is T11's land — fetch-back, count, push or nothing to land —
    // and then T12's PR, each staged here because a `GitError` and a
    // `ForgeError` say nothing about where the run was and the row has to
    // (matrix rows 13-15). Then the run releases in reverse, removing the
    // container and fetching the checkout back a second time, which is the
    // salvage every other exit path takes.
    yield* runInScope(
      plan,
      repoRoot,
      agentCredential,
      forgeRepoSlug,
      ({ sandbox, pr, outcomes }) =>
        land(plan, repoRoot, outcomes).pipe(
          Effect.mapError(atStage("land")),
          // The PR, on the commits the land sent out and inside the container
          // that is still up, because the description is one more agent pass.
          // A branch with nothing past the boundary skips it entirely: there
          // is nothing to open a PR about, and the row records neither field
          // (`run.sh:1673`).
          Effect.flatMap((landed) =>
            landed === "pushed"
              ? openPullRequest(plan, forgeRepoSlug, sandbox, pr, outcomes).pipe(
                  Effect.mapError(atStage("pr")),
                )
              : Effect.void,
          ),
        ),
      dispatcherRevision,
      // The row records an override, not a flag (T44): `staleDispatcherOverridden`
      // means "a stale-dispatcher refusal was proceeded past", and on a dispatch
      // that is not self-hosted the preflight never asked, so there was nothing
      // to proceed past (T60). Recording the flag alone would put a check on the
      // ledger that never ran — the reading a later dispatcher makes of a row is
      // the whole reason the field exists.
      selfHosted && request.allowStaleDispatcher,
    );
    return plan;
  });
