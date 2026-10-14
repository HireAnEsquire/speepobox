// The land (T11): the run's commits coming home and then going out, in the
// order bash does it (`run.sh:1529-1592`) — fetch-back, count, push, or
// "nothing to land". It is the first half of the `work` the run's scope is
// handed, so it runs inside the scope with all three resources still held,
// after the review rounds and before anything releases. The PR follows it
// (`pr.ts`), on the answer this hands back.
//
// **The fetch-back here is the same one the release attempts on the way out,
// and that is not a second path.** The release's fetch is the salvage *every*
// exit path gets (`checkout.ts`, 05 Q10) — it answers "did this run's work
// survive" for a run that died at the setup hook no less than for one that got
// this far, which is why it takes no opinion from anything above it and must
// keep taking none. This fetch asks the land's own question, at the one point
// where its answer is an outcome: the commits are not pushable until they are
// on the branch, and a fetch that will not fast-forward has to end the run at
// stage `land` (matrix row 13) rather than warn from a finalizer that
// swallows. Behind a fetch that succeeded, the release's is a fast-forward
// over zero commits, so the checkout goes by its ordinary derived path —
// which is exactly what matrix row 14 says a failed push leaves behind.
import { Effect, Option, Ref } from "effect";
import { SpeepoboxConfig } from "../config/config.ts";
import { Git, type GitError } from "../git/git.ts";
import { IssueStore, type IssueStoreError } from "../issues/issue-store.ts";
import type { IssueOutcome } from "../ledger/record.ts";
import { Reporter } from "../reporter.ts";
import { repoUrl } from "./checkout.ts";
import { APPROVED_OUTCOME } from "./feature.ts";
import { type DispatchPlan, statusIndexPathFor, type Task } from "./plan.ts";

// Which of the step's two ends this run reached — and the whole of what the
// caller needs from it (T12): a PR is opened for commits that went out, and a
// branch with nothing past the boundary has nothing to open one about
// (`run.sh:1673`). A boolean would answer the same question and name neither
// arm.
export type LandOutcome = "pushed" | "nothing-to-land";

// The stems of the issues this run approved, in the order the loop decided
// them (T77). The outcomes carry ids and the commit is named after stems (14,
// lesson 10), so the selection is what maps one onto the other.
const approvedStems = (
  task: Extract<Task, { readonly _tag: "Feature" }>,
  outcomes: ReadonlyArray<IssueOutcome>,
): ReadonlyArray<string> =>
  outcomes.flatMap(({ issue, outcome }) => {
    const selected = task.selection.issues.find((candidate) => candidate.id === issue);
    return outcome === APPROVED_OUTCOME && selected !== undefined ? [selected.stem] : [];
  });

// What the warning quotes: git's own words where git refused, and the store's
// for the two arms that are about the folder rather than git.
const markLandedFailure = (error: IssueStoreError): string => {
  switch (error._tag) {
    case "GitError":
      return error.detail;
    case "FolderAbsent":
      return `${error.ref} carries no ${error.path}`;
    case "Unparseable":
      return `${error.file}: ${error.detail}`;
  }
};

export const land = (
  plan: DispatchPlan,
  repoRoot: string,
  outcomes: Ref.Ref<ReadonlyArray<IssueOutcome>>,
): Effect.Effect<LandOutcome, GitError, Git | IssueStore | SpeepoboxConfig | Reporter> =>
  Effect.gen(function* () {
    const repo = yield* Git;
    const config = yield* SpeepoboxConfig;
    const issueStore = yield* IssueStore;
    const reporter = yield* Reporter;
    const branchRef = `refs/heads/${plan.branch}`;

    // Read before the fetch moves the ref: "what did this run add" is a
    // question about a tip that stops existing the moment the commits land.
    // bash keeps the same value from before the clone (`run.sh:1261`); the
    // lock is what makes reading it here the same answer, since no second
    // dispatch can be touching this branch in between.
    //
    // Every one of the four git calls below names `repoRoot`, reads included
    // (T27): the tip this run started from, the two counts, and the fetch-back
    // between them are one answer about one repo, and a read taken from the
    // working directory instead would be an answer about whichever repo the
    // dispatcher happened to be standing in — the agent's own clone, most
    // plausibly, which is a real repo with this same branch in it.
    const preTip = yield* repo.revParse({ repo: repoRoot, rev: branchRef });
    // The same branded parse the release sends this same path through (SPEC
    // §9, invariant 2), imported rather than spelled a second time: two
    // spellings of one door is how a URL eventually arrives through the one
    // that forgot to strip it.
    const from = yield* repoUrl(plan.checkoutPath);
    // Onto the branch the run was given, and only ever that one: the release's
    // rescue is salvage, and a land that partially succeeded onto a branch
    // nobody asked for is the outcome this step exists to refuse (T29).
    yield* repo.fetchBack({ from, into: repoRoot, branch: plan.branch, onto: plan.branch });

    const sinceBoundary = yield* repo.countCommits({
      repo: repoRoot,
      from: plan.mergeBaseSha,
      to: branchRef,
    });
    const thisRun = yield* repo.countCommits({ repo: repoRoot, from: preTip, to: branchRef });

    // A hard reset rewrote the branch, so its push is a rewrite too (T101):
    // leased, and pinned to where `origin/<b>` stood after the guard phase's
    // fetch (D7). Every other dispatch pushes forward or fails, argv unchanged.
    // Built once, because the empty arm below pushes a reset with it as well.
    const push = {
      from: repoRoot,
      branch: plan.branch,
      ...Option.match(plan.reset, {
        onNone: () => ({}),
        onSome: (reset) => ({ lease: { expect: reset.originTip } }),
      }),
    };

    // Nothing past the boundary is **not a failure and not a push**
    // (`run.sh:1589-1592`): the agent's pass produced no work, the run says so
    // in its own sentence, and the terminal row records the review's verdict
    // over a branch that gained nothing — with the PR fields absent, because
    // there is nothing to open one about. bash gates on the boundary count
    // alone and so does this: a branch with nothing past the boundary has
    // nothing this run added either, so the second count is a report rather
    // than a second condition.
    //
    // **Except that a reset is a reset on both ends** (T105): under
    // `--hard-reset` the boundary is the base, so an agent that added nothing
    // leaves the local branch at the base while origin still holds everything
    // the plan counted as discarded. The leased push goes out anyway — only
    // when origin had the branch somewhere other than the base, since an absent
    // one would be *created* and one already there moves nothing. The land
    // still answers `nothing-to-land`: there is no commit for a PR to be about.
    if (sinceBoundary === 0) {
      yield* reporter.emit({ _tag: "NothingToLand" });
      const stale = Option.flatMap(plan.reset, (reset) =>
        Option.filter(reset.originTip, (originTip) => originTip !== plan.mergeBaseSha),
      );
      if (Option.isSome(stale)) {
        yield* repo.push(push);
        yield* reporter.emit({
          _tag: "ResetPushed",
          branch: plan.branch,
          originTip: stale.value,
        });
      }
      return "nothing-to-land";
    }

    // The status commit (T77), between the fetch-back and the push: after the
    // fetch because it is built on the branch the agent's commits are now on,
    // and before the push so it goes out with them and reaches the base in the
    // same merge as the code it describes. `IssueStore` builds it in the
    // served repo with plumbing — never in the clone, whose `.git` the agent
    // owns. One commit, carrying every issue this run approved; a spec or
    // inline run approves none, so it never asks.
    //
    // Gated on `thisRun`, not on the boundary count (14, lesson 5): a run that
    // produced no agent commits gets no status commit, so it cannot push a
    // branch whose only new content is bookkeeping — and counting the branch
    // total instead is the mistake bash's first version made on a resume.
    //
    // **Advisory, never fatal** (14, lesson 4): the fetched-back commits are
    // in hand and unpushed, so a failure here is a warning naming the stems and
    // git's words, and the push still happens.
    //
    // The scratch index the tree is built in is this host's file, so it is
    // named here, off the plan's slug and the runtime root, and handed down:
    // the store writes where it is told and removes what it wrote.
    //
    // **A commit made says so** (T90): it is the one commit on the branch the
    // dispatcher's own identity authored, so the log names it — the stems and
    // the branch — rather than leaving it to be inferred from a count. A store
    // that found none of the stems' files made nothing and says nothing.
    let statusCommit = false;
    if (plan.task._tag === "Feature" && thisRun > 0) {
      const stems = approvedStems(plan.task, yield* Ref.get(outcomes));
      if (stems.length > 0) {
        statusCommit = yield* issueStore
          .markLanded({
            repo: repoRoot,
            branch: plan.branch,
            folder: plan.task.folder,
            stems,
            index: statusIndexPathFor(config.runtimeRoot, plan.slug),
          })
          .pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.succeed(false),
                onSome: () =>
                  reporter
                    .emit({ _tag: "StatusCommitted", stems, branch: plan.branch })
                    .pipe(Effect.as(true)),
              }),
            ),
            Effect.catchAll((error) =>
              reporter
                .emit({
                  _tag: "Warned",
                  detail: `could not mark ${stems.join(" ")} Done on '${plan.branch}': ${markLandedFailure(error)}`,
                })
                .pipe(Effect.as(false)),
            ),
          );
      }
    }

    // What the push carried, which is not what was counted above once the
    // status commit exists: it stands on top of the agent's commits, so it is
    // one more on both counts. The pre-status `thisRun` is still what gated it
    // — that gate is about agent work and must not start counting bookkeeping.
    const statusCommits = statusCommit ? 1 : 0;
    yield* repo.push(push);
    yield* reporter.emit({
      _tag: "CommitsPushed",
      thisRun: thisRun + statusCommits,
      sinceBoundary: sinceBoundary + statusCommits,
      statusCommit,
    });
    return "pushed";
  });
