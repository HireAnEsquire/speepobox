// Live case 6 (T22): **a container removed while a command is running inside
// it**. The real `dockerLayer` against a real dockerd, an exec held open, and
// the container taken out from under it — then the reason a pass would be
// given is read off the error the exec came back with.
//
// This earns the tier by the admission rule, and it is the one case a fake
// structurally cannot answer: the whole ticket is about what docker *actually*
// reports when the container goes mid-exec. T9's predicate matched the
// daemon's refusal to exec against an already-dead container, and a scripted
// docker will happily produce that string on demand — which is how a pattern
// that never covers this path stayed green for a ticket. What a real daemon
// says here is the child's own exit code and nothing else.
//
// **The pass is a `Sandbox.exec`, not the agent CLI.** The subject is the
// answer the daemon gives about a container, and it is reached through the
// same streamed exec an agent pass uses (`agent/agent-cli.ts` calls it with
// the prompt on stdin, as this does). Spawning the CLI itself would put a
// credential check and a network round trip between the start of the pass and
// the removal — a CLI that exited on its own first would fail this case for a
// reason that has nothing to do with what it asserts.
import { describe, expect } from "@effect/vitest";
import { FileSystem } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { Deferred, Effect, Either, Layer, Option, Schema } from "effect";
import { agentPassReason } from "../../src/agent/agent-cli.ts";
import { RepoUrl } from "../../src/git/repo-url.ts";
import { Reporter } from "../../src/reporter.ts";
import { Sandbox, SandboxLive } from "../../src/sandbox/sandbox.ts";
import { type SandboxSpec, SPEC_TARGET } from "../../src/sandbox/spec.ts";
import { TEST_CREDENTIAL } from "../support/credential.ts";
import { docker, dockerdIsUp, itLive, LIVE_IMAGE, sweepOwned } from "./live.ts";

// The pid keeps two runs of this file — or a container a hard kill left
// behind — from colliding on a container name.
const CONTAINER = `speepobox-live-sandbox-gone-${process.pid}`;

// The command standing in for a pass: it says one word and then outlives any
// case here. The word is the point — the exec's own output is what says the
// child is running, so the removal lands *during* the command rather than at
// some delay this file guessed at.
const RUNNING_MARKER = "the pass is running";
const HELD_COMMAND: ReadonlyArray<string> = ["sh", "-c", `echo '${RUNNING_MARKER}'; sleep 600`];

// How long the child gets to say it started. Well under
// `vitest.live.config.ts`'s per-case budget, so a run that never gets there
// fails with the sentence below rather than with vitest's own timeout.
const RUNNING_DEADLINE = "60 seconds";

describe("a container removed while a command runs inside it", () => {
  itLive.scoped("answers sandbox-gone from the daemon, with no message to match", () =>
    Effect.gen(function* () {
      yield* dockerdIsUp;
      const fs = yield* FileSystem.FileSystem;
      // A throwaway repo root: `speepobox.repo` hashes it, so this case's label
      // scope is its own and its sweep can never reach another run's
      // containers — nor another live case's.
      const repoRoot = yield* fs.makeTempDirectoryScoped();
      const workspace = yield* fs.makeTempDirectoryScoped();
      const specPath = `${repoRoot}/live.md`;
      yield* fs.writeFileString(specPath, "# a spec no agent reads: this container is removed\n");

      const spec: SandboxSpec = {
        name: CONTAINER,
        image: LIVE_IMAGE,
        repoRoot,
        workspace: yield* Schema.decode(RepoUrl)(workspace),
        mounts: [{ source: specPath, target: SPEC_TARGET }],
        env: [],
        envFile: Option.none(),
        credential: TEST_CREDENTIAL,
        limits: { pids: 2048, memory: "2g" },
        capabilities: [],
      };

      const assertions = Effect.gen(function* () {
        const sandbox = yield* Sandbox;
        const handle = yield* sandbox.run(spec);
        const running = yield* Deferred.make<void>();

        // The removal, waiting on the child's own first line: this is the
        // "mid-exec" the whole case rests on, and a fixed delay would be a
        // guess about how fast this host starts a container.
        const removal = Deferred.await(running).pipe(
          Effect.timeoutFail({
            duration: RUNNING_DEADLINE,
            onTimeout: () =>
              `the command never said it was running within ${RUNNING_DEADLINE} — nothing was removed mid-exec, so this case asserted nothing`,
          }),
          Effect.zipRight(docker("rm", "-fv", handle.id)),
          Effect.flatMap((result) =>
            result.exitCode === 0
              ? Effect.void
              : Effect.fail(
                  `could not remove '${handle.id}' mid-exec: docker exited ${result.exitCode} — ${result.stderr.trim()}`,
                ),
          ),
          Effect.orDie,
        );

        const pass = sandbox
          .exec(handle, HELD_COMMAND, {
            // The half an agent pass uses: the prompt travels on stdin, and
            // nothing in this container reads it.
            stdin: "",
            onOutput: (line) =>
              line.trim() === RUNNING_MARKER
                ? Effect.asVoid(Deferred.succeed(running, undefined))
                : Effect.void,
            onStderr: () => Effect.void,
          })
          .pipe(Effect.either);

        const [outcome] = yield* Effect.all([pass, removal], { concurrency: 2 });

        expect(Either.isLeft(outcome)).toBe(true);
        if (Either.isLeft(outcome)) {
          // The whole ticket, in two lines. The daemon was asked about the id
          // the exec addressed and said the container is gone; the reason a
          // pass is failed with follows from that answer and from nothing the
          // CLI printed.
          expect(outcome.left.sandboxGone).toBe(true);
          expect(agentPassReason(outcome.left.sandboxGone)).toBe("sandbox-gone");
        }
      });

      // Whatever the assertions did, this host keeps no container from them:
      // a case that failed early is a bug report, not a leak to clean up by
      // hand. The scope's own finalizer already removed a container that is
      // still there; this reaches the one a failed case never got that far
      // with.
      yield* assertions.pipe(Effect.ensuring(sweepOwned(repoRoot)));
    }).pipe(
      Effect.provide(
        Layer.provideMerge(
          SandboxLive,
          Layer.mergeAll(NodeContext.layer, Layer.succeed(Reporter, { emit: () => Effect.void })),
        ),
      ),
    ),
  );
});
