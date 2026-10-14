// `RepoSlug` (T39): which owner and name a `gh` call names with `--repo`. It
// is not `RepoUrl` (`git/repo-url.ts`) wearing a second hat — that module
// brands a URL that carries no userinfo, a different invariant from "this
// string names an owner and a repo". A remote is also an scp-like
// `git@github.com:owner/name.git` or a local path, neither of which `RepoUrl`
// touches and both of which this parse has to answer for on its own, so it
// stands beside `RepoUrl` as its own pure module rather than folding into it.
//
// Plain module, no tag (SPEC §2): pure, so a fake buys nothing.
import { Option } from "effect";

export interface RepoSlug {
  readonly owner: string;
  readonly name: string;
}

// What `gh --repo` takes (github.com only — an enterprise host would want
// `HOST/OWNER/NAME`, and this package names no second forge host until one
// exists, 05's rule about seams).
export const repoSlugArg = (slug: RepoSlug): string => `${slug.owner}/${slug.name}`;

const GIT_SUFFIX = /\.git$/;

// The scp-like remote ssh accepts nowhere else: `git@github.com:owner/name`.
// It is not a URL — the colon is not a port separator — so `URL.parse` either
// rejects it outright or, worse, misreads it, and this is checked first.
const SCP_LIKE = /^[^/@]+@[^:/]+:(.+)$/;

// The last two non-empty path segments, `.git` stripped off the last one —
// which is "owner" and "name" for every shape a clone URL takes (`https://`,
// `ssh://`, and the scp-like syntax above), including a nested path where a
// forge groups repos more than one level deep: the two segments beside the
// leaf are what `gh` and every one of this ticket's examples call owner and
// name. Fewer than two segments — a bare hostname, a local path with no
// parent directory — has no owner to name.
const ownerAndName = (path: string): Option.Option<RepoSlug> => {
  const segments = path
    .replace(GIT_SUFFIX, "")
    .split("/")
    .filter((segment) => segment !== "");
  const name = segments.at(-1);
  const owner = segments.at(-2);
  return owner === undefined || name === undefined ? Option.none() : Option.some({ owner, name });
};

// `None` for a remote this cannot read an owner and a name out of — a local
// path (`/srv/hae`, no scheme and no `@host:` prefix) chief among them, which
// `RepoUrl` passes through verbatim for the identical reason: it is a real
// remote shape and not a malformed one, it simply names no forge.
export const parseRepoSlug = (url: string): Option.Option<RepoSlug> => {
  const trimmed = url.trim();
  const scpLike = SCP_LIKE.exec(trimmed);
  if (scpLike?.[1] !== undefined) {
    return ownerAndName(scpLike[1]);
  }
  const parsed = URL.parse(trimmed);
  return parsed === null ? Option.none() : ownerAndName(parsed.pathname);
};
