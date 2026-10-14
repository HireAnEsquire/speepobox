# T43 — Every row records the dispatcher that ran it

Status: Done
Type: AFK
Blocked by: None — can start immediately, and independently of
[T42](T42-doctor-asks-whether-the-dispatcher-is-stale.md).

<!--
Second of three from the 2026-09-08 re-slice of T41, whose dispatch timed out at 900s having
committed nothing. Full design:
docs/wayfinder/effect-agentbox/issues/superseded/dispatcher-freshness.md.

Independent of T42 on purpose — this one is a ledger field with a writer and a renderer, and shares
no code with the ancestry question. Both are blockers of T44, and neither blocks the other. Do not
run them concurrently: nothing in this repo has been dispatched twice at once yet.
-->

## What to build

Every ledger row records **which revision of the dispatcher wrote it**, and whether that
dispatcher's own source was dirty at the time.

The ledger already answers what ran, on what branch, from what base, and how it ended. It cannot
answer *which dispatcher* — and that is the question the whole self-hosting stretch turns on, because
across P2-P6 the tool dispatches itself and the revision that runs is decided by whichever branch the
dev had checked out. Bash records this; this package does not. On the run that motivated the whole
guard, the divergence was found days later by reading commit dates, because nothing on the row said
which dispatcher had produced it.

It is worth recording on its own, before any check consumes it: a row that names its dispatcher
makes a past run's semantics recoverable, which is exactly what the failing bash run could not offer.

### The revision is the dispatcher's, not the served repo's

Read it from the repo enclosing **`packageRoot`**, not from `repoRoot`. During incubation those are
one directory and the distinction costs nothing; under P6's shim they are two, and the tool runs out
of a cache clone while serving somebody else's repo. The dispatcher's revision is a fact about the
tool's own source, so the root it is read from has to be the tool's — this is the one place the
adopter shape can be got right for free rather than added to
[19](../19-the-tool-serves-a-repo-it-does-not-live-in.md)'s pile.

**Dirty means dirty under the package directory**, not anywhere in the repo. A doc edit is not a
modified dispatcher, and a row that claimed otherwise would cry wolf on nearly every run of this
repo. Derive that path the way [T42](T42-doctor-asks-whether-the-dispatcher-is-stale.md) derives its
scope, if T42 has landed; if it has not, derive it here in `src/config/paths.ts` beside
`resolveTasksDir` and `resolveSetupHookPath`, and T42 will use it.

It is a **host read, resolved at the composition root and passed down** — `AGENTS.md`'s rule, and the
one `DoctorHost` already follows for the node version and the repo root. Not read inside the ledger,
and not read from the working directory.

### The shape: a struct, not a decorated string

Record the short revision and the dirty flag as two fields of one value, rather than a string like
`6345f52-dirty` that a renderer has to parse back apart. `PullRequest` on this record already sets
the precedent and states the reason — the number is stored beside the URL "so no call site parses it
back out".

**It stays on record version 1**, and the file already carries the rule:

> A field every reader can be absent stays on this version. The number is what tells the *legacy*
> adapter apart from this schema, and bumping it for an addition every version-1 line already
> satisfies would either drop every line on the dispatcher's disk … or buy a third literal that no
> code branches on.

Spell it as an **absent key, not a nullable one** — the same
`Schema.optionalWith(…, { as: "Option", nullable: true, exact: true })` `rescuedOnto` uses, and for
the identical reason: the rows already on disk carry no such key at all, and those rows are the
history `status` exists to show.

`status` renders it. A row whose dispatcher is unknown — every row written before this ticket — must
still render, and must read as *unknown*, never as clean.

## Effect wiring

- **Tags introduced or consumed**: `Ledger` (consumed, record shape changed). `Git` is **not**
  consumed: the revision and the dirty flag are host facts read once at the composition root, the way
  `DoctorHost`'s facts are, and they reach the ledger as data on the record.
- **Layer composition**: unchanged. `RunRecord` gains one optional field; no layer's type moves, and
  nothing new is provided. The composition root grows two host reads, which is where every other one
  already happens.

## Acceptance criteria

- [ ] A dispatch writes a row naming the short revision of the dispatcher that ran it.
- [ ] The revision is read from the repo enclosing the package, not from the served repo — the two
      being the same directory today must not be what makes the test pass.
- [ ] A dispatcher with uncommitted changes under its package directory writes a row that is
      distinguishable from a clean one.
- [ ] Uncommitted changes outside the package directory leave the row reading clean.
- [ ] Rows already on disk, which carry no such key, still decode and still render on `status`, and
      the schema version is unchanged.
- [ ] `status` shows the dispatcher for a row that has one and shows a row that has none as unknown.

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package.

Cover the decode direction against a real version-1 line with no dispatcher key, and the encode
direction for `none` — it must round-trip to **no key**, not to a null and not to an empty string.
