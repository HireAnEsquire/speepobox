# T121 — The pin is read by one grammar

Status: Done (PR #83. src/pin/pin.ts; fixture lines under test/fixtures/pin/, verdict by directory, for T125's agreement test.)
Type: AFK
Blocked by: None — can start immediately.

<!--
P6, ruled 2026-10-02 (09's comment of that date, F6 and F7, F6 as amended the same day).
Terms: **pin**, **release**, **shim** (CONTEXT.md). Prefactor: a pure module with its own green
and no caller yet. Its callers are T124 (asserting the line init writes), T125 (the agreement
test against the shim's `sed`), T128 (`upgrade`), and T129 (`doctor`).
-->

## What to build

**One grammar with two implementations** (F7): the shim's `sed` (T125) and one TS module. This
ticket is the TS module and the fixture lines both implementations will be held to.

### The module

A pure function from the text of `.bessemer/config.toml` to the pin or a refusal. It reads text
handed to it and nothing else: no `FileSystem`, no `Git`. Put it in its own module (for example
`src/pin/pin.ts`); it is not a `BessemerConfig` concern (T120).

The grammar is SPEC §6's, exactly:

```
^tool-sha[ \t]*=[ \t]*"([^"]*)"[ \t]*$
```

Exactly one line may match, and the captured value must match `^[0-9a-f]{40}$`. It is narrower
than TOML on purpose, and `init` always writes a line it accepts. The answers:

| Verdict | When | Its fix, named in the refusal |
| --- | --- | --- |
| pin | one matching line whose value is 40 lowercase hex | — |
| **no line** | no line matches and none is malformed | run `init` (F5's hand clone, on a fresh repo), or add the line |
| **malformed** | a line that starts, after optional blanks, with `tool-sha` then optional blanks and `=`, and that the grammar does not match: single quotes, a trailing comment, leading indentation | quote the expected form, `tool-sha = "<40-hex sha>"` |
| **duplicated** | more than one line matches | keep one |
| **empty** | the one matching line's value is `""` (`init` ran on a dirty package) | as *short* |
| **short** | the value is non-empty and not 40 lowercase hex | see below |

*Duplicated* follows from F6's *exactly one line may match* and its *each failure is its own
refusal*; it is not one of the four F6 names, so it is its own. A malformed line wins over
everything else: a file with one good line and one malformed one is malformed, because the shim
cannot know which the adopter meant.

**The empty and short fix (F6, amended).** The shim cannot run `upgrade` on a pin it cannot fetch,
so the remedy names, first, `git ls-remote --tags https://github.com/HireAnEsquire/bessemer.git`,
from which the adopter copies the full SHA on a release's `vN^{}` line onto the `tool-sha` line —
git and the credential F4 already needs, and no clone. Second, `upgrade --to vN` run from a hand
clone, the way F5 runs `init`. The refusal is a value with a tag per verdict; the sentence is the
renderer's, and T125's shim prints the same remedies in its own words.

Also export what `upgrade` needs to rewrite the line (T128): where the one grammar-matching line
is, so that `--to` can replace it whatever its value. `--to` needs a matching line, not a valid
value; a *malformed*, *duplicated*, or *no line* file gives it nothing safe to rewrite.

### The fixture lines

A shared fixture both implementations run over, so T125's agreement test can assert the shim's
`sed` reaches the same verdict on every line. One config text per case, each with its expected
verdict:

- valid (spaces around `=`), and valid with **tab** separators — BSD `sed` does not read `\t` in a
  bracket expression, which is the bug the tab case exists to catch;
- short (`abc1234`), empty, uppercase hex;
- single-quoted, trailing comment, indented;
- duplicated (two valid lines);
- missing (no `tool-sha` at all; another key that merely contains `tool-sha` in a comment or a
  value is still *no line*).

Keep them as data (one file per case, or one structured file), not inlined in the TS test, because
T125 feeds the same files to a shell.

## Effect wiring

- **Tags introduced or consumed**: none. A pure module.
- **Layer composition**: unchanged.

## Acceptance criteria

- [ ] Every fixture case returns its expected verdict from the module (test).
- [ ] A valid case returns the full 40-hex SHA as written.
- [ ] Each refusal carries its kind, and the rendered sentence for *empty* and *short* names
      `git ls-remote --tags https://github.com/HireAnEsquire/bessemer.git` before `upgrade --to vN`
      from a hand clone.
- [ ] The line-locating export finds the one matching line for valid, empty, and short texts,
      and refuses for malformed, duplicated, and missing ones.

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package.
