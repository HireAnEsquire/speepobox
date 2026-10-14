# T143 — The release URL names the public repo

Status: Done (PR #103. Release URL names `HireAnEsquire/speepobox`; shim template v4 with v3 frozen; MIT LICENSE; README, CONTEXT, MAP and 09 say the repository is public. Host steps (seed, scan, settings, release, hae re-pin) follow.)
Type: AFK
Blocked by: [T141](T141-the-tree-is-scrubbed-for-the-public-seed.md)

<!--
Ruled 2026-10-14: the public repository is `HireAnEsquire/speepobox`, seeded from this tree as one
fresh commit, MIT-licensed. This repository stays private as the archive and keeps its name. The tool
is still called bessemer; only the repository is speepobox. This ticket makes the tree ready to be
that seed. The seed itself, the repository settings, and hae's re-pin are host steps, listed under
Verify.
-->

## What to build

### The release URL

Every place that names the repository a release is fetched from moves from
`HireAnEsquire/bessemer` to `HireAnEsquire/speepobox`:

- `RELEASE_URL` in `src/pin/pin.ts` and in `templates/bessemer`;
- the README's `gh api repos/…/tags` and `gh repo clone` lines (the bootstrap, and "When the pin
  cannot be fetched");
- the test expectations that spell it (`test/pin.test.ts`, `test/releases.test.ts`,
  `test/repo-slug.test.ts`, `test/shim.test.ts`). Where a test only needs *a* GitHub URL to parse,
  any spelling works; where it pins the shipped value, it pins the new one.

The clone directory in the bootstrap (`$(mktemp -d)/bessemer`) and every other use of the tool's
name stay `bessemer`.

### The shim template version

Changing `templates/bessemer` changes a released shim template: version 3 shipped in the archive's
`v2` release. Follow the rule in `src/init/stamp.ts` and `test/fixtures/shim/README.md`: first copy
the current `templates/bessemer` to `test/fixtures/shim/bessemer.v3`, unstamped and byte-identical,
then edit the template and bump its entry in `TEMPLATE_VERSIONS` to 4. Leave `bessemer.v2` and the
new `bessemer.v3` exactly as they are, old URL included: they are the text those releases shipped.
In the fixtures README, say that the `v<N>` releases it names are the archive's.

### The README says the repository is public

- **Prerequisites:** `gh auth login` stays, because a dispatch opens PRs through `gh` and the
  preflight refuses without it. Replace the reason: the repository is public, so fetching a release
  needs no membership. Keep one clause saying the shim tries `gh`'s login first and then git's own
  credentials, which `templates/bessemer` does (T132).
- Add a **License** section at the end: MIT, pointing at `LICENSE`.
- Add one sentence near the top: the repository is `speepobox`, the tool it ships is `bessemer`.
- In `CONTEXT.md`, add a `speepobox` entry: it is this repository's name, and it was also the tool's
  name until T63 renamed the tool `bessemer`. In `docs/`, `speepobox` means the tool under its old
  name: `@hireanesquire/speepobox` and the `speepobox/` directory inside hae are the old package and
  its incubation directory, never this repository. Code and tests never use the word.

### LICENSE

Add `LICENSE` at the repo root: the standard MIT text, `Copyright (c) 2026 HireAnEsquire`. Set
`"license": "MIT"` in `package.json`. Leave `"private": true`: it stops `npm publish`, and the
package is not published to npm.

### The map's leftovers

- `MAP.md`, *Not yet specified*, "Whether the package goes public": strike it through and mark it
  **Resolved 2026-10-14**: public as `HireAnEsquire/speepobox`, seeded from this tree; the private
  repo is the archive. Do the same at `09-post-move-sequence.md`'s "stays private" passage (around
  `:739-741`): keep the text, and add one sentence saying it was reversed on that date.
- `MAP.md`'s two links to `../../../.agentbox/ROADMAP.md` (around `:131` and `:521`) point at a
  file T137 deleted. Make them plain text naming the path and
  `6f66e9ac891462de809d207822c77d8f27615663`, as T141 did for SPEC §12.

## Effect wiring

- **Tags introduced or consumed**: none. A constant, a template, docs, and tests.
- **Layer composition**: unchanged.

## Acceptance criteria

- [ ] Outside `docs/` and `test/fixtures/shim/`, no tracked file contains `HireAnEsquire/bessemer`.
- [ ] `test/fixtures/shim/bessemer.v3` is byte-identical to `templates/bessemer` at this ticket's
      base, and `TEMPLATE_VERSIONS.bessemer` is 4.
- [ ] `LICENSE` holds the MIT text, and `package.json` says `"license": "MIT"`.
- [ ] The README names the repository public, keeps `gh auth login` with its new reason, and ends
      with a License section.
- [ ] `CONTEXT.md`'s *Repositories and roles* has a `speepobox` entry saying both meanings.
- [ ] MAP's public-repo item and 09's passage are marked resolved; MAP has no link to
      `.agentbox/ROADMAP.md`.

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package.

Also inside the container. Each prints nothing when done:

```
git grep -n "HireAnEsquire/bessemer" -- . ':!docs' ':!test/fixtures/shim'
```

```
git diff --quiet "$(git merge-base HEAD origin/main)":templates/bessemer HEAD:test/fixtures/shim/bessemer.v3 || echo "bessemer.v3 is not the old template"
```

Host-only, after merge, in this order (the operator's steps, not the agent's):

1. Cut the seed: export this tree without the T140 manifest's ten drops, and without the untracked
   runtime state (`.bessemer/.env`, `runs.jsonl`, `logs/`, `locks/`, `checkouts/`).
2. Scan the seed for secrets (`gitleaks dir` or equivalent) before the first push.
3. Create `HireAnEsquire/speepobox` empty and public, commit the seed as one commit, push.
4. Settings: protect `main` with the admin bypass, require `verify`, require approval for CI on
   fork PRs, install CodeRabbit if wanted.
5. Tag the first release once its CI is green on `main`, then run `doctor`'s `upstream` row against
   it.
6. hae: re-pin #4625 to that release with `upgrade`, so hae's shim is rewritten at template version
   4 and names `speepobox`.
