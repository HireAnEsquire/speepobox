# 08 — The in-hae tracer-bullet sequence (T1 → move bar)

Labels: `wayfinder:grilling`
Map: [MAP.md](MAP.md)
Blocked by: ~~03~~ (closed 2026-07-29), ~~04~~ (closed 2026-08-05), ~~05~~ (closed 2026-08-06),
~~06~~ (closed 2026-08-06), ~~11~~ (closed 2026-08-06) — **unblocked**
Assignee: claude (claimed 2026-08-06)
Status: closed (2026-08-06)

## Question

Produce the first of the destination's two sequences: the tracer bullets that take the package
from nothing to the move-out bar — **one-off dispatch on itself, plus feedback-resume**.

Each bullet is one branch/PR with a demonstrable tracer, in the style of ADR 0006's F1–F7.
Working hypothesis to be confirmed or restructured:

- **T1 skeleton** — layout, `package.json`, CLI entry, config module, `doctor`. Tracer: `doctor`
  green.
- **T2 data layer** — issue parsing/selection, ledger, status. Tracer: `status` renders real
  state.
- **T3 dispatch one-off** — clone, container lifecycle, setup hook, implement + review loop,
  push, draft PR, notify, locks/logs. Tracer: it dispatches a one-off task on itself. This is
  also the bake-off comparison point against the python port.
- **T4 resume** — re-dispatch a branch with feedback. Tracer: a PR iterated without manual work.

Settle: whether T1–T3 are built interactively (the TS tool can't dispatch itself yet) and T4+
dogfooded; where the config-format decision lands (map fog); which parts are deliberately
deferred past the move; and what the move-out checklist is.

Output: the sequence, plus tracer-bullet-sized issue files under
`docs/wayfinder/effect-agentbox/issues/` for at least T1.

## Carried in from ticket 04

- **Issue files are tracked**, at `docs/wayfinder/effect-agentbox/issues/`, not the gitignored
  `.agentbox/tasks/` path this ticket originally named. `run.sh --feature` takes a slash path as-is
  and rewrites `Status:` host-side, so no dispatcher change is needed and the agent cannot commit
  churn.
- **T1's tracer does double duty.** "`doctor` green" must be run under **plain node**, making it
  the strip-safety check that closes vitest's transform gap. Write it into the T1 issue that way.
- **Each issue must name its own verification commands** (typecheck + lint + tests). This is now
  load-bearing, not cosmetic: `pre-commit` on the package dir passes while checking nothing, and
  both prompts have been given a line that defers to spec-named commands. An issue that omits them
  hands the agent a false green.
- Toolchain fixed by 04: npm, node 26, vitest + `@effect/vitest`. Lint/format settled by ticket 11 —
  **`oxlint` + `oxfmt`, both pinned exact, `typeAware` off**, two standalone configs in the package
  dir (nothing above it to inherit from — hae's oxc configs live in `client/`, not at the root).

## Carried in from ticket 06

Three concrete T1 obligations, all of them prerequisites for every later bullet:

- **`npm run verify`** — one script: typecheck-with-Effect-diagnostics + lint + tests. This is the
  gate; nothing else expresses it.
- **An issue template for this package with its Verify section pre-filled** with `npm run verify`
  — 06's fix for 04's "nothing forces an issue to name the commands", and for the false green
  where `pre-commit` on the package dir passes while checking nothing.
- **`<package>/AGENTS.md`**, authored via `/writing-for-agents`, carrying only what no diagnostic
  can catch.

Pinned toolchain for T1's `package.json`: `effect@3.22.1` **exact**, `typescript@7`,
`@effect/tsgo`, plus 04's npm / node 26 / vitest + `@effect/vitest`.

Each Effect bullet's spec must **name the tag and paste the layer composition** the bullet ends at,
written out verbatim for the agent to **copy rather than derive** — layer wiring is the top failure
mode for agent-written Effect (06).

> **Amended 2026-08-10, twice.** The original sentence sourced that composition from
> `effect-language-service layerinfo` and opened "sizing is unchanged". Both were wrong.
>
> `layerinfo` is an **editor-only language-service feature with no CLI** — `effect-tsgo`'s
> subcommands are `patch`, `unpatch`, `get-exe-path`, `diagnostics`, `setup`, `config`. T2's reviewer
> correctly reported twice that it could not produce the output, spending rounds on an impossible
> criterion. Paste the composition from the composition root (`src/app.ts`); **every acceptance
> criterion must name a command that runs inside the container.**
>
> "Sizing is unchanged" did not survive T3, which packed four services into one bullet, read for 12
> of its 28 minutes, committed nothing, and died on exhausted credits. §1 below split T3 once on the
> right principle and not deeply enough. The working guideline is now **one service per ticket**, with
> acceptance criteria in the high single digits — calibrated against T2 (11 criteria, landed) and T3
> (14, failed), so treat it as an upper bound on tickets we already know were too big, not a measured
> optimum.

## Carried in from ticket 11

- **04's pre-commit `exclude:` edit was never made** and is still owed — the top-level `exclude:`
  does not name the package dir, so hae's *generic* hooks (`trailing-whitespace`, `check-json`,
  `end-of-file-fixer`) still reach into the package dir. Unlike
  07's rename touch-points, this one did **not** collapse to nothing. It belongs in T1.
- `@effect/tsgo` belongs in the **typecheck** path, not the lint path — Effect's own repo does exactly
  this, confirming 06's declined bridge. `npm run verify` therefore runs typecheck, lint, and tests as
  three distinct steps.

## Answer

Resolved 2026-08-06 by grilling. The working hypothesis's four bullets become **six**, the deferral
list is explicit, and the bake-off is **decoupled from move-out**.

### The sequence

| # | Bullet | Tracer |
| --- | --- | --- |
| **T1** | skeleton — layout, `package.json`, tsconfig, oxc configs, CLI entry, config module, `doctor` | `doctor` green **under plain `node`** |
| **T2** | ledger + status | `status` renders real state |
| **T3** | scoped shell — `RunLock` → checkout → `Sandbox` → setup hook, reconciler | all three released on Ctrl-C, on SIGHUP, and on success |
| **T4** | agent loop + land — `AgentCli`, review loop, FF fetch-back, push, `Forge` draft PR, notify, ledger row | dispatches a one-off task on itself |
| **T5** | `--dry-run` as a layer swap | same guards, same derivation, zero mutations, one code path |
| ← | **bake-off scored** (see below) | |
| **T6** | feedback-resume | a PR iterated with no manual step |
| ← | **move-out bar met** | |

> **Re-sliced 2026-08-10.** T1 and T2 are built and merged. **T3–T6 above are no longer the live
> tickets** — the single `/to-tickets` pass this ticket's closing section calls for turned them into
> fifteen, sized against each other under the skill's own rules: no surface without a consumer in the
> same ticket, each slice demoable on its own, each sized for one fresh context window (which means
> the later ones are narrower, since a fresh dispatch at T17 reads a much bigger package than one at
> T4).
>
> **Every `T`-number in the prose of this ticket refers to the six bullets above, not to the live
> tickets.** The mapping:
>
> | Bullet | Live tickets | Tracer lands on |
> | --- | --- | --- |
> | **T3** scoped shell | [T3 guards](issues/T3-dispatch-guards.md) · [T4 `RunLock`](issues/T4-run-lock.md) · [T5 `Git`/checkout](issues/T5-git-checkout.md) · [T6 `Sandbox`](issues/T6-sandbox.md) · [T7 setup hook](issues/T7-setup-hook.md) · [T19 signal matrix](issues/T19-signal-matrix.md) · [T20 atomic lock claim](issues/T20-atomic-lock-claim.md) · [T21 lock eviction](issues/T21-serialize-lock-eviction.md) · [T8 reconciler](issues/T8-reconciler.md) | **T7** |
> | **T4** agent loop + land | [T9 implement pass](issues/T9-agent-implement-pass.md) · [T22 sandbox-gone from the daemon](issues/T22-sandbox-gone-from-the-daemon.md) · [T23 one credential source](issues/T23-one-credential-source.md) · [T10 review loop](issues/T10-review-loop.md) · [T11 land + push](issues/T11-land-push.md) · [T12 `Forge` + PR](issues/T12-forge-pr.md) · [T13 `Notifier`](issues/T13-notifier.md) · [T14 `PromptSource`](issues/T14-prompt-source.md) | **T12** |
> | **T5** `--dry-run` | [T15 `--dry-run`](issues/T15-dry-run.md) | **T15** |
> | **T6** feedback-resume | [T16 resume](issues/T16-resume.md) · [T17 `--feedback`](issues/T17-feedback.md) | **T17** |
>
> Blocking is a chain through T3→T12 with two forks — T8 runs beside T7, and T16 runs beside
> T13/T14 — then T13→T14→T15, because each new tag mutates `AppLive` and every ticket pastes the
> composition it must copy rather than derive.
>
> Two scope calls made in the same pass: **`PromptSource` is built pre-move** (T14), because once the
> tool dispatches its own issues *it* is the client, and the `project-context.md` fragment is what
> makes a self-dispatch produce useful work. **`--feedback-edit` is deferred** to ticket 09 — TTY-only,
> unexercisable by an AFK dispatch, and absent from the move-out bar.

### 1. T3 is split (Q1)

The hypothesis packed 03's slice #4 (`run_task`, 618 lines) plus land (64) plus `claude_pass` (41)
into one bullet — 4–6× the next biggest, spanning lock, checkout, sandbox, agent, and forge.

06's "sizing unchanged" ruling does **not** cover this. That ruling was about splitting *within* one
Effect concern, where extra seams are the cost agents pay. This split runs along a boundary that
already exists in the design: **T3 ends where the `Scope` is fully acquired.**

- **T3** is Claim 1's evidence, isolated and provable without any agent involvement — the exact leak
  `run.sh:1024-1027` documents (macOS bash 3.2 not firing EXIT traps for a backgrounded function's
  subshell) becomes structurally impossible. It also picks up the reconciler, since 05 puts stale-lock
  reclamation inside `RunLock` acquisition rather than beside it.
- **T4** is the user-visible dispatch.

Numbered flat (T3/T4, not T3a/T3b): these are two independently landable tracers, not one deliverable
split across two PRs.

Cost accepted: T3's tracer is not user-visible work. Benefit: the highest-risk 618 lines land as two
reviewable diffs, and if the agent-loop half stalls, the Claim-1 proof is already merged.

### 2. Every bullet is AFK-dispatched from T1 (Q2)

The hypothesis's "T1–T3 built interactively because the TS tool can't dispatch itself yet" conflated
two dispatchers. **hae's bash agentbox can dispatch TS-port work from T1 onward** — 05 Q19 is explicit:
*"hae dispatching TS-port work through bash agentbox is ordinary usage, and agentbox knows nothing
about what it is building."* Only *self*-dispatch is gated, and that is T4's tracer.

The deciding argument is 06's tripwire: *">half of the first ~8 issues needing ≥2 Effect-error
redispatches"* escalates and surfaces a decision the user makes. **A redispatch count only exists if
the issues are AFK-dispatched.** Hand-write T1–T3 and the tripwire measures nothing, and the map's
central bet — that agents writing Effect is the top cost — goes untested until backing out is
expensive.

So the interactive/dogfood boundary is **T5→T6**, not T3→T4: from T6 the TS tool re-dispatches its own
issues.

**Two carve-outs stay hand-written**, pre-seeded on T1's branch before dispatch:

- **`AGENTS.md`** — 06 requires `/writing-for-agents` and "only what no diagnostic can
  catch". That is judgment about what agents get wrong, written *before* there is evidence. T2+ amend
  it as tripwire data arrives.
- **The two hae-side edits** — 04's generic prompt line, and the pre-commit `exclude:` edit that
  ticket 11 discovered was never made. Both touch hae's shared config; neither should arrive inside an
  agent's diff.

### 3. `IssueStore` leaves the sequence entirely (Q3)

**Nothing before the move-out bar reads an issue file.** One-off dispatch is positional `<spec>` +
`--branch` (03 §1.2); feedback-resume is `--resume` + feedback text. `IssueStore` — parse / select /
set-status, 03's slice #1 at ~520 lines and ~40% of tasklib's existing tests — exists only to serve
**feature-mode**, which is the first item in ticket 09.

So **T2 is `Ledger` + `status` only**:

- `Ledger` is load-bearing for T6 — resume recovers mode and base through `resolve_resume` and the
  `--base` default chain, so 05's tagged-union record must exist before resume does.
- `status` is the tracer, and is one of the three read-only commands that must work when the thing they
  inspect is broken (03 §1.1).
- Dispatching TS-port work still uses `--feature`, but that is **bash** agentbox reading the issue
  files — unaffected.

### 4. Deliberately deferred past the move

| Deferred to ticket 09 | Why it waits |
| --- | --- |
| `IssueStore` + feature-mode loop | no pre-move consumer |
| Picker (`tasklib.py:1084-2222`, 1139 lines) | 03 ranks it last; roadmap F5 rewrites it anyway. Its *design* is de-risked early by ticket **13** |
| `gc` command | the **reconciler** is not deferred — 05 puts it in dispatch preflight, so it lands in T3. Only `gc`'s aggressive/interactive path waits |
| `init`, the clone-run shim, adopter distribution | ticket 01's shim only matters once the repo exists |
| `--hard-reset` | destructive, TTY-confirmed, unused by self-dispatch |

**Not deferred despite being tempting:** `Notifier`. Trivially fakeable, already has a tag in 05, and
the entire point of AFK dispatch is finding out that it finished.

**`--dry-run` moved back in** as T5. It was deferred on move-out grounds, which held only while the
bake-off gated move-out; once the two were decoupled (Q4) the reasoning no longer applied — see below.

### 5. The bake-off: decoupled from move-out, scored at T5 (Q4)

**Decoupled by user ruling.** Move-out to `speepobox/` may happen before the bake-off is ready, or
after. Neither gates the other.

**The moment is: our T5 complete AND Bessemer at F3 — whichever lands later.** (Post-re-slice, "our
T5 complete" is live ticket **[T15](issues/T15-dry-run.md)** landed, and "our T4" below is
**[T12](issues/T12-forge-pr.md)**.) Bessemer is independent
and unplanned here, so the TS side may idle at T5 waiting, or proceed to T6 and move out with the
bake-off still pending.

Why T5, from the roadmap rather than from preference:

- **Only one exact parity point exists.** Bessemer's **F3 dispatch-one-off** — *"clone, container
  lifecycle, setup hook, implement + review loop, push, draft PR"* — is our **T4**, bullet for bullet.
  Bessemer's **F4 is "feature-mode-*and*-resume"**, one bullet, so the moment our T6 lands, the
  comparable Bessemer bullet also contains feature-mode, which we pushed to 09. Past T4 the sequences
  never line up again.
- **Claim 1 completes exactly at T4, not T3.** T3 holds lock + checkout + sandbox, but 05 makes the
  checkout release **derived** from whether the FF fetch-back succeeded — and the fetch-back is the
  land step. Before T4, the most interesting finalizer in the design does not exist.
- **Claim 2's best exhibit is T5.** 05 calls `--dry-run`-as-layer-swap *"the cleanest demonstration of
  Claim 2 in the whole port"* — the same dispatch effect against a layer whose mutating services are
  recording no-ops, deleting 78 lines of drift-prone re-derivation (`run.sh:1647-1724`). Cheap after
  T4, impossible before it. It is its own bullet for the same sizing reason T3 was split, and because
  the bake-off's key exhibit should be a single diff someone can point at.
- **The third axis cannot complete pre-move at any timing.** 06's tripwire needs ~8 issues; T1–T6 is
  six. So agent productivity must not influence the *timing* — record the running redispatch count and
  let it resolve in 09. **The re-slice changes this input, not the ruling**: seventeen live tickets
  clears the ~8 threshold, so the tripwire may well resolve pre-move. It still must not influence the
  bake-off's timing, and the count is still carried into 09.

**Fairness note, for the scoring write-up:** Bessemer's dry-run is F5, so at scoring time we have T5
and they do not. This is not cheating — Claim 2 is a claim about *structure*, and the exhibit ("78
duplicated lines became a layer swap") stands alone. But the bake-off compares **T1–T5 against
F1–F3**, and that asymmetry is recorded rather than hidden.

**Criteria are not widened.** The map's ruling stands: scored on guaranteed cleanup under failure and
dispatch-core test quality, *not* ergonomics or line count. A bake-off whose criteria grow to cover
whatever the loser is missing stops being falsifiable.

**One asymmetry is reported alongside, never scored.** The picker is absent on both sides at T5, but
the *route* to it differs by language: Bessemer's handoff commits to *"aim for clack-style polish; F5
evaluates a stdlib-ANSI prompts module that may retire gum"* — hand-rolling an approximation under its
stdlib-first posture — while the TS side takes clack directly. Same target, very different cost, and
the difference follows from the language choice rather than from either team's skill. Ticket **13** is
what that report points at. Moving the bake-off later to catch the real pickers does not work: they are
F5 and 09 respectively, both well past move-out, by which point the sequences have diverged past
comparability.

### 6. Move-out checklist

The bar is unchanged — one-off dispatch **plus** feedback-resume — but it is now stated as gates:

1. **T4 tracer green** — the TS tool dispatches a one-off task on itself and opens a PR. Post-re-slice
   this is live ticket **[T12](issues/T12-forge-pr.md)**.
2. **T6 tracer green** — a PR iterated through `--resume --feedback` with no manual step.
   Post-re-slice this is live ticket **[T17](issues/T17-feedback.md)**.
3. **`npm run verify` green**, and **`doctor` green under plain `node`**. T1's tracer re-run as a gate,
   not a new check: it is ticket 01's type-stripping path, the property the entire clone-run shim rests
   on.
4. **Tripwire count recorded** — the number of issues among T1–T17 that needed ≥2 Effect-error
   redispatches. It will not have reached 06's ~8-issue threshold; record it anyway and carry it into
   09, because it is the only quantitative result this experiment produces.
5. **Extraction rehearsed** — `git filter-repo` multi-path, **copy not move**, dry-run first, carrying:
   `speepobox/`, this map and its tickets, `docs/adr/0004`–`0006`, and `run.sh` + `tasklib.py` as the
   parity oracle. Ticketed 2026-08-18 as **[T34](issues/T34-extraction-rehearsal.md)**, which corrects
   this carry list where it has gone stale (`0007` postdates it) and turns it into a manifest with an
   audit, because the path nobody thought of is what a rehearsal is for.
6. **Runtime-root default still separated** (05 Q19) — the committed config points the TS tool at its
   own root, not `.agentbox/`. Flipping it is a switchover step in 09, not a move-out step.

**The bake-off is not on this list.** If Bessemer wins it, whenever it is scored, this map's line of
work stops and 09 is abandoned — that is the honest exit and it is written down as one. But it does not
block extracting to `speepobox/`.

### 7. Config format — already closed, not fog

The ticket asked "where the config-format decision lands (map fog)". It landed in **05 Q4**: TOML via
`@effect/cli`'s `ConfigFile`, `.agentbox/config.toml` committed plus `.agentbox/config.local.toml`
gitignored, with ticket 01's pinned tool SHA in the committed layer. No fog remains; it is a T1
implementation detail.

### 8. New ticket graduated

**[13 — Prototype the clack picker](13-prototype-clack-picker.md)** (`wayfinder:prototype`, blocks
nothing, blocked by nothing). 05's clack ruling was decided from documentation rather than a running
prompt, and its load-bearing claim — that `autocomplete` closes 02's fuzzy gap outright — is unverified
on the tool's richest surface. Under the sequence above it would be tested in 09, after the move. The
prototype tests it now, and doubles as the UI exhibit for the bake-off write-up.

### Issue files

`docs/wayfinder/effect-agentbox/issues/` — [`TEMPLATE.md`](issues/TEMPLATE.md) (06's Verify-prefilled
template, which T1 commits into the package), [`T1-skeleton.md`](issues/T1-skeleton.md) and
[`T2-ledger-status.md`](issues/T2-ledger-status.md) as worked examples, and **T3–T17**, written in one
pass on 2026-08-10 (mapping table above). The oversized first attempt at the T3 bullet lives at
[`issues/superseded/scoped-shell.md`](issues/superseded/scoped-shell.md) — source material, deliberately
out of `load_issues`' reach, not a live ticket.

> **Amended 2026-08-10.** This section said T2–T6 were "written as each predecessor lands, so each
> one can carry what its predecessor actually built". The second half is a real benefit and T2's
> `## Comments` block is the proof. The first half is the defect: authoring one ticket at a time
> means **no ticket is ever sized against its siblings**, so "is this one bigger than the others?" is
> a question nobody is in a position to ask. T3 was the cost.
>
> The remaining bullets are re-sliced in **one `/to-tickets` pass over the whole scope**, which is
> what produces the blocking graph and a comparable set. Predecessor knowledge is carried by the
> landed ticket's `## Comments` section instead — written at close, read at slice time.
