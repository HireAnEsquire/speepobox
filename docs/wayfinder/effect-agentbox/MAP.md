# Map: agentbox as an Effect TypeScript library

Labels: `wayfinder:map`
Charted: 2026-07-29

## Destination

A committed **ADR + spec + two tracer-bullet sequences** for an Effect-TypeScript port of
agentbox. The tool incubates as a self-contained top-level package inside hae until it can
dispatch a one-off task on itself *and* re-dispatch a branch with feedback; it is then lifted
into its own repo, where it self-hosts through feature parity, hae switchover, and adopter
install.

The map is done when an agent session can start T1 with no decisions left to make. **No product
code is written by this map** — it produces decisions and planning artifacts only.

**18 closed 2026-09-09, and the name of this tool changes.** The package roots at `/`, takes the
name **`bessemer`**, and stops anchoring anything to its own directory — `runtimeRoot` now defaults
to `<repoRoot>/.bessemer` and the client-override root moves to `repoRoot`. **On 2026-09-18 the
package took the name `bessemer` and this tree was swept under 18 §4's rule (T63): every ticket
here, closed ones included, now carries retrofitted vocabulary — a closed ticket that says
`bessemer` was written under the name `speepobox`, and only its branch names and quoted history
still say so.** The evidence is frozen as written: `.agentbox/`, the extraction's own records (not
carried), ADRs 0007 and 0008, and [07](07-name.md). The vocabulary for the roots lives in the
repo-root [`CONTEXT.md`](../../../CONTEXT.md).

**The sweep is authored.** 18's forced four-step order and 19's rulings became `T56`–`T63` in the
`/to-tickets` pass of 2026-09-14, 19 folding into step 3. The **Status log** at the foot of this
file carries how the map reached that point.

**Not yet specified** below is live and being worked; do not read this section as saying the map is
finished.

Do not confuse these tickets with the **implementation** issues at
[`issues/`](issues/) (`T1`…`T67`). Those are the map's deliverable, worked by AFK dispatch; these
are decisions, worked in conversation.

## Notes

- **Domain**: AFK coding-agent dispatch orchestration. Prior art and constraints live in
  `docs/adr/0004`, `0005`, `0006`, `.agentbox/ROADMAP.md`, hae's sandboxing guide (not carried), and
  the implementation itself (`.agentbox/run.sh`, `.agentbox/tasklib.py`).
- **This map reverses a recorded decision.** ADR 0006 rejected TS/node explicitly ("port-to-TS
  rewrites everything including the proven half"). The final ADR must confront that argument
  head-on, not route around it.
- **Bessemer (the python port) is out of scope** and proceeds independently. A bake-off between
  the two is expected at F3/T3 parity, but nothing on the python side is planned here.
- **Behavior spec source**: `run.sh` + `tasklib.py` read directly. No intermediate
  language-neutral spec doc is produced (decided during charting).
- **Skills every session should consult**: `/grilling`, `/domain-modeling`, `/research`,
  `/prototype`.
- **Standing preferences**: the user makes all commits, pushes, and merges — prepare changes and
  show exact commands, never run `git commit`. Every question carries a recommendation, and a
  grilling session asks its whole frontier as one numbered round rather than one question per turn
  (user ruling 2026-09-10). Handoffs and specs are committed repo markdown, never web artifacts.
  Issues are tracer-bullet sized (one reviewable concern).
- **Standing preference — minimize adopter onboarding friction** (04). Decides package-manager and
  distribution questions against dev-side taste: the tool's own lockfile is a *shipped artifact*
  consumed by the shim, so it stays npm even though pnpm is the nicer dev experience. "Best
  available tech for a fresh repo" is explicitly **not** the governing preference where the two
  conflict.
- **A client's stack is the client's business** (04). The client's tests, package manager, and
  language are reached through its setup hook and its spec's verify commands; the tool never has an
  opinion. A PHP client with no node in its container is fine — the tool runs on the **dispatching
  host**, not inside the task container.
- **This repo holds the live map; hae's copy is a snapshot.** The extraction on 2026-08-21 was a
  **copy, not a move** — `docs/wayfinder/effect-agentbox/` still exists in hae and is now a fork that
  receives no updates. Every ticket from 16 onward, the `/to-tickets` pass over P2–P6, and every
  correction to these docs happen **here**. hae's copy stays only as the parity oracle's neighbour
  until P7 deletes it alongside `.agentbox`. This is easy to get wrong from muscle memory: the
  session that ran the extraction wrote ADR 0007's tripwire result into *hae's* T17 an hour before
  the move and had to be told twice which copy was live. If a doc edit is not in this repo, it did
  not happen.
- **Ticket layout**: this map and its tickets live here under `docs/wayfinder/` because
  `.agentbox/.gitignore` untracks `tasks/*/`. The T1–T4 *implementation* issues this map produces
  live alongside them at `docs/wayfinder/effect-agentbox/issues/`, **tracked** — revised by 04.
  They are this map's deliverable, not a per-dev queue, and `run.sh --feature` accepts a slash path
  as-is, so no dispatcher change is needed.

## Decisions so far

<!-- one line per closed ticket: enough to judge relevance, then open the ticket for detail -->

- [01 — TS distribution with uvx-equivalent guarantees](01-ts-distribution-model.md) — no `npx`
  form matches uvx; the answer is a ~40-line committed **clone-run shim** (shallow clone at a pinned
  SHA, `npm ci`, TS source run under node's type stripping). JSR and bun ruled out; node ≥ 24 floor.
- [02 — Effect's surface for a subprocess/resource orchestrator](02-effect-surface-for-this-tool.md) —
  both load-bearing claims hold: Scope release with four named gaps, and Layer/Context tests that
  subprocess mocks cannot express *if* services are domain-shaped. Cost: v3 is frozen, v4 in beta.
- [03 — Behavior inventory of run.sh + tasklib.py](03-behavior-inventory.md) — the inventory later
  tickets navigate by. Two invariant gaps (unenforced no-ports; origin-URL userinfo); the hardest
  area to port is the dispatch core, the untested half with no oracle.
- [04 — Incubation mechanics inside hae](04-incubation-mechanics.md) — hae's dispatcher is not
  modified for its guest (the node-26 bump is the one exception); npm + vitest with `doctor` under
  plain node as the strip-safety check; issues tracked under `docs/wayfinder/`; move-out is
  `git filter-repo`, copy not move. The tool runs on the dispatching host, and a client's stack is
  the client's business. Lint graduated to 11.
- [05 — Effect architecture: services, error channel, Scope seams](05-effect-architecture.md) —
  twelve domain-shaped tags, the outcome-row test for typed error vs defect, one `Scope` opened after
  the guards, ownership by label with a reconciler, `--dry-run` as a layer swap, TOML config decoded
  once, clack for prompting; five design rules for the ADR. Q16R (2026-08-10): a failed agent pass
  ends the run, no retry.
- [06 — De-risking agent-written Effect](06-derisking-agent-written-effect.md) — `effect@3.22.1`
  pinned exact for the whole incubation; `typescript@7` + `@effect/tsgo` with Effect diagnostics on
  the single typecheck behind one `npm run verify`; `AGENTS.md` carries only what no diagnostic can
  catch; specs paste the layer composition to copy, not derive; a tripwire surfaces a decision the
  user makes, with Bessemer as the fallback.
- [07 — Settle the real name](07-name.md) — the name is **`speepobox`** (`@hireanesquire/speepobox`,
  org-owned): the only candidate free on both npm and GitHub, though availability stopped mattering
  once 01's shim made the package scoped. `bessemer` is the bake-off prize, so that rename is
  conditional and post-bake-off. Resolving before T1 collapsed 04's rename touch-points to three doc
  lines.
- [11 — Lint/format toolchain for the TS package](11-lint-format-toolchain.md) — `oxlint` + `oxfmt`,
  pinned exact, `typeAware` off. A T1 detail once 06 closed the floating-Effect gap in the typecheck;
  recorded because it unblocks 08 and fixes two stale premises (no isolation mechanism is needed;
  04's pre-commit `exclude:` edit was never made and is owed by T1).
- [08 — The in-hae tracer-bullet sequence](08-in-hae-sequence.md) — six bullets T1–T6 (T3 split where
  the `Scope` is fully acquired; `--dry-run` back in as T5), every one AFK-dispatched from T1,
  `IssueStore` deferred to 09, the bake-off decoupled from move-out and scored at T5 AND Bessemer F3,
  a six-gate move-out checklist. Re-sliced 2026-08-10 into T3–T17 in one `/to-tickets` pass.
- [09 — The post-move sequence](09-post-move-sequence.md) — seven bullets P1–P7 with hae as adopter #1
  installing via `init` at P7 (it has no organic traffic to soak on), P2–P6 self-hosted, CI the only
  gate, no release, the agent never merges, v4 conditional on GA, parity as a written checklist,
  ADR 0008 closing the bake-off. Amends 07: retiring the python port includes vacating its name, so
  `speepobox` renames to `bessemer` only after that repo moves aside. Amended 2026-08-19 with two
  guards owed — a selection the dispatcher did not name is a proposal (P2), and a dispatch refuses a
  dispatcher older than its base (P1). Amended 2026-10-02 by P6's F11: releases are hand-cut
  `v<N>` tags on green main commits, so Q4's "no tags" no longer holds; the pin stays a full SHA.
- [10 — Write the ADR and the spec](10-write-adr-and-spec.md) — **the destination artifact; landed**:
  ADR 0007 (confronts 0006's TS rejection verbatim and answers it in its own unit),
  [SPEC.md](SPEC.md), and Phase B2 in `.agentbox/ROADMAP.md` (deleted by T137; read it at
  `6f66e9ac891462de809d207822c77d8f27615663` in the archive). Two
  facts checked at write time changed the ADR: both of 03's invariant gaps were since fixed in bash,
  so the argument is shapes over checks, and the map's repair-`run.sh` out-of-scope item is moot.
- [12 — Test strategy for the port](12-test-strategy.md) — written into [SPEC §11](SPEC.md):
  Layer-faked `npm run verify` plus a host-only `verify:live` of five cases; the dispatch core's
  missing oracle is a 22-row failure-point matrix authored before T3; the signal matrix is a
  regression suite the bake-off borrows; the carried oracle is read, never executed.
- [13 — Prototype the clack picker](13-prototype-clack-picker.md) — 05 Q8 confirmed on real repo data
  with three amendments: options-getter + vendored scorer + explicit pass-through `filter`,
  clack-native cancel with `← Back` rows, and a TTY bracket that is signal passthrough rather than a
  manual raw-mode restore. T1's `package.json` unchanged.
- [14 — `Status: Done` conflates *approved* with *landed*](14-done-conflates-approved-with-landed.md) —
  issue state splits by scope and no store answers what it cannot know: `Done` means landed, written
  by the dispatcher on approval as a commit on the run branch and gated on the branch tip (stacked
  dispatch becomes legal); approved-awaiting-merge is derived from refs; the ledger stays derived
  state. Ruling in [`docs/agents/issue-tracker.md`](../../agents/issue-tracker.md), SPEC §2, and one
  HITL bash ticket.
- [15 — A dispatch names the work it will do](15-a-dispatch-names-the-work-it-will-do.md) — the
  dispatcher may replay a work set it recorded or execute one the command named, never compute one
  it did not: `--feature` requires `--issues` (`all` spells the wide form), a resume can only run
  some of what it ran before, feedback-only stays derived, guards split by what they ask around one
  post-fetch `BASE_SHA`, `/feature-issues` mounts from the checkout. bash gets nothing.
- [17 — Feedback that forbids leaves no trace](17-feedback-that-forbids-leaves-no-trace.md) — no
  conversation history: feedback is per-dispatch, nothing carries across rounds, and the agent does
  not read its own PR (a later credential mount must reopen this), because an accumulating channel
  has no revocation vocabulary. One bullet in [SPEC §8](SPEC.md); nothing built.
- [16 — What the tool keeps, and who deletes it](16-what-the-tool-keeps-and-who-deletes-it.md) — a
  run log is an audit trail kept indefinitely and nothing in the tool deletes one; rotation is
  deleted rather than repaired (each run writes `<slug>-<runId>.log`), a rehearsal writes no log,
  `gc` reports and never removes. Closes [T36](issues/T36-a-failed-runs-log-survives.md); landed
  2026-09-09 as T46–T48. Surfaced [20](20-the-agent-pass-narrates-nothing.md).
- [18 — Where the package lives, and what it is called](18-where-the-package-lives-and-what-it-is-called.md) —
  the package roots at `/`, renames from `speepobox` to **`bessemer`**, and stops anchoring anything
  to its own directory: `runtimeRoot` defaults to `<repoRoot>/.bessemer` and the client-override root
  becomes `repoRoot`. The record sweeps vocabulary and freezes evidence — `.agentbox/`, the two
  extraction records, ADRs 0007/0008 and `07-name.md` stay as written; everything else, closed
  tickets included, is swept, and `.agentbox/` keeps its name. The forced order's first step, the
  freshness source-set, landed as
  [T49](issues/T49-the-freshness-question-names-its-source-set.md); the remaining three became
  `T56`–`T63` in the `/to-tickets` pass of 2026-09-14.
- [19 — The tool serves a repo it does not live in](19-the-tool-serves-a-repo-it-does-not-live-in.md) —
  the served repo is named once by `--repo-root` at the composition root, and everything bessemer
  keeps in it — config, credential, prompt overrides, runtime state — lives in `<repoRoot>/.bessemer/`,
  this repo included; freshness applies only when self-hosted; a repo declares container environment
  with `sandbox-env-file`; a root conflation is caught structurally by a `check-bans` rule on
  `packageRoot`. Terms in [`CONTEXT.md`](../../../CONTEXT.md). Implementation folds into 18's step 3,
  deadline P6, the ban slice last, this repo's token moved by the operator after
  `.bessemer/.gitignore` merges.
- [20 — The agent pass narrates nothing until it ends](20-the-agent-pass-narrates-nothing.md) —
  narration returns as typed events parsed on the host from `stream-json`, a pass's answer is the
  result event's text, a failed pass writes its own log line with usage, bash's watch and heartbeat
  return as events, the console restyles after Claude Code. Six issues, T50–T55, re-sliced
  2026-09-11. Surfaced the image's unpinned CLI.
- [21 — The agentbox vocabulary: what moves to bessemer, and what is frozen](21-the-agentbox-vocabulary.md) —
  the whole mechanism vocabulary moves to `bessemer` as one break before P6: the ownership and
  image-input labels, the `bessemer-` container prefix, the `/bessemer` mount, the `BESSEMER_*`
  environment prefix, the image tag `bessemer`, and the `BessemerConfig` tag; every string the tool
  writes says `bessemer` from now on. 18's mention-versus-use rule holds with one sharpening — a
  mention follows its referent — so the frozen set is unchanged. Old images heal through doctor's
  own stale row; running containers are stopped by hand before the flip. Dissolves the
  container-name fog entry. One AFK issue,
  [T65](issues/T65-the-mechanism-vocabulary-is-bessemer.md).
- [22 — A dispatch that carries a prompt and no spec](22-a-dispatch-that-carries-a-prompt-and-no-spec.md) —
  a task may be stated inline with `--task "…"`: the same one-off run with nothing mounted at
  `/spec.md`, the text recorded on the ledger row and replayed by `--resume`, refused beside `<spec>`,
  `--resume`, `--feedback`, or when empty. Not a mode, not an entrypoint, and not 09 P2's computed
  selection — the work is *named*, by text. **Task** replaces *work order* in the glossary (a spec is
  a task stated as a file), `prompts/` keeps its name, and `FeedbackOnly` collapses into the inline
  arm with the resuming framing keyed off the identity. P3's picker gets a third row. Two AFK issues:
  [T66](issues/T66-the-task-is-one-union-and-resuming-is-the-identitys-fact.md) (the collapse), then
  [T67](issues/T67-a-task-stated-on-the-command-line.md) (the flag).

### Settled during charting

Fixed by the destination-naming grill and never ticketed, so this map is their only home.
**These seven bullets are the whole section** — the ticket entries above are not part of it.

- **Bessemer is not replaced** — both ports proceed; a bake-off at one-off-dispatch parity
  decides. Bessemer's side is independent and unplanned here.
- **Destination is planning artifacts**, not a working skeleton — ADR + spec + two sequences.
- **Effect's load-bearing benefits** are (1) `Scope`/`acquireRelease` + the typed error channel,
  which make container teardown, lock release, and checkout cleanup type-enforced properties and
  delete the `set -e` bug class ADR 0006 named as bash's worst; and (2) `Layer`/`Context`, which
  turn "ops-as-library, CLI a thin renderer" from a convention into structure and make the
  rewritten half *better* tested than tasklib's subprocess-mock suite. `@effect/cli` and personal
  fluency are reinforcing, not justifying. The bake-off is scored on (1) and (2) — guaranteed
  cleanup under failure and dispatch-core test quality — not ergonomics or line count.
- **Top cost, acknowledged**: AFK agents writing Effect. Layer variance, `R`-channel inference,
  and 3.x API churn are where agents emit plausible non-compiling code — and this plan's whole
  leverage is agentbox dispatching agents to build agentbox. Ticket 06 de-risks it.
- **Incubation location**: a self-contained top-level dir with its own `package.json`, tsconfig,
  test runner, and lint config — no hae workspace coupling, so `git subtree split` lifts it out
  with history.
- **Move-out bar**: one-off dispatch **plus** feedback-resume. Without resume, every review cycle
  after the move is manual.
- **Finish line** (post-move sequence): feature parity, hae switchover with the old `.agentbox`
  core deleted, and adopter install — mirroring F4–F7.

## Not yet specified

- ~~**The image's CLI is unpinned, and the stream parser now depends on its output format.**~~
  **Resolved 2026-09-30 by P5's E11** ([09](09-post-move-sequence.md), comment of that date): the
  image pins it. The Dockerfile template carries `ARG CLAUDE_CODE_VERSION=<exact>`, so a bump is a
  digest change that `init --diff` surfaces, and `doctor` does not learn the version. This repo's
  Dockerfile pins too (E12). Kept below as the reasoning.
  `image/image-inputs.sh:22` records the gap; 20 sharpened it — a CLI that renames an event or drops
  `--verbose` turns every pass into a "no result event" failure. T50's parser tolerates unknown
  types and T51's failure detail names the flags, so the question left is whether the image pins
  the CLI or `doctor` learns to check it, and neither is decidable until an adopter's image exists
  (P5). Surfaced 2026-09-10 by [20](20-the-agent-pass-narrates-nothing.md).

- ~~**The carried oracle has no end-of-life.**~~ **Resolved 2026-10-02 by [PARITY.md](PARITY.md)**:
  every row is marked, so parity is reached on paper, but the copy stays as the reference while
  P7's gate runs and is deleted in P7 once the gate passes. The same commit adds one `AGENTS.md`
  line pinning `src/`'s `run.sh:N` citations to the last commit that has the file. `.agentbox/` holds hae's bash dispatcher, carried whole
  as the parity oracle and read-never-executed (12). 09's atomic flip-and-delete happens **in hae**
  (Q11: *"it happens in hae, not the tool's own repo"*), and nothing in 09, the extraction manifest,
  or 12 says when **this** repo's copy dies. So it is a tracked directory of another tool's source
  that nobody owns and nothing retires. Probably belongs with P7 and the parity checklist — the
  oracle's job ends when no parity item is unmarked — but that is a guess, which is why it is here
  and not a ticket. Surfaced 2026-09-09 by
  [18](18-where-the-package-lives-and-what-it-is-called.md), which kept its name on the strength of
  310 citations resolving into it and then found nothing states when those citations stop mattering.
  [21](21-the-agentbox-vocabulary.md) is the neighbouring question and does not wait on this one: the
  directory is the largest thing frozen by the name rule, so ruling on the name while it still exists
  is the conservative order.

- ~~**The bash picker still reads the host tree.**~~ **Resolved by T83**: the port's picker asks
  branch first and reads the folder at its tip. 14's ruling moved issue state onto the ref, but
  `run.sh`'s no-arg picker runs *before* materialization, so both its "All / All unfinished" label
  and the ready set it offers come from whatever is checked out. It can offer an issue the tip
  already says is `Done`, and the dispatch then reports "no issues to run". Fixing it properly is
  the branch-before-issues reorder 14 already ruled for **P3, in TS** — so the open question is
  scope, not design: reorder bash now, or accept the divergence with an honest message and let it
  die at P3. Surfaced 2026-08-17 by the pre-dispatch review. **Scoped 2026-08-20: let it die at
  P3.** No bash work; the divergence is accepted for the handful of dispatches left before
  move-out.

- ~~**`--base` resolves before `git fetch origin`.**~~ **Resolved 2026-08-21 by
  [ticket 15](15-a-dispatch-names-the-work-it-will-do.md).** Mostly dissolved: the leaning here was
  *re-read the issue set after the fetch*, and 15's replay rule removes the need, since the set is
  named rather than read. What survived is the guard split — local/ref facts pre-fetch, one
  authoritative `BASE_SHA` and all issue-set expansion and validation post-fetch against the fork
  commit. Keeps `run.sh`'s cheap-local-validation-first invariant *and* freshness, with nothing
  validated twice.

- ~~**This repo cannot dispatch into itself yet, and nothing owns the reason.**~~ **Graduated
  2026-09-04 to [T40](issues/T40-this-repo-can-be-dispatched-into.md)**, which owns it: this repo's
  own Dockerfile, build script, and declared inputs at the repo root — never in `.agentbox/`, which
  is hae's carried oracle and whose 182 line-number citations a second Dockerfile would make
  ambiguous — plus its own `image` and `base` in `config.toml`, and hae's two values retired from the
  package's code defaults on `image-build-command`'s existing rule. Kept below as the reasoning the
  ticket rests on. Surfaced 2026-08-21
  reviewing what P1 still owes. Three defaults still name hae: `defaultConfig.image` is
  hae's image name, `defaultConfig.base` is `"origin/master"` against a repo whose default branch is
  `main`, and `config.toml`'s `image-build-command = ".agentbox/build-image.sh"` names a script whose
  inputs (`.agentbox/image-inputs.sh` — hae's backend and frontend lockfiles) were cut in the
  extraction, so it cannot run here. T34's rehearsal recorded the image half; none of it is anyone's
  work item. It matters because **P2–P6 are bessemer dispatching itself out of this repo** (09 Q11),
  so no image means no P2. 09 mentions the image trio only as adapter-template reference material and
  never says what the tool's own image is. **Sharp enough to ticket** — it is here rather than as a
  ticket only because it was found the same hour this section was last edited. **Narrowed 2026-09-04
  by the probe**: pointed at hae, all three defaults are correct and the machinery around them works
  — the image was found, `image-build-command` resolved against the served repo and named hae's own
  script in `doctor`'s failure row, and `origin/master` produced the right diff boundary. So nothing
  here is a design gap; what is missing is only this repo's own answers, which is a smaller thing
  than it read as.

- ~~**Two dispatchers can still kill each other's containers by name.**~~ **Dissolved 2026-09-18 by
  [21](21-the-agentbox-vocabulary.md)**, as a side effect of the vocabulary move rather than by a
  design of its own: hae's bash removes by constructed name (`cid="agentbox-$slug"`,
  `.agentbox/run.sh:581,1530,2279`), a port container named `bessemer-<slug>` is unreachable from
  that line, and the port's queries were label-only already. Holds as long as bash keeps its prefix,
  which is until P7 deletes bash. Kept below as the hazard T65 closes. [05](05-effect-architecture.md)
  retired the `agentbox-` name prefix as an *ownership* signal and replaced it with labels, which the
  probe confirmed working — the container carried `agentbox.repo=sha256(repoRoot)[:12]`, correctly
  scoped to the served repo. But the port still *names* containers `agentbox-<slug>`
  (`CONTAINER_PREFIX`), and hae's bash dispatcher still sweeps by that name prefix. So the label
  direction is safe and the name direction is not: a bash sweep can kill a container this package
  started. Harmless today because the two serve different repos, and **exactly not harmless at P7**,
  where they serve the same repo through the parallel-run gate 09 adopted from ADR 0006 — a gate
  whose whole design is the two dispatchers running side by side with runtime roots still split.
  Surfaced 2026-09-04 by [the probe](research/09-p1-hae-probe-findings.md).

- ~~**Prompting without reference to a spec.**~~ **Graduated 2026-09-18 to
  [22 — A dispatch that carries a prompt and no spec](22-a-dispatch-that-carries-a-prompt-and-no-spec.md).**
  Surfaced 2026-08-21 while resolving 15, which considered a `--feedback-only` that *suppresses*
  recoverable work and rejected it as the wrong vehicle for a general capability. 22 asks what a
  dispatch that carries a prompt and no work order *is* — a mode, an empty selection, or a different
  entrypoint — against 09's P2 selection refusal and its P3 softening.

- **A repo cannot ask for writable container storage.** Probe finding 8: bash gave hae an anonymous
  `client/node_modules` volume, a shared `/yarn-cache`, and a root `chown` for both; the port has
  none of it, and `SandboxMount` has no mode on purpose.
  [19](19-the-tool-serves-a-repo-it-does-not-live-in.md) built nothing. It did not bite the probe,
  T40's hook runs `npm ci` into the bind-mounted workspace, and the only prospective consumer (hae
  at P7) wants it for speed, not correctness. A cache that survives between runs is also a trust
  edge: run N writes what run N+1 executes. **Any design keeps one constraint: docker-managed
  volumes only, never a writable host directory, and `SandboxMount` stays mode-less.** Graduates when
  an adopter's spec is shown to be blocked. Surfaced 2026-09-10 by 19. [PARITY.md](PARITY.md)
  marks bash's two volumes `deferred` on this entry (rows 1.37, 4.7), so it does not gate P7.

- ~~**Cross-round feedback context.**~~ **Graduated 2026-08-21 to
  [ticket 17 — Feedback that forbids leaves no trace](17-feedback-that-forbids-leaves-no-trace.md),
  and closed the same day.** Resolved as a negative: no history, per-dispatch upheld, nothing built.
  Dead rather than deferred — see the Decisions entry above.

- ~~**Blocker gating for untracked issue queues.**~~ **Resolved 2026-08-20 by scoping.** The hazard
  — a blocker marked Done host-side while its code sits unmerged — only reaches issue folders that
  are on no ref, which is hae's own `.agentbox/tasks/*/` (untracked by `.agentbox/.gitignore:11`)
  and not this map's tickets, which are tracked and so already get 14's protection. Ruling: **the
  port requires issue folders to be tracked.** Not a runtime check to build — a constraint the P5
  scaffold must honour, so the `.gitignore` template `init` generates never untracks the issue
  directory. bash keeps the gap; it dies with bash. **Carried into P5 as E8** (2026-09-30): the
  template ignores by name plus one anchored `/*-edit-*/`, and a `git check-ignore` test over a
  scaffolded issue path pins it.

- ~~**Non-macOS/Linux posture.**~~ **Resolved 2026-08-20.** Smaller than it looked: the only
  macOS-specific thing in the port is the notifier, which already probes (`command -v osascript`)
  rather than assumes, and everything that was BSD-vs-GNU shell trivia in bash disappeared with the
  move to Node. Ruling: **macOS is the supported dispatching host at move-out; Linux is expected to
  work and gets verified by P1's CI.** Node ≥ 26 remains a dispatching-host prerequisite (04).

- ~~**Runtime-root leftovers that `gc` does not see.**~~ **Graduated 2026-09-29 to
  [T108](issues/T108-gc-lists-runtime-root-leftovers.md) and
  [T109](issues/T109-gc-force-removes-dead-leftovers.md).** Ruled: `gc` lists all three and
  `gc --force` removes the dead ones; the reconciler does not sweep them, because they block nothing
  and an editor directory holds the dispatcher's own text. Each is judged by a witness its name
  carries, **never by age** (T20, T26): a `.claim` by the pid in its name, a `<slug>.index` by
  whether its slug holds a lock with a live owner (the index is only ever written under that lock),
  and an editor directory by a pid now written into its prefix (`<purpose>-edit-<pid>-XXXXXX`). An
  editor directory from before that change carries no pid, so `--force` leaves it and prints the
  `rm -rf` for a human. Kept below as the reasoning. bash's `gc` knew three classes: containers,
  checkouts, and locks. The port writes three more kinds of file that a `kill -9` can strand, and
  no SPEC row assigns them to anyone:
  - the claim's temp file, `<lock>.<pid>.<attempt>.claim` (`lock/claim.ts`);
  - the status commit's scratch index under `locks/` (`statusIndexPathFor`, T77);
  - `--feedback-edit`'s `feedback-edit-XXXXXX/` directory (T84).

  All three name no live resource and block nothing. The comment in `claim.ts` already says that
  of a leftover `.claim`. So the open question is whether `gc` lists and removes them, and under
  which liveness rule: the pid in the claim's name, or age for the other two, which carry no pid.
  Eviction witnesses and markers are *not* in this bucket: the reconciler's sweep already owns
  them, and `gc --force` runs it (T100). Ruled out of P4 by the user on 2026-09-24 (the P4 quiz,
  D10).

- ~~**The salvage onto a branch that no longer exists.**~~ **Graduated 2026-09-29 to
  [T107](issues/T107-a-branch-that-cannot-be-read-sends-the-salvage-to-the-rescue.md).** Ruled: the
  candidate rule, widened — **any** failed read of `refs/heads/<b>` in the served repo, not only
  absence, sends the salvage straight to the rescue `<b>-from-run-<short>`, and the containment read
  after that fetch still authorizes the removal. `Rescued` carries why (`Refused` or
  `BranchUnread` with git's words), because "would not go onto `<b>`" is false of a branch that is
  not there. `gc --force` drops its D11 skip and calls the salvage like the other two call sites.
  The read-then-fetch window is accepted: it is human-deletion timescale. The land's own fetch onto
  a branch deleted mid-run is **out of scope** (see *Out of scope*). Kept below as the reasoning.
  `salvage` (`dispatch/checkout.ts`) fetches
  `refs/heads/<b>:refs/heads/<b>` first, and git creates an absent destination unconditionally
  (AGENTS.md, T29). So when a human has deleted `<b>` since the copy was made, the salvage brings
  the branch back, answers `WentHome`, and removes the copy. The candidate rule is that **an
  absent branch is not a destination**: the salvage goes straight to the rescue ref
  `<b>-from-run-<short>`, and the containment read after that fetch authorizes the removal. It
  would change the one function at all its call sites. It was not taken in P4, because the
  dispatch's acquire *can* reach an absent branch, though only through a race: `branchExists` runs
  before the lock and nothing holds the ref between the two. The release is exposed for the
  length of the run. T100's `gc --force` takes the conservative arm instead: a copy whose branch
  is gone is skipped loudly and never salvaged. Surfaced 2026-09-24 in the P4 quiz (D11).

- ~~**A hard reset whose agent commits nothing never pushes.**~~ **Graduated 2026-09-29 to
  [T105](issues/T105-an-empty-hard-reset-still-pushes.md) and
  [T106](issues/T106-a-branch-that-does-not-contain-its-remote-is-refused.md).** Ruled: the first
  way — a reset is a reset on both ends. The land still returns `nothing-to-land` and opens no PR,
  but under `--hard-reset` it then does the leased push, **only when `originTip` is some and is not
  the base** (an absent origin branch would be created at the base, and one already there would be
  a push that moved nothing), and emits `ResetPushed`. That does not reach a run that fails or is
  killed after the reset, which leaves the same divergence, so the third way is taken as well, as a
  general guard: every dispatch but `--hard-reset` refuses after the fetch when local `<b>` does not
  contain `origin/<b>`, with one sentence for *behind* (naming `git branch -f` to take origin's
  commits and `--hard-reset` to discard them) and another for *diverged*, which never offers the
  `branch -f` that would discard local work. Kept below as the reasoning. The land gates on `sinceBoundary`
  (`dispatch/land.ts`, `run.sh:1589-1592`), and under `--hard-reset` the boundary is the base, so
  a run that adds nothing returns `nothing-to-land` before the push. The local branch now stands at
  the base, but origin still holds everything the plan counted as discarded:
  - `BranchReset`'s line still says `N commit(s) discarded`, and N includes origin's commits,
    which were never touched;
  - the local branch and `origin/<b>` have diverged, so the next dispatch of `<b>` without
    `--hard-reset` does all its work and then fails at the push, because the push is not a
    fast-forward.

  bash has the same shape, since its `MERGE_BASE` is `BASE_SHA` too. There are three ways to go:
  push the reset anyway under the lease, so a reset is a reset on both ends; leave origin alone and
  make the line and the ledger say only the local branch was reset; or refuse the next plain
  dispatch early, before any work, when the local branch is behind or beside origin. A related
  point is that a rehearsal cannot show this path. Its `updateRef` is recorded, so the land reads
  the un-reset branch and prints `pushed: 0 new commit(s) this run, N total` where a live run would
  stop at `nothing-to-land`. That follows from recording writes over real reads (T15), and it is
  the cost of the layer swap, not something to fix here. Surfaced 2026-09-24 reviewing T101
  (PR #60) and its host dry run.

- ~~**P6's shim and distribution are unruled.**~~ **Ruled 2026-10-02 as F1–F21**
  ([09](09-post-move-sequence.md), comment of that date): `init` writes a committed `sh` shim at
  `.bessemer/bessemer`; the pin is a full SHA read by one line grammar from the committed config
  only; the package cache builds each entry beside its final name and renames it into place;
  releases are hand-cut `v<N>` tags, which amends 09 Q4; `bessemer upgrade` compares tag numbers;
  `doctor` gains an upstream row that never joins the preflight; and the shim–package call is a
  contract written in SPEC §6. Question 7's leaning was taken except for Renovate, which is left
  out. Kept below as the questions it answered. P6 had no decisions yet, only 01's shim design (a
  committed script that clones the package at `tool-sha` into a user cache, runs `npm ci` once,
  and runs `node <cache>/src/bin.ts --repo-root <repo>`) and its finish line: the `bessemer …`
  commands `init` prints work as printed (T117's finding). The questions a grilling owes, before
  `/to-tickets`:
  1. Who writes the shim: `init`, or the adopter by hand? E3 left it out of P5.
  2. Where it lives: committed in the repo (01) or on the PATH. Committed means `bessemer` is not
     a bare command unless something on the PATH finds it.
  3. How the shim clones `HireAnEsquire/bessemer`: under what credential, and is the repo public.
  4. How a repin works: a `bessemer upgrade`, or a hand edit of `tool-sha`.
  5. The cache: a directory per SHA, pruning, an interrupted `npm ci`, two first runs at once.
  6. The pin discipline E7 deferred: `init` only warns on a dirty package today.
  7. How an adopter learns upstream moved. Nothing tells them today: `dispatcher-freshness` runs
     self-hosted only (T60), and the adopter arm prints the pin and compares nothing. The
     leaning: releases are tags, so "behind" means something; `doctor` gains an upstream row
     (an `ok` row, never a `warn`); `bessemer upgrade` repins to the latest tag and shows
     `init --diff`; the README documents Renovate over `tool-sha`. No per-dispatch nudge unless
     `doctor` proves not enough.

  Surfaced 2026-09-30 when P5 closed.

- ~~**Whether the package goes public.** P6 keeps `HireAnEsquire/bessemer` private (F4), so an
  adopter is an org member whose git credential can read it, and the shim hard-codes the https URL
  with no token of its own. Going public would let an adopter outside the org bootstrap and run
  the shim with no credential at all, and it changes nothing in the shim. It is an act for the
  org, not a design question, and nothing in P6 or P7 waits on it: hae, adopter #1, is inside the
  org. Surfaced 2026-10-02 by P6's F4.~~ **Resolved 2026-10-14**: public as
  `HireAnEsquire/speepobox`, seeded from this tree; the private repo is the archive (T143).

- ~~**The `.gitignore` entries for runtime state are unanchored.**~~ **Graduated 2026-09-30 to
  [T119](issues/T119-the-gitignore-anchors-its-runtime-state.md)**, which also anchors
  `config.local.toml`, the same defect. Kept below as the reasoning. `logs/`, `locks/`, `checkouts/`,
  and `runs.jsonl` in `templates/.gitignore` (T113) and in this repo's `.bessemer/.gitignore` match
  at any depth, so a file or directory with one of those names under the tasks dir is ignored. That
  breaks MAP's 2026-08-20 rule that issue folders stay tracked, and T113's `check-ignore` pin does
  not probe it. The fix is a leading `/` on those four in both files, plus a pin case for
  `.bessemer/tasks/f/logs/x.md`. **`.env` stays unanchored on purpose**, so a stray credential file
  anywhere under `.bessemer/` is never committed. Changing the template bumps its version, which is
  free until an adopter holds a v1 stamp (P7). Surfaced 2026-09-30 reviewing T113 (PR #72).

## Out of scope

- **The land's fetch onto a branch deleted mid-run.** `land.ts` fetches the checkout back onto
  `<b>`, and git creates an absent destination, so a branch a human deletes while its own dispatch
  runs is recreated and pushed. **Ruled out 2026-09-29** while deciding D11: the land runs because
  the dispatcher asked for this branch, and a mid-run deletion is a human racing their own
  dispatch. [T107](issues/T107-a-branch-that-cannot-be-read-sends-the-salvage-to-the-rescue.md)
  changes the salvage only, never the land (T29: the rescue lives in the release, never the land).
- **Bessemer and the python port.** Independent effort, owned by the user; no tickets here.
  **Retired 2026-08-20** — the bake-off closed for speepobox
  ([ADR 0008](../../adr/0008-agentbox-port-bakeoff-closes-for-speepobox.md)), decided rather than
  scored. Retired means kept as a cold fallback, so this stays out of scope rather than becoming
  moot.
- **Phase C** (`.agentbox/ROADMAP.md`): multi-agent provider abstraction (codex/cursor), setup
  script v1/v2, model choice. Each needs its own grill; none blocks this destination.
- **Per-pass selection of prompt, model and thinking level.** **Ruled post-MVP 2026-09-14.** The
  wanted shape: a dispatch chooses *which* prompts run, in what order, and at what model and
  thinking level per pass — so a cheap pass drafts and an expensive one reviews, by declaration
  rather than by the pass loop's fixed ladder. Real, and wanted; it is the natural next question
  after T53 made a run's cost a ledger fact and T54 made each pass visible. It is out of scope
  because MVP is *one* repo dispatching with one ladder, and every root ruling (T56–T63) would have
  to be re-read against a config surface that does not exist yet. Revisit after the rename, with
  Phase C's model choice above — they are one grill, not two.
- ~~**Fixing the two invariant gaps ticket 03 found in the bash dispatcher**~~ (unenforced
  no-published-ports, and origin-URL userinfo). **Moot as of 2026-08-06** — ticket 10 verified both
  were repaired in `run.sh`, before the port, while this map was open.
  Nothing is owed to hae's queue. The TS port still enforces both *by construction* rather than by
  check, and ADR 0007 uses the contrast as its worked example of design rule 2.
- **ADR 0008 (the bake-off outcome)** — 09 fixed its form, venue (hae), scoring, and evidence
  artifacts, but it is written when the bake-off resolves, which is past this map's destination. Not
  a ticket.
- **The v4 migration itself** — 09 gave it a placement rule, not a slot. In the likely case (not GA
  at move-out) it becomes a follow-on issue in the new repo, after the finish line.
- **Parked items**: wave dispatcher, dashboard, Jira adapter, review-run skill, sizing tripwire.
  Parked for domain reasons that Effect does not change — notably, wave dispatch is parked
  because same-feature tracer-bullet issues deliberately overlap files, which structured
  concurrency does nothing to fix.


## Status log

<!-- How the map got here, moved out of Destination 2026-09-14 so a session reading for
     orientation is not handed six weeks of progress history. Append; do not read to act. -->

**Status 2026-08-07: the charted destination was reached and tickets 01–13 all closed.** Ticket 10
landed [ADR 0007](../../adr/0007-agentbox-effect-typescript-port.md), [SPEC.md](SPEC.md), and Phase
B2 in `.agentbox/ROADMAP.md` (deleted by T137; read it at
`6f66e9ac891462de809d207822c77d8f27615663` in the archive). Ticket
[13 — Prototype the clack picker](13-prototype-clack-picker.md) closed 2026-08-07, confirming 05's
clack ruling with three amendments (propagated into ADR 0007 and SPEC.md).

**The map has since been reopened, and is live.** Building the sequence surfaced decisions charting
could not have seen — the fog only lifts where the frontier has actually reached. Tickets numbered
**14 and up** are that second wave: 14 closed 2026-08-14, 15 and 17 closed 2026-08-21, **16 and 18
both closed 2026-09-09, and [19](19-the-tool-serves-a-repo-it-does-not-live-in.md) on 2026-09-10**.
**[20](20-the-agent-pass-narrates-nothing.md) closed 2026-09-10, and
[21](21-the-agentbox-vocabulary.md) opened and closed 2026-09-18, and
[22](22-a-dispatch-that-carries-a-prompt-and-no-spec.md) opened the same day and closed 2026-09-21,
leaving no live ticket.** 18 was taken before 19
because they shared one key and only 18 owned it, and 19 inherited 18's `runtimeRoot` ruling rather
than deciding it twice. That sequencing worked as written: 18's session was told the client-override
half was live and ruled on the key with it in hand rather than blind. 16 had been blocked by
[09's P1](09-post-move-sequence.md) — an edge this file-based tracker cannot express natively, which
16 stated in its header; P1's blocking half landed 2026-08-21 and 16 resolved against the tool's own
runtime root, as it was waiting to.

**20 is 16's discovery, and it is the second time a review finding outlived the ticket that made
it.** The port dropped bash's `--output-format stream-json --verbose` and has no replacement for
`stream-filter.py`, so a pass emits nothing until it finishes and **a killed pass emits nothing at
all** — every killed run to date wrote 80 lines and zero agent lines, against 260–495 lines and
31–84 for every run that finished. T9's review saw it, judged it *"only the liveness is missing"*,
and left it in a closed ticket's comment section; that judgement holds for a pass that finishes and
not for one that is killed, which is three of this repo's eight runs. It matters now because 16
committed to keeping every log indefinitely on the grounds that a failed run's log is its only
witness — and for those runs the witness is nearly empty.

**P1's blocking half is done as of 2026-08-21, and this repo is the evidence.** The extraction ran,
CI and branch protection are up, and the runtime root is settled — which is all 16 was waiting on. So
**16 is takeable now.** See [T34's record](issues/T34-extraction-rehearsal.md) for what the move
actually produced. Of P1's remaining items the repin discipline landed 2026-09-04 as one rule in
[SPEC §6](SPEC.md) — *a SHA is fit to pin when it is on default with CI green* — and **the hae probe
ran 2026-09-04**. **[T40](issues/T40-this-repo-can-be-dispatched-into.md) landed 2026-09-08** — this repo's own agent
image and base, HITL because it is what makes AFK possible here. `doctor` is green on every probe and
the first self-dispatch ran end to end, so **this repo can now dispatch into itself.**

**P1's dispatcher-freshness guard is complete as of 2026-09-08 (T42, T43, T44, T45) and correctly
scoped as of 2026-09-09 ([T49](issues/T49-the-freshness-question-names-its-source-set.md), PR #9),
so the item below is settled history rather than an outstanding debt.** It reads as owed because it
was, for six weeks; what follows is how it was paid, and T49 is where the scope it asks about stopped
being "the package directory" and became a named source set.

What P1 owed was the dispatcher-freshness guard, which must precede the first P2 dispatch. It
was authored as T41 and **its dispatch failed the same day**: 900s of implement pass, nothing
committed, because nothing in it typechecks until most of it is in. It was re-sliced into three
tickets that each go green alone —
[T42](issues/T42-doctor-asks-whether-the-dispatcher-is-stale.md) (the question, with `doctor` as its
first caller), [T43](issues/T43-every-row-records-the-dispatcher-that-ran-it.md) (the ledger field),
and [T44](issues/T44-a-dispatch-runs-a-dispatcher-no-older-than-its-base.md) (the preflight refusal,
blocked by both). T41 itself is [source material now](issues/superseded/dispatcher-freshness.md): the
analysis held, the decomposition did not.

**T42 and T43 both landed 2026-09-08** (PR #2, PR #3), and the re-slice is what made them land: each
was a two-piece ticket that went green on its own, where T41 had been five. T43 proved itself on the
next run — the first row in this repo whose failure names the dispatcher that wrote it,
`"dispatcher":{"revision":"c778311","dirty":false}`.

**T44 took two dispatches and both were killed at the wall, and neither is a repeat of T41.** The
first committed *two green pieces*: `Git.dispatcherFreshness` — the tag's caller of T42's pure
module, so the preflight and `doctor` cannot answer differently — and `staleDispatcherOverridden` on
the record, threaded to the finalizer but not yet set by anything. That is an **expand step** in
`/to-tickets`'s sense, both new forms beside the old with no consumer, and the agent chose the shape
on its own, so it was merged rather than discarded and the ticket re-aimed at the migrate. The
second dispatch then committed the whole migrate — the refusal, the flag, the render case, the row —
**four seconds before it was killed**, green under `npm run verify`.

**The sizing rule this bought was wrong, and the second T44 run is what disproved it.** The claim
here was that 900s holds a two-piece ticket with room and refuses a four-piece one. It does not hold
anything with room. The two passes that finished used **91% and 95%** of the budget; the three that
were killed include one whose scope was complete and green at the buzzer. A wall that lands
mid-completion says nothing about the size of what it cut, so the timeout was never doing the sizing
work it was credited with, and the advice it printed at the kill ("re-slice before re-dispatching")
would have re-sliced a ticket that was already the right size. **The pass timeout is raised to
1800s**, and the kill message now sends the reader to the branch before it sends them to the ticket.
What the pass committed is the evidence; the timeout alone is not. The remaining tail of T44 — the
tests of the behaviour it wired, which the buzzer cut off — is
[T45](issues/T45-the-stale-dispatcher-refusal-is-under-test.md), and it is the first ticket to run
under the new budget.

**T45 finished in 23% of the raised budget, which refutes the account first given for the raise.**
That account was that a pass *expands to fill* whatever it is handed — the only reading that seemed
to fit five runs clustering between 91% and 100%. T45 was handed 1800s and used **415**, approved in
review round 1, ten minutes end to end. A pass leaves slack when it has slack, so the clustering was
five genuinely large tickets and not an elastic pass, and 900s was a wall standing a few percent past
where those tickets finished — the worst place a wall can stand. The raise stands on the T44b
evidence alone. The correction is to the *inference*: budget-used is worth reading after all, just
never at the wall. 23% is real evidence that T45 was small; a kill at 100% is a fact about the wall.

**T39 is the second reading, and the stronger one: 1231s of 1800, 68%.** T45 could be waved off as a
ticket small enough that any budget would have held it. T39 was not — five commits, a new pure
module, a new `Git` read, a production probe moved onto it, and every `gh` call resigned — and it
still left 569s unused. Two runs now leave slack in proportion to what they were asked for, which is
what a pass that does not expand looks like from the outside. The pair also fixes the reading of the
old cluster: 91% and 95% were not near-misses to be rescued by a bigger number, they were two large
tickets against a wall that happened to stand just past them.

**T46, T47, and T48 are the third reading, and they retire the sizing question rather than adding to
it: three dispatches, three first-round approvals, no kill.** Implement-pass times of **410s, 391s,
and 653s** against the 1800s budget — 23%, 22%, 36% — run end to end in 551s, 500s, and 803s. The
spread is the point. The three are one decision's implementation split three ways, and what each pass
spent tracks the number of interlocking pieces it was handed: T46 moves one function and threads one
field, T47 deletes a code path and re-keys one derivation, T48 changes a type and moves seven
readers — and T48 is the one that cost over half again as much. **Piece count is what predicts the
outcome, not ticket length**: T41 was five interlocking pieces and was killed with nothing committed,
T44 four and was killed twice, while T42, T43, and T45 were two each and landed. Length predicts
nothing — these three ticket files are among the longest written here, and all three landed clean.
The corollary for the `/to-tickets` pass over P2–P6 is a slicing rule, not a budget one: **slice by
how many things must be true at once, and stop at three.**

**[T49](issues/T49-the-freshness-question-names-its-source-set.md) is the fourth reading and it
splits the measure in two.** It landed 2026-09-09 (PR #9) on an implement pass of **343s — 19%, the
cheapest of the four** — against 732s end to end, and it is a one-piece ticket by the rule above: one
derivation restated in one pure module, spread at two callers, plus a guard. The pass cost tracked
the piece count exactly as predicted. **What did not hold is the approval half.** T49 is the first
ticket since T45 to need a second review round — round 1 came back `fixed`, and the two commits it
produced were real work rather than polish: the real-git coverage the acceptance criteria asked for,
and a leftover *"package directory"* fact in `dispatcher-revision.ts` the sweep had missed. So
**piece count predicts what a pass costs; it does not predict whether the first round approves.**
The three-way run of first-round approvals across T46–T48 read as one property and was two, and the
second one is about how much a ticket asks the agent to *notice* — T49's criteria named cases that
had to be asked of real git rather than a fake, and the first pass answered them with the fake it
already had.

**The stacking hazard did not materialise across any of the four runs**, and from T45 onward the
guard rather than the discipline is what catches it. T44's header names the hazard — the ticket is
the thing the guard exists to catch, dispatched off a base that must already carry its blockers —
and what stood in for the guard each time was a `git rev-list --left-right --count` by hand. T45 was
the first dispatch the guard could refuse on its own, and it said nothing — dispatched from a `main`
level with `origin/main`, the verdict is `Current` and a `Current` verdict is silent by design. The
guard has now run in anger once and stayed out of the way, which is all a passing case can show; it
has still never fired.

**The probe is where 19 came from, and it earned its keep.** 09 bought an early throwaway run to
recover the second-client signal that switching over last would otherwise lose, and it produced both
halves at once: the pipeline works end to end against a repo the tool does not live in — implement,
review-approved, fetch-back, push, six minutes — and every root it resolves against is its own
rather than the served repo's. Full write-up in
[research/09-p1-hae-probe-findings.md](research/09-p1-hae-probe-findings.md). One finding was carved
out as an implementation ticket rather than a decision, because its fix is determined and it is the
one with a safety consequence: [T39](issues/T39-the-forge-names-the-repo-it-opens-a-pr-on.md) — `gh`
is scoped by nothing, so a PR lands on whichever repo the operator's shell was sitting in.
**Landed** (PR #5): `--repo` is now a required field on every forge operation's arguments, so the
scoping is unspellable-without rather than remembered, resolved once at the composition root and
refused at a guard that holds nothing.

**T39 also absorbed a second copy nobody had noticed, and finding it is what re-aimed the ticket.**
The ticket was first written as though nothing read a remote's URL yet. `doctor`'s probe 5 did —
shelling `git remote get-url origin` around the `Git` tag rather than through it — which makes T39 a
*one-definition* ticket in T42's shape, not a first-reader one. The agent went one better than the
correction asked for: rather than two callers of one definition, `doctor.ts` performs the read once
and hands the result to probes 5 and 6, so the `gh` row can name the repo it would act on without
asking again. The near-miss is the point — the wrong version of this ticket would have shipped a
third copy into the exact module the ticket exists to stop being unscoped, and what caught it was
grepping the repo instead of the file the answer was expected in.

**The sweep has not run.** It is unauthored on purpose, following 16's precedent, and goes through a
`/to-tickets` pass with a forced four-step order — the freshness source-set first, because that one
is a pre-existing defect rather than a cost of rooting, and rooting makes it fatal.

**19 closed 2026-09-10 and rides the same pass.** The served repo is named by a `--repo-root` the
shim passes; everything bessemer keeps in it — config, credential, prompt overrides, runtime state —
lives in `<repoRoot>/.bessemer/`, this repo included; and freshness becomes a question only a
self-hosted dispatch asks. Its implementation folds into the sweep's step 3 with ordering inputs of
its own (see the Decisions entry). The vocabulary for the roots now lives in the repo-root
[`CONTEXT.md`](../../../CONTEXT.md).

**T56–T62 landed 2026-09-14 (T56) and 2026-09-15 (T57–T62); T63, the name sweep, is the last of the
pass and is HITL.** Scoping it opened [21](21-the-agentbox-vocabulary.md), the map's only live ticket: 18 swept
the word `speepobox` and said in terms that it was not sweeping `agentbox`, which is still the name
of the ownership labels, the image's digest label, the container prefix, the setup-hook mount, the
config environment prefix, and the central config tag. The question is one ticket rather than a fog
entry because it can already be stated exactly — the whole set is enumerated, with the read-back
sites that make it move as one — and because it carries a deadline that fog cannot express: **before
P6**, on 09's rule that the shim's adopters pin what they see. The proposal that opened it was to
fold the environment prefix into T63, and the two premises behind that proposal were both false; the
ticket records them so they are not offered again.

**T63 landed 2026-09-18 and closed the T56–T63 pass, and the same day three review findings that had
been living in closed tickets' `Status:` lines were moved somewhere a later session will find them.**
T61's lexical containment (a symlink inside the repo pointing out satisfies `sandbox-env-file`'s
guard, which is left as it is) is now [SPEC §6](SPEC.md); T62's two evasions of the `packageRoot`
ban (a namespace import, and `packagePathspec`) are now [SPEC §9](SPEC.md), which says the ban
catches the spelling rather than every route so a green `verify` is not mistaken for a proof; and
`AGENTS.md`'s citation of the twelve tags moved from SPEC §3 to §2, where they are. T52's two
unaddressed CodeRabbit findings became
[T64](issues/T64-the-write-watch-reads-the-command-not-the-sentence.md) instead, being code rather
than a sentence. **A finding recorded only in a closed ticket's status line is not findable** — the
next pass reads the map and the spec, not thirteen closed tickets — which is why these moved rather
than waiting to be folded into the P2–P6 `/to-tickets` pass, whose scope does not contain any of
them.

**21 closed 2026-09-18, the day it opened, and every question went at its recommendation.** The
round added two things the ticket did not have: the operator's environment already carried both
prefixes (`BESSEMER_LIVE_IMAGE` beside `AGENTBOX_IMAGE`), which turned "should group 1 move" from a
preference into the removal of a half-state already in the tree; and the container rename reaches
the *Two dispatchers can still kill each other's containers by name* entry, which was waiting on a
design and got none — bash removes by a constructed `agentbox-$slug` and the port's containers stop
answering to it. The sweep is [T65](issues/T65-the-mechanism-vocabulary-is-bessemer.md), AFK where
T63 was HITL, because `agentbox` in a living document has no "was chosen because" sentences to
tell apart; the operator holds the image rebuild and `verify:live` at merge.

**T65 landed 2026-09-18, and the mechanism vocabulary is `bessemer`.** Sixty files, 271 insertions
against 267 deletions — the shape of a rename rather than a change — with each of the seven
writer/reader pairs moving in a single commit, so no commit on the branch left a label stamped by one
spelling and read by the other. **The operator's half is what actually proved it**: `npm run verify`
cannot see a label on an image, so the gate was a rebuild through `image/build-image.sh` and a
`doctor` run that recomputed `bessemer.inputs.digest` over the declared inputs and matched it against
the stamp. No `agentbox.managed` container survived on the host to be stranded by the flip, which the
ruling accepted but could not promise. The one defect was authored into the ticket rather than found
by it — the moves list swept a sentence the stays list had frozen in two other files — and the
restored copy now carries the reason it stays, on the same principle T63 established: a swept tree
makes the surviving old spelling look like an oversight, so it has to say why it is not. **`agentbox`
now survives here only where it names hae's bash dispatcher or this port's own history**: sixty-two
lines under the audit path, each enumerated on PR #25. This map is not among them — `MAP.md` sits
outside the audited set, and its remaining hits are ADR filenames, the frozen fog entry, and this log
talking about the word.

**That closes every implementation ticket the map has authored, and `T1`…`T65` are all Done.** The
last act the map owes is the **P2–P6 `/to-tickets` pass**, which nothing now blocks.

**Status 2026-09-21: [22](22-a-dispatch-that-carries-a-prompt-and-no-spec.md) closed, and two
implementation tickets are open again.** A task may be stated inline with `--task "…"`; the ruling
retired *work order* for **task** in [`CONTEXT.md`](../../../CONTEXT.md) and kept `prompts/` its
name. [T66](issues/T66-the-task-is-one-union-and-resuming-is-the-identitys-fact.md) collapses `FeedbackOnly` into the
inline arm and waits on nothing; [T67](issues/T67-a-task-stated-on-the-command-line.md) builds the flag on it; the P2–P6 pass above is still owed and still unblocked.

**Status 2026-09-21, later: P2 is sliced.** The `/to-tickets` pass over P2 authored
[T68](issues/T68-issue-files-parse-order-and-restamp.md) through
[T79](issues/T79-the-pr-body-carries-the-issue-checklist.md) — the pure issue layer (T68, T69), the
fetch prefactor (T70), `IssueStore` and its ref scan (T71, T72), the flags and the two-phase content
guards (T73), the two witnesses (T74), the per-issue passes and the loop (T75, T76), `markLanded`
(T77), the feature resume (T78), and the PR checklist (T79). Five decisions are recorded on
[09](09-post-move-sequence.md)'s comment of the same date. P3–P6 are
still owed their passes; P3 runs after P2 lands, against `IssueStore`'s interface.

**T68 and T70 landed 2026-09-21** (PRs #29, #28): the issue file parses, orders, and restamps as a
value, and every dispatch fetches `origin` once before it resolves its base — a rehearsal included,
which is the one write `--dry-run` now makes.

**T69 and T71 landed 2026-09-21** (PRs #30, #31): a selection is a value that answers either an
ordered set or every reason it cannot stand, and `IssueStore` reads that set out of a **ref** —
`ls-tree` plus one batched `cat-file`, never off disk, and never one child per file. `--issues all`
over this folder today means the whole T69–T79 chain in one run, which is what the wide form now
consents to.

**T72 and T73 landed 2026-09-21** (PRs #32, #33): *landed elsewhere* is derived rather than stored
— one `for-each-ref` and one batched `cat-file`, two git children whatever the ref count, measured
at 73ms over 553 object names on the dispatching host — and `--feature <folder> --issues a,b|all`
resolves a plan whose task is an ordered `IssueSelection`, read at the **branch tip** after the
fetch, with every refusal a `GuardRefused` before the lock. `--dry-run` prints the block and then
takes the scope-door refusal: the loop is T76's, so a rehearsal of a feature dispatch exits
non-zero until then. The frontier is [T74](issues/T74-two-witnesses-for-someone-else-has-this-issue.md)
and [T75](issues/T75-the-passes-are-told-which-issue-they-are-for.md); T75 is the critical path —
T76, and through it T77, T78, and T79, all hang off it — and T74, which turns T72's scan into a
refusal, blocks nothing, exactly as T72 did.

**P3 sliced 2026-09-22** into [T80](issues/T80-the-fuzzy-scorer-is-a-pure-module.md)–[T86](issues/T86-flags-seed-the-wizard.md):
the scorer alone (T80), the picker's spine and the package's first TTY surface (T81), the base step
and edit rows (T82), the feature row and the issues step read at the **tip** (T83), the editor
bracket as `--feedback-edit` (T84), the task and resume rows (T85), and flags seeding the wizard
with 15's softening (T86, `needs-triage` until SPEC §7 carries its paragraph). T84 blocks nothing
and runs beside the chain. ADR 0005's create-a-branch carve-out is deliberately unexercised (T81's
§12 entry). Two corrections to the brief this pass ran on: the prototype **is** tracked here at
`.agentbox/proto-clack-picker/`, byte-identical to hae's `proto/clack-picker`, and `@clack/prompts`
was already pinned with `Terminal.isTTY` already in the parser's requirements. P4 stays its own
bullet.

**T74 and T75 landed 2026-09-22** as PRs #34
and #35, merged the same day: `--issues all` is
now checked twice and an enumerated `--issues` skips both checks outright, and a feature run's three
messages name the issue they are for, over an issue set mounted at `/feature-issues` from inside the
checkout. Review found one thing that outlives its own ticket — **the read-only mount rules out a
second path to an issue file, never a second author**, since the same files are writable at
`/workspace/<folder>/issues`, so 14's *one author* is carried by T77's land-time write plus the
prompts and by nothing in the container. That is recorded on [T77](issues/T77-approval-lands-as-a-commit-on-the-run-branch.md) §2,
with the enforcement point named for whoever wants it enforced rather than asserted. The frontier is
now [T76](issues/T76-the-feature-loop.md) — the P2 critical path, with T77, T78 and T79 behind it —
beside [T80](issues/T80-the-fuzzy-scorer-is-a-pure-module.md) and
[T84](issues/T84-the-editor-bracket-feedback-edit.md), which open P3 and block nothing.

**06's tripwire: recommend closing it, unfired — the operator decides (09 Q9).** The sample 09
said completes at P3 cannot be read the way 06 wrote it, and what can be read answers the premise.
Three things, from `.bessemer/runs.jsonl` and the logs on 2026-09-22: **(1)** the metric was never
machine-readable — a row's `terminalReason` is `Failed { stage }` with no cause, so an Effect error
and a `529` are one value; **(2)** the denominator drifted — 08 priced one issue per bullet, and P2
alone is twelve tickets; **(3)** the data in hand: 42 rows over 37 branches, 35 of them single-run
and 32 of those approved. The three single-run failures (`speepobox-t41`, `-t44`, `-t44b`,
2026-09-08) have logs that end at the prompt — pre-T51, cause unrecorded. Every redispatch since
is T74 (approved on its third run) and T75 (approved on its fourth), and all five of
those failures are server-side — three `500 Internal server error`, two `529 Overloaded` — not
Effect errors. Twenty-five tickets landing is the premise *agents can't write this* answered; nothing
here fires the >half-needing-≥2-Effect-error-redispatches threshold, and nothing could have shown it
firing. This is a recommendation, not a closure.

**T76, T80 and T84 landed 2026-09-22** as PRs #38,
#36 and #37:
a feature run loops its issues, reads each boundary **in the container**, and records a failed pass
as that issue's outcome rather than the run's error; the fuzzy scorer is a pure module; and
`--feedback-edit` ships behind the TTY gate. Review findings outlive two of them: the T84
rehearsal prints no feedback row and can leave an empty runtime root behind (T84's Status, SPEC §7,
AGENTS.md), and `rankFuzzy` returns every match unbounded (recorded on T81). The frontier is now
[T77](issues/T77-approval-lands-as-a-commit-on-the-run-branch.md),
[T78](issues/T78-a-resume-runs-some-of-what-it-ran-before.md) and
[T79](issues/T79-the-pr-body-carries-the-issue-checklist.md) on P2, beside
[T81](issues/T81-no-args-on-a-tty-picks-a-spec-and-a-branch.md) on P3. The three P2 tickets all
extend T76's loop and land, so they run one at a time; T81 shares none of their files. Passes now
run on a pinned model — `.bessemer/env.sandbox` carries `ANTHROPIC_MODEL=claude-opus-5-5` through
T61's `sandbox-env-file`.

**T77 and T81 landed 2026-09-22** as PRs #39
and #40: an approved issue's `Status: Done`
now reaches the base as a dispatcher commit on the run branch, and a bare `bessemer` on a terminal
picks a spec and a branch. T77 was two tickets' worth — its first dispatch spent the 30-minute
implement cap and a resume finished it — and no feature run has exercised the status commit live
yet. T77's resume was the first run on the pinned model and read `models=claude-opus-5-5`.
[T79](issues/T79-the-pr-body-carries-the-issue-checklist.md) and [T82](issues/T82-the-base-step-and-the-summarys-edit-rows.md) were dispatched side by side the same
day. T79 is blocked by T76 alone and touches only `dispatch/pr.ts`: it never had to wait on T78,
though the frontier line first written here said it did.

**T78 was split 2026-09-22** before dispatch, at T77's size and for T77's reason. T78 keeps the
replay, a `resume (feature)` mode line, and two stopgap refusals.
[T87](issues/T87-an-empty-feature-flag-is-refused-as-empty.md) takes the empty-`--feature` fix,
[T88](issues/T88-issues-on-a-resume-only-narrows.md) `--issues` narrowing a resume, and
[T89](issues/T89-an-exhausted-resume-takes-feedback-as-its-task.md) the exhausted set taking
`--feedback`. T87 and T78 have no blockers between them and run side by side. T88 waits on both;
T89 waits on T78; T88 and T89 run one at a time.

**T82 and T87 landed 2026-09-22** as PRs #43
and #42: the picker asks for a base after the
branch and its summary re-runs a step and everything derived from it, and a `--feature` holding
nothing is refused as empty. T82 owes one hands-on check, a refused as-is base on a real terminal
(its Status). T79 went back on a resume the same day: its checklist printed each issue's id twice,
because `Issue.title` is the whole H1 and every H1 already starts with the id. T78 is still in
flight; P3's next is [T83](issues/T83-the-feature-row-and-the-issues-step-read-at-the-tip.md).

**T78 and T79 landed 2026-09-22** as PRs #44
and #41: a resume of a feature row replays the
ids its record left, re-read at the tip, and a feature run's PR body ends with its issue checklist.
T78's two stopgaps refuse `--issues` beside a feature resume and an exhausted set, and
[T88](issues/T88-issues-on-a-resume-only-narrows.md) and
[T89](issues/T89-an-exhausted-resume-takes-feedback-as-its-task.md) replace them, one at a time.

**T83 landed 2026-09-22** as PR #45: the
picker offers every feature folder, reads the chosen one at the branch tip, and hands on
`--feature <folder> --issues all|<ids>`. MAP's *bash picker still reads the host tree* is resolved.
One dead end is left, unticketed: a folder with nothing tickable still offers `Choose…` (T83's
Status). P3's next is [T85](issues/T85-the-task-row-and-the-resume-row.md), unblocked now; P2's is
[T88](issues/T88-issues-on-a-resume-only-narrows.md), then
[T89](issues/T89-an-exhausted-resume-takes-feedback-as-its-task.md).

**T85 and T88 landed 2026-09-22** as PRs #47
and #46. The picker's source step has its
four rows: a task typed into the editor and a run resumed from the ledger join the feature and
spec rows, and a resume asks no branch, issues, or base. `--issues` on a resume now only narrows the
recorded set; `all` and a row with no set refuse. P2's last ticket is
[T89](issues/T89-an-exhausted-resume-takes-feedback-as-its-task.md), unblocked now; P3's is
[T86](issues/T86-flags-seed-the-wizard.md), which needs triage and its SPEC §7 paragraph before it
can be dispatched. The editor's fixed filename is a new unticketed finding (T85's Status).

**T89 landed 2026-09-22** as PR #48: a resume
of a feature run whose recorded ids are all approved runs `--feedback` as an inline task, and
refuses without it. That closes P2's tickets. What P2 still owes is its first live feature run,
which is also T77's status-commit check. P3's last ticket is
[T86](issues/T86-flags-seed-the-wizard.md), which still needs triage and its SPEC §7 paragraph.

**P2's first live feature run landed 2026-09-23** as PR
#49, over a two-issue editor-and-review fix set:
two issues, each implemented and approved in round 1, the second's boundary the first's commit,
then T77's status commit stamping both `Done` before the push. P2 is done. Two earlier attempts
failed and taught two things. T76's boundary read was the first git command the package runs in the
container, and Docker Desktop's root-owned mount point made git refuse `/workspace`; the sandbox now
passes git's `safe.directory` for the mount as `GIT_CONFIG_*` constants, for every git in any
adopter's image. And the setup hook's output reaches no log and its step has no time limit, which a
stalled `npm ci` showed (T90).

**06's tripwire closed unfired, 2026-09-23, by the operator (09 Q9).** The count completed nowhere
it could fire: every redispatch on record was a server-side `500` or `529`, never an Effect error,
and P1–P2 plus five of P3's six tickets landed. The operator's ruling is that the TS port has won,
and that it replaces Bessemer for good. The python repo stays retired, not deleted (ADR 0008).

**T86 triaged 2026-09-23** and now `ready-for-agent`. SPEC §7's *Flags seed the wizard* paragraph
is the contract. On a terminal, only a *missing* answer opens the picker, raised as a new typed
`AnswerMissing`. A command line that states two of something, or gives a wrong value, is still
refused. The picker rebuilds the words for its steps, and hides any source row that the typed
flags would make the dispatch refuse.

**T86, T90, and T93 landed 2026-09-23** (PRs #51, #50, #52). With T86, P3's six tickets are done;
T91 is its cleanup, and T92 closes the gap T89 left in a feedback-only resume's row. The setup
hook's output now reaches the log under a `setup-timeout` budget, and `npm run lint` refuses an
import from `.agentbox/`. Owed by hand: a walk through the picker on a real terminal, covering
T82–T86.

**T91 and T92 landed 2026-09-23** (PRs #54, #53), and the picker walk-through was done the same
day. Every step behaved as specified except three, each now a ticket that can be dispatched at once:

- the TTY gate asks stdout alone where bash asks stdin (T94);
- the editor's file puts the dispatcher's cursor on a comment line (T95);
- a seeded `--branch` that does not exist ends the picker on git's raw error (T96).

The three can run side by side. T94 and T96 both touch `picker/picker.ts`, and T94 and T95 both
touch `SPEC.md`, but each pair edits different sections.

**T94, T95, and T96 landed 2026-09-23** (PRs #57, #55, #56). A prompt now needs a terminal at
both ends, the editor's file opens on an empty line above its comments, and a seeded `--branch`
that does not exist is refused before the first question. P3 is closed. P4 (`gc`'s force paths
and `--hard-reset`) is next and needs `/to-tickets`.

**P4 sliced 2026-09-24** into [T97](issues/T97-the-reconcilers-scan-is-a-value.md)–[T104](issues/T104-the-row-records-the-discarded-tip.md):
- two prefactors, each with its own green: T97 takes the scan out of the reconciler, and T98
  narrows the salvage to a checkout;
- `gc` lists (T99), then `gc --force` reclaims (T100);
- `--hard-reset` (T101), then three tickets that each extend it: its TTY confirm (T102), its
  feature arm (T103), and its ledger field (T104).

T97, T98, and T101 can start now. T102, T103, and T104 can run side by side once T101 lands. T102
and T104 both touch the checkout's acquire, but at different lines: T102 changes a sentence and
T104 adds the `Ref` write. The twelve decisions are recorded in
[09](09-post-move-sequence.md), and two of them are open items above.

**P4 landed 2026-09-25** (PRs #58–#65). `gc` lists what the host holds from runs that are over,
and `gc --force` reclaims it one slug at a time, under that slug's lock. It removes a checkout
only after the salvage proves the commits are somewhere else. `--hard-reset` resets the branch to
the base under the lock, pushes with a pinned lease, and asks before it discards on a terminal. It
works on a feature dispatch, and the ledger row records the tip it discarded. `gc --force` was
checked on the host against a run killed with `kill -9`: the lock, the container, and the checkout
were reclaimed, and the agent's commit went home first. Three items that came up in P4 stay open
above: the runtime-root leftovers `gc` does not see (D10), the salvage onto a deleted branch (D11),
and the hard reset that never pushes. P5 (`init`, its templates, and `init --diff`) is next and
needs `/to-tickets`.

**P5 ruled 2026-09-30.** The twelve decisions, E1–E12, are recorded in
[09](09-post-move-sequence.md). The scaffold lives under `.bessemer/`, tasks dir included:
- `init` writes only files that are absent;
- every scaffold file but the config carries a stamp line with a template version and a digest;
- `init --diff` reports each file as missing, current, or behind, and as pristine or edited.

The package owns the image build, as `bessemer image build` over a new `Sandbox.build`. There is
one digest recipe, a plain list of inputs, and the Dockerfile is an implicit input. The template
pins the agent CLI, which resolves the unpinned-CLI item above. This repo moves `image/` into
`.bessemer/image/`, and its image goes stale once. Terms are **scaffold**, **template**, and
**drift** in [`CONTEXT.md`](../../../CONTEXT.md). The editor-directory ignore line reached this
repo's `.gitignore` in its own PR.

**P5 sliced the same day** into [T110](issues/T110-the-image-inputs-list-is-a-value.md)–[T117](issues/T117-a-fresh-repo-is-scaffolded-end-to-end.md):
- the input list as a value, a prefactor (T110);
- `image build` over `Sandbox.build` (T111);
- this repo moving onto it (T112);
- the templates and their stamps (T113);
- `init` writing the scaffold (T114);
- `init` working out its config values (T115);
- `init --diff` (T116);
- a hand-run proof in a throwaway repo (T117, HITL).

T110 and T113 can start now. T111 and T114 follow them, and T115 and T116 run side by side once
T114 lands.

**P5 landed 2026-09-30** (PRs #71–#80, T110–T118). `init` scaffolds a repo that bessemer does not
live in, works out its config values, and `init --diff` reports each scaffold file's drift against
the package's templates. The package builds the image through `image build`, and this repo builds
its own that way from `.bessemer/image/`. T117 ran it end to end on the host against a throwaway
repo: scaffold, image build, `doctor`, and a dispatch that opened a PR, all on the first try. It
found two things. The Dockerfile template named no model, which T118 fixed (it names both homes,
`sandbox-env-file` and the image). And `bessemer` is not yet a command, which is P6's shim. The
`.gitignore` anchors are [T119](issues/T119-the-gitignore-anchors-its-runtime-state.md), which can
be dispatched now. P6 is next and needs a grilling before `/to-tickets`: its questions are under
*Not yet specified*.

**P6 ruled 2026-10-02.** The twenty-one decisions, F1–F21, are recorded in
[09](09-post-move-sequence.md). `init` writes the **shim**, `.bessemer/bessemer`, a stamped `sh`
script that passes `--repo-root` from its own location. It reads the **pin**, a full SHA, from
the committed config by one line grammar, which a TS module shares with `upgrade` and `doctor`
under one agreement test. It prepares each pin once in the **package cache** and renames the
entry into place, because `mv` nests a directory on a lost race. A **release** is a hand-cut
`v<N>` tag on a green main commit, which amends 09 Q4. `bessemer upgrade` moves the pin by tag
number, and `doctor` gains an upstream row that stays out of the preflight. The call between the
shim and the package is a contract in SPEC §6, held across versions by a test that runs every
shipped shim template. `v1` is cut when P6's last ticket merges, and a hand proof then runs the
README literally. The terms are in [`CONTEXT.md`](../../../CONTEXT.md). P6 needs `/to-tickets`,
starting at T120. Whether the package goes public is a new item under *Not yet specified*.

**P6 sliced 2026-10-02** as [T120](issues/T120-tool-sha-leaves-the-config-chain.md)–T130 and an adopter-install proof.
Slicing found three rulings it could not follow as written — F6's looping remedy, F18's empty
fixture, and F1's shim refresh — and 09 records each amendment. T120–T123 are prefactors and can
start at once; T125 opens the shim chain. `v1` is the operator's act once T130 merges green, and
an adopter's first install from it (since superseded, not carried) is the HITL proof against it.

**Parity checklist written 2026-10-02** as [PARITY.md](PARITY.md): 147 rows over 03's inventory
and the 22 bash commits after its snapshot, every row marked. Five rulings made with it: bash's
storage volumes `deferred`, `status`'s stale-lock list and the `--status`/`--doctor` aliases
`dropped`, notify's `0`/`1` aliases `diverged`, and the oracle copy deleted after P7's gate.

**F4 amended 2026-10-05** ([09](09-post-move-sequence.md), from
[research/09-shim-fetch-auth-findings.md](research/09-shim-fetch-auth-findings.md)): every git call
to the release URL authenticates through gh for that call only, falling back to the operator's own
credentials, so an SSH-only host needs no `gh auth setup-git`. Sliced as
[T132](issues/T132-the-release-fetch-authenticates-through-gh.md) and
[T133](issues/T133-git-reads-name-the-git-dir.md); `v2` is cut once both merge green, before P7.

**P7 ruled 2026-10-08** as G1–G14 ([09](09-post-move-sequence.md), comment of that date). Bash never reached hae's master, so retiring it is out of scope. hae
installs from `v2` on an install branch. The install has to pass a gate of five bessemer-only
dispatches based on that branch, the fifth a `kill -9` and reclaim, before one PR takes `.bessemer/`
to master. The gate amends 09 Q7: no parallel run, no parity bookkeeping, and no atomic commit.
Root in an adopter's setup is a script baked into the image (T136). Sliced the same day into the
hae install gate, the HITL install that holds the runbook (not carried), and three AFK tickets:
[T135](issues/T135-the-legacy-read-adapter-retires.md), free to start now;
[T136](issues/T136-setup-that-needs-root-is-documented.md), the root pattern for adopters; and
[T137](issues/T137-the-parity-oracle-retires.md), the oracle's deletion. The last two wait on
the hae install gate. The map closes, as a planning edit, once T135–T137 have merged.
