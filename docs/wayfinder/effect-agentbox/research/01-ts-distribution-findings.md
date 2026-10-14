# Research findings: TS distribution with uvx-equivalent guarantees

Ticket: [01-ts-distribution-model.md](../01-ts-distribution-model.md) · Researched: 2026-07-29

Method: primary-source doc verification (npm docs, Node docs, JSR repo, bun docs, GitHub
changelog) **plus empirical tests** run on this machine (node v23.7.0, npm 10.9.2, TypeScript
7.0.2, effect 3.22.0, @effect/cli 0.76.0, @effect/platform-node 0.108.0). Where the local npm
(v10) differs from current npm (v12.0.1, shipped 2026-07-08), the v12 docs are cited — v12's
changes turn out to be decisive.

## Three ecosystem facts that reframe the ticket

1. **npm v12 (July 2026) blocks git dependencies and lifecycle scripts by default.**
   `allow-git` defaults to `"none"` — "npm install will no longer resolve Git dependencies
   (direct or transitive) unless explicitly allowed via `--allow-git`"; `allow-remote` likewise;
   and `allow-scripts` (default empty) blocks `preinstall`/`install`/`postinstall` and
   "`prepare` scripts from git, file, and link dependencies". The npm docs state allow-scripts
   "is intended for one-off and global contexts: `npm exec`, `npx`, and `npm install -g`" —
   i.e., npx is explicitly in scope. Both `npx github:` options in the ticket now require
   per-machine or per-invocation config overrides on every adopter box.
   Sources: [GitHub changelog 2026-06-09](https://github.blog/changelog/2026-06-09-upcoming-breaking-changes-for-npm-v12/),
   [npm v12 config docs](https://docs.npmjs.com/cli/v12/using-npm/config).

2. **Node type stripping is Stable, but Node refuses to strip `.ts` under `node_modules` —
   and that refusal survived stabilization.** Docs (v26.5.1): "To discourage package authors
   from publishing packages written in TypeScript, Node.js refuses to handle TypeScript files
   inside folders under a `node_modules` path." Verified empirically: a package whose `bin`
   points at a `.ts` file installs fine but dies at launch with
   `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`, both via the `.bin` shim and when imported
   from outside. **So "publish TS source, run with npx" does not work, period.** Any
   npm-layout option must ship JS. Source: [nodejs.org/api/typescript.html](https://nodejs.org/api/typescript.html).

3. **Node 26 removed `--experimental-transform-types` entirely** ([PR #61803](https://github.com/nodejs/node/pull/61803),
   SEMVER-MAJOR; flag history: added v22.7.0, removed v26.0.0). Strip-only is now the permanent
   law: enums, namespaces-with-runtime-code, parameter properties, `import =` aliases, and
   decorators can *never* run under plain `node`. Type stripping itself is default since
   v23.6.0 and Stability 2 (Stable) in v26. This makes the type-strip-safety question (§3)
   a hard gate, not a preference.

Consequence: the true uvx equivalent is **not** any `npx` form. It is a shim that checks out
the tool repo at a pinned SHA into a user cache *outside* any `node_modules` path, runs
`npm ci` there once for dependencies, and executes `node <cache>/src/cli.ts` directly —
where type stripping works. That option is added to the matrix below as **G (git+SHA
clone-run shim)**; it was validated end-to-end in scratch (layout identical: `src/*.ts`
entry + sibling `node_modules` deps runs clean).

## 1. Scoring table

Options: **A** `npm publish` + `npx pkg@x.y.z` · **B** `npx github:#sha`, committed `dist/` ·
**C** `npx github:#sha`, `prepare` build · **D** JSR · **E** bunx (registry) ·
**F** `bun build --compile` · **G** git+SHA clone-run shim, Node type-stripping

| Criterion | A: npx registry | B: npx git+dist | C: npx git+prepare | D: JSR | E: bunx | F: bun binary | G: clone-run shim |
|---|---|---|---|---|---|---|---|
| **(a) pin in committed config, no team skew** | Yes for the tool: exact `pkg@1.2.3` in the committed shim resolves exactly (verified: per-spec cache dirs; the caret rewrite npx makes in its cache `package.json` is cosmetic). **But transitive deps re-resolve per machine** — npx generates a local lockfile in its cache, never shares one, so two teammates cold-starting a week apart can hold different transitive trees under the same pin. | SHA pin is content-addressed (stronger than a version string). Transitive deps of the tool still re-resolved per machine — npm ignores a git dep's lockfile. Bundling `dist/` dependency-free closes this. | Same SHA pin; same transitive drift, plus **devDependencies** resolved per machine. | Moot (see (b)/(c) — ruled out). | Exact pin works (`bunx pkg@1.2.3`); transitive drift same as A; bun's own resolution, no shared lock. | Pin = binary release URL + checksum in config; nothing resolves at all. | **Strongest**: SHA pin *plus* the tool repo's own committed `package-lock.json` honored by `npm ci` → full-tree determinism, better than uvx-without-lock. |
| **(b) core never in consuming repo** | Yes — npx cache (`<npm-cache>/_npx/<hash>`). | Yes — npx cache. `dist/` is committed in the *tool* repo (churny generated diffs there, not in consumers). | Yes — npx cache. | The compat path is `npm install` into the consumer's `node_modules` — closer to a dependency than a tool. | Yes — bun global cache. | Yes — a binary on PATH or in a cache dir. | Yes — `~/.cache/agentbox/<sha>/` (or similar); consumer repo holds only the shim + config, exactly like the python plan. |
| **(c) no build on adopter machine** | Yes — built at publish time (CI). | Yes — `dist/` is prebuilt; npm packs the checkout as-is (`files` honored on git installs). | **No** — npm installs the git dep's deps *and devDeps* and runs `prepare` on the adopter machine ([scripts docs](https://docs.npmjs.com/cli/v12/using-npm/scripts): "its `dependencies` and `devDependencies` will be installed, and the prepare script will be run"). Under npm v12 the prepare script is **blocked by default** — cold start fails until the adopter approves scripts. | JSR transpiles at publish; no adopter build — but see (e). | Yes — bun executes TS natively (incl. enums/decorators). | Build happens once, in tool CI, per release. | **Yes — no build ever exists.** Node strips types at run time; verified: full Effect + @effect/cli program runs under strip-types with zero compile step. |
| **(d) upgrade = one-line diff** | Yes — version bump in committed shim/config. | Yes — SHA bump. | Yes — SHA bump. | Yes in principle. | Yes — version bump. | Yes — URL/checksum bump (two lines). | Yes — SHA bump; `npm ci` re-runs automatically when the cached SHA dir is absent. |
| **(e) cold start / offline** | Cold: registry fetch, ~2–5 s; prompts "Ok to proceed?" unless the shim passes `--yes` (verified). Warm: cache hit by spec-hash, runs offline (verified with `--offline`). | Cold: git clone via npm — **and under npm v12, fails outright until `allow-git` is set** (default `"none"`). Warm: cached, offline OK. | Cold: clone + full devDep install + build — slowest by far, and doubly blocked by v12 defaults (`allow-git` + `allow-scripts`). | **No npx-equivalent exists at all**: "Add npx-like behavior" is an open feature request since 2024 ([jsr#157](https://github.com/jsr-io/jsr/issues/157)); npm-compat requires a committed `.npmrc` scope mapping first. | Cold: fast fetch, cached in global cache; no prompt. Warm: instant, offline OK. | Best possible: single file, instant, fully offline. | Cold: one `git clone --depth 1` + one `npm ci` (~5–15 s). Warm: **zero network** — pure local `node` invocation; fully offline; no npx staleness checks in the loop. |
| **(f) supply-chain surface (credential-adjacent tool that pushes code)** | Registry account is the attack surface; mitigations now real: versions immutable ("Once `package@version` has been used, you can never use it again" — [unpublish policy](https://docs.npmjs.com/policies/unpublish/)), provenance attestations, trusted publishing OIDC GA since 2025-07 ([changelog](https://github.blog/changelog/2025-07-31-npm-trusted-publishing-with-oidc-is-generally-available/)), `npm audit signatures`, and v12's script-blocking. Residual: unpinned transitive tree on each cold start (the 2025 Shai-Hulud vector). | Tool code integrity is git-SHA content addressing — no registry trust needed for the tool itself. Transitive deps still registry-resolved unpinned, unless dist/ is bundled dep-free (then surface ≈ zero, at the cost of committing bundles). | Worst: adopter machine runs a build with the full devDep tree installed; requires enabling scripts globally for npx — weakening the v12 default for *everything else* the adopter runs. | Immutable registry (good design) but unusable for a CLI (see below). | Tool via registry as A; bun itself becomes a second trusted runtime; bun only runs postinstall for allowlisted `trustedDependencies` (a plus). | Exact signed artifact — strongest integrity, but you now own release signing infra; ADR 0006 already rejected this posture. | SHA-pinned tool + lock-pinned full dep tree + `npm ci --ignore-scripts` viable (Effect ships no install scripts — verified install of 39 packages runs none). Smallest surface of the npm-based options; equal to uvx-with-lock. |

## 2. Mechanics per option

### A. `npm publish` (scoped) + `npx @scope/agentbox@x.y.z`

- **Adopter runs**: nothing to install. Committed shim (`.agentbox/agentbox` or a
  `package.json` script):
  ```sh
  #!/bin/sh
  exec npx --yes @scope/agentbox@1.4.2 "$@"
  ```
  Pin can also live in `config.toml`/`config.json` with the shim reading it — same shape as the
  python plan.
- **Cold start**: npx resolves `@1.4.2` against the registry, installs into
  `<npm-cache>/_npx/<hash-of-spec>/node_modules`, runs the `bin`. `--yes` suppresses the
  install-confirmation prompt. Verified: each distinct spec gets its own hash dir, so two pins
  never collide; re-running the same pin is a cache hit.
- **Offline/warm**: verified — second run of the same spec works with `--offline`; without
  flags npm may still do registry staleness checks depending on cache headers.
- **Publish side**: CI builds `dist/` (erasure-only — see §3), `npm publish --provenance` via
  trusted-publishing OIDC (no long-lived token). Requires: claiming the scope, release
  workflow, 2FA on the account.
- **Gotcha**: the exact-pin guarantee covers only the top package. Transitive deps (effect,
  @effect/cli, ~19 packages) are re-resolved from their semver ranges per machine at first
  run — npx involves no shared lockfile. Mitigation: bundle at publish (tsdown/esbuild single
  file, zero runtime deps), which converts A into "registry-hosted bundle" and closes both the
  drift and most of the supply-chain residual.

### B. `npx github:org/agentbox#<sha>` with committed `dist/`

- **Shim**: `exec npx --yes github:org/agentbox#4f2a91c "$@"`.
- **What npm does**: clones/fetches the repo at the SHA, packs it (honoring `files` /
  `.npmignore` — [package spec docs](https://docs.npmjs.com/cli/v12/commands/npm-install)),
  installs the result plus its `dependencies` into the npx cache. A committed `dist/` ships
  as-is; without a `prepare` script no build runs.
- **npm v12 breaks the default path**: `allow-git` defaults to `"none"`, so every adopter must
  carry `allow-git=all` in `.npmrc` or the shim must pass `--allow-git`. A committed
  project-level `.npmrc` in the consuming repo can carry it, but that flag then loosens git
  deps for the *whole* consuming project, not just the tool. This is a real, new tax on the
  option the ticket presumed cheapest.
- **Tool-repo cost**: generated `dist/` committed on every release — diff noise, merge
  conflicts on parallel release branches, and the classic "dist out of sync with src" review
  hazard.

### C. `npx github:org/agentbox#<sha>` with `prepare` build

- Same shim as B; the repo commits no artifacts and declares
  `"prepare": "tsc -p tsconfig.build.json"` (or tsdown).
- **What happens**: npm installs deps **and devDependencies** of the tool and runs `prepare`
  on the adopter machine before packing/installing
  ([scripts docs](https://docs.npmjs.com/cli/v12/using-npm/scripts)).
- **npm v12 double-blocks it**: needs `allow-git` *and* script approval ("prepare scripts from
  git, file, and link dependencies are blocked the same way" —
  [v12 changelog](https://github.blog/changelog/2026-06-09-upcoming-breaking-changes-for-npm-v12/)).
  An adopter running the shim cold gets a failure, then has to weaken two security defaults
  machine-wide (or per-invocation in the shim, which normalizes `--allow-scripts` for a
  credential-adjacent tool — exactly backwards). **Ruled out.**

### D. JSR

- **What JSR serves npm clients**: *transpiled JS + `.d.ts`*, not TS source — "JSR transpiles
  the TypeScript code to JavaScript before it is installed into your `node_modules`"
  ([npm-compatibility doc](https://jsr.io/docs/npm-compatibility)). So the "publishes TS
  source" appeal doesn't reach npm-side consumers anyway; it exists only for Deno-native use.
- **Fatal for a CLI**: the npm-compat tarballs **do not carry the `bin` field** — the fix PR
  ([jsr#284](https://github.com/jsr-io/jsr/pull/284), for
  [jsr#157](https://github.com/jsr-io/jsr/issues/157)) has been open since March 2024 and
  unmerged as of Sept 2025, and there is no `npx`-like one-off runner
  (open feature request, same #157). Install requires a committed `.npmrc` mapping
  `@jsr:registry=https://npm.jsr.io` first.
- Good properties it does have (registry immutability by design, OIDC publishing) are
  unreachable for this use case. **Ruled out.**

### E/F. `bunx` / `bun build --compile`

- **bunx**: `bunx agentbox@1.4.2` — fast, cached in bun's global cache, no confirmation
  prompt, respects a `#!/usr/bin/env node` shebang (runs node) or `--bun` to force bun's
  runtime ([bunx docs](https://bun.sh/docs/cli/bunx)). Bun executes TS natively including
  non-erasable syntax, so it could even run TS straight from a registry package.
- **The disqualifier is upstream of the mechanics**: it makes *bun* a hard host dependency.
  ADR 0006's adopter survey says "all adopter machines have node" — it says nothing about
  bun. Adding a second runtime to every adopter machine to avoid a build step that §3 shows
  is avoidable anyway is a net loss. (Whether bunx accepts `github:#sha` sources was not
  verified — UNVERIFIED — but it doesn't change the verdict.)
- **`bun build --compile`** produces a self-contained single binary with embeddable assets —
  this is precisely the "exact signed artifacts, release infra, binaries don't belong in git"
  posture ADR 0006 rejected for Go/Rust, with the same fixed costs. **Ruled out** on the
  ADR's own recorded reasoning.

### G. git+SHA clone-run shim (the actual uvx equivalent)

- **Committed config** (`.agentbox/config.*`):
  ```
  source = "https://github.com/org/agentbox"
  pin    = "4f2a91c8..."   # full SHA, reviewable one-line bump
  ```
- **Committed shim** (~30–40 lines of sh, scaffolded by `init` like the python plan's
  two-liner — this is the honest extra cost vs uvx):
  ```sh
  #!/bin/sh
  # resolves pin from config; then:
  cache="${XDG_CACHE_HOME:-$HOME/.cache}/agentbox/$pin"
  if [ ! -d "$cache" ]; then
    git clone --depth 1 "$source" "$cache" && git -C "$cache" fetch --depth 1 origin "$pin" \
      && git -C "$cache" checkout -q "$pin"
    (cd "$cache" && npm ci --omit=dev --ignore-scripts)
  fi
  exec node "$cache/src/cli.ts" "$@"
  ```
  (Illustrative; the real shim handles fetch-by-SHA vs clone, lock retries, and node-version
  check. `node` here strips types natively — the entry `.ts` files live under
  `~/.cache/...`, *not* under a `node_modules` path, so the restriction in fact-2 never
  fires. Empirically validated in exactly this layout.)
- **Cold start**: one shallow clone + one `npm ci` (registry fetch of ~20 packages, honoring
  the tool's committed lockfile), then `node src/cli.ts`. Subsequent runs: no network, no
  npm, no npx — just node. Offline: fully, after first run per pin.
- **npm v12 compatibility**: `npm ci` inside the checkout is a *root project* install of
  registry deps — `allow-git`/`allow-remote` never trigger; `--ignore-scripts` is viable
  because effect/@effect/cli/@effect/platform-node ship no install scripts (verified: 39
  packages installed, zero lifecycle scripts).
- **Node-version floor**: adopters need node ≥ 23.6 (stripping default) — realistically
  "node 24 LTS or later" as the documented requirement; the shim can check and say so. This
  is the analogue of uv's `requires-python`, except node is *not* fetched for the adopter —
  the one uvx property that genuinely does not survive in any TS option.

## 3. Node type-stripping verdict: Effect is strip-safe — verified, not assumed

Two distinct questions, both answered:

1. **Does Effect-the-dependency need stripping?** No — irrelevant. effect 3.22.0 publishes
   compiled dual CJS/ESM JS (`dist/cjs`, `dist/esm`) with `.d.ts` (362 files) and `src/*.ts`
   included only for source-mapping/go-to-definition. Whatever non-erasable syntax Effect uses
   internally is already compiled away before it reaches `node_modules`. (Bonus: effect
   publishes with `"provenance": true`.)

2. **Is Effect *consumer* code — the agentbox source that would be stripped — erasable-only in
   its natural idioms?** Yes. A representative program exercising the ADR's load-bearing
   idioms — `Data.TaggedError` typed errors, `Effect.Service` classes, `Context.Tag`,
   `Layer`, `Schema.Struct`/`Schema.brand`/`Schema.Literal` (the enum replacement),
   `Effect.acquireRelease` + `Scope`, generics with the R-channel, and a full `@effect/cli`
   `Command.run` wiring — was written and:
   - **compiles clean under `tsc --strict --erasableSyntaxOnly --verbatimModuleSyntax`**
     (TypeScript 7.0.2, exit 0) — `erasableSyntaxOnly` (added TS 5.8,
     [release notes](https://devblogs.microsoft.com/typescript/announcing-typescript-5-8/))
     is the compile-time guarantee that no enum/namespace/param-property/`import =` ever
     enters the codebase, enforceable in CI and, crucially, on AFK-agent-authored diffs;
   - **runs under `node --experimental-strip-types` with zero build** (verified output:
     the CLI parsed args, built layers, acquired/released the scoped resource, printed).

   This is no accident: Effect's public API is class-and-function shaped; its own style guide
   avoids enums in favor of literal unions/`Schema.Literal`, and decorators appear nowhere in
   the core API. The idioms and the erasable subset genuinely coincide.

   Constraints the codebase inherits (all mechanical, all lintable):
   - relative imports must be extensioned `./x.ts` (Node docs: "File extensions are mandatory");
   - no enums/namespaces/parameter-properties/decorators/`import =` — enforced by
     `erasableSyntaxOnly`, and since Node 26 removed transform-types there is no escape hatch
     to grow dependent on;
   - strip overhead measured at **~68 ms** on the test CLI (median 397 ms vs 329 ms prebuilt,
     7 runs) — noise against container dispatch times. No on-disk cache of stripped output;
     the cost recurs per invocation.

   **So the ticket's conditional holds**: git+SHA distribution needs no build step at all —
   *provided the tool's own files are executed from outside `node_modules`* (option G), because
   the node_modules refusal (fact 2) kills the strip-based versions of options A–C.

   One publishing wrinkle if option A is ever wanted alongside G: `.ts`-extensioned relative
   imports must be rewritten to `.js` for a compiled artifact — TS 5.7+'s
   `rewriteRelativeImportExtensions` or any bundler handles this; the scratch test confirmed
   erasure+rewrite yields a working 1:1 `dist/`.

## 4. Prompt templates and non-JS assets

| Option | How prompts ship | Notes |
|---|---|---|
| A (registry) | `"files": ["dist", "prompts"]` — verified via `npm pack`: `prompts/dispatch.md` lands in the tarball and in `node_modules/agentbox/prompts/` | Resolve at runtime relative to `import.meta.url`; works. If A adopts single-file bundling to fix transitive drift, prompts must be either embedded as strings (build step complexity) or kept as `files` alongside the bundle (fine). |
| B (git+dist) | Full repo checkout is packed → prompts present as plain files | `files` in package.json controls what's packed from the checkout. |
| C (git+prepare) | Same as B | Moot — option ruled out. |
| D (JSR) | `jsr.json` include/exclude allows arbitrary files | Moot. |
| E (bunx) | As A | — |
| F (bun --compile) | Must be embedded (`Bun.embeddedFiles`) — assets stop being inspectable files | Worst option for the "package defaults + `.agentbox/prompts/` overrides, user reads the default before overriding" model. |
| G (clone-run) | **Identical to uvx**: the cache dir *is* a git checkout — `prompts/` sit next to `src/` as ordinary readable files | The override model (same-named file under `.agentbox/prompts/` wins) ports byte-for-byte from ADR 0006. Best case. |

## 5. Recommendation

**Primary: option G — git+SHA clone-run shim, Node type-stripping, committed lockfile.**
It is the only option that matches uvx on all four original properties *and* beats it on one:
pin in committed config (a: yes, and full-tree via `npm ci` + lockfile — uv needed a lock for
that too), core never in the consuming repo (b: yes), no adopter build (c: yes — no build
exists anywhere), one-line upgrade (d: yes), instant offline warm starts (e), and the smallest
supply-chain surface of any npm-touching option (f: SHA-addressed tool + hash-locked deps +
`--ignore-scripts`). Prompts ship exactly like the python plan. npm v12's new defaults, which
tax options B/C, don't touch it.

**The honest trade-off**: uv hands you the shim, the cache, the lock semantics, *and the
interpreter* as product features; here the ~40-line shim and its edge cases (concurrent first
runs, cache eviction on pin bump, node-version check) are yours to write, test, and scaffold
via `init` — and the adopter must already have node ≥ 24-LTS-with-default-stripping, because
no TS option can fetch the runtime the way uv fetches a python. That shim is the port's first
tracer-bullet-sized artifact, not a footnote.

**Fallback (if the shim feels like too much ownership): option A** — scoped npm publish of an
erasure-built, ideally *bundled dep-free* artifact, `npx --yes @scope/agentbox@<exact>`, with
trusted-publishing OIDC + provenance. Real release infra and registry trust in exchange for
zero custom machinery; bundle to close transitive drift.

**Ruled out**: **C** (npx git + prepare) — npm v12 blocks it twice by default and it installs
the devDep tree to build on the adopter machine; adopters would have to weaken security
defaults to run a security-sensitive tool. **D** (JSR) — no `bin` in npm-compat tarballs and
no npx-equivalent (both open issues since 2024); unusable for a CLI regardless of its good
registry design. **F** (bun --compile) — re-litigates the binary posture ADR 0006 already
rejected, with bun as an added runtime dependency. **B** survives as viable-but-dominated:
everything it offers, G does without committed `dist/` churn or `allow-git` overrides.

## Source index

- npm v12 breaking changes: https://github.blog/changelog/2026-06-09-upcoming-breaking-changes-for-npm-v12/
- npm v12 config (`allow-git`, `allow-scripts`, …): https://docs.npmjs.com/cli/v12/using-npm/config
- npm scripts / `prepare` on git installs: https://docs.npmjs.com/cli/v12/using-npm/scripts
- npm unpublish policy (version immutability): https://docs.npmjs.com/policies/unpublish/
- npm trusted publishing GA: https://github.blog/changelog/2025-07-31-npm-trusted-publishing-with-oidc-is-generally-available/ · https://docs.npmjs.com/trusted-publishers/
- npm provenance: https://docs.npmjs.com/generating-provenance-statements/
- Node type stripping (stability, node_modules refusal, unsupported syntax, extensions): https://nodejs.org/api/typescript.html
- transform-types removal (Node 26): https://github.com/nodejs/node/pull/61803 · https://nodejs.org/en/blog/release/v26.0.0
- `module.registerHooks` (RC): https://nodejs.org/api/module.html
- TS `erasableSyntaxOnly` (5.8): https://devblogs.microsoft.com/typescript/announcing-typescript-5-8/
- JSR npm compatibility: https://jsr.io/docs/npm-compatibility (mirrored at jsr-io/jsr `frontend/docs/npm-compatibility.md`)
- JSR immutability: https://jsr.io/docs/immutability
- JSR bin/npx gaps: https://github.com/jsr-io/jsr/issues/157 · https://github.com/jsr-io/jsr/pull/284
- bunx: https://bun.sh/docs/cli/bunx
- Empirical: scratch project with effect@3.22.0 / @effect/cli@0.76.0 / @effect/platform-node@0.108.0, node v23.7.0, tsc 7.0.2 — strip-run success, `erasableSyntaxOnly` clean pass, `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` repro, npx cache-dir/pin/offline behavior, `npm pack` asset inclusion, 7-run startup benchmark.

## Loose ends / UNVERIFIED

- bunx `github:#sha` support: not verified (moot for the verdict).
- Whether npm's registry staleness check on warm `npx` (without `--offline`) adds latency when
  the network is up: behavior observed cached-and-working, exact revalidation policy not
  pinned to a doc.
- `module.registerHooks` + amaro (Node's own stripper, published by the nodejs foundation) was
  verified to bypass the node_modules `.ts` refusal at ~68 ms cost — noted for completeness;
  the recommendation doesn't need it, and shipping a workaround against an explicit Node
  design decision would be poor posture for this tool.
