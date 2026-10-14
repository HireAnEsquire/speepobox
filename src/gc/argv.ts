// `gc`'s own argv (SPEC §7). `gc` is intercepted before `@effect/cli` ever
// sees the command line, as `status` and `doctor` are, so its one flag is read
// here — in a module rather than in `bin.ts`, because importing the entrypoint
// runs the CLI and nothing that owes an assertion stays there (AGENTS.md).
//
// `--force` is the only flag. bash's `--gc` alias (`run.sh:545`) is not
// carried, and neither is an interactive mode: gc stays scriptable (D9,
// `run.sh:541-544`).
import { Data, Either } from "effect";

export const GC_USAGE = "bessemer gc [--force]";

// One line on stderr and exit 1, through the renderer every other refusal
// uses (`dispatch/render.ts`).
export class GcRefused extends Data.TaggedError("GcRefused")<{
  readonly detail: string;
}> {}

export interface GcArgs {
  readonly force: boolean;
}

// The words after `gc`. A repeated `--force` says nothing new, so it is not
// refused.
export const parseGcArgv = (argv: ReadonlyArray<string>): Either.Either<GcArgs, GcRefused> => {
  const unknown = argv.find((word) => word !== "--force");
  return unknown === undefined
    ? Either.right({ force: argv.includes("--force") })
    : Either.left(new GcRefused({ detail: `unknown gc flag: ${unknown} (usage: ${GC_USAGE})` }));
};
