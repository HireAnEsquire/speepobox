# T149 — upgrade refreshes

Status: Done (PR #7. `upgrade` moves the pin, then runs the shim's `init --refresh` as a child and relays its lines; not on a rollback, and no child without a runnable shim. A failed child keeps the moved pin and exits 1. `init` prints its Next steps only where it wrote a file, so the relay carries no setup advice. Left as is: a release that adds a new scaffold file writes it on refresh, so that one upgrade shows the Next steps again.)
Type: AFK
Blocked by: T147

<!--
Ruled 2026-10-15. `upgrade` rewrites the `tool-sha` line and stops; the adopter then runs
`init --diff` and `init --refresh` by hand (README, "So the usual upgrade is…"). Skipping the
refresh leaves a scaffold older than the code: an old image Dockerfile the new code may need
changed, an old `.gitignore` that misses a new runtime path, a shim fix that never arrives.

Who does the refresh was decided: **the release that ships the templates applies them.** `upgrade`
runs the old release's code, which does not know the new templates, the new scaffold list, or the
new stamps. So `upgrade` moves the pin and then runs the repo's shim as a child,
`.speepobox/speepobox init --refresh`; the shim reads the new pin and the new release refreshes.
Considered and rejected:
- the old code fetching the new templates and writing them itself (old rules, new files: right
  until the day the rules change);
- the shim refreshing on the next command after it sees a new pin (a hidden write inside an
  unrelated command);
- leaving the two steps separate (today: how scaffolds fall behind).

Blocked by T147 because this runs a refresh on every upgrade, which makes a stranded
`<file>.refresh` more likely.

v4 has no handoff, so the v4 to v5 upgrade still needs one `init --refresh` by hand. Every upgrade
from v5 on gets it.
-->

## What to build

### After the pin, the refresh

When `upgrade` ends at `Pinned` (the pin moved) or at `Unchanged` (it is already current), it runs:

```
<repoRoot>/.speepobox/speepobox init --refresh
```

as a child, through `src/internal/exec.ts`. On `Unchanged` the cache entry already exists, so this
costs no fetch. It also makes `upgrade` the retry for a refresh that failed last time.

**Not on a rollback.** When the new release's number is lower than the old one's, `upgrade` does not
run the refresh. It prints one line instead: scaffold files are not rolled back, and
`init --diff` shows how they compare. A pin that was no release (`NoRelease`) counts as moving up.

**No shim, no refresh.** If `<repoRoot>/.speepobox/speepobox` is absent or not executable (an
`upgrade` run from a hand clone into a repo with no shim, say), the pin still moves. `upgrade`
prints that the refresh was not run and why, and gives the command to run it.

### The environment the shim needs

The shim reads `XDG_CACHE_HOME` to find the package cache (`templates/speepobox`, section 4). The
chokepoint's allowlist does not carry it today, so a child shim would look in `$HOME/.cache` while
the dispatcher's own shim used `$XDG_CACHE_HOME`, and build a second cache. Add `XDG_CACHE_HOME` to
`ENV_ALLOWLIST` with a note naming the child that reads it, as every entry there has. Add nothing
else.

### What `upgrade` prints

One report, in this order:

1. The pin line, as today.
2. The child's own output, verbatim. Those are the new release's `wrote`, `kept`, `refreshed`, and
   `removed` lines.
3. If any `kept … (behind, edited — see init --diff)` line came back, one line: those files are
   yours to merge, and `init --diff` shows each one.
4. If `image/Dockerfile` or `image/inputs` changed on disk across the refresh, one line: rebuild the
   image, naming the command. Decide "changed" by comparing the two files' bytes before and after the
   child, not by parsing its output. The command comes from the same place `init`'s next steps take
   it (`NEXT_STEPS` in `src/init/render.ts`).
5. The line that replaces today's "run `init --diff`" advice: review the diff, then commit
   `.speepobox/`.

**A refresh that fails** (the child exits nonzero, or cannot be started): the pin has already moved,
and `upgrade` says so plainly, quotes the child's stderr, gives the retry command
(`.speepobox/speepobox upgrade` or `.speepobox/speepobox init --refresh`), and exits 1. It never
moves the pin back.

### README

Section 5's upgrade text: `upgrade` now moves the pin **and** refreshes. Replace "So the usual upgrade
is `upgrade`, then `init --diff`, then `init --refresh`, then a hand merge…" with the new order:
`upgrade`, then a hand merge of any file it names, then commit. Keep the text on edited files and
the shim's `mv` route. Say that a rollback does not refresh, and that the v4 to v5 upgrade needs
one `init --refresh` by hand.

## Effect wiring

- **Tags introduced or consumed**: none new. `upgrade` already requires `CommandExecutor`,
  `FileSystem`, and `Reporter`.
- **Layer composition**: unchanged. `bin.ts`'s `upgrade` case stays as it is.

## Acceptance criteria

- [ ] After a `Pinned` or `Unchanged` decision, `upgrade` runs the repo's shim with `init --refresh`
      through the exec chokepoint, and its output appears in `upgrade`'s report.
- [ ] A test: a rollback (`--to` a lower release) moves the pin, runs no child, and prints the
      not-rolled-back line.
- [ ] A test: no executable shim moves the pin, runs no child, and prints the not-run line with the
      command.
- [ ] A test: a child that exits nonzero leaves the moved pin in place, quotes its stderr, gives the
      retry command, and `upgrade` exits 1.
- [ ] A test: when `image/Dockerfile`'s bytes differ before and after the child, the rebuild line is
      printed; when neither image file changes, it is not.
- [ ] `XDG_CACHE_HOME` is on `ENV_ALLOWLIST` with a note; nothing else is added.
- [ ] README section 5 describes the new order.

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package.

Also inside the container: `node src/bin.ts upgrade` under plain node refuses as self-hosted, with
its usual sentence, not a crash.

Host-only, after merge and a v5 tag: in a throwaway adopter repo pinned to v4, with a behind and
pristine file, run `upgrade` from a hand clone at v5 (`node "$clone/src/bin.ts" upgrade --repo-root
"$PWD"`), because v4's own `upgrade` has no handoff. The pin moves to v5, and the file is reported
`refreshed` by the child.
