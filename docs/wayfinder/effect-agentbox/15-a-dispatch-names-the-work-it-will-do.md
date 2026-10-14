# 15 — A dispatch names the work it will do

Labels: `wayfinder:grilling`
Map: [MAP.md](MAP.md)
Blocked by: —
Assignee: Scott Bowles (claimed 2026-08-21)
Status: closed (resolved 2026-08-21)

## Question

**What must a dispatch command say before the dispatcher will act on it, and what may the dispatcher
still infer?**

Two observed failures share one cause: the dispatcher fills in the most consequential thing a run
does — *which issues it will work* — from context rather than from the command, and says so only in
a status line nobody reads in time.

### The evidence

**2026-08-18, five-issue run.** `--feature` without `--issues` selects every ready issue in the
folder as a fixed point (`tasklib.py:288-302`). Against `docs/wayfinder/effect-agentbox` that
resolved to five issues and fourteen steps, on the branch for one of them, reaching T34's implement
pass before a human killed it. Two of the five already had their own branches and open PRs, so a
third branch had begun editing both. Already recorded in
[09's P2](09-post-move-sequence.md) — *a selection the dispatcher did not name is a proposal, not an
instruction* — which ships two refusals beside the selection loop.

**2026-08-19, the T37 feedback run.** `--resume speepobox-t37 --feedback "…"` was issued intending a
feedback-only run. It ran a normal two-issue feature run with the feedback riding along: `--resume`
recovers `task_dir` from the branch's ledger row (`run.sh:18`), which resurrected the feature
folder nobody had named, and three issues in it were not marked Done *on that branch*. The
dispatcher then handed the agent a mounted `/spec.md` for one ticket and a feedback block describing
a different one, with no consistency check. The agent noticed the mismatch and said so in its log;
the dispatcher never did.

### What makes this one question rather than three

The natural reading is three defects — over-wide selection, no feedback-only mode, no spec/feedback
consistency check — but only the first is real. Detecting whether a mounted spec and a feedback
block "are about the same thing" is a semantic judgement no dispatcher can make reliably; requiring
the selection to be named makes it a syntax check the parser does for free. And a run that names no
issues *is* a feedback-only run, so the mode falls out of the rule rather than needing a flag of its
own. Fix the naming and both others stop existing.

### What the grill must settle

1. **The shape of an explicit wide selection.** 09's P2 rules a wide selection must be *assented
   to*; the counter-proposal is that it must be *spelled* — an `--issues all` / `--all-available`
   token, no prompt. Spelling suits a backgrounded dispatch, which cannot answer a prompt, and
   `guards.ts` is already a module of refusals holding nothing. Decide which, and whether a TTY run
   is allowed to soften at P3 when the picker exists.
   <!-- T86: the TTY softening landed — on a terminal, --feature without --issues opens the picker at the issues step; off a terminal, or with --no-input, the refusal is unchanged. -->
2. **What `--resume` may still inherit.** Inheriting the base ref and the PR from the ledger is a
   good default. Inheriting *what work to do* is the bug. Draw that line explicitly rather than
   letting it fall out of the implementation.
3. **Whether feedback-only needs a name.** If naming no issues is unambiguously feedback-only, a
   `--feedback-only` flag is belt-and-braces. Decide whether the belt is worth it — an explicit flag
   that refuses when issues are open is self-documenting in a way an absence is not.
4. **Where this lands.** The real design is TypeScript, at P2. bash gets at most a one-line refusal,
   because move-out is close and passing `--issues` on each remaining dispatch is the same consent
   the guard would enforce — the position 09 already takes.

Adjacent, undecided, and probably the same grill: **`--base` resolves before `git fetch origin`**
(see the map's *Not yet specified*). Same surface — what the command means and when the dispatcher
is allowed to decide it.

---

## Resolution (2026-08-21)

### The ruling

**The dispatcher may replay a work set it recorded, and may execute a set the command named. It may
never compute one the command did not name.**

The distinction is *value versus policy*, and it is what makes the two incidents one defect. Both
times the dispatcher held a **folder** rather than a work set, and re-ran the selection policy
against it at dispatch time — on 08-18 from `--feature`, on 08-19 from a `task_dir` recovered off
the ledger. Inheriting a value is fine and stays: base ref, PR, branch identity, image, container
name. Re-executing a policy is the bug.

A named predicate counts as named. `--issues all` is the command choosing a set by rule instead of
by enumeration, so evaluating it is *executing the instruction*, not inferring one. What the rule
forbids is a set arrived at because nobody said anything.

Everything below follows from that sentence.

### Where `--issues` is required, and what `all` means

Not a special case for `--feature` — it falls out. A set is legal when it is named or replayed, and
`--feature` is the only input that would otherwise compute one, so it is the only form that requires
`--issues`. Spec mode names no set because there is none to name. A resume names none because it has
a recorded one.

`--feature` without `--issues` **refuses**. The wide selection survives, spelled: **`--issues all`**.
Three shapes were weighed — the token, no wide form at all, and a refusal that prints the resolved
set as a paste-ready `--issues T25,T28,…` for the dispatcher to convert. The token won on the
grounds that naming "all" without knowing the numbers is genuinely useful, and that the refusal on
absence is what catches the real mistake: forgetting to list.

The cost is stated rather than argued away. **`all` consents to wideness, not to contents** — the
08-18 run would have been legal under it, because the surprise was never that the selection was wide
but *which five*. A token typed before the list is seen cannot fix that. Contents protection is the
next section's job, which is why:

**`--issues all` is not an override of either check below.** Only enumerating is.

**Amended 2026-09-21 (09's P2 comment, decision 1): the predicate `all` evaluates is
`ready-for-agent`**, not the *AFK, not-yet-Done* this ticket and SPEC §7 said — every issue file
opens at `needs-triage` (TEMPLATE.md), so the older spelling makes the token consent to everything
nobody has triaged, which is precisely the wideness the cost above is about. Built as a pure
function over the parsed set in [T69](issues/T69-a-selection-is-a-value.md), which also holds the
rest of what `all` means: blockers done or also selected, as a fixed point, dropped silently.

### Two witnesses for "someone else already has this issue"

09's P2 unit 2 refuses an issue whose newest ledger row names a different branch, with a missing
`runs.jsonl` disabling it silently. That collides head-on with 14, which closed with *the ledger may
be used as a hint to order or skip the scan — **never as truth***. Under a wide default that anyone
must consent to explicitly the collision was tolerable; under `--issues all` unit 2 became the whole
contents check, so it had to be settled.

It splits into two questions with two different witnesses, and **neither is asked something it
cannot know**:

- **Landed elsewhere** — some other ref's copy of the issue says `Status: Done`. Git knows this, so
  it is answered by 14's ref scan (`for-each-ref` + one batched `cat-file`; measured 2712 blob reads
  in 0.62s) and it is a **hard refusal**. Truth, host-independent, self-correcting after a
  `--hard-reset` discards a branch.
- **In-progress elsewhere** — a run is mid-flight on another branch, `Status:` not yet `Done`
  anywhere. **Git has no witness for this.** The two colliding issues on 08-18 were exactly this
  case. The ledger is the only record that knows, and it is machine-local, so it answers as a
  **hint**: refuse when the row exists, stay silent when it does not.

That keeps 14 intact rather than bending it. 14 forbids machine-local state deciding **correctness**;
this guard only decides whether a run is *wasted*, which is the bucket 14 already assigned host-local
records to. An over-refusal that fires on one host and not another is asymmetric in the safe
direction and already has its escape hatch in enumerating `--issues`.

### Feedback-only stays derived, and the ticket's own premise was wrong

Item 3 proposed a `--feedback-only` flag as insurance for the 08-19 incident. Reading the ledger
retired the premise. The recorded row for that branch (`.agentbox/runs.jsonl:47`) is:

```
branch=speepobox-t37  feature=effect-agentbox  issues={"37": "approved"}  task_dir=docs/wayfinder/effect-agentbox
```

One issue, approved. Under the replay rule, `--resume speepobox-t37 --feedback "…"` reads that array,
filters the approved entry, finds nothing recoverable, sees feedback, and *is* a feedback-only run.
**The ruling above already fixes T37 outright.** bash got it wrong only because it went to `task_dir`
and rescanned the folder, where three issues were not Done on that branch. (The bad run left no
ledger row — it was killed before completion.)

So **no flag.** Feedback-only remains derived: a resume whose recorded set is exhausted, plus
`--feedback` present. `resume.ts:118`'s `FeedbackOnly` arm already models it; P2 only widens what
feeds it. It is not "the command named no issues" — spec mode sits in that same hole and is an
ordinary run — it is a positive condition with exactly two instances, both under resume: a recovered
`OneOff` whose spec file is gone, and a recovered `Feature` whose every entry is approved.

The ticket's thesis — *printing isn't stopping* — was tested against this and does not carry, because
it rests on harm. Believing feedback-only and getting a feature run is closed by the replay rule.
Believing a feature run and getting feedback-only costs one agent pass against a PR: nothing claimed
wrongly, no cross-branch edit, visible in the first status line. A guard earns its place by
preventing damage, not by confirming a belief.

**One obligation instead of a flag:** the resolved-plan render must print the mode as its own line,
not leave it inferable from the absence of an issue list, so `--dry-run` can confirm a belief for
anyone who wants it checked.

### What a resume may inherit

Inherited, all values: **`--base`** (via `lastBaseForBranch`; an explicit `--base` overrides), the
**branch identity**, the **PR**, and the **recorded issue set** filtered by recorded outcomes.
**Not** inherited: feedback, which is per-run and is not on the record.

Two spellings are constrained:

- **`--issues all` on a `--resume` is refused.** It has two defensible readings — everything in the
  record including approved entries, or a fresh scan of `task_dir` picking up issues added since —
  and neither dominates, which is the tell. A token with two plausible meanings is the shape this
  ticket exists to eliminate. The unambiguous spelling of the second already exists:
  `--feature <folder> --issues all --branch <same branch>`, one flag longer and unmisreadable. Cost:
  that route records a fresh `Feature` row instead of a `FeedbackResume` wrapping the old one, so the
  run-to-run link is not captured. Minor — the branch is the identity that matters.
- **Enumerated `--issues` on a `--resume` must be a subset of the recorded set.** Legality is not
  coherence: `--resume` means *continue this run*, and continuing with issues the run never had is a
  new run wearing resume's clothes, inheriting base, PR, and identity from a record about different
  work. Narrowing *is* continuing — "of the three the record left unfinished, retry just T31" — and
  it is the common shape after a partial failure like the `implement-failed` row on `speepobox-t15`.
  The check is set membership against `issues[]`, already on the record.

Together these give one rule short enough to state whole: **a resume can only ever run some of what
it ran before.**

### Guards split into two phases, by what they ask

The map's adjacent fog item — *`--base` resolves before `git fetch origin`* — is closed here, and it
mostly dissolved. Its leaning was *re-read the issue set after the fetch*; the replay rule removes
the need, because the set is named rather than read. What survives is narrower: the issue *content*
(`Status:`, `Blocked by:`, `Type:`, and the bodies the agent gets) still comes off a tree, and
`origin/<x>` resolves to one SHA before the fetch and possibly another after.

Three candidates: pin the pre-fetch SHA (deterministic, but every dispatch runs a fetch behind);
fetch first then resolve (fresh, but a typo'd `--branch` now costs a network round trip, which is
what `run.sh`'s cheap-local-validation-first invariant exists to prevent); or **two resolutions doing
two different jobs**, which is the ruling.

The general form is that guards split by *what they ask*:

1. Parse.
2. **Local guards** — ref-shaped and host-shaped facts only: branch exists / not protected / not
   checked out, `--base` resolves at all, docker, gh, credential, setup-hook path. No network, and
   **no repo content**. A `--base` that exists only on origin is still refused here, keeping
   `guards.ts:268`'s message and matching bash.
3. `git fetch origin`.
4. **The authoritative `--base` resolve** → one `BASE_SHA` that the run forks from, materializes
   from, records, and prints. `resolveMergeBase` moves here with it, because the diff boundary must
   be the boundary the run actually forked from.
5. **Content guards** — the issue set is expanded and validated **once**, here, against the fork
   commit. `all` evaluates its predicate here. An enumerated set is checked here (exists, `Type:
   AFK`, not already Done on this ref, blockers Done-or-selected). The previous section's two checks
   run here too.
6. Lock → checkout → sandbox.

Two consequences worth having in writing:

- **Nothing is validated pre-fetch, so there is no pre/post disagreement to catch.** A set cannot
  pass early and fail late, and `all` cannot expand against a stale tree, because neither happens
  before step 5. This was the question that produced the phase split.
- **Step 5 needs no working tree.** It reads blobs at `BASE_SHA` with `cat-file` — 14's already
  measured technique — so it fits before the checkout with no ordering problem. The ref scan also
  gets *better* here, since `refs/remotes` is post-fetch, which retires 14's stale-remote caveat.

**Row 1 of the failure matrix is not dented.** Its invariant is *nothing acquired* — no lock, no
clone, no container, no ledger row — and all of that holds through step 5. A fetch mutates
remote-tracking refs but holds nothing and has no release. An earlier draft of this resolution
recorded a dent here; there is none.

### Which tree the agent reads

`run.sh:1668-1670` mounts host paths for both modes — `$issues_dir_abs:/feature-issues:ro` and
`$spec_abs:/spec.md:ro`. With the gate above reading issue state from the fork commit, that would
have the dispatcher reading one tree and the agent reading another.

Split by what the thing **is**, not by mode for its own sake:

- A **spec** is inert. Nothing writes back to it; it is meaningful only to the run it was handed to.
  It is a work order, not repo state, and drafting one and dispatching it uncommitted is the normal
  workflow. **`/spec.md` keeps mounting from the host.**
- An **issue** is read *and written*: the dispatcher parses its headers to decide the selection, then
  stamps `Status: Done` on approval — which 14 made a commit on the run branch precisely because the
  state differs per branch. **`/feature-issues` mounts from inside the checkout**, which is already
  at the fork point.

Nearly free: the map ruled on 2026-08-20 that **the port requires issue folders to be tracked**, so
the folder is always inside the checkout. This is a path change, not new machinery — no extract step.
bash mounts the host path only because `.agentbox/tasks/*/` is untracked (`run.sh:135-136` still says
*issue files live outside the checkout*), and that case dies with bash.

### bash gets nothing

09's position, upheld, now with a count behind it. Of 38 files in `issues/`, **exactly one is open**
— `T36`, `needs-info`, blocked by ticket 16, which is a wayfinder ticket and not an issue number, so
the fixed point drops it from any wide selection anyway. Remaining dispatches before move-out are
T36 plus whatever tickets 15 and 16 spawn, against a folder where the wide default now resolves to
approximately nothing.

A five-line arg-parse refusal was considered on a vocabulary argument — dispatchers arriving at P2
already typing `--issues all` — and rejected on the count: five lines of change to the live
dispatcher to protect three dispatches against a selection that resolves to nothing. Porting the
replay rule into bash was never in the running; it reaches `resume_dispatch_action`, the untested
half 04 and 09 both rule off-limits this close to move-out.

This leaves 08-19's resume-rescan reproducible in bash until move-out. Accepted, with the same
disposition and the same evidence the map already applied to the picker-reads-host-tree divergence on
2026-08-20: **let it die at P3.**

### Deliverables

1. **09's P2 amended** — it invited this as *a floor, not a ceiling*. Unit 1 gains `--issues all` as
   the spelled wide form; unit 2 splits into the two witnesses above.
2. **SPEC §7 updated** — the `--issues`, `--resume`, and `--base` rows; the two-phase guard order;
   the plan render naming the mode.
3. **No `AGENTS.md` line owed.** Stated otherwise mid-grill and revised: `AGENTS.md` carries only
   what no diagnostic can catch — naming, the outcome-row test, pick-one-where-both-typecheck calls.
   Everything here is spec behaviour with a test, not a call an agent could get wrong two ways that
   both compile.

### Parked, not resolved here

Two things surfaced that are about the **prompt** surface rather than the command surface, and both
graduate to the map's *Not yet specified* rather than being wedged in:

- **Prompting without reference to a spec, in general** (user's framing). The nearest thing this
  ticket considered was a `--feedback-only` that *suppresses* recoverable work; it was rejected as
  the wrong vehicle. The general capability is its own feature and its own decision.
- **Cross-round feedback context.** Verified: the container gets `/workspace`, the spec or issues
  mount, the two `/agentbox/*` scripts, and the node_modules/yarn volumes (`run.sh:1682-1687`).
  `.agentbox/logs/` is not among them, and the agent reaches no GitHub credential, so it can read
  neither the logs nor the PR. Feedback text reaches the implement, review, and PR-description
  prompts **for that run only** and is persisted nowhere the next round can reach. Across N rounds
  the agent's entire memory is the branch's own commit history. Round 3 cannot see what rounds 1 and
  2 asked for. **Graduated 2026-08-21 to
  [ticket 17](17-feedback-that-forbids-leaves-no-trace.md)**, which sharpens it to *prohibitions*
  specifically and re-derives the evidence — two citations here are loose. `run.sh:348` is the
  preflight ancestry check, not a checkout exclusion; the residents are absent from the clone because
  `.agentbox/.gitignore:1-6` untracks them. And a GitHub token variable *is* passed, but it
  is empty, so it authenticates nothing. The conclusion holds three times over; only the
  reasons given for it were thin.
