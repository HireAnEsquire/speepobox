# 03 — Behavior inventory of run.sh + tasklib.py

Ticket: [../03-behavior-inventory.md](../03-behavior-inventory.md) · Map: [../MAP.md](../MAP.md)
Researched: 2026-07-29 · Sources read at commit `e194121f75` (branch `agentbox`)

A navigation map, not a prose rewrite. Every claim carries a `file:line`.

## 0. Size at a glance

| File | Lines | Shape |
| --- | ---: | --- |
| `.agentbox/run.sh` | 1732 | bash spine. 227 lines of it are the header docstring (`run.sh:1-227`) — the de-facto spec. **Zero tests.** |
| `.agentbox/tasklib.py` | 2325 | data + interactive UI. 160-line module docstring (`tasklib.py:1-160`) is the subcommand contract. |
| `.agentbox/test_tasklib.py` | 3703 | 337 tests, stdlib `unittest`, **not wired into CI or pre-commit** (`test_tasklib.py:1-7`) |
| `.agentbox/Dockerfile` | 80 | agent image layered on hae's application image |
| `.agentbox/setup-db.sh` | 40 | in-container database bring-up (hae-specific) |
| `.agentbox/build-image.sh` | 33 | uid/gid-matched `docker build` wrapper |
| `.agentbox/{implement,review,pr}-prompt.md` | 58/46/59 | prompt templates, hae-flavoured |
| `.agentbox/.env.sandbox` | 247 | committed dummy app env (hae app vars) |
| hae's sandboxing guide (not carried) | 685 | user-facing manual + the security rationale |
| `docs/adr/0004,0005,0006` | 104/179/125 | decisions |

Subprocess/exec surface to port:
- `run.sh` issues **13 distinct `docker` invocation sites** (`run.sh:263, 292, 320, 333, 440, 467, 482, 947, 1017, 1123, 1161/1183, 1249, 1273/1274/1314, 1098`).
- `run.sh` issues **~24 `git` sites** and **6 `gh` sites** (`gh auth status` 383; `gh pr view` 1465, 1579, 1709; `gh pr edit` 1581; `gh pr create` 1584).
- `run.sh` shells out to `$PYTHON tasklib.py` at **14 call sites** (299, 449, 460, 610, 697, 737, 848, 881, 918, 1297, 1305/1344/1376/1381, 1393, 1424, 1644, 1678).
- `tasklib.py` has **11 `subprocess.run` calls** (1154, 1212, 1223, 1290, 1302, 1315, 1324, 1608, 1667, 1821, 1844) — all in the picker half except `_git_branches`/`_current_branch`/`_ref_resolvable`.

---

## 1. CLI surface

### 1.1 `run.sh` — three read-only subcommands intercepted before flag parsing

All three are intercepted *before* flag parsing and before the docker/credential preflight, deliberately: they have to work when the thing they inspect is broken.

| Command | Lines | Size | Notes |
| --- | --- | ---: | --- |
| `status` \| `--status` | `run.sh:282-301` | 20 | Requires `$# -eq 1`. Gathers `docker ps --format '{{.Names}}\t{{.Status}}'`, pipes to `tasklib.py status`. Sets `--docker-down` if docker missing/failed. No git, no writes (except tasklib's one-time ledger migration). |
| `doctor` \| `--doctor` | `run.sh:303-420` | 118 | Requires `$# -eq 1`. **9 checks** in dependency order: docker CLI+daemon (316-325), image presence+staleness (327-342), `.env` + credential presence (344-353), host python ≥3.14 (355-369), git work tree + `origin` (371-378), `gh` present + authed (380-387), `gum` (395-399), `fzf` — *only if* `tasklib.py` still greps for it (400-406), tasks dir (408-413). Exit 1 on any FAIL, 0 on warnings. |
| `gc [--force]` \| `--gc` | `run.sh:422-523` | 102 | `$# -ge 1`, own mini flag loop (431-436). Lists via `tasklib.py gc`; `--force` fetches a TSV plan (`--plan`, 460) and deletes item-by-item (462-520). Refuses `--force` when docker is down (453-456). |

### 1.2 Dispatch flags

Parsed in one `while`/`case` loop, `run.sh:556-580` — **13 arms**:

| Flag | Line | Semantics |
| --- | --- | --- |
| `<spec>` (positional) | 574-578 | Bare name → `$TASKS_DIR/<name>`; anything with `/` used as-is; `.md` appended (`run.sh:816-817`). One per invocation. |
| `--feature <folder>` | 558 | Same resolution (`run.sh:790`), must contain `issues/` (`run.sh:792`). |
| `--issues NN,NN` | 559 | Feature mode only (`run.sh:768-776`). Delegated to `tasklib select`. |
| `--branch <name>` | 560 | Required unless `--resume`/`--last` (`run.sh:777`). Task identity. |
| `--resume <branch>` | 561 | Mutually exclusive with spec/`--feature`/`--branch` (`run.sh:717-720`). |
| `--last` | 562 | Sugar → `--resume`; exclusivity checks at `run.sh:688-696`. |
| `--base <ref>` | 563 | Sets `BASE_EXPLICIT=1`, suppressing the ledger default chain (`run.sh:880-888`). |
| `--hard-reset` | 564 | Destructive; TTY confirm at `run.sh:981-985`; force-with-lease push at 1546. |
| `--feedback <text>` | 565 | Appended as a `--- Dispatcher feedback ---` block to implement (1326-1332, 1483-1489), review (1356-1362, 1508-1514), and PR (1565-1571) prompts. |
| `--feedback-edit` | 566 | Editor flow, `run.sh:890-925`. Mutually exclusive with `--feedback` (586-589); TTY-only (593-596). |
| `--dry-run` | 571 | Counted in a *separate* counter (`DRY_RUN_ARGC`) so `run.sh --dry-run` alone still enters the picker (`run.sh:606`). |
| `-h`/`--help` | 572 | `awk` prints the header docstring back. |
| unknown `--*` | 573 | Hard error. |

**Flag interaction rules, all in run.sh:**
- `--feedback` + `--feedback-edit` → refuse (586-589)
- `--feedback-edit` on non-TTY → refuse (593-596)
- `--last` + `--resume` → refuse (689-692); `--last` + spec/`--feature`/`--branch` → refuse (693-696)
- `--resume` + spec/`--feature`/`--branch` → refuse (717-720)
- `--feature` + spec → refuse (761-763)
- `--issues` without `--feature` → refuse, *except* when a `--resume`'s recorded task dir is gone (deferred to the resume guard for a better message) (768-776)

### 1.3 Picker entry

`run.sh:598-679` (82 lines). Gate: `[ "$((ORIGINAL_ARGC - DRY_RUN_ARGC))" -eq 0 ] && [ -t 0 ]` (606). Calls `tasklib.py pick`, reads back `key=value` lines into the *same shell variables the flag loop sets* (614-625) — so everything downstream is mode-blind. Special handling: `resume=1` moves `branch` → `RESUME_BRANCH` and slurps multiline feedback from a temp file (631-638); `create-branch=1` is the one branch-creation carve-out (645-657, `git branch --no-track`). Echoes an equivalent flag invocation for copy-paste (658-678).

### 1.4 Notify verbosity

`AGENTBOX_NOTIFY` parsed at `run.sh:532-540` → `off|end|steps`, `0`/`1` aliases, unknown warns once and falls back to `end`. Two functions: `notify` (1067-1074, fires at every landing + hard failure) and `notify_step` (1078-1081, gated to `steps`). Fire sites: setup complete (1282), per-issue verdict (1370, 1379, 1385), review round needs-work (1523), cleanup failure (1174), landing (1615). macOS `osascript` only; args passed as `on run argv` (not interpolated) to prevent AppleScript string-breakout.

### 1.5 `tasklib.py` subcommands

`main()` at `tasklib.py:2224-2321` — **13 subparsers**: `select`, `info`, `list`, `set-status`, `ledger-append`, `ledger-last-base`, `resume`, `last`, `feedback-edit-strip`, `resume-guard`, `pick`, `status`, `gc`. Contract documented in the module docstring `tasklib.py:1-160`.

### 1.6 Config

`.agentbox/.env` sourced with `set -a` at `run.sh:247-249`. Recognized vars documented at `run.sh:202-221`; defaults resolved at `run.sh:525-540`: `AGENTBOX_IMAGE`, `AGENTBOX_BASE`, `AGENTBOX_MAX_REVIEW_ROUNDS`, `AGENTBOX_PASS_TIMEOUT`, `AGENTBOX_YARN_CACHE_VOLUME`, `AGENTBOX_PIDS_LIMIT`, `AGENTBOX_MEMORY`, `AGENTBOX_NOTIFY`, plus `CLAUDE_CODE_OAUTH_TOKEN`/`ANTHROPIC_API_KEY`. Precedence is CLI > `.env` > default, achieved by `${VAR:-default}` after sourcing.

---

## 2. Dispatch state machine

Everything from `run.sh:942` (preflight) to `run.sh:1732`. `run_task()` is `run.sh:1028-1645` — **618 lines, the single biggest unit in the system**.

### 2.1 Pre-`run_task` resolution (still in the main shell)

| Stage | Lines | Can fail? | Cleanup owed |
| --- | --- | --- | --- |
| `--last` resolution | 688-715 | yes (empty ledger → exit 1) | none — nothing written |
| `--resume` recovery | 722-759 | yes (branch not in ledger → exit 1, tasklib prints recent-branches hint) | none |
| mode/exclusivity validation | 761-777 | yes | none |
| feature issue selection + blocker guard | 788-814 | yes (`tasklib select` exit 2 → 797-799) | none |
| resume selection guard | 834-873 | yes (`refuse`/`hard-error` → exit 1) | none |
| `--base` ledger default chain | 875-888 | never (degrades silently) | none |
| `--feedback-edit` editor | 890-925 | yes (editor nonzero 914-917; empty after strip 921-924) | **temp file** — covered by `trap 'rm -f "$FEEDBACK_EDIT_FILE"' EXIT INT TERM` at 905, cleared at 920 |
| branch existence / protected / self-base / checked-out guards | 927-940 | yes | none |
| docker/gh/credential/image preflight | 942-952 | yes | none |
| `mkdir -p logs checkouts locks` | 956 | — | dirs left behind (benign) |
| `git fetch origin --quiet` | 957 | yes (network) | none |
| `git rev-parse` base, merge-base | 958-1002 | yes (bad ref) | none |
| `--hard-reset` TTY confirm + `git branch -f` | 971-995 | yes (declined → exit 1) | **branch already reset** if the failure comes after 992 |
| `check_no_inflight_run` | 1009-1021, called 1148 | yes | none — deliberately runs *before* any write |

The invariant here (stated at `run.sh:1144-1147`): **nothing is touched before `check_no_inflight_run` passes** — no lock write, no log rotation, no trap armed. A refused dispatch can never tear down the live run's container.

### 2.2 `run_task` — the six steps

State variables are deliberately **not `local`** (`run.sh:1031`) because the EXIT trap fires after the function returns.

| # | Step | Lines | Failure mode | Cleanup owed |
| --- | --- | --- | --- | --- |
| — | identity derivation (`slug`, `wt`, `cid`, `log`) | 1132-1142 | — | — |
| — | in-flight guard | 1148 | exit 1 | none |
| — | write lock `$LOCKS_DIR/$slug.pid` | 1149-1150 | — | lock (cleanup 1184) |
| — | log rotate `mv -f "$log" "$log.1"` | 1155 | — | — (logs never deleted) |
| — | stale-leftover clear: `docker rm -fv`, `rm -rf "$wt"` | 1161-1162 | `\|\| true` | — |
| — | **arm `trap cleanup EXIT` + `trap 'exit 130' INT TERM`** | 1189-1190 | — | everything from here is trap-covered |
| 1 | checkout: `git clone --no-hardlinks --branch` from `$REPO_ROOT` | 1196-1213 | clone failure, remote set-url, config | checkout dir, container, lock |
| 2 | container: `docker run -d` (hardened) | 1215-1264 | image/daemon/cap failure | same |
| 3 | setup: chown mounts (`-u root`), settings copy + `sudo setup-db.sh` + `yarn install` | 1266-1282 | any `set -e` failure inside the `bash -lc` | same |
| 4 | implement pass(es) | 1284-1492 | `claude_pass` returns 1 after 3 attempts | same |
| 5 | review loop(s) | 1494-1527 | capped at `MAX_REVIEW_ROUNDS`, never fatal | same |
| 6 | land: FF fetch → push → PR | 1529-1592 | FF fetch failure calls `fail` (1539) → return 1 | same, **plus the checkout is kept** for inspection |
| — | notify | 1594-1615 | `\|\| true`'d | — |
| — | ledger append | 1617-1644 | degrades to stderr warning in tasklib (`tasklib.py:425-429`) | — |

### 2.3 `cleanup()` — the single cleanup owner

`run.sh:1169-1186`, 18 lines, installed as `trap cleanup EXIT` at 1189. It does, in order:

1. Capture `$?` (1170) and report the failed step + fire a failure notification (1172-1175).
2. If `$wt` exists: **FF-only** `git fetch "$REPO_ROOT/$wt" refs/heads/$branch:refs/heads/$branch`. Success → `rm -rf "$wt"`. Failure → keep the checkout and say so loudly (1176-1182).
3. `docker rm -fv "$cid" || true` (1183).
4. `rm -f "$LOCKS_DIR/$slug.pid"` (1184).

**The bash bug this design exists to work around** is documented at `run.sh:1024-1027`: macOS bash 3.2 does not fire EXIT traps when a *backgrounded* function's subshell exits normally, so `run_task &` silently leaked containers and checkouts after every completed run. Hence `run_task` runs in the main shell (`run.sh:1731`), foreground.

**Gaps in cleanup coverage:**
- `SIGKILL` is uncatchable — leaves container + checkout + lock. This is exactly what `gc` exists to reclaim (`run.sh:422-523`).
- The `--feedback-edit` temp file has its own separate trap (905) which is *replaced* by `trap cleanup EXIT` later — noted explicitly at `run.sh:902-904`. Between 920 (`trap - EXIT INT TERM`) and 1189, no trap is armed at all.
- `claude_pass`'s scratch file `$LOGS_DIR/.pass-$slug.$$` (`run.sh:1091`) is removed on both paths (1112, 1121) but **not trap-covered** — an interrupt mid-pass leaks it.
- A `--hard-reset` that dies between `git branch -f` (992) and the clone (1204) leaves the branch reset with no run to show for it (reflog-recoverable only).

### 2.4 `claude_pass` — the retry engine

> **Superseded in the subject, 2026-08-06.** bash agentbox removed retry: `claude_pass` now runs one
> attempt and a failed pass ends the task. The port follows (05 Q16R). This section stands as read at
> `e194121f75` — the port's parity checklist compares against the *current* bash, not this snapshot.

`run.sh:1090-1130`, 41 lines. Per attempt (max 3):
- Logs the full assembled prompt verbatim under the step banner (1096) — "self-authored, secret-free".
- `printf '%s\n' "$prompt" | docker exec -i "$cid" timeout "$PASS_TIMEOUT" bash -c 'claude --dangerously-skip-permissions -p --output-format stream-json --verbose | python3 /agentbox/stream-filter.py'` (1098-1100). **Prompt travels on stdin, never as a shell string** — so quotes/backticks/`$(...)` in `--feedback` arrive literally.
- Backgrounded, heartbeat every 30s, console line every 120s (1102-1109).
- `rc == 124` → timeout message; otherwise last log line truncated to 140 chars (1116-1120).
- **Aborts without retrying if the container is gone** (1122-1126).
- Sleeps 30s between attempts (1127).

### 2.5 Feature-mode loop

`run.sh:1292-1431` (140 lines). Per selected issue, in dependency order:
1. `tasklib info` → tab-separated `num/title/type/status/blocked-by` (1297).
2. **HITL stop**: `Type: HITL` → set-status `blocked (HITL)`, record checklist entry, break — *before* touching the container (1301-1309).
3. Re-point `/spec.md` symlink at the issue via `docker exec -u root ln -sfn` (1314).
4. `issue_boundary="$(git -C "$wt" rev-parse HEAD)"` (1316) — see §5, invariant 2.
5. Implement pass → on failure, set-status `needs-work`, break (1333-1347).
6. Review loop up to `MAX_REVIEW_ROUNDS`, break on `<verdict>approved</verdict>` (1349-1372).
7. Approved → set-status `Done`; else set-status `needs-work` + break (1375-1387).

**Three stop conditions**, all landing what's already done: HITL, implement failure, needs-work cap.

Then: unreached issues are recorded as `not-attempted` (1391-1397); the PR checklist is rebuilt over the **whole feature** (not just this run's selection) by merging this run's fresh lines over a status-derived fallback (1399-1424) — implemented without associative arrays because run.sh must stay bash-3.2-safe (1404-1405).

### 2.6 Feedback-only path

Triggered by the resume guard (`run.sh:863-871`). Always takes the single-pass branch even when `FEATURE_MODE=1` (`run.sh:1292` condition). Its implement prompt (1439-1474) is built from: `implement-prompt.md` + "the feedback IS your work order" framing + merge-base + background mount note + **best-effort `gh pr view --json title,body`** (1465). Review criteria are swapped (1504-1507). Its ledger line carries `RESUME_IDENTITY` forward rather than re-deriving from `FEATURE`/`spec` (1624-1635).

### 2.7 Land step

`run.sh:1529-1592` (64 lines).
1. FF-only fetch from clone (1538) — failure → `fail` → return 1 → cleanup.
2. Count commits past merge-base and past `pre_tip` (1540-1541).
3. If 0 commits: skip everything, "nothing to land" (1589-1592).
4. Push: `--force-with-lease` in hard-reset mode, plain otherwise (1545-1549). Explicit refspec both ways.
5. PR-description claude pass, falling back to a static body on failure (1554-1573).
6. `gh pr view "$branch" --json url,state --jq 'select(.state == "OPEN") | .url'` → edit-or-create (1579-1587). Body always on stdin via `--body-file -`.

### 2.8 `--dry-run`

`run.sh:1647-1724` (78 lines). Runs *after* every guard, so it is a real guard rehearsal (rationale at 1648-1656). Re-derives slug/cid/wt/log with the same expressions `run_task` uses (1658-1661) — **duplicated, not shared**. Re-runs `check_no_inflight_run` (1664). Reproduces the `gh pr view` probe including its "no pull requests found" disambiguation (1702-1720).

---

## 3. Data layer (`tasklib.py`)

| Area | Lines | Size | Key functions |
| --- | --- | ---: | --- |
| Issue model + parsing | 174-379 | 205 | `Issue` (179-195), `parse_issue` (217-241), `load_issues` (244), `_topo_order` (248-261), `select_issues` (264-328), `cmd_select/info/list/set-status` (331-379) |
| Ledger | 382-698 | 316 | `central_ledger_path` (385), `read_ledger` (392-414), `append_ledger` (417-429), `last_base_for_branch` (432), `newest_record_for_branch` (442), `recent_distinct_branches` (451), `resolve_last` (464), `resolve_resume` (525-576), `resume_dispatch_action` (579-602), `_migrate_legacy_ledgers` (635-660), `cmd_ledger_append` (663-688) |
| Status render | 701-893 | 193 | `parse_docker_rows` (713), `stale_locks` (730), `_format_table` (807-824), `render_running` (827-844), `render_recent` (847-869), `render_status` (872) |
| gc scan/render | 896-1081 | 186 | `_is_live_status` (911), `_pid_alive` (938), `_lock_pid_alive` (952), `collect_gc_items` (963-1022), `summarize_logs` (1025-1039), `render_gc` (1042-1060), `render_gc_plan` (1063) |
| Picker | 1084-2222 | **1139** | `materialize_ad_hoc` (1097), gum wrappers (1251-1331), `pick_resume` (1381-1449), `pick_task_source` (1470-1545), `pick_issues` (1552-1605), `pick_branch` (1696-1807), `pick_base` (1828-1884), step machinery (1886-2072), `cmd_pick` (2074-2222) |
| argparse `main` | 2224-2325 | 101 | 13 subparsers |

### 3.1 Issue parsing

`parse_issue` (`tasklib.py:217-241`) — deliberately tolerant:
- Header regex `^\s*(status|type|blocked by)\s*:\s*(.*?)\s*$`, case-insensitive (`tasklib.py:174`).
- Parsing **stops at the first `##`** (223-224) — headers must be in the preamble.
- Title = first `#` line, falling back to `path.stem` (225-227).
- `blocked_by` = leading number of each comma token (231).
- Issue number = leading number of the stem, falling back to the title (232-234).
- Missing `Type:` defaults to `AFK` (238) — a deliberate compat choice.
- `is_done` is a **first-token** match `done\b(?!-)` (192-195), so `Done (verified …)` counts and `needs-work`/`done-ish` do not.

### 3.2 Selection

`select_issues` (`tasklib.py:264-328`) — three phases:
1. **Explicit `--issues`**: parse tokens, refuse unknown numbers with a `DispatchError` naming them (271-286).
2. **Default**: every AFK, not-Done issue, then a **fixed-point shrink** dropping any issue whose blockers aren't Done-or-also-selected (288-302). Unresolvable issues are silently left for a later run, not an error.
3. `_topo_order` (248-261) — Kahn-style, ties broken by ascending number, raises on cycles.
4. **Blocker guard** (309-326): any selected issue with an out-of-set blocker that isn't Done → `DispatchError` listing every violation. Exit 2 from `cmd_select` (331-339).

### 3.3 `Status:` writes

`cmd_set_status` (`tasklib.py:359-379`). Rewrites the first `Status:` header line in place; if none exists, inserts one before the first `##`; if the file has neither, inserts at index 1. Always rewrites the whole file with a trailing newline. Called from run.sh at 1305 (blocked/HITL), 1344 (implement-failed), 1376 (Done), 1381 (needs-work).

### 3.4 `runs.jsonl` schema

Written by `cmd_ledger_append` (`tasklib.py:663-688`). One JSON object per line:

```
timestamp  ISO-8601 UTC (datetime.now(timezone.utc).isoformat())
branch     str
base       str
spec       str | null      one-off/ad-hoc identifier (basename)
feature    str | null      feature folder name (basename)
issues     {NUM: OUTCOME}  feature runs only; outcomes: approved|needs-work|implement-failed|blocked-hitl|not-attempted
outcome    str | null      one-off/feedback-only runs: approved|needs-work
pr_url     str | null
task_dir   str | null      recorded FACT, no longer a write location; "" records as null
```

Location: `central_ledger_path` = `tasks_dir.parent / "runs.jsonl"` (`tasklib.py:385-389`) — i.e. `.agentbox/runs.jsonl`. Gitignored (`.agentbox/.gitignore:6`).

**Degradation contract** (`tasklib.py:392-414`): a missing file yields no records; a corrupt line is skipped, never raised; a non-dict JSON value is dropped. Writes are best-effort — an `OSError` prints to stderr and returns (417-429), because the push/PR already happened.

**Auto-migration** `_migrate_legacy_ledgers` (`tasklib.py:635-660`): no-op if the central file exists; otherwise merges every `<tasks_dir>/*/runs.jsonl`, stamping each record's `task_dir` with the legacy file's own directory, sorted by timestamp. Legacy files are left in place. Triggered from **five** entry points: `cmd_last` (482), `resolve_resume` (545), `cmd_ledger_append` (666), `cmd_ledger_last_base` (694), `collect_recent_ledger_records` (744) — the read paths trigger it too, per the contract.

### 3.5 Status rendering

`render_status` (`tasklib.py:872-878`) = `render_running` + blank + `render_recent`. Docker facts arrive on stdin as `NAME\tSTATUS` (`cmd_status:882`). `parse_docker_rows` (713-727) filters to the `agentbox-` prefix and treats **the slug as the branch** — lossy for branches with slashes, accepted explicitly (717-718). `stale_locks` (730-735) cross-checks `*.pid` stems against live slugs. `_format_table` (807-824) is stdlib-only column alignment with per-column truncation opt-in (`_STATUS_MAX_COL_WIDTH = 32`, line 704) and an unpadded last column so piped output has no trailing whitespace.

### 3.6 gc scan

`collect_gc_items` (`tasklib.py:963-1022`) produces three classes:
- **container**: `agentbox-*` in `docker ps -a` whose status doesn't start with `Up` (`_is_live_status`, 911-915 — the sole liveness test, no second docker call).
- **checkout**: a dir under `checkouts/` with no live container **and** no live lock pid (992-1007). The lock check (`_lock_pid_alive`, 952-960) exists to cover run.sh's clone-before-`docker run` and cleanup-after-`docker rm` windows.
- **lock**: a `*.pid` whose pid is dead and has no live container (1009-1020).

`docker_down` disables the container class entirely and sets `deletable=False` everywhere (974-976). `render_gc_plan` (1063-1064) emits TSV `class\tslug` filtered on `deletable and cls in _GC_DELETABLE_CLASSES`.

### 3.7 Resume recovery

`resolve_resume` (`tasklib.py:525-576`). Mode comes from **which identity field the newest record carries** (`feature` vs `spec`), not from re-inspecting the filesystem — so a feedback-only run's own ledger line carries mode forward and repeated `--resume`s compose. Only "branch has no ledger record at all" raises; every other degradation is expressed as `task_dir_exists=False`.

`resume_dispatch_action` (`tasklib.py:579-602`) is the pure decision table — **4 outcomes**:

| `task_dir_exists` | `issues_arg` | `mode` | `issue_count` | `has_feedback` | → |
| --- | --- | --- | --- | --- | --- |
| 0 | set | — | — | — | `hard-error` |
| 0 | — | — | — | 1 | `feedback-only` |
| 0 | — | — | — | 0 | `refuse` |
| 1 | — | spec | — | — | `normal` |
| 1 | — | feature | >0 | — | `normal` |
| 1 | — | feature | 0 | 1 | `feedback-only` |
| 1 | — | feature | 0 | 0 | `refuse` |

### 3.8 Picker

The largest single area (1139 lines, ~49% of tasklib). Structure:
- **Backend wrappers**: `prompt` (1230), `read_multiline` (1237), `gum_choose` (1266-1296), `gum_confirm` (1297), `gum_input` (1308), `gum_write` (1321). `_raise_gum_cancel` (1251-1264) maps gum exit codes to `PickBack`/`PickAbort`. **Every gum use is guarded by `shutil.which("gum")` — 13 call sites** (1410, 1443, 1497, 1522, 1534, 1572, 1737, 1759, 1801, 1843, 1875, 2041); each degrades independently to numbered lists / `input()`.
- **fzf** at two sites: `_fuzzy_all_branches` (1653-1694, `shutil.which("fzf")` at 1664) and `pick_base` (1828-1884, at 1843). `doctor` greps the source for `shutil.which("fzf")` (`run.sh:400`) rather than hardcoding the dependency.
- **Wizard step machinery**: `_DOWNSTREAM_STEPS` (1942-1948) declares which steps an edit invalidates; `_natural_next_step` (1896), `_step_back` (1923), `_summary_lines` (1999), `_summary_menu` (2022-2052), `_trail` (2054).
- **Control flow via exceptions**: `PickBack` (202-204) and `PickAbort` (207-209). Sub-prompts catch `PickBack` and `continue`; `PickAbort` always propagates.
- **Ad-hoc materialization is deferred to Dispatch** (`materialize_ad_hoc`, 1097-1114) so an Esc/Abort after typing a prompt leaves no orphan file. File is named `<tasks-dir>/ad-hoc/<timestamp>-<branch>.md`.
- Only the Dispatch choice prints `key=value` lines; no git state is touched before that (`tasklib.py:91-99`).

---

## 4. Runtime state

All under `.agentbox/`, all gitignored (`.agentbox/.gitignore`). Dirs created at `run.sh:956` (skipped on `--dry-run`).

**Slug derivation** — the identity everything keys off. `run.sh:1134`:
```
slug = printf '%s' "$branch" | tr 'A-Z' 'a-z' | tr -cs 'a-z0-9\n' '-' | sed 's/^-//;s/-$//'
```
Duplicated verbatim in the dry-run path at `run.sh:1658`. Not injective (`feat/x` and `feat-x` collide) — accepted.

| Dir | Layout | Created | Deleted |
| --- | --- | --- | --- |
| `locks/` | `<slug>.pid` containing `$$` | `run.sh:1150`, after the in-flight guard | `cleanup` (`run.sh:1184`); `gc --force` (`run.sh:516`) |
| `logs/` | `<slug>.log` (current), `<slug>.log.1` (one rotation) | rotated at `run.sh:1155`, header written 1156-1157 | **never** — audit trail. gc summarizes only (`tasklib.py:1025-1039`) |
| `logs/.pass-<slug>.$$` | claude_pass scratch | `run.sh:1091` | 1112 / 1121; leaks on interrupt |
| `checkouts/` | `<slug>/` — a full `git clone --no-hardlinks` | `run.sh:1204` | `cleanup` after FF salvage (1176-1182); `gc --force` after FF salvage (488-513) |
| `runs.jsonl` | append-only JSONL | `tasklib.py:426` | never |
| `tasks/ad-hoc/` | `<timestamp>-<branch>.md` | `tasklib.py:1097` | never |
| container | `agentbox-<slug>`, plus an anonymous node_modules volume | `run.sh:1249` | `cleanup` `docker rm -fv` (1183); pre-run clear (1161); `gc --force` (482) |
| shared volume | `$AGENTBOX_YARN_CACHE_VOLUME` (default `hae-agentbox-yarn-cache`) | on first `docker run` | never |

Log format: `== agentbox ==` banner lines separate orchestrator steps from step output (`banner`, `run.sh:1042-1048`); each claude pass's full prompt is logged verbatim between `-- prompt --` markers (`run.sh:1096`).

---

## 5. Security invariants as implemented

The twelve the ticket names. **Verdict column: `code` = a mechanism would have to be removed for it to break; `absence` = it holds only because nobody added a flag/mount; `comment` = asserted in prose, relied on upstream.**

| # | Invariant | Enforced at | Verdict |
| --- | --- | --- | --- |
| 1 | Zero git credentials in the container | `run.sh:1249-1263` (mount list); `.env.sandbox` sets a dummy GitHub token; `Dockerfile:35-39` (no `gh` installed) | **absence + one gap, see below** |
| 2 | No write-side git inside the agent's clone; branch read textually from `.git/HEAD` | `run.sh:505` (`sed -n 's#^ref: refs/heads/##p' "$gc_wt/.git/HEAD"`); rationale 494-505 and 1531-1536 | **comment**, with a documented read-side carve-out |
| 3 | Host fetches from the clone via hardened `upload-pack` | `run.sh:508`, `run.sh:1177`, `run.sh:1538` | **comment** — see below |
| 4 | Push from the main repo only | `run.sh:1546`, `run.sh:1548` — plain `git push` with `cwd=$REPO_ROOT` (set at `run.sh:231`), explicit refspec. No `git -C "$wt" push` exists anywhere | **code** |
| 5 | Credential checks report presence only | `run.sh:253` (`[ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}${ANTHROPIC_API_KEY:-}" ]`); doctor 347-353 prints "(value not shown)"; dispatch preflight 945-946 | **code** |
| 6 | master/main refused as working branch | `run.sh:931-935` (dispatch); `tasklib.py:1084-1085` + `1779-1781` (picker) | **code**, but duplicated |
| 7 | Draft PRs only | `run.sh:1584` `gh pr create --draft` | **code** on create, **absence** on update |
| 8 | gc never deletes logs | `tasklib.py:898` `_GC_DELETABLE_CLASSES = {"container","checkout","lock"}`; `tasklib.py:1063-1064` filters the plan on it; `collect_gc_items` (963-1022) never emits a log class; `run.sh:480-519` `case` has exactly three arms | **code**, belt-and-braces |
| 9 | FF-only salvage before checkout removal | `run.sh:508→509` (gc), `run.sh:1177→1178` (cleanup), `run.sh:1538` (land). All use `refs/heads/X:refs/heads/X` with **no leading `+`**, and `rm -rf` sits inside the success branch only. Detached HEAD → skip, not delete (`run.sh:506-507`) | **code** |
| 10 | Liveness re-checked immediately before every deletion | `run.sh:465-479` — container `docker ps -q -f name="^${gc_cid}\$"` **and** lock `kill -0`, both inside the per-item loop, before the `case` | **code** |
| 11 | PR review comments never enter prompts | `run.sh:1465` — `gh pr view "$RESUME_PR_URL" --json title,body`. The `--json` field list *is* the enforcement; rationale at 1456-1463. No other `gh` call reads comments (1579, 1709 use `--json url,state`) | **code** |
| 12 | Task containers publish no ports | `run.sh:1249-1263` — no `-p`, no `--publish`, no `--network` | **absence — weakest of the twelve** |

### 5.1 The gaps worth carrying into the port

**(1) Two credential leak paths with no guard** (the origin-URL path since repaired in bash, see ticket 10; the env-file path closed only in the port, T23).

- `run.sh:1262` applies `--env-file "$BOX/.env.sandbox" --env-file "$BOX/.env"` **in that order**, so anything in the personal, gitignored `.agentbox/.env` overrides the sandbox dummies — including `GITHUB_TOKEN`. `.env.example` (19 lines) advertises only `CLAUDE_CODE_OAUTH_TOKEN`/`ANTHROPIC_API_KEY`/`AGENTBOX_*`, but nothing validates the file's contents, `doctor` doesn't check for it, and no test covers it.
- `run.sh:1205` runs `git -C "$wt" remote set-url origin "$REMOTE_URL"` where `REMOTE_URL="$(git remote get-url origin)"` (`run.sh:959`). If the host's `origin` is an HTTPS URL with an embedded token (`https://x-access-token:TOKEN@github.com/…` — the shape `gh auth setup-git` and most CI produce), that token is written into the clone's `.git/config` and is readable by the agent. Nothing strips userinfo from the URL. **This is the one I would fix first**; in the port it is a two-line URL-sanitize.

**(2) Invariant 3 is a claim about upstream git, not a configuration.** There are no `-c uploadpack.*`, no `GIT_CONFIG_NOSYSTEM`, no `protocol.*` restrictions on any of the three fetch sites. "Hardened `upload-pack`" means "git's upload-pack is the code path designed to face untrusted repos" — true, but there is no agentbox-side mechanism. A port that keeps the invariant should make it explicit (e.g. `git -c protocol.allow=never -c uploadpack.hideRefs=…`, or a `--no-local` decision) rather than inherit the prose.

**(3) Invariant 12 has no enforcement at all.** No `-p` in the arg list is the entire mechanism. It is not asserted in a comment, not in hae's sandboxing guide, not covered by a test, and not checked by `doctor`. A one-line edit anywhere in the 15-line `docker run` at `run.sh:1249-1263` silently breaks it. In Effect this becomes a typed container spec where publishing ports is not expressible. (Since repaired in bash; see ticket 10.)

**(4) Invariant 2's known carve-out.** `run.sh:1316` runs `git -C "$wt" rev-parse HEAD` inside the feature loop, i.e. *after* the previous issue's agent passes have committed. This is host-side git inside an agent-owned clone. It is documented and accepted in hae's sandboxing guide, as read-only: `rev-parse` reads refs and executes nothing from the clone's config. Note that `rev-parse` does still load the clone's `.git/config`, so the residual is config-triggered execution (`core.fsmonitor` class), not ref reading. Not an unenforced invariant — a knowingly-accepted exception — but the port should either re-derive the boundary from the host side or make the exception explicit in the type.

**(5) Invariant 7 half-holds.** `gh pr edit` (`run.sh:1581`) never touches draft state, so a PR a human marked ready-for-review stays ready across re-dispatches. That is arguably correct, but "draft PRs only" as written is only true of *creation*.

**(6) Invariant 6 is duplicated.** `{master, main}` is hardcoded twice — `run.sh:932` and `tasklib.py:1085` — with no shared definition and no `--base`-derived default-branch detection. ADR 0006 already flags base auto-detect as necessary for adopters (`.agentbox/ROADMAP.md`, adopter inputs).

**(7) None of the twelve has an automated test.** They live entirely in run.sh, which has no test suite (§6).

### 5.2 Container hardening (supporting, not in the ticket's twelve)

`run.sh:1249-1263`: `--cap-drop ALL` then six caps added back with a per-cap justification at 1222-1233 (`CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `SETUID`, `SETGID`, `KILL` — all for setup-db.sh's root path). No `NET_*`. `--pids-limit`, `--memory`. Agent sudo is scoped to one command, the setup script, invoked by its exact path at `run.sh:1278`. Mounts are single files, never the `.agentbox` dir (which holds `.env` and other tasks' checkouts) — rationale at `run.sh:1215-1217`. No docker socket.

---

## 6. Test suite shape

`.agentbox/test_tasklib.py`, 3703 lines, 337 tests, stdlib `unittest`. Run manually: `python3 .agentbox/test_tasklib.py`. Its own docstring says why (`test_tasklib.py:1-7`): it is dev-local tooling, not wired into hae's test runner or CI.

**Not wired into anything.** No `.pre-commit-config.yaml` hook, no CI job, no mention in hae's sandboxing guide or `CLAUDE.md`. It runs only when someone remembers.

**56 `TestCase` classes.** Distribution by area:

| Area | Tests | Share | Classes (first line) |
| --- | ---: | ---: | --- |
| **Picker / wizard** | **138** | **41%** | `PickIssuesTests` (:1754), `PickResumeTests` (:1976), `PickTaskSourceTests` (:2102, 19), `PickBranchTests` (:2324, **29**), `PickBaseTests` (:2726), `SummaryLinesTests` (:2829), `SummaryMenuTests` (:2894), `CmdPickTests` (:2954, **30**), `GumHelpersTests` (:3602, 17) |
| Status render | 39 | 12% | `ParseDockerRowsTests` (:873), `StaleLocksTests` (:897), `IssueSummaryTests` (:961), `OverallOutcomeTests` (:972), `AgeTests` (:991), `FormatTableTests` (:1023), `RenderRunningTests` (:1038), `RenderRecentTests` (:1081), `RenderStatusTests` (:1114), `CmdStatusTests` (:1211), `CollectRecentLedgerRecordsTests` (:923) |
| Resume | 39 | 12% | `ResolveResumeTests` (:384, 12), `ResumeDispatchActionTests` (:552, 8), `CmdResumeTests` (:611), `CmdResumeGuardTests` (:660), `ResolveLastTests` (:687), `CmdLastTests` (:716), `ResumeRunLabelTests` (:1865), `LatestPerBranchTests` (:1895), `ResumeIssueCountTests` (:1919) |
| Ledger / `runs.jsonl` | 36 | 11% | `LedgerTests` (:149), `CentralLedgerPathTests` (:224), `CmdLedgerAppendLastBaseTests` (:231), `NewestRecordForBranchTests` (:341), `RecentDistinctBranchesTests` (:360), `MigrateLegacyLedgersTests` (:799), `LedgerBranchHelpersTests` (:1706) |
| gc | 35 | 10% | `IsLiveStatusTests` (:1256), `PidAliveTests` (:1267), `HumanSizeTests` (:1287), `DirSizeTests` (:1301), `CollectGcItemsTests` (:1316, 11), `SummarizeLogsTests` (:1428), `RenderGcTests` (:1458), `RenderGcPlanTests` (:1484), `CmdGcTests` (:1498) |
| Naming / path resolution | 25 | 7% | `IsProtectedTests` (:1572), `SlugifyTests` (:1581), `MaterializeAdHocTests` (:1592), `ResolveSpecTests` (:1620), `BranchNameSuggestionTests` (:1656), `FirstFreeBranchNameTests` (:1675) |
| Issue parsing + selection | 14 | 4% | `ParseIssueTests` (:35), `SelectIssuesTests` (:71) |
| Feedback-edit stripping | 5 | 1% | `StripFeedbackEditTextTests` (:761), `CmdFeedbackEditStripTests` (:786) |
| `Status:` writes | 2 | <1% | `SetStatusTests` (:1548) |

**Style.**
- Real filesystem in a temp dir — **30 `tempfile.TemporaryDirectory()`** sites, always with `addCleanup`. Issues, `runs.jsonl`, locks, logs and checkouts are genuinely written and read.
- **Subprocess is fully mocked, never executed** — 20 `mock.patch("tasklib.subprocess.run")` sites. No test shells out to git, docker, gum or fzf. Git helpers are patched by name instead (`_git_branches` ×21, `_branch_exists` ×22, `_remote_branch_exists` ×9, `_ref_resolvable` ×2, `_current_branch` ×1).
- **`shutil.which` is the main dial — patched 56 times.** `None` forces the plain-`input()` fallback, `"/usr/bin/gum"` forces the gum path; most picker behaviors are asserted on *both*, sometimes with an explicit "matches fallback result" cross-check (`:1842`, `:2224`, `:2447`).
- `redirect_stdout`/`redirect_stderr` into `StringIO` for every `cmd_*` test; `builtins.input` patched with `side_effect` lists at 22 sites (including `side_effect=AssertionError("should not prompt")` at `:1770` to assert a step is *skipped*).
- One module-level factory (`write_issue`, `:25`); no fixtures or conftest — each class rolls its own `_run`/`_pick`/`_collect` helper.
- One place touches real syscalls: `PidAliveTests` (`:1267`) against `os.getpid()`.

**This shape is exactly what the map's thesis targets.** The suite is a subprocess-mock suite: it verifies argv construction and exit-code mapping, not that the commands do what they are believed to do. And 41% of it defends the picker — the piece the roadmap already plans to replace (F5).

### 6.1 tasklib functions with no direct test

Genuine gaps (no direct *and* no indirect coverage): `cmd_select` (`tasklib.py:331`), `cmd_info` (`:347`), `cmd_list_all` (`:352`), `main` (`:2224` — the whole argparse wiring), `read_multiline` (`:1237`), `_print_issue_line` (`:342`), `_mtime_age` (`:795`), `_first_line` (`:1093`), `_fuzzy_all_branches` (`:1653`).

Note that `cmd_select`, `cmd_info` and `cmd_list_all` are the **three subcommands run.sh calls most** (`run.sh:797, 1297/1393/1678, 1424`) — the `DispatchError` → exit-2 mapping in `cmd_select` (`tasklib.py:331-339`), which is the blocker guard's entire contract with the shell, is untested.

Covered only indirectly: `_leading_number` (`:212`), `_topo_order` (`:248`), `_age_from_seconds` (`:770`), `_truncate` (`:803`), `_lock_pid_alive` (`:952`), `_feature_recency_key` (`:1451`), and the wizard-state trio `_issues_step_applies`/`_natural_next_step`/`_step_back`/`_trail` (`:1886`, `:1896`, `:1923`, `:2054`) — the last group heavily exercised through `CmdPickTests`.

### 6.2 What has no test at all

**The entire bash spine.** `run.sh` is 1732 lines with zero tests, no `bats`, no `shellcheck` hook, no lint. That includes every one of these:

- All 13 flag-parse arms and all 6 mutual-exclusivity rules (`run.sh:556-596`, 688-720, 761-776)
- The dispatch state machine and every failure/cleanup path (`run.sh:1028-1645`)
- `cleanup()` and the trap wiring — **the bug class ADR 0006 names as bash's worst, and the one the bash-3.2 EXIT-trap incident actually bit** (`run.sh:1024-1027, 1169-1190`)
- `claude_pass` retry/timeout/dead-container logic (`run.sh:1090-1130`)
- The feature loop's three stop conditions and the whole-feature checklist merge (`run.sh:1292-1431`)
- `--dry-run`'s parity with the real path — the duplicated slug/cid/wt/log derivation at `run.sh:1658-1661` vs `run.sh:1134-1137` is exactly the kind of drift a test would catch
- `doctor`'s 9 checks (`run.sh:303-420`)
- `gc --force`'s deletion loop, including the liveness re-check and the FF salvage (`run.sh:462-520`)
- Every security invariant in §5
- `--feedback-edit`'s editor invocation and its temp-file trap (`run.sh:890-925`)
- The slug derivation itself

That asymmetry — a heavily-tested data layer bolted to a completely untested orchestrator — is the single clearest argument the map's Effect thesis has, and it is the thing to measure the bake-off on.

---

## 7. hae-specific adapter vs portable core

### 7.1 Portable core (moves as-is, modulo language)

- `run.sh`'s entire orchestration shape: flag parsing, picker wiring, resume recovery, guards, preflight, `run_task`'s six steps, `cleanup`, `claude_pass`, land, notify, ledger, `--dry-run`, `status`, `gc`.
- `tasklib.py`'s issue layer (174-379), ledger layer (382-698), status render (701-893), gc scan/render (896-1081), picker (1084-2222). Nothing in any of these mentions Django, postgres, or hae.
- Slug/lock/log/checkout conventions, `runs.jsonl` schema, the `<verdict>approved</verdict>` contract.
- The three prompt templates' *structure* (task/orientation/commands/implement/verify/commit/rules; role/review/fix/verdict/rules).

### 7.2 hae-specific adapter (does not move)

| Thing | Location | Why |
| --- | --- | --- |
| Host python resolution via `env/bin/python` | `run.sh:244-245`, doctor 355-369 | hae's repo-root venv; also the ≥3.14 floor exists only because tasklib uses PEP 758 comma-`except` (`tasklib.py:401, 947`) |
| Image staleness inputs | `run.sh:265` — hae's backend and frontend lockfiles plus `$BOX/Dockerfile` | hae layout |
| Default image / cache names | `run.sh:525` hae's image name, `529` its yarn-cache volume name | hae naming |
| The **entire setup step** | `run.sh:1272-1281` — a settings-module copy, the database bring-up, and the frontend install | This is exactly what ADR 0006 turns into a `.agentbox/setup.sh` hook |
| `client/node_modules` pre-create + anonymous volume | `run.sh:1212`, `1258` | virtiofs workaround, yarn-specific |
| Cap-add set | `run.sh:1250-1252` | justified *by setup-db.sh's* root path — a different setup hook needs a different set |
| `setup-db.sh` | whole file, 40 lines | hae's database bring-up |
| `Dockerfile` | whole file, 80 lines | hae's image recipe |
| `build-image.sh` | whole file | hae's base image |
| `.env.sandbox` | 247 lines | hae app env vars |
| Prompt bodies | `implement-prompt.md` ORIENTATION/COMMANDS/VERIFY (hae's stack-specific test, migration and package commands); `review-prompt.md` FIX section | ADR 0006's "package defaults + `.agentbox/prompts/` overrides" |
| `master`/`main` hardcoding | `run.sh:932`, `tasklib.py:1085`, default `AGENTBOX_BASE=origin/master` (`run.sh:526`) | adopters have a mix; base auto-detect is a stated requirement |
| `.agentbox/tasks/` as the fixed tasks dir | `run.sh:233` and every tasklib `--tasks-dir` caller | configurable tasks dir is a stated requirement |
| macOS bash 3.2 constraints | `run.sh:1024-1027`, `1404-1405` | disappears entirely in the port |

### 7.3 Suggested slice boundaries for tracer bullets

Ordered by how cleanly each cuts, with the size to expect:

1. **Ledger + issue layer** (`tasklib.py:174-698`, ~520 lines, ~40% of the existing tests) — pure functions over files. No subprocess. The cheapest real slice.
2. **status + gc scan/render** (`tasklib.py:701-1081`, ~380 lines) — pure functions over `docker ps` text + filesystem. Still no subprocess of its own.
3. **doctor** (`run.sh:303-420`, 118 lines, 9 independent probes) — the natural first Effect `Layer` exercise: nine effects, each with a typed failure, rendered by a thin CLI.
4. **Dispatch core** (`run.sh:1028-1645`, 618 lines) — the piece the whole thesis rests on. Scope/acquireRelease over: lock, log rotation, checkout, container. Four resources, one cleanup order, currently one 18-line trap.
5. **gc --force loop** (`run.sh:462-520`, 59 lines) — small, but carries three of the twelve invariants (8, 9, 10) and is the best place to prove "guaranteed cleanup under failure" without a container.
6. **Picker** (`tasklib.py:1084-2222`, 1139 lines) — biggest, least load-bearing, and the one the roadmap already plans to rewrite anyway (F5, gum retirement). Do it last.

---

## 8. Cross-references

- `docs/adr/0004-agent-sandboxing-workflow.md` — two-lane decision, open egress
- `docs/adr/0005-agentbox-dispatch-branches-iteration.md` — user-owned branches, continue-by-default, derived-state rule for the ledger, container hardening baseline
- `docs/adr/0006-agentbox-extraction-python-rewrite.md` — the rewrite this map reverses; also the source of the setup-hook / prompt-override / config-precedence design
- hae's sandboxing guide (not carried) — the security rationale in prose (sandbox image, secrets, git permissions incl. the documented `rev-parse` carve-out, egress, gc)
- `.agentbox/ROADMAP.md` — F1–F7 sequence, adopter inputs, parked items
