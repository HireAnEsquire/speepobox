// Live case 4 (SPEC §11): **label filter selectivity**. Two real containers on
// one real daemon, one of them carrying our labels, and the reconciler's own
// query has to match exactly one — **in both directions**.
//
// Over-matching is the dangerous direction and the exact bug that retired the
// name prefix (05 Q11): a query that reaches one container too far is a
// reconcile that removes a colleague's, or a second repo's, on a host where
// both live. A fake answers whatever it was scripted to, so only a daemon can
// say which containers a `--filter label=` actually selects.
//
// Only the filter is live. The reconciler's liveness *logic* — the three
// conditions, the classification, the witness sweep — is pure and stays in
// `test/reconcile.test.ts`, where it is asserted as values.
import { describe, expect } from "@effect/vitest";
import { FileSystem } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { DateTime, Effect, Layer, Option, Schema } from "effect";
import { defaultConfig } from "../../src/config/config.ts";
import { planFor, specDispatch } from "../../src/dispatch/plan.ts";
import { RepoUrl } from "../../src/git/repo-url.ts";
import { ownedSandboxes } from "../../src/reconcile/reconcile.ts";
import { Reporter } from "../../src/reporter.ts";
import { Sandbox, SandboxLive } from "../../src/sandbox/sandbox.ts";
import { sandboxSpecFor } from "../../src/sandbox/spec.ts";
import { TEST_CREDENTIAL } from "../support/credential.ts";
import { docker, dockerdIsUp, itLive, LIVE_IMAGE, sweepOwned } from "./live.ts";
import { PLAN_TIP } from "../support/plan.ts";

// This process's pid keeps two runs of this file, and any container a hard
// kill left behind, from colliding on a name.
const BRANCH = `speepobox-live-labels-${process.pid}`;
// The other container: same host, same image, no labels of ours. It is what
// the query must *not* reach.
const UNLABELLED = `speepobox-live-unlabelled-${process.pid}`;

// Every container this host holds, ours and everyone else's, by name. It is
// the check that keeps the selectivity assertions from passing vacuously: a
// case where neither container ever started would otherwise agree with every
// "does not match" below.
const everyContainer = Effect.map(
  docker("ps", "-a", "--format", "{{.Names}}"),
  (result) => result.stdout,
);

describe("the reconciler's ownership query against a real dockerd", () => {
  itLive.scoped("matches the container it labelled, and nothing beside it", () =>
    Effect.gen(function* () {
      yield* dockerdIsUp;
      const fs = yield* FileSystem.FileSystem;
      // Two throwaway repo roots: `speepobox.repo` hashes the root, so these
      // are two repos on one host — the case the name prefix could not tell
      // apart, and the second direction this asserts.
      const repoRoot = yield* fs.makeTempDirectoryScoped();
      const elsewhere = yield* fs.makeTempDirectoryScoped();
      const runtimeRoot = yield* fs.makeTempDirectoryScoped();
      const specPath = `${repoRoot}/live.md`;
      yield* fs.writeFileString(
        specPath,
        "# a spec no agent reads: this run only exists to be found\n",
      );

      const plan = planFor({
        ...specDispatch(specPath),
        branch: BRANCH,
        baseRef: "origin/master",
        baseSha: "1111111111111111111111111111111111111111",
        mergeBaseSha: "2222222222222222222222222222222222222222",
        tipSha: PLAN_TIP,
        runtimeRoot,
        startedAt: DateTime.unsafeMake("2026-01-01T00:00:00.000Z"),
      });
      // The workspace mount has to exist before the container asks for it, or
      // docker invents an empty directory at the bind source.
      yield* fs.makeDirectory(plan.checkoutPath, { recursive: true });
      const workspace = yield* Schema.decode(RepoUrl)(plan.checkoutPath).pipe(Effect.orDie);

      const assertions = Effect.gen(function* () {
        const sandbox = yield* Sandbox;
        // Ours, through the tool's own creation path: the labels are stamped
        // by `ownership/labels.ts` on the way in and read from that same list
        // on the way out, so this asserts they agree against a real daemon
        // rather than against each other.
        const ours = yield* sandbox.run(
          sandboxSpecFor({
            plan,
            repoRoot,
            workspace,
            config: { ...defaultConfig, image: LIVE_IMAGE, runtimeRoot, capAdd: [] },
            credential: TEST_CREDENTIAL,
          }),
        );

        // Theirs: same daemon, same image, none of our labels.
        const started = yield* docker("run", "-d", "--name", UNLABELLED, LIVE_IMAGE);
        if (started.exitCode !== 0) {
          return yield* Effect.die(
            `could not start the unlabelled container this case compares against: ${started.stderr.trim()}`,
          );
        }

        // Both really are on this host — read before anything below claims one
        // of them is invisible.
        const everything = yield* everyContainer;
        expect(everything).toContain(plan.containerId);
        expect(everything).toContain(UNLABELLED);

        const found = yield* ownedSandboxes(repoRoot);
        // Not an empty list and not a silence: `None` here would be a daemon
        // that could not be asked, which is a different answer entirely.
        expect(Option.isSome(found)).toBe(true);
        const matched = Option.getOrElse(found, () => []);
        // Matching direction: exactly ours, running, addressable by the id
        // `docker ps` printed — which is the short form of the one `docker
        // run` answered with.
        expect(matched.map((owned) => owned.name)).toEqual([plan.containerId]);
        expect(matched[0]?.running).toBe(true);
        expect(ours.id.startsWith(matched[0]?.id ?? "no id")).toBe(true);

        // Over-matching direction, twice: the unlabelled container beside it
        // is invisible regardless of what it is called, and a second repo root
        // on this same host selects nothing at all — the containers of one
        // repo are not the containers of another.
        expect(matched.map((owned) => owned.name)).not.toContain(UNLABELLED);
        expect(yield* ownedSandboxes(elsewhere)).toEqual(Option.some([]));
      });

      // Whatever the assertions did, this host keeps neither container: the
      // labelled one through the sweep that reads the same filter, and the
      // unlabelled one by name, because nothing of ours can see it.
      yield* assertions.pipe(
        Effect.ensuring(
          sweepOwned(repoRoot).pipe(
            Effect.zipRight(Effect.ignore(docker("rm", "-fv", UNLABELLED))),
          ),
        ),
      );
    }).pipe(
      Effect.provide(
        Layer.provideMerge(
          Layer.merge(SandboxLive, Layer.succeed(Reporter, { emit: () => Effect.void })),
          NodeContext.layer,
        ),
      ),
    ),
  );
});
