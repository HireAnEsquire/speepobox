# 14 — `Status: Done` conflates *approved* with *landed*

Labels: `wayfinder:grilling`
Map: [MAP.md](MAP.md)
Blocked by: — (**unblocked, on the frontier**)
Assignee: Scott Bowles (claimed 2026-08-14)
Status: closed (resolved 2026-08-14)

## Question

`Status: Done` answers two questions that disagree for the whole approval-to-merge window: "don't
re-run this" and "its code is on the base, so dependents may start." What replaces it — a richer
status vocabulary, a guard that checks the base itself, or a ruling that `Status:` is a view and the
ledger is the record?

---

Moved into the map on 2026-08-14 from a handoff written 2026-08-13. Everything below is the
pre-work: the finding, where it lives, what is *not* broken, and the proposal to attack. No code has
been written for it. **Branch:** `tseff` — nothing in this effort lands on `master`.

## The finding, in one paragraph

The bash `agentbox` dispatcher records issue state as a `Status:` line in the issue markdown file.
`Status: Done` is stamped by `run.sh` the moment the **reviewer approves** — minutes into a run,
before push, before the PR exists, hours before merge. But `Done` is also the *only* thing that
satisfies a dependent ticket's blocker check. So one boolean answers two different questions that
disagree for the entire approval-to-merge window: "don't re-run this" and "its code is on the base,
dependents may start."

Nothing downstream closes the gap: `--base` is a free argument, and no guard cross-checks that the
ref actually contains the blockers' commits.

## Where it lives (read these first)

| What | Where |
| --- | --- |
| The single predicate | `.agentbox/tasklib.py:192` — `is_done`, a regex on the `Status:` line |
| Gate 1 — default selection | `.agentbox/tasklib.py:292` and the fixed-point loop at `:299` |
| Gate 2 — blocker violation | `.agentbox/tasklib.py:318`, raising `DispatchError` at `:326` |
| The stamp, at approval | `.agentbox/run.sh:1487` (`set-status ... "Done"`) |
| Other stamps (not `Done`) | `run.sh:1400` blocked-HITL, `:1439`, `:1494`, `:1501` needs-work |

`tasklib.py:1616` and `:2041` also read `is_done`, but only to pick a picker label ("All" vs "All
unfinished") — cosmetic, not a gate. Ignore them.

All `set-status` calls sit inside `if [ "$FEATURE_MODE" -eq 1 ] && [ "$FEEDBACK_ONLY" -eq 0 ]`.
**Spec mode never stamps at all** and pins a file inode rather than mounting a directory, so it is
immune to this whole class of problem.

## What is *not* broken

The **default multi-issue path** is coherent. With no `--issues`, `select_issues` picks a whole
chain — every AFK not-Done issue reachable through Done-or-also-selected blockers — and runs it
sequentially in one container on one branch, so commits accumulate and issue 13 sees issue 12's
work. The base genuinely does not need to contain them.

The hazard is specific to the mode currently in use: **one ticket per branch, `--issues NN`, merged
between dispatches.** There `Done` is a claim about the base that nothing verifies.

## Evidence

**It has not fired.** Every dispatch so far was hand-gated by merging the blocker first (T9 before
T22, T8 before T25, T10 before T11 and T24). The protection is discipline, not design.

**The near-miss, now historical.** When the handoff was written, T28 was `Blocked by: T25` with T25
approved but unmerged. A bare `--feature docs/wayfinder/effect-agentbox` with no `--issues` would
have selected T28 and run it against `--base tseff`, which contained none of T25's code — the agent
would have opened `wreckage.ts`, found no `Kept` verdict, and implemented a ticket whose entire
premise is that `Kept` exists. T25 has since merged, so that specific window is closed; the class is
not. T28 now carries `Blocked by: T25, T29` and T31 carries `Blocked by: T13, T28, T29`, so every
future dispatch of either reopens the same question.

**The stamps you can look at right now.** As of 2026-08-14 the working tree on `tseff` carries two
uncommitted edits — `T13-notifier.md` and `T26-stranded-eviction-witness.md` both flipped to
`Status: Done` by their own runs. Neither branch is merged. Neither has been reviewed. That is the
defect in its plainest form: two files on disk asserting a state the base does not have.

### The unrelated failure that accidentally saved the near-miss

T25's run reported `APPROVED (issue 25, round 1)` then `!! FAILED (exit 1) during step 5/6`. Cause:
`FileNotFoundError` on the issue file — the host working tree was on branch `speepobox-t11`, whose
merge-base predates the commit that added T25/T26, and `run.sh` stamps status in the **host working
tree**. `set -euo pipefail` made it fatal, so the push, the PR, the `Done` stamp, and the ledger row
were all lost. The work survived as 3 commits on `speepobox-t25`.

This is a **second, separable defect** — the stamp is fatal when it should be advisory — and it is
worth grilling alongside the first, but do not conflate them.

## The fix to attack

Not a new status vocabulary. **Validate the thing that matters instead of a proxy for it.**

The ledger (`.bessemer/runs.jsonl`, SPEC §11) already records `branch` and `issues` per run, so a
blocker's branch is knowable. Before any container starts, refuse if a blocker's branch is not an
ancestor of `--base`:

```
git merge-base --is-ancestor <blocker-branch> <base>
```

A preflight guard in the existing matrix row 1 shape — holds nothing, acquires nothing, refuses at
the door. It asks whether the code is *there* rather than whether a line of markdown was stamped,
which makes the approved-vs-merged distinction stop mattering: an approved-unmerged blocker fails
the ancestor check automatically.

It is also the project's own established ruling applied to a new fact. From
`src/dispatch/checkout.ts:10-12`:

> There is no keep flag here and there must never be one: a flag is a second answer to "did this
> run's work survive" that can disagree with the fetch that actually knows.

`Status: Done` is exactly that flag, for "did this land."

**Cheaper second-order option:** stop stamping `Done` at approval; stamp `approved`. Then `is_done`
becomes honest, `select` still skips the issue (it is no longer `ready-for-agent`), and the blocker
gate starts telling the truth without any new machinery.

### Angles worth grilling

- Is the ledger the right source for "which branch belongs to this issue", or does that pull
  dispatch-time state into a guard that should be pure?
- What happens on a squash-merge, where the blocker's branch tip is *not* an ancestor of the base
  even though the code landed? Does `--is-ancestor` need to be `git cherry` or a merge-tree check
  instead? **This may sink the whole proposal.**
- Should this be fixed in bash at all, or only ruled and deferred to the port's P2 `IssueStore`?
  bessemer today has no `IssueStore` — its dispatches are one-off spec mode, no status, no blocker
  gate — so it is currently immune and inherits this the moment P2 lands.
- Is `Status:` the right home for any of this, or should the ruling be "the ledger is the record and
  `Status:` is a view"? That ruling was offered earlier and never written down. Candidate home:
  `docs/agents/issue-tracker.md`.
- The separable defect: should `stamp_status` be a non-fatal helper in `run.sh` so a failed stamp
  warns instead of killing a run that already succeeded?

## Deliverable

An ADR or a ruling in `docs/agents/issue-tracker.md`, plus whichever of these the grilling concludes
is warranted: a bash-side issue under `.agentbox/tasks/`, and/or a note on P2 in
`.agentbox/ROADMAP.md`.

## Suggested skills

- **`/grill-with-docs`** — the main one. Stateful, has a codebase, leaves a paper trail. This is a
  design question with a real codebase behind it, so it beats `/grill-me`.
- **`/domain-modeling`** — reach for it directly. "Done" is a textbook overloaded term doing two
  jobs; this skill is the single source of truth for resolving exactly that.
- **`/to-tickets`** — only *after* the grilling settles, and only if the outcome is buildable work.
  The effort's tickets live in `issues/` using `issues/TEMPLATE.md`, with `T1-skeleton.md` as the
  worked example.

Do not reach for `/wayfinder` — the map already exists and this is one decision inside it, not a new
fog.

## Standing constraints — carry these

- **The user makes all their own git commits.** Prepare changes, show the diff, never run
  `git commit`.
- bessemer never lands on `master`. `tseff` is the integration branch.
- `.agentbox/.env` holds `CLAUDE_CODE_OAUTH_TOKEN` and **must never be read into context**. Only
  `grep ^ANTHROPIC_MODEL .agentbox/.env` is safe. When inspecting any `.env`, read key names only
  (`cut -d= -f1`), never values.
- `gh` and `git fetch` do not work inside the assistant's sandbox, so the user runs them — all `gh`
  commands, and the assistant sees no merge until the user pulls.
- The Docker socket is blocked in the assistant's sandbox — the user runs `verify:live` and any
  dispatch. Never dispatch from a git worktree: `.bessemer/locks/` is relative to the tree, so a
  second tree keeps a second lock namespace.
- Dispatch commands go plain: no `nohup` / `setsid` / `</dev/null` wrapper.
- Prefer simple bash under the sandbox; split compound one-liners.

---

## Resolution (2026-08-14)

**None of the three answers this ticket proposed survived.** Not a richer status vocabulary — the
vocabulary gets *smaller*. Not the `--is-ancestor` guard — never needed. Not "the ledger is the
record" — the ledger stays derived state, correctly.

### The ruling

**Issue state is split by scope, and no store answers a question it cannot know.**

| Question | Answered by | Cost if lost |
| --- | --- | --- |
| landed — may dependents start | the issue file **at the branch tip**, in git | — (it is git) |
| approved, awaiting merge | any other ref's copy says `Done` and that ref is unmerged into tip | — (it is git) |
| running | live PID claim (`claim.ts` + `liveness.ts` + T8 reconciler) | already reliable |
| needs-work | the ledger row | **harmless** — re-running a failed issue is correct |

`Status: Done` acquires exactly **one** meaning: landed. It is written by the **dispatcher**, on
**approval only**, as a commit on the run branch, so it arrives on the base in the same merge as the
code it describes. The two can never disagree, because git couples them.

### Why the gate is the branch tip, not `--base`

The checkout forks from the **branch tip** (`run.sh:147`); `--base` is "never pushed to, never
forked from." So the tip is the ref whose content the agent actually sees, and gating on anything
else gates on a ref the run never touches.

Consequence: **stacked dispatch becomes legal.** Fork `speepobox-t28` from `speepobox-t25` and the
tip carries T25's code *and* its `Done`, so the gate passes on the strength of the very file the
agent will read. This is the thing that has been holding the queue.

### Two objections that dissolved rather than being answered

- **Squash-merge** (flagged in this ticket as possibly sinking the proposal). It sank the *guard*,
  not the ruling. Nobody asks "is branch X an ancestor of base" any more — the question is "does the
  tip's copy of the file say `Done`", and a squash carries the edit like any other hunk.
- **The separable defect** (`stamp_status` fatal when it should be advisory). Unreachable rather
  than fixed. For a tracked set nothing writes the host working tree, so there is no
  `FileNotFoundError` to be fatal about. Untracked queues *do* keep the host write — but they are
  gitignored, so their files are present whatever is checked out, and the crash cannot reach them
  either. T25's class is gone by construction, not by making a failure non-fatal.

  The advisory question came back anyway, one layer down. The **status commit** is built at land,
  after the agent's work has been fetched back and before the push, so a failure there would take
  the push, the PR and the ledger row — the same loss T25 suffered, from a different line. That one
  is fatal-when-it-should-be-advisory for real, and is built that way: every step returns and the
  caller degrades to a warning.

### Correctness never depends on machine-local state

The test that drove the design: *what breaks if each store is lost?* Losing git's copy means wrong
work — so it must be git. Losing any host-local record only ever costs **waste**, never correctness,
because a dependent's gate reads the tip's file. Lose the "approved on branch X" record and you
re-dispatch finished work; you never start a dependent against a tip missing its blocker's code.

That is why the ledger's derived-state ruling (`ledger.ts:5-8`, SPEC §10, `run.sh:198`) survives
untouched. Nothing needed promoting out of derived state. Only **one** state — needs-work — depends
on disposable storage, and losing it produces correct behavior anyway.

Corollary: the **ledger's existing shape is right and a per-issue store would be wrong.** An issue
can be approved on branch X and later needs-work on branch Y (feedback re-run); a store keyed by
issue alone overwrites and forgets X. `runs.jsonl` is keyed per-run carrying `branch` +
`issues: {N: verdict}` — exactly right.

### Approved-awaiting-merge is derived, with no naming convention

`git for-each-ref` + one `git cat-file --batch`. **Measured** in this repo: 339 refs (99 local, 240
remote) × 8 not-Done issues = 2712 blob reads in **0.62s wall**, including shell overhead. No
`speepobox-*` prefix or any other branch-name pattern is needed — an earlier draft of this
resolution claimed a tradeoff there and it does not exist.

It self-corrects where a stored pointer would lie: after `--hard-reset` discards a branch's commits,
a stored "approved on X" still says *just merge it* when there is nothing to merge; the scan re-reads
X, sees not-Done, and correctly drops to available. Ledger may be used as a **hint** to order or skip
the scan — never as truth.

Caveat, and it is a label not a gate: `refs/remotes` is only as current as the last fetch, so a
stale remote can show a merged branch as awaiting-merge. Harmless — the gate is the tip's own file.

### The write cannot happen inside the clone

`run.sh:1669` forbids host-side write-side git in the clone after the agent has touched it: the
agent owns its `.git/hooks` and `.git/config`, and a host-side git there would execute them with the
dev's credentials. So the status commit is built **in the main repo**, after land's fetch-back
(`run.sh:1676`) and before the push, with `commit-tree` — no checkout, no working tree, no hooks.
Shorter *and* safer than the clone route.

### Reverses ticket 04, deliberately

04 ruled `Status:` written host-side "so the agent cannot commit churn." Still satisfied: the
**dispatcher** writes it mechanically, never the agent. An agent-written status (option B) was
rejected — an agent that forgets produces an issue that silently never lands as `Done`, invisible
until a dependent won't select.

Accepted cost, weighed and taken: every PR now carries a bookkeeping commit touching `issues/`,
inside the reviewed diff. No downside found and no real alternative.

### Deliverables

- Ruling: **[`docs/agents/issue-tracker.md`](../../agents/issue-tracker.md)** § "Issue state lives
  on the branch".
- Port: **SPEC §2**, on the `IssueStore` row (`setStatus` becomes `markLanded`) — bessemer is
  immune today (`grep -rn "Status:|IssueStore|issues/" src/` → 0 hits; `src/status/` is
  the `status` dashboard over the ledger, not issue status) and inherits this at **P2**.
- bash: **[`.agentbox/tasks/agentbox-hardening/issues/03-issue-state-lives-on-the-branch.md`](../../../.agentbox/tasks/agentbox-hardening/issues/03-issue-state-lives-on-the-branch.md)**
  — **one** ticket, `Type: HITL`. Units 1 and 2 are two halves of one invariant; splitting them
  yields an incoherent intermediate where nothing ever reads `Done`. Estimated as a net deletion —
  five stamp call sites dying against ~8 lines of plumbing — and it came out the other way: the
  five sites survive unchanged, writing into the materialized copy instead of the host tree, and
  the plumbing is an order of magnitude larger than guessed. The estimate was wrong about the
  *shape* of the fix, not its size: pointing the existing writes at a different directory turned
  out to be cheaper than deleting them and rebuilding the same behaviour at land. HITL because it
  edits the dispatch core (the untested half, no oracle) and a bug there stalls the eight remaining
  bessemer tickets — which is what it did: the first implementation shipped a status commit that
  aborted the land step on macOS, caught by review before any dispatch.

Scope taken was **(b)** — ruling plus minimal bash — over ruling-only, because bash is not a retiring
tool here: it is the live harness dispatching T14, T15, T16, T17, T23, T28, T30 and T31.

### Two consequences recorded, not re-grilled

1. **`RunLock` is keyed by branch slug** (`run-lock.ts:5`), but "is issue N running" is per-issue and
   one run can hold many issues on the default chain path. The live claim needs to carry its issue
   set. T4/T20-adjacent.
2. **The picker reorders to branch-before-issues.** The frontier is a function of the branch tip, and
   `--branch` must already exist ("creating branches is your act"), so the branch list is knowable
   with no issue chosen — which breaks the circularity that base-first would have created (base
   defaults from the ledger *per branch*, `run.sh:919-929`). Offer "new branch off base" as the first
   row for the common case, existing branches below for stacking. P3.

### Migration: none owed

The two uncommitted host-side `Done` edits this ticket cites as "the defect in its plainest form"
were settled before the resolution was written — and settled in exactly the shape the ruling
prescribes. Both became dedicated status commits **on their own branches**
(`042946c21c docs(T13): update status from ready-for-agent to Done`, `1dde465710 docs(T26): …`) and
reached `tseff` by merge (`ff8edf90a1`, `cc0db0202a`). `git show tseff:` reads `Status: Done` for
both, and the working tree matches.

That is worth recording as evidence, not just bookkeeping: **the correct handling was reached by
hand, under pressure, without the ruling existing.** The ruling makes the dispatcher do what the dev
already did when forced to think about it.

---

## What building it in bash taught (appended 2026-08-19)

This ruling was graded on 2026-08-14 and implemented in bash three days later. The implementation
ticket lives under `.agentbox/tasks/`, which the extraction manifest cuts — the *mechanics* travel
inside the carried `run.sh`, the *reasoning* does not. What follows is the part P2 has to decide
again, recorded here because this is the ruling it amends.

Nine of these are decisions rather than bash mechanics. The trap discipline, the `set -e`
suppression, the bsdtar-takes-SIGPIPE-on-`git archive` failure, and the `commit-tree` block itself
are bash's problems and are deliberately not carried.

1. **Ask git whether the set is tracked; never inspect the path shape.** A tracked set reads from the
   ref, an untracked per-dev queue keeps working host-side, byte-unchanged. The tempting test — "does
   the `--feature` argument contain a slash" — is the same category error the ruling exists to remove.
2. **The silent fallback warns, unless the path is ignored.** A set absent from the ref *and* not
   gitignored means the tip predates it, so `Status:` is coming from whatever is checked out and the
   dispatcher should say so. An ignored path is a per-dev queue and stays silent.
3. **Mid-run progress stays visible.** The stamp writes go to the materialized copy rather than the
   host tree, so the host is untouched *and* the mounted issue directory still reflects progress
   during the run. This was estimated as a net deletion of five write sites and came out the other
   way: pointing existing writes at a different directory was cheaper than deleting them and
   rebuilding the same behaviour at land. Only the **approved** files are committed.
4. **The status write is advisory, never fatal.** This is the hardest-won one. The first version
   aborted the run on a path bug — after the fetch-back, before the push — costing the push, the PR
   *and* the ledger row on a run whose agent work was already done. A step that runs while unpushed
   commits are in hand may not be able to fail the run.
5. **A run that produced no agent commits gets no status commit**, so it cannot push a branch whose
   only new content is bookkeeping. Count *this run's* commits, not the branch total — the first
   implementation used the total, which let a resumed run that approved without the agent committing
   anything push anyway.
6. **One commit per run**, carrying every issue approved *this* run. A run that stops mid-sequence
   commits only what was approved, which is correct rather than partial.
7. **Ordering is load-bearing**: resolve the base chain first (selection now reads a ref, and
   `--hard-reset` makes the base *be* that ref), then validate `--branch`, then materialize, then
   select. Branch validation ahead of materialization or a typo'd branch materializes and selects
   before being refused. `--hard-reset` and a not-yet-created branch both fall back to the base as the
   effective tip.
8. **Derive the repo-relative path from the source directory; never strip a prefix.** The bug that
   caused (4) was `Path.resolve()` canonicalising symlinks so the approved paths carried macOS's
   `/private/var/…` while the scratch directory was the `/var/…` form. Node's `realpath` has the
   identical shape. Linux was unaffected, which is why reading the diff did not find it.
9. **The ledger's feature field, the resume target, and anything a human reads keep the repo-relative
   source directory** — never the scratch path.
10. **Commit subject `docs(issues): mark <stems> Done`** — `docs` because the change is markdown,
    matching the hand-written status commits already on these branches; file stems rather than bare
    numbers because the stem is what a reader recognises in a commit list.

One thing bash left undone, on purpose. Its picker runs *before* materialization, so it reads the
host tree — and the consequence is not cosmetic: it can offer an issue the tip already says is
`Done`, after which the dispatch reports "no issues to run". The proper fix is the picker asking
**branch before issues**, which is what this ticket already ruled for P3. Bash was not reordered for
a picker scheduled to die.

---

## State of the wider effort (context only — do not act on it here)

As of 2026-08-14: merged through T29, including T24, T25, T27. Awaiting review and merge: **T13**
(notifier) and **T26** (stranded eviction witness), both finished, both on local branches. Nothing
is dispatched — the user is holding the queue until those two merge, partly because this decision is
in the way. Unblocked and waiting: T28, T30, T23, T16.

ADR 0007's tripwire — more than half of the first ~8 dispatched issues needing 2+ Effect-error
redispatches — stands at **0**.
