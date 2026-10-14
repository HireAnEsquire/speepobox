# T73 — A feature dispatch names its issues

Status: Done (PR #33; §2's table was four rows and wanted five — `--feature` beside `--resume`/`--last` passed the guard and lost to the resume arm downstream, answering the dispatcher about a ledger they had not asked about or dropping the selection in silence, fixed on the branch before merge — and two smaller things went to T78, which owns the same arm: a whitespace-only `--feature` is told to pass `--feature`, and SPEC §7's `--issues` row contradicts itself on resumes)
Type: AFK
Blocked by: [T69](T69-a-selection-is-a-value.md), [T70](T70-the-dispatch-fetches-origin-before-it-resolves-the-base.md), [T71](T71-issuestore-reads-an-issue-set-out-of-a-ref.md)

T69 is the selection, T70 the post-fetch slot the content guards sit in, T71 the read at the tip.

<!--
P2 (09 Q5), the command surface. 15's ruling: *the dispatcher may replay a work set it recorded,
and may execute a set the command named. It may never compute one the command did not name.* 09's
unit 1 is the spelling of that rule at the door — `--feature` without `--issues` refuses, and the
wide form is `--issues all` — and it is an argv-only refusal in T67's class, which is why it lives
here and not beside the two witnesses (T74), which read refs and the ledger and fire under the
opposite override.

The live run stops after the guards in this ticket: a `Feature` plan reaching the scope is refused
with the line `resume.ts` already uses for a feature resume, until T76 builds the loop. What is
demoable is `--dry-run --feature … --issues …` end to end, and every refusal.
-->

## What to build

**`bessemer --feature <folder> --issues a,b|all --branch <b>` resolves a plan whose task is a
`Feature` arm carrying an ordered `IssueSelection`, read at the branch tip through `IssueStore`
after the fetch, with every refusal a `GuardRefused` before the lock — and `--dry-run` prints it.**

### 1. The flags (SPEC §7)

- `--feature <folder>`: resolved like a spec (`run.sh:790`; `specPathFor`'s rule without the `.md`
  suffix) — a bare name under the tasks dir, anything with a slash a path used as-is — to a
  **repo-relative** folder, which is what the plan, the row, and every message carry (14, lesson 9).
- `--issues <a,b|all>`: comma list of ids, or the literal `all`. Trimmed and emptiness-filtered
  **once at the door**, as `--task` and `--feedback` are; `all` is case-insensitive.

Both optional at the parser, refused by guards (T3's rule). Both go through the `--repo-root` peel's
`VALUE_OPTION_NAMES` (T67's closing note).

### 2. Refusals decided from the command line alone

In `taskStatedOnce`'s slot, before anything asks the world:

| Spelling | Refuses because |
| --- | --- |
| `--feature x` with no `--issues` | a selection the dispatcher did not name is a proposal, not an instruction — name the set, or `--issues all` (09 unit 1, 15) |
| `--issues` with neither `--feature` nor `--resume`/`--last` | `--issues` names issues of a feature or narrows a resume (`run.sh:926`) |
| `--feature x` beside `<spec>` or `--task` | two tasks; state one (T67 row 10's shape) |
| `--feature x` beside `--resume`/`--last` | two runs; a resume replays the work set its record holds (`--task`'s row 11 on this pair). Above the `--issues` rows below: the whole command line is the mistake, so a dispatcher told to name a set would add one and still lose it to the resume arm |
| `--feature x --issues ""` (or all whitespace) | an empty selection, refused as such — not as "requires `--issues`" |

`specGiven`'s message gains the fourth spelling: *a task is required — pass `<spec>`, `--task "…"`,
`--feature <folder> --issues …`, or `--resume <branch>`*. `--issues` beside `--resume` is T78's.

### 3. The content guards, post-fetch, at the tip

After `resolveMergeBase` (post-fetch, T70) and before `reconcile`:

1. Resolve the branch tip once — `revParse refs/heads/<branch>` — and put it on the plan as
   `tipSha`. This is 15's "fork commit": the checkout clones the tip, so the tip is the ref whose
   content the agent sees (14). `BASE_SHA` is the diff boundary's other end, never what the set is
   read at (T70 §4).
2. `IssueStore.issues({ repo, ref: tipSha, folder })`. `FolderAbsent` refuses: *`<folder>/issues/`
   is not on branch '<b>' at <short tip> — the folder must be tracked and present on the branch
   (an untracked queue is not supported; a branch cut before the folder was added needs a rebase)*.
   `Unparseable` refuses naming the file.
3. `select(issues, request)` (T69). Every `SelectionRefused` arm becomes a `GuardRefused` in its
   own words — all violations in one message, as T69 lists them.

Nothing here writes: two reads and a pure function. Matrix row 1 holds through this phase (15).

### 4. The plan

`Task` gains a third arm: `Feature { folder, selection: IssueSelection, feedback }`. `feedbackIn`
answers `feedback`. `specMount` mounts nothing on it (the mount is T75's, from the checkout).
`taskNamed` prints `'<folder>'`; the mode line prints **`feature`**, §7's sixth spelling, and the
plan block gains a row per selected issue in order — `issues  T70 T71 T72 (3)` on one line is
enough, since the ids are what a dispatcher checks. The identity is `Feature { feature: folder,
issues: [] }`: outcomes are the run's to fill (T76), and a plan decided before anything is held
cannot know them.

`DispatchPlan.tipSha` is added for every arm, not only this one: the value exists for every
dispatch and T77 reads it on the way out.

### 5. The scope, until T76

`runInScope` refuses a `Feature` plan at the door of the scope, before the lock, with
`resume.ts`'s existing sentence (*feature mode is not implemented yet*) — a `GuardRefused`, so no
row and no log. It is the one temporary line this sequence carries, and T76 deletes it.

### 6. Docs

- SPEC §7's *Guards run in two phases* paragraph: step 4 now ships; strike *this describes the
  target, not what ships today*.
- `docs/agents/issue-tracker.md`, the *Caveat, unresolved* paragraph: the port answers it by
  refusing an untracked folder; say so in one sentence beside bash's behaviour.
- `AGENTS.md`, under *Guards*: one bullet, ending `(T73)` — **the issue set is read at the branch
  tip and never at `BASE_SHA` or off disk**; a read of the working tree typechecks and answers
  for whichever branch the dev left checked out (14).

## Effect wiring

- **Tags introduced or consumed**: none introduced. `IssueStore` and `Git` consumed in `dispatch.ts`,
  where both are already in the requirement set (`Git`) or reachable from the composition
  (`IssueStore`, T71). The `IssueStore` fake from T71 scripts the tip's issue set.
- **Layer composition**: unchanged from T71. `dispatch/command.ts` gains `Options.text("feature")`
  and `Options.text("issues")`; `DispatchRequest` gains `feature` and `issues` as `Option<string>`.

## Acceptance criteria

- [ ] `--feature f --issues T70,T71 --branch b --dry-run` records one fetch, reads the set at the
      branch tip through the fake `IssueStore` (the fake records the `ref` it was asked, and it is
      the tip's SHA, not `baseSha`), prints the plan block with mode `feature` and the two ids in
      T69's order, and writes nothing under the runtime root.
- [ ] The same without `--dry-run` refuses at the scope's door with no lock, no row, no log.
- [ ] Each row of §2's table refuses with a `GuardRefused` in its words, before any git call.
- [ ] `--feature f --issues all` with the fake set holding one `ready-for-agent` issue and one
      `needs-triage` issue selects the first only; with nothing ready refuses `NothingReady`.
- [ ] A folder absent at the tip refuses with §3's sentence; a set naming an unknown id, a done
      id, a HITL id, and an unmet blocker refuses once, naming all four.
- [ ] `--branch b` with none of `<spec>`, `--task`, `--feature`, `--resume` refuses naming all four
      spellings.
- [ ] Every existing dispatch test passes unchanged, and `DispatchPlan.tipSha` is the branch's
      pre-run tip on a spec dispatch too.
- [ ] `node src/bin.ts --help` lists `--feature` and `--issues` with SPEC §7's sentences.

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package.

```
node src/bin.ts --help | grep -- "--feature\|--issues"
```
