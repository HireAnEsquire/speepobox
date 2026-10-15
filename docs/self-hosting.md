# Using speepobox on its own repo

This is for working on speepobox itself: dispatching agents into this repository. If you are
adopting speepobox in your own repo, read the [README](../README.md) instead.

## What self-hosted means

A dispatch is **self-hosted** when the repo it serves is the repo speepobox's own source lives in.
speepobox decides this once, at startup, by comparing the served repo (`--repo-root`) with the repo
around its own package. `doctor` and every dispatch read that one answer.

## How you run it

From the root of your checkout:

```sh
node src/bin.ts <command> …
```

There is no shim and no pin. `.speepobox/config.toml` has no `tool-sha`, and the code that runs is
whatever your working tree holds. **The checked-out branch is the dispatcher.**

A dispatch looks like this:

```sh
git branch --no-track <branch> origin/main
node src/bin.ts docs/wayfinder/effect-agentbox/issues/<ticket> --branch <branch>
```

Every command in the README works the same way here, with `node src/bin.ts` in place of
`.speepobox/speepobox`.

## The stale-dispatcher check

Because your working tree is the dispatcher, a dispatch from an old checkout would run old code
against a newer base. So a self-hosted dispatch first asks git which commits the base has that your
`HEAD` lacks, counting only the package's own files (`src`, `prompts`, `templates`, `scripts`,
`package.json`, `package-lock.json`, `tsconfig.json`). If there are any, the dispatch is refused
before anything is acquired, and the refusal names the commits.

The usual fix is to pull `main`. `--allow-stale-dispatcher` runs the dispatch anyway; it prints a
warning and the run's ledger row records the override. `doctor`'s probe 10 asks the same question.

An adopter's dispatch never runs this check: its dispatcher is a pinned release, so there is nothing
to be stale against.

## Commands that do not apply

- `init` refuses: this repo is not scaffolded. `init --refresh` refuses the same way.
- `upgrade` refuses: there is no pin to move.
- `init --diff` works. It lists the shim as missing without counting it as drift, and for a behind
  file it says to bring it up to date by hand from `templates/`.
- `doctor`'s `upstream` row reads `not applicable — self-hosted`.

## This repo's `.speepobox/`

The same directory an adopter has, written by hand rather than by `init`:

- `config.toml` (committed): image `speepobox`, base `origin/main`, `image-build-command = "node
  src/bin.ts image build"`, setup hook `setup-hook.sh` at the repo root, and sandbox env file
  `.speepobox/env.sandbox`.
- `image/Dockerfile` and `image/inputs` (committed): what `node src/bin.ts image build` builds.
- `prompts/project-context.md` (committed): appended to every pass's prompt.
- `.env` (ignored): the agent credential, `CLAUDE_CODE_OAUTH_TOKEN`. Put it there by hand.
- `checkouts/`, `locks/`, `logs/`, `runs.jsonl` (ignored): runtime state.

## While a dispatch is running

The code is safe: node loads all of `src/` once, at startup, so a pull mid-run does not change the
running dispatcher. Three things in the working tree are read later, and those you must leave alone
until the run ends:

- **Prompts.** Each pass reads its prompt from disk when it starts. Here both prompt roots are in
  your working tree: the package defaults in `prompts/` and the override in
  `.speepobox/prompts/`. An edit, pull, or checkout that changes them changes what the next review
  round or the description pass is told. A checkout of a branch that lacks a package prompt crashes
  the next pass.
- **The spec file.** A one-off spec, such as a ticket under `docs/wayfinder/effect-agentbox/issues/`,
  is mounted into the container from your working tree. A checkout or pull that changes the file
  makes it vanish inside the container, because git replaces the file rather than writing into it;
  every later pass then finds no spec. An edit saved in place reaches the agent instead. Leave it
  alone mid-run. (Measured on Docker Desktop for Mac, 2026-10-15.)
- **The dispatch's branch.** Never check it out. At the end the run fetches its commits into that
  branch, and git refuses to fetch into a checked-out branch, so the land fails and the commits go to
  a rescue branch `<branch>-from-run-<sha>`.

The setup hook and `env.sandbox` are read once, when the container starts.

The simple rule that covers all of it: **no checkout, switch, or pull in the main tree, and no prompt
edits, while a dispatch is running.**

## Releasing

A release is a `v<N>` tag on `main`:

```sh
git tag -a v<N> origin/main -m "v<N>: <what changed>"
git push origin v<N>
```

Adopters pick it up with `.speepobox/speepobox upgrade`, then `init --diff` and `init --refresh`.

## Tests

- `npm run verify`: the gate. Typecheck, lint, and tests.
- `npm run verify:live`: the live tier under `test/live/`, run on your host against a real docker
  daemon. The agent writing code has no docker socket, so only you can run it.
