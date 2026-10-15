// The `upgrade` renderer (T128): a pure function over `UpgradeSnapshot`,
// subscribed to the `Reporter` stream exactly as `init`'s is. One report, in
// T149's order: the pin line, the refresh child's own output, the two lines
// that output can owe — files to merge, an image to rebuild — and what to do
// with the result. A rollback refreshes nothing and a missing shim cannot, and
// each says so in that slot instead.
import { IMAGE_BUILD, REFRESH } from "../init/render.ts";
import type { Release } from "../git/releases.ts";
import type { PinnedBefore, RefreshOutcome, ShimUnrunnable, UpgradeSnapshot } from "./snapshot.ts";

export const INIT_DIFF_COMMAND = ".speepobox/speepobox init --diff";

export const UPGRADE_COMMAND = ".speepobox/speepobox upgrade";

export const shortSha = (sha: string): string => sha.slice(0, 7);

const named = (release: Release): string => `${release.tag} (${shortSha(release.commit)})`;

// How a value no release names reads: its short form, or that it was empty.
export const shownPin = (value: string): string => (value === "" ? '""' : shortSha(value));

const wasLine = (was: PinnedBefore): string =>
  was._tag === "Release" ? named(was.release) : `${shownPin(was.value)} (no release)`;

// The release the pin names once `upgrade` is done, moved or not.
export const pinnedRelease = (snapshot: UpgradeSnapshot): Release =>
  snapshot._tag === "Pinned" ? snapshot.to : snapshot.release;

const pinLine = (snapshot: UpgradeSnapshot): string =>
  snapshot._tag === "Pinned"
    ? `pinned ${named(snapshot.to)}, was ${wasLine(snapshot.was)}`
    : snapshot.explicit
      ? `already pinned ${named(snapshot.release)} — the pin line was not rewritten`
      : `pinned ${named(snapshot.release)}, the latest release: the pin is current — the pin line was not rewritten`;

export const KEPT_EDITED_LINE =
  "The files kept above as behind and edited are yours to merge: run this to see each one's diff against the new template:";

export const REBUILD_LINE = "The image's inputs changed: rebuild it with";

export const COMMIT_LINE =
  "Nothing was committed: review the diff (`git diff .speepobox/`), then commit .speepobox/.";

// The child's stdout as it printed it, less the newline that ends it.
const outputLines = (output: string): ReadonlyArray<string> => {
  const trimmed = output.replace(/\n+$/, "");
  return trimmed === "" ? [] : ["", trimmed];
};

const shimWhy = (reason: ShimUnrunnable): string =>
  typeof reason === "string" ? `is ${reason}` : `could not be read: ${reason.unreadable}`;

const refreshLines = (
  snapshot: UpgradeSnapshot,
  refresh: RefreshOutcome,
): ReadonlyArray<string> => {
  switch (refresh._tag) {
    case "Refreshed":
      return [
        ...outputLines(refresh.output),
        "",
        ...(refresh.keptEdited ? [KEPT_EDITED_LINE, `  ${INIT_DIFF_COMMAND}`] : []),
        ...(refresh.imageChanged ? [REBUILD_LINE, `  ${IMAGE_BUILD}`] : []),
        COMMIT_LINE,
      ];
    case "RolledBack":
      return [
        "",
        `Scaffold files are not rolled back: run this to see how they compare with ${pinnedRelease(snapshot).tag}'s templates:`,
        `  ${INIT_DIFF_COMMAND}`,
        COMMIT_LINE,
      ];
    case "NoShim":
      return [
        "",
        `The scaffold was not refreshed: the shim .speepobox/speepobox ${shimWhy(refresh.reason)}. Once it can run, refresh with:`,
        `  ${REFRESH}`,
        COMMIT_LINE,
      ];
    // The failure itself is `upgrade`'s error, on stderr after this.
    case "Failed":
      return outputLines(refresh.output);
  }
};

export const renderUpgrade = (snapshot: UpgradeSnapshot, refresh: RefreshOutcome): string =>
  [pinLine(snapshot), ...refreshLines(snapshot, refresh)].join("\n");
