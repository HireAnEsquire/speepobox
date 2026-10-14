// Live cases 2 and 3 (SPEC §11): **the spec type renders to a `docker run`
// dockerd accepts**, and **no published ports, live**.
//
// Both exist because the fake tier's opinion is worthless here. The scripted
// executor in `test/sandbox.test.ts` accepts any argv at all — it would
// be just as green against `--pids-limit banana` — so the only thing that can
// say our render is a command a daemon honours is a daemon. And the ports
// invariant is unrepresentable in the type, which constrains *our* renderer
// and nothing else: `docker port` is the one assertion that says the container
// dockerd actually built publishes nothing.
//
// The spec under test is the one a dispatch derives, `sandboxSpecFor` and all,
// rather than a literal written for the occasion — a hand-written spec would
// prove the renderer honours a shape no dispatch produces.
import { describe, expect } from "@effect/vitest";
import { FileSystem } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { DateTime, Effect, Layer, Schema } from "effect";
import { defaultConfig, defaultConfigFor } from "../../src/config/config.ts";
import { planFor, specDispatch } from "../../src/dispatch/plan.ts";
import { RepoUrl } from "../../src/git/repo-url.ts";
import { Reporter } from "../../src/reporter.ts";
import { Sandbox, SandboxLive } from "../../src/sandbox/sandbox.ts";
import { sandboxSpecFor, SPEC_TARGET, WORKSPACE_TARGET } from "../../src/sandbox/spec.ts";
import { TEST_CREDENTIAL } from "../support/credential.ts";
import {
  dockerdIsUp,
  inspectContainer,
  itLive,
  LIVE_IMAGE,
  ownedContainers,
  publishedPorts,
  sweepOwned,
} from "./live.ts";
import { PLAN_TIP } from "../support/plan.ts";

// One capability, so both halves of `--cap-drop ALL --cap-add …` are asserted
// against what dockerd recorded rather than against our own argv.
const DECLARED_CAP = "CHOWN";

// The pid keeps two runs of this file — or a run and a container a hard kill
// left behind — from colliding on a container name.
const branchFor = (what: string): string => `speepobox-live-${what}-${process.pid}`;

// A dispatch's worth of real host state: a repo root whose hash scopes this
// case's labels, a checkout directory to mount as the workspace, and a spec
// file to mount read-only. They are real because docker will happily invent a
// *directory* at a bind source that does not exist, which would turn the spec
// mount into a silently empty one.
const world = (branch: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const repoRoot = yield* fs.makeTempDirectoryScoped();
    const runtimeRoot = yield* fs.makeTempDirectoryScoped();
    const specPath = `${repoRoot}/live.md`;
    yield* fs.writeFileString(specPath, "# a spec no agent reads: this case only starts it\n");

    const plan = planFor({
      ...specDispatch(specPath),
      branch,
      baseRef: "origin/master",
      baseSha: "1111111111111111111111111111111111111111",
      mergeBaseSha: "2222222222222222222222222222222222222222",
      tipSha: PLAN_TIP,
      runtimeRoot,
      startedAt: DateTime.unsafeMake("2026-01-01T00:00:00.000Z"),
    });
    // The checkout T18 would have cloned. This case's subject starts after it.
    yield* fs.makeDirectory(plan.checkoutPath, { recursive: true });

    // The same branded door `dispatch/run.ts` sends the checkout through, and
    // through the error channel as it does: a `decodeSync` here would throw
    // past the effect it is inside, which is the one thing this tier never
    // wants — a path it cannot brand is a defect with the parse's own words.
    const workspace = yield* Schema.decode(RepoUrl)(plan.checkoutPath).pipe(Effect.orDie);
    const spec = sandboxSpecFor({
      plan,
      repoRoot,
      workspace,
      config: { ...defaultConfigFor(repoRoot), image: LIVE_IMAGE, capAdd: [DECLARED_CAP] },
      credential: TEST_CREDENTIAL,
    });
    const layer = Layer.provideMerge(
      SandboxLive,
      Layer.mergeAll(NodeContext.layer, Layer.succeed(Reporter, { emit: () => Effect.void })),
    );
    return { repoRoot, specPath, plan, spec, layer };
  });

describe("the sandbox spec against a real dockerd", () => {
  itLive.scoped("renders to a docker run the daemon accepts, caps, mounts and limits", () =>
    Effect.gen(function* () {
      yield* dockerdIsUp;
      const scratch = yield* world(branchFor("render"));

      const assertions = Effect.gen(function* () {
        const inspected = yield* Effect.scoped(
          Effect.gen(function* () {
            const sandbox = yield* Sandbox;
            // A start the daemon refused is a `SandboxError` here, and this
            // case has no handler for it: an unacceptable render fails loudly
            // with the daemon's own stderr in the message.
            const handle = yield* sandbox.run(scratch.spec);
            expect(handle.name).toBe(scratch.plan.containerId);
            expect(handle.id).not.toBe("");
            // Asked while the container exists, because the scope removes it
            // on the way out of this block.
            return yield* inspectContainer(handle.id);
          }).pipe(Effect.provide(scratch.layer)),
        );

        // Capabilities: dropped to none, then exactly what the config
        // declared added back — the order our renderer emits them in is our
        // business, but which set the container ended up with is dockerd's.
        expect(inspected.HostConfig.CapDrop).toEqual(["ALL"]);
        expect(inspected.HostConfig.CapAdd).toEqual([DECLARED_CAP]);
        // Limits, as the numbers docker normalised them to.
        expect(inspected.HostConfig.PidsLimit).toBe(defaultConfig.pidsLimit);
        expect(inspected.HostConfig.Memory).toBe(8 * 1024 * 1024 * 1024);
        // Mounts: the checkout read-write at the workspace, the spec
        // read-only where every prompt already names it.
        expect(inspected.HostConfig.Binds).toContain(
          `${scratch.plan.checkoutPath}:${WORKSPACE_TARGET}`,
        );
        expect(inspected.HostConfig.Binds).toContain(`${scratch.specPath}:${SPEC_TARGET}:ro`);
        // The scope's own word, checked against the daemon rather than
        // against our reporter (live case 1's subject, asserted again here
        // because this case had a container of its own to lose).
        expect(yield* ownedContainers(scratch.repoRoot)).toEqual([]);
      });

      yield* assertions.pipe(Effect.ensuring(sweepOwned(scratch.repoRoot)));
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  itLive.scoped("publishes no ports, as the daemon reports them", () =>
    Effect.gen(function* () {
      yield* dockerdIsUp;
      const scratch = yield* world(branchFor("ports"));

      const assertions = Effect.scoped(
        Effect.gen(function* () {
          const sandbox = yield* Sandbox;
          const handle = yield* sandbox.run(scratch.spec);
          // Fail closed, as bash does (`run.sh:1338-1347`): a container that
          // has already exited publishes nothing for uninteresting reasons,
          // and a security invariant that passes because there was nothing to
          // ask about has not been verified at all.
          const inspected = yield* inspectContainer(handle.id);
          expect(inspected.State.Running).toBe(true);
          expect(inspected.HostConfig.PublishAllPorts).toBe(false);
          // The assertion itself. `publishedPorts` dies rather than returning
          // "" if `docker port` cannot be run, for the same reason.
          expect(yield* publishedPorts(handle.id)).toBe("");
        }).pipe(Effect.provide(scratch.layer)),
      );

      yield* assertions.pipe(Effect.ensuring(sweepOwned(scratch.repoRoot)));
    }).pipe(Effect.provide(NodeContext.layer)),
  );
});
