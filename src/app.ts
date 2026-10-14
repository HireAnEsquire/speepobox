import { Terminal } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import pc from "picocolors";
import { type AgentCli, AgentCliLive } from "./agent/agent-cli.ts";
import { type PromptSource, promptSourceLiveFor } from "./agent/prompt-source.ts";
import { renderAgentEvent } from "./agent/render.ts";
import {
  SpeepoboxConfig,
  speepoboxConfigLiveFor,
  type ConfigError,
  defaultConfigFor,
  loadConfig,
} from "./config/config.ts";
import { renderPlan } from "./dispatch/render.ts";
import { AgentCliRecordingLive } from "./dry-run/agent-cli.ts";
import { ForgeRecordingLive } from "./dry-run/forge.ts";
import { GitRecordingLive } from "./dry-run/git.ts";
import { IssueStoreRecordingLive } from "./dry-run/issue-store.ts";
import { LedgerRecordingLive } from "./dry-run/ledger.ts";
import { NotifierRecordingLive } from "./dry-run/notifier.ts";
import { PromptRecordingLive } from "./dry-run/prompt.ts";
import { RunLockRecordingLive } from "./dry-run/run-lock.ts";
import { SandboxRecordingLive } from "./dry-run/sandbox.ts";
import { renderProbeRow } from "./doctor/render.ts";
import { renderGc } from "./gc/render.ts";
import { renderInit } from "./init/render.ts";
import { renderUpgrade } from "./upgrade/render.ts";
import { type Forge, ForgeLive } from "./forge/forge.ts";
import { type Git, GitLive } from "./git/git.ts";
import { type IssueStore, IssueStoreLive } from "./issues/issue-store.ts";
import { type Ledger, LedgerLive } from "./ledger/ledger.ts";
import { type RunLock, RunLockLive } from "./lock/run-lock.ts";
import { type Notifier, NotifierLive } from "./notify/notifier.ts";
import { PromptClackLive } from "./prompt/clack.ts";
import type { Prompt } from "./prompt/prompt.ts";
import { Reporter, type ReporterEvent } from "./reporter.ts";
import {
  issuePrefix,
  renderBranchReset,
  renderElapsed,
  renderImageBuildOutput,
  renderPushed,
  renderResetPushed,
  renderSetupOutput,
  renderStatusCommitted,
} from "./run-log.ts";
import { type Sandbox, SandboxLive } from "./sandbox/sandbox.ts";
import { renderStatus } from "./status/render.ts";

// Under `WARN  `, so a wrapped warning's continuation lines sit under its
// first word. A blank line inside one stays blank rather than carrying the
// indent — trailing whitespace is invisible until it lands in a diff.
const WARN_CONTINUATION = " ".repeat("WARN  ".length);

// The console subscriber: one place that turns events into text, so a command
// never writes to stdout itself.
const renderConsoleEvent = (event: ReporterEvent): string => {
  switch (event._tag) {
    case "ProbeChecked":
      return renderProbeRow(event);
    // A warning is sometimes a whole recovery rather than a sentence: a kept
    // copy of the repository is the one event a dispatcher has to act on, and
    // the commands that recover it do not fit on a line. The console prints it
    // whole, indenting the continuation under the label so the block reads as
    // one message; the run log summarizes it back to a line. That is the same
    // one-event-two-renderers split `PromptAssembled` already establishes, and
    // it is why the newlines live in the detail rather than in a second field.
    case "Warned":
      return event.detail
        .split("\n")
        .map((line, index) =>
          index === 0 ? `WARN  ${line}` : line === "" ? "" : `${WARN_CONTINUATION}${line}`,
        )
        .join("\n");
    case "StatusReported":
      return renderStatus(event.snapshot);
    case "GcReported":
      return renderGc(event.snapshot);
    case "InitReported":
      return renderInit(event.snapshot);
    case "UpgradeReported":
      return renderUpgrade(event.snapshot);
    // The rehearsal's own line (T15), under `would  ` for the reason a warning
    // sits under `WARN  `: a dry run's console is the plan block followed by
    // the mutations it did not perform, and the two read as one column.
    case "MutationRecorded":
      return `would  ${event.detail}`;
    case "PlanResolved":
      return renderPlan(event.plan);
    case "ResourceAcquired":
      return `${event.resource}: acquired`;
    case "ResourceReleased":
      return `${event.resource}: released`;
    case "BranchReset":
      return renderBranchReset(event);
    // The six events a pass emits, in `agent/render.ts` (T54): the rules that
    // bracket a pass, what the agent says and does while it runs, and the
    // watch's two lines. They move together because they are one vocabulary —
    // the console's, which is a screen, against the log's, which is a record
    // and keeps its own `agent | ` / `agent > ` wording.
    //
    // `pc` is picocolors' default instance: it detects the TTY and honours
    // `NO_COLOR` on its own, and this file adds no detection. The renderer
    // takes it as an argument so both screens are assertable from a test.
    case "PromptAssembled":
    case "AgentOutput":
    case "PassStillRunning":
    case "NoWritesYet":
    case "AgentPassFinished":
    case "PassFailed":
      return renderAgentEvent(event, pc);
    // The setup hook (T90): each line as it arrives, as a pass's narration is,
    // under the log's own `setup` label, then the line that says the run has
    // moved on — or, red as a failed pass is, why it has not.
    case "SetupOutput":
      return renderSetupOutput(event);
    // `image build`'s docker output (T111), line by line as it arrives.
    case "ImageBuildOutput":
      return renderImageBuildOutput(event);
    case "SetupFinished":
      return `setup hook finished (${renderElapsed(event.elapsed)})`;
    case "SetupFailed":
      return pc.red(`setup hook failed: ${event.detail}`);
    // Which issue the round was about in front of it (T76), through the one
    // spelling the log and `agent/render.ts` read as well.
    case "ReviewVerdictReached":
      return `${issuePrefix(event.issue)}review round ${event.round.index}/${event.round.of}: ${event.verdict}`;
    case "CommitsPushed":
      return renderPushed(event);
    case "StatusCommitted":
      return renderStatusCommitted(event);
    case "NothingToLand":
      return "nothing to land — no commits past the diff boundary";
    case "ResetPushed":
      return renderResetPushed(event);
    // The line bash ends a landing on (`run.sh:1723`), and the one a
    // dispatcher actually clicks. Draft, always: the human merge gate is the
    // point of the tool.
    case "PullRequestReady":
      return event.action === "created"
        ? `draft PR opened: ${event.pr.url}`
        : `PR updated: ${event.pr.url}`;
  }
};

export const ReporterConsoleLive: Layer.Layer<Reporter> = Layer.succeed(Reporter, {
  emit: (event) =>
    Effect.sync(() => {
      process.stdout.write(`${renderConsoleEvent(event)}\n`);
    }),
});

// A prompt needs a terminal at both ends (T94). The platform's `Terminal`
// answers `isTTY` from stdout alone, so a redirected stdin with the screen
// still attached read as a terminal and the picker drew itself over input
// nobody could type. bash asks `[ -t 0 ]` (`run.sh:752`, `run.sh:1296`).
// Whether stdin is a terminal is a host read, so `bin.ts` makes it and it
// arrives here as a parameter; this layer is the platform's `Terminal` with
// `isTTY` answering for both ends and every other member passed through.
//
// It is provided *over* the platform, so its `Terminal` is the one that
// survives the merge. The other way round typechecks and overrides nothing —
// `test/terminal.test.ts` pins which way it is.
const terminalAnsweringFor = (
  stdinIsTTY: boolean,
): Layer.Layer<Terminal.Terminal, never, Terminal.Terminal> =>
  Layer.effect(
    Terminal.Terminal,
    Effect.map(Terminal.Terminal, (platform) =>
      Terminal.Terminal.of({
        ...platform,
        isTTY: Effect.map(platform.isTTY, (stdoutIsTTY) => stdoutIsTTY && stdinIsTTY),
      }),
    ),
  );

export const PlatformAndReporterLive = (
  stdinIsTTY: boolean,
): Layer.Layer<NodeContext.NodeContext | Reporter> =>
  Layer.mergeAll(
    Layer.provideMerge(terminalAnsweringFor(stdinIsTTY), NodeContext.layer),
    ReporterConsoleLive,
  );

// The read-only slice's config layer. It differs from speepoboxConfigLiveFor in
// exactly one way: a failed decode degrades to the committed defaults instead
// of dying at layer build, because the three read-only commands are
// intercepted before any preflight (03 §1.1) and must work when the thing they
// inspect — the config included — is broken. doctor still *reports* the failed
// decode as probe 7, which runs its own decode.
//
// The served repo is a parameter of every composition below, which is why they
// are functions of `repoRoot` rather than constants (T57). T27's objection to
// `GitLive(repoRoot)` does not reach them: it refused a host fact inside a
// layer `status` composes without ever asking git anything, where the config
// layer already reads the host filesystem at a root, and which root that is is
// the fact that says which repo is served.
const speepoboxConfigTolerantLiveFor = (
  repoRoot: string,
): Layer.Layer<SpeepoboxConfig, never, NodeContext.NodeContext> =>
  Layer.effect(
    SpeepoboxConfig,
    loadConfig(repoRoot).pipe(Effect.orElseSucceed(() => defaultConfigFor(repoRoot))),
  );

// The read-only slice of appLiveFor: platform services, Reporter, and Ledger —
// `status` and `doctor` run on this. Ledger is here rather than in a
// per-command layer because 05 Q21 rejects per-subcommand layers; the two
// compositions below are the same expression twice, differing only in which
// config layer they take.
//
// `GitLive` joins the merge for `doctor`'s git probe (T39): it needs nothing
// but a `CommandExecutor`, which `PlatformAndReporterLive` already supplies,
// and `status` gains no new dependency by its presence — SPEC §7 still runs
// no git commands, it simply now *could*.
export const appBaseLiveFor = (
  repoRoot: string,
  stdinIsTTY: boolean,
): Layer.Layer<Git | Ledger | SpeepoboxConfig | Reporter | NodeContext.NodeContext> =>
  Layer.provideMerge(
    Layer.mergeAll(LedgerLive, GitLive),
    Layer.provideMerge(
      speepoboxConfigTolerantLiveFor(repoRoot),
      PlatformAndReporterLive(stdinIsTTY),
    ),
  );

// The one appLiveFor (05 Q21): wired at the entrypoint and provided to every
// subcommand that goes through flag parsing and preflight (the dispatch
// surface, T3+). Building it decodes the config exactly once — a malformed
// config fails here, at startup, before a run exists.
//
// `SandboxLive`, `GitLive`, `RunLockLive`, `ForgeLive`, `NotifierLive`,
// `IssueStoreLive`, and `promptSourceLiveFor` depend on nothing of each
// other's — each needs exactly what the first two do, a `CommandExecutor`, or
// what the config/platform stack below already provides — so they merge at the
// same level over that stack rather than stacking. `IssueStoreLive` speaks git
// and is handed its own `Git` inside itself (T71), which is why it sits beside
// `GitLive` rather than over it: a term in a `mergeAll` provides nothing to
// its neighbours. The prompt layer takes the served repo rather than the
// config (T59), which is the same parameter every composition here already
// has. `appBaseLiveFor` above stays byte-unchanged as each of them lands:
// `status` and `doctor` gain no dependency on a lock, a git binary, a docker
// daemon, `gh`, a host that can raise a notification — they notify nobody
// (T13) — the served repo's prompt overrides (T14), or an issue set read out
// of a ref (T71), or a `Prompt`: `PromptClackLive` joins the merge for
// `--hard-reset`'s confirm (T102), the one question a dispatch puts to a
// person, and `status`, `doctor`, and `gc` ask nobody anything.
// `AgentCli` runs its passes *through* `Sandbox` and takes their prompts from
// `PromptSource`, so `AgentCliLive` is provided **after** the merged resource
// layer rather than inside it (T9, T14).
export const appLiveFor = (
  repoRoot: string,
  stdinIsTTY: boolean,
): Layer.Layer<
  | AgentCli
  | PromptSource
  | Forge
  | Notifier
  | Sandbox
  | Git
  | IssueStore
  | RunLock
  | Ledger
  | SpeepoboxConfig
  | Reporter
  | NodeContext.NodeContext
  | Prompt,
  ConfigError
> =>
  Layer.provideMerge(
    AgentCliLive,
    Layer.provideMerge(
      Layer.mergeAll(
        SandboxLive,
        GitLive,
        RunLockLive,
        ForgeLive,
        NotifierLive,
        IssueStoreLive,
        promptSourceLiveFor(repoRoot),
        PromptClackLive,
      ),
      Layer.provideMerge(
        LedgerLive,
        Layer.provideMerge(speepoboxConfigLiveFor(repoRoot), PlatformAndReporterLive(stdinIsTTY)),
      ),
    ),
  );

// The rehearsal (T15, 05 Q20, SPEC §11 design rule 5): the same expression as
// `appLiveFor`, differing only in which service layers are recording — the shape
// `appBaseLiveFor` above already establishes, where one term differs and nothing
// else moves. `--dry-run` runs the **same dispatch effect** against this, so
// every guard, the whole `--base` chain, the preflight, the plan derivation,
// the ordering of the scope's three resources, and the create-vs-update
// decision are the ones a real run gets. What differs is that the seven
// mutating layers say what they would have done (`MutationRecorded`) instead
// of doing it. `IssueStoreRecordingLive` is the eighth term that differs and
// not an eighth of those: every operation on that tag is a read today, so it
// holds nothing back and records nothing (T71). It is swapped now so both
// expressions gain the tag in the same commit and the write T77 adds has a
// term to land in. `PromptRecordingLive` stands where `PromptClackLive` does
// (T102, D4): a rehearsal discards nothing, so it records the confirm a real
// run would have asked and answers yes, and the guard asking never learns
// which of the two it asked.
//
// The prompt layer is deliberately *not* swapped: it is read-only, and a
// rehearsal that stopped resolving prompts would rehearse the wrong thing —
// which template won is exactly what a dispatcher runs one to see.
//
// **What the swap does not reach**: the filesystem. SPEC §2 uses `FileSystem`
// directly and wraps nothing, so a write that does not stand behind a tag
// happens in a dry run as it does in a real one — and one does: the run log
// this dispatch opens for real, exactly as a live run's does (16, T47). The
// `rm -rf` of a dead run's checkout in `dispatch/checkout.ts` and
// `reconcile/reconcile.ts` stands outside the swap too, but **a removal is
// authorized by a read** now (T38) and a recording layer keeps its reads real,
// so a fetch-back that recorded rather than fetched fails the containment
// question and the directory stays. AGENTS.md carries the ruling and SPEC §12
// records what is left of the divergence; a `--dry-run` branch inside those
// ops is the 78 lines this exists to delete.
export const appDryRunLiveFor = (
  repoRoot: string,
  stdinIsTTY: boolean,
): Layer.Layer<
  | AgentCli
  | PromptSource
  | Forge
  | Notifier
  | Sandbox
  | Git
  | IssueStore
  | RunLock
  | Ledger
  | SpeepoboxConfig
  | Reporter
  | NodeContext.NodeContext
  | Prompt,
  ConfigError
> =>
  Layer.provideMerge(
    AgentCliRecordingLive,
    Layer.provideMerge(
      Layer.mergeAll(
        SandboxRecordingLive,
        GitRecordingLive,
        RunLockRecordingLive,
        ForgeRecordingLive,
        NotifierRecordingLive,
        IssueStoreRecordingLive,
        promptSourceLiveFor(repoRoot),
        PromptRecordingLive,
      ),
      Layer.provideMerge(
        LedgerRecordingLive,
        Layer.provideMerge(speepoboxConfigLiveFor(repoRoot), PlatformAndReporterLive(stdinIsTTY)),
      ),
    ),
  );

// `--dry-run`, and the **only** place it is consulted (T15). Everything below
// this line — the parser, every guard, the plan, the scope, every dispatch op
// — sees one dispatch with no flag on it; which layer it runs against is the
// whole of the difference. A dispatch op that branched on the flag would be
// the second implementation `run.sh:1647-1724` already is.
//
// It lives here rather than in `bin.ts` because it owes an assertion and
// nothing in the entrypoint can be asserted (AGENTS.md): importing that file
// runs the CLI. The parser declares the flag as well — `dispatch/command.ts`,
// so `--help` says it exists and an unknown option is still refused — and
// reads nothing off it.
export const DRY_RUN_FLAG = "--dry-run";

// An argv that is **only** modifiers is no args at all — bash's rule
// (`run.sh:752`, `ORIGINAL_ARGC - MODIFIER_ARGC`), and what makes
// `speepobox --dry-run` on a TTY open the picker and rehearse what it picks
// (T81). It lives here rather than in `picker/picker.ts` because that module
// may not name the flag at all (`scripts/check-bans.ts`) and must not: the
// words ride through the picker unread, onto the argv it hands back and onto
// the command line its summary prints.
//
// The empty argv satisfies it too, which is the same statement: no words is
// no arguments.
export const isModifiersOnly = (argv: ReadonlyArray<string>): boolean =>
  argv.every((word) => word === DRY_RUN_FLAG);

// The modifiers a parsed request was typed with, rendered back into words
// (T86): a seeded picker rebuilds its argv from its answers, and the flag
// has to stay on it so `appCompositionFor` still sees it. The parser turned
// `--dry-run` into `keepsLog`, and this is the one place that turns it back,
// because the picker may not name the flag.
export const modifiersFor = (request: { readonly keepsLog: boolean }): ReadonlyArray<string> =>
  request.keepsLog ? [] : [DRY_RUN_FLAG];

// Which of the two compositions the flag picks, as the composition itself
// rather than a layer: two layers built from one expression are different
// objects, so once a root is applied the choice can no longer be compared —
// and the choice is the whole of what this line decides.
export const appCompositionFor = (argv: ReadonlyArray<string>): typeof appLiveFor =>
  argv.includes(DRY_RUN_FLAG) ? appDryRunLiveFor : appLiveFor;

export const appLayerFor = (
  argv: ReadonlyArray<string>,
  repoRoot: string,
  stdinIsTTY: boolean,
): Layer.Layer<
  | AgentCli
  | PromptSource
  | Forge
  | Notifier
  | Sandbox
  | Git
  | IssueStore
  | RunLock
  | Ledger
  | SpeepoboxConfig
  | Reporter
  | NodeContext.NodeContext
  | Prompt,
  ConfigError
> => appCompositionFor(argv)(repoRoot, stdinIsTTY);
