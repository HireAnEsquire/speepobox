// The one lock-file read the reconciler and `status` share (T146), against a
// real scratch directory: what a lock file holds is the filesystem's answer.
import { describe, expect, it } from "@effect/vitest";
import { FileSystem, Path } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { Effect, Option } from "effect";
import { readLockOnDisk } from "../src/reconcile/lock-on-disk.ts";

describe("readLockOnDisk", () => {
  it.scoped("reads an absent file as no lock", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped();
      expect(yield* readLockOnDisk(path.join(dir, "absent.lock"))).toEqual(Option.none());
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("reads a file holding a pid as a lock that names its owner", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const file = path.join(yield* fs.makeTempDirectoryScoped(), "b.lock");
      yield* fs.writeFileString(file, "4242\n");
      expect(yield* readLockOnDisk(file)).toEqual(
        Option.some({ path: file, owner: Option.some(4242) }),
      );
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("reads an empty file as a lock nobody can name", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const file = path.join(yield* fs.makeTempDirectoryScoped(), "b.lock");
      yield* fs.writeFileString(file, "");
      expect(yield* readLockOnDisk(file)).toEqual(
        Option.some({ path: file, owner: Option.none() }),
      );
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("reads a directory at the path as no lock", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const file = path.join(yield* fs.makeTempDirectoryScoped(), "b.lock");
      yield* fs.makeDirectory(file);
      expect(yield* readLockOnDisk(file)).toEqual(Option.none());
    }).pipe(Effect.provide(NodeContext.layer)),
  );
});
