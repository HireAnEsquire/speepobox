// The `Prompt` tag (SPEC §2): interactive prompting, in **our** vocabulary
// rather than clack's. The tag is the seam a scripted fake stands in at, which
// is what makes a wizard assertable at all — the picker's 138 bash tests were
// ruled untranslated (12) because they drove a terminal, and this is where the
// package learns to test a prompt instead.
//
// Five asks and a note. Each one is a question about *rows*, and none of them
// is a question about keys: back-navigation is a visible `← Back` row in the
// caller's own list, never key-level handling, because Esc and Ctrl-C are one
// sentinel here (13's cancel ruling) and a tag that tried to tell them apart
// would be reading keystrokes the live layer no longer taps.
//
// **`autocomplete` takes its rows as a getter of the query and never filters.**
// The caller ranks and orders — `rankFuzzy` for every caller in this package
// (T80) — and the tag's contract is that what the getter answers is what the
// step shows, in that order. A tag that filtered would be a second ranking
// nobody asked for, which is exactly the defect 13 found in clack's own
// default (`clack.ts` carries the mitigation).
import { Context, Data, type Effect } from "effect";

// Esc, Ctrl-C, and every other way a prompt comes back without an answer —
// **one sentinel**, per 13's ruling that clack collapses the two cancel keys
// anyway. It carries no detail because there is nothing to say that the
// caller does not already know: which step was open is the caller's own
// context, and what to print about it is the caller's decision (the picker
// prints one line and exits 1, T81).
//
// A tagged error rather than an `Option`, for `EditorCancelled`'s reason
// (`editor.ts`): it is a refusal that holds nothing, it stops the wizard where
// it stands, and a caller that wants to recover from it says so by name.
export class PromptCancelled extends Data.TaggedError("PromptCancelled")<{}> {}

// One row of a list. `value` is what the ask answers with when this row is
// chosen, `label` is what the dispatcher reads, and the two are separate
// because a row's text says things its value must not carry — a disabled
// branch's `⛔ CHECKED OUT — ` prefix, a hint that ages it.
//
// `disabled` is 13's accepted divergence made representable: a branch the
// dispatch would refuse is shown and unpickable, rather than pickable and
// then refused.
export interface PromptRow<A> {
  readonly value: A;
  readonly label: string;
  readonly hint?: string;
  readonly disabled?: boolean;
}

// How many rows a list shows at once. It bounds the **window**, never the
// ranking: a query matching three hundred branches still ranks all of them
// and still puts the best first, and what this decides is how much of that
// order fits on the screen (T81).
export interface RowWindow {
  readonly maxItems?: number;
}

// The row the cursor starts on, by value (T82): an edited step re-runs
// pre-answered with its previous choice, and the base step's Enter is the
// chain default. Absent, the cursor starts where clack starts it — row 0. A
// value no row carries is the same as absent, which is clack's rule too.
export interface StartingRow<A> {
  readonly initial?: A;
}

export interface SelectRequest<A> extends RowWindow, StartingRow<A> {
  readonly message: string;
  readonly rows: ReadonlyArray<PromptRow<A>>;
}

// The rows as a function of what has been typed — the getter 13's amendment 1
// requires. The empty query is the at-rest list, and it is the caller's own
// order (recency, for the branch step).
//
// It answers a **row's** value or a cancel, and nothing else: a query no row
// matches, or one whose every match is disabled, leaves the ask open rather
// than answering. clack does not give that for free (`clack.ts` (4)), and a
// caller reading `A` as "one of the rows I offered" is what the whole tag is
// for.
//
// `asIs` is the one way past that: a query no row matches is answerable as
// typed **iff `accepts` says so** — the base step's SHAs, `HEAD~1`, and tags
// no listed ref carries (T82, bash's rule). That question is a read, so it is
// an effect, and the getter is not: the scripted fake asks it before it
// records the rows, and the live layer asks it on Enter (`clack.ts` (5)).
export interface AutocompleteRequest<A> extends RowWindow, StartingRow<A> {
  readonly message: string;
  readonly rows: (query: string) => ReadonlyArray<PromptRow<A>>;
  readonly asIs?: AsIs<A>;
}

// The row a query nothing matches is offered as, and the read that decides
// whether it is offered at all.
export interface AsIs<A> {
  readonly row: (query: string) => PromptRow<A>;
  readonly accepts: (query: string) => Effect.Effect<boolean>;
}

// A list that answers with several rows, and the ones already ticked when it
// opens. `selected` holds values rather than labels, because it is compared
// against what the rows carry.
//
// `required` is whether an empty answer is an answer at all. Absent is
// clack's own default, which is that it is not; the picker's issues step says
// so out loud (T83), because a run of no issues is no run.
export interface MultiselectRequest<A> extends RowWindow {
  readonly message: string;
  readonly rows: ReadonlyArray<PromptRow<A>>;
  readonly selected: ReadonlyArray<A>;
  readonly required?: boolean;
}

export interface ConfirmRequest {
  readonly message: string;
  readonly initial?: boolean;
}

export interface TextRequest {
  readonly message: string;
  readonly placeholder?: string;
}

// Not an ask: a block of text shown between the steps — the picker's summary,
// with the equivalent command line in it. It answers nothing, so it is the one
// member of this tag that cannot be cancelled.
export interface NoteRequest {
  readonly message: string;
  readonly title?: string;
}

export interface PromptShape {
  readonly select: <A>(request: SelectRequest<A>) => Effect.Effect<A, PromptCancelled>;
  readonly autocomplete: <A>(request: AutocompleteRequest<A>) => Effect.Effect<A, PromptCancelled>;
  readonly multiselect: <A>(
    request: MultiselectRequest<A>,
  ) => Effect.Effect<ReadonlyArray<A>, PromptCancelled>;
  readonly confirm: (request: ConfirmRequest) => Effect.Effect<boolean, PromptCancelled>;
  readonly text: (request: TextRequest) => Effect.Effect<string, PromptCancelled>;
  readonly note: (request: NoteRequest) => Effect.Effect<void>;
}

export class Prompt extends Context.Tag("Prompt")<Prompt, PromptShape>() {}
