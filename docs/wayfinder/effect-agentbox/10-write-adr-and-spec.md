# 10 — Write the ADR and the spec

Labels: `wayfinder:task`
Map: [MAP.md](MAP.md)
Blocked by: ~~01~~, ~~02~~, ~~03~~, ~~04~~, ~~05~~, ~~06~~, ~~08~~, ~~09~~ (all closed) — **unblocked, on the frontier**
Assignee: agent session (claimed 2026-08-06)
Status: closed (2026-08-06)

## Question

The destination artifact. Assemble what every closed ticket decided into:

**`docs/adr/0007-agentbox-effect-typescript-port.md`** — must:

- confront ADR 0006's explicit TS rejection head-on. That ADR killed TS with "port-to-python
  rewrites only the untested half, port-to-TS rewrites everything including the proven half."
  The counter-argument on record is that `Layer`/`Context` turn the rewrite of the proven half
  into an upgrade rather than a loss. State it, and state honestly what is still lost.
- record the load-bearing rationale (scoped resources + typed errors; Layer/Context as the
  ops-as-library seam) separately from the reinforcing rationale (`@effect/cli`, fluency).
- record the costs as decided, not minimised: agent-written Effect, distribution regression
  versus uvx, supply-chain surface, front-loaded T1.
- fix language, distribution model, config format, layering posture, and the UI posture.
- restate which security invariants from ADR 0004/0005/0006 are unchanged and mandatory —
  including the two gaps ticket 03 surfaced in the bash spine (unenforced no-published-ports; the
  conditional origin-URL token exposure) and the note that invariant 3's hardened `upload-pack` is
  inherited from upstream git rather than set by agentbox.
- record the bake-off criteria and what formally closes it.
- list rejected alternatives with reasons, in the house style.

**The spec** — the shape agreed in 05, at the fidelity an implementing session needs: service
boundaries, error taxonomy, Scope seams, config precedence, CLI surface, prompt packaging, test
strategy.

**The two sequences** from 08 and 09, recorded where the roadmap lives.

Map is done when this lands and an agent session can start T1 with no decisions left.

## Answer

Resolved 2026-08-06. Three artifacts landed; two facts checked at write time changed what they say.

### Delivered

1. **[`docs/adr/0007-agentbox-effect-typescript-port.md`](../../adr/0007-agentbox-effect-typescript-port.md)**
   — reverses 0006's TS rejection **for a second, parallel port**, quoting the rejection verbatim
   and answering it in its own unit — the "proven half" is 49% picker, which both roadmaps rewrite
   anyway, and the carryable tests become plain functions here while the *shape* that does not carry
   is exactly the subprocess mocks a `Layer` fake beats — before stating what is still lost (337
   tests and 2325 working python lines discarded; two rewrites in one quarter; node ≥ 26 as a
   *new* host dependency python never added; no `uv`-equivalent that fetches the runtime;
   agent-written Effect unmeasured).
   Rationale is split as the ticket required: load-bearing = Scope + typed errors, and Layer/Context
   as the ops-as-library seam; `@effect/cli`, clack, and fluency recorded explicitly as
   **reinforcing, not justifying**, so the bake-off stays falsifiable. Costs recorded as decided:
   agent-written Effect with its tripwire, the distribution regression versus uvx, the supply-chain
   growth away from 0006's stdlib-first posture, and front-loaded T1. Fixes language, distribution
   model, config format, layering posture, and UI posture (the UI section **supersedes** 0006 —
   clack retires gum *and* fzf, so the tool ships zero optional binaries). Bake-off criteria,
   timing, evidence artifacts, and the two exits that close it are recorded. Rejected alternatives
   in house style, including plain-TS-without-Effect and why it is not the tripwire's fallback.
2. **[`SPEC.md`](SPEC.md)** — implementing-session fidelity: package layout and pinned toolchain,
   the twelve tags with their interface shapes, the plain-function list, error taxonomy by the
   outcome-row test, Scope seams with the acquisition/release diagram and the four signal paths,
   reconciler liveness rule, ops-as-library return values and the `Reporter` stream, config
   precedence chain, the full CLI surface with the nine `doctor` probes, prompt packaging, the
   chokepoint and its grep bans, the ledger record, test strategy, and the parity checklist marks.
3. **[`.agentbox/ROADMAP.md`](../../../.agentbox/ROADMAP.md)** — new **Phase B2** section carrying
   both sequences (T1–T6 with the bake-off and move-out bar inline; P1–P7 with the AFK boundary and
   the atomic switchover commit), plus the stale "repo name open" line replaced.

### Two facts checked at write time

Both invariant gaps ticket 03 found have **since been fixed in hae's bash spine** — verified against
`run.sh`, not taken from the ticket:

- no-published-ports now has a post-start `docker port` check that aborts the dispatch and fails
  closed if the check itself cannot run (`e2bcc3d0`);
- the origin URL is passed through a `strip_url_userinfo` helper before it is written into the
  agent-readable clone, plus a `doctor` warning (`d914fc75`).

This **removes an argument the ADR was going to make** and leaves the better one, which is now what
it says: in bash both repairs are checks a future edit can bypass; in the port both are shapes a
future edit cannot express. That is design rule 2, stated against a live example rather than a gap.

It also **moots the map's out-of-scope item** "fixing the two invariant gaps in hae's live bash
agentbox" — nothing is owed to hae's queue. Invariant 3's `upload-pack` note is carried as the ticket
asked, in both the ADR and SPEC §9.

### One thing this ticket could not close

The ticket's spec list names **test strategy**, but ticket [12](12-test-strategy.md) is open and owns
it, and 12 is not in this ticket's blocked-by. SPEC §11 therefore carries what is already fixed
(runner, the transform gap and its tracer, `floatingEffectInVitest`, the canonical Claim-1 test
shape, `Reporter`-as-ordering-instrument, config precedence via `Layer.succeed`) and marks the rest
as 12's. **This does not block T1** — nothing in T1–T6 waits on it — but 12 should resolve before P2's
parity work. Ticket [13](13-prototype-clack-picker.md) (clack verification) is likewise open and
likewise blocks nothing; SPEC §13 lists both.

**Map status**: the destination is met — an agent session can start T1 with no decisions left.
