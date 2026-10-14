# T10 — The review loop and its round cap

Status: Done
Type: AFK
Blocked by: T9

Sequence: [ticket 08](../08-in-hae-sequence.md), re-sliced 2026-08-10. Second of the four tickets
that replace 08's T4 bullet.

**Tracer: review rounds run after the implement pass and stop on approval or on the cap.** Dispatch
with `maxReviewRounds` set low, watch the rounds run against the real diff, and see the run reach a
recorded verdict either way. A capped-but-unapproved run is **not a failure** — it proceeds, and the
unapproved state is what gets recorded.

## What to build

The policy on top of T9's seam: `AgentCli.review`, and the loop that drives it.

### 1. `AgentCli.review`

The second method on the tag T9 introduced, single-shot per round exactly as `implement` is. Same
mechanics, unchanged: through `Sandbox.exec` in the foreground, **prompt on stdin**, assembled prompt
logged verbatim, output through `Reporter`, `passTimeoutSeconds` honoured. If those mechanics need to
be shared between the two methods, factor them — do not copy them.

**The review prompt is a package default file plus the pure interpolation function** T9 introduced.
`PromptSource` is still T14's.

### 2. The diff boundary

Review reads the diff from `merge-base(branch, base)` (SPEC §7's `--base` semantics). T3 already
resolves and records that SHA on the plan; consume it rather than re-deriving it — a second
derivation is the drift `--dry-run` exists to delete, in miniature.

### 3. The loop

- rounds run until the verdict is approval or the round count reaches `maxReviewRounds` from config
- the verdict is parsed out of the pass output, following bash's marker (`run.sh:1349-1372`)
- **hitting the cap is not a failure** (matrix row 12): the run proceeds to land, and the unapproved
  state is recorded as the row's `outcome`. `outcome` is an **open string** in
  `src/ledger/record.ts` — bash's own renderer passes unrecognized tokens through, and dropping a
  real row because a token grew is worse than rendering one we do not recognize
- `outcome` answers "what did the review decide"; `terminalReason` answers "why did it stop". A run
  that reaches the cap has both; a crashed run has only the second

### 4. The canonical Claim-1 case

**Matrix row 11 — a review pass dying with a defect** — is the case SPEC §11 names as the canonical
Claim-1 exhibit: sandbox, checkout, and lock all release in reverse order, the row records
`crashed`, and the defect is **rethrown after release**. It is a defect and not a typed error because
our own invariant broke, and `Scope` releases on both — the choice decides reporting shape, not
resource safety (SPEC §3).

## Not in scope

Push and land (T11), `Forge` and the PR description (T12), `Notifier` (T13), `PromptSource` (T14). Do
not stub them. There is still no retry anywhere in the port.

## Read first

T9's `AgentCli` and prompt module, T3's resolved plan (for the merge-base SHA),
`src/ledger/record.ts`, `src/config/config.ts`, `src/reporter.ts`, `AGENTS.md`, and
**SPEC §3 (lines 142–175), §7 (305–367), and §11 (470–606)** — those ranges, not the whole file.
`run.sh:1494-1527` is the behaviour source, read as a reference document and never executed.

The plan's merge-base SHA is already asserted in `test/dispatch.test.ts` under
`describe("plan derivation")`; read that rather than re-deriving what T3 resolves.

**Already on the branch — do not rewrite** T1–T9's modules; amend `AGENTS.md` only with a ruling you
had to discover. **Do not touch hae files.**

## Effect wiring

- **Tags introduced**: none.
- **Tags consumed**: `AgentCli`, `Sandbox`, `Ledger`, `AgentboxConfig`, `Reporter`.
- **Not introduced**: `Forge`, `Notifier`, `PromptSource`, `Prompt`, `IssueStore`. Do not stub them.
- **Layer composition**: unchanged from T9 — a second method on an existing tag adds no layer. Copy,
  do not derive:

  ```ts
  export const AppLive: Layer.Layer<
    AgentCli | Sandbox | Git | RunLock | Ledger | AgentboxConfig | Reporter | NodeContext.NodeContext,
    ConfigError
  > = Layer.provideMerge(
    AgentCliLive,
    Layer.provideMerge(
      Layer.mergeAll(SandboxLive, GitLive, RunLockLive),
      Layer.provideMerge(LedgerLive, Layer.provideMerge(AgentboxConfigLive, PlatformAndReporterLive)),
    ),
  );
  ```

  **`AppBaseLive` is byte-unchanged.**
- **Errors**: a review pass that exits nonzero is a typed `AgentPassFailed` like any other pass; a
  review pass that violates our own invariants is a **defect**, rethrown after release (matrix
  row 11).

## Acceptance criteria

- [ ] Review rounds run after the implement pass, stopping on approval or at `maxReviewRounds`
- [ ] Each round is single-shot with the same mechanics as `implement` — foreground `Sandbox.exec`,
      prompt on stdin, prompt logged verbatim — shared rather than copied
- [ ] The review diff boundary is the merge-base SHA T3 already resolved, consumed rather than
      re-derived
- [ ] Reaching the cap is **not** a failure: the run proceeds and the unapproved verdict is recorded
      as the row's `outcome` (matrix row 12)
- [ ] `outcome` and `terminalReason` stay distinct — a crashed run records the second and not the
      first
- [ ] A defect in a review pass releases all three resources in reverse, records `crashed`, and
      rethrows the defect (matrix row 11)
- [ ] The review prompt is a package file interpolated by T9's pure function
- [ ] `AppLive` and `AppBaseLive` are byte-unchanged

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, grep bans, and fake-tier tests. `pre-commit` is not a
substitute and does not check this package.

**Host-only**, run by the user before landing:

```
node src/bin.ts <spec> --branch <throwaway-branch>
```

Once with a spec the agent can satisfy (expect approval before the cap) and once with
`maxReviewRounds` set to 1 against work it cannot (expect the cap, a recorded unapproved outcome, and
exit 0 rather than a failure).

## Comments

**2026-08-13 — closed.** PR #4482. `APPROVED` at review round 2 (round 1 `fixed`); `npm run verify`
green with 231 tests, verified in a throwaway worktree. 7 commits, 21 files, +1061/−68, 33.2M tokens
over 4 passes. Ran in parallel with [T8](T8-reconciler.md) with no collision — the two branches
turned out to share no file.

**`AppLive` and `AppBaseLive` are byte-unchanged**, and the only `app.ts` hunk is a console arm for
the new event, exactly as §Effect wiring demanded. No tag introduced. The pass mechanics are shared
rather than copied: `runPass` holds the template read, the verbatim `PromptAssembled`, stdin
delivery, per-line events, and `passTimeoutSeconds`, and `implement` became a two-line caller of it.
`implementPassCommand` became `agentPassCommand` on the reasoning that which pass it is lives in the
prompt and never in argv — self-derived, and the right instinct.

**The `Ref` ruling is the best thing in the diff, and it prevented a defect T11 would have shipped.**
The verdict reaches the row through a `Ref` made outside `Effect.scoped`, because the row is written
from the scope's `onExit`, which sees *how* the run ended and not what it decided on the way.
Threading the verdict out as the work's success value typechecks — and then a land that fails in T11
writes a row with no `outcome` for a review that reached one. `outcome` answers what the review
decided, `terminalReason` why the run stopped; a capped run has both, a crashed one has only the
second.

**The second ruling was mutation-verified.** `AgentCli` has leaked `Reporter` in its requirements
since T9 on purpose — a pass runs inside the run log's bracket, so a reporter captured at layer build
would send its prompt and output to the console alone. `leakingRequirements` stays quiet until a
*second* method does the same, which `review` is. Capturing it at that point typechecks and silently
unsubscribes the log. The round-1 reviewer removed `@effect-expect-leaking Reporter`, confirmed
`TS377041` fires, and restored it.

**Round 1 found a gap this ticket did not name.** T10 writes a new `outcome` token,
`capped-unreviewed-fix`, but `src/status/render.ts`'s label map was written at T2 with two entries —
so `status` would have printed the raw token where bash prints "⚠️ fix unreviewed". A new outcome
token and the renderer that names it live in different files with nothing structurally linking them,
and only a reader who knew both would catch it. Fixed with the label plus a test that also pins the
verbatim fallback for genuinely unknown tokens.

**The `Not-fixed` finding that became [T24](T24-verdict-marker-precedence.md).** `reviewVerdictIn`
checks `output.includes(APPROVED_MARKER)` first, over the whole output, so a reviewer that quotes a
marker in prose can be read as approving. The round recorded it and ruled it bash parity. **It fired
in this very run**: round 2's own review body contains `<verdict>approved</verdict>` inside an
ordinary sentence describing the loop. Harmless only because that round genuinely approved. Parity
was defensible when it was hypothetical; it is not now that we have watched it happen, and a false
*approval* ends the loop early and stamps `Done` on unreviewed code. T24 fixes it.

**The two other `Not-fixed` findings stand.** The host-only rehearsal is a criterion defect — it
needs docker, the agent CLI, and network, so no review round can reach it — and `runPass`'s quadratic
line collection is deliberate and bounded.

**The host rehearsal was not run.** Both arms need a real dispatch, and the cap arm needs work the
agent cannot satisfy, which `tasks/tracer.md` is deliberately too small to be. Judged not
worth building a seeded-defect spec for, on the reasoning that bessemer is about to dogfood its own
review loop on every remaining ticket in the sequence — T8's merge is the first exercise of it, and
the cap arm will be met the first time a real dispatch runs out of rounds. **So the cap path reaches
production unrehearsed**, and the first capped run is the one to read closely: expect exit 0, a
`capped-unreviewed-fix` outcome, and "⚠️ fix unreviewed" from `status`.
