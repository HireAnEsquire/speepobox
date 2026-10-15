// The dispatch renderer: pure functions over the resolved plan and over the
// failures a refusal produces, subscribed to the `Reporter` stream exactly
// like doctor's row renderer and status's screen.
import type { ValidationError } from "@effect/cli/ValidationError";
import { Option } from "effect";
import type { AgentPassFailed } from "../agent/agent-cli.ts";
import type { PromptUnusable } from "../agent/prompt-source.ts";
import type { ConfigError } from "../config/config.ts";
import type { RepoRootRefused } from "../config/served-repo.ts";
import type { DockerUnavailable, GhUnavailable, ImageUnavailable } from "../doctor/probes.ts";
import type { ForgeError } from "../forge/forge.ts";
import type { GcRefused } from "../gc/argv.ts";
import type { InitRefused } from "../init/argv.ts";
import type { LogsRefused } from "../logs/argv.ts";
import type { UpgradeRefused } from "../upgrade/argv.ts";
import type { GitError } from "../git/git.ts";
import type { ImageBuildRefused } from "../image/build.ts";
import { dispatchIdentity } from "../ledger/record.ts";
import type { LockError, LockHeld } from "../lock/run-lock.ts";
import type { SandboxError } from "../sandbox/sandbox.ts";
import type { GuardRefused } from "./guards.ts";
// The abbreviation lives beside the plan rather than here (T73): the content
// guards name the tip they read the issue set at, and two shortenings that
// disagreed would render one commit two ways on two screens about one run.
import { isResume, logPathOrNote, shortSha, taskNamed, type DispatchPlan } from "./plan.ts";
import type { StaleDispatcher } from "./preflight.ts";

const row = (label: string, value: string): string => `  ${`${label}:`.padEnd(15)}${value}`;

// The two facts the passes are framed by, on the one line SPEC §7 specifies
// for them (T67): what the task is, and whether the run resumes. Neither is
// inferable from the rest of the block — the banner names a path or a phrase
// but not which of the two it is, and nothing above prints the identity at all
// — which is why §7 asks for the line rather than leaving a reader to work it
// out from what is missing.
//
// All eight of §7's spellings are printed here — *feature* since T73,
// *resume (feature)* since T78 made a feature row's resume replay its recorded
// set, and *resume (feedback stands in for the exhausted issue set)* since T89
// ran a feature row's resume whose set is all approved on `--feedback`. The
// `issues` row below lists the replayed ids on the feature arm; the eighth
// rides the inline arm and has none.
//
// The task says which arm; the **identity** says whether this is a resume
// (`plan.ts`), on either arm. Rows 6 and 8 of 22 §6 are the one pair the two
// cannot tell apart alone — both are a resume whose task is text — and what
// tells them apart is the identity underneath the `FeedbackResume`: an
// `InlineTask` is the text this branch was dispatched with, a `OneOff` is a
// spec that has since left the disk with the dispatcher's feedback standing in
// for it, and a `Feature` is a recorded set with nothing left to run, the
// feedback standing in for that (T89).
const modeNamed = (plan: DispatchPlan): string => {
  const resuming = isResume(plan.identity);
  if (plan.task._tag === "Feature") {
    return resuming ? "resume (feature)" : "feature";
  }
  if (plan.task._tag === "Spec") {
    return resuming ? "resume (spec)" : "one-off (spec)";
  }
  if (!resuming) {
    return "one-off (inline task)";
  }
  switch (dispatchIdentity(plan.identity)._tag) {
    case "InlineTask":
      return "resume (inline task)";
    case "Feature":
      return "resume (feedback stands in for the exhausted issue set)";
    case "OneOff":
      return "resume (feedback stands in for the missing spec)";
  }
};

// The selection a feature dispatch resolved, on the one line a dispatcher
// checks it from (T73): the ids in T69's order and how many there are. The ids
// are the whole of what is checked — which files they came from, what they are
// called, and what blocks what are all questions the folder answers — so a row
// per issue would be a screen of vocabulary nobody reads to approve a command
// line. Absent on the other two arms, which have no set.
const issueRows = (plan: DispatchPlan): ReadonlyArray<string> => {
  if (plan.task._tag !== "Feature") {
    return [];
  }
  const { issues } = plan.task.selection;
  return [row("issues", `${issues.map((issue) => issue.id).join(" ")} (${issues.length})`)];
};

// What a `--hard-reset` dispatch will throw away (T101), on the one row bash
// prints for it under `--dry-run` (`run.sh:2305`): the base it resets to, and
// the union count over the branch and origin's copy of it. origin is named
// only when it had the branch, since only then does the leased push discard
// anything there. Absent without the flag, which leaves the block byte for byte
// what it was.
const resetRows = (plan: DispatchPlan): ReadonlyArray<string> =>
  Option.match(plan.reset, {
    onNone: () => [],
    onSome: (reset) => [
      row(
        "fork point",
        `hard reset to ${plan.baseRef} — discards ${reset.discarding} commit(s) on '${plan.branch}'${
          Option.isSome(reset.originTip) ? ` and origin/${plan.branch}` : ""
        } (reflog-recoverable only)`,
      ),
    ],
  });

// The plan block bash prints under `--dry-run` (run.sh:1806-1837), which is
// the shape T15 inherits — one derivation, one rendering, no second copy.
export const renderPlan = (plan: DispatchPlan): string =>
  [
    `speepobox: ${taskNamed(plan.task)} on branch '${plan.branch}'  |  base ${plan.baseRef} @ ${shortSha(plan.baseSha)}`,
    row("mode", modeNamed(plan)),
    ...issueRows(plan),
    row("branch", plan.branch),
    row("base", `${plan.baseRef} @ ${shortSha(plan.baseSha)}`),
    row("diff boundary", plan.mergeBaseSha),
    ...resetRows(plan),
    row("container", plan.containerId),
    row("checkout path", plan.checkoutPath),
    row("log path", logPathOrNote(plan.logPath)),
  ].join("\n");

// Everything the dispatch surface can fail with that carries a human-readable
// line: the guards, the two preflight probes, and the config decode `appLiveFor`
// performs at startup. `@effect/cli`'s own validation errors are not in here
// on purpose — the parser has already printed its help doc by the time one
// reaches the entrypoint, and printing a second line would double-report it.
//
// `RepoRootRefused` (T60) is the one member that precedes every command rather
// than belonging to the dispatch surface: the `--repo-root` peel runs before
// the entrypoint's `argv[0]` switch, and a refusal there is the same one line
// on stderr and the same exit 1, rendered here rather than in a second shape
// `bin.ts` could not have asserted. `GcRefused` (T99) is the same kind of
// member: `gc` is intercepted before the dispatch surface, and its refusal is
// that same one line, and so are `InitRefused` (T114), `UpgradeRefused`
// (T128), and `LogsRefused` (T151). `ImageBuildRefused` (T111) is `image build`'s, which is on the dispatch surface and refuses
// before `Sandbox.build` is asked.
export type DispatchFailure =
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
  | ForgeError
  | ConfigError
  | RepoRootRefused
  | GcRefused
  | InitRefused
  | UpgradeRefused
  | LogsRefused
  | ImageBuildRefused
  | ValidationError;

// The preflight and config details are `doctor`'s, written for a row whose own
// label column already says which check failed ("docker", "image", "config").
// A refusal is one line with no such column, so it carries the label here — in
// the renderer, not in a second copy of the probe text. A `GuardRefused` names
// its own subject ("--branch is required", "spec not found: …") and needs none.
const label = (
  error:
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
    | ForgeError
    | ConfigError
    | RepoRootRefused
    | GcRefused
    | InitRefused
    | UpgradeRefused
    | LogsRefused
    | ImageBuildRefused,
): string => {
  switch (error._tag) {
    case "DockerUnavailable":
      return "docker: ";
    case "ImageUnavailable":
      return "image: ";
    case "GhUnavailable":
      return "gh: ";
    case "ConfigError":
      return "config: ";
    // `LockError` is the lock file we could not write, so the line says which
    // subject failed. `LockHeld` names its own ("another speepobox run …") and
    // falls through to no label, as a `GuardRefused`, a `GitError` ("could not
    // clone 'x' into …"), a `SandboxError` ("could not start the sandbox
    // 'x' …"), an `AgentPassFailed` ("the implement pass …"), a
    // `PromptUnusable` ("the implement prompt at … is empty", T14), a
    // `ForgeError` ("could not read the PR for 'x' …"), a `StaleDispatcher`
    // ("this dispatcher's source here is missing …", T44), a
    // `RepoRootRefused` ("--repo-root must be an absolute path …", T60), a
    // `GcRefused` ("unknown gc flag: …", T99), an `InitRefused` ("init needs
    // --base …", T114), an `UpgradeRefused` ("pin … is no release", T128), and an `ImageBuildRefused` ("image input not found: …",
    // T111) do.
    case "LockError":
      return "lock: ";
    default:
      return "";
  }
};

export const renderFailure = (error: DispatchFailure): Option.Option<string> =>
  "detail" in error ? Option.some(`!! ${label(error)}${error.detail}`) : Option.none();
