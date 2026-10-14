# T103 — `--hard-reset` on a feature dispatch reads the set at the base

Status: Done (PR #63)
Type: AFK
Blocked by: [T101](T101-hard-reset-resets-to-the-base-and-force-pushes.md) — the reset, the effective tip, and the `--feature` refusal this deletes.

<!--
P4 (09 Q5). Decision 14, lesson 7: "resolve the base chain first (selection now reads a ref, and
`--hard-reset` makes the base *be* that ref) … `--hard-reset` and a not-yet-created branch both
fall back to the base as the effective tip." bash does the same at `run.sh:1008-1021`
(`ISSUE_STATE_REF="$BASE"` under `HARD_RESET`). Decision 15 relies on it: the landed-elsewhere
witness is "self-correcting after a `--hard-reset` discards a branch".

T101 already makes the base the effective tip for every arm, and refuses `--feature` with the
flag so the arm could land untested. This ticket lifts that refusal and owns the feature-arm
behaviour.

**D12, surfaced while slicing and confirmed by the user on 2026-09-24.**
`IssueStore.landedElsewhere` excludes **only refs standing at the tip** (`issue-store.ts`, "Only
the tip itself is excluded"). Under a reset the tip is the base, so `refs/heads/<b>` and
`refs/remotes/origin/<b>`, still at the commits being discarded when the guard runs, would count
as witnesses. An issue marked `Done` only on the work this dispatch is about to throw away would
then be refused, which contradicts 15's "self-correcting".

The ruling is that **both refs are left out, by name**, because both are being discarded:
`refs/heads/<b>` by T101's reset, and `refs/remotes/origin/<b>` by the D7 lease push that
overwrites it. Excluding by SHA was rejected. It would also silence a *different* branch that
happens to stand at the discarded tip and keeps those commits.
-->

## What to build

**`--feature <f> --hard-reset` selects and checks the issue set as the base has it, and the
branch being discarded is not a witness against itself.**

### 1. Lift the refusal

Delete T101's `--feature` + `--hard-reset` refusal and its test. `--resume`/`--last` +
`--hard-reset` stays refused (D5). A feature resume is a resume.

### 2. The witness does not count the branch being discarded

`landedElsewhere`'s request gains the refs to leave out, for example `alsoExcluding:
ReadonlyArray<string>` of full ref names, empty by default. `notLandedElsewhere` in
`dispatch/guards.ts` passes `refs/heads/<b>` and `refs/remotes/origin/<b>` when the plan resets,
and nothing otherwise. The tip exclusion is unchanged. With no reset, the request and the answer
are what they are today.

Leave the ledger witness (`notInProgressElsewhere`) alone: it asks about *other* branches'
in-flight runs, and a reset does not change that.

### 3. What already follows from T101, pinned here

Once the effective tip is `baseSha`, these follow with no further code. This ticket adds a test
for each:

- `issueSetAt` reads the set at `baseSha`. An issue marked `Done` only on the branch's discarded
  commits is **not Done** for this run.
- `issuesSelected`: `--issues all` offers such an issue as ready, and an enumerated one is not
  refused as already Done (T73's rule, read at the base).
- The feature loop's first per-issue boundary falls back to `plan.tipSha`, which is the base
  (`dispatch/feature.ts:194`). So T75's build-on sentence is absent for the first issue and
  present from the second, exactly as on a fresh branch.
- T77's status commit is built on the reset branch and gated on `thisRun`, as for any run.

### 4. SPEC

SPEC §7's `--hard-reset` row: the feature arm reads the set at the base (14 §7). The
landed-elsewhere witness leaves out the branch's own local and remote-tracking refs under a reset
(this ticket), with 15's "self-correcting" as the reason.

## Effect wiring

- **Tags introduced or consumed**: `IssueStore` (`landedElsewhere`'s request widens). No new tag.
- **Layer composition**: unchanged. `IssueStoreRecordingLive` passes the read through, so a
  rehearsal asks the same question.

## Acceptance criteria

- [ ] `--feature <f> --hard-reset --branch b` is no longer refused for being a feature dispatch,
      and `--resume b --hard-reset` still is.
- [ ] With an issue `Done` on `b` and on `origin/b` but not at the base, `--issues all
      --hard-reset` selects it and is not refused by the landed-elsewhere witness. The same issue
      `Done` on some *other* branch still refuses.
- [ ] An enumerated `--issues` naming that issue is not refused as already Done.
- [ ] Without `--hard-reset`, every T71–T79 test passes unchanged.
- [ ] SPEC §7 is updated as in §4.

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package.
