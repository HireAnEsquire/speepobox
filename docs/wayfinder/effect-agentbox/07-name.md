# 07 — Settle the real name

Labels: `wayfinder:task`
Map: [MAP.md](MAP.md)
Blocked by: —
Assignee: Scott Bowles
Status: closed

## Question

`.agentbox/ROADMAP.md` records this as an open offline item: "agentbox" is taken; shortlist is
drydock / offhand / nightshift. `agentbox-ts/` is the placeholder until this resolves.

Manual work, HITL, no decision for an agent to make:

- pick the name
- check npm scope/package availability and GitHub org/repo availability for it
- confirm it doesn't collide with the python port's name

The answer records the name, the package name, the binary name, and where the rename has to
land (dir, `package.json`, bin, docs). Needed before move-out, not before T1.

## Carried in from ticket 04

Known rename touch-points so far, in hae:

- the top-level package dir itself (`agentbox-ts/` placeholder)
- `package.json` name + bin
- the `exclude:` regex at `.pre-commit-config.yaml:1`, which carries the dir name to isolate the
  package from hae's hooks (deleted outright at move-out)
- the `--feature`/dispatch invocations recorded in the T-sequence issues

Deliberately **not** a touch-point: the added line in `implement-prompt.md` / `review-prompt.md`.
04 phrased it generically — "if the spec names its own verification commands, those are the gate" —
specifically so it names no directory and survives this rename untouched.

## Answer

**The name is `speepobox`** — for the incubation and for the standalone repo, with `bessemer`
held back as the bake-off prize (below).

| Thing            | Value                                                                |
| ---------------- | -------------------------------------------------------------------- |
| Name             | `speepobox`                                                          |
| Package name     | `@hireanesquire/speepobox`                                           |
| Binary name      | `speepobox`                                                          |
| Incubation dir   | `speepobox/` at hae's top level                                      |
| Repo (post-move) | `HireAnEsquire/speepobox`                                            |

### Availability, checked 2026-08-06

| Candidate     | npm unscoped                     | GitHub org/user       |
| ------------- | -------------------------------- | --------------------- |
| `agentbox`    | taken (the original blocker)     | —                     |
| `drydock`     | taken — v0.8.1, last pub 2022-06 | taken (user)          |
| `offhand`     | taken — v0.1.2, last pub 2022-05 | taken (user)          |
| `nightshift`  | **free**                         | taken (user)          |
| `bessemer`    | free                             | taken (user)          |
| **`speepobox`** | **free**                       | **free**              |

`speepobox` is the only candidate clear on **both** axes. The whole shortlist
(drydock/offhand/nightshift) is dead: two are blocked by dormant 2022 npm squats, and *all four*
original candidates collide with existing GitHub user accounts, so no matching org was ever
available for any of them.

Availability nonetheless stopped being decisive once the package went **scoped**: ticket 01 settled
distribution as a clone-run shim (shallow clone at a pinned SHA + `npm ci`), so `package.json`'s
`name` is never resolved from the registry. `@hireanesquire/<anything>` is always available; the
unscoped name buys only 01's publish *fallback* and vanity. Unscoped `speepobox` is free and is
deliberately **not** reserved — a placeholder publish serves nothing under the shim.

Owner is `HireAnEsquire`, not personal: the package incubates inside hae and is extracted by
`git filter-repo` carrying hae history, so the artifact is employer-derived either way and employer
ownership avoids raising an IP question later. It also keeps hae's shim pointed at a repo in hae's
own org rather than at a personally-owned dependency.

Provenance: a coworker's suggestion, from a work nickname of the user's. It also keeps the `-box`
lineage from `agentbox`. Baking a personal handle into a public artifact was raised and accepted —
the tool is not expected to attract many users.

### `bessemer` is the bake-off prize, not a collision

`bessemer` is reserved for **whichever implementation wins the bake-off**, not held permanently by
the python port. That dissolves the collision this ticket was asked to check, asymmetrically:

- The bake-off lands at F3/T3 parity, i.e. **after** move-out — so the TS repo already exists under
  its own name when the award happens.
- **TS loses** → TS repo dies, python keeps `bessemer`. Zero renames.
- **TS wins** → python is retired **first**, then TS renames into the now-vacant name. One rename,
  against a name whose other holder no longer exists.

So the two never coexist. The rename is **conditional and post-bake-off** — explicitly *not* pulled
earlier. ("Rename early" was raised and clarified to mean *early in user count*, not early in the
process; holding to the bake-off was chosen over both an early rename with python stepping aside and
an early rename with the two coexisting under different owners.)

Touch-points for that second rename, if it fires: GitHub repo rename (redirects keep existing
remotes working), `package.json` name + bin, and a repin of the shim URL in `.agentbox/config`.

> **Amended by ticket [09](09-post-move-sequence.md) (2026-08-06).** "Python is retired **first**"
> was written assuming retirement means deletion. It does not: 09 settled that the losing port's repo
> is **kept as a cold fallback** — retire means stop investing. So `HireAnEsquire/bessemer` remains an
> occupied GitHub name and the rename above would fail. **Vacating the name is a distinct act**, and a
> fourth touch-point, taken first: rename the python repo `bessemer` → `bessemer-python` (or
> `-archive`), *then* rename `speepobox` into the freed name. Order is load-bearing.
Cheap while hae is the only adopter — and MAP puts adopter-install in the post-move sequence, after
parity, so the ordering holds. **Recorded as an input to ticket 09**, not a ticket of its own: it
sits past this map's destination.

### Rename landing — there is nothing to rename

Grep at resolution time: `agentbox-ts` appears **only** as prose in `04` and in this ticket. The
directory was never created, and 04's `exclude:` edit was never made —
`.pre-commit-config.yaml:1` still does not name the package dir.

Because 07 resolved **before** T1 rather than merely before move-out, every touch-point carried in
from 04 collapses to a doc edit:

- **Package dir** — T1 creates `speepobox/` directly; no placeholder ever exists to rename.
- **`package.json` name + bin** — written correctly at creation.
- **`.pre-commit-config.yaml:1` `exclude:`** — 04's planned edit simply names `speepobox/` when it
  is made (and is deleted outright at move-out anyway).
- **`--feature`/dispatch invocations in the T-sequence issues** — those issues are not yet written;
  they name `speepobox/` from the start.
- **`<package>/AGENTS.md`** (ticket 06) — created at the right path.
- **Doc references** — the only actual edits: `04-incubation-mechanics.md:15`, `:105`, `:200`, which
  still say `agentbox-ts/` placeholder.

Confirmed **not** a touch-point, as 04 intended: the added line in `implement-prompt.md` /
`review-prompt.md`. 04 phrased it dir-name-free ("if the spec names its own verification commands,
those are the gate"), and it survives untouched.
