# T114 — `init` writes the scaffold

Status: Done (PR #75. `wx` backs the absence check, so a file appearing in between is `kept`. A write failing partway leaves a partial scaffold, which a rerun completes.)
Type: AFK
Blocked by: [T113](T113-the-templates-and-their-stamps.md) — the templates, the stamper, and config substitution.

<!--
P5, ruled 2026-09-30 (09's comment of that date, E2, E3, E4, E9). **Expand-first**: `--base` and
`--image` are required in this ticket, which T115 relaxes by working them out. They are parsed as
**optional** and refused by a guard (AGENTS.md, *A required flag whose absence must be a typed
refusal is parsed as optional*, T3), so T115 changes a guard, never the parser.
-->

## What to build

`bessemer init` writes the scaffold into the served repo. It is the command an adopter runs once,
and again whenever a later version adds a template.

**Where it sits.** It is intercepted in `bin.ts`'s switch beside `status`, `doctor`, and `gc`,
before any preflight, because there is no config to decode yet (E9). It parses its own words in
`src/init/argv.ts`, as `gc` does (`gc/argv.ts`), because nothing that owes an assertion stays in
`bin.ts`. Its words are:
- `--base <ref>`
- `--image <tag>`

Anything else is refused with the usage line. `--dry-run` is refused like any other unknown word.
`--diff` is T116's, and until then it is unknown too. `--force` does not exist and is refused.

**What it refuses**, as typed refusals printed on one line and exiting 1, before writing anything:
- a **self-hosted** repo (`selfHosted`, decided once in `bin.ts` and passed down, 19 §4). This
  repo is not scaffolded; T116's `--diff` is allowed here, but `init` is not;
- a missing `--base` or `--image`. The refusal names the flag, and in this ticket it is the guard
  T115 relaxes.

**What it writes** (E2), under `<repoRoot>/.bessemer/`:

| File | From |
| --- | --- |
| `config.toml` | `templates/config.toml`, substituted (`{{base}}`, `{{image}}`, `{{tool-sha}}` — this ticket writes `tool-sha = ""`; T115 fills it) |
| `.gitignore` | `templates/.gitignore`, stamped |
| `image/Dockerfile` | `templates/image/Dockerfile`, stamped |
| `image/inputs` | `templates/image/inputs`, stamped |
| `tasks/.gitkeep` | empty; makes `.bessemer/tasks/`, which the config's `tasks-dir` names, so probe 8 is green |

**Only absent files are written** (E4). A file that already exists is never opened for writing and
is reported as `kept`. Every other file is reported as `wrote`. There is no `--force`: an adopter
refreshes a file by deleting it and running `init` again, and T116's `--diff` prints that
command. Running `init` twice in a row is a no-op that reports five `kept` lines. A directory
standing where a file should be is a refusal that names the path, not a `kept`.

It writes **no** setup hook, sandbox env file, prompt file, or shim (E3). The config names the
first two only in comments.

**The report** is a `Reporter` event carrying a snapshot, rendered by `src/init/render.ts` in the
same shape as `GcReported`: one `wrote` or `kept` line per file, then the **next steps**, printed
and never run:
1. put the adopter's own stack's base image in `.bessemer/image/Dockerfile`;
2. run `bessemer image build`;
3. put the credential in `.bessemer/.env`;
4. run `bessemer doctor`;
5. commit `.bessemer/`.

**Templates** are read from `templatesRoot`, defined in `src/config/paths.ts` as `join(packageRoot,
"templates")` and passed down from `bin.ts` as a parameter. No new file imports `packageRoot`.
Amend SPEC §9's ban paragraph so that `paths.ts`'s parenthetical names the templates root beside
the freshness pathspec.

Files are written through `FileSystem`, which SPEC §2 uses directly and wraps in nothing.

## Effect wiring

- **Tags introduced or consumed**: `Reporter`, `FileSystem`, `Path`. `Git` is not used yet (T115).
  No new tag.
- **Layer composition**: `app.ts` is unchanged. `init` takes the read-only slice, whose config
  layer is the tolerant one, so an adopter's absent or broken `config.toml` cannot stop the command
  that writes it:

  ```ts
  case "init":
    return init({ repoRoot, argv: argv.slice(1), selfHosted, templatesRoot }).pipe(
      Effect.provide(appBaseLiveFor(repoRoot, stdinIsTTY)),
      Effect.catchAll(reportFailure),
    );
  ```

  Put the resulting `bin.ts` case in the PR description.

## Acceptance criteria

- [ ] In an empty temporary served repo, `init --base origin/main --image acme-bessemer` writes
      all five files. `config.toml` has no `{{` left in it. The three stamped files carry a
      stamp `readStamp` accepts, whose digest equals their `bodyDigest`.
- [ ] Running it a second time writes nothing and reports five `kept` lines.
- [ ] With an existing `.bessemer/config.toml` that holds other content, that file is byte-identical
      afterwards, and the other four are written.
- [ ] A missing `--base` or `--image` refuses, naming the flag, and writes nothing.
- [ ] A self-hosted invocation refuses and writes nothing.
- [ ] `--force`, `--dry-run`, and an unknown word are each refused with the usage line.
- [ ] `status`, `doctor`, `gc`, and the dispatch surface behave exactly as before.

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package.
