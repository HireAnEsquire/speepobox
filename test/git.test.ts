// `Git`: the porcelain parse is pure and asserted as a value, and the
// operations run against the scripted executor — the same seam every other
// subprocess caller uses, which is the whole reason the chokepoint is a module
// and not a tag.
//
// Every operation's argv is asserted through `recorded`, and every one of them
// opens with `-C <repo> --git-dir=<repo>/.git` (T27, T32): "the repo is named"
// is a fact about the words a child was spawned with, so it is asserted as
// those words rather than intended in a comment. `clone` is the one that names
// no repo to run in, and its argv names both of its ends instead.
//
// The scripted executor cannot show what `-C` alone would have done — it
// answers the words, not the disk — so the discovery walk is asserted against
// a **real** git at the bottom of this file, over a fixture path that sits
// inside a repository.
import { isAbsolute, resolve } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { FileSystem } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { DateTime, Effect, Either, Layer, Option, Ref, Schema } from "effect";
import { packagePathspec } from "../src/config/paths.ts";
import {
  Git,
  GitLive,
  parseBranches,
  parseCatFileBatch,
  parseRefs,
  parseTree,
  parseWorktrees,
} from "../src/git/git.ts";
import { exec } from "../src/internal/exec.ts";
import { RepoUrl } from "../src/git/repo-url.ts";
import { type ScriptedResult, scriptedExecutor } from "./support/exec-fake.ts";

const SHA = "1111111111111111111111111111111111111111";
const MERGE_BASE = "4444444444444444444444444444444444444444";
const REPO_ROOT = "/srv/hae";
const CHECKOUT = "/runtime/checkouts/demo-target";
const BRANCH = "demo-target";
// The repo-relative directory an issue set is read out of (T71), as the
// dispatcher spelled it — never a scratch path (14, lesson 9).
const FOLDER = "feature/issues";
// And what the write half (T77) adds to those: the branch the status commit
// lands on, the scratch index its tree is built in — a path under the runtime
// root, never inside the repository — the tree that comes back out, and one
// restamped file's text.
const BRANCH_REF = `refs/heads/${BRANCH}`;
const INDEX = "/runtime/locks/demo-target.index";
const WRITTEN_TREE = "5555555555555555555555555555555555555555";
const STAMPED = "# T77 — the write\n\nStatus: Done\n";

const PORCELAIN = [
  "worktree /srv/hae",
  `HEAD ${SHA}`,
  "branch refs/heads/master",
  "",
  "worktree /srv/wt-demo",
  "HEAD 2222222222222222222222222222222222222222",
  "branch refs/heads/demo-target",
  "",
  "worktree /srv/wt-detached",
  "HEAD 3333333333333333333333333333333333333333",
  "detached",
  "",
].join("\n");

const gitLayer = (
  script: Record<string, ScriptedResult>,
  recorded?: Ref.Ref<ReadonlyArray<string>>,
  // What each child was fed on stdin, which only the batched blob read uses
  // (T71): the ids go in on the pipe, so "one `cat-file` over all of them" is
  // an assertion about this ref and not about argv.
  fed?: Ref.Ref<ReadonlyArray<string>>,
  // And the environment each child was given, which only the status commit's
  // plumbing uses (T77): `GIT_INDEX_FILE` reaches three of its five children
  // and no other spawn in the package, and that is a fact about this ref.
  environments?: Ref.Ref<ReadonlyArray<Record<string, string>>>,
): Layer.Layer<Git> =>
  GitLive.pipe(Layer.provide(scriptedExecutor(script, recorded, fed, environments)));

// The branded parse is the only door into `clone` and `fetchBack`, so a test
// hands them the same value a caller does — a local path brands verbatim.
const repoUrl = Schema.decodeSync(RepoUrl);

// How every operation but `clone` opens: the directory it runs in, and the
// repository it runs against. Spelled once here because it is one rule and not
// nine coincidences — a spelling that drifted for a single operation is the
// operation that would answer for whatever repo encloses its path (T32).
const inRepo = (repo: string): string => `git -C ${repo} --git-dir=${repo}/.git`;

describe("parseWorktrees", () => {
  it("reads the path and the branch out of each porcelain record", () => {
    expect(parseWorktrees(PORCELAIN)).toEqual([
      { path: "/srv/hae", branch: Option.some("master") },
      { path: "/srv/wt-demo", branch: Option.some("demo-target") },
      // A detached worktree holds no branch, which is an answer and not a gap.
      { path: "/srv/wt-detached", branch: Option.none() },
    ]);
  });

  it("is empty on empty output", () => {
    expect(parseWorktrees("")).toEqual([]);
  });
});

// `git ls-tree -z` over one directory (T71). The records are NUL-terminated
// and each one is `<mode> SP <type> SP <oid> TAB <path>`, with the path
// written from the repo root — so the entry's own name is what the parse has
// to answer, since that is what a caller reads a file's stem off.
const treeRecord = (mode: string, type: string, id: string, path: string): string =>
  `${mode} ${type} ${id}\t${path}\0`;

const T71_BLOB = "78981922613b2afb6025042ff6bd878ac1994e85";
const T72_BLOB = "61780798228d17af2d34fce4cfbdf35556832472";

const TREE = [
  treeRecord("100644", "blob", T71_BLOB, "feature/issues/T71-the-read.md"),
  treeRecord("100644", "blob", T72_BLOB, "feature/issues/T72-the-scan.md"),
  treeRecord("040000", "tree", "5e126ebafc912c1055aef1775494a0042ffe3291", "feature/issues/draft"),
].join("");

describe("parseTree", () => {
  it("answers each file's own name and the blob the ref holds it as", () => {
    expect(parseTree(TREE)).toEqual(
      Option.some([
        { name: "T71-the-read.md", id: T71_BLOB },
        { name: "T72-the-scan.md", id: T72_BLOB },
      ]),
    );
  });

  // No records at all is the directory not being there: git stores no empty
  // directories, so a tree that exists has something in it. That is the
  // difference `IssueStore` refuses on, and it is an `Option` rather than an
  // empty array so that the two cannot be confused.
  it("answers None on no records at all", () => {
    expect(parseTree("")).toEqual(Option.none());
  });

  // And a directory holding nothing but subdirectories is present and holds no
  // files — the records were there, and none of them was one.
  it("answers Some([]) on a directory holding only subdirectories", () => {
    expect(parseTree(treeRecord("040000", "tree", T71_BLOB, "feature/issues/draft"))).toEqual(
      Option.some([]),
    );
  });
});

// `git for-each-ref --format=%(objectname) %(refname)` (T72): the object, a
// space, and the ref's full name. Commits here rather than the blob ids above
// — a ref points at what a ref points at, and a fixture that is not the shape
// of the thing is one a reader has to translate.
const T71_TIP = "5555555555555555555555555555555555555555";
const T72_TIP = "6666666666666666666666666666666666666666";

const REFS = [
  `${T71_TIP} refs/heads/bessemer-t71`,
  `${T72_TIP} refs/remotes/origin/bessemer-t72`,
  "",
].join("\n");

describe("parseRefs", () => {
  // The full name, because that is what a refusal quotes back (T74): a local
  // branch and its remote-tracking copy are two refs a dispatcher fixes
  // differently, and short names would spell both of them `bessemer-t71`.
  it("answers each ref's full name and the object it points at", () => {
    expect(parseRefs(REFS)).toEqual([
      { name: "refs/heads/bessemer-t71", sha: T71_TIP },
      { name: "refs/remotes/origin/bessemer-t72", sha: T72_TIP },
    ]);
  });

  // A line the frame cannot read is skipped and the refs around it still
  // answer: the read is a witness, and one unreadable line is not a reason to
  // say nothing about three hundred refs.
  it("skips a line carrying no name, and keeps reading", () => {
    expect(parseRefs(`nonsense\n${T71_TIP} refs/heads/a\n`)).toEqual([
      { name: "refs/heads/a", sha: T71_TIP },
    ]);
  });

  it("is empty on empty output", () => {
    expect(parseRefs("")).toEqual([]);
  });
});

// `git for-each-ref --format=%(committerdate:unix) %(refname) refs/heads/`
// (T81): the tip's commit time in seconds, a space, and the ref's full name.
// The name comes back **bare**, because that is how `--branch` spells one and
// the picker's product is that flag's value.
const T80_COMMITTED = 1_757_000_000;
const T81_COMMITTED = 1_758_000_000;

const BRANCH_LINES = [
  `${T80_COMMITTED} refs/heads/bessemer-t80`,
  `${T81_COMMITTED} refs/heads/bessemer-t81`,
  "",
].join("\n");

describe("parseBranches", () => {
  it("answers each branch bare, with the instant its tip was committed", () => {
    expect(parseBranches(BRANCH_LINES)).toEqual([
      { name: "bessemer-t80", committedAt: DateTime.unsafeMake(T80_COMMITTED * 1000) },
      { name: "bessemer-t81", committedAt: DateTime.unsafeMake(T81_COMMITTED * 1000) },
    ]);
  });

  // git's own order, kept: `GitLive` promises none, and the recency order is
  // the picker's (T81) — a parse that sorted would be a second place the
  // order is decided.
  it("keeps the order git listed them in", () => {
    expect(
      parseBranches(`${T81_COMMITTED} refs/heads/b\n${T80_COMMITTED} refs/heads/a\n`).map(
        (branch) => branch.name,
      ),
    ).toEqual(["b", "a"]);
  });

  // A line the frame cannot read is skipped and the branches around it still
  // answer, as `parseRefs` does: this list is what a picker offers, and one
  // branch whose date git could not render is no reason to offer none. A ref
  // outside `refs/heads/` is skipped for a different reason — it is not a
  // branch `--branch` could name.
  it("skips a line with no date, and a ref that is not a local branch", () => {
    expect(
      parseBranches(
        `nonsense refs/heads/a\n${T81_COMMITTED} refs/remotes/origin/b\n${T81_COMMITTED} refs/heads/c\n`,
      ).map((branch) => branch.name),
    ).toEqual(["c"]);
  });

  it("is empty on empty output", () => {
    expect(parseBranches("")).toEqual([]);
  });
});

const encoded = (text: string): Uint8Array => new TextEncoder().encode(text);

// A header line, the object's bytes, and the newline git writes after them.
const answer = (id: string, text: string): string =>
  `${id} blob ${encoded(text).length}\n${text}\n`;

describe("parseCatFileBatch", () => {
  it("reads each object in the order the ids were fed in", () => {
    expect(parseCatFileBatch(encoded(answer(T71_BLOB, "one") + answer(T72_BLOB, "two")))).toEqual([
      { id: T71_BLOB, text: Option.some("one") },
      { id: T72_BLOB, text: Option.some("two") },
    ]);
  });

  // **The frame is counted in bytes, and this folder's files are full of em
  // dashes.** One is a single character and three bytes, so a parse counting
  // characters would take the second object's header out of the middle of the
  // first object's text — and every object after it with it.
  it("frames the objects in bytes, not in characters", () => {
    const first = "# T71 — the read\n";
    expect(parseCatFileBatch(encoded(answer(T71_BLOB, first) + answer(T72_BLOB, "two")))).toEqual([
      { id: T71_BLOB, text: Option.some(first) },
      { id: T72_BLOB, text: Option.some("two") },
    ]);
  });

  // git's own answer for an object it does not hold, which is a statement
  // about that one object: the record is that line, and the next object starts
  // after it (T72 is the caller that expects them).
  it("reads a missing object as an answer, and keeps reading", () => {
    expect(parseCatFileBatch(encoded(`deadbeef missing\n${answer(T72_BLOB, "two")}`))).toEqual([
      { id: "deadbeef", text: Option.none() },
      { id: T72_BLOB, text: Option.some("two") },
    ]);
  });

  it("is empty on empty output", () => {
    expect(parseCatFileBatch(new Uint8Array())).toEqual([]);
  });
});

describe("Git", () => {
  it.effect("resolves a revision through rev-parse, in the repo it names", () =>
    Effect.gen(function* () {
      const recorded = yield* Ref.make<ReadonlyArray<string>>([]);
      const resolved = yield* Effect.gen(function* () {
        const git = yield* Git;
        return yield* git.revParse({ repo: REPO_ROOT, rev: "origin/master^{commit}" });
      }).pipe(
        Effect.provide(
          gitLayer(
            {
              [`${inRepo(REPO_ROOT)} rev-parse --verify origin/master^{commit}`]: {
                exit: 0,
                stdout: `${SHA}\n`,
              },
            },
            recorded,
          ),
        ),
      );

      expect(resolved).toBe(SHA);
      expect(yield* Ref.get(recorded)).toEqual([
        `${inRepo(REPO_ROOT)} rev-parse --verify origin/master^{commit}`,
      ]);
    }),
  );

  // A relative repo reaches git as an absolute one. git resolves `--git-dir`
  // against `-C`'s destination rather than against the process, so the two
  // flags only name the same directory once the path is absolute — spelled
  // relatively, `-C box/x --git-dir=box/x/.git` looks for `box/x/box/x/.git`.
  // Reachable because `checkoutPathFor` is rooted at the configured
  // `runtime-root`, which a `config.toml` may spell relatively, and which bare
  // `-C` resolved against the process perfectly well before `--git-dir` sat
  // beside it. The assertion is the argv: what the path was turned into is
  // what the child was spawned with.
  it.effect("resolves a relative repo before naming it twice", () =>
    Effect.gen(function* () {
      const recorded = yield* Ref.make<ReadonlyArray<string>>([]);
      const relative = "box/checkouts/demo-target";
      yield* Effect.gen(function* () {
        const git = yield* Git;
        return yield* git.revParse({ repo: relative, rev: `refs/heads/${BRANCH}` });
      }).pipe(Effect.provide(gitLayer({ "git -C": { exit: 0, stdout: `${SHA}\n` } }, recorded)));

      expect(yield* Ref.get(recorded)).toEqual([
        `${inRepo(resolve(relative))} rev-parse --verify refs/heads/${BRANCH}`,
      ]);
      expect(isAbsolute(resolve(relative))).toBe(true);
    }),
  );

  // A nonzero exit is a result the layer classifies, not a failure the
  // chokepoint raised (SPEC §3): this is where it becomes a typed GitError.
  it.effect("fails a revision that does not resolve with a typed GitError", () =>
    Effect.gen(function* () {
      const git = yield* Git;
      const outcome = yield* Effect.either(git.revParse({ repo: REPO_ROOT, rev: "nope^{commit}" }));
      expect(Either.isLeft(outcome)).toBe(true);
      if (Either.isLeft(outcome)) {
        expect(outcome.left._tag).toBe("GitError");
        expect(outcome.left.detail).toContain("does not resolve");
        expect(outcome.left.detail).toContain("unknown revision");
      }
    }).pipe(
      Effect.provide(
        gitLayer({
          [`${inRepo(REPO_ROOT)} rev-parse --verify nope^{commit}`]: {
            exit: 128,
            stderr: "fatal: unknown revision 'nope'\n",
          },
        }),
      ),
    ),
  );

  it.effect("lists every worktree of the repo it names", () =>
    Effect.gen(function* () {
      const recorded = yield* Ref.make<ReadonlyArray<string>>([]);
      const worktrees = yield* Effect.gen(function* () {
        const git = yield* Git;
        return yield* git.worktrees(REPO_ROOT);
      }).pipe(
        Effect.provide(
          gitLayer(
            {
              [`${inRepo(REPO_ROOT)} worktree list --porcelain`]: { exit: 0, stdout: PORCELAIN },
            },
            recorded,
          ),
        ),
      );

      expect(worktrees.map((worktree) => worktree.path)).toEqual([
        "/srv/hae",
        "/srv/wt-demo",
        "/srv/wt-detached",
      ]);
      expect(yield* Ref.get(recorded)).toEqual([`${inRepo(REPO_ROOT)} worktree list --porcelain`]);
    }),
  );

  // The one definition doctor's probe 5 and the composition root's forge-repo
  // resolution both go through now (T39), rather than each shelling
  // `git remote get-url origin` on its own.
  it.effect("reads the 'origin' remote's URL, in the repo it names", () =>
    Effect.gen(function* () {
      const recorded = yield* Ref.make<ReadonlyArray<string>>([]);
      const url = yield* Effect.gen(function* () {
        const git = yield* Git;
        return yield* git.originUrl(REPO_ROOT);
      }).pipe(
        Effect.provide(
          gitLayer(
            {
              [`${inRepo(REPO_ROOT)} remote get-url origin`]: {
                exit: 0,
                stdout: "https://github.com/acme/hae.git\n",
              },
            },
            recorded,
          ),
        ),
      );

      expect(url).toBe("https://github.com/acme/hae.git");
      expect(yield* Ref.get(recorded)).toEqual([`${inRepo(REPO_ROOT)} remote get-url origin`]);
    }),
  );

  // No 'origin' configured is git exiting nonzero and saying nothing useful —
  // a typed GitError like any other unanswerable read, not a special case.
  it.effect("fails an unconfigured 'origin' with a typed GitError", () =>
    Effect.gen(function* () {
      const git = yield* Git;
      const outcome = yield* Effect.either(git.originUrl(REPO_ROOT));
      expect(Either.isLeft(outcome)).toBe(true);
      if (Either.isLeft(outcome)) {
        expect(outcome.left._tag).toBe("GitError");
        expect(outcome.left.detail).toContain("no 'origin' remote configured");
      }
    }).pipe(
      Effect.provide(
        gitLayer({ "git -C": { exit: 128, stderr: "error: No such remote 'origin'\n" } }),
      ),
    ),
  );

  // The diff boundary, taken in the repo it names and off a ref this builds
  // rather than a caller spells.
  it.effect("takes the merge-base of the base and the branch, in the repo it names", () =>
    Effect.gen(function* () {
      const recorded = yield* Ref.make<ReadonlyArray<string>>([]);
      const boundary = yield* Effect.gen(function* () {
        const git = yield* Git;
        return yield* git.mergeBase({ repo: REPO_ROOT, baseSha: SHA, branch: BRANCH });
      }).pipe(
        Effect.provide(gitLayer({ "git -C": { exit: 0, stdout: `${MERGE_BASE}\n` } }, recorded)),
      );

      expect(boundary).toBe(MERGE_BASE);
      expect(yield* Ref.get(recorded)).toEqual([
        `${inRepo(REPO_ROOT)} merge-base ${SHA} refs/heads/${BRANCH}`,
      ]);
    }),
  );

  // Unrelated histories: git exits nonzero and says nothing, and the guard
  // above this turns that into the refusal a dispatcher reads.
  it.effect("fails a merge-base of unrelated histories with a typed GitError", () =>
    Effect.gen(function* () {
      const git = yield* Git;
      const outcome = yield* Effect.either(
        git.mergeBase({ repo: REPO_ROOT, baseSha: SHA, branch: BRANCH }),
      );
      expect(Either.isLeft(outcome)).toBe(true);
      if (Either.isLeft(outcome)) {
        expect(outcome.left._tag).toBe("GitError");
        expect(outcome.left.detail).toContain("have no merge-base");
      }
    }).pipe(Effect.provide(gitLayer({ "git -C": { exit: 1 } }))),
  );

  // The containment question (T32), asked of the repo that owns the branch and
  // off a ref this builds rather than a caller spells — as the merge-base
  // above it does.
  it.effect("asks whether a branch already holds a commit, in the repo it names", () =>
    Effect.gen(function* () {
      const recorded = yield* Ref.make<ReadonlyArray<string>>([]);
      const held = yield* Effect.gen(function* () {
        const git = yield* Git;
        return yield* git.branchContains({ repo: REPO_ROOT, branch: BRANCH, commit: SHA });
      }).pipe(Effect.provide(gitLayer({ "git -C": { exit: 0 } }, recorded)));

      expect(held).toBe(true);
      expect(yield* Ref.get(recorded)).toEqual([
        `${inRepo(REPO_ROOT)} merge-base --is-ancestor ${SHA} refs/heads/${BRANCH}`,
      ]);
    }),
  );

  // Exit 1 is git's answer and not git's failure: the branch does not hold
  // these commits, which is exactly the case the salvage rescues.
  it.effect("answers no without failing when the branch does not hold the commit", () =>
    Effect.gen(function* () {
      const git = yield* Git;
      expect(yield* git.branchContains({ repo: REPO_ROOT, branch: BRANCH, commit: SHA })).toBe(
        false,
      );
    }).pipe(Effect.provide(gitLayer({ "git -C": { exit: 1 } }))),
  );

  // And every other exit code is git failing to answer. A commit this repo has
  // never seen is the reachable case — exit 128, not 1 — so "no such object"
  // arrives as a typed error here rather than as a quiet `false` that reads
  // like an answer.
  it.effect("fails a containment question git could not answer with a typed GitError", () =>
    Effect.gen(function* () {
      const git = yield* Git;
      const outcome = yield* Effect.either(
        git.branchContains({ repo: REPO_ROOT, branch: BRANCH, commit: SHA }),
      );
      expect(Either.isLeft(outcome)).toBe(true);
      if (Either.isLeft(outcome)) {
        expect(outcome.left._tag).toBe("GitError");
        expect(outcome.left.detail).toContain(`could not tell whether '${BRANCH}' already holds`);
        expect(outcome.left.detail).toContain("Not a valid commit name");
      }
    }).pipe(
      Effect.provide(
        gitLayer({
          "git -C": { exit: 128, stderr: `fatal: Not a valid commit name ${SHA}\n` },
        }),
      ),
    ),
  );

  // T44's preflight goes through this operation rather than composing the
  // question at the call site, so the argv is asserted the way every other
  // operation's is — as `-C`/`--git-dir`-scoped words, built from
  // `dispatcherFreshnessArgs` and not restated here.
  it.effect("asks the dispatcher-freshness range in the repo it names, empty is Current", () =>
    Effect.gen(function* () {
      const recorded = yield* Ref.make<ReadonlyArray<string>>([]);
      const verdict = yield* Effect.gen(function* () {
        const git = yield* Git;
        return yield* git.dispatcherFreshness({ repo: REPO_ROOT, base: "origin/main" });
      }).pipe(
        Effect.provide(
          gitLayer(
            {
              [`${inRepo(REPO_ROOT)} rev-list HEAD..origin/main -- ${packagePathspec(REPO_ROOT).join(" ")}`]:
                {
                  exit: 0,
                  stdout: "",
                },
            },
            recorded,
          ),
        ),
      );

      expect(verdict).toEqual({ _tag: "Current" });
      expect(yield* Ref.get(recorded)).toEqual([
        `${inRepo(REPO_ROOT)} rev-list HEAD..origin/main -- ${packagePathspec(REPO_ROOT).join(" ")}`,
      ]);
    }),
  );

  it.effect("reads the listed SHAs as Stale rather than failing on them", () =>
    Effect.gen(function* () {
      const git = yield* Git;
      const missing = "3".repeat(40);
      const verdict = yield* git.dispatcherFreshness({ repo: REPO_ROOT, base: "origin/main" });
      expect(verdict).toEqual({ _tag: "Stale", missing: [missing] });
    }).pipe(
      Effect.provide(
        gitLayer({
          [`${inRepo(REPO_ROOT)} rev-list HEAD..origin/main -- ${packagePathspec(REPO_ROOT).join(" ")}`]:
            {
              exit: 0,
              stdout: `${"3".repeat(40)}\n`,
            },
        }),
      ),
    ),
  );

  // A base this clone cannot resolve is `BaseUnresolvable`, not a `GitError`:
  // the caller cannot refuse a dispatcher on an answer it does not have.
  it.effect("answers BaseUnresolvable on a nonzero exit rather than failing", () =>
    Effect.gen(function* () {
      const git = yield* Git;
      const outcome = yield* Effect.either(
        git.dispatcherFreshness({ repo: REPO_ROOT, base: "origin/gone" }),
      );
      expect(outcome).toEqual(Either.right({ _tag: "BaseUnresolvable" }));
    }).pipe(
      Effect.provide(
        gitLayer({
          [`${inRepo(REPO_ROOT)} rev-list HEAD..origin/gone -- ${packagePathspec(REPO_ROOT).join(" ")}`]:
            {
              exit: 128,
              stderr: "fatal: bad revision 'origin/gone'\n",
            },
        }),
      ),
    ),
  );

  // A missing git binary is the one thing that really is a `GitError` here.
  it.effect("reports a missing git binary as a GitError", () =>
    Effect.gen(function* () {
      const git = yield* Git;
      const outcome = yield* Effect.either(
        git.dispatcherFreshness({ repo: REPO_ROOT, base: "origin/main" }),
      );
      expect(Either.isLeft(outcome)).toBe(true);
      if (Either.isLeft(outcome)) {
        expect(outcome.left.detail).toContain("git CLI not found");
      }
    }).pipe(Effect.provide(gitLayer({}))),
  );

  it.effect("clones the branch with --no-hardlinks, from the source into the checkout", () =>
    Effect.gen(function* () {
      const recorded = yield* Ref.make<ReadonlyArray<string>>([]);
      yield* Effect.gen(function* () {
        const git = yield* Git;
        yield* git.clone({ source: repoUrl(REPO_ROOT), branch: BRANCH, into: CHECKOUT });
      }).pipe(Effect.provide(gitLayer({ "git clone": { exit: 0 } }, recorded)));

      expect(yield* Ref.get(recorded)).toEqual([
        `git clone --no-hardlinks --branch ${BRANCH} ${REPO_ROOT} ${CHECKOUT}`,
      ]);
      // Named on its own as well as inside the argv above (T35): the agent
      // owns this clone, and a hardlinked object is one inode — an agent
      // writing through it would be writing into the *host* repository's
      // object store. The flag is what makes the copy a copy.
      expect((yield* Ref.get(recorded))[0]).toContain("--no-hardlinks");
    }),
  );

  // The editor lookup (T84): one question, asked of git, in the repo whose
  // config is one of the five things git consults. `var GIT_EDITOR` and not
  // `config --get core.editor` — the config is one link of a chain, and the
  // whole point of the operation is that the chain is git's.
  it.effect("asks git which editor this repo's commits open", () =>
    Effect.gen(function* () {
      const recorded = yield* Ref.make<ReadonlyArray<string>>([]);
      const editor = yield* Effect.gen(function* () {
        const git = yield* Git;
        return yield* git.editor({ repo: REPO_ROOT });
      }).pipe(
        Effect.provide(gitLayer({ "git -C": { exit: 0, stdout: "code --wait\n" } }, recorded)),
      );

      // Answered whole, arguments and all: `code --wait` is one value git
      // resolved, and a caller that split it on the first space would open an
      // editor called `code` with no `--wait` and read the file back before
      // the dispatcher had typed anything.
      expect(editor).toBe("code --wait");
      expect(yield* Ref.get(recorded)).toEqual([`${inRepo(REPO_ROOT)} var GIT_EDITOR`]);
    }),
  );

  // Git's chain ends in a literal, so there is no absence to report: an empty
  // answer is git failing to answer, and it fails like any other read here.
  it.effect("fails when git answers nothing at all", () =>
    Effect.gen(function* () {
      const git = yield* Git;
      const outcome = yield* Effect.either(git.editor({ repo: REPO_ROOT }));
      expect(Either.isLeft(outcome)).toBe(true);
      if (Either.isLeft(outcome)) {
        expect(outcome.left._tag).toBe("GitError");
        expect(outcome.left.detail).toContain("could not resolve an editor");
      }
    }).pipe(Effect.provide(gitLayer({ "git -C": { exit: 0, stdout: "\n" } }))),
  );

  // The identity read (T35), asked of the repo it reads and resolved the way
  // git resolves it: no scope flag, so the dispatching dev's own config
  // answers when this repo's does not.
  it.effect("reads one config key, in the repo it names", () =>
    Effect.gen(function* () {
      const recorded = yield* Ref.make<ReadonlyArray<string>>([]);
      const name = yield* Effect.gen(function* () {
        const git = yield* Git;
        return yield* git.readConfig({ repo: REPO_ROOT, key: "user.name" });
      }).pipe(
        Effect.provide(gitLayer({ "git -C": { exit: 0, stdout: "Ada Lovelace\n" } }, recorded)),
      );

      expect(name).toEqual(Option.some("Ada Lovelace"));
      expect(yield* Ref.get(recorded)).toEqual([`${inRepo(REPO_ROOT)} config --get user.name`]);
    }),
  );

  // Exit 1 is git's answer for a key nobody set, and it is the whole reason the
  // caller has a fallback — so it comes back as an absence rather than as an
  // error the checkout would have to recover from.
  it.effect("answers nothing, without failing, for a key nobody set", () =>
    Effect.gen(function* () {
      const git = yield* Git;
      expect(yield* git.readConfig({ repo: REPO_ROOT, key: "user.name" })).toEqual(Option.none());
    }).pipe(Effect.provide(gitLayer({ "git -C": { exit: 1 } }))),
  );

  // And a key set to nothing is the same absence spelled differently: a
  // dispatch whose commits would be authored by the empty string is the case
  // the fallback exists for just as much as an unset key is.
  it.effect("reads an empty value as no value at all", () =>
    Effect.gen(function* () {
      const git = yield* Git;
      expect(yield* git.readConfig({ repo: REPO_ROOT, key: "user.email" })).toEqual(Option.none());
    }).pipe(Effect.provide(gitLayer({ "git -C": { exit: 0, stdout: "  \n" } }))),
  );

  // Every other exit is git failing to answer — a config file it cannot parse
  // — which is a typed error like any other read's.
  it.effect("fails a config read git could not answer with a typed GitError", () =>
    Effect.gen(function* () {
      const git = yield* Git;
      const outcome = yield* Effect.either(git.readConfig({ repo: REPO_ROOT, key: "user.name" }));
      expect(Either.isLeft(outcome)).toBe(true);
      if (Either.isLeft(outcome)) {
        expect(outcome.left._tag).toBe("GitError");
        expect(outcome.left.detail).toContain("could not read 'user.name'");
        expect(outcome.left.detail).toContain("bad config line");
      }
    }).pipe(
      Effect.provide(gitLayer({ "git -C": { exit: 128, stderr: "fatal: bad config line 3\n" } })),
    ),
  );

  // The base `init` works out (T115), asked of the repo it names under
  // `--git-dir` like every other read (T27, T32).
  it.effect("reads origin/HEAD short, in the repo it names", () =>
    Effect.gen(function* () {
      const recorded = yield* Ref.make<ReadonlyArray<string>>([]);
      const head = yield* Effect.gen(function* () {
        const git = yield* Git;
        return yield* git.originHead({ repo: REPO_ROOT });
      }).pipe(
        Effect.provide(gitLayer({ "git -C": { exit: 0, stdout: "origin/trunk\n" } }, recorded)),
      );

      expect(head).toEqual(Option.some("origin/trunk"));
      expect(yield* Ref.get(recorded)).toEqual([
        `${inRepo(REPO_ROOT)} symbolic-ref -q --short refs/remotes/origin/HEAD`,
      ]);
    }),
  );

  // `-q` is what makes an unset ref exit 1 rather than 128, so the absence
  // is an answer and every other exit is git failing to give one.
  it.effect("answers nothing for an unset origin/HEAD, and fails when git cannot answer", () =>
    Effect.gen(function* () {
      const unset = yield* Effect.flatMap(Git, (git) => git.originHead({ repo: REPO_ROOT })).pipe(
        Effect.provide(gitLayer({ "git -C": { exit: 1 } })),
      );
      expect(unset).toEqual(Option.none());
      const broken = yield* Effect.flatMap(Git, (git) => git.originHead({ repo: REPO_ROOT })).pipe(
        Effect.provide(
          gitLayer({ "git -C": { exit: 128, stderr: "fatal: not a git repository\n" } }),
        ),
        Effect.either,
      );
      expect(Either.isLeft(broken)).toBe(true);
      if (Either.isLeft(broken)) {
        expect(broken.left.detail).toContain("not a git repository");
      }
    }),
  );

  // The write's whole shape is its argv (T35): the repo it names, `--local`,
  // and one key — never `--global`, which is a file belonging to a human.
  it.effect("writes one config key into the repo it names, locally", () =>
    Effect.gen(function* () {
      const recorded = yield* Ref.make<ReadonlyArray<string>>([]);
      yield* Effect.gen(function* () {
        const git = yield* Git;
        yield* git.setConfig({ repo: CHECKOUT, key: "user.email", value: "ada@example.com" });
      }).pipe(Effect.provide(gitLayer({ "git -C": { exit: 0 } }, recorded)));

      expect(yield* Ref.get(recorded)).toEqual([
        `${inRepo(CHECKOUT)} config --local user.email ada@example.com`,
      ]);
      expect((yield* Ref.get(recorded))[0]).not.toContain("--global");
    }),
  );

  it.effect("fails a config write git refused with a typed GitError", () =>
    Effect.gen(function* () {
      const git = yield* Git;
      const outcome = yield* Effect.either(
        git.setConfig({ repo: CHECKOUT, key: "user.name", value: "Ada Lovelace" }),
      );
      expect(Either.isLeft(outcome)).toBe(true);
      if (Either.isLeft(outcome)) {
        expect(outcome.left._tag).toBe("GitError");
        expect(outcome.left.detail).toContain(
          `could not write 'user.name' into the config of ${CHECKOUT}`,
        );
        expect(outcome.left.detail).toContain("could not lock config file");
      }
    }).pipe(
      Effect.provide(
        gitLayer({
          "git -C": { exit: 255, stderr: "error: could not lock config file\n" },
        }),
      ),
    ),
  );

  it.effect("fails a clone that git refuses with a typed GitError", () =>
    Effect.gen(function* () {
      const git = yield* Git;
      const outcome = yield* Effect.either(
        git.clone({ source: repoUrl(REPO_ROOT), branch: BRANCH, into: CHECKOUT }),
      );
      expect(Either.isLeft(outcome)).toBe(true);
      if (Either.isLeft(outcome)) {
        expect(outcome.left._tag).toBe("GitError");
        expect(outcome.left.detail).toContain(`could not clone '${BRANCH}'`);
        expect(outcome.left.detail).toContain("already exists");
      }
    }).pipe(
      Effect.provide(
        gitLayer({
          "git clone": {
            exit: 128,
            stderr: `fatal: destination path '${CHECKOUT}' already exists\n`,
          },
        }),
      ),
    ),
  );

  // The dispatch's own fetch (T70), and its whole shape is its argv too: the
  // verb, the remote, and not one word more. `--prune` would delete refs a
  // dispatcher owns, `--tags` would write refs nobody asked for, and a refspec
  // into `refs/heads` would move a local branch — this moves the
  // remote-tracking refs the base is about to be resolved against, which is
  // what a hand-run `git fetch origin` moves.
  it.effect("fetches the remote's tracking refs, in the repo it names", () =>
    Effect.gen(function* () {
      const recorded = yield* Ref.make<ReadonlyArray<string>>([]);
      yield* Effect.gen(function* () {
        const git = yield* Git;
        yield* git.fetch({ repo: REPO_ROOT, remote: "origin" });
      }).pipe(Effect.provide(gitLayer({ "git -C": { exit: 0 } }, recorded)));

      expect(yield* Ref.get(recorded)).toEqual([`${inRepo(REPO_ROOT)} fetch origin`]);
    }),
  );

  // A fetch that could not run is a `GitError` carrying git's own line: the
  // host is what has to be fixed, so the words a dispatcher acts on are git's
  // and not a paraphrase of ours.
  it.effect("fails a fetch git refused with a typed GitError carrying git's line", () =>
    Effect.gen(function* () {
      const git = yield* Git;
      const outcome = yield* Effect.either(git.fetch({ repo: REPO_ROOT, remote: "origin" }));
      expect(Either.isLeft(outcome)).toBe(true);
      if (Either.isLeft(outcome)) {
        expect(outcome.left._tag).toBe("GitError");
        expect(outcome.left.detail).toContain("could not fetch 'origin'");
        expect(outcome.left.detail).toContain("Could not resolve host: github.com");
      }
    }).pipe(
      Effect.provide(
        gitLayer({
          "git -C": {
            exit: 128,
            stderr: "fatal: unable to access 'origin': Could not resolve host: github.com\n",
          },
        }),
      ),
    ),
  );

  // The fetch-back's whole shape is its argv: the repo fetches *from* the
  // clone (never write-side git inside it), into the repo `-C` names, on a
  // refspec with no `+` so a rebased branch cannot rewrite the user's.
  it.effect("fetches back from the clone into the repo, fast-forward only", () =>
    Effect.gen(function* () {
      const recorded = yield* Ref.make<ReadonlyArray<string>>([]);
      yield* Effect.gen(function* () {
        const git = yield* Git;
        yield* git.fetchBack({
          from: repoUrl(CHECKOUT),
          into: REPO_ROOT,
          branch: BRANCH,
          onto: BRANCH,
        });
      }).pipe(Effect.provide(gitLayer({ "git -C": { exit: 0 } }, recorded)));

      expect(yield* Ref.get(recorded)).toEqual([
        `${inRepo(REPO_ROOT)} fetch ${CHECKOUT} refs/heads/${BRANCH}:refs/heads/${BRANCH}`,
      ]);
    }),
  );

  // The same operation with the destination the release's rescue sends to
  // (T29): one refspec, both halves named, and still no `+` — git creates a
  // ref that does not exist yet without any force, and one that does exist and
  // is not an ancestor must refuse rather than clobber a previous rescue.
  it.effect("sends the same commits onto a destination of its own, still without a force", () =>
    Effect.gen(function* () {
      const recorded = yield* Ref.make<ReadonlyArray<string>>([]);
      yield* Effect.gen(function* () {
        const git = yield* Git;
        yield* git.fetchBack({
          from: repoUrl(CHECKOUT),
          into: REPO_ROOT,
          branch: BRANCH,
          onto: `${BRANCH}-from-run-a1b2c3d`,
        });
      }).pipe(Effect.provide(gitLayer({ "git -C": { exit: 0 } }, recorded)));

      expect(yield* Ref.get(recorded)).toEqual([
        `${inRepo(REPO_ROOT)} fetch ${CHECKOUT} refs/heads/${BRANCH}:refs/heads/${BRANCH}-from-run-a1b2c3d`,
      ]);
      expect((yield* Ref.get(recorded))[0]).not.toContain("+");
      expect((yield* Ref.get(recorded))[0]).not.toContain("--force");
    }),
  );

  // Whichever destination refused, `onto` is what could not move — so the
  // detail reads correctly for the rescue as it does for the way home.
  it.effect("names the destination that could not move when a rescue is refused", () =>
    Effect.gen(function* () {
      const git = yield* Git;
      const outcome = yield* Effect.either(
        git.fetchBack({
          from: repoUrl(CHECKOUT),
          into: REPO_ROOT,
          branch: BRANCH,
          onto: `${BRANCH}-from-run-a1b2c3d`,
        }),
      );
      expect(Either.isLeft(outcome)).toBe(true);
      if (Either.isLeft(outcome)) {
        expect(outcome.left.detail).toContain(
          `could not fast-forward '${BRANCH}-from-run-a1b2c3d'`,
        );
      }
    }).pipe(
      Effect.provide(
        gitLayer({ "git -C": { exit: 1, stderr: "! [rejected] (non-fast-forward)\n" } }),
      ),
    ),
  );

  // The direction that keeps a checkout: the agent rebased inside the clone,
  // so the fast-forward is refused and the commits have not made it home.
  it.effect("fails a fetch-back that is not a fast-forward with a typed GitError", () =>
    Effect.gen(function* () {
      const git = yield* Git;
      const outcome = yield* Effect.either(
        git.fetchBack({ from: repoUrl(CHECKOUT), into: REPO_ROOT, branch: BRANCH, onto: BRANCH }),
      );
      expect(Either.isLeft(outcome)).toBe(true);
      if (Either.isLeft(outcome)) {
        expect(outcome.left._tag).toBe("GitError");
        expect(outcome.left.detail).toContain(`could not fast-forward '${BRANCH}'`);
        expect(outcome.left.detail).toContain("non-fast-forward");
      }
    }).pipe(
      Effect.provide(
        gitLayer({ "git -C": { exit: 1, stderr: "! [rejected] (non-fast-forward)\n" } }),
      ),
    ),
  );

  // The push's whole shape is its argv too, and for the same reason the
  // fetch-back's is: it runs in the repo `-C` names, and it names both ends of
  // the refspec so nothing the branch's upstream says can redirect it.
  it.effect("pushes the branch to origin with an explicit refspec at both ends", () =>
    Effect.gen(function* () {
      const recorded = yield* Ref.make<ReadonlyArray<string>>([]);
      yield* Effect.gen(function* () {
        const git = yield* Git;
        yield* git.push({ from: REPO_ROOT, branch: BRANCH });
      }).pipe(Effect.provide(gitLayer({ "git -C": { exit: 0 } }, recorded)));

      expect(yield* Ref.get(recorded)).toEqual([
        `${inRepo(REPO_ROOT)} push --set-upstream origin refs/heads/${BRANCH}:refs/heads/${BRANCH}`,
      ]);
      // `--force-with-lease` belongs to `--hard-reset` alone (T101): a push
      // handed no lease that cannot fast-forward the remote fails instead.
      expect((yield* Ref.get(recorded))[0]).not.toContain("--force");
    }),
  );

  // A hard reset's push (T101, D7): the lease names the ref and the SHA the
  // guard phase read, never the bare flag that reads the remote-tracking ref
  // at push time — and an origin with no such branch is the empty expectation,
  // which git reads as "must not exist".
  it.effect("pushes under a lease pinned to the SHA origin held", () =>
    Effect.gen(function* () {
      const recorded = yield* Ref.make<ReadonlyArray<string>>([]);
      yield* Effect.gen(function* () {
        const git = yield* Git;
        yield* git.push({ from: REPO_ROOT, branch: BRANCH, lease: { expect: Option.some(SHA) } });
      }).pipe(Effect.provide(gitLayer({ "git -C": { exit: 0 } }, recorded)));

      expect(yield* Ref.get(recorded)).toEqual([
        `${inRepo(REPO_ROOT)} push --set-upstream --force-with-lease=refs/heads/${BRANCH}:${SHA} origin refs/heads/${BRANCH}:refs/heads/${BRANCH}`,
      ]);
    }),
  );

  it.effect("pushes under a lease expecting the branch absent when origin had none", () =>
    Effect.gen(function* () {
      const recorded = yield* Ref.make<ReadonlyArray<string>>([]);
      yield* Effect.gen(function* () {
        const git = yield* Git;
        yield* git.push({ from: REPO_ROOT, branch: BRANCH, lease: { expect: Option.none() } });
      }).pipe(Effect.provide(gitLayer({ "git -C": { exit: 0 } }, recorded)));

      expect(yield* Ref.get(recorded)).toEqual([
        `${inRepo(REPO_ROOT)} push --set-upstream --force-with-lease=refs/heads/${BRANCH}: origin refs/heads/${BRANCH}:refs/heads/${BRANCH}`,
      ]);
    }),
  );

  // The discard count is one union (T101): two tips, one exclusion, one
  // `rev-list`, so history the tips share is counted once.
  it.effect("counts the commits reachable from any tip and not from the exclusion", () =>
    Effect.gen(function* () {
      const recorded = yield* Ref.make<ReadonlyArray<string>>([]);
      const counted = yield* Effect.gen(function* () {
        const git = yield* Git;
        return yield* git.countReachable({
          repo: REPO_ROOT,
          excluding: SHA,
          tips: [`refs/heads/${BRANCH}`, T72_TIP],
        });
      }).pipe(Effect.provide(gitLayer({ "git -C": { exit: 0, stdout: "5\n" } }, recorded)));

      expect(counted).toBe(5);
      expect(yield* Ref.get(recorded)).toEqual([
        `${inRepo(REPO_ROOT)} rev-list --count ^${SHA} refs/heads/${BRANCH} ${T72_TIP}`,
      ]);
    }),
  );

  it.effect("fails a rejected push with a typed GitError", () =>
    Effect.gen(function* () {
      const git = yield* Git;
      const outcome = yield* Effect.either(git.push({ from: REPO_ROOT, branch: BRANCH }));
      expect(Either.isLeft(outcome)).toBe(true);
      if (Either.isLeft(outcome)) {
        expect(outcome.left._tag).toBe("GitError");
        expect(outcome.left.detail).toContain(`could not push '${BRANCH}' to origin`);
        expect(outcome.left.detail).toContain("fetch first");
      }
    }).pipe(
      Effect.provide(
        gitLayer({
          "git -C": { exit: 1, stderr: "! [rejected] (fetch first)\n" },
        }),
      ),
    ),
  );

  it.effect("counts the commits in a range, in the repo it names", () =>
    Effect.gen(function* () {
      const recorded = yield* Ref.make<ReadonlyArray<string>>([]);
      const counted = yield* Effect.gen(function* () {
        const git = yield* Git;
        return yield* git.countCommits({ repo: REPO_ROOT, from: SHA, to: `refs/heads/${BRANCH}` });
      }).pipe(Effect.provide(gitLayer({ "git -C": { exit: 0, stdout: "3\n" } }, recorded)));

      expect(counted).toBe(3);
      expect(yield* Ref.get(recorded)).toEqual([
        `${inRepo(REPO_ROOT)} rev-list --count ${SHA}..refs/heads/${BRANCH}`,
      ]);
    }),
  );

  // Zero is an answer — it is the whole of "nothing to land" — so it comes
  // back as a count and not as a failure.
  it.effect("counts zero commits without failing", () =>
    Effect.gen(function* () {
      const git = yield* Git;
      expect(
        yield* git.countCommits({ repo: REPO_ROOT, from: SHA, to: `refs/heads/${BRANCH}` }),
      ).toBe(0);
    }).pipe(Effect.provide(gitLayer({ "git -C": { exit: 0, stdout: "0\n" } }))),
  );

  it.effect("fails a count git could not answer with a typed GitError", () =>
    Effect.gen(function* () {
      const git = yield* Git;
      const outcome = yield* Effect.either(
        git.countCommits({ repo: REPO_ROOT, from: SHA, to: `refs/heads/${BRANCH}` }),
      );
      expect(Either.isLeft(outcome)).toBe(true);
      if (Either.isLeft(outcome)) {
        expect(outcome.left._tag).toBe("GitError");
        expect(outcome.left.detail).toContain("could not count the commits");
        expect(outcome.left.detail).toContain("bad revision");
      }
    }).pipe(
      Effect.provide(
        gitLayer({
          "git -C": { exit: 128, stderr: "fatal: bad revision\n" },
        }),
      ),
    ),
  );

  // The tree read (T71), argv and all: the ref and the path are two words,
  // the trailing slash is what makes the answer the directory's *entries*, and
  // `--literal-pathspecs` is what keeps a folder a dispatcher typed from being
  // read as a glob.
  it.effect("lists one directory at one ref, in the repo it names", () =>
    Effect.gen(function* () {
      const recorded = yield* Ref.make<ReadonlyArray<string>>([]);
      const entries = yield* Effect.gen(function* () {
        const git = yield* Git;
        return yield* git.listTree({ repo: REPO_ROOT, ref: SHA, path: FOLDER });
      }).pipe(Effect.provide(gitLayer({ "git -C": { exit: 0, stdout: TREE } }, recorded)));

      expect(entries).toEqual(
        Option.some([
          { name: "T71-the-read.md", id: T71_BLOB },
          { name: "T72-the-scan.md", id: T72_BLOB },
        ]),
      );
      expect(yield* Ref.get(recorded)).toEqual([
        `${inRepo(REPO_ROOT)} --literal-pathspecs ls-tree -z ${SHA} -- ${FOLDER}/`,
      ]);
    }),
  );

  // **Absent is an answer, not a failure.** A ref that never carried the
  // folder answers exit 0 and says nothing, which is how an untracked issue
  // set and a branch cut before the folder existed both present — and the
  // refusal written about that is `IssueStore`'s, in its own words.
  it.effect("answers None for a path the ref does not carry", () =>
    Effect.gen(function* () {
      const git = yield* Git;
      expect(yield* git.listTree({ repo: REPO_ROOT, ref: SHA, path: FOLDER })).toEqual(
        Option.none(),
      );
    }).pipe(Effect.provide(gitLayer({ "git -C": { exit: 0, stdout: "" } }))),
  );

  it.effect("fails a tree read git could not answer with a typed GitError", () =>
    Effect.gen(function* () {
      const git = yield* Git;
      const outcome = yield* Effect.either(
        git.listTree({ repo: REPO_ROOT, ref: "nope", path: FOLDER }),
      );
      expect(Either.isLeft(outcome)).toBe(true);
      if (Either.isLeft(outcome)) {
        expect(outcome.left._tag).toBe("GitError");
        expect(outcome.left.detail).toContain(`could not list '${FOLDER}' at nope`);
        expect(outcome.left.detail).toContain("Not a valid object name");
      }
    }).pipe(
      Effect.provide(
        gitLayer({
          "git -C": { exit: 128, stderr: "fatal: Not a valid object name nope\n" },
        }),
      ),
    ),
  );

  // **One child, and the ids on stdin** (T71): the batch is the whole point,
  // so what is asserted is that two blobs cost one `git cat-file --batch` with
  // both names fed to it — not two spawns, and not two names in argv.
  it.effect("reads every blob in one batch, with the ids on stdin", () =>
    Effect.gen(function* () {
      const recorded = yield* Ref.make<ReadonlyArray<string>>([]);
      const fed = yield* Ref.make<ReadonlyArray<string>>([]);
      const blobs = yield* Effect.gen(function* () {
        const git = yield* Git;
        return yield* git.readBlobs({ repo: REPO_ROOT, ids: [T71_BLOB, T72_BLOB] });
      }).pipe(
        Effect.provide(
          gitLayer(
            { "git -C": { exit: 0, stdout: `${T71_BLOB} blob 3\none\n${T72_BLOB} blob 3\ntwo\n` } },
            recorded,
            fed,
          ),
        ),
      );

      expect([...blobs]).toEqual([
        [T71_BLOB, "one"],
        [T72_BLOB, "two"],
      ]);
      expect(yield* Ref.get(recorded)).toEqual([`${inRepo(REPO_ROOT)} cat-file --batch`]);
      expect(yield* Ref.get(fed)).toEqual([`${T71_BLOB}\n${T72_BLOB}\n`]);
    }),
  );

  // An id the repo does not hold comes back as git's own `missing` line, and
  // this is where that becomes a `GitError`: every caller reads ids it listed
  // out of a tree a moment earlier, so a missing one is a repository that
  // changed underneath the read.
  it.effect("fails a batch git answered `missing` to", () =>
    Effect.gen(function* () {
      const git = yield* Git;
      const outcome = yield* Effect.either(
        git.readBlobs({ repo: REPO_ROOT, ids: [T71_BLOB, T72_BLOB] }),
      );
      expect(Either.isLeft(outcome)).toBe(true);
      if (Either.isLeft(outcome)) {
        expect(outcome.left.detail).toContain(`'${T72_BLOB}' is not a blob in this repo`);
      }
    }).pipe(
      Effect.provide(
        gitLayer({
          "git -C": { exit: 0, stdout: `${T71_BLOB} blob 3\none\n${T72_BLOB} missing\n` },
        }),
      ),
    ),
  );

  // Every ref, and the object each one points at (T72): no pattern, no sort,
  // and a format carrying exactly the two fields the scan reads.
  it.effect("lists every ref in the repo it names", () =>
    Effect.gen(function* () {
      const recorded = yield* Ref.make<ReadonlyArray<string>>([]);
      const refs = yield* Effect.gen(function* () {
        const git = yield* Git;
        return yield* git.forEachRef({ repo: REPO_ROOT });
      }).pipe(Effect.provide(gitLayer({ "git -C": { exit: 0, stdout: REFS } }, recorded)));

      expect(refs).toEqual([
        { name: "refs/heads/bessemer-t71", sha: T71_TIP },
        { name: "refs/remotes/origin/bessemer-t72", sha: T72_TIP },
      ]);
      expect(yield* Ref.get(recorded)).toEqual([
        `${inRepo(REPO_ROOT)} for-each-ref --format=%(objectname) %(refname)`,
      ]);
    }),
  );

  // The picker's list (T81): one child, narrowed to `refs/heads/` by the
  // pattern git takes last, with the date the rows are ordered and aged by.
  it.effect("lists every local branch of the repo it names, with its tip's date", () =>
    Effect.gen(function* () {
      const recorded = yield* Ref.make<ReadonlyArray<string>>([]);
      const branches = yield* Effect.gen(function* () {
        const git = yield* Git;
        return yield* git.branches({ repo: REPO_ROOT });
      }).pipe(Effect.provide(gitLayer({ "git -C": { exit: 0, stdout: BRANCH_LINES } }, recorded)));

      expect(branches.map((branch) => branch.name)).toEqual(["bessemer-t80", "bessemer-t81"]);
      expect(yield* Ref.get(recorded)).toEqual([
        `${inRepo(REPO_ROOT)} for-each-ref --format=%(committerdate:unix) %(refname) refs/heads/`,
      ]);
    }),
  );

  it.effect("fails a branch listing git could not answer with a typed GitError", () =>
    Effect.gen(function* () {
      const git = yield* Git;
      const outcome = yield* Effect.either(git.branches({ repo: REPO_ROOT }));
      expect(Either.isLeft(outcome)).toBe(true);
      if (Either.isLeft(outcome)) {
        expect(outcome.left._tag).toBe("GitError");
        expect(outcome.left.detail).toContain("could not list the branches of this repo");
      }
    }).pipe(
      Effect.provide(
        gitLayer({
          "git -C": { exit: 128, stderr: "fatal: not a git repository\n" },
        }),
      ),
    ),
  );

  it.effect("fails a ref listing git could not answer with a typed GitError", () =>
    Effect.gen(function* () {
      const git = yield* Git;
      const outcome = yield* Effect.either(git.forEachRef({ repo: REPO_ROOT }));
      expect(Either.isLeft(outcome)).toBe(true);
      if (Either.isLeft(outcome)) {
        expect(outcome.left._tag).toBe("GitError");
        expect(outcome.left.detail).toContain("could not list the refs of this repo");
        expect(outcome.left.detail).toContain("not a git repository");
      }
    }).pipe(
      Effect.provide(
        gitLayer({
          "git -C": { exit: 128, stderr: "fatal: not a git repository\n" },
        }),
      ),
    ),
  );

  // The tolerant sibling (T72): the same one child and the same stdin, over
  // `<sha>:<path>` object names — and a `missing` is an answer about that one
  // name, not a failure of the read. The scan asks one file's name at every
  // ref in the repo, and most refs do not carry it.
  const NAMES = [`${SHA}:${FOLDER}/T71.md`, `${SHA}:${FOLDER}/T72.md`];

  it.effect("reads named objects in one batch, and leaves out the ones git has not got", () =>
    Effect.gen(function* () {
      const recorded = yield* Ref.make<ReadonlyArray<string>>([]);
      const fed = yield* Ref.make<ReadonlyArray<string>>([]);
      const objects = yield* Effect.gen(function* () {
        const git = yield* Git;
        return yield* git.readObjects({ repo: REPO_ROOT, names: NAMES });
      }).pipe(
        Effect.provide(
          gitLayer(
            { "git -C": { exit: 0, stdout: `${T71_BLOB} blob 3\none\n${NAMES[1]} missing\n` } },
            recorded,
            fed,
          ),
        ),
      );

      // Keyed by the name **as asked**, which is the only thing that pairs an
      // answer with a question: git echoes the object's own id on the header
      // line and the name as given on a `missing` one.
      expect([...objects]).toEqual([[NAMES[0], "one"]]);
      expect(objects.has(`${NAMES[1]}`)).toBe(false);
      expect(yield* Ref.get(recorded)).toEqual([`${inRepo(REPO_ROOT)} cat-file --batch`]);
      expect(yield* Ref.get(fed)).toEqual([`${NAMES[0]}\n${NAMES[1]}\n`]);
    }),
  );

  // Only git failing to run the batch at all: a repository this cannot read,
  // rather than an object it does not hold.
  it.effect("fails a batch git could not run with a typed GitError", () =>
    Effect.gen(function* () {
      const git = yield* Git;
      const outcome = yield* Effect.either(git.readObjects({ repo: REPO_ROOT, names: NAMES }));
      expect(Either.isLeft(outcome)).toBe(true);
      if (Either.isLeft(outcome)) {
        expect(outcome.left.detail).toContain("could not read 2 object(s) from this repo");
      }
    }).pipe(
      Effect.provide(
        gitLayer({ "git -C": { exit: 128, stderr: "fatal: not a git repository\n" } }),
      ),
    ),
  );

  // **The status commit's five steps, as argv** (T77): the tree of the branch
  // into a scratch index, a rewritten file into the object database, that blob
  // over the entry it replaces, the index back out as a tree, the tree onto
  // the branch as a commit, and the branch onto that commit. Every one of them
  // opens with the repo, `commit-tree` carries its two `-m`s, and the new
  // text travels on stdin rather than as a word of argv.
  it.effect("builds the status commit out of plumbing, in the repo it names", () =>
    Effect.gen(function* () {
      const recorded = yield* Ref.make<ReadonlyArray<string>>([]);
      const fed = yield* Ref.make<ReadonlyArray<string>>([]);
      const environments = yield* Ref.make<ReadonlyArray<Record<string, string>>>([]);
      const answers = yield* Effect.gen(function* () {
        const git = yield* Git;
        yield* git.readTree({ repo: REPO_ROOT, ref: T72_TIP, index: INDEX });
        const blob = yield* git.hashObject({ repo: REPO_ROOT, text: STAMPED });
        yield* git.updateIndex({
          repo: REPO_ROOT,
          index: INDEX,
          path: `${FOLDER}/T77-a-ticket.md`,
          blob,
        });
        const tree = yield* git.writeTree({ repo: REPO_ROOT, index: INDEX });
        const commit = yield* git.commitTree({
          repo: REPO_ROOT,
          tree,
          parent: T72_TIP,
          subject: "docs(issues): mark T77-a-ticket Done",
          body: "what Done means",
        });
        yield* git.updateRef({ repo: REPO_ROOT, ref: BRANCH_REF, to: commit, from: T72_TIP });
        return { blob, tree, commit };
      }).pipe(
        Effect.provide(
          gitLayer(
            {
              [`${inRepo(REPO_ROOT)} hash-object`]: { exit: 0, stdout: `${T71_BLOB}\n` },
              [`${inRepo(REPO_ROOT)} write-tree`]: { exit: 0, stdout: `${WRITTEN_TREE}\n` },
              [`${inRepo(REPO_ROOT)} commit-tree`]: { exit: 0, stdout: `${SHA}\n` },
              "git -C": { exit: 0 },
            },
            recorded,
            fed,
            environments,
          ),
        ),
      );

      expect(answers).toEqual({ blob: T71_BLOB, tree: WRITTEN_TREE, commit: SHA });
      expect(yield* Ref.get(recorded)).toEqual([
        `${inRepo(REPO_ROOT)} read-tree ${T72_TIP}`,
        `${inRepo(REPO_ROOT)} hash-object -w --stdin`,
        `${inRepo(REPO_ROOT)} update-index --add --cacheinfo 100644,${T71_BLOB},${FOLDER}/T77-a-ticket.md`,
        `${inRepo(REPO_ROOT)} write-tree`,
        `${inRepo(REPO_ROOT)} commit-tree ${WRITTEN_TREE} -p ${T72_TIP} -m docs(issues): mark T77-a-ticket Done -m what Done means`,
        `${inRepo(REPO_ROOT)} update-ref ${BRANCH_REF} ${SHA} ${T72_TIP}`,
      ]);
      // The file's new text is what the pipe carried and argv never did.
      expect(yield* Ref.get(fed)).toEqual([STAMPED]);
      // **And the index reaches exactly the three children that read it**
      // (T77): `hash-object`, `commit-tree`, and `update-ref` write objects and
      // move a ref, which no index is involved in — a `GIT_INDEX_FILE` on one
      // of them would be this package pointing a child at a file it has no
      // business reading.
      expect((yield* Ref.get(environments)).map((env) => env["GIT_INDEX_FILE"] ?? "none")).toEqual([
        INDEX,
        "none",
        INDEX,
        INDEX,
        "none",
        "none",
      ]);
    }),
  );

  // Every step of it is a `GitError` naming what could not be done, because
  // the caller's answer is one warning and the dispatcher's next move is the
  // step that failed (T77 §2).
  it.effect("fails the status commit's steps with git's own line", () =>
    Effect.gen(function* () {
      const git = yield* Git;
      const outcome = yield* Effect.either(git.writeTree({ repo: REPO_ROOT, index: INDEX }));
      expect(Either.isLeft(outcome)).toBe(true);
      if (Either.isLeft(outcome)) {
        expect(outcome.left.detail).toContain(`could not write a tree out of ${INDEX}`);
        expect(outcome.left.detail).toContain("index file smaller than expected");
      }
    }).pipe(
      Effect.provide(
        gitLayer({
          "git -C": { exit: 128, stderr: "fatal: index file smaller than expected\n" },
        }),
      ),
    ),
  );

  // **A relative index reaches git absolute** (T77, T32's reason): git reads
  // `GIT_INDEX_FILE` against `-C`'s destination, so a `runtime-root` spelled
  // relatively would otherwise aim the scratch index inside the served repo.
  it.effect("hands git the scratch index as an absolute path", () =>
    Effect.gen(function* () {
      const environments = yield* Ref.make<ReadonlyArray<Record<string, string>>>([]);
      yield* Effect.gen(function* () {
        const git = yield* Git;
        yield* git.readTree({ repo: REPO_ROOT, ref: BRANCH_REF, index: "runtime/b.index" });
      }).pipe(
        Effect.provide(gitLayer({ "git -C": { exit: 0 } }, undefined, undefined, environments)),
      );
      expect((yield* Ref.get(environments)).map((env) => env["GIT_INDEX_FILE"])).toEqual([
        resolve("runtime/b.index"),
      ]);
    }),
  );

  // A missing binary is the one thing the chokepoint does raise, and it
  // arrives here as the same typed error a bad exit code does.
  it.effect("reports a missing git binary as a GitError", () =>
    Effect.gen(function* () {
      const git = yield* Git;
      const outcome = yield* Effect.either(git.worktrees(REPO_ROOT));
      expect(Either.isLeft(outcome)).toBe(true);
      if (Either.isLeft(outcome)) {
        expect(outcome.left.detail).toContain("git CLI not found");
      }
    }).pipe(Effect.provide(gitLayer({}))),
  );

  // **The shape pin** (AGENTS.md, design rule 2). T27's rule is that a read
  // cannot be *spelled* without the repo it reads — not that every caller
  // remembers to. The twelve lines below are the spellings that rule ruled out,
  // and each is red today; a green one means the field went optional or grew
  // a default, which is the shape the ticket named and refused. Restore the
  // shape rather than deleting the pin. Every read the tag grows lands here:
  // T32's containment question is the one whose answer is *about* which repo
  // was asked, so a spelling of it without one is the pin's whole point.
  it.effect("has no read that can be spelled without the repo it reads", () =>
    Effect.gen(function* () {
      const git = yield* Git;
      // @ts-expect-error — `revParse` takes `{ repo, rev }`, never a bare rev
      const rev = git.revParse(`${SHA}^{commit}`);
      // @ts-expect-error — `worktrees` lists a named repo's, never the working directory's
      const worktrees = git.worktrees();
      // @ts-expect-error — the diff boundary is taken in a repo, not in wherever the process started
      const boundary = git.mergeBase({ baseSha: SHA, branch: BRANCH });
      // @ts-expect-error — a count is a count of commits in a repo
      const counted = git.countCommits({ from: SHA, to: `refs/heads/${BRANCH}` });
      // @ts-expect-error — "does that branch hold this commit" is a question only a named repo answers
      const held = git.branchContains({ branch: BRANCH, commit: SHA });
      // @ts-expect-error — a config value is read out of a repo, never out of wherever the process started
      const configured = git.readConfig({ key: "user.name" });
      // @ts-expect-error — dispatcher-freshness is a question about a repo's package directory, not about wherever the process started
      const freshness = git.dispatcherFreshness({ base: "origin/main" });
      // @ts-expect-error — the 'origin' remote is a fact about a named repo, not about wherever the process started (T39)
      const origin = git.originUrl();
      // @ts-expect-error — a tree is listed in a repo, at a ref, never in wherever the process started (T71)
      const listed = git.listTree({ ref: SHA, path: FOLDER });
      // @ts-expect-error — blobs are read out of a named repo's object store, not out of whichever one encloses the process
      const blobs = git.readBlobs({ ids: [SHA] });
      // @ts-expect-error — which refs exist is a fact about one repo, never about wherever the process started (T72)
      const listedRefs = git.forEachRef({});
      // @ts-expect-error — which branches exist is a fact about one repo too (T81)
      const listedBranches = git.branches({});
      // @ts-expect-error — an object name is read out of the repo that holds it (T72)
      const objects = git.readObjects({ names: [`${SHA}:${FOLDER}/T71.md`] });
      // @ts-expect-error — which editor opens is resolved in a repo, whose config is one link of git's chain (T84)
      const editor = git.editor({});
      // @ts-expect-error — origin/HEAD is a fact about a named repo (T115)
      const head = git.originHead({});
      // Building an effect spawns nothing, and none of the twelve is yielded:
      // the assertion that matters is the compile-time one above. This one
      // says only that the pins are calls and not dead syntax.
      expect(
        [
          rev,
          worktrees,
          boundary,
          counted,
          held,
          configured,
          freshness,
          origin,
          listed,
          blobs,
          listedRefs,
          listedBranches,
          objects,
          editor,
          head,
        ].every(Effect.isEffect),
      ).toBe(true);
    }).pipe(Effect.provide(gitLayer({}))),
  );
});

// The fixture the scripted executor cannot stand in for: a real repository,
// and a real directory inside its working tree that holds no repository of its
// own. That is the shape a checkout path has before anything is cloned into it
// — and `checkouts/` lives inside the host repo's working tree, so it is also
// the shape where `-C` alone answered for the *host* repo (T32). git is a hard
// dependency of this package and the fake tier already spawns real children
// (`test/exec.test.ts`), so this is a unit case and not a live one.
const HAND = ["-c", "user.email=t@example.com", "-c", "user.name=Test"];

// One issue file, with an em dash in it: three bytes and one character, which
// is the difference the batch's framing is counted in (T71).
const ISSUE_TEXT = "# T71 — the read\n\nStatus: ready-for-agent\n";

const realRepo = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const repo = yield* fs.makeTempDirectoryScoped();
  const run = (...args: ReadonlyArray<string>) =>
    exec("git", "-C", repo, ...HAND, ...args).pipe(Effect.map((result) => result.stdout.trim()));
  yield* exec("git", "init", "-q", "-b", BRANCH, repo);
  // Two commits, so the branch stands **ahead** of its first: that is the
  // shape a copy whose commits already went home leaves behind, and the one a
  // tip comparison would call diverged (T32).
  yield* run("commit", "-q", "--allow-empty", "-m", "what the run did");
  const wentHome = yield* run("rev-parse", "HEAD");
  yield* run("commit", "-q", "--allow-empty", "-m", "and the branch moved on");
  // A real commit in this repo that the branch does not hold: written straight
  // to the object store, so no ref of ours points at it. That is the copy that
  // truly diverged.
  const diverged = yield* run(
    "commit-tree",
    `${wentHome}^{tree}`,
    "-p",
    wentHome,
    "-m",
    "what the run did instead",
  );
  // The issue folder, as a ref carries one (T71): a file whose characters are
  // not its bytes, a file that is not an issue, and a subdirectory — so the
  // batch's framing, the caller's own filter, and "a tree is not an entry" are
  // all asked of a real git.
  yield* fs.makeDirectory(`${repo}/${FOLDER}/draft`, { recursive: true });
  yield* fs.writeFileString(`${repo}/${FOLDER}/T71.md`, ISSUE_TEXT);
  yield* fs.writeFileString(`${repo}/${FOLDER}/notes.txt`, "not an issue\n");
  yield* fs.writeFileString(`${repo}/${FOLDER}/draft/T99.md`, "# T99\n");
  yield* run("add", "-A");
  yield* run("commit", "-q", "-m", "the issue folder");
  // Where a run's copy would go, holding one ordinary file and no `.git` —
  // T28's Verify step 4, as a fixture.
  const notARepo = `${repo}/checkouts/${BRANCH}`;
  yield* fs.makeDirectory(notARepo, { recursive: true });
  yield* fs.writeFileString(`${notARepo}/LEFT-BEHIND`, "what the dead run did\n");
  return { repo, notARepo, wentHome, diverged };
}).pipe(Effect.orDie);

describe("Git against a real repository", () => {
  it.scoped("answers for the repo it names, and for no repo enclosing it", () =>
    Effect.gen(function* () {
      const { repo, notARepo } = yield* realRepo;
      const git = yield* Git;

      // The fixture is only a fixture if the enclosing repo really does hold
      // this ref: the walk `--git-dir` turns off is a walk that would have
      // found *this* answer and reported it as the copy's.
      const tip = yield* git.revParse({ repo, rev: `refs/heads/${BRANCH}` });
      expect(tip).toMatch(/^[0-9a-f]{40}$/);

      const outcome = yield* Effect.either(
        git.revParse({ repo: notARepo, rev: `refs/heads/${BRANCH}` }),
      );
      expect(Either.isLeft(outcome)).toBe(true);
      if (Either.isLeft(outcome)) {
        // A path that is not a repository is reported as that path — git's own
        // words, naming the directory it was told to read.
        expect(outcome.left.detail).toContain(notARepo);
        expect(outcome.left.detail).toContain("not a git repository");
        // And not as an answer belonging to the repo it sits inside, which is
        // what a discovered read gave back.
        expect(outcome.left.detail).not.toContain(tip);
      }
    }).pipe(Effect.provide(Layer.provideMerge(GitLive, NodeContext.layer))),
  );

  // The exit-code contract, asked of git rather than of a script: a fake can
  // agree with itself about which code means what, and the whole of the
  // salvage's new answer rests on 0-versus-1-versus-anything-else.
  it.scoped("reads containment off a real branch, ahead, apart, and unknown", () =>
    Effect.gen(function* () {
      const { repo, wentHome, diverged } = yield* realRepo;
      const git = yield* Git;

      // The case the ticket exists for: the branch has moved on since these
      // commits landed, so the tips differ and the commits are home anyway.
      const tip = yield* git.revParse({ repo, rev: `refs/heads/${BRANCH}` });
      expect(tip).not.toBe(wentHome);
      expect(yield* git.branchContains({ repo, branch: BRANCH, commit: wentHome })).toBe(true);

      // A commit this repo holds and this branch does not — the rescue's case.
      expect(yield* git.branchContains({ repo, branch: BRANCH, commit: diverged })).toBe(false);

      // And a commit it has never seen, which git refuses to answer about at
      // all rather than answering no.
      const outcome = yield* Effect.either(
        git.branchContains({ repo, branch: BRANCH, commit: SHA }),
      );
      expect(Either.isLeft(outcome)).toBe(true);
    }).pipe(Effect.provide(Layer.provideMerge(GitLive, NodeContext.layer))),
  );
  // Where a clone's `origin` points, and the whole of what a container can
  // reach through it (T35): the repo root's own local path. That path is not
  // mounted into the sandbox — the workspace is — so a `git fetch` or a
  // `git push` from inside the container reaches nothing at all. It is *more*
  // restrictive than bash, which re-points `origin` at the real remote
  // (`run.sh:1449`), and it is asserted rather than improved: the commits come
  // home by the dispatcher fetching **from** the clone, never by the agent
  // pushing.
  it.scoped("leaves origin at the repo root's own path, which no container holds", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { repo } = yield* realRepo;
      const into = `${yield* fs.makeTempDirectoryScoped()}/checkout`;
      const git = yield* Git;
      yield* git.clone({ source: repoUrl(repo), branch: BRANCH, into });

      const origin = yield* exec("git", "-C", into, "config", "--get", "remote.origin.url");
      expect(origin.stdout.trim()).toBe(repo);
      // A path on this host, not a URL: no scheme and no host, so nothing a
      // container's network stack could resolve even if it tried.
      expect(isAbsolute(origin.stdout.trim())).toBe(true);
      expect(origin.stdout.trim()).not.toContain("://");
    }).pipe(Effect.provide(Layer.provideMerge(GitLive, NodeContext.layer))),
  );
  // The editor chain against a real git (T84), which is the half a script
  // cannot show: `var GIT_EDITOR` really does read this repository's
  // `core.editor`, and it really does answer something on a host where nobody
  // set one — the chain ends in a literal, so the operation has no absent arm.
  //
  // The three environment links are cleared for the duration rather than
  // assumed unset: they beat `core.editor` in git's own order, so a dispatcher
  // who exported `GIT_EDITOR` would otherwise turn this case into a report on
  // their shell.
  it.scoped("resolves the editor a real repo's commits would open", () =>
    Effect.gen(function* () {
      const { repo } = yield* realRepo;
      const git = yield* Git;
      const names = ["GIT_EDITOR", "VISUAL", "EDITOR"];
      const previous = names.map((name) => [name, process.env[name]] as const);
      const terminal = process.env["TERM"];
      for (const name of names) {
        delete process.env[name];
      }
      // A terminal that can run one, because that is the other half of git's
      // last link: on a *dumb* terminal with nothing configured git refuses
      // outright — `fatal: Terminal is dumb, but EDITOR unset` — which is the
      // `GitError` this operation has instead of an absent arm, and which the
      // container this suite runs in would otherwise answer with.
      process.env["TERM"] = "xterm-256color";
      try {
        // Nobody has said anything about an editor anywhere: git still answers,
        // which is why there is no `Option` on this operation.
        expect((yield* git.editor({ repo })).trim()).not.toBe("");

        yield* git.setConfig({ repo, key: "core.editor", value: "code --wait" });
        expect(yield* git.editor({ repo })).toBe("code --wait");
      } finally {
        for (const [name, value] of previous) {
          if (value !== undefined) {
            process.env[name] = value;
          }
        }
        if (terminal === undefined) {
          delete process.env["TERM"];
        } else {
          process.env["TERM"] = terminal;
        }
      }
    }).pipe(Effect.provide(Layer.provideMerge(GitLive, NodeContext.layer))),
  );

  // origin/HEAD against a real git (T115): set, it answers short; unset, it
  // is an absence and not a failure.
  it.scoped("reads a set origin/HEAD and answers nothing for an unset one", () =>
    Effect.gen(function* () {
      const { repo } = yield* realRepo;
      const git = yield* Git;
      expect(yield* git.originHead({ repo })).toEqual(Option.none());
      yield* exec(
        "git",
        "-C",
        repo,
        "update-ref",
        "refs/remotes/origin/trunk",
        `refs/heads/${BRANCH}`,
      );
      yield* exec(
        "git",
        "-C",
        repo,
        "symbolic-ref",
        "refs/remotes/origin/HEAD",
        "refs/remotes/origin/trunk",
      );
      expect(yield* git.originHead({ repo })).toEqual(Option.some("origin/trunk"));
    }).pipe(Effect.provide(Layer.provideMerge(GitLive, NodeContext.layer))),
  );

  // The identity write against a real git (T35): `--local` lands in the
  // clone's own `.git/config` and in no other file, and the two keys are the
  // whole of what a run adds. This is the ticket's host-only check —
  // `git config --local --list | grep -c '^user\\.'` is 2 — asked of a clone
  // this test made rather than of a dispatch.
  it.scoped("writes the identity into the clone's own config, and nothing else's", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { repo } = yield* realRepo;
      const into = `${yield* fs.makeTempDirectoryScoped()}/checkout`;
      const git = yield* Git;
      yield* git.clone({ source: repoUrl(repo), branch: BRANCH, into });

      yield* git.setConfig({ repo: into, key: "user.name", value: "Ada Lovelace" });
      yield* git.setConfig({ repo: into, key: "user.email", value: "ada@example.com" });

      // Read back through the same tag, which is what the container's git will
      // resolve when the agent commits.
      expect(yield* git.readConfig({ repo: into, key: "user.name" })).toEqual(
        Option.some("Ada Lovelace"),
      );
      const local = yield* exec("git", "-C", into, "config", "--local", "--list");
      expect(local.stdout.split("\n").filter((line) => line.startsWith("user."))).toEqual([
        "user.name=Ada Lovelace",
        "user.email=ada@example.com",
      ]);

      // And the repository it was cloned from is untouched: the write named
      // the clone, so nothing of the dispatching dev's was edited to make the
      // clone carry their name.
      const source = yield* exec("git", "-C", repo, "config", "--local", "--list");
      expect(source.stdout.split("\n").filter((line) => line.startsWith("user."))).toEqual([]);
    }).pipe(Effect.provide(Layer.provideMerge(GitLive, NodeContext.layer))),
  );

  // The tree read and the batch against a real git (T71), which is where the
  // three things a script cannot show are asserted: that a directory's entries
  // come back rather than the directory itself, that an absent path exits zero
  // and says nothing while an unresolvable ref does not, and that the batch's
  // frame survives a file whose characters are not its bytes.
  it.scoped("lists a real directory at a ref and reads its blobs in one batch", () =>
    Effect.gen(function* () {
      const { repo } = yield* realRepo;
      const git = yield* Git;
      const ref = yield* git.revParse({ repo, rev: `refs/heads/${BRANCH}` });

      const entries = yield* git.listTree({ repo, ref, path: FOLDER });
      expect(Option.isSome(entries)).toBe(true);
      if (Option.isNone(entries)) {
        return;
      }
      // The subdirectory is not an entry, and the names are the files' own
      // rather than the paths they were listed under.
      expect(entries.value.map((entry) => entry.name)).toEqual(["T71.md", "notes.txt"]);

      const blobs = yield* git.readBlobs({
        repo,
        ids: entries.value.map((entry) => entry.id),
      });
      expect([...blobs.values()]).toEqual([ISSUE_TEXT, "not an issue\n"]);

      // Nothing to read is an empty answer and not a failure: a folder holding
      // no files of the kind a caller wants asks for no ids, and a blank line
      // fed to `--batch` is an object name git answers `missing` to.
      expect([...(yield* git.readBlobs({ repo, ids: [] }))]).toEqual([]);
    }).pipe(Effect.provide(Layer.provideMerge(GitLive, NodeContext.layer))),
  );

  // The scan's two reads against a real git (T72). What a script cannot show
  // is here: that `for-each-ref` names a remote-tracking ref in full beside a
  // local branch, and that `<sha>:<path>` really is how one file is read at a
  // ref that was never checked out — including the `missing` line a ref that
  // does not carry the folder answers with, which is the whole of what makes
  // the tolerant read tolerant.
  it.scoped("lists real refs and reads one path at each of them", () =>
    Effect.gen(function* () {
      const { repo } = yield* realRepo;
      const git = yield* Git;
      const tip = yield* git.revParse({ repo, rev: `refs/heads/${BRANCH}` });
      // A remote-tracking ref, written the way a fetch writes one: post-fetch
      // it is current (T70), so the scan reads it like any other ref.
      yield* exec("git", "-C", repo, "update-ref", `refs/remotes/origin/${BRANCH}`, tip);
      // And a ref cut before the folder existed — the repo's first commit,
      // which carries no `${FOLDER}` at all.
      const first = yield* exec("git", "-C", repo, "rev-list", "--max-parents=0", "HEAD");
      yield* exec("git", "-C", repo, "update-ref", "refs/heads/before", first.stdout.trim());

      const refs = yield* git.forEachRef({ repo });
      expect(refs.map((ref) => ref.name)).toEqual([
        "refs/heads/before",
        `refs/heads/${BRANCH}`,
        `refs/remotes/origin/${BRANCH}`,
      ]);
      expect(refs.every((ref) => /^[0-9a-f]{40}$/.test(ref.sha))).toBe(true);

      // One file's name at every ref there is, in one batch: the two refs
      // carrying the folder answer with its text, and the one cut before it
      // existed is simply absent.
      const nameAt = (sha: string): string => `${sha}:${FOLDER}/T71.md`;
      const objects = yield* git.readObjects({
        repo,
        names: refs.map((ref) => nameAt(ref.sha)),
      });
      expect(objects.get(nameAt(tip))).toBe(ISSUE_TEXT);
      expect(objects.has(nameAt(first.stdout.trim()))).toBe(false);
    }).pipe(Effect.provide(Layer.provideMerge(GitLive, NodeContext.layer))),
  );

  // The picker's list against a real git (T81). What a script cannot show is
  // here: that `%(committerdate:unix)` is a format git accepts and answers
  // with seconds, and that the `refs/heads/` pattern really does leave the
  // remote-tracking ref beside it out — the two ways the argv could be wrong
  // and still parse.
  it.scoped("lists the local branches of a real repo, and no remote-tracking ref", () =>
    Effect.gen(function* () {
      const { repo } = yield* realRepo;
      const git = yield* Git;
      const tip = yield* git.revParse({ repo, rev: `refs/heads/${BRANCH}` });
      yield* exec("git", "-C", repo, "update-ref", `refs/remotes/origin/${BRANCH}`, tip);
      yield* exec("git", "-C", repo, "branch", "bessemer-t81");

      const branches = yield* git.branches({ repo });

      expect(branches.map((branch) => branch.name)).toEqual(["bessemer-t81", BRANCH]);
      // A real date, not the epoch: the format answered with the seconds the
      // commit carries.
      expect(branches.every((branch) => DateTime.toEpochMillis(branch.committedAt) > 0)).toBe(true);
    }).pipe(Effect.provide(Layer.provideMerge(GitLive, NodeContext.layer))),
  );

  it.scoped(
    "answers None for a folder the ref does not carry, and fails on a ref it cannot resolve",
    () =>
      Effect.gen(function* () {
        const { repo } = yield* realRepo;
        const git = yield* Git;
        const ref = yield* git.revParse({ repo, rev: `refs/heads/${BRANCH}` });

        expect(yield* git.listTree({ repo, ref, path: "nowhere/issues" })).toEqual(Option.none());

        // And the difference the two-word spelling buys: a ref that does not
        // resolve is git failing to answer, never a folder that is not there.
        const outcome = yield* Effect.either(
          git.listTree({ repo, ref: "no-such-ref", path: FOLDER }),
        );
        expect(Either.isLeft(outcome)).toBe(true);
      }).pipe(Effect.provide(Layer.provideMerge(GitLive, NodeContext.layer))),
  );
});
