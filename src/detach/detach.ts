// `--detach` (T153): start a dispatch in a new process, wait until it holds
// its lock, say where to watch it, and exit 0 — so a run outlives the terminal
// or the agent session that started it.
//
// The parent is not the run. It holds no lock, writes no ledger row, and
// writes nothing under `logs/`: its writes are the `detached/` directory and
// the one `.out` file the child's console goes to. The guards run once, in the
// child; the parent refuses only what the command line alone says (a
// rehearsal, a `--hard-reset`, no branch to name the files by) and otherwise
// relays what the child wrote, so whoever ran the command sees the plan, the
// warnings, or the refusal as a foreground run shows them.
//
// Until the start line is printed the run belongs to the parent: a timeout or
// a Ctrl-C sends the child one SIGINT, from a finalizer of the wait's scope,
// and waits for it to exit. No orphan, and no `process.on` handler.
//
// The spawn and the lock read arrive as a `DetachHost` built in `bin.ts`, so no
// test starts a real process.
import { dirname, join } from "node:path";
import { FileSystem } from "@effect/platform";
import { Clock, Data, Duration, Effect, Either, Option } from "effect";
import { detachRehearsalRefusal } from "../app.ts";
import { SpeepoboxConfig } from "../config/config.ts";
import { REPO_ROOT_FLAG, VALUE_OPTION_NAMES } from "../config/served-repo.ts";
import { BRANCH_REQUIRED } from "../dispatch/guards.ts";
import { LOGS_DIRNAME, lockPathFor, slugFor } from "../dispatch/plan.ts";
import type { DetachedChild, ExecError } from "../internal/exec.ts";
import { lineSplitter, logStartedAt, newestLogFor } from "../logs/logs.ts";
import { readLockOnDisk } from "../reconcile/lock-on-disk.ts";
import { Reporter } from "../reporter.ts";
import { POLL_INTERVAL, START_TIMEOUT, STOP_GRACE } from "./timing.ts";

export const DETACH_FLAG = "--detach";
export const NO_INPUT_FLAG = "--no-input";
const HARD_RESET_FLAG = "--hard-reset";
// Beside `logs/` rather than in it, so `logs/` keeps one file per run and a
// refused dispatch never becomes the newest log `logs` finds.
export const DETACHED_DIRNAME = "detached";

// One line on stderr and exit 1, through the renderer every other refusal
// uses (`dispatch/render.ts`).
export class DetachRefused extends Data.TaggedError("DetachRefused")<{
  readonly detail: string;
}> {}

// The child exited before its lock. Exit 1 and no line of the parent's own:
// the child's output, relayed above it, already says why.
export class DetachedChildExited extends Data.TaggedError("DetachedChildExited")<{
  readonly branch: string;
  readonly pid: number;
}> {}

// The words a dispatch was typed with, read the way `config/served-repo.ts`
// reads them: the token after a value-taking option is that option's value,
// so `--feedback "--detach"` is feedback and not the flag.
interface Scanned {
  readonly detach: boolean;
  // The words minus every `--detach`.
  readonly rest: ReadonlyArray<string>;
  // Every word that stands as a flag of its own.
  readonly flags: ReadonlyArray<string>;
  // The last `--branch` or `--resume` value: a resume's branch is the one it
  // names.
  readonly branch: Option.Option<string>;
}

const BRANCH_OPTIONS = ["--branch", "--resume"];

const scan = (argv: ReadonlyArray<string>): Scanned => {
  const rest: Array<string> = [];
  const flags: Array<string> = [];
  let detach = false;
  let branch = Option.none<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const word = argv[index] ?? "";
    if (VALUE_OPTION_NAMES.some((name) => word === `--${name}`)) {
      rest.push(word);
      const value = argv[index + 1];
      if (value !== undefined) {
        rest.push(value);
        index += 1;
        if (BRANCH_OPTIONS.includes(word)) {
          branch = Option.some(value);
        }
      }
      continue;
    }
    const spelled = BRANCH_OPTIONS.find((name) => word.startsWith(`${name}=`));
    if (spelled !== undefined) {
      branch = Option.some(word.slice(spelled.length + 1));
    }
    if (word === DETACH_FLAG) {
      detach = true;
      continue;
    }
    if (word.startsWith("-")) {
      flags.push(word);
    }
    rest.push(word);
  }
  return { detach, rest, flags, branch };
};

// A dispatch's words minus `--detach`, when they carry it; `None` is a
// foreground dispatch.
export const peelDetach = (argv: ReadonlyArray<string>): Option.Option<ReadonlyArray<string>> => {
  const scanned = scan(argv);
  return scanned.detach ? Option.some(scanned.rest) : Option.none();
};

export interface DetachedRun {
  readonly branch: string;
  // The child's dispatch words: the parent's minus `--detach`, plus
  // `--no-input`, which `--detach` implies — a detached run has nobody to ask.
  readonly words: ReadonlyArray<string>;
}

// What the command line alone refuses, before any child starts.
export const detachedRunFor = (
  words: ReadonlyArray<string>,
): Either.Either<DetachedRun, DetachRefused> => {
  const scanned = scan(words);
  if (scanned.flags.includes(HARD_RESET_FLAG)) {
    return Either.left(
      new DetachRefused({
        detail: `--detach and ${HARD_RESET_FLAG} pull opposite ways — a hard reset asks for confirmation, and a detached run cannot be asked. Run it in the foreground`,
      }),
    );
  }
  const rehearsal = detachRehearsalRefusal(words);
  if (Option.isSome(rehearsal)) {
    return Either.left(new DetachRefused({ detail: rehearsal.value }));
  }
  // The branch names the `.out` file and the lock the wait reads, so it has to
  // be on the command line: `--last` resolves its branch from the ledger, in
  // the child.
  const branch = Option.filter(scanned.branch, (value) => slugFor(value) !== "");
  if (Option.isNone(branch)) {
    return Either.left(
      new DetachRefused({
        detail: scanned.flags.includes("--last")
          ? "--detach needs the branch on the command line, and --last finds it in the ledger — name it: --resume <branch>"
          : BRANCH_REQUIRED,
      }),
    );
  }
  return Either.right({
    branch: branch.value,
    words: scanned.flags.includes(NO_INPUT_FLAG) ? scanned.rest : [...scanned.rest, NO_INPUT_FLAG],
  });
};

// The child's arguments after the entrypoint: the served repo as the parent
// peeled it, then its dispatch words.
export const childArgvFor = (run: DetachedRun, repoRoot: string): ReadonlyArray<string> => [
  REPO_ROOT_FLAG,
  repoRoot,
  ...run.words,
];

// The host calls `--detach` makes, built in `bin.ts`.
export interface DetachHost {
  // The package's own entrypoint under the node binary and flags this process
  // runs with, given `argv` after it, through `execDetached`.
  readonly spawn: (
    argv: ReadonlyArray<string>,
    outFile: string,
  ) => Effect.Effect<DetachedChild, ExecError>;
  // The pid the slug's lock names, if any.
  readonly lockOwner: (
    file: string,
  ) => Effect.Effect<Option.Option<number>, never, FileSystem.FileSystem>;
}

// The lock read `status` makes (`reconcile/lock-on-disk.ts`), down to its pid.
export const lockOwnerOnDisk = (
  file: string,
): Effect.Effect<Option.Option<number>, never, FileSystem.FileSystem> =>
  Effect.map(
    readLockOnDisk(file),
    Option.flatMap((lock) => lock.owner),
  );

export interface DetachOptions {
  // A dispatch's words, `--repo-root` already peeled.
  readonly argv: ReadonlyArray<string>;
  readonly repoRoot: string;
  readonly host: DetachHost;
  // How long the wait sleeps between polls. 200ms in use; a test passes a
  // longer one so two minutes of test clock are a few dozen polls.
  readonly pollInterval?: Duration.DurationInput;
}

export const detach = (
  options: DetachOptions,
): Effect.Effect<
  void,
  DetachRefused | DetachedChildExited,
  SpeepoboxConfig | Reporter | FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const parsed = detachedRunFor(options.argv);
    if (Either.isLeft(parsed)) {
      return yield* parsed.left;
    }
    const run = parsed.right;
    const poll = options.pollInterval ?? POLL_INTERVAL;
    const { branch } = run;
    const config = yield* SpeepoboxConfig;
    const reporter = yield* Reporter;
    const fs = yield* FileSystem.FileSystem;
    const slug = slugFor(branch);
    const outFile = join(config.runtimeRoot, DETACHED_DIRNAME, `${slug}.out`);
    const logsDir = join(config.runtimeRoot, LOGS_DIRNAME);
    const lockFile = lockPathFor(config.runtimeRoot, slug);

    // Created and truncated here, so the next detach of the branch overwrites
    // it and the child only ever appends.
    yield* Effect.all([
      fs.makeDirectory(dirname(outFile), { recursive: true }),
      fs.writeFileString(outFile, ""),
    ]).pipe(
      Effect.mapError(
        (error) => new DetachRefused({ detail: `could not prepare ${outFile}: ${error.message}` }),
      ),
    );
    const spawnedAt = yield* Clock.currentTimeMillis;
    const child = yield* options.host.spawn(childArgvFor(run, options.repoRoot), outFile).pipe(
      Effect.mapError(
        (error) =>
          new DetachRefused({
            detail: `could not start the detached run for '${branch}': ${error.detail}`,
          }),
      ),
    );

    // Every line of the `.out` file the parent has not printed yet. A partial
    // last line waits for its newline, or for `flush` once the child is gone.
    const lines = lineSplitter();
    let printed = 0n;
    const relay = Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* fs.open(outFile, { flag: "r" });
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
          reporter.emit({ _tag: "DetachedOutput", line }),
        );
      }),
    ).pipe(
      Effect.mapError(
        (error) => new DetachRefused({ detail: `could not read ${outFile}: ${error.message}` }),
      ),
    );
    const flush = Effect.suspend(() =>
      Effect.forEach(lines.end(), (line) => reporter.emit({ _tag: "DetachedOutput", line })),
    );

    const holdsLock = Effect.map(options.host.lockOwner(lockFile), (owner) =>
      Option.contains(owner, child.pid),
    );
    // This run's log: T151's newest-log rule, and only a log numbered at or
    // after the spawn, so an earlier run of the branch is never taken for it.
    // The log opens just after the lock, so its existence also says the lock
    // was held.
    const runLog = fs.readDirectory(logsDir).pipe(
      Effect.orElseSucceed((): ReadonlyArray<string> => []),
      Effect.map((names) =>
        newestLogFor(slug, names).pipe(
          Option.filter((name) =>
            Option.exists(logStartedAt(name), (startedAt) => startedAt >= BigInt(spawnedAt)),
          ),
          Option.map((name) => join(logsDir, name)),
        ),
      ),
    );

    let started = false;
    let sawLock = false;

    // The finalizer of the wait's scope: unless the start line was printed,
    // the child gets one SIGINT and the parent waits for it, relaying what it
    // writes as it tears down, then says which case it was.
    const stopChild = Effect.gen(function* () {
      if (started || (yield* child.exited)) {
        return;
      }
      sawLock = sawLock || (yield* holdsLock);
      yield* child.interrupt;
      const deadline = (yield* Clock.currentTimeMillis) + Duration.toMillis(STOP_GRACE);
      let exited = false;
      while (true) {
        yield* Effect.ignore(relay);
        if (yield* child.exited) {
          exited = true;
          break;
        }
        if ((yield* Clock.currentTimeMillis) >= deadline) {
          break;
        }
        yield* Effect.sleep(poll);
      }
      yield* Effect.ignore(relay);
      if (exited) {
        yield* flush;
      }
      const heldLock = sawLock || Option.isSome(yield* runLog);
      yield* reporter.emit({ _tag: "DetachedStopped", branch, pid: child.pid, heldLock, exited });
    });

    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() => stopChild);
        const deadline = spawnedAt + Duration.toMillis(START_TIMEOUT);
        while (true) {
          yield* relay;
          if (yield* child.exited) {
            yield* relay;
            yield* flush;
            return yield* new DetachedChildExited({ branch, pid: child.pid });
          }
          if (yield* holdsLock) {
            sawLock = true;
            const log = yield* runLog;
            if (Option.isSome(log)) {
              yield* relay;
              // Printed and owned in one step: an interrupt between the two
              // would signal a run whose start line is already on screen.
              yield* Effect.uninterruptible(
                Effect.suspend(() => {
                  started = true;
                  return reporter.emit({
                    _tag: "DetachedStarted",
                    branch,
                    pid: child.pid,
                    log: log.value,
                  });
                }),
              );
              return;
            }
          }
          if ((yield* Clock.currentTimeMillis) >= deadline) {
            return yield* new DetachRefused({
              detail: `'${branch}' did not start within ${Duration.toSeconds(START_TIMEOUT)}s`,
            });
          }
          yield* Effect.sleep(poll);
        }
      }),
    );
  });
