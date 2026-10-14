// The `upgrade` renderer (T128): a pure function over `UpgradeSnapshot`,
// subscribed to the `Reporter` stream exactly as `init`'s is. A move is what
// moved, then the drift check to run — printed, and never run: the next shim
// call runs the *new* pin, whose templates are the ones to diff against.
import type { Release } from "../git/releases.ts";
import type { PinnedBefore, UpgradeSnapshot } from "./snapshot.ts";

export const INIT_DIFF_COMMAND = ".bessemer/bessemer init --diff";

export const shortSha = (sha: string): string => sha.slice(0, 7);

const named = (release: Release): string => `${release.tag} (${shortSha(release.commit)})`;

// How a value no release names reads: its short form, or that it was empty.
export const shownPin = (value: string): string => (value === "" ? '""' : shortSha(value));

const wasLine = (was: PinnedBefore): string =>
  was._tag === "Release" ? named(was.release) : `${shownPin(was.value)} (no release)`;

export const renderUpgrade = (snapshot: UpgradeSnapshot): string =>
  snapshot._tag === "Pinned"
    ? [
        `pinned ${named(snapshot.to)}, was ${wasLine(snapshot.was)}`,
        "",
        "Next: run this to see which scaffold files the new release's templates change:",
        `  ${INIT_DIFF_COMMAND}`,
        "Nothing was committed: commit .bessemer/config.toml when you are ready.",
      ].join("\n")
    : snapshot.explicit
      ? `already pinned ${named(snapshot.release)} — nothing was written`
      : `pinned ${named(snapshot.release)}, the latest release: the pin is current — nothing was written`;
