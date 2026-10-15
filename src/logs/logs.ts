// `logs <branch> [--follow]` (T151): the newest run log of a branch, and with
// `--follow` what the run appends to it while it is live. It reads files and
// nothing else — no git, no docker, no ledger — so it sits in the read-only
// slice beside `status`, and a malformed `config.toml` falls back to the
// committed defaults rather than stopping it.
//
// Which file is decided off the names alone: a log is `<runId>.log` and a run
// id is `<slug>-<epoch ms>` (T47), so the slug and the start time are both in
// the name. The mtime is never asked — a log that is still being written is
// the newest-touched file whether or not it is the newest run.
//
// The contents reach the console as `Reporter` events, a line each, as every
// other command's output does: the console is the subscriber, and a
// `process.stdout.write` here typechecks and is wrong.
import { join } from "node:path";
import { FileSystem } from "@effect/platform";
import { Duration, Effect, Either, Option } from "effect";
import { SpeepoboxConfig } from "../config/config.ts";
import { LOGS_DIRNAME, lockPathFor, slugFor } from "../dispatch/plan.ts";
import { ownerIsAlive } from "../lock/liveness.ts";
import { readLockOnDisk } from "../reconcile/lock-on-disk.ts";
import { Reporter } from "../reporter.ts";
import { LogsRefused, parseLogsArgv } from "./argv.ts";

const LOG_NAME = /^(.*)-(\d+)\.log$/;

// When a log's run started, off its name alone: the epoch milliseconds a
// run id ends in. `detach` (T153) asks it of the log it found, to tell the
// run it started from an earlier one of the same branch.
export const logStartedAt = (name: string): Option.Option<bigint> => {
  const match = LOG_NAME.exec(name);
  return match === null ? Option.none() : Option.some(BigInt(match[2]!));
};

// The newest log of `slug` among a directory's names, or none. The name is
// parsed rather than prefix-matched: slug `foo` must not claim
// `foo-bar-1791813203269.log`, whose slug is `foo-bar`.
export const newestLogFor = (slug: string, names: ReadonlyArray<string>): Option.Option<string> => {
  let newest: Option.Option<{ readonly name: string; readonly startedAt: bigint }> = Option.none();
  for (const name of names) {
    const match = LOG_NAME.exec(name);
    if (match === null || match[1] !== slug) {
      continue;
    }
    const startedAt = BigInt(match[2]!);
    if (Option.isNone(newest) || startedAt > newest.value.startedAt) {
      newest = Option.some({ name, startedAt });
    }
  }
  return Option.map(newest, (found) => found.name);
};

const DEFAULT_POLL = Duration.seconds(1);

export interface LogsOptions {
  // The words after `logs`.
  readonly argv: ReadonlyArray<string>;
  // How long `--follow` waits between reads. A second in use; a test passes
  // a shorter one so a live case does not take seconds.
  readonly pollInterval?: Duration.DurationInput;
}

// Bytes past what was already printed, split into lines — here and for the
// output `detach` relays (T153). A trailing partial
// line is held back until its newline arrives — or until the run ends, when
// whatever is left is printed as the last line. The decoder streams, so a
// multi-byte character split across two reads is decoded whole.
export const lineSplitter = () => {
  const decoder = new TextDecoder();
  let pending = "";
  return {
    push: (bytes: Uint8Array): ReadonlyArray<string> => {
      pending += decoder.decode(bytes, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop()!;
      return lines;
    },
    end: (): ReadonlyArray<string> => {
      const rest = pending + decoder.decode();
      pending = "";
      return rest === "" ? [] : [rest];
    },
  };
};

export const logs = (
  options: LogsOptions,
): Effect.Effect<void, LogsRefused, SpeepoboxConfig | Reporter | FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const parsed = parseLogsArgv(options.argv);
    if (Either.isLeft(parsed)) {
      return yield* parsed.left;
    }
    const { branch, follow } = parsed.right;
    const config = yield* SpeepoboxConfig;
    const reporter = yield* Reporter;
    const fs = yield* FileSystem.FileSystem;
    const slug = slugFor(branch);
    const logsDir = join(config.runtimeRoot, LOGS_DIRNAME);
    const noLog = new LogsRefused({ detail: `no run log for '${branch}' under ${logsDir}` });

    // An absent `logs/` is a host that has run nothing yet, which is the same
    // answer as a directory holding nobody's log for this branch.
    const names = yield* fs.readDirectory(logsDir).pipe(
      Effect.catchIf(
        (error) => error._tag === "SystemError" && error.reason === "NotFound",
        () => Effect.succeed<ReadonlyArray<string>>([]),
      ),
      Effect.mapError(
        (error) => new LogsRefused({ detail: `could not list ${logsDir}: ${error.message}` }),
      ),
    );
    const name = slug === "" ? Option.none() : newestLogFor(slug, names);
    if (Option.isNone(name)) {
      return yield* noLog;
    }
    const file = join(logsDir, name.value);
    const unreadable = (error: { readonly message: string }) =>
      new LogsRefused({ detail: `could not read ${file}: ${error.message}` });

    yield* reporter.emit({ _tag: "LogOpened", path: file });

    const lines = lineSplitter();
    let printed = 0n;
    // Everything past `printed`, through a handle opened for this read alone.
    const printNew = Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* fs.open(file, { flag: "r" });
        const size = BigInt((yield* handle.stat).size);
        if (size <= printed) {
          return;
        }
        yield* handle.seek(printed, "start");
        const bytes = yield* handle.readAlloc(size - printed);
        if (Option.isNone(bytes)) {
          return;
        }
        printed += BigInt(bytes.value.length);
        yield* Effect.forEach(lines.push(bytes.value), (line) =>
          reporter.emit({ _tag: "LogLine", line }),
        );
      }),
    ).pipe(Effect.mapError(unreadable));

    // Live is asked exactly as `status` asks it: the slug's lock, read through
    // the reconciler's own read, and an owner `liveness.ts` says is alive. The
    // run log closes before the lock is released, so a log whose lock is gone
    // is complete.
    const lockFile = lockPathFor(config.runtimeRoot, slug);
    const live = Effect.map(readLockOnDisk(lockFile), (lock) =>
      Option.match(lock, { onNone: () => false, onSome: (found) => ownerIsAlive(found.owner) }),
    );

    yield* printNew;
    if (follow) {
      const poll = options.pollInterval ?? DEFAULT_POLL;
      while (yield* live) {
        yield* Effect.sleep(poll);
        yield* printNew;
      }
      yield* printNew;
    }
    yield* Effect.forEach(lines.end(), (line) => reporter.emit({ _tag: "LogLine", line }));
  });
