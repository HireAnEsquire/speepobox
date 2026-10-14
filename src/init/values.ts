// The three values `init` substitutes into `config.toml`, and where each came
// from (T115). A flag always wins; otherwise each has one place of its own to
// be read from, and the report names which one answered so an adopter reads
// the values before committing them.
//
// Only the image name is worked out here, because it is the only one that is
// pure: the basename is a fact of `repoRoot`, which `init` already holds, not
// a host read. The base is `Git.originHead`'s answer and `tool-sha` is the
// `DispatcherRevision` `bin.ts` resolves (T43); `init.ts` asks for both.
import { Schema } from "effect";

export const ValueSource = Schema.Literal(
  "flag",
  "origin/HEAD",
  "directory name",
  "package revision",
);
export type ValueSource = Schema.Schema.Type<typeof ValueSource>;

export const ResolvedValue = Schema.Struct({
  value: Schema.String,
  source: ValueSource,
});
export type ResolvedValue = Schema.Schema.Type<typeof ResolvedValue>;

const SUFFIX = "bessemer";

// The served repo directory's basename as an image name: lowercased, every
// character outside `[a-z0-9._-]` replaced by `-`, runs of `-` collapsed, and
// separators trimmed from the ends so the `-bessemer` joined on after them is
// never a second separator beside one — `My App` is `my-app-bessemer`. A name
// with nothing left after that is `bessemer` alone rather than `-bessemer`,
// which is not a legal repository name.
export const imageNameFor = (directoryName: string): string => {
  const stem = directoryName
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[._-]+/, "")
    .replace(/[._-]+$/, "");
  return stem === "" ? SUFFIX : `${stem}-${SUFFIX}`;
};
