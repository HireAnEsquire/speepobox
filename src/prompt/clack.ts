// `Prompt`'s live layer, and the **only** importer of `@clack/prompts` in the
// package — `scripts/check-bans.ts` refuses the import anywhere else, so every
// other module speaks the tag's vocabulary and nothing else can grow a second
// opinion about how a terminal behaves. With `ReporterConsoleLive` it is also
// the only writer to stdout in `src/`.
//
// Five things live here and nowhere else, the first three 13's rulings:
//
//  1. **The interrupt bracket is the `signal` option, and that is the whole of
//     it.** Every ask is `Effect.promise((signal) => clack.x({ …, signal }))`,
//     which hands the fiber's interrupt straight to clack's own close —
//     raw-mode restore, listener removal, resolve-with-sentinel. The
//     hand-rolled `acquireRelease` restoring raw mode that 05 priced was
//     *measured* to leave the dead prompt on stdin, still consuming and
//     rendering keystrokes; this leaves none (`test/prompt-clack.test.ts`).
//  2. **`isCancel` is a sentinel, not a rejection**, and it is the one way Esc
//     and Ctrl-C come back. It becomes `PromptCancelled` here, so no caller
//     ever holds a symbol.
//  3. **An options getter needs an explicit pass-through `filter`.** The
//     prompts wrapper injects its case-insensitive substring default whenever
//     none is given — *after* the getter has ranked — so a fuzzy list without
//     this line works on most queries and silently is not fuzzy.
//  4. **Enter with nothing focused is not an answer, and clack resolves one
//     anyway.** `AutocompletePrompt` submits `selectedValues[0]`, so a query
//     no row matches — or one whose every match is `disabled` — resolves
//     **`undefined`**, which `isCancel` says nothing about and which this
//     tag's `Effect<A, PromptCancelled>` cannot represent. Measured over a
//     `PassThrough`: the picker's branch step hands that `undefined` on as the
//     value of `--branch`, which the summary prints as the word and the
//     dispatch takes as a branch name. A `validate` keeps the prompt open on
//     that keystroke instead, which is what the list is already saying on
//     screen (*No matches found*); clearing the query restores the at-rest
//     list and the pick goes through. The same hole in `select` is not
//     reachable — `SelectOptions` takes no `validate`, and every caller here
//     offers at least one enabled row.
//  5. **An `asIs` row is shown before it is known to be answerable.** clack's
//     getter is synchronous and its list is recomputed only when the query
//     changes, so a read's answer arriving later has no way onto the screen.
//     The row is shown for every query no enabled row matches, and Enter on
//     it asks `accepts`: a refusal re-opens the ask with the query still
//     typed, so what the tag answers is what the fake answers — a row
//     `accepts` refused is never the answer — and what differs is only that a
//     dispatcher sees the row a keystroke before the read (T82).
import * as clack from "@clack/prompts";
import type { Readable, Writable } from "node:stream";
import { Effect, Layer } from "effect";
import {
  type AutocompleteRequest,
  type ConfirmRequest,
  type MultiselectRequest,
  type NoteRequest,
  Prompt,
  PromptCancelled,
  type PromptRow,
  type RowWindow,
  type SelectRequest,
  type StartingRow,
  type TextRequest,
} from "./prompt.ts";

// Where a prompt reads and writes. clack takes both on `CommonOptions` and
// defaults them to the process's own, which is what a dispatcher gets; a test
// hands it a pair of `PassThrough`s instead, which is the only reason the
// bracket's regression is assertable in the fake tier at all (T81 §5).
export interface PromptStreams {
  readonly input?: Readable;
  readonly output?: Writable;
}

// The shape clack's rows have. Its own `Option<Value>` is conditional on
// whether the value is primitive, which no generic caller can satisfy, so the
// mapping below builds the wider of the two arms — `label` always written —
// and hands it over as that type.
const rowOf = <A>(row: PromptRow<A>): clack.Option<A> =>
  ({
    value: row.value,
    label: row.label,
    // Spread rather than assigned: an optional field written as `undefined`
    // is not the field being absent (`exactOptionalPropertyTypes`), and clack
    // reads `hint` and `disabled` by presence.
    ...(row.hint === undefined ? {} : { hint: row.hint }),
    ...(row.disabled === undefined ? {} : { disabled: row.disabled }),
  }) as clack.Option<A>;

// What an autocomplete says when Enter arrives with nothing focused — the
// keystroke (4) above refuses. It names the query and not the rows, because
// the list is already saying there are none of those.
const NOTHING_FOCUSED = "no row matches — edit the query, or Esc to cancel";

const windowOf = (request: RowWindow): { maxItems?: number } =>
  request.maxItems === undefined ? {} : { maxItems: request.maxItems };

// The starting row, onto clack's own `initialValue` (T82). Spread for the
// reason `rowOf`'s optional fields are.
const startOf = <A>(request: StartingRow<A>): { initialValue?: A } =>
  request.initial === undefined ? {} : { initialValue: request.initial };

const hasEnabled = <A>(rows: ReadonlyArray<PromptRow<A>>): boolean =>
  rows.some((row) => row.disabled !== true);

// The getter, the pass-through filter, and the no-match guard together — (3)
// and (4) above — and the as-is row with its read on Enter, (5). `typed` is
// the query the ask opens with: empty the first time, and the refused query
// when (5) re-opens it.
const autocompleteFrom = <A>(
  request: AutocompleteRequest<A>,
  typed: string,
  streams: PromptStreams,
): Effect.Effect<A, PromptCancelled> =>
  Effect.suspend(() => {
    const asIs = request.asIs;
    // What the getter was last asked for, which is what was typed when Enter
    // arrived: clack re-reads the getter on every change to the query.
    let query = typed;
    const rowsFor = (current: string): ReadonlyArray<PromptRow<A>> => {
      const rows = request.rows(current);
      return asIs === undefined || current === "" || hasEnabled(rows)
        ? rows
        : [...rows, asIs.row(current)];
    };
    return ask<A>((signal) =>
      clack.autocomplete({
        message: request.message,
        // `this.userInput` is what has been typed; clack calls the getter on
        // every keystroke and shows exactly what it answers, in that order.
        options: function () {
          query = this.userInput ?? "";
          return rowsFor(query).map(rowOf);
        },
        filter: () => true,
        validate: (answer) => (answer === undefined ? NOTHING_FOCUSED : undefined),
        ...startOf(request),
        ...(typed === "" ? {} : { initialUserInput: typed }),
        ...windowOf(request),
        ...streams,
        signal,
      }),
    ).pipe(
      Effect.flatMap((answer) => {
        const asked = query;
        if (
          asIs === undefined ||
          asked === "" ||
          hasEnabled(request.rows(asked)) ||
          answer !== asIs.row(asked).value
        ) {
          return Effect.succeed(answer);
        }
        return asIs
          .accepts(asked)
          .pipe(
            Effect.flatMap((accepted) =>
              accepted ? Effect.succeed(answer) : autocompleteFrom(request, asked, streams),
            ),
          );
      }),
    );
  });

export const promptClackLive = (streams: PromptStreams = {}): Layer.Layer<Prompt> =>
  Layer.succeed(Prompt, {
    select: <A>(request: SelectRequest<A>) =>
      ask<A>((signal) =>
        clack.select({
          message: request.message,
          options: request.rows.map(rowOf),
          ...startOf(request),
          ...windowOf(request),
          ...streams,
          signal,
        }),
      ),
    autocomplete: <A>(request: AutocompleteRequest<A>) => autocompleteFrom(request, "", streams),
    multiselect: <A>(request: MultiselectRequest<A>) =>
      ask<ReadonlyArray<A>>((signal) =>
        clack.multiselect({
          message: request.message,
          options: request.rows.map(rowOf),
          initialValues: [...request.selected],
          ...(request.required === undefined ? {} : { required: request.required }),
          ...windowOf(request),
          ...streams,
          signal,
        }),
      ),
    confirm: (request: ConfirmRequest) =>
      ask<boolean>((signal) =>
        clack.confirm({
          message: request.message,
          ...(request.initial === undefined ? {} : { initialValue: request.initial }),
          ...streams,
          signal,
        }),
      ),
    text: (request: TextRequest) =>
      ask<string>((signal) =>
        clack.text({
          message: request.message,
          ...(request.placeholder === undefined ? {} : { placeholder: request.placeholder }),
          ...streams,
          signal,
        }),
      ),
    // Synchronous in clack and answering nothing, so it is an `Effect.sync`
    // rather than a bracketed promise: there is no prompt open to interrupt.
    note: (request: NoteRequest) =>
      Effect.sync(() => {
        clack.note(request.message, request.title, streams);
      }),
  });

// The bracket itself. `Effect.promise` with a one-parameter callback builds an
// `async` effect that owns an `AbortController`: an interrupt aborts the
// signal, clack closes the prompt, and the fiber ends interrupted rather than
// waiting on a promise nobody will settle.
const ask = <A>(
  open: (signal: AbortSignal) => Promise<A | symbol>,
): Effect.Effect<A, PromptCancelled> =>
  Effect.promise(open).pipe(
    Effect.flatMap((answer) =>
      clack.isCancel(answer) ? new PromptCancelled() : Effect.succeed(answer as A),
    ),
  );

// What `bin.ts` provides to the picker (T81), and what `appLiveFor` provides
// to the dispatch for `--hard-reset`'s confirm (T102). `appBaseLiveFor` is
// unchanged, so `status`, `doctor`, and `gc` acquire no prompt.
export const PromptClackLive: Layer.Layer<Prompt> = promptClackLive();
