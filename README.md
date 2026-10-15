# speepobox

An AFK coding-agent dispatcher ([ADR 0007](docs/adr/0007-agentbox-effect-typescript-port.md)): it
takes a task, runs an agent against a repository inside a sandbox, reviews the result, and
lands it as a branch and a PR. The vocabulary — the roles, the roots, and the read-versus-write
split — is in [CONTEXT.md](CONTEXT.md).

## Using speepobox in your repo

You are an **adopter**: your repo is served by a speepobox **release** it pins, and every command
goes through the **shim** committed in your repo. Every command below is typed as printed, from
your repo's root.

### 1. Prerequisites

On the host you dispatch from:

- node 26 or later
- docker
- `gh auth login` — a dispatch opens its PR through `gh`, and the preflight refuses without it. The
  repository is public, so fetching a release needs no membership; the shim tries gh's login first
  for that one call and then git's own credentials, and writes nothing to your git config.

The task container needs no node.

### 2. The bootstrap

Find the latest release. This prints the highest `v<N>` tag, and nothing before the first release
exists:

```sh
latest=$(gh api --paginate repos/HireAnEsquire/speepobox/tags --jq '.[] | "\(.commit.sha) \(.name)"' | sed -n 's|^[0-9a-f]* v\([1-9][0-9]*\)$|\1|p' | sort -n | tail -n 1)
echo "${latest:+v$latest}"
```

Clone that release, install it, and run `init` against your repo:

```sh
clone=$(mktemp -d)/speepobox
gh repo clone HireAnEsquire/speepobox "$clone" -- --depth 1 --branch "v$latest"
(cd "$clone" && npm ci)
node "$clone/src/bin.ts" init --repo-root "$PWD"
```

`init` writes `.speepobox/`, pins `tool-sha` in `.speepobox/config.toml` to the clone's revision, and
prints the next steps: your stack's base image, `.speepobox/speepobox image build`, the agent
credential in `.speepobox/.env`, and `.speepobox/speepobox doctor`. Commit `.speepobox/`, the shim
`.speepobox/speepobox` included.

Whatever base image you choose needs `git` and `timeout` on its path; the template's
`debian:bookworm-slim` already has both.

The hand clone has done its job. Delete it:

```sh
rm -rf "$clone"
```

#### Setup that needs root

The container runs as your image's user under `--cap-drop ALL`, with no sudo. If your setup needs
root — starting a database, say — speepobox builds nothing for it, because the image is yours. One
pattern is written down here, and it is the one a served repo has run; others are allowed.

- **The root work is a script baked into the image.** It lives in `.speepobox/image/`, is listed in
  `.speepobox/image/inputs` so that changing it makes the image stale for `doctor`, and is `COPY`'d
  to a fixed absolute path.
- **sudo is scoped to exactly that command line.** The sudoers entry is
  `agent ALL=(ALL) NOPASSWD: /usr/bin/bash <path>`, and the setup hook runs exactly that. sudo
  matches the command line verbatim.
- **The setup hook runs as the image's user.** It makes the one `sudo` call and does everything
  else unprivileged: a dependency install run as root leaves root-owned files in the clone.
- **`cap-add` carries what sudo and the script need, and nothing more.** sudo needs `SETUID` and
  `SETGID`; anything beyond that is the script's to earn.

A worked example, starting postgres for the test suite. The root script,
`.speepobox/image/root-setup.sh`:

```bash
#!/usr/bin/env bash
# Starts the test database. Run as root by the setup hook, through the
# image's one sudoers entry. Idempotent.
set -euo pipefail

service postgresql start
for _ in $(seq 1 30); do pg_isready -q && break; sleep 1; done
pg_isready

sudo -u postgres psql -v ON_ERROR_STOP=1 <<'SQL'
ALTER USER postgres PASSWORD 'postgres';
SELECT 'CREATE DATABASE app'
  WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'app')\gexec
SQL
```

listed in `.speepobox/image/inputs`:

```
.speepobox/image/root-setup.sh
```

In `.speepobox/image/Dockerfile`, while the image is still root: `postgresql` joins the
`apt-get install` list, and the commented-out block the template ships is uncommented as it stands:

```dockerfile
RUN apt-get update && apt-get install -y --no-install-recommends sudo \
    && rm -rf /var/lib/apt/lists/*
COPY root-setup.sh /usr/local/libexec/speepobox/root-setup.sh
RUN echo "agent ALL=(ALL) NOPASSWD: /usr/bin/bash /usr/local/libexec/speepobox/root-setup.sh" \
      > /etc/sudoers.d/agent \
    && chmod 0440 /etc/sudoers.d/agent
```

The setup hook, `.speepobox/setup-hook.sh`, runs in the clone as `agent`:

```bash
#!/usr/bin/env bash
set -euo pipefail

sudo /usr/bin/bash /usr/local/libexec/speepobox/root-setup.sh
npm ci
```

And `.speepobox/config.toml` names the hook and the capabilities, as one comma-separated value:

```toml
setup-hook = ".speepobox/setup-hook.sh"
cap-add = "CHOWN, DAC_OVERRIDE, FOWNER, SETUID, SETGID, KILL"
```

`SETUID` and `SETGID` are sudo's; postgres earned the other four. That list is known to be enough,
not known to be minimal. Give both scripts the executable bit (`chmod +x`) — speepobox runs them
through `bash`, but a pre-commit hook may refuse a shebang script without it. Then rebuild with
`.speepobox/speepobox image build`.

### 3. The shim

From now on every command is `.speepobox/speepobox …`:

```sh
.speepobox/speepobox doctor
.speepobox/speepobox status
```

Nothing goes on your `PATH`. The shim is committed with the rest of `.speepobox/`, so everyone who
clones your repo runs the release it pins. The first run on a host fetches that release and installs
it into the package cache, which is slow; later runs start straight away.

### 4. Dispatching

A dispatch hands one task to an agent. speepobox clones your branch into a private copy, starts a
container for the agent to work in, runs the implement pass and then the review rounds, pushes the
result to the branch, and opens a draft PR against the base.

#### Before a dispatch: the branch

The branch is yours to make, and speepobox never creates one. Make it from the base you mean to
target:

```sh
git fetch origin
git branch --no-track my-change origin/main
```

The branch is the task's identity: it names the run's container, its copy, its lock, and its rows
in the ledger. A dispatch refuses a `--branch` that:

- does not exist locally;
- is `main` or `master` — those are PR targets, never pushed to;
- is the base itself;
- is checked out, here or in any other worktree of this repo — switch away from it first;
- is behind or has diverged from `origin/<branch>`. The refusal names the counts and the way out.
  Behind, `git branch -f <branch> origin/<branch>` takes origin's commits and loses nothing.
  Diverged, merge or rebase by hand — `git branch -f` would throw your own commits away. Either
  way, `--hard-reset` discards both sides.

Only one run per branch at a time: a second dispatch of a branch whose run is still alive is
refused. Different branches run side by side.

#### The forms

A spec file. A bare name resolves under the tasks dir (`tasks-dir`, `.speepobox/tasks` in the
scaffold). Anything with a slash is a path used as-is. `.md` is added if it is missing either way,
so this runs `.speepobox/tasks/add-login.md`:

```sh
.speepobox/speepobox add-login --branch my-change
```

The spec is read from your working tree, so it can be uncommitted. It is mounted read-only into the
container at `/spec.md`.

The task stated inline, with no spec file. The text is recorded on the ledger row, so a later
`--resume` can replay it:

```sh
.speepobox/speepobox --task "Rename the config loader's error type to ConfigError" --branch my-change
```

A feature run works through `<folder>/issues/*.md` in dependency order, in one container, on one
branch. The folder resolves like a spec name, and `--issues` is required. It takes a comma list of
issue ids, or `all`, which selects every `ready-for-agent` AFK issue whose blockers are done or
also selected:

```sh
.speepobox/speepobox --feature checkout-flow --issues all --branch checkout-flow
.speepobox/speepobox --feature checkout-flow --issues 3,4 --branch checkout-flow
```

The issues are read from the branch tip, not from your working tree, so the folder must be committed
on the branch. Each issue gets an implement pass and its review rounds. An issue that is not
approved stops the sequence, and the run still lands what the issues before it approved. Each
approved issue is marked `Status: Done` in a commit on the branch.

`--resume <branch>` re-dispatches a branch from its newest ledger record: its spec, inline task, or
feature selection, and its base. A resumed feature run replays only the issues that were not
approved. Feedback is not recovered — add new feedback with `--feedback`:

```sh
.speepobox/speepobox --resume my-change --feedback "Keep the old function as a deprecated alias"
```

Or write it in your editor with `--feedback-edit`. speepobox opens the editor git would open for a
commit. That needs a terminal, and saving an empty file aborts the dispatch:

```sh
.speepobox/speepobox --resume my-change --feedback-edit
```

`--feedback` and `--feedback-edit` also work on a fresh spec or feature dispatch. The text is added
to the implement, review, and PR-description prompts. If a resumed run's spec has since been
deleted, or a resumed feature run has no unapproved issues left, the feedback becomes the task.

`--last` is `--resume` on the branch that was recorded most recently:

```sh
.speepobox/speepobox --last --feedback "Address the review comments about error handling"
```

With no arguments on a terminal, speepobox opens the **picker**. It asks for the source (a feature
folder, a spec, an inline task, or a recorded run to resume), then the branch, the issues if it is a
feature, and the base. Then it shows the equivalent command line and asks before it dispatches:

```sh
.speepobox/speepobox
```

A command line missing an answer — no source, no `--branch`, or `--feature` without `--issues` —
opens the same picker on a terminal, with the flags you typed already filled in. A command line that
is wrong rather than incomplete is refused, never asked about.

#### The other flags

- `--base <ref>` is the PR target and the diff boundary the review reads against. Leave it out and
  the branch's last recorded base in the ledger is used, then the `base` key in
  `.speepobox/config.toml`. A resume takes the base off its record.
- `--dry-run` rehearses the dispatch. Every guard runs for real, including the `git fetch origin`,
  and the plan is printed. Nothing is claimed, started, pushed, logged, or recorded. Use it to check
  what a command line would do.
- `--hard-reset` is **destructive**. It resets the branch to the base and does the work again from
  there, then pushes with `--force-with-lease`. The commits it discards can be recovered only from
  the reflog, and the run's ledger row records the tip it threw away. On a terminal it asks first
  and names how many commits will go. It is refused beside `--resume` or `--last`.
- `--allow-stale-dispatcher` only matters when speepobox dispatches into its own repo. There, a
  dispatcher whose source is missing a commit the base already has is refused, and this flag runs it
  anyway and records that on the row. In your repo there is nothing for it to override.
- `--no-input` never prompts. A command line missing an answer is refused instead of opening the
  picker, and `--hard-reset` does not ask. Use it in scripts.

#### What a run does

1. **The guards.** Every check above, then `git fetch origin` and the base resolved to a commit.
   Then the preflight: the docker daemon is up, the image exists, `gh` is logged in. A refusal holds
   nothing and records nothing. Then the dispatch clears what dead runs left behind (see below).
2. **The plan.** A block naming the mode, the branch, the base, the diff boundary, the container,
   the checkout path, and the `log path`.
3. **The lock**, `.speepobox/locks/<slug>.pid`, held until the run ends.
4. **The checkout.** A clone of the branch tip into `.speepobox/checkouts/<slug>`. The agent never
   works in your own working tree.
5. **The container**, `speepobox-<slug>`, started from your image with every capability dropped
   except those listed in `cap-add`, and with the `memory` and `pids-limit` limits.
6. **The setup hook**, if `setup-hook` names one, run in the clone within `setup-timeout`.
7. **The implement pass.** The agent works the task and commits, within `pass-timeout`.
8. **The review rounds.** Up to `max-review-rounds` reviewer passes, each of which may fix what it
   finds, stopping at the first one that approves. Hitting the cap is not a failure: the run lands
   anyway, and the row records the verdict.
9. **The land.** The commits are fetched back onto your local branch and pushed to `origin`. A run
   that made no commits pushes nothing and opens no PR.
10. **The PR.** A description pass writes the body. If the branch has an open PR it is updated, and
    if not, a draft PR is opened against the base.
11. **The notification.** A desktop notification through `osascript` on macOS, with the outcome
    and the PR. Where it cannot be sent, the run warns and carries on.

The run log is `.speepobox/logs/<slug>-<id>.log`, one file per run. Logs are never deleted. The plan
block prints the run's log path when the run starts, so `tail -f` that path to watch the agent
work. The log has every prompt verbatim and everything the agent printed.

While a run is going, leave its branch checked out nowhere: the run fetches its commits into that
branch at the end, git refuses to fetch into a checked-out branch, and the commits go to a rescue
branch instead. Leave `.speepobox/prompts/` and the spec file alone too, since each pass reads its
prompt when it starts and the spec is mounted from your working tree.

Ctrl-C, or closing the terminal, tears the run down: the container goes, the commits are moved back
as at the end of a run, and the row records the run as interrupted.

#### Watching and cleaning up

```sh
.speepobox/speepobox status
```

`status` shows running containers and the recent runs. Its **OWNER** column says who owns each
container:

- `pid <N>` — a live dispatch.
- `dead — next dispatch reclaims` — the dispatcher died, and the next dispatch will clean it up.
- `no lock — reported only` — nothing here names an owner, so speepobox never touches it.

The recent runs show each run's outcome, cost, PR, and any rescue branch.

```sh
.speepobox/speepobox logs <branch>
.speepobox/speepobox logs <branch> --follow
```

`logs` prints the path of a branch's newest run log, then its contents. With `--follow` it keeps
printing what the run appends, the way `tail -f` does, and exits when the run ends. A background
dispatch is watched with `.speepobox/speepobox logs <branch> --follow`. A `--dry-run` writes no
log, so a branch that was only rehearsed has none.

```sh
.speepobox/speepobox stop <branch>
```

`stop` ends a branch's live run, such as one running in the background with no terminal to press
Ctrl-C in. It sends the run SIGINT and waits for it to tear down. The commits are kept, as on
Ctrl-C, and the row records the run as interrupted.

```sh
.speepobox/speepobox doctor
```

`doctor` checks the host and changes nothing: docker, the image and whether it is stale, the
credential, node, git and `origin`, `gh`, the config, the tasks dir, the runtime root, and the
upstream release. It exits 1 on any FAIL.

```sh
.speepobox/speepobox gc
.speepobox/speepobox gc --force
```

`gc` lists what dead runs left on the host and touches nothing. `gc --force` removes the dead ones.
A checkout's commits are moved back before it is removed, and a checkout whose commits nothing else
would take is skipped loudly. A live run is listed as `skip` and never touched, and logs are never
deleted.

#### When a run goes wrong

- **A kept checkout.** At the end of a run, the commits are moved back onto your branch and the
  copy is removed. When the branch will not take them, they go onto a rescue branch. When neither
  works, the copy in `.speepobox/checkouts/<slug>` is kept and the run prints the commands to recover
  from it. The next dispatch of the same branch tries the move again first and clears the copy if it
  works. A dispatch of another branch reports the copy and leaves it alone.
- **A rescue branch.** When your branch moved while the run worked and the run's commits do not
  fast-forward onto it, they go onto `<branch>-from-run-<sha>` instead, named from the run's tip
  commit. Nothing is lost. Merge it or cherry-pick from it, then delete it. `status`'s RESCUE column
  names it.
- **A dead dispatcher.** If the dispatching process was killed (`kill -9`, a crash, a power loss),
  its lock and container stay behind. The next dispatch of any branch reclaims them. It removes the
  checkout only after confirming the commits in it are on a branch, and otherwise keeps it and says
  so.
- **The ledger.** `.speepobox/runs.jsonl` gets one JSON line per run that took the lock, written
  when the run ends. The line records the branch, what was dispatched, the base and the diff
  boundary, why the run stopped, the review verdict, the PR, the token counts, and any rescue
  branch. `status` is the readable view; the run log has the detail.

#### Configuration

These are the `.speepobox/config.toml` keys a dispatcher is most likely to change. Put a change just
for you in `.speepobox/config.local.toml`, which is gitignored and overrides the committed file.

- `pass-timeout` — seconds one agent pass may run before it is killed. Default `1800`.
- `max-review-rounds` — how many review rounds a run gets. Default `3`.
- `setup-timeout` — seconds the setup hook may run. Default `600`.
- `notify` — `off`, `end` (one notification when the run ends), or `steps` (also along the way,
  such as when the implement pass finishes and at each review verdict). Default `end`.
- `setup-hook` — a script, relative to the repo root, run in the clone before the agent. Default:
  none.
- `cap-add` — capabilities added back after `--cap-drop ALL`, as one comma-separated value.
  Default: none.
- `memory` — the container's memory limit. Default `8g`.
- `pids-limit` — the container's process limit. Default `2048`.

The comments in `.speepobox/config.toml` cover the rest, and they come from the package's
`templates/config.toml`.

### 5. Upgrading

`doctor`'s `upstream` row names the release you are pinned to and the latest one upstream — that is
where a new release shows up. To move to the newest:

```sh
.speepobox/speepobox upgrade
```

To move to a named release, or roll back to an earlier one:

```sh
.speepobox/speepobox upgrade --to v1
```

`upgrade` rewrites the `tool-sha` line, then refreshes the scaffold: it runs
`.speepobox/speepobox init --refresh`, so the new release — the one that ships the templates — applies
them, and prints what that refresh wrote, kept, refreshed, and removed. It commits nothing. When a
file it kept needs your hand, or the image's inputs changed and the image wants a rebuild, it says
so. If the refresh fails, the pin stays moved and `upgrade` exits 1 with the command to retry; running
`upgrade` again is that retry. On a pin that is already current it still refreshes, which costs no
fetch.

A rollback (`--to` an earlier release) moves the pin and refreshes nothing: scaffold files are not
rolled back. `init --diff` shows how they compare with the older release's templates:

```sh
.speepobox/speepobox init --diff
```

The upgrade from v4 to v5 needs one `init --refresh` by hand afterwards, because v4's `upgrade` does
not refresh; every upgrade from v5 on does it for you.

For each file `--diff` reports behind, it shows the diff and the command that refreshes it. A file
you never edited — its text still matches its own stamp — is *pristine*, and one command takes every
pristine behind file at once, the shim included:

```sh
.speepobox/speepobox init --refresh
```

`--refresh` writes any absent file as `init` does, overwrites each behind and pristine file with the
current template, and reports it `refreshed` with both versions. Each overwrite is a rename over the
old file, so a failed one leaves the old text whole. It never overwrites a file you edited, an
unstamped file, or `config.toml`; those are reported `kept`, and an edited behind one says so.

A file you edited is yours to merge: take what you want from the diff by hand, or take the template
and lose your edits. For an ordinary file that is:

```sh
rm .speepobox/<file> && .speepobox/speepobox init
```

An edited shim is not refreshed by deleting it — that would delete the command that runs `init` —
so it is moved aside and run from there:

```sh
mv .speepobox/speepobox .speepobox/speepobox.old && .speepobox/speepobox.old init && rm .speepobox/speepobox.old
```

If that `init` fails partway, put the old shim back with
`mv .speepobox/speepobox.old .speepobox/speepobox`; failing both, run `init` from a hand clone as in the
bootstrap.

So the usual upgrade is `upgrade`, then a hand merge of any file it names, then a commit: review the
diff, then commit `.speepobox/`.

### 6. When the pin cannot be fetched

The shim fetches the release by its full SHA, so it refuses a `tool-sha` that is empty (`!! [empty]`)
or anything but 40 hex characters (`!! [short]`). Either way there are two remedies:

- List the releases and copy one onto the pin by hand: run
  `gh api --paginate repos/HireAnEsquire/speepobox/tags --jq '.[] | "\(.commit.sha) \(.name)"'`,
  take the SHA on the `vN` line of the release you want, and write it into
  `.speepobox/config.toml` as `tool-sha = "<that SHA>"`.
- Or let `upgrade` write it, from a hand clone of the release you want, made as in the
  bootstrap — every command there but `init`:

  ```sh
  node "$clone/src/bin.ts" upgrade --to "v$latest" --repo-root "$PWD"
  ```

### 7. The package cache

The shim keeps each pinned release in `${XDG_CACHE_HOME:-$HOME/.cache}/speepobox/<sha>/`. The cache
is shared by every served repo on the host and is never pruned; `gc` does not touch it. Removing it
is always safe — the next run rebuilds what it needs:

```sh
rm -rf "${XDG_CACHE_HOME:-$HOME/.cache}/speepobox"
```

or one release's entry, `rm -rf "${XDG_CACHE_HOME:-$HOME/.cache}/speepobox/<sha>"`.

## This repo

speepobox is the TypeScript port of the bash dispatcher it was incubated inside, and since ticket 18
it sits at the root of this repo rather than in a directory of its own. The decisions behind it are
in [docs/wayfinder/effect-agentbox/](docs/wayfinder/effect-agentbox/MAP.md).

`.speepobox/` is everything speepobox keeps in this repo — its config, its credential, its prompt
overrides, and its runtime state (checkouts, locks, logs, and the run ledger). An adopter's repo gets
the same directory, which is what keeps self-hosting from being a special case. The credential is
read from `.speepobox/.env`, as in an adopter's repo.

To dispatch agents into this repo, read [docs/self-hosting.md](docs/self-hosting.md).

## License

MIT — see [LICENSE](LICENSE).
