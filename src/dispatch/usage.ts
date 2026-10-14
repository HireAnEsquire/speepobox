// What the run cost, folded out of the event stream (T53). bash summed the
// `claude $ usage` lines its filter left in the log (`run.sh:2188-2210`);
// nothing here re-parses a file. SPEC §10 says the row is derivable from the
// `Reporter` stream, and every pass's cost travels on `AgentPassFinished` —
// and on `PassFailed` where a result arrived (T55) — so the row's figures are
// a fold over the same events the log renders.
//
// **The four counts stay apart.** Bash stored one pre-summed `tokens`, and on
// a real run the cache reads are ~98% of it, so the sum alone cannot say what
// a run burned. Adding them is `status`'s job and stays reversible.
import { Effect, Option, Ref } from "effect";
import type { PassUsage } from "../agent/stream.ts";
import type { ReporterEvent, ReporterShape } from "../reporter.ts";

// The run's side of a pass's `PassUsage`: the four counts added over the
// passes that reported one, how many those were, and every model they named.
export interface RunUsage {
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly cacheWrite: number;
  readonly cacheRead: number;
  readonly passes: number;
  readonly models: ReadonlyArray<string>;
}

// A pass reported usage when it reported a count: bash's filter leaves a
// `claude $ usage` line in the log only where a `result` event arrived, and
// every one of those carries figures. Four zeros is what a pass that never
// spoke to a model answers with — a rehearsal's recording `AgentCli`, a fake —
// and counting it would put a denominator on the row with no numerator under
// it, which reads as a pass that cost nothing rather than as one nobody
// measured (`tasklib.py:691`).
const reportedUsage = (usage: PassUsage): boolean =>
  usage.input + usage.output + usage.cacheWrite + usage.cacheRead > 0;

// The two events a cost travels on, and no third. A killed pass, a lost
// sandbox, and a stream that ended without a result carry no usage at all and
// are counted nowhere — so a run made only of those writes none of the six
// fields rather than six zeros.
export const passUsageOf = (event: ReporterEvent): Option.Option<PassUsage> => {
  const reported =
    event._tag === "AgentPassFinished"
      ? Option.some(event.usage)
      : event._tag === "PassFailed"
        ? event.usage
        : Option.none<PassUsage>();
  return Option.filter(reported, reportedUsage);
};

// One pass added to the run's total. `models` is a union in first-seen order
// rather than a concatenation: **one pass can report more than one model**
// (`models=claude-haiku-4-5-20251001,claude-opus-5`), and the same model
// answers for every pass of an ordinary run.
export const addPassUsage = (total: Option.Option<RunUsage>, usage: PassUsage): RunUsage => {
  const before = Option.getOrElse(total, (): RunUsage => ({
    tokensIn: 0,
    tokensOut: 0,
    cacheWrite: 0,
    cacheRead: 0,
    passes: 0,
    models: [],
  }));
  return {
    tokensIn: before.tokensIn + usage.input,
    tokensOut: before.tokensOut + usage.output,
    cacheWrite: before.cacheWrite + usage.cacheWrite,
    cacheRead: before.cacheRead + usage.cacheRead,
    passes: before.passes + 1,
    models: usage.models.reduce<ReadonlyArray<string>>(
      (seen, model) => (seen.includes(model) ? seen : [...seen, model]),
      before.models,
    ),
  };
};

// The fold, as the subscriber shape the run log and the step notifier already
// use (`run-log.ts`, `notify/notifications.ts`): it takes the subscriber
// underneath it and returns one that tees, so every event still reaches the
// console and the log and no step of the dispatch knows a tally exists.
export const withUsageTally = (
  tally: Ref.Ref<Option.Option<RunUsage>>,
  next: ReporterShape,
): ReporterShape => ({
  emit: (event) =>
    next.emit(event).pipe(
      Effect.zipRight(
        Option.match(passUsageOf(event), {
          onNone: () => Effect.void,
          onSome: (usage) => Ref.update(tally, (total) => Option.some(addPassUsage(total, usage))),
        }),
      ),
    ),
});

// The six record fields, written together or not at all. They are built here
// rather than spelled out at the row because all six answer one question, and
// a run with no usage-bearing event has to leave every one of them absent —
// six `Option.map`s at the call site is six chances to fill one in.
export interface RunUsageFields {
  readonly tokensIn: Option.Option<number>;
  readonly tokensOut: Option.Option<number>;
  readonly cacheWrite: Option.Option<number>;
  readonly cacheRead: Option.Option<number>;
  readonly passes: Option.Option<number>;
  readonly models: Option.Option<ReadonlyArray<string>>;
}

export const usageFields = (usage: Option.Option<RunUsage>): RunUsageFields => ({
  tokensIn: Option.map(usage, (total) => total.tokensIn),
  tokensOut: Option.map(usage, (total) => total.tokensOut),
  cacheWrite: Option.map(usage, (total) => total.cacheWrite),
  cacheRead: Option.map(usage, (total) => total.cacheRead),
  passes: Option.map(usage, (total) => total.passes),
  models: Option.map(usage, (total) => total.models),
});
