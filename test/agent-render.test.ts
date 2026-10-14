// `src/agent/render.ts` (T54): the console's narration vocabulary, as strings.
// Every line is asserted twice — against a disabled `colors`, which is the
// piped-to-a-file screen, and against an enabled one, which is the terminal's.
// The escape codes are spelled out rather than built from the same `colors`
// instance the renderer used: an expectation that calls `dim` to check `dim`
// passes whatever the renderer did.
import { describe, expect, it } from "@effect/vitest";
import { Duration, Option } from "effect";
import pc from "picocolors";
import { renderAgentEvent } from "../src/agent/render.ts";
import type { PassUsage } from "../src/agent/stream.ts";

const plain = pc.createColors(false);
const coloured = pc.createColors(true);

const dim = (text: string): string => `\u001B[2m${text}\u001B[22m`;
const red = (text: string): string => `\u001B[31m${text}\u001B[39m`;
const yellow = (text: string): string => `\u001B[33m${text}\u001B[39m`;

// T55's worked example, the same counts `test/run-log.test.ts` asserts the log
// line from: 18 + 246 + 8068 + 40768 is 49100, which is the `49.1k` the ticket
// prints.
const USAGE: PassUsage = {
  input: 18,
  output: 246,
  cacheWrite: 8068,
  cacheRead: 40768,
  turns: 3,
  costUsd: Option.some(0.0214608),
  models: ["claude-haiku-4-5-20251001"],
};

const usage = (over: Partial<PassUsage> = {}): PassUsage => ({ ...USAGE, ...over });

const finished = (over: Partial<PassUsage> = {}) =>
  ({
    _tag: "AgentPassFinished",
    pass: "implement",
    issue: Option.none(),
    elapsed: Duration.minutes(12),
    usage: usage(over),
  }) as const;

describe("tool use", () => {
  it("is the glyph, the tool, and the brief in parentheses", () => {
    const event = {
      _tag: "AgentOutput",
      pass: "implement",
      kind: "tool-use",
      tool: "Read",
      brief: "src/run-log.ts",
    } as const;
    expect(renderAgentEvent(event, plain)).toBe("* Read(src/run-log.ts)");
    expect(renderAgentEvent(event, coloured)).toBe(dim("⏺ Read(src/run-log.ts)"));
  });

  it("keeps a shell brief as the fold read it", () => {
    const event = {
      _tag: "AgentOutput",
      pass: "implement",
      kind: "tool-use",
      tool: "Bash",
      brief: "ls src",
    } as const;
    expect(renderAgentEvent(event, coloured)).toBe(dim("⏺ Bash(ls src)"));
  });

  // A tool called with nothing worth briefing is the bare name: empty
  // parentheses read as a brief the fold lost.
  it("renders an empty brief as the bare name", () => {
    const event = {
      _tag: "AgentOutput",
      pass: "implement",
      kind: "tool-use",
      tool: "Task",
      brief: "",
    } as const;
    expect(renderAgentEvent(event, plain)).toBe("* Task");
    expect(renderAgentEvent(event, coloured)).toBe(dim("⏺ Task"));
  });
});

describe("prose", () => {
  it("is indented two spaces, with no prefix and no colour", () => {
    const event = {
      _tag: "AgentOutput",
      pass: "implement",
      kind: "text",
      text: "Reading the spec first.",
    } as const;
    expect(renderAgentEvent(event, plain)).toBe("  Reading the spec first.");
    expect(renderAgentEvent(event, coloured)).toBe("  Reading the spec first.");
  });

  // The blank line inside a paragraph the agent wrote, and it carries no
  // indent: trailing whitespace is invisible until it lands in a diff.
  it("renders an empty line for an empty text", () => {
    const event = { _tag: "AgentOutput", pass: "implement", kind: "text", text: "" } as const;
    expect(renderAgentEvent(event, plain)).toBe("");
    expect(renderAgentEvent(event, coloured)).toBe("");
  });
});

describe("a pass start", () => {
  it("is a rule and today's sentence about the prompt", () => {
    const event = {
      _tag: "PromptAssembled",
      pass: "implement",
      prompt: "line one\nline two\nline three",
      root: "package",
      issue: Option.none(),
    } as const;
    expect(renderAgentEvent(event, plain)).toBe(
      [
        "-- implement pass --",
        "implement prompt assembled from the package default — 3 lines, verbatim in the run log",
      ].join("\n"),
    );
    expect(renderAgentEvent(event, coloured)).toBe(
      [
        dim("── implement pass ──"),
        dim(
          "implement prompt assembled from the package default — 3 lines, verbatim in the run log",
        ),
      ].join("\n"),
    );
  });

  it("names the client's root when the override won", () => {
    const event = {
      _tag: "PromptAssembled",
      pass: "review",
      prompt: "one line",
      root: "client",
      issue: Option.none(),
    } as const;
    expect(renderAgentEvent(event, plain)).toBe(
      [
        "-- review pass --",
        "review prompt assembled from the client override — 1 lines, verbatim in the run log",
      ].join("\n"),
    );
  });
});

describe("a pass end", () => {
  it("closes the rule with elapsed, tokens, and models", () => {
    expect(renderAgentEvent(finished({ costUsd: Option.none() }), plain)).toBe(
      "-- implement pass finished · 12m · 49.1k tokens · claude-haiku-4-5-20251001 --",
    );
    expect(renderAgentEvent(finished({ costUsd: Option.none() }), coloured)).toBe(
      dim("── implement pass finished · 12m · 49.1k tokens · claude-haiku-4-5-20251001 ──"),
    );
  });

  it("appends the cost when the CLI reported one", () => {
    expect(renderAgentEvent(finished(), plain)).toBe(
      "-- implement pass finished · 12m · 49.1k tokens · claude-haiku-4-5-20251001 · $0.02 --",
    );
    expect(renderAgentEvent(finished(), coloured)).toBe(
      dim("── implement pass finished · 12m · 49.1k tokens · claude-haiku-4-5-20251001 · $0.02 ──"),
    );
  });

  it("comma-joins the models a pass ran on", () => {
    expect(
      renderAgentEvent(
        finished({ models: ["claude-haiku-4-5-20251001", "claude-opus-4-1-20250805"] }),
        plain,
      ),
    ).toContain("· claude-haiku-4-5-20251001,claude-opus-4-1-20250805 ·");
  });

  // A pass that reported no model at all says nothing rather than leaving a
  // separator around an empty field — the rule is a sentence, not the log's
  // `models=-` record line.
  it("drops the field when no model was reported", () => {
    expect(renderAgentEvent(finished({ models: [] }), plain)).toBe(
      "-- implement pass finished · 12m · 49.1k tokens · $0.02 --",
    );
  });

  // The console's own renderer, deliberately not `status/render.ts`'s (T53):
  // that one is bash's COST column and rounds to `49k`.
  it("renders tokens at the three magnitudes", () => {
    const tokensOf = (input: number) =>
      renderAgentEvent(
        finished({ input, output: 0, cacheWrite: 0, cacheRead: 0, costUsd: Option.none() }),
        plain,
      );
    expect(tokensOf(1_234_567)).toContain("· 1.2M tokens ·");
    expect(tokensOf(49_100)).toContain("· 49.1k tokens ·");
    expect(tokensOf(812)).toContain("· 812 tokens ·");
  });
});

describe("a feature run's passes on the console", () => {
  // The same prefix the log opens its lines with (T76): the console draws this
  // rule three times per issue, and a rule that did not say which issue would
  // read as one pass repeating.
  it("opens the closing rule and the failure line with the issue", () => {
    expect(
      renderAgentEvent(
        { ...finished({ costUsd: Option.none() }), issue: Option.some("T70") },
        plain,
      ),
    ).toBe(
      "-- issue T70 implement pass finished · 12m · 49.1k tokens · claude-haiku-4-5-20251001 --",
    );
    expect(
      renderAgentEvent(
        {
          _tag: "PassFailed",
          pass: "implement",
          issue: Option.some("T70"),
          reason: "timed-out",
          detail: "timed out at 900s",
          elapsed: Duration.minutes(15),
          usage: Option.none(),
        } as const,
        plain,
      ),
    ).toBe("x issue T70 implement pass failed: timed out at 900s");
  });
});

describe("a pass failure", () => {
  it("is one red line carrying the error's own sentence", () => {
    const event = {
      _tag: "PassFailed",
      pass: "implement",
      issue: Option.none(),
      reason: "timed-out",
      detail: "timed out at 900s",
      elapsed: Duration.minutes(15),
      usage: Option.none(),
    } as const;
    expect(renderAgentEvent(event, plain)).toBe("x implement pass failed: timed out at 900s");
    expect(renderAgentEvent(event, coloured)).toBe(
      red("✗ implement pass failed: timed out at 900s"),
    );
  });
});

describe("the watch's two lines", () => {
  // The console's wording alone: the log keeps T52's `(4m, cap 15m)`.
  it("says the elapsed against the budget, dimmed", () => {
    const event = {
      _tag: "PassStillRunning",
      pass: "implement",
      elapsed: Duration.minutes(4),
      budget: Duration.minutes(15),
    } as const;
    expect(renderAgentEvent(event, plain)).toBe("... implement pass still running (4m of 15m)");
    expect(renderAgentEvent(event, coloured)).toBe(
      dim("… implement pass still running (4m of 15m)"),
    );
  });

  it("warns about a pass that has written nothing, with the sizing sentence under it", () => {
    const event = {
      _tag: "NoWritesYet",
      pass: "implement",
      elapsed: Duration.minutes(5),
      budget: Duration.minutes(15),
    } as const;
    const sizing =
      "usually a sizing problem: the ticket is too large, or it points at sources to consult instead of carrying the decisions and code shapes the agent needs";
    expect(renderAgentEvent(event, plain)).toBe(
      ["! no file written after 5m of a 15m budget — still reading", `  ${sizing}`].join("\n"),
    );
    expect(renderAgentEvent(event, coloured)).toBe(
      [
        yellow("⚠ no file written after 5m of a 15m budget — still reading"),
        yellow(`  ${sizing}`),
      ].join("\n"),
    );
  });
});

// The acceptance criterion as one case over all six events: a disabled
// `colors` is the piped screen, and nothing on it is an escape code.
describe("a disabled colors", () => {
  it("leaves no escape code on any of the six events", () => {
    const events = [
      {
        _tag: "PromptAssembled",
        pass: "implement",
        prompt: "one line",
        root: "package",
        issue: Option.none(),
      },
      { _tag: "AgentOutput", pass: "implement", kind: "tool-use", tool: "Read", brief: "/spec.md" },
      { _tag: "AgentOutput", pass: "implement", kind: "text", text: "Reading the spec first." },
      finished(),
      {
        _tag: "PassFailed",
        pass: "review",
        issue: Option.none(),
        reason: "exited",
        detail: "the agent CLI exited 1",
        elapsed: Duration.minutes(2),
        usage: Option.none(),
      },
      {
        _tag: "PassStillRunning",
        pass: "review",
        elapsed: Duration.minutes(4),
        budget: Duration.minutes(15),
      },
      {
        _tag: "NoWritesYet",
        pass: "implement",
        elapsed: Duration.minutes(5),
        budget: Duration.minutes(15),
      },
    ] as const;
    for (const event of events) {
      expect(renderAgentEvent(event, plain)).not.toContain("\u001B");
    }
  });
});
