# T12 — `Forge`: the PR description pass and the draft PR

Status: Done
Type: AFK
Blocked by: T11

Sequence: [ticket 08](../08-in-hae-sequence.md), re-sliced 2026-08-10. Last of the four tickets that
replace 08's T4 bullet, and it carries **08's original T4 tracer**.

**Tracer: the tool dispatches a one-off task on itself and opens a draft PR.** Point bessemer at a
spec describing work on bessemer, `--branch` a throwaway branch, and let it run end to end: clone,
container, setup, implement, review, fetch-back, push, and a draft PR whose body the agent wrote.
This is **move-out gate 1** (08 §6).

## What to build

The forge seam and the description that goes through it.

### 1. `Forge`

`prView` / `prCreate` / `prEdit` (SPEC §2) over the `gh` CLI, through the chokepoint. It is the one
network surface with no local oracle, which is why it is a tag: it is the seam a fake stands in for.
Named for its role, not its vendor — no provider abstraction is built behind it.

**`gh` auth preflight lands here**, the piece T3 deliberately left out. `doctor`'s probe 6 already
checks `gh` presence and authentication in `src/doctor/probes.ts` — reuse it rather than writing a
second check, exactly as T3 did with the docker probes.

Edit-or-create follows bash (`run.sh:1579-1587`): view the branch's PR, and if one is open, edit it;
otherwise create. **The body always travels on stdin**, never as an argument.

### 2. `AgentCli.describePr`

The third and last method on T9's tag, landing with its caller. Same mechanics as the other passes —
foreground `Sandbox.exec`, prompt on stdin, prompt logged verbatim, output through `Reporter`, the
same timeout — and the same package-file-plus-pure-interpolation prompt shape.

**It falls back to a static body when the pass fails** (`run.sh:1554-1573`). A failed description
pass must not cost the run its PR; the commits are already pushed.

### 3. Ordering, and what it costs

The description pass and the PR both happen **after** the push, so a `Forge` failure arrives with the
commits already home (matrix row 15): everything releases, the row is `failed` at stage `pr`, and the
error is a typed `ForgeError`. That ordering is bash's and it is deliberate — the expensive,
recoverable thing happens first.

### 4. What the ledger records

**PR number alongside URL**, both, so no call site parses the number back out of the string
(`src/ledger/record.ts`'s `PullRequest`). A PR that could not be created leaves both absent —
absent, never synthesized.

## Not in scope

`Notifier` (T13), `PromptSource` (T14), `--dry-run` (T15), resume (T16). Do not stub them. Feature
mode, `IssueStore`, the picker, `gc`, `init`, and `--hard-reset` stay deferred past the move.

## Read first

T11's land step, T9's `AgentCli` and prompt module, `src/doctor/probes.ts` (**probe 6 only** — the
file is 299 lines and the other probes are not yours), `src/internal/exec.ts`, `src/ledger/record.ts`,
`AGENTS.md`, and **SPEC §2 (lines 92–141), §3 (142–175), §7 (305–367), and §11 (470–606)**
— those ranges, not the whole file. `run.sh:1554-1592` is the behaviour source, read as a reference
document and never executed.

**Already on the branch — do not rewrite** T1–T11's modules; amend `AGENTS.md` only with a ruling you
had to discover. **Do not touch hae files.**

## Effect wiring

- **Tags introduced**: `Forge`.
- **Tags consumed**: `AgentCli`, `Git`, `Sandbox`, `RunLock`, `Ledger`, `AgentboxConfig`, `Reporter`.
- **Not introduced**: `Notifier`, `PromptSource`, `Prompt`, `IssueStore`. Do not stub them.
- **Layer composition**: `ForgeLive` depends on nothing that `SandboxLive` and `GitLive` do not
  already have, so it joins the same merged resource layer; `AgentCliLive` stays outside it because
  it consumes `Sandbox`. Copy this, do not derive it:

  ```ts
  export const AppLive: Layer.Layer<
    | AgentCli
    | Forge
    | Sandbox
    | Git
    | RunLock
    | Ledger
    | AgentboxConfig
    | Reporter
    | NodeContext.NodeContext,
    ConfigError
  > = Layer.provideMerge(
    AgentCliLive,
    Layer.provideMerge(
      Layer.mergeAll(SandboxLive, GitLive, RunLockLive, ForgeLive),
      Layer.provideMerge(LedgerLive, Layer.provideMerge(AgentboxConfigLive, PlatformAndReporterLive)),
    ),
  );
  ```

  **`AppBaseLive` is byte-unchanged** — `status` and `doctor` gain no dependency on `gh`.
- **Errors**: `ForgeError` is typed (SPEC §3). A failed description pass is **not** a run failure —
  it degrades to the static body and reports a warning.

## Acceptance criteria

- [ ] `Forge` exposes `prView` / `prCreate` / `prEdit` through the chokepoint, with the body always
      on stdin
- [ ] A branch with an open PR is edited; a branch without one gets a **draft** PR created
- [ ] `gh` auth is preflighted by reusing `doctor`'s probe rather than a second check, and its
      failure is typed
- [ ] `AgentCli.describePr` writes the body, and a failed description pass degrades to a static body
      with a warning rather than failing the run
- [ ] A `Forge` failure after the push releases everything and writes `failed` at stage `pr` with a
      typed `ForgeError` (matrix row 15)
- [ ] The row records PR **number and URL** together, and records neither when no PR was opened
- [ ] `AppLive` matches the composition above verbatim; `AppBaseLive` is byte-unchanged

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, grep bans, and fake-tier tests. `pre-commit` is not a
substitute and does not check this package.

**Host-only**, run by the user — this tracer cannot run inside the task container, which has neither
a docker socket nor `gh` credentials:

```
node src/bin.ts <spec-describing-bessemer-work> --branch <throwaway-branch>
```

The run must open a draft PR with an agent-written body, leave the commits on the branch, release
container, checkout and lock, and write one terminal row carrying the PR number and URL. That is
move-out gate 1; record it in this ticket's `## Comments` when it closes.
