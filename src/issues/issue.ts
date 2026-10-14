// Issue files: parse, order, and restamp (T68) — tasklib's issue half
// (`tasklib.py:174-241`, `252-266`, `363-388`; inventory 03 §3.1–3.3) as the
// plain functions SPEC §2 lists it under. Text in, values out: no tag, no
// `FileSystem`, no `Git`, so a fake buys nothing and every case in
// `test/issue.test.ts` is a value assertion.
//
// Nothing here is reachable from a command line. `IssueStore` (T71) is the
// first caller of the parse — it reads the `.md` blobs out of a ref and hands
// each one's stem and text in — and `markLanded` (T77) is the first caller of
// the restamp.
//
// The rules are this folder's own headers, which is why the suite parses
// `docs/wayfinder/effect-agentbox/issues/*.md` as they sit beside the ticket
// rather than fixtures alone: the parse and the files it reads are one
// artifact, and a rule that drifts from the folder it was taken from is a rule
// nobody notices breaking.
import { Data, Either, Option, Schema } from "effect";

// --- ids --------------------------------------------------------------------

// The identifier at the head of a piece of text. One rule serves three
// readings, because they are the same question asked of different strings: a
// file's stem (`T67-a-task-stated-on-the-command-line` → `T67`,
// `03-behavior-inventory` → `03`), a `Blocked by:` token
// (`[T66](T66-….md) — the union` → `T66`), and the `--issues` argument a
// dispatcher types (T69).
//
// *The stem up to its first `-`* is the rule as stated; the leading run of
// alphanumerics is that rule plus the two things a token carries and a stem
// does not — the brackets of a markdown link, and the prose after the id. So
// `ticket 16` names `ticket`, which is nothing in any folder, and that is the
// answer 15 wanted for T36's `Blocked by: ticket 16`: the digits tasklib
// searched out of it anywhere in the token (`_leading_number`) named whichever
// issue happened to be 16.
const IDENTIFIER = /^[^A-Za-z0-9]*([A-Za-z0-9]+)/;

export const idIn = (text: string): Option.Option<string> =>
  Option.fromNullable(IDENTIFIER.exec(text)?.[1]);

const DIGITS = /\d+/;
const BARE_NUMBER = /^\d+$/;

// Whether a candidate id names the issue whose id this is. Case-insensitively,
// and **a bare number matches an id whose digits are that number** — `37`
// names `T37`, which is what bash recorded (`issues={"37": "approved"}`, 15)
// and what a dispatcher types. The comparison is numeric rather than textual
// so `3` and `03` are the same issue.
export const namesId = (candidate: string, id: string): boolean => {
  if (candidate.toLowerCase() === id.toLowerCase()) {
    return true;
  }
  if (!BARE_NUMBER.test(candidate)) {
    return false;
  }
  const digits = DIGITS.exec(id)?.[0];
  return digits !== undefined && Number(digits) === Number(candidate);
};

// --- the value --------------------------------------------------------------

// `AFK` or `HITL`, and nothing else (`tasklib.py:238` upper-cases before it
// compares, so `Type: afk` is the same header).
export const IssueType = Schema.Literal("AFK", "HITL");
export type IssueType = Schema.Schema.Type<typeof IssueType>;

// Absent is `AFK` — deliberate compat with tasklib, whose default keeps a
// feature folder written before the header existed selectable.
export const DEFAULT_TYPE: IssueType = "AFK";

// The triage vocabulary of `docs/agents/triage-labels.md`, plus the `done`
// that file adds as closure. `done` carries exactly one meaning here —
// **landed on this ref** (14, SPEC §2) — and is the only one this package
// ever writes.
export const TRIAGE_STATUSES = [
  "needs-triage",
  "needs-info",
  "ready-for-agent",
  "ready-for-human",
  "wontfix",
  "done",
] as const;

export const TriageStatus = Schema.Literal(...TRIAGE_STATUSES);
export type TriageStatus = Schema.Schema.Type<typeof TriageStatus>;

// A status whose first token is none of the six. Kept as an arm rather than
// refused, because a stale spelling on one file must not refuse a dispatch of
// its neighbours; the selection (T69) reads it as neither done nor ready. It
// carries the header's text as the file wrote it — the whole of it, annotation
// included, since a reader who has to fix the spelling needs to see what is
// there.
//
// The six known arms are the label strings themselves rather than six more
// wrappers: they *are* the vocabulary, so `status === "done"` is the question
// every caller asks, and the one arm that needs a wrapper is the one carrying
// text that is not vocabulary.
export const UnknownStatus = Schema.TaggedStruct("Unknown", { text: Schema.String });

export const IssueStatus = Schema.Union(TriageStatus, UnknownStatus);
export type IssueStatus = Schema.Schema.Type<typeof IssueStatus>;

export const unknownStatus = (text: string): IssueStatus => ({ _tag: "Unknown", text });

// Absent is `needs-triage`, which is where TEMPLATE.md opens every issue.
export const DEFAULT_STATUS: TriageStatus = "needs-triage";

// One `Blocked by:` token: the id it names, and the token as the file wrote
// it. Both, because the id is what matches an issue in the folder and the
// token is what a violation quotes back — a token naming no issue in the
// folder is an **external** blocker, never satisfied, and the only useful
// thing to say about it is what it said (T69).
export const Blocker = Schema.Struct({
  id: Schema.String,
  token: Schema.String,
});
export type Blocker = Schema.Schema.Type<typeof Blocker>;

// A `Schema.Struct` rather than an interface so SPEC §5's rule holds when
// `IssueSelection` (T69) carries these: every operation returns a
// Schema-defined domain value, and JSON for a future frontend is free.
export const Issue = Schema.Struct({
  // What `--issues` names, what a `Blocked by:` token names, and what the
  // ledger row records in `IssueOutcome.issue` (`ledger/record.ts`).
  id: Schema.String,
  // The file's name without `.md`. The stem is what a reader recognises in a
  // commit list (14, lesson 10), so the write half (T77) names its files from
  // this and never from a scratch path.
  stem: Schema.String,
  title: Schema.String,
  type: IssueType,
  status: IssueStatus,
  blockers: Schema.Array(Blocker),
});
export type Issue = Schema.Schema.Type<typeof Issue>;

// The `.md` the stem came off — what a selected issue carries as its file name
// (T69 §4) and what the write half names its commit after (T77). Derived from
// the stem rather than stored beside it, so the two cannot disagree about
// which file an issue is.
export const fileNameOf = (issue: Issue): string => `${issue.stem}.md`;

// Whether an issue's title already names it. A ticket's H1 opens with its id
// (`T89 — …`), and so does a title that fell back to the stem, so a message
// printing the id beside the title would say it twice. Asked of the title's
// *leading identifier* rather than as a prefix, so `T890 — …` does not open
// with `T89`; case-insensitively, as every id comparison here is.
export const titleNamesIssue = (issue: Issue): boolean =>
  Option.exists(idIn(issue.title), (lead) => lead.toLowerCase() === issue.id.toLowerCase());

// What follows the id in a title that opens with it — the separator dropped —
// and the whole title in one that does not.
export const titleAfterId = (issue: Issue): string =>
  titleNamesIssue(issue)
    ? issue.title
        .slice(issue.title.search(/[A-Za-z0-9]/) + issue.id.length)
        .replace(/^[\s—–:-]+/, "")
    : issue.title;

// A file this package cannot read as an issue. Today that is one case — a
// `Type:` that is neither `AFK` nor `HITL` — and it names the file, because
// the caller reads a whole folder at a ref (T71) and "which one" is the first
// thing a dispatcher asks.
export class IssueUnparseable extends Data.TaggedError("IssueUnparseable")<{
  readonly stem: string;
  readonly detail: string;
}> {}

// --- the parse --------------------------------------------------------------

// tasklib's header regex verbatim (`tasklib.py:178`): the three headers, in
// any case, with the value trimmed off both ends.
const HEADER = /^\s*(status|type|blocked by)\s*:\s*(.*?)\s*$/i;

// Python's `splitlines`, which is what the two ports of tasklib's loops below
// are written against: a trailing newline ends the last line rather than
// starting an empty one, and `""` has no lines at all. `\r\n` splits too, so
// a CRLF file's headers are not read with a stray carriage return on the end
// of every value.
const linesOf = (text: string): ReadonlyArray<string> => {
  const lines = text.split(/\r?\n/);
  return lines.at(-1) === "" ? lines.slice(0, -1) : lines;
};

// Of the four spellings of "nothing blocks this" — empty, `none`, `—`, `-` —
// this is the only one that needs naming: the other three carry no identifier
// at all, so `idIn` already answers `None` for them.
const NONE = "none";

// The header block: from the top of the file **until the first `##`**, so a
// header below the first section heading is body (`tasklib.py:184-185`).
//
// **First occurrence wins**, where tasklib let a later line overwrite an
// earlier one (`tasklib.py:190`). The restamp below rewrites the *first*
// `Status:` line, so last-wins would make `parse(withStatus(text, s)).status
// === s` false on any file carrying two of them — a round-trip that holds for
// every file in this folder today and not for the one somebody quotes a header
// inside an HTML comment in tomorrow.
interface Headers {
  readonly title: Option.Option<string>;
  readonly fields: ReadonlyMap<string, string>;
}

const headersIn = (text: string): Headers => {
  let title = Option.none<string>();
  const fields = new Map<string, string>();
  for (const line of linesOf(text)) {
    const stripped = line.trim();
    if (stripped.startsWith("##")) {
      break;
    }
    if (Option.isNone(title) && stripped.startsWith("#")) {
      const named = stripped.replace(/^#+/, "").trim();
      if (named !== "") {
        title = Option.some(named);
      }
      continue;
    }
    const match = HEADER.exec(line);
    const header = match?.[1]?.toLowerCase();
    if (header !== undefined && match?.[2] !== undefined && !fields.has(header)) {
      fields.set(header, match[2]);
    }
  }
  return { title, fields };
};

// The first token of the status line, compared case-insensitively — which is
// `tasklib.py:196`'s `done\b(?!-)` generalized to all six labels. `Done (PR
// #26; …)` is done, because humans annotate status lines and an annotation
// must not un-done an issue; `done-ish` is not, because the token runs to the
// whitespace and `done-ish` is a different word.
const statusIn = (value: string): IssueStatus => {
  const trimmed = value.trim();
  if (trimmed === "") {
    return DEFAULT_STATUS;
  }
  const first = (trimmed.split(/\s+/)[0] ?? trimmed).toLowerCase();
  return TRIAGE_STATUSES.find((label) => label === first) ?? unknownStatus(trimmed);
};

// A comma list, each token read for the id it names. The empty spellings are
// tested against the **whole value** and not only per token, because the four
// of them are how a file says the header is empty and this folder says it with
// prose after the word — `none. **Deadline: before P6** …` is not a blocker
// named `P6`, which is the answer tasklib's digit search gave it.
const blockersIn = (value: string): ReadonlyArray<Blocker> => {
  const trimmed = value.trim();
  const leading = idIn(trimmed);
  if (Option.isNone(leading) || leading.value.toLowerCase() === NONE) {
    return [];
  }
  const blockers: Array<Blocker> = [];
  for (const piece of trimmed.split(",")) {
    const token = piece.trim();
    const id = idIn(token);
    if (Option.isNone(id) || id.value.toLowerCase() === NONE) {
      continue;
    }
    blockers.push({ id: id.value, token });
  }
  return blockers;
};

// One `.md` per issue: the caller passes the file's stem and its text, and
// nothing else — no path, no ref, no folder. Whether a blocker is external is
// a fact about the folder, not about this file, so it is answered where the
// set is (the order below, the selection in T69) against `Blocker.id`.
export const parseIssue = (stem: string, text: string): Either.Either<Issue, IssueUnparseable> => {
  const { title, fields } = headersIn(text);
  const declared = fields.get("type")?.trim() ?? "";
  const type = declared === "" ? DEFAULT_TYPE : declared.toUpperCase();
  if (type !== "AFK" && type !== "HITL") {
    return Either.left(
      new IssueUnparseable({
        stem,
        detail: `${stem}.md: 'Type: ${declared}' is neither AFK nor HITL`,
      }),
    );
  }
  return Either.right({
    // A stem with no identifier in it at all is its own id: there is nothing
    // better to call the file, and refusing it would refuse a dispatch of its
    // neighbours over a name.
    id: Option.getOrElse(idIn(stem), () => stem.trim()),
    stem,
    title: Option.getOrElse(title, () => stem),
    type,
    status: statusIn(fields.get("status") ?? ""),
    blockers: blockersIn(fields.get("blocked by") ?? ""),
  });
};

// --- the order --------------------------------------------------------------

// A `Blocked by:` cycle among the issues handed in. Carries the ids on it and
// nothing else: which sentence a dispatcher reads is the refusal's job (T69
// turns this into a `SelectionRefused`, T73 into a `GuardRefused`), and a
// message built here would be a second copy of that vocabulary.
export class BlockerCycle extends Data.TaggedError("BlockerCycle")<{
  readonly ids: ReadonlyArray<string>;
}> {}

// Ids ascending — **numerically where both carry digits, lexically otherwise**,
// so `T9` precedes `T10` where a plain string sort would not, and `TEMPLATE`
// still has a place among them. Equal numbers fall through to the lexical
// comparison rather than tying, because a tie is a nondeterministic order and
// determinism is the whole point of the rule.
export const compareIds = (a: string, b: string): number => {
  const left = DIGITS.exec(a)?.[0];
  const right = DIGITS.exec(b)?.[0];
  if (left !== undefined && right !== undefined && Number(left) !== Number(right)) {
    return Number(left) - Number(right);
  }
  return a < b ? -1 : a > b ? 1 : 0;
};

// Kahn's algorithm over the set handed in, ties broken by id
// (`tasklib.py:252-266`). Pure over `ReadonlyArray<Issue>`: the set is
// whatever the caller selected, and a blocker outside it is not a constraint —
// which is how a blocker already landed on the base, and an **external**
// blocker naming no issue at all, both stay out of the order. Refusing on
// either is the selection's call (T69), where the two have different answers.
//
// A round emits every ready issue at once, sorted, rather than one at a time,
// which is tasklib's own loop (`tasklib.py:258-266`) and **not** the same
// sequence: `{T1, T5, T2 blocked by T1}` is `T1 T5 T2` by rounds and
// `T1 T2 T5` one at a time, because taking T1 alone lets T2 into the next
// tie-break. The round is the sequence bash's dispatches ran in, and a round
// is what makes the tie-break a property of the set rather than of the
// iteration.
export const orderIssues = (
  issues: ReadonlyArray<Issue>,
): Either.Either<ReadonlyArray<Issue>, BlockerCycle> => {
  let remaining: ReadonlyArray<Issue> = issues;
  const ordered: Array<Issue> = [];
  while (remaining.length > 0) {
    const blocked = (issue: Issue): boolean =>
      issue.blockers.some((blocker) => remaining.some((other) => namesId(blocker.id, other.id)));
    // Nothing excludes an issue from its own `remaining`, so an issue that
    // blocks itself is a cycle of one — which is what it is.
    const ready = remaining
      .filter((issue) => !blocked(issue))
      .toSorted((a, b) => compareIds(a.id, b.id));
    if (ready.length === 0) {
      return Either.left(
        new BlockerCycle({ ids: remaining.map((issue) => issue.id).toSorted(compareIds) }),
      );
    }
    ordered.push(...ready);
    remaining = remaining.filter((issue) => !ready.includes(issue));
  }
  return Either.right(ordered);
};

// --- the restamp ------------------------------------------------------------

// What the dispatcher writes when a run's work lands (T77). `Done` and not
// `done`, matching the hand-written status commits already in this folder;
// the parse reads either, so the capital is a courtesy to the reader and
// nothing branches on it.
export const LANDED_STATUS = "Done";

// The file's text with its `Status:` line replaced, by `cmd_set_status`'s
// three placements (`tasklib.py:363-388`): the first `Status:` line rewritten
// in place, none → inserted before the first `##`, no `##` either → inserted
// as the second line. The result always ends in one newline.
//
// The contract is the round trip — `parseIssue(stem, withStatus(text, s))`
// reads `s` back — which is the whole of what `markLanded` needs, and it is
// why the second and third placements land the line *above* the first section
// heading rather than anywhere tidier: below it the header is body, and the
// write would be invisible to the read.
//
// The status is a string rather than an `IssueStatus`: this writes the line a
// human then annotates (`Done (PR #26; …)`), so what goes in is text, and what
// it parses back to is the parse's question.
export const withStatus = (text: string, status: string): string => {
  const line = `Status: ${status}`;
  const out: Array<string> = [];
  let written = false;
  for (const source of linesOf(text)) {
    if (!written) {
      if (source.trim().startsWith("##")) {
        out.push(line);
        written = true;
      } else {
        const match = HEADER.exec(source);
        if (match?.[1]?.toLowerCase() === "status") {
          out.push(line);
          written = true;
          continue;
        }
      }
    }
    out.push(source);
  }
  if (!written) {
    // The second line, so the status sits under the title the way every file
    // in this folder writes it — and the first line of an empty file, which
    // has no title to sit under.
    out.splice(out.length > 0 ? 1 : 0, 0, line);
  }
  return `${out.join("\n")}\n`;
};
