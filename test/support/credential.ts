// The credential a fake-tier dispatch is handed (T23). It is a fixture rather
// than a fake layer because the resolver is a module and not a tag: every
// caller below the composition root takes the *answer* as a parameter, so what
// a test needs is a value, and `test/credential.test.ts` is where the resolving
// itself is the subject.
//
// The value is a `Redacted`, exactly as `resolveCredential` answers with one,
// and it is a canary: every case that asserts "the token is not in argv" looks
// for this string in the exec fake's `recorded` ref.
import { Redacted } from "effect";
import { type AgentCredential, CREDENTIAL_NAMES } from "../../src/agent/credential.ts";

// The token itself, spelled once so a test can assert its absence.
export const CREDENTIAL_CANARY = "not-a-real-token";

export const TEST_CREDENTIAL: AgentCredential = {
  name: CREDENTIAL_NAMES[0] ?? "",
  value: Redacted.make(CREDENTIAL_CANARY),
  source: "file",
};

// The *other* accepted name (`ANTHROPIC_API_KEY`), which the probe has
// promised works since T1. Every case above is handed the first name, so a
// dispatch path that had quietly gone back to a constant would satisfy all of
// them and still hand a container the variable the agent CLI does not read —
// which is §1's second row, the one this ticket had to close as well.
export const ALTERNATE_CREDENTIAL: AgentCredential = {
  name: CREDENTIAL_NAMES[1] ?? "",
  value: Redacted.make(CREDENTIAL_CANARY),
  source: "file",
};
