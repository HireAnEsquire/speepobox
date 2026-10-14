// A scripted `Prompt` — the seam that makes a wizard assertable (T81). The
// picker's 138 bash tests were ruled untranslated (12) because they drove a
// terminal; this drives the tag instead, and what a case asserts is the two
// things a terminal could only show a person: **which questions were asked, in
// which order, with which rows**, and what the wizard did with the answers.
//
// The script answers asks in order. A row ask is answered by the **label** of
// the row to pick, which is how the acceptance criteria are written ("T3",
// then "bessemer-t3", then "Dispatch") and what keeps a case readable when the
// value behind a row is a tagged union. Three things deliberately fail the
// test rather than degrading:
//
//  - a script that runs out (the wizard asked more than the case scripted),
//  - a label no row offered (the case and the picker disagree about the list),
//  - a label on a **disabled** row — the property 13's divergence is about,
//    since a disabled row is unpickable in clack and must be here too.
//
// `autocomplete`'s rows are a getter of the query, and this answers it **at
// rest** — the empty query, whose order is the caller's own — unless the
// script says what was typed (`typed`, T82). Ranking under a query is
// `rankFuzzy`'s (T80) and the row builder's, and both are pure and asserted
// directly; what a typed answer is for is the as-is row, whose offer is a
// read the ask makes and so has no pure half to assert.
//
// `ENTER` is the key rather than a label: the row the cursor starts on — the
// ask's `initial` where a row carries it, row 0 otherwise, which is clack's
// own rule — or, under a query, the first enabled row, which is where clack's
// focus lands.
import { Effect, Layer, Ref } from "effect";
import {
  type AutocompleteRequest,
  type ConfirmRequest,
  type MultiselectRequest,
  type NoteRequest,
  Prompt,
  PromptCancelled,
  type PromptRow,
  type SelectRequest,
  type TextRequest,
} from "../../src/prompt/prompt.ts";

// Esc or Ctrl-C at this step — clack's one sentinel, scripted. A symbol rather
// than a reserved string, so no label can ever collide with it.
export const CANCEL: unique symbol = Symbol("PromptCancelled");

// Enter on whatever row the cursor is on, scripted.
export const ENTER: unique symbol = Symbol("Enter");

// A query typed into an autocomplete, and then the row picked under it — or
// the cancel, which is how a case reads the list a query left without
// answering from it.
export interface Typed {
  readonly _tag: "Typed";
  readonly query: string;
  readonly pick: string | typeof ENTER | typeof CANCEL;
}

export const typed = (query: string, pick: string | typeof ENTER | typeof CANCEL): Typed => ({
  _tag: "Typed",
  query,
  pick,
});

// One scripted answer: the label of the row to pick, Enter on the row the
// cursor is on, a query and then a pick, the labels for a multiselect, what
// was typed into a `text`, the answer to a `confirm`, or the cancel.
export type ScriptedAnswer =
  | string
  | boolean
  | ReadonlyArray<string>
  | Typed
  | typeof ENTER
  | typeof CANCEL;

// A row as it was offered, with the value left out: what a case asserts about
// a list is what a dispatcher would see — the text, the age or outcome beside
// it, and whether it could be picked at all.
export interface AskedRow {
  readonly label: string;
  readonly hint?: string;
  readonly disabled?: boolean;
}

export type AskKind = "select" | "autocomplete" | "multiselect" | "confirm" | "text" | "note";

export interface AskedQuestion {
  readonly kind: AskKind;
  readonly message: string;
  // The rows the question offered, in the order it offered them. Empty for
  // the asks that offer none.
  readonly rows: ReadonlyArray<AskedRow>;
  // A note's heading, and nothing else's.
  readonly title?: string;
  // The label of the row the cursor started on, when the ask named one a row
  // carries (T82) — an edited step's previous choice, the base's default.
  readonly initial?: string;
  // What was typed before the rows were read, when anything was.
  readonly query?: string;
  // The labels of the rows a multiselect opened with ticked (T83), in row
  // order — the preselection is part of what a dispatcher is shown.
  readonly selected?: ReadonlyArray<string>;
}

const askedRow = <A>(row: PromptRow<A>): AskedRow => ({
  label: row.label,
  ...(row.hint === undefined ? {} : { hint: row.hint }),
  ...(row.disabled === undefined ? {} : { disabled: row.disabled }),
});

// A fake that answers no ask is a wiring mistake in the test rather than a
// case with an answer, so every one of these dies rather than failing: the
// wizard under test has a script or it has a bug.
const died = (detail: string): Effect.Effect<never> => Effect.die(`scriptedPrompt: ${detail}`);

export const scriptedPrompt = (
  answers: ReadonlyArray<ScriptedAnswer>,
  asked?: Ref.Ref<ReadonlyArray<AskedQuestion>>,
): Layer.Layer<Prompt> =>
  Layer.effect(
    Prompt,
    Effect.gen(function* () {
      const remaining = yield* Ref.make<ReadonlyArray<ScriptedAnswer>>(answers);
      const record = (question: AskedQuestion): Effect.Effect<void> =>
        asked === undefined ? Effect.void : Ref.update(asked, (current) => [...current, question]);

      // The next answer, and the script's own end: a wizard that asked one
      // more question than the case wrote is exactly the regression an
      // out-of-answers fake has to fail on.
      const next = (question: AskedQuestion): Effect.Effect<ScriptedAnswer> =>
        Ref.modify(remaining, (script) => [script[0], script.slice(1)] as const).pipe(
          Effect.flatMap((answer) =>
            answer === undefined
              ? died(`the script ran out at '${question.message}'`)
              : Effect.succeed(answer),
          ),
        );

      // One row ask. The answer is taken first, because a typed one decides
      // which rows the getter answers; the rows are recorded before anything
      // else is decided, so a case that ends in a die still has the list the
      // wizard offered.
      const pick = <A>(
        kind: AskKind,
        message: string,
        rowsAt: (query: string) => Effect.Effect<ReadonlyArray<PromptRow<A>>>,
        initial: A | undefined,
      ): Effect.Effect<A, PromptCancelled> =>
        Effect.gen(function* () {
          const answer = yield* Ref.modify(
            remaining,
            (script) => [script[0], script.slice(1)] as const,
          );
          const query = typeof answer === "object" && "_tag" in answer ? answer.query : "";
          const rows = yield* rowsAt(query);
          const started = rows.find((row) => initial !== undefined && row.value === initial);
          yield* record({
            kind,
            message,
            rows: rows.map(askedRow),
            ...(started === undefined ? {} : { initial: started.label }),
            ...(query === "" ? {} : { query }),
          });
          if (answer === undefined) {
            return yield* died(`the script ran out at '${message}'`);
          }
          const label = typeof answer === "object" && "_tag" in answer ? answer.pick : answer;
          if (label === CANCEL) {
            return yield* new PromptCancelled();
          }
          if (label === ENTER) {
            // Where the cursor is: the starting row at rest, the first
            // enabled row under a query — clack's own two rules.
            const focused =
              query === "" ? (started ?? rows[0]) : rows.find((row) => row.disabled !== true);
            return focused === undefined || focused.disabled === true
              ? yield* died(`Enter on '${message}' has no row to land on`)
              : focused.value;
          }
          if (typeof label !== "string") {
            return yield* died(`'${message}' offers rows, and the script answered ${typeof label}`);
          }
          const row = rows.find((candidate) => candidate.label === label);
          if (row === undefined) {
            return yield* died(
              `'${label}' is no row of '${message}' — offered: ${rows.map((r) => r.label).join(", ")}`,
            );
          }
          if (row.disabled === true) {
            return yield* died(`'${label}' is a disabled row of '${message}'`);
          }
          return row.value;
        });

      return {
        select: <A>(request: SelectRequest<A>) =>
          pick<A>(
            "select",
            request.message,
            (query) =>
              query === ""
                ? Effect.succeed(request.rows)
                : died(`'${request.message}' is a select, and takes no query`),
            request.initial,
          ),
        // At rest unless the script typed: what this records is the list a
        // dispatcher sees, and its order. The as-is row is asked for here,
        // before the rows are recorded, so a query `accepts` refuses records
        // a list without it — the row was never offered (T82).
        autocomplete: <A>(request: AutocompleteRequest<A>) =>
          pick<A>(
            "autocomplete",
            request.message,
            (query) => {
              const rows = request.rows(query);
              const asIs = request.asIs;
              return asIs === undefined || query === "" || rows.some((row) => row.disabled !== true)
                ? Effect.succeed(rows)
                : asIs
                    .accepts(query)
                    .pipe(Effect.map((accepted) => (accepted ? [...rows, asIs.row(query)] : rows)));
            },
            request.initial,
          ),
        multiselect: <A>(request: MultiselectRequest<A>) =>
          Effect.gen(function* () {
            const question = {
              kind: "multiselect" as const,
              message: request.message,
              rows: request.rows.map(askedRow),
              selected: request.rows
                .filter((row) => request.selected.includes(row.value))
                .map((row) => row.label),
            };
            yield* record(question);
            const answer = yield* next(question);
            if (answer === CANCEL) {
              return yield* new PromptCancelled();
            }
            if (!Array.isArray(answer)) {
              return yield* died(`'${request.message}' takes a list of labels`);
            }
            const labels: ReadonlyArray<string> = answer;
            const picked = request.rows.filter((row) => labels.includes(row.label));
            if (picked.length !== labels.length) {
              return yield* died(`'${request.message}' was answered with a label it did not offer`);
            }
            // The two things clack would not let a dispatcher do either: tick
            // a disabled row, or submit nothing when something is required —
            // clack's default, so absent counts as required.
            if (picked.some((row) => row.disabled === true)) {
              return yield* died(`'${request.message}' was answered with a disabled row`);
            }
            return picked.length === 0 && request.required !== false
              ? yield* died(`'${request.message}' requires at least one row`)
              : picked.map((row) => row.value);
          }),
        confirm: (request: ConfirmRequest) =>
          Effect.gen(function* () {
            const question = { kind: "confirm" as const, message: request.message, rows: [] };
            yield* record(question);
            const answer = yield* next(question);
            if (answer === CANCEL) {
              return yield* new PromptCancelled();
            }
            return typeof answer === "boolean"
              ? answer
              : yield* died(`'${request.message}' is a confirm, and the script answered a label`);
          }),
        text: (request: TextRequest) =>
          Effect.gen(function* () {
            const question = { kind: "text" as const, message: request.message, rows: [] };
            yield* record(question);
            const answer = yield* next(question);
            if (answer === CANCEL) {
              return yield* new PromptCancelled();
            }
            return typeof answer === "string"
              ? answer
              : yield* died(
                  `'${request.message}' is a text ask, and the script answered ${typeof answer}`,
                );
          }),
        // A note answers nothing, so it consumes no answer — it is recorded
        // and that is all. What a case asserts about it is its text, which is
        // where the equivalent command line lands (T81).
        note: (request: NoteRequest) =>
          record({
            kind: "note",
            message: request.message,
            rows: [],
            ...(request.title === undefined ? {} : { title: request.title }),
          }),
      };
    }),
  );
