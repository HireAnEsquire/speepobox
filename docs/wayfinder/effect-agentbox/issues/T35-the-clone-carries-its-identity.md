# T35 — The clone carries its commit identity, and nothing else

Status: Done
Type: AFK
Blocked by:

Sequence: not on [ticket 08](../08-in-hae-sequence.md)'s move-out path — a parity gap found by running
gate 1's tracer by hand on 2026-08-18, not by a failing test. It lands on its own like
[T23](T23-one-credential-source.md) did: a correctness fix to code already on the branch, promoted out
of a live run's report rather than out of a review log.

**Tracer: a bessemer-dispatched run's commits are authored by the dispatching dev, without the agent
having been asked, told, or able to find out anything else about them.**

## What to build

One value written into the clone before the container starts, and a pin on everything the container
does *not* get.

### 1. The gap

`run.sh:1450-1458` clones, re-points `origin`, and then writes two values into the clone's own config:

```
# commit identity for the in-container agent (clone-local, nothing global):
# the dispatching dev's own identity, so PR commits attribute to them
git -C "$wt" config user.name  "$(git config user.name  || id -un)"
git -C "$wt" config user.email "$(git config user.email || echo agentbox@users.noreply.github.com)"
```

bessemer does none of it — `grep -rnE "user\.name|user\.email|gitconfig|GIT_AUTHOR|GIT_COMMITTER"
src/` returns nothing. Every bessemer-dispatched run so far has landed commits under an identity the
**agent invented on the spot**, because the task required a commit and the container had none. The run
that surfaced it reported:

> this container had no git identity configured at all (no `~/.gitconfig`, no local
> `user.name`/`user.email`) … I set a local-only `user.name`/`user.email`
> (`Claude Agent <agent@anthropic.com>`) in this repo to unblock committing

That is the defect: not the value, which was reasonable, but that **the value is whatever the agent
improvised**. A different agent invents a different one, or reaches for `git commit --author`, or
fails the pass. The identity on a run's commits is a property of the dispatch and must not depend on
the model's improvisation.

### 2. The decision this copies

**The dispatching dev's identity, read from the repo, written clone-local.** bash's comment states the
intent and this ticket does not relitigate it: the human who typed the dispatch is accountable for
what it produced, and `Co-Authored-By:` is what marks the agent's hand. Precedence and fallbacks as
bash has them — `user.name` then the host username, `user.email` then
`agentbox@users.noreply.github.com`.

**Read exactly two values and write exactly two.** Not the host's gitconfig, which is where credential
helpers, `url.*.insteadOf` rewrites, and signing keys live; those must not reach a container and must
not be inherited by accident. bash never mounts `~/.gitconfig` and neither does this — the reason it
gets to be a two-line change is that it is deliberately not a config passthrough.

**Never `--global`, and never inside the container.** The write happens on the host, into the clone,
in the checkout step, before `docker run`. That ordering is the point: an identity the agent could set
is a claim, and one the dispatcher set before the agent existed is a default the agent had no part in.

Be honest about what that buys, in the code comment and nowhere else: the agent owns its clone
(`git/git.ts:137-142`), so it *can* override the value or pass `--author`. This makes correct
attribution the path of least resistance and makes a deviation visible in the commit — it is not
enforcement, and the ticket does not pretend otherwise. Rewriting commits at land to enforce it is
**out of scope**.

### 3. The shape

`Git` gains a config read and a config write, both repo-scoped like every other read on that tag, and
both going through `inRepo` so they name the repository they act on (T27, T32). The checkout step's
acquire calls them between `clone` and the resource being reported acquired.

Resolve the fallback username from `os.userInfo().username` rather than shelling to `id -un` — it is
the same answer without a child process. It reads the host, so it belongs inside `Effect.suspend`,
for the reason `inRepo`'s `resolve` does (T32): describing an operation may not reach the host, only
running it may.

Not a composition-root read, and **not threaded like T23's credential**: a credential is a host fact
with no repository to ask, while this is `git config` run in a repo — an ordinary `Git` read that the
tag's fake already knows how to record. Do not add a parameter to `dispatchCli`, `dispatch`,
`planFor`, or `runInScope`.

### 4. Pin what the container holds

The reason this ticket is worth a session rather than a two-line commit. Adding a value to the clone
is the moment to assert the rest is unchanged, as tests rather than as prose, so the posture cannot
erode the way this gap opened — silently, with everything still green.

What is true today, verified while writing this ticket. Each line is an assertion to write, not a
claim to restate:

- **Mounts** are the workspace (read-write, the clone), `/spec.md` (read-only), and the config-declared
  setup hook (read-only). `SandboxMount` has no mode field, so read-only is a shape. No host repo, no
  `~/.ssh`, no `~/.gitconfig`, no docker socket.
- **Environment** is one variable: the agent credential, forwarded by name (`docker run -e NAME`, no
  value) with the value reaching docker's own child environment. `ENV_ALLOWLIST` in
  `internal/exec.ts` is `PATH` and `HOME` and nothing else — T23 removed the token from it.
- **`origin` in the clone is the repo root's local path**, which is not mounted, so a `git fetch` or
  `git push` from inside the container reaches nothing at all. This is *more* restrictive than bash,
  which re-points `origin` at the real remote. Assert it rather than improve it: commits come home by
  the dispatcher fetching **from** the clone (`git/git.ts:140-142`), never by the agent pushing.
- **The clone is `--no-hardlinks`** (`git/git.ts:320`), so its objects are copies. A hardlinked object
  is one inode, and an agent writing through it would reach into the host repository's object store.
- **`--cap-drop ALL` comes first** and only config-declared caps are added back; there is no ports
  field to misuse.

State the residual risk in one comment where the credential is threaded, and do not paper over it:
the agent holds the LLM API credential because it must call the model, so anything inside the
container is reachable by that endpoint. The mitigation is that it is the **only** credential present
— the blast radius is model spend, not repository writes and not cloud access.

## Not in scope

Signing commits, `--author` enforcement, or rewriting commits at land. Changing `origin` to a
fetchable remote. Any new config key — the identity is read from the repo, not declared. Reading
anything else out of the host's git config. `src/app.ts`.

## Read first

`src/dispatch/checkout.ts`'s acquire (the `clone` call and the `ResourceAcquired` emit either side of
it), `src/git/git.ts` — `GitShape`, `inRepo`, and `clone` — and `run.sh:1450-1462`, read as a
reference document and never executed. `src/sandbox/spec.ts` and `src/internal/exec.ts` are what unit
4's assertions are about; read the `ENV_ALLOWLIST` comment and `renderRunArgs`, not the whole files.

`test/support/exec-fake.ts`'s `recorded` ref holds every word of argv every child ran — that is how
"the identity was written into the clone and nowhere else" becomes an assertion. `test/git.test.ts`'s
shape pin is the pattern for asserting a read names its repository.

**Already on the branch — do not rewrite** T1–T23's modules beyond what this ticket names. Amend
`AGENTS.md` only with a ruling you had to discover. **Do not touch hae files.**

## Effect wiring

- **Tags introduced**: none.
- **Tags consumed**: `Git`, `Reporter` — unchanged. `Git` gains two operations on its existing shape;
  the fake in `test/support/` gains them with it.
- **Layer composition**: **unchanged — do not edit `src/app.ts`.** No service is added.
- **Errors**: a config write that fails is a `GitError` like any other write in the checkout step —
  it happens inside the resource's acquire, so the existing release path already covers it. A host
  with no `user.name` is **not** an error; it is the fallback, which is the whole reason bash has one.

## Acceptance criteria

- [ ] A clone carries `user.name` and `user.email` in its own config before the container starts,
      taken from the repo's config where set
- [ ] An unset `user.name` falls back to the host username and an unset `user.email` to
      `agentbox@users.noreply.github.com`, neither of which is an error
- [ ] The write is clone-local: no `--global`, no `~/.gitconfig` read, no config key beyond the two
- [ ] Both operations name the repository they act on, asserted the way `test/git.test.ts` pins the
      other reads
- [ ] The exec fake's `recorded` ref shows the identity written into the checkout path and nowhere
      else
- [ ] A test asserts the sandbox spec's env list is exactly the one credential entry, by name, with
      no value
- [ ] A test asserts `ENV_ALLOWLIST` is exactly `PATH` and `HOME`
- [ ] A test asserts the clone is made with `--no-hardlinks`
- [ ] A test asserts the mount list is workspace read-write plus spec and setup hook read-only, and
      that no mount names a path outside the run's own
- [ ] `src/app.ts` is unchanged

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, grep bans, and fake-tier tests. `pre-commit` is not a
substitute and does not check this package.

**Host-only**, run by the user before landing — the task container has no docker socket:

```
node src/bin.ts <spec> --branch <throwaway-branch>
git log --format='%an <%ae>%n%b' <throwaway-branch> -3
```

Every commit must be authored by the dispatching dev, with no line in the agent's output reporting a
missing identity. Then, in the run's checkout while it is up:

```
git -C <checkout> config --local --list | grep -c '^user\.'
```

must be `2`.

Do not print the agent credential while testing, and do not paste `.env` into a terminal whose output
is captured.
