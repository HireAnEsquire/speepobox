import { describe, expect, it } from "@effect/vitest";
import { FileSystem, Path } from "@effect/platform";
import { NodeContext, NodeFileSystem, NodePath } from "@effect/platform-node";
import { ConfigProvider, Effect, Either, Layer, Option, Redacted, Ref } from "effect";
import { type AgentCredential, resolveCredential } from "../src/agent/credential.ts";
import { defaultConfig } from "../src/config/config.ts";
import { bessemerDir, findRepoRoot, packagePathspec, packageRoot } from "../src/config/paths.ts";
import { doctor } from "../src/doctor/doctor.ts";
import {
  credentialProbe,
  dispatcherFreshnessProbe,
  gitProbe,
  imageProbe,
  inputsDigest,
  nodeMajor,
  nodeProbe,
  parseDeclaredInputs,
  rootsRow,
  runtimeRootProbe,
  upstreamProbe,
} from "../src/doctor/probes.ts";
import { renderProbeRow } from "../src/doctor/render.ts";
import type { DispatcherRevision } from "../src/git/dispatcher-revision.ts";
import { GitLive } from "../src/git/git.ts";
import { exec } from "../src/internal/exec.ts";
import { Reporter, type ReporterEvent } from "../src/reporter.ts";
import { type ScriptedResult, scriptedExecutor } from "./support/exec-fake.ts";
import { repoWithNestedDir } from "./support/nested-dir.ts";

// The origin read now goes through `Git`'s `inRepo`, exactly like every other
// operation on the tag (T39) — `-C <repo> --git-dir=<repo>/.git`, not the bare
// `-C` the probe used to shell on its own.
const inRepo = (repo: string): string => `git -C ${repo} --git-dir=${repo}/.git`;

const refReporter = Effect.gen(function* () {
  const events = yield* Ref.make<ReadonlyArray<ReporterEvent>>([]);
  const layer = Layer.succeed(Reporter, {
    emit: (event) => Ref.update(events, (current) => [...current, event]),
  });
  return { events, layer };
});

// doctor's own host fact, read the way bin.ts reads it: probe 8 resolves the
// configured tasks dir under it, probe 2 compares the image against files
// under it, and probe 5 asks git about *it* rather than about the working
// directory — so every git entry below names it (T27). `--show-toplevel` is
// gone with the second answer it used to be.
const REPO_ROOT = findRepoRoot(packageRoot);

const allGreenScript: Record<string, ScriptedResult> = {
  "docker info": { exit: 0 },
  // An image carrying neither label: the undeclared row, which is `ok` (T30) —
  // so this fixture no longer dates the image in the future to keep probe 2
  // green on every host. The four states probe 2 can be in are pinned against
  // fixture files in "image probe" below, where the labels are the input.
  "docker image inspect": { exit: 0, stdout: "\n" },
  [`${inRepo(REPO_ROOT)} rev-parse --is-inside-work-tree`]: { exit: 0, stdout: "true\n" },
  [`${inRepo(REPO_ROOT)} remote get-url origin`]: {
    exit: 0,
    stdout: "https://github.com/acme/hae.git\n",
  },
  "gh auth status": { exit: 0 },
  // Probe 10 reads the real committed `base` (config.toml's "origin/main")
  // against the real package pathspec — current, so the "all green" fixture
  // stays green.
  [`${inRepo(REPO_ROOT)} rev-list HEAD..origin/main -- ${packagePathspec(REPO_ROOT).join(" ")}`]: {
    exit: 0,
    stdout: "",
  },
};

// The host node version is scripted like every other probe input: a real
// `process.versions.node` read would make these outcomes depend on whichever
// node runs vitest.
//
// `selfHosted` is bin.ts's own predicate (T60), decided there and handed down
// as a value — `true` is this repo's answer and every case below inherits it
// except the adopter one, which states it. Every argv a probe spends is
// recorded, which is what makes "no `rev-list` at all" an assertion.
const runDoctor = (
  script: Record<string, ScriptedResult>,
  nodeVersion = "26.0.0",
  host: {
    readonly selfHosted?: boolean;
    readonly packageRepoRoot?: string;
    readonly dispatcherRevision?: DispatcherRevision;
    readonly credential?: Option.Option<AgentCredential>;
  } = {},
) =>
  Effect.gen(function* () {
    const { events, layer } = yield* refReporter;
    const commands = yield* Ref.make<ReadonlyArray<string>>([]);
    // The credential is resolved here because bin.ts resolves it there (T62):
    // `doctor` is handed one answer for the whole screen, so the roots row and
    // probe 3 report on the same credential and the run makes one resolver
    // call. The canary below is what that resolution finds.
    const resolved = yield* resolveCredential(bessemerDir(REPO_ROOT)).pipe(
      Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
    );
    // The repo root is doctor's other host fact, and probe 8 resolves the
    // configured tasks dir under it — this is the same walk bin.ts does, so the
    // probe looks at the directory a real dispatch would.
    const failures = yield* doctor({
      nodeVersion,
      repoRoot: REPO_ROOT,
      // The package's own location, which bin.ts hands down and this file
      // imports (the ban is scoped to `src/`): rooted, it is REPO_ROOT, and
      // `test/roots.test.ts` is where the two are different directories.
      packageRoot,
      packageRepoRoot: host.packageRepoRoot ?? REPO_ROOT,
      selfHosted: host.selfHosted ?? true,
      dispatcherRevision:
        host.dispatcherRevision === undefined
          ? Option.none()
          : Option.some(host.dispatcherRevision),
      credential: host.credential ?? resolved,
    }).pipe(
      Effect.provide(
        Layer.provideMerge(
          GitLive,
          Layer.mergeAll(
            NodeFileSystem.layer,
            NodePath.layer,
            scriptedExecutor(script, commands),
            layer,
          ),
        ),
      ),
    );
    // doctor emits probe rows and nothing else; narrowing here keeps the
    // assertions below on the arm they are about.
    const emitted = yield* Ref.get(events);
    return {
      failures,
      events: emitted.filter((event) => event._tag === "ProbeChecked"),
      commands: yield* Ref.get(commands),
    };
  });

// The doctor tests give the process a credential so probe 3 is deterministic
// (its value must never appear in any event — asserted below).
const withCredentialCanary = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = process.env["ANTHROPIC_API_KEY"];
      process.env["ANTHROPIC_API_KEY"] = "bessemer-credential-canary";
      return previous;
    }),
    () => effect,
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) {
          delete process.env["ANTHROPIC_API_KEY"];
        } else {
          process.env["ANTHROPIC_API_KEY"] = previous;
        }
      }),
  );

describe("doctor", () => {
  it.effect("runs the eleven probes in dependency order and returns 0 when all pass", () =>
    withCredentialCanary(
      Effect.gen(function* () {
        const { failures, events } = yield* runDoctor(allGreenScript);
        expect(events.map((event) => event.probe)).toEqual([
          // The roots row heads the screen and takes no number (T62): it says
          // which repo every row below it is about.
          "roots",
          "docker",
          "image",
          "credential",
          "node",
          "git",
          "gh",
          "config",
          "tasks-dir",
          "runtime-root",
          "dispatcher-freshness",
          "upstream",
        ]);
        expect(events.every((event) => event.status === "ok")).toBe(true);
        expect(failures).toBe(0);
      }),
    ),
  );

  // Acceptance criterion (T39): a green `gh` row states which forge this
  // dispatch would act on, resolved off the same origin read probe 5 shares.
  it.effect("a green gh row names the repo it resolved", () =>
    withCredentialCanary(
      Effect.gen(function* () {
        const { events } = yield* runDoctor(allGreenScript);
        const gh = events.find((event) => event.probe === "gh");
        expect(gh?.status).toBe("ok");
        expect(gh?.detail).toContain("will act on acme/hae");
      }),
    ),
  );

  // An origin that resolves but names no owner/repo — a local path, chief
  // among them — still passes the git probe (a work tree with an 'origin'
  // remote configured, exactly what that row checks) while the slug parse
  // downstream comes back empty: the gh row says so rather than silently
  // naming a repo it never resolved.
  it.effect("gh reports the repo as unresolved when origin names no owner/repo", () =>
    withCredentialCanary(
      Effect.gen(function* () {
        const { events } = yield* runDoctor({
          ...allGreenScript,
          [`${inRepo(REPO_ROOT)} remote get-url origin`]: { exit: 0, stdout: "/srv/hae\n" },
        });
        const gh = events.find((event) => event.probe === "gh");
        expect(gh?.status).toBe("ok");
        expect(gh?.detail).toContain("repo unresolved — see the git probe");
      }),
    ),
  );

  it.effect("credential presence is reported without the value, ever", () =>
    withCredentialCanary(
      Effect.gen(function* () {
        const { events } = yield* runDoctor(allGreenScript);
        const credential = events.find((event) => event.probe === "credential");
        expect(credential?.status).toBe("ok");
        for (const event of events) {
          expect(renderProbeRow(event)).not.toContain("bessemer-credential-canary");
        }
      }),
    ),
  );

  // Acceptance criterion (T62): the row that makes the roots readable. It is
  // first, it is `ok`, and it names the five things every row below it is
  // about — rooted, the served repo and the package are one directory, which
  // is exactly why `test/roots.test.ts` runs the same row against a repo the
  // package does not live in.
  it.effect("opens with an ok roots row naming the served repo, the package, and the config", () =>
    withCredentialCanary(
      Effect.gen(function* () {
        const { events } = yield* runDoctor(allGreenScript, "26.0.0", {
          dispatcherRevision: {
            sha: "6345f52000000000000000000000000000000000",
            revision: "6345f52",
            dirty: false,
          },
          // Stated rather than resolved: which of the two places answers is a
          // fact about the host running the suite — this checkout may or may
          // not have a `.bessemer/.env` — and the row's own rendering is what
          // this case is about.
          credential: Option.some({
            name: "CLAUDE_CODE_OAUTH_TOKEN",
            value: Redacted.make("bessemer-credential-canary"),
            source: "file",
          }),
        });
        const roots = events[0];
        expect(roots?.probe).toBe("roots");
        expect(roots?.status).toBe("ok");
        expect(roots?.detail).toBe(
          `serving ${REPO_ROOT}; package ${packageRoot} at 6345f52; config ${bessemerDir(REPO_ROOT)}/config.toml; credential from ${bessemerDir(REPO_ROOT)}/.env; self-hosted`,
        );
      }),
    ),
  );

  // The canary is exported in the *environment*, so the row says so — the
  // place, and never the value, which is the rule probe 3 keeps and the reason
  // this row prints a source rather than a credential. (The committed
  // `.bessemer/.env` would win if this checkout had one, which is what the
  // case above reads; this one states the environment arm outright.)
  it("the roots row names where the credential came from, never what it is", () => {
    const environment = rootsRow({
      repoRoot: "/srv/hae",
      packageRoot: "/home/me/.cache/bessemer/abc123",
      dispatcherRevision: Option.some({
        sha: "abc1230000000000000000000000000000000000",
        revision: "abc123",
        dirty: false,
      }),
      credential: Option.some({
        name: "CLAUDE_CODE_OAUTH_TOKEN",
        value: Redacted.make("bessemer-credential-canary"),
        source: "environment",
      }),
      selfHosted: false,
    });
    expect(environment.detail).toBe(
      "serving /srv/hae; package /home/me/.cache/bessemer/abc123 at abc123; config /srv/hae/.bessemer/config.toml; credential from the environment; not self-hosted",
    );
    expect(environment.detail).not.toContain("bessemer-credential-canary");
  });

  // No credential is `none` here and a FAIL on probe 3, which is where a host
  // is told what to do about it (T23's one piece of advice). A second, shorter
  // answer in this row would be a second answer.
  it("the roots row says none when there is no credential, and unknown for an unread revision", () => {
    expect(
      rootsRow({
        repoRoot: "/srv/hae",
        packageRoot: "/srv/hae",
        dispatcherRevision: Option.none(),
        credential: Option.none(),
        selfHosted: true,
      }).detail,
    ).toBe(
      "serving /srv/hae; package /srv/hae at revision unknown; config /srv/hae/.bessemer/config.toml; credential none; self-hosted",
    );
  });

  // A dirty dispatcher is marked here the way probe 10's pinned row marks one
  // (T43): both read the one label, so the two rows of a single screen cannot
  // disagree about which dispatcher is running.
  it("the roots row marks a dirty dispatcher", () => {
    expect(
      rootsRow({
        repoRoot: "/srv/hae",
        packageRoot: "/pkg",
        dispatcherRevision: Option.some({
          sha: "6345f52000000000000000000000000000000000",
          revision: "6345f52",
          dirty: true,
        }),
        credential: Option.none(),
        selfHosted: false,
      }).detail,
    ).toContain("package /pkg at 6345f52-dirty");
  });

  // Criterion 2 (T62): one resolver call for the whole run. The screen is
  // handed a credential and reports on it — a probe that resolved again could
  // answer differently from the row above it, which is the drift T23 closed
  // between `doctor` and a dispatch and this closes inside `doctor`.
  it.effect("reports on the credential it was handed, in both rows", () =>
    withCredentialCanary(
      Effect.gen(function* () {
        const { events } = yield* runDoctor(allGreenScript, "26.0.0", {
          credential: Option.some({
            name: "ANTHROPIC_API_KEY",
            value: Redacted.make("handed-in-not-resolved"),
            source: "environment",
          }),
        });
        expect(events[0]?.detail).toContain("credential from the environment");
        const credential = events.find((event) => event.probe === "credential");
        expect(credential?.status).toBe("ok");
        expect(credential?.detail).toBe(
          "ANTHROPIC_API_KEY set from the environment (value not shown)",
        );
        for (const event of events) {
          expect(renderProbeRow(event)).not.toContain("handed-in-not-resolved");
        }
      }),
    ),
  );

  it.effect("a dead docker daemon FAILs docker and skips the image probe as a FAIL", () =>
    withCredentialCanary(
      Effect.gen(function* () {
        const { failures, events } = yield* runDoctor({
          ...allGreenScript,
          "docker info": { exit: 1 },
        });
        const byProbe = new Map(events.map((event) => [event.probe, event]));
        expect(byProbe.get("docker")?.status).toBe("fail");
        expect(byProbe.get("docker")?.detail).toContain("daemon not responding");
        expect(byProbe.get("image")?.status).toBe("fail");
        expect(byProbe.get("image")?.detail).toContain("skipped — docker unavailable");
        expect(failures).toBe(2);
      }),
    ),
  );

  it.effect("a missing docker CLI reads as CLI not found", () =>
    withCredentialCanary(
      Effect.gen(function* () {
        const script: Record<string, ScriptedResult> = { ...allGreenScript };
        delete script["docker info"];
        delete script["docker image inspect"];
        const { failures, events } = yield* runDoctor(script);
        const docker = events.find((event) => event.probe === "docker");
        expect(docker?.status).toBe("fail");
        expect(docker?.detail).toContain("CLI not found");
        expect(failures).toBe(2);
      }),
    ),
  );

  it.effect("userinfo in the origin URL is a warning, and warnings alone still exit 0", () =>
    withCredentialCanary(
      Effect.gen(function* () {
        const { failures, events } = yield* runDoctor({
          ...allGreenScript,
          [`${inRepo(REPO_ROOT)} remote get-url origin`]: {
            exit: 0,
            stdout: "https://user:token@github.com/acme/hae.git\n",
          },
        });
        const remote = events.find((event) => event.probe === "git-remote");
        expect(remote?.status).toBe("warn");
        expect(failures).toBe(0);
      }),
    ),
  );

  it.effect("an unauthenticated gh FAILs with the auth hint", () =>
    withCredentialCanary(
      Effect.gen(function* () {
        const { failures, events } = yield* runDoctor({
          ...allGreenScript,
          "gh auth status": { exit: 1 },
        });
        const gh = events.find((event) => event.probe === "gh");
        expect(gh?.status).toBe("fail");
        expect(gh?.detail).toContain("gh auth login");
        expect(failures).toBe(1);
      }),
    ),
  );

  it.effect("a host below node 26 FAILs the node probe and nothing else", () =>
    withCredentialCanary(
      Effect.gen(function* () {
        const { failures, events } = yield* runDoctor(allGreenScript, "23.7.0");
        const node = events.find((event) => event.probe === "node");
        expect(node?.status).toBe("fail");
        expect(node?.detail).toContain("need >= 26");
        expect(failures).toBe(1);
      }),
    ),
  );

  // Acceptance criterion (T60): freshness is a self-hosted question. Pointed
  // at another repo the pathspec renders `../…` and git exits 128, which read
  // as `BaseUnresolvable` and printed a false "git fetch" warning on every
  // adopter's doctor (19 §4) — so the question is not asked at all, and the
  // row says why rather than evaporating into a bare `ok`.
  it.effect("probe 10 is not applicable when this dispatch is not self-hosted", () =>
    withCredentialCanary(
      Effect.gen(function* () {
        const { failures, events, commands } = yield* runDoctor(allGreenScript, "26.0.0", {
          selfHosted: false,
          dispatcherRevision: {
            sha: "6345f52000000000000000000000000000000000",
            revision: "6345f52",
            dirty: false,
          },
        });
        const freshness = events.find((event) => event.probe === "dispatcher-freshness");
        expect(freshness?.status).toBe("ok");
        expect(freshness?.detail).toContain("not applicable — dispatcher pinned at 6345f52");
        expect(commands.filter((command) => command.includes("rev-list"))).toEqual([]);
        expect(failures).toBe(0);
      }),
    ),
  );

  // The revision is the `Option` `resolveDispatcherRevision` already hands
  // back (T43): a read that came back empty renders as unknown in the same
  // row, never as a failure and never as a fabricated sha.
  it.effect("the not-applicable row says the revision is unknown when it could not be read", () =>
    withCredentialCanary(
      Effect.gen(function* () {
        const { events } = yield* runDoctor(allGreenScript, "26.0.0", { selfHosted: false });
        const freshness = events.find((event) => event.probe === "dispatcher-freshness");
        expect(freshness?.status).toBe("ok");
        expect(freshness?.detail).toContain("dispatcher pinned at revision unknown");
      }),
    ),
  );

  // A dirty dispatcher is marked the way `status`'s dispatcher column marks
  // one (T43): the row names what is actually running, not what was pinned.
  it.effect("the not-applicable row marks a dirty dispatcher", () =>
    withCredentialCanary(
      Effect.gen(function* () {
        const { events } = yield* runDoctor(allGreenScript, "26.0.0", {
          selfHosted: false,
          dispatcherRevision: {
            sha: "6345f52000000000000000000000000000000000",
            revision: "6345f52",
            dirty: true,
          },
        });
        const freshness = events.find((event) => event.probe === "dispatcher-freshness");
        expect(freshness?.detail).toContain("pinned at 6345f52-dirty");
      }),
    ),
  );

  // The other arm is untouched: self-hosted, the probe asks git the same
  // question it always did, and its three verdicts render as they always did.
  it.effect("probe 10 asks the freshness question when self-hosted", () =>
    withCredentialCanary(
      Effect.gen(function* () {
        const { events, commands } = yield* runDoctor({
          ...allGreenScript,
          [`${inRepo(REPO_ROOT)} rev-list HEAD..origin/main -- ${packagePathspec(REPO_ROOT).join(" ")}`]:
            { exit: 0, stdout: `${"a".repeat(40)}\n` },
        });
        const freshness = events.find((event) => event.probe === "dispatcher-freshness");
        expect(freshness?.status).toBe("warn");
        expect(freshness?.detail).toContain("missing 1 source commit(s)");
        expect(commands.some((command) => command.includes("rev-list"))).toBe(true);
      }),
    ),
  );

  // Probe 11 (T129): self-hosted there is no pin, and no `ls-remote` is spent
  // finding that out.
  it.effect("probe 11 is not applicable self-hosted, and spawns no ls-remote", () =>
    withCredentialCanary(
      Effect.gen(function* () {
        const { events, commands } = yield* runDoctor(allGreenScript);
        const upstream = events.find((event) => event.probe === "upstream");
        expect(upstream?.status).toBe("ok");
        expect(upstream?.detail).toContain("not applicable — self-hosted");
        expect(commands.filter((command) => command.includes("ls-remote"))).toEqual([]);
      }),
    ),
  );

  // F15: an unreachable `origin` is an `ok` row quoting git, and the exit code
  // is whatever the other probes make it — 0 here, 1 beside a FAIL.
  it.effect("an unreachable origin is an ok row quoting git, and moves no exit code", () =>
    withCredentialCanary(
      Effect.gen(function* () {
        const unreachable = {
          ...allGreenScript,
          "git -C /srv/bessemer --git-dir=/srv/bessemer/.git ls-remote --tags origin": {
            exit: 128,
            stderr:
              "fatal: unable to access 'https://github.com/x/y.git/': Could not resolve host\n",
          },
        };
        const host = { selfHosted: false, packageRepoRoot: "/srv/bessemer" };
        const green = yield* runDoctor(unreachable, "26.0.0", host);
        const upstream = green.events.find((event) => event.probe === "upstream");
        expect(upstream?.status).toBe("ok");
        expect(upstream?.detail).toContain(
          "nothing compared — git ls-remote origin: fatal: unable to access",
        );
        expect(green.failures).toBe(0);
        const red = yield* runDoctor(unreachable, "25.0.0", host);
        expect(red.events.find((event) => event.probe === "upstream")?.status).toBe("ok");
        expect(red.failures).toBe(1);
      }),
    ),
  );
});

// The probe reports on the credential the composition root resolved and no
// longer resolves one itself (T62), so every case below asks the resolver the
// way bin.ts asks it and hands the probe the answer. What is asserted is still
// the row, and the resolution beside it is what keeps the row a report on a
// real host rather than on a literal.
describe("credential probe", () => {
  it.scoped("fails typed when no credential exists in .env or the environment", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const credential = yield* resolveCredential(root, ConfigProvider.fromMap(new Map()));
      const outcome = yield* Effect.either(credentialProbe(root, credential));
      expect(Either.isLeft(outcome)).toBe(true);
      if (Either.isLeft(outcome)) {
        expect(outcome.left._tag).toBe("CredentialMissing");
      }
    }).pipe(Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer))),
  );

  it.scoped(".env beside config.toml wins over the inherited environment", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      yield* fs.writeFileString(path.join(root, ".env"), "CLAUDE_CODE_OAUTH_TOKEN=dotenv-secret\n");
      const credential = yield* resolveCredential(root, ConfigProvider.fromMap(new Map()));
      const rows = yield* credentialProbe(root, credential);
      expect(rows[0]?.detail).toContain("CLAUDE_CODE_OAUTH_TOKEN set");
      // The row says which of the two places answered (T58): the path may
      // appear, the value never does.
      expect(rows[0]?.detail).toContain(`set from ${path.join(root, ".env")}`);
      expect(rows[0]?.detail).not.toContain("dotenv-secret");
    }).pipe(Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer))),
  );

  // The row names the variable the resolver found, because that is the one the
  // dispatch forwards into the container (T23): a probe that reported a
  // canonical name would be describing a credential the agent CLI never reads.
  it.scoped("names the variable the credential was found under, either of the two", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      yield* fs.writeFileString(path.join(root, ".env"), "ANTHROPIC_API_KEY=dotenv-secret\n");
      const credential = yield* resolveCredential(root, ConfigProvider.fromMap(new Map()));
      const rows = yield* credentialProbe(root, credential);
      expect(rows[0]?.detail).toContain("ANTHROPIC_API_KEY set");
      expect(rows[0]?.detail).not.toContain("dotenv-secret");
    }).pipe(Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer))),
  );

  // The read-only slice degrades rather than dies (AGENTS.md): a `.env` this
  // host cannot open is a probe result like any other, never a failed doctor.
  it.effect("still renders its row when .env cannot be read at all", () =>
    Effect.gen(function* () {
      const credential = yield* resolveCredential(
        "/nowhere/bessemer",
        ConfigProvider.fromMap(new Map([["CLAUDE_CODE_OAUTH_TOKEN", "from-the-shell"]])),
      );
      const rows = yield* credentialProbe("/nowhere/bessemer", credential);
      expect(rows[0]?.status).toBe("ok");
      expect(rows[0]?.detail).toContain("CLAUDE_CODE_OAUTH_TOKEN set from the environment");
    }).pipe(Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer))),
  );
});

// Probe 2's whole subject (T30): two dependency files under a scratch repo
// root, and an image whose labels declare them. The labels are the input, the
// files are the fact — no clock on either side.
const DECLARED = "api/requirements.txt,client/yarn.lock";

// The exact hex for those two files' exact contents, in that exact order. It is
// pinned rather than recomputed so the bash half that sets the label can be
// checked against a number: reproduce it with
//   printf 'api/requirements.txt %s\nclient/yarn.lock %s\n' \
//     "$(sha256sum api/requirements.txt | cut -d' ' -f1)" \
//     "$(sha256sum client/yarn.lock | cut -d' ' -f1)" | sha256sum
const DIGEST = "f853f386de37646493ded9d2a23bbcd2eafb3e2562924e0032398006cd4dc315";
// The same two files declared the other way round. A different number, which is
// what puts each path inside the digest beside its own hash.
const REVERSED_DIGEST = "8e1351b6d4e5992f9ef31d9a29a0a3de8ee09f475881a88b9c35835ecd701364";

const imageFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped();
  yield* fs.makeDirectory(path.join(root, "api"), { recursive: true });
  yield* fs.makeDirectory(path.join(root, "client"), { recursive: true });
  yield* fs.writeFileString(path.join(root, "api", "requirements.txt"), "django==6.0\n");
  yield* fs.writeFileString(path.join(root, "client", "yarn.lock"), "# yarn lockfile v1\n");
  return root;
});

// `docker image inspect` prints the two labels on two lines; an absent label is
// an empty one. Every state below is a different pair of lines.
const scriptedLabels = (inputs: string, digest: string): string => `${inputs}\n${digest}\n`;

const runImageProbe = (
  repoRoot: string,
  labels: string,
  buildCommand = ".agentbox/build-image.sh",
) =>
  Effect.gen(function* () {
    const commands = yield* Ref.make<ReadonlyArray<string>>([]);
    const rows = yield* imageProbe("hae-agentbox", repoRoot, buildCommand).pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeFileSystem.layer,
          NodePath.layer,
          scriptedExecutor({ "docker image inspect": { exit: 0, stdout: labels } }, commands),
        ),
      ),
    );
    return { rows, commands: yield* Ref.get(commands) };
  });

describe("image probe", () => {
  it.scoped("hashes the declared files in the declared order, to a pinned digest", () =>
    Effect.gen(function* () {
      const root = yield* imageFixture;
      expect(yield* inputsDigest(root, ["api/requirements.txt", "client/yarn.lock"])).toEqual(
        Option.some(DIGEST),
      );
      expect(yield* inputsDigest(root, ["client/yarn.lock", "api/requirements.txt"])).toEqual(
        Option.some(REVERSED_DIGEST),
      );
      // A declared path that is not there has no digest at all — the probe
      // turns that into a warning rather than a claim about contents.
      expect(yield* inputsDigest(root, ["api/requirements.txt", "gone.txt"])).toEqual(
        Option.none(),
      );
    }).pipe(Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer))),
  );

  // Reachable since `image` lost its code default (T40): the read-only slice
  // degrades to `defaultConfig` on a failed decode, so the probe can be handed
  // the empty string.
  it.scoped("fails by naming the key when no image is declared", () =>
    Effect.gen(function* () {
      const outcome = yield* Effect.either(imageProbe("", REPO_ROOT, "")).pipe(
        Effect.provide(
          Layer.mergeAll(
            NodeFileSystem.layer,
            NodePath.layer,
            scriptedExecutor({ "docker image inspect": { exit: 0, stdout: "\n" } }),
          ),
        ),
      );
      expect(Either.isLeft(outcome)).toBe(true);
      if (Either.isLeft(outcome)) {
        expect(outcome.left._tag).toBe("ImageUnavailable");
        expect(outcome.left.detail).toContain("image");
      }
    }),
  );

  it.scoped("matching digests are ok, and the image is never asked when it was created", () =>
    Effect.gen(function* () {
      const root = yield* imageFixture;
      const { rows, commands } = yield* runImageProbe(root, scriptedLabels(DECLARED, DIGEST));
      expect(rows[0]?.status).toBe("ok");
      expect(rows[0]?.detail).toContain("built against the current dependency files");
      // The argv itself: two labels, and no timestamp anywhere in it.
      expect(commands[0]).toContain("bessemer.inputs");
      expect(commands[0]).toContain("bessemer.inputs.digest");
      expect(commands[0]).not.toContain(".Created");
    }).pipe(Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer))),
  );

  // §1, and the whole point: git rewrites a file whenever it differs between
  // two branches, so an mtime moves on every branch hop. Contents did not.
  it.scoped("a rewrite with identical contents stays ok", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* imageFixture;
      const requirements = path.join(root, "api", "requirements.txt");
      // Rewritten byte-for-byte and dated a month on, which is what a branch
      // hop does to a file whose two versions happen to agree.
      yield* fs.writeFileString(requirements, "django==6.0\n");
      const moved = new Date("2099-01-01T00:00:00Z");
      yield* fs.utimes(requirements, moved, moved);
      expect((yield* fs.stat(requirements)).mtime).toEqual(Option.some(moved));

      const { rows } = yield* runImageProbe(root, scriptedLabels(DECLARED, DIGEST));
      expect(rows[0]?.status).toBe("ok");
    }).pipe(Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer))),
  );

  it.scoped("changed contents warn and name the configured build command", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* imageFixture;
      yield* fs.writeFileString(path.join(root, "api", "requirements.txt"), "django==6.1\n");

      const { rows } = yield* runImageProbe(
        root,
        scriptedLabels(DECLARED, DIGEST),
        "make agent-image",
      );
      expect(rows[0]?.status).toBe("warn");
      expect(rows[0]?.detail).toContain("different contents");
      expect(rows[0]?.detail).toContain("make agent-image");
    }).pipe(Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer))),
  );

  // Reordering the declaration is a change too: same bytes, different digest.
  it.scoped("a reordered declaration warns rather than colliding", () =>
    Effect.gen(function* () {
      const root = yield* imageFixture;
      const { rows } = yield* runImageProbe(
        root,
        scriptedLabels("client/yarn.lock,api/requirements.txt", DIGEST),
      );
      expect(rows[0]?.status).toBe("warn");
    }).pipe(Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer))),
  );

  it.scoped("a declared path missing from disk warns — deleting an input is not unknown", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* imageFixture;
      yield* fs.remove(path.join(root, "client", "yarn.lock"));

      const { rows } = yield* runImageProbe(root, scriptedLabels(DECLARED, DIGEST));
      expect(rows[0]?.status).toBe("warn");
      expect(rows[0]?.detail).toContain("client/yarn.lock");
    }).pipe(Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer))),
  );

  // Every image built before T30 takes this branch, so it is `ok` and not
  // `warn` — and it has to say out loud that nothing is being compared.
  it.scoped("an image declaring no inputs is ok, and says the check is not running", () =>
    Effect.gen(function* () {
      const root = yield* imageFixture;
      const { rows } = yield* runImageProbe(root, "\n", "make agent-image");
      expect(rows[0]?.status).toBe("ok");
      expect(rows[0]?.detail).toContain("declares no build inputs");
      expect(rows[0]?.detail).toContain("unchecked");
      expect(rows[0]?.detail).toContain("make agent-image");
    }).pipe(Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer))),
  );

  // The default: no repo has declared a build command, so no message may read
  // as though one is there to run. A trailing "rebuild: " would name the tool
  // as broken where the repo simply has not said anything yet.
  it.scoped("says what to do with no image-build-command configured", () =>
    Effect.gen(function* () {
      const root = yield* imageFixture;
      const undeclared = yield* runImageProbe(root, "\n", "");
      expect(undeclared.rows[0]?.status).toBe("ok");
      expect(undeclared.rows[0]?.detail).toContain("rebuild to enable it");

      const stale = yield* runImageProbe(root, scriptedLabels(DECLARED, `${"0".repeat(64)}`), "");
      expect(stale.rows[0]?.status).toBe("warn");
      expect(stale.rows[0]?.detail).toMatch(/— rebuild$/);
    }).pipe(Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer))),
  );
});

// Probe 9's two red arms (T57). They are one status and two fixes — `mkdir`
// for a root nobody has created, `chmod` for one the host will not let this
// user write — and a row that named only the second would send an adopter
// whose `.bessemer/` does not exist yet to the wrong command.
const configAt = (runtimeRoot: string) => ({ ...defaultConfig, runtimeRoot });

describe("runtime root probe", () => {
  it.scoped("is green on a writable directory, naming it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const runtimeRoot = yield* fs.makeTempDirectoryScoped();
      const rows = yield* runtimeRootProbe(configAt(runtimeRoot));
      expect(rows[0]?.status).toBe("ok");
      expect(rows[0]?.detail).toBe(`${runtimeRoot} writable`);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped("tells a host to create a runtime root that is not there", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const absent = path.join(yield* fs.makeTempDirectoryScoped(), ".bessemer");
      const outcome = yield* Effect.either(runtimeRootProbe(configAt(absent)));
      expect(Either.isLeft(outcome)).toBe(true);
      if (Either.isLeft(outcome)) {
        expect(outcome.left.detail).toContain(`${absent} is missing`);
        expect(outcome.left.detail).toContain(`mkdir -p ${absent}`);
        expect(outcome.left.detail).not.toContain("permissions");
      }
    }).pipe(Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer))),
  );

  it.scoped("tells a host to fix the permissions on one it cannot write", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const runtimeRoot = yield* fs.makeTempDirectoryScoped();
      yield* fs.chmod(runtimeRoot, 0o500);
      const outcome = yield* Effect.either(runtimeRootProbe(configAt(runtimeRoot)));
      // Restored before the scope closes, so the temp cleanup can remove it.
      yield* fs.chmod(runtimeRoot, 0o700);
      expect(Either.isLeft(outcome)).toBe(true);
      if (Either.isLeft(outcome)) {
        expect(outcome.left.detail).toContain(`${runtimeRoot} is not writable`);
        expect(outcome.left.detail).toContain("fix its permissions");
        expect(outcome.left.detail).not.toContain("mkdir");
      }
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
});

describe("pure probe helpers", () => {
  it("reads the two labels off one inspect, and no label at all as undeclared", () => {
    expect(parseDeclaredInputs(scriptedLabels(DECLARED, DIGEST))).toEqual(
      Option.some({ paths: ["api/requirements.txt", "client/yarn.lock"], digest: DIGEST }),
    );
    // Docker prints an absent label as an empty line, and an image carrying
    // neither prints two of them.
    expect(parseDeclaredInputs("\n")).toEqual(Option.none());
    expect(parseDeclaredInputs("")).toEqual(Option.none());
    // The digest is compared as lowercase hex on both sides.
    expect(parseDeclaredInputs(scriptedLabels("a.txt", DIGEST.toUpperCase()))).toEqual(
      Option.some({ paths: ["a.txt"], digest: DIGEST }),
    );
  });

  it("parses node major versions and gates on >= 26", () => {
    expect(nodeMajor("26.7.0")).toBe(26);
    expect(nodeMajor("25.9.1")).toBe(25);
  });

  it.effect("the node probe fails typed below 26", () =>
    Effect.gen(function* () {
      const outcome = yield* Effect.either(nodeProbe("25.9.1"));
      expect(Either.isLeft(outcome)).toBe(true);
      if (Either.isLeft(outcome)) {
        expect(outcome.left._tag).toBe("NodeTooOld");
      }
      const rows = yield* nodeProbe("26.7.0");
      expect(rows[0]?.status).toBe("ok");
    }),
  );

  it("renders probe rows in the bash table shape", () => {
    expect(
      renderProbeRow({ _tag: "ProbeChecked", probe: "docker", status: "ok", detail: "fine" }),
    ).toBe("ok    docker       fine");
    expect(
      renderProbeRow({
        _tag: "ProbeChecked",
        probe: "runtime-root",
        status: "fail",
        detail: "nope",
      }),
    ).toBe("FAIL  runtime-root nope");
  });
});

// Probe 11's row (T129) against real repositories: a temp package repo whose
// `origin` is a local bare repo carrying an annotated v1 and a lightweight v2,
// and a temp served repo whose `.bessemer/config.toml` holds the pin.
const HAND = ["-c", "user.email=t@example.com", "-c", "user.name=Test"];
const realGit = (...args: ReadonlyArray<string>) =>
  exec("git", ...HAND, ...args).pipe(
    Effect.flatMap((result) =>
      result.exitCode === 0
        ? Effect.succeed(result.stdout.trim())
        : Effect.dieMessage(`git ${args.join(" ")}: ${result.stderr}`),
    ),
  );

const upstreamWorld = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped();
  const upstream = `${root}/upstream`;
  yield* realGit("init", "-q", "-b", "main", upstream);
  yield* realGit("-C", upstream, "commit", "-q", "--allow-empty", "-m", "one");
  const v1 = yield* realGit("-C", upstream, "rev-parse", "HEAD");
  yield* realGit("-C", upstream, "tag", "-a", "-m", "v1", "v1");
  yield* realGit("-C", upstream, "commit", "-q", "--allow-empty", "-m", "two");
  const v2 = yield* realGit("-C", upstream, "rev-parse", "HEAD");
  yield* realGit("-C", upstream, "tag", "v2");
  yield* realGit("-C", upstream, "commit", "-q", "--allow-empty", "-m", "three");
  const untagged = yield* realGit("-C", upstream, "rev-parse", "HEAD");
  const bare = `${root}/origin.git`;
  yield* realGit("clone", "-q", "--bare", upstream, bare);
  const packageRepoRoot = `${root}/package`;
  yield* realGit("clone", "-q", bare, packageRepoRoot);
  const served = `${root}/served`;
  yield* fs.makeDirectory(bessemerDir(served), { recursive: true });
  const pinTo = (line: string) =>
    fs.writeFileString(`${bessemerDir(served)}/config.toml`, `image = "x"\n${line}\n`);
  return { root, packageRepoRoot, served, pinTo, v1, v2, untagged };
}).pipe(Effect.orDie);

const revision = (sha: string): Option.Option<DispatcherRevision> =>
  Option.some({ sha, revision: sha.slice(0, 7), dirty: false });

const rowFor = (
  w: Effect.Effect.Success<typeof upstreamWorld>,
  running: Option.Option<DispatcherRevision>,
) =>
  upstreamProbe({
    repoRoot: w.served,
    packageRepoRoot: w.packageRepoRoot,
    selfHosted: false,
    dispatcherRevision: running,
  });

describe("upstream probe", () => {
  it.scoped("names the pinned release and the latest one", () =>
    Effect.gen(function* () {
      const w = yield* upstreamWorld;
      yield* w.pinTo(`tool-sha = "${w.v1}"`);
      expect(yield* rowFor(w, revision(w.v1))).toEqual({
        probe: "upstream",
        status: "ok",
        detail: `pinned v1 (${w.v1.slice(0, 7)}); latest v2`,
      });
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("is the same row with K = N when the pin is the latest", () =>
    Effect.gen(function* () {
      const w = yield* upstreamWorld;
      yield* w.pinTo(`tool-sha = "${w.v2}"`);
      expect((yield* rowFor(w, revision(w.v2))).detail).toBe(
        `pinned v2 (${w.v2.slice(0, 7)}); latest v2`,
      );
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("names an untagged pin as no release", () =>
    Effect.gen(function* () {
      const w = yield* upstreamWorld;
      yield* w.pinTo(`tool-sha = "${w.untagged}"`);
      expect((yield* rowFor(w, revision(w.untagged))).detail).toBe(
        `pinned ${w.untagged.slice(0, 7)} (no release); latest v2`,
      );
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  // F14: under a hand clone the running revision and the pin differ, compared
  // in full — the row says so and stays `ok`.
  it.scoped("says so when the running revision is not the pin, still ok", () =>
    Effect.gen(function* () {
      const w = yield* upstreamWorld;
      yield* w.pinTo(`tool-sha = "${w.v1}"`);
      const row = yield* rowFor(w, revision(w.v2));
      expect(row.status).toBe("ok");
      expect(row.detail).toBe(
        `pinned v1 (${w.v1.slice(0, 7)}); latest v2; running ${w.v2.slice(0, 7)}, not the pin`,
      );
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("names a refused pin by its refusal kind", () =>
    Effect.gen(function* () {
      const w = yield* upstreamWorld;
      yield* w.pinTo(`tool-sha = "${w.v1.slice(0, 7)}"`);
      expect(yield* rowFor(w, revision(w.v1))).toEqual({
        probe: "upstream",
        status: "ok",
        detail: "pin refused (Short); latest v2",
      });
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("an unreachable origin compares nothing, quoting git, and is ok", () =>
    Effect.gen(function* () {
      const w = yield* upstreamWorld;
      yield* w.pinTo(`tool-sha = "${w.v1}"`);
      yield* realGit(
        "-C",
        w.packageRepoRoot,
        "remote",
        "set-url",
        "origin",
        `${w.root}/nowhere.git`,
      );
      expect(yield* rowFor(w, revision(w.v1))).toEqual({
        probe: "upstream",
        status: "ok",
        detail:
          `pinned ${w.v1.slice(0, 7)}; nothing compared — git ls-remote origin: ` +
          `fatal: '${w.root}/nowhere.git' does not appear to be a git repository`,
      });
    }).pipe(Effect.provide(NodeContext.layer)),
  );
});

// Both probes name the git dir (T133): a repo root that holds no repository
// is reported as one, rather than read through to the repo enclosing it.
describe("the git probes, pointed at a directory that is not a repository", () => {
  const origin = Either.right("git@github.com:o/r.git");

  it.scoped("the git probe reports not-a-work-tree", () =>
    Effect.gen(function* () {
      const { repo, nested } = yield* repoWithNestedDir;
      expect((yield* gitProbe(repo, origin))[0]?.status).toBe("ok");
      const refused = yield* Effect.flip(gitProbe(nested, origin));
      expect(refused.detail).toBe(`not a git work tree: ${nested}`);
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  // Weaker than the one above, and said so: `packagePathspec` is relative to
  // this checkout's own layout, so against a scratch fixture the read fails on
  // the pathspec whichever repo git found. The spelling itself is pinned by
  // the scripted rows at the top of this file, which key on `--git-dir`.
  it.scoped("the freshness probe finds no base rather than the enclosing repo's", () =>
    Effect.gen(function* () {
      const { nested } = yield* repoWithNestedDir;
      const [row] = yield* dispatcherFreshnessProbe(nested, "main");
      expect(row?.status).toBe("warn");
      expect(row?.detail).toContain("does not resolve in this clone");
    }).pipe(Effect.provide(NodeContext.layer)),
  );
});
