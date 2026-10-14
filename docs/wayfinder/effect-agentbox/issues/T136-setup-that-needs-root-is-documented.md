# T136 — Setup that needs root is documented

Status: Done (PR #97. Template image/Dockerfile at v3; a host fix made the README's example uncomment the template's block as it stands, so sudo is installed once. Image rebuilt on the host after merge. Adopters get v3 with the next release.)
Type: AFK
Blocked by: the hae install gate (private archive) — the pattern described is the one hae's gate actually ran.

<!--
Ruled 2026-10-08 as P7's G10 and G14 (09's comment of that date). The pattern is the one adopter
#1's install ran, after all six of its gate runs passed on it. Where this ticket and that install
disagree, describe what the install does.
-->

## What to build

An adopter whose setup needs root, such as one that starts a database, finds one pattern written
down for it. They also learn about it from `init --diff`. Today the template's Dockerfile says "No
sudo" and stops there, and the README says nothing on the subject.

Bessemer builds no mechanism for this, because the image is the adopter's (MAP: *a client's stack
is the client's business*). It describes **one** pattern, and other patterns stay allowed:

- **Root work is a script baked into the image.** It lives in `.bessemer/image/` and is listed in
  `image/inputs`, so a change to it makes the image stale under probe 2. It is `COPY`'d to a fixed
  absolute path.
- **sudo is scoped to that exact command line.** The sudoers entry is
  `agent ALL=(ALL) NOPASSWD: /usr/bin/bash <path>`, and the hook invokes exactly that.
- **The mounted hook runs as the image's user.** It calls the one `sudo` and does everything else
  unprivileged. A dependency install run as root leaves root-owned files in the clone.
- **`cap-add` carries what sudo and the script need, and nothing more.** sudo needs `SETUID` and
  `SETGID`. Everything beyond that is earned by the script, the way a database server's startup
  earns further capabilities (e.g. `CHOWN`, `KILL`).

It is written in two places:

1. **The README** gets a short section after the image build step, with a worked example drawn from
   hae's real files. The example starts a database and uses no hae names.
2. **The Dockerfile template**'s "No sudo" sentence becomes a commented-out block (the `sudo` apt
   entry, the `COPY`, the sudoers line) that points at the README section. The template's version
   goes from 2 to 3, so `init --diff` reports the change to adopters. Any digest fixture the bump
   touches is updated with it.

The hook mechanism, the sandbox spec, and the config keys do not change.

## Effect wiring

- **Tags introduced or consumed**: none.
- **Layer composition**: unchanged.

## Acceptance criteria

- [ ] The README describes the pattern above, and the template's Dockerfile points at that section.
- [ ] The template builds exactly as before while the block stays commented out. The image-build
      tests stay green.
- [ ] The Dockerfile template is at version 3. An `init --diff` test reports a pristine Dockerfile
      stamped v2 as *behind* and safe to take.

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package.

## Appendix

The README's worked example was drawn from adopter #1's install files.
