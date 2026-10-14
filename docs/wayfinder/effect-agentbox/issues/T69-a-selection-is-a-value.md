# T69 — A selection is a value

Status: Done (PR #30; the ticket ordered exactly two SPEC §12 entries, so the third divergence it creates went unrecorded — bash re-runs an enumerated already-Done issue where the port refuses it — and §3's table misplaces bash's HITL stamp, which goes on the issue file's own `Status:` header and not on the row)
Type: AFK
Blocked by: [T68](T68-issue-files-parse-order-and-restamp.md) — the `Issue` it selects over and the
order it hands back.

<!--
P2, second ticket (09 Q5; 15's resolution). tasklib's `select_issues` (`tasklib.py:268-333`) as a
pure function returning a Schema value, per SPEC §5: *every operation returns a Schema-defined
domain value — `IssueSelection`*. Its typed refusals become `GuardRefused`s in T73 — this ticket
returns them as data and knows nothing about a dispatch.

**`all` selects `ready-for-agent`, not bash's "AFK and not done"** — decision 1 of 09's comment of
2026-09-21, which amends 15 and SPEC §7 (both say *AFK, not-yet-Done*). The triage vocabulary
invented that status for exactly this question, and every ticket in this folder opens at
`needs-triage` (TEMPLATE.md), so bash's predicate would sweep in every ticket nobody has triaged —
the wideness 09's guard paragraph is about, and one a token typed before the list is seen cannot
consent to (15: "`all` consents to wideness, not to contents"). `ready-for-agent` is real
vocabulary here, not invented: 14 cites the status commits `docs(T13): update status from
ready-for-agent to Done`. This ticket amends SPEC §7's `--issues` row and 15's `all` sentence, and
adds the divergence to SPEC §12's list.
-->

## What to build

**`select(issues, request)` — pure over T68's `Issue`s — answers either an ordered `IssueSelection`
or a typed `SelectionRefused`, and every rule bash spread over `select_issues`, `cmd_select`, and the
run loop's HITL check is one arm of one of those two values.**

### 1. The request

```ts
// The shape 15 decided; names are the implementer's.
SelectionRequest = All | Enumerated { ids: ReadonlyArray<string> }
```

`Enumerated` ids arrive already trimmed and emptiness-filtered by the caller (T73 does it once, at
the door, as `--task` and `--feedback` are). Matching is T68's id rule.

### 2. `All`

Every issue that is `Type: AFK`, `Status: ready-for-agent`, and whose blockers are each **done or
also selected** — as a fixed point: start from every ready AFK issue, drop any whose blockers are
not all done-or-in-set, repeat until stable (`tasklib.py:292-306`). What the fixed point drops is
dropped silently; that is the wide form's contract. An external blocker (T68) is never satisfied.
The result may be empty, and empty is a `SelectionRefused.NothingReady` naming the folder — a
feature run with no issues is unrepresentable (T66's rule for the inline arm, applied here).

### 3. `Enumerated`

In order, and **all violations reported, not the first** (`tasklib.py:313-330` lists them):

| Arm | Fires when |
| --- | --- |
| `UnknownIssue` | an id names no issue in the folder — with the folder's ids as the hint |
| `AlreadyDone` | the named issue is `done` on this ref — 14's one meaning; re-running landed work is refused, not skipped |
| `NotAfk` | `Type: HITL` — bash stamps `blocked (HITL)` mid-run and stops the sequence (`run.sh:1746-1757`); here it is a refusal before anything is held, and the port never writes `blocked-hitl` to a row (SPEC §12 divergence, recorded by this ticket) |
| `BlockerViolation` | a blocker that is neither done nor in the set, listing every (issue, blocker) pair, external blockers by their token |

Enumerating **overrides status except `done`**: a `needs-triage` or `needs-info` issue named by id
runs, because the dispatcher named it (15's value-versus-policy line). `wontfix` too — naming it is
the override.

### 4. The value

`IssueSelection` is a `Schema.Struct`: the request that produced it, and `issues` in T68's order,
each carrying id, stem, file name, title, type, status, blockers. Order is decided **here**, once,
so the run loop (T76), the plan render (T73), the resume's subset check (T78), and the ledger's
`not-attempted` tail (T76) all read one sequence.

### 5. Docs

- SPEC §7, the `--issues` row: *`all` selects every `ready-for-agent` AFK issue whose blockers are
  done or also selected*. SPEC §12's divergence list gains two entries: `all` reads the triage
  status, and HITL is refused before the lock rather than stamped mid-run.
- 15's *Where `--issues` is required* section: one sentence beside the `all` cost, saying the
  predicate is `ready-for-agent` and pointing here.

## Effect wiring

- **Tags introduced or consumed**: none. Pure.
- **Layer composition**: unchanged.

## Acceptance criteria

- [ ] `All` over this folder's own files as of this ticket selects exactly the `ready-for-agent`
      AFK issues whose blockers are done or selected, in T68's order; a `needs-triage` AFK issue is
      not in it; a `ready-for-agent` issue blocked by a `needs-triage` one is not in it; a chain
      whose head is ready and whose tail is blocked only by the head selects both.
- [ ] `All` with nothing ready is `NothingReady`.
- [ ] `Enumerated` with two unknown ids reports both; with one done, one HITL, and one with an
      unmet blocker reports all three arms in one value.
- [ ] `Enumerated` naming a `needs-triage` issue and a `wontfix` issue selects both.
- [ ] `Enumerated` naming an issue whose blocker is also named selects both, ordered blocker first;
      naming only the dependent is a `BlockerViolation`.
- [ ] Bare numbers work in `Enumerated` (`37` selects `T37`).
- [ ] `IssueSelection` encodes and decodes through its Schema.
- [ ] SPEC §7's `--issues` row, SPEC §12's list, and 15 carry the sentences in §5.

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package.
