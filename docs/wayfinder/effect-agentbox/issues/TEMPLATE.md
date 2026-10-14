# NN — <one-line title>

Status: needs-triage
Type: AFK
Blocked by:

<!--
Template for issues in the bessemer package. Required by ticket 06, which found that nothing
otherwise forces an issue to name its verification commands — and that `pre-commit` run on the package
directory passes while checking NOTHING, which hands the agent a false green.

The Verify section below is pre-filled and must not be deleted. Add package-specific checks under it;
never replace it.

**The three headers above each fit on one line.** The regex that reads them is per-line (tasklib's
`_HEADER_RE`, and T68's `HEADER`), so a `Blocked by:` wrapped onto a second line keeps only what is
on the first and the rest is body — silently. T73 lost its T71 edge that way on 2026-09-21. Put the
prose under the header, not inside it.
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
  entrypoint should end up with, for the agent to copy rather than derive. Author it here by hand or
  from `layerinfo` in an editor — `layerinfo` has **no CLI**, so an issue must never ask the agent to
  run it. Every acceptance criterion needs a command that runs *inside the container*; a criterion
  that only a host or an editor can satisfy belongs in Verify, marked host-only.

## Acceptance criteria

- [ ] <observable behavior, not implementation>

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package.
