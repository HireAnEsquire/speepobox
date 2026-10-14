# T14 — `PromptSource`: override precedence and the project-context fragment

Status: Done
Type: AFK
Blocked by: T13

Sequence: [ticket 08](../08-in-hae-sequence.md), re-sliced 2026-08-10. Blocked by
[T13](T13-notifier.md) rather than [T12](T12-forge-pr.md) for one reason only: both tickets add a
layer to `AppLive`, and the composition below is pasted for copying, so it has to be the shape that
actually exists when this ticket starts. Runs in parallel with [T16](T16-resume.md), which changes no
layer.

**Tracer: a client override takes effect, and the log says which root won.** Drop a replacement
implement prompt into the client prompts directory, dispatch, and the log shows the client's text
being used and names the root it came from. Remove it and the package default returns, named as such.
Add a `project-context.md` fragment and watch the default prompts interpolate it.

## What to build

The client-facing extension point (05 Q6/Q9, SPEC §8). T9, T10, and T12 each shipped a package
default prompt read by a pure interpolation function; this ticket turns that single root into the
precedence chain and converts all three call sites at once.

**This is why it is built before the move rather than after.** Once bessemer dispatches its own
issues, *it* is the client — the `project-context.md` fragment naming its own verify command is what
makes a self-dispatch produce useful work.

### 1. The tag

It earns a tag on the **precedence logic** and on being the surface clients extend — not on file
reading, which `FileSystem.layerNoop` already fakes (05 Q9).

`get(name)` returns **the resolved text and which root won**. Both halves are load-bearing: bash logs
the assembled prompt verbatim before each pass (`run.sh:1096`), and a client needs to see their
override actually take. T9 already logs the prompt; this ticket makes the log say where it came from.

### 2. Precedence and granularity

- a client's `prompts/*.md` under the runtime root beats the package defaults
- **override granularity is whole-file replacement only**, plus a separate small
  **`project-context.md` fragment** that the default prompts interpolate. The fragment is the narrow
  common case — a client's test command, its setup notes — and it survives the defaults improving
  underneath them; whole-file replacement is the escape hatch
- **fragment-patching a template is refused**: it is a mini-templating-language, and it was rejected
  by name in 05 Q9. If a client needs more than a fragment, they replace the file
- **interpolation stays a pure function** — the one T9 wrote. Do not move it behind the tag

Under the clone-run model prompts are just files in the cloned tree, so there is no bundling problem
(ticket 01).

### 3. What this is not

**`PromptSource` is a different surface from `AGENTS.md`** (06 §4). `AGENTS.md` is our own
development guidance and never ships to users; these prompts are the product. Do not merge them, do
not read one from the other.

## Not in scope

`Prompt` and clack — all interactive prompting is post-move (P3). `init` and adapter scaffolding are
P5. `--dry-run` (T15) and resume (T16). Do not stub them.

## Read first

T9's prompt files and interpolation function, T10's review prompt, T12's PR-description prompt,
`src/config/config.ts` (the runtime root), `AGENTS.md`, and **SPEC §8 (lines 368–386)** —
that range, not the whole file. §8 is nineteen lines; read it exactly.

**Already on the branch — do not rewrite** T1–T13's modules; amend `AGENTS.md` only with a ruling you
had to discover. **Do not touch hae files** — hae's own prompts do not travel, and this package ships
its own defaults (SPEC §12's expected-divergence list).

## Effect wiring

- **Tags introduced**: `PromptSource`.
- **Tags consumed**: `AgentboxConfig`, `Reporter`, plus `FileSystem` / `Path` **directly, no
  wrappers**.
- **Not introduced**: `Prompt`, `IssueStore`. Do not stub them.
- **Layer composition**: `AgentCli` consumes `PromptSource`, so `PromptSourceLive` goes **inside** the
  merged layer that `AgentCliLive` is provided over. Copy this, do not derive it:

  ```ts
  export const AppLive: Layer.Layer<
    | AgentCli
    | PromptSource
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
      Layer.mergeAll(
        SandboxLive,
        GitLive,
        RunLockLive,
        ForgeLive,
        NotifierLive,
        PromptSourceLive,
      ),
      Layer.provideMerge(LedgerLive, Layer.provideMerge(AgentboxConfigLive, PlatformAndReporterLive)),
    ),
  );
  ```

  **`AppBaseLive` is byte-unchanged.**
- **Errors**: a missing client override is not an error — it is the package default winning. A
  malformed or unreadable prompt file that *was* selected is a typed failure the run reports; a
  prompt the package itself is missing is a **defect**, since that is our own invariant breaking.

## Acceptance criteria

- [ ] `PromptSource.get(name)` returns the resolved text **and** which root won, and both are covered
      by tests
- [ ] A client prompt under the runtime root beats the package default; removing it restores the
      default
- [ ] The verbatim prompt log names the winning root, for every pass
- [ ] The `project-context.md` fragment is interpolated by the default prompts, and its absence is
      not an error
- [ ] Override granularity is whole-file only — no fragment-patching, no templating syntax beyond the
      existing pure interpolation
- [ ] All three call sites — implement, review, PR description — go through the tag; no direct
      package-path read remains
- [ ] `AppLive` matches the composition above verbatim; `AppBaseLive` is byte-unchanged

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, grep bans, and tests. `pre-commit` is not a substitute
and does not check this package.

**Host-only**, run by the user before landing:

```
node src/bin.ts <spec> --branch <throwaway-branch>
```

Once with a client override present and once without, confirming from the run log that the winning
root differs between the two and that the text used matches it.
