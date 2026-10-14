# Research findings: lint/format toolchain for the TS package — PARTIAL

Ticket: [11-lint-format-toolchain.md](../11-lint-format-toolchain.md) · Researched: 2026-08-05

> **STATUS: PARTIAL — ticket 11 is NOT resolved.** The research subagent was killed by a network
> interruption before it recorded conclusions. What follows is only the part that could be
> verified **empirically and locally**, re-run and confirmed by the main session from the harness
> the subagent left behind. Questions 4, 5, and 6 are untouched, and question 3 is only half
> answered. Do not treat this as the ticket's answer.

Method: empirical. Packages installed from npm into a scratch project; oxlint run against a
purpose-built fixture. No primary-source doc reading survived the interruption, so **nothing here
rests on documentation** — only on observed tool behavior at the versions named.

Versions under test:

| Package               | Version          |
| --------------------- | ---------------- |
| `oxlint`              | 1.77.0           |
| `oxlint-plugin-effect`| 0.6.0            |
| `oxlint-tsgolint`     | 7.0.2001         |
| `effect`              | 4.0.0-beta.103   |
| `typescript`          | 7.0.2            |

## Q1 — Does oxlint ship Effect-specific rules? YES, via a plugin

`oxlint-plugin-effect@0.6.0` exists on npm and loads as a JS plugin
(`"jsPlugins": ["oxlint-plugin-effect/plugin"]`). It ships exactly **13 rules**, enumerated from
`node_modules/oxlint-plugin-effect/dist/rules/`:

`no-as`, `no-async-function`, `no-dynamic-imports`, `no-effect-bind`, `no-effect-do`,
`no-globals`, `no-new-error`, `no-new-promise`, `no-node-builtin-import`, `no-ternary`,
`no-test-lifecycle-hooks`, `no-throw-statement`, `no-try-catch`.

Characterization: this is a **style and discipline** rule set — it pushes code toward Effect
idiom and away from native control flow. It is not a correctness analyzer.

## Q2 — Does oxlint do type-aware linting? YES

`oxlint --type-aware`, backed by `oxlint-tsgolint`, works. `typescript/no-floating-promises`
fired correctly in the fixture below. The type-aware machinery is present and functional.

## Q3 — Is there a floating-Effect rule? NOT IN OXLINT (eslint side unverified)

This was the ticket's deciding question. **Answer for oxlint: no.**

Fixture (`src/floating.ts`), containing three genuine floating Effects plus two Promise controls:

```ts
import { Console, Effect } from "effect"

// (1) FLOATING EFFECT inside a generator: constructed, never yielded.
export const program = Effect.gen(function*() {
  Console.log("I never run")
  yield* Console.log("I do run")
})

// (2) FLOATING EFFECT at statement position outside a generator.
Effect.succeed(42)

// (3) FLOATING EFFECT: a pipe chain discarded.
Effect.succeed(1).pipe(Effect.map((n) => n + 1))

// (4) plain FLOATING PROMISE, for no-floating-promises calibration.
async function makePromise(): Promise<number> { return 1 }
makePromise()

// (5) the Effect is run but the resulting Promise floats.
Effect.runPromise(program)
```

Result of `oxlint --type-aware src/floating.ts`, with all 13 effect rules and
`typescript/no-floating-promises` set to `error`:

```
src/floating.ts:16:1: error effect(noAsyncFunction): Avoid async functions. ...
src/floating.ts:19:1: error typescript(no-floating-promises): Promises must be awaited ...
src/floating.ts:22:1: error typescript(no-floating-promises): Promises must be awaited ...
```

Reading of that output:

- Cases **(1), (2), (3) — the actual floating Effects — produced no diagnostic at all.**
- Cases (4) and (5), both genuine floating *Promises*, were caught by the type-aware rule.
- The plugin was **demonstrably active** — `noAsyncFunction` fired on line 16 of the same file.
  The silence on (1)–(3) is therefore a real negative result, not a loading or config failure.

**Consequence for the ticket.** Ticket 11's stated deciding consideration was that a type-aware
rule catching floating Effects would be a de-risking lever for ticket 06 (agent-authored Effect),
not a style preference. **No such rule exists in oxlint at these versions.** The argument that
would have selected a linter on correctness grounds currently selects nothing, and the choice
falls back to ordinary criteria (speed, config independence, formatter quality) — unless the
unverified eslint half of this question turns up an implementation.

## Q4, Q5, Q6 — NOT INVESTIGATED

Lost with the subagent; all require network access:

- **Q4** What the Effect repo itself uses for lint and format today.
- **Q5** oxfmt maturity for a standalone package, and whether oxlint/oxfmt can be configured for
  a top-level dir independently of hae's `client/` config.
- **Q6** Whether any Effect lint rules are written against v3, the v4 beta, or both. Note the
  fixture above ran against **v4 beta only**; a v3 scratch project (`effect@3.22.1`, with
  `oxfmt@0.62.0`) was also installed by the subagent but no v3 result was recorded.

Also unanswered on the eslint side of Q3: whether `@effect/eslint-plugin` or any community eslint
plugin implements a floating-Effect rule. Until that is checked, Q3's answer is "not in oxlint,"
not "does not exist."

## Recommendation

**None yet — do not close ticket 11 on this document.** The one firm input for a decision is the
negative result in Q3: correctness-based rule selection has no oxlint implementation to point at.
Re-run the research with network to settle Q3's eslint half and Q4–Q6 before choosing.

---

## Round 2 (2026-08-06) — Q4, Q5

Researched 2026-08-06, with network, from primary sources only (GitHub raw/API, oxc.rs docs and
blog, npm registry) plus direct reads of hae's own config files. Q1/Q2/Q3/Q6 are settled elsewhere
(ticket Progress + the "Update from ticket 06" section) and are not revisited. Scope here is
style/format only.

### Versions this round is verified against

| Thing | Version | Date | Source |
| --- | --- | --- | --- |
| `Effect-TS/effect` `main` | HEAD | read 2026-08-06 | [raw package.json](https://raw.githubusercontent.com/Effect-TS/effect/main/package.json) |
| `oxlint` (Effect's pin) | `^1.76.0` | — | same |
| `dprint` (Effect's pin) | `^0.55.2` | — | same |
| `oxlint` (latest) | **1.77.0** | 2026-08-03 | [oxc release `apps_v1.77.0`](https://github.com/oxc-project/oxc/releases) |
| `oxfmt` (latest) | **0.62.0** | 2026-08-03 | [registry dist-tags](https://registry.npmjs.org/-/package/oxfmt/dist-tags) |
| `@effect/tsgo` (latest) | **0.33.0** | — | [dist-tags](https://registry.npmjs.org/-/package/@effect/tsgo/dist-tags) |
| `@effect/eslint-plugin` (latest) | **0.3.2** | published **2025-04-24** | [registry](https://registry.npmjs.org/@effect/eslint-plugin) |

---

## Q4 — What the Effect repo itself uses: **oxlint + dprint. No ESLint. No Prettier. No oxfmt.**

### The scripts

From [`package.json` on `main`](https://raw.githubusercontent.com/Effect-TS/effect/main/package.json):

```json
"prepare":  "node scripts/setup-agents.mjs && effect-tsgo patch",
"check":    "tsc -b tsconfig.json",
"lint":     "oxlint -f unix && dprint check",
"lint-fix": "oxlint --fix && dprint fmt",
"test":     "vitest"
```

Relevant devDependencies, verbatim: `"oxlint": "^1.76.0"`, `"dprint": "^0.55.2"`,
`"@effect/tsgo": "^0.21.0"`, `"typescript": "^7.0.2"`, `"vitest": "^4.1.10"`,
`"@effect/oxc": "workspace:^"`. Package manager is `pnpm@10.17.1`.

**Negative results, checked explicitly.** The root directory listing
([contents API, ref=main](https://api.github.com/repos/Effect-TS/effect/contents?ref=main))
contains exactly two lint/format config files: `.oxlintrc.json` and `dprint.json`. There is **no**
`eslint.config.*`, no `.eslintrc*`, no `.prettierrc*`, no `.oxfmtrc.json`, no `biome.json`. No
eslint or prettier package appears anywhere in root devDependencies.

### The oxlint config, and what it says about "Effect rules"

Root [`.oxlintrc.json`](https://raw.githubusercontent.com/Effect-TS/effect/main/.oxlintrc.json) is
a thin wrapper:

```json
{
  "extends": ["./packages/tools/oxc/oxlintrc.json"],
  "jsPlugins": ["@effect/oxc/oxlint"],
  "ignorePatterns": [ … ],
  "overrides": [{ "files": ["**/{test,typetest,examples,…}/**"], "rules": { … "off" } }]
}
```

So Effect **does** use an Effect-specific oxlint JS plugin — but **not `oxlint-plugin-effect`**
(the third-party package Q1 tested). It is their own in-repo package
[`packages/tools/oxc`](https://raw.githubusercontent.com/Effect-TS/effect/main/packages/tools/oxc/package.json),
named `@effect/oxc`, described as *"Opinionated linting and formatting configuration for Effect"*,
depending on `@oxlint/plugins@^1.76.0`.

**`@effect/oxc` is `"private": true`, `"version": "0.0.0"`, and is NOT published** —
`https://registry.npmjs.org/@effect/oxc` returns `{"error":"Not found"}`. It is internal tooling
for the monorepo; you cannot install it.

Its five custom rules ([shared oxlintrc](https://raw.githubusercontent.com/Effect-TS/effect/main/packages/tools/oxc/oxlintrc.json))
are all *monorepo-hygiene* rules, not user-code correctness rules:
`effect/no-bigint-literals`, `effect/no-import-from-barrel-package`, `effect/no-js-extension-imports`,
`effect/no-opaque-instance-fields`, `effect/no-unused-internal`. Nothing resembling a
floating-Effect check — consistent with ticket 06's finding that floating-Effect lives in
`@effect/tsgo`'s diagnostics, not in a lint rule.

The rest of that config is ordinary oxlint: `plugins: ["typescript","import","oxc","eslint","unicorn","node"]`,
`categories: { correctness: "error", suspicious: "error", perf: "error" }`, plus rule tuning.
**Type-aware linting is not enabled** — no `"options": { "typeAware": true }` anywhere in either
config file. (hae's `client/.oxlintrc.json` *does* set it; Effect does not.)

### `@effect/tsgo` is in the typecheck path, not the lint path

`lint` is `oxlint && dprint check` — no tsgo. tsgo enters via `prepare: … effect-tsgo patch`,
which patches the TypeScript install so `check` (`tsc -b`) emits the Effect diagnostics. This is
**exactly the arrangement ticket 06 chose**: Effect diagnostics ride the single typecheck; the
linter is a separate, ordinary style/hygiene tool. Effect's own repo is the existence proof for
06's decision to decline the oxlint bridge.

### CI

[`.github/workflows/check.yml`](https://raw.githubusercontent.com/Effect-TS/effect/main/.github/workflows/check.yml)
runs one `lint` job (`pnpm lint` — oxlint + dprint check) and a separate `types` job
(`pnpm check` then `pnpm test-types`), plus `build`, `test`, `doctest`, `circular`, `bundle`. Lint,
types, and tests are three independent jobs, not one `verify`.

### `@effect/eslint-plugin`: effectively abandoned

`@effect/eslint-plugin@0.3.2`, last published **2025-04-24** — nine versions total, nothing in
~16 months. The Effect repo does not consume it. Treat it as dead for planning purposes.

### Q4 verdict

Effect ships **oxlint 1.76+ for lint and dprint 0.55 for format**, on TypeScript 7 / vitest 4 /
pnpm, with Effect-specific diagnostics arriving through a tsgo-patched `tsc` rather than the
linter. The formatter choice (**dprint, not oxfmt, not prettier**) is the one genuine surprise, and
dprint's config gives away why: `semiColons: "asi"`, `trailingCommas: "never"`, `lineWidth: 120`,
`operatorPosition: "maintain"` ([dprint.json](https://raw.githubusercontent.com/Effect-TS/effect/main/dprint.json)).
That is the distinctive semicolon-less, comma-less Effect house style, and it long predates oxfmt.
This looks like an established style preference plus inertia, **not** a considered rejection of
oxfmt — they were already on oxlint, so an oxfmt migration was available and not taken, but no
public statement explains the choice. Marked **UNVERIFIED** as to motive; the fact is solid.

---

## Q5(a) — oxfmt maturity

**Current: `oxfmt@0.62.0`, published 2026-08-03**
([dist-tags](https://registry.npmjs.org/-/package/oxfmt/dist-tags)), shipped in lockstep with
oxlint in the oxc release [`apps_v1.77.0` — "oxlint v1.77.0 & oxfmt v0.62.0"](https://github.com/oxc-project/oxc/releases).
Cadence is roughly weekly: 0.57.0 (2026-06-29), 0.58.0 (07-06), 0.59.0 (07-14), 0.60.0 (07-21),
0.61.0 (07-27), 0.62.0 (08-03). First npm publish was `0.0.0` on **2025-09-10** — the project is
about eleven months old.

**Stability label: beta, un-superseded — but the docs no longer treat it as provisional.**

- The oxc blog's complete post list (extracted from the site's route hash map) is: … `2025-12-01-oxfmt-alpha`,
  `2026-02-24-oxfmt-beta`, `2026-03-11-oxlint-js-plugins-alpha`, `2026-07-22-type-aware-linting-stable`.
  **There is no oxfmt-stable / oxfmt-1.0 post.** The most recent stability announcement for oxfmt
  is [Oxfmt Beta, 2026-02-24](https://oxc.rs/blog/2026-02-24-oxfmt-beta).
- The version number agrees: still `0.x`. oxc's
  [versioning policy page](https://oxc.rs/docs/guide/usage/linter/versioning.md) is written for
  **oxlint only**; oxfmt has no published semver promise. (By contrast oxlint hit 1.0 stable on
  2025-06-10, and type-aware linting went stable 2026-07-22.)
- But the current [Oxfmt overview](https://oxc.rs/docs/guide/usage/formatter) carries no beta
  banner and states flatly: *"Oxfmt is the recommended choice when you want a dedicated formatter
  with a Prettier-compatible workflow"*, and *"Stay on Prettier only if you still depend on exact
  plugin behavior not yet covered by Oxfmt."*

**Prettier parity.** Both the beta post and the current docs claim *"Oxfmt now passes 100% of
Prettier's JavaScript and TypeScript conformance tests… any formatting differences are considered
bugs."* Named production adopters in the beta post: `vuejs/core`, `vercel/turborepo`,
`getsentry/sentry-javascript`, `huggingface/huggingface.js`, `openclaw/openclaw`. Claimed ~30×
Prettier / 2–3× Biome throughput (their benchmark, not independently checked — **UNVERIFIED**).

**Known gaps**, from the official
[Unsupported features](https://oxc.rs/docs/guide/usage/formatter/unsupported-features.md) page
(tracked in [milestone 19](https://github.com/oxc-project/oxc/milestone/19)):

- No `prettier` field in `package.json` as a config source.
- No nested `.editorconfig` in subdirectories; `root = true` is not respected and nested
  `.editorconfig` files are not merged.
- `experimentalTernaries` and `experimentalOperatorPosition` not supported.
- **Prettier plugins are not supported at all.** Built-in replacements exist for the four common
  ones: `sortImports` (perfectionist-style, off by default), `sortTailwindcss` (off),
  `sortPackageJson` (**on by default**), `jsdoc` (off).
- Default `printWidth` is **100**, not Prettier's 80.

None of these gaps touch a plain Node/TS library with no Tailwind and no Prettier plugins. For this
package the honest risk is not capability, it is **0.x churn**: weekly minor releases with no semver
contract, so a bump can in principle reformat the tree. Pin exact and bump deliberately.

**Language coverage is broad** — JS/JSX/TS/TSX, JSON/JSONC/JSON5, YAML, TOML, Markdown/MDX, CSS/SCSS/Less,
GraphQL, HTML, Vue/Angular/Svelte/Ember/Handlebars — so one binary can format `.ts`, `package.json`,
`*.md`, and any `.toml`/`.yaml` config the package carries.

---

## Q5(b) — Standalone config for a top-level dir: **yes, cleanly, by construction**

Both tools resolve config **per formatted/linted file, nearest-wins, with no merging into parent
configs.**

**oxlint** ([Nested configuration files](https://oxc.rs/docs/guide/usage/linter/nested-config.md)):

> "For each file being linted, Oxlint uses the nearest config file … relative to that file."
> "Configuration files are not automatically merged. A config in a child directory does not affect
> the parent config."

Auto-discovered names: `.oxlintrc.json`, `.oxlintrc.jsonc`, `oxlint.config.ts`, `oxlint.config.mts`.
`extends` is opt-in only — an array of paths resolved relative to the declaring config; a config
with no `extends` inherits nothing. `-c/--config` or `--disable-nested-config` pins a single config
and turns discovery off entirely. One real constraint: `options.typeAware` and `options.typeCheck`
are **root-config-only** — setting either in a *nested* config is an error. Not a problem here,
because the package will be run with its own directory as the working root (and, once lifted out,
literally is the root).

**oxfmt** ([Configuration](https://oxc.rs/docs/guide/usage/formatter/config.md)): identical model —
walks up from the file being formatted, discovering `.oxfmtrc.json`, `.oxfmtrc.jsonc`,
`oxfmt.config.ts`, `oxfmt.config.mts`; *"The nearest config file to each formatted file wins"*;
`-c` or `--disable-nested-config` pins one config. `ignorePatterns` are gitignore-style and rooted
at the config file's directory — patterns containing `..` are a hard configuration error, which is
itself a guarantee that a package-level config cannot reach outside its own directory.

**hae's actual situation makes even that machinery unnecessary.** Contrary to the ticket's
phrasing, hae's configs are **not at the repo root** — they are at
`client/.oxlintrc.json` and `client/.oxfmtrc.json` (plus `client/.oxlintrc.json.example`). There is
no `.oxlintrc.json` or `.oxfmtrc.json` at `/Users/sbowles/hae`. So a sibling top-level package
directory has **nothing above it to inherit from in the first place** — nearest-wins finds the
package's own config and stops at the repo root having seen no other.

`client/.oxlintrc.json` is a React/browser config and `client/.oxfmtrc.json` a formatter config
tuned to hae's frontend, neither meaningful to a Node library — nothing an Effect Node library
should inherit even if it could.

**Pre-commit scoping, verified.** hae's pre-commit lint/format hooks are scoped to `client/`: both
shell into it and are file-scoped to it, so a file in the new package never triggers them. **Caveat
worth recording:** the file's top-level `exclude:` does **not** yet name the new package directory,
so hae's *generic* hooks would still touch files there until the planned exclude edit. Ticket 04
Q4's "excluded from pre-commit entirely" is therefore a **planned edit not yet made**; the
oxlint/oxfmt half is already true, the generic half is not.

**Q5(b) verdict:** no conflict is possible, and no `extends`, no `--config` flag, and no
`--disable-nested-config` is required. Drop `.oxlintrc.json` + `.oxfmtrc.json` in the package
directory and run the tools from there via the package's own npm scripts.

---

## Recommendation

**This is a T1 implementation detail, not a decision the map should carry.** The correctness
premise that made ticket 11 load-bearing is gone (closed by tsgo diagnostics on the single
typecheck, per 06). What remains is which of four interchangeable style tools formats a
single-author package that will be lifted into its own repo shortly. Nothing downstream depends on
the answer; any of the four can be swapped in an afternoon with one command and one reformat commit.

**Recommendation: oxlint + oxfmt.** Reasons, in order of weight:

1. **The user's stated prior already matches hae's client**, so there is one toolchain in the
   contributor's head instead of two. That is the whole argument and it is sufficient for a T1.
2. **Effect itself uses oxlint** (1.76+), on TS 7 and vitest 4 — the same stack. Copying rule
   selections from
   [`packages/tools/oxc/oxlintrc.json`](https://raw.githubusercontent.com/Effect-TS/effect/main/packages/tools/oxc/oxlintrc.json)
   is free and legitimate. The `@effect/oxc` *plugin* is unpublished, so its five custom rules are
   not available — but they are monorepo-hygiene rules irrelevant to a single package.
3. **One binary, no plugin ecosystem, no config sprawl** — both tools are Rust, zero-JS-dependency,
   and fast enough to be invisible in `npm run verify`.
4. **Two configs, ~15 lines total**, provably independent of `client/` (Q5b).

**The honest counter-argument, stated plainly:** Effect chose **dprint**, not oxfmt, and dprint's
config encodes the semicolon-less/no-trailing-comma Effect house style. If matching *Effect's* code
shape matters more than matching *hae's client*, copy
[`dprint.json`](https://raw.githubusercontent.com/Effect-TS/effect/main/dprint.json) verbatim and
be done. This is a genuine fork in the road, and it is purely aesthetic. oxfmt can be configured to
approximate it (`semi: false`, `trailingComma: "none"`, `printWidth: 120`) if you want Effect's
look on hae's toolchain — recommended if the eventual lift-out is meant to read as an Effect-native
project.

**Rejected:**

- **eslint + prettier** — the incumbent-by-default. Costs a plugin graph and a flat-config file,
  and `@effect/eslint-plugin` has been unpublished-to since 2025-04-24, so the "ecosystem breadth"
  argument does not even pay off on the Effect axis. No.
- **biome** — a fine single-binary alternative with no relationship to anything already in play
  here (not hae's client, not Effect's repo). Choosing it means a third toolchain for zero gain.
- **dprint alone** — format only; you would still need a linter, so this is really "dprint +
  oxlint", which is Effect's exact combination. Legitimate, and the runner-up. It costs a WASM
  plugin download (`plugins.dprint.dev/typescript-0.93.4.wasm` etc.) versus oxfmt's zero.

**Concrete shape:**

```json
"scripts": {
  "typecheck": "tsgo --noEmit",
  "lint":      "oxlint --deny-warnings",
  "format":    "oxfmt",
  "format:check": "oxfmt --check",
  "test":      "vitest run",
  "verify":    "npm run typecheck && npm run lint && npm run format:check && npm run test"
}
```

Note that Effect folds `dprint check` into `lint`; keeping `format:check` as its own step in
`verify` is clearer for an agent reading a failure. **Pin `oxfmt` exact, not `^`** — it is 0.x with
weekly minors and no semver contract (Q5a), and an unattended bump reformatting the tree is the one
failure mode this choice actually carries.

**Do not** enable `options.typeAware` in the package's oxlint config. Effect does not, ticket 06
declined the tsgolint bridge, and type-aware oxlint is explicitly excluded from oxc's semver policy
("Type-aware rules and their behavior may change as this feature evolves" —
[versioning](https://oxc.rs/docs/guide/usage/linter/versioning.md)). Type-level truth arrives via
the tsgo-patched typecheck; the linter should stay cheap and syntactic.
