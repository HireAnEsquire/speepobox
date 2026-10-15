# Working in speepobox

`npm run verify` catches everything it can. This file carries only what it cannot: naming rulings,
the error taxonomy, and the calls where two shapes both typecheck and one is right.

Interface shapes, the Scope diagram, and the full design rules live in
`docs/wayfinder/effect-agentbox/SPEC.md`.

**Every rule ends in the ticket that decided it, and the ticket holds the argument.** `(T24)` is
`docs/wayfinder/effect-agentbox/issues/T24-*.md`; a bare number like `(05 Q7)` or `(13)` is the
numbered decision doc one directory up. Read the source when a rule blocks you or looks wrong — the
rule is here so you follow it, the argument is there so you can challenge it.

`run.sh:N`, `tasklib.py:N`, and `.agentbox/…` citations here refer to the deleted parity oracle as of
`6f66e9ac891462de809d207822c77d8f27615663`. These citations, and the commit SHAs and PR numbers in
`docs/`, refer to the **private archive repository**, readable by org members only; every rule
states its claim in place. An org member reads the oracle with
`git show 6f66e9ac891462de809d207822c77d8f27615663:.agentbox/run.sh` in the archive.

## Naming

- Services are named for their **role, not their vendor**: `Sandbox` (not Docker), `Forge` (not
  GitHub), `AgentCli` (not Claude). The tag is the seam — leave provider abstractions unbuilt until
  a second provider exists (05).
- The twelve tags in SPEC §2 are the complete service surface. New capability goes inside an
  existing tag; a genuinely new tag is an issue-level decision — surface it in the PR description
  rather than adding it quietly.

## Errors: the outcome-row test

One test decides every error's kind (05): **if the failure gives the dispatch an outcome — a ledger
row gets written — it is a typed error** in the effect's error channel. **If our own invariant
broke, it is a defect** (`Effect.die`). Both shapes typecheck; apply the test, not taste.

Corollary from SPEC §11: **a ledger row exists iff `RunLock` was acquired.** Guard failures before
the lock are typed errors that write no row.

**`LockHeld` is the collision, not every lock failure.** Its other failures (unwritable runtime
root, lock path is a directory) are a typed `LockError`. The outcome-row test does not separate
them; the dispatcher's next move does. Flattening them reports a broken host as a colleague's live
dispatch (T4).

## Calls where both sides typecheck

Each bullet names the wrong shape as well as the right one, because the wrong one compiles. Before
writing in an area, read **every** rule under its heading: `verify` cannot catch any of these, so
the only thing standing between you and the wrong shape is having read the rule that names it.

### Wiring and config

- **`NodeRuntime.runMain` in `bin.ts` is the only place an effect is run.** Everything else composes
  and returns effects.
- **One `appLiveFor`, composed at the entrypoint and provided to every subcommand**; services acquire
  lazily inside their own scoped constructors (05 Q21). Layer wiring is the top failure mode for
  agent-written Effect (06), so the issue hands you the composition expression to **copy, not
  derive** — reproduce it verbatim and put the resulting `app.ts` composition in the PR description.
- **One layer decodes the provider chain once into `SpeepoboxConfig`. Call sites read the tag.** A
  `Config.*` read at a call site typechecks and is wrong (05 Q7).
- **A list-valued config key is one comma-separated scalar, never a TOML array.** `Config.array`
  merges the provider chain **per index** rather than replacing, and a file that declares the key
  beats flags and env outright. Read the key as a string and split it (`parseCapAdd`) — measured on
  the capability list, where a mixed answer is a container's privileges (T6).
- **The read-only slice's config degrades; the dispatch surface's dies.** `status`, `doctor`, and
  `gc` are intercepted before any preflight so they work when the thing they inspect is broken.
  Giving that slice `speepoboxConfigLiveFor` lets a malformed `config.toml` kill the three commands that
  exist to diagnose it, at layer build. The slice falls back to committed defaults; `doctor` reports
  the failed decode as probe 7.
- **Nothing in `bin.ts` can be asserted, so nothing that owes an assertion stays there.** Importing
  the entrypoint runs the CLI — hence `exit-code.ts` and a one-call teardown. Inlining the mapping
  typechecks, and is how an interrupted run reported success to the shell for six tickets with no
  red test (T19).
- **Rehearsal (`--dry-run`) is a layer swap** — the same effect against no-op recording services. A
  dry-run branch inside an op reintroduces the 78-line drift bug the swap deletes (05 Q20), and
  `scripts/check-bans.ts` refuses one: the flag may be named in `src/` only by `app.ts`, `bin.ts`,
  the parser that declares it, and `src/dry-run/`.
- **A recording layer keeps its reads real, and it is built over the live layer wherever that tag
  has one** (T15). `Git`, `Ledger`, and `Forge` are `Layer.provide`d their live layer, so
  `revParse`, `lastBaseForBranch`, and `prView` answer for real and cannot become a second
  implementation; `Sandbox` and `Notifier` stand alone, because every operation on them is a write —
  with the one exception T76 added and could not keep real, the feature loop's boundary read, whose
  answer lives inside a container a rehearsal never started (`dispatch/feature.ts` says what stands
  in for it).
  `RunLock` looks like the third of those and is not: **acquisition has a read half** — is a live
  pid already working this branch — answered off the lock file through `liveness.ts` as the
  reconciler answers it, which is a classification and not the second arrangement of the claim §3a
  bans. It is what keeps bash's dry-run in-flight check (`run.sh:2285`), and it is load-bearing: a
  rehearsal that claimed unconditionally reaches the checkout step, which clears the directory it
  finds, and that directory is the live run's working copy. `AgentCli` is the live pass over a
  recording `Sandbox`, **provided inside the layer rather than taken from the composition**, so "no
  agent runs" is a property of the layer and not of the wiring — a pass's read half is its prompt,
  which is still assembled and still logged verbatim, because "what would this agent have been
  told" is what a dispatcher runs a rehearsal to see.
- **`--dry-run` writes nothing to the runtime root at all** (T15, narrowed by T38, closed by T48).
  SPEC §2 uses `FileSystem` directly and wraps nothing, so the run log was the one write the tag
  swap did not reach — until the plan itself stopped carrying a log path for a rehearsal: `logPath`
  is absent, `dispatch/command.ts` is where `--dry-run` becomes that fact, and no dispatch op
  learns a rehearsal is in progress. Pinned by `test/dry-run.test.ts`. **The editor bracket's file
  is the one kind of write a rehearsal makes there, on purpose** (T84): `--feedback-edit` and the
  picker's task row both open one. The file is the dispatcher's input, created and removed inside
  the scope, in a directory `FileSystem` mints per session and names for its purpose — no fixed
  name, so two sessions open at once never share one — but on a host with no runtime root yet, the
  root made to hold it stays behind. The two `rm -rf`s that clear
  a *dead* run's leftovers — `dispatch/checkout.ts`'s clear-my-own-path and the reconciler's sweep
  — are outside the swap as well, but **a removal is authorized by a read** now, and a recording
  layer keeps its reads real: a fetch-back that recorded rather than fetched fails the containment
  question, so a rehearsal removes nothing. Reading the flag inside those ops instead is the branch
  this whole shape exists to delete.
- **`Notifier` neither reads the config nor warns about itself: both happen at the call site.**
  `notify = off` means the notifier is *never invoked*, so a live layer that read the level and
  returned `void` typechecks and makes the one thing this tag exists for unassertable — a fake
  counting zero calls. The failure is the same shape from the other end: `notify` fails with a typed
  `NotifyError` and the caller turns it into the `Reporter` warning matrix row 21 owes, because a
  notifier that emitted its own warning would be a subscriber writing to the stream it renders. And
  its host binary is **probed by the spawn**: bash asks `command -v osascript` (`run.sh:1117`), which
  needs a shell this package will not spawn, so an absent binary arrives as the chokepoint's own
  "the child never ran" and degrades to that same warning (T13).
- **A step notification means a phase ended and there is still waiting to do; the terminal
  notification means it is over.** This is not bash's `notify_step` in either direction. The two it
  drops are dropped for different reasons: setup complete (`run.sh:1377`) arrives while the dispatch
  command is still on screen, so it tells a dispatcher who has not walked away something they are
  watching happen; the landing and the PR (`run.sh:1750`) are the end of the run said early, seconds
  before the terminal notification says it again with the verdict *and* the PR URL — two
  notifications a dispatcher reads as two runs finishing. What survives is the per-round verdict and
  the implement pass finishing, the two boundaries with real waiting on both sides of them, and the
  second is one bash has no notification for at all. **A new `ReporterEvent` is not a step
  notification by default**: adding a case to `stepNotificationBodyFor` is a claim that someone
  should be woken, and the rule above is the test it has to pass. **`NoWritesYet` is the one event
  that notifies mid-pass** (T52): it passes the rule from the other end — a pass still reading a
  third of the way into its budget has the most waiting left of anything in the run — and it is the
  one advisory a dispatcher who walked away can still act on, because re-slicing the ticket is
  cheapest while the budget is unspent. Its heartbeat twin `PassStillRunning` notifies nobody: it
  says nothing has happened yet, every two minutes.
- **A pass emits `AgentPassFinished` for every pass, and only when it really finished.** An event
  named for the pass that fires for one pass is an event whose name is a lie — which renderer cares
  about which pass is that renderer's question, and `notifications.ts` is the one that answers
  `implement` only. It sits after the timeout as well as after the exec, so a pass that failed or
  ran out of its budget never says "finished", which would be a second answer to whether the pass
  worked (T13). **It says `PassFailed` instead** (T55): one terminal event per pass either way,
  never both. The failure is still the run's outcome and still travels in the error channel — but
  the typed error renders on stderr at exit, after the run log's bracket has closed, so until there
  was an event for it a killed run's log stopped mid-narration and never said it was killed
  (ticket 20). Both events carry what the pass cost, which is the `claude $ usage` line bash wrote
  and the port had dropped; `usage` on the failure is some only where a `result` event arrived,
  which is the error-result case, because zeros elsewhere would read as a pass that cost nothing.

### Probes

- **A built artifact declares what it was built from, and the probe compares contents rather than
  clocks.** Probe 2 reads `speepobox.inputs` / `speepobox.inputs.digest` off the image and recomputes
  the digest over those files; it reads no timestamp and names no dependency path of its own. Asking
  the clock typechecks and was wrong three ways at once (T30): git rewrites a file whenever it
  differs between two branches, so an mtime says "changed" on every branch hop while the contents
  did not — a warning that is always on, in the one advisory a dispatch shows mid-run; the rebuild
  it named could not clear it, because neither lock file is in that build context; and in a repo
  without hae's three hard-coded paths the whole probe **evaporated** into a permanent `ok` row,
  which is worse than a false positive because nothing says the check stopped running. Two shapes
  that look like the fix and are not: `git log -1 --format=%ct -- <path>` (a fourth answer to "which
  repo is this", silent about an uncommitted input, and it fixes neither of the other two), and the
  input list as a config key (config is the dispatcher's intent, and a list there can disagree with
  what the image was actually built from — silently).
- **An unchecked check is an `ok` row that says so, never a `warn`.** An image predating the labels
  declares nothing, and warning about that on every dispatch until the user rebuilds *is* the
  always-on warning above, with new words. A dispatch interrupts only for something its dispatcher
  can act on about *this* run; `doctor` is where a check that is not running gets read — so the row
  has to say plainly that nothing was compared, or the evaporation above is back wearing a hat.
  What the remedy is called comes from `imageBuildCommand`, not a literal: which script builds a
  repo's agent image is that repo's fact — and unset is the default, so every message that names it
  has to read without one. A path-valued default that ships with the package points into its first
  host's layout from inside every repo that adopts it (T34 caught this one live).

### Guards

- **The guard phase holds nothing, and everything it refuses is a `GuardRefused`** — including
  resolving `--base` to a SHA and taking the merge-base (T18). **Its one write is `git fetch
  origin`** (T70): matrix row 1's invariant is *nothing acquired* — no lock, no clone, no container,
  no ledger row — which a moved `refs/remotes/origin/*` does not dent, and the fetch has no release
  to owe. It runs after the last local guard and before anything below reads a remote-tracking ref,
  so a typo'd `--branch` still costs no round trip, and the base is resolved **once**, out of what
  that fetch brought back. A guard may *ask* through `Git`, but maps the `GitError` onto its own
  refusal — the fetch's included, which carries git's own line because no network, no `origin`, and
  a refused credential are three different repairs; letting one escape hands the dispatcher a
  run-time failure for bad input (T5).
- **The issue set is read at the branch tip, and never at `BASE_SHA` or off disk.** The checkout
  clones the tip, so the tip is the ref whose content the agent sees (15's fork commit, 14's branch
  tip); `BASE_SHA` is the diff boundary's *other* end, and a read of the working tree typechecks and
  answers for whichever branch the dev left checked out. So the tip is resolved once in the guard
  phase, onto `DispatchPlan.tipSha` for every arm, and the set comes through `IssueStore` — which
  reads git objects and materializes nothing, so a folder no ref carries refuses rather than falling
  back to the host tree the way `run.sh:1017-1030` does (T73).
- **Two witnesses for "someone else already has this issue", and they degrade differently.** Under
  `--issues all` the selection is asked of git — any *other* ref whose copy says `Done` is a hard
  refusal, because that answer is host-independent and self-correcting (14) — and then of the ledger,
  whose row naming another branch refuses but whose `LedgerError` is a `Warned` the check passes
  through (derived state, SPEC §10). An enumerated `--issues` **skips both outright** rather than
  running and ignoring them: the scan is two git processes over every ref, and a check whose answer
  is discarded is a check a reader will one day believe was made (T74).
- **A required flag whose absence must be a typed refusal is parsed as optional.** `@effect/cli` can
  enforce `--branch`, but then one of the six dispatch refusals arrives with a different shape and a
  different exit path. The parser parses; the guards refuse (T3).
- **A config-declared path asks two questions, and neither is the container's.** *Where* the setup
  hook is — anchored to the repo root, derived once, read by both the mount and the `Sandbox.exec`
  that runs it — is pure. *Whether it is there* is a guard. Deriving the in-container path a second
  time at the call site lets the mount and the command drift; checking existence inside the run
  answers a mistyped key three held resources late, against a bind docker has already invented a
  directory for. A config naming no hook is a third thing: no step, not a failed one (T7).
- **Spec resolution: "used as-is" is about the directory, not the suffix.** A slash keeps the path
  out of the tasks dir's reach; `.md` is appended on both arms (`run.sh:859-860`). Both arms land
  absolute, the slash one anchored to the working directory. bash gets that by `cd`-ing to the repo
  root first (`run.sh:235-236`); nothing here does (T3).
- **The four `--task` refusals are decided from the command line alone, and run ahead of everything
  this phase asks of the world** — the ledger included. A `<spec>` beside it, a `--resume`/`--last`
  beside it, a `--feedback` beside it, and an empty value are all facts about what was typed (22 §6
  rows 10-13); a resume resolved before them answers a collision with *no ledger record for branch
  'b'*, which is a refusal about the wrong thing and one the dispatcher cannot act on. The empty
  case reads the flag **as typed**, not the trimmed-and-filtered value the rest of the dispatch
  takes: after that filter `--task ""` and no `--task` at all are one value, so an empty one falls
  through to `specGiven` and a dispatcher who typed the flag is told *a task is required — pass
  `<spec>`, `--task "…"`, `--feature <folder> --issues …`, or `--resume <branch>`* and left to work
  out which half of that sentence was theirs. That shape typechecks and is wrong; the refusal has to
  be about the emptiness (T67).
- **A resume recovers a dispatch's inputs; the identity it records is decided with them.** The mode
  comes off the record's union tag, so it is read exactly once — in the dispatch, where `--resume`
  resolves the branch, the spec, and the base — and the `FeedbackResume` that wraps it travels on
  the `DispatchPlan` with everything else that was resolved. Building the row's identity where the
  row is *written* typechecks and silently unmakes every resume: that is a finalizer, and a
  finalizer sees how the run ended, never what it was for — it would have to re-derive a
  `OneOff` from the spec path and the chain would break at the first repeat (T16).

### The lock

- **A lock file is written by the claim, never by an exclusive create.** `writeFileString` with
  `flag: "wx"` publishes the name before the pid, and empty is "an owner nobody can name"
  (`liveness.ts`) — a live run's lock, reclaimed one syscall old. The temp file plus `link` in
  `lock/claim.ts` publishes a complete lock or none, so `AlreadyExists` from the link *is* the
  collision (T20).
- **A stale lock is evicted under a witness, and the witness is read back before the removal.**
  `fs.remove(file, { force: true })` on a dead owner is the reclaim race; linking the corpse to
  `<lock>.<dead pid>.evicting` hands the removal to one dispatch through the kernel. Reading the pid
  back names the generation — anything but the owner this run found dead is a lost eviction, which
  is a `LockHeld`. No timeout, no age check: SPEC §6 refuses a second staleness rule here (T21).
- **The witness's link is a bracket's acquisition, not a step before an `ensuring`.**
  `Effect.ensuring` leaves the link interruptible, and a Ctrl-C in flight strands a witness that
  refuses every later eviction of that corpse. `Effect.acquireUseRelease` takes the link
  uninterruptibly and delivers the interrupt to the eviction (T21).
- **The evictor names itself beside the witness, before it takes the link.** The witness says which
  *corpse* is being evicted and never who is evicting it — it is a second name for the corpse file,
  so its contents are the corpse's pid — and an eviction in flight belongs to a dispatch that holds
  no lock yet by definition. So nothing on disk could tell a stranded witness from a live eviction,
  and a `kill -9` in that instant wedged the slug **permanently**: every acquisition collided on the
  same witness path forever, and the reconciler's reclaim goes through that same acquisition, so
  nothing on the host would ever clear it. The evictor writes `<witness>.<pid>.<attempt>.evictor`
  first and takes it back with the witness; **a witness whose evictor is not alive is debris**,
  which is the whole rule and covers T8's gone-lock case as one of its two halves (T26).
- **Three shapes that carry the evictor's pid and are all wrong** (T26). *In the witness path*
  (`<lock>.<dead>.<evictor>.evicting`): two evictors compute two destinations, both links succeed,
  and both remove the same corpse — the path must stay a pure function of the lock file and the dead
  owner, because that is what makes `link` the arbiter. *Inside the witness*: a write to it is a
  write to the lock, which `claim.ts` and the reconciler read as the owner. *In a shared sibling*
  (`<witness>.evictor`): the loser of the link wrote one too, so its release takes the winner's name
  away — hence the attempt serial, `claim.ts`'s, making the marker per-eviction rather than
  per-process. No timeout either: an "old enough to be stale" witness is the staleness heuristic T20
  replaced with an atomic primitive, and the recycled-pid window this leaves is the one the lock
  itself already lives with (`liveness.ts`), narrowed by sweeping dead markers on sight.
- **Acquisition still refuses on a colliding witness.** Reading `AlreadyExists` as "probably stale,
  proceed anyway" would un-serialize eviction and reinstate the double-remove T21 closed. The
  stranded case is the *reconciler's* to clear, on the pass before it evicts anything (T26).
- **The run log opens after the lock, never before.** Opening it early touches another run's state,
  and a dispatch refused by `LockHeld` must leave the live run's log alone (`run.sh:1210-1221`) (T4).
  **Corollary: the lock's own two events stay off the log at both ends** — the log lives strictly
  inside the lock's bracket. Every other resource inside the bracket does reach the log; the console
  keeps the whole ordered stream (T18).

### The reconciler

- **A dead lock answers for its whole run; "the sandbox is not running" answers only where no lock
  does.** All three of SPEC §4's conditions hold before a reclaim; reading the third as a veto over
  the second leaves the `kill -9` case unreclaimed forever, since the image's entrypoint is `sleep
  infinity`. The running-container condition refuses a container **no lock names**, which another
  dispatcher (a second runtime root, bash's `run.sh`) may still be working in. The ledger is never
  consulted either way (T8).
- **The reconciler reclaims by acquiring, and sweeps every witness no live evictor is standing
  behind.** `RunLock.acquire` *is* T20's claim and T21's witness composed; a second arrangement
  beside it is the third implementation §3a bans. `LockHeld` there is the race with a live dispatch:
  report and touch nothing (T8). The sweep runs **before** the reclaim loop, and that order is what
  lets one pass clear a wedged slug: the reclaim collides on exactly the witness the sweep just
  took away. It decides from the directory listing alone — the marker's *name* carries the evictor's
  pid, so nothing is read and a half-written file cannot vouch for anybody — and it asks only about
  the evictor. Sweeping on the lock's presence would take a live eviction's witness and hand that
  corpse to two dispatches, which is what T21 exists to prevent (T26).
- **A checkout with no lock beside it is reported, never reclaimed.** The lock is taken first and
  released last, so a run killed at any point leaves one beside its checkout — a lone checkout is a
  directory somebody already declined to delete. Ordinarily that is the run's own release, which
  keeps it only when neither of its two destinations would take the commits, so the clone holds the
  only copy of them (`checkout.ts`, 05 Q10, T29); since T38 it is also a reclaim that took the
  killed run's lock and container and could not confirm the commits in the copy are anywhere else.
  Reading that as wreckage typechecks, and is bash parity only by shape — bash cleared a
  checkout on the next dispatch of *that same slug*, so whoever lost the commits had chosen to
  dispatch that branch again, while this pass sweeps every slug on every preflight. A successful
  fetch-back followed by a failed removal reaches the same state and nothing on disk tells the two
  apart, so it keeps a disposable directory rather than deleting an irreplaceable one, with P4's
  `gc` as where a human removes what it will not. A marker written on the keep path is the keep flag
  `checkout.ts` forbids wearing a hat, and is absent exactly where it matters most — a run killed
  before it could write one (T25).
- **And a checkout the pass *does* reclaim goes only after a read says the commits in it are
  somewhere else.** The reclaim's evidence is a lock naming an owner that is not alive, which is
  exactly the run whose release never got to move anything — so the scan establishes the opposite
  of what its own failure message used to assert ("its commits are already home"). It asks the
  question the salvage asks, with the same two operations: the tip read in the copy, the ancestry
  asked in this repo. That is one tag more than T8 needed and no operation `Git` did not already
  have; the scan itself still reads `.git/HEAD` as a file, because it walks every slug and a `git`
  per directory is not what a preflight is for. Unconfirmed keeps the directory and prints the
  recovery `keptCheckoutNotice` already hands a dispatcher (T38).

### The checkout and the land

- **The release's salvage tries the branch it was given, then a branch of its own, and keeps the
  clone only when neither takes the commits.** `git fetch` refuses a non-fast-forward update but
  does not refuse to *create* a ref — the fast-forward check applies only to refs already present —
  so the exact case that refuses `refs/heads/<branch>:refs/heads/<branch>` succeeds unconditionally
  as `refs/heads/<branch>:refs/heads/<branch>-from-run-<short>`. **The name is taken from the
  commits, never the clock**: the SHA is the clone's `HEAD`, so two failed runs on one branch leave
  two branches (they are different work) and a rerun at the same tip is a no-op rather than a
  collision. Two shapes that typecheck and are wrong: forcing into a fixed `<branch>-from-run`,
  which silently destroys the previous run's commits; and hiding the ref under `refs/speepobox/…`,
  which is a ref the human never sees and so never merges. **No `+` and no `--force` on either
  destination** — a rescue ref that exists and is not an ancestor must refuse. The rescue lives in
  the release and never in the land (a land that partially succeeded is worse than one that failed),
  it swallows its own failure exactly as the home fetch does, and it decides where the commits live,
  never whether the run succeeded (T29). A branch the served repo cannot read is not a destination:
  the salvage asks before it fetches, because the fetch would create it, and goes straight to the
  rescue (T107).
- **The slug's own re-dispatch may salvage and clear its kept checkout; the sweep over other slugs
  may not.** `git clone` refuses a destination that exists, so a kept copy makes the one branch you
  most want to re-run the one you cannot — until a human finds the directory. The remedy is bash's
  authority given back to exactly where bash had it (`run.sh:1161-1162`): the next dispatch **of
  that same slug**, inside the `Scope`, under its own lock, at the moment the path is about to be
  used. T25's rule is untouched — the reconciler still reports every other slug's kept copy and
  touches none of them, because a pass that clears a *neighbouring* slug's directory is the
  behaviour T25 exists to stop, rebuilt in a new place. **The fetches and the read that checks them
  are the only things that decide**, at this end as at the other: home, then a branch of the dead
  run's own, and the directory goes when the commits are reachable from a ref somewhere else (T38).
  A marker, a "is this a real repo" read, or a "does it hold unpushed commits" probe is the keep
  flag `checkout.ts` forbids, in a different coat. **One function, two call sites** — a second copy
  of the two fetches drifts, and the copy nobody watches run is the one that drifts. They differ
  only in what they do with the answer: the release warns and swallows (a finalizer that fails
  becomes a defect), the acquire fails the run at stage `checkout` with the row the held lock owes
  (SPEC §11). A directory git cannot read at all refuses too, deliberately — rubble from a
  half-written clone is indistinguishable from a branch that will not fast-forward, so the refusal
  keeps it and says the `rm -rf` is the reader's to run. It is **not** a guard: a guard holds
  nothing and writes nothing, and two fetches into the repo are a write (T28).
- **`--hard-reset`'s reset stands inside the checkout's acquire, after its salvage and before the
  clone, as a compare-and-set against the guard-read tip** (T101). The guard phase holds nothing
  and writes nothing but the fetch, so the reset is under the lock. The wrong shape that
  typechecks is a reset before `checkout()`: the acquire's clear-my-own-path salvages a kept copy
  of this slug by fast-forwarding its commits onto the branch, which puts the discarded commits
  straight back and silently undoes the reset. After the salvage, a branch that moved — the
  salvage's own `WentHome`, or anything else — fails the `update-ref` at stage `checkout`
  with nothing reset and nothing cloned, and the sentence says which moved it.
- **A refused fast-forward is not proof the commits are homeless: ask the repo before minting a
  rescue.** Fast-forward-only refuses two situations and only one of them wants one — histories that
  disagree, and a branch standing *ahead* of the copy, which is what an earlier fetch home leaves
  behind as soon as anything moves the branch on (a merge, a hand commit, the dispatcher's own
  status commit). Treating both as the rescue's case mints refs holding nothing anyone needs to look
  at and — worse, because it is what a human acts on — says the commits *would not go onto* the
  branch while they are sitting on it. So the salvage asks `merge-base --is-ancestor` in the **host
  repo**, about the tip read in the copy, and a branch that already holds them answers `WentHome`.
  bash carried the identical defect in `cleanup()`, where it reported a diverged branch on every
  successful run (`8f3f513ee0`). Four shapes that typecheck: asking ancestry *instead of* the fetch
  (the fetch is what moves the commits in the common case, and it is one round trip — the read
  belongs *after* it, which T38 then made "after it on both arms"); comparing the two tips for
  equality (equal tips are one case of contained, and branch-is-ahead is the case that bit us);
  asking the question in the copy, which cannot know what the repo holds; and a fourth `Salvage`
  arm for "already there", which is a ledger value meaning what `WentHome` already means. A tip the
  repo has never seen is **not contained** — git refuses to answer rather than answering no, and
  that refusal is exactly the rescue's case (T32).
- **A removal is authorized by a read, never by a write's return value.** T32 asked the containment
  question only where the fetch had refused; on the other arm the salvage answered `WentHome` on
  what `fetchBack` *returned*, and the caller then `rm -rf`'d the directory those commits were in. A
  fetch reporting success and the commits being reachable in the destination are two different
  propositions, and it is the second an irreversible removal depends on — a partial fetch, a
  refspec that lands somewhere unexpected, or a recording `Git` all produce the first without the
  second. So the question is asked **after every fetch, about the ref that fetch claimed** — once
  after the branch attempt, covering both the refused and the returned-success arms, and again
  after a rescue's, about the name the rescue minted. Every `rm -rf` of a checkout stands behind
  one: the release's, the acquire's clear-my-own-path, and the reconciler's sweep, which had no
  read in its path at all while its own failure message asserted the commits were home. The rescue
  arm is the one where a return value costs most, because a rescue happens only after the branch
  refused — so by then the copy is the sole known home of the work. A success that moved nothing is not a refused fast-forward and does not borrow its
  sentences — nothing refused, so no git error is quoted and no rescue is minted; the copy stays
  and the message names the commit the question was asked about. Where a read cannot confirm it,
  the answer is the `Kept` one that already exists. **A copy that is not on disk was not kept**:
  every `Kept` sentence is about a directory that is still there, so the release asks the same
  `fs.exists` question the acquire already asked before it salvages, and a path holding nothing
  releases the resource silently instead of telling a dispatcher to fetch from it. A rehearsal
  reaches that line because it recorded its clone rather than making one; a run whose copy vanished
  under it reaches it the same way, and neither learns which it is (T38).
- **The terminal ledger row is a finalizer of the run's `Scope`, registered immediately after the
  lock — never an `Effect.onExit` on the work.** Finalizers run in reverse of registration, so a row
  registered after the lock's and before the checkout's is written once the checkout has released
  and while the lock is still held, which is the only position it can carry the release's answer
  from: *where this run's commits ended up* is decided by the checkout's release, and that runs
  strictly after the work's `onExit`. The shape that hides this is the one to know — a `Ref` the
  release writes and the row reads typechecks, records the field as silently always absent, and
  passes every test written against a release that went home. SPEC §11 is unchanged and better
  served: the row is owed *from the lock* and is now written from the lock too — the registration
  sits inside the lock's bracket and inside the `uninterruptibleMask`'s protected stretch, so a row
  still exists iff the lock was acquired, and `Effect.scoped` closes the scope with the work's own
  exit, so a `checkout`- or `sandbox`-staged failure names the stage it always did. Three more
  shapes that typecheck: a *second* ledger line for the rescue (SPEC §11 says exactly one terminal
  row per run, and a second makes `lastBaseForBranch`, the `status` grouping, and every count in the
  ledger ambiguous about how many runs happened, to record a field); releasing the checkout outside
  the `Scope` so it runs before the row (the design rule — three resources, one scope, reverse order
  — traded away for a field, and a checkout released outside the scope is not released on the paths
  the scope exists to cover); and recording the rescue on the row of the *re-dispatch* that salvaged
  a dead run's kept checkout on its way in (T28's salvage moves commits whose row was written and
  notified long ago) (T31).
- **A record field every earlier line simply lacks is spelled as an absent key, and does not bump
  `CURRENT_SCHEMA_VERSION`.** `Schema.OptionFromNullOr` — the record's spelling for every other
  absence — wants the key *present and null*, and every version-1 line already on a dispatcher's
  disk carries no such key at all; those are the lines `status` exists to show, so
  `Schema.optionalWith(…, { as: "Option", nullable: true, exact: true })` is the requirement and
  `Option.none` encodes back to no key rather than to a null or an empty string. The schema admits
  one version literal, so bumping it for an addition every version-1 line already satisfies either
  drops every version-1 line outright — `Schema.Literal` admits exactly that one — or buys a second
  literal nothing branches on. A version goes up when a line written under the old number can no
  longer be read as itself (T31).
- **What a run cost is four counts on the row and one number on the screen.** Bash stored the sum
  (`run.sh:2188-2210`), and on a real run the cache reads swamp it — a pass reporting
  `in=164 out=38700 cache_write=132393 cache_read=8067677` makes 98% of an 8.2M-token row its
  cheapest component, so a row that generated 8M tokens of output and one that re-read a warm cache
  render identically. Summing is the renderer's (`status/render.ts`) and stays reversible; a sum
  written into the row cannot be taken apart again. The figures are folded off `AgentPassFinished`
  and `PassFailed` into a `Ref` the finalizer reads — re-parsing the log for them typechecks and
  leaves the record underivable from the event stream (05). **A pass that reported four zeros is
  counted nowhere**: that is a rehearsal's or a fake's pass, and a denominator with no numerator
  under it reads as a pass that cost nothing rather than as one nobody measured (T53).
- **The land fetches the checkout back itself, and the release fetches it again — not a duplicate.**
  The release's fetch is the salvage *every* exit path gets, so it takes an opinion from nothing
  above it and swallows its own failure by design (05 Q10, rule 4). Letting it stand in for the
  land's fetch turns matrix row 13 into a warning underneath a `Completed` row. The land is in the
  scope's `work`, staged by the exported `atStage`; unstaged it records `Crashed` for a failure the
  run can name (T11).
- **The status commit is built in the served repo with plumbing, and its failure is a warning.**
  `IssueStore.markLanded` runs in `land.ts` between the fetch-back and the push, once, for every
  issue this run approved, and only when `thisRun > 0` — commits past *this run's* tip, never the
  branch total, so a run that produced nothing pushes no bookkeeping. It resolves the branch to a
  SHA once, reads blobs at it, builds the tree in a scratch index under the runtime root's `locks/`
  (`GIT_INDEX_FILE`, handed per call to the three children that read it, never forwarded; removed
  afterwards, written or not), and `commit-tree`s on that SHA and `update-ref`s expecting it: no
  working tree, no hooks, and a branch that moved meanwhile fails the move instead of losing a
  commit. Two shapes typecheck and are wrong: running git **in the clone** after
  the agent touched it — its `.git/config` is the agent's, so a `core.fsmonitor` or a hook there
  runs a command of its choosing; and letting the failure **propagate past the push** — the
  fetched-back commits are in hand and unpushed, and a bookkeeping step may not cost the run its
  work. It is a `Warned` naming the stems and git's words, and the push, the PR, and the row all
  still happen (T77).

### The agent passes and the review

- **A failed agent pass ends the run** (05 Q16R). `AgentCli.implement` is single-shot; the failure
  surfaces as a typed `AgentPassFailed` the caller reports. What the *caller* makes of it is the
  caller's: inside a feature loop it is the issue's outcome and the sequence's stop, never the run's
  error (T76, below).
- **The pass budget is the caller's timeout; the in-container `timeout` set past it is a backstop,
  never the budget.** bash's `docker exec … timeout …` (`run.sh:1153`) caps only one of the three
  things that can hang — the daemon and the CLI are outside it. `Effect.timeoutFail` over
  `Sandbox.exec` caps the pass wherever it hung, and decides every live run's outcome; the interrupt
  closes the exec's scope, killing the docker child. Cost: the case is **live-clock**
  (`it.scopedLive`), because `TestClock.adjust` would race the timeout's own sleep registration. But
  that timeout lives in the dispatcher, so a dispatcher killed with `kill -9` left its agent working
  unsupervised, with the run's credential, until a later reclaim removed the container — and killing
  the `docker exec` client never stopped the process inside it. So `agentPassCommand` runs the CLI
  under `timeout -k 30 <budget + 60>`: the grace puts it past the dispatcher's, so on a live run it
  never fires, and exit 124 reaching the dispatcher is a defect of the arrangement with no
  `AgentPassReason` of its own. Two shapes that typecheck: the prefix *at* the budget, which races
  the dispatcher for the outcome; and a container lifetime, which is no one number because a run's
  budget spans passes, rounds, and feature issues (T9, T139).
- **"Did the sandbox go" is asked of the daemon, and only `Sandbox` may ask it.** A predicate over
  docker's English only ever matches the daemon *refusing* to exec against an already-dead
  container; a container removed mid-exec reports the child's SIGKILL and says nothing about a
  container. `docker inspect` on `handle.id` is safe because **container ids are never reused**.
  Asked on the failure path alone, travelling as `SandboxError.sandboxGone` — a boolean, because the
  third state is `AgentPassReason`, `AgentCli`'s vocabulary. It does **not** say why the child died:
  `.State.OOMKilled` is the *container's* OOM state, `false` for exactly the
  agent-OOM-killed-inside-a-living-container case this tells apart (T22).
- **The verbatim prompt is the one run-log event deliberately not one line**, because "what exactly
  was this agent told" is what the log exists to answer (`run.sh:1144-1149`). **It names the root the
  template came from as well** (T14) — a client extends this tool by dropping a file in, and that
  line is where they see it take. Two shapes that typecheck: writing the provenance *into* the
  prompt, which the agent then reads as instructions, since those bytes are what it is handed; and
  announcing it from the prompt layer through a captured `Reporter`, which is the layer-capture
  `AgentCli` keeps `Reporter` in its requirements to avoid — the run log's subscriber is provided at
  the call site, so a root said from the layer reaches the console alone. `PromptSource` therefore
  emits nothing at all: it answers `get` with the text *and* the root, and the pass that logs the
  prompt logs the root beside it.
- **The two prompt roots are the served repo's speepobox directory and the package, and they cannot
  be one directory** (T59, retiring T14's guard). A prompt is a read location, so an override is
  `<repoRoot>/.speepobox/prompts/<name>.md` and the layer takes the served repo rather than the
  config: the runtime root decides where this tool *writes*, and moving it moves writes only. T14
  had to guard the collision because the client root was the runtime root, which defaulted to the
  package — `<runtimeRoot>/prompts/implement.md` *was* then the file the package ships, and a
  bare "does it exist" reported an override nobody wrote in the one line a reader checks to confirm
  theirs took. `.speepobox/prompts/` is never `<packageRoot>/prompts/`, self-hosted or not, so the
  case cannot arise and **no guard stands there**. Putting one back — a `repoRoot === packageRoot`
  comparison, or the resolved-roots one that used to be here — typechecks, and makes this repo's own
  overrides unreadable while it dispatches into itself.
- **The `project-context.md` fragment is a second method on the tag, because absence is an answer
  there and a defect here** (T14). `get` dies when neither root ships a pass prompt — our invariant,
  which no client action fixes — while a client who wrote no fragment has said everything they meant
  to. Routing the fragment through `get` either kills runs over a file nobody has to write or softens
  the missing-default rule into a shrug for every prompt. The same split decides the empty file: an
  empty *pass* prompt is a typed `PromptUnusable`, since a whole-file override replaces the default
  outright and hands the agent nothing but the dispatcher's message, and an empty *fragment* is
  `Option.none`, because a fragment only ever adds. And it is **appended** to whichever template won,
  never patched into one: a placeholder in the defaults typechecks and is the mini-templating-language
  05 Q9 rejected by name, and appending is also what lets a client who replaced a prompt outright keep
  their fragment.
- **The review verdict reaches the ledger row through a `Ref`, not the scope's success value.** The
  row is written from a finalizer, which sees *how* the run ended, not what it decided on the way.
  `outcome` answers what the review decided, `terminalReason` why it stopped — a capped run has
  both, a crashed one only the second (matrix rows 11-12) (T10).
- **The verdict is the *last* well-formed marker, not the first — the port's first deliberate
  divergence from bash.** `run.sh:1349-1372` takes the first `<verdict>approved</verdict>` anywhere
  in the output, so one the reviewer wrote *about* rather than meant wins. The failure is silent,
  asymmetric (only ever unapproved → approved), and ships unreviewed work. A reviewer describing a
  review loop is the one most likely to type the marker, which from here on is every reviewer in
  this sequence. No tag, and an unknown token inside a well-formed tag, are both `needs-work`;
  neither falls back to an earlier marker. Two shapes that look like fixes are not — see the
  ticket (T24).
- **The PR body is the span between the *first* opening marker and the *last* closing one** — the
  opposite end of the same argument, because a verdict is a token and a body is a span. Taking the
  last opening tag would truncate a description that quotes the markers while explaining them,
  which the PR for this very change had to do; first-and-last keeps quoted markers as body text,
  and discards preamble before the block and sign-off after it by construction. The prompt had
  forbidden narration in its own section since T12 was written and the first live run narrated
  anyway, straight into the PR body — so the prompt now also says where narration may *legally*
  go, because a bare prohibition is what already failed. An output with no well-formed block is
  `""`, which the caller already turns into the static body, and it warns rather than shipping
  text no marker vouched for (T12).
- **The work is handed what the scope holds, and what it opens reaches the row through a `Ref`.**
  `runInScope` takes `(context) => Effect` and passes the started handle: rebuilding one from
  `plan.containerId` typechecks and addresses the sandbox by **name**, the one thing the daemon
  cannot answer authoritatively for (T22's id-not-name ruling, from the other side). The PR travels
  as the verdict does and for the same reason — returning it as the work's value loses it on every
  path that fails after the create, which is every path this step exists to survive (T12).
- **A tag whose *every* method leaks a requirement trips a diagnostic; the answer is the annotation,
  not the capture.** `AgentCli` keeps `Reporter` in `implement`'s requirements on purpose — a
  reporter captured at layer build sends prompt and output to the console alone.
  `leakingRequirements` stays quiet until a *second* method does the same, which `review` does —
  capturing it at that point typechecks and silently unsubscribes the log.
  `@effect-expect-leaking Reporter` says the pass-through is the design (T10).
- **What a pass is for is a value on the plan, and it is one union with two arms** (T17, collapsed
  by T66). `Task` is `Spec { path, feedback: Option }` or `Inline { text, feedback: Option }`,
  resolved with everything else a dispatch decides before it acquires anything, and T16's decision
  table answers with the same shape. The **path rides on its arm**: `DispatchPlan` has no `spec`
  field, because a resolved path has no meaning on the other one, and a plan-level field that every
  reader had to consult the arm before trusting is a field that will be trusted. The text carries
  the task itself rather than a flag saying there was some, so a run with nothing to do is
  unrepresentable rather than remembered. `feedbackIn` means *the dispatcher's feedback, whichever
  arm* — on `Inline` it answers `feedback` and never `text`, because the text is the task and it
  travels in its own section of all three messages. The dispatcher's text is trimmed and
  emptiness-filtered **once**, at the door, so "was there feedback" has one answer: an empty
  `--feedback` is a dispatch that said nothing and still refuses a resume whose spec is gone. `--task`
  goes through the identical filter at the identical door (T67), for the identical reason.
- **The ledger row carries an inline task's text verbatim, and the version does not move for it**
  (T67). `DispatchIdentity` grew a third arm — `InlineTask { task }` — rather than `OneOff { spec:
  "" }`, which is the nullable pair T2 deleted, and rather than a pointer into the run log, which
  breaks replay the day the log is moved or pruned: replay is the row's job (22 §4). The resume
  reads it off the tag with the others, and `FeedbackResume` admits it through the union it already
  wraps. `CURRENT_SCHEMA_VERSION` stays `1` on **T31's rule** — a version goes up when a line
  written under the old number can no longer be read as itself, and growing a union an arm is not
  that: every version-1 line on disk still decodes, because no existing line's shape changed, and
  bumping would either drop all of them (`Schema.Literal` admits exactly one) or buy a second literal
  nothing branches on. The unchanged number buys nothing in the other direction, and the comment on the
  constant says so rather than leaving it read as a promise: a row carrying the new arm fails to
  decode under a speepobox older than this ticket, which bites a rollback over a ledger the tool has
  since written to and nothing else.
- **The *resuming* framing comes from the identity, never from the arm** (T66). A run resumes iff
  its identity is a `FeedbackResume` — true of a spec resume as much as of an inline one, false of
  every fresh dispatch — so `isResume` is what the implement message's resuming sentence and the
  PR-context fetch are both keyed off. A sentence keyed off the arm typechecks and is false twice
  over: on a spec resume, which needs it and until T66 never got it, and on a fresh inline task,
  which does not. The prompt functions stay pure over `PassRun`, which carries the identity for
  this and reads the plan for nothing.
- **Which issue a pass is for rides on the pass, and its build-on sentence is keyed off the
  boundary** (T75). A feature run's passes are for different issues and the branch moves under
  them, so `CurrentIssue` — the issue and the SHA the branch stood at when its implement pass began
  — is handed in beside the plan. A field on `DispatchPlan` typechecks and freezes at the one value
  the guard phase resolved, before anything was acquired. The sentence sending an implement pass to
  read what earlier issues left is keyed off `boundary !== mergeBaseSha` and **not** off the
  identity: it is true from the second issue of a *fresh* run onward, which no identity says
  anything about, while the resuming sentence above stays the identity's. A run carries both, and
  they say different things — this branch holds work from a run before this one, and this branch
  holds work from the issues before this one.
- **A per-issue boundary is read in the container, never by host git in the clone** `(T76)`. The
  SHA a feature run's issue begins at comes back from `Sandbox.exec`'s `git rev-parse HEAD`
  (`dispatch/feature.ts`). `Git.revParse` against `plan.checkoutPath` typechecks, reads fine, and is
  the hole `run.sh`'s own land step already guards: the agent owns that clone's `.git/config`, and a
  `core.fsmonitor` written there runs a command of the agent's choosing — with the dispatcher's
  credentials — on read-only operations too (decision 2 of 09's comment of 2026-09-21). The
  container is where the clone's git already runs, under the caps the sandbox drops. `Sandbox` is
  therefore the one tag with a read that a rehearsal cannot keep real (T15's rule), and the plan's
  tip stands in when nothing answered.
- **A failed pass in a feature run is an outcome, not the run's error** `(T76)`. The loop catches
  `AgentPassFailed` once per pass and records `implement-failed` or `review-failed` for that issue,
  then stops the sequence and falls through to the land — so the run still lands what earlier issues
  committed and records `Completed`. Letting it propagate typechecks, is what every other arm does,
  and throws away committed work: bash assigns both passes through an `if` after exactly that took a
  run down on a mid-review 529. What is *not* caught is `PromptUnusable` — a client's own file is
  not an issue's outcome — and `PassFailed` is still emitted either way (T55).
- **A resume's implement pass is handed what the branch's PR says today; a fresh dispatch's is
  not** (T17, widened by T66 off 22 §5). The body is what the human read before they wrote the
  feedback and what the feedback refers to, whichever arm the task is on; on a fresh dispatch of a
  branch that already has a PR it describes work this run supersedes, which is misleading context
  rather than missing context. Narrowing it back to the inline arm keeps an accident of T17's
  prompt layout rather than a rule.
- **A run whose task is stated inline mounts no spec, and no dispatcher's message it assembles
  sends a pass to `/spec.md`.** There is no spec — on the one dispatch that reaches this arm today
  the recorded one is gone from disk — and a bind mount whose host path is missing is a directory
  docker invents there, root-owned, *inside the client's repo*. It is T7's ruling from the other
  side (a missing file is answered before a container starts, never by one), and it is why no
  message on that arm sends a pass after the file (T17, T66). *Naming* it is the narrower claim and
  belongs to the bullet below: against the shipped templates no message names it either, and the one
  sentence that can is conditional on a client's template having asserted the mount first.
- **Whether a spec is mounted is a dispatcher fact, not template prose** (T37). The shipped
  templates name no file: each pass's *generated message* says where the spec is, in that pass's own
  register — read it first, the standard fidelity is judged against, background for the overview —
  and an inline task's messages say nothing, because there is nothing to say. That is the same
  principle `image-build-command` settled from the other direction (T34): the package ships no fact
  it cannot know, and a run condition that changes between two dispatches on the same branch is the
  worst kind to ship. Prose that asserted it needed a correction remembered at three sites, and the
  site whose generated message never mentioned the file — the description pass — is where it went
  missing. One correction is held in reserve: the **templates** are a client's to write
  (`PromptSource`), so all three of the inline arm's messages can carry `NO_SPEC_MOUNTED`, the one
  sentence that covers an override still asserting the mount — and each emits it **only when the
  template that won names `SPEC_TARGET`**. Whether there is anything above
  to retract is a fact the assembler can check, and all three arms hold the template. Against the
  shipped defaults the sentence therefore never fires: an inline task's prompts do not mention the
  path. It is a deliberate divergence from bash, SPEC §12. The arm it speaks of is the inline one,
  which is the arm the run whose spec is gone takes (T66).
- **The pass is handed what the dispatch gathered for it; the seam does not go and get it.** A
  resuming implement prompt quotes the branch's PR title and body, and `dispatch/feedback.ts`
  asks `Forge` and degrades — a failed view warns and costs the prompt one section, never the run.
  Putting `Forge` in `AgentCli.implement`'s requirements typechecks and puts "the view failed, carry
  on" policy inside the seam that runs a CLI in a container, which is the same split that keeps the
  description pass's degradation in `dispatch/pr.ts` (T17, T66).
- **Reporter events are the source of progress**; the log file is one subscriber. New user-visible
  progress goes through a `Reporter` event — printing from inside the op typechecks and leaves the
  ledger record underivable from the event stream (05).

### The forge

- **A view answers with what the PR says today, and never with its comments** (T17). One
  `gh pr view` answers both questions a run has — is there an open PR, and what does it say — so
  `prView` asks for `title` and `body` beside the pair the row records, nested rather than
  flattened: a shape merely assignable to `PullRequest` would let a title reach the ledger the day
  that record grows a field. Comments are the deliberate omission, not an oversight —
  reviewer-authored text steering an unattended agent is a prompt-injection channel, and the human
  folds what matters into `--feedback`, which is text they wrote.
- **A nonzero `gh pr view` reads as "this branch has no PR", and the preflight is what buys that
  reading.** bash says the same with `|| true` (`run.sh:1714`), and it is honest only because an
  absent or unauthenticated `gh` was refused before the run started (`dispatch/preflight.ts` reuses
  `doctor`'s probe 6). Without that refusal "no PR" and "no forge" collapse into one answer, and the
  collapse resolves as a **create** against a forge that cannot answer. It is also the only `gh`
  failure that is swallowed: the create or edit behind it fails loudly a moment later, with the
  commits already pushed (matrix row 15, T12).

### The TTY

- **Interruption crosses promise boundaries via the signal**: wrap foreign promises as
  `Effect.promise((signal) => …)` and hand that signal to the library. For clack prompts it goes in
  as the `signal` option and that **is** the whole TTY bracket — a manual raw-mode restore leaves a
  zombie prompt attached to stdin (13).
- **clack fuzzy lists**: when `options` is a function, also pass an always-true `filter`. The
  wrapper otherwise re-applies its substring default *after* your ranking — works on most queries,
  silently not fuzzy (13).
- **clack cancel**: `isCancel` is a sentinel, not a rejection, and Esc/Ctrl-C are one sentinel.
  Back-navigation is a visible `← Back` option row, never key-level handling (13).
- **The picker's product is argv handed to `dispatchCli`, never a `DispatchRequest` built in
  place (T81).** bash's picker writes `key=value` lines into the same variables its flag loop sets
  (`run.sh:744-771`); the port hands over the words. The built request typechecks and is the wrong
  shape: it skips the `--repo-root` peel, `VALUE_OPTION_NAMES`, and every argv guard, so a picked
  run and a typed one would stop being the same dispatch at exactly the place a picker is most
  likely to be wrong.
- **The editor is the one child that inherits the terminal**, through `execInteractive` and nothing
  else. Every other entry in the chokepoint captures its child's output, which is exactly
  what an editor cannot survive: a captured-output entry with the editor's argv typechecks, takes
  the terminal away from the program that is being driven, and hangs on a screen nobody is shown
  while a `Stream` waits on a pipe that never ends. So the flag that opens one is TTY-gated
  (`Terminal.isTTY`) and refuses off a pipe rather than behaving differently there, and the editor
  itself is resolved by `git var GIT_EDITOR` rather than by a chain assembled here — which is why
  no `EDITOR` read exists in `src/`: the three environment links of git's chain are *forwarded* to
  that child by the allowlist, and git answers. The value can carry arguments (`code --wait`), so
  it is invoked as git invokes it, `sh -c '<editor> "$1"' - <file>`, with the named `sh` as the
  child — not `Command.runInShell`, which stays banned (T84).
- **A resume pass asks no branch, issues, or base step**: the picker's resume row is the source
  step and its submenu, and its words are `--resume <branch> [--feedback "<text>"]` and nothing
  else, because the resume recovers its branch and base from the record (SPEC §7). `applies` skips
  the three steps for it. A picker that re-asks the base for a resume typechecks and emits a
  `--base` the resume arm then overrides in silence (T85).
- **Only a missing answer opens the picker; two of something and a wrong value are refused, never
  asked about.** A command line with no source, no `--branch`, or `--feature` without `--issues`
  raises `AnswerMissing`, and on a terminal the entrypoint hands its request to the picker as a
  seed. Everything else stays a `GuardRefused`. Two wrong shapes both typecheck. One is a question
  offering to drop one of two tasks, which decides for the dispatcher. The other is catching a
  `GuardRefused` by matching its `detail` text instead of raising `AnswerMissing`, which turns the
  next refusal that shares those words into a prompt (T86).

### Signals

- **`NodeRuntime.runMain` installs SIGINT and SIGTERM handlers — not SIGHUP.** On a hangup node's
  default action kills the process, no finalizer runs, and the lock survives — the leak SPEC §4 says
  the port closes. `bin.ts` re-raises SIGHUP as SIGINT so the runtime's single handler stays the only
  teardown; a `process.on("SIGHUP", …)` that tears down itself races it (T4).

## Subprocesses and the environment

All subprocess work goes through `internal/exec.ts`. The grep ban enforces the import; the
discipline it cannot check is **`extendEnv: false` plus an allowlist grown one variable at a time**,
each with a note naming the child that reads it. Default env inheritance is how the parent's
credentials leak into agent containers (05 Q3).

**Two exceptions, both in `test/`, for different reasons.** Live case 5 spawns `node src/bin.ts`
with `node:child_process` to signal a child mid-run — the chokepoint's contract is "run it to
completion and hand me the output", the opposite of holding a live pid — and pays the allowlist
itself, writing the child's env variable by variable (T19). The shim tests (`test/shim.test.ts`)
spawn `.speepobox/speepobox` the same way **not for that reason**: their children run to completion
and nothing holds a live pid. What they need is a whole environment written by hand — `PATH`,
`HOME`, `XDG_CACHE_HOME`, and nothing inherited — which the chokepoint has no spelling for
(`execUnder` carries one variable), and growing `src/` a way to hand a child a whole environment
for tests alone is the wrong trade (T125). Nothing in `src/` may do either, except the one entry
below.

**One exception in `src/`: `execDetached`, which the chokepoint itself holds** (T153). `--detach`
starts the package's own entrypoint in a new session (`detached: true`) and `unref`s it, so the run
outlives the process that started it. `Command` has no spelling for that, so this entry is the one
in `internal/exec.ts` that speaks `node:child_process`, does not run its child to completion, and
does not apply the allowlist. The child gets the parent's **whole** environment, passed in by
`bin.ts` from `process.env`. The child is speepobox, which resolves the credential itself
(`agent/credential.ts`) and applies the allowlist to every child it spawns. The allowlist would be
wrong for this child: it carries no credential, by rule (T23), so a token exported in the
dispatcher's shell would never reach the one process that resolves it. The handle sends SIGINT and
no other signal. Its only caller is `detach/detach.ts`, and the command is always the package's own
entrypoint. **Nothing else in `src/` may spawn with an inherited environment**: a second caller of
`execDetached`, or a second inheriting spawn beside it, is how the parent's credentials leak into
agent containers (05 Q3).

**A secret crosses into a container by name, never by value.** `SandboxEnvVar` renders
`-e NAME=value` when it has one and bare `-e NAME` when it does not; the credential is the second,
so docker takes the value from *its own* environment. Giving it a value puts the token in argv —
readable in `ps`, in every command log, and in the failure detail of anything that echoes a command
back (T9).

**And the value that child reads is one we resolved, never one we inherited.** `agent/credential.ts`
is the single answer to "is there a credential, under which name, and what is its value" —
`<repoRoot>/.speepobox/.env` then the process environment, either accepted name — resolved at the
composition root and passed down, so `doctor`'s probe 3 and the dispatch read the *same* answer,
against the *same* root. Three places it deliberately does not read, each for its own reason (T58):
the package, because the shim re-clones its cache on every repin and one cache serves every repo;
the served repo's own top-level `.env`, because that file belongs to the application and means
something else in any repo that is not hae; and any user-level file, because a person who exports
`CLAUDE_CODE_OAUTH_TOKEN` in their shell profile already has the user-level answer. The answer
carries which of the two places it came from, so probe 3 and T62's roots row can name the file path
or the environment — never the value.
**The process-env allowlist carries no credential at all**, and that is the rule rather than an
omission: it forwards variables we did not read, this is a value we did, and a second mechanism
reaching the same child is one more place a secret can be spilled. It was also the defect — nothing
loads `.env` into this process, so the probe's green row and the run's authentication were two
independent answers, and a host whose token was exactly where `doctor` told it to put one got a
container whose agent said `Not logged in`, three held resources late. The value travels as a
`Redacted` from the resolver to the one `execWith` call, and that call is the only `Redacted.value`
in the package that writes the token anywhere — the resolver's own unwrap reads a length, to tell a
declared-but-empty variable from a credential, and keeps nothing. Four shapes that typecheck and are
wrong: sourcing `.env` into `process.env` (every child
this package spawns gets the token); rendering it into argv; adding either name back to the
chokepoint's allowlist; and re-reading the host where the container starts, which is how the two
answers came apart in the first place. A missing credential is a **guard's** refusal before the lock
carrying probe 3's advice, on T7's ruling — a missing file is a guard's answer, not a container's —
so it writes no ledger row (T23).

## Host reads live at the composition root

Every read of the host — `process.versions`, `process.platform`, `os.*`, the clock, `process.env`
outside `internal/exec.ts`'s allowlist — happens in `bin.ts` and reaches the command as a parameter.
A read buried in a command turns its tests into a report on whichever machine ran them, and the gate
structurally cannot catch it: the container satisfies every prerequisite, so a host-dependent test
is green there and red on a host one version behind (T1).

Filesystem-derived facts count too, and the repo root is the one that bites: it is what the
`speepobox.repo` ownership label hashes, and `status` may run **no git commands** (SPEC §7), so it is
resolved by walking up for `.git` at the composition root and passed in. Resolving it inside the
command makes the label depend on where the process happened to start.

**`--repo-root` is the one argv read that precedes parsing, and `selfHosted` is decided there and
never re-derived below** (19 §1 and §4, T60). The served repo is named by a flag the shim always
passes, peeled off in `bin.ts` **before** the `argv[0]` switch — `status` and `doctor` are
intercepted there and never reach `@effect/cli`, so a flag the parser owned would be a flag two of
the three commands could not see — and everything downstream gets the peeled argv. A relative value
is refused rather than resolved, because resolving it would read the working directory this rule
retired. `selfHosted = resolve(findRepoRoot(packageRoot)) === resolve(repoRoot)` is computed beside
it, once, and travels as a boolean to `doctor`'s `DoctorHost` and through `dispatchCli` to the
preflight: the dispatcher-freshness question is a self-hosted one, and a predicate re-derived at
either end is how `doctor`'s screen and a dispatch come to disagree about whether the check ran. The
peel is a module (`config/served-repo.ts`) rather than four lines in `bin.ts` for this file's own
reason — importing the entrypoint runs the CLI, so nothing that owes an assertion stays there.

**Every git operation names the repo it runs in, reads no less than writes** (T27). The one answer
travels down as a required parameter — `Git`'s `revParse` / `worktrees` / `mergeBase` /
`countCommits` / `branchContains` carry it beside `fetch.repo`, `fetchBack.into` and `push.from`,
the guards' subprocess helper takes it as its first word, and `doctor`'s probes take it too. `git
clone` is the only exception, and it names both of its ends instead of a repo to run in. A read
left to answer from the working directory typechecks and reads fine, and it is the same defect as a
write to the wrong repo — just later and quieter: the reachable case is a refusal blaming `--base`
for a directory problem, and the one worth fearing is a read answering from
`<runtimeRoot>/checkouts/<slug>`, a real clone with this same branch in it, so the diff boundary in
the ledger row and in every review round is a commit from another repository while the ownership
label still says hae. **Make it unrepresentable rather than remembered**: a read that can be spelled
without a repo is one a later ticket will spell that way, so the field is required and forgetting it
is a type error. Two things that are *not* the fix, and were considered:
parameterizing the layer (`GitLive(repoRoot)`) puts a host fact inside a layer
`status` composes without ever asking git anything, and changes `app.ts`'s graph; resolving the root
a second time inside `git.ts` or a probe is a third answer to the question this rule exists to give
one answer to. Do not add a guard refusing a working directory outside the repo either — the point
is that the working directory stopped mattering.

**`-C` names a directory, and a directory is not a repository** (T32). It changes directory and
leaves git to *discover* the repository by walking up, so the rule above was implemented as naming a
*path*: a path holding no repository resolves to the nearest enclosing one, and `checkouts/` lives
inside the host repo's working tree, so that is always the host repo answering about a copy that is
not it — the observed case proposed a rescue branch named after the host repo's own tip for a
directory holding one empty file. Every operation on the tag therefore names the git directory too
(`-C <repo> --git-dir=<repo>/.git`), which turns the walk off: a path holding no repository fails
naming that path, in git's own words, and resolves to no other repo. The salvage on the way *in* is
exactly such a read by design — it runs before anyone knows what is there. **The two flags only name
the same directory once the path is absolute**, so `inRepo` resolves it rather than assuming it: git
resolves a relative `--git-dir` against `-C`'s destination and not against the process, so
`-C box/x --git-dir=box/x/.git` looks for `box/x/box/x/.git` and dies. Absoluteness cannot be read
off as an invariant — `checkoutPathFor` is rooted at the configured `runtime-root`, a plain
`Config.string` a `config.toml` may spell relatively — and resolving against the process working
directory is what bare `-C` did with a relative repo before this flag sat beside it, so closing the
discovery walk changes no path that already worked. Two shapes that look right: fencing the walk
with `GIT_CEILING_DIRECTORIES`, which is a per-call environment variable against an allowlist that
is `extendEnv: false` with one note per variable saying which child reads it, for a property git
asserts directly when asked; and checking `rev-parse --show-toplevel` against the path first, which
is a second read that can disagree with the one it is vouching for.

**A fallback for a repository read is not a parameter** (T35). The commit identity a run's clone
carries is `git config user.name` / `user.email` read in the dispatching repo — an ordinary `Git`
read, with a repository to ask and a fake that records it — and its fallback is the host username,
which `checkout.ts` takes from `os.userInfo()` inside an `Effect.sync` rather than from a threaded
parameter. Beside `inRepo`'s `resolve` above and the allowlist this rule already carves out, that
is the only host read this package does outside `bin.ts`, and the rule it does not break is the
reason the rule exists: it makes no test a report on the machine that ran it, because every case scripts
the config read that comes first and the fallback case asserts against `userInfo()` itself. Adding
the value to `dispatchCli`, `dispatch`, `planFor`, and `runInScope` would put a host fact on four
signatures to serve the branch a repository read did not take — T23's credential is threaded because
it is a host fact with *no* repository to ask, which is the distinction, not the shape.

## Shape pins

Small `@ts-expect-error` tests are **shape pins**: each asserts something stays impossible (a ports
field on the sandbox spec, a string URL crossing into the sandbox). A red pin means a design rule
broke — restore the shape it pins rather than deleting the pin (12, design rule 2).

## The gate

The issue's Verify section is authoritative. One gotcha no green can confess: vitest transforms
source and the clone-run shim does not, so `node src/bin.ts doctor` under plain node is the only
check that proves the distribution model.

**The live tier is tagged by an import, and the tag throws.** `test/live/` is host-only
(`npm run verify:live`, against a real dockerd) and the agent writing the code has no docker socket,
so the failure mode to design against is a case that reports green without asking a daemon anything.
Hence: `verify` excludes the directory by path, `test/live/live.ts` throws at import when the live
config's `SPEEPOBOX_LIVE` marker is unset, and nothing in the tier is `skipIf`-guarded. The marker
is set by `vitest.live.config.ts` rather than a `VAR=1` prefix in the npm script, so the one config
that admits live cases is the only thing that can. Import `itLive` from that module; writing `it`
directly typechecks and silently opts out (T6).
