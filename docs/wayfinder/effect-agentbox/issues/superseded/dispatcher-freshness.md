# Superseded — Dispatcher freshness: a dispatch runs a dispatcher no older than its base

Status: wontfix
Type: AFK
Blocked by: T40

> **Superseded 2026-09-08 — source material, not a live ticket.** This was T41, the last of P1's
> owed work. It was oversized — a `Git` operation, a ledger schema change, a preflight refusal, a
> CLI flag, and a `doctor` probe in one ticket — and **its dispatch failed**: the implement pass ran
> its full 900s and committed nothing, which is the interlocking-work failure the implement prompt
> itself warns about. Nothing here typechecks until most of it is in, so the gate never fires
> partway and a pass that runs out of budget loses everything.
>
> It is replaced by [T42](../T42-doctor-asks-whether-the-dispatcher-is-stale.md),
> [T43](../T43-every-row-records-the-dispatcher-that-ran-it.md), and
> [T44](../T44-a-dispatch-runs-a-dispatcher-no-older-than-its-base.md), each green on its own.
>
> **Read the design below; do not amend it and do not build from it directly.** The decomposition is
> what went wrong, not the analysis: the rule, the bash evidence, the ancestry-not-equality reading,
> the package-directory scope, the offline clause, and the instruct-don't-repair ruling are all
> still correct, and the three tickets carry them forward. The one thing they do *not* carry is the
> wiring paragraph below, which reads the whole change as one `Git` operation — that is superseded
> by T42's pure module, because `probes.ts` shells out directly and cannot take the tag.
>
> It lives here rather than beside the live tickets for `scoped-shell.md`'s reason: an issue's
> number comes from its filename, `load_issues` globs `*.md` non-recursively, and a live `T41-*.md`
> would collide. The title no longer starts with `T41` for the same reason.
>
> **Still true, and now owned by T44:** this must land before the first P2 dispatch. Across P2-P6
> the tool dispatches itself out of this repo (09 Q11), so which revision of the dispatcher runs is
> decided by whichever branch the dev has checked out — a fact about the checkout, not about the
> dispatch. Adopters are immune from P6 onward because 01's shim pins a SHA; the tool's own repo is
> not, for exactly the five bullets where every ticket stacks on the last.

## What to build

**A dispatch runs a dispatcher no older than the one on the base it targets, or it refuses.**

Refuse when `HEAD` is missing a commit under the package directory that the base ref already has.
The run would otherwise have different semantics than the base expects, and say nothing about it.

### Why a refusal and not a warning

Observed in bash on 2026-08-17, dispatching T31 with `--base speepobox-t28`. That base forks from
`cc0db0202a`, three days before `81c3bb31ed` landed the issue-state-lives-on-the-branch change, so
the run executed the *pre*-change dispatcher: issue state read from the host working tree, `Status:`
stamped host-side, no status commit on the branch. It also ran without the ahead-is-not-diverged
cleanup fix, which postdates the same fork point. Two mechanisms silently absent from one run, and
the console said nothing about either. The divergence was found days later by reading commit dates.

That is what separates this from the image-staleness warning beside it in `preflight.ts`. A stale
image still runs, and the advisory can be acted on afterwards. A stale dispatcher produces a
plausible success whose semantics nobody can recover after the fact. **Stacking is not the exotic
case** — it is the intended workflow, and it is precisely when the dev is sitting *on* the parent
branch whose tree is behind.

### Ancestry, not equality

Uncommitted local edits to the tool's own source are the normal state of a repo that is building
itself and must stay silent. What is refused is a `HEAD` missing commits the base already has.

The refusal only covers what the base can see; a dispatcher edited locally and never committed is
invisible to it. That is what the ledger field below is for.

### Scoped to the package directory

Bash scopes its check to `.agentbox/` because hae's repo is mostly not the dispatcher. Scope this one
to **the package directory**, for the same reason and against the same failure: this repo also holds
`docs/`, and a whole-repo ancestry check would refuse a dispatch because a doc commit landed on the
base.

Derive that path from `packageRoot` relative to `repoRoot` (`src/config/paths.ts`) rather than
introducing a config key. It is a fact about where the dispatcher's own source sits, the package
already knows it, and it stays correct on its own if
[18](../../18-where-the-package-lives-and-what-it-is-called.md) moves the package.

### Where it goes, and what it may touch

**`dispatch/preflight.ts`, not `guards.ts`.** It is a fact about host fitness, like the
authenticated-`gh` refusal already there, not a fact about the run.

**First in the preflight, before `dockerProbe`** — before any docker or network work, per 09. The
call site already has what it needs: `dispatch.ts` resolves `baseRef` above its `preflight(...)`
call, so the ref is in hand.

**It makes no network call.** Bash phrases this as *read the local base ref, never `origin/<base>`*.
That clause needs restating rather than copying, because this package's `--base` already names a
remote-tracking ref (`guards.ts`: "`--base` names a remote-tracking ref (`origin/master`)"). Reading
`origin/main` out of this clone is still an offline read of a local ref, which is what bash's rule
protects. The rule that ports is: **the preflight resolves the base as this clone already has it and
never fetches.** A stale local base is a `git fetch` away and is the operator's to run.

### The refusal, and the escape hatch

The refusal names the missing commit, the branch you are on, and the command that fixes it.

**It instructs; it does not repair.** 09 leaves this to P1 and notes that bash's reason does not
port — bash reads a script incrementally by byte offset, so a `git checkout` from inside a running
`run.sh` mutates the file underneath the interpreter, and Node has no such constraint. Decide it
anyway on this package's own grounds: mutating the operator's checkout is not this tool's act. It is
the ruling `guards.ts` already carries for the neighbouring case — "Creating branches is the
dispatcher's act, never ours" — and a preflight that silently moved `HEAD` would be a refusal that
held something, against matrix row 1.

`--allow-stale-dispatcher` proceeds anyway, with a warning, and says so on the ledger row.

### The ledger field

Every row records `dispatcher`: the short rev that ran the dispatch, marked when the package
directory was dirty. A forced dispatch also records the override. Bash has both; this package has
neither.

**Both stay on record version 1** (`src/ledger/record.ts`). T31's rule is on the file: a field every
reader can be absent does not bump the version, because the number is what tells the legacy adapter
apart from this schema, and bumping it would either drop every version-1 line already on disk or buy
a third literal nothing branches on. Spell them as **absent keys, not nullable ones** — the same
`Schema.optionalWith(..., { as: "Option", nullable: true, exact: true })` `rescuedOnto` uses, and for
the identical reason: the rows already written carry no such key at all, and `status` exists to show
them.

### `doctor`

`doctor` asks the same ancestry question against the configured base, before a dispatch is typed —
the whole point being that the check is reachable without spending a dispatch to see it. It becomes
probe ten; `bin.ts`'s usage string says "nine probes" and must move with it.

## Effect wiring

- **Tags introduced or consumed**: `Git` (consumed, one operation added), `Reporter` (consumed, for
  the override warning — `preflight` already takes it), `Ledger` (consumed, record shape changed).
- **Layer composition**: unchanged. `preflight`'s signature grows the base ref, and its error union
  grows one typed refusal alongside `DockerUnavailable | ImageUnavailable | GhUnavailable`; the
  requirement channel already carries `Reporter | CommandExecutor | FileSystem.FileSystem |
  Path.Path`, and `Git` resolves through the same `CommandExecutor`. No new layer, no new
  `Layer.provide`.
- **The `Git` operation**: `countCommits` is `rev-list --count <from>..<to>` with no pathspec, so it
  cannot name the commit the refusal has to print. Add one that lists commits in a range **under a
  path** and returns their SHAs, on the tag beside `branchContains` — which is already
  `merge-base --is-ancestor` and is the model for asking git its own question rather than composing
  one. Render it through `inRepo`, never bare `git`, so it is scoped like every other call
  (`src/git/git.ts`).

## Acceptance criteria

- [ ] A dispatch whose `HEAD` is missing a package commit that its base already has is refused, and
      the refusal happens before docker is contacted.
- [ ] The refusal names a missing commit, the branch the dispatcher is on, and the command that
      fixes it, and it changes nothing about the checkout.
- [ ] A `HEAD` ahead of its base is not refused, and uncommitted edits under the package directory
      never trigger the refusal on their own.
- [ ] A base carrying commits that touch nothing under the package directory does not refuse.
- [ ] `--allow-stale-dispatcher` proceeds with a warning, and the row it writes records that the
      check was overridden.
- [ ] Every row records the dispatcher revision that ran, and a dirty package directory is
      distinguishable on the row from a clean one.
- [ ] Rows already on disk — which carry neither key — still decode, still render on `status`, and
      the schema version is unchanged.
- [ ] `doctor` reports the same question against the configured base as its own row, and the usage
      string's probe count matches what `doctor` prints.
- [ ] The preflight issues no fetch and no other network call.

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package.

The whole guard is testable against a fake `CommandExecutor` and a temp repo: the four ancestry cases
above are fixtures, not host facts. Cover the offline criterion the way it will actually regress —
assert the rendered argv, so a `fetch` added later fails the test rather than merely slowing the
preflight down.
