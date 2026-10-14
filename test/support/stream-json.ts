// The JSONL a scripted `docker exec` prints, now that a pass runs under
// `--output-format stream-json --verbose` (T51). The event shapes are T50's
// fixtures' (`test/fixtures/stream-json/pass.jsonl`) reduced to the fields the
// fold reads, built here rather than read from a file: a case that scripts a
// pass needs *this* verdict or *that* description in the result, and a fixture
// is one fixed stream.
//
// It builds the CLI's side of the seam, so it belongs to whichever test
// scripts a docker — `agent-cli.test.ts` for the pass itself, `dry-run.test.ts`
// for the real stack it compares a rehearsal against.

import { Option } from "effect";
import type { PassUsage } from "../../src/agent/stream.ts";

// One model, named the same way in every scripted stream: which model answered
// is nothing this package decides, and a second name here would only make the
// lines longer.
const MODEL = "claude-haiku-4-5-20251001";

const assistantEvent = (content: ReadonlyArray<unknown>): string =>
  JSON.stringify({ type: "assistant", message: { model: MODEL, role: "assistant", content } });

// One line of the agent's prose.
export const narratesText = (text: string): string => assistantEvent([{ type: "text", text }]);

// One tool the agent reached for, and what `brief_input`'s first matching key
// holds (`agent/stream.ts`).
export const narratesToolUse = (tool: string, input: Readonly<Record<string, string>>): string =>
  assistantEvent([{ type: "tool_use", id: "toolu_1", name: tool, input }]);

// The pass's **answer**: the one event a verdict or a PR body may be read from.
export const answersWith = (text: string): string => resultEvent(text, false);

// The same event with the CLI saying it failed — a credential exhausted, a
// login gone. The pass ran and came back; what it came back with is an error.
export const answersWithError = (text: string): string => resultEvent(text, true);

const resultEvent = (text: string, isError: boolean): string =>
  JSON.stringify({
    type: "result",
    subtype: isError ? "error_during_execution" : "success",
    is_error: isError,
    num_turns: 2,
    result: text,
    total_cost_usd: 0.0214608,
    usage: {
      input_tokens: 18,
      cache_creation_input_tokens: 8068,
      cache_read_input_tokens: 40768,
      output_tokens: 246,
    },
    modelUsage: { [MODEL]: {} },
  });

// What the fold reads back out of that result event — the usage a scripted
// pass reports, so a case can assert the figure the terminal event carries
// without restating the JSON above (T55).
export const RESULT_USAGE: PassUsage = {
  input: 18,
  output: 246,
  cacheWrite: 8068,
  cacheRead: 40768,
  turns: 2,
  costUsd: Option.some(0.0214608),
  models: [MODEL],
};

// The lines as the CLI writes them: one JSON object per line, with the
// trailing newline a stream that ended cleanly has.
export const streamJson = (...lines: ReadonlyArray<string>): string => `${lines.join("\n")}\n`;
