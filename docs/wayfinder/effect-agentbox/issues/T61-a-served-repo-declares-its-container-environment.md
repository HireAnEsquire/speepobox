# T61 — A served repo declares its container environment

Status: Done (PR #20; containment is lexical — `resolveSandboxEnvFile` (`src/config/paths.ts:129-133`)
`join`s and string-prefix-compares without a `realpath`, so a symlink inside the repo pointing out of
it satisfies the guard. Left as it is — the key rests on the file being committed and reviewable —
and written into SPEC §6 on 2026-09-18, having lived in the PR body alone until then)
Type: AFK
Blocked by: [T56](T56-the-package-roots-at-the-repo.md). Free-standing otherwise (19 §10): it
depends on no root placement and on nothing in T57–T60.

<!--
[Ticket 19](../19-the-tool-serves-a-repo-it-does-not-live-in.md) §5, whole: "A repo declares its
container environment with one key — `sandbox-env-file`: optional, no default, a single path
relative to the served repo, rendered as `docker run --env-file <path>`." hae needs it: it commits
a sandbox env file of a few hundred application settings that its setup script must agree with,
which is why the probe could not run hae's backend spec.

Rejected there: forwarding named host variables (an adopter would need every one of them in the
dispatcher's own environment — the leak the allowlist exists to prevent), literal values in config
(argv), and passing the repo's `.env` wholesale the way bash does (the credential stays on T23's
name-only path).

Probe finding 8 — container storage — is **not** built (19 §6) and is not here.
-->

## What to build

**A served repo names one file, inside itself, and docker hands that file's contents to the
container. Bessemer never opens it.**

### The key

`sandbox-env-file`, a string, default `""` meaning "none" — the convention `setup-hook` already
uses, so a repo that declares neither has neither step. It joins the descriptor and the shape as
`sandboxEnvFile`, with a `withDefault` of the empty string. A single path, not a list: list-valued
keys merge per index across config layers (AGENTS.md's `cap-add` ruling).

### The path rule, in the pure module

`resolveSandboxEnvFile(repoRoot, declared)` in `src/config/paths.ts`, beside `resolveSetupHookPath`,
answering one of three: *none* (the empty string), *inside* with the absolute path, or *outside*
with a reason. Inside means: the declared value is relative, and its normalized join onto `repoRoot`
still starts with `repoRoot` — so `a/../../x` and `../x` are outside, and so is any absolute value.
This is on purpose the opposite of `tasks-dir` and `setup-hook`, which accept absolute paths: this
is the only key whose file's *contents* enter the sandbox, so the file stays inside the served repo,
where review sees it (19 §5).

### The guard, before the lock

`sandboxEnvFileFound(repoRoot, declared)` in `dispatch/guards.ts`, on `setupHookFound`'s shape and
T7's rule: *outside* is refused, naming the key and the reason; *inside* but not an existing regular
file is refused, naming the path (a missing file is a guard's answer, not a container's); *none*
passes. Refused means no lock, no ledger row, one line on stderr. The check is a `stat`, never a
read — see the guarantee below.

### The spec and the argv

`SandboxSpec` gains `envFile: Option<string>`, its own field beside `env` — which stays bessemer's
own one-variable-at-a-time allowlist and is not touched. `sandboxSpecFor` fills it from the
resolver's *inside* arm (the guard has already refused the others, exactly as `setupHookMount` and
`setupHookFound` split the work today). `renderRunArgs` emits `--env-file <path>` before the `-e`
entries. The dry run's sandbox line renders through the same function and so shows the path with no
change to `dry-run/sandbox.ts`.

### The guarantee, stated where it is kept

**Bessemer never opens the file; docker reads it.** That is *why* its values cannot reach argv, a
log, the ledger, or an event — the path may appear in any of them, the contents never. Put that
sentence on the spec field and on the resolver, and hold it: no `readFile` of this path anywhere in
`src/`.

SPEC §9's two unrepresentable invariants are untouched (no ports field; no userinfo on a `RepoUrl`).
The `@ts-expect-error` pin in `test/sandbox-spec.test.ts` stays.

### Documents

- SPEC §2's naming paragraph lists what the spec type expresses (image reference, mounts, env
  allowlist); add the env file.
- SPEC §6's key list gains `sandbox-env-file`.
- SPEC §9 gains one line under the `extendEnv: false` sentence, which stays literally as it is: the
  allowlist governs inherited parent environment, which stays banned; a declared env file is the
  served repo's explicit act, carried in its own field. Whatever the repo puts in that file, the
  agent can read, and that is the repo's call (04).
- `config.toml` gains a commented-out example paragraph beside `setup-hook`'s, in its voice: what
  the key is, that it is relative to the repo and refused outside it, that this repo declares none.

## Effect wiring

- **Tags introduced or consumed**: `Sandbox` — its spec type gains a field; its interface does not
  change. `AgentboxConfig` gains a field.
- **Layer composition**: unchanged.

## Acceptance criteria

- [ ] `sandbox-env-file = ".bessemer/env.sandbox"` with that file present renders
      `--env-file <repoRoot>/.bessemer/env.sandbox` in the rehearsal's sandbox line, and no read of
      the file happens.
- [ ] With the key absent, the rendered argv is byte-identical to today's.
- [ ] An absolute value, a value that escapes the repo after normalization, and a relative value
      naming no file are each refused before the lock, with no ledger row, and the message names the
      key and which of the three it was.
- [ ] `SandboxSpec.env` still has exactly one entry — the credential's name — on every run.
- [ ] Nothing under `src/` reads the named file's contents.
- [ ] SPEC §2, §6, §9 and `config.toml` are amended as above.
- [ ] The suite passes.

## Verify

```
npm run verify
```

Run from the repo root — the package has sat there since T56. This is the gate — typecheck (with
Effect diagnostics: **errors and warnings break the build**, suggestions print), lint, and tests.
`pre-commit` is not a substitute and does not check this package.
