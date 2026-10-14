// The `gc` renderer: a pure function over `GcSnapshot`, subscribed to the
// `Reporter` stream exactly as `status`'s is. Column shapes port bash's
// `render_gc` (`tasklib.py:1111-1130`): CLASS, SLUG, AGE, SIZE, WOULD, the
// slug ellipsized, and the last column unpadded.
import { Option } from "effect";
import { formatDuration, formatTable } from "../status/render.ts";
import type { GcSnapshot, Measure } from "./snapshot.ts";

const HEADER = "What this host holds from bessemer runs";

// bash's warning (`run.sh:562`, `tasklib.py:1113`), in this tool's words.
export const DAEMON_DOWN_NOTE =
  "(dockerd could not be asked — liveness unverified, listing only; gc --force would refuse)";

export const NOTHING_TO_RECLAIM = "nothing to reclaim";

// An editor directory from before its name carried a pid (T108): nothing can
// say whose it was, and it holds a dispatcher's own text, so `--force` leaves
// it for a human.
export const UNWITNESSED_WOULD = "keep — no pid, rm -rf by hand";

const KIB = 1024;

// bash's `_human_size`: whole bytes, then one decimal through K and M, and G
// for everything past that.
export const formatSize = (bytes: number): string => {
  let size = bytes;
  for (const unit of ["B", "K", "M"]) {
    if (size < KIB) {
      return unit === "B" ? `${size.toFixed(0)}B` : `${size.toFixed(1)}${unit}`;
    }
    size /= KIB;
  }
  return `${size.toFixed(1)}G`;
};

const measureCell = (measure: Measure, render: (value: number) => string): string => {
  switch (measure._tag) {
    case "Measured":
      return render(measure.value);
    case "Unmeasured":
      return "?";
    case "NotApplicable":
      return "-";
  }
};

export const renderGc = (snapshot: GcSnapshot): string => {
  const age = (measure: Measure): string =>
    measureCell(measure, (modifiedAt) => formatDuration((snapshot.renderedAt - modifiedAt) / 1000));

  const rows = [
    ...snapshot.slugs.flatMap((found) =>
      found.resources.map((resource) => [
        resource.kind,
        found.slug,
        age(resource.modifiedAt),
        measureCell(resource.size, formatSize),
        resource.would,
      ]),
    ),
    ...snapshot.witnesses.map((witness) => [
      "witness",
      witness.slug,
      age(witness.modifiedAt),
      "-",
      "sweep",
    ]),
    ...snapshot.leftovers.map((leftover) => [
      leftover.kind === "editor" ? "edit-dir" : leftover.kind,
      Option.getOrElse(leftover.slug, () => "-"),
      age(leftover.modifiedAt),
      "-",
      leftover.state === "dead" ? "remove" : UNWITNESSED_WOULD,
    ]),
  ];

  const logs = `logs: ${snapshot.logs.count} run log${snapshot.logs.count === 1 ? "" : "s"}, ${measureCell(snapshot.logs.bytes, formatSize)} total — kept (audit trail, gc never deletes logs)`;

  const body =
    rows.length === 0
      ? [NOTHING_TO_RECLAIM]
      : formatTable(["CLASS", "SLUG", "AGE", "SIZE", "WOULD"], rows, new Set([1]));

  return [
    snapshot.daemonAnswered ? HEADER : `${HEADER}  ${DAEMON_DOWN_NOTE}`,
    ...[...body, logs].map((line) => `  ${line}`),
  ].join("\n");
};
