// `RunLock` (SPEC §2/§4): the first resource in the run's `Scope`, and a PID
// file rather than a `Semaphore` (05 Q17) — the contention this exists to see
// is two invocations in two terminals, which an in-process primitive cannot.
// It lives under the runtime root (the served repo's bessemer directory by
// default, T57), keyed by the slug the plan derives.
//
// `LockHeld` comes from a *claim that collided*, never from a stat-then-write:
// checking for the file and then writing it is a TOCTOU race two dispatches
// can both win. The collision *is* the answer, and `claim.ts` is where it is
// taken — every lock file this port writes is written there, by acquisition
// today and by T8's reconciler next. Every other failure stays a typed
// `LockError`; the two are never flattened together, because "someone else
// owns this branch" and "this host's disk is broken" are different answers to
// the dispatcher.
import { FileSystem, Path } from "@effect/platform";
import type { PlatformError } from "@effect/platform/Error";
import { Context, Data, Effect, Layer, Option, Schema, type Scope } from "effect";
import { BessemerConfig } from "../config/config.ts";
import { lockPathFor } from "../dispatch/plan.ts";
import { Reporter } from "../reporter.ts";
import { type ClaimOutcome, claimLockFile } from "./claim.ts";
import { ownerIsAlive, parsePid } from "./liveness.ts";
import { withEvictionWitness } from "./witness.ts";

// Another live run owns this branch (SPEC §3, matrix row 3). Nothing is
// acquired and no ledger row is written — the run never started.
export class LockHeld extends Data.TaggedError("LockHeld")<{
  readonly detail: string;
}> {}

// The lock file could not be written or read for a reason that is not a
// collision — an unwritable runtime root, a lock path that is a directory.
// Kept distinct from `LockHeld` on purpose: flattening them would report a
// broken host as a colleague's dispatch.
export class LockError extends Data.TaggedError("LockError")<{
  readonly detail: string;
}> {}

export const LockClaim = Schema.Struct({
  path: Schema.String,
  // This process. The reconciler (T8) reads it back out of the file and asks
  // the same liveness predicate about it.
  pid: Schema.Int,
  // True when acquisition found a lock whose owner was not alive and took it.
  // The specifics go to the `Reporter`; this is what a caller can branch on.
  reclaimed: Schema.Boolean,
});
export type LockClaim = Schema.Schema.Type<typeof LockClaim>;

export interface RunLockShape {
  // Scoped in the interface, not at the call site: release is the reverse of
  // acquisition and the `Scope` runs it on success, on typed failure, and on
  // interrupt.
  readonly acquire: (slug: string) => Effect.Effect<LockClaim, LockHeld | LockError, Scope.Scope>;
}

export class RunLock extends Context.Tag("RunLock")<RunLock, RunLockShape>() {}

export const RunLockLive: Layer.Layer<
  RunLock,
  never,
  BessemerConfig | Reporter | FileSystem.FileSystem | Path.Path
> = Layer.effect(
  RunLock,
  Effect.gen(function* () {
    const config = yield* BessemerConfig;
    // The reporter this layer was built over — the console. It is never the
    // run log: that one is provided further in, and does not yet exist when
    // the lock is claimed. `dispatch/run.ts` carries the ruling on why the
    // lock's acquired/released pair stays off the log at both ends.
    const reporter = yield* Reporter;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    // The lock records *this* process, so the pid is read here rather than at
    // the composition root: there is no other process whose identity a lock
    // file could honestly carry.
    const pid = process.pid;

    const lockError = (file: string) => (error: PlatformError) =>
      new LockError({ detail: `${file}: ${error.message}` });

    // The claim, with this layer's own `FileSystem` and `Path` handed to it:
    // the primitive consumes both tags directly, and acquisition owes its
    // caller an effect that needs nothing but the run's `Scope`.
    const claimFile = (file: string): Effect.Effect<ClaimOutcome, LockError> =>
      claimLockFile(file, pid).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.mapError(lockError(file)),
      );

    // The eviction, held the same way: free the path and claim it, under a
    // witness keyed to the owner just found dead. `Option.none()` is another
    // dispatch already evicting that same corpse — this one removed nothing.
    const evictFile = (
      file: string,
      owner: Option.Option<number>,
    ): Effect.Effect<Option.Option<ClaimOutcome>, LockError> =>
      withEvictionWitness(
        file,
        owner,
        fs.remove(file, { force: true }).pipe(Effect.zipRight(claimLockFile(file, pid))),
      ).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.mapError(lockError(file)),
      );

    // Whose lock is this? An unreadable-because-gone file is an owner nobody
    // can name, which reads the same as an empty one: not provably alive.
    // The platform error stays raw — acquisition types it as a `LockError`,
    // and release reports it in the warning it was already reporting.
    const ownerOf = (file: string): Effect.Effect<Option.Option<number>, PlatformError> =>
      fs.readFileString(file).pipe(
        Effect.map(parsePid),
        Effect.catchIf(
          (error) => error._tag === "SystemError" && error.reason === "NotFound",
          () => Effect.succeed(Option.none<number>()),
        ),
      );

    const acquireFile = (slug: string): Effect.Effect<LockClaim, LockHeld | LockError> =>
      Effect.gen(function* () {
        const file = lockPathFor(config.runtimeRoot, slug);
        yield* fs
          .makeDirectory(path.dirname(file), { recursive: true })
          .pipe(Effect.mapError(lockError(file)));

        if ((yield* claimFile(file)) === "claimed") {
          return { path: file, pid, reclaimed: false };
        }

        // Reclamation is part of acquisition, not a step beside it: the
        // question "is this lock stale" only ever gets asked because a claim
        // collided, and asking it earlier is the stat-then-write race again.
        const owner = yield* ownerOf(file).pipe(Effect.mapError(lockError(file)));
        if (ownerIsAlive(owner)) {
          return yield* new LockHeld({
            detail: `another bessemer run (pid ${owner.value}) is already working '${slug}' — wait for it or kill it`,
          });
        }

        // Removing the corpse is exclusive for the same reason creating a lock
        // is: two dispatches that read this one dead owner would both remove
        // it, and the second removal takes the first's *fresh* lock with it.
        // The witness settles that through the kernel, keyed to the pid just
        // read, so a later corpse's eviction is never blocked by it (T21).
        const evicted = yield* evictFile(file, owner);
        if (Option.isNone(evicted) || evicted.value === "collided") {
          // Another dispatch got to the same stale lock first, and this one
          // holds nothing — it either lost the witness and removed nothing, or
          // claimed after the corpse was gone and landed on a lock somebody
          // else had just written.
          //
          // **"got to", not "reclaimed"**: the three ways in are not all in
          // the same tense. Losing the witness means the other eviction is
          // still *in flight*, while the other two mean it finished and the
          // branch is already relocked. One sentence covers all three only if
          // it does not claim the reclaim is over — and the case a dispatcher
          // most often reads this on is the one where it is not.
          return yield* new LockHeld({
            detail: `another bessemer run got to the stale lock on '${slug}' first — wait for it or kill it`,
          });
        }
        yield* reporter.emit({
          _tag: "Warned",
          detail: `reclaimed a stale lock on '${slug}' at ${file} — ${Option.match(owner, {
            onNone: () => "it recorded no live pid",
            onSome: (dead) => `pid ${dead} is not alive`,
          })}`,
        });
        return { path: file, pid, reclaimed: true };
      });

    // Release cannot fail (design rule 4, matrix row 19): a failing finalizer
    // becomes a defect and would mask the run's own error, so this reports and
    // swallows. The next dispatch's reconciler is what cleans up after it.
    // The lock is the first resource in and the last out, so the two events
    // below are the ends the ordering assertion reads (SPEC §11).
    //
    // What it removes is a lock that still records *this* run, never whatever
    // is at the recorded path: a force-remove of the path deletes a live
    // colleague's lock whenever an interleaving took this one away, which is
    // the release half of the eviction race (T21).
    const releaseFile = (claim: LockClaim): Effect.Effect<void> =>
      ownerOf(claim.path).pipe(
        Effect.flatMap((owner) =>
          Option.isSome(owner) && owner.value === claim.pid
            ? fs
                .remove(claim.path, { force: true })
                .pipe(
                  Effect.zipRight(reporter.emit({ _tag: "ResourceReleased", resource: "lock" })),
                )
            : reporter.emit({
                _tag: "Warned",
                detail: `the run lock at ${claim.path} is no longer this run's — ${Option.match(
                  owner,
                  {
                    onNone: () => "it records no live pid",
                    onSome: (other) => `pid ${other} records it now`,
                  },
                )}, so it is left alone`,
              }),
        ),
        Effect.catchAll((error) =>
          reporter.emit({
            _tag: "Warned",
            detail: `could not remove the run lock at ${claim.path} (${error.message}) — the next dispatch reclaims it`,
          }),
        ),
      );

    return {
      acquire: (slug) =>
        Effect.acquireRelease(
          acquireFile(slug).pipe(
            Effect.tap(() => reporter.emit({ _tag: "ResourceAcquired", resource: "lock" })),
          ),
          releaseFile,
        ),
    };
  }),
);
