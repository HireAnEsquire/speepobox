# Roadmap

The ongoing list of what comes next for speepobox. One entry per effort, in order. An entry says what
the effort is, why it waits, and what it waits on. It never holds the effort's decisions.

- An effort with open design questions gets a map under `docs/wayfinder/<name>/` when it starts.
  Its entry then links the map, and later the spec and tickets.
- A small effort goes straight to a grill and a ticket under
  `docs/wayfinder/effect-agentbox/issues/`. No map.
- When an effort ships, remove its entry. The tickets and git history record it.

## Now

- **T150: the picker opens on an empty tasks dir.** Dispatched 2026-10-15. Ships in v6.
- **Close the effect-agentbox map.** Give T134 its Done line, write the map's final status line, and
  point its Out of scope at this file.

## Next

### Per-pass prompt, model, and thinking level, with a provider seam

A dispatch declares which prompts run, in what order, and at which model and thinking level for
each pass. Then a cheap pass can draft and an expensive one can review, by declaration rather than
by the fixed ladder. The agent seam (`AgentCli`) is shaped so a second CLI can plug in. A second
adapter (codex or cursor) is the last part of the route: the need is real but not urgent.

- Ruled post-MVP on 2026-09-14 by the effect-agentbox map, which also ruled that this and Phase C's
  model choice are **one grill, not two**.
- What this builds on: T53 made a run's cost a ledger fact, and T54 made each pass visible.
- Before the provider part: ask the dev who wants another CLI which CLI, which headless flags, and
  whether they need the review loop.
- Needs a map. Not charted yet.

### Writable container storage

Give a repo docker-managed volumes for slow installs (`node_modules`, a package cache), so a run
does not reinstall from scratch. Today hae's setup hook runs a full install into the bind-mounted
clone on every run.

- Constraint carried from the effect-agentbox map: docker-managed volumes only, never a writable
  host directory, and `SandboxMount` stays mode-less.
- The trust edge to rule on: a cache that outlives a run is something run N writes and run N+1
  executes.
- One grill, then one ticket. No map.

### Setup script

A guided first install for a new adopter: the credential, the tasks dir, the defaults. `init` and
its Next steps cover part of this today. Version 2 adds a provider picker, so it waits for the
provider seam above.

## Later

### Effect 4

speepobox is on `effect` 3.22. `effect@4` is now the `latest` dist-tag (4.0.5, checked 2026-10-15),
so 3 is the old line. A migration touches every layer, so it runs when nothing else is in flight.
Read the migration guide first, and size it with a grill.

## Parked

Each of these waits for a trigger. None is scheduled.

- **Wave dispatcher.** Run the unblocked issues of one feature in parallel. Parked because the
  issues of one feature overlap files on purpose, so merging them rewrites freshly reviewed code.
  Branches of different features already run in parallel (one lock per branch). Revisit for a
  feature whose issues touch disjoint parts of the code.
- **Dashboard.** Trigger: pain from watching many parallel runs. A UI that can start dispatches
  needs its own security grill: bound to loopback, token-gated, safe against DNS rebinding and CSRF.
- **Jira adapter.** No adopter has asked for one.

## Small ideas

Too small for an entry of their own. Each is a ticket when someone wants it.

- A console line while the setup hook runs (`setup: running`), so a slow hook does not look hung.
- `init --refresh` skips a dangling symlink at the temp path `<file>.refresh` silently (T147).
- A refusal after a leftover removal does not name the removed file (T147).
- A release that adds a scaffold file writes it on refresh, so that one `upgrade` shows `init`'s Next
  steps again (T149).

## Ruled out

- **The review-run skill and the sizing tripwire.** Rejected before the port.
- **A Go or Rust binary.** Rejected in ADR 0006. Revisit only if adoption grows by an order of
  magnitude.
- **The land recreating a branch deleted mid-run.** Ruled out on 2026-09-29 (effect-agentbox map):
  a human deleting the branch of their own dispatch while it runs is racing themselves.
