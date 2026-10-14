# T108 — `gc` lists the runtime root's leftovers

Status: Done (PR #68. Host check 2026-09-30: `gc` rendered under plain node, and a planted `locks/x.index` was listed as an `index` row marked `remove`. Live runs of other slugs, in flight at the time, were not listed.)
Type: AFK
Blocked by: none.

<!--
MAP.md's *Not yet specified*, "Runtime-root leftovers that `gc` does not see" (D10), ruled by the
user on 2026-09-29. T100 kept these out of P4.

bash's `gc` knew three classes: containers, checkouts, and locks. The port writes three more kinds
of file that a `kill -9` can strand, and nothing lists them:
- the claim's temp file, `<slug>.pid.<pid>.<attempt>.claim`, in `locks/` (`lock/claim.ts:39`);
- the status commit's scratch index, `<slug>.index`, in `locks/` (`statusIndexPathFor`,
  `dispatch/plan.ts:77`, T77);
- the editor's session directory, `<purpose>-edit-XXXXXX/`, at the runtime root's top
  (`prompt/editor.ts:141`, T84). It holds the dispatcher's own text.

None blocks anything. `claim.ts` truncates and overwrites a leftover `.claim`, and `markLanded`
starts with `read-tree`, which replaces a leftover index. They are clutter, and `gc` is where a
human reads what the tool stranded (16).

Decisions (the user, 2026-09-29):
- **`gc` lists all three; `gc --force` removes the dead ones** (T109). The reconciler does **not**
  sweep them. A per-preflight sweep of files that block nothing is work with no payoff, and an
  editor directory is the dispatcher's text.
- **Liveness comes from a witness the name carries, never from age** (T20, T26):
  - a `.claim` is dead when the pid in its name is not alive;
  - an `.index` is dead when its slug holds no lock with a live owner. The index is only ever
    written under that lock;
  - an editor directory is dead when the pid **now written into its prefix** is not alive.
- **An editor directory from before this change carries no pid.** It is listed as unwitnessed, and
  `--force` leaves it for a human (T109).

The pid in the editor prefix. `editor.ts`'s comment rejects a pid in the name as a host read that
belongs at the composition root. The ruling reverses that on `run-lock.ts:77`'s reasoning: the
directory names *this process*, and there is no other process whose identity it could honestly
carry. Read `process.pid` inside `Effect.sync` in `editText`, and rewrite the comment to say so,
citing the lock's precedent and T108.
-->

## What to build

**`bessemer gc` lists stranded `.claim` files, scratch indexes, and editor directories beside the
classes it already lists, each with what `--force` would do to it. `--force` itself is T109.**

### 1. The editor directory names its process

In `prompt/editor.ts`, change the prefix from `` `${purpose}-edit-` `` to
`` `${purpose}-edit-${pid}-` ``, with `pid` read once via `Effect.sync(() => process.pid)`. Rewrite
the comment above it as described above.

Export one pure parser that the listing and T109 share, in `gc/` or beside the editor:

```ts
// `<purpose>-edit-<pid>-<suffix>` → Some(pid); `<purpose>-edit-<suffix>` (pre-T108) → None.
export const editorDirPid = (name: string): Option.Option<number>
```

It matches on a directory whose name contains `-edit-`. Only directories directly under the runtime
root are considered. The pid form is **two** segments after `-edit-`, digits then the random
suffix. A pre-T108 name has one, and the random suffix alone can be all digits
(`feedback-edit-482913`), so reading "digits after `-edit-`" as a pid would judge a legacy
directory by a number nobody wrote as a pid. Parse from the right, and test that case.

### 2. The snapshot

`gc/snapshot.ts`: add

```ts
export const GcLeftoverKind = Schema.Literal("claim", "index", "editor");
export const GcLeftoverState = Schema.Literal("dead", "unwitnessed");
export const GcLeftover = Schema.Struct({
  kind: GcLeftoverKind,
  path: Schema.String,
  // The slug for a claim or an index, off the name; none for an editor directory.
  slug: Schema.Option(Schema.String),
  modifiedAt: Measure,
  state: GcLeftoverState,
});
```

and `leftovers: Schema.Array(GcLeftover)` on `GcSnapshot`.

**Only dead and unwitnessed leftovers are listed.** A live one is in use, not left over. That
means a claim whose pid is alive, an index whose slug's lock has a live owner, or an editor
directory whose pid is alive.

### 3. Gathering

In `gc/gc.ts`, beside the witnesses. This is gc's own read, **not** the reconciler's scan, because
the reconciler never acts on these and its scan value (T97) should not grow a class it ignores.

- `readDirectory(<runtimeRoot>/locks)`:
  - `*.claim`: parse `<slug>.pid.<pid>.<attempt>.claim`. The pid is dead when
    `!isProcessAlive(pid)`. A name that does not parse is not a claim and is not listed.
  - `*.index`: the slug is the stem. Dead when the slug's lock file `lockPathFor(runtimeRoot,
    slug)` is absent, or when its owner (read as the reconciler reads it: `parsePid` then
    `ownerIsAlive`) is not alive.
- `readDirectory(<runtimeRoot>)`: directories whose name contains `-edit-`. `editorDirPid` gives
  `Some(pid)`, which is dead when `!isProcessAlive(pid)`, or `None`, which is `unwitnessed`.
- A directory that does not exist is empty. One that cannot be read is a `Warned`, as the logs line
  does it, and lists nothing from that directory.
- Age with the existing `ageOf`.

### 4. Rendering

`gc/render.ts`: one row per leftover in the existing table, after the witnesses:

| CLASS | SLUG | AGE | SIZE | WOULD |
|---|---|---|---|---|
| `claim` | slug | age | `-` | `remove` |
| `index` | slug | age | `-` | `remove` |
| `edit-dir` | `-` | age | `-` | `remove` (dead) or `keep — no pid, rm -rf by hand` (unwitnessed) |

`NOTHING_TO_RECLAIM` still shows only when every class is empty.

### 5. SPEC

SPEC §7's `gc` row: add the three classes, the name-borne liveness rules, and that the reconciler
does not sweep them (T108).

### 6. Tests

- `test/editor.test.ts`: the session directory's name matches
  `` `^${purpose}-edit-${process.pid}-` ``.
- `editorDirPid`: pid form, pid-less form, a name without `-edit-`.
- `test/gc.test.ts`, on a temp runtime root:
  - a claim with a dead pid is listed, and one with this process's pid is not;
  - an index with no lock is listed, one whose lock names a dead pid is listed, and one whose lock
    names this process is not;
  - a dead-pid editor directory is listed as `remove`;
  - a pid-less editor directory is listed as `keep — no pid`;
  - a live-pid editor directory is not listed;
  - nothing at all still renders `NOTHING_TO_RECLAIM`.

For a dead pid, use one `isProcessAlive` refuses: spawn and reap a child and use its pid, or use
the existing tests' dead-pid fixture if one exists (`test/support/`). Never hard-code a pid that
might be alive.

## Effect wiring

- **Tags introduced or consumed**: `FileSystem`, `Path`, `BessemerConfig`, and `Reporter`, which
  `gc` already has. No new tag.
- **Layer composition**: unchanged.

## Acceptance criteria

- [ ] The editor's session directory is named `<purpose>-edit-<pid>-XXXXXX`.
- [ ] `gc` lists dead claims, dead indexes, dead editor directories, and pid-less editor
      directories, with what `--force` would do to each. Live ones are not listed.
- [ ] No leftover is judged by age.
- [ ] The reconciler is unchanged.
- [ ] SPEC §7's `gc` row says it.

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package.

Host-only, after the gate, by the dispatcher: run `node src/bin.ts gc` under plain node on this
repo. It must render, with no leftover rows on a clean runtime root. Then run `touch
.bessemer/locks/x.index`, run `gc` again, and check that an `index` row for `x` appears. Remove the
file by hand afterwards.
