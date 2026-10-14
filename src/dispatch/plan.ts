// The resolved plan: what a dispatch decided before it acquired anything.
//
// Slug, container id, checkout path, log path, and spec resolution are plain
// functions with no tag (SPEC §2) — pure, so a fake buys nothing. They are
// derived exactly once, here, and every later consumer reads the value:
// T15's `--dry-run` prints this rather than re-deriving it, which is what
// `run.sh:1802-1806` does and why its dry run and its dispatch can disagree.
import { join, relative, resolve, sep } from "node:path";
import { DateTime, Option, Schema } from "effect";
import { IssueSelection } from "../issues/selection.ts";
import { RunIdentity } from "../ledger/record.ts";

// The container name is for humans only — ownership is declared by label and
// never inferred from a name (ownership/labels.ts, design rule 3).
export const CONTAINER_PREFIX = "speepobox-";
export const CHECKOUTS_DIRNAME = "checkouts";
export const LOGS_DIRNAME = "logs";
export const LOCKS_DIRNAME = "locks";

// `run.sh:1201`: lowercase, every run of non-alphanumerics collapsed to one
// dash, no leading or trailing dash. The branch is the task's identity, so
// this one string keys the container, the checkout, and the lock. The log
// does not: two dispatches of one branch share a slug and must not share a
// file (T47), so its path is keyed off the run id below instead.
export const slugFor = (branch: string): string =>
  branch
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");

export const containerIdFor = (slug: string): string => `${CONTAINER_PREFIX}${slug}`;

export const checkoutPathFor = (runtimeRoot: string, slug: string): string =>
  join(runtimeRoot, CHECKOUTS_DIRNAME, slug);

// Keyed off the run id, not the slug (T47): two dispatches of one branch
// share a slug but never a run id, so each gets its own file under the same
// `logs/` directory and neither is renamed or overwritten by the other.
export const logPathFor = (runtimeRoot: string, runId: string): string =>
  join(runtimeRoot, LOGS_DIRNAME, `${runId}.log`);

// A log path rendered for a reader, never asserted (T48). `DispatchPlan.logPath`
// is absent on a rehearsal's plan, and most of its readers sit behind tags a
// rehearsal's recording layers replace — `Ledger`, `Notifier`, the agent pass —
// so they can never actually receive `None` a real dispatch produced. They
// still have to typecheck without `Option.getOrThrow` and without an
// empty-string default that would read like a path in a message a dispatcher
// sees.
export const logPathOrNote = (logPath: Option.Option<string>): string =>
  Option.getOrElse(logPath, () => "no log — this is a rehearsal");

// Keyed off the same slug as the two above (`run.sh:1216`), and derived here
// with them so a caller cannot key the lock off one slug and the container off
// another. It is not a `DispatchPlan` field: bash's `--dry-run` block prints no
// lock row, and T15 inherits that shape.
export const lockPathFor = (runtimeRoot: string, slug: string): string =>
  join(runtimeRoot, LOCKS_DIRNAME, `${slug}.pid`);

// Where the status commit's tree is built (T77): a scratch index under the
// runtime root, keyed off the same slug as the three above, because it is a
// write of this host's and never of the repository it is about — the commit is
// built in the served repo with plumbing, and the one file it may not touch
// there is the `.git/index` a human has staged in. Keyed rather than fixed,
// because two runs of two branches share a runtime root and hold two different
// locks; the write removes it when it is done, and `read-tree` replaces the
// file whole, so a leftover from a run killed mid-write carries nothing into
// the next one.
//
// Under `locks/`, beside the lock the run holds while it writes, and not at the
// runtime root's top: the default root is the served repo's `.speepobox/`, and a
// loose file there is an untracked file in that repo. The suffix is neither
// `.pid` nor `.evicting`, so the lock scans skip it the way they skip
// `claim.ts`'s temp file.
//
// Not a `DispatchPlan` field, for `lockPathFor`'s reason: nothing renders it,
// and its one caller derives it from the plan's slug.
export const statusIndexPathFor = (runtimeRoot: string, slug: string): string =>
  join(runtimeRoot, LOCKS_DIRNAME, `${slug}.index`);

// A run id from the clock and the slug, not from host randomness: the lock is
// what makes the pair unique — two runs of one slug cannot overlap, which is
// the whole point of holding it — and `Clock` is a service a test controls.
//
// The clock read here is **plan time**, not lock-claim time: `planFor` calls
// this with the `startedAt` it is handed, and the ledger row's own
// `startedAt` field is read later, when `runInScope` claims the lock. The two
// can be seconds apart — they are the two ends of the preflight — and after
// this ticket neither is derivable from the other. That is deliberate: T47
// needs the id fixed before anything is opened, so a reader who finds the
// plan and the row disagreeing on time should read it as the shape of the
// preflight, not as drift.
export const runIdFor = (slug: string, startedAt: DateTime.Utc): string =>
  `${slug}-${DateTime.toEpochMillis(startedAt)}`;

// SPEC §7: a bare name resolves under the tasks dir; anything with a slash is
// a path used as-is. "As-is" is about the *directory* — the `.md` suffix is
// appended on both arms, as `run.sh:859-860` does, so `--branch`-shaped
// muscle memory (`tasks/T3` no less than `T3`) lands on the file that exists.
// Existence is the guard's business; this stays pure.
export const specPathFor = (tasksDir: string, spec: string): string => {
  const located = spec.includes("/") ? spec : join(tasksDir, spec);
  return located.endsWith(".md") ? located : `${located}.md`;
};

// `--feature`'s folder (SPEC §7): the rule above without the `.md` suffix — a
// bare name resolves under the tasks dir, anything with a slash is a path used
// as-is (`run.sh:790`) — and the answer is **repo-relative**, which is what the
// plan, the ledger row, and every message carry (14, lesson 9). Relative rather
// than absolute because the set is read out of a ref and never off disk (T71):
// a path anchored to this host names no git object, and it is not the path a
// dispatcher reading a row would type back either.
export const featureFolderFor = (repoRoot: string, tasksDir: string, feature: string): string => {
  const located = feature.includes("/") ? feature : join(tasksDir, feature);
  return relative(repoRoot, resolve(repoRoot, located)).split(sep).join("/");
};

// Abbreviated here rather than by git, and at a fixed width: bash prints
// `git rev-parse --short`, which honours `core.abbrev`, so a dispatcher who set
// that to 12 reads 12 there and 10 here. This is a pure function over values
// the plan already carries, and both ways to close the gap cost more than the
// line does — asking git inside a renderer makes the plan block a subprocess
// call, and putting the abbreviation on the `DispatchPlan` makes a cosmetic
// host setting a field the ledger row's producer carries. Recorded in SPEC
// §12's ported-with-divergence set rather than left unstated (T3's review,
// closed by T15, whose whole output is the plan block).
//
// **One function, two call sites** (T73): the plan block (`render.ts`) and the
// content guards, whose refusals name the tip the issue set was read at
// (`guards.ts`). Two abbreviations that disagreed would name one commit two
// ways on two screens about one run.
export const SHORT_SHA = 10;

export const shortSha = (sha: string): string => sha.slice(0, SHORT_SHA);

// What this run's passes are *for* (T66, collapsing the two arms T17 wrote),
// and the second half of the resume decision table T16 wrote (`resume.ts`).
// Two arms — a task stated as a file, or stated inline — and the spec's path
// rides on its own arm rather than beside the union, because it has no meaning
// on the other one: the mount, the plan banner, and the one-off identity all
// read it here.
//
// Whether the run is a **resume** is not on this union at all. That is a fact
// of the identity (`isResume` below), true of a spec resume and an inline one
// alike, and a framing keyed off the arm typechecks and is wrong on both
// (AGENTS.md).
export const Task = Schema.Union(
  // The ordinary run: the spec at `path` is the work, and `--feedback` — when
  // there is any — is extra dispatcher instructions appended to the implement,
  // review, and PR-description prompts (SPEC §7).
  Schema.TaggedStruct("Spec", { path: Schema.String, feedback: Schema.Option(Schema.String) }),
  // The task the dispatcher stated as text rather than as a file. One thing
  // reaches it today — a resume whose recorded spec is gone from disk, where
  // what the dispatcher said stands in as the task (`resume.ts`, chart row 6)
  // — and T67's `--task` reaches it from a fresh command line. The run mounts
  // no spec, because there is none: a bind on a path that is not there is a
  // directory docker invents in the client's repo (T7's ruling, from the other
  // side), and the text travels in its own section of all three messages
  // (`agent/prompt.ts`) rather than as the feedback it happened to arrive on.
  Schema.TaggedStruct("Inline", { text: Schema.String, feedback: Schema.Option(Schema.String) }),
  // The feature run (T73): the issues under `<folder>/issues/` this dispatch
  // named, read at the branch tip and selected before anything was held
  // (`guards.ts`). The folder is the **repo-relative** one `featureFolderFor`
  // resolved, because that is what the row and every message carry (14, lesson
  // 9), and the selection is T69's whole value — the request that produced it
  // and its issues in T69's order — so the run loop (T76), the PR checklist
  // (T79), and this plan's own block read one sequence rather than re-deriving
  // three. `--feedback` rides here as it does on the other two arms: it is
  // extra dispatcher instructions under whatever the task turned out to be.
  Schema.TaggedStruct("Feature", {
    folder: Schema.String,
    selection: IssueSelection,
    feedback: Schema.Option(Schema.String),
  }),
);
export type Task = Schema.Schema.Type<typeof Task>;

// The dispatcher's feedback, whichever arm the run took, for the passes that
// treat it the same way either way: it is appended as instructions under the
// task. On `Inline` that is `feedback` and never `text` — the text is the
// task, it travels as one, and the section that carries it is its own.
export const feedbackIn = (task: Task): Option.Option<string> => task.feedback;

// Whether this run resumes a branch, which is a fact of its **identity** and of
// nothing else (T66): true of every `FeedbackResume`, on the spec arm as much
// as the inline one, and false of every fresh dispatch. Two things read it —
// the implement message's resuming sentence (`agent/prompt.ts`) and the PR
// context the dispatch gathers for that message (`dispatch/feedback.ts`) — and
// they read this one spelling, so a prompt cannot carry the sentence on a run
// the forge was never asked about.
export const isResume = (identity: RunIdentity): boolean => identity._tag === "FeedbackResume";

// What an ordinary dispatch derives from the one path it resolved: the `Spec`
// arm, and the `OneOff` identity built from that same path. The pair is
// derived here, once, for the reason the five derivations at the bottom of this
// file are — so a caller cannot key the task off one path and the ledger row
// off another. A resume hands its own identity in instead (`dispatch.ts`).
export const specDispatch = (
  path: string,
  feedback: Option.Option<string> = Option.none(),
): { readonly task: Task; readonly identity: RunIdentity } => ({
  task: { _tag: "Spec", path, feedback },
  identity: { _tag: "OneOff", spec: path },
});

// What a dispatch whose task was stated on the command line derives from the
// one thing it was handed (T67): the `Inline` arm, and the identity that
// carries the text onto the ledger row so a `--resume` replays it. The pair is
// derived here beside `specDispatch` and for its reason — so a caller cannot
// key the passes off one text and the row off another.
//
// `feedback` is `none` rather than a parameter: `--feedback` beside `--task`
// is refused at the door (22 §6 row 12), because the task already says what to
// do and feedback is for a spec or a resume. The arm keeps the field, and a
// resume of this identity is where it is filled in (`dispatch.ts`).
export const inlineDispatch = (
  text: string,
): { readonly task: Task; readonly identity: RunIdentity } => ({
  task: { _tag: "Inline", text, feedback: Option.none() },
  identity: { _tag: "InlineTask", task: text },
});

// And what a feature dispatch derives from the folder it named and the
// selection the content guards resolved at the tip (T73), the pair derived
// here beside the two above for their reason — so a caller cannot key the
// passes off one folder and the row off another.
//
// The identity carries **no outcomes**: `issues: []`. They are the run's to
// fill (T76), and a plan decided before anything is held cannot know them —
// writing the selected ids in with a synthesized outcome would be a row
// claiming work that has not started.
export const featureDispatch = (
  folder: string,
  selection: IssueSelection,
  feedback: Option.Option<string> = Option.none(),
): { readonly task: Task; readonly identity: RunIdentity } => ({
  task: { _tag: "Feature", folder, selection, feedback },
  identity: { _tag: "Feature", feature: folder, issues: [] },
});

// And the same pair on a resume of a feature row (T78): the task is the
// recorded folder with the replayed selection, and the identity is the
// `FeedbackResume` wrapping a `Feature` that — like the fresh one above —
// carries no outcomes, because the run overlays its own onto the arm it wraps
// (`feature.ts`). `feedback` is this dispatch's; a resume never inherits it.
export const resumedFeatureDispatch = (
  folder: string,
  selection: IssueSelection,
  feedback: Option.Option<string>,
  resumedRunId: Option.Option<string>,
): { readonly task: Task; readonly identity: RunIdentity } => ({
  task: { _tag: "Feature", folder, selection, feedback },
  identity: {
    _tag: "FeedbackResume",
    resumed: { _tag: "Feature", feature: folder, issues: [] },
    resumedRunId,
  },
});

// About a line of a column, which is what both readers of a summary have room
// for.
export const TASK_SUMMARY_WIDTH = 40;

// A task stated inline, said in one short phrase: its first line, cut with an
// ellipsis when that line is longer than the width above. The whole text stays
// on the ledger row and in the run log — this is what a reader skims, never
// what a resume replays.
//
// **One function, two call sites** (T67): the plan banner below, and `status`'s
// source cell (`status/render.ts`). Two summaries that disagreed on how much of
// the text they show would read, on two screens describing one run, as two
// different tasks.
export const taskSummary = (text: string): string => {
  const [firstLine = ""] = text.split("\n");
  const first = firstLine.trim();
  return first.length <= TASK_SUMMARY_WIDTH ? first : `${first.slice(0, TASK_SUMMARY_WIDTH - 1)}…`;
};

// What the passes are for, said in one phrase for a human reading the plan
// block or the run log: the resolved path on the arm that has one, a summary
// of the text on the arm that does not, and the folder on the feature arm
// (T73) — quoted every time, because the banner is naming the same kind of
// fact in all three places. *Which* arm it is, and whether the run resumes, is
// the mode line's to say (`render.ts`).
export const taskNamed = (task: Task): string => {
  switch (task._tag) {
    case "Spec":
      return `'${task.path}'`;
    case "Inline":
      return `'${taskSummary(task.text)}'`;
    case "Feature":
      return `'${task.folder}'`;
  }
};

// What a `--hard-reset` dispatch decided in the guard phase (T101): the tip
// the branch is reset *from*, which is the compare-and-set's expected old value
// and what T104's row records; how many commits the reset and the leased push
// discard between them, counted once over the local tip and origin's; and
// where `origin/<b>` stood after the fetch, which is the lease's pin (D7) —
// `None` when origin had no such branch, so the lease expects it absent.
export const HardReset = Schema.Struct({
  discardedTip: Schema.String,
  discarding: Schema.Number,
  originTip: Schema.Option(Schema.String),
});
export type HardReset = Schema.Schema.Type<typeof HardReset>;

// The value the dispatch resolves to before the `Scope` opens (T4). It is a
// Schema struct rather than an interface because SPEC §5 makes every
// operation's return a `Schema`-defined domain value: the renderer is a pure
// function over this, and JSON for a future frontend is free.
export const DispatchPlan = Schema.Struct({
  // What the run's passes are for: a spec at the path on its arm, or the text
  // on the other (T66). Decided here with the rest of what a dispatch resolves
  // before it acquires anything, because the prompts are assembled from it and
  // `--dry-run` prints this plan rather than re-deriving one.
  //
  // There is no `spec` field beside it: a resolved path has no meaning on the
  // inline arm, so every reader that wants one — the mount, the banner, the
  // PR trailer — asks the arm and is answered or not.
  task: Task,
  // What this run *is*, and the identity its ledger row records: a `OneOff`
  // on an ordinary dispatch, and a `FeedbackResume` wrapping the recovered
  // one on a resume (T16). It is decided here, with the rest of what a
  // dispatch resolves before it acquires anything, because the row is written
  // from a finalizer that sees how the run ended and not what it was for.
  identity: RunIdentity,
  branch: Schema.String,
  // The `--base` value as given (`origin/master`) — the ref, which is what
  // the ledger records and what the next run's default chain reads back.
  baseRef: Schema.String,
  // What that ref resolved to for this run, and the diff boundary derived
  // from it: review, PR description, and commit counting all scope to the
  // merge-base, because the fork SHA is meaningless once branches pre-exist.
  baseSha: Schema.String,
  mergeBaseSha: Schema.String,
  // Where `--branch` stood when this dispatch was typed, resolved once in the
  // guard phase (T73). This is 15's **fork commit**: the checkout clones the
  // tip, so the tip is the ref whose content the agent sees (14) — which is
  // why the issue set is read at it and never at `baseSha`, the diff
  // boundary's other end (T70 §4). It is on the plan for **every** arm and not
  // only the feature one: the value exists for every dispatch, and T77 reads
  // it on the way out.
  tipSha: Schema.String,
  // Present only under `--hard-reset` (T101). `tipSha` and `mergeBaseSha`
  // are then both `baseSha` — the base is the effective tip (14, lesson 7) —
  // so the tip the guards read survives only here, as what the reset expects
  // to move the branch from. A `Schema.Option`, following `logPath` below.
  reset: Schema.Option(HardReset),
  slug: Schema.String,
  containerId: Schema.String,
  checkoutPath: Schema.String,
  // Absent on a rehearsal's plan (T48): `--dry-run` writes nothing to the
  // runtime root at all, and the log was the one write the tag swap did not
  // reach (AGENTS.md, narrowing T15). `Schema.Option`, not an empty string,
  // following the precedent `Task`'s `feedback` sets above.
  logPath: Schema.Option(Schema.String),
  // The run's id, minted once here from the slug and the clock read `planFor`
  // is handed — see `runIdFor` above for why this clock read is the one that
  // counts. `terminalRecord` reads this rather than deriving a second one.
  runId: Schema.String,
});
export type DispatchPlan = Schema.Schema.Type<typeof DispatchPlan>;

// The five derivations in one place, so a caller cannot key four of them off
// one slug and the fifth off another.
export const planFor = (fields: {
  readonly task: Task;
  // Decided with the task and handed in with it (T66): a fresh dispatch's is
  // the `OneOff` `specDispatch` builds from the arm's path, and a resume's is
  // the `FeedbackResume` wrapping what the ledger handed back. Required rather
  // than defaulted, because the inline arm has no path to build one from and a
  // default that invented one would be a row saying this branch is about a
  // file it was never dispatched for.
  readonly identity: RunIdentity;
  readonly branch: string;
  readonly baseRef: string;
  readonly baseSha: string;
  readonly mergeBaseSha: string;
  // The branch tip the guard phase read (T73). Required rather than defaulted:
  // there is no value to invent for it — a synthesized one would be a plan
  // naming a commit no ref stands on.
  readonly tipSha: string;
  // What a `--hard-reset` dispatch decided (T101); absent on every other.
  readonly reset?: Option.Option<HardReset>;
  readonly runtimeRoot: string;
  // The clock read the id is minted from — plan time, taken by the caller
  // immediately before this call so `planFor` itself stays pure (T46).
  readonly startedAt: DateTime.Utc;
  // Absent on a dispatch that keeps no log at all, which is a rehearsal's
  // whole `--dry-run` (T48). Defaults to `true`, which is every dispatch that
  // is not one; `dispatch/command.ts` is where the flag becomes this fact,
  // and this file only takes the answer.
  readonly keepsLog?: boolean;
}): DispatchPlan => {
  const slug = slugFor(fields.branch);
  const runId = runIdFor(slug, fields.startedAt);
  return {
    task: fields.task,
    identity: fields.identity,
    branch: fields.branch,
    baseRef: fields.baseRef,
    baseSha: fields.baseSha,
    mergeBaseSha: fields.mergeBaseSha,
    tipSha: fields.tipSha,
    reset: fields.reset ?? Option.none(),
    slug,
    containerId: containerIdFor(slug),
    checkoutPath: checkoutPathFor(fields.runtimeRoot, slug),
    logPath:
      (fields.keepsLog ?? true)
        ? Option.some(logPathFor(fields.runtimeRoot, runId))
        : Option.none(),
    runId,
  };
};
