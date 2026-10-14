// `--resume <branch>` and `--last` (SPEC §7): re-dispatching a branch off the
// ledger, with no spec argument and no `--base` — both come back off the
// record, and the run proceeds exactly as the original did.
//
// Three things live here: which target the flags name, what the ledger's
// answer means for a dispatch, and the decision table bash spells
// `resume_dispatch_action` (`tasklib.py:579-602`). The table is a **pure
// function, not a tag** (SPEC §2) — one decision, written whole, so no later
// ticket has to re-derive half of it and invent a contradictory answer.
//
// **Mode recovery is a tag read.** `Ledger.resolveResume` hands back a
// `DispatchIdentity` already unwrapped by `dispatchIdentity()`, and the arm is
// matched on `_tag`; nothing here null-checks its way to a mode, which is the
// whole point of T2 replacing bash's nullable `spec`/`feature` pair.
import { Effect, Option } from "effect";
import { Ledger, type ResumeTarget } from "../ledger/ledger.ts";
import type { DispatchIdentity, IssueOutcome } from "../ledger/record.ts";
import { namesId } from "../issues/issue.ts";
import type { SelectionRequest } from "../issues/selection.ts";
import { APPROVED_OUTCOME } from "./feature.ts";
import { GuardRefused } from "./guards.ts";

// `--last` is **sugar on `--resume`**, so it is a second *target* rather than
// a second code path: the same query, the same guard, and the same dispatch
// below it — only which record the ledger picks differs.
export const resumeTargetFor = (flags: {
  readonly resume: Option.Option<string>;
  readonly last: boolean;
}): Effect.Effect<Option.Option<ResumeTarget>, GuardRefused> => {
  // An empty `--resume ''` is no branch at all, filtered the way `--branch`
  // is, so it refuses as "no target" rather than resolving nothing.
  const named = Option.filter(flags.resume, (branch) => branch.trim() !== "");
  if (flags.last && Option.isSome(named)) {
    return new GuardRefused({
      detail:
        "--resume and --last name two different runs — --last already means --resume on the most recent branch",
    });
  }
  if (flags.last) {
    return Effect.succeedSome({ _tag: "Last" });
  }
  return Effect.succeed(Option.map(named, (branch) => ({ _tag: "Branch", branch }) as const));
};

// What a resume recovered: the branch it is for, the identity to carry
// forward, the run it resumed, and the base it ran against.
export interface ResumedRun {
  readonly branch: string;
  readonly identity: DispatchIdentity;
  readonly resumedRunId: Option.Option<string>;
  readonly base: Option.Option<string>;
}

const subjectOf = (target: ResumeTarget): string =>
  target._tag === "Last" ? "--last" : `--resume '${target.branch}'`;

// The hint bash prints under its not-found refusal (`tasklib.py:449-459`):
// "which branch did I call it" is the question a dispatcher who mistyped
// `--resume` actually has, and the ledger is the only thing that knows.
const knownBranchLines = (branches: ReadonlyArray<string>): string =>
  branches.length === 0 ? "  (none recorded)" : branches.map((branch) => `  ${branch}`).join("\n");

// The one refusal a resume has (matrix row 1): a branch with no ledger record
// at all, before anything is acquired and with no row written. Every other
// shortfall in the record is data on the resolved value, which is what keeps
// the ledger derived state (SPEC §10).
//
// A ledger that cannot be *read* degrades here the way it degrades `status`
// and the `--base` chain — it is not a crash and not a `Cause` dump, it is the
// same one-line refusal, saying which read failed. There is no fallback to
// degrade onto: the identity a resume needs exists nowhere else.
export const resumeResolved = (
  target: ResumeTarget,
): Effect.Effect<ResumedRun, GuardRefused, Ledger> =>
  Ledger.pipe(
    Effect.flatMap((ledger) => ledger.resolveResume(target)),
    Effect.mapError(
      (error) =>
        new GuardRefused({
          detail: `${subjectOf(target)}: the ledger could not be read (${error.detail}) — there is nothing to recover the run from`,
        }),
    ),
    Effect.flatMap((resolution) =>
      resolution._tag === "Resumable"
        ? Effect.succeed<ResumedRun>(resolution)
        : new GuardRefused({
            detail:
              target._tag === "Last"
                ? "--last: no runs recorded yet — dispatch normally first"
                : `no ledger record for branch '${target.branch}' — recent branches in the ledger:\n${knownBranchLines(resolution.knownBranches)}`,
          }),
    ),
  );

// What the recovered record says this branch's task was: the spec's identity
// as dispatched, the text a `--task` run recorded verbatim (T67), or the folder
// a feature run worked through and the ids of it still owed (T78). Three arms
// rather than one string, because they are answered differently below — a spec
// goes through T16's decision table, a recorded text cannot be *gone from
// disk*, so the table has no question to ask of it, and a recorded set is
// re-read at the tip through the content guards.
//
// The fourth is 15's feedback-only resume (T89): a feature row with nothing
// left to recover, and a `--feedback` that says what to do instead. It carries
// the text, as the decision table's `FeedbackStandsIn` does, and the folder
// and the recorded outcomes — every one `approved` — because the identity it
// wraps still says what the branch was dispatched for and what it holds (T92).
export type ResumedTask =
  | { readonly _tag: "Spec"; readonly spec: string }
  | { readonly _tag: "Inline"; readonly text: string }
  | { readonly _tag: "Feature"; readonly folder: string; readonly ids: ReadonlyArray<string> }
  | {
      readonly _tag: "FeedbackStandsIn";
      readonly folder: string;
      readonly issues: ReadonlyArray<IssueOutcome>;
      readonly text: string;
    };

// Which mode the recovered record was dispatched in — read off the tag. A
// feature row replays **the set it recorded, filtered by the outcomes it
// recorded**, and never rescans the folder (15, T78): *a resume can only ever
// run some of what it ran before*. The row's `issues` are the newest run's
// outcomes — T76 overlays them onto the identity a resume wraps — so the chain
// composes, each resume replaying what the one before it left.
//
// **Recoverable is every outcome but `approved`**: a failed pass, a capped
// review, and an issue the sequence never reached are all still owed.
//
// `--issues` beside the resume only **narrows** (15, T88): every id it names
// must be recorded on the row — membership against `issues[]`, whatever the
// outcomes, matched by T68's id rule as a fresh dispatch's ids are — and,
// within that, recoverable. The narrowed ids leave as the record spells them,
// so the tip re-read and T69's order take them exactly as they take a replay.
// `all` is refused: it has two readings and neither wins. And a row that
// recorded no set (`OneOff`, `InlineTask`) has nothing to narrow, so the flag
// refuses there rather than being dropped in silence. Every one of these needs
// the record, which is why they are decided here and `featureStatedOnce` lets
// the flag through.
//
// `issues` is the flag **as typed** on the outside — a row with no set refuses
// it for having been given at all — and what it named after the door's filter
// on the inside, where `None` is a flag that named nothing.
//
// A set with nothing left to recover is 15's feedback-only resume when
// `--feedback` said something (T89) — what it said stands in as the task, and
// no flag of its own selects that — and is refused when it said nothing.
export const resumedTask = (
  branch: string,
  identity: DispatchIdentity,
  issues: Option.Option<Option.Option<SelectionRequest>> = Option.none(),
  feedback: Option.Option<string> = Option.none(),
): Effect.Effect<ResumedTask, GuardRefused> => {
  switch (identity._tag) {
    case "OneOff":
      return Option.isSome(issues)
        ? noSetToNarrow(branch, "a spec")
        : Effect.succeed({ _tag: "Spec", spec: identity.spec });
    case "InlineTask":
      return Option.isSome(issues)
        ? noSetToNarrow(branch, "a --task")
        : Effect.succeed({ _tag: "Inline", text: identity.task });
    case "Feature": {
      if (Option.isSome(issues)) {
        return Effect.map(narrowed(branch, identity, issues.value), (ids) => ({
          _tag: "Feature" as const,
          folder: identity.feature,
          ids,
        }));
      }
      const ids = identity.issues
        .filter((recorded) => recorded.outcome !== APPROVED_OUTCOME)
        .map((recorded) => recorded.issue);
      if (ids.length > 0) {
        return Effect.succeed({ _tag: "Feature", folder: identity.feature, ids });
      }
      return Option.match(feedback, {
        onSome: (text) =>
          Effect.succeed<ResumedTask>({
            _tag: "FeedbackStandsIn",
            folder: identity.feature,
            issues: identity.issues,
            text,
          }),
        onNone: () =>
          new GuardRefused({
            detail: `every issue of '${identity.feature}' recorded on '${branch}' is approved; say what to do with --feedback, or dispatch the folder afresh with --feature … --issues …`,
          }),
      });
    }
  }
};

const noSetToNarrow = (branch: string, run: string): Effect.Effect<never, GuardRefused> =>
  new GuardRefused({
    detail: `--issues narrows the set a feature run recorded, and '${branch}' last ran ${run}, which records none — resume without --issues`,
  });

// The subset rule over what `--issues` named. An id outside the record and an
// approved one are both refused, every instance in one message, for
// `issuesSelected`'s reason: a dispatcher fixes one command line instead of
// re-running to meet the next complaint.
const narrowed = (
  branch: string,
  identity: Extract<DispatchIdentity, { readonly _tag: "Feature" }>,
  request: Option.Option<SelectionRequest>,
): Effect.Effect<ReadonlyArray<string>, GuardRefused> => {
  if (Option.isNone(request)) {
    return new GuardRefused({
      detail: `--issues was given with nothing in it — name the recorded issues to narrow the resume of '${branch}' to, or resume without --issues`,
    });
  }
  if (request.value._tag === "All") {
    return new GuardRefused({
      detail: `--issues all on a resume reads two ways — everything the record holds, or a fresh scan of '${identity.feature}' — so it is refused; name the recorded issues to narrow to, or dispatch the folder afresh: --feature ${identity.feature} --issues all --branch ${branch}`,
    });
  }
  const unknown: Array<string> = [];
  const approved: Array<string> = [];
  const selected: Array<string> = [];
  for (const candidate of request.value.ids) {
    const named = identity.issues.find((recorded) => namesId(candidate, recorded.issue));
    // Two spellings of one issue (`3,T3`) are one issue, as T69 has it.
    const into =
      named === undefined ? unknown : named.outcome === APPROVED_OUTCOME ? approved : selected;
    const id = named?.issue ?? candidate;
    if (!into.includes(id)) {
      into.push(id);
    }
  }
  const lines = [
    ...(unknown.length === 0
      ? []
      : [
          `not recorded on '${branch}': ${unknown.join(", ")} — the recorded set of '${identity.feature}' is ${identity.issues.map((recorded) => recorded.issue).join(", ")}; a resume only narrows it, and other issues are a fresh --feature dispatch`,
        ]),
    ...(approved.length === 0
      ? []
      : [
          `already approved on '${branch}': ${approved.join(", ")} — re-running approved work is refused, never silently skipped`,
        ]),
  ];
  return lines.length === 0
    ? Effect.succeed(selected)
    : new GuardRefused({
        detail: [
          `--issues does not narrow the resume of '${branch}':`,
          ...lines.map((line) => `  ${line}`),
        ].join("\n"),
      });
};

// Bash's four outcomes collapse to three before the move (08 §3): `--issues`
// and feature mode are post-move, so the `hard-error` arm arrives with them in
// ticket 09. What is left is one question asked of the resumed spec.
export type ResumeAction =
  // Ride the ordinary dispatch path on this spec — the common case, and no
  // mode switch.
  | { readonly _tag: "Normal"; readonly spec: string }
  // The spec is gone but the dispatcher said what to do anyway, so what they
  // said **stands in as the task** (T17, named for the table's decision rather
  // than for the flag it arrived on in T66). It carries the text: this arm
  // exists only because there was some, so a caller that had to unwrap an
  // `Option` again — and decide what an impossible `None` means — would be
  // re-deriving half the decision this table exists to make once.
  | { readonly _tag: "FeedbackStandsIn"; readonly text: string }
  // Nothing to run and nothing said: refuse, exit nonzero, start nothing.
  | { readonly _tag: "Refuse"; readonly detail: string };

// The table, whole. T16 wrote all three arms and left the standing-in one
// unreachable — nothing could supply the text — and T17 is what reaches it:
// the flag arrives as the `Option` below, and the arm it decides carries the
// text rather than a flag saying there was some.
export const resumeDispatchAction = (recovered: {
  // The spec as the ledger recorded it, which is what a refusal names.
  readonly spec: string;
  // Where that spec resolves on this host today, or none. Whether the file is
  // there is the world's question, asked by the guard; this stays pure.
  readonly resolved: Option.Option<string>;
  // What this dispatch's `--feedback` said, if it said anything (T17). The
  // whole value rather than a `hasFeedback` boolean: the presence is what
  // decides the arm and the text is what that arm needs, and taking them apart
  // is what would let a run be built with nothing to do.
  readonly feedback: Option.Option<string>;
}): ResumeAction =>
  Option.match(recovered.resolved, {
    onSome: (spec) => ({ _tag: "Normal", spec }),
    onNone: () =>
      Option.match(recovered.feedback, {
        onSome: (text) => ({ _tag: "FeedbackStandsIn", text }),
        onNone: () => ({
          _tag: "Refuse",
          detail: `the resumed spec is no longer on disk: ${recovered.spec} — restore it, or dispatch a spec by name on this branch`,
        }),
      }),
  });
