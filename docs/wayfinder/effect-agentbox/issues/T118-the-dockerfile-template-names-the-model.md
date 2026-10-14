# T118 — The Dockerfile template names the model

Status: Done (PR #80. The premise below is wrong: the dispatcher also passes `sandbox-env-file` as `docker run --env-file` (T61), so the image is not the only home for the model. Caught in review; the template names both homes, and the env file wins when both are set. This repo's image reads stale until one host rebuild.)
Type: AFK
Blocked by: None — can start immediately.

<!--
Surfaced by T117's host run (2026-09-30): a freshly scaffolded repo's passes all ran on the agent
CLI's default model, and nothing an adopter is shown says the model is theirs to choose. Terms:
**scaffold**, **template**, **stamp**, **drift** (CONTEXT.md).
-->

## What to build

The Dockerfile template tells an adopter which model the agent passes run on, and where to change
it.

The dispatcher forwards only the credential into the container (`sandbox/spec.ts`), so the image's
`ENV` is the one place a model is chosen. This repo's own `.bessemer/image/Dockerfile` already does
it (`ENV ANTHROPIC_MODEL=…`). The template says nothing, so a scaffolded repo runs whatever the CLI
defaults to. On T117's run that was `claude-sonnet-5`, and the adopter was never told.

### The template

Add a short block to `templates/image/Dockerfile`, after the CLI install and before the
`ENTRYPOINT`, written in the template's register:

- It says the passes run on the CLI's default model unless this line is set, and that the
  dispatcher forwards no model variable, so the image is where the choice lives.
- It carries the line **commented out**: `# ENV ANTHROPIC_MODEL=<model id>`. Nothing is set by
  default. A model ID baked in as a live value goes stale with every release, and on every
  adopter's image at once. Choosing the model is the adopter's decision, as the base image is.
- It says a change needs a rebuild through `bessemer image build`, as the pin comment above it
  already does.

### The stamp

The template's text changes, so **bump `image/Dockerfile` to version 2** in `TEMPLATE_VERSIONS`
(T113's rule: bump whenever the template's text changes). An adopter's v1 file then reads
`behind` under `init --diff`. That is the point: the adopter is shown the new lines.

### This repo's own Dockerfile

T112 stamped `.bessemer/image/Dockerfile` by hand with the template's name, version, and digest.
`test/init-stamp.test.ts` asserts that stamp equals the template's current one. Restamp the first
line with v2 and the new template's body digest, and leave the rest of this repo's file alone. It
already sets `ANTHROPIC_MODEL`. It must still read `current, edited`, never `pristine`.

Restamping changes the file's text, and the file is an image input, so this repo's image reads
stale once, until a host rebuild. That is expected, and it is host-only (see Verify).

## Effect wiring

- **Tags introduced or consumed**: none. This changes a template, a version constant, and one
  stamp line.
- **Layer composition**: unchanged.

## Acceptance criteria

- [ ] `templates/image/Dockerfile` carries the commented `ANTHROPIC_MODEL` line and its
      explanation, and sets no model.
- [ ] `TEMPLATE_VERSIONS["image/Dockerfile"]` is `2`.
- [ ] This repo's `.bessemer/image/Dockerfile` carries the v2 stamp with the new template's
      digest. `node src/bin.ts init --diff` from the repo root reports it `current, edited`,
      reports `No drift.`, and exits 0.
- [ ] A test pins that a v1-stamped Dockerfile reads `behind` against the v2 template. This is
      the upgrade an existing adopter will see.

## Verify

```
npm run verify
```

Run from the repo root. This is the gate: typecheck (with Effect diagnostics: **errors and
warnings break the build**, suggestions print), lint, and tests. `pre-commit` is not a substitute
and does not check this package.

```
node src/bin.ts init --diff
```

Run from the repo root. It exits 0, and all three stamped files read `current, edited`.

Host-only, run by the operator at merge:

- `node src/bin.ts image build`, then `node src/bin.ts doctor`. Probe 2 reads current again.
