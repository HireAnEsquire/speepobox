// The selection rules (T69), asserted as values: `select` is pure, so nothing
// here needs a layer and every case is a set of issues, a request, and an
// expected value.
//
// Two kinds of case sit side by side, as T68's suite has them. The
// hand-written ones pin one rule each, built through T68's parse so no case
// can assert on a shape a real file never produces; the ones reading
// `docs/wayfinder/effect-agentbox/issues/*.md` pin the wide predicate against
// the folder it will be pointed at.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Either, Schema } from "effect";
import { packageRoot } from "../src/config/paths.ts";
import { type Issue, fileNameOf, namesId, orderIssues, parseIssue } from "../src/issues/issue.ts";
import {
  IssueSelection,
  type SelectionRefusal,
  type SelectionRefused,
  type SelectionRequest,
  select,
} from "../src/issues/selection.ts";

const FOLDER = join("docs", "wayfinder", "effect-agentbox");

const ALL: SelectionRequest = { _tag: "All" };
const named = (...ids: ReadonlyArray<string>): SelectionRequest => ({ _tag: "Enumerated", ids });

const parsed = (stem: string, text: string): Issue => {
  const result = parseIssue(stem, text);
  if (Either.isLeft(result)) {
    throw new Error(`expected '${stem}' to parse: ${result.left.detail}`);
  }
  return result.right;
};

// A file's three headers, through the parse — `Blocked by:` spelled the way
// this folder spells it.
const issueOf = (stem: string, status: string, type: string, blockers: string): Issue =>
  parsed(
    stem,
    [`# ${stem}`, "", `Status: ${status}`, `Type: ${type}`, `Blocked by: ${blockers}`, ""].join(
      "\n",
    ),
  );

const ready = (stem: string, blockers = "none"): Issue =>
  issueOf(stem, "ready-for-agent", "AFK", blockers);
const done = (stem: string, blockers = "none"): Issue => issueOf(stem, "Done", "AFK", blockers);
const untriaged = (stem: string, blockers = "none"): Issue =>
  issueOf(stem, "needs-triage", "AFK", blockers);
const hitl = (stem: string, blockers = "none"): Issue =>
  issueOf(stem, "ready-for-agent", "HITL", blockers);

type Answer = Either.Either<
  Schema.Schema.Type<typeof IssueSelection>,
  InstanceType<typeof SelectionRefused>
>;

const selectedIds = (answer: Answer): Array<string> => {
  if (Either.isLeft(answer)) {
    throw new Error(`expected a selection, refused with ${answer.left.refusals.map(tagOf)}`);
  }
  return answer.right.issues.map((issue) => issue.id);
};

const tagOf = (refusal: SelectionRefusal): string => refusal._tag;

const refusalsOf = (answer: Answer): ReadonlyArray<SelectionRefusal> => {
  if (Either.isRight(answer)) {
    throw new Error(`expected a refusal, selected ${answer.right.issues.map((i) => i.id)}`);
  }
  return answer.left.refusals;
};

const oneRefusal = (answer: Answer): SelectionRefusal => {
  const refusals = refusalsOf(answer);
  expect(refusals).toHaveLength(1);
  return refusals[0] as SelectionRefusal;
};

describe("selecting every ready issue", () => {
  // The predicate 09 amended bash's to: the triage status, not *AFK and
  // not-yet-Done*. Everything a human has not looked at yet is `needs-triage`,
  // and `all` is consent to wideness typed before the list is seen.
  it("selects ready-for-agent AFK issues and leaves the untriaged ones alone", () => {
    const folder = [
      ready("T71-the-store"),
      untriaged("T80-nobody-has-read-this-yet"),
      hitl("T63-the-name-sweep"),
      done("T68-the-parse"),
      issueOf("T81-parked", "wontfix", "AFK", "none"),
      issueOf("T82-half-written", "needs-info", "AFK", "none"),
    ];
    expect(selectedIds(select(folder, ALL, FOLDER))).toStrictEqual(["T71"]);
  });

  // The fixed point, one round at a time: T73 is ready but blocked by an
  // untriaged issue, and T75 is ready and blocked only by T73 — so dropping
  // T73 has to strand T75 in a second round.
  it("drops what an untriaged blocker blocks, and what that strands", () => {
    const folder = [
      untriaged("T71-the-store"),
      ready("T73-the-dispatch", "T71"),
      ready("T75-the-passes", "T73"),
      ready("T70-the-fetch"),
    ];
    expect(selectedIds(select(folder, ALL, FOLDER))).toStrictEqual(["T70"]);
  });

  // The chain that survives: a ready head and a tail blocked only by it are
  // both selected, because a blocker **in the set** is satisfied by landing
  // earlier in the same run — which is the whole reason the order exists.
  it("selects a chain whose head is ready and whose tail is blocked only by the head", () => {
    const folder = [ready("T72-the-scan", "T71"), ready("T71-the-store", "T68")];
    expect(selectedIds(select([...folder, done("T68-the-parse")], ALL, FOLDER))).toStrictEqual([
      "T71",
      "T72",
    ]);
  });

  // An external blocker names no file in the folder, so nothing can ever
  // satisfy it (T68) — and the wide form says so by dropping, silently.
  it("drops an issue whose blocker is external, and one whose blocker is not in the folder", () => {
    const folder = [
      ready("T36-a-failed-runs-log-survives", "ticket 16"),
      ready("T83-blocked-on-a-ghost", "T99"),
      ready("T84-free"),
    ];
    expect(selectedIds(select(folder, ALL, FOLDER))).toStrictEqual(["T84"]);
  });

  it("refuses NothingReady, naming the folder, when nothing is ready", () => {
    const folder = [done("T68-the-parse"), untriaged("T80-nobody-has-read-this-yet")];
    expect(oneRefusal(select(folder, ALL, FOLDER))).toStrictEqual({
      _tag: "NothingReady",
      folder: FOLDER,
    });
    expect(oneRefusal(select([], ALL, FOLDER))._tag).toBe("NothingReady");
  });

  // Where the fixed point and a growth from the done set part company: two
  // ready issues blocking each other each have their blocker *in the set*, so
  // the shrink keeps both and the order is what refuses them.
  it("keeps a ready cycle whole, and refuses it as a cycle", () => {
    const cycle = select([ready("T1-first", "T2"), ready("T2-second", "T1")], ALL, FOLDER);
    expect(oneRefusal(cycle)).toStrictEqual({ _tag: "BlockerCycle", ids: ["T1", "T2"] });
  });
});

describe("selecting the issues a dispatcher named", () => {
  // Naming is the override (15's value-versus-policy line): the status a wide
  // selection reads is not a veto on a set the dispatcher typed out.
  it("selects an untriaged issue and a wontfix one when they are named", () => {
    const folder = [
      untriaged("T80-nobody-has-read-this-yet"),
      issueOf("T81-parked", "wontfix", "AFK", "none"),
    ];
    expect(selectedIds(select(folder, named("T80", "T81"), FOLDER))).toStrictEqual(["T80", "T81"]);
  });

  it("lets a bare number name the issue whose digits it is", () => {
    const folder = [done("T36-a-log"), ready("T37-a-mounted-spec")];
    expect(selectedIds(select(folder, named("37"), FOLDER))).toStrictEqual(["T37"]);
    // Two spellings of one issue are one issue, and run once.
    expect(selectedIds(select(folder, named("37", "T37"), FOLDER))).toStrictEqual(["T37"]);
  });

  // The order is T68's and not the dispatcher's typing order: one sequence,
  // decided here, for the loop and the plan and the ledger's tail to read.
  it("answers in T68's order, whatever order the ids arrived in", () => {
    const folder = [ready("T5-git-checkout"), ready("T3-dispatch-guards"), ready("T10-review")];
    expect(selectedIds(select(folder, named("T10", "T5", "T3"), FOLDER))).toStrictEqual([
      "T3",
      "T5",
      "T10",
    ]);
  });

  it("orders a named blocker before the issue it blocks", () => {
    const folder = [ready("T72-the-scan", "T71"), ready("T71-the-store")];
    expect(selectedIds(select(folder, named("T72", "T71"), FOLDER))).toStrictEqual(["T71", "T72"]);
  });

  it("refuses the dependent when only the dependent is named", () => {
    const folder = [ready("T72-the-scan", "T71"), ready("T71-the-store")];
    expect(oneRefusal(select(folder, named("T72"), FOLDER))).toStrictEqual({
      _tag: "BlockerViolation",
      pairs: [{ issue: folder[0], blocker: { id: "T71", token: "T71" } }],
    });
  });

  it("takes a blocker that is done on this ref as satisfied without naming it", () => {
    const folder = [ready("T71-the-store", "T68"), done("T68-the-parse")];
    expect(selectedIds(select(folder, named("T71"), FOLDER))).toStrictEqual(["T71"]);
  });

  // An external blocker is never satisfied, and the violation quotes the token
  // the file wrote — which is all there is to say about a blocker that names
  // no issue.
  it("refuses an external blocker by its token", () => {
    const folder = [ready("T36-a-failed-runs-log-survives", "ticket 16")];
    expect(oneRefusal(select(folder, named("T36"), FOLDER))).toStrictEqual({
      _tag: "BlockerViolation",
      pairs: [{ issue: folder[0], blocker: { id: "ticket", token: "ticket 16" } }],
    });
  });

  it("reports both unknown ids at once, with the folder's ids as the hint", () => {
    const folder = [ready("T71-the-store"), done("T68-the-parse"), untriaged("TEMPLATE")];
    expect(oneRefusal(select(folder, named("T91", "nope"), FOLDER))).toStrictEqual({
      _tag: "UnknownIssue",
      ids: ["T91", "nope"],
      known: ["T68", "T71", "TEMPLATE"],
    });
  });

  // All violations, not the first (`tasklib.py:313-330`): a dispatcher fixes
  // one command line rather than re-running to meet the next complaint.
  it("reports a done issue, a HITL issue, and an unmet blocker in one value", () => {
    const folder = [
      done("T68-the-parse"),
      hitl("T63-the-name-sweep"),
      ready("T72-the-scan", "T71"),
      untriaged("T71-the-store"),
    ];
    const refusals = refusalsOf(select(folder, named("T68", "T63", "T72"), FOLDER));
    expect(refusals.map(tagOf)).toStrictEqual(["AlreadyDone", "NotAfk", "BlockerViolation"]);
    expect(refusals).toStrictEqual([
      { _tag: "AlreadyDone", issues: [folder[0]] },
      { _tag: "NotAfk", issues: [folder[1]] },
      {
        _tag: "BlockerViolation",
        pairs: [{ issue: folder[2], blocker: { id: "T71", token: "T71" } }],
      },
    ]);
  });

  // Re-running landed work is refused rather than skipped: the dispatcher
  // named it, so the mismatch between what they believe and what the ref says
  // is the answer (14's one meaning of `done`).
  it("refuses a done issue rather than dropping it from the set", () => {
    const folder = [done("T68-the-parse"), ready("T71-the-store")];
    expect(refusalsOf(select(folder, named("T68", "T71"), FOLDER)).map(tagOf)).toStrictEqual([
      "AlreadyDone",
    ]);
  });

  it("refuses a named cycle as a cycle", () => {
    const folder = [ready("T1-first", "T2"), ready("T2-second", "T1")];
    expect(oneRefusal(select(folder, named("T1", "T2"), FOLDER))).toStrictEqual({
      _tag: "BlockerCycle",
      ids: ["T1", "T2"],
    });
  });
});

describe("the selection as a value", () => {
  it("carries the request that produced it, and each issue's file name", () => {
    const folder = [ready("T71-issuestore-reads-an-issue-set-out-of-a-ref")];
    const answer = select(folder, named("71"), FOLDER);
    if (Either.isLeft(answer)) {
      throw new Error("expected a selection");
    }
    expect(answer.right.request).toStrictEqual({ _tag: "Enumerated", ids: ["71"] });
    expect(answer.right.issues.map(fileNameOf)).toStrictEqual([
      "T71-issuestore-reads-an-issue-set-out-of-a-ref.md",
    ]);
  });

  // JSON for a future frontend is free (SPEC §5), which only holds if the
  // whole value goes through its Schema — including the status union's
  // `Unknown` arm, which is the one part of an `Issue` that is not a string.
  it("encodes and decodes through its Schema", () => {
    const folder = [
      ready("T71-the-store", "T68"),
      issueOf("T72-the-scan", "blocked (waiting on T71)", "AFK", "T71"),
      done("T68-the-parse"),
    ];
    const answer = select(folder, named("T71", "T72"), FOLDER);
    if (Either.isLeft(answer)) {
      throw new Error("expected a selection");
    }
    const encoded = Schema.encodeSync(IssueSelection)(answer.right);
    const round = Schema.decodeUnknownSync(IssueSelection)(JSON.parse(JSON.stringify(encoded)));
    expect(round).toStrictEqual(answer.right);
  });
});

// The wide predicate reached from the other side: start from nothing, add
// every ready AFK issue whose blockers are all done or already added, and
// repeat until nothing more can be added. `select` shrinks from above instead,
// and the two agree on every acyclic set — the one shape they part company on
// is the ready cycle the hand-written case above pins, which this growth never
// reaches and the shrink keeps whole.
const reachable = (issues: ReadonlyArray<Issue>): ReadonlyArray<Issue> => {
  const landed = (id: string): boolean =>
    issues.some((issue) => namesId(id, issue.id) && issue.status === "done");
  const added: Array<Issue> = [];
  for (;;) {
    const next = issues.filter(
      (issue) =>
        issue.type === "AFK" &&
        issue.status === "ready-for-agent" &&
        !added.includes(issue) &&
        issue.blockers.every(
          (blocker) => landed(blocker.id) || added.some((one) => namesId(blocker.id, one.id)),
        ),
    );
    if (next.length === 0) {
      return added;
    }
    added.push(...next);
  }
};

// The folder this ticket sits in is where `all` will be pointed, so the wide
// predicate is asserted against it rather than against fixtures alone. What is
// pinned is the **rule** and not a list of ids: the folder moves as tickets
// land, and a list would be red the day this one is stamped `Done`.
describe("this folder's own issue files", () => {
  const ISSUES_DIR = join(packageRoot, FOLDER, "issues");

  const folderIssues: ReadonlyArray<Issue> = readdirSync(ISSUES_DIR)
    .filter((name) => name.endsWith(".md"))
    .map((name) =>
      parsed(name.slice(0, -".md".length), readFileSync(join(ISSUES_DIR, name), "utf8")),
    );

  const answer = select(folderIssues, ALL, FOLDER);
  const ids = Either.isRight(answer) ? answer.right.issues.map((issue) => issue.id) : [];

  it("selects every ready issue this folder can reach through its done ones", () => {
    const expected = orderIssues(reachable(folderIssues));
    if (Either.isLeft(expected)) {
      throw new Error(`the folder has a blocker cycle on ${expected.left.ids.join(", ")}`);
    }
    expect(ids).toStrictEqual(expected.right.map((issue) => issue.id));
  });

  it("never selects the untriaged template every ticket opens as", () => {
    const template = folderIssues.find((issue) => issue.id === "TEMPLATE");
    expect(template?.status).toBe("needs-triage");
    expect(ids).not.toContain("TEMPLATE");
    for (const id of ids) {
      const issue = folderIssues.find((one) => one.id === id);
      expect([issue?.type, issue?.status]).toStrictEqual(["AFK", "ready-for-agent"]);
    }
  });
});
