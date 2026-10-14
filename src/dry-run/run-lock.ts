// `RunLock`, recording (T15): **no PID file is written**, and the path the
// claim would have taken is said instead.
//
// **The read half stays real, and here that half is load-bearing**: "is this
// branch already claimed by a run that is alive" is answerable without
// claiming anything, and it is the question bash's dry run asks too
// (`run.sh:2285`'s `check_no_inflight_run` — "a dry run must refuse
// identically to a real one when another run already owns this branch"). It is
// asked the way the reconciler asks it, off the lock file and through
// `liveness.ts`'s exported predicate, which is a classification and not a
// claim: nothing is created, nothing is linked, nothing is evicted. The
// TOCTOU race a stat-then-write would lose (T20) is not a race a rehearsal can
// lose, because it never takes the lock.
//
// It matters beyond fidelity. A rehearsal that claimed unconditionally would
// walk past a live run of the same branch and into the checkout step, where
// `dispatch/checkout.ts` clears the directory it finds — and that directory
// would be the live run's working copy. The refusal is what keeps a dry run
// from reaching it. (The residue is in AGENTS.md: filesystem writes are not
// behind a tag, so the swap cannot cover the checkout removals a *dead* run's
// leftovers still get.)
//
// A stale lock is recorded rather than reclaimed: the eviction is a write, so
// it is said and not done, and the `Warned` the live layer emits on a real
// reclaim is deliberately not said here — nothing was reclaimed.
//
// The two events are emitted from the reporter this layer was built over,
// exactly as `RunLockLive` emits them: the run log opens *after* the lock, so
// the lock's pair belongs to the console at both ends (AGENTS.md).
import { FileSystem } from "@effect/platform";
import { Effect, Layer, Option } from "effect";
import { BessemerConfig } from "../config/config.ts";
import { lockPathFor } from "../dispatch/plan.ts";
import { ownerIsAlive, parsePid } from "../lock/liveness.ts";
import { LockError, LockHeld, RunLock, type RunLockShape } from "../lock/run-lock.ts";
import { Reporter, type ReporterShape } from "../reporter.ts";
import { recorded } from "./record.ts";

export const recordingRunLock = (
  runtimeRoot: string,
  // The pid the claim would have recorded — this process, read where the live
  // layer reads it, because there is no other process a lock file could
  // honestly name.
  pid: number,
  reporter: ReporterShape,
  fs: FileSystem.FileSystem,
): RunLockShape => ({
  acquire: (slug) =>
    Effect.gen(function* () {
      const file = lockPathFor(runtimeRoot, slug);
      // An absent lock is nobody's, which is the ordinary case and the reason
      // this reads rather than stats: the file's *contents* are the owner.
      const owner = yield* fs.readFileString(file).pipe(
        Effect.map(parsePid),
        Effect.catchIf(
          (error) => error._tag === "SystemError" && error.reason === "NotFound",
          () => Effect.succeed(Option.none<number>()),
        ),
        Effect.mapError((error) => new LockError({ detail: `${file}: ${error.message}` })),
      );
      if (ownerIsAlive(owner)) {
        return yield* new LockHeld({
          detail: `another bessemer run (pid ${Option.getOrElse(owner, () => pid)}) is already working '${slug}' — wait for it or kill it`,
        });
      }

      const stale =
        Option.isSome(owner) || (yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false)));
      return yield* Effect.acquireRelease(
        (stale
          ? recorded(
              reporter,
              `evict the stale lock at ${file} — ${Option.match(owner, {
                onNone: () => "it records no live pid",
                onSome: (dead) => `pid ${dead} is not alive`,
              })}`,
            )
          : Effect.void
        ).pipe(
          Effect.zipRight(recorded(reporter, `claim the run lock at ${file} for pid ${pid}`)),
          Effect.zipRight(reporter.emit({ _tag: "ResourceAcquired", resource: "lock" })),
          // `reclaimed` says a stale lock was taken, and a rehearsal took
          // nothing — the file is still there, and the next real dispatch is
          // what reclaims it.
          Effect.as({ path: file, pid, reclaimed: false }),
        ),
        (claim) =>
          recorded(reporter, `release the run lock at ${claim.path}`).pipe(
            Effect.zipRight(reporter.emit({ _tag: "ResourceReleased", resource: "lock" })),
          ),
      );
    }),
});

export const RunLockRecordingLive: Layer.Layer<
  RunLock,
  never,
  BessemerConfig | Reporter | FileSystem.FileSystem
> = Layer.effect(
  RunLock,
  Effect.map(
    Effect.all([BessemerConfig, Reporter, FileSystem.FileSystem]),
    ([config, reporter, fs]) => recordingRunLock(config.runtimeRoot, process.pid, reporter, fs),
  ),
);
