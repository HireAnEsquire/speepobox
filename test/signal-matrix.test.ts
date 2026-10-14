// The signal matrix (SPEC §4, matrix rows 16-17) at three-resource depth, and
// the single teardown path all four of its rows run through.
//
// Nothing here acquires anything new: `NodeRuntime.runMain` interrupts the
// main fiber on SIGINT and SIGTERM, `bin.ts` re-raises SIGHUP into that same
// handler, and every `Effect.acquireRelease` finalizer in the run's `Scope`
// already runs on an interrupt. So a fiber interrupt *is* the path a signal
// takes, and what these cases prove is that the release the scope already owes
// covers the lock, the checkout, and the container together, in reverse.
//
// The two rows this tier cannot reach are here as the state they leave rather
// than as the exit itself: a second Ctrl-C and a `kill -9` skip every
// finalizer, which is not something an in-process test can simulate, so the
// assertion is that the world mid-run is one a reconciler can read — no ledger
// row yet, a lock naming a live pid, a container. Live case 5 sends the real
// signals to a real child (`test/live/signal-matrix.live.test.ts`).
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { FileSystem } from "@effect/platform";
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { DateTime, Deferred, Effect, Exit, Fiber, Layer, Option, Ref } from "effect";
import { BessemerConfig, defaultConfig } from "../src/config/config.ts";
import { packageRoot } from "../src/config/paths.ts";
import { lockPathFor, planFor, specDispatch } from "../src/dispatch/plan.ts";
import { runInScope } from "../src/dispatch/run.ts";
import { exitCodeFor } from "../src/exit-code.ts";
import { Ledger } from "../src/ledger/ledger.ts";
import type { RunRecord } from "../src/ledger/record.ts";
import { isProcessAlive, parsePid } from "../src/lock/liveness.ts";
import { RunLockLive } from "../src/lock/run-lock.ts";
import { Reporter, type ReporterEvent, type RunResource } from "../src/reporter.ts";
import type { SandboxSpec } from "../src/sandbox/spec.ts";
import { fakeAgentCli } from "./support/agent-cli-fake.ts";
import { TEST_CREDENTIAL } from "./support/credential.ts";
import { TEST_FORGE_REPO } from "./support/repo-slug.ts";
import { fakeGit, type GitCall } from "./support/git-fake.ts";
import { fakeForge } from "./support/forge-fake.ts";
import { fakeNotifier } from "./support/notifier-fake.ts";
import { fakeSandbox } from "./support/sandbox-fake.ts";
import { PLAN_TIP } from "./support/plan.ts";

const BRANCH = "bessemer-t19";
const BASE_SHA = "1111111111111111111111111111111111111111";
const MERGE_BASE_SHA = "2222222222222222222222222222222222222222";

// All three resources, really held: a real PID file under a scratch runtime
// root, a checkout the fake clone really creates, and a sandbox that emits the
// acquired/released pair the ordering assertion reads.
const world = () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const runtimeRoot = yield* fs.makeTempDirectoryScoped();
    const repoRoot = yield* fs.makeTempDirectoryScoped();
    const events = yield* Ref.make<ReadonlyArray<ReporterEvent>>([]);
    const appended = yield* Ref.make<ReadonlyArray<RunRecord>>([]);
    const gitCalls = yield* Ref.make<ReadonlyArray<GitCall>>([]);
    const sandboxes = yield* Ref.make<ReadonlyArray<SandboxSpec>>([]);

    const plan = planFor({
      ...specDispatch(`${runtimeRoot}/tasks/T19.md`),
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
          append: (record) => Ref.update(appended, (current) => [...current, record]),
          recent: () => Effect.succeed([]),
          lastBaseForBranch: () => Effect.succeed(Option.none()),
          resolveResume: () => Effect.die("a signal never resumes"),
          newestBranchForIssue: () => Effect.die("a signal dispatches no feature"),
        }),
      ),
    );

    return { runtimeRoot, repoRoot, events, appended, sandboxes, plan, layer };
  });

// The ordering observable (SPEC §11): acquisition and release as a plain list
// of values, so "released in reverse" is a value comparison rather than an
// inspection of the code that did it.
const resourceEvents = (
  events: ReadonlyArray<ReporterEvent>,
): ReadonlyArray<{ readonly _tag: string; readonly resource: RunResource }> =>
  events.flatMap((event) =>
    event._tag === "ResourceAcquired" || event._tag === "ResourceReleased"
      ? [{ _tag: event._tag, resource: event.resource }]
      : [],
  );

const acquired = (resource: RunResource) => ({ _tag: "ResourceAcquired", resource });
const released = (resource: RunResource) => ({ _tag: "ResourceReleased", resource });

type Scratch = Effect.Effect.Success<ReturnType<typeof world>>;

// A run held open with all three resources acquired: the fake tier's hold
// point is the work, because the setup hook is a step inside the same scope
// and holds exactly what the work holds. Live case 5's hold point is the hook
// itself, which is what makes a real signal land mid-run without `dispatch`
// growing a test-only flag.
const heldRun = (scratch: Scratch, held: Deferred.Deferred<void>) =>
  Effect.fork(
    runInScope(scratch.plan, scratch.repoRoot, TEST_CREDENTIAL, TEST_FORGE_REPO, () =>
      Deferred.succeed(held, undefined).pipe(Effect.zipRight(Effect.never)),
    ).pipe(Effect.provide(scratch.layer)),
  );

describe("the run's scope under a signal", () => {
  // Matrix row 16, at the depth the release path is actually used: Ctrl-C, or
  // a closed terminal tab arriving as the same interrupt through `bin.ts`'s
  // re-raise. The bash leak this closes is the macOS 3.2 EXIT trap that never
  // fires for a backgrounded function's subshell (`run.sh:1024-1027`) — here
  // there is no trap to miss, only finalizers the scope owes.
  it.scoped("releases sandbox, checkout, and lock in reverse and records interrupted", () =>
    Effect.gen(function* () {
      const scratch = yield* world();
      const fs = yield* FileSystem.FileSystem;
      const held = yield* Deferred.make<void>();
      const lockPath = lockPathFor(scratch.runtimeRoot, BRANCH);

      const fiber = yield* heldRun(scratch, held);
      yield* Deferred.await(held);

      // Really held, all three, before the signal: a teardown assertion over a
      // run that had acquired nothing would pass just as happily.
      expect(yield* fs.exists(lockPath)).toBe(true);
      expect(yield* fs.exists(scratch.plan.checkoutPath)).toBe(true);
      expect((yield* Ref.get(scratch.sandboxes)).map((spec) => spec.name)).toEqual([
        scratch.plan.containerId,
      ]);

      const exit = yield* Fiber.interrupt(fiber);
      expect(Exit.isInterrupted(exit)).toBe(true);

      // The ordering invariant, read off the test `Reporter`'s `Ref`.
      expect(resourceEvents(yield* Ref.get(scratch.events))).toEqual([
        acquired("lock"),
        acquired("checkout"),
        acquired("sandbox"),
        released("sandbox"),
        released("checkout"),
        released("lock"),
      ]);
      // And the world agrees with the events: nothing left on this host.
      expect(yield* fs.exists(lockPath)).toBe(false);
      expect(yield* fs.exists(scratch.plan.checkoutPath)).toBe(false);

      // Exactly one row, and it says how the run ended (SPEC §11).
      const rows = yield* Ref.get(scratch.appended);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.terminalReason).toEqual(Option.some({ _tag: "Interrupted" }));

      // The same exit the entrypoint's teardown reads: 130, not the 0 an
      // interrupted-but-tidy run reported before T19.
      expect(exitCodeFor(exit, undefined)).toBe(130);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // Matrix row 17's fake-tier half. A second Ctrl-C and a `kill -9` run no
  // finalizer at all — `runMain` removes its own SIGINT handler when the first
  // one fires, so the second signal gets node's default action — which is not
  // an exit an in-process test can produce. What it *can* pin is the state
  // such an exit freezes: the ledger row is written from inside the scope, so
  // a run killed while it is held has written none, and the lock still names a
  // live pid beside a container that is still there. That triple is exactly
  // what T8's reconciler reads, and it is the reason a row exists iff the lock
  // was acquired.
  it.scoped("leaves a hard exit no ledger row, and state the reconciler can read", () =>
    Effect.gen(function* () {
      const scratch = yield* world();
      const fs = yield* FileSystem.FileSystem;
      const held = yield* Deferred.make<void>();
      const lockPath = lockPathFor(scratch.runtimeRoot, BRANCH);

      const fiber = yield* heldRun(scratch, held);
      yield* Deferred.await(held);

      // No row yet, and none owed until the scope closes: a process that dies
      // here writes nothing, which is what row 17 says and what makes the
      // reconciler — not the ledger — the thing that reports the run.
      expect(yield* Ref.get(scratch.appended)).toEqual([]);
      // The lock names an owner the liveness predicate calls alive, so a
      // reconciler meeting it while this process ran would leave it alone.
      const owner = parsePid(yield* fs.readFileString(lockPath));
      expect(owner).toEqual(Option.some(process.pid));
      expect(isProcessAlive(process.pid)).toBe(true);
      // The other two the reconciler sees: a container and its checkout.
      expect((yield* Ref.get(scratch.sandboxes)).map((spec) => spec.name)).toEqual([
        scratch.plan.containerId,
      ]);
      expect(yield* fs.exists(scratch.plan.checkoutPath)).toBe(true);

      // This case's own exit is an ordinary interrupt: the hard one is live
      // case 5's, with a real `kill -9` against a real child.
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
});

// Reading source is the only way to assert an absence from the tier that runs
// in CI, and the absence is the ticket: SIGHUP reaching a handler that tore
// down itself would typecheck, pass every case above, and race the runtime's
// teardown on a real hangup — two releases for one run. `live-tier-tag.test.ts`
// asserts its own wiring the same way and for the same reason.
const SOURCE_ROOT = join(packageRoot, "src");

const sourceFiles = (dir: string): ReadonlyArray<string> =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(full);
    }
    return entry.name.endsWith(".ts") ? [full] : [];
  });

// Comments name the banned shapes at their sites — that is how the rulings are
// documented — so only code counts here, as `scripts/check-bans.ts` does it.
const codeOf = (file: string): string =>
  readFileSync(file, "utf8")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");

// Every spelling node takes a handler by, not just the one `bin.ts` happens to
// use: `process.once("SIGINT", …)` releasing the lock is the same second
// teardown as `process.on` would be, and an absence only one spelling can trip
// is an absence nobody asserted. One string, so the count below and the shape
// check under it cannot come to know different sets of them.
const REGISTRATION = String.raw`process\.(?:on|once|addListener|prependListener|prependOnceListener)\(`;

const registrations = (code: string): ReadonlyArray<string> =>
  code.match(new RegExp(REGISTRATION, "g")) ?? [];

describe("the one teardown path", () => {
  it("registers exactly one signal handler in src, and it releases nothing", () => {
    const registering = sourceFiles(SOURCE_ROOT)
      .map((file) => ({ file: relative(packageRoot, file), code: codeOf(file) }))
      .filter((source) => registrations(source.code).length > 0);

    // The entrypoint, and nowhere else. A handler in a service or a step is a
    // second teardown by construction: it outlives the scope it would be
    // releasing.
    expect(registering.map((source) => source.file)).toEqual([join("src", "bin.ts")]);
    const bin = registering[0]?.code ?? "";
    expect(registrations(bin)).toHaveLength(1);

    // And the one that is there re-raises rather than tears down: SIGHUP is
    // not on `runMain`'s list (measured in T4), so `bin.ts` hands the hangup to
    // the SIGINT handler that is, and the single teardown stays single.
    const handler = new RegExp(
      `${REGISTRATION}\\s*"(?<signal>[A-Z]+)",\\s*\\(\\)\\s*=>\\s*\\{(?<body>[^}]*)\\}`,
    ).exec(bin);
    expect(handler?.groups?.signal).toBe("SIGHUP");
    expect(
      (handler?.groups?.body ?? "")
        .split(";")
        .map((statement) => statement.trim())
        .filter((statement) => statement !== ""),
    ).toEqual(['process.kill(process.pid, "SIGINT")']);
  });
});
