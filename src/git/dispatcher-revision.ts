// T43: which revision of the dispatcher wrote a ledger row, and whether its
// source was dirty when it did. A host fact about the tool's own
// source — read once at the composition root (AGENTS.md) and reaching the
// ledger as data on the record, never through `Git`: this is not a question a
// run asks about the repo it is dispatching for.
//
// Read from the repo **enclosing `packageRoot`**, never from the served repo:
// self-hosted the two are one directory and the distinction costs nothing, but
// under P6's shim the tool runs out of a cache clone while serving somebody
// else's repo, and the dispatcher's revision is a fact about the tool's own
// source. No `Git` import here for the same reason
// `dispatcher-freshness.ts` has none: a plain module beside it, taking a repo
// path rather than the tag.
//
// **Dirty means dirty under this dispatcher's source, not anywhere in the
// repo.** Scoped with `packagePathspec` — the same scope T42's freshness
// check uses — so a doc edit under `docs/` is not a modified dispatcher.
import type { CommandExecutor } from "@effect/platform/CommandExecutor";
import { Effect, Option } from "effect";
import { packagePathspec } from "../config/paths.ts";
import type { Dispatcher } from "../ledger/record.ts";
import { exec } from "../internal/exec.ts";
import { repoArgs } from "./repo-args.ts";

// `sha` is the full 40-hex commit and `revision` git's own abbreviation of
// it (T123). The ledger and every display keep the short form — rows already
// on disk carry it — while the pin and the comparison against it need the full
// one, since a fetch by SHA is served only for a full one (P6, F6 and F14).
export interface DispatcherRevision {
  readonly sha: string;
  readonly revision: string;
  readonly dirty: boolean;
}

// The ledger's view of the revision: the short form and the dirty bit, and
// nothing else. Projected rather than passed through, so the full SHA never
// rides into a record whose field is the short one.
export const toDispatcher = (resolved: DispatcherRevision): Dispatcher => ({
  revision: resolved.revision,
  dirty: resolved.dirty,
});

// One call answers both forms: `rev-parse` applies `--short` to the revisions
// after it, so `HEAD --short HEAD` prints the full SHA and then exactly what
// `rev-parse --short HEAD` prints alone.
//
// `None` only when the revision itself could not be read — an
// unlikely host problem `doctor`'s git probe already diagnoses, and never a
// fabricated clean. A row with no dispatcher renders as unknown on `status`,
// which is the correct reading for "we could not tell" as much as for "this
// row predates the field".
export const resolveDispatcherRevision = (
  dispatcherRepoRoot: string,
): Effect.Effect<Option.Option<DispatcherRevision>, never, CommandExecutor> =>
  Effect.gen(function* () {
    const revision = yield* exec(
      "git",
      ...repoArgs(dispatcherRepoRoot),
      "rev-parse",
      "HEAD",
      "--short",
      "HEAD",
    ).pipe(Effect.orElseSucceed(() => ({ exitCode: 1, stdout: "", stderr: "" })));
    const [sha, short] = revision.stdout
      .trim()
      .split("\n")
      .map((line) => line.trim());
    if (revision.exitCode !== 0 || !sha || !short) {
      return Option.none();
    }
    const status = yield* exec(
      "git",
      ...repoArgs(dispatcherRepoRoot),
      "status",
      "--porcelain",
      "--",
      ...packagePathspec(dispatcherRepoRoot),
    ).pipe(Effect.orElseSucceed(() => ({ exitCode: 1, stdout: "", stderr: "" })));
    return Option.some({
      sha,
      revision: short,
      dirty: status.exitCode === 0 && status.stdout.trim() !== "",
    });
  });
