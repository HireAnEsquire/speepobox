// `init`'s own argv (T114). `init` is intercepted before `@effect/cli` ever
// sees the command line, as `gc` is, so its words are read here — in a module
// rather than in `bin.ts`, because importing the entrypoint runs the CLI and
// nothing that owes an assertion stays there (AGENTS.md).
//
// Both flags are parsed as **optional**: each is an override of a value
// `init.ts` works out itself (T115), and the one it cannot work out is a
// refusal made there, never here (T3). `--diff` (T116) is a bare word, and it
// refuses either flag beside it: those configure a write `--diff` never makes.
// Every other word — a rehearsal flag, `--force` — is unknown and refused with
// the usage line.
import { Data, Either, Option } from "effect";

export const INIT_USAGE = "bessemer init [--base <ref>] [--image <tag>] | bessemer init --diff";

// One line on stderr and exit 1, through the renderer every other refusal
// uses (`dispatch/render.ts`).
export class InitRefused extends Data.TaggedError("InitRefused")<{
  readonly detail: string;
}> {}

export interface InitArgs {
  readonly base: Option.Option<string>;
  readonly image: Option.Option<string>;
  // Report drift and write nothing (T116).
  readonly diff: boolean;
}

const VALUE_FLAGS = { "--base": "base", "--image": "image" } as const;

type ValueFlag = keyof typeof VALUE_FLAGS;

const isValueFlag = (word: string): word is ValueFlag => Object.hasOwn(VALUE_FLAGS, word);

const refused = (detail: string): InitRefused =>
  new InitRefused({ detail: `${detail} (usage: ${INIT_USAGE})` });

// The words after `init`. A flag given twice is refused rather than resolved
// by position: two answers to one question is not something to pick between.
export const parseInitArgv = (
  argv: ReadonlyArray<string>,
): Either.Either<InitArgs, InitRefused> => {
  const values: { base: Option.Option<string>; image: Option.Option<string> } = {
    base: Option.none(),
    image: Option.none(),
  };
  let diff = false;
  let at = 0;
  while (at < argv.length) {
    const word = argv[at]!;
    if (word === "--diff") {
      if (diff) {
        return Either.left(refused("--diff given twice"));
      }
      diff = true;
      at += 1;
      continue;
    }
    if (!isValueFlag(word)) {
      return Either.left(refused(`unknown init flag: ${word}`));
    }
    const value = argv[at + 1];
    if (value === undefined || value.trim() === "" || value.startsWith("--")) {
      return Either.left(refused(`${word} needs a value`));
    }
    const key = VALUE_FLAGS[word];
    if (Option.isSome(values[key])) {
      return Either.left(refused(`${word} given twice`));
    }
    values[key] = Option.some(value);
    at += 2;
  }
  if (diff) {
    const configured = Option.isSome(values.base)
      ? "--base"
      : Option.isSome(values.image)
        ? "--image"
        : undefined;
    if (configured !== undefined) {
      return Either.left(
        refused(
          `--diff writes nothing, and ${configured} configures a write — give one or the other`,
        ),
      );
    }
  }
  return Either.right({ ...values, diff });
};
