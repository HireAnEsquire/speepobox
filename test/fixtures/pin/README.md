# The pin grammar's fixture lines (T121)

One `.bessemer/config.toml` text per file, held to SPEC §6's grammar by both of its
implementations: `src/pin/pin.ts` (`test/pin.test.ts`) and the shim's `sed` (T125). Keep them as
data — the shim's agreement test feeds these same files to a shell.

- The **directory** names the expected verdict: `pin`, `no-line`, `malformed`, `duplicated`,
  `empty`, `short`.
- Every case under `pin/` pins the SHA in `sha`, written exactly as it appears in the file.

The bytes matter: `pin/tabs.toml` separates with real tab characters, because BSD `sed` does not
read `\t` inside a bracket expression, and that is the bug it exists to catch.
