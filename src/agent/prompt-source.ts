// `PromptSource` (SPEC §8): the precedence chain over the prompt files, and
// the surface a served repo extends. It earns its tag on **the precedence
// logic** and on being that surface — not on file reading, which `FileSystem`
// already fakes (05 Q9), which is why the reads below are `FileSystem`
// directly with no wrapper of our own between them and this module.
//
// **`get` answers with the text and with which root won**, and both halves are
// load-bearing: the assembled prompt is logged verbatim before every pass
// (`run.sh:1096`, T9), and a served repo that drops an override in needs the
// log to say its file is the one that took. The root travels on
// `PromptAssembled` from there.
//
// **Two roots, whole-file granularity.** The served repo's
// `<repoRoot>/.bessemer/prompts/<name>.md` beats `<packageRoot>/prompts/
// <name>.md`, and that is the entire override mechanism: there is no
// fragment-patching of a default, because that is a mini-templating-language
// and 05 Q9 rejected it by name. What a served repo gets instead of patching
// is `project-context.md` — one small fragment, beside the overrides in that
// same directory, which the assembly interpolates into whichever template won
// (`prompt.ts`), so the narrow common case (this project's verify command, its
// setup notes) survives the defaults improving underneath it and needs no copy
// of them.
//
// **The bessemer directory, not the runtime root** (19 §2, T59). A prompt is a
// read location, and read locations resolve against the served repo
// (`CONTEXT.md`); the runtime root is where this tool *writes*, so moving it
// moves writes only and says nothing about which prompt wins.
//
// **Interpolation is not here.** It stays the pure function T9 wrote
// (`prompt.ts`); this module reads files and decides which one, and hands both
// answers to the pass.
import { FileSystem, type Path } from "@effect/platform";
import type { PlatformError } from "@effect/platform/Error";
import { Context, Data, Effect, Layer, Option } from "effect";
import { bessemerDir } from "../config/paths.ts";
import { packagePromptPath, PROJECT_CONTEXT_PROMPT, promptPathIn } from "./prompt.ts";

// Which root a prompt came from. Two arms, because there are two roots — a
// third would be a design change rather than a case to add.
export type PromptRoot = "client" | "package";

// What a reader is told the root is, in one place because two renderers say it
// (`app.ts` on the console, `run-log.ts` in the file) and a reader comparing
// the two must not have to work out that they mean the same thing. *Client
// override* is the wording logs already carry, and it stays (19 §9).
export const promptRootLabel = (root: PromptRoot): string =>
  root === "client" ? "client override" : "package default";

export interface ResolvedPrompt {
  readonly text: string;
  readonly root: PromptRoot;
  // Which file it actually was. It never reaches the log — the root is what a
  // reader confirming an override reads — but it is what a failure has to
  // name, since "the implement prompt is empty" is unactionable without the
  // path it is empty at.
  readonly path: string;
}

// A prompt file that was **selected** and cannot be used: unreadable (a
// directory, a permission, a device), or malformed, which for a markdown
// template means holding nothing at all. Typed by the outcome-row test (SPEC
// §3): the read happens inside the run's scope, so the run owes a `failed` row
// at the stage of the pass that asked, and a dispatcher owes an answer naming
// the file.
//
// It is **not** `PromptError`: `Prompt` is the clack tag P3 introduces, and
// two unrelated errors a letter apart in the same package is a name that
// misleads once. The condition is what it is named for, as `LockHeld` and
// `ImageUnavailable` are.
//
// The two cases it does not cover are the two the ticket separates out. A
// missing override is no error at all — it is the package default winning,
// which is the ordinary path. A missing *package* prompt is a **defect**: our
// own invariant broke, and nothing a served repo does fixes it.
export class PromptUnusable extends Data.TaggedError("PromptUnusable")<{
  readonly detail: string;
}> {}

export interface PromptSourceShape {
  // The pass prompts (`implement`, `review`, `describe-pr`), resolved through
  // the chain. Absent from both roots is a defect, so this never answers "no
  // prompt".
  readonly get: (name: string) => Effect.Effect<ResolvedPrompt, PromptUnusable>;
  // The fragment, and the reason it is a second method rather than
  // `get(PROJECT_CONTEXT_PROMPT)`: **absence is an answer here and a defect
  // there.** A served repo that wrote no `project-context.md` has said
  // everything it wanted to say, and routing that through `get` would either
  // kill the run over a file nobody has to write or soften the missing-default
  // rule into a shrug for every prompt. Same chain, same roots — only the
  // empty case differs.
  readonly projectContext: Effect.Effect<Option.Option<ResolvedPrompt>, PromptUnusable>;
}

export class PromptSource extends Context.Tag("PromptSource")<PromptSource, PromptSourceShape>() {}

// The one platform error that is not a failure here: the file is simply not at
// that root, which is the question the chain is asking.
const isMissing = (error: PlatformError): boolean =>
  error._tag === "SystemError" && error.reason === "NotFound";

// The served repo is the parameter, and the only one: nothing here reads the
// config once the runtime root is out of the picture (T59).
export const promptSourceLiveFor = (
  repoRoot: string,
): Layer.Layer<PromptSource, never, FileSystem.FileSystem | Path.Path> =>
  Layer.effect(
    PromptSource,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;

      // The overriding root: the served repo's bessemer directory, derived
      // once here and never spelled as a literal (`paths.ts`). No guard stands
      // beside it and none can be needed — `.bessemer/prompts/` is never
      // `<packageRoot>/prompts/`, self-hosted or not, so the two roots cannot
      // be one directory and a shipped default cannot arrive wearing an
      // override's name. `promptPathIn` is what both arms below derive with,
      // so the two roots cannot resolve a name two different ways either.
      const overrideRoot = bessemerDir(repoRoot);

      // One read, not an `exists` and then a read: the two-syscall shape has to
      // decide what a file that vanished in between means, and this has the
      // answer already — the platform tells missing apart from unreadable, and
      // those are exactly the two outcomes the chain distinguishes.
      const readAt = (file: string): Effect.Effect<Option.Option<string>, PromptUnusable> =>
        fs.readFileString(file).pipe(
          Effect.map(Option.some),
          Effect.catchIf(isMissing, () => Effect.succeed(Option.none<string>())),
          Effect.mapError(
            (error) => new PromptUnusable({ detail: `could not read ${file}: ${error.message}` }),
          ),
        );

      // The chain itself, and the whole of it: the served repo's bessemer
      // directory when it holds the file, the package root otherwise.
      const resolve = (
        name: string,
      ): Effect.Effect<Option.Option<ResolvedPrompt>, PromptUnusable> =>
        Effect.gen(function* () {
          const overridePath = promptPathIn(overrideRoot, name);
          const override = yield* readAt(overridePath);
          if (Option.isSome(override)) {
            return Option.some({
              text: override.value,
              root: "client",
              path: overridePath,
            } as const);
          }
          const defaultPath = packagePromptPath(name);
          return Option.map(
            yield* readAt(defaultPath),
            (text) => ({ text, root: "package", path: defaultPath }) as const,
          );
        });

      return {
        get: (name) =>
          resolve(name).pipe(
            Effect.flatMap(
              Option.match({
                // Our own invariant, so a defect rather than a run's outcome:
                // no served repo can fix a prompt this package failed to ship,
                // and reporting it as a run failure would file it under the
                // same heading as their own broken override.
                onNone: () =>
                  Effect.dieMessage(
                    `no ${name} prompt is shipped at ${packagePromptPath(name)} — the package's own default is missing`,
                  ),
                onSome: (resolved) =>
                  resolved.text.trim() === ""
                    ? Effect.fail(
                        new PromptUnusable({
                          detail: `the ${name} prompt at ${resolved.path} is empty — a whole-file override replaces the default outright, so an empty one would hand the agent nothing but the dispatcher's message`,
                        }),
                      )
                    : Effect.succeed(resolved),
              }),
            ),
          ),
        // A fragment holding only whitespace is the absent case, not the empty
        // case `get` refuses: the fragment is *additive*, so nothing to add is
        // what a served repo that left a stub behind meant, while an empty pass
        // prompt is a template that replaced everything with nothing.
        projectContext: resolve(PROJECT_CONTEXT_PROMPT).pipe(
          Effect.map(Option.filter((resolved) => resolved.text.trim() !== "")),
        ),
      };
    }),
  );
