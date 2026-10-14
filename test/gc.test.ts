// `gc`'s listing (T99): the reconciler's scan and classification, listed with
// what `--force` would do, over a real runtime root on disk — only dockerd is
// scripted. The renderer is asserted as a pure function over the snapshot.
import { describe, expect, it } from "@effect/vitest";
import { FileSystem } from "@effect/platform";
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { Effect, Either, Exit, Layer, Option, Ref } from "effect";
import { SpeepoboxConfig, defaultConfig } from "../src/config/config.ts";
import { speepoboxDir } from "../src/config/paths.ts";
import {
  CHECKOUTS_DIRNAME,
  checkoutPathFor,
  LOCKS_DIRNAME,
  LOGS_DIRNAME,
  lockPathFor,
  statusIndexPathFor,
} from "../src/dispatch/plan.ts";
import { renderFailure } from "../src/dispatch/render.ts";
import { GcRefused, parseGcArgv } from "../src/gc/argv.ts";
import { reclaimAll } from "../src/gc/force.ts";
import { gc, gcSnapshot, slugOfWitness, wouldFor } from "../src/gc/gc.ts";
import { parseClaimName } from "../src/gc/names.ts";
import {
  DAEMON_DOWN_NOTE,
  formatSize,
  NOTHING_TO_RECLAIM,
  renderGc,
  UNWITNESSED_WOULD,
} from "../src/gc/render.ts";
import type { GcLeftover, GcSnapshot } from "../src/gc/snapshot.ts";
import { Git, GitError } from "../src/git/git.ts";
import { RunLock, RunLockLive } from "../src/lock/run-lock.ts";
import type { WreckageScan } from "../src/reconcile/reconcile.ts";
import { Reporter, type ReporterEvent } from "../src/reporter.ts";
import { SandboxLive } from "../src/sandbox/sandbox.ts";
import { type ScriptedResult, scriptedExecutor } from "./support/exec-fake.ts";
import { type FakeGitOptions, fakeGit, type GitCall, PRE_TIP } from "./support/git-fake.ts";

// Above Linux's pid_max, so `kill -0` can only answer "no such process".
const DEAD_PID = 2147483647;

// The listing's tags and the three `--force` acts with (T100): the real
// `RunLock` and the real `Sandbox` over a scripted docker, as the
// reconciler's cases run them, and the fake `Git` whose fetch-backs and
// containment read decide what the salvage answers. The served repo carries a
// committed config that decodes, because `--force` refuses one that does not.
interface WorldOptions {
  readonly dockerRm?: ScriptedResult;
  readonly git?: FakeGitOptions;
  // Branches the served repo does not have (T107): `revParse` of one in the
  // repo root fails, as git's `--verify` does.
  readonly absent?: ReadonlyArray<string>;
}

const world = (dockerPs: ScriptedResult, options: WorldOptions = {}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const runtimeRoot = yield* fs.makeTempDirectoryScoped();
    const repoRoot = yield* fs.makeTempDirectoryScoped();
    yield* fs.makeDirectory(speepoboxDir(repoRoot));
    yield* fs.writeFileString(
      `${speepoboxDir(repoRoot)}/config.toml`,
      `image = "baseline-image"\nbase = "origin/main"\n`,
    );
    const events = yield* Ref.make<ReadonlyArray<ReporterEvent>>([]);
    const commands = yield* Ref.make<ReadonlyArray<string>>([]);
    const gitCalls = yield* Ref.make<ReadonlyArray<GitCall>>([]);
    const absent = options.absent ?? [];
    const git = Layer.effect(
      Git,
      Effect.map(Git, (inner) => ({
        ...inner,
        revParse: (read: Parameters<typeof inner.revParse>[0]) =>
          read.repo === repoRoot && absent.some((branch) => read.rev === `refs/heads/${branch}`)
            ? Ref.update(gitCalls, (current): ReadonlyArray<GitCall> => [
                ...current,
                { _tag: "RevParse", ...read },
              ]).pipe(
                Effect.zipRight(
                  new GitError({ detail: `fatal: Needed a single revision (${read.rev})` }),
                ),
              )
            : inner.revParse(read),
      })),
    ).pipe(Layer.provide(fakeGit(gitCalls, options.git)));
    const layer = Layer.provideMerge(
      Layer.mergeAll(SandboxLive, RunLockLive, git),
      Layer.mergeAll(
        NodeFileSystem.layer,
        NodePath.layer,
        scriptedExecutor(
          { "docker ps": dockerPs, "docker rm": options.dockerRm ?? { exit: 0 } },
          commands,
        ),
        Layer.succeed(SpeepoboxConfig, { ...defaultConfig, runtimeRoot }),
        Layer.succeed(Reporter, {
          emit: (event) => Ref.update(events, (current) => [...current, event]),
        }),
      ),
    );
    return { runtimeRoot, repoRoot, events, commands, gitCalls, layer };
  });

const leaveLock = (runtimeRoot: string, slug: string, pid: number) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(`${runtimeRoot}/${LOCKS_DIRNAME}`, { recursive: true });
    yield* fs.writeFileString(lockPathFor(runtimeRoot, slug), `${pid}\n`);
  });

// A checkout holding exactly `bytes` of file content, some of it nested, so
// the size is a recursive sum rather than the top directory's.
const leaveCheckout = (runtimeRoot: string, slug: string, bytes = 0) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const checkout = checkoutPathFor(runtimeRoot, slug);
    yield* fs.makeDirectory(`${checkout}/.git`, { recursive: true });
    const head = `ref: refs/heads/${slug}\n`;
    yield* fs.writeFileString(`${checkout}/.git/HEAD`, head);
    yield* fs.makeDirectory(`${checkout}/src/deep`, { recursive: true });
    yield* fs.writeFileString(`${checkout}/src/deep/work.txt`, "x".repeat(bytes - head.length));
  });

const containerRow = (slug: string, state: string) => `c-${slug}\tspeepobox-${slug}\t${state}`;

// Every path under a directory with its contents, so "wrote nothing" is a
// comparison of two values rather than a spot check.
const treeOf = (root: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const entries = (yield* fs.readDirectory(root, { recursive: true })).toSorted();
    return yield* Effect.forEach(entries, (entry) =>
      Effect.gen(function* () {
        const info = yield* fs.stat(`${root}/${entry}`);
        return info.type === "File"
          ? `${entry}=${yield* fs.readFileString(`${root}/${entry}`)}`
          : `${entry}/`;
      }),
    );
  });

describe("the gc snapshot", () => {
  it.scoped("lists one slug of each verdict with what --force would do", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const scratch = yield* world({
        exit: 0,
        stdout: [
          containerRow("dead-run", "running"),
          containerRow("kept-run", "exited"),
          containerRow("live-run", "running"),
        ].join("\n"),
      });
      yield* leaveLock(scratch.runtimeRoot, "dead-run", DEAD_PID);
      yield* leaveCheckout(scratch.runtimeRoot, "dead-run", 3000);
      yield* leaveCheckout(scratch.runtimeRoot, "kept-run", 100);
      yield* leaveLock(scratch.runtimeRoot, "live-run", process.pid);
      const witness = `${lockPathFor(scratch.runtimeRoot, "gone-run")}.${DEAD_PID}.evicting`;
      yield* fs.writeFileString(witness, `${DEAD_PID}\n`);

      const snapshot = yield* gcSnapshot(scratch.repoRoot).pipe(Effect.provide(scratch.layer));

      expect(snapshot.daemonAnswered).toBe(true);
      expect(snapshot.slugs.map((found) => [found.slug, found.verdict._tag])).toEqual([
        ["dead-run", "Reclaimable"],
        ["kept-run", "Kept"],
        ["live-run", "Live"],
      ]);
      const [dead, kept, live] = snapshot.slugs;
      expect(dead?.resources.map((resource) => [resource.kind, resource.would])).toEqual([
        ["container", "remove the container"],
        ["checkout", "salvage then remove"],
        ["lock", "reclaim the lock"],
      ]);
      expect(kept?.resources.map((resource) => [resource.kind, resource.would])).toEqual([
        ["container", "remove the stopped container"],
        ["checkout", "salvage then remove"],
      ]);
      expect(live?.resources.map((resource) => [resource.kind, resource.would])).toEqual([
        ["container", `skip — pid ${process.pid} still holds its lock`],
        ["lock", `skip — pid ${process.pid} still holds its lock`],
      ]);

      // Sizes: the checkout's recursive sum, and `-` where none applies. Ages
      // come off `mtime`, so every on-disk entry has one and a container none.
      const checkout = dead?.resources.find((resource) => resource.kind === "checkout");
      expect(checkout?.size).toEqual({ _tag: "Measured", value: 3000 });
      expect(checkout?.modifiedAt._tag).toBe("Measured");
      const container = dead?.resources.find((resource) => resource.kind === "container");
      expect(container?.size).toEqual({ _tag: "NotApplicable" });
      expect(container?.modifiedAt).toEqual({ _tag: "NotApplicable" });
      const lock = dead?.resources.find((resource) => resource.kind === "lock");
      expect(lock?.size).toEqual({ _tag: "NotApplicable" });
      expect(lock?.modifiedAt._tag).toBe("Measured");

      expect(snapshot.witnesses).toEqual([
        {
          path: witness,
          slug: "gone-run",
          modifiedAt: expect.objectContaining({ _tag: "Measured" }),
        },
      ]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // bash's `--docker-down`: no query ran, so no container rows, and the rest
  // of the host is listed under a header that says liveness went unverified.
  it.scoped("lists the disk without containers when dockerd cannot be asked", () =>
    Effect.gen(function* () {
      const scratch = yield* world({ exit: 1, stderr: "Cannot connect to the Docker daemon" });
      yield* leaveLock(scratch.runtimeRoot, "dead-run", DEAD_PID);
      yield* leaveCheckout(scratch.runtimeRoot, "dead-run", 100);

      const snapshot = yield* gcSnapshot(scratch.repoRoot).pipe(Effect.provide(scratch.layer));

      expect(snapshot.daemonAnswered).toBe(false);
      expect(snapshot.slugs.map((found) => found.slug)).toEqual(["dead-run"]);
      expect(snapshot.slugs[0]?.resources.map((resource) => resource.kind)).toEqual([
        "checkout",
        "lock",
      ]);
      const rendered = renderGc(snapshot);
      expect(rendered.split("\n")[0]).toContain(DAEMON_DOWN_NOTE);
      expect(rendered).not.toContain("container");
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped("says there is nothing to reclaim, and still prints the logs line", () =>
    Effect.gen(function* () {
      const scratch = yield* world({ exit: 0, stdout: "\n" });

      const snapshot = yield* gcSnapshot(scratch.repoRoot).pipe(Effect.provide(scratch.layer));

      expect(snapshot.slugs).toEqual([]);
      expect(snapshot.witnesses).toEqual([]);
      expect(snapshot.leftovers).toEqual([]);
      expect(snapshot.logs).toEqual({ count: 0, bytes: { _tag: "Measured", value: 0 } });
      expect(renderGc(snapshot).split("\n")).toEqual([
        "What this host holds from speepobox runs",
        `  ${NOTHING_TO_RECLAIM}`,
        "  logs: 0 run logs, 0B total — kept (audit trail, gc never deletes logs)",
      ]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // Logs are keyed off the run id (`logPathFor`), so several runs of several
  // slugs share one directory, and every `.log` directly in it counts once.
  it.scoped("counts every run log of every slug in one line", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const scratch = yield* world({ exit: 0, stdout: "" });
      const logs = `${scratch.runtimeRoot}/${LOGS_DIRNAME}`;
      yield* fs.makeDirectory(`${logs}/nested`, { recursive: true });
      yield* fs.writeFileString(`${logs}/speepobox-t8-1786000000000.log`, "a".repeat(1000));
      yield* fs.writeFileString(`${logs}/speepobox-t8-1786000000001.log`, "b".repeat(1000));
      yield* fs.writeFileString(`${logs}/feature-foo-1786000000002.log`, "c".repeat(48));
      // Neither of these is a run log directly in the directory.
      yield* fs.writeFileString(`${logs}/notes.txt`, "d".repeat(500));
      yield* fs.writeFileString(`${logs}/nested/elsewhere.log`, "e".repeat(500));

      const snapshot = yield* gcSnapshot(scratch.repoRoot).pipe(Effect.provide(scratch.layer));

      expect(snapshot.logs).toEqual({ count: 3, bytes: { _tag: "Measured", value: 2048 } });
      expect(renderGc(snapshot)).toContain(
        "logs: 3 run logs, 2.0K total — kept (audit trail, gc never deletes logs)",
      );
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // The same zero-write assertion T97's scan case makes, over the whole
  // runtime root: every path and every file's contents as they were, and the
  // one subprocess the daemon's question — no git, no removal.
  it.scoped("writes nothing, removes nothing, and runs no git", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const scratch = yield* world({
        exit: 0,
        stdout: containerRow("dead-run", "exited"),
      });
      yield* leaveLock(scratch.runtimeRoot, "dead-run", DEAD_PID);
      yield* leaveCheckout(scratch.runtimeRoot, "dead-run", 100);
      yield* leaveCheckout(scratch.runtimeRoot, "kept-run", 100);
      yield* fs.writeFileString(
        `${lockPathFor(scratch.runtimeRoot, "gone-run")}.${DEAD_PID}.evicting`,
        "",
      );
      yield* fs.makeDirectory(`${scratch.runtimeRoot}/${LOGS_DIRNAME}`);
      yield* fs.writeFileString(`${scratch.runtimeRoot}/${LOGS_DIRNAME}/dead-run-1.log`, "log");
      const before = yield* treeOf(scratch.runtimeRoot);

      yield* gc({ repoRoot: scratch.repoRoot, argv: [] }).pipe(Effect.provide(scratch.layer));

      expect(yield* treeOf(scratch.runtimeRoot)).toEqual(before);
      expect(before).toContain(`${CHECKOUTS_DIRNAME}/kept-run/`);
      expect(
        (yield* Ref.get(scratch.commands)).map((command) => command.split(" ", 2).join(" ")),
      ).toEqual(["docker ps"]);
      expect((yield* Ref.get(scratch.events)).map((event) => event._tag)).toEqual(["GcReported"]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped("refuses an unknown flag before it lists anything", () =>
    Effect.gen(function* () {
      const scratch = yield* world({ exit: 0, stdout: "" });

      const exit = yield* Effect.exit(
        gc({ repoRoot: scratch.repoRoot, argv: ["--bogus"] }).pipe(Effect.provide(scratch.layer)),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      expect(yield* Ref.get(scratch.events)).toEqual([]);
      expect(yield* Ref.get(scratch.commands)).toEqual([]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
});

// What a run strands beside the classes bash knew (T108), each judged by the
// witness its name carries and never by its age. Only dead and unwitnessed
// ones are listed: a live one is in use, not left over.
const leaveFile = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(file.slice(0, file.lastIndexOf("/")), { recursive: true });
    yield* fs.writeFileString(file, "");
  });

const leftoversOf = (snapshot: GcSnapshot) =>
  snapshot.leftovers.map((leftover) => [
    leftover.kind,
    leftover.path,
    Option.getOrElse(leftover.slug, () => "-"),
    leftover.state,
  ]);

describe("the gc leftovers", () => {
  it.scoped("lists a claim whose pid is dead, and not one whose pid is alive", () =>
    Effect.gen(function* () {
      const scratch = yield* world({ exit: 0, stdout: "" });
      const dead = `${lockPathFor(scratch.runtimeRoot, "dead-run")}.${DEAD_PID}.3.claim`;
      yield* leaveFile(dead);
      yield* leaveFile(`${lockPathFor(scratch.runtimeRoot, "live-run")}.${process.pid}.1.claim`);

      const snapshot = yield* gcSnapshot(scratch.repoRoot).pipe(Effect.provide(scratch.layer));

      expect(leftoversOf(snapshot)).toEqual([["claim", dead, "dead-run", "dead"]]);
      expect(snapshot.leftovers[0]?.modifiedAt._tag).toBe("Measured");
      expect(renderGc(snapshot)).toMatch(/claim +dead-run +\S+ +- +remove/);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped("lists an index whose slug holds no live lock, and not one whose lock is live", () =>
    Effect.gen(function* () {
      const scratch = yield* world({ exit: 0, stdout: "" });
      const locks = `${scratch.runtimeRoot}/${LOCKS_DIRNAME}`;
      yield* leaveFile(`${locks}/no-lock.index`);
      yield* leaveFile(`${locks}/dead-lock.index`);
      yield* leaveLock(scratch.runtimeRoot, "dead-lock", DEAD_PID);
      yield* leaveFile(`${locks}/live-lock.index`);
      yield* leaveLock(scratch.runtimeRoot, "live-lock", process.pid);

      const snapshot = yield* gcSnapshot(scratch.repoRoot).pipe(Effect.provide(scratch.layer));

      expect(leftoversOf(snapshot)).toEqual([
        ["index", `${locks}/dead-lock.index`, "dead-lock", "dead"],
        ["index", `${locks}/no-lock.index`, "no-lock", "dead"],
      ]);
      expect(renderGc(snapshot)).toMatch(/index +no-lock +\S+ +- +remove/);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped("lists editor directories by the pid in their name, or by its absence", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const scratch = yield* world({ exit: 0, stdout: "" });
      const dead = `${scratch.runtimeRoot}/feedback-edit-${DEAD_PID}-a1B2c3`;
      // Pre-T108, with the all-digit suffix a left-to-right read takes for a pid.
      const legacy = `${scratch.runtimeRoot}/feedback-edit-482913`;
      const live = `${scratch.runtimeRoot}/task-edit-${process.pid}-x9Y8z7`;
      for (const dir of [dead, legacy, live]) {
        yield* fs.makeDirectory(dir);
        yield* fs.writeFileString(`${dir}/feedback-edit.txt`, "the dispatcher's text");
      }
      // A file carrying the marker is not an editor session.
      yield* fs.writeFileString(`${scratch.runtimeRoot}/notes-edit-${DEAD_PID}-a1B2c3`, "");

      const snapshot = yield* gcSnapshot(scratch.repoRoot).pipe(Effect.provide(scratch.layer));

      expect(leftoversOf(snapshot)).toEqual([
        ["editor", dead, "-", "dead"],
        ["editor", legacy, "-", "unwitnessed"],
      ]);
      const rendered = renderGc(snapshot);
      expect(rendered).toMatch(/edit-dir +- +\S+ +- +remove$/m);
      expect(rendered).toMatch(/edit-dir +- +\S+ +- +keep — no pid, rm -rf by hand$/m);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped("lists no leftover it cannot read a directory for, and says so", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const scratch = yield* world({ exit: 0, stdout: "" });
      // `locks` as a file: the directory read fails with something other
      // than NotFound.
      yield* fs.writeFileString(`${scratch.runtimeRoot}/${LOCKS_DIRNAME}`, "");

      const snapshot = yield* gcSnapshot(scratch.repoRoot).pipe(Effect.provide(scratch.layer));

      expect(snapshot.leftovers).toEqual([]);
      expect(said(yield* Ref.get(scratch.events), "no leftovers under it are listed")).toBe(true);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it("reads a claim's name as claim.ts writes it, and nothing else", () => {
    expect(parseClaimName("speepobox-t8.pid.4321.2.claim")).toEqual(
      Option.some({ lockFile: "speepobox-t8.pid", pid: 4321 }),
    );
    // No attempt serial: not a name the claim writes.
    expect(parseClaimName("speepobox-t8.pid.4321.claim")).toEqual(Option.none());
    expect(parseClaimName("speepobox-t8.pid.x.2.claim")).toEqual(Option.none());
    expect(parseClaimName("speepobox-t8.pid")).toEqual(Option.none());
  });
});

// `gc --force` (T100): each slug under its own lock, reclassified under it,
// and a checkout removed only on the salvage's say-so. Over a real runtime
// root, the real `RunLock` and `Sandbox`, and a fake `Git` whose fetches and
// containment read are what the salvage decides from.
const warnings = (events: ReadonlyArray<ReporterEvent>): ReadonlyArray<string> =>
  events.flatMap((event) => (event._tag === "Warned" ? [event.detail] : []));

const said = (events: ReadonlyArray<ReporterEvent>, fragment: string): boolean =>
  warnings(events).some((detail) => detail.includes(fragment));

const failureOf = (exit: Exit.Exit<void, unknown>): string =>
  Exit.isFailure(exit) ? JSON.stringify(exit.cause) : "";

const fetchBacks = (calls: ReadonlyArray<GitCall>) =>
  calls.flatMap((call) => (call._tag === "FetchBack" ? [call.onto] : []));

const leaveLog = (runtimeRoot: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const log = `${runtimeRoot}/${LOGS_DIRNAME}/dead-run-1786000000000.log`;
    yield* fs.makeDirectory(`${runtimeRoot}/${LOGS_DIRNAME}`, { recursive: true });
    yield* fs.writeFileString(log, "the audit trail");
    return log;
  });

// A scan value drawn up by hand, for the cases about what changed *after* the
// scan: the world on disk is the one under the lock, this is the snapshot.
const staleScan = (wreckage: WreckageScan["wreckage"]): WreckageScan => ({
  wreckage,
  deadMarkers: [],
  stranded: [],
  containers: Option.some([]),
});

describe("gc --force", () => {
  // The kill -9 wreck, end to end: all three go, the checkout after its
  // commits were shown to be on the branch, and the logs stay.
  it.scoped("reclaims a dead run's container, checkout, and lock, and leaves the logs", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const scratch = yield* world({ exit: 0, stdout: containerRow("dead-run", "running") });
      yield* leaveLock(scratch.runtimeRoot, "dead-run", DEAD_PID);
      yield* leaveCheckout(scratch.runtimeRoot, "dead-run", 100);
      const log = yield* leaveLog(scratch.runtimeRoot);
      const witness = `${lockPathFor(scratch.runtimeRoot, "gone-run")}.${DEAD_PID}.evicting`;
      yield* fs.writeFileString(witness, `${DEAD_PID}\n`);

      yield* gc({ repoRoot: scratch.repoRoot, argv: ["--force"] }).pipe(
        Effect.provide(scratch.layer),
      );

      expect(yield* fs.exists(checkoutPathFor(scratch.runtimeRoot, "dead-run"))).toBe(false);
      expect(yield* fs.readDirectory(`${scratch.runtimeRoot}/${LOCKS_DIRNAME}`)).toEqual([]);
      expect(yield* Ref.get(scratch.commands)).toContain("docker rm -fv c-dead-run");
      expect(yield* fs.readFileString(log)).toBe("the audit trail");
      expect(fetchBacks(yield* Ref.get(scratch.gitCalls))).toEqual(["dead-run"]);

      const events = yield* Ref.get(scratch.events);
      expect(events[0]?._tag).toBe("GcReported");
      expect(said(events, "reclaimed the container 'speepobox-dead-run'")).toBe(true);
      expect(said(events, "removed checkout dead-run (its commits are on 'dead-run')")).toBe(true);
      expect(said(events, "swept a stranded eviction witness")).toBe(true);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // The one place a human clears a kept copy (T25, T28): a `Kept` verdict is
  // acted on here, which the reconciler never does.
  it.scoped("salvages and removes a kept checkout and its stopped container", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const scratch = yield* world({ exit: 0, stdout: containerRow("kept-run", "exited") });
      yield* leaveCheckout(scratch.runtimeRoot, "kept-run", 100);

      yield* gc({ repoRoot: scratch.repoRoot, argv: ["--force"] }).pipe(
        Effect.provide(scratch.layer),
      );

      expect(yield* fs.exists(checkoutPathFor(scratch.runtimeRoot, "kept-run"))).toBe(false);
      expect(yield* Ref.get(scratch.commands)).toContain("docker rm -fv c-kept-run");
      expect(yield* fs.readDirectory(`${scratch.runtimeRoot}/${LOCKS_DIRNAME}`)).toEqual([]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped("skips a live run and never locks it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const scratch = yield* world({ exit: 0, stdout: containerRow("live-run", "running") });
      yield* leaveLock(scratch.runtimeRoot, "live-run", process.pid);
      yield* leaveCheckout(scratch.runtimeRoot, "live-run", 100);

      yield* gc({ repoRoot: scratch.repoRoot, argv: ["--force"] }).pipe(
        Effect.provide(scratch.layer),
      );

      expect(
        yield* fs.exists(`${checkoutPathFor(scratch.runtimeRoot, "live-run")}/.git/HEAD`),
      ).toBe(true);
      expect(yield* fs.readFileString(lockPathFor(scratch.runtimeRoot, "live-run"))).toBe(
        `${process.pid}\n`,
      );
      expect(
        (yield* Ref.get(scratch.commands)).filter((command) => command.startsWith("docker rm")),
      ).toEqual([]);
      expect(yield* Ref.get(scratch.gitCalls)).toEqual([]);
      const events = yield* Ref.get(scratch.events);
      expect(said(events, `skip live-run — pid ${process.pid} still holds its lock`)).toBe(true);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // SPEC §4 from under the lock: the scan saw a kept copy and nothing
  // running, and by the time the lock was taken a container no lock names was
  // up — possibly another dispatcher's. Nothing of the slug is touched.
  it.scoped("skips a slug that reads live once it is locked", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const scratch = yield* world({ exit: 0, stdout: containerRow("kept-run", "running") });
      yield* leaveCheckout(scratch.runtimeRoot, "kept-run", 100);
      const checkout = checkoutPathFor(scratch.runtimeRoot, "kept-run");

      const failures = yield* reclaimAll(
        scratch.repoRoot,
        staleScan([
          {
            slug: "kept-run",
            lock: Option.none(),
            sandbox: Option.none(),
            checkout: Option.some({ path: checkout, branch: Option.some("kept-run") }),
          },
        ]),
        [],
      ).pipe(Effect.provide(scratch.layer));

      expect(failures).toBe(0);
      expect(yield* fs.exists(`${checkout}/.git/HEAD`)).toBe(true);
      expect(
        (yield* Ref.get(scratch.commands)).filter((command) => command.startsWith("docker rm")),
      ).toEqual([]);
      expect(yield* Ref.get(scratch.gitCalls)).toEqual([]);
      // The lock it took to find that out left with it.
      expect(yield* fs.readDirectory(`${scratch.runtimeRoot}/${LOCKS_DIRNAME}`)).toEqual([]);
      const events = yield* Ref.get(scratch.events);
      expect(
        said(events, "skip kept-run — its container 'speepobox-kept-run' is running and no lock"),
      ).toBe(true);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // Another dispatch got there between the scan and the lock.
  it.scoped("skips a slug whose lock is held at acquisition", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const scratch = yield* world({ exit: 0, stdout: containerRow("dead-run", "running") });
      yield* leaveLock(scratch.runtimeRoot, "dead-run", process.pid);
      yield* leaveCheckout(scratch.runtimeRoot, "dead-run", 100);
      const checkout = checkoutPathFor(scratch.runtimeRoot, "dead-run");

      const failures = yield* reclaimAll(
        scratch.repoRoot,
        staleScan([
          {
            slug: "dead-run",
            lock: Option.some({
              path: lockPathFor(scratch.runtimeRoot, "dead-run"),
              owner: Option.some(DEAD_PID),
            }),
            sandbox: Option.some({ id: "c-dead-run", name: "speepobox-dead-run", running: true }),
            checkout: Option.some({ path: checkout, branch: Option.some("dead-run") }),
          },
        ]),
        [],
      ).pipe(Effect.provide(scratch.layer));

      expect(failures).toBe(0);
      expect(yield* fs.exists(`${checkout}/.git/HEAD`)).toBe(true);
      expect(yield* fs.readFileString(lockPathFor(scratch.runtimeRoot, "dead-run"))).toBe(
        `${process.pid}\n`,
      );
      expect(
        (yield* Ref.get(scratch.commands)).filter((command) => command.startsWith("docker rm")),
      ).toEqual([]);
      const events = yield* Ref.get(scratch.events);
      expect(said(events, "skip dead-run — another speepobox run")).toBe(true);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // The rescue: the branch refused, a branch of the run's own took them, and
  // the containment read after that fetch authorized the removal.
  it.scoped("removes a checkout the salvage rescued, and names where the commits went", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const scratch = yield* world(
        { exit: 0, stdout: "" },
        { git: { homeFetchBackFails: "! [rejected] (non-fast-forward)" } },
      );
      yield* leaveLock(scratch.runtimeRoot, "dead-run", DEAD_PID);
      yield* leaveCheckout(scratch.runtimeRoot, "dead-run", 100);

      yield* gc({ repoRoot: scratch.repoRoot, argv: ["--force"] }).pipe(
        Effect.provide(scratch.layer),
      );

      expect(yield* fs.exists(checkoutPathFor(scratch.runtimeRoot, "dead-run"))).toBe(false);
      const [home, onto] = fetchBacks(yield* Ref.get(scratch.gitCalls));
      expect(home).toBe("dead-run");
      expect(onto).toMatch(/^dead-run-from-run-/);
      const events = yield* Ref.get(scratch.events);
      expect(
        said(
          events,
          `removed checkout dead-run — its commits would not go onto 'dead-run' — they are on '${onto}' now`,
        ),
      ).toBe(true);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // Each way the salvage keeps a copy: skipped loudly, never discarded, and
  // each ends in the recovery for the branch the copy is on.
  const keptArms: ReadonlyArray<readonly [string, FakeGitOptions, ReadonlyArray<string>]> = [
    [
      "Refused",
      { fetchBackFails: "! [rejected] (non-fast-forward)" },
      ["neither went through", "git said: ! [rejected]", "git also said: ! [rejected]"],
    ],
    ["Unverified", { fetchBackLands: false }, ["reported the move onto 'dead-run' went through"]],
    [
      "RescueUnverified",
      { homeFetchBackFails: "! [rejected] (non-fast-forward)", fetchBackLands: false },
      ["The branch would not take them", "the work reached neither destination"],
    ],
  ];
  for (const [arm, git, fragments] of keptArms) {
    it.scoped(`keeps a checkout the salvage kept (${arm}) and hands over the recovery`, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const scratch = yield* world({ exit: 0, stdout: "" }, { git });
        yield* leaveLock(scratch.runtimeRoot, "dead-run", DEAD_PID);
        yield* leaveCheckout(scratch.runtimeRoot, "dead-run", 100);
        const checkout = checkoutPathFor(scratch.runtimeRoot, "dead-run");

        const exit = yield* Effect.exit(
          gc({ repoRoot: scratch.repoRoot, argv: ["--force"] }).pipe(Effect.provide(scratch.layer)),
        );

        // A skip is gc working: exit 0.
        expect(Exit.isSuccess(exit)).toBe(true);
        expect(yield* fs.exists(`${checkout}/src/deep/work.txt`)).toBe(true);
        // The lock still goes: it leaves with the scope.
        expect(yield* fs.readDirectory(`${scratch.runtimeRoot}/${LOCKS_DIRNAME}`)).toEqual([]);
        const events = yield* Ref.get(scratch.events);
        expect(said(events, "skip dead-run — nothing could move the commits")).toBe(true);
        for (const fragment of fragments) {
          expect(said(events, fragment)).toBe(true);
        }
        expect(
          said(events, `git fetch ${checkout} refs/heads/dead-run:refs/heads/dead-run-from-run`),
        ).toBe(true);
        expect(said(events, "removed checkout")).toBe(false);
      }).pipe(Effect.provide(NodeFileSystem.layer)),
    );
  }

  it.scoped("keeps a detached copy without asking git anything", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const scratch = yield* world({ exit: 0, stdout: "" });
      yield* leaveLock(scratch.runtimeRoot, "dead-run", DEAD_PID);
      const checkout = checkoutPathFor(scratch.runtimeRoot, "dead-run");
      yield* fs.makeDirectory(`${checkout}/.git`, { recursive: true });
      yield* fs.writeFileString(
        `${checkout}/.git/HEAD`,
        "9fceb02d0ae598e95dc970b74767f19372d61af8\n",
      );

      yield* gc({ repoRoot: scratch.repoRoot, argv: ["--force"] }).pipe(
        Effect.provide(scratch.layer),
      );

      expect(yield* fs.exists(`${checkout}/.git/HEAD`)).toBe(true);
      expect(yield* Ref.get(scratch.gitCalls)).toEqual([]);
      const events = yield* Ref.get(scratch.events);
      expect(said(events, "skip dead-run — its copy's HEAD names no branch")).toBe(true);
      expect(said(events, `git fetch ${checkout} HEAD`)).toBe(true);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // T107: a branch the served repo cannot read is not a destination — the
  // salvage's fetch would create it — so the commits go straight to a rescue,
  // and the copy goes once the read after that fetch says they landed.
  it.scoped("rescues a copy whose branch this repo no longer has, and never recreates it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const scratch = yield* world({ exit: 0, stdout: "" }, { absent: ["dead-run"] });
      yield* leaveLock(scratch.runtimeRoot, "dead-run", DEAD_PID);
      yield* leaveCheckout(scratch.runtimeRoot, "dead-run", 100);
      const checkout = checkoutPathFor(scratch.runtimeRoot, "dead-run");

      yield* gc({ repoRoot: scratch.repoRoot, argv: ["--force"] }).pipe(
        Effect.provide(scratch.layer),
      );

      expect(yield* fs.exists(checkout)).toBe(false);
      const calls = yield* Ref.get(scratch.gitCalls);
      // One fetch, and it is the rescue's: nothing was fetched onto the branch.
      const [onto, ...rest] = fetchBacks(calls);
      expect(onto).toMatch(/^dead-run-from-run-/);
      expect(rest).toEqual([]);
      expect(calls).toContainEqual({
        _tag: "BranchContains",
        repo: scratch.repoRoot,
        branch: onto,
        commit: PRE_TIP,
      });
      const events = yield* Ref.get(scratch.events);
      expect(
        said(
          events,
          `removed checkout dead-run — 'dead-run' could not be read here (fatal: Needed a single revision (refs/heads/dead-run)), so its commits were not sent there — they are on '${onto}' now`,
        ),
      ).toBe(true);
      expect(said(events, "would not go onto")).toBe(false);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped("exits 1 when a removal failed, after acting on everything else", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const scratch = yield* world(
        { exit: 0, stdout: containerRow("dead-run", "running") },
        { dockerRm: { exit: 1, stderr: "Error response from daemon: device busy" } },
      );
      yield* leaveLock(scratch.runtimeRoot, "dead-run", DEAD_PID);
      yield* leaveCheckout(scratch.runtimeRoot, "dead-run", 100);

      const exit = yield* Effect.exit(
        gc({ repoRoot: scratch.repoRoot, argv: ["--force"] }).pipe(Effect.provide(scratch.layer)),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      expect(failureOf(exit)).toContain("gc --force could not remove 1 item");
      // The checkout was still salvaged and removed.
      expect(yield* fs.exists(checkoutPathFor(scratch.runtimeRoot, "dead-run"))).toBe(false);
      const events = yield* Ref.get(scratch.events);
      expect(said(events, "still on this host, and still labelled ours")).toBe(true);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped("refuses when dockerd cannot be asked, after the listing, touching nothing", () =>
    Effect.gen(function* () {
      const scratch = yield* world({ exit: 1, stderr: "Cannot connect to the Docker daemon" });
      yield* leaveLock(scratch.runtimeRoot, "dead-run", DEAD_PID);
      yield* leaveCheckout(scratch.runtimeRoot, "dead-run", 100);
      yield* leaveLog(scratch.runtimeRoot);
      const before = yield* treeOf(scratch.runtimeRoot);

      const exit = yield* Effect.exit(
        gc({ repoRoot: scratch.repoRoot, argv: ["--force"] }).pipe(Effect.provide(scratch.layer)),
      );

      expect(failureOf(exit)).toContain(
        "gc --force refused: dockerd could not be asked, so container liveness cannot be verified — nothing was removed",
      );
      expect(yield* treeOf(scratch.runtimeRoot)).toEqual(before);
      expect((yield* Ref.get(scratch.events)).map((event) => event._tag)).toEqual(["GcReported"]);
      expect(yield* Ref.get(scratch.gitCalls)).toEqual([]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // D8: the listing ran on the committed defaults, whose runtime root may not
  // be the one this repo's runs wrote. Plain `gc` still lists and exits 0.
  it.scoped("refuses when config.toml does not decode, and plain gc still lists", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const scratch = yield* world({ exit: 0, stdout: containerRow("dead-run", "running") });
      yield* fs.writeFileString(
        `${speepoboxDir(scratch.repoRoot)}/config.toml`,
        `image = "baseline-image"\nbase = "origin/main"\nnotify = "loud"\n`,
      );
      yield* leaveLock(scratch.runtimeRoot, "dead-run", DEAD_PID);
      yield* leaveCheckout(scratch.runtimeRoot, "dead-run", 100);
      const before = yield* treeOf(scratch.runtimeRoot);

      const listed = yield* Effect.exit(
        gc({ repoRoot: scratch.repoRoot, argv: [] }).pipe(Effect.provide(scratch.layer)),
      );
      expect(Exit.isSuccess(listed)).toBe(true);

      const exit = yield* Effect.exit(
        gc({ repoRoot: scratch.repoRoot, argv: ["--force"] }).pipe(Effect.provide(scratch.layer)),
      );

      expect(failureOf(exit)).toContain("gc --force refused: config.toml does not decode (");
      expect(failureOf(exit)).toContain(
        "the listing above is against the committed defaults, and nothing was removed",
      );
      expect(yield* treeOf(scratch.runtimeRoot)).toEqual(before);
      expect((yield* Ref.get(scratch.events)).map((event) => event._tag)).toEqual([
        "GcReported",
        "GcReported",
      ]);
      expect(
        (yield* Ref.get(scratch.commands)).filter((command) => command.startsWith("docker rm")),
      ).toEqual([]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
});

// `gc --force` on the leftovers (T109): each removed after its witness is
// asked again, an index only under its slug's lock, and a pid-less editor
// directory left to a human.
type LockLog = Ref.Ref<ReadonlyArray<string>>;

// The real `RunLock`, recording each acquisition and — from a finalizer that
// runs before the lock's own release — whether the slug's index was still
// there, so "under the lock" is asserted rather than assumed.
const recordingLock = (log: LockLog, runtimeRoot: string) =>
  Layer.effect(
    RunLock,
    Effect.gen(function* () {
      const inner = yield* RunLock;
      const fs = yield* FileSystem.FileSystem;
      const append = (line: string) =>
        Ref.update(log, (current): ReadonlyArray<string> => [...current, line]);
      return {
        acquire: (slug: string) =>
          inner.acquire(slug).pipe(
            Effect.tap(() => append(`acquire ${slug}`)),
            Effect.tap(() =>
              Effect.addFinalizer(() =>
                fs.exists(statusIndexPathFor(runtimeRoot, slug)).pipe(
                  Effect.orElseSucceed(() => true),
                  Effect.flatMap((exists) => append(`release ${slug} index=${exists}`)),
                ),
              ),
            ),
          ),
      };
    }),
  );

const deadLeftover = (kind: GcLeftover["kind"], path: string, slug?: string): GcLeftover => ({
  kind,
  path,
  slug: Option.fromNullable(slug),
  modifiedAt: { _tag: "Unmeasured" },
  state: "dead",
});

describe("gc --force on the leftovers", () => {
  it.scoped("removes a dead claim and leaves the logs", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const scratch = yield* world({ exit: 0, stdout: "" });
      const claim = `${lockPathFor(scratch.runtimeRoot, "dead-run")}.${DEAD_PID}.3.claim`;
      yield* leaveFile(claim);
      const log = yield* leaveLog(scratch.runtimeRoot);

      yield* gc({ repoRoot: scratch.repoRoot, argv: ["--force"] }).pipe(
        Effect.provide(scratch.layer),
      );

      expect(yield* fs.exists(claim)).toBe(false);
      expect(yield* fs.readFileString(log)).toBe("the audit trail");
      expect(said(yield* Ref.get(scratch.events), `removed claim ${claim}`)).toBe(true);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // Planted between the listing and the force: the listing's `dead` is a
  // snapshot, and the pid is asked again right before the removal.
  it.scoped("skips a claim whose pid is alive at removal time", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const scratch = yield* world({ exit: 0, stdout: "" });
      const claim = `${lockPathFor(scratch.runtimeRoot, "live-run")}.${process.pid}.1.claim`;
      yield* leaveFile(claim);

      const failures = yield* reclaimAll(scratch.repoRoot, staleScan([]), [
        deadLeftover("claim", claim, "live-run"),
      ]).pipe(Effect.provide(scratch.layer));

      expect(failures).toBe(0);
      expect(yield* fs.exists(claim)).toBe(true);
      expect(
        said(
          yield* Ref.get(scratch.events),
          `skip ${claim} — its process (pid ${process.pid}) is running`,
        ),
      ).toBe(true);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped("removes a dead editor directory with its contents", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const scratch = yield* world({ exit: 0, stdout: "" });
      const dir = `${scratch.runtimeRoot}/feedback-edit-${DEAD_PID}-a1B2c3`;
      yield* fs.makeDirectory(dir);
      yield* fs.writeFileString(`${dir}/feedback-edit.txt`, "the dispatcher's text");

      yield* gc({ repoRoot: scratch.repoRoot, argv: ["--force"] }).pipe(
        Effect.provide(scratch.layer),
      );

      expect(yield* fs.exists(dir)).toBe(false);
      expect(said(yield* Ref.get(scratch.events), `removed editor ${dir}`)).toBe(true);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped("keeps a pid-less editor directory and hands over its rm -rf", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const scratch = yield* world({ exit: 0, stdout: "" });
      const dir = `${scratch.runtimeRoot}/feedback-edit-482913`;
      yield* fs.makeDirectory(dir);
      yield* fs.writeFileString(`${dir}/feedback-edit.txt`, "the dispatcher's text");

      const exit = yield* Effect.exit(
        gc({ repoRoot: scratch.repoRoot, argv: ["--force"] }).pipe(Effect.provide(scratch.layer)),
      );

      // A skip, not a failure.
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(yield* fs.readFileString(`${dir}/feedback-edit.txt`)).toBe("the dispatcher's text");
      const events = yield* Ref.get(scratch.events);
      expect(said(events, "predates pid-named editor directories")).toBe(true);
      expect(said(events, `rm -rf ${dir}`)).toBe(true);
      expect(said(events, "removed editor")).toBe(false);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped("removes an index for a slug in the loop inside that slug's lock", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const scratch = yield* world({ exit: 0, stdout: "" });
      yield* leaveLock(scratch.runtimeRoot, "dead-run", DEAD_PID);
      yield* leaveCheckout(scratch.runtimeRoot, "dead-run", 100);
      const index = statusIndexPathFor(scratch.runtimeRoot, "dead-run");
      yield* leaveFile(index);
      const locks = yield* Ref.make<ReadonlyArray<string>>([]);

      yield* gc({ repoRoot: scratch.repoRoot, argv: ["--force"] }).pipe(
        Effect.provide(
          Layer.provideMerge(recordingLock(locks, scratch.runtimeRoot), scratch.layer),
        ),
      );

      expect(yield* fs.exists(index)).toBe(false);
      // One acquisition — the loop's — and the index was gone before it released.
      expect(yield* Ref.get(locks)).toEqual(["acquire dead-run", "release dead-run index=false"]);
      expect(said(yield* Ref.get(scratch.events), `removed index ${index}`)).toBe(true);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped("takes a slug's lock of its own for an index nothing else of it is left beside", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const scratch = yield* world({ exit: 0, stdout: "" });
      const index = statusIndexPathFor(scratch.runtimeRoot, "done-run");
      yield* leaveFile(index);
      const locks = yield* Ref.make<ReadonlyArray<string>>([]);

      yield* gc({ repoRoot: scratch.repoRoot, argv: ["--force"] }).pipe(
        Effect.provide(
          Layer.provideMerge(recordingLock(locks, scratch.runtimeRoot), scratch.layer),
        ),
      );

      expect(yield* fs.exists(index)).toBe(false);
      expect(yield* Ref.get(locks)).toEqual(["acquire done-run", "release done-run index=false"]);
      expect(yield* fs.readDirectory(`${scratch.runtimeRoot}/${LOCKS_DIRNAME}`)).toEqual([]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // Another dispatch took the slug between the listing and the force.
  it.scoped("leaves an index whose slug's lock is held, and skips it loudly", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const scratch = yield* world({ exit: 0, stdout: "" });
      const index = statusIndexPathFor(scratch.runtimeRoot, "held-run");
      yield* leaveFile(index);
      yield* leaveLock(scratch.runtimeRoot, "held-run", process.pid);

      const failures = yield* reclaimAll(scratch.repoRoot, staleScan([]), [
        deadLeftover("index", index, "held-run"),
      ]).pipe(Effect.provide(scratch.layer));

      expect(failures).toBe(0);
      expect(yield* fs.exists(index)).toBe(true);
      const events = yield* Ref.get(scratch.events);
      expect(said(events, "skip held-run — another speepobox run")).toBe(true);
      expect(said(events, "removed index")).toBe(false);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped("exits 1 when a leftover's removal failed, and names its rm -rf", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const scratch = yield* world({ exit: 0, stdout: "" });
      // A claim name on a non-empty directory: a claim is removed
      // non-recursively, so the removal fails.
      const claim = `${lockPathFor(scratch.runtimeRoot, "dead-run")}.${DEAD_PID}.3.claim`;
      yield* leaveFile(`${claim}/inside`);

      const exit = yield* Effect.exit(
        gc({ repoRoot: scratch.repoRoot, argv: ["--force"] }).pipe(Effect.provide(scratch.layer)),
      );

      expect(failureOf(exit)).toContain("gc --force could not remove 1 item");
      expect(yield* fs.exists(claim)).toBe(true);
      const events = yield* Ref.get(scratch.events);
      expect(said(events, `could not remove ${claim}`)).toBe(true);
      expect(said(events, `rm -rf ${claim}`)).toBe(true);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
});

describe("gc's argv", () => {
  it("reads --force, nothing, and refuses anything else with the usage", () => {
    expect(parseGcArgv([])).toEqual(Either.right({ force: false }));
    expect(parseGcArgv(["--force"])).toEqual(Either.right({ force: true }));
    const refused = parseGcArgv(["--bogus"]);
    expect(Either.isLeft(refused)).toBe(true);
    if (Either.isLeft(refused)) {
      expect(refused.left).toBeInstanceOf(GcRefused);
      expect(renderFailure(refused.left)).toEqual(
        Option.some("!! unknown gc flag: --bogus (usage: speepobox gc [--force])"),
      );
    }
    // bash's alias spelling is not carried.
    expect(Either.isLeft(parseGcArgv(["--force", "--gc"]))).toBe(true);
  });
});

describe("the gc renderer", () => {
  const NOW = Date.parse("2026-09-24T12:00:00.000Z");
  const HOUR = 3_600_000;

  const snapshot: GcSnapshot = {
    daemonAnswered: true,
    slugs: [
      {
        slug: "dead-run",
        verdict: { _tag: "Reclaimable" },
        resources: [
          {
            kind: "container",
            modifiedAt: { _tag: "NotApplicable" },
            size: { _tag: "NotApplicable" },
            would: wouldFor({ _tag: "Reclaimable" }, "container"),
          },
          {
            kind: "checkout",
            modifiedAt: { _tag: "Measured", value: NOW - 3 * HOUR },
            size: { _tag: "Measured", value: 5 * 1024 * 1024 },
            would: wouldFor({ _tag: "Reclaimable" }, "checkout"),
          },
          {
            kind: "lock",
            modifiedAt: { _tag: "Unmeasured" },
            size: { _tag: "NotApplicable" },
            would: wouldFor({ _tag: "Reclaimable" }, "lock"),
          },
        ],
      },
      {
        slug: "live-run",
        verdict: { _tag: "Live", detail: "pid 42 still holds its lock" },
        resources: [
          {
            kind: "lock",
            modifiedAt: { _tag: "Measured", value: NOW - 90_000 },
            size: { _tag: "NotApplicable" },
            would: wouldFor({ _tag: "Live", detail: "pid 42 still holds its lock" }, "lock"),
          },
        ],
      },
    ],
    witnesses: [
      {
        path: "/runtime/locks/gone-run.pid.7.evicting",
        slug: "gone-run",
        modifiedAt: { _tag: "Measured", value: NOW - 2 * 24 * HOUR },
      },
    ],
    leftovers: [
      {
        kind: "claim",
        path: "/runtime/locks/gone-run.pid.7.1.claim",
        slug: Option.some("gone-run"),
        modifiedAt: { _tag: "Measured", value: NOW - 5 * HOUR },
        state: "dead",
      },
      {
        kind: "index",
        path: "/runtime/locks/gone-run.index",
        slug: Option.some("gone-run"),
        modifiedAt: { _tag: "Measured", value: NOW - 5 * HOUR },
        state: "dead",
      },
      {
        kind: "editor",
        path: "/runtime/feedback-edit-7-a1b2c3",
        slug: Option.none(),
        modifiedAt: { _tag: "Measured", value: NOW - 24 * HOUR },
        state: "dead",
      },
      {
        kind: "editor",
        path: "/runtime/feedback-edit-a1b2c3",
        slug: Option.none(),
        modifiedAt: { _tag: "Unmeasured" },
        state: "unwitnessed",
      },
    ],
    logs: { count: 1, bytes: { _tag: "Unmeasured" } },
    renderedAt: NOW,
  };

  it("renders the table, the witness, the leftovers, and the logs line", () => {
    expect(renderGc(snapshot).split("\n")).toEqual([
      "What this host holds from speepobox runs",
      "  CLASS      SLUG      AGE  SIZE  WOULD",
      "  container  dead-run  -    -     remove the container",
      "  checkout   dead-run  3h   5.0M  salvage then remove",
      "  lock       dead-run  ?    -     reclaim the lock",
      "  lock       live-run  1m   -     skip — pid 42 still holds its lock",
      "  witness    gone-run  2d   -     sweep",
      "  claim      gone-run  5h   -     remove",
      "  index      gone-run  5h   -     remove",
      "  edit-dir   -         1d   -     remove",
      `  edit-dir   -         ?    -     ${UNWITNESSED_WOULD}`,
      "  logs: 1 run log, ? total — kept (audit trail, gc never deletes logs)",
    ]);
  });

  it("carries the daemon-down warning in the header", () => {
    expect(renderGc({ ...snapshot, daemonAnswered: false }).split("\n")[0]).toBe(
      `What this host holds from speepobox runs  ${DAEMON_DOWN_NOTE}`,
    );
  });

  it("sizes as bash's _human_size does", () => {
    expect(formatSize(0)).toBe("0B");
    expect(formatSize(1023)).toBe("1023B");
    expect(formatSize(1024)).toBe("1.0K");
    expect(formatSize(1536 * 1024)).toBe("1.5M");
    expect(formatSize(3 * 1024 ** 3)).toBe("3.0G");
  });

  it("names the slug a witness is evicting for", () => {
    expect(slugOfWitness("speepobox-t8.pid.4321.evicting")).toBe("speepobox-t8");
    expect(slugOfWitness("odd")).toBe("odd");
  });
});
