// Matrix rows 1-2 (SPEC §11): every guard and both preflight probes refuse
// with a typed error and hold nothing. "Holds nothing" is asserted rather than
// intended — the runtime root is a fresh temp directory and every refusal
// re-checks that no lock, checkout, log, or ledger row appeared in it, and
// that no state-changing docker or git command was ever spawned.
import { describe, expect, it } from "@effect/vitest";
import { type CommandExecutor, FileSystem, type Path, Terminal } from "@effect/platform";
import type { PlatformError } from "@effect/platform/Error";
import { NodeContext, NodeFileSystem, NodePath } from "@effect/platform-node";
import { DateTime, Duration, Effect, Either, Layer, Option, Ref, type Scope } from "effect";
import { AgentPassFailed, type AgentCli } from "../src/agent/agent-cli.ts";
import type { AgentCredential } from "../src/agent/credential.ts";
import type { CurrentIssue, PrContext } from "../src/agent/prompt.ts";
import { PromptUnusable } from "../src/agent/prompt-source.ts";
import {
  SpeepoboxConfig,
  type SpeepoboxConfigShape,
  ConfigError,
  defaultConfig,
} from "../src/config/config.ts";
import { packagePathspec } from "../src/config/paths.ts";
import { RepoRootRefused } from "../src/config/served-repo.ts";
import { dispatchCli } from "../src/dispatch/command.ts";
import {
  dispatch,
  type DispatchRequest,
  feedbackGiven,
  issuesRequested,
  taskGiven,
} from "../src/dispatch/dispatch.ts";
import { prContextFor } from "../src/dispatch/feedback.ts";
import {
  AnswerMissing,
  branchBehindItsRemote,
  branchExists,
  branchDivergedFromItsRemote,
  FEEDBACK_EDIT_PURPOSE,
  FEEDBACK_EDIT_NEEDS_A_TTY,
  GuardRefused,
  hardResetDecided,
  isProtectedBranch,
  namesTheSameRef,
  stripOriginPrefix,
} from "../src/dispatch/guards.ts";
import {
  CHECKOUTS_DIRNAME,
  checkoutPathFor,
  containerIdFor,
  type DispatchPlan,
  featureDispatch,
  featureFolderFor,
  feedbackIn,
  LOCKS_DIRNAME,
  lockPathFor,
  inlineDispatch,
  logPathFor,
  planFor,
  resumedFeatureDispatch,
  slugFor,
  specDispatch,
  specPathFor,
  statusIndexPathFor,
  type Task,
  taskNamed,
  TASK_SUMMARY_WIDTH,
  taskSummary,
} from "../src/dispatch/plan.ts";
import { type DispatchFailure, renderFailure, renderPlan } from "../src/dispatch/render.ts";
import {
  resumeDispatchAction,
  resumeResolved,
  resumedTask,
  resumeTargetFor,
} from "../src/dispatch/resume.ts";
import { DockerUnavailable, ImageUnavailable } from "../src/doctor/probes.ts";
import { exec } from "../src/internal/exec.ts";
import { type Forge, ForgeLive } from "../src/forge/forge.ts";
import { type Git, GitError, GitLive } from "../src/git/git.ts";
import type { IssueStore } from "../src/issues/issue-store.ts";
import type { Issue } from "../src/issues/issue.ts";
import type { RepoSlug } from "../src/git/repo-slug.ts";
import {
  type LastWorkedOn,
  Ledger,
  LedgerError,
  type ResumeResolution,
  type ResumeTarget,
} from "../src/ledger/ledger.ts";
import type {
  Dispatcher,
  DispatchIdentity,
  IssueOutcome,
  RunIdentity,
  RunRecord,
} from "../src/ledger/record.ts";
import { dispatchIdentity } from "../src/ledger/record.ts";
import { LockError, LockHeld, type RunLock, RunLockLive } from "../src/lock/run-lock.ts";
import type { Notifier } from "../src/notify/notifier.ts";
import type { Prompt } from "../src/prompt/prompt.ts";
import { ALL_READY, argvFor } from "../src/picker/picker.ts";
import { type AgentPass, Reporter, type ReporterEvent } from "../src/reporter.ts";
import { type Sandbox, type SandboxHandle, SandboxLive } from "../src/sandbox/sandbox.ts";
import { SETUP_HOOK_DIR, SPEC_TARGET } from "../src/sandbox/spec.ts";
import {
  fakeAgentCli,
  type FakeAgentCliOptions,
  ZERO_PASS_USAGE,
} from "./support/agent-cli-fake.ts";
import { CREDENTIAL_CANARY, TEST_CREDENTIAL } from "./support/credential.ts";
import { editorInvocationUnder } from "./support/editor-file.ts";
import { TEST_FORGE_REPO } from "./support/repo-slug.ts";
import {
  type FakeForgeOptions,
  fakeForge,
  type ForgeCall,
  PR_NUMBER,
  PR_URL,
  viewedPullRequest as VIEWED_PR,
} from "./support/forge-fake.ts";
import { type ScriptedResult, scriptedExecutor } from "./support/exec-fake.ts";
import { repoWithNestedDir } from "./support/nested-dir.ts";
import {
  fakeIssue,
  fakeIssueStore,
  type FakeIssueStoreOptions,
  type IssueStoreCall,
} from "./support/issue-store-fake.ts";
import { fakeNotifier } from "./support/notifier-fake.ts";
import {
  type AskedQuestion,
  CANCEL,
  type ScriptedAnswer,
  scriptedPrompt,
} from "./support/prompt-fake.ts";
import { PLAN_TIP } from "./support/plan.ts";

// The close of one pass as the fake `AgentCli` reports it (T55): a pass that
// never ran took no time and spent nothing, so every one of them is the same
// event but for which pass it names.
const passFinished = (pass: AgentPass): ReporterEvent => ({
  _tag: "AgentPassFinished",
  pass,
  issue: Option.none(),
  elapsed: Duration.zero,
  usage: ZERO_PASS_USAGE,
});

const BRANCH = "speepobox-t3";
// The scratch repo root is a temp directory the world below creates, so the
// worktree list is scripted against a placeholder and rewritten per attempt.
const REPO_WORKTREE = "<repo-root>";
// And the scratch runtime root, for the one command a dispatch runs inside the
// run's own copy: the identity write the checkout carries (T35).
const RUNTIME_ROOT = "<runtime-root>";
// How every command the `Git` tag spawns opens: the directory it runs in, and
// the repository it runs against (T27, T32). The guards' own `show-ref` still
// spells `-C` alone — it asks about the host repo, which is a repository by
// the time a dispatch is typed, and `git.ts` is where the discovery walk was
// the defect.
const inRepo = (repo: string): string => `git -C ${repo} --git-dir=${repo}/.git`;
const BASE_SHA = "1111111111111111111111111111111111111111";
const MERGE_BASE_SHA = "2222222222222222222222222222222222222222";
// Where the branch was when this dispatch was typed — the land reads it back
// before its fetch-back moves the ref, and counts this run's commits from it.
const PRE_TIP = "4444444444444444444444444444444444444444";
// And where the run's own copy of the branch stands when the release reads it
// — a different commit from the repo's, because the agent committed in there
// (T27). It is what the containment question the removal is authorized by is
// asked about (T38).
const COPY_TIP = "5555555555555555555555555555555555555555";
const CONTAINER_ID = "d15c0ffee1d";
// What `git rev-parse HEAD` answers inside that container, which is where a
// feature run reads the boundary each issue begins at (T76) — a different
// commit from every SHA the host's git answers with in this file, so a read
// that went to the clone instead could not pass by coincidence.
const ISSUE_BOUNDARY = "8888888888888888888888888888888888888888";
// Another branch's run, hard-killed before this one was typed: the wreckage
// the reconciler meets on preflight (T8). Its pid is above Linux's pid_max, so
// `kill -0` can only answer "no such process".
const WRECK = "speepobox-t7";
const WRECK_CONTAINER = "0ddba11";
const DEAD_PID = 2147483647;

// The tip that run's copy of its branch is on, which the reclaim reads before
// it removes the directory (T38).
const WRECK_TIP = "6666666666666666666666666666666666666666";

// That run's lock and checkout, exactly as its hard exit left them — a real
// clone, `.git/HEAD` and all, because that is what a killed run leaves and it
// is what the containment read below asks about.
const leftByTheDeadRun = (
  runtimeRoot: string,
): Effect.Effect<void, PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(`${runtimeRoot}/${LOCKS_DIRNAME}`, { recursive: true });
    yield* fs.writeFileString(lockPathFor(runtimeRoot, WRECK), `${DEAD_PID}\n`);
    yield* fs.makeDirectory(`${checkoutPathFor(runtimeRoot, WRECK)}/.git`, { recursive: true });
    yield* fs.writeFileString(
      `${checkoutPathFor(runtimeRoot, WRECK)}/.git/HEAD`,
      `ref: refs/heads/${WRECK}\n`,
    );
  });

// A world where every question a dispatch asks answers yes: the branch exists,
// something else is checked out, the base resolves, docker is up, the image is
// present. Each test below breaks exactly one of these.
//
// Every git entry below names the repo it runs against, the reads included
// (T27, T32): the repo a dispatch is for is resolved once and passed down, so
// a command that did not name it would be answering from wherever it found one
// — and in this file the working directory is the checkout vitest was started
// from, never the scratch repo these tests are about.
const happyScript: Record<string, ScriptedResult> = {
  [`${inRepo(REPO_WORKTREE)} show-ref --verify --quiet refs/heads/${BRANCH}`]: { exit: 0 },
  [`${inRepo(REPO_WORKTREE)} worktree list --porcelain`]: {
    exit: 0,
    stdout: `worktree ${REPO_WORKTREE}\nHEAD ${BASE_SHA}\nbranch refs/heads/master\n`,
  },
  // T44's preflight, first and before docker is asked anything: this
  // dispatcher's own package directory holds every commit `origin/master`
  // does — the ordinary state every test below assumes unless it says
  // otherwise. Matched by prefix, ahead of the pathspec: `packagePathspec`
  // renders relative to this test's own scratch repo root, not a fixed path.
  [`${inRepo(REPO_WORKTREE)} rev-list HEAD..origin/master --`]: { exit: 0, stdout: "" },
  [`${inRepo(REPO_WORKTREE)} rev-parse --verify origin/master^{commit}`]: {
    exit: 0,
    stdout: `${BASE_SHA}\n`,
  },
  [`${inRepo(REPO_WORKTREE)} merge-base ${BASE_SHA} refs/heads/${BRANCH}`]: {
    exit: 0,
    stdout: `${MERGE_BASE_SHA}\n`,
  },
  "docker info": { exit: 0 },
  // An image carrying neither of probe 2's labels (T30): the undeclared row,
  // which is `ok` and shows nothing on a preflight — so every warning counted
  // below is the one its own test arranged.
  "docker image inspect": { exit: 0, stdout: "\n" },
  // The third preflight probe (T12): a run ends at a PR, so an unauthenticated
  // `gh` is refused before anything is held.
  "gh auth status": { exit: 0 },
  // And the run's own forge calls, past the push: the branch has no PR yet, so
  // the draft is created and its URL is what `gh` prints.
  "gh pr view": { exit: 1, stderr: "no pull requests found\n" },
  "gh pr create": { exit: 0, stdout: `${PR_URL}\n` },
  // The reconciler's ownership query, on a host holding no wreckage (T8): it
  // runs on every preflight, and a daemon that cannot be asked is a reported
  // degradation rather than silence.
  "docker ps": { exit: 0, stdout: "" },
  // The run's own git commands, past every guard: the clone that makes the
  // checkout, the fetch-back the land does and its release does again, and the
  // push that sends the commits out. They spawn nothing, so the checkout
  // directory never exists here — checkout.test and land.test are where the
  // world afterwards is the assertion.
  [`git clone --no-hardlinks --branch ${BRANCH} ${REPO_WORKTREE}`]: { exit: 0 },
  // The commit identity the clone carries (T35): two values read where the
  // dispatch is for, two written into the run's own copy. The write names the
  // checkout, which is a path under the scratch runtime root — `<runtime-root>`
  // is filled in the way `<repo-root>` is.
  [`${inRepo(REPO_WORKTREE)} config --get user.name`]: { exit: 0, stdout: "Ada Lovelace\n" },
  [`${inRepo(REPO_WORKTREE)} config --get user.email`]: { exit: 0, stdout: "ada@example.com\n" },
  // The dead run's copy, read the same way before the reclaim removes it (T8,
  // T38) — the repo's `merge-base --is-ancestor` below answers for both.
  [`${inRepo(`${RUNTIME_ROOT}/${CHECKOUTS_DIRNAME}/${WRECK}`)} rev-parse --verify refs/heads/${WRECK}`]:
    {
      exit: 0,
      stdout: `${WRECK_TIP}\n`,
    },
  // The copy's own tip, read in the copy, and the repo's answer about whether
  // its branch holds that commit — the read that authorizes the release's `rm
  // -rf` (T38). Ahead of the catch-all below it, which answers every other
  // command run in the checkout.
  [`${inRepo(`${RUNTIME_ROOT}/${CHECKOUTS_DIRNAME}/${BRANCH}`)} rev-parse --verify refs/heads/${BRANCH}`]:
    {
      exit: 0,
      stdout: `${COPY_TIP}\n`,
    },
  // Exit 0 is contained: the fetch-back above really did move the commits, so
  // the branch holds the copy's tip afterwards.
  [`${inRepo(REPO_WORKTREE)} merge-base --is-ancestor`]: { exit: 0 },
  [`git -C ${RUNTIME_ROOT}/${CHECKOUTS_DIRNAME}`]: { exit: 0 },
  [`${inRepo(REPO_WORKTREE)} fetch`]: { exit: 0 },
  [`${inRepo(REPO_WORKTREE)} push`]: { exit: 0 },
  // The land's pre-run tip, and its two counts: what the branch holds past the
  // diff boundary and what this run added past that tip.
  [`${inRepo(REPO_WORKTREE)} rev-parse --verify refs/heads/${BRANCH}`]: {
    exit: 0,
    stdout: `${PRE_TIP}\n`,
  },
  [`${inRepo(REPO_WORKTREE)} rev-list --count ${MERGE_BASE_SHA}..refs/heads/${BRANCH}`]: {
    exit: 0,
    stdout: "3\n",
  },
  [`${inRepo(REPO_WORKTREE)} rev-list --count ${PRE_TIP}..refs/heads/${BRANCH}`]: {
    exit: 0,
    stdout: "2\n",
  },
  // And the run's two docker commands: the sandbox the scope starts inside the
  // checkout, and the removal its finalizer owes. `docker info` and `docker
  // image inspect` above are the preflight's, and are matched first by prefix.
  "docker run": { exit: 0, stdout: `${CONTAINER_ID}\n` },
  "docker rm": { exit: 0 },
  // The one command a feature run runs *inside* the container (T76): the SHA
  // the branch stands at as each issue begins. It answers the same commit
  // every time here — what a case in this file asserts is that the question
  // was asked of docker and never of the clone.
  "docker exec": { exit: 0, stdout: `${ISSUE_BOUNDARY}\n` },
};

// The path the plan's `Spec` arm carries, for the cases whose subject is spec
// *resolution* (T66). A plan on the other arm has no path at all — that is why
// the field left `DispatchPlan` — so the answer here is a string no case
// asserts, rather than a default that would let one pass on the wrong arm.
const specPathOf = (plan: DispatchPlan): string =>
  plan.task._tag === "Spec" ? plan.task.path : "(the task was stated inline)";

interface Attempt {
  readonly outcome: Either.Either<DispatchPlan, { readonly _tag: string; readonly detail: string }>;
  readonly events: ReadonlyArray<ReporterEvent>;
  readonly commands: ReadonlyArray<string>;
  readonly appended: ReadonlyArray<RunRecord>;
  // Every branch `lastBaseForBranch` was asked about. The chain is "this
  // branch's last recorded base", so which branch reaches the ledger — and
  // whether it is asked at all — is the assertion, not the answer alone.
  readonly lastBaseQueries: ReadonlyArray<string>;
  // Every target `resolveResume` was asked about — `--last` is sugar on
  // `--resume`, so *which* target reached the ledger is the assertion.
  readonly resumeTargets: ReadonlyArray<ResumeTarget>;
  // Every (folder, issue) pair the in-progress witness asked the ledger about
  // (T74). Like the scan beside it, *whether it was asked at all* is the
  // assertion: the hint fires under `--issues all` and under nothing else.
  readonly issueWorkQueries: ReadonlyArray<{ readonly feature: string; readonly issue: string }>;
  // Every handle an implement pass ran against — one per run, and the
  // assertion behind "a resume whose spec is gone is single-pass too" (T17).
  readonly passes: ReadonlyArray<SandboxHandle>;
  // Every question the content guards put to `IssueStore` (T73): which repo,
  // which **ref**, and which folder. The ref is the assertion — the set is
  // read at the branch tip and never at `baseSha`.
  readonly issueReads: ReadonlyArray<IssueStoreCall>;
  // Every question the dispatch put to the dispatcher (T102). Empty on every
  // case but a hard reset on a terminal, which is the one dispatch that asks.
  readonly asked: ReadonlyArray<AskedQuestion>;
  readonly runtimeRoot: string;
  readonly repoRoot: string;
}

interface AttemptOptions {
  readonly request?: Partial<DispatchRequest>;
  // Whether this dispatch was typed at a terminal (T84). `false` is every
  // case in this file but the ones about `--feedback-edit`, which is the only
  // flag that asks.
  readonly isTTY?: boolean;
  // What the dispatcher answers, in order (T102). Absent is no answers at all,
  // so a dispatch that asks anything the case did not script dies.
  readonly answers?: ReadonlyArray<ScriptedAnswer>;
  readonly script?: Record<string, ScriptedResult>;
  readonly config?: Partial<SpeepoboxConfigShape>;
  // Files to create under the scratch repo root before dispatching, named the
  // way someone standing anywhere would name them: relative read locations
  // anchor there, not to the working directory and not to the runtime root.
  readonly repoFiles?: ReadonlyArray<string>;
  // The ledger's answer for `lastBaseForBranch`, the `--base` chain's first
  // link. A Left stands in for a ledger that cannot be read at all.
  readonly lastBase?: Either.Either<Option.Option<string>, LedgerError>;
  // The ledger's answer for `resolveResume` (T16). Only the cases that pass
  // `--resume` or `--last` reach it; everything else dies if it does.
  readonly resume?: Either.Either<ResumeResolution, LedgerError>;
  // The ledger's answer for `newestBranchForIssue` (T74), keyed by issue id:
  // where each id was last worked on, if anywhere. An unscripted id is one no
  // row names, which is the ordinary case. A Left stands in for a ledger that
  // cannot be read at all — the hint's waiver, not its refusal.
  readonly workedOn?: Either.Either<Readonly<Record<string, LastWorkedOn>>, LedgerError>;
  // What the composition root resolved before this dispatch was called (T23):
  // `Some` on every case but the one that asserts the refusal, because a host
  // with no credential anywhere is refused at the door.
  readonly credential?: Option.Option<AgentCredential>;
  // What a previous run left under the runtime root before this dispatch was
  // typed: the wreckage the reconciler meets on preflight (T8).
  readonly leaveBehind?: (
    runtimeRoot: string,
  ) => Effect.Effect<void, PlatformError, FileSystem.FileSystem>;
  // What the composition root resolved for the dispatcher's own revision
  // (T43) — `None` by default, the same as every other attempt in this file,
  // since the wiring from this parameter to the appended row is what the one
  // test that sets it exists to prove.
  readonly dispatcherRevision?: Option.Option<Dispatcher>;
  // What the composition root resolved for the repo every `gh` call this run
  // makes will name (T39) — `Some(TEST_FORGE_REPO)` by default, the same as
  // every other attempt in this file, since the refusal is what the one test
  // that sets `Option.none()` exists to prove.
  readonly forgeRepo?: Option.Option<RepoSlug>;
  // Whether the composition root decided this dispatch serves the repo the
  // package lives in (T60) — `true` by default, which is every case in this
  // file but the two that prove the freshness question is not asked when it is
  // `false`.
  readonly selfHosted?: boolean;
  // What the passes do, for the cases whose subject is a pass rather than the
  // dispatch around it (T53): what each one reports it cost, and whether the
  // implement pass fails instead of finishing. `passes` stays the harness's
  // own — every attempt records the handles.
  readonly agent?: Omit<FakeAgentCliOptions, "passes">;
  // What each ref's `<folder>/issues/` holds, for the cases whose subject is
  // the content guards (T73). An unscripted ref carries no folder at all,
  // which is the `FolderAbsent` refusal.
  readonly issues?: FakeIssueStoreOptions;
}

// The dispatch's `Terminal`. What prompts is `Prompt`, scripted per case
// (T102), and the one question a dispatch puts to the terminal is *is anyone
// there* — `--feedback-edit`'s (T84) and `--hard-reset`'s (T102) — so a case scripts `isTTY` and every read dies: a dispatch that
// asked the terminal anything else would fail here rather than behave one way
// on a pipe and another on a desk.
const terminalOf = (isTTY: boolean): Terminal.Terminal => ({
  columns: Effect.succeed(80),
  rows: Effect.succeed(24),
  isTTY: Effect.succeed(isTTY),
  readInput: Effect.die("dispatch never reads the terminal"),
  readLine: Effect.die("dispatch never reads the terminal"),
  display: () => Effect.void,
});

// A scratch runtime root holding a `tasks/T3.md`, wired to the three
// observables SPEC §11 names: the event stream, the argv every subprocess was
// spawned with, and the ledger rows. Both entry points below run against it —
// `dispatch` directly, and the same call through the `@effect/cli` parser.
interface World {
  readonly layer: Layer.Layer<
    | SpeepoboxConfig
    | Ledger
    | RunLock
    | Git
    | IssueStore
    | Sandbox
    | AgentCli
    | Forge
    | Notifier
    | Reporter
    | CommandExecutor.CommandExecutor
    | FileSystem.FileSystem
    | Path.Path
    | Terminal.Terminal
    | Prompt
  >;
  readonly events: Ref.Ref<ReadonlyArray<ReporterEvent>>;
  readonly commands: Ref.Ref<ReadonlyArray<string>>;
  readonly appended: Ref.Ref<ReadonlyArray<RunRecord>>;
  readonly lastBaseQueries: Ref.Ref<ReadonlyArray<string>>;
  readonly resumeTargets: Ref.Ref<ReadonlyArray<ResumeTarget>>;
  readonly issueWorkQueries: Ref.Ref<
    ReadonlyArray<{ readonly feature: string; readonly issue: string }>
  >;
  readonly passes: Ref.Ref<ReadonlyArray<SandboxHandle>>;
  readonly issueReads: Ref.Ref<ReadonlyArray<IssueStoreCall>>;
  readonly asked: Ref.Ref<ReadonlyArray<AskedQuestion>>;
  readonly runtimeRoot: string;
  readonly repoRoot: string;
}

// The worktree list names absolute paths, and the scratch repo root is a temp
// directory only the world knows: a script writes `<repo-root>` and this fills
// it in — in the argv a command is matched by no less than in what it answers,
// since the clone and the fetch-back both name that root — so a test can say
// "checked out here" and "checked out over there" without reaching for the
// filesystem itself.
const scriptFor = (
  script: Record<string, ScriptedResult>,
  repoRoot: string,
  runtimeRoot: string,
): Record<string, ScriptedResult> => {
  const fill = (text: string): string =>
    text.replaceAll(REPO_WORKTREE, repoRoot).replaceAll(RUNTIME_ROOT, runtimeRoot);
  return Object.fromEntries(
    Object.entries(script).map(([prefix, result]) => [
      fill(prefix),
      result.stdout === undefined ? result : { ...result, stdout: fill(result.stdout) },
    ]),
  );
};

const world = (
  options: AttemptOptions,
): Effect.Effect<World, PlatformError, FileSystem.FileSystem | Scope.Scope> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    // Two scratch roots, deliberately different: the runtime root is where the
    // lock, the log, and the checkout are written, and the repo root is where
    // every relative *read* location resolves — a tasks dir under the runtime
    // root would conflate the two (05 Q19).
    const runtimeRoot = yield* fs.makeTempDirectoryScoped();
    const repoRoot = yield* fs.makeTempDirectoryScoped();
    yield* fs.makeDirectory(`${repoRoot}/tasks`);
    yield* fs.writeFileString(`${repoRoot}/tasks/T3.md`, "# T3\n");
    for (const file of options.repoFiles ?? []) {
      yield* fs.makeDirectory(`${repoRoot}/${file}`.replace(/\/[^/]*$/, ""), { recursive: true });
      yield* fs.writeFileString(`${repoRoot}/${file}`, "# elsewhere\n");
    }

    const events = yield* Ref.make<ReadonlyArray<ReporterEvent>>([]);
    const commands = yield* Ref.make<ReadonlyArray<string>>([]);
    const appended = yield* Ref.make<ReadonlyArray<RunRecord>>([]);
    const lastBaseQueries = yield* Ref.make<ReadonlyArray<string>>([]);
    const resumeTargets = yield* Ref.make<ReadonlyArray<ResumeTarget>>([]);
    const issueWorkQueries = yield* Ref.make<
      ReadonlyArray<{ readonly feature: string; readonly issue: string }>
    >([]);
    const passes = yield* Ref.make<ReadonlyArray<SandboxHandle>>([]);
    const issueReads = yield* Ref.make<ReadonlyArray<IssueStoreCall>>([]);
    const asked = yield* Ref.make<ReadonlyArray<AskedQuestion>>([]);

    // `image` and `base` have no code default (T40), so this harness declares
    // them as a repo's config.toml would; `options.config` still overrides.
    // `origin/master` is the ref the git script answers to.
    const config: SpeepoboxConfigShape = {
      ...defaultConfig,
      image: "test-speepobox",
      base: "origin/master",
      runtimeRoot,
      ...options.config,
    };
    const lastBase = options.lastBase ?? Either.right(Option.none<string>());
    const workedOn = options.workedOn ?? Either.right<Readonly<Record<string, LastWorkedOn>>>({});
    const ledger = Layer.succeed(Ledger, {
      append: (record) => Ref.update(appended, (current) => [...current, record]),
      recent: () => Effect.succeed([]),
      resolveResume: (target) =>
        Ref.update(resumeTargets, (current) => [...current, target]).pipe(
          Effect.flatMap(() =>
            Either.match(options.resume ?? Either.left(new LedgerError({ detail: "unasked" })), {
              onLeft: (error) => Effect.fail(error),
              onRight: (value) => Effect.succeed(value),
            }),
          ),
        ),
      lastBaseForBranch: (branch) =>
        Ref.update(lastBaseQueries, (current) => [...current, branch]).pipe(
          Effect.flatMap(() =>
            Either.match(lastBase, {
              onLeft: (error) => Effect.fail(error),
              onRight: (value) => Effect.succeed(value),
            }),
          ),
        ),
      newestBranchForIssue: (query) =>
        Ref.update(issueWorkQueries, (current) => [...current, query]).pipe(
          Effect.flatMap(() =>
            Either.match(workedOn, {
              onLeft: (error) => Effect.fail(error),
              onRight: (answers) => Effect.succeed(Option.fromNullable(answers[query.issue])),
            }),
          ),
        ),
    });

    // The real `RunLock` over the scratch runtime root, wired the way appLiveFor
    // wires it: the lock is what the assertions below look for on disk, so a
    // fake would prove nothing about it.
    const base = Layer.mergeAll(
      NodeFileSystem.layer,
      NodePath.layer,
      scriptedExecutor(scriptFor(options.script ?? happyScript, repoRoot, runtimeRoot), commands),
      Layer.succeed(SpeepoboxConfig, config),
      Layer.succeed(Reporter, {
        emit: (event) => Ref.update(events, (current) => [...current, event]),
      }),
      // Off a TTY unless a case says otherwise, which is what an AFK dispatch
      // is: the one flag that asks (T84) refuses there.
      Layer.succeed(Terminal.Terminal, terminalOf(options.isTTY ?? false)),
      scriptedPrompt(options.answers ?? [], asked),
      ledger,
    );

    return {
      // `SandboxLive`, `GitLive`, and `RunLockLive` merge at the same level
      // over the same base, exactly as appLiveFor composes them. The fake
      // `AgentCli` rides in that merge only because a fake depends on
      // nothing — `appLiveFor` provides `AgentCliLive` *outside* it, since a
      // pass runs through `Sandbox` (T9), and `test/agent-cli.test.ts` is
      // where that ordering is mirrored.
      layer: Layer.provideMerge(
        // `ForgeLive` joins the merge over the same base, exactly as appLiveFor
        // composes it: it needs a `CommandExecutor` and nothing the other
        // three do not already have.
        Layer.mergeAll(
          SandboxLive,
          GitLive,
          RunLockLive,
          ForgeLive,
          fakeNotifier(),
          fakeAgentCli({ passes, ...options.agent }),
          // The issue set the content guards read at the branch tip (T73),
          // scripted per ref rather than spelled out in blobs: what a case is
          // about is what the ref says, and **which** ref was asked is the
          // assertion the recorded calls carry.
          fakeIssueStore(issueReads, options.issues),
        ),
        base,
      ),
      events,
      commands,
      appended,
      lastBaseQueries,
      resumeTargets,
      issueWorkQueries,
      passes,
      issueReads,
      asked,
      runtimeRoot,
      repoRoot,
    };
  });

// One dispatch attempt, returning everything the three observables need.
const attempt = (
  options: AttemptOptions = {},
): Effect.Effect<Attempt, PlatformError, FileSystem.FileSystem | Scope.Scope> =>
  Effect.gen(function* () {
    const scratch = yield* world(options);
    yield* options.leaveBehind?.(scratch.runtimeRoot) ?? Effect.void;
    const outcome = yield* Effect.either(
      dispatch(
        {
          spec: Option.some("T3"),
          branch: Option.some(BRANCH),
          base: Option.none(),
          resume: Option.none(),
          last: false,
          feedback: Option.none(),
          feedbackEdit: false,
          task: Option.none(),
          feature: Option.none(),
          issues: Option.none(),
          allowStaleDispatcher: false,
          hardReset: false,
          keepsLog: true,
          ...options.request,
        },
        scratch.repoRoot,
        options.selfHosted ?? true,
        options.credential ?? Option.some(TEST_CREDENTIAL),
        options.dispatcherRevision ?? Option.none(),
        options.forgeRepo ?? Option.some(TEST_FORGE_REPO),
      ),
    ).pipe(Effect.provide(scratch.layer));

    return {
      outcome,
      events: yield* Ref.get(scratch.events),
      commands: yield* Ref.get(scratch.commands),
      appended: yield* Ref.get(scratch.appended),
      lastBaseQueries: yield* Ref.get(scratch.lastBaseQueries),
      resumeTargets: yield* Ref.get(scratch.resumeTargets),
      issueWorkQueries: yield* Ref.get(scratch.issueWorkQueries),
      passes: yield* Ref.get(scratch.passes),
      issueReads: yield* Ref.get(scratch.issueReads),
      asked: yield* Ref.get(scratch.asked),
      runtimeRoot: scratch.runtimeRoot,
      repoRoot: scratch.repoRoot,
    };
  });

// The same attempt, entered through `@effect/cli` with a real argv, so the
// flag names and the positional are asserted rather than assumed.
const attemptCli = (
  argv: ReadonlyArray<string>,
  options: AttemptOptions = {},
): Effect.Effect<
  {
    readonly outcome: Either.Either<void, DispatchFailure>;
    readonly events: ReadonlyArray<ReporterEvent>;
    readonly resumeTargets: ReadonlyArray<ResumeTarget>;
  },
  PlatformError,
  FileSystem.FileSystem | Scope.Scope
> =>
  Effect.gen(function* () {
    const scratch = yield* world(options);
    const outcome = yield* Effect.either(
      dispatchCli(
        argv,
        scratch.repoRoot,
        true,
        options.credential ?? Option.some(TEST_CREDENTIAL),
        Option.none(),
        Option.some(TEST_FORGE_REPO),
      ),
    ).pipe(Effect.provide(scratch.layer));
    return {
      outcome,
      events: yield* Ref.get(scratch.events),
      resumeTargets: yield* Ref.get(scratch.resumeTargets),
    };
  });

const refusal = (result: Attempt): { readonly _tag: string; readonly detail: string } => {
  expect(Either.isLeft(result.outcome)).toBe(true);
  if (Either.isRight(result.outcome)) {
    throw new Error("expected a refusal, got a plan");
  }
  // Nothing resolved, so nothing was announced: the one event a successful
  // dispatch emits must never reach the renderer on the refusal path.
  expect(result.events.filter((event) => event._tag === "PlanResolved")).toEqual([]);
  return result.outcome.left;
};

// The row-1/row-2 invariant, asserted the only way that means anything: look
// at the world afterwards. Nothing under the runtime root but the tasks dir it
// started with, no ledger row, and no command that could have created state.
//
// The git pattern steps over an opening `-C <repo>` **and the `--git-dir`
// beside it**, because since T27 every git command in the package but `clone`
// carries both: a verb list anchored at `git ` alone, or at `-C <repo>` alone,
// would have kept matching nothing forever, and a write that slipped past a
// guard is exactly what it exists to catch. None of the tag's reads render one
// of these verbs — `branchContains` asks `merge-base --is-ancestor` — so the
// pattern costs no false positive for the tightening.
const heldNothing = (result: Attempt): Effect.Effect<void, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    expect(yield* fs.readDirectory(result.runtimeRoot).pipe(Effect.orDie)).toEqual([]);
    expect(result.appended).toEqual([]);
    for (const command of result.commands) {
      expect(command).not.toMatch(/^docker (run|create|rm|start)\b/);
      // The dispatch's own `git fetch origin` is the one command this list
      // lets through (T70), and it is let through by name rather than by
      // shape: it moves remote-tracking refs, which row 1's *nothing
      // acquired* — no lock, no clone, no container, no row — does not cover.
      // Every other fetch is the land's or the release's, and still a write a
      // refusal may not have made. A refusal from above the fetch records none
      // of either, which is what the ordering case next door asserts.
      if (command === `${inRepo(result.repoRoot)} fetch origin`) {
        continue;
      }
      expect(command).not.toMatch(
        /^git (-C \S+ )?(--git-dir=\S+ )?(clone|fetch|push|branch|checkout|switch|reset)\b/,
      );
    }
  });

// The editor bracket's session directory, asked of the world afterwards (T84): it
// lives under the runtime root and dies with the scope, so a successful run
// leaves the lock, the checkout, and the log directory it always did — and
// nothing of this. A refusal leaves the directory empty outright, which
// `heldNothing` above already says.
const fileGone = (result: Attempt): Effect.Effect<void, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    for (const entry of yield* fs.readDirectory(result.runtimeRoot).pipe(Effect.orDie)) {
      expect(entry).not.toMatch(new RegExp(`^${FEEDBACK_EDIT_PURPOSE}-edit`));
    }
  });

describe("dispatch guards", () => {
  it.scoped("resolves the plan and emits it when every guard passes", () =>
    Effect.gen(function* () {
      const result = yield* attempt();
      expect(Either.isRight(result.outcome)).toBe(true);
      if (Either.isLeft(result.outcome)) {
        return;
      }
      const plan = result.outcome.right;
      expect(plan).toEqual({
        // Its passes are for the spec it resolved, with no dispatcher feedback
        // beside it — `--feedback` was not typed, so there is nothing to
        // append (T17) — and an ordinary dispatch is a one-off over that same
        // path, which is the identity its row records (T66).
        ...specDispatch(`${result.repoRoot}/tasks/T3.md`),
        branch: BRANCH,
        baseRef: "origin/master",
        baseSha: BASE_SHA,
        mergeBaseSha: MERGE_BASE_SHA,
        // The branch's pre-run tip, read in the guard phase and carried on
        // every arm's plan (T73) — the spec arm's included, since the fork
        // commit is a fact of every dispatch and not only a feature one.
        tipSha: PRE_TIP,
        // No `--hard-reset`, so nothing to discard (T101).
        reset: Option.none(),
        slug: BRANCH,
        containerId: `speepobox-${BRANCH}`,
        checkoutPath: checkoutPathFor(result.runtimeRoot, BRANCH),
        logPath: Option.some(logPathFor(result.runtimeRoot, plan.runId)),
        runId: plan.runId,
      });
      // The plan is a Reporter event with the renderer as a subscriber; no
      // command writes to stdout itself. Everything after it is the run's
      // `Scope` reporting itself, which is where the ordering invariant is
      // read from (SPEC §11).
      // The rounds between the two halves are T10's: the fake reviewer never
      // approves, so the run spends the default budget and lands anyway —
      // reaching the cap is not a failure (matrix row 12). The land is T11's,
      // and it happens with all three resources still held: the commits are
      // home and pushed before anything releases. The draft PR is T12's, and
      // it is the last thing the run does — after the push, still inside the
      // scope, because the description that goes in it is one more agent pass
      // in the container.
      expect(result.events).toEqual([
        { _tag: "PlanResolved", plan },
        { _tag: "ResourceAcquired", resource: "lock" },
        { _tag: "ResourceAcquired", resource: "checkout" },
        { _tag: "ResourceAcquired", resource: "sandbox" },
        passFinished("implement"),
        passFinished("review"),
        {
          _tag: "ReviewVerdictReached",
          issue: Option.none(),
          round: { index: 1, of: 3 },
          verdict: "needs-work",
        },
        passFinished("review"),
        {
          _tag: "ReviewVerdictReached",
          issue: Option.none(),
          round: { index: 2, of: 3 },
          verdict: "needs-work",
        },
        passFinished("review"),
        {
          _tag: "ReviewVerdictReached",
          issue: Option.none(),
          round: { index: 3, of: 3 },
          verdict: "needs-work",
        },
        { _tag: "CommitsPushed", thisRun: 2, sinceBoundary: 3, statusCommit: false },
        passFinished("describe-pr"),
        {
          _tag: "PullRequestReady",
          pr: { number: Option.some(PR_NUMBER), url: PR_URL },
          action: "created",
        },
        { _tag: "ResourceReleased", resource: "sandbox" },
        { _tag: "ResourceReleased", resource: "checkout" },
        { _tag: "ResourceReleased", resource: "lock" },
      ]);
      // The whole point of the ticket, in the argv a real `Git` produced: the
      // fetch-back the land does, the push with both ends of the refspec
      // spelled out, and the release's own fetch-back behind them — the
      // salvage every exit path takes, a fast-forward over zero commits here
      // because the land's already succeeded.
      expect(
        result.commands.filter((command) => command.includes("fetch") || command.includes("push")),
      ).toEqual([
        // And ahead of all three, the dispatch's own fetch (T70): the refs the
        // base was resolved against, brought back before anything read one.
        `${inRepo(result.repoRoot)} fetch origin`,
        `${inRepo(result.repoRoot)} fetch ${checkoutPathFor(result.runtimeRoot, BRANCH)} refs/heads/${BRANCH}:refs/heads/${BRANCH}`,
        `${inRepo(result.repoRoot)} push --set-upstream origin refs/heads/${BRANCH}:refs/heads/${BRANCH}`,
        `${inRepo(result.repoRoot)} fetch ${checkoutPathFor(result.runtimeRoot, BRANCH)} refs/heads/${BRANCH}:refs/heads/${BRANCH}`,
      ]);
      // A spec run approves no issue, so it never asks for a status commit
      // (T77) — the store is not asked anything at all.
      expect(result.issueReads).toEqual([]);
      // Past the guards the run opens its scope, so the world afterwards is
      // the lock's directory and the log — and the lock file itself is gone,
      // released with the scope.
      const fs = yield* FileSystem.FileSystem;
      expect((yield* fs.readDirectory(result.runtimeRoot)).toSorted()).toEqual(["locks", "logs"]);
      expect(yield* fs.readDirectory(`${result.runtimeRoot}/locks`)).toEqual([]);
      expect(yield* fs.readFileString(Option.getOrThrow(plan.logPath))).toContain("run start");
      // Exactly one terminal row, because the lock was acquired (SPEC §11).
      expect(result.appended).toHaveLength(1);
      // The row's id is the plan's, read rather than re-derived (T46).
      expect(result.appended[0]?.runId).toEqual(Option.some(plan.runId));
      expect(result.appended[0]?.terminalReason).toEqual(Option.some({ _tag: "Completed" }));
      // Why it stopped and what the review decided, side by side (T10).
      expect(result.appended[0]?.outcome).toEqual(Option.some("needs-work"));
      // And where the work is now readable (T12): number *and* URL, so no
      // reader of this row parses one back out of the other.
      expect(result.appended[0]?.pr).toEqual(
        Option.some({ number: Option.some(PR_NUMBER), url: PR_URL }),
      );
      // The forge calls a real `Forge` produced, in bash's order: view the
      // branch, and create only because nothing is open on it. The body is
      // not in either command line — it went down `gh`'s stdin. Both name the
      // repo the composition root resolved (T39), never wherever `gh` would
      // otherwise fall back to.
      const gh = result.commands.filter((command) => command.startsWith("gh pr"));
      const forgeRepoArg = `${TEST_FORGE_REPO.owner}/${TEST_FORGE_REPO.name}`;
      expect(gh).toEqual([
        `gh pr view ${BRANCH} --repo ${forgeRepoArg} --json number,state,url,title,body`,
        `gh pr create --repo ${forgeRepoArg} --draft --base master --head ${BRANCH} --title [speepobox] ${BRANCH} --body-file -`,
      ]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // T43: the dispatcher revision resolved at the composition root reaches
  // the appended row unchanged — the wiring `dispatch` → `runInScope` →
  // `recordTerminal` is what every other attempt's `Option.none()` cannot
  // exercise.
  it.scoped("carries the composition root's dispatcher revision onto the appended row", () =>
    Effect.gen(function* () {
      const dispatcherRevision: Option.Option<Dispatcher> = Option.some({
        revision: "6345f52",
        dirty: true,
      });
      const result = yield* attempt({ dispatcherRevision });
      expect(result.appended[0]?.dispatcher).toEqual(dispatcherRevision);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // T53: what the run cost reaches the row the way every other recorded fact
  // does — off the event stream, summed over the passes that reported a
  // figure. The four counts stay apart in the row; only `status` adds them.
  it.scoped("sums what every pass reported onto the row, models deduplicated", () =>
    Effect.gen(function* () {
      const result = yield* attempt({
        agent: {
          verdicts: ["approved"],
          usage: {
            implement: {
              ...ZERO_PASS_USAGE,
              input: 164,
              output: 38_700,
              cacheWrite: 132_393,
              cacheRead: 8_067_677,
              models: ["claude-opus-5", "claude-haiku-4-5-20251001"],
            },
            // The same model on the second pass, and one it did not touch on
            // the first: the union is what keeps the row from listing a model
            // once per pass, and one pass really can name several.
            review: {
              ...ZERO_PASS_USAGE,
              input: 36,
              output: 1_300,
              cacheWrite: 7_607,
              cacheRead: 132_323,
              models: ["claude-opus-5"],
            },
          },
        },
      });
      expect(Either.isRight(result.outcome)).toBe(true);
      const row = result.appended[0];
      // Each count is its own sum, and nothing on the row holds their total:
      // a row whose 8.2M is 98% cache read is a different run from one that
      // wrote 8.2M tokens, and only four fields can say so.
      expect(row?.tokensIn).toEqual(Option.some(200));
      expect(row?.tokensOut).toEqual(Option.some(40_000));
      expect(row?.cacheWrite).toEqual(Option.some(140_000));
      expect(row?.cacheRead).toEqual(Option.some(8_200_000));
      // The two passes that reported a figure. The describe-pr pass ran as
      // well and reported none, which is not the same as reporting zero.
      expect(row?.passes).toEqual(Option.some(2));
      expect(row?.models).toEqual(Option.some(["claude-opus-5", "claude-haiku-4-5-20251001"]));
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // The killed pass (matrix rows 8-10): the run failed with nothing to
  // report, so the row carries none of the six. Zeros here would price the
  // run as free, and unmeasured is not free.
  it.scoped("writes none of the six when the run's only pass was killed", () =>
    Effect.gen(function* () {
      const result = yield* attempt({
        agent: {
          implementFails: new AgentPassFailed({
            reason: "timed-out",
            detail: "implement pass exceeded its 20m budget",
          }),
        },
      });
      expect(Either.isLeft(result.outcome)).toBe(true);
      const row = result.appended[0];
      expect(row?.terminalReason).toEqual(Option.some({ _tag: "Failed", stage: "implement" }));
      expect(row?.tokensIn).toEqual(Option.none());
      expect(row?.tokensOut).toEqual(Option.none());
      expect(row?.cacheWrite).toEqual(Option.none());
      expect(row?.cacheRead).toEqual(Option.none());
      expect(row?.passes).toEqual(Option.none());
      expect(row?.models).toEqual(Option.none());
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // And the expensive failure (T55): a pass whose stream carried an error
  // `result` reported what it spent on the way there, so it counts — the run
  // still failed, and what it burned failing is exactly what a dispatcher
  // wants off the row.
  it.scoped("counts a failed pass that reported what it spent", () =>
    Effect.gen(function* () {
      const result = yield* attempt({
        agent: {
          implementFails: new AgentPassFailed({
            reason: "exited",
            detail: "the implement pass ended with an error result",
          }),
          usage: {
            implement: {
              ...ZERO_PASS_USAGE,
              input: 120,
              output: 900,
              cacheWrite: 4_000,
              cacheRead: 61_000,
              models: ["claude-opus-5"],
            },
          },
        },
      });
      expect(Either.isLeft(result.outcome)).toBe(true);
      const row = result.appended[0];
      expect(row?.passes).toEqual(Option.some(1));
      expect(row?.tokensIn).toEqual(Option.some(120));
      expect(row?.tokensOut).toEqual(Option.some(900));
      expect(row?.cacheWrite).toEqual(Option.some(4_000));
      expect(row?.cacheRead).toEqual(Option.some(61_000));
      expect(row?.models).toEqual(Option.some(["claude-opus-5"]));
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // T27's tracer, in the only form the fake tier can hold it: a dispatch
  // launched from outside the repo behaves like one launched from the repo
  // root exactly when no command's answer depends on where it was launched
  // from, and that is a fact about argv. Every git child a whole dispatch
  // spawns — the guards' reads, the land's four calls, the release's fetch —
  // opens with `-C <repoRoot>`, and the tag's own also name the repository
  // there rather than discovering one (T32); `clone` is the one exception, and
  // it names both of its ends rather than a repo to run in. The repo root here
  // is a scratch temp directory, never the checkout vitest was started from,
  // so a call that dropped the repo would land in this list unprefixed.
  it.scoped("names the repo in every git command a dispatch runs, reads included", () =>
    Effect.gen(function* () {
      const result = yield* attempt();
      expect(Either.isRight(result.outcome)).toBe(true);

      const gitCommands = result.commands.filter((command) => command.startsWith("git "));
      // The reads specifically, so this cannot pass on the writes alone.
      expect(
        gitCommands.filter((command) =>
          /\b(show-ref|worktree|rev-parse|merge-base|rev-list)\b/.test(command),
        ),
      ).toEqual([
        `${inRepo(result.repoRoot)} show-ref --verify --quiet refs/heads/${BRANCH}`,
        `${inRepo(result.repoRoot)} worktree list --porcelain`,
        `${inRepo(result.repoRoot)} rev-list HEAD..origin/master -- ${packagePathspec(result.repoRoot).join(" ")}`,
        `${inRepo(result.repoRoot)} rev-parse --verify origin/master^{commit}`,
        `${inRepo(result.repoRoot)} merge-base ${BASE_SHA} refs/heads/${BRANCH}`,
        // The content phase's tip read (T73), in the guard phase and therefore
        // above the lock — and the land's own, below it. Two reads of one ref
        // and deliberately not one: the plan's is taken before anything is
        // held, and the land's is taken under the lock, immediately before the
        // fetch that moves the ref out from under it.
        `${inRepo(result.repoRoot)} rev-parse --verify refs/heads/${BRANCH}`,
        // Whether the branch contains its remote (T106) — absent here, so
        // nothing past the read is asked.
        `${inRepo(result.repoRoot)} rev-parse --verify refs/remotes/origin/${BRANCH}`,
        `${inRepo(result.repoRoot)} rev-parse --verify refs/heads/${BRANCH}`,
        // Whether the branch was checked out mid-run (T148), before the
        // land's fetch into it.
        `${inRepo(result.repoRoot)} worktree list --porcelain`,
        `${inRepo(result.repoRoot)} rev-list --count ${MERGE_BASE_SHA}..refs/heads/${BRANCH}`,
        `${inRepo(result.repoRoot)} rev-list --count ${PRE_TIP}..refs/heads/${BRANCH}`,
        // The release's salvage asks whether the branch is there before it
        // fetches onto it (T107), in the repo the fetch would write to — and
        // whether it is checked out there (T148).
        `${inRepo(result.repoRoot)} rev-parse --verify refs/heads/${BRANCH}`,
        `${inRepo(result.repoRoot)} worktree list --porcelain`,
        // The release's containment read, which names *two* repositories for
        // one question (T38): the tip in the copy the commits are in, the
        // ancestry in the repo whose branch has to hold them before the copy
        // can be removed.
        `${inRepo(checkoutPathFor(result.runtimeRoot, BRANCH))} rev-parse --verify refs/heads/${BRANCH}`,
        `${inRepo(result.repoRoot)} merge-base --is-ancestor ${COPY_TIP} refs/heads/${BRANCH}`,
      ]);
      // The identity write is the one command that names a repository other
      // than this one, and it names it for the same reason (T35): it acts on
      // the run's own copy, so that is the repo it opens with. `clone` remains
      // the only command naming no repo to run in.
      const checkout = Either.isRight(result.outcome) ? result.outcome.right.checkoutPath : "";
      for (const command of gitCommands) {
        if (command.startsWith("git clone ")) {
          continue;
        }
        expect(
          command.startsWith(`git -C ${result.repoRoot} `) ||
            command.startsWith(`git -C ${checkout} `),
        ).toBe(true);
      }
      // And what a dispatch writes into that copy is exactly the two identity
      // keys, taken from this repo's config and written clone-local.
      expect(gitCommands.filter((command) => command.startsWith(`git -C ${checkout} `))).toEqual([
        `${inRepo(checkout)} config --local user.name Ada Lovelace`,
        `${inRepo(checkout)} config --local user.email ada@example.com`,
        // The one read of the copy, and the reason T27's rule covers reads:
        // the tip the removal's authorization is about is the *copy's*, and a
        // read that discovered a repository would answer with the host's.
        `${inRepo(checkout)} rev-parse --verify refs/heads/${BRANCH}`,
      ]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped("refuses a missing --branch", () =>
    Effect.gen(function* () {
      const result = yield* attempt({ request: { branch: Option.none() } });
      expect(refusal(result)._tag).toBe("GuardRefused");
      expect(refusal(result).detail).toContain("--branch is required");
      yield* heldNothing(result);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped("refuses a branch that does not exist", () =>
    Effect.gen(function* () {
      const script = { ...happyScript };
      delete script[`${inRepo(REPO_WORKTREE)} show-ref --verify --quiet refs/heads/${BRANCH}`];
      const result = yield* attempt({
        script: { ...script, [`${inRepo(REPO_WORKTREE)} show-ref`]: { exit: 1 } },
      });
      expect(refusal(result)._tag).toBe("GuardRefused");
      expect(refusal(result).detail).toContain("doesn't exist");
      yield* heldNothing(result);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped("refuses master and main", () =>
    Effect.gen(function* () {
      for (const branch of ["master", "main"]) {
        const result = yield* attempt({
          request: { branch: Option.some(branch) },
          script: { ...happyScript, [`${inRepo(REPO_WORKTREE)} show-ref`]: { exit: 0 } },
        });
        expect(refusal(result)._tag).toBe("GuardRefused");
        expect(refusal(result).detail).toContain("protected branches are PR targets");
        yield* heldNothing(result);
      }
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped("refuses the branch that is currently checked out", () =>
    Effect.gen(function* () {
      const result = yield* attempt({
        script: {
          ...happyScript,
          [`${inRepo(REPO_WORKTREE)} worktree list --porcelain`]: {
            exit: 0,
            stdout: `worktree ${REPO_WORKTREE}\nHEAD ${BASE_SHA}\nbranch refs/heads/${BRANCH}\n`,
          },
        },
      });
      expect(refusal(result)._tag).toBe("GuardRefused");
      expect(refusal(result).detail).toContain("is checked out in this repo");
      yield* heldNothing(result);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // The hole bash still has (`run.sh:983-985`): `symbolic-ref HEAD` sees only
  // the current worktree, so a branch checked out in a linked one waved
  // through here and died at the docker probe. It refuses up front now, naming
  // the branch and the worktree holding it, and holds nothing doing it.
  it.scoped("refuses a branch checked out in another worktree, naming that worktree", () =>
    Effect.gen(function* () {
      const result = yield* attempt({
        script: {
          ...happyScript,
          [`${inRepo(REPO_WORKTREE)} worktree list --porcelain`]: {
            exit: 0,
            stdout: [
              `worktree ${REPO_WORKTREE}`,
              `HEAD ${BASE_SHA}`,
              "branch refs/heads/master",
              "",
              "worktree /tmp/wt-demo",
              `HEAD ${MERGE_BASE_SHA}`,
              `branch refs/heads/${BRANCH}`,
              "",
            ].join("\n"),
          },
        },
      });
      expect(refusal(result)._tag).toBe("GuardRefused");
      expect(refusal(result).detail).toContain(`'${BRANCH}' is checked out in the worktree at`);
      expect(refusal(result).detail).toContain("/tmp/wt-demo");
      // Before preflight, which is the point: no docker command ran at all.
      expect(result.commands.some((command) => command.startsWith("docker"))).toBe(false);
      yield* heldNothing(result);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // A detached worktree has no branch line, and a second one holding some
  // other branch is not this branch's problem.
  it.scoped("lets a dispatch through when no worktree holds the branch", () =>
    Effect.gen(function* () {
      const result = yield* attempt({
        script: {
          ...happyScript,
          [`${inRepo(REPO_WORKTREE)} worktree list --porcelain`]: {
            exit: 0,
            stdout: [
              `worktree ${REPO_WORKTREE}`,
              `HEAD ${BASE_SHA}`,
              "detached",
              "",
              "worktree /tmp/wt-other",
              `HEAD ${MERGE_BASE_SHA}`,
              "branch refs/heads/speepobox-t4",
              "",
            ].join("\n"),
          },
        },
      });
      expect(Either.isRight(result.outcome)).toBe(true);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // The other half of the guard owning the refusal shape: a `GitError` from
  // the tag is folded into a `GuardRefused` rather than escaping as the
  // run-time failure matrix row 1 forbids. Dropping the entry makes the
  // scripted executor behave like a missing binary.
  it.scoped("refuses, holding nothing, when the worktree list cannot be read", () =>
    Effect.gen(function* () {
      const result = yield* attempt({
        script: Object.fromEntries(
          Object.entries(happyScript).filter(
            ([prefix]) => prefix !== `${inRepo(REPO_WORKTREE)} worktree list --porcelain`,
          ),
        ),
      });
      expect(refusal(result)._tag).toBe("GuardRefused");
      expect(refusal(result).detail).toContain("could not read this repo's worktrees");
      expect(refusal(result).detail).toContain("git CLI not found");
      yield* heldNothing(result);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped("refuses a base that names the branch, with or without the origin/ prefix", () =>
    Effect.gen(function* () {
      for (const base of [BRANCH, `origin/${BRANCH}`]) {
        const result = yield* attempt({ request: { base: Option.some(base) } });
        expect(refusal(result)._tag).toBe("GuardRefused");
        expect(refusal(result).detail).toContain("the PR would target itself");
        yield* heldNothing(result);
      }
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped("refuses a spec that does not resolve", () =>
    Effect.gen(function* () {
      const result = yield* attempt({ request: { spec: Option.some("T99") } });
      expect(refusal(result)._tag).toBe("GuardRefused");
      expect(refusal(result).detail).toContain("spec not found");
      expect(refusal(result).detail).toContain("tasks/T99.md");
      yield* heldNothing(result);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped("refuses a --base that resolves to no commit", () =>
    Effect.gen(function* () {
      const script = { ...happyScript };
      delete script[`${inRepo(REPO_WORKTREE)} rev-parse --verify origin/master^{commit}`];
      const result = yield* attempt({
        script: { ...script, [`${inRepo(REPO_WORKTREE)} rev-parse --verify`]: { exit: 1 } },
      });
      expect(refusal(result)._tag).toBe("GuardRefused");
      // The advice is what is true after T70: the fetch already happened, so
      // there is nothing left for the dispatcher to fetch and the ref they
      // named is the only thing left to fix.
      expect(refusal(result).detail).toBe(
        "--base 'origin/master' does not resolve to a commit after fetching origin — pass a ref that exists",
      );
      yield* heldNothing(result);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped("refuses a branch that shares no history with the base", () =>
    Effect.gen(function* () {
      const script = { ...happyScript };
      delete script[`${inRepo(REPO_WORKTREE)} merge-base ${BASE_SHA} refs/heads/${BRANCH}`];
      const result = yield* attempt({
        script: { ...script, [`${inRepo(REPO_WORKTREE)} merge-base`]: { exit: 1 } },
      });
      expect(refusal(result)._tag).toBe("GuardRefused");
      expect(refusal(result).detail).toContain("share no history");
      yield* heldNothing(result);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped("takes a spec path containing a slash as-is, .md appended", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const elsewhere = yield* fs.makeTempDirectoryScoped();
      yield* fs.writeFileString(`${elsewhere}/plan.md`, "# elsewhere\n");
      const result = yield* attempt({
        request: { spec: Option.some(`${elsewhere}/plan`) },
        // Nothing under the tasks dir could satisfy this — the slash is what
        // takes it out of the tasks dir's reach.
        config: { tasksDir: "/nowhere" },
      });
      expect(Either.isRight(result.outcome)).toBe(true);
      if (Either.isRight(result.outcome)) {
        expect(specPathOf(result.outcome.right)).toBe(`${elsewhere}/plan.md`);
      }
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped("anchors a relative spec path to the repo root, not the working directory", () =>
    Effect.gen(function* () {
      // Named the way someone standing in the repo would name it. The plan is
      // what T18-T6 mount and T15 prints, so it may not depend on which form was
      // typed or on which directory it was typed from — which is what bash gets
      // by `cd`-ing to the repo root first (run.sh:235-236).
      const result = yield* attempt({
        repoFiles: ["docs/plan.md"],
        request: { spec: Option.some("docs/plan") },
        // Nothing under the tasks dir could satisfy this — the slash is what
        // takes it out of the tasks dir's reach.
        config: { tasksDir: "/nowhere" },
      });
      expect(Either.isRight(result.outcome)).toBe(true);
      if (Either.isRight(result.outcome)) {
        expect(specPathOf(result.outcome.right)).toBe(`${result.repoRoot}/docs/plan.md`);
      }
      // The two anchors really are different here, so landing on the repo
      // root's copy is evidence rather than a coincidence.
      expect(result.repoRoot).not.toBe(process.cwd());
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
});

// T70: every dispatch fetches `origin` once, and it does it in one place —
// after the last local guard, before anything that reads a remote-tracking
// ref. The three assertions are the same fact from three sides: that it
// happens, where it happens, and what a dispatch refused above it did not do.
// What a hard reset said, asked, and did (T102): the warnings it emitted, the
// confirms it put to the dispatcher, and whether the branch was moved.
const warningsOf = (result: Attempt): ReadonlyArray<string> =>
  result.events.flatMap((event) => (event._tag === "Warned" ? [event.detail] : []));
const confirms = (result: Attempt): ReadonlyArray<string> =>
  result.asked.filter((question) => question.kind === "confirm").map((q) => q.message);
const resetMoved = (result: Attempt): boolean =>
  result.commands.some((command) => command.includes(" update-ref refs/heads/"));

// `--hard-reset` (T101): the guard phase decides the reset — what origin holds
// now, and what the reset and the leased push discard between them — and
// everything below it receives the base as the tip and the boundary.
const ORIGIN_TIP = "9999999999999999999999999999999999999999";
const ORIGIN_READ = `${inRepo(REPO_WORKTREE)} rev-parse --verify refs/remotes/origin/${BRANCH}`;
// What a reset run asks past the guards: the compare-and-set, and the
// land's count from the base rather than from the merge-base.
const resetRun: Record<string, ScriptedResult> = {
  [`${inRepo(REPO_WORKTREE)} update-ref`]: { exit: 0 },
  [`${inRepo(REPO_WORKTREE)} rev-list --count ${BASE_SHA}..refs/heads/${BRANCH}`]: {
    exit: 0,
    stdout: "1\n",
  },
};
// A reset dispatch whose origin has the branch — the T103 cases below reuse it.
const withOrigin: Record<string, ScriptedResult> = {
  ...happyScript,
  ...resetRun,
  [ORIGIN_READ]: { exit: 0, stdout: `${ORIGIN_TIP}\n` },
  [`${inRepo(REPO_WORKTREE)} rev-list --count ^${BASE_SHA} ${PRE_TIP} ${ORIGIN_TIP}`]: {
    exit: 0,
    stdout: "4\n",
  },
};

describe("--hard-reset", () => {
  const withoutOrigin: Record<string, ScriptedResult> = {
    ...happyScript,
    ...resetRun,
    [ORIGIN_READ]: { exit: 128, stderr: "fatal: Needed a single revision\n" },
    [`${inRepo(REPO_WORKTREE)} rev-list --count ^${BASE_SHA} ${PRE_TIP}`]: {
      exit: 0,
      stdout: "2\n",
    },
  };

  it.scoped("plans from the base, carrying the tip it discards and what origin held", () =>
    Effect.gen(function* () {
      const result = yield* attempt({ request: { hardReset: true }, script: withOrigin });
      expect(Either.isRight(result.outcome)).toBe(true);
      if (Either.isLeft(result.outcome)) {
        return;
      }
      const plan = result.outcome.right;
      expect(plan.tipSha).toBe(BASE_SHA);
      expect(plan.mergeBaseSha).toBe(BASE_SHA);
      expect(plan.reset).toEqual(
        Option.some({ discardedTip: PRE_TIP, discarding: 4, originTip: Option.some(ORIGIN_TIP) }),
      );
      // No merge-base is asked about a boundary the reset makes the base.
      expect(result.commands.some((command) => command.includes(` merge-base ${BASE_SHA} `))).toBe(
        false,
      );
      const repoGit = inRepo(result.repoRoot);
      // One union count, over both tips — never two counts added together.
      expect(result.commands.filter((command) => command.includes("rev-list --count ^"))).toEqual([
        `${repoGit} rev-list --count ^${BASE_SHA} ${PRE_TIP} ${ORIGIN_TIP}`,
      ]);
      // And the run itself: the branch moved to the base expecting the tip the
      // guards read, and the push leased on where origin stood.
      expect(result.commands).toContain(
        `${repoGit} update-ref refs/heads/${BRANCH} ${BASE_SHA} ${PRE_TIP}`,
      );
      expect(result.commands).toContain(
        `${repoGit} push --set-upstream --force-with-lease=refs/heads/${BRANCH}:${ORIGIN_TIP} origin refs/heads/${BRANCH}:refs/heads/${BRANCH}`,
      );
      expect(result.events).toContainEqual({
        _tag: "BranchReset",
        branch: BRANCH,
        from: PRE_TIP,
        originTip: Option.some(ORIGIN_TIP),
        to: BASE_SHA,
        discarding: 4,
      });
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // An origin read that fails is **absent**, the safe direction: the lease
  // then expects no remote branch, and the count is the local tip's alone.
  it.scoped("counts the local tip alone and leases on absence when origin has no branch", () =>
    Effect.gen(function* () {
      const result = yield* attempt({ request: { hardReset: true }, script: withoutOrigin });
      expect(Either.isRight(result.outcome)).toBe(true);
      if (Either.isLeft(result.outcome)) {
        return;
      }
      expect(result.outcome.right.reset).toEqual(
        Option.some({ discardedTip: PRE_TIP, discarding: 2, originTip: Option.none() }),
      );
      const repoGit = inRepo(result.repoRoot);
      expect(result.commands).toContain(`${repoGit} rev-list --count ^${BASE_SHA} ${PRE_TIP}`);
      expect(result.commands).toContain(
        `${repoGit} push --set-upstream --force-with-lease=refs/heads/${BRANCH}: origin refs/heads/${BRANCH}:refs/heads/${BRANCH}`,
      );
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped("parses --hard-reset off a real argv", () =>
    Effect.gen(function* () {
      const result = yield* attemptCli(["T3", "--branch", BRANCH, "--hard-reset"], {
        script: withOrigin,
      });
      expect(Either.isRight(result.outcome)).toBe(true);
      // The discard line first (T102), then the plan it was about.
      const [warned, event] = result.events;
      expect(warned?._tag).toBe("Warned");
      expect(event?._tag).toBe("PlanResolved");
      if (event?._tag === "PlanResolved") {
        expect(Option.isSome(event.plan.reset)).toBe(true);
        expect(renderPlan(event.plan)).toContain(
          `  fork point:    hard reset to origin/master — discards 4 commit(s) on '${BRANCH}' and origin/${BRANCH}`,
        );
      }
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // Without the flag nothing of this is asked: no union count, no move of the
  // branch, and the push's argv is today's. The origin read that remains is
  // T106's containment check, which every other dispatch makes.
  it.scoped("asks nothing of it and changes nothing without the flag", () =>
    Effect.gen(function* () {
      const result = yield* attempt();
      expect(Either.isRight(result.outcome)).toBe(true);
      if (Either.isRight(result.outcome)) {
        expect(result.outcome.right.reset).toEqual(Option.none());
        expect(result.outcome.right.tipSha).toBe(PRE_TIP);
        expect(result.outcome.right.mergeBaseSha).toBe(MERGE_BASE_SHA);
      }
      for (const command of result.commands) {
        expect(command).not.toContain("rev-list --count ^");
        expect(command).not.toContain("update-ref");
        expect(command).not.toContain("--force-with-lease");
      }
      expect(result.events.some((event) => event._tag === "BranchReset")).toBe(false);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // D5: a resume continues the work a hard reset discards. Decided from the
  // command line alone, ahead of the ledger.
  it.scoped("is refused beside --resume and --last, holding nothing", () =>
    Effect.gen(function* () {
      const named = yield* attempt({
        request: { hardReset: true, spec: Option.none(), resume: Option.some(BRANCH) },
      });
      expect(refusal(named)._tag).toBe("GuardRefused");
      expect(refusal(named).detail).toBe(
        "--hard-reset and --resume pull opposite ways — a resume continues the work a branch's record holds, and a hard reset discards it; pick one",
      );
      yield* heldNothing(named);
      const last = yield* attempt({
        request: { hardReset: true, spec: Option.none(), last: true },
      });
      expect(refusal(last).detail).toContain("--hard-reset and --last pull opposite ways");
      yield* heldNothing(last);
      expect([...named.resumeTargets, ...last.resumeTargets]).toEqual([]);
      expect([...named.commands, ...last.commands]).toEqual([]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // T102: what the discard costs is said on every run with something to
  // discard, and asked about on a terminal alone.
  const DISCARD_LINE = `--hard-reset: DISCARDING 4 commit(s) on '${BRANCH}' — recoverable from the reflog only`;
  const CONFIRM = `Discard 4 commit(s) on '${BRANCH}' and reset it to the base?`;

  it.scoped("on a terminal, says what it discards, asks, and proceeds on yes", () =>
    Effect.gen(function* () {
      const result = yield* attempt({
        request: { hardReset: true },
        script: withOrigin,
        isTTY: true,
        answers: [true],
      });
      expect(Either.isRight(result.outcome)).toBe(true);
      expect(warningsOf(result)).toEqual([DISCARD_LINE]);
      expect(confirms(result)).toEqual([CONFIRM]);
      expect(resetMoved(result)).toBe(true);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // A declined confirm is matrix row 1's "declined confirm": refused before
  // the reconciler, holding nothing and having written nothing but the fetch.
  it.scoped("on a terminal, is refused holding nothing when the answer is no", () =>
    Effect.gen(function* () {
      const result = yield* attempt({
        request: { hardReset: true },
        script: withOrigin,
        isTTY: true,
        answers: [false],
      });
      expect(refusal(result)).toEqual(
        new GuardRefused({ detail: `--hard-reset aborted — '${BRANCH}' was not touched` }),
      );
      expect(confirms(result)).toEqual([CONFIRM]);
      yield* heldNothing(result);
      expect(resetMoved(result)).toBe(false);
      expect(result.commands.some((command) => command.startsWith("docker ps"))).toBe(false);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // Esc and Ctrl-C are one sentinel (13), and it is a no.
  it.scoped("on a terminal, is refused the same way when the confirm is cancelled", () =>
    Effect.gen(function* () {
      const result = yield* attempt({
        request: { hardReset: true },
        script: withOrigin,
        isTTY: true,
        answers: [CANCEL],
      });
      expect(refusal(result).detail).toBe(`--hard-reset aborted — '${BRANCH}' was not touched`);
      yield* heldNothing(result);
      expect(resetMoved(result)).toBe(false);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // D3: off a terminal the flag is the consent. The line still says what it
  // cost; no answer is scripted, so a question would die.
  it.scoped("off a terminal, says what it discards and proceeds without asking", () =>
    Effect.gen(function* () {
      const result = yield* attempt({ request: { hardReset: true }, script: withOrigin });
      expect(Either.isRight(result.outcome)).toBe(true);
      expect(warningsOf(result)).toEqual([DISCARD_LINE]);
      expect(result.asked).toEqual([]);
      expect(resetMoved(result)).toBe(true);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped(
    "with --no-input on a terminal, says what it discards and proceeds without asking",
    () =>
      Effect.gen(function* () {
        const result = yield* attempt({
          request: { hardReset: true, noInput: true },
          script: withOrigin,
          isTTY: true,
        });
        expect(Either.isRight(result.outcome)).toBe(true);
        expect(warningsOf(result)).toEqual([DISCARD_LINE]);
        expect(result.asked).toEqual([]);
      }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // bash's `-gt 0`: nothing to discard is nothing to say.
  it.scoped("with nothing to discard, neither warns nor asks", () =>
    Effect.gen(function* () {
      const result = yield* attempt({
        request: { hardReset: true },
        script: {
          ...withOrigin,
          [`${inRepo(REPO_WORKTREE)} rev-list --count ^${BASE_SHA} ${PRE_TIP} ${ORIGIN_TIP}`]: {
            exit: 0,
            stdout: "0\n",
          },
        },
        isTTY: true,
      });
      expect(Either.isRight(result.outcome)).toBe(true);
      expect(warningsOf(result)).toEqual([]);
      expect(result.asked).toEqual([]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // T101's union count: a local branch level with the base has nothing of its
  // own to lose, but the leased push overwrites what origin holds — so it
  // asks, where bash would have asked nothing.
  it.scoped("asks about the origin-only commits of a branch level with the base", () =>
    Effect.gen(function* () {
      const result = yield* attempt({
        request: { hardReset: true },
        script: {
          ...withOrigin,
          [`${inRepo(REPO_WORKTREE)} rev-parse --verify refs/heads/${BRANCH}`]: {
            exit: 0,
            stdout: `${BASE_SHA}\n`,
          },
          [`${inRepo(REPO_WORKTREE)} rev-list --count ^${BASE_SHA} ${BASE_SHA} ${ORIGIN_TIP}`]: {
            exit: 0,
            stdout: "2\n",
          },
        },
        isTTY: true,
        answers: [true],
      });
      expect(Either.isRight(result.outcome)).toBe(true);
      expect(result.commands).toContain(
        `${inRepo(result.repoRoot)} rev-list --count ^${BASE_SHA} ${BASE_SHA} ${ORIGIN_TIP}`,
      );
      expect(warningsOf(result)).toEqual([
        `--hard-reset: DISCARDING 2 commit(s) on '${BRANCH}' — recoverable from the reflog only`,
      ]);
      expect(confirms(result)).toEqual([
        `Discard 2 commit(s) on '${BRANCH}' and reset it to the base?`,
      ]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
});

// T106: every dispatch but `--hard-reset` refuses a branch that does not
// contain `origin/<b>`, after the fetch and before anything is held. The
// case's own entries come **first**, because the executor takes the earliest
// matching prefix and `happyScript`'s `merge-base --is-ancestor` answers
// every ancestry question with yes.
describe("a branch and its remote", () => {
  const ORIGIN_HOLDS = `${inRepo(REPO_WORKTREE)} merge-base --is-ancestor ${ORIGIN_TIP} refs/heads/${BRANCH}`;
  const BEHIND_COUNT = `${inRepo(REPO_WORKTREE)} rev-list --count ${PRE_TIP}..${ORIGIN_TIP}`;
  const AHEAD_COUNT = `${inRepo(REPO_WORKTREE)} rev-list --count ${ORIGIN_TIP}..${PRE_TIP}`;
  const originAt = (
    contained: ScriptedResult,
    counts: { readonly behind: number; readonly ahead: number } = { behind: 0, ahead: 0 },
  ): Record<string, ScriptedResult> => ({
    [ORIGIN_READ]: { exit: 0, stdout: `${ORIGIN_TIP}\n` },
    [ORIGIN_HOLDS]: contained,
    [BEHIND_COUNT]: { exit: 0, stdout: `${counts.behind}\n` },
    [AHEAD_COUNT]: { exit: 0, stdout: `${counts.ahead}\n` },
    ...happyScript,
  });
  const behind = originAt({ exit: 1 }, { behind: 3, ahead: 0 });
  const diverged = originAt({ exit: 1 }, { behind: 2, ahead: 1 });
  const asked = (result: Attempt, command: string): boolean =>
    result.commands.includes(command.replaceAll(REPO_WORKTREE, result.repoRoot));

  it("says behind with the fast-forward and the reset, each named for what it does", () => {
    expect(branchBehindItsRemote(BRANCH, 3)).toBe(
      `'${BRANCH}' is 3 behind origin/${BRANCH}. To take origin's commits: git branch -f ${BRANCH} origin/${BRANCH}. To discard them: --hard-reset.`,
    );
  });

  it("says diverged with both counts and the reset, and never the fast-forward", () => {
    const sentence = branchDivergedFromItsRemote(BRANCH, 1, 2);
    expect(sentence).toContain("1 commit(s) only here");
    expect(sentence).toContain("2 only on origin");
    expect(sentence).toContain("--hard-reset");
    expect(sentence).not.toContain("branch -f");
  });

  // `happyScript` scripts no origin read, so every other case in this file
  // is this one: the read fails, absent passes, and nothing past it is asked.
  it.scoped("passes when origin has no such branch", () =>
    Effect.gen(function* () {
      const result = yield* attempt();
      expect(Either.isRight(result.outcome)).toBe(true);
      expect(asked(result, ORIGIN_READ)).toBe(true);
      expect(asked(result, ORIGIN_HOLDS)).toBe(false);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // Equal tips and local ahead are one answer to the one question git is
  // asked: origin's tip is an ancestor of the branch, so the push goes
  // forward, and nothing is counted.
  it.scoped("passes when the branch contains origin's tip — equal or ahead", () =>
    Effect.gen(function* () {
      const result = yield* attempt({ script: originAt({ exit: 0 }) });
      expect(Either.isRight(result.outcome)).toBe(true);
      expect(asked(result, ORIGIN_HOLDS)).toBe(true);
      expect(asked(result, BEHIND_COUNT)).toBe(false);
      expect(asked(result, AHEAD_COUNT)).toBe(false);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped("refuses a branch behind its remote, holding nothing", () =>
    Effect.gen(function* () {
      const result = yield* attempt({ script: behind });
      expect(refusal(result)).toEqual(
        new GuardRefused({ detail: branchBehindItsRemote(BRANCH, 3) }),
      );
      yield* heldNothing(result);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped("refuses a diverged branch naming both counts, and no branch -f", () =>
    Effect.gen(function* () {
      const result = yield* attempt({ script: diverged });
      expect(refusal(result)).toEqual(
        new GuardRefused({ detail: branchDivergedFromItsRemote(BRANCH, 1, 2) }),
      );
      expect(refusal(result).detail).not.toContain("branch -f");
      yield* heldNothing(result);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // Skipped by construction, not run and ignored: the reset discards both
  // sides, and its union count already says how much (T101).
  it.scoped("is not asked under --hard-reset", () =>
    Effect.gen(function* () {
      const result = yield* attempt({
        request: { hardReset: true },
        script: { ...behind, ...withOrigin },
      });
      expect(Either.isRight(result.outcome)).toBe(true);
      expect(asked(result, ORIGIN_HOLDS)).toBe(false);
      expect(asked(result, BEHIND_COUNT)).toBe(false);
      expect(asked(result, AHEAD_COUNT)).toBe(false);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // A check that could not be made is not a clean sheet (T72).
  it.scoped("refuses with git's words when the ancestry cannot be asked", () =>
    Effect.gen(function* () {
      const result = yield* attempt({
        script: originAt({ exit: 128, stderr: "fatal: bad object 9999999\n" }),
      });
      const { detail } = refusal(result);
      expect(detail).toContain(`could not tell whether '${BRANCH}' contains origin/${BRANCH}`);
      expect(detail).toContain("fatal: bad object 9999999");
      yield* heldNothing(result);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped("refuses a resume of a branch behind its remote", () =>
    Effect.gen(function* () {
      const result = yield* attempt({
        request: {
          spec: Option.none(),
          branch: Option.none(),
          resume: Option.some(BRANCH),
        },
        resume: Either.right({
          _tag: "Resumable",
          branch: BRANCH,
          identity: { _tag: "OneOff", spec: "T3" },
          resumedRunId: Option.none(),
          base: Option.none(),
        }),
        script: behind,
      });
      expect(refusal(result).detail).toBe(branchBehindItsRemote(BRANCH, 3));
      yield* heldNothing(result);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
});

// The discard count's three shapes, against a real repository (T101): git
// takes the union, which a script can only restate. The shared history of a
// pushed branch and its remote is the ordinary case, and it is counted once.
describe("the hard reset's discard count, against a real repository", () => {
  const HAND = ["-c", "user.email=t@example.com", "-c", "user.name=Test"];

  // A base commit, then `b` with two commits both ends share. Each case moves
  // one end past the shared history and says where origin's copy stands by
  // writing the remote-tracking ref by hand — which is what a fetch leaves.
  const repoWith = (shape: "ahead" | "behind" | "no-origin") =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const repo = yield* fs.makeTempDirectoryScoped();
      const git = (...args: ReadonlyArray<string>) =>
        exec("git", "-C", repo, ...HAND, ...args).pipe(
          Effect.map((result) => result.stdout.trim()),
        );
      const commit = (message: string) => git("commit", "-q", "--allow-empty", "-m", message);
      yield* exec("git", "init", "-q", "-b", "master", repo);
      yield* commit("base");
      const base = yield* git("rev-parse", "HEAD");
      yield* git("checkout", "-q", "-b", BRANCH);
      yield* commit("shared 1");
      yield* commit("shared 2");
      const shared = yield* git("rev-parse", "HEAD");
      if (shape === "ahead") {
        yield* git("update-ref", `refs/remotes/origin/${BRANCH}`, shared);
        yield* commit("local only");
      }
      if (shape === "behind") {
        yield* commit("origin only");
        yield* git("update-ref", `refs/remotes/origin/${BRANCH}`, "HEAD");
        yield* git("reset", "-q", "--hard", shared);
      }
      const tip = yield* git("rev-parse", "HEAD");
      return { repo, base, tip };
    }).pipe(Effect.orDie);

  const discarding = (shape: "ahead" | "behind" | "no-origin") =>
    Effect.gen(function* () {
      const { repo, base, tip } = yield* repoWith(shape);
      return yield* hardResetDecided({
        repoRoot: repo,
        branch: BRANCH,
        baseSha: base,
        tipSha: tip,
      });
    });

  it.scoped("counts a branch ahead of origin once over their shared history", () =>
    Effect.gen(function* () {
      const reset = yield* discarding("ahead");
      // Two shared and one local — not 3 + 2.
      expect(reset.discarding).toBe(3);
      expect(Option.isSome(reset.originTip)).toBe(true);
    }).pipe(Effect.provide(Layer.provideMerge(GitLive, NodeContext.layer))),
  );

  it.scoped("counts the commits only origin has when the branch is behind it", () =>
    Effect.gen(function* () {
      const reset = yield* discarding("behind");
      // `base..tip` alone would say 2 and the leased push would destroy a third.
      expect(reset.discarding).toBe(3);
    }).pipe(Effect.provide(Layer.provideMerge(GitLive, NodeContext.layer))),
  );

  it.scoped("counts the local tip alone when origin has no such branch", () =>
    Effect.gen(function* () {
      const reset = yield* discarding("no-origin");
      expect(reset.discarding).toBe(2);
      expect(reset.originTip).toEqual(Option.none());
    }).pipe(Effect.provide(Layer.provideMerge(GitLive, NodeContext.layer))),
  );
});

describe("the dispatch's fetch", () => {
  it.scoped(
    "fetches origin once, after the local guards and before every read of a remote ref",
    () =>
      Effect.gen(function* () {
        const result = yield* attempt();
        expect(Either.isRight(result.outcome)).toBe(true);

        const fetched = `${inRepo(result.repoRoot)} fetch origin`;
        // Once. A second one would be a second answer to what `origin` holds,
        // and the base is resolved from exactly one of them.
        expect(result.commands.filter((command) => command === fetched)).toEqual([fetched]);

        // And its position, spelled as the neighbours rather than as an index:
        // the last local guard's own git call is the worktree list, and the two
        // reads that follow are the preflight's freshness range and the
        // authoritative base resolve — both of which name `origin/master`, and
        // both of which would otherwise answer off whatever a hand-run fetch
        // last left behind.
        const gitCommands = result.commands.filter((command) => command.startsWith("git "));
        expect(gitCommands.indexOf(fetched)).toBeGreaterThan(
          gitCommands.indexOf(`${inRepo(result.repoRoot)} worktree list --porcelain`),
        );
        expect(gitCommands.indexOf(fetched)).toBeLessThan(
          gitCommands.indexOf(
            `${inRepo(result.repoRoot)} rev-list HEAD..origin/master -- ${packagePathspec(result.repoRoot).join(" ")}`,
          ),
        );
        expect(gitCommands.indexOf(fetched)).toBeLessThan(
          gitCommands.indexOf(
            `${inRepo(result.repoRoot)} rev-parse --verify origin/master^{commit}`,
          ),
        );
      }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // The other half of the placement, and the reason it is not simply first:
  // a typo'd `--branch` costs no network round trip (`run.sh`'s
  // cheap-local-validation-first invariant, 15).
  it.scoped("costs no round trip when a local guard refuses first", () =>
    Effect.gen(function* () {
      const script = { ...happyScript };
      delete script[`${inRepo(REPO_WORKTREE)} show-ref --verify --quiet refs/heads/${BRANCH}`];
      const result = yield* attempt({
        request: { branch: Option.some("bessmer-t3") },
        script: { ...script, [`${inRepo(REPO_WORKTREE)} show-ref`]: { exit: 1 } },
      });
      expect(refusal(result)._tag).toBe("GuardRefused");
      expect(refusal(result).detail).toContain("doesn't exist");
      expect(result.commands.filter((command) => command.includes("fetch"))).toEqual([]);
      yield* heldNothing(result);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // No network, no `origin`, a refused credential: one refusal, in git's own
  // words, because only git can tell the three repairs apart. It is a
  // `GuardRefused` and not a `GitError` for every guard's reason — nothing is
  // held — so the run leaves no lock, no log, and no ledger row behind.
  it.scoped("refuses in git's words when the fetch cannot run, holding nothing", () =>
    Effect.gen(function* () {
      // The happy script answers every fetch at once, so the entry that
      // covers this one goes and the failing one takes its place: the
      // land's and the release's are never reached, because this refuses
      // above the lock.
      const script = { ...happyScript };
      delete script[`${inRepo(REPO_WORKTREE)} fetch`];
      const result = yield* attempt({
        script: {
          ...script,
          [`${inRepo(REPO_WORKTREE)} fetch origin`]: {
            exit: 128,
            stderr: "fatal: unable to access 'origin': Could not resolve host: github.com\n",
          },
        },
      });
      expect(refusal(result)._tag).toBe("GuardRefused");
      expect(refusal(result).detail).toContain("could not fetch 'origin'");
      expect(refusal(result).detail).toContain("Could not resolve host: github.com");
      // Refused before the preflight, which is the placement said as a
      // consequence: a host that cannot reach its remote is not asked about
      // its daemon.
      expect(result.commands.filter((command) => command.startsWith("docker"))).toEqual([]);
      yield* heldNothing(result);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
});

describe("the @effect/cli surface", () => {
  // The other end of "the picker's product is argv" (T81): the words
  // `argvFor` builds are handed to this parser, and they resolve the run they
  // name. A `DispatchRequest` built in the picker would typecheck and would
  // never pass through here — which is the whole of why the picker does not
  // build one.
  it.scoped("dispatches the words the picker hands it, as if they were typed", () =>
    Effect.gen(function* () {
      const result = yield* attemptCli(argvFor("T3", BRANCH, []));

      expect(Either.isRight(result.outcome)).toBe(true);
      const [event] = result.events;
      expect(event?._tag).toBe("PlanResolved");
      if (event?._tag === "PlanResolved") {
        expect(event.plan.branch).toBe(BRANCH);
        expect(specPathOf(event.plan)).toMatch(/tasks\/T3\.md$/);
      }
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped("parses the positional spec, --branch, and --base into the same dispatch", () =>
    Effect.gen(function* () {
      const result = yield* attemptCli(["T3", "--branch", BRANCH, "--base", "origin/release"], {
        script: {
          ...happyScript,
          [`${inRepo(REPO_WORKTREE)} rev-list HEAD..origin/release --`]: { exit: 0, stdout: "" },
          [`${inRepo(REPO_WORKTREE)} rev-parse --verify origin/release^{commit}`]: {
            exit: 0,
            stdout: `${BASE_SHA}\n`,
          },
        },
      });
      expect(Either.isRight(result.outcome)).toBe(true);
      const [event] = result.events;
      expect(event?._tag).toBe("PlanResolved");
      if (event?._tag === "PlanResolved") {
        expect(event.plan.branch).toBe(BRANCH);
        expect(event.plan.baseRef).toBe("origin/release");
        expect(specPathOf(event.plan)).toMatch(/tasks\/T3\.md$/);
      }
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // The two flags a feature dispatch is named with (T73), asserted through a
  // real argv rather than assumed: the spellings are what a dispatcher types,
  // and the `--repo-root` peel has to know both of them take a value
  // (`served-repo.ts`, kept honest by its own test next door).
  it.scoped("parses --feature and --issues into the same dispatch", () =>
    Effect.gen(function* () {
      const result = yield* attemptCli(["--branch", BRANCH, "--feature", "f", "--issues", "T70"], {
        issues: { sets: { [PRE_TIP]: [fakeIssue("T70")] } },
      });
      const [event] = result.events;
      expect(event?._tag).toBe("PlanResolved");
      if (event?._tag === "PlanResolved") {
        expect(event.plan.task).toMatchObject({
          _tag: "Feature",
          folder: "tasks/f",
          selection: { request: { _tag: "Enumerated", ids: ["T70"] } },
        });
      }
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // T83's end of the same rule: a feature picked in the wizard is the two
  // flags, and `--dry-run` rides through behind them. The picked words and
  // the typed ones resolve one plan — mode `feature`, the set read at the tip
  // — and end the same way, because they are the same dispatch.
  it.scoped("dispatches a picked feature exactly as its typed flags", () =>
    Effect.gen(function* () {
      const issues = { sets: { [PRE_TIP]: [fakeIssue("T70")] } };
      const picked = yield* attemptCli(
        argvFor({ folder: "f", issues: ALL_READY }, BRANCH, ["--dry-run"]),
        { issues },
      );
      const typed = yield* attemptCli(
        ["--feature", "f", "--issues", "all", "--branch", BRANCH, "--dry-run"],
        { issues },
      );

      expect(picked.outcome._tag).toBe(typed.outcome._tag);
      expect(picked.events.map((event) => event._tag)).toEqual(
        typed.events.map((event) => event._tag),
      );
      const [event] = picked.events;
      expect(event?._tag).toBe("PlanResolved");
      if (event?._tag === "PlanResolved") {
        expect(renderPlan(event.plan).split("\n")[1]).toBe("  mode:          feature");
        expect(event.plan.task).toMatchObject({
          _tag: "Feature",
          folder: "tasks/f",
          selection: { request: { _tag: "All" } },
        });
      }
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // The parser could enforce `--branch` itself; it deliberately does not, so
  // all six refusals arrive with one shape and one exit path (AGENTS.md).
  it.scoped("leaves a missing --branch to the guard rather than the parser", () =>
    Effect.gen(function* () {
      const result = yield* attemptCli(["T3"]);
      expect(Either.isLeft(result.outcome)).toBe(true);
      if (Either.isLeft(result.outcome)) {
        expect(result.outcome.left._tag).toBe("GuardRefused");
        expect(Option.getOrNull(renderFailure(result.outcome.left))).toContain(
          "!! --branch is required",
        );
      }
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
});

describe("the --base default chain", () => {
  it.scoped("uses the ledger's last recorded base for this branch", () =>
    Effect.gen(function* () {
      const result = yield* attempt({
        lastBase: Either.right(Option.some("origin/release")),
        script: {
          ...happyScript,
          [`${inRepo(REPO_WORKTREE)} rev-parse --verify origin/release^{commit}`]: {
            exit: 0,
            stdout: `${BASE_SHA}\n`,
          },
        },
      });
      expect(Either.isRight(result.outcome)).toBe(true);
      if (Either.isRight(result.outcome)) {
        expect(result.outcome.right.baseRef).toBe("origin/release");
      }
      // *This* branch's last base: the branch is what reaches the ledger, and
      // it is asked once.
      expect(result.lastBaseQueries).toEqual([BRANCH]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped("never consults the ledger when --base is given explicitly", () =>
    Effect.gen(function* () {
      const result = yield* attempt({
        request: { base: Option.some("origin/release") },
        lastBase: Either.right(Option.some("origin/stale")),
        script: {
          ...happyScript,
          [`${inRepo(REPO_WORKTREE)} rev-parse --verify origin/release^{commit}`]: {
            exit: 0,
            stdout: `${BASE_SHA}\n`,
          },
        },
      });
      expect(Either.isRight(result.outcome)).toBe(true);
      if (Either.isRight(result.outcome)) {
        expect(result.outcome.right.baseRef).toBe("origin/release");
      }
      expect(result.lastBaseQueries).toEqual([]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped("degrades to the configured fallback when the ledger cannot be read", () =>
    Effect.gen(function* () {
      const result = yield* attempt({
        lastBase: Either.left(new LedgerError({ detail: "runs.jsonl: EACCES" })),
      });
      expect(Either.isRight(result.outcome)).toBe(true);
      if (Either.isRight(result.outcome)) {
        expect(result.outcome.right.baseRef).toBe("origin/master");
      }
      expect(result.lastBaseQueries).toEqual([BRANCH]);
      // Degraded, and said so — never a failed run (SPEC §10).
      expect(result.events.filter((event) => event._tag === "Warned")).toHaveLength(1);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
});

// The tracer (T16): re-dispatch a branch with nothing but `--resume`. No spec
// argument, no `--base` — both come back off the ledger — and the run proceeds
// exactly as the original did, recording a `FeedbackResume` row wrapping what
// it resumed.
describe("--resume and --last", () => {
  // What the ledger recorded for the run being resumed: a one-off over a spec
  // that still resolves, on a base that is not the configured default, from a
  // run that had an id.
  const RECORDED: ResumeResolution = {
    _tag: "Resumable",
    branch: BRANCH,
    identity: { _tag: "OneOff", spec: "T3" },
    resumedRunId: Option.some("speepobox-t3-1786000000000"),
    base: Option.some("origin/release"),
  };

  const resumeScript = {
    ...happyScript,
    [`${inRepo(REPO_WORKTREE)} rev-parse --verify origin/release^{commit}`]: {
      exit: 0,
      stdout: `${BASE_SHA}\n`,
    },
  };

  // Nothing on the command line but the flag: no positional spec, no
  // `--branch`, no `--base`.
  const resumeRequest = {
    spec: Option.none<string>(),
    branch: Option.none<string>(),
    base: Option.none<string>(),
    resume: Option.some(BRANCH),
  };

  it.scoped("recovers the spec, the branch, and the base off the newest record", () =>
    Effect.gen(function* () {
      const result = yield* attempt({
        request: resumeRequest,
        resume: Either.right(RECORDED),
        script: resumeScript,
      });
      expect(Either.isRight(result.outcome)).toBe(true);
      if (Either.isRight(result.outcome)) {
        expect(specPathOf(result.outcome.right)).toBe(`${result.repoRoot}/tasks/T3.md`);
        expect(result.outcome.right.branch).toBe(BRANCH);
        expect(result.outcome.right.baseRef).toBe("origin/release");
      }
      expect(result.resumeTargets).toEqual([{ _tag: "Branch", branch: BRANCH }]);
      // The base came off the resumed record, so the default chain was never
      // consulted.
      expect(result.lastBaseQueries).toEqual([]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped("records a FeedbackResume wrapping the identity it resumed", () =>
    Effect.gen(function* () {
      const result = yield* attempt({
        request: resumeRequest,
        resume: Either.right(RECORDED),
        script: resumeScript,
      });
      expect(result.appended.length).toBe(1);
      expect(result.appended[0]?.identity).toEqual({
        _tag: "FeedbackResume",
        resumed: { _tag: "OneOff", spec: "T3" },
        resumedRunId: Option.some("speepobox-t3-1786000000000"),
      });
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // Repeated resumes compose because the ledger hands back the *dispatch*
  // identity: resuming a run that was itself a resume wraps the original
  // one-off again rather than a chain of wrappers.
  it.scoped("wraps the original one-off again when the resumed run was itself a resume", () =>
    Effect.gen(function* () {
      const result = yield* attempt({
        request: resumeRequest,
        resume: Either.right({ ...RECORDED, resumedRunId: Option.some("speepobox-t3-2") }),
        script: resumeScript,
      });
      expect(result.appended[0]?.identity).toEqual({
        _tag: "FeedbackResume",
        resumed: { _tag: "OneOff", spec: "T3" },
        resumedRunId: Option.some("speepobox-t3-2"),
      });
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped("records no resumed run id when the run it resumed predates them", () =>
    Effect.gen(function* () {
      const result = yield* attempt({
        request: resumeRequest,
        resume: Either.right({ ...RECORDED, resumedRunId: Option.none() }),
        script: resumeScript,
      });
      const identity = result.appended[0]?.identity;
      expect(identity?._tag).toBe("FeedbackResume");
      if (identity?._tag === "FeedbackResume") {
        // Absent, never synthesized.
        expect(identity.resumedRunId).toEqual(Option.none());
      }
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // A record short of a base is a degradation expressed as data, so the resume
  // falls through to the same `--base` default chain a fresh dispatch takes.
  it.scoped("falls back to the --base chain when the resumed record carried no base", () =>
    Effect.gen(function* () {
      const result = yield* attempt({
        request: resumeRequest,
        resume: Either.right({ ...RECORDED, base: Option.none() }),
      });
      expect(Either.isRight(result.outcome)).toBe(true);
      if (Either.isRight(result.outcome)) {
        expect(result.outcome.right.baseRef).toBe("origin/master");
      }
      expect(result.lastBaseQueries).toEqual([BRANCH]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped("refuses a branch with no ledger record, naming the ones it knows", () =>
    Effect.gen(function* () {
      const result = yield* attempt({
        request: { ...resumeRequest, resume: Option.some("never-dispatched") },
        resume: Either.right({ _tag: "NoRecord", knownBranches: [BRANCH, WRECK] }),
      });
      expect(refusal(result)._tag).toBe("GuardRefused");
      expect(refusal(result).detail).toContain("no ledger record for branch 'never-dispatched'");
      expect(refusal(result).detail).toContain(`  ${BRANCH}`);
      // Matrix row 1: nothing held, no row written.
      yield* heldNothing(result);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped("refuses when the resumed spec is no longer on disk", () =>
    Effect.gen(function* () {
      const result = yield* attempt({
        request: resumeRequest,
        resume: Either.right({ ...RECORDED, identity: { _tag: "OneOff", spec: "T99" } }),
      });
      expect(refusal(result)._tag).toBe("GuardRefused");
      expect(refusal(result).detail).toContain("the resumed spec is no longer on disk: T99");
      yield* heldNothing(result);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // T3's guards still all run: a resume recovers the inputs, it does not
  // excuse them.
  it.scoped("runs the ordinary guards on the branch it recovered", () =>
    Effect.gen(function* () {
      const result = yield* attempt({
        request: resumeRequest,
        resume: Either.right({ ...RECORDED, branch: "master" }),
        script: {
          ...resumeScript,
          [`${inRepo(REPO_WORKTREE)} show-ref --verify --quiet refs/heads/master`]: { exit: 0 },
        },
      });
      expect(refusal(result).detail).toContain("refusing 'master' as --branch");
      yield* heldNothing(result);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped("parses --resume with no spec argument and no --base", () =>
    Effect.gen(function* () {
      const result = yield* attemptCli(["--resume", BRANCH], {
        resume: Either.right(RECORDED),
        script: resumeScript,
      });
      expect(Either.isRight(result.outcome)).toBe(true);
      expect(result.resumeTargets).toEqual([{ _tag: "Branch", branch: BRANCH }]);
      const [event] = result.events;
      if (event?._tag === "PlanResolved") {
        expect(event.plan.branch).toBe(BRANCH);
        expect(event.plan.baseRef).toBe("origin/release");
        expect(specPathOf(event.plan)).toMatch(/tasks\/T3\.md$/);
      }
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // Sugar, not a second path: the flag changes which target the one query
  // takes, and everything below it is the same dispatch.
  it.scoped("--last asks the ledger for the most recent branch, on the same path", () =>
    Effect.gen(function* () {
      const result = yield* attemptCli(["--last"], {
        resume: Either.right(RECORDED),
        script: resumeScript,
      });
      expect(Either.isRight(result.outcome)).toBe(true);
      expect(result.resumeTargets).toEqual([{ _tag: "Last" }]);
      const [event] = result.events;
      if (event?._tag === "PlanResolved") {
        expect(event.plan.branch).toBe(BRANCH);
      }
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped("refuses --last on an empty ledger, holding nothing", () =>
    Effect.gen(function* () {
      const result = yield* attempt({
        request: { ...resumeRequest, resume: Option.none(), last: true },
        resume: Either.right({ _tag: "NoRecord", knownBranches: [] }),
      });
      expect(refusal(result).detail).toContain("no runs recorded yet");
      expect(result.resumeTargets).toEqual([{ _tag: "Last" }]);
      yield* heldNothing(result);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // The ledger degrades resume the way it degrades `status` and the `--base`
  // chain: one line, nothing held, and no `Cause` dump.
  it.scoped("refuses when the ledger cannot be read at all", () =>
    Effect.gen(function* () {
      const result = yield* attempt({
        request: resumeRequest,
        resume: Either.left(new LedgerError({ detail: "runs.jsonl: EACCES" })),
      });
      expect(refusal(result)._tag).toBe("GuardRefused");
      expect(refusal(result).detail).toContain("the ledger could not be read");
      yield* heldNothing(result);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // The positional is optional so a resume can leave it out; a dispatch that
  // named neither is still a refusal with row 1's one shape, not a parser
  // error with another.
  it.scoped("refuses a dispatch that names neither a spec nor a resume", () =>
    Effect.gen(function* () {
      const result = yield* attempt({ request: { spec: Option.none() } });
      expect(refusal(result)._tag).toBe("GuardRefused");
      expect(refusal(result).detail).toContain(
        'a task is required — pass <spec>, --task "…", --feature <folder> --issues …, or --resume <branch>',
      );
      yield* heldNothing(result);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
});

// The other half of feedback-resume (T17): the flag that carries the
// dispatcher's instructions, and the run a resume takes when its recorded spec
// is gone and the feedback is all there is to go on.
describe("--feedback", () => {
  // Every character a shell would act on. The assertion is that none of them
  // is a shell's business: the text reaches the plan as typed and never
  // becomes a word of any command line.
  const HOSTILE = 'drop the `$(uname)` call; keep "quotes" and $HOME literal';

  it.scoped("carries the dispatcher's words onto the plan every pass reads", () =>
    Effect.gen(function* () {
      const result = yield* attempt({ request: { feedback: Option.some(HOSTILE) } });
      expect(Either.isRight(result.outcome)).toBe(true);
      if (Either.isRight(result.outcome)) {
        expect(result.outcome.right.task).toEqual({
          _tag: "Spec",
          path: `${result.repoRoot}/tasks/T3.md`,
          feedback: Option.some(HOSTILE),
        });
      }
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // The parser hands the text through untouched, and the run never spells it
  // into argv: it rides the stdin prompt pipe (T9), which is what makes the
  // property above hold end to end.
  it.scoped("parses --feedback and keeps it out of every command line", () =>
    Effect.gen(function* () {
      const scratch = yield* world({});
      const outcome = yield* Effect.either(
        dispatchCli(
          ["T3", "--branch", BRANCH, "--feedback", HOSTILE],
          scratch.repoRoot,
          true,
          Option.some(TEST_CREDENTIAL),
          Option.none(),
          Option.some(TEST_FORGE_REPO),
        ),
      ).pipe(Effect.provide(scratch.layer));

      expect(Either.isRight(outcome)).toBe(true);
      const [event] = yield* Ref.get(scratch.events);
      if (event?._tag === "PlanResolved") {
        expect(event.plan.task).toEqual({
          _tag: "Spec",
          path: `${scratch.repoRoot}/tasks/T3.md`,
          feedback: Option.some(HOSTILE),
        });
      }
      for (const command of yield* Ref.get(scratch.commands)) {
        expect(command).not.toContain("uname");
        expect(command).not.toContain("--feedback");
      }
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // **The tracer** (T17, move-out gate 2): a PR the tool opened, iterated with
  // one command and no manual step. The spec still resolves, so this is the
  // ordinary resume — with the dispatcher's instructions riding along.
  it.scoped("rides an ordinary resume, with the instructions appended to it", () =>
    Effect.gen(function* () {
      const result = yield* attempt({
        request: {
          spec: Option.none(),
          branch: Option.none(),
          base: Option.none(),
          resume: Option.some(BRANCH),
          feedback: Option.some(HOSTILE),
        },
        resume: Either.right({
          _tag: "Resumable",
          branch: BRANCH,
          identity: { _tag: "OneOff", spec: "T3" },
          resumedRunId: Option.some("speepobox-t3-1786000000000"),
          base: Option.none(),
        }),
      });

      expect(Either.isRight(result.outcome)).toBe(true);
      if (Either.isRight(result.outcome)) {
        const plan = result.outcome.right;
        // Still the spec's run — feedback steers it, it does not replace it.
        expect(specPathOf(plan)).toBe(`${result.repoRoot}/tasks/T3.md`);
        expect(plan.task).toEqual({
          _tag: "Spec",
          path: `${result.repoRoot}/tasks/T3.md`,
          feedback: Option.some(HOSTILE),
        });
      }
      // And the row carries the identity forward, as any resume does.
      expect(result.appended[0]?.identity).toEqual({
        _tag: "FeedbackResume",
        resumed: { _tag: "OneOff", spec: "T3" },
        resumedRunId: Option.some("speepobox-t3-1786000000000"),
      });
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped("reads a blank --feedback as nothing said", () =>
    Effect.gen(function* () {
      const result = yield* attempt({ request: { feedback: Option.some("   \n") } });
      expect(Either.isRight(result.outcome)).toBe(true);
      if (Either.isRight(result.outcome)) {
        expect(result.outcome.right.task).toEqual(
          specDispatch(`${result.repoRoot}/tasks/T3.md`).task,
        );
      }
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
});

// `--feedback-edit` (T84): the same value as `--feedback`, written in the
// dispatcher's own editor. What this block asserts is the four ends the
// bracket can have and the state each one leaves — and, on every one of them,
// that the temp file is gone.
describe("--feedback-edit", () => {
  const TEXT = "use the smaller diff";
  // What `git var GIT_EDITOR` answers in this world. The bracket spawns it
  // through `sh -c`, as git does, so the scripted entry matches on `sh`.
  const EDITOR = "fake-editor";

  // An editor that appends `lines` to the file it was handed — the last word
  // of its argv — and exits with `exit`. Scripted this way rather than as a
  // fixed path because the runtime root is a temp directory the world makes:
  // what is asserted is that the bracket handed its file over, not that a
  // fixture guessed where it would be.
  const editorWriting = (
    lines: ReadonlyArray<string>,
    exit = 0,
  ): Record<string, ScriptedResult> => ({
    [`${inRepo(REPO_WORKTREE)} var GIT_EDITOR`]: { exit: 0, stdout: `${EDITOR}\n` },
    "sh -c": {
      exit,
      onSpawn: (args) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const file = args[args.length - 1] ?? "";
          const prefilled = yield* fs.readFileString(file);
          yield* fs.writeFileString(file, `${prefilled}${lines.join("\n")}\n`);
        }).pipe(Effect.provide(NodeFileSystem.layer), Effect.orDie),
    },
  });

  const edited = (
    lines: ReadonlyArray<string>,
    exit = 0,
    options: AttemptOptions = {},
  ): Effect.Effect<Attempt, PlatformError, FileSystem.FileSystem | Scope.Scope> =>
    attempt({
      isTTY: true,
      script: { ...editorWriting(lines, exit), ...happyScript },
      ...options,
      request: { feedbackEdit: true, ...options.request },
    });

  it.scoped("dispatches what the dispatcher wrote, and leaves no temp file", () =>
    Effect.gen(function* () {
      const result = yield* edited(["# their own comment", "", TEXT]);

      expect(Either.isRight(result.outcome)).toBe(true);
      if (Either.isRight(result.outcome)) {
        // The plan's feedback is exactly `--feedback`'s would have been: the
        // header is stripped, the dispatcher's own `#` line with it, and what
        // is left is trimmed.
        expect(result.outcome.right.task).toEqual({
          _tag: "Spec",
          path: `${result.repoRoot}/tasks/T3.md`,
          feedback: Option.some(TEXT),
        });
      }
      // The editor was git's answer, asked in the repo this dispatch serves,
      // and it was invoked as git invokes it — shell text with the file as
      // `"$1"`, so an editor carrying its own arguments arrives whole.
      expect(result.commands).toContain(`${inRepo(result.repoRoot)} var GIT_EDITOR`);
      expect(result.commands).toContainEqual(
        expect.stringMatching(
          editorInvocationUnder(EDITOR, result.runtimeRoot, FEEDBACK_EDIT_PURPOSE),
        ),
      );
      yield* fileGone(result);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // Git's rule for an empty commit message, and bash's for this flag: stop
  // loudly rather than run an agent on no instructions because an editor
  // closed wrong. It refuses where `--feedback`'s value is read, so nothing
  // has been claimed — matrix row 1, asserted by looking at the world.
  it.scoped("refuses an editor that left nothing but the header", () =>
    Effect.gen(function* () {
      const result = yield* edited([]);

      expect(refusal(result)._tag).toBe("GuardRefused");
      expect(refusal(result).detail).toBe(
        "--feedback-edit: empty feedback — aborted before any container started",
      );
      // And the whole of what this dispatch spawned, listed rather than
      // sampled: the editor lookup and the editor, and **not the fetch**.
      // `heldNothing` below lets `git fetch origin` through by name (T70), so
      // it is the one thing it cannot say — and "above the fetch" is exactly
      // what buys a dispatcher who quits the editor a host nothing has been
      // done to.
      expect(result.commands).toEqual([
        `${inRepo(result.repoRoot)} var GIT_EDITOR`,
        expect.stringMatching(
          editorInvocationUnder(EDITOR, result.runtimeRoot, FEEDBACK_EDIT_PURPOSE),
        ),
      ]);
      yield* heldNothing(result);
      yield* fileGone(result);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped("refuses an editor that exited nonzero, whatever it left behind", () =>
    Effect.gen(function* () {
      const result = yield* edited([TEXT], 1);

      expect(refusal(result).detail).toContain("--feedback-edit: the editor exited 1");
      yield* heldNothing(result);
      yield* fileGone(result);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // Off a TTY there is nobody to drive an editor, and the refusal comes
  // **before any git call** — the editor lookup included, which is the first
  // thing the bracket would have done.
  it.scoped("refuses a dispatch that is not on a terminal, before it asks git anything", () =>
    Effect.gen(function* () {
      const result = yield* edited([TEXT], 0, { isTTY: false });

      expect(refusal(result).detail).toBe(FEEDBACK_EDIT_NEEDS_A_TTY);
      expect(result.commands).toEqual([]);
      yield* heldNothing(result);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // The two argv collisions, decided from the command line alone: neither
  // spawns anything, and neither asks the ledger who owns the branch.
  it.scoped("refuses --feedback beside it — two texts, state one", () =>
    Effect.gen(function* () {
      const result = yield* edited([TEXT], 0, { request: { feedback: Option.some("typed") } });

      expect(refusal(result).detail).toContain("--feedback and --feedback-edit are two texts");
      expect(result.commands).toEqual([]);
      expect(result.resumeTargets).toEqual([]);
      yield* heldNothing(result);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped("refuses --task beside it — the task already says what to do", () =>
    Effect.gen(function* () {
      const result = yield* edited([TEXT], 0, {
        request: { spec: Option.none(), task: Option.some("fix the release note") },
      });

      expect(refusal(result).detail).toContain("--task and --feedback-edit are two texts");
      expect(result.commands).toEqual([]);
      yield* heldNothing(result);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // And the flag itself, through the parser: a boolean, so it names no value
  // and `VALUE_OPTION_NAMES` is untouched.
  it.scoped("is parsed by @effect/cli and reaches the plan as feedback", () =>
    Effect.gen(function* () {
      const scratch = yield* world({
        isTTY: true,
        script: { ...editorWriting([TEXT]), ...happyScript },
      });
      const outcome = yield* Effect.either(
        dispatchCli(
          ["T3", "--branch", BRANCH, "--feedback-edit"],
          scratch.repoRoot,
          true,
          Option.some(TEST_CREDENTIAL),
          Option.none(),
          Option.some(TEST_FORGE_REPO),
        ),
      ).pipe(Effect.provide(scratch.layer));

      expect(Either.isRight(outcome)).toBe(true);
      const [event] = yield* Ref.get(scratch.events);
      if (event?._tag === "PlanResolved") {
        expect(event.plan.task).toEqual({
          _tag: "Spec",
          path: `${scratch.repoRoot}/tasks/T3.md`,
          feedback: Option.some(TEXT),
        });
      }
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
});

// The resume whose spec is gone (T17's run, on the arm T66 moved it to — chart
// row 6): the arm T16 wrote and left unreachable, reached when the resumed spec
// no longer resolves and the dispatcher said what to do anyway.
describe("the resume whose recorded spec is gone", () => {
  const FEEDBACK = "the release note contradicts the flag default — fix both, then re-run verify";

  const GONE: ResumeResolution = {
    _tag: "Resumable",
    branch: BRANCH,
    // A spec this repo no longer has: the branch's work is on the branch, and
    // the file it was dispatched from is not on disk.
    identity: { _tag: "OneOff", spec: "T99" },
    resumedRunId: Option.some("speepobox-t3-1786000000000"),
    base: Option.none(),
  };

  const request = {
    spec: Option.none<string>(),
    branch: Option.none<string>(),
    base: Option.none<string>(),
    resume: Option.some(BRANCH),
    feedback: Option.some(FEEDBACK),
  };

  it.scoped("runs the resume with what the dispatcher said as its task", () =>
    Effect.gen(function* () {
      const result = yield* attempt({ request, resume: Either.right(GONE) });
      expect(Either.isRight(result.outcome)).toBe(true);
      if (Either.isRight(result.outcome)) {
        const plan = result.outcome.right;
        // The text is the task, and it is not also the feedback: `--feedback`
        // is what it arrived on, not what it is (T66).
        expect(plan.task).toEqual({ _tag: "Inline", text: FEEDBACK, feedback: Option.none() });
        // The boundary the prompt reads the accumulated work against.
        expect(plan.mergeBaseSha).toBe(MERGE_BASE_SHA);
      }
      // Single-pass: one implement pass, as every run in this package is.
      expect(result.passes).toHaveLength(1);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // Nothing here re-derives a mode or a spec from the filesystem: the row
  // carries forward exactly the identity the ledger handed back (T16).
  it.scoped("records a FeedbackResume wrapping the identity it recovered", () =>
    Effect.gen(function* () {
      const result = yield* attempt({ request, resume: Either.right(GONE) });
      expect(result.appended).toHaveLength(1);
      expect(result.appended[0]?.identity).toEqual({
        _tag: "FeedbackResume",
        resumed: { _tag: "OneOff", spec: "T99" },
        resumedRunId: Option.some("speepobox-t3-1786000000000"),
      });
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // A bind mount whose host path does not exist is a directory docker invents
  // there — inside the client's repo, root-owned. The run that has no spec
  // mounts none, and its prompts never name `/spec.md` (`agent/prompt.ts`).
  it.scoped("mounts no spec, because the recorded one is not on disk", () =>
    Effect.gen(function* () {
      const result = yield* attempt({ request, resume: Either.right(GONE) });
      const [started] = result.commands.filter((command) => command.startsWith("docker run"));
      expect(started).toBeDefined();
      expect(started).not.toContain(SPEC_TARGET);
      // The ordinary run still mounts its spec, so this is the arm's own
      // behaviour rather than the mount going missing for everyone.
      const ordinary = yield* attempt();
      const [withSpec] = ordinary.commands.filter((command) => command.startsWith("docker run"));
      expect(withSpec).toContain(`:${SPEC_TARGET}:ro`);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // The best-effort context, asked **before** the implement pass and again at
  // the PR step — the second is the edit-or-create decision, and the first is
  // what the prompt quotes.
  it.scoped("asks the forge what the PR says before the pass runs", () =>
    Effect.gen(function* () {
      const result = yield* attempt({ request, resume: Either.right(GONE) });
      const views = result.commands.filter((command) => command.startsWith("gh pr view"));
      expect(views).toHaveLength(2);
      const firstView = result.commands.findIndex((command) => command.startsWith("gh pr view"));
      const push = result.commands.findIndex((command) => command.includes(" push"));
      expect(firstView).toBeLessThan(push);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // T16's table, now fully reachable from both ends: the same resume without
  // feedback is still the refusal, holding nothing.
  it.scoped("still refuses the same resume when nothing was said", () =>
    Effect.gen(function* () {
      const result = yield* attempt({
        request: { ...request, feedback: Option.none() },
        resume: Either.right(GONE),
      });
      expect(refusal(result)._tag).toBe("GuardRefused");
      expect(refusal(result).detail).toContain("the resumed spec is no longer on disk: T99");
      yield* heldNothing(result);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // And a `--feedback` holding nothing is nothing said, so it refuses too: an
  // empty task would be a container started to be told to do nothing.
  it.scoped("refuses a blank --feedback rather than running with an empty task", () =>
    Effect.gen(function* () {
      const result = yield* attempt({
        request: { ...request, feedback: Option.some("  ") },
        resume: Either.right(GONE),
      });
      expect(refusal(result).detail).toContain("the resumed spec is no longer on disk: T99");
      yield* heldNothing(result);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
});

// A dispatch that states its task inline rather than naming a file: no
// positional, and the text on the flag.
const statedInline = (text: string): Partial<DispatchRequest> => ({
  spec: Option.none(),
  task: Option.some(text),
});

// The task stated on the command line (T67, chart row 3): the one-off path end
// to end, with the text as what the passes are for and nothing mounted at
// `/spec.md`. Not a mode, not an entrypoint — one branch, one container, one
// PR, exactly as a spec run is.
describe("--task", () => {
  const TEXT = "fix the release note: it contradicts the flag's default";

  // Everything a shell would act on, in one string. The assertion is that none
  // of it is a shell's business: the text rides the stdin prompt pipe T9 built,
  // exactly as `--feedback` does (T17).
  const HOSTILE = 'drop the `$(uname)` call; keep "quotes" and $HOME literal';

  it.scoped("rides the Spec arm's own path, with the text as what the passes are for", () =>
    Effect.gen(function* () {
      const result = yield* attempt({ request: statedInline(TEXT) });
      expect(Either.isRight(result.outcome)).toBe(true);
      if (Either.isRight(result.outcome)) {
        const plan = result.outcome.right;
        expect(plan.task).toEqual({ _tag: "Inline", text: TEXT, feedback: Option.none() });
        expect(plan.identity).toEqual({ _tag: "InlineTask", task: TEXT });
      }
      // Every pass, the lock, the checkout, the PR: the same run a spec gets.
      expect(result.passes).toHaveLength(1);
      expect(result.commands.some((command) => command.startsWith("gh pr create"))).toBe(true);
      // Nor a status commit: an inline run has no issues to mark (T77).
      expect(result.issueReads).toEqual([]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // The row a `--resume` replays off (22 §4): the text verbatim, written by the
  // finalizer whatever the outcome, as every row is.
  it.scoped("records the text verbatim on the ledger row, under the identity's own arm", () =>
    Effect.gen(function* () {
      const result = yield* attempt({ request: statedInline(HOSTILE) });
      expect(result.appended).toHaveLength(1);
      expect(result.appended[0]?.identity).toEqual({ _tag: "InlineTask", task: HOSTILE });
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // A bind mount whose host path does not exist is a directory docker invents
  // there, root-owned, inside the client's repo (T7's ruling from the other
  // side). There is no spec on this arm, so there is no mount.
  it.scoped("mounts nothing at /spec.md, because there is no spec", () =>
    Effect.gen(function* () {
      const result = yield* attempt({ request: statedInline(TEXT) });
      const [started] = result.commands.filter((command) => command.startsWith("docker run"));
      expect(started).toBeDefined();
      expect(started).not.toContain(SPEC_TARGET);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // A fresh dispatch asks the forge nothing before its pass (22 §5): a PR on
  // this branch describes work this run supersedes, which is misleading
  // context rather than missing context. The one view left is the PR step's
  // own create-or-edit probe, and it happens after the push.
  it.scoped("asks the forge nothing about the branch's PR before the pass", () =>
    Effect.gen(function* () {
      const result = yield* attempt({ request: statedInline(TEXT) });
      const views = result.commands.filter((command) => command.startsWith("gh pr view"));
      expect(views).toHaveLength(1);
      const view = result.commands.findIndex((command) => command.startsWith("gh pr view"));
      const push = result.commands.findIndex((command) => command.includes(" push"));
      expect(push).toBeLessThan(view);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // The property the whole flag rests on, asserted against the argv the
  // dispatch really spawned rather than against a rendered command line.
  it.scoped("parses --task and keeps the text out of every command line", () =>
    Effect.gen(function* () {
      const scratch = yield* world({});
      const outcome = yield* Effect.either(
        dispatchCli(
          ["--branch", BRANCH, "--task", HOSTILE],
          scratch.repoRoot,
          true,
          Option.some(TEST_CREDENTIAL),
          Option.none(),
          Option.some(TEST_FORGE_REPO),
        ),
      ).pipe(Effect.provide(scratch.layer));

      expect(Either.isRight(outcome)).toBe(true);
      const [event] = yield* Ref.get(scratch.events);
      if (event?._tag === "PlanResolved") {
        expect(event.plan.task).toEqual({
          _tag: "Inline",
          text: HOSTILE,
          feedback: Option.none(),
        });
      }
      for (const command of yield* Ref.get(scratch.commands)) {
        expect(command).not.toContain("uname");
        expect(command).not.toContain("--task");
      }
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // Trimmed at the door beside `--feedback`, so a shell's trailing newline
  // makes no difference to what the passes are told or to what the row holds.
  it.scoped("trims what the shell handed over, on the plan and on the row", () =>
    Effect.gen(function* () {
      const result = yield* attempt({ request: statedInline(`  ${TEXT}\n`) });
      expect(Either.isRight(result.outcome)).toBe(true);
      if (Either.isRight(result.outcome)) {
        expect(result.outcome.right.task).toEqual(inlineDispatch(TEXT).task);
      }
      expect(result.appended[0]?.identity).toEqual({ _tag: "InlineTask", task: TEXT });
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
});

// The four spellings the flag is refused in (22 §6 rows 10-13). Each holds
// nothing: no lock, no log, no ledger row — matrix row 1, asserted by looking
// at the world afterwards rather than by intending it.
//
// Every one of them is decided from the command line alone, which is why none
// of these attempts scripts a ledger answer: a refusal that had consulted the
// ledger first would arrive here as *the ledger could not be read*, naming the
// wrong thing entirely.
describe("the spellings --task is refused in", () => {
  const TEXT = "fix the release note";

  const refused = (
    request: Partial<DispatchRequest>,
  ): Effect.Effect<Attempt, PlatformError, FileSystem.FileSystem | Scope.Scope> =>
    attempt({ request: { spec: Option.none(), task: Option.some(TEXT), ...request } });

  it.scoped("row 10: a spec and inline text are two tasks", () =>
    Effect.gen(function* () {
      const result = yield* refused({ spec: Option.some("T3") });
      expect(refusal(result)._tag).toBe("GuardRefused");
      expect(refusal(result).detail).toContain("--task and <spec> are two tasks");
      yield* heldNothing(result);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped("row 11: a resume replays its record, on --resume and on --last alike", () =>
    Effect.gen(function* () {
      const named = yield* refused({ branch: Option.none(), resume: Option.some(BRANCH) });
      expect(refusal(named).detail).toContain("--task and --resume name two different runs");
      expect(refusal(named).detail).toContain("a fresh dispatch on --branch");
      yield* heldNothing(named);
      // The sugar takes the same refusal, naming the flag that was typed.
      const last = yield* refused({ branch: Option.none(), last: true });
      expect(refusal(last).detail).toContain("--task and --last name two different runs");
      yield* heldNothing(last);
      // And neither of them reached the ledger to find that out.
      expect([...named.resumeTargets, ...last.resumeTargets]).toEqual([]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped("row 12: the task already says what to do, so feedback is a second text", () =>
    Effect.gen(function* () {
      const result = yield* refused({ feedback: Option.some("and update the changelog") });
      expect(refusal(result).detail).toContain("--task and --feedback are two texts");
      yield* heldNothing(result);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // Refused **as an empty task**, never as "a spec is required": a dispatcher
  // who typed the flag must not be sent to look for a file.
  it.scoped("row 13: an empty --task is refused as such", () =>
    Effect.gen(function* () {
      for (const empty of ["", "   \n"]) {
        const result = yield* refused({ task: Option.some(empty) });
        expect(refusal(result).detail).toBe(
          "--task was given with nothing in it — state the task, or pass <spec>",
        );
        yield* heldNothing(result);
      }
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // The other end of the same question: no spelling given at all, and the
  // message names all four so the dispatcher can pick (T67, and the feature
  // form T73 adds).
  it.scoped("names all four spellings when the dispatch stated none of them", () =>
    Effect.gen(function* () {
      const result = yield* attempt({ request: { spec: Option.none() } });
      expect(refusal(result).detail).toBe(
        'a task is required — pass <spec>, --task "…", --feature <folder> --issues …, or --resume <branch>',
      );
      yield* heldNothing(result);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
});

// One issue's `Blocked by:` line, as a case writes it: the token a file wrote
// is what a violation quotes back, and on a token naming an issue in the
// folder the two are the same string.
const blockedBy = (id: string): Partial<Issue> => ({ blockers: [{ id, token: id }] });

// The plan a dispatch announced, for the cases whose subject resolves one and
// is then refused below it (T73): the event is the only place it survives.
const planIn = (result: Attempt): DispatchPlan => {
  const resolved = result.events.find((event) => event._tag === "PlanResolved");
  if (resolved?._tag !== "PlanResolved") {
    throw new Error("expected a resolved plan");
  }
  return resolved.plan;
};

// A refusal decided from the command line alone spawns nothing at all — not
// one git call, let alone a ledger read (T67's ruling, and T73's four
// spellings sit under it).
const spawnedNothing = (result: Attempt): void => {
  expect(result.commands).toEqual([]);
};

// T73, and 15's rule at the door: *the dispatcher may replay a work set it
// recorded, and may execute a set the command named. It may never compute one
// the command did not name.* Every case below is one spelling of that, or the
// set read at the one ref it may be read at.
const FOLDER = "f";
// Where `--feature f` lands: a bare name under the tasks dir, rendered
// **repo-relative**, which is what the plan, the row, and every message carry
// (14, lesson 9) and what `IssueStore` reads a ref under.
const RESOLVED = `tasks/${FOLDER}`;

// A dispatch that names a folder and a set. The positional the harness
// otherwise passes goes back off: a spec beside `--feature` is two tasks,
// which is a case of its own below.
const feature = (issues: string): Partial<DispatchRequest> => ({
  spec: Option.none(),
  feature: Option.some(FOLDER),
  issues: Option.some(issues),
});

// What the branch tip carries, keyed by the tip the happy script answers with.
// Keyed by *ref* because that is the whole assertion: the same folder reads
// differently at two refs, and this one is read at the tip.
const atTheTip = (...issues: ReadonlyArray<Issue>): FakeIssueStoreOptions => ({
  sets: { [PRE_TIP]: issues },
});

describe("--feature and --issues", () => {
  // Criterion 1: the whole of what a rehearsal shows a dispatcher, and the one
  // assertion that says *which ref* the set came off. `keepsLog` is false the
  // way `--dry-run` sets it (T48), so the plan this asserts is the one a
  // rehearsal prints.
  it.scoped("reads the set at the branch tip and prints it on the plan block", () =>
    Effect.gen(function* () {
      const result = yield* attempt({
        request: { ...feature("T71,T70"), keepsLog: false },
        issues: atTheTip(fakeIssue("T70"), fakeIssue("T71", blockedBy("T70"))),
      });

      // One question, at the tip, about the repo-relative folder — and the tip
      // is not `baseSha`, which is the diff boundary's other end and never
      // what a set is read at (T70 §4).
      expect(result.issueReads).toEqual([
        { _tag: "Issues", repo: result.repoRoot, ref: PRE_TIP, folder: RESOLVED },
      ]);
      expect(PRE_TIP).not.toBe(BASE_SHA);
      // And one fetch, before all of it (T70).
      expect(result.commands.filter((command) => command.endsWith("fetch origin"))).toHaveLength(1);

      const plan = planIn(result);
      expect(plan.tipSha).toBe(PRE_TIP);
      expect(plan.task).toEqual({
        _tag: "Feature",
        folder: RESOLVED,
        selection: {
          request: { _tag: "Enumerated", ids: ["T71", "T70"] },
          // T69's order, and deliberately not the order they were typed in:
          // the blocker comes first because the set is ordered once, where it
          // is selected.
          issues: [fakeIssue("T70"), { ...fakeIssue("T71"), ...blockedBy("T70") }],
        },
        feedback: Option.none(),
      });
      // The identity records the folder and no outcomes: they are the run's to
      // fill (T76), and a plan decided before anything is held cannot know them.
      expect(plan.identity).toEqual({ _tag: "Feature", feature: RESOLVED, issues: [] });

      const block = renderPlan(plan).split("\n");
      expect(block[0]).toContain(`speepobox: '${RESOLVED}' on branch '${BRANCH}'`);
      expect(block[1]).toBe("  mode:          feature");
      expect(block[2]).toBe("  issues:        T70 T71 (2)");
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // Criterion 2, and where T73's temporary refusal used to be (T76 deleted
  // it): the plan resolves and the run goes *into* the scope — the selection
  // runs, the branch lands, the PR opens, and the row carries the issue's
  // outcome. What that sequence does issue by issue is
  // `test/feature-loop.test.ts`; what this asserts is that a `--feature`
  // dispatch reaches it at all.
  it.scoped("runs the selection inside the scope and records what it came to", () =>
    Effect.gen(function* () {
      // What each pass was told it was for, through the one seam that carries
      // it (T75): this is where the SHA the container printed has to arrive.
      const current = yield* Ref.make<ReadonlyArray<Option.Option<CurrentIssue>>>([]);
      const result = yield* attempt({
        request: feature("T70"),
        issues: atTheTip(fakeIssue("T70")),
        agent: { current, perIssue: { T70: { verdicts: ["approved"] } } },
      });
      expect(Either.isRight(result.outcome)).toBe(true);
      expect(result.appended).toHaveLength(1);
      expect(result.appended[0]?.terminalReason).toEqual(Option.some({ _tag: "Completed" }));
      expect(result.appended[0]?.identity).toEqual({
        _tag: "Feature",
        feature: RESOLVED,
        issues: [{ issue: "T70", outcome: "approved" }],
      });
      // The verdict slot stays empty on this arm: there is no one verdict on a
      // feature run, and the tally is per issue above (T76).
      expect(result.appended[0]?.outcome).toEqual(Option.none());
      // And the run ended where every run ends: the commits pushed and one
      // draft PR over the branch, not one per issue (T11, T12).
      expect(result.appended[0]?.pr).toEqual(
        Option.some({ number: Option.some(PR_NUMBER), url: PR_URL }),
      );
      // And the boundary was read **in the container** — never by host git in
      // the clone, whose `.git/config` the agent owns (AGENTS.md). Every
      // spawn that asked the question is in this list, so a second one against
      // the checkout would fail here rather than pass unnoticed.
      expect(result.commands.filter((command) => command.includes("rev-parse HEAD"))).toEqual([
        `docker exec -i ${CONTAINER_ID} git rev-parse HEAD`,
      ]);
      // And what that container printed is what the issue's passes were told —
      // the implement pass and the round that approved it, both carrying a SHA
      // no host git in this file answers with, so a read that went to the clone
      // could not pass here by coincidence. The `None` after them is the PR
      // pass, which names no issue (T75).
      expect(
        (yield* Ref.get(current)).map((seen) => Option.map(seen, ({ boundary }) => boundary)),
      ).toEqual([Option.some(ISSUE_BOUNDARY), Option.some(ISSUE_BOUNDARY), Option.none()]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // T77, end to end through a real `Git`: the issue approved and the run made
  // commits, so the land asks for its status commit once, against the served
  // repo, and the push still goes out. The order across the two seams is
  // `test/land.test.ts`'s assertion.
  it.scoped("asks for the status commit of what approved, once, before the push", () =>
    Effect.gen(function* () {
      const result = yield* attempt({
        request: feature("T70"),
        issues: atTheTip(fakeIssue("T70")),
        agent: { perIssue: { T70: { verdicts: ["approved"] } } },
      });
      expect(Either.isRight(result.outcome)).toBe(true);
      expect(result.issueReads.filter((call) => call._tag === "MarkLanded")).toEqual([
        {
          _tag: "MarkLanded",
          repo: result.repoRoot,
          branch: BRANCH,
          folder: RESOLVED,
          stems: [fakeIssue("T70").stem],
          index: statusIndexPathFor(result.runtimeRoot, slugFor(BRANCH)),
        },
      ]);
      expect(result.commands.some((command) => command.includes(" push "))).toBe(true);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // Advisory, never fatal (14, lesson 4): the write refused, and the run
  // still pushed, still opened its PR, and still wrote its row — with a
  // warning naming the stem and git's own words.
  it.scoped("warns when the status commit fails, and pushes, opens the PR, and records", () =>
    Effect.gen(function* () {
      const result = yield* attempt({
        request: feature("T70"),
        issues: {
          ...atTheTip(fakeIssue("T70")),
          markLandedFails: "fatal: cannot lock ref",
        },
        agent: { perIssue: { T70: { verdicts: ["approved"] } } },
      });
      expect(Either.isRight(result.outcome)).toBe(true);
      expect(
        result.events.flatMap((event) => (event._tag === "Warned" ? [event.detail] : [])),
      ).toContain(
        `could not mark ${fakeIssue("T70").stem} Done on '${BRANCH}': fatal: cannot lock ref`,
      );
      expect(result.commands.some((command) => command.includes(" push "))).toBe(true);
      expect(result.commands.some((command) => command.startsWith("gh pr create"))).toBe(true);
      expect(result.appended).toHaveLength(1);
      expect(result.appended[0]?.terminalReason).toEqual(Option.some({ _tag: "Completed" }));
      expect(result.appended[0]?.pr).toEqual(
        Option.some({ number: Option.some(PR_NUMBER), url: PR_URL }),
      );
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
  // A slash keeps the folder out of the tasks dir's reach, exactly as it does
  // for a spec (`specPathFor`'s rule without the `.md`).
  it.scoped("takes a folder with a slash in it as a path, anchored at the repo root", () =>
    Effect.gen(function* () {
      const result = yield* attempt({
        request: {
          spec: Option.none(),
          feature: Option.some("docs/queue"),
          issues: Option.some("T70"),
        },
        issues: atTheTip(fakeIssue("T70")),
      });
      expect(result.issueReads.map((call) => call.folder)).toEqual(["docs/queue"]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // Criterion 4: `all` consents to wideness, not to contents — it selects the
  // triage status and not bash's *AFK and not-yet-Done* (T69, 09's amendment).
  it.scoped("selects only the ready-for-agent issues under --issues all", () =>
    Effect.gen(function* () {
      const result = yield* attempt({
        request: feature("ALL"),
        issues: atTheTip(fakeIssue("T70"), fakeIssue("T71", { status: "needs-triage" })),
      });
      expect(planIn(result).task).toMatchObject({
        selection: { request: { _tag: "All" }, issues: [fakeIssue("T70")] },
      });
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped("refuses --issues all over a folder with nothing ready", () =>
    Effect.gen(function* () {
      const result = yield* attempt({
        request: feature("all"),
        issues: atTheTip(fakeIssue("T71", { status: "needs-triage" })),
      });
      expect(refusal(result).detail).toContain(`nothing under ${RESOLVED}/issues/ is ready`);
      yield* heldNothing(result);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // Criterion 5, first half: the folder is not on the branch at all, which is
  // how an untracked queue and a branch cut before the folder existed both
  // present — git cannot tell them apart, so the sentence names both repairs.
  it.scoped("refuses a folder the branch tip does not carry", () =>
    Effect.gen(function* () {
      const result = yield* attempt({ request: feature("T70"), issues: {} });
      expect(refusal(result).detail).toBe(
        `${RESOLVED}/issues/ is not on branch '${BRANCH}' at ${PRE_TIP.slice(0, 10)} — the folder must be tracked and present on the branch (an untracked queue is not supported; a branch cut before the folder was added needs a rebase)`,
      );
      yield* heldNothing(result);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped("refuses a file at the tip it cannot read as an issue, naming it", () =>
    Effect.gen(function* () {
      const result = yield* attempt({
        request: feature("T70"),
        issues: {
          unparseable: {
            file: `${RESOLVED}/issues/T70-a-thing.md`,
            detail: "T70-a-thing.md: 'Type: maybe' is neither AFK nor HITL",
          },
        },
      });
      expect(refusal(result).detail).toBe(
        `${RESOLVED}/issues/T70-a-thing.md at ${PRE_TIP.slice(0, 10)} cannot be read as an issue — T70-a-thing.md: 'Type: maybe' is neither AFK nor HITL`,
      );
      yield* heldNothing(result);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // The tag's third failure, and the one the guard hands on rather than
  // interpreting: git's own line, under a sentence naming the directory and the
  // ref it could not be read at (SPEC §3 — three failures, three repairs).
  it.scoped("carries git's own line when the read cannot be made at all", () =>
    Effect.gen(function* () {
      const result = yield* attempt({
        request: feature("T70"),
        issues: { gitError: "fatal: not a git repository" },
      });
      expect(refusal(result).detail).toBe(
        `could not read ${RESOLVED}/issues/ on branch '${BRANCH}' at ${PRE_TIP.slice(0, 10)}: fatal: not a git repository`,
      );
      yield* heldNothing(result);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // `--feedback` rides on this arm as it does on the other two (T73 §4): it is
  // extra dispatcher instructions under whatever the task turned out to be, so
  // `feedbackIn` answers it here off the same field.
  it.scoped("carries --feedback beside the selection, as the other two arms do", () =>
    Effect.gen(function* () {
      const result = yield* attempt({
        request: { ...feature("T70"), feedback: Option.some("keep the diff small") },
        issues: atTheTip(fakeIssue("T70")),
      });
      const { task } = planIn(result);
      expect(task).toMatchObject({ _tag: "Feature", feedback: Option.some("keep the diff small") });
      expect(feedbackIn(task)).toEqual(Option.some("keep the diff small"));
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // Criterion 5, second half, and T69's own rule read from this end: **every**
  // arm that fired in one message, so a dispatcher fixes one command line
  // rather than re-running to meet the next complaint.
  it.scoped("names every violation in one refusal", () =>
    Effect.gen(function* () {
      const result = yield* attempt({
        request: feature("T88,T70,T71,T72"),
        issues: atTheTip(
          fakeIssue("T70", { status: "done" }),
          fakeIssue("T71", { type: "HITL" }),
          fakeIssue("T72", blockedBy("T73")),
          fakeIssue("T73"),
        ),
      });
      const { detail } = refusal(result);
      expect(detail).toContain(`--issues does not select a run of '${RESOLVED}'`);
      expect(detail).toContain("no issue is named by T88 — the folder holds T70, T71, T72, T73");
      expect(detail).toContain("already done on this ref: T70");
      expect(detail).toContain("not an AFK issue: T71");
      expect(detail).toContain("blocked: T72 by 'T73'");
      yield* heldNothing(result);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // The hint above with nothing in it: a tracked `issues/` holding no `.md` at
  // all — a `.gitkeep` and nothing else — is the folder being *there and
  // empty*, which is not `FolderAbsent` and reaches the unknown-id arm with no
  // ids to suggest. The sentence says so rather than ending on *the folder
  // holds* and leaving a dispatcher to wonder what was cut off.
  it.scoped("says the folder holds nothing when there is no id to suggest", () =>
    Effect.gen(function* () {
      const result = yield* attempt({ request: feature("T70"), issues: atTheTip() });
      expect(refusal(result).detail).toContain(
        "no issue is named by T70 — the folder holds no issues at all",
      );
      yield* heldNothing(result);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
});

// Where a ledger row says an issue was last worked on (T74). `endedAt` is a
// fixed instant rather than a clock read: the refusal quotes the day, so a
// test that took it from `now` would assert nothing about the rendering.
const workedOn = (
  branch: string,
  outcome: Option.Option<string> = Option.some("needs-work"),
): LastWorkedOn => ({
  branch,
  endedAt: DateTime.unsafeMake("2026-08-18T16:04:00.000Z"),
  outcome,
});

// What "the content guards passed" looks like now that the loop exists (T76):
// the run goes into the scope and comes out the far side, with one row naming
// every selected issue. The fake agent approves nothing unless a case scripts
// it to, so the sequence stops at the first issue's cap — which is why the
// expected outcomes are the caller's to state.
const ranTheFeature = (result: Attempt, issues: ReadonlyArray<IssueOutcome>): void => {
  expect(Either.isRight(result.outcome)).toBe(true);
  expect(result.appended).toHaveLength(1);
  expect(result.appended[0]?.terminalReason).toEqual(Option.some({ _tag: "Completed" }));
  expect(result.appended[0]?.identity).toEqual({
    _tag: "Feature",
    feature: RESOLVED,
    issues,
  });
};

// The two the witnesses' cases below expect: the fake reviewer never approves,
// so the first selected issue caps at `needs-work` and the sequence stops
// there, leaving everything after it unattempted.
const CAPPED = (id: string): IssueOutcome => ({ issue: id, outcome: "needs-work" });
const UNATTEMPTED = (id: string): IssueOutcome => ({ issue: id, outcome: "not-attempted" });

// T74's two witnesses, in the phase T73 built and under `--issues all` alone:
// git for what has already landed, the ledger for what somebody is already
// working on. Neither is asked something it cannot know, and enumerating is
// the override for both — `all` consents to wideness, not to contents (15).
describe("the two witnesses for someone else having this issue", () => {
  // The scan's answer, as `for-each-ref` names the refs: a branch and its
  // remote-tracking copy are two refs at one commit and two answers, because a
  // local branch behind its own remote is a different repair from a branch
  // somebody else landed (T72).
  const LANDED_REFS = ["refs/heads/speepobox-t25", "refs/remotes/origin/speepobox-t25"];

  // Criterion 1: git's answer is truth — host-independent and self-correcting
  // after a `--hard-reset` discards a branch (14) — so one hit refuses, and the
  // refusal names every ref, since which of them carries the copy is what the
  // dispatcher acts on.
  it.scoped("refuses under all when another ref already carries the issue as Done", () =>
    Effect.gen(function* () {
      const result = yield* attempt({
        request: feature("all"),
        issues: { ...atTheTip(fakeIssue("T25")), landed: { T25: LANDED_REFS } },
      });
      expect(refusal(result).detail).toBe(
        `T25 is Done on refs/heads/speepobox-t25 and refs/remotes/origin/speepobox-t25 but not on '${BRANCH}' — merge or rebase before dispatching it here, or enumerate --issues to override`,
      );
      // The scan was asked about the selected issues, standing on the tip the
      // set was read at — the same ref, since a second ref at that commit
      // would be answering about the tip's own copy.
      expect(result.issueReads).toEqual([
        { _tag: "Issues", repo: result.repoRoot, ref: PRE_TIP, folder: RESOLVED },
        {
          _tag: "LandedElsewhere",
          repo: result.repoRoot,
          folder: RESOLVED,
          ids: ["T25"],
          tip: PRE_TIP,
        },
      ]);
      yield* heldNothing(result);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped("names every hit in one message", () =>
    Effect.gen(function* () {
      const result = yield* attempt({
        request: feature("all"),
        issues: {
          ...atTheTip(fakeIssue("T25"), fakeIssue("T26")),
          landed: { T25: ["refs/heads/speepobox-t25"], T26: ["refs/heads/speepobox-t26"] },
        },
      });
      expect(refusal(result).detail.split("\n")).toEqual([
        `T25 is Done on refs/heads/speepobox-t25 but not on '${BRANCH}' — merge or rebase before dispatching it here, or enumerate --issues to override`,
        `T26 is Done on refs/heads/speepobox-t26 but not on '${BRANCH}' — merge or rebase before dispatching it here, or enumerate --issues to override`,
      ]);
      yield* heldNothing(result);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // A scan that could not be made is not a clean sheet: git's own line travels
  // up under a sentence naming the folder, the way the set's own read does.
  it.scoped("refuses with git's line when the scan cannot be made at all", () =>
    Effect.gen(function* () {
      const result = yield* attempt({
        request: feature("all"),
        issues: {
          ...atTheTip(fakeIssue("T25")),
          landedElsewhereFails: "fatal: bad object refs/heads/gone",
        },
      });
      expect(refusal(result).detail).toBe(
        `could not read which refs already carry ${RESOLVED}/issues/ as done: fatal: bad object refs/heads/gone`,
      );
      yield* heldNothing(result);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // Criterion 2: the ledger's hint, which answers whether a run would be
  // *wasted* and never whether it would be wrong (15) — so it quotes the
  // branch to go to and what happened there, and sends the dispatcher to
  // `--resume` rather than to a merge.
  it.scoped("refuses when the newest row for a selected issue names another branch", () =>
    Effect.gen(function* () {
      const result = yield* attempt({
        request: feature("all"),
        issues: atTheTip(fakeIssue("T28")),
        workedOn: Either.right({ T28: workedOn("speepobox-t28") }),
      });
      expect(refusal(result).detail).toBe(
        "T28 was last worked on 'speepobox-t28' (needs-work, 2026-08-18) — dispatch it there with --resume, or enumerate --issues to override",
      );
      // Asked of the folder as the row records it — repo-relative (14, lesson
      // 9) — and once per selected issue.
      expect(result.issueWorkQueries).toEqual([{ feature: RESOLVED, issue: "T28" }]);
      yield* heldNothing(result);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // A run that crashed before a verdict recorded none, and it is still where
  // the issue was last worked on: the day alone says which run that was.
  it.scoped("says the day alone when the row recorded no outcome", () =>
    Effect.gen(function* () {
      const result = yield* attempt({
        request: feature("all"),
        issues: atTheTip(fakeIssue("T28")),
        workedOn: Either.right({ T28: workedOn("speepobox-t28", Option.none()) }),
      });
      expect(refusal(result).detail).toContain(
        "T28 was last worked on 'speepobox-t28' (2026-08-18) —",
      );
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // A row naming **this** branch is this dispatch's own history, not somebody
  // else's: re-dispatching a branch you already ran is what `--resume` is.
  it.scoped("passes when the newest row names this very branch", () =>
    Effect.gen(function* () {
      const result = yield* attempt({
        request: feature("all"),
        issues: atTheTip(fakeIssue("T28")),
        workedOn: Either.right({ T28: workedOn(BRANCH) }),
      });
      ranTheFeature(result, [CAPPED("T28")]);
      expect(result.issueWorkQueries).toEqual([{ feature: RESOLVED, issue: "T28" }]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // Criterion 3: the ledger is derived state (SPEC §10), so a read that fails
  // is a `Warned` event and the check passes — 09 unit 2's rule, the one
  // `lastBaseForBranch` already follows. The witness that *is* truth is
  // untouched by it, and the assertion says so.
  it.scoped("warns and proceeds when the ledger cannot be read, and still scans", () =>
    Effect.gen(function* () {
      const result = yield* attempt({
        request: feature("all"),
        issues: atTheTip(fakeIssue("T28")),
        workedOn: Either.left(new LedgerError({ detail: "runs.jsonl: EACCES" })),
      });
      ranTheFeature(result, [CAPPED("T28")]);
      expect(
        result.events.filter((event) => event._tag === "Warned").map((event) => event.detail),
      ).toEqual([
        "--issues all could not ask the ledger where these issues were last worked on (runs.jsonl: EACCES) — dispatching without that check, which is a hint rather than a correctness question",
      ]);
      expect(result.issueReads.filter((call) => call._tag === "LandedElsewhere")).toHaveLength(1);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // git first, because it is the one that is truth: a copy that says `Done` on
  // another ref refuses whatever the ledger holds, and the ledger is not even
  // asked once the run is already refused.
  it.scoped("asks git first, and stops there when git answers", () =>
    Effect.gen(function* () {
      const result = yield* attempt({
        request: feature("all"),
        issues: { ...atTheTip(fakeIssue("T25")), landed: { T25: LANDED_REFS } },
        workedOn: Either.right({ T25: workedOn("speepobox-t25") }),
      });
      expect(refusal(result).detail).toContain("is Done on refs/heads/speepobox-t25");
      expect(result.issueWorkQueries).toEqual([]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // Criterion 4: enumerating is the override for both, and it is an override
  // by **not asking** — a check whose answer is discarded is a check a reader
  // will one day believe was made, and the scan is two git processes over
  // every ref of the dispatching host.
  it.scoped("asks neither witness under an enumerated --issues", () =>
    Effect.gen(function* () {
      const result = yield* attempt({
        request: feature("T25,T28"),
        issues: {
          ...atTheTip(fakeIssue("T25"), fakeIssue("T28")),
          landed: { T25: LANDED_REFS },
        },
        workedOn: Either.right({ T28: workedOn("speepobox-t28") }),
      });
      ranTheFeature(result, [CAPPED("T25"), UNATTEMPTED("T28")]);
      expect(result.issueReads).toEqual([
        { _tag: "Issues", repo: result.repoRoot, ref: PRE_TIP, folder: RESOLVED },
      ]);
      expect(result.issueWorkQueries).toEqual([]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // And the ordinary wide dispatch, which both witnesses pass: the scan finds
  // nobody else's copy and no row names another branch, so the selection
  // stands and the run goes on to the scope.
  it.scoped("passes a wide selection nobody else has", () =>
    Effect.gen(function* () {
      const result = yield* attempt({
        request: feature("all"),
        issues: atTheTip(fakeIssue("T25"), fakeIssue("T28")),
      });
      ranTheFeature(result, [CAPPED("T25"), UNATTEMPTED("T28")]);
      expect(planIn(result).task).toMatchObject({
        selection: { request: { _tag: "All" }, issues: [fakeIssue("T25"), fakeIssue("T28")] },
      });
      expect(result.issueWorkQueries).toEqual([
        { feature: RESOLVED, issue: "T25" },
        { feature: RESOLVED, issue: "T28" },
      ]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
});

// T103: `--feature --hard-reset` reads the set at the base — T101 made the
// base the effective tip for every arm — and the branch being discarded is not
// a witness against itself. The fixture is an issue `Done` only on the commits
// the reset throws away: on `refs/heads/<b>` and on `origin/<b>`, and still
// ready at the base.
describe("--feature under --hard-reset", () => {
  const OWN_REFS = [`refs/heads/${BRANCH}`, `refs/remotes/origin/${BRANCH}`];
  const doneOnlyOnTheDiscard: FakeIssueStoreOptions = {
    sets: {
      [PRE_TIP]: [fakeIssue("T25", { status: "done" })],
      [BASE_SHA]: [fakeIssue("T25")],
    },
    landed: { T25: OWN_REFS },
  };
  const resetting = (issues: string): Partial<DispatchRequest> => ({
    ...feature(issues),
    hardReset: true,
  });

  // Criterion 1, and criterion 2's first half: the dispatch is not refused
  // for being a feature run, the set is read at the base, `all` offers the
  // issue as ready, and the witness leaves out the branch's own two refs by
  // name — so nothing it discards refuses it.
  it.scoped("selects an issue Done only on the discarded branch, and runs it", () =>
    Effect.gen(function* () {
      const result = yield* attempt({
        request: resetting("all"),
        issues: doneOnlyOnTheDiscard,
        script: withOrigin,
      });
      ranTheFeature(result, [CAPPED("T25")]);
      const plan = planIn(result);
      expect(plan.tipSha).toBe(BASE_SHA);
      expect(Option.isSome(plan.reset)).toBe(true);
      expect(plan.task).toMatchObject({
        selection: { request: { _tag: "All" }, issues: [fakeIssue("T25")] },
      });
      expect(result.issueReads.filter((call) => call._tag !== "MarkLanded")).toEqual([
        { _tag: "Issues", repo: result.repoRoot, ref: BASE_SHA, folder: RESOLVED },
        {
          _tag: "LandedElsewhere",
          repo: result.repoRoot,
          folder: RESOLVED,
          ids: ["T25"],
          tip: BASE_SHA,
          alsoExcluding: OWN_REFS,
        },
      ]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // Criterion 2's second half: the exclusion is of the branch being discarded
  // and nothing else, so the same issue `Done` on another branch still refuses
  // — naming that branch alone.
  it.scoped("still refuses when another branch carries the issue as Done", () =>
    Effect.gen(function* () {
      const result = yield* attempt({
        request: resetting("all"),
        issues: {
          ...doneOnlyOnTheDiscard,
          landed: { T25: [...OWN_REFS, "refs/heads/speepobox-t25"] },
        },
        script: withOrigin,
      });
      expect(refusal(result).detail).toBe(
        `T25 is Done on refs/heads/speepobox-t25 but not on '${BRANCH}' — merge or rebase before dispatching it here, or enumerate --issues to override`,
      );
      yield* heldNothing(result);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // Criterion 3: T73's "already done on this ref" is read at the base, where
  // the issue is not done.
  it.scoped("does not refuse an enumerated issue as already Done", () =>
    Effect.gen(function* () {
      const result = yield* attempt({
        request: resetting("T25"),
        issues: doneOnlyOnTheDiscard,
        script: withOrigin,
      });
      ranTheFeature(result, [CAPPED("T25")]);
      expect(result.issueReads.filter((call) => call._tag !== "MarkLanded")).toEqual([
        { _tag: "Issues", repo: result.repoRoot, ref: BASE_SHA, folder: RESOLVED },
      ]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // And the same fixture without the flag is what it always was: the set is
  // read at the tip, where the issue is done, and the scan asks nothing extra.
  it.scoped("reads at the tip and excludes nothing without the flag", () =>
    Effect.gen(function* () {
      const result = yield* attempt({ request: feature("T25"), issues: doneOnlyOnTheDiscard });
      expect(refusal(result).detail).toContain("already done on this ref: T25");

      const wide = yield* attempt({
        request: feature("all"),
        issues: { sets: { [PRE_TIP]: [fakeIssue("T25")] }, landed: { T25: OWN_REFS } },
      });
      expect(refusal(wide).detail).toContain(`T25 is Done on ${OWN_REFS.join(" and ")}`);
      expect(wide.issueReads.find((call) => call._tag === "LandedElsewhere")).toEqual({
        _tag: "LandedElsewhere",
        repo: wide.repoRoot,
        folder: RESOLVED,
        ids: ["T25"],
        tip: PRE_TIP,
      });
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
});

// Criterion 3: the four spellings decided from the command line alone, which
// is why every one of them refuses with nothing spawned at all — not one git
// call, let alone a ledger read (T67's ruling, applied to this pair).
describe("the spellings --feature and --issues are refused in", () => {
  it.scoped("refuses --feature with no --issues", () =>
    Effect.gen(function* () {
      const result = yield* attempt({
        request: { spec: Option.none(), feature: Option.some("f") },
      });
      expect(refusal(result)._tag).toBe("GuardRefused");
      expect(refusal(result).detail).toBe(
        "--feature 'f' needs --issues — a selection the dispatcher did not name is a proposal, not an instruction; name the issues, or pass --issues all",
      );
      spawnedNothing(result);
      yield* heldNothing(result);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped("refuses --issues with neither a feature nor a resume", () =>
    Effect.gen(function* () {
      const result = yield* attempt({ request: { issues: Option.some("T70") } });
      expect(refusal(result).detail).toBe(
        "--issues names the issues of a feature or narrows a resume — pass --feature <folder> beside it, or --resume <branch>",
      );
      spawnedNothing(result);
      yield* heldNothing(result);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped("refuses --feature beside <spec>", () =>
    Effect.gen(function* () {
      const result = yield* attempt({
        request: { feature: Option.some("f"), issues: Option.some("T70") },
      });
      expect(refusal(result).detail).toBe(
        "--feature and <spec> are two tasks — a folder of issues and a spec; state one, not both",
      );
      spawnedNothing(result);
      yield* heldNothing(result);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped("refuses --feature beside --task", () =>
    Effect.gen(function* () {
      const result = yield* attempt({
        request: {
          spec: Option.none(),
          task: Option.some("fix the release note"),
          feature: Option.some("f"),
          issues: Option.some("T70"),
        },
      });
      expect(refusal(result).detail).toBe(
        "--feature and --task are two tasks — a folder of issues and inline text; state one, not both",
      );
      spawnedNothing(result);
      yield* heldNothing(result);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // `--task`'s row 11, on this pair. Above the two `--issues` rows below
  // because the whole command line is the mistake: before this refusal existed
  // the guard passed, the resume arm downstream won, and the dispatcher was
  // answered about a ledger they had not asked about — the exact shape the
  // comment over `featureStatedOnce` says this slot exists to prevent.
  it.scoped("refuses --feature beside --resume, and beside --last alike", () =>
    Effect.gen(function* () {
      const named = yield* attempt({
        request: {
          spec: Option.none(),
          branch: Option.none(),
          feature: Option.some("f"),
          issues: Option.some("T70"),
          resume: Option.some(BRANCH),
        },
      });
      expect(refusal(named)._tag).toBe("GuardRefused");
      expect(refusal(named).detail).toContain("--feature and --resume name two different runs");
      expect(refusal(named).detail).toContain("a fresh dispatch on --branch");
      spawnedNothing(named);
      yield* heldNothing(named);

      // The sugar takes the same refusal, naming the flag that was typed.
      const last = yield* attempt({
        request: {
          spec: Option.none(),
          branch: Option.none(),
          feature: Option.some("f"),
          issues: Option.some("T70"),
          last: true,
        },
      });
      expect(refusal(last).detail).toContain("--feature and --last name two different runs");
      spawnedNothing(last);
      yield* heldNothing(last);

      // And neither of them reached the ledger to find that out, which is the
      // half that makes the refusal the dispatcher's to act on.
      expect([...named.resumeTargets, ...last.resumeTargets]).toEqual([]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // It is refused whether or not the pair is otherwise well formed: a
  // `--feature` with no `--issues` beside a resume is still two runs, and
  // being told to name a set would have the dispatcher add one and lose it.
  it.scoped("refuses --feature beside --resume before it asks about --issues", () =>
    Effect.gen(function* () {
      const result = yield* attempt({
        request: {
          spec: Option.none(),
          branch: Option.none(),
          feature: Option.some("f"),
          resume: Option.some(BRANCH),
        },
      });
      expect(refusal(result).detail).toContain("--feature and --resume name two different runs");
      expect(result.resumeTargets).toEqual([]);
      yield* heldNothing(result);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // The emptiness is refused **as such** rather than as the requirement above:
  // a dispatcher told to pass `--issues` when they just did is left working
  // out which half of that sentence was theirs (T67's ruling for `--task ""`).
  it.scoped("refuses an --issues that names nothing, as the emptiness it is", () =>
    Effect.gen(function* () {
      for (const given of ["", "   ", ",", " , ,"]) {
        const result = yield* attempt({
          request: { spec: Option.none(), feature: Option.some("f"), issues: Option.some(given) },
        });
        expect(refusal(result).detail).toBe(
          "--issues was given with nothing in it — name the issues of 'f', or pass --issues all",
        );
        spawnedNothing(result);
        yield* heldNothing(result);
      }
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // And `--feature` the same (T87): a flag holding only whitespace named no
  // folder, and the `--issues` row's sentence would tell the dispatcher to pass
  // the flag they just passed. Alone, beside `--issues`, and beside a resume
  // alike — and before any ledger or git read.
  it.scoped("refuses a --feature that names nothing, as the emptiness it is", () =>
    Effect.gen(function* () {
      const requests = [
        { spec: Option.none(), feature: Option.some("  "), issues: Option.some("all") },
        { spec: Option.none(), feature: Option.some("") },
        {
          spec: Option.none(),
          branch: Option.none(),
          feature: Option.some("  "),
          resume: Option.some(BRANCH),
        },
      ];
      for (const request of requests) {
        const result = yield* attempt({ request });
        expect(refusal(result)._tag).toBe("GuardRefused");
        expect(refusal(result).detail).toBe(
          "--feature was given with nothing in it — name the folder whose issues this run works through",
        );
        expect(refusal(result).detail).not.toContain("pass --feature");
        expect(result.resumeTargets).toEqual([]);
        spawnedNothing(result);
        yield* heldNothing(result);
      }
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
});

// Chart rows 8 and 9: a resume of a branch whose last run stated its task
// inline. The text comes back off the row — it cannot be *gone from disk*, so
// T16's table has no question to ask of it and 15's feedback-only derivation is
// unreachable on this arm.
describe("the resume of a branch that last ran --task", () => {
  const TEXT = "fix the release note: it contradicts the flag's default";

  const RECORDED: ResumeResolution = {
    _tag: "Resumable",
    branch: BRANCH,
    identity: { _tag: "InlineTask", task: TEXT },
    resumedRunId: Option.some("speepobox-t3-1786000000000"),
    base: Option.none(),
  };

  const request: Partial<DispatchRequest> = {
    spec: Option.none(),
    branch: Option.none(),
    resume: Option.some(BRANCH),
  };

  it.scoped("replays the recorded text, and wraps the identity it recovered", () =>
    Effect.gen(function* () {
      const result = yield* attempt({ request, resume: Either.right(RECORDED) });
      expect(Either.isRight(result.outcome)).toBe(true);
      if (Either.isRight(result.outcome)) {
        expect(result.outcome.right.task).toEqual({
          _tag: "Inline",
          text: TEXT,
          feedback: Option.none(),
        });
      }
      expect(result.appended[0]?.identity).toEqual({
        _tag: "FeedbackResume",
        resumed: { _tag: "InlineTask", task: TEXT },
        resumedRunId: Option.some("speepobox-t3-1786000000000"),
      });
      // Nothing is mounted: the recorded task is text, and there is no file.
      const [started] = result.commands.filter((command) => command.startsWith("docker run"));
      expect(started).not.toContain(SPEC_TARGET);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // Row 9: `--feedback` on that resume is appended under the task, exactly as
  // on a spec resume — it does not replace what the branch was dispatched for.
  it.scoped("appends --feedback under the recorded task rather than replacing it", () =>
    Effect.gen(function* () {
      const result = yield* attempt({
        request: { ...request, feedback: Option.some("and update the changelog") },
        resume: Either.right(RECORDED),
      });
      expect(Either.isRight(result.outcome)).toBe(true);
      if (Either.isRight(result.outcome)) {
        expect(result.outcome.right.task).toEqual({
          _tag: "Inline",
          text: TEXT,
          feedback: Option.some("and update the changelog"),
        });
      }
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // The resuming half T66 keyed off the identity: this run is a resume, so the
  // forge is asked what the branch's PR says before the implement pass runs.
  it.scoped("asks the forge what the PR says, because the identity says resume", () =>
    Effect.gen(function* () {
      const result = yield* attempt({ request, resume: Either.right(RECORDED) });
      const firstView = result.commands.findIndex((command) => command.startsWith("gh pr view"));
      const push = result.commands.findIndex((command) => command.includes(" push"));
      expect(firstView).toBeGreaterThanOrEqual(0);
      expect(firstView).toBeLessThan(push);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
});

// T78, and 15's rule in one sentence: *a resume can only ever run some of what
// it ran before.* The recorded set is replayed, filtered by the outcomes the
// row recorded, and re-read at the tip through the content guards; the folder
// is never rescanned.
describe("the resume of a branch that last ran a feature run", () => {
  const RUN_ID = "speepobox-t3-1786000000000";

  const recordedAs = (identity: DispatchIdentity): ResumeResolution => ({
    _tag: "Resumable",
    branch: BRANCH,
    identity,
    resumedRunId: Option.some(RUN_ID),
    base: Option.none(),
  });

  // Run 1: `[A approved, B needs-work, C not-attempted]`.
  const FIRST_RUN: DispatchIdentity = {
    _tag: "Feature",
    feature: RESOLVED,
    issues: [{ issue: "T70", outcome: "approved" }, CAPPED("T71"), UNATTEMPTED("T72")],
  };

  const request: Partial<DispatchRequest> = {
    spec: Option.none(),
    branch: Option.none(),
    resume: Option.some(BRANCH),
  };

  // The tip after run 1: its status commit marked the approved issue `Done`,
  // and the other two are as they were.
  const TIP = atTheTip(
    fakeIssue("T70", { status: "done" }),
    fakeIssue("T71", blockedBy("T70")),
    fakeIssue("T72", blockedBy("T71")),
  );

  it.scoped("replays what the record left, runs it, and wraps the recorded Feature", () =>
    Effect.gen(function* () {
      const result = yield* attempt({
        request,
        resume: Either.right(recordedAs(FIRST_RUN)),
        issues: TIP,
        agent: { perIssue: { T71: { verdicts: ["approved"] } } },
      });

      // Read at the tip through the store — once, and the folder the row
      // recorded — and neither witness asked: a replay is an enumerated set.
      expect(result.issueReads).toContainEqual({
        _tag: "Issues",
        repo: result.repoRoot,
        ref: PRE_TIP,
        folder: RESOLVED,
      });
      expect(result.issueReads.filter((call) => call._tag === "Issues")).toHaveLength(1);
      expect(result.issueReads.filter((call) => call._tag === "LandedElsewhere")).toEqual([]);
      expect(result.issueWorkQueries).toEqual([]);

      const plan = planIn(result);
      expect(plan.task).toEqual({
        _tag: "Feature",
        folder: RESOLVED,
        selection: {
          request: { _tag: "Enumerated", ids: ["T71", "T72"] },
          issues: [
            { ...fakeIssue("T71"), ...blockedBy("T70") },
            { ...fakeIssue("T72"), ...blockedBy("T71") },
          ],
        },
        feedback: Option.none(),
      });
      expect(plan.identity).toEqual({
        _tag: "FeedbackResume",
        resumed: { _tag: "Feature", feature: RESOLVED, issues: [] },
        resumedRunId: Option.some(RUN_ID),
      });

      // The loop ran over both, and the row carries this run's outcomes under
      // the resume it was.
      expect(Either.isRight(result.outcome)).toBe(true);
      expect(result.appended).toHaveLength(1);
      expect(result.appended[0]?.terminalReason).toEqual(Option.some({ _tag: "Completed" }));
      expect(result.appended[0]?.identity).toEqual({
        _tag: "FeedbackResume",
        resumed: {
          _tag: "Feature",
          feature: RESOLVED,
          issues: [{ issue: "T71", outcome: "approved" }, CAPPED("T72")],
        },
        resumedRunId: Option.some(RUN_ID),
      });

      // And the chain composes: a second resume over that row — whose newest
      // outcomes are the wrapped `Feature`'s — plans what it left.
      const row = result.appended[0];
      if (row === undefined) {
        throw new Error("expected a row");
      }
      const second = yield* attempt({
        request: { ...request, keepsLog: false },
        resume: Either.right(recordedAs(dispatchIdentity(row.identity))),
        issues: atTheTip(
          fakeIssue("T70", { status: "done" }),
          fakeIssue("T71", { status: "done", ...blockedBy("T70") }),
          fakeIssue("T72", blockedBy("T71")),
        ),
      });
      expect(planIn(second).task).toMatchObject({
        selection: { request: { _tag: "Enumerated", ids: ["T72"] } },
      });
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // `--feedback` on the replay is this dispatch's own, and rides the task.
  it.scoped("carries this dispatch's --feedback on the replayed task", () =>
    Effect.gen(function* () {
      const result = yield* attempt({
        request: { ...request, feedback: Option.some("keep the flag's name") },
        resume: Either.right(recordedAs(FIRST_RUN)),
        issues: TIP,
      });
      expect(planIn(result).task).toMatchObject({ feedback: Option.some("keep the flag's name") });
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // The plan block of that replay: `resume (feature)`, and the replayed ids.
  // `keepsLog` is false the way `--dry-run` sets it (T48); the rehearsal
  // itself is `test/dry-run.test.ts`'s.
  it.scoped("prints resume (feature) and the replayed ids", () =>
    Effect.gen(function* () {
      const result = yield* attempt({
        request: { ...request, keepsLog: false },
        resume: Either.right(recordedAs(FIRST_RUN)),
        issues: TIP,
      });
      const block = renderPlan(planIn(result)).split("\n");
      expect(block[0]).toContain(`speepobox: '${RESOLVED}' on branch '${BRANCH}'`);
      expect(block[1]).toBe("  mode:          resume (feature)");
      expect(block[2]).toBe("  issues:        T71 T72 (2)");
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // An id the record says was not approved, `Done` at the tip: somebody
  // marked it by hand, or the branch was reset under the record.
  it.scoped("refuses an id Done at the tip as the branch having moved under the record", () =>
    Effect.gen(function* () {
      const result = yield* attempt({
        request,
        resume: Either.right(recordedAs(FIRST_RUN)),
        issues: atTheTip(
          fakeIssue("T70", { status: "done" }),
          fakeIssue("T71", { status: "done" }),
          fakeIssue("T72"),
        ),
      });
      const refused = refusal(result);
      expect(refused.detail).toBe(
        [
          `the set of '${RESOLVED}' recorded on '${BRANCH}' does not replay at ${PRE_TIP.slice(0, 10)}:`,
          `  the branch moved under the record: T71 Done on this ref, but the last run recorded on '${BRANCH}' did not approve it — the record no longer describes the branch; dispatch what is left afresh with --feature … --issues …`,
        ].join("\n"),
      );
      yield* heldNothing(result);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // A blocker the replay does not carry, and that is not done at the tip,
  // refuses as it would on a fresh dispatch.
  it.scoped("refuses a replay whose blocker is not done at the tip", () =>
    Effect.gen(function* () {
      const result = yield* attempt({
        request,
        resume: Either.right(recordedAs(FIRST_RUN)),
        issues: atTheTip(fakeIssue("T70"), fakeIssue("T71", blockedBy("T70")), fakeIssue("T72")),
      });
      expect(refusal(result).detail).toContain("blocked: T71 by 'T70'");
      yield* heldNothing(result);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // A tip where the last recorded id stands on its own, so it can run alone.
  const UNBLOCKED_TIP = atTheTip(
    fakeIssue("T70", { status: "done" }),
    fakeIssue("T71", blockedBy("T70")),
    fakeIssue("T72"),
  );

  // Narrowing is continuing (T88): an id the record left, matched by T68's
  // rule — exact, case-insensitive, or a bare number against the digits —
  // plans that id alone, re-read at the tip like the replay it narrows.
  it.scoped("narrows the replay to the recorded ids --issues names", () =>
    Effect.gen(function* () {
      for (const typed of ["T72", "t72"]) {
        const result = yield* attempt({
          request: { ...request, issues: Option.some(typed), keepsLog: false },
          resume: Either.right(recordedAs(FIRST_RUN)),
          issues: UNBLOCKED_TIP,
        });
        expect(planIn(result).task).toMatchObject({
          _tag: "Feature",
          folder: RESOLVED,
          selection: {
            request: { _tag: "Enumerated", ids: ["T72"] },
            issues: [fakeIssue("T72")],
          },
        });
        expect(planIn(result).identity).toMatchObject({ _tag: "FeedbackResume" });
      }
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped("matches a bare number against a recorded id's digits", () =>
    Effect.gen(function* () {
      const result = yield* attempt({
        request: { ...request, issues: Option.some("3"), keepsLog: false },
        resume: Either.right(
          recordedAs({
            _tag: "Feature",
            feature: RESOLVED,
            issues: [CAPPED("T2"), UNATTEMPTED("T3")],
          }),
        ),
        issues: atTheTip(fakeIssue("T2"), fakeIssue("T3")),
      });
      expect(planIn(result).task).toMatchObject({
        selection: { request: { _tag: "Enumerated", ids: ["T3"] }, issues: [fakeIssue("T3")] },
      });
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // Several narrowed ids take T69's order, not the order they were typed in.
  it.scoped("plans a narrowed set in T69's order", () =>
    Effect.gen(function* () {
      const result = yield* attempt({
        request: { ...request, issues: Option.some("72,T71,71"), keepsLog: false },
        resume: Either.right(recordedAs(FIRST_RUN)),
        issues: TIP,
      });
      expect(planIn(result).task).toMatchObject({
        selection: {
          issues: [
            { ...fakeIssue("T71"), ...blockedBy("T70") },
            { ...fakeIssue("T72"), ...blockedBy("T71") },
          ],
        },
      });
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // The three refusals, each before anything is read at the tip.
  const narrowingRefused = (typed: string, detail: string) =>
    Effect.gen(function* () {
      const result = yield* attempt({
        request: { ...request, issues: Option.some(typed) },
        resume: Either.right(recordedAs(FIRST_RUN)),
        issues: TIP,
      });
      expect(refusal(result).detail).toBe(detail);
      expect(result.issueReads).toEqual([]);
      yield* heldNothing(result);
    });

  it.scoped("refuses an id the record approved", () =>
    narrowingRefused(
      "T70",
      [
        `--issues does not narrow the resume of '${BRANCH}':`,
        `  already approved on '${BRANCH}': T70 — re-running approved work is refused, never silently skipped`,
      ].join("\n"),
    ).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped("refuses an id outside the record, naming the recorded set", () =>
    narrowingRefused(
      "T73,T70",
      [
        `--issues does not narrow the resume of '${BRANCH}':`,
        `  not recorded on '${BRANCH}': T73 — the recorded set of '${RESOLVED}' is T70, T71, T72; a resume only narrows it, and other issues are a fresh --feature dispatch`,
        `  already approved on '${BRANCH}': T70 — re-running approved work is refused, never silently skipped`,
      ].join("\n"),
    ).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped("refuses --issues all with the spelling of a fresh dispatch", () =>
    narrowingRefused(
      "all",
      `--issues all on a resume reads two ways — everything the record holds, or a fresh scan of '${RESOLVED}' — so it is refused; name the recorded issues to narrow to, or dispatch the folder afresh: --feature ${RESOLVED} --issues all --branch ${BRANCH}`,
    ).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped("refuses an --issues that named nothing", () =>
    narrowingRefused(
      " , ",
      `--issues was given with nothing in it — name the recorded issues to narrow the resume of '${BRANCH}' to, or resume without --issues`,
    ).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // A row that recorded no set has nothing to narrow, and the flag is refused
  // rather than dropped in silence.
  it.scoped("refuses --issues on the resume of a spec run and of a --task run", () =>
    Effect.gen(function* () {
      const rows: ReadonlyArray<readonly [DispatchIdentity, string]> = [
        [{ _tag: "OneOff", spec: "T99" }, "a spec"],
        [{ _tag: "InlineTask", task: "fix the note" }, "a --task"],
      ];
      for (const [identity, run] of rows) {
        const result = yield* attempt({
          request: { ...request, issues: Option.some("T72") },
          resume: Either.right(recordedAs(identity)),
          issues: TIP,
        });
        expect(refusal(result).detail).toBe(
          `--issues narrows the set a feature run recorded, and '${BRANCH}' last ran ${run}, which records none — resume without --issues`,
        );
        yield* heldNothing(result);
      }
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // An exhausted set: every recorded id approved, nothing left to recover.
  const EXHAUSTED_SET: DispatchIdentity = {
    _tag: "Feature",
    feature: RESOLVED,
    issues: [
      { issue: "T70", outcome: "approved" },
      { issue: "T71", outcome: "approved" },
    ],
  };
  const EXHAUSTED = recordedAs(EXHAUSTED_SET);

  // 15's feedback-only resume (T89): no flag of its own, just the exhausted
  // set and `--feedback` — which stands in as the task, on the inline arm.
  it.scoped("runs --feedback as the task of an exhausted set's resume", () =>
    Effect.gen(function* () {
      const feedback = "now tidy the docs";
      const result = yield* attempt({
        request: { ...request, feedback: Option.some(feedback) },
        resume: Either.right(EXHAUSTED),
        issues: TIP,
      });
      expect(Either.isRight(result.outcome)).toBe(true);
      const plan = planIn(result);
      // The text is the task and not also the feedback, and no set is read.
      expect(plan.task).toEqual({ _tag: "Inline", text: feedback, feedback: Option.none() });
      expect(result.issueReads).toEqual([]);
      // One implement pass, with the PR asked about before it runs.
      expect(result.passes).toHaveLength(1);
      const firstView = result.commands.findIndex((command) => command.startsWith("gh pr view"));
      const push = result.commands.findIndex((command) => command.includes(" push"));
      expect(firstView).toBeGreaterThanOrEqual(0);
      expect(firstView).toBeLessThan(push);
      const context = yield* asked(plan, { existing: VIEWED_PR });
      expect(context.context).toEqual(
        Option.some({ title: VIEWED_PR.title, body: VIEWED_PR.body }),
      );
      // The mode line's eighth spelling, and no `issues` row.
      const block = renderPlan(plan).split("\n");
      expect(block[1]).toBe(
        "  mode:          resume (feedback stands in for the exhausted issue set)",
      );
      expect(block.some((line) => line.startsWith("  issues:"))).toBe(false);
      // The row wraps the recorded `Feature` and carries its set forward,
      // unchanged (T92): the outcomes are the ledger's, not this run's.
      const identity = {
        _tag: "FeedbackResume",
        resumed: EXHAUSTED_SET,
        resumedRunId: Option.some(RUN_ID),
      };
      expect(plan.identity).toEqual(identity);
      expect(result.appended).toHaveLength(1);
      expect(result.appended[0]?.identity).toEqual(identity);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // T92: the row that resume writes still holds the set, so the next resume
  // over it answers as it would over the exhausted row itself.
  it.scoped("keeps the recorded set for the resume after a feedback resume", () =>
    Effect.gen(function* () {
      const first = yield* attempt({
        request: { ...request, feedback: Option.some("now tidy the docs") },
        resume: Either.right(EXHAUSTED),
        issues: TIP,
      });
      const row = first.appended[0];
      if (row === undefined) {
        throw new Error("expected a row");
      }
      const next = Either.right(recordedAs(dispatchIdentity(row.identity)));

      // A bare resume: every issue of a set that exists is approved.
      const bare = yield* attempt({ request, resume: next, issues: TIP });
      expect(refusal(bare).detail).toBe(
        `every issue of '${RESOLVED}' recorded on '${BRANCH}' is approved; say what to do with --feedback, or dispatch the folder afresh with --feature … --issues …`,
      );
      yield* heldNothing(bare);

      // A recorded id is refused as approved, not as unrecorded.
      const narrowed = yield* attempt({
        request: { ...request, issues: Option.some("T71") },
        resume: next,
        issues: TIP,
      });
      expect(refusal(narrowed).detail).toBe(
        [
          `--issues does not narrow the resume of '${BRANCH}':`,
          `  already approved on '${BRANCH}': T71 — re-running approved work is refused, never silently skipped`,
        ].join("\n"),
      );
      yield* heldNothing(narrowed);

      // And `--feedback` takes the inline arm again, with the same identity.
      const again = yield* attempt({
        request: { ...request, feedback: Option.some("and the changelog"), keepsLog: false },
        resume: next,
        issues: TIP,
      });
      const plan = planIn(again);
      expect(plan.task).toEqual({
        _tag: "Inline",
        text: "and the changelog",
        feedback: Option.none(),
      });
      expect(plan.identity).toEqual(row.identity);
      expect(again.appended[0]?.identity).toEqual(row.identity);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // Without `--feedback` there is nothing to run, and T78's words stand.
  it.scoped("refuses an exhausted set without --feedback", () =>
    Effect.gen(function* () {
      const words = `every issue of '${RESOLVED}' recorded on '${BRANCH}' is approved; say what to do with --feedback, or dispatch the folder afresh with --feature … --issues …`;
      for (const feedback of [Option.none(), Option.some("  ")]) {
        const result = yield* attempt({
          request: { ...request, feedback },
          resume: Either.right(EXHAUSTED),
          issues: TIP,
        });
        expect(refusal(result).detail).toBe(words);
        yield* heldNothing(result);
      }
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
});

// The best-effort half of a resuming run's implement prompt (T17, asked off
// the identity since T66): what the branch's PR says today, and what happens
// when the forge will not say.
//
// The two inputs are taken apart deliberately: the predicate is the identity's,
// so a case that varied only the arm would be asserting nothing.
const RESUMED_IDENTITY: RunIdentity = {
  _tag: "FeedbackResume",
  resumed: { _tag: "OneOff", spec: "T99" },
  resumedRunId: Option.some("speepobox-t3-1786000000000"),
};

const INLINE_TASK: Task = { _tag: "Inline", text: "fix the note", feedback: Option.none() };

const planWith = (fields: { readonly task: Task; readonly identity: RunIdentity }): DispatchPlan =>
  planFor({
    ...fields,
    branch: BRANCH,
    baseRef: "origin/master",
    baseSha: BASE_SHA,
    mergeBaseSha: MERGE_BASE_SHA,
    tipSha: PLAN_TIP,
    runtimeRoot: "/runtime",
    startedAt: DateTime.unsafeMake("2026-01-01T00:00:00.000Z"),
  });

const asked = (
  plan: DispatchPlan,
  options: FakeForgeOptions,
): Effect.Effect<
  {
    readonly context: Option.Option<PrContext>;
    readonly calls: ReadonlyArray<ForgeCall>;
    readonly events: ReadonlyArray<ReporterEvent>;
  },
  never
> =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<ForgeCall>>([]);
    const events = yield* Ref.make<ReadonlyArray<ReporterEvent>>([]);
    const context = yield* prContextFor(plan, TEST_FORGE_REPO).pipe(
      Effect.provide(
        Layer.merge(
          fakeForge(calls, options),
          Layer.succeed(Reporter, {
            emit: (event) => Ref.update(events, (current) => [...current, event]),
          }),
        ),
      ),
    );
    return { context, calls: yield* Ref.get(calls), events: yield* Ref.get(events) };
  });

describe("the PR context a resuming pass is handed", () => {
  it.effect("quotes the title and body the forge answered with", () =>
    Effect.gen(function* () {
      const result = yield* asked(planWith({ task: INLINE_TASK, identity: RESUMED_IDENTITY }), {
        existing: VIEWED_PR,
      });
      expect(result.context).toEqual(Option.some({ title: VIEWED_PR.title, body: VIEWED_PR.body }));
      expect(result.calls).toEqual([{ _tag: "View", branch: BRANCH }]);
    }),
  );

  // **The widening T66 makes** (22 §5): the PR body is what the human read
  // before they wrote the feedback, and that is as true when the spec is still
  // on disk as when it is gone. T17 asked on the text arm alone because an
  // ordinary implement message had no place to put the section.
  it.effect("asks on a resume whose spec is still there, too", () =>
    Effect.gen(function* () {
      const result = yield* asked(
        planWith({ task: specDispatch("T99").task, identity: RESUMED_IDENTITY }),
        { existing: VIEWED_PR },
      );
      expect(result.context).toEqual(Option.some({ title: VIEWED_PR.title, body: VIEWED_PR.body }));
      expect(result.calls).toEqual([{ _tag: "View", branch: BRANCH }]);
    }),
  );

  // Degraded and said out loud, never fatal: the run has everything it needs
  // to do the work — the dispatcher's own words — and loses one context
  // section (run.sh's `gh pr view` fetch, non-fatal there for the same reason).
  it.effect("warns and runs without the section when the forge will not answer", () =>
    Effect.gen(function* () {
      const result = yield* asked(planWith({ task: INLINE_TASK, identity: RESUMED_IDENTITY }), {
        viewFails: "gh: server error (HTTP 502)",
      });
      expect(result.context).toEqual(Option.none());
      const warnings = result.events.flatMap((event) =>
        event._tag === "Warned" ? [event.detail] : [],
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("HTTP 502");
      expect(warnings[0]).toContain("without its title and body");
    }),
  );

  // A branch whose PR was never opened is the same absence, and no warning:
  // there is nothing wrong with a resume having no PR to quote.
  it.effect("carries no section, and no complaint, when the branch has no PR", () =>
    Effect.gen(function* () {
      const result = yield* asked(planWith({ task: INLINE_TASK, identity: RESUMED_IDENTITY }), {});
      expect(result.context).toEqual(Option.none());
      expect(result.calls).toEqual([{ _tag: "View", branch: BRANCH }]);
      expect(result.events).toEqual([]);
    }),
  );

  // And never on a fresh dispatch, whichever arm it is on: the branch may
  // already have a PR, and its body describes work this run supersedes — which
  // is misleading context rather than missing context (22 §5).
  it.effect("asks nothing at all on a fresh dispatch, on either arm", () =>
    Effect.gen(function* () {
      const fresh = specDispatch("T99");
      // The third pair is T67's own: a `--task` dispatch, where both halves —
      // the arm and the identity — are the inline ones, and the forge is still
      // never asked, because what makes a run ask is that it resumes.
      for (const dispatched of [
        fresh,
        { task: INLINE_TASK, identity: fresh.identity },
        inlineDispatch("fix the note"),
      ]) {
        const result = yield* asked(planWith(dispatched), { existing: VIEWED_PR });
        expect(result.context).toEqual(Option.none());
        expect(result.calls).toEqual([]);
        expect(result.events).toEqual([]);
      }
    }),
  );
});

describe("dispatch preflight", () => {
  // T44's own refusal, first in preflight and before docker (T45): the tests
  // T44's commit did not write. `Stale` is scripted by giving
  // `rev-list HEAD..<base> --` a nonzero-length stdout — the same call
  // `happyScript` already answers empty, matched by prefix ahead of the
  // pathspec (`packagePathspec` renders relative to each test's own scratch
  // repo root).
  const MISSING_SHA = "7777777777777777777777777777777777777777";
  const staleScript = {
    ...happyScript,
    [`${inRepo(REPO_WORKTREE)} rev-list HEAD..origin/master --`]: {
      exit: 0,
      stdout: `${MISSING_SHA}\n`,
    },
  };

  it.scoped("refuses a stale dispatcher before docker is asked anything, holding nothing", () =>
    Effect.gen(function* () {
      const result = yield* attempt({ script: staleScript });
      expect(refusal(result)._tag).toBe("StaleDispatcher");
      expect(result.commands.some((command) => command.startsWith("docker"))).toBe(false);
      yield* heldNothing(result);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // The refusal exists to tell a dispatcher what went wrong and what to do
  // (T45): the missing commit, the branch they are on — read off the
  // worktree `happyScript` already answers ("branch refs/heads/master") —
  // and the command that fixes it, plus the override sentence naming the
  // flag. And nothing was mutated getting there: no clone, no branch, no
  // config write (`heldNothing` covers the first two; the identity write is
  // the one it does not pattern-match, so it is asserted here).
  it.scoped("names the missing commit, the branch, and the fix command in the refusal", () =>
    Effect.gen(function* () {
      const result = yield* attempt({ script: staleScript });
      const failure = refusal(result);
      expect(failure.detail).toContain(MISSING_SHA);
      expect(failure.detail).toContain("You are on 'master'");
      expect(failure.detail).toContain("git checkout master");
      expect(failure.detail).toContain("--allow-stale-dispatcher");
      expect(result.commands.some((command) => command.includes("config --local"))).toBe(false);
      yield* heldNothing(result);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // The other half of the same sentence, and the reason it is worth a case of
  // its own: "You are on ..." is filled from the worktree list, and on a
  // detached HEAD there is no branch to fill it with. `parseWorktrees` reads
  // that as the *absence* of a `branch` line rather than the presence of git's
  // `detached` marker, so the fixture prints what real git prints and the
  // parse still has to find nothing. The fix command is unchanged: where to go
  // is not a function of where you are.
  it.scoped("reads a detached HEAD as one, rather than as a branch named nothing", () =>
    Effect.gen(function* () {
      const result = yield* attempt({
        script: {
          ...staleScript,
          [`${inRepo(REPO_WORKTREE)} worktree list --porcelain`]: {
            exit: 0,
            stdout: `worktree ${REPO_WORKTREE}\nHEAD ${BASE_SHA}\ndetached\n`,
          },
        },
      });
      const failure = refusal(result);
      expect(failure._tag).toBe("StaleDispatcher");
      expect(failure.detail).toContain("You are on 'a detached HEAD'");
      expect(failure.detail).toContain("git checkout master");
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // Not a refusal (T44): a base this clone cannot read is the operator's to
  // fix, so the check warns and the rest of preflight — and the run — goes
  // ahead. What it tells them to fix is the base and not their refs (T70):
  // the dispatch fetched `origin` two steps above this check, so a warning
  // asking for a `git fetch` would be asking for the one thing that already
  // happened — the same dead advice `resolveBaseSha` dropped.
  it.scoped("warns and proceeds when the base does not resolve in this clone", () =>
    Effect.gen(function* () {
      const result = yield* attempt({
        script: {
          ...happyScript,
          [`${inRepo(REPO_WORKTREE)} rev-list HEAD..origin/master --`]: {
            exit: 1,
            stderr: "fatal: bad revision 'origin/master'\n",
          },
        },
      });
      expect(Either.isRight(result.outcome)).toBe(true);
      const warned = result.events.filter((event) => event._tag === "Warned");
      const unresolvable = warned.filter((event) =>
        event.detail.includes("does not resolve in this clone"),
      );
      expect(unresolvable.length).toBe(1);
      expect(unresolvable[0]?.detail).toBe(
        "'origin/master' does not resolve in this clone even after fetching origin, so the dispatcher-freshness check has nothing to compare against — check the configured base",
      );
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped(
    "--allow-stale-dispatcher proceeds past a Stale verdict with a warning, recorded on the row",
    () =>
      Effect.gen(function* () {
        const result = yield* attempt({
          request: { allowStaleDispatcher: true },
          script: staleScript,
        });
        expect(Either.isRight(result.outcome)).toBe(true);
        const warned = result.events.filter((event) => event._tag === "Warned");
        expect(warned.some((event) => event.detail.includes("--allow-stale-dispatcher"))).toBe(
          true,
        );
        expect(result.appended[0]?.staleDispatcherOverridden).toEqual(Option.some(true));
      }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped("writes no staleDispatcherOverridden key on a run that never overrides the check", () =>
    Effect.gen(function* () {
      const result = yield* attempt();
      expect(Either.isRight(result.outcome)).toBe(true);
      expect(result.appended[0]?.staleDispatcherOverridden).toEqual(Option.none());
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // Acceptance criterion (T60): freshness is a self-hosted question. The
  // scripted git here would answer `Stale` — the same script that refuses
  // above — and the question is never put to it, so there is no `rev-list`,
  // no warning, and no refusal. Under the shim the dispatcher is a pinned SHA
  // and no branch of the served repo chooses it (09), so there is nothing to
  // be stale relative to; asking anyway renders a pathspec that leaves the
  // served repo and warns about the base (19 §4).
  it.scoped("asks the freshness question of nothing when the dispatch is not self-hosted", () =>
    Effect.gen(function* () {
      const result = yield* attempt({ selfHosted: false, script: staleScript });
      expect(Either.isRight(result.outcome)).toBe(true);
      expect(result.commands.some((command) => command.includes("rev-list HEAD.."))).toBe(false);
      expect(
        result.events.filter(
          (event) => event._tag === "Warned" && event.detail.includes("dispatcher"),
        ),
      ).toEqual([]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // And the flag that overrides the refusal has nothing to override there: the
  // run proceeds exactly as it does without it, and records no override — the
  // row would otherwise claim a check was overridden that never ran.
  it.scoped("--allow-stale-dispatcher does nothing at all when not self-hosted", () =>
    Effect.gen(function* () {
      const result = yield* attempt({
        selfHosted: false,
        request: { allowStaleDispatcher: true },
        script: staleScript,
      });
      expect(Either.isRight(result.outcome)).toBe(true);
      expect(
        result.events.some(
          (event) => event._tag === "Warned" && event.detail.includes("--allow-stale-dispatcher"),
        ),
      ).toBe(false);
      expect(result.commands.some((command) => command.includes("rev-list HEAD.."))).toBe(false);
      // And nothing on the row: `staleDispatcherOverridden` records an override
      // that happened, so a run whose preflight never asked the question writes
      // no such key — exactly the row an ordinary run writes (T44).
      expect(result.appended[0]?.staleDispatcherOverridden).toEqual(Option.none());
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // `doctor`'s probe 11 (T129) is `doctor`-only: the preflight reuses
  // `doctor`'s probes, and this one never joins it, so no dispatch waits on
  // the network for advice — self-hosted or not.
  it.scoped("spawns no ls-remote, self-hosted or not", () =>
    Effect.gen(function* () {
      for (const selfHosted of [true, false]) {
        const result = yield* attempt({ selfHosted });
        expect(Either.isRight(result.outcome)).toBe(true);
        expect(result.commands.filter((command) => command.includes("ls-remote"))).toEqual([]);
      }
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped("reports a dead docker daemon as a typed failure holding nothing", () =>
    Effect.gen(function* () {
      const result = yield* attempt({ script: { ...happyScript, "docker info": { exit: 1 } } });
      expect(refusal(result)._tag).toBe("DockerUnavailable");
      expect(refusal(result).detail).toContain("daemon not responding");
      yield* heldNothing(result);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped("reports a missing image as a typed failure holding nothing", () =>
    Effect.gen(function* () {
      const result = yield* attempt({
        script: { ...happyScript, "docker image inspect": { exit: 1 } },
      });
      expect(refusal(result)._tag).toBe("ImageUnavailable");
      expect(refusal(result).detail).toContain("not found locally");
      yield* heldNothing(result);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // `gh` auth, the probe T3 deliberately left out and T12's `Forge` brought
  // in: it is `doctor`'s probe 6, called here rather than reimplemented, and
  // it refuses at the same point the other two do — before the lock, and with
  // the whole run still unstarted.
  it.scoped("reports an unauthenticated gh as a typed failure holding nothing", () =>
    Effect.gen(function* () {
      const result = yield* attempt({
        script: { ...happyScript, "gh auth status": { exit: 1 } },
      });
      expect(refusal(result)._tag).toBe("GhUnavailable");
      expect(refusal(result).detail).toContain("gh auth login");
      expect(renderFailure(refusal(result) as DispatchFailure)).toEqual(
        Option.some("!! gh: not authenticated — run `gh auth login`"),
      );
      yield* heldNothing(result);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // The setup hook is config-declared (T7), so a config that names a script
  // this host does not have is bad input like any other: refused before the
  // container that would have run it exists, holding nothing. The two cases
  // above are its neighbours because all three answer "does this run have what
  // it needs" — and this one answers it without asking docker anything.
  it.scoped("refuses a setup hook the config names but the host does not have", () =>
    Effect.gen(function* () {
      const result = yield* attempt({ config: { setupHook: ".agentbox/setup.sh" } });
      expect(refusal(result)._tag).toBe("GuardRefused");
      expect(refusal(result).detail).toContain("setup hook not found");
      expect(refusal(result).detail).toContain(`${result.repoRoot}/.agentbox/setup.sh`);
      expect(result.commands.some((command) => command.startsWith("docker"))).toBe(false);
      yield* heldNothing(result);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // A directory is not a script, and the mount would have been a silently
  // empty one — docker invents a directory at a bind source it cannot find.
  it.scoped("refuses a setup hook that names a directory", () =>
    Effect.gen(function* () {
      const result = yield* attempt({ config: { setupHook: "tasks" } });
      expect(refusal(result)._tag).toBe("GuardRefused");
      expect(refusal(result).detail).toContain("setup hook not found");
      yield* heldNothing(result);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped("takes an absolute setup hook path as-is", () =>
    Effect.gen(function* () {
      const result = yield* attempt({ config: { setupHook: "/nowhere/setup.sh" } });
      expect(refusal(result).detail).toContain("setup hook not found: /nowhere/setup.sh");
      yield* heldNothing(result);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // The guard's other arm, which the three refusals above cannot see: a hook
  // the host *does* have passes, and the run behind it mounts the script
  // read-only and runs it there. An existence check inverted the other way
  // refuses every real config and still turns all of them green.
  it.scoped("dispatches a setup hook the host has, mounting and running it", () =>
    Effect.gen(function* () {
      const result = yield* attempt({
        config: { setupHook: ".agentbox/setup.sh" },
        repoFiles: [".agentbox/setup.sh"],
        script: { ...happyScript, "docker exec": { exit: 0 } },
      });
      expect(Either.isRight(result.outcome)).toBe(true);
      const target = `${SETUP_HOOK_DIR}/setup.sh`;
      const docker = result.commands.filter((command) => command.startsWith("docker"));
      expect(docker.at(-3)).toContain(`-v ${result.repoRoot}/.agentbox/setup.sh:${target}:ro`);
      expect(docker.at(-2)).toBe(`docker exec ${CONTAINER_ID} bash ${target}`);
      expect(docker.at(-1)).toBe(`docker rm -fv ${CONTAINER_ID}`);
      // A completed run: the hook is a step the dispatch passed through, not a
      // resource it holds and not an outcome of its own.
      expect(result.appended).toHaveLength(1);
      expect(result.appended[0]?.terminalReason).toEqual(Option.some({ _tag: "Completed" }));
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // The container's env file (T61), which is the setup hook's ruling with one
  // more arm on it: the key names a file docker reads into the container, so a
  // declared value that this host does not have is refused at the door like
  // any other bad input — before the lock, with no ledger row.
  it.scoped("refuses a sandbox env file the config names but the host does not have", () =>
    Effect.gen(function* () {
      const result = yield* attempt({ config: { sandboxEnvFile: ".speepobox/env.sandbox" } });
      expect(refusal(result)._tag).toBe("GuardRefused");
      expect(refusal(result).detail).toContain("sandbox env file not found");
      expect(refusal(result).detail).toContain(`${result.repoRoot}/.speepobox/env.sandbox`);
      // Which of the three it was, and under which key.
      expect(refusal(result).detail).toContain("sandbox-env-file");
      expect(result.commands.some((command) => command.startsWith("docker"))).toBe(false);
      yield* heldNothing(result);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // And the arm `tasks-dir` and `setup-hook` do not have: an absolute value is
  // refused rather than taken as-is, because this file's *contents* enter the
  // sandbox and the file has to stay where review sees it (19 §5).
  it.scoped("refuses an absolute sandbox env file instead of resolving it", () =>
    Effect.gen(function* () {
      const result = yield* attempt({ config: { sandboxEnvFile: "/etc/secrets/.env" } });
      expect(refusal(result)._tag).toBe("GuardRefused");
      expect(refusal(result).detail).toContain("sandbox-env-file");
      expect(refusal(result).detail).toContain("is an absolute path");
      // Refused, not stat'd: the message names the value, never a path under
      // the repo it was never resolved against.
      expect(refusal(result).detail).not.toContain(`${result.repoRoot}/etc`);
      yield* heldNothing(result);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped("refuses a sandbox env file that escapes the repo after normalization", () =>
    Effect.gen(function* () {
      const result = yield* attempt({ config: { sandboxEnvFile: "a/../../.env" } });
      expect(refusal(result)._tag).toBe("GuardRefused");
      expect(refusal(result).detail).toContain("sandbox-env-file");
      expect(refusal(result).detail).toContain("leaves the repo");
      yield* heldNothing(result);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // The guard's other arm, and the run behind it: a declared file the host has
  // reaches docker as one `--env-file`, resolved against the served repo. What
  // is *in* the file never appears anywhere — this process never opened it.
  it.scoped("hands docker the declared env file, resolved against the served repo", () =>
    Effect.gen(function* () {
      const result = yield* attempt({
        config: { sandboxEnvFile: ".speepobox/env.sandbox" },
        repoFiles: [".speepobox/env.sandbox"],
      });
      expect(Either.isRight(result.outcome)).toBe(true);
      const run = result.commands.find((command) => command.startsWith("docker run")) ?? "";
      expect(run).toContain(`--env-file ${result.repoRoot}/.speepobox/env.sandbox`);
      // The allowlist is unchanged beside it: the credential's name with no
      // value (T23), and the three constants of git's workspace trust.
      expect(run.match(/ -e /g)).toHaveLength(4);
      expect(run).toContain(`-e ${TEST_CREDENTIAL.name} -e GIT_CONFIG_COUNT=1`);
      // And the file's contents are in no command this run spawned. The
      // harness writes every repo file the same line, which is why the check
      // is worth making here: docker was told the path, and that is all.
      for (const command of result.commands) {
        expect(command).not.toContain("# elsewhere");
      }
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // The credential (T23), and it is the setup hook's ruling applied to the one
  // thing every run needs: a missing one is a guard's answer, not a
  // container's. Until this ticket the run took the lock, cloned, started a
  // container, delivered the prompt, and read back
  // `Not logged in · Please run /login` — three held resources spent on a
  // question that was answerable at the door.
  it.scoped("refuses a dispatch with no credential anywhere, before anything is held", () =>
    Effect.gen(function* () {
      const result = yield* attempt({ credential: Option.none() });
      expect(refusal(result)._tag).toBe("GuardRefused");
      // Probe 3's advice, word for word: one answer behind both refusals.
      expect(refusal(result).detail).toContain("no LLM API credential");
      expect(refusal(result).detail).toContain("claude setup-token");
      expect(refusal(result).detail).toContain(".env beside config.toml");
      // Before the lock, so there is no ledger row (SPEC §11) — and before
      // dockerd was asked anything at all.
      expect(result.commands.some((command) => command.startsWith("docker"))).toBe(false);
      yield* heldNothing(result);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // The forge repo (T39), on the credential's own shape: an `origin` that
  // could not be read into an owner/repo is a guard's refusal, naming the
  // repo root, and never a `gh` error about a missing ref from a call that
  // fell back to wherever the process happened to start.
  it.scoped(
    "refuses a dispatch whose forge repo could not be resolved, before anything is held",
    () =>
      Effect.gen(function* () {
        const result = yield* attempt({ forgeRepo: Option.none() });
        expect(refusal(result)._tag).toBe("GuardRefused");
        expect(refusal(result).detail).toContain(result.repoRoot);
        expect(refusal(result).detail).toContain("origin");
        expect(result.commands.some((command) => command.startsWith("docker"))).toBe(false);
        yield* heldNothing(result);
      }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // The other arm, and the whole point of the ticket: the credential the
  // composition root resolved reaches the container it was resolved for. It
  // crosses as `-e NAME` with no value — the token goes to the `docker`
  // child's own environment (`test/sandbox.test.ts` asserts that half against
  // the real layer) and never into argv, which every command log keeps.
  it.scoped("forwards the resolved credential by name, with its value nowhere in argv", () =>
    Effect.gen(function* () {
      const result = yield* attempt();
      expect(Either.isRight(result.outcome)).toBe(true);
      const run = result.commands.find((command) => command.startsWith("docker run"));
      expect(run).toContain(`-e ${TEST_CREDENTIAL.name}`);
      for (const command of result.commands) {
        expect(command).not.toContain(CREDENTIAL_CANARY);
      }
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // The reconciler joins the two probes above, for the same reason they are
  // here: it is preflight, not a resource (T8). A previous run of *another*
  // branch was hard-killed, so its lock records a pid that is gone and its
  // container is still up — all three go, and every one of them goes before
  // this dispatch resolves a plan or acquires anything of its own.
  it.scoped("reclaims a dead run's wreckage before this run's scope opens", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const result = yield* attempt({
        script: {
          ...happyScript,
          "docker ps": { exit: 0, stdout: `${WRECK_CONTAINER}\tspeepobox-${WRECK}\trunning\n` },
        },
        leaveBehind: leftByTheDeadRun,
      });

      expect(Either.isRight(result.outcome)).toBe(true);
      expect(yield* fs.exists(lockPathFor(result.runtimeRoot, WRECK))).toBe(false);
      expect(yield* fs.exists(checkoutPathFor(result.runtimeRoot, WRECK))).toBe(false);
      // The copy went because a read said this repository holds what was in
      // it, and the read named both ends (T38): the tip in the dead run's
      // copy, the ancestry here.
      expect(result.commands).toContain(
        `${inRepo(checkoutPathFor(result.runtimeRoot, WRECK))} rev-parse --verify refs/heads/${WRECK}`,
      );
      expect(result.commands).toContain(
        `${inRepo(result.repoRoot)} merge-base --is-ancestor ${WRECK_TIP} refs/heads/${WRECK}`,
      );
      // Before the `Scope`: the reclaim's `docker rm` precedes the run's own
      // `docker run`, and its report precedes the resolved plan.
      const docker = result.commands.filter((command) => command.startsWith("docker"));
      expect(docker.indexOf(`docker rm -fv ${WRECK_CONTAINER}`)).toBeLessThan(
        docker.findIndex((command) => command.startsWith("docker run")),
      );
      const reclaimed = result.events.findIndex(
        (event) =>
          event._tag === "Warned" && event.detail.includes(`reclaiming the wreckage of '${WRECK}'`),
      );
      expect(reclaimed).toBeGreaterThanOrEqual(0);
      expect(reclaimed).toBeLessThan(
        result.events.findIndex((event) => event._tag === "PlanResolved"),
      );
      // And this run's own row is the only one: a reclaim is a `Reporter`
      // event, and the run it cleaned up after writes nothing more (T8 §5).
      expect(result.appended).toHaveLength(1);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // A refusal touches nothing (matrix row 1), and this pass is the first thing
  // a dispatch does that would: every guard sits above it, so wreckage a
  // refused dispatch found is still there for the next one that gets further.
  it.scoped("leaves the wreckage where it is when a guard above it refuses", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const script = { ...happyScript };
      delete script[`${inRepo(REPO_WORKTREE)} rev-parse --verify origin/master^{commit}`];
      const result = yield* attempt({
        script: {
          ...script,
          [`${inRepo(REPO_WORKTREE)} rev-parse --verify`]: { exit: 1 },
          "docker ps": { exit: 0, stdout: `${WRECK_CONTAINER}\tspeepobox-${WRECK}\texited\n` },
        },
        leaveBehind: leftByTheDeadRun,
      });

      expect(refusal(result)._tag).toBe("GuardRefused");
      expect(yield* fs.readFileString(lockPathFor(result.runtimeRoot, WRECK))).toBe(
        `${DEAD_PID}\n`,
      );
      expect(yield* fs.exists(checkoutPathFor(result.runtimeRoot, WRECK))).toBe(true);
      // Not even asked: the reconciler never ran, so dockerd was never queried
      // and nothing of that dead run's was removed.
      for (const command of result.commands) {
        expect(command).not.toMatch(/^docker (ps|rm)\b/);
      }
      expect(result.appended).toEqual([]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // A reconcile that cannot ask dockerd reclaims nothing and reports — it does
  // not fail the dispatch it is preflighting. The check that *can* refuse one
  // is `docker info` above, and it passed.
  it.scoped("dispatches anyway when the reconciler cannot ask dockerd what it holds", () =>
    Effect.gen(function* () {
      const result = yield* attempt({
        script: { ...happyScript, "docker ps": { exit: 1, stderr: "daemon not responding\n" } },
      });
      expect(Either.isRight(result.outcome)).toBe(true);
      const warned = result.events.filter((event) => event._tag === "Warned");
      expect(warned).toHaveLength(1);
      expect(warned[0]?.detail).toContain("could not ask dockerd");
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped("passes doctor's image-input warning through and dispatches anyway", () =>
    Effect.gen(function* () {
      // An image declaring an input whose contents on disk hash to something
      // else. The file is written under **this dispatch's** repo root and not
      // under a toplevel scripted separately — the probe hashes the repo it was
      // handed (T27), so the comparison is the test's own to arrange.
      const result = yield* attempt({
        repoFiles: ["api/requirements.txt"],
        script: {
          ...happyScript,
          "docker image inspect": {
            exit: 0,
            stdout: `api/requirements.txt\n${"0".repeat(64)}\n`,
          },
        },
      });
      expect(Either.isRight(result.outcome)).toBe(true);
      const warned = result.events.filter((event) => event._tag === "Warned");
      expect(warned).toHaveLength(1);
      expect(warned[0]?.detail).toContain("rebuild");
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // The other half of the same row, and the reason the warning above is worth
  // reading: an image that matches says nothing at all here, exactly as the
  // undeclared image every other case in this file scripts says nothing.
  it.scoped("says nothing when the image matches the dependency files it declares", () =>
    Effect.gen(function* () {
      // The digest of the one declared input as the harness writes it — a repo
      // file holds "# elsewhere\n" — computed as T30 §4 spells it.
      const result = yield* attempt({
        repoFiles: ["api/requirements.txt"],
        script: {
          ...happyScript,
          "docker image inspect": {
            exit: 0,
            stdout:
              "api/requirements.txt\n2ec96f00e03050099a1f9884fce32b499457602a85e5d604fbc37ab3c8f584a3\n",
          },
        },
      });
      expect(Either.isRight(result.outcome)).toBe(true);
      expect(result.events.filter((event) => event._tag === "Warned")).toEqual([]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
});

describe("plan derivation", () => {
  it("slugs a branch the way bash does", () => {
    expect(slugFor("speepobox-t3")).toBe("speepobox-t3");
    expect(slugFor("Feature/Some_Thing")).toBe("feature-some-thing");
    expect(slugFor("--wrapped--")).toBe("wrapped");
  });

  it("keys the container, checkout, and lock off the same slug", () => {
    const slug = slugFor("Feature/X");
    expect(containerIdFor(slug)).toBe("speepobox-feature-x");
    expect(checkoutPathFor("/runtime", slug)).toBe("/runtime/checkouts/feature-x");
    expect(lockPathFor("/runtime", slug)).toBe("/runtime/locks/feature-x.pid");
  });

  it("keys the log off the run id, not the slug", () => {
    expect(logPathFor("/runtime", "feature-x-1700000000000")).toBe(
      "/runtime/logs/feature-x-1700000000000.log",
    );
  });

  it("resolves bare spec names under the tasks dir and paths as-is", () => {
    expect(specPathFor("/runtime/tasks", "T3")).toBe("/runtime/tasks/T3.md");
    expect(specPathFor("/runtime/tasks", "T3.md")).toBe("/runtime/tasks/T3.md");
    expect(specPathFor("/runtime/tasks", "docs/plan.md")).toBe("docs/plan.md");
    expect(specPathFor("/runtime/tasks", "docs/plan")).toBe("docs/plan.md");
  });

  // `specPathFor`'s rule above without the `.md`, and the answer rendered
  // repo-relative: that is what the plan, the row, and every message carry, and
  // what `IssueStore` reads a ref under (T73).
  it("resolves a feature folder like a spec, minus the suffix, and repo-relative", () => {
    expect(featureFolderFor("/srv/hae", "/srv/hae/tasks", "f")).toBe("tasks/f");
    expect(featureFolderFor("/srv/hae", "/srv/hae/tasks", "docs/queue")).toBe("docs/queue");
    // A trailing separator is a slash like any other, so it takes the path arm
    // — the same answer `specPathFor` gives `tasks/T3/`, and the reason the
    // rule is about the *directory* rather than about the shape of the name.
    expect(featureFolderFor("/srv/hae", "/srv/hae/tasks", "docs/queue/")).toBe("docs/queue");
    // A slash-form value anchors to the repo root rather than to wherever the
    // process was started, which is what bash gets by `cd`-ing there first.
    expect(featureFolderFor("/srv/hae", "/srv/hae/tasks", "./docs/queue")).toBe("docs/queue");
  });

  // The plan banner names all three arms the same way — a phrase in quotes —
  // and on the feature arm the phrase is the folder (T73).
  it("names a feature dispatch by its folder", () => {
    expect(
      taskNamed({
        _tag: "Feature",
        folder: "tasks/f",
        selection: { request: { _tag: "All" }, issues: [fakeIssue("T70")] },
        feedback: Option.none(),
      }),
    ).toBe("'tasks/f'");
  });

  it("compares --base against --branch with the origin/ prefix stripped", () => {
    expect(stripOriginPrefix("origin/master")).toBe("master");
    expect(stripOriginPrefix("master")).toBe("master");
    expect(namesTheSameRef("topic", "origin/topic")).toBe(true);
    expect(namesTheSameRef("topic", "origin/master")).toBe(false);
    expect(isProtectedBranch("master")).toBe(true);
    expect(isProtectedBranch("mastermind")).toBe(false);
  });
});

// The resume half (T16), pure and near-pure: which target the flags name,
// what the ledger's answer means, and the decision table. The wired dispatch
// is asserted through `attempt`/`attemptCli` above; these are the pieces that
// need no world at all.
const ledgerAnswering = (
  answer: Either.Either<ResumeResolution, LedgerError>,
): Layer.Layer<Ledger> =>
  Layer.succeed(Ledger, {
    append: () => Effect.die("this case writes no row"),
    recent: () => Effect.succeed([]),
    lastBaseForBranch: () => Effect.succeed(Option.none()),
    resolveResume: () => Either.match(answer, { onLeft: Effect.fail, onRight: Effect.succeed }),
    newestBranchForIssue: () => Effect.die("this case dispatches no feature"),
  });

const RESUMABLE: ResumeResolution = {
  _tag: "Resumable",
  branch: BRANCH,
  identity: { _tag: "OneOff", spec: "T3" },
  resumedRunId: Option.some("speepobox-t3-1786000000000"),
  base: Option.some("origin/release"),
};

const resumeTarget = (flags: { resume: Option.Option<string>; last: boolean }) =>
  Effect.runSync(Effect.either(resumeTargetFor(flags)));

describe("the resume target", () => {
  it("reads --resume and --last as the same target, never as two paths", () => {
    expect(resumeTarget({ resume: Option.some(BRANCH), last: false })).toEqual(
      Either.right(Option.some({ _tag: "Branch", branch: BRANCH })),
    );
    expect(resumeTarget({ resume: Option.none(), last: true })).toEqual(
      Either.right(Option.some({ _tag: "Last" })),
    );
    // Neither flag: an ordinary dispatch, which is every case above this
    // describe.
    expect(resumeTarget({ resume: Option.none(), last: false })).toEqual(
      Either.right(Option.none()),
    );
    // An empty value is no branch at all, as `--branch ''` is.
    expect(resumeTarget({ resume: Option.some("  "), last: false })).toEqual(
      Either.right(Option.none()),
    );
  });

  it("refuses --resume and --last together rather than silently picking one", () => {
    const outcome = Effect.runSync(
      Effect.either(resumeTargetFor({ resume: Option.some(BRANCH), last: true })),
    );
    expect(Either.isLeft(outcome)).toBe(true);
    if (Either.isLeft(outcome)) {
      expect(outcome.left._tag).toBe("GuardRefused");
      expect(outcome.left.detail).toContain("--last already means --resume");
    }
  });
});

describe("resume resolution", () => {
  it.effect("hands the recovered run straight through", () =>
    Effect.gen(function* () {
      expect(yield* resumeResolved({ _tag: "Branch", branch: BRANCH })).toEqual(RESUMABLE);
    }).pipe(Effect.provide(ledgerAnswering(Either.right(RESUMABLE)))),
  );

  it.effect("refuses a branch with no record, naming the branches the ledger knows", () =>
    Effect.gen(function* () {
      const outcome = yield* Effect.either(
        resumeResolved({ _tag: "Branch", branch: "never-dispatched" }),
      );
      expect(Either.isLeft(outcome)).toBe(true);
      if (Either.isLeft(outcome)) {
        expect(outcome.left._tag).toBe("GuardRefused");
        expect(outcome.left.detail).toBe(
          `no ledger record for branch 'never-dispatched' — recent branches in the ledger:\n  ${BRANCH}\n  ${WRECK}`,
        );
      }
    }).pipe(
      Effect.provide(
        ledgerAnswering(Either.right({ _tag: "NoRecord", knownBranches: [BRANCH, WRECK] })),
      ),
    ),
  );

  it.effect("refuses --last on an empty ledger with bash's own line", () =>
    Effect.gen(function* () {
      const outcome = yield* Effect.either(resumeResolved({ _tag: "Last" }));
      expect(Either.isLeft(outcome)).toBe(true);
      if (Either.isLeft(outcome)) {
        expect(outcome.left.detail).toBe("--last: no runs recorded yet — dispatch normally first");
      }
    }).pipe(Effect.provide(ledgerAnswering(Either.right({ _tag: "NoRecord", knownBranches: [] })))),
  );

  // The ledger degrades the same way it degrades `status` and the `--base`
  // chain: one line naming the read that failed, never a Cause dump. There is
  // no fallback to degrade onto — the identity exists nowhere else — so the
  // line is a refusal that holds nothing.
  it.effect("turns an unreadable ledger into the same one-line refusal", () =>
    Effect.gen(function* () {
      const outcome = yield* Effect.either(resumeResolved({ _tag: "Branch", branch: BRANCH }));
      expect(Either.isLeft(outcome)).toBe(true);
      if (Either.isLeft(outcome)) {
        expect(outcome.left._tag).toBe("GuardRefused");
        expect(outcome.left.detail).toContain("the ledger could not be read (runs.jsonl: EACCES)");
      }
    }).pipe(
      Effect.provide(
        ledgerAnswering(Either.left(new LedgerError({ detail: "runs.jsonl: EACCES" }))),
      ),
    ),
  );

  it("recovers the mode off the tag, and every arm of it", () => {
    expect(Effect.runSync(resumedTask(BRANCH, { _tag: "OneOff", spec: "T3" }))).toEqual({
      _tag: "Spec",
      spec: "T3",
    });
    // The arm T67 added: the recorded text itself, which is what a resume of a
    // `--task` run replays (chart row 8).
    expect(
      Effect.runSync(resumedTask(BRANCH, { _tag: "InlineTask", task: "fix the release note" })),
    ).toEqual({ _tag: "Inline", text: "fix the release note" });
    // The arm T78 opened: the recorded folder, and every recorded id but the
    // approved ones, in the order the row holds them.
    expect(
      Effect.runSync(
        resumedTask(BRANCH, {
          _tag: "Feature",
          feature: "tasks/f",
          issues: [
            { issue: "T70", outcome: "approved" },
            { issue: "T71", outcome: "needs-work" },
            { issue: "T72", outcome: "implement-failed" },
            { issue: "T73", outcome: "not-attempted" },
          ],
        }),
      ),
    ).toEqual({ _tag: "Feature", folder: "tasks/f", ids: ["T71", "T72", "T73"] });
    // And T89's: a set with nothing left, where `--feedback` stands in.
    expect(
      Effect.runSync(
        resumedTask(
          BRANCH,
          { _tag: "Feature", feature: "tasks/f", issues: [{ issue: "T70", outcome: "approved" }] },
          Option.none(),
          Option.some("tidy the docs"),
        ),
      ),
    ).toEqual({
      _tag: "FeedbackStandsIn",
      folder: "tasks/f",
      issues: [{ issue: "T70", outcome: "approved" }],
      text: "tidy the docs",
    });
  });
});

// Bash's four outcomes collapse to three before the move (08 §3), and the
// table lands whole. T16 wrote all three arms; T17 is what makes the middle
// one reachable, and the arm now carries the feedback it decided on rather
// than a flag saying there was some.
describe("the resume decision table", () => {
  const FEEDBACK = "rename the flag and update the release note";

  it("rides the ordinary path when the resumed spec still resolves", () => {
    expect(
      resumeDispatchAction({
        spec: "T3",
        resolved: Option.some("/repo/tasks/T3.md"),
        feedback: Option.none(),
      }),
    ).toEqual({ _tag: "Normal", spec: "/repo/tasks/T3.md" });
    // Feedback changes nothing while the spec is there: a resume with
    // follow-up instructions is still an ordinary run of that spec.
    expect(
      resumeDispatchAction({
        spec: "T3",
        resolved: Option.some("/repo/tasks/T3.md"),
        feedback: Option.some(FEEDBACK),
      }),
    ).toEqual({ _tag: "Normal", spec: "/repo/tasks/T3.md" });
  });

  it("lets what was said stand in when the spec is gone and the dispatcher said it", () => {
    expect(
      resumeDispatchAction({
        spec: "T3",
        resolved: Option.none(),
        feedback: Option.some(FEEDBACK),
      }),
    ).toEqual({ _tag: "FeedbackStandsIn", text: FEEDBACK });
  });

  it("refuses when the spec is gone and nothing was said", () => {
    const action = resumeDispatchAction({
      spec: "T3",
      resolved: Option.none(),
      feedback: Option.none(),
    });
    expect(action._tag).toBe("Refuse");
    if (action._tag === "Refuse") {
      expect(action.detail).toContain("the resumed spec is no longer on disk: T3");
    }
  });
});

// What counts as having said something (T17). One filter, before anything
// reads the flag, so "was there feedback" has a single answer.
describe("the --feedback value", () => {
  it("keeps what the dispatcher typed, trimmed of the shell's own newline", () => {
    expect(feedbackGiven(Option.some("  fix the retry loop\n"))).toEqual(
      Option.some("fix the retry loop"),
    );
  });

  it("reads an empty or blank --feedback as nothing said", () => {
    expect(feedbackGiven(Option.some(""))).toEqual(Option.none());
    expect(feedbackGiven(Option.some("  \n "))).toEqual(Option.none());
    expect(feedbackGiven(Option.none())).toEqual(Option.none());
  });
});

// The same filter at the same door (T67), so "was a task stated" has one
// answer below it. What an empty one *means* is the guard's, which reads the
// flag as typed — by the time this has run the two cases are one value.
describe("the --task value", () => {
  it("keeps what the dispatcher typed, trimmed of the shell's own newline", () => {
    expect(taskGiven(Option.some("  fix the release note\n"))).toEqual(
      Option.some("fix the release note"),
    );
  });

  it("reads an empty or blank --task as nothing stated", () => {
    expect(taskGiven(Option.some(""))).toEqual(Option.none());
    expect(taskGiven(Option.some("  \n "))).toEqual(Option.none());
    expect(taskGiven(Option.none())).toEqual(Option.none());
  });
});

// The same filter at the same door, one flag over (T73): what `--issues`
// named, trimmed and emptiness-filtered **once**, so nothing below ever has to
// ask about a blank id (T69 §1).
describe("the --issues value", () => {
  it("reads the wide form in any case a dispatcher types it", () => {
    for (const given of ["all", "ALL", " All\n"]) {
      expect(issuesRequested(Option.some(given))).toEqual(Option.some({ _tag: "All" }));
    }
  });

  it("trims each id and drops the ones that named nothing", () => {
    expect(issuesRequested(Option.some("T70, ,T71 ,"))).toEqual(
      Option.some({ _tag: "Enumerated", ids: ["T70", "T71"] }),
    );
  });

  // A flag that named nothing at all is `None` here and a *refusal* at the
  // guard — not a selection of nothing, which is unrepresentable.
  it("reads a flag that named nothing as nothing named", () => {
    for (const given of ["", "   ", ",", " , ,"]) {
      expect(issuesRequested(Option.some(given))).toEqual(Option.none());
    }
    expect(issuesRequested(Option.none())).toEqual(Option.none());
  });
});

// One summary, two call sites (T67): the plan banner and `status`'s source
// cell. A multi-line task is its first line; an over-long first line is cut
// with an ellipsis; the whole text stays on the row and in the run log.
describe("the summary of a task stated inline", () => {
  it("keeps a short one-line task whole", () => {
    expect(taskSummary("fix the release note")).toBe("fix the release note");
  });

  it("cuts a multi-line task to its first line", () => {
    expect(taskSummary("fix the release note\n\nthen re-run verify")).toBe("fix the release note");
  });

  it("cuts an over-long first line with an ellipsis, and at one width", () => {
    const long = "f".repeat(TASK_SUMMARY_WIDTH + 20);
    const summary = taskSummary(long);
    expect(summary).toHaveLength(TASK_SUMMARY_WIDTH);
    expect(summary.endsWith("…")).toBe(true);
    // The boundary itself: a line exactly the width is not cut.
    expect(taskSummary("f".repeat(TASK_SUMMARY_WIDTH))).toHaveLength(TASK_SUMMARY_WIDTH);
    expect(taskSummary("f".repeat(TASK_SUMMARY_WIDTH))).not.toContain("…");
  });

  // The banner is this summary quoted, so the block and the screen cannot
  // drift on how much of the task they show.
  it("is what the plan banner names the arm with no path by", () => {
    const text = "fix the release note\nand re-run verify";
    expect(taskNamed({ _tag: "Inline", text, feedback: Option.none() })).toBe(
      `'${taskSummary(text)}'`,
    );
  });
});

// A `FeedbackResume` wrapping whichever dispatch the ledger handed back, which
// is what every resume's identity is (T16).
const resumeOf = (resumed: DispatchIdentity): RunIdentity => ({
  _tag: "FeedbackResume",
  resumed,
  resumedRunId: Option.none(),
});

describe("dispatch rendering", () => {
  const plan: DispatchPlan = {
    ...specDispatch("/runtime/tasks/T3.md"),
    branch: "speepobox-t3",
    baseRef: "origin/master",
    baseSha: BASE_SHA,
    mergeBaseSha: MERGE_BASE_SHA,
    tipSha: PLAN_TIP,
    reset: Option.none(),
    slug: "speepobox-t3",
    containerId: "speepobox-speepobox-t3",
    checkoutPath: "/runtime/checkouts/speepobox-t3",
    logPath: Option.some("/runtime/logs/speepobox-t3-1700000000000.log"),
    runId: "speepobox-t3-1700000000000",
  };

  it("renders the plan block bash prints under --dry-run", () => {
    expect(renderPlan(plan)).toBe(
      [
        "speepobox: '/runtime/tasks/T3.md' on branch 'speepobox-t3'  |  base origin/master @ 1111111111",
        "  mode:          one-off (spec)",
        "  branch:        speepobox-t3",
        "  base:          origin/master @ 1111111111",
        `  diff boundary: ${MERGE_BASE_SHA}`,
        "  container:     speepobox-speepobox-t3",
        "  checkout path: /runtime/checkouts/speepobox-t3",
        "  log path:      /runtime/logs/speepobox-t3-1700000000000.log",
      ].join("\n"),
    );
  });

  // The arm with no path to print (T66, given its summary by T67): the banner
  // says what the run is for in the words the plan has for it. Every other row
  // is a fact about the run, so none of them moves.
  it("names an inline task on the arm that has no path", () => {
    const inline = renderPlan({ ...plan, ...inlineDispatch("fix the release note") });
    expect(inline).toContain("speepobox: 'fix the release note' on branch 'speepobox-t3'");
    expect(inline).not.toContain("/runtime/tasks/T3.md");
    expect(inline).toContain("  container:     speepobox-speepobox-t3");
  });

  // The mode line SPEC §7:428 specified and nothing rendered until T67: the two
  // facts the passes are framed by, neither of which the rest of the block
  // says. Five spellings here, and the sixth — *feature* — below (T73).
  it("names the mode in each of the five spellings T67 prints", () => {
    const modeOf = (fields: { readonly task: Task; readonly identity: RunIdentity }): string =>
      renderPlan({ ...plan, ...fields })
        .split("\n")
        .find((line) => line.startsWith("  mode:"))
        ?.replace(/^ {2}mode: +/, "") ?? "";
    const spec: Task = { _tag: "Spec", path: "/runtime/tasks/T3.md", feedback: Option.none() };
    const inline: Task = { _tag: "Inline", text: "fix the note", feedback: Option.none() };
    expect(modeOf({ task: spec, identity: { _tag: "OneOff", spec: "/runtime/tasks/T3.md" } })).toBe(
      "one-off (spec)",
    );
    expect(modeOf(inlineDispatch("fix the note"))).toBe("one-off (inline task)");
    expect(modeOf({ task: spec, identity: resumeOf({ _tag: "OneOff", spec: "T3" }) })).toBe(
      "resume (spec)",
    );
    // Chart row 8 and chart row 6 are the one pair the arm cannot tell apart —
    // both are a resume whose task is text — so the identity underneath the
    // `FeedbackResume` is what separates them.
    expect(
      modeOf({ task: inline, identity: resumeOf({ _tag: "InlineTask", task: "fix the note" }) }),
    ).toBe("resume (inline task)");
    expect(modeOf({ task: inline, identity: resumeOf({ _tag: "OneOff", spec: "T99" }) })).toBe(
      "resume (feedback stands in for the missing spec)",
    );
    // §7's eighth (T89): the same arm again, under a feature row whose set
    // is exhausted.
    expect(
      modeOf({
        task: inline,
        identity: resumeOf({ _tag: "Feature", feature: "tasks/f", issues: [] }),
      }),
    ).toBe("resume (feedback stands in for the exhausted issue set)");
  });

  // §7's sixth spelling, and the row beside it (T73). The ids are what a
  // dispatcher checks a command line by, so they go on one line in T69's
  // order; the two arms without a set print no such row at all.
  it("names the feature mode and the selection it resolved", () => {
    const block = renderPlan({
      ...plan,
      ...featureDispatch("tasks/f", {
        request: { _tag: "Enumerated", ids: ["T71", "T70"] },
        issues: [fakeIssue("T70"), fakeIssue("T71")],
      }),
    }).split("\n");
    expect(block[0]).toContain("speepobox: 'tasks/f' on branch 'speepobox-t3'");
    expect(block[1]).toBe("  mode:          feature");
    expect(block[2]).toBe("  issues:        T70 T71 (2)");
    expect(renderPlan(plan)).not.toContain("issues:");
  });

  // §7's seventh (T78): the same arm under a resume says it resumes, keyed off
  // the identity as the spec arm's is, and the row lists the replayed ids.
  it("names a resumed feature run as one", () => {
    const block = renderPlan({
      ...plan,
      ...resumedFeatureDispatch(
        "tasks/f",
        {
          request: { _tag: "Enumerated", ids: ["T71"] },
          issues: [fakeIssue("T71")],
        },
        Option.none(),
        Option.none(),
      ),
    }).split("\n");
    expect(block[1]).toBe("  mode:          resume (feature)");
    expect(block[2]).toBe("  issues:        T71 (1)");
  });

  // T101: a hard reset's plan says what it will throw away, on one row under
  // the boundary — which is the base, since the base is the effective tip.
  // origin is named only when origin had the branch.
  it("renders the fork-point row under a hard reset, and no such row without one", () => {
    const reset = (originTip: Option.Option<string>): DispatchPlan => ({
      ...plan,
      mergeBaseSha: BASE_SHA,
      tipSha: BASE_SHA,
      reset: Option.some({ discardedTip: PLAN_TIP, discarding: 3, originTip }),
    });
    const block = renderPlan(reset(Option.some(MERGE_BASE_SHA))).split("\n");
    expect(block[4]).toBe(`  diff boundary: ${BASE_SHA}`);
    expect(block[5]).toBe(
      "  fork point:    hard reset to origin/master — discards 3 commit(s) on 'speepobox-t3' and origin/speepobox-t3 (reflog-recoverable only)",
    );
    expect(renderPlan(reset(Option.none()))).toContain(
      "  fork point:    hard reset to origin/master — discards 3 commit(s) on 'speepobox-t3' (reflog-recoverable only)",
    );
    expect(renderPlan(plan)).not.toContain("fork point:");
  });

  // T48: a rehearsal's plan carries no log path, and the block says so rather
  // than printing a path nothing will write.
  it("says there is no log on a rehearsal's plan, rather than a path nothing writes", () => {
    expect(renderPlan({ ...plan, logPath: Option.none() })).toContain(
      "  log path:      no log — this is a rehearsal",
    );
  });

  it("renders a refusal as one line, and a parser error as none", () => {
    expect(renderFailure(new GuardRefused({ detail: "nope" }))).toEqual(Option.some("!! nope"));
    // doctor's probe text says which check failed in the row's label column;
    // a one-line refusal has none, so the renderer supplies it.
    expect(renderFailure(new DockerUnavailable({ detail: "daemon not responding" }))).toEqual(
      Option.some("!! docker: daemon not responding"),
    );
    expect(renderFailure(new ImageUnavailable({ detail: "'x' not found locally" }))).toEqual(
      Option.some("!! image: 'x' not found locally"),
    );
    // A held lock names its own subject, as a GuardRefused does; the lock file
    // we could not write does not, so the renderer supplies the column.
    expect(renderFailure(new LockHeld({ detail: "another speepobox run (pid 42) …" }))).toEqual(
      Option.some("!! another speepobox run (pid 42) …"),
    );
    expect(renderFailure(new LockError({ detail: "locks/x.pid: EACCES" }))).toEqual(
      Option.some("!! lock: locks/x.pid: EACCES"),
    );
    // A failed clone names its own subject too, so it takes no label either.
    expect(renderFailure(new GitError({ detail: "could not clone 'topic' into /x" }))).toEqual(
      Option.some("!! could not clone 'topic' into /x"),
    );
    // An unusable client override names its own subject too. This is the line a
    // reviewer sees when they empty a prompt file by hand, so it is asserted
    // here rather than left to the manual host-only pass.
    expect(
      renderFailure(
        new PromptUnusable({ detail: "the implement prompt at /c/implement.md is empty" }),
      ),
    ).toEqual(Option.some("!! the implement prompt at /c/implement.md is empty"));
    // appLiveFor's decode failure reaches the same one line, and its detail is a
    // provider-chain dump that never says which file it came from.
    expect(
      renderFailure(new ConfigError({ detail: "(Invalid data at max-review-rounds)" })),
    ).toEqual(Option.some("!! config: (Invalid data at max-review-rounds)"));
    // The `--repo-root` peel's refusal is the one member that precedes every
    // command rather than belonging to the dispatch surface (T60), and it
    // reaches the same one line: it names its own subject, so it takes no
    // label either.
    expect(
      renderFailure(
        new RepoRootRefused({
          detail: "--repo-root must be an absolute path, and '../hae' is not",
        }),
      ),
    ).toEqual(Option.some("!! --repo-root must be an absolute path, and '../hae' is not"));
    // `@effect/cli` printed its own help doc already; a second line would
    // double-report it.
    expect(renderFailure({ _tag: "MissingValue" } as never)).toEqual(Option.none());
  });
});

// T86: the three refusals that mean an answer is missing, not wrong. Each is
// an `AnswerMissing` carrying the step it wants and the request as parsed, in
// today's words and with nothing spawned. Every other refusal stays a plain
// `GuardRefused`, which the picker never opens for.
describe("an answer missing (T86)", () => {
  const missing = (result: Attempt): AnswerMissing => {
    const error = refusal(result);
    expect(error).toBeInstanceOf(AnswerMissing);
    if (!(error instanceof AnswerMissing)) {
      throw new Error(`expected an AnswerMissing, got: ${error.detail}`);
    }
    return error;
  };

  it.scoped("wants the branch when <spec> has no --branch, and carries the request", () =>
    Effect.gen(function* () {
      const result = yield* attempt({ request: { branch: Option.none() } });
      const error = missing(result);
      expect(error.step).toBe("branch");
      expect(error.request.spec).toEqual(Option.some("T3"));
      expect(error.detail).toBe(
        "--branch is required — the working branch. Create it first: git branch <name> [<start>]",
      );
      // Rendered exactly as the GuardRefused it was before.
      expect(renderFailure(error)).toEqual(
        Option.some(
          "!! --branch is required — the working branch. Create it first: git branch <name> [<start>]",
        ),
      );
      spawnedNothing(result);
      yield* heldNothing(result);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped("wants the source when --branch has nothing to dispatch", () =>
    Effect.gen(function* () {
      const result = yield* attempt({ request: { spec: Option.none() } });
      const error = missing(result);
      expect(error.step).toBe("source");
      expect(error.request.branch).toEqual(Option.some(BRANCH));
      spawnedNothing(result);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped("wants the issues when --feature has no --issues", () =>
    Effect.gen(function* () {
      const result = yield* attempt({
        request: { spec: Option.none(), feature: Option.some(FOLDER) },
      });
      expect(missing(result).step).toBe("issues");
      spawnedNothing(result);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped("wants the source when --issues has nothing it could narrow", () =>
    Effect.gen(function* () {
      const result = yield* attempt({
        request: { spec: Option.none(), issues: Option.some("T70") },
      });
      expect(missing(result).step).toBe("source");
      spawnedNothing(result);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // Before the editor, which is where the source check used to sit behind.
  it.scoped("wants the source with --feedback-edit before any editor opens", () =>
    Effect.gen(function* () {
      const result = yield* attempt({
        isTTY: true,
        request: { spec: Option.none(), feedbackEdit: true },
      });
      expect(missing(result).step).toBe("source");
      spawnedNothing(result);
      yield* heldNothing(result);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // A flag typed with nothing in it is what was typed: the same words, and no
  // question about it.
  it.scoped("leaves an empty --branch, <spec>, or --issues a plain refusal", () =>
    Effect.gen(function* () {
      for (const request of [
        { branch: Option.some("  ") },
        { spec: Option.some("") },
        { spec: Option.none(), issues: Option.some(" , ") },
      ] satisfies ReadonlyArray<Partial<DispatchRequest>>) {
        const result = yield* attempt({ request });
        expect(refusal(result)._tag).toBe("GuardRefused");
        expect(refusal(result)).not.toBeInstanceOf(AnswerMissing);
      }
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // Two of something is refused, never asked about — even with the branch
  // missing too.
  it.scoped("refuses two tasks as two tasks, with no question to ask", () =>
    Effect.gen(function* () {
      const result = yield* attempt({
        request: { task: Option.some("x"), branch: Option.none() },
      });
      expect(refusal(result).detail).toBe(
        "--task and <spec> are two tasks — a spec and inline text; state one, not both",
      );
      expect(refusal(result)).not.toBeInstanceOf(AnswerMissing);
      spawnedNothing(result);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // --issues beside a spec or a task has a source already: asking would
  // answer the source step with it and drop --issues from the words.
  it.scoped("refuses --issues beside <spec> or --task, with no question to ask", () =>
    Effect.gen(function* () {
      for (const request of [
        { issues: Option.some("T70") },
        { spec: Option.none(), task: Option.some("x"), issues: Option.some("T70") },
      ] satisfies ReadonlyArray<Partial<DispatchRequest>>) {
        const result = yield* attempt({ request });
        expect(refusal(result).detail).toBe(
          "--issues names the issues of a feature or narrows a resume — pass --feature <folder> beside it, or --resume <branch>",
        );
        expect(refusal(result)).not.toBeInstanceOf(AnswerMissing);
        spawnedNothing(result);
      }
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped("parses --no-input onto the request the error carries", () =>
    Effect.gen(function* () {
      const result = yield* attemptCli(["T3", "--no-input"]);
      expect(Either.isLeft(result.outcome)).toBe(true);
      if (Either.isLeft(result.outcome)) {
        expect(result.outcome.left).toBeInstanceOf(AnswerMissing);
        if (result.outcome.left instanceof AnswerMissing) {
          expect(result.outcome.left.request.noInput).toBe(true);
        }
      }
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
});

// The guards' helper names the git dir too (T133): a served repo root that
// holds no repository refuses, rather than finding the branch in the repo
// enclosing it.
describe("the guards, pointed at a directory that is not a repository", () => {
  it.scoped("refuse rather than answer for the repo enclosing it", () =>
    Effect.gen(function* () {
      const { repo, nested } = yield* repoWithNestedDir;
      yield* branchExists(repo, "main");
      const refused = yield* Effect.flip(branchExists(nested, "main"));
      expect(refused).toBeInstanceOf(GuardRefused);
    }).pipe(Effect.provide(NodeContext.layer)),
  );
});
