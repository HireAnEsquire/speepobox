// The one read of a lock file (T146). The reconciler's scan and `status` both
// call it, so a lock reads the same on both screens; the classification it
// feeds is `wreckage.ts`'s, which stays pure — this is the half that touches
// the filesystem.
import { FileSystem } from "@effect/platform";
import { Effect, Option } from "effect";
import { parsePid } from "../lock/liveness.ts";
import type { LockOnDisk } from "./wreckage.ts";

// A scan is a snapshot: a file that vanished under it is not wreckage
// anybody has to account for, so an unreadable entry drops out rather than
// becoming a lock nobody can name.
export const readLockOnDisk = (
  file: string,
): Effect.Effect<Option.Option<LockOnDisk>, never, FileSystem.FileSystem> =>
  Effect.flatMap(FileSystem.FileSystem, (fs) =>
    fs.readFileString(file).pipe(
      Effect.map((contents) => Option.some<LockOnDisk>({ path: file, owner: parsePid(contents) })),
      Effect.orElseSucceed(() => Option.none<LockOnDisk>()),
    ),
  );
