# 17 — Feedback that forbids leaves no trace

Labels: `wayfinder:grilling`
Map: [MAP.md](MAP.md)
Blocked by: —
Assignee: Scott Bowles (claimed 2026-08-21)
Status: closed (resolved 2026-08-21)

## Question

**A dispatcher's feedback reaches one round and is persisted nowhere the next round can read. Does a
later round need the earlier rounds' feedback — and if so, is the fix a mechanism or a habit?**

Surfaced 2026-08-21 while resolving [15](15-a-dispatch-names-the-work-it-will-do.md), promoted out of
the map's fog on the same day.

## The asymmetry that makes this narrow

The obvious framing — *feedback does not persist* — overstates it. Feedback that says **do X** already
survives: the agent does X, X lands in the commits, and every later round reads the branch. The text
is gone but the effect is durable, and the effect is what mattered.

Feedback that says **don't do X** leaves nothing. The absence of X in the diff is indistinguishable
from X never having come up, so round 3 can reintroduce exactly what round 1 forbade, and nothing in
its context contradicts it. It will not even look like a regression — it looks like the agent having
a different opinion than it had two rounds ago, which is what it is.

So the failure mode is **prohibitions**, not instructions. That narrowness is the ticket: it is small
enough that the answer might be a prompt-authoring habit — restate standing constraints every round —
rather than anything that persists. Deciding which is the work.

## What is true today

Verified 2026-08-21 against `run.sh` and `.agentbox/Dockerfile`.

**Feedback's reach.** `--feedback` text is appended to the implement, review, and PR-description
prompts for **that run only**. Nothing writes it anywhere a later dispatch reads.

**What the container can see** (`run.sh:1682-1687`): `/workspace` (the checkout), the spec mount
(`/spec.md` or `/feature-issues`), the setup scripts, the stream filter, and two dependency-cache
volumes. That is the whole list.

**What it cannot see, and why it is not a mount question.** `.agentbox/logs/`, `runs.jsonl`, and
`.env` are gitignored (`.agentbox/.gitignore:1-6`), so they are absent from the clone as well as
unmounted. Two independent reasons, which is worth knowing before anyone proposes solving this by
adding a mount.

**So across N rounds the agent's entire memory is the branch's own commit history.**

## The candidate homes

1. **The ledger** (`runs.jsonl`). Not in the container by either route above. Also collides with
   [14](14-done-conflates-approved-with-landed.md)'s ruling — the ledger is a hint, never truth, and
   derived state. Making feedback load-bearing there would reverse that.
2. **The run log.** Same absence, and its retention is itself undecided —
   [16](16-what-the-tool-keeps-and-who-deletes-it.md) owns whether logs survive at all.
3. **A commit on the run branch.** Available today, and with precedent: 14 already ruled that the
   dispatcher writes `Status: Done` as a commit on the run branch, so dispatcher-authored content
   travelling with the code is a settled shape rather than a new one. The branch is already the
   agent's only durable memory, which is the argument for putting the thing it needs to remember
   there.
4. **The PR.** Closed, and by three independent facts — see below.

## The PR is out, and it is worth knowing exactly why

The container's environment comes from two env files (`run.sh:1690`) and no `-e` credential.
Checked 2026-08-21, by key name and value *length*, never by value:

- **The secrets env file carries no usable GitHub credential.** Its token variable reaches the
  container set to the empty string, which authenticates nothing.
- **Neither does the sandbox env file**, which holds dummies only.
- **The image does not install `gh`.**

Any one of the three would close the door; all three hold. The real credential lives in the host's
own `gh` login, which is never mounted — `run.sh` calls `gh pr view` and `gh pr edit` on the
dispatching host, on the far side of the container boundary.

So door 4 is closed for the same reason as doors 1 and 2: the container cannot reach the artifact.
**Any answer that wants the agent reading its own PR is proposing a new capability**, not switching on
an existing one, and should be priced that way.

## What this ticket has to settle

1. **Whether prohibitions need to survive at all**, or whether a dispatcher restating them each round
   is the correct division of labour. The cheapest answer, and not obviously wrong.
2. **If they must survive: which home**, given the four above and the reasons three of them are
   awkward.
3. **Whether the agent should read its own PR at all.** Independent of 1 and 2. Today it cannot, by
   three separate facts, so this is a question about adding a capability — and the answer may well be
   no, since the PR is where *humans* discuss the work and feeding it back to the agent is a wider
   change than this ticket needs.
4. **Where the answer lands.** The prompt surface is P2/P3 work, so this closes before the P2–P6
   slicing pass rather than after it.

## Notes

**Not blocked, and deliberately so.** Unlike 16 this needs no repo bootstrap and no settled runtime
root — the prompt surface exists today and the question is about it, not about where logs live. It is
the frontier.

**Adjacent, not the same:** *prompting without reference to a spec*, still in the map's fog. 15
rejected a `--feedback-only` flag as the wrong vehicle for a general capability; that item asks what a
dispatch carrying a prompt and no work order *is*. Both are about the prompt surface and either may
constrain the other, but they are separate decisions and should not be merged before both are stated.

---

## Resolution (2026-08-21)

### The ruling

**Dispatcher feedback is per-dispatch. There is no conversation history — not for the agent, not on
the host.**

The prompt is assembled fresh each run from the templates plus *this* dispatch's `--feedback`.
Nothing carries an earlier round's text forward, no store holds it, and the agent does not read its
own PR. Round 3 seeing nothing of round 1 is correct behaviour, not a gap.

This upholds [15](15-a-dispatch-names-the-work-it-will-do.md)'s *a resume inherits base, PR,
identity and recorded set but **not** feedback* — the same line, now with a reason attached rather
than left as a resume-table detail.

### Why not cumulative

The alternative is one sentence long and fails on one fact: **an accumulating feedback channel has
no revocation vocabulary.**

Prohibitions are precisely the class of instruction that gets reversed. *Don't solve it with a
decorator* in round 1, *actually, do* in round 3 — both now in the prompt, with no ordering the
agent can be trusted to read as supersession. Fixing that means marking which lines are dead, which
means inventing a revocation syntax for a free-text box, which is a language, not a channel. The
channel would be wrong within a handful of rounds, and wrong in the direction of steering work with
instructions the dispatcher has already withdrawn.

Two supporting notes:

- `--feedback-edit` is deliberately git-commit-message-shaped. A commit message describes one
  commit, not the branch. The editor flow already reads per-dispatch.
- The **feedback-only** run (`run.sh:1949`) is where feedback *is* the entire work order. That
  sharpens the ruling rather than straining it: a work order is for one run, and work orders have
  never accumulated.

### The asymmetry survives, but does not imply persistence

The ticket's framing holds — *do X* survives as code and *don't do X* leaves nothing. What it does
not establish is that the trace must live in the feedback channel. A prohibition that genuinely must
outlive its round is a standing constraint, and standing constraints already have durable homes that
reach every round: `project-context.md` (SPEC §8) and `AGENTS.md` (06 §4), both on the branch, both
in the clone. Those are not this ticket's answer — this ticket is about the `--feedback` channel —
but they are why the residue is small enough that no mechanism earns its place.

### All homes moot

Doors 1–4 close without being weighed on their own merits: with no history wanted, none is needed.
Recorded so the reasoning is not re-derived:

- **Ledger, run log, PR** — unreachable from the container, as the ticket establishes, and now also
  unwanted.
- **A commit on the run branch** — reachable and with 14's precedent, so this was the live one. It
  dies with cumulative, not with reachability.
- **The issue file** (not in the ticket's list) — after [15](15-a-dispatch-names-the-work-it-will-do.md)
  moved `/feature-issues` into the checkout and [14](14-done-conflates-approved-with-landed.md) put
  issue state on the ref, a tracked issue file is on the branch, read every round, and
  dispatcher-writable. Also moot, and it never covered spec mode, where `/spec.md` stays
  host-mounted and uncommitted.

### The agent does not read its own PR

Settled as a decision, not left as a cost. The PR is a conversation history, human-authored; no
history is wanted, so the answer is no on the same grounds as the rest. The three facts closing the
door today (no usable GitHub credential in the secrets env file, none in the sandbox env file, no
`gh` in the image) stop being the argument — which matters, because any one of them could be
removed by an unrelated change. A later proposal to mount a credential must reopen this decision,
not merely switch on a capability.

### Nothing supports the habit either

Per-dispatch relocates the burden to the dispatcher: restating a standing prohibition each round is
now the human's job. Verified there is no host-side memory to lean on — `tasklib.py` records only a
`has_feedback` boolean for the resume guard, never the text, and the log does not keep it either.

Ruled: **build nothing.** `run.sh:806-813` already prints each dispatch's `EQUIV` replay line with
`--feedback '<text>'` quoted verbatim, so recovering an earlier round's wording is a scroll, not a
reconstruction.

Rejected: recording feedback text in the ledger and pre-seeding `--feedback-edit` with prior rounds
as commented lines (stripped by the existing `feedback-edit-strip` path). It is a real design and it
keeps history human-side, but it puts dispatcher prose into a store 14 fought to keep narrow, for a
failure with zero recorded incidents, on a bash surface that dies at P3 — the same call
[15](15-a-dispatch-names-the-work-it-will-do.md) made when bash got nothing.

### Where it lands

One bullet in **SPEC §8** (prompt packaging), stating the ruling and naming the accumulation trap.
The ruling is a negative, and a closed ticket is exactly what a P2/P3 AFK agent will not read while
building the prompt surface — *carry the last round's feedback forward* is a plausible thing for an
agent to add. That is this ticket's own failure mode one level up, which is why the trace goes in
the section that governs the surface.

No other change: no bash work, no ledger field, no `AGENTS.md` entry, no code.

### Correction to this ticket's facts

`--feedback` reaches **six** insertion points, not the three stated above: `run.sh:1779`
(implement), `1811` (review), `1949` (feedback-only work order), `1991`, `2030`, `2134`. Reach is
unchanged — all six are within one run.

### Knock-ons

None. The adjacent fog item — *prompting without reference to a spec* — stays open and unmerged, with
one constraint added: whatever that mode turns out to be, it does not get a history either.
