import type { ProbeStatus, ReporterEvent } from "../reporter.ts";

const statusLabel: Record<ProbeStatus, string> = {
  ok: "ok",
  warn: "WARN",
  fail: "FAIL",
};

// One line per check, matching bash's `%-4s  %-10s %s` table (run.sh:332-334);
// the probe column is wider because runtime-root exists now.
export const renderProbeRow = (event: Extract<ReporterEvent, { _tag: "ProbeChecked" }>): string =>
  `${statusLabel[event.status].padEnd(4)}  ${event.probe.padEnd(12)} ${event.detail}`;
