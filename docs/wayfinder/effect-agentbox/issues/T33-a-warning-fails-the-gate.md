# T33 — A warning fails the gate

Status: Done
Type: AFK
Blocked by:

Sequence: [ticket 08](../08-in-hae-sequence.md). A gate fix, not a feature — the same shape as
[T20](T20-atomic-lock-claim.md) and [T32](T32-the-salvage-verifies-what-it-reports.md): something
already on the branch reports success over a real defect.

**Tracer: `npm run verify` goes red on a warning, because a warning is a finding nobody is going to
come back for.**

## What to build

`npm run verify` is what the dispatcher's agent runs to decide it is done, and what every ticket's
Verify section leans on. It is `typecheck && lint && test`, and `lint` is:

```
oxlint && oxfmt --check . && node scripts/check-bans.ts
```

`oxlint` exits `0` when every finding is a warning. `.oxlintrc.json` maps the whole `suspicious`
category to `warn` and `no-underscore-dangle` likewise, so a real defect in one of those rules
leaves `verify` green.

It has fired. [T31](T31-a-rescued-run-says-so-on-its-row.md)'s `releaseClone` took a parameter named
`rescued` while a `Ref` of the same name was in scope in the caller — a shadow, `suspicious`,
warning-only. `verify` passed on it through the agent's seven commits and review round 1. Round 2
found it by reading. The fix landed as `0b15cd23f2 review(T31): the release's clone removal names
its argument distinctly`.

Add `--deny-warnings` to the `oxlint` invocation in the `lint` script:

```
"lint": "oxlint --deny-warnings && oxfmt --check . && node scripts/check-bans.ts"
```

**The tree is already clean under it** — `./node_modules/.bin/oxlint --deny-warnings` exits `0` on
`tseff` as of 2026-08-17, so this needs no cleanup pass and no rule triage. It is one flag.

`--deny-warnings` rather than promoting `suspicious` to `"error"` in `.oxlintrc.json`: the severity
distinction is worth keeping for a human reading `oxlint` output directly during development, where
"this is definitely wrong" and "look at this" are usefully different. What must not differ is
whether the _gate_ accepts them. One flag on the gate, config untouched.

## Not in scope

The other two commands in the chain. `oxfmt --check` and `check-bans.ts` are pass/fail already.

Widening what `verify` covers — `verify:live`, coverage thresholds, anything new. This ticket makes
the existing gate mean what it says.

`.oxlintrc.json` rule severities. Changing them is a separate judgement about each rule; this is a
judgement about the exit code.

## Read first

`package.json` (the `scripts` block), `.oxlintrc.json`, and `AGENTS.md`
where it names `npm run verify` as the definition of done. Amend `AGENTS.md` only with a ruling you
had to discover. **Do not touch hae files** — this is entirely inside `speepobox/`.

## Acceptance criteria

- [ ] `npm run lint` exits non-zero when `oxlint` reports a warning and no error
- [ ] `npm run lint` exits `0` on the tree as it stands, with no source changes
- [ ] `npm run verify` still runs typecheck, lint and test in that order, unchanged otherwise
- [ ] `.oxlintrc.json` is unmodified
- [ ] no source file outside `package.json` changes, except an `AGENTS.md` amendment if
      one is genuinely owed

## Verify

```
cd bessemer
npm run lint                    # exits 0
```

Then introduce a warning-only finding and confirm the gate now catches it — a shadowed binding, or
a leading underscore on a name other than `_tag`:

```
npm run lint                    # exits non-zero, names the rule
```

Remove it and confirm `npm run verify` is green end to end.
