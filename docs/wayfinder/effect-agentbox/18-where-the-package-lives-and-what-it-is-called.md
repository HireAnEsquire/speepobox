# 18 — Where the package lives, and what it is called

Labels: `wayfinder:grilling`
Map: [MAP.md](MAP.md)
Blocked by: —
Assignee: Scott Bowles (claimed 2026-09-09)
Status: closed (resolved 2026-09-09)

## Question

The package sits at `speepobox/` inside a repo already named `bessemer`, and its runtime root is
derived from that directory. Does it root at `/`, what is it called, and where does its runtime state
land — as one switchover, or as three separable acts?

---

Surfaced 2026-08-21, the day after the extraction. Not a new question: the
extraction manifest states it and defers it. What is new is that the
deferral pointed at a ticket that never took it, and both halves of the deferral are now live at
once.

## Why this is unowned

The manifest's layout decision gives three reasons for keeping the package nested, and the third
is the deferral:

> Rooting at `/`, renaming the package, and flipping `runtime-root` are one switchover, and that
> switchover is ticket 09's.

[09](09-post-move-sequence.md) never ruled on it. It contains no `--path-rename`, no rooting
decision, and nothing about the package's directory at all — its Q10 covers only the *name*
(the repo rename, `package.json` name + bin, the shim URL repin, and the python-repo vacate taken
first). So the layout was handed to a ticket that does not cover it, and has been unowned since
2026-08-19.

**Two of the manifest's three reasons have expired**, both by having been extraction-scoped:

1. *`tasks-dir` would silently re-resolve.* True, and it was the right reason not to change layout
   mid-rehearsal — "a rehearsal whose first act is a config edit is not rehearsing the extraction."
   Outside a rehearsal it is a one-line config edit.
2. *Carried citations keep resolving.* Those citations are `run.sh:NNNN`, `tasklib.py:NNNN`, and
   `.agentbox/…` / `docs/adr/…` links. None of them move if only `speepobox/` is hoisted.

What survives is reason 3, which is not an argument for *later* — it is an argument for *together*.
This ticket is that togetherness, taken deliberately rather than by drift.

## What is true today

- **Package at `speepobox/`.** Name `@hireanesquire/speepobox`, bin `speepobox`, `private: true`.
- **The repo is already `bessemer`.** 09 Q10's step 1 (vacate the python name) and step 2 (claim it)
  are both done; steps 3 — `package.json` name + bin, and the shim URL repin — are not.
- **Runtime root is derived, not configured.** `defaultConfig.runtimeRoot = packageRoot`
  (`speepobox/src/config/config.ts:54`), and `packageRoot` is three `dirname`s up from
  `src/config/paths.ts` — so it *is* the package directory, by construction. `config.toml` sets
  `runtime-root` nowhere, on purpose.
- **So hoisting moves the runtime state.** `logs/`, `locks/`, `checkouts/`, and `runs.jsonl` are
  gitignored relative to the package (`speepobox/.gitignore`). Root the package at `/` and all four
  land at the repo root, and that `.gitignore` has to move with them. This is the coupling reason 3
  named, and it is real: it is not a rename, it is where the tool writes.
- **`tasks-dir = "speepobox/tasks"` is repo-root-relative** and would become `"tasks"`.
- **`.agentbox/` is a peer.** The parity oracle keeps hae's directory name, which is currently
  unremarkable one level up from the package and becomes a sibling of `src/` if the package roots.
- **Scope of the name change**: 503 occurrences of `speepobox` across 100 tracked files; 40 of those
  files are inside the package, 52 are under `docs/wayfinder/effect-agentbox/`.

## What has to be settled

1. **Does the package root at `/`?** The nesting buys one thing today — hae's dispatcher and this one
   cannot confuse their runtime roots — and that is 05 Q19's data race, which was about *two
   dispatchers on one host*, not two directories. They are already on different repos, so the race
   this nesting was protecting against is not the one it is currently preventing.
2. **If it roots, where does runtime state go?** Repo root (following `packageRoot`, four new
   gitignored entries at top level), or a named directory with `runtime-root` set explicitly for the
   first time. Deciding this is deciding whether `runtimeRoot = packageRoot` stays the default at
   all, or becomes a value the scaffold writes.
3. **The name, in code.** `package.json` name + bin, `defaultConfig.image`, the `AGENTS.md`
   references, and the SPEC. 09's deadline is *before P6* — the shim URL is what adopters pin.
4. **Whether the historical record gets rewritten.** The wayfinder tickets and ADR 0007 record
   decisions taken under the name `speepobox`, including ticket [07](07-name.md), whose entire
   subject is choosing it. Sweeping those to `bessemer` makes the record read as though the second
   rename never happened. Leaving them makes 52 files disagree with the code. A third option — sweep
   the code and the live docs, freeze the closed tickets — needs a stated rule for which is which.
5. **How the sweep runs.** One commit, or expand–contract. A rename with a 503-occurrence blast
   radius is the wide-refactor shape `/to-tickets` names, but nothing here can be half-renamed: the
   directory and the package name are single-valued. Probably one commit with `npm run verify` as the
   gate — but that is a claim to check, not an assumption to carry.
6. **Whether `.agentbox/` keeps its name** once it is a sibling of the package rather than its
   uncle. It is read-never-executed (12), so nothing breaks either way; the question is whether a
   directory named for the tool it is *not* confuses a reader of this repo.

## Notes

**Do this before the `/to-tickets` pass over P2–P6.** Zero issue files exist for any P-bullet, so
those tickets are unwritten and would be authored in the doomed vocabulary and against doomed paths.
Renaming first means the sweep runs over 100 files once, instead of over 100 files now and the new
P-bullet tickets later. This is the only scheduling argument that has a deadline attached to it that
is nearer than 09's *before P6*.

**Does not block [16](16-what-the-tool-keeps-and-who-deletes-it.md).** 16 decides a retention
*policy* — age, count, disk budget, or a property of the run — and its blast radius is `logPathFor`
(`dispatch/plan.ts:33`), which takes the runtime root as a parameter. Moving the root changes what
that parameter *is* and nothing about what 16 answers. The order below is a doc-churn preference,
not a dependency.

**The image story is a separate gap, not part of this.** `config.toml`'s
`image-build-command = ".agentbox/build-image.sh"` names a script whose inputs
(hae's own dependency files) were cut in the
extraction, and `defaultConfig.image` is `"hae-agentbox"`, and `defaultConfig.base` is
`"origin/master"` against a repo whose default branch is `main`. Those are what stand between this
repo and its first self-dispatch. They are named here so they are not re-found as this ticket's
problem, and they want their own ticket.

**The `runtime-root` flip at P7 is a different flip.** 05 Q19's "flipped at switchover" is about
*hae's* config pointing at `.agentbox/` and then not; this ticket's question 2 is about this repo's
own default. They share a config key and nothing else.

## Resolution — 2026-09-09

**The package roots at `/`, takes the name `bessemer`, and stops anchoring anything to its own
directory.** Three acts, and the ticket was right that they are one switchover — but not for the
reason the manifest gave. Reason 3's coupling was never structural: it was the single line
`defaultConfig.runtimeRoot = packageRoot` (`config.ts:81`). Cut that anchor and the three acts stop
holding each other up; they land together here because they are cheapest together, not because any
of them requires the others.

### 1. The package roots at `/`

Yes. The manifest's reasons 1 and 2 were extraction-scoped and expired on schedule; reason 3
dissolves with the anchor above. What the nesting was protecting — 05 Q19's two dispatchers on one
host — was never bought by the *directory*: `~/hae/.agentbox` and `~/bessemer/speepobox` differ
because they are different repos, and would differ just as much with the package at
`~/bessemer`. The nesting has been carrying a justification that repo separation already provides.

Executed as a `git mv`, not a `--path-rename`. The manifest's fallback line (*"add
`--path-rename speepobox/:` to the flags the extraction script builds"*) is moot — the extraction
has run, so this rewrites no history.

**Priced honestly, rooting costs**: one `tasks-dir` line, the `.gitignore` move (`speepobox/.gitignore`
becomes the repo's first root `.gitignore`), and 209 `speepobox/` path occurrences across 78 files
— of which 41 sit in the two frozen extraction records and are not swept at all.

**And it costs one thing the ticket could not see**: `repoRoot` and `packageRoot` become
byte-identical in this repo. `bin.ts:63` is `findRepoRoot(packageRoot)`, which today returns a
genuinely different directory from the package and so catches a conflation locally. Rooted, it
cannot. That coverage was accidental rather than designed — the same species of proxy this ticket
deletes from the freshness guard — but it makes **19's question 6 (an adopter-shape `doctor` probe)
stop being optional**: after rooting, serving a foreign repo is the only thing that can catch a root
conflation.

### 2. Runtime state, and the key that carries it

**`runtimeRoot` defaults to `<repoRoot>/.bessemer`, not to `packageRoot`.** Each served repo holds
its own checkouts, locks, logs and ledger. This is the direct answer to
[the probe's finding 6](research/09-p1-hae-probe-findings.md): anchored to the package, one shim
cache clone accumulates every adopter's working trees and run history, and a repin that re-clones
the cache carries them off with it.

05 Q19's data race survives untouched. hae's bash writes `~/hae/.agentbox/locks`; this tool serving
hae writes `~/hae/.bessemer/locks`. Two dispatchers, two directories — the protection never depended
on the *package* being the anchor, only on the two not colliding.

**The client-override root becomes `repoRoot`, and `runtimeRoot` keeps writes and nothing else.**
This is not a new design question. `paths.ts` already states the rule, in `resolveTasksDir`'s own
comment: *"05 Q19 scopes the runtime root to the ledger, the locks, and the checkouts — write
locations. A spec is a read location, so resolving one under the runtime root conflates the two."*
`resolveTasksDir` and `resolveSetupHookPath` both obey it; `prompt-source.ts` does not, and flags its
own doubt about it at `:28-31`. A prompt override and `project-context.md` are reads and facts about
the repo being served, so they resolve at `<repoRoot>/prompts/<name>.md` beating
`<packageRoot>/prompts/<name>.md`. One caller moves to the right side of a rule the codebase had
already written down; no second key is invented.

`prompt-source.ts`'s `clientIsPackage` guard survives and is still needed — rooted, this repo's
client root and package root remain byte-identical, which is exactly the case it exists to suppress.

**Amended 2026-09-10 by [19](19-the-tool-serves-a-repo-it-does-not-live-in.md):** the root stands,
but the path moves to `<repoRoot>/.bessemer/prompts/<name>.md`, and with it the `clientIsPackage`
guard is **deleted** rather than kept — `.bessemer/prompts/` is never the package's own `prompts/`,
even self-hosted.

**This repo therefore sets `runtime-root` to nothing.** `.bessemer/` appears at its root by default,
because `repoRoot` and `packageRoot` are one directory here. The first exercise of the config path is
P5's `init` writing the key, which is where it was always going to happen.

**Per the map's 2026-09-09 edit, [19](19-the-tool-serves-a-repo-it-does-not-live-in.md) inherits
this ruling rather than deciding it again** — its question 3 is answered above and its question 4 is
answered for both shapes. Its questions 1, 2, 5 and 6 are untouched.

### 3. The name

**`bessemer`**, in full: `package.json` `name` → `@hireanesquire/bessemer` and `bin` → `bessemer`,
the `@effect/cli` name and executable (`command.ts:126,170-173`), `bin.ts`'s usage block, the three
wreckage messages (`checkout.ts:473,692`, `wreckage.ts:235,261`), `AGENTS.md`, and prose throughout.

07 chose `speepobox` because it was the only candidate free on both registries — and 01's clone-run
shim never resolves `name` from a registry, so the constraint that picked the old name does not apply
to the new one. ADR 0008 closed the bake-off for this port, 09 Q10's steps 1 and 2 are done
(the repo's `origin` is already named `bessemer`, verified), and the package trailing the
repo is the last unfinished piece of a decision otherwise complete.

**Rooting deletes one of the three acts outright**: there is no `speepobox/` directory left to
rename. Two touch-point classes remain, not three.

**Nothing owed on the shim.** 09 Q10 step 3's second half — *"repin the shim URL"* — has no subject:
no shim URL is pinned anywhere in this repo and `tool-sha = ""`. It is a future act at P5/P6 with
nothing to edit now.

**Untouched by the rename**: `CONTAINER_PREFIX` is `"agentbox-"`, never `speepobox-`, so no container
naming changes. `docs/wayfinder/effect-agentbox/` is named for neither name. And T40 already put the
image outside the blast radius — the tag `bessemer-agentbox` and `image/` at the repo root were
placed *because* this ticket might move the package, and they name the repo, not the package.

### 4. The historical record — sweep vocabulary, freeze evidence

The rule, and it does not split on open-versus-closed:

> **A document that merely uses the name to talk about the tool gets the current vocabulary. A
> document whose accuracy depends on the name it was written under does not.**

Four frozen sets, each for its own reason:

1. **`.agentbox/`** — a carried snapshot of hae. 12 ruled it read-never-executed; editing it
   falsifies the parity oracle.
2. **The extraction manifest and `T34-extraction-rehearsal.md`** — the `speepobox/` paths *are* the
   record of what `filter-repo` carried. Swept, the manifest would document a move that never ran.
3. **`docs/adr/0007` and `0008`** — this repo supersedes ADRs, it does not edit them. 0008's filename
   is `...-closes-for-speepobox.md` and stays.
4. **`07-name.md`** — the name is its entire subject.

Everything else sweeps: all code and tests, `SPEC.md`, `MAP.md`, every other wayfinder ticket open or
closed, all T-tickets, `image/`, `.github/`, `setup-hook.sh`.

Open-versus-closed was rejected as the axis because **closed T-tickets are read by agents doing
archaeology in the same breath as open ones**, and the `/to-tickets` pass over P2–P6 is about to
author more into the same directory. Two vocabularies in one `issues/` folder is worse than
retrofitted vocabulary in a closed ticket — provided the retrofit is disclosed, which is why **one
dated line goes into `MAP.md`** recording that the rename happened and that closed tickets carry
retrofitted vocabulary. Without it, a reader of a swept closed ticket has no way to tell.

### 5. How the sweep runs — not authored here

The ticket's guess was *"probably one commit with `npm run verify` as the gate — but that is a claim
to check."* Checked, and it is half right and half wrong.

**The rename cannot be expand–contract.** The package name and `bin` are single-valued; there is no
shape in which both names are live. That half is forced.

**But this is not one commit, and the ordering is not free.** Four separable changes, in a forced
order:

1. **The freshness source-set, first and alone.** This is a **pre-existing defect, not a cost of
   rooting** — `speepobox/tasks/` is tracked and holds three real specs, so *today* writing a one-off
   spec marks the dispatcher `dirty` in every ledger row it writes (T43) and a spec landing on the
   base makes it `Stale` and refuses the dispatch (T44). Ten tracked files inside the package are not
   the dispatcher's source. It must land before rooting regardless, because rooted,
   `packagePathspec` returns `"."` and **every** dispatch refuses on any docs commit — 9 of the last
   30 commits on `main` touch no `speepobox/` file.
2. **Rooting** — `git mv`, `tasks-dir`, the `.gitignore` move, `setup-hook.sh`'s path.
3. **The root rulings** — `runtimeRoot` default, the client-override root moving to `repoRoot`.
4. **The name sweep**, under Q4's rule.

**T42's ticket asserts the opposite of finding 1 and is wrong**: *"it stays correct on its own if 18
moves the package."* It does not. The scope was never really "the package directory" — that was a
coincidence of nesting. It becomes an explicit source-set stated once in the pure module both callers
already share: **`src`, `prompts`, `package.json`, `package-lock.json`, `tsconfig.json`, `scripts`**.
`prompts/` is in it because a prompt ships with the tool and is consumed by every pass — a changed
prompt is a changed dispatcher. `test/` is not; nothing in a dispatch runs it. The failure mode is
the unsafe direction — a new top-level source directory silently drops out of scope — so it wants a
test that fails when one appears.

**The implementation is deliberately unauthored**, following 16's precedent in this map: it goes
through a `/to-tickets` pass, which is also the pass that will decide hand-versus-AFK. Recorded as
inputs to that pass: the four-step order above, `npm run verify` as the gate, and the fact that **it
must not race an in-flight dispatch** — T47 landed and T48 was running when this ticket resolved.

**Step 1 was pulled out of that pass, authored on its own the same day, and landed the same day** —
[T49 — The freshness question names its source set](issues/T49-the-freshness-question-names-its-source-set.md),
PR #9. **So step 1 is done and the forced order now starts at step 2.**
It earned the exception on the three grounds this section already states: it is a defect that exists
today rather than a cost of rooting, it is unblocked by everything else here, and the forced order
puts it before the `git mv` however the remaining three steps are sliced. Steps 2–4 still go to the
pass, and T49 is one of its inputs — its guard test is what will force step 2 to declare the repo
root's new top-level neighbours instead of silently widening the freshness scope: it fails when a
tracked top-level entry is in neither the source set nor an explicit not-source list, so step 2 must
declare `docs/`, `.agentbox/`, `image/` and `README.md`.

### 6. `.agentbox/` keeps its name

The ticket said *"nothing breaks either way."* Wrong on the numbers: **310 `.agentbox/…` path
references live in `docs/`**, and T40 counts 182 line-number citations resolving into it.

But the decisive argument is that **Q4's rule already settles it.** `.agentbox/` is frozen set #1 —
evidence, not vocabulary — and renaming the directory *is* editing the evidence. The confusion is
already bounded by T40's standing rule that **`.agentbox/` gains no file of ours**, which is why
`image-build-command` points at `image/build-image.sh`.

**A repo-root `README.md` instead**, which rooting makes owed anyway: rooted, the repo root is the
front door and there is currently no README at all. Three lines of orientation — what this repo is,
that `.agentbox/` is hae's bash dispatcher carried as the read-never-executed parity oracle (12), and
that `.bessemer/` is runtime state.

## Corrections to this ticket's own premises

- **The image trio is fixed, not a gap.** The Notes park `defaultConfig.image = "hae-agentbox"`,
  `base = "origin/master"` and `image-build-command = ".agentbox/build-image.sh"` as what stands
  between this repo and its first self-dispatch. T40 landed 2026-09-08: `config.toml` now reads
  `image = "bessemer-agentbox"`, `base = "origin/main"`, `image-build-command = "image/build-image.sh"`,
  and the code defaults are empty strings rather than hae's values. That whole Note is dead.
- **Blast radius**: 543 occurrences across 114 tracked files, not 503 across 100.
- **`config.ts:54`** is the interface field; the default is `config.ts:81`.
- **Question 6's premise** was wrong — see above.
- **Stale framing, live content**: roughly eight code comments justify themselves with *"during
  incubation"*, a phase that ended 2026-08-21. Each fact they assert is still true, so this is a
  wording sweep and not a re-decision; it rides along with §4's sweep.

## Surfaced

**The carried oracle has no end-of-life.** 09's atomic flip-and-delete happens *in hae*
(Q11: *"it happens in hae, not the tool's own repo"*), and nothing in 09, the manifest, or 12 states
when **this** repo's `.agentbox/` dies. Not this ticket's question — it belongs with P7 and the parity
checklist — but it is now a directory nobody owns, and it goes to the map's *Not yet specified*
rather than being forgotten a third time.
