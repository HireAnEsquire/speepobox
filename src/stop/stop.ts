// `stop <branch>` (T152): interrupt a branch's live run, wait for it to tear
// down, and say so. A run started in the background has no terminal to press
// Ctrl-C in, and reading a pid off `status`'s OWNER column to `kill -INT` it by
// hand asks the dispatcher to handle a pid.
//
// It holds no lock, writes no file, and writes no ledger row: the run it
// interrupts writes its own, through the teardown SIGINT already drives.
//
// The two host calls — the signal and the `ps` read — arrive as a `StopHost`
// built in `bin.ts`, so no test signals a real process.
import { FileSystem } from "@effect/platform";
import type { CommandExecutor } from "@effect/platform/CommandExecutor";
import { Clock, Data, Duration, Effect, Either, Option } from "effect";
import { SpeepoboxConfig } from "../config/config.ts";
import { lockPathFor, slugFor } from "../dispatch/plan.ts";
import type { ExecError, ExecResult } from "../internal/exec.ts";
import { ownerIsAlive } from "../lock/liveness.ts";
import { readLockOnDisk } from "../reconcile/lock-on-disk.ts";
import { Reporter } from "../reporter.ts";

export const STOP_USAGE = "speepobox stop <branch>";

// `etime` counts whole seconds, so a process that started a hair before the
// lock was written can read as up to a second younger than it is. Two seconds
// covers that and the rounding on the mtime's side.
export const IDENTITY_SLACK = Duration.seconds(2);
export const POLL_INTERVAL = Duration.seconds(1);
// Teardown fetches the commits back and removes the container, which can take
// tens of seconds.
export const STOP_TIMEOUT = Duration.seconds(120);

// One line on stderr and exit 1, through the renderer every other refusal
// uses (`dispatch/render.ts`).
export class StopRefused extends Data.TaggedError("StopRefused")<{
  readonly detail: string;
}> {}

// The host calls `stop` makes, built in `bin.ts`. There is no signal
// parameter: SIGINT is the only signal this command sends, because a
// SIGKILL'd dispatcher skips its finalizers and strands the lock and the
// container this command exists to release.
export interface StopHost {
  // `ps -o etime= -p <pid>`, through the exec chokepoint.
  readonly elapsed: (pid: number) => Effect.Effect<ExecResult, ExecError, CommandExecutor>;
  // SIGINT to `pid`, once; fails with the error's own words.
  readonly interrupt: (pid: number) => Effect.Effect<void, string>;
}

// The words after `stop`: exactly one branch.
export const parseStopArgv = (argv: ReadonlyArray<string>): Either.Either<string, StopRefused> => {
  const [branch, ...rest] = argv;
  return branch === undefined || branch === "" || branch.startsWith("-") || rest.length > 0
    ? Either.left(new StopRefused({ detail: `usage: ${STOP_USAGE}` }))
    : Either.right(branch);
};

// `etime`'s POSIX format, `[[dd-]hh:]mm:ss`, as seconds. Days need hours
// beside them, so `dd-mm:ss` is not one of its forms.
export const parseEtime = (text: string): Option.Option<number> => {
  const match = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/.exec(text.trim());
  if (match === null) {
    return Option.none();
  }
  const [, days, hours, minutes, seconds] = match;
  return Option.some(
    Number(days ?? 0) * 86_400 +
      Number(hours ?? 0) * 3_600 +
      Number(minutes) * 60 +
      Number(seconds),
  );
};

// The owner wrote the lock after it started, so a process that started after
// the lock's mtime (plus the slack) is a later process wearing a reused pid.
// Pure, so the arithmetic is asserted without a clock.
export const startedAfterLock = (input: {
  readonly nowMillis: number;
  readonly elapsedSeconds: number;
  readonly lockMtimeMillis: number;
}): boolean =>
  input.nowMillis - input.elapsedSeconds * 1000 >
  input.lockMtimeMillis + Duration.toMillis(IDENTITY_SLACK);

// The slug's live owner, asked exactly as `status` asks it: the reconciler's
// lock read, then `liveness.ts`. No second liveness rule.
const liveOwner = (
  file: string,
): Effect.Effect<Option.Option<number>, never, FileSystem.FileSystem> =>
  Effect.map(readLockOnDisk(file), (lock) => {
    const owner = Option.flatMap(lock, (found) => found.owner);
    return ownerIsAlive(owner) ? Option.some(owner.value) : Option.none();
  });

// Whether `pid` is still the process that wrote `file`. Every failure to tell
// is a refusal: a process whose identity could not be checked is not signalled.
const checkIdentity = (
  host: StopHost,
  file: string,
  pid: number,
): Effect.Effect<void, StopRefused, FileSystem.FileSystem | CommandExecutor> =>
  Effect.gen(function* () {
    const unchecked = (why: string) =>
      new StopRefused({
        detail: `could not check that pid ${pid} is still the run that wrote its lock (${why}) — nothing was signalled`,
      });
    const fs = yield* FileSystem.FileSystem;
    const mtime = yield* fs.stat(file).pipe(
      Effect.map((info) => info.mtime),
      Effect.mapError((error) => unchecked(`the lock could not be read: ${error.message}`)),
    );
    if (Option.isNone(mtime)) {
      return yield* unchecked("the lock has no modification time");
    }
    const result = yield* host
      .elapsed(pid)
      .pipe(Effect.mapError((error) => unchecked(`ps failed: ${error.detail}`)));
    if (result.exitCode !== 0) {
      const said = result.stderr.trim();
      return yield* unchecked(`ps exited ${result.exitCode}${said === "" ? "" : `: ${said}`}`);
    }
    const elapsed = parseEtime(result.stdout);
    if (Option.isNone(elapsed)) {
      return yield* unchecked(`ps answered '${result.stdout.trim()}', which is no elapsed time`);
    }
    const nowMillis = yield* Clock.currentTimeMillis;
    if (
      startedAfterLock({
        nowMillis,
        elapsedSeconds: elapsed.value,
        lockMtimeMillis: mtime.value.getTime(),
      })
    ) {
      return yield* new StopRefused({
        detail: `the lock names pid ${pid}, which now belongs to another process — the run itself is gone, and the next dispatch clears its lock. Nothing was signalled`,
      });
    }
  });

export interface StopOptions {
  // The words after `stop`.
  readonly argv: ReadonlyArray<string>;
  readonly host: StopHost;
}

export const stop = (
  options: StopOptions,
): Effect.Effect<
  void,
  StopRefused,
  SpeepoboxConfig | Reporter | FileSystem.FileSystem | CommandExecutor
> =>
  Effect.gen(function* () {
    const parsed = parseStopArgv(options.argv);
    if (Either.isLeft(parsed)) {
      return yield* parsed.left;
    }
    const branch = parsed.right;
    const config = yield* SpeepoboxConfig;
    const reporter = yield* Reporter;
    const file = lockPathFor(config.runtimeRoot, slugFor(branch));

    const owner = yield* liveOwner(file);
    if (Option.isNone(owner)) {
      return yield* new StopRefused({ detail: `no live run for '${branch}'` });
    }
    const pid = owner.value;
    yield* checkIdentity(options.host, file, pid);

    yield* options.host
      .interrupt(pid)
      .pipe(
        Effect.mapError(
          (error) =>
            new StopRefused({ detail: `could not interrupt pid ${pid} for '${branch}': ${error}` }),
        ),
      );
    yield* reporter.emit({ _tag: "RunStopping", branch, pid });

    // Live means the same answer as above, about the same pid: a lock a new
    // dispatch took meanwhile is not the run this command stopped.
    const stillLive = Effect.map(liveOwner(file), (now) =>
      Option.exists(now, (current) => current === pid),
    );
    const polls = Math.ceil(Duration.toMillis(STOP_TIMEOUT) / Duration.toMillis(POLL_INTERVAL));
    for (let poll = 0; poll < polls; poll++) {
      yield* Effect.sleep(POLL_INTERVAL);
      if (!(yield* stillLive)) {
        yield* reporter.emit({ _tag: "RunStopped", branch });
        return;
      }
    }
    return yield* new StopRefused({
      detail: `'${branch}' (pid ${pid}) was sent SIGINT and is still tearing down after ${Duration.toSeconds(STOP_TIMEOUT)}s — check on it with \`speepobox status\``,
    });
  });
