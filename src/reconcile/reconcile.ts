// The reconciler (SPEC §4, 05 Q11/Q14): the component the bash spine never
// had. It runs on **every dispatch preflight**, over **all** slugs —
// generalizing bash's per-slug stale clear (`run.sh:1226-1227`) — after the
// guards and before the run's `Scope` opens. It is preflight, not a resource:
// it holds nothing when it is done, and it never fails the dispatch it
// precedes (a daemon that will not answer degrades and reports; the daemon
// *check* is T3's, one line above).
//
// It auto-reclaims **only the provably dead** and reports everything else
// (`wreckage.ts` decides which, purely). Silently deleting a possibly-live run
// is how you kill a colleague's dispatch, so the reclaim is the narrow half
// and the report is the wide one — matrix row 17's second half, and the only
// closure the hard-exit path gets.
//
// **It takes the lock before it touches a thing.** Acquisition is where T20's
// atomic claim and T21's eviction witness already compose, so a reclaim goes
// through `RunLock.acquire` rather than through a second arrangement of the
// two: the reconciler sweeps every slug on every preflight, so it races
// against any dispatch acquiring at that moment without the "same dead owner"
// narrowing that keeps both windows small inside one acquisition. Removing a
// container under a lock we hold cannot delete the container of a run that
// started while we were scanning, because that run would have had to take this
// lock first. `LockHeld` here is exactly that race, and the answer to it is to
// report and touch nothing.
//
// The consequence is that a reclaim emits the lock's own `ResourceAcquired` /
// `ResourceReleased` pair from preflight, before the run's scope opens. That
// is honest — the reconciler really did hold that lock — and the ordering
// invariant SPEC §11 asserts is about the run's own scope, which still opens
// and closes its three resources in order after this has finished.
//
// **It removes a checkout only after a read says the commits in it are
// somewhere else** (T38). The reclaim's own evidence is a lock naming an owner
// that is not alive — which is exactly the case where that run's release never
// got to move its commits home, so nothing in the scan establishes they are
// anywhere but in that directory. The question is `Git`'s, and it is the one
// the salvage already asks (`dispatch/checkout.ts`): the tip read in the copy,
// the ancestry asked in the repo. A read that cannot confirm it keeps the
// directory and says why, which is the `Kept` direction §2 already picks.
//
// Nothing here writes to the ledger, and nothing here *reads* it (§3c).
import { FileSystem, Path } from "@effect/platform";
import type { CommandExecutor } from "@effect/platform/CommandExecutor";
import type { PlatformError } from "@effect/platform/Error";
import { Effect, Option } from "effect";
import { SpeepoboxConfig } from "../config/config.ts";
import {
  CHECKOUTS_DIRNAME,
  checkoutPathFor,
  LOCKS_DIRNAME,
  lockPathFor,
} from "../dispatch/plan.ts";
import { Git } from "../git/git.ts";
import { exec } from "../internal/exec.ts";
import { isProcessAlive, parsePid } from "../lock/liveness.ts";
import { RunLock } from "../lock/run-lock.ts";
import { evictorInMarkerName } from "../lock/witness.ts";
import { ownershipFilterArgs } from "../ownership/labels.ts";
import { Reporter } from "../reporter.ts";
import { Sandbox } from "../sandbox/sandbox.ts";
import {
  branchInHead,
  type CheckoutOnDisk,
  classify,
  describeWreckage,
  type EvictionWitness,
  isDebris,
  isEvictionWitness,
  keptCheckoutNotice,
  type LockOnDisk,
  type OwnedSandbox,
  parseOwnedSandboxes,
  type RunWreckage,
  slugOfContainer,
  unmovedCheckoutNotice,
} from "./wreckage.ts";

// The reconciler's ownership query, and the one live case 4 asks a real daemon
// (SPEC §11). `-a` because a container that started, exited, and was never
// removed is wreckage plain `docker ps` cannot see; both labels because
// ownership is declared, never inferred (design rule 3), through the one list
// creation reads from so the two agree by construction.
//
// It goes to the subprocess chokepoint directly rather than through `Sandbox`,
// as `status` does for the same query: the tag's surface is the resource a run
// holds, and this asks about the ones no run holds any more.
//
// `None` is "dockerd could not be asked", which is not an empty list: with no
// answer, condition 3 has no answer either, and a reconcile that cannot see
// containers reclaims nothing.
export const ownedSandboxes = (
  repoRoot: string,
): Effect.Effect<Option.Option<ReadonlyArray<OwnedSandbox>>, never, CommandExecutor> =>
  exec(
    "docker",
    "ps",
    "-a",
    ...ownershipFilterArgs(repoRoot),
    "--format",
    "{{.ID}}\t{{.Names}}\t{{.State}}",
  ).pipe(
    Effect.map((result) =>
      result.exitCode === 0
        ? Option.some(parseOwnedSandboxes(result.stdout))
        : Option.none<ReadonlyArray<OwnedSandbox>>(),
    ),
    Effect.orElseSucceed(() => Option.none<ReadonlyArray<OwnedSandbox>>()),
  );

const isNotFound = (error: PlatformError): boolean =>
  error._tag === "SystemError" && error.reason === "NotFound";

// A dead evictor's name beside a witness, located in the directory it was
// listed from. The sweep removes it by path and has nothing else to ask.
export interface DeadEvictorMarker {
  readonly path: string;
  readonly evictor: number;
}

// What this host holds, gathered and not yet acted on (T97). The reconciler
// acts on it on every preflight; `gc` lists it, and acts on it differently
// (P4) — so the gathering is a value both can take, and it removes nothing.
export interface WreckageScan {
  // Every slug's wreckage, sorted, in the order the reconciler visits them.
  readonly wreckage: ReadonlyArray<RunWreckage>;
  // What the witness sweep acts on: the markers whose evictor is not alive,
  // and the witnesses no live evictor is standing behind.
  readonly deadMarkers: ReadonlyArray<DeadEvictorMarker>;
  readonly stranded: ReadonlyArray<EvictionWitness>;
  // The daemon's answer, `None` for "could not be asked" exactly as
  // `ownedSandboxes` returns it — never an empty list. With `None`, no slug's
  // wreckage carries a sandbox, because no query ran.
  readonly containers: Option.Option<ReadonlyArray<OwnedSandbox>>;
}

// Everything the reconciler reads before it acts, and nothing it acts with:
// no `Sandbox`, `RunLock`, or `Git` in its requirements, because those are
// the removals' and the removal's authorization.
export const scanWreckage = (
  repoRoot: string,
): Effect.Effect<
  WreckageScan,
  never,
  SpeepoboxConfig | Reporter | CommandExecutor | FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const config = yield* SpeepoboxConfig;
    const reporter = yield* Reporter;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const report = (detail: string): Effect.Effect<void> =>
      reporter.emit({ _tag: "Warned", detail });

    const locksDir = path.join(config.runtimeRoot, LOCKS_DIRNAME);
    const checkoutsDir = path.join(config.runtimeRoot, CHECKOUTS_DIRNAME);

    // A directory that does not exist is a host that has not dispatched yet,
    // not a failure. One that cannot be read is reported and skipped: this
    // never fails the dispatch it precedes.
    const entriesIn = (dir: string): Effect.Effect<ReadonlyArray<string>> =>
      fs.readDirectory(dir).pipe(
        Effect.catchIf(isNotFound, () => Effect.succeed<ReadonlyArray<string>>([])),
        Effect.catchAll((error) =>
          report(`could not read ${dir} (${error.message}) — nothing under it is reclaimed`).pipe(
            Effect.as<ReadonlyArray<string>>([]),
          ),
        ),
      );

    // A scan is a snapshot: a file that vanished under it is not wreckage
    // anybody has to account for, so an unreadable entry drops out rather than
    // becoming a lock nobody can name.
    const lockAt = (file: string): Effect.Effect<Option.Option<LockOnDisk>> =>
      fs.readFileString(file).pipe(
        Effect.map((contents) =>
          Option.some<LockOnDisk>({ path: file, owner: parsePid(contents) }),
        ),
        Effect.orElseSucceed(() => Option.none<LockOnDisk>()),
      );

    // The branch a kept copy is on, read as a file rather than asked of git:
    // this is the scan, and the scan touches every slug on the host, so it
    // reads directories rather than spawning a `git` per one. `.git/HEAD` is
    // the fact the notice cannot derive from the slug (`wreckage.ts`), and it
    // is also the ref the reconciler's containment read asks about.
    // Unreadable is `None`, not a failure — the notice has a form that needs
    // no branch name, and a copy that cannot name one is a copy nothing can
    // vouch for.
    const checkoutAt = (slug: string): Effect.Effect<CheckoutOnDisk> => {
      const dir = checkoutPathFor(config.runtimeRoot, slug);
      return fs.readFileString(path.join(dir, ".git", "HEAD")).pipe(
        Effect.map((contents) => branchInHead(contents)),
        Effect.orElseSucceed(() => Option.none<string>()),
        Effect.map((branch) => ({ path: dir, branch })),
      );
    };

    // Which slug a lock file belongs to, answered through `plan.ts`'s own
    // derivation rather than a second spelling of `<slug>.pid`: strip the
    // suffix, then derive the path again and keep the answer only if it lands
    // back on this entry. `.claim` and `.evicting` files fail that round trip,
    // which is what keeps a claim in flight from being read as a lock.
    const slugOfLockEntry = (entry: string): Option.Option<string> => {
      const suffix = entry.lastIndexOf(".");
      if (suffix <= 0) {
        return Option.none();
      }
      const slug = entry.slice(0, suffix);
      return path.basename(lockPathFor(config.runtimeRoot, slug)) === entry
        ? Option.some(slug)
        : Option.none();
    };

    const lockEntries = yield* entriesIn(locksDir);

    // The one piece of wreckage T20 and T21 leave rather than clear (§3a): a
    // run killed between taking a witness and finishing its eviction leaves a
    // name behind, and a stranded witness refuses every later eviction of that
    // same corpse — including the reclaim, which goes through the very
    // acquisition that collides, so the slug wedges until a human deletes a
    // file by hand (T26).
    //
    // Decided from the listing and nothing else: the evictor names itself
    // beside the witness before it takes the link (`lock/witness.ts`), so a
    // witness with no live evictor is debris and one with a live evictor is an
    // eviction in flight, which is somebody else's. Reading the witness would
    // only say which corpse — it *is* the corpse file — which is the half T8
    // could reach and the reason it could not settle this.
    const markers = lockEntries.flatMap((entry) =>
      Option.toArray(Option.map(evictorInMarkerName(entry), (marker) => ({ ...marker, entry }))),
    );

    const deadMarkers = markers
      .filter((marker) => !isProcessAlive(marker.evictor))
      .map((marker) => ({ path: path.join(locksDir, marker.entry), evictor: marker.evictor }));

    const stranded = lockEntries.filter(isEvictionWitness).flatMap((entry) => {
      const witness: EvictionWitness = {
        path: path.join(locksDir, entry),
        evictors: markers
          .filter((marker) => marker.witness === entry)
          .map((marker) => marker.evictor),
      };
      return isDebris(witness) ? [witness] : [];
    });

    const containers = yield* ownedSandboxes(repoRoot);

    const locks = new Map<string, LockOnDisk>();
    for (const entry of lockEntries) {
      const slug = slugOfLockEntry(entry);
      if (Option.isSome(slug)) {
        const lock = yield* lockAt(path.join(locksDir, entry));
        if (Option.isSome(lock)) {
          locks.set(slug.value, lock.value);
        }
      }
    }

    const sandboxes = new Map<string, OwnedSandbox>();
    for (const container of Option.getOrElse(containers, () => [])) {
      sandboxes.set(slugOfContainer(container.name), container);
    }

    const checkouts = new Set(yield* entriesIn(checkoutsDir));

    const slugs = [...new Set([...locks.keys(), ...sandboxes.keys(), ...checkouts])].toSorted();

    const wreckage = yield* Effect.forEach(slugs, (slug): Effect.Effect<RunWreckage> =>
      Effect.map(
        checkouts.has(slug) ? Effect.asSome(checkoutAt(slug)) : Effect.succeedNone,
        (checkout) => ({
          slug,
          lock: Option.fromNullable(locks.get(slug)),
          sandbox: Option.fromNullable(sandboxes.get(slug)),
          checkout,
        }),
      ),
    );

    return { wreckage, deadMarkers, stranded, containers };
  });

// The sweep of what T20 and T21 leave behind, over a scan's value. It runs
// before anything tries to evict, which is what lets the same pass clear the
// wreckage underneath a stranded witness (T26).
//
// The markers first, exactly as the eviction's own release takes them first:
// a name that outlives the witness it stands beside would vouch for the
// *next* eviction of that same generation. These all record dispatches that
// are gone — one beside a live evictor's is a losing dispatch killed before it
// could take its own name back — and a marker left lying around is a live
// evictor again the day its pid is recycled. Not a notice of its own: the
// witness below is the wedge a dispatcher can act on, and this is the
// bookkeeping that leaves with it — but a removal that fails is a host that
// stopped answering, and that is reported.
export const sweepWitnesses = (
  scan: WreckageScan,
): Effect.Effect<void, never, Reporter | FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const reporter = yield* Reporter;
    const fs = yield* FileSystem.FileSystem;

    const report = (detail: string): Effect.Effect<void> =>
      reporter.emit({ _tag: "Warned", detail });

    yield* Effect.forEach(
      scan.deadMarkers,
      (marker) =>
        fs
          .remove(marker.path, { force: true })
          .pipe(
            Effect.catchAll((error) =>
              report(`could not sweep the eviction marker at ${marker.path} (${error.message})`),
            ),
          ),
      { discard: true },
    );
    yield* Effect.forEach(
      scan.stranded,
      (witness) =>
        fs.remove(witness.path, { force: true }).pipe(
          Effect.matchEffect({
            onSuccess: () =>
              report(
                `swept a stranded eviction witness at ${witness.path} — no live dispatch is evicting under it, so the lock it names can be reclaimed again`,
              ),
            onFailure: (error) =>
              report(`could not sweep the eviction witness at ${witness.path} (${error.message})`),
          }),
        ),
      { discard: true },
    );
  });

export const reconcile = (
  repoRoot: string,
): Effect.Effect<
  void,
  never,
  | Sandbox
  | RunLock
  // One tag more than T8 needed, and no operation on it this package did not
  // already have (T38): the removal below is authorized by a read, and `Git`
  // is where every question about a repository is asked.
  | Git
  | SpeepoboxConfig
  | Reporter
  | CommandExecutor
  | FileSystem.FileSystem
  | Path.Path
> =>
  Effect.gen(function* () {
    const reporter = yield* Reporter;
    const fs = yield* FileSystem.FileSystem;
    const sandbox = yield* Sandbox;
    const runLock = yield* RunLock;
    const repo = yield* Git;

    // Everything this component says is one event kind: a reclaim is a
    // `Reporter` event, and the run that triggered it writes its own row on
    // its own terms (§5).
    const report = (detail: string): Effect.Effect<void> =>
      reporter.emit({ _tag: "Warned", detail });

    const scan = yield* scanWreckage(repoRoot);

    yield* sweepWitnesses(scan);

    if (Option.isNone(scan.containers)) {
      // Condition 3 has no answer, so no run can be proven dead on this pass.
      // The dispatch itself is unaffected — the daemon check that *can* refuse
      // it is T3's, and it has already run.
      yield* report(
        "could not ask dockerd which containers it holds — nothing was reclaimed on this preflight",
      );
      return;
    }

    const removeSandbox = (found: RunWreckage): Effect.Effect<void> =>
      Option.match(found.sandbox, {
        onNone: () => Effect.void,
        onSome: (container) =>
          sandbox.remove({ name: container.name, id: container.id }).pipe(
            Effect.matchEffect({
              onSuccess: () => report(`reclaimed the container '${container.name}'`),
              onFailure: (error) =>
                report(`${error.detail} — it is still on this host, and still labelled ours`),
            }),
          ),
      });

    // Whether the commits in a copy are reachable from that branch **here**,
    // which is the only thing that authorizes removing the directory (T38).
    // The same two operations the salvage uses and in the same direction: the
    // tip is read in the copy, because only the copy knows what it is on, and
    // the ancestry is asked in the repo, because only the repo knows what its
    // branch holds. Ancestry rather than equality, for T32's reason — a branch
    // standing ahead of the copy is the ordinary case after any earlier fetch
    // home.
    //
    // `None` is confirmed; `Some(why)` is not, and carries what to say about
    // it. Four things land in that arm and every one of them keeps the
    // directory: a copy whose HEAD named no branch, a tip the copy will not
    // resolve, a repo that cannot answer at all, and a branch that plainly
    // does not hold the commits.
    const notElsewhere = (checkout: CheckoutOnDisk): Effect.Effect<Option.Option<string>> =>
      Option.match(checkout.branch, {
        onNone: () =>
          Effect.succeed(
            Option.some(
              "its HEAD names no branch, so there is no ref in it to ask this repository about",
            ),
          ),
        onSome: (branch) =>
          repo.revParse({ repo: checkout.path, rev: `refs/heads/${branch}` }).pipe(
            Effect.flatMap((tip) =>
              repo
                .branchContains({ repo: repoRoot, branch, commit: tip })
                .pipe(
                  Effect.map((held) =>
                    held
                      ? Option.none<string>()
                      : Option.some(
                          `'${branch}' here does not hold ${tip}, the commit that copy is on`,
                        ),
                  ),
                ),
            ),
            Effect.catchAll((error) => Effect.succeed(Option.some(error.detail))),
          ),
      });

    // The clone goes whole, as bash's stale clear does (`rm -rf "$wt"`) — but
    // only once the read above says the commits in it are on a branch here
    // (T38). Its own failure sentence used to assert that as a fact about a
    // repository nothing in this path had read; now it is read, a moment
    // before the removal it authorizes, and a read that will not confirm it
    // leaves the directory and hands the dispatcher the commands that answer
    // what is in there.
    const removeCheckout = (found: RunWreckage): Effect.Effect<void> =>
      Option.match(found.checkout, {
        onNone: () => Effect.void,
        onSome: (checkout) =>
          Effect.flatMap(notElsewhere(checkout), (unconfirmed) =>
            Option.match(unconfirmed, {
              onSome: (why) => report(unmovedCheckoutNotice(found.slug, checkout, why)),
              onNone: () =>
                fs.remove(checkout.path, { recursive: true, force: true }).pipe(
                  Effect.matchEffect({
                    onSuccess: () => report(`reclaimed the checkout at ${checkout.path}`),
                    onFailure: (error) =>
                      report(
                        `could not remove the checkout at ${checkout.path} (${error.message}) — the commits in it are on a branch here, read a moment ago, so it is safe to delete by hand: rm -rf ${checkout.path}`,
                      ),
                  }),
                ),
            }),
          ),
      });

    // Under the lock, and in the order a run releases: sandbox, checkout, and
    // then the lock itself, which leaves with the scope this opens. Losing the
    // lock is the race §3a names — another dispatch got to this slug between
    // the scan and now — and the answer to it is to report and touch nothing.
    const reclaim = (found: RunWreckage): Effect.Effect<void> =>
      Effect.scoped(
        runLock
          .acquire(found.slug)
          .pipe(
            Effect.zipRight(
              report(`reclaiming the wreckage of '${found.slug}': ${describeWreckage(found)}`),
            ),
            Effect.zipRight(removeSandbox(found)),
            Effect.zipRight(removeCheckout(found)),
          ),
      ).pipe(
        Effect.catchAll((error) =>
          report(
            `'${found.slug}' looked reclaimable, but its lock is not this preflight's to take (${error.detail}) — nothing of it was touched`,
          ),
        ),
      );

    yield* Effect.forEach(
      scan.wreckage,
      (found) =>
        Effect.gen(function* () {
          const slug = found.slug;
          const verdict = classify(found);
          switch (verdict._tag) {
            case "Live":
              return yield* report(
                `'${slug}' is a live run — ${verdict.detail} — ${describeWreckage(found)} left untouched`,
              );
            // A checkout the run kept on purpose (`wreckage.ts`). This is the
            // only notice a dispatcher ever gets that the commits are sitting
            // there, and the one thing they must not do is assume the pass
            // will tidy it later — so it is the whole recovery, not a line
            // saying something was skipped. P4's `gc` is where a human removes
            // what this pass will not.
            case "Kept":
              return yield* Option.match(found.checkout, {
                onNone: () => Effect.void,
                onSome: (checkout) => report(keptCheckoutNotice(slug, checkout)),
              });
            case "Reclaimable":
              return yield* reclaim(found);
          }
        }),
      { discard: true },
    );
  });
