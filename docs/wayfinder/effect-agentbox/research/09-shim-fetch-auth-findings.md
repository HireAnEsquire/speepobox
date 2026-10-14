# 09 P6 — how the shim authenticates its fetch: findings

Run 2026-10-05. Input to a follow-up on [09](../09-post-move-sequence.md)'s P6 ruling **F4**
(comment of 2026-10-02), and to the README section *Using bessemer in your repo*.

Method: primary sources (git, gh, actions/checkout, pacote, @npmcli/git, pip, and the Go modules
reference read **as source at a pinned tag or commit** through `gh api`; GitHub REST and gh docs
read on docs.github.com and cli.github.com), plus **read-only experiments** against
`HireAnEsquire/bessemer` in throwaway directories under this session's scratchpad. No global or
repo git config was changed, no token was printed, and every git experiment ran in a scratch clone.

Versions on the experiment host:

| Tool  | Version                          |
| ----- | -------------------------------- |
| git   | 2.51.0 (`/opt/homebrew/bin/git`) |
| gh    | 2.101.0 (2026-09-15)             |
| macOS | Darwin 25.6.0                    |

The host is **exactly the failing case**. `gh auth status` reports `Logged in to github.com …
(keyring)` and `Git operations protocol: ssh`. The only git credential helper configured is
Homebrew's system-level `osxkeychain` (`/opt/homebrew/etc/gitconfig`), which holds nothing for
github.com. No `gh auth setup-git` has ever run here. (The interactive shell aliases `git` to
`hub`, so every experiment calls `/opt/homebrew/bin/git` by path.)

## The question, and what the brief says

The shim's cold path (`templates/bessemer:165-178`) runs `git init`, `remote add origin
https://github.com/HireAnEsquire/bessemer.git`, then `GIT_TERMINAL_PROMPT=0 git fetch --depth 1
origin <sha>`. That reaches a private repo only through the host's git credential chain. A host
whose git uses SSH fails until the adopter runs `gh auth setup-git`, which rewrites their global
git config.

**The brief matches the ruling.** F4 (`09-post-move-sequence.md:739-744`) says what the brief says:
the URL is hard-coded, the shim "reads no token", it uses "the operator's git credential chain with
`GIT_TERMINAL_PROMPT=0`", and a failure names `gh auth setup-git`. F21 puts `gh auth setup-git` in
the README's prerequisites, and the README does that (`README.md:20-22`).

**One correction, and it widens the problem.** The brief calls an authenticated `gh` "a hard
prerequisite". It is a prerequisite of the *dispatch*: probe 6 is "gh: CLI present and
authenticated — needed for PR creation" (`src/doctor/probes.ts:347`), and the dispatch preflight
reuses it. `doctor`, `status`, `init --diff`, and `upgrade` do not require gh. That matters for the
recommendation: the shim's cold path runs *before* `doctor`, so a shim that cannot start without gh
would stop the one command that reports gh is missing.

**And the shim is not the only fetch with this problem.** `upgrade` and `doctor`'s upstream row run
`git -C <packageRepoRoot> ls-remote --tags origin` (`src/git/releases.ts:125`), and `origin` there
is the same HTTPS release URL. The README's bootstrap (`git ls-remote`, `git clone`,
`README.md:31-43`) and both pin refusals' remedy (`git ls-remote --tags <url>`, `src/pin/pin.ts:105-108`,
`templates/bessemer:91`) use it too. On this host every one of them fails the same way.

Reproduced on this host:

```
$ GIT_TERMINAL_PROMPT=0 git ls-remote --tags https://github.com/HireAnEsquire/bessemer.git
fatal: could not read Username for 'https://github.com': terminal prompts disabled

$ git init -q fetch1 && git -C fetch1 remote add origin https://github.com/HireAnEsquire/bessemer.git
$ GIT_TERMINAL_PROMPT=0 git -C fetch1 fetch -q --depth 1 origin 8de7f0b93e7694326219879401f5c16029b923b5
fatal: could not read Username for 'https://github.com': terminal prompts disabled
plain exit=128
```

**Why such hosts exist** is in gh's own login flow. `gh auth login` offers to configure git as a
credential consumer **only when the chosen protocol is HTTPS**:
`if opts.Interactive && gitProtocol == "https" { … opts.CredentialFlow.Prompt(hostname) … }`
([`login_flow.go:80-85`](https://github.com/cli/cli/blob/0cf1092493af067646fc5f3db9421c6a6ec9c938/pkg/cmd/auth/shared/login_flow.go#L80-L85)).
An adopter who picked SSH at login has an authenticated gh and no HTTPS helper, by design.

## Q1 — what established tools do

### gh itself (`gh repo clone`, `gh repo sync`, fetch/pull/push): a per-command helper

gh never relies on the host's helper chain. Every networked git call goes through
`AuthenticatedCommand`, which **prepends two `-c` pairs to that one command**
([`git/client.go:143-163`](https://github.com/cli/cli/blob/0cf1092493af067646fc5f3db9421c6a6ec9c938/git/client.go#L143-L163)):

```go
credHelper := fmt.Sprintf("!%q auth git-credential", c.GhPath)
…
} else if credentialPattern == AllMatchingCredentialsPattern {
    preArgs = []string{"-c", "credential.helper="}
    preArgs = append(preArgs, "-c", fmt.Sprintf("credential.helper=%s", credHelper))
} else {
    preArgs = []string{"-c", fmt.Sprintf("credential.%s.helper=", credentialPattern.pattern)}
    preArgs = append(preArgs, "-c", fmt.Sprintf("credential.%s.helper=%s", credentialPattern.pattern, credHelper))
}
```

- `Clone` uses the **host-scoped** pattern, from the clone URL
  ([`client.go:923-955`](https://github.com/cli/cli/blob/0cf1092493af067646fc5f3db9421c6a6ec9c938/git/client.go#L923-L955)).
  For github.com that is `credential.https://github.com.helper`
  (`CredentialPatternFromHost`, [`client.go:132-140`](https://github.com/cli/cli/blob/0cf1092493af067646fc5f3db9421c6a6ec9c938/git/client.go#L132-L140)).
- `Fetch`, `Pull`, and `Push` use `AllMatchingCredentialsPattern`
  ([`client.go:881-920`](https://github.com/cli/cli/blob/0cf1092493af067646fc5f3db9421c6a6ec9c938/git/client.go#L881-L920)),
  which gh's own comment calls "less secure … we should endeavour to remove it"
  ([`client.go:117-119`](https://github.com/cli/cli/blob/0cf1092493af067646fc5f3db9421c6a6ec9c938/git/client.go#L117-L119)).
- Which URL `gh repo clone` uses is the user's `git_protocol`
  ([`repo/clone/clone.go:163`, `:178`, `:245-247`](https://github.com/cli/cli/blob/0cf1092493af067646fc5f3db9421c6a6ec9c938/pkg/cmd/repo/clone/clone.go#L245-L247)).
  On an SSH host it clones over SSH with the user's key, and the helper it attached goes unused.
  gh's comment: "even if this is an SSH clone URL, we are setting the pattern anyway"
  ([`client.go:924-925`](https://github.com/cli/cli/blob/0cf1092493af067646fc5f3db9421c6a6ec9c938/git/client.go#L924-L925)).

`gh auth setup-git` writes **the same pair** to `--global`. First it writes an empty value, which
the source comments as "indicate to git we want to sever the chain of credential helpers". Then it
adds `!<gh> auth git-credential`
([`gitcredentials/helper_config.go:22-64`](https://github.com/cli/cli/blob/0cf1092493af067646fc5f3db9421c6a6ec9c938/pkg/cmd/auth/shared/gitcredentials/helper_config.go#L22-L64)).
So the per-command form is setup-git's configuration without the persistence.

### gh extensions: script extensions clone, precompiled ones download through the API

`Manager.Install` asks whether the repo is a binary extension (it checks for release assets), and
then branches ([`extension/manager.go:255-280`](https://github.com/cli/cli/blob/0cf1092493af067646fc5f3db9421c6a6ec9c938/pkg/cmd/extension/manager.go#L255-L280)):

- **Script extensions** go through `installGit`. It builds the clone URL from the user's
  `git_protocol` and calls the same `gitClient.Clone`, so they get the same per-command helper
  ([`manager.go:413-433`](https://github.com/cli/cli/blob/0cf1092493af067646fc5f3db9421c6a6ec9c938/pkg/cmd/extension/manager.go#L413-L433),
  [`extension/git.go:28-30`](https://github.com/cli/cli/blob/0cf1092493af067646fc5f3db9421c6a6ec9c938/pkg/cmd/extension/git.go#L28-L30)).
  A `--pin` is resolved to a SHA through the API first (`fetchCommitSHA`), then checked out.
- **Precompiled extensions** go through `installBin`. It downloads the release asset with gh's
  **authenticated HTTP client**, using `Accept: application/octet-stream`, and runs no git at all
  ([`manager.go:283-355`](https://github.com/cli/cli/blob/0cf1092493af067646fc5f3db9421c6a6ec9c938/pkg/cmd/extension/manager.go#L283-L355),
  [`extension/http.go:82-88`](https://github.com/cli/cli/blob/0cf1092493af067646fc5f3db9421c6a6ec9c938/pkg/cmd/extension/http.go#L82-L88)).

### actions/checkout: an `extraheader`, and a REST tarball when there is no git

At [v7.0.1, `3d3c42e`](https://github.com/actions/checkout/tree/3d3c42e5aac5ba805825da76410c181273ba90b1):

- The git path writes `http.<origin>/.extraheader = AUTHORIZATION: basic <base64 x-access-token:TOKEN>`
  into the checkout's **local** `.git/config`
  ([`src/git-auth-helper.ts:55-64`](https://github.com/actions/checkout/blob/3d3c42e5aac5ba805825da76410c181273ba90b1/src/git-auth-helper.ts#L55-L64)).
  This is the token-holding approach F4 rules out: the shim reads no token.
- With no usable git (`if (!git)`), it logs "The repository will be downloaded using the GitHub REST
  API" ([`src/git-source-provider.ts:77-101`](https://github.com/actions/checkout/blob/3d3c42e5aac5ba805825da76410c181273ba90b1/src/git-source-provider.ts#L77-L101)).
  It calls `downloadTarballArchive({ ref: commit || ref })`
  ([`src/github-api-helper.ts:177-196`](https://github.com/actions/checkout/blob/3d3c42e5aac5ba805825da76410c181273ba90b1/src/github-api-helper.ts#L177-L196)),
  asserts "Expected exactly one directory inside archive", and moves that directory's contents up
  ([`github-api-helper.ts:59-87`](https://github.com/actions/checkout/blob/3d3c42e5aac5ba805825da76410c181273ba90b1/src/github-api-helper.ts#L59-L87)).
  On that path it refuses `submodules` and `ssh-key`. **The result has no `.git`**, which is the
  cost option (c) below inherits.

### Go modules (`GOPRIVATE`): delegates to git's own credentials, prompts off

From the Go modules reference
([`golang/website@32881aa`, `_content/ref/mod.md:3742-3779`](https://github.com/golang/website/blob/32881aa55f0d81413cda4fe43e0236d0cae2b2ec/_content/ref/mod.md#L3742-L3779)):
`GOPRIVATE` makes `go` skip the proxy and checksum DB and "clone the Git repository … directly".
"Developers will need read access … This may be configured in global VCS configuration files like
`.gitconfig`." And: "By default, when invoking Git, the `go` command disables interactive prompts
by setting `GIT_TERMINAL_PROMPT=0`". The same thing F4 does.

For private repositories ([`mod.md:3827-3866`](https://github.com/golang/website/blob/32881aa55f0d81413cda4fe43e0236d0cae2b2ec/_content/ref/mod.md#L3827-L3866)):
"These tools perform their own authentication". "For GitHub repositories specifically, the `go`
command assumes `https://`". The documented remedies are `.netrc` or a **global** `insteadOf`
rewrite, `[url "git@github.com:"] insteadOf = https://github.com/`. That is F4's posture, and the
fix it gives SSH users is the global-config change F4 asks for, only spelled differently.

### npm git dependencies (pacote, @npmcli/git): try HTTPS, then fall back to SSH

pacote [v22.0.0](https://github.com/npm/pacote/blob/e4e44c5428c840d853b5ef8641e169b5b79328ab/lib/git.js):

- For a hosted repo at a SHA it first tries the **codeload tarball**, and falls back to cloning if
  that fails ([`lib/git.js:241-275`](https://github.com/npm/pacote/blob/e4e44c5428c840d853b5ef8641e169b5b79328ab/lib/git.js#L241-L275)).
- Clones go "first try https … Fall back to SSH to support private repos"
  ([`lib/git.js:90-106`, `:290-308`](https://github.com/npm/pacote/blob/e4e44c5428c840d853b5ef8641e169b5b79328ab/lib/git.js#L290-L308)).

@npmcli/git [v8.0.0](https://github.com/npm/git/blob/5c8dc2a51721a659f6641142ce86d4c83bce60a0/lib/opts.js#L38-L54)
sets `GIT_ASKPASS=echo` and `GIT_SSH_COMMAND=ssh -oStrictHostKeyChecking=accept-new` unless the
user already set them, and otherwise inherits `process.env`. So npm uses the host's own credentials
over *both* transports, in turn. It never consults gh.

### pip VCS requirements: shells out to git, host credentials

pip 26.2.1 supports `git+https` and `git+ssh`, and recommends a full hash "because a full hash
allows pip to operate more efficiently"
([VCS support](https://pip.pypa.io/en/stable/topics/vcs-support/)). Its docs say nothing about
credentials for VCS URLs; keyring support covers index downloads
([authentication](https://pip.pypa.io/en/stable/topics/authentication/)). The source runs `git`.
Only under `PIP_NO_INPUT` does it add `GIT_TERMINAL_PROMPT=0` and `GIT_SSH_COMMAND=ssh -oBatchMode=yes`
([`src/pip/_internal/vcs/git.py:81-88` @ 26.2.1](https://github.com/pypa/pip/blob/26.2.1/src/pip/_internal/vcs/git.py#L81-L88)).

### A tool built on the host's gh login: mise

mise's token resolution for GitHub ([docs](https://mise.jdx.dev/dev-tools/github-tokens.html)) has
eight steps: env vars, `credential_command`, its own OAuth, `github_tokens.toml`, then **"gh CLI
token (from `hosts.yml`)"**, then an opt-in `git credential fill` run with `GIT_TERMINAL_PROMPT=0`.
The docs carry the caveat that matters here: "mise reads the config file directly — it does not
shell out to `gh`. If your gh CLI uses a credential helper (e.g., macOS Keychain) … the token won't
be available". This host stores its token in the keyring, so mise's shortcut would miss it.
**Asking `gh` itself** (`gh auth git-credential`, or `gh api`) is the only form that sees keyring
tokens. (Docs only, not pinned: the mise site carries no version.)

### Summary

| Tool | Transport | Credential source | Touches user config? |
| --- | --- | --- | --- |
| gh clone / fetch / script ext | git, user's `git_protocol` | per-command `-c` helper → gh | no |
| gh precompiled ext | gh HTTP client (release asset) | gh | no |
| actions/checkout | git, or REST tarball fallback | token in local `extraheader` | local `.git/config` only |
| Go `GOPRIVATE` | git (HTTPS assumed for GitHub) | host's git config / `.netrc` | user does it |
| npm git deps | codeload tarball → git HTTPS → git SSH | host's git, both transports | no |
| pip VCS | git | host's git | no |
| mise | REST | env, files, gh's `hosts.yml` (not keyring), opt-in `git credential fill` | no |
| **bessemer shim today (F4)** | git HTTPS only | host's git chain | **yes, via `gh auth setup-git`** |

## Q2 — is the per-command gh helper a supported use of git and gh?

**git: yes, documented.** Every piece of the form is documented:

- A helper string "begins with `!`" is "a shell snippet"
  ([`gitcredentials.adoc:234-235`](https://github.com/git/git/blob/v2.51.0/Documentation/gitcredentials.adoc#L234-L235)).
- Context-scoped options: "`credential.<URL>.*`, where <URL> matches the context"
  ([`:136-183`](https://github.com/git/git/blob/v2.51.0/Documentation/gitcredentials.adoc#L136-L183)).
- **Ordering**: "each helper will be tried in turn … Once Git has acquired both a username and a
  non-expired password, no more helpers will be tried."
- **The reset**: "If `credential.helper` is configured to the empty string, this resets the helper
  list to empty" ([`:195-203`](https://github.com/git/git/blob/v2.51.0/Documentation/gitcredentials.adoc#L195-L203)).

**The empty-helper reset is load-bearing, and the source says how far it reaches.**
`credential_config_callback` appends a non-empty `helper` and `string_list_clear`s the list on an
empty one ([`credential.c:119-123`](https://github.com/git/git/blob/v2.51.0/credential.c#L119-L123)).
The URL-matching collector uses `select_all`, which returns 0
([`credential.c:150-154`, `:170-201`](https://github.com/git/git/blob/v2.51.0/credential.c#L150-L201)).
So plain `credential.helper` and every matching `credential.<url>.helper` feed **one list**, in
config read order: system, global, local, then `-c` last. An empty value of *either* spelling
therefore clears the helpers every config file contributed.

Without the reset, the user's helpers still run first. And on success `credential_approve` sends
`store` to **every** helper in the list
([`credential.c:547-562`](https://github.com/git/git/blob/v2.51.0/credential.c#L547-L562)), so
`osxkeychain` (or `store`) would be handed gh's token to persist. That is a write into the user's
keychain nobody asked for. Measured with `GIT_TRACE`, both reset spellings invoke only gh:

```
--- A: -c credential.helper= -c 'credential.https://github.com.helper=!gh auth git-credential'
trace: run_command: 'gh auth git-credential get'
trace: run_command: 'gh auth git-credential store'
46d47e94e1e5fde2d74807369cd4f25caf05e5c3	refs/tags/v1
--- B: gh's own form: -c 'credential.https://github.com.helper=' -c 'credential.https://github.com.helper=!gh auth git-credential'
trace: run_command: 'gh auth git-credential get'
trace: run_command: 'gh auth git-credential store'
46d47e94e1e5fde2d74807369cd4f25caf05e5c3	refs/tags/v1
```

`osxkeychain` (system config) was cleared in both. gh's `store` is a no-op: "We pretend to
implement the "store" operation, but do nothing" ([`gitcredential/helper.go:58-67`](https://github.com/cli/cli/blob/0cf1092493af067646fc5f3db9421c6a6ec9c938/pkg/cmd/auth/gitcredential/helper.go#L58-L67)).
The fetch that failed above succeeds with form B, and writes nothing into the clone's config:

```
$ GIT_TERMINAL_PROMPT=0 git -C fetch1 -c credential.helper= \
    -c 'credential.https://github.com.helper=!gh auth git-credential' \
    fetch -q --depth 1 origin 8de7f0b93e7694326219879401f5c16029b923b5
helper exit=0
$ git -C fetch1 checkout -q --detach 8de7f0b9… && git -C fetch1 rev-parse HEAD
8de7f0b93e7694326219879401f5c16029b923b5
$ git -C fetch1 config --list --local      # no credential.* line
core.repositoryformatversion=0 … remote.origin.url=https://github.com/HireAnEsquire/bessemer.git
remote.origin.fetch=+refs/heads/*:refs/remotes/origin/*
```

**gh: supported in practice, not documented as a public command.** `git-credential` is declared
`Hidden: true` with `Short: "Implements git credential helper protocol"`
([`helper.go:40-45`](https://github.com/cli/cli/blob/0cf1092493af067646fc5f3db9421c6a6ec9c938/pkg/cmd/auth/gitcredential/helper.go#L40-L45)),
and `gh auth --help` does not list it. But it is the string `gh auth setup-git` writes into users'
global configs ([`helper_config.go:51-56`](https://github.com/cli/cli/blob/0cf1092493af067646fc5f3db9421c6a6ec9c938/pkg/cmd/auth/shared/gitcredentials/helper_config.go#L51-L56)),
and gh invokes it itself on every authenticated git call. Removing or renaming it would break every
machine that ran setup-git, which is about as strong as a contract gets without a manual page.
**Not found:** any written stability promise for the hidden command.

Caveats, each checked:

- **gh not on PATH.** The helper is run by git's shell. It fails, and git falls through to the
  disabled prompt:

  ```
  $ env -i HOME="$HOME" PATH="$PWD/nogh:/usr/bin:/bin" GIT_TERMINAL_PROMPT=0 git -c credential.helper= \
      -c 'credential.https://github.com.helper=!gh auth git-credential' ls-remote https://github.com/HireAnEsquire/bessemer.git refs/tags/v1
  gh auth git-credential get: gh: command not found
  fatal: could not read Username for 'https://github.com': terminal prompts disabled
  exit=128
  ```

  So the shim should add the pair only when `command -v gh` succeeds, and should pass the
  **resolved path**, quoted, the way gh passes `%q` of its own path. Otherwise a missing gh plus
  the reset turns a host whose own chain worked into a failure.
- **gh logged out / no token.** `helperRun` returns `cmdutil.SilentError` when it has no user or
  token ([`helper.go:130-132`](https://github.com/cli/cli/blob/0cf1092493af067646fc5f3db9421c6a6ec9c938/pkg/cmd/auth/gitcredential/helper.go#L113-L141)),
  and git again ends at the disabled prompt. The message is indistinguishable from "no helper".
  Non-HTTPS requests are refused the same way ([`helper.go:104-106`](https://github.com/cli/cli/blob/0cf1092493af067646fc5f3db9421c6a6ec9c938/pkg/cmd/auth/gitcredential/helper.go#L104-L106)).
- **`GH_HOST` / GitHub Enterprise.** The helper looks up the token by the **host git asks about**
  (`wants["host"]`, [`helper.go:113-119`](https://github.com/cli/cli/blob/0cf1092493af067646fc5f3db9421c6a6ec9c938/pkg/cmd/auth/gitcredential/helper.go#L113-L119)),
  and never reads `GH_HOST`. Measured: `GH_HOST=example.ghe.com` with the helper → `refs/tags/v1`,
  exit 0. The release URL names github.com, and the pattern scopes the helper to it, so an
  adopter's GHES login neither helps nor interferes. A fork on GHES edits `RELEASE_URL` and the
  pattern host together, so the pattern should be **derived from `RELEASE_URL`**, not written a
  second time.
- **Token precedence.** `GH_TOKEN`/`GITHUB_TOKEN` "takes precedence over previously stored
  credentials" (`gh help environment`;
  [`root/help_topic.go:45-56`](https://github.com/cli/cli/blob/0cf1092493af067646fc5f3db9421c6a6ec9c938/pkg/cmd/root/help_topic.go#L45-L56)).
  When the source ends in `_TOKEN`, the helper answers with user `x-access-token`
  ([`helper.go:121-128`](https://github.com/cli/cli/blob/0cf1092493af067646fc5f3db9421c6a6ec9c938/pkg/cmd/auth/gitcredential/helper.go#L121-L128)).
  The shim runs with the adopter's whole environment, so an exported stale `GH_TOKEN` wins there.
  The package's gh children (forge, probe 6) never see it, because `src/internal/exec.ts` forwards
  only `PATH`, `HOME`, the editor variables, and `TERM`. So the shim's answer and probe 6's can
  disagree on such a host. That is a pre-existing split, not one this change creates.
- **Scopes.** A `gh auth login` token carries at least `repo`, `read:org`, `gist`
  ([gh auth login manual](https://cli.github.com/manual/gh_auth_login)). `repo` covers private
  contents. A fine-grained PAT in `GH_TOKEN` needs **Contents: read** on `HireAnEsquire/bessemer`.
  The tarball and `matching-refs` endpoints are listed under Contents/read, and `/tags` under
  Metadata/read
  ([permissions for fine-grained PATs](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens)).
  **Not verified:** whether HireAnEsquire enforces SAML SSO. If it does, gh's OAuth token must be
  authorized for the org. That requirement is the same for every approach here.
- **Keyring-stored tokens.** gh stores the token "securely in the system credential store" and
  falls back to a plain-text file ([gh auth login manual](https://cli.github.com/manual/gh_auth_login)).
  This host's token is in the keyring, and every measurement above used it non-interactively. One
  oddity was observed and is recorded rather than explained. With `XDG_CONFIG_HOME` pointed at an
  empty directory, `gh auth status` said "You are not logged into any GitHub hosts", yet
  `gh auth git-credential get` still answered `username=x-access-token` with a password (value not
  printed). It apparently found a keyring entry without `hosts.yml`.
  **Not verified:** Linux secret-service keyrings reached through a child whose environment lacks
  `DBUS_SESSION_BUS_ADDRESS`. The package's chokepoint already spawns gh that way for probe 6 and
  the forge, so this is not new exposure.
- **Non-interactive.** `GIT_TERMINAL_PROMPT=0` stays. gh's `get` reads stdin and prints, with no
  prompt anywhere in `helperRun`.
- **The F19 mirror tests are unaffected.** The tests rewrite the release URL with a `GIT_CONFIG_*`
  `insteadOf` to a local path. Credentials are looked up for the *rewritten* URL, so no helper runs,
  even with gh absent from the test's `PATH` (`test/shim.test.ts` puts only node, git, npm, sed
  there):

  ```
  $ env -i HOME=… PATH="$PWD/nogh:/usr/bin:/bin" GIT_TRACE=1 GIT_CONFIG_COUNT=1 \
      GIT_CONFIG_KEY_0="url.$PWD/fetch1.insteadOf" GIT_CONFIG_VALUE_0=https://github.com/HireAnEsquire/bessemer.git \
      git -c credential.helper= -c 'credential.https://github.com.helper=!gh auth git-credential' ls-remote https://github.com/HireAnEsquire/bessemer.git HEAD
  trace: run_command: … 'git-upload-pack '\''…/scratchpad/fetch1'\'''
  8de7f0b93e7694326219879401f5c16029b923b5	HEAD
  ```

## Q3 — fetching through gh with no git transport

All measured against the private repo, with v1 = tag object `46d47e9…` → commit `8de7f0b…`.

**Tarball by ref.** `GET /repos/{owner}/{repo}/tarball/{ref}` "Gets a redirect URL"; the response
is `302 Found`, and "For private repositories, these links are temporary and expire after five
minutes" ([REST: download a repository archive](https://docs.github.com/en/rest/repos/contents?apiVersion=2022-11-28#download-a-repository-archive-tar)).
`gh api` follows the redirect itself. Only the final hop is visible, filtered here to safe headers
(the `Location` of the 302 carries a temporary token and was deliberately not printed):

```
$ gh api -i repos/HireAnEsquire/bessemer/tarball/8de7f0b93e7694326219879401f5c16029b923b5 > tar1.raw
HTTP/2.0 200 OK
Content-Disposition: attachment; filename=HireAnEsquire-bessemer-v1-0-g8de7f0b93e7694326219879401f5c16029b923b5.tar.gz
Content-Type: application/x-gzip
```

| ref given | exit | top-level dir | `git get-tar-commit-id` |
| --- | --- | --- | --- |
| full SHA `8de7f0b9…b5` (40 hex) | 0 | `HireAnEsquire-bessemer-8de7f0b9…b5/` | `8de7f0b9…b5` |
| short `8de7f0b` | 0 | `HireAnEsquire-bessemer-8de7f0b9…b5/` (full SHA) | `8de7f0b9…b5` |
| short `8de7f0b93e76` | 0 | same | same |
| tag `v1` | 0 | `HireAnEsquire-bessemer-46d47e94…5c3/` (**tag object** SHA) | `8de7f0b9…b5` (commit) |
| tag object `46d47e94…5c3` | 0 | `HireAnEsquire-bessemer-46d47e94…5c3/` | `8de7f0b9…b5` |
| `0000…0000` | 1 | — | `gh: HTTP 404`; stdout got `404: Not Found` (14 bytes) |

- **A full SHA is not required** by this endpoint. A short one resolves. That differs from git:
  `git fetch origin 8de7f0b9` fails with `fatal: couldn't find remote ref 8de7f0b9`, because a
  refspec's source can be "a fully spelled hex object name" and nothing shorter
  ([`pull-fetch-param.adoc:28-32`](https://github.com/git/git/blob/v2.51.0/Documentation/pull-fetch-param.adoc#L28-L32)).
  F6's full-SHA grammar still stands for other reasons (no skew, `upgrade` compares full SHAs).
- **No `^{}` peeling is needed to *fetch*.** An annotated tag's ref or tag-object SHA yields the
  commit's tree. But the top-level directory is named after **whatever was asked for**, here the
  tag object. A consumer must strip one component (`tar --strip-components=1`, as checkout's
  single-directory move does) and never derive the SHA from the name.
- **The archive names its commit.** `git get-tar-commit-id` reads it from the pax header, so the
  shim could verify the archive *is* the pin before renaming it into place.
- **Layout and contents.** The archive has exactly one top-level directory, the repo's tree with no
  `.git`. Extracted, it is **identical** to the depth-1 checkout (`diff -rq --exclude=.git` printed
  nothing), and file modes match (`setup-hook.sh` is `-rwxr-xr-x` in both). GitHub says "An archive
  of a commit ID will always have the same file contents"
  ([source code archives](https://docs.github.com/en/repositories/working-with-files/using-files/downloading-source-code-archives)).
  This repo has no `.gitattributes`, so `export-ignore` cannot drop anything today.
- **Errors go to stdout too.** On a 404, `gh api` writes the error body to stdout. A shim piping
  stdout into `tar` must check gh's exit status first.
- **`GH_HOST` *does* matter here, unlike for the helper.** `GH_HOST=ghe.invalid.example gh api
  repos/HireAnEsquire/bessemer/tags` → `Error connecting to ghe.invalid.example`, exit 1. Adding
  `--hostname github.com` fixes it (`v1`, exit 0). `GH_REPO` does not affect an explicit path.
- **Rate limits.** Authenticated REST is "5,000 requests per hour"
  ([rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)),
  and the docs say nothing archive-specific. **Not measurable here**: `X-Ratelimit-Used` stayed `0`
  before and after archive, repo, and `rate_limit` calls on this account. A cold path makes 1-2
  calls per new pin, so the limit is not a practical concern.
- **Size.** The REST docs give no archive size limit; the 1 MB / 100 MB limits are for the contents
  API's single files. The v1 tarball is 1.6 MB.

**Tag listing.** Three endpoints were compared, and they disagree about peeling:

```
$ gh api repos/HireAnEsquire/bessemer/git/matching-refs/tags/v
[{"ref":"refs/tags/v1", … "object":{"sha":"46d47e94e1e5fde2d74807369cd4f25caf05e5c3","type":"tag", …}}]
$ gh api repos/HireAnEsquire/bessemer/tags --jq '.[] | {name, commit: .commit.sha}'
{"commit":"8de7f0b93e7694326219879401f5c16029b923b5","name":"v1"}
$ gh release list -R HireAnEsquire/bessemer
(empty, exit 0)
```

- `matching-refs` returns the **tag object** for an annotated tag. Peeling it costs one more call
  per tag (`git/tags/{sha}` → `object.sha` = the commit), so this is the endpoint where `^{}`
  matters.
- `/tags` returns the **commit already peeled**. It is paginated, so a script needs `--paginate`.
- `gh release list` is the wrong tool. F11's releases are tags, not GitHub Release objects, and
  there are none.

## Q4 — what reads `.git` in the package root when it runs from the cache

`bin/` does not exist (`ls: bin: No such file or directory`), so the sweep covers `src`,
`templates`, `scripts`, and `test`.

```
$ grep -rn "packageRepoRoot\|findRepoRoot(packageRoot)" src templates scripts test | grep -v -E "^[^:]+:[0-9]+:\s*//"
src/bin.ts:122:  const packageRepoRoot = findRepoRoot(packageRoot);
src/bin.ts:123:  const repoRoot = Option.getOrElse(peeled.right.repoRoot, () => packageRepoRoot);
src/bin.ts:137:  const selfHosted = resolve(packageRepoRoot) === resolve(repoRoot);
src/bin.ts:181:      dispatcherRevision: resolveDispatcherRevision(packageRepoRoot),
src/bin.ts:282:        dispatcherRevision: resolveDispatcherRevision(packageRepoRoot),
src/bin.ts:283:        headReleases: Effect.option(readHeadReleases(packageRepoRoot)),
src/bin.ts:311:      return upgrade({ repoRoot, argv: argv.slice(1), selfHosted, packageRepoRoot }).pipe(
src/bin.ts:328:        dispatcherRevision: resolveDispatcherRevision(packageRepoRoot),
src/bin.ts:335:            packageRepoRoot,
src/upgrade/upgrade.ts:39:  readonly packageRepoRoot: string;
src/upgrade/upgrade.ts:110:    const releases = yield* readRemoteReleases(options.packageRepoRoot).pipe(
src/doctor/probes.ts:545:  readonly packageRepoRoot: string;
src/doctor/probes.ts:563:    const releases = yield* Effect.either(readRemoteReleases(host.packageRepoRoot));
src/doctor/doctor.ts:50:  readonly packageRepoRoot: string;
src/git/releases.ts:123:  packageRepoRoot: string,
src/git/releases.ts:125:  execUnder(NO_TERMINAL_PROMPT, "git", "-C", packageRepoRoot, "ls-remote", "--tags", "origin").pipe(
src/git/releases.ts:145:  packageRepoRoot: string,
src/git/releases.ts:149:      exec("git", "-C", packageRepoRoot, ...args).pipe(
test/upgrade.test.ts:49:    return { packageRepoRoot: clone, shas };
test/upgrade.test.ts:79:  readonly packageRepoRoot: string;
test/upgrade.test.ts:87:      packageRepoRoot: options.packageRepoRoot,
test/upgrade.test.ts:354:          packageRepoRoot: join(f.root, "nowhere"),
test/upgrade.test.ts:403:        yield* git("-C", f.packageRepoRoot, "remote", "set-url", "origin", nowhere);
test/upgrade.test.ts:421:          packageRepoRoot: repoRoot,
test/init-stamp.test.ts:225:  const bessemer = join(findRepoRoot(packageRoot), ".bessemer");
test/roots.test.ts:140:const packageRepoRoot = findRepoRoot(packageRoot);
test/roots.test.ts:228:          { ...script, [`git -C ${packageRepoRoot} ls-remote`]: { exit: 0, stdout: "" } },
test/roots.test.ts:245:        packageRepoRoot,
test/doctor.test.ts:45:const REPO_ROOT = findRepoRoot(packageRoot);
test/doctor.test.ts:82:    readonly packageRepoRoot?: string;
test/doctor.test.ts:107:      packageRepoRoot: host.packageRepoRoot ?? REPO_ROOT,
test/doctor.test.ts:532:        const host = { selfHosted: false, packageRepoRoot: "/srv/bessemer" };
test/doctor.test.ts:935:  const packageRepoRoot = `${root}/package`;
test/doctor.test.ts:936:  yield* realGit("clone", "-q", bare, packageRepoRoot);
test/doctor.test.ts:941:  return { root, packageRepoRoot, served, pinTo, v1, v2, untagged };
test/doctor.test.ts:953:    packageRepoRoot: w.packageRepoRoot,
test/doctor.test.ts:1023:        w.packageRepoRoot,
test/config.test.ts:367:        path.join(bessemerDir(findRepoRoot(packageRoot)), "config.toml"),
test/config.test.ts:390:      const repoRoot = findRepoRoot(packageRoot);
test/config.test.ts:633:    expect(findRepoRoot(packageRoot)).toBe(packageRoot);
test/config.test.ts:634:    expect(packagePathspec(findRepoRoot(packageRoot))).toEqual([
test/live/signal-matrix.live.test.ts:146:    const repoRoot = findRepoRoot(packageRoot);

$ grep -rn '"\.git"\|\.git/\|existsSync' src templates scripts | grep -v -E "^[^:]+:[0-9]+:\s*//"
src/reconcile/reconcile.ts:192:      return fs.readFileString(path.join(dir, ".git", "HEAD")).pipe(
src/config/paths.ts:1:import { existsSync } from "node:fs";
src/config/paths.ts:153:    if (existsSync(join(directory, ".git"))) {
src/git/git.ts:752:const repoArgs = (at: string): ReadonlyArray<string> => ["-C", at, `--git-dir=${join(at, ".git")}`];

$ grep -rn 'ls-remote\|"--points-at"\|"rev-parse"' src templates scripts | grep -v -E "^[^:]+:[0-9]+:\s*//"
src/pin/pin.ts:106:  `find a release's full SHA with \`git ls-remote --tags ${RELEASE_URL}\` and copy the SHA ` +
src/dispatch/feature.ts:166:export const BOUNDARY_COMMAND: ReadonlyArray<string> = ["git", "rev-parse", "HEAD"];
src/doctor/probes.ts:324:    const workTree = yield* exec("git", "-C", repoRoot, "rev-parse", "--is-inside-work-tree").pipe(
src/doctor/probes.ts:571:        `${pinned}; nothing compared — git ls-remote origin: ${releases.left.detail}`,
src/git/releases.ts:125:  execUnder(NO_TERMINAL_PROMPT, "git", "-C", packageRepoRoot, "ls-remote", "--tags", "origin").pipe(
src/git/releases.ts:157:    const commit = (yield* run("rev-parse", "HEAD")).trim();
src/git/releases.ts:158:    const tags = yield* run("tag", "--points-at", "HEAD");
templates/bessemer:91:unfetchable="find a release's full SHA with \`git ls-remote --tags $RELEASE_URL\` and copy the SHA on its \`vN^{}\` line onto the tool-sha line, or run \`upgrade --to vN\` from a hand clone of bessemer"
src/git/git.ts:875:        inRepo(repo, "rev-parse", "--verify", rev).pipe(
src/git/dispatcher-revision.ts:59:      "rev-parse",
```

`reconcile.ts:192` reads checkouts under the runtime root, and `git.ts:752` is the `Git` tag's
served-repo helper, so neither is the package. **Every read of the package's own `.git` hangs off
the one `packageRepoRoot`** computed at `src/bin.ts:122`. Five consumers:

1. **`findRepoRoot(packageRoot)`** (`src/config/paths.ts:150-162`) walks up for a `.git` entry,
   and falls back to its start when none is found. It feeds `selfHosted` (`bin.ts:137`) and is the
   fallback `repoRoot`. `bin.ts:131-136` already records the assumption: "the shim's cache clone
   carries its own `.git`, so the walk stops there."
2. **`resolveDispatcherRevision(packageRepoRoot)`** runs `git -C … rev-parse HEAD --short HEAD`
   and `status --porcelain` (`src/git/dispatcher-revision.ts:51-80`). It feeds the ledger row's
   `dispatcher` (dispatch, `bin.ts:181`), doctor's roots row and upstream row's running clause
   (`bin.ts:328`), and **`init`'s `tool-sha`** (`bin.ts:282`; `src/init/init.ts:175-200`). With
   no readable revision, init writes the pin **empty**.
3. **`readHeadReleases`** runs `git tag --points-at HEAD` for init's F16 warning
   (`src/git/releases.ts:143-163`).
4. **`readRemoteReleases`** runs `git ls-remote --tags origin` for `upgrade` and doctor's
   upstream row (`releases.ts:121-140`). It needs a `.git` **and** `origin` set to the release
   URL, which is F17 item 4 ("the cache copy is a git repository with `HEAD` at the pin and
   `origin` set to the release URL").
5. `packagePathspec` (`src/config/paths.ts:77-80`) is pure path arithmetic and reads nothing.

**Two hazards if the cache entry had no `.git` (option c).**

- `findRepoRoot` would keep walking up from `~/.cache/bessemer/<sha>`. On a host whose `$HOME` is
  a git repo (a dotfiles repo), it would answer `$HOME`.
- Independently, `dispatcher-revision.ts` and `releases.ts` call `git -C <dir>` **without**
  `--git-dir`, so git's own discovery walk would do the same. That is the defect AGENTS.md's T32
  rule closed for the `Git` tag, which has not reached these two plain modules.

`init` run through the shim would then pin `$HOME`'s `HEAD`, or write an empty pin.
`upgrade` / `doctor` would read `$HOME`'s `origin`.

**A side finding that holds today, under the git path too.** A by-SHA fetch brings no tags. In the
scratch clone after `fetch --depth 1 origin 8de7f0b…`, `git tag` printed nothing. git
auto-follows "tags that point at branches you are interested in"
([`git-fetch.adoc:25-31`](https://github.com/git/git/blob/v2.51.0/Documentation/git-fetch.adoc#L25-L31)),
and a bare SHA fetch stores no branch. So `readHeadReleases` in a cache entry always answers
"no releases". When `init` runs through the shim and writes `config.toml`, it would warn "not a
bessemer release" even for a pin at `v1`. The README's hand-clone bootstrap is unaffected:
`gh repo clone … -- --depth 1 --branch v1` (and so presumably `git clone --branch v1`) does carry
the tag (`git tag` → `v1`, measured below). **Not verified:** whether any current path runs
`init` through the shim with `config.toml` absent. The F1 refresh keeps the existing config, so
the warning is gated off there.

## Q5 — recommendation

### (a) Keep F4 and document it

The shim, `pin.ts`, and `exec.ts` need **no change**. The README already says `gh auth setup-git`.

Costs:

- every SSH-protocol adopter must run a command that edits `~/.gitconfig` for **all** github.com
  HTTPS traffic, not only bessemer's. setup-git replaces the github.com helper chain with gh
  (`--replace-all … ""`, `helper_config.go:40-49`);
- the refusal and README §2/§5 keep three more `git` commands with the same dependency;
- it is the posture Go documents and that npm and pip inherit. No tool in Q1 that *has* a gh
  login to use asks the user to change global config instead.

### (b) Per-command gh credential helper: **recommended**

This is what gh does for its own clones (Q1), on documented git mechanics (Q2), and it reads no
token. Write the helper in gh's own form (scoped reset, then the helper), with the host derived
from `RELEASE_URL`. Use it **only when `command -v gh` succeeds**. Try it **first**, and **fall
back to the operator's chain** (today's F4 behaviour) when it fails. On a host without gh, or with
gh logged out, the cold path then still reaches `doctor`, which is what reports gh's state.
gh-first also means the success path never sends `store` to the user's own helpers.

**Shim** (`templates/bessemer`):

- `gh=$(command -v gh)` (optional, so no F3 check is added);
- `release_host` derived from `RELEASE_URL` with `sed` or `${…#https://}`;
- the fetch runs once as `git -C "$tmp" -c "credential.https://$release_host.helper=" -c
  "credential.https://$release_host.helper=!\"$gh\" auth git-credential" fetch …` when `$gh` is
  set, then plain on failure;
- the refusal quotes both attempts' lines, and names `gh auth login` and, as the fallback,
  `gh auth setup-git`;
- `unfetchable` replaces `git ls-remote --tags $RELEASE_URL` with a command that works on an SSH
  host, `gh api --paginate repos/HireAnEsquire/bessemer/tags --jq '.[] | "\(.commit.sha) \(.name)"'`,
  which also drops the `vN^{}` instruction, because `/tags` is pre-peeled;
- bump `TEMPLATE_VERSIONS.bessemer`, because F17 says a change bumps the template version.

**Package** (`src/git/releases.ts`): `readRemoteReleases` gets the same pair before `ls-remote`
(bare `gh` on the forwarded `PATH`, the way gh itself defaults when `GhPath` is empty,
`client.go:144-147`), with the same fallback inside the existing 10 s budget.

**`src/pin/pin.ts`**: `unfetchableRemedy` gets the same text as the shim's, and stays one sentence
two implementations agree on. `test/shim.test.ts:301-305` asserts the old `ls-remote` wording, so
it moves with it.

**README**:

- drop `gh auth setup-git` from the prerequisites;
- the bootstrap's release lookup becomes `gh api --paginate repos/HireAnEsquire/bessemer/tags --jq …`;
- the clone becomes `gh repo clone HireAnEsquire/bessemer "$clone" -- --depth 1 --branch "v$latest"`.
  It uses the adopter's own `git_protocol`. Measured on this SSH host: exit 0, origin
  `git@github.com:HireAnEsquire/bessemer.git`, `HEAD` `8de7f0b…`, `git tag` → `v1`;
- §5's manual remedy mirrors the shim's.

**`src/internal/exec.ts` allowlist: no change.** The pair is argv, not environment. The helper is
spawned by git, which inherits the chokepoint's `PATH` and `HOME`, the same two variables probe 6's
`gh auth status` and the forge already get. Do **not** add `GH_TOKEN`, `GH_HOST`, or
`GH_CONFIG_DIR`. That would be a second route to a credential, which the credential rule forbids,
and `GH_HOST` is irrelevant to a helper keyed on git's host (Q2).

**Tests**: F19's mirror rewrite bypasses the helper (Q2, measured), so the cold-path cases stand.
A new case puts a **fake `gh`** on the child's `PATH` that answers `get` from a canned
credential. That pins the `-c` pair and the gh-absent fallback without a network.

### (c) Fetch through gh with no git: not recommended

The fetch itself works and is well-defined (Q3). But the entry it produces has no `.git`, and the
package depends on one (Q4):

- F17 item 4 is a **cross-version contract** that every shipped shim makes. Breaking it needs a
  new contract item (for example a `<entry>/.bessemer-sha` stamp) and a reader for it.
- `findRepoRoot`, `selfHosted`, `resolveDispatcherRevision`, init's `tool-sha`, `readHeadReleases`,
  and `readRemoteReleases` would all have to read that stamp instead of git. `upgrade` / doctor
  would list tags through `gh api` (adding `--hostname github.com`, since `GH_HOST` redirects
  `gh api` but not the helper).
- Until all of that lands, a cache entry under a `$HOME` that is a git repo silently answers with
  `$HOME`'s revision.

**Shim** changes: `gh` becomes a hard F3 prerequisite, so `doctor` is unreachable without it. The
fetch becomes `gh api --hostname github.com repos/…/tarball/$sha`, with an exit-status check
before `tar` (errors go to stdout), `tar -xz --strip-components=1`, and a `git get-tar-commit-id`
check against the pin. F19's mirror tests cannot rewrite an API call, so every cold-path case needs
a fake `gh` serving tarballs. **README**: the same gh commands as (b). **`exec.ts`**: no allowlist
change. The work is several times (b)'s, and buys only the removal of git from the cold path,
which F3 requires anyway.

## Unverified / partial

- No written stability promise exists for gh's hidden `auth git-credential`. The case for its
  stability is structural: setup-git writes it into user configs, and gh calls it itself.
- Whether HireAnEsquire enforces SAML SSO on OAuth tokens.
- Linux secret-service keyrings for gh children spawned without `DBUS_SESSION_BUS_ADDRESS`.
- REST rate-limit accounting for archive downloads. The docs are silent, and `X-Ratelimit-Used`
  read `0` throughout on this account.
- The empty-`hosts.yml` / keyring observation in Q2 is recorded, not explained.
- `export-ignore` behaviour of the tarball endpoint. This is inferred from its being `git
  archive`-generated (`get-tar-commit-id` works), not documented, and moot until the repo gains a
  `.gitattributes`.
- pip and mise are cited from docs and a tag-named source path, not from a commit SHA.
