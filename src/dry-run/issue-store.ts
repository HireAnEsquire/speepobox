// `IssueStore`, recording (T15, T71, T77). **The two reads stay real** — a
// recording layer keeps its reads real, and it is built over the live layer
// wherever that tag has one (AGENTS.md) — and the one write says what it would
// have done instead of doing it.
//
// The override is load-bearing in a way the other recording layers' are not.
// This layer is `{ ...live }` over a store that **carries its own `GitLive`**
// (`issues/issue-store.ts` provides it inside), so the `Git` swap in
// `appDryRunLiveFor` does not reach inside it: a `markLanded` this file forgot
// to name would write objects and move a ref in a rehearsal. That is why
// `test/dry-run.test.ts` pins the override as an inequality, the mirror of the
// identity it pins on T70's deliberate pass-through.
import type { CommandExecutor, FileSystem } from "@effect/platform";
import { Effect, Layer, Option } from "effect";
import { IssueStore, IssueStoreLive, type IssueStoreShape } from "../issues/issue-store.ts";
import { Reporter, type ReporterShape } from "../reporter.ts";
import { recorded } from "./record.ts";

export const recordingIssueStore = (
  live: IssueStoreShape,
  reporter: ReporterShape,
): IssueStoreShape => ({
  ...live,
  // In the tag's vocabulary and not git's (05 Q20): which issues would have
  // been marked, and on which branch — never the six children that would have
  // done it. The answer is `None` for the reason a real store answers `None`
  // when it wrote nothing: there is no commit, and a synthesized sha would be
  // a rehearsal naming an object no repository holds.
  markLanded: ({ branch, stems }) =>
    recorded(reporter, `mark ${stems.join(" ")} Done on '${branch}'`).pipe(
      Effect.as(Option.none()),
    ),
});

export const IssueStoreRecordingLive: Layer.Layer<
  IssueStore,
  never,
  CommandExecutor.CommandExecutor | FileSystem.FileSystem | Reporter
> = Layer.effect(
  IssueStore,
  Effect.map(Effect.all([IssueStore, Reporter]), ([live, reporter]) =>
    recordingIssueStore(live, reporter),
  ),
).pipe(Layer.provide(IssueStoreLive));
