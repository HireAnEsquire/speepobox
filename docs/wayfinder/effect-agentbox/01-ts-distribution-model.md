# 01 — TS distribution with uvx-equivalent guarantees

Labels: `wayfinder:research`
Map: [MAP.md](MAP.md)
Blocked by: —
Assignee: research subagent (charting session, 2026-07-29)
Status: **closed** 2026-07-29 — findings at `research/01-ts-distribution-findings.md`

## Question

ADR 0006 chose `uvx --from git+<source>@<pinned-ref>` for the python port and got four
properties nearly for free: the ref pinned in a committed config file, no build step on the
adopter's machine, an interpreter supplied by the tool, and a one-line reviewable upgrade. The
core never enters the consuming repo — `.agentbox/` there holds only adapter files.

What is the TS equivalent, and which of those four properties survive?

Evaluate at minimum:

- `npm publish` (scoped) + `npx <pkg>@<version>` — real release infra, but registry semantics
- `npx github:org/repo#<sha>` with a committed `dist/` — no registry, no adopter build
- `npx github:org/repo#<sha>` with a `prepare` build — no committed artifacts, adopter builds
- JSR (publishes TS source; npm compatibility layer)
- Node type-stripping (`--experimental-strip-types` / unflagged on node 24) to skip the build
  entirely — check whether Effect code is type-strip-safe (no enums, namespaces, parameter
  properties, or decorators in emitted output)
- `bunx` / `bun build --compile` — note this drifts toward the Go/Rust binary posture ADR 0006
  rejected

Score each on: **(a)** pin lives in a committed, reviewable config file, so within-team version
skew is impossible; **(b)** core never lands in the consuming repo; **(c)** no build on the
adopter machine; **(d)** upgrade is a one-line diff; **(e)** cold-start and offline/cache
behavior; **(f)** supply-chain surface for a credential-adjacent tool that pushes code.

Also report: how prompt templates and any non-JS assets ship under each option (feeds the
prompt-packaging fog on the map).

## Answer

Full findings at [`research/01-ts-distribution-findings.md`](research/01-ts-distribution-findings.md).

**Recommendation: none of the `npx` forms is the uvx equivalent — the match is a clone-run
shim.** A ~40-line committed shim shallow-clones the tool repo at a SHA pinned in
`.agentbox/config`, runs `npm ci --omit=dev --ignore-scripts` once into a user cache, and executes
`node <cache>/src/cli.ts` directly under Node's now-stable type stripping. That yields all four
uvx properties — committed reviewable pin, core outside the consuming repo, zero build anywhere,
one-line upgrade — **plus** full transitive-tree determinism via the tool's committed lockfile,
which plain `npx` can never give (it re-resolves transitive deps per machine even under an exact
pin). Effect consumer code verified fully strip-safe: a representative Effect + `@effect/cli`
program passed `tsc --erasableSyntaxOnly` clean and ran unbuilt, ~68 ms strip overhead.

**Honest trade-off:** the shim, cache, and a node ≥ 24 floor are ours to build and scaffold — no
TS option fetches the runtime the way uv fetches python.

**Fallback:** scoped `npm publish` of a bundled dep-free artifact + `npx --yes pkg@exact` with
OIDC trusted publishing.

**Ruled out:** JSR (npm-compat tarballs still lack `bin`, no npx-equivalent — both open issues
since 2024); `npx github:` + `prepare` build; `bun --compile` (drifts into the binary posture ADR
0006 rejected).

**Biggest surprise — the ecosystem moved under the ticket while it was open:** npm v12 shipped
2026-07-08 and by default blocks git dependencies (`allow-git=none`) and all install/`prepare`
scripts, explicitly including under `npx` — so both `npx github:#sha` options the ticket presumed
cheapest now fail cold until every adopter weakens security defaults. Node 26 deleted
`--experimental-transform-types` (erasable-only TS is permanent law), and Node still refuses to
strip `.ts` under `node_modules` even post-stabilization. All three pushed the same direction: the
clone-run shim.

**Asset packaging** (feeds the prompt-template fog): under the clone-run model, prompt templates
and other non-JS assets are just files in the cloned tree — no bundling problem at all.

**Supplementary asset**: [`research/01a-npm-npx-semantics.md`](research/01a-npm-npx-semantics.md) —
verbatim primary-source report on npm/npx semantics (unpublish policy, trusted-publishing/token
timeline, packlist + `prepare` mechanics, offline-replay source reading). Feeds ticket 10's ADR
supply-chain section beyond what the main findings doc carries.
