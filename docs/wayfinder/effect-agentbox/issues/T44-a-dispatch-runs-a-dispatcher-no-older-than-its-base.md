# T44 — A dispatch runs a dispatcher no older than its base

Status: Done (implementation only — its tests are T45)
Type: AFK
Blocked by: None — [T42](T42-doctor-asks-whether-the-dispatcher-is-stale.md) and
[T43](T43-every-row-records-the-dispatcher-that-ran-it.md) both landed 2026-09-08, and this ticket's
own expand step landed with them. See **What is already on `main`** below.

<!--
Third of three from the 2026-09-08 re-slice of T41, whose dispatch timed out at 900s having committed
nothing. Full design and the long-form evidence:
docs/wayfinder/effect-agentbox/issues/superseded/dispatcher-freshness.md.

**Re-aimed 2026-09-08 after its own first dispatch timed out.** That run also spent its full 900s,
but unlike T41's it committed two green pieces first — an expand step, both new forms sitting beside
the old with no consumer yet — and those were merged to `main` rather than discarded. The ticket was
four pieces where T42 and T43 were two each, which is the whole of why it did not fit; the remaining
scope below is the migrate, and it is deliberately the size of a ticket that has been observed to
fit. The pass timeout stays at 900: it has now rejected two oversized tickets and passed two
right-sized ones.

**This must land before the first P2 dispatch.** From P2 onward the tool dispatches itself out of
this repo (09 Q11) and every ticket stacks on the last, which is exactly when the dev is sitting on a
parent branch whose tree is behind.

**Dispatching this ticket is itself the stacking hazard it exists to catch**: it goes off a `main`
that must already carry T42, T43, and the expand step. On the first attempt the discipline held —
the run's base and its dispatcher were both `c7783117`, clean — and the check that stood in for the
guard was a `git rev-list --left-right --count` by hand. Do it again before branching.
-->

## What is already on `main`

Two commits from this ticket's first dispatch, both green under `npm run verify`. **Do not rebuild
them; the work below consumes them.**

- **`Git.dispatcherFreshness`** (`src/git/git.ts`, beside `branchContains`) —
  `({ repo, base }) => Effect<DispatcherFreshness, GitError>`. It renders
  `dispatcherFreshnessArgs` through `inRepo` and reads the verdict with `readDispatcherFreshness`,
  so this caller and `doctor`'s probe 10 ask through T42's one definition. A nonzero exit is
  `BaseUnresolvable`, not a `GitError` — only a git that never ran at all fails the effect. Covered
  in `test/git.test.ts`, and present on the fake in `test/support/git-fake.ts`.
- **`staleDispatcherOverridden`** on `RunRecord` (`src/ledger/record.ts`) — `Option<boolean>`,
  spelled as the same absent key on schema version 1 as `dispatcher` and `rescuedOnto`. `legacy.ts`
  decodes it as `None`. `run.ts` threads it from `runInScope` through `recordTerminal` to
  `terminalRecord` and writes `Option.some(true)` only when the override was used, so an ordinary
  run's row carries no such key. **Nothing sets it yet** — no preflight refusal exists to override.

## What to build

**A dispatch runs a dispatcher no older than the one on the base it targets, or it refuses.**

Refuse when `HEAD` is missing a commit under the package directory that the base ref already has.
The run would otherwise have different semantics than the base expects, and say nothing about it.

The question, its scope, its argv, and its verdict are all built. What remains is the caller that
refuses, the flag that overrides it, and the message a refused dispatcher reads:

- **The refusal**, in `dispatch/preflight.ts`, consuming `Git.dispatcherFreshness`.
- **`--allow-stale-dispatcher`**, in `dispatch/command.ts`, reaching the preflight and the row.
- **The rendered refusal**, in `dispatch/render.ts`, alongside the failures already there.
- **The row**, which means passing the flag to `runInScope`'s existing parameter — not adding one.

### Why a refusal and not a warning

Observed in bash on 2026-08-17. A dispatch whose base forked three days before the
issue-state-lives-on-the-branch change ran the *pre*-change dispatcher: issue state read from the
host working tree, no status commit on the branch. It also ran without the ahead-is-not-diverged
cleanup fix, which postdates the same fork point. Two mechanisms silently absent from one run, and
the console said nothing about either; the divergence was found days later by reading commit dates.

That is what separates this from the image-staleness warning already in `preflight.ts`, and from
T42's own probe row. A stale image still runs and the advisory can be acted on afterwards. A stale
dispatcher produces a plausible success whose semantics nobody can recover after the fact. `doctor`
reports because reporting is its whole job; the preflight refuses because it is the last moment the
run can still be stopped.

### Ancestry, not equality

Uncommitted local edits to the tool's own source are the normal state of a repo that is building
itself and must stay silent. What is refused is a `HEAD` missing commits the base already has.

The refusal only covers what the base can see; a dispatcher edited locally and never committed is
invisible to it. That is what T43's `dispatcher.dirty` field is for, and it is already recorded.

### Where it goes, and what it may touch

**`dispatch/preflight.ts`, not `guards.ts`.** It is a fact about host fitness, like the
authenticated-`gh` refusal already there, not a fact about the run.

**First in the preflight, before `dockerProbe`** — before any docker or network work. The call site
already has what it needs: `dispatch.ts` resolves `baseRef` above its `preflight(…)` call.

**It asks about `repoRoot`, the same root `doctor`'s probe 10 asks about.** Not because that root is
right — under P6's shim the dispatcher's own repo is the one enclosing `packageRoot`, which is what
T43 reads and what this should eventually read too — but because the two callers giving the *same*
verdict matters more than either being adopter-correct today, and during incubation the two roots are
one directory. **Do not fix that here.** The pair is
[19](../19-the-tool-serves-a-repo-it-does-not-live-in.md)'s to move together; splitting them now
would buy exactly the drift T42's one-definition module exists to prevent.

**It makes no network call.** The preflight resolves the base as this clone already has it and never
fetches. `--base` in this package names a remote-tracking ref (`guards.ts`), so reading `origin/main`
out of this clone is a local read — which is the property bash's *read the local base ref* rule
exists to protect. A stale local base is a `git fetch` away and is the operator's to run.

### The refusal, and the escape hatch

The refusal names the missing commit, the branch you are on, and the command that fixes it.

**It instructs; it does not repair.** Mutating the operator's checkout is not this tool's act. It is
the ruling `guards.ts` already carries for the neighbouring case — "Creating branches is the
dispatcher's act, never ours" — and a preflight that silently moved `HEAD` would be a refusal that
held something, against matrix row 1.

`--allow-stale-dispatcher` proceeds anyway, with a warning through the `Reporter` the preflight
already takes, and sets the `staleDispatcherOverridden` field already on the record. **That field is
an absent key on record version 1** and is already wired to write no key on an ordinary run; the flag
reaches it through `runInScope`'s existing trailing parameter, which currently defaults to `false`
because nothing supplies it.

**`BaseUnresolvable` does not refuse.** A base this clone cannot read is the operator's to fetch, and
it is what `doctor`'s probe 10 already warns about rather than failing on. Refusing here would stop a
dispatch on a stale clone rather than a stale dispatcher — a different fault with a different remedy.
Warn through the `Reporter` and proceed.

## Effect wiring

- **Tags introduced or consumed**: `Git` (consumed — the operation exists; this adds `preflight`'s
  call to it), `Reporter` (consumed, for the override and unresolvable-base warnings — `preflight`
  already takes it), `Ledger` (consumed through `runInScope`, unchanged: the field is already on the
  record).
- **`preflight`'s signature** grows the base ref and the override flag, and its error union grows one
  typed refusal alongside `DockerUnavailable | ImageUnavailable | GhUnavailable`; its requirement
  channel grows `Git`, which resolves through the same `CommandExecutor` it already carries and is
  already provided at the dispatch's composition root.
- **Layer composition**: unchanged. No new layer, no new `Layer.provide`.

## Acceptance criteria

- [ ] A dispatch whose `HEAD` is missing a package commit that its base already has is refused, and
      the refusal happens before docker is contacted.
- [ ] The refusal names a missing commit, the branch the dispatcher is on, and the command that
      fixes it, and it changes nothing about the checkout.
- [ ] A `HEAD` ahead of its base is not refused, and uncommitted edits under the package directory
      never trigger the refusal on their own.
- [ ] A base carrying commits that touch nothing under the package directory does not refuse.
- [ ] A base this clone cannot resolve warns and proceeds; it does not refuse.
- [ ] `--allow-stale-dispatcher` proceeds with a warning, and the row it writes records that the
      check was overridden.
- [ ] A run that never overrides the check writes a row with no `staleDispatcherOverridden` key, and
      rows already on disk still decode and still render on `status`, with the schema version
      unchanged.
- [ ] The preflight and `doctor`'s probe give the same verdict for the same repo state, because they
      ask through the same definition rather than through two copies of it.
- [ ] The preflight issues no fetch and no other network call.

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package.

The whole guard is testable against the `Git` fake in `test/support/git-fake.ts`: the ancestry cases
are fixtures, not host facts. The fake currently answers `dispatcherFreshness` with
`Effect.die("this fake Git answers no dispatcher-freshness questions")` — a placeholder from the
expand step, since nothing called it yet. Make it answerable the way `branchContains` is, through a
field on the fake's options rather than a second fake. `dispatch.test.ts`'s
`attempt` helper is the model for reaching the appended row — T43 added a `dispatcherRevision`
override to it for exactly this shape of assertion. Cover the offline criterion the way it will
actually regress: assert the rendered argv, so a `fetch` added later fails the test rather than
merely slowing the preflight down.
