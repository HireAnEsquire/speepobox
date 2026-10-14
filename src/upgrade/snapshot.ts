// `UpgradeSnapshot` — what `upgrade` did, as a value (SPEC §5: ops as library,
// CLI as renderer), shaped as `init`'s and `gc`'s are. The command gathers
// this; the renderer is a pure function over it. Refusals are not in here:
// they are `UpgradeRefused`, one line on stderr.
import type { Release } from "../git/releases.ts";

// What the tool-sha line pinned before: a release, or a value no release
// names — an untagged full SHA, or the empty or short value `--to` may
// rewrite.
export type PinnedBefore =
  | { readonly _tag: "Release"; readonly release: Release }
  | { readonly _tag: "NoRelease"; readonly value: string };

export type UpgradeSnapshot =
  // The line was rewritten to `to`'s commit.
  | { readonly _tag: "Pinned"; readonly to: Release; readonly was: PinnedBefore }
  // Nothing was written: plain `upgrade` on the latest release, or `--to`
  // naming the commit already pinned.
  | { readonly _tag: "Unchanged"; readonly release: Release; readonly explicit: boolean };
