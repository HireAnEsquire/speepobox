# 13 — Prototype the clack picker

Labels: `wayfinder:prototype`
Map: [MAP.md](MAP.md)
Blocked by: — (**unblocked, on the frontier**)
Assignee: sbowles
Status: closed (2026-08-07)

Graduated during ticket [08](08-in-hae-sequence.md) on 2026-08-06, when the bake-off's timing raised
the question of what CLI surface exists to compare. Blocks nothing — runs in parallel with the
T-sequence.

## Question

**Ticket 05's clack ruling is unverified.** It was decided from documentation, not from a running
prompt, and it carries a load-bearing claim: that `@clack/prompts`' `autocomplete` /
`autocompleteMultiselect` *"closes the fuzzy gap 02 found — no homegrown filter prompt, no optional
fzf."* Ticket 02 had flagged fuzzy selection as an open UX problem; 05 closed it by reading a
changelog.

The picker is 1139 lines of `tasklib.py` today — 05 calls it *"the richest surface in the tool, and
where it is actually used"*, and its strength is part of why clack won over `@effect/cli` prompts. If
the claim is wrong, the picker design is wrong, and under the current sequence we find out in ticket
09 — **after the move, on the biggest surface in the tool.**

Build a throwaway clack picker against real branch and issue data and settle:

1. **Fuzzy fidelity.** Does `autocomplete` actually match gum + fzf at the fidelity today's picker
   gives? Match algorithm, ranking, behavior on a long branch list, keyboard feel.
2. **The TTY bracket.** Does the `Prompt` tag's `acquireRelease` restoring raw mode actually hold when
   a clack promise is abandoned on an external fiber interrupt? 05 accepted this as a known cost —
   *"abandon a clack promise on an external fiber interrupt and the terminal wedges"* — so verify the
   mitigation, not just the hazard. Also exercise `isCancel`, which is a sentinel rather than a
   rejection.
3. **`taskLog` under real volume.** 05 picked it to render agent-pass output "continuous output, last
   lines visible, cleared on success". Test it against a real agent pass's line rate, not a synthetic
   loop.
4. **Verdict on 05 Q8** — confirm or overturn. If overturned, name what replaces it and what it costs
   T1's `package.json`.

Reversal is cheap by design: T1 pins `@clack/prompts` per 05, and if this prototype kills it the
change is one dependency line. That is why this ticket blocks nothing.

## Secondary output — the bake-off's UI exhibit

Ticket 08 ruled that the bake-off scores only the map's two claims, and that the UI-cost asymmetry is
**reported alongside, never scored**. This prototype is what that report points at: Bessemer's handoff
commits to *"aim for clack-style polish; F5 evaluates a stdlib-ANSI prompts module that may retire
gum"* — it hand-rolls an approximation of clack under its stdlib-first posture, while the TS side takes
clack directly. Same target, very different cost, and the difference is a direct consequence of the
language choice.

## Answer

**05 Q8 CONFIRMED — clack stays, T1's `package.json` untouched — with three amendments and two
accepted divergences** (detail in Comments):

1. **Fuzzy fidelity holds in spirit, not letter.** The default filter is unranked substring; parity
   with gum+fzf needs the options-as-function getter, a vendored ~45-line pure scorer
   (prototype's `fuzzy.mjs`), and an **explicit pass-through `filter`** — without it the prompts
   wrapper silently re-applies its substring default *after* the getter's ranking (found by hand,
   missed by the harness; spec-worthy gotcha for AGENTS.md). "No fzf" upheld: zero subprocesses,
   and `--print-query` / quiet-until-typed / preselect-all all reproduced.
2. **Cancel model (user ruling): clack-native.** Esc and Ctrl-C both abort — clack collapses them
   into one sentinel anyway — and wizard back-navigation becomes a visible `← Back` option row per
   step (gum-menu precedent). The keypress tap explored during prototyping is dropped.
3. **The TTY bracket is signal passthrough, not a manual raw-mode restore.** 05's priced mitigation
   (acquireRelease restoring raw mode) measurably fails: the zombie prompt stays on stdin. Passing
   the fiber's interrupt signal into clack's `signal` option unwinds cleanly and is less code.

Accepted divergences: the checked-out branch is *disabled* rather than pickable-then-rejected, and
focus survives backspace-clear (fzf resets to top; clack keeps the focused item — no override
exists in 1.7.0, and forcing one would be tap-species hackery).

`taskLog` confirmed at real volume (942-line log, firehose and bursty pacing — "Claude Code
behavior"). Amendments propagated to ADR 0007's UI-posture section and SPEC.md (tag table §3, risk
table §13). Prototype: [`.agentbox/proto-clack-picker/`](../../../.agentbox/proto-clack-picker/),
to be captured on a throwaway branch; `fuzzy.mjs` is the one liftable module.

## Comments

### 2026-08-07 — AFK findings (prototype built and driven via paced-pipe harness)

Prototype lives at [`.agentbox/proto-clack-picker/`](../../../.agentbox/proto-clack-picker/) —
`npm install` then `npm run picker` / `npm run tasklog` / `npm run wedge -- A|B|C` (see its README).
Pinned exactly per the map: `@clack/prompts@1.7.0`, `effect@3.22.1`. Everything below was verified
against a running prompt fed real repo data (64 branches, 285 refs, agentbox-v2's 11 issues, a
942-line real agent log); the sandbox blocks pty allocation, so keystrokes went through paced pipes —
raw-mode-specific behavior is the one thing that still needs a real terminal.

**Q1 — fuzzy fidelity: 05's claim overturned in letter, upheld in spirit.** clack's default filter
is case-insensitive **substring** with **no ranking** (`core/dist/index.mjs:358` —
`label.toLowerCase().includes(search)`); `tsf` finds `tseff` in fzf and finds **nothing** under the
default (verified live: "0 matches"). So "closes the fuzzy gap outright — no homegrown filter" is
wrong as stated. What makes it right: passing **options as a function** hands the getter full control
of both membership and order (`this.userInput` is the query; no default filter is applied), and a
**~45-line pure scorer** ([`fuzzy.mjs`](../../../.agentbox/proto-clack-picker/fuzzy.mjs)) restores
fzf-grade behavior: `tsf` → `tseff` first, `hard` → `agentbox-hardening` first. All three tasklib
surfaces reproduced on that mechanism: ranked fuzzy branch pick with the current branch ⛔-disabled;
quiet-until-typed base step (empty at rest = `change:reload` parity, Enter accepts the default,
free text accepted iff git-resolvable); fzf `--print-query` parity via a synthetic
`+ create '<query>'` row when the query matches no branch. `autocompleteMultiselect` handled
preselect-all over the 11 real issues. **"No fzf" is upheld** — no subprocess anywhere.

**New finding 05 missed — the cancel-key collapse.** clack maps **both Esc and Ctrl-C to one
`cancel` action** resolving one `CANCEL_SYMBOL` (core aliases: `\x03` and `escape`). Today's wizard
is built on gum distinguishing them (Esc = `PickBack`, Ctrl-C = `PickAbort`; `_raise_gum_cancel`).
Recovered with a small stdin `keypress` tap riding the same events clack's readline emits, recording
which key caused the cancel: verified live — Esc at the base step returns to the branch step,
Ctrl-C exits 130. The tap belongs inside the `Prompt` tag.

**Q2 — TTY bracket: cheaper and *different* from what 05 priced.** clack's `CommonOptions` carries
`signal?: AbortSignal`, and its abort path runs clack's own close (raw-mode restore, listener
removal, resolve-with-sentinel). `Effect.promise((signal) => prompt({ signal, ... }))` passes the
fiber's interrupt signal straight through. Measured on interrupt-while-open:

- **A (no mitigation):** promise pending forever, keypress listener leaked, and the dead prompt
  *keeps consuming and rendering keystrokes* — the hazard is real and worse than "terminal wedges".
- **B (05's mitigation — acquireRelease restoring raw mode by hand):** restores the terminal but the
  zombie prompt persists identically to A, still fighting the next prompt for stdin. **Wrong shape.**
- **C (signal passthrough):** promise resolves with the cancel sentinel, zero leaked listeners, no
  zombie. **The bracket is one option field, not a hand-rolled restore.**

Raw-mode wedge on a real tty (the literal "terminal wedges" claim) still wants a 2-minute hands-on
check: `npm run wedge -- A` vs `-- C` (add `--wedge-for-real` to feel it; `reset` fixes it).

**Q3 — taskLog:** replayed 798 non-empty lines of `agentbox-hardening.log` at firehose rate — no
crash, last-N window renders, clears on `success()`, retained on `error()`. Pacing feel
(`npm run tasklog`, bursty ~40s replay) is a hands-on check.

**Q4 — verdict shape (to ratify hands-on): 05 Q8 CONFIRMED with three amendments.** clack stays; T1's
`package.json` is untouched (the scorer is a vendored pure module, not a dependency). Amendments to
carry into SPEC/AGENTS.md: (1) picker options go through an options-getter + pure scorer, not the
default filter; (2) the `Prompt` tag includes the cancel-key tap to keep back/abort wizard semantics;
(3) the Promise-boundary bracket is `Effect.promise((signal) => …)` passing the signal into clack —
**not** a manual raw-mode acquireRelease, which demonstrably fails to kill the zombie prompt.

Remaining before close: keyboard feel vs today's gum+fzf picker (`npm run picker`, and
`-- --substring` to feel the unranked default), real-tty wedge check, taskLog pacing look.
`bisect.mjs` in the prototype dir is debugging residue — delete freely.

### 2026-08-07 — hands-on pass: one bug caught, one ruling made

**Bug (user's fingers, harness missed it): the wrapper re-filters the getter's output.**
`@clack/prompts` injects its substring default whenever no `filter` is passed
(`prompts/dist/index.mjs:144` — `filter: t.filter ?? substring`), *even for options-as-function*,
and it runs **after** the getter's ranking. Net effect: the "fuzzy" picker silently degraded to
substring — `tse` matched, `tsf`/`sfb` returned nothing but the `+ create` row (whose label contains
the query, so it always survived). Every harness query had been accidentally substring-compatible.
Fix: pass an explicit always-true `filter` alongside the getter; verified `tsf` → `tseff` ranked
first and `sfb` → `resume-feedback`. **Spec-worthy gotcha**: an options-getter without an explicit
pass-through filter *works on most queries and silently isn't fuzzy* — precisely the
plausible-but-wrong class the port's design rules exist to catch. Goes into AGENTS.md with
amendment 1.

**Ruling — cancel model (supersedes amendment 2's keypress tap).** Clack-native cancel semantics,
user decision after feeling both: **Esc and Ctrl-C both abort the picker** (clack's one-sentinel
norm, matches clack-habituated expectations and the terminal-wide Ctrl-C instinct), and wizard
back-navigation moves to a **visible `← Back` option row** in each step's list — same pattern
today's gum menus already use (`_BACK_LABEL`). The keypress tap is dropped entirely; the `Prompt`
tag needs no key-level machinery. Decided without prototyping the row (user waived it). The
prototype still carries the tap — superseded, not representative.

**Other hands-on verdicts:** ranking feel good (even pre-fix); taskLog "moves fast, Claude Code
behavior is what I want" — confirmed; wedge C accepted as the required shape (no choice existed —
A and B both leave a zombie prompt on stdin; C is also the least code).

Amended amendment set for SPEC/AGENTS.md at T1: (1) options-getter + vendored pure scorer **+
explicit pass-through filter**; (2) clack-native cancel + `← Back` rows, no tap; (3) bracket =
`Effect.promise((signal) => …)` into clack's `signal` option.

### 2026-08-07 — final feel pass; closed

Post-fix ranking confirmed by hand (`tsf` → `tseff`, ranked not substring). One last divergence
surfaced and **accepted**: after backspace-clearing the query, clack keeps focus on the
previously-focused item wherever it lands in the restored list (core's cursor recovery), where fzf
snaps to the top. No override in 1.7.0; forcing one would be out-of-model hackery of the same
species as the deleted tap. Also confirmed the at-rest ordering is **recency** (last commit date,
newest first) — matching today's picker, not `git branch` alphabetical — with fuzzy-score order
while typing, ties breaking toward recency. Verdict ratified; ticket closed. ADR 0007 and SPEC.md
amended in the same change.
