// The two flags that name a repository, spelled once for the package (T32,
// T133): every git read or write that runs *in* a repo opens with these,
// whether it goes through the `Git` tag or is one of the plain modules that
// read the package's own clone, the guards' helper, or `doctor`'s probes. A
// second spelling is the one that would answer for whatever encloses its path.
//
// **`-C` names a directory, and a directory is not a repository.** It leaves
// git to *discover* the repository by walking up, so a path holding no
// repository resolves to the nearest enclosing one — a checkout under the
// host repo's working tree to the host repo, and a package cache entry under a
// `$HOME` that is itself a repository to `$HOME`. `--git-dir` turns the walk
// off, so such a path fails naming itself, in git's own words.
//
// **The two flags only name the same directory once the path is absolute**:
// git resolves a relative `--git-dir` against `-C`'s destination and not
// against the process, so `-C box/x --git-dir=box/x/.git` looks for
// `box/x/box/x/.git`. `resolve` makes it absolute against the process working
// directory — what bare `-C` resolved a relative path against — so closing the
// walk changes no path that already worked. That reads `process.cwd()`, which
// is host work: call this when the effect runs (inside an `Effect.suspend`),
// never when it is built.
import { join, resolve } from "node:path";

export const repoArgs = (repo: string): ReadonlyArray<string> => {
  const at = resolve(repo);
  return ["-C", at, `--git-dir=${join(at, ".git")}`];
};
