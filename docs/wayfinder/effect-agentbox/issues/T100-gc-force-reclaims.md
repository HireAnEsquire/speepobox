# T100 — `gc --force` reclaims

Status: Done (PR #65. Host check 2026-09-25: a `--task` run on `gc-probe` killed with `kill -9` mid-pass was listed as `Reclaimable`, and `gc --force` reclaimed the lock, removed the container, and removed the checkout after its salvage sent the agent's commit home to `gc-probe`. Logs untouched.)
Type: AFK
Blocked by: [T98](T98-the-salvage-takes-a-checkout-not-a-plan.md) — the salvage this calls; [T99](T99-gc-lists-what-it-would-reclaim.md) — the listing and the argv this acts on.

<!--
P4 (09 Q5). SPEC §7's `gc` row: *`--force` reclaims after re-verifying liveness. **Logs are never
deleted.** Checkouts are salvaged before removal, by the release's own two-destination rule (T29):
FF home, else onto a branch of the run's own, named from the commits. A checkout neither
destination takes is skipped loudly, never discarded. Daemon down → … `--force` refuses.*

This is the one place a **human** clears another slug's checkout. AGENTS.md (T25, T28): the
reconciler reports every other slug's kept copy and touches none, and "P4's `gc` is where a human
removes what it will not". Two binding rules carry over:
- **One salvage function** (T28). gc calls `salvage` from `dispatch/checkout.ts`, narrowed by T98.
  gc never writes a second pair of fetches.
- **A removal is authorized by a read** (T38). `salvage` already asks the containment question
  after every fetch. gc removes a directory only on `WentHome` or `Rescued`.

The reconciler's own `removeCheckout` is read-only (`notElsewhere`) and stays that way: the
preflight sweep over other slugs may not salvage (T28). gc salvages because gc is the human's
explicit act.

Oracle: `run.sh:569-647`. It re-checks liveness per item immediately before touching it, removes
containers with `docker rm -fv`, salvages checkouts, and treats a detached HEAD as a loud skip. It
sets `GC_FAILED` only when a removal fails.

Decisions (the user, 2026-09-24, P4 quiz):
- **D8 (a)**: a malformed `config.toml` degrades the listing, and `--force` refuses with one line,
  as it does when the daemon is down. The composition is the read-only slice plus the two tags
  that `--force` needs, provided at the `gc` case. This is the picker's pattern, and
  `appBaseLiveFor` stays byte-unchanged.
- **D10**: leftovers bash never produced (stranded `.claim` temp files, the status-commit scratch
  index under `locks/`, `feedback-edit-*` directories) are **out of scope**. They are recorded in
  MAP.md's *Not yet specified*. Eviction witnesses and markers are in scope, through T97's sweep.
- **D11 (option 2)**: gc does not salvage onto a branch the served repo no longer has. The
  salvage's first fetch creates an absent `refs/heads/<b>` unconditionally (AGENTS.md, T29), so
  calling it for a deleted branch would bring back a branch a human removed. The acquire reaches
  that state only through a race: `branchExists` runs before the lock, and nothing holds the ref
  in between. The release is exposed for the whole run. So `salvage` is **not** changed here, and
  the rescue-only arm for an absent branch is recorded in MAP.md's *Not yet specified*.
-->

## What to build

**`bessemer gc --force` does what T99's listing said it would. Each slug is handled under its own
lock, and a checkout is removed only when the commits in it are proven to be somewhere else.**

### 1. Two refusals, before anything is touched

- **The daemon did not answer** (the scan's `None`): print the listing, then one line saying
  `--force` refused because container liveness cannot be verified and nothing was removed. Exit 1.
  This is bash's `run.sh:570-573`.
- **The config does not decode** (D8): run `loadConfig(repoRoot)` once, as `doctor`'s probe 7
  does (`doctor/doctor.ts:116`). On a `ConfigError`, print the listing, then one line saying
  `--force` refused because `config.toml` does not decode (quote the error's first line), the
  listing is against the committed defaults, and nothing was removed. Exit 1. The reason is that
  the fallback's `runtimeRoot` can differ from the one the dispatcher's runs actually wrote, and
  `--force` would then act on the wrong directory's locks.

### 2. Per slug, under its lock, reclassified

For each slug in the scan whose verdict is not `Live`:

1. `RunLock.acquire(slug)` inside `Effect.scoped`, as the reconciler's `reclaim` does. A
   `LockHeld` or `LockError` means another dispatch got there: print `skip <slug> — <detail>` and
   touch nothing of that slug.
2. **Under the lock, read that slug's wreckage again and `classify` it again.** This is the
   "re-verifying liveness" that SPEC §7 asks for. The scan is a snapshot. The lock proves no live
   *dispatch of ours* owns the slug. The reclassification also catches a container that started
   running since the scan and that no lock names, which may belong to another dispatcher (SPEC
   §4). A slug that now reads `Live` is skipped with its detail.
3. Act in release order (sandbox, then checkout, then lock), as the reconciler does:
   - **Container**: `Sandbox.remove`, the reconciler's `removeSandbox` sentence.
   - **Checkout**: see §3.
   - **Lock**: leaves with the scope. The acquisition in step 1 already evicted a dead owner's
     file.

Run T97's witness sweep once, before the per-slug loop, which is where the reconciler runs it.

`Live` slugs from the scan are listed as skipped and never locked.

### 3. The checkout: salvage, then remove only on proof

Read the branch from the copy's `.git/HEAD`. The scan already carries it as
`CheckoutOnDisk.branch`, read as a file rather than by spawning a `git` per slug (`reconcile.ts`'s
`checkoutAt`). Do not add a host `git` read of the copy beyond what `salvage` already does.

- **`None`** (a detached HEAD or unreadable): skip loudly, keep the directory, and print
  `unmovedCheckoutNotice`-style recovery: the branchless form of `checkoutRecovery` in
  `wreckage.ts`.
- **The branch is absent from the served repo** (D11): ask `Git.revParse({ repo: repoRoot, rev:
  "refs/heads/<b>" })`. On failure, skip loudly and keep the directory. The sentence says that
  `'<b>'` no longer exists here, so gc will not recreate it, and gives the named-branch recovery
  commands from `checkoutRecovery` with the fetch target changed to `<b>-from-run`, which a human
  can inspect and delete. A `GitError` for any other reason lands here too. That is the safe
  direction: the directory stays.
- **Otherwise**: call `salvage({ branch, checkoutPath }, repoRoot)`, and then:
  - `WentHome`: remove the directory. Print `removed checkout <slug> (its commits are on '<b>')`.
  - `Rescued { onto }`: remove the directory. Print that the commits would not go onto `'<b>'`
    and are on `'<onto>'`, so merge or cherry-pick from there, or delete it if the work was
    already merged.
  - `Kept { why }`: keep the directory and print gc's own sentence for each `Unmoved` arm. Use
    `nothingLanded` and `rescueDidNotLand` (narrowed by T98) for the `Unverified` and
    `RescueUnverified` arms, and git's two quoted errors for `Refused`. It ends with the recovery
    from `checkoutRecovery`. **Skipped loudly, never discarded.**

A removal that fails prints the path and the `rm -rf` for a human, the way `reconcile.ts`'s
failure sentence does. That failure is what sets the nonzero exit.

### 4. What `--force` never touches

- **Logs.** Nothing under `<runtimeRoot>/logs/` is removed, and a test pins it.
- A `Live` slug's anything.
- A container that the label-filtered query did not return. Ownership is declared, never
  inferred.
- The D10 leftovers.

### 5. Exit code

Exit 0 when every attempted removal succeeded, **including** runs where some items were skipped:
a skip is gc working, which is bash's `GC_FAILED` rule. Exit 1 on either refusal in §1, or when a
container or checkout removal failed.

### 6. SPEC

SPEC §7's `gc` row: mark `--force` built (T100). Add the D11 sentence: a checkout whose branch the
served repo no longer has is skipped, never recreated. Add the D8 sentence: `--force` also refuses
when the config does not decode.

### 7. Tests

`test/gc.test.ts`, on the reconciler's fakes plus a scripted `Git` fake that returns `salvage`'s
answers:

- each verdict;
- a slug that turns `Live` between the scan and the lock;
- `LockHeld` at acquisition;
- each `Salvage` arm, including `Kept` with each `Unmoved` arm;
- the detached-HEAD skip;
- the absent-branch skip, asserting that **no `fetchBack` was called**;
- a failed removal, which exits 1;
- the daemon-down refusal;
- the config refusal;
- logs are untouched.

## Effect wiring

- **Tags introduced or consumed**: consumes `RunLock`, `Sandbox`, `Git`, `BessemerConfig`,
  `Reporter`, `FileSystem`, `Path`, and `CommandExecutor`. No new tag.
- **Layer composition**: `bin.ts`'s `gc` case from T99 becomes the following, copied rather than
  derived. `RunLockLive` needs `BessemerConfig | Reporter | FileSystem | Path`, and `SandboxLive`
  needs a `CommandExecutor`. Both come from `appBaseLiveFor`, which already provides `GitLive`:

  ```ts
  case "gc":
    return gc({ repoRoot, argv: argv.slice(1) }).pipe(
      Effect.provide(
        Layer.provideMerge(
          Layer.merge(RunLockLive, SandboxLive),
          appBaseLiveFor(repoRoot, stdinIsTTY),
        ),
      ),
    );
  ```

  The listing path gains the two tags without using them. That is deliberate: one composition per
  command, as the picker's case does it. Put the resulting case in the PR description.

## Acceptance criteria

- [ ] `gc --force` with the daemon down prints the listing and the refusal, removes nothing, and
      exits 1.
- [ ] `gc --force` with a malformed `config.toml` prints the listing and the refusal, removes
      nothing, and exits 1. Plain `gc` still exits 0.
- [ ] Every slug is acted on under its own `RunLock`, and is reclassified under that lock before
      any removal.
- [ ] A checkout is removed only on `WentHome` or `Rescued` from `salvage`. There is no other
      fetch in `gc`'s module, and a grep for `fetchBack` in it finds nothing.
- [ ] A detached-HEAD copy, a copy whose branch is absent here, and a `Kept` salvage are all kept,
      each with a message naming the path and the recovery commands.
- [ ] The absent-branch case makes no `fetchBack` call.
- [ ] No file under `logs/` is removed.
- [ ] The exit codes follow §5.
- [ ] SPEC §7's row is updated as in §6.

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package.

Host-only, after the gate: dispatch a run, `kill -9` it mid-pass, then `node src/bin.ts gc`
followed by `node src/bin.ts gc --force`. The listing names the lock, the container, and the
checkout, and `--force` reclaims them. With the agent's commits in the copy, the checkout reports
where they went.
