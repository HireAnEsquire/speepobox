// What a resuming run's implement pass is handed beyond its prompt (T17,
// widened to every resume by T66): what the branch's PR says today, fetched
// **best-effort**.
//
// It lives here rather than inside `AgentCli` for the reason the description
// pass degrades at its caller (`pr.ts`): asking the forge is a dispatch step's
// job, and "the view failed, carry on" is policy that belongs beside the run
// rather than inside the seam that runs a CLI in a container. It runs inside
// the run's scope and under the run log's reporter, so the warning a failure
// leaves is in the file a dispatcher reads afterwards.
//
// **The title and body only** — never review comments (run.sh's `gh pr view`
// fetch asks for `--json title,body` and nothing else).
// Reviewer-authored text steering an unattended agent is a prompt-injection
// channel; the human reads the comments and folds what matters into
// `--feedback`, which is text they wrote.
import { Effect, Option } from "effect";
import type { PrContext } from "../agent/prompt.ts";
import { Forge } from "../forge/forge.ts";
import type { RepoSlug } from "../git/repo-slug.ts";
import { Reporter } from "../reporter.ts";
import { isResume, type DispatchPlan } from "./plan.ts";

export const prContextFor = (
  plan: DispatchPlan,
  // Which repo the view below names (T39), resolved once at the composition
  // root and passed down like `repoRoot` itself.
  forgeRepo: RepoSlug,
): Effect.Effect<Option.Option<PrContext>, never, Forge | Reporter> =>
  // **Asked on every resume, and on nothing else** (T66, 22 §5). The PR body
  // is what the human read before they wrote the feedback and what the
  // feedback refers to, and that is as true when the spec is still on disk as
  // when it is gone — so the predicate is the identity's, not the arm's. It is
  // not the wider one either: on a fresh dispatch of a branch that already has
  // a PR, the body describes work this run supersedes, which is misleading
  // context rather than missing context. T17 asked on the text arm alone
  // because an ordinary implement prompt had no place to put the section; it
  // has one now, so what is left is the rule rather than that layout.
  !isResume(plan.identity)
    ? Effect.succeedNone
    : Effect.gen(function* () {
        const forge = yield* Forge;
        const reporter = yield* Reporter;
        // Degraded, never fatal: the prompt loses one context section and the
        // task — the thing the run is actually for — is untouched. A forge that
        // cannot answer here would otherwise cost a run that has everything it
        // needs to do the work.
        return yield* forge.prView({ repo: forgeRepo, branch: plan.branch }).pipe(
          Effect.map(Option.map((viewed) => ({ title: viewed.title, body: viewed.body }))),
          Effect.catchAll((error) =>
            reporter
              .emit({
                _tag: "Warned",
                detail: `could not read the PR for '${plan.branch}' (${error.detail}) — the implement pass runs without its title and body`,
              })
              .pipe(Effect.as(Option.none<PrContext>())),
          ),
        );
      });
