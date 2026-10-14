# T64 — The write watch reads the command, not the sentence

Status: Done (PR #24; head-matching is narrower than the ticket priced, and in the expensive
direction. `briefFor` collapses `\s+` to one space before the event exists (`stream.ts:97`), so a
`git add -A` and a `git commit -m x` written on two lines arrive as one line whose only command head
is `git add` and read as a read — the newline cannot be a separator here because it is gone before
`isWrite` runs. The round disclosed the shape and left it, correctly; a comment on
`COMMAND_SEPARATORS` was added on review so the next reader finds it in the file rather than in a
merged PR body. The PR body also inverted `pass-watch.ts:33-36`, calling a spurious advisory the
cheaper mistake when the ruling says the silence is — the code comment gets it right, so nothing
shipped wrong, but the ticket's real argument is the one neither states: the over-match was not
random, it fired exactly at a pass narrating a write instead of doing one, which is the pass the
advisory exists for)
Type: AFK
Blocked by: none.

<!--
Two CodeRabbit findings on [T52](T52-a-long-pass-says-it-is-still-running.md)'s PR #13 that went
unaddressed into the merge, surfaced again 2026-09-18 by the status-line pass that read the PR back.
Neither is a design question — T52's ruling stands and this is what it costs to hold — so this is a
ticket rather than a map entry.

The advisory these two defects silence is the one 20 built the watch *for*: an implement pass that
has read for a third of its budget and written nothing. So the failure is not "a warning is
slightly wrong"; it is the feature declining to fire in a case it exists to catch.
-->

## What to build

**`isWrite` decides on the command a `Bash` line runs, not on the brief containing a listed
command's spelling somewhere in it, and the watch cannot observe a write's narration before the
flag that records it.**

### The substring match

`isWrite` (`src/agent/pass-watch.ts:51-54`) asks `line.brief.includes(command)` for each of the six
`WRITING_COMMANDS`. `brief` is the tool's `command` for a `Bash`, so a pass that narrates

```
echo "next I will git commit"
```

is counted as having written a file. It ran `echo`.

**This is not the over-matching the file already accepts.** The comment at
`pass-watch.ts:30-36` rules that over-matching is the cheaper of the two mistakes, and that ruling
holds — but it justifies the *membership of the list* ("each listed command writes unambiguously"),
which assumes the match identifies the command being run. A substring test extends the tolerance
along a second axis the comment never priced: a command that merely *mentions* a write. Leave that
comment in place and let it keep governing ties; this ticket narrows what counts as a match, not
what is on the list.

The case that makes it bite: an agent narrating what it is *about* to do is exactly the agent that
has not done it. The pass most likely to trip this is the pass the advisory is for.

Match each listed command as the **head of a command position**: split `brief` on `&&`, `||`, `;`
and `|`, trim each segment, and test the list against each segment's start. That keeps every real
write already caught — `cd sub && git commit -m x`, `foo | tee out.txt`, `sed -i …`, `cat > f`,
`git apply p.diff` — and drops the mention. A quoted separator inside an argument will split
wrongly; accept it. This is an advisory's input and not a security boundary, so a heuristic that
reads the common shapes right is the whole goal, and the existing comment's "over-matching is the
cheaper mistake" still decides anything genuinely ambiguous.

### The flag is set after the narration is emitted

`src/agent/agent-cli.ts:303-311` emits the narration event and *then* sets the `wrote` `Ref`:

```ts
reporter
  .emit(narrationEvent(pass, narrated))
  .pipe(Effect.zipRight(isWrite(narrated) ? Ref.set(wrote, true) : Effect.void))
```

The watch fiber reads `Ref.get(wrote)` on its own 30s tick (`agent-cli.ts:266`), so a tick landing
between the emit and the set reads `false` for a line that is a write. The window is one `emit` —
a log line and a console line — against a threshold measured in minutes, so this is narrow and its
consequence is one spurious advisory. Fix it because the ordering has no reason to be this way
round, not because it is likely.

Set the flag first, then emit. **Order the effects; do not add a lock or a semaphore** — there is
one writer and the flag is monotonic.

## Effect wiring

- **Tags introduced or consumed**: none.
- **Layer composition**: unchanged.

## Tests

- `test/pass-watch.test.ts`, on `isWrite` directly:
  - `echo "next I will git commit"` is **not** a write, and neither is `echo git commit later`.
  - `cd sub && git commit -m x` is, and so is `foo | tee out.txt` — a listed command that is not
    the first segment.
  - The existing cases stay: `sed -i s/a/b/ f`, `cat > f`, `git apply p.diff`, `patch -p1 < d`,
    and each of `Write` / `Edit` / `NotebookEdit` by tool name.
  - A `Bash` line whose brief is empty is not a write.
- The ordering half has **no fixture in the fake tier** — asserting it needs a watch tick scheduled
  inside a single `emit`, which is the race `pass-watch.ts:9-14` already records as a test whose
  green side never ran. Record it `Not-fixed:` in the review and confirm it by reading the pipe.

## Acceptance criteria

- [ ] A `Bash` narration whose brief mentions a listed command outside a command position does not
      count as a write; `echo "next I will git commit"` is the pinned case.
- [ ] A listed command in any command position of a compound line still counts, first segment or
      not.
- [ ] Every write shape T52 already caught still counts, and the tool-name half is untouched.
- [ ] `wrote` is set before its narration is emitted.
- [ ] `pass-watch.ts:30-36`'s over-matching ruling is still in the file and still true of the list.
- [ ] The suite passes.

## Verify

```
npm run verify
```

Run from the repo root. This is the gate: typecheck (with Effect diagnostics: **errors and warnings
break the build**; suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package.
