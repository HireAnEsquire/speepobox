// `RepoUrl` (SPEC §9, invariant 2): the branded parse every URL that crosses
// into a checkout or a sandbox goes through. The invariant is *unrepresentable
// rather than checked* — `Git.clone` (T18) and the sandbox spec (T6) take
// `RepoUrl`, not `string`, so a URL still carrying a credential cannot be
// typed into them. Bash grew a `strip_url_userinfo` helper plus a `doctor`
// warning; this is the same rule as a shape.
//
// Plain module, no tag (SPEC §2): pure, so a fake buys nothing, and `doctor`'s
// probe imports the predicate directly rather than keeping a second copy —
// which is how the rule reaches the read-only slice without giving it a
// dependency on a git binary.
import { Option, ParseResult, Schema } from "effect";

// Userinfo on an http(s) remote is a bare credential leaking into every
// process that reads it; ssh usernames are not secrets (`run.sh:256-273`),
// which is why neither `ssh://git@…` nor the scp-like `git@github.com:…`
// matches — stripping those would break the URL to hide nothing.
export const urlEmbedsUserinfo = (url: string): boolean =>
  /^(?:https?|git\+https):\/\/[^/]*@/.test(url);

// The strip. `URL.parse` answers with `null` rather than throwing, so an
// http(s) URL we cannot parse is an input we cannot prove we cleaned — the
// decode below refuses it instead of branding it.
const withoutUserinfo = (url: string): Option.Option<string> => {
  const parsed = URL.parse(url);
  if (parsed === null) {
    return Option.none();
  }
  parsed.username = "";
  parsed.password = "";
  const cleaned = parsed.toString();
  return urlEmbedsUserinfo(cleaned) ? Option.none() : Option.some(cleaned);
};

// Strips where it can, refuses where it cannot, and brands what comes out. A
// URL with no userinfo passes through *verbatim* rather than round-tripping
// through `URL`: a clone source is also a local path (`/srv/hae`) or an
// scp-like ssh remote, neither of which survives re-serialization, and
// normalizing the rest would rewrite strings for no invariant's sake.
export const RepoUrl = Schema.transformOrFail(
  Schema.String,
  Schema.String.pipe(Schema.brand("RepoUrl")),
  {
    strict: true,
    decode: (input, _options, ast) => {
      const trimmed = input.trim();
      if (trimmed === "") {
        return ParseResult.fail(new ParseResult.Type(ast, input, "a repo URL is required"));
      }
      if (!urlEmbedsUserinfo(trimmed)) {
        return ParseResult.succeed(trimmed);
      }
      return Option.match(withoutUserinfo(trimmed), {
        onNone: () =>
          ParseResult.fail(
            new ParseResult.Type(
              ast,
              input,
              "the URL embeds userinfo (credentials) and does not parse, so it cannot be stripped — use a credential helper instead",
            ),
          ),
        onSome: ParseResult.succeed,
      });
    },
    encode: ParseResult.succeed,
  },
);
export type RepoUrl = Schema.Schema.Type<typeof RepoUrl>;
