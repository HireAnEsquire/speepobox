# T34 — Rehearse the extraction

Status: Done
Type: AFK
Blocked by:

Sequence: [ticket 08](../08-in-hae-sequence.md) §6, **move-out gate 5** — the one gate with no ticket
behind it. Gates 1 and 2 are [T12](T12-forge-pr.md) and [T17](T17-feedback.md); gate 3 is `npm run
verify` plus `doctor` under plain `node`; gate 6 was met by `speepobox/config.toml` leaving
`runtime-root` unset. This is the remaining one, and nothing has started it.

Not on any other ticket's critical path — it reads the tree and writes a script, so it runs beside
the T14/T16/T17 chain rather than after it.

**Tracer: a scratch clone outside this repo, carrying speepobox's whole history and nothing of hae's
that speepobox does not need, whose `npm run verify` is green — and this repo byte-unchanged
afterwards.**

## What to build

The extraction is a one-way door, and the whole point of rehearsing it is that the thing which
actually goes wrong is not the `filter-repo` invocation — it is the **manifest**: a path that should
have been carried and was not, or one carried that should have been cut. Units 1 and 2 are what this
ticket is for. Unit 3 is the user running what they produce.

### 1. The extraction script

The extraction script, committed and re-runnable.

**Copy, never move.** The script operates on a fresh `git clone --no-local` into a scratch directory
given as its one argument, and touches this repository nowhere — `git filter-repo` rewrites every
commit in the repository it runs in, so a script that could be pointed at the source is a script
that will eventually be pointed at the source. Refuse to run when the target directory exists, when
it is inside this repository, or when `HEAD` is dirty.

**`--dry-run` first, always.** The script's default is the dry run; performing the rewrite takes an
explicit flag. `filter-repo`'s dry run writes the rewritten commit map without moving any ref, which
is the artifact unit 3 records.

**Multi-path, from a manifest the script reads rather than a list it hard-codes** (unit 2 writes
that manifest, and the two must not drift). `08 §6` names: `speepobox/`, this map and its tickets,
`docs/adr/0004`–`0006`, and `run.sh` + `tasklib.py` as the parity oracle. That list is **stale in one
respect and incomplete in another**, both of which this ticket fixes rather than copies:

- [`docs/adr/0007`](../../../adr/0007-agentbox-effect-typescript-port.md) is this port's own ADR and
  postdates the list. It is carried.
- `.agentbox/`'s tracked residents are more than two files. The parity oracle is whatever a reader
  needs to answer "what did bash do here" — decide it, and say why for each file, including the ones
  cut.

`filter-repo` needs no network and is not in the task image. **Do not install it, and do not run it**
— see _Not in scope_.

### 2. The manifest, and the audit that proves it complete

The extraction manifest: every carried path with one line on why, and
— the half that does the work — **every deliberate cut, with one line on what breaks and why that is
acceptable.** A path nobody thought about is the failure mode; a path listed as a cut has been
thought about.

Then the audit, as a command that runs **inside the container** and is the acceptance gate:
enumerate every reference from `speepobox/` to a path outside it, and assert each one is either
carried by the manifest or listed as a cut. Comments count — a comment naming
`.agentbox/setup-db.sh` in an extracted repo where no such path exists is a dangling pointer, and
those are the whole reason a rehearsal beats a checklist.

The audit will surface at least these, which are named here so a run that finds _only_ these knows it
has not looked hard enough:

- `src/config/config.ts`'s `imageBuildCommand` default is `.agentbox/build-image.sh` — a **value**,
  not a comment, and hae's directory layout baked into the extracted package's defaults. Say what
  the extracted default should be; do not change it here (this ticket writes no package code).
- `src/config/config.ts`, `src/dispatch/setup-hook.ts`, `src/doctor/probes.ts`, `config.toml` all
  name `.agentbox/` in prose as _hae's example of what a host writes_. Those may be fine as-is —
  decide, and record the decision either way.
- The tickets under `issues/` cite `run.sh:NNNN` and `tasklib.py:NNNN` line numbers throughout. That
  is the parity oracle's whole job, and it is why the oracle is carried.

Also decide, and record: `docs/agents/` (the issue-tracker, triage-label, and domain-doc contracts
these tickets are written against), `CONTEXT-MAP.md`, and `docs/contexts/`. They are hae's, and the
tickets depend on them. Carried, cut, or restated in the new repo — pick one and say why.

### 3. What the extracted repo must be able to do

The post-extraction checklist, in the manifest: what a reader runs in the scratch clone to know the
rehearsal succeeded, and in what order. At minimum `npm ci && npm run verify` from `speepobox/`, and
`node src/bin.ts doctor` rendering every row. Whether the extracted repo's speepobox lives at its
root or stays under `speepobox/` is a decision this ticket makes and records — it changes every
relative path in the script.

## Not in scope

**Running `git filter-repo`.** It is not in the task image, and installing it is not this ticket's
business — but the binding reason is that the agent's `/workspace` **is the clone that carries this
branch home**, and `filter-repo` rewrites every commit in the repository it runs in. A rehearsal that
succeeded and lost the run is worse than one that never ran. Write the script, prove the manifest,
and let unit 3 execute it.

Moving anything. Renaming the package, flipping `runtime-root` (a switchover step in ticket 09, not a
move-out step — `config.toml` says so), deleting `.agentbox/`, or changing a single line of
`speepobox/src/`. This ticket adds two files, the script and the manifest, and nothing else.

Deciding the new repository's name, remote, or CI. Ticket 09's.

## Read first

`docs/wayfinder/effect-agentbox/08-in-hae-sequence.md` **§6 (lines 267–290)** — those lines, not the
whole file — plus `speepobox/config.toml`'s `runtime-root` comment and `.gitignore`'s speepobox
block, which is what says which of the package's files are tracked at all. `.agentbox/image-inputs.sh`
is the worked example of a manifest that is read rather than hard-coded.

`git filter-repo`'s `--path` / `--path-glob` semantics are the behaviour source, read as
documentation. There is no network in the task container; reason from the flags the script writes and
mark anything you could not confirm.

**Do not touch hae files** outside the extraction script and manifest, and **do not rewrite**
anything under `speepobox/src/` or `speepobox/test/`.

## Effect wiring

None. This ticket adds no TypeScript, introduces no tag, consumes none, and **`src/app.ts` is
unchanged** — as is every other file under `speepobox/`.

## Acceptance criteria

- [ ] The extraction script clones to a caller-named scratch directory and refuses to run against
      this repository, against an existing target, or with a dirty `HEAD`
- [ ] The dry run is the default; performing the rewrite takes an explicit flag
- [ ] The script reads its paths from the extraction manifest rather than hard-coding them
- [ ] The extraction manifest lists every carried path **and every deliberate cut**, each with its
      reason, and carries `docs/adr/0007` alongside `0004`–`0006`
- [ ] An audit command run inside the container enumerates every reference from `speepobox/` to a
      path outside it and reports each as carried, cut, or **unaccounted** — and reports zero
      unaccounted
- [ ] The `imageBuildCommand` default's hae-specific value is recorded as a known dangling pointer
      with a proposed extracted value, and is **not** changed in this ticket
- [ ] The manifest states whether the extracted repo roots speepobox at `/` or at `speepobox/`
- [ ] `git status --porcelain` shows changes only to the extraction script and manifest

## Verify

```
npm run verify
```

Run from `speepobox/`. Unchanged and green — this ticket touches no package code, so a red gate means
something was edited that should not have been. Then the audit command from unit 2, which must report
zero unaccounted paths.

**Host-only**, run by the user, and the gate itself:

```
pip install git-filter-repo          # or brew install git-filter-repo
<extraction script> ~/scratch/speepobox-rehearsal
```

Then, with the rewrite flag, in the scratch clone:

```
cd ~/scratch/speepobox-rehearsal/speepobox && npm ci && npm run verify && node src/bin.ts doctor
```

And back here, the half that matters as much as the other one:

```
git status --porcelain && git rev-parse HEAD
```

must be unchanged from before the rehearsal. Record the carried commit count and the verify result
on this ticket; that record **is** move-out gate 5.

Do not run the rehearsal against a directory inside this repository, and do not carry
`speepobox/.env` — it holds the agent credential and is gitignored, so `filter-repo` will not see it
unless a path glob reaches for it.

## The record — move-out gate 5

Run 2026-08-18 from `speepobox-t34`, dry run into `~/scratch/speepobox-dry` and the rewrite into
`~/scratch/speepobox-rehearsal`. Both scratch directories were removed after these were taken; the
numbers are the artifact.

- **History carried, not squashed.** 473 commits. The oldest touching the package is `7e3f676 seed
speepobox incubation: AGENTS.md, issue template, hae-side edits (T1 preconditions)` — the commit
  that introduced speepobox, not the clone.
- **Nothing came along.** Top level is exactly `.agentbox`, `docs`, `speepobox`.
- **No cut path survived.** `.agentbox` holds exactly the twelve carried oracle files. No
  `.env.sandbox`, no `setup-db.sh`, no `tasks/`.
- **The credential did not travel.** Zero `.env` additions across all history, and
  `git ls-files speepobox/.env` prints nothing.
- **The package stands alone.** `npm ci && npm run verify` green at 28 files / 462 tests in the
  extracted repo — identical to what the branch runs in hae.
- **hae is untouched.** `git status --porcelain` empty and `HEAD` unmoved after both runs.

`doctor` in the extracted repo reports `image`, `credential`, and `git` failing. All three are
correct: the image was never built there, a fresh clone has no `.env` (which is the credential check
passing, not failing), and `filter-repo` strips remotes by design so a rewritten history cannot be
pushed over the original.

**What the rehearsal found**, none of it visible from inside hae:

1. `abs_path` claimed parity with `realpath -m` and did not have it for symlinks that are not
   directories — 89 divergences over 614 inputs. Fixed; the containment guard tested a string that
   could name a path inside the repository while reading as outside it.
2. The existence refusal ran only on the path as typed, not on the one `git clone` is handed. Fixed.
3. `target is this repository` was unreachable behind an earlier existence test. Fixed by ordering
   the refusals by meaning.
4. The carried image trio cannot build in the extracted repo: `.agentbox/image-inputs.sh` declares
   hae's dependency manifests, both cut. The manifest said "breaks nothing" and
   was wrong; corrected, and `--audit-carried` added for the reference direction the audit does not
   scan.
5. Five of the PR body's manual-testing steps could not run on the host they were written for
   (bash 3.2 vs 4, `python` vs `python3`, `/workspace` paths, a `..` count valid only in the
   container). The PR-description prompts on both dispatchers now state the reviewer's environment.

**Settled from _Not confirmed in the container_.** A `--dry-run` leaves `fast-export.original` and
`fast-export.filtered`, and no `commit-map` — as reasoned, since without `fast-import` there are no
rewritten hashes for a map to hold. It moved no ref.

### The real run — 2026-08-21

The section above records the **rehearsal**. This is the extraction itself, run three days later
from the monorepo clone on the incubation branch into a scratch target. Where the numbers differ
from the rehearsal's, the difference is the point.

**Method changed: a double clone, not a single one.** The monorepo clone → a scratch copy → the
target, rather than the script's own clone straight from hae. Two reasons, and the second was not
anticipated:

1. It puts a second repository between `filter-repo` and the monorepo. The script never pointed at
   hae to begin with — it clones and rewrites the clone — so this guards against the guard itself
   being wrong, which is the residual risk the rehearsal's own finding 1 (`abs_path` vs
   `realpath -m`, 89 divergences) shows is not hypothetical.
2. **It prunes the branch set for free.** `git clone` copies the source's *local heads* into the new
   repo's remote-tracking refs and does not copy the source's remote-tracking refs. The monorepo's
   other local branches stay behind; the copy has one (`tseff`, from HEAD); so the target sees
   `tseff` alone. `filter-repo` parsed the incubation branch's history and nothing else, and the
   result needed no branch deletion, no `gc`, and no second clone to reduce it. Verified against a
   four-branch scratch repo before relying on it.

**The numbers.**

- **History carried, not squashed.** 526 commits, against the rehearsal's 473 — three days of work
  plus the two restores below. The oldest touching the package is unchanged: `7e3f676 seed speepobox
  incubation`.
- **Nothing came along.** Top level is exactly `.agentbox`, `docs`, `speepobox`.
- **No cut path survived.** `.agentbox` holds exactly **twenty** files — the twelve oracle files plus
  the eight under `proto-clack-picker/`, against hae's twenty-seven tracked. Seven cuts.
- **The credential did not travel.** Zero `.env` additions across all history; `git ls-files` finds
  none.
- **Every carried path arrived.** All 22 path flags the manifest yields resolve in the extracted
  repo. This is the check *Verify* step 7 claims the audit performs and does not — see below.
- **The package stands alone.** `npm ci && npm run verify` green.
- **The tool runs under plain `node`.** `node src/bin.ts doctor` renders all nine rows;
  `image`, `credential`, and `git` fail, all three correctly and for the reasons the rehearsal
  already recorded.
- **hae is untouched.** `git status --porcelain` empty, `HEAD` unmoved.

**Four manifest changes were needed first, and one was a genuine miss.**

- `docs/adr/0008` was named **nowhere** in the manifest — neither carried nor cut. Written on the
  19th, the ADR landed on the 20th: stale by one day. Seventeen references from seven carried files,
  `docs/adr/0007` among them, so extracting as-was would have left this port's own ADR citing the
  decision that authorised it as a dead link. **The audit did not catch this** and could not: it
  scans references out of `speepobox/`, and every one of those seventeen is from a carried *doc*.
- `.agentbox/proto-clack-picker/` was added to *Carried* after first being written as a cut. The cut
  reasoning — the `/prototype` skill's *keep the answer, delete the code* — was wrong twice over:
  that rule governs the product line, and ADR 0008 hands this repo to outside teams, for whom a
  pointer into a private monorepo does not resolve.
- One more editor and agent tooling directory added to *Cut*; the others had been named and it had
  not.
- *Verify* step 3's count corrected from twelve to twenty, stale the moment the prototype moved.

**Two files had to be committed to `tseff` before the run**, a consequence of extracting one branch:
`.agentbox/BESSEMER-HANDOFF.md` (tracked only on branches that no longer travel) and
`.agentbox/proto-clack-picker/` (tracked only on `proto/clack-picker`, which exists on **no remote** —
the only copy was one laptop). Both now show as added by a single commit rather than carrying their
original development history. Content intact; archaeology gone. Anything reachable only from a
side branch needs this treatment, and nothing in the tooling says so.

**Correction to _Verify_ step 7.** It claims "a carried path that turned out unreachable shows up
here". The audit does not test existence: its verdicts come from the manifest's carried/cut lists, so
a path the manifest claims to carry reports `carried` whether or not the filter kept it. What running
it in the extracted repo genuinely checks is that the manifest and script travelled and still
execute, and that `git ls-files` returns something for both the package and the root. Expect a
*shorter* report than in hae, legitimately: `TOPLEVEL` and `ROOTFILE` are derived from the repo it
runs in, so hae's root files stop being recognised as bare names. The existence check is a separate
one line, and is what the bullet above records.

**Two hae-side acts this run depended on**, both tags, both for the same reason — a pointer to a
deletable branch is a dangling pointer with a delay on it. Two tags on the private hae repo preserve
the source branches (the port's source, per ADR 0008 consequence 3, and the picker prototype); the
prototype's durable home is now this repo.
