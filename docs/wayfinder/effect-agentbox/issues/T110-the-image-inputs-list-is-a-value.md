# T110 — The image's input list is a value

Status: Done (PR #71. `parseInputsList` also refuses `.` and `a/..`, which name the repo root rather than a file in it.)
Type: AFK
Blocked by: None — can start immediately.

<!--
P5, ruled 2026-09-30 (09's comment of that date, E10). Prefactor for T111: it has its own green
without a caller, so T111 reads as pure addition (the split-prefactor rule).
-->

## What to build

The package is taking over the image build (E10), and the build and probe 2 must share **one**
digest recipe. Today the recipe is spelled twice — `inputsDigest` in `src/doctor/probes.ts` and
`bessemer_inputs_digest` in `image/image-inputs.sh` — and T112 deletes the bash copy. This ticket
prepares the TS side and adds nothing that runs.

1. **Move the recipe into its own module**, `src/image/inputs.ts`: `inputsDigest`, `INPUTS_LABEL`,
   `INPUTS_DIGEST_LABEL`, `DeclaredInputs`, and `parseDeclaredInputs` move there unchanged, and
   `probes.ts` imports them. Probe 2's behaviour does not change by one byte. The comment above
   `inputsDigest` stops naming `.agentbox/build-image.sh` as a mirror and says the package's own
   build (T111) is the other caller.

2. **Parse the input list file** as a pure function, beside the recipe:

   ```ts
   parseInputsList(text: string, dockerfile: string): Either<ReadonlyArray<string>, InputsListRefused>
   ```

   - The file is `.bessemer/image/inputs`. Each line holds one repo-relative, `/`-separated path.
     Surrounding whitespace is trimmed, and blank lines and lines starting with `#` are ignored.
     That is how a template stamp (T113) fits in the file.
   - **No globs.** A line containing `*`, `?`, or `[` is refused, and the refusal names the line.
     An earlier inputs list used a requirements-file glob, and bash had to treat a glob that
     stopped matching as a missing file (`.agentbox/image-inputs.sh`). An exact path makes that
     case impossible.
   - An absolute path, or one that escapes the repo after normalizing (`..`), is refused, the same
     way `sandbox-env-file`'s lexical containment works (T61).
   - **The Dockerfile is implicit and always comes first.** The result is `[dockerfile, ...listed]`,
     where `dockerfile` is the repo-relative path the caller passes
     (`.bessemer/image/Dockerfile`). If the list names the Dockerfile itself, that entry is
     dropped rather than refused, so the Dockerfile is never hashed twice.
   - A repeated path is refused. It would hash twice and say nothing new.
   - The list file itself is **not** an input. Adding a path already changes the digest, because
     every hashed line carries its path.

   Checking whether a file exists is the build's job (T111), not this function's. It only
   decides what the list says.

## Effect wiring

- **Tags introduced or consumed**: none. `inputsDigest` keeps its
  `Effect<Option<string>, never, FileSystem | Path>` signature, and `parseInputsList` is pure.
- **Layer composition**: unchanged.

## Acceptance criteria

- [ ] `src/image/inputs.ts` holds the recipe and the two labels, and `probes.ts` imports them;
      every existing probe 2 test passes unmodified.
- [ ] `parseInputsList` returns the Dockerfile first, followed by the listed paths in file order,
      skipping comments and blank lines.
- [ ] A glob, an absolute path, a path escaping the repo, and a duplicate each produce a refusal
      that names the offending line.
- [ ] A list that names the Dockerfile yields it exactly once, first.
- [ ] An empty list, or one that is only comments, yields `[dockerfile]`.

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package.
