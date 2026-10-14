// A real repository with a tagged release on `main`, and a real directory
// inside its working tree that holds no repository of its own (T133). That is
// the shape bare `-C` answered for the *enclosing* repo: a package cache entry
// missing its `.git` under a `$HOME` that is itself a repository, or a served
// repo root that is not one. Every read pointed at `nested` must fail, or
// report not-a-repo, instead of answering with `repo`'s facts.
import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { exec } from "../../src/internal/exec.ts";

const HAND = ["-c", "user.email=t@example.com", "-c", "user.name=Test"];

export const repoWithNestedDir = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const repo = yield* fs.makeTempDirectoryScoped();
  const run = (...args: ReadonlyArray<string>) =>
    exec("git", "-C", repo, ...HAND, ...args).pipe(
      Effect.flatMap((result) =>
        result.exitCode === 0
          ? Effect.succeed(result.stdout.trim())
          : Effect.dieMessage(`git ${args.join(" ")}: ${result.stderr}`),
      ),
    );
  yield* exec("git", "init", "-q", "-b", "main", repo);
  const nested = `${repo}/nested`;
  yield* fs.makeDirectory(nested, { recursive: true });
  yield* fs.writeFileString(`${nested}/LEFT-BEHIND`, "no .git beside me\n");
  yield* run("add", "-A");
  yield* run("commit", "-q", "-m", "root");
  yield* run("tag", "v1");
  const sha = yield* run("rev-parse", "HEAD");
  return { repo, nested, sha };
}).pipe(Effect.orDie);
