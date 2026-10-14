// `upgrade`'s own argv (T128). Intercepted before `@effect/cli` ever sees the
// command line, as `gc` and `init` are, so its words are read here — in a
// module rather than in `bin.ts`, because importing the entrypoint runs the
// CLI and nothing that owes an assertion stays there (AGENTS.md).
//
// `--to vN` is the only word. Every other — `--dry-run` included — is unknown
// and refused with the usage line. A `--to` value that is not a release name
// refuses here, which is before the network.
import { Data, Either, Option } from "effect";
import { isReleaseTag } from "../git/releases.ts";

export const UPGRADE_USAGE = "speepobox upgrade [--to vN]";

// One line on stderr and exit 1, through the renderer every other refusal
// uses (`dispatch/render.ts`).
export class UpgradeRefused extends Data.TaggedError("UpgradeRefused")<{
  readonly detail: string;
}> {}

export interface UpgradeArgs {
  // The release to pin; none moves to the newest.
  readonly to: Option.Option<string>;
}

const refused = (detail: string): UpgradeRefused =>
  new UpgradeRefused({ detail: `${detail} (usage: ${UPGRADE_USAGE})` });

// The words after `upgrade`. A `--to` given twice is refused rather than
// resolved by position, as `init`'s flags are.
export const parseUpgradeArgv = (
  argv: ReadonlyArray<string>,
): Either.Either<UpgradeArgs, UpgradeRefused> => {
  let to = Option.none<string>();
  let at = 0;
  while (at < argv.length) {
    const word = argv[at]!;
    if (word !== "--to") {
      return Either.left(refused(`unknown upgrade flag: ${word}`));
    }
    const value = argv[at + 1];
    if (value === undefined || value.trim() === "" || value.startsWith("--")) {
      return Either.left(refused("--to needs a value"));
    }
    if (Option.isSome(to)) {
      return Either.left(refused("--to given twice"));
    }
    if (!isReleaseTag(value)) {
      return Either.left(
        refused(`--to ${value} is not a release name: a release is v and a number, as v3`),
      );
    }
    to = Option.some(value);
    at += 2;
  }
  return Either.right({ to });
};
