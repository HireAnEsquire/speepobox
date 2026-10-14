// T62, and 19 §8's second layer: **the tool serving a repo it does not live
// in.** Rooted, `repoRoot` and `packageRoot` are one directory in this
// checkout, so every other case in this suite is blind to a conflation between
// them by construction — a probe, a plan, or a mount that resolved against the
// package would be right here and wrong under the clone-run shim, where the
// package is a cache clone every served repo shares. This file is the one
// place the two roots are different directories, and what it asserts is the
// positive form: **every served-repo read lands under the scratch repo.**
//
// "Nothing was read from the package" is not the assertion and is not true:
// the package's own default prompts are a legitimate package read, and so is
// the dispatcher's revision. Both are named where they happen below.
//
// **No `GIT_DIR`, `GIT_WORK_TREE`, `GIT_COMMON_DIR`, `GIT_INDEX_FILE`, or any
// other git location variable is exported here or in anything this file
// calls.** `GIT_DIR` plus `git init` rewrites the real `.git/config` of
// whatever repository the test process is standing in — this one. The scratch
// repo is addressed with `-C` and with paths, the way every other case in this
// suite addresses one.
//
// git and the filesystem are real (`test/dispatcher-freshness.test.ts` is the
// precedent): which directory a read lands in is the whole subject, and a
// faked git would answer whatever a fixture said rather than what a repository
// does. docker and `gh` are scripted through the executor
// `test/doctor.test.ts` already builds — this container has neither.
//
// The dispatch stack below is `appDryRunLiveFor` spelled out over that
// executor rather than imported, for the reason `test/dry-run.test.ts` spells
// its two stacks out: the seam has to be the `CommandExecutor`, and `Git` and
// `Forge` capture theirs when their layer is *built*, so an executor provided
// over the finished composition would reach the dispatch's own reads and not
// theirs. Every term is `app.ts`'s, including `speepoboxConfigLiveFor` and
// `promptSourceLiveFor` at the scratch repo — which is the point: the config,
// the prompts, and the runtime root all come from the repo being served.
import { describe, expect, it } from "@effect/vitest";
import { CommandExecutor, FileSystem, Terminal } from "@effect/platform";
import { SystemError } from "@effect/platform/Error";
import { NodeContext, NodeFileSystem, NodePath } from "@effect/platform-node";
import { Effect, Either, Layer, Option, Ref, type Scope } from "effect";
import { resolveCredential } from "../src/agent/credential.ts";
import { promptSourceLiveFor } from "../src/agent/prompt-source.ts";
import { speepoboxConfigLiveFor } from "../src/config/config.ts";
import { speepoboxDir, findRepoRoot, packageRoot } from "../src/config/paths.ts";
import { dispatchCli } from "../src/dispatch/command.ts";
import { dispatch } from "../src/dispatch/dispatch.ts";
import { checkoutPathFor, logPathFor, slugFor } from "../src/dispatch/plan.ts";
import { doctor } from "../src/doctor/doctor.ts";
import { AgentCliRecordingLive } from "../src/dry-run/agent-cli.ts";
import { ForgeRecordingLive } from "../src/dry-run/forge.ts";
import { GitRecordingLive } from "../src/dry-run/git.ts";
import { LedgerRecordingLive } from "../src/dry-run/ledger.ts";
import { IssueStoreRecordingLive } from "../src/dry-run/issue-store.ts";
import { NotifierRecordingLive } from "../src/dry-run/notifier.ts";
import { PromptRecordingLive } from "../src/dry-run/prompt.ts";
import { RunLockRecordingLive } from "../src/dry-run/run-lock.ts";
import { SandboxRecordingLive } from "../src/dry-run/sandbox.ts";
import { resolveForgeRepo } from "../src/forge/forge.ts";
import { GitLive } from "../src/git/git.ts";
import { exec } from "../src/internal/exec.ts";
import { Reporter, type ReporterEvent } from "../src/reporter.ts";
import { SPEC_TARGET } from "../src/sandbox/spec.ts";
import { fakeProcess, type ScriptedResult } from "./support/exec-fake.ts";

// The branch this dispatch is for, and the one that is checked out instead —
// the branch guard refuses dispatching the branch the served repo currently
// has out, so the scratch repo stands on a third one.
const BRANCH = "speepobox-t62";
const CHECKED_OUT = "holding";
const BASE = "main";
const SPEC = "T62";
const IMAGE = "served-speepobox";
// The forge guard reads `origin`, and since T70 every dispatch fetches it —
// which is the one git command this world answers from the table rather than
// running, because it is the one that would leave the host.
const ORIGIN = "https://github.com/acme/served-repo.git";
// A throwaway, in the scratch repo's own `.speepobox/.env` — which is where a
// served repo's credential lives (T58) and what the roots row names. It is
// never printed by anything, which is asserted.
const TOKEN = "speepobox-t62-scratch-token";
// The dispatcher's own revision: a package fact, resolved at the composition
// root against the repo the *package* lives in, and one of the two legitimate
// package reads this file names.
const REVISION = "abc1234";
const OVERRIDE = "# TASK\n\nthe served repo's own implement prompt\n";

// Real git, scripted everything else. `git` is passed through to the platform
// executor because the scratch repository is real; every other binary is
// answered from the table, so nothing here depends on a docker daemon or an
// authenticated `gh`. Every argv either half spawns lands in `recorded`, which
// is what makes "no freshness `rev-list` ran" an assertion rather than a hope.
//
// **The table is consulted first, git included** (T70). One git command this
// world cannot run is the dispatch's `git fetch origin`: this repo's `origin`
// is a GitHub URL, which the fake tier does not reach and which nothing here
// is about. It is scripted by its whole argv, so every *other* git command —
// which is every command this file's assertions are about — still runs against
// the real scratch repository.
const realGitScriptedRest = (
  script: Record<string, ScriptedResult>,
  recorded: Ref.Ref<ReadonlyArray<string>>,
): Layer.Layer<CommandExecutor.CommandExecutor, never, CommandExecutor.CommandExecutor> =>
  Layer.effect(
    CommandExecutor.CommandExecutor,
    Effect.map(CommandExecutor.CommandExecutor, (real) =>
      CommandExecutor.makeExecutor((command) => {
        if (command._tag !== "StandardCommand") {
          return Effect.die("piped commands are not expected here");
        }
        const rendered = [command.command, ...command.args].join(" ");
        return Ref.update(recorded, (current) => [...current, rendered]).pipe(
          Effect.flatMap(() => {
            const match = Object.entries(script).find(([prefix]) => rendered.startsWith(prefix));
            if (match !== undefined) {
              return Effect.succeed(fakeProcess(match[1]));
            }
            return command.command === "git"
              ? real.start(command)
              : Effect.fail(
                  new SystemError({
                    reason: "NotFound",
                    module: "Command",
                    method: "spawn",
                    description: `ENOENT: ${rendered}`,
                  }),
                );
          }),
        );
      }),
    ),
  );

// The dispatch's own fetch (T70), named by its whole argv — the repo it runs
// in and the remote it names — so nothing else this world spawns is answered
// by it. Exit 0 with nothing on either stream is a fetch against a remote that
// had nothing new, which is what this repo's refs are.
const fetchesOrigin = (repo: string): string =>
  `git -C ${repo} --git-dir=${repo}/.git fetch origin`;

// The repo enclosing the package, as bin.ts computes it.
const packageRepoRoot = findRepoRoot(packageRoot);

const script: Record<string, ScriptedResult> = {
  "docker info": { exit: 0 },
  // Neither label, which is the undeclared image: an `ok` row that says
  // staleness is unchecked (T30).
  "docker image inspect": { exit: 0, stdout: "\n" },
  // The reconciler's ownership query — nothing of this repo's is running.
  "docker ps": { exit: 0, stdout: "" },
  "gh auth status": { exit: 0 },
};

// The served repo: a real repository in a temporary directory, holding
// everything a served repo holds and nothing the package holds. The commit
// exists because a branch has to point at something; the second branch is
// checked out because the branch guard refuses the one that is.
const servedRepo: Effect.Effect<
  string,
  never,
  FileSystem.FileSystem | CommandExecutor.CommandExecutor | Scope.Scope
> = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const repo = yield* fs.makeTempDirectoryScoped();
  const git = (...args: ReadonlyArray<string>) => exec("git", "-C", repo, ...args);

  yield* exec("git", "init", "-q", "-b", BASE, repo);
  // The identity the run's clone would carry, declared in the repo so the
  // dispatch's own read of it answers rather than falling back to the host
  // user (T35).
  yield* git("config", "user.email", "scratch@example.com");
  yield* git("config", "user.name", "Scratch");
  yield* fs.makeDirectory(`${repo}/tasks`, { recursive: true });
  yield* fs.writeFileString(`${repo}/tasks/${SPEC}.md`, `# ${SPEC}\n\nthe task\n`);
  // The speepobox directory, which is everything speepobox keeps in a served
  // repo (19 §2): the committed config, the prompt override, and — written
  // after the commit, because it is the one file that is never committed —
  // the credential.
  yield* fs.makeDirectory(`${speepoboxDir(repo)}/prompts`, { recursive: true });
  yield* fs.writeFileString(
    `${speepoboxDir(repo)}/config.toml`,
    // A local ref as the base: this repo has no remote-tracking refs, and
    // `resolveBaseSha` refuses a base it cannot resolve.
    `image = "${IMAGE}"\nbase = "${BASE}"\n`,
  );
  yield* fs.writeFileString(`${speepoboxDir(repo)}/prompts/implement.md`, OVERRIDE);
  yield* git("add", "-A");
  yield* git("commit", "-q", "-m", "the served repo");
  yield* git("branch", BRANCH);
  yield* git("checkout", "-q", "-b", CHECKED_OUT);
  yield* git("remote", "add", "origin", ORIGIN);
  yield* fs.writeFileString(`${speepoboxDir(repo)}/.env`, `CLAUDE_CODE_OAUTH_TOKEN=${TOKEN}\n`);
  return repo;
}).pipe(Effect.orDie);

const refReporter = Effect.map(Ref.make<ReadonlyArray<ReporterEvent>>([]), (events) => ({
  events,
  layer: Layer.succeed(Reporter, {
    emit: (event: ReporterEvent) => Ref.update(events, (current) => [...current, event]),
  }),
}));

// The parser's `Terminal`, never reached: nothing here prompts.
const stubTerminal: Terminal.Terminal = {
  columns: Effect.succeed(80),
  rows: Effect.succeed(24),
  isTTY: Effect.succeed(false),
  readInput: Effect.die("a dispatch never reads the terminal"),
  readLine: Effect.die("a dispatch never reads the terminal"),
  display: () => Effect.void,
};

const probeRows = (events: ReadonlyArray<ReporterEvent>) =>
  events.flatMap((event) => (event._tag === "ProbeChecked" ? [event] : []));

const intents = (events: ReadonlyArray<ReporterEvent>): ReadonlyArray<string> =>
  events.flatMap((event) => (event._tag === "MutationRecorded" ? [event.detail] : []));

describe("doctor, on a repo the package does not live in", () => {
  it.scoped("says which roots it is reporting against, and probes only the served one", () =>
    Effect.gen(function* () {
      const repo = yield* servedRepo;
      const { events, layer } = yield* refReporter;
      const commands = yield* Ref.make<ReadonlyArray<string>>([]);
      // Probe 11 asks the package repo's `origin` for its releases (T129):
      // scripted, because that origin is the real release URL and this suite
      // leaves the host for nothing.
      const executor = Layer.provide(
        realGitScriptedRest(
          {
            ...script,
            [`git -C ${packageRepoRoot} --git-dir=${packageRepoRoot}/.git ls-remote`]: {
              exit: 0,
              stdout: "",
            },
          },
          commands,
        ),
        NodeContext.layer,
      );
      // The composition root's two reads, made here because that is where they
      // are made (AGENTS.md): the credential against the **served repo's**
      // speepobox directory, and the package's own location handed down as a
      // value — `doctor.ts` may not import it (19 §8).
      const credential = yield* resolveCredential(speepoboxDir(repo)).pipe(
        Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
      );

      const failures = yield* doctor({
        nodeVersion: "26.0.0",
        repoRoot: repo,
        packageRoot,
        packageRepoRoot,
        selfHosted: false,
        dispatcherRevision: Option.some({
          sha: REVISION.padEnd(40, "0"),
          revision: REVISION,
          dirty: false,
        }),
        credential,
      }).pipe(
        Effect.provide(
          Layer.provideMerge(
            GitLive,
            Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, executor, layer),
          ),
        ),
      );

      const rows = probeRows(yield* Ref.get(events));
      // The row that would have made the ticket's own probe run readable
      // (19 §8): both roots, the config that was read, where the credential
      // came from, and the answer to the question the other rows depend on.
      expect(rows[0]?.probe).toBe("roots");
      expect(rows[0]?.status).toBe("ok");
      expect(rows[0]?.detail).toBe(
        `serving ${repo}; package ${packageRoot} at ${REVISION}; config ${repo}/.speepobox/config.toml; credential from ${repo}/.speepobox/.env; not self-hosted`,
      );
      // The credential came out of the served repo's own file — the token is
      // in it, and no row says so.
      for (const row of rows) {
        expect(row.detail).not.toContain(TOKEN);
      }
      const row = (probe: string) => rows.find((candidate) => candidate.probe === probe);
      expect(row("credential")?.detail).toBe(
        `CLAUDE_CODE_OAUTH_TOKEN set from ${repo}/.speepobox/.env (value not shown)`,
      );
      expect(row("tasks-dir")?.detail).toContain(`${repo}/tasks`);
      expect(row("runtime-root")?.detail).toContain(`${repo}/.speepobox`);
      // Probe 10 is not asked at all when the dispatcher serves another repo
      // (T60), so no `rev-list` is spent and the row says what it did not
      // compare.
      expect(row("dispatcher-freshness")?.detail).toContain("not applicable");
      expect((yield* Ref.get(commands)).filter((command) => command.includes("rev-list"))).toEqual(
        [],
      );
      // Probe 11 reads the pin out of the served repo's config — which pins
      // nothing here — and asks the package repo for releases (T129).
      expect(row("upstream")?.status).toBe("ok");
      expect(row("upstream")?.detail).toBe("pin refused (NoLine); no release upstream");
      // And the positive form of the whole file: the package is named in the
      // roots row, which is what that row is for, and nowhere else.
      for (const other of rows.slice(1)) {
        expect(other.detail).not.toContain(packageRoot);
      }
      expect(failures).toBe(0);
    }).pipe(Effect.provide(NodeContext.layer)),
  );
});

// The rehearsal's world: the scratch repo, a ref-backed `Reporter`, the
// scripted executor, and `app.ts`'s `appDryRunLiveFor` spelled out over them
// term for term — same nine recording layers, same `speepoboxConfigLiveFor`
// and `promptSourceLiveFor`, both rooted at the served repo.
const rehearsalWorld = Effect.gen(function* () {
  const repo = yield* servedRepo;
  const { events, layer } = yield* refReporter;
  const commands = yield* Ref.make<ReadonlyArray<string>>([]);
  const executor = Layer.provide(
    realGitScriptedRest({ ...script, [fetchesOrigin(repo)]: { exit: 0 } }, commands),
    NodeContext.layer,
  );
  const platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, executor, layer);
  const base = Layer.provideMerge(speepoboxConfigLiveFor(repo), platform);
  const rehearsal = Layer.provideMerge(
    AgentCliRecordingLive,
    Layer.provideMerge(
      Layer.mergeAll(
        SandboxRecordingLive,
        GitRecordingLive,
        RunLockRecordingLive,
        ForgeRecordingLive,
        NotifierRecordingLive,
        IssueStoreRecordingLive,
        promptSourceLiveFor(repo),
        PromptRecordingLive,
      ),
      Layer.provideMerge(LedgerRecordingLive, base),
    ),
  );
  // The two host reads a dispatch is handed, made where bin.ts makes them and
  // asked of the **served** repo: the credential out of its speepobox
  // directory, and the forge repo off its own `origin`.
  const credential = yield* resolveCredential(speepoboxDir(repo)).pipe(
    Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
  );
  const forgeRepo = yield* resolveForgeRepo(repo).pipe(
    Effect.provide(Layer.provideMerge(GitLive, platform)),
  );
  return { repo, events, commands, rehearsal, credential, forgeRepo };
});

describe("a rehearsal of a repo the package does not live in", () => {
  it.scoped("resolves every served-repo path under the served repo", () =>
    Effect.gen(function* () {
      const { repo, events, commands, rehearsal, credential, forgeRepo } = yield* rehearsalWorld;

      const outcome = yield* Effect.either(
        dispatchCli(
          [SPEC, "--branch", BRANCH, "--dry-run"],
          repo,
          false,
          credential,
          Option.some({ revision: REVISION, dirty: false }),
          forgeRepo,
        ).pipe(Effect.provideService(Terminal.Terminal, stubTerminal), Effect.provide(rehearsal)),
      );

      expect(Either.isRight(outcome)).toBe(true);
      const emitted = yield* Ref.get(events);
      const resolved = emitted.find((event) => event._tag === "PlanResolved");
      const plan = resolved?._tag === "PlanResolved" ? resolved.plan : undefined;
      // The runtime root defaults to the served repo's speepobox directory
      // (T57), so every write location this run named is inside the repo it
      // serves.
      expect(plan?.task).toEqual({
        _tag: "Spec",
        path: `${repo}/tasks/${SPEC}.md`,
        feedback: Option.none(),
      });
      expect(plan?.checkoutPath).toBe(checkoutPathFor(speepoboxDir(repo), slugFor(BRANCH)));
      expect(plan?.checkoutPath.startsWith(`${repo}/.speepobox/`)).toBe(true);

      // The line docker would have been handed: the spec mounted out of the
      // served repo's tasks dir, the workspace under its speepobox directory,
      // and not one word of the package.
      const start = intents(emitted).find((detail) => detail.startsWith("start the sandbox"));
      expect(start).toContain(`-v ${repo}/tasks/${SPEC}.md:${SPEC_TARGET}:ro`);
      // Every host path docker was to bind, read off the line itself: the
      // workspace and the spec, both under the served repo. The *targets* are
      // the container's own directories and are deliberately not compared —
      // `/workspace` inside the container is not this package's location, and
      // a substring test against the whole line would say it was.
      const words = (start ?? "").split(" ");
      const mountSources = words.flatMap((word, index) =>
        words[index - 1] === "-v" ? [word.slice(0, word.indexOf(":"))] : [],
      );
      expect(mountSources).toEqual([plan?.checkoutPath, `${repo}/tasks/${SPEC}.md`]);
      for (const source of mountSources) {
        expect(source.startsWith(`${repo}/`)).toBe(true);
      }
      // Nor the token: the credential crosses by name (T23), and this
      // rehearsal resolved a real one out of the served repo's `.env`.
      expect(start).not.toContain(TOKEN);

      // The override took, and the log says so as the client's (T14, T59): the
      // file is `<repo>/.speepobox/prompts/implement.md` and nothing in the
      // package is named `implement.md`'s equal here. The review and
      // description passes fall through to the package's own defaults, which
      // is the package read this file does not object to.
      const assembled = emitted.flatMap((event) =>
        event._tag === "PromptAssembled" ? [event] : [],
      );
      const implement = assembled.find((event) => event.pass === "implement");
      expect(implement?.root).toBe("client");
      expect(implement?.prompt).toContain("the served repo's own implement prompt");
      expect(assembled.find((event) => event.pass === "review")?.root).toBe("package");

      // The freshness question is not asked on a dispatch that is not
      // self-hosted (T60), which is what keeps the pathspec from leaving the
      // served repo: the package's own paths are not this repo's paths.
      const spawned = yield* Ref.get(commands);
      expect(spawned.filter((command) => command.includes("rev-list HEAD.."))).toEqual([]);
      // Every git command this rehearsal spent was asked of the served repo or
      // of the copy it would have made under it.
      for (const spawn of spawned.filter((command) => command.startsWith("git "))) {
        expect(spawn).toContain(repo);
      }
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  // The one write the layer swap does not reach (T15, AGENTS.md): the run log
  // is a plain `FileSystem` write, so a dispatch that keeps one really opens
  // the file. `--dry-run` keeps none at all (T48), so this case is the same
  // dispatch over the same recording layers with `keepsLog` set the way a real
  // run sets it — which is what makes "the file lands in the served repo"
  // assertable without a daemon.
  it.scoped("opens its run log inside the served repo and nowhere under the package", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { repo, events, rehearsal, credential, forgeRepo } = yield* rehearsalWorld;

      const outcome = yield* Effect.either(
        dispatch(
          {
            spec: Option.some(SPEC),
            branch: Option.some(BRANCH),
            base: Option.none(),
            resume: Option.none(),
            last: false,
            feedback: Option.none(),
            feedbackEdit: false,
            task: Option.none(),
            feature: Option.none(),
            issues: Option.none(),
            allowStaleDispatcher: false,
            hardReset: false,
            keepsLog: true,
          },
          repo,
          false,
          credential,
          Option.some({ revision: REVISION, dirty: false }),
          forgeRepo,
        ).pipe(Effect.provideService(Terminal.Terminal, stubTerminal), Effect.provide(rehearsal)),
      );

      expect(Either.isRight(outcome)).toBe(true);
      const resolved = (yield* Ref.get(events)).find((event) => event._tag === "PlanResolved");
      const plan = resolved?._tag === "PlanResolved" ? resolved.plan : undefined;
      const logPath = Option.getOrElse(plan?.logPath ?? Option.none(), () => "");
      expect(logPath).toBe(logPathFor(speepoboxDir(repo), plan?.runId ?? ""));
      expect(yield* fs.exists(logPath)).toBe(true);
      // And not beside the package, which under the shim is a cache clone
      // every served repo shares — one run's log there would be every
      // adopter's.
      expect(yield* fs.exists(logPathFor(speepoboxDir(packageRoot), plan?.runId ?? ""))).toBe(
        false,
      );
      // The log is a record of the run, and the token is not part of it.
      expect(yield* fs.readFileString(logPath)).not.toContain(TOKEN);
    }).pipe(Effect.provide(NodeContext.layer)),
  );
});
