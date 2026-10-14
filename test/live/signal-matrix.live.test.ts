// Live case 5 (SPEC §11): **the signal matrix**, against real processes and
// real signals. Ctrl-C once, Ctrl-C twice, SIGHUP, `kill -9` — each one sent
// to a real `node src/bin.ts` holding a real lock, a real checkout, and a real
// container, and each one asserting what the host holds afterwards.
//
// These are **regression tests first**. SIGHUP-teardown and the second Ctrl-C
// are new behaviour with no bash equivalent — bash leaks a container silently
// when a terminal tab closes — and an untested signal path is exactly what
// bash had. Nothing here is a fake's opinion: the fake tier already asserts
// that an interrupt runs the finalizers (`test/signal-matrix.test.ts`), and
// "our finalizer ran" is not "dockerd has no container".
//
// **The hold point is T7's setup hook**, which is why this case can exist
// without a test-only flag anywhere near `dispatch`: the hook is
// config-declared, so the run is parked by pointing `setup-hook` at a script
// that sleeps, exactly as a host points it at its own. By the time the marker
// that script touches appears on this side of the mount, all three resources
// are held and the signal has somewhere to land.
//
// Two facts about the host shape everything below. The child resolves the
// repo root for itself, by walking up from its own source (AGENTS.md) — there
// is no flag to point a dispatch elsewhere — so this case runs in the **real
// repo**, its containers carry the **host's own label scope**, and it creates
// a throwaway branch it deletes on the way out. Which means: cleanup addresses
// this case's own container by the id its plan derived, and `sweepOwned` is
// never called here — a label sweep would take the user's live dispatches with
// it. Each case also clones this repo for real, into a temp runtime root it
// removes again; four real dispatches are what "real processes, real signals"
// costs.
import { spawn } from "node:child_process";
import { join } from "node:path";
import { describe, expect } from "@effect/vitest";
import { FileSystem } from "@effect/platform";
import type { CommandExecutor } from "@effect/platform/CommandExecutor";
import { NodeContext } from "@effect/platform-node";
import { DateTime, Deferred, Effect, Exit, Option, Schedule, Schema, type Scope } from "effect";
import { findRepoRoot, packageRoot } from "../../src/config/paths.ts";
import { lockPathFor, planFor, specDispatch } from "../../src/dispatch/plan.ts";
import { INTERRUPTED_EXIT_CODE } from "../../src/exit-code.ts";
import { LEDGER_FILENAME } from "../../src/ledger/ledger.ts";
import { RunRecord } from "../../src/ledger/record.ts";
import { exec } from "../../src/internal/exec.ts";
import { isProcessAlive, parsePid } from "../../src/lock/liveness.ts";
import { WORKSPACE_TARGET } from "../../src/sandbox/spec.ts";
import { docker, dockerdIsUp, itLive, LIVE_IMAGE, ownedContainers } from "./live.ts";
import { PLAN_TIP } from "../support/plan.ts";

// The entrypoint, run the way the distribution model says it is run: plain
// node over the source, no transform step (AGENTS.md, the tracer). A case that
// spawned vitest's transformed copy would be asserting about a file no
// dispatcher ever runs.
const DISPATCH_ENTRYPOINT = join(packageRoot, "src", "bin.ts");

// The marker the hold script touches, in the workspace — which is the run's
// checkout, bound read-write because the agent commits into it, so a container
// that cannot write there cannot dispatch at all. Its appearance on this side
// is the harness's proof that the lock, the checkout, and the container are
// all held. The two sides name one place: the container's from the mount
// target the spec renders, this side's from the checkout it is mounted from.
const HOLD_MARKER = ".speepobox-live-held";

const HOLD_SCRIPT = `#!/usr/bin/env bash
# Live case 5's hold point (T19): a config-declared setup hook that parks the
# run with all three resources held, so a real signal has somewhere to land.
set -eu
touch "${WORKSPACE_TARGET}/${HOLD_MARKER}"
# Longer than any case here: every one of them ends this container by signal.
sleep 600
`;

// How long the run gets to reach its hold point: a real clone of a real repo
// plus a container start, on a host that may be pulling nothing but is not
// necessarily fast. Deliberately under `vitest.live.config.ts`'s 120-second
// `testTimeout`, which is the budget for the *whole* case — signal, exit, and
// the docker questions after it included. A deadline at the budget can never
// fire: vitest would kill the case first and report its own timeout in place
// of the sentence below, which carries the run's output and is the only thing
// that says why a run never held anything.
const HOLD_DEADLINE = "90 seconds";

// The gap before the second Ctrl-C, and it is a two-sided window. It must be
// **long enough** that `runMain`'s SIGINT handler has already run and removed
// itself — that is what makes the second signal node's default action rather
// than a duplicate interrupt the runtime absorbs — and **short enough** that
// the teardown it interrupts has not got as far as the ledger append, which is
// the first thing the scope does on the way out. The child's event loop is
// idle against a `docker exec` when the first signal lands, so the handler
// runs in about a millisecond; the append waits on that exec's own teardown
// first. If this case ever goes red on the exit assertion alone, it is
// reporting which side of that window the host fell on, not a behaviour
// change.
const SECOND_INTERRUPT_AFTER = "25 millis";

interface ChildExit {
  readonly code: number | null;
  readonly signal: string | null;
}

interface DispatchChild {
  readonly pid: number;
  readonly signal: (name: NodeJS.Signals) => Effect.Effect<void>;
  readonly exited: Effect.Effect<ChildExit>;
  // Everything the run said, for the assertions to fail *with*: a run that
  // never reached its hold point otherwise fails as a diff of container names.
  readonly transcript: () => string;
}

const describeExit = (exit: ChildExit): string =>
  exit.signal === null ? `exited ${exit.code}` : `died on ${exit.signal}`;

// A run that tore down and reported the interrupt's code, said as a sentence
// so the failure carries the child's own output (live case 1's idiom).
const INTERRUPTED_CLEANLY = `exited ${INTERRUPTED_EXIT_CODE}, the interrupt's code`;

const howItEnded = (exit: ChildExit, transcript: string): string =>
  exit.code === INTERRUPTED_EXIT_CODE && exit.signal === null
    ? INTERRUPTED_CLEANLY
    : `${describeExit(exit)} — the run's output was:\n${transcript}`;

const howItDied = (exit: ChildExit, transcript: string): string =>
  exit.signal === null
    ? `${describeExit(exit)} — the run's output was:\n${transcript}`
    : exit.signal;

// git, for the throwaway branch this case dispatches. Through the subprocess
// chokepoint like everything else; a git that will not run is this tier's
// precondition rather than a case, so it dies.
const git = (...args: ReadonlyArray<string>): Effect.Effect<string, never, CommandExecutor> =>
  exec("git", ...args).pipe(
    Effect.mapError(
      (error) => `verify:live needs a working git on PATH — ${error.detail}. This is host-only.`,
    ),
    Effect.flatMap((result) =>
      result.exitCode === 0
        ? Effect.succeed(result.stdout.trim())
        : Effect.fail(`git ${args.join(" ")} exited ${result.exitCode} — ${result.stderr.trim()}`),
    ),
    Effect.orDie,
  );

const world = (what: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    // The same walk the child does with the same starting point, so the labels
    // this case queries are the labels that child stamps.
    const repoRoot = findRepoRoot(packageRoot);
    const runtimeRoot = yield* fs.makeTempDirectoryScoped();
    // The hook and the spec live outside the repo: a `setup-hook` may be
    // absolute, and a spec path with a slash is used as-is, so neither of them
    // needs a file written into the host's working tree.
    const scratch = yield* fs.makeTempDirectoryScoped();
    const hookPath = join(scratch, "hold.sh");
    yield* fs.writeFileString(hookPath, HOLD_SCRIPT);
    const specPath = join(scratch, `${what}.md`);
    yield* fs.writeFileString(
      specPath,
      "# live case 5: no agent reads this — the run is signalled at its setup hook\n",
    );

    // The pid keeps two runs of this file, or a container a hard kill left
    // behind, from colliding on a branch, a lock, or a container name.
    const branch = `speepobox-live-${what}-${process.pid}`;
    const baseSha = yield* git("-C", repoRoot, "rev-parse", "HEAD");
    // A branch of this repo's own tip, deleted again by `cleanup`. It has to
    // exist and it may not be checked out: the guards say so, and the clone
    // needs something to clone.
    yield* git("-C", repoRoot, "branch", branch, baseSha);
    // `--base` as a SHA, so this case does not depend on the host having an
    // `origin/master` to resolve.
    const plan = planFor({
      ...specDispatch(specPath),
      branch,
      baseRef: baseSha,
      baseSha,
      mergeBaseSha: baseSha,
      tipSha: PLAN_TIP,
      runtimeRoot,
      startedAt: DateTime.unsafeMake("2026-01-01T00:00:00.000Z"),
    });

    return {
      repoRoot,
      runtimeRoot,
      hookPath,
      specPath,
      branch,
      baseSha,
      plan,
      lockPath: lockPathFor(runtimeRoot, plan.slug),
      marker: join(plan.checkoutPath, HOLD_MARKER),
    };
  });

type Scratch = Effect.Effect.Success<ReturnType<typeof world>>;

// Whatever the case did: this host keeps no container and no branch of ours.
// The container is addressed by id — never by a label sweep, which in this
// case's label scope is the user's own dispatches — and a `docker rm` that
// finds nothing is the ordinary answer, not a failure.
const cleanup = (scratch: Scratch): Effect.Effect<void, never, CommandExecutor> =>
  Effect.all(
    [
      docker("rm", "-fv", scratch.plan.containerId),
      exec("git", "-C", scratch.repoRoot, "branch", "-D", scratch.branch).pipe(Effect.ignore),
    ],
    { discard: true },
  );

const spawnDispatch = (
  scratch: Scratch,
): Effect.Effect<DispatchChild, never, Scope.Scope | FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const exited = yield* Deferred.make<ChildExit>();
    let transcript = "";

    const child = yield* Effect.acquireRelease(
      Effect.sync(() =>
        spawn(
          process.execPath,
          [
            DISPATCH_ENTRYPOINT,
            scratch.specPath,
            "--branch",
            scratch.branch,
            "--base",
            scratch.baseSha,
          ],
          {
            // The chokepoint's own allowlist and nothing else
            // (`internal/exec.ts`): the two children this run spawns are
            // docker and git, and they read PATH and HOME. The rest is the
            // live config, arriving through the provider chain's env layer —
            // which is how a host declares a setup hook, so this case needs no
            // test-only surface on `dispatch`.
            env: {
              PATH: process.env["PATH"] ?? "",
              HOME: process.env["HOME"] ?? "",
              SPEEPOBOX_SETUP_HOOK: scratch.hookPath,
              SPEEPOBOX_RUNTIME_ROOT: scratch.runtimeRoot,
              SPEEPOBOX_IMAGE: LIVE_IMAGE,
              // Explicit, and empty: env beats the file layers, so a host's
              // own `cap-add` cannot hand this container capabilities the case
              // never asked for.
              SPEEPOBOX_CAP_ADD: "",
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        ),
      ),
      // A case that failed early leaves no dispatch of ours running.
      (spawned) =>
        Effect.sync(() => {
          spawned.kill("SIGKILL");
        }),
    );

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      transcript += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      transcript += chunk;
    });
    // One listener, resolved once: every later `exited` reads the same answer,
    // so a case that asks after the child is gone still gets one.
    child.on("exit", (code, signal) => {
      Deferred.unsafeDone(exited, Exit.succeed({ code, signal }));
    });

    const pid = child.pid;
    if (pid === undefined) {
      return yield* Effect.die(`could not spawn ${DISPATCH_ENTRYPOINT} — verify:live needs node`);
    }
    return {
      pid,
      // A real Ctrl-C reaches the foreground process group; this reaches the
      // one process in it, which is the same delivery the child sees.
      signal: (name) =>
        Effect.sync(() => {
          child.kill(name);
        }),
      exited: Deferred.await(exited),
      transcript: () => transcript,
    };
  });

// The run, parked at its setup hook with all three resources held. A dispatch
// that ends before that — a guard, a preflight, a daemon that refused the
// start — is this case's failure and carries the run's own output.
const heldAtTheHook = (
  scratch: Scratch,
  child: DispatchChild,
): Effect.Effect<void, never, FileSystem.FileSystem> =>
  Effect.raceFirst(
    FileSystem.FileSystem.pipe(
      Effect.flatMap((fs) => fs.exists(scratch.marker)),
      Effect.flatMap((there) => (there ? Effect.void : Effect.fail("not yet"))),
      Effect.retry(Schedule.spaced("100 millis")),
      Effect.timeoutFail({
        duration: HOLD_DEADLINE,
        onTimeout: () =>
          `the run never reached its setup hook within ${HOLD_DEADLINE} — its output was:\n${child.transcript()}`,
      }),
      Effect.orDie,
    ),
    child.exited.pipe(
      Effect.flatMap((exit) =>
        Effect.die(
          `the run ended before it held anything (${describeExit(exit)}) — its output was:\n${child.transcript()}`,
        ),
      ),
    ),
  );

// The rows this run wrote, decoded rather than sniffed: a line the tool wrote
// and this cannot decode is a defect, not an empty ledger.
const ledgerRows = (
  scratch: Scratch,
): Effect.Effect<ReadonlyArray<RunRecord>, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const file = join(scratch.runtimeRoot, LEDGER_FILENAME);
    if (!(yield* fs.exists(file))) {
      return [];
    }
    const text = yield* fs.readFileString(file);
    return yield* Effect.forEach(
      text.split("\n").filter((line) => line.trim() !== ""),
      (line) => Schema.decodeUnknown(Schema.parseJson(RunRecord))(line),
    );
  }).pipe(Effect.orDie);

// Matrix row 16's whole claim, asked of the host rather than of our reporter.
const expectNothingLeaked = (
  scratch: Scratch,
): Effect.Effect<void, never, FileSystem.FileSystem | CommandExecutor> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    // Not `toEqual([])`: this case's label scope is the host's real repo, so
    // the user's own live dispatches may be in this list and none of our
    // business. Ours is the one that may not be.
    expect(yield* ownedContainers(scratch.repoRoot)).not.toContain(scratch.plan.containerId);
    expect(yield* fs.exists(scratch.lockPath)).toBe(false);
    expect(yield* fs.exists(scratch.plan.checkoutPath)).toBe(false);
    expect((yield* ledgerRows(scratch)).map((row) => row.terminalReason)).toEqual([
      Option.some({ _tag: "Interrupted" }),
    ]);
  }).pipe(Effect.orDie);

// Matrix row 17: no finalizer ran, so all three are still on this host — and
// the state they are in is the state T8's reconciler is built to read.
//
// **The ledger is asserted loosely on purpose.** SPEC §11's rule is that a row
// exists iff `RunLock` was acquired, and this run acquired it — so a row is
// permitted here, and whether one landed depends only on how far the first
// interrupt's teardown got before the second signal killed it. Measured: at
// 25ms the `Interrupted` row is written and the lock release is not, which is
// the order §11 requires (the row is written while the lock is held). Any
// fixed delay picks a point on that race, so the invariant is *what* a row may
// say, never how many there are.
const expectTheReconcilersWork = (
  scratch: Scratch,
  child: DispatchChild,
): Effect.Effect<void, never, FileSystem.FileSystem | CommandExecutor> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    expect(yield* ownedContainers(scratch.repoRoot)).toContain(scratch.plan.containerId);
    expect(yield* fs.exists(scratch.plan.checkoutPath)).toBe(true);
    // The lock names the dispatch that died, and that dispatch is gone — the
    // two halves the reconciler's liveness predicate joins before it reclaims
    // anything. The child has been awaited, so its pid is reaped by now.
    expect(parsePid(yield* fs.readFileString(scratch.lockPath))).toEqual(Option.some(child.pid));
    expect(isProcessAlive(child.pid)).toBe(false);
    // A run killed mid-teardown may have recorded that it was interrupted, and
    // may not have got that far. What it may never do is claim it finished:
    // `Completed` or `Failed` here would mean the run reached its own end and
    // then left all three resources on the host.
    const reasons = (yield* ledgerRows(scratch)).map((row) => row.terminalReason);
    expect(reasons.length).toBeLessThanOrEqual(1);
    for (const reason of reasons) {
      expect(reason).toEqual(Option.some({ _tag: "Interrupted" }));
    }
  }).pipe(Effect.orDie);

describe("the signal matrix against real processes", () => {
  // Row 16, the path bash gets right and the port has to keep: one Ctrl-C,
  // full teardown, and — new since T19 — the 130 a wrapping script reads.
  itLive.scopedLive("releases all three on one Ctrl-C, and reports 130", () =>
    Effect.gen(function* () {
      yield* dockerdIsUp;
      const scratch = yield* world("ctrl-c-once");

      const assertions = Effect.gen(function* () {
        const child = yield* spawnDispatch(scratch);
        yield* heldAtTheHook(scratch, child);
        yield* child.signal("SIGINT");

        const exit = yield* child.exited;
        // Read the exit first: it is the only assertion that says why, and a
        // run that failed for its own reasons fails every other one below.
        expect(howItEnded(exit, child.transcript())).toBe(INTERRUPTED_CLEANLY);
        yield* expectNothingLeaked(scratch);
      });

      yield* assertions.pipe(Effect.ensuring(cleanup(scratch)));
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  // Row 16's other half, and **the divergence from bash**: a closed terminal
  // tab kills bash's script outright and leaves the container behind. Here the
  // hangup is re-raised as SIGINT (`bin.ts`), arrives at `runMain`'s single
  // handler, and tears the same three resources down in the same order.
  itLive.scopedLive("releases all three when the terminal closes, which bash does not", () =>
    Effect.gen(function* () {
      yield* dockerdIsUp;
      const scratch = yield* world("sighup");

      const assertions = Effect.gen(function* () {
        const child = yield* spawnDispatch(scratch);
        yield* heldAtTheHook(scratch, child);
        yield* child.signal("SIGHUP");

        const exit = yield* child.exited;
        // 130 via the re-raise: the hangup becomes the interrupt, so the exit
        // code is the interrupt's, not a hangup's 129.
        expect(howItEnded(exit, child.transcript())).toBe(INTERRUPTED_CLEANLY);
        yield* expectNothingLeaked(scratch);
      });

      yield* assertions.pipe(Effect.ensuring(cleanup(scratch)));
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  // Row 17: the dispatcher who does not want to wait for teardown. The second
  // Ctrl-C is node's default action — `runMain` removed its handler when the
  // first one fired — so nothing releases, and whatever the first interrupt
  // had already written stays written. That is not a leak the port tolerates;
  // it is the case T8's reconciler exists for, and this asserts the state it
  // will find.
  itLive.scopedLive("hard-exits on a second Ctrl-C, leaving what a reconciler reclaims", () =>
    Effect.gen(function* () {
      yield* dockerdIsUp;
      const scratch = yield* world("ctrl-c-twice");

      const assertions = Effect.gen(function* () {
        const child = yield* spawnDispatch(scratch);
        yield* heldAtTheHook(scratch, child);
        yield* child.signal("SIGINT");
        yield* Effect.sleep(SECOND_INTERRUPT_AFTER);
        yield* child.signal("SIGINT");

        const exit = yield* child.exited;
        // Killed by the signal rather than exiting under its own power: a 130
        // here would mean the teardown ran, which is row 16, not row 17.
        expect(howItDied(exit, child.transcript())).toBe("SIGINT");
        yield* expectTheReconcilersWork(scratch, child);
      });

      yield* assertions.pipe(Effect.ensuring(cleanup(scratch)));
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  // Row 17's other half, and the one exit no finalizer can serve: the process
  // is gone before any code of ours runs. Identical evidence, for the identical
  // reason — the reconciler is the only thing that can clean up after it.
  itLive.scopedLive("leaves everything to the reconciler on kill -9", () =>
    Effect.gen(function* () {
      yield* dockerdIsUp;
      const scratch = yield* world("kill-9");

      const assertions = Effect.gen(function* () {
        const child = yield* spawnDispatch(scratch);
        yield* heldAtTheHook(scratch, child);
        yield* child.signal("SIGKILL");

        const exit = yield* child.exited;
        expect(howItDied(exit, child.transcript())).toBe("SIGKILL");
        yield* expectTheReconcilersWork(scratch, child);
      });

      yield* assertions.pipe(Effect.ensuring(cleanup(scratch)));
    }).pipe(Effect.provide(NodeContext.layer)),
  );
});
