# T55 — A pass's end says what happened and what it cost

Status: Done (PR #12; the ticket assumes all four failure details are already one line, but
`passFailed` embeds `SandboxError.detail`, which appends the child's trimmed stderr
(`src/sandbox/sandbox.ts:174`) — a dying CLI's node stack wrote a wrapped block into the log, so the
detail is folded in `9efd0ee`, and a failed `describe-pr` now says its detail twice, once as
`PassFailed` and again as `dispatch/pr.ts`'s `Warned`)
Type: AFK
Blocked by: [T51](T51-the-agent-pass-narrates-as-it-runs.md) — `finish` must already be wired
into `runPass`, because that is where the usage comes from.

<!--
[Ticket 20](../20-the-agent-pass-narrates-nothing.md)'s ruling, step 3 of 6. This is the half of
ticket 20's original T51 that the `/to-tickets` review split off on 2026-09-11. Together the two
halves were five interlocking pieces, and MAP's sizing record says five does not land.

The defect this closes is the one ticket 20 found underneath the silence. **A killed run's log does
not say it was killed.** `AgentPassFailed` renders on stderr at exit (`bin.ts:49`), after the log's
bracket has closed, and no `Reporter` event exists for it. 16 ruled that the log is a failed run's
only witness; T51 gives that witness the narration, and this ticket gives it the failure.

The same two terminal events carry what the pass cost. That is bash's `claude $ usage` line, which
the port dropped, and T53 carries it on into the ledger.
-->

## What to build

### `PassUsage` on the events

`PassUsage` comes from T50's `stream.ts`. Both terminal events carry `elapsed` and usage:

```ts
| { readonly _tag: "AgentPassFinished"; readonly pass: AgentPass; readonly elapsed: Duration.Duration; readonly usage: PassUsage }
| {
    readonly _tag: "PassFailed";
    readonly pass: AgentPass;
    readonly reason: AgentPassReason;
    readonly detail: string;
    readonly elapsed: Duration.Duration;
    readonly usage: Option.Option<PassUsage>;
  }
```

`elapsed` is measured with `Clock` from just before the exec starts. On `AgentPassFinished`, `usage`
is the result's usage. On `PassFailed`, `usage` is some **only** when `finish` answered some, which
is the error-result case: bash emits usage for failed passes on the same grounds, because the
error-result pass is the expensive one worth seeing. It is none on a kill, a sandbox error, or a
stream with no result.

### `PassFailed` is emitted on every error path

`runPass` emits `PassFailed` before the `AgentPassFailed` propagates, on all four error paths:

- timeout
- `SandboxError`
- no result
- error result

Use one `Effect.tapError` applied **after** `Effect.timeoutFail`, so a kill reaches it too. `detail`
on the event is the same string as the error's `detail`, so the log and the exit line say the same
thing.

### The no-result detail says the branch keeps the work

Of the four details, only the no-result one (`noResultEvent` in `agent-cli.ts`) omits the clause the
other three end on: `anything it committed is kept on '${plan.branch}'`. Bash says it after every
failed pass (`run.sh:1521`). It matters most here: an implement pass can commit its work and then
have its stream end without a result.

Insert `; anything it committed is kept on '${plan.branch}'` right after the `read ${log}` clause,
before the sentence about the stream flags, so the stderr tail stays last. This came up in the T51
review, where the reviewer recorded it as not fixed.

### Rendering — one line per event

AGENTS.md:387 and `run-log.ts:13` both say the verbatim prompt is the **one** run-log event that is
not one line. That stays true: both events here render on one line.

- `run-log.ts`, finished:
  `${pass} pass finished (${elapsed}) usage in=${input} out=${output} cache_write=${cacheWrite} cache_read=${cacheRead} turns=${turns}[ cost=${costUsd}] models=${models}`
- `run-log.ts`, failed:
  `${pass} pass failed (${elapsed})[ usage …same fields…]: ${reason} — ${detail}`

In both lines:

- `elapsed` renders as whole minutes when ≥ 1m, otherwise seconds (`12m`, `40s`).
- `cost=` appears only when `costUsd` is some, with four decimals.
- `models` is comma-joined, or `-` when empty.
- `usage in=` is the greppable token that bash's `claude $ usage` was. It is the run's line, not the
  agent's, so there is no `agent` prefix.

Put the elapsed renderer and the usage renderer in `run-log.ts` as exported pure functions. T52
reuses the first, and T54 reuses both.

For example:

```
implement pass finished (12m) usage in=18 out=246 cache_write=8068 cache_read=40768 turns=3 cost=0.0215 models=claude-haiku-4-5-20251001
implement pass failed (30m): timed-out — the implement pass timed out at 1800s — read what it committed …
```

Console (`app.ts`), plain for now (T54 restyles):

- `${pass} pass finished (${elapsed})`
- `${pass} pass failed: ${detail}`

The stderr exit line from `render.ts` is **unchanged**. It carries the recovery sentence and sets
the exit code.

Notifications (`notifications.ts`):

- `AgentPassFinished` is unchanged: the implement pass still notifies, with the same body.
- `PassFailed` is **not** a step notification. The terminal notification already says the run
  failed. Add it to the fall-through list with that reason in the comment.

## Effect wiring

No tag is introduced or consumed, and no layer composition changes. `Duration`, `Option`, and the
`PassUsage` type join `reporter.ts`'s imports. The dry-run result line from T51 carries zero usage,
so a rehearsal's `AgentPassFinished` renders `usage in=0 … models=-`, and that is correct.

## Tests

- `test/agent-cli.test.ts`:
  - A finished pass emits `AgentPassFinished` with the fixture's usage.
  - No result, an error result, and a scripted `SandboxError` each emit exactly one `PassFailed`
    before the error. `usage` is some only for the error result.
  - The no-result case (line 465 today) also asserts that the detail contains
    `anything it committed is kept on '<branch>'`, and that the stderr tail comes after it.
  - The live-clock timeout case (row 9) emits `PassFailed { reason: "timed-out", usage: none }`
    after its last `AgentOutput`, with `elapsed` ≥ 1s.
  - Nothing is emitted after `PassFailed`.
  - Under `TestClock`, assert `elapsed` equals `Duration.zero`; do not advance the clock.
- `test/run-log.test.ts`:
  - `AgentPassFinished` with and without `cost=`, and with empty `models`.
  - `PassFailed` with and without usage.
  - Every rendering is a single line.
  - The elapsed renderer at `40s` and at `12m`.
- `test/notify.test.ts`: `PassFailed` yields no body.
- `test/dispatch.test.ts` and `test/support/agent-cli-fake.ts`: wherever `AgentPassFinished` is
  constructed, the new fields. By default the fake `AgentCli` emits a zero `PassUsage` and a zero
  `elapsed`, and it accepts a usage per pass so that T53 can script one.

## Acceptance criteria

- [ ] A pass killed by the timeout ends its log narration with one `… pass failed (Nm): timed-out —
      …` line.
- [ ] A finished pass's finish line carries `usage in=… out=… … models=…` on the same line.
- [ ] A pass that fails with an error result logs its usage on its `pass failed` line. A kill logs
      none.
- [ ] Every run-log line these events produce is a single line, and AGENTS.md's "one deliberate
      exception" is still the verbatim prompt alone.
- [ ] `PassFailed` is not a step notification. `AgentPassFinished` for the implement pass still is.
- [ ] The no-result detail says `anything it committed is kept on '<branch>'`, as the other three
      failure details already do.
- [ ] Apart from that one clause in the no-result case, the stderr exit line for every
      `AgentPassFailed` is byte-identical to before.
- [ ] The suite passes.

## Verify

```
npm run verify
```

Run from the repo root. This is the gate: typecheck (with Effect diagnostics: **errors and warnings
break the build**; suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package.
