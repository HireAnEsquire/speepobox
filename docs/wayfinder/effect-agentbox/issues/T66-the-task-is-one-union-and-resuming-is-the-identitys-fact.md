# T66 — The task is one union, and resuming is the identity's fact

Status: Done (PR #26; the plan's path had five readers, not the three §1 listed — the PR trailer and the run log's plan line were the two it missed)
Type: AFK
Blocked by: none.

<!--
[Ticket 22](../22-a-dispatch-that-carries-a-prompt-and-no-spec.md) §1 and §5, resolved 2026-09-21.
22 produces two implementation tickets, and this is the first: the prefactor that makes the second
— [T67](T67-a-task-stated-on-the-command-line.md), the `--task` flag — a pure addition. It was
split out because it has its own green (every existing dispatch behaves as before, under new names,
with one sentence and one section added on the resume arms) and because its one real decision — the *resuming*
framing comes from the identity, not from the arm — would be invisible under the flag's diff.

Nothing here is reachable from a new command line. After this ticket the inline arm is entered
exactly where T17's feedback-only arm was: a resume whose recorded spec is gone plus `--feedback`.
-->

## What to build

**What a run's passes are for is a `Task` with two arms — a spec at a path, or text stated inline —
and whether the run is a resume is read off its identity, never off the arm.** T17's `FeedbackOnly`
arm, its `FEEDBACK-ONLY` prompt heading, and the phrase *work order* leave the tree. Every dispatch
that runs today runs the same afterwards, with two additions on the resume arms that 22 §5 and §6
decided.

### 1. The union

`WorkOrder` (`src/dispatch/plan.ts`) becomes `Task`, with the spec's path moved onto its arm:

```ts
// The shape 22 §5 decided; field names are the implementer's, the split is not.
Task = Spec   { path: string;  feedback: Option<string> }
     | Inline { text: string;  feedback: Option<string> }
```

`DispatchPlan.spec` is deleted — the resolved path has no meaning on the inline arm, and the field's
own comment already tells every reader to consult the arm before trusting it. Its readers move to
the arm: the mount (`sandbox/spec.ts`) mounts the `Spec` arm's path and nothing on `Inline`; the
plan banner (`dispatch/render.ts`) prints the path on `Spec` and the words *inline task* on `Inline`
(T67 replaces that with a summary of the text); the `OneOff` identity is built from the arm's path.

`feedbackIn` keeps its name and its meaning — *the dispatcher's feedback, whichever arm* — so on
`Inline` it answers `feedback`, **not** `text`. The text is the task and travels as one; see §3.

Chart row 6 (a resume whose spec is gone, with `--feedback`) becomes
`Inline { text: <the feedback>, feedback: none }`. Its identity is still `FeedbackResume { OneOff }`
and its ledger row is unchanged.

### 2. Resuming is a fact of the identity

Today only the feedback-only prompt says the run is resuming, and it says so because it is the arm
that happened to be built for a resume. The sentence is true of every `FeedbackResume` and false of
every one-off, whichever arm the task is on. So:

- `PassRun` (`agent/prompt.ts`) learns whether the run is a resume — a boolean derived once where the
  `PassRun` is built from the plan, or the identity itself; either way the prompt functions stay pure
  over `PassRun` and never read the plan.
- The implement message on **both** arms carries, when resuming, one sentence saying the run resumes
  branch `<b>` and the pass reads the branch's accumulated work against the diff boundary first
  (`git log <mb>..HEAD` / `git diff <mb>..HEAD`), before it adds to it. Chart rows 4, 5, 6 (and 8, 9
  once T67 lands). A one-off says nothing about resuming.
- The heading `This is a FEEDBACK-ONLY run …` is gone. Nothing in any generated message says
  *feedback-only*, *work order*, or *FEEDBACK-ONLY*.

### 3. The inline arm's three messages

The text rides in its own fenced section on every pass — the successor of `FEEDBACK_WORK_ORDER_OPEN`,
named for what it is (a task stated inline), with a close marker — and the feedback, when there is
any, rides in the existing feedback section after it, exactly as on the spec arm. Today row 6's
review and description passes receive the text only because `feedbackIn` returned it; after §1 it
does not, so the task section is what carries the text to all three passes.

- **Implement**: template, the resuming sentence when resuming, the backstop (`NO_SPEC_MOUNTED`, only
  under a template naming `SPEC_TARGET` — T37's rule, unchanged), branch and boundary, the task
  section, the feedback section, the PR context section.
- **Review**: template, branch and boundary, the round note, the swapped criteria re-worded for a
  task stated inline (*judge the diff against the task below, not spec fidelity*; addressed and
  nothing broken), the backstop on the same condition, the task section, the feedback section.
- **Describe-PR**: template, describe-the-work, the backstop on the same condition, the task section,
  the feedback section.

The spec arm's three messages are unchanged except for §2's sentence and §4's section.

### 4. PR context on every resume

`prContextFor` (`dispatch/feedback.ts`) asks the forge when `plan.identity._tag === "FeedbackResume"`
and never otherwise. This is **not** in 22's resolution: the collapse forced the choice, and the
`/to-tickets` pass of 2026-09-21 made it — recorded in 22 §5 beside the two predicates it beat
(identity *and* `Inline`, which is today's set carried over; `Inline` alone, which fetches on a
fresh `--task`). The reasoning, so the predicate is not "fixed" back to the narrow one: the PR
body is what the human read before writing feedback and what the feedback refers to, on a spec
resume as much as on an inline one; on a fresh dispatch of a branch that already has a PR the body
describes superseded work, so it is misleading context. The comment beside today's predicate — a
`gh` call nobody reads is a round trip inside every dispatch — is retired by the same change,
because the **spec** arm's implement message gains the PR context section on a resume and reads
it; the section it had no place for was an implementation accident, not a rule. Review and
description passes do not receive it, as today. Best-effort as today: a failed view warns and
costs the prompt one section.

### 5. The sweep

Every use leaves; every mention in a comment that explains history may stay if it says which ticket
it is history of.

- `FeedbackOnly` (the tag, `ResumeAction`'s arm — rename it for what the table decided, which is
  *the text stands in for the missing spec*, not for the flag it arrived on), `renderFeedbackOnlyPrompt`,
  `feedbackOnlyReviewCriteria`, `FEEDBACK_WORK_ORDER_OPEN`, `SPEC_WORK_ORDER`, `WorkOrder`, and the
  phrase *work order* in `src/` and `test/` (`plan.ts`, `dispatch.ts`, `resume.ts`, `feedback.ts`,
  `command.ts`, `run.ts`, `pr.ts`, `agent/prompt.ts`, `agent/agent-cli.ts`, `dry-run/agent-cli.ts`,
  `forge/forge.ts`, `sandbox/spec.ts`; `test/dispatch.test.ts`, `agent-prompt.test.ts`,
  `agent-cli.test.ts`, `sandbox-spec.test.ts`, `forge.test.ts`, `roots.test.ts`,
  `support/forge-fake.ts`).
- `--feedback`'s help text: *on a `--resume` whose spec is gone, it stands in as the task* — the
  glossary's own sentence (`CONTEXT.md`, *Feedback*).
- `AGENTS.md`, the four bullets under *The agent passes and the review* that name `WorkOrder`,
  `FeedbackOnly`, or *feedback-only* as an arm (currently 474–510): re-spelled for the two-arm
  `Task`, the identity-keyed framing, and the every-resume PR context, each ending in `(T66)`
  beside the ticket it revises. Add the rule this ticket is: **the resuming framing comes from the
  identity, never from the arm** — a sentence keyed off the arm typechecks and is false on a
  spec resume and false on a fresh inline dispatch.
- SPEC §7's *feedback-only* survives as the name of chart row 6's **situation** (a resume whose
  spec is gone plus `--feedback` — "feedback-only has no flag", §7:429) and nowhere as the name of
  an arm, a function, or a prompt heading.

### Out of scope

`--task` itself, the ledger's inline identity arm, `status`'s cell for it, the plan render's mode
line, and the four refusals — all [T67](T67-a-task-stated-on-the-command-line.md).

## Effect wiring

- **Tags introduced or consumed**: none introduced. `Forge` and `Reporter` are consumed where they
  already are (`prContextFor`); `AgentCli.implement` keeps `Reporter` in its requirements
  (`@effect-expect-leaking Reporter`, T10).
- **Layer composition**: unchanged. `app.ts` is not touched; the recording `AgentCli` layer
  (`dry-run/agent-cli.ts`) follows the rename only.

## Acceptance criteria

- [ ] A fresh spec dispatch (chart rows 1–2) assembles the three messages it assembles today, byte for
      byte, plus nothing: no resuming sentence, no PR context section, and the fake forge records no
      `prView` call.
- [ ] A spec resume (rows 4–5) carries the resuming sentence naming the branch and the boundary, and
      the PR context section when the view succeeds; when the view fails the run warns, the prompt
      lacks the section, and the run proceeds.
- [ ] A resume whose spec is gone with `--feedback` (row 6) runs on the `Inline` arm: implement,
      review, and describe-PR messages each carry the text in the task section, the resuming sentence
      where §3 puts it, no `FEEDBACK-ONLY` wording, no mention of `/spec.md` under the shipped
      templates, and the backstop under a template that names `SPEC_TARGET`.
- [ ] Row 6 mounts nothing at `/spec.md`; rows 1–2 and 4–5 mount the spec path read-only.
- [ ] Row 6's ledger row is `FeedbackResume { OneOff }` as before; every fixture line in
      `test/status.test.ts` and `test/ledger.test.ts` decodes unchanged.
- [ ] Row 7 (spec gone, nothing said) still refuses with the message it refuses with today.
- [ ] `DispatchPlan` has no `spec` field; the mount, the banner, and the identity read the arm.
- [ ] `--dry-run` of a spec run prints the plan block it prints today.
- [ ] `git grep -n -i "FeedbackOnly\|FEEDBACK_WORK_ORDER\|WorkOrder\|work order\|feedback-only" src test`
      returns nothing, and the same grep over `AGENTS.md` returns only lines that name a ticket as
      history.
- [ ] `node src/bin.ts --help` says `--feedback` stands in as the task on a resume whose spec is gone,
      and says *work order* nowhere.

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package.

```
git grep -n -i "FeedbackOnly\|FEEDBACK_WORK_ORDER\|WorkOrder\|work order\|feedback-only" src test
git grep -n -i "FeedbackOnly\|FEEDBACK_WORK_ORDER\|WorkOrder\|work order\|feedback-only" AGENTS.md
node src/bin.ts --help | grep -i "work order" ; echo "exit $? (1 is the pass)"
```

The first grep must print nothing. The second may print only lines that name a ticket as history
(`(T17)`, `(T66)`) — read each hit. The third line is the distribution-model check the gate cannot make (06): plain node, no vitest
transform.
