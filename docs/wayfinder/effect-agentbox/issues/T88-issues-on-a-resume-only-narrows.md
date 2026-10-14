# T88 — `--issues` on a resume only narrows

Status: Done (PR #46. Narrowing to an id whose blocker is open and unselected refuses as a fresh enumerated dispatch does, per T69; no resume-path test pins it)
Type: AFK
Blocked by: [T78](T78-a-resume-runs-some-of-what-it-ran-before.md), [T87](T87-an-empty-feature-flag-is-refused-as-empty.md) — the replay it narrows, and the same guard arm.

<!--
P2. Split out of T78 on 2026-09-22 (T78 says why). T78 refuses `--issues` beside a feature resume
as a stopgap; this ticket replaces that refusal with 15's rule — narrowing *is* continuing. T87
edits the same `featureStatedOnce` arm and lands first.
-->

## What to build

**`--issues` on a resume of a feature run may only name a subset of what the record left to do.
`all` on a resume is refused. `--issues` on a resume of a run that recorded no set is refused.**

### 1. The three rules (SPEC §7, 15)

- **`--issues all` refuses.** It has two defensible readings and neither wins. The unambiguous
  spelling of the second is `--feature <folder> --issues all --branch <same branch>`, and the
  refusal says so.
- **Enumerated `--issues` must be a subset of the recorded set** — membership against the row's
  `issues[]`, whatever their outcomes — and, within that, of the recoverable ones. An id outside
  the set refuses and names the recorded set. An id recorded `approved` refuses as `AlreadyDone`
  does. Ids match by T68's id rule, as a fresh dispatch's do: exact and case-insensitive, or a bare
  number against the id's digits (`37` selects `T37`).
- **`--issues` beside `--resume` of a `OneOff` or `InlineTask` row refuses**: the record has no set
  to narrow. Today it is dropped in silence.

The narrowed ids go through the same tip re-read T78 built, in T69's order.

### 2. Where the rule lives

**This ticket owns `featureStatedOnce`'s `onNone` arm for a resume.** T73 left it letting
`--issues` through beside `--resume` so the subset rule could be decided here. The rule needs the
record, so the refusal is not the command-line guard's to make. The guard keeps letting it
through, and the resume decides: the same place T78's stopgap refused, and the stopgap goes.

### 3. Docs

SPEC §7's `--issues` row contradicts itself. It says *Refused on a `--resume` as ambiguous*, and
then *enumerated `--issues` on a resume must be a **subset** of the recorded set*. Only `all` is
ambiguous. Rewrite the row to say so as this ticket builds it. The same row calls the value a
*comma list of issue prefixes*, which is bash's word. The port matches by id (§1), never by prefix,
and the row says that.

The comment at `featureStatedOnce`'s `onNone` arm names this ticket and says a feature row's resume
refuses the flag until then (T78 re-pointed it); drop the *until then* when the stopgap goes.

## Effect wiring

- **Tags introduced or consumed**: none introduced.
- **Layer composition**: unchanged.

## Acceptance criteria

- [ ] Over a feature row `[A approved, B needs-work, C not-attempted]`: `--resume b --issues C`
      plans `[C]`, and so does a lower-case `--issues c`. Over ids `T2`/`T3`, `--issues 3` plans
      `[T3]`.
- [ ] `--issues A` refuses as already approved; `--issues D` refuses naming the recorded set;
      `--issues all` refuses with the spelling 15 gives.
- [ ] `--resume b --issues C` where `b`'s row is a `OneOff`, and where it is an `InlineTask`,
      refuses.
- [ ] T78's stopgap refusal is gone.
- [ ] SPEC §7's `--issues` row says `all` alone is what a resume refuses, over a value matched by
      id rather than by prefix.

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package.
