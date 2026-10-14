// `Forge` (SPEC §2): the pull request half of a run, over the `gh` CLI and
// through the subprocess chokepoint. It is the one network surface with no
// local oracle — nothing on this host can answer "is there an open PR for this
// branch" — which is why it is a tag at all: the seam a fake stands in for.
//
// Named for its role, not its vendor, exactly as `Sandbox` and `AgentCli` are
// (AGENTS.md), and **no provider abstraction is built behind it** (05 Q22):
// the one CLI it knows about is named once, below.
//
// Edit-or-create is bash's (`run.sh:1714-1722`): view the branch's PR, and if
// one is open, edit it; otherwise create a draft. Re-runs land on the same
// branch, so a second dispatch updates the PR the first one opened rather than
// stacking duplicates.
//
// **The body always travels on stdin** (`--body-file -`), never as an
// argument: a description an agent wrote is arbitrary markdown — backticks,
// `$(…)`, and megabytes of it — and argv is neither big enough nor quiet
// enough for that. It is the same property the prompt pipe rests on (T9).
import { CommandExecutor } from "@effect/platform";
import { Context, Data, Effect, Either, Layer, Option, Ref, Schema } from "effect";
import { Git } from "../git/git.ts";
import { parseRepoSlug, repoSlugArg, type RepoSlug } from "../git/repo-slug.ts";
import { exec, type ExecResult, execStreamed } from "../internal/exec.ts";
import type { PullRequest } from "../ledger/record.ts";

// `gh` PR view / create / edit failures (SPEC §3). Typed by the outcome-row
// test: the PR happens after the push, so a forge that will not answer is a
// run that started, pushed, and owes a `failed` row at stage `pr` (matrix row
// 15) — the commits are already home, which is why this failure is expensive
// but not destructive.
export class ForgeError extends Data.TaggedError("ForgeError")<{
  readonly detail: string;
}> {}

// The forge CLI, and the whole of what this package knows about it.
const FORGE_CLI_BINARY = "gh";

// Which repo a call names, beside whatever it already asked (T39). Every
// `ForgeShape` method takes one, the way every `Git` operation takes a
// `repo: string` (`git.ts`) — a field on the operation's own arguments, not a
// second service, so a call cannot be written without one.
export interface PrViewOptions {
  readonly repo: RepoSlug;
  readonly branch: string;
}

// What a PR is created from. `base` is the *ref* this run was dispatched
// against; turning it into the branch the forge wants happens below, once.
export interface PrCreateOptions {
  readonly repo: RepoSlug;
  readonly branch: string;
  readonly base: string;
  readonly title: string;
  readonly body: string;
}

export interface PrEditOptions {
  readonly repo: RepoSlug;
  readonly branch: string;
  readonly body: string;
}

// What a view answers with: the pair the ledger records, and what the PR says
// today. The two halves travel together because one `gh pr view` answers both,
// and they are **nested rather than flattened** — a `PullRequest` is what the
// row records, and a shape that merely happened to be assignable to one would
// let a title reach the ledger the day that record grows a field.
//
// The title and body are what a resuming run quotes into its prompt
// (T17). Review comments are deliberately not here: reviewer-authored text
// driving an unattended agent is a prompt-injection channel, and the human
// folds what matters into `--feedback` themselves (run.sh's `gh pr view`
// fetch, whose own comment gives this reason).
export interface ViewedPr {
  readonly pr: PullRequest;
  readonly title: string;
  readonly body: string;
}

export interface ForgeShape {
  // The branch's open PR, or nothing. Absence is an answer rather than a
  // failure: a branch nobody has opened a PR for is the ordinary first-run
  // case, and it is what decides create-vs-edit.
  readonly prView: (options: PrViewOptions) => Effect.Effect<Option.Option<ViewedPr>, ForgeError>;
  // A **draft** PR (`run.sh:1719`): the human merge gate is the whole point of
  // the tool, so a run never opens one that looks ready.
  readonly prCreate: (options: PrCreateOptions) => Effect.Effect<PullRequest, ForgeError>;
  // The body of an already-open PR, replaced wholesale. It answers with
  // nothing: the caller already holds the `PullRequest` the view handed it,
  // and asking the forge to say it again would be a second answer to a
  // question that has one.
  readonly prEdit: (options: PrEditOptions) => Effect.Effect<void, ForgeError>;
}

export class Forge extends Context.Tag("Forge")<Forge, ForgeShape>() {}

// Which repo every `gh` call this dispatch makes acts on (T39): the served
// repo's `origin` remote, resolved **once** here and handed to `prView`,
// `prCreate`, and `prEdit` as a field on their own arguments — never a tag,
// because which repo this is is a host fact resolved at the composition root
// and passed down (AGENTS.md), the same shape `repoRoot` already is. `None`
// is a repo root whose origin cannot be read or does not name an owner and a
// repo; the dispatch's own guard turns that into a refusal naming the repo
// root, the same split `credentialFound` draws between "the composition root
// could not resolve it" and "the guard says what that means" — never a `gh`
// error about a missing ref, which is what falling back to the working
// directory used to fail as.
export const resolveForgeRepo = (
  repoRoot: string,
): Effect.Effect<Option.Option<RepoSlug>, never, Git> =>
  Effect.gen(function* () {
    const git = yield* Git;
    const origin = yield* Effect.either(git.originUrl(repoRoot));
    return Option.flatMap(Either.getRight(origin), parseRepoSlug);
  });

// `gh pr create --base` names a branch on the remote, and `--base` reaches
// this package as the ref a dispatch was given (`origin/master`) — the value
// the ledger records and the next run's default chain reads back. bash strips
// the same prefix at the same point (`run.sh:1719`). It happens here rather
// than at the call site because "the forge wants a branch name" is forge
// vocabulary, and a caller that stripped it would be deciding for a seam.
const ORIGIN_PREFIX = "origin/";

export const baseBranch = (baseRef: string): string =>
  baseRef.startsWith(ORIGIN_PREFIX) ? baseRef.slice(ORIGIN_PREFIX.length) : baseRef;

// A `gh` PR URL ends in `/pull/<number>`, and the number is read out of it
// **here**, where the URL is produced — `gh pr create` prints the URL and
// nothing else, and the record stores the pair so no call site ever parses one
// back out of the other (`ledger/record.ts`).
export const prNumberIn = (url: string): Option.Option<number> => {
  const match = /\/pull\/(\d+)(?:$|[/?#])/.exec(url);
  return match?.[1] === undefined ? Option.none() : Option.some(Number(match[1]));
};

// What `gh pr view --json number,state,url,title,body` answers with. Decoded
// rather than `--jq`-filtered (`run.sh:1714`) because this call answers two
// questions at once — is there an open PR, and which one — and a jq that
// selected on state would hand back an empty string for "closed" and for
// "gh is confused" alike.
const ViewedPullRequest = Schema.parseJson(
  Schema.Struct({
    number: Schema.Int,
    state: Schema.String,
    url: Schema.String,
    // The two fields a resuming run quotes (T17, T66). They are asked for on
    // the one view the step already makes rather than by a second call: the
    // question "is there an open PR for this branch" and the question "what
    // does it say" have one answer, and two `gh` invocations could disagree.
    title: Schema.String,
    body: Schema.String,
  }),
);

const OPEN = "OPEN";

export const ForgeLive: Layer.Layer<Forge, never, CommandExecutor.CommandExecutor> = Layer.effect(
  Forge,
  Effect.gen(function* () {
    // Captured here rather than left in every operation's requirements: a tag
    // whose methods ask for a service is a mechanism leaking through a domain
    // seam (`git/git.ts` does the same).
    const executor = yield* CommandExecutor.CommandExecutor;

    // A missing `gh` is a `ForgeError` like any other here. The dispatch that
    // reaches this has already been through the preflight that refuses a host
    // without an authenticated one (`dispatch/preflight.ts`), so this arm is
    // the binary going away mid-run.
    const missing = (): ForgeError =>
      new ForgeError({ detail: "gh CLI not found — install: https://cli.github.com" });

    const gh = (...args: ReadonlyArray<string>): Effect.Effect<ExecResult, ForgeError> =>
      exec(FORGE_CLI_BINARY, ...args).pipe(
        Effect.mapError(missing),
        Effect.provideService(CommandExecutor.CommandExecutor, executor),
      );

    // The same call for the two commands that carry a body: it goes down the
    // child's stdin and its output is collected back. `execStreamed` is the
    // chokepoint's stdin-carrying half (T9) — a forge's output is a line or
    // two rather than a narration, so the lines are collected rather than
    // reported.
    const ghWithBody = (
      body: string,
      ...args: ReadonlyArray<string>
    ): Effect.Effect<ExecResult, ForgeError> =>
      Effect.gen(function* () {
        const lines = yield* Ref.make<ReadonlyArray<string>>([]);
        const outcome = yield* execStreamed(
          {
            stdin: body,
            onLine: (line) => Ref.update(lines, (current) => [...current, line]),
          },
          FORGE_CLI_BINARY,
          ...args,
        ).pipe(Effect.mapError(missing));
        // The same `ExecResult` the read-only call answers with, so both
        // callers below read one shape: the collected lines *are* the stdout
        // the other half of the chokepoint would have handed back.
        return { ...outcome, stdout: (yield* Ref.get(lines)).join("\n") };
      }).pipe(Effect.provideService(CommandExecutor.CommandExecutor, executor));

    // A nonzero exit is a *result* at the chokepoint and a typed error here
    // (`internal/exec.ts`), carrying whatever `gh` said about it.
    const failed = (what: string, result: ExecResult): ForgeError =>
      new ForgeError({
        detail: result.stderr.trim() === "" ? what : `${what}: ${result.stderr.trim()}`,
      });

    return {
      prView: ({ repo, branch }) =>
        gh(
          "pr",
          "view",
          branch,
          "--repo",
          repoSlugArg(repo),
          "--json",
          "number,state,url,title,body",
        ).pipe(
          Effect.flatMap((result) => {
            // A branch with no PR is `gh` exiting nonzero and saying so, and
            // bash reads it exactly this way (`|| true`, `run.sh:1714`). The
            // host's `gh` is authenticated — preflight refused otherwise — so
            // the remaining reading of a failure here is "there is none",
            // and a create that follows on a genuinely broken forge fails
            // loudly a moment later.
            if (result.exitCode !== 0) {
              return Effect.succeedNone;
            }
            return Schema.decode(ViewedPullRequest)(result.stdout).pipe(
              Effect.mapError(
                (error) =>
                  new ForgeError({
                    detail: `could not read the PR for '${branch}': ${error.message}`,
                  }),
              ),
              Effect.map((viewed) =>
                viewed.state === OPEN
                  ? Option.some({
                      pr: { number: Option.some(viewed.number), url: viewed.url },
                      title: viewed.title,
                      body: viewed.body,
                    })
                  : Option.none<ViewedPr>(),
              ),
            );
          }),
        ),
      prCreate: ({ repo, branch, base, title, body }) =>
        ghWithBody(
          body,
          "pr",
          "create",
          "--repo",
          repoSlugArg(repo),
          "--draft",
          "--base",
          baseBranch(base),
          "--head",
          branch,
          "--title",
          title,
          // The body on stdin, and the only thing about it in argv is the
          // dash that says where to read it from.
          "--body-file",
          "-",
        ).pipe(
          Effect.flatMap((result) => {
            const url = result.stdout
              .split("\n")
              .map((line) => line.trim())
              .findLast((line) => line !== "");
            if (result.exitCode !== 0 || url === undefined) {
              return Effect.fail(failed(`could not open a draft PR for '${branch}'`, result));
            }
            return Effect.succeed({ number: prNumberIn(url), url });
          }),
        ),
      prEdit: ({ repo, branch, body }) =>
        ghWithBody(
          body,
          "pr",
          "edit",
          branch,
          "--repo",
          repoSlugArg(repo),
          "--body-file",
          "-",
        ).pipe(
          Effect.flatMap((result) =>
            result.exitCode === 0
              ? Effect.void
              : Effect.fail(failed(`could not update the PR for '${branch}'`, result)),
          ),
        ),
    };
  }),
);
