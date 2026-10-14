// A prompt needs a terminal at both ends (T94). The platform's `Terminal`
// answers `isTTY` from stdout alone, so `app.ts` provides one over it that
// answers from the stdin fact `bin.ts` reads as well. Every gate asks the tag,
// and every other test stubs it — this file is where the live answer is pinned.
//
// Composed the wrong way round, the platform's `Terminal` wins the merge, the
// override does nothing, and it all still typechecks. Under vitest stdout is
// not a terminal, so the platform answers `false` and a no-op override would
// pass unnoticed; each case sets stdout's answer itself.
import { Terminal } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { afterEach } from "vitest";
import { PlatformAndReporterLive } from "../src/app.ts";

const isTTY = Effect.flatMap(Terminal.Terminal, (terminal) => terminal.isTTY);

const stdoutWas = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");

const stdoutIsTTY = (value: boolean): void => {
  Object.defineProperty(process.stdout, "isTTY", { value, configurable: true, writable: true });
};

afterEach(() => {
  if (stdoutWas === undefined) {
    delete (process.stdout as { isTTY?: boolean }).isTTY;
  } else {
    Object.defineProperty(process.stdout, "isTTY", stdoutWas);
  }
});

describe("the live Terminal's isTTY", () => {
  it.scoped("answers false when stdin is not a terminal, though stdout is", () =>
    Effect.gen(function* () {
      stdoutIsTTY(true);
      expect(yield* isTTY.pipe(Effect.provide(NodeContext.layer))).toBe(true);
      expect(yield* isTTY.pipe(Effect.provide(PlatformAndReporterLive(false)))).toBe(false);
    }),
  );

  it.scoped("answers what the platform does when stdin is a terminal", () =>
    Effect.gen(function* () {
      for (const stdout of [true, false]) {
        stdoutIsTTY(stdout);
        const platform = yield* isTTY.pipe(Effect.provide(NodeContext.layer));
        expect(platform).toBe(stdout);
        expect(yield* isTTY.pipe(Effect.provide(PlatformAndReporterLive(true)))).toBe(platform);
      }
    }),
  );
});
