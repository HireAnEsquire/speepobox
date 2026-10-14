# T71 — `IssueStore` reads an issue set out of a ref

Status: Done (PR #31; the recording layer is `{ ...live }` over a store holding its own `GitLive`, so the `Git` swap in `appDryRunLiveFor` does not reach inside it and T77's write has nothing pinning it — recorded on T77 — and `parseCatFileBatch` clamps a truncated frame to a short read rather than a failure, which only the exit-code check keeps harmless)
Type: AFK
Blocked by: [T68](T68-issue-files-parse-order-and-restamp.md) — the parse it composes.

<!--
P2 (09 Q5): the eleventh of SPEC §2's twelve tags, and the one §2 marks *post-move only*. 14's
ruling in one sentence — *`IssueStore` reads a ref and writes a commit. It never touches the host
working tree, whose contents depend on whichever branch the dev left checked out — not a fact about
any issue.* This ticket is the read half; T72 adds the scan over every ref and T77 the write.

bash materializes the folder out of the ref with `git archive` into a scratch directory
(`run.sh:997-1040`) and reads files from there. The port reads blobs and materializes nothing —
14's `cat-file` technique, which 15 §"Guards split" chose because it needs no working tree and so
fits before the checkout.
-->

## What to build

**`IssueStore.issues({ repo, ref, folder })` answers the parsed `Issue`s under `<folder>/issues/`
as they are at `ref`, read out of git objects, never off disk.** The tag exists after this ticket
and is wired into both compositions; nothing calls it from a command line until T73.

### 1. Two `Git` reads

The tag speaks git through `Git` (T27: every git operation names its repo, and `Git` is where git
is spoken), so `Git` gains two read operations, both through `inRepo`:

- `listTree({ repo, ref, path })` — `ls-tree` of one directory at a ref, answering the entries'
  names and blob ids; a path absent at the ref is a typed answer, not an error.
- `readBlobs({ repo, ids })` — one `cat-file --batch` over the ids, answering each blob's text.
  Batched, because T72 reads thousands (14 measured 2712 in 0.62s); one `cat-file` per file is
  the shape that does not scale.

### 2. The tag

```ts
// Shape, not names.
IssueStoreShape = {
  issues: (request: { repo: string; ref: string; folder: string })
    => Effect<ReadonlyArray<Issue>, IssueStoreError>
}
```

The folder is the repo-relative source directory as the dispatcher gave it (14's lesson 9: the
ledger, the resume target, and anything a human reads keep that path; never a scratch path). The
tag lists `<folder>/issues/` at the ref, reads every `.md` blob in one batch, and parses each with
T68 — a parse error names the file and the ref.

`IssueStoreError` has two arms the guards need to tell apart: **`FolderAbsent`** — the ref carries
no `<folder>/issues/`, which is how an untracked folder or a branch forked before the folder
existed presents (T73 refuses on it; the port requires tracked sets, map ruling of 2026-08-20,
and never falls back to the host tree the way `run.sh:1017-1030` does) — and **`Unparseable`**.
Both are typed: the caller's next move differs (SPEC §3).

### 3. The layers

`IssueStoreLive` needs `Git` and nothing else. The recording layer for `--dry-run` keeps its reads
real (AGENTS.md: *a recording layer keeps its reads real, and it is built over the live layer
wherever that tag has one*) — until T77 adds the write it records nothing, and it exists now so
`app.ts`'s two compositions gain the tag in the same commit and the swap has a term to differ in.

### 4. Docs

SPEC §2's `IssueStore` row names `parse` / `select` / `markLanded`. Selection is a pure function
(T69) and the tag reads and writes: amend the row to `issues` / `landedElsewhere` (T72) /
`markLanded` (T77), keeping its sentence about the ref.

## Effect wiring

- **Tags introduced**: `IssueStore`. **Consumed**: `Git`.
- **Layer composition**: `IssueStoreLive` joins the `Layer.mergeAll` in `appLiveFor` beside
  `SandboxLive`, `GitLive`, `RunLockLive`, `ForgeLive`, `NotifierLive`, and
  `promptSourceLiveFor(repoRoot)` — it needs only what that level already has below it. The
  recording composition gains `IssueStoreRecordingLive` in the same position, built over the live
  layer as `GitRecordingLive` is. `appBaseLiveFor` is byte-unchanged. The expression to end at:

```ts
export const appLiveFor = (repoRoot: string) =>
  Layer.provideMerge(
    AgentCliLive,
    Layer.provideMerge(
      Layer.mergeAll(
        SandboxLive,
        GitLive,
        RunLockLive,
        ForgeLive,
        NotifierLive,
        IssueStoreLive,
        promptSourceLiveFor(repoRoot),
      ),
      Layer.provideMerge(
        LedgerLive,
        Layer.provideMerge(bessemerConfigLiveFor(repoRoot), PlatformAndReporterLive),
      ),
    ),
  );
```

  and `appDryRunLiveFor` the same with `IssueStoreRecordingLive` in that slot. Put the resulting
  composition in the PR description.

## Acceptance criteria

- [ ] Against a real temporary repository (the `test/git.test.ts` idiom): a folder committed on one
      branch and edited on another reads differently by `ref`, and neither read matches the
      working tree after a third edit left uncommitted — the working tree is never consulted.
- [ ] A ref with no `<folder>/issues/` answers `FolderAbsent`; a file that fails T68's parse answers
      `Unparseable` naming file and ref; an `issues/` holding non-`.md` entries ignores them.
- [ ] Against a fake `Git`, the read is one `listTree` and one `readBlobs` — never one call per
      file.
- [ ] `IssueStore` resolves from both `appLiveFor` and `appDryRunLiveFor`; `appBaseLiveFor` does
      not provide it.
- [ ] `test/support/` gains an `IssueStore` fake answering scripted issue sets per ref, for T73.

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package.
