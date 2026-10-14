// `--dry-run` as a layer swap (T15, SPEC §11 design rule 5). Each recording
// layer is asserted the only way a rehearsal can be: what it answered, what it
// said it would have done, and — for the layers built over a live one — that
// its reads still went all the way to the thing that knows.
//
// The event-sequence-shape case, which is design rule 5's own enforcement,
// lives at the bottom: one world, two stacks, the same dispatch.
import { describe, expect, it } from "@effect/vitest";
import { FileSystem, Terminal } from "@effect/platform";
import type { PlatformError } from "@effect/platform/Error";
import { NodeContext, NodeFileSystem, NodePath } from "@effect/platform-node";
import { DateTime, Effect, Either, Layer, Option, Ref, Schema, type Scope } from "effect";
import { AgentCli, AgentCliLive, agentPassCommand } from "../src/agent/agent-cli.ts";
import {
  appCompositionFor,
  appDryRunLiveFor,
  appLiveFor,
  DRY_RUN_FLAG,
  isModifiersOnly,
} from "../src/app.ts";
import { promptSourceLiveFor } from "../src/agent/prompt-source.ts";
import { BessemerConfig, type BessemerConfigShape, defaultConfig } from "../src/config/config.ts";
import { packagePathspec } from "../src/config/paths.ts";
import { dispatchCli } from "../src/dispatch/command.ts";
import { dispatch, type DispatchRequest } from "../src/dispatch/dispatch.ts";
import { APPROVED_OUTCOME } from "../src/dispatch/feature.ts";
import { branchBehindItsRemote, GuardRefused } from "../src/dispatch/guards.ts";
import { land } from "../src/dispatch/land.ts";
import { renderPlan } from "../src/dispatch/render.ts";
import {
  checkoutPathFor,
  featureDispatch,
  type DispatchPlan,
  feedbackIn,
  lockPathFor,
  planFor,
  slugFor,
  specDispatch,
  statusIndexPathFor,
} from "../src/dispatch/plan.ts";
import { GitRecordingLive, recordingGit } from "../src/dry-run/git.ts";
import { LedgerRecordingLive } from "../src/dry-run/ledger.ts";
import { AgentCliRecordingLive } from "../src/dry-run/agent-cli.ts";
import { ForgeRecordingLive, recordingForge, RECORDED_PR } from "../src/dry-run/forge.ts";
import { IssueStoreRecordingLive, recordingIssueStore } from "../src/dry-run/issue-store.ts";
import { NotifierRecordingLive, recordingNotifier } from "../src/dry-run/notifier.ts";
import { PromptRecordingLive } from "../src/dry-run/prompt.ts";
import { recordingRunLock, RunLockRecordingLive } from "../src/dry-run/run-lock.ts";
import { recordingSandbox, SandboxRecordingLive } from "../src/dry-run/sandbox.ts";
import { Forge, ForgeLive } from "../src/forge/forge.ts";
import { Git, GitLive } from "../src/git/git.ts";
import { IssueStore, IssueStoreLive } from "../src/issues/issue-store.ts";
import { LEDGER_FILENAME, Ledger, LedgerLive } from "../src/ledger/ledger.ts";
import { CURRENT_SCHEMA_VERSION, type IssueOutcome, RunRecord } from "../src/ledger/record.ts";
import { RepoUrl } from "../src/git/repo-url.ts";
import { Reporter, type ReporterEvent, type ReporterShape } from "../src/reporter.ts";
import { RunLockLive } from "../src/lock/run-lock.ts";
import { NotifierLive } from "../src/notify/notifier.ts";
import { Sandbox, SandboxLive } from "../src/sandbox/sandbox.ts";
import { SPEC_TARGET, type SandboxSpec } from "../src/sandbox/spec.ts";
import { FEEDBACK_CLOSE, FEEDBACK_OPEN, TASK_CLOSE, TASK_OPEN } from "../src/agent/prompt.ts";
import { TEST_CREDENTIAL } from "./support/credential.ts";
import { TEST_FORGE_REPO } from "./support/repo-slug.ts";
import { fakeForge, type ForgeCall, viewedPullRequest } from "./support/forge-fake.ts";
import { type ScriptedResult, scriptedExecutor } from "./support/exec-fake.ts";
import { answersWith, streamJson } from "./support/stream-json.ts";
import { fakeGit, type GitCall } from "./support/git-fake.ts";
import {
  fakeIssue,
  fakeIssueStore,
  type FakeIssueStoreOptions,
  type IssueStoreCall,
} from "./support/issue-store-fake.ts";
import { PLAN_TIP } from "./support/plan.ts";
import { scriptedPrompt } from "./support/prompt-fake.ts";

const REPO_ROOT = "/srv/hae";
const BRANCH = "bessemer-t15";
const CONTAINER = `bessemer-${BRANCH}`;
const CHECKOUT = `/srv/bessemer/checkouts/${BRANCH}`;
// The feature folder a rehearsal would have marked issues under (T77).
const FOLDER = "docs/wayfinder/effect-agentbox";

// `image` and `base` have no code default (T40), so this suite declares them as
// a repo's config.toml would. `origin/master` is the ref the git script below
// answers to. No `runtimeRoot`: every case below is a scratch root of its own
// and supplies it, so the one key that is a fact about the served repo is not
// answered here (T57).
const hostConfig: Omit<BessemerConfigShape, "runtimeRoot"> = {
  ...defaultConfig,
  image: "test-bessemer",
  base: "origin/master",
};

const SPEC_PATH = `${REPO_ROOT}/tasks/T15.md`;

const plan = planFor({
  ...specDispatch(SPEC_PATH),
  branch: BRANCH,
  baseRef: "origin/master",
  baseSha: "1111111111111111111111111111111111111111",
  mergeBaseSha: "2222222222222222222222222222222222222222",
  tipSha: PLAN_TIP,
  runtimeRoot: "/srv/bessemer",
  startedAt: DateTime.unsafeMake("2026-01-01T00:00:00.000Z"),
});

// Hoisted rather than called inline, which is how the other five suites that
// decode a `RepoUrl` do it (`checkout.test.ts`, `land.test.ts`, `git.test.ts`).
// The sync form is deliberate in a test — these decode literals declared a few
// lines up, so a failure is a broken fixture and throwing says so at the point
// it broke. Called inside an `Effect.gen` it also draws `schemaSyncInEffect`,
// which is a suggestion the gate prints and does not fail on; at module scope
// the position matches the intent and the suggestion has nothing to say.
const repoUrl = Schema.decodeSync(RepoUrl);
const encodeRow = Schema.encodeSync(RunRecord);

const sandboxSpec: SandboxSpec = {
  name: CONTAINER,
  image: "hae-agentbox",
  repoRoot: REPO_ROOT,
  workspace: repoUrl(CHECKOUT),
  mounts: [{ source: SPEC_PATH, target: SPEC_TARGET }],
  env: [],
  envFile: Option.none(),
  credential: TEST_CREDENTIAL,
  limits: { pids: 2048, memory: "8g" },
  capabilities: ["CHOWN"],
};

// A row the branch already has — the ledger read a dry run depends on, and
// the row a dry run would append if it wrote one.
const recordedRow: RunRecord = {
  schemaVersion: CURRENT_SCHEMA_VERSION,
  runId: Option.some(`${BRANCH}-1786000000000`),
  branch: BRANCH,
  identity: plan.identity,
  startedAt: Option.some(DateTime.unsafeMake("2026-08-19T20:00:00.000Z")),
  endedAt: DateTime.unsafeMake("2026-08-19T20:41:00.000Z"),
  terminalReason: Option.some({ _tag: "Completed" }),
  outcome: Option.some("approved"),
  base: { ref: "origin/master", sha: Option.some(plan.baseSha) },
  mergeBaseSha: Option.some(plan.mergeBaseSha),
  pr: Option.none(),
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
};

// The three observables a recording layer has: every event it emitted, and the
// recorded intents on their own — which is what a dispatcher reads off a dry
// run.
interface Recording {
  readonly events: Ref.Ref<ReadonlyArray<ReporterEvent>>;
  readonly reporter: ReporterShape;
}

const recording = (): Effect.Effect<Recording> =>
  Effect.map(Ref.make<ReadonlyArray<ReporterEvent>>([]), (events) => ({
    events,
    reporter: { emit: (event) => Ref.update(events, (current) => [...current, event]) },
  }));

const intents = (events: ReadonlyArray<ReporterEvent>): ReadonlyArray<string> =>
  events.flatMap((event) => (event._tag === "MutationRecorded" ? [event.detail] : []));

const tags = (events: ReadonlyArray<ReporterEvent>): ReadonlyArray<string> =>
  events.map((event) => event._tag);

describe("the recording sandbox", () => {
  // The recording layer implements the whole tag (T111), so `build` records
  // too — and, like every operation here, spawns nothing: the layer is built
  // over a `Reporter` alone and has no executor to spawn with. Nothing of the
  // spec's `onOutput` is called, because there was no build to narrate.
  it.effect("records an image build and runs nothing", () =>
    Effect.gen(function* () {
      const seen = yield* recording();
      const narrated = yield* Ref.make<ReadonlyArray<string>>([]);
      yield* Effect.flatMap(Sandbox, (sandbox) =>
        sandbox.build({
          tag: "hae-agentbox",
          context: `${REPO_ROOT}/.bessemer/image`,
          dockerfile: `${REPO_ROOT}/.bessemer/image/Dockerfile`,
          buildArgs: { AGENT_UID: "501", AGENT_GID: "20" },
          labels: {},
          onOutput: (line) => Ref.update(narrated, (current) => [...current, line]),
        }),
      ).pipe(
        Effect.provide(Layer.provide(SandboxRecordingLive, Layer.succeed(Reporter, seen.reporter))),
      );

      expect(intents(yield* Ref.get(seen.events))).toEqual([
        `build the image 'hae-agentbox' from ${REPO_ROOT}/.bessemer/image/Dockerfile in ${REPO_ROOT}/.bessemer/image`,
      ]);
      expect(yield* Ref.get(narrated)).toEqual([]);
    }),
  );

  it.scoped("records the start and answers with the container the plan named", () =>
    Effect.gen(function* () {
      const seen = yield* recording();
      const handle = yield* recordingSandbox(seen.reporter)
        .run(sandboxSpec)
        .pipe(Effect.provideService(Reporter, seen.reporter));

      // Addressed by the name the plan derived, because there is no id: a
      // daemon that never ran this container printed nothing to read one from.
      expect(handle).toEqual({ name: CONTAINER, id: CONTAINER });
      // The argv the live layer would have handed docker, rendered by the same
      // function — the caps, the mounts, and the credential *by name*.
      const [start] = intents(yield* Ref.get(seen.events));
      expect(start).toContain(`start the sandbox '${CONTAINER}' from image 'hae-agentbox'`);
      expect(start).toContain("--cap-drop ALL");
      expect(start).toContain(`--name ${CONTAINER}`);
      // The pair SPEC §11's ordering assertion reads, in the place the live
      // layer emits it: the scope acquired something, even though dockerd
      // never heard about it.
      expect(tags(yield* Ref.get(seen.events))).toEqual(["MutationRecorded", "ResourceAcquired"]);
    }),
  );

  // The env file a served repo declares (T61) reaches the rehearsal through
  // the same renderer, so the line a dispatcher reads names the file the real
  // run would have handed docker — the path, never a word of its contents,
  // because nothing here opened it.
  it.scoped("names the declared env file in the line it records, and reads nothing of it", () =>
    Effect.gen(function* () {
      const seen = yield* recording();
      const declared = `${REPO_ROOT}/.bessemer/env.sandbox`;
      yield* recordingSandbox(seen.reporter)
        .run({ ...sandboxSpec, envFile: Option.some(declared) })
        .pipe(Effect.provideService(Reporter, seen.reporter));

      const words = (intents(yield* Ref.get(seen.events))[0] ?? "").split(" ");
      expect(words[words.indexOf("--env-file") + 1]).toBe(declared);
      // The path is the whole of it: this file does not exist on the host
      // running the suite, and the rehearsal still renders the line — because
      // what docker is told to open is never opened here.
      expect(words.at(-1)).toBe("hae-agentbox");
    }),
  );

  it.effect("releases the recorded container when the scope closes", () =>
    Effect.gen(function* () {
      const seen = yield* recording();
      yield* Effect.scoped(recordingSandbox(seen.reporter).run(sandboxSpec)).pipe(
        Effect.provideService(Reporter, seen.reporter),
      );

      expect(tags(yield* Ref.get(seen.events))).toEqual([
        "MutationRecorded",
        "ResourceAcquired",
        "MutationRecorded",
        "ResourceReleased",
      ]);
      expect(intents(yield* Ref.get(seen.events))[1]).toBe(`remove the sandbox '${CONTAINER}'`);
    }),
  );

  it.effect("records the exec every pass and the setup hook run through", () =>
    Effect.gen(function* () {
      const seen = yield* recording();
      const sandbox = recordingSandbox(seen.reporter);
      yield* sandbox.exec({ name: CONTAINER, id: CONTAINER }, ["claude", "-p"], {
        stdin: "the whole prompt",
        onOutput: () => Effect.void,
        onStderr: () => Effect.void,
      });
      yield* sandbox.remove({ name: CONTAINER, id: CONTAINER });

      // The command, not its stdin: the pass that assembled that prompt logged
      // it verbatim a moment earlier, and no agent ran either way.
      expect(intents(yield* Ref.get(seen.events))).toEqual([
        `run 'claude -p' in the sandbox '${CONTAINER}'`,
        `remove the sandbox '${CONTAINER}'`,
      ]);
    }),
  );

  it.effect("emits nothing a real dispatch would not, beyond the recorded intent", () =>
    Effect.gen(function* () {
      const seen = yield* recording();
      yield* Effect.scoped(recordingSandbox(seen.reporter).run(sandboxSpec)).pipe(
        Effect.provideService(Reporter, seen.reporter),
      );
      const events = yield* Ref.get(seen.events);
      expect(
        events.filter((event) => event._tag !== "MutationRecorded").map((event) => event),
      ).toEqual([
        { _tag: "ResourceAcquired", resource: "sandbox" },
        { _tag: "ResourceReleased", resource: "sandbox" },
      ]);
    }),
  );
});

// The layer stands behind the same tag the live one does, which is the whole
// mechanism: a swap is a different layer, never a different call site.
describe("the recording sandbox layer", () => {
  it.effect("stands behind the `Sandbox` tag", () =>
    Effect.gen(function* () {
      const seen = yield* recording();
      const handle = yield* Effect.scoped(
        Effect.flatMap(Sandbox, (sandbox) => sandbox.run(sandboxSpec)),
      ).pipe(
        Effect.provide(
          Layer.provideMerge(SandboxRecordingLive, Layer.succeed(Reporter, seen.reporter)),
        ),
      );

      expect(handle).toEqual({ name: CONTAINER, id: CONTAINER });
      expect(intents(yield* Ref.get(seen.events))).toHaveLength(2);
    }),
  );
});

describe("the recording git", () => {
  // The four writes, and the whole of what a rehearsal holds back: they never
  // reach the layer underneath, so nothing this run does can move a ref, make
  // a directory, or change a config.
  it.effect("records the clone, the fetch-back, the push, and the identity write", () =>
    Effect.gen(function* () {
      const seen = yield* recording();
      const calls = yield* Ref.make<ReadonlyArray<GitCall>>([]);
      const live = yield* Git.pipe(Effect.provide(fakeGit(calls)));
      const git = recordingGit(live, seen.reporter);
      const source = repoUrl(REPO_ROOT);

      yield* git.clone({ source, branch: BRANCH, into: CHECKOUT });
      yield* git.setConfig({ repo: CHECKOUT, key: "user.name", value: "Ada Lovelace" });
      yield* git.fetchBack({
        from: repoUrl(CHECKOUT),
        into: REPO_ROOT,
        branch: BRANCH,
        onto: BRANCH,
      });
      yield* git.push({ from: REPO_ROOT, branch: BRANCH });

      expect(yield* Ref.get(calls)).toEqual([]);
      expect(intents(yield* Ref.get(seen.events))).toEqual([
        `clone '${BRANCH}' from ${REPO_ROOT} into ${CHECKOUT}`,
        `set user.name to 'Ada Lovelace' in ${CHECKOUT}`,
        `fetch refs/heads/${BRANCH} from ${CHECKOUT} onto refs/heads/${BRANCH} in ${REPO_ROOT}`,
        `push refs/heads/${BRANCH} from ${REPO_ROOT} to origin`,
      ]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // `--dry-run --hard-reset` (T101): the compare-and-set that moves the branch
  // and the leased push are both recorded, and neither reaches the layer
  // underneath — the spread would otherwise hand the live `updateRef` through
  // and a rehearsal would reset the branch for real.
  it.effect("records the hard reset and the leased push, and makes neither", () =>
    Effect.gen(function* () {
      const seen = yield* recording();
      const calls = yield* Ref.make<ReadonlyArray<GitCall>>([]);
      const live = yield* Git.pipe(Effect.provide(fakeGit(calls)));
      const git = recordingGit(live, seen.reporter);
      const from = "4444444444444444444444444444444444444444";
      const to = "1111111111111111111111111111111111111111";
      const origin = "5555555555555555555555555555555555555555";

      expect(git.updateRef).not.toBe(live.updateRef);
      yield* git.updateRef({ repo: REPO_ROOT, ref: `refs/heads/${BRANCH}`, to, from });
      yield* git.push({ from: REPO_ROOT, branch: BRANCH, lease: { expect: Option.some(origin) } });
      yield* git.push({ from: REPO_ROOT, branch: BRANCH, lease: { expect: Option.none() } });

      expect(yield* Ref.get(calls)).toEqual([]);
      expect(intents(yield* Ref.get(seen.events))).toEqual([
        `move refs/heads/${BRANCH} from ${from} to ${to} in ${REPO_ROOT}`,
        `push refs/heads/${BRANCH} from ${REPO_ROOT} to origin with --force-with-lease=refs/heads/${BRANCH}:${origin}`,
        `push refs/heads/${BRANCH} from ${REPO_ROOT} to origin with --force-with-lease=refs/heads/${BRANCH}:`,
      ]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // And the other half of "recording, not blindly no-op": every read goes
  // through to the layer underneath and comes back with its answer, which is
  // what keeps the `--base` chain resolving and every guard failing for real.
  it.effect("asks the live layer every question a run asks", () =>
    Effect.gen(function* () {
      const seen = yield* recording();
      const calls = yield* Ref.make<ReadonlyArray<GitCall>>([]);
      const live = yield* Git.pipe(
        Effect.provide(
          fakeGit(calls, {
            config: { "user.name": "Ada Lovelace" },
            counts: { boundary: 3 },
            originHead: "origin/trunk",
          }),
        ),
      );
      const git = recordingGit(live, seen.reporter);

      expect(yield* git.revParse({ repo: REPO_ROOT, rev: `refs/heads/${BRANCH}` })).toBe(
        "3333333333333333333333333333333333333333",
      );
      expect(yield* git.readConfig({ repo: REPO_ROOT, key: "user.name" })).toEqual(
        Option.some("Ada Lovelace"),
      );
      expect(yield* git.countCommits({ repo: REPO_ROOT, from: "boundary", to: BRANCH })).toBe(3);
      expect(yield* git.branchContains({ repo: REPO_ROOT, branch: BRANCH, commit: "beef" })).toBe(
        false,
      );
      expect(yield* git.originHead({ repo: REPO_ROOT })).toEqual(Option.some("origin/trunk"));

      expect((yield* Ref.get(calls)).map((call) => call._tag)).toEqual([
        "RevParse",
        "ReadConfig",
        "CountCommits",
        "BranchContains",
        "OriginHead",
      ]);
      // A read is not an intent: nothing here is something a dry run would
      // have done, so nothing here is recorded.
      expect(intents(yield* Ref.get(seen.events))).toEqual([]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // **The one write this layer does not hold back** (T70). A fetch mutates
  // remote-tracking refs but holds nothing and has no release, and a rehearsal
  // that resolved its base against a stale `origin/master` would print a plan
  // the run would not use. So the recording layer does not name `fetch` at
  // all: the spread hands the live function through, and this is that fact
  // pinned as an identity — recording it later is a red line here rather than
  // a plan a dispatcher cannot trust.
  it.effect("hands the fetch through to the live layer, function and all", () =>
    Effect.gen(function* () {
      const seen = yield* recording();
      const calls = yield* Ref.make<ReadonlyArray<GitCall>>([]);
      const live = yield* Git.pipe(Effect.provide(fakeGit(calls)));
      const git = recordingGit(live, seen.reporter);

      expect(git.fetch).toBe(live.fetch);

      yield* git.fetch({ repo: REPO_ROOT, remote: "origin" });
      expect(yield* Ref.get(calls)).toEqual([{ _tag: "Fetch", repo: REPO_ROOT, remote: "origin" }]);
      // And it is not an intent either: a rehearsal that recorded this would
      // be describing a fetch it had not made.
      expect(intents(yield* Ref.get(seen.events))).toEqual([]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
});

// The write half of `IssueStore` (T77), and the one rehearsal invariant that
// is a *function identity* rather than a behaviour: this layer is built over a
// store that carries its own `GitLive`, so the `Git` swap in `appDryRunLiveFor`
// does not reach inside it. A `markLanded` this layer forgot to override would
// write objects and move a ref in a rehearsal, and every event assertion above
// would still pass.
describe("the recording issue store", () => {
  it.effect("records the status commit and never hands it to the live store", () =>
    Effect.gen(function* () {
      const seen = yield* recording();
      const calls = yield* Ref.make<ReadonlyArray<IssueStoreCall>>([]);
      const live = yield* IssueStore.pipe(Effect.provide(fakeIssueStore(calls)));
      const store = recordingIssueStore(live, seen.reporter);

      // The pin, and the mirror of T70's `git.fetch === live.fetch` above:
      // this one must **not** be the live function.
      expect(store.markLanded).not.toBe(live.markLanded);
      // And the reads are, for the reason they are on every other recording
      // layer — a rehearsal reads the set a live run reads.
      expect(store.issues).toBe(live.issues);
      expect(store.landedElsewhere).toBe(live.landedElsewhere);

      const marked = yield* store.markLanded({
        repo: REPO_ROOT,
        branch: BRANCH,
        folder: FOLDER,
        stems: ["T70-the-first", "T71-the-second"],
        index: statusIndexPathFor("/runtime", slugFor(BRANCH)),
      });

      // Nothing reached the store underneath, and the answer is no commit —
      // because there is none.
      expect(marked).toEqual(Option.none());
      expect(yield* Ref.get(calls)).toEqual([]);
      expect(intents(yield* Ref.get(seen.events))).toEqual([
        `mark T70-the-first T71-the-second Done on '${BRANCH}'`,
      ]);
    }),
  );
});

describe("the recording run lock", () => {
  it.effect("records the claim and the release, and writes no PID file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const runtimeRoot = yield* fs.makeTempDirectory();
      const seen = yield* recording();
      const lock = recordingRunLock(runtimeRoot, 4242, seen.reporter, fs);

      const claim = yield* Effect.scoped(lock.acquire(BRANCH));

      // The claim answers with the path it would have taken and this
      // process's pid, so everything downstream — the log's position, a
      // release that checks the lock is still its own — sees the shape a live
      // claim has.
      expect(claim).toEqual({
        path: lockPathFor(runtimeRoot, BRANCH),
        pid: 4242,
        reclaimed: false,
      });
      // And the runtime root is exactly as it was: `RunLockLive` creates the
      // locks directory on its way to the claim, and a rehearsal creates
      // neither.
      expect(yield* fs.readDirectory(runtimeRoot)).toEqual([]);
      expect(intents(yield* Ref.get(seen.events))).toEqual([
        `claim the run lock at ${lockPathFor(runtimeRoot, BRANCH)} for pid 4242`,
        `release the run lock at ${lockPathFor(runtimeRoot, BRANCH)}`,
      ]);
      // The first resource in and the last out, reported as the live layer
      // reports it — SPEC §11's ordering assertion reads exactly this pair.
      expect(
        (yield* Ref.get(seen.events)).filter((event) => event._tag !== "MutationRecorded"),
      ).toEqual([
        { _tag: "ResourceAcquired", resource: "lock" },
        { _tag: "ResourceReleased", resource: "lock" },
      ]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
});

describe("the recording run lock, against a lock that is already there", () => {
  // bash's dry run runs the same in-flight check a real dispatch runs
  // (`run.sh:2285`), and so does this: the read half of an acquisition is a
  // question the lock file answers, and refusing here is also what keeps a
  // rehearsal from walking into a live run's checkout and clearing it.
  it.effect("refuses a branch a live run owns", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const runtimeRoot = yield* fs.makeTempDirectory();
      const file = lockPathFor(runtimeRoot, BRANCH);
      yield* fs.makeDirectory(`${runtimeRoot}/locks`, { recursive: true });
      yield* fs.writeFileString(file, `${process.pid}\n`);

      const seen = yield* recording();
      const refusal = yield* Effect.flip(
        Effect.scoped(recordingRunLock(runtimeRoot, 4242, seen.reporter, fs).acquire(BRANCH)),
      );

      expect(refusal._tag).toBe("LockHeld");
      expect(refusal.detail).toContain(`is already working '${BRANCH}'`);
      // Refused, so nothing was recorded and nothing was acquired: a rehearsal
      // that would have been refused says so and stops, exactly as the run it
      // is rehearsing does.
      expect(yield* Ref.get(seen.events)).toEqual([]);
      expect(yield* fs.readFileString(file)).toBe(`${process.pid}\n`);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.effect("records the eviction a stale lock would have got, and evicts nothing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const runtimeRoot = yield* fs.makeTempDirectory();
      const file = lockPathFor(runtimeRoot, BRANCH);
      yield* fs.makeDirectory(`${runtimeRoot}/locks`, { recursive: true });
      // Above Linux's pid_max, so `kill -0` can only answer "no such process".
      yield* fs.writeFileString(file, "2147483647\n");

      const seen = yield* recording();
      const claim = yield* Effect.scoped(
        recordingRunLock(runtimeRoot, 4242, seen.reporter, fs).acquire(BRANCH),
      );

      // `reclaimed` stays false because nothing was reclaimed — the corpse is
      // still on disk for the next real dispatch to take.
      expect(claim.reclaimed).toBe(false);
      expect(yield* fs.readFileString(file)).toBe("2147483647\n");
      expect(intents(yield* Ref.get(seen.events))[0]).toBe(
        `evict the stale lock at ${file} — pid 2147483647 is not alive`,
      );
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
});

describe("the recording ledger", () => {
  it.effect("records the row, reads the ledger for real, and writes nothing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const runtimeRoot = yield* fs.makeTempDirectory();
      const file = `${runtimeRoot}/${LEDGER_FILENAME}`;
      // A ledger the dispatcher already has — the `--base` chain's first link
      // lives in it, and a dry run must still resolve the same base a real
      // dispatch would.
      const before = `${JSON.stringify(encodeRow(recordedRow))}\n`;
      yield* fs.writeFileString(file, before);

      const seen = yield* recording();
      const ledger = yield* Ledger.pipe(
        Effect.provide(
          LedgerRecordingLive.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(BessemerConfig, { ...hostConfig, runtimeRoot }),
                Layer.succeed(Reporter, seen.reporter),
                NodeContext.layer,
              ),
            ),
          ),
        ),
      );

      expect(yield* ledger.lastBaseForBranch(BRANCH)).toEqual(Option.some("origin/master"));
      expect(yield* ledger.recent(10)).toHaveLength(1);
      yield* ledger.append(recordedRow);

      // Byte-identical, which is the assertion the host-only check makes by
      // hand after a real dry run.
      expect(yield* fs.readFileString(file)).toBe(before);
      expect(intents(yield* Ref.get(seen.events))).toEqual([
        `append the terminal row for '${BRANCH}' to the ledger: completed, approved`,
      ]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
});

describe("the recording forge", () => {
  it.effect("views for real and records the create and the edit", () =>
    Effect.gen(function* () {
      const seen = yield* recording();
      const calls = yield* Ref.make<ReadonlyArray<ForgeCall>>([]);
      const live = yield* Forge.pipe(
        Effect.provide(fakeForge(calls, { existing: viewedPullRequest })),
      );
      const forge = recordingForge(live, seen.reporter);

      // The probe that decides create-vs-update still answers, which is the
      // half of `run.sh:1714-1722` a rehearsal has to keep.
      expect(yield* forge.prView({ repo: TEST_FORGE_REPO, branch: BRANCH })).toEqual(
        Option.some(viewedPullRequest),
      );
      expect(
        yield* forge.prCreate({
          repo: TEST_FORGE_REPO,
          branch: BRANCH,
          base: "origin/master",
          title: "t",
          body: "b",
        }),
      ).toEqual(RECORDED_PR);
      yield* forge.prEdit({ repo: TEST_FORGE_REPO, branch: BRANCH, body: "b" });

      // Only the view crossed the seam.
      expect((yield* Ref.get(calls)).map((call) => call._tag)).toEqual(["View"]);
      expect(intents(yield* Ref.get(seen.events))).toEqual([
        `open a draft PR for '${BRANCH}' into 'master', titled 't'`,
        `replace the body of the PR for '${BRANCH}'`,
      ]);
    }),
  );
});

describe("the recording notifier", () => {
  it.effect("records what it would have said, and wakes nobody", () =>
    Effect.gen(function* () {
      const seen = yield* recording();
      yield* recordingNotifier(seen.reporter).notify({
        title: `bessemer: ${BRANCH}`,
        body: "approved — PR: https://example.test/pull/1",
      });

      expect(intents(yield* Ref.get(seen.events))).toEqual([
        `notify: bessemer: ${BRANCH} — approved — PR: https://example.test/pull/1`,
      ]);
    }),
  );
});

// The pass is assembled for real and the exec that would have started an agent
// is the only thing held back — so the one question a dispatcher runs a
// rehearsal for, *what would this agent have been told*, is answered with the
// bytes rather than with a description of them.
const passLayer = (seen: Recording) =>
  AgentCliRecordingLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(BessemerConfig, { ...hostConfig, runtimeRoot: "/srv/bessemer" }),
        Layer.succeed(Reporter, seen.reporter),
        // The real chain over the served repo (T59), which takes no config at
        // all: nothing sits under `${REPO_ROOT}/.bessemer/prompts/`, so the
        // package default wins and the rehearsal logs the bytes a live run
        // would have been handed.
        promptSourceLiveFor(REPO_ROOT).pipe(Layer.provide(NodeContext.layer)),
      ),
    ),
  );

describe("the recording agent CLI", () => {
  it.effect("logs the prompt verbatim and records the pass instead of running it", () =>
    Effect.gen(function* () {
      const seen = yield* recording();
      yield* Effect.flatMap(AgentCli, (agent) =>
        agent.implement({ name: CONTAINER, id: CONTAINER }, plan, Option.none(), Option.none()),
      ).pipe(
        Effect.provide(Layer.provideMerge(passLayer(seen), Layer.succeed(Reporter, seen.reporter))),
      );

      const events = yield* Ref.get(seen.events);
      expect(tags(events)).toEqual(["PromptAssembled", "MutationRecorded", "AgentPassFinished"]);
      const [assembled] = events;
      // The real template, with the real dispatcher's message under it: the
      // branch this run is for and the boundary its diff is scoped to.
      const prompt = assembled?._tag === "PromptAssembled" ? assembled.prompt : "";
      expect(prompt).toContain(BRANCH);
      expect(prompt).toContain(plan.mergeBaseSha);
      expect(intents(events)).toEqual([
        `run '${agentPassCommand(defaultConfig.passTimeoutSeconds).join(" ")}' in the sandbox '${CONTAINER}'`,
      ]);
      // The rehearsal records the pass a live run would run, backstop and all
      // (T139).
      expect(intents(events)[0]).toMatch(/^run 'timeout -k 30 1860 claude /);
    }),
  );

  it.effect("answers a round with what the run makes of a pass that printed nothing", () =>
    Effect.gen(function* () {
      const seen = yield* recording();
      const verdict = yield* Effect.flatMap(AgentCli, (agent) =>
        agent.review({ name: CONTAINER, id: CONTAINER }, plan, Option.none(), { index: 1, of: 3 }),
      ).pipe(
        Effect.provide(Layer.provideMerge(passLayer(seen), Layer.succeed(Reporter, seen.reporter))),
      );

      // No marker is `needs-work` (T24), decided by the module that owns the
      // question — a rehearsal that invented an approval would be the second
      // derivation this ticket deletes.
      expect(verdict).toBe("needs-work");
    }),
  );

  it.effect("answers the description pass with the body its caller substitutes", () =>
    Effect.gen(function* () {
      const seen = yield* recording();
      const description = yield* Effect.flatMap(AgentCli, (agent) =>
        agent.describePr({ name: CONTAINER, id: CONTAINER }, plan, Option.none()),
      ).pipe(
        Effect.provide(Layer.provideMerge(passLayer(seen), Layer.succeed(Reporter, seen.reporter))),
      );

      expect(description).toBe("");
    }),
  );
});

// Design rule 5 (SPEC §11), and the case that enforces it: **the same dispatch
// effect, run twice over one scripted world, differing only in which layers
// are recording.** Same guards, same plan derivation, same acquisition and
// release sequence — the only events a rehearsal adds are the mutations it
// recorded rather than performed, and the only commands it spawns are reads.
//
// The two stacks below are `appLiveFor` and `appDryRunLiveFor`, spelled out over a
// scripted `CommandExecutor` instead of `NodeContext`'s: what a real dockerd,
// git, and `gh` would have been asked is the assertion, so the seam has to be
// the executor rather than a fake tag.
const REPO = "<repo-root>";
const RUNTIME = "<runtime-root>";
const BASE_SHA = "1111111111111111111111111111111111111111";
const MERGE_BASE_SHA = "2222222222222222222222222222222222222222";
const PRE_TIP = "4444444444444444444444444444444444444444";
// Where a *leftover* copy of the branch stands, which is what the salvage
// reads before anything is removed (T38). Only the case that stages one on
// disk scripts it: a rehearsal's own copy is never cloned, so there is no
// directory to answer with a tip.
const COPY_TIP = "5555555555555555555555555555555555555555";
const CONTAINER_ID = "d15c0ffee1d";
const PR_URL = "https://github.com/acme/hae/pull/101";
const inRepo = (repo: string): string => `git -C ${repo} --git-dir=${repo}/.git`;

const worldScript: Record<string, ScriptedResult> = {
  // The guards, read for real on both stacks.
  [`${inRepo(REPO)} show-ref --verify --quiet refs/heads/${BRANCH}`]: { exit: 0 },
  [`${inRepo(REPO)} worktree list --porcelain`]: {
    exit: 0,
    stdout: `worktree ${REPO}\nHEAD ${BASE_SHA}\nbranch refs/heads/master\n`,
  },
  // T44's preflight, on both stacks: it is a read, so a rehearsal takes it for
  // real exactly like the guards above it.
  [`${inRepo(REPO)} rev-list HEAD..origin/master --`]: { exit: 0, stdout: "" },
  [`${inRepo(REPO)} rev-parse --verify origin/master^{commit}`]: {
    exit: 0,
    stdout: `${BASE_SHA}\n`,
  },
  [`${inRepo(REPO)} merge-base ${BASE_SHA} refs/heads/${BRANCH}`]: {
    exit: 0,
    stdout: `${MERGE_BASE_SHA}\n`,
  },
  // Preflight and the reconciler's ownership query.
  "docker info": { exit: 0 },
  "docker image inspect": { exit: 0, stdout: "\n" },
  "gh auth status": { exit: 0 },
  "docker ps": { exit: 0, stdout: "" },
  // The existing-PR probe, which a rehearsal keeps: this branch has none, so
  // both stacks resolve to a create.
  "gh pr view": { exit: 1, stderr: "no pull requests found\n" },
  "gh pr create": { exit: 0, stdout: `${PR_URL}\n` },
  // Everything below here is a mutation, and only the real stack reaches it.
  [`git clone --no-hardlinks --branch ${BRANCH} ${REPO}`]: { exit: 0 },
  [`${inRepo(REPO)} config --get user.name`]: { exit: 0, stdout: "Ada Lovelace\n" },
  [`${inRepo(REPO)} config --get user.email`]: { exit: 0, stdout: "ada@example.com\n" },
  // Nothing scripts a tip for the checkout on either stack, because on neither
  // of them was one ever made: the clone is a mutation, so the rehearsal
  // records it, and this world's `git clone` writes no directory either. The
  // catch-all below is what the release's containment read therefore meets —
  // exit 0 and no stdout, which is a ref that does not resolve (T38).
  [`git -C ${RUNTIME}/checkouts`]: { exit: 0 },
  [`${inRepo(REPO)} fetch`]: { exit: 0 },
  [`${inRepo(REPO)} push`]: { exit: 0 },
  [`${inRepo(REPO)} rev-parse --verify refs/heads/${BRANCH}`]: { exit: 0, stdout: `${PRE_TIP}\n` },
  [`${inRepo(REPO)} rev-list --count ${MERGE_BASE_SHA}..refs/heads/${BRANCH}`]: {
    exit: 0,
    stdout: "3\n",
  },
  [`${inRepo(REPO)} rev-list --count ${PRE_TIP}..refs/heads/${BRANCH}`]: { exit: 0, stdout: "2\n" },
  "docker run": { exit: 0, stdout: `${CONTAINER_ID}\n` },
  // The real stack's passes answer for real, which since T51 means a result
  // event: an empty one, so the two stacks reach the same warning about a
  // description block nobody wrote. The setup hook comes through the same
  // prefix and reads none of it.
  "docker exec": { exit: 0, stdout: streamJson(answersWith("")) },
  "docker rm": { exit: 0 },
  // The terminal notification the real stack raises and the rehearsal records.
  osascript: { exit: 0 },
};

interface Dispatched {
  // What the dispatch answered — the plan it resolved, or the typed refusal a
  // guard or a preflight probe gave it. A rehearsal fails with the same errors
  // a run does, which is the whole of criterion 3.
  readonly outcome: Either.Either<DispatchPlan | void, { readonly _tag: string }>;
  readonly events: ReadonlyArray<ReporterEvent>;
  readonly commands: ReadonlyArray<string>;
  readonly runtimeRoot: string;
  readonly repoRoot: string;
}

// The dispatch's `Terminal`. The one question a dispatch puts to it is *is
// anyone there* — `--feedback-edit`'s (T84), which a rehearsal asks exactly as
// a run does, since the text is the dispatcher's input and the plan carries it
// either way, and `--hard-reset`'s (T102), whose confirm a rehearsal's
// recording `Prompt` answers without asking anybody.
const terminalOf = (isTTY: boolean): Terminal.Terminal => ({
  columns: Effect.succeed(80),
  rows: Effect.succeed(24),
  isTTY: Effect.succeed(isTTY),
  readInput: Effect.die("a dispatch never reads the terminal"),
  readLine: Effect.die("a dispatch never reads the terminal"),
  display: () => Effect.void,
});

// One scratch world, and the dispatch run over it — `isRecording` picks which
// of the two compositions it runs against, and nothing else differs. `argv`
// enters through `@effect/cli` instead of calling `dispatch` directly, which
// is how the flag itself is asserted: the parser has to accept `--dry-run`,
// and the handler has to ignore it.
interface Rehearsal {
  // Entered through `@effect/cli` with a real argv instead of by calling
  // `dispatch`, which is how the flag itself is asserted: the parser has to
  // accept `--dry-run`, and the handler has to ignore it.
  readonly argv?: ReadonlyArray<string>;
  readonly request?: Partial<DispatchRequest>;
  // Whether this rehearsal was typed at a terminal (T84): `--feedback-edit`
  // is the one flag that asks, and it opens the editor on a rehearsal too.
  readonly isTTY?: boolean;
  readonly script?: Record<string, ScriptedResult>;
  // What the served repo's own `config.toml` declares, over the host config
  // above: the keys a case is about, and nothing else (T61).
  readonly config?: Partial<Omit<BessemerConfigShape, "runtimeRoot">>;
  // Files staged under the scratch repo root before anything runs, named the
  // way a config names them — relative to the served repo.
  readonly repoFiles?: ReadonlyArray<string>;
  // A checkout an earlier run of this branch left at the path this dispatch
  // is about to want, staged before anything runs — the state the way-in
  // removal meets, and the one a rehearsal must not act on (T38).
  readonly leftover?: boolean;
  // Rows the ledger already holds, written before anything runs — what a
  // `--resume` recovers its run from (T78).
  readonly ledger?: ReadonlyArray<RunRecord>;
  // What the branch tip's issue set says, answered by the fake store rather
  // than by blobs through a scripted `git` — the read is the one a rehearsal
  // keeps real, and it stays under the recording store's own wrapper, so the
  // write half is recorded exactly as `IssueStoreRecordingLive` records it.
  readonly issues?: FakeIssueStoreOptions;
}

// What a staged repo file holds: a line this process must never be in a
// position to repeat, since the one such file a config can name is read by
// docker alone (T61).
const ONLY_DOCKER_READS_THIS = "SECRET_SETTING=only-docker-reads-this\n";

// The file that dead run left in it, so "the directory is still there" is an
// assertion about its contents rather than about an empty shell.
const LEFT_BY_THE_DEAD_RUN = "what the dead run did\n";

const dispatched = (
  isRecording: boolean,
  options: Rehearsal = {},
): Effect.Effect<Dispatched, PlatformError, FileSystem.FileSystem | Scope.Scope> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const runtimeRoot = yield* fs.makeTempDirectoryScoped();
    const repoRoot = yield* fs.makeTempDirectoryScoped();
    yield* fs.makeDirectory(`${repoRoot}/tasks`);
    yield* fs.writeFileString(`${repoRoot}/tasks/T15.md`, "# T15\n");
    for (const file of options.repoFiles ?? []) {
      yield* fs.makeDirectory(`${repoRoot}/${file}`.replace(/\/[^/]*$/, ""), { recursive: true });
      yield* fs.writeFileString(`${repoRoot}/${file}`, ONLY_DOCKER_READS_THIS);
    }
    if (options.leftover === true) {
      const left = checkoutPathFor(runtimeRoot, BRANCH);
      yield* fs.makeDirectory(`${left}/.git`, { recursive: true });
      yield* fs.writeFileString(`${left}/.git/HEAD`, `ref: refs/heads/${BRANCH}\n`);
      yield* fs.writeFileString(`${left}/LEFT-BY-THE-DEAD-RUN`, LEFT_BY_THE_DEAD_RUN);
    }
    if (options.ledger !== undefined) {
      yield* fs.writeFileString(
        `${runtimeRoot}/${LEDGER_FILENAME}`,
        options.ledger.map((row) => `${JSON.stringify(encodeRow(row))}\n`).join(""),
      );
    }

    const events = yield* Ref.make<ReadonlyArray<ReporterEvent>>([]);
    const commands = yield* Ref.make<ReadonlyArray<string>>([]);
    // A case's own scripting is the more specific of the two, so it is matched
    // **first** as well as winning: the executor takes the earliest prefix
    // that matches, and a world with a catch-all in it would otherwise answer
    // ahead of the entry a case added to override it.
    const overrides = options.script ?? {};
    const script = Object.fromEntries(
      [
        ...Object.entries(overrides),
        ...Object.entries(worldScript).filter(([prefix]) => !(prefix in overrides)),
      ].map(([prefix, result]) => [
        prefix.replaceAll(REPO, repoRoot).replaceAll(RUNTIME, runtimeRoot),
        result.stdout === undefined
          ? result
          : { ...result, stdout: result.stdout.replaceAll(REPO, repoRoot) },
      ]),
    );

    const base = Layer.mergeAll(
      NodeFileSystem.layer,
      NodePath.layer,
      scriptedExecutor(script, commands),
      Layer.succeed(BessemerConfig, { ...hostConfig, runtimeRoot, ...options.config }),
      Layer.succeed(Reporter, {
        emit: (event) => Ref.update(events, (current) => [...current, event]),
      }),
    );

    // `appLiveFor`, and `appDryRunLiveFor` beside it: the same expression, the seven
    // mutating terms swapped.
    const live = Layer.provideMerge(
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
          // `PromptClackLive`'s stand-in: no case here scripts an answer, so a
          // live dispatch that asked anything dies rather than hanging (T102).
          scriptedPrompt([]),
        ),
        Layer.provideMerge(LedgerLive, base),
      ),
    );
    const rehearsal = Layer.provideMerge(
      AgentCliRecordingLive,
      Layer.provideMerge(
        Layer.mergeAll(
          SandboxRecordingLive,
          GitRecordingLive,
          RunLockRecordingLive,
          ForgeRecordingLive,
          NotifierRecordingLive,
          options.issues === undefined
            ? IssueStoreRecordingLive
            : Layer.effect(
                IssueStore,
                Effect.map(Effect.all([IssueStore, Reporter]), ([store, reporter]) =>
                  recordingIssueStore(store, reporter),
                ),
              ).pipe(Layer.provide(fakeIssueStore(undefined, options.issues))),
          promptSourceLiveFor(repoRoot),
          PromptRecordingLive,
        ),
        Layer.provideMerge(LedgerRecordingLive, base),
      ),
    );

    const run =
      options.argv === undefined
        ? dispatch(
            {
              spec: Option.some("T15"),
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
              keepsLog: !isRecording,
              ...options.request,
            },
            repoRoot,
            // Self-hosted, as every case in this file is: the rehearsal is the
            // same dispatch against recording services, and T60 changes which
            // *questions* are asked rather than which layer answers them.
            true,
            Option.some(TEST_CREDENTIAL),
            Option.none(),
            Option.some(TEST_FORGE_REPO),
          )
        : dispatchCli(
            options.argv,
            repoRoot,
            true,
            Option.some(TEST_CREDENTIAL),
            Option.none(),
            Option.some(TEST_FORGE_REPO),
          );
    const outcome = yield* Effect.either(run).pipe(
      Effect.provideService(Terminal.Terminal, terminalOf(options.isTTY ?? false)),
      Effect.provide(isRecording ? rehearsal : live),
    );

    return {
      outcome,
      events: yield* Ref.get(events),
      commands: yield* Ref.get(commands),
      runtimeRoot,
      repoRoot,
    };
  });

// The scope's boundary crossings on their own, which is what SPEC §11's
// ordering invariant is asserted off: lock, checkout, sandbox, released in
// reverse.
const resources = (run: Dispatched): ReadonlyArray<string> =>
  run.events.flatMap((event) =>
    event._tag === "ResourceAcquired"
      ? [`+${event.resource}`]
      : event._tag === "ResourceReleased"
        ? [`-${event.resource}`]
        : [],
  );

describe("a dry run and a real dispatch", () => {
  it.scoped("emit the same event-sequence shape", () =>
    Effect.gen(function* () {
      const real = yield* dispatched(false);
      const dry = yield* dispatched(true);
      expect(Either.isRight(real.outcome)).toBe(true);
      expect(Either.isRight(dry.outcome)).toBe(true);

      // Tags, not values: the two worlds are two temp directories, so a plan
      // holds different paths while being the same plan. Every recorded
      // mutation is dropped, because that is the one difference design rule 5
      // allows — the recorded-vs-performed nature of the mutations.
      expect(tags(dry.events).filter((tag) => tag !== "MutationRecorded")).toEqual(
        tags(real.events),
      );
      // And the sequence itself, spelled out, so a future edit that reorders
      // the scope fails here rather than passing a comparison of two equally
      // wrong lists.
      expect(tags(real.events)).toEqual([
        "PlanResolved",
        "ResourceAcquired",
        "ResourceAcquired",
        "ResourceAcquired",
        // The implement pass, then a review round per prompt-and-verdict pair
        // up to the cap, then the description pass — every one of them
        // assembled for real on both stacks, and the rehearsal's warning is
        // the same one a pass that wrote no description block earns.
        "PromptAssembled",
        "AgentPassFinished",
        "PromptAssembled",
        "AgentPassFinished",
        "ReviewVerdictReached",
        "PromptAssembled",
        "AgentPassFinished",
        "ReviewVerdictReached",
        "PromptAssembled",
        "AgentPassFinished",
        "ReviewVerdictReached",
        "CommitsPushed",
        "PromptAssembled",
        "AgentPassFinished",
        "Warned",
        "PullRequestReady",
        "ResourceReleased",
        "ResourceReleased",
        "ResourceReleased",
      ]);
      // The acquisition and release sequence on its own (SPEC §11): lock,
      // checkout, sandbox, released in reverse, in a rehearsal exactly as in a
      // run.
      expect(resources(dry)).toEqual([
        "+lock",
        "+checkout",
        "+sandbox",
        "-sandbox",
        "-checkout",
        "-lock",
      ]);
      expect(resources(dry)).toEqual(resources(real));
      // `-checkout` is there for the reason it has to be read carefully (T38):
      // a rehearsal's copy was never cloned, so the release's containment read
      // gets no tip out of it and the salvage answers `Kept` — and **a copy
      // that is not on disk was not kept**, so the resource releases and the
      // dispatcher is told nothing about a directory that never existed.
      expect(
        dry.events.filter(
          (event) =>
            event._tag === "Warned" && event.detail.includes(`${dry.runtimeRoot}/checkouts`),
        ),
      ).toEqual([]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped("spawns every read and no mutation, and holds nothing afterwards", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dry = yield* dispatched(true);

      // The reads a rehearsal keeps, spelled out: every guard's question, the
      // `--base` chain's merge-base, and nothing else — this is the list that
      // makes "the guards still fail for real" mean something.
      expect(dry.commands.filter((command) => command.startsWith("git "))).toEqual([
        `${inRepo(dry.repoRoot)} show-ref --verify --quiet refs/heads/${BRANCH}`,
        `${inRepo(dry.repoRoot)} worktree list --porcelain`,
        // **The one write a rehearsal makes** (T70), in its place: after the
        // last local guard and before anything reads a remote-tracking ref. A
        // recorded fetch would leave the freshness check and the base resolve
        // below answering off stale refs, and the plan this whole file is
        // about is the plan the run would use.
        `${inRepo(dry.repoRoot)} fetch origin`,
        `${inRepo(dry.repoRoot)} rev-list HEAD..origin/master -- ${packagePathspec(dry.repoRoot).join(" ")}`,
        `${inRepo(dry.repoRoot)} rev-parse --verify origin/master^{commit}`,
        `${inRepo(dry.repoRoot)} merge-base ${BASE_SHA} refs/heads/${BRANCH}`,
        // The content phase's tip read (T73), made for real here as every read
        // in a rehearsal is: the plan prints the fork commit the run would
        // have used, so a recorded answer would print a plan of nothing.
        `${inRepo(dry.repoRoot)} rev-parse --verify refs/heads/${BRANCH}`,
        // Whether the branch contains its remote (T106) — a read, so real;
        // this world has no `origin/<b>`, which passes.
        `${inRepo(dry.repoRoot)} rev-parse --verify refs/remotes/origin/${BRANCH}`,
        // The identity the clone would have carried, read where it is read for
        // real (T35) — it is the *write* into the copy that records.
        `${inRepo(dry.repoRoot)} config --get user.name`,
        `${inRepo(dry.repoRoot)} config --get user.email`,
        // The land's own reads, which a rehearsal makes too: what the branch
        // held when this run was typed, and what it holds past the boundary.
        `${inRepo(dry.repoRoot)} rev-parse --verify refs/heads/${BRANCH}`,
        `${inRepo(dry.repoRoot)} rev-list --count ${MERGE_BASE_SHA}..refs/heads/${BRANCH}`,
        `${inRepo(dry.repoRoot)} rev-list --count ${PRE_TIP}..refs/heads/${BRANCH}`,
        // The release's branch read (T107), before its fetch onto the branch:
        // a read, so a rehearsal makes it for real.
        `${inRepo(dry.repoRoot)} rev-parse --verify refs/heads/${BRANCH}`,
        // And the release's containment read, made for real here as every read
        // is (T38): the copy's tip, asked of the copy. It gets no answer,
        // because a rehearsal recorded the clone rather than making it — which
        // is exactly why nothing a rehearsal does can get a directory removed,
        // and why the ancestry question below it is never reached.
        `${inRepo(`${dry.runtimeRoot}/checkouts/${BRANCH}`)} rev-parse --verify refs/heads/${BRANCH}`,
      ]);
      // The docker and `gh` preflight, the reconciler's ownership query, and
      // the existing-PR probe that decides create-vs-update.
      expect(dry.commands).toContain("docker info");
      expect(dry.commands).toContain("gh auth status");
      expect(dry.commands.some((command) => command.startsWith("docker ps"))).toBe(true);
      expect(dry.commands.some((command) => command.startsWith(`gh pr view ${BRANCH}`))).toBe(true);
      // And not one command that could change anything — every command but
      // the fetch above, which is the one write a rehearsal makes and so the
      // one this list cannot ask about (T70). Every *other* `git fetch` — the
      // land's trip home, the release's salvage — is still a mutation, and
      // still recorded rather than run.
      const fetched = `${inRepo(dry.repoRoot)} fetch origin`;
      for (const command of dry.commands.filter((spawned) => spawned !== fetched)) {
        expect(command).not.toMatch(/^docker (run|create|rm|start|exec)\b/);
        expect(command).not.toMatch(
          /^git (-C \S+ (--git-dir=\S+ )?)?(clone|fetch|push|branch|checkout|switch|reset|config --local)\b/,
        );
        expect(command).not.toMatch(/^gh pr (create|edit)\b/);
        expect(command).not.toBe("osascript");
      }

      // No lock, no checkout, no ledger row, and no log: `--dry-run` writes
      // nothing to the runtime root at all (T48). Pinned here rather than
      // left unstated, so closing the leak was a red test rather than a
      // discovery.
      expect(yield* fs.readDirectory(dry.runtimeRoot)).toEqual([]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
});

// The status commit in a rehearsal (T77). A rehearsed feature run never
// reaches it through the loop: the recording agent's rounds read no verdict,
// which is `needs-work`, and inventing an approval would be the second
// derivation the swap exists to delete. So the land is run here under the
// rehearsal's own two terms with the approval already on the slot, over the
// same scripted world — which is the only way the question *would the write
// have fallen through* can be asked of a rehearsal at all.
describe("a rehearsed land with an approved issue", () => {
  it.scoped("records the status commit, and spawns none of the plumbing that builds one", () =>
    Effect.gen(function* () {
      const runtimeRoot = yield* FileSystem.FileSystem.pipe(
        Effect.flatMap((fs) => fs.makeTempDirectoryScoped()),
      );
      const seen = yield* recording();
      const commands = yield* Ref.make<ReadonlyArray<string>>([]);
      const script = Object.fromEntries(
        Object.entries(worldScript).map(([prefix, result]) => [
          prefix.replaceAll(REPO, REPO_ROOT).replaceAll(RUNTIME, runtimeRoot),
          result,
        ]),
      );
      const issue = fakeIssue("T70");
      const featurePlan = planFor({
        ...featureDispatch(FOLDER, { request: { _tag: "All" }, issues: [issue] }),
        branch: BRANCH,
        baseRef: "origin/master",
        baseSha: BASE_SHA,
        mergeBaseSha: MERGE_BASE_SHA,
        tipSha: PLAN_TIP,
        runtimeRoot,
        startedAt: DateTime.unsafeMake("2026-01-01T00:00:00.000Z"),
      });
      const outcomes = yield* Ref.make<ReadonlyArray<IssueOutcome>>([
        { issue: issue.id, outcome: APPROVED_OUTCOME },
      ]);

      const landed = yield* land(featurePlan, REPO_ROOT, outcomes).pipe(
        Effect.provide(
          Layer.provideMerge(
            Layer.mergeAll(GitRecordingLive, IssueStoreRecordingLive),
            Layer.mergeAll(
              scriptedExecutor(script, commands),
              Layer.succeed(BessemerConfig, { ...hostConfig, runtimeRoot }),
              Layer.succeed(Reporter, seen.reporter),
            ),
          ),
        ),
      );

      expect(landed).toBe("pushed");
      expect(intents(yield* Ref.get(seen.events))).toContain(
        `mark ${issue.stem} Done on '${BRANCH}'`,
      );
      // No new commit: nothing that writes an object, builds a tree, or moves
      // a ref was spawned — the rehearsal's git ran only the land's reads.
      for (const command of yield* Ref.get(commands)) {
        expect(command).not.toMatch(
          /\b(hash-object|read-tree|update-index|write-tree|commit-tree|update-ref)\b/,
        );
      }
      expect(yield* Ref.get(commands)).toEqual([
        `${inRepo(REPO_ROOT)} rev-parse --verify refs/heads/${BRANCH}`,
        `${inRepo(REPO_ROOT)} rev-list --count ${MERGE_BASE_SHA}..refs/heads/${BRANCH}`,
        `${inRepo(REPO_ROOT)} rev-list --count ${PRE_TIP}..refs/heads/${BRANCH}`,
      ]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
});

// Criterion 1 end to end (T61): the key declared, the file present, and the
// line a dispatcher reads off a rehearsal naming it — through the same
// renderer the live layer hands docker, so the rehearsal cannot describe a
// container the run would not have started.
describe("a rehearsal of a repo that declares an env file", () => {
  it.scoped("names it in the sandbox line, and repeats nothing that is in it", () =>
    Effect.gen(function* () {
      const dry = yield* dispatched(true, {
        config: { sandboxEnvFile: ".bessemer/env.sandbox" },
        repoFiles: [".bessemer/env.sandbox"],
      });

      expect(Either.isRight(dry.outcome)).toBe(true);
      const start = intents(dry.events).find((detail) => detail.startsWith("start the sandbox"));
      expect(start).toContain(`--env-file ${dry.repoRoot}/.bessemer/env.sandbox`);
      // The path travelled; the contents did not. Nothing here opened the
      // file — docker would have — so there is nothing of it to leak into a
      // recorded intent, an event, or a spawned command.
      for (const detail of intents(dry.events)) {
        expect(detail).not.toContain(ONLY_DOCKER_READS_THIS.trim());
      }
      for (const command of dry.commands) {
        expect(command).not.toContain(ONLY_DOCKER_READS_THIS.trim());
      }
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
});

// **A rehearsal removes nothing it has not read to be disposable** (T38). The
// removals are `FileSystem` calls and the swap does not reach them (SPEC §12),
// so what holds them back is not a flag: the fetch-back that would authorize
// one is recorded rather than made, the containment read afterwards is real,
// and a branch that does not hold the copy's commits is the answer that keeps
// the directory. Nothing in the dispatch learns a rehearsal is in progress.
describe("a dry run over a checkout an earlier run left behind", () => {
  it.scoped("removes nothing, and says the commits are still only in there", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dry = yield* dispatched(true, {
        leftover: true,
        script: {
          // The staged copy is on disk, so it answers a tip — the one thing
          // the ordinary rehearsal has no directory to answer with.
          [`${inRepo(`${RUNTIME}/checkouts/${BRANCH}`)} rev-parse --verify refs/heads/${BRANCH}`]: {
            exit: 0,
            stdout: `${COPY_TIP}\n`,
          },
          // Exit 1 is git's own "no": the branch does not hold that copy's tip.
          [`${inRepo(REPO)} merge-base --is-ancestor`]: { exit: 1 },
        },
      });
      const left = checkoutPathFor(dry.runtimeRoot, BRANCH);

      // Refused, at the step that would have cleared the path, with the
      // sentence that says which fetch answered and what the read found.
      expect(Either.isLeft(dry.outcome)).toBe(true);
      expect(Either.isLeft(dry.outcome) ? dry.outcome.left._tag : "").toBe("GitError");

      // And the directory is exactly as it was staged, file and all.
      expect(yield* fs.readFileString(`${left}/LEFT-BY-THE-DEAD-RUN`)).toBe(LEFT_BY_THE_DEAD_RUN);
      expect(yield* fs.readFileString(`${left}/.git/HEAD`)).toBe(`ref: refs/heads/${BRANCH}\n`);

      // The rehearsal recorded the fetch it would have made — the return value
      // that used to authorize the removal — and made the read that refused to
      // stand behind it.
      expect(
        intents(dry.events).some((intent) =>
          intent.startsWith(`fetch refs/heads/${BRANCH} from ${left}`),
        ),
      ).toBe(true);
      expect(dry.commands).toContain(
        `${inRepo(dry.repoRoot)} merge-base --is-ancestor ${COPY_TIP} refs/heads/${BRANCH}`,
      );
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
});

// The flag itself, at the two places it is allowed to exist: the parser,
// which declares it so `--help` says it exists, an unknown option is still
// refused, and it becomes `keepsLog` on the `DispatchRequest` (T48); and the
// entrypoint, which reads it to pick the layer.
describe("the --dry-run flag", () => {
  it.scoped("is accepted by the parser and never reaches the dispatch core", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const viaCli = yield* dispatched(true, {
        argv: ["T15", "--branch", BRANCH, "--dry-run"],
      });

      // The same rehearsal, reached through a real argv: the flag parsed, the
      // dispatch ran, and nothing was claimed or recorded.
      expect(resources(viaCli)).toEqual([
        "+lock",
        "+checkout",
        "+sandbox",
        "-sandbox",
        "-checkout",
        "-lock",
      ]);
      expect(yield* fs.readDirectory(viaCli.runtimeRoot)).toEqual([]);
      // And TTY-independent by construction: the `Terminal` above answers
      // `isTTY: false` and dies on a read, so a rehearsal that asked the
      // terminal anything would fail here rather than behave differently on a
      // pipe than on a desk.
      expect(Either.isRight(viaCli.outcome)).toBe(true);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // `--dry-run --hard-reset` on a terminal (T102, D4): the discard is still
  // said, the confirm is recorded rather than asked, and the rehearsal goes
  // on — the recording `Prompt` answers yes, and no scripted answer exists
  // anywhere in this world for a real one to consume.
  it.scoped("rehearses a hard reset on a terminal without asking, recording the question", () =>
    Effect.gen(function* () {
      const origin = "9999999999999999999999999999999999999999";
      const dry = yield* dispatched(true, {
        argv: ["T15", "--branch", BRANCH, "--hard-reset", "--dry-run"],
        isTTY: true,
        script: {
          [`${inRepo(REPO)} rev-parse --verify refs/remotes/origin/${BRANCH}`]: {
            exit: 0,
            stdout: `${origin}\n`,
          },
          [`${inRepo(REPO)} rev-list --count ^${BASE_SHA} ${PRE_TIP} ${origin}`]: {
            exit: 0,
            stdout: "4\n",
          },
          [`${inRepo(REPO)} rev-list --count ${BASE_SHA}..refs/heads/${BRANCH}`]: {
            exit: 0,
            stdout: "1\n",
          },
        },
      });
      expect(Either.isRight(dry.outcome)).toBe(true);
      expect(dry.events).toContainEqual({
        _tag: "Warned",
        detail: `--hard-reset: DISCARDING 4 commit(s) on '${BRANCH}' — recoverable from the reflog only`,
      });
      expect(intents(dry.events)).toContain(
        `ask: Discard 4 commit(s) on '${BRANCH}' and reset it to the base?`,
      );
      // And it went on past the question: the reset itself is recorded too.
      expect(intents(dry.events)).toContain(
        `move refs/heads/${BRANCH} from ${PRE_TIP} to ${BASE_SHA} in ${dry.repoRoot}`,
      );
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // A task stated inline, rehearsed whole (T67): every guard, the plan block
  // with its mode line, the three passes' prompts assembled for real with the
  // text in the task section — and nothing written under the runtime root.
  it.scoped("rehearses a --task dispatch, prompts and all, and writes nothing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const text = "fix the release note: it contradicts the flag's default";
      const dry = yield* dispatched(true, {
        argv: ["--branch", BRANCH, "--task", text, "--dry-run"],
      });
      expect(Either.isRight(dry.outcome)).toBe(true);

      const resolved = dry.events.find((event) => event._tag === "PlanResolved");
      expect(resolved?._tag).toBe("PlanResolved");
      if (resolved?._tag === "PlanResolved") {
        expect(resolved.plan.identity).toEqual({ _tag: "InlineTask", task: text });
        const block = renderPlan(resolved.plan);
        expect(block).toContain("  mode:          one-off (inline task)");
        expect(block).toContain(`bessemer: '${text}'`.slice(0, 30));
      }

      // Every pass's message, assembled over the template that won: the text
      // in its own fenced section, and no resuming sentence — this is a fresh
      // dispatch, so there is nothing on the branch this run did not put there.
      const prompts = dry.events.flatMap((event) =>
        event._tag === "PromptAssembled" ? [event.prompt] : [],
      );
      expect(prompts.length).toBeGreaterThanOrEqual(3);
      for (const prompt of prompts) {
        expect(prompt).toContain(`${TASK_OPEN}\n${text}\n${TASK_CLOSE}`);
        expect(prompt).not.toContain("resumes branch");
        expect(prompt).not.toContain(SPEC_TARGET);
      }

      // No lock, no checkout, no ledger row, no log (T48).
      expect(yield* fs.readDirectory(dry.runtimeRoot)).toEqual([]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // The same rehearsal on the arm that has a file, so the mode line is asserted
  // against a run that differs in exactly one fact.
  it.scoped("names the spec arm's mode on a rehearsed spec dispatch", () =>
    Effect.gen(function* () {
      const dry = yield* dispatched(true, { argv: ["T15", "--branch", BRANCH, "--dry-run"] });
      const resolved = dry.events.find((event) => event._tag === "PlanResolved");
      if (resolved?._tag === "PlanResolved") {
        expect(renderPlan(resolved.plan)).toContain("  mode:          one-off (spec)");
      }
      // And it really fetched on its way to that block (T70): the base every
      // line of it is resolved from comes out of what `origin` holds now, or
      // the rehearsal is printing a plan the run would not use.
      expect(dry.commands).toContain(`${inRepo(dry.repoRoot)} fetch origin`);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // `--dry-run --feedback-edit` **opens the editor** (T84): the text is the
  // dispatcher's own input, not a mutation, so a rehearsal that skipped it
  // would print a plan with no feedback in it and the run would carry one. The
  // temp file lives under the runtime root and dies with the scope, which is
  // the one way a rehearsal touches that directory at all — and the assertion
  // T48 owes is about the world afterwards, which is unchanged.
  it.scoped("rehearses --feedback-edit by opening the editor, and leaves nothing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const text = "use the smaller diff";
      const dry = yield* dispatched(true, {
        argv: ["T15", "--branch", BRANCH, "--dry-run", "--feedback-edit"],
        isTTY: true,
        script: {
          [`${inRepo(REPO)} var GIT_EDITOR`]: { exit: 0, stdout: "fake-editor\n" },
          "sh -c": {
            exit: 0,
            onSpawn: (args) =>
              Effect.gen(function* () {
                const editing = yield* FileSystem.FileSystem;
                const file = args[args.length - 1] ?? "";
                const prefilled = yield* editing.readFileString(file);
                yield* editing.writeFileString(file, `${prefilled}${text}\n`);
              }).pipe(Effect.provide(NodeFileSystem.layer), Effect.orDie),
          },
        },
      });

      expect(Either.isRight(dry.outcome)).toBe(true);
      const resolved = dry.events.find((event) => event._tag === "PlanResolved");
      if (resolved?._tag === "PlanResolved") {
        expect(feedbackIn(resolved.plan.task)).toEqual(Option.some(text));
      }
      // And every pass a rehearsal assembles carries it, in the section
      // `--feedback`'s own text would have landed in.
      const prompts = dry.events.flatMap((event) =>
        event._tag === "PromptAssembled" ? [event.prompt] : [],
      );
      expect(prompts.length).toBeGreaterThanOrEqual(3);
      for (const prompt of prompts) {
        expect(prompt).toContain(`${FEEDBACK_OPEN}\n${text}\n${FEEDBACK_CLOSE}`);
      }
      // The whole of T48, unchanged: the editor's file is the scope's, and the
      // runtime root is empty when the scope closes.
      expect(yield* fs.readDirectory(dry.runtimeRoot)).toEqual([]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it("picks the rehearsal at the entrypoint and nowhere else", () => {
    // The composition rather than the layer: each takes the served repo, so
    // two layers built from one expression are different objects and only the
    // choice between them is comparable (T57).
    expect(appCompositionFor(["T15", "--branch", BRANCH, "--dry-run"])).toBe(appDryRunLiveFor);
    expect(appCompositionFor(["T15", "--branch", BRANCH])).toBe(appLiveFor);
    // The flag as written, once: `bin.ts` and the parser both spell it from
    // here, so they cannot drift apart.
    expect(DRY_RUN_FLAG).toBe("--dry-run");
  });

  // bash's modifier rule (`run.sh:752`), which is what routes a lone
  // `--dry-run` into the picker on a TTY (T81): the modifier is not a
  // dispatch, and the entrypoint is the only place that knows which word it
  // is.
  it("counts an argv of nothing but modifiers as no arguments", () => {
    expect(isModifiersOnly([])).toBe(true);
    expect(isModifiersOnly(["--dry-run"])).toBe(true);
    expect(isModifiersOnly(["T15", "--dry-run"])).toBe(false);
    expect(isModifiersOnly(["--branch", BRANCH])).toBe(false);
  });
});

// Criterion 3, which is what separates a rehearsal from a print-out: the
// guards and the preflight probes are the live ones, so a dispatch a real run
// would refuse is refused here too — with the same typed error, before
// anything is recorded, let alone done.
describe("a dry run's refusals", () => {
  it.scoped("refuses a protected branch exactly as a real dispatch does", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dry = yield* dispatched(true, { request: { branch: Option.some("master") } });

      expect(Either.isLeft(dry.outcome)).toBe(true);
      expect(Either.isLeft(dry.outcome) ? dry.outcome.left._tag : "").toBe("GuardRefused");
      // Nothing resolved, so nothing was announced and nothing was recorded:
      // a refusal holds nothing in a rehearsal for the same reason it holds
      // nothing in a run (matrix row 1).
      expect(dry.events).toEqual([]);
      expect(yield* fs.readDirectory(dry.runtimeRoot)).toEqual([]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // T106: the containment check is reads only, and a rehearsal's reads are
  // real (T15) — so a branch behind its remote is refused here as it would be
  // in a run, before anything is recorded.
  it.scoped("refuses a branch behind its remote exactly as a real dispatch does", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const originTip = "9999999999999999999999999999999999999999";
      const dry = yield* dispatched(true, {
        script: {
          [`${inRepo(REPO)} rev-parse --verify refs/remotes/origin/${BRANCH}`]: {
            exit: 0,
            stdout: `${originTip}\n`,
          },
          [`${inRepo(REPO)} merge-base --is-ancestor ${originTip} refs/heads/${BRANCH}`]: {
            exit: 1,
          },
          [`${inRepo(REPO)} rev-list --count ${PRE_TIP}..${originTip}`]: { exit: 0, stdout: "2\n" },
          [`${inRepo(REPO)} rev-list --count ${originTip}..${PRE_TIP}`]: { exit: 0, stdout: "0\n" },
        },
      });

      expect(Either.isLeft(dry.outcome) ? dry.outcome.left : undefined).toEqual(
        new GuardRefused({ detail: branchBehindItsRemote(BRANCH, 2) }),
      );
      expect(dry.events).toEqual([]);
      expect(yield* fs.readDirectory(dry.runtimeRoot)).toEqual([]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped("stops at the docker preflight, on the daemon's real answer", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dry = yield* dispatched(true, {
        script: { "docker info": { exit: 1, stderr: "Cannot connect to the Docker daemon\n" } },
      });

      expect(Either.isLeft(dry.outcome) ? dry.outcome.left._tag : "").toBe("DockerUnavailable");
      expect(dry.events).toEqual([]);
      expect(yield* fs.readDirectory(dry.runtimeRoot)).toEqual([]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
});

// The plan block a rehearsal announced, as a dispatcher reads it.
const blockOf = (dry: Dispatched): ReadonlyArray<string> => {
  const resolved = dry.events.find((event) => event._tag === "PlanResolved");
  if (resolved?._tag !== "PlanResolved") {
    throw new Error("expected a resolved plan");
  }
  return renderPlan(resolved.plan).split("\n");
};

// T78's rehearsal: `--dry-run --resume b` over a feature row prints the mode
// as a resume and the ids the record left, and writes nothing — the ledger it
// resumed from is byte-identical afterwards and nothing joins it under the
// runtime root. A fresh `--feature` rehearsal still prints `feature`.
describe("a rehearsed resume of a feature run", () => {
  const tip = {
    sets: {
      [PRE_TIP]: [
        fakeIssue("T70", { status: "done" as const }),
        fakeIssue("T71"),
        fakeIssue("T72"),
      ],
    },
  };

  // Run 1 of the branch: `[A approved, B needs-work, C not-attempted]`.
  const featureRow: RunRecord = {
    ...recordedRow,
    identity: {
      _tag: "Feature",
      feature: FOLDER,
      issues: [
        { issue: "T70", outcome: APPROVED_OUTCOME },
        { issue: "T71", outcome: "needs-work" },
        { issue: "T72", outcome: "not-attempted" },
      ],
    },
  };

  it.scoped("prints resume (feature) and the replayed ids, and writes nothing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dry = yield* dispatched(true, {
        request: { spec: Option.none(), branch: Option.none(), resume: Option.some(BRANCH) },
        ledger: [featureRow],
        issues: tip,
      });

      expect(Either.isRight(dry.outcome)).toBe(true);
      const block = blockOf(dry);
      expect(block[1]).toBe("  mode:          resume (feature)");
      expect(block[2]).toBe("  issues:        T71 T72 (2)");
      // The row it resumed from is all the runtime root holds, as it was.
      expect(yield* fs.readDirectory(dry.runtimeRoot)).toEqual([LEDGER_FILENAME]);
      expect(yield* fs.readFileString(`${dry.runtimeRoot}/${LEDGER_FILENAME}`)).toBe(
        `${JSON.stringify(encodeRow(featureRow))}\n`,
      );
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped("still prints feature for a fresh --feature rehearsal", () =>
    Effect.gen(function* () {
      const dry = yield* dispatched(true, {
        request: {
          spec: Option.none(),
          feature: Option.some(FOLDER),
          issues: Option.some("T71"),
        },
        issues: tip,
      });
      expect(Either.isRight(dry.outcome)).toBe(true);
      expect(blockOf(dry)[1]).toBe("  mode:          feature");
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // T89: a row whose set is all approved, resumed with `--feedback`, rehearses
  // the feedback-only resume — the eighth spelling, no `issues` row — and
  // writes nothing either.
  it.scoped("prints the eighth spelling for an exhausted set with --feedback", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const exhaustedRow: RunRecord = {
        ...recordedRow,
        identity: {
          _tag: "Feature",
          feature: FOLDER,
          issues: [
            { issue: "T70", outcome: APPROVED_OUTCOME },
            { issue: "T71", outcome: APPROVED_OUTCOME },
          ],
        },
      };
      const dry = yield* dispatched(true, {
        request: {
          spec: Option.none(),
          branch: Option.none(),
          resume: Option.some(BRANCH),
          feedback: Option.some("x"),
        },
        ledger: [exhaustedRow],
        issues: tip,
      });

      expect(Either.isRight(dry.outcome)).toBe(true);
      const block = blockOf(dry);
      expect(block[1]).toBe(
        "  mode:          resume (feedback stands in for the exhausted issue set)",
      );
      expect(block.some((line) => line.startsWith("  issues:"))).toBe(false);
      expect(yield* fs.readDirectory(dry.runtimeRoot)).toEqual([LEDGER_FILENAME]);
      expect(yield* fs.readFileString(`${dry.runtimeRoot}/${LEDGER_FILENAME}`)).toBe(
        `${JSON.stringify(encodeRow(exhaustedRow))}\n`,
      );
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
});
