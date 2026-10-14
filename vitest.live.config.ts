import { defineConfig } from "vitest/config";

// The live tier (SPEC §11): host-only cases against a real dockerd, run by
// hand with `npm run verify:live` before landing anything that touches
// `Sandbox.dockerLayer`. `verify` never reaches them — the config above
// excludes the directory and the tag below refuses to be imported without the
// marker this file sets.
//
// A case earns this tier only if a fake could pass while dockerd disagrees.
// Everything else is a unit test, in `test/`.
export default defineConfig({
  test: {
    // Exactly what `verify` excludes, and written to stay that way: the fake
    // tier drops `test/live/**` by path, so anything narrower here leaves a
    // gap between the two globs where a case is collected by neither run and
    // both exit 0. `.live.test.ts` stays the naming convention; it is no
    // longer the thing the wiring depends on.
    include: ["test/live/**/*.test.ts"],
    // The tag's marker (`test/live/live.ts`). It lives here rather than in the
    // npm script so the one config that runs live cases is the one thing that
    // can admit them — and so the script stays a plain `vitest run`, with no
    // `VAR=1` prefix a non-POSIX shell would choke on.
    env: { BESSEMER_LIVE: "1" },
    // The two ways a live tier goes quietly green, both refused: an empty
    // glob (a renamed or moved case) is a failed run, not a pass, and no case
    // here is `skipIf`-guarded — a missing dockerd is red.
    passWithNoTests: false,
    // One daemon, one host: cases start real containers and query by label, so
    // they run one file at a time rather than racing each other's `docker ps`.
    // Each case still scopes its own labels to its own temp repo root.
    fileParallelism: false,
    // A daemon is slower than a fake, and an image pull is slower still.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
