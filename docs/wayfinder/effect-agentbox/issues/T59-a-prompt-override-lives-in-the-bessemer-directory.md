# T59 — A prompt override lives in the bessemer directory

Status: Done (PR #19, but the review's one `Not-fixed:` outlived the merge — the self-hosted
no-override case asserted `<packageRoot>/.bessemer/prompts/implement.md` absent against the real
working tree, so an operator of this repo using the very feature T59 ships turns `npm run verify`
red, and that gate runs inside every dispatch's clone. Judged deliberate in `f3d122d` and then
restaged onto a substituted `readFileString` in `50069dc`, which landed on T60's branch in PR #21)
Type: AFK
Blocked by: [T57](T57-config-and-runtime-state-live-in-the-bessemer-directory.md). The prompt layer
needs the served repo, and T57 is what makes `appLiveFor(repoRoot)` a function it can be handed to.

<!--
[Ticket 18](../18-where-the-package-lives-and-what-it-is-called.md) §2 moved the client-override
root from the runtime root to the repo root — "one caller moves to the right side of a rule the
codebase had already written down" (`resolveTasksDir`'s comment: the runtime root is write
locations; a read location resolves against the repo root). [19](../19-the-tool-serves-a-repo-it-does-not-live-in.md)
§2 then amended the path, not the root: `<repoRoot>/.bessemer/prompts/<name>.md`, "so bessemer
stops claiming a top-level `prompts/` in an adopter's repo" — and deleted the guard 18 had kept,
because `.bessemer/prompts/` is never the package's own `prompts/`, self-hosted or not.

`prompt-source.ts` flags its own doubt about the runtime root at `:28-31`. This ticket answers it.
-->

## What to build

**A served repo overrides a prompt by putting a file at `<repoRoot>/.bessemer/prompts/<name>.md`,
and `project-context.md` lives beside it. The runtime root has nothing to do with it, and there is
no self-hosted special case.**

### The chain

`PromptSourceLive` reads `config.runtimeRoot` as the client root (`prompt-source.ts:119`). The
client root becomes `bessemerDir(repoRoot)`, and the paths are `promptPathIn(bessemerDir(repoRoot),
name)` — the same derivation the package arm uses, so the two roots still cannot resolve a name two
different ways. The fragment `project-context.md` resolves through the same chain, at
`<repoRoot>/.bessemer/prompts/project-context.md`.

**`clientIsPackage` is deleted**, with the block that explains it. It existed because the client root
defaulted to the package root and the chain would otherwise call every default a client override.
`.bessemer/prompts/` is never `<packageRoot>/prompts/`, so the case cannot arise: self-hosted, with no
file there, the chain falls through to the package default and reports "package", as it should.

`PromptSourceLive` stops consuming `AgentboxConfig` — nothing in it reads config once the runtime
root is out of the picture — and takes the served repo instead: `promptSourceLiveFor(repoRoot)`,
wired inside `appLiveFor(repoRoot)` and `appDryRunLiveFor(repoRoot)` (the rehearsal does not swap
it; T15's reason stands).

`prompt-source.ts` then imports nothing from `paths.ts` but `bessemerDir` — **its `packageRoot`
import is gone**, the third of the four T62's ban retires.

### Words

- The header of `prompt-source.ts`: two roots — the served repo's bessemer directory and the package
  — whole-file granularity; the paragraph beginning *"The client root is the runtime root, not
  `.agentbox/`"* goes, along with the `:28-31` doubt it records. Say *served repo* in prose;
  *client* survives only as the existing label `PromptRoot = "client"` and `promptRootLabel`'s
  "client override" text, which readers of logs already know (19 §9).
- `prompt.ts`'s comment on `promptPathIn` — "the client arm is this expression against the runtime
  root" — names the bessemer directory.
- SPEC §8, first bullet: `.agentbox/prompts/*.md` becomes `<repoRoot>/.bessemer/prompts/*.md`, and
  `project-context.md` is said to live there. 19 §10 lists §8 as a section the pass amends.

### Tests

`test/prompt-source.test.ts` builds `clientAt(runtimeRoot)` from a config layer; it becomes
`clientAt(repoRoot)` and writes overrides under `<repoRoot>/.bessemer/prompts/`. The case *"does not
call the package's own default a client override"* pins the deleted guard (`expect(
defaultConfig.runtimeRoot).toBe(packageRoot)`) and is replaced by two: self-hosted (`repoRoot ===
packageRoot`) with nothing under `.bessemer/prompts/` reports "package"; the same with a file there
reports "client". Add one more: a config whose `runtime-root` points elsewhere changes nothing
about which prompt wins — moving the runtime root moves writes only (`CONTEXT.md`).

## Effect wiring

- **Tags introduced or consumed**: `PromptSource`, unchanged in interface. It no longer requires
  `AgentboxConfig`.
- **Layer composition** — the merged resource term in `appLiveFor` and `appDryRunLiveFor`:

```ts
export const promptSourceLiveFor = (
  repoRoot: string,
): Layer.Layer<PromptSource, never, FileSystem.FileSystem | Path.Path> => /* Layer.effect(PromptSource, …) */;

Layer.mergeAll(SandboxLive, GitLive, RunLockLive, ForgeLive, NotifierLive, promptSourceLiveFor(repoRoot))
```

Everything else in both expressions is as T57 left it.

## Acceptance criteria

- [ ] `<repoRoot>/.bessemer/prompts/implement.md` wins over the package default and the assembled
      prompt is reported as the client override; with no such file, the package default wins and is
      reported as "package".
- [ ] Self-hosted (`repoRoot === packageRoot`) with no override reports "package" — with no guard.
- [ ] A configured `runtime-root` elsewhere changes nothing about which prompt wins.
- [ ] `project-context.md` is read from `<repoRoot>/.bessemer/prompts/`.
- [ ] `src/agent/prompt-source.ts` no longer imports `packageRoot` and no longer consumes
      `AgentboxConfig`.
- [ ] SPEC §8 names the new path.
- [ ] The suite passes.

## Verify

```
npm run verify
```

Run from the repo root — the package has sat there since T56. This is the gate — typecheck (with
Effect diagnostics: **errors and warnings break the build**, suggestions print), lint, and tests.
`pre-commit` is not a substitute and does not check this package.
