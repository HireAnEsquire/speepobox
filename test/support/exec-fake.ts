// A scripted CommandExecutor — the layer seam the subprocess chokepoint keeps
// open. Commands are matched by their rendered argv prefix; anything
// unscripted behaves like a missing binary. Pass `recorded` to capture every
// argv a command actually ran, which is how "runs no git, changes no docker
// state" becomes an assertion rather than an intention.
import { CommandExecutor } from "@effect/platform";
import { SystemError } from "@effect/platform/Error";
import { Effect, HashMap, Layer, Ref, Sink, Stream } from "effect";
import { NodeInspectSymbol } from "effect/Inspectable";

export interface ScriptedResult {
  readonly exit?: number;
  readonly stdout?: string;
  readonly stderr?: string;
  // A child that never exits — the shape a pass that outruns its budget has
  // (matrix row 9). Its streams still end; only the wait does not, which is
  // what a caller's own timeout has to survive.
  readonly hangs?: boolean;
  // A child whose point is what it does to the world rather than what it says
  // (T84): the editor, which answers on stdout to nobody and is scripted by
  // what it leaves in the file it was handed. It runs before the process is
  // answered, so a caller reading the file back after the exit reads what this
  // wrote — and it is handed the argv, because the file is the *last* word of
  // it and a fixture that hard-coded the path would not be asserting that.
  readonly onSpawn?: (args: ReadonlyArray<string>) => Effect.Effect<void>;
}

export const fakeProcess = (result: ScriptedResult): CommandExecutor.Process => ({
  [CommandExecutor.ProcessTypeId]: CommandExecutor.ProcessTypeId,
  pid: CommandExecutor.ProcessId(1),
  exitCode:
    result.hangs === true
      ? Effect.never
      : Effect.succeed(CommandExecutor.ExitCode(result.exit ?? 0)),
  isRunning: Effect.succeed(false),
  kill: () => Effect.void,
  stdin: Sink.drain,
  stdout: Stream.make(new TextEncoder().encode(result.stdout ?? "")),
  stderr: Stream.make(new TextEncoder().encode(result.stderr ?? "")),
  toJSON: () => ({}),
  toString: () => "FakeProcess",
  [NodeInspectSymbol]: () => "FakeProcess",
});

export const scriptedExecutor = (
  script: Record<string, ScriptedResult>,
  recorded?: Ref.Ref<ReadonlyArray<string>>,
  // What was fed to each child's **stdin**, in spawn order. The pair with
  // `recorded` is the whole assertion behind "the prompt travels on stdin,
  // never as a shell string" (T9): one ref holds every word of argv, the other
  // holds what only the pipe carried.
  fed?: Ref.Ref<ReadonlyArray<string>>,
  // The environment each child was given, in the same spawn order — the third
  // thing a spawn carries, and the only one that can hold a secret without
  // holding it in argv (T23). It is what turns "the credential reaches the
  // `docker` child and no other" into an assertion.
  environments?: Ref.Ref<ReadonlyArray<Record<string, string>>>,
): Layer.Layer<CommandExecutor.CommandExecutor> =>
  Layer.succeed(
    CommandExecutor.CommandExecutor,
    CommandExecutor.makeExecutor((command) => {
      if (command._tag !== "StandardCommand") {
        return Effect.die("piped commands are not expected here");
      }
      const rendered = [command.command, ...command.args].join(" ");
      const remember = (
        recorded === undefined
          ? Effect.void
          : Ref.update(recorded, (current) => [...current, rendered])
      ).pipe(
        Effect.zipRight(
          environments === undefined
            ? Effect.void
            : Ref.update(environments, (current) => [
                ...current,
                Object.fromEntries(HashMap.entries(command.env)),
              ]),
        ),
        Effect.zipRight(
          fed === undefined || typeof command.stdin === "string"
            ? Effect.void
            : Stream.mkString(Stream.decodeText(command.stdin)).pipe(
                Effect.orElseSucceed(() => ""),
                Effect.flatMap((input) => Ref.update(fed, (current) => [...current, input])),
              ),
        ),
      );
      return remember.pipe(
        Effect.flatMap(() => {
          const match = Object.entries(script).find(([prefix]) => rendered.startsWith(prefix));
          return match === undefined
            ? Effect.fail(
                new SystemError({
                  reason: "NotFound",
                  module: "Command",
                  method: "spawn",
                  description: `ENOENT: ${rendered}`,
                }),
              )
            : (match[1].onSpawn?.(command.args) ?? Effect.void).pipe(
                Effect.as(fakeProcess(match[1])),
              );
        }),
      );
    }),
  );
