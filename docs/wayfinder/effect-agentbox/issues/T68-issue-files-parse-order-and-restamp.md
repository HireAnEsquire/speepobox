# T68 — Issue files: parse, order, and restamp

Status: Done (PR #29; a wrapped `Blocked by:` header silently loses its continuation to the per-line regex — T73 read as blocked by T69 and T70 with T71 invisible — and the first-token status rule diverges from the cited `done\b(?!-)` on a punctuation-attached annotation, where a false not-done re-dispatches landed work)
Type: AFK
Blocked by: none.

<!--
First of the P2 tickets (09 Q5, `IssueStore` + feature mode), authored in the `/to-tickets` pass of
2026-09-21 — 09's comment of that date carries the five decisions the pass took. This is the pure
half of tasklib's issue layer (`tasklib.py:174-261, 363-388`, inventory 03 §3.1–3.3), which SPEC §2
lists under *plain functions, no tag*: text in, values out, no filesystem and no git. It is where
tasklib's 14 parsing/selection tests and 2 set-status tests translate (SPEC §11).

Nothing here is reachable from a command line. `IssueStore` (T71) is the first caller of the parse;
`markLanded` (T77) is the first caller of the restamp.
-->

## What to build

**A module of pure functions over issue-file text: parse one file into an `Issue`, order a set of
them by their blockers, and rewrite a file's `Status:` line.** No tag, no `FileSystem`, no `Git` —
the caller hands text in and takes values out, so a fake buys nothing and every test is a value
assertion.

### 1. Parse

One `.md` per issue; the caller passes the file's stem and its text. The rules are tasklib's
(`tasklib.py:174-241`), which are also this folder's own headers:

- **Headers** are lines matching `^\s*(status|type|blocked by)\s*:\s*(.*?)\s*$`, case-insensitive,
  read from the top **until the first `##`** — a header below the first section heading is body.
- **Title** is the first `#` line's text; absent, the stem.
- **Id** is the stem up to its first `-` (`T67`, `03`). It is the value `--issues` names, the value
  a `Blocked by:` token names, and the value the ledger row records in `IssueOutcome.issue` ("the
  issue's own identifier as dispatched", `record.ts`). A token compares to an id case-insensitively,
  and **a bare number matches an id whose digits are that number** — `37` names `T37`, which is
  what bash recorded (`issues={"37": "approved"}`, 15) and what a dispatcher types.
- **`Type:`** is `AFK` or `HITL`; absent is `AFK` (`tasklib.py:238`, deliberate compat). Anything
  else is a parse error naming the file.
- **`Status:`** is the triage vocabulary of `docs/agents/triage-labels.md` — `needs-triage`,
  `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`, `done` — compared by **first
  token, case-insensitively** (`tasklib.py:196`'s `done\b(?!-)`), so `Done (PR #26; …)` is done and
  `done-ish` is not. Absent is `needs-triage`. An unrecognised first token is kept as an
  `Unknown(text)` arm rather than a parse error: a stale spelling on one file must not refuse a
  dispatch of its neighbours, and the selection (T69) treats `Unknown` as not-done and not-ready.
- **`Blocked by:`** is a comma list; each token's id is read by the rule above (so `[T66](…)` and
  `T66 — the union` both name `T66`, and `ticket 16` names nothing in the folder). Empty, `none`,
  `—`, and `-` are no blockers. A token naming no issue in the folder is kept verbatim as an
  **external** blocker: never satisfied, so `all` never selects the issue and enumerating it is a
  violation naming the token (T69) — this is how 15 read T36's `Blocked by: ticket 16`.

### 2. Order

Kahn's algorithm over the selected set, ties broken by id ascending (numerically where both ids
carry digits, lexically otherwise), a cycle a typed error naming the ids on it
(`tasklib.py:252-266`). Pure over `ReadonlyArray<Issue>`.

### 3. Restamp

`withStatus(text, status)` returns the file's text with its `Status:` line replaced, by
`cmd_set_status`'s three placements (`tasklib.py:363-388`): the first `Status:` line rewritten in
place; none → inserted before the first `##`; no `##` either → inserted as the second line. The
result always ends in one newline. The parse of the result reads the new status back — that is the
test, and it is the whole contract T77's `markLanded` needs. The value written for landed is `Done`,
matching the hand-written status commits already in this folder.

### Out of scope

Reading a directory or a ref (T71), selection (T69), anything that knows what a branch is.

## Effect wiring

- **Tags introduced or consumed**: none. `Schema.Struct` for `Issue` (id, stem, title, type,
  status, blockers) so SPEC §5's rule holds when `IssueSelection` (T69) carries them.
- **Layer composition**: unchanged. `app.ts` is not touched.

## Acceptance criteria

- [ ] Every rule in §1 has a test: the header regex and the `##` cut-off, title fallback, id from
      the stem, bare-number matching (`37` ↔ `T37`), `Type` default and rejection, every triage
      status by first token with a trailing annotation, `Unknown`, `Blocked by` link and dash
      spellings, `none`/`—`/empty, an external blocker kept verbatim.
- [ ] `T66-…md` and `T67-…md` as they sit in this folder parse to `Done`, `AFK`, the right ids and
      blockers (T67 → `[T66]`; T66 → none). `TEMPLATE.md` parses to `needs-triage`, `AFK`, no
      blockers.
- [ ] Order: a diamond orders deterministically with ties by id; a cycle is the typed error naming
      its members; an external blocker does not enter the order.
- [ ] Restamp: all three placements, idempotence (restamping `Done` over `Done` is a no-op), a file
      without a trailing newline gains one, and `parse(withStatus(t, s)).status === s` for every
      status.
- [ ] `git grep -n "Status:" src/` returns only this module — nothing else in `src/` reads or
      writes the header yet.

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package.
