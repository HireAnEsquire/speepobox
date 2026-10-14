// T122: what a **release** is, read the one way every caller reads it —
// `init`'s no-release warning (T124), `upgrade` (T128), and `doctor`'s
// upstream row (T129). A plain module beside `dispatcher-revision.ts`, and
// for its reason: it asks about the tool's own source, never about a served
// repo, so it takes a repo path rather than the `Git` tag. The path is
// `packageRepoRoot`, handed down from `bin.ts`, which already computes it —
// `doctor.ts` may not import `packageRoot` (SPEC §9), and taking it as a
// parameter keeps this module from needing to.
//
// Under the shim that repo is the package cache entry, whose `origin` is the
// release URL (SPEC §6's contract, item 4), so the remote read names `origin`
// and TS holds no second copy of the URL.
import type { CommandExecutor } from "@effect/platform/CommandExecutor";
import { Array as Arr, Data, Duration, Effect, Option, Order } from "effect";
import { execUnder, exec, type ExecResult } from "../internal/exec.ts";
import { repoArgs } from "./repo-args.ts";

export interface Release {
  readonly tag: string;
  readonly number: number;
  readonly commit: string;
}

// What a failed read says: git's own line, or that it timed out. What it
// *means* is the caller's — an `ok` row in `doctor`, a refusal in `upgrade`.
export class ReleaseReadError extends Data.TaggedError("ReleaseReadError")<{
  readonly detail: string;
}> {}

// F11: `v` and a positive number with no leading zero, and nothing else.
// `v0`, `v01`, `v1.2`, `V1` and the repo's other tags are not releases, and
// are ignored without comment.
const RELEASE_TAG = /^v[1-9][0-9]*$/;

export const isReleaseTag = (name: string): boolean => RELEASE_TAG.test(name);

export const releaseNumber = (name: string): Option.Option<number> =>
  isReleaseTag(name) ? Option.some(Number(name.slice(1))) : Option.none();

const byNumber: Order.Order<Release> = Order.mapInput(Order.number, (release) => release.number);

// F13: `git ls-remote --tags` prints `<sha>\trefs/tags/<name>` per tag and,
// for an annotated one, a second `<sha>\trefs/tags/<name>^{}` naming the
// commit it peels to. The peeled line wins where there is one; a lightweight
// tag has none, and its bare line already names the commit. Sorted by number.
export const parseLsRemoteTags = (output: string): ReadonlyArray<Release> => {
  const bare = new Map<string, string>();
  const peeled = new Map<string, string>();
  for (const line of output.split("\n")) {
    const [sha, ref] = line.trim().split(/\s+/);
    if (sha === undefined || ref === undefined || !ref.startsWith("refs/tags/")) {
      continue;
    }
    const name = ref.slice("refs/tags/".length);
    if (name.endsWith("^{}")) {
      peeled.set(name.slice(0, -"^{}".length), sha);
    } else {
      bare.set(name, sha);
    }
  }
  const releases = Arr.filterMap(Array.from(bare), ([tag, sha]) =>
    Option.map(releaseNumber(tag), (number) => ({
      tag,
      number,
      commit: peeled.get(tag) ?? sha,
    })),
  );
  return Arr.sort(releases, byNumber);
};

export const latestRelease = (releases: ReadonlyArray<Release>): Option.Option<Release> =>
  Arr.isNonEmptyReadonlyArray(releases) ? Option.some(Arr.max(releases, byNumber)) : Option.none();

// The release a full SHA is, or none. A commit carrying two releases counts
// as the higher.
export const releaseAt = (releases: ReadonlyArray<Release>, sha: string): Option.Option<Release> =>
  latestRelease(releases.filter((release) => release.commit === sha));

// The decision `upgrade` makes (T128), as a value. **Tag numbers, never
// ancestry**: the package cache entry is a depth-1 clone with no history to
// ask (F13). An untagged pin is its own answer, whatever the latest is.
export type MoveDecision =
  | { readonly _tag: "Move"; readonly from: Release; readonly to: Release }
  | { readonly _tag: "Current"; readonly release: Release }
  | { readonly _tag: "Untagged" };

export const moveDecision = (releases: ReadonlyArray<Release>, pin: string): MoveDecision =>
  Option.match(releaseAt(releases, pin), {
    onNone: () => ({ _tag: "Untagged" }),
    // The pin came out of `releases`, so the latest exists and is at least it.
    onSome: (from) => {
      const to = Option.getOrElse(latestRelease(releases), () => from);
      return to.number > from.number
        ? { _tag: "Move", from, to }
        : { _tag: "Current", release: from };
    },
  });

// F15: a remote that hangs is answered by our clock, and the interrupt closes
// the chokepoint's scope, which kills the child.
export const LS_REMOTE_TIMEOUT_SECONDS = 10;

// F15: a private `origin` with no credential would otherwise sit at a
// username prompt nobody is shown until the timeout. A per-call constant
// handed to this one child (`execUnder`, as T77 hands `GIT_INDEX_FILE`), never
// an allowlist entry: the allowlist forwards values we did not choose.
const NO_TERMINAL_PROMPT = { name: "GIT_TERMINAL_PROMPT", value: "0" } as const;

// git's own line: its first `fatal:`, which names the cause — the lines after
// it are generic advice ("Please make sure you have the correct access
// rights") that would read the same for every failure.
const gitLine = (result: ExecResult): string => {
  const lines = result.stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return (
    lines.find((line) => line.startsWith("fatal:")) ?? lines[0] ?? `git exited ${result.exitCode}`
  );
};

// T132: gh is the credential, for this one call. The scoped reset empties
// every helper the operator's config files contributed for that origin —
// without it git asks them first and then hands each one gh's token to
// `store` — and the second value is gh's own helper, the pair gh adds to its
// own fetches. Bare `gh`, found on the forwarded `PATH` by git's shell; the
// pair is argv, so the allowlist is untouched and no token is read here.
export const ghCredentialPair = (origin: string): ReadonlyArray<string> => [
  "-c",
  `credential.${origin}.helper=`,
  "-c",
  `credential.${origin}.helper=!gh auth git-credential`,
];

// The `scheme://host[:port]` a URL's credentials are looked up under, or none
// for a URL no credential helper is asked about (a path, `file://`, ssh).
export const credentialOrigin = (url: string): Option.Option<string> => {
  const match = /^(https?):\/\/(?:[^@/]*@)?([^/]+)/.exec(url.trim());
  return match === null ? Option.none() : Option.some(`${match[1]}://${match[2]}`);
};

// The remedy a refusal that tried both names (T132), in the order to try them.
export const GH_AUTH_REMEDY = "run `gh auth login`, then `gh auth setup-git`";

// The release list, as `origin` has it now. git expands `origin` first
// (`--get-url`, which applies `insteadOf`), because the credential is looked
// up for the URL git will actually reach — the release URL under the shim, or
// whatever a rewrite turns it into. An HTTPS origin is read through gh first
// and through the operator's own chain when that fails, both inside the one
// budget; any other origin needs no helper and is read once, as before.
export const readRemoteReleases = (
  packageRepoRoot: string,
): Effect.Effect<ReadonlyArray<Release>, ReleaseReadError, CommandExecutor> => {
  const lsRemote = (...config: ReadonlyArray<string>) =>
    Effect.suspend(() =>
      execUnder(
        NO_TERMINAL_PROMPT,
        "git",
        ...repoArgs(packageRepoRoot),
        ...config,
        "ls-remote",
        "--tags",
        "origin",
      ),
    ).pipe(Effect.mapError((error) => new ReleaseReadError({ detail: error.detail })));
  const listed = (result: ExecResult) =>
    result.exitCode === 0
      ? Effect.succeed(parseLsRemoteTags(result.stdout))
      : Effect.fail(new ReleaseReadError({ detail: gitLine(result) }));
  return Effect.suspend(() =>
    exec("git", ...repoArgs(packageRepoRoot), "ls-remote", "--get-url", "origin"),
  ).pipe(
    Effect.map((result) =>
      result.exitCode === 0 ? credentialOrigin(result.stdout) : Option.none<string>(),
    ),
    Effect.orElseSucceed(() => Option.none<string>()),
    Effect.flatMap(
      Option.match({
        onNone: () => lsRemote().pipe(Effect.flatMap(listed)),
        onSome: (origin) =>
          lsRemote(...ghCredentialPair(origin)).pipe(
            Effect.flatMap((viaGh) =>
              viaGh.exitCode === 0
                ? listed(viaGh)
                : lsRemote().pipe(
                    Effect.flatMap((plain) =>
                      plain.exitCode === 0
                        ? listed(plain)
                        : Effect.fail(
                            new ReleaseReadError({
                              detail:
                                `through gh: ${gitLine(viaGh)}; through git's own credentials: ` +
                                `${gitLine(plain)} — ${GH_AUTH_REMEDY}`,
                            }),
                          ),
                    ),
                  ),
            ),
          ),
      }),
    ),
    Effect.timeoutFail({
      duration: Duration.seconds(LS_REMOTE_TIMEOUT_SECONDS),
      onTimeout: () =>
        new ReleaseReadError({
          detail: `timed out after ${LS_REMOTE_TIMEOUT_SECONDS} s`,
        }),
    }),
  );
};

// The offline read (T124): the releases among the tags on the package repo's
// own `HEAD`, through the same predicate, highest last. No remote, so no
// timeout and no prompt to suppress.
export const readHeadReleases = (
  packageRepoRoot: string,
): Effect.Effect<ReadonlyArray<Release>, ReleaseReadError, CommandExecutor> =>
  Effect.gen(function* () {
    const run = (...args: ReadonlyArray<string>) =>
      Effect.suspend(() => exec("git", ...repoArgs(packageRepoRoot), ...args)).pipe(
        Effect.mapError((error) => new ReleaseReadError({ detail: error.detail })),
        Effect.flatMap((result) =>
          result.exitCode === 0
            ? Effect.succeed(result.stdout)
            : Effect.fail(new ReleaseReadError({ detail: gitLine(result) })),
        ),
      );
    const commit = (yield* run("rev-parse", "HEAD")).trim();
    const tags = yield* run("tag", "--points-at", "HEAD");
    const releases = Arr.filterMap(
      tags.split("\n").map((name) => name.trim()),
      (tag) => Option.map(releaseNumber(tag), (number) => ({ tag, number, commit })),
    );
    return Arr.sort(releases, byNumber);
  });
