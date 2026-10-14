// The per-run log file (SPEC §4): a second `Reporter` subscriber, opened as a
// plain effect. Every assertion here is about the file on disk — "the
// subscriber emitted" is not "the log holds it".
import { describe, expect, it } from "@effect/vitest";
import { FileSystem, Path } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { DateTime, Duration, Effect, Layer, Option, Ref } from "effect";
import type { PassUsage } from "../src/agent/stream.ts";
import { Reporter, type ReporterEvent } from "../src/reporter.ts";
import { openRunLog, renderElapsed, renderLogLine, renderPassUsage } from "../src/run-log.ts";

// A pass's counts as the fold reads them off a `result` event
// (`test/support/stream-json.ts` scripts the same shape), at the figures T55's
// own worked example uses — so the line asserted here is the line the spec
// names.
const USAGE: PassUsage = {
  input: 18,
  output: 246,
  cacheWrite: 8068,
  cacheRead: 40768,
  turns: 3,
  costUsd: Option.some(0.0214608),
  models: ["claude-haiku-4-5-20251001"],
};

const HEADER = "== speepobox [speepobox-t4] run start";

// The console subscriber, faked: the log is a *second* subscriber, so every
// event must still reach this one.
const consoleEvents = (seen: Ref.Ref<ReadonlyArray<ReporterEvent>>) =>
  Layer.succeed(Reporter, {
    emit: (event) => Ref.update(seen, (current) => [...current, event]),
  });

const open = (logPath: string) =>
  Effect.gen(function* () {
    const seen = yield* Ref.make<ReadonlyArray<ReporterEvent>>([]);
    const reporter = yield* openRunLog(logPath, HEADER).pipe(Effect.provide(consoleEvents(seen)));
    return { reporter, seen };
  });

const logDir = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped();
  return { root, logPath: path.join(root, "logs", "speepobox-t4.log") };
});

describe("the run log", () => {
  it.scoped("writes a header line and appends one line per event", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { logPath } = yield* logDir;
      const { reporter, seen } = yield* open(logPath);
      yield* reporter.emit({ _tag: "Warned", detail: "stale lock reclaimed" });

      const lines = (yield* fs.readFileString(logPath)).split("\n").filter((line) => line !== "");
      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain(HEADER);
      expect(lines[1]).toContain("WARN  stale lock reclaimed");
      // Timestamped, so a run's evidence can be read against wall time.
      expect(lines[1]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      // Still a second subscriber, not a parallel output path.
      expect(yield* Ref.get(seen)).toEqual([{ _tag: "Warned", detail: "stale lock reclaimed" }]);
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped(
    "opens two logs for one branch under one runtime root, and neither touches the other",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped();
        // Two dispatches of the same branch: same slug, different run ids.
        const first = path.join(root, "logs", "speepobox-t4-1700000000000.log");
        const second = path.join(root, "logs", "speepobox-t4-1700000600000.log");

        const { reporter: firstReporter } = yield* open(first);
        yield* firstReporter.emit({ _tag: "Warned", detail: "first run's line" });

        const { reporter: secondReporter } = yield* open(second);
        yield* secondReporter.emit({ _tag: "Warned", detail: "second run's line" });

        const firstContents = yield* fs.readFileString(first);
        const secondContents = yield* fs.readFileString(second);
        expect(firstContents).toContain(HEADER);
        expect(firstContents).toContain("first run's line");
        expect(secondContents).toContain(HEADER);
        expect(secondContents).toContain("second run's line");
        expect(firstContents).not.toContain("second run's line");
        expect(secondContents).not.toContain("first run's line");
      }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("degrades to console-only, loudly, when the log cannot be opened", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root } = yield* logDir;
      // A regular file where the logs directory should be: the log path has a
      // non-directory parent, so nothing can be created under it.
      const blocked = path.join(root, "logs");
      yield* fs.writeFileString(blocked, "");
      const logPath = path.join(blocked, "speepobox-t4.log");

      const { reporter, seen } = yield* open(logPath);
      yield* reporter.emit({ _tag: "Warned", detail: "still running" });
      const emitted = yield* Ref.get(seen);
      expect(emitted[0]?._tag).toBe("Warned");
      expect(emitted[0]).toMatchObject({ detail: expect.stringContaining("run log unavailable") });
      // The run keeps going and the console keeps its stream.
      expect(emitted[1]).toEqual({ _tag: "Warned", detail: "still running" });
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it("renders one timestamped line per event, never a screen", () => {
    const at = DateTime.unsafeMake("2026-08-11T09:30:00.000Z");
    expect(renderLogLine(at, { _tag: "Warned", detail: "degraded" })).toBe(
      "2026-08-11T09:30:00.000Z WARN  degraded",
    );
    const line = renderLogLine(at, {
      _tag: "ProbeChecked",
      probe: "docker",
      status: "ok",
      detail: "daemon reachable",
    });
    expect(line).toContain("probe docker: ok");
    expect(line).not.toContain("\n");
    // The round a reader scans for when the ledger says the review did not
    // approve (T10, `run.sh:1365`).
    expect(
      renderLogLine(at, {
        _tag: "ReviewVerdictReached",
        issue: Option.none(),
        round: { index: 2, of: 3 },
        verdict: "needs-work",
      }),
    ).toBe("2026-08-11T09:30:00.000Z review round 2/3: needs-work");
  });

  // The hard reset's audit line (T101): both discarded tips in full — the
  // local one, and origin's when origin had the branch, which nothing else
  // records.
  it("records both discarded tips of a hard reset in full", () => {
    const at = DateTime.unsafeMake("2026-08-11T09:30:00.000Z");
    const from = "4444444444444444444444444444444444444444";
    const origin = "5555555555555555555555555555555555555555";
    const to = "1111111111111111111111111111111111111111";
    expect(
      renderLogLine(at, {
        _tag: "BranchReset",
        branch: "b",
        from,
        originTip: Option.some(origin),
        to,
        discarding: 4,
      }),
    ).toBe(
      `2026-08-11T09:30:00.000Z hard reset: 'b' moved from ${from} to ${to}; origin/b was at ${origin} — 4 commit(s) discarded`,
    );
    expect(
      renderLogLine(at, {
        _tag: "BranchReset",
        branch: "b",
        from,
        originTip: Option.none(),
        to,
        discarding: 2,
      }),
    ).toBe(
      `2026-08-11T09:30:00.000Z hard reset: 'b' moved from ${from} to ${to} — 2 commit(s) discarded`,
    );
  });

  // The empty hard reset's push (T105): which origin tip it overwrote.
  it("says an empty hard reset pushed, naming origin's old tip", () => {
    const at = DateTime.unsafeMake("2026-08-11T09:30:00.000Z");
    expect(
      renderLogLine(at, {
        _tag: "ResetPushed",
        branch: "b",
        originTip: "5555555555555555555555555555555555555555",
      }),
    ).toBe(
      "2026-08-11T09:30:00.000Z reset pushed: origin/b moved from 5555555555 to the base (nothing new to land)",
    );
  });

  // Which issue a line is about, in front of it (T76, `run.sh:1803, 1847`): a
  // feature run repeats these three lines per issue, and a reader scanning for
  // one issue's stretch finds it by the first column.
  it("opens a feature run's three repeated lines with the issue they are about", () => {
    const at = DateTime.unsafeMake("2026-08-11T09:30:00.000Z");
    expect(
      renderLogLine(at, {
        _tag: "ReviewVerdictReached",
        issue: Option.some("T70"),
        round: { index: 2, of: 3 },
        verdict: "needs-work",
      }),
    ).toBe("2026-08-11T09:30:00.000Z issue T70 review round 2/3: needs-work");
    expect(
      renderLogLine(at, {
        _tag: "AgentPassFinished",
        pass: "implement",
        issue: Option.some("T70"),
        elapsed: Duration.minutes(12),
        usage: USAGE,
      }),
    ).toContain("issue T70 implement pass finished (12m) usage in=");
    expect(
      renderLogLine(at, {
        _tag: "PassFailed",
        pass: "review",
        issue: Option.some("T71"),
        reason: "exited",
        detail: "the review pass ended with an error result",
        elapsed: Duration.minutes(2),
        usage: Option.none(),
      }),
    ).toContain("issue T71 review pass failed (2m): exited —");
  });

  // The two shapes a pass narrates in (ticket 20), under the port's own
  // `agent` label: bash's `|` for prose and `>` for a tool use, one line each
  // and greppable. Which one this is comes off the event's `kind` — no
  // renderer here reads prose to decide what it is looking at.
  it("prints narration as prose or as a tool use, never as one shape", () => {
    const at = DateTime.unsafeMake("2026-08-11T09:30:00.000Z");
    expect(
      renderLogLine(at, {
        _tag: "AgentOutput",
        pass: "implement",
        kind: "text",
        text: "Reading the spec first.",
      }),
    ).toBe("2026-08-11T09:30:00.000Z agent | Reading the spec first.");
    expect(
      renderLogLine(at, {
        _tag: "AgentOutput",
        pass: "review",
        kind: "tool-use",
        tool: "Bash",
        brief: "npm run verify",
      }),
    ).toBe("2026-08-11T09:30:00.000Z agent > Bash: npm run verify");
    // A blank line inside a paragraph the agent wrote is a line all the same:
    // it keeps the prefix and its trailing space, so a block read back out of
    // the log has the shape it was written in.
    expect(
      renderLogLine(at, { _tag: "AgentOutput", pass: "implement", kind: "text", text: "" }),
    ).toBe("2026-08-11T09:30:00.000Z agent | ");
  });

  // The one event that is deliberately a block, and the one line in it a client
  // reads (T14): which root the template came from, said for whichever pass the
  // block belongs to.
  it("opens the verbatim prompt block with the root that won", () => {
    const at = DateTime.unsafeMake("2026-08-11T09:30:00.000Z");
    expect(
      renderLogLine(at, {
        _tag: "PromptAssembled",
        pass: "review",
        prompt: "# ROLE\n\nReview it.",
        root: "client",
        issue: Option.none(),
      }),
    ).toBe(
      "2026-08-11T09:30:00.000Z -- review prompt (client override) --\n# ROLE\n\nReview it.\n-- end prompt --",
    );
    expect(
      renderLogLine(at, {
        _tag: "PromptAssembled",
        pass: "describe-pr",
        prompt: "# ROLE",
        root: "package",
        issue: Option.none(),
      }),
    ).toContain("-- describe-pr prompt (package default) --");
  });

  // And which issue the pass was for, where there is one (T75): a feature
  // run's log holds three prompt blocks per issue, and this is the line a
  // reader greps to find the one they are after. A run with no issue is the
  // line above, unchanged.
  it("names the issue the pass was for, beside the root", () => {
    const at = DateTime.unsafeMake("2026-08-11T09:30:00.000Z");
    expect(
      renderLogLine(at, {
        _tag: "PromptAssembled",
        pass: "implement",
        prompt: "# TASK",
        root: "package",
        issue: Option.some("T70"),
      }),
    ).toBe(
      "2026-08-11T09:30:00.000Z -- implement (issue T70) prompt (package default) --\n# TASK\n-- end prompt --",
    );
  });

  // The heartbeat (T52), bash's `run.sh:1505` line: the elapsed and the cap,
  // both through the same renderer, so the two figures on it are comparable at
  // a glance.
  it("says a long pass is still running, against its cap", () => {
    expect(
      renderLogLine(DateTime.unsafeMake("2026-08-11T09:30:00.000Z"), {
        _tag: "PassStillRunning",
        pass: "implement",
        elapsed: Duration.minutes(2),
        budget: Duration.minutes(30),
      }),
    ).toBe("2026-08-11T09:30:00.000Z ... implement pass still running (2m, cap 30m)");
  });

  // The sizing advisory, as one line: bash says two sentences (`run.sh:1495-
  // 1497`) and the log is a record of single lines, so the second sits beside
  // the first rather than under it. The console is where they read as two.
  it("folds the no-writes warning's two sentences onto one line", () => {
    const line = renderLogLine(DateTime.unsafeMake("2026-08-11T09:30:00.000Z"), {
      _tag: "NoWritesYet",
      pass: "implement",
      elapsed: Duration.minutes(10),
      budget: Duration.minutes(30),
    });
    expect(line).toBe(
      "2026-08-11T09:30:00.000Z WARN  no file written after 10m of a 30m budget — still reading; usually a sizing problem: the ticket is too large, or it points at sources to consult instead of carrying the decisions and code shapes the agent needs",
    );
    expect(line).not.toContain("\n");
  });

  // **The two lines a pass ends on** (T55), and the ticket-20 defect the
  // second one closes: until now a killed run's log stopped mid-narration and
  // never said it was killed, because the failure only ever reached stderr at
  // exit — after this file's bracket had closed.
  it("closes a pass with what it took and what it cost, on one line", () => {
    const at = DateTime.unsafeMake("2026-08-11T09:30:00.000Z");
    const line = renderLogLine(at, {
      _tag: "AgentPassFinished",
      pass: "implement",
      issue: Option.none(),
      elapsed: Duration.minutes(12),
      usage: USAGE,
    });
    expect(line).toBe(
      "2026-08-11T09:30:00.000Z implement pass finished (12m) usage in=18 out=246 cache_write=8068 cache_read=40768 turns=3 cost=0.0215 models=claude-haiku-4-5-20251001",
    );
    expect(line).not.toContain("\n");
    // A rehearsal's pass (T15): the recorded result carries zeros and names no
    // model, and the line says exactly that rather than dropping fields.
    expect(
      renderLogLine(at, {
        _tag: "AgentPassFinished",
        pass: "describe-pr",
        issue: Option.none(),
        elapsed: Duration.zero,
        usage: { ...USAGE, costUsd: Option.none(), models: [] },
      }),
    ).toBe(
      "2026-08-11T09:30:00.000Z describe-pr pass finished (0s) usage in=18 out=246 cache_write=8068 cache_read=40768 turns=3 models=-",
    );
  });

  it("says how a pass failed, with its cost when the CLI reported one", () => {
    const at = DateTime.unsafeMake("2026-08-11T09:30:00.000Z");
    // A kill: no result event ever arrived, so there is no usage to report and
    // none is reported — zeros here would read as a pass that cost nothing.
    const killed = renderLogLine(at, {
      _tag: "PassFailed",
      pass: "implement",
      issue: Option.none(),
      reason: "timed-out",
      detail: "the implement pass timed out at 1800s — read what it committed",
      elapsed: Duration.minutes(30),
      usage: Option.none(),
    });
    expect(killed).toBe(
      "2026-08-11T09:30:00.000Z implement pass failed (30m): timed-out — the implement pass timed out at 1800s — read what it committed",
    );
    expect(killed).not.toContain("usage in=");
    expect(killed).not.toContain("\n");
    // An error result: the pass ran, the CLI said it failed, and what it spent
    // getting there is the expensive failure worth seeing.
    const errored = renderLogLine(at, {
      _tag: "PassFailed",
      pass: "review",
      issue: Option.none(),
      reason: "exited",
      detail: "the review pass ended with an error result: Credit balance is too low",
      elapsed: Duration.seconds(40),
      usage: Option.some(USAGE),
    });
    expect(errored).toBe(
      "2026-08-11T09:30:00.000Z review pass failed (40s) usage in=18 out=246 cache_write=8068 cache_read=40768 turns=3 cost=0.0215 models=claude-haiku-4-5-20251001: exited — the review pass ended with an error result: Credit balance is too low",
    );
    expect(errored).not.toContain("\n");
  });

  // The one failure detail that is not already one line: a lost sandbox
  // carries the child's stderr verbatim (`sandbox/sandbox.ts`'s `failed`), and
  // an agent CLI dying says so over several. It folds here the way a warning's
  // recovery does, because a log line that wraps hides the lines around it —
  // and the stderr the exit renders keeps the error's own string.
  it("folds a failure detail that came with the child's stderr", () => {
    const line = renderLogLine(DateTime.unsafeMake("2026-08-11T09:30:00.000Z"), {
      _tag: "PassFailed",
      pass: "implement",
      issue: Option.none(),
      reason: "sandbox-gone",
      detail:
        "the implement pass lost its sandbox: 'claude -p' exited 1 in the sandbox 'speepobox-t55': Error: connection reset\n    at Socket.onError\n    at emitErrorNT — read /tmp/t55.log",
      elapsed: Duration.minutes(3),
      usage: Option.none(),
    });
    expect(line).not.toContain("\n");
    expect(line).toBe(
      "2026-08-11T09:30:00.000Z implement pass failed (3m): sandbox-gone — the implement pass lost its sandbox: 'claude -p' exited 1 in the sandbox 'speepobox-t55': Error: connection reset at Socket.onError at emitErrorNT — read /tmp/t55.log",
    );
  });

  // The two pure renderers the terminal lines are built from (T55), asserted
  // on their own because T52's round line and T54's console reuse them.
  it("renders an elapsed as whole minutes once there is a minute to say", () => {
    expect(renderElapsed(Duration.seconds(40))).toBe("40s");
    expect(renderElapsed(Duration.minutes(12))).toBe("12m");
    // The two edges either side of the switch, and the zero a rehearsal's
    // pass reports.
    expect(renderElapsed(Duration.seconds(59))).toBe("59s");
    expect(renderElapsed(Duration.seconds(60))).toBe("1m");
    expect(renderElapsed(Duration.zero)).toBe("0s");
  });

  it("renders the usage under the token bash's usage line was", () => {
    expect(renderPassUsage(USAGE)).toBe(
      "usage in=18 out=246 cache_write=8068 cache_read=40768 turns=3 cost=0.0215 models=claude-haiku-4-5-20251001",
    );
    // No cost reported and no model named: the field goes, and the models
    // field says `-` rather than trailing off into nothing.
    expect(renderPassUsage({ ...USAGE, costUsd: Option.none(), models: [] })).toBe(
      "usage in=18 out=246 cache_write=8068 cache_read=40768 turns=3 models=-",
    );
    // More than one model on one pass is one field, comma-joined.
    expect(
      renderPassUsage({ ...USAGE, models: ["claude-opus-5", "claude-haiku-4-5-20251001"] }),
    ).toContain("models=claude-opus-5,claude-haiku-4-5-20251001");
  });
});
