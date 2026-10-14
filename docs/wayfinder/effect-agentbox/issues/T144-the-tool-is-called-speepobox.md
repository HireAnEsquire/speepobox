# T144 — The tool is called speepobox

Status: Done (PR #2. Every name the tool writes, reads back or prints says `speepobox`; shims `bessemer.v2`/`v3` retired and the shim template is `speepobox` v5; history docs frozen, MAP carries the dated line. One mention site beyond the list: `test/init.test.ts`'s `RETIRED_NAME`, which rebuilds the older template texts. Host steps (clear old containers, move runtime state, rebuild, tag v4, re-pin hae) follow.)
Type: AFK
Blocked by:

<!--
Ruled 2026-10-14: the tool takes the repository's name, `speepobox`. T63 renamed the package from
`speepobox` to `bessemer`, and T65 moved the mechanism vocabulary (labels, prefixes, the config tag)
to `bessemer` with it. This ticket moves both back, as one break.

Why now: the only adopter is hae, on a draft PR that has not merged, and the public `v3` release has
no adopter. After hae merges, a rename owes every adopter a migration. So this is a clean break: no
fallback reads the old directory, and no shim from before this ticket runs a release from after it.

AFK where T63 was HITL, because the docs that record history are frozen here (see below), not swept.
T63's cost was telling a use of a name from a mention of it across the closed tickets. The living
documents this ticket sweeps have almost no mentions, and the ones they have are listed.
-->

## What to build

**Every name the tool declares, writes, reads back, or prints says `speepobox`. The writer and the
reader of each name change in the same commit. The documents that record history keep the name they
were written under.**

### Group 1 — names read back by something outside the process

Each of these is written in one place and read in another. Change both together.

- **The directory.** `.bessemer/` becomes `.speepobox/`: `BESSEMER_DIRNAME` in `src/config/paths.ts`
  and everything that spells the path.
- **The shim.** `templates/bessemer` becomes `templates/speepobox`, written at `.speepobox/speepobox`.
  Its comments, its config path (`$repo/.speepobox/config.toml`), every refusal that names the path,
  and its cache root (`$cache/speepobox`) change. `RELEASE_URL` already names speepobox and does not
  change.
- **The template stamp.** `# bessemer-template:` becomes `# speepobox-template:` (`src/init/stamp.ts`
  and every stamped template).
- **The labels.** `bessemer.managed`, `bessemer.repo`, `bessemer.inputs` and `bessemer.inputs.digest`
  become `speepobox.*`, writer and reader together, and the ban message in `scripts/check-bans.ts`.
- **The container prefix.** `CONTAINER_PREFIX` becomes `speepobox-`.
- **The config environment prefix.** `ConfigProvider.nested("bessemer")` becomes `"speepobox"`, so the
  variables are `SPEEPOBOX_*`.
- **The image name default.** The suffix in `src/init/values.ts` becomes `speepobox` (`my-app-speepobox`).
- **The live tier markers.** `BESSEMER_LIVE` and `BESSEMER_LIVE_IMAGE` become `SPEEPOBOX_LIVE` and
  `SPEEPOBOX_LIVE_IMAGE`, in `test/live/live.ts` and `vitest.live.config.ts`. The live image default
  becomes `speepobox`.

### Group 2 — names inside the package

- `package.json`: `name` becomes `@hireanesquire/speepobox` and `bin` becomes `speepobox`. Then run
  `npm install --package-lock-only` and confirm `npm ci` is clean.
- `src/dispatch/command.ts`: the command name and `executable`.
- Every usage string (`GC_USAGE`, `IMAGE_USAGE`, `INIT_USAGE`, the `bin.ts` usage block) and every
  printed string: the plan header, the run log's start line, `PR_TITLE_PREFIX` (`[speepobox] `), the PR
  body, the notification title, the lock's `LockHeld` details, the `gc` header, `init`'s next steps and
  refusals, the ledger's decode message, and `FALLBACK_EMAIL` (`speepobox@users.noreply.github.com`).
- Identifiers: `BessemerConfig` (the tag and its string key), `BessemerConfigShape`,
  `bessemerConfigLiveFor`, `bessemerConfigTolerantLiveFor`, `bessemerDir`, `BESSEMER_DIRNAME`, and every
  other identifier with `bessemer` in it, in any case.
- Comments in `src/`, `test/` and `scripts/` that use the name.
- Test fixtures and expectations: branch names, paths, labels, env names. Let the suite say what
  was pinned.

### The shim templates and the clean break

A released shim from before this ticket reads `.bessemer/config.toml`, and this package reads
`.speepobox/`. It cannot run a release from after this ticket, and nothing is added to make it.

- Remove `test/fixtures/shim/bessemer.v2` and `bessemer.v3` from the tree, with every reference to
  them, so the contract test runs the current template only.
- Rewrite `test/fixtures/shim/README.md`. Keep the rule (copy a released template here before
  bumping it). Add one paragraph: T144 renamed the tool as one break, so the shims named `bessemer`
  were retired. They ran only against releases named `bessemer`, and those releases are unchanged.
- In `TEMPLATE_VERSIONS`, the shim's key becomes `speepobox` at version 5. Bump every other template
  whose text changes. Do not freeze version 4: no adopter ever ran it.
- Update the rule's comments in `src/init/stamp.ts` to name `test/fixtures/shim/` and
  `.speepobox/speepobox`.

### This repository's own tracked files

- `git mv .bessemer .speepobox`. That moves `.gitignore`, `config.toml`, `env.sandbox`, `image/` and
  `prompts/`. **Do not change `env.sandbox`'s contents.**
- In `.speepobox/config.toml`, `image = "bessemer"` becomes `image = "speepobox"`, and its comments
  name the new paths.
- `.speepobox/image/inputs`, the Dockerfile and the prompts: sweep their comments.
- The root `.gitignore`'s comment about the credential's path.
- `.github/workflows/ci.yml`, if it names the tool.

### The living documents — swept

Sweep these as uses: `README.md`, `AGENTS.md`, `CONTEXT.md`, `docs/wayfinder/effect-agentbox/SPEC.md`,
`docs/agents/*.md`, `docs/wayfinder/effect-agentbox/issues/TEMPLATE.md`, `prompts/*.md`, and
`templates/*`. Capitalized `Bessemer` in prose becomes `Speepobox`.

Particular edits:

- `README.md`: remove the sentence "The repository is `speepobox`; the tool it ships is `bessemer`."
  Every command is spelled `.speepobox/speepobox …`.
- `CONTEXT.md`: the title is `# Speepobox`. Replace the `speepobox` entry with this meaning: the name
  of the tool and of this repository (`HireAnEsquire/speepobox`). The tool was called `speepobox` until
  T63, `bessemer` from T63 to T144, and `speepobox` again from T144. In `docs/`, a ticket or decision
  doc uses the name that was current when it was written. Add a `bessemer` entry: the tool's name from
  T63 to T144; _Avoid_ it as a name for the tool.
- `AGENTS.md`: the title is `# Working in speepobox`. Every rule's citations stay as they are.

**The mention sites** — keep the old spelling, because the sentence is about the name:

- a link to, or a citation of, a file whose name contains `bessemer` (for example
  `T65-the-mechanism-vocabulary-is-bessemer.md`, or `test/fixtures/shim/` history in the README you
  write above);
- the new `bessemer` entry in `CONTEXT.md` and the history sentence in the `speepobox` entry;
- `AGENTS.md`'s and `SPEC.md`'s note about the private archive repository, if it names it.

### The history documents — frozen

Do not edit any other file under `docs/`: the decision docs, `MAP.md`, the research, `docs/adr/`,
and every ticket under `issues/` other than `TEMPLATE.md` and this one. They record what was true
when they were written, under the name used then. The one exception is a single dated line in
`MAP.md`'s Status log: on 2026-10-14 the tool took the name `speepobox` (T144). Code, tests and
the living documents were swept, and the history documents were not.

## Effect wiring

- **Tags introduced or consumed**: none. `BessemerConfig` is renamed `SpeepoboxConfig`, key
  included. That is the same tag under a new name, not a new tag.
- **Layer composition**: unchanged except for that rename. Put the resulting `app.ts` composition in
  the PR description.

## Acceptance criteria

- [ ] `git grep -n -i bessemer` (case-insensitive) outside `docs/` returns only the mention sites
      above, and the PR description lists every hit.
- [ ] Under `docs/`, only `MAP.md` (one line), `issues/TEMPLATE.md`, `SPEC.md`, `docs/agents/`, and
      this ticket changed.
- [ ] No tracked path contains `bessemer`, except files under `docs/` that are frozen.
- [ ] `package.json`'s `bin` is `speepobox`, the lockfile agrees, and `node src/bin.ts` with no
      arguments prints a usage block that says `speepobox`.
- [ ] `TEMPLATE_VERSIONS` has a `speepobox` key at 5, and `test/fixtures/shim/` holds no `bessemer.*`.
- [ ] `.speepobox/env.sandbox` is byte-identical to the old `.bessemer/env.sandbox`.
- [ ] `npm run verify` passes, and `node src/bin.ts doctor` runs under plain node.

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package.

Also inside the container. Each prints only the mention sites:

```
git grep -n -i bessemer -- . ':!docs'
```

```
git ls-files | grep -i bessemer | grep -v '^docs/'
```

And prints nothing:

```
git diff --quiet "$(git merge-base HEAD origin/main)":.bessemer/env.sandbox HEAD:.speepobox/env.sandbox || echo "env.sandbox changed"
```

Host-only, after merge (the operator's steps, not the agent's): clear this host's old-labelled
containers and checkouts with the old code before pulling, move the untracked runtime state from
`.bessemer/` into `.speepobox/` by hand, rebuild the image, tag `v4` once CI is green, then re-pin hae.
