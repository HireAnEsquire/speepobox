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

// Why the shim cannot run: it is not there, it has no execute bit, or it
// could not be read at all.
export type ShimUnrunnable = "absent" | "not executable" | { readonly unreadable: string };

// What became of the scaffold refresh `upgrade` hands to the new release
// (T149): the release that ships the templates applies them, so after the pin
// the repo's own shim runs `init --refresh` as a child, and this is its answer.
export type RefreshOutcome =
  // The child ran and exited 0. `output` is its stdout, verbatim; the two
  // flags are what the report adds after it.
  | {
      readonly _tag: "Refreshed";
      readonly output: string;
      // A `kept … (behind, edited — see init --diff)` line came back.
      readonly keptEdited: boolean;
      // `image/Dockerfile` or `image/inputs` differ in bytes across the child.
      readonly imageChanged: boolean;
    }
  // The pin moved down a release: scaffold files are not rolled back.
  | { readonly _tag: "RolledBack" }
  // No shim that can run, so no child: the pin moved and the refresh is the
  // adopter's to run. A stat that failed for any reason but a missing file
  // carries the error, so it is never mistaken for an absent shim.
  | { readonly _tag: "NoShim"; readonly reason: ShimUnrunnable }
  // The child exited nonzero or never started. Its stdout is still the
  // report's; the failure itself is `upgrade`'s error, on stderr.
  | { readonly _tag: "Failed"; readonly output: string };
