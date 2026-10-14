// `InitSnapshot` — what `init` did, as a value (SPEC §5: ops as library, CLI
// as renderer), shaped as `gc`'s is. The command gathers this; the renderer
// is a pure function over it. One event, two variants: what a write did, and
// what `--diff` found (T116) — a diff variant rather than a second event
// family.
import { Schema } from "effect";
import { SHIM } from "./stamp.ts";
import { ResolvedValue } from "./values.ts";

// Only absent files are written (E4): a file already there is never opened
// for writing, so every file is exactly one of the two.
export const InitAction = Schema.Literal("wrote", "kept");
export type InitAction = Schema.Schema.Type<typeof InitAction>;

// The three values `config.toml` is written with, each beside where it came
// from (T115). Worked out only when `config.toml` is absent (T127): a kept
// file asks nothing (E4), so a repo with no `origin/HEAD` is not refused a
// base it would never write.
export const InitValues = Schema.Struct({
  base: ResolvedValue,
  image: ResolvedValue,
  "tool-sha": ResolvedValue,
});
export type InitValues = Schema.Schema.Type<typeof InitValues>;

// One file, keyed on what happened to it. Only a write can carry values — the
// written `config.toml`'s, which the renderer shows on its `wrote` line — so a
// kept config has none to show, by its shape (T127).
export const InitFile = Schema.Union(
  Schema.Struct({
    // The file's path relative to the served repo's root, `/`-separated.
    path: Schema.String,
    action: Schema.Literal("kept"),
  }),
  Schema.Struct({
    path: Schema.String,
    action: Schema.Literal("wrote"),
    values: Schema.optionalWith(InitValues, { exact: true }),
  }),
);
export type InitFile = Schema.Schema.Type<typeof InitFile>;

export const InitWrite = Schema.TaggedStruct("Write", {
  files: Schema.Array(InitFile),
  // At most one today: the pin written empty, and why (T115).
  warnings: Schema.Array(Schema.String),
});
export type InitWrite = Schema.Schema.Type<typeof InitWrite>;

// A stamped file against the template this package ships (T116). `behind`
// covers a file with no stamp, read as version 0, and a stamp naming another
// template than the path it sits at.
export const DriftState = Schema.Literal("missing", "current", "behind");
export type DriftState = Schema.Schema.Type<typeof DriftState>;

export const StampedDrift = Schema.TaggedStruct("Stamped", {
  path: Schema.String,
  // The template's name under `templates/`, and where it is on this host.
  template: Schema.String,
  templatePath: Schema.String,
  state: DriftState,
  // Whether the body no longer hashes to its own stamp. An unstamped file is
  // edited; a missing one is not.
  edited: Schema.Boolean,
  // 0 when the file carries no stamp.
  stampVersion: Schema.Number,
  templateVersion: Schema.Number,
  stamped: Schema.Boolean,
  // The name the stamp carries, when it is not this path's template.
  stampedAs: Schema.OptionFromSelf(Schema.String),
  // A present shim without its owner's execute bit (T127). Only the shim is
  // asked, since no other scaffold file is executed. The adopter's change, not
  // drift — but the shim cannot run, so it fails `--diff` all the same.
  notExecutable: Schema.Boolean,
  // The current template against the file, for a `behind` file; `""`
  // otherwise.
  diff: Schema.String,
});
export type StampedDrift = Schema.Schema.Type<typeof StampedDrift>;

// `config.toml` is checked for presence only: probe 7 judges what is in it,
// and a file of adopter-owned values has no drift.
export const PresenceDrift = Schema.TaggedStruct("Presence", {
  path: Schema.String,
  present: Schema.Boolean,
});
export type PresenceDrift = Schema.Schema.Type<typeof PresenceDrift>;

export const DriftFile = Schema.Union(StampedDrift, PresenceDrift);
export type DriftFile = Schema.Schema.Type<typeof DriftFile>;

export const InitDiff = Schema.TaggedStruct("Diff", {
  // A self-hosted repo is not scaffolded, so its remedy names the template
  // rather than `rm … && .speepobox/speepobox init` or the shim's `mv`.
  selfHosted: Schema.Boolean,
  files: Schema.Array(DriftFile),
});
export type InitDiff = Schema.Schema.Type<typeof InitDiff>;

export const InitSnapshot = Schema.Union(InitWrite, InitDiff);
export type InitSnapshot = Schema.Schema.Type<typeof InitSnapshot>;

// Drift is a file that is missing or behind; `edited` alone never is.
export const isDrift = (file: DriftFile): boolean =>
  file._tag === "Presence" ? !file.present : file.state !== "current";

// A self-hosted repo runs `node src/bin.ts` and has no shim by design (E12),
// so its absence there is the expected state: listed, never counted.
export const isSelfHostedShim = (file: DriftFile, selfHosted: boolean): boolean =>
  selfHosted && file._tag === "Stamped" && file.template === SHIM && file.state === "missing";

// What `--diff` counts as drift: every drifted file but the shim a
// self-hosted repo has no use for.
export const countsAsDrift = (file: DriftFile, selfHosted: boolean): boolean =>
  isDrift(file) && !isSelfHostedShim(file, selfHosted);

export const isNotExecutable = (file: DriftFile): boolean =>
  file._tag === "Stamped" && file.notExecutable;
