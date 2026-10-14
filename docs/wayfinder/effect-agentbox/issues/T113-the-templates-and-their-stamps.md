# T113 — The templates and their stamps

Status: Done (PR #72. The ticket says four placeholders; it names three, and the code has those three. `templates/` joined the dispatcher-freshness source set beside `prompts/`, since `init` reads it.)
Type: AFK
Blocked by: None — can start immediately.

<!--
P5, ruled 2026-09-30 (09's comment of that date, E1, E2, E5, E7, E8, E11). Terms: **scaffold**,
**template**, **drift** (CONTEXT.md). Nothing here writes into a served repo — that is T114.
-->

## What to build

The package ships the four templates `init` writes from, and a pure module that stamps them and
reads their stamps back.

### `templates/` at the package root

This sits beside `prompts/`, and it is a read location inside the package. Nothing in `src/`
reaches it through `packageRoot` except by a path handed in (SPEC §9's ban). Each template is
**versioned** by an integer declared in one place in the module below. Bump it whenever the
template's text changes.

- **`config.toml`**: the committed layer for an adopter.
  - Values it sets: `image = "{{image}}"`, `base = "{{base}}"`, `tool-sha = "{{tool-sha}}"`,
    `tasks-dir = ".bessemer/tasks"`, and `image-build-command = "bessemer image build"`.
  - Keys that appear only as comments: `setup-hook`, `sandbox-env-file`, and `cap-add`. A hook
    that is not declared is no step at all (T7), while a stub hook is a step that does nothing.
  - Every key carries a short comment in this repo's `.bessemer/config.toml` register, explaining
    what the key is. It explains nothing about this repo.
  - Those four placeholders are the whole set. Substitution replaces each exact `{{name}}` and
    fails on any other `{{…}}` it finds. It is not a templating language: no conditionals, no
    loops (05 Q9 rejected one for prompts; this is the named-set exception E7 allows the config).
  - It carries **no stamp** (E5), because it is the one substituted file.
- **`.gitignore`**: ignores entries **by name**, matching this repo's `.bessemer/.gitignore`:
  `config.local.toml`, `.env`, `logs/`, `locks/`, `checkouts/`, and `runs.jsonl`. It has one
  anchored pattern, `/*-edit-*/`, for the editor's session directories (T84, T108). It must never
  ignore `tasks/` or anything under it, and never `env.sandbox`. This meets MAP's 2026-08-20
  ruling that issue folders stay tracked.
- **`image/Dockerfile`**: generic, for a stack this package knows nothing about. It declares:
  - `ARG BASE_IMAGE=debian:bookworm-slim`, with a comment telling the adopter to replace it with
    their own stack's image;
  - the `git` install;
  - `ARG CLAUDE_CODE_VERSION=2.1.282`, installed with the **native installer**
    (`curl -fsSL https://claude.ai/install.sh | bash -s "$CLAUDE_CODE_VERSION"`), running as the
    agent user so it lands in `~/.local/bin`, which the template puts on `PATH` with
    `ENV PATH="/home/agent/.local/bin:$PATH"` as this repo's Dockerfile does, because
    `docker exec` reads the image's `PATH` and never a login shell's. No node is required (04). `2.1.282` is
    the version this repo's image runs today, which the stream parser is proven against (E11).
    The installer needs `curl` and CA certificates, so install them too;
  - the non-root `agent` user from `ARG AGENT_UID` / `AGENT_GID`, which T111 passes in;
  - `ENTRYPOINT ["sleep", "infinity"]`.

  It installs no sudo and needs no capability. Model the comments on this repo's `image/Dockerfile`
  but keep hae out of them. This file is the adopter's from the moment it is written.
- **`image/inputs`**: comments only, explaining the format (T110): one exact repo-relative path per
  line, no globs, and the Dockerfile is implicit. Name, as the example, the dependency manifest a
  repo would add if its image bakes one in.

### Stamps: `src/init/stamp.ts` (pure)

- **Format**: one whole line, `# bessemer-template: <name> v<N> sha256:<12 hex>`. `<name>` is the
  template's path under `templates/`. The digest is the first 12 hex characters of sha256 over
  the template's text with the stamp line removed. Stamped files are never substituted, so this
  equals the text as written.
- **`stamp(name, version, text)`** puts the stamp line **after** any leading lines that must stay
  first. A Dockerfile parser directive (`# syntax=`, `# escape=`, `# check=`) is only honoured
  before the first comment, and a shebang must be line 1. Otherwise the stamp goes on line 1.
- **`readStamp(text)`** returns `Option<{ name, version, digest }>`, found **on any line**, and
  returns none when there is none. It also yields `bodyDigest(text)`, the digest of the text with
  its stamp line removed, so a caller can tell a pristine file from an edited one (T116).
- The stamp is an ordinary `#` comment in all three stamped files: `.gitignore`, the Dockerfile,
  and `inputs`. `parseInputsList` already skips it (T110).

### The tracked-issues pin

A test scaffolds the rendered `.gitignore` into a throwaway `git init` repo at `.bessemer/.gitignore`.
It asserts with real `git check-ignore` that:
- `.bessemer/tasks/some-feature/issues/T1-x.md`, `.bessemer/tasks/spec.md`, and
  `.bessemer/env.sandbox` are **not** ignored;
- `.bessemer/feedback-edit-123-abc/f.txt`, `.bessemer/.env`, and `.bessemer/logs/x.log` **are**
  ignored.

This is a construction rule's test, not a runtime check.

## Effect wiring

- **Tags introduced or consumed**: none. The stamp module is pure, and the templates are files.
- **Layer composition**: unchanged.

## Acceptance criteria

- [ ] `templates/` holds the four files above, and the three stamped ones carry no stamp in the
      package. A stamp is written on the way out (T114).
- [ ] `stamp` then `readStamp` round-trips name, version, and digest. `bodyDigest` of a freshly
      stamped template equals its stamp digest, and it differs after any edit to the body.
- [ ] A Dockerfile opening with `# syntax=docker/dockerfile:1` keeps that line first, with the
      stamp after it.
- [ ] Substituting the config template with all four values leaves no `{{`. Substituting it
      with any value missing fails, as does a template holding an unknown placeholder.
- [ ] The `git check-ignore` test above passes against real git.
- [ ] Every template version is declared in one place and read by both the stamper and the test.

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package.

Host-only, and not a gate for this ticket (T117 owns it): the Dockerfile template is proven fit only
by building it, and it installs the CLI from the network.
