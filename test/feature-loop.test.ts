// The feature run (T76): a selection walked in T69's order inside the one
// scope a spec run uses — per issue, implement then review rounds — stopping
// at the first issue that does not approve and landing what approved.
//
// Three observables, as everywhere else in the dispatch core (SPEC §11): the
// fake `Reporter`'s event `Ref`, the fake `Ledger`'s rows, and the failure
// channel. Two more are this loop's own — which `CurrentIssue` crossed the
// `AgentCli` seam, and every call the fake `Git` was asked to make, because
// *the boundary is read in the container* is an assertion about the absence of
// the second.
import { describe, expect, it } from "@effect/vitest";
import { FileSystem } from "@effect/platform";
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { DateTime, Deferred, Effect, Exit, Fiber, Layer, Option, Ref } from "effect";
import { AgentPassFailed } from "../src/agent/agent-cli.ts";
import { CAPPED_UNREVIEWED_FIX } from "../src/agent/verdict.ts";
import { BessemerConfig, defaultConfig } from "../src/config/config.ts";
import {
  APPROVED_OUTCOME,
  boundaryIn,
  IMPLEMENT_FAILED,
  issueChecklistFor,
  issueOutcomesFor,
  NOT_ATTEMPTED,
  REVIEW_FAILED,
  stoppedAt,
  withIssueOutcomes,
} from "../src/dispatch/feature.ts";
import { land } from "../src/dispatch/land.ts";
import { featureDispatch, planFor } from "../src/dispatch/plan.ts";
import { atStage, runInScope, runStartHeader } from "../src/dispatch/run.ts";
import { type CurrentIssue, implementPromptFor } from "../src/agent/prompt.ts";
import { Ledger } from "../src/ledger/ledger.ts";
import type { IssueOutcome, RunIdentity, RunRecord } from "../src/ledger/record.ts";
import { RunLockLive } from "../src/lock/run-lock.ts";
import { Reporter, type ReporterEvent } from "../src/reporter.ts";
import type { SandboxSpec } from "../src/sandbox/spec.ts";
import { renderStatus } from "../src/status/render.ts";
import { fakeAgentCli, type FakeIssueScript } from "./support/agent-cli-fake.ts";
import { TEST_CREDENTIAL } from "./support/credential.ts";
import { fakeForge } from "./support/forge-fake.ts";
import { fakeGit, type GitCall } from "./support/git-fake.ts";
import { fakeIssue, fakeIssueStore } from "./support/issue-store-fake.ts";
import { fakeNotifier } from "./support/notifier-fake.ts";
import { TEST_FORGE_REPO } from "./support/repo-slug.ts";
import { fakeSandbox } from "./support/sandbox-fake.ts";
import { PLAN_TIP } from "./support/plan.ts";

const BRANCH = "bessemer-t76";
const FOLDER = "docs/wayfinder/effect-agentbox";
const MERGE_BASE_SHA = "2222222222222222222222222222222222222222";

// The three SHAs the branch stands at as each issue begins: the merge-base for
// the first — a fresh run's clone is at the tip, and nothing has committed yet
// — and a later commit for each one after it.
const BOUNDARIES = [
  MERGE_BASE_SHA,
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
];

const selectionOf = (...ids: ReadonlyArray<string>) => ({
  request: { _tag: "All" as const },
  issues: ids.map((id) => fakeIssue(id)),
});

const featurePlan = (runtimeRoot: string, ...ids: ReadonlyArray<string>) =>
  planFor({
    ...featureDispatch(FOLDER, selectionOf(...ids)),
    branch: BRANCH,
    baseRef: "origin/master",
    baseSha: "1111111111111111111111111111111111111111",
    mergeBaseSha: MERGE_BASE_SHA,
    tipSha: PLAN_TIP,
    runtimeRoot,
    startedAt: DateTime.unsafeMake("2026-01-01T00:00:00.000Z"),
  });

// The same run under `--hard-reset` (T101): the base is the effective tip, so
// the tip and the diff boundary are both it (T103 pins what follows).
const RESET_BASE = "1111111111111111111111111111111111111111";
const resetFeaturePlan = (runtimeRoot: string, ...ids: ReadonlyArray<string>) =>
  planFor({
    ...featureDispatch(FOLDER, selectionOf(...ids)),
    branch: BRANCH,
    baseRef: "origin/master",
    baseSha: RESET_BASE,
    mergeBaseSha: RESET_BASE,
    tipSha: RESET_BASE,
    reset: Option.some({ discardedTip: PLAN_TIP, discarding: 2, originTip: Option.none() }),
    runtimeRoot,
    startedAt: DateTime.unsafeMake("2026-01-01T00:00:00.000Z"),
  });

const outcome = (issue: string, token: string): IssueOutcome => ({ issue, outcome: token });

describe("what a feature run records", () => {
  // The tail (`run.sh:1896-1901`): every selected id the sequence never
  // reached, in T69's order beside the ones it did.
  it("names every selected id, and not-attempted for the ones never reached", () => {
    expect(
      issueOutcomesFor(selectionOf("T70", "T71", "T72").issues, [
        outcome("T70", APPROVED_OUTCOME),
        outcome("T71", "needs-work"),
      ]),
    ).toEqual([
      outcome("T70", APPROVED_OUTCOME),
      outcome("T71", "needs-work"),
      outcome("T72", NOT_ATTEMPTED),
    ]);
  });

  // A run that reached nothing — killed before its first pass answered — still
  // names what it was for.
  it("records a run that reached no issue as three not-attempted", () => {
    expect(issueOutcomesFor(selectionOf("T70", "T71").issues, [])).toEqual([
      outcome("T70", NOT_ATTEMPTED),
      outcome("T71", NOT_ATTEMPTED),
    ]);
  });

  // The plan's identity carries `issues: []` (`plan.ts`); this is where the
  // run's answer lands on it.
  it("overlays the outcomes onto the identity's Feature arm", () => {
    const { identity } = featureDispatch(FOLDER, selectionOf("T70"));
    expect(withIssueOutcomes(identity, [outcome("T70", APPROVED_OUTCOME)])).toEqual({
      _tag: "Feature",
      feature: FOLDER,
      issues: [outcome("T70", APPROVED_OUTCOME)],
    });
  });

  // And under a `FeedbackResume`, which is the arm T78 resumes on: a row whose
  // outcomes went missing there would be a feature run reporting nothing it
  // did.
  it("reaches the Feature arm under a resume", () => {
    const identity: RunIdentity = {
      _tag: "FeedbackResume",
      resumed: { _tag: "Feature", feature: FOLDER, issues: [] },
      resumedRunId: Option.some("bessemer-t76-1"),
    };
    expect(withIssueOutcomes(identity, [outcome("T70", APPROVED_OUTCOME)])).toEqual({
      _tag: "FeedbackResume",
      resumed: { _tag: "Feature", feature: FOLDER, issues: [outcome("T70", APPROVED_OUTCOME)] },
      resumedRunId: Option.some("bessemer-t76-1"),
    });
  });

  // An identity with no `Feature` arm anywhere is left alone rather than
  // grown one: a spec run records no issues.
  it("leaves a one-off identity untouched", () => {
    const identity: RunIdentity = { _tag: "OneOff", spec: "/repo/tasks/T76.md" };
    expect(withIssueOutcomes(identity, [outcome("T70", APPROVED_OUTCOME)])).toEqual(identity);
  });

  // The stop, read back off the row: the first issue that neither approved nor
  // went unattempted, which is the sentence the terminal notification names.
  it("finds the issue the sequence stopped on", () => {
    expect(
      stoppedAt([
        outcome("T70", APPROVED_OUTCOME),
        outcome("T71", REVIEW_FAILED),
        outcome("T72", NOT_ATTEMPTED),
      ]),
    ).toEqual(Option.some(outcome("T71", REVIEW_FAILED)));
    expect(stoppedAt([outcome("T70", APPROVED_OUTCOME)])).toEqual(Option.none());
    expect(stoppedAt([outcome("T70", IMPLEMENT_FAILED)])).toEqual(
      Option.some(outcome("T70", IMPLEMENT_FAILED)),
    );
  });
});

describe("the checklist a feature run's PR body ends with", () => {
  const selected = [
    fakeIssue("T70", { title: "The dispatch fetches origin" }),
    fakeIssue("T71", { title: "`IssueStore` reads" }),
    fakeIssue("T72", { title: "Landed elsewhere" }),
  ];

  // §1's example, line for line: the stop, the line under it, and the tail.
  it("renders an approval, a capped needs-work, and the tail it left", () => {
    expect(
      issueChecklistFor(
        selected,
        [outcome("T70", APPROVED_OUTCOME), outcome("T71", "needs-work")],
        3,
      ),
    ).toBe(
      [
        "### Issues",
        "- [x] T70 — The dispatch fetches origin: ✅ approved",
        "- [ ] T71 — `IssueStore` reads: ⚠️ needs-work (review capped at 3 round(s))",
        "- [ ] T72 — Landed elsewhere: not attempted (sequence stopped)",
        "",
        "**Stopped:** issue T71 (`IssueStore` reads) review capped at needs-work after 3 round(s)",
      ].join("\n"),
    );
  });

  it("says every selected issue completed when nothing stopped it", () => {
    expect(
      issueChecklistFor(
        selected.slice(0, 2),
        [outcome("T70", APPROVED_OUTCOME), outcome("T71", APPROVED_OUTCOME)],
        3,
      ),
    ).toBe(
      [
        "### Issues",
        "- [x] T70 — The dispatch fetches origin: ✅ approved",
        "- [x] T71 — `IssueStore` reads: ✅ approved",
        "",
        "**All selected issues completed.**",
      ].join("\n"),
    );
  });

  // A real ticket's H1 already opens with its id, in whatever case, and so
  // does a title that fell back to the file stem: the id is printed once, in
  // the lines and in the footer alike. The titles above are the other case.
  it("prints the id once when the title already opens with it", () => {
    expect(
      issueChecklistFor(
        [
          fakeIssue("T70", { title: "T70 — The dispatch fetches origin" }),
          fakeIssue("T71", { title: "t71 — `IssueStore` reads" }),
          fakeIssue("T72", { title: "T72-landed-elsewhere" }),
        ],
        [outcome("T70", APPROVED_OUTCOME), outcome("T71", "needs-work")],
        3,
      ),
    ).toBe(
      [
        "### Issues",
        "- [x] T70 — The dispatch fetches origin: ✅ approved",
        "- [ ] t71 — `IssueStore` reads: ⚠️ needs-work (review capped at 3 round(s))",
        "- [ ] T72-landed-elsewhere: not attempted (sequence stopped)",
        "",
        "**Stopped:** issue T71 (`IssueStore` reads) review capped at needs-work after 3 round(s)",
      ].join("\n"),
    );
  });

  // A longer id sharing the prefix is not this id: the title keeps it beside.
  it("keeps the id beside a title that opens with a longer id", () => {
    expect(
      issueChecklistFor(
        [fakeIssue("T89", { title: "T890 — A longer id" })],
        [outcome("T89", REVIEW_FAILED)],
        3,
      ),
    ).toBe(
      [
        "### Issues",
        "- [ ] T89 — T890 — A longer id: ❌ review pass failed",
        "",
        "**Stopped:** issue T89 (T890 — A longer id) review pass failed — see log",
      ].join("\n"),
    );
  });

  // The other three stops, each with bash's line and bash's reason.
  it.each([
    [
      IMPLEMENT_FAILED,
      "- [ ] T70 — The dispatch fetches origin: ❌ implement pass failed",
      "**Stopped:** issue T70 (The dispatch fetches origin) implement pass failed — see log",
    ],
    [
      REVIEW_FAILED,
      "- [ ] T70 — The dispatch fetches origin: ❌ review pass failed",
      "**Stopped:** issue T70 (The dispatch fetches origin) review pass failed — see log",
    ],
    [
      CAPPED_UNREVIEWED_FIX,
      "- [ ] T70 — The dispatch fetches origin: ⚠️ fix unreviewed (round 2 fixed and capped — nothing else outstanding)",
      "**Stopped:** issue T70 (The dispatch fetches origin) capped after a fixing round — the final round's commits went unreviewed, nothing else outstanding",
    ],
  ])("renders %s with its stop", (token, line, stop) => {
    expect(issueChecklistFor(selected.slice(0, 1), [outcome("T70", token)], 2)).toBe(
      ["### Issues", line, "", stop].join("\n"),
    );
  });
});

describe("the boundary an issue begins at", () => {
  // The whole point of the read (T76 §1): it is a `Sandbox` question, asked of
  // the container, and the one line the child printed is the answer.
  it.effect("reads git rev-parse HEAD in the container", () =>
    Effect.gen(function* () {
      const started = yield* Ref.make<ReadonlyArray<SandboxSpec>>([]);
      const execs = yield* Ref.make<ReadonlyArray<ReadonlyArray<string>>>([]);
      const plan = featurePlan("/runtime", "T70");
      const boundary = yield* boundaryIn({ name: "c", id: "c" }, plan).pipe(
        Effect.provide(fakeSandbox(started, { execs, answers: [`${BOUNDARIES[1]}\n`] })),
      );

      expect(boundary).toBe(BOUNDARIES[1]);
      expect(yield* Ref.get(execs)).toEqual([["git", "rev-parse", "HEAD"]]);
    }),
  );

  // A container that said nothing is a rehearsal — the recording `Sandbox`
  // records the command rather than running it (T15) — and the plan's tip is
  // what the answer would have been, rather than an empty commit in a prompt.
  it.effect("falls back to the plan's tip when nothing answered", () =>
    Effect.gen(function* () {
      const started = yield* Ref.make<ReadonlyArray<SandboxSpec>>([]);
      const plan = featurePlan("/runtime", "T70");
      const boundary = yield* boundaryIn({ name: "c", id: "c" }, plan).pipe(
        Effect.provide(fakeSandbox(started)),
      );

      expect(boundary).toBe(PLAN_TIP);
    }),
  );
});

// --- the loop, inside the run's scope ----------------------------------------

interface FeatureWorld {
  readonly ids?: ReadonlyArray<string>;
  // A `--hard-reset` dispatch's plan (T101): the tip and the boundary are both
  // the base, and the tip the guards read survives only on `reset`.
  readonly resetting?: boolean;
  // What the boundary reads answer, in order, when not `BOUNDARIES`.
  readonly answers?: ReadonlyArray<string>;
  readonly perIssue?: Readonly<Record<string, FakeIssueScript>>;
  readonly maxReviewRounds?: number;
}

// All three resources really held, as the review loop's own world holds them
// (`test/review.test.ts`): the subject here is the sequence, and a scripted
// docker would only let each issue say the same thing as the last. The
// sandbox is the fake because the one command this loop runs in the container
// is the boundary read, and what it answers is what a case scripts.
const world = (options: FeatureWorld = {}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const runtimeRoot = yield* fs.makeTempDirectoryScoped();
    const repoRoot = yield* fs.makeTempDirectoryScoped();
    const events = yield* Ref.make<ReadonlyArray<ReporterEvent>>([]);
    const appended = yield* Ref.make<ReadonlyArray<RunRecord>>([]);
    const gitCalls = yield* Ref.make<ReadonlyArray<GitCall>>([]);
    const sandboxes = yield* Ref.make<ReadonlyArray<SandboxSpec>>([]);
    const execs = yield* Ref.make<ReadonlyArray<ReadonlyArray<string>>>([]);
    // What each pass was told it was for, in the order the passes ran: the
    // sequence that crossed the seam *is* the loop, so this is the assertion.
    const current = yield* Ref.make<ReadonlyArray<Option.Option<CurrentIssue>>>([]);
    // Every git call the loop made, snapshotted where the work begins: the
    // release below reads the clone's own tip afterwards (T38), which is a
    // read this criterion is not about.
    const duringTheLoop = yield* Ref.make<ReadonlyArray<GitCall>>([]);
    // Whether the run reached its work — the land and the PR (T11, T12) — which
    // every stop the loop makes still owes.
    const worked = yield* Ref.make(0);
    // And what the work was handed on `RunWork` when it ran: the loop's
    // outcomes are on the slot before the land begins, which is what lets
    // T77's land read which issues approved.
    const workSaw = yield* Ref.make<ReadonlyArray<IssueOutcome>>([]);

    const ids = options.ids ?? ["T70", "T71", "T72"];
    const plan =
      options.resetting === true
        ? resetFeaturePlan(runtimeRoot, ...ids)
        : featurePlan(runtimeRoot, ...ids);

    const layer = Layer.provideMerge(
      Layer.mergeAll(
        RunLockLive,
        fakeGit(gitCalls),
        fakeIssueStore(),
        // One scripted SHA per issue, in the order the loop asks for them.
        fakeSandbox(sandboxes, {
          execs,
          answers: options.answers ?? BOUNDARIES.map((sha) => `${sha}\n`),
        }),
        fakeNotifier(),
        fakeForge(),
        fakeAgentCli({
          current,
          ...(options.perIssue === undefined ? {} : { perIssue: options.perIssue }),
        }),
      ),
      Layer.mergeAll(
        NodeFileSystem.layer,
        NodePath.layer,
        Layer.succeed(BessemerConfig, {
          ...defaultConfig,
          runtimeRoot,
          ...(options.maxReviewRounds === undefined
            ? {}
            : { maxReviewRounds: options.maxReviewRounds }),
        }),
        Layer.succeed(Reporter, {
          emit: (event) => Ref.update(events, (seen) => [...seen, event]),
        }),
        Layer.succeed(Ledger, {
          append: (record) => Ref.update(appended, (rows) => [...rows, record]),
          recent: () => Effect.succeed([]),
          lastBaseForBranch: () => Effect.succeed(Option.none()),
          resolveResume: () => Effect.die("this feature run never resumes"),
          newestBranchForIssue: () => Effect.die("the witnesses ran before the lock"),
        }),
      ),
    );

    return {
      runtimeRoot,
      repoRoot,
      plan,
      events,
      appended,
      gitCalls,
      duringTheLoop,
      execs,
      current,
      worked,
      workSaw,
      layer,
    };
  });

type FeatureScratch = Effect.Effect.Success<ReturnType<typeof world>>;

// The run, with the work standing in for T11's land and T12's PR: what every
// case here asserts about it is that it ran at all, because all three stops
// land what the issues before them left.
const run = (scratch: FeatureScratch) =>
  runInScope(scratch.plan, scratch.repoRoot, TEST_CREDENTIAL, TEST_FORGE_REPO, (work) =>
    Ref.get(scratch.gitCalls).pipe(
      Effect.flatMap((calls) => Ref.set(scratch.duringTheLoop, calls)),
      Effect.zipRight(
        Effect.flatMap(Ref.get(work.outcomes), (seen) => Ref.set(scratch.workSaw, seen)),
      ),
      Effect.zipRight(Ref.update(scratch.worked, (count) => count + 1)),
    ),
  ).pipe(Effect.provide(scratch.layer));

const issuesOn = (record: RunRecord | undefined): ReadonlyArray<IssueOutcome> =>
  record?.identity._tag === "Feature" ? record.identity.issues : [];

const approves = (): FakeIssueScript => ({ verdicts: ["approved"] });

const passFailure = (detail: string): AgentPassFailed =>
  new AgentPassFailed({ reason: "exited", detail });

describe("a feature run's sequence", () => {
  // The first criterion, end to end: three issues in T69's order, each pass
  // told the SHA the container answered as that issue began, one land, and a
  // row with three approvals on it.
  it.scoped("runs implement then review per issue, and records three approvals", () =>
    Effect.gen(function* () {
      const scratch = yield* world({
        perIssue: { T70: approves(), T71: approves(), T72: approves() },
      });
      yield* run(scratch);

      // Two passes per issue — the implement one and the round that approved —
      // each carrying the boundary the fake sandbox answered for that issue.
      expect(yield* Ref.get(scratch.current)).toEqual([
        Option.some({ issue: fakeIssue("T70"), boundary: BOUNDARIES[0] }),
        Option.some({ issue: fakeIssue("T70"), boundary: BOUNDARIES[0] }),
        Option.some({ issue: fakeIssue("T71"), boundary: BOUNDARIES[1] }),
        Option.some({ issue: fakeIssue("T71"), boundary: BOUNDARIES[1] }),
        Option.some({ issue: fakeIssue("T72"), boundary: BOUNDARIES[2] }),
        Option.some({ issue: fakeIssue("T72"), boundary: BOUNDARIES[2] }),
      ]);
      // One boundary read per issue, in the container and nowhere else.
      expect(yield* Ref.get(scratch.execs)).toEqual([
        ["git", "rev-parse", "HEAD"],
        ["git", "rev-parse", "HEAD"],
        ["git", "rev-parse", "HEAD"],
      ]);
      // One land and one PR for the branch, not one per issue: what the work
      // sends out is the whole run's commits (T11, T12).
      expect(yield* Ref.get(scratch.worked)).toBe(1);
      // And it was handed what each issue came to, on `RunWork` and already
      // filled when it ran — which is the slot T77's land reads to know which
      // issues approved.
      expect(yield* Ref.get(scratch.workSaw)).toEqual([
        outcome("T70", APPROVED_OUTCOME),
        outcome("T71", APPROVED_OUTCOME),
        outcome("T72", APPROVED_OUTCOME),
      ]);

      const rows = yield* Ref.get(scratch.appended);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.terminalReason).toEqual(Option.some({ _tag: "Completed" }));
      expect(issuesOn(rows[0])).toEqual([
        outcome("T70", APPROVED_OUTCOME),
        outcome("T71", APPROVED_OUTCOME),
        outcome("T72", APPROVED_OUTCOME),
      ]);
      // The verdict slot stays empty: there is no one verdict on this arm.
      expect(rows[0]?.outcome).toEqual(Option.none());
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // **The boundary is read in the container, never by host git in the clone**
  // (T76 §1): the agent owns that clone's `.git/config`, and a `core.fsmonitor`
  // there runs a command on read-only operations too. The read after the loop
  // — the release's, about the copy's own tip — is the checkout's and is not
  // this (T38), which is why the snapshot is taken where the work begins.
  it.scoped("asks git nothing about the checkout while the sequence runs", () =>
    Effect.gen(function* () {
      const scratch = yield* world({ perIssue: { T70: approves() } });
      yield* run(scratch);

      const calls = yield* Ref.get(scratch.duringTheLoop);
      expect(calls).not.toEqual([]);
      // The only calls naming the copy at all are the checkout's own two
      // identity writes (T35), made before the container started. Nothing the
      // loop did is in this list — a `rev-parse` here would be the read this
      // ticket moved into the container.
      expect(
        calls
          .filter((call) => "repo" in call && call.repo === scratch.plan.checkoutPath)
          .map((call) => call._tag),
      ).toEqual(["SetConfig", "SetConfig"]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // T103, what follows from T101 with no code of its own: under `--hard-reset`
  // the plan's tip is the base, so the first issue's boundary falls back to it
  // and equals the diff boundary — the build-on sentence is absent there and
  // present from the second issue on, exactly as on a fresh branch.
  it.scoped("builds on nothing for the first issue of a reset run, and on it from the second", () =>
    Effect.gen(function* () {
      const scratch = yield* world({
        ids: ["T70", "T71"],
        perIssue: { T70: approves(), T71: approves() },
        resetting: true,
        // Nothing answered for the first issue, a later commit for the second.
        answers: ["", `${BOUNDARIES[1]}\n`],
      });
      yield* run(scratch);

      expect(scratch.plan.tipSha).toBe(RESET_BASE);
      expect(scratch.plan.mergeBaseSha).toBe(RESET_BASE);
      const seen = (yield* Ref.get(scratch.current)).flatMap((current) =>
        Option.isSome(current) ? [current.value] : [],
      );
      expect(seen.map(({ boundary }) => boundary)).toEqual([
        RESET_BASE,
        RESET_BASE,
        BOUNDARIES[1],
        BOUNDARIES[1],
      ]);
      const [first, , second] = seen;
      if (first === undefined || second === undefined) {
        throw new Error("expected a pass per issue");
      }
      const promptFor = (current: CurrentIssue) =>
        implementPromptFor(
          "# TASK",
          { ...scratch.plan, current: Option.some(current) },
          Option.none(),
        );
      expect(promptFor(first)).not.toContain("build on them");
      expect(promptFor(second)).toContain(
        `The branch already carries commits from earlier issues or runs of this feature — read them (git log ${RESET_BASE}..HEAD) and build on them; do not redo or undo them.`,
      );
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // The second criterion: a capped issue stops the sequence, and the run still
  // lands, still opens its PR, and still completes — what happened to each
  // issue is on the row (`run.sh:1889`).
  it.scoped("stops at the issue the review capped, leaving the rest not-attempted", () =>
    Effect.gen(function* () {
      const scratch = yield* world({
        maxReviewRounds: 2,
        perIssue: { T70: approves(), T71: { verdicts: ["needs-work"] } },
      });
      yield* run(scratch);

      const rows = yield* Ref.get(scratch.appended);
      expect(issuesOn(rows[0])).toEqual([
        outcome("T70", APPROVED_OUTCOME),
        outcome("T71", "needs-work"),
        outcome("T72", NOT_ATTEMPTED),
      ]);
      expect(rows[0]?.terminalReason).toEqual(Option.some({ _tag: "Completed" }));
      expect(yield* Ref.get(scratch.worked)).toBe(1);
      // What the work was handed is what the loop reached, tail and all: the
      // `not-attempted` fill is the row's, computed in the finalizer, so the
      // land sees the two issues that were decided and no third.
      expect(yield* Ref.get(scratch.workSaw)).toEqual([
        outcome("T70", APPROVED_OUTCOME),
        outcome("T71", "needs-work"),
      ]);
      // T72 was never asked anything: the sequence stopped above it.
      expect(yield* Ref.get(scratch.execs)).toHaveLength(2);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // A capped *fixing* round stops too, and for its own reason: the final
  // round's commits went unreviewed, so the next issue would build on work
  // nothing looked at (`run.sh:1868-1893`).
  it.scoped("stops on a capped fixing round, under its own token", () =>
    Effect.gen(function* () {
      const scratch = yield* world({
        maxReviewRounds: 1,
        perIssue: { T70: { verdicts: ["fixed"] } },
      });
      yield* run(scratch);

      expect(issuesOn((yield* Ref.get(scratch.appended))[0])).toEqual([
        outcome("T70", CAPPED_UNREVIEWED_FIX),
        outcome("T71", NOT_ATTEMPTED),
        outcome("T72", NOT_ATTEMPTED),
      ]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // The third criterion, and the ruling this ticket makes: **a failed pass is
  // the issue's outcome, not the run's error.** 05 Q16R settles retry, not
  // sequencing — the failure stops the sequence and the run goes on to land
  // what earlier issues left, which on this case is nothing.
  it.scoped("records a failed implement pass as the issue's outcome and lands anyway", () =>
    Effect.gen(function* () {
      const scratch = yield* world({
        perIssue: { T70: { implementFails: passFailure("the implement pass exited 1") } },
      });
      // T11's own land as the work here, because the claim is about what it
      // does on this path: the first issue failed, so nothing was committed,
      // and the land says so rather than failing (`run.sh:1589-1592`).
      const exit = yield* Effect.exit(
        runInScope(
          scratch.plan,
          scratch.repoRoot,
          TEST_CREDENTIAL,
          TEST_FORGE_REPO,
          ({ outcomes }) =>
            land(scratch.plan, scratch.repoRoot, outcomes).pipe(Effect.mapError(atStage("land"))),
        ).pipe(Effect.provide(scratch.layer)),
      );

      // The run did what a feature run does, so it completed (T76 §4).
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(
        (yield* Ref.get(scratch.events)).filter((event) => event._tag === "NothingToLand"),
      ).toHaveLength(1);
      const rows = yield* Ref.get(scratch.appended);
      expect(rows[0]?.terminalReason).toEqual(Option.some({ _tag: "Completed" }));
      expect(issuesOn(rows[0])).toEqual([
        outcome("T70", IMPLEMENT_FAILED),
        outcome("T71", NOT_ATTEMPTED),
        outcome("T72", NOT_ATTEMPTED),
      ]);
      // The pass still said it failed, once and in the log (T55): what the
      // loop caught is the typed error after the event, not the event.
      expect(
        (yield* Ref.get(scratch.events)).filter((event) => event._tag === "PassFailed"),
      ).toMatchObject([{ pass: "implement", issue: Option.some("T70") }]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // The fourth: the same shape one step later, which is the failure bash found
  // aborting a whole run over a 529 mid-review.
  it.scoped("records a failed review pass as review-failed and stops there", () =>
    Effect.gen(function* () {
      const scratch = yield* world({
        perIssue: {
          T70: approves(),
          T71: { reviewFails: passFailure("the review pass ended with an error result") },
        },
      });
      const exit = yield* Effect.exit(run(scratch));

      expect(Exit.isSuccess(exit)).toBe(true);
      expect(issuesOn((yield* Ref.get(scratch.appended))[0])).toEqual([
        outcome("T70", APPROVED_OUTCOME),
        outcome("T71", REVIEW_FAILED),
        outcome("T72", NOT_ATTEMPTED),
      ]);
      expect(yield* Ref.get(scratch.worked)).toBe(1);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // The fifth (matrix row 16): the kill lands with issue 2's implement pass in
  // flight. Nothing landed for that issue, so it is `not-attempted` like the
  // ones the sequence never reached — and the tail proves the row is built in
  // the finalizer, since no code after the stop ran at all.
  it.scoped("records the issue in flight as not-attempted when the run is interrupted", () =>
    Effect.gen(function* () {
      const held = yield* Deferred.make<void>();
      const scratch = yield* world({
        perIssue: { T70: approves(), T71: { implementHangs: held } },
      });
      const fiber = yield* Effect.fork(run(scratch));
      yield* Deferred.await(held);
      const exit = yield* Fiber.interrupt(fiber);

      expect(Exit.isInterrupted(exit)).toBe(true);
      const rows = yield* Ref.get(scratch.appended);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.terminalReason).toEqual(Option.some({ _tag: "Interrupted" }));
      expect(issuesOn(rows[0])).toEqual([
        outcome("T70", APPROVED_OUTCOME),
        outcome("T71", NOT_ATTEMPTED),
        outcome("T72", NOT_ATTEMPTED),
      ]);
      // The work never ran: an interrupt is not a stop the loop makes.
      expect(yield* Ref.get(scratch.worked)).toBe(0);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // The log's first line says which mode this run is and which issues it
  // selected (T76 §3) — the list is decided before the first pass, and a
  // reader afterwards reads it against the outcomes on the row.
  it.scoped("opens the run log with the mode and the ids", () =>
    Effect.gen(function* () {
      const scratch = yield* world();
      expect(runStartHeader(scratch.plan)).toBe(
        `== bessemer [${scratch.plan.slug}] run start: mode=feature issues=T70,T71,T72 branch=${BRANCH} boundary=${MERGE_BASE_SHA}`,
      );
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // And `status` renders the row this loop wrote exactly as it renders a
  // feature row from before this loop: the tally is per issue, and the column
  // already existed (`status/render.ts`, T2).
  it.scoped("renders its tally on the status screen", () =>
    Effect.gen(function* () {
      const scratch = yield* world({
        maxReviewRounds: 1,
        perIssue: { T70: approves(), T71: { verdicts: ["needs-work"] } },
      });
      yield* run(scratch);

      const screen = renderStatus({
        containers: { _tag: "Containers", running: [] },
        ledger: { _tag: "Runs", recent: yield* Ref.get(scratch.appended) },
        limit: 10,
        renderedAt: Date.parse("2026-01-01T01:00:00.000Z"),
      });
      expect(screen).toContain("T70✓ T71✗ T72✗");
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
});
