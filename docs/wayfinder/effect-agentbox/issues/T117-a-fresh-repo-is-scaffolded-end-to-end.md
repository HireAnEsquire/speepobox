# T117 — A fresh repo is scaffolded end to end

Status: Done (run on the host 2026-09-30 against a private throwaway repo. Every step passed. Two findings: `bessemer` is not a command yet, which is P6's shim; the Dockerfile template names no model, which is T118.)
Type: HITL
Blocked by: [T111](T111-bessemer-image-build.md); [T112](T112-this-repo-builds-through-image-build.md); [T115](T115-init-works-out-its-config-values.md); [T116](T116-init-diff-reports-drift.md) — every P5 ticket; this is P5's closing check.

<!--
P5, ruled 2026-09-30 (09's comment of that date). HITL because nothing in it is code: it is a
docker build from a network-fetched CLI, a real dispatch, and a reading of what an adopter is
shown. This is what 09 Q1-Q2 meant by `init` being "proven by the author's own repo before any
outsider touches it" — the P7 install into hae is the second proof, not the first.
-->

## What to do

Run the adopter's path by hand, against a repository bessemer does not live in, and record what was
confusing as well as what failed.

1. Create a throwaway repo with an `origin` on the forge and a default branch, containing one
   trivial file and a `tasks/`-free tree.
2. Run `node <bessemer>/src/bin.ts init --repo-root <throwaway>`. Check that the base came from
   `origin/HEAD`, that the image name came from the directory, and that `tool-sha` is this
   package's revision.
3. Replace the Dockerfile's `BASE_IMAGE` if the stack needs one (for a trivial repo, the default
   will do). Run `image build` and confirm the CLI version inside the image matches the pin.
4. Put a credential in `.bessemer/.env` and run `doctor`. Every row must be green, including
   probe 2 (the image is current) and probe 8 (the tasks dir exists).
5. Commit `.bessemer/`, then run `git status`: nothing under `.bessemer/tasks/` is ignored, and
   no runtime file appears after a dispatch.
6. Dispatch one `--task "…"` run into the throwaway repo. It must land a commit and open a PR.
7. Run `init --diff` there. The result should be all current, and exit 0.
8. Run `init --diff` in **this** repo. All three stamped files (T112) should read *current,
   edited*, `config.toml` present, and the command exits 0. Record whether the output told a
   reader anything they could act on.
9. Discard the throwaway repo, its remote, and its image.

Write the findings into a `## Result` section on this ticket. Anything that needs code becomes a
new ticket. Nothing is fixed inline.

## Acceptance criteria

- [ ] Steps 1–8 were run on the host, and the `## Result` section records each one's outcome.
- [ ] `doctor` was all green in the throwaway repo after `init` and `image build`, and the manual
      Dockerfile edit, if any, is recorded.
- [ ] The dispatch landed and opened a PR.
- [ ] Every finding needing code is a new ticket.

## Verify

Host-only, and the whole substance of the ticket:

```
node src/bin.ts init --repo-root <absolute path to throwaway>
node src/bin.ts image build --repo-root <throwaway>
node src/bin.ts doctor --repo-root <throwaway>
node src/bin.ts init --diff --repo-root <throwaway>
node src/bin.ts init --diff
```

`npm run verify` is not a gate here, because no code changes.

## Result

Run on the host 2026-09-30, at `main` `622c77d`, against a private throwaway GitHub repo
(`bessemer-t117-scratch`) created with a README, so `origin/HEAD` was set by the clone.

1. **Throwaway repo:** created with `gh repo create --private --add-readme --clone`. One file, no
   `tasks/`.
2. **`init`:** wrote all five files. The config line read `base = "origin/main" (origin/HEAD),
   image = "bessemer-t117-scratch-bessemer" (directory name), tool-sha = "622c77d" (package
   revision)`, and no warning appeared. All three values came from where T115 says.
3. **`image build`:** the template's `debian:bookworm-slim` base was kept, so **there was no
   manual Dockerfile edit**. The build succeeded, and `claude --version` in the image printed
   `2.1.282`, the template's pin. This repo's own image was rebuilt from `.bessemer/image/` first
   (T112's host step) and read current afterwards.
4. **`doctor`:** every row green, probe 2 (image current) and probe 8 (tasks dir) included. The
   credential was copied into the throwaway repo's `.bessemer/.env`.
5. **Commit and `git status`:** after committing `.bessemer/`, `status --ignored` listed only
   `.bessemer/.env`. After the dispatch it listed `.bessemer/.env`, `.bessemer/logs/`, and
   `.bessemer/runs.jsonl`, all ignored by the scaffolded `.gitignore`. Nothing was untracked, and
   nothing under `.bessemer/tasks/` was ignored. The empty `locks/` and `checkouts/` directories
   do not show, because git lists no empty directory.
6. **Dispatch:** `--task` "add hello.txt" on branch `t117-probe`. The implement pass committed,
   review approved in round 1, the commit was pushed, and draft PR #1 opened on the throwaway repo.
7. **`init --diff` in the throwaway repo:** `config.toml` present, all three stamped files
   `current, pristine`, `No drift.`, exit 0.
8. **`init --diff` in this repo:** `config.toml` present, all three stamped files
   `current, edited`, `No drift.`, exit 0. There was nothing to act on, and the output said so. An
   `edited` file alone never counts as drift, which is right: it tells a reader the file is theirs
   without asking them to do anything.
9. **Discard:** the throwaway repo, its remote, and its image were deleted by hand afterwards.

### Findings

- **`bessemer` is not a command yet.** `init`'s next steps say `bessemer image build` and
  `bessemer doctor`, and the adopter's config names `bessemer image build`, but nothing installs a
  `bessemer` on the PATH. On this run every command was `node <bessemer>/src/bin.ts … --repo-root`.
  No new ticket: this is P6's clone-run shim. P6 is done when those printed commands work as
  printed.
- **The Dockerfile template names no model.** Every pass ran on the CLI's default
  (`claude-sonnet-5`), while this repo's own Dockerfile pins `ANTHROPIC_MODEL`. An adopter is not
  told that the model is theirs to choose, or where to set it. This is
  [T118](T118-the-dockerfile-template-names-the-model.md).
- Nothing failed. The dispatch into a repo that bessemer does not live in worked on the first try.
