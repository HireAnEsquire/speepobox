# NN — <one-line title>

Status: needs-triage
Type: AFK
Blocked by:

<!--
Verify-prefilled issue template (ticket 06): nothing else forces an issue to name its verification
commands, and `pre-commit` run on this package passes while checking NOTHING — a false green.

The Verify section below is pre-filled and must not be deleted. Add package-specific checks under it;
never replace it.
-->

## What to build

<the change, in enough detail that an AFK agent needs no further input>

## Effect wiring

<!--
Required for any issue that adds or changes a service, per ticket 06: agents fail at layer WIRING more
than at layer authorship, so the spec pastes the wiring rather than describing it.
-->

- **Tags introduced or consumed**: <e.g. `Sandbox`, `Ledger`>
- **Layer composition**: paste the exact `Layer.provide` / `Layer.provideMerge` expression the
  entrypoint should end up with, for the agent to copy rather than derive. Take it verbatim from the
  composition root (`src/app.ts`). `layerinfo` is an editor-only language-service feature with **no
  CLI**, so an issue must never ask the agent to run it. Every acceptance criterion needs a command
  that runs *inside the container*; one only a host or an editor can satisfy belongs in Verify,
  marked host-only.

## Acceptance criteria

- [ ] <observable behavior, not implementation>

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and
warnings break the build**, suggestions print), lint, and tests. `pre-commit` is not a substitute and
does not check this package.
