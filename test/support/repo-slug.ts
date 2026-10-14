// The forge repo a fake-tier run is handed (T39). It is a fixture rather than
// a fake layer, the same reason `TEST_CREDENTIAL` is one
// (`test/support/credential.ts`): every caller below the composition root
// takes the *answer* as a parameter, so what a test needs is a value, and
// `test/repo-slug.test.ts` is where the parse itself is the subject.
import type { RepoSlug } from "../../src/git/repo-slug.ts";

export const TEST_FORGE_REPO: RepoSlug = { owner: "HireAnEsquire", name: "hae" };
