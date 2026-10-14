// The live tier's gates, asserted from the tier that runs in CI (SPEC §11).
//
// Both gates fail closed on their own — but only under `npm run verify:live`,
// which the container writing this package can never run. So the wiring is
// asserted here, where `npm run verify` reaches it: an edit that drops the
// path exclude, renames the marker, or lets an empty live run pass turns this
// red now rather than turning a host-only script red weeks later, in the one
// tier whose whole design is a refusal to go quietly green.
import { describe, expect, it } from "@effect/vitest";
import fakeTier from "../vitest.config.ts";
import liveTier from "../vitest.live.config.ts";

describe("the live tier's tag", () => {
  it("refuses to be imported without the marker, rather than skipping", async () => {
    // This file runs under `verify`, where the marker is unset, so importing
    // the harness *is* the case: a live case that somehow reached the fake
    // tier dies exactly here, and `test/live/live.ts` is the only import a
    // live case needs to inherit that.
    await expect(import("./live/live.ts")).rejects.toThrow(/SPEEPOBOX_LIVE/);
  });

  it("takes its marker from the live config, so only that config admits a live case", () => {
    expect(liveTier.test?.env).toEqual({ SPEEPOBOX_LIVE: "1" });
  });

  it("keeps the live directory out of verify, and never passes an empty live run", () => {
    // The path exclude is the first of the two gates; the include below is its
    // complement, so no `.test.ts` under `test/live/` falls between the tiers
    // and is collected by neither run.
    expect(fakeTier.test?.exclude).toContain("test/live/**");
    expect(liveTier.test?.include).toEqual(["test/live/**/*.test.ts"]);
    // The other way a host-only tier goes green: a renamed or moved case
    // leaving the glob with nothing to collect.
    expect(liveTier.test?.passWithNoTests).toBe(false);
  });
});
