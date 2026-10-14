// The `Ledger` tag (SPEC §3): the durable outcome record at `runs.jsonl`
// under the runtime root (T57 — the served repo's speepobox directory, unless a
// `runtime-root` moved the writes), gitignored and per-machine.
//
// Ledger content is derived state (SPEC §10): a missing file, an unreadable
// one, or a line the record schema cannot decode degrades the caller and never
// fails a run. That is why a read failure is a typed `LedgerError` the caller
// degrades on — the outcome-row test in AGENTS.md — and never a defect.
import { FileSystem, Path } from "@effect/platform";
import { Context, Data, DateTime, Effect, Either, Layer, Option, Schema } from "effect";
import { SpeepoboxConfig } from "../config/config.ts";
import { namesId } from "../issues/issue.ts";
import { Reporter } from "../reporter.ts";
import { type DispatchIdentity, dispatchIdentity, formatParseError, RunRecord } from "./record.ts";

export const LEDGER_FILENAME = "runs.jsonl";

// How many branches a refused `--resume` names back (`tasklib.py:449`). The
// hint is the whole of what "which branch did I call it, again" needs.
export const RESUME_BRANCH_HINT_LIMIT = 8;

export class LedgerError extends Data.TaggedError("LedgerError")<{
  readonly detail: string;
}> {}

// What a re-dispatch names: a branch, or "whatever ran last" — `--last` is
// sugar on `--resume` (SPEC §7), so it is a second *target*, never a second
// query and never a second code path.
export type ResumeTarget =
  | { readonly _tag: "Branch"; readonly branch: string }
  | { readonly _tag: "Last" };

// What a dispatch needs to repeat a run, read off the newest record naming it.
//
// The identity is the **dispatch** arm — `dispatchIdentity()` has already
// unwrapped any `FeedbackResume`, which is what makes repeated resumes
// compose: a resume's own row carries the original identity forward rather
// than re-deriving it, and mode recovery stays a tag read (SPEC §10).
//
// Everything a record can be short of is data here rather than a failure
// (`task_dir_exists=False` in bash, `tasklib.py:525-576`): a run that predates
// run ids resumes with `resumedRunId` absent, and a record with no base ref
// resumes onto the `--base` default chain. Only "this branch has no ledger
// record at all" is the caller's refusal, and it arrives as `NoRecord` with
// the branches this ledger does know about.
export type ResumeResolution =
  | {
      readonly _tag: "Resumable";
      // The branch the record names — recovered rather than given, which is
      // the whole of `--last`.
      readonly branch: string;
      readonly identity: DispatchIdentity;
      // The run being resumed, absent when it predates run ids. Never
      // synthesized: the resuming row records exactly this.
      readonly resumedRunId: Option.Option<string>;
      // The recorded base *ref*, absent when the record carried none — a SHA
      // would pin the resumed run to a stale commit.
      readonly base: Option.Option<string>;
    }
  | { readonly _tag: "NoRecord"; readonly knownBranches: ReadonlyArray<string> };

// Where an issue was last worked on, off the newest row that names it (T74).
// Three fields because the refusal quotes all three — the branch to dispatch
// it on, and what happened there and when, which is how a dispatcher tells a
// run they remember from one they do not.
//
// The outcome is the record's, absent and all: a run that crashed before a
// verdict has a row and no outcome, and it is still where the issue was last
// worked on.
export interface LastWorkedOn {
  readonly branch: string;
  readonly endedAt: DateTime.Utc;
  readonly outcome: Option.Option<string>;
}

export interface LedgerShape {
  // One terminal row per run. SPEC §11: a row exists iff `RunLock` was
  // acquired — the lock arrives in T4, so nothing calls this yet.
  readonly append: (record: RunRecord) => Effect.Effect<void, LedgerError>;
  // Newest first, for `status`.
  readonly recent: (limit: number) => Effect.Effect<ReadonlyArray<RunRecord>, LedgerError>;
  // The `--base` default chain's first link (`ledger-last-base` in bash),
  // consumed by `dispatch` (T3).
  readonly lastBaseForBranch: (branch: string) => Effect.Effect<Option.Option<string>, LedgerError>;
  // What `--resume` and `--last` re-dispatch from (T16): the newest record for
  // the target, read back as the identity and the base a run needs to repeat.
  readonly resolveResume: (target: ResumeTarget) => Effect.Effect<ResumeResolution, LedgerError>;
  // The second of T74's two witnesses, and a sibling of `lastBaseForBranch`:
  // the newest row whose **dispatch identity** is a `Feature` for this folder
  // and whose issues name this id — so a `FeedbackResume` answers through what
  // it wrapped, exactly as mode recovery does (SPEC §10).
  //
  // It answers whether a run would be *wasted*, never whether it would be
  // wrong (15): the ledger is per-machine derived state, so a `Some` is a
  // **hint** the caller refuses on and a `LedgerError` is one the caller
  // warns about and proceeds past. The folder is matched as the row recorded
  // it — repo-relative, the way every message carries it (14, lesson 9) — and
  // the id by T68's rule, since a row holds the id as it was dispatched.
  readonly newestBranchForIssue: (request: {
    readonly feature: string;
    readonly issue: string;
  }) => Effect.Effect<Option.Option<LastWorkedOn>, LedgerError>;
}

export class Ledger extends Context.Tag("Ledger")<Ledger, LedgerShape>() {}

// A line is a speepobox record when it says so. One with no `schemaVersion`
// is skipped like any other undecodable line: the bash adapter that once read
// those was retired with the side-by-side comparison it served (T135).
const decodeLine = (line: string): Either.Either<RunRecord, string> => {
  const parsed = Either.try({
    try: () => JSON.parse(line) as unknown,
    catch: (error) => `not JSON — ${String(error)}`,
  });
  if (Either.isLeft(parsed)) {
    return Either.left(parsed.left);
  }
  const value = parsed.right;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return Either.left("not a JSON object");
  }
  if (!("schemaVersion" in value)) {
    return Either.left("no schemaVersion — not a speepobox record");
  }
  return Schema.decodeUnknownEither(RunRecord)(value).pipe(
    Either.mapLeft((error) => `undecodable record — ${formatParseError(error)}`),
  );
};

// The newest record the target names, in file order — the same
// file-order-is-recency-order convention `lastBaseForBranch` reads by
// (`tasklib.py:441-446`). `--last` takes the newest record of any branch,
// with no outcome filter: resuming a run that failed is the primary reason to
// type it.
const newestFor = (
  records: ReadonlyArray<RunRecord>,
  target: ResumeTarget,
): RunRecord | undefined => {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record === undefined) {
      continue;
    }
    if (target._tag === "Last" || record.branch === target.branch) {
      return record;
    }
  }
  return undefined;
};

// The refusal's hint: the most recently active branches, newest first and
// deduped (`tasklib.py:449-459`) — "which branch did I call it" is the
// question a dispatcher who mistyped `--resume` actually has.
const recentBranches = (records: ReadonlyArray<RunRecord>): ReadonlyArray<string> => {
  const seen: Array<string> = [];
  for (
    let index = records.length - 1;
    index >= 0 && seen.length < RESUME_BRANCH_HINT_LIMIT;
    index -= 1
  ) {
    const branch = records[index]?.branch;
    if (branch !== undefined && branch !== "" && !seen.includes(branch)) {
      seen.push(branch);
    }
  }
  return seen;
};

// The newest row that worked on this issue of this folder, read backwards
// through the same file-order-is-recency-order convention `newestFor` above
// reads by. `dispatchIdentity()` again, and for its reason: a resumed feature
// run's row carries a `FeedbackResume` wrapping the `Feature` it replayed, and
// the work it did is the wrapped identity's.
//
// A row for the same id under a *different* folder is not a hit: two queues
// each holding a `T1` are two issues, and the folder is what tells them apart.
const newestWorkOn = (
  records: ReadonlyArray<RunRecord>,
  feature: string,
  issue: string,
): Option.Option<LastWorkedOn> => {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record === undefined) {
      continue;
    }
    const identity = dispatchIdentity(record.identity);
    if (identity._tag !== "Feature" || identity.feature !== feature) {
      continue;
    }
    // The row's ids are what the run was dispatched with, so `37` and `T37`
    // are one issue here as they are everywhere else (T68).
    if (!identity.issues.some((outcome) => namesId(outcome.issue, issue))) {
      continue;
    }
    return Option.some({
      branch: record.branch,
      endedAt: record.endedAt,
      outcome: record.outcome,
    });
  }
  return Option.none();
};

// Mode recovery is a tag read, and it is `dispatchIdentity()` that reads it:
// a record whose identity is a `FeedbackResume` hands back the dispatch it
// wrapped, so resuming a resumed run recovers the original one-off rather
// than a chain of wrappers.
const resumeFrom = (records: ReadonlyArray<RunRecord>, target: ResumeTarget): ResumeResolution => {
  const record = newestFor(records, target);
  if (record === undefined) {
    return { _tag: "NoRecord", knownBranches: recentBranches(records) };
  }
  return {
    _tag: "Resumable",
    branch: record.branch,
    identity: dispatchIdentity(record.identity),
    resumedRunId: record.runId,
    // An empty ref is a record that recorded no base — the same emptiness
    // `lastBaseForBranch` skips over. It degrades the resumed run onto the
    // `--base` default chain rather than failing it.
    base: record.base.ref === "" ? Option.none() : Option.some(record.base.ref),
  };
};

export const LedgerLive: Layer.Layer<
  Ledger,
  never,
  SpeepoboxConfig | Reporter | FileSystem.FileSystem | Path.Path
> = Layer.effect(
  Ledger,
  Effect.gen(function* () {
    const config = yield* SpeepoboxConfig;
    const reporter = yield* Reporter;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    // Resolved once at layer build; nothing is opened until a query runs
    // (05 Q21 — services acquire lazily inside their own constructors).
    const file = path.join(config.runtimeRoot, LEDGER_FILENAME);

    // Every decodable record, in file order — which is recency order, the
    // same convention bash relies on.
    const readAll: Effect.Effect<ReadonlyArray<RunRecord>, LedgerError> = Effect.gen(function* () {
      // Absent and unreadable are different answers, and only the first one is
      // "no runs": `exists` already returns false for a genuinely missing file,
      // so anything it *fails* with (an untraversable parent, a permission
      // denial) is a ledger we could not read. Swallowing it to false renders
      // "no runs recorded" over a history that is really still there —
      // fabricated absence, which is the one thing this file may not do.
      const exists = yield* fs
        .exists(file)
        .pipe(Effect.mapError((error) => new LedgerError({ detail: `${file}: ${error.message}` })));
      if (!exists) {
        return [];
      }
      const text = yield* fs
        .readFileString(file)
        .pipe(Effect.mapError((error) => new LedgerError({ detail: `${file}: ${error.message}` })));
      const records: Array<RunRecord> = [];
      const lines = text.split("\n");
      for (let index = 0; index < lines.length; index += 1) {
        const line = (lines[index] ?? "").trim();
        if (line === "") {
          continue;
        }
        const decoded = decodeLine(line);
        if (Either.isLeft(decoded)) {
          yield* reporter.emit({
            _tag: "Warned",
            detail: `${file}:${index + 1} skipped — ${decoded.left}`,
          });
          continue;
        }
        records.push(decoded.right);
      }
      return records;
    });

    return {
      append: (record) =>
        Schema.encode(RunRecord)(record).pipe(
          Effect.mapError((error) => new LedgerError({ detail: formatParseError(error) })),
          Effect.flatMap((encoded) =>
            fs
              .writeFileString(file, `${JSON.stringify(encoded)}\n`, { flag: "a" })
              .pipe(
                Effect.mapError(
                  (error) => new LedgerError({ detail: `${file}: ${error.message}` }),
                ),
              ),
          ),
        ),

      recent: (limit) =>
        readAll.pipe(
          Effect.map((records) =>
            records
              .toSorted(
                (left, right) =>
                  DateTime.toEpochMillis(right.endedAt) - DateTime.toEpochMillis(left.endedAt),
              )
              .slice(0, limit),
          ),
        ),

      lastBaseForBranch: (branch) =>
        readAll.pipe(
          Effect.map((records) => {
            for (let index = records.length - 1; index >= 0; index -= 1) {
              const record = records[index];
              if (record === undefined || record.branch !== branch || record.base.ref === "") {
                continue;
              }
              return Option.some(record.base.ref);
            }
            return Option.none();
          }),
        ),

      resolveResume: (target) => readAll.pipe(Effect.map((records) => resumeFrom(records, target))),

      newestBranchForIssue: ({ feature, issue }) =>
        readAll.pipe(Effect.map((records) => newestWorkOn(records, feature, issue))),
    };
  }),
);
