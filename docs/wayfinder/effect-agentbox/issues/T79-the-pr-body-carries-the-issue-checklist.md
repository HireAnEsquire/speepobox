# T79 — The PR body carries the issue checklist

Status: Done (PR #41. The first round printed each issue's id twice — `Issue.title` is the whole H1, and every H1 opens with the id — and a resume made it print once. The id check has no boundary after the id, so `T7` would match a title opening `T70…`; a ticket's H1 is its own, so no real folder reaches it. `src/agent/prompt.ts:424` writes `<id> (<title>)` into the review prompt and doubles the id the same way; it was left out of scope)
Type: AFK
Blocked by: [T76](T76-the-feature-loop.md) — the outcomes it renders.

<!--
P2 (09 Q5). bash appends an `### Issues` checklist to every feature PR (`run.sh:1903-1935`),
rebuilt over the whole folder with a status-derived line for every issue this run did not touch,
merged without associative arrays because bash 3.2. Decision 4 of 09's comment of 2026-09-21:
**this run's selection only** — the status commit in the same PR's diff (T77) already says which
files went `Done`, and a line about an issue the run never selected is a claim about work the PR
does not contain.
-->

## What to build

**A feature run's PR body ends with a checklist of the selected issues, one line each in T69's
order, rendered by the dispatcher from the run's outcomes and appended below the describe-PR pass's
answer — never asked of the agent.**

### 1. The render

A pure function over `(selection, outcomes, stopReason)` → markdown:

```
### Issues
- [x] T70 — The dispatch fetches origin …: ✅ approved
- [ ] T71 — `IssueStore` reads …: ⚠️ needs-work (review capped at 3 round(s))
- [ ] T72 — Landed elsewhere …: not attempted (sequence stopped)

**Stopped:** issue T71 (…) review capped at needs-work after 3 round(s)
```

One line per outcome in T76's vocabulary, bash's wording (`run.sh:1792, 1859, 1873, 1880, 1887,
1899`) minus the `blocked (HITL)` line; **All selected issues completed.** when nothing stopped it.

### 2. The placement

`dispatch/pr.ts` appends it to the body on a `Feature` task — after the span T12 extracts from the
answer, or after the static body when no marker vouched for one — on create and on edit alike, so
a resumed run's PR shows the newest run's checklist. A spec or inline run's body is unchanged.

## Effect wiring

- **Tags introduced or consumed**: none.
- **Layer composition**: unchanged.

## Acceptance criteria

- [ ] The render, for each outcome and for the stopped/completed footer, matches §1 line for line.
- [ ] A feature run's `prCreate` body ends with the checklist; the fake forge records it; a resume's
      `prEdit` body carries the resumed run's checklist and not the first run's.
- [ ] A spec run's body is byte-identical to today's.

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package.
