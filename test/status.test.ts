import { describe, expect, it } from "@effect/vitest";
import { FileSystem, Path } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { DateTime, Effect, Layer, Option, Ref } from "effect";
import { CAPPED_UNREVIEWED_FIX } from "../src/agent/verdict.ts";
import { lockPathFor } from "../src/dispatch/plan.ts";
import { classify, type LockOnDisk } from "../src/reconcile/wreckage.ts";
import { SpeepoboxConfig, defaultConfig } from "../src/config/config.ts";
import { LEDGER_FILENAME, Ledger, LedgerError, LedgerLive } from "../src/ledger/ledger.ts";
import { CURRENT_SCHEMA_VERSION, type RunRecord } from "../src/ledger/record.ts";
import {
  MANAGED_LABEL,
  ownershipFilterArgs,
  ownershipLabels,
  REPO_LABEL,
  repoScope,
} from "../src/ownership/labels.ts";
import { Reporter, type ReporterEvent } from "../src/reporter.ts";
import { renderStatus } from "../src/status/render.ts";
import type { StatusSnapshot } from "../src/status/snapshot.ts";
import { type ContainerRow, ownerOf, parseContainerRows, status } from "../src/status/status.ts";
import { type ScriptedResult, scriptedExecutor } from "./support/exec-fake.ts";

const REPO_ROOT = "/repos/hae";
const NOW = Date.parse("2026-08-07T22:00:00.000Z");

// Version-1 lines with every absence spelled as null, frozen as text: the
// sparsest rows a version-1 ledger holds, rendered end to end so `status` is
// proved against lines on disk rather than against today's encoder.
const V1_LINES = [
  '{"schemaVersion":1,"runId":null,"branch":"speepobox-t1","identity":{"_tag":"Feature","feature":"issues","issues":[{"issue":"T1","outcome":"approved"}]},"startedAt":null,"endedAt":"2026-08-07T21:07:26.322Z","terminalReason":null,"outcome":null,"base":{"ref":"origin/feature-x","sha":null},"mergeBaseSha":null,"pr":{"number":101,"url":"https://example.test/pull/101"}}',
  '{"schemaVersion":1,"runId":null,"branch":"widget-report","identity":{"_tag":"OneOff","spec":"widget-report.md"},"startedAt":null,"endedAt":"2026-08-07T20:07:26.553Z","terminalReason":null,"outcome":"needs-work","base":{"ref":"origin/master","sha":null},"mergeBaseSha":null,"pr":{"number":102,"url":"https://example.test/pull/102"}}',
];

// A native line as this package wrote them **before T31**, frozen: every key
// the record had then and no `rescuedOnto`. These are the lines already on the
// dispatcher's disk, and a `status` that skipped them would be a worse bug
// than the one the field fixes.
const V1_LINE_WITHOUT_RESCUE =
  '{"schemaVersion":1,"runId":"speepobox-t29-1786000000000","branch":"speepobox-t29","identity":{"_tag":"OneOff","spec":"/repo/tasks/T29.md"},"startedAt":"2026-08-07T21:00:00.000Z","endedAt":"2026-08-07T21:41:00.000Z","terminalReason":{"_tag":"Failed","stage":"land"},"outcome":null,"base":{"ref":"origin/master","sha":"26f4ea47ef"},"mergeBaseSha":"22e7e70e14","pr":null}';

const dockerPsScript = (stdout: string, exit = 0): Record<string, ScriptedResult> => ({
  "docker ps": { exit, stdout },
});

const failingLedger = Layer.succeed(Ledger, {
  append: () => Effect.fail(new LedgerError({ detail: "no" })),
  recent: () => Effect.fail(new LedgerError({ detail: "runs.jsonl: EACCES" })),
  lastBaseForBranch: () => Effect.fail(new LedgerError({ detail: "runs.jsonl: EACCES" })),
  resolveResume: () => Effect.die("status never resumes"),
  newestBranchForIssue: () => Effect.die("status dispatches no feature"),
});

// A Ledger over a throwaway runtime root seeded with `lines`.
const ledgerOver = (runtimeRoot: string) =>
  LedgerLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(SpeepoboxConfig, { ...defaultConfig, runtimeRoot }),
        Layer.succeed(Reporter, { emit: () => Effect.void }),
      ),
    ),
  );

interface RunOptions {
  readonly script?: Record<string, ScriptedResult>;
  readonly ledger: Layer.Layer<Ledger, never, FileSystem.FileSystem | Path.Path>;
  // Where the lock directory is read. Defaults to a path holding nothing, so
  // every listed container reads as one no lock names.
  readonly runtimeRoot?: string;
}

// Runs `status` and hands back everything it emitted plus every argv it ran.
const runStatus = (options: RunOptions) =>
  Effect.gen(function* () {
    const events = yield* Ref.make<ReadonlyArray<ReporterEvent>>([]);
    const commands = yield* Ref.make<ReadonlyArray<string>>([]);
    yield* status({ repoRoot: REPO_ROOT }).pipe(
      Effect.provide(
        Layer.mergeAll(
          options.ledger,
          Layer.succeed(Reporter, {
            emit: (event) => Ref.update(events, (current) => [...current, event]),
          }),
          scriptedExecutor(options.script ?? dockerPsScript(""), commands),
          Layer.succeed(SpeepoboxConfig, {
            ...defaultConfig,
            runtimeRoot: options.runtimeRoot ?? "/nonexistent/speepobox-status-runtime",
          }),
        ),
      ),
    );
    const emitted = yield* Ref.get(events);
    const reported = emitted.find((event) => event._tag === "StatusReported");
    expect(reported).toBeDefined();
    return {
      events: emitted,
      commands: yield* Ref.get(commands),
      snapshot: reported?.snapshot as StatusSnapshot,
    };
  });

describe("ownership labels", () => {
  it("declares ownership with both labels and queries on both", () => {
    expect(ownershipLabels(REPO_ROOT)).toEqual([
      `${MANAGED_LABEL}=true`,
      `${REPO_LABEL}=${repoScope(REPO_ROOT)}`,
    ]);
    expect(ownershipFilterArgs(REPO_ROOT)).toEqual([
      "--filter",
      `label=${MANAGED_LABEL}=true`,
      "--filter",
      `label=${REPO_LABEL}=${repoScope(REPO_ROOT)}`,
    ]);
  });

  it("scopes by repo root: a second repo on the same host gets a different label", () => {
    expect(repoScope(REPO_ROOT)).toBe(repoScope(REPO_ROOT));
    expect(repoScope(REPO_ROOT)).not.toBe(repoScope("/repos/other"));
    expect(repoScope(REPO_ROOT)).toMatch(/^[0-9a-f]{12}$/);
  });

  // Two spellings of one directory are one repo (T60): `--repo-root` hands its
  // value down as given, so a trailing slash or a `..` segment must not scope a
  // dispatch's containers away from the `status` and reconcile queries that go
  // looking for them.
  it("scopes one directory identically however its path is spelled", () => {
    expect(repoScope(`${REPO_ROOT}/`)).toBe(repoScope(REPO_ROOT));
    expect(repoScope("/repos/other/../hae")).toBe(repoScope(REPO_ROOT));
  });
});

describe("the container half", () => {
  it("parses NAME<TAB>STATUS rows without re-checking the name", () => {
    expect(parseContainerRows("speepobox-t2\tUp 3 minutes\nsomething-else\tUp 2 days\n")).toEqual([
      { name: "speepobox-t2", uptime: "Up 3 minutes" },
      // Not dropped: the label filter already decided ownership, and a second
      // name check is the retired prefix sweep wearing a hat.
      { name: "something-else", uptime: "Up 2 days" },
    ]);
    expect(parseContainerRows("\n  \n")).toEqual([]);
  });

  it.scoped("queries by label, never by container name", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const runtimeRoot = yield* fs.makeTempDirectoryScoped();
      const { commands } = yield* runStatus({ ledger: ledgerOver(runtimeRoot) });
      expect(commands.length).toBe(1);
      const argv = commands[0] ?? "";
      expect(argv.startsWith("docker ps ")).toBe(true);
      expect(argv).toContain(`--filter label=${MANAGED_LABEL}=true`);
      expect(argv).toContain(`--filter label=${REPO_LABEL}=${repoScope(REPO_ROOT)}`);
      expect(argv).not.toContain("speepobox-");
    }).pipe(Effect.provide(NodeContext.layer)),
  );
});

describe("status degradations", () => {
  it.scoped("daemon down still renders the ledger half, with a warning, and succeeds", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const runtimeRoot = yield* fs.makeTempDirectoryScoped();
      yield* fs.writeFileString(
        path.join(runtimeRoot, LEDGER_FILENAME),
        `${V1_LINES.join("\n")}\n`,
      );
      const { snapshot } = yield* runStatus({
        script: dockerPsScript("", 1),
        ledger: ledgerOver(runtimeRoot),
      });
      expect(snapshot.containers._tag).toBe("ContainersUnavailable");
      expect(snapshot.ledger._tag).toBe("Runs");
      const screen = renderStatus(snapshot);
      expect(screen).toContain("docker unavailable (daemon down?)");
      expect(screen).toContain("Recent below is unaffected");
      expect(screen).toContain("speepobox-t1");
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  // Every line written before this ticket still renders (T31), end to end
  // through the real file rather than by inspection: the sparsest version-1 lines and a
  // native line from before the rescue field, and no row is skipped.
  it.scoped("renders rows written before the rescue field, with nothing skipped", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const runtimeRoot = yield* fs.makeTempDirectoryScoped();
      yield* fs.writeFileString(
        path.join(runtimeRoot, LEDGER_FILENAME),
        `${[...V1_LINES, V1_LINE_WITHOUT_RESCUE].join("\n")}\n`,
      );
      const { snapshot, events } = yield* runStatus({ ledger: ledgerOver(runtimeRoot) });
      const screen = renderStatus(snapshot);
      expect(screen).toContain("speepobox-t29");
      expect(screen).toContain("❌ failed(land)");
      expect(screen).toContain("speepobox-t1");
      expect(screen).toContain("widget-report");
      expect(events.filter((event) => event._tag === "Warned")).toEqual([]);
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("a missing docker CLI degrades the same way", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const runtimeRoot = yield* fs.makeTempDirectoryScoped();
      const { snapshot } = yield* runStatus({ script: {}, ledger: ledgerOver(runtimeRoot) });
      expect(snapshot.containers).toEqual({
        _tag: "ContainersUnavailable",
        detail: "docker CLI not found",
      });
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.effect("an unreadable ledger still renders the container half", () =>
    Effect.gen(function* () {
      const { snapshot } = yield* runStatus({
        script: dockerPsScript("speepobox-t2\tUp 3 minutes\n"),
        ledger: failingLedger,
      });
      expect(snapshot.ledger._tag).toBe("LedgerUnavailable");
      const screen = renderStatus(snapshot);
      expect(screen).toContain("speepobox-t2");
      expect(screen).toContain("ledger unavailable: runs.jsonl: EACCES");
      expect(screen).toContain("Running above is unaffected");
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("a missing ledger and no containers renders empty and says so", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const runtimeRoot = yield* fs.makeTempDirectoryScoped();
      const { snapshot } = yield* runStatus({ ledger: ledgerOver(runtimeRoot) });
      expect(renderStatus(snapshot)).toBe(
        ["Running", "  no running tasks", "", "Recent (last 10)", "  no runs recorded"].join("\n"),
      );
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.effect("neither half available still renders both explanations", () =>
    Effect.gen(function* () {
      const { snapshot } = yield* runStatus({ script: {}, ledger: failingLedger });
      const screen = renderStatus(snapshot);
      expect(screen).toContain("docker CLI not found");
      expect(screen).toContain("ledger unavailable");
    }).pipe(Effect.provide(NodeContext.layer)),
  );
});

// T138: the Running section names each container's owner, as the reconciler
// would answer for it. Run 5's `kill -9`'d dispatcher left a container that
// read exactly like a live run until the re-dispatch reclaimed it.
describe("the container's owner", () => {
  // As `test/gc.test.ts` uses it: past every kernel's pid_max, so never alive.
  const DEAD_PID = 2147483647;
  const CONTAINER = "speepobox-gate-5";
  const SLUG = "gate-5";

  // Runs `status` over one running container, with `lock` seeded at the
  // slug's lock path (a string is written as the file; `"directory"` puts a
  // directory there instead; absent writes nothing).
  const ownerWith = (lock?: string | { readonly directory: true }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const runtimeRoot = yield* fs.makeTempDirectoryScoped();
      const file = lockPathFor(runtimeRoot, SLUG);
      if (lock !== undefined) {
        yield* fs.makeDirectory(path.dirname(file), { recursive: true });
        yield* typeof lock === "string" ? fs.writeFileString(file, lock) : fs.makeDirectory(file);
      }
      const { snapshot } = yield* runStatus({
        script: dockerPsScript(`${CONTAINER}\tUp 2 hours\n`),
        ledger: ledgerOver(runtimeRoot),
        runtimeRoot,
      });
      return { snapshot, screen: renderStatus(snapshot) };
    });

  it.scoped("a lock naming a live pid renders that pid", () =>
    Effect.gen(function* () {
      const { snapshot, screen } = yield* ownerWith(`${process.pid}\n`);
      expect(snapshot.containers).toEqual({
        _tag: "Containers",
        running: [
          { name: CONTAINER, uptime: "Up 2 hours", owner: { _tag: "OwnedBy", pid: process.pid } },
        ],
      });
      expect(screen).toContain("NAME              UPTIME      OWNER");
      expect(screen).toContain(`${CONTAINER}  Up 2 hours  pid ${process.pid}`);
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("a lock naming a dead pid renders the reclaim", () =>
    Effect.gen(function* () {
      const { screen } = yield* ownerWith(`${DEAD_PID}\n`);
      expect(screen).toContain(`${CONTAINER}  Up 2 hours  dead — next dispatch reclaims`);
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  // An owner nobody can name is not one anybody can prove alive (`liveness.ts`).
  it.scoped("an empty lock renders the reclaim, as classify reads it", () =>
    Effect.gen(function* () {
      const { screen } = yield* ownerWith("");
      expect(screen).toContain("dead — next dispatch reclaims");
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("no lock file renders the report-only value", () =>
    Effect.gen(function* () {
      const { screen } = yield* ownerWith();
      expect(screen).toContain(`${CONTAINER}  Up 2 hours  no lock — reported only`);
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  // `status` never fails: a lock it cannot read is a lock it did not find.
  it.scoped("an unreadable lock path renders the report-only value, and status succeeds", () =>
    Effect.gen(function* () {
      const { screen } = yield* ownerWith({ directory: true });
      expect(screen).toContain("no lock — reported only");
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("with the daemon unavailable no lock is read and the section is as before", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const runtimeRoot = yield* fs.makeTempDirectoryScoped();
      yield* fs.makeDirectory(`${runtimeRoot}/locks`);
      yield* fs.writeFileString(lockPathFor(runtimeRoot, SLUG), `${process.pid}\n`);
      // Any read under the lock directory dies, so a green run is one that
      // asked nothing of it.
      const noLockReads = Layer.succeed(FileSystem.FileSystem, {
        ...fs,
        readFileString: (file, encoding) =>
          file.startsWith(`${runtimeRoot}/locks`)
            ? Effect.die(`status read ${file}`)
            : fs.readFileString(file, encoding),
      });
      const { snapshot } = yield* runStatus({
        script: dockerPsScript("", 1),
        ledger: ledgerOver(runtimeRoot),
        runtimeRoot,
      }).pipe(Effect.provide(noLockReads));
      expect(snapshot.containers).toEqual({
        _tag: "ContainersUnavailable",
        detail: "docker unavailable (daemon down?)",
      });
      expect(renderStatus(snapshot).split("\n").slice(0, 2)).toEqual([
        "Running",
        "  docker unavailable (daemon down?) — Recent below is unaffected",
      ]);
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  // The same facts handed to the reconciler and to `status` get the same
  // answer: a drift between the two is what `liveness.ts` exists to prevent.
  it("agrees with the reconciler's classify on all three cases", () => {
    const container: ContainerRow = { name: CONTAINER, uptime: "Up 2 hours" };
    const lockOf = (owner: Option.Option<number>): Option.Option<LockOnDisk> =>
      Option.some({ path: `/runtime/locks/${SLUG}.pid`, owner });
    const cases: ReadonlyArray<{
      readonly lock: Option.Option<LockOnDisk>;
      readonly verdict: string;
      readonly owner: string;
    }> = [
      { lock: lockOf(Option.some(process.pid)), verdict: "Live", owner: "OwnedBy" },
      { lock: lockOf(Option.some(DEAD_PID)), verdict: "Reclaimable", owner: "OwnerGone" },
      { lock: lockOf(Option.none()), verdict: "Reclaimable", owner: "OwnerGone" },
      { lock: Option.none(), verdict: "Live", owner: "NoLock" },
    ];
    for (const { lock, verdict, owner } of cases) {
      const reconciler = classify({
        slug: SLUG,
        lock,
        sandbox: Option.some({ id: "c0ffee", name: CONTAINER, running: true }),
        checkout: Option.none(),
      });
      expect(reconciler._tag).toBe(verdict);
      expect(ownerOf(container, lock)._tag).toBe(owner);
    }
  });
});

describe("status is read-only", () => {
  it.scoped("makes no writes, runs no git, and changes no docker state", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const runtimeRoot = yield* fs.makeTempDirectoryScoped();
      const file = path.join(runtimeRoot, LEDGER_FILENAME);
      const contents = `${V1_LINES.join("\n")}\n`;
      yield* fs.writeFileString(file, contents);
      const before = yield* fs.stat(file);

      const { commands } = yield* runStatus({
        script: dockerPsScript("speepobox-t2\tUp 3 minutes\n"),
        ledger: ledgerOver(runtimeRoot),
      });

      // Exactly one subprocess, and it is the read-only query.
      expect(commands).toEqual([
        `docker ps ${ownershipFilterArgs(REPO_ROOT).join(" ")} --format {{.Names}}\t{{.Status}}`,
      ]);
      expect(commands.some((argv) => argv.startsWith("git "))).toBe(false);
      for (const mutating of ["rm", "stop", "kill", "start", "run", "create"]) {
        expect(commands.some((argv) => argv.startsWith(`docker ${mutating}`))).toBe(false);
      }

      // The ledger it read is byte-for-byte what it was, at the same mtime.
      expect(yield* fs.readFileString(file)).toBe(contents);
      const after = yield* fs.stat(file);
      expect(after.mtime).toEqual(before.mtime);
      expect(after.size).toEqual(before.size);
      expect(yield* fs.readDirectory(runtimeRoot)).toEqual([LEDGER_FILENAME]);
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("emits its output as a Reporter event, leaving rendering to the subscriber", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const runtimeRoot = yield* fs.makeTempDirectoryScoped();
      const { events } = yield* runStatus({ ledger: ledgerOver(runtimeRoot) });
      expect(events.map((event) => event._tag)).toEqual(["StatusReported"]);
    }).pipe(Effect.provide(NodeContext.layer)),
  );
});

describe("the status renderer", () => {
  const record: RunRecord = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    runId: Option.some("run-1"),
    branch: "speepobox-t2",
    identity: {
      _tag: "Feature",
      feature: "issues",
      issues: [
        { issue: "T1", outcome: "approved" },
        { issue: "T2", outcome: "needs-work" },
      ],
    },
    startedAt: Option.some(DateTime.unsafeMake("2026-08-07T21:00:00.000Z")),
    endedAt: DateTime.unsafeMake("2026-08-07T21:39:00.000Z"),
    terminalReason: Option.some({ _tag: "Completed" }),
    outcome: Option.none(),
    base: { ref: "origin/feature-x", sha: Option.some("26f4ea47ef") },
    mergeBaseSha: Option.some("22e7e70e14"),
    pr: Option.some({ number: Option.some(4470), url: "https://example.test/pull/4470" }),
    rescuedOnto: Option.none(),
    discardedTip: Option.none(),
    dispatcher: Option.none(),
    staleDispatcherOverridden: Option.none(),
    tokensIn: Option.none(),
    tokensOut: Option.none(),
    cacheWrite: Option.none(),
    cacheRead: Option.none(),
    passes: Option.none(),
    models: Option.none(),
  };

  // The running container names no row below it, which is the honest pairing —
  // the two halves answer different questions — and keeps the row lookups in
  // this block unambiguous now that the prefix and this repo's branches are the
  // same word (T65).
  const snapshotOf = (recent: ReadonlyArray<RunRecord>): StatusSnapshot => ({
    containers: {
      _tag: "Containers",
      running: [
        { name: "speepobox-t9", uptime: "Up 3 minutes", owner: { _tag: "OwnedBy", pid: 4242 } },
      ],
    },
    ledger: { _tag: "Runs", recent },
    limit: 10,
    renderedAt: NOW,
  });

  it("renders both halves as aligned tables with no trailing whitespace", () => {
    const screen = renderStatus(snapshotOf([record]));
    expect(screen.split("\n").every((line) => line === line.trimEnd())).toBe(true);
    expect(screen).toContain("speepobox-t9  Up 3 minutes");
    expect(screen).toContain("T1✓ T2✗");
    // Duration is why start joined end in the record.
    expect(screen).toContain("39m");
    expect(screen).toContain("21m ago");
    expect(screen).toContain("https://example.test/pull/4470");
  });

  it("derives a feature run's outcome from its own arm, and reads source off the tag", () => {
    expect(renderStatus(snapshotOf([record]))).toContain("⚠️ 1/2 approved");
    const resumed: RunRecord = {
      ...record,
      identity: {
        _tag: "FeedbackResume",
        resumed: { _tag: "OneOff", spec: "t2.md" },
        resumedRunId: Option.none(),
      },
      outcome: Option.some("approved"),
    };
    const screen = renderStatus(snapshotOf([resumed]));
    expect(screen).toContain("resume:t2.md");
    expect(screen).toContain("✅ approved");
  });

  // The arm with no name to print (T67): a task stated inline has only its
  // text, so the cell says which kind of task it is and carries a summary. The
  // whole text stays on the row and in the run log.
  it("labels a run whose task was stated inline, and keeps the resume prefix", () => {
    const inline: RunRecord = {
      ...record,
      identity: { _tag: "InlineTask", task: "fix the release note" },
      outcome: Option.some("approved"),
    };
    expect(renderStatus(snapshotOf([inline]))).toContain("task: fix the release note");
    // A resume of it keeps its own prefix, exactly as a spec resume does.
    expect(
      renderStatus(
        snapshotOf([
          {
            ...inline,
            identity: {
              _tag: "FeedbackResume",
              resumed: { _tag: "InlineTask", task: "fix the release" },
              resumedRunId: Option.none(),
            },
          },
        ]),
      ),
    ).toContain("resume:task: fix the release");
  });

  // A multi-line task is cut to its first line, and a first line too long for
  // the column is cut with an ellipsis: the cell is one cell wide however much
  // the dispatcher typed.
  it("cuts a long or multi-line inline task down to one line of a column", () => {
    const multiline = renderStatus(
      snapshotOf([
        {
          ...record,
          identity: {
            _tag: "InlineTask",
            task: "fix the release note\n\nthen re-run npm run verify and push",
          },
        },
      ]),
    );
    expect(multiline).toContain("task: fix the release note");
    expect(multiline).not.toContain("re-run npm run verify");

    const line =
      renderStatus(
        snapshotOf([
          {
            ...record,
            identity: { _tag: "InlineTask", task: "f".repeat(200) },
          },
        ]),
      )
        .split("\n")
        .find((row) => row.includes("task: ")) ?? "";
    expect(line).toContain("…");
    expect(line).not.toContain("f".repeat(40));
  });

  // The third token the review loop writes (T10): labelled rather than passed
  // through, because "one commit shipped unreviewed" asks something different
  // of the human than "problems remain" (tasklib.py:801-806). A token this
  // renderer has never heard of still prints verbatim.
  it("labels a capped fixing round, and prints an unknown token as it stands", () => {
    const capped: RunRecord = {
      ...record,
      identity: { _tag: "OneOff", spec: "t10.md" },
      outcome: Option.some(CAPPED_UNREVIEWED_FIX),
    };
    expect(renderStatus(snapshotOf([capped]))).toContain("⚠️ fix unreviewed");
    expect(renderStatus(snapshotOf([{ ...capped, outcome: Option.some("lgtm") }]))).toContain(
      "lgtm",
    );
  });

  it("falls back to the terminal reason when no verdict was reached", () => {
    const crashed: RunRecord = {
      ...record,
      identity: { _tag: "OneOff", spec: "t2.md" },
      terminalReason: Option.some({ _tag: "Crashed" }),
    };
    expect(renderStatus(snapshotOf([crashed]))).toContain("💥 crashed");
    const failed: RunRecord = {
      ...crashed,
      terminalReason: Option.some({ _tag: "Failed", stage: "implement" }),
    };
    expect(renderStatus(snapshotOf([failed]))).toContain("❌ failed(implement)");
  });

  // The tracer (T31): a dispatcher who walked away learns from `status` alone
  // that this run's commits are on a branch of the run's own, without opening
  // the log — and it is on that run's line, beside the stage it failed at.
  it("names where a rescued run's commits are, on that run's own line", () => {
    const rescued: RunRecord = {
      ...record,
      branch: "speepobox-t29",
      identity: { _tag: "OneOff", spec: "t29.md" },
      terminalReason: Option.some({ _tag: "Failed", stage: "land" }),
      pr: Option.none(),
      rescuedOnto: Option.some("speepobox-t29-from-run-a1b2c3d"),
    };
    const line = renderStatus(snapshotOf([rescued]))
      .split("\n")
      .find((row) => row.includes("speepobox-t29"));
    expect(line).toContain("❌ failed(land)");
    expect(line).toContain("speepobox-t29-from-run-a1b2c3d");
    // Whole, never ellipsized: it is a ref the reader is about to type.
    expect(line).not.toContain("…");
  });

  // The ordinary run, which is nearly every run: the commits are on the branch
  // the first column already names, so the cell says nothing rather than
  // repeating it.
  it("leaves the rescue column empty for a run that went home", () => {
    const screen = renderStatus(snapshotOf([record]));
    expect(screen).toContain("RESCUE");
    // The column is there and this row's cell is the same "-" ISSUES and PR
    // print when they have nothing: PR URL, then nothing, then the age.
    expect(screen).toMatch(/https:\/\/example\.test\/pull\/4470\s+-\s+21m ago/);
  });

  it("renders a row with no start without inventing a duration", () => {
    const sparse: RunRecord = {
      ...record,
      runId: Option.none(),
      startedAt: Option.none(),
      terminalReason: Option.none(),
      identity: { _tag: "OneOff", spec: "widget-report.md" },
      outcome: Option.some("needs-work"),
    };
    const screen = renderStatus(snapshotOf([sparse]));
    expect(screen).toContain("⚠️ needs-work");
    // DURATION is "-", never a span back-filled from the end time, and COST
    // is the "-" beside it: a row with no count reads as unmeasured rather than as free
    // (T53).
    expect(screen).toMatch(/needs-work\s+-\s+-\s+https/);
  });

  // T43: every row before this ticket, and any row this ticket's own read
  // could not answer, must read as *unknown* — never as a fabricated clean.
  it("shows a row with no dispatcher as unknown, never as clean", () => {
    const screen = renderStatus(snapshotOf([record]));
    expect(screen).toContain("DISPATCHER");
    expect(screen).toContain("unknown");
  });

  // And a row that does carry one distinguishes a dirty package directory
  // from a clean one, on the same line.
  it("shows the dispatcher's revision, marking a dirty package directory", () => {
    const clean: RunRecord = {
      ...record,
      dispatcher: Option.some({ revision: "6345f52", dirty: false }),
    };
    const dirty: RunRecord = {
      ...record,
      branch: "speepobox-t43",
      dispatcher: Option.some({ revision: "6345f52", dirty: true }),
    };
    const screen = renderStatus(snapshotOf([clean, dirty]));
    const cleanLine = screen.split("\n").find((row) => row.includes("speepobox-t2"));
    const dirtyLine = screen.split("\n").find((row) => row.includes("speepobox-t43"));
    expect(cleanLine).toContain("6345f52");
    expect(cleanLine).not.toContain("6345f52-dirty");
    expect(dirtyLine).toContain("6345f52-dirty");
  });

  // bash's COST column, in bash's own rendering (T53, `tasklib.py:779-795`):
  // the tokens a run burned over the passes that reported them, and "-" for
  // every row that carries no count — which is every row written before this
  // ticket, and every run whose passes were killed before one reported.
  it("renders what a run cost as tokens over passes, and nothing for a row with none", () => {
    const spent: RunRecord = {
      ...record,
      branch: "speepobox-t53",
      tokensIn: Option.some(100_000),
      tokensOut: Option.some(300_000),
      cacheWrite: Option.some(400_000),
      cacheRead: Option.some(600_000),
      passes: Option.some(4),
      models: Option.some(["claude-opus-5"]),
    };
    const cheaper: RunRecord = {
      ...spent,
      branch: "speepobox-t52",
      tokensIn: Option.some(30_000),
      tokensOut: Option.some(100_000),
      cacheWrite: Option.some(50_000),
      cacheRead: Option.some(50_000),
      passes: Option.some(2),
    };
    const screen = renderStatus(snapshotOf([spent, cheaper, record]));
    const lineFor = (branch: string): string | undefined =>
      screen.split("\n").find((row) => row.includes(branch));
    expect(screen).toContain("COST");
    expect(lineFor("speepobox-t53")).toContain("1.4M/4");
    expect(lineFor("speepobox-t52")).toContain("230k/2");
    // The row every dispatcher already has on disk: unmeasured, which is not
    // the same claim as free. DURATION is "39m" on this row, so the "-" being
    // matched here is the cost cell rather than that one.
    expect(lineFor("speepobox-t2")).toMatch(/39m\s+-\s/);
    // And the models are on the row, never on the screen: this is one screen.
    expect(screen).not.toContain("claude-opus-5");
  });

  // The whole reason the four counts stay apart in the record (T53): on a real
  // run the cache reads swamp the rest, so a cell that rendered one component
  // would be off by a factor of fifty. These are the figures a T52 implement
  // pass really reported.
  it("adds all four counts, never one component, on a cache-read-heavy run", () => {
    const warm: RunRecord = {
      ...record,
      tokensIn: Option.some(164),
      tokensOut: Option.some(38_700),
      cacheWrite: Option.some(132_393),
      cacheRead: Option.some(8_067_677),
      passes: Option.some(1),
    };
    const screen = renderStatus(snapshotOf([warm]));
    expect(screen).toContain("8.2M/1");
    // 8.1M is the cache read alone, and 39k is the output alone.
    expect(screen).not.toContain("8.1M");
    expect(screen).not.toContain("39k");
  });
});
