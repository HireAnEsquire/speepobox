# 12 — Test strategy for the port

Labels: `wayfinder:grilling`
Map: [MAP.md](MAP.md)
Blocked by: ~~03~~ (closed 2026-07-29), ~~05~~ (closed 2026-08-06) — **unblocked, on the frontier**
Assignee: Scott Bowles (claimed 2026-08-06)
Status: closed (resolved 2026-08-06)

Graduated from the map's **Not yet specified** on 2026-08-06: 05 settled the service list and the
Scope seams, which is what the strategy was waiting on.

## Question

What replaces tasklib's 337 tests, and what the bake-off actually measures.

- **Case translation** — how many of tasklib's *cases* survive as-is, how many were testing the
  subprocess-mock shape rather than behavior (03 §6), and what the untested half (the dispatch core,
  which has no oracle) needs that never existed.
- **The split** — Layer-faked unit tests versus real-container integration tests. Which invariants
  can only be proven against a live dockerd, and how many of those there are.
- **The bake-off instrument** — the map scores Effect on (1) guaranteed cleanup under failure and
  (2) dispatch-core test quality. Both need to be *measurable*, not asserted. 02 names the canonical
  case: dispatch a task, make the reviewer pass die with a defect, assert the fake `Sandbox`'s log
  ends in a removal. Enumerate the rest.
- **Coverage of 05's five design rules** — each is a claim that should fail a test if violated:
  domain-shaped services, unrepresentable invariant violations, declared-not-inferred ownership,
  finalizers that never fail the scope, rehearsal-as-layer-swap.
- **The parity oracle** — 04 carries `run.sh`/`tasklib.py` out with the port. What is actually run
  against them, and on which behaviors differential testing is worth the cost.

## Carried in from ticket 05

- **Reporter as a test instrument.** In-flight progress is a structured event stream, and the test
  implementation appends to a `Ref` — so *ordering* assertions (lock before checkout before sandbox;
  release in reverse) become plain value assertions. This is the mechanism the cleanup claim is
  proven with; decide how far it is leaned on.
- **`--dry-run` is a layer swap**, so guard rehearsal is exercised by the same code path as a real
  dispatch. Decide whether dry-run *is* a test harness or merely shares one.
- **Ledger breaks compatibility** with a legacy read adapter. That adapter needs its own cases and a
  deletion date (switchover).
- **The runner is settled** (04): vitest + `@effect/vitest`, with T1's `doctor`-under-plain-node
  tracer doubling as the strip-safety check that closes vitest's transform gap.

## Carried in from ticket 06

- `@effect/tsgo` ships **`floatingEffectInVitest`** — "Detects Effects returned from
  non-Effect-aware Vitest callbacks", i.e. a test that constructs an Effect and never runs it, so
  it passes while asserting nothing. Directly in this ticket's territory, and it is already inside
  `npm run verify` (06 puts the Effect diagnostics on the single typecheck, with warnings breaking
  the build), so the strategy should assume it rather than re-derive the gap.
- Toolchain is now fixed: `effect@3.22.1` exact, `typescript@7`, `@effect/tsgo`, vitest +
  `@effect/vitest`.

## Answer

Resolved 2026-08-06 by grilling. Full strategy written into [SPEC.md §11](SPEC.md), which is the
normative text; this records the decisions and their reasons.

**1. The split — two tiers, forced by the container.** T1–T6 are AFK-dispatched into hae's task
container (08), which has no docker socket and `--cap-drop ALL` — the agent writing the code can
never reach a live dockerd. So `npm run verify` (the one gate, 06) is entirely Layer-faked and
agent-runnable, and **`npm run verify:live`** is a host-only tagged suite the user runs before
landing any bullet that touches `Sandbox.dockerLayer` (T3 onward). `it.skipIf(noDocker)` inside
`verify` was rejected: skipped-is-green in exactly the environment that writes all the code is the
false-green shape 04 already ate once. Nothing touches hae CI — it has no npm job for the package;
the only contact is pre-commit's `exclude:`, already owed by T1 (11).

**2. What earns the live tier**: only cases a fake could pass while dockerd disagrees. Five: leak
under real-`dockerLayer` defect; spec type renders to a `docker run` dockerd accepts; live
no-published-ports; **label filter selectivity** (two containers, claim exactly one — kept over
cutting, because the dangerous direction is over-matching, the exact bug that retired the name
prefix, and a fake never parses a docker filter); and the five-kill signal matrix.

**3. The bake-off instrument, deflated (user ruling).** The signal matrix is a **regression suite
first** — SIGHUP-teardown, second-Ctrl-C, and reconciler reclaim are new behavior with no bash
equivalent and need permanent guards. ADR 0007's failure-injection evidence *borrows* it if the
comparison happens; nothing is designed for comparability, and no shared cross-port harness is
built (running the case list against `run.sh` by hand once is an afternoon, not architecture). This
narrows 09's "identical instrument" framing: if it's working and the user feels good about it,
Effect wins — the comparison is not what the suite is for.

**4. The dispatch core's missing oracle is authored, not discovered.** A **failure-point matrix**
(22 rows × three observables: `Reporter` event ordering via `Ref`, ledger row, error shape) is
written **once into SPEC §11 by this ticket**, before T3 — per-bullet emergence was rejected
because six AFK bullets would invent contradictory-but-green answers. New rule fixed by the matrix:
**a run writes exactly one terminal ledger row iff `RunLock` was acquired** — guards and preflight
refusals never started. Each bullet satisfies rows already written.

**5. Five design rules → mechanisms** (SPEC §11 table). Rule 1 is a review property (chokepoint
greps are the proxy); rule 2 gets a *small* `@ts-expect-error` shape-pin file, admitted only where
a future edit could silently add capability (user's filter: best-practice tests, never
we-said-we'd-prove-something tests); rule 3 = live selectivity + labels-always-attached unit test;
rule 4 = matrix rows 18–19; rule 5 = same-entry event-shape parity test + grep ban on a second
dispatch path.

**6. Case translation**: picker's 138 die (rewritten fresh at P3 against clack); ledger/resume's 75
mostly die (greenfield schema); ~113 plain-function tests translate per-bullet with no dedicated
pass; subprocess-mock shape tests die untranslated — that is the thesis.

**7. The parity oracle is read, never executed** (user ruling: source material, not a gold
standard — revises 04's framing to its real strength). No python toolchain in the new repo. The one
differential comparison is 09's switchover gate, which already exists. The **legacy ledger import
adapter** is tested against frozen lines of hae's real `runs.jsonl` — *inputs* to the adapter, not
golden outputs — and deleted after the gate passes (P7).
