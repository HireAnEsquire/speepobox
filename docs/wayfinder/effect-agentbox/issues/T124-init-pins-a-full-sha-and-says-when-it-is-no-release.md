# T124 — `init` pins a full SHA, and says when it is no release

Status: Done (PR #86. config.toml template now v2; the no-release warning stays silent when the offline release read fails.)
Type: AFK
Blocked by: [T121](T121-the-pin-is-read-by-one-grammar.md) — the grammar the written line must pass; [T122](T122-releases-are-a-value.md) — the offline release read; [T123](T123-the-running-revision-carries-its-full-sha.md) — the full SHA.

<!--
P6, ruled 2026-10-02 (09's comment of that date, F6 and F16; SPEC §7's `init` row). Terms: **pin**,
**release** (CONTEXT.md). T127 also edits `src/init/` and `templates/config.toml`; the two can run
side by side, but expect a merge, as T115 and T116 had.
-->

## What to build

`init` writes the pin the shim can fetch, and tells the adopter when what it pinned is not a
release.

1. **A full SHA** (F6). `tool-sha` is the running revision's full SHA (T123), not the short
   revision `init` writes today. Everything else about `resolveToolSha` holds: a dirty package or
   an unreadable revision still writes `tool-sha = ""` with its warning. The empty line is one
   T121's grammar reads as *empty*, and the shim refuses it naming the fix — that refusal is the
   point at which the adopter is stopped, so the warning here stays a warning.
2. **The written line passes the grammar.** Assert it: the `config.toml` `init` writes, read
   through T121's module, is a pin equal to the running revision's full SHA. `init` must always
   write a line the grammar accepts (F6), and this is the test that holds it to that.
3. **No release, a warning** (F16). When the revision it pins carries no release — T122's offline
   read, `git tag --points-at HEAD` in the package, filtered by the release predicate — `init`
   warns and still writes. A hand clone at main is a legitimate way to try a revision; `upgrade`
   only ever pins releases. Say what is true: the pin is `<short>`, no `v<N>` tag points at it, and
   `upgrade` moves a pin only between releases. No network: the shim's warm path has none, and
   neither does this.
4. **The config template's comment on `tool-sha`** says what a pin is now: the full SHA of the
   bessemer release this repo runs, read by the shim, changed by `upgrade` or by hand, and fit to
   pin when a `v<N>` tag marks it (SPEC §6's repin discipline). Bump `config.toml`'s template
   version for the text change (`TEMPLATE_VERSIONS`); if T127 has already bumped it, take the next
   number. No released template is affected — nothing has been released yet.

The rendered `wrote` line keeps showing the value it wrote, which is now 40 characters; that is
what the adopter commits, so show it whole.

## Effect wiring

- **Tags introduced or consumed**: none new. The offline release read is T122's module, called
  with `packageRepoRoot` resolved in `bin.ts`.
- **Layer composition**: unchanged. The `init` case in `bin.ts` gains the release read beside
  `resolveDispatcherRevision`, both host facts about the package resolved at the composition root
  and passed in.

## Acceptance criteria

- [ ] On a clean package, the written `config.toml`'s `tool-sha` is the full 40-hex SHA, and T121's
      module reads it back as that pin (test).
- [ ] On a dirty package, `tool-sha = ""` with the existing warning (test unchanged in substance).
- [ ] With no release on `HEAD`, `init` writes everything and warns once, naming the short
      revision; with a release on `HEAD`, no such warning (tests).
- [ ] `config.toml`'s template version is bumped, and its `tool-sha` comment names the full SHA,
      releases, and `upgrade`.

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package.
