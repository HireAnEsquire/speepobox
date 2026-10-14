# T51 — The agent pass narrates as it runs

Status: Done (PR #11, three not-fixed; acceptance criterion 1 — the in-container
`claude -p --output-format stream-json --verbose` the ticket orders run "before anything else" —
was never run, the box having no docker, so only `--help`'s parser accepting the flags was checked
and the no-result detail is the whole guard. The round also found `timedOut`'s `run.sh:1187-1190`
citation stale and the no-result detail missing its branch clause, which became T52's and T55's work)
Type: AFK
Blocked by: [T50](T50-the-stream-parser-reads-what-the-agent-cli-prints.md) — the parser this
consumes.

<!--
[Ticket 20](../20-the-agent-pass-narrates-nothing.md)'s ruling, step 2 of 6 and the migrate. The argv
gains `--output-format stream-json --verbose`. The fold from T50 turns the CLI's JSONL into typed
narration events as they arrive. The pass's answer becomes the result event's text.

The defect: today `claude -p` prints one blob at exit. `AgentOutput` arrives as a burst after
minutes of silence, and a pass killed at the wall emits nothing at all — every killed run in
`.bessemer/logs/` is 80 lines with zero agent lines.

**These three pieces must land together.** Once the argv flips, stdout is JSONL, so the answer must
come from the result event or every review verdict breaks. The dry-run result line is forced by the
same flip. What a pass's *end* says — `PassFailed` in the log, `elapsed` and `usage` on the terminal
events — is [T55](T55-a-pass-end-says-what-happened-and-what-it-cost.md), deliberately. Ticket 20
first landed this step with both halves in it: five interlocking pieces, which MAP's sizing record
says does not land (T41 had five, T44 had four). The `/to-tickets` review re-sliced it on 2026-09-11.

Render the new event shape with **plain sentences** in both renderers. T54 restyles the console.
-->

## What to build

### 1. The argv

`agentPassCommand` becomes

```
claude --dangerously-skip-permissions -p --output-format stream-json --verbose
```

The CLI requires `--verbose` for `stream-json` under `-p`. **Verify on the image's CLI before
anything else**: inside the container, `echo 'Reply with exactly: ok' | claude -p --output-format
stream-json --verbose` must print JSONL ending in a `"type":"result"` line. The image installs the
CLI unpinned (`image/image-inputs.sh:22`). If the flags are refused there, stop and report rather
than design around it.

Rewrite the comment block above the constant (`agent-cli.ts:39-48`):

- The filter is now this package's own (`stream.ts`).
- The `run.sh:1154` citation is wrong. The pipeline is at `run.sh:1466`; 1154 is the
  feedback-editor block.
- SPEC §12 has no expected-divergence entry for this; SPEC records ticket 20's ruling instead.

### 2. `AgentOutput` is structured

In `reporter.ts`:

```ts
| { readonly _tag: "AgentOutput"; readonly pass: AgentPass; readonly kind: "text"; readonly text: string }
| { readonly _tag: "AgentOutput"; readonly pass: AgentPass; readonly kind: "tool-use"; readonly tool: string; readonly brief: string }
```

`runPass` threads a `Ref<StreamState>` through `onOutput`. Each line goes through `feed`, and each
`NarrationLine` it yields becomes one `AgentOutput` event carrying the pass. Lines are no longer
collected: the `Ref<ReadonlyArray<string>>` goes.

Renderers, plain sentences for now:

- `run-log.ts`: `agent | ${text}` and `agent > ${tool}: ${brief}` — bash's vocabulary under the
  port's `agent` label. Empty `text` renders `agent | ` with a trailing space, as today's blank
  lines do.
- `app.ts`: the same two strings.
- `notifications.ts`: still never a step notification.

### 3. The answer is the result event's text

After the exec returns, call `finish(state)`:

- **none** → `AgentPassFailed { reason: "exited", detail }`. The stream ended without a result
  event. The detail says so and names the log path. It adds *"if the CLI in the image refuses
  `--output-format stream-json --verbose`, this is what it looks like"*. When the exec left stderr,
  the detail also carries its last line, cut to 140 chars.
- **some, `isError: true`** → `AgentPassFailed { reason: "exited", detail }`, with the result text's
  first 300 chars in the detail.
- **some, `isError: false`** → `runPass` returns `result.text`. `reviewVerdictIn` and
  `prDescriptionIn` read it, unchanged.

Keep every detail on one line. `AgentPassFinished` is emitted exactly where it is today — after
`finish` answers some with `isError: false`, and on no other path.

The `Effect.timeoutFail` and the `mapError` on the exec stay exactly where they are. A pass that
timed out never reaches `finish`.

### 4. A rehearsal still answers

The dry-run `AgentCli` (`dry-run/agent-cli.ts`) is `AgentCliLive` over the recording `Sandbox`,
whose `exec` never calls `onOutput`. `finish` would answer none there, so a rehearsal would become a
failed pass. **A rehearsal must not become a failed pass.**

Fix it in **`dry-run/agent-cli.ts`, not in `dry-run/sandbox.ts`**. The recording `Sandbox` also
serves the setup hook (`dry-run/sandbox.ts:55-57`), and 20 §1 keeps what the CLI prints behind the
`AgentCli` tag. So `Sandbox` stays ignorant of the stream format.

`AgentCliRecordingLive` provides a `Sandbox` that wraps `recordingSandbox`. Its `exec` records
exactly as before. Then, when `options` is given, it calls `options.onOutput` once with one
`result` line:

- `result` text empty
- `is_error: false`
- every usage count zero
- no `modelUsage`

Every exec through that private `Sandbox` is an agent pass: `AgentCli` runs nothing else, and the
setup hook reaches the composition's own `Sandbox`.

The rehearsal's outcome is unchanged: its answer is still empty, `review` still reads `needs-work`,
`describePr` still finds no block, and nothing invents an approval or a body (T15). Update the
file's header comment: a recorded pass now answers with an empty result rather than printing
nothing.

### 5. One more comment

`run-log.ts:15` names `tail -f` as the log's use. That was hollow while the pass was silent. Reword
it: the log is followed with `tail -f` on the path the plan block prints, and the pass narrates
into it as it runs.

### Tests

- `test/agent-cli.test.ts`:
  - The scripted `docker exec` stdout becomes JSONL, built from the event shapes in T50's
    `pass.jsonl`: one `text` block per narration line, and a `result` line carrying the verdict or
    description text.
  - The `AgentOutput` expectations become structured events.
  - The review and describe-pr cases put their markers in the `result` line's `result` field, not
    in a text block, and assert the verdict and description still come out.
  - `:558`'s `agent > writing …` log assertion moves to the new `agent | ` / `agent > Tool: brief`
    rendering.
- New cases in the same file:
  - A scripted exec whose stdout has no `result` line fails as `exited`, with the detail naming
    the missing result and the flags.
  - One whose `result` has `is_error: true` fails as `exited`, with its text in the detail.
  - The existing live-clock timeout case (row 9) gets `hangs: true` plus JSONL stdout, so it
    asserts that the log holds the narration lines emitted before the kill.
- `test/run-log.test.ts`: both `AgentOutput` kinds, including empty `text`.
- `test/dry-run.test.ts`: a rehearsal still emits `AgentPassFinished` for every pass, the review
  verdict is still `needs-work`, and the setup hook's recorded line is unchanged.
- `test/dispatch.test.ts` and `test/support/agent-cli-fake.ts`: wherever an `AgentOutput` is
  constructed, the new fields.

## Effect wiring

No tag is introduced or consumed, and `AppLive` and `AppDryRunLive` are byte-unchanged.
`AgentCliLive` imports `feed`, `finish`, and `initialStreamState` from `./stream.ts`.
`AgentCliRecordingLive` becomes:

```ts
AgentCliLive.pipe(Layer.provide(SandboxAgentPassRecordingLive))
```

Here `SandboxAgentPassRecordingLive: Layer.Layer<Sandbox, never, Reporter>` is defined in the same
file as `Layer.effect(Sandbox, Effect.map(Reporter, (reporter) => withRecordedResult(recordingSandbox(reporter))))`.

## Acceptance criteria

- [ ] Inside the container, `echo 'Reply with exactly: ok' | claude -p --output-format stream-json
      --verbose` prints JSONL whose last line has `"type":"result"`.
- [ ] A pass killed by the timeout leaves in its log every narration line it produced before the
      kill.
- [ ] A pass whose stream ends without a `result` event fails as `exited`, with a detail that names
      the missing result and the flags.
- [ ] A review verdict and a PR description are read from the result event's text. The existing
      review and describe-pr tests pass with markers only in that text.
- [ ] A rehearsal (`--dry-run`) finishes every pass, its review verdict is still `needs-work`, and
      `dry-run/sandbox.ts` is unchanged.
- [ ] `agent-cli.ts` no longer cites `run.sh:1154` or SPEC §12's "expected-divergence list", and
      `run-log.ts:15` no longer describes `tail -f` on a silent pass.
- [ ] The suite passes.

## Verify

```
npm run verify
```

Run from the repo root. This is the gate: typecheck (with Effect diagnostics: **errors and warnings
break the build**; suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package.

**Host-only**, for the dispatcher after merge: during the next real dispatch, `tail -f` the log path
the plan block prints. `agent | ` and `agent > ` lines appear **while the pass runs**, not in one
burst at its end.
