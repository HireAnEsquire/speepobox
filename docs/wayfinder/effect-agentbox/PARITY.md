# Parity checklist

The written checklist 09 Q8 asks for (SPEC §12). Every behaviour in the bash oracle carries exactly
one mark. **Parity is reached when no row is unmarked**, and that is P7's gate.

| Mark | Meaning |
| --- | --- |
| **ported** | behaviour reproduced |
| **diverged** | ported-with-divergence: reproduced differently on purpose; the deciding ticket is named |
| **not core** | belongs to the hae adapter or a scaffold template; never in the tool |
| **transitional** | carried only to serve the switchover gate, then deleted in P7 |
| **retired** | was transitional, and is deleted; the deleting ticket is named |
| **dropped** | deliberately not carried, with a reason |
| **deferred** | post-finish-line, with a reason |

**What is checked.** The rows are 03's inventory (`research/03-behavior-inventory.md`, read at
hae `e194121f75`), section by section, plus the behaviour the bash oracle grew after that snapshot
(§9 below, the 22 commits up to `.agentbox/run.sh` as of `6f66e9ac891462de809d207822c77d8f27615663`). Per 03's own note, the
comparison is against the *current* bash, so a snapshot behaviour bash later removed is marked
against what bash does now. Inventory §0 (sizes), §6 (bash's test suite) and §8 (cross-references)
describe the oracle rather than behaviour, and carry no rows.

**Diverged rows are the switchover gate's expected-divergence list.** SPEC §12 holds the long form
of the known set; a row here points at it rather than restating it.

## 1. CLI surface

| # | Behaviour (bash) | Mark | Where / why |
| --- | --- | --- | --- |
| 1.1 | `status`: running + recent, read-only, no git, intercepted before preflight | ported | `src/status/`; SPEC §7 |
| 1.2 | `status` degrades to ledger-only when docker is down | ported | `status/status.ts` |
| 1.3 | `status` lists stale locks (`*.pid` with no live container) | dropped | the reconciler makes a stale lock short-lived; `gc` lists leftovers |
| 1.4 | `doctor`: dependency-ordered `ok`/`WARN`/`FAIL`, exit 1 on FAIL, read-only | ported | `src/doctor/`; SPEC §7 |
| 1.5 | doctor probes: docker, image + staleness, credential presence, git + origin, gh, tasks dir | ported | probes 1, 2, 3, 5, 6, 8 |
| 1.6 | doctor probe: host python ≥ 3.14 | diverged | probe 4 is host node ≥ 26 (SPEC §7) |
| 1.7 | doctor probes: gum, fzf | dropped | clack replaces both (13, SPEC §7) |
| 1.8 | doctor probe: `.agentbox/` older than its base | diverged | probe 10, self-hosted only (T42, T60) |
| 1.9 | `gc [--force]`: audit by default, delete with `--force` | ported | `src/gc/` (T99) |
| 1.10 | `--gc` alias | dropped | one spelling (T99) |
| 1.11 | `--status`, `--doctor` aliases | dropped | one spelling per command, T99's reason |
| 1.12 | `<spec>` positional: bare name under the tasks dir, slash path as-is, `.md` appended | ported | AGENTS.md "Spec resolution" (T3) |
| 1.13 | `--feature <folder>` must contain `issues/` | ported | issue set read at the branch tip (T73) |
| 1.14 | `--issues NN,NN`, feature mode only | ported | `issues/selection.ts` |
| 1.15 | `--branch` required, the task's identity | ported | parsed optional, refused by a guard (T3) |
| 1.16 | `--resume <branch>`, `--last` | ported | `dispatch/resume.ts` (T16) |
| 1.17 | `--base <ref>` | ported | |
| 1.18 | `--hard-reset`: TTY confirm, force-with-lease push | diverged | reset under the lock, discard count includes `origin/<b>` (T101, T102; SPEC §12) |
| 1.19 | `--feedback <text>` into implement, review, PR prompts | ported | trimmed once at the door (T17, T66) |
| 1.20 | `--feedback-edit`: `git var GIT_EDITOR`, TTY-only, strip comments, empty aborts | diverged | file opens on an empty line above its comments (T84, T95) |
| 1.21 | `--dry-run` alone still enters the picker | ported | modifiers ride into the picker (`bin.ts`) |
| 1.22 | `-h` / `--help` | ported | `@effect/cli` help; usage off a TTY |
| 1.23 | unknown `--*` is a hard error | ported | `@effect/cli` |
| 1.24 | the six flag-exclusivity refusals | ported | guards (T3, T16); `--task`'s four (T67) |
| 1.25 | picker gate: no args on a TTY; never prompts off one | ported | `Terminal.isTTY` (T81, T94) |
| 1.26 | picker hands back the same variables the flag loop sets | diverged | hands back argv to `dispatchCli` (T81) |
| 1.27 | picker echoes the equivalent command for copy-paste | ported | `commandLine` (`picker/picker.ts`) |
| 1.28 | picker resume row: latest-per-branch, optional feedback, skips to base | diverged | asks no base step either (T85) |
| 1.29 | picker `create-branch` carve-out | dropped | SPEC §12 (T81) |
| 1.30 | `AGENTBOX_NOTIFY` `off`/`end`/`steps` | ported | `notify` config key |
| 1.31 | notify `0`/`1` aliases; an unknown value warns once and falls back to `end` | diverged | config decodes once and refuses a bad value; `doctor` reports it as probe 7 (SPEC §6) |
| 1.32 | notification fire sites | diverged | setup-complete and landing dropped, implement-finished added, `NoWritesYet` notifies (T13, T52) |
| 1.33 | `osascript` args as `argv`, never script text | ported | `notify/notifier.ts` |
| 1.34 | tasklib's 13 subcommands, `key=value`/TSV over stdout | dropped | one process; the modules are called in place |
| 1.35 | config from `.agentbox/.env`, CLI > `.env` > default | diverged | `config.toml` provider chain, decoded once (05 Q7, SPEC §6) |
| 1.36 | config keys: image, base, review rounds, pass timeout, pids limit, memory | ported | `config/config.ts` |
| 1.37 | config key: yarn cache volume | deferred | a repo cannot yet ask for writable container storage; post-finish-line (MAP) |

## 2. Dispatch state machine

| # | Behaviour (bash) | Mark | Where / why |
| --- | --- | --- | --- |
| 2.1 | `--last` resolves the newest row and prints the equivalent `--resume` | ported | `dispatch/resume.ts` |
| 2.2 | `--resume` on an unknown branch refuses with recent branches as a hint | ported | `ledger/ledger.ts` `NoRecord` |
| 2.3 | resume decision table (normal / feedback-only / refuse / hard-error) | ported | T16; 22 |
| 2.4 | feature selection + blocker guard before anything is acquired | diverged | `all` selects on triage status; an enumerated Done issue is refused (SPEC §12) |
| 2.5 | `--base` default chain: ledger's last base, then the configured default | ported | `dispatch/dispatch.ts` |
| 2.6 | branch guards: exists, not protected, not self-base, not checked out | diverged | checked-out guard is worktree-aware (T5) |
| 2.7 | branch behind or beside its remote fails at the push | diverged | refused before the lock (T106) |
| 2.8 | preflight: docker, gh, credential, image | ported | `dispatch/preflight.ts` |
| 2.9 | `git fetch origin` before resolving the base | ported | the guard phase's one write (T70) |
| 2.10 | nothing is touched before the in-flight check passes | ported | guards hold nothing; `RunLock` (T4, SPEC §11) |
| 2.11 | lock `<slug>.pid` written after the in-flight guard | diverged | atomic link claim, witnessed eviction (T20, T21, T26) |
| 2.12 | log rotation `<slug>.log` → `.log.1` | diverged | one log per run, `<slug>-<runId>.log`, no rotation (16) |
| 2.13 | stale-leftover clear before the clone | diverged | salvage-then-clear under the slug's own lock (T28, T38) |
| 2.14 | single `trap cleanup EXIT` | diverged | one `Scope`, reverse-order release (05) |
| 2.15 | SIGHUP | diverged | tears down; bash leaks (T4) |
| 2.16 | clone `--no-hardlinks --branch` from the repo | ported | `git/git.ts` |
| 2.17 | hardened `docker run` | ported | `sandbox/spec.ts` (T6) |
| 2.18 | setup step | diverged | a config-declared setup hook (T7); the hae body is row 7.4 |
| 2.19 | implement pass, single attempt (retry removed 2026-08-10) | ported | 05 Q16R |
| 2.20 | prompt on stdin, `stream-json`, filtered | diverged | the filter is `agent/stream.ts` on the host (20) |
| 2.21 | prompt logged verbatim under the step banner | ported | names its template root too (T14) |
| 2.22 | `timeout` inside the container | diverged | `Effect.timeoutFail` over the exec (T9) |
| 2.23 | heartbeat and console line while a pass runs | ported | `PassStillRunning` (20) |
| 2.24 | no file written by a third of the budget: warn | ported | `NoWritesYet` (T52) |
| 2.25 | dead container aborts the pass | ported | `sandboxGone`, asked of the daemon (T22) |
| 2.26 | review loop, verdict-break, capped, never fatal | diverged | last well-formed verdict wins, not the first (T24) |
| 2.27 | feature loop: one container, issues in dependency order | ported | `dispatch/feature.ts` (T76) |
| 2.28 | HITL issue stops the sequence mid-run | diverged | refused before the lock (SPEC §12) |
| 2.29 | `/spec.md` re-pointed per issue | ported | T75 |
| 2.30 | per-issue boundary via host `git -C "$wt" rev-parse` | diverged | read in the container (T76) |
| 2.31 | failed pass stops the sequence and lands what is done | diverged | typed catch in the loop (T76) |
| 2.32 | `Status:` written into the issue file per issue | diverged | only `Done`, by a commit on the run branch at land (T77, 14) |
| 2.33 | unreached issues recorded `not-attempted` | ported | `dispatch/feature.ts` |
| 2.34 | PR checklist over the whole feature | ported | `### Issues` checklist (T79) |
| 2.35 | feedback-only path: feedback is the work order, PR title/body as context | ported | T17, T66 |
| 2.36 | PR prompt sends the pass to sibling issues only when the run spans several | ported | the description pass names the selection's issues and no others (`agent/prompt.ts`, T75) |
| 2.37 | land: FF fetch from the clone, failure fails the run | ported | land's fetch is not the release's (T11) |
| 2.38 | commits counted; zero means nothing to land | ported | `NothingToLand` |
| 2.39 | push from the main repo, explicit refspec | ported | `Git.push.from` |
| 2.40 | PR description pass, static body on failure | diverged | body is first-open to last-close marker (T12) |
| 2.41 | `gh pr view` then edit-or-create, body on stdin | ported | `forge/forge.ts` |
| 2.42 | ledger append after land, best-effort | diverged | a finalizer of the scope, iff the lock was taken (T31, SPEC §11) |
| 2.43 | `--dry-run` runs every guard, prints the plan, starts nothing | diverged | a layer swap (05 Q20, T15) |
| 2.44 | plan block short SHAs from `rev-parse --short` | diverged | fixed 10 characters (SPEC §12) |

## 3. Data layer

| # | Behaviour (bash) | Mark | Where / why |
| --- | --- | --- | --- |
| 3.1 | issue headers in the preamble, stop at the first `##` | ported | `issues/issue.ts` |
| 3.2 | title from the first `#` line; number from the stem | ported | `issues/issue.ts` |
| 3.3 | missing `Type:` is AFK | ported | `DEFAULT_TYPE` |
| 3.4 | `Done` is a first-token match | ported | `issues/issue.ts` |
| 3.5 | Kahn topo order, ties by number, cycles raise | ported | `issues/selection.ts` |
| 3.6 | issue set read off disk | diverged | read at the branch tip through `IssueStore` (T73) |
| 3.7 | `runs.jsonl` schema | diverged | greenfield schema (05) |
| 3.8 | ledger degrades: missing file, corrupt line, write failure | ported | SPEC §10 |
| 3.9 | reading bash's `runs.jsonl` | retired | legacy read adapter deleted by T135: the 09 Q7 comparison it served will never run, so an unversioned line is skipped with a warning |
| 3.10 | auto-migrate per-task-dir `runs.jsonl` files | dropped | bash already merged them; the port reads the central file only |
| 3.11 | ledger row records tokens, passes, models | diverged | four counts, not the sum (T53) |
| 3.12 | status tables: column alignment, truncation, no trailing whitespace | ported | `status/render.ts` |
| 3.13 | status takes the slug as the branch from the container name | diverged | ownership by label (05) |
| 3.14 | gc classes: stopped container, orphan checkout, dead lock | ported | `gc/gc.ts` |
| 3.15 | gc with docker down: list with a warning, `--force` deletes nothing | diverged | per-item skip when dockerd stops answering (`gc/force.ts`) |
| 3.16 | resume mode from the newest row's identity field | ported | read off the record's union tag (T16) |
| 3.17 | picker: gum menus with numbered-list fallback, fzf fuzzy lists | diverged | clack, vendored scorer (13) |
| 3.18 | picker focus snaps to top on backspace-clear | diverged | focus survives (13) |
| 3.19 | picker issues step auto-skips a single issue | diverged | no auto-skip (T83) |
| 3.20 | picker refuses a protected or checked-out branch after the pick | diverged | disabled row (T81) |
| 3.21 | picker ad-hoc prompt materialized as a file under `tasks/ad-hoc/` | diverged | `--task` inline, text on the row (T67, 22) |
| 3.22 | picker back / abort / step invalidation | diverged | `← Back` rows; Esc and Ctrl-C both abort (13) |

## 4. Runtime state

| # | Behaviour (bash) | Mark | Where / why |
| --- | --- | --- | --- |
| 4.1 | slug derivation, lossy, shared by every name | ported | one function; the dry-run duplicate is gone (T15) |
| 4.2 | everything under `.agentbox/` | diverged | runtime root is its own config key (05 Q19) |
| 4.3 | logs never deleted | ported | 16 |
| 4.4 | `== agentbox ==` banners in the log | ported | `run-log.ts` |
| 4.5 | `logs/.pass-<slug>.$$` scratch file | dropped | the stream is folded in process; nothing to leak |
| 4.6 | container `agentbox-<slug>` | diverged | ownership by label (05) |
| 4.7 | anonymous `client/node_modules` volume | deferred | as 1.37 |
| 4.8 | `SIGKILL` leftovers reclaimed by `gc` | diverged | the reconciler reclaims on preflight; lone checkouts are kept (T8, T25) |

## 5. Security invariants

| # | Behaviour (bash) | Mark | Where / why |
| --- | --- | --- | --- |
| 5.1 | zero git credentials in the container | ported | credential by name, never by value (T9, T23) |
| 5.2 | personal `.env` overrides sandbox dummies via `--env-file` | diverged | no env file reaches the container (T23) |
| 5.3 | origin URL userinfo stripped before the clone sees it | ported | `git/repo-url.ts` |
| 5.4 | no write-side git in the clone; branch read off `.git/HEAD` | ported | AGENTS.md "Every git operation names the repo" |
| 5.5 | fetch from the clone via upstream `upload-pack` | ported | same posture as bash, no `-c` hardening (03 §5.1(2) gap stands on both sides) |
| 5.6 | push from the main repo only | ported | `Git.push.from` |
| 5.7 | credential checks report presence only | ported | probe 3 |
| 5.8 | `master`/`main` refused as the working branch | ported | one definition, guard and picker |
| 5.9 | draft PRs on create; edit leaves draft state | ported | `forge/forge.ts` |
| 5.10 | gc never deletes logs | ported | 16 |
| 5.11 | FF-only salvage before checkout removal | diverged | rescue branch, removal authorized by a read (T29, T32, T38) |
| 5.12 | liveness re-checked right before every deletion | ported | `gc/force.ts` |
| 5.13 | PR review comments never enter prompts | ported | `prView` asks title and body only (T17) |
| 5.14 | containers publish no ports: post-start `docker port` check | diverged | not expressible in `SandboxSpec`; asserted by the live tier (`sandbox/spec.ts`) |
| 5.15 | cap-drop ALL plus a named set, pids limit, memory | ported | caps are config (T6) |
| 5.16 | sudo scoped to one sudoers line; single-file mounts; no docker socket | ported | `sandbox/spec.ts` (T6, T7) |

## 6. hae adapter

| # | Behaviour (bash) | Mark | Where / why |
| --- | --- | --- | --- |
| 6.1 | host python via `env/bin/python` | not core | |
| 6.2 | image staleness inputs hard-coded to hae's paths | diverged | the image declares its inputs (T30) |
| 6.3 | default image and cache names `hae-agentbox*` | not core | |
| 6.4 | setup body: settings copy, `setup-db.sh`, `yarn install` | not core | hae's setup hook (T7) |
| 6.5 | cap-add set justified by `setup-db.sh` | not core | the set is config (T6) |
| 6.6 | `setup-db.sh`, `Dockerfile`, `build-image.sh`, `.env.sandbox` | not core | scaffold reference (04) |
| 6.7 | prompt bodies | not core | package defaults, `.bessemer/prompts/` overrides (04, T59) |
| 6.8 | default base `origin/master` | not core | configured per repo |
| 6.9 | fixed tasks dir `.agentbox/tasks/` | not core | configured per repo |
| 6.10 | macOS bash 3.2 workarounds | dropped | no bash |

## 7. Behaviour added after 03's snapshot

| # | Behaviour (bash) | Mark | Where / why |
| --- | --- | --- | --- |
| 7.1 | review rounds stop re-deriving a settled `Not-fixed` finding | ported | `prompts/review.md` |
| 7.2 | install package deps in setup, not in the agent's budget | not core | hae's setup hook |
| 7.3 | `--branch` validated before the issue set is read off its tip | ported | T73 |
| 7.4 | cleanup reads "branch ahead" as home, not diverged | ported | T32 |
| 7.5 | ledger row records which dispatcher ran | ported | T43, T123 |
| 7.6 | refuse a dispatch whose `.agentbox/` is older than its base | diverged | self-hosted only (T42, T60) |
| 7.7 | `--allow-stale-dispatcher`, composing with the picker and replayed in its echo | ported | `dispatch/command.ts`, `picker/seed.ts` |
| 7.8 | image build command configured, not hard-coded | ported | `image-build-command` (T34) |
| 7.9 | failed runs keep their logs | ported | every log is kept (16) |
| 7.10 | heartbeat kept out of the captured verdict and PR text | ported | progress is a `Reporter` event; a pass's answer is its `result` event (20) |
