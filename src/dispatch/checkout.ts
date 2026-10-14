// The run's second resource (SPEC §4): a self-contained clone of the branch
// under the runtime root, acquired inside the same `Scope` as the lock and
// after it, so release reverses the two for free. Not a `git worktree` — a
// linked worktree's `.git` file points at the host repo's absolute path, which
// does not exist inside the sandbox T6 mounts this into (`run.sh:1255-1269`).
//
// **The release is derived, not flagged** (05 Q10). It always attempts the
// fast-forward fetch-back from the clone, and keep-vs-delete falls out of
// whether the commits made it home — the rule `run.sh:1236-1247` already
// implements, minus the mutable state. There is no keep flag here and there
// must never be one: a flag is a second answer to "did this run's work
// survive" that can disagree with the fetch that actually knows. At this
// ticket no commits exist yet, so the fast-forward is a real one over zero
// commits and the checkout is deleted; T11 only makes the commits real.
//
// **The salvage tries the branch it was given, then a branch of its own, and
// keeps the clone only when neither works** (T29). `git fetch` refuses a
// non-fast-forward update, but it does not refuse to *create* a ref — the
// fast-forward check applies only to refs already present — so the exact case
// that cannot go home lands unconditionally on a name no ref holds yet. That
// is one more question in the derived chain and not a new kind of answer:
// keep-vs-delete still falls out of what the fetches did, there is still no
// flag, and nothing above the release records an opinion for it to read.
//
// **The salvage is one function and both ends of the run call it** (T28). It
// is a question about a directory — *where did the commits in this clone end
// up* — and the two callers differ only in what they do with the answer: the
// release warns and swallows, because a finalizer that fails becomes a defect,
// and the acquire refuses, because a dispatch that cannot clear its own path
// has not started. A second copy of the two fetches would be a second answer to
// the same question, and the one nobody watches run is the one that drifts.
//
// **The salvage reads before it reports** (T32). A refused fast-forward is not
// proof the commits are homeless: git refuses one because the histories
// disagree and one because the fetch would rewind a branch that has moved on
// past this copy — and the second is a copy whose commits are already home.
// Treating both as the rescue's case mints refs holding nothing and, worse,
// tells a human their commits are not on a branch that has them. So the
// question is asked of the repo before a rescue is minted, and the answer is
// `WentHome`.
//
// **A removal is authorized by a read** (T38). T32 asked the containment
// question only where the fetch had refused; on the other arm the salvage
// answered `WentHome` on the strength of what `fetchBack` *returned*, and the
// caller then deleted the directory those commits were in. A fetch reporting
// success and the commits being reachable in the destination are two different
// propositions, and it is the second an irreversible `rm -rf` depends on — so
// the question is asked once, after either fetch attempt, and a success that
// moved nothing keeps the copy instead of taking it. That is a different
// situation from a refused fast-forward and gets its own sentences: nothing
// was refused, so there is no git error to quote and no reason to mint a
// rescue.
//
// **Every** destination, not just the branch: the rescue's fetch is read about
// too, before the removal it would authorize. T38 scoped its own work to the
// two paths answering `WentHome` and left this arm on its acceptance criteria,
// which froze the refused path as T32 wrote it; the read below adds to that
// path rather than altering it, and it is the arm where trusting a return
// value costs most. A rescue is reached only because the branch already
// refused, so by then the copy is the sole known home of the work and a
// success that moved nothing would take the directory on the strength of a ref
// that was never written.
//
// **A rescue the release performed reaches the run's ledger row** (T31), and
// through the slot the verdict and the PR already travel by: a finalizer has
// no return value, so `rescued` is where the release leaves the one fact the
// row cannot derive. The run's outcome is untouched — T29's rule that the
// rescue decides *where the commits live, never whether the run succeeded*
// still holds — and the salvage on the way *in* writes nothing here, because
// the commits it moves belong to the dead run whose row was written long ago.
//
// **The release never fails the scope** (design rule 4, matrix row 18): a
// failing Effect finalizer becomes a defect and would mask the run's own
// error, so a fetch-back that will not fast-forward warns loudly, keeps the
// directory, and swallows. The rescue is held to the same rule — a rescue that
// cannot be written is exactly as loud as a fetch that could not go home, and
// no louder. **The run's outcome does not change either way**: a run whose
// work did not reach the branch it was given has not done what it was asked,
// and the rescue decides where the commits live, never whether the run
// succeeded.
import { userInfo } from "node:os";
import { FileSystem } from "@effect/platform";
import { Effect, Either, Option, Ref, Schema, type Scope } from "effect";
import { Git, GitError } from "../git/git.ts";
import { RepoUrl } from "../git/repo-url.ts";
import { Reporter } from "../reporter.ts";
import { type DispatchPlan, type HardReset, shortSha } from "./plan.ts";

// The branded parse is the only door into `clone` and `fetchBack` (SPEC §9,
// invariant 2), so every local path the run hands them — this module's two,
// and the land's fetch-back, which imports this rather than spelling it a
// second time — goes through it exactly as a remote would. There is no
// string-typed second entrance for a URL to arrive by with its credentials
// still attached.
export const repoUrl = (location: string): Effect.Effect<RepoUrl, GitError> =>
  Schema.decode(RepoUrl)(location).pipe(
    Effect.mapError(
      (error) =>
        new GitError({ detail: `'${location}' is not a usable repo location: ${error.message}` }),
    ),
  );

// The email a dispatch commits under when the dispatching dev's config names
// none (`run.sh:1454`). A noreply address rather than a guess at one: an
// invented address is a real mailbox belonging to somebody else.
const FALLBACK_EMAIL = "bessemer@users.noreply.github.com";

// And the name, when the config names none: the host user this dispatch is
// running as (`run.sh:1453`'s `id -un`, without the child process).
//
// **A host read, and the one this package does outside its composition root**
// (AGENTS.md). It is here rather than threaded down because the value it
// falls back *from* is `git config` run in a repo — an ordinary `Git` read
// with a repository to ask — and threading a parameter through `dispatchCli`,
// `dispatch`, `planFor`, and `runInScope` for the case where that read answers
// nothing would put a host fact on four signatures to serve one fallback
// (T35). It reads the host, so it runs when the effect runs and not when it is
// built, for the reason `inRepo`'s `resolve` is suspended (T32): describing an
// operation may not reach the host, only running it may.
const hostUsername = Effect.sync(() => userInfo().username);

// The rescue's destination, **named from the commits and not from the clock**
// (T29). Two consecutive failed runs on one branch leave two rescue branches,
// which is right — they are different work — and a rerun that somehow produced
// the same tip finds the ref already at that SHA, so the fetch is a no-op and
// the operation is idempotent rather than collision-prone. A timestamp would
// have to be threaded from `bin.ts` into a finalizer (host reads live at the
// composition root) and would make neither of those true. It is a branch in
// `refs/heads/` on purpose: a ref hidden under a namespace of ours is one the
// human never sees and so never merges.
const SHORT_SHA = 7;

const rescueBranch = (branch: string, tip: string): string =>
  `${branch}-from-run-${tip.slice(0, SHORT_SHA)}`;

// Where the commits in a checkout directory ended up, and the whole of what
// either caller learns about it (T28). There is no fourth answer and no
// "probably": the fetches are what decide, so a shape with a boolean beside
// them would be the flag this module forbids, arriving by a different door.
//
// `WentHome` is **both** ways the commits reach the branch (T32) — this fetch
// moved them, or the branch was already holding them from an earlier one. A
// fourth arm for the second would be a ledger value meaning what an existing
// one means: for every consumer the commits are on the branch, the copy is
// finished with, and there is nothing to tell a human.
//
// `Kept` carries **why** the commits are still only in the copy, because the
// two ways of arriving there are two different situations and a reader acts on
// them differently (T38). Nothing here is rendered: the release tells the
// dispatcher about a run that just ended and the acquire about one that ended
// some time ago, and those are not the same sentence.
//
// `Refused` is git saying no, twice, and it carries the three things those
// sentences need — what git said about the branch, the name the rescue would
// have used if it could be named at all, and what git said about that.
// `Unverified` is the other one: the fetch *returned success* and the branch
// does not hold the commits afterwards, so there is no git error to quote and
// nothing was refused. It carries the tip the containment question was asked
// about, absent when the copy could not be read for one at all.
//
// `RescueUnverified` is the same failure one destination over: the branch
// refused, so a rescue was minted and *that* fetch answered success without
// moving anything. It is its own arm rather than either of the others because
// it is the only one with a git error to quote **and** a read to report — the
// first destination said no out loud, the second said yes and did nothing. Its
// tip and its destination are plain strings, not options: reaching this arm at
// all means the copy resolved a tip, because that tip is what the rescue
// branch is named after.
//
// `home` on both rescue arms is what happened to the branch attempt, and
// there are two answers since T107: the fetch ran and git refused it, or the
// branch could not be read and no fetch onto it ran at all. The second carries
// the read's words and no `GitError` of a fetch, because there was none.
export type BranchAttempt =
  | { readonly _tag: "Refused"; readonly error: GitError }
  | { readonly _tag: "Unread"; readonly detail: string };

export type Unmoved =
  | {
      readonly _tag: "Refused";
      readonly home: BranchAttempt;
      readonly onto: Option.Option<string>;
      readonly rescue: GitError;
    }
  | { readonly _tag: "Unverified"; readonly tip: Option.Option<string> }
  | {
      readonly _tag: "RescueUnverified";
      readonly home: BranchAttempt;
      readonly onto: string;
      readonly tip: string;
    };

// Why a rescue was minted rather than the branch used (T107). Every sentence
// about a rescue says it, and only the run log hears it: the ledger row
// records where the commits are (`rescuedOnto`), not why.
export type RescueReason =
  | { readonly _tag: "Refused" }
  | { readonly _tag: "BranchUnread"; readonly detail: string };

export type Salvage =
  | { readonly _tag: "WentHome" }
  | { readonly _tag: "Rescued"; readonly onto: string; readonly because: RescueReason }
  | { readonly _tag: "Kept"; readonly why: Unmoved };

// The clause every rescue sentence carries, at the release, the acquire, and
// `gc --force`: why the commits are not on the branch they were for.
export const rescueBecause = (branch: string, because: RescueReason): string =>
  because._tag === "Refused"
    ? `its commits would not go onto '${branch}'`
    : `'${branch}' could not be read here (${because.detail}), so its commits were not sent there`;

// Which destinations a rescue arm tried, said the same way by every renderer:
// both, or — when the branch could not be read — the run's own alone.
export const destinationsTried = (branch: string, home: BranchAttempt, whose: string): string =>
  home._tag === "Refused"
    ? `onto '${branch}', then onto a branch of ${whose} own`
    : `onto a branch of ${whose} own, because '${branch}' could not be read here`;

// What git said about the branch attempt: the fetch's refusal, or the read's.
export const branchAttemptSaid = (home: BranchAttempt): string =>
  home._tag === "Refused" ? home.error.detail : home.detail;

// What the salvage is about: a copy on disk and the branch it is for — the two
// facts it reads, and all a caller holding no plan has (T98). A `DispatchPlan`
// is one, so the run's own two call sites pass theirs whole.
export type SalvageTarget = Pick<DispatchPlan, "branch" | "checkoutPath">;

// The evidence an `Unverified` keep has, which is not the evidence a refused
// one has (T38): git said yes, so there is no error of its to quote and no
// second destination it declined. What a reader needs instead is the question
// that was asked afterwards and the answer it gave — the same question at both
// ends of the run, so it is written once and both sentences fold it in. The
// tipless form is a copy that could not be read for a commit at all, which is
// kept for the reason every unreadable copy is: from out here it looks exactly
// like one holding work.
export const nothingLanded = (branch: string, tip: Option.Option<string>): string =>
  Option.match(tip, {
    onNone: () =>
      `git reported the move onto '${branch}' went through, but the copy
could not then be read for the commit it is on — so nothing here can say the work
reached the branch, and the copy was kept rather than removed.`,
    onSome: (at) =>
      `git reported the move onto '${branch}' went through, and
'${branch}' here does not hold ${at},
the commit that copy is on. Whatever the fetch returned, the work did not reach the
branch, so the copy was kept rather than removed.`,
  });

// And the evidence a `RescueUnverified` keep has, which is both of the others'
// at once: the branch's refusal in git's own words, then the rescue's silent
// one in the read's. Written once and folded into both sentences for the same
// reason `nothingLanded` is — what was asked and what it answered does not
// change with which end of the run is asking.
export const rescueDidNotLand = (
  branch: string,
  why: Extract<Unmoved, { _tag: "RescueUnverified" }>,
): string =>
  `${
    why.home._tag === "Refused"
      ? "The branch would not take them:"
      : `'${branch}' could not be read here, so they were not sent there:`
  }

git said: ${branchAttemptSaid(why.home)}

So they were put on '${why.onto}' instead — a branch named after the commits — and git
reported that move went through. But '${why.onto}' here does not hold ${why.tip},
the commit that copy is on, so the work reached ${
    why.home._tag === "Refused" ? "neither destination" : "no destination"
  }. Whatever ${why.home._tag === "Refused" ? "the second" : "that"}
fetch returned, nothing was deleted: that copy is still the only place the work exists.`;

// Why a *dead* run's copy is still there, said on the way in, where the
// dispatch is about to stop over it. The refused arm names both destinations
// and quotes git for each; the unverified one has neither to name, and the
// rescue-unverified one has the first of each.
const deadRunKeptItBecause = (plan: DispatchPlan, why: Unmoved): string => {
  if (why._tag === "Unverified") {
    return `This dispatch tried that move again before cloning.
${nothingLanded(plan.branch, why.tip)}`;
  }
  if (why._tag === "RescueUnverified") {
    return `This dispatch tried that move again before cloning — ${destinationsTried(plan.branch, why.home, "the dead run's")}.

${rescueDidNotLand(plan.branch, why)}`;
  }
  const alsoTried = Option.match(why.onto, {
    onNone: () =>
      `A branch of that run's own could not even be named: the copy's own HEAD would not
resolve, so there was no commit to name one after.`,
    onSome: (name) =>
      `Putting them on '${name}' instead — a branch of that run's own, named after the
commits — was tried too, and that did not work either.`,
  });
  return `This dispatch tried that move again before cloning — ${destinationsTried(plan.branch, why.home, "the dead run's")} — and ${why.home._tag === "Refused" ? "neither went through" : "that did not go through"}, so that copy is still the
only place its work exists. A directory git cannot read at all lands here too, and is kept for
the same reason: from out here it looks exactly like one holding work.

git said: ${branchAttemptSaid(why.home)}

${alsoTried}

git also said: ${why.rescue.detail}`;
};

// And the same question at the other end of the run, about the copy this run
// itself made — a different sentence for the same reason the two callers are
// two callers (T28): one is about a run that just ended, the other about one
// that ended some time ago.
const thisRunKeptItBecause = (plan: DispatchPlan, why: Unmoved): string => {
  if (why._tag === "Unverified") {
    return nothingLanded(plan.branch, why.tip);
  }
  if (why._tag === "RescueUnverified") {
    return rescueDidNotLand(plan.branch, why);
  }
  const alsoTried = Option.match(why.onto, {
    onNone: () =>
      `A branch of this run's own could not even be named: the copy's own HEAD would not
resolve, so there was no commit to name one after.`,
    onSome: (name) =>
      `Putting them on '${name}' instead — a branch of this run's own, named after the
commits — was tried too, and that did not work either.`,
  });
  const opening =
    why.home._tag === "Refused"
      ? `This move did not go through: the branch inside the copy no longer
continues on from '${plan.branch}' as it stands here, which is usually because the run tidied up
its own commits before finishing.`
      : `'${plan.branch}' could not be read here, so the commits were not sent there — a
fetch onto a branch that is not there would have created it.`;
  return `${opening} Nothing was deleted and nothing is lost — the copy was kept
for exactly this reason.

git said: ${branchAttemptSaid(why.home)}

${alsoTried}

git also said: ${why.rescue.detail}`;
};

// The salvage itself: the branch it was given, the question of whether that
// branch holds these commits now, then a branch of its own — and it answers
// `Kept` when the branch does not hold them, whether git refused the move or
// reported one that did not land. It never fails —
// "neither destination would take them" is an answer and not an error, which
// is what lets the release swallow it and the acquire refuse on it without
// either of them re-deciding what the other one meant.
//
// **The branch is asked about before it is fetched onto** (T107), because a
// fetch creates an absent destination unconditionally: a branch this repo
// cannot read is not a destination, and the commits go straight to the rescue.
//
// Nothing is removed here. Both fetches read *from* the directory, and so does
// the `rev-parse` that names the rescue, so a removal on this side of the
// answer would destroy the commits along with the evidence for keeping them.
export const salvage = (
  plan: SalvageTarget,
  repoRoot: string,
): Effect.Effect<Salvage, never, Git> =>
  Effect.gen(function* () {
    const repo = yield* Git;

    // One operation, one refspec, and the destination is the only thing the
    // two fetches differ by (T29).
    const fetchOnto = (onto: string): Effect.Effect<void, GitError> =>
      repoUrl(plan.checkoutPath).pipe(
        Effect.flatMap((from) =>
          repo.fetchBack({ from, into: repoRoot, branch: plan.branch, onto }),
        ),
      );

    // **The destination is asked about before it is fetched onto** (T107).
    // `git fetch` creates an absent destination unconditionally — the same
    // property the rescue below relies on — so a branch a human deleted since
    // this copy was made would come back from the fetch, the containment read
    // would answer yes about the ref the fetch had just created, and the copy
    // would go. A branch that cannot be read is therefore not a destination:
    // **any** failed read, not only absence, sends the commits straight to the
    // rescue, whose own read still authorizes the removal (T38). A branch
    // deleted between this read and the fetch is still recreated; that window
    // is human-deletion timescale, and closing it would need a primitive git
    // does not have.
    const branchRead = yield* Effect.either(
      repo.revParse({ repo: repoRoot, rev: `refs/heads/${plan.branch}` }),
    );

    // The tip is read in the clone and not in the repo (T27): the repo's copy
    // of this branch is a different commit, and it is the copy's tip that
    // names the branch these commits are going onto — and that the question
    // below is about.
    //
    // **The rev is the branch ref, not `HEAD`**, so the name is read off
    // exactly what the refspec below sends. They are the same commit whenever
    // the clone is on its branch, which is every ordinary path — but an agent
    // that left a rebase or a bisect half-done leaves a detached copy
    // (`wreckage.ts` reports that state), and there `HEAD` names a commit the
    // rescue branch would not contain. That breaks both properties the naming
    // rule rests on at once: named-from-the-commits, and a rerun at the same
    // tip being a no-op.
    const readTip = Effect.either(
      repo.revParse({ repo: plan.checkoutPath, rev: `refs/heads/${plan.branch}` }),
    );

    // The rescue, reached either way the branch could not be used: `home`
    // says which, for the sentences a keep owes, and `because` says it for the
    // ones a landing owes.
    const rescueFrom = (
      tip: Either.Either<string, GitError>,
      home: BranchAttempt,
      because: RescueReason,
    ): Effect.Effect<Salvage> =>
      Effect.gen(function* () {
        const named = Either.map(tip, (at) => rescueBranch(plan.branch, at));
        const rescue: Either.Either<string, GitError> = yield* Either.match(named, {
          onLeft: (error) => Effect.succeed(Either.left(error)),
          onRight: (name) => Effect.either(fetchOnto(name).pipe(Effect.as(name))),
        });

        // **And the rescue's removal is authorized by a read too.** The branch's
        // arm below is closed by the containment read after its fetch; this
        // closes the one destination left, for the same reason and with the
        // same question — a fetch reporting success and the ref holding the
        // commits afterwards are two propositions, and it is the second the
        // `rm -rf` in `releaseClone` depends on. A rescue is the case where that
        // matters most: it is reached only because the branch refused or could
        // not be read, so the copy is by then the sole known home of the work,
        // and a success that moved nothing would take the directory on the
        // strength of a ref that was never written.
        //
        // The tip is re-narrowed rather than reached for: a right `rescue`
        // implies a right `tip`, because the branch it fetched onto is named
        // after it, but that is an inference the compiler does not make and it
        // is cheaper to ask than to assert.
        if (Either.isRight(rescue) && Either.isRight(tip)) {
          const landed = yield* repo
            .branchContains({ repo: repoRoot, branch: rescue.right, commit: tip.right })
            .pipe(Effect.orElseSucceed(() => false));
          if (!landed) {
            return {
              _tag: "Kept",
              why: { _tag: "RescueUnverified", home, onto: rescue.right, tip: tip.right },
            };
          }
        }

        return Either.isRight(rescue)
          ? { _tag: "Rescued", onto: rescue.right, because }
          : {
              _tag: "Kept",
              why: { _tag: "Refused", home, onto: Either.getRight(named), rescue: rescue.left },
            };
      });

    // Unread: no fetch onto the branch, and no containment question about a
    // ref that is not there — the copy's tip, then the rescue alone.
    if (Either.isLeft(branchRead)) {
      const detail = branchRead.left.detail;
      return yield* rescueFrom(
        yield* readTip,
        { _tag: "Unread", detail },
        { _tag: "BranchUnread", detail },
      );
    }

    const home = yield* Effect.either(fetchOnto(plan.branch));
    const tip = yield* readTip;

    // **A refused fast-forward is not proof the commits are homeless** (T32),
    // and **a fetch that returned success is not proof they moved** (T38). One
    // question answers both, asked once, after the fetch rather than in place
    // of it — the fetch is what actually moves the commits in the common case,
    // and this is the read that says it did.
    //
    // Fast-forward-only refuses two situations and only one of them wants a
    // rescue: histories that disagree, and a branch standing *ahead* of this
    // copy — which is what an earlier fetch home leaves behind, because
    // anything that moves the branch on afterwards (a merge, a hand commit,
    // the dispatcher's own status commit) puts the repo's tip past the copy's.
    // The second is a copy that is finished with, so it answers `WentHome`:
    // there is no ref worth minting and nothing for a human to merge.
    //
    // **Asked in the repo, about the tip read in the copy.** The copy cannot
    // know what the repo holds, and the tips being unequal is what the
    // branch-is-ahead case looks like — so this is an ancestry question and
    // not a comparison. A repo that cannot answer at all — a tip whose object
    // it has never seen — is **not contained**, which is exactly the rescue's
    // case, and a copy that cannot be read for a tip at all is not contained
    // either: from out here it looks exactly like one holding work.
    const contained = yield* Either.match(tip, {
      onLeft: () => Effect.succeed(false),
      onRight: (at) =>
        repo
          .branchContains({ repo: repoRoot, branch: plan.branch, commit: at })
          .pipe(Effect.orElseSucceed(() => false)),
    });
    if (contained) {
      return { _tag: "WentHome" };
    }

    // **The removal below this answer is authorized by the read above it, not
    // by what the fetch returned** (T38). A fetch that reported success and
    // left the branch where it was — a partial fetch, a refspec that landed
    // somewhere unexpected, a `Git` layer that recorded rather than fetched —
    // arrives here, and it is not the rescue's case: nothing was refused, so
    // there is no reason to think a second destination would fare better, and
    // one that answered success the same way would mint a name holding
    // nothing and take the directory with it. The copy stays, and the sentence
    // the callers write says what was actually asked and answered.
    if (Either.isRight(home)) {
      return { _tag: "Kept", why: { _tag: "Unverified", tip: Either.getRight(tip) } };
    }

    return yield* rescueFrom(tip, { _tag: "Refused", error: home.left }, { _tag: "Refused" });
  });

export const checkout = (
  plan: DispatchPlan,
  repoRoot: string,
  // Where the release put this run's commits when they could not go home, for
  // the terminal row to read after this resource has let go (T31). Left as it
  // was found on every other path, which is what makes "no rescue" an absence
  // rather than a name.
  rescued: Ref.Ref<Option.Option<string>>,
  // The tip a `--hard-reset` discarded, for the same row (T104): set the
  // moment the reset's compare-and-set succeeds and never before, so a reset
  // that failed — or never ran — leaves it as it was found.
  discarded: Ref.Ref<Option.Option<string>>,
): Effect.Effect<string, GitError, Scope.Scope | Git | Reporter | FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const repo = yield* Git;
    const reporter = yield* Reporter;
    const fs = yield* FileSystem.FileSystem;

    // The directory a dead run of **this slug** left, cleared by this dispatch
    // and by nothing else (T28). bash cleared a stale checkout on the next
    // dispatch of that same slug (`run.sh:1161-1162`), so the person who lost
    // the commits was the person who chose to dispatch that branch again; T8
    // generalized that to every slug on every preflight and generalizing it is
    // what made it dangerous. The reconciler therefore reports a lone checkout
    // and never touches it (T25), and this — the slug's own re-dispatch, under
    // its own lock, at the moment the path is about to be used — is where the
    // authority bash always had comes back.
    //
    // It is not a guard, and could not be: what a guard may do is bounded by
    // what a refusal may leave behind, which since T70 is *holds nothing and
    // owes no release* rather than *writes nothing* — the `origin` fetch is a
    // write and still a guard (`guards.ts`). These two fetches fail that bar
    // anyway: they land on the dispatcher's own `refs/heads`, and the removal
    // after them is irreversible. Inside the `Scope`, under the lock, is also
    // the only moment at which nothing else may be holding this path.
    const clearKept = Effect.gen(function* () {
      const salvaged = yield* salvage(plan, repoRoot);
      if (salvaged._tag === "Kept") {
        // Rubble from a clone that died mid-write is indistinguishable here
        // from a repo whose branch will not fast-forward, and the safe
        // direction is the one that keeps it — so the refusal says the `rm
        // -rf` is the reader's to run. P4's `gc` is where that stops being
        // manual. The dispatch has not started, so this fails the run at the
        // stage it is already in and the lock it holds owes a row (SPEC §11).
        return yield* new GitError({
          detail: `an earlier run of '${plan.branch}' left its own copy of the repository behind, and the commits in
it are still only in there. Nothing was removed, nothing was cloned, and this dispatch stops here.

bessemer gives every run a private copy of this repository to work in, and moves the commits
back when the run ends. ${deadRunKeptItBecause(plan, salvaged.why)}

To bring the commits over as a branch you can look at before deciding anything:
  git fetch ${plan.checkoutPath} refs/heads/${plan.branch}:refs/heads/${plan.branch}-from-run
  git log --oneline ${plan.branch}..${plan.branch}-from-run

Then merge or cherry-pick from '${plan.branch}-from-run', whichever you want. Once the commits
are somewhere you are happy with — or if you can see the copy holds nothing — the directory is
yours to remove, and dispatching this branch again then works:
  rm -rf ${plan.checkoutPath}`,
        });
      }

      // Where the salvage just put them, which after a rescue is a branch of
      // the dead run's own and not the one this dispatch was given. The
      // refusal below is the **only** sentence that path gets — the warning
      // that names the branch comes after the removal, so a rescue followed by
      // a failed removal would otherwise write a ref nobody is ever told about
      // (the release names it for the same reason).
      const landed = salvaged._tag === "WentHome" ? plan.branch : salvaged.onto;

      // The commits are somewhere named, so the directory is disposable and
      // the path is this run's to clone into. A removal that fails here is not
      // the release's swallowed warning — this one is on the way *in*, and a
      // dispatch that cannot clear its own path has not started.
      yield* fs.remove(plan.checkoutPath, { recursive: true, force: true }).pipe(
        Effect.mapError(
          (error) =>
            new GitError({
              detail: `an earlier run of '${plan.branch}' left its own copy of the repository at ${plan.checkoutPath}, and it could not be removed (${error.message}) — its commits are safe on '${landed}', but nothing can be cloned into that path until the directory goes: rm -rf ${plan.checkoutPath}`,
            }),
        ),
      );

      // Said either way, because a directory disappearing is a thing the
      // dispatcher gets to know about — and after a rescue the sentence has to
      // name the branch, which is where those commits now are and is not the
      // branch this run was given.
      yield* reporter.emit({
        _tag: "Warned",
        detail:
          salvaged._tag === "WentHome"
            ? `an earlier run of '${plan.branch}' left its own copy of the repository at ${plan.checkoutPath}; its commits are on '${plan.branch}', so the copy has been removed and this run starts from a fresh clone.`
            : `an earlier run of '${plan.branch}' left its own copy of the repository at ${plan.checkoutPath}, and ${rescueBecause(plan.branch, salvaged.because)} — they are on '${salvaged.onto}' now, so merge or cherry-pick from there whenever you like. Nothing was lost, the copy has been removed, and this run starts from a fresh clone.`,
      });
      // Where the commits went, for the one reader that has to know whether
      // the branch just moved under it: the hard reset below (T101).
      return salvaged;
    });

    // **The hard reset, under the lock** (T101, D1). It stands here — after
    // the salvage above and before the clone — because the salvage fast-
    // forwards a kept copy's commits onto the branch, and a reset taken
    // earlier would have those commits put straight back, silently undoing it.
    // It is a compare-and-set against the tip the guards read, so a salvage
    // that just moved the branch, or anything else that did, fails the run at
    // stage `checkout` with nothing reset and nothing cloned, and the lock it
    // holds owes a row (SPEC §11). The sentence says which of the two moved
    // it: after a salvage that went home, the moved commits are ones the
    // discard count this dispatch printed never included, and so ones its
    // confirm never asked about (T102).
    const resetBranch = (reset: HardReset, salvaged: Option.Option<Salvage>) =>
      repo
        .updateRef({
          repo: repoRoot,
          ref: `refs/heads/${plan.branch}`,
          to: plan.baseSha,
          from: reset.discardedTip,
        })
        .pipe(
          Effect.mapError(
            (error) =>
              new GitError({
                detail: `${
                  Option.isSome(salvaged) && salvaged.value._tag === "WentHome"
                    ? `an earlier run of '${plan.branch}' left its own copy of the repository, and it held commits: this dispatch just moved them onto '${plan.branch}', and the discard count it printed never included them. Nothing was reset and those commits are safe on the branch. If this dispatch asked you to confirm the discard, that question never asked about them. Run the dispatch again — it will count them, and ask about them, before it discards anything.`
                    : `'${plan.branch}' moved after the guards read it at ${shortSha(reset.discardedTip)}, and something other than this dispatch moved it. Nothing was reset. Run the dispatch again to count what is there now.`
                }\n${error.detail}`,
              }),
          ),
          Effect.zipRight(Ref.set(discarded, Option.some(reset.discardedTip))),
          Effect.zipRight(
            reporter.emit({
              _tag: "BranchReset",
              branch: plan.branch,
              from: reset.discardedTip,
              originTip: reset.originTip,
              to: plan.baseSha,
              discarding: reset.discarding,
            }),
          ),
        );

    // **The commit identity the run's commits carry** (T35, `run.sh:1450-1454`):
    // the dispatching dev's own, read from the repo this dispatch is for and
    // written into the clone the agent works in. The human who typed the
    // dispatch is accountable for what it produced, and `Co-Authored-By:` is
    // what marks the agent's hand.
    //
    // **Read exactly two values and write exactly two.** Not the host's
    // gitconfig, which is where credential helpers, `url.*.insteadOf` rewrites,
    // and signing keys live: nothing of it is mounted into a container and
    // nothing of it is copied here, which is why this is two keys and not a
    // config passthrough.
    //
    // **Never `--global`, and never inside the container.** The write happens
    // on the host, into the clone, before `docker run` — an identity the agent
    // could set is a claim, and one the dispatcher set before the agent existed
    // is a default the agent had no part in. Be honest about what that buys:
    // the agent owns this clone, so it *can* override the value or pass
    // `--author`. This makes correct attribution the path of least resistance
    // and a deviation visible in the commit; it is not enforcement and does not
    // pretend to be.
    //
    // A config write that fails is a `GitError` like the clone above it, and
    // the acquire undoes its own clone before failing on it (`discardClone`).
    // A host with no `user.name` is **not** an error: it is the fallback, which
    // is the whole reason bash has one.
    const carryIdentity = Effect.gen(function* () {
      const name = yield* repo.readConfig({ repo: repoRoot, key: "user.name" });
      yield* repo.setConfig({
        repo: plan.checkoutPath,
        key: "user.name",
        value: yield* Option.match(name, {
          onNone: () => hostUsername,
          onSome: (found) => Effect.succeed(found),
        }),
      });
      const email = yield* repo.readConfig({ repo: repoRoot, key: "user.email" });
      yield* repo.setConfig({
        repo: plan.checkoutPath,
        key: "user.email",
        value: Option.getOrElse(email, () => FALLBACK_EMAIL),
      });
    });

    // **The one undo the acquire owes itself.** `acquireRelease` adds the
    // release only once the acquire has *succeeded*, so a failure between the
    // clone and the resource being reported acquired leaves the directory
    // behind with no finalizer coming for it — and a checkout with no lock
    // beside it is `Kept` by the reconciler (`wreckage.ts`), reported to a
    // human as a copy that may hold the only version of a run's work. This one
    // holds none: it was cloned a moment ago, no container ever started on it,
    // and its branch is still exactly what the repo's is. So it goes, and the
    // run fails on the write that would not land rather than on anything about
    // the directory.
    const discardClone: Effect.Effect<void> = fs
      .remove(plan.checkoutPath, { recursive: true, force: true })
      .pipe(
        Effect.catchAll((error) =>
          reporter.emit({
            _tag: "Warned",
            detail: `this dispatch could not finish preparing its own copy of the repository at ${plan.checkoutPath}, and the copy could not be removed either (${error.message}) — nothing ever ran in it and nothing is lost, and the directory is finished with: rm -rf ${plan.checkoutPath}`,
          }),
        ),
      );

    // `git clone` creates its leading directories itself, so a refused clone
    // leaves no empty `checkouts/` behind for the next `status` to explain. It
    // also refuses a destination that exists, which is why the salvage above
    // runs first — and only when there is something there to salvage: a path
    // that does not exist asks git nothing at all.
    const acquire = Effect.gen(function* () {
      const kept = yield* fs.exists(plan.checkoutPath).pipe(
        Effect.mapError(
          (error) =>
            new GitError({
              detail: `could not tell whether ${plan.checkoutPath} is already there (${error.message}) — nothing was removed and nothing was cloned`,
            }),
        ),
      );
      const salvaged = kept ? Option.some(yield* clearKept) : Option.none<Salvage>();
      if (Option.isSome(plan.reset)) {
        yield* resetBranch(plan.reset.value, salvaged);
      }
      const source = yield* repoUrl(repoRoot);
      yield* repo.clone({ source, branch: plan.branch, into: plan.checkoutPath });
      yield* carryIdentity.pipe(Effect.onError(() => discardClone));
      yield* reporter.emit({ _tag: "ResourceAcquired", resource: "checkout" });
      return plan.checkoutPath;
    });

    // `rm -rf`, as bash's cleanup does (`run.sh:1245`): the clone is a
    // directory tree, and a removal that fails is the reconciler's problem
    // rather than this run's error. `rescuedOnto` is the rescue — the branch it
    // wrote, and why the run's own was not used — absent when the commits went
    // home. Every sentence here names where the commits actually are, which
    // after a rescue is not the branch the run was given.
    const releaseClone = (
      rescuedOnto: Option.Option<{ readonly onto: string; readonly because: RescueReason }>,
    ): Effect.Effect<void> =>
      fs.remove(plan.checkoutPath, { recursive: true, force: true }).pipe(
        Effect.matchEffect({
          onSuccess: () =>
            reporter.emit({ _tag: "ResourceReleased", resource: "checkout" }).pipe(
              Effect.zipRight(
                Option.match(rescuedOnto, {
                  onNone: () => Effect.void,
                  // One line, because that is all a rescue needs to be: the
                  // human gets a branch, and `git log`, `git diff`, `git
                  // merge`, and `git cherry-pick` all work on it with no
                  // explanation of what a checkout is.
                  onSome: ({ onto, because }) =>
                    reporter.emit({
                      _tag: "Warned",
                      detail: `this run ended, and ${rescueBecause(plan.branch, because)} — they are on '${onto}' now, so merge or cherry-pick from there whenever you like. Nothing was lost, and the run's copy of the repository has been cleaned up.`,
                    }),
                }),
              ),
            ),
          onFailure: (error) =>
            reporter.emit({
              _tag: "Warned",
              detail: `this run's commits are safely on '${Option.match(rescuedOnto, { onNone: () => plan.branch, onSome: ({ onto }) => onto })}', but its copy of the repository could not be cleaned up (${error.message}) — nothing is lost, and the directory is finished with: rm -rf ${plan.checkoutPath}`,
            }),
        }),
      );

    // Attempted on every exit path, whatever the run did: the release's
    // question is "did the commits make it home", and only the fetch answers
    // it. Nothing above this line records an opinion for it to read.
    const release = Effect.gen(function* () {
      const salvaged = yield* salvage(plan, repoRoot);
      if (salvaged._tag === "WentHome") {
        return yield* releaseClone(Option.none());
      }
      if (salvaged._tag === "Rescued") {
        // Recorded before the removal rather than after it: the commits are on
        // that branch whatever the disk does next, and the row is the durable
        // half of the same sentence the warning below says once.
        yield* Ref.set(rescued, Option.some(salvaged.onto));
        return yield* releaseClone(Option.some(salvaged));
      }

      // **A copy that is not on disk was not kept** (T38). Every arm of `Kept`
      // is a sentence about a directory that is still there — where to fetch
      // from, what to `rm -rf` — and a path holding nothing has none of that
      // to say and nothing to destroy, so it releases the resource the way the
      // went-home arm does. The acquire asks this same question before it
      // salvages at all ("a path that does not exist asks git nothing"); the
      // release owed it too, because the salvage answers `Kept` for a copy that
      // was never made as readily as for one that holds work. It is a question
      // about the filesystem and about nothing else: a run whose copy vanished
      // under it reaches this line for the same reason a rehearsal does, and
      // neither of them learns which it is.
      const stillThere = yield* fs.exists(plan.checkoutPath).pipe(
        // Unreadable is "assume it is there": the loud arm below keeps the
        // directory and says so, which is the safe direction when the disk
        // will not answer.
        Effect.orElseSucceed(() => true),
      );
      if (!stillThere) {
        return yield* releaseClone(Option.none());
      }

      // Loud, kept, and swallowed (matrix rows 13, 18). The branch does not
      // hold the commits, so the directory is still the only copy of them —
      // which is a broken repo or a broken disk rather than the routine
      // rebase. On the refused arm the folded `detail` opens with git's own
      // subject — "could not fast-forward '<onto>' from <path>" — because
      // `render.ts` prints a `GitError` as a whole line with no label, so these
      // sentences say what the *run* lost rather than restating that clause
      // under them.
      return yield* reporter.emit({
        _tag: "Warned",
        detail: `this run's commits are still in its own copy of the repository, not on '${plan.branch}'.

bessemer gives every run a private copy of this repository to work in, and moves the commits
back when the run ends. ${thisRunKeptItBecause(plan, salvaged.why)}

To bring the commits over as a branch you can look at before deciding anything:
  git fetch ${plan.checkoutPath} refs/heads/${plan.branch}:refs/heads/${plan.branch}-from-run
  git log --oneline ${plan.branch}..${plan.branch}-from-run

Then merge or cherry-pick from '${plan.branch}-from-run', whichever you want. Once the commits
are somewhere you are happy with, the copy is finished with:
  rm -rf ${plan.checkoutPath}`,
      });
    });

    return yield* Effect.acquireRelease(acquire, () => release);
  });
