# T112 — This repo builds its image through `image build`

Status: Done (PR #77. The Dockerfile's path moved, and it is hashed into the input digest, so the existing image reads stale until one host rebuild: `node src/bin.ts image build`, then `doctor` probe 2 current and `claude --version` 2.1.282 in the image. `init --diff` on this repo reads all three stamped files `current, edited`.)
Type: AFK
Blocked by: [T111](T111-bessemer-image-build.md) — the command this repo switches to; [T113](T113-the-templates-and-their-stamps.md) — the template version, digest, and CLI pin this repo's files are stamped with.

<!--
P5, ruled 2026-09-30 (09's comment of that date, E12). This **retires** T40's self-hosted layout:
T40 put `image/` at the repo root only because 18 might move the package and `.bessemer/` did not
exist yet, and neither holds now. AFK with a host-only Verify, as T105–T109 are.
-->

## What to build

This repo's image moves onto the scaffold layout and the package's own build, so it keeps no bash
copy of the digest recipe and becomes the first repo `init --diff` can say something real about.

1. **Move** `image/Dockerfile` to `.bessemer/image/Dockerfile`, keeping its content: the node base,
   and the comments, updated wherever they name paths. Then **pin the CLI** by replacing
   `npm install -g @anthropic-ai/claude-code` with the template's pin: the same
   `ARG CLAUDE_CODE_VERSION` value and install line that T113's Dockerfile template uses. Rewrite
   the "Unpinned, and a known hole" comment to say the pin now matches the template's.
2. **Add** `.bessemer/image/inputs` with no paths, only the template's comments. The Dockerfile is
   implicit (T110), and this image bakes in no dependency manifest, for the reason
   `image/image-inputs.sh` gives today. Carry that reason over into the new file's comment.
3. **Stamp** both files, and `.bessemer/.gitignore` as well, **by hand** with the *template's* stamp (T113). Use its name and current
   version, and **its** digest, never a digest of this repo's text. This repo's Dockerfile then
   reads as *edited, current*, and so does `.gitignore`, whose comments are this repo's. It must never read as *pristine*, which `--diff` would report as
   safe to replace, and replacing it with the template would lose the node base (E5).
4. **Delete** `image/build-image.sh`, `image/image-inputs.sh`, and the `image/` directory.
5. **Config**: set `.bessemer/config.toml`'s `image-build-command` to
   `node src/bin.ts image build`, and rewrite its comments. The "must match `image/build-image.sh`'s
   own fallback" sentence goes, and the reason `.agentbox/build-image.sh` is not named stays.
6. **Every other reference**, all found with
   `git grep -n "build-image\|image-inputs\|image/Dockerfile" -- ':!.agentbox' ':!docs'`:
   - `test/config.test.ts:397` asserts the bash script contains `${BESSEMER_IMAGE:-<image>}`.
     Delete that case. The tag now comes from config, so no second spelling is left to agree
     with.
   - `setup-hook.sh:7-9`: its comment explains why it is not in `image/image-inputs.sh`. Restate
     that against `.bessemer/image/inputs`.
   - `test/live/live.ts:95`: the error text says "build it with image/build-image.sh". Change it to
     name `node src/bin.ts image build`.
   - `src/doctor/probes.ts:186`, or wherever T110 moved that comment: it must not name a bash
     mirror of the recipe.
   - `docs/` is out of scope except where a **living** document tells a reader to run the deleted
     script. Closed tickets are frozen history.

**Never touch `.agentbox/`.** Its `Dockerfile`, `build-image.sh`, and `image-inputs.sh` are hae's
bash copies, carried whole as the parity oracle (ADR 0008, 12), and nothing here edits, moves, or
deletes them.

`setup-hook.sh` stays at the repo root, because config names it (E12).

**The image goes stale once.** Each hashed line carries its path, and the Dockerfile's path
changes, so `doctor` warns until the rebuild in Verify. That is expected, and the PR description
should say so.

## Effect wiring

- **Tags introduced or consumed**: none. This ticket moves files and values.
- **Layer composition**: unchanged.

## Acceptance criteria

- [ ] `image/` no longer exists, and `.bessemer/image/` holds a stamped `Dockerfile` and a stamped
      `inputs`. `.bessemer/.gitignore` carries the template's stamp, and its entries are a
      superset of the template's.
- [ ] `readStamp` on each returns the template's name, current version, and digest, and
      `bodyDigest` differs from the stamp digest for the Dockerfile, which is edited.
- [ ] The Dockerfile's `CLAUDE_CODE_VERSION` equals the template's.
- [ ] `image-build-command` is `node src/bin.ts image build`.
- [ ] The `git grep` in step 6 finds nothing outside `.agentbox/` and closed tickets.
- [ ] `git diff --stat origin/main -- .agentbox/` is empty.

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package.

Host-only, run by the operator at merge. Neither can run inside the agent's container:

```
node src/bin.ts image build
node src/bin.ts doctor
```

The build must succeed. `doctor` must then exit 0 with probe 2 reading present and current, since
the rebuild clears the stale image described above. Then `docker run --rm --entrypoint claude
bessemer --version` prints the pinned version.
