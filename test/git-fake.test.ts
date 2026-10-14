// The `Git` fake's own options fields, asked directly with nothing above
// them. T45's two came first — `worktrees` and `dispatcherFreshness` used to
// die (`test/support/git-fake.ts`), and the cases below are the fake answering
// instead. That was the ticket's first green piece: it does not touch a
// dispatch, so it goes green before the preflight cases that read the same two
// fields through it can. T70's `fetch` joins them at the bottom, for the same
// reason and on the same terms.
import { describe, expect, it } from "@effect/vitest";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect, Either, Option, Ref } from "effect";
import { Git } from "../src/git/git.ts";
import { fakeBlobId, fakeGit, type GitCall, objectNameFor } from "./support/git-fake.ts";

const REPO = "/repo";

describe("the Git fake's worktrees and dispatcherFreshness options", () => {
  it.scoped("answers worktrees from options, a detached HEAD entry included", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<GitCall>>([]);
      const worktrees = [
        { path: REPO, branch: Option.some("master") },
        { path: "/other-worktree", branch: Option.none<string>() },
      ];
      const result = yield* Git.pipe(
        Effect.flatMap((git) => git.worktrees(REPO)),
        Effect.provide(fakeGit(calls, { worktrees })),
      );
      expect(result).toEqual(worktrees);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped("answers with no worktrees when the option is unset", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<GitCall>>([]);
      const result = yield* Git.pipe(
        Effect.flatMap((git) => git.worktrees(REPO)),
        Effect.provide(fakeGit(calls)),
      );
      expect(result).toEqual([]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped("answers dispatcherFreshness from options", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<GitCall>>([]);
      const verdict = {
        _tag: "Stale" as const,
        missing: ["7777777777777777777777777777777777777777"],
      };
      const result = yield* Git.pipe(
        Effect.flatMap((git) => git.dispatcherFreshness({ repo: REPO, base: "origin/master" })),
        Effect.provide(fakeGit(calls, { dispatcherFreshness: verdict })),
      );
      expect(result).toEqual(verdict);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped("answers Current when the option is unset, the ordinary case", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<GitCall>>([]);
      const result = yield* Git.pipe(
        Effect.flatMap((git) => git.dispatcherFreshness({ repo: REPO, base: "origin/master" })),
        Effect.provide(fakeGit(calls)),
      );
      expect(result).toEqual({ _tag: "Current" });
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
});

// And the option T70 gave it: the dispatch's own fetch, recorded like every
// other call and refusable like the clone and the push beside it — a host
// with no network is a `GitError` the guard turns into its refusal.
describe("the Git fake's fetch", () => {
  it.scoped("records the repo and the remote it was asked to fetch", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<GitCall>>([]);
      yield* Git.pipe(
        Effect.flatMap((git) => git.fetch({ repo: REPO, remote: "origin" })),
        Effect.provide(fakeGit(calls)),
      );
      expect(yield* Ref.get(calls)).toEqual([{ _tag: "Fetch", repo: REPO, remote: "origin" }]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped("fails with the scripted line, having recorded the attempt", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<GitCall>>([]);
      const outcome = yield* Effect.either(
        Git.pipe(
          Effect.flatMap((git) => git.fetch({ repo: REPO, remote: "origin" })),
          Effect.provide(
            fakeGit(calls, { fetchFails: "could not fetch 'origin': no route to host" }),
          ),
        ),
      );
      expect(Either.isLeft(outcome)).toBe(true);
      if (Either.isLeft(outcome)) {
        expect(outcome.left.detail).toBe("could not fetch 'origin': no route to host");
      }
      expect((yield* Ref.get(calls)).map((call) => call._tag)).toEqual(["Fetch"]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
});

// And the pair T71 gave it: a tree read keyed by `<ref>:<path>` and a batch
// over the ids it minted, which is what lets a case script *what a ref holds*
// rather than what git printed.
describe("the Git fake's trees", () => {
  const TIP = "1111111111111111111111111111111111111111";
  const FOLDER = "feature/issues";
  const KEY = `${TIP}:${FOLDER}`;

  it.scoped("lists the scripted directory and reads its files back by id", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<GitCall>>([]);
      const trees = { [KEY]: { "T71.md": "# T71\n", "T72.md": "# T72\n" } };
      const read = yield* Git.pipe(
        Effect.flatMap((git) =>
          Effect.gen(function* () {
            const entries = yield* git.listTree({ repo: REPO, ref: TIP, path: FOLDER });
            const ids = Option.getOrElse(entries, () => []).map((entry) => entry.id);
            return yield* git.readBlobs({ repo: REPO, ids });
          }),
        ),
        Effect.provide(fakeGit(calls, { trees })),
      );

      expect([...read]).toEqual([
        [fakeBlobId(KEY, "T71.md"), "# T71\n"],
        [fakeBlobId(KEY, "T72.md"), "# T72\n"],
      ]);
      // Two files, two calls — the batch is the fake's shape as much as the
      // live layer's (T71).
      expect(yield* Ref.get(calls)).toEqual([
        { _tag: "ListTree", repo: REPO, ref: TIP, path: FOLDER },
        {
          _tag: "ReadBlobs",
          repo: REPO,
          ids: [fakeBlobId(KEY, "T71.md"), fakeBlobId(KEY, "T72.md")],
        },
      ]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // An unscripted key is a directory that ref does not carry, which is an
  // answer: the same `None` a real git's silent exit-zero comes back as.
  it.scoped("answers None for a ref and path nothing scripted", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const calls = yield* Ref.make<ReadonlyArray<GitCall>>([]);
        const entries = yield* Git.pipe(
          Effect.flatMap((git) => git.listTree({ repo: REPO, ref: TIP, path: FOLDER })),
          Effect.provide(fakeGit(calls, { trees: { [`other:${FOLDER}`]: {} } })),
        );
        expect(entries).toEqual(Option.none());
      }),
    ).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped("fails a blob nobody scripted, as a real repo fails an id it does not hold", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<GitCall>>([]);
      const outcome = yield* Effect.either(
        Git.pipe(
          Effect.flatMap((git) => git.readBlobs({ repo: REPO, ids: ["blob:nowhere"] })),
          Effect.provide(fakeGit(calls)),
        ),
      );
      expect(Either.isLeft(outcome)).toBe(true);
      if (Either.isLeft(outcome)) {
        expect(outcome.left.detail).toContain("is not a blob in this repo");
      }
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped("fails the tree read with the scripted line", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<GitCall>>([]);
      const outcome = yield* Effect.either(
        Git.pipe(
          Effect.flatMap((git) => git.listTree({ repo: REPO, ref: "nope", path: FOLDER })),
          Effect.provide(fakeGit(calls, { listTreeFails: "fatal: Not a valid object name nope" })),
        ),
      );
      expect(Either.isLeft(outcome)).toBe(true);
      expect((yield* Ref.get(calls)).map((call) => call._tag)).toEqual(["ListTree"]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
});

// And the pair T72 gave it: every ref the case scripted, and the tolerant
// read of one path at each of them. The second is where this fake differs
// from itself — `readBlobs` fails an id nobody scripted, and `readObjects`
// answers nothing about a name nobody scripted, because that is a ref whose
// tree does not carry the file.
describe("the Git fake's refs and object reads", () => {
  const TIP = "1111111111111111111111111111111111111111";
  const OTHER = "2222222222222222222222222222222222222222";
  const FOLDER = "feature/issues";

  it.scoped("answers the scripted refs, and records the ask", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<GitCall>>([]);
      const refs = [
        { name: "refs/heads/demo-target", sha: TIP },
        { name: "refs/remotes/origin/other", sha: OTHER },
      ];
      const listed = yield* Git.pipe(
        Effect.flatMap((git) => git.forEachRef({ repo: REPO })),
        Effect.provide(fakeGit(calls, { refs })),
      );

      expect(listed).toEqual(refs);
      expect(yield* Ref.get(calls)).toEqual([{ _tag: "ForEachRef", repo: REPO }]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // Unscripted is a repo holding no refs, which is an answer and not a gap —
  // there is nothing for a scan to find in it.
  it.scoped("answers no refs when the option is unset", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<GitCall>>([]);
      const listed = yield* Git.pipe(
        Effect.flatMap((git) => git.forEachRef({ repo: REPO })),
        Effect.provide(fakeGit(calls)),
      );
      expect(listed).toEqual([]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped("fails the ref listing with the scripted line, having recorded the attempt", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<GitCall>>([]);
      const outcome = yield* Effect.either(
        Git.pipe(
          Effect.flatMap((git) => git.forEachRef({ repo: REPO })),
          Effect.provide(fakeGit(calls, { forEachRefFails: "fatal: not a git repository" })),
        ),
      );
      expect(Either.isLeft(outcome)).toBe(true);
      expect((yield* Ref.get(calls)).map((call) => call._tag)).toEqual(["ForEachRef"]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped("reads a scripted tree's file by object name, and skips the ones nobody has", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<GitCall>>([]);
      const here = objectNameFor(`${TIP}:${FOLDER}`, "T72.md");
      const nowhere = objectNameFor(`${OTHER}:${FOLDER}`, "T72.md");
      const objects = yield* Git.pipe(
        Effect.flatMap((git) => git.readObjects({ repo: REPO, names: [here, nowhere] })),
        Effect.provide(
          fakeGit(calls, { trees: { [`${TIP}:${FOLDER}`]: { "T72.md": "# T72\n" } } }),
        ),
      );

      // The ref that carries the file answers with its text; the ref that does
      // not is absent, which is git's own `missing` line as an answer.
      expect([...objects]).toEqual([[here, "# T72\n"]]);
      expect(yield* Ref.get(calls)).toEqual([
        { _tag: "ReadObjects", repo: REPO, names: [here, nowhere] },
      ]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
});
