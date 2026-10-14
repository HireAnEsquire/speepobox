// The shim (T125, T126): `templates/bessemer` reads the served repo's pin
// and runs the package cache entry for it, building the entry when it is
// missing. The cold path fetches from a fixture mirror on disk the release URL
// is rewritten to, so every case is offline.
//
// The children are spawned with `node:child_process`, not the chokepoint, and
// each one's environment is written out in full — `PATH`, `HOME`,
// `XDG_CACHE_HOME`, nothing inherited. These children run to completion; the
// exception is for the hand-written environment, which `execUnder` has no
// spelling for (AGENTS.md, beside live case 5).
import { describe, expect, it } from "@effect/vitest";
import { Either, Option } from "effect";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  statSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { packageRoot, templatesRoot } from "../src/config/paths.ts";
import { SHIM_REFRESH } from "../src/init/render.ts";
import { readStamp, STAMPED_TEMPLATES, stamp, TEMPLATE_VERSIONS } from "../src/init/stamp.ts";
import { type PinRefusal, pinIn, RELEASE_URL, renderPinRefusal } from "../src/pin/pin.ts";
import { type Credential, fakeGh, operatorHome, serveGitHttp } from "./support/git-http.ts";

const TEMPLATE = readFileSync(join(templatesRoot, "bessemer"), "utf8");
const CURRENT = stamp("bessemer", TEMPLATE_VERSIONS.bessemer, TEMPLATE);

const PIN_FIXTURES = new URL("./fixtures/pin/", import.meta.url);
const RELEASED_SHIMS = new URL("./fixtures/shim/", import.meta.url);

const temp = (): string => mkdtempSync(join(tmpdir(), "bessemer-shim-"));

// The host's own copy of a tool, found the way the shell would find it.
const onHostPath = (name: string): string => {
  for (const dir of (process.env["PATH"] ?? "").split(delimiter)) {
    if (dir !== "" && existsSync(join(dir, name))) return join(dir, name);
  }
  throw new Error(`${name} is not on the host PATH`);
};

// A `PATH` of exactly the tools the shim and the package reach for, so a case
// can leave one out. `sed` is the shim's one external command.
const TOOLS = ["node", "git", "npm", "sed"] as const;

const toolsDir = (omit: ReadonlyArray<string> = []): string => {
  const dir = temp();
  for (const name of TOOLS) {
    if (!omit.includes(name)) symlinkSync(onHostPath(name), join(dir, name));
  }
  return dir;
};

const ALL_TOOLS = toolsDir();

// A served repo: the shim under test at `.bessemer/bessemer`, beside a config.
const fixtureRepo = (config: string, shim: string = CURRENT): string => {
  const repo = temp();
  mkdirSync(join(repo, ".bessemer"));
  writeFileSync(join(repo, ".bessemer", "config.toml"), config);
  writeFileSync(join(repo, ".bessemer", "bessemer"), shim);
  chmodSync(join(repo, ".bessemer", "bessemer"), 0o755);
  return repo;
};

const pinned = (sha: string): string => `image = "acme-bessemer"\ntool-sha = "${sha}"\n`;

// A cache whose entries are stub packages: each `src/bin.ts` prints its argv
// and its own location, which names the entry the shim ran.
const stubCache = (shas: ReadonlyArray<string>): string => {
  const cache = temp();
  for (const sha of shas) {
    const src = join(cache, "bessemer", sha, "src");
    mkdirSync(src, { recursive: true });
    writeFileSync(
      join(src, "bin.ts"),
      "console.log(JSON.stringify({ at: process.argv[1], argv: process.argv.slice(2) }));\n",
    );
  }
  return cache;
};

const shimEnv = (options: {
  readonly cache: string;
  readonly path?: string;
  readonly locale?: string;
  readonly env?: Readonly<Record<string, string>>;
}): Record<string, string> => ({
  PATH: options.path ?? ALL_TOOLS,
  HOME: temp(),
  XDG_CACHE_HOME: options.cache,
  ...(options.locale === undefined ? {} : { LC_ALL: options.locale }),
  ...options.env,
});

interface Run {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

const runShim = (
  repo: string,
  args: ReadonlyArray<string>,
  options: {
    readonly cache: string;
    readonly path?: string;
    readonly cwd?: string;
    readonly locale?: string;
    readonly env?: Readonly<Record<string, string>>;
  },
): Run => {
  const result = spawnSync(join(repo, ".bessemer", "bessemer"), args, {
    cwd: options.cwd ?? repo,
    encoding: "utf8",
    env: shimEnv(options),
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};

const stubOutput = (run: Run): { readonly at: string; readonly argv: ReadonlyArray<string> } => {
  expect(run.stderr).toBe("");
  expect(run.status).toBe(0);
  return JSON.parse(run.stdout);
};

// A refusal is one line, `!! [<kind>] <sentence>`.
const refusalOf = (run: Run): { readonly kind: string; readonly sentence: string } => {
  expect(run.status).toBe(1);
  expect(run.stdout).toBe("");
  const match = /^!! \[([a-z-]+)\] (.+)\n$/.exec(run.stderr);
  expect(match, run.stderr).not.toBeNull();
  return { kind: match![1]!, sentence: match![2]! };
};

describe("the shim template", () => {
  it("is POSIX sh, stamped after its shebang, and one init writes", () => {
    expect(TEMPLATE.startsWith("#!/bin/sh\n")).toBe(true);
    const lines = CURRENT.split("\n");
    expect(lines[0]).toBe("#!/bin/sh");
    expect(readStamp(lines[1]!)).toEqual(
      Option.some(expect.objectContaining({ name: "bessemer", version: 4 })),
    );
    expect((STAMPED_TEMPLATES as ReadonlyArray<string>).includes("bessemer")).toBe(true);
    const syntax = spawnSync("sh", ["-n", join(templatesRoot, "bessemer")], { encoding: "utf8" });
    expect(syntax.stderr).toBe("");
    expect(syntax.status).toBe(0);
  });

  it("names the release once, at the top, and reads no token", () => {
    expect(TEMPLATE.match(/^RELEASE_URL=.*$/gm)).toEqual([`RELEASE_URL='${RELEASE_URL}'`]);
    expect(TEMPLATE.split(RELEASE_URL)).toHaveLength(2);
    expect(TEMPLATE).not.toMatch(/token/i);
    // The pin grammar's blanks are `[[:blank:]]`: BSD `sed` reads `\t` in a
    // bracket expression as a letter.
    expect(TEMPLATE).not.toContain("\\t");
  });
});

describe("the warm path, against the current package (F18)", () => {
  const head = spawnSync("git", ["-C", packageRoot, "rev-parse", "HEAD"], { encoding: "utf8" });
  const sha = head.stdout.trim();

  // The current template, then every released one kept as a fixture.
  const released = readdirSync(RELEASED_SHIMS)
    .filter((file) => file !== "README.md")
    .map((file) => ({ name: file, text: readFileSync(new URL(file, RELEASED_SHIMS), "utf8") }));
  const shims = [{ name: `current (v${TEMPLATE_VERSIONS.bessemer})`, text: CURRENT }, ...released];

  it.each(shims)(
    "$name runs `init --diff` on the fixture repo",
    ({ text }) => {
      expect(sha).toMatch(/^[0-9a-f]{40}$/);
      const repo = fixtureRepo(pinned(sha), text);
      const cache = temp();
      mkdirSync(join(cache, "bessemer"));
      symlinkSync(packageRoot, join(cache, "bessemer", sha));
      const run = runShim(repo, ["init", "--diff"], { cache });
      // The scaffold is not written, so `--diff` reports drift and exits 1;
      // what proves `--repo-root` arrived is that it describes this repo.
      expect(run.stderr).toBe("");
      expect(run.stdout).toMatch(/^present +\.bessemer\/config\.toml$/m);
      expect(run.stdout).toMatch(/^missing +\.bessemer\/\.gitignore /m);
      expect(run.stdout).toMatch(/^missing +\.bessemer\/image\/Dockerfile /m);
    },
    // A cold start of the full CLI on a loaded two-core runner; every released shim fixture adds another.
    60_000,
  );
});

// T127: `init` writes the shim, and the refresh `--diff` prints for a behind
// one runs as printed — from the shim it is about to replace.
describe("the shim init writes refreshes itself", () => {
  const head = spawnSync("git", ["-C", packageRoot, "rev-parse", "HEAD"], { encoding: "utf8" });
  const sha = head.stdout.trim();

  it("leaves a current, executable shim and no .old", () => {
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    const repo = temp();
    const cache = temp();
    mkdirSync(join(cache, "bessemer"));
    symlinkSync(packageRoot, join(cache, "bessemer", sha));
    // The tools the refresh line itself runs, beside the shim's own.
    const path = `${ALL_TOOLS}${delimiter}${process.env["PATH"] ?? ""}`;
    const env = { PATH: path, HOME: temp(), XDG_CACHE_HOME: cache };

    // The bootstrap: `init` from a hand clone, which this package is.
    const bootstrap = spawnSync(
      "node",
      [join(packageRoot, "src", "bin.ts"), "--repo-root", repo, "init", "--base", "origin/main"],
      { cwd: repo, encoding: "utf8", env },
    );
    expect(bootstrap.stderr).toBe("");
    expect(bootstrap.status).toBe(0);
    const shim = join(repo, ".bessemer", "bessemer");
    expect(statSync(shim).mode & 0o777).toBe(0o755);

    // Pinned at the cache entry — a dirty tree writes an empty pin — and
    // the shim taken one version back, as an `upgrade` would leave it.
    const config = join(repo, ".bessemer", "config.toml");
    writeFileSync(
      config,
      readFileSync(config, "utf8").replace(/^tool-sha = ".*"$/m, `tool-sha = "${sha}"`),
    );
    writeFileSync(shim, stamp("bessemer", TEMPLATE_VERSIONS.bessemer - 1, TEMPLATE));

    // No origin/HEAD here, and no --base: a kept config.toml asks nothing.
    const refresh = spawnSync("sh", ["-c", SHIM_REFRESH], { cwd: repo, encoding: "utf8", env });
    expect(refresh.stderr).toBe("");
    expect(refresh.status).toBe(0);
    expect(refresh.stdout).toMatch(/^wrote {2}\.bessemer\/bessemer$/m);
    expect(refresh.stdout).toMatch(/^kept {2}\.bessemer\/config\.toml$/m);
    expect(readFileSync(shim, "utf8")).toBe(CURRENT);
    expect(statSync(shim).mode & 0o777).toBe(0o755);
    expect(existsSync(`${shim}.old`)).toBe(false);
  }, 60_000); // Two cold starts of the full CLI.
});

describe("the shim and the pin module agree (F7)", () => {
  const KINDS = {
    NoLine: "no-line",
    Malformed: "malformed",
    Duplicated: "duplicated",
    Empty: "empty",
    Short: "short",
  } as const satisfies Record<PinRefusal["_tag"], string>;

  const cases = readdirSync(PIN_FIXTURES, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap(({ name: verdict }) =>
      readdirSync(new URL(`${verdict}/`, PIN_FIXTURES)).map((file) => ({
        fixture: `${verdict}/${file}`,
        text: readFileSync(new URL(`${verdict}/${file}`, PIN_FIXTURES), "utf8"),
      })),
    );

  const SHA = readFileSync(new URL("sha", PIN_FIXTURES), "utf8").trim();
  const cache = stubCache([SHA]);

  it("has every T121 fixture", () => {
    expect(cases).toHaveLength(11);
  });

  it.each(cases)("$fixture", ({ text }) => {
    const repo = fixtureRepo(text);
    const run = runShim(repo, [], { cache });
    Either.match(pinIn(text), {
      onRight: (sha) => {
        expect(stubOutput(run).at).toBe(join(cache, "bessemer", sha, "src", "bin.ts"));
      },
      onLeft: (refusal) => {
        expect(refusalOf(run)).toEqual({
          kind: KINDS[refusal._tag],
          sentence: renderPinRefusal(refusal),
        });
      },
    });
  });

  // A UTF-8 locale widens `[[:blank:]]` to Unicode spaces (GNU sed reads
  // U+2000 as one); the module's grammar is ASCII blanks only, so the line
  // is no pin there.
  it("agrees under a UTF-8 locale about a Unicode space", () => {
    const text = `tool-sha = "${SHA}"\n`;
    const refusal = Option.getOrThrow(Either.getLeft(pinIn(text)));
    const run = runShim(fixtureRepo(text), [], { cache, locale: "C.UTF-8" });
    expect(refusalOf(run)).toEqual({
      kind: KINDS[refusal._tag],
      sentence: renderPinRefusal(refusal),
    });
  });

  it.each(["empty/empty.toml", "short/abbreviated.toml", "short/uppercase.toml"])(
    "%s names the gh api tag list first, then `upgrade --to vN` from a hand clone",
    (fixture) => {
      const text = cases.find((c) => c.fixture === fixture)!.text;
      const { sentence } = refusalOf(runShim(fixtureRepo(text), [], { cache }));
      const tags =
        "`gh api --paginate repos/HireAnEsquire/speepobox/tags " +
        `--jq '.[] | "\\(.commit.sha) \\(.name)"'\``;
      expect(sentence).toContain(tags);
      expect(sentence).not.toContain("ls-remote");
      expect(sentence).not.toContain("^{}");
      expect(sentence).toMatch(/upgrade --to vN` from a hand clone/);
      expect(sentence.indexOf(tags)).toBeLessThan(sentence.indexOf("upgrade --to vN"));
    },
  );
});

describe("the shim's own warm path", () => {
  const SHA = "0123456789abcdef0123456789abcdef01234567";
  const cache = stubCache([SHA]);

  it("passes argv verbatim, after --repo-root <absolute repo>", () => {
    const repo = fixtureRepo(pinned(SHA));
    const args = ["has space", 'a "quoted" word', "it's", "$(touch pwned)", "", "--", "*", "-x"];
    const out = stubOutput(runShim(repo, args, { cache }));
    expect(out.argv).toEqual(["--repo-root", repo, ...args]);
    expect(existsSync(join(repo, "pwned"))).toBe(false);
  });

  it("serves the repo it sits in when run from elsewhere", () => {
    const repo = fixtureRepo(pinned(SHA));
    // Somewhere else, holding a pin of its own the shim must not read.
    const elsewhere = fixtureRepo(pinned("f".repeat(40)));
    const run = runShim(repo, ["status"], { cache, cwd: elsewhere });
    const out = stubOutput(run);
    expect(out.argv).toEqual(["--repo-root", repo, "status"]);
    expect(out.at).toBe(join(cache, "bessemer", SHA, "src", "bin.ts"));
  });

  it("refuses a node older than 26, naming node 26", () => {
    const fake = temp();
    writeFileSync(join(fake, "node"), "#!/bin/sh\necho v22.11.0\n");
    chmodSync(join(fake, "node"), 0o755);
    const run = runShim(fixtureRepo(pinned(SHA)), [], {
      cache,
      path: `${fake}${delimiter}${ALL_TOOLS}`,
    });
    const { kind, sentence } = refusalOf(run);
    expect(kind).toBe("node");
    expect(sentence).toContain("v22.11.0");
    expect(sentence).toContain("install node 26 or later");
  });

  it.each([
    { missing: "node", names: "install node 26 or later" },
    { missing: "git", names: "install git" },
    { missing: "npm", names: "install npm" },
  ])("refuses a PATH with no $missing, naming what to install", ({ missing, names }) => {
    const run = runShim(fixtureRepo(pinned(SHA)), [], { cache, path: toolsDir([missing]) });
    const { kind, sentence } = refusalOf(run);
    expect(kind).toBe(missing);
    expect(sentence).toContain(names);
  });

  it("reads config.toml only, never config.local.toml", () => {
    const repo = fixtureRepo('image = "x"\n');
    writeFileSync(join(repo, ".bessemer", "config.local.toml"), pinned(SHA));
    expect(refusalOf(runShim(repo, [], { cache })).kind).toBe("no-line");
  });
});

// The fixture mirror: a stub package at one commit — an empty lockfile, so
// `npm ci` installs nothing, and a `src/bin.ts` that prints its argv.
const git = (cwd: string, ...args: ReadonlyArray<string>): string => {
  const result = spawnSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8" },
  );
  expect(result.stderr, args.join(" ")).not.toMatch(/fatal/);
  expect(result.status).toBe(0);
  return result.stdout.trim();
};

const mirror = (): { readonly path: string; readonly sha: string } => {
  const path = temp();
  const manifest = { name: "stub", version: "0.0.0" };
  writeFileSync(join(path, "package.json"), JSON.stringify(manifest));
  writeFileSync(
    join(path, "package-lock.json"),
    JSON.stringify({ ...manifest, lockfileVersion: 3, requires: true, packages: { "": manifest } }),
  );
  mkdirSync(join(path, "src"));
  writeFileSync(
    join(path, "src", "bin.ts"),
    "console.log(JSON.stringify({ at: process.argv[1], argv: process.argv.slice(2) }));\n",
  );
  git(path, "init", "-q");
  git(path, "add", ".");
  git(path, "commit", "-q", "-m", "stub");
  return { path, sha: git(path, "rev-parse", "HEAD") };
};

// The release URL rewritten to `source`, on the child only.
const rewrite = (source: string): Record<string, string> => ({
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: `url.file://${source}.insteadOf`,
  GIT_CONFIG_VALUE_0: RELEASE_URL,
  npm_config_offline: "true",
});

const leftovers = (cache: string): ReadonlyArray<string> =>
  readdirSync(join(cache, "bessemer")).filter((name) => name.includes(".tmp."));

const runShimAsync = (
  repo: string,
  args: ReadonlyArray<string>,
  options: {
    readonly cache: string;
    readonly path?: string;
    readonly env: Readonly<Record<string, string>>;
  },
): Promise<Run> =>
  new Promise((resolve, reject) => {
    const child = spawn(join(repo, ".bessemer", "bessemer"), args, {
      cwd: repo,
      env: shimEnv(options),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });

describe("the cold path (T126)", () => {
  it("builds the entry from an empty cache, then runs it", () => {
    const source = mirror();
    const cache = temp();
    const repo = fixtureRepo(pinned(source.sha));
    const out = stubOutput(runShim(repo, ["status", "a b"], { cache, env: rewrite(source.path) }));
    const entry = join(cache, "bessemer", source.sha);
    expect(out.argv).toEqual(["--repo-root", repo, "status", "a b"]);
    expect(out.at).toBe(join(entry, "src", "bin.ts"));
    // SPEC §6's contract item 4: `HEAD` is the pin, `origin` the release.
    expect(git(entry, "rev-parse", "HEAD")).toBe(source.sha);
    expect(git(entry, "config", "remote.origin.url")).toBe(RELEASE_URL);
    expect(leftovers(cache)).toEqual([]);
  }, 60_000);

  it("runs the built entry again with the mirror gone", () => {
    const source = mirror();
    const cache = temp();
    const repo = fixtureRepo(pinned(source.sha));
    const env = rewrite(source.path);
    stubOutput(runShim(repo, [], { cache, env }));
    rmSync(source.path, { recursive: true, force: true });
    const out = stubOutput(runShim(repo, ["again"], { cache, env }));
    expect(out.argv).toEqual(["--repo-root", repo, "again"]);
  }, 60_000);

  it("builds one entry when two first runs race", async () => {
    const source = mirror();
    const cache = temp();
    const repo = fixtureRepo(pinned(source.sha));
    const env = rewrite(source.path);
    const runs = await Promise.all([
      runShimAsync(repo, ["one"], { cache, env }),
      runShimAsync(repo, ["two"], { cache, env }),
    ]);
    expect(runs.map((run) => stubOutput(run).argv)).toEqual([
      ["--repo-root", repo, "one"],
      ["--repo-root", repo, "two"],
    ]);
    expect(readdirSync(join(cache, "bessemer"))).toEqual([source.sha]);
    expect(
      readdirSync(join(cache, "bessemer", source.sha)).filter((name) => name.includes(".tmp.")),
    ).toEqual([]);
  }, 60_000);

  it("sweeps a dead pid's temp directory and leaves a live one's", () => {
    const source = mirror();
    const cache = temp();
    // A pid that was alive a moment ago and is not now.
    const dead = spawnSync("node", ["-e", ""]).pid;
    const deadTemp = join(cache, "bessemer", `${source.sha}.tmp.${dead}`);
    const liveTemp = join(cache, "bessemer", `${source.sha}.tmp.${process.pid}`);
    for (const dir of [deadTemp, liveTemp]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "half-built"), "");
    }
    const repo = fixtureRepo(pinned(source.sha));
    stubOutput(runShim(repo, [], { cache, env: rewrite(source.path) }));
    expect(existsSync(deadTemp)).toBe(false);
    expect(existsSync(liveTemp)).toBe(true);
    expect(existsSync(join(cache, "bessemer", source.sha))).toBe(true);
  }, 60_000);

  it("refuses an unreachable source in one line naming gh auth login, then setup-git", () => {
    const sha = "b".repeat(40);
    const cache = temp();
    const notARepo = temp();
    const run = runShim(fixtureRepo(pinned(sha)), [], { cache, env: rewrite(notARepo) });
    const { kind, sentence } = refusalOf(run);
    expect(kind).toBe("fetch");
    expect(sentence).toContain("gh is not on the PATH; through git's own credentials: fatal:");
    expect(sentence.indexOf("`gh auth login`")).toBeGreaterThan(-1);
    expect(sentence.indexOf("`gh auth login`")).toBeLessThan(
      sentence.indexOf("`gh auth setup-git`"),
    );
    expect(sentence).toContain("may also not exist upstream");
    expect(existsSync(join(cache, "bessemer", sha))).toBe(false);
    expect(leftovers(cache)).toEqual([]);
  });
});

// T132: the release URL pointed at a local smart-HTTP server behind basic
// auth, so the credential is actually asked for — the `file://` rewrite above
// never asks a helper anything. The shim is the current template with its one
// RELEASE_URL line edited, which is the edit a fork makes.
describe("the cold path's credential (T132)", () => {
  const CANNED: Credential = { username: "x-access-token", password: "canned" };

  const served = async (
    gh: ReturnType<typeof fakeGh> | undefined,
    operator: ReturnType<typeof operatorHome>,
  ): Promise<{ readonly run: Run; readonly sha: string; readonly cache: string }> => {
    const source = mirror();
    const root = temp();
    git(root, "clone", "-q", "--bare", source.path, join(root, "bessemer.git"));
    const server = await serveGitHttp(root, CANNED);
    try {
      const shim = CURRENT.replace(RELEASE_URL, server.url("bessemer.git"));
      const repo = fixtureRepo(pinned(source.sha), shim);
      const cache = temp();
      const run = await runShimAsync(repo, ["status"], {
        cache,
        path: gh === undefined ? ALL_TOOLS : `${gh.dir}${delimiter}${ALL_TOOLS}`,
        env: { HOME: operator.home, npm_config_offline: "true" },
      });
      return { run, sha: source.sha, cache };
    } finally {
      await server.close();
    }
  };

  it("passes the pair and asks gh, and the operator's helper hears nothing", async () => {
    const gh = fakeGh(CANNED);
    const operator = operatorHome(undefined);
    const { run, sha, cache } = await served(gh, operator);
    expect(stubOutput(run).at).toBe(join(cache, "bessemer", sha, "src", "bin.ts"));
    expect(gh.calls()).toContain("auth git-credential get");
    // The scoped reset: no `get` before gh, and no `store` of gh's answer.
    expect(operator.actions()).toEqual([]);
    // Nothing written to the entry's config, or to the operator's.
    expect(git(join(cache, "bessemer", sha), "config", "--local", "--list")).not.toMatch(
      /credential/,
    );
    expect(readFileSync(join(operator.home, ".gitconfig"), "utf8")).not.toMatch(/gh/);
  }, 60_000);

  it("falls back to the operator's chain when gh cannot answer", async () => {
    const gh = fakeGh(undefined);
    const operator = operatorHome(CANNED);
    const { run, sha, cache } = await served(gh, operator);
    expect(stubOutput(run).at).toBe(join(cache, "bessemer", sha, "src", "bin.ts"));
    expect(gh.calls()).toContain("auth git-credential get");
    expect(operator.actions()).toEqual(["get", "store"]);
  }, 60_000);

  it("still builds the entry with no gh on the PATH", async () => {
    const operator = operatorHome(CANNED);
    const { run, sha, cache } = await served(undefined, operator);
    expect(stubOutput(run).at).toBe(join(cache, "bessemer", sha, "src", "bin.ts"));
    expect(operator.actions()).toEqual(["get", "store"]);
  }, 60_000);

  it("refuses quoting both attempts when neither has a credential", async () => {
    const gh = fakeGh(undefined);
    const { run, cache } = await served(gh, operatorHome(undefined));
    const { kind, sentence } = refusalOf(run);
    expect(kind).toBe("fetch");
    expect(sentence).toMatch(/\(through gh: .*fatal: .*; through git's own credentials: .*fatal: /);
    expect(sentence).toContain("run `gh auth login`");
    expect(sentence.indexOf("`gh auth login`")).toBeLessThan(
      sentence.indexOf("`gh auth setup-git`"),
    );
    expect(leftovers(cache)).toEqual([]);
  }, 60_000);
});
