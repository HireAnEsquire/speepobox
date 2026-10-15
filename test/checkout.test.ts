// The checkout resource and its **derived** release (SPEC §4, 05 Q10). The
// runtime root and the repo root are real scratch directories and the clone
// really lands in one of them: "our fake released" is not "the directory is
// gone", and keep-vs-delete is the whole behaviour under test.
//
// Matrix rows covered: 5 (clone fails → typed `GitError`, lock released,
// `failed` row at stage `checkout`), 13 and 18 (fetch-back fails → the
// checkout is kept, loudly, the scope does not fail, and the run's own error
// is unmasked).
import { userInfo } from "node:os";
import { describe, expect, it } from "@effect/vitest";
import { FileSystem } from "@effect/platform";
import { SystemError } from "@effect/platform/Error";
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { DateTime, Effect, Either, Exit, Layer, Option, Ref, Schema } from "effect";
import { SpeepoboxConfig, defaultConfig } from "../src/config/config.ts";
import { type HardReset, planFor, specDispatch } from "../src/dispatch/plan.ts";
import { atStage, runInScope } from "../src/dispatch/run.ts";
import { checkout, salvage } from "../src/dispatch/checkout.ts";
import { Git, GitError, GitLive } from "../src/git/git.ts";
import { RepoUrl } from "../src/git/repo-url.ts";
import { Ledger } from "../src/ledger/ledger.ts";
import type { RunRecord } from "../src/ledger/record.ts";
import { RunLockLive } from "../src/lock/run-lock.ts";
import { reconcile } from "../src/reconcile/reconcile.ts";
import { Reporter, type ReporterEvent } from "../src/reporter.ts";
import type { SandboxSpec } from "../src/sandbox/spec.ts";
import {
  CLONE_MARKER,
  CLONE_TIP,
  type FakeGitOptions,
  fakeGit,
  type GitCall,
  PRE_TIP,
} from "./support/git-fake.ts";
import { fakeAgentCli } from "./support/agent-cli-fake.ts";
import { TEST_CREDENTIAL } from "./support/credential.ts";
import { TEST_FORGE_REPO } from "./support/repo-slug.ts";
import { scriptedExecutor } from "./support/exec-fake.ts";
import { fakeForge } from "./support/forge-fake.ts";
import { fakeNotifier } from "./support/notifier-fake.ts";
import { fakeSandbox } from "./support/sandbox-fake.ts";
import { PLAN_TIP } from "./support/plan.ts";

const BRANCH = "speepobox-t18";
const BASE_SHA = "1111111111111111111111111111111111111111";
const MERGE_BASE_SHA = "2222222222222222222222222222222222222222";

// Where a refused release sends the commits instead: the branch it was given,
// plus the short SHA the *clone* is at (T29). Spelled out here rather than
// built by the module's own helper, so the naming rule is asserted and not
// restated.
const RESCUE = `${BRANCH}-from-run-a1b2c3d`;

// The same name for a directory this suite wrote itself rather than cloned:
// the fake answers a branch tip of `PRE_TIP` for any repo it did not make, so
// a hand-staged kept copy rescues onto that instead of the clone's tip — which
// is the naming rule working, not a coincidence to paper over.
const STALE_RESCUE = `${BRANCH}-from-run-${PRE_TIP.slice(0, 7)}`;

const repoUrl = Schema.decodeSync(RepoUrl);

// How every command `Git` spawns opens: the directory it runs in, and the
// repository it runs against (T27, T32). One case below reads argv rather than
// domain values, and this is the half of each line it shares with every other.
const inRepo = (repo: string): string => `git -C ${repo} --git-dir=${repo}/.git`;

// The dispatching dev, as the repo this dispatch is for answers for them
// (T35). Every run below carries these two values into its clone, so they are
// scripted for the whole file rather than per case — a case about the fallback
// unsets them itself.
const DISPATCHER = { "user.name": "Ada Lovelace", "user.email": "ada@example.com" };

// What the acquire does between the clone and the resource being reported
// acquired: read the identity where the dispatch is for, write it where the
// agent works. Spelled once, because it is one rule and it shows up in every
// sequence of git calls a run makes.
const identityCalls = (repoRoot: string, copy: string): ReadonlyArray<GitCall> => [
  { _tag: "ReadConfig", repo: repoRoot, key: "user.name" },
  { _tag: "SetConfig", repo: copy, key: "user.name", value: DISPATCHER["user.name"] },
  { _tag: "ReadConfig", repo: repoRoot, key: "user.email" },
  { _tag: "SetConfig", repo: copy, key: "user.email", value: DISPATCHER["user.email"] },
];

const IDENTITY_TAGS = identityCalls("", "").map((call) => call._tag);

// What the salvage asks after every fetch-back, and the whole of what
// authorizes the `rm -rf` that follows it (T38): the copy's tip, then the
// repo's answer about whether the branch holds it. The fetch's return value
// authorizes nothing, so these run on the path where it succeeded exactly as
// on the path where it refused.
const CONTAINMENT_TAGS = ["RevParse", "BranchContains"];

// And what it asks before any of that (T107): whether the branch it is about
// to fetch onto is there to be read, in the repo that fetch would write to. A
// fetch onto a ref that is not there creates it, so this read is what keeps
// the salvage from recreating a branch a human deleted.
const branchRead = (repoRoot: string): GitCall => ({
  _tag: "RevParse",
  repo: repoRoot,
  rev: `refs/heads/${BRANCH}`,
});

// A filesystem that will not delete one directory. It is the only way to reach
// the state T28 mostly exists for — the commits went home, or onto a rescue,
// and `fs.remove` then could not delete the tree, which is exactly what T29's
// `releaseClone` warns about. Scoped to one path and switched by a `Ref`, so
// the *next* dispatch runs against a working disk with nobody having gone near
// the directory in between.
const refusingToRemove = (
  path: string,
  refusing: Ref.Ref<boolean>,
): Layer.Layer<FileSystem.FileSystem> =>
  Layer.effect(
    FileSystem.FileSystem,
    Effect.map(FileSystem.FileSystem, (fs) => ({
      ...fs,
      remove: (target: string, options?: FileSystem.RemoveOptions) =>
        target === path
          ? Effect.flatMap(Ref.get(refusing), (yes) =>
              yes
                ? Effect.fail(
                    new SystemError({
                      reason: "PermissionDenied",
                      module: "FileSystem",
                      method: "remove",
                      pathOrDescriptor: target,
                    }),
                  )
                : fs.remove(target, options),
            )
          : fs.remove(target, options),
    })),
  ).pipe(Layer.provide(NodeFileSystem.layer));

// `reset` is a `--hard-reset` dispatch's plan (T101): the base is then the
// tip and the boundary, and the tip the guards read is what the reset expects.
const world = (
  options: FakeGitOptions & {
    // The served repo refusing to read the run's branch (T107) — deleted by a
    // human since the copy was made, as git's `--verify` answers it. Only the
    // repo root's read fails: the copy still has the branch its commits are on.
    readonly branchUnread?: string;
  } = {},
  removalRefused?: Ref.Ref<boolean>,
  reset?: HardReset,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    // Two roots, deliberately different: the clone is written under the
    // runtime root and fetched back into the repo root, so a release that
    // confused the two would show up here rather than pass by coincidence.
    const runtimeRoot = yield* fs.makeTempDirectoryScoped();
    const repoRoot = yield* fs.makeTempDirectoryScoped();
    const events = yield* Ref.make<ReadonlyArray<ReporterEvent>>([]);
    const appended = yield* Ref.make<ReadonlyArray<RunRecord>>([]);
    // The stream as it stood at the moment the row was written, which is how
    // "the row is written after the checkout released and before the lock
    // does" is asserted as a value rather than inspected in the code (T31).
    const eventsAtRow = yield* Ref.make<ReadonlyArray<ReporterEvent>>([]);
    const gitCalls = yield* Ref.make<ReadonlyArray<GitCall>>([]);
    const sandboxes = yield* Ref.make<ReadonlyArray<SandboxSpec>>([]);

    const plan = planFor({
      ...specDispatch(`${repoRoot}/tasks/T18.md`),
      branch: BRANCH,
      baseRef: "origin/master",
      baseSha: BASE_SHA,
      mergeBaseSha: reset === undefined ? MERGE_BASE_SHA : BASE_SHA,
      tipSha: reset === undefined ? PLAN_TIP : BASE_SHA,
      reset: Option.fromNullable(reset),
      runtimeRoot,
      startedAt: DateTime.unsafeMake("2026-01-01T00:00:00.000Z"),
    });

    // The real filesystem, unless a case is staging the one state that needs a
    // refused removal to reach it (T28) — and then only for the checkout's own
    // path, so the lock beside it goes on releasing normally.
    const files =
      removalRefused === undefined
        ? NodeFileSystem.layer
        : refusingToRemove(plan.checkoutPath, removalRefused);

    // The real `RunLock` over the scratch runtime root, wired as appLiveFor wires
    // it: the ordering this file asserts is between two resources, so faking
    // one of them would assert half of it.
    const { branchUnread, ...gitOptions } = options;
    const git = Layer.effect(
      Git,
      Effect.map(Git, (inner) => ({
        ...inner,
        revParse: (read: Parameters<typeof inner.revParse>[0]) =>
          branchUnread !== undefined &&
          read.repo === repoRoot &&
          read.rev === `refs/heads/${BRANCH}`
            ? Ref.update(gitCalls, (current): ReadonlyArray<GitCall> => [
                ...current,
                { _tag: "RevParse", ...read },
              ]).pipe(Effect.zipRight(new GitError({ detail: branchUnread })))
            : inner.revParse(read),
      })),
    ).pipe(Layer.provide(fakeGit(gitCalls, { config: DISPATCHER, ...gitOptions })));

    const layer = Layer.provideMerge(
      Layer.mergeAll(
        RunLockLive,
        git,
        fakeSandbox(sandboxes),
        fakeNotifier(),
        fakeForge(),
        fakeAgentCli(),
      ),
      Layer.mergeAll(
        files,
        NodePath.layer,
        Layer.succeed(SpeepoboxConfig, { ...defaultConfig, runtimeRoot }),
        Layer.succeed(Reporter, {
          emit: (event) => Ref.update(events, (current) => [...current, event]),
        }),
        Layer.succeed(Ledger, {
          append: (record) =>
            Ref.get(events).pipe(
              Effect.flatMap((seen) => Ref.set(eventsAtRow, seen)),
              Effect.zipRight(Ref.update(appended, (current) => [...current, record])),
            ),
          recent: () => Effect.succeed([]),
          lastBaseForBranch: () => Effect.succeed(Option.none()),
          resolveResume: () => Effect.die("the checkout never resumes"),
          newestBranchForIssue: () => Effect.die("the checkout dispatches no feature"),
        }),
      ),
    );

    return {
      runtimeRoot,
      repoRoot,
      plan,
      events,
      appended,
      eventsAtRow,
      gitCalls,
      sandboxes,
      layer,
    };
  });

const warningsIn = (events: ReadonlyArray<ReporterEvent>): ReadonlyArray<string> =>
  events.flatMap((event) => (event._tag === "Warned" ? [event.detail] : []));

// The resource half of the event stream, which is what the ordering invariant
// is read off (SPEC §11) — a plain value assertion, not a mock's call log.
const resourceEventsIn = (
  events: ReadonlyArray<ReporterEvent>,
): ReadonlyArray<readonly [string, string]> =>
  events.flatMap((event) =>
    event._tag === "ResourceAcquired" || event._tag === "ResourceReleased"
      ? [[event._tag, event.resource] as const]
      : [],
  );

describe("the checkout resource", () => {
  it.scoped("clones the branch from the repo root into the runtime root, through a RepoUrl", () =>
    Effect.gen(function* () {
      const scratch = yield* world();
      const fs = yield* FileSystem.FileSystem;

      // Asserted from inside the run: the release deletes the directory on the
      // way out, so "it existed" is only visible while the scope is open.
      yield* runInScope(scratch.plan, scratch.repoRoot, TEST_CREDENTIAL, TEST_FORGE_REPO, () =>
        Effect.gen(function* () {
          expect(yield* fs.exists(scratch.plan.checkoutPath)).toBe(true);
          expect(yield* fs.readFileString(`${scratch.plan.checkoutPath}/${CLONE_MARKER}`)).toBe(
            `${BRANCH}\n`,
          );
        }),
      ).pipe(Effect.provide(scratch.layer));

      expect(yield* Ref.get(scratch.gitCalls)).toEqual([
        {
          _tag: "Clone",
          source: repoUrl(scratch.repoRoot),
          branch: BRANCH,
          into: scratch.plan.checkoutPath,
        },
        // The identity the clone carries, written before anything starts in it
        // (T35).
        ...identityCalls(scratch.repoRoot, scratch.plan.checkoutPath),
        branchRead(scratch.repoRoot),
        {
          _tag: "FetchBack",
          from: repoUrl(scratch.plan.checkoutPath),
          into: scratch.repoRoot,
          branch: BRANCH,
          onto: BRANCH,
        },
        // And the read the removal stands on, in the two repos each half of it
        // belongs to (T38): the tip in the copy, the containment question in
        // the repo the fetch just went into.
        { _tag: "RevParse", repo: scratch.plan.checkoutPath, rev: `refs/heads/${BRANCH}` },
        { _tag: "BranchContains", repo: scratch.repoRoot, branch: BRANCH, commit: CLONE_TIP },
      ]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped("is acquired after the lock, before the sandbox, and released between them", () =>
    Effect.gen(function* () {
      const scratch = yield* world();
      yield* runInScope(
        scratch.plan,
        scratch.repoRoot,
        TEST_CREDENTIAL,
        TEST_FORGE_REPO,
        () => Effect.void,
      ).pipe(Effect.provide(scratch.layer));

      expect(resourceEventsIn(yield* Ref.get(scratch.events))).toEqual([
        ["ResourceAcquired", "lock"],
        ["ResourceAcquired", "checkout"],
        ["ResourceAcquired", "sandbox"],
        ["ResourceReleased", "sandbox"],
        ["ResourceReleased", "checkout"],
        ["ResourceReleased", "lock"],
      ]);
      // The sandbox mounts this checkout, so it is started from the path the
      // clone landed at and torn down before the fetch-back reads it.
      expect((yield* Ref.get(scratch.sandboxes)).map((sandbox) => sandbox.workspace)).toEqual([
        scratch.plan.checkoutPath,
      ]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // Where the row sits among the three releases (T31), which is what lets it
  // carry an answer only the checkout's release has: the row is a finalizer of
  // the run's scope registered after the lock's and before the checkout's, so
  // it is written once the checkout has let go and while the lock is still
  // held. Read off the event stream as it stood when the append ran — an
  // `onExit` on the work would show none of the three releases here, and a row
  // written after the lock would show all of them.
  it.scoped("writes the row after the checkout released and before the lock does", () =>
    Effect.gen(function* () {
      const scratch = yield* world();
      yield* runInScope(
        scratch.plan,
        scratch.repoRoot,
        TEST_CREDENTIAL,
        TEST_FORGE_REPO,
        () => Effect.void,
      ).pipe(Effect.provide(scratch.layer));

      expect(resourceEventsIn(yield* Ref.get(scratch.eventsAtRow))).toEqual([
        ["ResourceAcquired", "lock"],
        ["ResourceAcquired", "checkout"],
        ["ResourceAcquired", "sandbox"],
        ["ResourceReleased", "sandbox"],
        ["ResourceReleased", "checkout"],
      ]);
      // And the lock's release really did come after it, so SPEC §11's "a row
      // exists iff the lock was acquired" is still written from inside the
      // bracket that owes it.
      expect(resourceEventsIn(yield* Ref.get(scratch.events)).at(-1)).toEqual([
        "ResourceReleased",
        "lock",
      ]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // The derivation, in the direction that deletes: no commits exist yet, so
  // the fast-forward is a real one over zero commits and the checkout goes.
  it.scoped("fetches back and deletes the checkout when the fast-forward succeeds", () =>
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

      expect(yield* fs.exists(scratch.plan.checkoutPath)).toBe(false);
      expect(warningsIn(yield* Ref.get(scratch.events))).toEqual([]);
      expect((yield* Ref.get(scratch.appended))[0]?.terminalReason).toEqual(
        Option.some({ _tag: "Completed" }),
      );
      // A run that went home carries no rescue at all (T31) — absent, rather
      // than the branch it was given or an empty string, because "the commits
      // are where you were told to look" is what an absence says.
      expect((yield* Ref.get(scratch.appended))[0]?.rescuedOnto).toEqual(Option.none());
      // One fetch and no more (T29): the rescue is what happens when the
      // commits cannot go home, never instead of it — so no second destination
      // needed naming. The two reads after it are the containment question
      // (T38), which is what says the fetch really moved them and so what the
      // removal above is authorized by.
      expect((yield* Ref.get(scratch.gitCalls)).map((call) => call._tag)).toEqual([
        "Clone",
        ...IDENTITY_TAGS,
        "RevParse",
        "FetchBack",
        ...CONTAINMENT_TAGS,
      ]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // The middle row of the release's table (T29), and the whole point of it:
  // `git fetch` refuses to move a ref backward but does not refuse to create
  // one, so the commits that could not go home land on a name no ref holds
  // yet — and the clone turns out to be disposable after all.
  it.scoped("sends the commits onto a branch of its own when the home fetch is refused", () =>
    Effect.gen(function* () {
      const scratch = yield* world({ homeFetchBackFails: "! [rejected] (non-fast-forward)" });
      const fs = yield* FileSystem.FileSystem;
      yield* runInScope(
        scratch.plan,
        scratch.repoRoot,
        TEST_CREDENTIAL,
        TEST_FORGE_REPO,
        () => Effect.void,
      ).pipe(Effect.provide(scratch.layer));

      expect(yield* Ref.get(scratch.gitCalls)).toEqual([
        {
          _tag: "Clone",
          source: repoUrl(scratch.repoRoot),
          branch: BRANCH,
          into: scratch.plan.checkoutPath,
        },
        ...identityCalls(scratch.repoRoot, scratch.plan.checkoutPath),
        // The branch it was given first, always.
        branchRead(scratch.repoRoot),
        {
          _tag: "FetchBack",
          from: repoUrl(scratch.plan.checkoutPath),
          into: scratch.repoRoot,
          branch: BRANCH,
          onto: BRANCH,
        },
        // Then the name, read off the branch ref the fetch below sends and
        // *in the clone* (T27) — the repo's copy of this branch is a different
        // commit, and asking `HEAD` instead would name a third one whenever
        // the agent left the copy detached.
        {
          _tag: "RevParse",
          repo: scratch.plan.checkoutPath,
          rev: `refs/heads/${BRANCH}`,
        },
        // Then the question the rescue is only allowed to happen after (T32),
        // asked of the **repo** about the tip read in the copy: a branch that
        // already holds these commits wants no rescue at all, and only the
        // repo can say whether it does.
        {
          _tag: "BranchContains",
          repo: scratch.repoRoot,
          branch: BRANCH,
          commit: CLONE_TIP,
        },
        // The same commits, off the same branch, onto a destination of the
        // release's own.
        {
          _tag: "FetchBack",
          from: repoUrl(scratch.plan.checkoutPath),
          into: scratch.repoRoot,
          branch: BRANCH,
          onto: RESCUE,
        },
        // And the rescue's own containment read, which is what authorizes the
        // removal below — the same question as the one above it, about the
        // branch this fetch just minted rather than the one that refused.
        {
          _tag: "BranchContains",
          repo: scratch.repoRoot,
          branch: RESCUE,
          commit: CLONE_TIP,
        },
      ]);

      // The commits are in the repository, so the directory goes by the
      // ordinary path and the checkout really released.
      expect(yield* fs.exists(scratch.plan.checkoutPath)).toBe(false);
      expect(resourceEventsIn(yield* Ref.get(scratch.events))).toEqual([
        ["ResourceAcquired", "lock"],
        ["ResourceAcquired", "checkout"],
        ["ResourceAcquired", "sandbox"],
        ["ResourceReleased", "sandbox"],
        ["ResourceReleased", "checkout"],
        ["ResourceReleased", "lock"],
      ]);

      // One line, naming the branch: no diagnostic procedure, because there is
      // nothing left on disk for the reader to decide about.
      const warnings = warningsIn(yield* Ref.get(scratch.events));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(`its commits would not go onto '${BRANCH}'`);
      expect(warnings[0]).toContain(`they are on '${RESCUE}'`);
      expect(warnings[0]).not.toContain("rm -rf");

      // And the row says it too (T31), which is the whole of what a dispatcher
      // who walked away has: the warning is a line in a log they would have to
      // know to open, and this is the durable record `status` and the terminal
      // notification are both read off.
      const rows = yield* Ref.get(scratch.appended);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.rescuedOnto).toEqual(Option.some(RESCUE));
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // The case a refused fast-forward is *not* about (T32): the commits reached
  // the branch already and the branch has moved on since, so the fetch would
  // rewind it and git says no for a reason that has nothing to do with this
  // copy. Nothing is minted, nobody is warned, and the directory goes — the
  // commits are on the branch the run was given, which is where the run was
  // asked to put them.
  it.scoped("mints nothing and says nothing when the branch already holds the commits", () =>
    Effect.gen(function* () {
      const scratch = yield* world({
        homeFetchBackFails: "! [rejected] (non-fast-forward)",
        branchAlreadyContains: true,
      });
      const fs = yield* FileSystem.FileSystem;
      yield* runInScope(
        scratch.plan,
        scratch.repoRoot,
        TEST_CREDENTIAL,
        TEST_FORGE_REPO,
        () => Effect.void,
      ).pipe(Effect.provide(scratch.layer));

      // The refused fetch, the copy's tip, the repo's answer about it — and
      // then nothing, because there was nothing left to do.
      expect(yield* Ref.get(scratch.gitCalls)).toEqual([
        {
          _tag: "Clone",
          source: repoUrl(scratch.repoRoot),
          branch: BRANCH,
          into: scratch.plan.checkoutPath,
        },
        ...identityCalls(scratch.repoRoot, scratch.plan.checkoutPath),
        branchRead(scratch.repoRoot),
        {
          _tag: "FetchBack",
          from: repoUrl(scratch.plan.checkoutPath),
          into: scratch.repoRoot,
          branch: BRANCH,
          onto: BRANCH,
        },
        { _tag: "RevParse", repo: scratch.plan.checkoutPath, rev: `refs/heads/${BRANCH}` },
        { _tag: "BranchContains", repo: scratch.repoRoot, branch: BRANCH, commit: CLONE_TIP },
      ]);

      // No rescue ref, no warning, and no row saying the commits went
      // somewhere of their own: this is `WentHome`, said the ordinary way.
      expect(warningsIn(yield* Ref.get(scratch.events))).toEqual([]);
      expect((yield* Ref.get(scratch.appended))[0]?.rescuedOnto).toEqual(Option.none());
      expect(yield* fs.exists(scratch.plan.checkoutPath)).toBe(false);
      expect(resourceEventsIn(yield* Ref.get(scratch.events))).toContainEqual([
        "ResourceReleased",
        "checkout",
      ]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // The other end of the same question: a tip the repo has never seen. git
  // refuses to answer that at all rather than answering no — and a tip nothing
  // here has ever seen is precisely a tip whose commits are only in the copy,
  // so it is the rescue's case and never an error of its own.
  it.scoped("rescues when the repo cannot answer whether it holds the commits", () =>
    Effect.gen(function* () {
      const scratch = yield* world({
        homeFetchBackFails: "! [rejected] (non-fast-forward)",
        branchContainsFails: `fatal: Not a valid commit name ${CLONE_TIP}`,
      });
      const fs = yield* FileSystem.FileSystem;
      yield* runInScope(
        scratch.plan,
        scratch.repoRoot,
        TEST_CREDENTIAL,
        TEST_FORGE_REPO,
        () => Effect.void,
      ).pipe(Effect.provide(scratch.layer));

      expect(
        (yield* Ref.get(scratch.gitCalls)).flatMap((call) =>
          call._tag === "FetchBack" && call.onto !== BRANCH ? [call.onto] : [],
        ),
      ).toEqual([RESCUE]);
      expect((yield* Ref.get(scratch.appended))[0]?.rescuedOnto).toEqual(Option.some(RESCUE));
      // The run is untouched by the question it could not get an answer to:
      // the commits are on a branch, the copy is gone, and the warning is the
      // rescue's one line.
      expect((yield* Ref.get(scratch.appended))[0]?.terminalReason).toEqual(
        Option.some({ _tag: "Completed" }),
      );
      expect(yield* fs.exists(scratch.plan.checkoutPath)).toBe(false);
      const warnings = warningsIn(yield* Ref.get(scratch.events));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(`they are on '${RESCUE}'`);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // The row a rescued run's *failure* writes, which is the shape the tracer
  // describes: the land could not fetch back, so the run failed at `land`, and
  // the release then found the same refusal and rescued. Both facts are on one
  // row — why it stopped, and where the commits it made now live.
  it.scoped("carries the rescue on a failed run's row, beside the stage it failed at", () =>
    Effect.gen(function* () {
      const scratch = yield* world({ homeFetchBackFails: "! [rejected] (non-fast-forward)" });
      const outcome = yield* Effect.either(
        runInScope(scratch.plan, scratch.repoRoot, TEST_CREDENTIAL, TEST_FORGE_REPO, () =>
          Effect.fail(atStage("land")(new GitError({ detail: "! [rejected] (non-fast-forward)" }))),
        ).pipe(Effect.provide(scratch.layer)),
      );

      expect(Either.isLeft(outcome)).toBe(true);
      const rows = yield* Ref.get(scratch.appended);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.terminalReason).toEqual(
        Option.some({ _tag: "Failed", stage: "land" as const }),
      );
      expect(rows[0]?.rescuedOnto).toEqual(Option.some(RESCUE));
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // The name is taken from the commits and not from the clock (T29): two
  // consecutive failed runs on one branch are different work, so they leave
  // two branches and neither is in a position to overwrite the other. A fixed
  // `<branch>-from-run` forced over would typecheck and destroy the first
  // run's commits, which is the loss this whole rule exists to prevent.
  it.scoped("names the rescue after the clone's tip, so two failed runs leave two branches", () =>
    Effect.gen(function* () {
      const rescuesOnto = (tip: string) =>
        Effect.gen(function* () {
          const scratch = yield* world({
            homeFetchBackFails: "! [rejected] (non-fast-forward)",
            cloneTip: tip,
          });
          yield* runInScope(
            scratch.plan,
            scratch.repoRoot,
            TEST_CREDENTIAL,
            TEST_FORGE_REPO,
            () => Effect.void,
          ).pipe(Effect.provide(scratch.layer));
          return (yield* Ref.get(scratch.gitCalls)).flatMap((call) =>
            call._tag === "FetchBack" && call.onto !== BRANCH ? [call.onto] : [],
          );
        });

      expect(yield* rescuesOnto(CLONE_TIP)).toEqual([RESCUE]);
      expect(yield* rescuesOnto("9f8e7d6c000000000000000000000000000000ff")).toEqual([
        `${BRANCH}-from-run-9f8e7d6`,
      ]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // The last row of the release's table (matrix row 13): *neither* destination
  // took the commits, which is a broken repo or a broken disk rather than the
  // routine rebase — the clone is the only copy of them, so the directory
  // stays. A rescue that cannot be written is exactly as loud as a fetch that
  // could not go home, and no louder.
  it.scoped("keeps the checkout, loudly, when neither destination takes the commits", () =>
    Effect.gen(function* () {
      const scratch = yield* world({ fetchBackFails: "! [rejected] (non-fast-forward)" });
      const fs = yield* FileSystem.FileSystem;
      const outcome = yield* Effect.either(
        runInScope(scratch.plan, scratch.repoRoot, TEST_CREDENTIAL, TEST_FORGE_REPO, () =>
          Effect.succeed("the run itself was fine"),
        ).pipe(Effect.provide(scratch.layer)),
      );

      // A finalizer never fails the scope (design rule 4): the run keeps its
      // own outcome and its own row.
      expect(outcome).toEqual(Either.right("the run itself was fine"));
      expect((yield* Ref.get(scratch.appended))[0]?.terminalReason).toEqual(
        Option.some({ _tag: "Completed" }),
      );
      // No rescue on this row either (T31), and that is not an oversight: the
      // commits are in the kept checkout, which is a directory and not a
      // branch, so there is no name to put here. The loud warning below is
      // still the whole of what this case says.
      expect((yield* Ref.get(scratch.appended))[0]?.rescuedOnto).toEqual(Option.none());

      expect(yield* fs.exists(`${scratch.plan.checkoutPath}/${CLONE_MARKER}`)).toBe(true);
      const warnings = warningsIn(yield* Ref.get(scratch.events));
      // What the run lost, git's own reason folded in once, and where the
      // directory it left behind is — the fold never restates the clause a
      // `GitError`'s detail already opens with.
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("still in its own copy of the repository");
      expect(warnings[0]).toContain("non-fast-forward");
      expect(warnings[0]).toContain(scratch.plan.checkoutPath);
      // Both destinations it tried, named: the branch the run was given, and
      // the branch of its own that did not take them either.
      expect(warnings[0]).toContain(`not on '${BRANCH}'`);
      expect(warnings[0]).toContain(`Putting them on '${RESCUE}' instead`);
      // Both were tried, in that order, and the rescue's name was read out of
      // the clone before anything was removed.
      expect(yield* Ref.get(scratch.gitCalls)).toContainEqual({
        _tag: "FetchBack",
        from: repoUrl(scratch.plan.checkoutPath),
        into: scratch.repoRoot,
        branch: BRANCH,
        onto: RESCUE,
      });
      // The recovery, not just the diagnosis: a dispatcher who reads this has
      // to be able to act on it without knowing that the checkout is a clone.
      expect(warnings[0]).toContain(
        `git fetch ${scratch.plan.checkoutPath} refs/heads/${BRANCH}:refs/heads/${BRANCH}-from-run`,
      );
      expect(warnings[0]).toContain(`rm -rf ${scratch.plan.checkoutPath}`);
      // Kept is not released, and the sandbox and the lock still let go
      // around it.
      expect(resourceEventsIn(yield* Ref.get(scratch.events))).toEqual([
        ["ResourceAcquired", "lock"],
        ["ResourceAcquired", "checkout"],
        ["ResourceAcquired", "sandbox"],
        ["ResourceReleased", "sandbox"],
        ["ResourceReleased", "lock"],
      ]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // **A fetch that reported success and moved nothing** (T38), which is the
  // input the whole ruling is about: a partial fetch, a refspec that landed
  // somewhere unexpected, or a `Git` layer that recorded rather than fetched.
  // The old salvage answered `WentHome` on that return value and the caller
  // deleted the only copy of the commits; now the read afterwards is what
  // decides, so the directory stays.
  it.scoped("keeps the checkout when the fetch-back answers success and moves nothing", () =>
    Effect.gen(function* () {
      const scratch = yield* world({ fetchBackLands: false });
      const fs = yield* FileSystem.FileSystem;
      yield* runInScope(
        scratch.plan,
        scratch.repoRoot,
        TEST_CREDENTIAL,
        TEST_FORGE_REPO,
        () => Effect.void,
      ).pipe(Effect.provide(scratch.layer));

      // One fetch, and the two reads that refused to vouch for it. No rescue:
      // nothing was refused, so a second destination has nothing to prove and
      // one answering success the same way would mint a name holding nothing.
      expect((yield* Ref.get(scratch.gitCalls)).map((call) => call._tag)).toEqual([
        "Clone",
        ...IDENTITY_TAGS,
        "RevParse",
        "FetchBack",
        ...CONTAINMENT_TAGS,
      ]);
      expect(
        (yield* Ref.get(scratch.gitCalls)).flatMap((call) =>
          call._tag === "FetchBack" ? [call.onto] : [],
        ),
      ).toEqual([BRANCH]);

      // The copy is still there, marker and all, and the checkout never
      // released — a kept copy is not a released resource.
      expect(yield* fs.readFileString(`${scratch.plan.checkoutPath}/${CLONE_MARKER}`)).toBe(
        `${BRANCH}\n`,
      );
      expect(resourceEventsIn(yield* Ref.get(scratch.events))).toEqual([
        ["ResourceAcquired", "lock"],
        ["ResourceAcquired", "checkout"],
        ["ResourceAcquired", "sandbox"],
        ["ResourceReleased", "sandbox"],
        ["ResourceReleased", "lock"],
      ]);

      // And the sentence says what actually happened, which is **not** what a
      // refused fast-forward's says: git did not refuse anything, so nothing
      // is quoted as having, and the commit the question was asked about is
      // named so a reader can go and look for it themselves.
      const warnings = warningsIn(yield* Ref.get(scratch.events));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("still in its own copy of the repository");
      expect(warnings[0]).toContain(`git reported the move onto '${BRANCH}' went through`);
      expect(warnings[0]).toContain(CLONE_TIP);
      expect(warnings[0]).toContain(`rm -rf ${scratch.plan.checkoutPath}`);
      expect(warnings[0]).not.toContain("This move did not go through");
      expect(warnings[0]).not.toContain("Putting them on");
      expect(warnings[0]).not.toContain(RESCUE);

      // The run itself is untouched by any of it (T29's rule): the release
      // decides where the commits live, never whether the run succeeded — and
      // there is no branch to put on the row, because the commits are in a
      // directory.
      const rows = yield* Ref.get(scratch.appended);
      expect(rows[0]?.terminalReason).toEqual(Option.some({ _tag: "Completed" }));
      expect(rows[0]?.rescuedOnto).toEqual(Option.none());
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // **The same input, one destination over.** The branch refuses, so a rescue
  // is minted — and *that* fetch answers success without moving anything. The
  // arm above this one closed the branch's removal; T38 left this one open on
  // purpose, scoped out by its own acceptance criteria, and it is the case
  // where trusting a return value costs most: the rescue is reached only
  // because the branch already said no, so by then the copy is the sole known
  // home of the work, and a `Rescued` here deletes it on the strength of a ref
  // that was never written.
  it.scoped("keeps the checkout when the rescue answers success and moves nothing", () =>
    Effect.gen(function* () {
      const scratch = yield* world({
        homeFetchBackFails: "! [rejected] (non-fast-forward)",
        fetchBackLands: false,
      });
      const fs = yield* FileSystem.FileSystem;
      yield* runInScope(
        scratch.plan,
        scratch.repoRoot,
        TEST_CREDENTIAL,
        TEST_FORGE_REPO,
        () => Effect.void,
      ).pipe(Effect.provide(scratch.layer));

      // Both destinations were tried, in order, and each one was read about
      // afterwards — the branch before the rescue was minted, the rescue
      // before the directory would have gone.
      expect((yield* Ref.get(scratch.gitCalls)).map((call) => call._tag)).toEqual([
        "Clone",
        ...IDENTITY_TAGS,
        "RevParse",
        "FetchBack",
        ...CONTAINMENT_TAGS,
        "FetchBack",
        "BranchContains",
      ]);
      expect(
        (yield* Ref.get(scratch.gitCalls)).flatMap((call) =>
          call._tag === "FetchBack" ? [call.onto] : [],
        ),
      ).toEqual([BRANCH, RESCUE]);
      // And the last read is the one that decided it: asked in the repo, about
      // the rescue's name, for the tip the copy is on.
      expect((yield* Ref.get(scratch.gitCalls)).at(-1)).toEqual({
        _tag: "BranchContains",
        repo: scratch.repoRoot,
        branch: RESCUE,
        commit: CLONE_TIP,
      });

      // The copy is still there, and the checkout never released.
      expect(yield* fs.readFileString(`${scratch.plan.checkoutPath}/${CLONE_MARKER}`)).toBe(
        `${BRANCH}\n`,
      );
      expect(resourceEventsIn(yield* Ref.get(scratch.events))).toEqual([
        ["ResourceAcquired", "lock"],
        ["ResourceAcquired", "checkout"],
        ["ResourceAcquired", "sandbox"],
        ["ResourceReleased", "sandbox"],
        ["ResourceReleased", "lock"],
      ]);

      // The sentence has both halves and neither of the other arms': git's
      // refusal of the branch quoted as git's, and the rescue's silence
      // reported as a read rather than as a second refusal.
      const warnings = warningsIn(yield* Ref.get(scratch.events));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("still in its own copy of the repository");
      expect(warnings[0]).toContain("git said: ! [rejected] (non-fast-forward)");
      expect(warnings[0]).toContain(`So they were put on '${RESCUE}' instead`);
      expect(warnings[0]).toContain(`'${RESCUE}' here does not hold ${CLONE_TIP}`);
      expect(warnings[0]).toContain(`rm -rf ${scratch.plan.checkoutPath}`);
      expect(warnings[0]).not.toContain("git also said");
      expect(warnings[0]).not.toContain("that did not work either");

      // No rescue reaches the row, because none happened: the ledger's
      // `rescuedOnto` is where the commits *are*, not where they were sent.
      const rows = yield* Ref.get(scratch.appended);
      expect(rows[0]?.terminalReason).toEqual(Option.some({ _tag: "Completed" }));
      expect(rows[0]?.rescuedOnto).toEqual(Option.none());
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // The whole path, end to end, and the reason the reconciler's narrowing
  // exists: the run above kept its clone because the commits could not go
  // home, and the lock left with the scope — so what the *next* dispatch's
  // preflight sees is a checkout with no lock beside it. It reports that and
  // touches nothing; the classification itself is pinned in
  // `test/reconcile.test.ts`. Only dockerd is scripted here, holding nothing,
  // because the run's own container went with its sandbox finalizer.
  it.scoped("survives the next dispatch's reconcile, which reports it and takes nothing", () =>
    Effect.gen(function* () {
      const scratch = yield* world({ fetchBackFails: "! [rejected] (non-fast-forward)" });
      const fs = yield* FileSystem.FileSystem;
      yield* runInScope(
        scratch.plan,
        scratch.repoRoot,
        TEST_CREDENTIAL,
        TEST_FORGE_REPO,
        () => Effect.void,
      ).pipe(Effect.provide(scratch.layer));
      expect(yield* fs.exists(`${scratch.plan.checkoutPath}/${CLONE_MARKER}`)).toBe(true);
      expect(yield* fs.readDirectory(`${scratch.runtimeRoot}/locks`)).toEqual([]);

      yield* reconcile(scratch.repoRoot).pipe(
        Effect.provide(
          Layer.merge(scratch.layer, scriptedExecutor({ "docker ps": { exit: 0, stdout: "\n" } })),
        ),
      );

      // The commits are still where the run left them, marker and all.
      expect(yield* fs.readFileString(`${scratch.plan.checkoutPath}/${CLONE_MARKER}`)).toBe(
        `${BRANCH}\n`,
      );
      const warnings = warningsIn(yield* Ref.get(scratch.events));
      expect(
        warnings.some((detail) => detail.includes("still in its own copy of the repository")),
      ).toBe(true);
      // End to end, the reconciler's notice names the branch it read out of
      // the copy's own HEAD — the fact the slug cannot carry.
      expect(
        warnings.some(
          (detail) =>
            detail.includes("kept its own copy of the repository") &&
            detail.includes(scratch.plan.checkoutPath) &&
            detail.includes("nothing was removed") &&
            detail.includes(`refs/heads/${BRANCH}:refs/heads/${BRANCH}-from-run`),
        ),
      ).toBe(true);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // The same walk with the rescue in it (T29), which is what turns the case
  // above into the rare one: the commits could not go onto the branch the run
  // was given, went onto a branch of the release's own, and the copy went with
  // them. The next dispatch's preflight then finds nothing to report and
  // nothing in its way — no directory, and no notice about one.
  it.scoped("leaves the next dispatch's reconcile nothing to report once a rescue lands", () =>
    Effect.gen(function* () {
      const scratch = yield* world({ homeFetchBackFails: "! [rejected] (non-fast-forward)" });
      const fs = yield* FileSystem.FileSystem;
      yield* runInScope(
        scratch.plan,
        scratch.repoRoot,
        TEST_CREDENTIAL,
        TEST_FORGE_REPO,
        () => Effect.void,
      ).pipe(Effect.provide(scratch.layer));
      expect(yield* fs.exists(scratch.plan.checkoutPath)).toBe(false);
      expect(yield* fs.readDirectory(`${scratch.runtimeRoot}/locks`)).toEqual([]);

      yield* reconcile(scratch.repoRoot).pipe(
        Effect.provide(
          Layer.merge(scratch.layer, scriptedExecutor({ "docker ps": { exit: 0, stdout: "\n" } })),
        ),
      );

      // One line about the rescue branch, and nothing about a copy anyone has
      // to decide about — the reconciler saw no checkout at all.
      const warnings = warningsIn(yield* Ref.get(scratch.events));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(`they are on '${RESCUE}'`);
      expect(warnings.some((detail) => detail.includes("kept its own copy"))).toBe(false);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // Matrix row 18: the finalizer's own failure is swallowed, so the run's
  // error reaches the caller unmasked rather than becoming a defect.
  it.scoped("leaves the run's own error unmasked when the release fails too", () =>
    Effect.gen(function* () {
      const scratch = yield* world({ fetchBackFails: "! [rejected] (non-fast-forward)" });
      const fs = yield* FileSystem.FileSystem;
      const exit = yield* Effect.exit(
        runInScope(scratch.plan, scratch.repoRoot, TEST_CREDENTIAL, TEST_FORGE_REPO, () =>
          Effect.fail("the run's own error"),
        ).pipe(Effect.provide(scratch.layer)),
      );

      expect(exit).toEqual(Exit.fail("the run's own error"));
      expect(yield* fs.exists(scratch.plan.checkoutPath)).toBe(true);
      expect(warningsIn(yield* Ref.get(scratch.events))[0]).toContain(
        "still in its own copy of the repository",
      );
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // Matrix row 5: the run started, so it owes a row — and the row names the
  // stage, from the closed `RunStage` union rather than a fresh string.
  it.scoped(
    "fails a clone as a typed GitError, releases the lock, and records stage checkout",
    () =>
      Effect.gen(function* () {
        const scratch = yield* world({ cloneFails: "fatal: repository does not exist" });
        const fs = yield* FileSystem.FileSystem;
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
          expect(outcome.left._tag).toBe("GitError");
          expect(outcome.left.detail).toContain("repository does not exist");
        }
        const rows = yield* Ref.get(scratch.appended);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.terminalReason).toEqual(
          Option.some({ _tag: "Failed", stage: "checkout" as const }),
        );
        // The lock is released and nothing was left under the runtime root but
        // the two directories the lock and the log live in.
        expect(yield* fs.readDirectory(`${scratch.runtimeRoot}/locks`)).toEqual([]);
        expect(yield* fs.exists(scratch.plan.checkoutPath)).toBe(false);
        // A clone that never happened has nothing to fetch back.
        expect((yield* Ref.get(scratch.gitCalls)).map((call) => call._tag)).toEqual(["Clone"]);
        expect(resourceEventsIn(yield* Ref.get(scratch.events))).toEqual([
          ["ResourceAcquired", "lock"],
          ["ResourceReleased", "lock"],
        ]);
      }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // **The identity a run's commits carry is a property of the dispatch** (T35).
  // Written into the clone between the clone itself and the container that
  // mounts it: an identity the agent could set is a claim, and one the
  // dispatcher set before the agent existed is a default the agent had no part
  // in. Asserted from *inside* the run, which is after the sandbox started —
  // whatever the agent does next, the value was already there.
  it.scoped("carries the dispatching dev's identity into the clone before the agent runs", () =>
    Effect.gen(function* () {
      const scratch = yield* world();
      yield* runInScope(scratch.plan, scratch.repoRoot, TEST_CREDENTIAL, TEST_FORGE_REPO, () =>
        Effect.gen(function* () {
          expect(yield* Ref.get(scratch.gitCalls)).toEqual([
            {
              _tag: "Clone",
              source: repoUrl(scratch.repoRoot),
              branch: BRANCH,
              into: scratch.plan.checkoutPath,
            },
            // Read in the repo this dispatch is for, written in the copy the
            // agent works in — two values read and two written, and no other
            // key either way.
            ...identityCalls(scratch.repoRoot, scratch.plan.checkoutPath),
          ]);
        }),
      ).pipe(Effect.provide(scratch.layer));
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // A host that never set `user.name` is not an error — it is the fallback,
  // which is the whole reason bash has one (`run.sh:1453-1454`). The name
  // falls back to the host user this dispatch runs as, and the email to a
  // noreply address rather than to a guess at a real mailbox.
  it.scoped("falls back to the host username and a noreply address, without failing", () =>
    Effect.gen(function* () {
      const scratch = yield* world({ config: {} });
      yield* runInScope(
        scratch.plan,
        scratch.repoRoot,
        TEST_CREDENTIAL,
        TEST_FORGE_REPO,
        () => Effect.void,
      ).pipe(Effect.provide(scratch.layer));

      expect(
        (yield* Ref.get(scratch.gitCalls)).filter((call) => call._tag === "SetConfig"),
      ).toEqual([
        {
          _tag: "SetConfig",
          repo: scratch.plan.checkoutPath,
          key: "user.name",
          value: userInfo().username,
        },
        {
          _tag: "SetConfig",
          repo: scratch.plan.checkoutPath,
          key: "user.email",
          value: "speepobox@users.noreply.github.com",
        },
      ]);
      // And the run went through: an unset key is an answer, so nothing here
      // refused and nothing warned.
      expect((yield* Ref.get(scratch.appended))[0]?.terminalReason).toEqual(
        Option.some({ _tag: "Completed" }),
      );
      expect(warningsIn(yield* Ref.get(scratch.events))).toEqual([]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // A write that will not land is a `GitError` like the clone beside it: it
  // happens inside the resource's acquire, so the run fails at stage checkout
  // — and the acquire takes its own clone away on the way out, because
  // `acquireRelease` adds the release only once the acquire has succeeded.
  it.scoped("fails at stage checkout when the identity cannot be written", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const scratch = yield* world({ setConfigFails: "error: could not lock config file" });
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
        expect(outcome.left._tag).toBe("GitError");
        expect(outcome.left.detail).toContain("could not lock config file");
      }
      expect((yield* Ref.get(scratch.appended))[0]?.terminalReason).toEqual(
        Option.some({ _tag: "Failed", stage: "checkout" as const }),
      );
      // The agent never started: the container is mounted on a clone that
      // never finished being one.
      expect(yield* Ref.get(scratch.sandboxes)).toEqual([]);
      // And nothing of that clone is left on disk. A lone checkout is `Kept` by
      // the reconciler (`wreckage.ts`) and reported to a human as a copy that
      // may hold the only version of a run's work — which this one provably
      // does not, so leaving it would be a false alarm the next dispatch of
      // this branch also has to explain away.
      expect(yield* fs.exists(scratch.plan.checkoutPath)).toBe(false);
      expect(warningsIn(yield* Ref.get(scratch.events))).toEqual([]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // The same failure onto a disk that will not delete either: nothing is lost
  // because nothing ever ran in the copy, and the sentence that says so names
  // the path rather than leaving a directory nobody was told about.
  it.scoped("says so when the clone it could not finish cannot be removed either", () =>
    Effect.gen(function* () {
      const refusing = yield* Ref.make(true);
      const scratch = yield* world(
        { setConfigFails: "error: could not lock config file" },
        refusing,
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

      // The run still fails on the write that would not land, not on the
      // directory: the removal is the acquire's own tidying, never its error.
      expect(Either.isLeft(outcome)).toBe(true);
      if (Either.isLeft(outcome)) {
        expect(outcome.left.detail).toContain("could not lock config file");
      }
      const warned = warningsIn(yield* Ref.get(scratch.events));
      expect(warned).toHaveLength(1);
      expect(warned[0]).toContain(scratch.plan.checkoutPath);
      expect(warned[0]).toContain("nothing ever ran in it");
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // The same property read off **argv** rather than off domain values: which
  // repository each `git config` named, in the words the child was spawned
  // with (T35). The fake `Git` cannot answer this — it is handed the paths
  // rather than the flags — so this one case runs `GitLive` over the scripted
  // executor, and `recorded` is where "into the clone and nowhere else"
  // becomes an assertion.
  it.scoped("writes the identity into the run's own copy and into no other repository", () =>
    Effect.gen(function* () {
      const scratch = yield* world();
      const recorded = yield* Ref.make<ReadonlyArray<string>>([]);
      const discarded = yield* Ref.make(Option.none<string>());
      const rescued = yield* Ref.make(Option.none<string>());
      const script = {
        "git clone": { exit: 0 },
        [`${inRepo(scratch.repoRoot)} config --get user.name`]: {
          exit: 0,
          stdout: `${DISPATCHER["user.name"]}\n`,
        },
        [`${inRepo(scratch.repoRoot)} config --get user.email`]: {
          exit: 0,
          stdout: `${DISPATCHER["user.email"]}\n`,
        },
        "git -C": { exit: 0 },
      };

      yield* checkout(scratch.plan, scratch.repoRoot, rescued, discarded).pipe(
        Effect.provide(
          Layer.mergeAll(
            GitLive.pipe(Layer.provide(scriptedExecutor(script, recorded))),
            Layer.succeed(Reporter, { emit: () => Effect.void }),
            NodeFileSystem.layer,
          ),
        ),
      );

      const argv = yield* Ref.get(recorded);
      // Two reads, in the repo this dispatch is for — where the dispatching
      // dev's own config is what git resolves.
      expect(argv.filter((command) => command.includes(" config --get "))).toEqual([
        `${inRepo(scratch.repoRoot)} config --get user.name`,
        `${inRepo(scratch.repoRoot)} config --get user.email`,
      ]);
      // Two writes, in the clone, and `--local` in the words themselves.
      expect(argv.filter((command) => command.includes(" config --local "))).toEqual([
        `${inRepo(scratch.plan.checkoutPath)} config --local user.name ${DISPATCHER["user.name"]}`,
        `${inRepo(scratch.plan.checkoutPath)} config --local user.email ${DISPATCHER["user.email"]}`,
      ]);
      // And nothing else asked git about config at all: no third key, no
      // `--global`, and no reach for a file belonging to a human.
      expect(argv.filter((command) => command.includes(" config "))).toHaveLength(4);
      expect(argv.some((command) => command.includes("--global"))).toBe(false);
      expect(argv.some((command) => command.includes("gitconfig"))).toBe(false);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped("reports the checkout's own progress into the run log", () =>
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
      expect(log).toContain("checkout: acquired");
      expect(log).toContain("checkout: released");
      // The sandbox is acquired inside the same bracket, so its pair reaches
      // the log as well — the lock's is the one deliberate absence.
      expect(log).toContain("sandbox: acquired");
      expect(log).toContain("sandbox: released");
      // And the lock's pair does not, at *either* end — the ruling in
      // `run.ts`, pinned so a change that lands one of them without the other
      // trips here and reads it. The console stream above has all four.
      expect(log).not.toContain("lock: ");
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

// A file no clone of ours ever writes, so "the directory was removed and a
// fresh clone landed" is distinguishable from "the clone landed on top of it".
const STALE = "LEFT-BY-THE-DEAD-RUN";

// A kept copy as the host has it: the marker a fake clone leaves, a `HEAD` on
// the branch, and the dead run's own file. Written directly, exactly as T25's
// cases write theirs — nothing on disk says which of §1b's two causes left it,
// and that is the point: the salvage separates them by asking.
const keptCheckoutAt = (path: string): Effect.Effect<void, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(`${path}/.git`, { recursive: true });
    yield* fs.writeFileString(`${path}/${CLONE_MARKER}`, `${BRANCH}\n`);
    yield* fs.writeFileString(`${path}/.git/HEAD`, `ref: refs/heads/${BRANCH}\n`);
    yield* fs.writeFileString(`${path}/${STALE}`, "what the dead run did\n");
  }).pipe(Effect.orDie);

// The salvage asked on the way **in** (T28), which is the same function the
// release calls and the reason a branch that kept a checkout is re-dispatchable
// at all: `git clone` refuses a destination that exists, so before this the one
// branch you most want to re-run was the one you could not. The authority is
// the slug's own — the reconciler still reports every other slug's kept copy
// and touches none of them (T25).
describe("a checkout an earlier run of the same slug left behind", () => {
  // The path that does not exist is every case above, and it must stay exactly
  // as it was: no salvage, and no git question but the clone the run came for.
  it.scoped("asks git nothing extra when there is no directory in the way", () =>
    Effect.gen(function* () {
      const scratch = yield* world();
      const fs = yield* FileSystem.FileSystem;
      expect(yield* fs.exists(scratch.plan.checkoutPath)).toBe(false);

      yield* runInScope(
        scratch.plan,
        scratch.repoRoot,
        TEST_CREDENTIAL,
        TEST_FORGE_REPO,
        () => Effect.void,
      ).pipe(Effect.provide(scratch.layer));

      // The clone is the first thing git is asked, the identity goes into it,
      // and the release's fetch and the read that authorizes its removal are
      // the only others. Nothing asked about the path that was not there.
      expect((yield* Ref.get(scratch.gitCalls)).map((call) => call._tag)).toEqual([
        "Clone",
        ...IDENTITY_TAGS,
        "RevParse",
        "FetchBack",
        ...CONTAINMENT_TAGS,
      ]);
      expect(warningsIn(yield* Ref.get(scratch.events))).toEqual([]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // §1b's first survivor and the case this mostly exists for: the commits went
  // home and the removal failed, so the retried fetch is a fast-forward over
  // zero commits and the directory holds nothing irreplaceable.
  it.scoped("sends a kept checkout's commits home, removes it, says so, and clones", () =>
    Effect.gen(function* () {
      const scratch = yield* world();
      const fs = yield* FileSystem.FileSystem;
      yield* keptCheckoutAt(scratch.plan.checkoutPath);

      yield* runInScope(scratch.plan, scratch.repoRoot, TEST_CREDENTIAL, TEST_FORGE_REPO, () =>
        Effect.gen(function* () {
          // Removed and re-cloned, rather than cloned on top of.
          expect(yield* fs.exists(`${scratch.plan.checkoutPath}/${STALE}`)).toBe(false);
          expect(yield* fs.readFileString(`${scratch.plan.checkoutPath}/${CLONE_MARKER}`)).toBe(
            `${BRANCH}\n`,
          );
        }),
      ).pipe(Effect.provide(scratch.layer));

      // The salvage, then the clone the dispatch came for, then the run's own
      // release — one fetch each, because each of them went home, and the
      // containment read after each that says so (T38). The dead run's copy
      // and this run's are different directories with different tips, so the
      // two questions are asked about different commits.
      expect(yield* Ref.get(scratch.gitCalls)).toEqual([
        branchRead(scratch.repoRoot),
        {
          _tag: "FetchBack",
          from: repoUrl(scratch.plan.checkoutPath),
          into: scratch.repoRoot,
          branch: BRANCH,
          onto: BRANCH,
        },
        { _tag: "RevParse", repo: scratch.plan.checkoutPath, rev: `refs/heads/${BRANCH}` },
        { _tag: "BranchContains", repo: scratch.repoRoot, branch: BRANCH, commit: PRE_TIP },
        {
          _tag: "Clone",
          source: repoUrl(scratch.repoRoot),
          branch: BRANCH,
          into: scratch.plan.checkoutPath,
        },
        ...identityCalls(scratch.repoRoot, scratch.plan.checkoutPath),
        branchRead(scratch.repoRoot),
        {
          _tag: "FetchBack",
          from: repoUrl(scratch.plan.checkoutPath),
          into: scratch.repoRoot,
          branch: BRANCH,
          onto: BRANCH,
        },
        { _tag: "RevParse", repo: scratch.plan.checkoutPath, rev: `refs/heads/${BRANCH}` },
        { _tag: "BranchContains", repo: scratch.repoRoot, branch: BRANCH, commit: CLONE_TIP },
      ]);

      const warnings = warningsIn(yield* Ref.get(scratch.events));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(scratch.plan.checkoutPath);
      expect(warnings[0]).toContain(`its commits are on '${BRANCH}'`);
      expect((yield* Ref.get(scratch.appended))[0]?.terminalReason).toEqual(
        Option.some({ _tag: "Completed" }),
      );
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // The way *in* has the same two situations behind one refusal (T32), and the
  // dead run's is the likelier of them: its commits went home, the branch has
  // moved on since — a merge, a hand commit, the status commit the port will
  // write — and the copy it left behind is a copy of what is already on the
  // branch. The path is cleared as if the fetch had gone through, because as
  // far as the commits are concerned it did.
  it.scoped("clears a kept checkout the branch already holds, minting no rescue", () =>
    Effect.gen(function* () {
      const scratch = yield* world({
        homeFetchBackFails: "! [rejected] (non-fast-forward)",
        branchAlreadyContains: true,
      });
      const fs = yield* FileSystem.FileSystem;
      yield* keptCheckoutAt(scratch.plan.checkoutPath);

      yield* runInScope(
        scratch.plan,
        scratch.repoRoot,
        TEST_CREDENTIAL,
        TEST_FORGE_REPO,
        () => Effect.void,
      ).pipe(Effect.provide(scratch.layer));

      // The salvage, the copy's tip, the repo's answer — and then the clone
      // this dispatch came for, with no destination of the dead run's own
      // anywhere in between.
      const calls = yield* Ref.get(scratch.gitCalls);
      expect(calls.slice(0, 5).map((call) => call._tag)).toEqual([
        "RevParse",
        "FetchBack",
        "RevParse",
        "BranchContains",
        "Clone",
      ]);
      expect(
        calls.flatMap((call) =>
          call._tag === "FetchBack" && call.onto !== BRANCH ? [call.onto] : [],
        ),
      ).toEqual([]);

      // The dispatcher is told the copy went, and told the true reason it
      // could: the commits are on the branch they were always meant for. No
      // sentence here says they would not go onto it.
      const warnings = warningsIn(yield* Ref.get(scratch.events));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(scratch.plan.checkoutPath);
      expect(warnings[0]).toContain(`its commits are on '${BRANCH}'`);
      expect(warnings[0]).not.toContain("would not go onto");
      expect(yield* fs.exists(`${scratch.plan.checkoutPath}/${STALE}`)).toBe(false);
      expect((yield* Ref.get(scratch.appended))[0]?.terminalReason).toEqual(
        Option.some({ _tag: "Completed" }),
      );
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // §4's third case, which exists only because this ticket runs after T29: the
  // dead run kept its copy, and the repo now takes those commits somewhere. The
  // rescue is named from the commits in *that* directory, never from this run.
  it.scoped("rescues a kept checkout onto a branch of the dead run's own, then clones", () =>
    Effect.gen(function* () {
      const scratch = yield* world({ homeFetchBackFails: "! [rejected] (non-fast-forward)" });
      const fs = yield* FileSystem.FileSystem;
      yield* keptCheckoutAt(scratch.plan.checkoutPath);

      yield* runInScope(
        scratch.plan,
        scratch.repoRoot,
        TEST_CREDENTIAL,
        TEST_FORGE_REPO,
        () => Effect.void,
      ).pipe(Effect.provide(scratch.layer));

      const calls = yield* Ref.get(scratch.gitCalls);
      // Home first, then the name read out of the directory, then the repo's
      // answer about it, then the rescue and the repo's answer about *that* —
      // and only then the clone. Nothing was removed before the two fetches
      // that read from it, nor before the read that vouched for the second.
      expect(calls.slice(0, 7)).toEqual([
        branchRead(scratch.repoRoot),
        {
          _tag: "FetchBack",
          from: repoUrl(scratch.plan.checkoutPath),
          into: scratch.repoRoot,
          branch: BRANCH,
          onto: BRANCH,
        },
        { _tag: "RevParse", repo: scratch.plan.checkoutPath, rev: `refs/heads/${BRANCH}` },
        { _tag: "BranchContains", repo: scratch.repoRoot, branch: BRANCH, commit: PRE_TIP },
        {
          _tag: "FetchBack",
          from: repoUrl(scratch.plan.checkoutPath),
          into: scratch.repoRoot,
          branch: BRANCH,
          onto: STALE_RESCUE,
        },
        { _tag: "BranchContains", repo: scratch.repoRoot, branch: STALE_RESCUE, commit: PRE_TIP },
        {
          _tag: "Clone",
          source: repoUrl(scratch.repoRoot),
          branch: BRANCH,
          into: scratch.plan.checkoutPath,
        },
      ]);

      // The dispatcher is told which branch holds the dead run's work, and the
      // directory is gone.
      const warnings = warningsIn(yield* Ref.get(scratch.events));
      expect(warnings[0]).toContain(scratch.plan.checkoutPath);
      expect(warnings[0]).toContain(`they are on '${STALE_RESCUE}'`);
      expect(yield* fs.exists(`${scratch.plan.checkoutPath}/${STALE}`)).toBe(false);
      // The run itself ran: its own release rescued in turn, onto the tip of
      // the copy *it* made, which is a different commit and so a second branch.
      expect(
        (yield* Ref.get(scratch.gitCalls)).flatMap((call) =>
          call._tag === "FetchBack" && call.onto !== BRANCH ? [call.onto] : [],
        ),
      ).toEqual([STALE_RESCUE, RESCUE]);
      expect((yield* Ref.get(scratch.appended))[0]?.terminalReason).toEqual(
        Option.some({ _tag: "Completed" }),
      );
      // This run's row names *this* run's rescue and not the dead run's (T31).
      // The salvage on the way in moved commits whose row was written and
      // notified long ago; recording it here would attribute another run's
      // work to this one.
      expect((yield* Ref.get(scratch.appended))[0]?.rescuedOnto).toEqual(Option.some(RESCUE));
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // §1b's second survivor, and the deliberate refusal: rubble from a clone that
  // died mid-write is indistinguishable from a repo whose branch will not
  // fast-forward, so the safe direction keeps it and the dispatch stops.
  it.scoped("refuses at stage checkout when neither destination takes the commits", () =>
    Effect.gen(function* () {
      const scratch = yield* world({ fetchBackFails: "! [rejected] (non-fast-forward)" });
      const fs = yield* FileSystem.FileSystem;
      yield* keptCheckoutAt(scratch.plan.checkoutPath);

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
        expect(outcome.left._tag).toBe("GitError");
        expect(outcome.left.detail).toContain(scratch.plan.checkoutPath);
        expect(outcome.left.detail).toContain("Nothing was removed");
        expect(outcome.left.detail).toContain("non-fast-forward");
        // Both destinations are named, and the `rm -rf` is handed to the
        // reader rather than run.
        expect(outcome.left.detail).toContain(`Putting them on '${STALE_RESCUE}' instead`);
        expect(outcome.left.detail).toContain(`rm -rf ${scratch.plan.checkoutPath}`);
      }

      // The lock was held, so the row is owed — `failed`, at the stage the run
      // was already in (SPEC §11, matrix row 5).
      const rows = yield* Ref.get(scratch.appended);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.terminalReason).toEqual(
        Option.some({ _tag: "Failed", stage: "checkout" as const }),
      );

      // Untouched, down to the file the dead run left in it, and nothing was
      // cloned over it.
      expect(yield* fs.readFileString(`${scratch.plan.checkoutPath}/${STALE}`)).toBe(
        "what the dead run did\n",
      );
      expect((yield* Ref.get(scratch.gitCalls)).map((call) => call._tag)).toEqual([
        "RevParse",
        "FetchBack",
        "RevParse",
        "BranchContains",
        "FetchBack",
      ]);
      expect(resourceEventsIn(yield* Ref.get(scratch.events))).toEqual([
        ["ResourceAcquired", "lock"],
        ["ResourceReleased", "lock"],
      ]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // The same input on the way **in**, where the dispatch is the one that has
  // to stop (T38): the salvage's fetch reported success over a dead run's
  // copy, the branch does not hold that copy's commits afterwards, and the
  // next line would have been an `rm -rf` of the only place they exist.
  it.scoped("refuses to clear a dead run's copy the branch does not hold afterwards", () =>
    Effect.gen(function* () {
      const scratch = yield* world({ fetchBackLands: false });
      const fs = yield* FileSystem.FileSystem;
      yield* keptCheckoutAt(scratch.plan.checkoutPath);

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
        expect(outcome.left._tag).toBe("GitError");
        expect(outcome.left.detail).toContain("Nothing was removed");
        expect(outcome.left.detail).toContain(
          `git reported the move onto '${BRANCH}' went through`,
        );
        // The tip the question was asked about is the one in *that* directory
        // (T27), which is not the one the repo's branch is at.
        expect(outcome.left.detail).toContain(PRE_TIP);
        expect(outcome.left.detail).toContain(`rm -rf ${scratch.plan.checkoutPath}`);
        expect(outcome.left.detail).not.toContain("neither went through");
      }

      // Untouched, down to the file the dead run left in it, and nothing was
      // cloned over it — the fetch, the tip, the repo's answer, and then a
      // refusal.
      expect(yield* fs.readFileString(`${scratch.plan.checkoutPath}/${STALE}`)).toBe(
        "what the dead run did\n",
      );
      expect((yield* Ref.get(scratch.gitCalls)).map((call) => call._tag)).toEqual([
        "RevParse",
        "FetchBack",
        ...CONTAINMENT_TAGS,
      ]);
      expect((yield* Ref.get(scratch.appended))[0]?.terminalReason).toEqual(
        Option.some({ _tag: "Failed", stage: "checkout" as const }),
      );
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // The salvage worked and the disk still will not let go of the directory —
  // the one path on the way *in* where a ref has been written and the run
  // stops anyway. The refusal is the only sentence it gets, so it is the
  // sentence that has to name the branch the commits are on: the warning that
  // would have named it comes after the removal that just failed.
  it.scoped("names the rescue branch when the salvage worked but the removal did not", () =>
    Effect.gen(function* () {
      const refusing = yield* Ref.make(true);
      const scratch = yield* world(
        { homeFetchBackFails: "! [rejected] (non-fast-forward)" },
        refusing,
      );
      const fs = yield* FileSystem.FileSystem;
      yield* keptCheckoutAt(scratch.plan.checkoutPath);

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
        expect(outcome.left._tag).toBe("GitError");
        expect(outcome.left.detail).toContain("could not be removed");
        expect(outcome.left.detail).toContain(`its commits are safe on '${STALE_RESCUE}'`);
        expect(outcome.left.detail).toContain(`rm -rf ${scratch.plan.checkoutPath}`);
      }

      // The rescue really was written, and it is named nowhere else: the
      // warning this path never reaches is the only other place it appears.
      expect(
        (yield* Ref.get(scratch.gitCalls)).flatMap((call) =>
          call._tag === "FetchBack" && call.onto !== BRANCH ? [call.onto] : [],
        ),
      ).toEqual([STALE_RESCUE]);
      expect(warningsIn(yield* Ref.get(scratch.events))).toEqual([]);

      // Nothing was cloned, the directory the disk would not delete is still
      // there, and the held lock still owes its `failed` row at this stage.
      expect((yield* Ref.get(scratch.gitCalls)).some((call) => call._tag === "Clone")).toBe(false);
      expect(yield* fs.readFileString(`${scratch.plan.checkoutPath}/${STALE}`)).toBe(
        "what the dead run did\n",
      );
      expect((yield* Ref.get(scratch.appended))[0]?.terminalReason).toEqual(
        Option.some({ _tag: "Failed", stage: "checkout" as const }),
      );
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // The wedge, round-tripped: a run whose commits landed and whose copy could
  // not be deleted used to leave the branch undispatchable until a human found
  // the directory and removed it. Two dispatches, one disk that stops refusing
  // in between, and nobody goes near the directory.
  it.scoped("re-dispatches a branch whose copy the dead run could not remove", () =>
    Effect.gen(function* () {
      const refusing = yield* Ref.make(true);
      const scratch = yield* world({}, refusing);
      const fs = yield* FileSystem.FileSystem;

      yield* Effect.gen(function* () {
        // The wedge: the fetch home goes through, the removal does not, and
        // T29's release says exactly that.
        yield* runInScope(
          scratch.plan,
          scratch.repoRoot,
          TEST_CREDENTIAL,
          TEST_FORGE_REPO,
          () => Effect.void,
        );
        expect(yield* fs.readFileString(`${scratch.plan.checkoutPath}/${CLONE_MARKER}`)).toBe(
          `${BRANCH}\n`,
        );
        expect(warningsIn(yield* Ref.get(scratch.events))[0]).toContain("could not be cleaned up");

        // The disk is writable again — the only thing that changes. No `rm
        // -rf`, no human anywhere near the checkout.
        yield* Ref.set(refusing, false);
        yield* runInScope(
          scratch.plan,
          scratch.repoRoot,
          TEST_CREDENTIAL,
          TEST_FORGE_REPO,
          () => Effect.void,
        );
      }).pipe(Effect.provide(scratch.layer));

      // The second dispatch salvaged over zero commits, cleared the path,
      // cloned into it, and finished — two runs, two `Completed` rows.
      expect(yield* fs.exists(scratch.plan.checkoutPath)).toBe(false);
      expect((yield* Ref.get(scratch.gitCalls)).map((call) => call._tag)).toEqual([
        "Clone",
        ...IDENTITY_TAGS,
        "RevParse",
        "FetchBack",
        ...CONTAINMENT_TAGS,
        "RevParse",
        "FetchBack",
        ...CONTAINMENT_TAGS,
        "Clone",
        // Each dispatch writes its own identity into its own clone: the value
        // belongs to the copy, so a second run of the same branch writes it
        // again rather than inheriting the first one's (T35).
        ...IDENTITY_TAGS,
        "RevParse",
        "FetchBack",
        ...CONTAINMENT_TAGS,
      ]);
      expect(
        (yield* Ref.get(scratch.appended)).map((row) => Option.getOrNull(row.terminalReason)),
      ).toEqual([{ _tag: "Completed" }, { _tag: "Completed" }]);
      const warnings = warningsIn(yield* Ref.get(scratch.events));
      expect(warnings).toHaveLength(2);
      expect(warnings[1]).toContain(`its commits are on '${BRANCH}'`);
      expect(warnings[1]).toContain(scratch.plan.checkoutPath);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // The name is read from the commits in the directory that is there, never
  // from the live dispatch — whose slug, path, and branch are identical in both
  // halves below. So two re-dispatches that each rescue leave two branches
  // rather than putting two runs' work under one ref (T29).
  it.scoped("names each rescue after the commits it found, not after the run doing it", () =>
    Effect.gen(function* () {
      const redispatchRescuesOnto = (tip: string) =>
        Effect.gen(function* () {
          const refusing = yield* Ref.make(true);
          const scratch = yield* world(
            { homeFetchBackFails: "! [rejected] (non-fast-forward)", cloneTip: tip },
            refusing,
          );
          const calls = yield* Effect.gen(function* () {
            // A run that rescued and could not remove its copy afterwards.
            yield* runInScope(
              scratch.plan,
              scratch.repoRoot,
              TEST_CREDENTIAL,
              TEST_FORGE_REPO,
              () => Effect.void,
            );
            const left = (yield* Ref.get(scratch.gitCalls)).length;
            yield* Ref.set(refusing, false);
            // The re-dispatch, which salvages that copy on the way in.
            yield* runInScope(
              scratch.plan,
              scratch.repoRoot,
              TEST_CREDENTIAL,
              TEST_FORGE_REPO,
              () => Effect.void,
            );
            return (yield* Ref.get(scratch.gitCalls)).slice(left);
          }).pipe(Effect.provide(scratch.layer));

          // Only what the re-dispatch did *before* it cloned: the release's own
          // rescue at the end names the copy this run made, which is a
          // different question with the same answer here.
          return calls
            .slice(
              0,
              calls.findIndex((call) => call._tag === "Clone"),
            )
            .flatMap((call) =>
              call._tag === "FetchBack" && call.onto !== BRANCH ? [call.onto] : [],
            );
        });

      expect(yield* redispatchRescuesOnto(CLONE_TIP)).toEqual([RESCUE]);
      expect(yield* redispatchRescuesOnto("9f8e7d6c000000000000000000000000000000ff")).toEqual([
        `${BRANCH}-from-run-9f8e7d6`,
      ]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
});

// `--hard-reset` (T101, D1): the host branch is moved to the base under the
// lock, by one compare-and-set against the tip the guards read, after the
// acquire's salvage and before the clone. A reset taken before the salvage
// would be undone by it: the salvage fast-forwards a kept copy's commits
// straight back onto the branch.
describe("a hard reset, inside the checkout's acquire", () => {
  const ORIGIN_TIP = "9999999999999999999999999999999999999999";
  const RESET: HardReset = {
    discardedTip: PLAN_TIP,
    discarding: 3,
    originTip: Option.some(ORIGIN_TIP),
  };
  const RESET_CALL = (repoRoot: string): GitCall => ({
    _tag: "UpdateRef",
    repo: repoRoot,
    ref: `refs/heads/${BRANCH}`,
    to: BASE_SHA,
    from: PLAN_TIP,
  });

  it.scoped("moves the branch to the base after the salvage and before the clone", () =>
    Effect.gen(function* () {
      const scratch = yield* world({}, undefined, RESET);
      yield* keptCheckoutAt(scratch.plan.checkoutPath);

      yield* runInScope(
        scratch.plan,
        scratch.repoRoot,
        TEST_CREDENTIAL,
        TEST_FORGE_REPO,
        () => Effect.void,
      ).pipe(Effect.provide(scratch.layer));

      const calls = yield* Ref.get(scratch.gitCalls);
      expect(calls.map((call) => call._tag)).toEqual([
        "RevParse",
        "FetchBack",
        ...CONTAINMENT_TAGS,
        "UpdateRef",
        "Clone",
        ...IDENTITY_TAGS,
        "RevParse",
        "FetchBack",
        ...CONTAINMENT_TAGS,
      ]);
      expect(calls[4]).toEqual(RESET_CALL(scratch.repoRoot));
      // And the audit line, with both discarded tips in full.
      expect(
        (yield* Ref.get(scratch.events)).filter((event) => event._tag === "BranchReset"),
      ).toEqual([
        {
          _tag: "BranchReset",
          branch: BRANCH,
          from: PLAN_TIP,
          originTip: Option.some(ORIGIN_TIP),
          to: BASE_SHA,
          discarding: 3,
        },
      ]);
      // And the row says what was thrown away (T104): the tip the guards
      // read, in full — the one durable pointer to it beside the reflog.
      expect((yield* Ref.get(scratch.appended))[0]?.discardedTip).toEqual(Option.some(PLAN_TIP));
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped("resets nothing and asks nothing more on a dispatch without the flag", () =>
    Effect.gen(function* () {
      const scratch = yield* world();
      yield* runInScope(
        scratch.plan,
        scratch.repoRoot,
        TEST_CREDENTIAL,
        TEST_FORGE_REPO,
        () => Effect.void,
      ).pipe(Effect.provide(scratch.layer));
      expect((yield* Ref.get(scratch.gitCalls)).map((call) => call._tag)).not.toContain(
        "UpdateRef",
      );
      expect((yield* Ref.get(scratch.events)).some((event) => event._tag === "BranchReset")).toBe(
        false,
      );
      expect((yield* Ref.get(scratch.appended))[0]?.discardedTip).toEqual(Option.none());
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // Nothing kept, so nothing of this dispatch's moved the branch: something
  // else did after the guards read it. Staged `checkout`, the row owed, and
  // nothing cloned.
  it.scoped("fails at stage checkout when the branch moved since the guards read it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const scratch = yield* world(
        { resetFails: "fatal: cannot lock ref: is at 0000 but expected 7777" },
        undefined,
        RESET,
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
      if (Either.isLeft(outcome)) {
        expect(outcome.left._tag).toBe("GitError");
        expect(outcome.left.detail).toContain(
          `'${BRANCH}' moved after the guards read it at ${PLAN_TIP.slice(0, 10)}, and something other than this dispatch moved it. Nothing was reset. Run the dispatch again`,
        );
        // git's own words follow the sentence.
        expect(outcome.left.detail).toContain("cannot lock ref");
      }
      expect((yield* Ref.get(scratch.appended))[0]?.terminalReason).toEqual(
        Option.some({ _tag: "Failed", stage: "checkout" as const }),
      );
      expect((yield* Ref.get(scratch.gitCalls)).map((call) => call._tag)).toEqual(["UpdateRef"]);
      expect(yield* fs.exists(scratch.plan.checkoutPath)).toBe(false);
      expect((yield* Ref.get(scratch.events)).some((event) => event._tag === "BranchReset")).toBe(
        false,
      );
      // A compare-and-set that refused discarded nothing, so the row names no
      // discard — though the plan still carries the tip it would have (T104).
      expect((yield* Ref.get(scratch.appended))[0]?.discardedTip).toEqual(Option.none());
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // The placement's own case: a kept copy whose salvage went home moved the
  // branch a moment ago, so the compare-and-set refuses — and the sentence
  // says the commits it moved are ones the printed count never included.
  it.scoped("says the salvage moved the branch when a kept copy's commits went home", () =>
    Effect.gen(function* () {
      const scratch = yield* world(
        { resetFails: "fatal: cannot lock ref: is at 3333 but expected 7777" },
        undefined,
        RESET,
      );
      yield* keptCheckoutAt(scratch.plan.checkoutPath);
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
        expect(outcome.left._tag).toBe("GitError");
        expect(outcome.left.detail).toContain(
          `an earlier run of '${BRANCH}' left its own copy of the repository, and it held commits: this dispatch just moved them onto '${BRANCH}', and the discard count it printed never included them. Nothing was reset and those commits are safe on the branch. If this dispatch asked you to confirm the discard, that question never asked about them. Run the dispatch again — it will count them, and ask about them, before it discards anything.`,
        );
        expect(outcome.left.detail).not.toContain("something other than this dispatch");
      }
      expect((yield* Ref.get(scratch.appended))[0]?.terminalReason).toEqual(
        Option.some({ _tag: "Failed", stage: "checkout" as const }),
      );
      // The salvage, then the refused move — and no clone.
      expect((yield* Ref.get(scratch.gitCalls)).map((call) => call._tag)).toEqual([
        "RevParse",
        "FetchBack",
        ...CONTAINMENT_TAGS,
        "UpdateRef",
      ]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
});

// Every destination a fetch-back was pointed at, in order.
const fetchedOnto = (calls: ReadonlyArray<GitCall>): ReadonlyArray<string> =>
  calls.flatMap((call) => (call._tag === "FetchBack" ? [call.onto] : []));

// T107: a branch the served repo cannot read is not a destination. `git
// fetch` creates an absent destination unconditionally, so the salvage asks
// before it fetches, and goes straight to the rescue — whose own containment
// read still authorizes the removal (T38).
describe("a salvage whose branch the served repo cannot read", () => {
  const UNREAD = "fatal: Needed a single revision";

  it.scoped("fetches nothing onto the branch, and rescues with the read's words", () =>
    Effect.gen(function* () {
      const scratch = yield* world({ branchUnread: UNREAD });
      yield* keptCheckoutAt(scratch.plan.checkoutPath);

      const salvaged = yield* salvage(scratch.plan, scratch.repoRoot).pipe(
        Effect.provide(scratch.layer),
      );

      expect(salvaged).toEqual({
        _tag: "Rescued",
        onto: STALE_RESCUE,
        because: { _tag: "BranchUnread", detail: UNREAD },
      });
      // The read, then the copy's tip, then the rescue and the read that says
      // it landed — and no fetch onto the branch, nor a question about it.
      expect(yield* Ref.get(scratch.gitCalls)).toEqual([
        branchRead(scratch.repoRoot),
        { _tag: "RevParse", repo: scratch.plan.checkoutPath, rev: `refs/heads/${BRANCH}` },
        {
          _tag: "FetchBack",
          from: repoUrl(scratch.plan.checkoutPath),
          into: scratch.repoRoot,
          branch: BRANCH,
          onto: STALE_RESCUE,
        },
        { _tag: "BranchContains", repo: scratch.repoRoot, branch: STALE_RESCUE, commit: PRE_TIP },
      ]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped("still says Refused when the branch was read and refused the fetch", () =>
    Effect.gen(function* () {
      const scratch = yield* world({ homeFetchBackFails: "! [rejected] (non-fast-forward)" });
      yield* keptCheckoutAt(scratch.plan.checkoutPath);

      const salvaged = yield* salvage(scratch.plan, scratch.repoRoot).pipe(
        Effect.provide(scratch.layer),
      );

      expect(salvaged).toEqual({
        _tag: "Rescued",
        onto: STALE_RESCUE,
        because: { _tag: "Refused" },
      });
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped("keeps the copy when the rescue answers success and moves nothing", () =>
    Effect.gen(function* () {
      const scratch = yield* world({ branchUnread: UNREAD, fetchBackLands: false });
      const fs = yield* FileSystem.FileSystem;
      yield* keptCheckoutAt(scratch.plan.checkoutPath);

      const salvaged = yield* salvage(scratch.plan, scratch.repoRoot).pipe(
        Effect.provide(scratch.layer),
      );

      expect(salvaged).toEqual({
        _tag: "Kept",
        why: {
          _tag: "RescueUnverified",
          home: { _tag: "Unread", detail: UNREAD },
          onto: STALE_RESCUE,
          tip: PRE_TIP,
        },
      });
      expect(fetchedOnto(yield* Ref.get(scratch.gitCalls))).toEqual([STALE_RESCUE]);
      expect(yield* fs.readFileString(`${scratch.plan.checkoutPath}/${STALE}`)).toBe(
        "what the dead run did\n",
      );
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped("refuses at stage checkout quoting the read and the rescue, and no branch fetch", () =>
    Effect.gen(function* () {
      const scratch = yield* world({
        branchUnread: UNREAD,
        fetchBackFails: "fatal: cannot lock ref",
      });
      const fs = yield* FileSystem.FileSystem;
      yield* keptCheckoutAt(scratch.plan.checkoutPath);

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
        const detail = outcome.left.detail;
        expect(detail).toContain(
          `onto a branch of the dead run's own, because '${BRANCH}' could not be read here — and that did not go through`,
        );
        expect(detail).toContain(`git said: ${UNREAD}`);
        expect(detail).toContain("git also said: fatal: cannot lock ref");
        expect(detail).not.toContain("neither went through");
        expect(detail).not.toContain(`onto '${BRANCH}', then`);
      }
      expect(fetchedOnto(yield* Ref.get(scratch.gitCalls))).toEqual([STALE_RESCUE]);
      expect(yield* fs.readFileString(`${scratch.plan.checkoutPath}/${STALE}`)).toBe(
        "what the dead run did\n",
      );
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped("says why at the acquire and at the release, and records only where", () =>
    Effect.gen(function* () {
      const scratch = yield* world({ branchUnread: UNREAD });
      const fs = yield* FileSystem.FileSystem;
      yield* keptCheckoutAt(scratch.plan.checkoutPath);

      yield* runInScope(
        scratch.plan,
        scratch.repoRoot,
        TEST_CREDENTIAL,
        TEST_FORGE_REPO,
        () => Effect.void,
      ).pipe(Effect.provide(scratch.layer));

      // Never onto the branch, at either end: the dead run's copy and this
      // run's each went to a rescue named after its own tip.
      expect(fetchedOnto(yield* Ref.get(scratch.gitCalls))).toEqual([STALE_RESCUE, RESCUE]);
      expect(yield* fs.exists(scratch.plan.checkoutPath)).toBe(false);

      const clause = `'${BRANCH}' could not be read here (${UNREAD}), so its commits were not sent there`;
      const warnings = warningsIn(yield* Ref.get(scratch.events));
      expect(warnings).toHaveLength(2);
      expect(warnings[0]).toContain(clause);
      expect(warnings[0]).toContain(`they are on '${STALE_RESCUE}'`);
      expect(warnings[1]).toContain(clause);
      expect(warnings[1]).toContain(`they are on '${RESCUE}'`);
      for (const warning of warnings) {
        expect(warning).not.toContain("would not go onto");
      }
      // The row records where the commits are, not why (the ledger is
      // unchanged by T107).
      expect((yield* Ref.get(scratch.appended))[0]?.rescuedOnto).toEqual(Option.some(RESCUE));
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
});

// T148: a branch checked out in a worktree of the repo is not a destination
// either — git will not fetch into it — so the salvage goes straight to the
// rescue and the release hands the dispatcher the steps, with the run's real
// values, from the checkout they already have open.
describe("a salvage whose branch is checked out in a worktree", () => {
  const HOLDER = "/home/dev/hae-wt";
  const holding = { worktrees: [{ path: HOLDER, branch: Option.some(BRANCH) }] };

  it.scoped("rescues at the release because it is checked out, fetching nothing onto it", () =>
    Effect.gen(function* () {
      const scratch = yield* world(holding);

      yield* runInScope(
        scratch.plan,
        scratch.repoRoot,
        TEST_CREDENTIAL,
        TEST_FORGE_REPO,
        () => Effect.void,
      ).pipe(Effect.provide(scratch.layer));

      expect(fetchedOnto(yield* Ref.get(scratch.gitCalls))).toEqual([RESCUE]);
      expect((yield* Ref.get(scratch.appended))[0]?.rescuedOnto).toEqual(Option.some(RESCUE));

      const warnings = warningsIn(yield* Ref.get(scratch.events));
      expect(warnings).toHaveLength(1);
      const warning = warnings[0] ?? "";
      expect(warning).toContain(
        `'${BRANCH}' is checked out at ${HOLDER}, and git does not fetch into a checked-out branch`,
      );
      expect(warning).toContain(`  git -C ${HOLDER} merge --ff-only ${RESCUE}\n`);
      expect(warning).toContain(`  git -C ${HOLDER} push origin ${BRANCH}\n`);
      expect(warning).toContain(`--resume ${BRANCH}`);
      expect(warning).not.toContain("would not go onto");
      expect(warning).not.toMatch(/<[a-z]+>/);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped("answers Rescued because CheckedOut, with no fetch onto the branch", () =>
    Effect.gen(function* () {
      const scratch = yield* world(holding);
      yield* keptCheckoutAt(scratch.plan.checkoutPath);

      const salvaged = yield* salvage(scratch.plan, scratch.repoRoot).pipe(
        Effect.provide(scratch.layer),
      );

      expect(salvaged).toEqual({
        _tag: "Rescued",
        onto: STALE_RESCUE,
        because: { _tag: "CheckedOut", path: HOLDER },
      });
      // The read, the copy's tip, the question whether the checked-out branch
      // already holds it, then the rescue and the read that says it landed.
      expect(yield* Ref.get(scratch.gitCalls)).toEqual([
        branchRead(scratch.repoRoot),
        { _tag: "RevParse", repo: scratch.plan.checkoutPath, rev: `refs/heads/${BRANCH}` },
        { _tag: "BranchContains", repo: scratch.repoRoot, branch: BRANCH, commit: PRE_TIP },
        {
          _tag: "FetchBack",
          from: repoUrl(scratch.plan.checkoutPath),
          into: scratch.repoRoot,
          branch: BRANCH,
          onto: STALE_RESCUE,
        },
        { _tag: "BranchContains", repo: scratch.repoRoot, branch: STALE_RESCUE, commit: PRE_TIP },
      ]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped("mints nothing when the checked-out branch already holds the commits", () =>
    Effect.gen(function* () {
      const scratch = yield* world({ ...holding, branchAlreadyContains: true });
      yield* keptCheckoutAt(scratch.plan.checkoutPath);

      const salvaged = yield* salvage(scratch.plan, scratch.repoRoot).pipe(
        Effect.provide(scratch.layer),
      );

      expect(salvaged).toEqual({ _tag: "WentHome" });
      expect(fetchedOnto(yield* Ref.get(scratch.gitCalls))).toEqual([]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped("salvages as before when the worktree lookup fails", () =>
    Effect.gen(function* () {
      const scratch = yield* world({
        worktreesFails: "fatal: not a git repository",
        homeFetchBackFails: "! [rejected] (non-fast-forward)",
      });
      yield* keptCheckoutAt(scratch.plan.checkoutPath);

      const salvaged = yield* salvage(scratch.plan, scratch.repoRoot).pipe(
        Effect.provide(scratch.layer),
      );

      expect(salvaged).toEqual({
        _tag: "Rescued",
        onto: STALE_RESCUE,
        because: { _tag: "Refused" },
      });
      expect(fetchedOnto(yield* Ref.get(scratch.gitCalls))).toEqual([BRANCH, STALE_RESCUE]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped("says the branch is checked out when the rescue cannot be written either", () =>
    Effect.gen(function* () {
      const scratch = yield* world({ ...holding, fetchBackFails: "fatal: cannot lock ref" });
      yield* keptCheckoutAt(scratch.plan.checkoutPath);

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
        const detail = outcome.left.detail;
        expect(detail).toContain(
          `onto a branch of the dead run's own, because '${BRANCH}' is checked out at ${HOLDER}`,
        );
        expect(detail).toContain("git also said: fatal: cannot lock ref");
        expect(detail).not.toContain("neither went through");
      }
      expect(fetchedOnto(yield* Ref.get(scratch.gitCalls))).toEqual([STALE_RESCUE]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
});
