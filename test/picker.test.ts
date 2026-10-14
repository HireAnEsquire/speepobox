// The picker (T81): what the wizard asks, in what order, with which rows —
// and that what comes out of it is **argv**, the words a dispatch would have
// been typed as, rather than a plan built in place.
//
// Every case drives the `Prompt` tag through a scripted fake, which is how a
// wizard is assertable at all (`support/prompt-fake.ts`). The branch rows are
// built by a pure function beside it, so ranking under a query — the one
// thing a script answering at rest cannot show — is asserted directly.
import { describe, expect, it } from "@effect/vitest";
import { FileSystem, Terminal } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { DateTime, Effect, Either, Layer, Option, Ref, type Scope, TestClock } from "effect";
import { appCompositionFor, appDryRunLiveFor, modifiersFor } from "../src/app.ts";
import { BessemerConfig, type BessemerConfigShape, defaultConfig } from "../src/config/config.ts";
import type { DispatchRequest } from "../src/dispatch/dispatch.ts";
import { AnswerMissing, type GuardRefused, issueSetRefusal } from "../src/dispatch/guards.ts";
import { renderFailure } from "../src/dispatch/render.ts";
import type { GitError, LocalBranch, RefTip } from "../src/git/git.ts";
import { FolderAbsent } from "../src/issues/issue-store.ts";
import { Ledger, LedgerError } from "../src/ledger/ledger.ts";
import { CURRENT_SCHEMA_VERSION, type RunRecord } from "../src/ledger/record.ts";
import {
  ALL_READY,
  allReadyLabel,
  argvFor,
  asIsBaseLabel,
  BACK,
  BACK_LABEL,
  baseRefNames,
  baseRows,
  type BranchWorld,
  branchRows,
  anyPickable,
  CHOOSE_LABEL,
  defaultBaseLabel,
  DOWNSTREAM_STEPS,
  commandLine,
  featureLabel,
  issueRows,
  issuesMenuRows,
  latestPerBranch,
  ledgerHints,
  NO_RUNS_LABEL,
  nothingPickableNote,
  PICKER_CANCELLED,
  pickerArgv,
  readyIds,
  RESUME_LABEL,
  shellWord,
  sourceRows,
  specRows,
  summaryNote,
  TASK_LABEL,
} from "../src/picker/picker.ts";
import { type Seed, seedFor, seedOf } from "../src/picker/seed.ts";
import { type ScriptedResult, scriptedExecutor } from "./support/exec-fake.ts";
import { fakeGit, type GitCall, PRE_TIP } from "./support/git-fake.ts";
import {
  fakeIssue,
  fakeIssueStore,
  type FakeIssueStoreOptions,
  type IssueStoreCall,
} from "./support/issue-store-fake.ts";
import {
  type AskedQuestion,
  CANCEL,
  ENTER,
  type ScriptedAnswer,
  scriptedPrompt,
  typed,
} from "./support/prompt-fake.ts";

const SPEC = "T3";
const BRANCH = "bessemer-t3";
const NOW = 1_759_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

// A branch whose tip was committed `days` ago, by the clock the world is read
// at — so every age in a row is a value this file wrote rather than one the
// machine running the test happened to have.
const branchAt = (name: string, days: number): LocalBranch => ({
  name,
  committedAt: DateTime.unsafeMake(NOW - days * DAY),
});

const BRANCHES: ReadonlyArray<LocalBranch> = [
  branchAt("main", 1),
  branchAt(BRANCH, 2),
  branchAt("bessemer-t80", 9),
];

// The branch the dispatcher is standing on, which git would refuse a fetch
// into — the guard's own question (T5), and here a disabled row.
const CHECKED_OUT = "bessemer-t81";

const WORLD: BranchWorld = {
  branches: [...BRANCHES, branchAt(CHECKED_OUT, 3)],
  checkedOut: [CHECKED_OUT],
  hints: new Map([[BRANCH, "needs-work · #37"]]),
  now: NOW,
};

// The configured `base`, the chain's last link (SPEC §7).
const CONFIG_BASE = "origin/master";

// The refs the base step types against: a local branch and two remote-tracking
// ones, full names as git lists them, and a tag — which the list leaves out.
const REFS: ReadonlyArray<RefTip> = [
  { name: `refs/heads/${BRANCH}`, sha: "1".repeat(40) },
  { name: "refs/remotes/origin/master", sha: "2".repeat(40) },
  { name: "refs/remotes/origin/release-2", sha: "3".repeat(40) },
  { name: "refs/tags/v1.0", sha: "4".repeat(40) },
];

// A ledger row, cut down to the three fields a hint is built from: the branch
// it names, what the review decided, and the PR it opened.
const ledgerRow = (branch: string, outcome: string, pr: number | null): RunRecord =>
  ({
    branch,
    outcome: Option.some(outcome),
    pr: pr === null ? Option.none() : Option.some({ number: Option.some(pr), url: "u" }),
  }) as RunRecord;

// The `Terminal` the picker gates on. Every other read dies: the one question
// this asks is *is anyone there*, and a picker that read the terminal itself
// would be reading stdin behind clack's back.
const terminalOf = (isTTY: boolean): Terminal.Terminal => ({
  columns: Effect.succeed(80),
  rows: Effect.succeed(24),
  isTTY: Effect.succeed(isTTY),
  readInput: Effect.die("the picker prompts through the Prompt tag, never the terminal"),
  readLine: Effect.die("the picker prompts through the Prompt tag, never the terminal"),
  display: () => Effect.void,
});

interface PickOptions {
  readonly answers: ReadonlyArray<ScriptedAnswer>;
  readonly isTTY?: boolean;
  // The spec files the tasks dir holds, oldest **first**: the list is ordered
  // by modification time, so a case writes them in the order they were
  // written and asserts the reverse.
  readonly specs?: ReadonlyArray<string>;
  readonly branches?: ReadonlyArray<LocalBranch>;
  // git refusing to list them at all — a repository this package cannot read,
  // which is the picker's other refusal and travels as git's own line.
  readonly branchesFails?: string;
  readonly worktreeBranch?: string;
  // What the ledger answers, newest first, or a ledger that cannot be read at
  // all — derived state, so the hints go and the list stays.
  readonly records?: Either.Either<ReadonlyArray<RunRecord>, LedgerError>;
  readonly modifiers?: ReadonlyArray<string>;
  readonly config?: Partial<BessemerConfigShape>;
  // The base each branch's newest ledger row recorded (T82); a branch absent
  // here has none, and the chain falls through to the configured `base`.
  readonly lastBases?: Readonly<Record<string, string>>;
  // Every ref `for-each-ref` lists, and the commit expressions `revParse`
  // resolves beyond them.
  readonly refs?: ReadonlyArray<RefTip>;
  readonly resolvable?: ReadonlyArray<string>;
  // Feature folders under the tasks dir, each with an `issues/` holding one
  // file per id — on the **host**, which is what the source step lists (T83).
  // Oldest first, as `specs` are.
  readonly features?: ReadonlyArray<string>;
  // What the fake `IssueStore` answers at each tip: the issues step's read,
  // which never touches the host files above.
  readonly issues?: FakeIssueStoreOptions;
  // The editor the task and resume rows open (T85), scripted as the one
  // `sh -c` child the bracket spawns. Absent, no case opens one.
  readonly editor?: ScriptedResult;
  // What a command line missing an answer already said (T86).
  readonly seed?: Seed;
}

interface Picked {
  // The picker's two refusals, as the entrypoint sees them: a `GuardRefused`
  // — the cancel among them — and git failing to answer at all.
  readonly outcome: Either.Either<Option.Option<ReadonlyArray<string>>, GuardRefused | GitError>;
  readonly asked: ReadonlyArray<AskedQuestion>;
  readonly gitCalls: ReadonlyArray<GitCall>;
  readonly issueCalls: ReadonlyArray<IssueStoreCall>;
  readonly runtimeRoot: string;
}

// One pass through the picker over a scratch repo: a tasks dir holding real
// files (their modification times are what the first step orders by, so they
// have to be files), a fake git, a scripted ledger, and the script.
const pick = (
  options: PickOptions,
): Effect.Effect<Picked, never, FileSystem.FileSystem | Scope.Scope> =>
  Effect.gen(function* () {
    // The clock every age in a row is measured against. It is set rather than
    // read, for the reason every host read is resolved at the composition
    // root (AGENTS.md): an age taken from the machine running the test would
    // make "2d ago" a fact about when this file was written.
    yield* TestClock.setTime(NOW);
    const fs = yield* FileSystem.FileSystem;
    const repoRoot = yield* fs.makeTempDirectoryScoped();
    // Deliberately apart from the repo root: a cancelled picker leaves nothing
    // *anywhere*, and the runtime root is where a run would have written.
    const runtimeRoot = yield* fs.makeTempDirectoryScoped();
    yield* fs.makeDirectory(`${repoRoot}/tasks`);
    const specs = options.specs ?? [SPEC];
    for (const [index, spec] of specs.entries()) {
      const path = `${repoRoot}/tasks/${spec}.md`;
      yield* fs.writeFileString(path, `# ${spec}\n`);
      // Written oldest first, an hour apart, so "newest-modified first" is a
      // fact about these files rather than about how fast a test machine
      // writes three of them.
      yield* fs.utimes(path, new Date(NOW), new Date(NOW - (specs.length - index) * 3_600_000));
    }
    // A directory whose name ends in `.md`, which is not a spec: the list is
    // files, and a `stat` is what says so.
    yield* fs.makeDirectory(`${repoRoot}/tasks/drafts.md`);
    // And a directory with no `issues/` in it, which is not a feature.
    yield* fs.makeDirectory(`${repoRoot}/tasks/notes`);
    for (const [index, feature] of (options.features ?? []).entries()) {
      const path = `${repoRoot}/tasks/${feature}/issues/T1-a-thing.md`;
      yield* fs.makeDirectory(`${repoRoot}/tasks/${feature}/issues`, { recursive: true });
      yield* fs.writeFileString(path, "# T1\n");
      yield* fs.utimes(path, new Date(NOW), new Date(NOW - (10 - index) * 3_600_000));
    }

    const asked = yield* Ref.make<ReadonlyArray<AskedQuestion>>([]);
    const gitCalls = yield* Ref.make<ReadonlyArray<GitCall>>([]);
    const issueCalls = yield* Ref.make<ReadonlyArray<IssueStoreCall>>([]);
    const records = options.records ?? Either.right<ReadonlyArray<RunRecord>>([]);
    const ledger = Layer.succeed(Ledger, {
      append: () => Effect.die("the picker appends nothing"),
      recent: () =>
        Either.match(records, {
          onLeft: (error) => Effect.fail(error),
          onRight: (rows) => Effect.succeed(rows),
        }),
      lastBaseForBranch: (branch) =>
        Effect.succeed(Option.fromNullable(options.lastBases?.[branch])),
      resolveResume: () => Effect.die("the picker resumes nothing — T85 does"),
      newestBranchForIssue: () => Effect.die("the picker selects no issues — T83 does"),
    });

    const outcome = yield* Effect.either(
      pickerArgv({
        repoRoot,
        modifiers: options.modifiers ?? [],
        ...(options.seed === undefined ? {} : { seed: options.seed }),
      }),
    ).pipe(
      Effect.provide(
        Layer.provideMerge(
          Layer.mergeAll(
            scriptedPrompt(options.answers, asked),
            fakeGit(gitCalls, {
              branches: options.branches ?? BRANCHES,
              refs: options.refs ?? REFS,
              ...(options.resolvable === undefined ? {} : { resolvable: options.resolvable }),
              ...(options.branchesFails === undefined
                ? {}
                : { branchesFails: options.branchesFails }),
              ...(options.worktreeBranch === undefined
                ? {}
                : {
                    worktrees: [{ path: repoRoot, branch: Option.some(options.worktreeBranch) }],
                  }),
            }),
            ledger,
            fakeIssueStore(issueCalls, options.issues),
            // Over `NodeContext`, so the scripted editor wins the executor
            // tag rather than the dispatcher's own editor opening from a test.
            ...(options.editor === undefined
              ? []
              : [scriptedExecutor({ "sh -c": options.editor })]),
            Layer.succeed(BessemerConfig, {
              ...defaultConfig,
              runtimeRoot,
              base: CONFIG_BASE,
              ...options.config,
            }),
            // On a TTY unless a case says otherwise: the picker is the one
            // surface that needs one.
            Layer.succeed(Terminal.Terminal, terminalOf(options.isTTY ?? true)),
          ),
          NodeContext.layer,
        ),
      ),
    );

    return {
      outcome,
      asked: yield* Ref.get(asked),
      gitCalls: yield* Ref.get(gitCalls),
      issueCalls: yield* Ref.get(issueCalls),
      runtimeRoot,
    };
  }).pipe(Effect.orDie);

const answered = (result: Picked): ReadonlyArray<string> => {
  expect(Either.isRight(result.outcome)).toBe(true);
  if (Either.isLeft(result.outcome)) {
    throw new Error(`the picker refused: ${result.outcome.left.detail}`);
  }
  expect(Option.isSome(result.outcome.right)).toBe(true);
  return Option.getOrElse(result.outcome.right, (): ReadonlyArray<string> => []);
};

describe("the rows", () => {
  it("offers every spec newest-modified first, under the name a dispatch takes", () => {
    expect(
      specRows([
        { name: "T80", modifiedAt: 10 },
        { name: "T3", modifiedAt: 30 },
        { name: "T84", modifiedAt: 20 },
      ]),
    ).toEqual([
      { value: "T3", label: "T3" },
      { value: "T84", label: "T84" },
      { value: "T80", label: "T80" },
    ]);
  });

  it("puts the way back first at rest, then every branch by recency", () => {
    expect(branchRows("", WORLD).map((row) => row.label)).toEqual([
      BACK_LABEL,
      "⛔ PROTECTED — main",
      BRANCH,
      `⛔ CHECKED OUT — ${CHECKED_OUT}`,
      "bessemer-t80",
    ]);
  });

  // 13's accepted divergence: shown and unpickable, never pickable and then
  // refused. The reason is the guards' own, in their order — a `main` that is
  // also checked out reads as protected, which is what a dispatch would say.
  it("disables the protected branches and the ones a worktree holds", () => {
    const rows = branchRows("", WORLD);
    expect(rows.filter((row) => row.disabled === true).map((row) => row.label)).toEqual([
      "⛔ PROTECTED — main",
      `⛔ CHECKED OUT — ${CHECKED_OUT}`,
    ]);
    // Every row that is not blocked carries no `disabled` key at all, so a
    // list is read the way clack reads it.
    expect(rows.filter((row) => row.label === BRANCH)[0]?.disabled).toBeUndefined();
  });

  it("ages every row, and says what the ledger remembers about the branch", () => {
    const rows = branchRows("", WORLD);
    expect(rows.find((row) => row.label === BRANCH)?.hint).toBe("2d ago · needs-work · #37");
    expect(rows.find((row) => row.label === "bessemer-t80")?.hint).toBe("9d ago");
  });

  // The marquee case (13): `tsf` finds `tseff` in fzf and finds **nothing**
  // under clack's substring default. It ranks here, and the way back is not
  // in a result — a row whose label matched nothing typed would top every
  // empty search.
  it("ranks under a query rather than filtering, and drops the way back", () => {
    const world: BranchWorld = {
      branches: [branchAt("tseff", 1), branchAt("the-summer-fix", 2)],
      checkedOut: [],
      hints: new Map(),
      now: NOW,
    };
    expect(branchRows("tsf", world).map((row) => row.label)).toEqual(["tseff", "the-summer-fix"]);
    expect(branchRows("tsf", world).some((row) => row.label === BACK_LABEL)).toBe(false);
    // Every in-order match, no floor and no cap (T80): the window is
    // `maxItems`' job, and a scorer that dropped the weak matches would
    // change what ranking means for every caller.
    expect(branchRows("e", world)).toHaveLength(2);
  });

  // The rows are a getter, so clack rebuilds them on every keystroke and finds
  // the row it had focused by `===` on its value (`@clack/core`'s cursor
  // recovery). A value allocated per call is never the one focused a keystroke
  // ago, and focus would snap to row 0 — `← Back`, at rest — on every edit,
  // costing the focus survival SPEC §12 records. `toBe` is the assertion: a
  // structural comparison passes on freshly built objects, which is exactly
  // the shape this forbids.
  it("answers with values a rebuilt list still recognises", () => {
    const first = branchRows("", WORLD);
    const again = branchRows("", WORLD);

    expect(again).toHaveLength(first.length);
    for (const [index, row] of first.entries()) {
      expect(again[index]?.value).toBe(row.value);
    }
    // A branch answers with its own name, which is what `--branch` takes, and
    // the way back with a symbol no branch name can collide with.
    expect(first.map((row) => row.value)).toEqual([
      BACK,
      "main",
      BRANCH,
      CHECKED_OUT,
      "bessemer-t80",
    ]);
  });

  it("takes each branch's newest row for the hint, and nothing older", () => {
    const hints = ledgerHints([
      ledgerRow(BRANCH, "approved", 37),
      ledgerRow(BRANCH, "needs-work", 12),
      ledgerRow("bessemer-t80", "approved", null),
    ]);
    expect(hints.get(BRANCH)).toBe("approved · #37");
    // A PR the row never opened is absent from the hint rather than empty.
    expect(hints.get("bessemer-t80")).toBe("approved");
  });
});

describe("the command line", () => {
  it("is the words a dispatch would have been typed as", () => {
    expect(argvFor(SPEC, BRANCH, [])).toEqual([SPEC, "--branch", BRANCH]);
    expect(commandLine(argvFor(SPEC, BRANCH, []))).toBe(`bessemer ${SPEC} --branch ${BRANCH}`);
  });

  // bash's copy-paste parity (`run.sh:48`): what is printed is what pastes
  // back, which for anything the shell would take apart means quoting it.
  it("quotes a word the shell would not leave alone", () => {
    expect(shellWord("feature/a")).toBe("feature/a");
    expect(shellWord("two words")).toBe("'two words'");
    // POSIX's one escape: close the quoted string, hand the shell an
    // escaped quote, and open a new one.
    expect(shellWord("it's")).toBe("'it'\\''s'");
  });
});

describe("the wizard", () => {
  it.scoped("hands on the words a dispatch would have been typed with", () =>
    Effect.gen(function* () {
      const result = yield* pick({
        answers: [SPEC, BRANCH, ENTER, "Dispatch"],
        worktreeBranch: CHECKED_OUT,
        branches: [...BRANCHES, branchAt(CHECKED_OUT, 3)],
        records: Either.right([ledgerRow(BRANCH, "needs-work", 37)]),
      });

      expect(answered(result)).toEqual([SPEC, "--branch", BRANCH]);

      // Four questions and the note between the last two, in order.
      expect(result.asked.map((question) => question.kind)).toEqual([
        "select",
        "autocomplete",
        "autocomplete",
        "note",
        "select",
      ]);
      // The branch step's rows as a dispatcher would see them: recency, with
      // the worktree's branch and the protected name disabled.
      expect(result.asked[1]?.rows).toEqual([
        { label: BACK_LABEL },
        { label: "⛔ PROTECTED — main", hint: "1d ago", disabled: true },
        { label: BRANCH, hint: "2d ago · needs-work · #37" },
        { label: `⛔ CHECKED OUT — ${CHECKED_OUT}`, hint: "3d ago", disabled: true },
        { label: "bessemer-t80", hint: "9d ago" },
      ]);
      // And the summary carried the command line those words spell.
      expect(result.asked[3]?.message).toContain(`bessemer ${SPEC} --branch ${BRANCH}`);
      expect(result.asked[4]?.rows.map((row) => row.label)).toEqual([
        "Dispatch",
        "Edit source",
        "Edit branch",
        "Edit base",
        BACK_LABEL,
        "Abort",
      ]);
      // One git process per list read, and the repo named on each (T27).
      expect(result.gitCalls).toEqual([
        { _tag: "Branches", repo: expect.any(String) },
        { _tag: "ForEachRef", repo: expect.any(String) },
      ]);
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("lists every spec newest first, and no directory", () =>
    Effect.gen(function* () {
      const result = yield* pick({
        specs: ["T80", "T84", SPEC],
        answers: [SPEC, BRANCH, ENTER, "Dispatch"],
      });

      expect(result.asked[0]?.rows.map((row) => row.label)).toEqual([
        SPEC,
        "T84",
        "T80",
        TASK_LABEL,
        RESUME_LABEL,
      ]);
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  // The modifier the entrypoint was already given rides through — onto the
  // words handed on, and onto the command line the summary prints.
  it.scoped("carries the entrypoint's own words into the argv and the summary", () =>
    Effect.gen(function* () {
      const result = yield* pick({
        answers: [SPEC, BRANCH, ENTER, "Dispatch"],
        modifiers: ["--dry-run"],
      });

      expect(answered(result)).toEqual([SPEC, "--branch", BRANCH, "--dry-run"]);
      expect(result.asked[3]?.message).toContain(`bessemer ${SPEC} --branch ${BRANCH} --dry-run`);
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("goes back a step, and asks the step before it again", () =>
    Effect.gen(function* () {
      const result = yield* pick({
        // Branch, back to the spec step, again; then the summary, back to the
        // base step — the last one that ran (T82) — and through.
        answers: [SPEC, BACK_LABEL, "T80", BRANCH, ENTER, BACK_LABEL, ENTER, "Dispatch"],
        specs: ["T80", SPEC],
      });

      expect(answered(result)).toEqual(["T80", "--branch", BRANCH]);
      expect(result.asked.map((question) => question.message)).toEqual([
        "What should the run work on?",
        "Which branch?",
        "What should the run work on?",
        "Which branch?",
        "Which base?",
        expect.any(String),
        "Dispatch this?",
        "Which base?",
        expect.any(String),
        "Dispatch this?",
      ]);
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  // The ledger is derived state (SPEC §10): an unreadable one costs the hints
  // and nothing else.
  it.scoped("still lists the branches when the ledger cannot be read", () =>
    Effect.gen(function* () {
      const result = yield* pick({
        answers: [SPEC, BRANCH, ENTER, "Dispatch"],
        records: Either.left(new LedgerError({ detail: "runs.jsonl: EACCES" })),
      });

      expect(answered(result)).toEqual([SPEC, "--branch", BRANCH]);
      expect(result.asked[1]?.rows.find((row) => row.label === BRANCH)?.hint).toBe("2d ago");
    }).pipe(Effect.provide(NodeContext.layer)),
  );
});

describe("the base step", () => {
  // Quiet until typed: the way back and the chain default, and nothing else.
  it("offers the way back and the chain default at rest, and ranks refs under a query", () => {
    const refs = baseRefNames(REFS);

    // Short names, local and remote-tracking alike; the tag is not listed.
    expect(refs).toEqual([BRANCH, "origin/master", "origin/release-2"]);
    expect(baseRows("", refs, CONFIG_BASE)).toEqual([
      { value: BACK, label: BACK_LABEL },
      { value: CONFIG_BASE, label: defaultBaseLabel(CONFIG_BASE) },
    ]);
    expect(baseRows("rel", refs, CONFIG_BASE).map((row) => row.label)).toEqual([
      "origin/release-2",
    ]);
    expect(baseRows("zzz", refs, CONFIG_BASE)).toEqual([]);
  });

  it("puts --base in the words only when one is given", () => {
    expect(argvFor(SPEC, BRANCH, ["--dry-run"], "origin/dev")).toEqual([
      SPEC,
      "--branch",
      BRANCH,
      "--base",
      "origin/dev",
      "--dry-run",
    ]);
  });

  it.scoped("takes the ledger's last base on Enter, and says no --base", () =>
    Effect.gen(function* () {
      const result = yield* pick({
        answers: [SPEC, BRANCH, ENTER, "Dispatch"],
        lastBases: { [BRANCH]: "origin/release-2" },
      });

      expect(answered(result)).toEqual([SPEC, "--branch", BRANCH]);
      const base = result.asked[2];
      expect(base?.message).toBe("Which base?");
      expect(base?.rows).toEqual([
        { label: BACK_LABEL },
        { label: defaultBaseLabel("origin/release-2") },
      ]);
      expect(base?.initial).toBe(defaultBaseLabel("origin/release-2"));
      expect(result.asked[3]?.message).toContain("base:   [default] origin/release-2");
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("falls back to the configured base when the ledger has no row", () =>
    Effect.gen(function* () {
      const result = yield* pick({
        answers: [SPEC, BRANCH, ENTER, "Dispatch"],
        lastBases: { "bessemer-t80": "origin/release-2" },
      });

      expect(answered(result)).toEqual([SPEC, "--branch", BRANCH]);
      expect(result.asked[2]?.rows).toEqual([
        { label: BACK_LABEL },
        { label: defaultBaseLabel(CONFIG_BASE) },
      ]);
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("hands on a typed ref the list carries as --base", () =>
    Effect.gen(function* () {
      const result = yield* pick({
        answers: [SPEC, BRANCH, typed("rel", "origin/release-2"), "Dispatch"],
      });

      expect(answered(result)).toEqual([SPEC, "--branch", BRANCH, "--base", "origin/release-2"]);
      expect(result.asked[3]?.message).toContain(
        `bessemer ${SPEC} --branch ${BRANCH} --base origin/release-2`,
      );
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("takes a SHA no ref carries as-is when git resolves it", () =>
    Effect.gen(function* () {
      const sha = "abc1234";
      const result = yield* pick({
        answers: [SPEC, BRANCH, typed(sha, asIsBaseLabel(sha)), "Dispatch"],
        resolvable: [sha],
      });

      expect(answered(result)).toEqual([SPEC, "--branch", BRANCH, "--base", sha]);
      expect(result.asked[2]?.rows).toEqual([{ label: asIsBaseLabel(sha) }]);
      expect(result.gitCalls).toContainEqual({
        _tag: "RevParse",
        repo: expect.any(String),
        rev: `${sha}^{commit}`,
      });
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("does not offer a query git refuses", () =>
    Effect.gen(function* () {
      const result = yield* pick({
        answers: [SPEC, BRANCH, typed("deadbeef", CANCEL)],
        resolvable: ["abc1234"],
      });

      // The list under that query was empty: no ref matched, and the as-is
      // row was not offered, because git refused it.
      expect(result.asked[2]?.query).toBe("deadbeef");
      expect(result.asked[2]?.rows).toEqual([]);
      expect(result.gitCalls).toContainEqual({
        _tag: "RevParse",
        repo: expect.any(String),
        rev: "deadbeef^{commit}",
      });
    }).pipe(Effect.provide(NodeContext.layer)),
  );
});

describe("the summary's edit rows", () => {
  it("re-runs every step derived from the edited one, as data", () => {
    expect(DOWNSTREAM_STEPS).toEqual({
      source: ["branch", "issues", "base"],
      branch: ["issues", "base"],
      issues: [],
      base: [],
    });
  });

  it.scoped("re-runs the branch step and then the base step on Edit branch", () =>
    Effect.gen(function* () {
      const result = yield* pick({
        answers: [SPEC, BRANCH, ENTER, "Edit branch", "bessemer-t80", ENTER, "Dispatch"],
        lastBases: { "bessemer-t80": "origin/release-2" },
      });

      expect(answered(result)).toEqual([SPEC, "--branch", "bessemer-t80"]);
      expect(result.asked.map((question) => question.message)).toEqual([
        "What should the run work on?",
        "Which branch?",
        "Which base?",
        expect.any(String),
        "Dispatch this?",
        "Which branch?",
        "Which base?",
        expect.any(String),
        "Dispatch this?",
      ]);
      // Pre-answered with the previous choice, and the base re-derived from
      // the new branch's chain.
      expect(result.asked[5]?.initial).toBe(BRANCH);
      expect(result.asked[6]?.initial).toBe(defaultBaseLabel("origin/release-2"));
      expect(result.asked[7]?.message).toContain("branch: bessemer-t80");
      expect(result.asked[7]?.message).toContain("base:   [default] origin/release-2");
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("re-runs only the base step on Edit base", () =>
    Effect.gen(function* () {
      const result = yield* pick({
        answers: [SPEC, BRANCH, ENTER, "Edit base", typed("rel", ENTER), "Dispatch"],
      });

      expect(answered(result)).toEqual([SPEC, "--branch", BRANCH, "--base", "origin/release-2"]);
      expect(result.asked.map((question) => question.message)).toEqual([
        "What should the run work on?",
        "Which branch?",
        "Which base?",
        expect.any(String),
        "Dispatch this?",
        "Which base?",
        expect.any(String),
        "Dispatch this?",
      ]);
      expect(result.asked[6]?.message).toContain("base:   origin/release-2");
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("re-runs every step on Edit source, starting on the spec it chose", () =>
    Effect.gen(function* () {
      const result = yield* pick({
        answers: [SPEC, BRANCH, ENTER, "Edit source", ENTER, ENTER, ENTER, "Dispatch"],
      });

      expect(answered(result)).toEqual([SPEC, "--branch", BRANCH]);
      expect(result.asked[5]?.initial).toBe(SPEC);
      expect(result.asked.filter((question) => question.kind !== "note")).toHaveLength(8);
    }).pipe(Effect.provide(NodeContext.layer)),
  );
});

describe("off a TTY", () => {
  // As today: usage, and **no prompt asked** — which is only an assertion
  // because the gate is in this module rather than in the switch that prints
  // the usage text.
  it.scoped("asks nothing and leaves the entrypoint to print usage", () =>
    Effect.gen(function* () {
      const result = yield* pick({ answers: [], isTTY: false });

      expect(result.outcome).toEqual(Either.right(Option.none()));
      expect(result.asked).toEqual([]);
      expect(result.gitCalls).toEqual([]);
    }).pipe(Effect.provide(NodeContext.layer)),
  );
});

describe("cancel", () => {
  const cancelledAt = (answers: ReadonlyArray<ScriptedAnswer>) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const result = yield* pick({ answers });

      expect(Either.isLeft(result.outcome)).toBe(true);
      if (Either.isLeft(result.outcome)) {
        expect(result.outcome.left._tag).toBe("GuardRefused");
        expect(result.outcome.left.detail).toBe(PICKER_CANCELLED);
        // One line on stderr, through the same renderer every other refusal
        // goes through — and an exit 1, not a 130: clack holds raw mode, so
        // Ctrl-C arrived as the sentinel and nothing was signalled.
        expect(renderFailure(result.outcome.left)).toEqual(Option.some(`!! ${PICKER_CANCELLED}`));
      }
      // Nothing under the runtime root: a cancelled picker holds nothing,
      // writes nothing, and never reaches a dispatch.
      expect(yield* fs.readDirectory(result.runtimeRoot).pipe(Effect.orDie)).toEqual([]);
    }).pipe(Effect.provide(NodeContext.layer));

  it.scoped("refuses on Esc at the spec step", () => cancelledAt([CANCEL]));

  it.scoped("refuses on Esc at the branch step", () => cancelledAt([SPEC, CANCEL]));

  it.scoped("refuses on Esc at the summary", () => cancelledAt([SPEC, BRANCH, ENTER, CANCEL]));

  // `Abort` is the same cancel as the key, by the same line and the same exit
  // code — the row exists because the summary is where a dispatcher decides,
  // not because aborting there means something else.
  // 13's one sentinel, inside an edit too — not bash's "back to the summary".
  it.scoped("refuses on Esc during an edit", () =>
    cancelledAt([SPEC, BRANCH, ENTER, "Edit branch", CANCEL]),
  );

  it.scoped("refuses on the summary's Abort row", () =>
    cancelledAt([SPEC, BRANCH, ENTER, "Abort"]),
  );
});

describe("a tasks dir with nothing to dispatch", () => {
  it.scoped("refuses by naming the directory rather than opening an empty list", () =>
    Effect.gen(function* () {
      const result = yield* pick({ answers: [], specs: [] });

      expect(Either.isLeft(result.outcome)).toBe(true);
      if (Either.isLeft(result.outcome)) {
        expect(result.outcome.left._tag).toBe("GuardRefused");
        expect(result.outcome.left.detail).toContain("no specs under");
      }
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("refuses when the tasks dir is not there at all", () =>
    Effect.gen(function* () {
      const result = yield* pick({ answers: [], config: { tasksDir: "nowhere" } });

      expect(Either.isLeft(result.outcome)).toBe(true);
      if (Either.isLeft(result.outcome)) {
        expect(result.outcome.left.detail).toContain("cannot be read");
      }
    }).pipe(Effect.provide(NodeContext.layer)),
  );
});

describe("a repository git cannot read", () => {
  // The picker's other refusal, and not a cancel: git's own line reaches the
  // entrypoint through the same renderer, with nothing held and nothing
  // asked after it.
  it.scoped("refuses with git's line rather than opening a branch step", () =>
    Effect.gen(function* () {
      const result = yield* pick({
        answers: [],
        branchesFails: "fatal: not a git repository",
      });

      expect(Either.isLeft(result.outcome)).toBe(true);
      if (Either.isLeft(result.outcome)) {
        expect(result.outcome.left._tag).toBe("GitError");
        expect(renderFailure(result.outcome.left)).toEqual(
          Option.some("!! fatal: not a git repository"),
        );
      }
      // The refusal comes before the first question: the world is read once,
      // up front, so nothing is asked that the picker cannot follow through.
      expect(result.asked).toEqual([]);
    }).pipe(Effect.provide(NodeContext.layer)),
  );
});

describe("the summary block", () => {
  it("says what was chosen and how to type it again", () => {
    expect(summaryNote(SPEC, BRANCH, argvFor(SPEC, BRANCH, []))).toBe(
      [`spec:   ${SPEC}`, `branch: ${BRANCH}`, "", `bessemer ${SPEC} --branch ${BRANCH}`].join(
        "\n",
      ),
    );
  });
});

describe("the feature rows (T83)", () => {
  // bash's `_feature_recency_key`: newest issue file first, then by name —
  // and every feature above every spec.
  it("offers every feature newest first, above the specs", () => {
    const rows = sourceRows(
      [
        { name: "older", modifiedAt: 10 },
        { name: "b-newer", modifiedAt: 30 },
        { name: "a-newer", modifiedAt: 30 },
      ],
      [{ name: SPEC, modifiedAt: 50 }],
    );

    expect(rows.map((row) => row.label)).toEqual([
      featureLabel("a-newer"),
      featureLabel("b-newer"),
      featureLabel("older"),
      SPEC,
    ]);
    expect(rows[0]?.value).toEqual({ _tag: "Feature", folder: "a-newer" });
    // A spec still answers with its bare name, as it did before a feature row
    // could sit beside it.
    expect(rows[3]?.value).toBe(SPEC);
  });

  it("types a feature as its two flags, --issues all by name", () => {
    expect(argvFor({ folder: "f", issues: ALL_READY }, "b", [])).toEqual([
      "--feature",
      "f",
      "--issues",
      "all",
      "--branch",
      "b",
    ]);
    expect(
      argvFor({ folder: "f", issues: ["T2", "T10"] }, "b", ["--dry-run"], "origin/dev"),
    ).toEqual([
      "--feature",
      "f",
      "--issues",
      "T2,T10",
      "--branch",
      "b",
      "--base",
      "origin/dev",
      "--dry-run",
    ]);
  });

  it("says the folder and the issues on the summary", () => {
    const feature = { folder: "f", issues: ["T2", "T10"] };
    expect(summaryNote(feature, "b", argvFor(feature, "b", []))).toBe(
      [
        "feature: f",
        "issues: T2,T10",
        "branch: b",
        "",
        "bessemer --feature f --issues T2,T10 --branch b",
      ].join("\n"),
    );
  });

  it("lists every issue in orderIssues' order, with Done and HITL disabled", () => {
    const rows = issueRows([
      fakeIssue("T3", {
        blockers: [
          { id: "T1", token: "T1" },
          { id: "T2", token: "T2" },
        ],
      }),
      fakeIssue("T2", { status: "done" }),
      fakeIssue("T1", { type: "HITL" }),
      fakeIssue("T4", { status: { _tag: "Unknown", text: "doing" } }),
    ]);

    expect(rows).toEqual([
      {
        value: "T1",
        label: "T1 — a thing to do",
        hint: "ready-for-agent · HITL",
        disabled: true,
      },
      { value: "T2", label: "T2 — a thing to do", hint: "done · AFK", disabled: true },
      { value: "T4", label: "T4 — a thing to do", hint: "doing · AFK" },
      // Only the blocker not yet done on this ref is unmet.
      {
        value: "T3",
        label: "T3 — a thing to do",
        hint: "ready-for-agent · AFK · blocked by T1",
      },
    ]);
  });

  it("offers All ready only when the predicate answers a set", () => {
    const ready = readyIds([fakeIssue("T2"), fakeIssue("T1")], "tasks/f");
    expect(ready).toEqual(Option.some(["T1", "T2"]));
    expect(issuesMenuRows(ready).map((row) => row.label)).toEqual([
      "All ready (2): T1, T2",
      CHOOSE_LABEL,
      BACK_LABEL,
    ]);

    const none = readyIds([fakeIssue("T1", { status: "needs-triage" })], "tasks/f");
    expect(none).toEqual(Option.none());
    expect(issuesMenuRows(none).map((row) => row.label)).toEqual([CHOOSE_LABEL, BACK_LABEL]);
  });

  it("has something to pick while one row is enabled", () => {
    expect(anyPickable(issueRows([fakeIssue("T1", { status: "done" }), fakeIssue("T2")]))).toBe(
      true,
    );
    expect(
      anyPickable(
        issueRows([fakeIssue("T1", { status: "done" }), fakeIssue("T2", { type: "HITL" })]),
      ),
    ).toBe(false);
    expect(anyPickable([])).toBe(false);
  });
});

// An issue row's label, over `fakeIssue`'s title — which opens with the id,
// so the id is printed once.
const labelOf = (id: string): string => `${id} — a thing to do`;

describe("the issues step (T83)", () => {
  const FEATURE = "f";
  // Where `--feature f` lands, repo-relative — the folder T73's guard reads.
  const FOLDER = "tasks/f";

  it.scoped("reads the folder at the branch tip and hands on --issues all by name", () =>
    Effect.gen(function* () {
      const result = yield* pick({
        features: [FEATURE],
        issues: { sets: { [PRE_TIP]: [fakeIssue("T2"), fakeIssue("T1")] } },
        answers: [featureLabel(FEATURE), BRANCH, allReadyLabel(["T1", "T2"]), ENTER, "Dispatch"],
      });

      expect(answered(result)).toEqual([
        "--feature",
        FEATURE,
        "--issues",
        "all",
        "--branch",
        BRANCH,
      ]);
      // The tip resolved once, as T73's guard resolves it, and the set asked
      // for at exactly that sha.
      expect(result.gitCalls).toContainEqual({
        _tag: "RevParse",
        repo: expect.any(String),
        rev: `refs/heads/${BRANCH}`,
      });
      expect(result.issueCalls).toEqual([
        { _tag: "Issues", repo: expect.any(String), ref: PRE_TIP, folder: FOLDER },
      ]);
      // Source, branch, issues, base — branch before issues (SPEC §2).
      expect(result.asked.map((question) => question.message)).toEqual([
        "What should the run work on?",
        "Which branch?",
        "Which issues?",
        "Which base?",
        expect.any(String),
        "Dispatch this?",
      ]);
      expect(result.asked[0]?.rows.map((row) => row.label)).toEqual([
        featureLabel(FEATURE),
        SPEC,
        TASK_LABEL,
        RESUME_LABEL,
      ]);
      expect(result.asked[4]?.message).toContain("issues: all");
      expect(result.asked[4]?.message).toContain(
        `bessemer --feature ${FEATURE} --issues all --branch ${BRANCH}`,
      );
      expect(result.asked[5]?.rows.map((row) => row.label)).toEqual([
        "Dispatch",
        "Edit source",
        "Edit branch",
        "Edit issues",
        "Edit base",
        BACK_LABEL,
        "Abort",
      ]);
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("hands on the chosen ids in orderIssues' order, Done and HITL disabled", () =>
    Effect.gen(function* () {
      const set = [
        fakeIssue("T5", { status: "needs-triage" }),
        fakeIssue("T4", { blockers: [{ id: "T3", token: "T3" }] }),
        fakeIssue("T3"),
        fakeIssue("T2", { type: "HITL" }),
        fakeIssue("T1", { status: "done" }),
      ];
      const result = yield* pick({
        features: [FEATURE],
        issues: { sets: { [PRE_TIP]: set } },
        // Ticked out of order: the words follow the list, not the ticking.
        answers: [
          featureLabel(FEATURE),
          BRANCH,
          CHOOSE_LABEL,
          [labelOf("T5"), labelOf("T3")],
          ENTER,
          "Dispatch",
        ],
      });

      expect(answered(result)).toEqual([
        "--feature",
        FEATURE,
        "--issues",
        "T3,T5",
        "--branch",
        BRANCH,
      ]);
      const chosen = result.asked[3];
      expect(chosen?.kind).toBe("multiselect");
      expect(chosen?.rows).toEqual([
        { label: labelOf("T1"), hint: "done · AFK", disabled: true },
        { label: labelOf("T2"), hint: "ready-for-agent · HITL", disabled: true },
        { label: labelOf("T3"), hint: "ready-for-agent · AFK" },
        { label: labelOf("T5"), hint: "needs-triage · AFK" },
        { label: labelOf("T4"), hint: "ready-for-agent · AFK · blocked by T3" },
      ]);
      // The ready set is what `--issues all` would take: T3, and T4 behind it.
      expect(chosen?.selected).toEqual([labelOf("T3"), labelOf("T4")]);
      expect(result.asked[5]?.message).toContain("issues: T3,T5");
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("shows T73's sentence for a folder the tip lacks, and asks the branch again", () =>
    Effect.gen(function* () {
      const result = yield* pick({
        features: [FEATURE],
        issues: { sets: {} },
        answers: [featureLabel(FEATURE), BRANCH, CANCEL],
      });

      expect(result.asked.map((question) => question.message)).toEqual([
        "What should the run work on?",
        "Which branch?",
        issueSetRefusal(
          new FolderAbsent({ folder: FOLDER, path: `${FOLDER}/issues`, ref: PRE_TIP }),
          { branch: BRANCH, tipSha: PRE_TIP, folder: FOLDER },
        ).detail,
        "Which branch?",
      ]);
      expect(result.asked[2]?.kind).toBe("note");
      expect(result.asked[2]?.message).toContain(`${FOLDER}/issues/ is not on branch '${BRANCH}'`);
      // Pre-answered with the branch that lacked it.
      expect(result.asked[3]?.initial).toBe(BRANCH);
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("names the file that does not parse, and asks the branch again", () =>
    Effect.gen(function* () {
      const result = yield* pick({
        features: [FEATURE],
        issues: { unparseable: { file: `${FOLDER}/issues/T9-x.md`, detail: "no id" } },
        answers: [featureLabel(FEATURE), BRANCH, CANCEL],
      });

      expect(result.asked[2]?.kind).toBe("note");
      expect(result.asked[2]?.message).toContain(`${FOLDER}/issues/T9-x.md`);
      expect(result.asked[3]?.message).toBe("Which branch?");
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("offers no All ready row when nothing is ready", () =>
    Effect.gen(function* () {
      const result = yield* pick({
        features: [FEATURE],
        issues: { sets: { [PRE_TIP]: [fakeIssue("T1", { status: "needs-triage" })] } },
        answers: [featureLabel(FEATURE), BRANCH, CANCEL],
      });

      expect(result.asked[2]?.rows.map((row) => row.label)).toEqual([CHOOSE_LABEL, BACK_LABEL]);
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  // Choose… over nothing tickable is a multiselect only Esc leaves — and Esc
  // cancels the whole picker (13's back-navigation rule).
  it.scoped("says so for a folder with nothing to pick, and asks the branch again", () =>
    Effect.gen(function* () {
      const result = yield* pick({
        features: [FEATURE],
        issues: {
          sets: {
            [PRE_TIP]: [fakeIssue("T1", { status: "done" }), fakeIssue("T2", { type: "HITL" })],
          },
        },
        answers: [featureLabel(FEATURE), BRANCH, CANCEL],
      });

      expect(result.asked.map((question) => question.message)).toEqual([
        "What should the run work on?",
        "Which branch?",
        nothingPickableNote(FOLDER, BRANCH),
        "Which branch?",
      ]);
      expect(result.asked[2]?.kind).toBe("note");
      expect(result.asked[2]?.message).toContain(FOLDER);
      expect(result.asked[2]?.message).toContain(`'${BRANCH}'`);
      expect(result.asked[3]?.initial).toBe(BRANCH);
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  // One issue is still a question: the human names the set (no bash
  // auto-skip), and it costs one keypress.
  it.scoped("asks even when the folder holds one issue", () =>
    Effect.gen(function* () {
      const result = yield* pick({
        features: [FEATURE],
        issues: { sets: { [PRE_TIP]: [fakeIssue("T1")] } },
        answers: [featureLabel(FEATURE), BRANCH, ENTER, ENTER, "Dispatch"],
      });

      expect(answered(result)).toEqual([
        "--feature",
        FEATURE,
        "--issues",
        "all",
        "--branch",
        BRANCH,
      ]);
      expect(result.asked[2]?.message).toBe("Which issues?");
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("goes back from the issues step to the branch, and from the base to the issues", () =>
    Effect.gen(function* () {
      const all = allReadyLabel(["T1"]);
      const result = yield* pick({
        features: [FEATURE],
        issues: { sets: { [PRE_TIP]: [fakeIssue("T1")] } },
        answers: [
          featureLabel(FEATURE),
          BRANCH,
          BACK_LABEL,
          BRANCH,
          all,
          BACK_LABEL,
          all,
          ENTER,
          "Dispatch",
        ],
      });

      expect(answered(result)).toEqual([
        "--feature",
        FEATURE,
        "--issues",
        "all",
        "--branch",
        BRANCH,
      ]);
      expect(result.asked.map((question) => question.message)).toEqual([
        "What should the run work on?",
        "Which branch?",
        "Which issues?",
        "Which branch?",
        "Which issues?",
        "Which base?",
        "Which issues?",
        "Which base?",
        expect.any(String),
        "Dispatch this?",
      ]);
      // Re-entered, the issues step starts on what it answered last time.
      expect(result.asked[6]?.initial).toBe(all);
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("re-reads the issues at the new branch's tip on Edit branch, then the base", () =>
    Effect.gen(function* () {
      const all = allReadyLabel(["T1"]);
      const result = yield* pick({
        features: [FEATURE],
        issues: { sets: { [PRE_TIP]: [fakeIssue("T1")] } },
        answers: [
          featureLabel(FEATURE),
          BRANCH,
          all,
          ENTER,
          "Edit branch",
          "bessemer-t80",
          all,
          ENTER,
          "Dispatch",
        ],
      });

      expect(answered(result)).toEqual([
        "--feature",
        FEATURE,
        "--issues",
        "all",
        "--branch",
        "bessemer-t80",
      ]);
      expect(result.asked.map((question) => question.message)).toEqual([
        "What should the run work on?",
        "Which branch?",
        "Which issues?",
        "Which base?",
        expect.any(String),
        "Dispatch this?",
        "Which branch?",
        "Which issues?",
        "Which base?",
        expect.any(String),
        "Dispatch this?",
      ]);
      // Each branch's tip resolved, and the folder read at each.
      expect(
        result.gitCalls.filter(
          (call) => call._tag === "RevParse" && call.rev.startsWith("refs/heads/"),
        ),
      ).toEqual([
        { _tag: "RevParse", repo: expect.any(String), rev: `refs/heads/${BRANCH}` },
        { _tag: "RevParse", repo: expect.any(String), rev: "refs/heads/bessemer-t80" },
      ]);
      expect(result.issueCalls).toHaveLength(2);
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("drops the issues from the words when Edit source picks a spec", () =>
    Effect.gen(function* () {
      const result = yield* pick({
        features: [FEATURE],
        issues: { sets: { [PRE_TIP]: [fakeIssue("T1")] } },
        answers: [
          featureLabel(FEATURE),
          BRANCH,
          ENTER,
          ENTER,
          "Edit source",
          SPEC,
          ENTER,
          ENTER,
          "Dispatch",
        ],
      });

      expect(answered(result)).toEqual([SPEC, "--branch", BRANCH]);
      expect(result.asked.at(-1)?.rows.map((row) => row.label)).not.toContain("Edit issues");
    }).pipe(Effect.provide(NodeContext.layer)),
  );
});

// --- the task and resume rows (T85) -----------------------------------------

// An editor that leaves `lines` under the template it was handed, and exits 0
// — the dispatcher saving. The file is the last word of the argv the bracket
// spawned, as `editor.test.ts` reads it.
const editorWriting = (lines: ReadonlyArray<string>): ScriptedResult => ({
  onSpawn: (args) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const file = args[args.length - 1] ?? "";
      const prefilled = yield* fs.readFileString(file);
      yield* fs.writeFileString(file, `${prefilled}${lines.join("\n")}\n`);
    }).pipe(Effect.provide(NodeContext.layer), Effect.orDie),
});

const TASK = "add the missing guard";
const FEEDBACK = "use the smaller diff";

// A whole ledger row, as `run.ts` writes one: the resume rows render through
// `status`' cells, which read more of it than a branch hint does.
const runRow = (branch: string, daysAgo: number, spec: string, outcome: string): RunRecord => ({
  schemaVersion: CURRENT_SCHEMA_VERSION,
  runId: Option.none(),
  branch,
  identity: { _tag: "OneOff", spec },
  startedAt: Option.none(),
  endedAt: DateTime.unsafeMake(NOW - daysAgo * DAY),
  terminalReason: Option.some({ _tag: "Completed" }),
  outcome: Option.some(outcome),
  base: { ref: CONFIG_BASE, sha: Option.none() },
  mergeBaseSha: Option.none(),
  pr: Option.none(),
  rescuedOnto: Option.none(),
  discardedTip: Option.none(),
  dispatcher: Option.none(),
  staleDispatcherOverridden: Option.none(),
  tokensIn: Option.none(),
  tokensOut: Option.none(),
  cacheWrite: Option.none(),
  cacheRead: Option.none(),
  passes: Option.none(),
  models: Option.none(),
});

// Three rows on two branches, newest first as `recent` answers: BRANCH twice,
// its newer run approved.
const THREE_RUNS: ReadonlyArray<RunRecord> = [
  runRow(BRANCH, 1, SPEC, "approved"),
  runRow("bessemer-t80", 2, "T80", "needs-work"),
  runRow(BRANCH, 3, SPEC, "needs-work"),
];

const NEWER_ROW = `${BRANCH} — ${SPEC} ✅ approved 1d ago`;

describe("the task row (T85)", () => {
  it.scoped("opens the editor and hands on --task with its text as one word", () =>
    Effect.gen(function* () {
      const result = yield* pick({
        answers: [TASK_LABEL, "b", ENTER, "Dispatch"],
        branches: [...BRANCHES, branchAt("b", 4)],
        editor: editorWriting([TASK]),
      });

      expect(answered(result)).toEqual(["--task", TASK, "--branch", "b"]);
      // Branch and base as for a spec, and no issues step.
      expect(result.asked.map((question) => question.message)).toEqual([
        "What should the run work on?",
        "Which branch?",
        "Which base?",
        expect.any(String),
        "Dispatch this?",
      ]);
      // The echoed command line quotes the text, so it pastes back whole.
      expect(result.asked[3]?.message).toContain(`bessemer --task '${TASK}' --branch b`);
      expect(result.asked[4]?.rows.map((row) => row.label)).toEqual([
        "Dispatch",
        "Edit source",
        "Edit branch",
        "Edit base",
        BACK_LABEL,
        "Abort",
      ]);
      // The bracket removed its file on the way out.
      const fs = yield* FileSystem.FileSystem;
      expect(yield* fs.readDirectory(result.runtimeRoot).pipe(Effect.orDie)).toEqual([]);
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  // A sub-prompt's cancel, bash's rule for exactly this entry: the source step
  // again, not the picker's one sentinel.
  it.scoped("asks the source step again when the editor comes back empty", () =>
    Effect.gen(function* () {
      const result = yield* pick({
        answers: [TASK_LABEL, SPEC, BRANCH, ENTER, "Dispatch"],
        editor: editorWriting([]),
      });

      expect(answered(result)).toEqual([SPEC, "--branch", BRANCH]);
      expect(result.asked.slice(0, 2).map((question) => question.message)).toEqual([
        "What should the run work on?",
        "What should the run work on?",
      ]);
    }).pipe(Effect.provide(NodeContext.layer)),
  );
});

describe("the resume row (T85)", () => {
  it("takes each branch's newest record, newest first, capped at ten", () => {
    expect(latestPerBranch(THREE_RUNS).map((record) => record.branch)).toEqual([
      BRANCH,
      "bessemer-t80",
    ]);
    expect(latestPerBranch(THREE_RUNS)[0]?.outcome).toEqual(Option.some("approved"));
    const many = Array.from({ length: 12 }, (_, index) =>
      runRow(`b${index}`, index, SPEC, "approved"),
    );
    expect(latestPerBranch(many)).toHaveLength(10);
  });

  it.scoped("offers one row per branch and hands on --resume alone when feedback is declined", () =>
    Effect.gen(function* () {
      const result = yield* pick({
        answers: [RESUME_LABEL, NEWER_ROW, false, "Dispatch"],
        records: Either.right(THREE_RUNS),
      });

      expect(answered(result)).toEqual(["--resume", BRANCH]);
      // No branch, issues, or base step: the resume recovers both.
      expect(result.asked.map((question) => question.kind)).toEqual([
        "select",
        "select",
        "confirm",
        "note",
        "select",
      ]);
      expect(result.asked[1]?.rows.map((row) => row.label)).toEqual([
        NEWER_ROW,
        `bessemer-t80 — T80 ⚠️ needs-work 2d ago`,
        BACK_LABEL,
      ]);
      expect(result.asked[2]?.message).toBe("Add feedback?");
      expect(result.asked[3]?.message).toContain(`resume: ${BRANCH}`);
      expect(result.asked[3]?.message).toContain(`bessemer --resume ${BRANCH}`);
      // Its summary offers the source step and nothing else to edit.
      expect(result.asked[4]?.rows.map((row) => row.label)).toEqual([
        "Dispatch",
        "Edit source",
        BACK_LABEL,
        "Abort",
      ]);
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("hands on --feedback with what the editor held", () =>
    Effect.gen(function* () {
      const result = yield* pick({
        answers: [RESUME_LABEL, NEWER_ROW, true, "Dispatch"],
        records: Either.right(THREE_RUNS),
        editor: editorWriting([FEEDBACK]),
      });

      expect(answered(result)).toEqual(["--resume", BRANCH, "--feedback", FEEDBACK]);
      expect(result.asked[3]?.message).toContain(`feedback: ${FEEDBACK}`);
      expect(result.asked[3]?.message).toContain(
        `bessemer --resume ${BRANCH} --feedback '${FEEDBACK}'`,
      );
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  // bash's one deliberate exception (`pick_resume`): empty feedback is no
  // feedback, not a cancel.
  it.scoped("hands on no --feedback when the editor comes back empty", () =>
    Effect.gen(function* () {
      const result = yield* pick({
        answers: [RESUME_LABEL, NEWER_ROW, true, "Dispatch"],
        records: Either.right(THREE_RUNS),
        editor: editorWriting([]),
      });

      expect(answered(result)).toEqual(["--resume", BRANCH]);
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("says there are no runs over an empty ledger, and asks the source step again", () =>
    Effect.gen(function* () {
      const result = yield* pick({
        answers: [RESUME_LABEL, NO_RUNS_LABEL, SPEC, BRANCH, ENTER, "Dispatch"],
      });

      expect(answered(result)).toEqual([SPEC, "--branch", BRANCH]);
      expect(result.asked[1]?.rows).toEqual([{ label: NO_RUNS_LABEL }]);
      expect(result.asked[2]?.message).toBe("What should the run work on?");
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("goes back to the source step from the run list", () =>
    Effect.gen(function* () {
      const result = yield* pick({
        answers: [RESUME_LABEL, BACK_LABEL, SPEC, BRANCH, ENTER, "Dispatch"],
        records: Either.right(THREE_RUNS),
      });

      expect(answered(result)).toEqual([SPEC, "--branch", BRANCH]);
    }).pipe(Effect.provide(NodeContext.layer)),
  );
});

// A request as `@effect/cli` parses it, with nothing typed but `flags`.
const typedRequest = (flags: Partial<DispatchRequest>): DispatchRequest => ({
  spec: Option.none(),
  branch: Option.none(),
  base: Option.none(),
  resume: Option.none(),
  last: false,
  feedback: Option.none(),
  feedbackEdit: false,
  task: Option.none(),
  feature: Option.none(),
  issues: Option.none(),
  allowStaleDispatcher: false,
  hardReset: false,
  keepsLog: true,
  ...flags,
});

const count = (words: ReadonlyArray<string>, word: string): number =>
  words.filter((each) => each === word).length;

// T86: a command line missing an answer opens the picker with every typed
// flag already answered, and it asks only what is missing.
describe("flags seed the wizard (T86)", () => {
  const FEATURE = "f";
  const FOLDER = "tasks/f";

  const seeded = (flags: Partial<DispatchRequest>): Seed => seedFor(typedRequest(flags));

  it.scoped("opens at the branch step for <spec> alone, and says the spec once", () =>
    Effect.gen(function* () {
      const result = yield* pick({
        seed: seeded({ spec: Option.some(SPEC) }),
        answers: [BRANCH, ENTER, "Dispatch"],
      });

      const words = answered(result);
      expect(words).toEqual([SPEC, "--branch", BRANCH]);
      expect(count(words, SPEC)).toBe(1);
      expect(result.asked.map((question) => question.message)).toEqual([
        "Which branch?",
        "Which base?",
        expect.any(String),
        "Dispatch this?",
      ]);
      expect(result.asked[2]?.message).toContain(`spec:   ${SPEC}`);
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("opens at the source step for --branch alone, and skips the branch step", () =>
    Effect.gen(function* () {
      const result = yield* pick({
        seed: seeded({ branch: Option.some(BRANCH) }),
        answers: [SPEC, ENTER, "Dispatch"],
      });

      const words = answered(result);
      expect(words).toEqual([SPEC, "--branch", BRANCH]);
      expect(count(words, "--branch")).toBe(1);
      expect(result.asked.map((question) => question.message)).toEqual([
        "What should the run work on?",
        "Which base?",
        expect.any(String),
        "Dispatch this?",
      ]);
      expect(result.asked[2]?.message).toContain(`branch: ${BRANCH}`);
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("opens the issues step at the typed branch's tip for --feature and --branch", () =>
    Effect.gen(function* () {
      const result = yield* pick({
        seed: seeded({ feature: Option.some(FEATURE), branch: Option.some(BRANCH) }),
        features: [FEATURE],
        issues: { sets: { [PRE_TIP]: [fakeIssue("T1")] } },
        answers: [allReadyLabel(["T1"]), ENTER, "Dispatch"],
      });

      expect(answered(result)).toEqual([
        "--feature",
        FEATURE,
        "--issues",
        "all",
        "--branch",
        BRANCH,
      ]);
      expect(result.asked[0]?.message).toBe("Which issues?");
      expect(result.gitCalls).toContainEqual({
        _tag: "RevParse",
        repo: expect.any(String),
        rev: `refs/heads/${BRANCH}`,
      });
      expect(result.issueCalls).toEqual([
        { _tag: "Issues", repo: expect.any(String), ref: PRE_TIP, folder: FOLDER },
      ]);
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  // T96: a typed branch the branch step could never offer is refused before
  // the first question, in the words a typed dispatch refuses it with.
  describe("a seeded branch that does not exist", () => {
    const ABSENT = "some-branch";
    const REFUSAL = `branch '${ABSENT}' doesn't exist — create it first: git branch '${ABSENT}' [<start>]`;

    const expectRefused = (result: Picked): void => {
      expect(Either.isLeft(result.outcome)).toBe(true);
      if (Either.isLeft(result.outcome)) {
        expect(result.outcome.left._tag).toBe("GuardRefused");
        expect(result.outcome.left.detail).toBe(REFUSAL);
      }
      expect(result.asked).toEqual([]);
    };

    it.scoped("refuses --feature and --branch without asking, or reading the tip", () =>
      Effect.gen(function* () {
        const result = yield* pick({
          seed: seeded({ feature: Option.some(FEATURE), branch: Option.some(ABSENT) }),
          features: [FEATURE],
          answers: [],
        });

        expectRefused(result);
        expect(result.gitCalls).not.toContainEqual(expect.objectContaining({ _tag: "RevParse" }));
      }).pipe(Effect.provide(NodeContext.layer)),
    );

    it.scoped("refuses --branch alone the same way", () =>
      Effect.gen(function* () {
        const result = yield* pick({ seed: seeded({ branch: Option.some(ABSENT) }), answers: [] });

        expectRefused(result);
      }).pipe(Effect.provide(NodeContext.layer)),
    );
  });

  it.scoped("finds a typed feature's row again on Edit source", () =>
    Effect.gen(function* () {
      const result = yield* pick({
        seed: seeded({
          feature: Option.some(FEATURE),
          issues: Option.some("all"),
          branch: Option.some(BRANCH),
        }),
        features: [FEATURE],
        issues: { sets: { [PRE_TIP]: [fakeIssue("T1")] } },
        answers: [ENTER, "Edit source", ENTER, ENTER, ENTER, ENTER, "Dispatch"],
      });

      expect(answered(result)).toEqual([
        "--feature",
        FEATURE,
        "--issues",
        "all",
        "--branch",
        BRANCH,
      ]);
      expect(result.asked[3]?.initial).toBe(featureLabel(FEATURE));
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("lists only the feature rows when --issues was typed", () =>
    Effect.gen(function* () {
      const result = yield* pick({
        seed: seeded({ issues: Option.some("01"), branch: Option.some(BRANCH) }),
        features: [FEATURE],
        answers: [featureLabel(FEATURE), ENTER, "Dispatch"],
      });

      expect(result.asked[0]?.rows.map((row) => row.label)).toEqual([featureLabel(FEATURE)]);
      expect(answered(result)).toEqual([
        "--feature",
        FEATURE,
        "--issues",
        "01",
        "--branch",
        BRANCH,
      ]);
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped(
    "refuses rather than asking from no rows when --issues was typed and no feature exists",
    () =>
      Effect.gen(function* () {
        const result = yield* pick({
          seed: seeded({ issues: Option.some("01"), branch: Option.some(BRANCH) }),
          answers: [],
        });

        expect(result.asked).toEqual([]);
        expect(Either.isLeft(result.outcome)).toBe(true);
        if (Either.isLeft(result.outcome)) {
          expect(result.outcome.left._tag).toBe("GuardRefused");
          expect(result.outcome.left.detail).toContain("no features under");
        }
      }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("hides Resume a run for a typed --base, and keeps it even at the default", () =>
    Effect.gen(function* () {
      const result = yield* pick({
        seed: seeded({ base: Option.some(CONFIG_BASE), branch: Option.some(BRANCH) }),
        answers: [SPEC, "Dispatch"],
      });

      expect(result.asked[0]?.rows.map((row) => row.label)).toEqual([SPEC, TASK_LABEL]);
      expect(answered(result)).toEqual([SPEC, "--branch", BRANCH, "--base", CONFIG_BASE]);
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("hides Task typed inline for typed --feedback, and says it once", () =>
    Effect.gen(function* () {
      const result = yield* pick({
        seed: seeded({ feedback: Option.some("y"), branch: Option.some(BRANCH) }),
        answers: [SPEC, ENTER, "Dispatch"],
      });

      expect(result.asked[0]?.rows.map((row) => row.label)).toEqual([SPEC]);
      const words = answered(result);
      expect(words).toEqual([SPEC, "--branch", BRANCH, "--feedback", "y"]);
      expect(count(words, "--feedback")).toBe(1);
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("carries --feedback-edit and --allow-stale-dispatcher through as typed", () =>
    Effect.gen(function* () {
      const result = yield* pick({
        seed: seeded({ feedbackEdit: true, allowStaleDispatcher: true }),
        answers: [SPEC, BRANCH, ENTER, "Dispatch"],
      });

      expect(result.asked[0]?.rows.map((row) => row.label)).toEqual([SPEC, RESUME_LABEL]);
      expect(answered(result)).toEqual([
        SPEC,
        "--branch",
        BRANCH,
        "--feedback-edit",
        "--allow-stale-dispatcher",
      ]);
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  // T101: `--hard-reset` is a flag that is not a step, so it rides through
  // as typed beside the others.
  it.scoped("carries --hard-reset through as typed", () =>
    Effect.gen(function* () {
      const result = yield* pick({
        seed: seeded({ hardReset: true }),
        answers: [SPEC, BRANCH, ENTER, "Dispatch"],
      });

      expect(answered(result)).toEqual([SPEC, "--branch", BRANCH, "--hard-reset"]);
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("re-runs a typed branch on Edit branch, with the cursor on it", () =>
    Effect.gen(function* () {
      const result = yield* pick({
        seed: seeded({ branch: Option.some(BRANCH) }),
        answers: [SPEC, ENTER, "Edit branch", "bessemer-t80", ENTER, "Dispatch"],
      });

      expect(result.asked[4]?.message).toBe("Which branch?");
      expect(result.asked[4]?.initial).toBe(BRANCH);
      const words = answered(result);
      expect(words).toEqual([SPEC, "--branch", "bessemer-t80"]);
      expect(words).not.toContain(BRANCH);
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("walks back into a step a flag answered", () =>
    Effect.gen(function* () {
      const result = yield* pick({
        seed: seeded({ spec: Option.some(SPEC) }),
        answers: [BACK_LABEL, ENTER, BRANCH, ENTER, "Dispatch"],
      });

      expect(answered(result)).toEqual([SPEC, "--branch", BRANCH]);
      expect(result.asked[1]?.message).toBe("What should the run work on?");
      expect(result.asked[1]?.initial).toBe(SPEC);
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("keeps --dry-run on the words, so the rehearsal composition runs", () =>
    Effect.gen(function* () {
      const request = typedRequest({ branch: Option.some(BRANCH), keepsLog: false });
      const result = yield* pick({
        seed: seedFor(request),
        modifiers: modifiersFor(request),
        answers: [SPEC, ENTER, "Dispatch"],
      });

      const words = answered(result);
      expect(words).toEqual([SPEC, "--branch", BRANCH, "--dry-run"]);
      expect(appCompositionFor(words)).toBe(appDryRunLiveFor);
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("asks nothing off a TTY, and runs no git", () =>
    Effect.gen(function* () {
      const result = yield* pick({
        seed: seeded({ spec: Option.some(SPEC) }),
        answers: [],
        isTTY: false,
      });

      expect(result.outcome).toEqual(Either.right(Option.none()));
      expect(result.asked).toEqual([]);
      expect(result.gitCalls).toEqual([]);
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it("never asks with --no-input, and seeds from the request otherwise", () => {
    const detail = "--branch is required";
    const request = typedRequest({ spec: Option.some(SPEC) });
    expect(
      seedOf(new AnswerMissing({ step: "branch", request: { ...request, noInput: true }, detail })),
    ).toEqual(Option.none());
    expect(seedOf(new AnswerMissing({ step: "branch", request, detail }))).toEqual(
      Option.some(seedFor(request)),
    );
  });
});
