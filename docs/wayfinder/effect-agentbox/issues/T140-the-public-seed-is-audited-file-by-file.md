# T140 — The public seed is audited file by file

Status: Done (PR #100. Manifest at `research/T140-public-seed-manifest.md`: 359 keep, 52 scrub, 10 drop. Ruled 2026-10-14: identity stays, the rest as proposed; T141 applies the scrubs.)
Type: AFK
Blocked by:

<!--
Ruled 2026-10-14: bessemer goes public as a NEW repository under the HireAnEsquire org, seeded
from the current tree as one fresh commit. This private repo stays as the archive. The names "hae"
and "HireAnEsquire" are public, so mentioning them is fine. The concern is hae's internals, and
anything else that should not be published. The second concern is keeping what agents working in the
new repo need: AGENTS.md ends every rule in a ticket, and the code cites tickets and `run.sh:N`
throughout. This ticket only produces the audit; the operator decides from it.
-->

## What to build

A manifest that sorts every tracked file into **keep**, **scrub**, or **drop** for the public seed,
written to `docs/wayfinder/effect-agentbox/research/T140-public-seed-manifest.md`. This is a reading
task. **Change no file except the manifest.**

### What counts as sensitive

The names `hae` and `HireAnEsquire` are **not** sensitive. Flag:

- hae's internals: its settings and config values, its infrastructure (hosts, URLs, ports, database
  names), its test failures and bugs, quoted hae source, the contents of its Dockerfile and setup
  scripts, and any weakness in hae's security;
- people: names, handles, and email addresses other than placeholders (`example.com`, `noreply`);
- links into private systems: the private hae repo's issues and PRs, and any chat or tracker link;
- absolute home paths (`/Users/…`, `/home/…`);
- anything that looks like a credential. **Report its `path:line` only. Never copy a value into the
  manifest.** For an env-style file, report key names only.

bessemer's own design, its bash-parity notes, and the fact that it was built for hae are not
sensitive.

### The three verdicts

- **keep**: publish as it is.
- **scrub**: publish after the edits listed. Give each edit as `path:line`, what is wrong, and a
  proposed rewrite or redaction. Prefer rewording ("an adopter's test suite") to deletion where the
  passage carries a rule's argument.
- **drop**: leave out of the seed. Give the reason. A file that only records the route the work
  took (the map, the hae sequence, the gate) and that nothing an agent reads depends on is a drop
  candidate.

### Citations that a drop or a fresh history breaks

The seed has no history, so these break whatever is kept. List each class with a count and the files
it appears in, and propose one treatment per class:

- `T<N>` citations to a ticket the manifest drops (AGENTS.md, SPEC.md, `src/`, `test/`);
- citations to a numbered decision doc the manifest drops;
- `run.sh:N`, `tasklib.py:N`, and `.agentbox/…` citations, which point at commit
  `6f66e9ac891462de809d207822c77d8f27615663` in this repo;
- other commit SHAs and PR numbers from this repo's history.

For each class, the treatment options are: keep as it is (historical), reword without the pointer,
or point at the private archive. Recommend one and say why.

### How to work

There are about 420 tracked files, so do not read them all in full. First sweep with `git grep`
for the patterns above. Every file with no hit and no reason to doubt it is **keep** on the sweep's
evidence; say so in its row. Read the flagged files in full. `docs/wayfinder/` holds most of the hae
mentions.

### The manifest's shape

1. A summary: counts per verdict, and the five most important findings.
2. The citation table above.
3. One table per top-level directory, one row per tracked file: `path`, verdict, reason, and for a
   scrub the edits. Every file from `git ls-files` appears exactly once, the manifest included.

## Effect wiring

- **Tags introduced or consumed**: none. No code changes.
- **Layer composition**: unchanged.

## Acceptance criteria

- [ ] The manifest exists at the path above and no other file changed.
- [ ] Every file `git ls-files` lists appears in the manifest exactly once.
- [ ] The manifest contains no credential value, and quotes no env file's values.
- [ ] Every scrub row lists its edits as `path:line`.
- [ ] The citation table covers all four classes, with counts and one recommendation each.

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package.

Coverage, also run inside the container. It prints nothing when every tracked file has a row:

```
git ls-files | while read -r f; do grep -qF "\`$f\`" docs/wayfinder/effect-agentbox/research/T140-public-seed-manifest.md || echo "missing: $f"; done
```

Host-only, after merge: the operator reviews the manifest and rules on every scrub and drop. That
review, not this ticket, decides the seed.
