// `Sandbox` (SPEC §2): the run's third resource, and the one whose leak the
// behaviour inventory documents. **Scoped in the interface, not at the call
// site** — `run` hands back a `Scope`-bound container, so `docker rm -f` is a
// finalizer the runtime owes rather than a line a caller can forget.
//
// Named for its role: this layer *is* the docker implementation the spec calls
// `Sandbox.dockerLayer`, and **no provider abstraction is built** — the tag is
// the seam (05 Q22). It talks to the subprocess chokepoint directly, with no
// wrapper in between.
//
// `run`, `remove`, `exec`, and `build` are the whole surface. `exec` landed
// with its first caller — T7's setup hook — rather than ahead of it, because a
// method with no consumer is a layer rather than a tracer bullet; `build`
// landed with `speepobox image build` (T111).
import { CommandExecutor } from "@effect/platform";
import { Context, Data, Effect, Layer, Schema, type Scope } from "effect";
import {
  type ChildSecret,
  type ExecOutcome,
  type ExecResult,
  execStreamed,
  execWith,
  type StreamedIo,
} from "../internal/exec.ts";
import { Reporter } from "../reporter.ts";
import { renderBuildArgs, renderRunArgs, type SandboxBuildSpec, type SandboxSpec } from "./spec.ts";

// Container create / exec / remove failures (SPEC §3). Typed, by the
// outcome-row test: a sandbox that will not start is a run that started and
// owes a `failed` row at stage `sandbox` (matrix row 6).
export class SandboxError extends Data.TaggedError("SandboxError")<{
  readonly detail: string;
  // Whether the container this error came from is still there. Only `exec`
  // ever answers `true` — it is the one operation that can fail *because* the
  // sandbox went away underneath it (T22).
  readonly sandboxGone: boolean;
}> {}

// What a started sandbox is, as a domain value (SPEC §5). The name is for
// humans and for logs; the id is what every later docker call addresses.
// Ownership is neither of them — it is the label pair, always (design rule 3).
export const SandboxHandle = Schema.Struct({
  name: Schema.String,
  id: Schema.String,
});
export type SandboxHandle = Schema.Schema.Type<typeof SandboxHandle>;

// The halves a conversation with a long-running command needs (T9). The two
// sinks are required when the record is given at all; the prompt is not
// (T90): the setup hook has output worth a log line and nothing to read, and a
// command with nothing to read gets no `-i` held open for it.
export interface SandboxExecOptions {
  // Delivered on the command's **stdin**, never as a word of the command
  // itself, so quotes, backticks, and `$(…)` in it arrive literally
  // (`run.sh:1153`). This is the property `--feedback` rests on in T17.
  // Absent is no `-i` at all, which is what the setup hook asks for.
  readonly stdin?: string;
  // Each line of the command's stdout, as it arrives. It is an effect rather
  // than a string handed back at the end because progress is a `Reporter`
  // event stream (05) and a pass narrates while it works.
  readonly onOutput: (line: string) => Effect.Effect<void>;
  // What the child said on **stderr**, handed over once when it exits rather
  // than line by line: stderr stays collected and never joins the narration
  // (ticket 20 §8), because on a pass that finished it is noise. It is here
  // for the one case where it is the clue — a pass whose stdout ended without
  // the result event its answer comes from (T51) — so the caller can put its
  // tail in the failure it raises. Empty when the child said nothing.
  readonly onStderr: (stderr: string) => Effect.Effect<void>;
}

export interface SandboxShape {
  // Scoped in the interface: the container is removed when the scope closes,
  // on success, on typed failure, on defect, and on interrupt alike.
  readonly run: (
    spec: SandboxSpec,
  ) => Effect.Effect<SandboxHandle, SandboxError, Scope.Scope | Reporter>;
  // The removal on its own, for the caller that has a container but not the
  // scope that made it — the reconciler (T8). `run`'s finalizer is the first
  // consumer, which is why it exists at this ticket at all.
  readonly remove: (handle: SandboxHandle) => Effect.Effect<void, SandboxError>;
  // A command inside a started container, run to completion **in the
  // foreground** (SPEC §4): every subprocess this package spawns is awaited by
  // the fiber that spawned it, which is how Effect issue #5592
  // (detached-child cleanup) is sidestepped rather than worked around — a
  // sandbox is dockerd-owned, so teardown is `run`'s explicit `docker rm -f`
  // finalizer and never a child process this one has to chase.
  //
  // It answers with nothing rather than with the chokepoint's `ExecResult`: a
  // nonzero exit is a *result* one layer down and a typed `SandboxError` here,
  // carrying the command's own stderr, which is the whole of what its one
  // caller asks — a setup hook that failed ends the run and says why.
  //
  // `options` is the widening T9's agent pass asked for, and it is about input
  // and output rather than about the answer: a pass is handed its prompt on
  // stdin and narrates for minutes, so it needs both halves of a conversation.
  // The setup hook takes the output half alone (T90), so its lines reach the
  // log, and has nothing to read. The exit is still the same typed failure — what
  // *kind* of failure a nonzero pass is stays the caller's decision
  // (`agent/agent-cli.ts` reads the error this carries), because a sandbox
  // cannot know whether its command was an agent.
  //
  // The one thing a caller cannot decide for itself is whether the container
  // is still there, so a failure from here carries that as `sandboxGone`
  // (T22): this is the only operation that can fail *because* the sandbox went
  // away mid-command, and asking the daemon is docker vocabulary, which lives
  // here and nowhere else.
  readonly exec: (
    handle: SandboxHandle,
    command: ReadonlyArray<string>,
    options?: SandboxExecOptions,
  ) => Effect.Effect<void, SandboxError>;
  // The served repo's agent image, built (T111): `docker build`, awaited in
  // the foreground as `exec` is, with every line docker prints handed to the
  // spec's `onOutput` as it arrives. A nonzero exit is a `SandboxError`
  // carrying docker's stderr. No `Reporter` in the requirements and none
  // captured: the caller's callback is what emits, so the layer cannot send
  // the build's output anywhere its caller did not choose.
  readonly build: (spec: SandboxBuildSpec) => Effect.Effect<void, SandboxError>;
}

export class Sandbox extends Context.Tag("Sandbox")<Sandbox, SandboxShape>() {}

export const SandboxLive: Layer.Layer<Sandbox, never, CommandExecutor.CommandExecutor> =
  Layer.effect(
    Sandbox,
    Effect.gen(function* () {
      // Captured here rather than left in every operation's requirements, as
      // `GitLive` does: a domain tag whose methods ask for a `CommandExecutor`
      // is mechanism leaking through the seam.
      //
      // `Reporter` is the deliberate exception and stays in `run`'s
      // requirements. It is read where the sandbox is acquired, which is
      // *inside* the run log's bracket — so the sandbox's two events reach the
      // log as the checkout's do, and its finalizer closes over that same
      // reporter. Capturing the layer's reporter here would silently send them
      // to the console only (`dispatch/run.ts` carries the ruling).
      const executor = yield* CommandExecutor.CommandExecutor;

      // Every docker call but one runs with the chokepoint's allowlist and
      // nothing else; `start` is the one, and it is spelled `dockerWith` so
      // that handing a secret to a child is written at the call site rather
      // than defaulted into every spawn (T23).
      const dockerWith = (
        secrets: ReadonlyArray<ChildSecret>,
        ...args: ReadonlyArray<string>
      ): Effect.Effect<ExecResult, SandboxError> =>
        execWith(secrets, "docker", ...args).pipe(
          Effect.mapError(
            () =>
              new SandboxError({
                detail: "docker CLI not found — install Docker Desktop / docker-ce",
                sandboxGone: false,
              }),
          ),
          Effect.provideService(CommandExecutor.CommandExecutor, executor),
        );

      const docker = (...args: ReadonlyArray<string>): Effect.Effect<ExecResult, SandboxError> =>
        dockerWith([], ...args);

      const dockerStreamed = (
        io: StreamedIo,
        ...args: ReadonlyArray<string>
      ): Effect.Effect<ExecOutcome, SandboxError> =>
        execStreamed(io, "docker", ...args).pipe(
          Effect.mapError(
            () =>
              new SandboxError({
                detail: "docker CLI not found — install Docker Desktop / docker-ce",
                sandboxGone: false,
              }),
          ),
          Effect.provideService(CommandExecutor.CommandExecutor, executor),
        );

      // A nonzero exit is a *result* at the chokepoint (`internal/exec.ts`);
      // this is the layer that decides which results are a `SandboxError`.
      //
      // `sandboxGone` defaults to `false` because only `exec` can ever answer
      // otherwise: a start that failed has no container to have lost, and a
      // removal that failed is already reported and swallowed by the finalizer
      // (design rule 4).
      const failed = (what: string, result: ExecOutcome, sandboxGone = false): SandboxError =>
        new SandboxError({
          detail: result.stderr.trim() === "" ? what : `${what}: ${result.stderr.trim()}`,
          sandboxGone,
        });

      // Asked of the daemon, on the failure path only, about the id the exec
      // addressed (T22). A container id is never reused, so this answers about
      // that exact container and cannot answer for another one wearing the
      // same name — which is what makes the second question worth asking at
      // all. The success path never asks it.
      //
      // Three readings of one flag: a nonzero exit is `No such object`, so the
      // container was removed outright; `false` is a daemon that still knows
      // it and is no longer running it; and only `true` says the container
      // outlived its command, which makes the exit the child's own. Nothing
      // here reads `.State.OOMKilled` — that flag is the *container's* OOM
      // state, and an agent killed inside a container that keeps running
      // leaves it `false`, which is the very case this is telling apart. A 137
      // in a live container is an ordinary nonzero exit.
      const sandboxGone = (handle: SandboxHandle): Effect.Effect<boolean> =>
        docker("inspect", "-f", "{{.State.Running}}", handle.id).pipe(
          Effect.map((result) => result.exitCode !== 0 || result.stdout.trim() !== "true"),
          // The question itself failing means the docker CLI stopped being
          // there between the exec and this: nothing was observed, so nothing
          // is claimed.
          Effect.orElseSucceed(() => false),
        );

      const remove = (handle: SandboxHandle): Effect.Effect<void, SandboxError> =>
        // `-fv`, as bash's cleanup does (`run.sh:1250`): kill it if it is
        // still running, and take the anonymous volumes with it.
        docker("rm", "-fv", handle.id).pipe(
          Effect.flatMap((result) =>
            result.exitCode === 0
              ? Effect.void
              : failed(`could not remove the sandbox '${handle.name}'`, result),
          ),
        );

      // `docker exec` and nothing else: no `-d`, so the CLI holds the
      // container's process open until it exits and the fiber that asked for
      // it is the one that waits. No `-u` either — a hook runs as the image's
      // own default user, and a script that needs root asks the image for it
      // (`run.sh:1361` goes through a sudoers entry scoped to one path).
      const execute = (
        handle: SandboxHandle,
        command: ReadonlyArray<string>,
        options?: SandboxExecOptions,
      ): Effect.Effect<void, SandboxError> =>
        // `-i` only where there is something to say: it is what keeps the
        // child's stdin open for the prompt, and a command with nothing to
        // read should not have one held open for it.
        (options === undefined
          ? docker("exec", handle.id, ...command)
          : dockerStreamed(
              { stdin: options.stdin ?? "", onLine: options.onOutput },
              "exec",
              ...(options.stdin === undefined ? [] : ["-i"]),
              handle.id,
              ...command,
            )
        ).pipe(
          // The stderr sink before the exit is read, and on both paths: what
          // the child said is a fact of the run, and the caller either has a
          // use for it or does not.
          Effect.tap((result) =>
            options === undefined ? Effect.void : options.onStderr(result.stderr),
          ),
          Effect.flatMap((result) =>
            result.exitCode === 0
              ? Effect.void
              : sandboxGone(handle).pipe(
                  Effect.flatMap((gone) =>
                    failed(
                      `'${command.join(" ")}' exited ${result.exitCode} in the sandbox '${handle.name}'`,
                      result,
                      gone,
                    ),
                  ),
                ),
          ),
        );

      // The one spawn in the package that is handed a value rather than a name
      // (T23). `renderRunArgs` writes `-e NAME` with no value — the token is
      // never a word of argv — so docker takes the value from *its own*
      // environment, and this is what puts it there. Everything else about the
      // credential stays as T9 left it.
      //
      // **The residual risk, stated rather than papered over** (T35): the agent
      // holds this credential because it must call the model, so anything
      // inside the container is reachable by that endpoint. The mitigation is
      // that it is the **only** credential present — no git credentials, no
      // cloud credentials, no `~/.gitconfig` with its helpers and `insteadOf`
      // rewrites, and an `origin` pointing at a host path the container does
      // not hold. The blast radius is model spend, not repository writes and
      // not cloud access.
      const start = (spec: SandboxSpec): Effect.Effect<SandboxHandle, SandboxError> =>
        dockerWith([spec.credential], ...renderRunArgs(spec)).pipe(
          Effect.flatMap((result) => {
            if (result.exitCode !== 0) {
              return failed(
                `could not start the sandbox '${spec.name}' from image '${spec.image}'`,
                result,
              );
            }
            // `docker run -d` prints the container id. Addressing it by the
            // name we just gave it is equivalent, so an empty line is a
            // quieter docker rather than a failed start.
            const id = result.stdout.trim();
            return Effect.succeed({ name: spec.name, id: id === "" ? spec.name : id });
          }),
        );

      // Both streams go to the one callback: BuildKit writes its whole progress
      // on stderr and `docker build` barely uses stdout, so a build that
      // streamed stdout alone would sit silent until it ended. Stderr is still
      // collected, and is what a failed build's error carries.
      const build = (spec: SandboxBuildSpec): Effect.Effect<void, SandboxError> =>
        dockerStreamed(
          { stdin: "", onLine: spec.onOutput, onErrLine: spec.onOutput },
          ...renderBuildArgs(spec),
        ).pipe(
          Effect.flatMap((result) =>
            result.exitCode === 0
              ? Effect.void
              : failed(`could not build the image '${spec.tag}' from ${spec.dockerfile}`, result),
          ),
        );

      return {
        run: (spec) =>
          Effect.gen(function* () {
            const reporter = yield* Reporter;
            return yield* Effect.acquireRelease(
              start(spec).pipe(
                Effect.tap(() => reporter.emit({ _tag: "ResourceAcquired", resource: "sandbox" })),
              ),
              // A finalizer never fails the scope (design rule 4, matrix row
              // 19): a container we could not remove is reported, swallowed,
              // and left to the reconciler — the run's own error reaches its
              // caller unmasked, and a `docker rm` that failed is never the
              // reason a dispatch reports failure.
              (handle) =>
                remove(handle).pipe(
                  Effect.matchEffect({
                    onSuccess: () =>
                      reporter.emit({ _tag: "ResourceReleased", resource: "sandbox" }),
                    onFailure: (error) =>
                      reporter.emit({
                        _tag: "Warned",
                        detail: `${error.detail} — it is still on this host; the next dispatch's reconciler is what clears it`,
                      }),
                  }),
                ),
            );
          }),
        remove,
        exec: execute,
        build,
      };
    }),
  );
