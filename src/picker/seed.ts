// Flags seed the wizard (T86, SPEC §7): what a command line that left an
// answer out already said, as the picker's starting draft. The entrypoint
// catches an `AnswerMissing` and asks `seedOf` whether to open the picker.
// The decision is here rather than in `bin.ts` because nothing there can be
// asserted (AGENTS.md).
//
// **The seed is the answers, not the words.** The picker rebuilds the step
// words from its draft, so a flag value edited in the wizard appears once, as
// edited. Only the flags that are not steps ride through as words.
import { Option } from "effect";
import { type DispatchRequest, issuesRequested } from "../dispatch/dispatch.ts";
import type { AnswerMissing } from "../dispatch/guards.ts";
import { ALL_READY, type IssuesPick } from "./picker.ts";

// The source a command line named, as typed. A resume is never here: it names
// its own branch, and its base comes off the record, so a dispatch with
// `--resume` or `--last` is never missing an answer.
export type SeedSource =
  | { readonly _tag: "Spec"; readonly spec: string }
  | { readonly _tag: "Feature"; readonly folder: string }
  | { readonly _tag: "Task"; readonly task: string };

export interface Seed {
  readonly source: Option.Option<SeedSource>;
  readonly branch: Option.Option<string>;
  readonly issues: Option.Option<IssuesPick>;
  // Typed `--base`. It stays in the words even when it equals the chain
  // default, because the dispatcher typed it.
  readonly base: Option.Option<string>;
  // Whether `--feedback` or `--feedback-edit` was typed. A task and feedback
  // are two texts, so the source step hides `Task typed inline`, and a resume
  // picked there asks for no second feedback.
  readonly feedback: boolean;
  // The flags that are not steps, rendered from the request: `--feedback`,
  // `--feedback-edit`, `--allow-stale-dispatcher`, and `--hard-reset` (T101). The one modifier is the
  // entrypoint's to render (`app.ts`), since this module may not name it.
  readonly words: ReadonlyArray<string>;
}

// A flag that holds nothing named nothing, and answers no step.
const named = (value: Option.Option<string>): Option.Option<string> =>
  Option.filter(value, (text) => text.trim() !== "");

export const seedFor = (request: DispatchRequest): Seed => {
  const source: Option.Option<SeedSource> = Option.orElse(
    Option.map(named(request.feature), (folder) => ({ _tag: "Feature", folder }) as const),
    () =>
      Option.orElse(
        Option.map(named(request.task), (task) => ({ _tag: "Task", task }) as const),
        () => Option.map(named(request.spec), (spec) => ({ _tag: "Spec", spec }) as const),
      ),
  );
  const feedback = named(request.feedback);
  return {
    source,
    branch: named(request.branch),
    issues: Option.map(issuesRequested(request.issues), (asked): IssuesPick =>
      asked._tag === "All" ? ALL_READY : asked.ids,
    ),
    base: named(request.base),
    feedback: Option.isSome(feedback) || request.feedbackEdit,
    words: [
      ...Option.match(feedback, {
        onNone: (): ReadonlyArray<string> => [],
        onSome: () => ["--feedback", Option.getOrElse(request.feedback, () => "")],
      }),
      ...(request.feedbackEdit ? ["--feedback-edit"] : []),
      ...(request.allowStaleDispatcher ? ["--allow-stale-dispatcher"] : []),
      ...(request.hardReset ? ["--hard-reset"] : []),
    ],
  };
};

// Whether a missing answer is asked about at all. With `--no-input` it is
// not: the refusal is reported and the picker is never asked. Off a terminal
// the picker's own gate answers `None`, and the entrypoint reports the same
// refusal (T81).
export const seedOf = (missing: AnswerMissing): Option.Option<Seed> =>
  missing.request.noInput === true ? Option.none() : Option.some(seedFor(missing.request));
