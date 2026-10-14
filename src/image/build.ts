// `speepobox image build` (SPEC §7, T111): the served repo's agent image, built
// by the package itself, so every adopter's image carries labels made by the
// one recipe probe 2 checks them with. Each repo used to keep its own bash
// copy of the build and the digest recipe, and a change to the recipe would
// have left every one of them reporting a stale image for good.
//
// It is on the **dispatch surface**, not the read-only slice: it reads `image`
// off `SpeepoboxConfig`, so a config that does not decode stops it at layer
// build as it stops a dispatch. Its words are `image build` and nothing else —
// a rehearsal of a build has nothing to show that the command line does not
// already say, so the rehearsal flag is refused here as any unknown word is.
//
// A repo whose image needs more than this builds its own prerequisites and then
// calls this command; that wrapper is what its `image-build-command` names.
import { FileSystem, Path } from "@effect/platform";
import { Data, Effect, Either, Option } from "effect";
import { SpeepoboxConfig } from "../config/config.ts";
import { SPEEPOBOX_DIRNAME } from "../config/paths.ts";
import { Reporter } from "../reporter.ts";
import { Sandbox, type SandboxError } from "../sandbox/sandbox.ts";
import { INPUTS_DIGEST_LABEL, INPUTS_LABEL, inputsDigest, parseInputsList } from "./inputs.ts";

export const IMAGE_USAGE = "speepobox image build";

// The image's directory, repo-relative and `/`-separated: the build context,
// the home of the Dockerfile, and of the input list. The context is this and
// never the repo root, which holds `checkouts/` — the clones of other runs.
export const IMAGE_DIR = `${SPEEPOBOX_DIRNAME}/image`;
export const DOCKERFILE = `${IMAGE_DIR}/Dockerfile`;
export const INPUTS_LIST = `${IMAGE_DIR}/inputs`;

// One line on stderr and exit 1, through the renderer every other refusal
// uses (`dispatch/render.ts`): an unknown word, an input list that does not
// parse, or a declared input that is not there. All three are answered before
// `Sandbox.build` is asked anything.
export class ImageBuildRefused extends Data.TaggedError("ImageBuildRefused")<{
  readonly detail: string;
}> {}

// The words after `image`. `build` and nothing else.
export const parseImageArgv = (
  argv: ReadonlyArray<string>,
): Either.Either<void, ImageBuildRefused> => {
  const [verb, ...rest] = argv;
  if (verb !== "build") {
    return Either.left(
      new ImageBuildRefused({
        detail: `${verb === undefined ? "image needs a subcommand" : `unknown image subcommand: ${verb}`} (usage: ${IMAGE_USAGE})`,
      }),
    );
  }
  const [unknown] = rest;
  return unknown === undefined
    ? Either.void
    : Either.left(
        new ImageBuildRefused({
          detail: `unknown image build word: ${unknown} (usage: ${IMAGE_USAGE})`,
        }),
      );
};

export interface ImageBuildParams {
  readonly repoRoot: string;
  // The words after `image`.
  readonly argv: ReadonlyArray<string>;
  // Host reads, made in `bin.ts` and handed in (AGENTS.md, *Host reads live at
  // the composition root*): the agent user the image creates is the
  // dispatcher's, so the clone it writes stays theirs on the host.
  readonly uid: number;
  readonly gid: number;
}

export const imageBuild = (
  params: ImageBuildParams,
): Effect.Effect<
  void,
  ImageBuildRefused | SandboxError,
  SpeepoboxConfig | Sandbox | Reporter | FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    yield* parseImageArgv(params.argv);
    const config = yield* SpeepoboxConfig;
    const sandbox = yield* Sandbox;
    const reporter = yield* Reporter;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const onHost = (input: string): string => path.join(params.repoRoot, ...input.split("/"));

    // A missing list is an empty one: the Dockerfile is then the only input.
    const listPath = onHost(INPUTS_LIST);
    const listed = yield* fs.exists(listPath).pipe(
      Effect.flatMap((exists) => (exists ? fs.readFileString(listPath) : Effect.succeed(""))),
      Effect.mapError(
        (error) =>
          new ImageBuildRefused({ detail: `could not read ${INPUTS_LIST}: ${error.message}` }),
      ),
    );
    const inputs = yield* parseInputsList(listed, DOCKERFILE).pipe(
      Either.mapLeft(
        (refused) =>
          new ImageBuildRefused({
            detail: `${INPUTS_LIST} line ${refused.line}: '${refused.text}' ${refused.reason}`,
          }),
      ),
    );

    // Every input must exist, refused here and nowhere else. Probe 2 reads the
    // same absence as a change.
    const missing: Array<string> = [];
    for (const input of inputs) {
      if (!(yield* fs.exists(onHost(input)).pipe(Effect.orElseSucceed(() => false)))) {
        missing.push(input);
      }
    }
    if (missing.length > 0) {
      return yield* new ImageBuildRefused({
        detail: `image input${missing.length === 1 ? "" : "s"} not found: ${missing.join(", ")} — the image is built from ${DOCKERFILE} and every path ${INPUTS_LIST} lists, so each must exist`,
      });
    }

    // The one recipe probe 2 recomputes with. `None` here is an input that
    // exists and still cannot be read — a directory, say — which a label
    // could not describe.
    const digest = yield* inputsDigest(params.repoRoot, inputs);
    if (Option.isNone(digest)) {
      return yield* new ImageBuildRefused({
        detail: `could not read every image input to digest it: ${inputs.join(", ")} — each must be a readable file`,
      });
    }

    yield* sandbox.build({
      tag: config.image,
      context: onHost(IMAGE_DIR),
      dockerfile: onHost(DOCKERFILE),
      buildArgs: { AGENT_UID: String(params.uid), AGENT_GID: String(params.gid) },
      labels: { [INPUTS_LABEL]: inputs.join(","), [INPUTS_DIGEST_LABEL]: digest.value },
      onOutput: (line) => reporter.emit({ _tag: "ImageBuildOutput", line }),
    });
  });
