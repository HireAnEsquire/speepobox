// The dispatcher-freshness question (T42): the pure module's argv and verdict
// as values, the verdict against real git ancestry, and the whole probe
// against the scripted executor. The offline criterion is covered the way it
// will actually regress: the rendered argv is asserted, so a `fetch` added
// later fails the test rather than merely slowing doctor down.
import { describe, expect, it } from "@effect/vitest";
import { FileSystem } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { Effect, Ref } from "effect";
import { packagePathspec, packageRoot } from "../src/config/paths.ts";
import { dispatcherFreshnessProbe } from "../src/doctor/probes.ts";
import {
  dispatcherFreshnessArgs,
  readDispatcherFreshness,
} from "../src/git/dispatcher-freshness.ts";
import { exec, type ExecResult } from "../src/internal/exec.ts";
import { type ScriptedResult, scriptedExecutor } from "./support/exec-fake.ts";

describe("dispatcherFreshnessArgs", () => {
  it("lists a range under the package pathspec, and asks nothing else", () => {
    expect(dispatcherFreshnessArgs("/srv/hae", "origin/main")).toEqual([
      "rev-list",
      "HEAD..origin/main",
      "--",
      ...packagePathspec("/srv/hae"),
    ]);
  });
});

describe("readDispatcherFreshness", () => {
  it("is Current on an empty range", () => {
    expect(readDispatcherFreshness({ exitCode: 0, stdout: "" })).toEqual({ _tag: "Current" });
    expect(readDispatcherFreshness({ exitCode: 0, stdout: "\n" })).toEqual({ _tag: "Current" });
  });

  it("is Stale with the listed SHAs when the range holds commits", () => {
    const sha1 = "1".repeat(40);
    const sha2 = "2".repeat(40);
    expect(readDispatcherFreshness({ exitCode: 0, stdout: `${sha1}\n${sha2}\n` })).toEqual({
      _tag: "Stale",
      missing: [sha1, sha2],
    });
  });

  it("is BaseUnresolvable on any nonzero exit, regardless of stdout", () => {
    expect(readDispatcherFreshness({ exitCode: 128, stdout: "" })).toEqual({
      _tag: "BaseUnresolvable",
    });
  });
});

// A real repository, the way `git.test.ts`'s `realRepo` is: `packagePathspec`
// is a fact about *this* checkout's own layout (`packageRoot` relative to the
// repo root), so a scratch fixture cannot make `dispatcherFreshnessProbe`
// itself answer about a directory of the fixture's own choosing. What a
// fixture *can* stand in for is git's own ancestry answer — the same argv
// shape this module renders, run for real against the fixture's own pathspec
// and read back through `readDispatcherFreshness` — which is the ancestry
// logic the ticket asks to prove against fixtures rather than host facts.
// `pkg/` and `other/` stand in for the package directory and the rest of the
// repo (`docs/`), so "a base commit outside the package directory does not
// warn" is a real git answer and not an assumption about `--` semantics.
const HAND = ["-c", "user.email=t@example.com", "-c", "user.name=Test"];
const BRANCH = "dispatcher";
const BASE_BRANCH = "upstream";
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
  yield* exec("git", "init", "-q", "-b", BRANCH, repo);
  yield* run("add", "-A");
  yield* run("commit", "-q", "-m", "root");
  yield* run("branch", BASE_BRANCH);
  const freshness = (base: string) =>
    exec("git", "-C", repo, "rev-list", `HEAD..${base}`, "--", PKG).pipe(
      Effect.map((result: ExecResult) => readDispatcherFreshness(result)),
    );
  return { repo, run, fs, freshness };
}).pipe(Effect.orDie);

const provideReal = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(NodeContext.layer));

describe("the ancestry question, against a real repository", () => {
  it.scoped("is Current when HEAD already holds everything the base does", () =>
    provideReal(
      Effect.gen(function* () {
        const { freshness } = yield* realRepo;
        expect(yield* freshness(BASE_BRANCH)).toEqual({ _tag: "Current" });
      }),
    ),
  );

  it.scoped(
    "is Current when the base's extra commit touches nothing under the package directory",
    () =>
      provideReal(
        Effect.gen(function* () {
          const { repo, run, fs, freshness } = yield* realRepo;
          yield* run("checkout", "-q", BASE_BRANCH);
          yield* fs.writeFileString(`${repo}/other/note.md`, "a doc change\n");
          yield* run("add", "-A");
          yield* run("commit", "-q", "-m", "docs only");
          yield* run("checkout", "-q", BRANCH);

          expect(yield* freshness(BASE_BRANCH)).toEqual({ _tag: "Current" });
        }),
      ),
  );

  it.scoped("is Stale and names the missing commit when the base gained a package commit", () =>
    provideReal(
      Effect.gen(function* () {
        const { repo, run, fs, freshness } = yield* realRepo;
        yield* run("checkout", "-q", BASE_BRANCH);
        yield* fs.writeFileString(`${repo}/${PKG}/feature.ts`, "export const x = 1;\n");
        yield* run("add", "-A");
        yield* run("commit", "-q", "-m", "package change");
        const sha = yield* run("rev-parse", "HEAD");
        yield* run("checkout", "-q", BRANCH);

        expect(yield* freshness(BASE_BRANCH)).toEqual({ _tag: "Stale", missing: [sha] });
      }),
    ),
  );

  // The regression case the ticket exists for: local edits under the package
  // directory are the normal state of a repo building itself, and the
  // ancestry answer must not move because of them.
  it.scoped("does not change when the package directory holds uncommitted edits", () =>
    provideReal(
      Effect.gen(function* () {
        const { repo, run, fs, freshness } = yield* realRepo;
        yield* run("checkout", "-q", BASE_BRANCH);
        yield* fs.writeFileString(`${repo}/${PKG}/feature.ts`, "export const x = 1;\n");
        yield* run("add", "-A");
        yield* run("commit", "-q", "-m", "package change");
        const sha = yield* run("rev-parse", "HEAD");
        yield* run("checkout", "-q", BRANCH);

        const before = yield* freshness(BASE_BRANCH);
        yield* fs.writeFileString(`${repo}/${PKG}/draft.ts`, "not committed\n");
        const after = yield* freshness(BASE_BRANCH);

        expect(before).toEqual({ _tag: "Stale", missing: [sha] });
        expect(after).toEqual(before);
      }),
    ),
  );

  // A HEAD ahead of its base — the ordinary state of a repo mid-stack, and
  // not what this probe refuses (that is T44's).
  it.scoped("is Current when HEAD is ahead of the base under the package directory", () =>
    provideReal(
      Effect.gen(function* () {
        const { repo, run, fs, freshness } = yield* realRepo;
        yield* fs.writeFileString(`${repo}/${PKG}/own.ts`, "export const y = 2;\n");
        yield* run("add", "-A");
        yield* run("commit", "-q", "-m", "dispatcher's own package commit");

        expect(yield* freshness(BASE_BRANCH)).toEqual({ _tag: "Current" });
      }),
    ),
  );

  it.scoped("is BaseUnresolvable when the base ref does not exist in this clone", () =>
    provideReal(
      Effect.gen(function* () {
        const { freshness } = yield* realRepo;
        expect(yield* freshness("origin/does-not-exist-here")).toEqual({
          _tag: "BaseUnresolvable",
        });
      }),
    ),
  );
});

// The named source set (18's ruling), proved against real git rather than
// the single synthetic `pkg` pathspec above: `packagePathspec(packageRoot)`
// renders the six bare entry names (`config.test.ts` pins the exact list),
// and this fixture mirrors them for real, alongside `tasks/` and `test/` as
// tracked but not-source, so the ticket's own acceptance cases — the tasks/
// defect, each source path, and the test/-versus-src/ split — are asked of
// real git rather than assumed from the single-pathspec case above.
describe("the named source set, against a real repository", () => {
  const ENTRIES = packagePathspec(packageRoot);
  const NOT_SOURCE = ["tasks", "test"];

  const namedRepo = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const repo = yield* fs.makeTempDirectoryScoped();
    const run = (...args: ReadonlyArray<string>) =>
      exec("git", "-C", repo, ...HAND, ...args).pipe(Effect.map((result) => result.stdout.trim()));
    for (const entry of [...ENTRIES, ...NOT_SOURCE]) {
      yield* fs.makeDirectory(`${repo}/${entry}`, { recursive: true });
      yield* fs.writeFileString(`${repo}/${entry}/root.txt`, "root\n");
    }
    yield* exec("git", "init", "-q", "-b", BRANCH, repo);
    yield* run("add", "-A");
    yield* run("commit", "-q", "-m", "root");
    yield* run("branch", BASE_BRANCH);
    const freshness = (base: string) =>
      exec("git", "-C", repo, "rev-list", `HEAD..${base}`, "--", ...ENTRIES).pipe(
        Effect.map((result: ExecResult) => readDispatcherFreshness(result)),
      );
    return { repo, run, fs, freshness };
  }).pipe(Effect.orDie);

  // The defect this ticket exists for: a one-off spec under `tasks/` must
  // not stale the dispatcher.
  it.scoped("is Current when the base's extra commit touches only tasks/", () =>
    provideReal(
      Effect.gen(function* () {
        const { repo, run, fs, freshness } = yield* namedRepo;
        yield* run("checkout", "-q", BASE_BRANCH);
        yield* fs.writeFileString(`${repo}/tasks/T99.md`, "# T99\n");
        yield* run("add", "-A");
        yield* run("commit", "-q", "-m", "one-off spec");
        yield* run("checkout", "-q", BRANCH);

        expect(yield* freshness(BASE_BRANCH)).toEqual({ _tag: "Current" });
      }),
    ),
  );

  for (const entry of ENTRIES) {
    it.scoped(`is Stale when the base gained a commit under ${entry}`, () =>
      provideReal(
        Effect.gen(function* () {
          const { repo, run, fs, freshness } = yield* namedRepo;
          yield* run("checkout", "-q", BASE_BRANCH);
          yield* fs.writeFileString(`${repo}/${entry}/feature.ts`, "export const x = 1;\n");
          yield* run("add", "-A");
          yield* run("commit", "-q", "-m", `change under ${entry}`);
          const sha = yield* run("rev-parse", "HEAD");
          yield* run("checkout", "-q", BRANCH);

          expect(yield* freshness(BASE_BRANCH)).toEqual({ _tag: "Stale", missing: [sha] });
        }),
      ),
    );
  }
});

describe("dispatcherFreshnessProbe", () => {
  it.effect("warns without spending a git call when no base is configured", () =>
    Effect.gen(function* () {
      const recorded = yield* Ref.make<ReadonlyArray<string>>([]);
      const rows = yield* dispatcherFreshnessProbe("/srv/hae", "").pipe(
        Effect.provide(scriptedExecutor({}, recorded)),
      );
      expect(rows[0]?.status).toBe("warn");
      expect(yield* Ref.get(recorded)).toEqual([]);
    }),
  );

  const REPO_ROOT = "/srv/hae";
  const BASE = "origin/main";
  const runScripted = (script: Record<string, ScriptedResult>) =>
    Effect.gen(function* () {
      const recorded = yield* Ref.make<ReadonlyArray<string>>([]);
      const rows = yield* dispatcherFreshnessProbe(REPO_ROOT, BASE).pipe(
        Effect.provide(scriptedExecutor(script, recorded)),
      );
      return { rows, recorded: yield* Ref.get(recorded) };
    });

  // The offline criterion, asserted as words rather than intended in a
  // comment: no argv this probe renders may contain `fetch`, on any of the
  // three verdicts.
  it.effect("renders the shared argv and maps each verdict to a row, issuing no fetch", () =>
    Effect.gen(function* () {
      const command = `git -C ${REPO_ROOT} --git-dir=${REPO_ROOT}/.git rev-list HEAD..${BASE} -- ${packagePathspec(REPO_ROOT).join(" ")}`;

      const current = yield* runScripted({ [command]: { exit: 0, stdout: "" } });
      expect(current.rows[0]?.status).toBe("ok");
      expect(current.recorded).toEqual([command]);
      expect(current.recorded.some((line) => line.includes("fetch"))).toBe(false);

      const sha = "3".repeat(40);
      const stale = yield* runScripted({ [command]: { exit: 0, stdout: `${sha}\n` } });
      expect(stale.rows[0]?.status).toBe("warn");
      expect(stale.rows[0]?.detail).toContain(sha);
      expect(stale.recorded).toEqual([command]);

      const unresolvable = yield* runScripted({ [command]: { exit: 128, stderr: "bad revision" } });
      expect(unresolvable.rows[0]?.status).toBe("warn");
      expect(unresolvable.rows[0]?.detail).toContain("git fetch");
      expect(unresolvable.recorded).toEqual([command]);
    }),
  );
});

// 18's ruling, guarded: the source set is a declaration, not a snapshot, so a
// tracked top-level entry that is neither in it nor in this explicitly
// declared not-source list fails the suite rather than silently dropping out
// of the freshness question's scope — the unsafe direction, because
// under-inclusion runs a stale dispatcher and says nothing (T49).
describe("the package's tracked top-level entries", () => {
  // Rooted (18 step 2), `packageRoot` is the repo root, so the repo's own
  // top-level entries are the package's and each one is declared here rather
  // than widening the freshness scope by nobody's decision:
  //
  //   `.github`       CI's declaration, not the dispatcher's source.
  //   `CONTEXT.md`    the glossary.
  //   `README.md`     the front door.
  //   `LICENSE`       the terms the repository is published under (T143).
  //   `docs`          the map and its tickets.
  //   `image`         the agent image's inputs — the image probe (T30) tracks those itself.
  //   `.bessemer`     the served repo's own directory: its config, and by default its runtime state (T57).
  //   `setup-hook.sh` the served repo's hook, read from the working tree (19 §7).
  const notSource = new Set([
    ".bessemer",
    ".github",
    ".gitignore",
    ".oxfmtrc.json",
    ".oxlintrc.json",
    "AGENTS.md",
    "CONTEXT.md",
    "docs",
    "image",
    "ISSUE_TEMPLATE.md",
    "LICENSE",
    "README.md",
    "setup-hook.sh",
    "tasks",
    "test",
    "vitest.config.ts",
    "vitest.live.config.ts",
  ]);

  it.effect("is either in the source set or declared not-source", () =>
    Effect.gen(function* () {
      // `packagePathspec(packageRoot)` renders bare entry names — the
      // package is its own repo root here — so the source set reads as the
      // list of top-level names directly, with nothing to strip off.
      const source = new Set(packagePathspec(packageRoot));
      const tracked = yield* exec("git", "-C", packageRoot, "ls-files");
      // Asserted, not assumed: a `ls-files` that errors prints nothing on
      // stdout, and an empty set has no undeclared entry in it — so without
      // this the guard passes loudest in exactly the case it exists to
      // close (under-inclusion).
      expect(tracked.exitCode).toBe(0);
      const topLevel = new Set(
        tracked.stdout
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line !== "")
          .map((line) => line.split("/")[0]!),
      );
      const undeclared = [...topLevel].filter(
        (entry) => !source.has(entry) && !notSource.has(entry),
      );
      expect(undeclared).toEqual([]);
    }).pipe(Effect.provide(NodeContext.layer)),
  );
});
