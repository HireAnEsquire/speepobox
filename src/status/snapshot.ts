// `StatusSnapshot` — the domain value `status` returns (SPEC §5: ops as
// library, CLI as renderer). The command produces this; the renderer is a
// pure function over it, and a future frontend gets JSON for free.
//
// Both halves are tagged unions rather than nullable fields, because
// degradation is the point of this screen: the daemon can be down while the
// ledger reads fine, and vice versa, and each half says so in place.
import { Schema } from "effect";
import { RunRecord } from "../ledger/record.ts";

// Whether a dispatcher still owns a running container (T138), as the
// reconciler's `classify` answers it — `status` asks that function and never a
// predicate of its own. `OwnedBy` is a lock naming a live pid; `OwnerGone` is a
// lock whose owner is not alive or cannot be named, which the next dispatch
// preflight in this repo reclaims; `NoLock` is a container no lock in this
// runtime root names, which the reconciler reports and never removes.
export const ContainerOwner = Schema.Union(
  Schema.TaggedStruct("OwnedBy", { pid: Schema.Int }),
  Schema.TaggedStruct("OwnerGone", {}),
  Schema.TaggedStruct("NoLock", {}),
);
export type ContainerOwner = Schema.Schema.Type<typeof ContainerOwner>;

export const RunningContainer = Schema.Struct({
  // Rendered for humans only. Nothing keys ownership off it — that is what
  // the labels are for.
  name: Schema.String,
  uptime: Schema.String,
  owner: ContainerOwner,
});
export type RunningContainer = Schema.Schema.Type<typeof RunningContainer>;

export const ContainerHalf = Schema.Union(
  Schema.TaggedStruct("Containers", { running: Schema.Array(RunningContainer) }),
  Schema.TaggedStruct("ContainersUnavailable", { detail: Schema.String }),
);
export type ContainerHalf = Schema.Schema.Type<typeof ContainerHalf>;

export const LedgerHalf = Schema.Union(
  Schema.TaggedStruct("Runs", { recent: Schema.Array(RunRecord) }),
  Schema.TaggedStruct("LedgerUnavailable", { detail: Schema.String }),
);
export type LedgerHalf = Schema.Schema.Type<typeof LedgerHalf>;

export const StatusSnapshot = Schema.Struct({
  containers: ContainerHalf,
  ledger: LedgerHalf,
  limit: Schema.Int,
  // Epoch milliseconds, read from `Clock` by the command, so ages render
  // from a value the test can control rather than from wall time.
  renderedAt: Schema.Number,
});
export type StatusSnapshot = Schema.Schema.Type<typeof StatusSnapshot>;
