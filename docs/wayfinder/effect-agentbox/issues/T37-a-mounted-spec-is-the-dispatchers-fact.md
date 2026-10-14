# T37 — A mounted spec is the dispatcher's fact, not the template's

Status: Done
Type: AFK
Blocked by:

Not on the move-out path. It runs beside T15/T36 rather than after them, and touches three templates,
three render functions, and their tests.

**Tracer: a feedback-only run's three prompts never assert a file that is not in the container, and
no sentence anywhere retracts one that was.**

## Context

Every one of the three shipped templates opens by asserting the spec is mounted:

- `prompts/implement.md:3` — "Your task spec is `/spec.md` (mounted read-only). Read it first"
- `prompts/review.md:5` — "the spec is `/spec.md` (mounted read-only)"
- `prompts/describe-pr.md:7` — "The spec the work was implemented from is `/spec.md`"

On a feedback-only run all three are false: the recorded spec is gone from disk, so `specMount`
mounts nothing (`src/sandbox/spec.ts`, T7's ruling from the other side). The generated message
patches the assertion afterwards with `NO_SPEC_MOUNTED` — "there is nothing at /spec.md to read,
whatever the text above says about it."

**The patch has already been forgotten twice.** T17 round 1 stopped *generating* the spec line and
left the template's own standing; round 2 added `NO_SPEC_MOUNTED` to the implement arm
(`be2d6a294a`) and the review arm. The description arm went uncorrected until after the ticket
landed — and it was the easiest one to miss precisely because it is the only pass whose generated
message never mentions `/spec.md` at all, so nothing looked wrong at the call site.

That is the shape of the defect: a correction pattern has to be remembered at every site, and the
site where it is least visible is the site where it is needed.

Bash has the identical hole and is not the model here: `pr-prompt.md` asserts the mount, and the
feedback-only block corrects only the *feature*-mode case.

## The ruling

**Whether a spec is mounted is a dispatcher fact, not template prose.** It is the same principle
`image-build-command` settled from the other direction (T34): the package ships no host's fact. Here
the inversion is worse, because the templates assert a *run* condition that changes between two runs
on the same branch.

Facts about this run belong in the generated dispatcher's message, which knows them. Prose belongs in
the template. Today a run fact lives in the template and the message corrects it.

## What to build

The three package-default templates stop naming `/spec.md`, and the generated message names it on the
runs where it exists.

- On a spec run, the dispatcher's message states where the spec is mounted, in each pass's own
  register — the implement pass is told to read it, the review pass that it is the fidelity standard,
  the description pass that it is background for the overview.
- On a feedback-only run, nothing is said, because there is nothing to say. No assertion, no
  retraction.

**Decide and record: whether `NO_SPEC_MOUNTED` survives as a backstop.** The templates are the
client's to write (`PromptSource`), so an overridden template is still free to assert the mount and
nothing generated can stop it. Keeping the sentence covers that case; dropping it makes the
feedback-only prompt fully clean. The lean is **keep it**, reworded so it reads naturally after a
message that said nothing about a spec — it costs one line on a rare path and is the only thing
standing between a client's override and a pass sent after a file that is not there. Say which was
chosen and why, in the code.

**Record the divergence.** Bash keeps the assertion in its templates; this does not. That is a
deliberate divergence and belongs in SPEC §12 beside `branchNotCheckedOut`'s.

## Effect wiring

- **Tags introduced**: none.
- **Tags consumed**: none. Every function this touches is one of the pure assemblers in
  `src/agent/prompt.ts` (SPEC §8) — they take a template string and a `PassRun` and return a string.
- **Layer composition**: unchanged. `src/app.ts` is unchanged.

## Acceptance criteria

- [ ] No shipped template names `/spec.md`; the path appears only in generated dispatcher messages
- [ ] A spec run's implement, review, and description prompts each still say where the spec is, in
      that pass's own register — a reader cannot tell the sentence moved
- [ ] A feedback-only run's three prompts contain no assertion that a spec is mounted
- [ ] A client template that *does* assert the mount behaves as the recorded decision says — either
      corrected on the feedback-only arm, or documented as the client's own problem
- [ ] The divergence from bash is recorded in SPEC §12
- [ ] Every existing feedback-only prompt test still passes, or its expectation changes with a comment
      saying which sentence moved and why

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package.

The prompt assemblers are pure, so every criterion above is a unit assertion in
`test/agent-prompt.test.ts` against a literal `PassRun` — no container, no dispatch.

## Notes for P2

Feature mode adds a fourth fact of exactly this kind: bash's PR-description prompt tells a
multi-issue run to read `/feature-issues/*.md` instead of `/spec.md`, because the mount points at
whichever issue ran last. If the templates still asserted their mounts by then, that arrives as a
third correction sentence. Landing this first means P2 states the fact once, where it is known.
