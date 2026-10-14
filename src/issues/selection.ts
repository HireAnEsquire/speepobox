// A selection is a value (T69) — tasklib's `select_issues`
// (`tasklib.py:268-333`) as the pure function SPEC §5 asks for: every
// operation returns a Schema-defined domain value, and this one's is
// `IssueSelection`.
//
// No text and no folder reach here: `select` is pure over T68's `Issue`s, so
// reading a ref (T71) and refusing a dispatch (T73) are somebody else's job.
// Every rule bash spread over `select_issues`, `cmd_select`, and the run
// loop's mid-run HITL check (`run.sh:1746-1757`) is one arm of one of the two
// values below.
//
// **A refusal is data here, and a dispatch nowhere in sight.** T73 turns each
// arm into a `GuardRefused` in its own words, every arm in one message, which
// is why the arms carry the ids, titles, and tokens a sentence quotes and no
// sentence of their own — a message built here would be a second copy of that
// vocabulary (T68 says the same of `BlockerCycle`).
import { Data, Either, Schema } from "effect";
import { Blocker, Issue, compareIds, namesId, orderIssues } from "./issue.ts";

// --- the request ------------------------------------------------------------

// What the dispatcher asked for, in the shape 15 decided: the wide form, or
// the ids they listed. The two are not the same kind of consent — **`all`
// consents to wideness, not to contents**, and only enumerating overrides a
// status.
//
// `Enumerated.ids` arrive **already trimmed and emptiness-filtered**: T73 does
// that once at the door, as it does for `--task` and `--feedback`, so
// `--issues 'T70, ,'` is `["T70"]` and `--issues ''` is refused there as an
// empty selection rather than arriving here as one. Each id is matched by
// T68's rule, so `37`, `t37`, and `T37` all name `T37`.
export const SelectionRequest = Schema.Union(
  Schema.TaggedStruct("All", {}),
  Schema.TaggedStruct("Enumerated", { ids: Schema.Array(Schema.String) }),
);
export type SelectionRequest = Schema.Schema.Type<typeof SelectionRequest>;

// --- the value --------------------------------------------------------------

// What a feature dispatch carries (SPEC §5): the request that produced it, and
// its issues **in T68's order**.
//
// The order is decided here, once, so the run loop (T76), the plan block
// (T73), a resume's subset check (T88), and the ledger's `not-attempted` tail
// (T76) all read one sequence rather than four sorts that can disagree. The
// issues are T68's whole `Issue` — id, stem, title, type, status, blockers —
// and the file name a caller writes back to is `fileNameOf`, derived from the
// stem rather than stored beside it so the two cannot drift.
//
// `issues` is never empty. An empty result is `NothingReady` below, because a
// feature run with no issues is unrepresentable (T66's rule for the inline
// arm, applied here).
export const IssueSelection = Schema.Struct({
  request: SelectionRequest,
  issues: Schema.Array(Issue),
});
export type IssueSelection = Schema.Schema.Type<typeof IssueSelection>;

// --- the refusals -----------------------------------------------------------

// One reason a selection cannot stand. Each arm carries **every** instance
// that fired rather than the first (`tasklib.py:313-330`), and the refusal
// below carries every arm, so a dispatcher fixes one command line instead of
// re-running to meet the next complaint.
export const SelectionRefusal = Schema.Union(
  // `all` over a folder where nothing is ready — which is not an empty run but
  // no run at all. It names the folder because the folder is what the
  // dispatcher typed; the ids are not theirs to have known.
  Schema.TaggedStruct("NothingReady", { folder: Schema.String }),
  // Ids naming no file in the folder. The folder's own ids ride along as the
  // hint, since a dispatcher who typed the wrong one is looking for the right
  // one.
  Schema.TaggedStruct("UnknownIssue", {
    ids: Schema.Array(Schema.String),
    known: Schema.Array(Schema.String),
  }),
  // `done` on this ref — 14's one meaning. Re-running landed work is refused
  // and never silently skipped: the dispatcher named it, so the mismatch is
  // between what they believe and what the ref says.
  Schema.TaggedStruct("AlreadyDone", { issues: Schema.Array(Issue) }),
  // `Type: HITL`. Bash stamps `blocked (HITL)` mid-run and stops the sequence
  // (`run.sh:1746-1757`); here it is a refusal before anything is held, and
  // the port never writes `blocked-hitl` to a row at all (SPEC §12).
  Schema.TaggedStruct("NotAfk", { issues: Schema.Array(Issue) }),
  // Every (issue, blocker) pair whose blocker is neither done nor in the set.
  // The blocker is T68's, so an **external** one — a token naming no file in
  // the folder, never satisfiable — is quoted by the token the file wrote.
  Schema.TaggedStruct("BlockerViolation", {
    pairs: Schema.Array(Schema.Struct({ issue: Issue, blocker: Blocker })),
  }),
  // T68's cycle, reached by either arm: the wide one keeps a ready cycle
  // whole (each of its blockers is in the set), and enumerating one names it.
  Schema.TaggedStruct("BlockerCycle", { ids: Schema.Array(Schema.String) }),
);
export type SelectionRefusal = Schema.Schema.Type<typeof SelectionRefusal>;

// The answer when there is no selection: every reason that fired, in the order
// the table in T69 lists them. Non-empty by construction — a refusal with
// nothing on it would be a refusal nobody can read.
export class SelectionRefused extends Data.TaggedError("SelectionRefused")<{
  readonly refusals: ReadonlyArray<SelectionRefusal>;
}> {}

// --- the rules --------------------------------------------------------------

const issueNamed = (issues: ReadonlyArray<Issue>, candidate: string): Issue | undefined =>
  issues.find((issue) => namesId(candidate, issue.id));

// **Done or also selected** — the one rule both arms enforce, and the only
// place an external blocker is answered. A token naming no issue in the folder
// matches nothing here, so it is never satisfied: `all` drops whatever it
// blocks, and enumerating that issue is a violation quoting the token.
const isSatisfied = (
  blocker: Blocker,
  issues: ReadonlyArray<Issue>,
  selected: ReadonlyArray<Issue>,
): boolean =>
  selected.some((issue) => namesId(blocker.id, issue.id)) ||
  issueNamed(issues, blocker.id)?.status === "done";

// `all` (`tasklib.py:292-306`) with 09's amendment of 2026-09-21: the
// predicate reads the **triage status** — `Type: AFK` and `ready-for-agent` —
// where bash read *AFK and not-yet-Done*. Every ticket opens at `needs-triage`
// (TEMPLATE.md), so bash's predicate sweeps in everything nobody has triaged,
// and a token typed before the list is seen cannot consent to that.
//
// A fixed point from above: start from every ready AFK issue, drop any whose
// blockers are not all done-or-in-set, and repeat until the set stops moving —
// one round is not enough, because dropping an issue strands whatever it
// blocked. What the fixed point drops is dropped **silently**; that is the
// wide form's contract, and the enumerated arm is where an unmet blocker is an
// answer rather than a shrug.
const selectAll = (
  issues: ReadonlyArray<Issue>,
  selected: ReadonlyArray<Issue> = issues.filter(
    (issue) => issue.type === "AFK" && issue.status === "ready-for-agent",
  ),
): ReadonlyArray<Issue> => {
  const kept = selected.filter((issue) =>
    issue.blockers.every((blocker) => isSatisfied(blocker, issues, selected)),
  );
  return kept.length === selected.length ? kept : selectAll(issues, kept);
};

interface Enumeration {
  readonly selected: ReadonlyArray<Issue>;
  readonly refusals: ReadonlyArray<SelectionRefusal>;
}

// Enumerating (`tasklib.py:313-330`), which **overrides status except `done`**:
// a `needs-triage`, `needs-info`, `ready-for-human`, or `wontfix` issue named
// by id runs, because the dispatcher named it (15's value-versus-policy line).
// Naming it is the override; the four refusals below are what naming cannot
// override.
const selectEnumerated = (
  issues: ReadonlyArray<Issue>,
  ids: ReadonlyArray<string>,
): Enumeration => {
  const unknown: Array<string> = [];
  const selected: Array<Issue> = [];
  for (const candidate of ids) {
    const named = issueNamed(issues, candidate);
    if (named === undefined) {
      unknown.push(candidate);
    } else if (!selected.includes(named)) {
      // Two spellings of one issue (`37,T37`) are one issue, as bash's
      // `dict.fromkeys` had it — a set is a set, and the second spelling must
      // not run the issue twice.
      selected.push(named);
    }
  }
  const done = selected.filter((issue) => issue.status === "done");
  const hitl = selected.filter((issue) => issue.type === "HITL");
  const pairs = selected.flatMap((issue) =>
    issue.blockers
      .filter((blocker) => !isSatisfied(blocker, issues, selected))
      .map((blocker) => ({ issue, blocker })),
  );
  const refusals: Array<SelectionRefusal> = [];
  if (unknown.length > 0) {
    refusals.push({
      _tag: "UnknownIssue",
      ids: unknown,
      known: issues.map((issue) => issue.id).toSorted(compareIds),
    });
  }
  if (done.length > 0) {
    refusals.push({ _tag: "AlreadyDone", issues: done });
  }
  if (hitl.length > 0) {
    refusals.push({ _tag: "NotAfk", issues: hitl });
  }
  if (pairs.length > 0) {
    refusals.push({ _tag: "BlockerViolation", pairs });
  }
  return { selected, refusals };
};

// The selection, over the issue set a ref carries (T71) and the request the
// command named (T73). The folder is neither: nothing selects on it and only
// `NothingReady` says it, which is why it sits last.
export const select = (
  issues: ReadonlyArray<Issue>,
  request: SelectionRequest,
  folder: string,
): Either.Either<IssueSelection, SelectionRefused> => {
  const { selected, refusals }: Enumeration =
    request._tag === "All"
      ? { selected: selectAll(issues), refusals: [] }
      : selectEnumerated(issues, request.ids);
  if (refusals.length > 0) {
    return Either.left(new SelectionRefused({ refusals }));
  }
  // Both arms end here, and for the same reason: `all` over a folder with
  // nothing ready and an enumeration that named nothing are one answer, since
  // what neither produced is a run.
  if (selected.length === 0) {
    return Either.left(new SelectionRefused({ refusals: [{ _tag: "NothingReady", folder }] }));
  }
  return Either.mapBoth(orderIssues(selected), {
    onLeft: (cycle) =>
      new SelectionRefused({ refusals: [{ _tag: "BlockerCycle", ids: cycle.ids }] }),
    onRight: (ordered) => ({ request, issues: ordered }),
  });
};
