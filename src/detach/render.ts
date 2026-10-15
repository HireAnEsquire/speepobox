// What `--detach`'s parent says about the child it started (T153), pure so
// the console's wording is asserted without a process. The child's own lines
// are relayed verbatim and need no renderer.
import type { ReporterEvent } from "../reporter.ts";
import { Duration } from "effect";
import { STOP_GRACE } from "./timing.ts";

// The three start lines: the run, the file it writes, and the command that
// watches it. After this the run log is what anyone watches; the `.out` file
// the child's console goes to exists only to catch a crash.
export const renderDetachedStarted = (
  event: Extract<ReporterEvent, { readonly _tag: "DetachedStarted" }>,
): string =>
  [
    `started '${event.branch}' (pid ${event.pid})`,
    `log: ${event.log}`,
    `watch: .speepobox/speepobox logs ${event.branch} --follow`,
  ].join("\n");

// Which of the two cases a child stopped before its start line was: it never
// held the lock, so nothing was claimed; or it took the lock as the SIGINT was
// sent, and tore down as an interrupted run does.
export const renderDetachedStopped = (
  event: Extract<ReporterEvent, { readonly _tag: "DetachedStopped" }>,
): string => {
  const who = `'${event.branch}' (pid ${event.pid})`;
  if (!event.exited) {
    return `${who} was sent SIGINT and is still running after ${Duration.toSeconds(STOP_GRACE)}s — check on it with \`speepobox status\`, and end it with \`speepobox stop ${event.branch}\``;
  }
  return event.heldLock
    ? `${who} took its lock and was then stopped — the commits are kept and its row records the run as interrupted`
    : `${who} was stopped before it took its lock — nothing was claimed, and no row was written`;
};
