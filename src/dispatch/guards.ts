// The guards: every bad input a dispatch can be handed, refused before
// anything is acquired (SPEC §4, matrix row 1). Each one is a typed
// `GuardRefused` and holds nothing — no lock, no checkout, no container, no
// ledger row — which is the invariant the whole `Scope` design rests on.
//
// The ones that ask git a question go through the `Git` tag where it has the
// operation (T5) and through the subprocess chokepoint where it does not; what
// never changes is the shape of the answer, because what decides that shape is
// that a refusal here holds nothing — not that it only asked. Almost all of
// them are read-only ref questions put before a run exists; the one that is
// not is `originFetched` (T70), which moves this repo's remote-tracking refs
// and maps its `GitError` onto a `GuardRefused` exactly as the reads beside it
// do. Nothing here shells out to `gh` — that is `Forge`'s, and the one
// question a dispatch asks it before the run is the preflight's
// (`preflight.ts`).
import { resolve } from "node:path";
import { FileSystem, Terminal } from "@effect/platform";
import type { CommandExecutor } from "@effect/platform/CommandExecutor";
import { Data, DateTime, Effect, Either, Option } from "effect";
import { type AgentCredential, CREDENTIAL_ADVICE } from "../agent/credential.ts";
import { resolveSandboxEnvFile, resolveSetupHookPath } from "../config/paths.ts";
import { Git, type GitError, ORIGIN } from "../git/git.ts";
import { repoArgs } from "../git/repo-args.ts";
import type { RepoSlug } from "../git/repo-slug.ts";
import { exec } from "../internal/exec.ts";
import { IssueStore, type IssueStoreError, issuesPathFor } from "../issues/issue-store.ts";
import type { Issue } from "../issues/issue.ts";
import {
  type IssueSelection,
  select,
  type SelectionRefusal,
  type SelectionRequest,
} from "../issues/selection.ts";
import { type LastWorkedOn, Ledger } from "../ledger/ledger.ts";
import { editFailed, editText } from "../prompt/editor.ts";
import { Prompt } from "../prompt/prompt.ts";
import { Reporter } from "../reporter.ts";
import type { DispatchRequest } from "./dispatch.ts";
import { type HardReset, shortSha, specPathFor } from "./plan.ts";

// Protected branch, self-base, an absent branch, an unresolvable spec: one
// error for "the dispatcher asked for something we refuse to do", per SPEC
// §3's taxonomy. `detail` is the line the entrypoint renders.
export class GuardRefused extends Data.TaggedError("GuardRefused")<{
  readonly detail: string;
}> {}

// The wizard step a missing answer is for (T86).
export type MissingStep = "source" | "branch" | "issues";

// A refusal that means an answer is missing, not wrong (T86, SPEC §3): no
// source, no `--branch`, `--feature` without `--issues`. On a terminal the
// entrypoint catches it and hands `request` to the picker as its seed, so the
// wizard asks only for what is missing (`picker/seed.ts`). Anywhere else it is
// the `GuardRefused` it extends, with the same tag and `detail`, so it prints
// the same line and exits 1. Like every guard it is raised before the lock and
// writes no row.
//
// **A subclass, caught by class.** Matching a `GuardRefused` by its `detail`
// text would also compile. It would also turn the next refusal that happens
// to share those words into a question (AGENTS.md).
export class AnswerMissing extends GuardRefused {
  readonly step: MissingStep;
  readonly request: DispatchRequest;

  constructor(fields: {
    readonly step: MissingStep;
    readonly request: DispatchRequest;
    readonly detail: string;
  }) {
    super({ detail: fields.detail });
    this.step = fields.step;
    this.request = fields.request;
  }
}

export const isAnswerMissing = (error: unknown): error is AnswerMissing =>
  error instanceof AnswerMissing;

// PR targets, never pushed to (`run.sh:975-978`).
export const PROTECTED_BRANCHES: ReadonlyArray<string> = ["master", "main"];

export const isProtectedBranch = (branch: string): boolean => PROTECTED_BRANCHES.includes(branch);

// `--base` names a remote-tracking ref (`origin/master`); `--branch` names a
// local one. They collide on the branch name, which is what bash compares
// (`run.sh:979-980`).
export const stripOriginPrefix = (ref: string): string =>
  ref.startsWith("origin/") ? ref.slice("origin/".length) : ref;

export const namesTheSameRef = (branch: string, base: string): boolean =>
  branch === stripOriginPrefix(base);

// A missing git binary is a refusal like any other here: nothing is held and
// the dispatcher gets one line. `doctor` is where a broken toolchain is
// diagnosed properly.
//
// The repo is the first word and not an option, for `git.ts`'s reason (T27):
// a guard that answered from the working directory would refuse — or wave
// through — on a different repo than the one this dispatch is for, and the
// only way to keep that from being a thing to remember is for the spelling
// without it not to exist.
const git = (
  repo: string,
  ...args: ReadonlyArray<string>
): Effect.Effect<
  { readonly exitCode: number; readonly stdout: string },
  GuardRefused,
  CommandExecutor
> =>
  Effect.suspend(() => exec("git", ...repoArgs(repo), ...args)).pipe(
    Effect.mapError(() => new GuardRefused({ detail: "git CLI not found — install git" })),
  );

// `--branch` is required. The parser could refuse an absent flag itself, but
// then one of the six refusals in this file would arrive as a parser error
// with a different shape and a different exit path; the ticket's row-1
// invariant wants them uniform, so requiredness is a guard.
//
// An absent flag is an answer missing (T86). A flag typed with nothing in it
// is refused in the same words, but it stays a `GuardRefused`: the empty flag
// is what was typed, and the picker never opens for one.
export const branchGiven = (request: DispatchRequest): Effect.Effect<string, GuardRefused> => {
  const given = Option.filter(request.branch, (value) => value.trim() !== "");
  const detail =
    "--branch is required — the working branch. Create it first: git branch <name> [<start>]";
  return Option.match(given, {
    onNone: () =>
      Option.isNone(request.branch)
        ? new AnswerMissing({ step: "branch", request, detail })
        : new GuardRefused({ detail }),
    onSome: (value) => Effect.succeed(value),
  });
};

// Creating branches is the dispatcher's act, never ours (`run.sh:970-973`).
// One sentence for both refusals of a missing branch: this guard's, and the
// picker's for a seeded one (T96).
export const noSuchBranch = (branch: string): GuardRefused =>
  new GuardRefused({
    detail: `branch '${branch}' doesn't exist — create it first: git branch '${branch}' [<start>]`,
  });

export const branchExists = (
  repoRoot: string,
  branch: string,
): Effect.Effect<void, GuardRefused, CommandExecutor> =>
  git(repoRoot, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`).pipe(
    Effect.flatMap((result) => (result.exitCode === 0 ? Effect.void : noSuchBranch(branch))),
  );

export const branchNotProtected = (branch: string): Effect.Effect<void, GuardRefused> =>
  isProtectedBranch(branch)
    ? new GuardRefused({
        detail: `refusing '${branch}' as --branch — protected branches are PR targets (--base), never pushed to`,
      })
    : Effect.void;

export const baseNotBranch = (branch: string, base: string): Effect.Effect<void, GuardRefused> =>
  namesTheSameRef(branch, base)
    ? new GuardRefused({
        detail: "--branch and --base name the same ref — the PR would target itself",
      })
    : Effect.void;

// git refuses a fetch into a branch checked out in **any** worktree of this
// repo, not just this one, so the question is asked of the whole worktree list
// rather than of `symbolic-ref HEAD` — which sees only the current worktree
// and lets the linked-worktree case sail past here and die at preflight
// instead. bash has the identical hole (`run.sh:983-985`); closing it is a
// deliberate divergence, recorded in SPEC §12.
//
// This is `Git`'s first consumer: the tag owns the question, and the guard
// owns the refusal shape — a `GitError` here would be a run-time failure for
// what is still bad input (matrix row 1).
export const branchNotCheckedOut = (
  branch: string,
  repoRoot: string,
): Effect.Effect<void, GuardRefused, Git> =>
  Effect.gen(function* () {
    const repo = yield* Git;
    const worktrees = yield* repo
      .worktrees(repoRoot)
      .pipe(
        Effect.mapError(
          (error) =>
            new GuardRefused({ detail: `could not read this repo's worktrees: ${error.detail}` }),
        ),
      );
    const holder = worktrees.find(
      (worktree) => Option.isSome(worktree.branch) && worktree.branch.value === branch,
    );
    if (holder === undefined) {
      return;
    }
    // The repo root is the current worktree's root — `findRepoRoot` walks up
    // for `.git`, which a linked worktree has as a file — so which of the two
    // messages a dispatcher gets falls out of a pure comparison rather than a
    // second git call.
    return yield* new GuardRefused({
      detail:
        resolve(holder.path) === resolve(repoRoot)
          ? `'${branch}' is checked out in this repo — git refuses fetches/resets into a checked-out branch; switch away first`
          : `'${branch}' is checked out in the worktree at ${holder.path} — git refuses fetches/resets into a branch checked out anywhere in this repo; switch away there or remove that worktree`,
    });
  });

// What the dispatcher actually typed, if they typed anything: a flag holding
// nothing but whitespace named nothing. `branchGiven` above has spelled this
// inline since T3; `taskStatedOnce` below asks it of four flags at once, so it
// is a function.
const stated = (value: Option.Option<string>): Option.Option<string> =>
  Option.filter(value, (text) => text.trim() !== "");

// A task is required, and its absence is a guard rather than a parser error
// for `branchGiven`'s reason: the positional is parsed as optional since
// `--resume` supplies it off the ledger instead (T16), and a dispatch that
// named none of the four must still refuse with the one shape row 1 gives.
//
// The message names all four spellings — T67's three, and the feature form
// T73 adds. A dispatcher who meant to state their task inline, or to run a
// folder's issues, and mistyped the flag must not be told to go and write a
// file.
//
// It reads argv alone, so it runs beside `branchGiven`, ahead of
// `--feedback-edit`'s editor (T86): an absent source is an `AnswerMissing`,
// and nothing may open before the picker gets the chance to.
export const specGiven = (request: DispatchRequest): Effect.Effect<string, GuardRefused> => {
  const detail =
    'a task is required — pass <spec>, --task "…", --feature <folder> --issues …, or --resume <branch>';
  return Option.match(stated(request.spec), {
    onNone: () =>
      Option.isNone(request.spec)
        ? new AnswerMissing({ step: "source", request, detail })
        : new GuardRefused({ detail }),
    onSome: (value) => Effect.succeed(value),
  });
};

// The four spellings `--task` is refused in (T67, 22 §6 rows 10-13): a task
// stated inline **and** stated some other way, and a `--task` that states none
// at all.
//
// It is decided from the command line alone, and therefore runs ahead of
// everything this file asks the world — the ledger included. A resume resolved
// before this would answer *no ledger record for that branch* to a dispatcher
// whose actual mistake was naming a task and a resume in one breath, which is
// a refusal about the wrong thing and one they cannot act on.
//
// It takes the flag **as typed** rather than the filtered value `taskGiven`
// hands the rest of the dispatch: row 13 is a refusal *about* the emptiness, so
// by the time the filter has run the case is gone — `--task ""` and no `--task`
// at all are one value, and the dispatcher who typed the flag would fall
// through to `specGiven` above and be sent looking for a file.
// `--feedback-edit` rides in the same slot, and its two collisions are argv
// facts like the four below them (T84). The flag is a *second spelling of
// `--feedback`* — the editor writes the same value the flag would have carried
// — so the pair is refused for T67 row 12's reason and in its shape, and
// `--task` refuses it because `--task` already refuses `--feedback`.
//
// The `--feedback` collision is checked **before** the `--task` block, which is
// where bash checks it too (`run.sh:732`, ahead of the picker and the resume
// wiring): it is a static conflict between two sources of one value, and it
// holds whether or not there is a task on the line.
export const taskStatedOnce = (given: {
  readonly task: Option.Option<string>;
  readonly spec: Option.Option<string>;
  readonly resume: Option.Option<string>;
  readonly last: boolean;
  readonly feedback: Option.Option<string>;
  readonly feedbackEdit: boolean;
}): Effect.Effect<void, GuardRefused> => {
  if (given.feedbackEdit && Option.isSome(stated(given.feedback))) {
    return new GuardRefused({
      detail:
        "--feedback and --feedback-edit are two texts — --feedback-edit opens an editor on the one this run carries; state one, not both",
    });
  }
  return Option.match(given.task, {
    // No flag, nothing to collide: every dispatch before this ticket.
    onNone: () => Effect.void,
    onSome: (text) => {
      if (Option.isSome(stated(given.spec))) {
        return new GuardRefused({
          detail: "--task and <spec> are two tasks — a spec and inline text; state one, not both",
        });
      }
      if (given.last || Option.isSome(stated(given.resume))) {
        return new GuardRefused({
          detail: `--task and ${given.last ? "--last" : "--resume"} name two different runs — a resume replays the task its record holds, and a new task on that branch is a fresh dispatch on --branch`,
        });
      }
      if (Option.isSome(stated(given.feedback)) || given.feedbackEdit) {
        return new GuardRefused({
          detail: `--task and ${given.feedbackEdit ? "--feedback-edit" : "--feedback"} are two texts — the task already says what to do; feedback is for a spec or a resume`,
        });
      }
      // Last, so a dispatcher who typed two flags hears about the two flags:
      // an empty `--task` beside a spec is still two tasks, one of them blank.
      return text.trim() === ""
        ? new GuardRefused({
            detail: "--task was given with nothing in it — state the task, or pass <spec>",
          })
        : Effect.void;
    },
  });
};

// The spellings `--hard-reset` is refused in (T101), decided from the command
// line alone and in `taskStatedOnce`'s slot, for its reason: a resume
// resolved first would answer the collision with a refusal about the ledger.
//
// A resume continues the work a branch's record holds, and a hard reset
// discards it (D5) — the two cannot both be what the dispatcher meant. A
// feature resume is a resume. A fresh `--feature` is not refused (T103): it
// reads its set at the base, which the reset makes the effective tip.
export const hardResetStatedAlone = (given: {
  readonly hardReset: boolean;
  readonly resume: Option.Option<string>;
  readonly last: boolean;
}): Effect.Effect<void, GuardRefused> => {
  if (!given.hardReset) {
    return Effect.void;
  }
  if (given.last || Option.isSome(stated(given.resume))) {
    return new GuardRefused({
      detail: `--hard-reset and ${given.last ? "--last" : "--resume"} pull opposite ways — a resume continues the work a branch's record holds, and a hard reset discards it; pick one`,
    });
  }
  return Effect.void;
};

// The two sentences `branchContainsItsRemote` refuses with (T106), exported so
// a test asserts against them rather than retyping them. Each way out says
// what it does. Behind, `git branch -f` is a fast-forward and loses nothing;
// diverged, it would silently throw the local commits away, so that sentence
// never prints it — advice that destroys work is not printed where it would.
export const branchBehindItsRemote = (branch: string, behind: number): string =>
  `'${branch}' is ${behind} behind ${ORIGIN}/${branch}. To take origin's commits: git branch -f ${branch} ${ORIGIN}/${branch}. To discard them: --hard-reset.`;

export const branchDivergedFromItsRemote = (
  branch: string,
  ahead: number,
  behind: number,
): string =>
  `'${branch}' and ${ORIGIN}/${branch} have diverged — ${ahead} commit(s) only here, ${behind} only on ${ORIGIN}. Merge or rebase them by hand, or discard both with --hard-reset.`;

// A branch whose remote holds commits it does not is refused here, after the
// fetch and before anything is acquired (T106) — bash lets the run do all its
// work and fails at the push, which is not a fast-forward. `origin/<b>` is
// what origin holds now, since the fetch has just run; a read that fails is
// **absent**, which passes, because the first push creates it. Contained —
// equal tips, or local ahead — passes too: the push goes forward.
//
// A `GitError` past the origin read refuses with git's words (T5): a check
// that could not be made is not a clean sheet (T72). Under `--hard-reset` the
// caller does not run this at all — the reset discards both sides, and
// `hardResetDecided`'s union count already says how much.
export const branchContainsItsRemote = (fields: {
  readonly repoRoot: string;
  readonly branch: string;
  readonly tipSha: string;
}): Effect.Effect<void, GuardRefused, Git> =>
  Effect.gen(function* () {
    const repo = yield* Git;
    const originTip = yield* repo
      .revParse({ repo: fields.repoRoot, rev: `refs/remotes/${ORIGIN}/${fields.branch}` })
      .pipe(Effect.option);
    if (Option.isNone(originTip)) {
      return;
    }
    const uncheckable = (error: GitError) =>
      new GuardRefused({
        detail: `could not tell whether '${fields.branch}' contains ${ORIGIN}/${fields.branch}: ${error.detail}`,
      });
    const contained = yield* repo
      .branchContains({ repo: fields.repoRoot, branch: fields.branch, commit: originTip.value })
      .pipe(Effect.mapError(uncheckable));
    if (contained) {
      return;
    }
    const behind = yield* repo
      .countCommits({ repo: fields.repoRoot, from: fields.tipSha, to: originTip.value })
      .pipe(Effect.mapError(uncheckable));
    const ahead = yield* repo
      .countCommits({ repo: fields.repoRoot, from: originTip.value, to: fields.tipSha })
      .pipe(Effect.mapError(uncheckable));
    return yield* new GuardRefused({
      detail:
        ahead === 0
          ? branchBehindItsRemote(fields.branch, behind)
          : branchDivergedFromItsRemote(fields.branch, ahead, behind),
    });
  });

// What a `--hard-reset` dispatch will throw away, decided in the guard phase
// after the fetch and before anything reads the tip (T101).
//
// `originTip` is what `origin/<b>` holds now — the fetch has just run — and a
// read that fails is **absent**, which is the safe direction: the lease then
// expects the remote branch absent, and refuses to overwrite one that exists.
//
// The count is **one union** over the local tip and origin's, excluding the
// base (ruled 2026-09-24): the leased push overwrites whatever origin held, so
// commits only there are discarded too — a local branch behind or beside its
// remote has them, and `base..tip` alone reads 0 while the push destroys work.
// Two counts added together would count the shared history twice, and a
// pushed branch shares all of it. bash counts `$BASE_SHA..$BRANCH_REF` alone
// (`run.sh:1289`), which is the gap.
export const hardResetDecided = (fields: {
  readonly repoRoot: string;
  readonly branch: string;
  readonly baseSha: string;
  readonly tipSha: string;
}): Effect.Effect<HardReset, GuardRefused, Git> =>
  Effect.gen(function* () {
    const repo = yield* Git;
    const originTip = yield* repo
      .revParse({ repo: fields.repoRoot, rev: `refs/remotes/${ORIGIN}/${fields.branch}` })
      .pipe(Effect.option);
    const discarding = yield* repo
      .countReachable({
        repo: fields.repoRoot,
        excluding: fields.baseSha,
        tips: [fields.tipSha, ...Option.toArray(originTip)],
      })
      .pipe(
        Effect.mapError(
          (error) =>
            new GuardRefused({
              detail: `could not count what --hard-reset would discard on '${fields.branch}': ${error.detail}`,
            }),
        ),
      );
    return { discardedTip: fields.tipSha, discarding, originTip };
  });

// What a `--hard-reset` is about to throw away, said out loud, and on a
// terminal asked about (T102, `run.sh:1290-1298`). It runs straight after
// `hardResetDecided`, so a refusal here holds nothing and has written nothing
// but the fetch (matrix row 1).
//
// The warning is for every run with something to discard, a scripted one
// included: off a terminal the flag is its own consent (D3), and the line is
// what a dispatcher reads afterwards to learn what that consent cost. Nothing
// to discard says nothing and asks nothing — bash's `-gt 0`. A rehearsal asks
// the same question of a recording `Prompt` that answers yes (D4), so nothing
// here knows which it is talking to.
export const hardResetConfirmed = (fields: {
  readonly branch: string;
  readonly discarding: number;
  readonly noInput: boolean;
}): Effect.Effect<void, GuardRefused, Reporter | Terminal.Terminal | Prompt> =>
  Effect.gen(function* () {
    if (fields.discarding === 0) {
      return;
    }
    const reporter = yield* Reporter;
    yield* reporter.emit({
      _tag: "Warned",
      detail: `--hard-reset: DISCARDING ${fields.discarding} commit(s) on '${fields.branch}' — recoverable from the reflog only`,
    });
    const isTTY = yield* Effect.flatMap(Terminal.Terminal, (terminal) => terminal.isTTY);
    if (!isTTY || fields.noInput) {
      return;
    }
    const prompt = yield* Prompt;
    const proceed = yield* prompt
      .confirm({
        message: `Discard ${fields.discarding} commit(s) on '${fields.branch}' and reset it to the base?`,
        initial: false,
      })
      .pipe(Effect.catchTag("PromptCancelled", () => Effect.succeed(false)));
    if (!proceed) {
      return yield* new GuardRefused({
        detail: `--hard-reset aborted — '${fields.branch}' was not touched`,
      });
    }
  });

// bash's line, verbatim (`run.sh:740`). The flag opens an editor against the
// controlling terminal, so a backgrounded or piped dispatch cannot drive one
// and must say so rather than hang on a screen nobody is watching.
export const FEEDBACK_EDIT_NEEDS_A_TTY =
  "--feedback-edit requires a TTY (it opens an editor) — non-interactive dispatch: use --feedback <text> instead";

// The one question this flag asks of the world rather than of argv, and it is
// asked in the argv guards' slot all the same (T84): it is a fact about *this
// invocation* — is anyone there — and a dispatch that resolved a resume first
// would answer a piped `--feedback-edit` with *no ledger record for branch
// 'b'*, which is a refusal about the wrong thing. It runs before any git call,
// the editor lookup included.
export const feedbackEditOnATty = (
  feedbackEdit: boolean,
): Effect.Effect<void, GuardRefused, Terminal.Terminal> =>
  feedbackEdit
    ? Effect.flatMap(Terminal.Terminal, (terminal) => terminal.isTTY).pipe(
        Effect.flatMap((isTTY) =>
          isTTY ? Effect.void : new GuardRefused({ detail: FEEDBACK_EDIT_NEEDS_A_TTY }),
        ),
      )
    : Effect.void;

// What the file under the runtime root is named for. Only the purpose is
// fixed: the bracket mints the rest per session, so the picker's feedback step
// open beside this flag never shares its file, and a dispatcher who ever does
// meet one left behind meets one whose name says what it is.
export const FEEDBACK_EDIT_PURPOSE = "feedback";

// And the text itself, from the dispatcher's editor (T84). It stands exactly
// where `--feedback`'s value is read — above the fetch, above every guard that
// asks git anything but which editor to open — so a dispatcher who quits the
// editor has held nothing and left no row (matrix row 1).
//
// Every way the bracket can end arrives as one refusal, in `editText`'s own
// words: the dispatcher cancelling is what the flag is about, and git unable
// to name an editor or a runtime root that will not take a file are failures
// of the world that a guard still owes a line rather than a `Cause` (T5).
export const feedbackEdited = (options: {
  readonly repoRoot: string;
  readonly runtimeRoot: string;
  readonly branch: string;
}): Effect.Effect<string, GuardRefused, Git | FileSystem.FileSystem | CommandExecutor> =>
  Effect.scoped(
    editText({
      repo: options.repoRoot,
      runtimeRoot: options.runtimeRoot,
      purpose: FEEDBACK_EDIT_PURPOSE,
      header: [`feedback for '${options.branch}'`],
      what: "feedback",
    }),
  ).pipe(
    Effect.mapError(
      (error) => new GuardRefused({ detail: `--feedback-edit: ${editFailed(error)}` }),
    ),
  );

// What `--feature` and `--issues` named, once the pair has been found
// well-formed: the folder as the dispatcher typed it — `featureFolderFor`
// resolves it, and that is a pure derivation this guard may not do for it —
// and the request T69 selects with. The two travel together because they are
// one decision: neither is a dispatch on its own, which is what the four
// refusals below are about.
export interface FeatureRequested {
  readonly folder: string;
  readonly request: SelectionRequest;
}

// The five spellings `--feature`/`--issues` are refused in (T73, 09 unit 1 as
// 15 amended it), decided **from the command line alone** and standing in
// `taskStatedOnce`'s slot above for its reason: a resume or a ledger read taken
// first would answer a collision with a refusal about the ledger, which is
// about the wrong thing and one the dispatcher cannot act on. The fifth is
// where that sentence stopped being advice — `--feature` beside `--resume`
// passed this guard and lost to the resume arm downstream, so a dispatcher who
// named a folder was answered *no ledger record for branch 'b'* on a branch
// they had not asked to replay, or, worse, watched the recorded task run in
// silence with their selection dropped.
//
// The rule underneath all five is 15's: *the dispatcher may replay a work set
// it recorded, and may execute a set the command named. It may never compute
// one the command did not name.* `--feature` alone would have the dispatcher
// compute one, so it refuses; the wide form is spelled `--issues all`, which
// names a predicate and therefore counts as named — consenting to wideness,
// not to contents.
//
// It takes `issues` **as typed** beside the filtered `selection`, the same
// split `taskStatedOnce` draws for `--task`: after the filter a flag holding
// nothing and no flag at all are one value, and the two are different
// refusals — *name the set* versus *this set is empty*, and only one of them is
// the mistake of a dispatcher who typed `--issues`. It takes `feature` as typed
// for the same reason (T87): `--feature '  '` is a flag that named no folder,
// refused as that whatever else is on the line — beside `--issues` the filtered
// value alone would tell the dispatcher to pass the flag they just passed.
//
// Two of its arms are an answer missing rather than a wrong one (T86):
// `--issues` with nothing it could narrow is missing a source, and
// `--feature` with no `--issues` is missing the issues. Each is an
// `AnswerMissing` carrying `given`, which is why it takes the whole request.
export const featureStatedOnce = (
  given: DispatchRequest,
  // What `--issues` named after the trim-and-filter the dispatch does once at
  // the door: `None` where the flag named no id at all, which is the empty
  // selection below and never a selection of nothing.
  selection: Option.Option<SelectionRequest>,
): Effect.Effect<Option.Option<FeatureRequested>, GuardRefused> =>
  Option.match(stated(given.feature), {
    onNone: () => {
      // The flag was typed and named nothing: refused as the emptiness, ahead
      // of the `--issues` row below, which would otherwise answer it.
      if (Option.isSome(given.feature)) {
        return new GuardRefused({
          detail:
            "--feature was given with nothing in it — name the folder whose issues this run works through",
        });
      }
      // `--issues` on its own names nothing: it narrows a set a feature has or
      // a resume recorded, and neither is here (`run.sh:926`). A resume beside
      // it passes — the subset rule is T88's, and it needs the record, so the
      // resume decides it (`resume.ts`).
      if (Option.isNone(given.issues) || given.last || Option.isSome(stated(given.resume))) {
        return Effect.succeedNone;
      }
      const detail =
        "--issues names the issues of a feature or narrows a resume — pass --feature <folder> beside it, or --resume <branch>";
      // An `--issues` that named something, standing alone, is missing a
      // feature to name them from. One that named nothing is the empty flag,
      // and one beside a spec or a task is two sources — a seed would answer
      // the source step with the other and drop `--issues` from the words, so
      // both stay refused.
      return Option.isSome(selection) && Option.isNone(given.spec) && Option.isNone(given.task)
        ? new AnswerMissing({ step: "source", request: given, detail })
        : new GuardRefused({ detail });
    },
    onSome: (folder) => {
      // Two tasks, in T67 row 10's shape and for its reason: a folder of
      // issues and a spec, or a folder of issues and inline text, are two
      // answers to what this run is for.
      if (Option.isSome(stated(given.spec))) {
        return new GuardRefused({
          detail:
            "--feature and <spec> are two tasks — a folder of issues and a spec; state one, not both",
        });
      }
      if (Option.isSome(stated(given.task))) {
        return new GuardRefused({
          detail:
            "--feature and --task are two tasks — a folder of issues and inline text; state one, not both",
        });
      }
      // And a resume, which is `--task`'s row 11 on this pair: a replay takes
      // its work set off the record, so a folder and a set named on the
      // command line are a *second* answer to what this run is for. It sits
      // above the two `--issues` rows below because the whole command line is
      // the mistake — a dispatcher told to pass `--issues` would add one and
      // still lose the selection to the resume.
      if (given.last || Option.isSome(stated(given.resume))) {
        return new GuardRefused({
          detail: `--feature and ${given.last ? "--last" : "--resume"} name two different runs — a resume replays the work set its record holds, and a folder of issues named on the command line is a fresh dispatch on --branch`,
        });
      }
      if (Option.isNone(given.issues)) {
        return new AnswerMissing({
          step: "issues",
          request: given,
          detail: `--feature '${folder}' needs --issues — a selection the dispatcher did not name is a proposal, not an instruction; name the issues, or pass --issues all`,
        });
      }
      // And the flag that was typed and named nothing, which is refused as the
      // emptiness it is rather than as the requirement above: a dispatcher
      // told to pass `--issues` when they just did is left working out which
      // half of the sentence was theirs.
      return Option.match(selection, {
        onNone: () =>
          new GuardRefused({
            detail: `--issues was given with nothing in it — name the issues of '${folder}', or pass --issues all`,
          }),
        onSome: (request) => Effect.succeedSome({ folder, request }),
      });
    },
  });

// Absolute, and here rather than in the pure derivation, which may not read
// the world. Both arms anchor to the repo root, which is what bash gets by
// `cd`-ing there first (run.sh:235-236): the plan is what T18-T6 mount and
// T15 prints, so the same file may not reach it under two different values
// depending on which form was typed or which directory it was typed from.
const specLocation = (repoRoot: string, tasksDir: string, spec: string): string =>
  resolve(repoRoot, specPathFor(tasksDir, spec));

const isFile = (path: string): Effect.Effect<boolean, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const info = yield* fs.stat(path).pipe(Effect.option);
    return Option.isSome(info) && info.value.type === "File";
  });

// Bare name → `<tasks-dir>/<name>.md`, anything with a slash used as-is
// (SPEC §7). The path is resolved purely; only its existence needs the world.
export const specResolved = (
  repoRoot: string,
  tasksDir: string,
  spec: string,
): Effect.Effect<string, GuardRefused, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const resolved = specLocation(repoRoot, tasksDir, spec);
    if (!(yield* isFile(resolved))) {
      return yield* new GuardRefused({ detail: `spec not found: ${resolved}` });
    }
    return resolved;
  });

// The same question, answered as data rather than as a refusal. A resumed
// spec that is gone is not automatically a refusal — the decision table is
// what decides what its absence means (T16), and this may not pre-empt it.
export const specLocated = (
  repoRoot: string,
  tasksDir: string,
  spec: string,
): Effect.Effect<Option.Option<string>, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const resolved = specLocation(repoRoot, tasksDir, spec);
    return (yield* isFile(resolved)) ? Option.some(resolved) : Option.none();
  });

// The setup hook (T7) is config-declared and optional, and both halves of that
// are decided here: a config naming no script skips the step entirely, and one
// naming a script that is not on this host refuses before anything is
// acquired. A missing file is a guard's answer, not a container's — the
// alternative starts a container, mounts a bind docker invents a directory
// for, and reports the mistake three held resources later.
export const setupHookFound = (
  repoRoot: string,
  setupHook: string,
): Effect.Effect<void, GuardRefused, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const hook = resolveSetupHookPath(repoRoot, setupHook);
    if (Option.isNone(hook)) {
      return;
    }
    const fs = yield* FileSystem.FileSystem;
    const info = yield* fs.stat(hook.value).pipe(Effect.option);
    if (Option.isNone(info) || info.value.type !== "File") {
      return yield* new GuardRefused({
        detail: `setup hook not found: ${hook.value} — config declares 'setup-hook', so the run would have nothing to run`,
      });
    }
  });

// The container's env file (T61), and the setup hook's ruling above applied to
// the one config-declared path whose file's *contents* cross into the sandbox:
// a missing file is a guard's answer, not a container's. Two of the three
// answers `resolveSandboxEnvFile` gives are refusals, and this is the one place
// that decides what they mean — *outside* the served repo is refused rather
// than resolved (19 §5), because a file docker reads for us has to sit where
// review sees it, and a named file that is not on this host is refused before
// the lock like every other bad input (matrix row 1).
//
// **The check is a `stat`, never a read.** Speepobox never opens this file;
// docker does. That is why its values cannot reach argv, a log, the ledger, or
// an event — the path is in this refusal, the contents are in none of them.
export const sandboxEnvFileFound = (
  repoRoot: string,
  sandboxEnvFile: string,
): Effect.Effect<void, GuardRefused, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const declared = resolveSandboxEnvFile(repoRoot, sandboxEnvFile);
    if (declared._tag === "None") {
      return;
    }
    if (declared._tag === "Outside") {
      return yield* new GuardRefused({
        detail: `'sandbox-env-file' must name a file inside the served repo, and ${declared.reason} — docker reads that file into the container, so it stays where review sees it`,
      });
    }
    const fs = yield* FileSystem.FileSystem;
    const info = yield* fs.stat(declared.path).pipe(Effect.option);
    if (Option.isNone(info) || info.value.type !== "File") {
      return yield* new GuardRefused({
        detail: `sandbox env file not found: ${declared.path} — config declares 'sandbox-env-file', so the container would start without the environment it names`,
      });
    }
  });

// The agent credential (T23), and the same ruling the setup hook above got:
// **a missing file is a guard's answer, not a container's**. The resolver runs
// at the composition root, so by the time a dispatch is called the answer is
// already in hand — this only decides what to do with it, and what it does is
// refuse before the lock, holding nothing and writing no ledger row (SPEC §11).
// The alternative is what the run did until this ticket: take the lock, clone,
// start a container, deliver the prompt, and watch the agent answer
// `Not logged in · Please run /login`.
//
// The advice is probe 3's, spelled once in the resolver's module and said in
// both places, because there is now one answer behind them.
export const credentialFound = (
  credential: Option.Option<AgentCredential>,
): Effect.Effect<AgentCredential, GuardRefused> =>
  Option.match(credential, {
    onNone: () => new GuardRefused({ detail: CREDENTIAL_ADVICE }),
    onSome: (found) => Effect.succeed(found),
  });

// The repo every `gh` call this run makes will name (T39), resolved at the
// composition root from `repoRoot`'s `origin` remote and refused here rather
// than answered by whichever repo the process happened to start in — the
// same split `credentialFound` draws between "the composition root could not
// resolve it" and "the guard says what that means", so this is a typed
// refusal naming the repo root and never a `gh` error about a missing ref.
export const forgeRepoFound = (
  repoRoot: string,
  forgeRepo: Option.Option<RepoSlug>,
): Effect.Effect<RepoSlug, GuardRefused> =>
  Option.match(forgeRepo, {
    onNone: () =>
      new GuardRefused({
        detail: `could not resolve which repo to open a PR on — '${repoRoot}'s 'origin' remote either does not resolve or does not name an owner/repo`,
      }),
    onSome: (found) => Effect.succeed(found),
  });

// `git fetch origin`, once, before anything reads a remote-tracking ref (T70,
// SPEC §7 step 2). It is the one thing in this file that writes, and it is
// still a guard by the test that decides the rest of them: it holds nothing,
// it has no release, and matrix row 1's invariant is *nothing acquired* — no
// lock, no clone, no container, no ledger row — which a moved
// `refs/remotes/origin/*` does not dent.
//
// So the failure is a `GuardRefused` and not the `GitError` the tag raised,
// for every guard's reason: nothing is held, and the dispatcher's next move is
// to fix the host rather than to read a run-time failure. git's own line
// travels on it — no network, no `origin`, and a refused credential are three
// different repairs, and only git can tell them apart. bash dies here under
// `set -e` (`run.sh:1268`); this is the same stop with a sentence on it.
export const originFetched = (repoRoot: string): Effect.Effect<void, GuardRefused, Git> =>
  Git.pipe(
    Effect.flatMap((repo) => repo.fetch({ repo: repoRoot, remote: ORIGIN })),
    Effect.mapError(
      (error) =>
        new GuardRefused({
          detail: `${error.detail} — this dispatch resolves --base out of origin's refs, so '${repoRoot}' has to be able to reach it`,
        }),
    ),
  );

// `--base` is resolved out of what the fetch above just brought back (T70):
// one authoritative `BASE_SHA`, taken after the network round trip rather than
// off whatever a hand-run `git fetch` last left. The resolution goes through
// `Git.revParse`, but a ref that does not resolve is bad input, so it refuses
// here rather than reaching the dispatcher as the `GitError` the tag raised.
export const resolveBaseSha = (
  repoRoot: string,
  base: string,
): Effect.Effect<string, GuardRefused, Git> =>
  Git.pipe(
    Effect.flatMap((repo) => repo.revParse({ repo: repoRoot, rev: `${base}^{commit}` })),
    Effect.mapError(
      () =>
        new GuardRefused({
          // The advice is what is true now that the dispatch fetches: a ref
          // that does not resolve here did not resolve against a current
          // `origin` either, so there is nothing left for the dispatcher to
          // fetch and the only thing left to fix is the ref they named (T70).
          detail: `--base '${base}' does not resolve to a commit after fetching origin — pass a ref that exists`,
        }),
    ),
  );

// The diff boundary review, PR description, and commit counting all scope to
// (`run.sh:1048`) — the fork SHA is meaningless once branches pre-exist.
// Unrelated histories have no merge-base, and a dispatch with no boundary has
// nothing to review against, so that too refuses here rather than deeper.
//
// It asks through the `Git` tag, like `resolveBaseSha` two lines above it and
// unlike the subprocess call it was until T27: the header's rule is "the tag
// where it has the operation", and giving the tag the operation is what puts
// this read under the same one-repo rule as every other. The `GitError` is
// mapped onto this file's own refusal shape for the reason matrix row 1 gives.
export const resolveMergeBase = (
  repoRoot: string,
  baseSha: string,
  branch: string,
): Effect.Effect<string, GuardRefused, Git> =>
  Git.pipe(
    Effect.flatMap((repo) => repo.mergeBase({ repo: repoRoot, baseSha, branch })),
    Effect.mapError(
      () =>
        new GuardRefused({
          detail: `'${branch}' and the base share no history — no diff boundary to review against`,
        }),
    ),
  );

// The branch tip, read once in the guard phase and put on the plan (T73). This
// is 15's **fork commit**: the checkout clones the tip, so the tip is the ref
// whose content the agent will see (14), and it is therefore the ref the issue
// set is read at. `BASE_SHA` is the diff boundary's *other* end and is never
// what a set is read at (T70 §4); the working tree is never read at all, and a
// read of it would typecheck and answer for whichever branch the dev left
// checked out.
//
// `branchExists` has already refused a branch that is not there, so a failure
// here is git unable to answer about a ref it just confirmed — still bad input
// as far as this phase is concerned, so it refuses in this file's shape with
// git's own line on it.
export const resolveBranchTip = (
  repoRoot: string,
  branch: string,
): Effect.Effect<string, GuardRefused, Git> =>
  Git.pipe(
    Effect.flatMap((repo) => repo.revParse({ repo: repoRoot, rev: `refs/heads/${branch}` })),
    Effect.mapError(
      (error) =>
        new GuardRefused({
          detail: `could not resolve the tip of '${branch}': ${error.detail}`,
        }),
    ),
  );

// What each of `IssueStore`'s three failures says, at one tip of one branch.
// Each is a different repair, so each gets its own sentence: a folder no ref
// carries is one to add to the branch, a file that will not parse is a header
// to fix, and git refusing outright is git's own line — flattening them would
// hand the dispatcher one message for three moves (SPEC §3).
//
// Exported for the picker's issues step (T83), which reads the same folder at
// the same tip before any dispatch exists and shows the first two sentences
// as they are: one refusal on two screens, said once.
export const issueSetRefusal = (
  error: IssueStoreError,
  fields: { readonly branch: string; readonly tipSha: string; readonly folder: string },
): GuardRefused => {
  switch (error._tag) {
    // The port requires a **tracked** set (map ruling of 2026-08-20) and
    // falls back to no host tree, so an untracked queue and a branch cut
    // before the folder was added arrive here as one answer — git cannot
    // tell them apart — and the sentence names both repairs.
    case "FolderAbsent":
      return new GuardRefused({
        detail: `${error.path}/ is not on branch '${fields.branch}' at ${shortSha(error.ref)} — the folder must be tracked and present on the branch (an untracked queue is not supported; a branch cut before the folder was added needs a rebase)`,
      });
    case "Unparseable":
      return new GuardRefused({
        detail: `${error.file} at ${shortSha(error.ref)} cannot be read as an issue — ${error.detail}`,
      });
    case "GitError":
      return new GuardRefused({
        detail: `could not read ${issuesPathFor(fields.folder)}/ on branch '${fields.branch}' at ${shortSha(fields.tipSha)}: ${error.detail}`,
      });
  }
};

// The issue set as `<folder>/issues/` holds it **at the tip**, through
// `IssueStore` (T71) and therefore out of git objects rather than off disk.
// Two reads and nothing held, which is what keeps this in the guard phase.
export const issueSetAt = (fields: {
  readonly repoRoot: string;
  readonly branch: string;
  readonly tipSha: string;
  readonly folder: string;
}): Effect.Effect<ReadonlyArray<Issue>, GuardRefused, IssueStore> =>
  IssueStore.pipe(
    Effect.flatMap((store) =>
      store.issues({ repo: fields.repoRoot, ref: fields.tipSha, folder: fields.folder }),
    ),
    Effect.mapError((error) => issueSetRefusal(error, fields)),
  );

// One `SelectionRefusal` arm said in this file's vocabulary. T69 returns the
// arms as **data** — ids, titles, and the tokens a file wrote, and no sentence
// — precisely so the sentence is written once, here, where a dispatcher reads
// it; a message built there would be a second copy of it.
//
// `replaying` is the branch a resume's recorded set is replayed on (T78), and
// it changes one arm: every id a resume asks for is one its record says was
// *not* approved, so `AlreadyDone` there is not a dispatcher re-running landed
// work — it is the branch having moved under the record, and it says so.
const refusalLine = (refusal: SelectionRefusal, replaying: Option.Option<string>): string => {
  if (refusal._tag === "AlreadyDone" && Option.isSome(replaying)) {
    return `the branch moved under the record: ${refusal.issues.map((issue) => issue.id).join(", ")} Done on this ref, but the last run recorded on '${replaying.value}' did not approve it — the record no longer describes the branch; dispatch what is left afresh with --feature … --issues …`;
  }
  switch (refusal._tag) {
    case "NothingReady":
      return `nothing under ${issuesPathFor(refusal.folder)}/ is ready — --issues all selects the AFK issues at 'Status: ready-for-agent' whose blockers are done or also selected`;
    case "UnknownIssue":
      // The hint is the folder's own ids, and there may be none: a tracked
      // `issues/` holding nothing but a `.gitkeep` is `FolderAbsent`'s
      // opposite — the directory is there and empty — and the list is what
      // says so. Joining an empty one would end the sentence on *the folder
      // holds* and leave the dispatcher to guess whether the hint was cut off.
      return refusal.known.length === 0
        ? `no issue is named by ${refusal.ids.join(", ")} — the folder holds no issues at all`
        : `no issue is named by ${refusal.ids.join(", ")} — the folder holds ${refusal.known.join(", ")}`;
    case "AlreadyDone":
      return `already done on this ref: ${refusal.issues.map((issue) => issue.id).join(", ")} — re-running landed work is refused, never silently skipped`;
    case "NotAfk":
      return `not an AFK issue: ${refusal.issues.map((issue) => issue.id).join(", ")} — 'Type: HITL' is a human's to do`;
    case "BlockerViolation":
      return `blocked: ${refusal.pairs.map((pair) => `${pair.issue.id} by '${pair.blocker.token}'`).join(", ")} — a blocker has to be done on this ref or named in this selection`;
    case "BlockerCycle":
      return `${refusal.ids.join(", ")} block each other — no order runs them`;
  }
};

// T69's `select`, with **every** arm that fired in one message (its own rule,
// and this is the end it was written for): a dispatcher fixes one command line
// instead of re-running to meet the next complaint. The header names the
// folder and the ref the set was read at, because which of the two a
// dispatcher's belief disagrees with is the first thing they ask.
//
// A resume's replay comes through here too (T78), as an `Enumerated` request
// of the ids its record left, so a blocker that landed elsewhere since refuses
// exactly as it would on a fresh dispatch. `replaying` names the branch on that
// arm alone; the header then says it was the record, not `--issues`, that
// named the set.
export const issuesSelected = (fields: {
  readonly issues: ReadonlyArray<Issue>;
  readonly request: SelectionRequest;
  readonly folder: string;
  readonly tipSha: string;
  readonly replaying?: Option.Option<string>;
}): Effect.Effect<IssueSelection, GuardRefused> => {
  const replaying = fields.replaying ?? Option.none();
  return select(fields.issues, fields.request, fields.folder).pipe(
    Either.mapLeft(
      (refused) =>
        new GuardRefused({
          detail: [
            Option.match(replaying, {
              onNone: () =>
                `--issues does not select a run of '${fields.folder}' at ${shortSha(fields.tipSha)}:`,
              onSome: (branch) =>
                `the set of '${fields.folder}' recorded on '${branch}' does not replay at ${shortSha(fields.tipSha)}:`,
            }),
            ...refused.refusals.map((refusal) => `  ${refusalLine(refusal, replaying)}`),
          ].join("\n"),
        }),
    ),
  );
};

// --- the two witnesses for "someone else already has this issue" (T74) ------

// Both of the checks below run **under `--issues all` and only under it**, and
// the decision is the caller's rather than theirs (`dispatch.ts`): they are
// skipped outright rather than run and ignored, because the scan is two git
// processes over every ref and a check whose answer is discarded is a check a
// reader will one day believe was made. Enumerating is the override for both —
// `all` consents to wideness, not to contents (15), and naming an id is the
// dispatcher saying they know what it is.

// The refs of one hit, as a sentence reads them. A branch and its
// remote-tracking copy are two answers and not one — a local branch behind its
// own remote is fixed differently from a branch somebody else landed (T72) —
// so all of them are quoted rather than counted.
const andList = (items: ReadonlyArray<string>): string =>
  items.length < 2 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;

// The first witness, and the **hard** one: git, asked of every ref (T72). It
// is truth rather than a hint — host-independent, and self-correcting after a
// `--hard-reset` discards a branch (14) — so there is no arm on which it
// degrades, and every hit refuses.
//
// The scan's own failure refuses too, in the shape `issueSetAt` gives git's
// third arm: a scan that could not be made is not a clean sheet, and reporting
// one as the other is the one thing a witness may not do.
//
// Under `--hard-reset` the branch being discarded is not a witness against
// itself (T103): `refs/heads/<b>` goes to the reset and
// `refs/remotes/origin/<b>` to the lease push, so both are left out by name —
// which is what makes 15's "self-correcting" true. Without the flag the
// request is what it always was.
export const notLandedElsewhere = (fields: {
  readonly repoRoot: string;
  readonly branch: string;
  readonly folder: string;
  readonly issues: ReadonlyArray<Issue>;
  readonly tipSha: string;
  readonly resetting: boolean;
}): Effect.Effect<void, GuardRefused, IssueStore> =>
  IssueStore.pipe(
    Effect.flatMap((store) =>
      store.landedElsewhere({
        repo: fields.repoRoot,
        folder: fields.folder,
        issues: fields.issues,
        tip: fields.tipSha,
        ...(fields.resetting
          ? {
              alsoExcluding: [
                `refs/heads/${fields.branch}`,
                `refs/remotes/origin/${fields.branch}`,
              ],
            }
          : {}),
      }),
    ),
    Effect.mapError(
      (error) =>
        new GuardRefused({
          detail: `could not read which refs already carry ${issuesPathFor(fields.folder)}/ as done: ${error.detail}`,
        }),
    ),
    Effect.flatMap((landed) =>
      landed.length === 0
        ? Effect.void
        : // Every hit in one message, for `issuesSelected`'s reason: a
          // dispatcher fixes one command line rather than re-running to meet
          // the next complaint.
          new GuardRefused({
            detail: landed
              .map(
                (hit) =>
                  `${hit.id} is Done on ${andList(hit.refs)} but not on '${fields.branch}' — merge or rebase before dispatching it here, or enumerate --issues to override`,
              )
              .join("\n"),
          }),
    ),
  );

// What the row says happened, for the sentence: the verdict and the day. A run
// that crashed before a verdict recorded none, and the absence travels rather
// than a stand-in — the day alone still says which run this was.
const lastRunSaid = (last: LastWorkedOn): string =>
  Option.match(last.outcome, {
    onNone: () => DateTime.formatIsoDateUtc(last.endedAt),
    onSome: (outcome) => `${outcome}, ${DateTime.formatIsoDateUtc(last.endedAt)}`,
  });

// The second witness, and the **hint**: the ledger (T74 §2), which is derived
// state and per-machine (SPEC §10). It answers only whether a run would be
// *wasted*, never whether it would be wrong (15), which is why a `LedgerError`
// is a `Warned` event and the check passes — 09 unit 2's rule, the one
// `lastBaseForBranch` already follows — and why an over-refusal on one host
// beside silence on another is asymmetric in the safe direction.
//
// A row naming **this** branch is the ordinary case: it is this dispatch's own
// history, and re-dispatching a branch you already ran is what `--resume` is.
export const notInProgressElsewhere = (fields: {
  readonly branch: string;
  readonly folder: string;
  readonly issues: ReadonlyArray<Issue>;
}): Effect.Effect<void, GuardRefused, Ledger | Reporter> =>
  Effect.gen(function* () {
    const ledger = yield* Ledger;
    const reporter = yield* Reporter;
    const elsewhere = yield* Effect.forEach(fields.issues, (issue) =>
      ledger.newestBranchForIssue({ feature: fields.folder, issue: issue.id }).pipe(
        Effect.map(
          Option.match({
            onNone: (): ReadonlyArray<{ readonly issue: Issue; readonly last: LastWorkedOn }> => [],
            onSome: (last) => (last.branch === fields.branch ? [] : [{ issue, last }]),
          }),
        ),
      ),
    ).pipe(
      Effect.map((found) => found.flat()),
      // One warning for the read, not one per issue: the ledger is read whole,
      // so every query would fail with the same line, and the check is waived
      // as a whole rather than issue by issue.
      Effect.catchAll((error) =>
        reporter
          .emit({
            _tag: "Warned",
            detail: `--issues all could not ask the ledger where these issues were last worked on (${error.detail}) — dispatching without that check, which is a hint rather than a correctness question`,
          })
          .pipe(Effect.as([])),
      ),
    );
    if (elsewhere.length === 0) {
      return;
    }
    return yield* new GuardRefused({
      detail: elsewhere
        .map(
          ({ issue, last }) =>
            `${issue.id} was last worked on '${last.branch}' (${lastRunSaid(last)}) — dispatch it there with --resume, or enumerate --issues to override`,
        )
        .join("\n"),
    });
  });
