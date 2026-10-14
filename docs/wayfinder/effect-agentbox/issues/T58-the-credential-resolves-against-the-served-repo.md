# T58 — The credential resolves against the served repo

Status: Done (PR #18; two of the criteria have no honest fixture — a token at `<packageRoot>/.env`
going unfound, and `doctor`'s own `bessemerDir(host.repoRoot)` wiring, would each have to be planted
under this very repo — so both are recorded `Not-fixed:` in `b1c39c4` and the `packageRoot` half is
confirmed by hand only)
Type: AFK
Blocked by: [T57](T57-config-and-runtime-state-live-in-the-bessemer-directory.md). Not for a code
reason — the one-line change below would typecheck today — but because 19 §3 orders the operator's
`.env` move *after* `.bessemer/.gitignore` has merged, and that file is T57's.

<!--
[Ticket 19](../19-the-tool-serves-a-repo-it-does-not-live-in.md) §3: "The credential resolves
against the served repo — `<repoRoot>/.bessemer/.env`, then the process environment. Nothing is
read from the package (probe finding 3: a repin re-clones the cache, and one cache serves every
repo), and no user-level file is added."

Probe finding 3 is the one this exists for: pointed at hae, the dispatcher read
`<packageRoot>/.env` — a file in a directory the shim will re-clone on every repin, shared by every
repo the operator serves. T23's shape is untouched: one resolver, called at the composition root,
the value `Redacted`, forwarded by name. Only the root it is handed changes, plus one thing the
resolver starts saying about its answer for T62's roots row.
-->

## What to build

**Both readers of the credential ask the same resolver with the same root, and that root is the
served repo's bessemer directory.**

### The root

- `bin.ts:107` — `resolveCredential(packageRoot)` becomes `resolveCredential(bessemerDir(repoRoot))`.
- `doctor.ts:101` — `credentialProbe(packageRoot)` becomes
  `credentialProbe(bessemerDir(host.repoRoot))`.

`doctor.ts` then imports nothing from `paths.ts` but `bessemerDir` — **its `packageRoot` import is
gone**, the second of the four T62's ban retires.

The resolver's contract does not change: `<root>/.env` first, then the process environment, both
names tried in order, a declared-but-empty variable is not a credential, an unreadable file is an
empty provider and never a failure. `CREDENTIAL_ADVICE` ("in .env beside config.toml") is true
unedited — `config.toml` is in the same directory since T57.

What is deliberately *not* read, and the resolver's header should say so in a sentence each: the
package (a repin re-clones it, and one cache serves every repo), the served repo's own top-level
`.env` (that file belongs to the application, and in any repo that is not hae it means something
else), and any user-level file (the token belongs to a person, and a person who exports
`CLAUDE_CODE_OAUTH_TOKEN` in their shell profile already has the user-level answer).

### The resolver says where it found the answer

`AgentCredential` gains `source: "file" | "environment"`. The precedence is unchanged — the file
beats the environment *per name*, so an exported `CLAUDE_CODE_OAUTH_TOKEN` still beats an
`ANTHROPIC_API_KEY` in the file — but each name is now asked of the two providers in turn rather
than of one merged provider, so the resolver knows which one answered. Probe 3's row says it:
`CLAUDE_CODE_OAUTH_TOKEN set from <root>/.env (value not shown)` or `… set from the environment
(value not shown)`. The path may appear; the value never does, and the `Redacted` discipline
(exactly two `Redacted.value` calls in the package) is untouched.

T62's roots row prints the same field, which is why it is added here and not there.

### Wording that stops being true

- `bin.ts`'s comment above the `Effect.all` — "`<packageRoot>/.env` — the file beside `config.toml`
  that `doctor` tells a host to write" — names the new root.
- `credential.ts`'s header, same.
- `AGENTS.md`, *Subprocesses and the environment*: "`<packageRoot>/.env` then the process
  environment" becomes `<repoRoot>/.bessemer/.env`, and the three things not read (above) join the
  paragraph in one sentence. 19 §10 lists this paragraph as one the pass amends.

### After it merges (operator, on the host — not this pass)

`mv .env .bessemer/.env` — `mv`, never copy, never read into any agent's context, never touched by
an AFK pass. Between this ticket merging and that move, a self-hosted dispatch is refused before the
lock with probe 3's advice. That fails closed and is the intended state (19 §3).

## Effect wiring

- **Tags introduced or consumed**: none. `agent/credential.ts` is a module and not a tag, for the
  chokepoint's reason, and stays one.
- **Layer composition**: unchanged. The resolver runs at the composition root and its answer travels
  as a parameter, exactly as today.

## Acceptance criteria

- [ ] With `repoRoot` a temporary directory that is not `packageRoot`: a token in
      `<repoRoot>/.bessemer/.env` is found; the same token placed only in `<repoRoot>/.env` or in
      `<packageRoot>/.env` is not.
- [ ] Per-name precedence is unchanged: `CLAUDE_CODE_OAUTH_TOKEN` in the environment beats
      `ANTHROPIC_API_KEY` in the file; `CLAUDE_CODE_OAUTH_TOKEN` in the file beats the same name in
      the environment.
- [ ] The resolver's answer carries its source, and probe 3's row names the file path or the
      environment — never the value.
- [ ] `doctor` and the dispatch hand the resolver the same root, derived in one place.
- [ ] `src/doctor/doctor.ts` no longer imports `packageRoot`.
- [ ] `AGENTS.md`'s credential paragraph names `<repoRoot>/.bessemer/.env`.
- [ ] The suite passes.

## Verify

```
npm run verify
```

Run from the repo root — the package has sat there since T56. This is the gate — typecheck (with
Effect diagnostics: **errors and warnings break the build**, suggestions print), lint, and tests.
`pre-commit` is not a substitute and does not check this package.
