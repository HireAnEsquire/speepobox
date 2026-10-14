import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Option } from "effect";

// The package's own root (the directory holding package.json), resolved from
// this source file so it is right in a checkout and under the clone-run
// shim's cache clone alike. Plain constant, no tag (SPEC §2).
export const packageRoot: string = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

// The templates `init` writes the scaffold from (T113, T114): part of the
// package, so a package read, and handed to `init` from `bin.ts` as a
// parameter rather than imported where it is read (SPEC §9).
export const templatesRoot: string = join(packageRoot, "templates");

// The speepobox directory (CONTEXT.md): the one directory speepobox keeps inside
// a served repo — its committed config, the operator's private settings and
// credential, and by default its runtime state. The name is spelled once,
// here, so no caller writes the literal a second time, and it is derived from
// the **served repo** and never from the package: under the clone-run shim the
// package is a cache clone every served repo shares, so one `.speepobox` beside
// it would be every adopter's at once (19 §2).
export const SPEEPOBOX_DIRNAME = ".speepobox";

export const speepoboxDir = (repoRoot: string): string => join(repoRoot, SPEEPOBOX_DIRNAME);

// Where write locations resolve against: the configured `runtime-root`, taken
// as-is when it is absolute and resolved against the **repo root** otherwise.
// `resolveTasksDir` below is the precedent, and 19 §1 is the reason — a
// relative value used unresolved means "against the working directory", and
// the working directory is retired from every answer this tool gives. The
// default is `speepoboxDir(repoRoot)`, which the descriptor supplies.
export const resolveRuntimeRoot = (repoRoot: string, runtimeRoot: string): string =>
  isAbsolute(runtimeRoot) ? runtimeRoot : join(repoRoot, runtimeRoot);

// Where one-off specs live: the configured `tasks-dir`, taken as-is when it is
// absolute and resolved against the **repo root** otherwise. One definition
// because two callers need the same answer — doctor's tasks-dir probe and the
// dispatch guard that turns a bare spec name into a path — and a bare name
// resolving somewhere doctor never looked is exactly the drift a second copy
// buys.
//
// The repo root and not the runtime root: bash anchors its tasks dir there by
// `cd`-ing to it first (`run.sh:235-236`, `TASKS_DIR="$BOX/tasks"`), and 05 Q19
// scopes the runtime root to the ledger, the locks, and the checkouts — write
// locations. A spec is a read location, so resolving one under the runtime root
// conflates the two.
export const resolveTasksDir = (repoRoot: string, tasksDir: string): string =>
  isAbsolute(tasksDir) ? tasksDir : join(repoRoot, tasksDir);

// What the dispatcher-freshness question (T42) scopes to: not the package
// directory — that was a coincidence of nesting, disproved by ticket 18's
// pricing of the package's move — but a named set of source paths, ruled by
// 18 and stated once here. `prompts/` ships with the tool and is read by
// every pass, so a changed prompt is a changed dispatcher, and `templates/`
// ships with it and is what `init` writes from (T113); `test/`,
// `tasks/`, and `config.toml` are deliberately not in it (see T49). It stays
// in `scripts/` too, even though nothing inside a dispatch runs it, because
// under-inclusion here fails silently and over-inclusion fails loudly.
const packageSourceEntries = [
  "src",
  "prompts",
  "templates",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "scripts",
] as const;

// Each entry above, joined to the package's own location relative to the
// repo root and rendered with git's pathspec separator (`/`, regardless of
// host, the way `imageProbe`'s declared inputs already are). `join` renders
// a bare entry name when the package sits at the repo root — `rel` is `""`
// there — so there is no arm for "rooted" versus "nested"; a pathspec built
// from a named entry can never be empty, the hazard git's own error for an
// empty pathspec exists to name.
export const packagePathspec = (repoRoot: string): ReadonlyArray<string> => {
  const rel = relative(repoRoot, packageRoot);
  return packageSourceEntries.map((entry) => join(rel, entry).split(sep).join("/"));
};

// The setup hook's host script (T7): the configured `setup-hook`, taken as-is
// when it is absolute and resolved against the **repo root** otherwise — a
// read location, anchored where a spec path is anchored and for the same
// reason. Nothing hae-specific is baked in anywhere: which script, or none at
// all, is a config layer's answer.
//
// The `Option` is the "none at all" arm, and it is a shape rather than an
// empty string travelling on: a config that names no hook skips the step and
// the run proceeds, so the two cases are distinguished once, here, instead of
// at every caller. Whether a named script *exists* is the guard's question
// (`dispatch/guards.ts`); this stays pure.
export const resolveSetupHookPath = (
  repoRoot: string,
  setupHook: string,
): Option.Option<string> => {
  const named = setupHook.trim();
  return named === ""
    ? Option.none()
    : Option.some(isAbsolute(named) ? named : join(repoRoot, named));
};

// The sandbox env file (T61), and what a config's declared value turned out
// to be: no file at all, a file inside the served repo, or a value refused
// before anything is acquired. A union rather than an `Option` because the
// third arm carries *why* — a guard has to say which of the three it was, and
// a resolver that folded "outside" into "none" would hand the container a
// silently empty environment instead of a refusal.
//
// **Speepobox never opens the file; docker reads it.** That is *why* its values
// cannot reach argv, a log, the ledger, or an event — the path may appear in
// any of them, the contents never. This resolver answers a path and nothing
// else, and nothing under `src/` reads what is in it (19 §5).
export type SandboxEnvFile =
  | { readonly _tag: "None" }
  | { readonly _tag: "Inside"; readonly path: string }
  | { readonly _tag: "Outside"; readonly reason: string };

// Inside means: the declared value is relative, and its normalized join onto
// the repo root still starts with the repo root — so `../x` and `a/../../x`
// are outside, and so is any absolute value.
//
// This is on purpose the opposite of `tasks-dir` and `setup-hook` above, which
// take an absolute value as-is: this is the only key whose file's *contents*
// enter the sandbox, so the file stays inside the served repo, where review
// sees it (19 §5). Whether a named file *exists* is the guard's question
// (`dispatch/guards.ts`); this stays pure.
export const resolveSandboxEnvFile = (repoRoot: string, declared: string): SandboxEnvFile => {
  const named = declared.trim();
  if (named === "") {
    return { _tag: "None" };
  }
  if (isAbsolute(named)) {
    return { _tag: "Outside", reason: `'${named}' is an absolute path` };
  }
  const resolved = join(repoRoot, named);
  const prefix = repoRoot.endsWith(sep) ? repoRoot : `${repoRoot}${sep}`;
  return resolved.startsWith(prefix)
    ? { _tag: "Inside", path: resolved }
    : { _tag: "Outside", reason: `'${named}' leaves the repo, resolving to ${resolved}` };
};

// The enclosing repo root, found by walking up for a `.git` entry, falling
// back to the starting directory when nothing above it is a repo.
//
// Why a path walk and not `git rev-parse --show-toplevel`: this is what the
// `speepobox.repo` ownership label hashes, and `status` runs no git commands
// (SPEC §7). It is a host read, so it is called from the composition root and
// reaches commands as a parameter.
export const findRepoRoot = (from: string): string => {
  let directory = from;
  for (;;) {
    if (existsSync(join(directory, ".git"))) {
      return directory;
    }
    const parent = dirname(directory);
    if (parent === directory) {
      return from;
    }
    directory = parent;
  }
};
