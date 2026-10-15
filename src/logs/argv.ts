// `logs`'s own argv (T151). Intercepted before `@effect/cli` ever sees the
// command line, as `gc` and `upgrade` are, so its words are read here — in a
// module rather than in `bin.ts`, because importing the entrypoint runs the
// CLI and nothing that owes an assertion stays there (AGENTS.md).
//
// One branch and `--follow`. A missing branch is a refusal naming the usage
// line, never the picker: `logs` reads files and asks nobody anything.
import { Data, Either } from "effect";

export const LOGS_USAGE = "speepobox logs <branch> [--follow]";

// One line on stderr and exit 1, through the renderer every other refusal
// uses (`dispatch/render.ts`).
export class LogsRefused extends Data.TaggedError("LogsRefused")<{
  readonly detail: string;
}> {}

export interface LogsArgs {
  readonly branch: string;
  readonly follow: boolean;
}

const refused = (detail: string): LogsRefused =>
  new LogsRefused({ detail: `${detail} (usage: ${LOGS_USAGE})` });

// The words after `logs`. A repeated `--follow` says nothing new, so it is not
// refused, as `gc --force` is not.
export const parseLogsArgv = (
  argv: ReadonlyArray<string>,
): Either.Either<LogsArgs, LogsRefused> => {
  const unknown = argv.find((word) => word.startsWith("-") && word !== "--follow");
  if (unknown !== undefined) {
    return Either.left(refused(`unknown logs flag: ${unknown}`));
  }
  const branches = argv.filter((word) => word !== "--follow");
  if (branches.length > 1) {
    return Either.left(refused(`logs takes one branch, got ${branches.length}`));
  }
  const branch = branches[0];
  if (branch === undefined || branch.trim() === "") {
    return Either.left(refused("logs needs a branch"));
  }
  return Either.right({ branch, follow: argv.includes("--follow") });
};
