# 11 — Lint/format toolchain for the TS package

Labels: `wayfinder:research`
Map: [MAP.md](MAP.md)
Blocked by: —
Assignee: claude (claimed 2026-08-06)
Status: closed (2026-08-06) · findings in [research/11-lint-format-findings.md](research/11-lint-format-findings.md)

## Question

Graduated from ticket [04](04-incubation-mechanics.md), which settled every other part of the
package's toolchain (npm, node 26, vitest + `@effect/vitest`) but could not settle lint/format
without current facts.

The deciding consideration is **not** style. Effect's characteristic bug is a **floating
Effect** — an `Effect` value constructed and never yielded, which type-checks and silently does
nothing. It is the direct analogue of `no-floating-promises`, a *type-aware* rule. Ticket 06
names agent-authored Effect as this plan's top cost; a lint rule that catches the exact failure
mode agents emit is a de-risking lever, not a preference.

User's prior: leaning **oxlint + oxfmt** (matches hae's client), believed to have shipped
Effect-related rules recently.

Settle, from primary sources:

1. **Does oxlint ship Effect-specific rules?** Which rules, which version, what stability tier.
2. **Does oxlint do type-aware linting** (the `tsgolint` integration)? Status, stability, which
   type-aware rules are available, and whether `no-floating-promises` is among them.
3. **Does a floating-Effect rule exist anywhere** — `@effect/eslint-plugin`, a community eslint
   plugin, Effect's own tooling, or an oxlint rule? If more than one, how they compare.
4. **What does the Effect repo itself use** for lint and format today?
5. **oxfmt maturity** for a standalone package, and whether oxlint/oxfmt can be configured for a
   top-level dir independently of hae's `client/` config (hae's hooks are scoped `^client/` and
   the new dir is excluded from pre-commit entirely — ticket 04 Q4 — so the package's config must
   stand alone).
6. **v3/v4 sensitivity**: if any Effect lint rules exist, are they written against Effect v3, the
   v4 beta, or both? Feeds ticket 06's open v3/v4 boundary question.

Findings land in `research/11-lint-format-findings.md`, per this effort's convention.

## Progress

First research run was killed by a network interruption before recording conclusions. Verified
empirically and preserved: **Q1 yes** (`oxlint-plugin-effect@0.6.0`, 13 rules), **Q2 yes**
(type-aware via `oxlint-tsgolint` works), **Q3 no for oxlint** — no rule detects a floating
Effect, confirmed by negative result on a fixture where the plugin was demonstrably active.

Still open, all needing network: Q3's eslint half, Q4, Q5, Q6.

**The deciding consideration has shifted.** This ticket was framed on the premise that a
type-aware floating-Effect rule would select the linter on correctness grounds. No such rule
exists in oxlint. Unless the eslint half turns one up, the choice reverts to ordinary criteria
and this ticket becomes much lower-stakes — possibly a T1 implementation detail rather than a
decision the map has to carry.

## Update from ticket 06 (2026-08-06)

**The correctness premise is settled elsewhere — this ticket is now style/format only.**

06 found that `@effect/tsgo` (0.33.0) both ships a `floatingEffect` rule and "ships a way to emit
additional **Oxlint Type Aware rules**" — so Q3's negative result was against
`oxlint-plugin-effect`, not against every route to a floating-Effect rule. But 06 **declined the
oxlint bridge**: the Effect diagnostics already ride the single `tsc` typecheck in `verify`
(errors + warnings break, suggestions print), and a second path to the same findings means
typechecking twice and two rule configs to drift.

So the floating-Effect gap is closed by tsc-mode diagnostics, and this ticket reverts to ordinary
criteria — exactly as its own Progress section suspected. Remaining live questions: **Q4** (what
the Effect repo uses), **Q5** (oxfmt maturity, standalone config for a top-level dir independent
of hae's `^client/`-scoped hooks). **Q6 is dead** — 06 pinned `effect@3.22.1` exact. **Q3's eslint
half is moot.** Plausibly now a T1 implementation detail rather than a decision the map carries.

## Answer

Resolved 2026-08-06. Round-2 research closed Q4 and Q5; Q1/Q2/Q3 were already settled, Q6 died with
06's exact pin.

**The toolchain is `oxlint` + `oxfmt`, both pinned exact, `typeAware` off, two standalone configs in
the package dir.** It goes into T1's `package.json` and `npm run verify`.

### Why this stopped being a map-level decision

The ticket was framed on a correctness premise: a type-aware floating-Effect rule would pick the
linter. That premise is gone. 06 closed the floating-Effect gap inside the single `tsc` typecheck via
`@effect/tsgo`'s `floatingEffect` diagnostic, and **declined the oxlint bridge** — one typecheck, one
config. So lint reverts to ordinary style criteria. Recorded as a decision anyway because it removes
the last blocker on ticket 08 and fixes two stale premises (below).

### Q4 — Effect's own repo: `oxlint` + `dprint`

`Effect-TS/effect@main`: `"lint": "oxlint -f unix && dprint check"`. devDeps `oxlint ^1.76.0`,
`dprint ^0.55.2`, `@effect/tsgo ^0.21.0`, `typescript ^7.0.2`, `vitest ^4.1.10`. Exactly two config
files at root — `.oxlintrc.json` and `dprint.json`; no eslint, prettier, biome, or oxfmt config
anywhere.

Three findings that carry weight beyond the tool choice:

- **`@effect/tsgo` sits in the *typecheck* path, not the lint path.** `prepare` runs
  `effect-tsgo patch`; `check` is `tsc -b`; lint/types/test are separate CI jobs. Effect's own repo is
  the existence proof for 06's arrangement — the bridge is declined upstream too.
- **Effect does not enable `typeAware`.**
- Their oxlint config loads an Effect JS plugin, but it is their in-repo **`@effect/oxc`**
  (`"private": true`, v0.0.0, **not published** — registry returns Not found), not the
  `oxlint-plugin-effect@0.6.0` this ticket tested in round 1. Its five rules are monorepo hygiene
  (`no-import-from-barrel-package`, `no-unused-internal`, …) — nothing correctness-bearing. So round
  1's negative result stands and there is no unpublished escape hatch.
- **`@effect/eslint-plugin` is dead** — 0.3.2, last published 2025-04-24.

The surprise is **dprint, not oxfmt**, encoding Effect house style (`semiColons: "asi"`,
`trailingCommas: "never"`, width 120). Motive UNVERIFIED — reads as preference and inertia predating
oxfmt, not a rejection of it.

### Q5a — oxfmt maturity: usable, but 0.x

`oxfmt@0.62.0` (2026-08-03), shipped alongside oxlint 1.77.0. First publish 2025-09-10; weekly minors
0.57 → 0.62 over six weeks. **Still formally beta**: the last stability post is *Oxfmt Beta*
(2026-02-24) and there is no 1.0/stable post; oxc's versioning policy page covers **oxlint only**.
Current docs carry no beta banner, call it "the recommended choice", claim 100% pass on Prettier's
JS/TS conformance suite, and name vuejs/core, turborepo, sentry-javascript as adopters.

Documented gaps: no Prettier plugins (built-in replacements for the common four; `sortPackageJson` on
by default), no `prettier` field in `package.json`, no nested `.editorconfig` merging, no
`experimentalTernaries`/`experimentalOperatorPosition`, default `printWidth` 100. **None apply to a
plain Node/TS library.** The live risk is 0.x churn, not capability — hence the exact pin.

### Q5b — standalone config is free, and this ticket's premise was wrong twice

Both tools resolve config **per file, nearest-wins, never merged into parents**; `extends` is opt-in;
`-c` / `--disable-nested-config` pin it. oxfmt `ignorePatterns` are rooted at the config's directory
and `..` is a hard error. One constraint: oxlint's `options.typeAware` / `typeCheck` are
root-config-only — irrelevant, since we are leaving them off.

- **Correction 1 (this ticket, Q5).** hae's configs are **not at the repo root** — they are
  `client/.oxlintrc.json` and `client/.oxfmtrc.json`. Nothing sits above a sibling top-level dir to
  inherit from, so *no isolation mechanism is needed at all*. Pre-commit hooks confirmed scoped
  (`files: ^client/…`, and `entry` does `cd client` anyway).
- **Correction 2 (ticket 04 Q4, carried into 08).** "The new dir is excluded from pre-commit entirely"
  is a **planned edit not yet made**. The top-level `exclude:` does not name the package dir, so
  hae's generic hooks still reach into it. Note this is the reverse of 07's finding, where 04's
  rename touch-points collapsed to nothing: this one is a real outstanding edit. **It belongs in
  T1**, alongside 04's other cross-package edit.

### The decision, and what was rejected

**`oxlint` + `oxfmt`.** Matches the user's stated prior and hae's client, so one mental model across
the repo; Effect itself runs oxlint on the same TS7 + vitest 4 stack, so rule selections are directly
copyable; two ~15-line configs, provably independent of `client/`.

Two rulings that ride along:

- **Pin `oxfmt` exact**, not `^` — 0.x, weekly minors, no semver contract, and a formatter minor
  rewrites every file in the diff. Consistent with 06's `effect@3.22.1` exact.
- **Leave `typeAware` off.** Effect doesn't enable it; 06 declined the bridge; and type-aware rules
  sit explicitly outside oxc's semver policy.

Runner-up: **dprint + oxlint** — Effect's exact combination, worth taking only if matching Effect's
*code shape* beats matching hae's client. It doesn't here: the package is read and written mostly by
agents and by this repo's dev, and 06 already put Effect-idiom guidance in `AGENTS.md` rather than in
a formatter. Effect's house style is approximable in oxfmt anyway (`semi: false`,
`trailingComma: "none"`, `printWidth: 120`) if that ever matters.

Rejected: **eslint + prettier** (plugin graph to maintain, and the Effect eslint plugin is abandoned),
**biome** (a third toolchain for zero gain over oxc).
