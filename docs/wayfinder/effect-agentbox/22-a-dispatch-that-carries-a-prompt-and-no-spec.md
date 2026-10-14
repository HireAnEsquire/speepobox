# 22 — A dispatch that carries a prompt and no spec

Labels: `wayfinder:grilling`
Map: [MAP.md](MAP.md)
Blocked by: —
Assignee: Scott Bowles (claimed 2026-09-18)
Status: closed (resolved 2026-09-21; implementation is
[T66](issues/T66-the-task-is-one-union-and-resuming-is-the-identitys-fact.md) then
[T67](issues/T67-a-task-stated-on-the-command-line.md))

## Question

**What is a dispatch that carries a prompt and no work order — a mode, an empty selection, or a
different entrypoint — and how does it fit beside P2's rule that a selection the dispatcher did not
name is a proposal?**

Graduated 2026-09-18 from the map's *Not yet specified* (*Prompting without reference to a spec*),
where [15](15-a-dispatch-names-the-work-it-will-do.md) parked it on 2026-08-21. 15 considered one
vehicle — a `--feedback-only` that *suppresses* recoverable work rather than asserting there is none
— and rejected it as the wrong one for a general capability. The general capability is this ticket.

## What is true today

**The capability exists, and it is reachable only by accident.** Today the one way to hand the
agent text with no spec behind it is `--resume <branch> --feedback "…"` on a branch whose recorded
spec has since left the disk — `resumeDispatchAction`'s `FeedbackOnly` arm (`src/dispatch/resume.ts`),
which 15 named as one of exactly two instances of feedback-only, both under resume. A fresh dispatch
with `--feedback` and no `<spec>` is refused by `specGiven` (`src/dispatch/guards.ts:157`): *"a spec
is required — pass <spec>, or --resume <branch>"*. So a dispatcher who wants to say *"fix the typo in
the README on this branch"* has to write a spec file first, or has to have dispatched a spec once and
then deleted it.

**Most of the machinery is already built, on the wrong door.** `WorkOrder` (`src/dispatch/plan.ts`)
is a two-arm union — `Spec { feedback: Option }` and `FeedbackOnly { feedback: string }` — and every
downstream site already keys on it rather than on the presence of a spec path:

- `specMount` (`src/sandbox/spec.ts`) mounts nothing on the `FeedbackOnly` arm, so no docker-invented
  directory appears in the served repo (T7, T17).
- `renderFeedbackOnlyPrompt` (`src/agent/prompt.ts`) frames the text as *the* work order, drops the
  spec sentence, and carries the backstop T37 kept for overridden templates.
- The review round swaps its criteria from *fidelity to the spec* to *was the feedback addressed and
  did nothing break*.
- `prContextFor` (`src/dispatch/feedback.ts`) fetches the PR's title and body, best-effort, on this
  arm alone.

What is *not* built is a front door, an identity, and a name. The ledger's `DispatchIdentity` is
`OneOff { spec }` or `Feature { feature, issues }` (`src/ledger/record.ts:57-72`); a run whose work
order is text has no arm to be recorded under, so it also has nothing for a `--resume` to replay.

**The vocabulary is off by one word.** `--feedback` is the right name for text appended beside a
spec, and a defensible one for text that revives an exhausted resume. On a first dispatch there is
nothing to feed back *on*. The repo's own vocabulary already has the right word: `CONTEXT.md` opens
with *"it takes a work order"*, and `plan.ts` calls the union `WorkOrder`. Neither is a glossary
entry yet, and *spec* is not either.

## Where the answer has to fit

[09's P2](09-post-move-sequence.md) (lines 208–231): *a selection the dispatcher did not name is a
proposal, not an instruction*, shipped as a refusal rather than a prompt because `src/` has no TTY
surface until P3 — and *"if P3's picker makes selection interactive, unit 1 can soften then."* 15
restated the whole thing as *the dispatcher may replay a work set it recorded, and may execute a set
the command named; it may never compute one the command did not name.*

A prompt-only dispatch names no issue set and no spec file. The question this ticket exists to
settle is whether that is *nobody said anything* — the case the refusal catches — or whether text on
the command line is the work being named, by a third spelling beside a file and a set. And at P3,
whether the picker's interactive selection has a row for it.

## The frontier

Asked as one round, per the map's standing preference. Each carries a recommendation.

1. **What is it?** *Recommend: a third kind of work order, not a mode and not an entrypoint.* A
   *mode* here means an identity and ledger shape (one-off, feature, resume) — a prompt-only run is
   still one branch, one container, one PR, and needs every guard, the lock, and the checkout, so a
   second entrypoint would re-derive the whole dispatch. `WorkOrder` is already *what the passes are
   for*, and `FeedbackOnly` is nine-tenths of this arm; what is missing is that it can only be
   reached through a resume. Rejected reading: *an empty selection* — that makes it an edge case of
   feature mode, where it has nothing to do with issues.
2. **Does it trip P2's refusal, and what happens at P3?** *Recommend: no, and the picker gets a row.*
   The refusal is for a set the dispatcher *computed*; a prompt on the command line computes nothing
   and names the work outright, so under 15's rule it is *named*, by text rather than by file. At P3,
   when selection is interactive, the picker offers it as the third choice beside *pick a spec* and
   *pick a feature*, entered through the git-commit-style editor flow SPEC §7 already specifies for
   `--feedback-edit` — one editor bracket for both, not two.
3. **What is it called — on the command line and in the glossary?** *Recommend a distinct flag, and
   two glossary entries.* Reusing `--feedback` with the meaning derived from context would give one
   flag three meanings (appended beside a spec, the whole order on an exhausted resume, the whole
   order on a fresh dispatch) — the shape 15 exists to eliminate. Candidates for the flag: `--prompt`
   (the user's own framing, but the word already means the templates under `prompts/`, and
   `PromptSource` resolves them), `--task` (collides with `tasks-dir`, which is where *specs* live),
   `--order`, `--brief`. Glossary: **Work order** — what a dispatch is told to do; one of a spec, an
   issue set, or the dispatcher's own text — and **Spec** — a work order that is a file. The
   feedback-only arm keeps its name because it is still reached by feedback.
4. **What does the ledger record, and what does a resume of it do?** *Recommend: a third
   `DispatchIdentity` arm carrying the text verbatim, and a resume replays it.* `OneOff { spec }` has
   nowhere to put text, and `spec: ""` is the nullable pair T2 deleted. With the text on the row,
   `--resume` of a prompt-only branch recovers the order exactly as it recovers a spec name — 15's
   replay rule — and `--feedback` on that resume is appended instructions, as on a spec resume. A
   prompt-only order cannot be *gone from disk*, so 15's feedback-only derivation never fires for it;
   a dispatcher who wants a *new* order on the same branch dispatches fresh on `--branch`, not
   `--resume`. Cost: long text on a ledger line. The log already holds the assembled prompt verbatim,
   so the row could hold a pointer instead, but a pointer into a log the operator may have moved
   breaks replay, and replay is the row's job.
5. **Does `FeedbackOnly` survive as its own arm?** *Recommend: no — two arms, `Spec` and the new
   one, with the resume framing keyed off `RunIdentity` rather than a third arm.* Today's
   `FeedbackOnly` prompt says *"this is a FEEDBACK-ONLY run resuming branch X — read the accumulated
   work first"*; that sentence is true because the identity is a `FeedbackResume`, not because the
   work order is text. Splitting *what the order is* from *whether this is a resume* makes the
   resume-of-a-prompt-only-run in Q4 fall out with no fourth arm. Cost: T17's naming (`FeedbackOnly`,
   `FEEDBACK_WORK_ORDER_OPEN`) is swept.
6. **Which spellings are refused?** *Recommend all four:* the flag with `<spec>` (two work orders);
   the flag with `--resume` (a new run wearing resume's clothes, 15); the flag with `--feedback` on a
   fresh dispatch (two texts, and the flag already says which it is); and an empty or whitespace
   value (as `--resume ''`). `--feature` is untouched: its work orders are issues.
7. **Where does it land?** *Recommend: one AFK issue now, on the one-off path, not pinned to a
   P-bullet.* It touches the parser, `WorkOrder`, one identity arm, one prompt message, `status`'s
   renderer, and their tests; the mount and the review criteria are already keyed on the arm. Nothing
   in it waits on P2's feature mode or P3's picker — the picker row in Q2 is P3's to add when it
   exists. The alternative is to hold it for P3 and ship it with the editor bracket; that costs every
   dispatch between now and then a spec file for a one-line instruction.

## Resolution — 2026-09-21

**A dispatch may state its task on the command line, and that is a task like any other.**
`bessemer --branch <b> --task "…"` runs the one-off path end to end — every guard, the lock, the
checkout, the three passes, the PR — with the text as what the passes are for, nothing mounted at
`/spec.md`, and the text recorded on the ledger row so a `--resume` replays it. It is not a mode,
not an entrypoint, and not an empty selection. Four rounds; the flag's name took three of them, and
the word it settled on reshaped the glossary.

### 1. What it is: a third way of stating a task

The port already resolves *what the passes are for* as a two-arm union (`WorkOrder` in `plan.ts`:
the spec at a path, or the feedback text on an exhausted resume), and the mount, the prompt framing,
the review criteria, and the PR-context fetch all key on that arm rather than on whether a path
exists. The whole of what was missing is a front door, an identity, and a name. So the text is a
third arm of that union — and after §3, the union's own name changes.

Rejected: a *mode*, because a mode here is an identity and ledger shape (one-off, feature, resume)
and this run is one branch, one container, one PR exactly as a spec run is; a second *entrypoint*,
which would re-derive the whole dispatch; an *empty selection*, which makes it an edge case of
feature mode where it has nothing to do with issues.

### 2. It fits 09's P2 without touching it, and P3 gets a row

09:208–231 refuses a selection the dispatcher did not name — a set the tool would otherwise
*compute*. Text on the command line computes nothing: under 15's rule it is the work *named*, by a
third spelling beside a file and a set. No guard fires and the refusal is unchanged. When P3 makes
selection interactive, the picker offers the task typed inline as its third row beside *pick a spec*
and *pick a feature*, entered through the git-commit-style editor bracket SPEC §7 already specifies
for `--feedback-edit` — one editor bracket, not two. Recorded as a comment on 09.

### 3. The name is `--task`, and *task* means the work, not the file

Three candidates fell in order. **`--feedback` with the meaning derived** would give one flag three
meanings (appended beside a spec, the whole order on an exhausted resume, the whole order on a fresh
dispatch) — the shape 15 exists to eliminate. **`--prompt`** was the user's framing and every agent
CLI's spelling, and it collided three ways: the per-pass files under `prompts/`, the assembled text
`CONTEXT.md`'s *Pass* entry already calls "one prompt", and the flag. Renaming the files was weighed
(*playbook*, *pass*, *template*, *skill*) and every candidate lost — *template* promises slots 05 Q9
rejected; *skill* borrows one provider's mechanism for a CLI-agnostic file and collides with the
plugin skills this repo runs; *playbook* and *passes/* were disliked or overloaded *Pass*. The
finding that settled it: the code already treats the file and the assembled text as one noun at two
stages (`renderImplementPrompt(template, run)` takes the file and returns the prompt), which is
natural and trips nobody, so `prompts/` stays and only the flag had to move. **`--brief`** solved the
collision at the cost of a fourth word.

**`--task`** won once the spec/task inheritance was read straight. bash called the file a task
(`.agentbox/tasks/<name>.md`, `tasklib.py`, `task_dir`); the port calls it a spec and kept *task* in
three places — `tasks-dir`, the implement prompt's `# TASK`, and "the task's diff boundary" — where
the last two mean the unit of work, not the file. Taking that reading: **a task is what a dispatch
is to do; a spec is a task stated as a file; `--task` is a task stated inline.** Three words, no
sweep of `prompts/`, and *work order* retires in favour of the word the repo already used.

Glossary, written into [`CONTEXT.md`](../../../CONTEXT.md): **Task**, **Spec**, **Prompt** (the
per-pass file; the run appends the task and feedback below it), and the *Pass* entry re-spelled.

### 4. The ledger records the text, and a resume replays it

A third `DispatchIdentity` arm carries the text verbatim on the run's row in `runs.jsonl`, written
by the finalizer whatever the outcome. `--resume` of that branch recovers the text as it recovers a
spec name (15's replay rule), and `--feedback` on that resume is appended, as on a spec resume. The
text cannot be *gone from disk*, so 15's feedback-only derivation never fires for it; a dispatcher
who wants a different task on the same branch dispatches fresh on `--branch`, not `--resume`. A
pointer into the run log was rejected: the log may move, and replay is the row's job. Two caveats
already true for specs: a run killed before the finalizer leaves no row, and `--dry-run` writes
none.

### 5. `FeedbackOnly` collapses: two arms, and the resume framing comes from the identity

Today's feedback-only prompt says *"this is a FEEDBACK-ONLY run resuming branch X — read the
accumulated work first"*. That sentence is true because the identity is a `FeedbackResume`, not
because the task is text. Splitting *what the task is* from *whether this is a resume* leaves two
arms — a spec, or inline text — and the resume-of-an-inline-task in §4 falls out with no third.
T17's `FeedbackOnly` naming and its markers are swept in T66, which carries this section as its
own ticket so that T67's flag lands as a pure addition.

The same split decides `prContextFor`, and this paragraph postdates the resolution above: the
collapse forced the choice and the `/to-tickets` pass of 2026-09-21 made it. Today the view is
asked on the feedback-only arm alone, and the comment beside it says why — an ordinary implement
prompt had no place for the section, so the call would be a round trip nobody reads. Once the
framing is the identity's, the section has a place on both arms, and the predicate has no
single-term translation. Three were on the table: identity **and** inline arm (rows 6, 8, 9 —
today's set carried over); identity alone (rows 4, 5, 6, 8, 9); inline arm alone (rows 3, 6, 8,
9 — a fresh `--task` fetches a PR describing superseded work, wrong). **Decided: identity alone.**
A resume's feedback is written by a human who read the PR, and the PR body is what the feedback
refers to; that is as true when the spec is on disk as when it is gone, so limiting the view to
the inline arm keeps an accident of T17's layout rather than a rule. A fresh dispatch never asks.
Best-effort stays as it is: a failed view warns and costs the prompt one section.

### 6. The chart

| # | Command | Task stated by | `/spec.md` | Identity recorded | Framing |
| --- | --- | --- | --- | --- | --- |
| 1 | `my-spec --branch b` | spec file on host | yes | `OneOff{spec}` | read the spec |
| 2 | `my-spec --branch b --feedback "x"` | spec file | yes | `OneOff{spec}` | as 1; feedback appended |
| 3 | `--task "x" --branch b` | the text | no | inline arm, text | the text is the task — **new** |
| 4 | `--resume b` (spec present) | recorded spec | yes | `FeedbackResume{OneOff}` | read the spec; resuming, read the branch first |
| 5 | `--resume b --feedback "x"` (spec present) | recorded spec | yes | `FeedbackResume{OneOff}` | as 4; feedback appended |
| 6 | `--resume b --feedback "x"` (spec gone) | the feedback text | no | `FeedbackResume{OneOff}` | text is the task; resuming |
| 7 | `--resume b` (spec gone, no feedback) | — | — | — | refused: restore the spec or dispatch by name |
| 8 | `--resume b` (last ran `--task`) | recorded text | no | `FeedbackResume{inline}` | text is the task; resuming — **new** |
| 9 | `--resume b --feedback "x"` (last ran `--task`) | recorded text | no | `FeedbackResume{inline}` | as 8; feedback appended — **new** |
| 10 | `--task "x" my-spec --branch b` | — | — | — | refused: two tasks |
| 11 | `--task "x" --resume b` | — | — | — | refused: a resume replays its record (15) |
| 12 | `--task "x" --feedback "y" --branch b` | — | — | — | refused: two texts |
| 13 | `--task "" --branch b` | — | — | — | refused: empty |
| 14 | `--feature f --issues all --branch b` | issues in the checkout | no (`/feature-issues`) | `Feature` | per issue — P2, untouched |
| 15 | no args on a TTY | picker: spec / feature / **task** | per choice | per choice | P3 |

Constants: `--branch` is required on every fresh dispatch and must exist; a resume implies it.
`--base` on a fresh dispatch is the ledger's last base then the configured base; on a resume it is
inherited. Feedback is never inherited.

### 7. Deliverables

1. [`CONTEXT.md`](../../../CONTEXT.md) — *Task*, *Spec*, *Prompt* added; *Pass* and the opening
   line re-spelled from *work order*.
2. [SPEC §7](SPEC.md) — the `--task` row, the mount rule, the plan render's mode line.
3. [09](09-post-move-sequence.md) — one comment: P3's picker gets the task row.
4. **Two AFK issues, now, on the one-off path**, split in the `/to-tickets` pass of 2026-09-21
   because the collapse has its own green and the flag reads as a pure addition without it:
   [T66](issues/T66-the-task-is-one-union-and-resuming-is-the-identitys-fact.md) — `Task` replaces `WorkOrder`,
   `FeedbackOnly` collapses into the inline arm, the resuming framing and the PR context are keyed
   off the identity; then [T67](issues/T67-a-task-stated-on-the-command-line.md) — the flag, the ledger arm,
   the four refusals, `status`, and the plan render's mode line, blocked by T66. Nothing in either
   waits on P2 or P3; the picker row is P3's to add when the picker exists.
