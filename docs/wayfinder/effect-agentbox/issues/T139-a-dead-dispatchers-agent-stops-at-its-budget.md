# T139 — A dead dispatcher's agent stops at its budget

Status: Done (PR #99. Every pass runs under `timeout -k 30 <pass-timeout + 60>`; `Effect.timeoutFail` is still the budget. `verify:live` and one real dispatch passed on the host after merge.)
Type: AFK
Blocked by:

<!--
From the hae install gate (09's comment of 2026-10-12). Run 5's dispatcher was killed with
`kill -9` and stopped logging at 13:54:23; its agent committed at 13:54:53. The pass budget is the
dispatcher's `Effect.timeoutFail` (T9), so when the dispatcher dies nothing caps the agent: it works
unsupervised, with the run's credential, until a later dispatch's reclaim removes the container.
Ruled 2026-10-14: a timeout inside the exec, as a backstop beside the dispatcher's own — not a
container lifetime, because a run's budget spans passes, rounds, and feature issues and is not one
number.
-->

## What to build

Every agent pass runs under an in-container `timeout`, set past the pass budget, so the agent CLI
stops even when no dispatcher is left to stop it.

- **The pass argv gains a prefix.** `agentPassCommand` in `src/agent/agent-cli.ts` becomes a
  function of the budget, and the pass runs:

  ```
  timeout -k 30 <passTimeoutSeconds + 60> claude --dangerously-skip-permissions -p …
  ```

  The rest of the argv is unchanged. `-k 30` follows the `TERM` with a `KILL` 30 seconds later for a
  CLI that ignores it. Name the 60 and the 30 as constants beside the argv, with a comment saying
  why each exists.

- **The dispatcher's timeout is still the budget.** `Effect.timeoutFail` over `Sandbox.exec` stays
  exactly as it is and still decides every live run's outcome. T9's reasons for it stand: it caps
  the daemon and the CLI as well as the agent. The grace of 60 seconds puts the backstop past it,
  so on a live run the dispatcher always fires first and the backstop is never what ended a pass.
  The backstop exists for the one case the dispatcher cannot cover: a dispatcher that is no
  longer there. It also stops the CLI when a live dispatcher's timeout kills only the `docker exec`
  client. Killing that client does not stop the process inside the container, which today keeps
  running until the run's scope removes the container.

- **No new failure classification.** Exit 124 from `timeout` reaches the dispatcher only if the
  backstop fired first, which the grace makes a defect of the arrangement rather than an outcome.
  It surfaces through the existing paths (a stream with no result) and needs no new
  `AgentPassReason`.

- **The image must provide `timeout`.** It is in coreutils (Debian, Ubuntu, the template's
  `debian:bookworm-slim`) and busybox (Alpine), so the template needs no change and
  `TEMPLATE_VERSIONS` does not move. Add one sentence to the README's bootstrap section, where
  `init`'s next steps name "your stack's base image": the image needs `git` and `timeout`, which
  the template's base already has. Do not add a `doctor` probe: no probe starts a container today,
  and this ticket does not make that change.

- **Amend the rule this changes.** AGENTS.md's bullet "The pass budget is the caller's timeout,
  not a `timeout` prefix inside the container" says the prefix is wrong; after this ticket the
  prefix exists as a backstop. Rewrite the bullet so it says both: the budget is the caller's
  timeout, and the in-container `timeout` set past it is the backstop for a dispatcher that died,
  never the budget. End it with `(T9, T139)`. Update the comment beside `Effect.timeoutFail` in
  `agent-cli.ts`, which contrasts the port with bash's in-container `timeout`, and SPEC wherever it
  describes the pass's argv or budget.

## Effect wiring

- **Tags introduced or consumed**: none introduced. `AgentCli` already reads `BessemerConfig`'s
  `passTimeoutSeconds`; the argv now takes it too.
- **Layer composition**: unchanged.

## Acceptance criteria

- [ ] Every pass's `docker exec` argv starts with `timeout -k 30 <passTimeoutSeconds + 60>`
      followed by the existing `claude …` argv, for implement, review, and the description pass.
- [ ] With `pass-timeout` set to a non-default value, the prefix carries that value plus 60.
- [ ] A pass that exceeds its budget still fails as `timedOut` from `Effect.timeoutFail`, exactly
      as before.
- [ ] A dry run's recorded pass command carries the prefix (`test/dry-run.test.ts`).
- [ ] AGENTS.md's pass-budget bullet, the `agent-cli.ts` comment, SPEC, and the README sentence are
      updated as above.

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package.

Host-only, after merge: `npm run verify:live` against a real dockerd, and one real dispatch that completes normally: the
prefix did not break a pass. The run log does not print the pass argv; the unit tests pin it.
