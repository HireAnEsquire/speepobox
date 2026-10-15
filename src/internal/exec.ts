// The subprocess chokepoint (05 Q3): the ONLY file allowed to import Command,
// enforced by scripts/check-bans.ts. It is an internal module, not a tag — a
// tag here would recreate the Shell.exec anti-pattern; the seam tests fake is
// CommandExecutor, which stays in the requirements channel.
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { Command } from "@effect/platform";
import type { CommandExecutor } from "@effect/platform/CommandExecutor";
import type { PlatformError } from "@effect/platform/Error";
import { Chunk, Data, Effect, Redacted, Stream } from "effect";

export class ExecError extends Data.TaggedError("ExecError")<{
  readonly command: string;
  readonly detail: string;
}> {}

// What every child answers with, whether or not its stdout was collected: the
// code it exited with and whatever it said on stderr. A nonzero exit is a
// *result* here and a typed error one layer up (SPEC §3).
export interface ExecOutcome {
  readonly exitCode: number;
  readonly stderr: string;
}

export interface ExecResult extends ExecOutcome {
  readonly stdout: string;
}

// The same, for the one child whose output is **framed in bytes** (T71):
// `git cat-file --batch` answers `<oid> <type> <size>` and then exactly
// `<size>` bytes, so a caller that has to find the next header counts bytes
// and not characters — an em dash is one character and three bytes. Decoding
// the whole stream to a string and re-encoding it would frame correctly right
// up until a blob that is not valid UTF-8, where the replacement character is
// a different length than the bytes it stood for and every object after it is
// read at the wrong offset.
export interface ExecBytes extends ExecOutcome {
  readonly stdout: Uint8Array;
}

// extendEnv: false is a security property, not tidiness: the default inherits
// process.env and would leak the parent environment into agent containers.
// Grow this allowlist one variable at a time, each with a note saying which
// child reads it (AGENTS.md).
// **This list forwards variables we did not read.** A value this package
// resolved for itself is not one of them and never joins it — it travels as a
// `ChildSecret` below, to the one child that needs it (T23).
const ENV_ALLOWLIST: ReadonlyArray<string> = [
  // binary resolution for every child: docker, git, gh, node
  "PATH",
  // docker CLI contexts/config, gh auth state, git global config
  "HOME",
  // The editor lookup, `git var GIT_EDITOR` (T84). Git's chain is
  // `GIT_EDITOR` → `core.editor` → `VISUAL` → `EDITOR` → `vi`, and three of
  // those five links are environment variables the *dispatcher* exported —
  // so a child that could not see them would answer `vi` to a dispatcher
  // whose `EDITOR` says otherwise, and the flag would open the wrong editor
  // while claiming git resolved it. They are forwarded rather than read:
  // nothing in `src/` asks what an editor is, it asks git.
  "GIT_EDITOR",
  "VISUAL",
  "EDITOR",
  // And the editor itself, which is the one child attached to a terminal
  // (`execInteractive` below): `vi` with no `TERM` refuses to start at all.
  // Harmless to the captured children beside it — none of them is on a
  // screen, so none of them renders anything a terminal type would change.
  "TERM",
  // The package cache, read by the shim `upgrade` runs as a child to refresh
  // the scaffold (T149): `.speepobox/speepobox init --refresh` looks for the
  // pinned release under `${XDG_CACHE_HOME:-$HOME/.cache}`, so a child that
  // could not see it would build a second cache beside the one the
  // dispatcher's own shim used.
  "XDG_CACHE_HOME",
];

// The one variable a child of ours is **given** rather than forwarded, and the
// reason it is not a name on the list above (T77): `GIT_INDEX_FILE` is the
// scratch index the status commit's tree is built in, a path this package
// derived under the runtime root's `locks/`, and the three children that read
// it — `git read-tree`, `git update-index`, `git write-tree` — are handed it
// one call at a time (`execUnder` below). Forwarding it would point every other `git` this
// package spawns at whatever index the dispatcher's shell exported, which is
// the whole difference between an allowlist entry and this: the list copies
// values we did not choose, and this carries one we did.
export const GIT_INDEX_FILE = "GIT_INDEX_FILE";

// A variable this process resolved the value of, handed to **one** child's
// environment and to nothing else (T23). The mirror image of the allowlist
// above: that one copies variables out of `process.env` for every child, this
// one carries a value we already hold to the single spawn that needs it — the
// `docker run` that starts a sandbox, whose `-e NAME` takes the value from the
// docker CLI's own environment.
//
// `Redacted` all the way in, so the value cannot be spelled by accident: the
// unwrap below is the only one that writes the token anywhere (the resolver's
// own, in `agent/credential.ts`, reads a length and keeps nothing), and a
// secret interpolated anywhere else — a command log, an error detail, an event
// — renders `<redacted>` instead of the token. It reaches the child's
// environment and never argv, which is readable by every process on the host.
export interface ChildSecret {
  readonly name: string;
  readonly value: Redacted.Redacted<string>;
}

// The same shape for a value that is **not** a secret: one variable this
// process resolved, carried to the single child that reads it (T77). It is a
// plain string rather than a `Redacted` because the one value there is — a
// path under the runtime root — is what a failed `write-tree` has to be able
// to name, and a `<redacted>` there would hide the whole of what went wrong.
export interface ChildVar {
  readonly name: string;
  readonly value: string;
}

const allowedEnv = (
  secrets: ReadonlyArray<ChildSecret>,
  variables: ReadonlyArray<ChildVar>,
): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const name of ENV_ALLOWLIST) {
    const value = process.env[name];
    if (value !== undefined) {
      env[name] = value;
    }
  }
  for (const secret of secrets) {
    env[secret.name] = Redacted.value(secret.value);
  }
  for (const variable of variables) {
    env[variable.name] = variable.value;
  }
  return env;
};

const collectText = (
  stream: Stream.Stream<Uint8Array, PlatformError>,
): Effect.Effect<string, PlatformError> => Stream.mkString(Stream.decodeText(stream));

// The chunks joined once at the end rather than concatenated as they arrive:
// a growing `Uint8Array` copies everything it already holds on every chunk,
// and the caller this exists for reads thousands of blobs in one child (T71).
const collectBytes = (
  stream: Stream.Stream<Uint8Array, PlatformError>,
): Effect.Effect<Uint8Array, PlatformError> =>
  Stream.runCollect(stream).pipe(
    Effect.map((collected) => {
      const chunks = Chunk.toReadonlyArray(collected);
      const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
      let at = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, at);
        at += chunk.length;
      }
      return bytes;
    }),
  );

// The captured child the three spellings below share: exit code and both
// streams, differing only in the environment they are given. It is one body
// rather than three, so a child that is handed a value cannot also be a child
// spawned a second way.
const captured = (
  env: Record<string, string>,
  command: string,
  args: ReadonlyArray<string>,
): Effect.Effect<ExecResult, ExecError, CommandExecutor> =>
  Command.make(command, ...args).pipe(
    Command.env(env, { extendEnv: false }),
    Command.start,
    Effect.flatMap((process_) =>
      Effect.all(
        {
          exitCode: process_.exitCode,
          stdout: collectText(process_.stdout),
          stderr: collectText(process_.stderr),
        },
        { concurrency: "unbounded" },
      ),
    ),
    Effect.scoped,
    Effect.mapError((error) => new ExecError({ command, detail: error.message })),
  );

// Runs a subprocess to completion, capturing exit code and both output
// streams. A nonzero exit is a *result*, not a failure; ExecError is reserved
// for the subprocess not running at all (missing binary, spawn failure).
// shell is never used: Command.make spawns argv directly, and runInShell is
// grep-banned on top.
export const exec = (
  command: string,
  ...args: ReadonlyArray<string>
): Effect.Effect<ExecResult, ExecError, CommandExecutor> => execWith([], command, ...args);

// The same child, plus a value only it may read (T23). It is a separate
// spelling rather than an option on `exec` so that handing a secret to a
// subprocess is a decision written at the call site: every other spawn in the
// package reads as the one above, with the allowlist and nothing more.
export const execWith = (
  secrets: ReadonlyArray<ChildSecret>,
  command: string,
  ...args: ReadonlyArray<string>
): Effect.Effect<ExecResult, ExecError, CommandExecutor> =>
  captured(allowedEnv(secrets, []), command, args);

// And the same child under **one** variable this process resolved (T77),
// spelled apart from `execWith` above for its reason: a child given a value
// is a decision written at the call site, and the two values are not the same
// kind of thing — a secret must never be read back, a scratch index path must.
export const execUnder = (
  variable: ChildVar,
  command: string,
  ...args: ReadonlyArray<string>
): Effect.Effect<ExecResult, ExecError, CommandExecutor> =>
  captured(allowedEnv([], [variable]), command, args);

// The chokepoint's third shape: a child that is **fed and then read whole**
// (T71). `git cat-file --batch` takes its object names on stdin and answers
// one framed record each, so neither of the two above can spawn it — `exec`
// writes nothing to the child, and `execStreamed` neither collects stdout nor
// keeps the framing, since splitting on lines is exactly what a record
// carrying arbitrary bytes cannot survive. The answer is `ExecBytes` for the
// same reason: the frame is counted in bytes.
//
// No secrets, and the allowlist is the ordinary one: the child is a `git` this
// package runs against a repository on this host.
export const execFed = (
  stdin: string,
  command: string,
  ...args: ReadonlyArray<string>
): Effect.Effect<ExecBytes, ExecError, CommandExecutor> =>
  Command.make(command, ...args).pipe(
    Command.env(allowedEnv([], []), { extendEnv: false }),
    Command.feed(stdin),
    Command.start,
    Effect.flatMap((process_) =>
      Effect.all(
        {
          exitCode: process_.exitCode,
          // Concurrent with the wait, as above and for the same reason: a
          // child whose output nobody drains fills its pipe and stops.
          stdout: collectBytes(process_.stdout),
          stderr: collectText(process_.stderr),
        },
        { concurrency: "unbounded" },
      ),
    ),
    Effect.scoped,
    Effect.mapError((error) => new ExecError({ command, detail: error.message })),
  );

// The same chokepoint for the one child that is *talked to* rather than only
// read: input on stdin, output consumed line by line as it arrives (T9's agent
// pass).
//
// Both halves matter. **The input travels on stdin, never as an argument**, so
// quotes, backticks, and `$(…)` in a prompt arrive literally — `Command.feed`
// writes it to the child's stdin and nothing about it is ever a word of argv.
// And stdout is *not* collected: a pass narrates for minutes, and a caller that
// wants to show that as it happens cannot be handed one string at the end. It
// is `Stream.runForEach` over the lines rather than a callback the caller polls,
// so backpressure is the stream's and the fiber that spawned the child is still
// the one awaiting it.
export interface StreamedIo {
  readonly stdin: string;
  readonly onLine: (line: string) => Effect.Effect<void>;
  // Each line of **stderr** as it arrives, for the one child whose progress is
  // written there (T111): `docker build` says everything it does on stderr, so
  // a build that streamed stdout alone would be silent until it ended. The
  // stderr is still collected either way — a failed build's error carries it.
  // Absent is stderr collected and nothing else, which is every other caller.
  readonly onErrLine?: (line: string) => Effect.Effect<void>;
}

// Stderr, collected — and, where the caller asked, handed over line by line on
// the way (T111). The lines handed over are the lines collected, so what the
// console showed and what the error carries cannot disagree.
const collectStderr = (
  stream: Stream.Stream<Uint8Array, PlatformError>,
  onErrLine: ((line: string) => Effect.Effect<void>) | undefined,
): Effect.Effect<string, PlatformError> =>
  onErrLine === undefined
    ? collectText(stream)
    : Effect.suspend(() => {
        const lines: Array<string> = [];
        return Stream.runForEach(Stream.splitLines(Stream.decodeText(stream)), (line) => {
          lines.push(line);
          return onErrLine(line);
        }).pipe(Effect.map(() => lines.join("\n")));
      });

export const execStreamed = (
  io: StreamedIo,
  command: string,
  ...args: ReadonlyArray<string>
): Effect.Effect<ExecOutcome, ExecError, CommandExecutor> =>
  Command.make(command, ...args).pipe(
    // No secrets here, and none owed: the one value this package holds crosses
    // at `docker run`, and the container carries it from then on — the streamed
    // child is a `docker exec` into a container that already has it (T23).
    Command.env(allowedEnv([], []), { extendEnv: false }),
    Command.feed(io.stdin),
    Command.start,
    Effect.flatMap((process_) =>
      Effect.all(
        {
          exitCode: process_.exitCode,
          stderr: collectStderr(process_.stderr, io.onErrLine),
          // Concurrent with the wait above, and the reason it must be: a child
          // whose output nobody drains fills its pipe and stops.
          stdout: Stream.runForEach(
            Stream.splitLines(Stream.decodeText(process_.stdout)),
            io.onLine,
          ),
        },
        { concurrency: "unbounded" },
      ),
    ),
    Effect.map(({ exitCode, stderr }) => ({ exitCode, stderr })),
    Effect.scoped,
    Effect.mapError((error) => new ExecError({ command, detail: error.message })),
  );

// The chokepoint's fourth shape, and the one that **captures nothing** (T84):
// stdin, stdout, and stderr are the dispatcher's own, inherited by the child.
// It exists for exactly one caller — the editor `--feedback-edit` opens — and
// the reason it has to exist is that every entry above it collects output: an
// editor spawned through one of those typechecks, takes the terminal away from
// itself, and hangs on a screen nobody is shown while a `Stream` waits for a
// pipe that will never end.
//
// So there is no `stdout` and no `stderr` in the answer: they went to the
// terminal as the child wrote them. What comes back is the exit code, which is
// the whole of what a caller can ask about a session it did not watch — and a
// nonzero one is a *result* here as everywhere else in this file, typed one
// layer up (`prompt/editor.ts` reads it as the dispatcher cancelling).
//
// The allowlist is the ordinary one: an editor is a program on this host run
// by the person who typed the command, and the one variable it needs beyond
// the others' — `TERM` — is named in the list above with the rest.
export const execInteractive = (
  command: string,
  ...args: ReadonlyArray<string>
): Effect.Effect<number, ExecError, CommandExecutor> =>
  Command.make(command, ...args).pipe(
    Command.env(allowedEnv([], []), { extendEnv: false }),
    Command.stdin("inherit"),
    Command.stdout("inherit"),
    Command.stderr("inherit"),
    Command.exitCode,
    Effect.mapError((error) => new ExecError({ command, detail: error.message })),
  );

// The chokepoint's fifth shape, and **the one exception in `src/`** (T153):
// a child that is started and **not** run to completion, under the parent's
// whole environment rather than the allowlist. It exists for exactly one
// caller — `detach/detach.ts`, which starts the package's own entrypoint as
// the run `--detach` hands back — and both halves of the exception are about
// what that child is.
//
// **Not run to completion**, because the point is that it outlives this
// process: node's `detached: true` puts it in a new session, so a hangup to
// the terminal that started the parent never reaches it, and it is `unref`'d
// once it has started so the parent can exit while it runs. `Command` has no
// spelling for either, which is why this entry speaks `node:child_process`.
//
// **The whole environment**, passed in by `bin.ts` from `process.env` —
// because the child is speepobox, which resolves the credential itself
// (`agent/credential.ts`) and applies the allowlist to every child *it*
// spawns. The allowlist would be wrong here: it carries no credential, by rule
// (T23), so a token exported in the dispatcher's shell would be dropped on the
// way to the one process that is supposed to resolve it. Nothing else in
// `src/` may spawn with an inherited environment.
//
// Stdin is `/dev/null`; stdout and stderr both go to `outFile`, opened for
// appending — the caller created and truncated it, and reads it back while
// the child writes.
export interface DetachedChild {
  readonly pid: number;
  // Whether the child has exited. A child this process has not reaped keeps
  // its pid, so the handle below never signals a stranger.
  readonly exited: Effect.Effect<boolean>;
  // SIGINT, and nothing else: a SIGKILL'd dispatcher skips its finalizers and
  // strands its lock and its container. A child that has already exited is
  // not signalled.
  readonly interrupt: Effect.Effect<void>;
}

export const execDetached = (
  env: Readonly<Record<string, string | undefined>>,
  outFile: string,
  command: string,
  ...args: ReadonlyArray<string>
): Effect.Effect<DetachedChild, ExecError> =>
  Effect.async<DetachedChild, ExecError>((resume) => {
    const failed = (error: unknown) =>
      Effect.fail(
        new ExecError({
          command,
          detail: error instanceof Error ? error.message : String(error),
        }),
      );
    let out: number;
    try {
      out = openSync(outFile, "a");
    } catch (error) {
      resume(failed(error));
      return;
    }
    const child = spawn(command, args, {
      detached: true,
      env: { ...env },
      stdio: ["ignore", out, out],
    });
    let settled = false;
    let exited = false;
    const settle = () => {
      settled = true;
      closeSync(out);
    };
    child.once("exit", () => {
      exited = true;
    });
    // Kept attached past the spawn: an `error` nobody listens for is thrown.
    child.on("error", (error) => {
      if (!settled) {
        exited = true;
        settle();
        resume(failed(error));
      }
    });
    child.once("spawn", () => {
      settle();
      child.unref();
      resume(
        Effect.succeed({
          pid: child.pid ?? 0,
          exited: Effect.sync(() => exited),
          interrupt: Effect.sync(() => {
            if (!exited) {
              child.kill("SIGINT");
            }
          }),
        }),
      );
    });
  });
