// The pin, read out of `.speepobox/config.toml` by the one grammar SPEC §6
// names (T121, P6 F6 and F7). Pure: it reads the text it is handed and
// nothing else — the shim reads the same file with `sed` before the package
// exists, so the pin is not a `SpeepoboxConfig` key and no layer decodes it.
//
// One grammar, two implementations: this module and the shim's `sed` (T125).
// `test/fixtures/pin/` holds the lines both are held to, so a case added here
// is a case the shell answers too.
//
// The grammar is narrower than TOML on purpose. `init` always writes a line it
// accepts, and a line that merely *looks* like the pin — single quotes, a
// trailing comment, indentation — is refused rather than read, because the
// shim's `sed` cannot read it and the two must never disagree about which SHA
// a repo runs.
import { Data, Either } from "effect";

// SPEC §6's grammar, exactly.
export const PIN_LINE = /^tool-sha[ \t]*=[ \t]*"([^"]*)"[ \t]*$/;

// A line that *starts* as the pin does — optional blanks, `tool-sha`, optional
// blanks, `=` — but that `PIN_LINE` does not match. A comment that mentions
// the key, or a key that merely begins with its letters (`tool-shaft`), is not
// one.
const PIN_ATTEMPT = /^[ \t]*tool-sha[ \t]*=/;

// The only value the shim can fetch: a full commit SHA, lowercase as git
// prints it.
const FULL_SHA = /^[0-9a-f]{40}$/;

// Where the pin is announced and what each refusal points at.
export const RELEASE_URL = "https://github.com/HireAnEsquire/speepobox.git";

export const EXPECTED_PIN_LINE = 'tool-sha = "<40-hex sha>"';

// Every way the file can fail to pin a release, one tag per verdict. `index`
// is the line's 0-based position in the text; the renderer counts from one.
export type PinRefusal = Data.TaggedEnum<{
  // No line matches and none is malformed.
  NoLine: {};
  // The first line that starts as the pin does and that the grammar refuses.
  Malformed: { readonly index: number; readonly text: string };
  // More than one line matches: F6's "exactly one line may match".
  Duplicated: { readonly indices: ReadonlyArray<number> };
  // The one matching line pins `""` — `init` ran on a dirty package.
  Empty: { readonly index: number };
  // The one matching line pins something that is not 40 lowercase hex.
  Short: { readonly index: number; readonly value: string };
}>;

export const PinRefusal = Data.taggedEnum<PinRefusal>();

// The refusals that leave no one line to rewrite.
export type PinLineRefusal = Extract<PinRefusal, { _tag: "NoLine" | "Malformed" | "Duplicated" }>;

// The one grammar-matching line, whatever its value: what `upgrade --to`
// replaces (T128), which needs a line to rewrite and not a valid value.
export interface PinLine {
  readonly index: number;
  readonly value: string;
}

// Lines as the shim's `sed` sees them: split on `\n` alone, so a `\r` stays
// on its line and fails the grammar's trailing `[ \t]*$` there too.
const linesOf = (text: string): ReadonlyArray<string> => text.split("\n");

export const pinLineIn = (text: string): Either.Either<PinLine, PinLineRefusal> => {
  const matches: Array<PinLine> = [];
  const lines = linesOf(text);
  for (const [index, line] of lines.entries()) {
    const match = PIN_LINE.exec(line);
    if (match !== null) {
      matches.push({ index, value: match[1]! });
    } else if (PIN_ATTEMPT.test(line)) {
      // A malformed line wins over everything: with a good line beside it,
      // nothing says which of the two the adopter meant.
      return Either.left(PinRefusal.Malformed({ index, text: line }));
    }
  }
  const [only, ...rest] = matches;
  if (only === undefined) {
    return Either.left(PinRefusal.NoLine());
  }
  if (rest.length > 0) {
    return Either.left(PinRefusal.Duplicated({ indices: matches.map((m) => m.index) }));
  }
  return Either.right(only);
};

// The pinned SHA, as written, or the refusal that names its fix.
export const pinIn = (text: string): Either.Either<string, PinRefusal> =>
  Either.flatMap(pinLineIn(text), ({ index, value }): Either.Either<string, PinRefusal> => {
    if (value === "") {
      return Either.left(PinRefusal.Empty({ index }));
    }
    if (!FULL_SHA.test(value)) {
      return Either.left(PinRefusal.Short({ index, value }));
    }
    return Either.right(value);
  });

// Empty and short share a fix (F6, amended by T132): the shim cannot run
// `upgrade` on a pin it cannot fetch, so the first remedy lists the releases
// through gh — the API, which needs no git credential and answers on an SSH
// host, and whose `/tags` is pre-peeled, so every line is a commit — and the
// second is `upgrade` from a hand clone, the way F5 runs `init`. The
// `owner/name` is derived from the release URL, as the shim derives it.
const RELEASE_REPO = RELEASE_URL.replace(/^[a-z]+:\/\/[^/]+\//, "").replace(/\.git$/, "");

const unfetchableRemedy =
  "find a release's full SHA with " +
  `\`gh api --paginate repos/${RELEASE_REPO}/tags --jq '.[] | "\\(.commit.sha) \\(.name)"'\` ` +
  "and copy the SHA on its `vN` line onto the tool-sha line, or run `upgrade --to vN` from a " +
  "hand clone of speepobox";

const lineNo = (index: number): string => `line ${index + 1}`;

export const renderPinRefusal = PinRefusal.$match({
  NoLine: () =>
    "no tool-sha line in .speepobox/config.toml — run `init` (from a hand clone, on a fresh " +
    `repo), or add the line \`${EXPECTED_PIN_LINE}\``,
  Malformed: ({ index, text }) =>
    `${lineNo(index)} of .speepobox/config.toml is a tool-sha line the pin grammar cannot read ` +
    `(\`${text}\`) — write it exactly as \`${EXPECTED_PIN_LINE}\`: unindented, double-quoted, ` +
    "with no trailing comment",
  Duplicated: ({ indices }) =>
    `${indices.length} tool-sha lines in .speepobox/config.toml ` +
    `(${indices.map(lineNo).join(", ")}) — keep one`,
  Empty: ({ index }) =>
    `the tool-sha pin on ${lineNo(index)} of .speepobox/config.toml is empty — ${unfetchableRemedy}`,
  Short: ({ index, value }) =>
    `the tool-sha pin on ${lineNo(index)} of .speepobox/config.toml (\`${value}\`) is not a ` +
    `full 40-hex SHA — ${unfetchableRemedy}`,
});

// The text with line `index` — the one `pinLineIn` located — replaced by the
// grammar's own spelling of `sha` (T128). Every other byte stands: the split
// is the grammar's, on `\n` alone, so a `\r` stays on the line it ended and a
// trailing newline is the empty last element it was. The located line itself
// carries no `\r`, since the grammar refuses one there.
export const withPin = (text: string, index: number, sha: string): string =>
  linesOf(text)
    .map((line, at) => (at === index ? `tool-sha = "${sha}"` : line))
    .join("\n");
