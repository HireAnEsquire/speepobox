# T72 — Landed elsewhere is asked of every ref

Status: Done (PR #32; the fourth acceptance line's budget is defended by whatever clone runs it — 10 refs on the dispatching host against 14's 339, and 73ms against a 2s budget — so the fake case asserting two calls over fifty refs is what actually holds the design, and the live one is a smoke test; the tip is excluded by sha, so an annotated tag standing on it is read redundantly rather than excluded, which stays harmless only because T69 refuses an already-`Done` tip copy first)
Type: AFK
Blocked by: [T71](T71-issuestore-reads-an-issue-set-out-of-a-ref.md) — the tag and the batched
blob read.

<!--
P2 (09 Q5). 14's "approved, awaiting merge" is derived, not stored: *some other ref's copy says
`Done` and that ref is unmerged into tip, answered by `for-each-ref` + one batched `cat-file`
(measured 0.62s over 339 refs × 8 issues, no branch-naming convention)*. 15 made it one of the two
witnesses for "someone else already has this issue" — the git one, a **hard refusal**. This ticket
is the scan; T74 is the refusal.
-->

## What to build

**`IssueStore.landedElsewhere({ repo, folder, ids, tip })` answers, for each id, every ref other
than `tip` whose copy of the issue file says `Done`.** One `for-each-ref`, one `cat-file --batch`
over `<sha>:<folder>/issues/<file>` for every ref × id, T68's parse on each blob that exists.

### 1. The question

*Landed elsewhere* means: the tip's copy is not `Done` (or T69's `AlreadyDone` would already have
refused) and some other ref's copy is. No ancestry check — 14: *`merge-base --is-ancestor` is the
wrong question and breaks under squash-merge*. If the other ref were merged into tip, tip's copy
would say `Done`; that it does not is the whole finding. A ref standing behind tip whose copy says
`Done` while tip's does not is a real answer too: the branch was cut before the landing reached
its base, and the dispatcher wants to know.

Only `tip` itself is excluded. `refs/remotes/origin/<branch>` is not: post-fetch (T70) it is
current, and a remote copy that says `Done` while the local branch's does not is a local branch
behind its own remote.

### 2. The answer

`ReadonlyArray<{ id, refs: ReadonlyArray<string> }>`, one entry per id that has at least one
such ref, refs as `for-each-ref` names them (`refs/heads/x`, `refs/remotes/origin/x`). Empty
means nobody else has landed any of them. A ref whose tree lacks the file, or whose blob does not
parse, contributes nothing — the scan is a witness, and a witness that cannot read a copy has
nothing to say about it.

### 3. Scale

`Git` gains `forEachRef({ repo })` → `(sha, refname)` pairs. The blob read is T71's `readBlobs`
extended (or a sibling) to take `<sha>:<path>` object names and to tolerate missing ones —
`cat-file --batch` answers `missing` per line, which is the tolerant read this scan needs. The
number of git processes is **two**, whatever the ref count.

## Effect wiring

- **Tags introduced or consumed**: `IssueStore` gains one method; `Git` gains `forEachRef`. The
  recording layer keeps the read real (it is a read).
- **Layer composition**: unchanged from T71.

## Acceptance criteria

- [ ] Against a real temporary repository: branch A's copy says `Done`, tip's says
      `ready-for-agent` → the id answers `[refs/heads/A]`; a remote-tracking ref copy saying `Done`
      answers too; a ref whose tree lacks the folder contributes nothing; the tip's own ref is never
      in an answer.
- [ ] A ref where the file is `Done` and that ref **is** the tip's ancestor still answers — no
      ancestry read is made (the fake `Git` records none).
- [ ] Against the fake `Git`: one `forEachRef`, one batched blob read, for any number of refs.
- [ ] Running the scan over this repository's own refs and this folder completes in under two
      seconds on the host (host-only, noted in the PR — the gate cannot time a real repo).

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package.
