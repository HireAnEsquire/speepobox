// The greenfield ledger record (SPEC §10, 05 Q18R). Today's bash schema is
// replaced rather than extended, because three of its flaws are structural:
// `spec`/`feature` is a nullable pair encoding a mode, `issues`-vs-`outcome`
// repeats that discriminant unenforced, and nothing records identity or
// timing.
//
// Every field is derivable from the `Reporter` event stream (05): a dispatch
// knows its own id, when it started and stopped, why it stopped, which SHAs it
// resolved, and which PR it opened. Nothing here depends on state no event
// carries, so promoting events to source-of-truth later is additive rather
// than a rewrite.
import { ParseResult, Schema } from "effect";

// A decode failure that reaches a reader is one warning line, not a schema
// dump. `ParseError.message` prints the whole expected type — on this record
// that is ~1500 characters of union, and it lands on `status`, the one screen
// SPEC §7 says is a screen. ArrayFormatter gives the path and the reason,
// which is the whole of what "why was this line skipped" needs.
export const formatParseError = (error: ParseResult.ParseError): string =>
  ParseResult.ArrayFormatter.formatErrorSync(error)
    .map((issue) =>
      issue.path.length === 0 ? issue.message : `${issue.path.join(".")}: ${issue.message}`,
    )
    .join("; ");

// The version stamped on every record this package writes. A line carrying
// none is not a speepobox record, and the reader skips it (T135).
//
// **A field every reader can be absent stays on this version** (T31).
// Bumping it for an addition every version-1 line already satisfies would
// either drop every line on the dispatcher's disk — `Schema.Literal` below
// admits exactly this one — or buy a second literal that no code branches on.
// A version goes up when a line written under the old number can no longer be
// read as itself, which is not what adding an absent-by-default key does.
//
// **Nor is growing a union an arm** (T67). Every version-1 line on disk still
// decodes as itself, because no existing line's shape changed — a third
// `DispatchIdentity` arm is a value none of them holds. What the unchanged
// number does *not* buy is the other direction: a row carrying the new arm
// fails to decode under a speepobox older than that ticket. That bites exactly
// one case — rolling the tool back over a ledger it has since written to — and
// it is named here so nobody reads this constant as a promise about older
// readers.
export const CURRENT_SCHEMA_VERSION = 1;

export const IssueOutcome = Schema.Struct({
  // The issue's own identifier as dispatched ("T1", "3"), never an index.
  issue: Schema.String,
  // Bash writes approved / needs-work / capped-unreviewed-fix / blocked-hitl /
  // implement-failed / review-failed / not-attempted (run.sh's issue loop —
  // cited by name rather than by line, because this list grows and a stale
  // range is worse than none) and its own renderer passes an unrecognized
  // token through verbatim. Modelled as an open string for the same reason:
  // dropping a real row because a token grew is worse than rendering one we do
  // not recognize. `review-failed` is the newest, added when a 529 mid-review
  // was found to abort the run outright instead of landing what it had.
  outcome: Schema.String,
});
export type IssueOutcome = Schema.Schema.Type<typeof IssueOutcome>;

// --- run identity: a tagged union, not a nullable pair ----------------------

export const OneOff = Schema.TaggedStruct("OneOff", {
  // The spec's identity as dispatched: a bare name or a path.
  spec: Schema.String,
});

export const Feature = Schema.TaggedStruct("Feature", {
  feature: Schema.String,
  // Per-issue outcomes belong to this arm alone. On the old schema every
  // record had room for them, which is what made `issues`-vs-`outcome` a
  // second, unenforced copy of the mode discriminant.
  issues: Schema.Array(IssueOutcome),
});

// The task the dispatcher stated on the command line rather than in a file
// (T67, 22 §4), carried **verbatim** so `--resume` replays it: a spec's
// identity is a name the resume re-resolves against disk, and this arm's is
// the whole of what the run was for. Not `OneOff { spec: "" }`, which is the
// nullable pair T2 deleted, and not a pointer into the run log — the log may
// be moved or pruned, and replay is the row's job.
//
// The field is `task` rather than `text`: it is the task, and the arm's name
// says where it was stated.
export const InlineTask = Schema.TaggedStruct("InlineTask", {
  task: Schema.String,
});

// The three arms a dispatch can start from. A feedback-resume wraps one of them
// rather than repeating its fields, so mode recovery is always a tag read.
export const DispatchIdentity = Schema.Union(OneOff, Feature, InlineTask);
export type DispatchIdentity = Schema.Schema.Type<typeof DispatchIdentity>;

export const FeedbackResume = Schema.TaggedStruct("FeedbackResume", {
  resumed: DispatchIdentity,
  // The run this one resumed. Absent when the resumed row recorded no run id,
  // never synthesized.
  resumedRunId: Schema.OptionFromNullOr(Schema.String),
});

export const RunIdentity = Schema.Union(OneOff, Feature, InlineTask, FeedbackResume);
export type RunIdentity = Schema.Schema.Type<typeof RunIdentity>;

// The dispatch arm underneath a run identity — the resumed one for a
// feedback-resume, the identity itself otherwise. Callers that want the
// spec/feature name go through here instead of null-checking a pair.
export const dispatchIdentity = (identity: RunIdentity): DispatchIdentity =>
  identity._tag === "FeedbackResume" ? identity.resumed : identity;

// --- why the run ended, distinct from what it decided -----------------------

// The stages of the failure-point matrix (SPEC §11).
export const RunStage = Schema.Literal(
  "checkout",
  "sandbox",
  "setup",
  "implement",
  "review",
  "land",
  "pr",
);
export type RunStage = Schema.Schema.Type<typeof RunStage>;

// Terminal reason answers "why did it stop"; `outcome` answers "what did the
// review decide". A crashed run has the first and not the second.
export const TerminalReason = Schema.Union(
  Schema.TaggedStruct("Completed", {}),
  Schema.TaggedStruct("Failed", { stage: RunStage }),
  Schema.TaggedStruct("Crashed", {}),
  Schema.TaggedStruct("Interrupted", {}),
);
export type TerminalReason = Schema.Schema.Type<typeof TerminalReason>;

// --- the record -------------------------------------------------------------

export const BaseRef = Schema.Struct({
  // The `--base` value as given (`origin/master`). This is what the
  // last-recorded-base query hands back to the default chain — a SHA there
  // would pin the next run to a stale commit.
  ref: Schema.String,
  // What that ref resolved to for this run.
  sha: Schema.OptionFromNullOr(Schema.String),
});
export type BaseRef = Schema.Schema.Type<typeof BaseRef>;

export const PullRequest = Schema.Struct({
  // Stored beside the URL so no call site parses it back out. Absent only
  // when the URL did not carry a recoverable number.
  number: Schema.OptionFromNullOr(Schema.Int),
  url: Schema.String,
});
export type PullRequest = Schema.Schema.Type<typeof PullRequest>;

// Which revision of the dispatcher wrote this row, and whether its package
// directory was dirty when it did (T43). A struct rather than a decorated
// string like `6345f52-dirty` that a renderer would have to parse back apart
// — `PullRequest` above sets the precedent and states the reason.
export const Dispatcher = Schema.Struct({
  revision: Schema.String,
  dirty: Schema.Boolean,
});
export type Dispatcher = Schema.Schema.Type<typeof Dispatcher>;

export const RunRecord = Schema.Struct({
  schemaVersion: Schema.Literal(CURRENT_SCHEMA_VERSION),
  // Absent where a version-1 line encoded it as null.
  runId: Schema.OptionFromNullOr(Schema.String),
  branch: Schema.String,
  identity: RunIdentity,
  // Both ends, because "why did that run take 40 minutes" is unanswerable on
  // the bash schema. A version-1 line may still carry only the end.
  startedAt: Schema.OptionFromNullOr(Schema.DateTimeUtc),
  endedAt: Schema.DateTimeUtc,
  terminalReason: Schema.OptionFromNullOr(TerminalReason),
  // The review verdict, when the run reached one.
  outcome: Schema.OptionFromNullOr(Schema.String),
  base: BaseRef,
  mergeBaseSha: Schema.OptionFromNullOr(Schema.String),
  pr: Schema.OptionFromNullOr(PullRequest),
  // Where this run's commits ended up when they could not go onto the branch
  // the run was given — T29's rescue, which is the one outcome in the whole
  // matrix where the work survived and is not where anybody was told to look
  // for it. Absent on a run that went home, and absent on a run whose commits
  // are still in a kept checkout: a directory is not a branch, and the loud
  // warning is the whole of what that case says.
  //
  // **An absent key, not a nullable one** (T31). `OptionFromNullOr` wants the
  // key present and null, and every version-1 line already on a dispatcher's
  // disk carries no such key at all — those lines are the history `status`
  // exists to show, so the spelling has to decode their absence as
  // `Option.none`. `nullable` is accepted on the way in as well, since a
  // hand-assembled line may spell an absence as null, and `none` encodes back
  // to no key rather than to a null or an empty string.
  rescuedOnto: Schema.optionalWith(Schema.String, {
    as: "Option",
    nullable: true,
    exact: true,
  }),
  // The full SHA the branch stood at before a `--hard-reset` run moved it to
  // the base (T104, D6) — present exactly when the reset happened, and absent
  // on every run that did not reset, including one whose compare-and-set
  // failed. Apart from the reflog, which is per-clone and expires, this is the
  // only durable pointer to the work a reset threw away, and the row is what
  // `status` and a later dispatcher read. Origin's discarded tip is not a
  // second field: `BranchReset` puts it in the run log. The absent-key spelling
  // of `rescuedOnto`, for its reason.
  discardedTip: Schema.optionalWith(Schema.String, {
    as: "Option",
    nullable: true,
    exact: true,
  }),
  // Which dispatcher wrote this row (T43) — absent on every row written
  // before this ticket, and `status` renders that as *unknown*, never as
  // clean. The same absent-key spelling as `rescuedOnto`, and for the
  // identical reason: every version-1 line already on a dispatcher's disk
  // carries no such key at all.
  dispatcher: Schema.optionalWith(Dispatcher, {
    as: "Option",
    nullable: true,
    exact: true,
  }),
  // Whether `--allow-stale-dispatcher` was needed to make this run go
  // (T44) — absent on every row where the preflight's freshness check
  // either passed or was never overridden, which is every row written
  // before this ticket as well as the ordinary run after it. The same
  // absent-key spelling as `rescuedOnto` and `dispatcher`, for the same
  // reason: no version-1 line carries this key, and a run that never
  // overrides the check must not either.
  staleDispatcherOverridden: Schema.optionalWith(Schema.Boolean, {
    as: "Option",
    nullable: true,
    exact: true,
  }),
  // What the run cost (T53): bash's `tokens`, `passes` and `models`
  // (`run.sh:2188-2210`, `tasklib.py:694`), which the port had dropped —
  // each count summed over every pass that reported usage, derived from
  // `AgentPassFinished` and `PassFailed` rather than re-parsed out of the log.
  //
  // **The four counts stay apart, and only the renderer adds them.** Bash
  // stored the sum, and on a real run the cache reads swamp it — an implement
  // pass reporting `in=164 out=38700 cache_write=132393 cache_read=8067677`
  // makes 98% of an 8.2M-token row its cheapest component, so a row that
  // generated 8M tokens of output and one that re-read a warm cache read
  // identically. Summing is a render-time concern (`status/render.ts`) and
  // stays reversible; a sum written into the row cannot be taken apart again.
  //
  // The absent-key spelling of `rescuedOnto` above, for its reason and one
  // more: a run with no usage-bearing event writes none of the six rather
  // than zeros, because unmeasured is not free (`tasklib.py:691`).
  tokensIn: Schema.optionalWith(Schema.Number, { as: "Option", nullable: true, exact: true }),
  tokensOut: Schema.optionalWith(Schema.Number, { as: "Option", nullable: true, exact: true }),
  cacheWrite: Schema.optionalWith(Schema.Number, { as: "Option", nullable: true, exact: true }),
  cacheRead: Schema.optionalWith(Schema.Number, { as: "Option", nullable: true, exact: true }),
  // How many passes those counts are over — the denominator `status` renders
  // beside them, and the count of passes that *reported* usage: a failed pass
  // with a result counts, a killed one has nothing to count.
  passes: Schema.optionalWith(Schema.Number, { as: "Option", nullable: true, exact: true }),
  // Every model the run touched, union over the passes in first-seen order.
  // One pass can report several (`models=claude-haiku-4-5-20251001,claude-opus-5`),
  // so the union is load-bearing rather than decoration — and tokens without
  // the models that spent them price nothing (`run.sh:2195`).
  models: Schema.optionalWith(Schema.Array(Schema.String), {
    as: "Option",
    nullable: true,
    exact: true,
  }),
});
export type RunRecord = Schema.Schema.Type<typeof RunRecord>;
export type EncodedRunRecord = Schema.Schema.Encoded<typeof RunRecord>;
