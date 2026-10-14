// The editor bracket (T84): the dispatcher's own editor, opened on a
// commented template, and what they left in it handed back as text. It is
// `--feedback-edit`'s whole mechanism, and T85's task and resume rows enter
// through this same function — **one editor flow, not two** (22).
//
// Two properties are the reason it is a bracket rather than three calls:
//
//  1. The temp file is acquired and released inside a `Scope`, so the window
//     bash leaves open (`run.sh:920`-`1189`, one of the two SPEC §4 says close
//     for free here) is closed by construction — a Ctrl-C in the editor, a
//     refusal on the way out, and an ordinary save all remove it on the same
//     path. The finalizer never fails the scope (design rule 4): a file that
//     is already gone is the state it wanted.
//  2. The editor is the one child that **inherits the terminal**
//     (`execInteractive`), because it is driven by the person who typed the
//     command rather than read by us.
import { FileSystem } from "@effect/platform";
import type { CommandExecutor } from "@effect/platform/CommandExecutor";
import type { PlatformError } from "@effect/platform/Error";
import { Data, Effect, Option, type Scope } from "effect";
import { Git, type GitError } from "../git/git.ts";
import { type ExecError, execInteractive } from "../internal/exec.ts";

// The dispatcher gave nothing back: the editor exited nonzero (they quit it),
// or everything they left was the header this wrote for them. Git applies the
// identical rule to an empty commit message, and bash to this flag — better to
// stop loudly than to run an agent on no instructions because an editor closed
// wrong.
//
// It is a refusal about the *dispatcher's* input, which is why the caller
// turns it into a `GuardRefused` (`dispatch/guards.ts`): nothing is held when
// it arrives, and nothing may be held after it.
export class EditorCancelled extends Data.TaggedError("EditorCancelled")<{
  readonly detail: string;
}> {}

export interface EditRequest {
  // The repo this invocation serves — whose git resolves the editor, and whose
  // `core.editor` is one link of that chain (T27: every git operation names
  // the repo it runs in).
  readonly repo: string;
  // Where the file lives: `<runtimeRoot>/<purpose>-edit-<pid>-XXXXXX/<purpose>-edit.txt`.
  // The runtime root is where this tool writes (T57), and it is a directory
  // the dispatcher can find again if a hard kill ever outran the finalizer —
  // `$TMPDIR` would put the one artifact of a failed dispatch somewhere the
  // tool does not own.
  readonly runtimeRoot: string;
  // What the file is for — `feedback`, `task` — and so what its name says, so
  // a dispatcher who meets one left behind can tell what it was. It is not the
  // whole name: two sessions open at once on one host (two pickers, a picker
  // beside `--feedback-edit`) would write one path, and whichever closed first
  // would remove the file under the other's editor.
  readonly purpose: string;
  // What the text is for, git-commit style — one entry per line, each written
  // into the file behind a `# `. The sentence about stripping is this module's
  // and is appended to it: it describes what the bracket does rather than what
  // the caller wanted.
  readonly header: ReadonlyArray<string>;
  // The noun the refusal uses when nothing came back — `feedback` here, the
  // task at T85. The file is not what the dispatcher is told about; what they
  // were writing is.
  readonly what: string;
  // What an empty text does, in the template's last line. Absent, it aborts
  // the dispatch — `--feedback-edit`'s rule. The picker's two editors (T85)
  // say their own: an empty task returns to the source step, and empty
  // feedback on a resume is no feedback. The bracket answers `EditorCancelled`
  // either way; what that means is the caller's, and the file only has to
  // tell the dispatcher which.
  readonly empty?: string;
}

// git-commit style: an empty first line, then every line of the header behind
// a `# `, a blank comment line, and the notice. Editors open at line 1, so the
// dispatcher types above the comments, as in `git commit` — bash writes the
// comments first (`run.sh:1164`), and text typed there lands on the header's
// first line, which the strip keeps whole (T95).
export const templateFor = ({
  header,
  what,
  empty = "aborts the dispatch",
}: Pick<EditRequest, "header" | "what" | "empty">): string =>
  [...header, "", `lines starting with '#' are stripped; an empty ${what} ${empty}`]
    .map((line) => (line === "" ? "#" : `# ${line}`))
    .reduce((file, line) => `${file}${line}\n`, "\n");

// What the dispatcher meant, out of what the file holds: every line opening
// with `#` dropped, the rest trimmed of surrounding blank space
// (`tasklib.py:508`). `startsWith` and not a trimmed test, exactly as bash
// spells it — an indented `#` is a line the dispatcher wrote and meant, and a
// filter that guessed otherwise would silently eat a markdown heading in a
// code block.
//
// Pure, so the rule is tested without an editor (SPEC §2).
export const stripComments = (raw: string): string =>
  raw
    .split("\n")
    .filter((line) => !line.startsWith("#"))
    .join("\n")
    .trim();

// One line for whatever stopped the bracket, so a caller's refusal reads the
// same whichever of the four it was: the dispatcher cancelling, the editor not
// running at all, git unable to name one, or the runtime root unable to hold a
// file. The first is the case this exists for; the other three are failures of
// the world that still hold nothing, and a caller that let one escape would
// hand a dispatcher a run-time failure for something they can fix at the door
// (T5).
export const editFailed = (
  error: EditorCancelled | ExecError | GitError | PlatformError,
): string => ("detail" in error ? error.detail : error.message);

// What marks a directory as an editor session, whatever its purpose.
export const EDIT_MARKER = "-edit-";

// Whose session a directory under the runtime root was, off its name alone —
// the one parser `gc`'s listing and its `--force` share (T108, T109).
// `<purpose>-edit-<pid>-<suffix>` is `Some(pid)`; a pre-T108
// `<purpose>-edit-<suffix>` carries no pid and is `None`, as is a name that
// is not an editor session at all. Parsed from the right: the random suffix
// alone can be all digits (`feedback-edit-482913`), so "digits after
// `-edit-`" would judge a legacy directory by a number nobody wrote as a pid.
export const editorDirPid = (name: string): Option.Option<number> => {
  const marker = name.lastIndexOf(EDIT_MARKER);
  if (marker < 0) {
    return Option.none();
  }
  const segments = name.slice(marker + EDIT_MARKER.length).split("-");
  if (segments.length !== 2) {
    return Option.none();
  }
  const [pid = "", suffix = ""] = segments;
  return /^\d+$/.test(pid) && Number(pid) > 0 && suffix !== ""
    ? Option.some(Number(pid))
    : Option.none();
};

export const editText = ({
  repo,
  runtimeRoot,
  purpose,
  header,
  what,
  empty,
}: EditRequest): Effect.Effect<
  string,
  EditorCancelled | ExecError | GitError | PlatformError,
  Git | FileSystem.FileSystem | CommandExecutor | Scope.Scope
> =>
  Effect.gen(function* () {
    const git = yield* Git;
    const fs = yield* FileSystem.FileSystem;
    // First, and before the file exists: an editor git cannot name is a
    // refusal that leaves nothing behind at all.
    const editor = yield* git.editor({ repo });
    // The session's own directory, its unique suffix minted by `FileSystem`
    // (`mkdtemp`) rather than made here out of the clock. The prefix carries
    // this process's pid, which is what lets `gc` tell a session a kill
    // stranded from one still open (T108) without judging it by age. The pid
    // is read here rather than at the composition root on the lock's reasoning
    // (`lock/run-lock.ts`): the directory names *this* process, and there is
    // no other process whose identity it could honestly carry. A directory and
    // not a flat file because that is what `mkdtemp` makes atomically; the
    // file inside carries the purpose in its own name too, which is the one
    // the editor shows.
    const pid = yield* Effect.sync(() => process.pid);
    const session = yield* Effect.acquireRelease(
      fs
        .makeDirectory(runtimeRoot, { recursive: true })
        .pipe(
          Effect.zipRight(
            fs.makeTempDirectory({ directory: runtimeRoot, prefix: `${purpose}-edit-${pid}-` }),
          ),
        ),
      // The whole reason this is a bracket. `force` because the finalizer owes
      // the scope a success and a file already gone is what it wanted anyway
      // (design rule 4), and `ignore` because an undeletable one is not a
      // reason to fail a dispatch that has otherwise resolved.
      (made) => fs.remove(made, { recursive: true, force: true }).pipe(Effect.ignore),
    );
    const file = `${session}/${purpose}-edit.txt`;
    yield* fs.writeFileString(
      file,
      templateFor({ header, what, ...(empty === undefined ? {} : { empty }) }),
    );

    // As git invokes it (`run.sh:1172`): the resolved value is *shell text*
    // and can carry arguments — `code --wait` is the common one — so it is the
    // body of a one-line `sh -c` with the file as `"$1"`, never argv of a
    // binary whose name would then be `code --wait`. This is not
    // `Command.runInShell`, which is banned and is a different thing: the
    // child is a named `sh` with an argv this builds, and the only word of
    // shell in it is the one git answered with.
    const exit = yield* execInteractive("sh", "-c", `${editor} "$1"`, "-", file);
    if (exit !== 0) {
      return yield* new EditorCancelled({
        detail: `the editor exited ${exit} — aborted before any container started`,
      });
    }

    // Read back rather than remembered: what the dispatcher saved is the file,
    // and the template above is only what they started from.
    const text = stripComments(yield* fs.readFileString(file));
    return text === ""
      ? yield* new EditorCancelled({
          detail: `empty ${what} — aborted before any container started`,
        })
      : text;
  });
