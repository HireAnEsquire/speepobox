# T82 — The base step and the summary's edit rows

Status: Done (PR #43. `Edit base` opens on the chain default, never on an explicit base picked earlier: at rest the list is only `← Back` and the default, so there is no other row to start on. Every T81 script gained an Enter for the base step, not only the `← Back` case the criteria named — the criterion was wrong, not the diff. The live layer's as-is row is shown before git is asked and checked on Enter; a refused query re-opens the prompt with no reason given (`clack.ts` (5)), which is the hands-on check still owed. A short SHA hidden by fuzzy ref matches was measured and ruled out: none of 200 short SHAs in hae matches any of its 159 ref names)
Type: AFK
Blocked by: [T81](T81-no-args-on-a-tty-picks-a-spec-and-a-branch.md) — the tag, the entry, and the two steps this one sits after.

<!--
P3 (09 Q5). bash's `pick_base` (`tasklib.py:1888`) and its installer-style summary
(`_summary_menu`, `_DOWNSTREAM_STEPS`, `cmd_pick`). SPEC §7 binds only branch-before-issues;
base is a function of the branch, so it goes last, where the step most often left at its default
belongs. T83 later **inserts** the issues step between branch and base — the derivation graph in §2
is written once, here, with that slot in it, so T83 adds an edge rather than re-authoring the graph.
-->

## What to build

**After the branch, the picker asks for the PR base — quiet until typed, Enter takes the chain
default, any git-resolvable ref is accepted — and the summary offers `Edit <step>` rows that re-run
that step and every step derived from it.**

### 1. The base step

One `autocomplete`. With an empty query the list is a single row, `[default] <chain>`, where the
chain is `Ledger.lastBaseForBranch(branch)` and then the configured `base` (SPEC §7's `--base`
row); Enter takes it. Typing ranks every ref name from `Git.forEachRef` (short names; `refs/heads/`
and `refs/remotes/` alike) through `rankFuzzy`; a query matching no ref adds a `use '<q>' as-is`
row iff `Git.revParse` resolves it (SHAs, `HEAD~1`, tags — bash's rule). `← Back` is the first
row at rest. The step never resolves anything for keeps: the run's `BASE_SHA` is still taken once,
post-fetch, by the guard (T70).

The argv gains `--base <ref>` **only when the choice differs from the chain default** — bash's
`BASE_EXPLICIT`; a run that took the default is recorded and echoed as a flag invocation without
`--base` would be.

### 2. The summary's edit rows

The `Dispatch` select gains `Edit source`, `Edit branch`, `Edit base` (and, once T83 lands, `Edit
issues` when the source is a feature) between `Dispatch` and `← Back`. An edit re-runs the edited
step and then every step whose input derives from it, in order, and returns to the summary:

| Edited | Re-runs |
| --- | --- |
| source | branch, issues, base |
| branch | issues, base |
| issues | — |
| base | — |

Data, not scattered ifs (`_DOWNSTREAM_STEPS`), with *issues* present as a slot T83 fills. A step
re-run this way is pre-answered with its previous choice where the prompt allows (the branch and
base rows the cursor starts on). T81's `Prompt` tag carries no starting row, so this grows
`select` and `autocomplete` an optional initial value, mapped onto clack's own in `clack.ts` and
recorded by `scriptedPrompt` so a test can assert it. Cancel inside an edit is a cancel — 13's
one-sentinel rule — not bash's "back to the summary".

`← Back` on the summary re-enters the last step that ran (base), as it does on every step.

### 3. Docs

- SPEC §7, the `--base` row: the interactive chain — quiet until typed, Enter is the chain default,
  free text iff resolvable — ships (T82); the flag is emitted only when the choice is not the
  default.
- SPEC §7's *no args on a TTY* row: name the four steps in their order and the edit-rerun rule in
  one sentence.

## Effect wiring

- **Tags introduced or consumed**: none introduced. `Prompt`, `Git` (`forEachRef`, `revParse`),
  `Ledger` (`lastBaseForBranch`) consumed by the picker.
- **Layer composition**: unchanged from T81.

## Acceptance criteria

- [ ] Script: spec, branch, Enter on the base step, `Dispatch` — the words carry no `--base`, and
      the base step's at-rest rows were exactly `← Back` and `[default] <ledger's last base>`
      (config's `base` when the ledger has no row for the branch).
- [ ] Script: a typed ref that `forEachRef` lists — `--base <that ref>` is among the words;
      a typed SHA no ref carries, with the fake `revParse` resolving it — accepted as-is; one it
      refuses — not offered.
- [ ] Script: `Edit branch` from the summary — the branch step and then the base step ran again,
      source did not, and the summary showed the new choices.
- [ ] Script: `Edit base` — only the base step ran again.
- [ ] `← Back` on the summary re-enters the base step; `Cancel` during an edit exits with
      `!! picker cancelled`.
- [ ] Every T81 test passes unchanged but one: the script that answers `← Back` at the summary
      (`test/picker.test.ts`) re-entered the branch step under T81 and re-enters base now — amend
      that case, do not add a second.

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package.
