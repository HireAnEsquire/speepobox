// `Notifier`, recording (T15): a desktop notification is a mutation of the
// dispatcher's attention, and a rehearsal that raised one would tell somebody a
// run they never started had finished. There is nothing to keep real — `notify`
// is the whole tag — so this layer stands on its own.
//
// What it would have said is recorded verbatim, title and body, because that
// is the assertion the tag exists for (AGENTS.md: a live layer that read the
// level and returned `void` makes the one thing this tag is for unassertable).
// The **caller** still decides whether to notify at all: `notify = off` means
// this is never invoked, in a rehearsal exactly as in a run.
import { Effect, Layer } from "effect";
import { Notifier, type NotifierShape } from "../notify/notifier.ts";
import { Reporter, type ReporterShape } from "../reporter.ts";
import { recorded } from "./record.ts";

export const recordingNotifier = (reporter: ReporterShape): NotifierShape => ({
  notify: ({ title, body }) => recorded(reporter, `notify: ${title} — ${body}`),
});

export const NotifierRecordingLive: Layer.Layer<Notifier, never, Reporter> = Layer.effect(
  Notifier,
  Effect.map(Reporter, recordingNotifier),
);
