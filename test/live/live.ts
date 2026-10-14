// The live tier's tag, and the small harness its cases share (SPEC §11 —
// cases 1-6 so far). Host-only: these run against a real dockerd, under
// `npm run verify:live`, and the container that writes this package's code has
// no docker socket and `--cap-drop ALL`, so the agent that wrote them could
// not run them.
//
// **Host-only is the tier; a daemon is what most of it asks for.** T72's ref
// scan asks for no daemon at all and belongs here anyway: its fixture is a
// repository carrying a dispatching host's ref count, which the container that
// writes this package has no more of than it has a docker socket. A second
// script for that one case would be a second thing a dispatcher has to
// remember before landing.
//
// **The tag is an import-time refusal, not a skip.** `it.skipIf(noDocker)`
// inside `verify` would report green in exactly the environment that can never
// satisfy it — the false-green shape ticket 04 already ate once. So there are
// two gates and neither of them is a skip: `vitest.config.ts` excludes this
// directory from `verify`, and importing this module without the live config's
// marker throws. A live case that somehow reaches `verify` is a red run.
//
// The corollary at the other end: nothing here guards on "is docker up". A
// missing daemon, a missing image, and a container that never started are all
// failures, loudly — the tier exists to ask dockerd, so not asking it is not a
// pass.
import { it } from "@effect/vitest";
import type { CommandExecutor } from "@effect/platform/CommandExecutor";
import { Effect, Schema } from "effect";
import { exec, type ExecResult } from "../../src/internal/exec.ts";
import { ownershipFilterArgs } from "../../src/ownership/labels.ts";
import { dockerRows } from "../../src/reconcile/wreckage.ts";

export const LIVE_MARKER = "SPEEPOBOX_LIVE";

if (process.env[LIVE_MARKER] !== "1") {
  throw new Error(
    `${LIVE_MARKER} is unset: live cases run only under \`npm run verify:live\`, never under \`verify\`. ` +
      "If you are seeing this from `verify`, a live case was collected by the fake tier — restore " +
      "the exclude in vitest.config.ts rather than turning this into a skip.",
  );
}

// The tag itself. It is `@effect/vitest`'s `it` — same `it.effect`, same
// `it.scoped` — reached through this module so that *using* it imports the
// refusal above. That is the whole mechanism: there is no way to write a live
// case without taking the gate with it.
export const itLive = it;

// The image these cases start: this repo's, because the host running
// `verify:live` is the host running dispatches, and its `sleep infinity`
// entrypoint keeps the container up while `docker port` is asked about it. Any
// image that stays up will do — the subject is our argv, not the image — so a
// host without it can point this elsewhere.
//
// A literal, not `defaultConfig.image`: the package ships no image name since
// T40, and reading one from there put `''` into docker's argv.
export const LIVE_IMAGE = process.env.SPEEPOBOX_LIVE_IMAGE ?? "speepobox";

// Every docker call in this tier goes through the subprocess chokepoint, as
// the tool's own do. A docker CLI that will not run at all is a defect here
// rather than a typed error: it is this tier's precondition, not a case.
export const docker = (
  ...args: ReadonlyArray<string>
): Effect.Effect<ExecResult, never, CommandExecutor> =>
  exec("docker", ...args).pipe(
    Effect.mapError(
      (error) =>
        `verify:live needs a working docker CLI on PATH — ${error.detail}. This is host-only; it is not a case that can skip.`,
    ),
    Effect.orDie,
  );

const succeeding = (
  what: string,
  ...args: ReadonlyArray<string>
): Effect.Effect<ExecResult, never, CommandExecutor> =>
  docker(...args).pipe(
    Effect.flatMap((result) =>
      result.exitCode === 0
        ? Effect.succeed(result)
        : Effect.die(`${what}: docker exited ${result.exitCode} — ${result.stderr.trim()}`),
    ),
  );

// The tier's two preconditions, asked once per case rather than assumed: a
// daemon that answers, and the image the case starts. Both fail the case when
// they are missing, with the sentence that says what to do about it.
export const dockerdIsUp: Effect.Effect<void, never, CommandExecutor> = Effect.gen(function* () {
  yield* succeeding(
    "verify:live needs a reachable dockerd (is Docker Desktop / the daemon running?)",
    "info",
    "--format",
    "{{.ServerVersion}}",
  );
  yield* succeeding(
    `verify:live needs the image '${LIVE_IMAGE}' on this host (build it with 'node src/bin.ts image build', or set SPEEPOBOX_LIVE_IMAGE to any image whose default command stays up)`,
    "image",
    "inspect",
    LIVE_IMAGE,
  );
});

// The query the whole tier turns on: what dockerd holds for *this* repo scope,
// running or exited. `-a` is the point — a container that started, exited, and
// was never removed is the leak, and plain `docker ps` cannot see it. The
// filter arguments come from the ownership module the tool creates with, never
// spelled out again here (design rule 3).
//
// Both queries below read docker's stdout through the tool's own `dockerRows`
// (§3b): one parse, trimming *before* it filters. They used to differ — this
// one trimmed and then filtered, and the sweep filtered on a trimmed value and
// then passed the untrimmed id to `docker rm -fv`. T6's cases could not reach
// it (a throwaway repo root means the sweep only ever sees a container it
// started a moment earlier), and case 4 below is where the ids come from a
// daemon this process did not populate.
export const ownedContainers = (
  repoRoot: string,
): Effect.Effect<ReadonlyArray<string>, never, CommandExecutor> =>
  succeeding(
    "could not list containers",
    "ps",
    "-a",
    ...ownershipFilterArgs(repoRoot),
    "--format",
    "{{.Names}}",
  ).pipe(Effect.map((result) => dockerRows(result.stdout)));

// A case's own cleanup, run on the way out whatever happened: the tier starts
// real containers, and one that leaks because the case failed early would
// otherwise sit on the host until someone noticed. Cases give themselves a
// throwaway repo root, so this can only ever reach that case's own containers.
export const sweepOwned = (repoRoot: string): Effect.Effect<void, never, CommandExecutor> =>
  succeeding(
    "could not list containers to sweep",
    "ps",
    "-aq",
    ...ownershipFilterArgs(repoRoot),
  ).pipe(
    Effect.map((result) => dockerRows(result.stdout)),
    Effect.flatMap((ids) =>
      ids.length === 0 ? Effect.void : Effect.asVoid(docker("rm", "-fv", ...ids)),
    ),
  );

// The slice of `docker inspect` these cases read back. Written as a schema
// rather than parsed by hand because the answer crosses a process boundary as
// text: the decode is what turns "docker printed something" into the fields
// being asserted, and a docker whose shape moved fails here by name.
//
// The nullable arrays are docker's own shape: an empty `CapAdd` comes back as
// `null` on some daemons and `[]` on others.
const InspectedContainer = Schema.Struct({
  State: Schema.Struct({ Running: Schema.Boolean }),
  HostConfig: Schema.Struct({
    CapDrop: Schema.NullOr(Schema.Array(Schema.String)),
    CapAdd: Schema.NullOr(Schema.Array(Schema.String)),
    PidsLimit: Schema.NullOr(Schema.Number),
    Memory: Schema.Number,
    Binds: Schema.NullOr(Schema.Array(Schema.String)),
    PublishAllPorts: Schema.Boolean,
  }),
});
export type InspectedContainer = Schema.Schema.Type<typeof InspectedContainer>;

const InspectOutput = Schema.parseJson(Schema.Array(InspectedContainer));

// What dockerd says it did with our argv — the half a fake cannot answer,
// because a fake accepts any garbage and dockerd is the thing with an opinion.
export const inspectContainer = (
  id: string,
): Effect.Effect<InspectedContainer, never, CommandExecutor> =>
  succeeding(`could not inspect '${id}'`, "inspect", id).pipe(
    Effect.flatMap((result) => Schema.decodeUnknown(InspectOutput)(result.stdout)),
    Effect.flatMap((containers) =>
      containers[0] === undefined
        ? Effect.die(`docker inspect '${id}' returned no container`)
        : Effect.succeed(containers[0]),
    ),
    Effect.orDie,
  );

// The published-ports question, asked the way bash asks it (`run.sh:1344`) and
// failing closed the same way: a `docker port` that cannot run is a failure,
// not a quiet "no ports". A security invariant must not pass unverified.
export const publishedPorts = (id: string): Effect.Effect<string, never, CommandExecutor> =>
  succeeding(
    `could not verify that '${id}' publishes no ports (docker port failed)`,
    "port",
    id,
  ).pipe(Effect.map((result) => result.stdout.trim()));
