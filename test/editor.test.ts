// The editor bracket (T84): the file the dispatcher is handed, what comes
// back out of it, and — the property the whole shape exists for — that the
// file is gone whichever way the bracket ends.
//
// The editor is scripted as a `CommandExecutor` entry that writes the file it
// was handed as its **last argument**, which is how a fake editor is a fake
// editor at all: a scripted exit code alone would assert nothing about the
// file the caller then reads back.
import { describe, expect, it } from "@effect/vitest";
import { FileSystem } from "@effect/platform";
import { SystemError } from "@effect/platform/Error";
import { NodeContext } from "@effect/platform-node";
import { Effect, Either, Exit, Layer, Option, Ref, Scope } from "effect";
import { GitError } from "../src/git/git.ts";
import { ExecError } from "../src/internal/exec.ts";
import {
  editFailed,
  editorDirPid,
  EditorCancelled,
  editText,
  stripComments,
  templateFor,
} from "../src/prompt/editor.ts";
import { editorFileUnder, editorInvocationUnder } from "./support/editor-file.ts";
import { type ScriptedResult, scriptedExecutor } from "./support/exec-fake.ts";
import { fakeGit, type GitCall } from "./support/git-fake.ts";

const REPO_ROOT = "/srv/hae";
const BRANCH = "speepobox-t84";
const PURPOSE = "feedback";
// What `git var GIT_EDITOR` answers here, and therefore the head of the `sh`
// argv the bracket builds. Two words, because an editor that carries its own
// arguments is the case the `sh -c` invocation exists for.
const EDITOR = "fake-editor --wait";
const TEXT = "use the smaller diff";

// An editor that leaves `lines` in the file it was handed, and exits 0 — the
// dispatcher saving. `args` is the argv the bracket spawned, so the file is
// read off the last word rather than out of the fixture.
const editorWriting = (lines: ReadonlyArray<string>, exit = 0): ScriptedResult => ({
  exit,
  onSpawn: (args) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const file = args[args.length - 1] ?? "";
      // Appended to what the bracket prefilled, which is what an editor does:
      // the header is still in the file, and stripping it is the caller's job.
      const prefilled = yield* fs.readFileString(file);
      yield* fs.writeFileString(file, `${prefilled}${lines.join("\n")}\n`);
    }).pipe(Effect.provide(NodeContext.layer), Effect.orDie),
});

interface Edited {
  readonly outcome: Either.Either<string, { readonly _tag: string; readonly detail?: string }>;
  readonly commands: ReadonlyArray<string>;
  readonly gitCalls: ReadonlyArray<GitCall>;
  readonly runtimeRoot: string;
}

// One pass through the bracket, over a scratch runtime root, with the editor
// scripted. The scope is closed before anything is asserted — the file's
// removal is the finalizer's, so a case that looked while the scope was open
// would be asserting the wrong moment.
const edit = (
  editor: ScriptedResult,
  options: { readonly editorFails?: string } = {},
): Effect.Effect<Edited, never, FileSystem.FileSystem | Scope.Scope> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const runtimeRoot = yield* fs.makeTempDirectoryScoped();
    const commands = yield* Ref.make<ReadonlyArray<string>>([]);
    const gitCalls = yield* Ref.make<ReadonlyArray<GitCall>>([]);
    const outcome = yield* Effect.scoped(
      Effect.either(
        editText({
          repo: REPO_ROOT,
          runtimeRoot,
          purpose: PURPOSE,
          header: [`feedback for '${BRANCH}'`],
          what: "feedback",
        }),
      ),
    ).pipe(
      Effect.provide(
        // The two fakes **over** `NodeContext`, never beside it: the fake
        // `Git` needs the real filesystem, and the scripted executor has to
        // win the `CommandExecutor` tag from the real one — a merge that let
        // the real one through would spawn the dispatcher's own editor from a
        // test.
        Layer.provideMerge(
          Layer.mergeAll(
            fakeGit(gitCalls, { editor: EDITOR, ...options }),
            scriptedExecutor({ "sh -c": editor }, commands),
          ),
          NodeContext.layer,
        ),
      ),
    );
    return {
      outcome,
      commands: yield* Ref.get(commands),
      gitCalls: yield* Ref.get(gitCalls),
      runtimeRoot,
    };
  }).pipe(Effect.orDie);

const gone = (result: Edited): Effect.Effect<void, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    expect(yield* fs.readDirectory(result.runtimeRoot).pipe(Effect.orDie)).toEqual([]);
  });

describe("the template and the strip", () => {
  it("says what the text is for and what happens to a # line", () => {
    const template = templateFor({ header: [`feedback for '${BRANCH}'`], what: "feedback" });
    expect(template.split("\n")).toEqual([
      "",
      `# feedback for '${BRANCH}'`,
      "#",
      "# lines starting with '#' are stripped; an empty feedback aborts the dispatch",
      "",
    ]);
    // Every line of it is a comment, so a dispatcher who saves it untouched
    // has written nothing — which is the abort, not a run whose feedback is
    // this file's own instructions.
    expect(stripComments(template)).toBe("");
  });

  // The picker's editors (T85) do something else with an empty text, and the
  // file says so rather than threatening an abort that will not happen.
  it("says what an empty text does when the caller names it", () => {
    expect(
      templateFor({ header: ["h"], what: "feedback", empty: "means no feedback" }).split("\n")[3],
    ).toBe("# lines starting with '#' are stripped; an empty feedback means no feedback");
  });

  // The editor opens at line 1, and that line is empty (T95): what the
  // dispatcher types first is a line of its own, not the front of a comment.
  it("keeps text typed on the first line, with every comment left in place", () => {
    const template = templateFor({ header: [`feedback for '${BRANCH}'`], what: "feedback" });
    expect(stripComments(`x${template}`)).toBe("x");
  });

  it("drops # lines and trims, and keeps an indented # the dispatcher wrote", () => {
    expect(stripComments("# header\n\nuse the smaller diff\n\n# trailing\n")).toBe(
      "use the smaller diff",
    );
    // `startsWith`, as bash spells it: an indented `#` is a line somebody
    // typed on purpose — a markdown heading in a fenced block, most often.
    expect(stripComments("# header\nas in:\n    # a heading in a code block\n")).toBe(
      "as in:\n    # a heading in a code block",
    );
    // Blank space around the text goes; blank space inside it is the
    // dispatcher's paragraphing.
    expect(stripComments("\n\nfirst\n\nsecond\n\n")).toBe("first\n\nsecond");
  });
});

describe("whose session an editor directory was", () => {
  it("reads the pid off a session named for its process", () => {
    expect(editorDirPid("feedback-edit-4321-a1B2c3")).toEqual(Option.some(4321));
    // A suffix that is all digits is still the suffix, not a second pid.
    expect(editorDirPid("task-edit-4321-482913")).toEqual(Option.some(4321));
  });

  // Pre-T108: one segment after `-edit-`, and an all-digit suffix is the
  // case a left-to-right read would mistake for a pid.
  it("reads no pid off a session named before the pid was", () => {
    expect(editorDirPid("feedback-edit-a1B2c3")).toEqual(Option.none());
    expect(editorDirPid("feedback-edit-482913")).toEqual(Option.none());
  });

  it("reads no pid off a name that is not an editor session", () => {
    expect(editorDirPid("checkouts")).toEqual(Option.none());
    expect(editorDirPid("feedback-4321-a1B2c3")).toEqual(Option.none());
  });
});

describe("the editor bracket", () => {
  it.scoped("hands back what the dispatcher wrote, and removes the file", () =>
    Effect.gen(function* () {
      const result = yield* edit(editorWriting(["# a comment of their own", "", TEXT]));

      expect(result.outcome).toEqual(Either.right(TEXT));
      // The editor git named, invoked as git invokes it: shell text with the
      // file as `"$1"`, so an editor carrying its own arguments arrives whole.
      // The file is under the runtime root, in a directory minted for this
      // session, and named for what it is for.
      expect(result.commands).toEqual([
        expect.stringMatching(editorInvocationUnder(EDITOR, result.runtimeRoot, PURPOSE)),
      ]);
      // And the editor was *asked of git*, in the repo this dispatch serves —
      // never resolved here out of an environment variable.
      expect(result.gitCalls).toEqual([{ _tag: "Editor", repo: REPO_ROOT }]);
      yield* gone(result);
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  // The session directory names the process that opened it (T108), so `gc`
  // can tell one a kill stranded from one still open by its name alone.
  it.scoped("names the session directory for this process", () =>
    Effect.gen(function* () {
      const result = yield* edit(editorWriting([TEXT]));

      const file = result.commands[0]?.split(" ").at(-1) ?? "";
      const session = file.slice(0, file.lastIndexOf("/"));
      expect(session.slice(session.lastIndexOf("/") + 1)).toMatch(
        new RegExp(`^${PURPOSE}-edit-${process.pid}-`),
      );
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("refuses an editor that left nothing but the header", () =>
    Effect.gen(function* () {
      const result = yield* edit(editorWriting([]));

      expect(Either.isLeft(result.outcome)).toBe(true);
      if (Either.isLeft(result.outcome)) {
        expect(result.outcome.left._tag).toBe("EditorCancelled");
        expect(result.outcome.left.detail).toBe(
          "empty feedback — aborted before any container started",
        );
      }
      yield* gone(result);
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  // The dispatcher quit rather than saved. What they left in the file is not
  // consulted at all — the exit code is the answer, as it is for a commit.
  it.scoped("refuses an editor that exited nonzero, whatever the file holds", () =>
    Effect.gen(function* () {
      const result = yield* edit(editorWriting([TEXT], 1));

      expect(Either.isLeft(result.outcome)).toBe(true);
      if (Either.isLeft(result.outcome)) {
        expect(result.outcome.left._tag).toBe("EditorCancelled");
        expect(result.outcome.left.detail).toContain("the editor exited 1");
      }
      yield* gone(result);
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  // git refusing to name an editor is a failure of the world rather than the
  // dispatcher cancelling — and it happens before the file exists, so there is
  // nothing to remove and nothing was spawned.
  it.scoped("fails before it writes anything when git cannot name an editor", () =>
    Effect.gen(function* () {
      const result = yield* edit(editorWriting([TEXT]), {
        editorFails: "fatal: Terminal is dumb, but EDITOR unset",
      });

      expect(Either.isLeft(result.outcome)).toBe(true);
      if (Either.isLeft(result.outcome)) {
        expect(result.outcome.left._tag).toBe("GitError");
      }
      expect(result.commands).toEqual([]);
      yield* gone(result);
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  // Two sessions open at once under one runtime root — two pickers, or a
  // picker beside a `--feedback-edit` dispatch. The file outlives the editor
  // until its scope closes, so holding both scopes open is holding both
  // sessions open: each gets a path of its own, named for what it is for, and
  // closing one leaves the other's file under its editor.
  it.scoped("gives two sessions open at once two files, and closes each alone", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const runtimeRoot = yield* fs.makeTempDirectoryScoped();
      const commands = yield* Ref.make<ReadonlyArray<string>>([]);
      const gitCalls = yield* Ref.make<ReadonlyArray<GitCall>>([]);
      const world = Layer.provideMerge(
        Layer.mergeAll(
          fakeGit(gitCalls, { editor: EDITOR }),
          scriptedExecutor({ "sh -c": editorWriting([TEXT]) }, commands),
        ),
        NodeContext.layer,
      );
      const open = (purpose: string, scope: Scope.CloseableScope) =>
        editText({ repo: REPO_ROOT, runtimeRoot, purpose, header: ["h"], what: purpose }).pipe(
          Scope.extend(scope),
          Effect.provide(world),
          Effect.orDie,
        );

      const feedbackScope = yield* Scope.make();
      const taskScope = yield* Scope.make();
      expect(yield* open("feedback", feedbackScope)).toBe(TEXT);
      expect(yield* open("task", taskScope)).toBe(TEXT);
      // The file is the last word of each spawn, in the order they opened.
      const [feedbackFile, taskFile] = (yield* Ref.get(commands)).map(
        (command) => command.split(" - ")[1] ?? "",
      );

      expect(feedbackFile).toMatch(editorFileUnder(runtimeRoot, "feedback"));
      expect(taskFile).toMatch(editorFileUnder(runtimeRoot, "task"));
      expect(feedbackFile).not.toBe(taskFile);
      expect(yield* fs.exists(feedbackFile ?? "")).toBe(true);
      expect(yield* fs.exists(taskFile ?? "")).toBe(true);

      yield* Scope.close(taskScope, Exit.void);
      expect(yield* fs.exists(taskFile ?? "")).toBe(false);
      expect(yield* fs.exists(feedbackFile ?? "")).toBe(true);

      yield* Scope.close(feedbackScope, Exit.void);
      expect(yield* fs.readDirectory(runtimeRoot)).toEqual([]);
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  // One line for each of the four, so the caller's refusal reads the same
  // whichever stopped it. The fourth is the one the shape test is really
  // about: a `PlatformError` carries no `detail` and spells its line as a
  // **getter on the prototype**, so the `"detail" in error` branch has to fall
  // through to `message` rather than render `undefined` into a dispatcher's
  // refusal.
  it("names every failure in one line", () => {
    expect(editFailed(new EditorCancelled({ detail: "empty feedback" }))).toBe("empty feedback");
    expect(editFailed(new ExecError({ command: "sh", detail: "ENOENT: sh" }))).toBe("ENOENT: sh");
    expect(editFailed(new GitError({ detail: "fatal: Terminal is dumb" }))).toBe(
      "fatal: Terminal is dumb",
    );
    const platform = new SystemError({
      reason: "PermissionDenied",
      module: "FileSystem",
      method: "writeFileString",
      pathOrDescriptor: "/runtime/feedback-edit-a1b2c3/feedback-edit.txt",
    });
    expect(editFailed(platform)).toBe(platform.message);
    expect(editFailed(platform)).not.toContain("undefined");
  });
});
