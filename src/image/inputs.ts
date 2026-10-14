// What an agent image was built from (T30, T110): the two labels it declares,
// the one digest recipe the build and probe 2 share, and the served repo's
// input list the build reads. Nothing here runs a build or asks docker.
import { FileSystem, Path } from "@effect/platform";
import { createHash } from "node:crypto";
import { posix } from "node:path";
import { Data, Effect, Either, Option } from "effect";

// The two labels the image carries about its own build (T30). They share the
// `bessemer.*` prefix with `ownership/labels.ts` and nothing else: ownership is
// a claim the *dispatcher* makes about a container it created and filters on,
// these are a declaration the *image* makes about the files it was built from,
// so they live beside the recipe the build writes them with and probe 2 reads
// them back through.
export const INPUTS_LABEL = "bessemer.inputs";
export const INPUTS_DIGEST_LABEL = "bessemer.inputs.digest";

export interface DeclaredInputs {
  // Repo-relative, `/`-separated, **in the order they were hashed** — the order
  // is part of the declaration, since it is part of the digest.
  readonly paths: ReadonlyArray<string>;
  readonly digest: string;
}

// The `bessemer.inputs` / `bessemer.inputs.digest` pair as inspect prints it.
// `None` is the undeclared image — every image built before T30, and any image
// built by something other than the repo's own build command.
export const parseDeclaredInputs = (stdout: string): Option.Option<DeclaredInputs> => {
  const [inputs = "", digest = ""] = stdout.split("\n");
  const paths = inputs
    .split(",")
    .map((declared) => declared.trim())
    .filter((declared) => declared !== "");
  return paths.length === 0
    ? Option.none()
    : Option.some({ paths, digest: digest.trim().toLowerCase() });
};

// The digest, spelled once here (T30 §4, T110). It has two callers and must
// have one recipe: probe 2, which recomputes it against the repo, and the
// package's own image build (T111), which writes it onto the image:
//
//     for each declared path p, in order: emit "<p> <sha256 of <root>/p>\n"
//     digest = sha256 over the concatenation of those lines, as UTF-8
//
// The path goes into the digest beside its hash so that reordering or renaming
// an input is a change rather than a collision. `None` is a declared path that
// is not readable here, which is a change like any other — deleting an input is
// not "unknown", and the probe reports it as one rather than refusing.
export const inputsDigest = (
  root: string,
  inputs: ReadonlyArray<string>,
): Effect.Effect<Option.Option<string>, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    let lines = "";
    for (const input of inputs) {
      // The declaration is `/`-separated whatever the host that built the image
      // separates paths with; this host joins it its own way.
      const contents = yield* fs.readFile(path.join(root, ...input.split("/"))).pipe(Effect.option);
      if (Option.isNone(contents)) {
        return Option.none();
      }
      lines += `${input} ${createHash("sha256").update(contents.value).digest("hex")}\n`;
    }
    return Option.some(createHash("sha256").update(lines, "utf8").digest("hex"));
  });

// The served repo's input list (`.bessemer/image/inputs`, T110), refused. It
// names the line — its 1-based number and its text as written — because the
// dispatcher's repair is an edit to exactly that line.
export class InputsListRefused extends Data.TaggedError("InputsListRefused")<{
  readonly line: number;
  readonly text: string;
  readonly reason: string;
}> {}

// What the input list says, in the order the digest hashes it: the Dockerfile
// first — implicit, so a list can never leave out the one file every image is
// built from — then each listed path in file order. One repo-relative,
// `/`-separated path a line; surrounding whitespace is trimmed, and blank lines
// and `#` lines are skipped, which is where a template stamp (T113) sits.
//
// **No globs.** bash's list globbed, and a glob that stopped matching had to be
// read as a missing file; an exact path makes that case unrepresentable. An
// absolute path or one that normalizes out of the repo is refused on
// `sandbox-env-file`'s lexical rule (T61). A repeat is refused, since it would
// hash twice and say nothing new — except the Dockerfile, which is dropped:
// naming it is redundant, not wrong. The list file is not an input of its own;
// every hashed line carries its path, so adding one already moves the digest.
//
// Whether the files exist is the build's question (T111); this is pure.
export const parseInputsList = (
  text: string,
  dockerfile: string,
): Either.Either<ReadonlyArray<string>, InputsListRefused> => {
  const implicit = posix.normalize(dockerfile);
  const paths: Array<string> = [implicit];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const written = (lines[index] ?? "").trim();
    if (written === "" || written.startsWith("#")) {
      continue;
    }
    const refuse = (reason: string) =>
      Either.left(new InputsListRefused({ line: index + 1, text: written, reason }));
    if (/[*?[]/.test(written)) {
      return refuse("is a glob — list each file by its exact path");
    }
    if (posix.isAbsolute(written)) {
      return refuse("is an absolute path — list it relative to the repo root");
    }
    const normalized = posix.normalize(written);
    if (normalized === ".." || normalized.startsWith("../")) {
      return refuse("leaves the repo");
    }
    // `.` and `a/..` stay inside lexically but name the repo root itself,
    // which T61's rule refuses too: its join is the root, not a path under it.
    if (normalized === "." || normalized === "./") {
      return refuse("names the repo root, not a file in it");
    }
    if (normalized === implicit) {
      continue;
    }
    if (paths.includes(normalized)) {
      return refuse("is listed twice");
    }
    paths.push(normalized);
  }
  return Either.right(paths);
};
