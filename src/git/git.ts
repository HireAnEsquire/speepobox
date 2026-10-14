// `Git` (SPEC §2): domain-shaped over branded types, not a `git` flag bag. It
// answers questions about a *named* repo — what a revision resolves to, and
// which worktrees have which branches checked out — and its failures are the
// typed `GitError` of SPEC §3.
//
// **Every operation names the repo it runs in, reads no less than writes**
// (T27). Which repo this package dispatches for is a host fact resolved once
// at the composition root and passed down (AGENTS.md); an operation that could
// be spelled without it would answer from wherever the process happened to
// start, and a read answering for a different repo than the write beside it is
// the same defect as a write to the wrong one — it just fails later and
// quieter. The field is required on every one of them so that forgetting it is
// a type error rather than a convention, and a `@ts-expect-error` shape pin in
// `test/git.test.ts` turns making it optional back into a red line.
//
// Only the operations this package has callers for are here — `push` and the
// commit count arrived with the land step that consumes them (T11), because a
// method with no consumer is a layer, not a tracer bullet.
//
// A nonzero exit from the chokepoint is a *result*, not a failure
// (`internal/exec.ts`) — `exec` hands back the code and both streams, and this
// is the layer that decides which codes are a `GitError`.
import { resolve } from "node:path";
import { CommandExecutor } from "@effect/platform";
import { Context, Data, DateTime, Effect, Layer, Option, Schema } from "effect";
import {
  exec,
  type ExecBytes,
  execFed,
  type ExecOutcome,
  type ExecResult,
  execUnder,
  GIT_INDEX_FILE,
} from "../internal/exec.ts";
import {
  type DispatcherFreshness,
  dispatcherFreshnessArgs,
  readDispatcherFreshness,
} from "./dispatcher-freshness.ts";
import { repoArgs } from "./repo-args.ts";
import type { RepoUrl } from "./repo-url.ts";

// Clone, fetch-back, push, rev-parse (SPEC §3). `detail` is the line a caller
// renders or folds into its own refusal.
export class GitError extends Data.TaggedError("GitError")<{
  readonly detail: string;
}> {}

// One entry of `git worktree list`. The branch is absent on a detached HEAD
// and on a bare repo, which is a real state and not a missing answer.
export const Worktree = Schema.Struct({
  path: Schema.String,
  branch: Schema.OptionFromNullOr(Schema.String),
});
export type Worktree = Schema.Schema.Type<typeof Worktree>;

// Where a clone comes from and where it lands. `source` is a `RepoUrl` and
// not a string (SPEC §9, invariant 2): the branded parse is the only door into
// a checkout, so a URL still carrying a credential cannot be typed into one —
// the repo root this clones from goes through it like any remote would.
export interface CloneOptions {
  readonly source: RepoUrl;
  readonly branch: string;
  // The checkout path, derived once by the plan.
  readonly into: string;
}

// The fetch every dispatch makes before it resolves its base (T70): the repo
// whose remote-tracking refs are being moved, and the remote they come from.
// The remote is named on the shape although `ORIGIN` is the only answer a call
// site has — this is git's own argv, where the remote is the one word after
// the verb, and a refspec is what is deliberately absent: the operation moves
// `refs/remotes/<remote>/*` and nothing else.
export interface FetchOptions {
  readonly repo: string;
  readonly remote: string;
}

// The fetch-back's two ends — the clone the commits are in, and the repo whose
// branch ref they land on — and the refspec's two halves, which are a name
// each rather than one name used twice. `branch` is what the clone holds them
// on; `onto` is what they land on here. They are the same name on the way home
// and different when the release's salvage sends the same commits to a branch
// of its own (T29): one operation, one refspec, and the only thing that varies
// between the two call sites is the destination.
export interface FetchBackOptions {
  readonly from: RepoUrl;
  readonly into: string;
  readonly branch: string;
  readonly onto: string;
}

// Which branch goes to the remote, and the repo it goes from — named rather
// than assumed for the same reason the fetch-back names its end: it is the
// dispatching repo, resolved once at the composition root, and the one whose
// config and credentials are ours to push with. Never the checkout: write-side
// git does not run in a repo the agent owned (`run.sh:1662-1669`).
export interface PushOptions {
  readonly from: string;
  readonly branch: string;
  // A rewrite of the published branch, which only `--hard-reset` asks for
  // (T101). Absent is the ordinary push, argv unchanged: forward or fail.
  readonly lease?: PushLease;
}

// What the remote's branch must still be for the rewrite to go through (T101,
// D7): pinned to where `origin/<b>` stood after the guard phase's fetch, never
// to whatever the remote-tracking ref says at push time — the bare form of the
// flag reads that ref, and anything that fetched in between would have
// silently moved the expectation. `None` is "origin had no such branch", which
// git reads as *must not exist*, so a branch that appeared meanwhile refuses.
export interface PushLease {
  readonly expect: Option.Option<string>;
}

// A revision expression, and the repo it is an expression about.
export interface RevParseOptions {
  readonly repo: string;
  readonly rev: string;
}

// The repo whose `origin/HEAD` is read (T115).
export interface OriginHeadOptions {
  readonly repo: string;
}

// The two revisions whose merge-base is the run's diff boundary: `--base` as
// it resolved, and the working branch. The branch is a name and the ref is
// built here, as `fetchBack` and `push` build theirs — a caller spelling
// `refs/heads/` itself is a caller that can spell it wrong.
export interface MergeBaseOptions {
  readonly repo: string;
  readonly baseSha: string;
  readonly branch: string;
}

// The containment question the salvage asks before minting a rescue (T32):
// **is this commit already reachable from that branch, in this repo**. The
// commit is the copy's tip, read in the copy; the branch and the repo are the
// host's, because only the host repo can say what its own branch holds.
export interface BranchContainsOptions {
  readonly repo: string;
  readonly branch: string;
  readonly commit: string;
}

// The dispatcher-freshness question (T42/T44): is this repo's package
// directory missing a commit `base` already has. The argv is
// `dispatcherFreshnessArgs`'s and the repo is the one the range is asked in
// — never composed at the call site, so the preflight and `doctor`'s probe
// cannot answer it differently (T44).
export interface DispatcherFreshnessOptions {
  readonly repo: string;
  readonly base: string;
}

// Which editor this dispatcher's git opens, asked of the repository whose
// config is part of the answer (T84). No key and no value on the shape: the
// question is git's own — `git var GIT_EDITOR` — and the repo is on it for the
// reason it is on every other read here (T27).
export interface EditorOptions {
  readonly repo: string;
}

// One config key, in the repository whose config answers for it (T35). The
// read resolves the way git itself does — the repository's own config, then
// the dispatching dev's — because the identity a dev commits under is
// ordinarily theirs and not this repo's, and `git config user.name` is the one
// question that has always answered that.
export interface ConfigReadOptions {
  readonly repo: string;
  readonly key: string;
}

// One config key and the value it takes, in the repository it is written into
// — **that repository's own config and no other**. There is no scope on this
// shape: `--global` is unrepresentable rather than unused, so the only file a
// write of ours can land in is the `.git/config` of the repo it names.
export interface ConfigWriteOptions {
  readonly repo: string;
  readonly key: string;
  readonly value: string;
}

// A half-open commit range, `<from>..<to>`, counted rather than listed — in
// the repo the count is about.
export interface CommitRange {
  readonly repo: string;
  readonly from: string;
  readonly to: string;
}

// One exclusion and several tips (T101): the commits reachable from **any**
// of `tips` and from none of `excluding`, counted once — git takes the union,
// so history two tips share is one set of commits and not two. It is what a
// hard reset discards on both ends, the local tip and origin's; adding two
// `CommitRange` counts together would count their shared history twice, and
// a pushed branch shares all of it with its remote.
export interface ReachableCount {
  readonly repo: string;
  readonly excluding: string;
  readonly tips: ReadonlyArray<string>;
}

// One directory at one ref (T71): the repo to ask, the ref whose tree is read,
// and the repo-relative directory whose entries are wanted. The ref is a
// separate word from the path rather than git's `<ref>:<path>` object name,
// because those two spellings answer an absent directory differently — the
// object name cannot tell a path that is not there from a ref that is not
// there, and `IssueStore` refuses on exactly that difference.
export interface ListTreeOptions {
  readonly repo: string;
  readonly ref: string;
  readonly path: string;
}

// One file in that directory: the name it carries *inside* the directory, and
// the blob the ref holds it as. The name is the entry's own and not the path
// it was listed under, so a caller reads a file's stem off it without knowing
// which folder the answer came from.
export interface TreeEntry {
  readonly name: string;
  readonly id: string;
}

// The blobs to read, and the repo that holds them. **A list, because the point
// is the batch**: the scan this exists for reads thousands of files (T72), and
// one `git` per file is the shape that does not scale.
export interface ReadBlobsOptions {
  readonly repo: string;
  readonly ids: ReadonlyArray<string>;
}

// Every ref one repo holds (T72): the repo, and nothing else on the shape.
// No pattern and no sort — the scan asks about *all* of them, because "some
// other ref already says this issue is `Done`" is a question no branch-naming
// convention answers (14), and a filter here would be this package deciding
// which branches count.
export interface ForEachRefOptions {
  readonly repo: string;
}

// One ref and what it points at, as `for-each-ref` names them:
// `refs/heads/x`, `refs/remotes/origin/x`. The **full** name, never a short
// one — it is what a refusal quotes back (T74), and `x` and `origin/x` are two
// refs a dispatcher fixes differently.
export interface RefTip {
  readonly name: string;
  readonly sha: string;
}

// The local branches of one repo (T81): the repo, and nothing else. A sibling
// of `ForEachRefOptions` above and not a parameter of it, because the two ask
// different questions of the same plumbing — the scan wants every ref there is
// and what it points at, and the picker wants the `refs/heads/` half with a
// **date** on each one, which `forEachRef`'s format does not carry.
export interface BranchesOptions {
  readonly repo: string;
}

// One local branch, named as `--branch` names it — bare, with `refs/heads/`
// off — and when its tip was committed. The date is what the picker orders by
// at rest and renders as each row's age (T81); it is the committer date rather
// than the author date, because a rebased branch was worked on when it was
// rebased and that is what "which branch was I on last" means.
export interface LocalBranch {
  readonly name: string;
  readonly committedAt: DateTime.Utc;
}

// The objects to read, and the repo that holds them: `<sha>:<path>` object
// names, where `readBlobs` above takes blob ids. A list for the same reason
// that one is — the point is the batch — and every name is asked as written,
// so a caller reads the answers back under the names it fed in.
export interface ReadObjectsOptions {
  readonly repo: string;
  readonly names: ReadonlyArray<string>;
}

// The five operations the status commit is built with (T77), and the scratch
// index three of them share. **No working tree and no `.git/index`**: the
// commit is written in the served repo, after the land's fetch-back and while
// the agent's own clone is still on disk, so the one place it may not touch is
// the state a human has checked out there (14, and `run.sh:1338-1342`).
//
// The index is a path rather than a flag on the tag because it is a *file this
// package chose the location of* — under the runtime root, beside the locks
// and the checkouts, never in the repository being written — and it reaches
// git as `GIT_INDEX_FILE`, the one variable a child of ours is given rather
// than forwarded (`internal/exec.ts`).
export interface ReadTreeOptions {
  readonly repo: string;
  // The commit or tree whose content the index starts from — the branch the
  // run is landing, so what is committed differs from it in the entries
  // replaced below and in nothing else.
  readonly ref: string;
  readonly index: string;
}

// One blob's text, written into the repo's object database and answered by the
// id git gave it. The text travels on stdin like every other fed child here
// (T71): a file's contents are not a word of argv.
export interface HashObjectOptions {
  readonly repo: string;
  readonly text: string;
}

// One entry replaced in the scratch index: the **repo-relative** path, built
// from the folder the dispatcher named and the file's own name, and the blob
// it now points at (14, lesson 8 — never a prefix stripped off a scratch
// path). The mode is not on the shape: every path this writes is a `.md` file
// under an issues folder, and a caller that could choose a mode could turn one
// into a symlink.
export interface UpdateIndexOptions {
  readonly repo: string;
  readonly index: string;
  readonly path: string;
  readonly blob: string;
}

export interface WriteTreeOptions {
  readonly repo: string;
  readonly index: string;
}

// The commit itself: a tree, the one parent it stands on, and the two halves
// of its message — subject and body as separate words, because git joins them
// with the blank line a commit message needs and a caller that spelled that
// itself would eventually spell it wrong.
export interface CommitTreeOptions {
  readonly repo: string;
  readonly tree: string;
  readonly parent: string;
  readonly subject: string;
  readonly body: string;
}

// Where a ref is moved to, in the repo that holds it. This is the whole of
// what makes the commit above visible: until it runs, the tree and the commit
// are objects nothing points at.
//
// `from` is the commit the ref must still be at, and git refuses the move when
// it is not: the new commit was built on that one, so a ref that moved while
// it was being written would otherwise be pointed past whatever landed on it,
// and that commit would drop off the branch without a word.
export interface UpdateRefOptions {
  readonly repo: string;
  readonly ref: string;
  readonly to: string;
  readonly from: string;
}

export interface GitShape {
  // A revision expression resolved to what it names — a SHA for `<ref>^{commit}`.
  readonly revParse: (options: RevParseOptions) => Effect.Effect<string, GitError>;
  // Every worktree attached to the named repo, the current one included. git
  // refuses a fetch into a branch checked out in *any* of them, so the guard
  // that asks this question needs the whole list, not just HEAD.
  readonly worktrees: (repo: string) => Effect.Effect<ReadonlyArray<Worktree>, GitError>;
  // The `origin` remote's URL, in the named repo (T39). One definition for a
  // question two callers ask — `doctor`'s git probe, and the composition
  // root's resolution of which repo `gh` acts on — so neither restates
  // `git remote get-url origin` on its own; `doctor/probes.ts` used to, around
  // this tag rather than through it. A repo with no `origin` configured is a
  // `GitError` here, exactly as an unresolvable revision is: the caller
  // decides what that means, whether that is a FAIL row or a refusal naming
  // the repo root.
  readonly originUrl: (repo: string) => Effect.Effect<string, GitError>;
  // What `refs/remotes/origin/HEAD` points at, short — `"origin/main"` — in
  // the named repo (T115): the base `init` writes when no `--base` names one.
  // **Absence is an answer**, as `readConfig`'s is: a clone that never ran
  // `git remote set-head`, and a repo with no `origin` at all, both leave the
  // ref unset, and the caller refuses with the remedy rather than recovering
  // from an error. Only a git that could not answer is a `GitError`.
  readonly originHead: (
    options: OriginHeadOptions,
  ) => Effect.Effect<Option.Option<string>, GitError>;
  // The diff boundary (`run.sh:1048`): where the branch left the base. It is
  // on the tag rather than on the guard's own subprocess call because it is a
  // question about a repo like the two above it, and the SHA it answers is
  // what the ledger row carries and every review round is scoped to — the one
  // answer that could least afford to come from somewhere else (T27).
  // Unrelated histories have no merge-base, which arrives here as the
  // `GitError` the guard folds into its own refusal.
  readonly mergeBase: (options: MergeBaseOptions) => Effect.Effect<string, GitError>;
  // Whether the branch already holds the commit, asked of the repo that owns
  // the branch (T32). It is on the tag rather than composed out of `mergeBase`
  // at the call site for the same reason the diff boundary is: it is a
  // question about a repo, and the salvage's whole answer — rescue, or the
  // commits are already home — turns on it. A `false` is an answer and not a
  // failure; git says so with its exit code, and this is where that becomes a
  // boolean (SPEC §3).
  readonly branchContains: (options: BranchContainsOptions) => Effect.Effect<boolean, GitError>;
  // T44's preflight refusal, through the tag rather than the bare subprocess
  // call `doctor`'s probe 10 makes (`probes.ts` forbids that dependency, this
  // package's dispatch surface does not) — `dispatcherFreshnessArgs` is the
  // one argv both callers render, so they cannot disagree. A nonzero exit is
  // `BaseUnresolvable`, read by `readDispatcherFreshness` off the result
  // rather than raised as a `GitError`: the caller cannot refuse on an answer
  // it does not have, and only a git that never ran at all is a failure here.
  readonly dispatcherFreshness: (
    options: DispatcherFreshnessOptions,
  ) => Effect.Effect<DispatcherFreshness, GitError>;
  // The run's checkout: a self-contained clone of the branch at its tip.
  // `--no-hardlinks` copies objects instead of sharing inodes with the source
  // `.git` (`run.sh:1262-1269`) — the agent owns this clone, and a shared
  // object file it corrupted would corrupt the host repo with it.
  readonly clone: (options: CloneOptions) => Effect.Effect<void, GitError>;
  // The editor a `git commit` in this repository would open (T84). It is a
  // question for git and not a chain assembled here: `git var GIT_EDITOR`
  // walks `GIT_EDITOR`, `core.editor`, `VISUAL`, `EDITOR`, and its own `vi`
  // fallback, so what `--feedback-edit` opens is what the dispatcher's commits
  // open — a hand-rolled chain typechecks and would answer differently the
  // first time git's own order or its fallback changed, in a package that
  // reads no `EDITOR` of its own.
  //
  // **Absence is not an answer here**, which is what separates it from
  // `readConfig` below: git's chain ends in a literal, so nobody having set
  // one is not a state this has to report. What it *can* report is git
  // refusing — `fatal: Terminal is dumb, but EDITOR unset`, which is what a
  // host with no editor configured and no usable terminal answers — and that
  // is a `GitError` the caller turns into its own refusal.
  readonly editor: (options: EditorOptions) => Effect.Effect<string, GitError>;
  // What a repository's config says about one key, resolved as git resolves it
  // — a value, or nothing at all (T35). **Absence is an answer**: a host that
  // never set `user.name` is the case bash's fallback exists for, so it comes
  // back as a `None` the caller substitutes for rather than an error it has to
  // recover from. Only a git that could not answer at all is a `GitError`.
  readonly readConfig: (
    options: ConfigReadOptions,
  ) => Effect.Effect<Option.Option<string>, GitError>;
  // One key written into the config of the repository it names, and nowhere
  // else. This is how the run's clone carries the dispatching dev's commit
  // identity before the container starts (`run.sh:1452-1454`): the write
  // happens on the host, into the clone, in the checkout step — an identity
  // the agent could set is a claim, and one the dispatcher set before the agent
  // existed is a default the agent had no part in. It is not enforcement and
  // does not pretend to be: the agent owns its clone and can override the value
  // or pass `--author`, which makes correct attribution the path of least
  // resistance and a deviation visible in the commit.
  readonly setConfig: (options: ConfigWriteOptions) => Effect.Effect<void, GitError>;
  // The remote-tracking refs this dispatch's base is resolved against (T70):
  // `git fetch <remote>` in the named repo, and nothing more. **No `--prune`,
  // no tags, and no refspec into `refs/heads`** — every one of those is a
  // write to something a dispatcher owns, and this exists to make
  // `origin/master` current, not to tidy up after them. The default refspec is
  // the remote's own `fetch` config, which is what a hand-run `git fetch
  // origin` moves too, so the dispatch and the dispatcher's own habit touch
  // the same refs.
  //
  // It is the one write on this tag a guard makes (`guards.ts`, SPEC §7): it
  // holds nothing and has no release, so the failure it raises is a `GitError`
  // here and the caller's own refusal there, exactly as the read beside it is.
  readonly fetch: (options: FetchOptions) => Effect.Effect<void, GitError>;
  // The commits coming home: the repo fetches *from* the clone, fast-forward
  // only. Both halves are load-bearing. The direction is the security property
  // (`run.sh:1662-1669`) — the agent owns the clone's hooks and config, so
  // write-side git never runs inside it, and upload-pack is hardened against
  // exactly this. The refspec carries no `+`, so a branch the agent rebased
  // cannot rewrite the user's branch backward; that refusal is what the
  // checkout's derived release reads keep-vs-delete off (05 Q10).
  //
  // **No `+` on either destination** (T29). The home fetch must stay
  // fast-forward-only for the reason above, and the release's rescue lands on
  // a ref that does not exist yet — git's fast-forward check applies only to
  // refs already present, so a new one is created unconditionally and needs no
  // force. A rescue ref that somehow *does* exist and is not an ancestor
  // refuses, which is the right answer: clobbering a previous rescue is the
  // one way that design can lose work.
  readonly fetchBack: (options: FetchBackOptions) => Effect.Effect<void, GitError>;
  // The commits leaving the host, from the repo the fetch-back just put them
  // in. **The refspec is explicit at both ends** (`run.sh:1545-1549`): a bare
  // push reads `push.default` and whatever upstream the branch happens to
  // carry, and a task branch created from `origin/master` carries that — so
  // the one shape that cannot land this run on the base ref is the one that
  // names both ends. No `+`, and `--force-with-lease` only when a lease is
  // handed in — rewriting a published branch belongs to `--hard-reset`
  // (T101), whose lease is pinned to a SHA the guard phase read; every other
  // push goes forward or it fails.
  readonly push: (options: PushOptions) => Effect.Effect<void, GitError>;
  // `git rev-list --count <from>..<to>` — the land's two questions
  // (`run.sh:1540-1541`): what the branch holds past the diff boundary, and
  // what this run added past the tip it started from. Zero past the boundary
  // is the whole of "nothing to land", so the answer is a number the caller
  // branches on rather than a list it has to count.
  readonly countCommits: (range: CommitRange) => Effect.Effect<number, GitError>;
  // `git rev-list --count ^<excluding> <tip>...` — the hard reset's discard
  // count (T101), one union over every tip it names.
  readonly countReachable: (count: ReachableCount) => Effect.Effect<number, GitError>;
  // One directory's files, as the ref holds them (T71). **An absent path is a
  // typed answer and not a failure**: a ref that never carried the folder and
  // a ref whose folder was deleted both come back as `None`, which is how an
  // untracked issue set or a branch cut before the folder existed presents,
  // and the caller's refusal is written about that rather than about git.
  // Only a ref git cannot resolve is a `GitError`.
  //
  // Subdirectories are not entries: this answers the blobs, because the
  // question it exists for is which *files* a directory holds at a ref.
  readonly listTree: (
    options: ListTreeOptions,
  ) => Effect.Effect<Option.Option<ReadonlyArray<TreeEntry>>, GitError>;
  // The text of every blob named, read by **one** `git cat-file --batch`
  // (T71): the ids go in on stdin and the answers come back framed, so the
  // number of children is one whether the caller asked for eight files or
  // 2712. Keyed by the id asked for — identical files are one blob in git, so
  // two names can share an answer, which a map says and a list would not.
  //
  // An id this repo does not hold is a `GitError` here: every caller so far
  // reads ids it just listed out of a tree, so a missing one is a repository
  // that changed underneath or one that is broken, not an answer.
  readonly readBlobs: (
    options: ReadBlobsOptions,
  ) => Effect.Effect<ReadonlyMap<string, string>, GitError>;
  // Every ref in the repo and the object each one points at, by **one**
  // `git for-each-ref` (T72). `refs/heads/*` and `refs/remotes/*` alike, in
  // the order git lists them: a remote-tracking ref is current after the
  // dispatch's own fetch (T70), and what it says is the same branch read
  // somewhere else.
  //
  // Which of them are interesting is the caller's question and not this one's
  // — the scan excludes exactly the ref it is standing on (T72), and a shape
  // that pre-filtered would answer a narrower question than the one 14 asked.
  readonly forEachRef: (
    options: ForEachRefOptions,
  ) => Effect.Effect<ReadonlyArray<RefTip>, GitError>;
  // Every **local** branch and when its tip was committed (T81), by one
  // `for-each-ref` over `refs/heads/` — the picker's list, and the question
  // `forEachRef` beside it cannot answer, since it carries no dates.
  //
  // No order is promised: git lists refs alphabetically and the picker sorts
  // by the date this answers, so a caller that wanted recency would get it
  // from the value rather than from an argv flag two readers would have to
  // agree about. Which branches are pickable is the caller's question too —
  // protected names and the ones a worktree holds are `Git.worktrees`' and
  // the guards', not a filter here.
  readonly branches: (
    options: BranchesOptions,
  ) => Effect.Effect<ReadonlyArray<LocalBranch>, GitError>;
  // The same single `git cat-file --batch` as `readBlobs`, over `<sha>:<path>`
  // object names and **tolerant of the ones that are not there** (T72): a name
  // git answered `missing` to is absent from the map, which is an answer about
  // that one object rather than a failure of the read.
  //
  // That is the whole difference between the two, and it belongs to their
  // callers. `readBlobs` reads ids listed out of a tree a moment earlier, so a
  // gap there is a repository that changed underneath it; this one asks for
  // one file's name at **every ref in the repo**, where most refs do not carry
  // it at all — a read that failed on the first branch cut before the folder
  // existed would say nothing about the three hundred after it.
  readonly readObjects: (
    options: ReadObjectsOptions,
  ) => Effect.Effect<ReadonlyMap<string, string>, GitError>;
  // The status commit's five steps (T77), in the order `IssueStore.markLanded`
  // runs them: the branch's tree into a scratch index, a rewritten file into
  // the object database, that blob over the entry it replaces, the index back
  // out as a tree, the tree as a commit on the branch, and the branch onto it.
  //
  // They are five operations rather than one because each is a child with its
  // own failure, and the caller's answer to any of them failing is the same
  // warning (the write is advisory, 14's lesson 4) — but *which* step failed
  // is what the dispatcher re-stamps by hand from. `commit-tree` runs no hooks
  // and needs no working tree, which is what lets the whole sequence run in a
  // repository somebody has a different branch checked out in.
  readonly readTree: (options: ReadTreeOptions) => Effect.Effect<void, GitError>;
  readonly hashObject: (options: HashObjectOptions) => Effect.Effect<string, GitError>;
  readonly updateIndex: (options: UpdateIndexOptions) => Effect.Effect<void, GitError>;
  readonly writeTree: (options: WriteTreeOptions) => Effect.Effect<string, GitError>;
  readonly commitTree: (options: CommitTreeOptions) => Effect.Effect<string, GitError>;
  readonly updateRef: (options: UpdateRefOptions) => Effect.Effect<void, GitError>;
}

export class Git extends Context.Tag("Git")<Git, GitShape>() {}

const BRANCH_PREFIX = "refs/heads/";

// The mode every entry the status commit writes carries (`run.sh:1367`): a
// regular, non-executable file, which is what an issue `.md` is in every tree
// this package reads one out of. It is a constant here rather than a field on
// `UpdateIndexOptions` for the reason that shape gives.
const BLOB_MODE = "100644";

// The remote the commits go home to, and the one the dispatch fetches from
// before it resolves its base (T70). bash names it at every push, and
// `doctor`'s probe 5 already refuses a repo without one, so this is a fact
// about the repo rather than a caller's choice — a parameter no call site
// could answer differently would be a knob, not a seam. It is exported for
// the one operation whose argv names a remote of its own (`fetch`), so the
// guard that calls it spells the same constant rather than a second literal.
export const ORIGIN = "origin";

// `git worktree list --porcelain`: records separated by blank lines, each
// opening with `worktree <path>` and carrying either `branch <ref>` or
// `detached`. Pure, so the parse is tested without a fake git (SPEC §2).
export const parseWorktrees = (porcelain: string): ReadonlyArray<Worktree> => {
  const worktrees: Array<Worktree> = [];
  let path = Option.none<string>();
  let branch = Option.none<string>();
  const flush = (): void => {
    if (Option.isSome(path)) {
      worktrees.push({ path: path.value, branch });
    }
    path = Option.none();
    branch = Option.none();
  };
  for (const line of porcelain.split("\n")) {
    if (line.startsWith("worktree ")) {
      flush();
      path = Option.some(line.slice("worktree ".length).trim());
    } else if (line.startsWith("branch ")) {
      const ref = line.slice("branch ".length).trim();
      branch = Option.some(ref.startsWith(BRANCH_PREFIX) ? ref.slice(BRANCH_PREFIX.length) : ref);
    }
  }
  flush();
  return worktrees;
};

// `git ls-tree -z`: one NUL-terminated record per entry, each
// `<mode> SP <type> SP <oid> TAB <path>`. `-z` rather than the default,
// because the default quotes and escapes a name carrying anything unusual and
// this answer is handed back as a filename.
//
// **No records at all is the directory being absent at that ref**, which is
// why the answer is an `Option` rather than an empty array: git stores no
// empty directories, so a tree that is there has something in it. A directory
// holding nothing but subdirectories is `Some([])` and not `None` — the
// records were there, and none of them was a file.
//
// The name is the entry's own: `ls-tree <ref> -- <dir>/` prints paths from the
// repo root, and everything up to the last `/` is the directory the caller
// already named. Pure, so the parse is tested without a git (SPEC §2).
export const parseTree = (records: string): Option.Option<ReadonlyArray<TreeEntry>> => {
  const rows = records.split("\0").filter((record) => record !== "");
  if (rows.length === 0) {
    return Option.none();
  }
  const entries: Array<TreeEntry> = [];
  for (const record of rows) {
    const tab = record.indexOf("\t");
    if (tab === -1) {
      continue;
    }
    const [, type, id] = record.slice(0, tab).split(" ");
    const path = record.slice(tab + 1);
    if (type === "blob" && id !== undefined) {
      entries.push({ name: path.slice(path.lastIndexOf("/") + 1), id });
    }
  }
  return Option.some(entries);
};

// `git for-each-ref --format=%(objectname) %(refname)`: one line per ref, the
// object first and the ref's full name after it. A refname carries neither a
// space nor a newline (`git check-ref-format`), so the first space is the
// whole of the frame.
//
// A line this cannot frame is skipped rather than refused — the blank one a
// trailing newline leaves is such a line — because the read it serves is a
// witness (T72): one unreadable line is no reason to say nothing about the
// refs around it. Pure, so the parse is tested without a repository (SPEC §2).
export const parseRefs = (lines: string): ReadonlyArray<RefTip> => {
  const refs: Array<RefTip> = [];
  for (const line of lines.split("\n")) {
    const space = line.indexOf(" ");
    if (space === -1) {
      continue;
    }
    const sha = line.slice(0, space);
    const name = line.slice(space + 1).trim();
    if (sha !== "" && name !== "") {
      refs.push({ name, sha });
    }
  }
  return refs;
};

// `git for-each-ref --format=%(committerdate:unix) %(refname) refs/heads/`:
// one line per local branch, the tip's commit time in seconds since the epoch
// first and the ref's full name after it. The frame is `parseRefs`' — the
// first space, which a refname cannot contain — and the same line-skipping
// rule applies, for the same reason: this list is what a picker offers, and
// one branch whose date git could not render is no reason to offer none.
//
// The name comes back bare, because `--branch` names a branch that way and
// the picker's product is that flag's value (T81). Pure, so the parse is
// tested without a repository (SPEC §2).
export const parseBranches = (lines: string): ReadonlyArray<LocalBranch> => {
  const branches: Array<LocalBranch> = [];
  for (const line of lines.split("\n")) {
    const space = line.indexOf(" ");
    if (space === -1) {
      continue;
    }
    const seconds = Number(line.slice(0, space));
    const ref = line.slice(space + 1).trim();
    if (!Number.isFinite(seconds) || !ref.startsWith(BRANCH_PREFIX)) {
      continue;
    }
    branches.push({
      name: ref.slice(BRANCH_PREFIX.length),
      committedAt: DateTime.unsafeMake(seconds * 1000),
    });
  }
  return branches;
};

// One answer of `git cat-file --batch`. The id is what git echoed — the
// object's own id where it resolved one, the name as it was asked where it did
// not — and the text is absent for git's `missing` line, which is an answer
// about one object rather than a failure of the read (T72 is the caller that
// expects them).
export interface BatchObject {
  readonly id: string;
  readonly text: Option.Option<string>;
}

const LF = 0x0a;

// `git cat-file --batch`, in the order the ids were fed in: a header line, the
// object's bytes, and a newline git adds after them. **The frame is counted in
// bytes**, which is why this reads the child's output as bytes rather than as
// the string every other parse here takes: `size` is what git wrote, not how
// many characters it decodes to.
export const parseCatFileBatch = (stdout: Uint8Array): ReadonlyArray<BatchObject> => {
  const decoder = new TextDecoder();
  const objects: Array<BatchObject> = [];
  let at = 0;
  while (at < stdout.length) {
    const eol = stdout.indexOf(LF, at);
    if (eol === -1) {
      break;
    }
    const [id = "", , size] = decoder.decode(stdout.subarray(at, eol)).split(" ");
    const length = Number(size);
    // `<name> missing`, and any other header this cannot frame: the record is
    // that one line, and the next one starts after it.
    if (size === undefined || !Number.isInteger(length)) {
      objects.push({ id, text: Option.none() });
      at = eol + 1;
      continue;
    }
    const from = eol + 1;
    objects.push({ id, text: Option.some(decoder.decode(stdout.subarray(from, from + length))) });
    at = from + length + 1;
  }
  return objects;
};

export const GitLive: Layer.Layer<Git, never, CommandExecutor.CommandExecutor> = Layer.effect(
  Git,
  Effect.gen(function* () {
    // The executor is captured here rather than left in every operation's
    // requirements: a tag whose methods ask for a service is a mechanism
    // leaking through a domain seam.
    const executor = yield* CommandExecutor.CommandExecutor;

    // A missing git binary is a `GitError` like any other here — the caller
    // decides what that means, and `doctor` is where a broken toolchain is
    // diagnosed properly.
    const git = (...args: ReadonlyArray<string>): Effect.Effect<ExecResult, GitError> =>
      exec("git", ...args).pipe(
        Effect.mapError(() => new GitError({ detail: "git CLI not found — install git" })),
        Effect.provideService(CommandExecutor.CommandExecutor, executor),
      );

    // `-C <repo>` rather than the working directory, on every command that
    // runs *in* a repo: which repo that is was resolved at the composition
    // root (AGENTS.md), and this is the one spelling of it every operation
    // below goes through. `clone` is the exception that proves the rule — it
    // has no repo to run in yet, and names both of its ends instead.
    //
    // **`-C` names a directory, and a directory is not a repository** (T32).
    // It changes directory and leaves git to *discover* the repository by
    // walking up, so a path holding no repository resolves to the nearest
    // enclosing one — and a checkout under a runtime root inside the host
    // repo's working tree resolves to the host repo, which then answers every
    // question about the copy with a fact about itself. `--git-dir` turns the
    // walk off: git is told which repository rather than asked to find one, so
    // a path holding no repository fails naming that path, in git's own words,
    // and resolves to no other repo. That is T27's invariant actually held
    // rather than nearly held — the salvage on the way *in* is a read against
    // a path nobody has established is a repository yet, by design.
    //
    // **The two flags name the same directory, so the path is made absolute
    // here rather than assumed to be.** git resolves a relative `--git-dir`
    // against `-C`'s destination and not against the process, so a relative
    // repo would name a directory inside itself — `-C box/x --git-dir=box/x/.git`
    // looks for `box/x/box/x/.git` and dies. The absolute paths are the ones
    // this package builds (`findRepoRoot`, `checkoutPathFor`), but
    // `checkoutPathFor` is rooted at the configured `runtime-root`, which is a
    // plain `Config.string` a `config.toml` may spell relatively — so
    // absoluteness is a property of the config's *input* and cannot be an
    // invariant this reads off. `repoArgs` (`repo-args.ts`, the package's one
    // spelling of the pair) makes it one, against the process working
    // directory, which is what bare `-C` resolved a relative repo
    // against before the `--git-dir` beside it existed: the flag that closed
    // the discovery walk changes no path that already worked.
    //
    // `resolve` reads `process.cwd()`, which makes it host work — so it runs
    // when the effect runs and not when it is built. Describing an operation
    // reaches nothing outside the process either way, and the shape pin in
    // `test/git.test.ts` builds these calls without ever yielding them.
    const inRepo = (
      repo: string,
      ...args: ReadonlyArray<string>
    ): Effect.Effect<ExecResult, GitError> => Effect.suspend(() => git(...repoArgs(repo), ...args));

    // The same child with its stdin written and its stdout taken as bytes —
    // the one operation below that talks to git rather than only reading it
    // (`internal/exec.ts`). It goes through the same `repoArgs`, because
    // "every git operation names the repo it runs in" (T27) is a rule about
    // all of them and not about the ones that happen to share a helper.
    const fedInRepo = (
      stdin: string,
      repo: string,
      ...args: ReadonlyArray<string>
    ): Effect.Effect<ExecBytes, GitError> =>
      Effect.suspend(() => execFed(stdin, "git", ...repoArgs(repo), ...args)).pipe(
        Effect.mapError(() => new GitError({ detail: "git CLI not found — install git" })),
        Effect.provideService(CommandExecutor.CommandExecutor, executor),
      );

    // The same child **under the scratch index** (T77): `GIT_INDEX_FILE` is
    // handed to this spawn and to no other, so the repository's own
    // `.git/index` — what a human has staged in the repo this run is landing
    // into — is never the file git reads or writes. It goes through the same
    // `repoArgs` as everything above it, for T27's reason — and it is resolved
    // for `inRepo`'s (T32): git reads a relative `GIT_INDEX_FILE` against
    // `-C`'s destination, not against this process, so a `runtime-root`
    // spelled relatively would aim the scratch index inside the served repo.
    const indexedInRepo = (
      index: string,
      repo: string,
      ...args: ReadonlyArray<string>
    ): Effect.Effect<ExecResult, GitError> =>
      Effect.suspend(() =>
        execUnder(
          { name: GIT_INDEX_FILE, value: resolve(index) },
          "git",
          ...repoArgs(repo),
          ...args,
        ),
      ).pipe(
        Effect.mapError(() => new GitError({ detail: "git CLI not found — install git" })),
        Effect.provideService(CommandExecutor.CommandExecutor, executor),
      );

    // The one child both batched reads spawn (T71, T72): the names go in on
    // stdin, one per line, and `--batch` answers each in turn, so the number
    // of children is one whether the caller asked for eight objects or 2712.
    // They travel on stdin rather than in argv for the reason the prompt does
    // (T9) — argv has a length limit and a batch does not.
    //
    // A line per name rather than `join`'s separators: an empty list must feed
    // nothing at all, where a trailing newline on nothing is a blank line git
    // answers ` missing` to.
    const catFileBatch = (
      repo: string,
      names: ReadonlyArray<string>,
    ): Effect.Effect<ExecBytes, GitError> =>
      fedInRepo(names.map((name) => `${name}\n`).join(""), repo, "cat-file", "--batch");

    const failed = (what: string, result: ExecOutcome): GitError =>
      new GitError({
        detail: result.stderr.trim() === "" ? what : `${what}: ${result.stderr.trim()}`,
      });

    return {
      revParse: ({ repo, rev }) =>
        inRepo(repo, "rev-parse", "--verify", rev).pipe(
          Effect.flatMap((result) =>
            result.exitCode === 0 && result.stdout.trim() !== ""
              ? Effect.succeed(result.stdout.trim())
              : failed(`'${rev}' does not resolve`, result),
          ),
        ),
      worktrees: (repo) =>
        inRepo(repo, "worktree", "list", "--porcelain").pipe(
          Effect.flatMap((result) =>
            result.exitCode === 0
              ? Effect.succeed(parseWorktrees(result.stdout))
              : failed("could not list the worktrees of this repo", result),
          ),
        ),
      // `--get-url` rather than a bare `remote show`: the one line a caller
      // wants, with none of `show`'s network round trip to describe the
      // remote's branches. A repo with no `origin` exits nonzero, which is a
      // `GitError` here like any other unanswerable read.
      originUrl: (repo) =>
        inRepo(repo, "remote", "get-url", ORIGIN).pipe(
          Effect.flatMap((result) =>
            result.exitCode === 0 && result.stdout.trim() !== ""
              ? Effect.succeed(result.stdout.trim())
              : failed("no 'origin' remote configured", result),
          ),
        ),
      // `-q` makes an unset ref exit 1 in silence, where without it git exits
      // 128 exactly as it does for a directory holding no repository — so the
      // exit code alone tells an absence from a failure to answer.
      originHead: ({ repo }) =>
        inRepo(repo, "symbolic-ref", "-q", "--short", `refs/remotes/${ORIGIN}/HEAD`).pipe(
          Effect.flatMap((result) => {
            const value = result.stdout.trim();
            if (result.exitCode === 1 || (result.exitCode === 0 && value === "")) {
              return Effect.succeed(Option.none<string>());
            }
            return result.exitCode === 0
              ? Effect.succeed(Option.some(value))
              : failed(`could not read ${ORIGIN}/HEAD in this repo`, result);
          }),
        ),
      mergeBase: ({ repo, baseSha, branch }) =>
        inRepo(repo, "merge-base", baseSha, `refs/heads/${branch}`).pipe(
          Effect.flatMap((result) =>
            result.exitCode === 0 && result.stdout.trim() !== ""
              ? Effect.succeed(result.stdout.trim())
              : failed(`'${branch}' and ${baseSha} have no merge-base`, result),
          ),
        ),
      // `merge-base --is-ancestor` is git's own answer to the question, and
      // its exit code is the whole of it: 0 is contained, 1 is not, and
      // anything else is git failing to answer — an object this repo has never
      // seen exits 128, which is a `GitError` here and the caller's decision
      // there. Equality is one case of contained and not the question: the
      // case this exists for is the branch having moved *ahead* of the copy,
      // where the tips differ and the commits are home anyway (T32).
      branchContains: ({ repo, branch, commit }) =>
        inRepo(repo, "merge-base", "--is-ancestor", commit, `refs/heads/${branch}`).pipe(
          Effect.flatMap((result) =>
            result.exitCode === 0
              ? Effect.succeed(true)
              : result.exitCode === 1
                ? Effect.succeed(false)
                : failed(`could not tell whether '${branch}' already holds ${commit}`, result),
          ),
        ),
      // The argv is `dispatcherFreshnessArgs`'s, rendered through `inRepo`
      // rather than the bare `-C` `probes.ts` uses (T27, T32); the verdict is
      // `readDispatcherFreshness`'s, read off the result whatever the exit
      // code — a nonzero one is `BaseUnresolvable`, not a reason to fail this
      // effect.
      dispatcherFreshness: ({ repo, base }) =>
        Effect.suspend(() => inRepo(repo, ...dispatcherFreshnessArgs(repo, base))).pipe(
          Effect.map((result) => readDispatcherFreshness(result)),
        ),
      clone: ({ source, branch, into }) =>
        git("clone", "--no-hardlinks", "--branch", branch, source, into).pipe(
          Effect.flatMap((result) =>
            result.exitCode === 0
              ? Effect.void
              : failed(`could not clone '${branch}' into ${into}`, result),
          ),
        ),
      // `var` rather than `config --get core.editor`: the value is a
      // resolution of five sources and only one of them is the config, and
      // git is the only thing that can be asked for the answer it would use
      // itself. It never comes back empty on a working git — the chain ends in
      // `vi` — so an empty line is git failing to answer.
      editor: ({ repo }) =>
        inRepo(repo, "var", "GIT_EDITOR").pipe(
          Effect.flatMap((result) =>
            result.exitCode === 0 && result.stdout.trim() !== ""
              ? Effect.succeed(result.stdout.trim())
              : failed("could not resolve an editor (git var GIT_EDITOR)", result),
          ),
        ),
      // `--get` rather than a bare read, so the answer is one value; the scope
      // is git's own resolution, which is where a dev's identity actually
      // lives. **Exit 1 is "nobody set that", not a failure** — it is the whole
      // reason the caller has a fallback — and a key set to nothing is the same
      // absence spelled differently, so both arrive as `None`. Every other
      // nonzero exit is git failing to answer, which is a `GitError` like any
      // other read's.
      readConfig: ({ repo, key }) =>
        inRepo(repo, "config", "--get", key).pipe(
          Effect.flatMap((result) => {
            const value = result.stdout.trim();
            if (result.exitCode === 1 || (result.exitCode === 0 && value === "")) {
              return Effect.succeed(Option.none<string>());
            }
            return result.exitCode === 0
              ? Effect.succeed(Option.some(value))
              : failed(`could not read '${key}' from the config of this repo`, result);
          }),
        ),
      // `--local` spelled out, so the file this lands in is the named repo's
      // own `.git/config` and is named in the argv a reader greps. Never
      // `--global`: the write is a property of one clone, and a tool that could
      // reach a dev's own gitconfig is a tool nobody should run twice.
      setConfig: ({ repo, key, value }) =>
        inRepo(repo, "config", "--local", key, value).pipe(
          Effect.flatMap((result) =>
            result.exitCode === 0
              ? Effect.void
              : failed(`could not write '${key}' into the config of ${repo}`, result),
          ),
        ),
      // The whole argv is the verb and the remote: what a repo's `origin`
      // brings back is the remote's own default refspec, and anything this
      // added would be a write nobody asked for (T70). git's line is what the
      // failure carries — no network, no `origin`, a refused credential all
      // read the same from here, and the dispatcher's next move is in git's
      // words rather than in ours.
      fetch: ({ repo, remote }) =>
        inRepo(repo, "fetch", remote).pipe(
          Effect.flatMap((result) =>
            result.exitCode === 0 ? Effect.void : failed(`could not fetch '${remote}'`, result),
          ),
        ),
      // The failure names `onto` rather than `branch` because `onto` is what
      // could not move, which reads correctly for both destinations.
      fetchBack: ({ from, into, branch, onto }) =>
        inRepo(into, "fetch", from, `refs/heads/${branch}:refs/heads/${onto}`).pipe(
          Effect.flatMap((result) =>
            result.exitCode === 0
              ? Effect.void
              : failed(`could not fast-forward '${onto}' from ${from}`, result),
          ),
        ),
      // `--set-upstream` for bash's reason (`run.sh:693-696`): the branch a
      // dispatcher hands us was often created from `origin/master`, and a
      // human's later bare `git push` would follow that tracking straight onto
      // the base ref. One push wires it to the branch it is actually on.
      //
      // The lease names the ref and the SHA explicitly (T101): the bare
      // `--force-with-lease` expects whatever `origin/<b>` says at push time,
      // which is a value this run did not read. An empty expectation is git's
      // own spelling for "the ref must not exist".
      push: ({ from, branch, lease }) =>
        inRepo(
          from,
          "push",
          "--set-upstream",
          ...(lease === undefined
            ? []
            : [
                `--force-with-lease=refs/heads/${branch}:${Option.getOrElse(lease.expect, () => "")}`,
              ]),
          ORIGIN,
          `refs/heads/${branch}:refs/heads/${branch}`,
        ).pipe(
          Effect.flatMap((result) =>
            result.exitCode === 0
              ? Effect.void
              : failed(`could not push '${branch}' to ${ORIGIN}`, result),
          ),
        ),
      countCommits: ({ repo, from, to }) =>
        inRepo(repo, "rev-list", "--count", `${from}..${to}`).pipe(
          Effect.flatMap((result) => {
            const count = Number.parseInt(result.stdout.trim(), 10);
            // A count is a number or it is nothing: git answering zero and git
            // answering nothing at all differ by exactly the branch a caller
            // takes on "nothing to land", so an unparseable line fails here
            // rather than arriving as a `NaN` nobody checks.
            return result.exitCode === 0 && Number.isInteger(count)
              ? Effect.succeed(count)
              : failed(`could not count the commits in ${from}..${to}`, result);
          }),
        ),
      countReachable: ({ repo, excluding, tips }) =>
        inRepo(repo, "rev-list", "--count", `^${excluding}`, ...tips).pipe(
          Effect.flatMap((result) => {
            const count = Number.parseInt(result.stdout.trim(), 10);
            // `countCommits`'s reason: zero and nothing differ by exactly the
            // question a caller branches on.
            return result.exitCode === 0 && Number.isInteger(count)
              ? Effect.succeed(count)
              : failed(
                  `could not count the commits on ${tips.join(" or ")} and not on ${excluding}`,
                  result,
                );
          }),
        ),
      // The trailing slash is what makes this the directory's *entries*: a
      // pathspec naming a directory without one matches the tree itself and
      // answers one line describing it. `--literal-pathspecs` turns off the
      // magic the rest of a pathspec can carry — the folder is a value a
      // dispatcher typed (T73), and a `*` in it must name a directory rather
      // than select several.
      //
      // Exit 0 and no output is the path not being there, which is the answer
      // the `Option` carries; a ref that does not resolve exits 128 and is a
      // `GitError`. That is the whole reason the ref and the path are two
      // words here: `<ref>:<path>` answers both of those the same way.
      listTree: ({ repo, ref, path }) =>
        inRepo(repo, "--literal-pathspecs", "ls-tree", "-z", ref, "--", `${path}/`).pipe(
          Effect.flatMap((result) =>
            result.exitCode === 0
              ? Effect.succeed(parseTree(result.stdout))
              : failed(`could not list '${path}' at ${ref}`, result),
          ),
        ),
      // One child, whatever the id count — `catFileBatch` above — and every id
      // answered or the read fails.
      readBlobs: ({ repo, ids }) =>
        catFileBatch(repo, ids).pipe(
          Effect.flatMap((result) => {
            if (result.exitCode !== 0) {
              return failed(`could not read ${ids.length} blob(s) from this repo`, result);
            }
            // Zipped by position and keyed by the id **as asked**: git echoes
            // the object's own id on a header line and the name as given on a
            // `missing` one, so position is the only thing that pairs an
            // answer with a question.
            const answers = parseCatFileBatch(result.stdout);
            const blobs = new Map<string, string>();
            for (const [index, id] of ids.entries()) {
              const text = answers[index]?.text;
              if (text === undefined || Option.isNone(text)) {
                return failed(`'${id}' is not a blob in this repo`, result);
              }
              blobs.set(id, text.value);
            }
            return Effect.succeed(blobs);
          }),
        ),
      // One child for every ref there is: `for-each-ref` with no pattern, in
      // the order git lists them. The format is the two fields the scan needs
      // and nothing else — `parseRefs` frames them at the first space, which a
      // refname cannot contain.
      forEachRef: ({ repo }) =>
        inRepo(repo, "for-each-ref", "--format=%(objectname) %(refname)").pipe(
          Effect.flatMap((result) =>
            result.exitCode === 0
              ? Effect.succeed(parseRefs(result.stdout))
              : failed("could not list the refs of this repo", result),
          ),
        ),
      // The picker's branch list (T81): one `for-each-ref`, narrowed to
      // `refs/heads/` by the pattern git takes last, with a format carrying
      // the two fields a row is built out of. `committerdate:unix` rather
      // than an ISO spelling because seconds are one `Number` away from the
      // instant this answers with, where a rendered date is a format the
      // writer and the reader would both have to agree about.
      branches: ({ repo }) =>
        inRepo(
          repo,
          "for-each-ref",
          "--format=%(committerdate:unix) %(refname)",
          BRANCH_PREFIX,
        ).pipe(
          Effect.flatMap((result) =>
            result.exitCode === 0
              ? Effect.succeed(parseBranches(result.stdout))
              : failed("could not list the branches of this repo", result),
          ),
        ),
      // The tolerant batch (T72): the same child as `readBlobs`, and the same
      // zip by position — git echoes an object's own id on a header line and
      // the **name as given** on a `missing` one, so position is the only
      // thing that pairs an answer with a question. What differs is what a
      // `missing` means here: the map simply has no entry under that name, and
      // the scan reads that as a ref whose tree does not carry the file.
      //
      // Only git failing to run the batch at all is a `GitError`, which is a
      // repository this package cannot read rather than an object it does not
      // hold.
      readObjects: ({ repo, names }) =>
        catFileBatch(repo, names).pipe(
          Effect.flatMap((result) => {
            if (result.exitCode !== 0) {
              return failed(`could not read ${names.length} object(s) from this repo`, result);
            }
            const answers = parseCatFileBatch(result.stdout);
            const objects = new Map<string, string>();
            for (const [index, name] of names.entries()) {
              const text = answers[index]?.text;
              if (text !== undefined && Option.isSome(text)) {
                objects.set(name, text.value);
              }
            }
            return Effect.succeed<ReadonlyMap<string, string>>(objects);
          }),
        ),
      // The status commit's five steps (T77). Each names the repo like every
      // operation above it, and the three that hold the index name it the one
      // way a child can be given a value (`indexedInRepo`).
      //
      // A single-tree `read-tree` *replaces* the index it is pointed at, so a
      // scratch file left behind by an earlier run carries nothing into this
      // one.
      readTree: ({ repo, ref, index }) =>
        indexedInRepo(index, repo, "read-tree", ref).pipe(
          Effect.flatMap((result) =>
            result.exitCode === 0
              ? Effect.void
              : failed(`could not read the tree of ${ref} into ${index}`, result),
          ),
        ),
      // `--stdin` rather than a path: the text is a value this package built
      // (T68's restamp) and was never on disk, and a file written out to be
      // hashed would be a second place the new content exists. No `--path`
      // either — that is what would run the repository's `.gitattributes`
      // filters over it, and this writes back exactly the bytes the read
      // answered with.
      hashObject: ({ repo, text }) =>
        fedInRepo(text, repo, "hash-object", "-w", "--stdin").pipe(
          Effect.flatMap((result) => {
            const id = new TextDecoder().decode(result.stdout).trim();
            return result.exitCode === 0 && id !== ""
              ? Effect.succeed(id)
              : failed("could not write a blob into this repo", result);
          }),
        ),
      // `--add` because the entry may be one the tree does not carry yet, and
      // `--cacheinfo` because there is no file on disk to stat: the blob is
      // already in the object database and the path is the repo-relative one
      // the caller built.
      updateIndex: ({ repo, index, path, blob }) =>
        indexedInRepo(
          index,
          repo,
          "update-index",
          "--add",
          "--cacheinfo",
          `${BLOB_MODE},${blob},${path}`,
        ).pipe(
          Effect.flatMap((result) =>
            result.exitCode === 0
              ? Effect.void
              : failed(`could not stage ${path} in ${index}`, result),
          ),
        ),
      writeTree: ({ repo, index }) =>
        indexedInRepo(index, repo, "write-tree").pipe(
          Effect.flatMap((result) =>
            result.exitCode === 0 && result.stdout.trim() !== ""
              ? Effect.succeed(result.stdout.trim())
              : failed(`could not write a tree out of ${index}`, result),
          ),
        ),
      // Two `-m`s, as bash writes them (`run.sh:1372-1374`): git puts the
      // blank line between them, so the subject a log renders is the subject
      // and the body stays a paragraph. **No hooks and no working tree** —
      // that is the whole reason this operation exists rather than a `commit`
      // in a checkout somewhere.
      commitTree: ({ repo, tree, parent, subject, body }) =>
        inRepo(repo, "commit-tree", tree, "-p", parent, "-m", subject, "-m", body).pipe(
          Effect.flatMap((result) =>
            result.exitCode === 0 && result.stdout.trim() !== ""
              ? Effect.succeed(result.stdout.trim())
              : failed(`could not commit ${tree} onto ${parent}`, result),
          ),
        ),
      // The three-argument form: git moves the ref only if it still holds
      // `from`, checked under the ref's own lock, so the check and the move are
      // one step and not two a commit could land between.
      updateRef: ({ repo, ref, to, from }) =>
        inRepo(repo, "update-ref", ref, to, from).pipe(
          Effect.flatMap((result) =>
            result.exitCode === 0
              ? Effect.void
              : failed(`could not move ${ref} from ${from} to ${to}`, result),
          ),
        ),
    };
  }),
);
