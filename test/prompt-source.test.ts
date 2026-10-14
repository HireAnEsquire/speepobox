// `PromptSource` (T14, rerooted by T59): the precedence chain, what it names as
// the winner, and the three answers that are not "the text" — a missing
// override (the ordinary path), a selected file that cannot be used (a typed
// failure the run reports), and a package default that is not there at all (a
// defect).
//
// The real layer over a real filesystem, deliberately: the tag earns itself on
// the precedence logic, so a fake `FileSystem` here would leave the one thing
// under test asserted against our own fixture of it (05 Q9). A temp directory
// is the served repo, and dropping a file into its `.bessemer/prompts/` is
// what an adopter does.
import { describe, expect, it } from "@effect/vitest";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { FileSystem, Path } from "@effect/platform";
import { NodeContext, NodeFileSystem } from "@effect/platform-node";
import { Cause, Effect, Exit, Layer, Option } from "effect";
import {
  DESCRIBE_PR_PROMPT,
  IMPLEMENT_PROMPT,
  packagePromptPath,
  PROJECT_CONTEXT_PROMPT,
  promptPathIn,
  REVIEW_PROMPT,
} from "../src/agent/prompt.ts";
import {
  PromptSource,
  promptSourceLiveFor,
  PromptUnusable,
  promptRootLabel,
} from "../src/agent/prompt-source.ts";
import { BessemerConfig, defaultConfig } from "../src/config/config.ts";
import { bessemerDir, packageRoot } from "../src/config/paths.ts";

// A served repo, with whatever it chose to override in place. The layer takes
// the repo root and nothing else (T59): there is no config to build, because
// there is no longer anything in the chain a config could answer.
const clientAt = (
  repoRoot: string,
): Layer.Layer<PromptSource, never, FileSystem.FileSystem | Path.Path> =>
  promptSourceLiveFor(repoRoot);

const OVERRIDE = "# TASK\n\nThe served repo's own implement prompt.\n";

// Where an override goes: `<repoRoot>/.bessemer/prompts/<name>.md`, derived
// the way the chain derives it so a case cannot pin a path the code does not
// use.
const overridePath = (repoRoot: string, name: string): string =>
  promptPathIn(bessemerDir(repoRoot), name);

const writePrompt = (
  repoRoot: string,
  name: string,
  text: string,
): Effect.Effect<string, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = overridePath(repoRoot, name);
    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    yield* fs.writeFileString(file, text);
    return file;
  }).pipe(Effect.orDie);

// The real filesystem with one path answered from memory, which is how the
// self-hosted override below gets a file at `<packageRoot>/.bessemer/prompts/`
// without writing one there. That directory is the working tree of whatever
// repo this suite is running in, and a real write into it would sit beside —
// or on top of — an override an operator actually keeps. One method, one path,
// everything else the real thing: `checkout.test.ts`'s refusing `remove` is the
// same shape, and the precedence logic under test is untouched by it.
const holding = (file: string, text: string): Layer.Layer<FileSystem.FileSystem> =>
  Layer.effect(
    FileSystem.FileSystem,
    Effect.map(FileSystem.FileSystem, (fs) => ({
      ...fs,
      readFileString: (path: string, encoding?: string) =>
        path === file ? Effect.succeed(text) : fs.readFileString(path, encoding),
    })),
  ).pipe(Layer.provide(NodeFileSystem.layer));

// `holding`'s mirror, for the case that needs a path to be *absent*: the read
// of that one path is sent to a file inside an empty directory instead, so what
// the chain sees is the platform's own `NotFound` and not an error this test
// built. The absence is staged rather than asserted, because the path in
// question is `<packageRoot>/.bessemer/prompts/<name>.md` — the working tree
// this suite runs in. Asserting the file is not there would mean `npm run
// verify` goes red the moment this repo uses the feature T59 ships, and that
// gate runs inside every dispatch's clone, so the override an operator wrote
// would fail every later dispatch until someone moved it aside.
const absent = (file: string, nowhere: string): Layer.Layer<FileSystem.FileSystem> =>
  Layer.effect(
    FileSystem.FileSystem,
    Effect.map(FileSystem.FileSystem, (fs) => ({
      ...fs,
      readFileString: (path: string, encoding?: string) =>
        fs.readFileString(path === file ? nowhere : path, encoding),
    })),
  ).pipe(Layer.provide(NodeFileSystem.layer));

describe("the prompt precedence chain", () => {
  it.scoped("answers the package default, named as the root that won", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const repoRoot = yield* fs.makeTempDirectoryScoped();
      const resolved = yield* Effect.flatMap(PromptSource, (prompts) =>
        prompts.get(IMPLEMENT_PROMPT),
      ).pipe(Effect.provide(clientAt(repoRoot)));

      expect(resolved.root).toBe("package");
      expect(resolved.path).toBe(packagePromptPath(IMPLEMENT_PROMPT));
      expect(resolved.text).toBe(readFileSync(packagePromptPath(IMPLEMENT_PROMPT), "utf8"));
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  // The tracer, in one case: the override takes, and removing it hands the
  // default back. Both halves matter — an override nobody can retract is a
  // served repo stuck on a prompt that stopped improving.
  it.scoped("prefers a served repo's .bessemer/prompts/*.md, and gives it back", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const repoRoot = yield* fs.makeTempDirectoryScoped();
      const file = yield* writePrompt(repoRoot, IMPLEMENT_PROMPT, OVERRIDE);
      const source = Effect.flatMap(PromptSource, (prompts) => prompts.get(IMPLEMENT_PROMPT)).pipe(
        Effect.provide(clientAt(repoRoot)),
      );

      const overridden = yield* source;
      expect(overridden.root).toBe("client");
      expect(overridden.path).toBe(`${repoRoot}/.bessemer/prompts/${IMPLEMENT_PROMPT}.md`);
      expect(overridden.path).toBe(file);
      expect(overridden.text).toBe(OVERRIDE);

      yield* fs.remove(file);
      const restored = yield* source;
      expect(restored.root).toBe("package");
      expect(restored.text).toBe(readFileSync(packagePromptPath(IMPLEMENT_PROMPT), "utf8"));
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  // Whole-file replacement is the granularity: what the served repo wrote is
  // what the pass is handed, with nothing of the default surviving underneath
  // it.
  it.scoped("replaces the default outright rather than merging with it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const repoRoot = yield* fs.makeTempDirectoryScoped();
      yield* writePrompt(repoRoot, REVIEW_PROMPT, "# ROLE\n\nJust look at the tests.\n");
      const resolved = yield* Effect.flatMap(PromptSource, (prompts) =>
        prompts.get(REVIEW_PROMPT),
      ).pipe(Effect.provide(clientAt(repoRoot)));

      expect(resolved.text).toBe("# ROLE\n\nJust look at the tests.\n");
      expect(resolved.text).not.toContain("<verdict>");
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  // Each name is resolved on its own: overriding one prompt says nothing about
  // the other two.
  it.scoped("overrides one name without disturbing the others", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const repoRoot = yield* fs.makeTempDirectoryScoped();
      yield* writePrompt(repoRoot, IMPLEMENT_PROMPT, OVERRIDE);
      const roots = yield* Effect.flatMap(PromptSource, (prompts) =>
        Effect.all([
          prompts.get(IMPLEMENT_PROMPT),
          prompts.get(REVIEW_PROMPT),
          prompts.get(DESCRIBE_PR_PROMPT),
        ]),
      ).pipe(Effect.provide(clientAt(repoRoot)));

      expect(roots.map((resolved) => resolved.root)).toEqual(["client", "package", "package"]);
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  // **Self-hosted**, both ways round, and together they are why T59 could
  // delete the guard rather than move it. The guard existed for a client root
  // that *was* the package root, where every shipped default sat exactly where
  // an override would. `.bessemer/prompts/` is never `<packageRoot>/prompts/`,
  // so the shipped default is read as the package's with nothing comparing the
  // two roots — and a file at the served repo's own `.bessemer/prompts/` is
  // still an override when that repo is this package, which is the half a
  // guard on the roots would have refused to see.
  it.scoped("reads the package's own defaults as the package's when self-hosted", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const empty = yield* fs.makeTempDirectoryScoped();
      const file = overridePath(packageRoot, IMPLEMENT_PROMPT);
      const resolved = yield* Effect.flatMap(PromptSource, (prompts) =>
        prompts.get(IMPLEMENT_PROMPT),
      ).pipe(
        Effect.provide(
          clientAt(packageRoot).pipe(
            Layer.provide(absent(file, path.join(empty, `${IMPLEMENT_PROMPT}.md`))),
          ),
        ),
      );

      expect(resolved.root).toBe("package");
      expect(resolved.path).toBe(packagePromptPath(IMPLEMENT_PROMPT));
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  // The one `get` in this file whose read does not come off disk, and
  // `holding` says why.
  it.effect("still takes a self-hosted repo's own override", () =>
    Effect.gen(function* () {
      const file = overridePath(packageRoot, IMPLEMENT_PROMPT);
      const resolved = yield* Effect.flatMap(PromptSource, (prompts) =>
        prompts.get(IMPLEMENT_PROMPT),
      ).pipe(Effect.provide(clientAt(packageRoot).pipe(Layer.provide(holding(file, OVERRIDE)))));

      expect(resolved.root).toBe("client");
      expect(resolved.path).toBe(file);
      expect(resolved.text).toBe(OVERRIDE);
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  // Moving the runtime root moves writes only (`CONTEXT.md`): a prompt is a
  // read location, so a `runtime-root` naming somewhere else changes nothing
  // about which prompt wins — and the decoy sitting where the old chain looked
  // is what says so. The config layer is provided and goes unread, which is
  // the point: `PromptSource` no longer requires `BessemerConfig` at all.
  it.scoped("reads nothing from a runtime root pointed somewhere else", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const repoRoot = yield* fs.makeTempDirectoryScoped();
      const runtimeRoot = yield* fs.makeTempDirectoryScoped();
      const file = yield* writePrompt(repoRoot, IMPLEMENT_PROMPT, OVERRIDE);
      const decoy = promptPathIn(runtimeRoot, IMPLEMENT_PROMPT);
      yield* fs.makeDirectory(dirname(decoy), { recursive: true });
      yield* fs.writeFileString(decoy, "# TASK\n\nA prompt under the runtime root.\n");

      const resolved = yield* Effect.flatMap(PromptSource, (prompts) =>
        prompts.get(IMPLEMENT_PROMPT),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            clientAt(repoRoot),
            Layer.succeed(BessemerConfig, { ...defaultConfig, runtimeRoot }),
          ),
        ),
      );

      expect(resolved.root).toBe("client");
      expect(resolved.path).toBe(file);
      expect(resolved.text).toBe(OVERRIDE);
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it("says which root won in words both renderers use", () => {
    expect(promptRootLabel("client")).toBe("client override");
    expect(promptRootLabel("package")).toBe("package default");
  });
});

describe("a prompt that cannot be used", () => {
  // Selected and unreadable: the served repo's own file is there and is not a
  // file we can read. Typed, because the run owes a row and a dispatcher owes
  // the path.
  it.scoped("fails a selected override the filesystem will not hand over", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const repoRoot = yield* fs.makeTempDirectoryScoped();
      // A directory where the override should be: readable metadata, no text.
      yield* fs.makeDirectory(overridePath(repoRoot, IMPLEMENT_PROMPT), { recursive: true });
      const outcome = yield* Effect.flatMap(PromptSource, (prompts) =>
        prompts.get(IMPLEMENT_PROMPT),
      ).pipe(Effect.provide(clientAt(repoRoot)), Effect.exit);

      expect(Exit.isFailure(outcome)).toBe(true);
      const failure = Exit.isFailure(outcome) ? Cause.failureOption(outcome.cause) : Option.none();
      expect(Option.isSome(failure)).toBe(true);
      if (Option.isSome(failure)) {
        expect(failure.value).toBeInstanceOf(PromptUnusable);
        expect(failure.value.detail).toContain(overridePath(repoRoot, IMPLEMENT_PROMPT));
      }
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  // The malformation a markdown template has: nothing in it. A whole-file
  // override replaces the default outright, so an empty one is a pass told
  // only which branch it is on.
  it.scoped("fails an override holding nothing at all", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const repoRoot = yield* fs.makeTempDirectoryScoped();
      const file = yield* writePrompt(repoRoot, IMPLEMENT_PROMPT, "\n  \n");
      const outcome = yield* Effect.flatMap(PromptSource, (prompts) =>
        prompts.get(IMPLEMENT_PROMPT),
      ).pipe(Effect.provide(clientAt(repoRoot)), Effect.exit);

      const failure = Exit.isFailure(outcome) ? Cause.failureOption(outcome.cause) : Option.none();
      expect(Option.isSome(failure)).toBe(true);
      if (Option.isSome(failure)) {
        expect(failure.value).toBeInstanceOf(PromptUnusable);
        expect(failure.value.detail).toContain(file);
      }
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  // Our own invariant, so a defect: nothing a served repo does fixes a prompt
  // this package failed to ship, and the run cannot report it as their problem.
  it.scoped("dies when neither root holds the name at all", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const repoRoot = yield* fs.makeTempDirectoryScoped();
      const outcome = yield* Effect.flatMap(PromptSource, (prompts) =>
        prompts.get("no-such-pass"),
      ).pipe(Effect.provide(clientAt(repoRoot)), Effect.exit);

      expect(Exit.isFailure(outcome)).toBe(true);
      if (Exit.isFailure(outcome)) {
        expect(Cause.isDie(outcome.cause)).toBe(true);
        expect(Cause.pretty(outcome.cause)).toContain(packagePromptPath("no-such-pass"));
      }
    }).pipe(Effect.provide(NodeContext.layer)),
  );
});

describe("the project-context fragment", () => {
  // Its absence is not an error — it is the narrow common case a served repo
  // has nothing to say about, and no run stops for it.
  it.scoped("answers none when the served repo wrote none", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const repoRoot = yield* fs.makeTempDirectoryScoped();
      const fragment = yield* Effect.flatMap(
        PromptSource,
        (prompts) => prompts.projectContext,
      ).pipe(Effect.provide(clientAt(repoRoot)));

      expect(Option.isNone(fragment)).toBe(true);
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  // Beside the overrides, through the same chain: one directory holds both
  // extension points (19 §2).
  it.scoped("answers the served repo's fragment, from .bessemer/prompts/", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const repoRoot = yield* fs.makeTempDirectoryScoped();
      const file = yield* writePrompt(
        repoRoot,
        PROJECT_CONTEXT_PROMPT,
        "Run `npm run verify` from the repo root.\n",
      );
      const fragment = yield* Effect.flatMap(
        PromptSource,
        (prompts) => prompts.projectContext,
      ).pipe(Effect.provide(clientAt(repoRoot)));

      expect(Option.isSome(fragment)).toBe(true);
      if (Option.isSome(fragment)) {
        expect(fragment.value.root).toBe("client");
        expect(fragment.value.path).toBe(`${repoRoot}/.bessemer/prompts/project-context.md`);
        expect(fragment.value.path).toBe(file);
        expect(fragment.value.text).toContain("npm run verify");
      }
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  // The difference from a pass prompt, and the reason the fragment is its own
  // method: a stub holding whitespace has nothing to add, which is the same
  // answer as having written none — where an empty *pass* prompt is a template
  // that replaced everything with nothing.
  it.scoped("reads a fragment holding only whitespace as none, never as a failure", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const repoRoot = yield* fs.makeTempDirectoryScoped();
      yield* writePrompt(repoRoot, PROJECT_CONTEXT_PROMPT, "\n\n");
      const fragment = yield* Effect.flatMap(
        PromptSource,
        (prompts) => prompts.projectContext,
      ).pipe(Effect.provide(clientAt(repoRoot)));

      expect(Option.isNone(fragment)).toBe(true);
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  // And the package ships none: the fragment is what a *served repo* says about
  // its own project, so a default one here would be this package describing it.
  it.scoped("has no package default behind it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const repoRoot = yield* fs.makeTempDirectoryScoped();
      expect(yield* fs.exists(packagePromptPath(PROJECT_CONTEXT_PROMPT))).toBe(false);
      const fragment = yield* Effect.flatMap(
        PromptSource,
        (prompts) => prompts.projectContext,
      ).pipe(Effect.provide(clientAt(repoRoot)));

      expect(Option.isNone(fragment)).toBe(true);
    }).pipe(Effect.provide(NodeContext.layer)),
  );
});
