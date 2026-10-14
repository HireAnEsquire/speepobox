// The dispatcher-freshness question (T42): is this dispatcher's package
// directory missing commits its configured base already has? Two callers ask
// it — `doctor`'s probe ten, through the subprocess chokepoint directly
// (`probes.ts` must work when the toolchain it inspects is broken, so it
// takes no `Git` dependency), and T44's preflight refusal, through the `Git`
// tag. Neither may restate the question, so the argv and the verdict live
// here, in a plain module with no `Git` import (`repo-url.ts`'s shape) —
// `resolveTasksDir` names the reason: one definition because two callers need
// the same answer, and a bare name resolving somewhere doctor never looked is
// exactly the drift a second copy buys. A doctor that answered a slightly
// different question than the preflight is that drift with a worse
// consequence, because the operator would have run doctor precisely to find
// out.
import { packagePathspec } from "../config/paths.ts";

// The three answers a caller can act on. `Stale` names the commits so the
// message can quote at least one; `BaseUnresolvable` is the base ref this
// clone cannot read at all — an unfetched clone, most commonly, and never a
// crash.
export type DispatcherFreshness =
  | { readonly _tag: "Current" }
  | { readonly _tag: "Stale"; readonly missing: ReadonlyArray<string> }
  | { readonly _tag: "BaseUnresolvable" };

// `rev-list HEAD..<base> -- <pathspec>...`: commits reachable from the base
// and not from `HEAD`, under this dispatcher's source alone — listed rather
// than counted. `countCommits` cannot serve this: it renders
// `rev-list --count <from>..<to>` with no pathspec and answers with a number,
// where both callers need the SHA to name. No `-C`/`--git-dir` here — each
// caller names its own repo through `repoArgs` (T27, T133).
export const dispatcherFreshnessArgs = (repoRoot: string, base: string): ReadonlyArray<string> => [
  "rev-list",
  `HEAD..${base}`,
  "--",
  ...packagePathspec(repoRoot),
];

// Reads a `rev-list` result into the three answers above. A nonzero exit is
// git refusing to resolve `base` in this clone — never a crash, and never
// distinguished from any other reason git could not answer, because the
// remedy is the same one either way: fetch it, or fix the configured ref.
export const readDispatcherFreshness = (result: {
  readonly exitCode: number;
  readonly stdout: string;
}): DispatcherFreshness => {
  if (result.exitCode !== 0) {
    return { _tag: "BaseUnresolvable" };
  }
  const missing = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return missing.length === 0 ? { _tag: "Current" } : { _tag: "Stale", missing };
};
