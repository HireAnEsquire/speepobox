# T141 — The tree is scrubbed for the public seed

Status: Done (PR #102. Manifest scrubs applied, no file deleted, private links gone; AGENTS.md and SPEC.md carry the private-archive note. Deferred to the go-public ticket: the "stays private" lines at MAP.md:457-462 and 09:739-741, and T140-T142's pointers to dropped files. The Dockerfile comment edit makes this repo's image stale: rebuild.)
Type: AFK
Blocked by: [T140](T140-the-public-seed-is-audited-file-by-file.md)

<!--
T140's manifest (`research/T140-public-seed-manifest.md`) sorted every file into keep, scrub, or
drop. The operator ruled on it 2026-10-14. This ticket applies the scrubs here, on main, so `verify`
checks them; the original text stays in this repo's history. The drops are NOT made here: the seed
leaves those files out, and this repo, the archive, keeps them whole.
-->

## What to build

Apply the manifest's **scrub** rows, as the operator ruled below. The manifest's line numbers are
against `26572c9b`; find each passage by its content, not only by its number.

### Apply

- **hae's internals.** Every scrub row about hae's settings, infrastructure, test failures, quoted
  source, Dockerfile, setup scripts, env files, or security arrangements. Use the rewording the row
  proposes, or an equivalent one that keeps the rule's argument. This includes deleting T136's
  appendix (`:68-271`). Its password is a throwaway test value, but the appendix also quotes hae's
  Dockerfile, setup script, settings paths, and config.
- **Hyperlinks into private repositories** become plain text: the 15 PR links in `MAP.md`, the blob
  URL in `SPEC.md`, and the `app\.hireanesquire\.com` PR links (`T2-ledger-status.md` and others the
  manifest lists).
- **Pointers to files the seed drops** are reworded without the pointer, as §2 of the manifest
  proposes: T131, T134, `docs/AGENT_SANDBOXING.md`, `extraction/`, and
  `tasks/editor-and-review-fixes/`. Example: "the hae install gate" instead of a T134 link.
- **The citation note.** Rewrite `AGENTS.md`'s `run.sh:N` preamble (`:14-16`) to say: these
  citations, and the commit SHAs and PR numbers in `docs/`, refer to the **private archive
  repository**, readable by org members only; every rule states its claim in place. Add the same
  sentence at the citation note in `SPEC.md` (`:903`). Leave every `run.sh:N` citation as written.
- **Test fixtures.** Replace real hae ledger lines, PR URLs, and PR numbers with the manifest's
  values (`acme/hae`, `example.test`, `101`). Change every number that tracks them in step, so
  `verify` stays green. Prefer importing `forge-fake.ts`'s `PR_NUMBER` to repeating the literal.

### Do not apply

- **Identity rows.** The operator's name, handle, home paths, and the story in `07-name.md` stay as
  they are.
- **Release-URL rows.** `README.md:20-22,32,40,195`, `templates/bessemer:12`, `src/pin/pin.ts:31`,
  `test/pin.test.ts`, `test/releases.test.ts`, and `test/fixtures/shim/bessemer.v2`. These wait for
  the go-public ticket, which knows the new repo's slug.
- **Optional bare `PR #N` and SHA removals.** The manifest's §2 keeps them as history.
- **Drops.** Delete no file. Rewording a pointer to a dropped file is in scope; removing the file is
  not.

T63's "frozen set" (T34 and others byte-identical) was T63's own acceptance check, not a standing
rule. Scrubbing T34 is in scope.

## Effect wiring

- **Tags introduced or consumed**: none. Comments, docs, and test fixtures only.
- **Layer composition**: unchanged.

## Acceptance criteria

- [ ] Every scrub row in the manifest is applied, except the three excluded classes above. The PR
      description lists any row not applied, and why.
- [ ] No tracked file outside `research/T140-public-seed-manifest.md` contains
      `app\.hireanesquire\.com`, `HireAnEsquire/hae[/]pull`, or a hyperlink to
      `github\.com/HireAnEsquire/bessemer[/]pull` (spelled as patterns, so this file does not match
      its own grep).
- [ ] T136 has no appendix quoting hae's files.
- [ ] `AGENTS.md` and `SPEC.md` carry the private-archive sentence.
- [ ] No file is deleted.

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package.

Also inside the container. It prints nothing when the links are gone:

```
git grep -nE "app\.hireanesquire\.com|HireAnEsquire/hae[/]pull|github\.com/HireAnEsquire/bessemer[/]pull" -- . ':!docs/wayfinder/effect-agentbox/research/T140-public-seed-manifest.md'
```
