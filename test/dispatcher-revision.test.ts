// T43: `resolveDispatcherRevision` against the scripted executor for the
// mapping from git's answers to the domain value, and against a real
// repository for the one thing a fixture cannot fake — that "dirty" is
// scoped to the package directory and not to the repo as a whole.
import { describe, expect, it } from "@effect/vitest";
import { FileSystem } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { Effect, Option, Ref } from "effect";
import { packagePathspec, packageRoot } from "../src/config/paths.ts";
import { exec } from "../src/internal/exec.ts";
import { resolveDispatcherRevision } from "../src/git/dispatcher-revision.ts";
import { type ScriptedResult, scriptedExecutor } from "./support/exec-fake.ts";
import { repoWithNestedDir } from "./support/nested-dir.ts";

const REPO_ROOT = "/srv/hae";
const revisionCommand = `git -C ${REPO_ROOT} --git-dir=${REPO_ROOT}/.git rev-parse HEAD --short HEAD`;
const SHA = "6345f52a9d1e0c7b3f8e2d4a6c1b9e7f0a3d5c8b";
const statusCommand = `git -C ${REPO_ROOT} --git-dir=${REPO_ROOT}/.git status --porcelain -- ${packagePathspec(REPO_ROOT).join(" ")}`;

const resolve = (script: Record<string, ScriptedResult>) =>
  Effect.gen(function* () {
    const recorded = yield* Ref.make<ReadonlyArray<string>>([]);
    const result = yield* resolveDispatcherRevision(REPO_ROOT).pipe(
      Effect.provide(scriptedExecutor(script, recorded)),
    );
    return { result, recorded: yield* Ref.get(recorded) };
  });

describe("resolveDispatcherRevision, against the scripted executor", () => {
  it.effect("is Some, clean, when HEAD resolves and the package directory has no changes", () =>
    Effect.gen(function* () {
      const { result, recorded } = yield* resolve({
        [revisionCommand]: { exit: 0, stdout: `${SHA}\n6345f52\n` },
        [statusCommand]: { exit: 0, stdout: "" },
      });
      expect(result).toEqual(Option.some({ sha: SHA, revision: "6345f52", dirty: false }));
      expect(recorded).toEqual([revisionCommand, statusCommand]);
    }),
  );

  it.effect("is Some, dirty, when the scoped status prints any line", () =>
    Effect.gen(function* () {
      const { result } = yield* resolve({
        [revisionCommand]: { exit: 0, stdout: `${SHA}\n6345f52\n` },
        [statusCommand]: { exit: 0, stdout: " M src/bin.ts\n" },
      });
      expect(result).toEqual(Option.some({ sha: SHA, revision: "6345f52", dirty: true }));
    }),
  );

  // None only when the revision itself could not be read — never a
  // fabricated clean, and never a defect.
  it.effect("is None when HEAD does not resolve, and spends no status call", () =>
    Effect.gen(function* () {
      const { result, recorded } = yield* resolve({
        [revisionCommand]: { exit: 128, stderr: "fatal: not a git repository" },
      });
      expect(result).toEqual(Option.none());
      expect(recorded).toEqual([revisionCommand]);
    }),
  );

  // A read that came back empty is None, never a fabricated value (T123).
  it.effect("is None when HEAD resolves to nothing, and spends no status call", () =>
    Effect.gen(function* () {
      const { result, recorded } = yield* resolve({
        [revisionCommand]: { exit: 0, stdout: "" },
      });
      expect(result).toEqual(Option.none());
      expect(recorded).toEqual([revisionCommand]);
    }),
  );

  it.effect("is None when git itself is not on the host", () =>
    Effect.gen(function* () {
      const { result } = yield* resolve({});
      expect(result).toEqual(Option.none());
    }),
  );
});

// A real repository, the way `dispatcher-freshness.test.ts`'s `realRepo` is:
// `packagePathspec` is a fact about *this* checkout's own layout, so a
// fixture cannot make `resolveDispatcherRevision` itself answer about a
// directory of the fixture's choosing. What a fixture can prove for real is
// the scoping rule — `pkg/` stands in for the package directory and `other/`
// for the rest of the repo, and only a change under the first may flip
// `dirty`.
const HAND = ["-c", "user.email=t@example.com", "-c", "user.name=Test"];
const PKG = "pkg";

const realRepo = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const repo = yield* fs.makeTempDirectoryScoped();
  const run = (...args: ReadonlyArray<string>) =>
    exec("git", "-C", repo, ...HAND, ...args).pipe(Effect.map((result) => result.stdout.trim()));
  yield* fs.makeDirectory(`${repo}/${PKG}`, { recursive: true });
  yield* fs.makeDirectory(`${repo}/other`, { recursive: true });
  yield* fs.writeFileString(`${repo}/${PKG}/root.txt`, "root\n");
  yield* fs.writeFileString(`${repo}/other/root.md`, "root\n");
  yield* exec("git", "init", "-q", "-b", "main", repo);
  yield* run("add", "-A");
  yield* run("commit", "-q", "-m", "root");
  const revision = yield* run("rev-parse", "--short", "HEAD");
  return { repo, run, fs, revision };
}).pipe(Effect.orDie);

const provideReal = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(NodeContext.layer));

describe("the dirty question, against a real repository", () => {
  // T123: both forms off the one call, against real git — the full SHA is
  // what `rev-parse HEAD` prints, and the short form is still exactly what
  // `--short` gives, since rows already on disk carry it.
  it.scoped("carries the full SHA and git's own short revision", () =>
    provideReal(
      Effect.gen(function* () {
        const { repo, run, revision } = yield* realRepo;
        const result = yield* resolveDispatcherRevision(repo);
        const resolved = Option.getOrThrow(result);
        expect(resolved.sha).toMatch(/^[0-9a-f]{40}$/);
        expect(resolved.sha).toBe(yield* run("rev-parse", "HEAD"));
        expect(resolved.revision).toBe(revision);
      }),
    ),
  );

  it.scoped("HEAD resolves to a real short revision, and nothing is dirty yet", () =>
    provideReal(
      Effect.gen(function* () {
        const { repo, revision } = yield* realRepo;
        expect(yield* exec("git", "-C", repo, "rev-parse", "--short", "HEAD")).toMatchObject({
          exitCode: 0,
          stdout: `${revision}\n`,
        });
        const status = yield* exec("git", "-C", repo, "status", "--porcelain", "--", PKG);
        expect(status.stdout.trim()).toBe("");
      }),
    ),
  );

  // The acceptance case this ticket names: an edit under the package
  // directory is dirty.
  it.scoped("is dirty when the package directory holds an uncommitted edit", () =>
    provideReal(
      Effect.gen(function* () {
        const { repo, fs } = yield* realRepo;
        yield* fs.writeFileString(`${repo}/${PKG}/draft.ts`, "not committed\n");
        const status = yield* exec("git", "-C", repo, "status", "--porcelain", "--", PKG);
        expect(status.stdout.trim()).not.toBe("");
      }),
    ),
  );

  // And the other acceptance case: an edit anywhere else leaves the
  // package-scoped question clean.
  it.scoped("stays clean when only the rest of the repo holds an uncommitted edit", () =>
    provideReal(
      Effect.gen(function* () {
        const { repo, fs } = yield* realRepo;
        yield* fs.writeFileString(`${repo}/other/draft.md`, "not committed\n");
        const status = yield* exec("git", "-C", repo, "status", "--porcelain", "--", PKG);
        expect(status.stdout.trim()).toBe("");
      }),
    ),
  );
});

// The named source set's own split (T49), proved against real git rather
// than the single synthetic `pkg` pathspec above: `packagePathspec(packageRoot)`
// renders the six bare entry names, mirrored here alongside `test/` as
// tracked but not-source, so the acceptance case naming `test/` and `src/`
// specifically is asked of real git.
describe("the named source set's dirty question, against a real repository", () => {
  const ENTRIES = packagePathspec(packageRoot);

  const namedRepo = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const repo = yield* fs.makeTempDirectoryScoped();
    const run = (...args: ReadonlyArray<string>) =>
      exec("git", "-C", repo, ...HAND, ...args).pipe(Effect.map((result) => result.stdout.trim()));
    for (const entry of [...ENTRIES, "test"]) {
      yield* fs.makeDirectory(`${repo}/${entry}`, { recursive: true });
      yield* fs.writeFileString(`${repo}/${entry}/root.txt`, "root\n");
    }
    yield* exec("git", "init", "-q", "-b", "main", repo);
    yield* run("add", "-A");
    yield* run("commit", "-q", "-m", "root");
    return { repo, fs };
  }).pipe(Effect.orDie);

  it.scoped("does not mark a row dirty for an uncommitted edit under test/", () =>
    provideReal(
      Effect.gen(function* () {
        const { repo, fs } = yield* namedRepo;
        yield* fs.writeFileString(`${repo}/test/draft.test.ts`, "not committed\n");
        const status = yield* exec("git", "-C", repo, "status", "--porcelain", "--", ...ENTRIES);
        expect(status.stdout.trim()).toBe("");
      }),
    ),
  );

  it.scoped("marks a row dirty for an uncommitted edit under src/", () =>
    provideReal(
      Effect.gen(function* () {
        const { repo, fs } = yield* namedRepo;
        yield* fs.writeFileString(`${repo}/src/draft.ts`, "not committed\n");
        const status = yield* exec("git", "-C", repo, "status", "--porcelain", "--", ...ENTRIES);
        expect(status.stdout.trim()).not.toBe("");
      }),
    ),
  );
});

// A package root missing its `.git` under a repository (T133): no revision,
// rather than the enclosing repo's.
describe("resolveDispatcherRevision, pointed at a directory that is not a repository", () => {
  it.scoped("is None rather than the revision of the repo enclosing it", () =>
    provideReal(
      Effect.gen(function* () {
        const { repo, nested, sha } = yield* repoWithNestedDir;
        expect(Option.map(yield* resolveDispatcherRevision(repo), (r) => r.sha)).toEqual(
          Option.some(sha),
        );
        expect(yield* resolveDispatcherRevision(nested)).toEqual(Option.none());
      }),
    ),
  );
});
