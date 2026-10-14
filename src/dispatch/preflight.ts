// Dispatch preflight: the dispatcher itself is no older than its base — asked
// only when this dispatch is self-hosted (T60) — the docker daemon is
// reachable, the image is present, and `gh` is authenticated — all typed
// (matrix row 2), all still holding nothing.
//
// `dockerProbe`, `imageProbe`, and `ghProbe` are `doctor`'s own probes, called
// against the same chokepoint — a second set here would drift, and the set
// that drifts is the one nobody runs. `imageProbe` takes the image, the repo
// root, and the build command — the root because the dependency files it
// hashes are the ones under the repo this dispatch is for, named rather than
// asked of git (T27), and the command because the one advisory this shows has
// to name something the dispatcher can run (T30).
//
// `gh` auth joined them with `Forge` (T12), and it is the same probe again for
// the same reason: a run ends at a PR, so a host whose `gh` cannot open one is
// refused here — before the lock, the clone, and the twenty minutes of agent
// time that would otherwise be spent finding out.
import { resolve } from "node:path";
import type { FileSystem, Path } from "@effect/platform";
import type { CommandExecutor } from "@effect/platform/CommandExecutor";
import { Data, Effect, Option } from "effect";
import type { DockerUnavailable, GhUnavailable, ImageUnavailable } from "../doctor/probes.ts";
import { dockerProbe, ghProbe, imageProbe } from "../doctor/probes.ts";
import type { DispatcherFreshness } from "../git/dispatcher-freshness.ts";
import { Git, type GitShape } from "../git/git.ts";
import type { RepoSlug } from "../git/repo-slug.ts";
import { Reporter } from "../reporter.ts";
import { stripOriginPrefix } from "./guards.ts";

// T44: a dispatch whose `HEAD` is missing a package commit its base already
// has would run different semantics than the base expects and say nothing
// about it — refused rather than warned (see the ticket for the bash evidence
// this rests on). `detail` is the line the entrypoint renders, exactly like
// every other typed refusal here.
export class StaleDispatcher extends Data.TaggedError("StaleDispatcher")<{
  readonly detail: string;
}> {}

// The current worktree's own branch, read the way `guards.ts`'s
// `branchNotCheckedOut` reads it — `resolve`d, because `findRepoRoot` and a
// linked worktree's path are not guaranteed to be spelled identically. `None`
// on a detached HEAD, and on a `Git` that could not answer at all: this is
// flavour for the refusal's message, not a second ancestry question, so a
// failure here degrades to "we don't know" rather than escaping as a
// `GitError` preflight has no typed refusal for.
const currentBranch = (git: GitShape, repoRoot: string): Effect.Effect<Option.Option<string>> =>
  git.worktrees(repoRoot).pipe(
    Effect.orElseSucceed(() => []),
    Effect.map((worktrees) => {
      const here = worktrees.find((worktree) => resolve(worktree.path) === resolve(repoRoot));
      return here === undefined ? Option.none<string>() : here.branch;
    }),
  );

const missingCommitDetail = (
  base: string,
  missing: ReadonlyArray<string>,
  branch: Option.Option<string>,
): string =>
  `this dispatcher's source here is missing ${missing.length} commit(s) already on '${base}' (e.g. ${missing[0]}) — dispatching now would run an older dispatcher than '${base}' expects. You are on '${Option.getOrElse(branch, () => "a detached HEAD")}' — bring it current first (git checkout ${stripOriginPrefix(base)}), then re-run`;

// The refusal, and the escape hatch (T44): mutating the operator's checkout is
// not this tool's act ("Creating branches is the dispatcher's act, never
// ours" — `guards.ts`), so this instructs and does not repair either.
const staleDispatcherRefusal = (
  base: string,
  missing: ReadonlyArray<string>,
  branch: Option.Option<string>,
): StaleDispatcher =>
  new StaleDispatcher({
    detail: `${missingCommitDetail(base, missing, branch)}, or pass --allow-stale-dispatcher to proceed anyway (recorded on the run's ledger row)`,
  });

const staleDispatcherOverrideWarning = (
  base: string,
  missing: ReadonlyArray<string>,
  branch: Option.Option<string>,
): string =>
  `overriding the stale-dispatcher refusal (--allow-stale-dispatcher, recorded on the run's ledger row) — ${missingCommitDetail(base, missing, branch)}`;

export const preflight = (
  image: string,
  repoRoot: string,
  imageBuildCommand: string,
  base: string,
  // Whether this dispatch serves the repo the package lives in (T60), decided
  // at the composition root and arriving as a value — the freshness block
  // below is the only thing that reads it, and `doctor`'s probe 10 reads the
  // same one answer, so the two cannot disagree.
  selfHosted: boolean,
  allowStaleDispatcher: boolean,
  // Which repo `ghProbe` reports on below (T39) — resolved above this call,
  // at the composition root, like every other host fact this preflight asks
  // about. It carries no bearing on the refusal: `ghProbe` still refuses on
  // auth alone, and this is only what its `ok` row would name.
  forgeRepo: Option.Option<RepoSlug>,
): Effect.Effect<
  void,
  DockerUnavailable | ImageUnavailable | GhUnavailable | StaleDispatcher,
  Reporter | CommandExecutor | FileSystem.FileSystem | Path.Path | Git
> =>
  Effect.gen(function* () {
    const reporter = yield* Reporter;
    const git = yield* Git;

    // First, and before any docker or network work (09), and only when this
    // dispatch is self-hosted (T60): the guard exists because while the tool
    // dispatches into itself the checked-out branch decides which dispatcher
    // runs (09), and under the shim the dispatcher is a pinned SHA no branch
    // of the served repo chooses — so there is nothing to be stale relative
    // to. Pointed at another repo the pathspec leaves it and git exits 128,
    // which reads as `BaseUnresolvable`, so what the skipped block used to
    // produce was a false "git fetch" warning on every adopter dispatch
    // (19 §4). No `rev-list`, no `Warned`, no refusal — and
    // `--allow-stale-dispatcher` has nothing to override here.
    //
    // A stale dispatcher produces a plausible success whose semantics nobody
    // can recover afterwards, which is worse than anything below it can do.
    // The base is resolved as this clone already has it — this check fetches
    // nothing, ever (T44), and since T70 it has nothing left to fetch: the
    // dispatch's own `git fetch origin` ran immediately above it, so what the
    // clone has is what `origin` holds. So a `GitError` here (only a missing
    // git binary can raise one) degrades to the same `BaseUnresolvable`
    // reading `doctor`'s probe gives a base it could not resolve, rather than
    // a refusal of its own: this preflight has no typed error for "git itself
    // is broken", and `gitProbe` is where that is diagnosed properly.
    if (selfHosted) {
      const verdict: DispatcherFreshness = yield* git
        .dispatcherFreshness({ repo: repoRoot, base })
        .pipe(Effect.orElseSucceed((): DispatcherFreshness => ({ _tag: "BaseUnresolvable" })));
      switch (verdict._tag) {
        case "Current":
          break;
        // Not a refusal (T44): a base this clone cannot read is the
        // operator's to fix, and `doctor`'s probe already warns about it
        // rather than failing — refusing here would stop a dispatch on a stale
        // clone rather than a stale dispatcher.
        //
        // The advice is the configured base and not a fetch, for the same
        // reason `resolveBaseSha`'s refusal dropped its own fetch advice
        // (T70): the dispatch made that fetch two steps above, so a base that
        // does not resolve is not one more `git fetch` away. `doctor`'s row
        // keeps the fetch advice, because `doctor` never makes one.
        case "BaseUnresolvable":
          yield* reporter.emit({
            _tag: "Warned",
            detail: `'${base}' does not resolve in this clone even after fetching origin, so the dispatcher-freshness check has nothing to compare against — check the configured base`,
          });
          break;
        case "Stale": {
          const branch = yield* currentBranch(git, repoRoot);
          if (allowStaleDispatcher) {
            yield* reporter.emit({
              _tag: "Warned",
              detail: staleDispatcherOverrideWarning(base, verdict.missing, branch),
            });
          } else {
            return yield* staleDispatcherRefusal(base, verdict.missing, branch);
          }
          break;
        }
      }
    }

    yield* dockerProbe;
    const rows = yield* imageProbe(image, repoRoot, imageBuildCommand);
    // In `doctor`'s own order (probe 6, after the image): a dispatcher fixing
    // one refusal meets the next in the sequence the diagnostic screen shows.
    yield* ghProbe(forgeRepo);
    // The ok rows are `doctor`'s screen, not a dispatch's. An image built
    // against different dependency contents is the one advisory a dispatcher
    // needs mid-run and never a refusal — a stale image still runs
    // (`run.sh:993-996`). An image that declares no inputs shows nothing here:
    // it is a check that is not running, which is `doctor`'s to report and
    // nothing this run can act on (T30).
    yield* Effect.forEach(
      rows.filter((row) => row.status === "warn"),
      (row) => reporter.emit({ _tag: "Warned", detail: row.detail }),
      { discard: true },
    );
  });
