// What a feature run records, and the one thing it reads inside the container
// (T76). The loop itself is the scope's, beside the single implement pass it
// replaces (`run.ts`); what lives here is everything about it that is a value:
// the outcome vocabulary, the fold from what the loop recorded onto the row,
// and the boundary read — a `Sandbox` question, not a `Git` one.
import { Effect, Option, Ref } from "effect";
import { CAPPED_UNREVIEWED_FIX } from "../agent/verdict.ts";
import { type Issue, titleAfterId, titleNamesIssue } from "../issues/issue.ts";
import type { IssueOutcome, RunIdentity } from "../ledger/record.ts";
import { Sandbox, type SandboxError, type SandboxHandle } from "../sandbox/sandbox.ts";
import type { DispatchPlan } from "./plan.ts";

// The vocabulary is bash's issue loop minus `blocked-hitl` (T69): a HITL issue
// is refused before the lock here, so no row this package writes carries that
// token (SPEC §12). The other two the loop reads back — `approved`, which is
// `outcomeFor("approved")`, and `not-attempted`, which nothing decides because
// it is what *no* decision leaves behind — are spelled here with the two the
// loop writes on a failed pass, so the six tokens of a `Feature` row are one
// list rather than five string literals and a comment.
export const APPROVED_OUTCOME = "approved";
export const IMPLEMENT_FAILED = "implement-failed";
export const REVIEW_FAILED = "review-failed";
export const NOT_ATTEMPTED = "not-attempted";

// Every selected id with the outcome the loop recorded for it, in T69's order,
// and `not-attempted` for every one the sequence never reached
// (`run.sh:1896-1901`).
//
// **The tail is computed where the row is written, never as the loop stops**
// (T76): a run killed mid-pass ran no code after its stop, so a tail the loop
// appended would be missing from exactly the rows that need it most — and the
// issue in flight when the kill landed is `not-attempted` too, because nothing
// landed for it and the resume replays it (T78).
export const issueOutcomesFor = (
  selected: ReadonlyArray<Issue>,
  recorded: ReadonlyArray<IssueOutcome>,
): ReadonlyArray<IssueOutcome> =>
  selected.map(
    (issue) =>
      recorded.find((outcome) => outcome.issue === issue.id) ?? {
        issue: issue.id,
        outcome: NOT_ATTEMPTED,
      },
  );

// The outcomes onto the identity the plan resolved, which carries `issues: []`
// because a plan decided before anything was held cannot know them
// (`plan.ts`). It reaches the `Feature` arm **wherever it is** — a resume wraps
// one (T78), and a row whose outcomes went missing under a `FeedbackResume`
// would be a feature run reporting nothing it did.
export const withIssueOutcomes = (
  identity: RunIdentity,
  issues: ReadonlyArray<IssueOutcome>,
): RunIdentity => {
  if (identity._tag === "Feature") {
    return { ...identity, issues };
  }
  if (identity._tag === "FeedbackResume" && identity.resumed._tag === "Feature") {
    return { ...identity, resumed: { ...identity.resumed, issues } };
  }
  return identity;
};

// Which issue the sequence stopped on, if it stopped on one: the first that
// neither approved nor went unattempted. It is read off the **row's** outcomes
// rather than kept beside them, so the sentence a dispatcher is notified with
// and the row they read afterwards cannot disagree (`notify/notifications.ts`,
// and T79's checklist after it).
export const stoppedAt = (issues: ReadonlyArray<IssueOutcome>): Option.Option<IssueOutcome> =>
  Option.fromNullable(
    issues.find(
      (outcome) => outcome.outcome !== APPROVED_OUTCOME && outcome.outcome !== NOT_ATTEMPTED,
    ),
  );

// The `### Issues` checklist a feature run's PR body ends with (T79): one line
// per **selected** issue in T69's order, then the footer that says whether the
// sequence finished. bash rebuilt it over the whole folder, with a
// status-derived line for every issue the run never selected
// (`run.sh:1903-1929`); this run's selection only is decision 4 of 09's
// comment of 2026-09-21, because a line about an issue the run never selected
// is a claim about work the PR does not contain.
//
// The wording is bash's (`run.sh:1792, 1859, 1873, 1880, 1887, 1899`) minus
// `blocked (HITL)`, which no selection carries (T69). The stop is read off the
// same outcomes the lines are, through `stoppedAt`, so the footer, the lines,
// the row, and the terminal notification cannot disagree about where the
// sequence stopped. `recorded` is what the loop wrote; the `not-attempted`
// tail is filled here exactly as it is for the row.
export const issueChecklistFor = (
  selected: ReadonlyArray<Issue>,
  recorded: ReadonlyArray<IssueOutcome>,
  maxReviewRounds: number,
): string => {
  const outcomes = issueOutcomesFor(selected, recorded);
  // The id once: a ticket's H1 already opens with it (`T70 — …`), as does a
  // title that fell back to the file stem, so only a title that does not is
  // prefixed with it — and the footer, which names the id itself, is given
  // what follows it. An id no selected issue carries is named by itself.
  const issueOf = (id: string): Issue | undefined => selected.find((issue) => issue.id === id);
  const nameOf = (id: string): string => {
    const issue = issueOf(id);
    if (issue === undefined) {
      return id;
    }
    return titleNamesIssue(issue) ? issue.title : `${id} — ${issue.title}`;
  };
  const restOf = (id: string): string => {
    const issue = issueOf(id);
    return issue === undefined ? "" : titleAfterId(issue);
  };
  const line = ({ issue, outcome }: IssueOutcome): string => {
    const head = nameOf(issue);
    switch (outcome) {
      case APPROVED_OUTCOME:
        return `- [x] ${head}: ✅ approved`;
      case IMPLEMENT_FAILED:
        return `- [ ] ${head}: ❌ implement pass failed`;
      case REVIEW_FAILED:
        return `- [ ] ${head}: ❌ review pass failed`;
      case "needs-work":
        return `- [ ] ${head}: ⚠️ needs-work (review capped at ${maxReviewRounds} round(s))`;
      case CAPPED_UNREVIEWED_FIX:
        return `- [ ] ${head}: ⚠️ fix unreviewed (round ${maxReviewRounds} fixed and capped — nothing else outstanding)`;
      case NOT_ATTEMPTED:
        return `- [ ] ${head}: not attempted (sequence stopped)`;
      // A token outside the vocabulary is still unfinished work, said as the
      // row spells it rather than dropped from the list.
      default:
        return `- [ ] ${head}: ${outcome}`;
    }
  };
  const stopReason = ({ issue, outcome }: IssueOutcome): string => {
    const rest = restOf(issue);
    const which = rest === "" ? `issue ${issue}` : `issue ${issue} (${rest})`;
    switch (outcome) {
      case IMPLEMENT_FAILED:
        return `${which} implement pass failed — see log`;
      case REVIEW_FAILED:
        return `${which} review pass failed — see log`;
      case "needs-work":
        return `${which} review capped at needs-work after ${maxReviewRounds} round(s)`;
      case CAPPED_UNREVIEWED_FIX:
        return `${which} capped after a fixing round — the final round's commits went unreviewed, nothing else outstanding`;
      default:
        return `${which} ${outcome}`;
    }
  };
  const footer = Option.match(stoppedAt(outcomes), {
    onNone: () => "**All selected issues completed.**",
    onSome: (stop) => `**Stopped:** ${stopReason(stop)}`,
  });
  return ["### Issues", ...outcomes.map(line), "", footer].join("\n");
};

// The commit the branch stands at as an issue begins (`run.sh:1766`), read
// **in the container** and never by host git in the clone.
//
// The rule it keeps is `run.sh`'s own at its land step, and decision 2 of 09's
// comment of 2026-09-21: the agent owns the clone's `.git/config`, so a
// `core.fsmonitor` it wrote there runs a command of its choosing — with the
// dispatcher's credentials — on read-only operations too. `git -C <checkout>
// rev-parse HEAD` typechecks, reads fine, and is that hole (AGENTS.md). The
// container is where the clone's own git already runs, under the caps the
// sandbox drops.
export const BOUNDARY_COMMAND: ReadonlyArray<string> = ["git", "rev-parse", "HEAD"];

export const boundaryIn = (
  handle: SandboxHandle,
  plan: DispatchPlan,
): Effect.Effect<string, SandboxError, Sandbox> =>
  Effect.gen(function* () {
    const sandbox = yield* Sandbox;
    // `exec`'s streaming half is the only one that hands a caller what the
    // child said (`sandbox/sandbox.ts`), so the one line is collected the way
    // a pass's narration is — through `onOutput`, into a `Ref` this reads back
    // once the child is gone.
    const said = yield* Ref.make<ReadonlyArray<string>>([]);
    yield* sandbox.exec(handle, BOUNDARY_COMMAND, {
      stdin: "",
      onOutput: (line) => Ref.update(said, (lines) => [...lines, line]),
      // The command's failure already carries git's own stderr; there is no
      // second use for it here.
      onStderr: () => Effect.void,
    });
    const answered = (yield* Ref.get(said)).map((line) => line.trim()).find((line) => line !== "");
    // A container that said nothing is a **rehearsal**: the recording
    // `Sandbox` records the command rather than running it (T15), so there is
    // no HEAD to have read. The plan's tip is what the answer would have been
    // — the checkout forks from it (T73) — which keeps a rehearsal's messages
    // saying the same thing a real run's first issue is told, rather than
    // naming an empty commit. A live `git rev-parse HEAD` that exits zero
    // always prints one.
    return answered ?? plan.tipSha;
  });
