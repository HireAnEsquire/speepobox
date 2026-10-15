// `init` (T114): the scaffold written into a real temporary served repo from
// the package's own templates. Only the `Reporter` is a fake — it collects the
// events so the report is asserted as a value; the renderer is asserted as a
// pure function over the snapshot. `Git` is the live layer (T115): the base is
// read off a real `origin/HEAD` in a real repository.
import { basename, join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { FileSystem } from "@effect/platform";
import { SystemError } from "@effect/platform/Error";
import type { CommandExecutor } from "@effect/platform/CommandExecutor";
import { NodeContext } from "@effect/platform-node";
import { Cause, Effect, Either, Exit, Layer, Option, Ref } from "effect";
import { templatesRoot } from "../src/config/paths.ts";
import { renderFailure } from "../src/dispatch/render.ts";
import type { DispatcherRevision } from "../src/git/dispatcher-revision.ts";
import type { Release } from "../src/git/releases.ts";
import { type Git, GitLive } from "../src/git/git.ts";
import { exec } from "../src/internal/exec.ts";
import { INIT_USAGE, InitRefused, parseInitArgv } from "../src/init/argv.ts";
import { init } from "../src/init/init.ts";
import { NEXT_STEPS, renderInit } from "../src/init/render.ts";
import { pinIn } from "../src/pin/pin.ts";
import { driftOf } from "../src/init/diff.ts";
import type { InitDiff, InitSnapshot, InitValues, InitWrite } from "../src/init/snapshot.ts";
import {
  bodyDigest,
  readStamp,
  stamp,
  STAMPED_TEMPLATES,
  type StampedTemplate,
  TEMPLATE_VERSIONS,
} from "../src/init/stamp.ts";
import { imageNameFor } from "../src/init/values.ts";
import { Reporter, type ReporterEvent } from "../src/reporter.ts";
import { fakeGit, type GitCall } from "./support/git-fake.ts";

const ARGV = ["--base", "origin/main", "--image", "acme-speepobox"];

const SCAFFOLD = [
  ".speepobox/config.toml",
  ".speepobox/.gitignore",
  ".speepobox/image/Dockerfile",
  ".speepobox/image/inputs",
  ".speepobox/speepobox",
  ".speepobox/tasks/.gitkeep",
];

const SHA = "abc1234000000000000000000000000000000000";

const CLEAN: Option.Option<DispatcherRevision> = Option.some({
  sha: SHA,
  revision: "abc1234",
  dirty: false,
});

// The package's `HEAD` carrying a release, which is what every case not about
// the no-release warning (T124) runs against.
const RELEASED: Option.Option<ReadonlyArray<Release>> = Option.some([
  { tag: "v3", number: 3, commit: SHA },
]);

const run = (
  repoRoot: string,
  argv: ReadonlyArray<string>,
  options: {
    readonly selfHosted?: boolean;
    readonly dispatcherRevision?: Option.Option<DispatcherRevision>;
    readonly headReleases?: Option.Option<ReadonlyArray<Release>>;
    // The `Git` the run asks; the live layer unless a case is asserting
    // which reads were made.
    readonly git?: Layer.Layer<Git, never, FileSystem.FileSystem | CommandExecutor>;
  } = {},
) =>
  Effect.gen(function* () {
    const events = yield* Ref.make<ReadonlyArray<ReporterEvent>>([]);
    const exit = yield* init({
      repoRoot,
      argv,
      selfHosted: options.selfHosted ?? false,
      templatesRoot,
      dispatcherRevision: options.dispatcherRevision ?? CLEAN,
      headReleases: options.headReleases ?? RELEASED,
    }).pipe(
      Effect.provide(
        Layer.merge(
          Layer.succeed(Reporter, {
            emit: (event) => Ref.update(events, (current) => [...current, event]),
          }),
          options.git ?? GitLive,
        ),
      ),
      Effect.exit,
    );
    return { exit, events: yield* Ref.get(events) };
  });

const reported = (events: ReadonlyArray<ReporterEvent>): InitSnapshot => {
  const event = events.find((e) => e._tag === "InitReported");
  if (event?._tag !== "InitReported") {
    throw new Error("no InitReported event");
  }
  return event.snapshot;
};

// What a write reported: the snapshot's `Write` arm, whose values and
// warnings T115 added.
const written = (events: ReadonlyArray<ReporterEvent>): InitWrite => {
  const snapshot = reported(events);
  if (snapshot._tag !== "Write") {
    throw new Error("expected a Write snapshot");
  }
  return snapshot;
};

// Each file and what happened to it, without the values a written config
// carries.
const actions = (events: ReadonlyArray<ReporterEvent>) =>
  written(events).files.map(({ path, action }) => ({ path, action }));

// The values the written `config.toml` carries on its `wrote` line (T127):
// the only file that can carry any.
const valuesOf = (events: ReadonlyArray<ReporterEvent>): InitValues => {
  const config = written(events).files.find((file) => file.path === ".speepobox/config.toml");
  if (config?.action !== "wrote" || config.values === undefined) {
    throw new Error("config.toml was not written with values");
  }
  return config.values;
};

const refusalOf = (exit: Exit.Exit<number, InitRefused>): string =>
  Exit.match(exit, {
    onSuccess: () => {
      throw new Error("expected a refusal");
    },
    onFailure: (cause) => Option.getOrThrow(Cause.failureOption(cause)).detail,
  });

// A real served repo, named as an adopter's directory might be, whose
// `origin/HEAD` points where it is told to — or nowhere, which is what a clone
// that never ran `git remote set-head` has.
const servedRepo = (originHead: Option.Option<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const repoRoot = join(yield* fs.makeTempDirectoryScoped(), "My App");
    yield* exec("git", "init", "-q", repoRoot);
    if (Option.isSome(originHead)) {
      yield* exec(
        "git",
        "-C",
        repoRoot,
        "symbolic-ref",
        "refs/remotes/origin/HEAD",
        `refs/remotes/${originHead.value}`,
      );
    }
    return repoRoot;
  });

const configIn = (repoRoot: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) =>
    fs.readFileString(join(repoRoot, ".speepobox/config.toml")),
  );

// Every entry under the served repo, so "writes nothing" is a listing that
// stayed empty rather than a check of the five paths it would have written.
const listing = (repoRoot: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readDirectory(repoRoot, { recursive: true }));

const parseRefusal = (argv: ReadonlyArray<string>): string =>
  Either.getLeft(parseInitArgv(argv)).pipe(Option.getOrThrow).detail;

describe("parseInitArgv", () => {
  it("reads both flags", () => {
    expect(parseInitArgv(ARGV)).toEqual(
      Either.right({
        base: Option.some("origin/main"),
        image: Option.some("acme-speepobox"),
        diff: false,
        refresh: false,
      }),
    );
  });

  it("parses both flags as optional, so a missing one is the guard's to refuse", () => {
    expect(parseInitArgv([])).toEqual(
      Either.right({ base: Option.none(), image: Option.none(), diff: false, refresh: false }),
    );
  });

  it.each([["--force"], ["--dry-run"], ["extra"]])("refuses %s with the usage line", (word) => {
    const parsed = parseInitArgv([...ARGV, word]);
    expect(Either.isLeft(parsed)).toBe(true);
    const detail = Either.getLeft(parsed).pipe(Option.getOrThrow).detail;
    expect(detail).toBe(`unknown init flag: ${word} (usage: ${INIT_USAGE})`);
  });

  it("reads --diff as a bare word, and refuses it beside a flag that configures a write", () => {
    expect(parseInitArgv(["--diff"])).toEqual(
      Either.right({ base: Option.none(), image: Option.none(), diff: true, refresh: false }),
    );
    expect(Either.isLeft(parseInitArgv(["--diff", "--base", "x"]))).toBe(true);
    expect(Either.isLeft(parseInitArgv(["--image", "y", "--diff"]))).toBe(true);
    expect(Either.isLeft(parseInitArgv(["--diff", "--diff"]))).toBe(true);
  });

  it("reads --refresh as a bare word, beside --base and --image but never --diff (T145)", () => {
    expect(parseInitArgv(["--refresh", ...ARGV])).toEqual(
      Either.right({
        base: Option.some("origin/main"),
        image: Option.some("acme-speepobox"),
        diff: false,
        refresh: true,
      }),
    );
    expect(parseRefusal(["--refresh", "--diff"])).toContain("--refresh is a write");
    expect(parseRefusal(["--diff", "--refresh"])).toContain("--refresh is a write");
    expect(parseRefusal(["--refresh", "--refresh"])).toContain("--refresh given twice");
    expect(INIT_USAGE).toContain("[--refresh]");
  });

  it("refuses a flag with no value, and one given twice", () => {
    expect(Either.isLeft(parseInitArgv(["--base"]))).toBe(true);
    expect(Either.isLeft(parseInitArgv(["--base", "--image", "x"]))).toBe(true);
    expect(Either.isLeft(parseInitArgv(["--base", "a", "--base", "b"]))).toBe(true);
  });
});

describe("init", () => {
  it.scoped("writes all six files into an empty served repo, the shim 0755", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const repoRoot = yield* fs.makeTempDirectoryScoped();
      const { exit, events } = yield* run(repoRoot, ARGV);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(actions(events)).toEqual(SCAFFOLD.map((path) => ({ path, action: "wrote" })));

      const config = yield* fs.readFileString(join(repoRoot, ".speepobox/config.toml"));
      expect(config).not.toContain("{{");
      expect(config).toContain('base = "origin/main"');
      expect(config).toContain('image = "acme-speepobox"');
      expect(config).toContain(`tool-sha = "${SHA}"`);

      for (const name of STAMPED_TEMPLATES) {
        const text = yield* fs.readFileString(join(repoRoot, ".speepobox", name));
        const found = Option.getOrThrow(readStamp(text));
        expect(found.name).toBe(name);
        expect(found.digest).toBe(bodyDigest(text));
      }
      expect(yield* fs.readFileString(join(repoRoot, ".speepobox/tasks/.gitkeep"))).toBe("");
      // The shim is the one file that is executed (T127).
      const shim = yield* fs.stat(join(repoRoot, ".speepobox/speepobox"));
      expect(shim.mode & 0o777).toBe(0o755);
      expect(
        Option.getOrThrow(
          readStamp(yield* fs.readFileString(join(repoRoot, ".speepobox/speepobox"))),
        ),
      ).toMatchObject({ name: "speepobox", version: TEMPLATE_VERSIONS.speepobox });
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("run a second time, writes nothing and reports six kept lines", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const repoRoot = yield* fs.makeTempDirectoryScoped();
      yield* run(repoRoot, ARGV);
      const before = yield* Effect.forEach(SCAFFOLD, (path) =>
        fs.stat(join(repoRoot, path)).pipe(Effect.map((info) => info.mtime)),
      );
      const { exit, events } = yield* run(repoRoot, ARGV);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(actions(events)).toEqual(SCAFFOLD.map((path) => ({ path, action: "kept" })));
      const after = yield* Effect.forEach(SCAFFOLD, (path) =>
        fs.stat(join(repoRoot, path)).pipe(Effect.map((info) => info.mtime)),
      );
      expect(after).toEqual(before);
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("keeps an existing config.toml byte for byte and writes the other five", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const repoRoot = yield* fs.makeTempDirectoryScoped();
      const mine = 'image = "mine"\n# an adopter\'s own words, {{not a placeholder}}\n';
      yield* fs.makeDirectory(join(repoRoot, ".speepobox"));
      yield* fs.writeFileString(join(repoRoot, ".speepobox/config.toml"), mine);
      const { exit, events } = yield* run(repoRoot, ARGV);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(yield* fs.readFileString(join(repoRoot, ".speepobox/config.toml"))).toBe(mine);
      expect(actions(events)).toEqual(
        SCAFFOLD.map((path, index) => ({ path, action: index === 0 ? "kept" : "wrote" })),
      );
    }).pipe(Effect.provide(NodeContext.layer)),
  );
});

describe("init works out its values (T115)", () => {
  it.scoped(
    "reads the base off origin/HEAD, the image off the directory, the pin off the package",
    () =>
      Effect.gen(function* () {
        const repoRoot = yield* servedRepo(Option.some("origin/trunk"));
        const { exit, events } = yield* run(repoRoot, []);
        expect(Exit.isSuccess(exit)).toBe(true);

        const config = yield* configIn(repoRoot);
        expect(config).toContain('base = "origin/trunk"');
        expect(config).toContain('image = "my-app-speepobox"');
        expect(config).toContain(`tool-sha = "${SHA}"`);
        expect(valuesOf(events)).toEqual({
          base: { value: "origin/trunk", source: "origin/HEAD" },
          image: { value: "my-app-speepobox", source: "directory name" },
          "tool-sha": { value: SHA, source: "package revision" },
        });
        expect(written(events).warnings).toEqual([]);
      }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("lets --base and --image override what it would have worked out", () =>
    Effect.gen(function* () {
      const repoRoot = yield* servedRepo(Option.some("origin/trunk"));
      const { exit, events } = yield* run(repoRoot, ARGV);
      expect(Exit.isSuccess(exit)).toBe(true);

      const config = yield* configIn(repoRoot);
      expect(config).toContain('base = "origin/main"');
      expect(config).toContain('image = "acme-speepobox"');
      expect(valuesOf(events).base).toEqual({ value: "origin/main", source: "flag" });
      expect(valuesOf(events).image).toEqual({ value: "acme-speepobox", source: "flag" });
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped(
    "refuses with origin/HEAD unset and no --base, naming both remedies, and writes nothing",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const repoRoot = yield* servedRepo(Option.none());
        const { exit, events } = yield* run(repoRoot, ["--image", "acme-speepobox"]);
        const detail = refusalOf(exit);
        expect(detail).toContain("--base");
        expect(detail).toContain("git remote set-head origin --auto");
        expect(detail.split("\n")).toHaveLength(1);
        expect(events).toEqual([]);
        expect(yield* fs.exists(join(repoRoot, ".speepobox"))).toBe(false);
      }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("needs no git at all when --base is given", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const repoRoot = yield* fs.makeTempDirectoryScoped();
      const { exit, events } = yield* run(repoRoot, ["--base", "origin/main"]);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(valuesOf(events).image).toEqual({
        value: imageNameFor(basename(repoRoot)),
        source: "directory name",
      });
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped.each([
    {
      name: "a dirty revision",
      revision: Option.some({
        sha: SHA,
        revision: "abc1234",
        dirty: true,
      }),
      why: "dirty at abc1234",
    },
    { name: "an unknown revision", revision: Option.none(), why: "could not be read" },
  ])("writes $name as an empty pin, with one warning saying why", ({ revision, why }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const repoRoot = yield* fs.makeTempDirectoryScoped();
      const { exit, events } = yield* run(repoRoot, ARGV, { dispatcherRevision: revision });
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(yield* configIn(repoRoot)).toContain('tool-sha = ""');
      expect(valuesOf(events)["tool-sha"]).toEqual({
        value: "",
        source: "package revision",
      });
      const warnings = written(events).warnings;
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("tool-sha is written empty");
      expect(warnings[0]).toContain(why);
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("writes a pin the pin grammar reads back as the running revision's full SHA", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const repoRoot = yield* fs.makeTempDirectoryScoped();
      const { exit } = yield* run(repoRoot, ARGV);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(pinIn(yield* configIn(repoRoot))).toEqual(Either.right(SHA));
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped.each([
    { name: "no tags on HEAD", releases: [] },
    {
      name: "a release on another commit",
      releases: [{ tag: "v2", number: 2, commit: "f".repeat(40) }],
    },
  ])(
    "with $name, writes the pin anyway and warns once, naming the short revision",
    ({ releases }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const repoRoot = yield* fs.makeTempDirectoryScoped();
        const { exit, events } = yield* run(repoRoot, ARGV, {
          headReleases: Option.some(releases),
        });
        expect(Exit.isSuccess(exit)).toBe(true);
        expect(actions(events)).toEqual(SCAFFOLD.map((path) => ({ path, action: "wrote" })));
        expect(pinIn(yield* configIn(repoRoot))).toEqual(Either.right(SHA));
        const warnings = written(events).warnings;
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain("abc1234");
        expect(warnings[0]).not.toContain(SHA);
        expect(warnings[0]).toContain("no v<N> tag points at it");
        expect(warnings[0]).toContain("`upgrade` moves a pin only between releases");
      }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("says nothing of releases when the tag read failed", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const repoRoot = yield* fs.makeTempDirectoryScoped();
      const { events } = yield* run(repoRoot, ARGV, { headReleases: Option.none() });
      expect(written(events).warnings).toEqual([]);
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("warns only that the pin is empty when a dirty revision carries no release", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const repoRoot = yield* fs.makeTempDirectoryScoped();
      const { events } = yield* run(repoRoot, ARGV, {
        dispatcherRevision: Option.some({ sha: SHA, revision: "abc1234", dirty: true }),
        headReleases: Option.some([]),
      });
      const warnings = written(events).warnings;
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("tool-sha is written empty");
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  // A kept config asks nothing (E4, T127): the base it would not write is
  // never worked out, so a repo with no origin/HEAD is not refused one.
  it.scoped("with config.toml present, asks no base and refuses nothing without origin/HEAD", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const repoRoot = yield* fs.makeTempDirectoryScoped();
      yield* fs.makeDirectory(join(repoRoot, ".speepobox"));
      yield* fs.writeFileString(join(repoRoot, ".speepobox/config.toml"), 'image = "mine"\n');
      const calls = yield* Ref.make<ReadonlyArray<GitCall>>([]);
      const { exit, events } = yield* run(repoRoot, [], { git: fakeGit(calls) });
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(yield* Ref.get(calls)).toEqual([]);
      const files = written(events).files;
      expect(files[0]).toEqual({ path: ".speepobox/config.toml", action: "kept" });
      expect(files.slice(1).every((file) => file.action === "wrote")).toBe(true);
      expect(files).toContainEqual({ path: ".speepobox/speepobox", action: "wrote" });
      expect(renderInit(written(events)).split("\n")[0]).toBe("kept  .speepobox/config.toml");
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("says nothing of the pin when config.toml was kept", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const repoRoot = yield* fs.makeTempDirectoryScoped();
      yield* run(repoRoot, ARGV);
      const { events } = yield* run(repoRoot, ARGV, { dispatcherRevision: Option.none() });
      expect(written(events).warnings).toEqual([]);
    }).pipe(Effect.provide(NodeContext.layer)),
  );
});

describe("init, refused", () => {
  it.scoped("refuses a self-hosted repo, and writes nothing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const repoRoot = yield* fs.makeTempDirectoryScoped();
      const { exit } = yield* run(repoRoot, ARGV, { selfHosted: true });
      expect(Exit.isFailure(exit)).toBe(true);
      expect(refusalOf(exit)).toContain("not scaffolded");
      expect(yield* listing(repoRoot)).toEqual([]);
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped.each(["--force", "--dry-run", "--bogus"])(
    "refuses %s with the usage line, and writes nothing",
    (word) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const repoRoot = yield* fs.makeTempDirectoryScoped();
        const { exit } = yield* run(repoRoot, [...ARGV, word]);
        expect(exit).toEqual(
          Exit.fail(
            new InitRefused({ detail: `unknown init flag: ${word} (usage: ${INIT_USAGE})` }),
          ),
        );
        expect(yield* listing(repoRoot)).toEqual([]);
      }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("refuses a directory standing where a file goes, naming it, and writes nothing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const repoRoot = yield* fs.makeTempDirectoryScoped();
      yield* fs.makeDirectory(join(repoRoot, ".speepobox/image/inputs"), { recursive: true });
      const { exit } = yield* run(repoRoot, ARGV);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(refusalOf(exit)).toContain(".speepobox/image/inputs is a directory");
      expect(yield* fs.exists(join(repoRoot, ".speepobox/config.toml"))).toBe(false);
    }).pipe(Effect.provide(NodeContext.layer)),
  );
});

const VALUES = {
  base: { value: "origin/trunk", source: "origin/HEAD" },
  image: { value: "my-app-speepobox", source: "directory name" },
  "tool-sha": { value: "", source: "package revision" },
} as const;

describe("renderInit", () => {
  it("prints one line per file, then the next steps", () => {
    const text = renderInit({
      _tag: "Write",
      files: [
        { path: ".speepobox/config.toml", action: "kept" },
        { path: ".speepobox/.gitignore", action: "wrote" },
      ],
      warnings: [],
    });
    expect(text.split("\n")).toEqual([
      "kept  .speepobox/config.toml",
      "wrote  .speepobox/.gitignore",
      "",
      "Next steps:",
      ...NEXT_STEPS.map((step, index) => `  ${index + 1}. ${step}`),
    ]);
    expect(NEXT_STEPS).toHaveLength(5);
  });

  // An adopter reads the values before committing them (T115), so a written
  // config.toml names each one and where it came from.
  it("names each written value and its source, and prints the warning", () => {
    const text = renderInit({
      _tag: "Write",
      files: [
        {
          path: ".speepobox/config.toml",
          action: "wrote",
          values: { ...VALUES, image: { value: "acme-speepobox", source: "flag" } },
        },
      ],
      warnings: ["tool-sha is written empty: why"],
    });
    expect(text.split("\n").slice(0, 3)).toEqual([
      'wrote  .speepobox/config.toml  base = "origin/trunk" (origin/HEAD), image = "acme-speepobox" (flag), tool-sha = "" (package revision)',
      "WARN  tool-sha is written empty: why",
      "",
    ]);
  });

  // The pin is what the adopter commits, so it is shown whole (T124).
  it("shows the full 40-hex pin it wrote", () => {
    const text = renderInit({
      _tag: "Write",
      files: [
        {
          path: ".speepobox/config.toml",
          action: "wrote",
          values: { ...VALUES, "tool-sha": { value: SHA, source: "package revision" } },
        },
      ],
      warnings: [],
    });
    expect(text.split("\n")[0]).toContain(`tool-sha = "${SHA}" (package revision)`);
  });
});

describe("the refusal", () => {
  it("is one line through the renderer every other refusal uses", () => {
    expect(renderFailure(new InitRefused({ detail: "init needs --base" }))).toEqual(
      Option.some("!! init needs --base"),
    );
  });
});

// `init --diff` (T116), against a real temporary served repo scaffolded by
// `init` itself. Every run compares the whole tree — listing and contents —
// before and after, so "read-only" is asserted rather than assumed.
const tree = (repoRoot: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const entries = (yield* listing(repoRoot)).toSorted();
    return yield* Effect.forEach(entries, (entry) =>
      fs
        .stat(join(repoRoot, entry))
        .pipe(
          Effect.flatMap((info) =>
            info.type === "File"
              ? Effect.map(fs.readFileString(join(repoRoot, entry)), (text) => [entry, text])
              : Effect.succeed([entry, info.type]),
          ),
        ),
    );
  });

// Runs `--diff`, asserting it changed nothing under the served repo, and
// answers with its drift count and snapshot.
const diff = (repoRoot: string, selfHosted = false) =>
  Effect.gen(function* () {
    const before = yield* tree(repoRoot);
    const { exit, events } = yield* run(repoRoot, ["--diff"], { selfHosted });
    expect(yield* tree(repoRoot)).toEqual(before);
    const drifted = Exit.match(exit, {
      onSuccess: (count) => count,
      onFailure: (cause) => {
        throw new Error(`--diff failed: ${Cause.pretty(cause)}`);
      },
    });
    const snapshot = reported(events);
    if (snapshot._tag !== "Diff") {
      throw new Error("expected a Diff snapshot");
    }
    return { drifted, snapshot, text: renderInit(snapshot) };
  });

const scaffolded = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const repoRoot = yield* fs.makeTempDirectoryScoped();
  yield* run(repoRoot, ARGV);
  return repoRoot;
});

const standing = (snapshot: InitDiff) =>
  snapshot.files.map((file) =>
    file._tag === "Presence"
      ? [file.path, file.present ? "present" : "missing"]
      : [file.path, file.state, file.edited ? "edited" : "pristine"],
  );

// A stamped file as init would have written it from an older template: a
// pristine stamp one version below, over a body the current template has
// since changed.
const olderTemplate = (repoRoot: string, name: StampedTemplate) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const current = yield* fs.readFileString(join(templatesRoot, name));
    const older = current.replace(/\n$/, "\n# a line the newer template dropped\n");
    yield* fs.writeFileString(
      join(repoRoot, ".speepobox", name),
      stamp(name, TEMPLATE_VERSIONS[name] - 1, older),
    );
  });

// The templates before v4 were written under the tool's name from T63 to T144,
// so a text one of them shipped is recovered from the current template with
// the name put back.
const RETIRED_NAME = "bessemer";
const underRetiredName = (text: string) => text.replaceAll("speepobox", RETIRED_NAME);

// The v2 Dockerfile template, recovered from v4 by putting back the old name
// (T144) and the "No sudo" sentence T136 turned into the commented-out root
// block.
const dockerfileV2 = (v4: string) => {
  const v3 = underRetiredName(v4);
  const v2 = v3
    .replace(
      "# certificates, because the agent CLI's installer below needs them.\n",
      "# certificates, because the agent CLI's installer below needs them. No sudo:\n" +
        "# the container runs under `--cap-drop ALL`, and a step that needs root earns\n" +
        "# a `cap-add` entry in config.toml alongside the package that needs it.\n",
    )
    .replace(/\n# Setup that needs root,[^]*?chmod 0440 \/etc\/sudoers\.d\/agent\n/, "");
  expect(v2).not.toBe(v3);
  return v2;
};

describe("init --diff", () => {
  it.scoped("reports a fresh scaffold current and pristine, config present, and exits 0", () =>
    Effect.gen(function* () {
      const repoRoot = yield* scaffolded;
      const { drifted, snapshot, text } = yield* diff(repoRoot);
      expect(drifted).toBe(0);
      expect(standing(snapshot)).toEqual([
        [".speepobox/config.toml", "present"],
        [".speepobox/.gitignore", "current", "pristine"],
        [".speepobox/image/Dockerfile", "current", "pristine"],
        [".speepobox/image/inputs", "current", "pristine"],
        [".speepobox/speepobox", "current", "pristine"],
      ]);
      expect(text).toContain("No drift.");
      expect(text).not.toContain("tasks");
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("reports an edited Dockerfile current and edited, and exits 0", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const repoRoot = yield* scaffolded;
      const dockerfile = join(repoRoot, ".speepobox/image/Dockerfile");
      const text = yield* fs.readFileString(dockerfile);
      yield* fs.writeFileString(dockerfile, `${text}RUN echo mine\n`);
      const { drifted, snapshot } = yield* diff(repoRoot);
      expect(drifted).toBe(0);
      expect(standing(snapshot)[2]).toEqual([".speepobox/image/Dockerfile", "current", "edited"]);
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("reports a file stamped below its template behind, with the diff and the refresh", () =>
    Effect.gen(function* () {
      const repoRoot = yield* scaffolded;
      yield* olderTemplate(repoRoot, "image/inputs");
      const { drifted, snapshot, text } = yield* diff(repoRoot);
      expect(drifted).toBe(1);
      expect(standing(snapshot)[3]).toEqual([".speepobox/image/inputs", "behind", "pristine"]);
      expect(text).toContain("includes your own edits");
      expect(text).toContain("-# a line the newer template dropped");
      expect(text).toContain("+++ templates/image/inputs v2");
      expect(text).toContain("To refresh it: .speepobox/speepobox init --refresh");
      expect(text).not.toContain("rm .speepobox/image/inputs");
      expect(text).toContain("nothing of yours is lost");
      expect(text).toContain("Drift: 1 file missing or behind.");
      expect(text.split("\n").at(-1)).toBe(
        "init --refresh takes the 1 pristine file above in one step.",
      );
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("says nothing is lost only of a pristine behind file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const repoRoot = yield* scaffolded;
      yield* olderTemplate(repoRoot, "image/inputs");
      const inputs = join(repoRoot, ".speepobox/image/inputs");
      yield* fs.writeFileString(inputs, `${yield* fs.readFileString(inputs)}package.json\n`);
      const { drifted, snapshot, text } = yield* diff(repoRoot);
      expect(drifted).toBe(1);
      expect(standing(snapshot)[3]).toEqual([".speepobox/image/inputs", "behind", "edited"]);
      expect(text).toContain("-package.json");
      expect(text).not.toContain("nothing of yours is lost");
      // An edited file is taken by hand, and the line before the remedy says
      // what that costs (T145).
      expect(text).toContain(
        "This file has your edits: merge the diff above by hand, or take the template and lose them with:\n" +
          "To refresh it: rm .speepobox/image/inputs && .speepobox/speepobox init",
      );
      expect(text).not.toContain("init --refresh");
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  // The upgrade an adopter scaffolded before T136 sees: the v2 Dockerfile is
  // the v3 template with its "No sudo" sentence where the commented-out root
  // block is now, and the digest pins that it is the text v2 actually shipped.
  it.scoped("reports a v2 Dockerfile behind the v4 template, showing the root block", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const repoRoot = yield* scaffolded;
      const v2 = dockerfileV2(yield* fs.readFileString(join(templatesRoot, "image/Dockerfile")));
      expect(bodyDigest(v2)).toBe("e1efef7d16c5");
      yield* fs.writeFileString(
        join(repoRoot, ".speepobox/image/Dockerfile"),
        stamp("image/Dockerfile", 2, v2),
      );
      const { drifted, snapshot, text } = yield* diff(repoRoot);
      expect(drifted).toBe(1);
      expect(standing(snapshot)[2]).toEqual([".speepobox/image/Dockerfile", "behind", "pristine"]);
      expect(text).toContain("+++ templates/image/Dockerfile v4");
      expect(text).toContain(
        "-# certificates, because the agent CLI's installer below needs them. No sudo:",
      );
      expect(text).toContain(
        '+# section "Setup that needs root" in speepobox\'s README walks through it. To',
      );
      expect(text).toContain("+# COPY root-setup.sh /usr/local/libexec/speepobox/root-setup.sh");
      expect(text).toContain("nothing of yours is lost");
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  // The upgrade an adopter scaffolded before T118 sees: the v1 Dockerfile is
  // the v2 template without its model block, and the digest pins that it is
  // the text v1 actually shipped.
  it.scoped("reports a v1 Dockerfile behind the v4 template, showing the model lines", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const repoRoot = yield* scaffolded;
      const v2 = dockerfileV2(yield* fs.readFileString(join(templatesRoot, "image/Dockerfile")));
      const v1 = v2.replace(
        /\n# The model the agent passes run on\.[^]*?# ENV ANTHROPIC_MODEL=.*\n/,
        "",
      );
      expect(v1).not.toBe(v2);
      expect(bodyDigest(v1)).toBe("b0faff370f7d");
      yield* fs.writeFileString(
        join(repoRoot, ".speepobox/image/Dockerfile"),
        stamp("image/Dockerfile", 1, v1),
      );
      const { drifted, snapshot, text } = yield* diff(repoRoot);
      expect(drifted).toBe(1);
      expect(standing(snapshot)[2]).toEqual([".speepobox/image/Dockerfile", "behind", "pristine"]);
      expect(text).toContain("+++ templates/image/Dockerfile v4");
      expect(text).toContain("+# ENV ANTHROPIC_MODEL=<model id>");
      expect(text).toContain("nothing of yours is lost");
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  // The upgrade an adopter scaffolded before T119 sees: the v1 .gitignore is
  // the v2 template with its runtime state unanchored, and the digest pins
  // that it is the text v1 actually shipped.
  it.scoped("reports a v1 .gitignore behind the v3 template, showing the anchors", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const repoRoot = yield* scaffolded;
      const v2 = underRetiredName(yield* fs.readFileString(join(templatesRoot, ".gitignore")));
      const v1 = v2
        .replace(/^\/(config\.local\.toml|logs\/|locks\/|checkouts\/|runs\.jsonl)$/gm, "$1")
        .replace(/^# The agent credential;.*$/m, "# The agent credential.");
      expect(v1).not.toBe(v2);
      expect(bodyDigest(v1)).toBe("e5a02c8cfb04");
      yield* fs.writeFileString(
        join(repoRoot, ".speepobox/.gitignore"),
        stamp(".gitignore", 1, v1),
      );
      const { drifted, snapshot, text } = yield* diff(repoRoot);
      expect(drifted).toBe(1);
      expect(standing(snapshot)[1]).toEqual([".speepobox/.gitignore", "behind", "pristine"]);
      expect(text).toContain("+++ templates/.gitignore v3");
      expect(text).toContain("+/logs/");
      expect(text).toContain("-logs/");
      expect(text).toContain("nothing of yours is lost");
      expect(text).toContain("To refresh it: .speepobox/speepobox init --refresh");
      expect(text).not.toContain("rm .speepobox/.gitignore");
      expect(text).not.toContain(".old");
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  // A lost bit is the adopter's change, not drift — but the shim cannot run
  // (T127).
  it.scoped("reports a shim without its execute bit not executable, not behind, and exits 1", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const repoRoot = yield* scaffolded;
      yield* fs.chmod(join(repoRoot, ".speepobox/speepobox"), 0o644);
      const { drifted, snapshot, text } = yield* diff(repoRoot);
      expect(drifted).toBe(1);
      expect(standing(snapshot)[4]).toEqual([".speepobox/speepobox", "current", "pristine"]);
      expect(text).toMatch(/^current, pristine, not executable +\.speepobox\/speepobox$/m);
      expect(text).toContain("To fix it: chmod +x .speepobox/speepobox");
      expect(text).toContain("No drift.");
      expect(text).toContain("Not executable: .speepobox/speepobox.");
      expect(text).not.toContain("is behind");
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("asks no other file for its execute bit", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const repoRoot = yield* scaffolded;
      yield* fs.chmod(join(repoRoot, ".speepobox/.gitignore"), 0o644);
      const { drifted, text } = yield* diff(repoRoot);
      expect(drifted).toBe(0);
      expect(text).not.toContain("not executable");
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  // A pristine shim is renamed over in place (T145).
  it.scoped("refreshes a behind, pristine shim with init --refresh", () =>
    Effect.gen(function* () {
      const repoRoot = yield* scaffolded;
      yield* olderTemplate(repoRoot, "speepobox");
      const { drifted, snapshot, text } = yield* diff(repoRoot);
      expect(drifted).toBe(1);
      expect(standing(snapshot)[4]).toEqual([".speepobox/speepobox", "behind", "pristine"]);
      expect(text).toContain("To refresh it: .speepobox/speepobox init --refresh");
      expect(text).not.toContain(".old");
      expect(text).toContain("init --refresh takes the 1 pristine file above in one step.");
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  // Deleting the shim deletes the command that runs init (09, amended).
  it.scoped("refreshes a behind, edited shim by moving it aside, with the restore line", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const repoRoot = yield* scaffolded;
      yield* olderTemplate(repoRoot, "speepobox");
      const shim = join(repoRoot, ".speepobox/speepobox");
      yield* fs.writeFileString(shim, `${yield* fs.readFileString(shim)}# mine\n`);
      const { drifted, snapshot, text } = yield* diff(repoRoot);
      expect(drifted).toBe(1);
      expect(standing(snapshot)[4]).toEqual([".speepobox/speepobox", "behind", "edited"]);
      expect(text).toContain("This file has your edits");
      expect(text).not.toContain("init --refresh");
      expect(text).toContain(
        "To refresh it: mv .speepobox/speepobox .speepobox/speepobox.old && .speepobox/speepobox.old init && rm .speepobox/speepobox.old",
      );
      expect(text).toContain("mv .speepobox/speepobox.old .speepobox/speepobox");
      expect(text).toContain("hand clone");
      expect(text).not.toContain("rm .speepobox/speepobox &&");
      expect(text).not.toContain("not executable");
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("reports a deleted .gitignore missing, and exits 1", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const repoRoot = yield* scaffolded;
      yield* fs.remove(join(repoRoot, ".speepobox/.gitignore"));
      const { drifted, snapshot, text } = yield* diff(repoRoot);
      expect(drifted).toBe(1);
      expect(standing(snapshot)[1]).toEqual([".speepobox/.gitignore", "missing", "pristine"]);
      expect(text).toMatch(/^missing +\.speepobox\/\.gitignore  \(init would write it\)$/m);
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("reports a file whose stamp line was removed behind and edited, and exits 1", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const repoRoot = yield* scaffolded;
      const gitignore = join(repoRoot, ".speepobox/.gitignore");
      const text = yield* fs.readFileString(gitignore);
      yield* fs.writeFileString(
        gitignore,
        text
          .split("\n")
          .filter((line) => !line.startsWith("# speepobox-template:"))
          .join("\n"),
      );
      const { drifted, snapshot, text: rendered } = yield* diff(repoRoot);
      expect(drifted).toBe(1);
      expect(standing(snapshot)[1]).toEqual([".speepobox/.gitignore", "behind", "edited"]);
      expect(rendered).toContain("no stamp, read as v0");
      expect(rendered).toContain("+# speepobox-template: .gitignore v3");
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("reports a stamp copied from another template behind and edited, naming both", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const repoRoot = yield* scaffolded;
      yield* fs.copyFile(
        join(repoRoot, ".speepobox/.gitignore"),
        join(repoRoot, ".speepobox/image/inputs"),
      );
      const { drifted, snapshot, text } = yield* diff(repoRoot);
      expect(drifted).toBe(1);
      expect(standing(snapshot)[3]).toEqual([".speepobox/image/inputs", "behind", "edited"]);
      expect(text).toContain("its stamp names template .gitignore, not image/inputs");
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("reports a missing config.toml, and exits 1", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const repoRoot = yield* scaffolded;
      yield* fs.remove(join(repoRoot, ".speepobox/config.toml"));
      const { drifted, snapshot } = yield* diff(repoRoot);
      expect(drifted).toBe(1);
      expect(standing(snapshot)[0]).toEqual([".speepobox/config.toml", "missing"]);
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("reports every file missing in an empty repo, and writes nothing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const repoRoot = yield* fs.makeTempDirectoryScoped();
      const { drifted } = yield* diff(repoRoot);
      expect(drifted).toBe(5);
      expect(yield* listing(repoRoot)).toEqual([]);
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("runs self-hosted, naming the template instead of rm … && speepobox init", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const repoRoot = yield* scaffolded;
      yield* olderTemplate(repoRoot, "image/Dockerfile");
      yield* fs.remove(join(repoRoot, ".speepobox/.gitignore"));
      const { drifted, text } = yield* diff(repoRoot, true);
      expect(drifted).toBe(2);
      expect(text).not.toContain("speepobox init");
      expect(text).not.toContain("init would write it");
      expect(text).toMatch(
        /^missing +\.speepobox\/\.gitignore  \(absent; init does not write here\)$/m,
      );
      expect(text).toContain(
        `bring it up to date by hand from ${join(templatesRoot, "image/Dockerfile")}`,
      );
      // Self-hosted `init` itself still refuses.
      const { exit } = yield* run(yield* fs.makeTempDirectoryScoped(), ARGV, { selfHosted: true });
      expect(refusalOf(exit)).toContain("not scaffolded");
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("runs self-hosted with no shim, listing it by design and exiting 0", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const repoRoot = yield* scaffolded;
      yield* fs.remove(join(repoRoot, ".speepobox/speepobox"));
      const { drifted, text } = yield* diff(repoRoot, true);
      expect(drifted).toBe(0);
      expect(text).toMatch(
        /^missing +\.speepobox\/speepobox  \(absent; this repo has no shim by design\)$/m,
      );
      expect(text).toContain("No drift.");
      // In a served repo the same absence still counts.
      expect((yield* diff(repoRoot)).drifted).toBe(1);
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped.each([{ argv: ["--diff", "--base", "x"] }, { argv: ["--image", "y", "--diff"] }])(
    "refuses $argv, and writes nothing",
    ({ argv }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const repoRoot = yield* fs.makeTempDirectoryScoped();
        const { exit, events } = yield* run(repoRoot, argv);
        expect(refusalOf(exit)).toContain("--diff writes nothing");
        expect(events).toEqual([]);
        expect(yield* listing(repoRoot)).toEqual([]);
      }).pipe(Effect.provide(NodeContext.layer)),
  );
});

// `init --refresh` (T145): `init`, plus every stamped file that is behind and
// pristine overwritten with the current template, by `diff.ts`'s own sorting.
const scaffoldPath = (repoRoot: string, name: string) => join(repoRoot, ".speepobox", name);

// Every scaffold file's text, by its path under the speepobox directory.
const texts = (repoRoot: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return Object.fromEntries(
      yield* Effect.forEach(SCAFFOLD, (path) =>
        Effect.map(fs.readFileString(join(repoRoot, path)), (text) => [path, text] as const),
      ),
    );
  });

const templateText = (name: StampedTemplate) =>
  Effect.map(
    Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(join(templatesRoot, name))),
    (text) => stamp(name, TEMPLATE_VERSIONS[name], text),
  );

describe("init --refresh", () => {
  it.scoped(
    "overwrites a behind, pristine file, and keeps edited, unstamped, current, and config files",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const repoRoot = yield* scaffolded;
        yield* olderTemplate(repoRoot, ".gitignore");
        // Behind and edited.
        yield* olderTemplate(repoRoot, "image/inputs");
        const inputs = scaffoldPath(repoRoot, "image/inputs");
        yield* fs.writeFileString(inputs, `${yield* fs.readFileString(inputs)}package.json\n`);
        // Unstamped, which reads as behind and edited.
        const dockerfile = scaffoldPath(repoRoot, "image/Dockerfile");
        yield* fs.writeFileString(
          dockerfile,
          (yield* fs.readFileString(dockerfile))
            .split("\n")
            .filter((line) => !line.startsWith("# speepobox-template:"))
            .join("\n"),
        );
        const before = yield* texts(repoRoot);

        const { exit, events } = yield* run(repoRoot, ["--refresh"]);
        expect(Exit.isSuccess(exit)).toBe(true);
        expect(written(events).files).toEqual([
          { path: ".speepobox/config.toml", action: "kept" },
          {
            path: ".speepobox/.gitignore",
            action: "refreshed",
            from: TEMPLATE_VERSIONS[".gitignore"] - 1,
            to: TEMPLATE_VERSIONS[".gitignore"],
          },
          { path: ".speepobox/image/Dockerfile", action: "kept", behindEdited: true },
          { path: ".speepobox/image/inputs", action: "kept", behindEdited: true },
          { path: ".speepobox/speepobox", action: "kept" },
          { path: ".speepobox/tasks/.gitkeep", action: "kept" },
        ]);

        const after = yield* texts(repoRoot);
        expect(after[".speepobox/.gitignore"]).toBe(yield* templateText(".gitignore"));
        expect({ ...after, ".speepobox/.gitignore": "" }).toEqual({
          ...before,
          ".speepobox/.gitignore": "",
        });
        expect(yield* fs.readDirectory(join(repoRoot, ".speepobox"))).not.toContainEqual(
          expect.stringContaining(".refresh"),
        );

        const lines = renderInit(written(events)).split("\n");
        expect(lines.slice(0, 4)).toEqual([
          "kept  .speepobox/config.toml",
          `refreshed  .speepobox/.gitignore  (v${TEMPLATE_VERSIONS[".gitignore"] - 1} → v${TEMPLATE_VERSIONS[".gitignore"]})`,
          "kept  .speepobox/image/Dockerfile  (behind, edited — see init --diff)",
          "kept  .speepobox/image/inputs  (behind, edited — see init --diff)",
        ]);
      }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("refreshes a behind, pristine shim in place, mode 0755", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const repoRoot = yield* scaffolded;
      yield* olderTemplate(repoRoot, "speepobox");
      yield* fs.chmod(scaffoldPath(repoRoot, "speepobox"), 0o700);
      const { exit, events } = yield* run(repoRoot, ["--refresh"]);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(actions(events)[4]).toEqual({ path: ".speepobox/speepobox", action: "refreshed" });
      expect(yield* fs.readFileString(scaffoldPath(repoRoot, "speepobox"))).toBe(
        yield* templateText("speepobox"),
      );
      expect((yield* fs.stat(scaffoldPath(repoRoot, "speepobox"))).mode & 0o777).toBe(0o755);
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("still writes absent files, as plain init does", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const repoRoot = yield* scaffolded;
      yield* fs.remove(scaffoldPath(repoRoot, ".gitignore"));
      yield* fs.remove(scaffoldPath(repoRoot, "tasks/.gitkeep"));
      const { exit, events } = yield* run(repoRoot, ["--refresh"]);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(actions(events)).toEqual([
        { path: ".speepobox/config.toml", action: "kept" },
        { path: ".speepobox/.gitignore", action: "wrote" },
        { path: ".speepobox/image/Dockerfile", action: "kept" },
        { path: ".speepobox/image/inputs", action: "kept" },
        { path: ".speepobox/speepobox", action: "kept" },
        { path: ".speepobox/tasks/.gitkeep", action: "wrote" },
      ]);
      expect(yield* fs.readFileString(scaffoldPath(repoRoot, ".gitignore"))).toBe(
        yield* templateText(".gitignore"),
      );
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("writes every absent file, config.toml included, into an empty repo", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const repoRoot = yield* fs.makeTempDirectoryScoped();
      const { exit, events } = yield* run(repoRoot, ["--refresh", ...ARGV]);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(actions(events)).toEqual(SCAFFOLD.map((path) => ({ path, action: "wrote" })));
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped(
    "leaves a file whose rename fails whole, refusing with what was already refreshed",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const repoRoot = yield* scaffolded;
        yield* olderTemplate(repoRoot, ".gitignore");
        yield* olderTemplate(repoRoot, "image/inputs");
        const old = yield* fs.readFileString(scaffoldPath(repoRoot, "image/inputs"));
        const failing: FileSystem.FileSystem = {
          ...fs,
          rename: (from, to) =>
            to === scaffoldPath(repoRoot, "image/inputs")
              ? Effect.fail(
                  new SystemError({
                    reason: "PermissionDenied",
                    module: "FileSystem",
                    method: "rename",
                    pathOrDescriptor: to,
                    description: "rename refused",
                  }),
                )
              : fs.rename(from, to),
        };
        const { exit, events } = yield* run(repoRoot, ["--refresh"]).pipe(
          Effect.provideService(FileSystem.FileSystem, failing),
        );
        const detail = refusalOf(exit);
        expect(detail).toContain("init could not refresh .speepobox/image/inputs");
        expect(detail).toContain("already refreshed: .speepobox/.gitignore");
        expect(events).toEqual([]);
        expect(yield* fs.readFileString(scaffoldPath(repoRoot, "image/inputs"))).toBe(old);
        expect(yield* fs.readFileString(scaffoldPath(repoRoot, ".gitignore"))).toBe(
          yield* templateText(".gitignore"),
        );
        expect(yield* fs.readDirectory(join(repoRoot, ".speepobox/image"))).toEqual(
          expect.not.arrayContaining([expect.stringContaining(".refresh")]),
        );
      }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped.each([
    { argv: ["--refresh", "--diff"], refusal: "--refresh is a write" },
    { argv: ["--refresh", "--refresh"], refusal: "--refresh given twice" },
  ])("refuses $argv, and writes nothing", ({ argv, refusal }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const repoRoot = yield* fs.makeTempDirectoryScoped();
      const { exit, events } = yield* run(repoRoot, argv);
      expect(refusalOf(exit)).toContain(refusal);
      expect(events).toEqual([]);
      expect(yield* listing(repoRoot)).toEqual([]);
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("refuses a self-hosted repo, and writes nothing", () =>
    Effect.gen(function* () {
      const repoRoot = yield* scaffolded;
      yield* olderTemplate(repoRoot, ".gitignore");
      const before = yield* tree(repoRoot);
      const { exit, events } = yield* run(repoRoot, ["--refresh"], { selfHosted: true });
      expect(refusalOf(exit)).toContain("not scaffolded");
      expect(events).toEqual([]);
      expect(yield* tree(repoRoot)).toEqual(before);
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("leaves a repo whose files were all pristine with no drift", () =>
    Effect.gen(function* () {
      const repoRoot = yield* scaffolded;
      for (const name of STAMPED_TEMPLATES) {
        yield* olderTemplate(repoRoot, name);
      }
      const behind = yield* diff(repoRoot);
      expect(behind.drifted).toBe(STAMPED_TEMPLATES.length);
      expect(behind.text.split("\n").at(-1)).toBe(
        `init --refresh takes the ${STAMPED_TEMPLATES.length} pristine files above in one step.`,
      );
      const { exit } = yield* run(repoRoot, ["--refresh"]);
      expect(Exit.isSuccess(exit)).toBe(true);
      const { drifted, text } = yield* diff(repoRoot);
      expect(drifted).toBe(0);
      expect(text).toContain("No drift.");
      expect(text).not.toContain("init --refresh");
    }).pipe(Effect.provide(NodeContext.layer)),
  );
});

describe("driftOf", () => {
  it("names the template path it was handed", () => {
    const drift = driftOf({
      path: ".speepobox/image/inputs",
      template: "image/inputs",
      templatePath: "templates/image/inputs",
      templateText: "# new\n",
      text: Option.some(stamp("image/inputs", 0, "# old\n")),
      executable: Option.none(),
    });
    expect(drift.notExecutable).toBe(false);
    expect(drift.state).toBe("behind");
    expect(drift.edited).toBe(false);
    expect(drift.stampVersion).toBe(0);
    expect(drift.templatePath).toBe("templates/image/inputs");
    expect(drift.diff).toContain("-# old");
    expect(drift.diff).toContain("+# new");
  });
});
