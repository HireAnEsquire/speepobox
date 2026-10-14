# T2 — Ledger record + `status`

Status: done
Type: AFK
Blocked by: T1

Sequence: [ticket 08](../08-in-hae-sequence.md). Second of six tracer bullets, after
[T1](T1-skeleton.md).

**Tracer: `status` renders real state** — not fixture rows. Pointed at bash agentbox's own
`.agentbox/runs.jsonl`, read-only, `status` renders the run history of this repo including the T1
dispatch that built this package. That exercises the legacy adapter against real output rather than
against lines we wrote ourselves, which is the only way to find out whether "tolerant" is true.

## What to build

`Ledger` (a tag, SPEC §3) and the `status` command. **Not** `IssueStore`, feature-mode, or any
dispatch machinery — ticket 08 §3 removed those from the sequence entirely, and nothing before the
move-out bar reads an issue file.

### 1. The record

Greenfield, per **05 Q18R / SPEC §10**. Today's bash schema is replaced, not extended, because three
of its flaws are structural: `spec`/`feature` is a nullable pair encoding a mode, `issues`-vs-`outcome`
repeats that discriminant unenforced, and nothing records identity or timing.

| Field | Notes |
| --- | --- |
| run identity | **tagged union**: one-off / feature / feedback-resume. Replaces the nullable pair; the mode is read off the tag, never recovered by null-checking |
| `schemaVersion` | explicit |
| run id | stable per run |
| start, end | both; today's "why did that run take 40 minutes" is unanswerable |
| terminal reason | why the run ended, distinct from outcome |
| base SHA, merge-base SHA | both |
| PR number **and** URL | number alongside the URL, not parsed out of it at every call site |
| per-issue outcomes | feature runs only — belongs to that arm of the union, not to every record |

**The record must be derivable from the `Reporter` event stream.** Event-log-as-truth is deferred
(05 Q18R: architecture spent on a consumer that does not exist), but promoting events to
source-of-truth later has to be additive rather than a rewrite. Nothing in the record may depend on
state that no event carries.

The ledger lives at `runs.jsonl` under the **runtime root** — the package's own root during
incubation (05 Q19), already a config value from T1. It is gitignored.

### 2. The legacy read adapter

Decodes bash-shaped lines at read time. Transitional: SPEC §10 deletes it in P7's atomic commit,
*after* the gate passes.

Legacy lines carry `timestamp`, `branch`, `base`, `spec`, `feature`, `issues`, `outcome`, `pr_url`,
`task_dir`. Two rulings, because both shapes typecheck and one is right:

- **Absence is represented, never fabricated.** Legacy has no run id, no start, no terminal reason,
  and no merge-base. Those decode as absent. A synthesized run id or a start time back-filled from
  the end time is a lie that survives into the side-by-side comparison the adapter exists to serve.
- **Legacy `timestamp` is an *end* time.** Bash appends its row at landing, after the PR exists — so
  mapping it to `start` misreports every historical run.

Mode recovery follows bash's own rule (`spec` non-null → one-off, `feature` non-null → feature).
A line that satisfies neither is **skipped with a warning, never an error**: the ledger is derived
state (SPEC §10), and a corrupt line degrades `status` rather than failing anything.

### 3. Queries

- recent runs, newest first, for `status`
- **last recorded base for a branch** — the `--base` default chain's first link
  (`ledger-last-base` in bash). No CLI consumer until T4; the query and its tests land here with the
  record.

### 4. `status`

Per **SPEC §7**: one screen — what's running, what just finished, where the PRs are. **No docker
state changes, no writes, no git commands.** It is one of the three commands intercepted before flag
parsing and before any preflight, because it must work when the thing it inspects is broken
(03 §1.1).

Two halves and their degradations:

| Condition | Behaviour |
| --- | --- |
| daemon down | ledger half still renders, with a warning. Exit 0 |
| ledger missing, empty, or corrupt | container half still renders. Exit 0 |
| neither available | renders empty and says so. Exit 0 |

**The container half queries by label, never by name.** Ownership is declared, not inferred (design
rule 3): filter on `agentbox.managed=true` **and** `agentbox.repo=<hash of repo root>`, both. Prefix
sweeping of `agentbox-*` is retired everywhere. Introduce the ownership-label module here — the pure
repo-root hash plus the filter arguments — because T3 applies the same labels when it creates
sandboxes, and the two must agree by construction rather than by review.

Nothing carries these labels until T3, so at T2 the container half is proved on its **empty** and
**daemon-down** paths; the populated path is T3's to demonstrate.

**`status` calls the subprocess chokepoint directly** and does not go through `Sandbox` — not merely
because `Sandbox` does not exist until T3, but because SPEC §7 requires `status` to work when the
world it inspects is broken. It stays on the chokepoint after T3.

Output goes through `Reporter` events with the renderer as a subscriber, matching `doctor`. A
`process.stdout.write` inside the command typechecks and is wrong.

## Already on the branch — do not rewrite

- **`AGENTS.md`** — hand-authored. Ticket 08 §2 expects T2+ to **amend** it as tripwire
  data arrives, so adding a ruling you had to discover is in scope; rewriting it is not.
- **Do not touch hae files.** `.agentbox/` is read as data by this bullet's tracer and modified by
  nothing.

## Effect wiring

- **Tags introduced**: `Ledger`.
- **Tags consumed**: `AgentboxConfig` (runtime root), `Reporter`.
- **Not introduced**: `Sandbox`, `Git`, `Forge`, `AgentCli`, `IssueStore`, `Notifier`, `RunLock`,
  `PromptSource`, `Prompt`. Do not stub them.
- **Layer composition**: `Ledger` joins the same single `AppLive` composed at the entrypoint (05
  Q21) — not a per-command layer. `status` runs on the read-only slice `doctor` already uses. Paste
  the `effect-language-service layerinfo` output for the updated layer into the PR description and
  match it against T1's; layer wiring is the top failure mode for agent-written Effect (06), so
  copy, don't derive.
- **Errors follow the outcome-row test** (05, and `AGENTS.md`): a ledger that cannot be read is a
  typed error the caller degrades on, never a defect. Note the corollary is not yet exercised — a
  ledger row exists iff `RunLock` was acquired, and `RunLock` arrives in T3.

## Acceptance criteria

- [ ] The record is a tagged union over run identity; no code recovers the mode by checking which
      field is null
- [ ] `schemaVersion`, run id, start, end, terminal reason, base SHA, merge-base SHA, PR number and
      URL are all present; per-issue outcomes exist only on the feature arm
- [ ] The record round-trips: encode then decode yields the original, covered by tests
- [ ] Legacy lines decode with genuinely-unknown fields absent — no synthesized run ids, no start
      back-filled from `timestamp` — and legacy `timestamp` maps to **end**
- [ ] An undecodable ledger line is skipped with a warning and does not fail the command; a missing
      or corrupt ledger degrades `status` and exits 0
- [ ] Last-recorded-base-for-branch is implemented and tested against both record shapes
- [ ] `status` makes no writes, runs no git commands, and changes no docker state — asserted, not
      just intended
- [ ] The container half filters on `agentbox.managed` **and** `agentbox.repo`; no query anywhere
      matches on container name
- [ ] Daemon down renders the ledger half with a warning and exits 0; empty ledger renders the
      container half and exits 0; neither available renders empty and exits 0
- [ ] `status` output is emitted as `Reporter` events, with rendering in the subscriber
- [ ] **`status` renders bash agentbox's real `runs.jsonl` read-only**, including the T1 dispatch,
      and this is what the PR description demonstrates

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package.

Plus, separately, the tracer — which `verify` cannot cover because `vitest` transforms:

```
node src/bin.ts status
```

And the real-state proof. Point the runtime root at hae's bash agentbox via `config.local.toml`
(gitignored, local wins — 05 Q4), then run `status` again and confirm the rendered rows match the
lines in `.agentbox/runs.jsonl`, including T1's own dispatch. `.agentbox/runs.jsonl` must be
**unchanged** afterward — `status` never writes.

## Comments

Merged via PR #4464 (a PR in the private hae repo) from `speepobox-t2` into `tseff`. One dispatch
on `claude-opus-5`, no redispatches, three review rounds.

**The dispatch ended `needs-work`, and that was procedural.** The review prompt required any round
that committed fixes to end `needs-work` so the next round could re-review them; round 3 committed
`52eadebe7b` and the 3-round cap fired, so nothing ever re-reviewed it. It was reviewed by hand
instead and was clean. That interaction is fixed for T3 onward: a round that fixes and finds nothing
else now ends `fixed`, and the cap records `capped-unreviewed-fix` rather than a verdict
indistinguishable from unsalvageable work.

**All acceptance criteria met, with one exception of record.** The criterion asking for
`effect-language-service layerinfo` output in the PR description is **unsatisfiable** — `layerinfo`
is an editor-only language-service feature with no CLI (`effect-tsgo`'s subcommands are `patch`,
`unpatch`, `get-exe-path`, `diagnostics`, `setup`, `config`). The reviewer correctly reported twice
that it could not produce it, which cost rounds. T3's ticket and the issue template now paste the
`Layer.provideMerge` expression for the agent to copy instead, and require every criterion to name a
command that runs inside the container.

**The real-state tracer was verified on the host, not in the container.** `.agentbox/runs.jsonl` is
gitignored and therefore absent from the checkout, so the agent substituted rows regenerated with
the real `tasklib.py`. Run from the host against hae's actual ledger it renders all rows including
T1's and its own dispatch, exits 0, and leaves the file byte-identical. The `DURATION` column
reading `-` throughout is the "absence is represented, never fabricated" ruling visible in output —
legacy rows carry no start time. The container half is unverified in this repo's sandbox (no docker
socket); check it from the real checkout rather than a worktree, since `repoScope` hashes the
repo-root path and a worktree hashes to a different scope.

**Three defects found and fixed, one per round**, all in the fabricated-absence family and none in
Effect typing or layer wiring: `fs.exists` failure swallowed to `false` so an unreadable ledger read
as "no runs recorded" (`4191eb6735`); `findRepoRoot` untested despite being what `agentbox.repo`
hashes (`9c7cd5d7f7`); `ParseError.message` dumping ~1500 characters of schema onto the one-screen
`status` (`52eadebe7b`). Contributes **0** to ADR 0008's tripwire count, which counts Effect-error
redispatches. Running total after T1 and T2: 0.

**What T3 inherits**

- `src/ownership/labels.ts` — `ownershipLabels` / `ownershipFilterArgs`. T3 applies these to every
  sandbox it creates; the grep ban on name-matching stays green.
- `src/config/paths.ts` — `findRepoRoot`, a path walk rather than `git rev-parse` because `status`
  may run no git commands.
- `lastBaseForBranch` — T3's `--base` default chain is its first consumer.
- `AppBaseLive` in `src/app.ts`, which T3 must leave byte-unchanged: `status` and `doctor` gain no
  dependency on a lock, a git binary, or a docker daemon.
- Two rulings added to `AGENTS.md` during this bullet, as ticket 08 §2 invites: the
  read-only slice's config degrades while the dispatch surface's dies, and filesystem-derived host
  facts (the repo root above all) are resolved at the composition root and passed in.
- Known and deliberately left: `AgentboxConfigTolerantLive` is hand-verified rather than unit-tested
  (parameterize when T3 touches the wiring); emoji column misalignment is a faithful port of bash's
  `len()`-based `ljust`; `Clock.currentTimeMillis` read inside `status` is the one place AGENTS.md's
  letter and spirit diverge.
