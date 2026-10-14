// The dispatch command surface (SPEC §7): positional `<spec>` plus `--branch`
// and `--base`, parsed by `@effect/cli` — one of the two jobs that library is
// retained for (SPEC §1; the other is `ConfigFile`, already in config.ts). Its
// prompting half is not used: prompting is the `Prompt` tag's, behind clack,
// and its layer reaches the picker (T81) and the dispatch, for `--hard-reset`'s
// confirm (T102).
//
// `status` and `doctor` stay intercepted in bin.ts *before* this parser, and
// on `appBaseLiveFor`: they must work when the thing they inspect is broken, so
// they must not be reachable only through a parser that can itself refuse.
import { Args, Command, Options } from "@effect/cli";
import type { ValidationError } from "@effect/cli/ValidationError";
import type { FileSystem, Path, Terminal } from "@effect/platform";
import type { CommandExecutor } from "@effect/platform/CommandExecutor";
import type { Effect, Option } from "effect";
import type { AgentCli, AgentPassFailed } from "../agent/agent-cli.ts";
import type { AgentCredential } from "../agent/credential.ts";
import type { PromptUnusable } from "../agent/prompt-source.ts";
import type { BessemerConfig } from "../config/config.ts";
import type { DockerUnavailable, GhUnavailable, ImageUnavailable } from "../doctor/probes.ts";
import type { Forge, ForgeError } from "../forge/forge.ts";
import type { Git, GitError } from "../git/git.ts";
import type { RepoSlug } from "../git/repo-slug.ts";
import type { IssueStore } from "../issues/issue-store.ts";
import type { Ledger } from "../ledger/ledger.ts";
import type { Dispatcher } from "../ledger/record.ts";
import type { LockError, LockHeld, RunLock } from "../lock/run-lock.ts";
import type { Notifier } from "../notify/notifier.ts";
import type { Prompt } from "../prompt/prompt.ts";
import type { Reporter } from "../reporter.ts";
import type { Sandbox, SandboxError } from "../sandbox/sandbox.ts";
import { dispatch } from "./dispatch.ts";
import type { GuardRefused } from "./guards.ts";
import type { StaleDispatcher } from "./preflight.ts";

// Optional, and refused by a guard for `--branch`'s reason below: a resume
// takes its spec off the ledger rather than off the command line (T16), so
// the parser cannot be the thing that insists on one.
const spec = Args.text({ name: "spec" }).pipe(
  Args.withDescription(
    "the task spec: a bare name resolves under the tasks dir, anything with a slash is a path used as-is",
  ),
  Args.optional,
);

// Required, and refused by a guard rather than by the parser: `--branch`
// missing is one of the six refusals row 1 of the failure matrix covers, and
// they all arrive as a typed GuardRefused with nothing held.
const branch = Options.text("branch").pipe(
  Options.withDescription(
    "REQUIRED — the working branch and the task's identity. Must already exist; master/main and the checked-out branch are refused",
  ),
  Options.optional,
);

const base = Options.text("base").pipe(
  Options.withDescription(
    "PR target and diff boundary. Defaults to this branch's last recorded base in the ledger, then to the configured base",
  ),
  Options.optional,
);

// Ledger-keyed re-dispatch (SPEC §7): the spec and `--base` come back off the
// branch's newest record, and `--branch` is implied by the branch resumed.
const resume = Options.text("resume").pipe(
  Options.withDescription(
    "re-dispatch <branch> from the ledger: its spec, its base, and its identity come off the newest record for it",
  ),
  Options.optional,
);

// Sugar on `--resume`, and a second *target* rather than a second code path:
// the most recently recorded branch, whichever it was.
const last = Options.boolean("last").pipe(
  Options.withDescription("--resume on the most recently recorded branch"),
);

// Extra dispatcher instructions for this run (SPEC §7, T17). The parser hands
// the text over untouched and it reaches the agent on the stdin prompt pipe —
// **it is never a word of any command line**, which is what makes quotes,
// backticks, and `$(…)` in it arrive literally.
const feedback = Options.text("feedback").pipe(
  Options.withDescription(
    "extra dispatcher instructions, appended to the implement, review, and PR-description prompts. On a --resume whose spec is gone, it stands in as the task",
  ),
  Options.optional,
);

// The same text, written in the dispatcher's editor rather than in their shell
// (T84). A boolean and not a value option — it names no text, it goes and gets
// one — so `VALUE_OPTION_NAMES` is untouched and the `--repo-root` peel reads
// the argv exactly as it did.
//
// Refused beside `--feedback` and beside `--task` from the command line alone
// (`taskStatedOnce`), and refused off a TTY before any git call: it opens an
// editor, and a dispatch that cannot drive one must say so rather than hang.
const feedbackEdit = Options.boolean("feedback-edit").pipe(
  Options.withDescription(
    "write --feedback's text in the editor git would open for a commit (git var GIT_EDITOR), on a commented template. TTY-only; refused beside --feedback or --task, and an empty result aborts before anything is claimed",
  ),
);

// The task stated inline rather than as a file (T67, 22 §3), and the whole of
// what a `--task` dispatch's passes are for. Optional here and refused by the
// guards — T3's rule, so the four collisions arrive as the one `GuardRefused`
// shape row 1 gives rather than as a parser error with another.
//
// **The text is never a word of any command line.** It rides the stdin prompt
// pipe as `--feedback` does (T17), which is what makes quotes, backticks, and
// `$(…)` in it arrive literally.
const task = Options.text("task").pipe(
  Options.withDescription(
    "the task, stated inline instead of as a spec file; refused beside <spec>, --resume/--last, or --feedback",
  ),
  Options.optional,
);

// The feature run's two flags (SPEC §7, T73), optional here and refused by
// `featureStatedOnce` for the reason `--task` is: the four collisions arrive as
// the one `GuardRefused` shape row 1 gives rather than as a parser error with
// another (T3).
//
// They are a pair, and neither is a dispatch alone: `--feature` without
// `--issues` refuses, because a selection the dispatcher did not name is a
// proposal rather than an instruction (09 unit 1, 15), and `--issues` without a
// feature or a resume names issues of nothing.
const feature = Options.text("feature").pipe(
  Options.withDescription(
    "feature run over <folder>/issues/*.md, one container and one branch, in dependency order. A bare name resolves under the tasks dir, anything with a slash is a path used as-is. Requires --issues",
  ),
  Options.optional,
);

const issues = Options.text("issues").pipe(
  Options.withDescription(
    "feature mode only; comma list of issue ids, or the literal 'all'. There is no default. 'all' selects every ready-for-agent AFK issue whose blockers are done or also selected, read at the branch tip",
  ),
  Options.optional,
);

// Declared so the parser accepts it and `--help` says it exists, and read in
// two places only: at the entrypoint, where it picks `appDryRunLiveFor` over
// `appLiveFor` (unchanged), and here, where the handler below turns it into
// `keepsLog` on the `DispatchRequest` (T48) — a fact about whether this run's
// plan carries a log path, not the flag that decided it. `dispatch` and
// everything below it read `keepsLog`, never this flag, so no dispatch op
// learns it is a rehearsal. A dispatch that branched on the flag itself would
// be the second dispatch path the layer swap exists to delete, and
// `scripts/check-bans.ts` fails on one outside the four sites permitted to
// name it.
const dryRun = Options.boolean("dry-run").pipe(
  Options.withDescription(
    "rehearse this dispatch: every guard and the resolved plan for real, and the mutations recorded rather than performed — nothing is started, claimed, pushed, or recorded",
  ),
);

// T44: proceed past the preflight's stale-dispatcher refusal anyway, with a
// warning and a row that records it (`staleDispatcherOverridden`). The
// ordinary case refuses instead — a dispatcher this far behind its base would
// run different semantics than the base expects and say nothing about it. On a
// dispatch that is not self-hosted there is no freshness check to override, so
// the flag does nothing (T60), and the description says so rather than leaving
// a dispatcher to wonder what it bought them.
const allowStaleDispatcher = Options.boolean("allow-stale-dispatcher").pipe(
  Options.withDescription(
    "proceed even when this dispatcher's source is missing a commit already on --base — recorded on the run's ledger row; nothing to override, and no effect, when this dispatch is not self-hosted",
  ),
);

// T101: throw away the branch's commits since the base — and origin's copy of
// them, through a pinned lease — and run from the base. Destructive, and the
// description says so. Not a modifier (bash counts only `--dry-run` and
// `--allow-stale-dispatcher`, `run.sh:716-717`), and refused beside a resume
// (`hardResetStatedAlone`); beside `--feature` the set is read at the base
// (T103). Off a terminal the flag is the consent (D3); the TTY confirm is
// T102's.
const hardReset = Options.boolean("hard-reset").pipe(
  Options.withDescription(
    "DESTRUCTIVE — reset --branch to --base and redo the work from there, discarding its commits since the base, and push with --force-with-lease pinned to where origin's branch stood. The discarded commits are recoverable from the reflog only. Refused beside --resume/--last",
  ),
);

// The scriptability escape hatch (T86): a command line missing an answer is
// refused as it is off a terminal, and the picker is never asked. It is a
// boolean the request carries, so the `AnswerMissing` the dispatch raises
// tells the entrypoint whether to ask. It is not a modifier: `bessemer
// --no-input` alone is a dispatch and is refused, rather than being usage.
const noInput = Options.boolean("no-input").pipe(
  Options.withDescription(
    "never prompt: a command line missing an answer is refused as it is off a terminal, and the picker does not open",
  ),
);

// The repo root, whether it is the package's own, the agent credential, the
// dispatcher's own revision, and the forge repo reach the handler as
// parameters rather than through a tag: all five are host reads, resolved once
// at the composition root (AGENTS.md), and the command is built around them
// rather than reaching for them. `selfHosted` is a plain boolean because it is
// a decided predicate rather than a read that can come back empty (T60). The
// credential is an `Option` because "there is none" is a dispatch guard's
// refusal (T23), not a parser error and not something the run finds out about
// inside a container; the dispatcher revision is an `Option` for the reason a
// row renders it as unknown (T43) — the read itself can come back empty. The
// forge repo is an `Option` for the same reason the credential is (T39): an
// unresolvable `origin` is `forgeRepoFound`'s refusal, not a parser error.
const dispatchCommand = (
  repoRoot: string,
  selfHosted: boolean,
  credential: Option.Option<AgentCredential>,
  dispatcherRevision: Option.Option<Dispatcher>,
  forgeRepo: Option.Option<RepoSlug>,
) =>
  Command.make(
    "bessemer",
    {
      spec,
      branch,
      base,
      resume,
      last,
      feedback,
      feedbackEdit,
      task,
      feature,
      issues,
      dryRun,
      allowStaleDispatcher,
      hardReset,
      noInput,
    },
    ({ dryRun: rehearse, ...parsed }) =>
      dispatch(
        { ...parsed, keepsLog: !rehearse },
        repoRoot,
        selfHosted,
        credential,
        dispatcherRevision,
        forgeRepo,
      ),
  ).pipe(Command.withDescription("dispatch an AFK agent run for <spec> on --branch"));

// `Command.run` drops the first two argv entries (runtime + script) before
// parsing; bin.ts has already sliced them off to intercept status/doctor, so
// they go back on here rather than un-slicing at the call site. What arrives
// is also the *peeled* argv (T60): `--repo-root` is read before the switch
// bin.ts makes, so this parser never sees a flag it does not declare.
export const dispatchCli = (
  argv: ReadonlyArray<string>,
  repoRoot: string,
  selfHosted: boolean,
  credential: Option.Option<AgentCredential>,
  dispatcherRevision: Option.Option<Dispatcher>,
  forgeRepo: Option.Option<RepoSlug>,
): Effect.Effect<
  void,
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
  | ValidationError,
  | BessemerConfig
  | Ledger
  | RunLock
  | Git
  | IssueStore
  | Sandbox
  | AgentCli
  | Forge
  | Notifier
  | Reporter
  | CommandExecutor
  | FileSystem.FileSystem
  | Path.Path
  | Terminal.Terminal
  | Prompt
> =>
  Command.run(dispatchCommand(repoRoot, selfHosted, credential, dispatcherRevision, forgeRepo), {
    name: "bessemer",
    version: "0.1.0",
    executable: "bessemer",
  })(["node", "bessemer", ...argv]);
