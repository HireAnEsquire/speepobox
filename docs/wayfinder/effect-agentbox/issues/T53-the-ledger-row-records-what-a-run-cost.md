# T53 — The ledger row records what a run cost

Status: Done (PR #14; `dispatch/usage.ts` drops any pass reporting four zeros, wider than the
ticket's "a killed pass does not count" — a rehearsal's recording `AgentCli` emits a real
`AgentPassFinished` with zero usage, so counting it would put `passes: 3` and four zeros on a dry
run's row)
Type: AFK
Blocked by: [T55](T55-a-pass-end-says-what-happened-and-what-it-cost.md) — the usage on
`AgentPassFinished` and `PassFailed` that this sums. Parallel with T52: they share no source file.

<!--
**Dispatcher's precondition, not a blocking edge:** before dispatching this, read the `usage in=`
lines of one real post-T55 run log, so the schema is cut to usage that has actually been observed.
Any dispatch under T55's dispatcher produces those lines. This replaced a blocking edge on T52 in
the `/to-tickets` review of 2026-09-11: that edge gated nothing T53 builds.

[Ticket 20](../20-the-agent-pass-narrates-nothing.md)'s ruling, step 5 of 6, and a parity gap the
ticket found rather than one it caused: bash sums the `claude $ usage` lines its filter left in the
log into the ledger's `tokens`, `passes`, and `models` (`run.sh:2188-2210`, `tasklib.py:694`), and
`status` renders `1.4M/4` per row (`tasklib.py:780`). The port's `src/ledger/record.ts` has none of
the three, and nothing ever ticketed dropping them. From T55 on, every pass's usage is on
`AgentPassFinished`, and on `PassFailed` when a result arrived. This ticket carries it to the row.
-->

## What to build

Six optional fields on the native record (`schemaVersion` stays `1` — additive, optional, absent
on every row written before this lands and on legacy lines):

```ts
tokensIn: Schema.optional(Schema.Number),     // each summed over the passes that reported usage
tokensOut: Schema.optional(Schema.Number),
cacheWrite: Schema.optional(Schema.Number),
cacheRead: Schema.optional(Schema.Number),
passes: Schema.optional(Schema.Number),       // passes that reported usage
models: Schema.optional(Schema.Array(Schema.String)),  // union over passes, first-seen order
```

**The four counts stay apart; only the renderer adds them.** Bash stored the sum
(`run.sh:2188-2210`), and on a real run cache reads swamp it: the T52 run's implement pass reported
`in=164 out=38700 cache_write=132393 cache_read=8067677`, so 98% of an 8.2M-token row is its
cheapest component. A row that generated 8M tokens of output and one that re-read a warm cache
render identically, which makes the sum alone a poor answer to what a run burned. Summing is a
render-time concern (`status`, below) and stays reversible; a sum written into the row cannot be
taken apart again.

Each count is added over every pass that reported usage — a failed pass with usage counts, a killed
one does not. `models` is the union of each pass's list in first-seen order, and **one pass can
report more than one model** (the same line reports
`models=claude-haiku-4-5-20251001,claude-opus-5`), so the union is load-bearing rather than
decoration. A run with no usage-bearing event writes none of the six, never zeros: unmeasured is not
free (`tasklib.py:691`).

**Derived from the event stream, as SPEC §10 says the row must be**: the dispatch keeps a `Ref` that
the `Reporter`-side fold updates on `AgentPassFinished` and on `PassFailed` with some usage, and the
finalizer that writes the row reads it. Do not re-parse the log.

`status`'s recent table gains bash's column: `<tokens>/<passes>` with bash's `1.4M` / `230k`
rendering (`tasklib.py:780-795`), `-` when absent. `<tokens>` is the four counts added at render
time, so the column is what bash's was. Models are not in the table; they are in the row for
whoever reads it.

SPEC §10's record list carries the bullet for these fields (added with ticket 20's resolution);
this ticket updates it from bash's single summed `tokens` to the four counts, and makes it true.

### Tests

- `test/ledger.test.ts`: a row round-trips with the six fields, and a row without them decodes.
- `test/dispatch.test.ts`: a dispatch whose fake `AgentCli` emits usage on two passes writes a row
  whose four counts each equal that field's sum across the two, with `passes: 2` and `models`
  deduplicated; a dispatch whose implement pass is killed writes a row with none of the six; one
  whose implement pass fails with an error result (usage some) writes `passes: 1`.
- `test/status.test.ts`: the column renders `1.4M/4`, `230k/2`, and `-`, and a row whose counts are
  almost entirely `cacheRead` renders their total, not one component.

## Effect wiring

No tag introduced or consumed; no layer composition changes. The `Ref` lives in `dispatch/run.ts`
beside `outcome`, and the fold is the same subscriber shape the run log uses — a second
`ReporterShape` that tees, or a `tap` on the existing one; the composition root is unchanged either
way.

## Acceptance criteria

- [ ] A completed run's ledger row carries the four token counts, `passes`, and `models`, and each
      count equals that field's sum across the `usage` lines in its log.
- [ ] A run whose only pass was killed carries none of the six.
- [ ] `status` renders `<tokens>/<passes>` per row, `-` for rows without them, including every row
      written before this landed.
- [ ] `schemaVersion` is still `1` and every existing row still decodes.
- [ ] The suite passes.

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package.
