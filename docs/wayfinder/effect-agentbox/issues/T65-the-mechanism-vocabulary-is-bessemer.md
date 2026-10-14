# T65 — The mechanism vocabulary is bessemer

Status: Done (PR #25; the one defect was authored into this ticket and the round built it faithfully.
The moves list above sent `scripts/check-bans.ts:9` to `bessemer-*` while the stays list froze the
same sentence at `ownership/labels.ts:4` and SPEC §7, and 21 had ruled only on `check-bans.ts:112`'s
label pair — so one sentence stood in the tree twice in two spellings, and the swept copy asserted a
retirement that never happened, this tool having never swept its own prefix. Restored on review with
a clause saying why the old spelling stays, because a lone `agentbox-*` in a swept tree is exactly
what invites the next sweeper; the audit count is 62 rather than the PR body's 61, and that sentence
is the extra hit. The round also found `.bessemer/config.toml:26-28` collapsed — "named for the repo
and not the package" now contrasts two identical words — and correctly ruled it out of scope rather
than widening; reworded in this commit. One thing the round did better than the criterion asked:
`slugOfContainer` reads `CONTAINER_PREFIX` from `plan.ts` rather than spelling it, so the container
pair is atomic by construction and could not have been split across commits even carelessly)
Type: AFK
Blocked by: none. **Deadline: before P6** — the shim's adopters pin what they see (09), and this is
the last name they would see under the old word.

<!--
[Ticket 21](../21-the-agentbox-vocabulary.md), resolved 2026-09-18. T63 renamed the package and said
in terms that it was not renaming the mechanism — the ownership labels, the image's digest label,
the container prefix, the setup-hook mount, the config environment prefix, the central config tag.
21 ruled that all of it moves to `bessemer` as one break, and that the word `agentbox` is retired
from everything this tool writes.

AFK where T63 was HITL, on purpose. T63's whole cost was telling a *use* of `speepobox` from a
*mention* of it across sentences like "07 chose `speepobox` because it was free" — noticing work a
first AFK round misses. `agentbox` has no such sentences in the living documents: it is a label
name, an env prefix, a path, a tag, and a handful of display strings, each of which either moves
because the code moves or stays because its referent is hae's bash. The frozen set is a path list.
-->

## What to build

**Every name the tool declares, stamps, reads back, or prints says `bessemer`; the writer and the
reader of each name change in the same commit; and `agentbox` survives in the tree only where its
referent is hae's bash dispatcher or the history of this port.**

### Group 1 — read back by something outside the process

Each row is one writer and one reader that must agree. Move both sides of a row in the same commit.

| Was | Becomes | Declared | Read back by |
| --- | --- | --- | --- |
| `agentbox.managed`, `agentbox.repo` | `bessemer.managed`, `bessemer.repo` | `src/ownership/labels.ts` (`MANAGED_LABEL`, `REPO_LABEL`) | the ownership filter in the same file; `scripts/check-bans.ts:112`'s ban text names the pair |
| `agentbox.inputs`, `agentbox.inputs.digest` | `bessemer.inputs`, `bessemer.inputs.digest` | `image/build-image.sh` (`--label`) | `src/doctor/probes.ts` (`INPUTS_LABEL`, `INPUTS_DIGEST_LABEL`), `test/doctor.test.ts:644-645` |
| `agentbox-` | `bessemer-` | `src/dispatch/plan.ts` (`CONTAINER_PREFIX`) | nothing by ruling (`labels.ts:4`); `test/status.test.ts:144` asserts the prefix is *not* queried on — move the string it asserts against; and `test/live/sandbox-gone.live.test.ts:35` hand-names a container `agentbox-live-sandbox-gone-<pid>`, a use the fake tier never sees |
| `/agentbox` | `/bessemer` | `src/sandbox/spec.ts` (`SETUP_HOOK_DIR`) | the container, at the path `spec.ts:127` mounts the hook to; `test/sandbox.test.ts` invokes `bash /agentbox/setup.sh` at four sites |
| `AGENTBOX_*` | `BESSEMER_*` | `src/config/config.ts` — `ConfigProvider.nested("agentbox")`, one line | the operator's environment; `test/config.test.ts` sets eleven `AGENTBOX_*` keys; `test/live/signal-matrix.live.test.ts:236-242` sets four; `.bessemer/config.toml:2`'s precedence comment |
| `AGENTBOX_IMAGE`, `AGENTBOX_IMAGE_INPUTS` | `BESSEMER_IMAGE`, `BESSEMER_IMAGE_INPUTS` | `image/build-image.sh:18`, `image/image-inputs.sh:27` | `test/config.test.ts:371` pins the variable name *and* the tag in one `toContain` |
| `bessemer-agentbox` (image tag) | `bessemer` | `image/build-image.sh:18` default, `.bessemer/config.toml:29` | `test/config.test.ts:371` (the same pin), `test/live/live.ts:49` default |

`config.test.ts:371` is the row that holds the build script and `config.toml` together — it exists
so doctor cannot advise a rebuild that never clears the stale row. Change the variable name and the
tag in the script, the config, and that assertion in one commit or the test says so.

The container rename has one cosmetic consequence, and it is correct: this repo's slugs are
`bessemer-t<n>`, so its own containers become `bessemer-bessemer-t<n>`. `labels.ts:6` says the name
survives for human readability only, and the prefix is the part that reads. Do not special-case it.

### The config tag

`AgentboxConfig` → **`BessemerConfig`**, with `AgentboxConfigShape` → `BessemerConfigShape`,
`agentboxConfigLiveFor` → `bessemerConfigLiveFor`, the tag string `Context.Tag("AgentboxConfig")`,
and `src/app.ts`'s `agentboxConfigTolerantLiveFor`. Twenty-odd importers in `src/` and `test/`
follow mechanically. **Not** bare `Config`: it collides with Effect's `Config` module, already
imported in `config.ts`. SPEC §2's tag table and AGENTS.md:51,59 follow; ADR 0007's copy of the
list is frozen (below).

### Group 3 — written, never parsed

Every string the tool emits from now on:

- `src/dispatch/pr.ts:29` `PR_TITLE_PREFIX` → `"[bessemer] "`; `:46` "AI-authored via bessemer".
- `src/notify/notifications.ts:31` `notificationTitleFor` → `bessemer: <branch>`.
- `src/dispatch/render.ts:38` banner; `src/dispatch/run.ts:54` run-log header
  `== bessemer [<slug>] run start`.
- `src/lock/run-lock.ts:139,162` and `src/dry-run/run-lock.ts:63` "another bessemer run …";
  `render.ts:107`'s comment quoting it.
- `src/dispatch/checkout.ts:106` `FALLBACK_EMAIL` → `bessemer@users.noreply.github.com`.
- `image/image-inputs.sh` `agentbox_sha256`, `agentbox_inputs_digest` → `bessemer_…`, and their
  callers in `build-image.sh`.

Logs already on disk keep their `== agentbox` header; nothing rewrites a log (16). Test fixtures
that pin these strings (`test/run-log.test.ts:26`, `test/forge.test.ts`, `test/pr.test.ts`,
`test/notify.test.ts:92`, `test/dry-run.test.ts`, `test/support/forge-fake.ts:24`,
`test/agent-prompt.test.ts:344`, `test/agent-cli.test.ts:105`, `test/checkout.test.ts:1027`,
`test/dispatch.test.ts`) are uses — sweep them and let the suite say which ones were pinned.

### Comments and living documents — a mention follows its referent

21's sharpening of 18 §4. A sentence that cites a name *because the code carries it* is citing the
code, and moves with it. A sentence that cites a name because *hae's bash* carries it stays.

Moves: every `src/` comment naming a label, prefix, or the tag (`labels.ts:1-6`, `probes.ts:150-171`,
`paths.ts:140`, `served-repo.ts:13`, `spec.ts:75`, `config.ts:181,200,216`, `agent-cli.ts:248`,
`check-bans.ts:9`); the three live tests whose comments explain the label they assert on
(`test/live/reconcile-labels.live.test.ts:49`, `sandbox-leak.live.test.ts:59`,
`sandbox-gone.live.test.ts:54`); `docs/wayfinder/effect-agentbox/SPEC.md` §2 (tag table, line 108, and the tree
at line 42), §6 (`AGENTBOX_*` at 307–308), §7 (labels at 251–253); `AGENTS.md:51,59,135,606`;
`.bessemer/config.toml:2`.

Stays, because the referent is bash or history: `labels.ts:4-5`'s "prefix sweeping of `agentbox-*`
is retired" and SPEC §7's "prefix sweeping (`agentbox-*`) is retired everywhere" — that names what
bash does and what this tool refuses to; keep the old spelling there, and add `bessemer-*` only if
the sentence stops being true without it (it does not). `hae-agentbox` wherever a fixture names
hae's image (`test/sandbox.test.ts:51`, `test/sandbox-spec.test.ts`, `test/dry-run.test.ts:83`,
`test/doctor.test.ts:585`). "Real bash-agentbox output, frozen" (`test/status.test.ts:25`,
`test/ledger.test.ts:22`). `test/config.test.ts:278,353,355,481` and
`test/dispatcher-freshness.test.ts:311,320`, which name `.agentbox` the directory — and for the
same reason `image/Dockerfile:4` ("Not `.agentbox/Dockerfile`, which is hae's") and
`test/config.test.ts:197`, whose *value* `.agentbox/.env.sandbox` is hae's example path while the
key beside it, `AGENTBOX_SANDBOX_ENV_FILE`, moves.
`docs/agents/issue-tracker.md:32` and `CONTEXT.md:51`, which name hae's paths. SPEC §12's quote of
`run.sh:1466` at line 810 (`/agentbox/stream-filter.py` is bash's mount).

### The frozen set — never edited, not even a path

Unchanged from T63, and for the same reasons: `.agentbox/**`; `docs/adr/0006-*.md`,
`0007-*.md`, `0008-*.md` and their filenames (0007:155,176,210 name the tag and the labels — 18
froze the document, not its sentences); hae's sandboxing manual (describes bash); the extraction
script and manifest, and `issues/T34-extraction-rehearsal.md`;
`07-name.md`; every closed wayfinder ticket, 21 included; `docs/wayfinder/effect-agentbox/` as a
directory name; `README.md:3`'s link to 0007's filename.

## Effect wiring

- **Tags introduced or consumed**: `AgentboxConfig` is renamed to `BessemerConfig`. No tag is
  added or removed; SPEC §2's count stays twelve.
- **Layer composition**: unchanged. `bessemerConfigLiveFor` and `bessemerConfigTolerantLiveFor`
  are the same layers under new names.

## Tests

- The suite is the test: every pinned string above is a fixture, and the sweep either updates it or
  the suite names it. No new test.
- `test/config.test.ts:371`'s pin is updated, not deleted — it is the assertion that makes the
  self-healing in 21 §5 hold.
- `test/status.test.ts:144` (`not.toContain("agentbox-")`) becomes `not.toContain("bessemer-")`;
  the assertion is about the new prefix, and the old spelling would pass vacuously.
- `verify:live` is the operator's gate at merge (below); the fake tier cannot see a label on an
  image.

## Acceptance criteria

- [ ] `git grep -ni agentbox -- src test image scripts .bessemer AGENTS.md CONTEXT.md
      docs/wayfinder/effect-agentbox/SPEC.md` returns only hits whose referent is hae's bash or
      history: `.agentbox`, `hae-agentbox`, "bash-agentbox", the retired-sweep sentences, and
      SPEC's quote of `run.sh:1466`. The PR description lists every remaining hit. Case-insensitive
      — T63's audit was case-sensitive and passed thirteen `SPEEPOBOX_*` survivors.
- [ ] `git diff --stat origin/main -- .agentbox docs/adr docs/wayfinder/effect-agentbox/07-name.md
      docs/wayfinder/effect-agentbox/21-the-agentbox-vocabulary.md` is empty, and so is the same
      diff over hae's sandboxing manual and the extraction files.
- [ ] Each Group 1 row's writer and reader change in the same commit.
- [ ] `BessemerConfig` is the tag; nothing in `src/` or `test/` says `AgentboxConfig`.
- [ ] The suite passes.

## Operator, at merge

The image and any running container carry the old labels, and 21 §5 accepts the break rather than
migrating it. Before merging:

1. `docker ps -a --filter label=agentbox.managed=true` — stop and remove anything listed; after the
   flip nothing reclaims it.
2. `image/build-image.sh` — stamps `bessemer.inputs.digest`; the old image can be left to
   `docker image prune`.
3. `npm run verify:live` against the rebuilt image, then `bessemer doctor` — the image row is green
   because writer and reader moved together; if it reports stale, the two labels disagree and the
   PR is wrong.

## Verify

```
npm run verify
```

Run from the repo root. This is the gate: typecheck (with Effect diagnostics: **errors and warnings
break the build**; suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package.
