// `IssueStore`'s two reads: the issue set a ref carries (T71) and the scan for
// the refs that already say `Done` (T72), both out of git objects and never
// off disk.
//
// The suite is in two halves for two different reasons. Against the **fake
// `Git`** the subject is the shape of the read — two calls, one of them a
// batch, and which typed arm each failure takes — which a real repository
// would only spell out in blobs and object ids first. Against a **real
// temporary repository** (`test/git.test.ts`'s idiom) the subject is the one
// claim a fake cannot make: that the answer is a fact about the ref and not
// about whatever the working tree happens to hold.
import { describe, expect, it } from "@effect/vitest";
import { CommandExecutor, FileSystem } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { Effect, Either, Layer, Option, Ref } from "effect";
import { appBaseLiveFor, appDryRunLiveFor, appLiveFor } from "../src/app.ts";
import { speepoboxDir } from "../src/config/paths.ts";
import { LOCKS_DIRNAME, slugFor, statusIndexPathFor } from "../src/dispatch/plan.ts";
import { exec } from "../src/internal/exec.ts";
import {
  IssueStore,
  IssueStoreLive,
  issueStoreOver,
  type IssueStoreShape,
  STATUS_COMMIT_BODY,
} from "../src/issues/issue-store.ts";
import { IssueStoreRecordingLive } from "../src/dry-run/issue-store.ts";
import { Git, GitLive } from "../src/git/git.ts";
import {
  fakeBlobId,
  fakeGit,
  type FakeGitOptions,
  type FakeTrees,
  fakeWrittenBlobId,
  type GitCall,
  PRE_TIP,
  STATUS_COMMIT,
  WRITTEN_TREE,
} from "./support/git-fake.ts";
import { Reporter, type ReporterEvent } from "../src/reporter.ts";
import { fakeIssue, fakeIssueStore, type IssueStoreCall } from "./support/issue-store-fake.ts";

const REPO = "/srv/hae";
const FOLDER = "tasks/the-feature";
const PATH = `${FOLDER}/issues`;
const TIP = "1111111111111111111111111111111111111111";
const OTHER = "2222222222222222222222222222222222222222";
const BRANCH = "demo-target";

// Where this host writes (T77): the scratch index the write builds its tree
// in is named off it, so the cases below read the path back rather than
// spelling a second one. Nothing creates it — the fake `Git` writes no file,
// and the removal after the write is of a file that was never there.
const RUNTIME_ROOT = "/runtime/never-written";
const BRANCH_REF = `refs/heads/${BRANCH}`;
const SCRATCH_INDEX = statusIndexPathFor(RUNTIME_ROOT, slugFor(BRANCH));

const READY = "# T1 — the first thing\n\nStatus: ready-for-agent\nType: AFK\n";
const BLOCKED = "# T2 — the second thing\n\nStatus: needs-triage\nBlocked by: [T1](T1-first.md)\n";

// The store over a fake `Git` — the shape `recordingGit` is tested in
// (`test/dry-run.test.ts`): `IssueStoreLive` provides `GitLive` to itself, so
// the function underneath it is what a fake goes beneath. The scan's cases
// script refs beside trees, so they take the whole options record; `storeOver`
// below is that with the one field T71's cases set.
const storeWith = (
  calls: Ref.Ref<ReadonlyArray<GitCall>>,
  options: FakeGitOptions,
): Effect.Effect<IssueStoreShape, never, FileSystem.FileSystem> =>
  Effect.flatMap(FileSystem.FileSystem, (fs) =>
    Effect.map(Git.pipe(Effect.provide(fakeGit(calls, options))), (git) => issueStoreOver(git, fs)),
  );

const storeOver = (
  calls: Ref.Ref<ReadonlyArray<GitCall>>,
  trees: FakeTrees,
): Effect.Effect<IssueStoreShape, never, FileSystem.FileSystem> => storeWith(calls, { trees });

describe("IssueStore against a fake Git", () => {
  it.effect("reads every .md under <folder>/issues/ at the ref, in two calls", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<GitCall>>([]);
      const store = yield* storeOver(calls, {
        [`${TIP}:${PATH}`]: {
          "T1-first.md": READY,
          "T2-second.md": BLOCKED,
          // Ignored: an issue folder holding a README beside its issues is
          // ordinary, and refusing one would refuse a dispatch over it.
          "README.txt": "how this folder works\n",
        },
      });
      const issues = yield* store.issues({ repo: REPO, ref: TIP, folder: FOLDER });

      expect(issues.map((issue) => [issue.id, issue.stem, issue.status])).toEqual([
        ["T1", "T1-first", "ready-for-agent"],
        ["T2", "T2-second", "needs-triage"],
      ]);
      expect(issues[1]?.blockers).toEqual([{ id: "T1", token: "[T1](T1-first.md)" }]);

      // **One `listTree` and one `readBlobs`** — never one call per file. The
      // ids on the second are the two issues and not the `README.txt`: the
      // filter runs before the batch rather than after it.
      const asked = yield* Ref.get(calls);
      expect(asked).toHaveLength(2);
      expect(asked[0]).toEqual({ _tag: "ListTree", repo: REPO, ref: TIP, path: PATH });
      expect(asked[1]?._tag).toBe("ReadBlobs");
      if (asked[1]?._tag === "ReadBlobs") {
        expect(asked[1].ids).toHaveLength(2);
      }
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  // The ref carries no `<folder>/issues/` at all: an untracked folder, or a
  // branch cut before the folder was added. T73 refuses on this arm, so what
  // it carries is what that refusal is written from — the folder as the
  // dispatcher spelled it, and the ref it was looked for at.
  it.effect("answers FolderAbsent for a ref that does not carry the folder", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<GitCall>>([]);
      const store = yield* storeOver(calls, { [`${OTHER}:${PATH}`]: { "T1-first.md": READY } });
      const outcome = yield* Effect.either(store.issues({ repo: REPO, ref: TIP, folder: FOLDER }));

      expect(Either.isLeft(outcome)).toBe(true);
      if (Either.isLeft(outcome)) {
        expect(outcome.left._tag).toBe("FolderAbsent");
        expect(outcome.left).toMatchObject({ folder: FOLDER, path: PATH, ref: TIP });
      }
      // And nothing was read after it: there were no blobs to ask for.
      expect((yield* Ref.get(calls)).map((call) => call._tag)).toEqual(["ListTree"]);
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  // The other typed arm, and the reason the two are told apart: this one names
  // a file a human fixes, where the one above names a folder a human adds.
  it.effect("answers Unparseable naming the file and the ref", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<GitCall>>([]);
      const store = yield* storeOver(calls, {
        [`${TIP}:${PATH}`]: { "T1-first.md": READY, "T2-second.md": "# T2\n\nType: maybe\n" },
      });
      const outcome = yield* Effect.either(store.issues({ repo: REPO, ref: TIP, folder: FOLDER }));

      expect(outcome).toMatchObject({
        _tag: "Left",
        left: { _tag: "Unparseable", file: `${PATH}/T2-second.md`, ref: TIP },
      });
      if (Either.isLeft(outcome) && outcome.left._tag === "Unparseable") {
        // T68's own sentence, carried rather than restated: the parse says
        // which header, and this says which file at which ref.
        expect(outcome.left.detail).toContain("neither AFK nor HITL");
      }
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  // A directory holding no `.md` at all is a present folder with no issues in
  // it, which is an empty set and not an absent folder: the two are different
  // answers to a dispatcher, and only one of them is fixed by adding a folder.
  it.effect("answers an empty set for a folder holding no .md files", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<GitCall>>([]);
      const store = yield* storeOver(calls, {
        [`${TIP}:${PATH}`]: { "README.txt": "nothing yet\n" },
      });

      expect(yield* store.issues({ repo: REPO, ref: TIP, folder: FOLDER })).toEqual([]);
    }).pipe(Effect.provide(NodeContext.layer)),
  );
});

// The scan over every ref (T72), against the same fake `Git`: what a case
// scripts is which refs there are and what each one's copy of a file says, and
// what it asserts is the answer and **the two calls it cost**. A real
// repository comes below, where "no ancestry question was asked" is a fact
// about a ref that really is an ancestor.
const LANDED_SHA = "3333333333333333333333333333333333333333";
const BARE_SHA = "4444444444444444444444444444444444444444";

// `Done` with the annotation a human writes after it (T68): the first token is
// the status, and a PR number after it does not un-done an issue.
const DONE = "# T1 — the first thing\n\nStatus: Done (PR #26)\nType: AFK\n";

// The issues as T69 selected them at the tip — the value `landedElsewhere`
// takes, since the copy it reads at another ref is `<stem>.md` and an id names
// no file.
const T1 = fakeIssue("T1", { stem: "T1-first" });
const T2 = fakeIssue("T2", { stem: "T2-second" });

describe("IssueStore.landedElsewhere against a fake Git", () => {
  // A branch and its remote-tracking copy are one commit and **two answers**:
  // the refusal names both, because a local branch behind its own remote is
  // fixed differently from a branch somebody else landed.
  it.effect("answers every ref whose copy says Done, tip excluded, in two calls", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<GitCall>>([]);
      const store = yield* storeWith(calls, {
        refs: [
          { name: `refs/heads/${BRANCH}`, sha: TIP },
          { name: "refs/heads/landed", sha: LANDED_SHA },
          { name: "refs/remotes/origin/landed", sha: LANDED_SHA },
          // A ref cut before the folder existed: its tree carries nothing to
          // read, which is a witness with nothing to say.
          { name: "refs/heads/before", sha: BARE_SHA },
        ],
        trees: {
          [`${TIP}:${PATH}`]: { "T1-first.md": READY, "T2-second.md": BLOCKED },
          [`${LANDED_SHA}:${PATH}`]: { "T1-first.md": DONE, "T2-second.md": BLOCKED },
        },
      });

      const landed = yield* store.landedElsewhere({
        repo: REPO,
        folder: FOLDER,
        issues: [T1, T2],
        tip: TIP,
      });

      expect(landed).toEqual([
        { id: "T1", refs: ["refs/heads/landed", "refs/remotes/origin/landed"] },
      ]);

      // **One `forEachRef` and one batch** — and no ancestry question, which
      // is the read this scan deliberately does not make (14): if the other
      // ref were merged into the tip, the tip's copy would say `Done` too.
      const asked = yield* Ref.get(calls);
      expect(asked.map((call) => call._tag)).toEqual(["ForEachRef", "ReadObjects"]);
      if (asked[1]?._tag === "ReadObjects") {
        // The tip's own ref is not among the names, and the two refs at one
        // commit ask for each file once: the dedupe is of the read, never of
        // the witnesses above.
        expect(asked[1].names).toEqual([
          `${LANDED_SHA}:${PATH}/T1-first.md`,
          `${LANDED_SHA}:${PATH}/T2-second.md`,
          `${BARE_SHA}:${PATH}/T1-first.md`,
          `${BARE_SHA}:${PATH}/T2-second.md`,
        ]);
      }
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  // Two git processes whatever the ref count, which is the whole of `0.62s
  // over 339 refs` (14) being reachable at all: a read per ref would be one
  // spawn per branch on the host.
  it.effect("costs the same two calls over fifty refs as over two", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<GitCall>>([]);
      const shas = Array.from({ length: 50 }, (_, index) => `${index}`.padStart(40, "a"));
      const store = yield* storeWith(calls, {
        refs: shas.map((sha, index) => ({ name: `refs/heads/b${index}`, sha })),
        trees: Object.fromEntries(shas.map((sha) => [`${sha}:${PATH}`, { "T1-first.md": DONE }])),
      });

      const landed = yield* store.landedElsewhere({
        repo: REPO,
        folder: FOLDER,
        issues: [T1],
        tip: TIP,
      });

      expect(landed[0]?.refs).toHaveLength(50);
      expect((yield* Ref.get(calls)).map((call) => call._tag)).toEqual([
        "ForEachRef",
        "ReadObjects",
      ]);
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  // The tip is excluded by **what it points at**: a second ref at that commit
  // holds the tip's own copy of every file, so an answer about it would be an
  // answer about the tip — which is the one thing this cannot say, since T69's
  // `AlreadyDone` would already have refused it.
  it.effect("never names the tip's own ref, nor another ref standing on it", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<GitCall>>([]);
      const store = yield* storeWith(calls, {
        refs: [
          { name: `refs/heads/${BRANCH}`, sha: TIP },
          { name: "refs/remotes/origin/demo-target", sha: TIP },
        ],
        trees: { [`${TIP}:${PATH}`]: { "T1-first.md": DONE } },
      });

      expect(
        yield* store.landedElsewhere({ repo: REPO, folder: FOLDER, issues: [T1], tip: TIP }),
      ).toEqual([]);
      const asked = yield* Ref.get(calls);
      if (asked[1]?._tag === "ReadObjects") {
        expect(asked[1].names).toEqual([]);
      }
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  // **A witness that cannot read a copy has nothing to say about it.** Neither
  // a ref whose tree lacks the file nor one whose copy is not an issue refuses
  // the dispatch: the scan reads three hundred refs this package does not own,
  // and a `Type: maybe` on somebody's branch is not the dispatcher's to fix.
  it.effect("passes over a ref with no copy, and one whose copy does not parse", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<GitCall>>([]);
      const store = yield* storeWith(calls, {
        refs: [
          { name: "refs/heads/unreadable", sha: LANDED_SHA },
          { name: "refs/heads/before", sha: BARE_SHA },
        ],
        trees: {
          [`${LANDED_SHA}:${PATH}`]: {
            "T1-first.md": "# T1\n\nStatus: Done\nType: maybe\n",
          },
        },
      });

      expect(
        yield* store.landedElsewhere({ repo: REPO, folder: FOLDER, issues: [T1], tip: TIP }),
      ).toEqual([]);
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  // Nobody else has landed any of them, which is the ordinary answer and an
  // empty one — not a failure and not a `None`.
  it.effect("answers nothing when no other ref says Done", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<GitCall>>([]);
      const store = yield* storeWith(calls, {
        refs: [{ name: "refs/heads/other", sha: LANDED_SHA }],
        trees: { [`${LANDED_SHA}:${PATH}`]: { "T1-first.md": READY, "T2-second.md": BLOCKED } },
      });

      expect(
        yield* store.landedElsewhere({ repo: REPO, folder: FOLDER, issues: [T1, T2], tip: TIP }),
      ).toEqual([]);
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  // git failing to answer at all travels as itself: the scan has no typed arm
  // of its own, because a repository this package cannot read the refs of is
  // not a finding about any issue.
  it.effect("fails with the GitError when the refs cannot be listed", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<GitCall>>([]);
      const store = yield* storeWith(calls, {
        forEachRefFails: "fatal: not a git repository",
      });
      const outcome = yield* Effect.either(
        store.landedElsewhere({ repo: REPO, folder: FOLDER, issues: [T1], tip: TIP }),
      );

      expect(Either.isLeft(outcome)).toBe(true);
      if (Either.isLeft(outcome)) {
        expect(outcome.left._tag).toBe("GitError");
      }
      // And the batch was never asked for: there were no refs to read at.
      expect((yield* Ref.get(calls)).map((call) => call._tag)).toEqual(["ForEachRef"]);
    }).pipe(Effect.provide(NodeContext.layer)),
  );
});

// The write (T77), at the same seam: what a case scripts is the branch's copy
// of each file, and what it asserts is the sequence of children the commit is
// built out of and the values that crossed. That the branch really moves is
// the real repository's claim, below.
const T70_READY = "# T70 — the first\n\nStatus: ready-for-agent\nType: AFK\n";
const T71_READY = "# T71 — the second\n\nStatus: ready-for-agent\nType: AFK\n";
const T70_DONE = "# T70 — the first\n\nStatus: Done\nType: AFK\n";
const T71_DONE = "# T71 — the second\n\nStatus: Done\nType: AFK\n";

const ON_BRANCH: FakeTrees = {
  [`${PRE_TIP}:${PATH}`]: { "T70-first.md": T70_READY, "T71-second.md": T71_READY },
};

const marking = (stems: ReadonlyArray<string>) => ({
  repo: REPO,
  branch: BRANCH,
  folder: FOLDER,
  stems,
  index: SCRATCH_INDEX,
});

describe("the status commit, against a fake Git", () => {
  it.effect("reads each approved file at the branch and commits the rewritten set", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<GitCall>>([]);
      const store = yield* storeOver(calls, ON_BRANCH);

      const commit = yield* store.markLanded(marking(["T70-first", "T71-second"]));

      expect(commit).toEqual(Option.some(STATUS_COMMIT));
      // The whole sequence: the branch resolved **once**, the two reads the
      // set is read with (T71) at that commit rather than at the tip the run
      // started from, then the scratch index, a blob and an entry per file,
      // and the commit.
      expect(yield* Ref.get(calls)).toEqual([
        { _tag: "RevParse", repo: REPO, rev: BRANCH_REF },
        { _tag: "ListTree", repo: REPO, ref: PRE_TIP, path: PATH },
        {
          _tag: "ReadBlobs",
          repo: REPO,
          ids: [
            fakeBlobId(`${PRE_TIP}:${PATH}`, "T70-first.md"),
            fakeBlobId(`${PRE_TIP}:${PATH}`, "T71-second.md"),
          ],
        },
        { _tag: "ReadTree", repo: REPO, ref: PRE_TIP, index: SCRATCH_INDEX },
        // T68's restamp, and the path built from the repo-relative folder and
        // the file's own name — never stripped off the scratch path the index
        // sits at (14, lesson 8).
        { _tag: "HashObject", repo: REPO, text: T70_DONE },
        {
          _tag: "UpdateIndex",
          repo: REPO,
          index: SCRATCH_INDEX,
          path: `${PATH}/T70-first.md`,
          blob: fakeWrittenBlobId(1),
        },
        { _tag: "HashObject", repo: REPO, text: T71_DONE },
        {
          _tag: "UpdateIndex",
          repo: REPO,
          index: SCRATCH_INDEX,
          path: `${PATH}/T71-second.md`,
          blob: fakeWrittenBlobId(2),
        },
        { _tag: "WriteTree", repo: REPO, index: SCRATCH_INDEX },
        {
          _tag: "CommitTree",
          repo: REPO,
          tree: WRITTEN_TREE,
          // The branch is its own parent, so the commit lands on top of what
          // the fetch-back brought home rather than beside it — as the commit
          // it was resolved to, never as the name.
          parent: PRE_TIP,
          subject: "docs(issues): mark T70-first T71-second Done",
          body: STATUS_COMMIT_BODY,
        },
        // And the ref moves only from that same commit (`update-ref`'s third
        // argument), so a branch that moved during the write fails the move.
        { _tag: "UpdateRef", repo: REPO, ref: BRANCH_REF, to: STATUS_COMMIT, from: PRE_TIP },
      ]);
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  // The stems in the order they were handed in, which is the order the run
  // decided them (T69) and the order a reader meets them in the subject —
  // never git's byte order over the folder.
  it.effect("names the stems in the order the run approved them", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<GitCall>>([]);
      const store = yield* storeOver(calls, ON_BRANCH);

      yield* store.markLanded(marking(["T71-second", "T70-first"]));

      expect(
        (yield* Ref.get(calls)).flatMap((call) =>
          call._tag === "CommitTree" ? [call.subject] : [],
        ),
      ).toEqual(["docs(issues): mark T71-second T70-first Done"]);
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  // A stem the branch carries no file for is left out rather than refused: the
  // agent owns the branch, and a file it renamed must not cost the issues
  // beside it their commit.
  it.effect("commits the stems the branch carries and names only those", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<GitCall>>([]);
      const store = yield* storeOver(calls, ON_BRANCH);

      expect(yield* store.markLanded(marking(["T70-first", "T99-renamed"]))).toEqual(
        Option.some(STATUS_COMMIT),
      );

      const asked = yield* Ref.get(calls);
      expect(asked.filter((call) => call._tag === "HashObject")).toHaveLength(1);
      expect(asked.flatMap((call) => (call._tag === "CommitTree" ? [call.subject] : []))).toEqual([
        "docs(issues): mark T70-first Done",
      ]);
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  // And none of them at all is **no commit**, not an empty one: a commit whose
  // tree equals its parent's would be a bookkeeping commit saying nothing.
  it.effect("writes nothing when the branch carries none of the stems", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<GitCall>>([]);
      const store = yield* storeOver(calls, ON_BRANCH);

      expect(yield* store.markLanded(marking(["T99-renamed"]))).toEqual(Option.none());
      expect((yield* Ref.get(calls)).map((call) => call._tag)).toEqual(["RevParse", "ListTree"]);
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  // The folder gone from the branch is the one typed arm this shares with the
  // read (T71): nothing is written, and the caller's warning names the folder
  // rather than git.
  it.effect("answers FolderAbsent when the branch carries no issues folder", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<GitCall>>([]);
      const store = yield* storeOver(calls, {});
      const outcome = yield* Effect.either(store.markLanded(marking(["T70-first"])));

      expect(outcome).toMatchObject({
        left: { _tag: "FolderAbsent", folder: FOLDER, path: PATH, ref: BRANCH_REF },
      });
      expect((yield* Ref.get(calls)).map((call) => call._tag)).toEqual(["RevParse", "ListTree"]);
    }).pipe(Effect.provide(NodeContext.layer)),
  );
});

// The fixture the fake cannot stand in for: one repository, one folder, and
// three different contents — two committed on two branches, and one only on
// disk. git is a hard dependency of this package and the fake tier already
// spawns real children (`test/exec.test.ts`), so this is a unit case and not a
// live one.
const HAND = ["-c", "user.email=t@example.com", "-c", "user.name=Test"];

// git by hand in a real repository, so a case reads back what the tag left
// behind rather than asking the tag to confirm itself.
const handGit = (
  repo: string,
  ...args: ReadonlyArray<string>
): Effect.Effect<string, never, CommandExecutor.CommandExecutor> =>
  exec("git", "-C", repo, ...HAND, ...args).pipe(
    Effect.map((result) => result.stdout.trim()),
    Effect.orDie,
  );

const revParse = (
  repo: string,
  rev: string,
): Effect.Effect<string, never, CommandExecutor.CommandExecutor> => handGit(repo, "rev-parse", rev);

const issueFile = (title: string, status: string): string =>
  `# T1 — ${title}\n\nStatus: ${status}\nType: AFK\n`;

const ON_TIP = issueFile("as the branch has it", "ready-for-agent");
const ON_OTHER = issueFile("as the other branch has it", "needs-info");
const ON_DISK = issueFile("as the dev left it", "wontfix");

const realRepo = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const repo = yield* fs.makeTempDirectoryScoped();
  const run = (...args: ReadonlyArray<string>) =>
    exec("git", "-C", repo, ...HAND, ...args).pipe(Effect.map((result) => result.stdout.trim()));
  const file = `${repo}/${PATH}/T1-first.md`;
  yield* exec("git", "init", "-q", "-b", BRANCH, repo);
  yield* fs.makeDirectory(`${repo}/${PATH}`, { recursive: true });

  yield* fs.writeFileString(file, ON_TIP);
  yield* run("add", "-A");
  yield* run("commit", "-q", "-m", "the issue folder");
  const tip = yield* run("rev-parse", "HEAD");

  // A second branch where the same file says something else — the case the
  // whole tag exists for, since a read off disk could answer only one of them.
  yield* run("checkout", "-q", "-b", "other");
  yield* fs.writeFileString(file, ON_OTHER);
  yield* run("commit", "-q", "-a", "-m", "the other branch's copy");
  const other = yield* run("rev-parse", "HEAD");

  // And a third content that is committed nowhere: whichever branch is checked
  // out, this is what the host working tree holds.
  yield* fs.writeFileString(file, ON_DISK);
  return { repo, tip, other, file };
}).pipe(Effect.orDie);

describe("IssueStore against a real repository", () => {
  it.scoped("reads each ref's own copy, and never the working tree's", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { repo, tip, other, file } = yield* realRepo;
      const store = yield* IssueStore;

      const atTip = yield* store.issues({ repo, ref: tip, folder: FOLDER });
      const atOther = yield* store.issues({ repo, ref: other, folder: FOLDER });

      // Two refs, two answers, from one folder on one host.
      expect(atTip.map((issue) => issue.title)).toEqual(["T1 — as the branch has it"]);
      expect(atOther.map((issue) => issue.title)).toEqual(["T1 — as the other branch has it"]);
      expect(atTip[0]?.status).toBe("ready-for-agent");
      expect(atOther[0]?.status).toBe("needs-info");

      // And neither of them is what is on disk, which is the whole claim: the
      // working tree's contents depend on whichever branch the dev left
      // checked out, and that is not a fact about any issue (14).
      expect(yield* fs.readFileString(file)).toBe(ON_DISK);
      expect([...atTip, ...atOther].map((issue) => issue.status)).not.toContain("wontfix");
    }).pipe(Effect.provide(Layer.provideMerge(IssueStoreLive, NodeContext.layer))),
  );

  it.scoped("answers FolderAbsent at a ref cut before the folder existed", () =>
    Effect.gen(function* () {
      const { repo, tip } = yield* realRepo;
      const store = yield* IssueStore;

      const outcome = yield* Effect.either(
        store.issues({ repo, ref: tip, folder: "tasks/never-tracked" }),
      );
      expect(Either.isLeft(outcome)).toBe(true);
      if (Either.isLeft(outcome)) {
        expect(outcome.left._tag).toBe("FolderAbsent");
      }
    }).pipe(Effect.provide(Layer.provideMerge(IssueStoreLive, NodeContext.layer))),
  );

  // A ref git cannot resolve is neither of the two typed arms: it is git
  // failing to answer, and it travels as its own error carrying git's line —
  // flattening it into `FolderAbsent` would tell a dispatcher to add a folder
  // that is already there.
  it.scoped("fails with the GitError for a ref that does not resolve", () =>
    Effect.gen(function* () {
      const { repo } = yield* realRepo;
      const store = yield* IssueStore;

      const outcome = yield* Effect.either(
        store.issues({ repo, ref: "no-such-ref", folder: FOLDER }),
      );
      expect(Either.isLeft(outcome)).toBe(true);
      if (Either.isLeft(outcome)) {
        expect(outcome.left._tag).toBe("GitError");
      }
    }).pipe(Effect.provide(Layer.provideMerge(IssueStoreLive, NodeContext.layer))),
  );
});

// The scan's own fixture, and the claims only a real repository can carry: a
// ref that **is** the tip's ancestor and still answers, a remote-tracking ref
// beside the branch it tracks, a ref cut before the folder existed, and the
// tip's own ref — all read by two git processes against real objects.
const scanFile = (id: string, status: string): string =>
  `# ${id} — a thing to do\n\nStatus: ${status}\nType: AFK\n`;

const scanRepo = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const repo = yield* fs.makeTempDirectoryScoped();
  const run = (...args: ReadonlyArray<string>) =>
    exec("git", "-C", repo, ...HAND, ...args).pipe(Effect.map((result) => result.stdout.trim()));
  const write = (id: string, stem: string, status: string) =>
    fs.writeFileString(`${repo}/${PATH}/${stem}.md`, scanFile(id, status));
  yield* exec("git", "init", "-q", "-b", BRANCH, repo);

  // A ref from before the folder existed: its tree carries no copy of
  // anything, which is a witness with nothing to say.
  yield* run("commit", "-q", "--allow-empty", "-m", "before the folder");
  yield* run("branch", "before");

  yield* fs.makeDirectory(`${repo}/${PATH}`, { recursive: true });
  yield* write("T1", "T1-first", "ready-for-agent");
  yield* write("T2", "T2-second", "ready-for-agent");
  yield* write("T3", "T3-third", "ready-for-agent");
  yield* run("add", "-A");
  yield* run("commit", "-q", "-m", "the issue folder");

  // Somebody else's branch, forked here and pushed: T1 landed on it, so the
  // branch and the remote-tracking ref that tracks it both say so — two refs
  // at one commit, and two answers.
  yield* run("checkout", "-q", "-b", "A");
  yield* write("T1", "T1-first", "Done (PR #26)");
  yield* run("commit", "-q", "-a", "-m", "T1 landed on A");
  const onA = yield* run("rev-parse", "HEAD");
  yield* run("update-ref", "refs/remotes/origin/A", onA);
  yield* run("checkout", "-q", BRANCH);

  // A commit of this branch's own where T2 landed, kept as a ref — and then a
  // tip that reads `ready-for-agent` for it again. That is the ref standing
  // **behind** the tip whose copy says `Done` while the tip's does not.
  yield* write("T2", "T2-second", "Done");
  yield* run("commit", "-q", "-a", "-m", "T2 landed");
  yield* run("branch", "landed");
  yield* write("T2", "T2-second", "ready-for-agent");
  // And one this branch is the only ref to have landed, which is the tip's own
  // copy and never an answer.
  yield* write("T3", "T3-third", "Done");
  yield* run("commit", "-q", "-a", "-m", "what this branch has");
  const tip = yield* run("rev-parse", "HEAD");
  return { repo, tip };
}).pipe(Effect.orDie);

describe("IssueStore.landedElsewhere against a real repository", () => {
  it.scoped("answers every other ref that says Done, and asks git no ancestry question", () =>
    Effect.gen(function* () {
      const { repo, tip } = yield* scanRepo;
      const store = yield* IssueStore;

      // The set as T73 reads it and T69 selects it — the scan is asked about
      // the issues at the tip, and answers about the same files elsewhere.
      const issues = yield* store.issues({ repo, ref: tip, folder: FOLDER });
      expect(issues.map((issue) => issue.id)).toEqual(["T1", "T2", "T3"]);

      const landed = yield* store.landedElsewhere({ repo, folder: FOLDER, issues, tip });

      expect(landed).toEqual([
        // A branch that diverged, and the remote-tracking ref that tracks it:
        // two refs, both named, as `for-each-ref` spells them.
        { id: "T1", refs: ["refs/heads/A", "refs/remotes/origin/A"] },
        // **The ancestor case.** `refs/heads/landed` is behind the tip and its
        // copy says `Done` while the tip's does not — the branch was cut
        // before the landing reached its base, and the dispatcher wants to
        // know. No `merge-base --is-ancestor` was asked: it is the wrong
        // question and breaks under squash-merge (14).
        { id: "T2", refs: ["refs/heads/landed"] },
      ]);

      // And the fixture really is that shape, so the claim above is about a
      // ref git agrees is an ancestor rather than about a name.
      const ancestry = yield* exec(
        "git",
        "-C",
        repo,
        "merge-base",
        "--is-ancestor",
        "refs/heads/landed",
        tip,
      );
      expect(ancestry.exitCode).toBe(0);

      // T3 says `Done` on the tip and on no other ref, so the tip's own ref is
      // not an answer — nor is the ref that carries no folder at all.
      expect(landed.map((hit) => hit.id)).not.toContain("T3");
      const named = landed.flatMap((hit) => hit.refs);
      expect(named).not.toContain(`refs/heads/${BRANCH}`);
      expect(named).not.toContain("refs/heads/before");
    }).pipe(Effect.provide(Layer.provideMerge(IssueStoreLive, NodeContext.layer))),
  );

  // T103: the refs a `--hard-reset` discards are left out **by name**. A ref
  // standing at the very commit an excluded one names is still a witness, so
  // the exclusion cannot be a SHA's.
  it.scoped("leaves out the refs it is asked to, by name and never by commit", () =>
    Effect.gen(function* () {
      const { repo, tip } = yield* scanRepo;
      const store = yield* IssueStore;
      const issues = yield* store.issues({ repo, ref: tip, folder: FOLDER });

      const both = yield* store.landedElsewhere({
        repo,
        folder: FOLDER,
        issues,
        tip,
        alsoExcluding: ["refs/heads/A", "refs/remotes/origin/A"],
      });
      expect(both).toEqual([{ id: "T2", refs: ["refs/heads/landed"] }]);

      // `refs/remotes/origin/A` is at the same commit as `refs/heads/A`, and
      // still answers when only the branch is named.
      const one = yield* store.landedElsewhere({
        repo,
        folder: FOLDER,
        issues,
        tip,
        alsoExcluding: ["refs/heads/A"],
      });
      expect(one).toEqual([
        { id: "T1", refs: ["refs/remotes/origin/A"] },
        { id: "T2", refs: ["refs/heads/landed"] },
      ]);
    }).pipe(Effect.provide(Layer.provideMerge(IssueStoreLive, NodeContext.layer))),
  );
});

// The write's own fixture (T77), and the state a land actually finds: three
// issue files on the branch this run is landing, a `pre-commit` hook that
// writes a marker if anything runs one, a dirty working tree, and **a
// different branch checked out** — a branch checked out anywhere is one the
// guards already refused (`guards.ts`), so the commit is built against a ref
// nothing is standing on.
const writeRepo = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const repo = yield* fs.makeTempDirectoryScoped();
  const runtimeRoot = yield* fs.makeTempDirectoryScoped();
  const run = (...args: ReadonlyArray<string>) =>
    exec("git", "-C", repo, ...HAND, ...args).pipe(Effect.map((result) => result.stdout.trim()));
  yield* exec("git", "init", "-q", "-b", BRANCH, repo);
  // The identity the dispatching dev commits under, in the repository rather
  // than on this command line: `commit-tree` is run by the tag, which passes
  // no `-c` of its own — a host with no identity at all is `doctor`'s
  // business and not this write's.
  yield* run("config", "user.email", "t@example.com");
  yield* run("config", "user.name", "Test");
  yield* fs.makeDirectory(`${repo}/${PATH}`, { recursive: true });
  yield* fs.writeFileString(`${repo}/${PATH}/T70-first.md`, scanFile("T70", "ready-for-agent"));
  yield* fs.writeFileString(`${repo}/${PATH}/T71-second.md`, scanFile("T71", "ready-for-agent"));
  // The third is the one this run did not approve, and the whole of "exactly
  // those two blobs".
  yield* fs.writeFileString(`${repo}/${PATH}/T72-third.md`, scanFile("T72", "ready-for-agent"));
  // And a file outside the folder, so "the tree the branch had" is carried
  // rather than rebuilt: a commit that lost it would show up as a third path.
  yield* fs.writeFileString(`${repo}/README.md`, "the repo\n");
  yield* run("add", "-A");
  yield* run("commit", "-q", "-m", "what the run's agent left");
  const tip = yield* run("rev-parse", "HEAD");

  const marker = `${repo}/HOOK-RAN`;
  yield* fs.writeFileString(`${repo}/.git/hooks/pre-commit`, `#!/bin/sh\ntouch ${marker}\n`);
  yield* fs.chmod(`${repo}/.git/hooks/pre-commit`, 0o755);

  // The dispatcher's own working copy: another branch, one file staged and one
  // left dirty. Neither is a fact about any issue, and neither may move.
  yield* run("checkout", "-q", "-b", "somewhere-else");
  yield* fs.writeFileString(`${repo}/README.md`, "the repo, as the dev left it\n");
  yield* fs.writeFileString(`${repo}/${PATH}/T72-third.md`, scanFile("T72", "needs-info"));
  yield* run("add", `${PATH}/T72-third.md`);
  const dirty = yield* run("status", "--porcelain");
  // The scratch index goes where the land names it, beside the run's lock —
  // a directory that exists whenever a land runs, because the lock is in it.
  const index = statusIndexPathFor(runtimeRoot, slugFor(BRANCH));
  yield* fs.makeDirectory(`${runtimeRoot}/${LOCKS_DIRNAME}`);
  return { repo, index, tip, marker, dirty };
}).pipe(Effect.orDie);

describe("the status commit, against a real repository", () => {
  it.scoped("commits the approved files onto the branch, touching nothing else", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { repo, index, tip, marker, dirty } = yield* writeRepo;
      const store = issueStoreOver(yield* Git, fs);

      const commit = yield* store.markLanded({
        repo,
        branch: BRANCH,
        folder: FOLDER,
        stems: ["T70-first", "T71-second"],
        index,
      });

      // One commit, on the branch, whose parent is the tip the fetch-back left.
      const sha = Option.getOrThrow(commit);
      expect(yield* revParse(repo, `refs/heads/${BRANCH}`)).toBe(sha);
      expect(yield* revParse(repo, `${sha}^`)).toBe(tip);
      const subject = yield* handGit(repo, "log", "-1", "--format=%s", sha);
      expect(subject).toBe("docs(issues): mark T70-first T71-second Done");
      expect(yield* handGit(repo, "log", "-1", "--format=%b", sha)).toContain(
        "means landed on this ref",
      );

      // Its tree differs from its parent's in exactly the two approved files.
      expect(
        (yield* handGit(repo, "diff", "--name-only", tip, sha)).split("\n").filter((l) => l !== ""),
      ).toEqual([`${PATH}/T70-first.md`, `${PATH}/T71-second.md`]);
      // And each one parses (T68) to `Done` at the new commit, while the issue
      // this run did not approve is untouched.
      const issues = yield* store.issues({ repo, ref: sha, folder: FOLDER });
      expect(issues.map((issue) => [issue.id, issue.status])).toEqual([
        ["T70", "done"],
        ["T71", "done"],
        ["T72", "ready-for-agent"],
      ]);

      // **No hook fired**: `commit-tree` runs none, which is what lets this
      // write happen in a repository whose hooks are somebody else's.
      expect(yield* fs.exists(marker)).toBe(false);
      // **And the working tree and the index are where the dispatcher left
      // them**: the scratch index is a file under the runtime root, and
      // nothing here checked anything out. That file is gone once the commit
      // is written.
      expect(yield* handGit(repo, "status", "--porcelain")).toBe(dirty);
      expect(yield* fs.readFileString(`${repo}/${PATH}/T72-third.md`)).toBe(
        scanFile("T72", "needs-info"),
      );
      expect(yield* fs.exists(index)).toBe(false);
    }).pipe(Effect.provide(Layer.provideMerge(GitLive, NodeContext.layer))),
  );

  // Twice over the same branch, which is what a second run of it does: the
  // scratch index the first call left behind is replaced rather than added to,
  // so the second commit changes one file and not three.
  it.scoped("builds its tree from the branch and not from the index it left", () =>
    Effect.gen(function* () {
      const { repo, index } = yield* writeRepo;
      const store = issueStoreOver(yield* Git, yield* FileSystem.FileSystem);
      const mark = (stems: ReadonlyArray<string>) =>
        store.markLanded({ repo, branch: BRANCH, folder: FOLDER, stems, index });

      const first = Option.getOrThrow(yield* mark(["T70-first"]));
      const second = Option.getOrThrow(yield* mark(["T71-second"]));

      expect(yield* revParse(repo, `${second}^`)).toBe(first);
      expect(
        (yield* handGit(repo, "diff", "--name-only", first, second))
          .split("\n")
          .filter((l) => l !== ""),
      ).toEqual([`${PATH}/T71-second.md`]);
    }).pipe(Effect.provide(Layer.provideMerge(GitLive, NodeContext.layer))),
  );

  // **A branch that moved during the write fails the move** rather than being
  // pointed past what landed on it: the commit was built on the branch as it
  // was resolved, and `update-ref` is told to expect exactly that. The commit
  // somebody else made in between stays the branch tip, and the scratch index
  // is removed on the failure as on the success.
  it.scoped("refuses to move a branch that moved under it, and removes the index", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { repo, index, tip } = yield* writeRepo;
      const live = yield* Git;
      const executor = yield* CommandExecutor.CommandExecutor;
      // A hand commit on the branch, made between the tree being built and
      // the ref being moved — the one window the expected old value closes.
      const moved = yield* Ref.make<Option.Option<string>>(Option.none());
      const racing: typeof live = {
        ...live,
        commitTree: (options) =>
          Effect.gen(function* () {
            const hand = yield* handGit(
              repo,
              "commit-tree",
              `${tip}^{tree}`,
              "-p",
              tip,
              "-m",
              "by hand",
            );
            yield* handGit(repo, "update-ref", BRANCH_REF, hand);
            yield* Ref.set(moved, Option.some(hand));
            return yield* live.commitTree(options);
          }).pipe(Effect.provideService(CommandExecutor.CommandExecutor, executor)),
      };
      const store = issueStoreOver(racing, fs);

      const outcome = yield* Effect.either(
        store.markLanded({ repo, branch: BRANCH, folder: FOLDER, stems: ["T70-first"], index }),
      );

      expect(outcome).toMatchObject({ left: { _tag: "GitError" } });
      expect(yield* revParse(repo, BRANCH_REF)).toBe(Option.getOrThrow(yield* Ref.get(moved)));
      expect(yield* fs.exists(index)).toBe(false);
    }).pipe(Effect.provide(Layer.provideMerge(GitLive, NodeContext.layer))),
  );
});

// That the tag is reachable at all, which is what a composition either does or
// does not do.
const resolves = (layer: Layer.Layer<IssueStore, never>) =>
  Effect.gen(function* () {
    const store = yield* IssueStore;
    expect(typeof store.issues).toBe("function");
  }).pipe(Effect.provide(layer));

// The wiring (T71): the tag is in both dispatch-surface compositions and in
// neither read-only one. `status` and `doctor` gain no dependency on it, which
// is the rule every service layer has landed under since T3.
describe("the compositions", () => {
  it.scoped("resolves IssueStore from appLiveFor and from appDryRunLiveFor", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const repoRoot = yield* fs.makeTempDirectoryScoped();
      // `image` and `base` have no code default (T40), and both compositions
      // decode the config at build — so the served repo declares them.
      yield* fs.makeDirectory(speepoboxDir(repoRoot));
      yield* fs.writeFileString(
        `${speepoboxDir(repoRoot)}/config.toml`,
        'image = "baseline-image"\nbase = "origin/main"\n',
      );
      yield* resolves(appLiveFor(repoRoot, false).pipe(Layer.orDie));
      yield* resolves(appDryRunLiveFor(repoRoot, false).pipe(Layer.orDie));
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  // The recording layer keeps both reads real and holds the one write back
  // (T77) — built over the live layer, so a read cannot become a second
  // implementation and the write cannot fall through to the `GitLive` this
  // store carries inside itself.
  it.scoped("reads for real through the recording layer and records the write", () =>
    Effect.gen(function* () {
      const { repo, tip } = yield* scanRepo;
      const events = yield* Ref.make<ReadonlyArray<ReporterEvent>>([]);
      const recording = Layer.provideMerge(
        IssueStoreRecordingLive,
        Layer.mergeAll(
          NodeContext.layer,
          Layer.succeed(Reporter, {
            emit: (event) => Ref.update(events, (seen) => [...seen, event]),
          }),
        ),
      );

      yield* Effect.gen(function* () {
        const store = yield* IssueStore;
        const issues = yield* store.issues({ repo, ref: tip, folder: FOLDER });
        expect(issues.map((issue) => issue.id)).toEqual(["T1", "T2", "T3"]);
        // Both reads stay real through it, the scan included: a rehearsal
        // reads the refs a live run reads, which is what a dispatcher runs one
        // to see.
        const landed = yield* store.landedElsewhere({ repo, folder: FOLDER, issues, tip });
        expect(landed.map((hit) => hit.id)).toEqual(["T1", "T2"]);

        // And the write says what it would have done: no commit comes back,
        // because there is none — a rehearsal that answered a sha would be
        // naming an object no repository holds.
        const marked = yield* store.markLanded({
          repo,
          branch: BRANCH,
          folder: FOLDER,
          stems: ["T1-first", "T2-second"],
          index: SCRATCH_INDEX,
        });
        expect(marked).toEqual(Option.none());
      }).pipe(Effect.provide(recording));

      expect(
        (yield* Ref.get(events)).flatMap((event) =>
          event._tag === "MutationRecorded" ? [event.detail] : [],
        ),
      ).toEqual([`mark T1-first T2-second Done on '${BRANCH}'`]);
      // The repository is where it was: no new commit, and no scratch index
      // under a runtime root a rehearsal never writes to.
      const fs = yield* FileSystem.FileSystem;
      expect(yield* revParse(repo, `refs/heads/${BRANCH}`)).toBe(tip);
      expect(yield* fs.exists(SCRATCH_INDEX)).toBe(false);
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it("does not provide IssueStore from the read-only slice", () => {
    // @ts-expect-error — `status`, `doctor`, and `gc` compose no IssueStore (T71)
    const base: Layer.Layer<IssueStore> = appBaseLiveFor("/srv/hae", false);
    expect(base).toBeDefined();
  });
});

// The fake this ticket owes T73 (`test/support/issue-store-fake.ts`): scripted
// sets per ref, and the two refusals a guard branches on. Its own case, on the
// terms `test/git-fake.test.ts` set — a fake nobody asserts against is a fake
// that drifts from the tag it stands in for.
describe("the IssueStore fake", () => {
  it.effect("answers the set scripted for the ref it was asked, and records the ask", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<IssueStoreCall>>([]);
      const store = yield* IssueStore.pipe(
        Effect.provide(
          fakeIssueStore(calls, {
            sets: { [TIP]: [fakeIssue("T1")], [OTHER]: [fakeIssue("T2"), fakeIssue("T3")] },
          }),
        ),
      );

      expect(
        (yield* store.issues({ repo: REPO, ref: TIP, folder: FOLDER })).map((i) => i.id),
      ).toEqual(["T1"]);
      expect(
        (yield* store.issues({ repo: REPO, ref: OTHER, folder: FOLDER })).map((i) => i.id),
      ).toEqual(["T2", "T3"]);
      // Which ref was read is the assertion T73 needs: the set is read at the
      // branch tip, never at the base. The list is the tag's whole surface
      // since T72, so the set reads are picked out by their tag rather than
      // assumed to be all of it.
      const sets = (yield* Ref.get(calls)).filter((call) => call._tag === "Issues");
      expect(sets.map((call) => call.ref)).toEqual([TIP, OTHER]);
    }),
  );

  it.effect("answers the scan's scripted hits, and records that it was asked", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<IssueStoreCall>>([]);
      const store = yield* IssueStore.pipe(
        Effect.provide(
          fakeIssueStore(calls, { landed: { T1: ["refs/heads/A", "refs/remotes/origin/A"] } }),
        ),
      );

      const landed = yield* store.landedElsewhere({
        repo: REPO,
        folder: FOLDER,
        issues: [fakeIssue("T1"), fakeIssue("T2")],
        tip: TIP,
      });

      // An unscripted id is one nobody else has landed, which is the ordinary
      // case; the hits come back in the order they were asked about.
      expect(landed).toEqual([{ id: "T1", refs: ["refs/heads/A", "refs/remotes/origin/A"] }]);
      // *Whether it ran at all* is what T74 asserts: both witnesses fire under
      // `--issues all` and neither under an enumerated one.
      expect(yield* Ref.get(calls)).toEqual([
        { _tag: "LandedElsewhere", repo: REPO, folder: FOLDER, ids: ["T1", "T2"], tip: TIP },
      ]);
    }),
  );

  it.effect("answers FolderAbsent for a ref nothing scripted, and Unparseable on demand", () =>
    Effect.gen(function* () {
      const absent = yield* Effect.either(
        Effect.flatMap(IssueStore, (store) =>
          store.issues({ repo: REPO, ref: TIP, folder: FOLDER }),
        ).pipe(Effect.provide(fakeIssueStore())),
      );
      expect(absent).toMatchObject({
        _tag: "Left",
        left: { _tag: "FolderAbsent", folder: FOLDER, path: PATH, ref: TIP },
      });

      const unreadable = yield* Effect.either(
        Effect.flatMap(IssueStore, (store) =>
          store.issues({ repo: REPO, ref: TIP, folder: FOLDER }),
        ).pipe(
          Effect.provide(
            fakeIssueStore(undefined, {
              unparseable: { file: `${PATH}/T2-second.md`, detail: "not an issue" },
            }),
          ),
        ),
      );
      expect(unreadable).toMatchObject({
        _tag: "Left",
        left: { _tag: "Unparseable", file: `${PATH}/T2-second.md`, ref: TIP },
      });
    }),
  );
});
