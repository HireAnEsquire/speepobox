import { describe, expect, it } from "@effect/vitest";
import { FileSystem, Path } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { DateTime, Effect, Either, Layer, Option, Ref, Schema } from "effect";
import { BessemerConfig, defaultConfig } from "../src/config/config.ts";
import {
  LEDGER_FILENAME,
  Ledger,
  LedgerLive,
  RESUME_BRANCH_HINT_LIMIT,
} from "../src/ledger/ledger.ts";
import {
  CURRENT_SCHEMA_VERSION,
  dispatchIdentity,
  type RunIdentity,
  RunRecord,
} from "../src/ledger/record.ts";
import { Reporter } from "../src/reporter.ts";

// Frozen version-1 lines with every absence spelled as null — no run id, no
// start, no terminal reason, no merge-base — which a version-1 line may do and
// which is why `RunRecord`'s optional fields stay optional (T135). Frozen as
// text rather than encoded from the schema, for `V1_LINE_WITHOUT_RESCUE`'s
// reason below.
const V1_LINES = [
  '{"schemaVersion":1,"runId":null,"branch":"bessemer-t1","identity":{"_tag":"Feature","feature":"issues","issues":[{"issue":"T1","outcome":"approved"}]},"startedAt":null,"endedAt":"2026-08-07T21:07:26.322Z","terminalReason":null,"outcome":null,"base":{"ref":"origin/feature-x","sha":null},"mergeBaseSha":null,"pr":{"number":101,"url":"https://example.test/pull/101"}}',
  '{"schemaVersion":1,"runId":null,"branch":"widget-report","identity":{"_tag":"OneOff","spec":"widget-report.md"},"startedAt":null,"endedAt":"2026-08-07T21:07:26.553Z","terminalReason":null,"outcome":"needs-work","base":{"ref":"origin/master","sha":null},"mergeBaseSha":null,"pr":{"number":102,"url":"https://example.test/pull/102"}}',
  '{"schemaVersion":1,"runId":null,"branch":"widget-report","identity":{"_tag":"OneOff","spec":"widget-report.md"},"startedAt":null,"endedAt":"2026-08-07T21:07:26.806Z","terminalReason":null,"outcome":"approved","base":{"ref":"origin/master","sha":null},"mergeBaseSha":null,"pr":{"number":102,"url":"https://example.test/pull/102"}}',
];

// The line T135 stopped reading: a bash-agentbox line, which carries no
// `schemaVersion` and so is not a bessemer record.
const BASH_LINE =
  '{"timestamp": "2026-08-07T21:07:26.322108+00:00", "branch": "bessemer-t1", "base": "origin/feature-x", "spec": null, "feature": "issues", "issues": {"T1": "approved"}, "outcome": null, "pr_url": "https://example.test/pull/101", "task_dir": "docs/wayfinder/effect-agentbox/issues"}';

const nativeRecord: RunRecord = {
  schemaVersion: CURRENT_SCHEMA_VERSION,
  runId: Option.some("01JZ0000000000000000000000"),
  branch: "bessemer-t2",
  identity: {
    _tag: "FeedbackResume",
    resumed: {
      _tag: "Feature",
      feature: "issues",
      issues: [
        { issue: "T1", outcome: "approved" },
        { issue: "T2", outcome: "needs-work" },
      ],
    },
    resumedRunId: Option.some("01JYZZZZZZZZZZZZZZZZZZZZZZ"),
  },
  startedAt: Option.some(DateTime.unsafeMake("2026-08-07T20:00:00.000Z")),
  endedAt: DateTime.unsafeMake("2026-08-07T20:39:00.000Z"),
  terminalReason: Option.some({ _tag: "Failed", stage: "implement" }),
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

// A native line as this package wrote them **before T31**: schema version 1,
// every key the record had then, and no `rescuedOnto`. Frozen as text rather
// than re-encoded from the schema, because the thing under test is a file the
// dispatcher already has — a fixture built by today's encoder would carry
// today's keys and assert nothing.
const V1_LINE_WITHOUT_RESCUE =
  '{"schemaVersion":1,"runId":"bessemer-t29-1786000000000","branch":"bessemer-t29","identity":{"_tag":"OneOff","spec":"/repo/tasks/T29.md"},"startedAt":"2026-08-13T20:00:00.000Z","endedAt":"2026-08-13T20:41:00.000Z","terminalReason":{"_tag":"Failed","stage":"land"},"outcome":null,"base":{"ref":"origin/master","sha":"26f4ea47ef"},"mergeBaseSha":"22e7e70e14","pr":null}';

// A Ledger over a throwaway runtime root, plus the warnings it emitted. Config
// arrives as Layer.succeed over an object literal, which is cheaper than
// building provider maps (SPEC §6).
const ledgerLayer = (runtimeRoot: string, warnings: Ref.Ref<ReadonlyArray<string>>) =>
  LedgerLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(BessemerConfig, { ...defaultConfig, runtimeRoot }),
        Layer.succeed(Reporter, {
          emit: (event) =>
            event._tag === "Warned"
              ? Ref.update(warnings, (current) => [...current, event.detail])
              : Effect.void,
        }),
      ),
    ),
  );

const openLedger = (contents?: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const runtimeRoot = yield* fs.makeTempDirectoryScoped();
    const file = path.join(runtimeRoot, LEDGER_FILENAME);
    if (contents !== undefined) {
      yield* fs.writeFileString(file, contents);
    }
    const warnings = yield* Ref.make<ReadonlyArray<string>>([]);
    const ledger = yield* Ledger.pipe(Effect.provide(ledgerLayer(runtimeRoot, warnings)));
    return { ledger, warnings, runtimeRoot, file };
  });

describe("the record", () => {
  it.effect("round-trips: encode then decode yields the original", () =>
    Effect.gen(function* () {
      const encoded = yield* Schema.encode(RunRecord)(nativeRecord);
      // The encoded form is plain JSON — a jsonl line, nothing self-describing
      // beyond schemaVersion.
      expect(JSON.parse(JSON.stringify(encoded))).toEqual(encoded);
      const decoded = yield* Schema.decode(RunRecord)(encoded);
      expect(decoded).toEqual(nativeRecord);
    }),
  );

  it.effect("round-trips an absence-heavy one-off with every optional empty", () =>
    Effect.gen(function* () {
      const sparse: RunRecord = {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        runId: Option.none(),
        branch: "lonely",
        identity: { _tag: "OneOff", spec: "lonely.md" },
        startedAt: Option.none(),
        endedAt: DateTime.unsafeMake("2026-01-01T00:00:00.000Z"),
        terminalReason: Option.none(),
        outcome: Option.none(),
        base: { ref: "origin/master", sha: Option.none() },
        mergeBaseSha: Option.none(),
        pr: Option.none(),
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
      const encoded = yield* Schema.encode(RunRecord)(sparse);
      expect(encoded.runId).toBeNull();
      expect(encoded.startedAt).toBeNull();
      // The one absence spelled as a missing key rather than a null (T31):
      // every line written before that ticket has it missing, so that is the
      // shape the decode has to read as `Option.none` — and the shape the
      // encode has to write back, or a rescue-less run would say "rescued
      // onto nothing" in a key no earlier line has. `dispatcher` follows the
      // identical rule (T43), and `staleDispatcherOverridden` follows it too
      // (T44): an ordinary run that never overrides the check must not say so
      // in a key no earlier line has either.
      expect("rescuedOnto" in encoded).toBe(false);
      expect("dispatcher" in encoded).toBe(false);
      expect("staleDispatcherOverridden" in encoded).toBe(false);
      // A run that reset nothing names no discarded tip (T104): no key, not a
      // null and not an empty string.
      expect("discardedTip" in encoded).toBe(false);
      // And the six (T53), on the same rule and for one reason of their own:
      // a run with no usage-bearing event is unmeasured, and a zero written
      // into any of these keys would price it as free.
      for (const key of ["tokensIn", "tokensOut", "cacheWrite", "cacheRead", "passes", "models"]) {
        expect(key in encoded).toBe(false);
      }
      expect(JSON.parse(JSON.stringify(encoded))).toEqual(encoded);
      expect(yield* Schema.decode(RunRecord)(encoded)).toEqual(sparse);
    }),
  );

  // The line already on the dispatcher's disk (T31, T43, T44 and T53 alike —
  // this line predates all four fields). A `status` that skipped every row
  // written before a field existed would be a worse bug than the one the
  // field fixes, so the absence is asserted against frozen text rather than
  // an encoder that would only ever produce today's shape.
  it.effect(
    "decodes a version-1 line written before the rescue, dispatcher, override and cost fields existed",
    () =>
      Effect.gen(function* () {
        const decoded = yield* Schema.decodeUnknown(RunRecord)(JSON.parse(V1_LINE_WITHOUT_RESCUE));
        expect(decoded.rescuedOnto).toEqual(Option.none());
        expect(decoded.discardedTip).toEqual(Option.none());
        expect(decoded.dispatcher).toEqual(Option.none());
        expect(decoded.staleDispatcherOverridden).toEqual(Option.none());
        expect(decoded.tokensIn).toEqual(Option.none());
        expect(decoded.tokensOut).toEqual(Option.none());
        expect(decoded.cacheWrite).toEqual(Option.none());
        expect(decoded.cacheRead).toEqual(Option.none());
        expect(decoded.passes).toEqual(Option.none());
        expect(decoded.models).toEqual(Option.none());
        expect(decoded.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
        expect(decoded.branch).toBe("bessemer-t29");
        expect(decoded.terminalReason).toEqual(Option.some({ _tag: "Failed", stage: "land" }));
      }),
  );

  // And the rescue itself round-trips as the branch's own name — never the
  // branch the run was given, and never an empty string standing in for "no
  // rescue" (T31).
  it.effect("round-trips a rescued run's branch", () =>
    Effect.gen(function* () {
      const rescued: RunRecord = {
        ...nativeRecord,
        rescuedOnto: Option.some("bessemer-t29-from-run-a1b2c3d"),
      };
      const encoded = yield* Schema.encode(RunRecord)(rescued);
      expect(encoded.rescuedOnto).toBe("bessemer-t29-from-run-a1b2c3d");
      expect(yield* Schema.decode(RunRecord)(encoded)).toEqual(rescued);
    }),
  );

  // The tip a `--hard-reset` discarded round-trips as the full SHA (T104, D6).
  it.effect("round-trips a reset run's discarded tip", () =>
    Effect.gen(function* () {
      const tip = "7777777777777777777777777777777777777777";
      const reset: RunRecord = { ...nativeRecord, discardedTip: Option.some(tip) };
      const encoded = yield* Schema.encode(RunRecord)(reset);
      expect(encoded.discardedTip).toBe(tip);
      expect(yield* Schema.decode(RunRecord)(encoded)).toEqual(reset);
    }),
  );

  // The dispatcher round-trips as a struct, not as a decorated string (T43):
  // two fields on the wire, never `"6345f52-dirty"` for a renderer to parse
  // back apart.
  it.effect("round-trips the dispatcher that ran, dirty package directory and all", () =>
    Effect.gen(function* () {
      const dirty: RunRecord = {
        ...nativeRecord,
        dispatcher: Option.some({ revision: "6345f52", dirty: true }),
      };
      const encoded = yield* Schema.encode(RunRecord)(dirty);
      expect(encoded.dispatcher).toEqual({ revision: "6345f52", dirty: true });
      expect(yield* Schema.decode(RunRecord)(encoded)).toEqual(dirty);
    }),
  );

  // The override round-trips as `true` on the one row it was needed for
  // (T44); every other row — including this one before the flag was passed —
  // carries no such key at all, which is the absence asserted above.
  it.effect("round-trips a run that overrode the stale-dispatcher refusal", () =>
    Effect.gen(function* () {
      const overridden: RunRecord = {
        ...nativeRecord,
        staleDispatcherOverridden: Option.some(true),
      };
      const encoded = yield* Schema.encode(RunRecord)(overridden);
      expect(encoded.staleDispatcherOverridden).toBe(true);
      expect(yield* Schema.decode(RunRecord)(encoded)).toEqual(overridden);
    }),
  );

  // What the run cost (T53), and the whole point of the shape: the four
  // counts are four fields, so a row that re-read a warm cache is still
  // distinguishable from one that generated the same number of output tokens.
  // `models` is a list because one run — and one pass — can touch several.
  it.effect("round-trips the four token counts, the passes, and the models beside them", () =>
    Effect.gen(function* () {
      const spent: RunRecord = {
        ...nativeRecord,
        tokensIn: Option.some(164),
        tokensOut: Option.some(38700),
        cacheWrite: Option.some(132393),
        cacheRead: Option.some(8067677),
        passes: Option.some(4),
        models: Option.some(["claude-haiku-4-5-20251001", "claude-opus-5"]),
      };
      const encoded = yield* Schema.encode(RunRecord)(spent);
      expect(encoded.tokensIn).toBe(164);
      expect(encoded.tokensOut).toBe(38700);
      expect(encoded.cacheWrite).toBe(132393);
      expect(encoded.cacheRead).toBe(8067677);
      expect(encoded.passes).toBe(4);
      expect(encoded.models).toEqual(["claude-haiku-4-5-20251001", "claude-opus-5"]);
      // Four fields on the wire and no fifth holding their sum: a total is a
      // render-time answer, and one written here could never be taken apart.
      expect("tokens" in encoded).toBe(false);
      expect(yield* Schema.decode(RunRecord)(encoded)).toEqual(spent);
      // And the version does not move for a key every earlier line lacks
      // (T31), so `status` still reads every row on the dispatcher's disk.
      expect(encoded.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    }),
  );

  it("carries schemaVersion, identity, timing, SHAs and the PR number beside the URL", () => {
    expect(nativeRecord.schemaVersion).toBe(1);
    expect(Option.isSome(nativeRecord.runId)).toBe(true);
    expect(Option.isSome(nativeRecord.startedAt)).toBe(true);
    expect(Option.isSome(nativeRecord.terminalReason)).toBe(true);
    expect(Option.isSome(nativeRecord.base.sha)).toBe(true);
    expect(Option.isSome(nativeRecord.mergeBaseSha)).toBe(true);
    expect(Option.map(nativeRecord.pr, (pr) => pr.number)).toEqual(Option.some(Option.some(4470)));
  });

  // Shape pins (AGENTS.md, design rule 2): each asserts something stays
  // impossible. A red pin means the tagged union grew a nullable pair back.
  it("pins mode recovery to the tag: there is no nullable pair to null-check", () => {
    const identity: RunIdentity = { _tag: "OneOff", spec: "t2.md" };
    // @ts-expect-error — `feature` exists only on the feature arm, so no code
    // can recover the mode by asking which field is null
    expect(identity.feature).toBeUndefined();
    expect(dispatchIdentity(identity)._tag).toBe("OneOff");
  });

  // The arm T67 added: the text verbatim on the row, which is what a
  // `--resume` replays. It round-trips both bare and under the
  // `FeedbackResume` that wraps it, because a resume of an inline task is the
  // second of those and nothing else would reach it.
  it.effect("round-trips the task a dispatch stated inline, bare and resumed", () =>
    Effect.gen(function* () {
      const text = 'fix the `$(uname)` note; keep "quotes" literal';
      const inline: RunRecord = {
        ...nativeRecord,
        identity: { _tag: "InlineTask", task: text },
      };
      const encoded = yield* Schema.encode(RunRecord)(inline);
      expect(encoded.identity).toEqual({ _tag: "InlineTask", task: text });
      expect(yield* Schema.decode(RunRecord)(encoded)).toEqual(inline);

      const resumed: RunRecord = {
        ...nativeRecord,
        identity: {
          _tag: "FeedbackResume",
          resumed: { _tag: "InlineTask", task: text },
          resumedRunId: Option.some("bessemer-t67-1786000000000"),
        },
      };
      expect(yield* Schema.decode(RunRecord)(yield* Schema.encode(RunRecord)(resumed))).toEqual(
        resumed,
      );
      // And the dispatch arm is read off the tag, as every other one is.
      expect(dispatchIdentity(resumed.identity)).toEqual({ _tag: "InlineTask", task: text });
    }),
  );

  // T31's rule, applied to a union growing an arm (T67): every version-1 line
  // on disk still decodes as itself, because no existing line's shape changed.
  // Bumping the number would drop every one of them — `Schema.Literal` admits
  // exactly two — to buy a third literal nothing branches on.
  it.effect("does not move the version for a union that grew an arm", () =>
    Effect.gen(function* () {
      expect(CURRENT_SCHEMA_VERSION).toBe(1);
      const inline = yield* Schema.encode(RunRecord)({
        ...nativeRecord,
        identity: { _tag: "InlineTask", task: "fix the release note" },
      });
      expect(inline.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
      // The line already on the dispatcher's disk still reads as itself.
      const older = yield* Schema.decodeUnknown(RunRecord)(JSON.parse(V1_LINE_WITHOUT_RESCUE));
      expect(older.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
      expect(older.identity).toEqual({ _tag: "OneOff", spec: "/repo/tasks/T29.md" });
    }),
  );

  it("pins the inline arm to the text, not to a spec path standing in for one", () => {
    const identity: RunIdentity = { _tag: "InlineTask", task: "fix the release note" };
    // @ts-expect-error — `spec` exists only on the one-off arm, so no code can
    // read a file path off a run that was never dispatched for a file
    expect(identity.spec).toBeUndefined();
  });

  it("pins per-issue outcomes to the feature arm alone", () => {
    const oneOff = { _tag: "OneOff", spec: "t2.md" } as const;
    // @ts-expect-error — a one-off run has no issues to carry
    expect(oneOff.issues).toBeUndefined();
    const resumed = dispatchIdentity(nativeRecord.identity);
    expect(resumed._tag === "Feature" && resumed.issues.length).toBe(2);
  });
});

describe("ledger queries", () => {
  it.scoped("reads version-1 lines newest first, for status", () =>
    Effect.gen(function* () {
      const { ledger, warnings } = yield* openLedger(`${V1_LINES.join("\n")}\n`);
      const recent = yield* ledger.recent(10);
      expect(recent.map((record) => record.branch)).toEqual([
        "widget-report",
        "widget-report",
        "bessemer-t1",
      ]);
      expect(recent[0]?.outcome).toEqual(Option.some("approved"));
      expect(yield* Ref.get(warnings)).toEqual([]);
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  // End to end through the real file: a ledger holding version-1 lines and a
  // native line from before the rescue field reads back whole, and nothing is
  // reported as skipped (T31).
  it.scoped("reads a native line written before the rescue field, without skipping it", () =>
    Effect.gen(function* () {
      const { ledger, warnings } = yield* openLedger(
        `${[...V1_LINES, V1_LINE_WITHOUT_RESCUE].join("\n")}\n`,
      );
      const recent = yield* ledger.recent(10);
      expect(recent.map((record) => record.branch)).toEqual([
        "bessemer-t29",
        "widget-report",
        "widget-report",
        "bessemer-t1",
      ]);
      expect(recent[0]?.rescuedOnto).toEqual(Option.none());
      expect(yield* Ref.get(warnings)).toEqual([]);
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("honours the limit", () =>
    Effect.gen(function* () {
      const { ledger } = yield* openLedger(`${V1_LINES.join("\n")}\n`);
      expect((yield* ledger.recent(2)).length).toBe(2);
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("a missing ledger reads as no runs, not as a failure", () =>
    Effect.gen(function* () {
      const { ledger } = yield* openLedger();
      expect(yield* ledger.recent(10)).toEqual([]);
      expect(yield* ledger.lastBaseForBranch("anything")).toEqual(Option.none());
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  // T135: a line with no `schemaVersion` takes the same path as any other
  // undecodable line — bash's rows included — and says why in its warning,
  // while the version-1 lines on either side of it still decode.
  it.scoped("a line with no schemaVersion is skipped by line, between lines that decode", () =>
    Effect.gen(function* () {
      const { ledger, warnings } = yield* openLedger(
        `${[V1_LINES[1] ?? "", BASH_LINE, V1_LINES[2] ?? ""].join("\n")}\n`,
      );
      const recent = yield* ledger.recent(10);
      expect(recent.map((record) => record.outcome)).toEqual([
        Option.some("approved"),
        Option.some("needs-work"),
      ]);
      expect(yield* Ref.get(warnings)).toEqual([
        expect.stringMatching(/runs\.jsonl:2 skipped — no schemaVersion — not a bessemer record$/),
      ]);
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("an undecodable line is skipped with a warning; the readable ones survive", () =>
    Effect.gen(function* () {
      const { ledger, warnings } = yield* openLedger(
        [
          "{not json at all",
          '{"timestamp": "2026-08-07T21:07:26Z", "branch": "modeless", "base": "origin/master", "spec": null, "feature": null}',
          '{"schemaVersion": 9, "branch": "from-the-future"}',
          "",
          V1_LINES[0] ?? "",
        ].join("\n"),
      );
      const recent = yield* ledger.recent(10);
      expect(recent.map((record) => record.branch)).toEqual(["bessemer-t1"]);
      const emitted = yield* Ref.get(warnings);
      expect(emitted.length).toBe(3);
      expect(emitted[0]).toContain(":1 skipped");
      expect(emitted[1]).toContain(":2 skipped — no schemaVersion");
      expect(emitted[2]).toContain(":3 skipped");
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  // The warning lands on `status`, which SPEC §7 says is one screen. A
  // ParseError's own message prints the whole expected type — the record's
  // union renders at ~1500 characters — so a skipped line would bury the
  // history it degrades. Pinned as a size, because a schema that grows makes
  // the default message grow with it.
  it.scoped("says why a line was skipped in one short line, never a schema dump", () =>
    Effect.gen(function* () {
      const { ledger, warnings } = yield* openLedger(
        [
          '{"schemaVersion": 1, "branch": "no-identity"}',
          '{"schemaVersion": 1, "runId": null, "branch": "b", "identity": {"_tag": "OneOff", "spec": "s.md"}, "startedAt": null, "endedAt": "not-a-date"}',
        ].join("\n"),
      );
      expect(yield* ledger.recent(10)).toEqual([]);
      const emitted = yield* Ref.get(warnings);
      expect(emitted.length).toBe(2);
      for (const warning of emitted) {
        expect(warning).not.toContain("\n");
        expect(warning.length).toBeLessThan(200);
      }
      expect(emitted[0]).toContain("runId: is missing");
      expect(emitted[1]).toContain("endedAt:");
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("last recorded base for a branch is the newest row's", () =>
    Effect.gen(function* () {
      const { ledger } = yield* openLedger(`${V1_LINES.join("\n")}\n`);
      // The version-1 lines only, so far.
      expect(yield* ledger.lastBaseForBranch("bessemer-t1")).toEqual(
        Option.some("origin/feature-x"),
      );
      expect(yield* ledger.lastBaseForBranch("widget-report")).toEqual(
        Option.some("origin/master"),
      );
      expect(yield* ledger.lastBaseForBranch("never-dispatched")).toEqual(Option.none());
      // A row appended after them wins for its branch.
      yield* ledger.append({ ...nativeRecord, branch: "widget-report" });
      expect(yield* ledger.lastBaseForBranch("widget-report")).toEqual(
        Option.some("origin/feature-x"),
      );
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  // --- resume recovery (T16) -------------------------------------------------

  it.scoped("recovers the identity and the base from the newest record for a branch", () =>
    Effect.gen(function* () {
      const { ledger } = yield* openLedger(`${V1_LINES.join("\n")}\n`);
      const resolved = yield* ledger.resolveResume({
        _tag: "Branch",
        branch: "widget-report",
      });
      expect(resolved._tag).toBe("Resumable");
      if (resolved._tag !== "Resumable") {
        return;
      }
      expect(resolved.branch).toBe("widget-report");
      // Mode off the tag, never off which of two fields is null. A bare
      // spec name is what the resume resolves under the tasks dir exactly as
      // a typed one would be.
      expect(resolved.identity).toEqual({ _tag: "OneOff", spec: "widget-report.md" });
      expect(resolved.base).toEqual(Option.some("origin/master"));
      // A line that recorded no run id resumes with none, rather than a
      // synthesized one.
      expect(resolved.resumedRunId).toEqual(Option.none());
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("carries the resumed run's id forward when it had one", () =>
    Effect.gen(function* () {
      const { ledger } = yield* openLedger();
      yield* ledger.append({
        ...nativeRecord,
        branch: "bessemer-t16",
        runId: Option.some("bessemer-t16-1786000000000"),
        identity: { _tag: "OneOff", spec: "/repo/tasks/T16.md" },
      });
      const resolved = yield* ledger.resolveResume({ _tag: "Branch", branch: "bessemer-t16" });
      expect(resolved._tag === "Resumable" && resolved.resumedRunId).toEqual(
        Option.some("bessemer-t16-1786000000000"),
      );
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  // The whole point of T2's wrapping arm: a resume's own row carries the
  // dispatch identity forward, so resuming a resumed run recovers the
  // original one-off rather than a chain of wrappers.
  it.scoped("composes: resuming a resumed run recovers the original dispatch identity", () =>
    Effect.gen(function* () {
      const { ledger } = yield* openLedger();
      const original: RunIdentity = { _tag: "OneOff", spec: "/repo/tasks/T16.md" };
      yield* ledger.append({ ...nativeRecord, branch: "twice", identity: original });
      const once: RunIdentity = {
        _tag: "FeedbackResume",
        resumed: dispatchIdentity(original),
        resumedRunId: Option.some("twice-1"),
      };
      yield* ledger.append({
        ...nativeRecord,
        branch: "twice",
        identity: once,
        runId: Option.some("twice-2"),
      });
      const resolved = yield* ledger.resolveResume({ _tag: "Branch", branch: "twice" });
      expect(resolved._tag === "Resumable" && resolved.identity).toEqual({
        _tag: "OneOff",
        spec: "/repo/tasks/T16.md",
      });
      expect(resolved._tag === "Resumable" && resolved.resumedRunId).toEqual(
        Option.some("twice-2"),
      );
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  // `--last` is the same query with a different target, not a second read
  // path: the newest record of any branch, with no outcome filter — resuming
  // a run that failed is the primary reason to type it.
  it.scoped("--last takes the newest record of any branch, whatever it decided", () =>
    Effect.gen(function* () {
      const { ledger } = yield* openLedger(`${V1_LINES.join("\n")}\n`);
      const resolved = yield* ledger.resolveResume({ _tag: "Last" });
      expect(resolved._tag === "Resumable" && resolved.branch).toBe("widget-report");
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("a branch with no record resolves to NoRecord naming the branches it knows", () =>
    Effect.gen(function* () {
      const { ledger } = yield* openLedger(`${V1_LINES.join("\n")}\n`);
      const resolved = yield* ledger.resolveResume({ _tag: "Branch", branch: "never-dispatched" });
      expect(resolved).toEqual({
        _tag: "NoRecord",
        knownBranches: ["widget-report", "bessemer-t1"],
      });
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("an empty ledger resolves --last to NoRecord with nothing to name", () =>
    Effect.gen(function* () {
      const { ledger } = yield* openLedger();
      expect(yield* ledger.resolveResume({ _tag: "Last" })).toEqual({
        _tag: "NoRecord",
        knownBranches: [],
      });
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("names at most the eight most recent branches, newest first", () =>
    Effect.gen(function* () {
      const { ledger } = yield* openLedger();
      for (let index = 0; index < RESUME_BRANCH_HINT_LIMIT + 2; index += 1) {
        yield* ledger.append({ ...nativeRecord, branch: `branch-${index}` });
      }
      const resolved = yield* ledger.resolveResume({ _tag: "Branch", branch: "absent" });
      expect(resolved._tag === "NoRecord" && resolved.knownBranches).toEqual([
        "branch-9",
        "branch-8",
        "branch-7",
        "branch-6",
        "branch-5",
        "branch-4",
        "branch-3",
        "branch-2",
      ]);
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  // Every degradation short of "no record at all" is data on the resolved
  // value (bash's `task_dir_exists=False`): a record that names no base
  // resumes onto the `--base` default chain rather than failing the resume.
  it.scoped("a record with no base ref resolves with the base absent, not as a failure", () =>
    Effect.gen(function* () {
      const { ledger } = yield* openLedger();
      yield* ledger.append({
        ...nativeRecord,
        branch: "baseless",
        base: { ref: "", sha: Option.none() },
      });
      const resolved = yield* ledger.resolveResume({ _tag: "Branch", branch: "baseless" });
      expect(resolved._tag === "Resumable" && resolved.base).toEqual(Option.none());
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("append then read round-trips a record through the real file", () =>
    Effect.gen(function* () {
      const { ledger, warnings, file } = yield* openLedger();
      yield* ledger.append(nativeRecord);
      const fs = yield* FileSystem.FileSystem;
      const written = yield* fs.readFileString(file);
      expect(written.endsWith("\n")).toBe(true);
      expect(written.split("\n").filter((line) => line !== "").length).toBe(1);
      const recent = yield* ledger.recent(10);
      expect(recent).toEqual([nativeRecord]);
      expect(yield* Ref.get(warnings)).toEqual([]);
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("a ledger we cannot even stat reads as unavailable, never as no runs", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      // A regular file where the runtime root should be, so the ledger path
      // has a non-directory parent: stat fails with something that is not
      // "missing". No chmod, so this cannot pass vacuously as root.
      const parent = yield* fs.makeTempDirectoryScoped();
      const runtimeRoot = path.join(parent, "not-a-directory");
      yield* fs.writeFileString(runtimeRoot, "");
      const warnings = yield* Ref.make<ReadonlyArray<string>>([]);
      const ledger = yield* Ledger.pipe(Effect.provide(ledgerLayer(runtimeRoot, warnings)));
      const outcome = yield* Effect.either(ledger.recent(10));
      expect(Either.isLeft(outcome)).toBe(true);
      if (Either.isLeft(outcome)) {
        expect(outcome.left._tag).toBe("LedgerError");
      }
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("an unreadable ledger is a typed LedgerError, not a defect", () =>
    Effect.gen(function* () {
      const { ledger, runtimeRoot } = yield* openLedger();
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      // A directory where the file should be: readable path, unreadable file.
      yield* fs.makeDirectory(path.join(runtimeRoot, LEDGER_FILENAME));
      const outcome = yield* Effect.either(ledger.recent(10));
      expect(Either.isLeft(outcome)).toBe(true);
      if (Either.isLeft(outcome)) {
        expect(outcome.left._tag).toBe("LedgerError");
      }
    }).pipe(Effect.provide(NodeContext.layer)),
  );
});

// --- the in-progress-elsewhere hint (T74) ------------------------------------

// The second witness for "someone else already has this issue", and the one
// that is a **hint**: the ledger is per-machine derived state, so what this
// query answers is whether a run would be *wasted*, never whether it would be
// wrong (15). The refusal built off it lives in `guards.ts`; what is asserted
// here is which row it reads and which rows it passes over.
describe("the newest branch an issue was worked on", () => {
  // A terminal row for a feature run, spelled as the arm the query matches on:
  // the folder repo-relative, the ids as the run was dispatched with them.
  const featureRow = (fields: {
    readonly branch: string;
    readonly feature: string;
    readonly issues: ReadonlyArray<string>;
    readonly outcome?: string;
    readonly endedAt: string;
  }): RunRecord => ({
    ...nativeRecord,
    branch: fields.branch,
    identity: {
      _tag: "Feature",
      feature: fields.feature,
      issues: fields.issues.map((issue) => ({ issue, outcome: "needs-work" })),
    },
    endedAt: DateTime.unsafeMake(fields.endedAt),
    outcome: Option.fromNullable(fields.outcome),
  });

  it.scoped("answers the newest row for the folder that names the id", () =>
    Effect.gen(function* () {
      const { ledger } = yield* openLedger();
      yield* ledger.append(
        featureRow({
          branch: "bessemer-t28-first",
          feature: "docs/queue",
          issues: ["T28"],
          outcome: "approved",
          endedAt: "2026-08-17T09:00:00.000Z",
        }),
      );
      yield* ledger.append(
        featureRow({
          branch: "bessemer-t28",
          feature: "docs/queue",
          issues: ["T27", "T28"],
          outcome: "needs-work",
          endedAt: "2026-08-18T16:04:00.000Z",
        }),
      );
      expect(yield* ledger.newestBranchForIssue({ feature: "docs/queue", issue: "T28" })).toEqual(
        Option.some({
          branch: "bessemer-t28",
          endedAt: DateTime.unsafeMake("2026-08-18T16:04:00.000Z"),
          outcome: Option.some("needs-work"),
        }),
      );
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  // The same tag read mode recovery makes (SPEC §10): a resumed feature run's
  // row wraps the `Feature` it replayed, and the work it did is the wrapped
  // identity's — so a resume is not a row this query goes blind on.
  it.scoped("reads a FeedbackResume through the identity it wrapped", () =>
    Effect.gen(function* () {
      const { ledger } = yield* openLedger();
      const worked = featureRow({
        branch: "bessemer-t2",
        feature: "issues",
        issues: ["T1", "T2"],
        endedAt: "2026-08-07T20:39:00.000Z",
      });
      // `nativeRecord`'s own identity is exactly this wrapper, so the row
      // appended here is the fixture the rest of this file already uses.
      yield* ledger.append({ ...worked, identity: nativeRecord.identity });
      expect(yield* ledger.newestBranchForIssue({ feature: "issues", issue: "T2" })).toEqual(
        Option.some({
          branch: "bessemer-t2",
          endedAt: DateTime.unsafeMake("2026-08-07T20:39:00.000Z"),
          outcome: Option.none(),
        }),
      );
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  // Two queues each holding a `T1` are two issues, and the folder is the whole
  // of what tells them apart.
  it.scoped("passes over a row for the same id under another folder", () =>
    Effect.gen(function* () {
      const { ledger } = yield* openLedger();
      yield* ledger.append(
        featureRow({
          branch: "somebody-elses",
          feature: "docs/other-queue",
          issues: ["T28"],
          endedAt: "2026-08-18T16:04:00.000Z",
        }),
      );
      expect(yield* ledger.newestBranchForIssue({ feature: "docs/queue", issue: "T28" })).toEqual(
        Option.none(),
      );
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  // And a row for the right folder that worked on other issues, plus the
  // one-off rows beside it: neither is this issue's last run.
  it.scoped("passes over rows that name another id and rows on another arm", () =>
    Effect.gen(function* () {
      const { ledger } = yield* openLedger();
      yield* ledger.append(
        featureRow({
          branch: "bessemer-t27",
          feature: "docs/queue",
          issues: ["T27"],
          endedAt: "2026-08-18T16:04:00.000Z",
        }),
      );
      yield* ledger.append({ ...nativeRecord, identity: { _tag: "OneOff", spec: "T28.md" } });
      expect(yield* ledger.newestBranchForIssue({ feature: "docs/queue", issue: "T28" })).toEqual(
        Option.none(),
      );
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  // A row holds the id as the run was dispatched with it, so the match is
  // T68's rule and not string equality: `37`, `t37` and `T37` are one issue
  // here as they are at every other reader.
  it.scoped("matches the recorded id the way every other reader does", () =>
    Effect.gen(function* () {
      const { ledger } = yield* openLedger();
      yield* ledger.append(
        featureRow({
          branch: "bessemer-t37",
          feature: "docs/queue",
          issues: ["37"],
          endedAt: "2026-08-18T16:04:00.000Z",
        }),
      );
      const found = yield* ledger.newestBranchForIssue({ feature: "docs/queue", issue: "T37" });
      expect(Option.map(found, (work) => work.branch)).toEqual(Option.some("bessemer-t37"));
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  // The query reads the record as it is — no schema change, no new field — so
  // every line already on a dispatcher's disk answers it, the sparsest
  // version-1 lines included.
  it.scoped("answers off a version-1 line that recorded no verdict", () =>
    Effect.gen(function* () {
      const { ledger, warnings } = yield* openLedger(`${V1_LINES.join("\n")}\n`);
      expect(yield* ledger.newestBranchForIssue({ feature: "issues", issue: "T1" })).toEqual(
        Option.some({
          branch: "bessemer-t1",
          endedAt: DateTime.unsafeMake("2026-08-07T21:07:26.322Z"),
          // A run that recorded no verdict is still where the issue was last
          // worked on, so the absence travels rather than a stand-in.
          outcome: Option.none(),
        }),
      );
      expect(yield* Ref.get(warnings)).toEqual([]);
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("a missing ledger is no record, not a failure", () =>
    Effect.gen(function* () {
      const { ledger } = yield* openLedger();
      expect(yield* ledger.newestBranchForIssue({ feature: "docs/queue", issue: "T28" })).toEqual(
        Option.none(),
      );
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  // Derived state degrades the caller and never fails a run (SPEC §10), which
  // is what makes this check a hint T74's guard waives on: the error is typed,
  // so the caller can warn and proceed.
  it.scoped("an unreadable ledger is a typed LedgerError here too", () =>
    Effect.gen(function* () {
      const { ledger, runtimeRoot } = yield* openLedger();
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.makeDirectory(path.join(runtimeRoot, LEDGER_FILENAME));
      const outcome = yield* Effect.either(
        ledger.newestBranchForIssue({ feature: "docs/queue", issue: "T28" }),
      );
      expect(Either.isLeft(outcome) && outcome.left._tag).toBe("LedgerError");
    }).pipe(Effect.provide(NodeContext.layer)),
  );
});
