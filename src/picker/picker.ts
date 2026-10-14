// The picker (T81, T82, T83, T85, SPEC §7's *no args on a TTY* row): which
// spec, feature, typed task, or run to resume, which branch, which issues,
// which base, and the command line that says so — everything the
// entrypoint's no-args arm does except the switch itself, because nothing in
// `bin.ts` is assertable (AGENTS.md).
//
// **What this produces is argv, never a plan.** bash's picker writes
// `key=value` lines into the same variables its flag loop sets
// (`run.sh:744-771`), and the port does the same by handing words to
// `dispatchCli`: every guard, the `--repo-root` peel, and `VALUE_OPTION_NAMES`
// are the ones a typed command line gets. A `DispatchRequest` built here would
// typecheck and would skip all three.
//
// The wizard is a list of steps and a summary that can re-run any of them
// (`DOWNSTREAM_STEPS`), and its back-navigation is a visible `← Back` **row**
// rather than a key (13): Esc and Ctrl-C are one sentinel,
// which is `PromptCancelled`, which ends the picker. What the rows say is
// 13's other accepted divergence — a branch the dispatch would refuse is
// shown **disabled** rather than picked and then refused.
//
// ADR 0005's carve-out letting a picker create a missing branch is
// deliberately unexercised (SPEC §12): `--branch` must already exist, the port
// has no creation path, and a host write before the lock is what matrix row 1
// forbids.
import { FileSystem, Terminal } from "@effect/platform";
import type { CommandExecutor } from "@effect/platform/CommandExecutor";
import { Clock, DateTime, Effect, Either, Option } from "effect";
import { SpeepoboxConfig } from "../config/config.ts";
import { resolveTasksDir } from "../config/paths.ts";
import {
  FEEDBACK_EDIT_PURPOSE,
  GuardRefused,
  isProtectedBranch,
  issueSetRefusal,
  noSuchBranch,
} from "../dispatch/guards.ts";
import { featureFolderFor } from "../dispatch/plan.ts";
import { Git, type GitError, type LocalBranch, type RefTip } from "../git/git.ts";
import { type Issue, compareIds, namesId, orderIssues, titleNamesIssue } from "../issues/issue.ts";
import { ISSUES_DIRECTORY, IssueStore } from "../issues/issue-store.ts";
import { select } from "../issues/selection.ts";
import { Ledger } from "../ledger/ledger.ts";
import type { RunRecord } from "../ledger/record.ts";
import { editFailed, editText } from "../prompt/editor.ts";
import { rankFuzzy } from "../prompt/fuzzy.ts";
import { Prompt, type PromptCancelled, type PromptRow } from "../prompt/prompt.ts";
import { ageCell, formatAge, outcomeCell, sourceCell } from "../status/render.ts";
import type { Seed } from "./seed.ts";

// The line a cancelled picker prints, and `tasklib.py`'s own
// (`run.sh:756` exits 1 on it). **Not 130**: clack holds raw mode while a
// prompt is open, so Ctrl-C arrives as the sentinel rather than as a signal,
// and the process was never signalled.
export const PICKER_CANCELLED = "picker cancelled";

// A cancel is a `GuardRefused` by the time it leaves this module, for
// `EditorCancelled`'s reason (`prompt/editor.ts`): it is a refusal about the
// dispatcher's own input, nothing is held when it arrives, and nothing may be
// held after it — SPEC §3 files a declined confirm under exactly that error.
// It also means the entrypoint renders it through `renderFailure` like every
// other refusal, which is what makes `!! picker cancelled` one line and one
// exit path rather than a second reporting shape.
export const pickerCancelled = (): GuardRefused => new GuardRefused({ detail: PICKER_CANCELLED });

// The row every step but the first opens with. A row and not a key, per 13.
export const BACK_LABEL = "← Back";

// How many rows a list shows at once. It bounds the **window** and not the
// ranking: `rankFuzzy` returns every in-order match with no floor and no cap
// (T80), because over a few hundred branches a two-letter query matches most
// of them and the order among the weak matches is noise — so what is bounded
// is how much of that order is on screen. A score floor would change what
// `rankFuzzy` means for every caller and belongs to that module, not here.
const ROWS_VISIBLE = 12;

// How far back the branch hints read. Wider than `status`' ten rows because
// this is a hint **per branch** rather than a screen of recent runs, and a few
// hundred rows is the whole file on any dispatcher's disk.
const LEDGER_WINDOW = 200;

const SPEC_SUFFIX = ".md";

const SOURCE_MESSAGE = "What should the run work on?";
const ISSUES_MESSAGE = "Which issues?";
const ISSUES_CHOOSE_MESSAGE = "Which of them?";
const ISSUES_TITLE = "issues";
const BRANCH_MESSAGE = "Which branch?";
const BASE_MESSAGE = "Which base?";
const SUMMARY_MESSAGE = "Dispatch this?";
const SUMMARY_TITLE = "speepobox";
const RESUME_MESSAGE = "Resume which run?";
const FEEDBACK_MESSAGE = "Add feedback?";

// How many runs the resume submenu offers: bash's `_latest_per_branch` cap.
const RESUME_ROWS = 10;

// The resume submenu's one row over an empty ledger — a dead end that says why
// and goes back to the source step, bash's rather than a disabled entry.
export const NO_RUNS_LABEL = "no runs recorded yet";

// What the task row's editor file is named for under the runtime root. The
// resume's feedback is `--feedback-edit`'s text and takes that flag's purpose.
const TASK_EDIT_PURPOSE = "task";

// What the branch step answers with: a branch by name, or the way back to the
// step before it.
//
// **Both arms are primitives, and that is load-bearing.** The rows are a
// getter, so clack rebuilds them on every keystroke and recovers the cursor by
// `===` against the value it last had focused (`@clack/core`'s `findCursor`
// over the restored list). A `{ _tag: "Branch", name }` allocated inside
// `branchRow` typechecks and is never the value it was a keystroke ago, so the
// recovery finds nothing and focus snaps to row 0 — `← Back`, at rest — on
// every edit. That silently costs the focus survival 13 measured on the
// prototype, whose rows carried `value: b.name`, and which SPEC §12 records as
// an accepted divergence from fzf. A symbol for the way back rather than a
// reserved name: no branch can be one, so the collision is unrepresentable
// rather than remembered.
export const BACK: unique symbol = Symbol("speepobox/picker/back");

export type BranchChoice = string | typeof BACK;

// What the base step answers with: a ref as typed or listed, or the way back.
export type BaseChoice = string | typeof BACK;

const HEADS = "refs/heads/";
const REMOTES = "refs/remotes/";

// A decision, or the step an `Edit` row re-runs from.
type SummaryChoice = "dispatch" | "back" | "abort" | StepName;

// One spec on disk: the bare name `<spec>` resolves under the tasks dir, and
// when the file was last written, which is what the list is ordered by.
export interface SpecEntry {
  readonly name: string;
  readonly modifiedAt: number;
}

// One feature folder on disk (T83): a directory under the tasks dir holding an
// `issues/` directory, by the bare name `--feature` resolves, and when its
// newest issue file was written.
//
// **A host listing, and a hint only.** No branch is chosen when this is read,
// so the host is the only source there is — and naming folders for a human to
// pick is not computing a work set (15). What the folder holds is read at the
// branch tip, in the issues step, and every refusal about it is T73's.
export type FeatureEntry = SpecEntry;

// The source step's answer for a feature row. A spec answers with its bare
// name; a feature cannot, since a folder and a spec may share one.
//
// An object, so **the rows are built once** (`pickerArgv`) rather than per
// ask: an edit re-runs the step with the previous choice as `initial`, which
// both clack and the fake find by `===` — `BACK`'s reason, for a select.
export interface FeatureSource {
  readonly _tag: "Feature";
  readonly folder: string;
}

// The source step's last two rows (T85), below the features and the specs:
// a task typed into the editor, and a run out of the ledger to resume. Each
// is one value built once, for `FeatureSource`'s reason; what either row
// goes on to ask is a sub-prompt of the source step, and its answer rides on
// the draft beside it.
export interface TaskSource {
  readonly _tag: "Task";
}

export interface ResumeSource {
  readonly _tag: "Resume";
}

export const TASK_LABEL = "Task typed inline";
export const RESUME_LABEL = "Resume a run";

const TASK_SOURCE: TaskSource = { _tag: "Task" };
const RESUME_SOURCE: ResumeSource = { _tag: "Resume" };

export const ENTRY_ROWS: ReadonlyArray<PromptRow<SourceChoice>> = [
  { value: TASK_SOURCE, label: TASK_LABEL },
  { value: RESUME_SOURCE, label: RESUME_LABEL },
];

export type SourceChoice = string | FeatureSource | TaskSource | ResumeSource;

// A typed task as it reaches the words: the text, verbatim.
export interface PickedTask {
  readonly task: string;
}

// A resume as it reaches the words: the branch the ledger row names, and the
// feedback the dispatcher wrote for it, if any. **No base and no issues**: the
// resume recovers both from its record (SPEC §7).
export interface PickedResume {
  readonly branch: string;
  readonly feedback: Option.Option<string>;
}

// `--issues all`: the **named predicate** (15), never the ids it expands to
// at this tip — the dispatch re-reads the set, and a picker that pinned the
// ids would be a second selection.
export const ALL_READY = "all";

// What the issues step decided: the predicate, or the ids a dispatcher ticked.
export type IssuesPick = typeof ALL_READY | ReadonlyArray<string>;

// A feature as it reaches the words: the folder the source step named and the
// issues the issues step picked.
export interface PickedFeature {
  readonly folder: string;
  readonly issues: IssuesPick;
}

// What the issues step's first ask answers with. `select` rather than going
// straight to a `multiselect` because that is what gives a multiselect a
// `← Back` (bash's `pick_issues` shape).
export type IssuesMenuChoice = typeof ALL_READY | "choose" | typeof BACK;

// Everything the branch rows are built out of, gathered once before the wizard
// opens: every local branch, which of them a worktree holds, what the ledger
// remembers about each, and the instant the ages are measured from.
export interface BranchWorld {
  readonly branches: ReadonlyArray<LocalBranch>;
  readonly checkedOut: ReadonlyArray<string>;
  readonly hints: ReadonlyMap<string, string>;
  readonly now: number;
}

export interface PickRequest {
  // The repo this invocation serves, resolved at the composition root as
  // every command's is (AGENTS.md): whose branches are listed and whose tasks
  // dir the specs come from.
  readonly repoRoot: string;
  // The words the entrypoint already had. An argv that is only a modifier
  // counts as no args (bash's rule, `run.sh:752`), and the modifier rides
  // through onto the words handed on and onto the command line the summary
  // prints. **This module never reads them** — which words are modifiers is
  // the entrypoint's question (`app.ts`), and the one modifier there is today
  // may not be named outside the four places `scripts/check-bans.ts` permits.
  readonly modifiers: ReadonlyArray<string>;
  // What a command line missing an answer already said (T86): every step it
  // answered is filled in and skipped on the first pass, and the flags that
  // are not steps ride into the words. Absent for a bare `speepobox`.
  readonly seed?: Seed;
}

// --- the pure half ---------------------------------------------------------

// Newest-modified first, and the name a dispatch would be typed with — bare,
// since `<spec>` resolves a bare name under the tasks dir (SPEC §7). Ties keep
// the order they arrived in, which is the directory's.
export const specRows = (specs: ReadonlyArray<SpecEntry>): ReadonlyArray<PromptRow<string>> =>
  specs
    .map((spec, index) => ({ spec, index }))
    .toSorted(
      (left, right) => right.spec.modifiedAt - left.spec.modifiedAt || left.index - right.index,
    )
    .map(({ spec }) => ({ value: spec.name, label: spec.name }));

export const featureLabel = (folder: string): string => `[feature] ${folder}`;

// The source step's rows (T83): one `[feature] <folder>` row per feature,
// newest first by its newest issue file and then by name (bash's
// `_feature_recency_key`), above the spec rows.
export const sourceRows = (
  features: ReadonlyArray<FeatureEntry>,
  specs: ReadonlyArray<SpecEntry>,
): ReadonlyArray<PromptRow<SourceChoice>> => [
  ...features
    .toSorted(
      (left, right) =>
        right.modifiedAt - left.modifiedAt ||
        (left.name < right.name ? -1 : left.name > right.name ? 1 : 0),
    )
    .map((feature) => ({
      value: { _tag: "Feature" as const, folder: feature.name },
      label: featureLabel(feature.name),
    })),
  ...specRows(specs),
];

// The source rows a seed leaves (T86): the ones the typed flags would not
// make the dispatch refuse. Typed `--issues` narrows a feature and nothing
// else. Typed `--branch` or `--base` cannot ride a resume, which takes both
// off its record. Typed feedback beside a typed task is two texts.
export const seededSourceRows = (
  rows: ReadonlyArray<PromptRow<SourceChoice>>,
  seed: Seed,
): ReadonlyArray<PromptRow<SourceChoice>> =>
  rows.filter(
    ({ value }) =>
      (Option.isNone(seed.issues) || isFeature(value)) &&
      ((Option.isNone(seed.branch) && Option.isNone(seed.base)) || !isResume(value)) &&
      (!seed.feedback || !isTask(value)),
  );

// A seeded branch the world does not hold (T96): the branch step lists only
// what is there, so a typed name missing from its list is one no step could
// offer, and it is refused before the first question in the words a typed
// dispatch uses. Existence only — a checked-out or protected branch is the
// dispatch's own guards' to refuse, after the picker.
export const seededBranchRefusal = (
  seed: Seed | undefined,
  world: BranchWorld,
): Option.Option<GuardRefused> =>
  Option.flatMap(
    Option.flatMap(Option.fromNullable(seed), ({ branch }) => branch),
    (branch) =>
      world.branches.some(({ name }) => name === branch)
        ? Option.none()
        : Option.some(noSuchBranch(branch)),
  );

// Why a branch cannot be dispatched onto, in the words the row wears. The
// order is the guards' own (`dispatch/guards.ts`): a protected branch is
// refused before the worktree question is asked, so a `main` that also happens
// to be checked out says the same thing here that a dispatch would say.
const blockedBecause = (name: string, checkedOut: ReadonlyArray<string>): Option.Option<string> =>
  isProtectedBranch(name)
    ? Option.some("PROTECTED")
    : checkedOut.includes(name)
      ? Option.some("CHECKED OUT")
      : Option.none();

// The age, and what the ledger remembers about this branch beside it.
const hintFor = (branch: LocalBranch, world: BranchWorld): string => {
  const age = formatAge((world.now - DateTime.toEpochMillis(branch.committedAt)) / 1000);
  const remembered = world.hints.get(branch.name);
  return remembered === undefined ? age : `${age} · ${remembered}`;
};

const branchRow = (branch: LocalBranch, world: BranchWorld): PromptRow<BranchChoice> => {
  const blocked = blockedBecause(branch.name, world.checkedOut);
  return {
    value: branch.name,
    label: Option.match(blocked, {
      onNone: () => branch.name,
      onSome: (reason) => `⛔ ${reason} — ${branch.name}`,
    }),
    hint: hintFor(branch, world),
    ...(Option.isSome(blocked) ? { disabled: true } : {}),
  };
};

// The branch list under one query. **At rest the order is recency**, newest
// first, with `← Back` at the top; while typing it is `rankFuzzy`'s order,
// and ties break toward recency because that scorer is stable and this is the
// order it is handed (13's at-rest ruling, T80's tie rule).
//
// Disabled rows rank and show like any other: they are what a dispatcher is
// looking at when they wonder why a branch is not offered, so hiding them
// would answer that question with silence.
export const branchRows = (
  query: string,
  world: BranchWorld,
): ReadonlyArray<PromptRow<BranchChoice>> => {
  const byRecency = world.branches.toSorted(
    (left, right) =>
      DateTime.toEpochMillis(right.committedAt) - DateTime.toEpochMillis(left.committedAt),
  );
  const rows = query === "" ? byRecency : rankFuzzy(query, byRecency, (branch) => branch.name);
  const ranked = rows.map((branch) => branchRow(branch, world));
  // The way back is offered at rest and not under a query: a query is a
  // search of the branches, and a row that matched nothing typed would be a
  // row that jumps to the top of every empty result.
  return query === "" ? [{ value: BACK, label: BACK_LABEL }, ...ranked] : ranked;
};

// What the ledger remembers about a branch: its **newest** row's outcome and
// PR number, which is what tells a run a dispatcher remembers from one they do
// not. A branch whose newest row carries neither gets no hint rather than a
// hint from an older row — the question is what happened last.
export const ledgerHints = (records: ReadonlyArray<RunRecord>): ReadonlyMap<string, string> => {
  const hints = new Map<string, string>();
  const seen = new Set<string>();
  // `recent` answers newest first, so the first row naming a branch is its
  // newest one.
  for (const record of records) {
    if (seen.has(record.branch)) {
      continue;
    }
    seen.add(record.branch);
    const parts = [
      ...Option.toArray(record.outcome),
      ...Option.toArray(
        Option.flatMap(record.pr, (pr) => Option.map(pr.number, (number) => `#${number}`)),
      ),
    ];
    if (parts.length > 0) {
      hints.set(record.branch, parts.join(" · "));
    }
  }
  return hints;
};

// One word of a command line a dispatcher can paste back (bash's copy-paste
// parity, `run.sh:48`). Bare where the shell would leave it alone, and single
// quoted otherwise — with the one escape single quotes have, closing the
// string and opening a new one around a literal quote.
export const shellWord = (word: string): string =>
  /^[\w.,/:=@-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;

export const commandLine = (argv: ReadonlyArray<string>): string =>
  ["speepobox", ...argv].map(shellWord).join(" ");

// The word `--issues` takes: the predicate by name, or the ids joined.
export const issuesWord = (issues: IssuesPick): string =>
  issues === ALL_READY ? ALL_READY : issues.join(",");

// The words a dispatch would have been typed as: the spec as a positional —
// or a feature's two flags (T83) — and the branch behind its flag, with
// whatever the entrypoint was already given after them.
//
// `--base` is there **only when the choice is not the chain default** (T82,
// bash's `BASE_EXPLICIT`): a run that took the default is the run a flag
// invocation without `--base` is, so it is recorded and echoed as one — and
// the dispatch resolves the same chain again rather than a ref this module
// pinned a moment before the fetch.
//
// A typed task is `--task` and its text as **one word** (T85), whatever it
// holds: argv carries it whole, and `commandLine` quotes it for the echo.
export const argvFor = (
  source: string | PickedFeature | PickedTask,
  branch: string,
  modifiers: ReadonlyArray<string>,
  base?: string,
): ReadonlyArray<string> => [
  ...(typeof source === "string"
    ? [source]
    : "task" in source
      ? ["--task", source.task]
      : ["--feature", source.folder, "--issues", issuesWord(source.issues)]),
  "--branch",
  branch,
  ...(base === undefined ? [] : ["--base", base]),
  ...modifiers,
];

// The block between the last step and the decision: what was chosen, and the
// command line that says it. The command line is the point — it is what a
// dispatcher copies when they want this run again without the wizard.
export const summaryNote = (
  source: string | PickedFeature | PickedTask,
  branch: string,
  argv: ReadonlyArray<string>,
  base?: string,
): string =>
  [
    ...(typeof source === "string"
      ? [`spec:   ${source}`]
      : "task" in source
        ? [`task:   ${source.task}`]
        : [`feature: ${source.folder}`, `issues: ${issuesWord(source.issues)}`]),
    `branch: ${branch}`,
    ...(base === undefined ? [] : [`base:   ${base}`]),
    "",
    commandLine(argv),
  ].join("\n");

// A resume's words (T85): the branch, and the feedback when there is some.
// **No `--branch` and no `--base`** — the resume recovers both from its record
// (SPEC §7), and a `--base` here would be one the resume arm overrides in
// silence.
export const resumeArgvFor = (
  resume: PickedResume,
  modifiers: ReadonlyArray<string>,
): ReadonlyArray<string> => [
  "--resume",
  resume.branch,
  ...Option.match(resume.feedback, {
    onNone: (): ReadonlyArray<string> => [],
    onSome: (text) => ["--feedback", text],
  }),
  ...modifiers,
];

export const resumeSummaryNote = (resume: PickedResume, argv: ReadonlyArray<string>): string =>
  [
    `resume: ${resume.branch}`,
    `feedback: ${Option.getOrElse(resume.feedback, () => "none")}`,
    "",
    commandLine(argv),
  ].join("\n");

// The newest record per branch, newest first, capped (bash's
// `_latest_per_branch`): `recent` answers newest first, so the first row
// naming a branch is its newest. A row with no branch names nothing to
// resume.
export const latestPerBranch = (
  records: ReadonlyArray<RunRecord>,
  limit: number = RESUME_ROWS,
): ReadonlyArray<RunRecord> => {
  const seen = new Set<string>();
  const latest: Array<RunRecord> = [];
  for (const record of records) {
    if (latest.length >= limit) {
      break;
    }
    if (record.branch !== "" && !seen.has(record.branch)) {
      seen.add(record.branch);
      latest.push(record);
    }
  }
  return latest;
};

// `<branch> — <source> <outcome> <age>`, through `status`' own cells, so a run
// reads here as it reads there and the two cannot drift (bash's
// `_resume_run_label` reuses its renderer for the same reason).
export const resumeLabel = (record: RunRecord, now: number): string =>
  `${record.branch} — ${sourceCell(record)} ${outcomeCell(record)} ${ageCell(record, now)}`;

// The resume submenu: one row per run, valued by its branch — deduplicated
// above, so a value is a row — then the way back. Over no runs, the one row
// that says so, and it goes back too.
export const resumeRows = (
  records: ReadonlyArray<RunRecord>,
  now: number,
): ReadonlyArray<PromptRow<BranchChoice>> =>
  records.length === 0
    ? [{ value: BACK, label: NO_RUNS_LABEL }]
    : [
        ...records.map((record) => ({ value: record.branch, label: resumeLabel(record, now) })),
        { value: BACK, label: BACK_LABEL },
      ];

// The base step's at-rest row: the chain default, which Enter takes.
export const defaultBaseLabel = (chain: string): string => `[default] ${chain}`;

// The row a query no ref matches is offered as, when git resolves it.
export const asIsBaseLabel = (query: string): string => `use '${query}' as-is`;

// Every ref name a base may be typed as: short names, local and
// remote-tracking alike (T82). Tags are not listed — they, SHAs, and
// `HEAD~1` are what the as-is row is for.
export const baseRefNames = (refs: ReadonlyArray<RefTip>): ReadonlyArray<string> =>
  refs.flatMap((ref) =>
    ref.name.startsWith(HEADS)
      ? [ref.name.slice(HEADS.length)]
      : ref.name.startsWith(REMOTES)
        ? [ref.name.slice(REMOTES.length)]
        : [],
  );

// The base list under one query. **Quiet until typed**: at rest it is the way
// back and the chain default, nothing else — the step most often left at its
// default is the one that should cost a single Enter. Typing ranks every ref
// name, and neither of the at-rest rows is in a result, for the branch
// step's reason. The values are the ref names themselves, primitives, for the
// focus reason `BACK` spells out.
export const baseRows = (
  query: string,
  refs: ReadonlyArray<string>,
  chain: string,
): ReadonlyArray<PromptRow<BaseChoice>> =>
  query === ""
    ? [
        { value: BACK, label: BACK_LABEL },
        { value: chain, label: defaultBaseLabel(chain) },
      ]
    : rankFuzzy(query, refs, (name) => name).map((name) => ({ value: name, label: name }));

// The ids `--issues all` would select at this tip, in T69's order — or none,
// when the predicate selects nothing (or refuses), and there is then no
// `All ready` row to offer.
export const readyIds = (
  issues: ReadonlyArray<Issue>,
  folder: string,
): Option.Option<ReadonlyArray<string>> =>
  Either.match(select(issues, { _tag: "All" }, folder), {
    onLeft: () => Option.none(),
    onRight: (selection) => Option.some(selection.issues.map((issue) => issue.id)),
  });

export const allReadyLabel = (ids: ReadonlyArray<string>): string =>
  `All ready (${ids.length}): ${ids.join(", ")}`;

export const CHOOSE_LABEL = "Choose…";

// The issues step's first ask: the predicate when it answers a set, the way
// into the list, and the way back.
export const issuesMenuRows = (
  ready: Option.Option<ReadonlyArray<string>>,
): ReadonlyArray<PromptRow<IssuesMenuChoice>> => {
  const always: ReadonlyArray<PromptRow<IssuesMenuChoice>> = [
    { value: "choose", label: CHOOSE_LABEL },
    { value: BACK, label: BACK_LABEL },
  ];
  return Option.match(ready, {
    onNone: () => always,
    onSome: (ids) => [{ value: ALL_READY, label: allReadyLabel(ids) }, ...always],
  });
};

const statusText = (issue: Issue): string =>
  typeof issue.status === "string" ? issue.status : issue.status.text;

// Every issue in `orderIssues`' order — the order a run would take them in.
// A folder whose blockers form a cycle has no such order, and is listed by id
// instead: the list is still what a dispatcher picks from, and the cycle is
// T73's to refuse if they pick into it.
export const issueOrder = (issues: ReadonlyArray<Issue>): ReadonlyArray<Issue> =>
  Either.getOrElse(orderIssues(issues), () =>
    issues.toSorted((left, right) => compareIds(left.id, right.id)),
  );

// One row per issue, valued by id. The hint is the status, the type, and the
// blockers not yet done on this ref — what decides whether the row can run.
// `done` and `HITL` rows are disabled, 13's divergence again: T73 refuses
// both when named, so they are shown and unpickable rather than picked and
// then refused.
export const issueRows = (issues: ReadonlyArray<Issue>): ReadonlyArray<PromptRow<string>> =>
  issueOrder(issues).map((issue) => {
    const unmet = issue.blockers.filter(
      (blocker) => issues.find((other) => namesId(blocker.id, other.id))?.status !== "done",
    );
    return {
      value: issue.id,
      label: titleNamesIssue(issue) ? issue.title : `${issue.id} — ${issue.title}`,
      hint: [
        statusText(issue),
        issue.type,
        ...(unmet.length === 0
          ? []
          : [`blocked by ${unmet.map((blocker) => blocker.token).join(", ")}`]),
      ].join(" · "),
      ...(issue.status === "done" || issue.type === "HITL" ? { disabled: true } : {}),
    };
  });

// Whether `Choose…` has anything to tick. With every row disabled it would open
// a required multiselect only Esc leaves, and Esc cancels the whole picker —
// the dead end 13's back-navigation rule forbids.
export const anyPickable = (rows: ReadonlyArray<PromptRow<string>>): boolean =>
  rows.some((row) => row.disabled !== true);

// What the issues step says instead of asking, on its way back to the branch.
export const nothingPickableNote = (folder: string, branch: string): string =>
  `every issue in ${folder} on branch '${branch}' is Done or HITL — nothing there can be picked`;

// --- the steps -------------------------------------------------------------

// The wizard's steps in the order they run. SPEC §7 binds only branch before
// issues; base is a function of the branch, so it goes last. *issues* runs
// when the source is a feature row (T83), and a step that does not apply is
// skipped wherever it would have run.
export type StepName = "source" | "branch" | "issues" | "base";

export const STEP_ORDER: ReadonlyArray<StepName> = ["source", "branch", "issues", "base"];

// What an edit re-runs after the edited step, in order: every step whose
// input derives from it (T82, bash's `_DOWNSTREAM_STEPS`). Data rather than a
// branch per step, so T83 adds an edge rather than re-authoring the graph.
export const DOWNSTREAM_STEPS: Readonly<Record<StepName, ReadonlyArray<StepName>>> = {
  source: ["branch", "issues", "base"],
  branch: ["issues", "base"],
  issues: [],
  base: [],
};

// A step and everything derived from it: what an edit runs, and what `← Back`
// runs from the step before the one it was chosen on.
export const stepsFrom = (step: StepName): ReadonlyArray<StepName> => [
  step,
  ...DOWNSTREAM_STEPS[step],
];

// --- the world -------------------------------------------------------------

// Every `*.md` under the tasks dir, as a name and a modification time. The
// tasks dir is a **host** read (`FileSystem`, SPEC §7): a spec is inert and
// mounts from the host, so this is the same directory a bare `<spec>` resolves
// against and the same one `doctor`'s probe 8 reports on.
const readSpecs = (
  tasksDir: string,
): Effect.Effect<ReadonlyArray<SpecEntry>, GuardRefused, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const names = yield* fs.readDirectory(tasksDir);
    const entries = yield* Effect.forEach(
      names.filter((name) => name.endsWith(SPEC_SUFFIX)),
      (name) =>
        fs.stat(`${tasksDir}/${name}`).pipe(
          Effect.map((info) => ({
            name: name.slice(0, -SPEC_SUFFIX.length),
            type: info.type,
            // A filesystem that answers no mtime sorts oldest rather than
            // dropping the spec: the list is what can be dispatched, and the
            // order is a convenience on top of it.
            modifiedAt: Option.match(info.mtime, {
              onNone: () => 0,
              onSome: (mtime) => mtime.getTime(),
            }),
          })),
        ),
    );
    return entries.filter((entry) => entry.type === "File");
  }).pipe(
    // An unreadable tasks dir is a refusal at the door like a missing spec is
    // — one line, nothing held, and the dispatcher's next move is to fix the
    // path `doctor` names.
    Effect.mapError(
      (error) =>
        new GuardRefused({ detail: `tasks dir '${tasksDir}' cannot be read: ${error.message}` }),
    ),
  );

// Every directory under the tasks dir that holds an `issues/` directory, and
// the newest write among the files in it (T83). A host read and a hint only —
// see `FeatureEntry` — so it degrades rather than refuses: a folder whose
// `issues/` cannot be listed is not offered, and a file that cannot be stat'ed
// counts as oldest. `readSpecs` has already refused a tasks dir that cannot be
// read at all.
const readFeatures = (
  tasksDir: string,
): Effect.Effect<ReadonlyArray<FeatureEntry>, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const modifiedAt = (path: string): Effect.Effect<Option.Option<number>> =>
      fs.stat(path).pipe(
        Effect.map((info) =>
          info.type === "File"
            ? Option.some(
                Option.match(info.mtime, { onNone: () => 0, onSome: (at) => at.getTime() }),
              )
            : Option.none(),
        ),
        Effect.orElseSucceed(() => Option.none<number>()),
      );
    const names = yield* fs
      .readDirectory(tasksDir)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    const found = yield* Effect.forEach(names, (name) => {
      const issuesDir = `${tasksDir}/${name}/${ISSUES_DIRECTORY}`;
      return fs.readDirectory(issuesDir).pipe(
        Effect.flatMap((files) =>
          Effect.forEach(files, (file) => modifiedAt(`${issuesDir}/${file}`)),
        ),
        Effect.map((times) =>
          Option.some({ name, modifiedAt: Math.max(0, ...times.flatMap(Option.toArray)) }),
        ),
        Effect.orElseSucceed(() => Option.none<FeatureEntry>()),
      );
    });
    return found.flatMap(Option.toArray);
  });

const readBranchWorld = (repoRoot: string): Effect.Effect<BranchWorld, GitError, Git | Ledger> =>
  Effect.gen(function* () {
    const git = yield* Git;
    const ledger = yield* Ledger;
    const branches = yield* git.branches({ repo: repoRoot });
    // The guard's own source (T5): git refuses a fetch into a branch checked
    // out in **any** worktree of the repo, so the list is every worktree's and
    // not this one's HEAD.
    const worktrees = yield* git.worktrees(repoRoot);
    // The ledger is derived state (SPEC §10), so a ledger that cannot be read
    // costs the hints and nothing else — the branch list is git's answer and
    // stands on its own.
    const records = yield* ledger
      .recent(LEDGER_WINDOW)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<RunRecord> => []));
    return {
      branches,
      checkedOut: worktrees.flatMap((worktree) => Option.toArray(worktree.branch)),
      hints: ledgerHints(records),
      now: yield* Clock.currentTimeMillis,
    };
  });

// --- the wizard ------------------------------------------------------------

const EDIT_LABELS: Readonly<Record<StepName, string>> = {
  source: "Edit source",
  branch: "Edit branch",
  issues: "Edit issues",
  base: "Edit base",
};

// The decision, then one `Edit` row per step that ran, then the way back and
// the abort — `Dispatch` first, because it is the row the cursor starts on.
const summaryRows = (steps: ReadonlyArray<StepName>): ReadonlyArray<PromptRow<SummaryChoice>> => [
  { value: "dispatch", label: "Dispatch" },
  ...steps.map((step) => ({ value: step, label: EDIT_LABELS[step] })),
  { value: "back", label: BACK_LABEL },
  { value: "abort", label: "Abort" },
];

// Whether a step runs at all, given what has been chosen so far: *issues*
// runs whenever the source is a feature (T83), and every other step always —
// except on a resume (T85), which is the source step and nothing after it.
// **A resume asks no branch, issues, or base**: the resume recovers its branch
// and its base from the record (SPEC §7), and a base asked here would reach
// the words as a `--base` the resume arm overrides in silence.
const applies =
  (draft: Draft) =>
  (step: StepName): boolean =>
    step === "source" ||
    (!isResume(draft.source) && (step !== "issues" || isFeature(draft.source)));

const isFeature = (source: SourceChoice | undefined): source is FeatureSource =>
  typeof source === "object" && source._tag === "Feature";

const isTask = (source: SourceChoice | undefined): source is TaskSource =>
  typeof source === "object" && source._tag === "Task";

const isResume = (source: SourceChoice | undefined): source is ResumeSource =>
  typeof source === "object" && source._tag === "Resume";

// The step `← Back` re-enters from `step`: the nearest one before it that
// runs. The source step offers no way back, so it is never asked this.
const stepBefore = (step: StepName, draft: Draft): StepName =>
  STEP_ORDER.slice(0, STEP_ORDER.indexOf(step)).findLast(applies(draft)) ?? "source";

// The last step that runs, which is the one the summary's `← Back` re-enters.
const lastStep = (draft: Draft): StepName => STEP_ORDER.findLast(applies(draft)) ?? "base";

// What the steps have chosen so far. Every field a step that ran fills is
// filled by the time the summary is shown — the first pass runs every step —
// so a missing one there is this module's invariant broken, not an outcome.
interface Draft {
  readonly source?: SourceChoice;
  // Only a typed task's: what the source step's editor handed back.
  readonly task?: string;
  // Only a resume's: the run the source step's submenu chose, and its
  // feedback.
  readonly resumed?: PickedResume;
  readonly branch?: string;
  // Only a feature's, and only once the issues step has run at this branch's
  // tip.
  readonly issues?: IssuesPick;
  readonly base?: string;
  // The chain default the base was chosen against, which is what decides
  // whether the argv says `--base` at all.
  readonly defaultBase?: string;
  // A `--base` the dispatcher typed (T86). It stays in the words whatever
  // the chain would pick, until the base step runs and chooses again.
  readonly baseTyped?: boolean;
}

// The draft a seed starts the wizard on, and which steps it answered. A
// feature seed is the row for that folder when the list has one, so an edit
// finds it by `===`. A spec or a folder with no row still reaches the words
// as typed.
const seededDraft = (
  seed: Seed | undefined,
  rows: ReadonlyArray<PromptRow<SourceChoice>>,
): { readonly draft: Draft; readonly answered: ReadonlyArray<StepName> } => {
  if (seed === undefined) {
    return { draft: {}, answered: [] };
  }
  const source: Draft = Option.match(seed.source, {
    onNone: () => ({}),
    onSome: (typed): Draft => {
      switch (typed._tag) {
        case "Spec":
          return { source: typed.spec };
        case "Task":
          return { source: TASK_SOURCE, task: typed.task };
        case "Feature":
          return {
            source: rows.find((row) => isFeature(row.value) && row.value.folder === typed.folder)
              ?.value ?? { _tag: "Feature", folder: typed.folder },
          };
      }
    },
  });
  return {
    draft: {
      ...source,
      ...Option.match(seed.branch, { onNone: () => ({}), onSome: (branch) => ({ branch }) }),
      ...Option.match(seed.issues, { onNone: () => ({}), onSome: (issues) => ({ issues }) }),
      ...Option.match(seed.base, {
        onNone: () => ({}),
        onSome: (base) => ({ base, baseTyped: true }),
      }),
    },
    answered: [
      ...(Option.isSome(seed.source) ? (["source"] as const) : []),
      ...(Option.isSome(seed.branch) ? (["branch"] as const) : []),
      ...(Option.isSome(seed.issues) ? (["issues"] as const) : []),
      ...(Option.isSome(seed.base) ? (["base"] as const) : []),
    ],
  };
};

// What the summary shows and what `Dispatch` hands on.
interface Settled {
  readonly argv: ReadonlyArray<string>;
  readonly note: string;
}

const unanswered = Effect.die("picker: the summary was reached with a step unanswered");

const settled = (draft: Draft, modifiers: ReadonlyArray<string>): Effect.Effect<Settled> => {
  const { source, task, resumed, branch, issues, base, defaultBase, baseTyped } = draft;
  if (isResume(source)) {
    if (resumed === undefined) {
      return unanswered;
    }
    const argv = resumeArgvFor(resumed, modifiers);
    return Effect.succeed({ argv, note: resumeSummaryNote(resumed, argv) });
  }
  if (
    source === undefined ||
    branch === undefined ||
    base === undefined ||
    (baseTyped !== true && defaultBase === undefined)
  ) {
    return unanswered;
  }
  const picked: string | PickedFeature | PickedTask | undefined = isFeature(source)
    ? issues === undefined
      ? undefined
      : { folder: source.folder, issues }
    : isTask(source)
      ? task === undefined
        ? undefined
        : { task }
      : source;
  if (picked === undefined) {
    return unanswered;
  }
  const explicitBase = baseTyped !== true && base === defaultBase ? undefined : base;
  const argv = argvFor(picked, branch, modifiers, explicitBase);
  return Effect.succeed({
    argv,
    note: summaryNote(picked, branch, argv, explicitBase ?? defaultBaseLabel(base)),
  });
};

const needs = <A>(value: A | undefined, what: string): Effect.Effect<A> =>
  value === undefined
    ? Effect.die(`picker: the ${what} step ran before its input`)
    : Effect.succeed(value);

// The picker, and what it picked. `None` is **nobody is there**: no prompt is
// asked, and what the entrypoint does with that is what this invocation did
// before the picker existed — usage for a bare `speepobox`, the dispatch's own
// refusal for an argv of nothing but modifiers. The gate lives here rather
// than in the switch for the reason every step does: nothing in `bin.ts` is
// assertable, and "off a terminal it asks nothing" is a property worth
// asserting.
//
// `Terminal.isTTY` is the gate, and the composition root answers it from both
// stdin and stdout (T94), as bash's `[ -t 0 ]` answers from stdin. It is the
// same question `--feedback-edit` asks (T84), answered by the same tag, which
// is already stubbed in three test files.
export const pickerArgv = (
  request: PickRequest,
): Effect.Effect<
  Option.Option<ReadonlyArray<string>>,
  GuardRefused | GitError,
  | Prompt
  | Git
  | IssueStore
  | Ledger
  | SpeepoboxConfig
  | Terminal.Terminal
  | FileSystem.FileSystem
  | CommandExecutor
> =>
  Effect.gen(function* () {
    const terminal = yield* Terminal.Terminal;
    if (!(yield* terminal.isTTY)) {
      return Option.none<ReadonlyArray<string>>();
    }
    const config = yield* SpeepoboxConfig;
    const prompt = yield* Prompt;
    const git = yield* Git;
    const store = yield* IssueStore;
    const ledger = yield* Ledger;
    const tasksDir = resolveTasksDir(request.repoRoot, config.tasksDir);
    const specs = yield* readSpecs(tasksDir);
    const features = yield* readFeatures(tasksDir);
    // A list with nothing in it is a refusal rather than an empty prompt: the
    // dispatcher's next move is to write a spec or to type a path, and
    // neither is something a list of no rows can say.
    if (
      specs.length === 0 &&
      features.length === 0 &&
      (request.seed === undefined || Option.isNone(request.seed.source))
    ) {
      return yield* new GuardRefused({
        detail: `no specs under '${tasksDir}' — write one there, or dispatch a path`,
      });
    }
    // Built once, so an edited source step finds its previous choice among
    // them by `===` (`FeatureSource`) — the task and resume rows below the
    // rest (T85).
    const listed = [...sourceRows(features, specs), ...ENTRY_ROWS];
    // Filtered once, too, so the rows stay the same objects (T86).
    const sources = request.seed === undefined ? listed : seededSourceRows(listed, request.seed);
    // And the same refusal after the filter: typed `--issues` keeps only the
    // feature rows, and a tasks dir holding specs alone leaves none of them
    // to ask from. A seed that named its source asks no source step.
    if (sources.length === 0 && request.seed !== undefined && Option.isNone(request.seed.source)) {
      return yield* new GuardRefused({
        detail: `no features under '${tasksDir}' — --issues narrows a feature's issues; write one there, or pass --feature <folder>`,
      });
    }
    const seeded = seededDraft(request.seed, sources);
    // The words after the steps': the flags a seed carried that are not
    // steps, then the entrypoint's modifiers.
    const tail = [...(request.seed?.words ?? []), ...request.modifiers];
    // Read once, before the first question: the steps loop over each other,
    // and a world re-read on every `← Back` would spend git processes and a
    // ledger read to redraw a list nothing has changed under.
    const world = yield* readBranchWorld(request.repoRoot);
    const refused = seededBranchRefusal(request.seed, world);
    if (Option.isSome(refused)) {
      return yield* refused.value;
    }
    const refs = baseRefNames(yield* git.forEachRef({ repo: request.repoRoot }));

    // SPEC §7's `--base` chain for one branch: its last recorded base, then
    // the configured one — the chain the dispatch resolves when no `--base`
    // is given, so the row that says `[default]` is the ref it would take.
    // The ledger is derived state (SPEC §10): unreadable, the chain is the
    // configured base, as it is for the dispatch.
    const chainFor = (branch: string): Effect.Effect<string> =>
      ledger.lastBaseForBranch(branch).pipe(
        Effect.orElseSucceed(() => Option.none<string>()),
        Effect.map(Option.getOrElse(() => config.base)),
      );

    // Whether a query no ref matches names a commit — a SHA, `HEAD~1`, a tag
    // (bash's rule). A question and not a pin: the run's `BASE_SHA` is still
    // taken once, post-fetch, by the guard (T70), through the same peel.
    const resolves = (query: string): Effect.Effect<boolean> =>
      git.revParse({ repo: request.repoRoot, rev: `${query}^{commit}` }).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );

    type StepOutcome = Effect.Effect<
      Draft | typeof BACK,
      PromptCancelled | GitError | GuardRefused
    >;

    // The editor bracket (T84), for the source step's two rows that type
    // (T85): one flow, not two (22). The editor's own services are taken here
    // so a step stays an ask over the world this function already read.
    // `None` is `EditorCancelled` — nothing came back — which each caller
    // reads its own way; every other way the bracket ends is the refusal it
    // is for `--feedback-edit`, in the same words.
    const editorContext = yield* Effect.context<Git | FileSystem.FileSystem | CommandExecutor>();
    const edited = (edit: {
      readonly purpose: string;
      readonly header: ReadonlyArray<string>;
      readonly what: string;
      readonly empty: string;
    }): Effect.Effect<Option.Option<string>, GuardRefused> =>
      Effect.scoped(
        editText({ repo: request.repoRoot, runtimeRoot: config.runtimeRoot, ...edit }),
      ).pipe(
        Effect.map(Option.some),
        Effect.catchTag("EditorCancelled", () => Effect.succeed(Option.none<string>())),
        Effect.mapError(
          (error) => new GuardRefused({ detail: `${edit.what}: ${editFailed(error)}` }),
        ),
        Effect.provide(editorContext),
      );

    // The task row: the editor, and its text verbatim. Nothing back is a
    // sub-prompt's cancel — the source step again, bash's rule for exactly
    // this entry — and not the picker's one sentinel.
    const typedTask = edited({
      purpose: TASK_EDIT_PURPOSE,
      header: [
        "the task the passes are for — what a spec file would have said",
        "recorded verbatim on the ledger row, so --resume replays it",
      ],
      what: "task",
      empty: "returns to the picker's first step",
    });

    // The resume row: the ledger's newest run per branch, then whether to
    // add feedback. `None` is the way back to the source step — `← Back`, or
    // a ledger with nothing to offer. The feedback's empty result is **no
    // feedback**, not a cancel: bash's one deliberate exception
    // (`pick_resume`), since a chosen run has no natural way back.
    const resumeRun: Effect.Effect<
      Option.Option<PickedResume>,
      PromptCancelled | GuardRefused
    > = Effect.gen(function* () {
      const read = yield* Effect.either(ledger.recent(LEDGER_WINDOW));
      const now = yield* Clock.currentTimeMillis;
      const choice = yield* prompt.select<BranchChoice>({
        message: RESUME_MESSAGE,
        // An unreadable ledger is the empty one's dead end with the reason
        // on it: a resume *is* a ledger read, so there is nothing to offer.
        rows: Either.match(read, {
          onLeft: (error) => [{ value: BACK, label: `ledger unavailable: ${error.detail}` }],
          onRight: (records) => resumeRows(latestPerBranch(records), now),
        }),
        maxItems: ROWS_VISIBLE,
      });
      if (choice === BACK) {
        return Option.none();
      }
      // Feedback typed on the command line already rides in the words (T86),
      // so a resume picked beside it asks for no second one.
      const wanted =
        request.seed?.feedback !== true &&
        (yield* prompt.confirm({ message: FEEDBACK_MESSAGE, initial: false }));
      const feedback = wanted
        ? yield* edited({
            purpose: FEEDBACK_EDIT_PURPOSE,
            header: [`feedback for '${choice}'`],
            what: "feedback",
            empty: "means no feedback",
          })
        : Option.none<string>();
      return Option.some({ branch: choice, feedback });
    });

    // The first step, so no `← Back`: there is nothing behind it but the shell
    // the dispatcher typed in, and Esc from here is the abort. Re-run by an
    // edit, the cursor starts on the source it chose last time. The task and
    // resume rows ask on inside it, and their way back is this list again.
    const sourceStep = (draft: Draft): StepOutcome =>
      Effect.gen(function* () {
        while (true) {
          const source = yield* prompt.select({
            message: SOURCE_MESSAGE,
            rows: sources,
            maxItems: ROWS_VISIBLE,
            ...(draft.source === undefined ? {} : { initial: draft.source }),
          });
          if (isTask(source)) {
            const task = yield* typedTask;
            if (Option.isSome(task)) {
              return { ...draft, source, task: task.value };
            }
          } else if (isResume(source)) {
            const resumed = yield* resumeRun;
            if (Option.isSome(resumed)) {
              return { ...draft, source, resumed: resumed.value };
            }
          } else {
            return { ...draft, source };
          }
        }
      });

    // 13's shape and not bash's curated two-tier menu: one list of every local
    // branch, ranked as it is typed into.
    const branchStep = (draft: Draft): StepOutcome =>
      prompt
        .autocomplete({
          message: BRANCH_MESSAGE,
          rows: (query) => branchRows(query, world),
          maxItems: ROWS_VISIBLE,
          ...(draft.branch === undefined ? {} : { initial: draft.branch }),
        })
        .pipe(Effect.map((choice) => (choice === BACK ? BACK : { ...draft, branch: choice })));

    // **Branch before issues** (SPEC §2): the frontier is a function of the
    // tip, so the folder is read there — the tip resolved once, as T73's guard
    // resolves it, and the set through `IssueStore`, never off the host tree.
    // Re-run by any edit upstream of it, so a new branch is a new read.
    //
    // A folder the tip does not carry, or a file there that does not parse,
    // is T73's sentence shown here and the branch step again: the folder is
    // not on that branch, and a branch is what the dispatcher can change from
    // this screen. A folder with nothing to pick there goes back the same way.
    // Git failing outright is git's own line and ends the picker, as it does
    // before the first question.
    const issuesStep = (draft: Draft): StepOutcome =>
      Effect.gen(function* () {
        const branch = yield* needs(draft.branch, "issues");
        const source = draft.source;
        if (!isFeature(source)) {
          return yield* Effect.die("picker: the issues step ran for a source that is no feature");
        }
        const folder = featureFolderFor(request.repoRoot, tasksDir, source.folder);
        const tip = yield* git.revParse({ repo: request.repoRoot, rev: `refs/heads/${branch}` });
        const read = yield* Effect.either(
          store.issues({ repo: request.repoRoot, ref: tip, folder }),
        );
        if (Either.isLeft(read)) {
          if (read.left._tag === "GitError") {
            return yield* read.left;
          }
          yield* prompt.note({
            message: issueSetRefusal(read.left, { branch, tipSha: tip, folder }).detail,
            title: ISSUES_TITLE,
          });
          return BACK;
        }
        const issues = read.right;
        const rows = issueRows(issues);
        if (!anyPickable(rows)) {
          yield* prompt.note({ message: nothingPickableNote(folder, branch), title: ISSUES_TITLE });
          return BACK;
        }
        const ready = readyIds(issues, folder);
        const menu = yield* prompt.select<IssuesMenuChoice>({
          message: ISSUES_MESSAGE,
          rows: issuesMenuRows(ready),
          maxItems: ROWS_VISIBLE,
          ...(draft.issues === undefined
            ? {}
            : { initial: draft.issues === ALL_READY ? ALL_READY : "choose" }),
        });
        if (menu === BACK) {
          return BACK;
        }
        if (menu === ALL_READY) {
          return { ...draft, issues: ALL_READY };
        }
        const chosen = yield* prompt.multiselect({
          message: ISSUES_CHOOSE_MESSAGE,
          rows,
          selected: Option.getOrElse(ready, (): ReadonlyArray<string> => []),
          required: true,
          maxItems: ROWS_VISIBLE,
        });
        // In the list's order, whatever order they were ticked in.
        return {
          ...draft,
          issues: rows.flatMap((row) => (chosen.includes(row.value) ? [row.value] : [])),
        };
      });

    // Quiet until typed, and Enter is the chain default — which is also the
    // row an edit starts on: a base chosen against another branch's chain is
    // not a choice this branch has made.
    const baseStep = (draft: Draft): StepOutcome =>
      Effect.gen(function* () {
        const branch = yield* needs(draft.branch, "base");
        const chain = yield* chainFor(branch);
        const choice = yield* prompt.autocomplete<BaseChoice>({
          message: BASE_MESSAGE,
          rows: (query) => baseRows(query, refs, chain),
          initial: chain,
          asIs: {
            row: (query) => ({ value: query, label: asIsBaseLabel(query) }),
            accepts: resolves,
          },
          maxItems: ROWS_VISIBLE,
        });
        return choice === BACK
          ? BACK
          : { ...draft, base: choice, defaultBase: chain, baseTyped: false };
      });

    const runStep = (step: StepName, draft: Draft): StepOutcome => {
      switch (step) {
        case "source":
          return sourceStep(draft);
        case "branch":
          return branchStep(draft);
        case "issues":
          return issuesStep(draft);
        case "base":
          return baseStep(draft);
      }
    };

    // Runs `first` and everything derived from it, in order. `← Back` on a
    // step re-enters the one before it and runs forward from there again, up
    // to where this pass was going — the same rule on every step, the
    // summary's included.
    //
    // `answered` is the steps a seed filled in (T86), skipped until the first
    // `← Back`: from there on, T82's rules re-run a step whatever answered it.
    const runFrom = (
      first: StepName,
      start: Draft,
      answered: ReadonlyArray<StepName> = [],
    ): Effect.Effect<Draft, PromptCancelled | GitError | GuardRefused> =>
      Effect.gen(function* () {
        let plan = stepsFrom(first);
        let draft = start;
        let skipped = answered;
        let at = 0;
        while (at < plan.length) {
          const step = plan[at] ?? first;
          at += 1;
          if (!applies(draft)(step) || skipped.includes(step)) {
            continue;
          }
          const outcome = yield* runStep(step, draft);
          if (outcome === BACK) {
            // Everything derived from the step re-entered, and still every
            // step this pass had left: *issues* derives nothing, so going
            // back into it from the base must not drop the base (T83).
            const rest = plan.slice(at - 1);
            const again = stepsFrom(stepBefore(step, draft));
            plan = STEP_ORDER.filter((name) => again.includes(name) || rest.includes(name));
            skipped = [];
            at = 0;
          } else {
            draft = outcome;
          }
        }
        return draft;
      });

    const wizard: Effect.Effect<
      ReadonlyArray<string>,
      GuardRefused | PromptCancelled | GitError
    > = Effect.gen(function* () {
      let draft = yield* runFrom("source", seeded.draft, seeded.answered);
      while (true) {
        const { argv, note } = yield* settled(draft, tail);
        yield* prompt.note({ message: note, title: SUMMARY_TITLE });
        const choice = yield* prompt.select({
          message: SUMMARY_MESSAGE,
          rows: summaryRows(STEP_ORDER.filter(applies(draft))),
          maxItems: ROWS_VISIBLE,
        });
        switch (choice) {
          case "dispatch":
            return argv;
          case "abort":
            return yield* pickerCancelled();
          case "back":
            draft = yield* runFrom(lastStep(draft), draft);
            break;
          default:
            draft = yield* runFrom(choice, draft);
        }
      }
    });

    // Esc or Ctrl-C at any step is the same cancel as at the first — inside
    // an edit too, not bash's "back to the summary" — one sentinel (13), one
    // line, one exit code.
    return Option.some(
      yield* wizard.pipe(Effect.catchTag("PromptCancelled", () => pickerCancelled())),
    );
  });
