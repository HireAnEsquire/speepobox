# 09 — The post-move sequence (parity → hae switchover → adopter install)

Labels: `wayfinder:grilling`
Map: [MAP.md](MAP.md)
Blocked by: ~~01~~ (closed 2026-07-29), ~~08~~ (closed 2026-08-06)
Assignee: Scott Bowles
Status: **closed 2026-08-06**

## Carried in from ticket 08

08 handed this ticket a concrete inbox rather than a hypothesis. Its deferral list is this sequence's
opening scope:

| Deferred here by 08 | Note |
| --- | --- |
| `IssueStore` (parse / select / set-status) + feature-mode loop | ~520 lines, 03's slice #1, ~40% of tasklib's existing tests. Cut from T2 because **nothing before the move-out bar reads an issue file** |
| Picker (1139 lines) | its *design* is de-risked ahead of time by ticket [13](13-prototype-clack-picker.md) — start from that prototype's verdict, not from scratch |
| `gc`'s aggressive/interactive path | the reconciler already landed in T3; only `gc` itself waits |
| `init`, the clone-run shim, adopter distribution | ticket 01's shim |
| `--hard-reset` | destructive, TTY-confirmed, unused by self-dispatch |

Also carried in:

- **`--dry-run` is already built** — 08 moved it forward to T5 as the bake-off's Claim-2 exhibit. Do
  not re-plan it; the hypothesis below is stale on this point.
- **The switchover flips the runtime-root default** (05 Q19) from the package's own root to
  `.agentbox/`. It is a config default, not a structural change, but it must appear in the switchover
  bullet.
- **The `bessemer` rename touch-points** (07): repo rename, `package.json` name + bin, and the shim URL
  repin in `.agentbox/config`. Conditional and post-bake-off.
- **The tripwire count is unresolved and inherited.** 06 needs ~8 issues; T1–T6 is six. 08 records the
  running count at move-out; this sequence is where it crosses the threshold and where the escalation,
  if any, fires.
- **The bake-off may still be pending** when this sequence starts — 08 decoupled it from move-out. If
  Bessemer wins it, this sequence is abandoned rather than completed.

## Question

Produce the second sequence: from "the package now lives in its own repo and can dispatch
itself" to the finish line — feature parity, hae switched over with the old `.agentbox` core
deleted, and an outside team able to install it. Mirrors F4–F7.

Working hypothesis, to be confirmed or restructured:

- **feature-mode** — multi-issue feature runs, selection loop, `Status:` writes, checklist.
- **picker / gc / dry-run** — including whether `@effect/cli` prompts carry the clack-polish
  requirement natively (map fog, informed by 02).
- **init + distribution** — scaffolding, `init --diff` adapter drift, templates, the shim, and
  whatever 01 settled as the distribution model. Adopter README and docs.
- **hae switchover** — the parallel-run acceptance gate (ADR 0006 defines one for the python
  port: read-only commands validated side-by-side any time; dispatch gate = one feature-mode
  multi-issue run, one one-off, one resume-with-feedback, one failure path handled correctly —
  outcome parity, not byte-identical logs). Decide whether the same gate applies, then install
  the shim + config + ported hae adapter and delete the old core.

Also settle: the bake-off resolution — what recorded outcome formally closes the TS-vs-python
question, given the comparison happens at T3 but the switchover happens here.

## Carried in from ticket 04

- **The move-out extraction is sketched**: `git filter-repo` multi-path (not `subtree split`, which
  takes one prefix), carrying the package, `docs/wayfinder/effect-agentbox/` including its issues,
  ADRs 0004/0005/0006, hae's sandboxing guide (not carried), and `run.sh`/`tasklib.py` as the
  **parity oracle** — parity work happens here, and the map fixes those two files as the behavior
  spec, so without them this sequence has no reference. Framed as **copy, not move**: hae keeps its
  originals and keeps running bash agentbox until the switchover step deletes its `.agentbox` core.
  Remaining fog for this ticket: **CI, release, and branch protection in the new repo**, and what
  the tool's own CI runs once it self-hosts.
- **The new repo becomes its own client.** Its setup is hardcoded first, hook-driven once the setup
  hook exists — which keeps `setup script v1/v2` out of scope (Phase C) unless this ticket
  deliberately pulls it forward. Note the two collapse here: post-move, the tool's own test command
  is both "the tool's tests" and "the client's tests."
- **Node ≥ 26 is a dispatching-host prerequisite, not a container one.** The tool runs on the host
  and `docker exec`s in, so an adopter's task container may contain no node at all. This matters
  for the adopter-install and README work in this sequence.
- hae's `implement-`/`review-`/`pr-prompt.md` do **not** travel — the tool ships its own
  package-default prompts inside the cloned tree (ticket 01).

## Carried in from ticket 06

- **The v4 migration is a bullet in this sequence.** 06 pinned `effect@3.22.1` exact and froze it
  for the whole incubation, on the grounds that incubation is the experiment testing agent
  productivity and the beta would confound it. The migration is deliberately deferred here, not
  avoided — size it, and decide where it sits relative to parity and switchover.
- **The bake-off has a second exit.** 06's tripwire (>half of the first ~8 issues needing ≥2
  Effect-error redispatches) can resolve the TS-vs-python question **in Bessemer's favour before
  T3 ever runs**. This ticket owns "what recorded outcome formally closes the bake-off", so it must
  cover that path too, not only the T3 comparison.

## Carried in from ticket 07

- **The repo is `HireAnEsquire/speepobox`**, package `@hireanesquire/speepobox`, bin `speepobox`.
  That fixes the concrete owner/name this sequence's CI, release, branch-protection, and adopter-README
  work has been waiting on.
- **A conditional rename to `bessemer` is a bullet in this sequence.** 07 settled that `bessemer` is
  the **bake-off prize**, not the python port's permanent name — so if TS wins, the python port is
  retired **first** and this repo renames into the vacated name. Deliberately held to the bake-off
  rather than pulled earlier, so the two never coexist. Size it and place it relative to the bake-off
  resolution this ticket already owns. Touch-points: GitHub repo rename (redirects keep existing
  remotes working), `package.json` name + bin, and a repin of the shim URL in `.agentbox/config`.
  Cheap **only while hae is the sole adopter** — which is this ticket's ordering constraint, since
  adopter-install lives here too: the rename should land before outside teams install, or the shim
  URL churns under them.

## Answer

Resolved 2026-08-06 by grilling (Q1–Q11).

### The premise that reshaped the sequence

**hae has no organic agentbox traffic.** The only workload is the user building bessemer. That
kills the "switch over early so hae's daily traffic exercises the tool" argument outright — there is
no daily traffic — and with it the idea of a soak period. It also removes the risk from switchover:
it is a config change for one person, not a production flip.

What survives is the thing that has nothing to do with traffic: for this entire sequence,
**bessemer's only client is bessemer**. hae is the one chance to point the tool at a client that
is not itself.

### Q1–Q2: switchover stays last, and hae is adopter #1

Switchover is **not** split-and-pulled-early. It stays at the end, mirroring Bessemer's F7 — but the
reason is not F7's. hae does **not** get a bespoke hand-ported adapter. hae installs bessemer the
way an outside team would: `init` scaffolds the config and adapter, and hae's `.agentbox` core is
deleted because `init`'s output replaced it.

This deletes a whole bespoke work item, and it makes `init` — the one deliverable with **no**
self-hosting exercise at all, since the tool's own repo is set up hardcoded first (04) — get proven
by the author's own repo before any outsider touches it. It also makes the destination honest:
"an outside team can install it" is demonstrated, not asserted.

What it gives up is the early second-client signal. Recovered by an **early throwaway probe**
(P1): a hand-written config pointed at hae, one real hae issue dispatched one-off, purely to
discover what is client-shaped that self-hosting never revealed. No runtime-root flip, no deletion,
findings feed `init`'s design, artifact discarded.

### Q3: the v4 migration is conditional, and the trigger is escalated, not auto-taken

Verified 2026-08-06: `effect` `latest` is still **3.22.1** (the newest 3.x — the frozen line is
genuinely frozen); v4 is still `beta`, at `4.0.0-beta.104` published that same day, cadence ~2/week.

The migration cannot be placed by taste — GA timing is not ours, and 06's refusal to build on a beta
still holds. But cost runs monotonically the wrong way: the codebase is at its **minimum** at
move-out (T1–T6 only), and every bullet here adds v3 code a later migration must carry.

**Rule:**

- If 4.0 is on `latest` at move-out → migrate as the **first** post-move bullet, before any parity
  work. Smallest codebase, and it re-runs 06's tripwire against v4's failure modes on six issues of
  code rather than the whole tool.
- If it is not GA (the likely case) → it does **not** enter this sequence. Follow-on issue in the
  new repo, after the finish line. Parity, switchover, and adopter install do not wait on someone
  else's release train.

Migrating *mid*-sequence is explicitly ruled out — larger codebase than P1, and it stalls parity on
a version bump.

**The GA check is surfaced to the user as a decision, never checked-and-passed silently.** Same
shape as 06's tripwire. Adopters are insulated either way: 01's shim pins a SHA.

### Q4: CI yes, release nothing, agent does not merge

**CI: one workflow running `npm run verify` on PRs; branch protection on default requiring it.**
The case is specific to this repo: every line is written by an AFK agent that runs verify *inside
its own container, on its own say-so*, then opens the PR. CI is the only gate the dispatching agent
cannot skip, misreport, or have silently pass on a broken environment — the failure 04 already
caught once in hae (`pre-commit` passing while checking nothing). Cost is one file, since 06
collapsed the gate to a single command. hae itself runs one workflow; this matches precedent rather
than importing ceremony.

**Release: nothing to build.** 01's shim shallow-clones a SHA pinned in `.agentbox/config` and never
resolves a version from the registry. No publish, no semver, no tags, no changelog gate, no release
workflow. "Set up releases in the new repo" is the reflex and here it is dead weight. What replaces
it is a one-line **repin discipline**: a SHA is fit to pin when it is on default with CI green.

**Branch protection**: require the CI check, and no direct pushes to default.

**The agent does not merge its own PRs.** Human merge is terminal. This bounds what "agentbox builds
agentbox" means — dispatch, build, verify, PR; never merge. The loop is closed by the user,
deliberately.

### Q5: the seven bullets

| # | Bullet | Notes |
| --- | --- | --- |
| **P1** | Repo bootstrap + hae probe | CI workflow, branch protection, repin discipline, plus the throwaway probe. Hand-done — mirrors 08's hand-seeded `AGENTS.md` |
| **P2** | `IssueStore` + feature-mode | 03's slice #1, ~520 lines, ~40% of tasklib's tests. Deferred here by 08. **06's tripwire count reaches issue 7 here** |
| **P3** | Picker | 1139 lines, the richest surface. Starts from ticket [13](13-prototype-clack-picker.md)'s verdict, not from scratch. Needs `IssueStore`, so follows P2. **Tripwire count completes here (issue 8)** |
| **P4** | `gc` force paths + `--hard-reset` | reconciler landed at T3; this is the interactive/aggressive surface plus the destructive TTY-confirmed path |
| **P5** | `init` + templates + `init --diff` | adapter-drift detection. Informed by P1's probe findings |
| **P6** | Shim + adopter distribution + docs | 01's clone-run shim, adopter README. Node ≥ 26 documented as a **dispatching-host** prerequisite — an adopter's task container may contain no node at all (04) |
| **P7** | hae switchover | hae runs `init` as adopter #1; atomic flip-and-delete. Finish line |

P5 and P6 are deliberately **split** (Bessemer's F6 merges them): the seam between "scaffolding
works" and "a stranger can install it" is exactly where the bugs are. P4 is deliberately **separate**
from P3: pairing them would make P3 the sequence's monster bullet.

Two **acts, not bullets**: the bake-off resolution and the rename (**before P6** — 07's constraint
that the rename precede outside installs, or the shim URL churns under them).

**Both acts moved on 2026-08-20.** The bake-off closed for speepobox —
[ADR 0008](../../adr/0008-agentbox-port-bakeoff-closes-for-speepobox.md), decided by the user rather
than scored against Q6's two claims. So the abandon clause this paragraph used to carry — *if
Bessemer wins the sequence is abandoned outright* — is **void**, and P1–P7 below are unconditional.
The rename stops being conditional on the bake-off and becomes simply due before P6, with its target
still undecided: speepobox may take the `bessemer` name under Q10's ordering, or keep its own.

**P2 carries a guard bash never had: a selection the dispatcher did not name is a proposal, not an
instruction.** Recorded 2026-08-19. `--feature` without `--issues` selects *every* ready issue in the
folder — all AFK, not-yet-Done issues whose blockers are Done-or-also-selected, as a fixed point
(`tasklib.py:288-302`).
That is right for a folder that *is* one feature, and wrong for a folder holding a long programme
worked one ticket per branch, where it resolves to "everything not yet finished" on whatever branch
was named. Observed against this very folder on 2026-08-18: five issues selected, fourteen steps, on
the branch for one of them, reaching T34's implement pass before a human killed it — and two of the
five already had their own branches and open PRs, so a third branch had begun editing both. The
serious failure is that cross-branch collision, not the wasted hours: two branches implementing one
ticket produce two diffs nobody asked to reconcile, and the issue's `Status:` line is rewritten by
whichever run lands last. Nothing hid it — `run.sh` prints the resolved list in its first status line.
Nothing *stopped* it. So P2 ships two units beside the selection loop: **(1)** a wide selection the
dispatcher did not name has to be assented to, and **(2)** an issue whose newest ledger row names a
different branch is refused, with `--issues` as the override. The default itself does not change.

**Unit 1 is a refusal here, not a prompt** — the one thing the bash ticket left open, settled by what
the package actually is. There is no TTY interaction anywhere in `src/`: no `isTTY`, no stdin read, no
`@clack`. `guards.ts` is already a module of exactly this shape — six refusals behind one
`GuardRefused`, each holding nothing, which is the invariant the whole `Scope` design rests on
(SPEC §4, matrix row 1) — so the wide selection is a seventh guard rather than the package's first
interactive surface. The interactive surface is **P3**, and a prompt built at P2 would either be
rebuilt there or land in the wrong bullet. If P3's picker makes selection interactive, unit 1 can
soften then; P2 ships the refusal first because a refusal an adopter can override with `--issues` is
strictly safer than a prompt a backgrounded dispatch would hang on.
<!-- T86: unit 1 softened on a terminal — the picker asks for the missing --issues; off a terminal, or with --no-input, the refusal is unchanged. -->

**Unit 2 needs no new data.** `RunRecord` already carries `branch` and the per-issue outcomes on its
`Feature` arm (`src/ledger/record.ts`), so the query is a sibling of `lastBaseForBranch` on
`LedgerShape` (`src/ledger/ledger.ts:62-74`). The ledger is derived state, so a missing or corrupt
`runs.jsonl` disables unit 2 silently rather than failing a dispatch — the rule `lastBaseForBranch`
already follows, and the same one bash lands on (`run.sh:838-839`).

This is recorded here and not as a pre-move ticket because there is nothing yet to guard: `Feature`
appears in the port only in the ledger schema and the `status` renderer (`src/status/render.ts:78`),
where it exists to read legacy bash rows. The guard has no subject until P2 builds the selection it
guards. hae's bash dispatcher keeps the defect deliberately — a handful of dispatches remain before
move-out, and passing `--issues` on each is the same consent the guard would enforce.

**[Ticket 15](15-a-dispatch-names-the-work-it-will-do.md) closed 2026-08-21 and amends both units —
read it before building either.** It took the floor these two units set and restated the whole thing
as one rule about inference: *the dispatcher may replay a work set it recorded and execute one the
command named, never compute one the command did not name.* Unit 1's refusal-not-prompt ruling
survives untouched, on the grounds it was already settled on (`src/` has no TTY surface until P3).
What changes:

- **Unit 1 gains a spelling.** The wide selection does not merely have to be assented to, it has to
  be **named**: `--feature` without `--issues` refuses, and the wide form is `--issues all`. A named
  predicate counts as named, so `all` is legal — with its cost stated rather than argued away, since
  it consents to wideness and not to contents, and the 08-18 run would have been legal under it.
- **Unit 2 splits into two witnesses**, because it collided with 14's *the ledger may be used as a
  hint, never as truth*. **Landed elsewhere** — some other ref says `Status: Done` — is answered by
  14's ref scan and is a hard refusal. **In-progress elsewhere** — the 08-18 case, `Status:` not
  `Done` anywhere — has no git witness at all, so the ledger answers it as a hint: refuse when the
  row exists, silent when it does not. That keeps 14 intact, because this guard decides only whether
  a run is *wasted*, never correctness.
- **`--issues all` overrides neither check.** Only enumerating does.
- **The second incident this section did not carry is fixed by the rule itself.** On 2026-08-19
  `--resume speepobox-t37 --feedback "…"` was issued intending feedback-only and ran a two-issue
  feature run, because `--resume` recovers `task_dir` from the ledger row (`run.sh:18`) and rescanned
  the folder it named. The recorded row is `issues={"37": "approved"}` — so replaying the recorded
  set, rather than rescanning the folder, finds nothing recoverable and correctly yields a
  feedback-only run. No flag was added.
- **Guards split into two phases by what they ask**, which is also how the map's
  `--base`-before-`git fetch` fog item closed: local ref/host facts and no repo content pre-fetch;
  then the fetch; then one authoritative `BASE_SHA`, `resolveMergeBase`, and **all issue-set
  expansion and validation** post-fetch against the fork commit, read with `cat-file` so no working
  tree is needed. Nothing is validated twice, `all` never expands against a stale tree, and row 1
  holds — a fetch acquires nothing. **Size this as new capability, not as a reordering**: the port
  has never fetched origin, the `Git` tag has no operation for it, and `resolveBaseSha` currently
  refuses with *"fetch it first"* — advice that stops being true once the tool does it. A `Git`
  operation, a §2 entry, and that message are all in scope here.
- **`/feature-issues` mounts from inside the checkout**, not from the host path bash uses, so the
  gate and the agent read the same tree. Free, since the port already requires tracked issue folders.
  `/spec.md` stays host-mounted: a spec is inert and is a work order, not repo state.

**P1 also owes a guard the whole self-hosting stretch depends on: a dispatch runs a dispatcher no
older than the one on the base it targets, or it refuses.** During P2–P6 the tool dispatches itself
out of its own repo, so *which revision of the dispatcher runs* is decided by whichever branch the
dev has checked out — a fact about the checkout, not about the dispatch. Adopters are immune from P6
onward, because 01's shim pins a SHA; the tool's own repo is not, for exactly the five bullets where
every ticket stacks on the last.

Observed in bash on 2026-08-17, dispatching T31 with `--base speepobox-t28`. That base forks from
`cc0db0202a`, three days before `81c3bb31ed` landed the issue-state-lives-on-the-branch change, so
the run executed the *pre*-change dispatcher: issue state read from the host working tree, `Status:`
stamped host-side, no status commit on the branch. It also ran without the ahead-is-not-diverged
cleanup fix, which postdates the same fork point. Two mechanisms silently absent from one run, and
the console said nothing about either. The divergence was found days later by reading commit dates.
That evidence is what makes this a **refusal rather than a warning** — unlike the image-staleness
warning beside it, this one cannot be shrugged off and corrected afterwards, because the run silently
had different semantics. Stacking is not the exotic case here; it is the intended workflow, and it is
precisely when the dev is sitting *on* the parent branch whose tree is behind.

The check is **ancestry, not equality**. Uncommitted local edits to the tool's own source are the
normal state of a repo that is building itself and must stay silent; what is refused is a `HEAD`
missing commits the base already has.

**One clause of bash's ruling does not port, and the divergence is worth taking.** bash refuses by
printing the command to run and exiting — *the check may never repair itself* — because bash reads a
script incrementally by byte offset, so a `git checkout` issued from inside a running `run.sh`
mutates the file underneath the interpreter mid-execution. Node has no such constraint. Whether the
port offers to repair rather than instruct is P1's call; the refusal-not-warning half is not.

Two notes for whoever builds it. It belongs in `dispatch/preflight.ts` rather than `guards.ts`: it is
a fact about host fitness, like the authenticated-`gh` refusal already there, not a fact about the
run. And it wants a ledger field bash already has and the port does not — bash records `dispatcher`
(the short rev, plus `+` when the tracked dispatcher directory was dirty) and `dispatcher_override`
for a forced dispatch. Adding it is a field every reader can be absent, so by T31's rule it stays on
record version 1 (`src/ledger/record.ts:30`) rather than bumping.

### Q6: ADR 0008 in hae closes the bake-off

> **Landed 2026-08-20 as
> [ADR 0008](../../adr/0008-agentbox-port-bakeoff-closes-for-speepobox.md), by a third exit this
> section did not enumerate.** Q6 planned for two — scored against Claims 1 and 2, or closed early
> by 06's tripwire in Bessemer's favour. What happened is neither: the user closed it for speepobox
> on preference, with **neither claim ever scored** and the identical kill list never run against
> both ports. Q6's governing rule still did its job — the ADR says that plainly instead of
> presenting a comparison that did not happen. Everything below is the standard Q6 held the ADR to,
> and the parts about capturing evidence at each milestone are now history rather than instruction.

**Form:** `docs/adr/0008-*.md` in **hae** — not either port's repo. hae is the shared parent and the
shared client, and where 0006 (the decision being reversed) and 0007 (the port ADR) live. A
winner's-repo ADR is a self-assessment; the loser's repo gets an obituary nobody reads.

**Content:** the two claims 08 fixed — Claim 1 (guaranteed cleanup under failure) and Claim 2
(dispatch-core test quality) — scored with the captured evidence, the UI-cost asymmetry **reported
and explicitly marked not-scored**, and the retirement decision as a named consequence.

**Evidence is captured at each port's own milestone, not reconstructed at comparison time.** 08
scores at "T5 AND Bessemer F3, whichever is later", so one port finishes first and sits. Without
capture-at-the-time its evidence is stale, re-derived, or gone by comparison day, and the bake-off
quietly becomes a vibe check. Each port commits two artifacts at its own milestone:

1. **Failure-injection matrix** — the *same* kill list against both (Ctrl-C once, Ctrl-C twice,
   SIGHUP, `kill -9`, agent-CLI crash mid-run), each asserting no leaked container, lock, or
   checkout. Claim 1's entire evidence, meaningful only if the matrix is identical.
2. **Dispatch-core test inventory** — what is covered, and what is provable only because of the
   architecture (Layer-faked failure paths for TS; whatever Bessemer's subprocess mocks reach).

**Second exit recorded in the same ADR.** If 06's tripwire fires first and resolves it in Bessemer's
favour, ADR 0008 says exactly that: closed on the agent-productivity axis, Claims 1 and 2 never
scored. Not dressed up as a comparison that did not happen.

**Adopters:** Bessemer has **no current outside adopters** — confirmed *future* ones, none deployed.
So there is no migration cost on the scoreboard. What there is instead is a commitment: the bake-off
decides what those waiting teams are eventually handed. Recorded as a consequence, not a score.

**Retire ≠ delete.** The loser's repo is kept as a cold fallback; retirement means stop investing.
This is the standing escape hatch that survives even after the tripwire's own options narrow (Q9).

### Q7: ADR 0006's parallel-run gate applies, with three additions

Adopted as written — read-only commands side-by-side any time; dispatch gate = one feature-mode
multi-issue run, one one-off, one resume-with-feedback, one failure path handled correctly; outcome
parity, not byte-identical logs. The four dispatch runs are **manufactured** (real hae work chosen
by the user; the failure path induced deliberately), because there is no organic traffic to wait for.

Three additions it does not survive contact without:

1. **The gate runs with runtime roots still separate.** 05 Q19 flips the root default to
   `.agentbox/` at switchover — but bash agentbox *is* `.agentbox/`. Flipping before the gate
   reintroduces the exact two-tools-one-lock-directory data race Q19 exists to prevent, at the worst
   possible moment. So the gate runs with roots split, and **the flip, the legacy-adapter deletion,
   and the bash core deletion are one atomic commit** at the end of P7. There is never a moment when
   both are live on the same root.
2. **Read-only side-by-side works through the legacy import adapter — that is what it is for.**
   Split roots mean split ledgers, so `status` comparison would otherwise compare two different
   worlds. 05's tolerant legacy import lets bessemer read bash's `.agentbox/runs.jsonl` while
   writing its own elsewhere. This fixes the adapter's deletion point precisely: **after** the gate
   passes, not before.
3. **An expected-divergence list, written before the gate runs.** "Outcome parity" is only testable
   if the intentional differences are named in advance, or the first one found reads as a failure:
   - SIGHUP now tears down (bash leaks a container silently) — 05
   - ownership by label, not the `agentbox-` name prefix — 05
   - ledger schema is greenfield, not comparable row-for-row — 05
   - `--dry-run` is a layer swap, not a parallel code path — 05
   - ~~retry lives in the dispatch core, not `AgentCli` — 05~~ **no longer a divergence**: bash
     agentbox removed retry on 2026-08-10 and the port follows (05 Q16R). Neither side retries, so
     the gate expects none
   - **prompts differ**: hae's `implement-`/`review-`/`pr-prompt.md` do not travel; the tool ships
     package defaults — 04

   The last one is load-bearing: different prompts mean different agent output, so outcome parity on
   a dispatch run **cannot** mean the same diff. It can only mean same terminal state, same ledger
   outcome, same resources released, PR opened. Unstated, the gate is unfalsifiable.

### Q8: parity is a written checklist, not a feeling

The destination names feature parity as a finish-line condition but nothing defined it, and both P6
and P7 depend on it being true. "Parity with the oracle" is already false by design: 05 diverged
deliberately in six places, and hae's `Dockerfile` / `build-image.sh` / `setup-db.sh` are adapter
template reference material, never core. Left undefined, parity gets declared by feel the moment
someone wants to start P7.

**Parity is a checklist derived from 03's behavior inventory**, mirroring 08's six-gate move-out
checklist. Every inventory item carries exactly one mark:

- **ported** — behavior reproduced
- **ported-with-divergence** — reproduced differently on purpose, pointing at the deciding ticket
  (Q7's expected-divergence list is this set)
- **not core** — belongs to the hae adapter or a scaffold template; never in the tool. hae's three
  prompt files land here (04)
- **transitional** — carried only to serve Q7's gate, then deleted in P7's atomic commit. The legacy
  ledger read adapter is the case; without its own mark it looks like a regression
- **dropped** — deliberately not carried, with a reason
- **deferred** — Phase C or post-finish-line, with a reason

Parity is reached when no item is unmarked. That makes it falsifiable, makes P7's gate honest, and
gives an outside adopter's "what does this do" question something to resolve against. The checklist
is an input to ticket [10](10-write-adr-and-spec.md)'s spec.

### Q9: the tripwire completes at P3, and its consequence is rescoped

Arithmetic: 06 sizes it at ">half of the first ~8 issues needing ≥2 Effect-error redispatches". 08
gives six bullets, one issue each, sizing held (agents fail at layer *wiring*, so splitting adds
seams). P1 is hand-done and does not count. So issue 7 is **P2** and issue 8 is **P3** — the
tripwire completes deep inside this sequence, not before move-out.

That matters because 06's stated fallback is Bessemer winning the bake-off. At P3 that door is far
more expensive than 06 priced: the repo exists, ADR 0007 is written, CI and branch protection are
up, and Bessemer's position is a live variable rather than a standing alternative.

- The sample of six from 08 is real data — not discarded, and the count is **not** restarted
  post-move.
- If it fires at P3 it escalates to the **user**, as 06 specified. The menu is **mitigate** (more
  `AGENTS.md` guidance, hand-seed the wiring, smaller issues accepting the seam cost) or
  **abandon**, priced honestly against what is already built.
- **It does not enter the bake-off's scored criteria.** 08 fixed those at Claim 1 and Claim 2 and
  said explicitly they are not widened. P3 is where the agent-productivity axis 08 called
  impossible-pre-move can finally complete, and folding it in as late evidence is tempting — and
  rejected, because widening criteria after seeing partial results is what makes a bake-off
  worthless. The tripwire stays a separate escalation with its own trigger and its own
  decision-maker.
- If the bake-off has already closed in TS's favour by P3, the tripwire's only live option is
  mitigation — **but the standing escape hatch from Q6 remains**: the python repo is retired, not
  deleted, so returning to it is always physically possible. Expensive, never impossible.

### Q10: vacating the name is a distinct act from retiring the code

07 reasoned that `bessemer` is not a collision because the loser is retired *first*. That holds only
if retirement means deletion. It does not (Q6) — so `HireAnEsquire/bessemer` stays an occupied
GitHub name and speepobox cannot rename into it.

**Retirement includes vacating the name.** If TS wins, in this order:

1. Rename the python repo `bessemer` → `bessemer-python` (or `-archive`). Code intact, fallback
   intact, name freed. GitHub's redirect keeps existing remotes working.
2. Rename `speepobox` → `bessemer`. Claiming the old name retires the stale redirect — fine, nothing
   but the user's own clone points at it.
3. `package.json` name + bin; repin the shim URL in `.agentbox/config` — 07's existing touch-points.

**Order is load-bearing**: step 1 before step 2, or step 2 fails outright. Step 1 is a new
touch-point, added to 07's list.

### Q11: the AFK/hand boundary

- **P1 hand-done.** Repo administration plus a deliberate experiment — nothing to dispatch, and the
  probe's whole value is watching it fail.
- **P2–P6 AFK-dispatched, bessemer on itself.** This is the self-hosting claim actually being
  exercised. One issue each per 06's held sizing. Agent builds, verifies, opens PR; the user merges.
- **P7 hand-done.** Config, four manufactured gate runs, an atomic flip-and-delete — and it happens
  in **hae**, not the tool's own repo. Its failure mode is two dispatchers confused about one repo,
  which is not something to hand an agent.
- **The rename, if it fires, is hand-done.** Three repo-level acts in a fixed order.

Bookended by hand-work, self-hosting through the middle.

## Comments

### 2026-08-07 — P3 design input: flags seed the wizard (recorded post-close)

Surfaced dispatching T1: any flag currently switches `run.sh` into all-flags mode, and the
`--branch is required` error is the cliff a wizard user hits. For the P3 picker, adopt
**partial-args**: every provided flag pre-answers its wizard step, the wizard runs per-step
**skip-if-answered** (not "resume at first unknown" — steps have data dependencies: the branch
list derives from the feature, the base default from the branch, and args can leave mid-sequence
holes), Esc-back may walk into a flag-answered step (flags are prefills, not locks), and every
run lands on the summary-confirm screen so a typo'd flag is seen before a container starts.
Scriptability contract preserved: interactive resume is TTY-gated; non-tty keeps today's hard
error (carry the hang-safety property, plus a `--no-input` escape hatch). Invalid flag value on
a tty drops into that step prefilled with the error shown; non-tty dies eagerly as today.
The bash picker is **not** retrofitted (frozen parity oracle); goes on the parity checklist as
**ported-with-divergence**. This is the standard shape in `gh` and the clack-ecosystem wizards,
so it also matches the 13 ruling to prefer clack-native expectations.

### 2026-09-21 — 22: the picker's third row is a task typed inline

[22](22-a-dispatch-that-carries-a-prompt-and-no-spec.md) ruled that a task stated on the command
line (`--task "…"`) is the work *named*, not computed, so unit 1's refusal above never fires for it.
When P3 makes selection interactive, the picker offers it as the third row beside *pick a spec* and
*pick a feature*, entered through the git-commit-style editor bracket SPEC §7 specifies for
`--feedback-edit` — one bracket for both. The flag lands before P3 as
[T67](issues/T67-a-task-stated-on-the-command-line.md), on [T66](issues/T66-the-task-is-one-union-and-resuming-is-the-identitys-fact.md); the row is P3's.

### 2026-09-21 — P2 sliced: twelve tickets, five decisions

The `/to-tickets` pass over P2 authored
[T68](issues/T68-issue-files-parse-order-and-restamp.md)–[T79](issues/T79-the-pr-body-carries-the-issue-checklist.md).
Q5's *~520 lines, ~40% of tasklib's tests* counted tasklib's pure python; what the port needs and
bash never counted is a tag that reads a ref (bash reads a materialized copy), `git fetch` (the
port never fetched), the two-phase guards, the loop (`run.sh:1740-1935`, tested nowhere), the
`commit-tree` landing (built after the inventory), the resume subset rule, and 15's two witnesses.
Sliced by the map's rule — how many things must be true at once, stopping at three — rather than
by Q11's one issue per bullet. **Q9's arithmetic is untouched**: its unit is a sequence bullet, so
P2 is sample 7 whether it takes one ticket or twelve.

Five decisions the tickets rest on, none of which 14 or 15 had settled:

1. **`--issues all` selects `ready-for-agent`**, not bash's *AFK and not Done* (T69). The template
   opens every ticket at `needs-triage`, so bash's predicate sweeps in what nobody has triaged — the
   wideness the P2 guard paragraph above is about. Amends 15 and SPEC §7; a SPEC §12 divergence.
2. **The per-issue boundary is read in the container** through `Sandbox.exec`, never by host git in
   the clone (T76): the agent owns the clone's `.git/config`, and a `core.fsmonitor` there runs a
   command on read-only operations with the dispatcher's credentials. `run.sh`'s land-step rule,
   extended to reads.
3. **A rehearsal fetches for real** (T70). 15: a fetch mutates remote-tracking refs, holds nothing,
   has no release; matrix row 1 is not dented. A plan resolved against a stale remote is a plan the
   run would not use.
4. **The PR checklist covers this run's selection only** (T79), not bash's whole-folder merge: the
   status commit in the same diff says which files went `Done`.
5. **The issue set is read at the branch tip.** 15's *fork commit* and 14's *branch tip* are one
   ref; SPEC §7's `--base` cell had 15's wording (*that the run forks from*) beside 14's (*never
   forked from*) unreconciled, and T70 fixes the cell: the checkout forks from the tip, `BASE_SHA`
   is the diff boundary's other end.

Units 1 and 2 above are two tickets, not one: the `--feature`-without-`--issues`
refusal reads argv alone and is T67's class (T73); the witnesses read refs and the ledger and fire
under the opposite override (T74). Outside this pass, by prior ruling: the `RunLock` carrying its
issue set (SPEC §2's first knock-on), the picker (P3), `--hard-reset` substituting the base for the
tip (P4), and Q8's parity checklist, which has no file yet and opens at P2's close.

### 2026-09-22 — P3 sliced: seven tickets

The `/to-tickets` pass over P3 authored
[T80](issues/T80-the-fuzzy-scorer-is-a-pure-module.md)–[T86](issues/T86-flags-seed-the-wizard.md),
from 13's verdict rather than from scratch. The scorer is its own ticket (a pure module with its own
green); T81 is the first TTY surface and sets how a prompt is tested here — the wizard on a scripted
`Prompt` fake, the interrupt bracket on a `PassThrough` in the fake tier, feel by hand. The step
order is source → branch → issues → base → summary (SPEC §2 binds only branch-before-issues; base is
a function of the branch). The comment of 2026-08-07 above is T86, last and `needs-triage` until
SPEC §7 says it. ADR 0005's create-a-branch carve-out is dropped, with reasons, at T81. Q9's
tripwire: MAP.md's status log carries the reading and a recommendation to close it unfired; the
decision is the user's.

### 2026-09-24 — P4 sliced: eight tickets, twelve decisions

The `/to-tickets` pass over P4 authored
[T97](issues/T97-the-reconcilers-scan-is-a-value.md)–[T104](issues/T104-the-row-records-the-discarded-tip.md).

**Prefactors.** Two prefactors come first, and each is its own ticket because each has its own
green. T97 splits the reconciler's scan from its act, because `gc` has to list without acting.
T98 narrows `salvage` to `{ branch, checkoutPath }`: gc has no `DispatchPlan`, and T28's
one-function rule forbids a second copy of the fetches.

**Decisions.** Asked in one batch, and ruled by the user:
- **D1**: the reset is a compare-and-set `update-ref` under the lock, before the clone, staged
  `checkout`. Slicing then found it must also come after the acquire's salvage, which would
  otherwise fast-forward a kept copy's commits back onto the reset branch. The user approved that
  placement. When the compare-and-set fails after such a salvage, the failure says the commits it
  moved were never counted or confirmed, and tells the dispatcher to run again (T101, T102).
- **D2**: the dispatch gets `Prompt`, which amends SPEC §2 (T102).
- **D3**: off a terminal or with `--no-input`, the flag is the consent.
- **D4**: a rehearsal records the confirm and does not ask it.
- **D5**: `--resume`/`--last` with `--hard-reset` is refused from argv.
- **D6**: the row records `discardedTip`, as an absent-key field under T31's rule. It was split
  out as T104 so T101 fits one context.
- **D7**: the lease is pinned to `origin/<b>` as the guard fetch left it, with the empty-expect
  form when origin has no such branch.
- **D8**: a malformed config degrades `gc`'s listing, and `gc --force` refuses. The composition
  is the read-only slice plus `RunLockLive` and `SandboxLive`.
- **D9**: no interactive gc, and SPEC §4's "aggressive/interactive" sentence is rewritten (T99).
- **D10**: the runtime-root leftovers bash never produced are out of P4 and recorded in MAP.md.
- **D11**: `gc` does not salvage onto a branch the repo no longer has. It skips that copy loudly.
  The rescue-only arm is recorded in MAP.md, because the acquire can reach an absent branch
  through a race, so `salvage` itself is not changed.
- **The discard count is a union** (raised by T101's implementing agent and ruled 2026-09-24):
  every commit reachable from the guard-read tip or from `originTip` and not from the base, counted
  once. The D7 lease discards origin-only commits too. The plan row and T102's warning and confirm
  use this count. The reset event names both tips, and T104's row keeps the local one.
- **D12** (surfaced while slicing): under a reset, the landed-elsewhere witness leaves out
  `refs/heads/<b>` and `refs/remotes/origin/<b>`, by name. Both are being discarded: the first
  by the reset, the second by the D7 lease push (T103).

**Not carried from bash:** the `--gc` alias, and bash's reset before the lock.

### 2026-09-30 — P5 ruled: `init`, its templates, and `init --diff`

Grilled in three rounds. Each round was cross-checked by an orchestrating agent and by the
implementer, and both corrected it. The user ruled on the result. Tickets start at T110.

**Vocabulary.**
- **E1**: what `init` writes is the **scaffold**. The package's copy of each file is its
  **template**. Once written, a scaffold file belongs to the served repo. "Adapter" is retired for
  this meaning, because SPEC §10's legacy ledger read adapter already uses the word. Both terms
  are in [`CONTEXT.md`](../../../CONTEXT.md).

**What `init` writes, and where.**
- **E2**: every scaffold file goes under `.bessemer/`:
  - `config.toml`
  - `.gitignore`
  - `image/Dockerfile`
  - `image/inputs`
  - `tasks/`, created with a `.gitkeep`

  The scaffolded config sets `tasks-dir = ".bessemer/tasks"`. Probe 8 is then green right after
  `init`, and the one-directory promise holds. The code default stays `"tasks"`.
- **E3**: `init` does not write these:
  - **A setup hook or a sandbox env file.** Their keys appear in the config only as comments.
    Declaring no hook means no step (T7), while a stub hook is a step that does nothing.
  - **Any prompt file.** A comments-only `project-context.md` is not empty, so it would be
    appended to every pass (T14).
  - **The shim**, which is P6's.
- **E4**: `init` writes only files that are absent. It never overwrites one. It reports each file
  as `wrote` or `kept`, and it has no `--force`. Running it again is how an adopter picks up a
  template added in a later version. To refresh a file, the adopter deletes it and runs `init`
  again. `--diff` prints that command.
- **E7**: the config values:
  - `base` comes from `refs/remotes/origin/HEAD`. If that cannot be read, `--base` is required,
    and without it `init` refuses.
  - `image` comes from `--image`. The default is the repo directory's name, lowercased into a
    legal tag, plus `-bessemer`.
  - `tool-sha` is the running package's revision. If the package is dirty, it is left empty and
    `init` warns, because the pin discipline is P6's.
  - `image-build-command` names E10's `image build`.

  Placeholders are a fixed, named set, and they are substituted in `config.toml` only. 05 Q9
  rejected a templating language for *prompts*. It did not reject one for the scaffold.
- **E8**: the `.gitignore` template ignores files by explicit name. There is one exception, the
  anchored `/*-edit-*/` for the editor's session directories (T84, T108). It cannot match
  anything under the tasks dir, and it never ignores `env.sandbox`. A test scaffolds a temporary
  repo and runs `git check-ignore` against `.bessemer/tasks/<feature>/issues/x.md`. That meets
  the MAP ruling of 2026-08-20 (*the port requires issue folders to be tracked*) by construction.
  It is not a runtime check.

**Drift.**
- **E5**: every scaffold file except `config.toml` carries a stamp. The stamp is one whole
  comment line, `# bessemer-template: <name> v<N> sha256:<12>`:
  - `<N>` is the template's version, an integer the package bumps whenever the template changes.
  - The digest is the template's, with the stamp line left out. That equals the text as written,
    because stamped files are never substituted. A file stamped by hand (E12) carries the
    template's version and digest, never a digest of its own text, so it reads as edited rather
    than as safe to replace.
  - The stamp line can sit anywhere in the file. A Dockerfile parser directive must still come
    first, so the stamp does not claim line 1.
  - The stamp describes the raw template, because only `config.toml` is substituted and
    `config.toml` carries no stamp.
- **E6**: `init --diff` sorts each stamped file into one of three states: **missing**,
  **current**, or **behind** (the stamp's `N` is below the template's). A file that is present
  is also **pristine** or **edited**, depending on whether it still hashes to its stamp's digest.
  - For a behind file, `--diff` prints the current template against the file, labelled as
    including the adopter's own edits. The template the file was stamped from is not kept,
    because the shim clones one SHA. It also prints the delete-and-rerun command. A file that is
    pristine and behind is reported as safe to take as it is.
  - `config.toml` is checked for presence only, because probe 7 judges its contents. The tasks
    dir is not checked, because probe 8 does that.
  - `.gitignore` **is** drift-checked. An ignore line added in a later version, such as E8's, is
    exactly the upgrade an adopter has to hear about.
  - A present file with no stamp counts as version 0, and so as **behind**.
  - `--diff` exits 0 only when no file is missing or behind.

**The command.**
- **E9**: `init` is intercepted before any preflight, the way `status`, `doctor`, and `gc` are.
  There is no config to decode yet. It takes flags only: no picker, and no `--dry-run`, since
  `--diff` on a fresh repo already lists what would be written. It reads templates from
  `<packageRoot>/templates/`, a path handed in as a parameter, so SPEC §9's ban on `packageRoot`
  holds. It ends by printing the next steps (build the image, put the credential in
  `.bessemer/.env`, run `doctor`) and does not run them.
  - `init` refuses on a self-hosted repo. `init --diff` is read-only and is allowed there.
  - There is no separate refusal for a repo with no `origin` beyond E7's base refusal. Probe 5
    reports a missing `origin`.

**How an image declares its inputs.**
- **E10**: the package owns the build, through a new subcommand, `bessemer image build`, and a
  new method on an existing tag, **`Sandbox.build`**. It is a capability inside a tag, not a new
  tag, and the PR says so. The recording `Sandbox` records the build as a no-op, and
  `image build` takes no `--dry-run`.
  - `image build` reads `image` from the config (dispatch-surface config, which dies on a bad
    decode). The uid and gid are read at the composition root.
  - The build context is `.bessemer/image/`, never the repo root, because the repo root holds
    `checkouts/`, which are other runs' clones.
  - The input list is `.bessemer/image/inputs`: one exact repo-relative path per line, with `#`
    comments and blank lines ignored. No globs are allowed, and a missing path refuses the build.
  - The Dockerfile is an implicit first input, labelled with its repo-relative path. The list
    file is not hashed itself. Adding a path already changes the digest, because every hashed
    line carries its path (`probes.ts`).
  - The digest is computed by the same TS function probe 2 uses, so there is one recipe instead
    of today's bash copy and TS mirror.
  - A repo whose image needs more wraps the command. One whose base image is compose-built would
    run `docker compose build <service> && bessemer image build`.
- **E11**: the Dockerfile template pins the agent CLI with `ARG CLAUDE_CODE_VERSION=<exact>`,
  installed through the native installer so that an adopter's image needs no node (04). Bumping
  the pin changes the digest and the template version, and `--diff` shows it. `doctor` does not
  learn the version. T50 and T51 already make a change in the stream format loud. This resolves
  MAP's *the image's CLI is unpinned*.

**This repo.**
- **E12**: this repo moves onto the scaffold layout. `image/` becomes `.bessemer/image/`
  (Dockerfile plus an `inputs` list), `image/build-image.sh` and `image/image-inputs.sh` are
  deleted, `image-build-command` names `node src/bin.ts image build`, and its Dockerfile pins the
  CLI. This **retires** the self-hosted-layout exception from T40 and from round 1 of this grill.
  T40 put `image/` at the root only because 18 might move the package, and `.bessemer/` did not
  exist yet. Neither reason holds now. `setup-hook.sh` stays at the root, because config names
  it. The Dockerfile's path changes and each hashed line carries its path, so this repo's image
  **goes stale once** and needs one rebuild.

### 2026-10-02 — P6 ruled: the shim, the pin, and releases

Grilled in four rounds against MAP's seven P6 questions. Each round was cross-checked by the
implementer, and both sides corrected the other. The user ruled on the result. This comment
**amends Q4** (releases are now tags) and **E3** (`init` now writes the shim). Tickets start at
T120.

**Vocabulary.** **Shim**, **pin**, **release**, and **package cache** are in
[`CONTEXT.md`](../../../CONTEXT.md). The package cache is not the runtime root: nothing a
dispatch writes goes there.

**The shim.**
- **F1**: `init` writes the shim as `.bessemer/bessemer`, a stamped scaffold file (E5) with mode
  0755. `init --diff` reports drift as it does for every other stamped file, and reports a shim
  that has lost its executable bit as a separate condition, *not executable*, whose fix is
  `chmod +x`. A lost bit is the adopter's change, not drift. This amends E3's third bullet.
- **F2**: the shim is committed only. It passes `--repo-root` computed from its own location
  (19 §1), and nothing ships on the PATH: a launcher that walks up to find the shim is the
  working-directory inference 19 rejected. Every printed command reads `.bessemer/bessemer …`,
  `init`'s next steps (`render.ts`) included. That is T117's finish line: the commands `init`
  prints work as printed.
- **F3**: the shim is POSIX `sh`. Before it clones, it checks that `node` is 26 or later and that
  `git` and `npm` are present, each failure in one line naming the fix. `doctor`'s probe 1 stays,
  but an old node fails before `doctor` can run at all.
- **F4**: the shim hard-codes `https://github.com/HireAnEsquire/bessemer.git`. The repository
  stays private: adopters are org members, and going public is its own act (MAP, *Not yet
  specified*). Reversed 2026-10-14: the repository went public as `HireAnEsquire/speepobox`,
  seeded from this tree, and the private repo is the archive (T143). The shim reads no token. It
  uses the operator's git credential chain with `GIT_TERMINAL_PROMPT=0`, so a missing credential
  fails instead of hanging, and the failure names
  `gh auth setup-git`, since an authenticated `gh` is already a preflight prerequisite (probe 6).
  A fork edits its shim, which `--diff` reports as edited.
- **F5**: the first `init` runs from a hand clone at the latest release: clone, `npm ci`, then
  `node <clone>/src/bin.ts init --repo-root "$PWD"`. The clone's revision becomes the pin (E7), and
  from then on every command goes through the shim. The README gives a command that finds the
  latest release, never a literal tag name.

**The pin.**
- **F6**: `tool-sha` is read from the committed `.bessemer/config.toml` only, by one line grammar:
  `^tool-sha[ \t]*=[ \t]*"([^"]*)"[ \t]*$`. Exactly one line may match, and the captured value must
  match `^[0-9a-f]{40}$`. Each failure is its own refusal naming its fix: **no line** (run `init`,
  or add it), **malformed** (a `tool-sha` line the grammar cannot read, such as single quotes or a
  trailing comment; the expected form is quoted), **empty** (`init` ran on a dirty package), and
  **short** (`upgrade --to vN`, or `git rev-parse` in a clone). The grammar is narrower than TOML
  on purpose, and `init` always writes a line it accepts. Full SHA because the shim fetches by SHA,
  which GitHub serves only for a full one: `init` writes `rev-parse HEAD`, not the `--short`
  revision it writes today. The ledger and every display keep the short form. No override layer
  feeds the pin: 01's property (a), no skew within a team, is what a local override would break
  silently. To try an unreleased bessemer, an operator runs `node <clone>/src/bin.ts --repo-root …`
  directly, which is visible and deliberate.
- **F7**: `tool-sha` leaves `BessemerConfig`'s four-layer chain. Nothing reads it there, and
  decoding ignores unknown keys, so an adopter's file that keeps the line still decodes. There is
  **one grammar with two implementations**: the shim's `sed`, and one TS module that `upgrade` and
  `doctor` use. One test runs both over the same fixture lines (valid, short, empty,
  single-quoted, trailing comment, duplicated, missing) and asserts they agree. The running
  revision answers *what is running*, and only the pin reader answers *what is pinned*: under a
  hand clone the two differ, which is why both readers exist.
- **F8**: this repo deletes its `tool-sha` line. `init` refuses here (E9), so this repo gets no
  shim, and no self-hosted arm of `doctor` or `upgrade` reads a pin: the checked-out branch
  chooses the dispatcher.

**The package cache.**
- **F9**: the cache is `${XDG_CACHE_HOME:-$HOME/.cache}/bessemer/<sha>/`. The shim builds a new
  entry in `<sha>.tmp.<pid>/` (fetch the SHA, check it out, `npm ci --omit=dev --ignore-scripts`)
  and moves it into place with `node -e` and `fs.renameSync`, so a directory named `<sha>` only
  ever exists complete. **Not `mv`**: when the target already exists as a directory, `mv` moves the
  temp directory *into* it and succeeds, which silently loses the race and nests
  `<sha>/<sha>.tmp.<pid>/` (verified on macOS; BSD `mv` has no `-T`). `rename(2)` onto a non-empty
  directory fails with `ENOTEMPTY` on Linux and macOS, and the loser removes its own temp directory
  and runs the winner's entry. An interrupted `npm ci` leaves only a temp directory, which never
  counts as an entry.
- **F10**: the slow path removes a `*.tmp.<pid>` directory whose pid is not alive, judged by the
  pid in its name and never by age (T20, T26). Nothing prunes old entries, because the cache is
  shared across served repos and another repo may pin an old SHA. `gc` does not touch it, because
  it is not a runtime root. The README documents `rm -rf`.

**Releases.**
- **F11**: a release is an annotated `v<N>` tag (`v1`, `v2`, …) cut by hand on a commit on main
  whose CI is green. Only tags matching `^v[1-9][0-9]*$` are releases. Every other tag — the repo
  already holds `bessemer-port-source` and `clack-picker-prototype` — is ignored without comment.
  The agent never tags, the same boundary as never merging. There is no semver, changelog, or
  publish. **This amends Q4's "no tags"**, and the reason is correctness, not noise: main's tip is
  not reliably fit to pin. Pushes to main are not gated before they land, and main has carried a
  commit whose CI failed (`3e77d33`, the merge of #78, in the private archive). Q4's rule stands
  underneath: a tag is the human recording that the commit is on main and green. The pin stays a
  full SHA, so a moved tag cannot change what an adopter runs.
- **F12**: `v1` is cut once P6's last ticket merges with CI green. The hand proof (F20) then runs
  the README literally, bootstrap included. If it fails, the fix lands and `v2` is cut: a release
  nobody pins costs nothing. Bootstrapping the proof from an untagged SHA instead would prove a path
  no adopter takes.

**`upgrade`, `doctor`, and the pin discipline.**
- **F13**: `bessemer upgrade` runs `git ls-remote --tags origin` **in the package cache copy**,
  whose `origin` is the release URL, so TS holds no second copy of the URL. It takes each release's
  commit from its peeled `^{}` line, or from the bare line when there is none (a lightweight tag's
  line already names the commit). It reads the pin through F7's module and compares **tag numbers,
  never ancestry**, because the cache copy is a depth-1 clone with no history to ask. A pin that
  `vK` points at moves only to a `vN` with N > K, and a commit carrying two releases counts as the
  higher. N = K says the pin is current. An untagged pin, such as one from a hand clone, refuses
  with "pin `<short>` is no release; `upgrade --to vN` pins one explicitly". `--to vN` also makes a
  rollback deliberate. `upgrade` rewrites only the `tool-sha` line, prints
  `.bessemer/bessemer init --diff` without running it (the next shim call runs the *new* pin,
  whose templates are the ones to diff against), and commits nothing. It refuses self-hosted.
- **F14**: `doctor` gains an upstream row, `pinned vK (<short>); latest vN`, from the same
  `ls-remote`. It is always `ok`, never `warn` (the *unchecked check* rule). When the running
  revision differs from the pin F7's module reads, it says so in the same `ok` register. The row is
  **`doctor`-only and never joins the dispatch preflight**, which reuses `doctor`'s probes: no
  dispatch waits on the network for advice. There is no per-dispatch nudge.
- **F15**: both network calls get a 10 s timeout and `GIT_TERMINAL_PROMPT=0` as a per-call
  constant. The allowlist does not change: it already forwards `HOME` and `PATH`, which is how the
  guard phase's `git fetch origin` reaches a private origin through the chokepoint today. A timeout
  or a git failure is an `ok` row saying nothing was compared, quoting git's line, in `doctor`, and
  a refusal quoting it, with nothing written, in `upgrade`.
- **F16**: `init` warns, and does not refuse, when the revision it pins carries no release
  (`git tag --points-at HEAD` in the package, offline). A hand clone at main is a legitimate way to
  try a revision. `upgrade` only ever pins releases. The shim checks nothing about tags, because
  its warm path has no network.

**The shim–package contract.**
- **F17**: an upgraded package is run by the adopter's old shim until `init --diff` brings the
  shim up to date, so the call between them is an interface across versions. It is written in SPEC
  §6:
  1. the entry is `node <cache>/src/bin.ts`;
  2. `--repo-root <absolute>` comes first, and the rest of argv is passed verbatim;
  3. `npm ci --omit=dev --ignore-scripts` prepares the tree;
  4. the cache copy is a git repository with `HEAD` at the pin and `origin` set to the release
     URL, and **the package reads nothing else from it**.

  A package release never stops accepting a call an earlier shim template makes. A change is
  additive, and it bumps the shim template's version so `--diff` reports it.

**What proves it.**
- **F18**: a contract test runs every shim template version ever shipped (each one's text is kept
  as a fixture when the template bumps) on its **warm path**, against a cache entry that is a
  symlink to this checkout with the pin set to its full SHA. It calls `init --diff` against an
  empty fixture repo: no network, no docker, no writes, and its every-file-missing output is the
  proof that `--repo-root` reached the package. Not `doctor`, which F14 now sends to the network.
  `--diff` asks the served repo no git question (`init.ts` returns from that branch before base
  resolution, and `diff.ts` imports no `Git`), so a plain directory serves as the fixture.
- **F19**: the shim's own tests run in verify against a fixture mirror: a package with an empty
  lockfile and a `src/bin.ts` that prints its argv. They reach it through a `GIT_CONFIG_*`
  `insteadOf` rewrite of the hard-coded URL, set on the child only, with `XDG_CACHE_HOME` pointed
  at a temp directory, `npm_config_offline=true` so verify stays offline by construction, and the
  child's environment written out in full. Cases: cold run; warm run with the mirror deleted (no
  network); two concurrent first runs, asserting no nested `<sha>/<sha>.tmp.*`; a short, an empty,
  and a malformed pin; node too old (a fake `node` first on a PATH that still holds real `git` and
  `npm`); and argv passthrough.
- **F20**: one HITL proof in T117's shape, after F12's `v1`: a real adopter repo through the
  README's bootstrap, the shim, `image build`, `doctor`, and a dispatch, against GitHub.
- **F21**: the adopter README covers the prerequisites (node ≥ 26, docker, `gh auth login` and
  `gh auth setup-git`), the bootstrap, the shim, `upgrade`, and the package cache with its
  `rm -rf`. Renovate is left out, against MAP's leaning: it is untested against a private repo's
  tags, and `doctor` with `upgrade` already does the job. It returns when an adopter asks.

**Amended the same day, while slicing.** The slicing pass found two rulings it could not follow as
written. The user ruled both:
- **F6's remedies looped.** The short pin's refusal named `upgrade --to vN`, but the shim cannot
  run `upgrade` on a pin it cannot fetch, so the remedy hit the same refusal. The **empty** and
  **short** refusals now name, first, `git ls-remote --tags
  https://github.com/HireAnEsquire/bessemer.git`, from which the adopter copies the full SHA on a
  release's `vN^{}` line onto the `tool-sha` line. That needs only git and the credential F4
  already requires, and no clone. Second, they name `upgrade --to vN` run from a hand clone, the
  way F5 runs `init`. `upgrade --to vN` needs a `tool-sha` line the grammar matches, not a valid
  value in it. Plain `upgrade` on an empty or short pin refuses the way an untagged pin does.
- **F18's fixture cannot be empty.** The shim names the served repo from its own location, so the
  fixture repo is the directory that holds the shim under test and a `config.toml` carrying the
  pin. The test asserts that `--diff`'s output names that directory's files, which still proves
  `--repo-root` reached the package. And **"shipped" means in a release**: a contract fixture is
  kept only for a shim template version that appeared in a `v<N>`, so the version bumps made
  before `v1` leave none.
- **F1's refresh fix could not run.** E6's fix for a behind file is delete-and-rerun, which for the
  shim is `rm .bessemer/bessemer && .bessemer/bessemer init`: the second half runs the file the
  first half deleted. F17 depends on exactly this step, because an old shim stays in use until it is
  refreshed. **For the shim only, the fix moves it aside inside `.bessemer/` and runs it from
  there:** `mv .bessemer/bessemer .bessemer/bessemer.old && .bessemer/bessemer.old init && rm
  .bessemer/bessemer.old`. The shim names the repo from its own directory, which is still
  `.bessemer/`, so the old shim serves the same repo. `init` sees the shim as absent and writes the
  new one from the running pin's templates, which after an `upgrade` are the new ones, and that call
  is what F17 already promises. `mv` keeps the mode, and the shim `exec`s node, so no `sh` is still
  reading the file when it moves. `--diff` also prints the restore line,
  `mv .bessemer/bessemer.old .bessemer/bessemer`, for an `init` that fails partway; a leftover
  `.old` is not ignored, so `git status` shows it. A hand clone running `init`, as in F5, is named
  as the fallback only. This amends E6's fix for one file.
- **`init` works out its config values only when it will write `config.toml`.** Re-running `init`
  resolved `base` before writing anything, even when the config was present and would be kept, so
  on a repo with no `origin/HEAD` the shim refresh above refused over a value it would not use. The
  `tool-sha` warning was already gated on the config being written; the values now are too. This
  corrects E7 by the rule E4 already implies: a kept file asks nothing.

### 2026-10-05 — F4 amended: the release fetch authenticates through gh

Found preparing P7: this host's git reaches GitHub over SSH and has no HTTPS credential helper, so
the shim's fetch, `upgrade`, `doctor`'s upstream row, and the README's bootstrap all fail until the
adopter runs `gh auth setup-git`, which rewrites the github.com helper chain in their global git
config. Researched in
[research/09-shim-fetch-auth-findings.md](research/09-shim-fetch-auth-findings.md); the user ruled
its recommendation (b). Tickets T132–T133.

- **F4, amended.** Every git call that reaches the release URL, which is the shim's fetch and
  `upgrade`'s and `doctor`'s `ls-remote` (F13, F14), first authenticates through gh **for that
  call only**: `-c credential.https://github.com.helper=` (the scoped reset, so the operator's
  own helpers are never sent gh's token to `store`), then
  `-c 'credential.https://github.com.helper=!gh auth git-credential'`. This is the pair gh adds to
  its own clones and fetches (findings, Q1). The shim still reads no token: git asks gh. Nothing on
  the host is written, and the host's git protocol stops mattering.
- **gh is optional, and the operator's chain is the fallback.** The pair is used only when `gh` is
  on the `PATH`. When it is absent, or the gh attempt fails, the call runs again exactly as F4
  first ruled it, so a host that ran `gh auth setup-git`, or has any other credential, still works.
  An authenticated gh is a dispatch prerequisite (probe 6), not one for `doctor`, `status`,
  `init --diff`, or `upgrade`, and a hard gh check in the shim (F3) would make `doctor`
  unreachable on the host it exists to diagnose. A refusal quotes both attempts' git lines and
  names `gh auth login`, then `gh auth setup-git`.
- **F6's remedy, amended again.** The empty and short refusals name
  `gh api --paginate repos/HireAnEsquire/bessemer/tags --jq '.[] | "\(.commit.sha) \(.name)"'`
  instead of `git ls-remote --tags <url>`. It works on an SSH host, and `/tags` answers with each
  tag's commit already peeled, so the `vN^{}` instruction goes. `upgrade --to vN` from a hand
  clone stays second.
- **F21, amended.** The README's prerequisites drop `gh auth setup-git`. Its release lookup uses
  the same `gh api` command, and the bootstrap clones with `gh repo clone`, which follows the
  adopter's own `git_protocol`.
- **No allowlist change.** The pair is argv. The helper is spawned by git and reads the `HOME` and
  `PATH` the chokepoint already forwards, as probe 6's `gh auth status` does. `GH_TOKEN`,
  `GH_HOST`, and `GH_CONFIG_DIR` stay out: a second route to a credential is what T23 forbids.
- **Fetching through gh with no git (findings' option (c)) is rejected.** The cache entry would have
  no `.git`, and the package reads it: the self-hosted check, the dispatcher revision on ledger
  rows, `init`'s `tool-sha`, and `upgrade`.
- **Released as `v2`, before P7**, so hae adopts onto a shim that never needed `setup-git`. The
  shim template moves to v3, and v2's text is the first released fixture F18 keeps.

The research's side finding, that a cache entry fetched by SHA carries no tags and so F16's warning
would fire on every `init` through the shim, is **unreachable**: the shim refuses without
`config.toml` (`no-config`), and `init` resolves `tool-sha` only when it writes that file. The
research also found `releases.ts` and `dispatcher-revision.ts` calling `git -C` without
`--git-dir`, against T32, and a grep found three more calls in `guards.ts` and `probes.ts`; all
five are T133.

### 2026-10-08 — P7 ruled: hae adopts from the v2 release

Grilled in four rounds. The user ruled on the result. This comment **amends Q7**, whose gate and
"one atomic commit" assumed bash was live in hae, and it closes P7's design. P7 is hand-done (Q11):
its install is the hae install gate, a HITL ticket, and three AFK tickets in this repo go with it
(G14).

**What the survey found.** Bash never reached hae's `master`. `run.sh`, `tasklib.py`, the
Dockerfile, its build and setup scripts, the bash prompts, and hae's bash-era ADRs exist only
on hae's `agentbox` branch (local and `origin`). On master, `.agentbox/` is a gitignored directory
of local leftovers, and `docs/wayfinder/effect-agentbox/` there holds no files. Nothing on master
names the tool: not the Makefile, CI, AGENTS.md, or docs.

**Scope.**
- **G1**: retiring bash is **out of P7's scope**. Nothing of it is on hae's master, so there is
  nothing to delete there. The operator clears their own local leftovers as they like.
- **G2**: the order:
  1. an install branch in the hae clone, cut from `origin/master`;
  2. the gate, run on that branch;
  3. one PR from the install branch to master;
  4. T136 and T137 in this repo. T135 is free to run at any point (G14).
- **G3**: bash's history is dropped. Its ledger rows describe work on bash itself, on branches
  nobody will resume, so there is no import and no side-by-side `status`. Q7's first two additions
  are void. The root flip was already dissolved by 18, which made the runtime root `.bessemer/`, so
  the two tools' roots were split by construction. With nothing of bash on master, the "one atomic
  commit" has nothing to hold. The legacy read adapter's job ended with that, and T135 deletes it
  (PARITY row 3.9).

**The gate.**
- **G4**: five dispatches, all under bessemer only:
  1. an inline `--task`;
  2. a one-off from a spec, which takes the other arm (T17, T37);
  3. a feature run over two or three issues;
  4. a resume with `--feedback` on run 1's branch;
  5. a `kill -9` of the dispatcher mid-pass, then a re-dispatch of the same branch.

  Each is judged by outcome. It reaches its terminal state, writes a ledger row, opens its PR (for
  run 5, the re-dispatch does), and leaves no lock or container behind according to
  `.bessemer/bessemer status`. Run 5 proves the reconciler's reclaim, the read before a removal, and
  the kept-checkout path against a repo that is not bessemer itself, which self-hosting never
  could. **There is no parity bookkeeping.** PARITY.md stays the record of what was ported. A
  surprise during the gate stops it, and the user rules on it. This amends Q7's gate and its third
  addition.
- **G5**: the gate's tasks are disposable on purpose. The gate tests the dispatcher, not the work.
  Dispatch branches are cut by hand from `origin/<install branch>`, their PRs target the install
  branch, and they are closed unmerged. The feature run's issue folder is committed on its own
  dispatch branch and never on the install branch.
- **G6**: during the gate, `base = "origin/<install branch>"`. It flips to `origin/master` in the
  commit just before the master PR.
- **G7**: a bessemer bug found by the gate is fixed in this repo and a new release is cut, as in
  F12. Then, in hae, run `.bessemer/bessemer upgrade`, then `init --diff`, then run the failed step
  again. The pin reaches master only after the gate has passed.

**hae's install.**
- **G8**: the first `init` runs from a hand clone of the latest release, following the README's
  bootstrap literally (F5, F21). Today that release is `v2`. The operator writes the credential into
  `.bessemer/.env` after `init` and before `doctor`.
- **G9**: the image starts from the template on hae's own app image, adding the database and
  client toolchain its tests need. The template's pinned native CLI install replaces bash's
  `npm install -g @anthropic-ai/claude-code`.

  The build command first builds that base image, then runs `.bessemer/bessemer image build`. A
  stale base is not detected, because it is no input. bash had the same gap, and it is accepted.
- **G10**: setup that needs root. Root work is a script baked into the image. bash's root setup
  script goes in under `.bessemer/image/`, listed in `image/inputs`, and is `COPY`'d to a fixed
  path. sudo is scoped to exactly `/usr/bin/bash <that path>`.

  The mounted hook, `.bessemer/setup-hook.sh`, runs as `agent`. It does the unprivileged setup and
  runs that one `sudo`.

  `cap-add` carries bash's six caps (`run.sh:1647`). Running the whole hook as root was rejected,
  because the dependency install would then leave root-owned files in the clone. Bessemer builds
  no second mechanism, since the image is the adopter's. T136 documents this pattern.
- **G11**: `.bessemer/env.sandbox` is the served repo's sandbox env file, ported whole and
  committed, dummies only (checked). Whatever the file holds, the agent can read it, so the
  dummies-only bar holds whether it is committed or not. A minimal file was rejected: a setting the
  app reads lazily would surface as a mid-pass test failure long after run 1. That is a later and
  more confusing failure than a large file.
- **G12**: no storage volumes. Q8 already rules that the client install runs in the clone: slower,
  and correct. The prompts are the package defaults. A `project-context.md` fragment is a follow-up
  if a gate run shows that hae context is missing.
- **G13**: the master PR touches only `.bessemer/`, which shows the one-directory promise holds.

**Tickets.**
- **G14**: P7 is four tickets:
  - The hae install gate is HITL, in the shape of P6's clean-room proof. It holds the runbook: the
    install, the gate, and the master PR. It also takes in that proof (F20), which never ran: the
    cold cache, `upgrade`, `init --diff`, and the warm path from a second clone. The proof's own
    ticket is marked superseded.
  - [T135](issues/T135-the-legacy-read-adapter-retires.md) deletes the legacy read adapter. It
    depends on nothing, because G3 already dropped bash's history.
  - [T136](issues/T136-setup-that-needs-root-is-documented.md) documents G10's pattern in the README
    and the Dockerfile template. It waits on the hae install gate, so its wording comes from what
    hae actually needed.
  - [T137](issues/T137-the-parity-oracle-retires.md) deletes this repo's `.agentbox/`. It waits on
    the hae install gate only, because the gate is the oracle's last reader.

**The map closes** once T135–T137 have merged. A planning session makes that edit, and no ticket
does it. MAP then gets its last Status-log entry, its destination is marked reached, and what is
still open moves to a **Follow-on** section: writable container storage, whether the package goes
public, per-pass model selection with Phase C, and the v4 migration.

### 2026-10-12 — The hae install gate: what hae's install surfaced

hae installed from `v2` on `bessemer-install` and passed all five gate runs on dispatcher `ec39dc3`
(base `55ea5c7`). The master PR touches nine files, all under `.bessemer/` (G13).

**What did not change.** No bessemer fix and no release came out of the gate. `setup-timeout` kept
its default, because the setup hook took about 40 seconds on every run. No `project-context.md`
fragment was needed (G12): no run lacked hae context. The README's bootstrap (§2) ran exactly as
written against a cold cache, and nothing in it was wrong. Its upgrade, unfetchable-pin, and cache
sections (§4–§6) were not exercised beyond `upgrade` reporting current. `doctor` and `init --diff`
were clean. hae's image, setup hook, and root setup were written by hand, since the README does not
cover setup that needs root; that is T136.

**Findings about bessemer.**
- **A `kill -9` on the dispatcher leaves the agent running.** Run 5's killed dispatcher stopped
  logging at 13:54:23, and its agent committed at 13:54:53. The pass budget is the dispatcher's
  timeout (T9), so a dead dispatcher leaves an agent with no budget, working unsupervised until a
  reclaim removes the container. Here the reclaim salvaged that commit and the re-dispatch's
  implement pass found the work already done. This is a candidate for the follow-on list, not a P7
  ticket.
- **`status` lists an orphaned container under "Running".** Between the kill and the re-dispatch it
  showed `bessemer-p7-gate-5` as running, with nothing to say its dispatcher was dead. The
  reconciler already knows the answer (the lock's owner is not alive), but `status` does not say it.
- **The re-dispatch's prompt did not know the salvage moved the branch.** The guard phase read the
  tip before the checkout's clear-my-own-path salvage brought the killed run's commit home (T38), so
  the prompt carried no build-on sentence. The agent found the commit anyway.
- **A committed issue folder makes issue 01's prompt say the branch holds earlier work.** Run 3's
  issues were committed on the branch, past the merge-base, so the boundary differed from
  `mergeBaseSha` from issue 01 onward. That is correct under T75: the branch did hold a commit
  the agent should read.

**Findings about hae, not bessemer.** hae's own test environment and settings needed adjustments
unrelated to bessemer; the setup scripts should be created with `chmod +x` (T136).
