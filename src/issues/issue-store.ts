// `IssueStore` (SPEC §2), the read half: the parsed issues under
// `<folder>/issues/` **as they are at a ref** (T71), and the same folder read
// at *every* ref to see who else already landed one (T72) — both out of git
// objects.
//
// **It reads a ref and writes a commit, and never touches the host working
// tree** (14, SPEC §2). What is on disk depends on whichever branch the dev
// left checked out, which is not a fact about any issue — so the set a run is
// dispatched with is read at the branch tip the checkout forks from (T73), and
// there is no fallback to the working copy the way `run.sh:1017-1030` has one.
// bash materialized the folder with `git archive` into a scratch directory and
// read files from there; this materializes nothing, which is also what lets it
// run before the checkout exists.
//
// The folder is the repo-relative directory the dispatcher named (14, lesson
// 9: the ledger, the resume target, and anything a human reads keep that path).
// Nothing here derives a scratch path, and every sentence this tag's failures
// carry names the path the dispatcher typed.
//
// It speaks git through `Git` and nothing else (T27), and each question costs
// two reads and never more: which files are there and what they say (T71),
// which refs there are and what their copies say (T72). A read per file, or a
// read per ref, is the shape that does not scale — the scan runs over every
// ref a dispatching host has.
import { type CommandExecutor, FileSystem } from "@effect/platform";
import { Context, Data, Effect, Either, Layer, Option } from "effect";
import { Git, type GitError, GitLive, type GitShape } from "../git/git.ts";
import { fileNameOf, type Issue, LANDED_STATUS, parseIssue, withStatus } from "./issue.ts";

// The directory an issue set lives in, under the folder a dispatch names —
// `tasklib`'s layout, and the one this package's own queue is written in.
export const ISSUES_DIRECTORY = "issues";

const MARKDOWN = ".md";

// Where a folder's issues are, spelled once: the refusals quote this path and
// the read lists it, so a drift between them would refuse about a directory
// nobody read.
export const issuesPathFor = (folder: string): string => `${folder}/${ISSUES_DIRECTORY}`;

// Which repo to read, which ref to read it at, and the folder as the
// dispatcher gave it.
export interface IssuesRequest {
  readonly repo: string;
  readonly ref: string;
  readonly folder: string;
}

// The scan over every ref (T72): which repo, the folder as the dispatcher
// gave it, the issues to ask about, and the one ref to leave out.
//
// `tip` is the commit the set was read at — T73's `tipSha`, the same value
// `issues` was asked at. Refs are left out by **what they point at** rather
// than by the name they carry: a second ref at that commit holds the tip's own
// copy of every file, so an answer about it would be an answer about the tip.
//
// The issues are T69's selected `Issue`s and not their ids, because an id
// names no file. The copy this reads at another ref is
// `<folder>/issues/<stem>.md` (`fileNameOf`, T68) — the stem carries prose the
// id does not — and answering by id while addressing by stem is what the pair
// on the value buys. The ticket writes it `ids`; this is that parameter with
// the file name it cannot be asked without.
export interface LandedElsewhereRequest {
  readonly repo: string;
  readonly folder: string;
  readonly issues: ReadonlyArray<Issue>;
  readonly tip: string;
  // Full ref names left out beside the tip, **by name** (T103): the refs a
  // `--hard-reset` dispatch is about to discard — `refs/heads/<b>` by the
  // reset and `refs/remotes/origin/<b>` by the lease push that overwrites it.
  // By name and never by SHA: a *different* branch standing at the discarded
  // tip keeps those commits, and is still a witness. Absent is empty.
  readonly alsoExcluding?: ReadonlyArray<string>;
}

// The write (T77): which repo the commit is built in, the branch it lands on,
// the folder as the dispatcher gave it, the stems of the issues this run
// approved — in the order they are to be named, which is the order the run
// decided them in (T69) — and the scratch index the tree is built in.
//
// Stems rather than ids or paths: the stem is what a reader recognises in a
// commit list (14, lesson 10), it is what the file is named, and the path is
// built here from the repo-relative folder and it (lesson 8 — never stripped
// off a scratch path).
//
// The repo is the **served** one, never the run's clone: the agent owns that
// clone's hooks and config, and write-side git does not run there once it has
// (14, `run.sh:1338-1342`).
//
// The index is handed in rather than derived here: where this host writes is
// the caller's answer (`statusIndexPathFor`, `dispatch/plan.ts`), and the
// store removes the file once the commit is written, whether it was or not.
export interface MarkLandedRequest {
  readonly repo: string;
  readonly branch: string;
  readonly folder: string;
  readonly stems: ReadonlyArray<string>;
  readonly index: string;
}

// One id, and every ref whose copy of its file says `Done`, as
// `for-each-ref` names them — `refs/heads/x`, `refs/remotes/origin/x`. Both
// spellings of one branch are two answers and not one: the refusal quotes
// them back (T74), and a local branch behind its own remote is fixed
// differently from a branch somebody else landed.
export interface LandedElsewhere {
  readonly id: string;
  readonly refs: ReadonlyArray<string>;
}

// The ref carries no `<folder>/issues/` at all. That is how an **untracked**
// folder presents, and how a branch forked before the folder existed presents,
// and the two are one answer here because git cannot tell them apart: neither
// ref holds the directory. T73 refuses on it — the port requires tracked sets
// (map ruling of 2026-08-20) and never falls back to the host tree — so this
// arm exists to be told apart from the one below, where a file *is* there and
// cannot be read.
export class FolderAbsent extends Data.TaggedError("FolderAbsent")<{
  readonly folder: string;
  readonly path: string;
  readonly ref: string;
}> {}

// One file under that directory this package cannot read as an issue. It names
// the file **and the ref**: a dispatcher whose branch tip carries a stale copy
// of a file they have already fixed on another branch needs both to act, and
// the file alone would send them to the working tree this tag deliberately
// does not read.
export class Unparseable extends Data.TaggedError("Unparseable")<{
  readonly file: string;
  readonly ref: string;
  readonly detail: string;
}> {}

// The two arms above, and git failing to answer at all. The guards tell the
// first two apart because the dispatcher's next move differs (SPEC §3) — add
// the folder to the branch, or fix a header — and a `GitError` travels as
// itself rather than flattened into either, because git's own line is the
// whole of what a caller can say about an unresolvable ref or a repository it
// cannot read.
export type IssueStoreError = FolderAbsent | Unparseable | GitError;

export interface IssueStoreShape {
  // Every `.md` under `<folder>/issues/` at the ref, parsed (T68). Non-`.md`
  // entries are ignored rather than refused — a folder holding a `README` or a
  // `TEMPLATE.txt` beside its issues is ordinary — and subdirectories are not
  // entries at all (`Git.listTree`).
  //
  // The order is the one the ref lists them in, which is git's byte order over
  // the names. Nothing downstream depends on it: selection orders by blocker
  // and by id (T69), and the two orders agreeing by accident is not something
  // to rest on.
  readonly issues: (request: IssuesRequest) => Effect.Effect<ReadonlyArray<Issue>, IssueStoreError>;
  // **"Approved, awaiting merge" is derived, not stored** (14, SPEC §2): for
  // each issue handed in, every ref other than the tip whose copy of its file
  // says `Done`. One entry per issue that has at least one such ref, and an
  // empty answer means nobody else has landed any of them.
  //
  // **No ancestry read.** `merge-base --is-ancestor` is the wrong question and
  // breaks under squash-merge (14): if the other ref were merged into the tip,
  // the tip's copy would say `Done` too, and that it does not is the whole
  // finding. A ref standing *behind* the tip whose copy says `Done` answers for
  // the same reason — the branch was cut before the landing reached its base,
  // which is exactly what the dispatcher wants to know.
  //
  // The two typed arms of `issues` have no meaning here, which is why only a
  // `GitError` is in the channel: **the scan is a witness**, and a witness that
  // cannot read a copy has nothing to say about it. A ref whose tree lacks the
  // file, and a blob that does not parse, each contribute nothing rather than
  // refusing a dispatch over three hundred refs this package does not own.
  readonly landedElsewhere: (
    request: LandedElsewhereRequest,
  ) => Effect.Effect<ReadonlyArray<LandedElsewhere>, GitError>;
  // **The write, and the whole of 14's one-author guarantee** (T77): every
  // issue a run approved gets its `Status:` rewritten to `Done` in **one**
  // commit on the run branch, so the bookkeeping reaches a base in the same
  // merge as the code it describes and the two can never disagree.
  //
  // It is built in the served repo with plumbing — `commit-tree` runs no hooks
  // and needs no working tree — and never inside the clone, and never against
  // the repository's own index: the run's own copy is still on disk when this
  // runs, and the branch it lands on may be checked out nowhere at all.
  //
  // The answer is the commit, or **nothing**: a run whose approved stems name
  // no file the branch carries writes no commit, and an empty set is not a
  // commit with no changes in it. `Option` rather than a sentinel sha, because
  // "there was nothing to write" and "here is what was written" are two
  // answers and one of them is not a commit.
  //
  // Its failure is the caller's warning and never the run's outcome (14's
  // lesson 4): a step that runs while unpushed commits are in hand may not
  // fail the run, so every arm here is one the land reports and walks past.
  readonly markLanded: (
    request: MarkLandedRequest,
  ) => Effect.Effect<Option.Option<string>, IssueStoreError>;
}

export class IssueStore extends Context.Tag("IssueStore")<IssueStore, IssueStoreShape>() {}

// The stem is the file's name without `.md` — what a reader recognises in a
// commit list (14, lesson 10), and what the parse takes an issue's id off.
const stemOf = (name: string): string => name.slice(0, -MARKDOWN.length);

// The status commit's subject (14, lesson 10): `docs` because the change is
// markdown, matching the hand-written status commits already on these
// branches, and the stems space-separated because a reader scanning a commit
// list recognises those and not a bare number.
export const statusCommitSubject = (stems: ReadonlyArray<string>): string =>
  `docs(issues): mark ${stems.join(" ")} Done`;

// And its body, which says what `Done` means rather than restating the
// subject (`run.sh:1373-1374`): the one meaning the ruling gives the word, and
// where a reader finds the ruling.
export const STATUS_COMMIT_BODY =
  `Approved by the review pass on this branch. Status: ${LANDED_STATUS} means landed on this ref` +
  " — it reaches a base only when this branch merges (docs/agents/issue-tracker.md).";

// The read, over a `Git` rather than over the tag — the shape `recordingGit`
// already has: the layer below hands it the live one, and a test hands it a
// fake, so what the two-reads-and-a-parse composition does is assertable
// without a repository underneath it.
//
// `git` is taken here rather than asked for inside `issues`: a tag whose
// methods ask for a service is a mechanism leaking through a domain seam
// (`git/git.ts` carries the ruling). `fs` is taken the same way and for the
// same reason — the write below removes the scratch index it built its tree
// in (T77).
export const issueStoreOver = (git: GitShape, fs: FileSystem.FileSystem): IssueStoreShape => ({
  issues: ({ repo, ref, folder }) =>
    Effect.gen(function* () {
      const path = issuesPathFor(folder);
      const entries = yield* git.listTree({ repo, ref, path });
      if (Option.isNone(entries)) {
        return yield* new FolderAbsent({ folder, path, ref });
      }
      const files = entries.value.filter((entry) => entry.name.endsWith(MARKDOWN));
      // **One read for the whole set**, not one per file: the scan over every
      // ref reads thousands of these (T72), and a `cat-file` per file is the
      // shape that does not scale.
      const blobs = yield* git.readBlobs({ repo, ids: files.map((file) => file.id) });
      const issues: Array<Issue> = [];
      for (const file of files) {
        const text = blobs.get(file.id);
        if (text === undefined) {
          // Our invariant, not the dispatcher's: the batch answers every id it
          // was handed or fails, so an id listed out of this very tree going
          // unanswered is this package being wrong about its own read
          // (AGENTS.md's outcome-row test).
          return yield* Effect.dieMessage(
            `${path}/${file.name} at ${ref}: the batch answered no blob for ${file.id}`,
          );
        }
        const parsed = parseIssue(stemOf(file.name), text);
        if (Either.isLeft(parsed)) {
          return yield* new Unparseable({
            file: `${path}/${file.name}`,
            ref,
            detail: parsed.left.detail,
          });
        }
        issues.push(parsed.right);
      }
      return issues;
    }),
  landedElsewhere: ({ repo, folder, issues, tip, alsoExcluding = [] }) =>
    Effect.gen(function* () {
      const path = issuesPathFor(folder);
      const refs = yield* git.forEachRef({ repo });
      // **Only the tip itself is excluded.** `refs/remotes/origin/<branch>` is
      // not: post-fetch (T70) it is current, and a remote copy saying `Done`
      // while the local branch's does not is a local branch behind its own
      // remote. Neither is a ref standing behind the tip, for the reason on
      // the shape above. The one exception is the request's own: refs a reset
      // is discarding, named by the caller (T103).
      const others = refs.filter((ref) => ref.sha !== tip && !alsoExcluding.includes(ref.name));
      const objectNameAt = (sha: string, issue: Issue): string =>
        `${sha}:${path}/${fileNameOf(issue)}`;
      // **One batch, whatever the ref count**, and each object name asked once:
      // a branch and its remote-tracking copy are two refs at one commit, so
      // the same file would otherwise be read twice for every branch that has
      // been pushed. Both refs still answer below — the dedupe is of the read,
      // never of the witnesses.
      const names = new Set(
        others.flatMap((ref) => issues.map((issue) => objectNameAt(ref.sha, issue))),
      );
      const copies = yield* git.readObjects({ repo, names: [...names] });
      const landed = new Map<string, Array<string>>();
      for (const ref of others) {
        for (const issue of issues) {
          const text = copies.get(objectNameAt(ref.sha, issue));
          if (text === undefined) {
            continue;
          }
          const parsed = parseIssue(issue.stem, text);
          // `done` is 14's one meaning — landed on this ref — and the parse
          // reads the annotated `Done (PR #26; …)` a human writes as the same
          // token (T68).
          if (Either.isLeft(parsed) || parsed.right.status !== "done") {
            continue;
          }
          const found = landed.get(issue.id);
          if (found === undefined) {
            landed.set(issue.id, [ref.name]);
          } else {
            found.push(ref.name);
          }
        }
      }
      // In the order the issues were handed in, refs in the order
      // `for-each-ref` listed them: what a refusal reads out (T74) is the
      // dispatcher's own sequence, not a hash order.
      return issues.flatMap((issue) => {
        const refsWithIt = landed.get(issue.id);
        return refsWithIt === undefined ? [] : [{ id: issue.id, refs: refsWithIt }];
      });
    }),
  markLanded: ({ repo, branch, folder, stems, index }) =>
    Effect.gen(function* () {
      const ref = `refs/heads/${branch}`;
      const path = issuesPathFor(folder);
      // **The branch, resolved once**: every step below is about this commit
      // and not about whatever the name says a moment later. The files are
      // read at it, the tree starts from it, the commit stands on it, and the
      // ref is moved only if it still holds it — so a commit landing on the
      // branch while this one is written fails the move rather than being
      // dropped off the branch by it.
      const parent = yield* git.revParse({ repo, rev: ref });
      // The same two reads the set is read with (T71), at the branch rather
      // than at the tip the run started from: the agent's commits are on it by
      // now, so what is rewritten is the copy this run's work left behind.
      const entries = yield* git.listTree({ repo, ref: parent, path });
      if (Option.isNone(entries)) {
        return yield* new FolderAbsent({ folder, path, ref });
      }
      // In the order the stems were handed in, which is the order the run
      // decided them (T69) and the order the subject names them. A stem the
      // branch carries no file for is left out rather than refused: the agent
      // owns the branch, a file it renamed or removed is its doing, and
      // refusing would cost the issues beside it their commit.
      const files = stems.flatMap((stem) => {
        const entry = entries.value.find((candidate) => candidate.name === `${stem}${MARKDOWN}`);
        return entry === undefined ? [] : [{ stem, entry }];
      });
      if (files.length === 0) {
        return Option.none();
      }
      const blobs = yield* git.readBlobs({ repo, ids: files.map((file) => file.entry.id) });
      // The scratch index: the tree starts as the branch's own, so everything
      // this run's work committed is carried and only the entries below are
      // replaced.
      const write = Effect.gen(function* () {
        yield* git.readTree({ repo, ref: parent, index });
        const written: Array<string> = [];
        for (const file of files) {
          const text = blobs.get(file.entry.id);
          if (text === undefined) {
            // Unreachable, and filtered rather than asserted: the batch answers
            // every id it was handed or fails (`git.readBlobs`), so this drops
            // nothing — and a `die` here would fail a run whose commits are
            // fetched back and unpushed, which is the one thing this step may
            // not do (14, lesson 4).
            continue;
          }
          const blob = yield* git.hashObject({ repo, text: withStatus(text, LANDED_STATUS) });
          yield* git.updateIndex({ repo, index, path: `${path}/${file.entry.name}`, blob });
          written.push(file.stem);
        }
        const tree = yield* git.writeTree({ repo, index });
        const commit = yield* git.commitTree({
          repo,
          tree,
          // The branch as its own parent, so the commit lands on top of what
          // the fetch-back just brought home rather than beside it.
          parent,
          subject: statusCommitSubject(written),
          body: STATUS_COMMIT_BODY,
        });
        yield* git.updateRef({ repo, ref, to: commit, from: parent });
        return Option.some(commit);
      });
      // **And the index is gone afterwards, written or not**: nothing reads it
      // once the tree is out, and a file left under the runtime root is one
      // more thing on a host a dispatcher has to account for. A removal that
      // fails is ignored rather than reported — the next write replaces the
      // file whole, and the commit's own answer is the one the land reports.
      return yield* write.pipe(Effect.ensuring(Effect.ignore(fs.remove(index, { force: true }))));
    }),
});

// `IssueStoreLive` needs `Git` and a `FileSystem`, and it takes the first the
// way `GitRecordingLive` takes its own live layer: provided **inside**, so what
// the composition root sees is a layer wanting what every other term at that
// level wants (`app.ts`) — a `CommandExecutor`, and the platform's filesystem
// the scratch index is removed through (T77).
export const IssueStoreLive: Layer.Layer<
  IssueStore,
  never,
  CommandExecutor.CommandExecutor | FileSystem.FileSystem
> = Layer.effect(
  IssueStore,
  Effect.map(Effect.all([Git, FileSystem.FileSystem]), ([git, fs]) => issueStoreOver(git, fs)),
).pipe(Layer.provide(GitLive));
