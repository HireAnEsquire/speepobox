// A unified line diff, computed in-process (T116): `init --diff` shows an
// adopter what the current template would change, and spawning `diff` or
// `git diff` for it would be one more child and one more host binary. Pure,
// and small on purpose — scaffold files are tens of lines, so a plain
// longest-common-subsequence table is all the cleverness it needs.

type Op = { readonly kind: " " | "-" | "+"; readonly line: string };

const linesOf = (text: string): ReadonlyArray<string> => {
  if (text === "") return [];
  const lines = text.split("\n");
  // A trailing newline ends the last line rather than opening an empty one.
  return lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines;
};

const opsOf = (from: ReadonlyArray<string>, to: ReadonlyArray<string>): ReadonlyArray<Op> => {
  const n = from.length;
  const m = to.length;
  // `common[i][j]` is the LCS length of `from[i..]` and `to[j..]`.
  const common = Array.from({ length: n + 1 }, () => Array.from<number>({ length: m + 1 }).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      common[i]![j] =
        from[i] === to[j]
          ? common[i + 1]![j + 1]! + 1
          : Math.max(common[i + 1]![j]!, common[i]![j + 1]!);
    }
  }
  const ops: Array<Op> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (from[i] === to[j]) {
      ops.push({ kind: " ", line: from[i]! });
      i += 1;
      j += 1;
    } else if (common[i + 1]![j]! >= common[i]![j + 1]!) {
      ops.push({ kind: "-", line: from[i]! });
      i += 1;
    } else {
      ops.push({ kind: "+", line: to[j]! });
      j += 1;
    }
  }
  for (; i < n; i += 1) ops.push({ kind: "-", line: from[i]! });
  for (; j < m; j += 1) ops.push({ kind: "+", line: to[j]! });
  return ops;
};

const CONTEXT = 3;

// `diff -u`'s range: a start and a length, where an empty range starts one
// line before where it would go.
const range = (start: number, length: number): string =>
  length === 1 ? `${start}` : `${length === 0 ? start - 1 : start},${length}`;

// The unified diff turning `from` into `to`, labelled with the two names, or
// `""` when the texts' lines agree.
export const unifiedDiff = (fromName: string, toName: string, from: string, to: string): string => {
  const ops = opsOf(linesOf(from), linesOf(to));
  const changed = ops.flatMap((op, index) => (op.kind === " " ? [] : [index]));
  if (changed.length === 0) return "";

  // Changes with no more than twice the context between them share a hunk,
  // as `diff -u` joins them: their contexts meet.
  const spans: Array<[number, number]> = [];
  for (const index of changed) {
    const last = spans[spans.length - 1];
    if (last !== undefined && index - last[1] - 1 <= 2 * CONTEXT) {
      last[1] = index;
    } else {
      spans.push([index, index]);
    }
  }

  // Line numbers before each op, on both sides.
  const fromAt: Array<number> = [];
  const toAt: Array<number> = [];
  let a = 1;
  let b = 1;
  for (const op of ops) {
    fromAt.push(a);
    toAt.push(b);
    if (op.kind !== "+") a += 1;
    if (op.kind !== "-") b += 1;
  }

  const out = [`--- ${fromName}`, `+++ ${toName}`];
  for (const [first, last] of spans) {
    const start = Math.max(0, first - CONTEXT);
    const end = Math.min(ops.length - 1, last + CONTEXT);
    const hunk = ops.slice(start, end + 1);
    const fromLength = hunk.filter((op) => op.kind !== "+").length;
    const toLength = hunk.filter((op) => op.kind !== "-").length;
    out.push(
      `@@ -${range(fromAt[start]!, fromLength)} +${range(toAt[start]!, toLength)} @@`,
      ...hunk.map((op) => `${op.kind}${op.line}`),
    );
  }
  return out.join("\n");
};
