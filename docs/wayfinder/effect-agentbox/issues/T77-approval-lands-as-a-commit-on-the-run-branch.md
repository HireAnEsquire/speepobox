# T77 — Approval lands as a commit on the run branch

Status: Done (PR #39; split mid-flight — the first dispatch hit the 30-minute implement cap with the plumbing and `markLanded` committed, and a resume wired the land. The write is pinned to one resolved SHA and moves the ref with `update-ref`'s old-value check, and its scratch index lives under `locks/` and is removed either way. Two things stand as written: an agent that already wrote `Done` itself gets a status commit whose tree equals its parent's, and no live feature run has exercised the path yet — the first one is its live check)
Type: AFK
Blocked by: [T68](T68-issue-files-parse-order-and-restamp.md) (the restamp), [T76](T76-the-feature-loop.md)
(the approved set at land).

<!--
P2 (09 Q5): `markLanded`, 14's ruling and the reason the tag is not `setStatus`. *`Status: Done`
acquires exactly one meaning: landed. It is written by the dispatcher, on approval only, as a
commit on the run branch, so it arrives on the base in the same merge as the code it describes.*
bash built it three days after the ruling (`run.sh:1341-1375`, `commit_issue_status`), and 14's
appendix records the ten decisions that survived doing so; this ticket carries the ones that are
decisions rather than bash mechanics.
-->

## What to build

**After land's fetch-back and before its push, every issue this run approved gets its `Status:`
rewritten to `Done` in one commit on the run branch, built in the served repo with plumbing —
no working tree, no hooks, never inside the clone — and a failure there warns and the push still
happens.**

### 1. The write

`IssueStore.markLanded({ repo, branch, folder, stems })` → `Effect<Option<sha>, IssueStoreError>`:
read each `<folder>/issues/<stem>.md` blob at `refs/heads/<branch>` (T71's reads), rewrite its
status with T68's `withStatus(text, "Done")`, write the new blobs, build a tree from the branch's
tree with those entries replaced, `commit-tree` it with the branch as parent, and `update-ref`
the branch to it. bash's sequence (`run.sh:1355-1375`): `read-tree` into a scratch index,
`hash-object -w`, `update-index --cacheinfo`, `write-tree`, `commit-tree`, `update-ref`. The
scratch index needs `GIT_INDEX_FILE`, which is a per-call environment variable against the
chokepoint's `extendEnv: false` allowlist — allowed on the allowlist's own terms, **one variable
with a note naming the child that reads it** (AGENTS.md), and the value is a path under the runtime
root, never anything inherited.

Subject `docs(issues): mark <stems> Done`, stems space-separated (14, lesson 10 — the stem is what
a reader recognises in a commit list); body as `run.sh:1373-1374` writes it, saying what `Done`
means. Paths are built from the repo-relative folder and the stem (lesson 8: never stripped off a
scratch path).

### 2. The placement and the contract

In `land.ts`, between `fetchBack` and `push`, when the `Feature` run's outcomes `Ref` (T76) holds
at least one `approved` **and** `thisRun > 0` — commits after `plan.tipSha` (T73), which land
already counts: a run that produced no agent commits gets no status commit, so it cannot push a
branch whose only new content is bookkeeping (lesson 5, counted against *this run's* tip and not
the branch total — the mistake bash's first version made on a resume).

**Advisory, never fatal** (lesson 4): a `markLanded` failure is a `Warned` event naming the stems
and git's words, and land goes on to push and open the PR. A step that runs while unpushed commits
are in hand may not fail the run.

One commit per run, carrying every issue approved this run (lesson 6); a run that stopped
mid-sequence commits exactly what approved.

**This write is the whole of 14's one-author guarantee, and nothing in the container enforces the
rest of it** (found reviewing T75). `/feature-issues` is mounted read-only, but its source is
inside the checkout, so the same files are writable at `/workspace/<folder>/issues` and an agent
that rewrites a `Status:` line there commits it with its own work. The read-only mount rules out
a second *path* to the file, never a second author. So the property *`Status: Done` is written by
the dispatcher, on approval only* is carried here plus the prompts, and a ticket that wants it
enforced rather than asserted is a fresh one — the enforcement point would be land, checking that
no `<folder>/issues/` blob changed under the agent's commits.

### 3. The rehearsal

`IssueStoreRecordingLive` (T71) records `markLanded` — *mark T70 T71 Done on 'b'* — and writes
nothing. It keeps `issues` and `landedElsewhere` real, over the live layer.

**The layer T71 left is `{ ...live }` over a store that carries its own `GitLive`**, so the `Git`
swap in `appDryRunLiveFor` does not reach inside it: a `markLanded` this layer forgets to override
writes objects and moves a ref in a rehearsal. Pin the override the way T70 pinned its deliberate
pass-through (`recordingGit(live, reporter).fetch === live.fetch`), so a later ticket cannot lose it
without a red test.

### 4. Docs

- `AGENTS.md`, under *The checkout and the land*: **the status commit is built in the served repo
  with plumbing, and its failure is a warning** `(T77)`, naming the two shapes that typecheck —
  running git in the clone after the agent touched it, and letting the failure propagate past the
  push.
- SPEC §2's `IssueStore` row: `markLanded` as built.

## Effect wiring

- **Tags introduced or consumed**: none introduced. `IssueStore` gains `markLanded`; `Git` gains
  whatever plumbing the tag needs (`hashObject`, `writeTree`/`updateIndex` under a scratch index,
  `commitTree`, `updateRef`), each through `inRepo`, each recorded by the fake.
- **Layer composition**: unchanged from T71.

## Acceptance criteria

- [ ] Against a real temporary repository: two approved stems → one new commit on the branch whose
      parent is the fetched-back tip, whose tree differs from the parent's in exactly those two
      blobs, each parsing (T68) to `Done`; the subject is `docs(issues): mark <a> <b> Done`; the
      working tree and index of the repository are untouched; no hook fired (a `pre-commit` hook
      that writes a marker file is installed and the marker does not appear).
- [ ] A feature run with one approved issue and agent commits: `markLanded` is called once, before
      `push`, after `fetchBack`; with no agent commits: not called, and nothing is pushed.
- [ ] A scripted `markLanded` failure: `Warned` naming the stems, `push` still recorded, PR still
      opened, row still written.
- [ ] A spec or inline run never calls it.
- [ ] `--dry-run` of a feature run records `mark … Done` and the repository has no new commit.
- [ ] `recordingIssueStore(live).markLanded !== live.markLanded` — pinned, so the write cannot fall
      through to the live layer's own `GitLive`.
- [ ] The allowlist in `internal/exec.ts` names `GIT_INDEX_FILE` with its note, and nothing else
      new.

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package.
