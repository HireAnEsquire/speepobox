// `GcSnapshot` — the domain value `gc` lists (SPEC §5: ops as library, CLI as
// renderer), shaped as `status`'s is. The command gathers this; the renderer
// is a pure function over it.
//
// What `--force` would do with each resource is decided here, as a value,
// rather than in the renderer: it is a fact about the classification
// (`wreckage.ts`), and T100 acts on the same verdicts this lists.
import { Schema } from "effect";

// A figure that has three answers rather than two: measured, asked and not
// answerable (`?` — an entry that could not be stat'd, or an absent `mtime`),
// and not a question for this kind of resource at all (`-`, bash's column
// for a size that does not apply).
export const Measure = Schema.Union(
  Schema.TaggedStruct("Measured", { value: Schema.Number }),
  Schema.TaggedStruct("Unmeasured", {}),
  Schema.TaggedStruct("NotApplicable", {}),
);
export type Measure = Schema.Schema.Type<typeof Measure>;

export const GcResourceKind = Schema.Literal("container", "checkout", "lock");
export type GcResourceKind = Schema.Schema.Type<typeof GcResourceKind>;

export const GcResource = Schema.Struct({
  kind: GcResourceKind,
  // Epoch milliseconds of the entry's `mtime`. A container is not an entry
  // on this host's disk, so its age is `NotApplicable`.
  modifiedAt: Measure,
  // Bytes: a recursive sum for a checkout, `NotApplicable` elsewhere.
  size: Measure,
  would: Schema.String,
});
export type GcResource = Schema.Schema.Type<typeof GcResource>;

// `classify`'s answer, carried as a value so the snapshot says why a slug is
// listed the way it is.
export const GcVerdict = Schema.Union(
  Schema.TaggedStruct("Reclaimable", {}),
  Schema.TaggedStruct("Kept", { detail: Schema.String }),
  Schema.TaggedStruct("Live", { detail: Schema.String }),
);
export type GcVerdict = Schema.Schema.Type<typeof GcVerdict>;

export const GcSlug = Schema.Struct({
  slug: Schema.String,
  verdict: GcVerdict,
  // In the order a run releases: container, checkout, lock.
  resources: Schema.Array(GcResource),
});
export type GcSlug = Schema.Schema.Type<typeof GcSlug>;

export const GcWitness = Schema.Struct({
  path: Schema.String,
  slug: Schema.String,
  modifiedAt: Measure,
});
export type GcWitness = Schema.Schema.Type<typeof GcWitness>;

// What a run strands beside the classes bash knew (T108): the claim's temp
// file and the status commit's scratch index in `locks/`, and the editor's
// session directory at the runtime root's top. None blocks anything, so the
// reconciler leaves them; `gc` is where a human reads them.
export const GcLeftoverKind = Schema.Literal("claim", "index", "editor");
export type GcLeftoverKind = Schema.Schema.Type<typeof GcLeftoverKind>;

// Judged by a witness the name carries, never by age: `dead` is a witness
// that says nobody is using it, and `unwitnessed` is an editor directory from
// before the pid was in its name, which nothing can vouch for either way. A
// live one is in use, not left over, and is not listed at all.
export const GcLeftoverState = Schema.Literal("dead", "unwitnessed");
export type GcLeftoverState = Schema.Schema.Type<typeof GcLeftoverState>;

export const GcLeftover = Schema.Struct({
  kind: GcLeftoverKind,
  path: Schema.String,
  // The slug for a claim or an index, off the name; none for an editor directory.
  slug: Schema.Option(Schema.String),
  modifiedAt: Measure,
  state: GcLeftoverState,
});
export type GcLeftover = Schema.Schema.Type<typeof GcLeftover>;

// One line, never one row per log: every run leaves a log behind forever, so
// per-log rows would drown the classes `gc` can act on (`tasklib.py`'s
// `summarize_logs`).
export const GcLogs = Schema.Struct({
  count: Schema.Int,
  bytes: Measure,
});
export type GcLogs = Schema.Schema.Type<typeof GcLogs>;

export const GcSnapshot = Schema.Struct({
  // Whether `ownedSandboxes` answered. `false` is "dockerd could not be
  // asked", which is not "it holds nothing": no container rows are listed,
  // because no query ran, and liveness is unverified for everything else.
  daemonAnswered: Schema.Boolean,
  slugs: Schema.Array(GcSlug),
  witnesses: Schema.Array(GcWitness),
  leftovers: Schema.Array(GcLeftover),
  logs: GcLogs,
  // Epoch milliseconds, read from `Clock`, so ages render from a value a test
  // controls rather than from wall time.
  renderedAt: Schema.Number,
});
export type GcSnapshot = Schema.Schema.Type<typeof GcSnapshot>;
