// `AgentCli`, recording (T15): every pass records and **no agent runs**.
//
// It is `AgentCliLive` with the one operation that leaves this process swapped
// underneath it — the `docker exec` that starts the CLI — because that is what
// "recording, not blindly no-op" means for this tag. A pass's read half is the
// prompt: which template won, the client's `project-context.md`, the
// dispatcher's feedback, and the message the task decides (T14, T17).
// All of that still happens, and the assembled prompt is still logged
// verbatim, so a dry run answers the question a dispatcher runs one for —
// *what exactly would this agent have been told* — with the bytes themselves
// rather than with a description of them.
//
// **The recording `Sandbox` is provided here rather than trusted to arrive**
// from the composition. Wiring alone would make "no agent runs" a property of
// how this layer happens to be composed; providing it makes it a property of
// the layer, so a later composition that paired this with a live `Sandbox`
// still starts nothing.
//
// What a recorded pass answers with is what the run's own logic makes of a
// pass that answered with nothing: `review` reads no verdict marker, which is
// `needs-work` (T24), and `describePr` finds no description block, which is
// the static body its caller already substitutes. Both come from the modules
// that own those questions — a rehearsal that invented an approval or a body
// would be the second derivation this ticket exists to delete.
//
// **A recorded pass answers with an empty result rather than printing
// nothing** (T51). Since the argv flipped to `--output-format stream-json`, a
// pass's answer is the `result` event's text and a stream that carries no such
// event is a failed pass — so a `Sandbox` that said nothing at all would turn
// every rehearsal into three failures. The one line is written here and not in
// `dry-run/sandbox.ts`: that layer also serves the setup hook, and what the
// agent CLI prints is behind *this* tag (ticket 20 §1).
import { type AgentCli, AgentCliLive } from "../agent/agent-cli.ts";
import type { PromptSource } from "../agent/prompt-source.ts";
import type { SpeepoboxConfig } from "../config/config.ts";
import { Effect, Layer } from "effect";
import { Reporter } from "../reporter.ts";
import { Sandbox, type SandboxShape } from "../sandbox/sandbox.ts";
import { recordingSandbox } from "./sandbox.ts";

// What a pass that never ran answers with: a `result` event whose text is
// empty, whose `is_error` is false, and whose every count is zero. The shape
// is the CLI's own (`agent/stream.ts` reads it), because the fold is the live
// one and a rehearsal must not get a second parser. No `modelUsage`: nothing
// was asked of any model, and a key here would name one that never ran.
const RECORDED_RESULT_LINE = JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  num_turns: 0,
  result: "",
  total_cost_usd: 0,
  usage: {
    input_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 0,
  },
});

// The recording `Sandbox` with that one line on the way out. `exec` records
// exactly as it did before — the command is said, its stdin is not — and then
// hands the caller the result event it would have read. **Every exec through
// this private `Sandbox` is an agent pass**: `AgentCli` runs nothing else, and
// the setup hook goes through the composition's own `Sandbox`, which is why
// this can answer for the CLI without knowing whose command it is.
const withRecordedResult = (sandbox: SandboxShape): SandboxShape => ({
  ...sandbox,
  exec: (handle, command, options) =>
    sandbox
      .exec(handle, command, options)
      .pipe(
        Effect.zipRight(
          options === undefined ? Effect.void : options.onOutput(RECORDED_RESULT_LINE),
        ),
      ),
});

export const SandboxAgentPassRecordingLive: Layer.Layer<Sandbox, never, Reporter> = Layer.effect(
  Sandbox,
  Effect.map(Reporter, (reporter) => withRecordedResult(recordingSandbox(reporter))),
);

export const AgentCliRecordingLive: Layer.Layer<
  AgentCli,
  never,
  SpeepoboxConfig | PromptSource | Reporter
> = AgentCliLive.pipe(Layer.provide(SandboxAgentPassRecordingLive));
