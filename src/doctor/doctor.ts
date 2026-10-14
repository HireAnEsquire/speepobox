// The doctor runner: eleven probes in dependency order, rendered through the
// Reporter, exit 1 on any FAIL and 0 on warnings (run.sh:323-447). This is the
// first Layer exercise and the shape every later command copies.
import type { FileSystem, Path } from "@effect/platform";
import type { CommandExecutor } from "@effect/platform/CommandExecutor";
import { Effect, Either, Option } from "effect";
import type { AgentCredential } from "../agent/credential.ts";
import { type SpeepoboxConfigShape, defaultConfigFor, loadConfig } from "../config/config.ts";
import { speepoboxDir } from "../config/paths.ts";
import type { DispatcherRevision } from "../git/dispatcher-revision.ts";
import { Git } from "../git/git.ts";
import { parseRepoSlug } from "../git/repo-slug.ts";
import { Reporter } from "../reporter.ts";
import type { ProbeRow } from "./probes.ts";
import {
  credentialProbe,
  dispatcherFreshnessProbe,
  dispatcherPinnedRow,
  dockerProbe,
  ghProbe,
  gitProbe,
  imageProbe,
  nodeProbe,
  rootsRow,
  runtimeRootProbe,
  tasksDirProbe,
  upstreamProbe,
} from "./probes.ts";

// Every host fact doctor reports on, read at the composition root (bin.ts) and
// passed in — never read in here. That is why the node version is a parameter:
// reading it here made all five doctor tests pass on a node 26 host and fail on
// any older one, since the container satisfied the requirement and the gate
// could not see it. The repo root is the same kind of fact, and probe 8 resolves
// a relative tasks dir under it.
export interface DoctorHost {
  readonly nodeVersion: string;
  readonly repoRoot: string;
  // Where the package itself lives, as a value (T62). It arrives the way the
  // node version does and for the same reason: **this file may not import
  // `packageRoot`** — `scripts/check-bans.ts` refuses it — because every other
  // path here is a served-repo read, and a screen that resolved the package's
  // location for itself is how the two roots come to be confused in a file
  // that reads both.
  readonly packageRoot: string;
  // The repo enclosing the package (T129): where probe 11 asks `origin`
  // for the release list. bin.ts already computes it for
  // `resolveDispatcherRevision`, and it arrives here for the reason
  // `packageRoot` does — this file may not import the package location.
  readonly packageRepoRoot: string;
  // Whether the repo this invocation serves is the one the package lives in
  // (T60). Decided once in `bin.ts` — `findRepoRoot(packageRoot)` against
  // `--repo-root`, both `resolve`d — and travelling down as a value, so probe
  // 10 and the dispatch preflight cannot answer it differently.
  readonly selfHosted: boolean;
  // The dispatcher's own revision (T43), resolved at the composition root for
  // the dispatch surface and now for this screen too: it is what probe 10's
  // not-applicable row names. `None` is a read that came back empty, which
  // that row renders as unknown rather than failing on.
  readonly dispatcherRevision: Option.Option<DispatcherRevision>;
  // The agent credential, resolved once at the composition root against the
  // served repo's speepobox directory (T23, T58) and reported on twice here:
  // the roots row names where it came from, probe 3 says whether there is one
  // at all. One resolver call for the whole run — the rule T23 gave `doctor`
  // and the dispatch, taken one step further inside `doctor` itself, so the
  // two rows cannot describe two different credentials.
  readonly credential: Option.Option<AgentCredential>;
}

// Runs doctor and returns the number of FAILed probes; the entrypoint maps
// any failure to exit code 1. Never fails itself: a probe's typed failure
// becomes a FAIL row, not a program error.
export const doctor = (
  host: DoctorHost,
): Effect.Effect<
  number,
  never,
  Reporter | CommandExecutor | FileSystem.FileSystem | Path.Path | Git
> =>
  Effect.gen(function* () {
    const reporter = yield* Reporter;
    const git = yield* Git;
    let failures = 0;

    const emitRows = (rows: ReadonlyArray<ProbeRow>) =>
      Effect.forEach(
        rows,
        (row) =>
          reporter.emit({
            _tag: "ProbeChecked",
            probe: row.probe,
            status: row.status,
            detail: row.detail,
          }),
        { discard: true },
      );

    const fail = (probe: string, detail: string) =>
      Effect.gen(function* () {
        failures += 1;
        yield* reporter.emit({ _tag: "ProbeChecked", probe, status: "fail", detail });
      });

    const check = <E extends { readonly detail: string }, R>(
      probe: string,
      effect: Effect.Effect<ReadonlyArray<ProbeRow>, E, R>,
    ): Effect.Effect<boolean, never, R> =>
      Effect.gen(function* () {
        const outcome = yield* Effect.either(effect);
        if (Either.isLeft(outcome)) {
          yield* fail(probe, outcome.left.detail);
          return false;
        }
        yield* emitRows(outcome.right);
        return true;
      });

    // The decode happens once, up front: probe 7 reports its outcome, and the
    // probes that need config values (image, tasks dir, runtime root) degrade
    // to the committed defaults when it failed — doctor must keep working when
    // the thing it inspects is broken.
    const decoded = yield* Effect.either(loadConfig(host.repoRoot));
    const config: SpeepoboxConfigShape = Either.getOrElse(decoded, () =>
      defaultConfigFor(host.repoRoot),
    );

    // The roots row, before probe 1 and outside the numbering (T62): it
    // reports no state that can be wrong, it says which state every row below
    // is about — the served repo, the package and its revision, the config
    // file, where the credential came from, and whether the first two are one
    // directory. `host` carries exactly the five values it prints, so this is
    // the host's own answer and not a second one derived here.
    yield* emitRows([rootsRow(host)]);

    // 1-2: docker, then image — no point inspecting an image when the daemon is
    // down, so the image probe is a dependent FAIL, exactly like bash.
    const dockerOk = yield* check("docker", dockerProbe);
    if (dockerOk) {
      yield* check("image", imageProbe(config.image, host.repoRoot, config.imageBuildCommand));
    } else {
      yield* fail("image", "skipped — docker unavailable, fix the docker check above first");
    }

    // 3: credential presence — presence reported, never the value, and
    // reported on the one the composition root resolved rather than a second
    // resolution of its own (T62). The root is the served repo's speepobox
    // directory, the same one the dispatch hands the resolver (T58): a row
    // about the package's own `.env` reported on a file the shim re-clones on
    // every repin and every served repo shares.
    yield* check("credential", credentialProbe(speepoboxDir(host.repoRoot), host.credential));

    // 4: host node >= 26.
    yield* check("node", nodeProbe(host.nodeVersion));

    // 5: git work tree + origin. The origin read is resolved once here (T39)
    // — through `Git`, not a second `exec` — and handed to both this probe
    // and probe 6, which reports the repo it names: one definition, so the
    // two rows cannot disagree about what `git remote get-url origin`
    // answered.
    const origin = yield* Effect.either(git.originUrl(host.repoRoot));
    yield* check("git", gitProbe(host.repoRoot, origin));

    // 6: gh present + authenticated.
    const forgeRepo = Option.flatMap(Either.getRight(origin), parseRepoSlug);
    yield* check("gh", ghProbe(forgeRepo));

    // 7: config decodes — makes the decode-once failure visible before a
    // dispatch ever runs.
    if (Either.isRight(decoded)) {
      yield* emitRows([
        { probe: "config", status: "ok", detail: "config.toml decodes and satisfies the schema" },
      ]);
    } else {
      yield* fail("config", decoded.left.detail);
    }

    // 8: tasks dir present.
    yield* check("tasks-dir", tasksDirProbe(config, host.repoRoot));

    // 9: runtime root writable.
    yield* check("runtime-root", runtimeRootProbe(config));

    // 10: dispatcher freshness — is this dispatcher's source missing commits
    // its configured base already has? Off the already-decoded config, degraded
    // like every other probe above that reads it.
    //
    // Asked only when self-hosted (T60): pointed at a repo the package does
    // not live in, the pathspec leaves that repo and git exits 128, which
    // reads as `BaseUnresolvable` and printed a false "git fetch" warning on
    // every adopter's screen (19 §4). The other arm spends no `rev-list` and
    // says what it did not compare.
    if (host.selfHosted) {
      yield* check("dispatcher-freshness", dispatcherFreshnessProbe(host.repoRoot, config.base));
    } else {
      yield* emitRows([dispatcherPinnedRow(host.dispatcherRevision)]);
    }

    // 11: upstream — the pin against the latest release (T129). Always an
    // `ok` row, so it never counts towards `failures`; not applicable, and
    // no `ls-remote` spent, when self-hosted.
    yield* emitRows([yield* upstreamProbe(host)]);

    return failures;
  });
