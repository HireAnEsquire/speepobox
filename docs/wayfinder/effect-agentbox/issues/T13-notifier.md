# T13 — `Notifier`

Status: Done
Type: AFK
Blocked by: T12

Sequence: [ticket 08](../08-in-hae-sequence.md), re-sliced 2026-08-10. Runs in parallel with
[T16](T16-resume.md), which changes no layer.

**Tracer: a finished run tells you it finished.** Dispatch, walk away, and get a notification when it
ends carrying the outcome and the PR. Break the notifier and the run still succeeds — the failure is
swallowed with a `Reporter` warning, because a dispatch that landed a PR did not fail just because
nobody was told.

## What to build

The smallest tag in the port, and the reason 08 §4 refused to defer it: *the entire point of AFK
dispatch is finding out that it finished.*

### 1. `Notifier`

One method, `notify` (SPEC §2). Trivially fakeable, which is exactly why it earns a tag — it keeps
notification mechanics out of the dispatch core.

The live implementation goes through the chokepoint like everything else. Any host binary it shells
out to is **probed, not assumed**: an absent notifier binary degrades to a warning, never a failure,
and never a crash on a machine that does not have it.

### 2. Verbosity

The `notify` config key already exists in `src/config/config.ts` with the values `off` / `end` /
`steps`, carried over from bash (`run.sh:202-221`). Honour all three:

- **`off`** — nothing is sent, and the notifier is never invoked
- **`end`** — one notification at the terminal row, carrying outcome and PR
- **`steps`** — step-level notifications as well, subscribed to the **`Reporter` event stream**
  rather than sprinkled through the dispatch core. New user-visible progress goes through a
  `Reporter` event (`AGENTS.md`); a notify call inside an op typechecks and is the wrong shape

### 3. Failure

**Matrix row 21**: notify fails → everything already released, the run's own row is written
unchanged, the failure is **swallowed with a `Reporter` warning**. Notification is never on the
outcome path.

## Not in scope

`PromptSource` (T14), `--dry-run` (T15), resume (T16). Do not stub them.

## Read first

`src/config/config.ts` (the `notify` key), `src/reporter.ts` and `src/run-log.ts` — the run log is
the existing worked example of a second subscriber on the same event stream, which is the shape step
notifications take — plus `src/app.ts`, `src/internal/exec.ts`, T12's land-and-PR path,
`AGENTS.md`, and **SPEC §2 (lines 92–141), §5 (250–277), and §11 (470–606)** — those
ranges, not the whole file.

In `test/run-lock.test.ts`, `describe("the run's scope")` has the case
`"logs through the run log as a second subscriber to the same events"`. That is the pattern to copy.

**Already on the branch — do not rewrite** T1–T12's modules; amend `AGENTS.md` only with a ruling you
had to discover. **Do not touch hae files.**

## Effect wiring

- **Tags introduced**: `Notifier`.
- **Tags consumed**: `AgentboxConfig`, `Reporter`, plus `CommandExecutor` **directly, no wrappers**.
- **Not introduced**: `PromptSource`, `Prompt`, `IssueStore`. Do not stub them.
- **Layer composition**: `NotifierLive` depends only on config and the platform, so it joins the
  merged resource layer. Copy this, do not derive it:

  ```ts
  export const AppLive: Layer.Layer<
    | AgentCli
    | Forge
    | Notifier
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
      Layer.mergeAll(SandboxLive, GitLive, RunLockLive, ForgeLive, NotifierLive),
      Layer.provideMerge(LedgerLive, Layer.provideMerge(AgentboxConfigLive, PlatformAndReporterLive)),
    ),
  );
  ```

  **`AppBaseLive` is byte-unchanged** — `status` and `doctor` notify nobody.
- **Errors**: a notify failure is never in the run's error channel. It is caught at the call site,
  warned through `Reporter`, and discarded.

## Acceptance criteria

- [ ] `Notifier` is one method behind a tag, with the live implementation going through the chokepoint
- [ ] `notify = off` invokes the notifier zero times; `end` sends exactly one notification carrying
      the outcome and the PR; `steps` adds step notifications
- [ ] Step notifications subscribe to the `Reporter` event stream; no notify call is embedded inside
      a dispatch op
- [ ] A failing notifier leaves the run's row and exit status unchanged and produces a `Reporter`
      warning (matrix row 21)
- [ ] A missing host notifier binary degrades to a warning rather than failing or crashing
- [ ] `AppLive` matches the composition above verbatim; `AppBaseLive` is byte-unchanged

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, grep bans, and fake-tier tests. `pre-commit` is not a
substitute and does not check this package.

**Host-only**, run by the user before landing — notifications are a host surface:

```
node src/bin.ts <spec> --branch <throwaway-branch>
```

Once with `notify = end` (expect exactly one notification at the end), once with `notify = off`
(expect none), and once with the notifier binary renamed away (expect a warning and a successful
run).
