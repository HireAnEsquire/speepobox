// The land (T11): the fetch-back with real commits behind it, the two counts,
// and the push — asserted against a fake `Git` for the same reason the
// checkout's release is, since what crosses the seam is domain values and a
// rendered command line would only spell them out again. `test/git.test.ts` is
// where the argv those values become is the assertion, and
// `test/dispatch.test.ts` is where a real `Git` runs the whole sequence.
//
// Matrix rows covered: 13 (the fetch-back fails at land — sandbox and lock
// release, the checkout is **kept**, loudly, and the row is `failed` at stage
// `land`) and 14 (the push fails — all three release, the checkout by its
// ordinary derived path, because the fast-forward already succeeded).
//
// Row 13 is where the release's rescue shows up from the land's side (T29):
// the commits that could not go home end up on a branch of the release's own
// and the directory goes, **and the row is unchanged by that** — where the
// commits were parked is not an outcome.
import { describe, expect, it } from "@effect/vitest";
import { FileSystem } from "@effect/platform";
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { DateTime, Effect, Either, Layer, Option, Ref, Schema } from "effect";
import { BessemerConfig, defaultConfig } from "../src/config/config.ts";
import { land } from "../src/dispatch/land.ts";
import { APPROVED_OUTCOME } from "../src/dispatch/feature.ts";
import {
  featureDispatch,
  type HardReset,
  inlineDispatch,
  planFor,
  slugFor,
  specDispatch,
  statusIndexPathFor,
} from "../src/dispatch/plan.ts";
import { atStage, runInScope } from "../src/dispatch/run.ts";
import { IssueStore } from "../src/issues/issue-store.ts";
import { RepoUrl } from "../src/git/repo-url.ts";
import { Ledger } from "../src/ledger/ledger.ts";
import type { IssueOutcome, RunRecord } from "../src/ledger/record.ts";
import { RunLockLive } from "../src/lock/run-lock.ts";
import { Reporter, type ReporterEvent } from "../src/reporter.ts";
import { renderLogLine } from "../src/run-log.ts";
import type { SandboxSpec } from "../src/sandbox/spec.ts";
import { fakeAgentCli } from "./support/agent-cli-fake.ts";
import { TEST_CREDENTIAL } from "./support/credential.ts";
import { TEST_FORGE_REPO } from "./support/repo-slug.ts";
import {
  CLONE_MARKER,
  CLONE_TIP,
  type FakeGitOptions,
  fakeGit,
  type GitCall,
  PRE_TIP,
} from "./support/git-fake.ts";
import { fakeForge } from "./support/forge-fake.ts";
import {
  type FakeIssueStoreOptions,
  fakeIssue,
  fakeIssueStore,
  type IssueStoreCall,
} from "./support/issue-store-fake.ts";
import { fakeNotifier } from "./support/notifier-fake.ts";
import { fakeSandbox } from "./support/sandbox-fake.ts";
import { PLAN_TIP } from "./support/plan.ts";

const BRANCH = "bessemer-t11";
const BASE_REF = "origin/master";
const BASE_SHA = "1111111111111111111111111111111111111111";
const MERGE_BASE_SHA = "2222222222222222222222222222222222222222";
// A run that committed: five past the diff boundary, two of them this run's.
const WORKED = { [MERGE_BASE_SHA]: 5, [PRE_TIP]: 2 };

const repoUrl = Schema.decodeSync(RepoUrl);

const AT = DateTime.unsafeMake("2026-01-01T00:00:00.000Z");

// The dispatching dev, as this repo's config answers for them, and the two
// writes that puts in the clone before the container starts (T35). The land
// runs a whole dispatch, so every sequence below carries them.
const DISPATCHER = { "user.name": "Ada Lovelace", "user.email": "ada@example.com" };

const identityCalls = (repoRoot: string, checkout: string): ReadonlyArray<GitCall> => [
  { _tag: "ReadConfig", repo: repoRoot, key: "user.name" },
  { _tag: "SetConfig", repo: checkout, key: "user.name", value: DISPATCHER["user.name"] },
  { _tag: "ReadConfig", repo: repoRoot, key: "user.email" },
  { _tag: "SetConfig", repo: checkout, key: "user.email", value: DISPATCHER["user.email"] },
];

const IDENTITY_TAGS = identityCalls("", "").map((call) => call._tag);

// `reset` is a `--hard-reset` dispatch's plan (T101), whose tip and boundary
// are both the base.
const world = (
  options: FakeGitOptions = {},
  issues: FakeIssueStoreOptions = {},
  reset?: HardReset,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    // The two roots stay deliberately different, as they are in
    // checkout.test.ts: the clone is written under the runtime root and both
    // the fetch-back and the push name the repo root, so a land that confused
    // them shows up here rather than passing by coincidence.
    const runtimeRoot = yield* fs.makeTempDirectoryScoped();
    const repoRoot = yield* fs.makeTempDirectoryScoped();
    const events = yield* Ref.make<ReadonlyArray<ReporterEvent>>([]);
    const appended = yield* Ref.make<ReadonlyArray<RunRecord>>([]);
    const gitCalls = yield* Ref.make<ReadonlyArray<GitCall>>([]);
    const sandboxes = yield* Ref.make<ReadonlyArray<SandboxSpec>>([]);
    const issueCalls = yield* Ref.make<ReadonlyArray<IssueStoreCall>>([]);

    const plan = planFor({
      ...specDispatch(`${repoRoot}/tasks/T11.md`),
      branch: BRANCH,
      baseRef: BASE_REF,
      baseSha: BASE_SHA,
      mergeBaseSha: reset === undefined ? MERGE_BASE_SHA : BASE_SHA,
      tipSha: reset === undefined ? PLAN_TIP : BASE_SHA,
      reset: Option.fromNullable(reset),
      runtimeRoot,
      startedAt: DateTime.unsafeMake("2026-01-01T00:00:00.000Z"),
    });

    const layer = Layer.provideMerge(
      Layer.mergeAll(
        RunLockLive,
        fakeGit(gitCalls, { config: DISPATCHER, ...options }),
        fakeIssueStore(issueCalls, issues),
        fakeSandbox(sandboxes),
        fakeNotifier(),
        fakeForge(),
        fakeAgentCli(),
      ),
      Layer.mergeAll(
        NodeFileSystem.layer,
        NodePath.layer,
        Layer.succeed(BessemerConfig, { ...defaultConfig, runtimeRoot }),
        Layer.succeed(Reporter, {
          emit: (event) => Ref.update(events, (current) => [...current, event]),
        }),
        Layer.succeed(Ledger, {
          append: (record) => Ref.update(appended, (current) => [...current, record]),
          recent: () => Effect.succeed([]),
          lastBaseForBranch: () => Effect.succeed(Option.none()),
          resolveResume: () => Effect.die("the land never resumes"),
          newestBranchForIssue: () => Effect.die("the land dispatches no feature"),
        }),
      ),
    );

    return {
      runtimeRoot,
      repoRoot,
      plan,
      events,
      appended,
      gitCalls,
      sandboxes,
      issueCalls,
      layer,
    };
  });

// The run as `dispatch.ts` composes it, up to the land: the land is the first
// half of the scope's `work`, staged where it is wired because the stage a
// `failed` row names is a fact about where the run was and only the work knows
// that. The PR that follows it there is `test/pr.test.ts`'s subject, so
// nothing here provides a `Forge` — which is also what keeps these cases about
// the land alone.
const runLanding = (scratch: {
  readonly plan: ReturnType<typeof planFor>;
  readonly repoRoot: string;
}) =>
  runInScope(scratch.plan, scratch.repoRoot, TEST_CREDENTIAL, TEST_FORGE_REPO, ({ outcomes }) =>
    land(scratch.plan, scratch.repoRoot, outcomes).pipe(Effect.mapError(atStage("land"))),
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

describe("the land", () => {
  it.scoped("fetches the commits back, counts them from both ends, and pushes them out", () =>
    Effect.gen(function* () {
      const scratch = yield* world({ counts: WORKED });
      yield* runLanding(scratch).pipe(Effect.provide(scratch.layer));

      // The whole sequence, in order, and both fetch-backs in it: the land's
      // own — the one whose failure is an outcome — and the release's, which
      // is the salvage every exit path takes and here fast-forwards over
      // nothing. The pre-run tip is read before either of them moves the ref.
      //
      // Every call names `repoRoot`, the two **reads** included (T27): the
      // clone is written under the runtime root and the repo root is a
      // different temp directory, so a read that answered from anywhere else —
      // the working directory, the checkout — shows up here as a value rather
      // than as a silently different diff boundary.
      expect(yield* Ref.get(scratch.gitCalls)).toEqual([
        {
          _tag: "Clone",
          source: repoUrl(scratch.repoRoot),
          branch: BRANCH,
          into: scratch.plan.checkoutPath,
        },
        ...identityCalls(scratch.repoRoot, scratch.plan.checkoutPath),
        { _tag: "RevParse", repo: scratch.repoRoot, rev: `refs/heads/${BRANCH}` },
        {
          _tag: "FetchBack",
          from: repoUrl(scratch.plan.checkoutPath),
          into: scratch.repoRoot,
          branch: BRANCH,
          onto: BRANCH,
        },
        {
          _tag: "CountCommits",
          repo: scratch.repoRoot,
          from: MERGE_BASE_SHA,
          to: `refs/heads/${BRANCH}`,
        },
        { _tag: "CountCommits", repo: scratch.repoRoot, from: PRE_TIP, to: `refs/heads/${BRANCH}` },
        // From the repo the commits were just fetched into, never from the
        // clone the agent owned.
        { _tag: "Push", from: scratch.repoRoot, branch: BRANCH },
        // The release's salvage asks whether the branch is there before it
        // fetches onto it (T107).
        { _tag: "RevParse", repo: scratch.repoRoot, rev: `refs/heads/${BRANCH}` },
        {
          _tag: "FetchBack",
          from: repoUrl(scratch.plan.checkoutPath),
          into: scratch.repoRoot,
          branch: BRANCH,
          onto: BRANCH,
        },
        // And the read that authorizes the removal after it (T38): the copy's
        // tip, then the repo's answer about whether the branch holds it. The
        // fetch above returning success is not what the `rm -rf` stands on.
        { _tag: "RevParse", repo: scratch.plan.checkoutPath, rev: `refs/heads/${BRANCH}` },
        {
          _tag: "BranchContains",
          repo: scratch.repoRoot,
          branch: BRANCH,
          commit: CLONE_TIP,
        },
      ]);
      expect(yield* Ref.get(scratch.events)).toContainEqual({
        _tag: "CommitsPushed",
        thisRun: 2,
        sinceBoundary: 5,
        statusCommit: false,
      });
      // The commits made it home, so the checkout goes by the same derived
      // release it has always gone by — no flag, no branch on the counts.
      const fs = yield* FileSystem.FileSystem;
      expect(yield* fs.exists(scratch.plan.checkoutPath)).toBe(false);
      expect(warningsIn(yield* Ref.get(scratch.events))).toEqual([]);
      // A spec run approves no issue, so the status commit is never asked for
      // (T77): there is nothing for it to mark.
      expect(yield* Ref.get(scratch.issueCalls)).toEqual([]);
      expect(yield* fs.readFileString(Option.getOrThrow(scratch.plan.logPath))).toContain(
        "pushed: 2 new commit(s) this run, 5 total since the boundary",
      );
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // A hard reset's push is a rewrite, leased and pinned to where origin stood
  // after the guard phase's fetch (T101, D7) — or expecting the branch absent
  // when origin had none. The boundary the counts start from is the base.
  it.scoped("pushes a hard reset under a lease pinned to origin's tip, or to its absence", () =>
    Effect.gen(function* () {
      const ORIGIN_TIP = "9999999999999999999999999999999999999999";
      for (const originTip of [Option.some(ORIGIN_TIP), Option.none<string>()]) {
        const scratch = yield* world(
          { counts: { [BASE_SHA]: 2, [PRE_TIP]: 2 } },
          {},
          {
            discardedTip: PLAN_TIP,
            discarding: 4,
            originTip,
          },
        );
        yield* runLanding(scratch).pipe(Effect.provide(scratch.layer));
        const calls = yield* Ref.get(scratch.gitCalls);
        expect(calls.filter((call) => call._tag === "Push")).toEqual([
          { _tag: "Push", from: scratch.repoRoot, branch: BRANCH, lease: { expect: originTip } },
        ]);
        expect(calls).toContainEqual({
          _tag: "CountCommits",
          repo: scratch.repoRoot,
          from: BASE_SHA,
          to: `refs/heads/${BRANCH}`,
        });
      }
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // A reset is a reset on both ends (T105): an agent that added nothing still
  // leaves origin holding what the plan counted as discarded, so the empty
  // arm pushes the reset under the same pinned lease — only when origin had
  // the branch somewhere other than the base — and still lands nothing.
  const emptyReset = (originTip: Option.Option<string>) =>
    world({}, {}, { discardedTip: PLAN_TIP, discarding: 4, originTip });
  const ORIGIN_TIP = "9999999999999999999999999999999999999999";

  it.scoped("pushes an empty hard reset under the pinned lease, and lands nothing", () =>
    Effect.gen(function* () {
      const scratch = yield* emptyReset(Option.some(ORIGIN_TIP));
      const outcome = yield* runInScope(
        scratch.plan,
        scratch.repoRoot,
        TEST_CREDENTIAL,
        TEST_FORGE_REPO,
        ({ outcomes }) => land(scratch.plan, scratch.repoRoot, outcomes),
      ).pipe(Effect.provide(scratch.layer));

      expect(outcome).toBe("nothing-to-land");
      expect((yield* Ref.get(scratch.gitCalls)).filter((call) => call._tag === "Push")).toEqual([
        {
          _tag: "Push",
          from: scratch.repoRoot,
          branch: BRANCH,
          lease: { expect: Option.some(ORIGIN_TIP) },
        },
      ]);
      const events = yield* Ref.get(scratch.events);
      expect(
        events.filter((event) => event._tag === "NothingToLand" || event._tag === "ResetPushed"),
      ).toEqual([
        { _tag: "NothingToLand" },
        { _tag: "ResetPushed", branch: BRANCH, originTip: ORIGIN_TIP },
      ]);
      expect(events.some((event) => event._tag === "CommitsPushed")).toBe(false);
      const fs = yield* FileSystem.FileSystem;
      expect(yield* fs.readFileString(Option.getOrThrow(scratch.plan.logPath))).toContain(
        `reset pushed: origin/${BRANCH} moved from`,
      );
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // Nothing to overwrite: an absent origin branch would be *created* at the
  // base, and one already there would be a push that moved nothing.
  it.scoped("pushes no empty hard reset when origin is absent or already at the base", () =>
    Effect.gen(function* () {
      for (const originTip of [Option.none<string>(), Option.some(BASE_SHA)]) {
        const scratch = yield* emptyReset(originTip);
        yield* runLanding(scratch).pipe(Effect.provide(scratch.layer));
        expect((yield* Ref.get(scratch.gitCalls)).some((call) => call._tag === "Push")).toBe(false);
        const events = yield* Ref.get(scratch.events);
        expect(events).toContainEqual({ _tag: "NothingToLand" });
        expect(events.some((event) => event._tag === "ResetPushed")).toBe(false);
      }
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // The empty reset's push is the pushed path's push, failure included: a
  // lease that no longer matches fails the run at stage land, and nothing
  // claims the reset went out.
  it.scoped("fails at stage land when the empty hard reset's lease no longer matches", () =>
    Effect.gen(function* () {
      const scratch = yield* world(
        { pushFails: "! [rejected] (stale info)" },
        {},
        { discardedTip: PLAN_TIP, discarding: 4, originTip: Option.some(ORIGIN_TIP) },
      );
      const outcome = yield* Effect.either(runLanding(scratch).pipe(Effect.provide(scratch.layer)));

      expect(Either.isLeft(outcome)).toBe(true);
      if (Either.isLeft(outcome)) {
        expect(outcome.left._tag).toBe("GitError");
        expect(outcome.left.detail).toContain("stale info");
      }
      expect((yield* Ref.get(scratch.appended))[0]?.terminalReason).toEqual(
        Option.some({ _tag: "Failed", stage: "land" as const }),
      );
      expect((yield* Ref.get(scratch.events)).some((event) => event._tag === "ResetPushed")).toBe(
        false,
      );
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // What the terminal row carries once there is a land to record: the review's
  // verdict, the base as given and as resolved, the diff boundary, and
  // `Completed` because the commits made it home. The PR fields stay absent —
  // absent, never synthesized (T12 fills them).
  it.scoped("records the review outcome, the base, the boundary, and no PR", () =>
    Effect.gen(function* () {
      const scratch = yield* world({ counts: WORKED });
      yield* runLanding(scratch).pipe(Effect.provide(scratch.layer));

      const rows = yield* Ref.get(scratch.appended);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.terminalReason).toEqual(Option.some({ _tag: "Completed" }));
      // The fake reviewer never approves, so the run spent its rounds and
      // landed anyway (matrix row 12) — and the row says which it was.
      expect(rows[0]?.outcome).toEqual(Option.some("needs-work"));
      expect(rows[0]?.base).toEqual({ ref: BASE_REF, sha: Option.some(BASE_SHA) });
      expect(rows[0]?.mergeBaseSha).toEqual(Option.some(MERGE_BASE_SHA));
      expect(rows[0]?.pr).toEqual(Option.none());
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // Neither a failure nor a push: the agent's pass produced no work, and the
  // run says exactly that.
  it.scoped("says nothing to land, and pushes nothing, when no commits are past the boundary", () =>
    Effect.gen(function* () {
      const scratch = yield* world();
      const outcome = yield* Effect.either(runLanding(scratch).pipe(Effect.provide(scratch.layer)));

      expect(Either.isRight(outcome)).toBe(true);
      expect(yield* Ref.get(scratch.events)).toContainEqual({ _tag: "NothingToLand" });
      expect((yield* Ref.get(scratch.gitCalls)).map((call) => call._tag)).toEqual([
        "Clone",
        ...IDENTITY_TAGS,
        "RevParse",
        "FetchBack",
        "CountCommits",
        "CountCommits",
        "RevParse",
        "FetchBack",
        // The release's own two reads, which run whether or not there was
        // anything to land: the removal is authorized by them and not by what
        // the fetch above returned (T38).
        "RevParse",
        "BranchContains",
      ]);
      // A row that records the run honestly: it completed, the review reached
      // a verdict, and nothing was invented about a PR that does not exist.
      const rows = yield* Ref.get(scratch.appended);
      expect(rows[0]?.terminalReason).toEqual(Option.some({ _tag: "Completed" }));
      expect(rows[0]?.outcome).toEqual(Option.some("needs-work"));
      expect(rows[0]?.pr).toEqual(Option.none());
      const fs = yield* FileSystem.FileSystem;
      expect(yield* fs.readFileString(Option.getOrThrow(scratch.plan.logPath))).toContain(
        "nothing to land",
      );
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // Matrix row 13: the agent rewrote history inside the clone, so the commits
  // cannot come home — the run ends at `land`, and the directory holding them
  // stays.
  it.scoped(
    "fails at stage land when the fetch-back is not a fast-forward, keeping the checkout",
    () =>
      Effect.gen(function* () {
        const scratch = yield* world({
          counts: WORKED,
          fetchBackFails: "! [rejected] (non-fast-forward)",
        });
        const outcome = yield* Effect.either(
          runLanding(scratch).pipe(Effect.provide(scratch.layer)),
        );

        expect(Either.isLeft(outcome)).toBe(true);
        if (Either.isLeft(outcome)) {
          expect(outcome.left._tag).toBe("GitError");
          expect(outcome.left.detail).toContain("non-fast-forward");
        }
        const rows = yield* Ref.get(scratch.appended);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.terminalReason).toEqual(
          Option.some({ _tag: "Failed", stage: "land" as const }),
        );
        // Nothing was counted and nothing was pushed: the commits are not on the
        // branch, so there is nothing to count and nothing to send. The release
        // then takes its own two shots at salvage on the way out (T29) — both
        // refused here, which is what leaves the directory behind — with the
        // repo asked in between whether the branch already holds them (T32),
        // because a refused fast-forward alone does not say.
        expect((yield* Ref.get(scratch.gitCalls)).map((call) => call._tag)).toEqual([
          "Clone",
          ...IDENTITY_TAGS,
          "RevParse",
          "FetchBack",
          "RevParse",
          "FetchBack",
          "RevParse",
          "BranchContains",
          "FetchBack",
        ]);
        // Kept, loudly, by the release's own derivation — sandbox and lock let
        // go around it.
        const fs = yield* FileSystem.FileSystem;
        expect(yield* fs.readFileString(`${scratch.plan.checkoutPath}/${CLONE_MARKER}`)).toBe(
          `${BRANCH}\n`,
        );
        expect(warningsIn(yield* Ref.get(scratch.events))[0]).toContain(
          "still in its own copy of the repository",
        );
        expect(resourceEventsIn(yield* Ref.get(scratch.events))).toEqual([
          ["ResourceAcquired", "lock"],
          ["ResourceAcquired", "checkout"],
          ["ResourceAcquired", "sandbox"],
          ["ResourceReleased", "sandbox"],
          ["ResourceReleased", "lock"],
        ]);
      }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // The whole path a run walks when its commits cannot go home (T29), end to
  // end: the land refuses, the release's rescue takes the same commits onto a
  // branch of its own, and the directory goes. **The run's outcome is
  // untouched by that** — a run whose work did not reach the branch it was
  // given has not done what it was asked, so the row still says `failed` at
  // stage `land` and the typed error still reaches the caller. Saying
  // otherwise because the commits were parked somewhere is the one way this
  // rule could make things worse.
  it.scoped("still fails at stage land when the release rescues the commits it left", () =>
    Effect.gen(function* () {
      const scratch = yield* world({
        counts: WORKED,
        homeFetchBackFails: "! [rejected] (non-fast-forward)",
      });
      const outcome = yield* Effect.either(runLanding(scratch).pipe(Effect.provide(scratch.layer)));

      expect(Either.isLeft(outcome)).toBe(true);
      if (Either.isLeft(outcome)) {
        expect(outcome.left._tag).toBe("GitError");
        expect(outcome.left.detail).toContain("non-fast-forward");
      }
      const rows = yield* Ref.get(scratch.appended);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.terminalReason).toEqual(
        Option.some({ _tag: "Failed", stage: "land" as const }),
      );

      // Nothing is left on the host to clean up by hand, and the next dispatch
      // of this branch finds no directory in its way — the whole cost the
      // rescue exists to stop paying.
      const fs = yield* FileSystem.FileSystem;
      expect(yield* fs.exists(scratch.plan.checkoutPath)).toBe(false);
      expect(resourceEventsIn(yield* Ref.get(scratch.events))).toEqual([
        ["ResourceAcquired", "lock"],
        ["ResourceAcquired", "checkout"],
        ["ResourceAcquired", "sandbox"],
        ["ResourceReleased", "sandbox"],
        ["ResourceReleased", "checkout"],
        ["ResourceReleased", "lock"],
      ]);

      // And the human is told where the work is, by name, in one line.
      const rescue = `${BRANCH}-from-run-${CLONE_TIP.slice(0, 7)}`;
      expect(yield* Ref.get(scratch.gitCalls)).toContainEqual({
        _tag: "FetchBack",
        from: repoUrl(scratch.plan.checkoutPath),
        into: scratch.repoRoot,
        branch: BRANCH,
        onto: rescue,
      });
      const warnings = warningsIn(yield* Ref.get(scratch.events));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(`they are on '${rescue}'`);
      expect(yield* fs.readFileString(Option.getOrThrow(scratch.plan.logPath))).toContain(rescue);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // Matrix row 14: the commits are home and the remote refused them. All three
  // release — the checkout by its ordinary derived path, because its
  // fast-forward already succeeded — and the row still names `land`.
  it.scoped("fails at stage land when the push is rejected, releasing all three", () =>
    Effect.gen(function* () {
      const scratch = yield* world({ counts: WORKED, pushFails: "! [rejected] (fetch first)" });
      const outcome = yield* Effect.either(runLanding(scratch).pipe(Effect.provide(scratch.layer)));

      expect(Either.isLeft(outcome)).toBe(true);
      if (Either.isLeft(outcome)) {
        expect(outcome.left._tag).toBe("GitError");
        expect(outcome.left.detail).toContain("fetch first");
      }
      expect((yield* Ref.get(scratch.appended))[0]?.terminalReason).toEqual(
        Option.some({ _tag: "Failed", stage: "land" as const }),
      );
      const fs = yield* FileSystem.FileSystem;
      expect(yield* fs.exists(scratch.plan.checkoutPath)).toBe(false);
      expect(warningsIn(yield* Ref.get(scratch.events))).toEqual([]);
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
});

// The status commit (T77): every issue this run approved, marked `Done` in one
// commit between the fetch-back and the push. The land is called directly
// here, with the outcomes slot already holding what the loop would have left
// on it — the loop itself is `test/feature-loop.test.ts`'s subject, and what
// these cases assert is what the land does with its answer.
const FOLDER = "docs/wayfinder/effect-agentbox";
const T70 = fakeIssue("T70");
const T71 = fakeIssue("T71");
const T72 = fakeIssue("T72");

// The world above over a feature plan, and the `IssueStore` wrapped so the
// write snapshots the git calls made before it: the placement is an order
// across two seams, and this is where the two meet.
const featureWorld = (
  options: FakeGitOptions,
  issues: FakeIssueStoreOptions = {},
  reset?: HardReset,
) =>
  Effect.gen(function* () {
    const scratch = yield* world(options, issues, reset);
    const plan = planFor({
      ...featureDispatch(FOLDER, { request: { _tag: "All" }, issues: [T70, T71, T72] }),
      branch: BRANCH,
      baseRef: BASE_REF,
      baseSha: BASE_SHA,
      mergeBaseSha: reset === undefined ? MERGE_BASE_SHA : BASE_SHA,
      tipSha: reset === undefined ? PLAN_TIP : BASE_SHA,
      reset: Option.fromNullable(reset),
      runtimeRoot: scratch.runtimeRoot,
      startedAt: DateTime.unsafeMake("2026-01-01T00:00:00.000Z"),
    });
    const beforeMark = yield* Ref.make<ReadonlyArray<GitCall>>([]);
    const layer = Layer.effect(
      IssueStore,
      Effect.map(IssueStore, (store) => ({
        ...store,
        markLanded: (request: Parameters<typeof store.markLanded>[0]) =>
          Ref.get(scratch.gitCalls).pipe(
            Effect.flatMap((calls) => Ref.set(beforeMark, calls)),
            Effect.zipRight(store.markLanded(request)),
          ),
      })),
    ).pipe(Layer.provideMerge(scratch.layer));
    return { ...scratch, plan, layer, beforeMark };
  });

const landWith = (
  scratch: Effect.Effect.Success<ReturnType<typeof featureWorld>>,
  outcomes: ReadonlyArray<IssueOutcome>,
) =>
  Ref.make(outcomes).pipe(
    Effect.flatMap((slot) => land(scratch.plan, scratch.repoRoot, slot)),
    Effect.provide(scratch.layer),
  );

const approved = (issue: string): IssueOutcome => ({ issue, outcome: APPROVED_OUTCOME });

describe("the land's status commit", () => {
  it.scoped("marks what this run approved, once, after the fetch-back and before the push", () =>
    Effect.gen(function* () {
      const scratch = yield* featureWorld({ counts: WORKED });
      const landed = yield* landWith(scratch, [
        approved("T70"),
        approved("T71"),
        { issue: "T72", outcome: "needs-work" },
      ]);

      expect(landed).toBe("pushed");
      // Once, for the two that approved, by stem and in the order the loop
      // decided them — against the served repo and never the clone, with the
      // scratch index under the runtime root's `locks/`, where the lock scans
      // skip it and the served repo's own tree never sees it.
      expect(yield* Ref.get(scratch.issueCalls)).toEqual([
        {
          _tag: "MarkLanded",
          repo: scratch.repoRoot,
          branch: BRANCH,
          folder: FOLDER,
          stems: [T70.stem, T71.stem],
          index: statusIndexPathFor(scratch.runtimeRoot, slugFor(BRANCH)),
        },
      ]);
      // After the fetch-back and the counts, before the push.
      expect((yield* Ref.get(scratch.beforeMark)).map((call) => call._tag)).toEqual([
        "RevParse",
        "FetchBack",
        "CountCommits",
        "CountCommits",
      ]);
      expect((yield* Ref.get(scratch.gitCalls)).map((call) => call._tag)).toContain("Push");
      expect(warningsIn(yield* Ref.get(scratch.events))).toEqual([]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // The commit the dispatcher's identity authored is named in the stream
  // (T90), and the pushed line counts it: two agent commits and the status
  // commit went out, so the push carried three, and six past the boundary.
  it.scoped("says what it marked, and counts the status commit in what was pushed", () =>
    Effect.gen(function* () {
      const scratch = yield* featureWorld({ counts: WORKED });
      yield* landWith(scratch, [approved("T70"), approved("T71")]);

      const events = yield* Ref.get(scratch.events);
      const committed = events.findIndex((event) => event._tag === "StatusCommitted");
      const pushed = events.findIndex((event) => event._tag === "CommitsPushed");
      expect(events[committed]).toEqual({
        _tag: "StatusCommitted",
        stems: [T70.stem, T71.stem],
        branch: BRANCH,
      });
      expect(events[pushed]).toEqual({
        _tag: "CommitsPushed",
        thisRun: 3,
        sinceBoundary: 6,
        statusCommit: true,
      });
      expect(committed).toBeLessThan(pushed);
      expect(renderLogLine(AT, events[committed] as ReporterEvent)).toContain(
        `status commit: marked ${T70.stem} ${T71.stem} Done on '${BRANCH}'`,
      );
      expect(renderLogLine(AT, events[pushed] as ReporterEvent)).toContain(
        "pushed: 3 new commit(s) this run (one of them the status commit), 6 total since the boundary",
      );
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // A store that found none of the stems' files built no commit, so there is
  // nothing to name and nothing extra to count.
  it.scoped("says nothing and counts nothing extra when no commit was made", () =>
    Effect.gen(function* () {
      const scratch = yield* featureWorld({ counts: WORKED }, { marksNothing: true });
      yield* landWith(scratch, [approved("T70")]);

      const events = yield* Ref.get(scratch.events);
      expect(events.some((event) => event._tag === "StatusCommitted")).toBe(false);
      expect(events).toContainEqual({
        _tag: "CommitsPushed",
        thisRun: 2,
        sinceBoundary: 5,
        statusCommit: false,
      });
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // Counted against *this run's* tip (14, lesson 5): the branch has five
  // commits past the boundary from an earlier run, and this one added none, so
  // nothing is marked and — the boundary count being what gates the push —
  // those five are all that could go out.
  it.scoped("marks nothing when this run made no commits of its own", () =>
    Effect.gen(function* () {
      const scratch = yield* featureWorld({ counts: { [MERGE_BASE_SHA]: 5, [PRE_TIP]: 0 } });
      yield* landWith(scratch, [approved("T70")]);

      expect(yield* Ref.get(scratch.issueCalls)).toEqual([]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // T103: a `--hard-reset` feature run is no different here. The commit is
  // built on the reset branch — the one the run's commits were fetched onto —
  // and gated on what *this* run added, with the boundary the base.
  it.scoped("marks what a reset run approved on the reset branch, gated on this run", () =>
    Effect.gen(function* () {
      const reset: HardReset = {
        discardedTip: PLAN_TIP,
        discarding: 4,
        originTip: Option.none(),
      };
      const worked = yield* featureWorld({ counts: { [BASE_SHA]: 2, [PRE_TIP]: 2 } }, {}, reset);
      expect(worked.plan.tipSha).toBe(BASE_SHA);
      yield* landWith(worked, [approved("T70")]);
      expect(yield* Ref.get(worked.issueCalls)).toEqual([
        {
          _tag: "MarkLanded",
          repo: worked.repoRoot,
          branch: BRANCH,
          folder: FOLDER,
          stems: [T70.stem],
          index: statusIndexPathFor(worked.runtimeRoot, slugFor(BRANCH)),
        },
      ]);

      const idle = yield* featureWorld({ counts: { [BASE_SHA]: 2, [PRE_TIP]: 0 } }, {}, reset);
      yield* landWith(idle, [approved("T70")]);
      expect(yield* Ref.get(idle.issueCalls)).toEqual([]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped("marks nothing and pushes nothing when there is nothing to land", () =>
    Effect.gen(function* () {
      const scratch = yield* featureWorld({});
      const landed = yield* landWith(scratch, [approved("T70")]);

      expect(landed).toBe("nothing-to-land");
      expect(yield* Ref.get(scratch.issueCalls)).toEqual([]);
      expect((yield* Ref.get(scratch.gitCalls)).map((call) => call._tag)).not.toContain("Push");
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // Only a feature run has issues to approve, so a spec run and an inline run
  // never ask — not even with commits of their own and an approval on the
  // slot, which neither arm's passes could have put there.
  it.scoped("marks nothing on a spec run or an inline run", () =>
    Effect.gen(function* () {
      const scratch = yield* world({ counts: WORKED });
      const inline = planFor({
        ...inlineDispatch("make the thing do the other thing"),
        branch: BRANCH,
        baseRef: BASE_REF,
        baseSha: BASE_SHA,
        mergeBaseSha: MERGE_BASE_SHA,
        tipSha: PLAN_TIP,
        runtimeRoot: scratch.runtimeRoot,
        startedAt: DateTime.unsafeMake("2026-01-01T00:00:00.000Z"),
      });
      expect([scratch.plan.task._tag, inline.task._tag]).toEqual(["Spec", "Inline"]);

      for (const plan of [scratch.plan, inline]) {
        const landed = yield* Ref.make<ReadonlyArray<IssueOutcome>>([approved("T70")]).pipe(
          Effect.flatMap((slot) => land(plan, scratch.repoRoot, slot)),
          Effect.provide(scratch.layer),
        );
        expect(landed).toBe("pushed");
      }

      expect(yield* Ref.get(scratch.issueCalls)).toEqual([]);
      expect(
        (yield* Ref.get(scratch.gitCalls)).filter((call) => call._tag === "Push"),
      ).toHaveLength(2);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped("marks nothing when no issue approved", () =>
    Effect.gen(function* () {
      const scratch = yield* featureWorld({ counts: WORKED });
      yield* landWith(scratch, [{ issue: "T70", outcome: "needs-work" }]);

      expect(yield* Ref.get(scratch.issueCalls)).toEqual([]);
      expect((yield* Ref.get(scratch.gitCalls)).map((call) => call._tag)).toContain("Push");
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // Advisory, never fatal (14, lesson 4): the commits are home and unpushed,
  // so the failure is a warning naming the stems and git's words, and the
  // push still happens.
  it.scoped("warns, naming the stems and git's words, and pushes anyway when it fails", () =>
    Effect.gen(function* () {
      const scratch = yield* featureWorld(
        { counts: WORKED },
        { markLandedFails: "fatal: unable to write new index file" },
      );
      const landed = yield* landWith(scratch, [approved("T70"), approved("T71")]);

      expect(landed).toBe("pushed");
      expect(warningsIn(yield* Ref.get(scratch.events))).toEqual([
        `could not mark ${T70.stem} ${T71.stem} Done on '${BRANCH}': fatal: unable to write new index file`,
      ]);
      expect(yield* Ref.get(scratch.gitCalls)).toContainEqual({
        _tag: "Push",
        from: scratch.repoRoot,
        branch: BRANCH,
      });
      // And the pushed line counts only what went out (T90): no status commit
      // was made, so none is counted and none is named.
      const events = yield* Ref.get(scratch.events);
      expect(events.some((event) => event._tag === "StatusCommitted")).toBe(false);
      expect(events).toContainEqual({
        _tag: "CommitsPushed",
        thisRun: 2,
        sinceBoundary: 5,
        statusCommit: false,
      });
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
});
