# Issue tracker: Local Markdown

Issues and PRDs for this repo live as markdown files in `.agentbox/tasks/`.

## Conventions

- One feature per directory: `.agentbox/tasks/<feature-slug>/`
- The PRD is `.agentbox/tasks/<feature-slug>/PRD.md`
- Implementation issues are `.agentbox/tasks/<feature-slug>/issues/<NN>-<slug>.md`, numbered from `01`
- Triage state is recorded as a `Status:` line near the top of each issue file (see `triage-labels.md` for the role strings)
- Comments and conversation history append to the bottom of the file under a `## Comments` heading

## Tracked issue sets

`.agentbox/.gitignore:11` ignores `tasks/*/`, so a feature directory is local to one dev. That is
right for hae's own queues, where `Status:` churn is derived state (ADR 0005), and it means any
issue set that must survive in git lives somewhere else.

An issue set is a **deliverable** rather than a queue when it gets reviewed in a PR, outlives the
run that consumed it, or is the stated output of a planning effort. Those live tracked, beside the
document that produced them, and dispatch passes the path: `run.sh` uses any `--feature` value
containing a slash as-is, so no dispatcher change and no gitignore surgery is needed.

The speepobox T-bullets are the standing example — `docs/wayfinder/effect-agentbox/issues/`, beside
the map that produced them, numbered `T1`–`T6` after the roadmap bullets they implement rather than
from `01` (ticket 04 §5).

## Issue state lives on the branch — for tracked sets

Ruled 2026-08-14 by
[`docs/wayfinder/effect-agentbox/14-done-conflates-approved-with-landed.md`](../wayfinder/effect-agentbox/14-done-conflates-approved-with-landed.md).
Implemented in bash by `.agentbox/tasks/agentbox-hardening/issues/03-issue-state-lives-on-the-branch.md`;
the TS port inherits it at P2.

Applies to **tracked** issue sets (previous section). Untracked per-dev queues under
`.agentbox/tasks/*/` are not in git, so there is no ref to read and their `Status:` stays host-side
derived state exactly as ADR 0005 has it — see the caveat at the end.

**`Status: Done` means one thing and one thing only: this issue's code is on this ref.** Not a
re-run guard, not a workflow position, and not a claim about work a reviewer approved but nobody has
merged.

It is written by the **dispatcher**, on **approval only**, as a commit on the run branch — so it
reaches a base in the same merge as the code it describes, and the two can never disagree. It is
never written to the host working tree: that path's existence depends on whichever branch the dev
happens to have checked out, which is not a fact about the issue.

State splits by scope, and no store answers a question it cannot know:

| Question | Answered by |
| --- | --- |
| landed — may dependents start | the issue file at the **branch tip**, in git |
| approved, awaiting merge | some other ref's copy says `Done`, and that ref is unmerged into tip |
| running | the live PID claim |
| needs-work | the ledger row |

**Gate against the branch tip, not the base.** The checkout forks from the branch tip, so the tip is
the ref whose content the agent actually sees. Gating on the base gates on a ref the run never
touches — and it forbids **stacking**, where a branch legitimately forks from another unmerged
branch and so already carries its blocker's code. The port's picker ships the same order —
branch before issues — so the set it offers is read at the tip the run will fork from (T83).

**Correctness never depends on machine-local state.** Losing a host-local record costs wasted work,
never wrong work: a dependent's gate reads the tip's file, so nothing can start against a tip
missing its blocker's code. That is why the run ledger stays derived state, usable as a hint and
never as truth.

**No ancestor check.** `git merge-base --is-ancestor <blocker-branch> <base>` is the wrong question
and breaks under squash-merge. The right question is whether the tip's copy of the file says `Done`,
and a squash carries that edit like any other hunk.

**Caveat, unresolved.** For untracked queues the issue files are absent from every ref, so the
blocker gate has no git answer and keeps reading the host tree. The *code* hazard is unchanged there
— a blocker may be approved and unmerged — but the fix above cannot reach it. Not yet worked in
bash. **The port answers it by refusing**: speepobox reads `<folder>/issues/` out of the branch tip
and never off disk, so a folder no ref carries is a `GuardRefused` before anything is held rather
than a gate quietly falling back to whichever branch the dev left checked out (T73).

## When a skill says "publish to the issue tracker"

Create a new file under `.agentbox/tasks/<feature-slug>/` (creating the directory if needed) — or,
for a tracked set, under that set's own directory.

## When a skill says "fetch the relevant ticket"

Read the file at the referenced path. The user will normally pass the path or the issue number directly.
