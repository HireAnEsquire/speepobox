import { ConfigFile } from "@effect/cli";
import type { FileSystem, Path } from "@effect/platform";
import { Config, ConfigProvider, Context, Data, Effect, Layer } from "effect";
import { bessemerDir, resolveRuntimeRoot } from "./paths.ts";

export interface BessemerConfigShape {
  // The agent image's tag. No code default (T40): an image is built by one
  // repo's script out of one repo's files, so it is that repo's to name — the
  // rule `imageBuildCommand` states below.
  readonly image: string;
  // What `doctor` and the dispatch preflight name when the image is absent, or
  // was built against different dependency contents than the repo now holds
  // (T30). Config-declared and empty by default, on `setupHook`'s rule: the
  // script that builds a repo's agent image is that repo's, so a path here
  // that ships with the package is a pointer into hae's layout that dangles
  // the moment the package lives anywhere else. hae declares its own in
  // `config.toml`; the probe's messages read without one.
  readonly imageBuildCommand: string;
  // The ref a dispatch diffs and branches from. No code default (T40), and for
  // a sharper reason than `image`: a wrong tag fails at `docker run`, where a
  // wrong base succeeds and hands the agent the wrong diff boundary.
  readonly base: string;
  readonly maxReviewRounds: number;
  // The budget one agent pass gets before it is killed. Raised from bash's 900
  // to 1800 on 2026-09-08, on the record of the five self-hosted dispatches
  // that ran under 900: the two that finished used 91% and 95% of it, and the
  // three that were killed include one whose work was complete and green,
  // committed four seconds before the kill. A wall that lands mid-completion
  // says nothing about the size of what it cut, and that is the whole of why
  // it moved.
  //
  // Not because a pass expands to fill whatever it is given. That was the
  // first reading of the clustering and the next two runs refuted it: T45 had
  // 1800 and used 415, and T39 — five commits, a new module, a production
  // probe rewired — used 1231. A pass leaves slack in proportion to what it
  // was asked for, so those five were five large tickets and not an elastic
  // pass. How much of the budget a pass used is worth reading — just not at
  // the wall, where a kill is a fact about the wall rather than about the
  // ticket.
  readonly passTimeoutSeconds: number;
  // The budget the setup hook gets before it is killed (T90), on the pass
  // budget's terms: the caller's cap, never a `timeout` inside the container.
  // 600 because the hook is one install on a warm cache, not a pass — the run
  // that found this sat nine minutes on an `npm ci` against a stalled
  // registry, and ten is the wall a dispatcher waiting on it would have drawn.
  readonly setupTimeoutSeconds: number;
  readonly pidsLimit: number;
  readonly memory: string;
  // The capabilities added back after `--cap-drop ALL` (T6). Config-declared,
  // never a code default: the sandbox drops to none, and a host adds back only
  // what its setup hook's root path demonstrably needs (`run.sh:1260`).
  readonly capAdd: ReadonlyArray<string>;
  // The setup hook's host script (T7), relative to the repo root or absolute.
  // Empty is the whole of "this repo has no setup step": the hook is generic
  // and config-declared, so no path belongs in the package's own defaults —
  // hae's `.agentbox/setup-db.sh` is an example of what a host writes here,
  // never a value this tool ships.
  readonly setupHook: string;
  // The container's environment file (T61), relative to the repo root and
  // refused when it is absolute or leaves the repo — `setup-hook`'s
  // convention for "none at all" (the empty string), and deliberately not its
  // path rule: this is the only key whose file's *contents* enter the
  // sandbox, so it stays inside the served repo where review sees it (19 §5).
  // One path and not a list, because a list-valued key merges per index
  // across the config layers (AGENTS.md's `cap-add` ruling).
  //
  // **Bessemer never opens the file; docker reads it** — the path is all this
  // record ever holds.
  readonly sandboxEnvFile: string;
  readonly notify: "off" | "end" | "steps";
  readonly tasksDir: string;
  readonly runtimeRoot: string;
}

// Keys carried over from bash (run.sh:202-221) —
// every one of them but `runtimeRoot`, which is not a constant (T57): it
// defaults to the served repo's bessemer directory, so it cannot be answered
// without being told which repo is served. `defaultConfigFor` below is the
// whole record; this one is what a caller spreads when it is supplying a
// runtime root of its own.
//
// The five empty strings are absent answers, not defaults: no repo's `image`,
// `base`, `imageBuildCommand`, `setupHook`, or `sandboxEnvFile` belongs to
// this package, and the descriptor below gives none of them a value of its
// own. They keep fields because `defaultConfigFor` spreads this record into
// the degraded config `app.ts` falls back to on a failed decode.
export const defaultConfig: Omit<BessemerConfigShape, "runtimeRoot"> = {
  image: "",
  imageBuildCommand: "",
  base: "",
  maxReviewRounds: 3,
  passTimeoutSeconds: 1800,
  setupTimeoutSeconds: 600,
  pidsLimit: 2048,
  memory: "8g",
  capAdd: [],
  setupHook: "",
  sandboxEnvFile: "",
  notify: "end",
  tasksDir: "tasks",
};

// The whole record, for one served repo: the code defaults above plus the one
// key that is a fact about the repo being served. This is what the tolerant
// layer degrades to on a failed decode — a degraded config still has to know
// where writes go, and the answer is the same directory a good decode gives.
export const defaultConfigFor = (repoRoot: string): BessemerConfigShape => ({
  ...defaultConfig,
  runtimeRoot: bessemerDir(repoRoot),
});

// Malformed or schema-violating config, at startup (SPEC §3). `detail` is the
// human-readable failure a doctor row or a preflight message renders.
export class ConfigError extends Data.TaggedError("ConfigError")<{
  readonly detail: string;
}> {}

// `cap-add = "CHOWN,SETUID"` — one layer's whole answer, in one value. Pure,
// and exported so the shape a host writes is asserted rather than described.
export const parseCapAdd = (value: string): ReadonlyArray<string> =>
  value
    .split(",")
    .map((capability) => capability.trim())
    .filter((capability) => capability !== "");

// Built per served repo, because two of `runtime-root`'s answers depend on
// one: the default is that repo's bessemer directory, and a configured value
// that is relative resolves against that repo rather than against whatever
// directory the operator's shell happened to be standing in (19 §1).
const descriptorFor = (repoRoot: string): Config.Config<BessemerConfigShape> =>
  Config.all({
    // `image` and `base` take no `withDefault` (T40): a chain that answers
    // neither fails the decode, and Effect's message names the missing key.
    image: Config.string("image"),
    imageBuildCommand: Config.string("image-build-command").pipe(
      Config.withDefault(defaultConfig.imageBuildCommand),
    ),
    base: Config.string("base"),
    maxReviewRounds: Config.integer("max-review-rounds").pipe(
      Config.withDefault(defaultConfig.maxReviewRounds),
    ),
    passTimeoutSeconds: Config.integer("pass-timeout").pipe(
      Config.withDefault(defaultConfig.passTimeoutSeconds),
    ),
    setupTimeoutSeconds: Config.integer("setup-timeout").pipe(
      Config.withDefault(defaultConfig.setupTimeoutSeconds),
    ),
    pidsLimit: Config.integer("pids-limit").pipe(Config.withDefault(defaultConfig.pidsLimit)),
    memory: Config.string("memory").pipe(Config.withDefault(defaultConfig.memory)),
    // A comma-separated *scalar*, deliberately not a TOML array (AGENTS.md
    // carries the ruling): a list-valued key read through an `orElse` chain
    // merges the layers **per index** instead of replacing them, so a local
    // `["KILL"]` over a committed `["CHOWN", "SETUID"]` decodes as
    // `["KILL", "SETUID"]`. One string per layer makes precedence mean what it
    // means for every other key here.
    capAdd: Config.string("cap-add").pipe(
      Config.map(parseCapAdd),
      Config.withDefault(defaultConfig.capAdd),
    ),
    setupHook: Config.string("setup-hook").pipe(Config.withDefault(defaultConfig.setupHook)),
    // Read as a string and resolved nowhere here: the three answers a
    // declared value can have are `resolveSandboxEnvFile`'s (T61), and the
    // guard that refuses two of them is the one place that decides what an
    // outside value means. Empty is "this repo declares none".
    sandboxEnvFile: Config.string("sandbox-env-file").pipe(
      Config.withDefault(defaultConfig.sandboxEnvFile),
    ),
    notify: Config.literal(
      "off",
      "end",
      "steps",
    )("notify").pipe(Config.withDefault(defaultConfig.notify)),
    tasksDir: Config.string("tasks-dir").pipe(Config.withDefault(defaultConfig.tasksDir)),
    // Resolved, not taken raw: a relative `runtime-root` is anchored on the
    // served repo, exactly as `tasks-dir` and `setup-hook` are. The default
    // needs no resolving — `bessemerDir` already answers absolutely.
    runtimeRoot: Config.string("runtime-root").pipe(
      Config.map((value) => resolveRuntimeRoot(repoRoot, value)),
      Config.withDefault(bessemerDir(repoRoot)),
    ),
  });

export interface ConfigSources {
  // Flag-provided overrides, already parsed by the CLI layer; they beat
  // every other source. Keys are the config key names (e.g. "image").
  readonly flags?: ReadonlyMap<string, string>;
  // Environment provider, injectable for tests. The real one reads
  // `BESSEMER_*` variables (constant-cased, nested under the prefix).
  readonly env?: ConfigProvider.ConfigProvider;
}

// Effect owns sourcing, we own shape (05 Q7): one provider stack expressing
// flags > env > local > committed. Defaults sit in the descriptor itself.
// The served repo is a parameter and not a constant (19 §2): under the
// clone-run shim the package is a cache clone every served repo shares, so a
// chain that searched beside the package would read one repo's config for all
// of them — and an adopter, whose checkout is not the package's, could
// configure nothing at all.
export const configProviderChain = (
  repoRoot: string,
  sources?: ConfigSources,
): Effect.Effect<ConfigProvider.ConfigProvider, ConfigError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const root = bessemerDir(repoRoot);
    const flags = ConfigProvider.fromMap(new Map(sources?.flags ?? []));
    // nested first, constantCase second: the case mapping must cover the
    // nested prefix too, so "max-review-rounds" reads BESSEMER_MAX_REVIEW_ROUNDS.
    const env = (sources?.env ?? ConfigProvider.fromEnv()).pipe(
      ConfigProvider.nested("bessemer"),
      ConfigProvider.constantCase,
    );
    const fileProvider = (fileName: string) =>
      ConfigFile.makeProvider(fileName, { formats: ["toml"], searchPaths: [root] });
    const local = yield* fileProvider("config.local");
    const committed = yield* fileProvider("config");
    return flags.pipe(
      ConfigProvider.orElse(() => env),
      ConfigProvider.orElse(() => local),
      ConfigProvider.orElse(() => committed),
    );
  }).pipe(Effect.mapError((error) => new ConfigError({ detail: error.message })));

// The decode, once. Dispatch startup runs this inside bessemerConfigLiveFor so a
// malformed config fails before the run exists; doctor runs it directly and
// reports the outcome as probe 7 instead of dying on it.
export const loadConfig = (
  repoRoot: string,
  sources?: ConfigSources,
): Effect.Effect<BessemerConfigShape, ConfigError, FileSystem.FileSystem | Path.Path> =>
  configProviderChain(repoRoot, sources).pipe(
    Effect.flatMap((provider) =>
      descriptorFor(repoRoot).pipe(
        Effect.withConfigProvider(provider),
        Effect.mapError((error) => new ConfigError({ detail: String(error) })),
      ),
    ),
  );

export class BessemerConfig extends Context.Tag("BessemerConfig")<
  BessemerConfig,
  BessemerConfigShape
>() {}

// One layer decodes the chain once into the tag (05 Q7); call sites read the
// tag. A `Config.*` read at a call site typechecks and is wrong (AGENTS.md).
//
// The served repo is a parameter of the layer, so this is a function rather
// than a constant. That is not the shape T27 rejected for `GitLive(repoRoot)`:
// there the objection was that `status` would compose a host fact it never
// asks git anything about, where this layer already reads the host filesystem
// at a root, every command composing it reads the config it decodes, and the
// root it reads at is precisely the fact that says which repo is being served.
export const bessemerConfigLiveFor = (
  repoRoot: string,
): Layer.Layer<BessemerConfig, ConfigError, FileSystem.FileSystem | Path.Path> =>
  Layer.effect(BessemerConfig, loadConfig(repoRoot));
