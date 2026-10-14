# 01a — npm/npx distribution semantics (supplementary primary-source report)

Supplementary asset for closed ticket [01](../01-ts-distribution-model.md). Produced by a
sub-agent of the 01 research run; preserved verbatim because its primary-source citations
(unpublish policy, trusted-publishing/token-hardening timeline, packlist and `prepare`
mechanics, offline-replay source reading) exceed what the main findings doc carries and feed
ticket 10's ADR supply-chain section.

---

**Version context:** current npm CLI is **v12.0.1** (2026-07-10); v12.0.0 shipped 2026-07-08. v12 makes several security-relevant breaking changes (default-deny install scripts, `allow-git`/`allow-remote` default `none`, `npm-shrinkwrap.json` removed). docs.npmjs.com serves v12 docs at `/cli/v12/...`. Where behavior comes from CLI source rather than prose docs, the repo file is cited.

## A. `npx <pkg>@<version>`

### 1. Cold-start behavior

- **What runs it:** since npm v7, `npx` is a thin wrapper over `npm exec` — https://docs.npmjs.com/cli/v12/commands/npx/ ("Compatibility with Older npx Versions").
- **Real install into the cache:** "The requested packages are installed to a folder in the npm cache, which is added to the `PATH` environment variable in the executed process." — https://docs.npmjs.com/cli/v12/commands/npm-exec/. A genuine Arborist install (`npxArb.reify({save: true, add})`) into `<npm-cache>/_npx/<hash>` — source: https://github.com/npm/cli/blob/latest/workspaces/libnpmexec/lib/index.js.
- **Exact path:** posix `~/.npm/_npx/<16-hex-hash>/`; hash is `sha512(sorted package specs).slice(0,16)` over raw spec strings. Consequence: `npx pkg@1.2.3` and `npx pkg` occupy *different* cache entries.
- **Prompt:** "Need to install the following packages: ... Ok to proceed?" — suppressed by `-y`/`--yes`; assumed when stdin is not a TTY or CI is detected. `--no` forces failure.
- **Prompt when already cached:** **not shown** — fires only when the spec is missing from both the local project tree and the `_npx` tree.
- **Lifecycle scripts of the fetched package:** npm ≤11 ran `preinstall`/`install`/`postinstall` by default. **npm v12 changed this**: "Dependency install scripts are blocked by default... silently skip lifecycle scripts for any dependency that does not have a matching entry in `allowScripts`" — https://docs.npmjs.com/cli/v12/commands/npm-install-scripts/. For npx/global contexts the opt-in is `--allow-scripts=<pkg-list>`; `--strict-allow-scripts` hard-errors; `--dangerously-allow-all-scripts` bypasses; `--ignore-scripts` disables everything.

### 2. Cache behavior

- **Second-run semantics depend on spec type** (libnpmexec `missingFromTree`):
  - **Exact version (`pkg@1.2.3`)**: matched by `node.pkgid === spec.raw` — no manifest fetch, **no registry contact** on re-run.
  - **Range, dist-tag (incl. implicit `@latest`), or bare name**: always fetches a fresh manifest (`preferOnline: true` → HTTP cache mode `'no-cache'`). So `npx foo` / `npx foo@latest` contacts the registry **every run**.
- **`_npx` directory:** managed via `npm cache npx ls|rm|info`; each entry stamped with `_npx: { packages }`.
- **TTL/staleness:** none on `_npx` entries; "npm will not remove data by itself". Caveat: "The npm cache is strictly a cache: it should not be relied upon as a persistent and reliable data store."
- **Fully offline re-run:** **yes for an exact pinned version**. For range/tag specs, needs `--offline`/`--prefer-offline`; plain re-run fails without network due to forced revalidation.

### 3. Resolution semantics and pinning

- **Exact version** pins the *top-level tarball* identity only. Registry versions are immutable, but a version can be *unpublished* (breaks, not silently changes, resolution).
- **Transitive drift: yes.** No lockfile is consumed by npx execution — fresh Arborist ideal-tree build from dependency *ranges* per machine at first run. `package-lock.json` never ships in registry tarballs; as of v12 even a shipped `npm-shrinkwrap.json` "is ignored... use `bundleDependencies` instead" — https://docs.npmjs.com/cli/v12/configuring-npm/package-lock-json/. **Exact top pin + unpinned transitives = per-machine transitive resolution**; only `bundleDependencies` or zero deps freeze transitives.
- Warm re-runs on one machine are frozen at first-run resolution; drift materializes across machines/cold caches.

## B. Publish/registry semantics

### 4. Mutation / unpublish

- "Registry data is immutable"; "Once `package@version` has been used, you can never use it again" — https://docs.npmjs.com/policies/unpublish.
- Unpublish: within 72h if no public dependents; after 72h requires no dependents AND <300 downloads/week AND single owner. Full unpublish ⇒ 24h before name reuse.

### 5. Provenance / attestations

- `npm publish --provenance` produces a SLSA provenance attestation + a registry publish attestation — https://docs.npmjs.com/generating-provenance-statements. Sigstore: Fulcio short-lived signing cert against CI OIDC; Rekor transparency log.
- Limit, verbatim: "it does not guarantee the package has no malicious code."
- Verify: `npm audit signatures` (`--json --include-attestations` emits DSSE envelopes).
- GA since 2023-09-26; public packages + public repos; cloud-hosted GitHub Actions or GitLab CI runners only.

### 6. Trusted publishing / OIDC

- **GA 2025-07-31** — "short-lived, workflow-specific credentials that cannot be exfiltrated or reused"; provenance on by default. Requires npm CLI ≥ 11.5.1. Providers July 2026: GitHub Actions, GitLab CI/CD, CircleCI cloud (2026-04-06). "Self-hosted runners are not currently supported." Bulk config (`npm trust`) GA 2026-02-18.

### 7. 2FA / tokens / post-incident hardening

- **Incidents:** chalk/debug phishing compromise Sept 2025 ("live for roughly two hours", ~2B weekly downloads affected); Shai-Hulud self-replicating worm notified 2025-09-14 — https://github.blog/security/supply-chain-security/our-plan-for-a-more-secure-npm-supply-chain/.
- **Hardening timeline** (github.blog/changelog): 2025-09-29 granular-token default expiry 7 days (was 30), max 90 (was unlimited), new TOTP setups disabled; 2025-11-05 classic-token creation disabled, write tokens 2FA-default + 90-day cap; 2025-12-09 all classic tokens permanently revoked, `npm login` issues 2-hour session tokens, 2FA-required default for new packages; 2026-07-08 bypass-2FA granular tokens lose sensitive actions Aug 2026 and publish ~Jan 2027 — sanctioned CI path = trusted or staged publishing.
- **Current state:** "only Granular access tokens are supported"; 2FA docs describe WebAuthn/security keys only; strictest per-package mode = "Require two-factor authentication and disallow tokens".

### 8. Install scripts default

- npm ≤11: dependency install scripts run by default. **npm 12: default deny**, managed via `npm install-scripts approve|deny|ls|prune` writing `allowScripts` in package.json (pinned `pkg@1.2.3` entries; explicit `false` survives `approve --all`). Root project's own scripts still run; root `preinstall` now runs before deps install. `--ignore-scripts` overrides everything.

## C. `npx github:org/repo#<ref>`

### 9. Spec syntax

- `#<commit-ish>` clones exactly that commit; `#semver:<range>` matches tags/refs; neither ⇒ default branch — https://docs.npmjs.com/cli/v12/configuring-npm/package-json/ ("Git URLs as Dependencies"). Shorthands `github:`, `gitlab:`, `bitbucket:`, `gist:`, `sourcehut:`.
- **npm 12 gate:** "allow-git and allow-remote now default to \"none\"" — `npx github:org/repo` requires `--allow-git=all` (or config) on npm 12.

### 10. `prepare` on git install

- "If a package being installed through git contains a `prepare` script, its `dependencies` and `devDependencies` will be installed, and the prepare script will be run, before the package is packaged and installed." — https://docs.npmjs.com/cli/v12/using-npm/scripts/.
- Build flow triggers on any of: `workspaces`, `build`, `prepare`, `prepack`, `preinstall`, `install`, `postinstall`. Warning: pre-built artifacts get rebuilt every install unless none of those scripts exist.
- Mechanics (pacote git.js/dir.js): clone to temp dir, child `npm install --force --include=dev... --no-save --no-audit` in the clone, then run only `prepare`. `_PACOTE_NO_PREPARE_` guards against prepare recursion.

### 11. Git npx caching

- Same `_npx/<hash>` mechanism, hash over the raw spec string — each ref spelling is its own entry.
- Re-runs touch network by default (git specs always `pacote.manifest` with `preferOnline: true`). **Full 40-hex pinned SHA on a hosted platform**: resolves without `git ls-remote` (codeload-tarball shortcut, cached in `_cacache`) — with `--offline`, a previously-run pinned-SHA npx can re-run fully offline. Branch/tag/`#semver:` refs require ls-remote every time — no offline replay. (Source-verified, not doc-stated.)
- Git deps skip integrity pinning deliberately (npm/rfcs#525) — the pin is the commit SHA, enforced by `EGITCHECKOUT` mismatch errors.

### 12. What ships — `files`/.npmignore

- Pack rules apply — the whole repo does not ship. Tarball built with npm-packlist: `files` omitted ⇒ `["*"]`; root `.npmignore` doesn't override `files` but does in subdirs; **`.gitignore` used as fallback when `.npmignore` missing**.
- Consequence: a committed-but-gitignored `dist/` with no `.npmignore`/`files` override is **silently dropped**. Never includable: `.git`, `node_modules`, all lockfiles, `.npmrc`.

### 13. Dependencies of a git dep

- Consumer's Arborist resolves the dep's `dependencies` from **ranges** at install time; the repo's committed lockfile does not constrain the consumer (can't be packed; shrinkwrap ignored as of v12). Only lock-shipping mechanism left: `bundleDependencies`.
- Nuance: the *preparation* child-install inside the clone IS lock-guided (lockfile on disk), but that tree is discarded after packing.

## Unverified / partial

Exact chalk/debug incident date from a primary source; Azure Pipelines trusted publishing (planned 2025-09-29, not shipped July 2026); registry packument TTL headers; §C11/§C13 offline-replay and clone-lockfile nuances are CLI/pacote source reading, not documentation prose.

## Load-bearing takeaways

1. `npx pkg@exact` is prompt-free once cached, replays offline, never re-contacts the registry — but transitives drift per machine unless bundled.
2. `npx pkg` / `@latest` phones the registry on every invocation.
3. npm 12 flips two defaults: dependency install scripts default-denied; git-source installs require explicit `--allow-git` — `npx github:org/repo#sha` is materially higher-friction than a registry publish.
4. Registry versions are immutable, and 2025–26 hardening (trusted publishing GA, classic tokens revoked, 2FA-enforced publish) substantially strengthens the registry-pinning story relative to git refs.
