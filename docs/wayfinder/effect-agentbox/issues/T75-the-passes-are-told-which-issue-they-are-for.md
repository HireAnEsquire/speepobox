# T75 — The passes are told which issue they are for

Status: Done (PR #35; `/feature-issues` is read-only but the same files stay writable at `/workspace/<folder>/issues`, because the mount source is inside the checkout — so §1's reason for read-only, that a writable mount is a second author of a file 14 gives one author, is not what the mount enforces, and the guarantee rests on T77's land-time write plus the prompts, recorded on T77 §2; and `describePr` threads `current` into `PromptAssembled` while its message deliberately names the whole set, so a caller handing it the issue in flight would log an issue the prompt never names — closed on T76 §1)
Type: AFK
Blocked by: [T73](T73-a-feature-dispatch-names-its-issues.md) — the `Feature` arm on the plan.

<!--
P2 (09 Q5). The pass-level half of feature mode, split from the loop (T76) on the map's slicing
rule — three things true at once — and because it has its own green: pure prompt assembly over a
`PassRun` that names an issue, and a mount spec. Nothing runs a feature loop after this ticket;
T76 is what calls what this builds.

bash re-points a `/spec.md` symlink at each issue with `docker exec -u root ln -sfn`
(`run.sh:1764`) and its three templates assert the mount. T37 retired the assertion — *whether a
spec is mounted is a dispatcher fact, not template prose* — so here each pass's generated message
names the issue file, and nothing runs as root in the container.
-->

## What to build

**`/feature-issues` is mounted read-only from inside the checkout, and the implement and review
messages of a feature run name the current issue's file under it in each pass's own register,
while the describe-PR message names the whole set.** No symlink, no root exec, no template that
asserts a path.

### 1. The mount (15 §"Which tree the agent reads")

`sandbox/spec.ts` gains `issuesMount(plan)`: on a `Feature` task, source
`<plan.checkoutPath>/<folder>/issues`, target `/feature-issues`, read-only; `None` on the other
arms. The source is inside the checkout — the clone of the tip the gate read (T73) — so gate and
agent read one tree. It is derivable from the plan alone, so the sandbox spec stays a pure
function of it. **Read-only**: the port writes status at land, in the served repo (T77), and the
mid-run stamp bash writes into its materialized copy (`run.sh:1866`) is dropped — nothing in a pass
reads a neighbour's status, and a mount the agent can write is a second author of the file 14
gives one author.

### 2. What a pass is told

`PassRun` gains `current: Option<CurrentIssue>` where `CurrentIssue = { issue: Issue; boundary:
string }` — the issue this pass is for, and the SHA the branch stood at when its implement pass
began (T76 reads it in the container). `None` on a spec or inline run. The three seam methods on
`AgentCli` take it beside the plan, so the layer that runs a pass reads a template and calls one
function, as today.

- **Implement**: template; the resuming sentence when resuming (identity-keyed, T66, unchanged);
  the backstop on a template naming `SPEC_TARGET` (T37, unchanged); branch and boundary; then
  *Your task is the issue file `/feature-issues/<file>`, mounted read-only — read it first*; then,
  **when `boundary !== mergeBaseSha`**, bash's build-on sentence (`run.sh:1772-1775`): *the branch
  already carries commits from earlier issues or runs of this feature — read them (`git log
  <mb>..HEAD`) and build on them; do not redo or undo them*. This sentence is keyed off the
  boundary, not the identity, because it is true from the second issue of a fresh run onward; the
  resuming sentence stays keyed off the identity (AGENTS.md). The feedback section, then the PR
  context section on a resume.
- **Review**: template; *Review the work on branch `<b>` for issue `<id>` (`<title>`) — every
  commit after `<boundary>`* (`run.sh:1806`); the round note; the standard is *the issue file
  `/feature-issues/<file>`* in the fidelity register; the backstop; the feedback section.
- **Describe-PR**: template; describe-the-work; *the branch carries a feature run over
  `<folder>`: issues `<ids in order>` — their files are under `/feature-issues`, background for
  the overview*; the backstop; the feedback section. The checklist itself is T79's, appended by the
  dispatcher below the answer, never asked of the agent.

The spec arm's and inline arm's messages are byte-unchanged.

### 3. The log

The prompt line the run log keeps verbatim (T14) says which issue the pass was for, beside the
root the template came from: `PromptAssembled` gains `issue: Option<string>`; the log renderer
prints `(issue T70)` after the pass name when present.

## Effect wiring

- **Tags introduced or consumed**: none introduced. `AgentCli`'s three methods gain a parameter;
  the fake in `test/support/agent-cli-fake.ts` records it; `dry-run/agent-cli.ts` passes it
  through to the same prompt functions.
- **Layer composition**: unchanged.

## Acceptance criteria

- [ ] `sandboxSpecFor` on a `Feature` plan carries exactly one task mount, `/feature-issues`
      read-only from under the plan's checkout path; on a `Spec` plan `/spec.md` as today; on
      `Inline` none. A shape pin keeps a `Feature` plan from producing a `/spec.md` mount.
- [ ] Implement message for a `CurrentIssue` whose boundary equals the merge-base carries the
      issue sentence and no build-on sentence; with a later boundary, both; on a resume, the
      resuming sentence too. Under a template naming `SPEC_TARGET`, the backstop fires on all three
      messages; under the shipped templates `/spec.md` appears nowhere in a feature run's prompts.
- [ ] Review message names the issue, its title, and the boundary; describe-PR names the folder and
      every id in order.
- [ ] Every existing prompt test in `test/agent-prompt.test.ts` passes byte for byte with
      `current: None`.
- [ ] `PromptAssembled` for a feature pass carries the id and the log line shows it.

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package.
