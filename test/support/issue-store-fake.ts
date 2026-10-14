// A fake `IssueStore` for the callers that are handed an issue set rather than
// a repository: the dispatch's content guards (T73) ask this tag one question
// and branch on the answer, so what a case needs to script is *what the ref
// says*, which a scripted `git` would only spell out in blobs and object ids
// first.
//
// **The sets are keyed by ref**, because that is the property the tag exists
// for: the same folder answers differently at two refs, and "the set was read
// at the branch tip and not at `BASE_SHA`" is an assertion about which ref
// crossed this seam (T73). An unscripted ref carries no folder at all, which
// is `FolderAbsent` — the refusal, and the honest default for a ref nobody
// said anything about.
import { Effect, Layer, Option, Ref } from "effect";
import { GitError } from "../../src/git/git.ts";
import {
  FolderAbsent,
  IssueStore,
  type IssueStoreError,
  issuesPathFor,
  type LandedElsewhere,
  Unparseable,
} from "../../src/issues/issue-store.ts";
import type { Issue } from "../../src/issues/issue.ts";

export type IssueStoreCall =
  | {
      readonly _tag: "Issues";
      readonly repo: string;
      readonly ref: string;
      readonly folder: string;
    }
  | {
      // The scan (T72), recorded because *whether it ran at all* is the
      // assertion T74 makes: both witnesses fire under `--issues all` and
      // neither under an enumerated one, and a check whose answer is discarded
      // is a check a reader will one day believe was made. The ids are the
      // issues it was asked about and `tip` the ref it stood on.
      readonly _tag: "LandedElsewhere";
      readonly repo: string;
      readonly folder: string;
      readonly ids: ReadonlyArray<string>;
      readonly tip: string;
      // The refs a `--hard-reset` leaves out (T103), recorded only when the
      // caller named some — a dispatch without the flag asks what it always did.
      readonly alsoExcluding?: ReadonlyArray<string>;
    }
  | {
      // The write (T77), recorded on the same terms: *whether it ran at all*
      // is half of what the land's placement is asserted as — once, for the
      // issues this run approved, and never on a run that committed nothing —
      // and the stems are the other half, because the commit is named after
      // them.
      readonly _tag: "MarkLanded";
      readonly repo: string;
      readonly branch: string;
      readonly folder: string;
      readonly stems: ReadonlyArray<string>;
      readonly index: string;
    };

// The commit a scripted write answers with. Forty hex characters for
// `git-fake.ts`'s reason: a fake that is not the shape of the thing is a fake
// a length check would catch and a reader would not.
export const MARKED_COMMIT = "9999999999999999999999999999999999999999";

// One issue, as a case spells it: everything a selection reads, with the
// ordinary answers as defaults — an `AFK` issue that is ready and blocked by
// nothing, which is the one a dispatch runs.
export const fakeIssue = (id: string, fields: Partial<Issue> = {}): Issue => ({
  id,
  stem: `${id}-a-thing-to-do`,
  title: `${id} — a thing to do`,
  type: "AFK",
  status: "ready-for-agent",
  blockers: [],
  ...fields,
});

export interface FakeIssueStoreOptions {
  // What each ref answers with, keyed by the ref as it was asked. An
  // unscripted ref is one carrying no `<folder>/issues/`.
  readonly sets?: Readonly<Record<string, ReadonlyArray<Issue>>>;
  // A file on that ref this package cannot read as an issue — the other typed
  // arm, which refuses naming the file rather than the folder.
  readonly unparseable?: { readonly file: string; readonly detail: string };
  // Git unable to answer at all: the third arm, which travels as itself rather
  // than flattened into either of the two above, because git's own line is the
  // whole of what a caller can say about an unreadable repository.
  readonly gitError?: string;
  // What the scan answers, keyed by issue id: the refs whose copy of that id's
  // file says `Done` (T72). An unscripted id is one nobody else has landed,
  // which is the ordinary case and the default — a dispatcher's own issue is
  // usually theirs alone.
  readonly landed?: Readonly<Record<string, ReadonlyArray<string>>>;
  // git failing the scan outright, which is neither a hit nor a clean sheet:
  // a repository this package could not read the refs of.
  readonly landedElsewhereFails?: string;
  // The status commit refusing to build (T77) — the case the whole step is
  // advisory for: the land warns, names the stems, and pushes anyway. It is a
  // `GitError` because that is what every one of the write's six children
  // fails as, and because the warning quotes git's own line.
  readonly markLandedFails?: string;
  // A write that found nothing to do: the branch carries no file for any of
  // the stems, so no commit was built. Scripted apart from the failure,
  // because "nothing to write" is an answer and not an error.
  readonly marksNothing?: boolean;
}

export const fakeIssueStore = (
  calls?: Ref.Ref<ReadonlyArray<IssueStoreCall>>,
  options: FakeIssueStoreOptions = {},
): Layer.Layer<IssueStore> =>
  Layer.succeed(IssueStore, {
    issues: ({ repo, ref, folder }) => {
      const call: IssueStoreCall = { _tag: "Issues", repo, ref, folder };
      const answer = Effect.suspend((): Effect.Effect<ReadonlyArray<Issue>, IssueStoreError> => {
        if (options.gitError !== undefined) {
          return new GitError({ detail: options.gitError });
        }
        if (options.unparseable !== undefined) {
          return new Unparseable({ ...options.unparseable, ref });
        }
        const set = options.sets?.[ref];
        return set === undefined
          ? new FolderAbsent({ folder, path: issuesPathFor(folder), ref })
          : Effect.succeed(set);
      });
      return (
        calls === undefined ? Effect.void : Ref.update(calls, (current) => [...current, call])
      ).pipe(Effect.zipRight(answer));
    },
    landedElsewhere: ({ repo, folder, issues, tip, alsoExcluding }) => {
      const call: IssueStoreCall = {
        _tag: "LandedElsewhere",
        repo,
        folder,
        ids: issues.map((issue) => issue.id),
        tip,
        ...(alsoExcluding === undefined ? {} : { alsoExcluding }),
      };
      const answer = Effect.suspend((): Effect.Effect<ReadonlyArray<LandedElsewhere>, GitError> =>
        options.landedElsewhereFails === undefined
          ? Effect.succeed(
              // One entry per issue that has refs, in the order it was asked
              // about — the live scan's order, so a refusal built off this
              // fake reads as the one built off a repository.
              // The refs named for exclusion are dropped as the live scan
              // drops them, by name (T103).
              issues.flatMap((issue) => {
                const refs = (options.landed?.[issue.id] ?? []).filter(
                  (ref) => !(alsoExcluding ?? []).includes(ref),
                );
                return refs.length === 0 ? [] : [{ id: issue.id, refs }];
              }),
            )
          : new GitError({ detail: options.landedElsewhereFails }),
      );
      return (
        calls === undefined ? Effect.void : Ref.update(calls, (current) => [...current, call])
      ).pipe(Effect.zipRight(answer));
    },
    // The write, scripted and otherwise inert: nothing here builds a tree or
    // moves a ref, because what a case at this seam asserts is that the land
    // asked for it, with which stems, and what it did with the answer.
    // `test/issue-store.test.ts` is where the commit is really made.
    markLanded: ({ repo, branch, folder, stems, index }) => {
      const call: IssueStoreCall = { _tag: "MarkLanded", repo, branch, folder, stems, index };
      const answer = Effect.suspend((): Effect.Effect<Option.Option<string>, IssueStoreError> => {
        if (options.markLandedFails !== undefined) {
          return new GitError({ detail: options.markLandedFails });
        }
        return Effect.succeed(
          options.marksNothing === true ? Option.none() : Option.some(MARKED_COMMIT),
        );
      });
      return (
        calls === undefined ? Effect.void : Ref.update(calls, (current) => [...current, call])
      ).pipe(Effect.zipRight(answer));
    },
  });
