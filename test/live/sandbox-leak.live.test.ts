// Live case 1 (SPEC §11): **leak under defect**. The real `dockerLayer`
// inside the run's `Scope`, everything else faked, a defect thrown mid-scope —
// and then dockerd itself is asked what it holds.
//
// This is the case the fake tier structurally cannot answer, and matrix row 22
// is the reason: `test/sandbox.test.ts` asserts that our finalizer *ran* and
// that it spawned `docker rm -fv`, which is "our fake released" — not "dockerd
// has no container". Only a daemon can say the second thing, so nothing below
// asserts on the `Reporter`'s events; the observable here is `docker ps -a`,
// filtered by the labels the tool stamped.
import { describe, expect } from "@effect/vitest";
import { FileSystem } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { Cause, DateTime, Effect, Exit, Layer, Option, Ref } from "effect";
import { BessemerConfig, defaultConfig } from "../../src/config/config.ts";
import { planFor, specDispatch } from "../../src/dispatch/plan.ts";
import { runInScope } from "../../src/dispatch/run.ts";
import { Ledger } from "../../src/ledger/ledger.ts";
import { RunLockLive } from "../../src/lock/run-lock.ts";
import { Reporter } from "../../src/reporter.ts";
import { SandboxLive } from "../../src/sandbox/sandbox.ts";
import { fakeAgentCli } from "../support/agent-cli-fake.ts";
import { TEST_CREDENTIAL } from "../support/credential.ts";
import { TEST_FORGE_REPO } from "../support/repo-slug.ts";
import { fakeGit, type GitCall } from "../support/git-fake.ts";
import { fakeForge } from "../support/forge-fake.ts";
import { fakeNotifier } from "../support/notifier-fake.ts";
import { dockerdIsUp, itLive, LIVE_IMAGE, ownedContainers, sweepOwned } from "./live.ts";
import { PLAN_TIP } from "../support/plan.ts";

// The branch carries this process's pid so a container left behind by a run
// that was hard-killed — the one exit that skips every finalizer — cannot
// collide with this run's container name. The sweep below reaches only this
// case's own labels, and a throwaway repo root means those labels are unique
// to this run.
const BRANCH = `bessemer-live-leak-${process.pid}`;

// How the run ended, as a sentence rather than as a boolean. The tier is
// written by an agent with no docker socket and run by a host that has one, so
// the failure a reader sees is the whole report: a run that never reached its
// defect — a daemon that refused the start is the likely one — carries the
// reason in its cause, and asserting `isFailure` alone would throw that away
// and leave a diff of container names in its place.
const DIED_ON_PURPOSE = "died mid-scope, on purpose";

const howTheRunEnded = (exit: Exit.Exit<unknown, unknown>): string => {
  if (Exit.isSuccess(exit)) {
    return "completed — nothing exercised the leak this case is about";
  }
  return Option.isSome(Cause.dieOption(exit.cause))
    ? DIED_ON_PURPOSE
    : `failed before its defect: ${Cause.pretty(exit.cause)}`;
};

describe("the sandbox against a real dockerd", () => {
  itLive.scoped("leaves dockerd holding nothing when the run dies mid-scope", () =>
    Effect.gen(function* () {
      yield* dockerdIsUp;
      const fs = yield* FileSystem.FileSystem;
      // A throwaway repo root: `bessemer.repo` hashes it, so this case's label
      // scope is its own and its query can never see another run's containers —
      // nor another live case's, in either direction.
      const repoRoot = yield* fs.makeTempDirectoryScoped();
      const runtimeRoot = yield* fs.makeTempDirectoryScoped();
      const specPath = `${repoRoot}/live.md`;
      yield* fs.writeFileString(specPath, "# a spec no agent reads: this run dies first\n");

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
      const gitCalls = yield* Ref.make<ReadonlyArray<GitCall>>([]);
      // Real: the sandbox, the lock, the daemon. Faked: the clone (T18's
      // subject, and a live one would need a real remote) and the ledger.
      const layer = Layer.provideMerge(
        Layer.mergeAll(
          SandboxLive,
          RunLockLive,
          fakeGit(gitCalls),
          fakeNotifier(),
          fakeForge(),
          fakeAgentCli(),
        ),
        Layer.mergeAll(
          NodeContext.layer,
          Layer.succeed(BessemerConfig, {
            ...defaultConfig,
            image: LIVE_IMAGE,
            runtimeRoot,
            capAdd: [],
          }),
          Layer.succeed(Reporter, { emit: () => Effect.void }),
          Layer.succeed(Ledger, {
            append: () => Effect.void,
            recent: () => Effect.succeed([]),
            lastBaseForBranch: () => Effect.succeed(Option.none()),
            resolveResume: () => Effect.die("this run never resumes"),
            newestBranchForIssue: () => Effect.die("this run dispatches no feature"),
          }),
        ),
      );

      const assertions = Effect.gen(function* () {
        expect(yield* ownedContainers(repoRoot)).toEqual([]);

        // Read *inside* the scope, from dockerd, before the defect: a case that
        // only checked the end state would pass just as happily against a run
        // that never started a container at all.
        const midRun = yield* Ref.make<ReadonlyArray<string>>([]);
        const exit = yield* Effect.exit(
          runInScope(plan, repoRoot, TEST_CREDENTIAL, TEST_FORGE_REPO, () =>
            ownedContainers(repoRoot).pipe(
              Effect.flatMap((names) => Ref.set(midRun, names)),
              // A defect, not a typed failure: matrix row 11's shape, and the
              // one that would leave a container behind if release were a line
              // a caller writes rather than something the scope owes.
              Effect.zipRight(Effect.die(new Error("the run died mid-scope, on purpose"))),
            ),
          ).pipe(Effect.provide(layer)),
        );

        // Read the exit first: a start the daemon refused fails every
        // assertion below it, and this is the only one that says why.
        expect(howTheRunEnded(exit)).toBe(DIED_ON_PURPOSE);
        expect(yield* Ref.get(midRun)).toEqual([plan.containerId]);
        // The whole point of the tier.
        expect(yield* ownedContainers(repoRoot)).toEqual([]);
        // And the checkout the container mounted is gone with it — this case
        // holds the real daemon, so it may as well hold the whole scope to its
        // word.
        expect(yield* fs.exists(plan.checkoutPath)).toBe(false);
      });

      // Whatever the assertions did, this host does not keep a container from
      // it: a case that fails early is a bug report, not a leak the reader has
      // to clean up by hand.
      yield* assertions.pipe(Effect.ensuring(sweepOwned(repoRoot)));
    }).pipe(Effect.provide(NodeContext.layer)),
  );
});
