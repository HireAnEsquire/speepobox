// `init --diff` (T116): which scaffold files a newer package would change,
// never counting an adopter's own edits as drift. Read-only — it opens nothing
// for writing — and so allowed on a self-hosted repo, where `init` refuses
// (E9).
//
// Each stamped file is read and `readStamp`ed (T113): absent is `missing`, a
// stamp at the template's version is `current`, and anything lower — no stamp
// at all counts as version 0 — is `behind`. Pristine or edited is the body
// digest against the stamp's. The template a file was stamped from is not
// kept, because the shim clones one SHA (E6), so a behind file's diff is the
// *current* template against the file, and it includes the adopter's edits.
// `config.toml` is presence only; the tasks dir is probe 8's. The shim is
// also asked for its owner's execute bit (T127), which is not drift.
import { FileSystem, Path } from "@effect/platform";
import { Effect, Option } from "effect";
import { BESSEMER_DIRNAME } from "../config/paths.ts";
import { InitRefused } from "./argv.ts";
import { unifiedDiff } from "./line-diff.ts";
import { countsAsDrift, isNotExecutable, type DriftFile, type StampedDrift } from "./snapshot.ts";
import {
  bodyDigest,
  readStamp,
  SHIM,
  STAMPED_TEMPLATES,
  stamp,
  TEMPLATE_VERSIONS,
  type StampedTemplate,
} from "./stamp.ts";

// One stamped file's standing, given its text (or none when it is absent) and
// the template's. Pure: the effect below only reads.
export const driftOf = (input: {
  readonly path: string;
  readonly template: StampedTemplate;
  readonly templatePath: string;
  readonly templateText: string;
  readonly text: Option.Option<string>;
  // Whether the owner may execute the file — asked of the shim alone, and
  // `None` for every other file and for an absent one (T127).
  readonly executable: Option.Option<boolean>;
}): StampedDrift => {
  const templateVersion = TEMPLATE_VERSIONS[input.template];
  const base = {
    _tag: "Stamped" as const,
    path: input.path,
    template: input.template,
    templatePath: input.templatePath,
    templateVersion,
    notExecutable: Option.contains(input.executable, false),
  };
  if (Option.isNone(input.text)) {
    return {
      ...base,
      state: "missing",
      edited: false,
      stampVersion: 0,
      stamped: false,
      stampedAs: Option.none(),
      diff: "",
    };
  }
  const text = input.text.value;
  const found = readStamp(text);
  const stampedAs = Option.filter(
    Option.map(found, (s) => s.name),
    (name) => name !== input.template,
  );
  const stampVersion = Option.match(found, { onNone: () => 0, onSome: (s) => s.version });
  // A stamp copied from another template vouches for nothing about this one.
  const edited =
    Option.isSome(stampedAs) ||
    Option.match(found, { onNone: () => true, onSome: (s) => s.digest !== bodyDigest(text) });
  const behind = Option.isSome(stampedAs) || stampVersion < templateVersion;
  const current = stamp(input.template, templateVersion, input.templateText);
  return {
    ...base,
    state: behind ? "behind" : "current",
    edited,
    stampVersion,
    stamped: Option.isSome(found),
    stampedAs,
    diff: behind
      ? unifiedDiff(input.path, `templates/${input.template} v${templateVersion}`, text, current)
      : "",
  };
};

const shown = (name: string): string => `${BESSEMER_DIRNAME}/${name}`;

export interface InitDiffOptions {
  readonly repoRoot: string;
  readonly templatesRoot: string;
}

// Reads the scaffold and the templates, and answers with every file's
// standing. A path that cannot be read as a file — a directory standing
// there, a permission — refuses naming it, rather than reading as missing.
export const scaffoldDrift = (
  options: InitDiffOptions,
): Effect.Effect<ReadonlyArray<DriftFile>, InitRefused, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const at = (name: string) => path.join(options.repoRoot, BESSEMER_DIRNAME, name);
    // Repo-relative where the package sits inside the served repo — the
    // self-hosted case, whose remedy names it — and absolute otherwise.
    const shownTemplate = (file: string) => {
      const relative = path.relative(options.repoRoot, file);
      return relative.startsWith("..") || path.isAbsolute(relative) ? file : relative;
    };

    const config = yield* fs.exists(at("config.toml")).pipe(
      Effect.mapError(
        (error) =>
          new InitRefused({
            detail: `init --diff could not read ${shown("config.toml")}: ${error.message}`,
          }),
      ),
    );

    const stamped = yield* Effect.forEach(STAMPED_TEMPLATES, (template) =>
      Effect.gen(function* () {
        const templateFile = path.join(options.templatesRoot, template);
        // The package ships its templates: one that does not read is our own
        // invariant broken, which no adopter action fixes.
        const templateText = yield* Effect.orDie(fs.readFileString(templateFile));
        const text = yield* fs.readFileString(at(template)).pipe(
          Effect.map(Option.some),
          Effect.catchIf(
            (error) => error._tag === "SystemError" && error.reason === "NotFound",
            () => Effect.succeed(Option.none<string>()),
          ),
          Effect.mapError(
            (error) =>
              new InitRefused({
                detail: `init --diff could not read ${shown(template)}: ${error.message}`,
              }),
          ),
        );
        const executable =
          template === SHIM && Option.isSome(text)
            ? yield* fs.stat(at(template)).pipe(
                Effect.map((info) => Option.some((info.mode & 0o100) !== 0)),
                Effect.mapError(
                  (error) =>
                    new InitRefused({
                      detail: `init --diff could not read ${shown(template)}: ${error.message}`,
                    }),
                ),
              )
            : Option.none<boolean>();
        return driftOf({
          path: shown(template),
          template,
          templatePath: shownTemplate(templateFile),
          templateText,
          text,
          executable,
        });
      }),
    );

    return [{ _tag: "Presence", path: shown("config.toml"), present: config }, ...stamped];
  });

// What `--diff`'s exit status counts: every file that drifted, and a shim that
// cannot run (T127) — never a self-hosted repo's absent shim.
export const failureCount = (files: ReadonlyArray<DriftFile>, selfHosted: boolean): number =>
  files.filter((file) => countsAsDrift(file, selfHosted) || isNotExecutable(file)).length;
