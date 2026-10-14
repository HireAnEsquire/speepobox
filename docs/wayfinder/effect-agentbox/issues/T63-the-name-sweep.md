# T63 — The name sweep

Status: Done (PR #23; the ticket's own closing audit — `git grep -n speepobox` — is case-sensitive,
as was the sed, so `SPEEPOBOX_LIVE`, `SPEEPOBOX_LIVE_IMAGE` and `SPEEPOBOX_LEAK_CANARY` survived
the sweep *and* the check that was supposed to catch what the sweep missed, and the round reported
"zero speepobox left in test/" while thirteen hits stood. Found on review, fixed in the same PR.
The ticket's mention list also missed a class the round found by hand: bare `speepobox/` as the old
directory's name, in eleven documents, where stripping yields nothing and renaming yields a
directory that never existed)
Type: HITL
Blocked by: [T61](T61-a-served-repo-declares-its-container-environment.md) and
[T62](T62-what-catches-a-root-conflation.md) — and through T62, all of T57–T60. 18 §5's forced
order puts the name last, after every root ruling has landed, so this sweeps a tree that is
otherwise finished.

<!--
[Ticket 18](../18-where-the-package-lives-and-what-it-is-called.md) step 4 of four, under §3 (the
name) and §4 (sweep vocabulary, freeze evidence). "The rename cannot be expand–contract. The package
name and `bin` are single-valued; there is no shape in which both names are live."

**HITL, decided by the `/to-tickets` pass of 2026-09-14.** 18 §4's rule is a use-versus-mention
rule: "A document that merely uses the name to talk about the tool gets the current vocabulary. A
document whose accuracy depends on the name it was written under does not." A blind substitution
breaks the documents that talk *about* the rename — 18 §3 itself ("07 chose `speepobox` because it
was the only candidate free"), 09 Q10, MAP's entries for 07, 09 and 18 — and telling a use from a
mention across some 540 occurrences is the noticing work T49 showed a first AFK round misses. The
sed is a minute; the read-through of its diff is the ticket, and it is an operator's half hour.

This is also where the `speepobox/…` path citations T56 left in `docs/` are stripped, so the docs
are swept once rather than twice. 18 §3 counted 209 in 78 files; the docs have grown since, and
the sweep's own `git grep` is the count that matters.
-->

## What to build

**The package is called `bessemer` everywhere the name is *used*, the evidence that was written
under the old name is left byte-identical, and one dated line in `MAP.md` says the retrofit
happened.**

### The frozen set — never edited, not even a path

1. `.agentbox/**` — a carried snapshot of hae; 12 ruled it read-never-executed, and editing it
   falsifies the parity oracle.
2. The extraction manifest,
   `docs/wayfinder/effect-agentbox/issues/T34-extraction-rehearsal.md` (note the directory: the
   rehearsal is a closed ticket under `issues/`, not one of the extraction files), and — a judgment
   this ticket adds to 18's list, for the same reason — the extraction script. The `speepobox/`
   paths in all three *are* the record of what `filter-repo` carried; swept, they document a move
   that never ran.
3. `docs/adr/0007-*.md` and `docs/adr/0008-*.md` — this repo supersedes ADRs, it does not edit
   them. 0008's filename (`…-closes-for-speepobox.md`) stays, and so does every link to it.
4. `docs/wayfinder/effect-agentbox/07-name.md` — the name is its entire subject.

### The code — the touch points 18 §3 enumerates

- `package.json`: `name` → `@hireanesquire/bessemer`, `bin` → `bessemer`. `package-lock.json`
  carries the name twice (root `name`, `packages[""]`); after editing run
  `npm install --package-lock-only` and confirm `npm ci` is clean.
- `src/dispatch/command.ts`: `Command.make("speepobox", …)` and `Command.run`'s `name` and
  `executable`.
- `src/bin.ts`: the usage block, first line and every command example.
- The three wreckage messages: `src/dispatch/checkout.ts` (two, "speepobox gives every run a
  private copy …") and `src/reconcile/wreckage.ts` (two).
- `AGENTS.md`'s title and its one `refs/speepobox/…` mention (a rejected design's naming — a use,
  sweep it).
- Test fixtures: branch names like `speepobox-t3` and the fake binary name in `exec.test.ts` are
  uses; sweep them, and let the suite say whether an expectation string was pinned somewhere.

**Untouched by the rename**, and check that the sed did not reach them: `CONTAINER_PREFIX` is
`agentbox-`; the image tag is `bessemer-agentbox` already (T40); `docs/wayfinder/effect-agentbox/`
is named for neither name; `agentbox.*` labels and the `AGENTBOX_*` config prefix are the
*mechanism's* name and are out of scope — 18 renamed the package, not the vocabulary of ownership
labels.

### The docs — everything else

`SPEC.md`, `MAP.md`, every other wayfinder ticket open or closed, every T-ticket including this
one's predecessors, `CONTEXT.md`, `docs/agents/issue-tracker.md` ("The speepobox T-bullets"),
`image/`, `.github/`, `setup-hook.sh`, and `config.toml`'s comments. Two substitutions:

1. The path prefix: `speepobox/src/…` → `src/…`, and likewise for `speepobox/test/`,
   `speepobox/prompts/`, `speepobox/config.toml`, `speepobox/AGENTS.md`, `speepobox/tasks/` and the
   rest. The package has sat at the root since T56; a citation with the prefix resolves nowhere.
2. The name: `speepobox` → `bessemer` where the name is *used*.

Do the paths first, then the name, so the second pass cannot manufacture `bessemer/src/…`.

### The mention sites — read after the sed, restore by hand

These are the places the name is *mentioned as a name*, where the old spelling must stay so the
sentence stays true. Read the diff at each and restore what the substitution broke:

- 18 §3 ("takes the name `bessemer`", "07 chose `speepobox` because …", "the package trailing the
  repo") and 18's *What is true today* ("Name `@hireanesquire/speepobox`", "503 occurrences of
  `speepobox`").
- 09 Q10 — the rename's own steps.
- `MAP.md`'s Decisions entries for 07, 09 and 18, and its T-ticket range line.
- T49's `<!-- -->` comment quoting 18 ("`speepobox/tasks/` is tracked") — a path, sweep it; the
  quote's *sense* survives as `tasks/`.
- Any T-ticket's `Status:` line quoting a PR title or a branch name — history, leave it.
- Links to `0008-agentbox-port-bakeoff-closes-for-speepobox.md` — a filename, leave it.

Then `git grep -n speepobox` — every remaining hit must be in the frozen set or in this list, and
the PR description enumerates them.

### The "incubation" wording

Seven comments in `src/` justify themselves with *during incubation* — a phase that ended
2026-08-21. 18's correction: each fact they assert is still true, so this is a wording sweep and not
a re-decision. Reword each to the fact it carries (`prompt-source.ts`'s and `bin.ts`'s were already
rewritten by T59 and T60; `config.toml`'s by T57). It rides along with §4's sweep because it is the
same act — prose catching up with a decision already taken.

### The record

One dated line in `MAP.md`, under *Notes* or beside the 18 entry: on this date the package took the
name `bessemer` and the tree was swept under 18 §4's rule, so **closed tickets carry retrofitted
vocabulary** — a reader of a swept closed ticket has no other way to tell. Without that line the
retrofit is undisclosed, and disclosure is the condition 18 §4 put on sweeping closed tickets at all.

### Procedure (operator)

1. Branch by hand from `origin/main` with no dispatch running; the setup hook and every path below
   are the rooted tree's.
2. Paths, then name, excluding the frozen set — for example
   `git grep -l 'speepobox' -- . ':!.agentbox' ':!docs/adr/0007*' ':!docs/adr/0008*'
   ':!docs/wayfinder/effect-agentbox/extraction'
   ':!docs/wayfinder/effect-agentbox/issues/T34-extraction-rehearsal.md'
   ':!docs/wayfinder/effect-agentbox/07-name.md'` piped to `sed -i ''`.
3. Read the diff at the mention sites above; restore.
4. The incubation comments; the MAP line; the lockfile.
5. `npm ci && npm run verify`; `git grep -n speepobox` and compare to the frozen set plus the list.
6. Confirm `git diff --stat origin/main -- .agentbox docs/adr docs/wayfinder/effect-agentbox/extraction
   docs/wayfinder/effect-agentbox/issues/T34-extraction-rehearsal.md
   docs/wayfinder/effect-agentbox/07-name.md` is empty.
7. Open the PR; CI is the second gate (SPEC §6's repin discipline).

Nothing on the host changes with the name: the ledger's old branch names are history, the image tag
was never the package's, and no shim URL is pinned anywhere (18 §3: "Nothing owed on the shim").

## Effect wiring

- **Tags introduced or consumed**: none.
- **Layer composition**: unchanged.

## Acceptance criteria

- [ ] `git grep -l speepobox` returns only the frozen set and the enumerated mention sites, and the
      PR lists the latter.
- [ ] Every file in the frozen set is byte-identical to `origin/main`.
- [ ] No tracked file cites a `speepobox/…` path outside the frozen set.
- [ ] `package.json`'s `bin` is `bessemer`, `node src/bin.ts` with no arguments prints a usage block
      that says `bessemer`, and the lockfile agrees with `package.json`.
- [ ] No comment in `src/` says *incubation*.
- [ ] `MAP.md` carries the dated disclosure line.
- [ ] `npm run verify` passes and CI is green on the PR.

## Verify

```
npm run verify
```

Run from the repo root — the package has sat there since T56. This is the gate — typecheck (with
Effect diagnostics: **errors and warnings break the build**, suggestions print), lint, and tests.
`pre-commit` is not a substitute and does not check this package. For this ticket, `git grep -n
speepobox` against the frozen set is the second half of the gate.
