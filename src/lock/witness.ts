// The eviction witness (SPEC §4): `link` again, in the one place the claim
// cannot reach. `claim.ts` makes *creation* exclusive, so two claims on a free
// path resolve through the kernel — but removing a dead owner's lock is a bare
// `remove`, and two dispatches that read the same dead pid both do it. The
// loser's remove lands on the winner's *fresh* lock, and the winner's release
// then deletes the loser's; both hold the branch in between.
//
// Renaming the corpse aside instead of removing it looks like the same trick
// applied to eviction and is not: by the time the loser gets there the path
// holds a live lock, and a rename moves that aside just as happily as it would
// have moved the corpse. POSIX has no unlink-if-this-is-still-the-file-I-read
// and no rename-if-unchanged, so the exclusivity has to be taken *before* the
// removal, on a path this process names — which is a link, and a link refuses
// an existing destination.
//
// That exclusivity is only ever as good as the evictor holding it, and nothing
// on disk said who that was: the witness's contents are the *corpse's* pid,
// because the witness is the corpse file. A dispatch killed between the link
// and the removal therefore left a state nobody could read — every later
// acquisition collided on the same witness and reported a colleague's eviction
// forever, the reconciler's reclaim went through that same acquisition, and
// the branch could not be dispatched again until a human deleted a file. So
// the evictor now names itself beside the witness, before it takes the link,
// and **a witness whose evictor is not alive is debris** (T26).
import { FileSystem, Path } from "@effect/platform";
import type { PlatformError } from "@effect/platform/Error";
import { Effect, Option } from "effect";
import { parsePid } from "./liveness.ts";

const isCollision = (error: PlatformError): boolean =>
  error._tag === "SystemError" && error.reason === "AlreadyExists";

const sameOwner = (one: Option.Option<number>, other: Option.Option<number>): boolean =>
  Option.getOrUndefined(one) === Option.getOrUndefined(other);

// Keyed to a generation, not to a path: the witness names the owner that was
// found dead, so evicting a later corpse under the same lock path takes a
// different witness and is never blocked by an older one — including the one a
// `kill -9` mid-eviction leaves behind, which is T8's reconciler's to reclaim.
// A lock nobody can name is its own generation. The suffix is not `.pid`, so a
// scan of the locks directory cannot mistake an eviction in flight for a lock,
// exactly as `.claim` cannot be mistaken for one.
const witnessPathFor = (path: Path.Path, file: string, owner: Option.Option<number>): string =>
  path.join(
    path.dirname(file),
    `${path.basename(file)}.${Option.match(owner, {
      onNone: () => "unowned",
      onSome: (dead) => `${dead}`,
    })}.evicting`,
  );

// The evictor's own name, *beside* the witness rather than in it (T26). Both
// of the obvious places are closed: the witness's **path** is a pure function
// of the lock file and the dead owner, because that is what makes `link` the
// arbiter — two evictors that computed two destinations would both win and
// both remove the same corpse — and the witness's **contents** are the
// corpse's, because it is a second name for the corpse file, which `claim.ts`
// and the reconciler both read as the owner. So the one fact nothing on disk
// carried — *who is holding this witness* — is a third file, keyed to the
// witness it belongs to.
//
// The name is the whole marker: it carries the pid, so a sweep decides from a
// directory listing rather than from a read of a file that may be a moment
// old, and there is nothing inside for a half-write to truncate. The suffix is
// neither `.pid` nor `.evicting`, so a scan mistakes it for neither a lock nor
// a witness.
export const EVICTOR_SUFFIX = ".evictor";

// The serial is `claim.ts`'s, for `claim.ts`'s reason: the pid is unique among
// live processes, the serial among this process's own concurrent evictions.
// One marker per *eviction* rather than per process is what keeps the loser of
// a link from removing a marker the winner is still standing behind — which
// would tell the reconciler that a live eviction was over, and hand its corpse
// to a second dispatch.
let serial = 0;

export const evictorMarkerFor = (witness: string, evictor: number, attempt: number): string =>
  `${witness}.${evictor}.${attempt}${EVICTOR_SUFFIX}`;

export interface EvictorMarker {
  // The witness this marker stands beside, as the same name the witness is
  // written under — so the reconciler groups the two by string equality over
  // one directory listing.
  readonly witness: string;
  readonly evictor: number;
}

// The other half of the name above, and the only reader of it. Anything that
// does not parse — a stray file, a marker whose fields are not numbers — is
// not a marker and vouches for nobody: it must not be able to keep a stranded
// witness alive by looking like an evictor.
export const evictorInMarkerName = (entry: string): Option.Option<EvictorMarker> => {
  if (!entry.endsWith(EVICTOR_SUFFIX)) {
    return Option.none();
  }
  const named = entry.slice(0, -EVICTOR_SUFFIX.length);
  const attempt = named.lastIndexOf(".");
  const evictor = named.slice(0, Math.max(attempt, 0)).lastIndexOf(".");
  if (attempt <= 0 || evictor <= 0) {
    return Option.none();
  }
  return Option.isNone(parsePid(named.slice(attempt + 1)))
    ? Option.none()
    : Option.map(parsePid(named.slice(evictor + 1, attempt)), (pid) => ({
        witness: named.slice(0, evictor),
        evictor: pid,
      }));
};

// The right to remove one dead lock, held for exactly as long as `evict` runs.
// `Option.none()` is the whole of "another dispatch is already evicting this
// same corpse": nothing was removed and nothing was claimed, so the caller owes
// its user the answer it already gives for losing a reclaim. Every other way
// the link can fail stays in the error channel, where a broken host and a
// colleague's dispatch are still different answers.
export const withEvictionWitness = <A, E, R>(
  file: string,
  owner: Option.Option<number>,
  evict: Effect.Effect<A, E, R>,
): Effect.Effect<Option.Option<A>, E | PlatformError, R | FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const witness = witnessPathFor(path, file, owner);
    // This process, read here rather than taken from the caller: the marker
    // answers "is the dispatch holding this witness still alive", and the only
    // process that can honestly answer it is the one running this bracket. A
    // pid handed in would be a pid the reconciler then trusts about somebody
    // else's liveness.
    const marker = evictorMarkerFor(witness, process.pid, yield* Effect.sync(() => (serial += 1)));

    // A bracket rather than `claim.ts`'s `ensuring`, because the link *is* the
    // acquisition and cannot sit inside the region the finalizer covers: the
    // dispatch that loses it must not run that finalizer, or losing would
    // delete the winner's witness. As the acquisition it is uninterruptible,
    // so an interrupt arriving while the link is in flight is delivered to the
    // eviction below, with the finalizer already installed — an `ensuring`
    // wrapped around the rest instead drops the witness in that window, and a
    // witness nobody removes refuses every later eviction of the same corpse
    // until T8's reconciler exists.
    return yield* Effect.acquireUseRelease(
      // The marker goes down **before** the link, and the order is the whole
      // of it: a witness on disk with no live evictor beside it is what the
      // reconciler sweeps (T26), so a link taken before its marker exists is a
      // live eviction the next preflight reads as debris — and sweeping it
      // hands this corpse to a second dispatch, which is the double remove the
      // witness exists to close. The other order is only ever litter: a marker
      // whose link never happened names a pid that is about to be gone.
      //
      // The corpse itself is the link source: the witness is a second name for
      // the very file being evicted, so `AlreadyExists` from the kernel *is*
      // the losing dispatch's answer rather than a conclusion drawn from a
      // read this process took a moment ago.
      fs.writeFileString(marker, "").pipe(
        Effect.zipRight(
          fs.link(file, witness).pipe(
            Effect.as(true),
            Effect.catchIf(isCollision, () => Effect.succeed(false)),
          ),
        ),
        // An acquisition that fails runs no release, so the marker is taken
        // back here — a link that failed for a reason that is not a collision
        // never stood beside anything.
        Effect.tapError(() => Effect.ignore(fs.remove(marker, { force: true }))),
      ),
      (won) =>
        won
          ? Effect.gen(function* () {
              // Which generation did the link actually catch? A dispatch whose
              // read predates another's *whole* eviction finds this witness
              // free again and links the winner's live lock into it — the one
              // case the link alone cannot refuse, because by then the corpse
              // it names is gone. The witness is a second name for that exact
              // file, and a lock is written before its name exists
              // (`claim.ts`), so what it holds identifies the generation
              // rather than reporting a read that may already be stale:
              // anything but the owner this eviction found dead means it lost.
              const witnessed = yield* fs.readFileString(witness).pipe(Effect.map(parsePid));
              if (!sameOwner(witnessed, owner)) {
                return Option.none<A>();
              }
              return Option.some(yield* evict);
            })
          : Effect.succeed(Option.none<A>()),
      // Success, failure, and interruption alike. The witness leaves only with
      // the dispatch that took it — it is never what a caller holds (the lock
      // is) — while the marker leaves either way, because the loser wrote one
      // too and it names the loser. Each removes a path that carries its own
      // pid and its own attempt, so neither can take the other's away. A
      // removal that itself fails is swallowed: a leftover witness names a
      // generation nobody will ever evict again, and the reconciler sweeps
      // both. Removing the witness takes away one *name*, so the loser of the
      // generation check hands the winner's lock back untouched.
      //
      // The marker goes first. The reverse order opens a window where this
      // witness is gone, a new one can be taken on the same generation, and
      // this marker — naming a pid that is still very much alive — vouches for
      // an eviction that is over: the next stranding on that path would then
      // read as in flight until this process exits.
      (won) =>
        Effect.ignore(fs.remove(marker, { force: true })).pipe(
          Effect.zipRight(won ? Effect.ignore(fs.remove(witness, { force: true })) : Effect.void),
        ),
    );
  });
