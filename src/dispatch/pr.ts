// The PR step (T12): the description pass, then the draft PR — the second
// half of the run's `work`, and the last thing that happens before anything
// releases.
//
// **It runs after the push, and that ordering is bash's and deliberate**
// (`run.sh:1679-1723`): the expensive, recoverable thing happens first, so a
// forge that will not answer arrives with the commits already home. Matrix row
// 15 is exactly that — everything releases, the row is `failed` at stage `pr`,
// and a human re-runs the dispatch or opens the PR by hand over commits that
// are already on the branch.
//
// The one degradation here is the description (`run.sh:1683-1687`): a failed
// pass must not cost the run its PR, so it warns and falls back to a static
// body. The failure that *is* fatal is the forge's, because a PR nobody opened
// is the thing the run was for.
import { basename } from "node:path";
import { Effect, Option, Ref } from "effect";
import { AgentCli } from "../agent/agent-cli.ts";
import { SpeepoboxConfig } from "../config/config.ts";
import { Forge, type ForgeError } from "../forge/forge.ts";
import type { RepoSlug } from "../git/repo-slug.ts";
import type { IssueOutcome, PullRequest } from "../ledger/record.ts";
import { Reporter } from "../reporter.ts";
import type { SandboxHandle } from "../sandbox/sandbox.ts";
import { issueChecklistFor } from "./feature.ts";
import type { DispatchPlan, Task } from "./plan.ts";

// bash's title (`run.sh:1721`). It carries the tool's name because the first
// thing a reviewer meeting one of these in a PR list needs to know is who
// wrote it.
export const PR_TITLE_PREFIX = "[speepobox] ";

export const prTitleFor = (branch: string): string => `${PR_TITLE_PREFIX}${branch}`;

// The body a run opens a PR with when the description pass could not write one
// (`run.sh:1686`). It points at the log rather than apologizing: the pass's
// own failure is already a warning on the console and a line in that file.
export const DESCRIPTION_UNAVAILABLE = "_(description generation failed — see the task log)_";

// The trailer bash appends to every body it writes (`run.sh:1687-1689`), and
// the two things it says are both for the human who opens the PR: what wrote
// this, and that the draft state is a gate rather than an accident.
//
// The spec is named by the arm that has one (T66). A run whose task was stated
// inline has no file to name, and the plan carries no path to fall back on —
// deliberately, because the one it used to carry was a spec the run never read.
const authorship = (task: Task): string =>
  task._tag === "Spec"
    ? `AI-authored via speepobox (spec: \`${basename(task.path)}\`).`
    : "AI-authored via speepobox.";

// A feature run's body ends with its `### Issues` checklist (T79), rendered
// here from the run's outcomes and never asked of the agent: what became of
// each issue is the dispatcher's record, and a description pass that restated
// it could restate it wrong. It rides on whatever body there is — the span the
// pass wrote or the static one — so a degraded description still says which
// issues landed. It is the last thing in the body, below the trailer bash put
// it above (`run.sh:2141`), because the ticket asks for a body that ends with
// it. Every other arm passes none and its body is unchanged.
export const prBodyFor = (
  description: string,
  plan: DispatchPlan,
  checklist: Option.Option<string> = Option.none(),
): string =>
  [
    description.trim() === "" ? DESCRIPTION_UNAVAILABLE : description.trim(),
    "",
    "---",
    `${authorship(plan.task)} Draft until the dispatching dev reviews it.`,
    ...Option.match(checklist, { onNone: () => [], onSome: (text) => ["", text] }),
  ].join("\n");

export const openPullRequest = (
  plan: DispatchPlan,
  // Which repo the forge calls below name (T39), resolved once at the
  // composition root and passed down like `repoRoot` itself.
  forgeRepo: RepoSlug,
  handle: SandboxHandle,
  // Where the PR reaches the terminal row (`run.ts`). It is set the moment the
  // forge names a PR, which on the edit path is the view rather than the edit:
  // a body we failed to replace is still a PR this branch's work is readable
  // at, and a row claiming none while one is open would be the mirror image of
  // synthesizing one.
  recorded: Ref.Ref<Option.Option<PullRequest>>,
  // What the feature loop recorded for each issue it reached (T76), which is
  // what the checklist renders. Read here, after the loop and the land, and on
  // the edit path as much as the create one — so a resumed run's PR shows the
  // newest run's checklist, never the one the first run wrote.
  outcomes: Ref.Ref<ReadonlyArray<IssueOutcome>>,
): Effect.Effect<void, ForgeError, Forge | AgentCli | SpeepoboxConfig | Reporter> =>
  Effect.gen(function* () {
    const forge = yield* Forge;
    const agent = yield* AgentCli;
    const reporter = yield* Reporter;
    const config = yield* SpeepoboxConfig;

    // The pass, and the whole of its failure handling: it is typed like every
    // other pass at the seam (`agent/agent-cli.ts`) and degrades here, where
    // the caller knows what a missing description costs — one section of one
    // PR body, against commits that are already pushed.
    // No issue: what this pass describes is the branch, and its message names
    // the whole selection off the plan on the arm that has one (T75).
    const description = yield* agent.describePr(handle, plan, Option.none()).pipe(
      Effect.catchAll((error) =>
        reporter
          .emit({
            _tag: "Warned",
            detail: `${error.detail} — the PR gets a static body instead; the commits are already pushed`,
          })
          .pipe(Effect.as("")),
      ),
    );
    const checklist =
      plan.task._tag === "Feature"
        ? Option.some(
            issueChecklistFor(
              plan.task.selection.issues,
              yield* Ref.get(outcomes),
              config.maxReviewRounds,
            ),
          )
        : Option.none();
    const body = prBodyFor(description, plan, checklist);

    // Edit-or-create, in bash's order (`run.sh:1713-1722`): re-runs land on
    // the same branch, so a second dispatch updates the PR the first one
    // opened rather than stacking a duplicate beside it.
    const existing = yield* forge.prView({ repo: forgeRepo, branch: plan.branch });
    if (Option.isSome(existing)) {
      // The pair, off the view's answer: the title and body beside it are what
      // a resuming run's prompt quotes (T17), and the row records neither.
      yield* Ref.set(recorded, Option.some(existing.value.pr));
      yield* forge.prEdit({ repo: forgeRepo, branch: plan.branch, body });
      return yield* reporter.emit({
        _tag: "PullRequestReady",
        pr: existing.value.pr,
        action: "updated",
      });
    }

    // The base the PR targets is this run's `--base` ref, the same value the
    // review read its diff against and the row records — never a second
    // answer resolved here (`forge.ts` turns it into the branch `gh` wants).
    const created = yield* forge.prCreate({
      repo: forgeRepo,
      branch: plan.branch,
      base: plan.baseRef,
      title: prTitleFor(plan.branch),
      body,
    });
    yield* Ref.set(recorded, Option.some(created));
    yield* reporter.emit({ _tag: "PullRequestReady", pr: created, action: "created" });
  });
