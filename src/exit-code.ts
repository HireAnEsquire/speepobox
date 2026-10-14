// What the shell learns from a run, as a pure function of how it ended (SPEC
// §4's signal table). It is a module rather than a closure inside `bin.ts`'s
// teardown because `bin.ts` *runs* the CLI on import: the one file the fake
// tier cannot import is the one place this could otherwise be asserted, and an
// exit code nobody can assert is exactly how the interrupt branch below stayed
// wrong from T1 to here.
import { Cause, Exit } from "effect";

// 128 + the signal's number, as every shell reports a signalled death — and as
// bash reports this same Ctrl-C today, because the signal kills the script
// outright there. So this is parity, not new behaviour: an interrupted run
// releases all three resources and records `interrupted`, and a dispatcher
// wrapped in a script is exactly the caller a silent 0 misleads.
export const SIGINT_SIGNAL_NUMBER = 2;
export const INTERRUPTED_EXIT_CODE = 128 + SIGINT_SIGNAL_NUMBER;

// SIGHUP needs no branch of its own: `bin.ts` re-raises it as SIGINT so the
// runtime's single handler is the only teardown (AGENTS.md), and the exit that
// reaches here is an interrupt whichever signal started it.
//
// `exitCode` is whatever the run left on `process.exitCode` — `doctor` sets 1
// on a FAIL row and reports success with warnings as 0 — and it is honored on
// every non-interrupt path. The interrupt is checked first on purpose: a run
// killed mid-flight reports the signal, not the code some earlier step left.
export const exitCodeFor = (
  exit: Exit.Exit<unknown, unknown>,
  exitCode: number | string | null | undefined,
): number => {
  if (Exit.isFailure(exit)) {
    return Cause.isInterruptedOnly(exit.cause) ? INTERRUPTED_EXIT_CODE : 1;
  }
  // A string is `process.exitCode`'s own shape and not a code: node coerces
  // one at exit, and the tool has no reason to. 0 is the honest answer.
  return typeof exitCode === "number" ? exitCode : 0;
};
