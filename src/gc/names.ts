// What a leftover's name says about who left it (T108): read by the listing,
// and read again by `--force` right before it removes one (T109).
import { Option } from "effect";
import { parsePid } from "../lock/liveness.ts";

const CLAIM_SUFFIX = ".claim";

// A claim's temp file off its name alone, `<lock file>.<pid>.<attempt>.claim`
// (`lock/claim.ts`): the lock file's name and the pid of the attempt that
// wrote it. Whether that lock file name is a slug's is the caller's round trip
// through `lockPathFor`. A name without this shape is not a claim.
export const parseClaimName = (
  name: string,
): Option.Option<{ readonly lockFile: string; readonly pid: number }> => {
  if (!name.endsWith(CLAIM_SUFFIX)) {
    return Option.none();
  }
  const parts = name.slice(0, -CLAIM_SUFFIX.length).split(".");
  const attempt = parts.pop() ?? "";
  const pid = parsePid(parts.pop() ?? "");
  const lockFile = parts.join(".");
  return /^\d+$/.test(attempt) && lockFile !== ""
    ? Option.map(pid, (owner) => ({ lockFile, pid: owner }))
    : Option.none();
};
