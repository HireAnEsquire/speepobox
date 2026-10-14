# T70 — The dispatch fetches origin before it resolves the base

Status: Done (PR #28; admitting the fetch meant restating the guard phase's own invariant from *read-only* to *holds nothing and owes no release*, which §4 did not name — and re-arguing in `checkout.ts` why its two fetches fail the looser bar anyway, so the rewording cannot later license a write in guards)
Type: AFK
Blocked by: none.

<!--
P2 (09 Q5), the prefactor 15 sized as new capability rather than a reordering: *the port has never
fetched origin, the `Git` tag has no operation for it, and `resolveBaseSha` currently refuses with
"fetch it first" — advice that stops being true once the tool does it. A `Git` operation, a §2
entry, and that message are all in scope.* Mode-independent, with its own green — every dispatch
that runs today runs the same afterwards, one fetch earlier — so it stands alone rather than riding
under the feature flags (T73), which are what need the slot this ticket opens.

bash fetches unconditionally (`run.sh:1268`, `git fetch origin --quiet`) before any base resolve.
-->

## What to build

**Every dispatch runs `git fetch origin` after the local guards and before anything reads a
remote-tracking ref, and the base is resolved once, authoritatively, from what that fetch brought
back.** 15's two-phase guard order, the mode-independent half: local guards → fetch → the
authoritative `BASE_SHA` → merge-base. The content-guard phase (T73) slots in after this, and this
ticket leaves a comment naming the slot.

### 1. The operation

`Git.fetch({ repo, remote: "origin" })` — a new operation on the tag (SPEC §2's `Git` row gains
it), through `inRepo` like every other, naming its repo (T27). It fetches remote-tracking refs and
nothing else: no `--prune`, no tags, no refspec into `refs/heads`. Its `GitError` carries git's
own words.

**The recording layer does not override it.** A rehearsal fetches for real — decision 3 of 09's
comment of 2026-09-21, settled by 15's own sentence: *a fetch mutates remote-tracking refs but
holds nothing and has no release*, and row 1 of the matrix is explicitly not dented. A rehearsal
that resolved the base against a stale remote would print a plan the run would not use. SPEC §7's
`--dry-run` row lists what a rehearsal never touches (lock, log, container, checkout, branch
creation, ledger); add the sentence that says the fetch is not on that list and why.

### 2. The placement

In `dispatch.ts`, the fetch runs after the last local guard (`forgeRepoFound`) and before
`preflight`, so the dispatcher-freshness check (T42) compares against a remote-tracking ref the
fetch just moved rather than whatever the last hand-run `git fetch` left. `resolveBaseSha` and
`resolveMergeBase` stay where they are — after the preflight — which is now post-fetch. Nothing
moves ahead of the branch guards: a typo'd `--branch` still costs no network round trip
(`run.sh`'s cheap-local-validation-first invariant, 15).

A fetch that fails — no network, no `origin`, a refused credential — is a `GuardRefused` quoting
git, not a `GitError`: nothing is held, and the dispatcher's next move is to fix the host. bash
dies here under `set -e`; parity.

### 3. The message

`resolveBaseSha`'s refusal drops *fetch it first* and says what is now true: `--base '<x>' does not
resolve to a commit after fetching origin — pass a ref that exists`. The comment at `guards.ts`
pointing the base resolve at "the checkout step" (15 named it) is retired.

### 4. Docs

- SPEC §7, the `--base` row, is self-contradictory in one cell (correction 3 of the pass): it says
  *never pushed to, never forked from* and then names *one authoritative `BASE_SHA` after the fetch
  that the run forks from*. Fix the cell: the checkout forks from the **branch tip** (SPEC §7's
  `--branch` row, 14 §"Why the gate is the branch tip"); `BASE_SHA` is the diff boundary's other
  end and the ref `--hard-reset` (P4) resets to, and is resolved once, after the fetch. Decision 5
  of 09's comment.
- SPEC §7's *The port does not fetch origin at all today* paragraph is rewritten to describe what
  ships: steps 1–3 land here, step 4 is T73's.
- SPEC §2's `Git` row names `fetch`.

## Effect wiring

- **Tags introduced or consumed**: none introduced. `Git` gains `fetch`; the fake in
  `test/support/git-fake.ts` records a `Fetch` call and can be scripted to fail.
- **Layer composition**: unchanged. `app.ts` is not touched; `dry-run/git.ts`'s `recordingGit`
  spreads the live shape and does not name `fetch`, which is the whole of decision 3 in code.

## Acceptance criteria

- [ ] Every dispatch in `test/dispatch.test.ts` records exactly one `Fetch` against `origin` in the
      served repo, after the last local guard's git call and before the preflight's freshness read
      and the base resolve; a refused `--branch` records none.
- [ ] A scripted fetch failure is a `GuardRefused` quoting git's line, before the lock, with no
      ledger row and no log.
- [ ] A `--base` that does not resolve refuses with the §3 message and the words *fetch it first*
      appear nowhere in `src/`.
- [ ] `recordingGit(live, reporter).fetch === live.fetch` — pinned, so a later ticket cannot record
      the fetch without a red test.
- [ ] `--dry-run` of a spec run records the fetch and prints the plan block it prints today.
- [ ] SPEC §7's `--base` cell reads as §4 says, with no sentence claiming the run forks from
      `BASE_SHA`.

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package.

```
git grep -n "fetch it first" src/ ; echo "exit $? (1 is the pass)"
```
