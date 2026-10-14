// Ownership is declared, never inferred (design rule 3, 05 Q11). Every
// sandbox carries `bessemer.managed=true` + `bessemer.repo=<hash of repo
// root>`, and every query filters on **both**. Prefix sweeping of
// `agentbox-*` is retired: the container name matches anyone's unrelated
// container and — worse — matches agentbox running in a second repo on the
// same host. The name survives for human readability only.
//
// This module is introduced by `status`, which only queries, because T3
// applies the same labels when it creates sandboxes. Creation and query read
// from one list here so the two agree by construction rather than by review.
import { createHash } from "node:crypto";
import { resolve } from "node:path";

export const MANAGED_LABEL = "bessemer.managed";
export const REPO_LABEL = "bessemer.repo";

// A stable, short, path-safe scope for one repo root. Pure — the caller
// resolves the repo root; `status` may run no git commands (SPEC §7), so it
// arrives as a parameter from the composition root.
//
// Hashed through `path.resolve`, because two spellings of one directory are
// one repo: since T60 the root can be `--repo-root`'s value taken as given,
// and a trailing slash or a `..` segment in it would otherwise label a
// dispatch's containers under a scope the same repo's `status` and reconciler
// then filter past — a live run reported as nothing running, and its sandboxes
// invisible to the sweep. `resolve` reads nothing for an absolute path, which
// is the only kind the peel lets through.
export const repoScope = (repoRoot: string): string =>
  createHash("sha256").update(resolve(repoRoot)).digest("hex").slice(0, 12);

// `key=value` pairs, the form both `docker run --label` and
// `docker ps --filter label=` take.
export const ownershipLabels = (repoRoot: string): ReadonlyArray<string> => [
  `${MANAGED_LABEL}=true`,
  `${REPO_LABEL}=${repoScope(repoRoot)}`,
];

// The query side: docker CLI arguments filtering on both labels at once.
export const ownershipFilterArgs = (repoRoot: string): ReadonlyArray<string> =>
  ownershipLabels(repoRoot).flatMap((label) => ["--filter", `label=${label}`]);
