// `Forge`, recording (T15): the view is real and the two writes record. Built
// over `ForgeLive` for exactly that reason — the existing-PR probe is what
// decides create-vs-update, and it is the one question a run asks a forge that
// has no local oracle, so a rehearsal that answered it itself would rehearse
// the wrong half of `run.sh:1714-1722`. bash's dry run reimplements this probe
// (`run.sh:2323-2340`); this is the same call the land makes, because it *is*
// the land's call.
import type { CommandExecutor } from "@effect/platform";
import { Effect, Layer, Option } from "effect";
import { baseBranch, Forge, ForgeLive, type ForgeShape } from "../forge/forge.ts";
import type { PullRequest } from "../ledger/record.ts";
import { Reporter, type ReporterShape } from "../reporter.ts";
import { recorded } from "./record.ts";

// What a draft that was never opened answers with. `prCreate` owes its caller
// a `PullRequest` — the value the run reports and the row records — and there
// is no URL to give: the forge was never asked. It says so in the field a
// reader looks at, rather than in a plausible-looking URL nobody can open.
export const RECORDED_PR: PullRequest = {
  number: Option.none(),
  url: "(dry run — no pull request was opened)",
};

export const recordingForge = (live: ForgeShape, reporter: ReporterShape): ForgeShape => ({
  ...live,
  prCreate: ({ branch, base, title }) =>
    recorded(
      reporter,
      `open a draft PR for '${branch}' into '${baseBranch(base)}', titled '${title}'`,
    ).pipe(Effect.as(RECORDED_PR)),
  // The body is not in the line for the reason it is not in the command line
  // (`forge/forge.ts`): it is arbitrary markdown an agent wrote, and the pass
  // that wrote it already narrated it.
  prEdit: ({ branch }) => recorded(reporter, `replace the body of the PR for '${branch}'`),
});

export const ForgeRecordingLive: Layer.Layer<
  Forge,
  never,
  CommandExecutor.CommandExecutor | Reporter
> = Layer.effect(
  Forge,
  Effect.map(Effect.all([Forge, Reporter]), ([live, reporter]) => recordingForge(live, reporter)),
).pipe(Layer.provide(ForgeLive));
