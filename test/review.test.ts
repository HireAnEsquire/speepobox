// The review loop (T10): the policy over T9's seam, asserted against a fake
// `AgentCli` whose rounds answer differently — which is the only way "stopped
// on the approval" and "stopped at the cap" are distinguishable at all. What a
// round *is* — the argv, the prompt on stdin, the verdict read back out of the
// output — is `test/agent-cli.test.ts`, against a scripted docker.
//
// Two matrix rows live here:
//   - **row 12**, the cap: not a failure. The run proceeds and the unapproved
//     verdict is the row's `outcome`.
//   - **row 11**, the canonical Claim-1 exhibit: a review pass dying with a
//     defect releases sandbox, checkout, and lock in reverse, records
//     `crashed`, and rethrows.
import { describe, expect, it } from "@effect/vitest";
import { FileSystem } from "@effect/platform";
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { Cause, DateTime, Effect, Either, Exit, Layer, Option, Ref } from "effect";
import { AgentPassFailed } from "../src/agent/agent-cli.ts";
import {
  CAPPED_UNREVIEWED_FIX,
  type ReviewRound,
  type ReviewVerdict,
} from "../src/agent/verdict.ts";
import { BessemerConfig, defaultConfig } from "../src/config/config.ts";
import { planFor, specDispatch } from "../src/dispatch/plan.ts";
import { runInScope } from "../src/dispatch/run.ts";
import { Ledger } from "../src/ledger/ledger.ts";
import type { RunRecord } from "../src/ledger/record.ts";
import { RunLockLive } from "../src/lock/run-lock.ts";
import { Reporter, type ReporterEvent } from "../src/reporter.ts";
import type { SandboxSpec } from "../src/sandbox/spec.ts";
import { fakeAgentCli } from "./support/agent-cli-fake.ts";
import { TEST_CREDENTIAL } from "./support/credential.ts";
import { TEST_FORGE_REPO } from "./support/repo-slug.ts";
import { fakeGit, type GitCall } from "./support/git-fake.ts";
import { fakeForge } from "./support/forge-fake.ts";
import { fakeNotifier } from "./support/notifier-fake.ts";
import { fakeSandbox } from "./support/sandbox-fake.ts";
import { PLAN_TIP } from "./support/plan.ts";

const BRANCH = "bessemer-t10";
const MERGE_BASE_SHA = "2222222222222222222222222222222222222222";

interface ReviewWorld {
  readonly verdicts?: ReadonlyArray<ReviewVerdict>;
  readonly maxReviewRounds?: number;
  readonly diesOnRound?: number;
  readonly fails?: AgentPassFailed;
}

// All three resources really held, so the release order the two rows assert is
// the run's own and not a story about it. The agent is the fake here — the
// subject is the loop, and a scripted docker would only let each round say the
// same thing as the last.
const world = (options: ReviewWorld = {}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const runtimeRoot = yield* fs.makeTempDirectoryScoped();
    const repoRoot = yield* fs.makeTempDirectoryScoped();
    const events = yield* Ref.make<ReadonlyArray<ReporterEvent>>([]);
    const appended = yield* Ref.make<ReadonlyArray<RunRecord>>([]);
    const gitCalls = yield* Ref.make<ReadonlyArray<GitCall>>([]);
    const sandboxes = yield* Ref.make<ReadonlyArray<SandboxSpec>>([]);
    const rounds = yield* Ref.make<ReadonlyArray<ReviewRound>>([]);

    const plan = planFor({
      ...specDispatch(`${repoRoot}/tasks/T10.md`),
      branch: BRANCH,
      baseRef: "origin/master",
      baseSha: "1111111111111111111111111111111111111111",
      mergeBaseSha: MERGE_BASE_SHA,
      tipSha: PLAN_TIP,
      runtimeRoot,
      startedAt: DateTime.unsafeMake("2026-01-01T00:00:00.000Z"),
    });

    const agent = fakeAgentCli({
      rounds,
      ...(options.verdicts === undefined ? {} : { verdicts: options.verdicts }),
      ...(options.fails === undefined ? {} : { reviewFails: options.fails }),
      ...(options.diesOnRound === undefined
        ? {}
        : {
            reviewDiesOnRound: {
              index: options.diesOnRound,
              message: "the reviewer's own invariant broke",
            },
          }),
    });

    const layer = Layer.provideMerge(
      Layer.mergeAll(
        RunLockLive,
        fakeGit(gitCalls),
        fakeSandbox(sandboxes),
        fakeNotifier(),
        fakeForge(),
        agent,
      ),
      Layer.mergeAll(
        NodeFileSystem.layer,
        NodePath.layer,
        Layer.succeed(BessemerConfig, {
          ...defaultConfig,
          runtimeRoot,
          ...(options.maxReviewRounds === undefined
            ? {}
            : { maxReviewRounds: options.maxReviewRounds }),
        }),
        Layer.succeed(Reporter, {
          emit: (event) => Ref.update(events, (current) => [...current, event]),
        }),
        Layer.succeed(Ledger, {
          append: (record) => Ref.update(appended, (current) => [...current, record]),
          recent: () => Effect.succeed([]),
          lastBaseForBranch: () => Effect.succeed(Option.none()),
          resolveResume: () => Effect.die("a review round never resumes"),
          newestBranchForIssue: () => Effect.die("a review round dispatches no feature"),
        }),
      ),
    );

    return { runtimeRoot, repoRoot, plan, events, appended, rounds, layer };
  });

const resourceEventsIn = (
  events: ReadonlyArray<ReporterEvent>,
): ReadonlyArray<readonly [string, string]> =>
  events.flatMap((event) =>
    event._tag === "ResourceAcquired" || event._tag === "ResourceReleased"
      ? [[event._tag, event.resource] as const]
      : [],
  );

const REVERSE_RELEASE = [
  ["ResourceAcquired", "lock"],
  ["ResourceAcquired", "checkout"],
  ["ResourceAcquired", "sandbox"],
  ["ResourceReleased", "sandbox"],
  ["ResourceReleased", "checkout"],
  ["ResourceReleased", "lock"],
];

describe("the review loop", () => {
  it.scoped("stops on the round that approves, and records that as the outcome", () =>
    Effect.gen(function* () {
      const scratch = yield* world({
        verdicts: ["needs-work", "approved", "needs-work"],
        maxReviewRounds: 3,
      });
      yield* runInScope(
        scratch.plan,
        scratch.repoRoot,
        TEST_CREDENTIAL,
        TEST_FORGE_REPO,
        () => Effect.void,
      ).pipe(Effect.provide(scratch.layer));

      // Two rounds, each told the budget it is spending.
      expect(yield* Ref.get(scratch.rounds)).toEqual([
        { index: 1, of: 3 },
        { index: 2, of: 3 },
      ]);
      const rows = yield* Ref.get(scratch.appended);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.outcome).toEqual(Option.some("approved"));
      expect(rows[0]?.terminalReason).toEqual(Option.some({ _tag: "Completed" }));
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // Matrix row 12. The whole point: a capped run is a *completed* run whose
  // review did not approve, and the exit code that follows from that row is a
  // success (`exit-code.ts`), not a failure.
  it.scoped("proceeds past the cap, recording the unapproved verdict as the outcome", () =>
    Effect.gen(function* () {
      const scratch = yield* world({ verdicts: ["needs-work"], maxReviewRounds: 2 });
      const landed = yield* Ref.make(false);
      yield* runInScope(scratch.plan, scratch.repoRoot, TEST_CREDENTIAL, TEST_FORGE_REPO, () =>
        Ref.set(landed, true),
      ).pipe(Effect.provide(scratch.layer));

      // The run reached the work the land will be, rather than stopping at the
      // cap.
      expect(yield* Ref.get(landed)).toBe(true);
      expect(yield* Ref.get(scratch.rounds)).toEqual([
        { index: 1, of: 2 },
        { index: 2, of: 2 },
      ]);
      const rows = yield* Ref.get(scratch.appended);
      expect(rows[0]?.outcome).toEqual(Option.some("needs-work"));
      expect(rows[0]?.terminalReason).toEqual(Option.some({ _tag: "Completed" }));
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // A `fixed` round loops like `needs-work` and differs only here, at the cap:
  // the last round's commits went unreviewed, which is a different thing to
  // tell a human than "problems remain" (`run.sh:1358-1362`).
  it.scoped("records a capped fixing round as its own outcome token", () =>
    Effect.gen(function* () {
      const scratch = yield* world({ verdicts: ["fixed"], maxReviewRounds: 1 });
      yield* runInScope(
        scratch.plan,
        scratch.repoRoot,
        TEST_CREDENTIAL,
        TEST_FORGE_REPO,
        () => Effect.void,
      ).pipe(Effect.provide(scratch.layer));

      expect(yield* Ref.get(scratch.rounds)).toEqual([{ index: 1, of: 1 }]);
      const rows = yield* Ref.get(scratch.appended);
      expect(rows[0]?.outcome).toEqual(Option.some(CAPPED_UNREVIEWED_FIX));
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // A round that fixed something is re-reviewed rather than trusted: the next
  // round judges those commits fresh, and its answer is the one recorded.
  it.scoped("re-reviews a fixing round rather than ending on it", () =>
    Effect.gen(function* () {
      const scratch = yield* world({ verdicts: ["fixed", "approved"], maxReviewRounds: 3 });
      yield* runInScope(
        scratch.plan,
        scratch.repoRoot,
        TEST_CREDENTIAL,
        TEST_FORGE_REPO,
        () => Effect.void,
      ).pipe(Effect.provide(scratch.layer));

      expect(yield* Ref.get(scratch.rounds)).toHaveLength(2);
      const rows = yield* Ref.get(scratch.appended);
      expect(rows[0]?.outcome).toEqual(Option.some("approved"));
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // Progress is the event stream (05), and the row's `outcome` stays derivable
  // from it: every round says what it decided, in order.
  it.scoped("reports each round's verdict as an event", () =>
    Effect.gen(function* () {
      const scratch = yield* world({ verdicts: ["needs-work", "approved"], maxReviewRounds: 3 });
      yield* runInScope(
        scratch.plan,
        scratch.repoRoot,
        TEST_CREDENTIAL,
        TEST_FORGE_REPO,
        () => Effect.void,
      ).pipe(Effect.provide(scratch.layer));

      expect(
        (yield* Ref.get(scratch.events)).filter((event) => event._tag === "ReviewVerdictReached"),
      ).toEqual([
        {
          _tag: "ReviewVerdictReached",
          issue: Option.none(),
          round: { index: 1, of: 3 },
          verdict: "needs-work",
        },
        {
          _tag: "ReviewVerdictReached",
          issue: Option.none(),
          round: { index: 2, of: 3 },
          verdict: "approved",
        },
      ]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // Matrix row 11, **the canonical Claim-1 case** (SPEC §11): our own
  // invariant broke inside a review round, so it is a defect and not a typed
  // error — and the choice decides reporting shape, not resource safety. The
  // three resources release in reverse either way (SPEC §3).
  it.scoped("releases all three in reverse and records crashed when a round dies", () =>
    Effect.gen(function* () {
      const scratch = yield* world({ maxReviewRounds: 3, diesOnRound: 2 });
      const fs = yield* FileSystem.FileSystem;
      const exit = yield* Effect.exit(
        runInScope(
          scratch.plan,
          scratch.repoRoot,
          TEST_CREDENTIAL,
          TEST_FORGE_REPO,
          () => Effect.void,
        ).pipe(Effect.provide(scratch.layer)),
      );

      // Rethrown after release, as a defect: not caught, not turned into an
      // outcome, and still carrying what broke.
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.isDie(exit.cause)).toBe(true);
        expect(Cause.pretty(exit.cause)).toContain("the reviewer's own invariant broke");
      }
      expect(resourceEventsIn(yield* Ref.get(scratch.events))).toEqual(REVERSE_RELEASE);

      // The row a crashed run owes: `terminalReason` and no `outcome` — the
      // second question was never answered, and a run that crashed mid-review
      // must not read as one the reviewer decided something about.
      const rows = yield* Ref.get(scratch.appended);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.terminalReason).toEqual(Option.some({ _tag: "Crashed" }));
      expect(rows[0]?.outcome).toEqual(Option.none());

      // And the host afterwards agrees with the events.
      expect(yield* fs.readDirectory(`${scratch.runtimeRoot}/locks`)).toEqual([]);
      expect(yield* fs.exists(scratch.plan.checkoutPath)).toBe(false);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // A defect on the first round proves the same thing one step earlier: the
  // loop adds no catch of its own, so nothing here converts a defect into a
  // verdict on the way past.
  it.scoped("does not turn a dying first round into a verdict", () =>
    Effect.gen(function* () {
      const scratch = yield* world({ maxReviewRounds: 3, diesOnRound: 1 });
      const exit = yield* Effect.exit(
        runInScope(
          scratch.plan,
          scratch.repoRoot,
          TEST_CREDENTIAL,
          TEST_FORGE_REPO,
          () => Effect.void,
        ).pipe(Effect.provide(scratch.layer)),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      expect(yield* Ref.get(scratch.rounds)).toEqual([{ index: 1, of: 3 }]);
      const rows = yield* Ref.get(scratch.appended);
      expect(rows[0]?.outcome).toEqual(Option.none());
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // A round that *fails* is not a verdict: it is a typed `AgentPassFailed`
  // like any other pass, and the stage it rides beside is this one's. Nothing
  // retries it — the loop repeats verdicts, never failures (05 Q16R).
  it.scoped("ends the run at stage review when a round fails, claiming no outcome", () =>
    Effect.gen(function* () {
      const scratch = yield* world({
        maxReviewRounds: 3,
        fails: new AgentPassFailed({ reason: "exited", detail: "the review pass failed: rc=2" }),
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
      if (Either.isLeft(outcome)) {
        expect(outcome.left).toBeInstanceOf(AgentPassFailed);
      }
      expect(yield* Ref.get(scratch.rounds)).toEqual([{ index: 1, of: 3 }]);
      expect(resourceEventsIn(yield* Ref.get(scratch.events))).toEqual(REVERSE_RELEASE);
      const rows = yield* Ref.get(scratch.appended);
      expect(rows[0]?.terminalReason).toEqual(Option.some({ _tag: "Failed", stage: "review" }));
      expect(rows[0]?.outcome).toEqual(Option.none());
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // A budget of zero is a review that never ran: bash's `for` loop does not
  // execute either, and the run still lands with the token that says nothing
  // looked at the diff.
  it.scoped("runs no round at all on a budget of zero, and still records an outcome", () =>
    Effect.gen(function* () {
      const scratch = yield* world({ maxReviewRounds: 0 });
      yield* runInScope(
        scratch.plan,
        scratch.repoRoot,
        TEST_CREDENTIAL,
        TEST_FORGE_REPO,
        () => Effect.void,
      ).pipe(Effect.provide(scratch.layer));

      expect(yield* Ref.get(scratch.rounds)).toEqual([]);
      const rows = yield* Ref.get(scratch.appended);
      expect(rows[0]?.outcome).toEqual(Option.some("needs-work"));
      expect(rows[0]?.terminalReason).toEqual(Option.some({ _tag: "Completed" }));
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
});
