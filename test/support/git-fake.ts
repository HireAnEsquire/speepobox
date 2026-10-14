// A fake `Git` for the callers that hand the tag *domain values* rather than
// argv. The scripted executor stays the seam for `GitLive` itself; this one
// exists because what the checkout's tests assert is which branded values
// crossed the seam and in which direction, which a rendered command line can
// only spell out again.
//
// The clone really creates its destination, marker file and all: the derived
// release is read off the world afterwards, so "the checkout is kept" and
// "the checkout is gone" are only assertions if something made a directory to
// keep — and a release that forgot to remove recursively fails on the marker.
import { FileSystem } from "@effect/platform";
import { Effect, Layer, Option, Ref } from "effect";
import type { DispatcherFreshness } from "../../src/git/dispatcher-freshness.ts";
import {
  Git,
  GitError,
  type LocalBranch,
  type PushLease,
  type RefTip,
  type TreeEntry,
  type Worktree,
} from "../../src/git/git.ts";
import type { RepoUrl } from "../../src/git/repo-url.ts";

// The file a fake clone leaves behind, so a kept checkout has contents.
export const CLONE_MARKER = "CLONED";

// The tip the branch was at when the run started — what the land reads back
// before its fetch moves the ref, and the start of the second of its two
// ranges.
export const PRE_TIP = "3333333333333333333333333333333333333333";

// The peel the base step asks `revParse` with (T82), the same one the base
// guard resolves through.
const COMMIT_PEEL = "^{commit}";

// The tip the *clone's* copy of the branch is at, which the release's rescue
// names its branch after (T29). Deliberately a different value from `PRE_TIP`:
// the same ref is read in two repos and answers differently in each, and a
// rescue named after the repo's tip rather than the copy's is the mistake
// worth failing on rather than passing by coincidence. Forty hex characters
// like the other one, because a fake that is not the shape of the thing is a
// fake a length check would catch and a reader would not.
export const CLONE_TIP = "a1b2c3d444444444444444444444444444444444";

export type GitCall =
  | {
      readonly _tag: "RevParse";
      readonly repo: string;
      readonly rev: string;
    }
  | {
      readonly _tag: "Clone";
      readonly source: RepoUrl;
      readonly branch: string;
      readonly into: string;
    }
  | {
      // The dispatch's own fetch (T70), recorded like the reads: *which* repo
      // was fetched into and from which remote is the whole assertion, and
      // "exactly one, before the base resolve" is only an assertion if it is
      // in this list beside them.
      readonly _tag: "Fetch";
      readonly repo: string;
      readonly remote: string;
    }
  | {
      readonly _tag: "FetchBack";
      readonly from: RepoUrl;
      readonly into: string;
      readonly branch: string;
      // Where the commits were sent, which is the whole of what the release's
      // two fetches differ by (T29) — recorded, because "the rescue landed
      // them on a branch of its own" is an assertion about this value.
      readonly onto: string;
    }
  | {
      // The salvage's containment question (T32), recorded like the reads
      // above it: *which* repo was asked, and about which commit, is the whole
      // of what makes the answer meaningful — the branch's own repo, about the
      // tip read in the copy.
      readonly _tag: "BranchContains";
      readonly repo: string;
      readonly branch: string;
      readonly commit: string;
    }
  | {
      // The editor lookup (T84), recorded like the reads beside it: *which*
      // repo git was asked in is the assertion — the served repo, whose config
      // is one link of the chain git walks.
      readonly _tag: "Editor";
      readonly repo: string;
    }
  | {
      // The base `init` works out (T115), in the repo it is read from.
      readonly _tag: "OriginHead";
      readonly repo: string;
    }
  | {
      // The identity read, in the repo it is read from (T35) — the dispatching
      // repo, whose config resolves to the dev's own.
      readonly _tag: "ReadConfig";
      readonly repo: string;
      readonly key: string;
    }
  | {
      // And the identity write, in the repo it is written into. Which repo
      // that is *is* the assertion: a write naming the host repo rather than
      // the clone is the mistake the whole ticket is about.
      readonly _tag: "SetConfig";
      readonly repo: string;
      readonly key: string;
      readonly value: string;
    }
  | {
      readonly _tag: "CountCommits";
      readonly repo: string;
      readonly from: string;
      readonly to: string;
    }
  | {
      // The hard reset's discard count (T101): one exclusion and every tip
      // it unions over, as they crossed the seam.
      readonly _tag: "CountReachable";
      readonly repo: string;
      readonly excluding: string;
      readonly tips: ReadonlyArray<string>;
    }
  | {
      readonly _tag: "Push";
      readonly from: string;
      readonly branch: string;
      // Present only on a hard reset's push (T101), so every case written
      // before it records exactly what it did.
      readonly lease?: PushLease;
    }
  | {
      // The two reads an issue set is read out of a ref with (T71). Both are
      // recorded, and the ids on the second one are the whole of "one batch,
      // never one call per file" — a store that read the blobs one at a time
      // would show up here as one entry per file rather than one entry.
      readonly _tag: "ListTree";
      readonly repo: string;
      readonly ref: string;
      readonly path: string;
    }
  | {
      readonly _tag: "ReadBlobs";
      readonly repo: string;
      readonly ids: ReadonlyArray<string>;
    }
  | {
      // The two reads the scan over every ref is (T72), recorded on the same
      // terms as the pair above: **one** entry of each, whatever the ref
      // count, is the whole of what "two git processes" is asserted as from
      // out here. The names on the second say which `<sha>:<path>` the scan
      // asked for, so a scan that skipped the tip's own ref shows up as names
      // it did not ask.
      readonly _tag: "ForEachRef";
      readonly repo: string;
    }
  | {
      // The picker's branch list (T81), recorded like the reads beside it:
      // which repo was asked is the assertion, and **one** entry whatever the
      // branch count is the other — a picker that asked git per row would
      // show up here as one entry per branch.
      readonly _tag: "Branches";
      readonly repo: string;
    }
  | {
      readonly _tag: "ReadObjects";
      readonly repo: string;
      readonly names: ReadonlyArray<string>;
    }
  // The status commit's five steps (T77), each recorded: what crosses this
  // seam is the whole of the write — which ref the tree came from, the text
  // each blob was written with, which path it was staged over, and the
  // message the commit carries — so a land that built the commit differently
  // shows up here as values rather than as a tree nobody looked inside.
  //
  // The scratch index is on all three of the operations that hold one, because
  // "the repository's own index is never touched" is an assertion about *which
  // file* they named.
  | {
      readonly _tag: "ReadTree";
      readonly repo: string;
      readonly ref: string;
      readonly index: string;
    }
  | {
      readonly _tag: "HashObject";
      readonly repo: string;
      readonly text: string;
    }
  | {
      readonly _tag: "UpdateIndex";
      readonly repo: string;
      readonly index: string;
      readonly path: string;
      readonly blob: string;
    }
  | {
      readonly _tag: "WriteTree";
      readonly repo: string;
      readonly index: string;
    }
  | {
      readonly _tag: "CommitTree";
      readonly repo: string;
      readonly tree: string;
      readonly parent: string;
      readonly subject: string;
      readonly body: string;
    }
  | {
      readonly _tag: "UpdateRef";
      readonly repo: string;
      readonly ref: string;
      readonly to: string;
      readonly from: string;
    };

// What a ref holds under one directory, as a case writes it: the files by
// name, with their text. Keyed by `<ref>:<path>` — the same directory reads
// differently at two refs, which is the property the tag exists for, so the
// ref is part of the key rather than a second level of nesting.
export type FakeTrees = Readonly<Record<string, Readonly<Record<string, string>>>>;

// The blob id this fake mints for one file. It is the key it looks a blob's
// text back up under, and a value a test can spell: content-addressing buys
// nothing here, and a readable id makes a `readBlobs` call in the recorded
// list say which files were asked for.
export const fakeBlobId = (key: string, name: string): string => `blob:${key}/${name}`;

// And the object name the scan reads the same file by (T72), which is git's
// own spelling rather than this fake's: `<sha>:<path>/<file>`, so the key a
// case scripts its tree under is the head of every name asked about it.
export const objectNameFor = (key: string, name: string): string => `${key}/${name}`;

// The id this fake gives the nth blob it was asked to write (T77), counted
// from one. A counter rather than a hash for `fakeBlobId`'s reason — an id a
// case can spell — and one per call rather than per text, so two files that
// happen to say the same thing are still two writes.
export const fakeWrittenBlobId = (nth: number): string => `blob:written-${nth}`;

// What `write-tree` and `commit-tree` answer with. Forty hex characters, like
// the tips above them: a fake that is not the shape of the thing is a fake a
// length check would catch and a reader would not.
export const WRITTEN_TREE = "7777777777777777777777777777777777777777";
export const STATUS_COMMIT = "8888888888888888888888888888888888888888";

export interface FakeGitOptions {
  // The `GitError` detail each operation fails with, when it is scripted to
  // fail at all. A clone that cannot run and a fetch-back that is not a
  // fast-forward are the two directions the derived release turns on; a
  // rejected push is matrix row 14.
  readonly cloneFails?: string;
  // The dispatch's fetch refusing (T70) — no network, no `origin`, a refused
  // credential — which is a `GuardRefused` quoting this line, before anything
  // is held.
  readonly fetchFails?: string;
  readonly fetchBackFails?: string;
  // The middle row of the release's table (T29): the fetch onto the branch the
  // run was given refuses, and the one onto a branch of the release's own goes
  // through. Refusing by *destination* is what tells the two apart, since both
  // are the same operation; `fetchBackFails` refuses either of them.
  readonly homeFetchBackFails?: string;
  readonly pushFails?: string;
  // The hard reset's compare-and-set refusing (T101): the branch is no longer
  // where the guards read it.
  readonly resetFails?: string;
  // What the union count answers (T101). Unscripted is nothing to discard.
  readonly reachable?: number;
  // Whether the repo's branch already holds the copy's tip (T32). A refused
  // fast-forward means one of two things, and this is the one that wants no
  // rescue: the commits went home earlier and the branch has moved on since,
  // so the fetch would rewind it. `false` — the default — is the diverged
  // case every case written before this ticket is about.
  readonly branchAlreadyContains?: boolean;
  // git failing to answer the containment question at all, which is what an
  // object the repo has never seen looks like: `merge-base --is-ancestor`
  // exits 128 rather than 1, so it arrives as a `GitError` and not a `false`.
  readonly branchContainsFails?: string;
  // Whether a fetch-back that answers success **moved anything** (T38). A real
  // one does, so `true` is the default and the branch it landed on holds the
  // copy's tip afterwards — which is what the containment read asks. `false`
  // is this ticket's defect: a partial fetch, a refspec that landed somewhere
  // unexpected, or a `Git` layer that recorded rather than fetched, all of
  // which answer success and leave the branch exactly where it was.
  readonly fetchBackLands?: boolean;
  // What the branch resolves to *inside a clone*, which is what the rescue
  // branch is named after. Scriptable so two runs of the same branch can leave
  // two different tips, which is the whole of why the name is taken from the
  // commits rather than from the clock.
  readonly cloneTip?: string;
  // What the repo's config answers, keyed by config key (T35). An unscripted
  // key is one nobody set — the fallback's case, and the default here, because
  // a host with no `user.name` is a state this must keep working on.
  readonly config?: Readonly<Record<string, string>>;
  // git refusing to answer a config question at all, which is neither a value
  // nor an absence: a broken config file, not an unset key.
  readonly readConfigFails?: string;
  // What `refs/remotes/origin/HEAD` points at (T115). Unscripted is unset —
  // a clone that never ran `git remote set-head`, which `init` refuses on.
  readonly originHead?: string;
  // What `git var GIT_EDITOR` answers (T84) — the argv the bracket then
  // spawns, so a case scripts this to whatever its executor answers to.
  // Unscripted is `vi`, git's own last link and the answer on a host where
  // nobody named one.
  readonly editor?: string;
  // git failing to resolve an editor at all: a repository it cannot read, and
  // never an editor nobody named — that chain ends in a literal.
  readonly editorFails?: string;
  // A config write that will not land — an unwritable `.git/config` — which is
  // a `GitError` inside the checkout's acquire like a refused clone is.
  readonly setConfigFails?: string;
  // What `rev-list --count` answers, keyed by the range's **start**: the land
  // asks two questions — past the diff boundary and past the pre-run tip — and
  // one number for both could not tell them apart in what the run reports. An
  // unscripted range is a branch with nothing past that point.
  readonly counts?: Readonly<Record<string, number>>;
  // What `worktrees` answers, unscripted defaulting to none — the one caller
  // that needs it (T45's stale-dispatcher message) reads its own worktree's
  // branch out of the list, so a case that wants "no branch here" (a detached
  // HEAD) writes an entry with `branch: Option.none()` rather than omitting
  // the field.
  readonly worktrees?: ReadonlyArray<Worktree>;
  // What each ref's tree holds, keyed by `<ref>:<path>` (T71). An unscripted
  // key is a directory the ref does not carry, which is an answer — `None`,
  // the case `IssueStore` refuses on — and not a failure.
  readonly trees?: FakeTrees;
  // git failing to read a tree at all, which is neither entries nor absence:
  // a ref that does not resolve.
  readonly listTreeFails?: string;
  // What `for-each-ref` answers (T72): every ref the repo holds and what it
  // points at, in the order git would list them. Unscripted is a repo with no
  // refs at all — which is an answer, and the one a scan over nothing gets.
  // The shas are the same ones the `trees` keys open with, so a case scripts a
  // ref's contents and its existence in the two halves of one fixture.
  readonly refs?: ReadonlyArray<RefTip>;
  // git failing to list the refs at all — a repository it cannot read, which
  // travels as a `GitError` like any other failed read.
  readonly forEachRefFails?: string;
  // What `branches` answers (T81): every local branch and when its tip was
  // committed, in whatever order a case writes them — `GitLive` promises
  // none, and the picker's at-rest recency order is only an assertion if the
  // fake is free to hand them over out of order. Unscripted is a repo with no
  // branches, which is an answer and not a failure.
  readonly branches?: ReadonlyArray<LocalBranch>;
  // git failing to list the branches at all, which travels as a `GitError`
  // like the ref listing beside it.
  readonly branchesFails?: string;
  // The commit expressions `revParse` resolves (T82) — a SHA no ref carries,
  // `HEAD~1`, a tag — each as typed, without the `^{commit}` the caller
  // peels with. Unscripted, the fake answers only branch tips, as before.
  readonly resolvable?: ReadonlyArray<string>;
  // What `dispatcherFreshness` answers, unscripted defaulting to `Current` —
  // the ordinary case every fake-backed test written before T45 assumes,
  // exactly as `branchAlreadyContains`'s default is the ordinary case for its
  // own question.
  readonly dispatcherFreshness?: DispatcherFreshness;
}

export const fakeGit = (
  calls: Ref.Ref<ReadonlyArray<GitCall>>,
  options: FakeGitOptions = {},
): Layer.Layer<Git, never, FileSystem.FileSystem> =>
  Layer.effect(
    Git,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const record = (call: GitCall): Effect.Effect<void> =>
        Ref.update(calls, (current) => [...current, call]);
      // Which paths are clones, which this fake knows because it made them.
      // The land and the release ask the same ref question of two different
      // repos, so the *repo* is what tells their answers apart — see below.
      const clonedInto = yield* Ref.make<ReadonlyArray<string>>([]);
      // How many blobs the write half has asked this fake to write (T77), so
      // each one answers with an id of its own.
      const written = yield* Ref.make(0);
      // What a fetch-back put where, so the containment question afterwards
      // has a world to answer from rather than a scripted boolean (T38): a
      // fetch that moved the commits is exactly a branch that holds them.
      const landed = yield* Ref.make<ReadonlyArray<{ branch: string; commit: string }>>([]);
      // The branch tip a repo answers with, which is a property of *which*
      // repo — see `revParse` below. Shared with the fetch-back, because "the
      // commits this fetch is carrying" is the same value read the same way.
      const tipIn = (repo: string): Effect.Effect<string> =>
        Ref.get(clonedInto).pipe(
          Effect.map((clones) =>
            clones.includes(repo) ? (options.cloneTip ?? CLONE_TIP) : PRE_TIP,
          ),
        );

      return {
        // A branch tip is the one ref question this fake answers; reaching any
        // other one is a wiring mistake in the test, not a case with an
        // answer. It is recorded like the four below it, because "every call
        // named the same repo" is only an assertion if the reads that run
        // before the fetch-backs are in the list too (T27).
        //
        // **The answer depends on which repo was asked, not on how.** The land
        // reads this branch in the host repo and the release's rescue reads it
        // in the clone, and those are two different commits — which is the
        // whole of why the rescue branch is named after the copy's tip and not
        // the repo's. A fake that answered one tip to both would pass a
        // release that read the wrong repo.
        //
        // With `resolvable` scripted, a commit expression is the other ref
        // question it answers (T82): `<expr>^{commit}` resolves iff the case
        // listed `<expr>`, and fails as git's own `--verify` would otherwise.
        revParse: ({ repo, rev }) =>
          rev.startsWith("refs/heads/")
            ? record({ _tag: "RevParse", repo, rev }).pipe(Effect.zipRight(tipIn(repo)))
            : options.resolvable !== undefined && rev.endsWith(COMMIT_PEEL)
              ? record({ _tag: "RevParse", repo, rev }).pipe(
                  Effect.zipRight(
                    options.resolvable.includes(rev.slice(0, -COMMIT_PEEL.length))
                      ? Effect.succeed(PRE_TIP)
                      : new GitError({ detail: `'${rev}' does not resolve` }),
                  ),
                )
              : Effect.die(`this fake Git answers no ref question but a branch tip (${rev})`),
        // Answered off what the fetches actually did, not off a flag: a branch
        // holds a commit because it already did before this run, or because a
        // fetch-back landed it there (T38). A fetch that reported success and
        // moved nothing therefore answers `false` here, which is the whole of
        // what tells the two apart from out here.
        //
        // **A fetch that just landed answers ahead of `branchContainsFails`.**
        // That option models the one real unanswerable case — an object this
        // repo has never seen, so `merge-base --is-ancestor` exits 128 rather
        // than 1 — and a fetch landing the commit here is exactly the event
        // that stops it being true. Failing anyway would let a case script a
        // repo that cannot answer about a ref it just wrote, which no real one
        // does, and would make the rescue's own containment read (T38)
        // unassertable in the one test that needs the pre-rescue read to fail.
        branchContains: ({ repo, branch, commit }) =>
          record({ _tag: "BranchContains", repo, branch, commit }).pipe(
            Effect.zipRight(Ref.get(landed)),
            Effect.flatMap((moved) =>
              moved.some((move) => move.branch === branch && move.commit === commit)
                ? Effect.succeed(true)
                : options.branchContainsFails === undefined
                  ? Effect.succeed(options.branchAlreadyContains ?? false)
                  : new GitError({ detail: options.branchContainsFails }),
            ),
          ),
        worktrees: () => Effect.succeed(options.worktrees ?? []),
        mergeBase: () => Effect.die("this fake Git answers no merge-base questions"),
        originUrl: () => Effect.die("this fake Git answers no origin-url questions"),
        originHead: ({ repo }) =>
          record({ _tag: "OriginHead", repo }).pipe(
            Effect.as(Option.fromNullable(options.originHead)),
          ),
        dispatcherFreshness: () =>
          Effect.succeed(options.dispatcherFreshness ?? { _tag: "Current" }),
        clone: ({ source, branch, into }) =>
          record({ _tag: "Clone", source, branch, into }).pipe(
            Effect.flatMap(() =>
              options.cloneFails === undefined
                ? fs.makeDirectory(`${into}/.git`, { recursive: true }).pipe(
                    Effect.zipRight(fs.writeFileString(`${into}/${CLONE_MARKER}`, `${branch}\n`)),
                    // A real clone lands on the branch it asked for, and
                    // `.git/HEAD` is where the reconciler reads that back
                    // (`wreckage.ts`) — the fake owes it, or the end-to-end
                    // case reports the branchless notice for a copy that is
                    // on a branch.
                    Effect.zipRight(
                      fs.writeFileString(`${into}/.git/HEAD`, `ref: refs/heads/${branch}\n`),
                    ),
                    Effect.orDie,
                    // And it is a clone from here on, which is what a later ref
                    // read of this path is answered by.
                    Effect.zipRight(Ref.update(clonedInto, (current) => [...current, into])),
                  )
                : new GitError({ detail: options.cloneFails }),
            ),
          ),
        fetch: ({ repo, remote }) =>
          record({ _tag: "Fetch", repo, remote }).pipe(
            Effect.flatMap(() =>
              options.fetchFails === undefined
                ? Effect.void
                : new GitError({ detail: options.fetchFails }),
            ),
          ),
        fetchBack: ({ from, into, branch, onto }) =>
          record({ _tag: "FetchBack", from, into, branch, onto }).pipe(
            Effect.flatMap(() => {
              const refused =
                options.fetchBackFails ??
                (onto === branch ? options.homeFetchBackFails : undefined);
              if (refused !== undefined) {
                return new GitError({ detail: refused });
              }
              // It went through, so the destination holds what the copy was
              // on — unless this case is scripting the fetch that says so and
              // does not (T38).
              return (options.fetchBackLands ?? true)
                ? tipIn(from).pipe(
                    Effect.flatMap((commit) =>
                      Ref.update(landed, (moves) => [...moves, { branch: onto, commit }]),
                    ),
                  )
                : Effect.void;
            }),
          ),
        // Which editor a dispatcher's own git would open (T84), recorded like
        // the config read below it: which repo was asked is the assertion.
        editor: ({ repo }) =>
          record({ _tag: "Editor", repo }).pipe(
            Effect.flatMap(() =>
              options.editorFails === undefined
                ? Effect.succeed(options.editor ?? "vi")
                : new GitError({ detail: options.editorFails }),
            ),
          ),
        // Absence is an answer and not a failure (T35): an unscripted key is a
        // host that never set one, which is the fallback's whole case.
        readConfig: ({ repo, key }) =>
          record({ _tag: "ReadConfig", repo, key }).pipe(
            Effect.flatMap(() =>
              options.readConfigFails === undefined
                ? Effect.succeed(Option.fromNullable(options.config?.[key]))
                : new GitError({ detail: options.readConfigFails }),
            ),
          ),
        setConfig: ({ repo, key, value }) =>
          record({ _tag: "SetConfig", repo, key, value }).pipe(
            Effect.flatMap(() =>
              options.setConfigFails === undefined
                ? Effect.void
                : new GitError({ detail: options.setConfigFails }),
            ),
          ),
        countCommits: ({ repo, from, to }) =>
          record({ _tag: "CountCommits", repo, from, to }).pipe(
            Effect.as(options.counts?.[from] ?? 0),
          ),
        // The tree read, answered off `trees` (T71): the names the scripted
        // directory holds, each with the id this fake mints for it. An
        // unscripted `<ref>:<path>` is a directory that ref does not carry.
        listTree: ({ repo, ref, path }) =>
          record({ _tag: "ListTree", repo, ref, path }).pipe(
            Effect.flatMap(() => {
              if (options.listTreeFails !== undefined) {
                return new GitError({ detail: options.listTreeFails });
              }
              const key = `${ref}:${path}`;
              const files = options.trees?.[key];
              return Effect.succeed(
                files === undefined
                  ? Option.none<ReadonlyArray<TreeEntry>>()
                  : Option.some(
                      Object.keys(files).map((name) => ({ name, id: fakeBlobId(key, name) })),
                    ),
              );
            }),
          ),
        // And the batch, answered off the same option: every id this fake
        // minted above resolves to the text it was scripted with, and an id
        // from nowhere is a `GitError` exactly as it is against a real repo.
        readBlobs: ({ repo, ids }) =>
          record({ _tag: "ReadBlobs", repo, ids }).pipe(
            Effect.flatMap(() => {
              const blobs = new Map<string, string>();
              for (const [key, files] of Object.entries(options.trees ?? {})) {
                for (const [name, text] of Object.entries(files)) {
                  blobs.set(fakeBlobId(key, name), text);
                }
              }
              const missing = ids.find((id) => !blobs.has(id));
              return missing === undefined
                ? Effect.succeed<ReadonlyMap<string, string>>(
                    new Map(ids.map((id) => [id, blobs.get(id) ?? ""])),
                  )
                : new GitError({ detail: `'${missing}' is not a blob in this repo` });
            }),
          ),
        // Every local branch the case scripted, recorded like the ref listing
        // below it and answered in the order it was written: the picker owns
        // the recency order, so a fake that sorted would be the thing under
        // test answering for itself.
        branches: ({ repo }) =>
          record({ _tag: "Branches", repo }).pipe(
            Effect.flatMap(() =>
              options.branchesFails === undefined
                ? Effect.succeed(options.branches ?? [])
                : new GitError({ detail: options.branchesFails }),
            ),
          ),
        // Every ref the case scripted, recorded like the tree read above it.
        forEachRef: ({ repo }) =>
          record({ _tag: "ForEachRef", repo }).pipe(
            Effect.flatMap(() =>
              options.forEachRefFails === undefined
                ? Effect.succeed(options.refs ?? [])
                : new GitError({ detail: options.forEachRefFails }),
            ),
          ),
        // And the tolerant batch, off the same `trees` option: a name is
        // `<sha>:<path>/<file>`, so everything up to the last `/` is the key a
        // case scripted the directory under. **A name nothing scripted is
        // absent from the answer**, never a failure — that is the difference
        // from `readBlobs` above, and the case it exists for is a ref whose
        // tree does not carry the folder at all.
        readObjects: ({ repo, names }) =>
          record({ _tag: "ReadObjects", repo, names }).pipe(
            Effect.map(() => {
              const objects = new Map<string, string>();
              for (const name of names) {
                const cut = name.lastIndexOf("/");
                const text = options.trees?.[name.slice(0, cut)]?.[name.slice(cut + 1)];
                if (text !== undefined) {
                  objects.set(name, text);
                }
              }
              return objects as ReadonlyMap<string, string>;
            }),
          ),
        // The status commit's five steps (T77), recorded and otherwise inert:
        // nothing here writes an object or moves a ref, because what a case
        // asserts about this write is the sequence and the values in it —
        // `test/issue-store.test.ts` runs the same sequence against a real
        // repository, which is where "the branch really moved" is the claim.
        readTree: ({ repo, ref, index }) => record({ _tag: "ReadTree", repo, ref, index }),
        hashObject: ({ repo, text }) =>
          record({ _tag: "HashObject", repo, text }).pipe(
            Effect.zipRight(Ref.updateAndGet(written, (count) => count + 1)),
            Effect.map(fakeWrittenBlobId),
          ),
        updateIndex: ({ repo, index, path, blob }) =>
          record({ _tag: "UpdateIndex", repo, index, path, blob }),
        writeTree: ({ repo, index }) =>
          record({ _tag: "WriteTree", repo, index }).pipe(Effect.as(WRITTEN_TREE)),
        commitTree: ({ repo, tree, parent, subject, body }) =>
          record({ _tag: "CommitTree", repo, tree, parent, subject, body }).pipe(
            Effect.as(STATUS_COMMIT),
          ),
        updateRef: ({ repo, ref, to, from }) =>
          record({ _tag: "UpdateRef", repo, ref, to, from }).pipe(
            Effect.zipRight(
              options.resetFails !== undefined
                ? new GitError({ detail: options.resetFails })
                : Effect.void,
            ),
          ),
        countReachable: ({ repo, excluding, tips }) =>
          record({ _tag: "CountReachable", repo, excluding, tips }).pipe(
            Effect.as(options.reachable ?? 0),
          ),
        push: ({ from, branch, lease }) =>
          record({ _tag: "Push", from, branch, ...(lease === undefined ? {} : { lease }) }).pipe(
            Effect.flatMap(() =>
              options.pushFails === undefined
                ? Effect.void
                : new GitError({ detail: options.pushFails }),
            ),
          ),
      };
    }),
  );
