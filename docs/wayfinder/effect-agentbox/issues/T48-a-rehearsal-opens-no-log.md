# T48 — A rehearsal opens no log

Status: Done (PR #8; `logPathOrNote` in `plan.ts` is the one reader helper the seven sites route
through, and `planFor`'s `keepsLog` defaults to `true` so a call site that omits it keeps its log)
Type: AFK
Blocked by: [T47](T47-each-run-writes-its-own-log.md) — both change `logPath` from opposite ends
(T47 its derivation, this one its type), and T47's invariant is what makes this the last leak to
close.

<!--
[Ticket 16](../16-what-the-tool-keeps-and-who-deletes-it.md)'s Q3, and it restores what SPEC's CLI
table always said: `--dry-run` is *"Zero state: no lock, log, container, checkout, branch creation,
or ledger append."* The implementation diverged, and T38 then recorded the divergence in §12 without
noticing §12 contradicted the CLI table two hundred lines earlier. SPEC is already corrected (commit
`3c90974`) — §12 now states the invariant, **the swap covers everything that writes**, instead of
maintaining a list of what leaks. This ticket is what makes that true.

Two alternatives were weighed and refused, so do not reach for either: a rehearsal log kept like any
other, and a marked `.dry.log`. `LedgerRecordingLive` swaps the ledger, so a rehearsal writes **no
row** — its run id keys nothing in `runs.jsonl`. Keeping the file gives the archive an orphan class
and every reader joining logs to runs learns the exception; marking it makes the orphans greppable
without making them fewer.
-->

## What to build

**`--dry-run` writes nothing to the runtime root at all — no file, and no `logs/` directory.**

### Where the decision is composed

In `src/dispatch/command.ts`, which `scripts/check-bans.ts` already permits to name the flag. The
plan a rehearsal carries says there is no log; **no dispatch op learns it is a rehearsal.**

`check-bans.ts` fails any file under `src/` outside the four permitted sites on a line matching
`/dry[\s_-]*run/i`, and its ban text names *"a `dryRun` field threaded down a signature"* explicitly.
So the field `DispatchRequest` gains must be named for a property of the run — whether it keeps a
record — and not for the flag that decided it. `planFor` takes that, and returns a `logPath` that is
absent on a rehearsal.

### `logPath` becomes optional, and seven readers move

`DispatchPlan.logPath` goes from `Schema.String` to an optional one; follow the precedent
`WorkOrder`'s `feedback` already sets in the same file.

The readers:

- `src/dispatch/render.ts:43` — the plan block's `log path` row. A rehearsal's block says there is no
  log rather than printing a path nothing will write. This row is the one a dispatcher reads to see
  what a real run would do, so the line has to be honest about the rehearsal.
- `src/notify/notifications.ts:44,46`
- `src/dispatch/run.ts:220`
- `src/agent/agent-cli.ts:308`, and **`:323` and `:324`**, which 16's resolution did not list.

The last five are unreachable under a rehearsal — `Ledger`, `Notifier`, and the agent pass are all
swapped — but they still have to typecheck without asserting the option. **No `Option.getOrThrow`,
and no empty-string default that reads like a path in a message a dispatcher will see.**

`openRunLog`'s call site (`run.ts:344`) becomes conditional: with no log path, the run's reporter is
the console (and, at `notify = steps`, the notifier) chain, unchanged.

### What is lost, and why that is fine

`MutationRecorded` — the one event a rehearsal produces — renders to the console at `app.ts:60`,
which is where bash puts a rehearsal's output too. A rehearsal leaves no artifact because it did
nothing, which is not the case ticket 16's keep-everything ruling exists to serve.

### Tests and docs

- `test/dry-run.test.ts` around lines 924 and 999 asserts the runtime root holds `["logs"]`. Both
  become `[]`, and the comment above the first — which pins the leak deliberately, *"so closing it is
  a red test rather than a discovery"* — is what this ticket is answering.
- The describe titled *"is accepted by the parser and read by nobody in the dispatch"* is no longer
  true as written: the flag is now also read where the plan is composed. Retitle it rather than
  delete it — the dispatch core still never learns a rehearsal is in progress, and that is the
  property worth keeping under test.
- **AGENTS.md's bullet** (*"What the swap cannot reach is the filesystem, and what that still costs
  is one log generation"*, around lines 84-89) states the opposite of what will be true. Replace it
  with the invariant SPEC §12 now carries. The two `rm -rf`s it goes on to describe are unaffected
  and stay.
- **SPEC needs no edit.** §5, §7's CLI table, and §12 already describe this.

## Effect wiring

No tag introduced or consumed, and §2's service list is untouched — 16 considered a `RunLog` tag and
obtained its prize without one. `DispatchRequest` gains a field, `planFor` gains an input, and the
layer composition at the entrypoint is unchanged.

## Acceptance criteria

- [ ] A rehearsal leaves the runtime root empty — no `logs/` directory, no file — reached through a
      real argv as well as through the dispatch.
- [ ] The plan block a rehearsal prints says there is no log, rather than printing a path nothing
      writes.
- [ ] A real run is unchanged: it opens its own log and every event still lands there.
- [ ] `MutationRecorded` still reaches the console on a rehearsal.
- [ ] No file under `src/` outside the four sites `check-bans.ts` permits names the flag, and the
      dispatch core never branches on whether this run is a rehearsal.
- [ ] The suite passes.

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package. `lint` is what runs `check-bans.ts`.
