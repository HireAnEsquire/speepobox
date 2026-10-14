// The stream parser: a fold over the JSONL lines `claude -p --output-format
// stream-json --verbose` prints, replacing hae's `stream-filter.py` (ticket
// 20, ruling step 1 of 6). It has no caller yet — the argv flip and the event
// changes that consume it are T51 — so this file is a pure module: no tag, no
// layer, nothing from this package.
//
// A fold rather than a per-line function because `models` needs memory: the
// result's `modelUsage` keys are preferred, and the `model` field seen on
// assistant events is the fallback when that key is absent. `StreamState` is
// the only place that memory lives.
//
// Tolerance is the point: no line the CLI prints may throw. A blank line, a
// line that is not JSON, and a well-formed event of a shape this module does
// not expect are all readable outcomes, never exceptions — a decode failure
// on one block or one field skips that block or field, not the whole line.
import { Option, Schema } from "effect";

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

// Opaque to callers: the models seen on assistant events, first-seen order,
// and the result event if one has arrived yet.
export interface StreamState {
  readonly seenModels: ReadonlyArray<string>;
  readonly result: Option.Option<PassResult>;
}

export const initialStreamState: StreamState = {
  seenModels: [],
  result: Option.none(),
};

// --- narrow, tolerant readers over `unknown` --------------------------------

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const asNumber = (value: unknown): number => (typeof value === "number" ? value : 0);

const tryParseJson = (raw: string): Option.Option<unknown> => {
  try {
    return Option.some(JSON.parse(raw) as unknown);
  } catch {
    return Option.none();
  }
};

// --- content blocks: the shape asserted with Schema -------------------------
//
// Each block type this module acts on gets its own schema and its own
// decoder, tried in turn — a `thinking` block, a future block type, and a
// `text` or `tool_use` block whose fields don't match its own schema all fall
// through the same way, to the "nothing" arm below.
const TextBlock = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
});

const ToolUseBlock = Schema.Struct({
  type: Schema.Literal("tool_use"),
  name: Schema.optional(Schema.String),
  input: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
});

const decodeTextBlock = Schema.decodeUnknownOption(TextBlock);
const decodeToolUseBlock = Schema.decodeUnknownOption(ToolUseBlock);

// bash's `brief_input`, verbatim key order: `command` wins over
// `description`, and every field is whitespace-collapsed and length-capped
// the same way regardless of which key produced it.
const BRIEF_KEYS = ["command", "file_path", "path", "pattern", "description", "prompt"] as const;
const BRIEF_KEPT_WHOLE = 160;
const BRIEF_CUT_TO = 157;

const collapseWhitespace = (text: string): string => text.replace(/\s+/g, " ").trim();

const briefFor = (input: Readonly<Record<string, unknown>>): string => {
  for (const key of BRIEF_KEYS) {
    const collapsed = collapseWhitespace(asString(input[key]) ?? "");
    if (collapsed.length > 0) {
      return collapsed.length <= BRIEF_KEPT_WHOLE
        ? collapsed
        : `${collapsed.slice(0, BRIEF_CUT_TO)}...`;
    }
  }
  return "";
};

const narrateBlock = (block: unknown): ReadonlyArray<NarrationLine> => {
  const text = decodeTextBlock(block);
  if (Option.isSome(text)) {
    return text.value.text
      .trim()
      .split("\n")
      .map((line): NarrationLine => ({ kind: "text", text: line }));
  }
  const toolUse = decodeToolUseBlock(block);
  if (Option.isSome(toolUse)) {
    return [
      {
        kind: "tool-use",
        tool: toolUse.value.name ?? "?",
        brief: briefFor(toolUse.value.input ?? {}),
      },
    ];
  }
  // `thinking` and anything else: current CLIs send `thinking` empty with a
  // signature, and a future block type is unknown vocabulary either way.
  return [];
};

// --- the "assistant" event ---------------------------------------------------

const narrateAssistant = (
  event: Record<string, unknown>,
  state: StreamState,
): readonly [StreamState, ReadonlyArray<NarrationLine>] => {
  const message = asRecord(event.message);
  if (message === undefined) {
    return [state, []];
  }
  const model = asString(message.model);
  const seenModels =
    model !== undefined && !state.seenModels.includes(model)
      ? [...state.seenModels, model]
      : state.seenModels;
  const nextState: StreamState = { ...state, seenModels };
  const content = message.content;
  if (!Array.isArray(content)) {
    return [nextState, []];
  }
  return [nextState, content.flatMap(narrateBlock)];
};

// --- the "result" event ------------------------------------------------------

const resultFor = (
  event: Record<string, unknown>,
  seenModels: ReadonlyArray<string>,
): PassResult => {
  const usageRecord = asRecord(event.usage) ?? {};
  const modelUsage = asRecord(event.modelUsage);
  const models =
    modelUsage !== undefined && Object.keys(modelUsage).length > 0
      ? Object.keys(modelUsage)
      : seenModels;
  const totalCostUsd = event.total_cost_usd;
  return {
    text: asString(event.result) ?? "",
    isError: event.is_error === true,
    usage: {
      input: asNumber(usageRecord.input_tokens),
      output: asNumber(usageRecord.output_tokens),
      cacheWrite: asNumber(usageRecord.cache_creation_input_tokens),
      cacheRead: asNumber(usageRecord.cache_read_input_tokens),
      turns: asNumber(event.num_turns),
      costUsd:
        typeof totalCostUsd === "number" && totalCostUsd > 0
          ? Option.some(totalCostUsd)
          : Option.none(),
      models,
    },
  };
};

// --- the fold -----------------------------------------------------------------

export const feed = (
  state: StreamState,
  raw: string,
): readonly [StreamState, ReadonlyArray<NarrationLine>] => {
  if (raw.trim().length === 0) {
    return [state, []];
  }
  const parsed = tryParseJson(raw);
  if (Option.isNone(parsed)) {
    return [state, [{ kind: "text", text: raw }]];
  }
  const event = asRecord(parsed.value);
  const type = event !== undefined ? asString(event.type) : undefined;
  if (event === undefined || type === undefined) {
    return [state, []];
  }
  if (type === "assistant") {
    return narrateAssistant(event, state);
  }
  if (type === "result") {
    return [{ ...state, result: Option.some(resultFor(event, state.seenModels)) }, []];
  }
  return [state, []];
};

export const finish = (state: StreamState): Option.Option<PassResult> => state.result;
