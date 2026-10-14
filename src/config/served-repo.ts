// Which repo this invocation serves (19 §1): an explicit `--repo-root <dir>`,
// peeled off the argv at the composition root **before** the `argv[0]` switch,
// because `status` and `doctor` never reach `@effect/cli`'s parser and would
// otherwise never see it. The committed shim always passes it, computed from
// its own location — the shim sits inside the served repo, so where the file
// is names the repo for free, the same move `packageRoot` makes from
// `import.meta.url`. With no flag the caller falls back to
// `findRepoRoot(packageRoot)`, the self-hosted case.
//
// Nothing here infers a repo: the value is taken as given, and nothing walks
// up from it. Three shapes were rejected in 19 §1 — walking up from the
// working directory (AGENTS.md: "the point is that the working directory
// stopped mattering"), a `SPEEPOBOX_*` environment variable (the config
// provider's namespace, so it would read as a config key), and a config key
// (circular: config is found *through* the repo root).
//
// Plain module, no tag (SPEC §2): pure, so a fake buys nothing. It lives in
// its own file rather than in `bin.ts` because importing the entrypoint runs
// the CLI — nothing that owes an assertion stays there (AGENTS.md), so the
// peel is tested here and `bin.ts` calls it in one line.
import { isAbsolute } from "node:path";
import { Data, Either, Option } from "effect";

export const REPO_ROOT_FLAG = "--repo-root";

// The options `@effect/cli` declares with a value (`dispatch/command.ts`), by
// name. The token after one of these is that option's **value**, not an option
// of its own: the shell strips the quotes long before an argv reaches this
// process, so `--feedback "--repo-root=/x"` arrives as two ordinary elements
// and nothing about their shape says which is which. Position is what says it.
//
// Without this the scan below would peel a `--repo-root` out of somebody's
// feedback text — and in the bare spelling it would swallow the *next* token as
// the served repo, silently dispatching against a repo nobody named.
//
// Duplicated from the parser deliberately, and kept honest by a test rather
// than by review: `served-repo.test.ts` reads `command.ts` and fails when the
// two disagree, so an option added there without a line here breaks the suite
// instead of quietly reopening the hole. The peel cannot ask the parser
// directly — it runs before it, which is the whole reason this module exists.
export const VALUE_OPTION_NAMES: ReadonlyArray<string> = [
  "base",
  "branch",
  // The feature run's pair (T73). Neither carries free text the way the two
  // below do, but the rule is about *taking a value* and not about what the
  // value says: an option whose value is skipped by nobody is an option whose
  // value the scan below can read as a flag.
  "feature",
  "feedback",
  "issues",
  "resume",
  // `--task` carries free text exactly as `--feedback` does (T67), so it needs
  // the same skip for the same reason.
  "task",
];

// One line on stderr and exit 1, in the shape every other refusal takes:
// `renderFailure` renders anything carrying a `detail`, and `bin.ts` hands
// this to the same `reportFailure` the dispatch surface uses.
export class RepoRootRefused extends Data.TaggedError("RepoRootRefused")<{
  readonly detail: string;
}> {}

export interface PeeledArgv {
  // The flag's value, or `None` for the self-hosted fallback the caller
  // supplies — this module names no default, because `packageRoot` is not its
  // question.
  readonly repoRoot: Option.Option<string>;
  // The argv with the flag and its value removed, which is what the `argv[0]`
  // switch, `appLayerFor`, and `dispatchCli` see: `--repo-root` is read here
  // and nowhere below.
  readonly argv: ReadonlyArray<string>;
}

// A relative value is refused rather than resolved: resolving it would read
// the working directory, which 19 §1 retired from every answer this tool
// gives. A missing value is the same refusal's other half — `--repo-root` as
// the last word names no directory at all.
const refusal = (detail: string) => Either.left(new RepoRootRefused({ detail }));

export const peelRepoRoot = (
  argv: ReadonlyArray<string>,
): Either.Either<PeeledArgv, RepoRootRefused> => {
  const rest: Array<string> = [];
  // Last spelling wins, and every one of them is peeled: a repeated flag is a
  // command line's own ordinary rule, and leaving an earlier copy in `rest`
  // would hand `@effect/cli` a flag it does not declare.
  let given = Option.none<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    // A value-taking option carries its value with it, untouched: that value
    // may say anything at all, including this flag's own spelling. The `=`
    // spelling needs no skip — it is one token, and falls through below.
    if (VALUE_OPTION_NAMES.some((name) => arg === `--${name}`)) {
      rest.push(arg);
      const value = argv[index + 1];
      if (value !== undefined) {
        rest.push(value);
        index += 1;
      }
      continue;
    }
    if (arg === REPO_ROOT_FLAG) {
      const value = argv[index + 1];
      if (value === undefined) {
        return refusal(`${REPO_ROOT_FLAG} needs a directory: the repo this invocation serves`);
      }
      given = Option.some(value);
      index += 1;
      continue;
    }
    if (arg.startsWith(`${REPO_ROOT_FLAG}=`)) {
      given = Option.some(arg.slice(REPO_ROOT_FLAG.length + 1));
      continue;
    }
    rest.push(arg);
  }
  if (Option.isSome(given) && !isAbsolute(given.value)) {
    return refusal(
      `${REPO_ROOT_FLAG} must be an absolute path, and '${given.value}' is not — the served repo is named in full, never resolved against the working directory`,
    );
  }
  return Either.right({ repoRoot: given, argv: rest });
};
