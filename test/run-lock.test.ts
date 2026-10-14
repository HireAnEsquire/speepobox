// `RunLock` and the run's `Scope` (SPEC §4, §11). The lock is a real PID file
// under a scratch runtime root in every case here: "our fake released" is not
// "the file is gone", and the whole point of a PID file is the contention an
// in-process primitive cannot see.
//
// Matrix rows covered: 3 (live owner → typed `LockHeld`, nothing acquired),
// 4 (stale owner → reclaimed inside acquisition, reported, run proceeds),
// 16 (interrupt → released, `interrupted` row) and 20 (ledger append fails →
// everything released, warned loudly, non-fatal), each at the one-resource
// depth this ticket has.
import { describe, expect, it } from "@effect/vitest";
import { FileSystem } from "@effect/platform";
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { DateTime, Deferred, Effect, Either, Exit, Fiber, Layer, Option, Ref } from "effect";
import { BessemerConfig, defaultConfig } from "../src/config/config.ts";
import { lockPathFor, planFor, specDispatch } from "../src/dispatch/plan.ts";
import { runInScope } from "../src/dispatch/run.ts";
import { Ledger, LedgerError } from "../src/ledger/ledger.ts";
import type { RunRecord } from "../src/ledger/record.ts";
import { claimLockFile } from "../src/lock/claim.ts";
import { isProcessAlive, ownerIsAlive, parsePid } from "../src/lock/liveness.ts";
import { RunLock, RunLockLive } from "../src/lock/run-lock.ts";
import { evictorInMarkerName, evictorMarkerFor, withEvictionWitness } from "../src/lock/witness.ts";
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

const BRANCH = "bessemer-t4";
const BASE_SHA = "1111111111111111111111111111111111111111";
const MERGE_BASE_SHA = "2222222222222222222222222222222222222222";

// Above Linux's pid_max, so `kill -0` can only answer "no such process". The
// live pid is this test process, which is unarguably alive.
const DEAD_PID = 2147483647;

interface WorldOptions {
  readonly appendFails?: boolean;
}

const world = (options: WorldOptions = {}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const runtimeRoot = yield* fs.makeTempDirectoryScoped();
    // The run's scope now clones a checkout too, so the repo it clones from is
    // part of the world. The `Git` behind it is a fake: what this file is
    // about is the lock and the row, and T18's checkout.test.ts is where the
    // clone and its derived release are the subject.
    const repoRoot = yield* fs.makeTempDirectoryScoped();
    const events = yield* Ref.make<ReadonlyArray<ReporterEvent>>([]);
    const appended = yield* Ref.make<ReadonlyArray<RunRecord>>([]);
    const gitCalls = yield* Ref.make<ReadonlyArray<GitCall>>([]);
    const sandboxes = yield* Ref.make<ReadonlyArray<SandboxSpec>>([]);

    const plan = planFor({
      ...specDispatch(`${runtimeRoot}/tasks/T4.md`),
      branch: BRANCH,
      baseRef: "origin/master",
      baseSha: BASE_SHA,
      mergeBaseSha: MERGE_BASE_SHA,
      tipSha: PLAN_TIP,
      runtimeRoot,
      startedAt: DateTime.unsafeMake("2026-01-01T00:00:00.000Z"),
    });

    const layer = Layer.provideMerge(
      Layer.mergeAll(
        RunLockLive,
        fakeGit(gitCalls),
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
          append: (record) =>
            options.appendFails === true
              ? Effect.fail(new LedgerError({ detail: "runs.jsonl: EACCES" }))
              : Ref.update(appended, (current) => [...current, record]),
          recent: () => Effect.succeed([]),
          lastBaseForBranch: () => Effect.succeed(Option.none()),
          resolveResume: () => Effect.die("the lock never resumes"),
          newestBranchForIssue: () => Effect.die("the lock dispatches no feature"),
        }),
      ),
    );

    return { runtimeRoot, repoRoot, events, appended, plan, layer };
  });

const warningsIn = (events: ReadonlyArray<ReporterEvent>): ReadonlyArray<string> =>
  events.flatMap((event) => (event._tag === "Warned" ? [event.detail] : []));

describe("the liveness predicate", () => {
  it("reads the one pid a lock file may hold, and refuses everything else", () => {
    expect(parsePid("4321\n")).toEqual(Option.some(4321));
    expect(parsePid(" 4321 ")).toEqual(Option.some(4321));
    expect(parsePid("")).toEqual(Option.none());
    expect(parsePid("4321 6543")).toEqual(Option.none());
    expect(parsePid("not a pid")).toEqual(Option.none());
    // 0 would signal the whole process group; it never reaches `kill`.
    expect(parsePid("0")).toEqual(Option.none());
  });

  it("says alive for a running process and dead for one that cannot exist", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(DEAD_PID)).toBe(false);
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
  });

  // The two halves as one question, for the callers that hold a *lock* rather
  // than a pid: acquisition below and T8's reconciler, which asks it of every
  // lock and every stranded eviction witness in the directory. One predicate,
  // not two spellings of it — the reason this module has no tag.
  it("reads a lock's owner as dead when nobody can name it", () => {
    expect(ownerIsAlive(parsePid(`${process.pid}\n`))).toBe(true);
    expect(ownerIsAlive(parsePid(`${DEAD_PID}\n`))).toBe(false);
    expect(ownerIsAlive(parsePid(""))).toBe(false);
  });
});

// The claim `RunLock` acquisition is built out of (T20). Its own contract is
// narrower than acquisition's: it answers won-or-lost and leaves the branch
// on staleness, reporting, and the error taxonomy to its caller.
describe("the atomic claim", () => {
  it.scoped("writes the pid under a free path and leaves no claim file behind", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const locks = yield* fs.makeTempDirectoryScoped();
      const file = `${locks}/t20.pid`;

      expect(yield* claimLockFile(file, process.pid)).toBe("claimed");
      expect(yield* fs.readFileString(file)).toBe(`${process.pid}\n`);
      // The temp file left with the attempt that made it: the runtime root is
      // a directory humans read, and a `.claim` beside a lock is debris.
      expect(yield* fs.readDirectory(locks)).toEqual(["t20.pid"]);
    }).pipe(Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer))),
  );

  it.scoped("answers collided rather than replacing a lock already in place", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const locks = yield* fs.makeTempDirectoryScoped();
      const file = `${locks}/t20.pid`;
      yield* fs.writeFileString(file, `${DEAD_PID}\n`);

      expect(yield* claimLockFile(file, process.pid)).toBe("collided");
      // `link` never overwrites, so losing a claim cannot cost the winner its
      // lock — whoever is recorded there is still recorded there.
      expect(yield* fs.readFileString(file)).toBe(`${DEAD_PID}\n`);
      expect(yield* fs.readDirectory(locks)).toEqual(["t20.pid"]);
    }).pipe(Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer))),
  );

  it.scoped("hands a free path to exactly one of two concurrent claims", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const locks = yield* fs.makeTempDirectoryScoped();
      const file = `${locks}/t20.pid`;

      const outcomes = yield* Effect.all(
        [claimLockFile(file, process.pid), claimLockFile(file, process.pid)],
        { concurrency: 2 },
      );
      expect(outcomes.filter((outcome) => outcome === "claimed")).toHaveLength(1);
      expect(yield* fs.readDirectory(locks)).toEqual(["t20.pid"]);
    }).pipe(Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer))),
  );

  it.scoped("keeps a claim that fails any other way in the error channel", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const locks = yield* fs.makeTempDirectoryScoped();
      // No directory to write the temp file into: not a collision, and the
      // caller is the one that decides what a broken path means.
      const outcome = yield* Effect.either(claimLockFile(`${locks}/absent/t20.pid`, process.pid));
      expect(Either.isLeft(outcome)).toBe(true);
    }).pipe(Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer))),
  );
});

const platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);

const witnessPath = (file: string, owner: number) => `${file}.${owner}.evicting`;

// An attempt number this process's own eviction counter cannot reach, so a
// marker a case places for the *live* pid — the only pid a test can prove
// alive — never lands on the path a real eviction is about to write.
const HELD_ATTEMPT = 100_000;

// A real `FileSystem` whose witness link reports that it has run and then
// waits, so a case can place an interrupt in the window between the witness
// appearing on disk and the finalizer that removes it. Only the witness's link
// stalls — the claim inside an eviction links too.
const stallingLink = (linked: Deferred.Deferred<void>, gate: Deferred.Deferred<void>) =>
  Layer.provide(
    Layer.effect(
      FileSystem.FileSystem,
      Effect.map(FileSystem.FileSystem, (fs) => ({
        ...fs,
        link: (from: string, to: string) =>
          to.endsWith(".evicting")
            ? fs
                .link(from, to)
                .pipe(
                  Effect.zipRight(Deferred.succeed(linked, undefined)),
                  Effect.zipRight(Deferred.await(gate)),
                )
            : fs.link(from, to),
      })),
    ),
    NodeFileSystem.layer,
  );

// What acquisition does while it holds the witness: free the path, then claim
// it through T20's primitive.
const evictAndClaim = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.remove(file, { force: true });
    return yield* claimLockFile(file, process.pid);
  });

// T21's witness: what `claim.ts` does for creation, done for removal. Its own
// contract is narrower than acquisition's — it hands the right to remove one
// dead lock to exactly one dispatch and says nothing about what that dispatch
// does with it, or about what the loser tells its user.
describe("the eviction witness", () => {
  it.scoped("removes the corpse under the witness and takes the witness away with it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const locks = yield* fs.makeTempDirectoryScoped();
      const file = `${locks}/t21.pid`;
      yield* fs.writeFileString(file, `${DEAD_PID}\n`);

      const evicted = yield* withEvictionWitness(file, Option.some(DEAD_PID), evictAndClaim(file));
      expect(evicted).toEqual(Option.some("claimed"));
      expect(yield* fs.readFileString(file)).toBe(`${process.pid}\n`);
      expect(yield* fs.readDirectory(locks)).toEqual(["t21.pid"]);
    }).pipe(Effect.provide(platform)),
  );

  it.scoped("answers none and removes nothing when that corpse is already being evicted", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const locks = yield* fs.makeTempDirectoryScoped();
      const file = `${locks}/t21.pid`;
      yield* fs.writeFileString(file, `${DEAD_PID}\n`);
      // The other dispatch's witness, taken a moment before this one looked.
      yield* fs.link(file, witnessPath(file, DEAD_PID));

      expect(yield* withEvictionWitness(file, Option.some(DEAD_PID), evictAndClaim(file))).toEqual(
        Option.none(),
      );
      // The corpse is the winner's to remove, and the witness is the winner's
      // to clear: the loser leaves both exactly as it found them.
      expect(yield* fs.readFileString(file)).toBe(`${DEAD_PID}\n`);
      expect((yield* fs.readDirectory(locks)).toSorted()).toEqual([
        "t21.pid",
        `t21.pid.${DEAD_PID}.evicting`,
      ]);
    }).pipe(Effect.provide(platform)),
  );

  // The tracer: two dispatches that found the same dead lock, both inside the
  // eviction at once. The kernel decides which one removes it.
  it.scoped("hands one corpse to exactly one of two concurrent evictions", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const locks = yield* fs.makeTempDirectoryScoped();
      const file = `${locks}/t21.pid`;
      yield* fs.writeFileString(file, `${DEAD_PID}\n`);

      const evicted = yield* Effect.all(
        [
          withEvictionWitness(file, Option.some(DEAD_PID), evictAndClaim(file)),
          withEvictionWitness(file, Option.some(DEAD_PID), evictAndClaim(file)),
        ],
        { concurrency: 2 },
      );
      expect(evicted.filter(Option.isSome)).toHaveLength(1);
      expect(yield* fs.readFileString(file)).toBe(`${process.pid}\n`);
      expect(yield* fs.readDirectory(locks)).toEqual(["t21.pid"]);
    }).pipe(Effect.provide(platform)),
  );

  // The late loser: a dispatch whose read of the dead owner predates another
  // dispatch's *whole* eviction, so the witness it names is free again by the
  // time it gets there. What it links is the winner's live lock — and the
  // witness names the generation this eviction may remove, which is not that
  // one. Without the check the loser's remove would take a live lock out from
  // under a run that is minutes into its work.
  it.scoped("removes nothing when the corpse it read has already been replaced", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const locks = yield* fs.makeTempDirectoryScoped();
      const file = `${locks}/t21.pid`;
      yield* fs.writeFileString(file, `${DEAD_PID}\n`);
      // The winner's eviction, start to finish: the corpse is gone, its lock
      // is in place, and the witness left with it.
      yield* withEvictionWitness(file, Option.some(DEAD_PID), evictAndClaim(file));

      expect(yield* withEvictionWitness(file, Option.some(DEAD_PID), evictAndClaim(file))).toEqual(
        Option.none(),
      );
      expect(yield* fs.readFileString(file)).toBe(`${process.pid}\n`);
      expect(yield* fs.readDirectory(locks)).toEqual(["t21.pid"]);
    }).pipe(Effect.provide(platform)),
  );

  it.scoped("is keyed to the dead owner, so an older witness never blocks a later eviction", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const locks = yield* fs.makeTempDirectoryScoped();
      const file = `${locks}/t21.pid`;
      // A `kill -9` mid-eviction, one corpse ago: a witness naming a pid that
      // is not the one this eviction read.
      yield* fs.writeFileString(witnessPath(file, DEAD_PID - 1), `${DEAD_PID - 1}\n`);
      yield* fs.writeFileString(file, `${DEAD_PID}\n`);

      expect(yield* withEvictionWitness(file, Option.some(DEAD_PID), evictAndClaim(file))).toEqual(
        Option.some("claimed"),
      );
      // The wreckage is the reconciler's, not this eviction's, so it stays.
      expect((yield* fs.readDirectory(locks)).toSorted()).toEqual([
        "t21.pid",
        `t21.pid.${DEAD_PID - 1}.evicting`,
      ]);
    }).pipe(Effect.provide(platform)),
  );

  it.scoped("takes the witness away when the eviction fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const locks = yield* fs.makeTempDirectoryScoped();
      const file = `${locks}/t21.pid`;
      yield* fs.writeFileString(file, `${DEAD_PID}\n`);

      const outcome = yield* Effect.either(
        withEvictionWitness(file, Option.some(DEAD_PID), Effect.fail("the eviction went wrong")),
      );
      expect(outcome).toEqual(Either.left("the eviction went wrong"));
      expect(yield* fs.readDirectory(locks)).toEqual(["t21.pid"]);
    }).pipe(Effect.provide(platform)),
  );

  it.scoped("takes the witness away when the eviction is interrupted", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const locks = yield* fs.makeTempDirectoryScoped();
      const file = `${locks}/t21.pid`;
      yield* fs.writeFileString(file, `${DEAD_PID}\n`);
      const held = yield* Deferred.make<void>();

      const fiber = yield* Effect.fork(
        withEvictionWitness(
          file,
          Option.some(DEAD_PID),
          Deferred.succeed(held, undefined).pipe(Effect.zipRight(Effect.never)),
        ),
      );
      yield* Deferred.await(held);
      // Really held while the eviction is in flight, or the assertion below
      // would pass against a witness that was never taken.
      expect(yield* fs.exists(witnessPath(file, DEAD_PID))).toBe(true);

      expect(Exit.isInterrupted(yield* Fiber.interrupt(fiber))).toBe(true);
      expect(yield* fs.exists(witnessPath(file, DEAD_PID))).toBe(false);
      // The corpse and nothing else: the evictor's own name goes with it, so
      // an interrupt leaves the next eviction of this generation a clean path.
      expect(yield* fs.readDirectory(locks)).toEqual(["t21.pid"]);
    }).pipe(Effect.provide(platform)),
  );

  // The window `claim.ts` does not have: its temp file is created inside the
  // region its finalizer covers, and the witness's link cannot be, because the
  // dispatch that loses the link must not run that finalizer. So the link is
  // the bracket's acquisition, and an interrupt that lands while it is in
  // flight is delivered to the eviction, where the finalizer is already
  // installed. Left interruptible it would strand the witness, and a stranded
  // witness refuses every later eviction of that same corpse.
  it.scoped("takes the witness away when the interrupt lands while the link is in flight", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const locks = yield* fs.makeTempDirectoryScoped();
      const file = `${locks}/t21.pid`;
      yield* fs.writeFileString(file, `${DEAD_PID}\n`);
      const linked = yield* Deferred.make<void>();
      const gate = yield* Deferred.make<void>();

      const fiber = yield* Effect.fork(
        withEvictionWitness(file, Option.some(DEAD_PID), Effect.void).pipe(
          Effect.provide(Layer.merge(stallingLink(linked, gate), NodePath.layer)),
        ),
      );
      // The witness is on disk and the link it came from has not returned yet:
      // exactly the moment an interrupt has nothing installed to clean up.
      yield* Deferred.await(linked);
      expect(yield* fs.exists(witnessPath(file, DEAD_PID))).toBe(true);

      const interrupting = yield* Effect.fork(Fiber.interrupt(fiber));
      yield* Deferred.succeed(gate, undefined);
      expect(Exit.isInterrupted(yield* Fiber.join(interrupting))).toBe(true);
      expect(yield* fs.exists(witnessPath(file, DEAD_PID))).toBe(false);
    }).pipe(Effect.provide(platform)),
  );

  it.scoped("keeps a link that fails any other way in the error channel", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const locks = yield* fs.makeTempDirectoryScoped();
      // No corpse to link from: not a collision, and the caller is the one
      // that decides what a broken path means.
      const outcome = yield* Effect.either(
        withEvictionWitness(`${locks}/t21.pid`, Option.none(), Effect.void),
      );
      expect(Either.isLeft(outcome)).toBe(true);
      // An acquisition that fails runs no release, so the marker it wrote on
      // the way in is taken back on the failure itself.
      expect(yield* fs.readDirectory(locks)).toEqual([]);
    }).pipe(Effect.provide(platform)),
  );
});

// T26: the fact the disk did not carry. The witness says which *corpse* is
// being evicted and the kernel says that exactly one dispatch may, but nothing
// said **who** — so a dispatch killed between the link and the removal left a
// state no later dispatch and no reconcile could tell from an eviction in
// flight, and the slug wedged. The evictor names itself beside the witness,
// before it takes it.
describe("the evictor beside the witness", () => {
  // The builder and the reader are one shape, asserted as one: the reconciler
  // groups a marker with its witness by the name the eviction wrote, so a
  // parse that disagreed with the build would silently vouch for nobody.
  it("reads back the evictor a marker names, and nothing else", () => {
    expect(evictorInMarkerName(evictorMarkerFor("t26.pid.4321.evicting", 99, 7))).toEqual(
      Option.some({ witness: "t26.pid.4321.evicting", evictor: 99 }),
    );
    expect(evictorInMarkerName("t26.pid.4321.evicting")).toEqual(Option.none());
    expect(evictorInMarkerName("t26.pid.4321.1.claim")).toEqual(Option.none());
    // Shaped like a marker, naming nothing that is a pid: it must not be able
    // to keep a stranded witness alive by looking like an evictor.
    expect(evictorInMarkerName("t26.pid.4321.evicting.later.7.evictor")).toEqual(Option.none());
    expect(evictorInMarkerName("t26.pid.4321.evicting.99.soon.evictor")).toEqual(Option.none());
    expect(evictorInMarkerName(".evictor")).toEqual(Option.none());
  });

  it.scoped("names this process beside the witness for as long as it holds it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const locks = yield* fs.makeTempDirectoryScoped();
      const file = `${locks}/t26.pid`;
      yield* fs.writeFileString(file, `${DEAD_PID}\n`);
      const during = yield* Ref.make<ReadonlyArray<string>>([]);

      yield* withEvictionWitness(
        file,
        Option.some(DEAD_PID),
        fs.readDirectory(locks).pipe(Effect.flatMap((entries) => Ref.set(during, entries))),
      );

      // Exactly one evictor, named by the eviction that was in flight — the
      // whole of what the sweep asks, read through the same parse it uses.
      expect(
        (yield* Ref.get(during)).flatMap((entry) => Option.toArray(evictorInMarkerName(entry))),
      ).toEqual([{ witness: `t26.pid.${DEAD_PID}.evicting`, evictor: process.pid }]);
      // And it leaves with the witness: an eviction that finished vouches for
      // nothing, or the next stranding on this path would read as in flight.
      expect(yield* fs.readDirectory(locks)).toEqual(["t26.pid"]);
    }).pipe(Effect.provide(platform)),
  );

  // The marker is per-eviction, not per-process, and this is why: the loser of
  // the link wrote one too. Sharing a path with the winner would mean the
  // loser's release took the winner's name away, and a witness with no live
  // evictor beside it is exactly what the reconciler sweeps.
  it.scoped("takes back only its own name when it loses the link", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const locks = yield* fs.makeTempDirectoryScoped();
      const file = `${locks}/t26.pid`;
      yield* fs.writeFileString(file, `${DEAD_PID}\n`);
      // The dispatch already inside the eviction, standing behind its witness.
      const witness = witnessPath(file, DEAD_PID);
      yield* fs.link(file, witness);
      const holder = evictorMarkerFor(witness, process.pid, HELD_ATTEMPT);
      yield* fs.writeFileString(holder, "");

      expect(yield* withEvictionWitness(file, Option.some(DEAD_PID), evictAndClaim(file))).toEqual(
        Option.none(),
      );

      expect((yield* fs.readDirectory(locks)).toSorted()).toEqual(
        [file, witness, holder].map((entry) => entry.slice(locks.length + 1)).toSorted(),
      );
    }).pipe(Effect.provide(platform)),
  );
});

describe("RunLock", () => {
  it.scoped("writes this process's pid under the runtime root and removes it on release", () =>
    Effect.gen(function* () {
      const scratch = yield* world();
      const fs = yield* FileSystem.FileSystem;
      const file = lockPathFor(scratch.runtimeRoot, BRANCH);

      yield* Effect.scoped(
        Effect.gen(function* () {
          const runLock = yield* RunLock;
          const claim = yield* runLock.acquire(BRANCH);
          expect(claim).toEqual({ path: file, pid: process.pid, reclaimed: false });
          expect(yield* fs.readFileString(file)).toBe(`${process.pid}\n`);
        }),
      ).pipe(Effect.provide(scratch.layer));

      expect(yield* fs.exists(file)).toBe(false);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped("releases the lock when the run fails", () =>
    Effect.gen(function* () {
      const scratch = yield* world();
      const fs = yield* FileSystem.FileSystem;
      const outcome = yield* Effect.either(
        Effect.scoped(
          Effect.gen(function* () {
            const runLock = yield* RunLock;
            yield* runLock.acquire(BRANCH);
            return yield* Effect.fail("the run went wrong");
          }),
        ).pipe(Effect.provide(scratch.layer)),
      );
      expect(Either.isLeft(outcome)).toBe(true);
      expect(yield* fs.exists(lockPathFor(scratch.runtimeRoot, BRANCH))).toBe(false);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // Matrix row 3: the second of two invocations refuses, and holds nothing.
  it.scoped("fails as a typed LockHeld when a live pid owns the branch", () =>
    Effect.gen(function* () {
      const scratch = yield* world();
      const fs = yield* FileSystem.FileSystem;
      const file = lockPathFor(scratch.runtimeRoot, BRANCH);
      yield* fs.makeDirectory(`${scratch.runtimeRoot}/locks`, { recursive: true });
      yield* fs.writeFileString(file, `${process.pid}\n`);

      const outcome = yield* Effect.either(
        Effect.scoped(RunLock.pipe(Effect.flatMap((runLock) => runLock.acquire(BRANCH)))).pipe(
          Effect.provide(scratch.layer),
        ),
      );
      expect(Either.isLeft(outcome)).toBe(true);
      if (Either.isLeft(outcome)) {
        expect(outcome.left._tag).toBe("LockHeld");
        expect(outcome.left.detail).toContain(`pid ${process.pid}`);
      }
      // Nothing acquired means nothing touched: the live run's lock file is
      // exactly as it left it, and the release path never ran over it.
      expect(yield* fs.readFileString(file)).toBe(`${process.pid}\n`);
      expect(warningsIn(yield* Ref.get(scratch.events))).toEqual([]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // Matrix row 4: reclaimed *inside* acquisition, reported, run proceeds.
  it.scoped("reclaims a lock whose owner is dead, reports it, and proceeds", () =>
    Effect.gen(function* () {
      const scratch = yield* world();
      const fs = yield* FileSystem.FileSystem;
      const file = lockPathFor(scratch.runtimeRoot, BRANCH);
      yield* fs.makeDirectory(`${scratch.runtimeRoot}/locks`, { recursive: true });
      yield* fs.writeFileString(file, `${DEAD_PID}\n`);

      yield* Effect.scoped(
        Effect.gen(function* () {
          const runLock = yield* RunLock;
          const claim = yield* runLock.acquire(BRANCH);
          expect(claim.reclaimed).toBe(true);
          // The reclaim happened during acquisition, so by the time anyone
          // sees the claim the file is already ours.
          expect(yield* fs.readFileString(file)).toBe(`${process.pid}\n`);
        }),
      ).pipe(Effect.provide(scratch.layer));

      const warnings = warningsIn(yield* Ref.get(scratch.events));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("reclaimed a stale lock");
      expect(warnings[0]).toContain(`pid ${DEAD_PID}`);
      expect(yield* fs.exists(file)).toBe(false);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped("reclaims a lock that records no pid at all", () =>
    Effect.gen(function* () {
      const scratch = yield* world();
      const fs = yield* FileSystem.FileSystem;
      const file = lockPathFor(scratch.runtimeRoot, BRANCH);
      yield* fs.makeDirectory(`${scratch.runtimeRoot}/locks`, { recursive: true });
      // A half-written lock from a run that died between create and write:
      // nobody can prove it live, so nobody may treat it as live.
      yield* fs.writeFileString(file, "");

      yield* Effect.scoped(
        Effect.gen(function* () {
          const runLock = yield* RunLock;
          expect((yield* runLock.acquire(BRANCH)).reclaimed).toBe(true);
        }),
      ).pipe(Effect.provide(scratch.layer));
      expect(warningsIn(yield* Ref.get(scratch.events))[0]).toContain("no live pid");
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // T20's tracer: two dispatches find the same dead owner, and exactly one of
  // them gets the branch. Both acquisitions share one `Scope` that stays open
  // across the race, so the loser cannot be a second winner that merely
  // arrived after the first had released.
  it.scoped("gives the branch to exactly one of two dispatches racing the same dead owner", () =>
    Effect.gen(function* () {
      const scratch = yield* world();
      const fs = yield* FileSystem.FileSystem;
      const locks = `${scratch.runtimeRoot}/locks`;
      const file = lockPathFor(scratch.runtimeRoot, BRANCH);
      yield* fs.makeDirectory(locks, { recursive: true });
      yield* fs.writeFileString(file, `${DEAD_PID}\n`);

      const raced = yield* Effect.scoped(
        Effect.gen(function* () {
          const runLock = yield* RunLock;
          const outcomes = yield* Effect.all(
            [Effect.either(runLock.acquire(BRANCH)), Effect.either(runLock.acquire(BRANCH))],
            { concurrency: 2 },
          );
          // Asked while both are still in scope: one lock file, holding the
          // winner, and no claim file left over from the loser.
          expect(yield* fs.readFileString(file)).toBe(`${process.pid}\n`);
          expect(yield* fs.readDirectory(locks)).toEqual([`${BRANCH}.pid`]);
          return outcomes;
        }),
      ).pipe(Effect.provide(scratch.layer));

      const held = raced.filter(Either.isRight);
      expect(held).toHaveLength(1);
      expect(held[0]?.right.reclaimed).toBe(true);
      const refused = raced.filter(Either.isLeft);
      expect(refused).toHaveLength(1);
      expect(refused[0]?.left._tag).toBe("LockHeld");
      expect(refused[0]?.left.detail).toContain("got to the stale lock");
      // One reclaim, so one report of it: the dispatch that lost took the
      // branch from nobody and has nothing to say about the corpse.
      expect(warningsIn(yield* Ref.get(scratch.events))).toHaveLength(1);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // T21: the loser of an eviction removes nothing. The witness is already in
  // place here, which is the same state the losing dispatch of the tracer
  // above finds — deterministically, and without racing for it.
  it.scoped("refuses when another dispatch already holds the eviction witness", () =>
    Effect.gen(function* () {
      const scratch = yield* world();
      const fs = yield* FileSystem.FileSystem;
      const locks = `${scratch.runtimeRoot}/locks`;
      const file = lockPathFor(scratch.runtimeRoot, BRANCH);
      yield* fs.makeDirectory(locks, { recursive: true });
      yield* fs.writeFileString(file, `${DEAD_PID}\n`);
      yield* fs.link(file, witnessPath(file, DEAD_PID));

      const outcome = yield* Effect.either(
        Effect.scoped(RunLock.pipe(Effect.flatMap((runLock) => runLock.acquire(BRANCH)))).pipe(
          Effect.provide(scratch.layer),
        ),
      );
      expect(Either.isLeft(outcome)).toBe(true);
      if (Either.isLeft(outcome)) {
        expect(outcome.left._tag).toBe("LockHeld");
        // Present tense, and this is the case that earns it: the dispatch
        // holding the witness is evicting *right now*, so a refusal saying the
        // reclaim had already happened would be wrong on the one path a
        // dispatcher hits most.
        expect(outcome.left.detail).toContain("got to the stale lock");
      }
      // The corpse belongs to the dispatch holding the witness: this one read
      // it, lost the eviction, and touched nothing.
      expect(yield* fs.readFileString(file)).toBe(`${DEAD_PID}\n`);
      expect((yield* fs.readDirectory(locks)).toSorted()).toEqual([
        `${BRANCH}.pid`,
        `${BRANCH}.pid.${DEAD_PID}.evicting`,
      ]);
      // Nothing was reclaimed, so nothing is reported as reclaimed.
      expect(warningsIn(yield* Ref.get(scratch.events))).toEqual([]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // T21's release half, independent of any race: the finalizer removes a lock
  // only while it still records this run. Whatever interleaving took the file
  // away, deleting whoever holds it now would be this dispatch reaching into
  // a live run's state on its way out.
  it.scoped("leaves a lock alone on release when another pid records it", () =>
    Effect.gen(function* () {
      const scratch = yield* world();
      const fs = yield* FileSystem.FileSystem;
      const file = lockPathFor(scratch.runtimeRoot, BRANCH);

      yield* Effect.scoped(
        Effect.gen(function* () {
          const runLock = yield* RunLock;
          yield* runLock.acquire(BRANCH);
          yield* fs.writeFileString(file, `${DEAD_PID}\n`);
        }),
      ).pipe(Effect.provide(scratch.layer));

      expect(yield* fs.readFileString(file)).toBe(`${DEAD_PID}\n`);
      const warnings = warningsIn(yield* Ref.get(scratch.events));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("no longer this run's");
      expect(warnings[0]).toContain(`pid ${DEAD_PID}`);
      // Reported is not released, here as in the unremovable case below.
      expect(
        (yield* Ref.get(scratch.events)).filter((event) => event._tag === "ResourceReleased"),
      ).toEqual([]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped("keeps a broken lock path typed as LockError, never as LockHeld", () =>
    Effect.gen(function* () {
      const scratch = yield* world();
      const fs = yield* FileSystem.FileSystem;
      // A directory where the PID file belongs: the exclusive create cannot
      // succeed and no owner can be read, but nobody holds the branch.
      yield* fs.makeDirectory(lockPathFor(scratch.runtimeRoot, BRANCH), { recursive: true });

      const outcome = yield* Effect.either(
        Effect.scoped(RunLock.pipe(Effect.flatMap((runLock) => runLock.acquire(BRANCH)))).pipe(
          Effect.provide(scratch.layer),
        ),
      );
      expect(Either.isLeft(outcome)).toBe(true);
      if (Either.isLeft(outcome)) {
        expect(outcome.left._tag).toBe("LockError");
      }
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
});

describe("the run's scope", () => {
  it.scoped("writes exactly one terminal row, derived from the plan", () =>
    Effect.gen(function* () {
      const scratch = yield* world();
      yield* runInScope(
        scratch.plan,
        scratch.repoRoot,
        TEST_CREDENTIAL,
        TEST_FORGE_REPO,
        () => Effect.void,
      ).pipe(Effect.provide(scratch.layer));

      const rows = yield* Ref.get(scratch.appended);
      expect(rows).toHaveLength(1);
      const row = rows[0];
      expect(row?.branch).toBe(BRANCH);
      expect(row?.identity).toEqual(scratch.plan.identity);
      expect(row?.terminalReason).toEqual(Option.some({ _tag: "Completed" }));
      expect(row?.base).toEqual({ ref: "origin/master", sha: Option.some(BASE_SHA) });
      expect(row?.mergeBaseSha).toEqual(Option.some(MERGE_BASE_SHA));
      // Both ends recorded, and an id that is not fabricated absence.
      expect(Option.isSome(row?.startedAt ?? Option.none())).toBe(true);
      expect(Option.isSome(row?.runId ?? Option.none())).toBe(true);
      // The review rounds ran inside the scope and the fake reviewer never
      // approves, so the row carries what they decided beside why the run
      // stopped — two questions, two fields (T10).
      expect(row?.outcome).toEqual(Option.some("needs-work"));
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped("opens the run log only after the lock, and writes no row when refused", () =>
    Effect.gen(function* () {
      const scratch = yield* world();
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(`${scratch.runtimeRoot}/locks`, { recursive: true });
      yield* fs.writeFileString(lockPathFor(scratch.runtimeRoot, BRANCH), `${process.pid}\n`);

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
        expect(outcome.left._tag).toBe("LockHeld");
      }
      // A refused dispatch must not touch the live run's log
      // (run.sh:1210-1221), and it owes no ledger row: it never started.
      expect(yield* fs.exists(Option.getOrThrow(scratch.plan.logPath))).toBe(false);
      expect(yield* Ref.get(scratch.appended)).toEqual([]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped("logs through the run log as a second subscriber to the same events", () =>
    Effect.gen(function* () {
      const scratch = yield* world();
      const fs = yield* FileSystem.FileSystem;
      yield* runInScope(scratch.plan, scratch.repoRoot, TEST_CREDENTIAL, TEST_FORGE_REPO, () =>
        Reporter.pipe(
          Effect.flatMap((reporter) => reporter.emit({ _tag: "Warned", detail: "in-run event" })),
        ),
      ).pipe(Effect.provide(scratch.layer));

      const log = yield* fs.readFileString(Option.getOrThrow(scratch.plan.logPath));
      expect(log).toContain("run start");
      expect(log).toContain("in-run event");
      // The console subscriber saw it too — one stream, two renderers.
      expect(warningsIn(yield* Ref.get(scratch.events))).toEqual(["in-run event"]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // Matrix row 16, at the depth this ticket has: Ctrl-C reaches the finalizers
  // through `NodeRuntime.runMain`'s interrupt of the main fiber, so a fiber
  // interrupt here is the same path a signal takes.
  it.scoped("releases the lock and records an interrupted row on interrupt", () =>
    Effect.gen(function* () {
      const scratch = yield* world();
      const fs = yield* FileSystem.FileSystem;
      const started = yield* Deferred.make<void>();

      const fiber = yield* Effect.fork(
        runInScope(scratch.plan, scratch.repoRoot, TEST_CREDENTIAL, TEST_FORGE_REPO, () =>
          Deferred.succeed(started, undefined).pipe(Effect.zipRight(Effect.never)),
        ).pipe(Effect.provide(scratch.layer)),
      );
      yield* Deferred.await(started);
      // The lock is really held while the run is in flight.
      expect(yield* fs.exists(lockPathFor(scratch.runtimeRoot, BRANCH))).toBe(true);

      const exit = yield* Fiber.interrupt(fiber);
      expect(Exit.isInterrupted(exit)).toBe(true);
      expect(yield* fs.exists(lockPathFor(scratch.runtimeRoot, BRANCH))).toBe(false);
      const rows = yield* Ref.get(scratch.appended);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.terminalReason).toEqual(Option.some({ _tag: "Interrupted" }));
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // Matrix row 22 at one-resource depth: a defect releases everything, writes
  // `crashed`, and is rethrown rather than swallowed.
  it.scoped("records a crashed row and rethrows a defect", () =>
    Effect.gen(function* () {
      const scratch = yield* world();
      const fs = yield* FileSystem.FileSystem;
      const exit = yield* Effect.exit(
        runInScope(scratch.plan, scratch.repoRoot, TEST_CREDENTIAL, TEST_FORGE_REPO, () =>
          Effect.die("impossible state"),
        ).pipe(Effect.provide(scratch.layer)),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(yield* fs.exists(lockPathFor(scratch.runtimeRoot, BRANCH))).toBe(false);
      expect((yield* Ref.get(scratch.appended))[0]?.terminalReason).toEqual(
        Option.some({ _tag: "Crashed" }),
      );
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // Matrix row 19, the lock's half: a release that cannot remove the file is
  // reported and swallowed rather than becoming a defect that masks the run.
  // The lock path is turned into a non-empty directory mid-run, which is the
  // shape `run-lock.ts` already calls out as "not a collision, a broken host".
  it.scoped("warns and swallows when the lock file itself cannot be removed", () =>
    Effect.gen(function* () {
      const scratch = yield* world();
      const fs = yield* FileSystem.FileSystem;
      const lockPath = lockPathFor(scratch.runtimeRoot, BRANCH);

      const outcome = yield* Effect.either(
        runInScope(scratch.plan, scratch.repoRoot, TEST_CREDENTIAL, TEST_FORGE_REPO, () =>
          fs
            .remove(lockPath)
            .pipe(
              Effect.zipRight(fs.makeDirectory(lockPath)),
              Effect.zipRight(fs.writeFileString(`${lockPath}/held`, "not empty\n")),
              Effect.orDie,
              Effect.as("the run itself was fine"),
            ),
        ).pipe(Effect.provide(scratch.layer)),
      );

      // The run keeps its own outcome, and the lock's failure is a warning
      // pointing at what clears it.
      expect(outcome).toEqual(Either.right("the run itself was fine"));
      const warnings = warningsIn(yield* Ref.get(scratch.events));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("could not remove the run lock");
      expect(warnings[0]).toContain(lockPath);
      expect((yield* Ref.get(scratch.appended))[0]?.terminalReason).toEqual(
        Option.some({ _tag: "Completed" }),
      );
      // Reported is not released: the event that says the lock let go is only
      // emitted when it really did.
      expect(
        (yield* Ref.get(scratch.events)).filter((event) => event._tag === "ResourceReleased"),
      ).toEqual([
        { _tag: "ResourceReleased", resource: "sandbox" },
        { _tag: "ResourceReleased", resource: "checkout" },
      ]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // Matrix row 20: the append is the failure, so there is no row to write it
  // in — everything releases, the run keeps its own outcome, and the warning
  // points at the file that does hold the truth.
  it.scoped("warns loudly and stays non-fatal when the ledger append fails", () =>
    Effect.gen(function* () {
      const scratch = yield* world({ appendFails: true });
      const fs = yield* FileSystem.FileSystem;
      const outcome = yield* Effect.either(
        runInScope(scratch.plan, scratch.repoRoot, TEST_CREDENTIAL, TEST_FORGE_REPO, () =>
          Effect.succeed("done"),
        ).pipe(Effect.provide(scratch.layer)),
      );
      expect(outcome).toEqual(Either.right("done"));
      expect(yield* fs.exists(lockPathFor(scratch.runtimeRoot, BRANCH))).toBe(false);

      const warnings = warningsIn(yield* Ref.get(scratch.events));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("ledger row not written");
      expect(warnings[0]).toContain(Option.getOrThrow(scratch.plan.logPath));
      // Loudly enough to survive the run: the log file carries it too.
      expect(yield* fs.readFileString(Option.getOrThrow(scratch.plan.logPath))).toContain(
        "ledger row not written",
      );
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
});
