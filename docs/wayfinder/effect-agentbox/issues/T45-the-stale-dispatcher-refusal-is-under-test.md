# T45 — The stale-dispatcher refusal is under test

Status: Done (PR #4; the detached-HEAD reading was added by hand afterwards in ceac49d)
Type: AFK
Blocked by: [T44](T44-a-dispatch-runs-a-dispatcher-no-older-than-its-base.md)'s implementation, which
is on `main`. See **What is already on `main`** below.

<!--
The tail of T44. Its second dispatch was killed at the pass timeout having committed the whole of the
implementation, green, four seconds earlier — so the wiring landed and the tests of the behaviour it
wires never started. This ticket is those tests, and nothing else.

Deliberately small. It is the first ticket dispatched under the raised pass timeout (1800s, up from
900 on 2026-09-08), so it doubles as a cheap read on whether the new budget leaves headroom on a
ticket that plainly should have some. If this one also finishes at the buzzer, the budget is not the
variable.

**Dispatching this ticket is the stacking hazard T44 exists to catch, and T44 is now on `main` to
catch it.** That is the point: this is the first dispatch the guard itself can refuse. Run it from a
`main` that is level with `origin/main` and the guard passes silently; run it from behind and it
should refuse. Either outcome is information — if the guard fires wrongly, that is a defect this
ticket wants to hear about before it writes a line.
-->

## What is already on `main`

T44's implementation, one commit, green under `npm run verify`. **Do not rebuild or redesign it; the
work below tests it.**

- **`StaleDispatcher`** (`src/dispatch/preflight.ts`) — a `Data.TaggedError` carrying `detail`, the
  line the entrypoint renders. `preflight` now takes `base` and `allowStaleDispatcher`, asks
  `Git.dispatcherFreshness` first — before `dockerProbe` — and switches on the verdict: `Current`
  passes silently, `BaseUnresolvable` warns through the `Reporter` and proceeds, `Stale` refuses
  unless the override is set, in which case it warns and proceeds. A `GitError` from the call is
  degraded to `BaseUnresolvable` rather than escaping.
- **`--allow-stale-dispatcher`** (`src/dispatch/command.ts`), reaching `DispatchRequest` and passed
  to both `preflight` and `runInScope`'s existing trailing parameter, so the override lands on the
  row as `staleDispatcherOverridden`.
- **The rendered refusal** (`src/dispatch/render.ts`) — `StaleDispatcher` joins the failure union and
  falls to the default arm, which prints its `detail` unprefixed.

**What the same commit did not do** is test any of it. No test names `StaleDispatcher`,
`--allow-stale-dispatcher`, or the refusal; what it added to `dispatch.test.ts` and `dry-run.test.ts`
is the happy-path `rev-list` script entries that keep the existing suites passing, plus the two argv
assertions. Of T44's nine acceptance criteria, three hold today — the ancestry ones through T42's
real-repo tests of the shared question, and the no-network one through the argv equality that a
`fetch` would break. **The other five have no test.** They are the acceptance criteria below.

## What to build

**Tests that fail if the refusal stops refusing.**

No production behaviour changes. If a test cannot be written without changing `src/`, that is a
finding — say so in your final message rather than reshaping the implementation to suit the test.

### Where the refusal is already reachable

`preflight` is exercised through the **scripted `CommandExecutor`**, not through the `Git` fake:
`dispatch.test.ts` asserts the exact rendered git argv, `rev-list HEAD..origin/master -- <pathspec>`
among it, which is the real `Git` layer running over scripted results. So the behaviour tests belong
there, beside the other preflight and guard cases, and a `Stale` verdict is scripted by giving that
`rev-list` a nonzero-length stdout — the same way `BaseUnresolvable` is scripted by giving it a
nonzero exit.

`happyScript` matches that command **by prefix, ahead of the pathspec**, because `packagePathspec`
renders relative to each test's own scratch repo root. Override it per-case rather than editing the
shared script, so the ordinary runs stay ordinary.

### The fake still dies where the refusal reads

`test/support/git-fake.ts` answers `dispatcherFreshness` with
`Effect.die("this fake Git answers no dispatcher-freshness questions")` — a placeholder from T44's
expand step, left in because nothing reached it. Make it answerable the way `branchContains` is,
through a field on `FakeGitOptions` rather than a second fake.

**`worktrees` on the same fake dies too**, and the refusal path reads it: `currentBranch` calls
`git.worktrees(repoRoot)` to name the branch in the message. It guards that call with
`Effect.orElseSucceed(() => [])`, **which recovers the error channel and not a defect**, so a die
propagates straight through. Make `worktrees` answerable as well, and cover the detached-HEAD reading
— the message says "a detached HEAD" when the current worktree has no branch, and that is a real
string a real operator will see.

### The refusal's message is the deliverable, so assert it

The refusal exists to tell a dispatcher what went wrong and what to do. A test that asserts only the
tag would pass on an empty string. Assert that the rendered line carries a missing commit, the branch
the dispatcher is on, and the command that fixes it — and that the override sentence names the flag.

Assert too that **nothing was mutated**: the refusal instructs and does not repair, so no checkout,
no branch creation, no config write appears in the recorded commands.

### It refuses before docker

T44 put the check first for a reason. Assert it the way it can actually regress — that a refused
dispatch records **no docker command at all**, so moving the check below `dockerProbe` fails the test
rather than merely reordering the output.

## Effect wiring

Unchanged. No tag introduced, no layer moved, no signature changed. This ticket adds test files and
options fields on an existing fake.

## Acceptance criteria

- [ ] A dispatch whose `HEAD` is missing a package commit its base already has is refused, and the
      refused run contacts docker not at all.
- [ ] The refusal's rendered line names a missing commit, the branch the dispatcher is on, and the
      command that fixes it, and the run mutates nothing — no clone, no branch, no config write.
- [ ] A base the clone cannot resolve warns and proceeds to the rest of the preflight; it does not
      refuse.
- [ ] `--allow-stale-dispatcher` proceeds past a `Stale` verdict with a warning, and the row that run
      writes carries `staleDispatcherOverridden`.
- [ ] A run that never overrides the check writes a row with no `staleDispatcherOverridden` key, end
      to end through a dispatch rather than only at the schema.
- [ ] `dispatcherFreshness` and `worktrees` on the `Git` fake answer from options rather than dying,
      including a detached-HEAD worktree reading.
- [ ] The suite still passes with no change to anything under `src/`.

## Also, while you are here

One comment nit from T44's commit: `render.ts`'s list of failures that carry their own message
**replaced** its `ForgeError` example with `StaleDispatcher` instead of joining them, so `ForgeError`
is no longer named there. Restore it alongside. Comment only.

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package.

Land a green piece before you start an interlocking one: the fake's two options fields, with one test
each, go green on their own and are the natural first commit.
