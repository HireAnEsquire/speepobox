// The exit code the shell sees (SPEC §4's signal table, T19). Four answers
// out of one function: 130 for an interrupt, 1 for a real failure, whatever
// `doctor` left on `process.exitCode` otherwise, and 0 when nothing set one.
//
// This is `bin.ts`'s teardown, tested where `bin.ts` cannot be: importing that
// file runs the CLI. The mapping lived inline there from T1 and reported an
// interrupted run — released and recorded correctly — to the shell as success.
import { describe, expect, it } from "@effect/vitest";
import { Cause, Exit, FiberId } from "effect";
import { exitCodeFor, INTERRUPTED_EXIT_CODE } from "../src/exit-code.ts";

const interrupted = Exit.failCause(Cause.interrupt(FiberId.none));

describe("the exit code a run reports", () => {
  it("is 128 + SIGINT's 2 on an interrupt", () => {
    expect(INTERRUPTED_EXIT_CODE).toBe(130);
    expect(exitCodeFor(interrupted, undefined)).toBe(130);
  });

  // The signal is the whole story of how the run ended, so it outranks
  // anything an earlier step left behind — a Ctrl-C is a Ctrl-C whether or not
  // some command had already set a code.
  it("reports the interrupt even when a command had set an exit code", () => {
    expect(exitCodeFor(interrupted, 1)).toBe(130);
    expect(exitCodeFor(interrupted, 0)).toBe(130);
  });

  // Ctrl-C during teardown, or a finalizer that died on the way out: the cause
  // carries a defect beside the interrupt, and that is a failed run, not a
  // cleanly interrupted one.
  it("is 1 when the cause carries anything besides the interrupt", () => {
    expect(
      exitCodeFor(
        Exit.failCause(Cause.sequential(Cause.interrupt(FiberId.none), Cause.die("mid-teardown"))),
        undefined,
      ),
    ).toBe(1);
  });

  it("is 1 for a typed failure and for a defect", () => {
    expect(exitCodeFor(Exit.fail("refused"), undefined)).toBe(1);
    expect(exitCodeFor(Exit.die("impossible state"), undefined)).toBe(1);
    // Even one `doctor` had reported success for: the failure is the answer.
    expect(exitCodeFor(Exit.fail("refused"), 0)).toBe(1);
  });

  // `doctor` exits 1 on a FAIL row and 0 on warnings, and it does that by
  // setting `process.exitCode` from inside the effect. The default teardown
  // stomps it with 0, which is why there is a teardown here at all.
  it("honors the exit code a successful command set", () => {
    expect(exitCodeFor(Exit.void, 1)).toBe(1);
    expect(exitCodeFor(Exit.void, 0)).toBe(0);
    expect(exitCodeFor(Exit.void, undefined)).toBe(0);
  });

  // `process.exitCode` accepts a string; node coerces it at exit and this tool
  // never sets one, so it reads as "no code was set" rather than as a number
  // to guess at.
  it("treats a non-numeric process.exitCode as no code at all", () => {
    expect(exitCodeFor(Exit.void, "1")).toBe(0);
  });
});
