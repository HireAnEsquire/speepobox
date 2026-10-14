# T74 — Two witnesses for "someone else has this issue"

Status: Done (PR #34; the in-progress witness is one whole-file `runs.jsonl` read per selected issue, so a wide dispatch re-reads it N times and re-emits `readAll`'s per-undecodable-line `Warned` N times — accepted, since batching would be a second query shape this ticket does not ask for, but `guards.ts`'s *one warning for the read, not one per issue* describes only the `LedgerError` waiver it sits on and not that; and §1's `landedElsewhere({ repo, folder, ids, tip })` is stale prose — the shipped scan takes `issues`, because it needs each file's name)
Type: AFK
Blocked by: [T72](T72-landed-elsewhere-is-asked-of-every-ref.md) (the scan), [T73](T73-a-feature-dispatch-names-its-issues.md)
(the selection they guard).

<!--
P2 (09 Q5), unit 2 as 15 split it. The 2026-08-18 incident: five issues selected on one branch,
two of them already on their own branches with open PRs, a third branch editing both. 15: *`all`
consents to wideness, not to contents*, so contents protection is two checks with two witnesses,
**neither asked something it cannot know** — git for landed, the ledger (as a hint) for
in-progress. Both fire under `all` and only under `all`; enumerating is the override for both.
-->

## What to build

**Under `--issues all`, a selected issue that some other ref already says is `Done` is a hard
refusal, and one whose newest ledger row names a different branch is a refusal that a missing or
unreadable ledger silently waives. Under an enumerated `--issues`, neither is asked.**

### 1. Landed elsewhere — git, hard

After T73's selection, `IssueStore.landedElsewhere({ repo, folder, ids: selected, tip })`. Any
answer refuses: *T25 is `Done` on refs/heads/bessemer-t25 and refs/remotes/origin/bessemer-t25 but
not on 'b' — merge or rebase before dispatching it here, or enumerate `--issues` to override*.
All hits in one message. It is truth: host-independent, self-correcting after a `--hard-reset`
discards a branch (14).

### 2. In-progress elsewhere — the ledger, a hint

`Ledger` gains `newestBranchForIssue({ feature, issue })` → `Option<{ branch, endedAt, outcome }>`,
a sibling of `lastBaseForBranch`: the newest row whose dispatch identity (`dispatchIdentity`, so a
`FeedbackResume` answers through what it wrapped) is a `Feature` for that folder and whose
`issues` name the id. A `Some` naming a branch other than this one refuses: *T28 was last worked on
'bessemer-t28' (needs-work, 2026-08-18) — dispatch it there with `--resume`, or enumerate
`--issues` to override*.

The ledger is derived state (SPEC §10): a `LedgerError` here is a `Warned` event and the check
passes — 09 unit 2's rule, the one `lastBaseForBranch` already follows. It answers only whether a
run is *wasted*, never correctness (15), which is why an over-refusal on one host and silence on
another is asymmetric in the safe direction.

### 3. Ordering and override

Both run inside T73's content-guard phase, after `select`, landed-elsewhere first. Both are
skipped outright when the request is `Enumerated` — not run-and-ignored: the scan is two git
processes over every ref, and a check whose answer is discarded is a check a reader will one day
believe was made.

## Effect wiring

- **Tags introduced or consumed**: none introduced. `Ledger` gains one read; `IssueStore`'s scan
  from T72 is consumed in `dispatch.ts`.
- **Layer composition**: unchanged from T71.

## Acceptance criteria

- [ ] `--issues all` with the fake scan answering one hit refuses naming the issue and every ref;
      with two hits, one message names both.
- [ ] `--issues all` with a ledger fixture whose newest `Feature` row for the folder names another
      branch for a selected id refuses with §2's sentence; a row for the same branch passes; a
      `FeedbackResume` wrapping a `Feature` row answers through the wrapped identity; a row for a
      different folder with the same id is not a hit.
- [ ] An unreadable ledger under `all` emits `Warned` and the dispatch proceeds; the fake scan is
      still consulted.
- [ ] `--issues T25,T28` with the same fixtures records **no** scan call and no ledger query.
- [ ] Every existing ledger fixture line still decodes (`newestBranchForIssue` reads the record as
      it is; no schema change).

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package.
