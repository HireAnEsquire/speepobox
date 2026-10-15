// `logs <branch> [--follow]` (T151) over a real runtime root on disk: which
// file it picks, what it prints, and when `--follow` stops. Liveness is the
// real `liveness.ts` — a lock naming this test's own pid is a live owner, one
// naming a pid above `pid_max` is a dead one.
import { describe, expect, it } from "@effect/vitest";
import { FileSystem } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { join } from "node:path";
import { Effect, Either, Exit, Fiber, Layer, Option, Ref, Schedule } from "effect";
import { appBaseLiveFor } from "../src/app.ts";
import { SpeepoboxConfig, defaultConfig } from "../src/config/config.ts";
import { speepoboxDir } from "../src/config/paths.ts";
import { LOCKS_DIRNAME, LOGS_DIRNAME, lockPathFor } from "../src/dispatch/plan.ts";
import { renderFailure } from "../src/dispatch/render.ts";
import { LogsRefused, parseLogsArgv } from "../src/logs/argv.ts";
import { logs, newestLogFor } from "../src/logs/logs.ts";
import { Reporter, type ReporterEvent } from "../src/reporter.ts";

// Above Linux's pid_max, so `kill -0` can only answer "no such process".
const DEAD_PID = 2147483647;

const capture = (events: Ref.Ref<ReadonlyArray<ReporterEvent>>) =>
  Layer.succeed(Reporter, {
    emit: (event) => Ref.update(events, (current) => [...current, event]),
  });

const world = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const runtimeRoot = yield* fs.makeTempDirectoryScoped();
  const logsDir = join(runtimeRoot, LOGS_DIRNAME);
  yield* fs.makeDirectory(logsDir);
  yield* fs.makeDirectory(join(runtimeRoot, LOCKS_DIRNAME));
  const events = yield* Ref.make<ReadonlyArray<ReporterEvent>>([]);
  const layer = Layer.merge(
    capture(events),
    Layer.succeed(SpeepoboxConfig, { ...defaultConfig, runtimeRoot }),
  );
  return { fs, runtimeRoot, logsDir, events, layer };
});

const printed = (events: ReadonlyArray<ReporterEvent>) =>
  events.map((event) =>
    event._tag === "LogOpened"
      ? `path ${event.path}`
      : event._tag === "LogLine"
        ? event.line
        : event._tag,
  );

describe("parseLogsArgv", () => {
  it("takes one branch and --follow", () => {
    expect(parseLogsArgv(["foo"])).toEqual(Either.right({ branch: "foo", follow: false }));
    expect(parseLogsArgv(["--follow", "foo"])).toEqual(
      Either.right({ branch: "foo", follow: true }),
    );
  });

  it("refuses no branch with the usage line, and never asks", () => {
    const parsed = parseLogsArgv([]);
    expect(Either.isLeft(parsed)).toBe(true);
    if (Either.isLeft(parsed)) {
      expect(renderFailure(parsed.left)).toEqual(
        Option.some("!! logs needs a branch (usage: speepobox logs <branch> [--follow])"),
      );
    }
    expect(Either.isLeft(parseLogsArgv(["--follow"]))).toBe(true);
  });

  it("refuses an unknown flag and a second branch", () => {
    expect(Either.isLeft(parseLogsArgv(["foo", "--tail"]))).toBe(true);
    expect(Either.isLeft(parseLogsArgv(["foo", "bar"]))).toBe(true);
  });
});

describe("newestLogFor", () => {
  it("chooses by the number in the name, and slug foo does not claim foo-bar", () => {
    expect(
      newestLogFor("foo", ["foo-100.log", "foo-bar-300.log", "foo-200.log", "foo-9.log.tmp"]),
    ).toEqual(Option.some("foo-200.log"));
    expect(newestLogFor("foo", ["foo-bar-300.log", "foo.log", "foo-x.log"])).toEqual(Option.none());
  });
});

describe("logs", () => {
  it.scoped("prints the path and then the newest log of the branch", () =>
    Effect.gen(function* () {
      const { fs, logsDir, events, layer } = yield* world;
      yield* fs.writeFileString(join(logsDir, "foo-100.log"), "old\n");
      yield* fs.writeFileString(join(logsDir, "foo-200.log"), "one\ntwo\n");
      yield* fs.writeFileString(join(logsDir, "foo-bar-300.log"), "neighbour\n");
      // The mtime is never asked: the older run is touched last.
      yield* fs.writeFileString(join(logsDir, "foo-100.log"), "old again\n");

      yield* logs({ argv: ["foo"] }).pipe(Effect.provide(layer));

      expect(printed(yield* Ref.get(events))).toEqual([
        `path ${join(logsDir, "foo-200.log")}`,
        "one",
        "two",
      ]);
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("refuses a branch with no log", () =>
    Effect.gen(function* () {
      const { fs, logsDir, layer } = yield* world;
      yield* fs.writeFileString(join(logsDir, "foo-bar-300.log"), "neighbour\n");

      const exit = yield* Effect.exit(logs({ argv: ["foo"] }).pipe(Effect.provide(layer)));

      expect(exit).toEqual(
        Exit.fail(new LogsRefused({ detail: `no run log for 'foo' under ${logsDir}` })),
      );
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("refuses when no logs directory exists yet", () =>
    Effect.gen(function* () {
      const { fs, logsDir, layer } = yield* world;
      yield* fs.remove(logsDir, { recursive: true });

      const exit = yield* Effect.exit(logs({ argv: ["foo"] }).pipe(Effect.provide(layer)));

      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("no run log for 'foo'");
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("--follow with no live owner prints the file and exits without waiting", () =>
    Effect.gen(function* () {
      const { fs, runtimeRoot, logsDir, events, layer } = yield* world;
      yield* fs.writeFileString(join(logsDir, "foo-200.log"), "done\n");
      yield* fs.writeFileString(lockPathFor(runtimeRoot, "foo"), `${DEAD_PID}\n`);

      // A poll this long would time the case out if it were waited on once.
      yield* logs({ argv: ["foo", "--follow"], pollInterval: "1 hour" }).pipe(
        Effect.provide(layer),
      );

      expect(printed(yield* Ref.get(events))).toEqual([
        `path ${join(logsDir, "foo-200.log")}`,
        "done",
      ]);
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scopedLive(
    "--follow with a live owner prints what is appended, and exits once the lock is gone",
    () =>
      Effect.gen(function* () {
        const { fs, runtimeRoot, logsDir, events, layer } = yield* world;
        const log = join(logsDir, "foo-200.log");
        const lock = lockPathFor(runtimeRoot, "foo");
        yield* fs.writeFileString(log, "first\n");
        yield* fs.writeFileString(lock, `${process.pid}\n`);

        const following = yield* Effect.fork(
          logs({ argv: ["foo", "--follow"], pollInterval: "20 millis" }).pipe(
            Effect.provide(layer),
          ),
        );
        // Waits on what was printed rather than on a clock, so a loaded host
        // makes the case slower and never red.
        const shown = (line: string) =>
          Effect.repeat(Ref.get(events), {
            until: (current) => printed(current).includes(line),
            schedule: Schedule.spaced("5 millis"),
          });
        yield* shown("first");
        yield* fs.writeFileString(log, "second\nhalf", { flag: "a" });
        yield* shown("second");
        // A live owner keeps it following, and a partial line waits for its end.
        expect(Option.isNone(yield* Fiber.poll(following))).toBe(true);
        expect(printed(yield* Ref.get(events))).not.toContain("half");
        // The last line arrives as the run ends, with no newline after it.
        yield* fs.writeFileString(log, " a line\nlast", { flag: "a" });
        yield* fs.remove(lock);
        yield* Fiber.join(following);

        expect(printed(yield* Ref.get(events))).toEqual([
          `path ${log}`,
          "first",
          "second",
          "half a line",
          "last",
        ]);
      }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("works with a malformed config.toml, on the read-only slice", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const repoRoot = yield* fs.makeTempDirectoryScoped();
      const logsDir = join(speepoboxDir(repoRoot), LOGS_DIRNAME);
      yield* fs.makeDirectory(logsDir, { recursive: true });
      yield* fs.writeFileString(join(speepoboxDir(repoRoot), "config.toml"), "image = [\n");
      yield* fs.writeFileString(join(logsDir, "foo-1.log"), "kept\n");
      const events = yield* Ref.make<ReadonlyArray<ReporterEvent>>([]);

      yield* logs({ argv: ["foo"] }).pipe(
        // The capture is merged last, so its `Reporter` is the one that answers.
        Effect.provide(Layer.merge(appBaseLiveFor(repoRoot, false), capture(events))),
      );

      expect(printed(yield* Ref.get(events))).toEqual([
        `path ${join(logsDir, "foo-1.log")}`,
        "kept",
      ]);
    }).pipe(Effect.provide(NodeContext.layer)),
  );
});
