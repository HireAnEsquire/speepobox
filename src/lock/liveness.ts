// Liveness: plain functions, no tag (SPEC §2). This is the *only* place the
// question "is the run that wrote this lock still alive" is decided —
// `RunLock` acquisition asks it here, T8's reconciler asks it here, and P4's
// `gc` asks it here, so the three cannot drift into different staleness rules
// over one lock directory.
import { Option } from "effect";

// A lock file holds one PID and nothing else (`echo "$$" > "$lock"`). Anything
// else — empty, truncated, a half-written line — is an owner we cannot name,
// which is a lock nobody can prove is live.
export const parsePid = (contents: string): Option.Option<number> => {
  const trimmed = contents.trim();
  if (!/^\d+$/.test(trimmed)) {
    return Option.none();
  }
  const pid = Number(trimmed);
  return pid > 0 ? Option.some(pid) : Option.none();
};

// `kill -0` (`run.sh:1059`): signal 0 runs every permission check and delivers
// nothing. EPERM means the process exists and belongs to someone else — alive,
// and emphatically not ours to reclaim. Every other failure means it is gone.
//
// A non-positive pid never reaches `process.kill`: 0 signals the whole process
// group, which is the one call this predicate must never make.
export const isProcessAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

// The two halves joined, for the callers that hold a *lock* rather than a pid:
// an owner nobody can name is not one anybody can prove alive, so it reads
// exactly as a pid that is gone. Acquisition asks it of the lock it collided
// with (T4), and T8's reconciler asks it of every lock and every stranded
// eviction witness in the directory — one predicate rather than two spellings
// of it, which is the whole reason this module has no tag.
// It narrows to `Some` because being alive says so: a caller that has just
// proven an owner alive has a pid to name in the sentence it reports.
export const ownerIsAlive = (owner: Option.Option<number>): owner is Option.Some<number> =>
  Option.isSome(owner) && isProcessAlive(owner.value);
