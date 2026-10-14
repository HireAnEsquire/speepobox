// `Sandbox`, recording (T15): every operation on this tag reaches dockerd, so
// every one of them records and nothing is spawned. There is no read to keep
// real here — `run`, `exec`, `remove`, and `build` all change the daemon's
// world — which is why this layer stands on its own rather than over
// `SandboxLive`.
//
// The two events stay exactly where the live layer emits them, on the
// **ambient** `Reporter` that `run`'s signature carries: the sandbox is
// acquired inside the run log's bracket, and a rehearsal that moved its
// acquire/release pair to a layer-captured reporter would report a different
// ordering than the run it is rehearsing (SPEC §11's assertion reads exactly
// this pair). `exec`, `remove`, and `build` have no ambient reporter to reach for — the
// tag's shape says so — so they use the one this layer was built over, which
// is the console.
import { Effect, Layer } from "effect";
import { Reporter, type ReporterShape } from "../reporter.ts";
import { Sandbox, type SandboxHandle, type SandboxShape } from "../sandbox/sandbox.ts";
import { renderRunArgs, type SandboxSpec } from "../sandbox/spec.ts";
import { recorded } from "./record.ts";

// What a container that was never started is called. The live layer reads the
// id docker printed and falls back to the name it just gave the container when
// the daemon says nothing — a rehearsal is that same case with nothing to
// read, so every later call addresses the name the plan derived (T22's rule is
// about a daemon that *has* an id to give).
export const recordedHandle = (spec: SandboxSpec): SandboxHandle => ({
  name: spec.name,
  id: spec.name,
});

// The argv the live layer would have handed docker, rendered by the same
// function it uses — so the line a dispatcher reads is the sandbox this run
// would really have started, caps, mounts, and all, rather than a second
// description of one. The credential is a name in that argv and never a value
// (T23), which is what makes it printable at all.
const startDetail = (spec: SandboxSpec): string =>
  `start the sandbox '${spec.name}' from image '${spec.image}': docker ${renderRunArgs(spec).join(" ")}`;

export const recordingSandbox = (reporter: ReporterShape): SandboxShape => ({
  run: (spec) =>
    Effect.gen(function* () {
      const ambient = yield* Reporter;
      return yield* Effect.acquireRelease(
        recorded(ambient, startDetail(spec)).pipe(
          Effect.zipRight(ambient.emit({ _tag: "ResourceAcquired", resource: "sandbox" })),
          Effect.as(recordedHandle(spec)),
        ),
        (handle) =>
          recorded(ambient, `remove the sandbox '${handle.name}'`).pipe(
            Effect.zipRight(ambient.emit({ _tag: "ResourceReleased", resource: "sandbox" })),
          ),
      );
    }),
  remove: (handle) => recorded(reporter, `remove the sandbox '${handle.name}'`),
  // The setup hook and every agent pass come through here (T7, T9), so this is
  // the operation that keeps a rehearsal from running anything: the command is
  // said, its stdin is not — a prompt is sixty lines and the pass that
  // assembled it already logged it verbatim.
  exec: (handle, command) =>
    recorded(reporter, `run '${command.join(" ")}' in the sandbox '${handle.name}'`),
  // Here because the recording layer implements the whole tag (T111), not
  // because anything rehearses a build: `image build` refuses `--dry-run`.
  // Said in the tag's vocabulary, and nothing of the spec's `onOutput` is
  // called — there is no build to narrate.
  build: (spec) =>
    recorded(reporter, `build the image '${spec.tag}' from ${spec.dockerfile} in ${spec.context}`),
});

export const SandboxRecordingLive: Layer.Layer<Sandbox, never, Reporter> = Layer.effect(
  Sandbox,
  Effect.map(Reporter, recordingSandbox),
);
