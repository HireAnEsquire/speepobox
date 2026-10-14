// `Prompt`, recording (T102): the rehearsal's answer to the one question a
// dispatch asks — `--hard-reset`'s confirm (D4). A rehearsal resets nothing,
// so there is nothing to consent to, and blocking a dry run on a question
// about a discard it will not perform would ask the dispatcher to decide
// something that decides nothing. So `confirm` records what a real run would
// have asked and answers yes, and the guard that asked it never learns which
// layer it was talking to (T15).
//
// There is nothing to keep real: an ask is a question put to a person, which
// is the one thing a rehearsal exists not to need. And the dispatch surface
// asks nothing else — every other member is the picker's, which runs before
// either composition is built — so a dispatch reaching one is our own broken
// invariant, and dies saying so.
import { Effect, Layer } from "effect";
import { Prompt, type PromptShape } from "../prompt/prompt.ts";
import { Reporter, type ReporterShape } from "../reporter.ts";
import { recorded } from "./record.ts";

const neverAsked = (member: string): Effect.Effect<never> =>
  Effect.die(
    `Prompt.${member} in a rehearsal: a dispatch asks nothing but --hard-reset's confirm (T102)`,
  );

export const recordingPrompt = (reporter: ReporterShape): PromptShape => ({
  select: () => neverAsked("select"),
  autocomplete: () => neverAsked("autocomplete"),
  multiselect: () => neverAsked("multiselect"),
  confirm: ({ message }) => recorded(reporter, `ask: ${message}`).pipe(Effect.as(true)),
  text: () => neverAsked("text"),
  note: () => neverAsked("note"),
});

export const PromptRecordingLive: Layer.Layer<Prompt, never, Reporter> = Layer.effect(
  Prompt,
  Effect.map(Reporter, recordingPrompt),
);
