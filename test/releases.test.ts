// T122: the release predicate, the `ls-remote` parse, the pin, and the move
// decision as pure values; the two reads against real repositories (a local
// bare repo standing in for `origin`, no network), and the one property a
// real repository cannot show — the child's environment — against the
// scripted executor.
import { describe, expect, it } from "@effect/vitest";
import { FileSystem } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { Chunk, Effect, Exit, Fiber, Option, Ref, TestClock } from "effect";
import { existsSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { exec } from "../src/internal/exec.ts";
import {
  credentialOrigin,
  isReleaseTag,
  moveDecision,
  parseLsRemoteTags,
  readHeadReleases,
  readRemoteReleases,
  ReleaseReadError,
  type Release,
  releaseAt,
} from "../src/git/releases.ts";
import { scriptedExecutor } from "./support/exec-fake.ts";
import { repoWithNestedDir } from "./support/nested-dir.ts";
import { type Credential, fakeGh, operatorHome, serveGitHttp } from "./support/git-http.ts";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const TAG_OBJECT = "f".repeat(40);
const OTHER_TAG_OBJECT = "e".repeat(40);

describe("isReleaseTag", () => {
  it.each(["v1", "v2", "v10"])("accepts %s", (name) => {
    expect(isReleaseTag(name)).toBe(true);
  });

  it.each(["v0", "v01", "v1.2", "V1", "bessemer-port-source", "clack-picker-prototype"])(
    "refuses %s",
    (name) => {
      expect(isReleaseTag(name)).toBe(false);
    },
  );
});

describe("parseLsRemoteTags", () => {
  // v1 annotated (peeled to A), v2 lightweight on B, a non-release annotated
  // tag, and v3 (annotated) and v4 (lightweight) both on C.
  const FIXTURE = [
    `${TAG_OBJECT}\trefs/tags/v1`,
    `${A}\trefs/tags/v1^{}`,
    `${B}\trefs/tags/v2`,
    `${OTHER_TAG_OBJECT}\trefs/tags/bessemer-port-source`,
    `${A}\trefs/tags/bessemer-port-source^{}`,
    `${"d".repeat(40)}\trefs/tags/v3`,
    `${C}\trefs/tags/v3^{}`,
    `${C}\trefs/tags/v4`,
    "",
  ].join("\n");

  it("parses releases, taking the commit from the peeled line where there is one", () => {
    expect(parseLsRemoteTags(FIXTURE)).toEqual([
      { tag: "v1", number: 1, commit: A },
      { tag: "v2", number: 2, commit: B },
      { tag: "v3", number: 3, commit: C },
      { tag: "v4", number: 4, commit: C },
    ]);
  });

  it("is empty for an origin with no tags", () => {
    expect(parseLsRemoteTags("")).toEqual([]);
  });
});

const RELEASES: ReadonlyArray<Release> = [
  { tag: "v1", number: 1, commit: A },
  { tag: "v2", number: 2, commit: B },
  { tag: "v3", number: 3, commit: C },
  { tag: "v4", number: 4, commit: C },
];

describe("releaseAt", () => {
  it("is the higher of two releases on one commit", () => {
    expect(releaseAt(RELEASES, C)).toEqual(Option.some({ tag: "v4", number: 4, commit: C }));
  });

  it("is none for a commit no release names", () => {
    expect(releaseAt(RELEASES, "9".repeat(40))).toEqual(Option.none());
  });
});

describe("moveDecision", () => {
  it("moves a pin behind the latest release to it", () => {
    expect(moveDecision(RELEASES, A)).toEqual({
      _tag: "Move",
      from: RELEASES[0],
      to: RELEASES[3],
    });
  });

  it("is current for a pin on the latest release", () => {
    expect(moveDecision(RELEASES, C)).toEqual({
      _tag: "Current",
      release: RELEASES[3],
    });
  });

  it("is untagged for a pin no release names", () => {
    expect(moveDecision(RELEASES, "9".repeat(40))).toEqual({
      _tag: "Untagged",
    });
    expect(moveDecision([], A)).toEqual({ _tag: "Untagged" });
  });
});

const HAND = ["-c", "user.email=t@example.com", "-c", "user.name=Test"];

const git = (...args: ReadonlyArray<string>) =>
  exec("git", ...HAND, ...args).pipe(
    Effect.flatMap((result) =>
      result.exitCode === 0
        ? Effect.succeed(result.stdout.trim())
        : Effect.dieMessage(`git ${args.join(" ")}: ${result.stderr}`),
    ),
  );

// An upstream repo carrying an annotated v1, a lightweight v2 and a
// non-release tag; a bare clone of it as `origin`; and a clone of that, which
// is the package repo the reads run in.
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped();
  const upstream = `${root}/upstream`;
  yield* git("init", "-q", "-b", "main", upstream);
  yield* git("-C", upstream, "commit", "-q", "--allow-empty", "-m", "one");
  const first = yield* git("-C", upstream, "rev-parse", "HEAD");
  yield* git("-C", upstream, "tag", "-a", "-m", "v1", "v1");
  yield* git("-C", upstream, "tag", "bessemer-port-source");
  yield* git("-C", upstream, "commit", "-q", "--allow-empty", "-m", "two");
  const second = yield* git("-C", upstream, "rev-parse", "HEAD");
  yield* git("-C", upstream, "tag", "v2");
  const bare = `${root}/origin.git`;
  yield* git("clone", "-q", "--bare", upstream, bare);
  const clone = `${root}/clone`;
  yield* git("clone", "-q", bare, clone);
  return { root, upstream, clone, first, second };
}).pipe(Effect.orDie);

const provideReal = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(NodeContext.layer));

describe("readRemoteReleases", () => {
  it.scoped("reads the releases off a local bare origin", () =>
    provideReal(
      Effect.gen(function* () {
        const { clone, first, second } = yield* fixture;
        expect(yield* readRemoteReleases(clone)).toEqual([
          { tag: "v1", number: 1, commit: first },
          { tag: "v2", number: 2, commit: second },
        ]);
      }),
    ),
  );

  it.scoped("fails carrying git's line when origin does not exist", () =>
    provideReal(
      Effect.gen(function* () {
        const { root, clone } = yield* fixture;
        yield* git("-C", clone, "remote", "set-url", "origin", `${root}/nowhere.git`);
        expect(yield* Effect.flip(readRemoteReleases(clone))).toEqual(
          new ReleaseReadError({
            detail: `fatal: '${root}/nowhere.git' does not appear to be a git repository`,
          }),
        );
      }),
    ),
  );

  // Both remote children, the gh attempt and the fallback; the `--get-url`
  // before them reads config and reaches nothing.
  it.effect("hands each remote child GIT_TERMINAL_PROMPT=0", () =>
    Effect.gen(function* () {
      const environments = yield* Ref.make<ReadonlyArray<Record<string, string>>>([]);
      const commands = yield* Ref.make<ReadonlyArray<string>>([]);
      yield* readRemoteReleases("/srv/bessemer").pipe(
        Effect.provide(
          scriptedExecutor(
            {
              "git -C /srv/bessemer --git-dir=/srv/bessemer/.git ls-remote --get-url origin": {
                stdout: "https://github.com/HireAnEsquire/speepobox.git\n",
              },
              "git -C /srv/bessemer --git-dir=/srv/bessemer/.git -c": {
                exit: 128,
                stderr: "fatal: gh said no\n",
              },
              "git -C /srv/bessemer --git-dir=/srv/bessemer/.git ls-remote --tags origin": {
                stdout: "",
              },
            },
            commands,
            undefined,
            environments,
          ),
        ),
      );
      expect(yield* Ref.get(commands)).toEqual([
        "git -C /srv/bessemer --git-dir=/srv/bessemer/.git ls-remote --get-url origin",
        "git -C /srv/bessemer --git-dir=/srv/bessemer/.git -c credential.https://github.com.helper= " +
          "-c credential.https://github.com.helper=!gh auth git-credential ls-remote --tags origin",
        "git -C /srv/bessemer --git-dir=/srv/bessemer/.git ls-remote --tags origin",
      ]);
      const spawned = yield* Ref.get(environments);
      expect(spawned.map((env) => env["GIT_TERMINAL_PROMPT"])).toEqual([undefined, "0", "0"]);
    }),
  );

  it.effect("quotes both attempts and names gh auth login, then setup-git", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        readRemoteReleases("/srv/bessemer").pipe(
          Effect.provide(
            scriptedExecutor({
              "git -C /srv/bessemer --git-dir=/srv/bessemer/.git ls-remote --get-url origin": {
                stdout: "https://github.com/HireAnEsquire/speepobox.git\n",
              },
              "git -C /srv/bessemer --git-dir=/srv/bessemer/.git -c": {
                exit: 128,
                stderr: "fatal: could not read Username for 'https://github.com': one\n",
              },
              "git -C /srv/bessemer --git-dir=/srv/bessemer/.git ls-remote --tags origin": {
                exit: 128,
                stderr: "fatal: could not read Username for 'https://github.com': two\n",
              },
            }),
          ),
        ),
      );
      expect(error.detail).toBe(
        "through gh: fatal: could not read Username for 'https://github.com': one; " +
          "through git's own credentials: fatal: could not read Username for " +
          "'https://github.com': two — run `gh auth login`, then `gh auth setup-git`",
      );
    }),
  );

  it.effect("fails with a nonzero git's fatal line", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        readRemoteReleases("/srv/bessemer").pipe(
          Effect.provide(
            scriptedExecutor({
              "git -C /srv/bessemer --git-dir=/srv/bessemer/.git ls-remote": {
                exit: 128,
                stderr:
                  "fatal: could not read Username for 'https://github.com': terminal prompts disabled\n",
              },
            }),
          ),
        ),
      );
      expect(exit).toEqual(
        Exit.fail(
          new ReleaseReadError({
            detail:
              "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
          }),
        ),
      );
    }),
  );

  // The test clock, not a live one: the budget is a module constant, and a
  // ten-second live case would be ten seconds of every verify. What makes the
  // virtual clock safe here is the barrier the agent pass's case lacks
  // (`agent-cli.test.ts`): the adjust waits until the timeout has registered
  // its sleep, so it cannot land before the sleep it is meant to fire.
  it.effect("times out after 10 s", () =>
    Effect.gen(function* () {
      const fiber = yield* Effect.fork(
        readRemoteReleases("/srv/bessemer").pipe(
          Effect.provide(
            scriptedExecutor({
              "git -C /srv/bessemer --git-dir=/srv/bessemer/.git ls-remote": { hangs: true },
            }),
          ),
        ),
      );
      yield* TestClock.sleeps().pipe(
        Effect.tap(() => Effect.yieldNow()),
        Effect.repeat({ until: Chunk.isNonEmpty }),
      );
      yield* TestClock.adjust("10 seconds");
      expect(yield* Effect.exit(Fiber.join(fiber))).toEqual(
        Exit.fail(new ReleaseReadError({ detail: "timed out after 10 s" })),
      );
    }),
  );
});

// This process's own environment, set for one scoped case and put back after.
const hostEnv = (vars: Record<string, string>) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const saved = Object.fromEntries(
        Object.keys(vars).map((name) => [name, process.env[name]] as const),
      );
      Object.assign(process.env, vars);
      return saved;
    }),
    (saved) =>
      Effect.sync(() => {
        for (const [name, value] of Object.entries(saved)) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
      }),
  );

// T132, through the chokepoint: `origin` served over HTTP behind basic auth,
// so a credential is really asked for. The chokepoint forwards `PATH` and
// `HOME` from this process, so the case sets those two here — a `PATH` of git
// and, where the case has one, the fake gh; a `HOME` whose global config names
// the operator's own helper — and puts them back afterwards.
describe("readRemoteReleases' credential (T132)", () => {
  const CANNED: Credential = { username: "x-access-token", password: "canned" };

  const gitOnly = Effect.sync(() => {
    const dir = mkdtempSync(join(tmpdir(), "bessemer-git-only-"));
    const found = (process.env["PATH"] ?? "")
      .split(delimiter)
      .map((entry) => join(entry, "git"))
      .find((candidate) => existsSync(candidate));
    symlinkSync(found!, join(dir, "git"));
    return dir;
  });

  const served = (
    gh: ReturnType<typeof fakeGh> | undefined,
    operator: ReturnType<typeof operatorHome>,
  ) =>
    Effect.gen(function* () {
      const { root, clone, first, second } = yield* fixture;
      const server = yield* Effect.acquireRelease(
        Effect.promise(() => serveGitHttp(root, CANNED)),
        (started) => Effect.promise(() => started.close()),
      );
      yield* git("-C", clone, "remote", "set-url", "origin", server.url("origin.git"));
      const tools = yield* gitOnly;
      yield* hostEnv({
        PATH: gh === undefined ? tools : `${gh.dir}${delimiter}${tools}`,
        HOME: operator.home,
      });
      const releases = yield* readRemoteReleases(clone);
      return { releases, first, second };
    });

  it.scoped("passes the pair and asks gh, and the operator's helper hears nothing", () =>
    provideReal(
      Effect.gen(function* () {
        const gh = fakeGh(CANNED);
        const operator = operatorHome(undefined);
        const { releases, first, second } = yield* served(gh, operator);
        expect(releases.map((release) => [release.tag, release.commit])).toEqual([
          ["v1", first],
          ["v2", second],
        ]);
        expect(gh.calls()).toContain("auth git-credential get");
        expect(operator.actions()).toEqual([]);
      }),
    ),
  );

  it.scoped("falls back to the operator's chain when gh cannot answer", () =>
    provideReal(
      Effect.gen(function* () {
        const gh = fakeGh(undefined);
        const operator = operatorHome(CANNED);
        const { releases } = yield* served(gh, operator);
        expect(releases.map((release) => release.tag)).toEqual(["v1", "v2"]);
        expect(gh.calls()).toContain("auth git-credential get");
        expect(operator.actions()).toEqual(["get", "store"]);
      }),
    ),
  );

  it.scoped("reads the releases with no gh on the PATH", () =>
    provideReal(
      Effect.gen(function* () {
        const operator = operatorHome(CANNED);
        const { releases } = yield* served(undefined, operator);
        expect(releases.map((release) => release.tag)).toEqual(["v1", "v2"]);
        expect(operator.actions()).toEqual(["get", "store"]);
      }),
    ),
  );
});

describe("readHeadReleases", () => {
  it.scoped("finds the release on HEAD", () =>
    provideReal(
      Effect.gen(function* () {
        const { clone, second } = yield* fixture;
        expect(yield* readHeadReleases(clone)).toEqual([{ tag: "v2", number: 2, commit: second }]);
      }),
    ),
  );

  it.scoped("finds none on an untagged HEAD", () =>
    provideReal(
      Effect.gen(function* () {
        const { clone } = yield* fixture;
        yield* git("-C", clone, "commit", "-q", "--allow-empty", "-m", "three");
        expect(yield* readHeadReleases(clone)).toEqual([]);
      }),
    ),
  );
});

describe("credentialOrigin", () => {
  it.each([
    ["https://github.com/HireAnEsquire/speepobox.git\n", Option.some("https://github.com")],
    ["https://someone@github.com/x/y.git", Option.some("https://github.com")],
    ["http://127.0.0.1:8080/bessemer.git", Option.some("http://127.0.0.1:8080")],
    ["git@github.com:HireAnEsquire/speepobox.git", Option.none()],
    ["ssh://git@github.com/HireAnEsquire/speepobox.git", Option.none()],
    ["file:///srv/bessemer.git", Option.none()],
    ["/srv/bessemer.git", Option.none()],
  ])("%s", (url, expected) => {
    expect(credentialOrigin(url)).toEqual(expected);
  });
});

// A cache entry missing its `.git` under a repository (T133): both reads fail
// naming that directory rather than answering with the enclosing repo's tags.
describe("the release reads, pointed at a directory that is not a repository", () => {
  it.scoped("fail rather than answer for the repo enclosing it", () =>
    provideReal(
      Effect.gen(function* () {
        const { repo, nested, sha } = yield* repoWithNestedDir;
        yield* git("-C", repo, "remote", "add", "origin", repo);
        // The enclosing repo really does answer both, so a discovered read
        // would have succeeded with these.
        const v1 = [{ tag: "v1", number: 1, commit: sha }];
        expect(yield* readHeadReleases(repo)).toEqual(v1);
        expect(yield* readRemoteReleases(repo)).toEqual(v1);

        const head = yield* Effect.flip(readHeadReleases(nested));
        expect(head.detail).toContain("not a git repository");
        // `ls-remote` runs outside a repository too, so the failure here is
        // git finding no `origin` to name: there is no config to read one from.
        const remote = yield* Effect.flip(readRemoteReleases(nested));
        expect(remote.detail).toContain("'origin' does not appear to be a git repository");
      }),
    ),
  );
});
