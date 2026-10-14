// `Ledger`, recording (T15): the row is said, not written, and every read goes
// through to the live layer — so `runs.jsonl` is byte-identical afterwards and
// the `--base` default chain still resolves off what is in it. That chain is
// the reason this layer is built over `LedgerLive` rather than standing alone:
// a rehearsal whose base came from somewhere else would rehearse a different
// run than the one a dispatch would make.
//
// `resolveResume` is a read like the other two (T16): a resumed dry run
// recovers its spec, its base, and its identity from the same record a real
// resume would.
import type { FileSystem, Path } from "@effect/platform";
import { Effect, Layer, Option } from "effect";
import type { SpeepoboxConfig } from "../config/config.ts";
import { Ledger, LedgerLive, type LedgerShape } from "../ledger/ledger.ts";
import type { RunRecord } from "../ledger/record.ts";
import { Reporter, type ReporterShape } from "../reporter.ts";
import { recorded } from "./record.ts";

// What the row would have said, in the two fields a dispatcher reads it for:
// why the run stopped, and what the review decided (SPEC §10). The row itself
// is a value the run already built — nothing here re-derives one.
const rowDetail = (record: RunRecord): string => {
  const reason = Option.match(record.terminalReason, {
    onNone: () => "no terminal reason",
    onSome: (terminal) => terminal._tag.toLowerCase(),
  });
  const outcome = Option.match(record.outcome, {
    onNone: () => "",
    onSome: (verdict) => `, ${verdict}`,
  });
  return `append the terminal row for '${record.branch}' to the ledger: ${reason}${outcome}`;
};

export const recordingLedger = (live: LedgerShape, reporter: ReporterShape): LedgerShape => ({
  ...live,
  append: (record) => recorded(reporter, rowDetail(record)),
});

export const LedgerRecordingLive: Layer.Layer<
  Ledger,
  never,
  SpeepoboxConfig | Reporter | FileSystem.FileSystem | Path.Path
> = Layer.effect(
  Ledger,
  Effect.map(Effect.all([Ledger, Reporter]), ([live, reporter]) => recordingLedger(live, reporter)),
).pipe(Layer.provide(LedgerLive));
