import { configDefaults, defineConfig } from "vitest/config";

// Note the transform gap: vitest accepts source plain node cannot run. The
// tracer — `node src/bin.ts doctor` with no transform step — is the check
// that closes it, and it is not part of this suite on purpose (ticket 12).
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // The fake tier is the whole of `verify` (SPEC §11): every case here is
    // Layer-faked and runs in a container with no docker socket. `test/live/`
    // is the other tier and is excluded by path — belt to the braces of the
    // tag itself, which throws on import when it is collected from here
    // (`test/live/live.ts`). Neither half of that pair skips: a live case
    // reached under `verify` is a red run, because skipped-is-green in
    // exactly the environment that writes all the code is the false green
    // ticket 04 already ate once.
    exclude: [...configDefaults.exclude, "test/live/**"],
    // Sized against the container, which node cannot see. Inside a
    // `--memory 8g` sandbox `os.cpus()` still reports the host's 14 and
    // `os.totalmem()` still reports 17GB — neither is namespaced — so the
    // default one-fork-per-CPU pool starts ~13 workers that each size a heap
    // against memory the cgroup will not give them. Observed as a `verify`
    // that took 10.5 minutes in the sandbox against 73 seconds on a two-core
    // CI runner. A `--cpus` limit on the container would not help: it does not
    // change what `os.cpus()` reports either. Four is below the floor of any
    // machine this runs on, so it costs nothing on the host or in CI.
    poolOptions: { forks: { maxForks: 4 } },
  },
});
