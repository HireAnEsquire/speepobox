# T24 — The verdict is the last marker, not any marker

Status: Done
Type: AFK
Blocked by: T10

Sequence: [ticket 08](../08-in-hae-sequence.md). A correctness fix to code already on the branch,
found by T10's own review round on 2026-08-13 and recorded in that ticket's close-out, so it lands on
its own rather than waiting on a feature ticket — the same shape as [T20](T20-atomic-lock-claim.md),
[T21](T21-serialize-lock-eviction.md), and [T22](T22-sandbox-gone-from-the-daemon.md).

**Touches `src/agent/verdict.ts` and nothing T22 or T23 touches**, so it can run beside either.

**Tracer: a review round that quotes a verdict marker in its prose and ends on a different one is
read as the one it ended on.**

## What to build

One change to how `reviewVerdictIn` chooses, and the cases that pin it.

### 1. What is wrong, and the run that proved it

`src/agent/verdict.ts` reads the round's verdict like this:

```ts
export const reviewVerdictIn = (output: string): ReviewVerdict => {
  if (output.includes(APPROVED_MARKER)) {
    return "approved";
  }
  return output.includes(FIXED_MARKER) ? "fixed" : "needs-work";
};
```

Two properties combine badly. It scans the **whole** output, and it gives `approved` **precedence**
over everything else. So any occurrence of `<verdict>approved</verdict>` anywhere in the round's
output wins, including one the reviewer wrote about rather than meant.

T10's review recorded this as `Not-fixed` and ruled it bash parity (`grep -q` over the captured pass
output does the same). **It then fired in that ticket's own second round**, whose review body
contains, in an ordinary sentence describing the loop it was reviewing:

> rounds 1..`maxReviewRounds`, break on `<verdict>approved</verdict>`, `fixed` loops like
> `needs-work`…

That round did approve, so nothing broke. Had the same sentence appeared in a round ending
`<verdict>needs-work</verdict>`, the loop would have read approval, stopped early, and stamped the
ticket `Done` over unreviewed code. A reviewer describing a review loop is the reviewer most likely
to type the marker — and from here on, every dispatch in this sequence is a reviewer reading
bessemer.

### 2. The rule

**The verdict is the last marker in the output.** Scan for every `<verdict>…</verdict>` occurrence
and take the final one; the prompt already says the reviewer ends its final message with exactly one
tag, so the last one is the one it meant. Precedence between the three tokens disappears — there is
nothing left for it to decide.

An output with **no** marker is still `needs-work`, unchanged: that is the answer that keeps a human
in the loop, and it is what a pass that says nothing or argues with itself deserves.

An unrecognized token inside a well-formed tag — `<verdict>lgtm</verdict>` — is also `needs-work`,
and it does **not** fall through to an earlier valid marker. A reviewer that ended on a word we do
not know has not approved anything.

### 3. Deliberate divergence from bash, recorded

This is the first place the port knowingly does something bash does not, so say so where the next
reader will look. `run.sh`'s two `grep -q` calls have this bug; parity would keep it. The port
diverges because the failure is silent, asymmetric, and lands on the side that ships unreviewed work.
Put the reasoning in `AGENTS.md` beside the existing rulings, not only in a comment.

### 4. A shape that looks right and is not

**Do not fix this in the prompt.** Telling the reviewer "never write a verdict marker except at the
end" is a rule the reviewer must obey on every round forever, in the one situation where quoting the
marker is the natural thing to write. The parser is where a guarantee can live; the prompt is where a
request lives.

**Do not read only the final line.** The reviewer's tag ends its final *message*, and nothing
promises the marker sits alone on the last line — `execStreamed` collects lines and the tag may share
one with prose. Search the whole output, take the last match.

## Not in scope

The review loop, the prompt file, `outcomeFor`, and the `outcome` token vocabulary — all T10's and
all correct. `AgentCli.review` itself is untouched: this is the parsing function it calls.

## Read first

`src/agent/verdict.ts` and `test/review-verdict.test.ts` — small, and between them they are most of
this ticket. `src/dispatch/review.ts` for how the verdict is consumed (approval breaks the loop),
`AGENTS.md`, and **SPEC §7 (lines 305–367)**. `run.sh:1349-1372` is the behaviour source
this ticket deliberately departs from, read as a reference document and never executed.

**Already on the branch — do not rewrite** T1–T10's modules. **Do not touch hae files.**

## Effect wiring

- **Tags introduced**: none. **Tags consumed**: none — `reviewVerdictIn` is a pure function and
  stays one.
- **Layer composition**: unchanged. `AppLive` and `AppBaseLive` are byte-unchanged.
- **Errors**: none. There is no failure mode here; an unreadable verdict is `needs-work`, which is a
  value.

## Acceptance criteria

- [ ] `reviewVerdictIn` returns the **last** marker in the output, whichever of the three it is
- [ ] A round whose prose quotes `<verdict>approved</verdict>` and ends on `<verdict>needs-work</verdict>`
      reads as `needs-work` — the case from T10's own round 2, as a test
- [ ] The same case in the other direction: prose quoting `needs-work`, ending on `approved`, reads
      as `approved`
- [ ] No marker at all is `needs-work`; an unrecognized token inside a tag is `needs-work` and does
      not fall through to an earlier valid marker
- [ ] `AGENTS.md` records the divergence from bash and why (§3)
- [ ] `AppLive` and `AppBaseLive` are byte-unchanged; no tag is introduced

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, grep bans, and fake-tier tests. `pre-commit` is not a
substitute and does not check this package.

No host-only step: this ticket is a pure function and its cases, and the fake tier reaches all of it.
