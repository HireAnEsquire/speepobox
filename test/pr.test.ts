// The PR step (T12), as the run composes it: the land, then the description
// pass, then the draft PR — inside the scope, with all three resources still
// held, and after the push.
//
// Matrix row 15 is here (the forge fails with the commits already pushed:
// everything releases, the row is `failed` at stage `pr`, the error is a typed
// `ForgeError`), along with the two things the row learns from this step —
// number and URL together, and neither when no PR was opened.
import { describe, expect, it } from "@effect/vitest";
import { FileSystem } from "@effect/platform";
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { DateTime, Effect, Either, Layer, Option, Ref } from "effect";
import { AgentPassFailed } from "../src/agent/agent-cli.ts";
import { SpeepoboxConfig, defaultConfig } from "../src/config/config.ts";
import { land } from "../src/dispatch/land.ts";
import { APPROVED_OUTCOME, IMPLEMENT_FAILED, issueChecklistFor } from "../src/dispatch/feature.ts";
import { type DispatchPlan, featureDispatch, planFor, specDispatch } from "../src/dispatch/plan.ts";
import { DESCRIPTION_UNAVAILABLE, openPullRequest, prBodyFor } from "../src/dispatch/pr.ts";
import { atStage, runInScope } from "../src/dispatch/run.ts";
import { ForgeError } from "../src/forge/forge.ts";
import { Ledger } from "../src/ledger/ledger.ts";
import type { IssueOutcome, PullRequest, RunRecord } from "../src/ledger/record.ts";
import { RunLockLive } from "../src/lock/run-lock.ts";
import { Reporter, type ReporterEvent } from "../src/reporter.ts";
import type { SandboxSpec } from "../src/sandbox/spec.ts";
import { type FakeAgentCliOptions, fakeAgentCli } from "./support/agent-cli-fake.ts";
import { TEST_CREDENTIAL } from "./support/credential.ts";
import { TEST_FORGE_REPO } from "./support/repo-slug.ts";
import {
  type FakeForgeOptions,
  fakeForge,
  type ForgeCall,
  openPullRequest as OPEN_PR,
  PR_NUMBER,
  PR_URL,
  // What the branch's PR *says*, which is what the forge answers a view with
  // (T17) — the row and the event still record the pair alone.
  viewedPullRequest as VIEWED_PR,
} from "./support/forge-fake.ts";
import { type FakeGitOptions, fakeGit, type GitCall, PRE_TIP } from "./support/git-fake.ts";
import { fakeNotifier } from "./support/notifier-fake.ts";
import { fakeSandbox } from "./support/sandbox-fake.ts";
import { PLAN_TIP } from "./support/plan.ts";
import { fakeIssue, fakeIssueStore } from "./support/issue-store-fake.ts";

const BRANCH = "speepobox-t12";
const BASE_REF = "origin/master";
const BASE_SHA = "1111111111111111111111111111111111111111";
const MERGE_BASE_SHA = "2222222222222222222222222222222222222222";
// A run that committed: five past the diff boundary, two of them this run's.
const WORKED = { [MERGE_BASE_SHA]: 5, [PRE_TIP]: 2 };
const DESCRIPTION = "## Overview\n\nThe forge seam, and the description through it.";

interface WorldOptions {
  readonly git?: FakeGitOptions;
  readonly forge?: FakeForgeOptions;
  readonly agent?: FakeAgentCliOptions;
}

const world = (options: WorldOptions = {}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const runtimeRoot = yield* fs.makeTempDirectoryScoped();
    const repoRoot = yield* fs.makeTempDirectoryScoped();
    const events = yield* Ref.make<ReadonlyArray<ReporterEvent>>([]);
    const appended = yield* Ref.make<ReadonlyArray<RunRecord>>([]);
    const gitCalls = yield* Ref.make<ReadonlyArray<GitCall>>([]);
    const forgeCalls = yield* Ref.make<ReadonlyArray<ForgeCall>>([]);
    const sandboxes = yield* Ref.make<ReadonlyArray<SandboxSpec>>([]);

    const plan = planFor({
      ...specDispatch(`${repoRoot}/tasks/T12-forge-pr.md`),
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
        fakeGit(gitCalls, { counts: WORKED, ...options.git }),
        fakeForge(forgeCalls, options.forge),
        fakeIssueStore(),
        fakeSandbox(sandboxes),
        fakeNotifier(),
        fakeAgentCli({ description: DESCRIPTION, ...options.agent }),
      ),
      Layer.mergeAll(
        NodeFileSystem.layer,
        NodePath.layer,
        Layer.succeed(SpeepoboxConfig, { ...defaultConfig, runtimeRoot }),
        Layer.succeed(Reporter, {
          emit: (event) => Ref.update(events, (current) => [...current, event]),
        }),
        Layer.succeed(Ledger, {
          append: (record) => Ref.update(appended, (current) => [...current, record]),
          recent: () => Effect.succeed([]),
          lastBaseForBranch: () => Effect.succeed(Option.none()),
          resolveResume: () => Effect.die("the PR step never resumes"),
          newestBranchForIssue: () => Effect.die("the PR step dispatches no feature"),
        }),
      ),
    );

    return { runtimeRoot, repoRoot, plan, events, appended, gitCalls, forgeCalls, layer };
  });

// The whole `work` as `dispatch.ts` composes it: land, then the PR on the
// commits it pushed, each staged where it is wired.
const runLandingAndPr = (scratch: {
  readonly plan: ReturnType<typeof planFor>;
  readonly repoRoot: string;
}) =>
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

const warningsIn = (events: ReadonlyArray<ReporterEvent>): ReadonlyArray<string> =>
  events.flatMap((event) => (event._tag === "Warned" ? [event.detail] : []));

const resourceEventsIn = (
  events: ReadonlyArray<ReporterEvent>,
): ReadonlyArray<readonly [string, string]> =>
  events.flatMap((event) =>
    event._tag === "ResourceAcquired" || event._tag === "ResourceReleased"
      ? [[event._tag, event.resource] as const]
      : [],
  );

// The body the step wrote, whichever of create or edit it took.
const bodyOf = (calls: ReadonlyArray<ForgeCall>): string => {
  const written = calls.find((call) => call._tag !== "View");
  return written !== undefined && "body" in written ? written.body : "";
};

describe("the body a PR is opened with", () => {
  const plan = planFor({
    ...specDispatch("/repo/tasks/T12-forge-pr.md"),
    branch: BRANCH,
    baseRef: BASE_REF,
    baseSha: BASE_SHA,
    mergeBaseSha: MERGE_BASE_SHA,
    tipSha: PLAN_TIP,
    runtimeRoot: "/runtime",
    startedAt: DateTime.unsafeMake("2026-01-01T00:00:00.000Z"),
  });

  it("is what the agent wrote, plus the trailer that says what wrote it", () => {
    const body = prBodyFor(DESCRIPTION, plan);
    expect(body.startsWith(DESCRIPTION)).toBe(true);
    // The spec by name, not by path: the trailer is for a human reading the PR.
    expect(body).toContain("AI-authored via speepobox (spec: `T12-forge-pr.md`)");
    expect(body).toContain("Draft until the dispatching dev reviews it.");
  });

  // A pass that printed nothing is a pass that wrote no description, and it
  // reads the same as one that failed (`run.sh:1686`).
  it("falls back to the static body for a description that is empty", () => {
    expect(prBodyFor("   \n", plan)).toContain(DESCRIPTION_UNAVAILABLE);
  });

  // The arm with no file to name (T66): the trailer names the spec when there
  // is one and stops there when there is not, rather than naming the spec the
  // plan used to carry — which on that arm was a file the run never read.
  it("names no spec when the task was stated inline", () => {
    const body = prBodyFor(DESCRIPTION, {
      ...plan,
      task: { _tag: "Inline", text: "fix the release note", feedback: Option.none() },
    });
    expect(body).toContain(
      "AI-authored via speepobox. Draft until the dispatching dev reviews it.",
    );
    expect(body).not.toContain("spec:");
  });
});

describe("the PR after the push", () => {
  it.scoped("describes the work, opens a draft PR, and records its number and URL", () =>
    Effect.gen(function* () {
      const scratch = yield* world();
      yield* runLandingAndPr(scratch).pipe(Effect.provide(scratch.layer));

      // Bash's order: view the branch first, and create only because nothing
      // is open on it (`run.sh:1713-1722`).
      expect(yield* Ref.get(scratch.forgeCalls)).toEqual([
        { _tag: "View", branch: BRANCH },
        {
          _tag: "Create",
          branch: BRANCH,
          // The ref this run was dispatched against, untouched: turning it
          // into the branch `gh` wants is the forge's own job.
          base: BASE_REF,
          title: `[speepobox] ${BRANCH}`,
          body: prBodyFor(DESCRIPTION, scratch.plan),
        },
      ]);
      expect(yield* Ref.get(scratch.events)).toContainEqual({
        _tag: "PullRequestReady",
        pr: OPEN_PR,
        action: "created",
      });
      const rows = yield* Ref.get(scratch.appended);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.terminalReason).toEqual(Option.some({ _tag: "Completed" }));
      // Both, together, so no call site parses the number back out of the URL.
      expect(rows[0]?.pr).toEqual(Option.some({ number: Option.some(PR_NUMBER), url: PR_URL }));
      const fs = yield* FileSystem.FileSystem;
      expect(yield* fs.readFileString(Option.getOrThrow(scratch.plan.logPath))).toContain(
        `draft PR opened: ${PR_URL}`,
      );
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // A re-dispatch lands on the same branch, so the PR the first run opened is
  // updated rather than duplicated.
  it.scoped("edits the open PR instead of creating a second one", () =>
    Effect.gen(function* () {
      const scratch = yield* world({ forge: { existing: VIEWED_PR } });
      yield* runLandingAndPr(scratch).pipe(Effect.provide(scratch.layer));

      expect(yield* Ref.get(scratch.forgeCalls)).toEqual([
        { _tag: "View", branch: BRANCH },
        { _tag: "Edit", branch: BRANCH, body: prBodyFor(DESCRIPTION, scratch.plan) },
      ]);
      expect(yield* Ref.get(scratch.events)).toContainEqual({
        _tag: "PullRequestReady",
        pr: OPEN_PR,
        action: "updated",
      });
      expect((yield* Ref.get(scratch.appended))[0]?.pr).toEqual(Option.some(OPEN_PR));
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // The one degradation this step is allowed: the commits are already pushed,
  // so a description pass that died must not cost the run its PR
  // (`run.sh:1683-1687`). It is a warning and a static body, never a failure.
  it.scoped("opens the PR with a static body when the description pass fails", () =>
    Effect.gen(function* () {
      const scratch = yield* world({
        agent: {
          describePrFails: new AgentPassFailed({
            reason: "timed-out",
            detail: "the describe-pr pass timed out at 900s",
          }),
        },
      });
      const outcome = yield* Effect.either(
        runLandingAndPr(scratch).pipe(Effect.provide(scratch.layer)),
      );

      expect(Either.isRight(outcome)).toBe(true);
      const created = (yield* Ref.get(scratch.forgeCalls)).find((call) => call._tag === "Create");
      expect(created?._tag === "Create" && created.body).toContain(DESCRIPTION_UNAVAILABLE);
      const warnings = warningsIn(yield* Ref.get(scratch.events));
      expect(warnings[0]).toContain("the describe-pr pass timed out");
      expect(warnings[0]).toContain("static body");
      // A completed run with a PR: the row says so, and says nothing about the
      // pass that degraded.
      const rows = yield* Ref.get(scratch.appended);
      expect(rows[0]?.terminalReason).toEqual(Option.some({ _tag: "Completed" }));
      expect(rows[0]?.pr).toEqual(Option.some(OPEN_PR));
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // Matrix row 15: the forge refused, with the commits already home. All three
  // resources release, the row is `failed` at stage `pr`, and the error is a
  // typed `ForgeError` — the branch keeps its commits either way, which is
  // exactly why this step is the one that runs last.
  it.scoped("fails at stage pr when the forge refuses, releasing everything", () =>
    Effect.gen(function* () {
      const scratch = yield* world({
        forge: {
          createFails:
            "could not open a draft PR for 'speepobox-t12': GraphQL: was submitted too quickly",
        },
      });
      const outcome = yield* Effect.either(
        runLandingAndPr(scratch).pipe(Effect.provide(scratch.layer)),
      );

      expect(Either.isLeft(outcome)).toBe(true);
      if (Either.isLeft(outcome)) {
        expect(outcome.left).toBeInstanceOf(ForgeError);
        expect(outcome.left.detail).toContain("too quickly");
      }
      const rows = yield* Ref.get(scratch.appended);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.terminalReason).toEqual(
        Option.some({ _tag: "Failed", stage: "pr" as const }),
      );
      // Absent, never synthesized: no PR was opened, so the row claims none.
      expect(rows[0]?.pr).toEqual(Option.none());
      // The commits are still home — the push happened before this step. The
      // read that opens the land is in the list too (T27): the pre-run tip is
      // taken in the repo, before the fetch moves the ref.
      expect((yield* Ref.get(scratch.gitCalls)).map((call) => call._tag)).toEqual([
        "Clone",
        // The identity the clone carries, written before the container starts
        // (T35).
        "ReadConfig",
        "SetConfig",
        "ReadConfig",
        "SetConfig",
        "RevParse",
        "FetchBack",
        "CountCommits",
        "CountCommits",
        "Push",
        // The release's branch read before its fetch (T107).
        "RevParse",
        "FetchBack",
        // And the read the release's removal stands on (T38), which runs on
        // the failure path like any other: a run that failed at `pr` still
        // owes its copy the same question.
        "RevParse",
        "BranchContains",
      ]);
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

  // The same row, from the re-dispatch direction: the PR exists and the edit
  // was refused, so the run fails at `pr` — and the row still names the PR the
  // forge told us about, because it is open whether or not its body was
  // replaced.
  it.scoped("fails at stage pr when the edit is refused, still recording the open PR", () =>
    Effect.gen(function* () {
      const scratch = yield* world({
        forge: { existing: VIEWED_PR, editFails: "could not update the PR for 'speepobox-t12'" },
      });
      const outcome = yield* Effect.either(
        runLandingAndPr(scratch).pipe(Effect.provide(scratch.layer)),
      );

      expect(Either.isLeft(outcome)).toBe(true);
      const rows = yield* Ref.get(scratch.appended);
      expect(rows[0]?.terminalReason).toEqual(
        Option.some({ _tag: "Failed", stage: "pr" as const }),
      );
      expect(rows[0]?.pr).toEqual(Option.some(OPEN_PR));
      expect(yield* Ref.get(scratch.events)).not.toContainEqual(
        expect.objectContaining({ _tag: "PullRequestReady" }),
      );
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // Nothing past the boundary is not a PR's business: the agent's pass
  // produced no work, so there is nothing to open one about and the forge is
  // never asked anything (`run.sh:1673`).
  it.scoped("asks the forge nothing when there was nothing to land", () =>
    Effect.gen(function* () {
      const scratch = yield* world({ git: { counts: {} } });
      const outcome = yield* Effect.either(
        runLandingAndPr(scratch).pipe(Effect.provide(scratch.layer)),
      );

      expect(Either.isRight(outcome)).toBe(true);
      expect(yield* Ref.get(scratch.forgeCalls)).toEqual([]);
      const rows = yield* Ref.get(scratch.appended);
      expect(rows[0]?.terminalReason).toEqual(Option.some({ _tag: "Completed" }));
      expect(rows[0]?.pr).toEqual(Option.none());
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
});

// T79: a feature run's body ends with the checklist of its selection, rendered
// from what the loop recorded rather than asked of the agent — on create and on
// edit alike, so a resume's PR carries the newest run's lines.
describe("the checklist on a feature run's PR", () => {
  const selection = {
    request: { _tag: "All" as const },
    issues: [fakeIssue("T70"), fakeIssue("T71"), fakeIssue("T72")],
  };
  const plan = planFor({
    ...featureDispatch("docs/wayfinder/effect-agentbox", selection),
    branch: BRANCH,
    baseRef: BASE_REF,
    baseSha: BASE_SHA,
    mergeBaseSha: MERGE_BASE_SHA,
    tipSha: PLAN_TIP,
    runtimeRoot: "/runtime",
    startedAt: DateTime.unsafeMake("2026-01-01T00:00:00.000Z"),
  });

  // The step alone, over the four tags it asks: the subject is the body that
  // crossed the forge seam, which the scope around it does not change.
  const openWith = (
    recorded: ReadonlyArray<IssueOutcome>,
    forge: FakeForgeOptions = {},
    on: DispatchPlan = plan,
    agent: FakeAgentCliOptions = {},
  ) =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<ForgeCall>>([]);
      const pr = yield* Ref.make(Option.none<PullRequest>());
      const outcomes = yield* Ref.make(recorded);
      yield* openPullRequest(on, TEST_FORGE_REPO, { name: "c", id: "c" }, pr, outcomes).pipe(
        Effect.provide(
          Layer.mergeAll(
            fakeForge(calls, forge),
            fakeAgentCli({ description: DESCRIPTION, ...agent }),
            Layer.succeed(SpeepoboxConfig, {
              ...defaultConfig,
              runtimeRoot: "/runtime",
              maxReviewRounds: 3,
            }),
            Layer.succeed(Reporter, { emit: () => Effect.void }),
          ),
        ),
      );
      return yield* Ref.get(calls);
    });

  it.effect("ends the created body with the checklist, below the description", () =>
    Effect.gen(function* () {
      const recorded = [
        { issue: "T70", outcome: APPROVED_OUTCOME },
        { issue: "T71", outcome: "needs-work" },
      ];
      const body = bodyOf(yield* openWith(recorded));

      const checklist = issueChecklistFor(selection.issues, recorded, 3);
      expect(body.startsWith(DESCRIPTION)).toBe(true);
      expect(body.endsWith(`\n\n${checklist}`)).toBe(true);
      expect(body).toContain("- [ ] T72 — a thing to do: not attempted (sequence stopped)");
    }),
  );

  // A description pass that produced no block: the static body stands in for
  // it, and the checklist still follows, so a degraded description still says
  // which issues landed.
  it.effect("ends the static body with the checklist when the pass produced no block", () =>
    Effect.gen(function* () {
      const recorded = [{ issue: "T70", outcome: IMPLEMENT_FAILED }];
      const body = bodyOf(yield* openWith(recorded, {}, plan, { description: "" }));

      expect(body.startsWith(DESCRIPTION_UNAVAILABLE)).toBe(true);
      expect(body.endsWith(`\n\n${issueChecklistFor(selection.issues, recorded, 3)}`)).toBe(true);
    }),
  );

  // The resume: the open PR still says what the first run's checklist said,
  // and the edit replaces the body wholesale with this run's.
  it.effect("edits a resumed run's PR with the newest run's checklist", () =>
    Effect.gen(function* () {
      const first = issueChecklistFor(
        selection.issues,
        [{ issue: "T70", outcome: IMPLEMENT_FAILED }],
        3,
      );
      const calls = yield* openWith(
        selection.issues.map((issue) => ({ issue: issue.id, outcome: APPROVED_OUTCOME })),
        { existing: { ...VIEWED_PR, body: `${DESCRIPTION}\n\n${first}` } },
      );

      expect(calls.map((call) => call._tag)).toEqual(["View", "Edit"]);
      const body = bodyOf(calls);
      expect(body.endsWith("**All selected issues completed.**")).toBe(true);
      expect(body).not.toContain("implement pass failed");
      expect(body.match(/### Issues/g)).toHaveLength(1);
    }),
  );

  // A spec run's body is byte-identical to the one it had before the checklist
  // existed, even with something in the outcomes slot: the arm decides, not
  // whether the slot is empty.
  it.effect("leaves a spec run's body exactly as it was", () =>
    Effect.gen(function* () {
      const spec = planFor({
        ...specDispatch("/repo/tasks/T12-forge-pr.md"),
        branch: BRANCH,
        baseRef: BASE_REF,
        baseSha: BASE_SHA,
        mergeBaseSha: MERGE_BASE_SHA,
        tipSha: PLAN_TIP,
        runtimeRoot: "/runtime",
        startedAt: DateTime.unsafeMake("2026-01-01T00:00:00.000Z"),
      });
      const calls = yield* openWith([{ issue: "T70", outcome: APPROVED_OUTCOME }], {}, spec);

      expect(bodyOf(calls)).toBe(
        [
          DESCRIPTION,
          "",
          "---",
          "AI-authored via speepobox (spec: `T12-forge-pr.md`). Draft until the dispatching dev reviews it.",
        ].join("\n"),
      );
    }),
  );
});
