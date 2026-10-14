// `Forge` against the scripted executor: the argv each of the three calls
// reaches `gh` with, the body that travelled on stdin rather than in it, and
// the two answers a view can give — an open PR, and none.
//
// It is the one seam with no local oracle (SPEC §2), so what a fake proves
// here is exactly what a fake can prove: which command line and which pipe.
// Whether GitHub accepts them is the tracer's question and the dispatcher's to
// run.
import { describe, expect, it } from "@effect/vitest";
import { Effect, Either, Layer, Option, Ref } from "effect";
import {
  baseBranch,
  Forge,
  ForgeError,
  ForgeLive,
  prNumberIn,
  resolveForgeRepo,
} from "../src/forge/forge.ts";
import { type Git, GitLive } from "../src/git/git.ts";
import type { RepoSlug } from "../src/git/repo-slug.ts";
import { type ScriptedResult, scriptedExecutor } from "./support/exec-fake.ts";

const BRANCH = "bessemer-t12";
const URL = "https://github.com/acme/hae/pull/101";
const BODY = "## Overview\n\nA body with `backticks` and $(not a command).\n";
// The repo every call below names (T39) — this is the argv assertion that
// stops the regression the ticket is about: a call built without one does
// not typecheck, and this is what the rendered `--repo` is checked against.
const REPO: RepoSlug = { owner: "HireAnEsquire", name: "hae" };
const REPO_ROOT = "/srv/hae";

const forgeLayer = (
  script: Record<string, ScriptedResult>,
  recorded?: Ref.Ref<ReadonlyArray<string>>,
  fed?: Ref.Ref<ReadonlyArray<string>>,
): Layer.Layer<Forge> => ForgeLive.pipe(Layer.provide(scriptedExecutor(script, recorded, fed)));

// `resolveForgeRepo` resolves through `Git`, live — not a fake, for the same
// reason `forge.test.ts` never reaches into `git-fake.ts`: it is a caller of
// `Git.originUrl`, and what proves it right is the operation it composes,
// scripted the way `git.test.ts` scripts that operation itself.
const gitLayer = (script: Record<string, ScriptedResult>): Layer.Layer<Git> =>
  GitLive.pipe(Layer.provide(scriptedExecutor(script)));

// What the PR says today, and what a resuming run quotes out of it (T17).
const TITLE = "[bessemer] bessemer-t12";
const PR_BODY = "## Overview\n\nWhat the run before this one said it did.";

const openPr: Record<string, ScriptedResult> = {
  "gh pr view": {
    exit: 0,
    stdout: `${JSON.stringify({ number: 101, state: "OPEN", url: URL, title: TITLE, body: PR_BODY })}\n`,
  },
  "gh pr edit": { exit: 0 },
  "gh pr create": { exit: 0, stdout: `${URL}\n` },
};

// What `gh` says about a branch nobody has opened a PR for: nonzero, with the
// reason on stderr.
const noPr: Record<string, ScriptedResult> = {
  ...openPr,
  "gh pr view": { exit: 1, stderr: `no pull requests found for branch "${BRANCH}"\n` },
};

describe("prNumberIn", () => {
  it("reads the number out of a PR URL", () => {
    expect(prNumberIn(URL)).toEqual(Option.some(101));
    expect(prNumberIn(`${URL}/files`)).toEqual(Option.some(101));
  });

  // Absent, never zero: the record says a PR number is missing rather than
  // claiming PR #0.
  it("is absent for a URL carrying no number", () => {
    expect(prNumberIn("https://github.com/acme/hae/pulls")).toEqual(Option.none());
  });
});

describe("baseBranch", () => {
  it("strips the remote-tracking prefix the forge does not want", () => {
    expect(baseBranch("origin/master")).toBe("master");
    // Anything else is already a branch name, including one that merely looks
    // like a remote's.
    expect(baseBranch("master")).toBe("master");
    expect(baseBranch("upstream/master")).toBe("upstream/master");
  });
});

describe("Forge", () => {
  it.effect("views the branch's open PR as a number and a URL, with what it says today", () =>
    Effect.gen(function* () {
      const commands = yield* Ref.make<ReadonlyArray<string>>([]);
      const viewed = yield* Effect.flatMap(Forge, (forge) =>
        forge.prView({ repo: REPO, branch: BRANCH }),
      ).pipe(Effect.provide(forgeLayer(openPr, commands)));

      // The pair the row records, and — nested beside it rather than mixed in
      // with it — the title and body a resuming run's prompt quotes (T17).
      expect(viewed).toEqual(
        Option.some({
          pr: { number: Option.some(101), url: URL },
          title: TITLE,
          body: PR_BODY,
        }),
      );
      // One call answers both questions: a second `gh pr view` for the text
      // could disagree with the one that decided create-vs-edit. `--repo` is
      // the mechanism this ticket exists for (T39): the repo it acts on comes
      // from the argument, never from wherever `gh` happens to run.
      expect(yield* Ref.get(commands)).toEqual([
        `gh pr view ${BRANCH} --repo ${REPO.owner}/${REPO.name} --json number,state,url,title,body`,
      ]);
    }),
  );

  it.effect("answers with nothing for a branch that has no PR", () =>
    Effect.gen(function* () {
      const forge = yield* Forge;
      expect(yield* forge.prView({ repo: REPO, branch: BRANCH })).toEqual(Option.none());
    }).pipe(Effect.provide(forgeLayer(noPr))),
  );

  // A closed or merged PR is not one to update: the branch is re-dispatchable
  // and the next run opens a fresh draft, exactly as bash's `select(.state ==
  // "OPEN")` does.
  it.effect("answers with nothing for a PR that is not open", () =>
    Effect.gen(function* () {
      const forge = yield* Forge;
      expect(yield* forge.prView({ repo: REPO, branch: BRANCH })).toEqual(Option.none());
    }).pipe(
      Effect.provide(
        forgeLayer({
          ...openPr,
          "gh pr view": {
            exit: 0,
            stdout: `${JSON.stringify({ number: 101, state: "MERGED", url: URL, title: TITLE, body: PR_BODY })}\n`,
          },
        }),
      ),
    ),
  );

  it.effect("creates a draft PR against the base branch, with the body on stdin", () =>
    Effect.gen(function* () {
      const commands = yield* Ref.make<ReadonlyArray<string>>([]);
      const fed = yield* Ref.make<ReadonlyArray<string>>([]);
      const created = yield* Effect.flatMap(Forge, (forge) =>
        forge.prCreate({
          repo: REPO,
          branch: BRANCH,
          base: "origin/master",
          title: `[bessemer] ${BRANCH}`,
          body: BODY,
        }),
      ).pipe(Effect.provide(forgeLayer(noPr, commands, fed)));

      expect(created).toEqual({ number: Option.some(101), url: URL });
      // `--repo`, `--draft`, the base with its remote-tracking prefix off, and
      // both ends of the PR named.
      expect(yield* Ref.get(commands)).toEqual([
        `gh pr create --repo ${REPO.owner}/${REPO.name} --draft --base master --head ${BRANCH} --title [bessemer] ${BRANCH} --body-file -`,
      ]);
      // **The property this seam rests on**: the body is in the pipe and
      // nowhere in argv, so backticks and `$(…)` in an agent-written
      // description arrive literally (`run.sh:1719`).
      expect(yield* Ref.get(fed)).toEqual([BODY]);
      expect((yield* Ref.get(commands))[0]).not.toContain("Overview");
    }),
  );

  it.effect("edits the open PR's body, also on stdin", () =>
    Effect.gen(function* () {
      const commands = yield* Ref.make<ReadonlyArray<string>>([]);
      const fed = yield* Ref.make<ReadonlyArray<string>>([]);
      yield* Effect.flatMap(Forge, (forge) =>
        forge.prEdit({ repo: REPO, branch: BRANCH, body: BODY }),
      ).pipe(Effect.provide(forgeLayer(openPr, commands, fed)));

      expect(yield* Ref.get(commands)).toEqual([
        `gh pr edit ${BRANCH} --repo ${REPO.owner}/${REPO.name} --body-file -`,
      ]);
      expect(yield* Ref.get(fed)).toEqual([BODY]);
    }),
  );

  // Typed, and carrying what `gh` said: the commits are already pushed, so the
  // line a dispatcher reads is the whole of what is left to act on.
  it.effect("fails a create the forge refused, as a typed ForgeError", () =>
    Effect.gen(function* () {
      const outcome = yield* Effect.either(
        Effect.flatMap(Forge, (forge) =>
          forge.prCreate({
            repo: REPO,
            branch: BRANCH,
            base: "origin/master",
            title: "[bessemer]",
            body: BODY,
          }),
        ),
      ).pipe(
        Effect.provide(
          forgeLayer({
            ...noPr,
            "gh pr create": { exit: 1, stderr: "pull request create failed: no commits\n" },
          }),
        ),
      );

      expect(Either.isLeft(outcome)).toBe(true);
      if (Either.isLeft(outcome)) {
        expect(outcome.left).toBeInstanceOf(ForgeError);
        expect(outcome.left.detail).toContain(`could not open a draft PR for '${BRANCH}'`);
        expect(outcome.left.detail).toContain("no commits");
      }
    }),
  );

  it.effect("fails an edit the forge refused, as a typed ForgeError", () =>
    Effect.gen(function* () {
      const outcome = yield* Effect.either(
        Effect.flatMap(Forge, (forge) => forge.prEdit({ repo: REPO, branch: BRANCH, body: BODY })),
      ).pipe(
        Effect.provide(
          forgeLayer({ ...openPr, "gh pr edit": { exit: 1, stderr: "GraphQL: Not Found\n" } }),
        ),
      );

      expect(Either.isLeft(outcome)).toBe(true);
      if (Either.isLeft(outcome)) {
        expect(outcome.left.detail).toContain(`could not update the PR for '${BRANCH}'`);
        expect(outcome.left.detail).toContain("Not Found");
      }
    }),
  );

  // The `gh` binary going away mid-run — the case preflight cannot cover,
  // since it asked before the run started.
  it.effect("fails a create with no gh binary at all", () =>
    Effect.gen(function* () {
      const outcome = yield* Effect.either(
        Effect.flatMap(Forge, (forge) =>
          forge.prCreate({ repo: REPO, branch: BRANCH, base: "master", title: "t", body: BODY }),
        ),
      ).pipe(Effect.provide(forgeLayer({})));

      expect(Either.isLeft(outcome)).toBe(true);
      if (Either.isLeft(outcome)) {
        expect(outcome.left.detail).toContain("gh CLI not found");
      }
    }),
  );
});

// The composition root's own resolution (T39): `Git.originUrl` and
// `parseRepoSlug`, composed once into the answer `bin.ts` resolves before any
// `gh` call is built. `None` is the one outcome the whole ticket exists to
// make unrepresentable past this point — `forgeRepoFound` (`guards.ts`) is
// what turns it into a refusal, and this is what feeds that guard its input.
describe("resolveForgeRepo", () => {
  it.effect("resolves the slug off the repo's 'origin' remote", () =>
    Effect.gen(function* () {
      const slug = yield* resolveForgeRepo(REPO_ROOT).pipe(
        Effect.provide(
          gitLayer({
            "git -C": { exit: 0, stdout: "https://github.com/acme/hae.git\n" },
          }),
        ),
      );

      expect(slug).toEqual(Option.some({ owner: "acme", name: "hae" }));
    }),
  );

  // No 'origin' configured — the same read `doctor`'s probe 5 fails on — is
  // an absence here, not a propagated GitError: the guard downstream is what
  // decides that means a refusal, and it decides it off an Option.
  it.effect("answers None when the repo's origin cannot be read", () =>
    Effect.gen(function* () {
      const slug = yield* resolveForgeRepo(REPO_ROOT).pipe(
        Effect.provide(gitLayer({ "git -C": { exit: 128, stderr: "fatal: no such remote\n" } })),
      );

      expect(slug).toEqual(Option.none());
    }),
  );

  // A readable remote that names no owner and no repo — a local path, chief
  // among them (`repo-slug.test.ts`) — is the same None: the parse failing is
  // not the git read failing, but the outcome the guard sees is identical.
  it.effect("answers None when the origin resolves but names no owner/repo", () =>
    Effect.gen(function* () {
      const slug = yield* resolveForgeRepo(REPO_ROOT).pipe(
        Effect.provide(gitLayer({ "git -C": { exit: 0, stdout: "/srv/hae\n" } })),
      );

      expect(slug).toEqual(Option.none());
    }),
  );
});
