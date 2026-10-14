# T111 — `bessemer image build`

Status: Done (PR #76. A failed build's error carries docker's whole stderr, which the console has already streamed, so the refusal repeats it on one line. Not yet run against a real dockerd: T117's host check covers a real build and probe 2 reading it.)
Type: AFK
Blocked by: [T110](T110-the-image-inputs-list-is-a-value.md) — the list parser and the one digest recipe this build stamps with.

<!--
P5, ruled 2026-09-30 (09's comment of that date, E10). **Adds a method to an existing tag**
(`Sandbox.build`): capability goes inside a tag, and a new one is an issue-level decision
(AGENTS.md, *Naming*). The PR description must say so. SPEC §2's `Sandbox` row already names it.
-->

## What to build

The package builds the served repo's agent image itself, so every adopter's image carries
labels made by the same recipe that probe 2 checks. Today each repo keeps its own bash copy
(`image/build-image.sh` plus `image-inputs.sh`), and any change to the recipe would leave every
adopter reporting a stale image permanently.

**`bessemer image build`** (SPEC §7):

- It is a subcommand on the **dispatch surface**. It reads `image` from `BessemerConfig`, so a
  config that does not decode stops it at layer build, as it stops a dispatch. It does **not**
  join the `status`/`doctor`/`gc`/`init` intercepts.
- Its words are `image build` and nothing else. `--dry-run` is refused as an unknown flag here.
  A rehearsal of a build has nothing to show that the command line does not already say.
- It reads `<repoRoot>/.bessemer/image/inputs` and parses it with `parseInputsList(text,
  ".bessemer/image/Dockerfile")` (T110). A missing list file means an empty list, so the
  Dockerfile is the only input. A refusal from the parser becomes a typed refusal of the build
  and is printed on one line.
- **Every input must exist.** A missing one is refused here and nowhere else, just as
  `build-image.sh` refuses today. Downstream, probe 2 reads the same absence as a change.
- It computes the digest with `inputsDigest` (T110), the same function probe 2 recomputes with.
- It calls `Sandbox.build` with:
  - the tag: config's `image`;
  - the context: `<repoRoot>/.bessemer/image`. Never the repo root, which holds `checkouts/`,
    the clones of other runs;
  - the Dockerfile: `<repoRoot>/.bessemer/image/Dockerfile`;
  - build args `AGENT_UID` / `AGENT_GID`;
  - labels `bessemer.inputs=<paths joined by ",">` and `bessemer.inputs.digest=<digest>`.
- **The uid and gid are host reads**, so they are made in `bin.ts` (`process.getuid()` /
  `process.getgid()`) and passed in as parameters (AGENTS.md, *Host reads live at the
  composition root*).
- The build's output streams to the console through `Reporter` as it arrives. A failed build is
  a typed `SandboxError` carrying docker's stderr, and the command exits 1.

**`Sandbox.build`**: a new method on `SandboxShape`, which runs `docker build` through the exec
chokepoint and awaits it in the foreground, like `exec`. Its output reaches the console through
an `onOutput` callback on the spec, the shape `exec`'s spec already has, and the command's
callback emits the `Reporter` event. The layer never captures `Reporter`: a reporter captured at
layer build is the shape AGENTS.md rules out for `AgentCli`, for the same reason. Its spec type uses our own vocabulary,
not docker flags: tag, context, dockerfile, build args, and labels. The Docker layer renders the
argv. `SandboxRecordingLive` records it as a mutation and returns without building. That does
not bring back a rehearsal of `image build`, which still refuses `--dry-run`. It is there
because the recording layer has to implement the whole tag.

A repo whose image needs more than this builds its own prerequisites and then calls this command.
An adopter whose base image is compose-built would use
`docker compose build <service> && bessemer image build`. That wrapper is what its
`image-build-command` names.

## Effect wiring

- **Tags introduced or consumed**: `Sandbox` (consumed, **one method added**: `build`),
  `BessemerConfig` (consumed), `Reporter` (consumed).
- **Layer composition**: `app.ts` is unchanged. The new case in `bin.ts`'s switch is
  provided the one `appLiveFor`, exactly as the dispatch surface is:

  ```ts
  case "image":
    return imageBuild({ repoRoot, argv: argv.slice(1), uid, gid }).pipe(
      Effect.provide(appLiveFor(repoRoot, stdinIsTTY)),
      Effect.catchAll(reportFailure),
    );
  ```

  `uid` and `gid` are read in `bin.ts` beside the other host reads. Put the resulting `bin.ts`
  case in the PR description.

## Acceptance criteria

- [ ] Against a fake `Sandbox`, `image build` passes the config's image as the tag,
      `.bessemer/image` as the context, the uid and gid it was given, and both labels. The
      digest label must equal what `inputsDigest` returns for the same tree.
- [ ] The inputs label lists the Dockerfile first, then the list file's paths in order.
- [ ] A declared input that does not exist refuses the build before `Sandbox.build` is called,
      and the refusal names the path.
- [ ] A glob in the list file refuses with the line named.
- [ ] `image build --dry-run` and any other word after `build` are refused.
- [ ] The Docker layer's argv for `build` is asserted as a unit test, the way `run`'s is.
- [ ] `SandboxRecordingLive.build` records a mutation and spawns nothing.
- [ ] `image build` appears in `bin.ts`'s usage text.

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package.
