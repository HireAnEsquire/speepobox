// Grep bans (SPEC §9), wired into `npm run lint` from T1 — added while there
// is nothing to fix:
//   1. `Command` imported outside src/internal/exec.ts (the subprocess
//      chokepoint is the only file allowed to touch it)
//   2. `Command.runInShell`
//   3. `Effect.runPromise` — NodeRuntime.runMain is the only entrypoint idiom
//   4. container-name-based ownership queries — a docker `name=` filter.
//      Ownership is declared by label, never inferred from a name (design
//      rule 3); prefix sweeping of `agentbox-*` is retired everywhere,
//      including gc. The old spelling is the right one here and stays: the
//      sweep that was retired is bash's, and `bessemer-*` was never swept,
//      so it has no retirement to record. T65 moved this line and put the
//      sentence at odds with its two other copies (`ownership/labels.ts:4`,
//      SPEC §7); restored on review.
//   5. `--dry-run` named anywhere in src/ but the four places it may be
//      (T15, SPEC §11 design rule 5). The rehearsal is a layer swap: the
//      entrypoint picks `appDryRunLiveFor` over `appLiveFor` and every dispatch op
//      below it runs one code path with no flag on it. An op that branched on
//      the flag would be the second dispatch path the swap exists to delete —
//      `run.sh:1647-1724`, which re-derives slug, container, checkout, log,
//      and the `gh pr view` probe, and drifts from the run it describes.
//   6. `@clack/prompts` imported outside src/prompt/clack.ts — the live
//      `Prompt` layer is the one file that speaks to the terminal library
//      (T81, SPEC §2). Everything else speaks the tag, which is what a
//      scripted fake can stand in at; a second importer is a second opinion
//      about cancel, about filtering, and about the interrupt bracket, and
//      none of the three is assertable from out here.
//   7. `packageRoot` imported anywhere in src/ but the three places the
//      package legitimately reads itself (T62, 19 §8). Every other read is a
//      served-repo read and resolves against `repoRoot`; under the clone-run
//      shim the package is a cache clone every served repo shares, so a
//      `packageRoot` join there answers for somebody else's repo — the
//      conflation this rule makes a lint error rather than a review note.
// Scans src/ and test/; this script is outside its own scan scope on purpose
// (the patterns below would trip it).
import { readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";

const ROOTS = ["src", "test"];
const CHOKEPOINT = join("src", "internal", "exec.ts");
// The live `Prompt` layer, and the only file that may name the prompt
// library. Scoped to both roots like the chokepoint above it: a test that
// reached for clack directly would be a test of clack rather than of this
// package's shape.
const CLACK_SITE = join("src", "prompt", "clack.ts");
const CLACK_MODULE = "@clack/prompts";

// Where `--dry-run` may be named at all: the composition that holds the third
// layer and the flag that picks it, the entrypoint that calls it, the parser
// that declares the flag so `--help` says it exists, and the recording layers
// themselves — which take no flag and only carry the directory in their import
// paths. The ban is scoped to `src/`: a test says the word to assert it.
const DRY_RUN_SITES = [
  join("src", "app.ts"),
  join("src", "bin.ts"),
  join("src", "dispatch", "command.ts"),
];
const DRY_RUN_DIR = join("src", "dry-run");

const mayNameDryRun = (file: string): boolean =>
  !file.startsWith(`src${sep}`) ||
  DRY_RUN_SITES.includes(file) ||
  file.startsWith(`${DRY_RUN_DIR}${sep}`);

// Where the package may read its own location (19 §8): the definition and the
// freshness pathspec built from it, the default prompts that ship beside the
// code, and the entrypoint's three package facts — the no-flag fallback, the
// dispatcher's own revision, and the `selfHosted` predicate. Scoped to `src/`
// like the rule above it: a test imports `packageRoot` to build the
// expectation that a served-repo read did *not* land there.
const PACKAGE_ROOT_SITES = [
  join("src", "config", "paths.ts"),
  join("src", "agent", "prompt.ts"),
  join("src", "bin.ts"),
];

const mayImportPackageRoot = (file: string): boolean =>
  !file.startsWith(`src${sep}`) || PACKAGE_ROOT_SITES.includes(file);

interface Violation {
  readonly file: string;
  readonly line: number;
  readonly ban: string;
}

const tsFiles = (dir: string): Array<string> =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      return tsFiles(full);
    }
    return entry.name.endsWith(".ts") ? [full] : [];
  });

const IMPORT_RE = /import\s+(?:type\s+)?(\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+["']([^"']+)["']/g;

const violationsIn = (file: string): Array<Violation> => {
  const found: Array<Violation> = [];
  const lines = readFileSync(file, "utf8").split("\n");
  // Comments may *name* a banned idiom (that is how the bans are documented
  // at their sites); only code trips them.
  const stripped = lines.map((raw) => raw.replace(/\/\/.*$/, ""));
  stripped.forEach((text, index) => {
    const line = index + 1;
    if (/\brunInShell\b/.test(text)) {
      found.push({ file, line, ban: "Command.runInShell is banned" });
    }
    if (/\bEffect\.runPromise/.test(text)) {
      found.push({ file, line, ban: "Effect.runPromise is banned — NodeRuntime.runMain only" });
    }
    // The flag, in code, outside the four places that may name it — an op
    // asking whether this is a dry run, a second layer selection, a `dryRun`
    // field threaded down a signature. Comments are already stripped above,
    // so the modules that *explain* the swap stay legal.
    if (!mayNameDryRun(file) && /dry[\s_-]*run/i.test(text)) {
      found.push({
        file,
        line,
        ban: "--dry-run is consulted at the entrypoint only — a dispatch op that branches on it is the second dispatch path the layer swap deletes (T15)",
      });
    }
    // A docker filter expression on the container name. Rendering a name is
    // fine; selecting on one is not.
    if (/(?:^|[^\w.])name=/.test(text)) {
      found.push({
        file,
        line,
        ban: "ownership queries must filter on the bessemer.managed/bessemer.repo labels, never on container name",
      });
    }
  });
  // Imports are matched against the whole file, not per line: oxfmt wraps a
  // long import clause across lines, and a line-scoped scan misses it.
  const text = stripped.join("\n");
  for (const match of text.matchAll(IMPORT_RE)) {
    const [, clause, specifier] = match;
    const lineOf = () => text.slice(0, match.index).split("\n").length;
    const importsCommandModule = specifier === "@effect/platform/Command";
    const importsCommandBinding =
      specifier === "@effect/platform" &&
      clause !== undefined &&
      /(?:^|[{,\s])Command(?:[,\s}]|$)/.test(clause);
    if (file !== CHOKEPOINT && (importsCommandModule || importsCommandBinding)) {
      found.push({
        file,
        line: lineOf(),
        ban: "Command may only be imported by src/internal/exec.ts (the subprocess chokepoint)",
      });
    }
    if (file !== CLACK_SITE && specifier === CLACK_MODULE) {
      found.push({
        file,
        line: lineOf(),
        ban: `${CLACK_MODULE} may only be imported by ${CLACK_SITE} — every other module speaks the Prompt tag, which is the seam a scripted fake stands in at (T81)`,
      });
    }
    // The name itself, wherever it is imported from: the clause is what a
    // conflation has to name, since the constant is the package's own
    // location and nothing derives it a second way.
    if (
      !mayImportPackageRoot(file) &&
      clause !== undefined &&
      /(?:^|[{,\s])packageRoot(?:[,\s}]|$)/.test(clause)
    ) {
      found.push({
        file,
        line: lineOf(),
        ban: `packageRoot may only be imported by ${PACKAGE_ROOT_SITES.join(", ")} — a served-repo read resolves against repoRoot; packageRoot is the package's own location and may be read only where the package reads itself (19 §8)`,
      });
    }
  }
  return found;
};

const violations = ROOTS.flatMap(tsFiles).flatMap(violationsIn);

if (violations.length > 0) {
  for (const violation of violations) {
    console.error(`${violation.file}:${violation.line}: ${violation.ban}`);
  }
  process.exit(1);
}
