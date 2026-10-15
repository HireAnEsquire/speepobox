// `gc` (SPEC §7, P4): what this host holds from speepobox runs, and what
// `gc --force` would do with each piece of it. The listing changes nothing and
// exits 0 — including when dockerd will not answer, where it lists what the
// disk holds and says liveness went unverified.
//
// It is one of the three commands intercepted before flag parsing and before
// any preflight, and it runs on `appBaseLiveFor` plus the two tags `--force`
// acts with: a malformed `config.toml` degrades the listing to the committed
// defaults rather than stopping the command a dispatcher reaches for when the
// host is in a mess — and `--force` refuses over it (D8).
//
// What is listed is the reconciler's own scan (T97) and its own
// classification (`wreckage.ts`), never a second set of per-class rules the
// way bash's `collect_gc_items` has: ownership is by label, liveness is
// `classify`'s, and a checkout no lock lies beside is `Kept` — which bash
// listed as a deletable orphan. The WOULD column says "salvage then remove"
// for every checkout, never "remove": `--force` removes one only when the
// salvage says the commits in it are somewhere else (`force.ts`, T100).
//
// Beside them, the leftovers the reconciler never acts on (T108): claim temp
// files, scratch indexes, and editor session directories. Those are gc's own
// read, each judged by a witness its name carries and never by its age.
//
// The listing writes nothing to the runtime root and runs no git. Its one
// subprocess is `ownedSandboxes`'s label-filtered `docker ps -a`, inside the
// scan.
import { FileSystem, Path } from "@effect/platform";
import type { CommandExecutor } from "@effect/platform/CommandExecutor";
import type { PlatformError } from "@effect/platform/Error";
import { Clock, Effect, Either, Option } from "effect";
import { SpeepoboxConfig, loadConfig } from "../config/config.ts";
import { LOCKS_DIRNAME, LOGS_DIRNAME, lockPathFor } from "../dispatch/plan.ts";
import type { Git } from "../git/git.ts";
import { isProcessAlive, ownerIsAlive } from "../lock/liveness.ts";
import type { RunLock } from "../lock/run-lock.ts";
import { EDIT_MARKER, editorDirPid } from "../prompt/editor.ts";
import { readLockOnDisk } from "../reconcile/lock-on-disk.ts";
import { scanWreckage, type WreckageScan } from "../reconcile/reconcile.ts";
import { classify, type RunWreckage, WITNESS_SUFFIX } from "../reconcile/wreckage.ts";
import { Reporter } from "../reporter.ts";
import type { Sandbox } from "../sandbox/sandbox.ts";
import { GcRefused, parseGcArgv } from "./argv.ts";
import { reclaimAll } from "./force.ts";
import { parseClaimName } from "./names.ts";
import type {
  GcLeftover,
  GcLogs,
  GcResource,
  GcResourceKind,
  GcSlug,
  GcSnapshot,
  GcVerdict,
  GcWitness,
  Measure,
} from "./snapshot.ts";

const measured = (value: number): Measure => ({ _tag: "Measured", value });
const UNMEASURED: Measure = { _tag: "Unmeasured" };
const NOT_APPLICABLE: Measure = { _tag: "NotApplicable" };

// What `--force` would do with one resource of a slug, decided by the slug's
// verdict (T99 §2). A `Kept` slug never has a lock (a lock beside it makes it
// `Reclaimable` or `Live`), and never a running container (that is `Live`),
// so the container it can carry is a stopped one.
export const wouldFor = (verdict: GcVerdict, kind: GcResourceKind): string => {
  if (verdict._tag === "Live") {
    return `skip — ${verdict.detail}`;
  }
  switch (kind) {
    case "container":
      return verdict._tag === "Kept" ? "remove the stopped container" : "remove the container";
    case "checkout":
      return "salvage then remove";
    case "lock":
      return "reclaim the lock";
  }
};

// Which slug a witness is evicting for, off its name alone:
// `<slug>.pid.<dead pid>.evicting`. The listing is for a reader, so a name
// that does not have that shape is shown whole rather than dropped.
export const slugOfWitness = (name: string): string => {
  const lockAndPid = name.endsWith(WITNESS_SUFFIX) ? name.slice(0, -WITNESS_SUFFIX.length) : name;
  const lockFile = lockAndPid.slice(0, Math.max(lockAndPid.lastIndexOf("."), 0));
  const slug = lockFile.slice(0, Math.max(lockFile.lastIndexOf("."), 0));
  return slug === "" ? name : slug;
};

const INDEX_SUFFIX = ".index";

const isNotFound = (error: PlatformError): boolean =>
  error._tag === "SystemError" && error.reason === "NotFound";

// The listing's value over a scan already taken: `--force` lists and then
// acts on the one scan, so what it acts on is what it listed (T100).
const snapshotOf = (
  scan: WreckageScan,
): Effect.Effect<
  GcSnapshot,
  never,
  SpeepoboxConfig | Reporter | FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const config = yield* SpeepoboxConfig;
    const reporter = yield* Reporter;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    // An entry that cannot be stat'd, or whose `mtime` the platform does not
    // report, is `?` and never a failed listing.
    const ageOf = (file: string): Effect.Effect<Measure> =>
      fs.stat(file).pipe(
        Effect.map((info) =>
          Option.match(info.mtime, {
            onNone: () => UNMEASURED,
            onSome: (mtime) => measured(mtime.getTime()),
          }),
        ),
        Effect.orElseSucceed(() => UNMEASURED),
      );

    // bash's `_dir_size`: the regular files under the directory, summed. A
    // file that vanishes mid-walk drops out of the sum, as bash's does; a
    // directory that cannot be walked at all is `?`.
    const sizeOf = (dir: string): Effect.Effect<Measure> =>
      fs.readDirectory(dir, { recursive: true }).pipe(
        Effect.flatMap((entries) =>
          Effect.reduce(entries, 0, (total, entry) =>
            fs.stat(path.join(dir, entry)).pipe(
              Effect.map((info) => (info.type === "File" ? total + Number(info.size) : total)),
              Effect.orElseSucceed(() => total),
            ),
          ),
        ),
        Effect.map(measured),
        Effect.orElseSucceed(() => UNMEASURED),
      );

    const resourcesOf = (
      found: RunWreckage,
      verdict: GcVerdict,
    ): Effect.Effect<Array<GcResource>> =>
      Effect.all([
        // A container is not an entry on this disk: no age of its own here,
        // and no size, exactly as bash lists one.
        Effect.succeed(
          Option.map(found.sandbox, (): GcResource => ({
            kind: "container",
            modifiedAt: NOT_APPLICABLE,
            size: NOT_APPLICABLE,
            would: wouldFor(verdict, "container"),
          })),
        ),
        Option.match(found.checkout, {
          onNone: () => Effect.succeedNone,
          onSome: (checkout) =>
            Effect.all({ modifiedAt: ageOf(checkout.path), size: sizeOf(checkout.path) }).pipe(
              Effect.map(({ modifiedAt, size }): Option.Option<GcResource> =>
                Option.some({
                  kind: "checkout",
                  modifiedAt,
                  size,
                  would: wouldFor(verdict, "checkout"),
                }),
              ),
            ),
        }),
        Option.match(found.lock, {
          onNone: () => Effect.succeedNone,
          onSome: (lock) =>
            ageOf(lock.path).pipe(
              Effect.map((modifiedAt): Option.Option<GcResource> =>
                Option.some({
                  kind: "lock",
                  modifiedAt,
                  size: NOT_APPLICABLE,
                  would: wouldFor(verdict, "lock"),
                }),
              ),
            ),
        }),
      ]).pipe(Effect.map((resources) => resources.flatMap(Option.toArray)));

    const slugs = yield* Effect.forEach(scan.wreckage, (found): Effect.Effect<GcSlug> => {
      const verdict: GcVerdict = classify(found);
      return Effect.map(resourcesOf(found, verdict), (resources) => ({
        slug: found.slug,
        verdict,
        resources,
      }));
    });

    const witnesses = yield* Effect.forEach(scan.stranded, (witness): Effect.Effect<GcWitness> =>
      Effect.map(ageOf(witness.path), (age) => ({
        path: witness.path,
        slug: slugOfWitness(path.basename(witness.path)),
        modifiedAt: age,
      })),
    );

    // The leftovers (T108): gc's own read and not the reconciler's scan, which
    // never acts on these and so does not carry them. A directory that is not
    // there holds nothing; one that cannot be read is said, and lists nothing.
    const entriesOf = (dir: string): Effect.Effect<ReadonlyArray<string>> =>
      fs.readDirectory(dir).pipe(
        Effect.map((entries) => entries.toSorted()),
        Effect.catchIf(isNotFound, () => Effect.succeed<ReadonlyArray<string>>([])),
        Effect.catchAll((error) =>
          reporter
            .emit({
              _tag: "Warned",
              detail: `could not read ${dir} (${error.message}) — no leftovers under it are listed`,
            })
            .pipe(Effect.as<ReadonlyArray<string>>([])),
        ),
      );

    const leftover = (
      kind: GcLeftover["kind"],
      file: string,
      slug: Option.Option<string>,
      state: GcLeftover["state"],
    ): Effect.Effect<GcLeftover> =>
      Effect.map(ageOf(file), (modifiedAt) => ({ kind, path: file, slug, modifiedAt, state }));

    // Whether a slug's lock names a live owner, through the reconciler's own
    // read (`readLockOnDisk`): a lock that is absent or unreadable names nobody.
    const lockIsLive = (slug: string): Effect.Effect<boolean, never, FileSystem.FileSystem> =>
      Effect.map(readLockOnDisk(lockPathFor(config.runtimeRoot, slug)), (lock) =>
        Option.exists(lock, ({ owner }) => ownerIsAlive(owner)),
      );

    const locksDir = path.join(config.runtimeRoot, LOCKS_DIRNAME);
    const lockEntries = yield* entriesOf(locksDir);

    // A claim is dead when the attempt that wrote it is: its pid is in its
    // name, and the claim removes its own temp file on every path it lives
    // through.
    const claims = yield* Effect.forEach(
      lockEntries.flatMap((entry) =>
        Option.toArray(
          Option.flatMap(parseClaimName(entry), ({ lockFile, pid }) => {
            const slug = lockFile.slice(0, Math.max(lockFile.lastIndexOf("."), 0));
            return slug !== "" &&
              path.basename(lockPathFor(config.runtimeRoot, slug)) === lockFile &&
              !isProcessAlive(pid)
              ? Option.some({ entry, slug })
              : Option.none();
          }),
        ),
      ),
      ({ entry, slug }) => leftover("claim", path.join(locksDir, entry), Option.some(slug), "dead"),
    );

    // An index is only ever written under its slug's lock (`land.ts`), so it
    // is dead when that lock has no live owner.
    const indexes = yield* Effect.forEach(
      lockEntries.filter(
        (entry) => entry.endsWith(INDEX_SUFFIX) && entry.length > INDEX_SUFFIX.length,
      ),
      (entry) => {
        const slug = entry.slice(0, -INDEX_SUFFIX.length);
        return Effect.flatMap(lockIsLive(slug), (live) =>
          live
            ? Effect.succeedNone
            : Effect.asSome(
                leftover("index", path.join(locksDir, entry), Option.some(slug), "dead"),
              ),
        );
      },
    ).pipe(Effect.map((found) => found.flatMap(Option.toArray)));

    // An editor session directly under the runtime root, dead when the pid in
    // its name is not alive, and unwitnessed when it is from before the name
    // carried one — nothing can say whose it was, so it is a human's to judge.
    const editors = yield* Effect.forEach(
      (yield* entriesOf(config.runtimeRoot)).filter((entry) => entry.includes(EDIT_MARKER)),
      (entry) =>
        Effect.gen(function* () {
          const dir = path.join(config.runtimeRoot, entry);
          const state: Option.Option<GcLeftover["state"]> = Option.match(editorDirPid(entry), {
            onNone: () => Option.some("unwitnessed"),
            onSome: (pid) => (isProcessAlive(pid) ? Option.none() : Option.some("dead")),
          });
          const isDirectory = yield* fs.stat(dir).pipe(
            Effect.map((info) => info.type === "Directory"),
            Effect.orElseSucceed(() => false),
          );
          return Option.isSome(state) && isDirectory
            ? Option.some(yield* leftover("editor", dir, Option.none(), state.value))
            : Option.none();
        }),
    ).pipe(Effect.map((found) => found.flatMap(Option.toArray)));

    const leftovers = [...claims, ...indexes, ...editors];

    // Every `<slug>-<runId>.log` directly under `logs/` (`logPathFor`), one
    // line for all of them. A directory that is not there is a host that has
    // not logged a run yet; one that cannot be read is said, and counted as
    // unknown rather than as empty.
    const logsDir = path.join(config.runtimeRoot, LOGS_DIRNAME);
    const logs: GcLogs = yield* fs.readDirectory(logsDir).pipe(
      Effect.map((entries) => entries.filter((entry) => entry.endsWith(".log"))),
      Effect.flatMap((names) =>
        Effect.forEach(names, (name) =>
          fs.stat(path.join(logsDir, name)).pipe(Effect.map((info) => Number(info.size))),
        ).pipe(
          Effect.map((sizes) => measured(sizes.reduce((total, size) => total + size, 0))),
          Effect.orElseSucceed(() => UNMEASURED),
          Effect.map((bytes) => ({ count: names.length, bytes })),
        ),
      ),
      Effect.catchIf(isNotFound, () => Effect.succeed({ count: 0, bytes: measured(0) })),
      Effect.catchAll((error) =>
        reporter
          .emit({
            _tag: "Warned",
            detail: `could not read ${logsDir} (${error.message}) — the logs line below counts nothing`,
          })
          .pipe(Effect.as({ count: 0, bytes: UNMEASURED })),
      ),
    );

    const renderedAt = yield* Clock.currentTimeMillis;

    return {
      daemonAnswered: Option.isSome(scan.containers),
      slugs,
      witnesses,
      leftovers,
      logs,
      renderedAt,
    };
  });

// The listing's value, gathered and not yet rendered.
export const gcSnapshot = (
  repoRoot: string,
): Effect.Effect<
  GcSnapshot,
  never,
  SpeepoboxConfig | Reporter | CommandExecutor | FileSystem.FileSystem | Path.Path
> => Effect.flatMap(scanWreckage(repoRoot), snapshotOf);

export interface GcOptions {
  // Resolved at the composition root: the label the container query filters
  // on, and the served repo whose runtime root is listed.
  readonly repoRoot: string;
  // The words after `gc`.
  readonly argv: ReadonlyArray<string>;
}

export const gc = (
  options: GcOptions,
): Effect.Effect<
  void,
  GcRefused,
  | Sandbox
  | RunLock
  | Git
  | SpeepoboxConfig
  | Reporter
  | CommandExecutor
  | FileSystem.FileSystem
  | Path.Path
> =>
  Effect.gen(function* () {
    const parsed = parseGcArgv(options.argv);
    if (Either.isLeft(parsed)) {
      return yield* parsed.left;
    }
    const reporter = yield* Reporter;
    const scan = yield* scanWreckage(options.repoRoot);
    const snapshot = yield* snapshotOf(scan);
    yield* reporter.emit({ _tag: "GcReported", snapshot });
    if (!parsed.right.force) {
      return;
    }

    // The two refusals (§1), after the listing and before anything is
    // touched. A daemon that did not answer leaves every container's
    // liveness unverified (`run.sh:570-573`).
    if (Option.isNone(scan.containers)) {
      return yield* new GcRefused({
        detail:
          "gc --force refused: dockerd could not be asked, so container liveness cannot be verified — nothing was removed",
      });
    }
    // And a config that does not decode (D8): the listing above ran on the
    // committed defaults, whose runtime root may not be the one this repo's
    // runs wrote, so acting on it could act on the wrong directory's locks.
    // Decoded once, as `doctor`'s probe 7 does.
    const decoded = yield* Effect.either(loadConfig(options.repoRoot));
    if (Either.isLeft(decoded)) {
      const firstLine = decoded.left.detail.split("\n")[0] ?? "";
      return yield* new GcRefused({
        detail: `gc --force refused: config.toml does not decode (${firstLine}) — the listing above is against the committed defaults, and nothing was removed`,
      });
    }

    const failures = yield* reclaimAll(options.repoRoot, scan, snapshot.leftovers);
    if (failures > 0) {
      return yield* new GcRefused({
        detail: `gc --force could not remove ${failures} item${failures === 1 ? "" : "s"} — each is named above with what to run by hand`,
      });
    }
  });
