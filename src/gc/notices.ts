// What `gc --force` says about each thing it did or declined to do (T100):
// pure sentences over values, pinned by `test/gc.test.ts`, kept apart from the
// IO in `force.ts` as `wreckage.ts` keeps the reconciler's.
//
// Every sentence about a copy left on disk ends in the recovery a reader acts
// on — `checkoutRecovery`, the reconciler's — because "skipped" alone is what
// made bash's `--force` a flag nobody trusted. The *why* is gc's own: this is a
// human's explicit act, not a preflight, so the words say what gc tried.
import { Option } from "effect";
import {
  branchAttemptSaid,
  destinationsTried,
  nothingLanded,
  type RescueReason,
  rescueBecause,
  rescueDidNotLand,
  type Unmoved,
} from "../dispatch/checkout.ts";
import { type CheckoutOnDisk, checkoutRecovery } from "../reconcile/wreckage.ts";
import type { GcLeftoverKind } from "./snapshot.ts";

// The one line every skip opens with, so a script can grep for it.
export const skipLine = (slug: string, detail: string): string => `skip ${slug} — ${detail}`;

// A copy whose HEAD names no branch — detached, or unreadable. There is no ref
// to move its commits onto, so the salvage is never asked, and the recovery is
// the branchless one.
export const detachedCheckoutNotice = (slug: string, checkout: CheckoutOnDisk): string =>
  `${skipLine(slug, "its copy's HEAD names no branch (detached, or unreadable), so there is nothing to move its commits onto")}

The copy was **not** removed. ${checkoutRecovery(slug, { ...checkout, branch: Option.none() })}`;

// A copy whose branch this repo cannot read is handed to the salvage like any
// other: the salvage itself never recreates a branch, and sends such a copy to
// a rescue (T107).

export const wentHomeLine = (slug: string, branch: string): string =>
  `removed checkout ${slug} (its commits are on '${branch}')`;

export const rescuedLine = (
  slug: string,
  branch: string,
  onto: string,
  because: RescueReason,
): string =>
  `removed checkout ${slug} — ${rescueBecause(branch, because)} — they are on '${onto}' now: merge or cherry-pick from there, or delete it if the work was already merged`;

// Why the salvage kept the copy, in gc's own register: gc is the one that
// just tried, so it says so, and folds in the same two evidence sentences the
// run's own ends use (`checkout.ts`, narrowed by T98).
const gcKeptItBecause = (branch: string, why: Unmoved): string => {
  switch (why._tag) {
    case "Unverified":
      return `gc tried to move them onto '${branch}'.
${nothingLanded(branch, why.tip)}`;
    case "RescueUnverified":
      return `gc tried to move them ${destinationsTried(branch, why.home, "the run's")}.

${rescueDidNotLand(branch, why)}`;
    case "Refused": {
      const alsoTried = Option.match(why.onto, {
        onNone: () =>
          `A branch of the run's own could not even be named: the copy's own HEAD would not
resolve, so there was no commit to name one after.`,
        onSome: (name) =>
          `Putting them on '${name}' instead — a branch of the run's own, named after the
commits — was tried too, and that did not work either.`,
      });
      return `gc tried to move them ${destinationsTried(branch, why.home, "the run's")}, and
${why.home._tag === "Refused" ? "neither went through" : "that did not go through"}, so that copy is still the only place its work exists.

git said: ${branchAttemptSaid(why.home)}

${alsoTried}

git also said: ${why.rescue.detail}`;
    }
  }
};

// A `Kept` salvage: skipped loudly, never discarded.
export const keptSalvageNotice = (
  slug: string,
  checkout: CheckoutOnDisk,
  branch: string,
  why: Unmoved,
): string =>
  `${skipLine(slug, "nothing could move the commits in its copy anywhere else, so the copy was **not** removed")}

${gcKeptItBecause(branch, why)}

${checkoutRecovery(slug, checkout)}`;

// A removal that failed after the salvage authorized it: the commits are
// somewhere else, read a moment ago, so the directory is a human's `rm -rf`.
export const checkoutRemovalFailed = (path: string, landed: string, error: string): string =>
  `could not remove the checkout at ${path} (${error}) — its commits are on '${landed}', read a moment ago, so it is safe to delete by hand: rm -rf ${path}`;

// The leftovers (T109): each removed only after its witness is asked again,
// right before the removal.
export const removedLeftoverLine = (kind: GcLeftoverKind, path: string): string =>
  `removed ${kind} ${path}`;

// The listing's snapshot said dead; the question asked again says otherwise.
export const leftoverAliveLine = (path: string, pid: number): string =>
  `skip ${path} — its process (pid ${pid}) is running`;

// A pid-less editor directory carries no witness either way, and holds the
// dispatcher's own text: a skip, and the removal is a human's.
export const unwitnessedEditorNotice = (path: string): string =>
  `skip ${path} — it predates pid-named editor directories, so gc cannot tell whether a dispatcher is still editing in it, and it was **not** removed. If nobody is, delete it by hand: rm -rf ${path}`;

export const leftoverRemovalFailed = (path: string, error: string): string =>
  `could not remove ${path} (${error}) — delete it by hand: rm -rf ${path}`;
