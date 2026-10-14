// The `status` renderer: a pure function over `StatusSnapshot`, subscribed to
// the `Reporter` stream exactly like doctor's row renderer. A
// `process.stdout.write` inside the command typechecks and is wrong.
//
// Column shapes port bash's status tables (tasklib.py:803-871): plain aligned
// text, free-text columns ellipsized, a pasteable column (a PR URL) never
// truncated, and the last column unpadded so redirected output carries no
// trailing whitespace.
import { DateTime, Option } from "effect";
import { CAPPED_UNREVIEWED_FIX } from "../agent/verdict.ts";
import { taskSummary } from "../dispatch/plan.ts";
import {
  type DispatchIdentity,
  dispatchIdentity,
  type RunRecord,
  type TerminalReason,
} from "../ledger/record.ts";
import type { ContainerOwner, StatusSnapshot } from "./snapshot.ts";

const MAX_COL_WIDTH = 32;

const truncate = (text: string, width: number): string =>
  text.length <= width ? text : `${text.slice(0, Math.max(width - 1, 1))}…`;

export const formatTable = (
  headers: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<string>>,
  truncateCols: ReadonlySet<number>,
): ReadonlyArray<string> => {
  const body = rows.map((row) =>
    row.map((cell, index) => (truncateCols.has(index) ? truncate(cell, MAX_COL_WIDTH) : cell)),
  );
  const all = [headers, ...body];
  const widths = headers.map((_, index) =>
    Math.max(...all.map((row) => (row[index] ?? "").length)),
  );
  return all.map((row) =>
    row
      .map((cell, index) => (index === row.length - 1 ? cell : cell.padEnd(widths[index] ?? 0)))
      .join("  "),
  );
};

export const formatDuration = (seconds: number): string => {
  const total = Math.max(0, Math.trunc(seconds));
  if (total < 60) {
    return `${total}s`;
  }
  const minutes = Math.trunc(total / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.trunc(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.trunc(hours / 24)}d`;
};

export const formatAge = (seconds: number): string => `${formatDuration(seconds)} ago`;

export const ageCell = (record: RunRecord, renderedAt: number): string =>
  formatAge((renderedAt - DateTime.toEpochMillis(record.endedAt)) / 1000);

// The whole reason start joined end in the record: "why did that run take 40
// minutes" is unanswerable on the bash schema, and unanswerable for rows
// that recorded no start here — they render "-" rather than a fabricated span.
const durationCell = (record: RunRecord): string =>
  Option.match(record.startedAt, {
    onNone: () => "-",
    onSome: (startedAt) =>
      formatDuration(
        (DateTime.toEpochMillis(record.endedAt) - DateTime.toEpochMillis(startedAt)) / 1000,
      ),
  });

// What the run cost, as bash's COST column (`tasklib.py:779-795`): the token
// total over the passes that reported one. **The addition happens here and
// only here** (T53) — the row keeps the four counts apart because a run that
// generated 8M tokens of output and one that re-read a warm cache are not the
// same run, and a sum written into the row could never be taken apart again.
const TOKENS_MILLION = 1_000_000;
const TOKENS_THOUSAND = 1_000;

const renderTokens = (tokens: number): string => {
  if (tokens >= TOKENS_MILLION) {
    return `${(tokens / TOKENS_MILLION).toFixed(1)}M`;
  }
  return tokens >= TOKENS_THOUSAND
    ? `${Math.round(tokens / TOKENS_THOUSAND)}k`
    : `${Math.trunc(tokens)}`;
};

const totalTokens = (record: RunRecord): number =>
  [record.tokensIn, record.tokensOut, record.cacheWrite, record.cacheRead].reduce(
    (total, count) => total + Option.getOrElse(count, () => 0),
    0,
  );

// `<tokens>/<passes>`, and "-" for a row that carries no count at all — every
// row written before T53, and every run whose passes were
// killed before one reported a figure. Unmeasured is not free
// (`tasklib.py:691`), so the cell says nothing rather than saying zero.
const costCell = (record: RunRecord): string => {
  const tokens = totalTokens(record);
  if (tokens <= 0) {
    return "-";
  }
  const size = renderTokens(tokens);
  return Option.match(record.passes, {
    onNone: () => size,
    onSome: (passes) => (passes > 0 ? `${size}/${passes}` : size),
  });
};

// What the row was dispatched for, in the width of a column. The two arms that
// were dispatched by *name* print theirs; the arm whose task is text has no
// name to print, so the cell says which kind of task it is and carries a
// summary of it (T67) — the whole text stays on the row and in the run log.
//
// The summary is `taskSummary`'s, shared with the plan banner
// (`dispatch/plan.ts`): two screens describing one run must not disagree on how
// much of the task they show.
const sourceNamed = (dispatch: DispatchIdentity): string => {
  switch (dispatch._tag) {
    case "OneOff":
      return dispatch.spec;
    case "Feature":
      return dispatch.feature;
    case "InlineTask":
      return `task: ${taskSummary(dispatch.task)}`;
  }
};

// Source is read off the identity tag, never by asking which of two fields is
// non-null. A resume keeps its prefix on every arm, so `resume:task: …` is a
// resume of a run whose task was stated inline.
export const sourceCell = (record: RunRecord): string => {
  const name = sourceNamed(dispatchIdentity(record.identity));
  return record.identity._tag === "FeedbackResume" ? `resume:${name}` : name;
};

const issuesCell = (record: RunRecord): string => {
  const dispatch = dispatchIdentity(record.identity);
  if (dispatch._tag !== "Feature" || dispatch.issues.length === 0) {
    return "-";
  }
  return dispatch.issues
    .map(({ issue, outcome }) => `${issue}${outcome === "approved" ? "✓" : "✗"}`)
    .join(" ");
};

const terminalLabel = (reason: TerminalReason): string => {
  switch (reason._tag) {
    case "Completed":
      return "-";
    case "Failed":
      return `❌ failed(${reason.stage})`;
    case "Crashed":
      return "💥 crashed";
    case "Interrupted":
      return "⏹ interrupted";
  }
};

// One column, three sources, in decreasing specificity: the run's own verdict,
// then a feature run's per-issue tally, then why it stopped. They never
// conflict — a run that reached a verdict completed, and a run that crashed
// reached none — so merging them here costs no information and keeps the
// screen one screen. Unrecognized verdict tokens print verbatim, as bash's own
// renderer does (tasklib.py:761).
export const outcomeCell = (record: RunRecord): string => {
  if (Option.isSome(record.outcome)) {
    const known: Record<string, string> = {
      approved: "✅ approved",
      "needs-work": "⚠️ needs-work",
      // A capped fixing round: the last round's commits shipped unreviewed,
      // which is a different ask of the human than "problems remain", and
      // bash's renderer labels it rather than passing it through
      // (tasklib.py:801-806). The token is written from T10's loop.
      [CAPPED_UNREVIEWED_FIX]: "⚠️ fix unreviewed",
    };
    return known[record.outcome.value] ?? record.outcome.value;
  }
  const dispatch = dispatchIdentity(record.identity);
  if (dispatch._tag === "Feature" && dispatch.issues.length > 0) {
    const done = dispatch.issues.filter(({ outcome }) => outcome === "approved").length;
    return done === dispatch.issues.length
      ? "✅ approved"
      : `⚠️ ${done}/${dispatch.issues.length} approved`;
  }
  return Option.match(record.terminalReason, { onNone: () => "-", onSome: terminalLabel });
};

const prCell = (record: RunRecord): string =>
  Option.match(record.pr, { onNone: () => "-", onSome: (pr) => pr.url });

// A column of its own, because a rescue is the one outcome where the work
// survived and is **not** where anybody was told to look for it (T31): the
// BRANCH column names the branch the run was dispatched on, and after a rescue
// the commits are somewhere else entirely. Folding it into `outcomeCell` would
// put it under a heading that answers a different question — why the run
// stopped — and the two are independent: a rescue rides on a `failed` row as
// readily as on a completed one.
//
// "-" on every other row, as ISSUES and PR already do, and never truncated for
// the reason a PR URL is not: it is a ref the reader is about to type.
const rescueCell = (record: RunRecord): string => Option.getOrElse(record.rescuedOnto, () => "-");

// Which dispatcher wrote this row (T43): the short revision, marked when its
// source was dirty. A row that predates the field — every row on
// disk before this ticket — must read as *unknown*, never as clean, so the
// absent case is spelled out rather than sharing "-" with columns where
// absence means "nothing to say".
const dispatcherCell = (record: RunRecord): string =>
  Option.match(record.dispatcher, {
    onNone: () => "unknown",
    onSome: (dispatcher) => `${dispatcher.revision}${dispatcher.dirty ? "-dirty" : ""}`,
  });

// Whether a dispatcher still owns the container (T138). The answer is the
// snapshot's — the reconciler's verdict — and this only says it, including
// what the reconciler will do about it.
export const ownerCell = (owner: ContainerOwner): string => {
  switch (owner._tag) {
    case "OwnedBy":
      return `pid ${owner.pid}`;
    case "OwnerGone":
      return "dead — next dispatch reclaims";
    case "NoLock":
      return "no lock — reported only";
  }
};

const renderRunning = (snapshot: StatusSnapshot): ReadonlyArray<string> => {
  const lines = ["Running"];
  if (snapshot.containers._tag === "ContainersUnavailable") {
    lines.push(`  ${snapshot.containers.detail} — Recent below is unaffected`);
    return lines;
  }
  const running = snapshot.containers.running;
  if (running.length === 0) {
    lines.push("  no running tasks");
    return lines;
  }
  const table = formatTable(
    ["NAME", "UPTIME", "OWNER"],
    running.map((container) => [container.name, container.uptime, ownerCell(container.owner)]),
    new Set([0]),
  );
  lines.push(...table.map((row) => `  ${row}`));
  return lines;
};

const renderRecent = (snapshot: StatusSnapshot): ReadonlyArray<string> => {
  const lines = [`Recent (last ${snapshot.limit})`];
  if (snapshot.ledger._tag === "LedgerUnavailable") {
    lines.push(`  ${snapshot.ledger.detail} — Running above is unaffected`);
    return lines;
  }
  const recent = snapshot.ledger.recent;
  if (recent.length === 0) {
    lines.push("  no runs recorded");
    return lines;
  }
  const table = formatTable(
    [
      "BRANCH",
      "SOURCE",
      "ISSUES",
      "OUTCOME",
      "DURATION",
      // Beside the duration, because the two answer the same question about a
      // run from either end: how long it took and what it burned getting
      // there. The models those tokens were spent on are **not** here — they
      // are on the row for whoever reads it, and this is one screen (SPEC §7).
      "COST",
      "PR",
      "RESCUE",
      "AGE",
      "DISPATCHER",
    ],
    recent.map((record) => [
      record.branch,
      sourceCell(record),
      issuesCell(record),
      outcomeCell(record),
      durationCell(record),
      costCell(record),
      prCell(record),
      rescueCell(record),
      ageCell(record, snapshot.renderedAt),
      dispatcherCell(record),
    ]),
    new Set([0, 1]),
  );
  lines.push(...table.map((row) => `  ${row}`));
  return lines;
};

export const renderStatus = (snapshot: StatusSnapshot): string =>
  [...renderRunning(snapshot), "", ...renderRecent(snapshot)].join("\n");
