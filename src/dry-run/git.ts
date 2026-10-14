// `Git`, recording (T15). Five operations are held back — the clone that makes
// the checkout, the identity written into it, the fetch-back that brings the
// commits home, the push that sends them out, and the hard reset's move of the
// branch (T101) — and everything else on this
// tag is a question about a repository, or the fetch below. So this layer is
// built **over** `GitLive`: the reads are the live reads, not a second set
// that could answer differently, which is what keeps the `--base` chain, the
// merge-base, and every guard that asks git something failing for real.
//
// **`fetch` is the write this layer deliberately does not name** (T70). It
// mutates remote-tracking refs, but it holds nothing and has no release, so
// SPEC §7's rehearsal invariant — no lock, log, container, checkout, branch
// creation, or ledger row — is untouched by it; and the base every plan this
// layer prints is resolved from is resolved out of the refs that fetch brings
// back, so a recorded one would print a plan the run would not use. The spread
// above hands the live function through, and `test/dry-run.test.ts` pins that
// as an identity: recording it is a red test rather than a silent drift.
//
// `setConfig` records although the ticket's table names only the other three:
// it writes into the run's own copy of the repository (T35), and in a
// rehearsal that copy was never cloned, so a real write would fail against a
// path this run deliberately did not create — a refusal invented by the
// rehearsal rather than one a dispatch would meet.
//
// The reporter is the one this layer was built over, because none of these
// operations carries an ambient one in its signature (a tag whose methods ask
// for a service is mechanism through a domain seam, `git/git.ts`). In a
// rehearsal that is the console, which is where a dry run is read.
import type { CommandExecutor } from "@effect/platform";
import { Effect, Layer, Option } from "effect";
import { Git, GitLive, type GitShape } from "../git/git.ts";
import { Reporter, type ReporterShape } from "../reporter.ts";
import { recorded } from "./record.ts";

export const recordingGit = (live: GitShape, reporter: ReporterShape): GitShape => ({
  ...live,
  clone: ({ source, branch, into }) =>
    recorded(reporter, `clone '${branch}' from ${source} into ${into}`),
  // Both call sites of the fetch-back are recorded by this one arm: the land's
  // trip home and the checkout release's salvage. It answers **success**,
  // because that is what the fetch would have done on the path a rehearsal is
  // rehearsing — a recorded failure would send the release down the rescue
  // arm and print a lost-commits warning about a clone that was never made.
  fetchBack: ({ from, into, branch, onto }) =>
    recorded(
      reporter,
      `fetch refs/heads/${branch} from ${from} onto refs/heads/${onto} in ${into}`,
    ),
  push: ({ from, branch, lease }) =>
    recorded(
      reporter,
      `push refs/heads/${branch} from ${from} to origin${
        lease === undefined
          ? ""
          : ` with --force-with-lease=refs/heads/${branch}:${Option.getOrElse(lease.expect, () => "")}`
      }`,
    ),
  // The hard reset's compare-and-set (T101). The spread above would hand the
  // live one through, and a rehearsal would then **reset the branch for
  // real**; `IssueStoreLive` holds its own `Git`, so T77's status commit, the
  // other caller of this operation, never reaches this layer.
  updateRef: ({ repo, ref, to, from }) =>
    recorded(reporter, `move ${ref} from ${from} to ${to} in ${repo}`),
  setConfig: ({ repo, key, value }) => recorded(reporter, `set ${key} to '${value}' in ${repo}`),
});

export const GitRecordingLive: Layer.Layer<Git, never, CommandExecutor.CommandExecutor | Reporter> =
  Layer.effect(
    Git,
    Effect.map(Effect.all([Git, Reporter]), ([live, reporter]) => recordingGit(live, reporter)),
  ).pipe(Layer.provide(GitLive));
