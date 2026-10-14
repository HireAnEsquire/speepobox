# T52 — A long pass says it is still running, and a reading pass says it has not written

Status: Done (PR #13; the spec's `dueAt` rule — `elapsed` a positive whole multiple of 120s — never
fires against a real `Clock`, whose fourth tick reads 120_037ms, so `pass-watch.ts` snaps elapsed
onto the 30s grid before the modulo and records why, lest a later round "correct" it back into a
dead heartbeat. **Two CodeRabbit findings went unaddressed into the merge**: `isWrite`'s
`brief.includes` (`src/agent/pass-watch.ts:54`) counts a Bash `echo git commit later` as a write,
and `wrote` is set after narration. Both owned since 2026-09-18 by
[T64](T64-the-write-watch-reads-the-command-not-the-sentence.md))
Type: AFK
Blocked by: [T55](T55-a-pass-end-says-what-happened-and-what-it-cost.md). The watch reuses its
elapsed measurement and its elapsed renderer, and it must stop before either terminal event it
added. T51's structured `tool-use` events arrive with it.

<!--
[Ticket 20](../20-the-agent-pass-narrates-nothing.md)'s ruling, step 4 of 6. Bash has two in-pass
behaviours with no port analogue, and they return as `Reporter` events:

- `run.sh:1493` warns once, a third of the way into the implement budget, if the agent has written
  nothing yet. It is a sizing signal.
- `run.sh:1505` prints a heartbeat every two minutes, so a console with no timestamps still shows
  time passing.

Narration alone is not the heartbeat: a single ten-minute test run narrates nothing.

**The timing is a pure function, and the fiber is a thin loop over it.** `test/agent-cli.test.ts`
already records (row 9, lines 394-400) why a forked sleep under `TestClock` is a race "whose green
side is a test that never ran". `exec-fake.ts` also cannot make a scripted exec take test time; it
only offers `hangs`. So nothing here asserts timing through the fiber.
-->

## What to build

### The events

Two events in `reporter.ts`:

```ts
| { readonly _tag: "PassStillRunning"; readonly pass: AgentPass; readonly elapsed: Duration.Duration; readonly budget: Duration.Duration }
| { readonly _tag: "NoWritesYet";      readonly pass: AgentPass; readonly elapsed: Duration.Duration; readonly budget: Duration.Duration }
```

### `src/agent/pass-watch.ts` — pure

These are bash's numbers, kept as constants rather than config: a tick every **30s**, a heartbeat
every **120s**, and the warning at **budget / 3**.

```ts
export const WATCH_TICK: Duration.Duration;         // 30 seconds

// Whether a narration line is a write, by bash's rule.
export const isWrite: (line: NarrationLine) => boolean;

// What one tick emits.
export const dueAt: (tick: {
  readonly pass: AgentPass;
  readonly elapsed: Duration.Duration;
  readonly budget: Duration.Duration;
  readonly wrote: boolean;
  readonly warned: boolean;
}) => { readonly stillRunning: boolean; readonly noWritesYet: boolean };
```

`isWrite` is true in exactly these cases:

- a `tool-use` whose `tool` is `Write`, `Edit`, or `NotebookEdit`;
- a `tool-use` whose `tool` is `Bash` and whose `brief` contains any of `cat >`, `tee `, `sed -i`,
  `git apply`, `git commit`, or `patch `.

That is bash's `run.sh:1493` alternation over the command, which is what `brief` carries for `Bash`.
It is a typed check over `tool` and `brief`, not a regex over a rendered line.

`dueAt` returns:

- `stillRunning`: `elapsed` is a positive whole multiple of 120s. This applies to any pass.
- `noWritesYet`: all four of these hold:
  - the pass is `implement`;
  - `wrote` is false;
  - `warned` is false;
  - `elapsed` ≥ `budget / 3`.

Review and describe-pr passes never warn: a round that finds nothing wrong writes nothing, and that
is the good case.

### The loop in `runPass`

`runPass` (`agent-cli.ts`) keeps two `Ref<boolean>` values, `wrote` and `warned`. The `onOutput`
path sets `wrote` when a line yielded by `feed` satisfies `isWrite`.

The watch is `Effect.forkScoped`, inside an `Effect.scoped` that encloses **only** the exec. It
repeats `Effect.sleep(WATCH_TICK)`, reads the elapsed time from T55's start instant, calls `dueAt`,
emits what is due, and sets `warned` once it has emitted `NoWritesYet`.

The scope closes when the exec returns, fails, or times out. That interrupts the watch before
`finish`, `AgentPassFinished`, or T55's `PassFailed` can run, so no watch event can follow a
terminal event.

### Rendering

`PassStillRunning`:

- `run-log.ts`: `... ${pass} pass still running (${elapsed}, cap ${budget})`, using T55's elapsed
  renderer for both durations.
- `app.ts`: the same line.
- `notifications.ts`: **never** a step notification.

`NoWritesYet`:

- `run-log.ts` renders it as one line, bash's two sentences folded:

  ```
  WARN  no file written after ${elapsed} of a ${budget} budget — still reading; usually a sizing problem: the ticket is too large, or it points at sources to consult instead of carrying the decisions and code shapes the agent needs
  ```

- `app.ts`: `WARN  ` and the first sentence on the first line, then the sizing sentence on a
  continuation line under `WARN_CONTINUATION`, the way a multi-line `Warned` renders.
- `notifications.ts`: **a step notification**, and the only addition. Its body is bash's
  `notify_step` text: `still reading at ${elapsed} — check ticket size`. It is the advisory aimed at
  a dispatcher who walked away. AGENTS.md's rule is that a new event is not a step notification by
  default; the case's comment answers that rule with this sentence.

`AGENTS.md`'s step-notification paragraph gains one line naming `NoWritesYet` as the event that
notifies mid-pass, and why.

### Fix a stale citation

Two comments cite `run.sh:1187-1190` as bash's `watch_writes` arm: the one above `timedOut` in
`agent-cli.ts`, and the timeout test's comment in `test/agent-cli.test.ts`. Those lines are the
pre-flight header. The arm is at `run.sh:1516-1517`, in the timeout branch just after the watch
loop this ticket ports, so both comments cite `run.sh:1516-1517` instead. The comments are otherwise unchanged. This
predates T51, which found it.

## Tests

- `test/pass-watch.test.ts`, as plain values:
  - `isWrite` is true for `Write`, `Edit`, and `NotebookEdit`, and for `Bash` with `sed -i x`,
    `tee out`, `cat > f`, `git apply p`, `git commit -m x`, and `patch -p1`.
  - `isWrite` is false for `Bash` with `ls src`, for `Read`, and for any `text` line.
  - With a 15-minute implement budget: `dueAt` at 30s, 90s, and 150s is neither. At 120s and 240s
    it is `stillRunning` only. At 300s it is `noWritesYet`, and it is not `noWritesYet` again once
    `warned` is true.
  - At 300s with `wrote: true`, it is not `noWritesYet`.
  - A `review` pass at 300s is not `noWritesYet`.
- `test/agent-cli.test.ts`:
  - The existing live-clock timeout case (row 9, `passTimeoutSeconds: 1`) emits no watch event,
    and nothing after `PassFailed`.
  - A pass whose stream carries a `Write` tool use leaves `wrote` observable as set. Expose it
    through the test only if a seam already exists; otherwise the pure `isWrite` cases suffice.
- `test/notify.test.ts`: `NoWritesYet` yields a body, and `PassStillRunning` yields none.
- `test/run-log.test.ts`: one case per rendering.

## Effect wiring

No tag is introduced or consumed, and no layer composition changes. The watch is
`Effect.forkScoped` inside `Effect.scoped(exec-and-watch)`, and the exec's own result is what the
scoped block returns. `pass-watch.ts` imports `Duration` from `effect` and `NarrationLine` from
`./stream.ts`, and nothing else.

## Acceptance criteria

- [ ] `dueAt` asks for a heartbeat at every 120s multiple for any pass, and asks for `NoWritesYet`
      once, at or past budget / 3, only for an implement pass that has not written.
- [ ] `isWrite` counts `Write`, `Edit`, `NotebookEdit`, and a `Bash` whose command contains
      `sed -i`, `tee `, `cat >`, `git apply`, `git commit`, or `patch `. It counts nothing else.
- [ ] The watch is interrupted with the exec: no `PassStillRunning` or `NoWritesYet` follows
      `AgentPassFinished` or `PassFailed`.
- [ ] `NoWritesYet` sends one step notification. `PassStillRunning` never does.
- [ ] Nothing under `speepobox/` cites `run.sh:1187`.
- [ ] The suite passes.

## Verify

```
npm run verify
```

Run from the repo root. This is the gate: typecheck (with Effect diagnostics: **errors and warnings
break the build**; suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package.

**Host-only**, for the dispatcher after merge: on the next dispatch longer than two minutes, the
console and the log show `... implement pass still running (2m, cap 30m)` at two-minute intervals.
