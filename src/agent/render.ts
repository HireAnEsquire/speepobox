// The console's narration vocabulary (T54, ticket 20's ruling step 6 of 6):
// pure functions over the six events a pass emits, beside `doctor/render.ts`
// and `dispatch/render.ts` and subscribed the same way. `app.ts` delegates to
// it and keeps the rest of its switch.
//
// **The console prints screens; the log prints a record** (20). Nothing
// here is the log's line: `run-log.ts` keeps its `agent | ` / `agent > `
// vocabulary, which is what grep and the parity oracle read, and the two
// renderers' wordings diverge on purpose — most visibly on the heartbeat,
// where the log says bash's `(4m, cap 15m)` and this says `(4m of 15m)`.
//
// No state and no rewriting: one event in, one string out. A spinner or an
// in-place status line would fight the narration interleaved around it, and
// collapsing consecutive reads would need memory this does not have.
import { Option } from "effect";
import type pc from "picocolors";
import type { ReporterEvent } from "../reporter.ts";
import { issuePrefix, renderElapsed } from "../run-log.ts";
import { promptRootLabel } from "./prompt-source.ts";
import type { PassUsage } from "./stream.ts";

// `picocolors`' `createColors(enabled)`, taken as an argument rather than
// imported as the default instance: the tests assert the coloured and the
// plain string without setting an environment variable. The library detects a
// TTY and honours `NO_COLOR` itself, so this file adds no detection of its own
// and asks the instance it was handed which screen it is drawing.
export type Colors = ReturnType<typeof pc.createColors>;

// The six events this file renders. `app.ts` holds the other arms.
export type AgentConsoleEvent = Extract<
  ReporterEvent,
  {
    _tag:
      | "PromptAssembled"
      | "AgentOutput"
      | "AgentPassFinished"
      | "PassFailed"
      | "PassStillRunning"
      | "NoWritesYet";
  }
>;

interface Glyphs {
  readonly tool: string;
  readonly failed: string;
  readonly warning: string;
  readonly running: string;
  readonly rule: string;
}

const UNICODE: Glyphs = {
  tool: "⏺",
  failed: "✗",
  warning: "⚠",
  running: "…",
  rule: "──",
};

// The fallback for a screen that is not a terminal — a log a dispatcher piped
// to a file, a CI job's captured output. It rides on `isColorSupported`
// because that is the one detection this file is allowed to consult: a screen
// that takes no colour is a screen to keep to ASCII.
const ASCII: Glyphs = {
  tool: "*",
  failed: "x",
  warning: "!",
  running: "...",
  rule: "--",
};

// Prose is indented rather than prefixed, so a block of it reads as a
// paragraph rather than as a column of markers. The sizing sentence sits at
// the same indent, under the warning it explains.
const PROSE_INDENT = "  ";

// Sized as this renderer's own decimal figures (T53): **not**
// `status/render.ts`'s token renderer and not becoming it. That one is bash's
// COST column, `49k` with no decimal, pinned to bash's rendering by the parity
// it exists for — a unification that gave it a decimal would break that.
const TOKENS_MILLION = 1_000_000;
const TOKENS_THOUSAND = 1_000;

const renderTokens = (tokens: number): string => {
  if (tokens >= TOKENS_MILLION) {
    return `${(tokens / TOKENS_MILLION).toFixed(1)}M`;
  }
  return tokens >= TOKENS_THOUSAND
    ? `${(tokens / TOKENS_THOUSAND).toFixed(1)}k`
    : `${Math.trunc(tokens)}`;
};

// What the pass moved, as one figure: the four counts summed. The row keeps
// them apart (T53) and a reader watching a pass end wants the total.
const totalTokens = (usage: PassUsage): number =>
  usage.input + usage.output + usage.cacheWrite + usage.cacheRead;

const rule = (glyphs: Glyphs, text: string): string => `${glyphs.rule} ${text} ${glyphs.rule}`;

// The sentence bash says under its no-writes warning (`run.sh:1495-1497`), and
// the one that says what to do about the line above it.
const SIZING =
  "usually a sizing problem: the ticket is too large, or it points at sources to consult instead of carrying the decisions and code shapes the agent needs";

export const renderAgentEvent = (event: AgentConsoleEvent, colors: Colors): string => {
  const glyphs = colors.isColorSupported ? UNICODE : ASCII;
  switch (event._tag) {
    // A pass opens with a rule and closes with one, so a long screen reads as
    // passes rather than as one stream. The sentence under it is the one
    // `app.ts` already said — the prompt is verbatim in the log, and which
    // root the template came from is what a client reads to see their
    // override take (T14).
    case "PromptAssembled":
      return [
        colors.dim(rule(glyphs, `${event.pass} pass`)),
        colors.dim(
          `${event.pass} prompt assembled from the ${promptRootLabel(event.root)} — ${event.prompt.split("\n").length} lines, verbatim in the run log`,
        ),
      ].join("\n");
    // Prose is what the agent said and is left at normal weight; a tool use is
    // what it did, dimmed, in the shape Claude Code's own screen uses. An
    // empty brief renders the bare name — empty parentheses read as a brief
    // the fold dropped — and an empty text renders an empty line, carrying no
    // indent, because trailing whitespace is invisible until it lands in a
    // diff.
    case "AgentOutput":
      return event.kind === "text"
        ? event.text === ""
          ? ""
          : `${PROSE_INDENT}${event.text}`
        : colors.dim(`${glyphs.tool} ${event.tool}${event.brief === "" ? "" : `(${event.brief})`}`);
    // The closing rule carries what the pass cost: elapsed through T55's own
    // renderer, the token total, the models, and the price when the CLI
    // reported one. An empty `models` drops its field rather than leaving
    // separators around nothing — this is a sentence, not the log's
    // `models=-` record line.
    //
    // Which issue the pass was for opens the rule when there is one (T76),
    // through the one spelling `run-log.ts` holds: a feature run draws this
    // rule three times per issue.
    case "AgentPassFinished":
      return colors.dim(
        rule(
          glyphs,
          [
            `${issuePrefix(event.issue)}${event.pass} pass finished`,
            renderElapsed(event.elapsed),
            `${renderTokens(totalTokens(event.usage))} tokens`,
            ...(event.usage.models.length === 0 ? [] : [event.usage.models.join(",")]),
            ...Option.match(event.usage.costUsd, {
              onNone: () => [],
              onSome: (cost) => [`$${cost.toFixed(2)}`],
            }),
          ].join(" · "),
        ),
      );
    // The short console form (T55): the detail alone, because it is the
    // sentence that says what to do next. The stderr exit line at the end of
    // the run is `dispatch/render.ts`'s and is not this.
    case "PassFailed":
      return colors.red(
        `${glyphs.failed} ${issuePrefix(event.issue)}${event.pass} pass failed: ${event.detail}`,
      );
    // The heartbeat (T52), dimmed because it is the one line here that says
    // nothing new — only that the pass is alive. The log keeps bash's
    // `(4m, cap 15m)`; the console reads as a sentence.
    case "PassStillRunning":
      return colors.dim(
        `${glyphs.running} ${event.pass} pass still running (${renderElapsed(event.elapsed)} of ${renderElapsed(event.budget)})`,
      );
    // The sizing advisory, and yellow rather than red because it is an
    // advisory: the agent that reads longest is often the one about to write
    // the most.
    case "NoWritesYet":
      return [
        colors.yellow(
          `${glyphs.warning} no file written after ${renderElapsed(event.elapsed)} of a ${renderElapsed(event.budget)} budget — still reading`,
        ),
        colors.yellow(`${PROSE_INDENT}${SIZING}`),
      ].join("\n");
  }
};
