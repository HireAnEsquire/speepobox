// The `Sandbox` resource against a scripted docker (fake tier). What is
// asserted here is the argv that reached the CLI, the events the resource
// emitted, and which failures are typed — the half a live dockerd cannot show
// you, because a daemon answers about *a* container and not about whether the
// scope owed one.
//
// The other half — "our fake released" is not "dockerd has no container" — is
// live case 1, in `test/live/`, and it is the user's to run.
//
// Matrix rows covered: 6 (start fails → typed `SandboxError`, nothing held)
// and 19 (a failing finalizer is reported, swallowed, and never masks the
// run's own error).
import { describe, expect, it } from "@effect/vitest";
import { FileSystem } from "@effect/platform";
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { DateTime, Effect, Either, Exit, Layer, Option, Ref, Schema } from "effect";
import { BessemerConfig, type BessemerConfigShape, defaultConfig } from "../src/config/config.ts";
import { planFor, specDispatch } from "../src/dispatch/plan.ts";
import { runInScope } from "../src/dispatch/run.ts";
import { RepoUrl } from "../src/git/repo-url.ts";
import { Ledger } from "../src/ledger/ledger.ts";
import type { RunRecord } from "../src/ledger/record.ts";
import { RunLockLive } from "../src/lock/run-lock.ts";
import { ownershipLabels } from "../src/ownership/labels.ts";
import { Reporter, type ReporterEvent } from "../src/reporter.ts";
import { Sandbox, SandboxError, SandboxLive } from "../src/sandbox/sandbox.ts";
import {
  type SandboxSpec,
  SETUP_HOOK_DIR,
  SPEC_TARGET,
  WORKSPACE_TARGET,
} from "../src/sandbox/spec.ts";
import { fakeAgentCli } from "./support/agent-cli-fake.ts";
import { CREDENTIAL_CANARY, TEST_CREDENTIAL } from "./support/credential.ts";
import { TEST_FORGE_REPO } from "./support/repo-slug.ts";
import { type ScriptedResult, scriptedExecutor } from "./support/exec-fake.ts";
import { fakeGit, type GitCall } from "./support/git-fake.ts";
import { fakeForge } from "./support/forge-fake.ts";
import { fakeNotifier } from "./support/notifier-fake.ts";
import { PLAN_TIP } from "./support/plan.ts";

const REPO_ROOT = "/srv/hae";
const CHECKOUT = "/srv/bessemer/checkouts/bessemer-t6";
const CONTAINER = "bessemer-bessemer-t6";
const CONTAINER_ID = "d15c0ffee1d";
// The setup hook the scoped cases below declare, named relative to the repo
// root as a host's own config would name it (T7).
const SETUP_HOOK = "setup.sh";

const spec: SandboxSpec = {
  name: CONTAINER,
  image: "hae-agentbox",
  repoRoot: REPO_ROOT,
  workspace: Schema.decodeSync(RepoUrl)(CHECKOUT),
  mounts: [{ source: "/srv/hae/tasks/T6.md", target: SPEC_TARGET }],
  env: [],
  envFile: Option.none(),
  credential: TEST_CREDENTIAL,
  limits: { pids: 2048, memory: "8g" },
  capabilities: ["CHOWN"],
};

const happyScript: Record<string, ScriptedResult> = {
  "docker run": { exit: 0, stdout: `${CONTAINER_ID}\n` },
  "docker rm": { exit: 0, stdout: `${CONTAINER_ID}\n` },
};

// The question a failing `exec` asks the daemon about its own container (T22),
// in its three readings: the container outlived its command, it is still known
// and no longer running, and it is not there at all.
const ALIVE: ScriptedResult = { exit: 0, stdout: "true\n" };
const STOPPED: ScriptedResult = { exit: 0, stdout: "false\n" };
const NO_SUCH_CONTAINER: ScriptedResult = {
  exit: 1,
  stderr: `Error: No such object: ${CONTAINER_ID}\n`,
};
const INSPECT = `docker inspect -f {{.State.Running}} ${CONTAINER_ID}`;

// One scope holding one sandbox, with the three observables the matrix names:
// every argv docker was spawned with, every event the resource emitted, and
// what the scope itself came back with.
const world = (script: Record<string, ScriptedResult> = happyScript) =>
  Effect.gen(function* () {
    const events = yield* Ref.make<ReadonlyArray<ReporterEvent>>([]);
    const commands = yield* Ref.make<ReadonlyArray<string>>([]);
    const layer = Layer.provideMerge(
      SandboxLive,
      Layer.mergeAll(
        scriptedExecutor(script, commands),
        Layer.succeed(Reporter, {
          emit: (event) => Ref.update(events, (current) => [...current, event]),
        }),
      ),
    );
    return { events, commands, layer };
  });

const resourceEventsIn = (
  events: ReadonlyArray<ReporterEvent>,
): ReadonlyArray<readonly [string, string]> =>
  events.flatMap((event) =>
    event._tag === "ResourceAcquired" || event._tag === "ResourceReleased"
      ? [[event._tag, event.resource] as const]
      : [],
  );

const warningsIn = (events: ReadonlyArray<ReporterEvent>): ReadonlyArray<string> =>
  events.flatMap((event) => (event._tag === "Warned" ? [event.detail] : []));

describe("the sandbox resource", () => {
  it.effect("starts the container the spec describes and removes it with the scope", () =>
    Effect.gen(function* () {
      const scratch = yield* world();
      const seen = yield* Effect.scoped(
        Effect.gen(function* () {
          const sandbox = yield* Sandbox;
          const handle = yield* sandbox.run(spec);
          // Inside the scope, the container exists and nothing removed it yet.
          expect(yield* Ref.get(scratch.commands)).toHaveLength(1);
          return handle;
        }),
      ).pipe(Effect.provide(scratch.layer));

      expect(seen).toEqual({ name: CONTAINER, id: CONTAINER_ID });
      const commands = yield* Ref.get(scratch.commands);
      expect(commands).toHaveLength(2);
      // Both ownership labels, on the way in — declared, never inferred, and
      // taken from the module `status` queries with.
      for (const label of ownershipLabels(REPO_ROOT)) {
        expect(commands[0]).toContain(`--label ${label}`);
      }
      expect(commands[0]).toContain("--cap-drop ALL --cap-add CHOWN");
      expect(commands[0]).toContain(`-v ${CHECKOUT}:${WORKSPACE_TARGET} -w ${WORKSPACE_TARGET}`);
      // Removed by id, forcibly, with its anonymous volumes.
      expect(commands[1]).toBe(`docker rm -fv ${CONTAINER_ID}`);
      expect(resourceEventsIn(yield* Ref.get(scratch.events))).toEqual([
        ["ResourceAcquired", "sandbox"],
        ["ResourceReleased", "sandbox"],
      ]);
    }),
  );

  // T23's whole delivery, at the one seam that can show it: the credential's
  // **value** goes to the `docker run` child's environment — which is where
  // `-e NAME` with no value tells docker to read it from — and its **name**,
  // alone, is what reaches argv. The removal that follows is handed no secret
  // at all: a value we hold goes to the one child that needs it, never to
  // every child this package spawns.
  it.effect("gives the credential's value to the docker child's environment, not its argv", () =>
    Effect.gen(function* () {
      const events = yield* Ref.make<ReadonlyArray<ReporterEvent>>([]);
      const commands = yield* Ref.make<ReadonlyArray<string>>([]);
      const environments = yield* Ref.make<ReadonlyArray<Record<string, string>>>([]);
      // The spec a dispatch derives, whose one env entry is the credential's
      // name and nothing else (`sandbox/spec.ts`).
      const forwarding: SandboxSpec = { ...spec, env: [{ name: TEST_CREDENTIAL.name }] };
      yield* Effect.scoped(Effect.flatMap(Sandbox, (sandbox) => sandbox.run(forwarding))).pipe(
        Effect.provide(
          Layer.provideMerge(
            SandboxLive,
            Layer.mergeAll(
              scriptedExecutor(happyScript, commands, undefined, environments),
              Layer.succeed(Reporter, {
                emit: (event) => Ref.update(events, (current) => [...current, event]),
              }),
            ),
          ),
        ),
      );

      const spawned = yield* Ref.get(environments);
      const [starting, removing] = spawned;
      expect(starting?.[TEST_CREDENTIAL.name]).toBe(CREDENTIAL_CANARY);
      expect(removing?.[TEST_CREDENTIAL.name]).toBeUndefined();
      // The name crosses by itself, and the token is in none of the argv the
      // host's process list and every command log would show.
      const argv = yield* Ref.get(commands);
      expect(argv[0]).toContain(`-e ${TEST_CREDENTIAL.name}`);
      for (const command of argv) {
        expect(command).not.toContain(CREDENTIAL_CANARY);
      }
      // And this process never carried it either — the resolver handed a
      // value over, it did not export one. Asserted against the canary rather
      // than against absence: a host that exported its own token under this
      // name is row 2 of the ticket's own verification, and the suite must not
      // fail on the very configuration it exists to support.
      expect(process.env[TEST_CREDENTIAL.name]).not.toBe(CREDENTIAL_CANARY);
    }),
  );

  // Matrix row 6's error half: the daemon refused, so nothing is held and the
  // failure is typed rather than a defect — the run gets an outcome.
  it.effect("fails a refused start as a typed SandboxError, with nothing to remove", () =>
    Effect.gen(function* () {
      const scratch = yield* world({
        ...happyScript,
        "docker run": { exit: 125, stderr: "docker: Error response from daemon: no such image\n" },
      });
      const outcome = yield* Effect.either(
        Effect.scoped(Effect.flatMap(Sandbox, (sandbox) => sandbox.run(spec))),
      ).pipe(Effect.provide(scratch.layer));

      expect(Either.isLeft(outcome)).toBe(true);
      if (Either.isLeft(outcome)) {
        expect(outcome.left._tag).toBe("SandboxError");
        expect(outcome.left.detail).toContain(`could not start the sandbox '${CONTAINER}'`);
        expect(outcome.left.detail).toContain("no such image");
        // A start that never happened has no container to have lost (T22).
        expect(outcome.left.sandboxGone).toBe(false);
      }
      // A container that never started is never removed, and never reported
      // as acquired.
      expect((yield* Ref.get(scratch.commands)).map((command) => command.split(" ")[1])).toEqual([
        "run",
      ]);
      expect(resourceEventsIn(yield* Ref.get(scratch.events))).toEqual([]);
    }),
  );

  it.effect("reports a missing docker CLI as a typed SandboxError", () =>
    Effect.gen(function* () {
      const scratch = yield* world({});
      const outcome = yield* Effect.either(
        Effect.scoped(Effect.flatMap(Sandbox, (sandbox) => sandbox.run(spec))),
      ).pipe(Effect.provide(scratch.layer));

      expect(Either.isLeft(outcome)).toBe(true);
      if (Either.isLeft(outcome)) {
        expect(outcome.left.detail).toContain("docker CLI not found");
      }
    }),
  );

  // Matrix row 19: the finalizer's own failure is reported and swallowed. The
  // scope keeps the value the work produced — a `docker rm` that failed is
  // never the reason a dispatch reports failure.
  it.effect("reports and swallows a removal that fails, leaving the run's outcome alone", () =>
    Effect.gen(function* () {
      const scratch = yield* world({
        ...happyScript,
        "docker rm": {
          exit: 1,
          stderr: "Error response from daemon: removal already in progress\n",
        },
      });
      const outcome = yield* Effect.exit(
        Effect.scoped(
          Effect.flatMap(Sandbox, (sandbox) =>
            sandbox.run(spec).pipe(Effect.as("the run itself was fine")),
          ),
        ),
      ).pipe(Effect.provide(scratch.layer));

      expect(outcome).toEqual(Exit.succeed("the run itself was fine"));
      const warnings = warningsIn(yield* Ref.get(scratch.events));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(`could not remove the sandbox '${CONTAINER}'`);
      expect(warnings[0]).toContain("removal already in progress");
      expect(warnings[0]).toContain("reconciler");
      // Reported is not released: the event that says a resource let go is
      // only ever emitted when it really did.
      expect(resourceEventsIn(yield* Ref.get(scratch.events))).toEqual([
        ["ResourceAcquired", "sandbox"],
      ]);
    }),
  );

  // The same failure, under a run that failed on its own: the finalizer must
  // not become the error the caller sees (design rule 4).
  it.effect("leaves the run's own error unmasked when the removal fails too", () =>
    Effect.gen(function* () {
      const scratch = yield* world({
        ...happyScript,
        "docker rm": { exit: 1, stderr: "no such container\n" },
      });
      const outcome = yield* Effect.exit(
        Effect.scoped(
          Effect.flatMap(Sandbox, (sandbox) =>
            sandbox.run(spec).pipe(Effect.zipRight(Effect.fail("the run's own error"))),
          ),
        ),
      ).pipe(Effect.provide(scratch.layer));

      expect(outcome).toEqual(Exit.fail("the run's own error"));
      expect(warningsIn(yield* Ref.get(scratch.events))).toHaveLength(1);
    }),
  );

  // `exec` (T7), against the container `run` started: the agent pass and the
  // setup hook both run *in* a sandbox, and both run in the foreground. What a
  // fake can say about that is the argv — no `-d`, so the CLI holds the
  // container's process and the fiber that asked waits for it, which is how
  // Effect issue #5592 is sidestepped rather than handled.
  it.effect("runs a command in the started container, in the foreground", () =>
    Effect.gen(function* () {
      const scratch = yield* world({ ...happyScript, "docker exec": { exit: 0 } });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const sandbox = yield* Sandbox;
          const handle = yield* sandbox.run(spec);
          yield* sandbox.exec(handle, ["bash", "/bessemer/setup.sh"]);
        }),
      ).pipe(Effect.provide(scratch.layer));

      const commands = yield* Ref.get(scratch.commands);
      expect(commands[1]).toBe(`docker exec ${CONTAINER_ID} bash /bessemer/setup.sh`);
      // Addressed by id, and detached from nothing: a `-d` here would spawn a
      // child no scope owns.
      expect(commands[1]).not.toContain(" -d");
      // A command that succeeded asks the daemon nothing: the second question
      // is the failure path's alone (T22).
      expect(commands).toEqual([commands[0], commands[1], `docker rm -fv ${CONTAINER_ID}`]);
    }),
  );

  it.effect("types a nonzero exit as a SandboxError carrying the command's own stderr", () =>
    Effect.gen(function* () {
      const scratch = yield* world({
        ...happyScript,
        "docker exec": { exit: 3, stderr: "setup.sh: line 4: pg_isready: not found\n" },
        "docker inspect": ALIVE,
      });
      const outcome = yield* Effect.either(
        Effect.scoped(
          Effect.gen(function* () {
            const sandbox = yield* Sandbox;
            const handle = yield* sandbox.run(spec);
            return yield* sandbox.exec(handle, ["bash", "/bessemer/setup.sh"]);
          }),
        ),
      ).pipe(Effect.provide(scratch.layer));

      expect(Either.isLeft(outcome)).toBe(true);
      if (Either.isLeft(outcome)) {
        expect(outcome.left._tag).toBe("SandboxError");
        expect(outcome.left.detail).toContain("'bash /bessemer/setup.sh' exited 3");
        expect(outcome.left.detail).toContain(`the sandbox '${CONTAINER}'`);
        expect(outcome.left.detail).toContain("pg_isready: not found");
        // The daemon still holds this container, so the command died on its
        // own and the sandbox is not what went (T22).
        expect(outcome.left.sandboxGone).toBe(false);
      }
      // The scope still owed the container, and a command that failed inside
      // it does not change that.
      const commands = yield* Ref.get(scratch.commands);
      expect(commands.at(-1)).toBe(`docker rm -fv ${CONTAINER_ID}`);
      // Asked once, about the id the exec addressed — a name would be another
      // container's answer as often as this one's, and an id is never reused.
      expect(commands.filter((command) => command.startsWith("docker inspect"))).toEqual([INSPECT]);
    }),
  );

  // The correction T22 makes: the container went away *underneath* the exec,
  // so docker reported the child's own SIGKILL code and said nothing about a
  // container at all. There is no message to match, and the daemon's answer is
  // what names it.
  it.effect("answers sandboxGone for a container killed underneath the command", () =>
    Effect.gen(function* () {
      const scratch = yield* world({
        ...happyScript,
        "docker exec": { exit: 137 },
        "docker inspect": STOPPED,
      });
      const outcome = yield* Effect.either(
        Effect.scoped(
          Effect.gen(function* () {
            const sandbox = yield* Sandbox;
            const handle = yield* sandbox.run(spec);
            return yield* sandbox.exec(handle, ["bash", "/bessemer/setup.sh"]);
          }),
        ),
      ).pipe(Effect.provide(scratch.layer));

      expect(Either.isLeft(outcome)).toBe(true);
      if (Either.isLeft(outcome)) {
        expect(outcome.left.sandboxGone).toBe(true);
        // The detail is docker's own, exactly as before: the answer is a field
        // beside it rather than something read out of it.
        expect(outcome.left.detail).toContain("exited 137");
      }
    }),
  );

  // The same answer from the other reading: the daemon does not know the id at
  // all, because the container was removed outright.
  it.effect("answers sandboxGone for a container the daemon no longer knows", () =>
    Effect.gen(function* () {
      const scratch = yield* world({
        ...happyScript,
        "docker exec": {
          exit: 1,
          stderr: `Error response from daemon: No such container: ${CONTAINER_ID}\n`,
        },
        "docker inspect": NO_SUCH_CONTAINER,
      });
      const outcome = yield* Effect.either(
        Effect.scoped(
          Effect.gen(function* () {
            const sandbox = yield* Sandbox;
            const handle = yield* sandbox.run(spec);
            return yield* sandbox.exec(handle, ["bash", "/bessemer/setup.sh"]);
          }),
        ),
      ).pipe(Effect.provide(scratch.layer));

      expect(Either.isLeft(outcome)).toBe(true);
      if (Either.isLeft(outcome)) {
        expect(outcome.left.sandboxGone).toBe(true);
      }
    }),
  );

  // `remove` on its own is what the reconciler will call (T8); `run`'s
  // finalizer is its first consumer, and both go through one implementation so
  // the two cannot drift apart.
  it.effect("removes a container by handle, and types a refusal to", () =>
    Effect.gen(function* () {
      const scratch = yield* world({
        "docker rm": { exit: 1, stderr: "No such container: bessemer-gone\n" },
      });
      const outcome = yield* Effect.either(
        Effect.flatMap(Sandbox, (sandbox) =>
          sandbox.remove({ name: "bessemer-gone", id: "bessemer-gone" }),
        ),
      ).pipe(Effect.provide(scratch.layer));

      expect(yield* Ref.get(scratch.commands)).toEqual(["docker rm -fv bessemer-gone"]);
      expect(Either.isLeft(outcome)).toBe(true);
      if (Either.isLeft(outcome)) {
        expect(outcome.left._tag).toBe("SandboxError");
        expect(outcome.left.detail).toContain("No such container");
        // A removal that failed is reported and swallowed by the finalizer, so
        // it answers `false` and asks the daemon nothing (T22).
        expect(outcome.left.sandboxGone).toBe(false);
      }
    }),
  );
});

// The same layer inside the run's `Scope`, where the sandbox is the third
// resource: what is asserted here is the row a failed start owes, the order
// the three let go in, and that a container we could not remove is still not
// the run's error. The `Git` behind the checkout is a fake — the clone is
// T18's subject — but the lock, the ledger row, and the docker argv are real.
const scoped = (
  script: Record<string, ScriptedResult> = happyScript,
  config: Partial<BessemerConfigShape> = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const runtimeRoot = yield* fs.makeTempDirectoryScoped();
    const repoRoot = yield* fs.makeTempDirectoryScoped();
    // A setup hook on disk, for the cases that declare one: the guard the
    // dispatch runs first is what refuses a config naming a script that is not
    // there, so a run reaching this far always has its file.
    yield* fs.writeFileString(`${repoRoot}/${SETUP_HOOK}`, "#!/usr/bin/env bash\necho ready\n");
    const events = yield* Ref.make<ReadonlyArray<ReporterEvent>>([]);
    const appended = yield* Ref.make<ReadonlyArray<RunRecord>>([]);
    const commands = yield* Ref.make<ReadonlyArray<string>>([]);
    const gitCalls = yield* Ref.make<ReadonlyArray<GitCall>>([]);

    const plan = planFor({
      ...specDispatch(`${repoRoot}/tasks/T6.md`),
      branch: "bessemer-t6",
      baseRef: "origin/master",
      baseSha: "1111111111111111111111111111111111111111",
      mergeBaseSha: "2222222222222222222222222222222222222222",
      tipSha: PLAN_TIP,
      runtimeRoot,
      startedAt: DateTime.unsafeMake("2026-01-01T00:00:00.000Z"),
    });

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
        NodeFileSystem.layer,
        NodePath.layer,
        scriptedExecutor(script, commands),
        Layer.succeed(BessemerConfig, {
          ...defaultConfig,
          runtimeRoot,
          capAdd: ["CHOWN"],
          ...config,
        }),
        Layer.succeed(Reporter, {
          emit: (event) => Ref.update(events, (current) => [...current, event]),
        }),
        Layer.succeed(Ledger, {
          append: (record) => Ref.update(appended, (current) => [...current, record]),
          recent: () => Effect.succeed([]),
          lastBaseForBranch: () => Effect.succeed(Option.none()),
          resolveResume: () => Effect.die("the sandbox never resumes"),
          newestBranchForIssue: () => Effect.die("the sandbox dispatches no feature"),
        }),
      ),
    );

    return { runtimeRoot, repoRoot, plan, events, appended, commands, layer };
  });

describe("the sandbox inside the run's scope", () => {
  it.scoped("starts the container the plan and the config describe, and removes it after", () =>
    Effect.gen(function* () {
      const scratch = yield* scoped();
      yield* runInScope(
        scratch.plan,
        scratch.repoRoot,
        TEST_CREDENTIAL,
        TEST_FORGE_REPO,
        () => Effect.void,
      ).pipe(Effect.provide(scratch.layer));

      const docker = (yield* Ref.get(scratch.commands)).filter((command) =>
        command.startsWith("docker"),
      );
      expect(docker).toHaveLength(2);
      // The values the plan derived and the config decided, end to end: the
      // container's name, the checkout as its workspace, the resolved spec
      // path mounted read-only, and the one declared capability.
      expect(docker[0]).toContain(`--name ${scratch.plan.containerId}`);
      expect(docker[0]).toContain(`-v ${scratch.plan.checkoutPath}:${WORKSPACE_TARGET}`);
      expect(docker[0]).toContain(`-v ${scratch.repoRoot}/tasks/T6.md:${SPEC_TARGET}:ro`);
      expect(docker[0]).toContain("--cap-drop ALL --cap-add CHOWN");
      expect(docker[0]).toContain(`--memory ${defaultConfig.memory}`);
      for (const label of ownershipLabels(scratch.repoRoot)) {
        expect(docker[0]).toContain(`--label ${label}`);
      }
      expect(docker[1]).toBe(`docker rm -fv ${CONTAINER_ID}`);
      // Two docker commands and no third: this config names no setup hook, so
      // the step is not there to skip (T7) and the run proceeds to its work.
      expect(docker.some((command) => command.startsWith("docker exec"))).toBe(false);
      expect(resourceEventsIn(yield* Ref.get(scratch.events))).toEqual([
        ["ResourceAcquired", "lock"],
        ["ResourceAcquired", "checkout"],
        ["ResourceAcquired", "sandbox"],
        ["ResourceReleased", "sandbox"],
        ["ResourceReleased", "checkout"],
        ["ResourceReleased", "lock"],
      ]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // The setup hook, end to end (T7): the config names a host script, the
  // container gets it read-only under `/bessemer`, and the run runs it there
  // through `Sandbox.exec` — the same path, derived once, in the mount and in
  // the command alike.
  it.scoped("mounts the declared setup hook read-only and runs it in the container", () =>
    Effect.gen(function* () {
      const scratch = yield* scoped(
        { ...happyScript, "docker exec": { exit: 0 } },
        {
          setupHook: SETUP_HOOK,
        },
      );
      yield* runInScope(
        scratch.plan,
        scratch.repoRoot,
        TEST_CREDENTIAL,
        TEST_FORGE_REPO,
        () => Effect.void,
      ).pipe(Effect.provide(scratch.layer));

      const docker = (yield* Ref.get(scratch.commands)).filter((command) =>
        command.startsWith("docker"),
      );
      const target = `${SETUP_HOOK_DIR}/${SETUP_HOOK}`;
      expect(docker[0]).toContain(`-v ${scratch.repoRoot}/${SETUP_HOOK}:${target}:ro`);
      // Between the container starting and the container going, and pointed at
      // the path the mount put it at.
      expect(docker[1]).toBe(`docker exec ${CONTAINER_ID} bash ${target}`);
      expect(docker[2]).toBe(`docker rm -fv ${CONTAINER_ID}`);
      // A completed run, with the row that says so: the hook is a step, not a
      // resource, and nothing about it changes what the scope holds.
      const rows = yield* Ref.get(scratch.appended);
      expect(rows[0]?.terminalReason).toEqual(Option.some({ _tag: "Completed" }));
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // What the hook says reaches the log (T90), marked as the hook's and not the
  // agent's, and the step ends on a line with its duration — the one place a
  // dispatcher watching learns the run has moved from setup to the first pass.
  it.scoped("logs each line the setup hook prints, and how long it took", () =>
    Effect.gen(function* () {
      const scratch = yield* scoped(
        {
          ...happyScript,
          "docker exec": {
            exit: 0,
            stdout: "added 212 packages in 9s\nready\n",
            stderr: "npm warn deprecated glob@7.2.3\n",
          },
        },
        { setupHook: SETUP_HOOK },
      );
      const fs = yield* FileSystem.FileSystem;
      yield* runInScope(
        scratch.plan,
        scratch.repoRoot,
        TEST_CREDENTIAL,
        TEST_FORGE_REPO,
        () => Effect.void,
      ).pipe(Effect.provide(scratch.layer));

      const events = yield* Ref.get(scratch.events);
      expect(
        events.flatMap((event) =>
          event._tag === "SetupOutput" ? [[event.stream, event.line] as const] : [],
        ),
      ).toEqual([
        ["stdout", "added 212 packages in 9s"],
        ["stdout", "ready"],
        ["stderr", "npm warn deprecated glob@7.2.3"],
      ]);
      const finished = events.findIndex((event) => event._tag === "SetupFinished");
      expect(finished).toBeGreaterThan(
        events.findLastIndex((event) => event._tag === "SetupOutput"),
      );
      expect(events.some((event) => event._tag === "SetupFailed")).toBe(false);

      const log = yield* fs.readFileString(Option.getOrThrow(scratch.plan.logPath));
      expect(log).toContain("setup | added 212 packages in 9s");
      expect(log).toContain("setup | ready");
      expect(log).toContain("setup ! npm warn deprecated glob@7.2.3");
      expect(log).toMatch(/setup hook finished \(\d+s\)/);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // Matrix row 7: the hook exited nonzero, so the run stopped at `setup` —
  // sandbox, checkout, and lock released in that order, one `failed` row
  // naming the stage, and a typed `SandboxError` carrying the script's stderr.
  it.scoped("fails a setup hook that exits nonzero, releasing all three in reverse", () =>
    Effect.gen(function* () {
      const scratch = yield* scoped(
        {
          ...happyScript,
          "docker exec": { exit: 1, stderr: "setup.sh: could not start postgres\n" },
          "docker inspect": ALIVE,
        },
        { setupHook: SETUP_HOOK },
      );
      const fs = yield* FileSystem.FileSystem;
      const outcome = yield* Effect.either(
        runInScope(scratch.plan, scratch.repoRoot, TEST_CREDENTIAL, TEST_FORGE_REPO, () =>
          Effect.fail("the work never ran"),
        ).pipe(Effect.provide(scratch.layer)),
      );

      expect(Either.isLeft(outcome)).toBe(true);
      if (Either.isLeft(outcome)) {
        expect(outcome.left).toBeInstanceOf(SandboxError);
        if (outcome.left instanceof SandboxError) {
          expect(outcome.left.detail).toContain(`bash ${SETUP_HOOK_DIR}/${SETUP_HOOK}' exited 1`);
          expect(outcome.left.detail).toContain("could not start postgres");
        }
      }
      const rows = yield* Ref.get(scratch.appended);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.terminalReason).toEqual(
        Option.some({ _tag: "Failed", stage: "setup" as const }),
      );
      // The ordering invariant, read off the test `Reporter`'s `Ref` rather
      // than off the host (SPEC §11).
      expect(resourceEventsIn(yield* Ref.get(scratch.events))).toEqual([
        ["ResourceAcquired", "lock"],
        ["ResourceAcquired", "checkout"],
        ["ResourceAcquired", "sandbox"],
        ["ResourceReleased", "sandbox"],
        ["ResourceReleased", "checkout"],
        ["ResourceReleased", "lock"],
      ]);
      // And the host afterwards agrees: the container was removed, the lock
      // file is gone, and the checkout went home with it.
      expect(
        (yield* Ref.get(scratch.commands)).filter((command) => command.startsWith("docker rm")),
      ).toEqual([`docker rm -fv ${CONTAINER_ID}`]);
      expect(yield* fs.readDirectory(`${scratch.runtimeRoot}/locks`)).toEqual([]);
      expect(yield* fs.exists(scratch.plan.checkoutPath)).toBe(false);
      // **And the log says why** (T90): the last event before the releases is
      // the failure, carrying the exit code and the hook's own stderr, rather
      // than a log that stops at `sandbox: released`.
      const events = yield* Ref.get(scratch.events);
      const releases = events.findIndex((event) => event._tag === "ResourceReleased");
      const last = events[releases - 1];
      expect(last?._tag).toBe("SetupFailed");
      if (last?._tag === "SetupFailed") {
        expect(last.detail).toContain("exited 1");
        expect(last.detail).toContain("could not start postgres");
      }
      expect(events.some((event) => event._tag === "SetupFinished")).toBe(false);
      const log = yield* fs.readFileString(Option.getOrThrow(scratch.plan.logPath));
      expect(log).toMatch(/setup hook failed \(\d+s\): .*exited 1.*could not start postgres/);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // The setup budget (T90), on the live clock for T9's reason: a virtual clock
  // would have to be adjusted after the timeout registered its sleep, and
  // nothing says when that happened. One real second, because the budget is a
  // config value and the case sets it to one. The hang is the caller's to end
  // — the interrupt closes the exec's scope, which is what kills the child —
  // and the run fails at `setup` with a message naming the limit and the key.
  it.scopedLive("kills a setup hook that runs past setup-timeout, failing at setup", () =>
    Effect.gen(function* () {
      const scratch = yield* scoped(
        { ...happyScript, "docker exec": { hangs: true, stdout: "fetching…\n" } },
        { setupHook: SETUP_HOOK, setupTimeoutSeconds: 1 },
      );
      const fs = yield* FileSystem.FileSystem;
      const outcome = yield* Effect.either(
        runInScope(scratch.plan, scratch.repoRoot, TEST_CREDENTIAL, TEST_FORGE_REPO, () =>
          Effect.fail("the work never ran"),
        ).pipe(Effect.provide(scratch.layer)),
      );

      expect(Either.isLeft(outcome)).toBe(true);
      if (Either.isLeft(outcome)) {
        expect(outcome.left).toBeInstanceOf(SandboxError);
        if (outcome.left instanceof SandboxError) {
          expect(outcome.left.detail).toContain("1s");
          expect(outcome.left.detail).toContain("setup-timeout");
        }
      }
      const rows = yield* Ref.get(scratch.appended);
      expect(rows[0]?.terminalReason).toEqual(
        Option.some({ _tag: "Failed", stage: "setup" as const }),
      );
      expect(resourceEventsIn(yield* Ref.get(scratch.events))).toEqual([
        ["ResourceAcquired", "lock"],
        ["ResourceAcquired", "checkout"],
        ["ResourceAcquired", "sandbox"],
        ["ResourceReleased", "sandbox"],
        ["ResourceReleased", "checkout"],
        ["ResourceReleased", "lock"],
      ]);
      // What the hook said before the kill is in the log, and so is the kill.
      const log = yield* fs.readFileString(Option.getOrThrow(scratch.plan.logPath));
      expect(log).toContain("setup | fetching…");
      expect(log).toMatch(/setup hook failed \(1s\): .*setup-timeout/);
      expect(
        (yield* Ref.get(scratch.commands)).filter((command) => command.startsWith("docker rm")),
      ).toEqual([`docker rm -fv ${CONTAINER_ID}`]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // Matrix row 6: the daemon refused the start, so the run stopped at the
  // sandbox — checkout and lock released, one `failed` row naming that stage,
  // and a typed `SandboxError` for the caller to render.
  it.scoped("fails a refused start as a typed SandboxError and records stage sandbox", () =>
    Effect.gen(function* () {
      const scratch = yield* scoped({
        ...happyScript,
        "docker run": { exit: 125, stderr: "docker: Error response from daemon: no such image\n" },
      });
      const fs = yield* FileSystem.FileSystem;
      const outcome = yield* Effect.either(
        runInScope(
          scratch.plan,
          scratch.repoRoot,
          TEST_CREDENTIAL,
          TEST_FORGE_REPO,
          () => Effect.void,
        ).pipe(Effect.provide(scratch.layer)),
      );

      expect(Either.isLeft(outcome)).toBe(true);
      if (Either.isLeft(outcome)) {
        expect(outcome.left._tag).toBe("SandboxError");
        expect(outcome.left.detail).toContain("no such image");
      }
      const rows = yield* Ref.get(scratch.appended);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.terminalReason).toEqual(
        Option.some({ _tag: "Failed", stage: "sandbox" as const }),
      );
      // Both resources below it let go, and nothing was left behind: no lock
      // file, no checkout, and no container to remove.
      expect(resourceEventsIn(yield* Ref.get(scratch.events))).toEqual([
        ["ResourceAcquired", "lock"],
        ["ResourceAcquired", "checkout"],
        ["ResourceReleased", "checkout"],
        ["ResourceReleased", "lock"],
      ]);
      expect(yield* fs.readDirectory(`${scratch.runtimeRoot}/locks`)).toEqual([]);
      expect(yield* fs.exists(scratch.plan.checkoutPath)).toBe(false);
      expect(
        (yield* Ref.get(scratch.commands)).filter((command) => command.startsWith("docker rm")),
      ).toEqual([]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // Matrix row 19, inside the run: the removal failed, so it is reported and
  // swallowed — the run's own error is what the caller sees, the row is the
  // run's own, and the two resources under the sandbox still release.
  it.scoped("reports a failed removal and leaves the run's own error unmasked", () =>
    Effect.gen(function* () {
      const scratch = yield* scoped({
        ...happyScript,
        "docker rm": { exit: 1, stderr: "Error response from daemon: device or resource busy\n" },
      });
      const fs = yield* FileSystem.FileSystem;
      const exit = yield* Effect.exit(
        runInScope(scratch.plan, scratch.repoRoot, TEST_CREDENTIAL, TEST_FORGE_REPO, () =>
          Effect.fail("the run's own error"),
        ).pipe(Effect.provide(scratch.layer)),
      );

      expect(exit).toEqual(Exit.fail("the run's own error"));
      const warnings = warningsIn(yield* Ref.get(scratch.events));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("could not remove the sandbox");
      expect(warnings[0]).toContain("reconciler");
      // The warning is in the run log too, which is the file someone reads
      // when a container turns up on the host afterwards.
      expect(yield* fs.readFileString(Option.getOrThrow(scratch.plan.logPath))).toContain(
        "could not remove the sandbox",
      );
      expect(resourceEventsIn(yield* Ref.get(scratch.events))).toEqual([
        ["ResourceAcquired", "lock"],
        ["ResourceAcquired", "checkout"],
        ["ResourceAcquired", "sandbox"],
        ["ResourceReleased", "checkout"],
        ["ResourceReleased", "lock"],
      ]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
});

// `Sandbox.build` (T111) against a scripted docker: the argv `renderBuildArgs`
// renders reaches the CLI, docker's lines reach the spec's `onOutput` — both
// streams, since BuildKit narrates on stderr — and a nonzero build is a typed
// `SandboxError` carrying that stderr.
const buildSpec = (seen: Ref.Ref<ReadonlyArray<string>>) => ({
  tag: "hae-agentbox",
  context: "/srv/hae/.bessemer/image",
  dockerfile: "/srv/hae/.bessemer/image/Dockerfile",
  buildArgs: { AGENT_UID: "501", AGENT_GID: "20" },
  labels: { "bessemer.inputs": ".bessemer/image/Dockerfile", "bessemer.inputs.digest": "d" },
  onOutput: (line: string) => Ref.update(seen, (current) => [...current, line]),
});

describe("the image build", () => {
  it.effect("runs docker build with the rendered argv and streams its output", () =>
    Effect.gen(function* () {
      const scratch = yield* world({
        "docker build": { exit: 0, stdout: "sha256:feed\n", stderr: "#1 load\n#2 done\n" },
      });
      const seen = yield* Ref.make<ReadonlyArray<string>>([]);
      yield* Effect.flatMap(Sandbox, (sandbox) => sandbox.build(buildSpec(seen))).pipe(
        Effect.provide(scratch.layer),
      );

      expect(yield* Ref.get(scratch.commands)).toEqual([
        "docker build --file /srv/hae/.bessemer/image/Dockerfile --tag hae-agentbox" +
          " --build-arg AGENT_UID=501 --build-arg AGENT_GID=20" +
          " --label bessemer.inputs=.bessemer/image/Dockerfile --label bessemer.inputs.digest=d" +
          " /srv/hae/.bessemer/image",
      ]);
      expect((yield* Ref.get(seen)).toSorted()).toEqual(["#1 load", "#2 done", "sha256:feed"]);
      // The layer emits nothing of its own: the callback is the caller's.
      expect(yield* Ref.get(scratch.events)).toEqual([]);
    }),
  );

  it.effect("fails a nonzero build with a typed SandboxError carrying docker's stderr", () =>
    Effect.gen(function* () {
      const scratch = yield* world({
        "docker build": { exit: 1, stderr: "ERROR: failed to solve: no such file\n" },
      });
      const seen = yield* Ref.make<ReadonlyArray<string>>([]);
      const result = yield* Effect.flatMap(Sandbox, (sandbox) =>
        sandbox.build(buildSpec(seen)),
      ).pipe(Effect.provide(scratch.layer), Effect.either);

      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        expect(result.left).toBeInstanceOf(SandboxError);
        expect(result.left.detail).toContain("could not build the image 'hae-agentbox'");
        expect(result.left.detail).toContain("ERROR: failed to solve: no such file");
        expect(result.left.sandboxGone).toBe(false);
      }
    }),
  );
});
