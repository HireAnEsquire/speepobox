// `stop <branch>` (T152), against a real scratch runtime root: the lock and
// its mtime are the filesystem's answer, and the two host calls are fakes —
// the signal is recorded, never sent, and `ps` is scripted.
import { describe, expect, it } from "@effect/vitest";
import { FileSystem, Path } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { Effect, Either, Fiber, Layer, Option, Ref, TestClock } from "effect";
import { SpeepoboxConfig, defaultConfig } from "../src/config/config.ts";
import { lockPathFor, slugFor } from "../src/dispatch/plan.ts";
import { renderFailure } from "../src/dispatch/render.ts";
import { ExecError, type ExecResult } from "../src/internal/exec.ts";
import { Reporter, type ReporterEvent } from "../src/reporter.ts";
import {
  parseEtime,
  parseStopArgv,
  STOP_USAGE,
  startedAfterLock,
  stop,
  type StopHost,
} from "../src/stop/stop.ts";
import { scriptedExecutor } from "./support/exec-fake.ts";

// As `test/status.test.ts` uses it: past every kernel's pid_max, so never alive.
const DEAD_PID = 2147483647;
const BRANCH = "speepobox-t152";

describe("parseEtime", () => {
  it("parses mm:ss", () => {
    expect(parseEtime("05:07")).toEqual(Option.some(307));
  });

  it("parses hh:mm:ss", () => {
    expect(parseEtime("02:05:07")).toEqual(Option.some(2 * 3600 + 307));
  });

  it("parses dd-hh:mm:ss, padded as ps pads it", () => {
    expect(parseEtime("   3-02:05:07\n")).toEqual(Option.some(3 * 86_400 + 2 * 3600 + 307));
  });

  it("refuses anything else", () => {
    for (const text of ["", "07", "3-05:07", "ab:cd", "1:2:3:4", "-05:07"]) {
      expect(parseEtime(text)).toEqual(Option.none());
    }
  });
});

describe("startedAfterLock", () => {
  const lockMtimeMillis = 1_000_000;

  it("an owner that started before the lock is the run", () => {
    expect(
      startedAfterLock({
        nowMillis: lockMtimeMillis + 10_000,
        elapsedSeconds: 60,
        lockMtimeMillis,
      }),
    ).toBe(false);
  });

  it("allows two seconds of slack past the mtime", () => {
    expect(
      startedAfterLock({ nowMillis: lockMtimeMillis + 10_000, elapsedSeconds: 8, lockMtimeMillis }),
    ).toBe(false);
    expect(
      startedAfterLock({ nowMillis: lockMtimeMillis + 10_000, elapsedSeconds: 7, lockMtimeMillis }),
    ).toBe(true);
  });
});

describe("parseStopArgv", () => {
  it("takes exactly one branch", () => {
    expect(parseStopArgv([BRANCH])).toEqual(Either.right(BRANCH));
  });

  it("refuses no branch, two words, or a flag, naming the usage line", () => {
    for (const argv of [[], [BRANCH, "extra"], ["--force"]]) {
      const parsed = parseStopArgv(argv);
      expect(Either.isLeft(parsed) && parsed.left.detail).toBe(`usage: ${STOP_USAGE}`);
    }
  });
});

interface Scenario {
  // Written at the branch's lock path; absent writes nothing.
  readonly lock?: string;
  // What `ps -o etime=` answers; an `ExecError` when a string is absent.
  readonly ps: ExecResult | ExecError;
  // How long after the lock's mtime the clock reads.
  readonly sinceLock: number;
  // Whether the fake SIGINT removes the lock, as a run that tore down would.
  readonly releasesOnSignal: boolean;
  readonly signalFails?: string;
}

const etime = (stdout: string): ExecResult => ({ exitCode: 0, stdout, stderr: "" });

// Runs `stop` over one scenario, advancing the test clock a second at a time
// so the poll's sleeps fire. Hands back the outcome, every signal, and every
// event.
const runStop = (scenario: Scenario, argv: ReadonlyArray<string> = [BRANCH]) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const runtimeRoot = yield* fs.makeTempDirectoryScoped();
    const file = lockPathFor(runtimeRoot, slugFor(BRANCH));
    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    let mtime = 0;
    if (scenario.lock !== undefined) {
      yield* fs.writeFileString(file, scenario.lock);
      mtime = Option.getOrThrow((yield* fs.stat(file)).mtime).getTime();
    }
    yield* TestClock.setTime(mtime + scenario.sinceLock);

    const signals = yield* Ref.make<ReadonlyArray<number>>([]);
    const events = yield* Ref.make<ReadonlyArray<ReporterEvent>>([]);
    const host: StopHost = {
      elapsed: () =>
        scenario.ps instanceof ExecError ? Effect.fail(scenario.ps) : Effect.succeed(scenario.ps),
      interrupt: (pid) =>
        Effect.gen(function* () {
          yield* Ref.update(signals, (sent) => [...sent, pid]);
          if (scenario.signalFails !== undefined) {
            return yield* Effect.fail(scenario.signalFails);
          }
          if (scenario.releasesOnSignal) {
            yield* fs.remove(file).pipe(Effect.orDie);
          }
        }),
    };

    const fiber = yield* stop({ argv, host }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(SpeepoboxConfig, { ...defaultConfig, runtimeRoot }),
          Layer.succeed(Reporter, {
            emit: (event) => Ref.update(events, (current) => [...current, event]),
          }),
          scriptedExecutor({}),
        ),
      ),
      Effect.either,
      Effect.fork,
    );
    // The command reads the real filesystem between its sleeps, so the clock
    // moves only once the fiber is parked on one.
    while (Option.isNone(yield* Fiber.poll(fiber))) {
      if ((yield* TestClock.sleeps()).length > 0) {
        yield* TestClock.adjust("1 second");
      } else {
        yield* Effect.promise(() => new Promise((resolve) => setImmediate(resolve)));
      }
    }
    const outcome = yield* Fiber.join(fiber);
    return {
      outcome,
      signals: yield* Ref.get(signals),
      events: yield* Ref.get(events),
    };
  }).pipe(Effect.provide(NodeContext.layer));

const refusal = (outcome: Either.Either<void, { readonly detail: string }>): string =>
  Either.isLeft(outcome) ? outcome.left.detail : "(succeeded)";

describe("stop", () => {
  it.scoped("signals a live owner that passes the identity check once, and waits for it", () =>
    Effect.gen(function* () {
      const { outcome, signals, events } = yield* runStop({
        lock: `${process.pid}\n`,
        ps: etime("   01:00\n"),
        sinceLock: 10_000,
        releasesOnSignal: true,
      });
      expect(outcome).toEqual(Either.right(undefined));
      expect(signals).toEqual([process.pid]);
      expect(events).toEqual([
        { _tag: "RunStopping", branch: BRANCH, pid: process.pid },
        { _tag: "RunStopped", branch: BRANCH },
      ]);
    }),
  );

  it.scoped("refuses a pid that started after the lock was written, and signals nothing", () =>
    Effect.gen(function* () {
      const { outcome, signals, events } = yield* runStop({
        lock: `${process.pid}\n`,
        ps: etime("00:05"),
        sinceLock: 10_000,
        releasesOnSignal: true,
      });
      expect(refusal(outcome)).toContain(
        `the lock names pid ${process.pid}, which now belongs to another process`,
      );
      expect(refusal(outcome)).toContain("the run itself is gone");
      expect(signals).toEqual([]);
      expect(events).toEqual([]);
    }),
  );

  it.scoped("refuses when ps fails, and signals nothing", () =>
    Effect.gen(function* () {
      const { outcome, signals } = yield* runStop({
        lock: `${process.pid}\n`,
        ps: new ExecError({ command: "ps", detail: "ps: not found" }),
        sinceLock: 10_000,
        releasesOnSignal: true,
      });
      expect(refusal(outcome)).toContain("could not check that pid");
      expect(signals).toEqual([]);
    }),
  );

  it.scoped("refuses when ps exits nonzero, and signals nothing", () =>
    Effect.gen(function* () {
      const { outcome, signals } = yield* runStop({
        lock: `${process.pid}\n`,
        ps: { exitCode: 1, stdout: "", stderr: "" },
        sinceLock: 10_000,
        releasesOnSignal: true,
      });
      expect(refusal(outcome)).toContain("ps exited 1");
      expect(signals).toEqual([]);
    }),
  );

  it.scoped("refuses unparseable ps output, and signals nothing", () =>
    Effect.gen(function* () {
      const { outcome, signals } = yield* runStop({
        lock: `${process.pid}\n`,
        ps: etime("yesterday\n"),
        sinceLock: 10_000,
        releasesOnSignal: true,
      });
      expect(refusal(outcome)).toContain("which is no elapsed time");
      expect(signals).toEqual([]);
    }),
  );

  it.scoped("refuses with no lock", () =>
    Effect.gen(function* () {
      const { outcome, signals } = yield* runStop({
        ps: etime("01:00"),
        sinceLock: 0,
        releasesOnSignal: true,
      });
      expect(refusal(outcome)).toBe(`no live run for '${BRANCH}'`);
      expect(signals).toEqual([]);
    }),
  );

  it.scoped("refuses a lock whose owner is dead", () =>
    Effect.gen(function* () {
      const { outcome, signals } = yield* runStop({
        lock: `${DEAD_PID}\n`,
        ps: etime("01:00"),
        sinceLock: 10_000,
        releasesOnSignal: true,
      });
      expect(refusal(outcome)).toBe(`no live run for '${BRANCH}'`);
      expect(signals).toEqual([]);
    }),
  );

  it.scoped("refuses no branch with the usage line, through the renderer", () =>
    Effect.gen(function* () {
      const { outcome } = yield* runStop(
        { ps: etime("01:00"), sinceLock: 0, releasesOnSignal: true },
        [],
      );
      expect(Either.isLeft(outcome) && renderFailure(outcome.left)).toEqual(
        Option.some(`!! usage: ${STOP_USAGE}`),
      );
    }),
  );

  it.scoped("quotes a signal that failed", () =>
    Effect.gen(function* () {
      const { outcome, signals } = yield* runStop({
        lock: `${process.pid}\n`,
        ps: etime("01:00"),
        sinceLock: 10_000,
        releasesOnSignal: false,
        signalFails: "kill EPERM",
      });
      expect(refusal(outcome)).toContain("kill EPERM");
      expect(signals).toEqual([process.pid]);
    }),
  );

  it.scoped("an owner still live after the timeout is exit 1, with only the one SIGINT", () =>
    Effect.gen(function* () {
      const { outcome, signals, events } = yield* runStop({
        lock: `${process.pid}\n`,
        ps: etime("01:00"),
        sinceLock: 10_000,
        releasesOnSignal: false,
      });
      expect(refusal(outcome)).toContain("was sent SIGINT and is still tearing down");
      expect(refusal(outcome)).toContain("speepobox status");
      expect(signals).toEqual([process.pid]);
      expect(events).toEqual([{ _tag: "RunStopping", branch: BRANCH, pid: process.pid }]);
    }),
  );
});
