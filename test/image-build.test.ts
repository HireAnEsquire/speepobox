// `speepobox image build` (T111) against a fake `Sandbox` that keeps the build
// spec it was handed, over a real temporary repo: the spec is the assertion,
// and whether the declared files exist is a question only a real tree answers.
// The argv docker is handed is `test/sandbox-spec.test.ts`'s and
// `test/sandbox.test.ts`'s; nothing here spawns anything.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { FileSystem, Path } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { Effect, Either, Layer, Option, Ref } from "effect";
import { SpeepoboxConfig, defaultConfig } from "../src/config/config.ts";
import { packageRoot } from "../src/config/paths.ts";
import { IMAGE_USAGE, imageBuild, ImageBuildRefused } from "../src/image/build.ts";
import { INPUTS_DIGEST_LABEL, INPUTS_LABEL, inputsDigest } from "../src/image/inputs.ts";
import { Reporter, type ReporterEvent } from "../src/reporter.ts";
import { Sandbox, SandboxError } from "../src/sandbox/sandbox.ts";
import type { SandboxBuildSpec } from "../src/sandbox/spec.ts";

const DOCKERFILE = ".speepobox/image/Dockerfile";
const UID = 501;
const GID = 20;

const unused = () => Effect.die("image build asks the sandbox for nothing but a build");

// A served repo holding the given files, repo-relative.
const repoWith = (files: Record<string, string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped();
    for (const [name, contents] of Object.entries(files)) {
      const at = path.join(root, name);
      yield* fs.makeDirectory(path.dirname(at), { recursive: true });
      yield* fs.writeFileString(at, contents);
    }
    return root;
  });

// The fake: it keeps each spec, narrates `lines` through the spec's own
// `onOutput` as the live layer does, and fails when told to.
const world = (options: { readonly lines?: ReadonlyArray<string>; readonly fails?: string } = {}) =>
  Effect.gen(function* () {
    const builds = yield* Ref.make<ReadonlyArray<SandboxBuildSpec>>([]);
    const events = yield* Ref.make<ReadonlyArray<ReporterEvent>>([]);
    const layer = Layer.mergeAll(
      Layer.succeed(Sandbox, {
        run: unused,
        remove: unused,
        exec: unused,
        build: (spec) =>
          Ref.update(builds, (current) => [...current, spec]).pipe(
            Effect.zipRight(Effect.forEach(options.lines ?? [], spec.onOutput)),
            Effect.zipRight(
              options.fails === undefined
                ? Effect.void
                : new SandboxError({ detail: options.fails, sandboxGone: false }),
            ),
          ),
      }),
      Layer.succeed(Reporter, {
        emit: (event) => Ref.update(events, (current) => [...current, event]),
      }),
      Layer.succeed(SpeepoboxConfig, {
        ...defaultConfig,
        runtimeRoot: "/srv/speepobox",
        image: "hae-agentbox",
      }),
    );
    return { builds, events, layer };
  });

const build = (
  repoRoot: string,
  layer: Layer.Layer<Sandbox | Reporter | SpeepoboxConfig>,
  argv: ReadonlyArray<string> = ["build"],
) => imageBuild({ repoRoot, argv, uid: UID, gid: GID }).pipe(Effect.provide(layer), Effect.either);

const refusalOf = (
  result: Either.Either<void, ImageBuildRefused | SandboxError>,
): ImageBuildRefused => {
  if (Either.isRight(result) || !(result.left instanceof ImageBuildRefused)) {
    throw new Error(`expected an ImageBuildRefused, got ${JSON.stringify(result)}`);
  }
  return result.left;
};

describe("image build", () => {
  it.scoped(
    "builds the config's image from .speepobox/image with the uid, gid, and both labels",
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const root = yield* repoWith({
          [DOCKERFILE]: "FROM scratch\n",
          ".speepobox/image/inputs": "# stamp\npackage.json\n\napi/requirements.txt\n",
          "package.json": "{}\n",
          "api/requirements.txt": "effect\n",
        });
        const scratch = yield* world();
        const result = yield* build(root, scratch.layer);

        expect(result).toEqual(Either.void);
        const [spec, ...others] = yield* Ref.get(scratch.builds);
        expect(others).toEqual([]);
        const inputs = [DOCKERFILE, "package.json", "api/requirements.txt"];
        expect(spec).toMatchObject({
          tag: "hae-agentbox",
          context: path.join(root, ".speepobox", "image"),
          dockerfile: path.join(root, ".speepobox", "image", "Dockerfile"),
          buildArgs: { AGENT_UID: "501", AGENT_GID: "20" },
        });
        // The Dockerfile first, then the list in its own order; and the digest
        // is the one probe 2 recomputes over the same tree.
        expect(spec?.labels).toEqual({
          [INPUTS_LABEL]: inputs.join(","),
          [INPUTS_DIGEST_LABEL]: Option.getOrThrow(yield* inputsDigest(root, inputs)),
        });
      }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("builds from the Dockerfile alone when the repo has no input list", () =>
    Effect.gen(function* () {
      const root = yield* repoWith({ [DOCKERFILE]: "FROM scratch\n" });
      const scratch = yield* world();
      expect(yield* build(root, scratch.layer)).toEqual(Either.void);
      const [spec] = yield* Ref.get(scratch.builds);
      expect(spec?.labels[INPUTS_LABEL]).toBe(DOCKERFILE);
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("streams docker's lines to the console as ImageBuildOutput events", () =>
    Effect.gen(function* () {
      const root = yield* repoWith({ [DOCKERFILE]: "FROM scratch\n" });
      const scratch = yield* world({ lines: ["#1 load", "#2 done"] });
      yield* build(root, scratch.layer);
      expect(yield* Ref.get(scratch.events)).toEqual([
        { _tag: "ImageBuildOutput", line: "#1 load" },
        { _tag: "ImageBuildOutput", line: "#2 done" },
      ]);
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("refuses a declared input that does not exist, naming it, before building", () =>
    Effect.gen(function* () {
      const root = yield* repoWith({
        [DOCKERFILE]: "FROM scratch\n",
        ".speepobox/image/inputs": "package.json\nclient/yarn.lock\n",
        "package.json": "{}\n",
      });
      const scratch = yield* world();
      const refused = refusalOf(yield* build(root, scratch.layer));
      expect(refused.detail).toContain("client/yarn.lock");
      expect(refused.detail).not.toContain("package.json,");
      expect(yield* Ref.get(scratch.builds)).toEqual([]);
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("refuses a missing Dockerfile, which is an input like any other", () =>
    Effect.gen(function* () {
      const root = yield* repoWith({});
      const scratch = yield* world();
      expect(refusalOf(yield* build(root, scratch.layer)).detail).toContain(DOCKERFILE);
      expect(yield* Ref.get(scratch.builds)).toEqual([]);
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("refuses a glob in the list, naming the line, on one line", () =>
    Effect.gen(function* () {
      const root = yield* repoWith({
        [DOCKERFILE]: "FROM scratch\n",
        ".speepobox/image/inputs": "# stamp\napi/requirements*.txt\n",
      });
      const scratch = yield* world();
      const { detail } = refusalOf(yield* build(root, scratch.layer));
      expect(detail).toContain(".speepobox/image/inputs line 2");
      expect(detail).toContain("api/requirements*.txt");
      expect(detail).toContain("glob");
      expect(detail).not.toContain("\n");
      expect(yield* Ref.get(scratch.builds)).toEqual([]);
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped.each<{ readonly argv: ReadonlyArray<string>; readonly named: string }>([
    { argv: ["build", "--dry-run"], named: "--dry-run" },
    { argv: ["build", "now"], named: "now" },
    { argv: ["rebuild"], named: "rebuild" },
    { argv: [], named: "subcommand" },
  ])("refuses the words $argv, and builds nothing", ({ argv, named }) =>
    Effect.gen(function* () {
      const root = yield* repoWith({ [DOCKERFILE]: "FROM scratch\n" });
      const scratch = yield* world();
      const { detail } = refusalOf(yield* build(root, scratch.layer, argv));
      expect(detail).toContain(named);
      expect(detail).toContain("speepobox image build");
      expect(yield* Ref.get(scratch.builds)).toEqual([]);
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("fails with the build's own SandboxError when docker does", () =>
    Effect.gen(function* () {
      const root = yield* repoWith({ [DOCKERFILE]: "FROM scratch\n" });
      const scratch = yield* world({ fails: "could not build the image 'hae-agentbox': boom" });
      const result = yield* build(root, scratch.layer);
      expect(result).toEqual(
        Either.left(
          new SandboxError({
            detail: "could not build the image 'hae-agentbox': boom",
            sandboxGone: false,
          }),
        ),
      );
    }).pipe(Effect.provide(NodeContext.layer)),
  );
});

// `bin.ts` runs the CLI on import, so its usage text is read as a file rather
// than imported (AGENTS.md): the command a dispatcher cannot find in `speepobox`
// with no arguments is a command nobody runs.
describe("the usage text", () => {
  it("names image build", () => {
    const usage = readFileSync(join(packageRoot, "src", "bin.ts"), "utf8");
    expect(usage).toContain(`  ${IMAGE_USAGE}\n`);
  });
});
