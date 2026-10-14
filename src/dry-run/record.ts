// The rehearsal, and the one move every layer in this directory makes: a
// mutating operation that says what it would have done instead of doing it
// (T15, 05 Q20).
//
// **The recording is the event stream.** Progress is a `Reporter` event (05),
// so an intent printed from inside a layer would be the second output path a
// dry run exists to delete — and the record it leaves has to be readable by
// the same subscribers everything else is: the console renders it, the run log
// summarizes it, and nothing is woken by it.
//
// **A recording layer keeps its reads real and records its mutations.** That
// is what makes the rehearsal honest: the `--base` chain still resolves, the
// existing-PR probe still answers, and every guard still fails for real —
// only the writes are held back. Where the live layer is the one that knows
// how to read, the recording layer is built *over* it (`Layer.provide`) rather
// than beside it, so a read cannot quietly become a second implementation.
import type { Effect } from "effect";
import type { ReporterShape } from "../reporter.ts";

// What a mutation says it would have done. The phrasing is the operation's
// own, in the vocabulary of its tag: "start the sandbox …", "clone … into …",
// never the argv underneath, because a dry run rehearses this package's logic
// and not docker's (05 Q20's caveat).
export const recorded = (reporter: ReporterShape, detail: string): Effect.Effect<void> =>
  reporter.emit({ _tag: "MutationRecorded", detail });
