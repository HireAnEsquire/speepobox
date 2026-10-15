#!/usr/bin/env node
// CLI entrypoint. NodeRuntime.runMain is the only place an effect is run
// (Effect.runPromise is grep-banned); everything else composes and returns
// effects.
import { NodeRuntime } from "@effect/platform-node";
import { resolve } from "node:path";
import { Effect, Either, Layer, Option } from "effect";
import { resolveCredential } from "./agent/credential.ts";
import { appBaseLiveFor, appLayerFor, appLiveFor, isModifiersOnly, modifiersFor } from "./app.ts";
import { speepoboxDir, findRepoRoot, packageRoot, templatesRoot } from "./config/paths.ts";
import { peelRepoRoot } from "./config/served-repo.ts";
import { dispatchCli } from "./dispatch/command.ts";
import { isAnswerMissing } from "./dispatch/guards.ts";
import { type DispatchFailure, renderFailure } from "./dispatch/render.ts";
import { doctor } from "./doctor/doctor.ts";
import { exitCodeFor } from "./exit-code.ts";
import { gc } from "./gc/gc.ts";
import { imageBuild } from "./image/build.ts";
import { resolveForgeRepo } from "./forge/forge.ts";
import { init } from "./init/init.ts";
import { logs } from "./logs/logs.ts";
import { resolveDispatcherRevision, toDispatcher } from "./git/dispatcher-revision.ts";
import { readHeadReleases } from "./git/releases.ts";
import { IssueStoreLive } from "./issues/issue-store.ts";
import { RunLockLive } from "./lock/run-lock.ts";
import { pickerArgv } from "./picker/picker.ts";
import { type Seed, seedOf } from "./picker/seed.ts";
import { PromptClackLive } from "./prompt/clack.ts";
import { SandboxLive } from "./sandbox/sandbox.ts";
import { status } from "./status/status.ts";
import { upgrade } from "./upgrade/upgrade.ts";

const usage = `speepobox — AFK agent dispatcher (ADR 0007)

Usage:
  speepobox <spec> --branch <name> [--base <ref>]
                      dispatch an AFK run. A bare <spec> resolves under the
                      tasks dir; anything with a slash is a path used as-is
  speepobox --resume <branch>
                      re-dispatch <branch> off the ledger: the spec, the base,
                      and the identity come back off its newest record
  speepobox --last    --resume on the most recently recorded branch
  speepobox ... --dry-run
                      rehearse: every guard, the resolved plan, and the
                      mutations this run would have made — no lock, no
                      container, no checkout, no PR, no ledger row
  speepobox ... --feedback "<what to change>"
                      extra dispatcher instructions for this run. On a --resume
                      whose recorded spec is gone, the feedback is the work
                      order and the run revises the branch's PR
  speepobox --repo-root <dir> ...
                      the repo this invocation serves, on any command here —
                      status and doctor included. The committed shim always
                      passes it; without it, the repo the package itself
                      lives in
  speepobox           no arguments, on a terminal: pick the spec and the branch,
                      read back the command line they spell, and dispatch it.
                      Off a terminal, this text
  speepobox status    read-only: what's running, what just finished, where the
                      PRs are. Always exit 0; each half degrades on its own
  speepobox logs <branch> [--follow]
                      read-only: the path and contents of <branch>'s newest run
                      log. --follow keeps printing what the run appends while
                      it is live, and exits when it ends. Exit 1 if there is
                      no log
  speepobox doctor    read-only preflight: eleven probes, exit 1 on any FAIL,
                      exit 0 on warnings
  speepobox gc [--force]
                      read-only: what this host holds from speepobox runs, and
                      what --force would do with each item. Logs are never
                      deleted. Exit 0
  speepobox init [--base <ref>] [--image <tag>] [--refresh]
                      write the scaffold into .speepobox/: only files that are
                      absent, each reported wrote or kept, then the next steps
                      where a file was written.
                      The base defaults to origin/HEAD, the image to the repo
                      directory's name, tool-sha to this package's revision.
                      --refresh also overwrites each file that is behind its
                      template and unedited, reported refreshed
  speepobox init --diff
                      read-only: which scaffold files this package's templates
                      would change, never counting your own edits. Exit 1 if
                      any is missing or behind, or the shim is not executable
  speepobox upgrade [--to vN]
                      move .speepobox/config.toml's tool-sha pin to the newest
                      release, or to the one --to names (rollbacks included).
                      Rewrites that one line, then runs the shim's
                      init --refresh so the new release refreshes the
                      scaffold (not on a rollback). Commits nothing
  speepobox image build
                      build the configured image from .speepobox/image, labelled
                      with the inputs probe 2 checks. Exit 1 if the build fails
`;

// A refusal is one line on stderr and a nonzero exit, as bash gives
// (`!! <detail>`) — never a Cause dump. `@effect/cli`'s own validation errors
// render as None: the parser printed its help doc already.
const reportFailure = (error: DispatchFailure): Effect.Effect<void> =>
  Effect.sync(() => {
    const line = renderFailure(error);
    if (Option.isSome(line)) {
      process.stderr.write(`${line.value}\n`);
    }
    process.exitCode = 1;
  });

// status, logs, doctor, gc, init, and upgrade are intercepted before flag
// parsing and before any preflight (03 §1.1): they must work when the thing
// they inspect is broken, so they run on the read-only slice of appLiveFor.
// The dispatch surface (T3+) is what gets the full appLiveFor.
const main = (fullArgv: ReadonlyArray<string>): Effect.Effect<void> => {
  // `--repo-root` is peeled first, before the switch below (19 §1): `status`
  // and `doctor` are intercepted here and never reach `@effect/cli`, so a flag
  // read by the parser would be a flag two of the three commands cannot see.
  // It is the one argv read that precedes parsing, and everything downstream
  // — the switch, `appLayerFor`, `dispatchCli` — sees the peeled argv.
  const peeled = peelRepoRoot(fullArgv);
  if (Either.isLeft(peeled)) {
    return reportFailure(peeled.left);
  }
  const argv = peeled.right.argv;
  // The repo root is a host read, so it happens here and arrives as a
  // parameter — a read buried in a command would turn its tests into a report
  // on whichever machine ran them. Every command that resolves a relative read
  // location or hashes the ownership label takes this one answer. The flag
  // names the served repo outright; with none, the fallback is the repo the
  // package itself lives in — the self-hosted case, which is this repo.
  //
  // That second root is walked once and named, because three of the answers
  // here are about it rather than about the served repo: the fallback, the
  // predicate under it, and the dispatcher's own revision.
  const packageRepoRoot = findRepoRoot(packageRoot);
  const repoRoot = Option.getOrElse(peeled.right.repoRoot, () => packageRepoRoot);
  // Whether this dispatch serves the repo the package lives in, decided once
  // here and handed down as a value (T60) so the preflight and `doctor` cannot
  // disagree. `resolve` on both sides: a trailing slash or a `..` segment in
  // the flag's value must not make two spellings of one directory look like
  // two directories, and it reads nothing for an absolute path — which the
  // peel has already refused anything else.
  //
  // One caveat, recorded so it is not rediscovered (19 §4): if 01's fallback
  // — a bundled `npm publish` — is ever taken, a copy under `node_modules`
  // would walk up to the *served* repo's `.git` and answer true here, and this
  // predicate has to be revisited then. It cannot happen today: node refuses
  // to strip `.ts` under `node_modules`, and the shim's cache clone carries
  // its own `.git`, so the walk stops there.
  const selfHosted = resolve(packageRepoRoot) === resolve(repoRoot);
  // Whether stdin is a terminal (T94), read once here — the one `process.stdin`
  // read in the package — and handed to every composition, whose `Terminal`
  // answers `isTTY` from it and from stdout together. A prompt needs a
  // terminal at both ends: bash gates each one on `[ -t 0 ]` (`run.sh:752`),
  // and the platform's own answer is stdout's alone.
  const stdinIsTTY = Boolean(process.stdin.isTTY);
  // The dispatcher's uid and gid, for `image build`'s `AGENT_UID` /
  // `AGENT_GID` (T111): the image's agent user is the dispatcher, so the clone
  // it writes stays theirs on the host. Host reads, so they are made here. A
  // platform with no uid at all (Windows) has no bind-mount ownership to
  // match, and the conventional first user stands in.
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;
  // The dispatch surface, taken as **words** rather than as this invocation's
  // argv: the picker's product is argv too (T81), so a picked run and a typed
  // one go through the one call — every guard, the `--repo-root` peel that has
  // already happened, and `VALUE_OPTION_NAMES` are the same for both.
  const dispatchWords = (words: ReadonlyArray<string>): Effect.Effect<void> =>
    // The agent credential is a host read like the repo root, so it happens
    // here and travels down as a parameter (T23):
    // `<repoRoot>/.speepobox/.env` — the file beside `config.toml` that
    // probe 3's advice names, in the **served repo** and never in the
    // package (T58) — then the process environment, resolved by the same
    // module probe 3 reports on, which `doctor` hands the same root.
    // It is deliberately *not* read where the container starts: that is
    // how the run came to answer this question differently from `doctor`,
    // and how a token sitting exactly where it was asked for reached nothing.
    // The absent case is refused by a guard, before the lock.
    //
    // The dispatcher's own revision is the same kind of host read (T43),
    // and it is asked of `packageRepoRoot` rather than of `repoRoot` — the
    // two are one directory exactly when
    // `selfHosted` is true, which is the name that coincidence now has, and
    // staying off it is what keeps this correct under the shim, where
    // `repoRoot` names somebody else's repo.
    //
    // The forge repo is `repoRoot`'s own read, and the opposite of the
    // dispatcher revision's: it is a fact about the repo this run dispatches
    // *for* (T39), so it asks `repoRoot` rather than the dispatcher's own
    // enclosing repo — the served repo is whose `origin` a `gh --repo`
    // argument has to name.
    Effect.all({
      credential: resolveCredential(speepoboxDir(repoRoot)),
      dispatcherRevision: resolveDispatcherRevision(packageRepoRoot),
      forgeRepo: resolveForgeRepo(repoRoot),
    }).pipe(
      Effect.flatMap(({ credential, dispatcherRevision, forgeRepo }) =>
        dispatchCli(
          words,
          repoRoot,
          selfHosted,
          credential,
          Option.map(dispatcherRevision, toDispatcher),
          forgeRepo,
        ),
      ),
      // The one place `--dry-run` is consulted (T15): the rehearsal is the
      // same dispatch against a layer whose mutating services record. Every
      // guard, the plan, and the ordering below are the ones a real run
      // gets, and no dispatch op knows which layer it is on.
      Effect.provide(appLayerFor(words, repoRoot, stdinIsTTY)),
      // A command line missing an answer (T86): the picker, seeded with what
      // it did say, unless `--no-input` says never to ask. Off a terminal the
      // picker answers `None` and the refusal is reported as it always was.
      Effect.catchIf(isAnswerMissing, (missing) =>
        Option.match(seedOf(missing), {
          onNone: () => reportFailure(missing),
          onSome: (seed) => picked(modifiersFor(missing.request), reportFailure(missing), seed),
        }),
      ),
      Effect.catchAll(reportFailure),
    );
  // The picker, and what it picked (T81). The gate is inside `pickerArgv` —
  // `Terminal.isTTY`, which the compositions answer from stdin and stdout
  // together (T94) — so `None` is "nobody is there" and `offTTY` is what
  // this invocation did before the picker existed.
  //
  // It runs on the read-only slice plus a prompt and the issue store — the
  // issues step reads a feature folder at the branch tip (T83) — since it
  // reads the ledger, git, and that folder and acquires nothing; the words it
  // answers with then run under `appLayerFor` like any dispatch, which is
  // why that provide is inside `dispatchWords` and this one stops at the
  // picker. `appBaseLiveFor` is untouched, so `status` and `doctor` acquire
  // no prompt; a dispatch gets its own from `appLiveFor`, for `--hard-reset`'s
  // confirm (T102).
  //
  // A seed is what a command line missing an answer already said (T86).
  const picked = (
    modifiers: ReadonlyArray<string>,
    offTTY: Effect.Effect<void>,
    seed?: Seed,
  ): Effect.Effect<void> =>
    pickerArgv({ repoRoot, modifiers, ...(seed === undefined ? {} : { seed }) }).pipe(
      Effect.provide(
        Layer.provideMerge(
          Layer.merge(PromptClackLive, IssueStoreLive),
          appBaseLiveFor(repoRoot, stdinIsTTY),
        ),
      ),
      Effect.flatMap(Option.match({ onNone: () => offTTY, onSome: dispatchWords })),
      // A cancelled picker is one line and an exit 1, through the renderer
      // every other refusal goes through (`!! picker cancelled`).
      Effect.catchAll(reportFailure),
    );
  switch (argv[0]) {
    case "status":
      return status({ repoRoot }).pipe(Effect.provide(appBaseLiveFor(repoRoot, stdinIsTTY)));
    // logs parses its own words (`logs/argv.ts`) and reads files only (T151):
    // the read-only slice as `status` gets it, so a malformed `config.toml`
    // falls back to the committed defaults and the log is still found.
    case "logs":
      return logs({ argv: argv.slice(1) }).pipe(
        Effect.provide(appBaseLiveFor(repoRoot, stdinIsTTY)),
        Effect.catchAll(reportFailure),
      );
    // gc parses its own words (`gc/argv.ts`), and a refusal — an unknown flag,
    // either of `--force`'s two refusals, or a removal that failed — is one
    // line through the renderer every other refusal uses. The read-only slice
    // plus the two tags `--force` needs, provided here as the picker's are
    // (T100, D8): `appBaseLiveFor` stays the read-only slice, and a malformed
    // `config.toml` still degrades the listing rather than killing it.
    case "gc":
      return gc({ repoRoot, argv: argv.slice(1) }).pipe(
        Effect.provide(
          Layer.provideMerge(
            Layer.merge(RunLockLive, SandboxLive),
            appBaseLiveFor(repoRoot, stdinIsTTY),
          ),
        ),
        Effect.catchAll(reportFailure),
      );
    // `image build` is on the dispatch surface (T111): it reads `image` off
    // `SpeepoboxConfig`, so a config that does not decode stops it at layer
    // build as it stops a dispatch, and it gets the one `appLiveFor`. Its
    // words are its own (`image/build.ts`), and `--dry-run` is not one of
    // them.
    case "image":
      return imageBuild({ repoRoot, argv: argv.slice(1), uid, gid }).pipe(
        Effect.provide(appLiveFor(repoRoot, stdinIsTTY)),
        Effect.catchAll(reportFailure),
      );
    // init parses its own words (`init/argv.ts`) and writes the scaffold (T114).
    // It runs on the read-only slice, whose config layer is the tolerant one:
    // there is no config to decode yet, so an absent or broken `config.toml`
    // cannot stop the command that writes it (E9). The templates root is a
    // package read, so it is handed down from here, and so is the package's
    // revision, which `tool-sha` pins (T115), and the releases on its `HEAD`,
    // which say whether that pin is a release (T124) — a read that fails is
    // `None`, and says nothing. `--diff` (T116) answers how many files
    // drifted, and any is exit 1, as a doctor FAIL is.
    case "init":
      return Effect.all({
        dispatcherRevision: resolveDispatcherRevision(packageRepoRoot),
        headReleases: Effect.option(readHeadReleases(packageRepoRoot)),
      }).pipe(
        Effect.flatMap(({ dispatcherRevision, headReleases }) =>
          init({
            repoRoot,
            argv: argv.slice(1),
            selfHosted,
            templatesRoot,
            dispatcherRevision,
            headReleases,
          }),
        ),
        Effect.flatMap((drifted) =>
          Effect.sync(() => {
            if (drifted > 0) {
              process.exitCode = 1;
            }
          }),
        ),
        Effect.provide(appBaseLiveFor(repoRoot, stdinIsTTY)),
        Effect.catchAll(reportFailure),
      );
    // upgrade parses its own words (`upgrade/argv.ts`) and moves the pin
    // (T128). Beside `init`, before any config decode: it reads the pin by
    // T121's grammar, never through `SpeepoboxConfig`, so the read-only slice
    // is enough. The releases are asked of the package's own repo, whose
    // `origin` is the release URL under the shim.
    case "upgrade":
      return upgrade({ repoRoot, argv: argv.slice(1), selfHosted, packageRepoRoot }).pipe(
        Effect.provide(appBaseLiveFor(repoRoot, stdinIsTTY)),
        Effect.catchAll(reportFailure),
      );
    case "doctor":
      // The dispatcher's own revision is resolved for this screen as well as
      // for the dispatch surface below (T43): probe 10's not-applicable arm
      // names it, the roots row prints it beside the package's location, and
      // an empty read renders as unknown in both rather than failing.
      //
      // The credential is resolved here too, for the reason it is resolved
      // here for a dispatch (T23): it is a host read, and `doctor` asks it
      // **once** for the whole screen (T62) — the roots row names where it
      // came from and probe 3 reports whether there is one. `packageRoot`
      // travels the same way, because `doctor.ts` may not import it (19 §8).
      return Effect.all({
        credential: resolveCredential(speepoboxDir(repoRoot)),
        dispatcherRevision: resolveDispatcherRevision(packageRepoRoot),
      }).pipe(
        Effect.flatMap(({ credential, dispatcherRevision }) =>
          doctor({
            nodeVersion: process.versions.node,
            repoRoot,
            packageRoot,
            packageRepoRoot,
            selfHosted,
            dispatcherRevision,
            credential,
          }),
        ),
        Effect.flatMap((failures) =>
          Effect.sync(() => {
            if (failures > 0) {
              process.exitCode = 1;
            }
          }),
        ),
        Effect.provide(appBaseLiveFor(repoRoot, stdinIsTTY)),
      );
    // No arguments: the picker on a terminal, and this text off one, exactly
    // as before (SPEC §7's *no args on a TTY* row). The gate and every step
    // live in `picker/picker.ts` — nothing in this file is assertable
    // (AGENTS.md) — and what comes back is argv, handed to the dispatch above
    // as if it had been typed.
    case undefined:
      return picked(
        [],
        Effect.sync(() => {
          process.stdout.write(usage);
        }),
      );
    // Everything else is the dispatch surface, and it is the first consumer of
    // the full appLiveFor: a malformed config kills a dispatch here, at
    // startup, where the two commands above degrade instead.
    //
    // An argv of nothing but modifiers arrives here with a word in `argv[0]`
    // and is **no dispatch at all** (`app.ts`, bash's `run.sh:752`): on a
    // terminal it is the picker, with the modifier riding through onto the
    // words that come back and onto the command line the summary prints. Off
    // one it falls through to the dispatch and is refused there — bash's own
    // fall-through, and what this invocation did before the picker existed.
    default:
      return isModifiersOnly(argv) ? picked(argv, dispatchWords(argv)) : dispatchWords(argv);
  }
};

// SIGHUP — a closed terminal tab — must tear the run down like Ctrl-C does
// (SPEC §4's signal table, where it is the row bash gets wrong). Measured in
// T4 rather than assumed: `NodeRuntime.runMain` registers SIGINT and SIGTERM
// and *not* SIGHUP (@effect/platform-node-shared's runtime.js), so on a hangup
// node's default action kills the process and every finalizer is skipped —
// the lock survives, exactly the leak the port exists to close.
//
// This re-raises the signal runMain already listens for instead of adding a
// handler that tears down: there stays exactly one teardown path, and the
// finalizers reach it the same way they reach Ctrl-C. T7 owns the full
// four-path matrix and its live proof.
process.on("SIGHUP", () => {
  process.kill(process.pid, "SIGINT");
});

NodeRuntime.runMain(main(process.argv.slice(2)), {
  // The default teardown exits 0 on success, stomping the exit code doctor
  // set; honor process.exitCode instead. Real failures still exit 1, and an
  // interrupted run exits 130 — the mapping is `exit-code.ts`'s, because this
  // file runs the CLI on import and so cannot be asserted from a test.
  teardown: (exit, onExit) => {
    onExit(exitCodeFor(exit, process.exitCode));
  },
});
