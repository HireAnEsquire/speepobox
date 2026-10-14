// The templates `init` writes from, and the stamps that let `init --diff` read
// a scaffold file back (T113, 09's E5 and E7). Pure: the templates are files
// under `<packageRoot>/templates/`, read by whoever holds that path (SPEC §9),
// and this module only ever sees their text.
//
// A stamp is one whole `#` comment line,
// `# speepobox-template: <name> v<N> sha256:<12 hex>`, where the digest is the
// template's text with the stamp line removed. Stamped files are never
// substituted, so that digest is the template as written, and a scaffold file
// that still hashes to its own stamp is one nobody has edited.
import { createHash } from "node:crypto";
import { Data, Either, Option } from "effect";

// Every template's version, in the one place it is declared. Bump a template's
// number whenever its text changes: `init --diff` calls a file stamped with a
// lower one behind. `config.toml` is versioned like the rest even though it
// carries no stamp — it is the one substituted file, checked for presence only.
export const TEMPLATE_VERSIONS = {
  "config.toml": 4,
  ".gitignore": 3,
  "image/Dockerfile": 4,
  "image/inputs": 2,
  // The shim (T125), written at `.speepobox/speepobox` (T127) and stamped after
  // its shebang. Bumping a released shim template: copy its text into
  // `test/fixtures/shim/` first, named by version — a package release never
  // stops accepting a call an earlier released shim makes (P6 F17, F18).
  speepobox: 5,
} as const;

export type TemplateName = keyof typeof TEMPLATE_VERSIONS;

// The four `init` writes with a stamp, by their path under `templates/`.
export const STAMPED_TEMPLATES = [
  ".gitignore",
  "image/Dockerfile",
  "image/inputs",
  "speepobox",
] as const;

// The shim's template, which is also its path under the speepobox directory:
// the one scaffold file that is executed, so the one written executable and
// the one whose execute bit `--diff` asks about (T127).
export const SHIM = "speepobox";

export type StampedTemplate = (typeof STAMPED_TEMPLATES)[number];

export interface Stamp {
  readonly name: string;
  readonly version: number;
  readonly digest: string;
}

const STAMP_LINE = /^# speepobox-template: (\S+) v(\d+) sha256:([0-9a-f]{12})$/;

const stampLine = (stamp: Stamp): string =>
  `# speepobox-template: ${stamp.name} v${stamp.version} sha256:${stamp.digest}`;

const digestOf = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex").slice(0, 12);

const withoutStamp = (lines: ReadonlyArray<string>): ReadonlyArray<string> => {
  const at = lines.findIndex((line) => STAMP_LINE.test(line));
  return at === -1 ? lines : [...lines.slice(0, at), ...lines.slice(at + 1)];
};

// The digest of `text` with its stamp line removed — what a pristine file's
// stamp says, and what an edited one no longer hashes to (T116).
export const bodyDigest = (text: string): string =>
  digestOf(withoutStamp(text.split("\n")).join("\n"));

// Lines that must stay ahead of the stamp: a shebang is only one on line 1,
// and a Dockerfile parser directive is honoured only before the first comment
// — which the stamp is.
const SHEBANG = /^#!/;
const PARSER_DIRECTIVE = /^#\s*(syntax|escape|check)\s*=/i;

const leadingLines = (lines: ReadonlyArray<string>): number => {
  let at = 0;
  if (lines.length > 0 && SHEBANG.test(lines[0]!)) at = 1;
  while (at < lines.length && PARSER_DIRECTIVE.test(lines[at]!)) at += 1;
  return at;
};

// Stamps a template's text: the stamp goes on line 1, or after any leading
// lines that must stay first. Removing that line gives back `text` exactly.
export const stamp = (name: string, version: number, text: string): string => {
  const lines = text.split("\n");
  const at = leadingLines(lines);
  const line = stampLine({ name, version, digest: bodyDigest(text) });
  return [...lines.slice(0, at), line, ...lines.slice(at)].join("\n");
};

// The stamp on any line of `text`, or none when there is none — which
// `init --diff` reads as version 0.
export const readStamp = (text: string): Option.Option<Stamp> => {
  for (const line of text.split("\n")) {
    const match = STAMP_LINE.exec(line);
    if (match !== null) {
      return Option.some({ name: match[1]!, version: Number(match[2]), digest: match[3]! });
    }
  }
  return Option.none();
};

// The config template's placeholders: a fixed, named set, substituted in
// `config.toml` only (E7). Not a templating language — no conditionals, no
// loops; each exact `{{name}}` is replaced and anything else in braces fails.
export const CONFIG_PLACEHOLDERS = ["image", "base", "tool-sha"] as const;

export type ConfigPlaceholder = (typeof CONFIG_PLACEHOLDERS)[number];

export class TemplateError extends Data.TaggedError("TemplateError")<{
  readonly detail: string;
}> {}

const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;

const isPlaceholder = (name: string): name is ConfigPlaceholder =>
  (CONFIG_PLACEHOLDERS as ReadonlyArray<string>).includes(name);

export const substitute = (
  template: string,
  values: Partial<Record<ConfigPlaceholder, string>>,
): Either.Either<string, TemplateError> => {
  for (const [, name] of template.matchAll(PLACEHOLDER)) {
    if (!isPlaceholder(name!)) {
      return Either.left(new TemplateError({ detail: `unknown placeholder {{${name}}}` }));
    }
    if (values[name] === undefined) {
      return Either.left(new TemplateError({ detail: `no value for {{${name}}}` }));
    }
  }
  // A lone `{{` the pattern could not pair is still a brace the template did
  // not mean to ship.
  if (template.replace(PLACEHOLDER, "").includes("{{")) {
    return Either.left(new TemplateError({ detail: "unpaired {{ in the template" }));
  }
  return Either.right(template.replace(PLACEHOLDER, (_, name: ConfigPlaceholder) => values[name]!));
};
