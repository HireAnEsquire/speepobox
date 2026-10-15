// `--detach` (T153), against a real scratch runtime root: the `.out` file and
// the run logs are the filesystem's, and the child is a fake — a script on
// the test clock that writes what a dispatch would, takes a scripted lock, and
// records every SIGINT instead of receiving one.
import { describe, expect, it } from "@effect/vitest";
import { FileSystem } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { Cause, Clock, Effect, Either, Exit, Fiber, Layer, Option, Ref, TestClock } from "effect";
import { join } from "node:path";
import { SpeepoboxConfig, defaultConfig } from "../src/config/config.ts";
import {
  DETACHED_DIRNAME,
  childArgvFor,
  detach,
  detachedRunFor,
  peelDetach,
  type DetachHost,
} from "../src/detach/detach.ts";
import { renderDetachedStarted, renderDetachedStopped } from "../src/detach/render.ts";
import { LOGS_DIRNAME, lockPathFor, slugFor } from "../src/dispatch/plan.ts";
import { renderFailure } from "../src/dispatch/render.ts";
import type { DetachedChild } from "../src/internal/exec.ts";
import { Reporter, type ReporterEvent } from "../src/reporter.ts";

const BRANCH = "speepobox-t153";
const SLUG = slugFor(BRANCH);
const PID = 4242;
const REPO_ROOT = "/repo";
const SPAWNED_AT = 1_800_000_000_000;
const WORDS = ["--task", "do the thing", "--branch", BRANCH];

describe("peelDetach", () => {
  it("is None without the flag", () => {
    expect(peelDetach(WORDS)).toEqual(Option.none());
  });

  it("takes the flag out wherever it stands", () => {
    expect(peelDetach(["--detach", ...WORDS])).toEqual(Option.some(WORDS));
    expect(peelDetach([...WORDS, "--detach"])).toEqual(Option.some(WORDS));
  });

  it("leaves a value that only spells the flag", () => {
    const words = ["--feedback", "--detach", "--branch", BRANCH];
    expect(peelDetach(words)).toEqual(Option.none());
  });
});

const refused = (words: ReadonlyArray<string>): string => {
  const run = detachedRunFor(words);
  return Either.isLeft(run) ? run.left.detail : "(accepted)";
};

describe("detachedRunFor", () => {
  it("hands the child the parent's words minus --detach, plus --no-input", () => {
    const run = Either.getOrThrow(
      detachedRunFor(Option.getOrThrow(peelDetach([...WORDS, "--detach"]))),
    );
    expect(run).toEqual({ branch: BRANCH, words: [...WORDS, "--no-input"] });
    expect(childArgvFor(run, REPO_ROOT)).toEqual([
      "--repo-root",
      REPO_ROOT,
      ...WORDS,
      "--no-input",
    ]);
  });

  it("adds no second --no-input", () => {
    const run = Either.getOrThrow(detachedRunFor([...WORDS, "--no-input"]));
    expect(run.words).toEqual([...WORDS, "--no-input"]);
  });

  it("takes a resume's branch from --resume, in either spelling", () => {
    expect(Either.getOrThrow(detachedRunFor(["--resume", BRANCH])).branch).toBe(BRANCH);
    expect(Either.getOrThrow(detachedRunFor([`--resume=${BRANCH}`])).branch).toBe(BRANCH);
    expect(Either.getOrThrow(detachedRunFor(["x", `--branch=${BRANCH}`])).branch).toBe(BRANCH);
  });

  it("refuses --dry-run", () => {
    expect(refused([...WORDS, "--dry-run"])).toContain("Rehearse in the foreground");
  });

  it("refuses --hard-reset", () => {
    expect(refused([...WORDS, "--hard-reset"])).toContain("a detached run cannot be asked");
  });

  it("refuses a command line with no branch with the guard's own words", () => {
    expect(refused(["--task", "x"])).toMatch(/^--branch is required/);
    expect(refused(["--task", "x", "--branch", ""])).toMatch(/^--branch is required/);
    expect(refused([])).toMatch(/^--branch is required/);
  });

  it("refuses --last, whose branch is the ledger's", () => {
    expect(refused(["--last"])).toContain("--resume <branch>");
  });
});

describe("the detach renderers", () => {
  it("prints the three start lines", () => {
    expect(
      renderDetachedStarted({ _tag: "DetachedStarted", branch: BRANCH, pid: PID, log: "/l.log" }),
    ).toBe(
      [
        `started '${BRANCH}' (pid ${PID})`,
        "log: /l.log",
        `watch: .speepobox/speepobox logs ${BRANCH} --follow`,
      ].join("\n"),
    );
  });

  it("tells a child that never held the lock from one stopped holding it", () => {
    const base = { _tag: "DetachedStopped", branch: BRANCH, pid: PID, exited: true } as const;
    expect(renderDetachedStopped({ ...base, heldLock: false })).toContain(
      "was stopped before it took its lock",
    );
    expect(renderDetachedStopped({ ...base, heldLock: true })).toContain(
      "took its lock and was then stopped",
    );
    expect(renderDetachedStopped({ ...base, heldLock: true, exited: false })).toContain(
      "is still running after 30s",
    );
  });
});

// What the fake child can do, in its script and when signalled.
interface ChildWorld {
  readonly write: (text: string) => Effect.Effect<void>;
  readonly takeLock: Effect.Effect<void>;
  readonly releaseLock: Effect.Effect<void>;
  // The run log, named off the clock as a run id is.
  readonly openLog: Effect.Effect<void>;
  readonly exit: Effect.Effect<void>;
}

interface Scenario {
  // What the child does from the moment it is spawned, on the test clock.
  readonly script: (world: ChildWorld) => Effect.Effect<void>;
  // What the child does when it receives SIGINT. Absent ignores it.
  readonly onInterrupt?: (world: ChildWorld) => Effect.Effect<void>;
  readonly argv?: ReadonlyArray<string>;
  // Interrupt the parent once this many test-clock milliseconds have passed.
  readonly interruptParentAfter?: number;
}

const runDetach = (scenario: Scenario) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const runtimeRoot = yield* fs.makeTempDirectoryScoped();
    const logsDir = join(runtimeRoot, LOGS_DIRNAME);
    yield* fs.makeDirectory(logsDir, { recursive: true });
    // An earlier run of the same branch, which is never this run's log.
    const earlierLog = join(logsDir, `${SLUG}-${SPAWNED_AT - 60_000}.log`);
    yield* fs.writeFileString(earlierLog, "an earlier run\n");
    yield* TestClock.setTime(SPAWNED_AT);

    const lockFile = lockPathFor(runtimeRoot, SLUG);
    const owner = yield* Ref.make(Option.none<number>());
    const exited = yield* Ref.make(false);
    const signals = yield* Ref.make(0);
    const spawned = yield* Ref.make<ReadonlyArray<ReadonlyArray<string>>>([]);
    const events = yield* Ref.make<ReadonlyArray<ReporterEvent>>([]);
    const logPath = yield* Ref.make(Option.none<string>());

    const host: DetachHost = {
      spawn: (argv, outFile) =>
        Effect.gen(function* () {
          yield* Ref.update(spawned, (all) => [...all, argv]);
          const world: ChildWorld = {
            write: (text) =>
              Effect.orDie(
                Effect.flatMap(fs.readFileString(outFile), (before) =>
                  fs.writeFileString(outFile, before + text),
                ),
              ),
            takeLock: Ref.set(owner, Option.some(PID)),
            releaseLock: Ref.set(owner, Option.none()),
            openLog: Effect.gen(function* () {
              const path = join(logsDir, `${SLUG}-${yield* Clock.currentTimeMillis}.log`);
              yield* Effect.orDie(fs.writeFileString(path, "run start\n"));
              yield* Ref.set(logPath, Option.some(path));
            }),
            exit: Ref.set(exited, true),
          };
          yield* Effect.forkDaemon(scenario.script(world));
          const child: DetachedChild = {
            pid: PID,
            exited: Ref.get(exited),
            interrupt: Effect.gen(function* () {
              yield* Ref.update(signals, (count) => count + 1);
              if (scenario.onInterrupt !== undefined) {
                yield* Effect.forkDaemon(scenario.onInterrupt(world));
              }
            }),
          };
          return child;
        }),
      lockOwner: (file) =>
        file === lockFile ? Ref.get(owner) : Effect.succeed(Option.none<number>()),
    };

    const fiber = yield* detach({
      argv: scenario.argv ?? [...WORDS, "--detach"],
      repoRoot: REPO_ROOT,
      host,
      pollInterval: "5 seconds",
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(SpeepoboxConfig, { ...defaultConfig, runtimeRoot }),
          Layer.succeed(Reporter, {
            emit: (event) => Ref.update(events, (current) => [...current, event]),
          }),
        ),
      ),
      Effect.fork,
    );
    let interrupter = Option.none<Fiber.RuntimeFiber<Exit.Exit<void, unknown>>>();
    // The command reads the real filesystem between its sleeps, so the clock
    // moves only once every fiber is parked on one.
    while (Option.isNone(yield* Fiber.poll(fiber))) {
      if (
        scenario.interruptParentAfter !== undefined &&
        Option.isNone(interrupter) &&
        (yield* Clock.currentTimeMillis) >= SPAWNED_AT + scenario.interruptParentAfter
      ) {
        interrupter = Option.some(yield* Effect.fork(Fiber.interrupt(fiber)));
      }
      if ((yield* TestClock.sleeps()).length > 0) {
        yield* TestClock.adjust("5 seconds");
      } else {
        yield* Effect.promise(() => new Promise((resolve) => setImmediate(resolve)));
      }
    }
    const outcome = yield* Fiber.await(fiber);
    const all = yield* Ref.get(events);
    return {
      outcome,
      signals: yield* Ref.get(signals),
      spawned: yield* Ref.get(spawned),
      events: all,
      output: all.flatMap((event) => (event._tag === "DetachedOutput" ? [event.line] : [])),
      logPath: yield* Ref.get(logPath),
      outFile: join(runtimeRoot, DETACHED_DIRNAME, `${SLUG}.out`),
      runtimeRoot,
    };
  }).pipe(Effect.provide(NodeContext.layer));

const failureOf = (exit: Exit.Exit<void, unknown>): unknown =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Cause.failureOption(exit.cause)) : undefined;

const detailOf = (exit: Exit.Exit<void, unknown>): string => {
  const failure = failureOf(exit);
  return typeof failure === "object" && failure !== null && "detail" in failure
    ? String(failure.detail)
    : "(no detail)";
};

describe("detach", () => {
  it.scoped("relays the child's output, then prints the start lines once it holds the lock", () =>
    Effect.gen(function* () {
      const result = yield* runDetach({
        script: (world) =>
          Effect.gen(function* () {
            yield* Effect.sleep("300 millis");
            yield* world.write("speepobox: plan line\n");
            yield* Effect.sleep("300 millis");
            yield* world.write("WARN  a warning\n");
            yield* world.takeLock;
            yield* Effect.sleep("300 millis");
            yield* world.openLog;
            yield* world.write("lock: acquired\n");
          }),
      });
      expect(result.outcome).toEqual(Exit.void);
      expect(result.signals).toBe(0);
      expect(result.spawned).toEqual([["--repo-root", REPO_ROOT, ...WORDS, "--no-input"]]);
      expect(result.output).toEqual(["speepobox: plan line", "WARN  a warning", "lock: acquired"]);
      expect(result.events.at(-1)).toEqual({
        _tag: "DetachedStarted",
        branch: BRANCH,
        pid: PID,
        log: Option.getOrThrow(result.logPath),
      });
    }),
  );

  it.scoped("relays a child that exits before the lock, and fails with no line of its own", () =>
    Effect.gen(function* () {
      const result = yield* runDetach({
        script: (world) =>
          Effect.gen(function* () {
            yield* Effect.sleep("500 millis");
            yield* world.write("!! spec not found: tasks/nope.md\nno newline at the end");
            yield* world.exit;
          }),
      });
      expect(result.signals).toBe(0);
      expect(result.output).toEqual(["!! spec not found: tasks/nope.md", "no newline at the end"]);
      const failure = failureOf(result.outcome);
      expect(failure).toMatchObject({ _tag: "DetachedChildExited", branch: BRANCH, pid: PID });
      expect(renderFailure(failure as never)).toEqual(Option.none());
      expect(result.events.some((event) => event._tag === "DetachedStarted")).toBe(false);
    }),
  );

  it.scoped("sends a child that neither locks nor exits exactly one SIGINT at 120s", () =>
    Effect.gen(function* () {
      const result = yield* runDetach({
        script: () => Effect.void,
        onInterrupt: (world) =>
          Effect.gen(function* () {
            yield* Effect.sleep("1 second");
            yield* world.write("interrupted\n");
            yield* world.exit;
          }),
      });
      expect(result.signals).toBe(1);
      expect(detailOf(result.outcome)).toBe(`'${BRANCH}' did not start within 120s`);
      expect(result.output).toEqual(["interrupted"]);
      expect(result.events.at(-1)).toEqual({
        _tag: "DetachedStopped",
        branch: BRANCH,
        pid: PID,
        heldLock: false,
        exited: true,
      });
    }),
  );

  it.scoped("signals once and stops waiting after 30s for a child that ignores it", () =>
    Effect.gen(function* () {
      const result = yield* runDetach({ script: () => Effect.void });
      expect(result.signals).toBe(1);
      expect(detailOf(result.outcome)).toBe(`'${BRANCH}' did not start within 120s`);
      expect(result.events.at(-1)).toMatchObject({ _tag: "DetachedStopped", exited: false });
    }),
  );

  it.scoped("sends the child exactly one SIGINT when the parent is interrupted", () =>
    Effect.gen(function* () {
      const result = yield* runDetach({
        script: () => Effect.void,
        onInterrupt: (world) => world.exit,
        interruptParentAfter: 5_000,
      });
      expect(Exit.isInterrupted(result.outcome)).toBe(true);
      expect(result.signals).toBe(1);
      expect(result.events.at(-1)).toMatchObject({
        _tag: "DetachedStopped",
        heldLock: false,
        exited: true,
      });
    }),
  );

  it.scoped(
    "reports a child that took the lock as the timeout fired as started, then stopped",
    () =>
      Effect.gen(function* () {
        const result = yield* runDetach({
          script: () => Effect.void,
          // It took the lock and opened its log in the instant the parent gave
          // up, so no poll saw either; the signal tears it down.
          onInterrupt: (world) =>
            Effect.gen(function* () {
              yield* world.takeLock;
              yield* world.openLog;
              yield* Effect.sleep("2 seconds");
              yield* world.releaseLock;
              yield* world.exit;
            }),
        });
        expect(result.signals).toBe(1);
        expect(result.events.at(-1)).toEqual({
          _tag: "DetachedStopped",
          branch: BRANCH,
          pid: PID,
          heldLock: true,
          exited: true,
        });
      }),
  );

  it.scoped("refuses --dry-run and --hard-reset before any spawn, and writes nothing", () =>
    Effect.gen(function* () {
      for (const flag of ["--dry-run", "--hard-reset"]) {
        const result = yield* runDetach({
          script: () => Effect.void,
          argv: [...WORDS, flag, "--detach"],
        });
        expect(result.spawned).toEqual([]);
        expect(result.signals).toBe(0);
        expect(failureOf(result.outcome)).toMatchObject({ _tag: "DetachRefused" });
        const fs = yield* FileSystem.FileSystem;
        expect(
          yield* fs.exists(join(result.runtimeRoot, DETACHED_DIRNAME)).pipe(Effect.orDie),
        ).toBe(false);
      }
    }).pipe(Effect.provide(NodeContext.layer)),
  );
});
