// The eleven doctor probes (run.sh:303-420 ported per the T1 table), in
// dependency order, each a distinct effect with a typed failure, plus the
// roots row the screen opens with (T62). Probes call the subprocess chokepoint
// directly; they do NOT go through Sandbox — doctor must work when the thing
// it inspects is broken (03 §1.1).
import { FileSystem, type Path } from "@effect/platform";
import type { CommandExecutor } from "@effect/platform/CommandExecutor";
import { join } from "node:path";
import { Data, Effect, Either, Option } from "effect";
import {
  type AgentCredential,
  CREDENTIAL_ADVICE,
  CREDENTIAL_FILENAME,
  type CredentialSource,
} from "../agent/credential.ts";
import type { BessemerConfigShape } from "../config/config.ts";
import { bessemerDir, resolveTasksDir } from "../config/paths.ts";
// The dispatcher-freshness question (T42), and the `RepoUrl` userinfo rule
// beside it: both are pure imports and not the `Git` tag, for the same
// reason — `doctor` must work when the toolchain it inspects is broken, so
// the read-only slice gains no git dependency here.
import { dispatcherFreshnessArgs, readDispatcherFreshness } from "../git/dispatcher-freshness.ts";
import type { DispatcherRevision } from "../git/dispatcher-revision.ts";
import type { GitError } from "../git/git.ts";
import { latestRelease, readRemoteReleases, type Release, releaseAt } from "../git/releases.ts";
import { repoArgs } from "../git/repo-args.ts";
import { repoSlugArg, type RepoSlug } from "../git/repo-slug.ts";
import { urlEmbedsUserinfo } from "../git/repo-url.ts";
import {
  INPUTS_DIGEST_LABEL,
  INPUTS_LABEL,
  inputsDigest,
  parseDeclaredInputs,
} from "../image/inputs.ts";
import { exec } from "../internal/exec.ts";
import { pinIn } from "../pin/pin.ts";
import type { ProbeStatus } from "../reporter.ts";

export interface ProbeRow {
  readonly probe: string;
  readonly status: Exclude<ProbeStatus, "fail">;
  readonly detail: string;
}

export class DockerUnavailable extends Data.TaggedError("DockerUnavailable")<{
  readonly detail: string;
}> {}
export class ImageUnavailable extends Data.TaggedError("ImageUnavailable")<{
  readonly detail: string;
}> {}
export class CredentialMissing extends Data.TaggedError("CredentialMissing")<{
  readonly detail: string;
}> {}
export class NodeTooOld extends Data.TaggedError("NodeTooOld")<{
  readonly detail: string;
}> {}
export class GitUnavailable extends Data.TaggedError("GitUnavailable")<{
  readonly detail: string;
}> {}
export class GhUnavailable extends Data.TaggedError("GhUnavailable")<{
  readonly detail: string;
}> {}
export class TasksDirMissing extends Data.TaggedError("TasksDirMissing")<{
  readonly detail: string;
}> {}
export class RuntimeRootUnwritable extends Data.TaggedError("RuntimeRootUnwritable")<{
  readonly detail: string;
}> {}

const ok = (probe: string, detail: string): ProbeRow => ({ probe, status: "ok", detail });
const warn = (probe: string, detail: string): ProbeRow => ({ probe, status: "warn", detail });

// What `config.ts`'s provider chain reads out of the bessemer directory. A
// `config.local.toml` beside it wins for whatever key it declares, which is a
// fact about values rather than about where a served repo's config lives —
// the row below names the file an adopter is told to write.
const CONFIG_FILENAME = "config.toml";

// Where the credential came from, as a place and never as a value: the file
// the advice names, under the root it was resolved against, or the process
// environment. Spelled once because two rows print it — the roots row and
// probe 3 — off the one resolution the composition root made.
const credentialSource = (root: string, source: CredentialSource): string =>
  source === "file" ? join(root, CREDENTIAL_FILENAME) : "the environment";

// The dispatcher's own revision as a row prints it (T43): the short SHA,
// marked when its source was dirty, and `revision unknown` when that read came
// back empty. Two rows print it — the roots row and probe 10's not-applicable
// arm — so neither spells it for itself.
const revisionLabel = (dispatcherRevision: Option.Option<DispatcherRevision>): string =>
  Option.match(dispatcherRevision, {
    onNone: () => "revision unknown",
    onSome: (dispatcher) => `${dispatcher.revision}${dispatcher.dirty ? "-dirty" : ""}`,
  });

// The row `doctor` opens with (T62), before probe 1, because it says what
// every row after it is about: which repo this invocation serves, where the
// package itself lives and at which revision, which config file was read,
// where the credential came from, and whether those first two roots are one
// directory. Informational and always `ok` — it reports no state that can be
// wrong, it says which state the rest of the screen is reporting on.
//
// **Names and paths, never a value.** The credential's *place* is the whole of
// what it says about the credential, exactly as probe 3 below.
//
// Every value is a parameter or derived from one, and the package's location
// is a parameter rather than an import — `scripts/check-bans.ts` refuses the
// import here (19 §8) and this is the row that would have hidden the
// conflation best: a row that read the package's own location to describe it
// would be right in this repo, where the two roots coincide, and wrong in
// every repo the shim serves.
export const rootsRow = (roots: {
  readonly repoRoot: string;
  readonly packageRoot: string;
  readonly dispatcherRevision: Option.Option<DispatcherRevision>;
  readonly credential: Option.Option<AgentCredential>;
  readonly selfHosted: boolean;
}): ProbeRow => {
  const bessemer = bessemerDir(roots.repoRoot);
  return ok(
    "roots",
    [
      `serving ${roots.repoRoot}`,
      `package ${roots.packageRoot} at ${revisionLabel(roots.dispatcherRevision)}`,
      `config ${join(bessemer, CONFIG_FILENAME)}`,
      // `none` and not a path: an absent credential has no source, and probe 3
      // is where a host is told what to do about it — this row would be a
      // second, shorter answer to a question that already has one.
      `credential ${Option.match(roots.credential, {
        onNone: () => "none",
        onSome: (found) => `from ${credentialSource(bessemer, found.source)}`,
      })}`,
      roots.selfHosted ? "self-hosted" : "not self-hosted",
    ].join("; "),
  );
};

// 1. docker: CLI present, daemon responding.
export const dockerProbe: Effect.Effect<
  ReadonlyArray<ProbeRow>,
  DockerUnavailable,
  CommandExecutor
> = Effect.gen(function* () {
  const info = yield* exec("docker", "info").pipe(
    Effect.mapError(
      () => new DockerUnavailable({ detail: "CLI not found — install Docker Desktop / docker-ce" }),
    ),
  );
  if (info.exitCode !== 0) {
    return yield* new DockerUnavailable({
      detail: "daemon not responding — start Docker Desktop / dockerd",
    });
  }
  return [ok("docker", "CLI present, daemon responding")];
});

// The recipe and its labels live in `image/inputs.ts` (T110), shared with the
// package's build; they are re-exported here for probe 2's own tests.
export {
  type DeclaredInputs,
  INPUTS_DIGEST_LABEL,
  INPUTS_LABEL,
  inputsDigest,
  parseDeclaredInputs,
} from "../image/inputs.ts";

// Both labels out of one inspect. `{{"\n"}}` is the template's own newline: a
// literal `\n` in a `-f` string is unescaped by `docker ps --format` and not by
// `docker inspect`. An absent label renders as the empty string.
const LABELS_FORMAT =
  `{{index .Config.Labels "${INPUTS_LABEL}"}}{{"\\n"}}` +
  `{{index .Config.Labels "${INPUTS_DIGEST_LABEL}"}}`;

// 2. image: exists locally, and was built against the dependency file contents
// this repo now holds — a WARN when it was not, never a FAIL.
//
// No clock, on either side (T30). The old rule compared the newest input mtime
// against the image's own creation timestamp, and git rewrites a file whenever
// it differs between two branches: one branch switch moved every mtime a month
// past its last content change, so the warning was on for every dispatch, and
// the rebuild it named could not clear it (that build context holds neither lock
// file). It also evaporated to an `ok` row in any repo without hae's three
// hard-coded paths in it, which is worse than a false positive because nothing
// says the check stopped running. The image declares what it was built from and
// the probe recomputes it; the package names no dependency path of its own.
//
// The repo root arrives as a parameter and is not asked of git (T27): this
// probe runs on the dispatch's preflight as well as in `doctor`, so a second
// answer to "which repo is this" meant a dispatch reporting on a repo it was
// not dispatching for.
// `image-build-command` is the host's to declare and is unset by default (the
// package ships no repo's path — `setup-hook`'s rule), so every message that
// names it has to read without one. Naming the act is the floor: "rebuild" on
// its own still tells a reader what to do, where "rebuild: " tells them the
// tool is broken.
const named = (buildCommand: string): string => (buildCommand === "" ? "" : ` (${buildCommand})`);

export const imageProbe = (
  image: string,
  repoRoot: string,
  buildCommand: string,
): Effect.Effect<
  ReadonlyArray<ProbeRow>,
  ImageUnavailable,
  CommandExecutor | FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    // Reachable since `image` lost its code default (T40): `doctor` degrades to
    // `defaultConfig` on a failed decode. Answered here so docker is never
    // asked to inspect `''`.
    if (image === "") {
      return yield* new ImageUnavailable({
        detail:
          "no 'image' declared — this package ships no default image name; declare one in config.toml",
      });
    }
    const inspect = yield* exec("docker", "image", "inspect", "-f", LABELS_FORMAT, image).pipe(
      Effect.mapError(
        () =>
          new ImageUnavailable({ detail: "skipped — docker CLI unavailable, fix docker first" }),
      ),
    );
    if (inspect.exitCode !== 0) {
      return yield* new ImageUnavailable({
        detail: `'${image}' not found locally — build it${named(buildCommand)}`,
      });
    }
    const declared = parseDeclaredInputs(inspect.stdout);
    if (Option.isNone(declared)) {
      // `ok` and not `warn`, deliberately: every image built before T30 is
      // undeclared, so a warning here would nag on every dispatch until the
      // user rebuilds — the always-on warning this rule exists to remove. The
      // row still says plainly that nothing is being checked, because a check
      // that quietly stopped running is the failure mode above.
      return [
        ok(
          "image",
          `'${image}' present — it declares no build inputs, so staleness is unchecked; rebuild${named(buildCommand)} to enable it`,
        ),
      ];
    }
    const digest = yield* inputsDigest(repoRoot, declared.value.paths);
    if (Option.isSome(digest) && digest.value === declared.value.digest) {
      return [ok("image", `'${image}' present, built against the current dependency files`)];
    }
    return [
      warn(
        "image",
        `'${image}' was built against different contents of ${declared.value.paths.join(", ")} — rebuild${named(buildCommand)}`,
      ),
    ];
  });

// 3. credential: an LLM API credential is configured — presence reported,
// never the value. Where one may come from is `agent/credential.ts`'s answer
// and no longer this file's (T23): the probe used to decide for itself, the
// run decided differently, and a green row here meant nothing about whether
// the next dispatch could authenticate.
//
// It no longer asks the resolver either (T62): the credential is a host read,
// so it is resolved once at the composition root and travels down as a value
// — the roots row above names where it came from and this row reports on the
// same answer, so one `doctor` run makes one resolver call and the two rows
// cannot describe two different credentials. The root is still a parameter
// because this row says *which file* would have carried it (T58).
//
// The credential is deliberately outside the config record (05 Q7): secrets
// live only in the gitignored .env, and this row reports presence of external
// state rather than a config key.
export const credentialProbe = (
  root: string,
  credential: Option.Option<AgentCredential>,
): Effect.Effect<ReadonlyArray<ProbeRow>, CredentialMissing> =>
  Option.match(credential, {
    onNone: () => new CredentialMissing({ detail: CREDENTIAL_ADVICE }),
    // The name that was *found*, because that is what the resolver answered
    // with and what the container will be handed, and *where* it was found,
    // because a host that has two candidates wants to know which one this
    // run would use. The place, never the value: the path may be printed,
    // the token is the one thing this row exists not to say.
    onSome: (found) =>
      Effect.succeed([
        ok(
          "credential",
          `${found.name} set from ${credentialSource(root, found.source)} (value not shown)`,
        ),
      ]),
  });

export const nodeMajor = (version: string): number => Number(version.split(".")[0]);

// 4. host node >= 26 (replaces bash's host python >= 3.14): the dispatching
// host runs the TS source directly under Node's type stripping.
export const nodeProbe = (version: string): Effect.Effect<ReadonlyArray<ProbeRow>, NodeTooOld> => {
  if (nodeMajor(version) >= 26) {
    return Effect.succeed([ok("node", `host node v${version} (>= 26)`)]);
  }
  return Effect.fail(
    new NodeTooOld({
      detail: `host node is v${version}, need >= 26 (the host runs the TS source under type stripping) — upgrade node`,
    }),
  );
};

// 5. git: the repo root is a work tree; 'origin' remote present.
//
// `-C <repoRoot>` on the work-tree check, and the questions are about that
// repo rather than about wherever `doctor` was typed (T27): the repo a
// dispatch would run in is the one whose work tree and remote decide whether a
// dispatch can push, and answering for the working directory would fail a
// fine host — or pass a broken one — on the strength of where the user was
// standing.
//
// The origin arrives already resolved rather than read here (T39): this probe
// used to shell `git remote get-url origin` directly, around the `Git` tag
// rather than through it, and probe 6 needs the identical answer to report
// which repo `gh` would act on — `doctor.ts` reads it once, through
// `Git.originUrl`, and hands both probes the one result, the same
// decode-once shape probe 7's config already is.
export const gitProbe = (
  repoRoot: string,
  origin: Either.Either<string, GitError>,
): Effect.Effect<ReadonlyArray<ProbeRow>, GitUnavailable, CommandExecutor> =>
  Effect.gen(function* () {
    const workTree = yield* exec(
      "git",
      ...repoArgs(repoRoot),
      "rev-parse",
      "--is-inside-work-tree",
    ).pipe(
      Effect.mapError(() => new GitUnavailable({ detail: "git CLI not found — install git" })),
    );
    if (workTree.exitCode !== 0 || workTree.stdout.trim() !== "true") {
      return yield* new GitUnavailable({ detail: `not a git work tree: ${repoRoot}` });
    }
    if (Either.isLeft(origin)) {
      return yield* new GitUnavailable({
        detail: "no 'origin' remote configured — git remote add origin <url>",
      });
    }
    const rows = [ok("git", "work tree ok, 'origin' remote present")];
    if (urlEmbedsUserinfo(origin.right)) {
      rows.push(
        warn(
          "git-remote",
          "origin URL embeds userinfo (credentials) on an http(s) scheme — every process reading it can see the token; use a credential helper instead",
        ),
      );
    }
    return rows;
  });

// 6. gh: CLI present and authenticated — needed for PR creation.
//
// `forgeRepo` is the same resolution the dispatch itself makes (T39), off the
// one origin read `doctor.ts` shares with probe 5 — reported here rather than
// re-derived, so a green row states which repo this dispatch would act on.
// `None` names no forge, deliberately: probe 5 already carries the reason
// (no work tree, no origin, or a remote this parse cannot read an owner and a
// name out of), and repeating it here would be a second answer to the
// question that probe owns.
export const ghProbe = (
  forgeRepo: Option.Option<RepoSlug>,
): Effect.Effect<ReadonlyArray<ProbeRow>, GhUnavailable, CommandExecutor> =>
  Effect.gen(function* () {
    const status = yield* exec("gh", "auth", "status").pipe(
      Effect.mapError(
        () => new GhUnavailable({ detail: "CLI not found — install: https://cli.github.com" }),
      ),
    );
    if (status.exitCode !== 0) {
      return yield* new GhUnavailable({ detail: "not authenticated — run `gh auth login`" });
    }
    const target = Option.match(forgeRepo, {
      onNone: () => "repo unresolved — see the git probe",
      onSome: (repo) => `will act on ${repoSlugArg(repo)}`,
    });
    return [ok("gh", `CLI present, authenticated (${target})`)];
  });

// Probe 7 (config decodes) lives in doctor.ts: it reports the outcome of the
// decode the runner already performed to obtain probe subjects.

// 8. tasks dir: where one-off specs live.
export const tasksDirProbe = (
  config: BessemerConfigShape,
  repoRoot: string,
): Effect.Effect<ReadonlyArray<ProbeRow>, TasksDirMissing, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    // Shared with the dispatch spec guard (config/paths.ts): the directory a
    // bare spec name resolves under is the directory this probe checks, which
    // is why the repo root reaches both of them from the composition root.
    const dir = resolveTasksDir(repoRoot, config.tasksDir);
    const info = yield* fs.stat(dir).pipe(Effect.option);
    if (Option.isSome(info) && info.value.type === "Directory") {
      return [ok("tasks-dir", `${dir} exists`)];
    }
    return yield* new TasksDirMissing({ detail: `${dir} missing — mkdir -p ${dir}` });
  });

// 9. runtime root writable: the bessemer directory by default (T57), or
// wherever a `runtime-root` moved the writes to.
//
// Absent and unwritable are two rows, not one (T57): `.bessemer/` exists in
// this repo because `config.toml` is committed there, but an adopter whose
// config arrived by hand may have no directory at all, and `mkdir` is the fix
// for that where `chmod` is the fix for the other. One detail covering both
// sends half the readers to the wrong command. Nothing below creates it: the
// ledger appends to `<runtimeRoot>/runs.jsonl` directly, so the directory has
// to be there before the first dispatch, and this row is where a host is told.
export const runtimeRootProbe = (
  config: BessemerConfigShape,
): Effect.Effect<ReadonlyArray<ProbeRow>, RuntimeRootUnwritable, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const present = yield* fs.exists(config.runtimeRoot).pipe(Effect.orElseSucceed(() => false));
    if (!present) {
      return yield* new RuntimeRootUnwritable({
        detail: `${config.runtimeRoot} is missing — locks, logs, and checkouts land here; mkdir -p ${config.runtimeRoot}`,
      });
    }
    const writable = yield* fs.access(config.runtimeRoot, { writable: true }).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
    if (!writable) {
      return yield* new RuntimeRootUnwritable({
        detail: `${config.runtimeRoot} is not writable — locks, logs, and checkouts land here; fix its permissions`,
      });
    }
    return [ok("runtime-root", `${config.runtimeRoot} writable`)];
  });

// 10. dispatcher freshness: is this dispatcher's source missing commits its
// configured base already has? Scoped to a named source set, not the package
// directory (T42, T49) — this repo also holds docs/, and a whole-repo check
// would go amber on every doc commit that lands on the base. `warn`, never
// `fail`: a dev sitting on a feature branch that is merely behind its base is
// the ordinary state of a repo mid-stack, and going red for it would take
// doctor red on every dispatch mid-stack. T44's preflight asks the identical
// question and refuses instead — different jobs.
//
// The argv and the verdict are `dispatcher-freshness.ts`'s, not restated
// here: two callers ask this question and neither may answer it differently.
// No `Git` tag (see the file header) — `exec` directly, like every probe
// beside it.
export const dispatcherFreshnessProbe = (
  repoRoot: string,
  base: string,
): Effect.Effect<ReadonlyArray<ProbeRow>, never, CommandExecutor> =>
  Effect.gen(function* () {
    // An unresolvable base by construction: nothing configured to compare
    // against, reached without spending a git call to find that out. A
    // config that decodes to an empty `base` is a row this probe writes, not
    // a crash (T40 dropped `base`'s code default).
    if (base.trim() === "") {
      return [
        warn(
          "dispatcher-freshness",
          "no 'base' configured — this check has nothing to compare this dispatcher's source against; set 'base' in config.toml",
        ),
      ];
    }
    const result = yield* exec(
      "git",
      ...repoArgs(repoRoot),
      ...dispatcherFreshnessArgs(repoRoot, base),
    ).pipe(Effect.orElseSucceed(() => ({ exitCode: 1, stdout: "", stderr: "" })));
    const verdict = readDispatcherFreshness(result);
    switch (verdict._tag) {
      case "Current":
        return [ok("dispatcher-freshness", `this dispatcher's source is current with '${base}'`)];
      case "Stale":
        return [
          warn(
            "dispatcher-freshness",
            `missing ${verdict.missing.length} source commit(s) already on '${base}' (e.g. ${verdict.missing[0]}) — merge or rebase '${base}' in before dispatching`,
          ),
        ];
      case "BaseUnresolvable":
        return [
          warn(
            "dispatcher-freshness",
            `'${base}' does not resolve in this clone — git fetch to update it, or check the configured base`,
          ),
        ];
    }
  });

// Probe 10's other arm (T60): when this dispatch is not self-hosted there is
// nothing to be stale relative to — the dispatcher is a pinned SHA and no
// branch of the served repo chooses it (09) — so the question is not asked and
// no `rev-list` is spent. It is an `ok` row that says plainly that nothing was
// compared, never a silent pass: an unchecked check that evaporates into a
// bare green row is the failure mode T30 named, and a `warn` here would be the
// always-on warning 19 §4 measured, with new words.
//
// The revision is the dispatcher's own (T43's `resolveDispatcherRevision`),
// resolved at the composition root and handed in as the `Option` it already
// is: a read that came back empty renders as unknown, the way `status`'s
// dispatcher column renders an absent one, and marks a dirty source the same
// way.
export const dispatcherPinnedRow = (
  dispatcherRevision: Option.Option<DispatcherRevision>,
): ProbeRow =>
  ok(
    "dispatcher-freshness",
    `not applicable — dispatcher pinned at ${revisionLabel(dispatcherRevision)}: this dispatch serves another repo, and no branch of it chooses the dispatcher`,
  );

// The pin as a row names it: the release it is, or that it is none, with
// the SHA cut to the length the roots row's revision has.
const shortSha = (sha: string): string => sha.slice(0, 7);

const pinLabel = (releases: ReadonlyArray<Release>, pin: string): string =>
  Option.match(releaseAt(releases, pin), {
    onNone: () => `pinned ${shortSha(pin)} (no release)`,
    onSome: (release) => `pinned ${release.tag} (${shortSha(pin)})`,
  });

// F14: the running revision is not the pin under a hand clone, which is why
// both readers exist. Compared in full, never by abbreviation. A revision
// that could not be read is said to be unknown rather than left out — the
// clause is a check, and a check that did not run says so.
const runningClause = (
  pin: string,
  dispatcherRevision: Option.Option<DispatcherRevision>,
): ReadonlyArray<string> =>
  Option.match(dispatcherRevision, {
    onNone: () => ["running revision unknown, not compared with the pin"],
    onSome: (running) => (running.sha === pin ? [] : [`running ${running.revision}, not the pin`]),
  });

// 11. upstream (T129, P6 F14 and F15): which release this repo is pinned
// to, and the latest one `origin` has — off the same `ls-remote` `upgrade`
// makes (T122), with the pin read by T121's one grammar out of the served
// repo's `config.toml`. **Always `ok`**: it is advice about what an adopter
// could move to, and an offline host, a slow remote, or a pin the grammar
// refuses is a row that says what it could not compare — never a `warn`, and
// never a change to `doctor`'s exit code. Probe 7 and the shim are what say
// how to fix a refused pin; this row names which refusal it was.
//
// Self-hosted there is no pin to read — the checked-out branch chooses this
// repo's dispatcher (F8) — so no `ls-remote` is spent. And it is
// `doctor`-only: the dispatch preflight does not import it, so no dispatch
// waits on the network for advice.
export const upstreamProbe = (host: {
  readonly repoRoot: string;
  readonly packageRepoRoot: string;
  readonly selfHosted: boolean;
  readonly dispatcherRevision: Option.Option<DispatcherRevision>;
}): Effect.Effect<ProbeRow, never, CommandExecutor | FileSystem.FileSystem> =>
  Effect.gen(function* () {
    if (host.selfHosted) {
      return ok(
        "upstream",
        "not applicable — self-hosted: the checked-out branch chooses this repo's dispatcher, and there is no pin to read",
      );
    }
    const fs = yield* FileSystem.FileSystem;
    // An unreadable or absent file has no pin line, which is the grammar's
    // own answer for it — probe 7 says what is wrong with the file itself.
    const text = yield* fs
      .readFileString(join(bessemerDir(host.repoRoot), CONFIG_FILENAME))
      .pipe(Effect.orElseSucceed(() => ""));
    const pin = pinIn(text);
    const releases = yield* Effect.either(readRemoteReleases(host.packageRepoRoot));
    if (Either.isLeft(releases)) {
      const pinned = Either.match(pin, {
        onLeft: (refusal) => `pin refused (${refusal._tag})`,
        onRight: (sha) => `pinned ${shortSha(sha)}`,
      });
      return ok(
        "upstream",
        `${pinned}; nothing compared — git ls-remote origin: ${releases.left.detail}`,
      );
    }
    const latest = Option.match(latestRelease(releases.right), {
      onNone: () => "no release upstream",
      onSome: (release) => `latest ${release.tag}`,
    });
    const clauses = Either.match(pin, {
      onLeft: (refusal) => [`pin refused (${refusal._tag})`, latest],
      onRight: (sha) => [
        pinLabel(releases.right, sha),
        latest,
        ...runningClause(sha, host.dispatcherRevision),
      ],
    });
    return ok("upstream", clauses.join("; "));
  });
