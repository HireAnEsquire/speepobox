# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker (recorded as the `Status:` line in each issue file under `.agentbox/tasks/`).

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

Edit the right-hand column to match whatever vocabulary you actually use.

## Closing an issue

The five roles above are triage states — all of them describe an issue that has not been built yet.
Trackers with native issue state close an issue outside the label vocabulary; this one is markdown
files, so closure is a sixth `Status:` value, local to this repo:

| Our label | Meaning                                                          |
| --------- | ---------------------------------------------------------------- |
| `done`    | Shipped and merged. The issue file is the record, not the backlog |

This is the word agentbox's dispatcher already reads as terminal: `tasklib.py` matches `done` as the
first token of the `Status:` line, case-insensitively, and skips those issues when selecting what to
run. A trailing annotation is fine — `done (verified 2026-08-07)` still counts.

An issue reaches `done` when its work is **merged**, not when the PR opens — a closed ticket on an
unmerged branch reads as shipped to the next session. Set it in the same commit that records the
closure, and append the outcome under a `## Comments` heading at the bottom of the file: what
merged (PR link and merge commit), which acceptance criteria came out differently than written, and
anything a later issue inherits.
