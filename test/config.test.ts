import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { FileSystem, Path } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { ConfigProvider, Effect, Either, Layer } from "effect";
import {
  BessemerConfig,
  defaultConfig,
  defaultConfigFor,
  loadConfig,
} from "../src/config/config.ts";
import {
  BESSEMER_DIRNAME,
  bessemerDir,
  findRepoRoot,
  packagePathspec,
  packageRoot,
  resolveRuntimeRoot,
  resolveSandboxEnvFile,
  resolveTasksDir,
} from "../src/config/paths.ts";
import { substitute } from "../src/init/stamp.ts";

// A scratch served repo: a temp root with its bessemer directory made, which
// is the only place the chain looks for the two files (T57). `fs` is read off
// the context rather than passed, so a case reads `yield* servedRepo` where it
// used to read `yield* fs.makeTempDirectoryScoped()`.
const servedRepo = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped();
  yield* fs.makeDirectory(bessemerDir(root));
  return root;
}).pipe(Effect.orDie);

// A deterministic empty environment: the host's real BESSEMER_* variables
// must not leak into these tests.
const emptyEnv = ConfigProvider.fromMap(new Map());

const envOf = (entries: Record<string, string>) =>
  ConfigProvider.fromMap(new Map(Object.entries(entries)), { pathDelim: "_" });

// `image` and `base` have no code default (T40), so every temp root here has to
// declare them. A function and not a constant: a test that is *about* `image`
// supplies its own, and TOML refuses the same key twice.
const required = (image = "baseline-image") => `image = "${image}"\nbase = "origin/main"\n`;

describe("config precedence chain", () => {
  it.scoped("flags > env > local > committed > defaults, at every step", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* servedRepo;

      // code defaults, for the keys that still have one
      yield* fs.writeFileString(path.join(bessemerDir(root), "config.toml"), required());
      const fromDefaults = yield* loadConfig(root, { env: emptyEnv });
      expect(fromDefaults.memory).toBe(defaultConfig.memory);
      expect(fromDefaults.maxReviewRounds).toBe(3);

      // committed beats defaults
      yield* fs.writeFileString(
        path.join(bessemerDir(root), "config.toml"),
        `${required("committed")}max-review-rounds = 4\n`,
      );
      const fromCommitted = yield* loadConfig(root, { env: emptyEnv });
      expect(fromCommitted.image).toBe("committed");
      expect(fromCommitted.maxReviewRounds).toBe(4);
      expect(fromCommitted.memory).toBe(defaultConfig.memory);

      // local beats committed
      yield* fs.writeFileString(
        path.join(bessemerDir(root), "config.local.toml"),
        'image = "local"\n',
      );
      const fromLocal = yield* loadConfig(root, { env: emptyEnv });
      expect(fromLocal.image).toBe("local");
      expect(fromLocal.maxReviewRounds).toBe(4);

      // env beats local
      const env = envOf({ BESSEMER_IMAGE: "from-env" });
      const fromEnv = yield* loadConfig(root, { env });
      expect(fromEnv.image).toBe("from-env");

      // flags beat env
      const fromFlags = yield* loadConfig(root, {
        env,
        flags: new Map([["image", "from-flags"]]),
      });
      expect(fromFlags.image).toBe("from-flags");
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("BESSEMER_* env keys map onto kebab-case config keys", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* servedRepo;
      yield* fs.writeFileString(path.join(bessemerDir(root), "config.toml"), required());
      const config = yield* loadConfig(root, {
        env: envOf({
          BESSEMER_MAX_REVIEW_ROUNDS: "7",
          BESSEMER_PASS_TIMEOUT: "120",
          BESSEMER_NOTIFY: "steps",
        }),
      });
      expect(config.maxReviewRounds).toBe(7);
      expect(config.passTimeoutSeconds).toBe(120);
      expect(config.notify).toBe("steps");
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  // The setup hook's budget (T90), read through the chain `pass-timeout` is:
  // 600 when nobody says, and each layer answering over the one below it.
  it.scoped("decodes setup-timeout from every layer, defaulting to 600", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* servedRepo;
      const committed = path.join(bessemerDir(root), "config.toml");

      yield* fs.writeFileString(committed, required());
      expect((yield* loadConfig(root, { env: emptyEnv })).setupTimeoutSeconds).toBe(600);

      yield* fs.writeFileString(committed, `${required()}setup-timeout = 900\n`);
      expect((yield* loadConfig(root, { env: emptyEnv })).setupTimeoutSeconds).toBe(900);

      const env = envOf({ BESSEMER_SETUP_TIMEOUT: "300" });
      expect((yield* loadConfig(root, { env })).setupTimeoutSeconds).toBe(300);

      const fromFlags = yield* loadConfig(root, {
        env,
        flags: new Map([["setup-timeout", "60"]]),
      });
      expect(fromFlags.setupTimeoutSeconds).toBe(60);
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  // The cap-add list (T6), which is a comma-separated *scalar* precisely so it
  // obeys the chain above. A layer's answer replaces the layer below it whole:
  // a local file asking for one capability gets one capability, not one of its
  // own and the rest of the committed file's (AGENTS.md carries the ruling on
  // why a TOML array cannot do that here).
  it.scoped("reads cap-add as one comma-separated value per layer, replacing whole", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* servedRepo;

      yield* fs.writeFileString(path.join(bessemerDir(root), "config.toml"), required());
      expect((yield* loadConfig(root, { env: emptyEnv })).capAdd).toEqual([]);

      yield* fs.writeFileString(
        path.join(bessemerDir(root), "config.toml"),
        `${required()}cap-add = "CHOWN, SETUID"\n`,
      );
      expect((yield* loadConfig(root, { env: emptyEnv })).capAdd).toEqual(["CHOWN", "SETUID"]);

      yield* fs.writeFileString(
        path.join(bessemerDir(root), "config.local.toml"),
        'cap-add = "KILL"\n',
      );
      expect((yield* loadConfig(root, { env: emptyEnv })).capAdd).toEqual(["KILL"]);

      const fromEnv = yield* loadConfig(root, { env: envOf({ BESSEMER_CAP_ADD: "FOWNER" }) });
      expect(fromEnv.capAdd).toEqual(["FOWNER"]);

      // Declaring none is a value a layer can hold, and it means none.
      const fromFlags = yield* loadConfig(root, {
        env: emptyEnv,
        flags: new Map([["cap-add", ""]]),
      });
      expect(fromFlags.capAdd).toEqual([]);
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  // The setup hook (T7): one scalar path, unset by default, and no
  // hae-specific value anywhere in the package's own layers — which host
  // script runs, or none at all, is something a host declares.
  it.scoped("reads setup-hook as one path per layer, unset by default", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* servedRepo;

      yield* fs.writeFileString(path.join(bessemerDir(root), "config.toml"), required());
      expect((yield* loadConfig(root, { env: emptyEnv })).setupHook).toBe("");

      yield* fs.writeFileString(
        path.join(bessemerDir(root), "config.toml"),
        `${required()}setup-hook = ".box/setup.sh"\n`,
      );
      expect((yield* loadConfig(root, { env: emptyEnv })).setupHook).toBe(".box/setup.sh");

      const fromEnv = yield* loadConfig(root, {
        env: envOf({ BESSEMER_SETUP_HOOK: "/opt/setup.sh" }),
      });
      expect(fromEnv.setupHook).toBe("/opt/setup.sh");
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  // The container's env file (T61): one scalar path per layer, unset by
  // default, and never resolved here — the decode reads the declared string,
  // and `resolveSandboxEnvFile` is what says whether it is inside the repo.
  it.scoped("reads sandbox-env-file as one path per layer, unset by default", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* servedRepo;

      yield* fs.writeFileString(path.join(bessemerDir(root), "config.toml"), required());
      expect((yield* loadConfig(root, { env: emptyEnv })).sandboxEnvFile).toBe("");

      yield* fs.writeFileString(
        path.join(bessemerDir(root), "config.toml"),
        `${required()}sandbox-env-file = ".bessemer/env.sandbox"\n`,
      );
      expect((yield* loadConfig(root, { env: emptyEnv })).sandboxEnvFile).toBe(
        ".bessemer/env.sandbox",
      );

      // A later layer replaces the whole answer, which is what a single path
      // buys over a list: a list-valued key merges per index instead.
      const fromEnv = yield* loadConfig(root, {
        env: envOf({ BESSEMER_SANDBOX_ENV_FILE: ".agentbox/.env.sandbox" }),
      });
      expect(fromEnv.sandboxEnvFile).toBe(".agentbox/.env.sandbox");
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  // The image's build command (T30): the string probe 2 tells a dispatcher to
  // run. Empty by default and declared per repo — a path shipped in the
  // package points into hae's layout from inside every repo that adopts it,
  // which is what the extraction rehearsal caught (T34).
  it.scoped("reads image-build-command per layer, defaulting to unset", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* servedRepo;

      yield* fs.writeFileString(path.join(bessemerDir(root), "config.toml"), required());
      expect((yield* loadConfig(root, { env: emptyEnv })).imageBuildCommand).toBe("");

      yield* fs.writeFileString(
        path.join(bessemerDir(root), "config.toml"),
        `${required()}image-build-command = "make agent-image"\n`,
      );
      expect((yield* loadConfig(root, { env: emptyEnv })).imageBuildCommand).toBe(
        "make agent-image",
      );

      const fromEnv = yield* loadConfig(root, {
        env: envOf({ BESSEMER_IMAGE_BUILD_COMMAND: "scripts/build.sh" }),
      });
      expect(fromEnv.imageBuildCommand).toBe("scripts/build.sh");
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("a schema-violating value fails the decode with a typed ConfigError", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* servedRepo;
      yield* fs.writeFileString(
        path.join(bessemerDir(root), "config.toml"),
        `${required()}notify = "loud"\n`,
      );
      const outcome = yield* Effect.either(loadConfig(root, { env: emptyEnv }));
      expect(Either.isLeft(outcome)).toBe(true);
      if (Either.isLeft(outcome)) {
        expect(outcome.left._tag).toBe("ConfigError");
        expect(outcome.left.detail).toContain("notify");
      }
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("an unparsable committed file fails the decode, not the fallback chain", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* servedRepo;
      yield* fs.writeFileString(path.join(bessemerDir(root), "config.toml"), "image = [unclosed\n");
      const outcome = yield* Effect.either(loadConfig(root, { env: emptyEnv }));
      expect(Either.isLeft(outcome)).toBe(true);
    }).pipe(Effect.provide(NodeContext.layer)),
  );
});

describe("defaults", () => {
  // The ruling T57 put in place of "the package's own root" (05 Q19): the
  // default is a directory *inside* the served repo and is equal to neither
  // the served repo's root nor the package's. Under the shim the package is a
  // cache clone every served repo shares, so a runtime root beside it would
  // pool every adopter's checkouts, locks, and ledger in one place — and a
  // repin would carry them off.
  it.scoped("the runtime root defaults to the served repo's .bessemer/", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* servedRepo;
      yield* fs.writeFileString(path.join(bessemerDir(root), "config.toml"), required());
      const config = yield* loadConfig(root, { env: emptyEnv });
      expect(config.runtimeRoot).toBe(bessemerDir(root));
      expect(config.runtimeRoot).not.toBe(root);
      expect(config.runtimeRoot).not.toBe(packageRoot);
      expect(config.runtimeRoot).not.toContain(".agentbox");
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  // A declared `runtime-root` moves the writes, and where a relative one lands
  // is the served repo — never the working directory, which 19 §1 retired from
  // every answer this tool gives.
  it.scoped("resolves a declared runtime root against the served repo, absolute as-is", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* servedRepo;
      const file = path.join(bessemerDir(root), "config.toml");

      yield* fs.writeFileString(file, `${required()}runtime-root = "state/box"\n`);
      expect((yield* loadConfig(root, { env: emptyEnv })).runtimeRoot).toBe(
        path.join(root, "state", "box"),
      );

      yield* fs.writeFileString(file, `${required()}runtime-root = "/var/lib/bessemer"\n`);
      expect((yield* loadConfig(root, { env: emptyEnv })).runtimeRoot).toBe("/var/lib/bessemer");
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  // Where the chain looks, stated as the two places it does not (19 §2): the
  // served repo's own root, which is where a config file would sit if the
  // bessemer directory did not exist, and the package, which every served repo
  // shares under the shim. A file in either is not this repo's config, and the
  // decode refuses by name rather than reading somebody else's answers.
  it.scoped("reads the bessemer directory and neither the repo root nor the package", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* servedRepo;
      yield* fs.writeFileString(path.join(root, "config.toml"), required("at-the-repo-root"));

      const ignored = yield* Effect.either(loadConfig(root, { env: emptyEnv }));
      expect(Either.isLeft(ignored)).toBe(true);
      if (Either.isLeft(ignored)) {
        expect(ignored.left.detail).toContain("image");
      }

      // The package's own committed config is a real file with a real
      // `image` in it, and it is not this served repo's answer either.
      yield* fs.writeFileString(path.join(bessemerDir(root), "config.toml"), required("its-own"));
      const decoded = yield* loadConfig(root, { env: emptyEnv });
      expect(decoded.image).toBe("its-own");
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("the committed .bessemer/config.toml travels with the repo and decodes alone", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      // The real committed file, through the real decode, but **alone**. No
      // root override reads the whole chain instead, and `config.local.toml`
      // is gitignored — so these assertions would report on whichever host ran
      // the suite: green in every container and on every fresh clone, red only
      // on one that set a key here by hand. That is AGENTS.md's
      // host-dependence rule, and the gate structurally cannot catch it.
      const root = yield* servedRepo;
      const committed = yield* fs.readFileString(
        path.join(bessemerDir(findRepoRoot(packageRoot)), "config.toml"),
      );
      // This repo is the package, so it carries no pin (T120): nothing
      // self-hosted reads one.
      expect(committed).not.toMatch(/^tool-sha/m);
      yield* fs.writeFileString(path.join(bessemerDir(root), "config.toml"), committed);

      const config = yield* loadConfig(root, { env: emptyEnv });
      // It answers the two keys the package will not answer for anyone (T40).
      expect(config.image).not.toBe("");
      expect(config.base).not.toBe("");
      // And names this repo's own host assets: `.agentbox/` is hae's carried
      // oracle (so the extraction ruled), never this host's dispatch directory.
      expect(config.imageBuildCommand).not.toContain(".agentbox");
      expect(config.imageBuildCommand).toBe("node src/bin.ts image build");
      expect(config.setupHook).not.toBe("");
      expect(config.setupHook).not.toContain(".agentbox");

      // The hook has to resolve to a file that exists. A declared asset left
      // untracked passes every shape assertion above and then refuses the next
      // dispatch (`setupHookFound`), and a fresh clone is the only place it
      // shows. The build command is a command, not a path (T112), and the tag
      // it builds comes from `image` above, so nothing is left to agree with.
      const repoRoot = findRepoRoot(packageRoot);
      expect(yield* fs.exists(path.join(repoRoot, config.setupHook))).toBe(true);

      // The third declared path, and the one rooting changed (18 step 2). It
      // is repo-root-relative like the two above, so this repo's own `tasks/`
      // is what a bare spec name resolves under and what doctor's probe stats;
      // a value still naming the pre-18 nesting resolves under a directory
      // neither of them finds, and only resolving it against this checkout
      // shows that.
      const tasksDir = resolveTasksDir(repoRoot, config.tasksDir);
      expect(tasksDir).toBe(path.join(repoRoot, "tasks"));
      expect(yield* fs.exists(tasksDir)).toBe(true);
    }).pipe(Effect.provide(NodeContext.layer)),
  );
});

// The pin is not a config key (SPEC §6, T120): the shim reads it before the
// package exists, so the chain decodes no `tool-sha` — and an adopter's file,
// which always carries one, still decodes, because unknown keys are ignored.
describe("the pin is not a config key", () => {
  it.scoped("the scaffold's config.toml, substituted, decodes with its tool-sha line", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* servedRepo;
      const template = yield* fs.readFileString(path.join(packageRoot, "templates", "config.toml"));
      const text = Either.getOrThrow(
        substitute(template, {
          image: "acme-bessemer",
          base: "origin/trunk",
          "tool-sha": "0123456789abcdef0123456789abcdef01234567",
        }),
      );
      expect(text).toMatch(/^tool-sha = "0123456789abcdef0123456789abcdef01234567"$/m);
      yield* fs.writeFileString(path.join(bessemerDir(root), "config.toml"), text);

      const config = yield* loadConfig(root, { env: emptyEnv });
      expect(config).not.toHaveProperty("toolSha");
      expect(config).toEqual({
        ...defaultConfigFor(root),
        image: "acme-bessemer",
        base: "origin/trunk",
        tasksDir: ".bessemer/tasks",
        imageBuildCommand: ".bessemer/bessemer image build",
      });
    }).pipe(Effect.provide(NodeContext.layer)),
  );
});

// `image` and `base` are one repo's answers (T40), on the rule
// `image-build-command` and `setup-hook` already follow. Missing is refused by
// name rather than silently filled with whichever repo wrote the package.
describe("the keys the package ships no answer for", () => {
  it.scoped("refuses a config that declares no image, naming the key", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* servedRepo;
      yield* fs.writeFileString(
        path.join(bessemerDir(root), "config.toml"),
        'base = "origin/main"\n',
      );
      const outcome = yield* Effect.either(loadConfig(root, { env: emptyEnv }));
      expect(Either.isLeft(outcome)).toBe(true);
      if (Either.isLeft(outcome)) {
        expect(outcome.left._tag).toBe("ConfigError");
        expect(outcome.left.detail).toContain("image");
      }
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("refuses a config that declares no base, naming the key", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* servedRepo;
      yield* fs.writeFileString(
        path.join(bessemerDir(root), "config.toml"),
        'image = "some-image"\n',
      );
      const outcome = yield* Effect.either(loadConfig(root, { env: emptyEnv }));
      expect(Either.isLeft(outcome)).toBe(true);
      if (Either.isLeft(outcome)) {
        expect(outcome.left._tag).toBe("ConfigError");
        expect(outcome.left.detail).toContain("base");
      }
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  // The refusal is about the chain having no answer, not about which layer
  // holds one.
  it.scoped("takes the answers from any layer, a file included", () =>
    Effect.gen(function* () {
      const root = yield* servedRepo;
      const config = yield* loadConfig(root, {
        env: envOf({ BESSEMER_IMAGE: "from-env", BESSEMER_BASE: "origin/trunk" }),
      });
      expect(config.image).toBe("from-env");
      expect(config.base).toBe("origin/trunk");
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  // `defaultConfig` keeps the fields because `app.ts` falls back to the whole
  // record on a failed decode. Empty there means "nobody has said", as it
  // already does for `setup-hook` and `image-build-command`.
  it("carries no repo's answer in the code defaults", () => {
    expect(defaultConfig.image).toBe("");
    expect(defaultConfig.base).toBe("");
  });
});

// The one derivation of the bessemer directory (CONTEXT.md), and the
// resolution every write location's root goes through. Pure, so they are
// asserted against trees named here rather than against this checkout.
describe("the bessemer directory", () => {
  it("is `.bessemer` under the served repo, spelled once", () => {
    expect(BESSEMER_DIRNAME).toBe(".bessemer");
    expect(bessemerDir("/srv/hae")).toBe(join("/srv/hae", ".bessemer"));
    // Derived from the served repo, never from the package: under the shim the
    // package is a cache clone every served repo shares.
    expect(bessemerDir("/srv/hae")).not.toBe(bessemerDir("/srv/other"));
  });

  it("resolves a relative runtime root against the repo and takes an absolute one as-is", () => {
    expect(resolveRuntimeRoot("/srv/hae", ".bessemer")).toBe(join("/srv/hae", ".bessemer"));
    expect(resolveRuntimeRoot("/srv/hae", "state/box")).toBe(join("/srv/hae", "state", "box"));
    expect(resolveRuntimeRoot("/srv/hae", "/var/lib/bessemer")).toBe("/var/lib/bessemer");
  });
});

// The one config-declared path that is refused rather than resolved when it
// points outside the served repo (T61, 19 §5): it is the only key whose
// file's *contents* enter the container, so it stays where review sees it.
describe("the sandbox env file's path rule", () => {
  it("answers none for an undeclared key, whitespace included", () => {
    expect(resolveSandboxEnvFile("/srv/hae", "")).toEqual({ _tag: "None" });
    // Whitespace is a key someone emptied, not a file called " " — the same
    // reading `resolveSetupHookPath` gives it.
    expect(resolveSandboxEnvFile("/srv/hae", "   ")).toEqual({ _tag: "None" });
  });

  it("resolves a relative value against the served repo", () => {
    expect(resolveSandboxEnvFile("/srv/hae", ".agentbox/.env.sandbox")).toEqual({
      _tag: "Inside",
      path: join("/srv/hae", ".agentbox", ".env.sandbox"),
    });
    // Normalized, so an interior `..` that stays inside is still inside.
    expect(resolveSandboxEnvFile("/srv/hae", "a/../.bessemer/env.sandbox")).toEqual({
      _tag: "Inside",
      path: join("/srv/hae", ".bessemer", "env.sandbox"),
    });
  });

  it("refuses an absolute value instead of taking it as-is", () => {
    const outside = resolveSandboxEnvFile("/srv/hae", "/etc/secrets/.env");
    expect(outside._tag).toBe("Outside");
    // The reason travels with the arm, because the guard has to say which of
    // the three this was.
    expect(outside).toEqual({
      _tag: "Outside",
      reason: "'/etc/secrets/.env' is an absolute path",
    });
    // And this is the deliberate divergence from the other two path keys,
    // which take an absolute value as-is.
    expect(resolveTasksDir("/srv/hae", "/var/specs")).toBe("/var/specs");
  });

  it("refuses a value that leaves the repo after normalization", () => {
    for (const escaping of ["../.env", "a/../../.env", "../hae-other/.env"]) {
      const outside = resolveSandboxEnvFile("/srv/hae", escaping);
      expect(outside._tag).toBe("Outside");
      expect(outside).toHaveProperty("reason", expect.stringContaining(escaping));
    }
    // A sibling repo whose name merely starts with this one's is outside too:
    // containment is measured in path segments, not in characters.
    expect(resolveSandboxEnvFile("/srv/hae", "../haevil/.env")._tag).toBe("Outside");
  });
});

// The repo root is what the `bessemer.repo` ownership label hashes, so these
// pin the walk against trees built here rather than against whatever repo the
// suite happens to run inside — the host-dependence rule in AGENTS.md.
describe("the repo root walk", () => {
  it.scoped("walks up to the enclosing repo root", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repo = yield* fs.makeTempDirectoryScoped();
      yield* fs.makeDirectory(path.join(repo, ".git"));
      const nested = path.join(repo, "bessemer", "src", "config");
      yield* fs.makeDirectory(nested, { recursive: true });
      expect(findRepoRoot(nested)).toBe(repo);
      expect(findRepoRoot(repo)).toBe(repo);
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("honours a .git file, which is what a worktree checkout has", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const worktree = yield* fs.makeTempDirectoryScoped();
      yield* fs.writeFileString(
        path.join(worktree, ".git"),
        "gitdir: /elsewhere/.git/worktrees/w\n",
      );
      const nested = path.join(worktree, "bessemer");
      yield* fs.makeDirectory(nested);
      expect(findRepoRoot(nested)).toBe(worktree);
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("stops at the nearest repo, so a nested checkout gets its own label", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const outer = yield* fs.makeTempDirectoryScoped();
      yield* fs.makeDirectory(path.join(outer, ".git"));
      const inner = path.join(outer, "checkouts", "t2");
      yield* fs.makeDirectory(path.join(inner, ".git"), { recursive: true });
      expect(findRepoRoot(inner)).toBe(inner);
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("falls back to where it started when nothing above is a repo", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      // A temp dir has no `.git` anywhere above it, so the walk runs to `/`
      // and returns the starting directory rather than the filesystem root —
      // a label scoped to `/` would collide across every non-repo host.
      const orphan = yield* fs.makeTempDirectoryScoped();
      expect(findRepoRoot(orphan)).toBe(orphan);
    }).pipe(Effect.provide(NodeContext.layer)),
  );
});

// T42's scope, named by 18 and stated in T49: a fact about where the package
// sits, not a config key — so it is asked of `packageRoot` and the repo root
// rather than declared anywhere.
describe("packagePathspec", () => {
  it("is bare entry names, with no prefix, when the package sits at the repo root itself", () => {
    // This checkout, since rooting: the walk up for `.git` from the package
    // lands on the package. Asserted rather than assumed, because it is what
    // makes the render below the bare-name arm.
    expect(findRepoRoot(packageRoot)).toBe(packageRoot);
    expect(packagePathspec(findRepoRoot(packageRoot))).toEqual([
      "src",
      "prompts",
      "templates",
      "package.json",
      "package-lock.json",
      "tsconfig.json",
      "scripts",
    ]);
  });

  // The prefixed arm, which rooting took away from this checkout and which a
  // package nested in the repo serving it still has. Asked of the directory
  // above the package, so it stays a fact about the derivation rather than
  // about where this checkout happens to sit.
  it("is each source entry prefixed by the package's location, `/`-separated", () => {
    const here = basename(packageRoot);
    expect(packagePathspec(dirname(packageRoot))).toEqual([
      `${here}/src`,
      `${here}/prompts`,
      `${here}/templates`,
      `${here}/package.json`,
      `${here}/package-lock.json`,
      `${here}/tsconfig.json`,
      `${here}/scripts`,
    ]);
  });
});

describe("BessemerConfig tag", () => {
  it.effect("consumers read the decoded record from the tag (Layer.succeed over a literal)", () =>
    Effect.gen(function* () {
      const config = yield* BessemerConfig;
      expect(config.image).toBe("from-literal");
      expect(config.maxReviewRounds).toBe(9);
    }).pipe(
      Effect.provide(
        Layer.succeed(BessemerConfig, {
          ...defaultConfigFor(packageRoot),
          image: "from-literal",
          maxReviewRounds: 9,
        }),
      ),
    ),
  );
});
