# T120 — `tool-sha` leaves the config chain

Status: Done (PR #82. This repo's config.toml drops its pin line; a test checks an adopter's file with one still decodes.)
Type: AFK
Blocked by: None — can start immediately.

<!--
P6, ruled 2026-10-02 (09's comment of that date, F7 and F8). Terms: **pin** (CONTEXT.md).
Prefactor: it has its own green without any P6 caller, so the pin reader (T121) and everything
after it read as pure addition.
-->

## What to build

The **pin** is not a config key (SPEC §6, F7). The shim reads it before the package exists, and
the one TS reader of it is T121's line grammar. `BessemerConfig` decoding it through the
four-layer chain is a second answer to *what is pinned* that nothing reads, and one a
`config.local.toml` or a `BESSEMER_TOOL_SHA` could make disagree with the shim — which is the skew
inside a team that 01's property (a) exists to rule out.

1. **`toolSha` leaves `BessemerConfig`**: the field, its default, and its `Config.string` read in
   `src/config/config.ts`. Nothing reads it today; confirm with a repo-wide grep before deleting,
   and update the config test that asserts its type.
2. **A file that keeps the line still decodes.** Decoding ignores unknown keys, so an adopter's
   `config.toml`, which always carries `tool-sha`, decodes exactly as before. Pin that with a test
   rather than trusting it: the scaffold's own `templates/config.toml`, substituted, decodes.
3. **This repo deletes its `tool-sha` line** from `.bessemer/config.toml` (F8). `init` refuses here
   (E9), so this repo gets no shim, and the checked-out branch chooses the dispatcher. Nothing
   self-hosted reads a pin, which T128 and T129 rely on.

`templates/config.toml` keeps its `tool-sha = "{{tool-sha}}"` line: an adopter's file carries the
pin. Its comment is T124's to rewrite.

## Effect wiring

- **Tags introduced or consumed**: `BessemerConfig` loses a field. No tag changes.
- **Layer composition**: unchanged.

## Acceptance criteria

- [ ] `BessemerConfig` has no `toolSha`, and no source file reads a `tool-sha` config key.
- [ ] A `config.toml` holding a `tool-sha` line decodes, with every other key as before (test).
- [ ] `.bessemer/config.toml` in this repo has no `tool-sha` line, and `node src/bin.ts doctor`
      still reports probe 7 (config decodes) `ok`.

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package.

Host-only: `node src/bin.ts doctor` under plain node.
