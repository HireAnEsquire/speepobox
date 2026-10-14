// The reconciler's pure half (SPEC §2): what one run left behind on this host,
// and whether the run that left it is provably dead. **No tag** — the
// classification and the liveness question it asks are plain functions, so
// P4's `gc` reuses them unchanged rather than growing a second staleness rule
// over the same directory. Nothing here reads the filesystem, the daemon, or
// the ledger; `reconcile.ts` gathers the facts and this decides what they mean.
import { Option } from "effect";
import { CONTAINER_PREFIX } from "../dispatch/plan.ts";
import { isProcessAlive, ownerIsAlive } from "../lock/liveness.ts";

// **One parse for docker's stdout, and every query calls it** (§3b): trim
// first, filter second. The asymmetry this closes is a query that tests
// `id.trim() !== ""` and then hands the *untrimmed* id to `docker rm` — it
// passes its own filter and addresses a container by a string with a newline
// in it, which is only ever caught where the ids come from a daemon this
// process did not populate.
export const dockerRows = (stdout: string): ReadonlyArray<string> =>
  stdout
    .split("\n")
    .map((row) => row.trim())
    .filter((row) => row !== "");

// One container dockerd holds for this repo scope. `running` is the third of
// SPEC §4's three conditions; the labels that answer the first are the query's
// (`ownership/labels.ts`), and nothing about them survives into this value.
export interface OwnedSandbox {
  readonly id: string;
  readonly name: string;
  readonly running: boolean;
}

// docker's own state vocabulary, split the safe way round: the states that
// certainly mean *stopped* are listed, and everything else — `running`,
// `paused`, `restarting`, `removing`, and any word a future daemon invents —
// reads as running. The failure this ordering picks is "reported rather than
// reclaimed", which is the one §2 says to prefer.
const STOPPED: ReadonlySet<string> = new Set(["created", "exited", "dead"]);

const isRunning = (state: string): boolean => !STOPPED.has(state.toLowerCase());

// `{{.ID}}\t{{.Names}}\t{{.State}}` rows, through the one parse above — which
// is why there is no "and drop the ones with no id" pass here: a row that
// survives `dockerRows` has been trimmed already, so its first field is the id
// it will be addressed by. Trimming after the filter is what leaves those two
// as different values (§3b).
export const parseOwnedSandboxes = (stdout: string): ReadonlyArray<OwnedSandbox> =>
  dockerRows(stdout).map((row) => {
    const [id = "", name = "", state = ""] = row.split("\t").map((field) => field.trim());
    return { id, name, running: isRunning(state) };
  });

// Which run's wreckage a container is part of. The name is a *key*, never the
// ownership question — that one was answered by the label filter on the query
// (design rule 3), and a container carrying our labels under some other name
// is still ours to account for, so it keys off what it is called.
export const slugOfContainer = (name: string): string =>
  name.startsWith(CONTAINER_PREFIX) ? name.slice(CONTAINER_PREFIX.length) : name;

export interface LockOnDisk {
  readonly path: string;
  // What the file recorded, through T4's parse. `None` is an owner nobody can
  // name — an empty or truncated lock — which reads as a pid that is gone.
  readonly owner: Option.Option<number>;
}

// One run's checkout as this host has it now. The branch is read out of the
// copy's own `.git/HEAD` rather than derived from the slug, because `slugFor`
// is lossy — `feature/foo` and `feature-foo` share a slug — and the recovery
// commands the notice prints are wrong, silently, if they name a ref that does
// not exist. `None` is a directory whose `HEAD` could not be read, which gets
// the notice that needs no branch name rather than a guessed one.
export interface CheckoutOnDisk {
  readonly path: string;
  readonly branch: Option.Option<string>;
}

// `ref: refs/heads/<branch>` — what a clone on a branch writes. A detached
// HEAD holds a bare SHA and matches nothing here, which is `None` and the
// branchless notice, because a SHA is not a ref the fetch can name.
const HEAD_REF = /^ref:\s*refs\/heads\/(.+)$/;

export const branchInHead = (contents: string): Option.Option<string> => {
  const matched = HEAD_REF.exec(contents.trim());
  return matched?.[1] === undefined ? Option.none() : Option.some(matched[1]);
};

// One run's three resources as this host has them now. Every field is optional
// because each of the three outlives the others on some exit path: a `kill -9`
// between the clone and `docker run` leaves a lock and a checkout, a finalizer
// that could not remove a container leaves that alone.
export interface RunWreckage {
  readonly slug: string;
  readonly lock: Option.Option<LockOnDisk>;
  readonly sandbox: Option.Option<OwnedSandbox>;
  readonly checkout: Option.Option<CheckoutOnDisk>;
}

// Reclaim, or report and touch nothing. `Live` and `Kept` both carry the
// sentence that says which evidence refused, because a report nobody can act
// on is why bash's `gc` grew a `--force` nobody trusts — `Live` for a run that
// may still be working, `Kept` for one that finished and left its checkout on
// purpose.
export type Verdict =
  | { readonly _tag: "Reclaimable" }
  | { readonly _tag: "Kept"; readonly detail: string }
  | { readonly _tag: "Live"; readonly detail: string };

// The three conditions of SPEC §4, joined in one place:
//
//   1. **labels match this repo** — already answered, by the query that
//      produced `sandbox`. It filters on both ownership labels and can return
//      nothing else, so re-asking it here off the container's *name* would be
//      the retired prefix sweep wearing a hat (05 Q11).
//   2. **the lock's recorded pid is not alive** — T4's predicate, shared.
//   3. **the sandbox is not running.**
//
// Where there is a lock to ask, (2) answers for the whole run: the dispatcher
// is the only process that ever tears a run down, so a container still up
// under a dead owner is the *common* wreck rather than a live run. The image's
// entrypoint is `sleep infinity`, so dockerd keeps that container up forever
// and nothing but this reconciler will ever remove it — reading (3) as a veto
// there typechecks and leaves the `kill -9` tracer's container on the host
// permanently, which is matrix row 17 going unreclaimed in the one case that
// produces it most.
//
// (3) is what answers when there is no lock to ask. A running container that
// no lock names may belong to a dispatcher this process cannot see — a second
// runtime root, or hae's bash `run.sh` on the same host — and a possibly-live
// run is reported, never reclaimed.
//
// The ledger is not consulted, here or anywhere in the reconciler (§3c): a row
// exists **iff `RunLock` was acquired**, full stop, so a run interrupted
// mid-teardown has an `Interrupted` row on disk *and* all three resources
// still on the host. Reading a row as "this run finished" would leave exactly
// that case's wreckage behind forever, and it is what Ctrl-C at a bad moment
// produces.
//
// **A checkout with no lock beside it is `Kept`: reported, never reclaimed.**
// The lock is the first resource a run takes and the last it releases
// (`run.ts`), so a run killed at any point leaves a lock beside its checkout —
// and a lone checkout is a run that let go of one. Ordinarily that is its own
// release; since T38 it is also a *reclaim* that took the killed run's lock
// and container and could not confirm the commits in its copy are anywhere
// else, which leaves the same shape a pass later. Both are directories
// somebody already declined to delete, so both get this verdict and neither
// gets acted on here. The release keeps the directory whenever the branch does
// not hold the copy's commits afterwards — the fetch-back refused, or it
// reported success and moved nothing (T38) — so those commits are still in
// there and that clone is the only copy of them (`checkout.ts`, 05 Q10).
// Reclaiming it here reads a deliberate keep as wreckage and deletes the work
// minutes later, on an unrelated dispatch of an unrelated branch — bash cleared
// a checkout only on the next dispatch of that same slug, so the person who
// lost the commits was the one who chose to dispatch that branch again; this
// pass sweeps every slug.
// The same state is also what a *successful* fetch-back followed by a failed
// removal leaves, and nothing on disk tells the two apart, so this keeps a
// disposable directory rather than deleting an irreplaceable one — the "report
// rather than reclaim" direction §2 already picks, with P4's `gc` as where a
// human removes what this will not. Nothing new is written to disk to decide
// it: a keep flag is a second answer to "did this run's work survive" that can
// disagree with the fetch that knows, and a run killed before it could write
// one leaves no marker at all, which is the deletion this rule exists to stop.
// The verdict is one run's and not one resource's, so a stopped container
// beside a kept checkout is named in the same report rather than removed under
// it — the same direction again, and `gc` is offered both.
export const classify = (found: RunWreckage): Verdict => {
  if (Option.isSome(found.lock)) {
    const owner = found.lock.value.owner;
    return ownerIsAlive(owner)
      ? { _tag: "Live", detail: `pid ${owner.value} still holds its lock` }
      : { _tag: "Reclaimable" };
  }
  // Asked before the checkout, because both answers touch nothing and a
  // container that may belong to a dispatcher this process cannot see is the
  // more urgent of the two sentences to print.
  if (Option.isSome(found.sandbox) && found.sandbox.value.running) {
    return {
      _tag: "Live",
      detail: `its container '${found.sandbox.value.name}' is running and no lock names an owner`,
    };
  }
  return Option.isSome(found.checkout)
    ? {
        _tag: "Kept",
        detail:
          "no lock lies beside it, and a copy outlives its run's lock only when the commits in it could not be moved back — or, after a reclaim, could not be shown to be anywhere else",
      }
    : { _tag: "Reclaimable" };
};

// The recovery half of every notice about a copy this pass leaves on disk:
// how to find out whether it holds anything, and what to do either way. Shared
// by the two notices below, because they differ in *why* the copy is still
// there and not in what a reader does about it (T38). Built here, where it is
// pure and pinned by a test, rather than in `reconcile.ts` beside the IO.
// `gc --force` ends its own keep sentences with it too (T100).
export const checkoutRecovery = (slug: string, checkout: CheckoutOnDisk): string => {
  // Without a branch name there is no ref to fetch by name, so the commands
  // ask the copy what it is on instead. `--contains` answers the same question
  // the named form does: is this work already somewhere I keep.
  if (Option.isNone(checkout.branch)) {
    return `The copy is at ${checkout.path}, and its HEAD could not be read, so these work without a branch name.

To see whether it holds anything you do not already have:
  git fetch ${checkout.path} HEAD
  git branch --contains FETCH_HEAD

If that lists a branch, the work is already there and the copy is safe to delete:
  rm -rf ${checkout.path}
If it lists nothing, the work is only in the copy — keep it first:
  git branch ${slug}-from-run FETCH_HEAD`;
  }

  const branch = checkout.branch.value;
  return `The copy is at ${checkout.path}.

To see whether it holds anything that is not already on '${branch}':
  git fetch ${checkout.path} refs/heads/${branch}:refs/heads/${branch}-from-run
  git log --oneline ${branch}..${branch}-from-run

If that lists nothing, the work is already on '${branch}' and the copy is safe to delete:
  rm -rf ${checkout.path}
If it lists commits, they exist only in the copy — merge or cherry-pick from
'${branch}-from-run', then delete the copy.`;
};

// The whole notice, not a sentence: a kept copy is the one piece of wreckage a
// dispatcher has to act on, and "no lock lies beside it" — the evidence that
// decides the verdict — tells nobody what to do about it. Two states produce
// this and nothing on disk tells them apart (a move-back that *neither*
// destination would take, and one that worked before the removal failed), so
// rather than guess, this hands over the commands that answer which.
export const keptCheckoutNotice = (slug: string, checkout: CheckoutOnDisk): string =>
  `'${slug}' kept its own copy of the repository, and nothing was removed.

speepobox gives every run a private copy of this repository to work in, and moves the commits
back when the run ends — onto the branch the run was given, or failing that onto a branch of
the run's own. A copy is kept when neither of those would take the commits, because then it is
the only place that work exists; when one of them did and the copy could not be removed
afterwards; or when the run was killed before it could try and nothing here could say the
commits in it are somewhere else.

${checkoutRecovery(slug, checkout)}`;

// And the notice the *reclaim* path owes when its read will not authorize the
// removal (T38). This is a run that is provably dead — a lock naming an owner
// that is not alive — which is exactly the case where its release never ran,
// so nothing has moved these commits anywhere and the wreckage scan cannot
// establish otherwise. Its container and its lock still go; the directory
// holding commits nothing else has does not, and the reason it stayed is what
// git said rather than a guess about it.
export const unmovedCheckoutNotice = (
  slug: string,
  checkout: CheckoutOnDisk,
  // What the containment read found, in git's own terms — the whole of what
  // makes this sentence a fact rather than a policy.
  found: string,
): string =>
  `'${slug}' left its own copy of the repository behind, and it was **not** removed: nothing here
could say the commits in it are anywhere else.

speepobox gives every run a private copy of this repository to work in, and moves the commits
back when the run ends — but this one was killed before it got there, so that move never
happened. A copy is removed on this pass only when a read says the commits in it are already on
a branch here, and this read said otherwise: ${found}

${checkoutRecovery(slug, checkout)}`;

// What was found, as a sentence rather than a count: the report is the whole
// output of a reconcile, and "3 items" is not something a dispatcher can act
// on. Ordered the way a run releases — sandbox, checkout, lock.
export const describeWreckage = (found: RunWreckage): string =>
  [
    Option.map(found.sandbox, (sandbox) => `container '${sandbox.name}'`),
    Option.map(found.checkout, (checkout) => `checkout ${checkout.path}`),
    Option.map(found.lock, (lock) => `lock ${lock.path}`),
  ]
    .flatMap((part) => Option.toArray(part))
    .join(", ");

// The one piece of wreckage T20's claim and T21's witness leave rather than
// clear (§3a): a `.evicting` link is a second name for the lock being evicted,
// removed by the eviction that took it — so a run killed mid-eviction strands
// one, and a stranded witness refuses every later eviction of the same corpse.
// A lock directory that accumulates them is one where eviction wedges.
export const WITNESS_SUFFIX = ".evicting";

// `<slug>.pid.<owner>.evicting`, built by `lock/witness.ts` and recognized
// here. Anything shaped otherwise is not a witness and is left alone. *Which*
// lock it names is not a fact anybody needs: the rule below asks about the
// dispatch holding the witness, not about the corpse underneath it (T26).
export const isEvictionWitness = (entry: string): boolean =>
  entry.endsWith(WITNESS_SUFFIX) && entry.slice(0, -WITNESS_SUFFIX.length).lastIndexOf(".") > 0;

export interface EvictionWitness {
  readonly path: string;
  // The dispatches standing behind it, as the markers beside it name them
  // (`lock/witness.ts`). Plural because a marker is per *eviction* rather than
  // per process: the loser of a link writes one too, and one a killed loser
  // never took back can lie beside a live evictor's.
  readonly evictors: ReadonlyArray<number>;
}

// **A witness whose evictor is not alive is debris, whether or not the lock it
// names is still there** (T26). One sentence for both halves of the sweep:
// T8's case — the lock gone and the corpse's pid dead — is a witness whose
// evictor died after it removed the lock, and it falls out of this rather than
// sitting beside it.
//
// The evictor is the *only* thing asked, because it is the only thing that
// answers. Reading the witness itself says what the corpse was, never who is
// evicting it — the witness is a second name for the corpse file — so a rule
// over the corpse's pid cannot tell a wedged slug from an eviction in flight,
// and one over the lock's presence sweeps a live eviction's witness and hands
// that corpse to two dispatches, which is what T21 exists to prevent. The
// marker is written before the link and removed with it, so "no live evictor"
// is exactly "nobody is inside that bracket".
//
// Both directions of the pid question are the same gamble the lock itself
// takes (`liveness.ts`): a recycled pid reads as alive, which reports rather
// than reclaims, and is why a marker whose dispatch is gone is swept on the
// pass that first sees it rather than left to grow old.
export const isDebris = (witness: EvictionWitness): boolean =>
  !witness.evictors.some(isProcessAlive);
