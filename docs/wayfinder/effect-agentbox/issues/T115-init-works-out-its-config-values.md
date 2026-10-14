# T115 — `init` works out its config values

Status: Done (PR #78. The image name also trims separators at the end, and a name with nothing left is plain `bessemer`. Open: `imageNameFor` keeps `..` and `._` inside a name, which docker rejects, so a directory named `acme..web` gives an unusable default. `--image` overrides it.)
Type: AFK
Blocked by: [T114](T114-init-writes-the-scaffold.md) — the command, its guards, and the config substitution this fills in.

<!--
P5, ruled 2026-09-30 (09's comment of that date, E7, E9). Relaxes T114's required-flag guard. The
parser does not change, because the flags were optional there all along (T3).
-->

## What to build

`init` works out `base`, `image`, and `tool-sha` itself. The flags remain as overrides.

- **`base`**: a flag wins. Otherwise it is read from `refs/remotes/origin/HEAD` in the served repo,
  through a new `Git` read, `originHead({ repo })`, which returns `Option<string>` such as
  `"origin/main"`. It names its repo like every other read (T27) and runs under `inRepo`'s
  `--git-dir` (T32). The underlying command is `git symbolic-ref --short refs/remotes/origin/HEAD`,
  and an unset ref is `None`, not an error. If there is neither a flag nor a read, `init`
  **refuses** with one line: it cannot work out the base, so pass `--base`, or run
  `git remote set-head origin --auto`. It refuses before writing anything. There is no separate
  refusal for a repo with no `origin` (E9). Given `--base`, `init` proceeds, and `doctor`'s probe
  5 reports the missing remote.
- **`image`**: a flag wins. Otherwise it is the served repo directory's basename, lowercased, with
  every character outside `[a-z0-9._-]` replaced by `-`, runs of `-` collapsed, leading
  separators trimmed, and `-bessemer` appended. That turns `My App` into `my-app-bessemer`. This is
  a pure function with its own tests. The basename is a fact of `repoRoot`, which `init` already
  holds, so it is not a host read.
- **`tool-sha`**: the running package's revision, the `DispatcherRevision` `bin.ts` already
  resolves (T43) and passes to `init` as a parameter. If it is **dirty** or unknown, `tool-sha` is
  written as `""` and the report carries one warning saying the pin is empty and why. It is
  never a refusal, because the pin discipline is P6's (E7).

The report's `wrote` line for `config.toml` names the three values it used and where each came
from: *flag*, *origin/HEAD*, *directory name*, or *package revision*. An adopter reads the values
before committing them.

## Effect wiring

- **Tags introduced or consumed**: `Git` (consumed, **one read added**: `originHead`). Its fake
  and `GitRecordingLive` answer it. A recording layer keeps its reads real, so the recording
  layer delegates to live (T15). No new tag.
- **Layer composition**: unchanged from T114. `appBaseLiveFor` already provides `GitLive`. The
  `bin.ts` case gains the one parameter:

  ```ts
  case "init":
    return resolveDispatcherRevision(packageRepoRoot).pipe(
      Effect.flatMap((dispatcherRevision) =>
        init({ repoRoot, argv: argv.slice(1), selfHosted, templatesRoot, dispatcherRevision }),
      ),
      Effect.provide(appBaseLiveFor(repoRoot, stdinIsTTY)),
      Effect.catchAll(reportFailure),
    );
  ```

## Acceptance criteria

- [ ] In a temporary repo whose `origin/HEAD` points at `origin/trunk`, a bare `init` writes
      `base = "origin/trunk"`.
- [ ] `--base` overrides the read.
- [ ] With `origin/HEAD` unset and no `--base`, `init` refuses, naming both remedies, and writes
      nothing.
- [ ] `originHead` against real git returns `Some` for a set ref and `None` for an unset one, and
      names its repo with `-C` and `--git-dir`.
- [ ] The image-name function maps `My App`, `acme.web`, `_x`, and `API--v2` to legal lowercase
      tags ending in `-bessemer`, and `--image` overrides it.
- [ ] A clean revision is written as `tool-sha`. A dirty or unknown one writes `""` and emits one
      warning.
- [ ] The report names each value's source.

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package.
