# T50 — The stream parser reads what the agent CLI prints

Status: Done (PR #10; no surprise — `548c7ed` records `Not-fixed: none`)
Type: AFK
Blocked by: none — can start immediately. Nothing imports it until
[T51](T51-the-agent-pass-narrates-as-it-runs.md).

<!--
[Ticket 20](../20-the-agent-pass-narrates-nothing.md)'s ruling, step 1 of 6: the replacement for
hae's `stream-filter.py` is a pure TypeScript module on the dispatching host. This ticket lands the
module and its tests with **no caller** — an expand step. The argv flip and the event changes that
consume it are T51, so this goes green on today's tree without touching `agent-cli.ts`,
`reporter.ts`, or any renderer.

Why a separate ticket: T41 taught this map that a ticket whose pieces only typecheck together does not
land. A pure fold over strings with a fixture typechecks alone.
-->

## What to build

**`src/agent/stream.ts`**: a fold over the JSONL lines `claude -p --output-format stream-json
--verbose` prints, producing narration lines as they arrive and the pass's result at the end.

### Types

```ts
export type NarrationLine =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "tool-use"; readonly tool: string; readonly brief: string };

export interface PassUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheWrite: number;
  readonly cacheRead: number;
  readonly turns: number;
  readonly costUsd: Option.Option<number>;
  readonly models: ReadonlyArray<string>;
}

export interface PassResult {
  readonly text: string;
  readonly isError: boolean;
  readonly usage: PassUsage;
}

export interface StreamState { /* opaque to callers; holds seen models and the result, if any */ }

export const initialStreamState: StreamState;
export const feed: (state: StreamState, raw: string) => readonly [StreamState, ReadonlyArray<NarrationLine>];
export const finish: (state: StreamState) => Option.Option<PassResult>;
```

A fold rather than a per-line function because `models` needs memory: the result's `modelUsage` keys
are preferred, and the `model` field seen on assistant events is the fallback when that key is
absent. The state is the only place that memory lives.

### Behaviour, per line

- **Blank line**: no output, state unchanged.
- **Not JSON**: one `text` line carrying the raw string. The CLI printed something plain; a reader
  sees it rather than losing it.
- **`type: "assistant"`**: remember `message.model` if new. For each block of `message.content`:
  - `text` → the block's text, trimmed, split on newlines, **one `text` line per line** (a blank
    line inside a block is a `text` line with empty `text`).
  - `tool_use` → one `tool-use` line: `tool` is `name` (`"?"` if missing); `brief` is the first
    present and non-empty of `input.command`, `input.file_path`, `input.path`, `input.pattern`,
    `input.description`, `input.prompt`, whitespace collapsed to single spaces, kept whole to 160
    chars and otherwise cut to 157 plus `...`. Empty when none is present.
  - `thinking` → nothing. Current CLIs send it empty with a signature.
  - any other block type → nothing.
- **`type: "result"`**: remembered as the result. No narration line.
- **Any other `type`** (`system`, `user`, `rate_limit_event`, anything future): nothing.

`finish` answers none when no result event arrived; otherwise `PassResult` with `text` from
`result` (empty string if absent), `isError` from `is_error` (false if absent), and usage:

- `input`/`output`/`cacheWrite`/`cacheRead` from `usage.input_tokens`, `usage.output_tokens`,
  `usage.cache_creation_input_tokens`, `usage.cache_read_input_tokens`; `turns` from `num_turns`.
  A missing or non-numeric field is `0`.
- `costUsd` some only when `total_cost_usd` is a number greater than 0. Subscription auth reports 0
  or nothing, and 0 rendered would read as free.
- `models`: `Object.keys(modelUsage)` when that object exists and is non-empty; otherwise the models
  seen on assistant events, in first-seen order.

Decode with `Schema` where a shape is asserted and plain `unknown` narrowing where it is optional —
the point is tolerance: **no line the CLI prints may throw.** A malformed `assistant` event (no
`message`, `content` not an array) produces nothing, not an error.

### Fixtures

Three files under `test/fixtures/stream-json/` (a new directory), hand-authored and read by the test.
The event shapes are the real ones below, observed on CLI 2.1.267 on 2026-09-10 with long fields
trimmed. **The files are the single source**: the test reads them and holds no inline copy.

**`pass.jsonl`** holds every line of the excerpt below, in its order, plus four lines the excerpt
lacks, each inserted just before the `result` line:

- an `assistant` line with a second `Bash` `tool_use` whose `input.command` is longer than 160 chars;
- an `assistant` line whose single `text` block has three lines, the middle one blank;
- one line that is not JSON;
- one line whose `type` is `"future_event"`.

The `result` line stays last.

```
{"type":"system","subtype":"init","cwd":"/work","model":"claude-haiku-4-5-20251001"}
{"type":"assistant","message":{"model":"claude-haiku-4-5-20251001","role":"assistant","content":[{"type":"thinking","thinking":"","signature":"…"}]}}
{"type":"assistant","message":{"model":"claude-haiku-4-5-20251001","role":"assistant","content":[{"type":"tool_use","id":"toolu_1","name":"Read","input":{"file_path":"/work/src/run-log.ts"}}]}}
{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_1","type":"tool_result","content":"1\t// The per-run log file…"}]}}
{"type":"assistant","message":{"model":"claude-haiku-4-5-20251001","role":"assistant","content":[{"type":"tool_use","id":"toolu_2","name":"Bash","input":{"command":"ls src","description":"List files"}}]}}
{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","overageStatus":"rejected"}}
{"type":"assistant","message":{"model":"claude-haiku-4-5-20251001","role":"assistant","content":[{"type":"text","text":"done"}]}}
{"type":"result","subtype":"success","is_error":false,"num_turns":3,"result":"done","total_cost_usd":0.0214608,"usage":{"input_tokens":18,"cache_creation_input_tokens":8068,"cache_read_input_tokens":40768,"output_tokens":246},"modelUsage":{"claude-haiku-4-5-20251001":{}}}
```

**`no-result.jsonl`**: `system`, one `assistant` `text` line, one `Read` `tool_use`. It has no
`result` line, so the none arm is covered.

**`error-result.jsonl`**: `system`, one `assistant` `text` line, and a `result` line with
`"is_error":true`, an error `result` text, no `modelUsage`, and `"total_cost_usd":0`. It covers
three things in one file: the error arm, the fallback to the models seen on assistant events, and
cost none at 0.

### Tests

`test/agent-stream.test.ts`, folding each fixture line by line and asserting the narration lines
and the `finish` value as plain values:

- the `Read` yields `{ kind: "tool-use", tool: "Read", brief: "/work/src/run-log.ts" }`
- the short `Bash` yields `brief: "ls src"` — `command` wins over `description`
- the long `Bash` command yields a `brief` of exactly 160 chars ending in `...`
- the three-line `text` block yields three `text` lines, the middle one with empty `text`
- the non-JSON line yields one `text` line with the raw string
- `system`, `user`, `rate_limit_event`, `thinking`, and `future_event` yield nothing
- `finish` on `pass.jsonl` is some, with `text: "done"`, `turns: 3`, `costUsd` some, and
  `models` equal to `["claude-haiku-4-5-20251001"]`
- `finish` on `no-result.jsonl` is none
- `finish` on `error-result.jsonl` has `isError: true`, `costUsd` none, and `models` taken from the
  assistant events
- no line of any fixture throws

## Effect wiring

No tag introduced or consumed; no layer composition changes. The module imports `Option` and
`Schema` from `effect` and nothing from this package. Nothing imports it yet.

## Acceptance criteria

- [ ] `src/agent/stream.ts` exports `initialStreamState`, `feed`, `finish`, `NarrationLine`,
      `PassUsage`, `PassResult`.
- [ ] Every line of the fixture folds without throwing, and the narration and result match the
      values above.
- [ ] A `tool-use` brief follows bash's `brief_input` exactly: key order `command`, `file_path`,
      `path`, `pattern`, `description`, `prompt`; whitespace collapsed; 160-char cap with `...`.
- [ ] A stream with no `result` event finishes as none; one with `is_error: true` finishes as some
      with `isError: true`.
- [ ] `costUsd` is none when `total_cost_usd` is absent or 0.
- [ ] `src/agent/agent-cli.ts`, `src/reporter.ts`, `src/run-log.ts`, and `src/app.ts` are unchanged.
- [ ] The suite passes.

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package.
