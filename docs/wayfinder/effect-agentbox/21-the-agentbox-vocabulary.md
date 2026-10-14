# 21 — The agentbox vocabulary: what moves to bessemer, and what is frozen

Labels: `wayfinder:grilling`
Map: [MAP.md](MAP.md)
Blocked by: —
Assignee: Scott Bowles
Status: closed (resolved 2026-09-18; implementation is
[T65](issues/T65-the-mechanism-vocabulary-is-bessemer.md))

## Question

[18](18-where-the-package-lives-and-what-it-is-called.md) renamed the package and swept the word
`speepobox`. It explicitly did **not** sweep `agentbox` — "18 renamed the package, not the
vocabulary of ownership labels." That vocabulary is still live in 20-odd places, some of them read
back off running containers and built images. Does it move to `bessemer`, all at once or not at all,
and what is frozen as evidence?

---

Surfaced 2026-09-18 while scoping [T63](issues/T63-the-name-sweep.md). The hand-off into T63
proposed folding the `AGENTBOX_*` environment prefix into the sweep, on two premises that are both
wrong and worth recording so they are not re-proposed:

- **"Renaming the prefix breaks every `config.toml`."** No config file carries the prefix. Every
  declared key is flat — `image`, `base`, `tasks-dir`. The nesting exists in exactly one line of
  code, `src/config/config.ts:202`, and the prefix appears in `.bessemer/config.toml` only inside a
  comment describing precedence.
- **"It breaks every operator's shell."** The port has no adopters. hae sets `AGENTBOX_*` for the
  bash dispatcher, which stays bash until P7 and is not this tool.

The real objection to folding it into T63 is different, and it is what this ticket exists for: the
prefix is one word of a **mechanism vocabulary**, and moving that one word is the worst available
split.

## What is true today

Three groups, distinguished by whether anything reads the name back.

### Group 1 — read back by something outside the process

Moving any of these alone desynchronizes a writer from a reader.

| Name | Declared | Read back by |
| --- | --- | --- |
| `agentbox.managed`, `agentbox.repo` | `src/ownership/labels.ts:14-15` | the ownership filter, `labels.ts:34-35` — reconcile's whole notion of what it owns |
| `agentbox.inputs`, `agentbox.inputs.digest` | `src/doctor/probes.ts:154-155`, stamped at `image/build-image.sh:36-37` | doctor's staleness probe, `probes.ts:161-162`, via `docker inspect` |
| `agentbox-` container prefix | `src/dispatch/plan.ts:14` | nothing, by ruling — `labels.ts:4` records that prefix sweeping is retired in favour of the labels |
| `/agentbox` setup-hook mount | `src/sandbox/spec.ts:43` | the container, at the path the hook is invoked on |
| `AGENTBOX_*` config prefix | `src/config/config.ts:202` | the operator's environment |
| `AGENTBOX_IMAGE`, `AGENTBOX_IMAGE_INPUTS` | `image/build-image.sh:18`, `image/image-inputs.sh:27` | `test/config.test.ts:370`, which pins the variable name *and* the tag so doctor cannot advise a rebuild that never clears the row |

`scripts/check-bans.ts:112` states the label pair in a ban message, so the rule's own text moves with
the labels.

The digest label is the sharpest of these. It is stamped into the image at build and read back by
doctor. Rename one side only and doctor reports every existing image stale forever, and the rebuild
it advises never clears the row — the exact loop `config.test.ts` exists to prevent, arrived at from
the other direction.

### Group 2 — frozen as evidence

Under 18's existing rule: a **mention** stays, a **use** moves.

- `.agentbox/` — hae's bash dispatcher, carried whole as the parity oracle, with 182 line-number
  citations against it. 18 already ruled it keeps its name.
- ADR `0006`/`0007`/`0008` filenames, `docs/wayfinder/effect-agentbox/`, `07-name.md`, the two
  extraction records, and every closed ticket.

### Group 3 — written, never parsed

Nothing in the repo reads any of these back; each is a display string.

- `PR_TITLE_PREFIX = "[agentbox] "` and the PR body's "AI-authored via agentbox" —
  `src/dispatch/pr.ts:29,46`
- `notificationTitleFor` → `agentbox: <branch>` — `src/notify/notifications.ts:31`
- the dispatch banner and run-log header — `src/dispatch/render.ts:38`, `src/dispatch/run.ts:54`
- "another agentbox run (pid …)" — `src/lock/run-lock.ts:139,162`, `src/dry-run/run-lock.ts:63`
- `FALLBACK_EMAIL = "agentbox@users.noreply.github.com"` — `src/dispatch/checkout.ts:106`

`AgentboxConfig` and `agentboxConfigLiveFor` (`src/config/config.ts:232,246`) sit between groups 1
and 3: nothing outside the process reads them, but the tag is one of the twelve that
[SPEC](SPEC.md) §2 calls the complete service surface. AGENTS.md governs *adding* a tag, not renaming
one, so a rename is uncovered rather than forbidden — which is a reason to rule on it here rather
than let a sweep decide it in passing.

> Incidental finding, worth a one-line fix wherever it is next convenient: AGENTS.md cites that list
> as "the twelve tags in SPEC §3", and it is SPEC §2 — `## 2. Service boundaries`, the count stated
> two lines under the heading. The count is right; the section number is stale.

## Why this is not T63

T63's rule is use-versus-mention for the word **`speepobox`**. `agentbox` is a different word with
its own frozen set, and the two sweeps have different blast radii: `speepobox` appears in no built
artifact, where `agentbox` is stamped into images and running containers. Folding them makes one
ticket whose green depends on a `docker build`.

## The deadline

**Before P6**, for the reason 09 gave the package name: the shim's adopters pin what they see. P7 is
after P6 by construction, so hae adopts under whatever name P6 ships. The cost of moving is near zero
today — one repo, one image, no adopters — and grows per adopter after. The cost of *not* deciding
is that P6 ships the name by default rather than by ruling.

## The frontier

Asked as one round, per the map's standing preference. Each carries a recommendation.

1. **Does group 1 move at all?** *Recommend yes, as one clean break before P6.* Effect makes a
   transitional dual read cheap for the config prefix (`orElse` of two nested providers), but the
   labels have no such trick, so a partial migration buys nothing and the whole point of group 1 is
   that its members move together.
2. **Does `AgentboxConfig` move with it?** *Recommend yes, in the same slice.* A codebase whose
   labels say `bessemer` and whose central config tag says `Agentbox` is the half-state this ticket
   exists to avoid, and the tag rename is mechanical.
3. **Does group 3 move now, separately, or ride with group 1?** *Recommend it rides.* It is free to
   move at any time, which means there is no reason to move it early and produce a console that says
   `bessemer` while `docker inspect` says `agentbox`.
4. **What does the image tag become?** It is already composite — `bessemer-agentbox`,
   `.bessemer/config.toml:29`. *Recommend `bessemer`*, with `AGENTBOX_IMAGE` → `BESSEMER_IMAGE` and
   `config.test.ts:370` updated in the same commit, since that test is what holds the two files
   together.
5. **Is 18's mention-versus-use rule sufficient for the freeze?** *Recommend yes, unchanged* — it
   already produced the right answer for `speepobox`, and group 2 is the same shape.
6. **What happens to images and containers built under the old labels?** *Recommend: accept the
   break.* Rebuild the image, and stop any running container before the flip. At one repo that is two
   commands; there is no migration to write, and writing one would outlive its usefulness by a week.

## Relation to the fog

The oracle's end-of-life ([MAP.md](MAP.md), *Not yet specified*) is the neighbouring question —
`.agentbox/` is group 2's largest member, and the day it is deleted is the day the strongest reason
for the freeze goes away. The two do not block each other: this ticket rules on the name while the
directory still exists, which is the conservative order.

## Resolution — 2026-09-18

**The whole mechanism vocabulary moves to `bessemer` as one break before P6, and the word
`agentbox` is retired from everything this tool writes.** After the sweep it survives only where its
referent is hae's bash dispatcher or the history of this port. Every question in the frontier was
taken at its recommendation; what follows is the ruling as decided, with the two sharpenings the
round produced.

### 1. Group 1 moves, all of it, together

| Was | Becomes |
| --- | --- |
| `agentbox.managed`, `agentbox.repo` | `bessemer.managed`, `bessemer.repo` |
| `agentbox.inputs`, `agentbox.inputs.digest` | `bessemer.inputs`, `bessemer.inputs.digest` |
| `agentbox-<slug>` container name | `bessemer-<slug>` |
| `/agentbox` setup-hook mount | `/bessemer` |
| `AGENTBOX_*` config prefix | `BESSEMER_*` |
| `AGENTBOX_IMAGE`, `AGENTBOX_IMAGE_INPUTS` | `BESSEMER_IMAGE`, `BESSEMER_IMAGE_INPUTS` |
| image tag `bessemer-agentbox` | `bessemer` |

No partial migration and no dual read. The labels have no transitional shape, and the environment
already has two prefixes for one tool: the live tier reads `BESSEMER_LIVE_IMAGE`
(`test/live/live.ts:49`) while the build script reads `AGENTBOX_IMAGE` — the half-state this ticket
exists to avoid was already in the tree.

The container rename has one cosmetic consequence: this repo's slugs are `bessemer-t<n>`, so its own
containers are named `bessemer-bessemer-t<n>`. That is correct and left alone — `labels.ts:6` says
the name survives for readability only, and readability of the *prefix* is what the rename buys.

### 2. `AgentboxConfig` moves in the same slice

`AgentboxConfig` → **`BessemerConfig`**, with `BessemerConfigShape`, `bessemerConfigLiveFor`, the tag
string, and `app.ts`'s `bessemerConfigTolerantLiveFor`. Bare `Config` was considered and rejected:
it collides with Effect's `Config` module, already imported in `config.ts:125`. SPEC §2's tag list
and AGENTS.md follow; ADR 0007's copy of the list is frozen.

### 3. Group 3 rides — it is forward writes, not history

Group 3 is every string the tool emits from now on: the PR title prefix and body line, the
notification title, the dispatch banner, the run-log header, the two lock messages, the fallback
email, and the two shell functions in `image-inputs.sh`. All say `bessemer` after the flip. Logs
already written keep their `== agentbox [...]` header because nothing rewrites a log (16); that is a
fact about old files, not a survivor of the vocabulary.

### 4. The freeze rule is 18's, with one sharpening: a mention follows its referent

A **use** moves and a **mention** stays, exactly as 18 §4 had it — and the round made explicit what
"mention" means when the thing mentioned is itself moving. A living document that cites
`agentbox.managed` because the code carries it is citing the code, so it moves with the code (SPEC
§7, AGENTS.md:135,606). A living document that says bash sweeps `agentbox-*` is citing bash, so it
stays. The frozen set stays whole either way: `.agentbox/`, ADRs 0006/0007/0008 (0007:210 specifies
the labels and is still frozen — 18 froze the document, not its sentences),
hae's sandboxing guide (not carried), the extraction records, `07-name.md`, every closed ticket, and
`hae-agentbox` wherever a fixture names hae's image.

### 5. Old images and containers: accept the break, and doctor already heals the image half

After the flip, doctor's staleness probe reads `bessemer.inputs.digest` off an image stamped
`agentbox.inputs.digest`, finds nothing, reports the image stale, and advises the rebuild that
clears it — the loop `config.test.ts:370` guards against is not entered, because writer and reader
move in the same commit. A container started under the old labels is invisible to the new reconcile
and `gc` and nothing reclaims it, so the operator stops running containers before the flip. Two
commands at one repo; no migration code.

### 6. The container-name fog entry dissolves

*Two dispatchers can still kill each other's containers by name* (MAP, *Not yet specified*) rested
on hae's bash removing by constructed name — `cid="agentbox-$slug"` (`.agentbox/run.sh:581,1530,2279`).
A port container named `bessemer-<slug>` is unreachable from that line, and the port's own queries
are label-only already, so neither dispatcher can reach the other's containers at P7 without a
bash change or a serialising gate. Holds for exactly as long as bash keeps its prefix, which is
until P7 deletes bash. Struck from the map.

### 7. Implementation: one AFK ticket, the operator holds the image half

[T65](issues/T65-the-mechanism-vocabulary-is-bessemer.md). One thing must be true at once — writer
and reader agree — so it is a one-piece ticket by the map's slicing rule, mechanical where T63 was
not: `agentbox` has no "was chosen because" sentences in living documents the way `speepobox` did.
The image rebuild and `verify:live` are the operator's, at merge, and are the ticket's gate. Deadline
**before P6** stands as the ticket header says.

### Incidental

The AGENTS.md §3→§2 citation noted above was fixed by the T63 session the same day this ticket was
written; nothing is owed.
