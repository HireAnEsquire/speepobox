# T83 — The feature row and the issues step, read at the tip

Status: Done (PR #45. The `--dry-run` criterion's scope-door refusal was retired by T76, so the test pins mode `feature` instead. A pick through a real terminal is the hands-on check still owed, as for T82)
Type: AFK
Blocked by: [T82](T82-the-base-step-and-the-summarys-edit-rows.md) — the step slot and the edit rows this one fills.

<!--
P3 (09 Q5). The reorder 14 ruled for P3 and SPEC §2 states: **branch before issues**, because the
frontier is a function of the tip. bash's picker reads the host tree before any branch is known
(`pick_issues`, `tasklib.py:1612`) and can offer an issue the tip already says is Done — MAP's
*The bash picker still reads the host tree*, scoped 2026-08-20 as *let it die at P3*. This is P3.

The step is inserted between branch and base; T82's derivation graph already carries the slot.

The picker's product is `--feature <folder> --issues a,b|all`, and everything after `Dispatch` is
T73's: the same content guards, at the same tip. A **live** feature run through it still takes
T73's scope-door refusal until T76 lands — the real edge, and not a blocker on the picker, whose
acceptance runs as a rehearsal and on the fake tier.
-->

## What to build

**The source step offers every feature folder; after the branch, the picker reads that folder's
issues at the branch tip through `IssueStore`, offers them with the ready set preselected, and
emits `--feature <folder> --issues …`.**

### 1. The feature rows

Source gains one `[feature] <folder>` row per directory under the tasks dir that holds an
`issues/` subdirectory, newest first by its newest issue file (bash's `_feature_recency_key`), above
the spec rows. This is a **host** listing and a hint only: no branch is chosen yet, so the host is
the only source there is, and listing folders for a human to name is not computing a work set (15).
The tip is what validates — §2.

### 2. The issues step, after the branch

1. Resolve the tip once — `Git.revParse` of `refs/heads/<branch>`, as T73's guard does — and
   `IssueStore.issues({ repo, ref: tip, folder })`. `FolderAbsent` shows T73 §3's sentence as the
   step's message and returns to the **branch** step: the folder is not on that branch. `Unparseable`
   the same, naming the file.
2. A `select` first — bash's shape (`pick_issues`), which is what gives a multiselect a `← Back`:
   `All ready (n): <ids>` when `select(issues, All)` (T69) answers a set, `Choose…`, `← Back`.
   `All ready` emits `--issues all` — the **named predicate**, 15 — never the expanded ids.
3. `Choose…` opens a `multiselect` over every issue in `orderIssues`'s order, label `<id> — <title>`,
   hint the status, type, and unmet blockers; `Done` and `HITL` rows disabled; the ready set
   preselected; at least one required. The chosen ids, in that order, are `--issues a,b`.

No auto-skip on a one-issue folder (bash skips): the human names the set here, and one row is one
keypress. The step runs whenever the source is a feature; T82's graph gains the *issues* edge
(source and branch both re-run it).

### 3. The summary

The note gains an `issues` line — `all` or the ids — and the command line carries the two flags.
`Edit issues` appears when the source is a feature (T82 §2).

### 4. Docs

- SPEC §7's *no args on a TTY* row: the feature row and the issues step, read at the tip (T83).
- MAP.md, *Not yet specified*, the *bash picker still reads the host tree* entry: struck-through,
  **resolved by T83** — the port's picker asks branch first and reads the folder at its tip.
- SPEC §12's divergence list: the picker's **feature folder list is a host listing** (the hint;
  the set itself is read at the tip and every refusal is T73's), and **no one-issue auto-skip**.
- `docs/agents/issue-tracker.md`: one sentence beside the branch-before-issues ruling — it ships.

## Effect wiring

- **Tags introduced or consumed**: none introduced. `IssueStore.issues` and `Git.revParse`
  consumed by the picker; `select` and `orderIssues` as pure functions. `fakeIssueStore` scripts
  the tip's set as it does for T73.
- **Layer composition**: unchanged from T81.

## Acceptance criteria

- [ ] Script: `[feature] f`, branch `b`, `All ready`, Enter on base, `Dispatch` — the fake
      `IssueStore` was asked for `f` at the sha the fake `revParse` answered for `refs/heads/b`,
      and the words are `["--feature", "f", "--issues", "all", "--branch", "b"]`.
- [ ] Script: `Choose…` toggling to two ids — `--issues <id1>,<id2>` in `orderIssues`'s order; the
      recorded rows had every `Done` and `HITL` issue disabled and the ready set preselected.
- [ ] A folder the fake tip does not carry: T73 §3's sentence is shown and the branch step runs
      again; a set with nothing ready offers no `All ready` row.
- [ ] `Edit branch` from the summary re-runs issues (re-read at the new branch's tip) and base.
- [ ] `--dry-run` through the picker with a feature choice: the plan block prints with mode
      `feature` and then T73's scope-door refusal, exactly as the typed flags do today.
- [ ] Every T81 and T82 test passes unchanged.

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package.
