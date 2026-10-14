# T30 — The image declares its own inputs

Status: Done
Type: AFK
Blocked by: T27

Sequence: [ticket 08](../08-in-hae-sequence.md). A correctness fix to code already on the branch,
found by the dispatcher while reading a warning that would not go away. The same shape as
[T20](T20-atomic-lock-claim.md), [T21](T21-serialize-lock-eviction.md),
[T25](T25-kept-checkout-is-not-wreckage.md), and [T27](T27-every-git-read-names-its-repo.md).

**Collides with nothing in flight.** It touches `src/doctor/probes.ts` and its two callers, and no
other open ticket names that file.

**Tracer: `doctor` reports the image stale when a dependency file's contents changed, and fresh
when a branch switch merely rewrote it.**

## What to build

Probe 2 stops asking the clock and asks the image what it was built from.

### 1. mtime is not "changed"

`stalenessInputMtimes` (`src/doctor/probes.ts:98`) stats the served repo's dependency
manifests (`<backend>/requirements*.txt`, `<frontend>/yarn.lock`) and `.agentbox/Dockerfile`, and
`classifyStaleness` (`:76`) calls the image stale when the newest of those mtimes is later than
`docker image inspect -f '{{.Created}}'`.

Git rewrites a file whenever it differs between two branches, whether or not its contents end up
different from what the image was built against. On the host this was found on:

```
<backend>/requirements.txt   mtime Aug 14 11:08     last content change  Jul 09
<frontend>/yarn.lock         mtime Aug 14 11:08     last content change  Jul 16
```

Both clean in `git status`. One branch switch between two bessemer tickets moved both mtimes a
month past their real change, and probe 2 has warned on every dispatch since. This sequence
dispatches in parallel and hops branches constantly, so the false positive is not an edge case here —
it is the normal state.

A warning that is always on is a warning nobody reads, and it sits in the one advisory a dispatch
shows mid-run (`preflight.ts:31-38`, the only `warn` row a dispatch surfaces).

### 2. The rebuild it asks for cannot clear it

The remedy in the message is `.agentbox/build-image.sh`. The served repo's build script builds from
a context that holds neither manifest, because both arrive through its base image, so a change busts
no layer, the build is a full cache hit, docker resolves the same image id, and `.Created` does not
move. The message names an action that provably cannot satisfy it.

This half is the served repo's Dockerfile rather than the port's, and it leaves at move-out. It is
recorded here because it is why the false positive is permanent rather than merely frequent, and
because the fix below retires it as a side effect.

### 3. What move-out does to this probe

The three input paths are hard-coded in the package's own source, and so is the remediation script.
Point bessemer at a repo with no `<backend>/` directory and follow the code:

```
readDirectory(<repoRoot>/<backend>)  fails  → orElseSucceed([])
stat(<frontend>/yarn.lock)           fails  → skipped
stat(.agentbox/Dockerfile)           fails  → skipped
mtimes.length === 0                         → "unknown"
                                            → ok("image", "staleness unknown — couldn't compare timestamps")
```

It does not fail. It **evaporates** — an `ok` row, forever, and probe 2 becomes decoration. That is
worse than §1's false positive, which is at least visible. P6's adopter distribution is where this
arrives, and an adopter has no way to tell a probe that passed from a probe that was never able to
run.

### 4. The rule

**The image carries the list of files it was built against and a digest of their contents. The probe
reads that list off the image and recomputes the digest.** Nothing about the host clock, and nothing
in the package about which files a repo's dependencies live in.

Two labels, set at build time, in the `agentbox.*` namespace `src/ownership/labels.ts` already owns:

| Label | Value |
| --- | --- |
| `agentbox.inputs` | repo-relative paths, `/`-separated, comma-joined, **in the order they were hashed** |
| `agentbox.inputs.digest` | lowercase hex sha256 over those files' contents |

The digest is computed identically on both sides, so spell it once and mirror it exactly:

```
for each path p, in the declared order:
    emit the line  "<p> <sha256 of the bytes at <root>/p, lowercase hex>\n"
digest = sha256 of the concatenation of those lines, read as UTF-8, lowercase hex
```

The path goes into the digest beside its hash so that reordering or renaming an input is a change,
not a collision.

This retires §2 as well: a label is part of the image config, so a changed digest changes the final
layer and the build stops being a no-op.

### 5. Four states, and which one interrupts a dispatch

| Condition | Row | Detail |
| --- | --- | --- |
| digests differ | `warn` | the image was built against different contents — rebuild with `<command>` |
| digests match | `ok` | present, built against the current dependency files |
| a declared path is missing on disk | `warn` | it is a change like any other; deleting an input is not "unknown" |
| no `agentbox.inputs` label | `ok` | the image does not declare its build inputs, so staleness is unchecked — rebuild with `<command>` to enable it |

The undeclared row is **`ok` and not `warn`, deliberately.** Every image built before this ticket is
undeclared, so a `warn` would nag on every dispatch until the user rebuilds — reproducing exactly the
always-on warning this ticket exists to remove. `doctor` is where an unchecked check is meant to be
read; a dispatch interrupts only for something the dispatcher can act on about *this* run. The row
must still say plainly that the check is not running, so §3's silent evaporation does not come back
wearing a new hat.

`<command>` comes from config, not from a string literal: add an `imageBuildCommand` key defaulting
to `.agentbox/build-image.sh`, which keeps today's message byte-identical on this host and lets an
adopter name their own.

### 6. The build script's half is host-only

`.agentbox/build-image.sh` is the served repo's build script, and no ticket in this sequence edits
one. The dispatcher applies it by hand, **at Verify time and not before**: the first host-only step
observes the undeclared row on an image built without these labels, and that is the branch every
image predating this ticket will take. Landing the labels early costs that observation and buys
nothing, since the package ignores them until this ticket's code exists.

It is the whole change:

```bash
INPUTS=(<backend>/requirements*.txt <frontend>/yarn.lock .agentbox/Dockerfile)

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

LINES=""
for p in "${INPUTS[@]}"; do
  [ -f "$p" ] || { echo "!! declared build input missing: $p" >&2; exit 1; }
  LINES+="$p $(sha256 "$p")"$'\n'
done
DIGEST="$(printf '%s' "$LINES" | { command -v sha256sum >/dev/null 2>&1 \
  && sha256sum || shasum -a 256; } | cut -d' ' -f1)"
JOINED="$(printf '%s,' "${INPUTS[@]}")"; JOINED="${JOINED%,}"
```

then two more flags on the `docker build`:

```
  --label "agentbox.inputs=$JOINED" \
  --label "agentbox.inputs.digest=$DIGEST" \
```

Note the script `cd`s to the repo root already, so the paths are repo-relative as §4 requires. A
missing input aborts the build rather than silently shortening the list — a declaration that quietly
covers less than it claims is the failure mode of §3.

The package half must work whether or not this has been applied: before it, the undeclared row; after
it, a real comparison. That is what makes this ticket landable on its own.

## A shape that looks right and is not

**Do not keep `.Created` as a fallback when the labels are absent.** A probe with two rules answers
two ways, and the mtime rule is the one that is wrong — retaining it as a default means every image
built before this ticket keeps producing §1's false positive, which is the entire complaint.

**Do not ask git when a file last changed.** `git log -1 --format=%ct -- <path>` would fix §1 and
nothing else: it is a fourth answer to "which repo is this" of the kind T27 just removed from this
same probe, it says nothing about an uncommitted or untracked input, and it leaves §3 exactly as it
is. The contents are the fact; the history is a proxy for it.

**Do not make the input list a config key.** It reads as the obvious generalization and it puts the
declaration in the wrong place: config describes the dispatcher's intent, and this is a fact about a
built artifact. A list in config can disagree with what the image was actually built from, and the
disagreement is silent — which is §1 again with different inputs.

**Do not compare timestamps at all, anywhere in this probe.** After this ticket, `imageProbe` reads
no clock.

## Not in scope

The served repo's base-image build and the base image's own freshness — an adopter's base image is
their concern, and this probe's claim is only that the agent image matches the files it declares.
The other eight probes. The ownership labels on containers (`agentbox.managed`, `agentbox.repo`),
which are a different mechanism that happens to share a prefix. Whether `preflight` should refuse on
a stale image — it must stay an advisory (`run.sh:993-996`, SPEC §"doctor probes" row 2).

## Read first

`src/doctor/probes.ts` — `classifyStaleness`, `stalenessInputMtimes`, and `imageProbe`, which is all
of §1 and §3 in about seventy lines — plus its two callers, `src/dispatch/preflight.ts` (which shows
only `warn` rows, and why) and `src/doctor/doctor.ts:87`. `src/config/config.ts` for where
`imageBuildCommand` goes and how `image` is already spelled. `src/ownership/labels.ts` for the
`agentbox.*` naming this reuses. The served repo's build script and Dockerfile — read only, to see §2
for yourself. `AGENTS.md`, and **SPEC §"doctor probes"** — that table, not the whole
file.

`test/doctor.test.ts` is where this is pinned. Its `allGreenScript` currently dates the image
`2099-01-01T00:00:00Z` with the comment *"so the staleness comparison is 'fresh' on every host"* —
the fixture is already working around the clock, and after this ticket it scripts labels instead and
needs no such trick. `test/dispatch.test.ts:976`'s `repoFiles: ["api/requirements.txt"]` is the
preflight side.

**Already on the branch — do not rewrite** T1–T11's, T20's, T21's, T22's, T25's, or T27's modules
beyond what §4 requires of this probe and its callers. **Do not touch hae files** — §6 is the user's
to apply, and this ticket must land green without it.

## Effect wiring

- **Tags introduced**: none. **Tags consumed**: unchanged — `imageProbe` keeps its
  `CommandExecutor | FileSystem | Path` requirements. It gains no service; it reads two labels
  instead of one timestamp and hashes files it already stats today.
- **Layer composition**: unchanged. `AppLive` and `AppBaseLive` are byte-unchanged and `src/app.ts`
  is not edited.
- **Errors**: unchanged. `ImageUnavailable` still means the image is absent or docker is not there;
  every state in §5's table is a `ProbeRow`, never a failure. An unreadable declared input is a
  `warn` row, not an error — the probe reports, it does not refuse.
- **Config**: `imageBuildCommand` follows `image` exactly — `Config.string(...)` with
  `Config.withDefault(defaultConfig.imageBuildCommand)`, added to the record and to the defaults.

## Acceptance criteria

- [ ] `imageProbe` reads no timestamp — `.Created` appears nowhere in the package
- [ ] The compared file list comes from the image's `agentbox.inputs` label; no dependency path is
      written in the package's source
- [ ] The digest is computed as §4 spells it, and a case pins the exact hex for a known set of
      files so the bash side can be checked against it
- [ ] Changing a declared file's **contents** produces the `warn` row; rewriting it with identical
      contents produces the `ok` row
- [ ] A declared path missing from disk produces the `warn` row
- [ ] An image with no `agentbox.inputs` label produces an `ok` row that says the check is not
      running and names the configured build command
- [ ] A dispatch preflight shows nothing for the undeclared and matching cases, and one line for the
      differing case
- [ ] `imageBuildCommand` is a config key defaulting to `.agentbox/build-image.sh`, and the message
      uses it
- [ ] `test/doctor.test.ts`'s `allGreenScript` no longer dates the image in the future
- [ ] `AGENTS.md` records the ruling — a built artifact declares what it was built from, and the
      probe compares contents rather than clocks
- [ ] `AppLive` and `AppBaseLive` are byte-unchanged; `src/app.ts` is unedited; no tag is introduced

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, grep bans, and fake-tier tests. `pre-commit` is not a
substitute and does not check this package.

The fake tier reaches every state in §5's table: the labels are scripted `docker image inspect`
output and the input files are fixture files, so all four rows are assertions rather than intentions.

**Host-only**, run by the user before landing:

Run `doctor` against the current image and confirm the undeclared row — it should say the check is
not running and name `.agentbox/build-image.sh`, and a dispatch preflight should print nothing.
Then apply §6, rebuild, and confirm the row turns to a match. Then `touch` a declared dependency
manifest without editing it and confirm it **stays** a match — that is §1 fixed, and the whole point.
Finally edit that manifest for real, confirm the `warn` row appears in both `doctor` and a dispatch
preflight, rebuild, and confirm it clears — which also confirms §2, since the same rebuild that used
to be a cache-hit no-op now changes the image.
