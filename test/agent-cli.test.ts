// `AgentCli` against a scripted docker (fake tier): the argv the pass reached
// the CLI with, the prompt that travelled on stdin rather than in it, the
// events its output became, and matrix rows 8-10 — the three ways a pass ends a
// run, each with its ledger row and its release order.
//
// The layer under test is the real one, over the real `SandboxLive`: what a
// fake `Sandbox` would prove here is that our fake fed our fake, and the whole
// question is which argv and which pipe a pass actually uses.
import { describe, expect, it } from "@effect/vitest";
import { readFileSync } from "node:fs";
import { FileSystem } from "@effect/platform";
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { DateTime, Duration, Effect, Either, Layer, Option, Ref } from "effect";
import {
  AgentCli,
  AgentCliLive,
  agentPassCommand,
  AgentPassFailed,
  agentPassReason,
} from "../src/agent/agent-cli.ts";
import {
  DESCRIBE_PR_PROMPT,
  FEEDBACK_CLOSE,
  FEEDBACK_OPEN,
  IMPLEMENT_PROMPT,
  inlineTaskReviewCriteria,
  packagePromptPath,
  type PrContext,
  PROJECT_CONTEXT_HEADING,
  PROJECT_CONTEXT_PROMPT,
  PROMPTS_DIRNAME,
  promptPathIn,
  renderDescribePrPrompt,
  renderImplementPrompt,
  renderReviewPrompt,
  REVIEW_PROMPT,
  TASK_CLOSE,
  TASK_OPEN,
} from "../src/agent/prompt.ts";
import {
  type PromptRoot,
  promptSourceLiveFor,
  PromptUnusable,
} from "../src/agent/prompt-source.ts";
import { DESCRIPTION_CLOSE, DESCRIPTION_OPEN } from "../src/agent/description.ts";
import { APPROVED_MARKER, FIXED_MARKER, type ReviewRound } from "../src/agent/verdict.ts";
import { BessemerConfig, type BessemerConfigShape, defaultConfig } from "../src/config/config.ts";
import { bessemerDir } from "../src/config/paths.ts";
import { featureDispatch, type DispatchPlan, planFor, specDispatch } from "../src/dispatch/plan.ts";
import { runInScope } from "../src/dispatch/run.ts";
import { Ledger } from "../src/ledger/ledger.ts";
import type { RunRecord } from "../src/ledger/record.ts";
import { RunLockLive } from "../src/lock/run-lock.ts";
import { type AgentPass, Reporter, type ReporterEvent } from "../src/reporter.ts";
import { SandboxLive } from "../src/sandbox/sandbox.ts";
import { TEST_CREDENTIAL } from "./support/credential.ts";
import { TEST_FORGE_REPO } from "./support/repo-slug.ts";
import { type ScriptedResult, scriptedExecutor } from "./support/exec-fake.ts";
import {
  answersWith,
  answersWithError,
  narratesText,
  narratesToolUse,
  RESULT_USAGE,
  streamJson,
} from "./support/stream-json.ts";
import { fakeGit, type GitCall } from "./support/git-fake.ts";
import { fakeForge, viewedPullRequest } from "./support/forge-fake.ts";
import { fakeIssue } from "./support/issue-store-fake.ts";
import { fakeNotifier } from "./support/notifier-fake.ts";
import { PLAN_TIP } from "./support/plan.ts";

const BRANCH = "bessemer-t9";
const CONTAINER_ID = "d15c0ffee1d";
const MERGE_BASE_SHA = "2222222222222222222222222222222222222222";
// What the agent says while it works, as the CLI prints it under
// `--output-format stream-json --verbose` (T51): a tool use and a line of
// prose, because "one event per narration line" is the assertion and the two
// kinds do not render the same.
const NARRATION: ReadonlyArray<string> = [
  narratesToolUse("Read", { file_path: "/spec.md" }),
  narratesText("writing src/agent/agent-cli.ts"),
];

// The close of a pass that answered (T55), carrying the scripted stream's own
// usage. `elapsed` is `Duration.zero` because every case but the timeout runs
// on `TestClock` and none of them advances it: what is asserted is that the
// reading was taken, not that a fake clock ticked.
const passFinished = (pass: AgentPass): ReporterEvent => ({
  _tag: "AgentPassFinished",
  pass,
  issue: Option.none(),
  elapsed: Duration.zero,
  usage: RESULT_USAGE,
});

// The two events that narration becomes, for whichever pass produced it.
const narrationEvents = (pass: AgentPass): ReadonlyArray<ReporterEvent> => [
  { _tag: "AgentOutput", pass, kind: "tool-use", tool: "Read", brief: "/spec.md" },
  { _tag: "AgentOutput", pass, kind: "text", text: "writing src/agent/agent-cli.ts" },
];

// A whole pass on stdout: what it narrated, then the result event its **answer**
// is read from. Every marker a case asserts on goes in that answer, never in a
// text block — narration is progress and nothing is decided by reading it.
const passOutput = (answer: string): string => streamJson(...NARRATION, answersWith(answer));
// What the branch's PR says today, as the forge answered it — the context a
// resuming pass is handed (T17, T66).
const PR: PrContext = { title: "[bessemer] bessemer-t9", body: "## Overview\n\nThe run before." };

const happyScript: Record<string, ScriptedResult> = {
  "docker run": { exit: 0, stdout: `${CONTAINER_ID}\n` },
  "docker rm": { exit: 0 },
  "docker exec": { exit: 0, stdout: passOutput("") },
  // What the daemon says about this container when a failing pass asks (T22).
  // The default is a container that is still there, so a pass that exited
  // nonzero exited on its own; the cases that lose their sandbox say so.
  "docker inspect": { exit: 0, stdout: "true\n" },
};

// The two answers that name matrix row 10: a container the daemon still knows
// and no longer runs, and one it does not know at all because it was removed
// outright. Both are a lost sandbox; only the third reading — `true` — leaves
// the pass its own nonzero exit.
const STOPPED: ScriptedResult = { exit: 0, stdout: "false\n" };
const NO_SUCH_CONTAINER: ScriptedResult = {
  exit: 1,
  stderr: `Error: No such object: ${CONTAINER_ID}\n`,
};

// The whole run, with the three observables SPEC §11 names plus the two this
// ticket adds: what was fed to each child's stdin, and the log file the
// verbatim prompt has to reach. `Git` is a fake — the clone is T18's subject —
// and everything else here is real.
const world = (
  script: Record<string, ScriptedResult> = happyScript,
  config: Partial<BessemerConfigShape> = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const runtimeRoot = yield* fs.makeTempDirectoryScoped();
    const repoRoot = yield* fs.makeTempDirectoryScoped();
    const events = yield* Ref.make<ReadonlyArray<ReporterEvent>>([]);
    const appended = yield* Ref.make<ReadonlyArray<RunRecord>>([]);
    const commands = yield* Ref.make<ReadonlyArray<string>>([]);
    const fed = yield* Ref.make<ReadonlyArray<string>>([]);
    const gitCalls = yield* Ref.make<ReadonlyArray<GitCall>>([]);

    const plan = planFor({
      ...specDispatch(`${repoRoot}/tasks/T9.md`),
      branch: BRANCH,
      baseRef: "origin/master",
      baseSha: "1111111111111111111111111111111111111111",
      mergeBaseSha: MERGE_BASE_SHA,
      tipSha: PLAN_TIP,
      runtimeRoot,
      startedAt: DateTime.unsafeMake("2026-01-01T00:00:00.000Z"),
    });

    const layer = Layer.provideMerge(
      // `AgentCliLive` over the merged resource layer, exactly as `appLiveFor`
      // composes it: a pass runs *through* `Sandbox`, so it cannot be inside
      // the merge beside it.
      AgentCliLive,
      Layer.provideMerge(
        // The prompt layer joins the merge over the same base, exactly as
        // `appLiveFor` composes it (T14): the real chain, over this scratch
        // served repo, so an override is a file a case writes into its
        // `.bessemer/prompts/` (T59).
        Layer.mergeAll(
          SandboxLive,
          RunLockLive,
          fakeGit(gitCalls),
          fakeNotifier(),
          // The run's one pre-push forge question (T17): the best-effort view a
          // resuming pass quotes. Every case here but that one is a fresh
          // dispatch, which never asks it.
          fakeForge(undefined, { existing: viewedPullRequest }),
          promptSourceLiveFor(repoRoot),
        ),
        Layer.mergeAll(
          NodeFileSystem.layer,
          NodePath.layer,
          scriptedExecutor(script, commands, fed),
          Layer.succeed(BessemerConfig, { ...defaultConfig, runtimeRoot, ...config }),
          Layer.succeed(Reporter, {
            emit: (event) => Ref.update(events, (current) => [...current, event]),
          }),
          Layer.succeed(Ledger, {
            append: (record) => Ref.update(appended, (current) => [...current, record]),
            recent: () => Effect.succeed([]),
            lastBaseForBranch: () => Effect.succeed(Option.none()),
            resolveResume: () => Effect.die("an agent pass never resumes"),
            newestBranchForIssue: () => Effect.die("an agent pass dispatches no feature"),
          }),
        ),
      ),
    );

    return { runtimeRoot, repoRoot, plan, events, appended, commands, fed, gitCalls, layer };
  });

const resourceEventsIn = (
  events: ReadonlyArray<ReporterEvent>,
): ReadonlyArray<readonly [string, string]> =>
  events.flatMap((event) =>
    event._tag === "ResourceAcquired" || event._tag === "ResourceReleased"
      ? [[event._tag, event.resource] as const]
      : [],
  );

const dockerIn = (commands: ReadonlyArray<string>): ReadonlyArray<string> =>
  commands.filter((command) => command.startsWith("docker"));

const warningsIn = (events: ReadonlyArray<ReporterEvent>): ReadonlyArray<string> =>
  events.flatMap((event) => (event._tag === "Warned" ? [event.detail] : []));

// Every failure the pass announced (T55). A run that ends in one of matrix
// rows 8-10 emits exactly one, before the `AgentPassFailed` leaves — which is
// what puts it inside the run log's bracket rather than on stderr at exit.
const passFailuresIn = (events: ReadonlyArray<ReporterEvent>) =>
  events.flatMap((event) => (event._tag === "PassFailed" ? [event] : []));

// Everything the watch said (T52). Its first tick is 30 seconds in, so no case
// in this file is long enough to have one — which is the assertion, not an
// accident: the watch is forked into a scope that holds only the exec, and a
// pass that ends takes it with it.
const watchEventsIn = (events: ReadonlyArray<ReporterEvent>) =>
  events.filter((event) => event._tag === "PassStillRunning" || event._tag === "NoWritesYet");

// Where a served repo puts an override: its bessemer directory (T59), derived
// the way the chain derives it.
const overrideIn = (repoRoot: string, name: string): string =>
  promptPathIn(bessemerDir(repoRoot), name);

// A served repo dropping a file into `.bessemer/prompts/` — the whole of an
// override and the whole of the fragment (T14).
const dropIn = (
  repoRoot: string,
  name: string,
  text: string,
): Effect.Effect<void, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(`${bessemerDir(repoRoot)}/${PROMPTS_DIRNAME}`, { recursive: true });
    yield* fs.writeFileString(overrideIn(repoRoot, name), text);
  }).pipe(Effect.orDie);

const promptsIn = (
  events: ReadonlyArray<ReporterEvent>,
): ReadonlyArray<{ readonly root: PromptRoot; readonly prompt: string }> =>
  events.flatMap((event) =>
    event._tag === "PromptAssembled" ? [{ root: event.root, prompt: event.prompt }] : [],
  );

// What the description pass is told to print around its answer
// (`prompts/describe-pr.md`), and what `description.ts` reads back out.
const wrapped = (body: string): string => `${DESCRIPTION_OPEN}\n${body}\n${DESCRIPTION_CLOSE}`;

// The assembled prompt, derived the way the pass derives it: the package
// default plus this run's message. Reading the file here rather than pinning a
// string keeps the assertion about *assembly* rather than about the wording of
// a prompt anyone may improve.
//
// A `DispatchPlan` is all three need: every pass in this file runs without a
// current issue (T75), which is every pass a spec run and an inline one have.
const expectedPrompt = (plan: DispatchPlan): string =>
  renderImplementPrompt(readFileSync(packagePromptPath(IMPLEMENT_PROMPT), "utf8"), plan);

const expectedReviewPrompt = (plan: DispatchPlan, round: ReviewRound): string =>
  renderReviewPrompt(readFileSync(packagePromptPath(REVIEW_PROMPT), "utf8"), plan, round);

const expectedDescribePrompt = (plan: DispatchPlan): string =>
  renderDescribePrPrompt(readFileSync(packagePromptPath(DESCRIBE_PR_PROMPT), "utf8"), plan);

describe("the implement pass", () => {
  // The argv word for word (T51). Every other command assertion in this file
  // spells the pass as `agentPassCommand(defaultConfig.passTimeoutSeconds).join(" ")` — which is what makes them
  // assertions about *the same* argv for all three passes, and what leaves them
  // all green if a flag goes. These three words are the ticket: without them
  // the CLI prints one blob at exit and a killed pass narrates nothing, and
  // `--verbose` is not a preference — the CLI refuses `stream-json` under `-p`
  // without it.
  //
  // And under the backstop (T139): an in-container `timeout` a grace past the
  // budget, so the CLI stops when no dispatcher is left to stop it.
  it("runs the CLI under the stream flags and the backstop, word for word", () => {
    expect(agentPassCommand(1800)).toEqual([
      "timeout",
      "-k",
      "30",
      "1860",
      "claude",
      "--dangerously-skip-permissions",
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
    ]);
  });

  // The backstop follows the budget it backs up: a configured `pass-timeout`
  // moves it, and it stays the grace past that value (T139).
  it.scoped("sets the backstop past a non-default pass budget", () =>
    Effect.gen(function* () {
      const scratch = yield* world(happyScript, { passTimeoutSeconds: 600 });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agent = yield* AgentCli;
          const handle = { name: scratch.plan.containerId, id: CONTAINER_ID };
          yield* agent.implement(handle, scratch.plan, Option.none(), Option.none());
        }),
      ).pipe(Effect.provide(scratch.layer));

      const [pass] = dockerIn(yield* Ref.get(scratch.commands));
      expect(pass).toBe(
        `docker exec -i ${CONTAINER_ID} timeout -k 30 660 claude --dangerously-skip-permissions -p --output-format stream-json --verbose`,
      );
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped("runs the agent CLI in the container, with the prompt on stdin", () =>
    Effect.gen(function* () {
      const scratch = yield* world();
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agent = yield* AgentCli;
          const handle = { name: scratch.plan.containerId, id: CONTAINER_ID };
          yield* agent.implement(handle, scratch.plan, Option.none(), Option.none());
        }),
      ).pipe(Effect.provide(scratch.layer));

      // `-i` so the pipe is open, and no `-d`: the CLI holds the container's
      // process and the fiber that asked is the one waiting for it (SPEC §4).
      const [pass] = dockerIn(yield* Ref.get(scratch.commands));
      expect(pass).toBe(
        `docker exec -i ${CONTAINER_ID} ${agentPassCommand(defaultConfig.passTimeoutSeconds).join(" ")}`,
      );
      expect(pass).not.toContain(" -d");

      // **The property this whole seam rests on**: the prompt is in the pipe
      // and nowhere in argv, so quotes, backticks, and `$(…)` in it arrive
      // literally (`run.sh:1153`, and what T17's `--feedback` needs).
      expect(yield* Ref.get(scratch.fed)).toEqual([expectedPrompt(scratch.plan)]);
      expect(pass).not.toContain("/spec.md");
      expect(pass).not.toContain(BRANCH);
      // A pass that worked asks the daemon nothing about its container: the
      // second question is the failure path's alone, so a successful pass
      // spawns exactly the docker it spawned before T22.
      expect(dockerIn(yield* Ref.get(scratch.commands))).toEqual([pass]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped(
    "brackets the pass: the prompt verbatim, one event per narration line, then the close",
    () =>
      Effect.gen(function* () {
        const scratch = yield* world();
        yield* Effect.scoped(
          Effect.flatMap(AgentCli, (agent) =>
            agent.implement(
              { name: scratch.plan.containerId, id: CONTAINER_ID },
              scratch.plan,
              Option.none(),
              Option.none(),
            ),
          ),
        ).pipe(Effect.provide(scratch.layer));

        // Verbatim, and first: a pass that dies still says what it was told.
        // Last is the close, which is the notification a dispatcher who walked
        // away gets for the longest wait in the run.
        expect(yield* Ref.get(scratch.events)).toEqual([
          {
            _tag: "PromptAssembled",
            pass: "implement",
            prompt: expectedPrompt(scratch.plan),
            root: "package",
            issue: Option.none(),
          },
          ...narrationEvents("implement"),
          passFinished("implement"),
        ]);
      }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped("carries this run's branch and diff boundary in the prompt it feeds", () =>
    Effect.gen(function* () {
      const scratch = yield* world();
      yield* Effect.scoped(
        Effect.flatMap(AgentCli, (agent) =>
          agent.implement(
            { name: scratch.plan.containerId, id: CONTAINER_ID },
            scratch.plan,
            Option.none(),
            Option.none(),
          ),
        ),
      ).pipe(Effect.provide(scratch.layer));

      const [prompt] = yield* Ref.get(scratch.fed);
      expect(prompt).toContain("Your task spec is the file /spec.md, mounted read-only");
      expect(prompt).toContain(`You are on branch ${BRANCH}.`);
      expect(prompt).toContain(MERGE_BASE_SHA);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // The predicate matrix row 10 rests on, on its own. It reads the answer
  // `Sandbox` asked the daemon for and nothing else: a pass that failed inside
  // a container that is still there exited on its own, whatever it printed
  // (T22).
  it("names the reason off the sandbox's own answer, not off what docker printed", () => {
    expect(agentPassReason(true)).toBe("sandbox-gone");
    expect(agentPassReason(false)).toBe("exited");
  });
});

// Matrix rows 8-10. All three are the same shape — a typed `AgentPassFailed`, a
// `failed` row at stage `implement`, and sandbox, checkout, and lock released in
// that order — and differ only in the reason a human is handed.
describe("a pass that ends the run", () => {
  // Row 8.
  it.scoped("fails a nonzero exit as AgentPassFailed, releasing all three in reverse", () =>
    Effect.gen(function* () {
      const scratch = yield* world({
        ...happyScript,
        "docker exec": { exit: 1, stderr: "Credit balance is too low\n" },
      });
      const fs = yield* FileSystem.FileSystem;
      const outcome = yield* Effect.either(
        runInScope(scratch.plan, scratch.repoRoot, TEST_CREDENTIAL, TEST_FORGE_REPO, () =>
          Effect.fail("the work never ran"),
        ).pipe(Effect.provide(scratch.layer)),
      );

      expect(Either.isLeft(outcome)).toBe(true);
      if (Either.isLeft(outcome)) {
        expect(outcome.left).toBeInstanceOf(AgentPassFailed);
        if (outcome.left instanceof AgentPassFailed) {
          expect(outcome.left.reason).toBe("exited");
          expect(outcome.left.detail).toContain("Credit balance is too low");
          // What a human does next: read the log, and the branch keeps
          // whatever the pass committed before it died (05 Q16R).
          expect(outcome.left.detail).toContain(Option.getOrThrow(scratch.plan.logPath));
          expect(outcome.left.detail).toContain("is kept");
        }
      }
      const rows = yield* Ref.get(scratch.appended);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.terminalReason).toEqual(
        Option.some({ _tag: "Failed", stage: "implement" as const }),
      );
      expect(resourceEventsIn(yield* Ref.get(scratch.events))).toEqual([
        ["ResourceAcquired", "lock"],
        ["ResourceAcquired", "checkout"],
        ["ResourceAcquired", "sandbox"],
        ["ResourceReleased", "sandbox"],
        ["ResourceReleased", "checkout"],
        ["ResourceReleased", "lock"],
      ]);
      // **And the pass never said it finished.** The failure leaves through
      // the error channel, and a "finished" beside it would be a second answer
      // to whether the pass worked — one a dispatcher would have read as the
      // implement pass landing.
      expect(
        (yield* Ref.get(scratch.events)).filter((event) => event._tag === "AgentPassFinished"),
      ).toEqual([]);
      // **Single-shot**: one pass, not two. A `Schedule` anywhere over this
      // call would show up here as a second `docker exec` (05 Q16R).
      expect(dockerIn(yield* Ref.get(scratch.commands)).filter((c) => c.includes("exec"))).toEqual([
        `docker exec -i ${CONTAINER_ID} ${agentPassCommand(defaultConfig.passTimeoutSeconds).join(" ")}`,
      ]);
      // And the host afterwards agrees with the events.
      expect(yield* fs.readDirectory(`${scratch.runtimeRoot}/locks`)).toEqual([]);
      expect(yield* fs.exists(scratch.plan.checkoutPath)).toBe(false);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // Row 8 again, from the direction that looks like row 10 and is not: the
  // agent CLI was killed *inside* a container that kept running, so docker
  // reports 137 and the daemon still holds the sandbox. This ticket separates
  // gone from not-gone and identifies no out-of-memory kill — a 137 in a live
  // container is an ordinary nonzero exit (T22).
  it.scoped("fails a 137 in a container that is still running as an ordinary exit", () =>
    Effect.gen(function* () {
      const scratch = yield* world({ ...happyScript, "docker exec": { exit: 137 } });
      const outcome = yield* Effect.either(
        runInScope(
          scratch.plan,
          scratch.repoRoot,
          TEST_CREDENTIAL,
          TEST_FORGE_REPO,
          () => Effect.void,
        ).pipe(Effect.provide(scratch.layer)),
      );

      expect(Either.isLeft(outcome)).toBe(true);
      if (Either.isLeft(outcome) && outcome.left instanceof AgentPassFailed) {
        expect(outcome.left.reason).toBe("exited");
        expect(outcome.left.detail).toContain("exited 137");
        expect(outcome.left.detail).not.toContain("lost its sandbox");
      }
      expect((yield* Ref.get(scratch.appended))[0]?.terminalReason).toEqual(
        Option.some({ _tag: "Failed", stage: "implement" as const }),
      );
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // The pass came back, and nothing it printed was the `result` event its
  // answer is read from — the stream ended mid-flight, or the CLI never spoke
  // the format. It is a **failed** pass and not an empty answer: an empty
  // answer is a review that approved nothing and a PR body nobody wrote, both
  // of which the run would carry on with.
  it.scoped("fails a pass whose stream carried no result event, naming the flags", () =>
    Effect.gen(function* () {
      const scratch = yield* world({
        ...happyScript,
        "docker exec": {
          exit: 0,
          stdout: streamJson(...NARRATION),
          stderr: "node: some deprecation\nerror: --output-format=stream-json requires --verbose\n",
        },
      });
      const outcome = yield* Effect.either(
        Effect.scoped(
          Effect.flatMap(AgentCli, (agent) =>
            agent.implement(
              { name: scratch.plan.containerId, id: CONTAINER_ID },
              scratch.plan,
              Option.none(),
              Option.none(),
            ),
          ),
        ).pipe(Effect.provide(scratch.layer)),
      );

      expect(Either.isLeft(outcome)).toBe(true);
      if (Either.isLeft(outcome) && outcome.left instanceof AgentPassFailed) {
        expect(outcome.left.reason).toBe("exited");
        expect(outcome.left.detail).toContain("without a result event");
        // **The whole guard against the CLI refusing the flags** (ticket 20
        // §9): there is no doctor probe for the stream format, because a probe
        // would need a container — so the failure names what to suspect.
        expect(outcome.left.detail).toContain("--output-format stream-json --verbose");
        expect(outcome.left.detail).toContain(Option.getOrThrow(scratch.plan.logPath));
        // The clause the other three failure details end on, said here too
        // (T55): a pass whose stream stopped may have committed the whole of
        // its work, and this is the only sentence that says where it is.
        expect(outcome.left.detail).toContain(`anything it committed is kept on '${BRANCH}'`);
        // And what the child said on the way out — its **last** line, which is
        // the one that names the reason, on the same line as everything else.
        expect(outcome.left.detail).toContain(
          "its last stderr line was: error: --output-format=stream-json requires --verbose",
        );
        // The tail stays last, so the branch clause sits before the sentence
        // about the flags rather than after the stderr it would push off.
        expect(outcome.left.detail.indexOf("is kept on")).toBeLessThan(
          outcome.left.detail.indexOf("its last stderr line was"),
        );
        expect(outcome.left.detail).not.toContain("some deprecation");
        expect(outcome.left.detail).not.toContain("\n");
      }
      // What it did narrate still reached the stream, and the pass still never
      // said it finished.
      const events = yield* Ref.get(scratch.events);
      expect(events.filter((event) => event._tag === "AgentOutput")).toEqual(
        narrationEvents("implement"),
      );
      expect(events.filter((event) => event._tag === "AgentPassFinished")).toEqual([]);
      // **What it said instead** (T55): one failure event, carrying the
      // error's own detail so the log and the exit line read the same. No
      // usage — the stream ended without a result, so nothing the CLI reported
      // is known — and `Duration.zero` because this case runs on `TestClock`
      // and nothing advances it.
      expect(passFailuresIn(events)).toEqual([
        {
          _tag: "PassFailed",
          pass: "implement",
          issue: Option.none(),
          reason: "exited",
          detail:
            Either.isLeft(outcome) && outcome.left instanceof AgentPassFailed
              ? outcome.left.detail
              : "",
          elapsed: Duration.zero,
          usage: Option.none(),
        },
      ]);
      // And it is the last thing the pass said: the failure leaves through the
      // error channel straight after it.
      expect(events.at(-1)?._tag).toBe("PassFailed");
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // The other half of the same rule: a result arrived and it is the CLI saying
  // the pass failed. Same reason — the child came back — and its text is the
  // whole of what is known about why, so it travels in the detail.
  it.scoped("fails a pass whose result event is an error, carrying its text", () =>
    Effect.gen(function* () {
      const scratch = yield* world({
        ...happyScript,
        "docker exec": {
          exit: 0,
          stdout: streamJson(
            ...NARRATION,
            answersWithError(
              "Credit balance is too low\nAdd credits at https://console.anthropic.com/billing",
            ),
          ),
        },
      });
      const outcome = yield* Effect.either(
        Effect.scoped(
          Effect.flatMap(AgentCli, (agent) =>
            agent.review(
              { name: scratch.plan.containerId, id: CONTAINER_ID },
              scratch.plan,
              Option.none(),
              {
                index: 1,
                of: 3,
              },
            ),
          ),
        ).pipe(Effect.provide(scratch.layer)),
      );

      expect(Either.isLeft(outcome)).toBe(true);
      if (Either.isLeft(outcome) && outcome.left instanceof AgentPassFailed) {
        expect(outcome.left.reason).toBe("exited");
        expect(outcome.left.detail).toContain("the review pass ended with an error result");
        // Folded onto one line, because that is what the log and the exit line
        // are: the second sentence is beside the first, not under it.
        expect(outcome.left.detail).toContain(
          "Credit balance is too low Add credits at https://console.anthropic.com/billing",
        );
        expect(outcome.left.detail).not.toContain("\n");
      }
      // Not an answer, so not a verdict: a round that ended this way never
      // reaches `reviewVerdictIn`, and nothing said `needs-work`.
      const events = yield* Ref.get(scratch.events);
      expect(events.filter((event) => event._tag === "AgentPassFinished")).toEqual([]);
      // **The one failure that carries a usage** (T55): the pass ran, the CLI
      // reported what it spent, and then said it failed — which is the
      // expensive failure worth seeing on the line. bash reports it on the
      // same grounds.
      expect(passFailuresIn(events)).toEqual([
        {
          _tag: "PassFailed",
          pass: "review",
          issue: Option.none(),
          reason: "exited",
          detail:
            Either.isLeft(outcome) && outcome.left instanceof AgentPassFailed
              ? outcome.left.detail
              : "",
          elapsed: Duration.zero,
          usage: Option.some(RESULT_USAGE),
        },
      ]);
      expect(events.at(-1)?._tag).toBe("PassFailed");
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // Row 9. A hanging pass is a child whose wait never returns, so what is
  // asserted is that the *caller's* cap ends it — and it is asserted on the
  // **live** clock, deliberately. `TestClock.adjust` would have to be issued
  // after the timeout registered its own sleep and there is no barrier that
  // says when that happened, so the virtual-clock version of this case is a
  // race whose green side is a test that never ran. One real second is the
  // price of a deterministic answer; the budget is a config value, so the case
  // sets it to one.
  it.scopedLive("fails a pass that outruns passTimeoutSeconds, with a timeout reason", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      // Narration, and then a child whose wait never returns: the lines are
      // out before the kill and no result event ever follows them.
      const scratch = yield* world(
        { ...happyScript, "docker exec": { hangs: true, stdout: streamJson(...NARRATION) } },
        { passTimeoutSeconds: 1 },
      );
      const outcome = yield* Effect.either(
        runInScope(
          scratch.plan,
          scratch.repoRoot,
          TEST_CREDENTIAL,
          TEST_FORGE_REPO,
          () => Effect.void,
        ).pipe(Effect.provide(scratch.layer)),
      );

      expect(Either.isLeft(outcome)).toBe(true);
      if (Either.isLeft(outcome) && outcome.left instanceof AgentPassFailed) {
        expect(outcome.left.reason).toBe("timed-out");
        expect(outcome.left.detail).toContain("timed out at 1s");
        // The sizing signal bash prints at the same moment (`run.sh:1190`).
        expect(outcome.left.detail).toContain("re-slice");
      }
      const rows = yield* Ref.get(scratch.appended);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.terminalReason).toEqual(
        Option.some({ _tag: "Failed", stage: "implement" as const }),
      );
      expect(resourceEventsIn(yield* Ref.get(scratch.events))).toEqual([
        ["ResourceAcquired", "lock"],
        ["ResourceAcquired", "checkout"],
        ["ResourceAcquired", "sandbox"],
        ["ResourceReleased", "sandbox"],
        ["ResourceReleased", "checkout"],
        ["ResourceReleased", "lock"],
      ]);
      // The container went even though the pass never came back — the removal
      // is the scope's, not the pass's.
      expect(dockerIn(yield* Ref.get(scratch.commands)).at(-1)).toBe(
        `docker rm -fv ${CONTAINER_ID}`,
      );
      // **What ticket 20 is for**: the pass was killed at the wall, and every
      // line it said before the kill is in its log. Under plain `-p` this file
      // held the run's 80 lines and nothing the agent said.
      const log = yield* fs.readFileString(Option.getOrThrow(scratch.plan.logPath));
      expect(log).toContain("agent > Read: /spec.md");
      expect(log).toContain("agent | writing src/agent/agent-cli.ts");
      // **And the log says it was killed** (T55), which is the half of the
      // silence ticket 20 found underneath the narration: the last thing in
      // the bracket is the failure, after the narration rather than instead of
      // it, and no usage — a kill reports none.
      const events = yield* Ref.get(scratch.events);
      const failures = passFailuresIn(events);
      expect(failures).toHaveLength(1);
      expect(failures[0]?.reason).toBe("timed-out");
      expect(failures[0]?.usage).toEqual(Option.none());
      expect(failures[0]?.detail).toContain("timed out at 1s");
      expect(events.findLastIndex((event) => event._tag === "AgentOutput")).toBeLessThan(
        events.findIndex((event) => event._tag === "PassFailed"),
      );
      // The live clock is the one this case runs on, so the elapsed is a real
      // reading: the pass sat out its whole one-second budget before the kill.
      expect(
        Duration.greaterThanOrEqualTo(failures[0]?.elapsed ?? Duration.zero, Duration.seconds(1)),
      ).toBe(true);
      expect(log).toContain("implement pass failed (1s): timed-out —");
      // **And the watch went with the exec** (T52): it is forked into a scope
      // that holds nothing else, so the kill closes that scope before the
      // failure is emitted. A pass killed at one second never reached a tick
      // to begin with — what this pins is that nothing the watch says can
      // arrive after a pass has said how it ended.
      expect(watchEventsIn(events)).toEqual([]);
      expect(events.findIndex((event) => event._tag === "PassFailed")).toBe(
        events.findLastIndex(
          (event) =>
            event._tag === "PassFailed" ||
            event._tag === "PassStillRunning" ||
            event._tag === "NoWritesYet" ||
            event._tag === "AgentPassFinished",
        ),
      );
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // Row 10.
  it.scoped("fails a pass whose sandbox disappeared, naming that as the reason", () =>
    Effect.gen(function* () {
      const scratch = yield* world({
        ...happyScript,
        "docker exec": {
          exit: 1,
          stderr: `Error response from daemon: Container ${CONTAINER_ID} is not running\n`,
        },
        // The container was already dead when the exec was refused, so the
        // daemon still knows it and no longer runs it. The refusal's wording
        // is nothing this reads.
        "docker inspect": STOPPED,
      });
      const outcome = yield* Effect.either(
        runInScope(
          scratch.plan,
          scratch.repoRoot,
          TEST_CREDENTIAL,
          TEST_FORGE_REPO,
          () => Effect.void,
        ).pipe(Effect.provide(scratch.layer)),
      );

      expect(Either.isLeft(outcome)).toBe(true);
      if (Either.isLeft(outcome) && outcome.left instanceof AgentPassFailed) {
        expect(outcome.left.reason).toBe("sandbox-gone");
        expect(outcome.left.detail).toContain("lost its sandbox");
      }
      const rows = yield* Ref.get(scratch.appended);
      expect(rows[0]?.terminalReason).toEqual(
        Option.some({ _tag: "Failed", stage: "implement" as const }),
      );
      // One failure event, no usage — the exec never got as far as a result —
      // and it is inside the bracket: it comes before anything releases, which
      // is the whole difference from the stderr line `bin.ts` prints at exit
      // (T55).
      const events = yield* Ref.get(scratch.events);
      expect(passFailuresIn(events)).toEqual([
        {
          _tag: "PassFailed",
          pass: "implement",
          issue: Option.none(),
          reason: "sandbox-gone",
          detail:
            Either.isLeft(outcome) && outcome.left instanceof AgentPassFailed
              ? outcome.left.detail
              : "",
          elapsed: Duration.zero,
          usage: Option.none(),
        },
      ]);
      expect(events.findIndex((event) => event._tag === "PassFailed")).toBeLessThan(
        events.findIndex((event) => event._tag === "ResourceReleased"),
      );
      // The removal is idempotent: a container that is already gone is still
      // the scope's to release, and its refusal is warned rather than fatal.
      expect(resourceEventsIn(yield* Ref.get(scratch.events))).toEqual([
        ["ResourceAcquired", "lock"],
        ["ResourceAcquired", "checkout"],
        ["ResourceAcquired", "sandbox"],
        ["ResourceReleased", "sandbox"],
        ["ResourceReleased", "checkout"],
        ["ResourceReleased", "lock"],
      ]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // Row 10, from the direction the regex could never reach (T22): the
  // container was removed *while* the pass ran, so the exec'd process took a
  // SIGKILL and docker reported its exit code rather than refusing anything.
  // There is no daemon text here at all — the reason comes from the answer the
  // sandbox went back and asked for.
  it.scoped("fails a pass whose container was killed mid-exec as sandbox-gone", () =>
    Effect.gen(function* () {
      const scratch = yield* world({
        ...happyScript,
        "docker exec": { exit: 137 },
        "docker inspect": NO_SUCH_CONTAINER,
      });
      const outcome = yield* Effect.either(
        runInScope(
          scratch.plan,
          scratch.repoRoot,
          TEST_CREDENTIAL,
          TEST_FORGE_REPO,
          () => Effect.void,
        ).pipe(Effect.provide(scratch.layer)),
      );

      expect(Either.isLeft(outcome)).toBe(true);
      if (Either.isLeft(outcome) && outcome.left instanceof AgentPassFailed) {
        expect(outcome.left.reason).toBe("sandbox-gone");
        expect(outcome.left.detail).toContain("lost its sandbox");
        // The message the sandbox carried only ever named the child's exit
        // code: there is no "no such container" in it to have matched, which
        // is why the reason has to come off the field.
        expect(outcome.left.detail).toContain("exited 137");
      }
      expect((yield* Ref.get(scratch.appended))[0]?.terminalReason).toEqual(
        Option.some({ _tag: "Failed", stage: "implement" as const }),
      );
      expect(resourceEventsIn(yield* Ref.get(scratch.events))).toEqual([
        ["ResourceAcquired", "lock"],
        ["ResourceAcquired", "checkout"],
        ["ResourceAcquired", "sandbox"],
        ["ResourceReleased", "sandbox"],
        ["ResourceReleased", "checkout"],
        ["ResourceReleased", "lock"],
      ]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // The pass inside the run, end to end: the prompt reaches the run log
  // verbatim, which is the file "what exactly was this agent told" is answered
  // from (`run.sh:1144-1149`), and a completed pass is a completed run.
  it.scoped("writes the verbatim prompt and the pass's output to the run log", () =>
    Effect.gen(function* () {
      const scratch = yield* world();
      const fs = yield* FileSystem.FileSystem;
      yield* runInScope(
        scratch.plan,
        scratch.repoRoot,
        TEST_CREDENTIAL,
        TEST_FORGE_REPO,
        () => Effect.void,
      ).pipe(Effect.provide(scratch.layer));

      const log = yield* fs.readFileString(Option.getOrThrow(scratch.plan.logPath));
      // And the block names the root it came from (T14): whoever wants to see
      // their override take reads this line, so it says which file won whether
      // or not one is in place.
      expect(log).toContain("-- implement prompt (package default) --");
      expect(log).toContain(expectedPrompt(scratch.plan));
      expect(log).toContain("-- end prompt --");
      // bash's two shapes under the port's `agent` label: a tool use after
      // `>`, prose after `|`.
      expect(log).toContain("agent > Read: /spec.md");
      expect(log).toContain("agent | writing src/agent/agent-cli.ts");
      // And what the pass cost, on the line that closes it — bash's
      // `claude $ usage`, which the port had dropped (T55). It is the run's own
      // line about the pass, so it carries no `agent` prefix.
      expect(log).toContain(
        "implement pass finished (0s) usage in=18 out=246 cache_write=8068 cache_read=40768 turns=2 cost=0.0215 models=claude-haiku-4-5-20251001",
      );
      const rows = yield* Ref.get(scratch.appended);
      expect(rows[0]?.terminalReason).toEqual(Option.some({ _tag: "Completed" }));
      // A run whose passes all worked never asks the daemon what became of
      // its container: the second question is the failure path's alone (T22).
      expect(
        dockerIn(yield* Ref.get(scratch.commands)).filter((command) =>
          command.startsWith("docker inspect"),
        ),
      ).toEqual([]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
});

// One review round (T10), against the same scripted docker: single-shot with
// the implement pass's mechanics — one `docker exec`, the prompt on stdin, the
// prompt logged verbatim — and one thing of its own, which is that the output
// is read back for a verdict. The rounds themselves are `test/review.test.ts`.
describe("a review round", () => {
  const ROUND: ReviewRound = { index: 1, of: 3 };
  // The marker rides in the **result** event, which is where a verdict is
  // read from (ticket 20): a round that only said it in its narration decided
  // nothing.
  const reviewing = (marker: string): Record<string, ScriptedResult> => ({
    ...happyScript,
    "docker exec": { exit: 0, stdout: passOutput(marker) },
  });

  it.scoped("runs the same argv as the implement pass, with the review prompt on stdin", () =>
    Effect.gen(function* () {
      const scratch = yield* world(reviewing(APPROVED_MARKER));
      const verdict = yield* Effect.scoped(
        Effect.flatMap(AgentCli, (agent) =>
          agent.review(
            { name: scratch.plan.containerId, id: CONTAINER_ID },
            scratch.plan,
            Option.none(),
            ROUND,
          ),
        ),
      ).pipe(Effect.provide(scratch.layer));

      expect(verdict).toBe("approved");
      // Which pass this is lives in the prompt, never in argv.
      expect(dockerIn(yield* Ref.get(scratch.commands))).toEqual([
        `docker exec -i ${CONTAINER_ID} ${agentPassCommand(defaultConfig.passTimeoutSeconds).join(" ")}`,
      ]);
      expect(yield* Ref.get(scratch.fed)).toEqual([expectedReviewPrompt(scratch.plan, ROUND)]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // The boundary the round reads the diff against is T3's, off the plan — the
  // round never asks git a second question about it.
  it.scoped("carries the plan's merge-base and the round it is on into the prompt", () =>
    Effect.gen(function* () {
      const scratch = yield* world(reviewing(APPROVED_MARKER));
      yield* Effect.scoped(
        Effect.flatMap(AgentCli, (agent) =>
          agent.review(
            { name: scratch.plan.containerId, id: CONTAINER_ID },
            scratch.plan,
            Option.none(),
            {
              index: 3,
              of: 3,
            },
          ),
        ),
      ).pipe(Effect.provide(scratch.layer));

      const [prompt] = yield* Ref.get(scratch.fed);
      expect(prompt).toContain(MERGE_BASE_SHA);
      expect(prompt).toContain(`You are on branch ${BRANCH}.`);
      expect(prompt).toContain("This is review round 3 of 3.");
      expect(yield* Ref.get(scratch.gitCalls)).toEqual([]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped("logs the round's prompt verbatim and one event per narration line", () =>
    Effect.gen(function* () {
      const scratch = yield* world(reviewing(FIXED_MARKER));
      const verdict = yield* Effect.scoped(
        Effect.flatMap(AgentCli, (agent) =>
          agent.review(
            { name: scratch.plan.containerId, id: CONTAINER_ID },
            scratch.plan,
            Option.none(),
            ROUND,
          ),
        ),
      ).pipe(Effect.provide(scratch.layer));

      expect(verdict).toBe("fixed");
      expect(yield* Ref.get(scratch.events)).toEqual([
        {
          _tag: "PromptAssembled",
          pass: "review",
          prompt: expectedReviewPrompt(scratch.plan, ROUND),
          root: "package",
          issue: Option.none(),
        },
        ...narrationEvents("review"),
        // **The marker is not among them.** It arrived in the result event,
        // which is the pass's answer and never narration — the verdict above
        // was read from there.
        // Emitted for every pass, not only the one anybody notifies about —
        // the round's own verdict is what `notifications.ts` renders here, and
        // this event's name would be a lie if it fired for one pass.
        passFinished("review"),
      ]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // A round that ends without saying anything the loop recognizes is
  // `needs-work` — the answer that keeps a human reading the diff.
  it.scoped("answers needs-work for a round that ended on no verdict at all", () =>
    Effect.gen(function* () {
      const scratch = yield* world();
      const verdict = yield* Effect.scoped(
        Effect.flatMap(AgentCli, (agent) =>
          agent.review(
            { name: scratch.plan.containerId, id: CONTAINER_ID },
            scratch.plan,
            Option.none(),
            ROUND,
          ),
        ),
      ).pipe(Effect.provide(scratch.layer));

      expect(verdict).toBe("needs-work");
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // A round that exits nonzero is a typed `AgentPassFailed` like any other
  // pass — same shape as matrix row 8, and it names the pass it was.
  it.scoped("fails a nonzero round as AgentPassFailed, naming the review pass", () =>
    Effect.gen(function* () {
      const scratch = yield* world({
        ...happyScript,
        "docker exec": { exit: 1, stderr: "Credit balance is too low\n" },
      });
      const outcome = yield* Effect.either(
        Effect.scoped(
          Effect.flatMap(AgentCli, (agent) =>
            agent.review(
              { name: scratch.plan.containerId, id: CONTAINER_ID },
              scratch.plan,
              Option.none(),
              ROUND,
            ),
          ),
        ).pipe(Effect.provide(scratch.layer)),
      );

      expect(Either.isLeft(outcome)).toBe(true);
      if (Either.isLeft(outcome) && outcome.left instanceof AgentPassFailed) {
        expect(outcome.left.reason).toBe("exited");
        expect(outcome.left.detail).toContain("the review pass failed");
        expect(outcome.left.detail).toContain(Option.getOrThrow(scratch.plan.logPath));
      }
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // Each round gets the whole pass budget, and a hanging one is capped by the
  // same caller's timeout (row 9). What differs is the sentence: the sizing
  // signal is the implement pass's alone, as it is in bash's `watch_writes`
  // arm (`run.sh:1516-1517`) — a round that finds nothing wrong writes
  // nothing, and that is the good case. Live clock, for row 9's reason.
  it.scopedLive("caps a hanging round at the same budget, without the sizing sentence", () =>
    Effect.gen(function* () {
      const scratch = yield* world(
        { ...happyScript, "docker exec": { hangs: true } },
        { passTimeoutSeconds: 1 },
      );
      const outcome = yield* Effect.either(
        Effect.scoped(
          Effect.flatMap(AgentCli, (agent) =>
            agent.review(
              { name: scratch.plan.containerId, id: CONTAINER_ID },
              scratch.plan,
              Option.none(),
              ROUND,
            ),
          ),
        ).pipe(Effect.provide(scratch.layer)),
      );

      expect(Either.isLeft(outcome)).toBe(true);
      if (Either.isLeft(outcome) && outcome.left instanceof AgentPassFailed) {
        expect(outcome.left.reason).toBe("timed-out");
        expect(outcome.left.detail).toContain("the review pass timed out at 1s");
        expect(outcome.left.detail).not.toContain("re-slice");
      }
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
});

// The PR description pass (T12): the same mechanics again — one `docker exec`,
// the prompt on stdin, the prompt logged verbatim — and one thing of its own,
// which is that the output *is* the answer. What the caller does with a pass
// that fails is `test/pr.test.ts`'s subject; here it fails like any other pass.
describe("the PR description pass", () => {
  // Its answer is the result event's text, markers and all: the block a body
  // is read out of is what the pass *returned*, not something it printed on
  // the way (ticket 20).
  const describing = (answer: string): Record<string, ScriptedResult> => ({
    ...happyScript,
    "docker exec": { exit: 0, stdout: passOutput(answer) },
  });
  const BODY = "## Overview\n\nThe forge seam and the description that goes through it.";

  it.scoped("runs the same argv as the other passes, with the describe prompt on stdin", () =>
    Effect.gen(function* () {
      const scratch = yield* world(describing(wrapped(BODY)));
      const body = yield* Effect.scoped(
        Effect.flatMap(AgentCli, (agent) =>
          agent.describePr(
            { name: scratch.plan.containerId, id: CONTAINER_ID },
            scratch.plan,
            Option.none(),
          ),
        ),
      ).pipe(Effect.provide(scratch.layer));

      // What the markers held, not what the pass printed (`description.ts`).
      expect(body).toBe(BODY);
      expect(dockerIn(yield* Ref.get(scratch.commands))).toEqual([
        `docker exec -i ${CONTAINER_ID} ${agentPassCommand(defaultConfig.passTimeoutSeconds).join(" ")}`,
      ]);
      expect(yield* Ref.get(scratch.fed)).toEqual([expectedDescribePrompt(scratch.plan)]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // The same boundary the review round read against, off the plan: one run's
  // work is one range of commits at every stage, and this pass never asks git
  // for it again.
  it.scoped("carries the branch and the plan's diff boundary into the prompt", () =>
    Effect.gen(function* () {
      const scratch = yield* world(describing(wrapped(BODY)));
      yield* Effect.scoped(
        Effect.flatMap(AgentCli, (agent) =>
          agent.describePr(
            { name: scratch.plan.containerId, id: CONTAINER_ID },
            scratch.plan,
            Option.none(),
          ),
        ),
      ).pipe(Effect.provide(scratch.layer));

      const [prompt] = yield* Ref.get(scratch.fed);
      expect(prompt).toContain(`Describe the work on branch ${BRANCH}`);
      expect(prompt).toContain(MERGE_BASE_SHA);
      expect(yield* Ref.get(scratch.gitCalls)).toEqual([]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped("logs its prompt verbatim and one event per narration line", () =>
    Effect.gen(function* () {
      const scratch = yield* world(describing(wrapped("One line, then another.")));
      yield* Effect.scoped(
        Effect.flatMap(AgentCli, (agent) =>
          agent.describePr(
            { name: scratch.plan.containerId, id: CONTAINER_ID },
            scratch.plan,
            Option.none(),
          ),
        ),
      ).pipe(Effect.provide(scratch.layer));

      // What reaches the console and the log is what the agent narrated; the
      // block it answered with is extracted from the result event afterwards
      // and is nowhere in this stream.
      expect(yield* Ref.get(scratch.events)).toEqual([
        {
          _tag: "PromptAssembled",
          pass: "describe-pr",
          prompt: expectedDescribePrompt(scratch.plan),
          root: "package",
          issue: Option.none(),
        },
        ...narrationEvents("describe-pr"),
        passFinished("describe-pr"),
      ]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // The live failure this ticket's second round exists for: the prompt already
  // forbade preamble and the pass wrote it anyway, and because this output
  // becomes the PR body, it went to the forge. The block is the guarantee the
  // prompt could only ask for (T24).
  it.scoped("keeps only what the markers hold, dropping narration on either side", () =>
    Effect.gen(function* () {
      const scratch = yield* world(
        describing(
          [
            "Good, that's all the context I need. Now writing the PR description.",
            "",
            wrapped(BODY),
            "",
            "Let me know if you'd like anything expanded.",
          ].join("\n"),
        ),
      );
      const body = yield* Effect.scoped(
        Effect.flatMap(AgentCli, (agent) =>
          agent.describePr(
            { name: scratch.plan.containerId, id: CONTAINER_ID },
            scratch.plan,
            Option.none(),
          ),
        ),
      ).pipe(Effect.provide(scratch.layer));

      expect(body).toBe(BODY);
      expect(warningsIn(yield* Ref.get(scratch.events))).toEqual([]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // An output with no block is the static body (`dispatch/pr.ts`) — and a
  // warning, because the text is still verbatim in the log and a human can
  // decide it was worth keeping.
  it.scoped("answers empty and warns when the pass wrote no block at all", () =>
    Effect.gen(function* () {
      const scratch = yield* world(describing(BODY));
      const body = yield* Effect.scoped(
        Effect.flatMap(AgentCli, (agent) =>
          agent.describePr(
            { name: scratch.plan.containerId, id: CONTAINER_ID },
            scratch.plan,
            Option.none(),
          ),
        ),
      ).pipe(Effect.provide(scratch.layer));

      expect(body).toBe("");
      const warnings = warningsIn(yield* Ref.get(scratch.events));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("wrote no <pr-description>");
      expect(warnings[0]).toContain(Option.getOrThrow(scratch.plan.logPath));
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // Typed like every other pass — the degradation is the caller's, not this
  // seam's (`dispatch/pr.ts`).
  it.scoped("fails a nonzero pass as AgentPassFailed, naming the description pass", () =>
    Effect.gen(function* () {
      const scratch = yield* world({
        ...happyScript,
        "docker exec": { exit: 1, stderr: "Credit balance is too low\n" },
      });
      const outcome = yield* Effect.either(
        Effect.scoped(
          Effect.flatMap(AgentCli, (agent) =>
            agent.describePr(
              { name: scratch.plan.containerId, id: CONTAINER_ID },
              scratch.plan,
              Option.none(),
            ),
          ),
        ).pipe(Effect.provide(scratch.layer)),
      );

      expect(Either.isLeft(outcome)).toBe(true);
      if (Either.isLeft(outcome) && outcome.left instanceof AgentPassFailed) {
        expect(outcome.left.reason).toBe("exited");
        expect(outcome.left.detail).toContain("the describe-pr pass failed");
        expect(outcome.left.detail).toContain(Option.getOrThrow(scratch.plan.logPath));
      }
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
});

// The served repo's extension point, at all three call sites (T14). What is
// asserted here is the *seam* — that every pass takes its template from
// `PromptSource` and says which root it came from — while the chain's own arms
// are `test/prompt-source.test.ts`'s. A pass that read a package path directly
// would still be green there and red here.
describe("a served repo's prompts in its bessemer directory", () => {
  const OVERRIDE = "# TASK\n\nThe served repo's own instructions, whole-file.\n";
  const CONTEXT = "Run `npm run verify` from the repo root; there is no pytest here.\n";

  it.scoped("hands the implement pass the override, and names the root that won", () =>
    Effect.gen(function* () {
      const scratch = yield* world();
      yield* dropIn(scratch.repoRoot, IMPLEMENT_PROMPT, OVERRIDE);
      yield* Effect.scoped(
        Effect.flatMap(AgentCli, (agent) =>
          agent.implement(
            { name: scratch.plan.containerId, id: CONTAINER_ID },
            scratch.plan,
            Option.none(),
            Option.none(),
          ),
        ),
      ).pipe(Effect.provide(scratch.layer));

      // The served repo's text on stdin, the package default nowhere in it, and
      // the dispatcher's message still appended: an override replaces the
      // template, never the assembly.
      const [prompt] = yield* Ref.get(scratch.fed);
      expect(prompt).toBe(renderImplementPrompt(OVERRIDE, scratch.plan));
      expect(prompt).not.toContain("Checkpoint your work");
      expect(prompt).toContain(`You are on branch ${BRANCH}.`);
      expect(promptsIn(yield* Ref.get(scratch.events)).map((assembled) => assembled.root)).toEqual([
        "client",
      ]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // The other two call sites, and the reason they are asserted separately: each
  // resolves its own name, so a pass left reading a package path is invisible
  // from the one that was converted.
  it.scoped("hands the review round and the description pass theirs", () =>
    Effect.gen(function* () {
      const scratch = yield* world({
        ...happyScript,
        "docker exec": { exit: 0, stdout: passOutput(`${wrapped("Body.")}\n${APPROVED_MARKER}`) },
      });
      yield* dropIn(scratch.repoRoot, REVIEW_PROMPT, "# ROLE\n\nThe client's reviewer.\n");
      yield* dropIn(scratch.repoRoot, DESCRIBE_PR_PROMPT, "# ROLE\n\nThe client's writer.\n");
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agent = yield* AgentCli;
          const handle = { name: scratch.plan.containerId, id: CONTAINER_ID };
          yield* agent.review(handle, scratch.plan, Option.none(), { index: 1, of: 3 });
          yield* agent.describePr(handle, scratch.plan, Option.none());
        }),
      ).pipe(Effect.provide(scratch.layer));

      const [review, described] = yield* Ref.get(scratch.fed);
      expect(review).toContain("The client's reviewer.");
      expect(review).toContain("This is review round 1 of 3.");
      expect(described).toContain("The client's writer.");
      expect(promptsIn(yield* Ref.get(scratch.events)).map((assembled) => assembled.root)).toEqual([
        "client",
        "client",
      ]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // Removing the file is the whole of retracting an override: the default is
  // back on the next pass, named as such, with nothing to undo.
  it.scoped("goes back to the package default when the override is removed", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const scratch = yield* world();
      yield* dropIn(scratch.repoRoot, IMPLEMENT_PROMPT, OVERRIDE);
      const pass = Effect.scoped(
        Effect.flatMap(AgentCli, (agent) =>
          agent.implement(
            { name: scratch.plan.containerId, id: CONTAINER_ID },
            scratch.plan,
            Option.none(),
            Option.none(),
          ),
        ),
      ).pipe(Effect.provide(scratch.layer));

      yield* pass;
      yield* fs.remove(overrideIn(scratch.repoRoot, IMPLEMENT_PROMPT));
      yield* pass;

      const assembled = promptsIn(yield* Ref.get(scratch.events));
      expect(assembled.map((one) => one.root)).toEqual(["client", "package"]);
      expect(assembled[1]?.prompt).toBe(expectedPrompt(scratch.plan));
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // The fragment: one file, interpolated into every default without any of
  // them being replaced — the narrow common case, which is what makes a
  // self-dispatch produce useful work.
  it.scoped("interpolates project-context.md into every default prompt", () =>
    Effect.gen(function* () {
      const scratch = yield* world({
        ...happyScript,
        "docker exec": { exit: 0, stdout: passOutput(`${wrapped("Body.")}\n${APPROVED_MARKER}`) },
      });
      yield* dropIn(scratch.repoRoot, PROJECT_CONTEXT_PROMPT, CONTEXT);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agent = yield* AgentCli;
          const handle = { name: scratch.plan.containerId, id: CONTAINER_ID };
          yield* agent.implement(handle, scratch.plan, Option.none(), Option.none());
          yield* agent.review(handle, scratch.plan, Option.none(), { index: 1, of: 3 });
          yield* agent.describePr(handle, scratch.plan, Option.none());
        }),
      ).pipe(Effect.provide(scratch.layer));

      const fed = yield* Ref.get(scratch.fed);
      expect(fed).toHaveLength(3);
      for (const prompt of fed) {
        expect(prompt).toContain(`${PROJECT_CONTEXT_HEADING}\n\n${CONTEXT.trim()}`);
      }
      // The defaults are still the defaults underneath it: the fragment adds a
      // section, it does not patch a template.
      expect(fed[0]).toContain("Checkpoint your work");
      // And the root is still the package's — the fragment is a second
      // extension point, not an override.
      expect(promptsIn(yield* Ref.get(scratch.events)).map((one) => one.root)).toEqual([
        "package",
        "package",
        "package",
      ]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // A selected override that cannot be used stops the pass before the
  // container is asked anything, as a typed failure naming the file (SPEC §3).
  it.scoped("fails the pass on an override it cannot use, without running one", () =>
    Effect.gen(function* () {
      const scratch = yield* world();
      yield* dropIn(scratch.repoRoot, IMPLEMENT_PROMPT, "\n");
      const outcome = yield* Effect.either(
        Effect.scoped(
          Effect.flatMap(AgentCli, (agent) =>
            agent.implement(
              { name: scratch.plan.containerId, id: CONTAINER_ID },
              scratch.plan,
              Option.none(),
              Option.none(),
            ),
          ),
        ).pipe(Effect.provide(scratch.layer)),
      );

      expect(Either.isLeft(outcome)).toBe(true);
      if (Either.isLeft(outcome)) {
        expect(outcome.left).toBeInstanceOf(PromptUnusable);
        expect(outcome.left.detail).toContain(overrideIn(scratch.repoRoot, IMPLEMENT_PROMPT));
      }
      expect(dockerIn(yield* Ref.get(scratch.commands))).toEqual([]);
      expect(yield* Ref.get(scratch.events)).toEqual([]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
});

// `--feedback` at the seam (T17): the dispatcher's text reaches all three
// passes through the task the plan carries, and it reaches them **on stdin** —
// the property T9 built the pipe for, asserted here against the argv the pass
// really spawned rather than against a rendered command line.
describe("dispatcher feedback at the pass", () => {
  // Everything a shell would act on, in one string.
  const FEEDBACK = 'drop the `$(uname)` call and the "retry" branch; use $HOME instead';

  const handleFor = (plan: { containerId: string }) => ({
    name: plan.containerId,
    id: CONTAINER_ID,
  });

  const steered = (plan: DispatchPlan): DispatchPlan => ({
    ...plan,
    task: { ...plan.task, feedback: Option.some(FEEDBACK) },
  });

  it.scoped("feeds the implement pass the feedback, in the pipe and never in argv", () =>
    Effect.gen(function* () {
      const scratch = yield* world();
      const plan = steered(scratch.plan);
      yield* Effect.scoped(
        Effect.flatMap(AgentCli, (agent) =>
          agent.implement(handleFor(plan), plan, Option.none(), Option.none()),
        ),
      ).pipe(Effect.provide(scratch.layer));

      const [fed] = yield* Ref.get(scratch.fed);
      // Literally: no shell ever saw it, so nothing in it was expanded, and
      // the section sits under the prompt T9 already assembled.
      expect(fed).toContain(`${FEEDBACK_OPEN}\n${FEEDBACK}\n${FEEDBACK_CLOSE}`);
      expect(fed).toContain(expectedPrompt(scratch.plan));
      for (const command of dockerIn(yield* Ref.get(scratch.commands))) {
        expect(command).not.toContain("uname");
        expect(command).not.toContain("Dispatcher feedback");
      }
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped("feeds the review round and the description pass the same section", () =>
    Effect.gen(function* () {
      const scratch = yield* world();
      const plan = steered(scratch.plan);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agent = yield* AgentCli;
          yield* agent.review(handleFor(plan), plan, Option.none(), { index: 1, of: 2 });
          yield* agent.describePr(handleFor(plan), plan, Option.none());
        }),
      ).pipe(Effect.provide(scratch.layer));

      const fed = yield* Ref.get(scratch.fed);
      expect(fed).toHaveLength(2);
      for (const prompt of fed) {
        expect(prompt).toContain(`${FEEDBACK_OPEN}\n${FEEDBACK}\n${FEEDBACK_CLOSE}`);
      }
      // Still the round's own prompt and the description's own, with the
      // section under each rather than in place of it.
      expect(fed[0]).toContain(expectedReviewPrompt(scratch.plan, { index: 1, of: 2 }));
      expect(fed[1]).toContain(expectedDescribePrompt(scratch.plan));
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // The verbatim log line is still the whole prompt, so "what exactly was this
  // agent told" answers with the feedback too (`run.sh:1144-1149`).
  it.scoped("logs the assembled prompt with the feedback in it, naming the root", () =>
    Effect.gen(function* () {
      const scratch = yield* world();
      const plan = steered(scratch.plan);
      yield* Effect.scoped(
        Effect.flatMap(AgentCli, (agent) =>
          agent.implement(handleFor(plan), plan, Option.none(), Option.none()),
        ),
      ).pipe(Effect.provide(scratch.layer));

      const [assembled] = promptsIn(yield* Ref.get(scratch.events));
      expect(assembled?.root).toBe("package");
      expect(assembled?.prompt).toContain(FEEDBACK);
      expect(assembled?.prompt).toBe((yield* Ref.get(scratch.fed))[0]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
});

// The pass whose task was stated inline (T17's arm, as T66 left it): the
// resumed spec is gone, so the text the dispatcher typed is the task and the
// pass is handed what the branch's PR says today.
describe("the pass whose task is stated inline", () => {
  const TEXT = "the release note contradicts the flag's default — fix both";

  // Chart row 6, whole: the inline arm plus the identity a resume carries
  // forward — which is what the resuming sentence is keyed off (T66).
  const inlineTask = (plan: DispatchPlan): DispatchPlan => ({
    ...plan,
    task: { _tag: "Inline", text: TEXT, feedback: Option.none() },
    identity: {
      _tag: "FeedbackResume",
      resumed: { _tag: "OneOff", spec: "tasks/T9.md" },
      resumedRunId: Option.some("bessemer-t9-1786000000000"),
    },
  });

  it.scoped("hands the pass the task and quotes the PR the run is iterating", () =>
    Effect.gen(function* () {
      const scratch = yield* world();
      const plan = inlineTask(scratch.plan);
      yield* Effect.scoped(
        Effect.flatMap(AgentCli, (agent) =>
          agent.implement(
            { name: plan.containerId, id: CONTAINER_ID },
            plan,
            Option.none(),
            Option.some(PR),
          ),
        ),
      ).pipe(Effect.provide(scratch.layer));

      const [fed] = yield* Ref.get(scratch.fed);
      expect(fed).toContain(`${TASK_OPEN}\n${TEXT}\n${TASK_CLOSE}`);
      expect(fed).toContain(`This run resumes branch ${plan.branch}`);
      expect(fed).toContain(`Title: ${PR.title}`);
      expect(fed).toContain(PR.body);
      // The template is still whichever one won — this is the same pass with a
      // different dispatcher's message, not a fourth prompt file.
      expect(fed).toContain(readFileSync(packagePromptPath(IMPLEMENT_PROMPT), "utf8").trimEnd());
      // And not the spec-run message: nothing is mounted at /spec.md. Since
      // T37 the template that won does not name the file either, and the
      // backstop only answers a template that does — so the path does not occur
      // anywhere in what the pass was fed.
      expect(fed).not.toContain("/spec.md");
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped("asks the review round whether the task was addressed", () =>
    Effect.gen(function* () {
      const scratch = yield* world();
      const plan = inlineTask(scratch.plan);
      yield* Effect.scoped(
        Effect.flatMap(AgentCli, (agent) =>
          agent.review({ name: plan.containerId, id: CONTAINER_ID }, plan, Option.none(), {
            index: 1,
            of: 2,
          }),
        ),
      ).pipe(Effect.provide(scratch.layer));

      const [fed] = yield* Ref.get(scratch.fed);
      expect(fed).toContain(
        inlineTaskReviewCriteria(readFileSync(packagePromptPath(REVIEW_PROMPT), "utf8")),
      );
      expect(fed).toContain(`${TASK_OPEN}\n${TEXT}\n${TASK_CLOSE}`);
      // And no more than the implement pass is: nothing is mounted at
      // /spec.md, and neither the round's message nor the template it was
      // assembled over names the file at all (T37).
      expect(fed).not.toContain("/spec.md");
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // The third pass sees the task for the first time since T66: until the
  // collapse it saw the text only because it was the run's feedback.
  it.scoped("gives the description pass the task the branch was run for", () =>
    Effect.gen(function* () {
      const scratch = yield* world();
      const plan = inlineTask(scratch.plan);
      yield* Effect.scoped(
        Effect.flatMap(AgentCli, (agent) =>
          agent.describePr({ name: plan.containerId, id: CONTAINER_ID }, plan, Option.none()),
        ),
      ).pipe(Effect.provide(scratch.layer));

      const [fed] = yield* Ref.get(scratch.fed);
      expect(fed).toContain(`${TASK_OPEN}\n${TEXT}\n${TASK_CLOSE}`);
      expect(fed).not.toContain("/spec.md");
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
});

// The task stated on the command line (T67, chart row 3), at the seam: the
// same arm as above with a **fresh** identity, and the property the whole flag
// rests on — the text rides the stdin prompt pipe T9 built, so a shell never
// sees it and nothing in it is expanded.
describe("the pass whose task was stated on the command line", () => {
  // Every character a shell would act on, in one string.
  const HOSTILE = 'drop the `$(uname)` call; keep "quotes" and $HOME literal';

  const stated = (plan: DispatchPlan): DispatchPlan => ({
    ...plan,
    task: { _tag: "Inline", text: HOSTILE, feedback: Option.none() },
    identity: { _tag: "InlineTask", task: HOSTILE },
  });

  it.scoped("feeds all three passes the text byte for byte, and no argv any of it", () =>
    Effect.gen(function* () {
      const scratch = yield* world();
      const plan = stated(scratch.plan);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agent = yield* AgentCli;
          const handle = { name: plan.containerId, id: CONTAINER_ID };
          yield* agent.implement(handle, plan, Option.none(), Option.none());
          yield* agent.review(handle, plan, Option.none(), { index: 1, of: 2 });
          yield* agent.describePr(handle, plan, Option.none());
        }),
      ).pipe(Effect.provide(scratch.layer));

      const fed = yield* Ref.get(scratch.fed);
      expect(fed).toHaveLength(3);
      for (const prompt of fed) {
        // Literally: no shell ever saw it, so nothing in it was expanded.
        expect(prompt).toContain(`${TASK_OPEN}\n${HOSTILE}\n${TASK_CLOSE}`);
        expect(prompt).not.toContain("/spec.md");
      }
      // A fresh dispatch: nothing on the branch this pass did not put there,
      // so the implement message says nothing about resuming (T66).
      expect(fed[0]).not.toContain("resumes branch");
      for (const command of dockerIn(yield* Ref.get(scratch.commands))) {
        expect(command).not.toContain("uname");
        expect(command).not.toContain(TASK_OPEN);
      }
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
});

// The pass of a feature run (T75): the same three passes, told which issue
// each of them is for. The messages themselves are `test/agent-prompt.test.ts`'s
// — what this file asserts is that the fact crosses the seam at all: into the
// prompt on the pipe, and onto the event the run log keeps.
describe("the passes of a feature run", () => {
  const ISSUES = [fakeIssue("T70"), fakeIssue("T71")];
  const FIRST = ISSUES[0] ?? fakeIssue("T70");
  const FOLDER = "docs/wayfinder/effect-agentbox";

  const featureRun = (plan: DispatchPlan): DispatchPlan => ({
    ...plan,
    ...featureDispatch(FOLDER, { request: { _tag: "All" }, issues: ISSUES }),
  });

  // The SHA the branch stood at when this issue's implement pass began — the
  // merge-base here, which is where the first issue of a fresh run stands.
  const CURRENT = Option.some({ issue: FIRST, boundary: MERGE_BASE_SHA });

  it.scoped("feeds each pass its issue and logs which issue the prompt was for", () =>
    Effect.gen(function* () {
      const scratch = yield* world();
      const plan = featureRun(scratch.plan);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agent = yield* AgentCli;
          const handle = { name: plan.containerId, id: CONTAINER_ID };
          yield* agent.implement(handle, plan, CURRENT, Option.none());
          yield* agent.review(handle, plan, CURRENT, { index: 1, of: 2 });
          yield* agent.describePr(handle, plan, Option.none());
        }),
      ).pipe(Effect.provide(scratch.layer));

      const fed = yield* Ref.get(scratch.fed);
      expect(fed).toHaveLength(3);
      // The implement pass is sent to the file, the round judges against it,
      // and the description pass is given the set — and none of the three is
      // sent to a spec, because a feature run mounts none (`sandbox/spec.ts`).
      expect(fed[0]).toContain("Your task is the issue file /feature-issues/T70-a-thing-to-do.md");
      expect(fed[1]).toContain(`for issue ${FIRST.title} — every commit after ${MERGE_BASE_SHA}`);
      expect(fed[2]).toContain(`a feature run over ${FOLDER}: issues T70, T71`);
      for (const prompt of fed) {
        expect(prompt).not.toContain("/spec.md");
      }

      // And the id on the event the log block is rendered from (T14, T75) —
      // some for the two passes that are for an issue, none for the one that
      // is for the branch.
      expect(
        (yield* Ref.get(scratch.events)).flatMap((event) =>
          event._tag === "PromptAssembled" ? [[event.pass, event.issue] as const] : [],
        ),
      ).toEqual([
        ["implement", Option.some(FIRST.id)],
        ["review", Option.some(FIRST.id)],
        ["describe-pr", Option.none()],
      ]);
      // And on the event that closes the same bracket (T76): the log line, the
      // console rule, and the step notification a feature run sends per issue
      // are all rendered off this one, so an id that reached the prompt and
      // not this would leave three passes of one issue indistinguishable from
      // the next issue's three.
      expect(
        (yield* Ref.get(scratch.events)).flatMap((event) =>
          event._tag === "AgentPassFinished" ? [[event.pass, event.issue] as const] : [],
        ),
      ).toEqual([
        ["implement", Option.some(FIRST.id)],
        ["review", Option.some(FIRST.id)],
        ["describe-pr", Option.none()],
      ]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // The other end of that bracket (T76): a pass that failed for an issue says
  // which one, and on a feature run that is the line saying where the sequence
  // stopped — the loop catches the error, so this event is the only thing that
  // names the issue in the log.
  it.scoped("names the issue on the failure event too", () =>
    Effect.gen(function* () {
      const scratch = yield* world({
        ...happyScript,
        "docker exec": { exit: 1, stderr: "Credit balance is too low\n" },
      });
      const plan = featureRun(scratch.plan);
      const outcome = yield* Effect.either(
        Effect.scoped(
          Effect.flatMap(AgentCli, (agent) =>
            agent.implement(
              { name: plan.containerId, id: CONTAINER_ID },
              plan,
              CURRENT,
              Option.none(),
            ),
          ),
        ).pipe(Effect.provide(scratch.layer)),
      );

      expect(Either.isLeft(outcome)).toBe(true);
      expect(
        passFailuresIn(yield* Ref.get(scratch.events)).map((event) => [event.pass, event.issue]),
      ).toEqual([["implement", Option.some(FIRST.id)]]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
});
