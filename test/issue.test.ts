// The issue-file rules (T68), asserted as values: the module is pure, so
// nothing here needs a layer and every case is an input string and an expected
// value.
//
// Two kinds of case sit side by side on purpose. The hand-written ones pin one
// rule each; the ones reading `docs/wayfinder/effect-agentbox/issues/*.md` pin
// the rules against the folder they were taken from, which is the half that
// notices when the two drift.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Either, Option } from "effect";
import { packageRoot } from "../src/config/paths.ts";
import {
  type BlockerCycle,
  type Issue,
  type IssueStatus,
  TRIAGE_STATUSES,
  idIn,
  namesId,
  LANDED_STATUS,
  orderIssues,
  parseIssue,
  titleAfterId,
  titleNamesIssue,
  unknownStatus,
  withStatus,
} from "../src/issues/issue.ts";

const parsed = (stem: string, text: string): Issue => {
  const result = parseIssue(stem, text);
  if (Either.isLeft(result)) {
    throw new Error(`expected '${stem}' to parse: ${result.left.detail}`);
  }
  return result.right;
};

const statusOf = (text: string): IssueStatus => parsed("T1-a-file", text).status;

describe("parsing an issue file", () => {
  it("reads the three headers off the top of the file", () => {
    const issue = parsed(
      "T5-git-checkout",
      [
        "# T5 — Git checkout",
        "",
        "Status: ready-for-agent",
        "Type: HITL",
        "Blocked by: T3",
        "",
      ].join("\n"),
    );
    expect(issue.title).toBe("T5 — Git checkout");
    expect(issue.status).toBe("ready-for-agent");
    expect(issue.type).toBe("HITL");
    expect(issue.blockers).toStrictEqual([{ id: "T3", token: "T3" }]);
  });

  // Case, surrounding whitespace, and the space before the colon are all
  // tasklib's regex (`tasklib.py:178`), and this folder's files are written
  // the tidy way — so the case that matters is the one nobody writes.
  it("matches a header in any case, with whitespace around it", () => {
    const issue = parsed(
      "T5-git-checkout",
      ["  STATUS :  Done  ", "\ttype\t:\thitl", "BLOCKED BY :  T3 "].join("\n"),
    );
    expect(issue.status).toBe("done");
    // `hitl` and not `afk`: AFK is what an unread header defaults to, so
    // asserting it here would pass on a regex that matched none of this.
    expect(issue.type).toBe("HITL");
    expect(issue.blockers).toStrictEqual([{ id: "T3", token: "T3" }]);
  });

  // The cut-off is what keeps a ticket's prose from being read as its
  // metadata. A spec that pastes a header block, a `## Comments` section
  // quoting the status a run wrote — both are body, and a parse that read on
  // would take whichever of them came last as the file's own.
  it("stops at the first `##`, so a header below a section heading is body", () => {
    const issue = parsed(
      "T5-git-checkout",
      [
        "# T5 — Git checkout",
        "",
        "Type: HITL",
        "",
        "## What to build",
        "",
        "Status: done",
        "Blocked by: T3",
      ].join("\n"),
    );
    expect(issue.type).toBe("HITL");
    expect(issue.status).toBe("needs-triage");
    expect(issue.blockers).toStrictEqual([]);
  });

  // Where tasklib let a later header overwrite an earlier one
  // (`tasklib.py:190`), the first one wins here — and the reason is the
  // restamp, which rewrites the *first* `Status:` line. Under last-wins the
  // round trip below reads the stale line back and `markLanded` (T77) would
  // stamp a file that still parses as whatever it was.
  it("takes the first of two headers, which is the line the restamp rewrites", () => {
    const twice = [
      "# T5 — Git checkout",
      "",
      "Status: ready-for-agent",
      "Status: wontfix",
      "",
    ].join("\n");
    expect(statusOf(twice)).toBe("ready-for-agent");
    expect(parsed("T5-git-checkout", withStatus(twice, LANDED_STATUS)).status).toBe("done");
  });

  it("takes the title from the first `#` line, and the stem when there is none", () => {
    expect(parsed("T5-git-checkout", "# T5 — Git checkout\n# T6 — Sandbox\n").title).toBe(
      "T5 — Git checkout",
    );
    expect(parsed("T5-git-checkout", "Status: done\n").title).toBe("T5-git-checkout");
  });

  // Whether a title already names its issue is asked of its leading id, so a
  // longer id sharing the prefix does not count.
  it("knows whether a title already opens with the issue's id", () => {
    const named = (stem: string, text: string) => {
      const issue = parsed(stem, text);
      return [titleNamesIssue(issue), titleAfterId(issue)];
    };
    expect(named("T89-x", "# T89 — An exhausted resume\n")).toEqual([true, "An exhausted resume"]);
    expect(named("T89-an-exhausted-resume", "")).toEqual([true, "an-exhausted-resume"]);
    expect(named("t89-x", "# T89: Mixed case\n")).toEqual([true, "Mixed case"]);
    expect(named("03-x", "# Tidy the docs\n")).toEqual([false, "Tidy the docs"]);
    expect(named("T89-x", "# T890 — A longer id\n")).toEqual([false, "T890 — A longer id"]);
  });

  it("reads the id off the stem, up to its first `-`", () => {
    expect(parsed("T67-a-task-stated-on-the-command-line", "").id).toBe("T67");
    expect(parsed("03-behavior-inventory", "").id).toBe("03");
    expect(parsed("TEMPLATE", "").id).toBe("TEMPLATE");
  });

  // What bash recorded (`issues={"37": "approved"}`, 15) and what a dispatcher
  // types. The comparison is numeric, so a zero-padded id answers to its
  // number too.
  it("lets a bare number name an id whose digits are that number", () => {
    expect(namesId("37", "T37")).toBe(true);
    expect(namesId("t37", "T37")).toBe(true);
    expect(namesId("3", "03")).toBe(true);
    expect(namesId("3", "T37")).toBe(false);
    expect(namesId("ticket", "T16")).toBe(false);
  });

  it("reads the id out of a link, a dash spelling, and a bare token alike", () => {
    expect(idIn("[T66](T66-the-task-is-one-union.md) — the union")).toStrictEqual(
      Option.some("T66"),
    );
    expect(idIn("T66 — the union")).toStrictEqual(Option.some("T66"));
    expect(idIn("ticket 16")).toStrictEqual(Option.some("ticket"));
    expect(idIn("—")).toStrictEqual(Option.none());
  });

  it("defaults an absent Type to AFK and refuses one that is neither", () => {
    expect(parsed("T5-git-checkout", "Status: done\n").type).toBe("AFK");
    expect(parsed("T5-git-checkout", "Type:   \n").type).toBe("AFK");
    const refused = parseIssue("T5-git-checkout", "Type: SEMI-AFK\n");
    expect(Either.isLeft(refused)).toBe(true);
    if (Either.isLeft(refused)) {
      expect(refused.left.stem).toBe("T5-git-checkout");
      expect(refused.left.detail).toContain("T5-git-checkout.md");
      expect(refused.left.detail).toContain("SEMI-AFK");
    }
  });

  // Every label of `docs/agents/triage-labels.md`, each with the annotation a
  // human leaves on it — the whole reason the comparison is by first token.
  it("reads every triage status by its first token, annotation and all", () => {
    for (const label of TRIAGE_STATUSES) {
      expect(statusOf(`Status: ${label}\n`)).toBe(label);
      expect(statusOf(`Status: ${label.toUpperCase()} (verified 2026-08-07)\n`)).toBe(label);
    }
    expect(statusOf("Status: Done (PR #26; the plan's path had five readers)\n")).toBe("done");
  });

  // A stale spelling on one file must not refuse a dispatch of its neighbours,
  // so an unrecognised first token is an arm and not a parse error. `done-ish`
  // is the case tasklib's `done\b(?!-)` was written for.
  it("keeps an unrecognised first token as Unknown, with the header's text", () => {
    expect(statusOf("Status: done-ish\n")).toStrictEqual(unknownStatus("done-ish"));
    expect(statusOf("Status: blocked (waiting on T3)\n")).toStrictEqual(
      unknownStatus("blocked (waiting on T3)"),
    );
    expect(statusOf("")).toBe("needs-triage");
  });

  it("reads a Blocked by list through its link, dash, and bare spellings", () => {
    const issue = parsed(
      "T31-a-rescued-run-says-so-on-its-row",
      "Blocked by: [T13](T13-notifier.md) (the events), T28 — the redispatch, 29\n",
    );
    expect(issue.blockers).toStrictEqual([
      { id: "T13", token: "[T13](T13-notifier.md) (the events)" },
      { id: "T28", token: "T28 — the redispatch" },
      { id: "29", token: "29" },
    ]);
  });

  it("reads none, an em dash, a hyphen, and an absent header as no blockers", () => {
    for (const value of ["none", "none.", "None — can start immediately", "—", "-", "", "   "]) {
      expect(parsed("T1-skeleton", `Blocked by: ${value}\n`).blockers).toStrictEqual([]);
    }
    expect(parsed("T1-skeleton", "Status: done\n").blockers).toStrictEqual([]);
  });

  // Never satisfied, so `all` never selects the issue and enumerating it is a
  // violation naming the token (T69) — this is how 15 read T36's
  // `Blocked by: ticket 16`.
  it("keeps a token naming no issue verbatim, as an external blocker", () => {
    expect(
      parsed("T36-a-failed-runs-log-survives", "Blocked by: ticket 16\n").blockers,
    ).toStrictEqual([{ id: "ticket", token: "ticket 16" }]);
  });
});

// The folder this ticket sits in is the fixture: these three files are read as
// they are committed, so a rule that drifts from the headers it was taken from
// turns this suite red.
describe("this folder's own issue files", () => {
  const ISSUES_DIR = join(packageRoot, "docs", "wayfinder", "effect-agentbox", "issues");

  const fromFolder = (stem: string): Issue =>
    parsed(stem, readFileSync(join(ISSUES_DIR, `${stem}.md`), "utf8"));

  it("reads T66 as a done AFK issue with no blockers", () => {
    const issue = fromFolder("T66-the-task-is-one-union-and-resuming-is-the-identitys-fact");
    expect(issue.id).toBe("T66");
    expect(issue.title).toBe("T66 — The task is one union, and resuming is the identity's fact");
    expect(issue.status).toBe("done");
    expect(issue.type).toBe("AFK");
    expect(issue.blockers).toStrictEqual([]);
  });

  it("reads T67 as a done AFK issue blocked by T66", () => {
    const issue = fromFolder("T67-a-task-stated-on-the-command-line");
    expect(issue.id).toBe("T67");
    expect(issue.status).toBe("done");
    expect(issue.type).toBe("AFK");
    expect(issue.blockers.map((blocker) => blocker.id)).toStrictEqual(["T66"]);
  });

  it("reads TEMPLATE.md as a needs-triage AFK issue with no blockers", () => {
    const issue = fromFolder("TEMPLATE");
    expect(issue.id).toBe("TEMPLATE");
    expect(issue.status).toBe("needs-triage");
    expect(issue.type).toBe("AFK");
    expect(issue.blockers).toStrictEqual([]);
  });
});

// The order is Kahn's over whatever set it is handed; what earns a place in
// that set is the selection's question (T69), so every case here hands it one
// directly.
const blockedBy = (stem: string, blockers: string): Issue =>
  parsed(stem, `Blocked by: ${blockers}\n`);

const idsOf = (ordered: Either.Either<ReadonlyArray<Issue>, BlockerCycle>): Array<string> => {
  if (Either.isLeft(ordered)) {
    throw new Error(`expected an order, got a cycle on ${ordered.left.ids.join(", ")}`);
  }
  return ordered.right.map((one) => one.id);
};

describe("ordering a set by its blockers", () => {
  // Two independent middles: the diamond is the shape where an implementation
  // that emits one ready issue at a time can still be right by accident, and
  // the tie between them is where determinism is decided.
  it("orders a diamond deterministically, ties broken by id", () => {
    const diamond = [
      blockedBy("T4-the-join", "T3, T2"),
      blockedBy("T2-one-side", "T1"),
      blockedBy("T3-the-other", "T1"),
      blockedBy("T1-the-head", "none"),
    ];
    expect(idsOf(orderIssues(diamond))).toStrictEqual(["T1", "T2", "T3", "T4"]);
    // The input order is not the answer: the same set, shuffled, orders the
    // same way.
    expect(idsOf(orderIssues(diamond.toReversed()))).toStrictEqual(["T1", "T2", "T3", "T4"]);
  });

  it("breaks ties numerically where both ids carry digits and lexically otherwise", () => {
    const ready = [
      blockedBy("T10-ten", "none"),
      blockedBy("TEMPLATE", "none"),
      blockedBy("T9-nine", "none"),
      blockedBy("03-an-inventory", "none"),
    ];
    expect(idsOf(orderIssues(ready))).toStrictEqual(["03", "T9", "T10", "TEMPLATE"]);
  });

  it("lets a bare-number blocker name the issue whose digits it is", () => {
    const set = [blockedBy("T38-the-dependent", "37"), blockedBy("T37-a-mounted-spec", "none")];
    expect(idsOf(orderIssues(set))).toStrictEqual(["T37", "T38"]);
  });

  // A blocker outside the set is not a constraint — which covers the one
  // already landed on the base and the external token naming no issue at all.
  // Refusing on either is the selection's call (T69).
  it("does not let a blocker outside the set into the order", () => {
    const set = [
      blockedBy("T36-a-failed-runs-log-survives", "ticket 16"),
      blockedBy("T35-the-clone-carries-its-identity", "T27"),
    ];
    expect(idsOf(orderIssues(set))).toStrictEqual(["T35", "T36"]);
  });

  it("answers a cycle as a typed error naming every id on it", () => {
    const cycle = orderIssues([
      blockedBy("T2-second", "T3"),
      blockedBy("T3-third", "T1"),
      blockedBy("T1-first", "T2"),
    ]);
    expect(Either.isLeft(cycle)).toBe(true);
    if (Either.isLeft(cycle)) {
      expect(cycle.left._tag).toBe("BlockerCycle");
      expect(cycle.left.ids).toStrictEqual(["T1", "T2", "T3"]);
    }
  });

  // Nothing excludes an issue from its own set, so blocking yourself is a
  // cycle of one rather than a no-op.
  it("reads an issue that blocks itself as a cycle, and orders the rest of a clean set", () => {
    const cycle = orderIssues([blockedBy("T1-first", "T1")]);
    expect(Either.isLeft(cycle)).toBe(true);
    expect(idsOf(orderIssues([]))).toStrictEqual([]);
  });
});

// `cmd_set_status`'s three placements (`tasklib.py:363-388`). The contract the
// write half needs (T77) is the round trip, so every case here restamps and
// then parses the result back.
describe("restamping a file's Status line", () => {
  const TICKET = ["# T5 — Git checkout", "", "Status: ready-for-agent", "Type: AFK", ""].join("\n");

  it("rewrites the first Status line in place", () => {
    expect(withStatus(TICKET, LANDED_STATUS)).toBe(
      ["# T5 — Git checkout", "", "Status: Done", "Type: AFK", ""].join("\n"),
    );
  });

  // Above the heading and not below it: below it the header is body, so the
  // write would be invisible to the read.
  it("inserts the line before the first `##` when there is no Status line", () => {
    const text = ["# T5 — Git checkout", "", "Type: AFK", "", "## What to build", ""].join("\n");
    expect(withStatus(text, LANDED_STATUS)).toBe(
      ["# T5 — Git checkout", "", "Type: AFK", "", "Status: Done", "## What to build", ""].join(
        "\n",
      ),
    );
  });

  it("inserts the line second when the file has neither a Status line nor a `##`", () => {
    expect(withStatus("# T5 — Git checkout\nType: AFK\n", LANDED_STATUS)).toBe(
      "# T5 — Git checkout\nStatus: Done\nType: AFK\n",
    );
    expect(withStatus("", LANDED_STATUS)).toBe("Status: Done\n");
  });

  it("ends the result in exactly one newline, whatever it was handed", () => {
    expect(withStatus("# T5 — Git checkout\nStatus: done", LANDED_STATUS)).toBe(
      "# T5 — Git checkout\nStatus: Done\n",
    );
    expect(withStatus(TICKET, LANDED_STATUS).endsWith("Type: AFK\n")).toBe(true);
  });

  // The write half runs on approval, and a resumed run can approve an issue
  // whose file is already stamped (T77): restamping what is already there has
  // to be a no-op, or the status commit is a diff of nothing.
  it("is idempotent — restamping Done over Done changes nothing", () => {
    const landed = withStatus(TICKET, LANDED_STATUS);
    expect(withStatus(landed, LANDED_STATUS)).toBe(landed);
  });

  // The whole contract in one line, over the whole vocabulary: what the
  // restamp writes is what the parse reads back.
  it("reads every status back through the parse", () => {
    for (const label of TRIAGE_STATUSES) {
      expect(parsed("T5-git-checkout", withStatus(TICKET, label)).status).toBe(label);
    }
    expect(parsed("T5-git-checkout", withStatus(TICKET, LANDED_STATUS)).status).toBe("done");
  });

  // An annotated status is what the restamp overwrites in practice, and the
  // rest of the header block survives it.
  it("replaces an annotated status without disturbing the other headers", () => {
    const annotated = parsed(
      "T66-the-task-is-one-union",
      withStatus(
        ["# T66 — The union", "", "Status: Done (PR #26; five readers)", "Blocked by: T5", ""].join(
          "\n",
        ),
        "ready-for-agent",
      ),
    );
    expect(annotated.status).toBe("ready-for-agent");
    expect(annotated.title).toBe("T66 — The union");
    expect(annotated.blockers).toStrictEqual([{ id: "T5", token: "T5" }]);
  });
});
