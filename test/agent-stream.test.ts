// `src/agent/stream.ts` against three hand-authored fixtures under
// `test/fixtures/stream-json/` (T50, ticket 20's ruling step 1 of 6). The
// files are the single source: every line asserted here is read out of them,
// never copied inline, so a fixture edit and this test cannot drift apart.
//
// No tag, no layer: the module is pure, so the fold runs directly against
// plain values.
import { describe, expect, it } from "@effect/vitest";
import { readFileSync } from "node:fs";
import { Option } from "effect";
import {
  feed,
  finish,
  initialStreamState,
  type NarrationLine,
  type PassResult,
  type StreamState,
} from "../src/agent/stream.ts";

const readFixture = (name: string): ReadonlyArray<string> =>
  readFileSync(new URL(`./fixtures/stream-json/${name}`, import.meta.url), "utf8").split("\n");

// The whole fold, run over one fixture's lines in order: the narration lines
// it produced, and the state `finish` reads.
const fold = (lines: ReadonlyArray<string>): [ReadonlyArray<NarrationLine>, StreamState] => {
  let state = initialStreamState;
  const narration: Array<NarrationLine> = [];
  for (const line of lines) {
    const [nextState, produced] = feed(state, line);
    expect(() => produced).not.toThrow();
    state = nextState;
    narration.push(...produced);
  }
  return [narration, state];
};

const LONG_BASH_BRIEF =
  'find /work/src -type f -name "*.test.ts" -exec grep -l describe_agent_stream {} ; | xargs -I{} sh -c "wc -l {} && echo --- && cat {}" | tee /tmp/agent-stream...';

describe("feed over pass.jsonl", () => {
  const [narration, state] = fold(readFixture("pass.jsonl"));

  it("narrates exactly the lines the excerpt and its four insertions produce, in order", () => {
    expect(narration).toEqual([
      { kind: "tool-use", tool: "Read", brief: "/work/src/run-log.ts" },
      { kind: "tool-use", tool: "Bash", brief: "ls src" },
      { kind: "text", text: "done" },
      { kind: "tool-use", tool: "Bash", brief: LONG_BASH_BRIEF },
      { kind: "text", text: "first line" },
      { kind: "text", text: "" },
      { kind: "text", text: "third line" },
      { kind: "text", text: "not json at all {" },
    ] satisfies ReadonlyArray<NarrationLine>);
  });

  it("caps the long Bash command's brief at exactly 160 chars, ending in '...'", () => {
    const long = narration.find(
      (line): line is Extract<NarrationLine, { kind: "tool-use" }> =>
        line.kind === "tool-use" && line.brief.length > 100,
    );
    expect(long?.brief).toHaveLength(160);
    expect(long?.brief.endsWith("...")).toBe(true);
  });

  it("finishes as the result event, with models read off modelUsage", () => {
    const result = finish(state);
    expect(Option.isSome(result)).toBe(true);
    const value = (result as Option.Some<PassResult>).value;
    expect(value.text).toBe("done");
    expect(value.isError).toBe(false);
    expect(value.usage.turns).toBe(3);
    expect(Option.isSome(value.usage.costUsd)).toBe(true);
    expect(value.usage.models).toEqual(["claude-haiku-4-5-20251001"]);
  });
});

describe("feed over no-result.jsonl", () => {
  it("finishes as none: no result event ever arrived", () => {
    const [, state] = fold(readFixture("no-result.jsonl"));
    expect(finish(state)).toEqual(Option.none());
  });
});

describe("feed over error-result.jsonl", () => {
  const [, state] = fold(readFixture("error-result.jsonl"));

  it("finishes with isError true, costUsd none at 0, and models from the assistant events", () => {
    const result = finish(state);
    expect(Option.isSome(result)).toBe(true);
    const value = (result as Option.Some<PassResult>).value;
    expect(value.isError).toBe(true);
    expect(Option.isNone(value.usage.costUsd)).toBe(true);
    expect(value.usage.models).toEqual(["claude-haiku-4-5-20251001"]);
  });
});

describe("per-line behaviour", () => {
  it("a blank line produces nothing and leaves the state unchanged", () => {
    const [state, produced] = feed(initialStreamState, "   ");
    expect(produced).toEqual([]);
    expect(state).toBe(initialStreamState);
  });

  it("system, user, rate_limit_event, and future_event lines produce nothing", () => {
    for (const type of ["system", "user", "rate_limit_event", "future_event"]) {
      const [, produced] = feed(initialStreamState, JSON.stringify({ type }));
      expect(produced).toEqual([]);
    }
  });

  it("a thinking block produces nothing", () => {
    const [, produced] = feed(
      initialStreamState,
      JSON.stringify({
        type: "assistant",
        message: {
          model: "m",
          role: "assistant",
          content: [{ type: "thinking", thinking: "", signature: "s" }],
        },
      }),
    );
    expect(produced).toEqual([]);
  });

  it("a malformed assistant event (no message, content not an array) produces nothing, never throws", () => {
    expect(() => feed(initialStreamState, JSON.stringify({ type: "assistant" }))).not.toThrow();
    expect(feed(initialStreamState, JSON.stringify({ type: "assistant" }))[1]).toEqual([]);

    const withBadContent = JSON.stringify({
      type: "assistant",
      message: { model: "m", content: "not an array" },
    });
    expect(() => feed(initialStreamState, withBadContent)).not.toThrow();
    expect(feed(initialStreamState, withBadContent)[1]).toEqual([]);
  });
});
