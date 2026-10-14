// The TTY bracket (T81 §5), which is the one thing the scripted `Prompt` fake
// cannot hold: that a **live** clack prompt unwinds when the fiber running it
// is interrupted. It is a fake-tier case anyway, because clack takes `input`
// and `output` streams on `CommonOptions` — so the prototype's wedge scenario
// C runs over a `PassThrough` under `npm run verify`, with no terminal
// anywhere.
//
// The regression it exists for is silent and terminal-wedging: 13 measured
// that without the signal the promise stays pending forever, the keypress
// listener leaks, and the dead prompt **keeps consuming and rendering
// keystrokes** — and that 05's priced mitigation (an `acquireRelease`
// restoring raw mode by hand) restores the terminal and leaves that zombie
// exactly as it was. Nothing about that is visible from a return value, which
// is why this case asserts the listeners on the stream rather than the answer.
import { PassThrough } from "node:stream";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Fiber, Option } from "effect";
import { promptClackLive } from "../src/prompt/clack.ts";
import { type AutocompleteRequest, Prompt, type PromptRow } from "../src/prompt/prompt.ts";

const ROWS = [
  { value: "T80", label: "T80" },
  { value: "T81", label: "T81" },
];

// A prompt opened on a pair of pipes, left open, and interrupted where it
// stands. The sleep is what makes it *while open*: the fiber has to reach
// clack's own `prompt()` and have its keypress listener attached before the
// interrupt arrives, or the case would be asserting about a prompt that never
// opened.
const interruptedWhileOpen = (input: PassThrough, output: PassThrough) =>
  Effect.gen(function* () {
    const prompt = yield* Prompt;
    const fiber = yield* Effect.fork(prompt.select({ message: "which spec?", rows: ROWS }));
    yield* Effect.sleep("50 millis");
    const opened = input.listenerCount("keypress");
    return { opened, exit: yield* Fiber.interrupt(fiber) };
  }).pipe(Effect.provide(promptClackLive({ input, output })));

describe("PromptClackLive under fiber interrupt", () => {
  it.live("ends interrupted and leaves no keypress listener on the input", () =>
    Effect.gen(function* () {
      const input = new PassThrough();
      const output = new PassThrough();
      output.resume();

      const { opened, exit } = yield* interruptedWhileOpen(input, output);

      // The prompt really was open and listening when the interrupt arrived —
      // clack's own handler and the readline interface's, which is a count
      // this asserts nothing about beyond its not being zero.
      expect(opened).toBeGreaterThan(0);
      // And the effect *ended*: scenario A's promise is still pending here,
      // which under `Effect.promise` is a fiber that never completes.
      expect(Exit.isInterrupted(exit)).toBe(true);
      // The zombie's own signature: a dead prompt still on the stream, eating
      // and rendering every key the next one was meant to get.
      expect(input.listenerCount("keypress")).toBe(0);
      // Nothing of the prompt's remains attached in either direction.
      expect(input.listenerCount("readable")).toBe(0);
      expect(output.listenerCount("resize")).toBe(0);
    }),
  );

  // The one listener that does survive, named here so it is not read as a
  // leak the case above missed: `readline.emitKeypressEvents` installs a
  // single keypress decoder per stream, guarded by a symbol on the stream
  // itself, and removes it on no path — not on interrupt, and not on an
  // ordinary submit either. It is therefore a constant rather than something
  // that accumulates, which is what this asserts: two interrupted prompts on
  // one stream leave the same one listener a single completed prompt would.
  it.live("accumulates nothing across prompts on the same stream", () =>
    Effect.gen(function* () {
      const input = new PassThrough();
      const output = new PassThrough();
      output.resume();

      yield* interruptedWhileOpen(input, output);
      const afterOne = input.listenerCount("data");
      yield* interruptedWhileOpen(input, output);

      expect(afterOne).toBe(1);
      expect(input.listenerCount("data")).toBe(afterOne);
      expect(input.listenerCount("keypress")).toBe(0);
    }),
  );
});

// The rows a branch step offers, cut down to the three kinds that decide what
// Enter may do: one pickable, one `disabled`, and the way back. The getter
// filters by substring rather than ranking — what ranks is `rankFuzzy`'s
// (T80) and is asserted there; what this file is about is what clack does
// with the answer.
const BRANCHES: ReadonlyArray<PromptRow<string>> = [
  { value: "back", label: "← Back" },
  { value: "main", label: "⛔ PROTECTED — main", disabled: true },
  { value: "speepobox-t81", label: "speepobox-t81" },
];

const matching = (query: string): ReadonlyArray<PromptRow<string>> =>
  query === "" ? BRANCHES : BRANCHES.filter((row) => row.label.includes(query));

// A live autocomplete over a pair of pipes, with each burst of keys typed a
// beat apart: the fiber has to be inside clack's own `prompt()` before the
// first one lands, and clack re-reads the getter between them.
const typedInto = (keys: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const input = new PassThrough();
    const output = new PassThrough();
    output.resume();
    const fiber = yield* Effect.fork(
      Effect.flatMap(Prompt, (prompt) =>
        prompt.autocomplete({ message: "which branch?", rows: matching }),
      ).pipe(Effect.provide(promptClackLive({ input, output }))),
    );
    yield* Effect.sleep("50 millis");
    for (const key of keys) {
      yield* Effect.sync(() => input.write(key));
      yield* Effect.sleep("50 millis");
    }
    return fiber;
  });

// Enter with nothing focused. clack answers `undefined` for it — not its
// cancel sentinel, so `isCancel` is no help — and `Prompt`'s
// `Effect<A, PromptCancelled>` has nowhere to put that: the picker's branch
// step would hand the word on as the value of `--branch`. The guard keeps the
// prompt open on that keystroke, which is what the list is already saying.
describe("PromptClackLive's autocomplete", () => {
  it.live("answers with the row a query left focused", () =>
    Effect.gen(function* () {
      const fiber = yield* typedInto(["speepobox", "\r"]);

      expect(yield* Fiber.join(fiber)).toBe("speepobox-t81");
    }),
  );

  it.live("will not submit a query no row matches, and picks once it is cleared", () =>
    Effect.gen(function* () {
      const fiber = yield* typedInto(["zzz", "\r"]);

      // Still open: the prompt took the keystroke as an error rather than as
      // an answer, so there is nothing to poll yet.
      expect(yield* Fiber.poll(fiber)).toEqual(Option.none());

      // And backspacing the query away restores the at-rest list, whose first
      // row is the way back — so the refusal costs the dispatcher a keystroke
      // rather than the step.
      const cleared = yield* typedInto(["zzz", "\r", "\u007f\u007f\u007f", "\r"]);
      expect(yield* Fiber.join(cleared)).toBe("back");

      yield* Fiber.interrupt(fiber);
    }),
  );

  // The other half of the same hole, and the one the disabled rows open: a
  // query whose every match is unpickable focuses nothing either.
  it.live("will not submit a query whose every match is disabled", () =>
    Effect.gen(function* () {
      const fiber = yield* typedInto(["PROTECTED", "\r"]);

      expect(yield* Fiber.poll(fiber)).toEqual(Option.none());

      yield* Fiber.interrupt(fiber);
    }),
  );
});

// The two things T82 grew the tag: a row the cursor starts on, mapped onto
// clack's own `initialValue`, and a query no row matches taken as typed iff a
// read says it may be.
const openWith = (
  request: Partial<AutocompleteRequest<string>>,
  keys: ReadonlyArray<string>,
  accepted: ReadonlyArray<string> = [],
) =>
  Effect.gen(function* () {
    const input = new PassThrough();
    const output = new PassThrough();
    output.resume();
    const fiber = yield* Effect.fork(
      Effect.flatMap(Prompt, (prompt) =>
        prompt.autocomplete({
          message: "which base?",
          rows: matching,
          asIs: {
            row: (query) => ({ value: query, label: `use '${query}' as-is` }),
            accepts: (query) => Effect.succeed(accepted.includes(query)),
          },
          ...request,
        }),
      ).pipe(Effect.provide(promptClackLive({ input, output }))),
    );
    yield* Effect.sleep("50 millis");
    for (const key of keys) {
      yield* Effect.sync(() => input.write(key));
      yield* Effect.sleep("50 millis");
    }
    return fiber;
  });

describe("PromptClackLive's starting row and as-is row", () => {
  it.live("starts the cursor on the initial row, so Enter takes it", () =>
    Effect.gen(function* () {
      const fiber = yield* openWith({ initial: "speepobox-t81" }, ["\r"]);

      expect(yield* Fiber.join(fiber)).toBe("speepobox-t81");
    }),
  );

  it.live("starts a select on the initial row too", () =>
    Effect.gen(function* () {
      const input = new PassThrough();
      const output = new PassThrough();
      output.resume();
      const fiber = yield* Effect.fork(
        Effect.flatMap(Prompt, (prompt) =>
          prompt.select({ message: "which spec?", rows: ROWS, initial: "T81" }),
        ).pipe(Effect.provide(promptClackLive({ input, output }))),
      );
      yield* Effect.sleep("50 millis");
      input.write("\r");

      expect(yield* Fiber.join(fiber)).toBe("T81");
    }),
  );

  it.live("answers a query the read accepts, as typed", () =>
    Effect.gen(function* () {
      const fiber = yield* openWith({}, ["abc1234", "\r"], ["abc1234"]);

      expect(yield* Fiber.join(fiber)).toBe("abc1234");
    }),
  );

  // The row is on screen before the read has answered (`clack.ts` (5)), so a
  // refusal is the ask re-opening with the query still typed — never the
  // query as the answer.
  it.live("re-opens on a query the read refuses", () =>
    Effect.gen(function* () {
      const fiber = yield* openWith({}, ["zzz", "\r"]);

      expect(yield* Fiber.poll(fiber)).toEqual(Option.none());

      yield* Fiber.interrupt(fiber);
    }),
  );
});
