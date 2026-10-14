// `Notifier` (T13): the tag, its live layer over the host binary, and the two
// places a run reaches for it — the terminal row and, at `notify = steps`, the
// `Reporter` event stream.
//
// Matrix row 21 is here: a notifier that fails leaves the run's row, its event
// stream, and its exit status exactly as they were and produces one `Reporter`
// warning. So is the host case that is not a failure at all — a machine with
// no notifier binary — which degrades to the same warning rather than to a
// crash on the one path that exists to tell somebody the run is over.
import { describe, expect, it } from "@effect/vitest";
import { FileSystem } from "@effect/platform";
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { DateTime, Duration, Effect, Either, Exit, Layer, Option, Ref } from "effect";
import {
  BessemerConfig,
  type BessemerConfigShape,
  defaultConfig,
  defaultConfigFor,
} from "../src/config/config.ts";
import { land } from "../src/dispatch/land.ts";
import { type DispatchPlan, planFor, specDispatch } from "../src/dispatch/plan.ts";
import { openPullRequest } from "../src/dispatch/pr.ts";
import { atStage, runInScope } from "../src/dispatch/run.ts";
import { Ledger } from "../src/ledger/ledger.ts";
import { CURRENT_SCHEMA_VERSION, type IssueOutcome, type RunRecord } from "../src/ledger/record.ts";
import { RunLockLive } from "../src/lock/run-lock.ts";
import {
  notificationTitleFor,
  notifyTerminal,
  stepNotificationBodyFor,
  terminalNotificationFor,
  withStepNotifications,
} from "../src/notify/notifications.ts";
import { type Notification, Notifier, NotifierLive } from "../src/notify/notifier.ts";
import {
  type AgentPass,
  Reporter,
  type ReporterEvent,
  type ReporterShape,
} from "../src/reporter.ts";
import type { SandboxSpec } from "../src/sandbox/spec.ts";
import { fakeAgentCli, ZERO_PASS_USAGE } from "./support/agent-cli-fake.ts";
import { TEST_CREDENTIAL } from "./support/credential.ts";
import { TEST_FORGE_REPO } from "./support/repo-slug.ts";
import { fakeIssueStore } from "./support/issue-store-fake.ts";
import { type ScriptedResult, scriptedExecutor } from "./support/exec-fake.ts";
import { fakeForge, type ForgeCall, PR_NUMBER, PR_URL } from "./support/forge-fake.ts";
import { CLONE_TIP, fakeGit, type GitCall, PRE_TIP } from "./support/git-fake.ts";
import { fakeNotifier } from "./support/notifier-fake.ts";
import { fakeSandbox } from "./support/sandbox-fake.ts";
import { PLAN_TIP } from "./support/plan.ts";

const BRANCH = "bessemer-t13";
const BASE_REF = "origin/master";
const BASE_SHA = "1111111111111111111111111111111111111111";
const MERGE_BASE_SHA = "2222222222222222222222222222222222222222";

const plan = planFor({
  ...specDispatch("/repo/tasks/T13-notifier.md"),
  branch: BRANCH,
  baseRef: BASE_REF,
  baseSha: BASE_SHA,
  mergeBaseSha: MERGE_BASE_SHA,
  tipSha: PLAN_TIP,
  runtimeRoot: "/runtime",
  startedAt: DateTime.unsafeMake("2026-01-01T00:00:00.000Z"),
});

// A terminal row as `run.ts` writes it, with only the two fields a
// notification reads varying per case.
const rowWith = (fields: Partial<RunRecord>): RunRecord => ({
  schemaVersion: CURRENT_SCHEMA_VERSION,
  runId: Option.some(`${plan.slug}-1`),
  branch: BRANCH,
  identity: plan.identity,
  startedAt: Option.some(DateTime.unsafeMake("2026-08-14T09:00:00.000Z")),
  endedAt: DateTime.unsafeMake("2026-08-14T09:41:00.000Z"),
  terminalReason: Option.some({ _tag: "Completed" }),
  outcome: Option.some("approved"),
  base: { ref: BASE_REF, sha: Option.some(BASE_SHA) },
  mergeBaseSha: Option.some(MERGE_BASE_SHA),
  pr: Option.some({ number: Option.some(PR_NUMBER), url: PR_URL }),
  rescuedOnto: Option.none(),
  discardedTip: Option.none(),
  dispatcher: Option.none(),
  staleDispatcherOverridden: Option.none(),
  tokensIn: Option.none(),
  tokensOut: Option.none(),
  cacheWrite: Option.none(),
  cacheRead: Option.none(),
  passes: Option.none(),
  models: Option.none(),
  ...fields,
});

const TITLE = "bessemer: bessemer-t13";
// A body carrying what an interpolated AppleScript string would break on. It
// travels as argv, so it arrives whole.
const BODY = `approved — PR: https://example.test/pull/1 "don't" 'quote' me`;

// One notification through the real layer, against a scripted executor and
// recording every argv it spawned.
const notifying = (script: Record<string, ScriptedResult>) =>
  Effect.gen(function* () {
    const commands = yield* Ref.make<ReadonlyArray<string>>([]);
    const outcome = yield* Notifier.pipe(
      Effect.flatMap((notifier) => notifier.notify({ title: TITLE, body: BODY })),
      Effect.either,
      Effect.provide(Layer.provide(NotifierLive, scriptedExecutor(script, commands))),
    );
    return { outcome, commands: yield* Ref.get(commands) };
  });

describe("the live notifier", () => {
  it.effect("passes the title and the body as arguments, never as script text", () =>
    Effect.gen(function* () {
      const { outcome, commands } = yield* notifying({ osascript: { exit: 0 } });
      expect(Either.isRight(outcome)).toBe(true);
      expect(commands).toHaveLength(1);
      const spawned = commands[0] ?? "";
      // The script text is one word of argv and the two values are two more:
      // the body ends the command line rather than sitting inside the `-e`
      // string, which is what makes a quote in a branch name harmless.
      expect(spawned.startsWith("osascript -e on run argv")).toBe(true);
      expect(spawned.endsWith(`${TITLE} ${BODY}`)).toBe(true);
      expect(spawned).toContain(
        "display notification (item 2 of argv) with title (item 1 of argv)",
      );
    }),
  );

  it.effect("reports a nonzero exit as a typed failure carrying what the binary said", () =>
    Effect.gen(function* () {
      const { outcome } = yield* notifying({
        osascript: { exit: 1, stderr: "execution error: Not authorized (-1743)\n" },
      });
      expect(Either.isLeft(outcome)).toBe(true);
      if (Either.isRight(outcome)) {
        return;
      }
      expect(outcome.left.detail).toContain("osascript exited 1");
      expect(outcome.left.detail).toContain("Not authorized");
    }),
  );

  // The probe: nothing is scripted, so the spawn fails the way a host without
  // the binary fails it. It is a typed `NotifyError` naming the binary, and
  // never a defect — the call sites below are what turn it into a warning.
  it.effect("degrades an absent binary to a typed failure that names it", () =>
    Effect.gen(function* () {
      const { outcome } = yield* notifying({});
      expect(Either.isLeft(outcome)).toBe(true);
      if (Either.isRight(outcome)) {
        return;
      }
      expect(outcome.left.detail).toContain("osascript not found");
    }),
  );
});

describe("what a run tells the dispatcher at the end", () => {
  it("leads with the verdict and carries the PR", () => {
    const notification = terminalNotificationFor(plan, rowWith({}));
    expect(notification.title).toBe(notificationTitleFor(BRANCH));
    expect(notification.body).toBe(`approved — PR: ${PR_URL}`);
  });

  // A completed run with no PR is the nothing-to-land case and only that one:
  // the PR step is skipped exactly when the land found nothing past the
  // boundary, and a step that ran and failed leaves a `Failed` row instead.
  it("says nothing was landed when a completed run opened no PR", () => {
    const body = terminalNotificationFor(plan, rowWith({ pr: Option.none() })).body;
    expect(body).toBe("approved — no commits to land");
  });

  it("leads with the stage a failed run stopped at, and where to read about it", () => {
    const body = terminalNotificationFor(
      plan,
      rowWith({
        terminalReason: Option.some({ _tag: "Failed", stage: "implement" }),
        outcome: Option.none(),
        pr: Option.none(),
      }),
    ).body;
    expect(body).toBe(`failed: implement — see ${Option.getOrThrow(plan.logPath)}`);
  });

  // A crashed or interrupted run says how it stopped and never claims an
  // outcome the review never reached — and neither says "no commits to land",
  // which on those paths would only mean "it never got that far".
  it("says how a crashed and an interrupted run stopped", () => {
    expect(
      terminalNotificationFor(
        plan,
        rowWith({
          terminalReason: Option.some({ _tag: "Crashed" }),
          outcome: Option.none(),
          pr: Option.none(),
        }),
      ).body,
    ).toBe(`crashed — see ${Option.getOrThrow(plan.logPath)}`);
    expect(
      terminalNotificationFor(
        plan,
        rowWith({
          terminalReason: Option.some({ _tag: "Interrupted" }),
          outcome: Option.none(),
          pr: Option.none(),
        }),
      ).body,
    ).toBe("interrupted");
  });

  // A feature run has no single verdict to lead with (T76), so its head is
  // what the sequence came to: the issue it stopped on, or that every selected
  // one is done (`run.sh:2168-2172`). Both are read off the row's own
  // outcomes, so the sentence and the row cannot disagree.
  it("names the issue a feature run stopped on, or says none stopped it", () => {
    const featureRow = (issues: ReadonlyArray<IssueOutcome>): RunRecord =>
      rowWith({
        identity: { _tag: "Feature", feature: "tasks/f", issues },
        outcome: Option.none(),
      });
    expect(
      terminalNotificationFor(
        plan,
        featureRow([
          { issue: "T70", outcome: "approved" },
          { issue: "T71", outcome: "needs-work" },
          { issue: "T72", outcome: "not-attempted" },
        ]),
      ).body,
    ).toBe(`stopped: issue T71 — needs-work — PR: ${PR_URL}`);
    expect(
      terminalNotificationFor(plan, featureRow([{ issue: "T70", outcome: "approved" }])).body,
    ).toBe(`all selected issues completed — PR: ${PR_URL}`);
  });

  // The tracer's other half (T31): the run failed at the land, which is what
  // the dispatcher already feared, and the sentence goes on to settle it —
  // the commits are on a branch of the run's own, named, in the same
  // notification and without opening the log.
  it("names the rescue branch, on the same footing as the PR URL", () => {
    const body = terminalNotificationFor(
      plan,
      rowWith({
        terminalReason: Option.some({ _tag: "Failed", stage: "land" }),
        outcome: Option.none(),
        pr: Option.none(),
        rescuedOnto: Option.some(`${BRANCH}-from-run-a1b2c3d`),
      }),
    ).body;
    expect(body).toBe(
      `failed: land — see ${Option.getOrThrow(plan.logPath)} — commits on '${BRANCH}-from-run-a1b2c3d'`,
    );
  });

  // A run whose commits are in a kept checkout has no rescue, and the
  // notification says nothing extra: a directory is not something to merge
  // from, and the log's loud warning is what that case has always had.
  it("says nothing about a rescue when there was none", () => {
    const body = terminalNotificationFor(
      plan,
      rowWith({
        terminalReason: Option.some({ _tag: "Failed", stage: "land" }),
        outcome: Option.none(),
        pr: Option.none(),
      }),
    ).body;
    expect(body).toBe(`failed: land — see ${Option.getOrThrow(plan.logPath)}`);
  });

  // The PR still travels on the paths that opened one before failing — a run
  // that pushed and then could not edit its PR is the case, and the URL is
  // what a dispatcher does something with.
  it("carries the PR of a run that failed after opening one", () => {
    const body = terminalNotificationFor(
      plan,
      rowWith({
        terminalReason: Option.some({ _tag: "Failed", stage: "pr" }),
        outcome: Option.none(),
      }),
    ).body;
    expect(body).toBe(`failed: pr — see ${Option.getOrThrow(plan.logPath)} — PR: ${PR_URL}`);
  });
});

const bodyFor = (event: ReporterEvent): string | undefined =>
  Option.getOrUndefined(stepNotificationBodyFor(event));

// The one event `steps` still notifies about, so the verbosity tests below
// discriminate: at `off` and `end` this sends nothing and at `steps` it sends
// one, which an event no verbosity notifies about could not tell apart.
const REVIEW_ROUND: ReporterEvent = {
  _tag: "ReviewVerdictReached",
  issue: Option.none(),
  round: { index: 1, of: 3 },
  verdict: "approved",
};

// A pass closing, with the figures it carries from T55. What it cost is
// nothing this file reads — which pass it was is the whole of the rule.
const passFinished = (pass: AgentPass): ReporterEvent => ({
  _tag: "AgentPassFinished",
  pass,
  issue: Option.none(),
  elapsed: Duration.minutes(12),
  usage: ZERO_PASS_USAGE,
});

describe("which events are a step", () => {
  // The longest wait in a run ending, and the place this list is *wider* than
  // bash's `notify_step`, which has no equivalent.
  it("notifies when the implement pass finishes", () => {
    expect(bodyFor(passFinished("implement"))).toBe(
      "implement pass finished — the review rounds start now",
    );
  });

  // The other two passes end into something that already says the boundary
  // better: a round into its own verdict, and the description pass into the
  // PR the terminal notification carries.
  it("stays silent when the review and description passes finish", () => {
    expect(bodyFor(passFinished("review"))).toBe(undefined);
    expect(bodyFor(passFinished("describe-pr"))).toBe(undefined);
  });

  // **A failed pass is not a step** (T55): the run is over, and the terminal
  // notification that follows it says so with the stage attached. A send here
  // would be the same news twice, seconds apart.
  it("stays silent when a pass fails", () => {
    expect(
      bodyFor({
        _tag: "PassFailed",
        pass: "implement",
        issue: Option.none(),
        reason: "timed-out",
        detail: "the implement pass timed out at 1800s",
        elapsed: Duration.minutes(30),
        usage: Option.none(),
      }),
    ).toBe(undefined);
  });

  // **The one event that notifies mid-pass** (T52), and bash's own
  // `notify_step` text (`run.sh:1498`): the advisory is about the ticket that
  // was dispatched, which is the one thing a dispatcher who walked away can
  // still act on — and cannot act on once the run has ended.
  it("notifies when an implement pass has read without writing", () => {
    expect(
      bodyFor({
        _tag: "NoWritesYet",
        pass: "implement",
        elapsed: Duration.minutes(10),
        budget: Duration.minutes(30),
      }),
    ).toBe("still reading at 10m — check ticket size");
  });

  // Its twin says nothing has happened yet, every two minutes: a notification
  // per heartbeat is not a verbosity anyone asked for.
  it("stays silent for the heartbeat", () => {
    expect(
      bodyFor({
        _tag: "PassStillRunning",
        pass: "implement",
        elapsed: Duration.minutes(2),
        budget: Duration.minutes(30),
      }),
    ).toBe(undefined);
  });

  // The one boundary with real waiting on both sides of it, and so the only
  // one left: a round decided, and another pass is about to start.
  it("notifies at the review round", () => {
    expect(
      bodyFor({
        _tag: "ReviewVerdictReached",
        issue: Option.none(),
        round: { index: 2, of: 3 },
        verdict: "needs-work",
      }),
    ).toBe("review round 2/3: needs-work");
  });

  // The two boundaries AGENTS.md admits, said once per issue (T76): a feature
  // run reaches both of them three times over, and three bodies with no id in
  // them read as one run stuttering. No new event notifies — these are the
  // same two, with the issue in front.
  it("names the issue in both bodies on a feature run", () => {
    expect(
      bodyFor({
        _tag: "AgentPassFinished",
        pass: "implement",
        issue: Option.some("T70"),
        elapsed: Duration.minutes(12),
        usage: ZERO_PASS_USAGE,
      }),
    ).toBe("issue T70 implement pass finished — the review rounds start now");
    expect(
      bodyFor({
        _tag: "ReviewVerdictReached",
        issue: Option.some("T70"),
        round: { index: 2, of: 3 },
        verdict: "needs-work",
      }),
    ).toBe("issue T70 review round 2/3: needs-work");
  });

  // The end of the run said early. Each of these is followed within seconds by
  // the terminal notification, which carries the verdict *and* the PR URL — so
  // sending them here too is the same news twice, which a dispatcher who
  // walked away reads as two runs finishing rather than one.
  it("stays silent for the landing, the PR, and the empty branch", () => {
    expect(
      bodyFor({ _tag: "CommitsPushed", thisRun: 2, sinceBoundary: 5, statusCommit: false }),
    ).toBe(undefined);
    expect(bodyFor({ _tag: "NothingToLand" })).toBe(undefined);
    expect(bodyFor({ _tag: "ResetPushed", branch: "b", originTip: "9".repeat(40) })).toBe(
      undefined,
    );
    expect(
      bodyFor({
        _tag: "PullRequestReady",
        pr: { number: Option.some(PR_NUMBER), url: PR_URL },
        action: "created",
      }),
    ).toBe(undefined);
  });

  // bash's setup-complete boundary (`run.sh:1377`), and this package's
  // deliberate departure from it: it arrives while the dispatch command is
  // still on screen, so it tells a dispatcher who has not left yet something
  // they are watching happen — and one who has left reads it as the end.
  it("stays silent when the environment comes up", () => {
    expect(bodyFor({ _tag: "ResourceAcquired", resource: "sandbox" })).toBe(undefined);
  });

  // The narration is not a phase boundary: a desktop notification per line an
  // agent prints is not a verbosity anyone asked for. Neither is a warning —
  // which is where this file's own failures land.
  it("stays silent for narration, warnings, and teardown", () => {
    expect(
      bodyFor({ _tag: "AgentOutput", pass: "implement", kind: "text", text: "editing run.ts" }),
    ).toBe(undefined);
    expect(
      bodyFor({
        _tag: "PromptAssembled",
        pass: "review",
        prompt: "...",
        root: "package",
        issue: Option.none(),
      }),
    ).toBe(undefined);
    expect(bodyFor({ _tag: "Warned", detail: "notification not sent" })).toBe(undefined);
    expect(bodyFor({ _tag: "ResourceReleased", resource: "sandbox" })).toBe(undefined);
    expect(bodyFor({ _tag: "ResourceAcquired", resource: "lock" })).toBe(undefined);
    expect(bodyFor({ _tag: "ResourceAcquired", resource: "checkout" })).toBe(undefined);
  });
});

// The three verbosities at the call sites, with the run itself out of the
// picture: what `notify` decides is how many times the seam is crossed.
interface Sent {
  readonly notifications: ReadonlyArray<Notification>;
  readonly events: ReadonlyArray<ReporterEvent>;
}

const withNotifier = <A>(
  notify: BessemerConfigShape["notify"],
  use: (reporter: ReporterShape) => Effect.Effect<A, never, Notifier | BessemerConfig | Reporter>,
  options: { readonly fails?: string } = {},
): Effect.Effect<Sent> =>
  Effect.gen(function* () {
    const notifications = yield* Ref.make<ReadonlyArray<Notification>>([]);
    const events = yield* Ref.make<ReadonlyArray<ReporterEvent>>([]);
    const base: ReporterShape = {
      emit: (event) => Ref.update(events, (current) => [...current, event]),
    };
    yield* use(base).pipe(
      Effect.provide(
        Layer.mergeAll(
          fakeNotifier({ sent: notifications, ...options }),
          Layer.succeed(BessemerConfig, { ...defaultConfigFor("/repo"), notify }),
          Layer.succeed(Reporter, base),
        ),
      ),
    );
    return { notifications: yield* Ref.get(notifications), events: yield* Ref.get(events) };
  });

const warningsIn = (events: ReadonlyArray<ReporterEvent>): ReadonlyArray<string> =>
  events.flatMap((event) => (event._tag === "Warned" ? [event.detail] : []));

describe("the notify verbosity", () => {
  it.effect("invokes the notifier zero times at off", () =>
    Effect.gen(function* () {
      const sent = yield* withNotifier("off", (base) =>
        Effect.gen(function* () {
          yield* notifyTerminal(plan, rowWith({}));
          const subscriber = yield* withStepNotifications(plan, base);
          yield* subscriber.emit(REVIEW_ROUND);
          yield* subscriber.emit({
            _tag: "CommitsPushed",
            thisRun: 2,
            sinceBoundary: 5,
            statusCommit: false,
          });
        }),
      );
      expect(sent.notifications).toEqual([]);
      // The stream itself is untouched: the subscriber below `steps` is the
      // one it was handed.
      expect(sent.events).toHaveLength(2);
    }),
  );

  it.effect("sends exactly one notification at end, carrying the outcome and the PR", () =>
    Effect.gen(function* () {
      const sent = yield* withNotifier("end", (base) =>
        Effect.gen(function* () {
          const subscriber = yield* withStepNotifications(plan, base);
          yield* subscriber.emit(REVIEW_ROUND);
          yield* subscriber.emit({
            _tag: "CommitsPushed",
            thisRun: 2,
            sinceBoundary: 5,
            statusCommit: false,
          });
          yield* notifyTerminal(plan, rowWith({}));
        }),
      );
      expect(sent.notifications).toEqual([{ title: TITLE, body: `approved — PR: ${PR_URL}` }]);
    }),
  );

  it.effect("adds the step notifications at steps", () =>
    Effect.gen(function* () {
      const sent = yield* withNotifier("steps", (base) =>
        Effect.gen(function* () {
          const subscriber = yield* withStepNotifications(plan, base);
          yield* subscriber.emit(REVIEW_ROUND);
          yield* subscriber.emit({
            _tag: "AgentOutput",
            pass: "implement",
            kind: "tool-use",
            tool: "Edit",
            brief: "src/run.ts",
          });
          yield* subscriber.emit({
            _tag: "CommitsPushed",
            thisRun: 2,
            sinceBoundary: 5,
            statusCommit: false,
          });
          yield* notifyTerminal(plan, rowWith({}));
        }),
      );
      expect(sent.notifications.map((notification) => notification.body)).toEqual([
        "review round 1/3: approved",
        `approved — PR: ${PR_URL}`,
      ]);
      // One stream, three renderers: every event still reached the subscriber
      // underneath, narration included.
      expect(sent.events).toHaveLength(3);
    }),
  );

  // Matrix row 21, at the call sites: a notifier that refuses produces one
  // warning per send and nothing else — no error to catch, and nothing in the
  // event stream but the warning.
  it.effect("swallows a failing notifier into a Reporter warning", () =>
    Effect.gen(function* () {
      const sent = yield* withNotifier(
        "steps",
        (base) =>
          Effect.gen(function* () {
            const subscriber = yield* withStepNotifications(plan, base);
            yield* subscriber.emit(REVIEW_ROUND);
            yield* notifyTerminal(plan, rowWith({}));
          }),
        { fails: "osascript not found — this host sends no desktop notifications" },
      );
      expect(sent.notifications).toHaveLength(2);
      const warnings = warningsIn(sent.events);
      expect(warnings).toHaveLength(2);
      expect(warnings[0]).toContain("notification not sent (osascript not found");
      expect(warnings[0]).toContain("the run is unaffected");
    }),
  );
});

// The whole run, so "one notification at the terminal row" is asserted where
// the row is written rather than beside a hand-built record — and so a
// notifier that fails is measured against the three observables SPEC §11
// names: the event stream, the ledger rows, and the failure channel.
interface RunWorldOptions {
  readonly notify?: BessemerConfigShape["notify"];
  // The notifier the run gets. It is the fake by default; the missing-binary
  // case below hands it the real layer over an executor that spawns nothing.
  readonly notifier?: Layer.Layer<Notifier>;
  readonly notifierFails?: string;
  // The land's fetch home refused, which is the run the rescue exists for: the
  // land fails at its own stage and the release then sends the commits onto a
  // branch of the run's own (T29, T31).
  readonly homeFetchBackFails?: string;
}

const runWorld = (options: RunWorldOptions = {}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const runtimeRoot = yield* fs.makeTempDirectoryScoped();
    const repoRoot = yield* fs.makeTempDirectoryScoped();
    const events = yield* Ref.make<ReadonlyArray<ReporterEvent>>([]);
    const appended = yield* Ref.make<ReadonlyArray<RunRecord>>([]);
    const notifications = yield* Ref.make<ReadonlyArray<Notification>>([]);
    const gitCalls = yield* Ref.make<ReadonlyArray<GitCall>>([]);
    const forgeCalls = yield* Ref.make<ReadonlyArray<ForgeCall>>([]);
    const sandboxes = yield* Ref.make<ReadonlyArray<SandboxSpec>>([]);

    const runPlan = planFor({
      ...specDispatch(`${repoRoot}/tasks/T13-notifier.md`),
      branch: BRANCH,
      baseRef: BASE_REF,
      baseSha: BASE_SHA,
      mergeBaseSha: MERGE_BASE_SHA,
      tipSha: PLAN_TIP,
      runtimeRoot,
      startedAt: DateTime.unsafeMake("2026-01-01T00:00:00.000Z"),
    });

    const layer = Layer.provideMerge(
      Layer.mergeAll(
        RunLockLive,
        // A run that worked: five commits past the boundary, two of them this
        // run's, so the land pushes and the PR step opens a draft.
        fakeGit(gitCalls, {
          counts: { [MERGE_BASE_SHA]: 5, [PRE_TIP]: 2 },
          ...(options.homeFetchBackFails === undefined
            ? {}
            : { homeFetchBackFails: options.homeFetchBackFails }),
        }),
        fakeForge(forgeCalls),
        fakeIssueStore(),
        fakeSandbox(sandboxes),
        options.notifier ??
          fakeNotifier(
            options.notifierFails === undefined
              ? { sent: notifications }
              : { sent: notifications, fails: options.notifierFails },
          ),
        fakeAgentCli({ verdicts: ["approved"] }),
      ),
      Layer.mergeAll(
        NodeFileSystem.layer,
        NodePath.layer,
        scriptedExecutor({}),
        Layer.succeed(BessemerConfig, {
          ...defaultConfig,
          runtimeRoot,
          notify: options.notify ?? defaultConfig.notify,
        }),
        Layer.succeed(Reporter, {
          emit: (event) => Ref.update(events, (current) => [...current, event]),
        }),
        Layer.succeed(Ledger, {
          append: (record) => Ref.update(appended, (current) => [...current, record]),
          recent: () => Effect.succeed([]),
          lastBaseForBranch: () => Effect.succeed(Option.none()),
          resolveResume: () => Effect.die("a notification never resumes"),
          newestBranchForIssue: () => Effect.die("a notification dispatches no feature"),
        }),
      ),
    );

    return { runtimeRoot, repoRoot, plan: runPlan, events, appended, notifications, layer };
  });

// The `work` as `dispatch.ts` composes it: the land, then the PR on what it
// pushed.
const runLandingAndPr = (scratch: { readonly plan: DispatchPlan; readonly repoRoot: string }) =>
  runInScope(
    scratch.plan,
    scratch.repoRoot,
    TEST_CREDENTIAL,
    TEST_FORGE_REPO,
    ({ sandbox, pr, outcomes }) =>
      land(scratch.plan, scratch.repoRoot, outcomes).pipe(
        Effect.mapError(atStage("land")),
        Effect.flatMap((landed) =>
          landed === "pushed"
            ? openPullRequest(scratch.plan, TEST_FORGE_REPO, sandbox, pr, outcomes).pipe(
                Effect.mapError(atStage("pr")),
              )
            : Effect.void,
        ),
      ),
  );

describe("a run telling the dispatcher it finished", () => {
  it.scoped("sends one notification at the terminal row, carrying the outcome and the PR", () =>
    Effect.gen(function* () {
      const scratch = yield* runWorld({ notify: "end" });
      yield* runLandingAndPr(scratch).pipe(Effect.provide(scratch.layer));

      expect(yield* Ref.get(scratch.notifications)).toEqual([
        { title: notificationTitleFor(BRANCH), body: `approved — PR: ${PR_URL}` },
      ]);
      // And it says what the row says, because it was derived from it.
      const rows = yield* Ref.get(scratch.appended);
      expect(rows[0]?.outcome).toEqual(Option.some("approved"));
      expect(Option.map(rows[0]?.pr ?? Option.none(), (pr) => pr.url)).toEqual(Option.some(PR_URL));
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // The whole tracer (T31), end to end: the land's fetch home is refused, so
  // the run fails at `land` and the release sends the commits onto a branch of
  // the run's own. The dispatcher walked away — what they get is one desktop
  // notification, and it names that branch. The row it was derived from says
  // the same thing, because it is derived from it.
  it.scoped("tells a dispatcher who walked away that the commits are on a rescue branch", () =>
    Effect.gen(function* () {
      const scratch = yield* runWorld({
        notify: "end",
        homeFetchBackFails: "! [rejected] (non-fast-forward)",
      });
      const exit = yield* Effect.exit(runLandingAndPr(scratch).pipe(Effect.provide(scratch.layer)));

      expect(Exit.isSuccess(exit)).toBe(false);
      const rescue = `${BRANCH}-from-run-${CLONE_TIP.slice(0, 7)}`;
      const rows = yield* Ref.get(scratch.appended);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.terminalReason).toEqual(Option.some({ _tag: "Failed", stage: "land" }));
      expect(rows[0]?.rescuedOnto).toEqual(Option.some(rescue));
      expect(yield* Ref.get(scratch.notifications)).toEqual([
        {
          title: notificationTitleFor(BRANCH),
          body: `failed: land — see ${Option.getOrThrow(scratch.plan.logPath)} — commits on '${rescue}'`,
        },
      ]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped("invokes the notifier zero times at off, and still writes the row", () =>
    Effect.gen(function* () {
      const scratch = yield* runWorld({ notify: "off" });
      yield* runLandingAndPr(scratch).pipe(Effect.provide(scratch.layer));

      expect(yield* Ref.get(scratch.notifications)).toEqual([]);
      expect(yield* Ref.get(scratch.appended)).toHaveLength(1);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // The step notifications are the `Reporter` stream's, so they arrive in the
  // order the events did and the terminal one still ends the list.
  //
  // **Three notifications for a whole run, and the last one is the last thing
  // that happens.** This is the assertion the list is kept short for: the run
  // acquires a container, pushes two commits, and opens a PR between these
  // sends, and none of that is worth waking a dispatcher for — the sentence
  // below carries the verdict and the PR URL in one. The review and
  // description passes close silently (T55), so the only pass that wakes
  // anybody is the one with nothing after it to say the same boundary.
  it.scoped("adds the phase boundaries at steps, from the event stream", () =>
    Effect.gen(function* () {
      const scratch = yield* runWorld({ notify: "steps" });
      yield* runLandingAndPr(scratch).pipe(Effect.provide(scratch.layer));

      expect((yield* Ref.get(scratch.notifications)).map((sent) => sent.body)).toEqual([
        "implement pass finished — the review rounds start now",
        "review round 1/3: approved",
        `approved — PR: ${PR_URL}`,
      ]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // Matrix row 21: everything released, the run's own row unchanged, the
  // failure swallowed with a `Reporter` warning — and the run itself a success.
  it.scoped("leaves the row and the exit status alone when the notifier fails", () =>
    Effect.gen(function* () {
      const scratch = yield* runWorld({
        notify: "end",
        notifierFails: "osascript exited 1: execution error",
      });
      const exit = yield* Effect.exit(runLandingAndPr(scratch).pipe(Effect.provide(scratch.layer)));

      expect(Exit.isSuccess(exit)).toBe(true);
      const rows = yield* Ref.get(scratch.appended);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.terminalReason).toEqual(Option.some({ _tag: "Completed" }));
      expect(rows[0]?.outcome).toEqual(Option.some("approved"));
      const warnings = warningsIn(yield* Ref.get(scratch.events));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("notification not sent (osascript exited 1");
      // The warning is on the run's own log too, which is where a dispatcher
      // who did come back reads it.
      const fs = yield* FileSystem.FileSystem;
      expect(yield* fs.readFileString(Option.getOrThrow(scratch.plan.logPath))).toContain(
        "notification not sent",
      );
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // The host with no notifier binary at all, through the *real* layer: nothing
  // is scripted, so the spawn fails the way it fails on a machine without one.
  // It is the same warning, and the run is the same success.
  it.scoped("degrades a host with no notifier binary to a warning", () =>
    Effect.gen(function* () {
      const scratch = yield* runWorld({
        notify: "end",
        notifier: Layer.provide(NotifierLive, scriptedExecutor({})),
      });
      const exit = yield* Effect.exit(runLandingAndPr(scratch).pipe(Effect.provide(scratch.layer)));

      expect(Exit.isSuccess(exit)).toBe(true);
      expect(yield* Ref.get(scratch.appended)).toHaveLength(1);
      const warnings = warningsIn(yield* Ref.get(scratch.events));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("osascript not found");
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
});
