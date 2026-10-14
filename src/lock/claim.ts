// The lock claim (SPEC §4): the one operation that creates a lock file, and
// the only place "did someone else get here first" is answered. `RunLock`
// acquisition claims through it and T8's reconciler will claim through the
// same one — a second implementation would be a second answer to that
// question over one lock directory, which is the drift `liveness.ts` already
// refuses for staleness.
//
// A unique temp file plus `link`, never an exclusive create and never a
// stat-then-write. Two things the pair buys that a create does not:
//
//   - the pid is written before the name exists, so no reader ever sees a
//     half-written lock. An empty lock file is an owner nobody can name
//     (`liveness.ts`), which is a lock the next dispatch reclaims — under an
//     exclusive create that window is a live run's own lock, one syscall old.
//   - `link` refuses to replace an existing destination, so a claim can only
//     put an owner where there was none. `AlreadyExists` from the kernel *is*
//     the collision, rather than a conclusion drawn from a stat this process
//     took a moment ago.
import { FileSystem, Path } from "@effect/platform";
import type { PlatformError } from "@effect/platform/Error";
import { Effect } from "effect";

// Won or lost, and nothing else. Every other way a claim can go wrong stays
// in the error channel, where the caller keeps it distinct — "someone else
// owns this branch" and "this host's disk is broken" are different answers.
export type ClaimOutcome = "claimed" | "collided";

const isCollision = (error: PlatformError): boolean =>
  error._tag === "SystemError" && error.reason === "AlreadyExists";

// Unique among live claims without asking the host anything: the pid is
// unique among live processes, the serial among this process's own concurrent
// claims. The temp file sits in the lock's own directory so the link stays
// inside one filesystem, and its name does not end in `.pid`, so a scan of
// the locks directory cannot mistake a claim in flight for a lock.
let serial = 0;

const tempPathFor = (path: Path.Path, file: string, pid: number, attempt: number): string =>
  path.join(path.dirname(file), `${path.basename(file)}.${pid}.${attempt}.claim`);

export const claimLockFile = (
  file: string,
  pid: number,
): Effect.Effect<ClaimOutcome, PlatformError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const attempt = yield* Effect.sync(() => (serial += 1));
    const temp = tempPathFor(path, file, pid, attempt);

    return yield* Effect.gen(function* () {
      // Truncating rather than exclusive: this path is this attempt's by
      // construction, and refusing to overwrite debris a killed run left
      // behind would wedge every later claim that lands on the same name.
      yield* fs.writeFileString(temp, `${pid}\n`);
      return yield* fs.link(temp, file).pipe(
        Effect.as("claimed" as const),
        Effect.catchIf(isCollision, () => Effect.succeed("collided" as const)),
      );
    }).pipe(
      // Both paths, and interruption with them: the temp file is never what a
      // caller holds, so it leaves with the attempt that made it. A removal
      // that itself fails is swallowed — the claim's outcome is the answer
      // being reported, and a leftover `.claim` file blocks nothing.
      Effect.ensuring(Effect.ignore(fs.remove(temp, { force: true }))),
    );
  });
