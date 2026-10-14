# T54 — The console reads like Claude Code

Status: Done (PR #15; the ASCII fallback keys off `colors.isColorSupported` (`src/agent/render.ts:105`),
not the "stdout is not a TTY" the ticket's glyph table names, so `NO_COLOR=1` on a terminal drops the
glyphs as well as the colour — forced by the ticket's own "add no detection of your own")
Type: AFK
Blocked by: [T52](T52-a-long-pass-says-it-is-still-running.md) and, through it,
[T55](T55-a-pass-end-says-what-happened-and-what-it-cost.md). Those two tickets add the last three
of the six events this renders, and all three tickets edit `renderConsoleEvent`.

<!--
[Ticket 20](../20-the-agent-pass-narrates-nothing.md)'s ruling, step 6 of 6. The console prints
screens; the log (`run-log.ts`) prints a record. From T51 on, the screen is a live narration. Bash
never worried about how that looked. The user's standing preference (20, round 3) is that it does,
with Claude Code's own UI as the reference.

**This ticket does not touch the log.** Its `agent | ` / `agent > ` vocabulary is what grep and the
parity oracle read.

This ticket was first written to render T52's two events only "if T52 has landed". The
`/to-tickets` review of 2026-09-11 made it blocked by T52 instead, so its scope does not depend on
what has merged.
-->

## What to build

### `src/agent/render.ts`

Pure functions over the narration and pass events, tested as strings, beside `doctor/render.ts` and
`dispatch/render.ts`. `app.ts`'s `renderConsoleEvent` delegates to it for six events:

- `PromptAssembled`
- `AgentOutput`
- `AgentPassFinished`
- `PassFailed`
- `PassStillRunning`
- `NoWritesYet`

Nothing else in `app.ts` changes.

### Vocabulary

- **Tool use**: `⏺ Read(src/run-log.ts)`, `⏺ Bash(ls src)` — glyph, space, tool name, then the
  brief in parentheses. An empty brief renders as the bare name, `⏺ Task`. Dim.
- **Prose**: two-space indent, no prefix, normal weight. An empty `text` renders an empty line, so a
  block reads as a paragraph.
- **Pass start** (`PromptAssembled`): a rule, `── implement pass ──`, followed by today's sentence
  about where the prompt came from and that it is verbatim in the log, dim.
- **Pass end** (`AgentPassFinished`): `── implement pass finished · 12m · 49.1k tokens ·
  claude-haiku-4-5-20251001 ──`.
  - Elapsed uses T55's renderer.
  - Tokens are the four counts summed, rendered as `1.2M`, `49.1k`, or `812`.
  - This is **not** `status/render.ts`'s token renderer, and does not become it. That one is bash's
    COST column — `49k`, no decimal — pinned to bash's own rendering by T53, and a unification
    that gave it a decimal would break the parity it exists for. Two renderers on purpose.
  - Models are comma-joined.
  - `· $0.02` is appended when `costUsd` is some.
- **Pass failed** (`PassFailed`): `✗ implement pass failed: timed out at 900s` in red. This is
  T55's short console form; the stderr exit line is not this file's.
- **Heartbeat** (`PassStillRunning`): `… implement pass still running (4m of 15m)`, dim. T52 shipped
  this event reading `... implement pass still running (4m, cap 30m)` in both renderers; the log
  keeps that wording, and only the console's changes here.
- **No writes** (`NoWritesYet`): `⚠ no file written after 5m of a 15m budget — still reading` in
  yellow, then the sizing sentence indented under it.
- **`WARN`** lines elsewhere in `app.ts` are not this ticket's. `WARN_CONTINUATION` may move into
  `render.ts` if the no-writes line reuses it.

Glyphs fall back to ASCII when stdout is not a TTY:

| Glyph | ASCII fallback |
| --- | --- |
| `⏺` | `*` |
| `✗` | `x` |
| `⚠` | `!` |
| `…` | `...` |
| `──` | `--` |

### Colour

`picocolors` becomes a **direct dependency** in `package.json`. It is already in the tree under
`@clack/prompts`; pin `1.1.1`, the version the lockfile resolves. It detects a TTY and honours
`NO_COLOR` on its own, so add no detection of your own.

- Dim: tool use, rules, and the heartbeat.
- Red: `PassFailed`.
- Yellow: `NoWritesYet`.

Nothing else is coloured.

`render.ts` takes a `colors` argument (`picocolors`' `createColors(enabled)`) so the tests can
assert both the coloured and the plain string without setting environment variables. `app.ts`
passes the default instance.

### Not built

- No in-place spinner or status line: rewriting fights interleaved narration.
- No collapsing of consecutive reads: the renderer prints one event at a time and keeps no state.
- No change to the doctor rows, the plan block, or `status`.

## Tests

`test/agent-render.test.ts`:

- one case per vocabulary line above, plain and coloured;
- the TTY-fallback glyphs;
- token rendering at the three magnitudes;
- the pass-end rule with and without cost.

No existing assertion moves. The suite's only `agent > ` assertion (`agent-cli.test.ts:558`) is on
the **log**, which this ticket leaves byte-identical.

## Effect wiring

No tag is introduced or consumed, and no layer composition changes. `ReporterConsoleLive` still
calls one `renderConsoleEvent`, which now delegates.

## Acceptance criteria

- [ ] `render.ts` renders each of the six events to the strings above, with ASCII glyphs and no
      escape codes when given a disabled `colors`.
- [ ] Each pass opens and closes with a rule, and the closing rule carries elapsed, tokens, and
      models.
- [ ] A failed pass renders one red `✗` line.
- [ ] `picocolors` is a direct dependency, and a disabled `colors` produces no escape codes.
- [ ] `run-log.ts` is unchanged, and no run-log assertion changes.
- [ ] The suite passes.

## Verify

```
npm run verify
```

Run from the repo root. This is the gate: typecheck (with Effect diagnostics: **errors and warnings
break the build**; suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package.

**Host-only**, for the dispatcher after merge:

1. On a TTY, run one dispatch. Tool use prints as dimmed `⏺ Tool(brief)` and prose prints as
   indented text.
2. Run one dispatch piped to a file. The same lines print with ASCII glyphs and no escape codes.
3. With `NO_COLOR=1`, nothing is coloured.
