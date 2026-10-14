# 03 — Behavior inventory of run.sh + tasklib.py

Labels: `wayfinder:research`
Map: [MAP.md](MAP.md)
Blocked by: —
Assignee: research subagent (charting session, 2026-07-29)
Status: **closed** 2026-07-29 — findings at `research/03-behavior-inventory.md`

## Question

The port implements against `.agentbox/run.sh` (~88K) and `.agentbox/tasklib.py` (~101K) read
directly — no intermediate language-neutral spec doc. But no one can hold both in one session, so
this ticket produces the **inventory** that later tickets navigate by: what exists, where it
lives, and how big each piece is.

Not a rewrite of the code into prose. A map of the behavior surface, with `file:line` anchors.

Cover:

- **CLI surface** — every flag and subcommand, its semantics, and its interactions
  (`--feature`, `--branch`, `--resume`, `--last`, `--feedback-edit`, `--dry-run`, `doctor`, `gc`,
  `status`, picker entry, notify verbosity).
- **Dispatch state machine** — the full path from invocation to draft PR: clone, container
  lifecycle, setup hook, implement pass, review pass and its verdict-break loop, push, PR
  create/update, notify. Note every point where it can fail and what cleanup is owed.
- **Data layer** — issue file parsing and selection, `Status:` writes, the central
  `runs.jsonl` ledger schema and its auto-migration, status rendering, gc scan/render, picker,
  resume recovery.
- **Runtime state** — `locks/`, `logs/`, `checkouts/` layouts and lifecycles.
- **Security invariants as implemented** — where each one is enforced in code: zero git
  credentials in the container, no write-side git inside the agent's clone (branch read
  textually from `.git/HEAD`), host fetches from the clone via hardened `upload-pack`, push from
  the main repo only, credential checks report presence only, master/main refused as working
  branch, draft PRs only, gc never deletes logs, FF-only salvage before checkout removal,
  liveness re-checked immediately before every deletion, PR review comments never enter prompts,
  task containers publish no ports.
- **Test suite shape** — `test_tasklib.py` (337 tests): what they cover by area, and which
  behaviors have *no* test (the bash spine is the untested half).
- **hae-specific adapter vs core** — which parts assume Django/postgres/hae layout and would not
  move to the new repo.

For each area give a rough size/complexity signal so later tickets can slice tracer bullets
sensibly.

## Answer

Full inventory at [`research/03-behavior-inventory.md`](research/03-behavior-inventory.md) — 468
lines, all eight sections, `file:line` anchors throughout. Gist:

**Shape.** A 1732-line bash spine (`run.sh`) wrapped around a 2325-line python data/UI layer
(`tasklib.py`), communicating over `key=value` and TSV on stdout. `run.sh` owns everything with a
side effect — docker (13 sites), git (~24), gh (6) — and delegates every pure-data decision to
`tasklib` across 14 shell-out points. Centre of mass is `run_task` at `run.sh:1028-1645`: 618
lines, six numbered steps, four resources (lock, rotated log, checkout, container) acquired in
sequence and released by a single 18-line `trap cleanup EXIT` at `run.sh:1169-1190`. That trap has
its exact shape because macOS bash 3.2 silently skips EXIT traps for backgrounded subshells and
leaked a container after every completed run — which is precisely the failure class `Scope`
exists to make structural. `tasklib` is 49% picker; the test suite is 41% picker tests.

**Two invariant gaps found** (both verified by hand during resolution, not taken on the
subagent's word):

1. **Invariant 12 — "task containers publish no ports" has zero enforcement.** Confirmed: no `-p`
   appears in the 15-line `docker run` at `run.sh:1249-1263`, so the invariant holds purely by
   absence. No comment asserts it, hae's sandboxing guide (not carried) never states it, no test,
   no doctor check. One careless `-p` in a future edit breaks it silently.
2. **Invariant 1 has a conditional hole.** `run.sh:959` reads `git remote get-url origin`;
   `run.sh:1205` writes it into the agent-readable clone's `.git/config`. If a dev's origin is an
   HTTPS URL with embedded userinfo, that token enters the sandbox. **Severity is conditional, not
   live**: on the current machine origin is an SSH URL (no credentials), and `gh auth setup-git`
   installs a credential helper rather than baking userinfo into the URL. So this is a latent
   hazard dependent on a dev's remote shape, not a present leak.

Also on record: invariant 3's "hardened `upload-pack`" is a property of upstream git, not a flag
agentbox sets.

**Hardest area to port**: the dispatch core (`run.sh:1028-1645`) — not for logic complexity but
because it is the untested half, so there is no oracle to port against. Its failure/cleanup matrix
has to be reconstructed from the code plus the 227-line header docstring.
