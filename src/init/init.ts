// `init` (SPEC §7, P5): writes the scaffold into the served repo — the command
// an adopter runs once, and again whenever a later version adds a template.
//
// It is intercepted in `bin.ts` beside `status`, `doctor`, and `gc`, before
// any preflight, because there is no config to decode yet (E9), and it runs on
// the read-only slice whose config layer is the tolerant one: an absent or
// broken `config.toml` cannot stop the command that writes it.
//
// **Only absent files are written** (E4). A file already there is never
// opened for writing and is reported `kept`; there is no `--force`, and an
// adopter refreshes a file by deleting it and running `init` again. Nothing is
// written until every refusal has had its chance, a directory standing where
// a file goes included.
//
// `--diff` (T116) is the read-only branch: it writes nothing, runs where
// `init` refuses, and lives in `diff.ts`.
//
// Files are written through `FileSystem`, which SPEC §2 uses directly and
// wraps in nothing.
//
// **The three config values are worked out, and a flag overrides each** (T115).
// The base is `origin/HEAD` in the served repo, asked through `Git`; the image
// is the served repo directory's name (`values.ts`); `tool-sha` is the
// running package's full SHA (T124), handed down from `bin.ts`. They are worked
// out only when `config.toml` is absent (T127): a kept file asks nothing (E4).
// Only the base can refuse — a repo that answers neither a flag nor a read has
// no base to write — and it refuses before anything is written. An unpinnable revision is written
// as `""` with a warning and never refuses: the shim refuses the empty pin
// naming its fix, and that is where the adopter is stopped (F6). A revision
// no release marks is written too, with a warning of its own (F16): a hand
// clone at main is a legitimate way to try one, and `upgrade` is what keeps a
// pin on releases.
import { basename } from "node:path";
import { FileSystem, Path } from "@effect/platform";
import type { PlatformError } from "@effect/platform/Error";
import { Effect, Either, Option } from "effect";
import { SPEEPOBOX_DIRNAME } from "../config/paths.ts";
import type { DispatcherRevision } from "../git/dispatcher-revision.ts";
import { Git } from "../git/git.ts";
import { releaseAt, type Release } from "../git/releases.ts";
import { Reporter } from "../reporter.ts";
import { InitRefused, parseInitArgv } from "./argv.ts";
import { failureCount, scaffoldDrift } from "./diff.ts";
import type { InitFile, InitValues } from "./snapshot.ts";
import {
  SHIM,
  STAMPED_TEMPLATES,
  stamp,
  substitute,
  TEMPLATE_VERSIONS,
  type StampedTemplate,
  type TemplateName,
} from "./stamp.ts";
import { imageNameFor, type ResolvedValue } from "./values.ts";

export interface InitOptions {
  // Resolved at the composition root: the served repo the scaffold goes into.
  readonly repoRoot: string;
  // The words after `init`.
  readonly argv: ReadonlyArray<string>;
  // Decided once in `bin.ts` and passed down (19 §4): this repo is not
  // scaffolded.
  readonly selfHosted: boolean;
  // `<packageRoot>/templates`, handed in from `bin.ts` (SPEC §9).
  readonly templatesRoot: string;
  // The running package's revision (T43), resolved in `bin.ts`: what
  // `tool-sha` pins when it is clean.
  readonly dispatcherRevision: Option.Option<DispatcherRevision>;
  // The releases on the package's `HEAD` (T122's offline read), resolved in
  // `bin.ts` beside the revision. `None` when the read failed: nothing is
  // known about a release then, so nothing is said about one.
  readonly headReleases: Option.Option<ReadonlyArray<Release>>;
}

// The empty file that makes `.speepobox/tasks/`, the directory the config's
// `tasks-dir` names, so `doctor`'s probe 8 is green on a fresh scaffold.
const TASKS_KEEP = "tasks/.gitkeep";

const CONFIG = "config.toml";

// What the scaffold holds, by its path under the speepobox directory, in the
// order it is reported.
const SCAFFOLD: ReadonlyArray<string> = [CONFIG, ...STAMPED_TEMPLATES, TASKS_KEEP];

const isStamped = (name: string): name is StampedTemplate =>
  (STAMPED_TEMPLATES as ReadonlyArray<string>).includes(name);

// What one absent scaffold file is written with. `config.toml` is asked for
// only when it is absent, which is the only time its values exist (T127). A
// template that does not read or does not substitute is the package's own
// invariant broken — it ships the templates and their placeholders together —
// so it dies rather than refusing: no adopter action fixes it.
const contentsOf = (
  templatesRoot: string,
  name: string,
  values: Option.Option<InitValues>,
): Effect.Effect<string, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const read = (template: TemplateName) => fs.readFileString(path.join(templatesRoot, template));
    if (isStamped(name)) {
      return stamp(name, TEMPLATE_VERSIONS[name], yield* read(name));
    }
    if (name !== CONFIG) {
      return "";
    }
    if (Option.isNone(values)) {
      return yield* Effect.dieMessage("config.toml is written only with its values worked out");
    }
    const config = substitute(yield* read(CONFIG), {
      base: values.value.base.value,
      image: values.value.image.value,
      "tool-sha": values.value["tool-sha"].value,
    });
    if (Either.isLeft(config)) {
      return yield* Effect.die(config.left);
    }
    return config.right;
  }).pipe(Effect.orDie);

const fromFlag = (flag: Option.Option<string>): Option.Option<ResolvedValue> =>
  Option.map(flag, (value) => ({ value, source: "flag" }));

// A flag, else `origin/HEAD`, else the refusal naming both remedies. There is
// no refusal of its own for a repo with no `origin` (E9): its `origin/HEAD`
// is as unset as a clone's that never ran `set-head`, and given `--base`,
// `doctor`'s probe 5 is where the missing remote is reported.
const resolveBase = (
  repoRoot: string,
  flag: Option.Option<string>,
): Effect.Effect<ResolvedValue, InitRefused, Git> =>
  Option.match(fromFlag(flag), {
    onSome: Effect.succeed,
    onNone: () =>
      Effect.flatMap(Git, (git) => git.originHead({ repo: repoRoot })).pipe(
        Effect.mapError(
          (error) =>
            new InitRefused({ detail: `init could not read origin/HEAD: ${error.detail}` }),
        ),
        Effect.flatMap(
          Option.match({
            onSome: (value) => Effect.succeed<ResolvedValue>({ value, source: "origin/HEAD" }),
            onNone: () =>
              new InitRefused({
                detail:
                  "init cannot work out the base: origin/HEAD is not set — pass --base <ref>, or run `git remote set-head origin --auto` — nothing was written",
              }),
          }),
        ),
      ),
  });

interface ToolSha {
  readonly value: ResolvedValue;
  readonly warning: Option.Option<string>;
}

const emptyPin = (why: string): ToolSha => ({
  value: { value: "", source: "package revision" },
  warning: Option.some(
    `tool-sha is written empty: ${why} — set it by hand to a pushed speepobox revision`,
  ),
});

// The package's full SHA when it names a commit, and `""` with the reason
// when it does not: a dirty tree's revision is not what is running, and an
// unread one is nothing at all. The full SHA, never git's abbreviation: a
// fetch by SHA is served only for a full one, and the pin grammar refuses
// anything shorter (F6, T121).
//
// A clean revision no `v<N>` tag marks is still pinned, and warned about
// once (F16) — read offline, off the tags on the package's own `HEAD`.
const resolveToolSha = (
  revision: Option.Option<DispatcherRevision>,
  headReleases: Option.Option<ReadonlyArray<Release>>,
): ToolSha => {
  if (Option.isNone(revision)) {
    return emptyPin("this speepobox's revision could not be read");
  }
  if (revision.value.dirty) {
    return emptyPin(
      `this speepobox's source is dirty at ${revision.value.revision}, so no revision names what is running`,
    );
  }
  const { sha, revision: short } = revision.value;
  const unreleased = Option.exists(headReleases, (releases) =>
    Option.isNone(releaseAt(releases, sha)),
  );
  return {
    value: { value: sha, source: "package revision" },
    warning: unreleased
      ? Option.some(
          `tool-sha pins ${short}, and no v<N> tag points at it, so it is not a speepobox release — ` +
            "`upgrade` moves a pin only between releases",
        )
      : Option.none(),
  };
};

const isAlreadyExists = (error: PlatformError): boolean =>
  error._tag === "SystemError" && error.reason === "AlreadyExists";

// Answers with how many files drifted — missing or behind — or, for the shim,
// cannot run, which `bin.ts` turns into the exit status, as it does
// `doctor`'s failures. A write never drifts: it answers 0.
export const init = (
  options: InitOptions,
): Effect.Effect<number, InitRefused, Reporter | Git | FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const parsed = parseInitArgv(options.argv);
    if (Either.isLeft(parsed)) {
      return yield* parsed.left;
    }
    // `--diff` writes nothing, so it runs where `init` refuses (E9).
    if (parsed.right.diff) {
      const files = yield* scaffoldDrift(options);
      const reporter = yield* Reporter;
      yield* reporter.emit({
        _tag: "InitReported",
        snapshot: { _tag: "Diff", selfHosted: options.selfHosted, files },
      });
      return failureCount(files, options.selfHosted);
    }
    if (options.selfHosted) {
      return yield* new InitRefused({
        detail: `init refused: ${options.repoRoot} is the repo speepobox itself lives in, and it is not scaffolded — nothing was written`,
      });
    }
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const targets = SCAFFOLD.map((name) => ({
      name,
      shown: `${SPEEPOBOX_DIRNAME}/${name}`,
      at: path.join(options.repoRoot, SPEEPOBOX_DIRNAME, name),
    }));

    // Every existing target is looked at before anything is written, so a
    // directory where a file goes refuses with nothing written. An absent one
    // is `None`; a stat that fails otherwise refuses naming the path.
    const present = yield* Effect.forEach(targets, (target) =>
      fs.stat(target.at).pipe(
        Effect.map((info) => Option.some(info.type)),
        Effect.catchIf(
          (error) => error._tag === "SystemError" && error.reason === "NotFound",
          () => Effect.succeed(Option.none()),
        ),
        Effect.mapError(
          (error) =>
            new InitRefused({ detail: `init could not read ${target.shown}: ${error.message}` }),
        ),
        Effect.flatMap((type) =>
          Option.contains(type, "Directory")
            ? new InitRefused({
                detail: `init refused: ${target.shown} is a directory where init writes a file — nothing was written`,
              })
            : Effect.succeed(Option.isSome(type)),
        ),
      ),
    );

    // The values exist only for a `config.toml` this run will write (T127): a
    // kept one asks nothing, so the base's refusal is reached only where the
    // base would be written — and still before anything is.
    const configAbsent = !present[SCAFFOLD.indexOf(CONFIG)];
    const toolSha = resolveToolSha(options.dispatcherRevision, options.headReleases);
    const values: Option.Option<InitValues> = configAbsent
      ? Option.some({
          base: yield* resolveBase(options.repoRoot, parsed.right.base),
          image: Option.getOrElse(fromFlag(parsed.right.image), (): ResolvedValue => ({
            value: imageNameFor(basename(options.repoRoot)),
            source: "directory name",
          })),
          "tool-sha": toolSha.value,
        })
      : Option.none();

    // What each absent file is written with; a present one is kept, so it
    // has nothing to be written with.
    const contents = yield* Effect.forEach(targets, (target, index) =>
      present[index]
        ? Effect.succeed(Option.none<string>())
        : Effect.map(contentsOf(options.templatesRoot, target.name, values), Option.some),
    );

    // `wx` on top of the look above: a file that appeared in between is still
    // never opened for writing, and is as `kept` as one that was there first.
    // The shim is executed, so it is created 0755 — on this write, which is
    // the only one it ever gets: a kept shim's mode is never touched (T127).
    const written = yield* Effect.forEach(targets, (target, index) =>
      Option.match(contents[index]!, {
        onNone: () => Effect.succeed<InitFile>({ path: target.shown, action: "kept" }),
        onSome: (text) =>
          fs.makeDirectory(path.dirname(target.at), { recursive: true }).pipe(
            Effect.zipRight(
              fs.writeFileString(
                target.at,
                text,
                target.name === SHIM ? { flag: "wx", mode: 0o755 } : { flag: "wx" },
              ),
            ),
            Effect.as<InitFile>(
              target.name === CONFIG && Option.isSome(values)
                ? { path: target.shown, action: "wrote", values: values.value }
                : { path: target.shown, action: "wrote" },
            ),
            Effect.catchIf(isAlreadyExists, () =>
              Effect.succeed<InitFile>({ path: target.shown, action: "kept" }),
            ),
            Effect.mapError(
              (error) =>
                new InitRefused({
                  detail: `init could not write ${target.shown}: ${error.message}`,
                }),
            ),
          ),
      }),
    );

    // The pin's warning is only worth saying when this run wrote it: a kept
    // `config.toml` says whatever it already said.
    const configWritten = written.some(
      (file) => file.action === "wrote" && file.values !== undefined,
    );
    const reporter = yield* Reporter;
    yield* reporter.emit({
      _tag: "InitReported",
      snapshot: {
        _tag: "Write",
        files: written,
        warnings: configWritten ? Option.toArray(toolSha.warning) : [],
      },
    });
    return 0;
  });
