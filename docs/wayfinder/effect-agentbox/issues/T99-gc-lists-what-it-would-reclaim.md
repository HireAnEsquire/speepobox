# T99 — `gc` lists what it would reclaim

Status: Done (PR #61. `node src/bin.ts gc` checked on the host 2026-09-24 with three live slugs and the daemon up.)
Type: AFK
Blocked by: [T97](T97-the-reconcilers-scan-is-a-value.md) — the scan this lists.

<!--
P4 (09 Q5). SPEC §7's `gc` row: *list by default (touches nothing, exit 0) … Logs are never
deleted … Daemon down → listing works with a warning*. SPEC §7 also says `status`, `doctor`, and
`gc` are intercepted before flag parsing and before any preflight, and SPEC §2 says
`appBaseLiveFor` is "what `status`, `doctor`, and `gc` run on". SPEC §4: every gc query filters on
**both** ownership labels, and gc keeps its path over the reconciler's pure classification. `gc`
does not exist yet; `bin.ts`'s switch comment says "with gc, when it exists".

Oracle: `run.sh:539-567` (the intercept, the daemon-down line, the listing) and `tasklib.py`'s
`collect_gc_items` / `summarize_logs` / `render_gc` (`tasklib.py:956-1141`). Two deliberate
differences from bash, both already ruled:
- Ownership is by label, never by the `agentbox-` prefix (SPEC §4, §12's divergence list). The
  container source is `ownedSandboxes` (`reconcile.ts`), the reconciler's own query.
- Liveness and "orphan" come from `classify` (`wreckage.ts`), not from bash's separate
  per-class rules. A checkout with no lock is `Kept` here, where bash listed it as a deletable
  orphan.

Decisions for this ticket (the user, 2026-09-24, in the P4 quiz):
- **D9**: no interactive or per-item-confirm mode. This ticket rewrites SPEC §4's sentence
  (currently "`gc` (P4) keeps the aggressive/interactive path …") to say what gc is.
- The `--gc` alias bash accepts (`run.sh:545`) is not carried. Only `gc` exists.
-->

## What to build

**`bessemer gc` prints what this host holds from runs that are over, and what `gc --force` would
do with each item. It changes nothing and exits 0.**

### 1. The intercept

In `src/bin.ts`'s switch, add `case "gc":` beside `status` and `doctor`. It runs after the
`--repo-root` peel, so `gc` gets the peeled argv and the served repo like the other two. It runs
on `appBaseLiveFor(repoRoot, stdinIsTTY)`, and `appBaseLiveFor` itself stays byte-unchanged.

Parse gc's own argv in a module, not in `bin.ts` (AGENTS.md: nothing that owes an assertion stays
there). `--force` is the only flag. Any other word is refused with one line naming the usage
(`bessemer gc [--force]`) and exits 1, through the renderer every other refusal uses. In this
ticket, `--force` parses but runs the listing, followed by one line saying that `--force` is not
built yet, and exits 1. T100 replaces that line with the reclaim. Add a `gc` entry to `bin.ts`'s
`usage` text.

### 2. The snapshot

Follow `status`'s shape (SPEC §5, ops as library): a `gc` effect gathers a snapshot value and
emits it as a `Reporter` event, and a pure renderer in the console reporter (`app.ts`, as
`StatusReported` is rendered) prints it. The snapshot holds:

- **one row per slug from `scanWreckage` (T97)**, with that slug's `classify` verdict. For each
  resource the slug has (container, checkout, lock), it holds the class, the slug, the age, the
  size where one applies, and what `--force` would do. The verdict decides the WOULD column:
  - `Live`: *skip*, with the verdict's own `detail`.
  - `Reclaimable`: remove the container, salvage then remove the checkout, and take the lock by
    reclaiming it.
  - `Kept`: salvage then remove the checkout; remove the stopped container beside it.

  The WOULD text says "salvage then remove" and never "remove": T100 removes a checkout only when
  the salvage says the commits are somewhere else.
- **stranded eviction witnesses** from the scan, each with "sweep".
- **one logs line**: how many run logs there are under `<runtimeRoot>/logs/` and their total size,
  followed by `kept (audit trail, gc never deletes logs)`. Run logs are named `<slug>-<runId>.log`
  (`logPathFor`, 16 Q5), so count every `.log` file directly in that directory. There is no
  `.log.1` class any more. No per-log rows.
- **the daemon's answer**. When `ownedSandboxes` answers `None`, the snapshot says so. The header
  carries bash's warning in this tool's words: dockerd could not be asked, so liveness is
  unverified, this is a listing only, and `gc --force` would refuse. Container rows are absent,
  because no query ran. Checkout and lock rows are still listed.

Age is from the entry's `mtime` (`FileSystem.stat`), measured against `Clock`. `mtime` is typed
`Option<Date>`, so an absent one renders as `?`. Size is a recursive sum for a checkout and `-`
elsewhere, as bash does it (`_dir_size`, `_human_size`). An entry that cannot be stat'd renders `?`
and does not fail the listing. When there is nothing to reclaim, the table is replaced by one line
saying so, and the logs line still prints.

`gc` writes nothing to the runtime root and runs no git command. The listing's only subprocess is
the label-filtered `docker ps -a` in `ownedSandboxes`.

### 3. SPEC

- SPEC §4, the ownership paragraph: replace "keeps the aggressive/interactive path" with what gc
  is. `gc` lists by default and `--force` reclaims, over the same pure classification. There is
  **no interactive mode** (D9, and bash's reasoning at `run.sh:541-544`: gc stays scriptable).
- SPEC §7's `gc` row: mark the listing half built (T99). The `--force` half stays marked P4 until
  T100.

### 4. Tests

A new `test/gc.test.ts` covers these cases:

- the snapshot over the fake scan for one slug of each verdict;
- the daemon-down snapshot;
- no wreckage at all;
- logs of mixed slugs.

The renderer is tested as a pure function. One case pins that `gc` makes no writes, using the
same zero-write assertion T97's scan case uses. One case covers the argv module: `--force`, no
flags, and an unknown flag.

## Effect wiring

- **Tags introduced or consumed**: consumes `BessemerConfig`, `Reporter`, `FileSystem`, `Path`,
  `CommandExecutor`, and `Clock`. Adds a `Reporter` event (for example `GcReported { snapshot }`).
  It is **not** a step notification: gc is not a run.
- **Layer composition**: `bin.ts`'s new case, copied rather than derived:

  ```ts
  case "gc":
    return gc({ repoRoot, argv: argv.slice(1) }).pipe(
      Effect.provide(appBaseLiveFor(repoRoot, stdinIsTTY)),
    );
  ```

  The exact name and signature of `gc` are yours; the provide is not. Put the resulting case in
  the PR description.

## Acceptance criteria

- [ ] `node src/bin.ts gc` prints the table (or the nothing-to-reclaim line) and the logs line,
      and exits 0.
- [ ] `node src/bin.ts --repo-root <abs> gc` lists the runtime root and containers of `<abs>`.
- [ ] Every verdict's WOULD text matches §2. A `Live` slug says it will be skipped and why.
- [ ] Daemon down: the header warns, container rows are absent, the rest is listed, and the exit
      is 0.
- [ ] `gc --bogus` is refused with the usage line and exits 1.
- [ ] A malformed `config.toml` does not stop `gc` (the tolerant slice).
- [ ] `gc` runs no git and removes nothing (pinned by a test).
- [ ] SPEC §4's sentence and §7's row are updated as in §3.

## Verify

```
npm run verify
node src/bin.ts gc
```

Run from the repo root. `npm run verify` is the gate — typecheck (with Effect diagnostics:
**errors and warnings break the build**, suggestions print), lint, and tests. `pre-commit` is not a
substitute and does not check this package. The second command is the distribution-model check
AGENTS.md asks for under *The gate*. It is host-only, because the container has no docker socket,
so on the host it also exercises the daemon-up path.
