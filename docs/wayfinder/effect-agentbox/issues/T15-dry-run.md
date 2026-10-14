# T15 — `--dry-run` as a layer swap

Status: Done
Type: AFK
Blocked by: T14

Sequence: [ticket 08](../08-in-hae-sequence.md), re-sliced 2026-08-10. This is 08's T5 bullet and the
**bake-off's key exhibit** — 05 calls `--dry-run`-as-layer-swap *"the cleanest demonstration of Claim
2 in the whole port"*.

**Tracer: same guards, same plan, zero state, one code path.** `--dry-run` runs the **same dispatch
effect** against a layer whose mutating services record instead of act. Every guard still runs and
still fails for real; afterwards there is no lock, no log, no container, no checkout, no branch
change, and no ledger row. It is TTY-independent.

## What to build

One layer, and nothing else. **If this ticket adds a branch on a dry-run flag inside a dispatch op,
it has failed** — that branch is exactly the 78 lines of re-derivation (`run.sh:1647-1724`) the swap
exists to delete, and it typechecks (`AGENTS.md`).

### 1. `AppDryRunLive`

The same expression as `AppLive`, differing only in which service layers are recording. That is the
shape `src/app.ts` already uses for `AppBaseLive`, which differs from `AppLive` in exactly one term —
follow it.

**Recording, not blindly no-op**: a recording service keeps its **read** operations real and records
its **mutations**. That is what makes the rehearsal honest.

| Service | In dry run |
| --- | --- |
| `Sandbox` | `run` / `remove` record; nothing reaches dockerd |
| `Git` | `revParse` real; `clone`, the fetch-back, and `push` record |
| `RunLock` | acquire/release record; **no PID file is written** |
| `Ledger` | `recent` and `lastBaseForBranch` real — the `--base` chain must still resolve; `append` records |
| `Forge` | `prView` real, so the existing-PR probe still answers; `prCreate` / `prEdit` record |
| `AgentCli` | every pass records; no agent runs |
| `Notifier` | records |
| `PromptSource` | **unchanged** — it is read-only, and swapping it would rehearse the wrong thing |

### 2. What the rehearsal proves, and what it does not

**Caveat to state in any write-up** (05 Q20): a recording layer rehearses *our* logic, not docker's.
A dry run still cannot prove `docker run` would have succeeded — exactly as today. The claim is about
structure: same guards, same derivation, same ordering, one code path.

### 3. Design rule 5, enforced

- **A fake-`Reporter` test asserts dry-run emits the same event-sequence shape as a real dispatch**
  (SPEC §11, design rule 5). Same ordering, same acquisition and release sequence, differing only in
  the recorded-vs-performed nature of the mutations
- **A grep ban keeps a second dispatch path from appearing.** Add it to `scripts/check-bans.ts`
  beside the existing four. The bans exist to be added while there is nothing to fix
- the recorded intent is rendered as the plan — T3's `DispatchPlan` value, unchanged and not
  re-derived

## Not in scope

Resume (T16) and `--feedback` (T17). `--hard-reset`, the picker, `gc`, `init`, feature mode, and
`IssueStore` stay deferred past the move.

## Read first

`src/app.ts` — the `AppLive` / `AppBaseLive` pair is the pattern this ticket repeats — plus
`scripts/check-bans.ts`, T3's plan derivation, and every service tag's interface. `AGENTS.md`
and **SPEC §5 (lines 250–277) and §11 (470–606)**, where design rule 5 lives — those ranges, not the
whole file. `run.sh:1647-1724` is the behaviour source, read as a reference document, and its
duplication is the thing being avoided rather than ported.

You need each tag's **interface**, not its live implementation. Read the tag declarations; skip the
`Live` layer bodies except where you are mirroring an operation's signature.

**Already on the branch — do not rewrite** T1–T14's modules; amend `AGENTS.md` only with a ruling you
had to discover. **Do not touch hae files.**

**Handed forward from T3's review** (recorded there as deliberately not-fixed, deferred to whichever
ticket inherits the block — this one): `renderPlan` shortens SHAs to a fixed 10 characters, where
bash uses `git rev-parse --short`, which honours `core.abbrev`. Cosmetic, and it only becomes visible
here, because this is the ticket whose whole output *is* that block. Match `core.abbrev` or record it
in SPEC §12 as an intentional divergence; do not leave it unstated.

## Effect wiring

- **Tags introduced**: none. Every recording implementation stands behind an existing tag.
- **Tags consumed**: all of them.
- **Layer composition**: a third composition joins `src/app.ts`, the same expression as `AppLive`
  with the mutating layers swapped. Copy this, do not derive it:

  ```ts
  export const AppDryRunLive: Layer.Layer<
    | AgentCli
    | PromptSource
    | Forge
    | Notifier
    | Sandbox
    | Git
    | RunLock
    | Ledger
    | AgentboxConfig
    | Reporter
    | NodeContext.NodeContext,
    ConfigError
  > = Layer.provideMerge(
    AgentCliRecordingLive,
    Layer.provideMerge(
      Layer.mergeAll(
        SandboxRecordingLive,
        GitRecordingLive,
        RunLockRecordingLive,
        ForgeRecordingLive,
        NotifierRecordingLive,
        PromptSourceLive,
      ),
      Layer.provideMerge(
        LedgerRecordingLive,
        Layer.provideMerge(AgentboxConfigLive, PlatformAndReporterLive),
      ),
    ),
  );
  ```

  **`AppLive` and `AppBaseLive` are byte-unchanged.** The entrypoint picks between `AppLive` and
  `AppDryRunLive` on the flag; that is the **only** place `--dry-run` is consulted.
- **Errors**: unchanged. Guards and preflight fail for real with their real typed errors — that is
  what makes it a rehearsal rather than a print-out.

## Checkpoint order

**This is the largest remaining ticket, and it is also the most checkpointable — take the
checkpoints.** Each recording layer is a new module plus its own test, standing behind a tag that
already exists, and nothing interlocks until `AppDryRunLive` composes them at the end. So:

1. one recording layer, its test, `npm run verify`, commit — then the next, and the next
2. `AppDryRunLive` and the entrypoint's flag, once every layer it names exists
3. the grep ban and the event-sequence-shape test last

A pass that writes all seven layers before running the gate has thrown away six checkpoints for
nothing. The order above is not a style preference; it is what makes a budget overrun cost one layer
instead of the ticket.

## Acceptance criteria

- [ ] `--dry-run` selects `AppDryRunLive` at the entrypoint and is consulted nowhere else; no
      dispatch op branches on it
- [ ] The dispatch effect invoked is the **same** effect a real run invokes, not a parallel one
- [ ] Every guard and preflight check still runs and still fails for real
- [ ] After a dry run there is no lock, log, container, checkout, branch change, or ledger row —
      asserted, not just intended
- [ ] Read operations stay real in the recording layers — the `--base` chain resolves and the
      existing-PR probe answers
- [ ] A fake-`Reporter` test asserts dry-run emits the same event-sequence shape as a real dispatch
- [ ] A grep ban in `scripts/check-bans.ts` fails if a second dispatch path appears
- [ ] `--dry-run` is TTY-independent
- [ ] `AppLive` and `AppBaseLive` are byte-unchanged; `AppDryRunLive` matches the composition above
      verbatim

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, grep bans, and tests. `pre-commit` is not a substitute
and does not check this package.

**Host-only**, run by the user before landing:

```
node src/bin.ts <spec> --branch <existing-branch> --dry-run
```

It prints the resolved plan and the intended mutations. Afterwards `docker ps -a` by our labels, the
runtime root's lock and checkout directories, and `runs.jsonl` must all be exactly as they were
before the command ran — the ledger file byte-identical.

**A dry run is not a way to run the tracer in the task container.** T3's preflight probes the docker
daemon, and criterion 3 keeps every guard failing for real, so a dry run stops at that probe here
exactly as a real dispatch does. Making it get past the probe would mean a guard that branches on the
flag — the shape this ticket exists to delete.
