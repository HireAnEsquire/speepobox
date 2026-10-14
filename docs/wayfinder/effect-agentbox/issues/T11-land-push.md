# T11 — Land: the fetch-back with real commits, and push

Status: Done
Type: AFK
Blocked by: T10

Sequence: [ticket 08](../08-in-hae-sequence.md), re-sliced 2026-08-10. Third of the four tickets that
replace 08's T4 bullet.

**Tracer: the agent's commits arrive on the real branch, and the checkout is gone.** Dispatch a
one-off task, let it implement and review, and afterwards `git log <branch>` on the host shows the
work — pushed, with the checkout deleted because the fast-forward succeeded. No PR yet; that is T12.

## What to build

The land step, up to but not including the forge.

### 1. The fetch-back, now with something to fetch

T18 built the checkout's **derived release** and proved both directions against a fake. This ticket is
where the fast-forward carries real commits for the first time. **Nothing about the release changes**
— if this ticket adds a flag, a branch, or a second fetch path to the finalizer, the derivation has
been broken and T18's design has been undone.

**Matrix row 13** — the fetch-back fails at land — becomes real here: sandbox and lock release, the
**checkout is kept, loudly**, the row is `failed` at stage `land`, and the error is a typed
`GitError`.

### 2. `Git.push`

The method T5 deliberately did not build, landing with its first caller. Plain push with an
**explicit refspec both ways** (`run.sh:1545-1549`); `--force-with-lease` belongs to `--hard-reset`,
which is deferred past the move, so it is not built and not stubbed.

A push failure is a typed `GitError` with sandbox, checkout, and lock all released — the checkout by
its ordinary derived path, because the fast-forward already succeeded (matrix row 14) — and a
`failed` row at stage `land`.

### 3. Commit counting and "nothing to land"

Count commits past the merge-base and past the pre-run tip (`run.sh:1540-1541`). **Zero commits means
skip everything and say "nothing to land"** (`run.sh:1589-1592`) — not a failure, not a push, and the
row records it honestly. This is the path a run takes when the agent's pass produced no work, and it
must not look like success or like an error.

### 4. What the ledger records

The terminal row stops naming "furthest stage reached" and starts carrying a real land outcome: the
review verdict from T10 as `outcome`, the base ref and resolved SHA, the merge-base SHA, and
`Completed` as the terminal reason when the commits made it home. The PR fields stay absent until
T12 — **absent, never synthesized**, which is the same ruling T2 applied to legacy lines.

## Not in scope

`Forge`, the PR-description pass, and the draft PR (all T12). `Notifier` (T13). `PromptSource`
(T14). `--hard-reset` and `--force-with-lease`. Do not stub any of them.

## Read first

T5's `Git` and T18's checkout release — read the release carefully before changing anything near it
— plus T10's review loop, `src/ledger/record.ts`, `src/internal/exec.ts`, `AGENTS.md`, and
**SPEC §3 (lines 142–175), §4 (176–249), and §11 (470–606)** — those ranges, not the whole file.
`run.sh:1529-1592` is the behaviour source, read as a reference document and never executed.

In `test/checkout.test.ts`, `describe("the checkout resource")` already pins the derived release in
both directions — `"fetches back and deletes the checkout when the fast-forward succeeds"` and
`"keeps the checkout, loudly, when the fetch-back is not a fast-forward"`. Those two are the contract
this ticket must not alter; read them before touching the finalizer.

**Already on the branch — do not rewrite** T1–T10's modules; amend `AGENTS.md` only with a ruling you
had to discover. **Do not touch hae files.**

## Effect wiring

- **Tags introduced**: none — `push` is a new method on T5's `Git`.
- **Tags consumed**: `Git`, `Sandbox`, `RunLock`, `Ledger`, `AgentCli`, `AgentboxConfig`, `Reporter`.
- **Not introduced**: `Forge`, `Notifier`, `PromptSource`, `Prompt`, `IssueStore`. Do not stub them.
- **Layer composition**: unchanged from T9. Copy, do not derive:

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
- **Errors**: `GitError` is typed for both the fetch-back and the push. The checkout finalizer still
  swallows its own failure and never fails the scope (design rule 4).

## Acceptance criteria

- [ ] The agent's commits reach the real branch through the derived fetch-back and a plain push with
      an explicit refspec both ways
- [ ] The checkout release is **unchanged** from T5 — no flag, no second fetch path, no branch on
      whether commits exist
- [ ] A failed fetch-back at land keeps the checkout loudly, releases sandbox and lock, and writes
      `failed` at stage `land` (matrix row 13)
- [ ] A failed push releases all three — the checkout by its ordinary derived path — and writes
      `failed` at stage `land` (matrix row 14)
- [ ] Zero commits past the merge-base and the pre-run tip skips the push entirely, records "nothing
      to land", and is neither a failure nor a success
- [ ] The terminal row carries the review outcome, base ref and SHA, merge-base SHA, and `Completed`
      when the commits landed; PR fields are absent rather than synthesized
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

Then `git log <throwaway-branch>` on the host — the agent's commits must be there. The checkout
directory must be gone, the lock gone, and `docker ps -a` by our labels empty. Run it a second time
against a spec that produces no commits and confirm the "nothing to land" path.
