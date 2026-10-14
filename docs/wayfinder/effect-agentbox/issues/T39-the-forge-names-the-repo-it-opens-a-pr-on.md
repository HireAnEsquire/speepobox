# T39 — The forge names the repo it opens a PR on

Status: Done (PR #5; probe 5 moved onto the shared read as asked, and `doctor` now performs it once for both probes rather than twice)
Type: AFK
Blocked by: None — can start immediately.

<!--
Found by 09's P1 probe, 2026-09-04. Full context:
docs/wayfinder/effect-agentbox/research/09-p1-hae-probe-findings.md, finding 1.

Carved out of ticket 19 on purpose: 19 asks which roots belong to the served repo and has real
decisions in it, while this one has none — the answer is the same shape `git/git.ts` already uses.
-->

## What to build

Every `gh` call names the repo it acts on, taken from the served repo rather than from wherever the
dispatching process happens to be running.

Today `git` is scoped explicitly — `inRepo` renders `git -C <at> --git-dir=<at>/.git`
(`git/git.ts`) — and `gh` is scoped by nothing: the helper is `exec(FORGE_CLI_BINARY, ...args)`
(`forge/forge.ts`), `exec`/`execStreamed` accept no working directory, and neither `prView`,
`prCreate`, nor `prEdit` passes `--repo`. So `gh` falls back to resolving the repo from the current
directory.

Measured during the probe, from two directories on one host:

```
$ gh repo view --json nameWithOwner        # in ~/bessemer
{"nameWithOwner":"HireAnEsquire/bessemer"}

$ cd <served-repo> && gh repo view --json nameWithOwner
{"nameWithOwner":"<owner>/<served-repo>"}
```

A dispatch launched from the wrong directory therefore aims its PR at the wrong repo. In the probe
it failed loudly — the target repo had neither ref, and GitHub returned five validation clauses for
the one cause — but that was luck. A repo holding a branch of the same name and a matching base
would have accepted a draft PR carrying another repo's work.

Resolve the forge repo **once, at the composition root**, from `repoRoot`'s origin remote, and pass
it down as a parameter, exactly as `repoRoot` itself is (`AGENTS.md`: host facts are resolved once
and passed down; *make it unrepresentable rather than remembered*). A `--repo <owner>/<name>`
argument on every `gh` invocation is the mechanism; the point of the ticket is that no `gh` call can
be written without one.

Note the adjacent gap while you are here: `exec`/`execStreamed` have no working-directory parameter
at all. Adding one is a legitimate alternative mechanism — `gh` run with cwd set to `repoRoot` — but
`--repo` is preferred, because a cwd is a thing a future edit can forget to set and an argument the
type system requires is not.

### There is already one origin read, and it is in the wrong place

**The `Git` tag has no operation for it, but `doctor` does the read anyway** — probe 5 shells
`exec("git", "-C", repoRoot, "remote", "get-url", "origin")` directly
(`doctor/probes.ts`), around the tag rather than through it. So this ticket does not add a first
reader; it adds the *definition* the existing reader should have been using, and moves that reader
onto it. That is the same shape T42 made for the freshness question, and for the same reason: two
callers asking one question through two copies is the drift a shared definition exists to prevent.

Concretely, the operation goes on `Git`, rendered through `inRepo` like every other — not shelled from
`forge.ts`, which would put a *third* copy in the exact module this ticket exists to stop being
unscoped — and probe 5 becomes a caller of it. That is what makes the `doctor` acceptance criterion
below fall out rather than be bolted on.

**`RepoUrl` (`git/repo-url.ts`) is not where the slug goes.** It brands a URL that carries no
userinfo, and that is a different invariant from "this string names owner and repo". A remote is also
an scp-like `git@github.com:owner/name.git` or a local path, so the slug parse has cases `RepoUrl`
deliberately passes through verbatim. Write it as its own pure module beside `RepoUrl` — same shape,
its own question — and let the two compose rather than overloading either.

**Both test routes are already in this repo, and they are different.** `forge.test.ts` drives
`ForgeLive` over the **scripted executor** (`test/support/exec-fake.ts`) and asserts rendered argv —
that is where "every `gh` call carries `--repo`" is proved, and it needs nothing from the `Git` fake.
`test/support/git-fake.ts` is the other route, for callers that take the `Git` tag. Pick per test by
which one the code under test actually resolves through; do not assume, and do not make the fake
answerable unless a test you are writing reaches it.

## Effect wiring

- **Tags introduced or consumed**: `Forge` (consumed and changed), `Git` (consumed and **grown by one
  read operation**, per the section above; still the model to copy for how `Forge` should scope).
- **Layer composition**: unchanged. `ForgeLive` keeps its
  `Layer.Layer<Forge, never, CommandExecutor.CommandExecutor>` shape — the repo slug travels as a
  field on the operation arguments, the way `repoRoot` travels on `SandboxSpec`, not as a new
  service or a new layer requirement. Do not add a tag for "which repo": it is a host fact resolved
  at the composition root, and 05's rule is that a tag is a seam, not a value holder.

## Acceptance criteria

- [ ] A dispatch run from a directory outside the served repo opens its PR on the served repo.
- [ ] A dispatch run from a directory inside a *different* git repo does the same — the operator's
      shell has no influence on which repo is acted upon.
- [ ] `prView`, `prCreate`, and `prEdit` all name the repo; none can be called without one.
- [ ] The slug is derived from `repoRoot`'s `origin` remote and resolved once, not per call.
- [ ] A repo root whose `origin` cannot be read fails as a typed error naming the repo root, not as
      a `gh` error about a missing ref.
- [ ] `doctor`'s `gh` probe reports the repo it resolved, so a green row states which forge this
      dispatch would act on.
- [ ] `doctor`'s probe 5 and the dispatch resolve `origin` through one definition, not two — the
      probe no longer shells `git remote get-url` on its own.

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package.

Land a green piece before you start an interlocking one. The order that goes green alone is: the new
`Git` read, with probe 5 moved onto it; then the slug parse as a pure module with its own cases; then
the threading through `Forge`. Committing at each of those three points is what let T42, T43, and T45
land — and what a pass killed mid-flight still leaves behind.

Cover the drift itself with a test: a fake `CommandExecutor` asserting the rendered `gh` argv
carries the expected `--repo`, which is the same shape `git`'s `-C` is already covered by. The
host-only half — that two directories on one host resolve two different repos — belongs in
`verify:live` if anywhere, and is probably not worth a case: the argv assertion is what stops the
regression.
