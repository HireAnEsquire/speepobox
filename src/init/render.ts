// The `init` renderer: a pure function over `InitSnapshot`, subscribed to the
// `Reporter` stream exactly as `gc`'s is. A write is one `wrote` or `kept`
// line per file, any warning, then the next steps — printed, and never run. A
// `--diff` (T116) is one line per file, then each behind file's diff and its
// remedy, then a shim that cannot run and its `chmod` (T127).
import { Option } from "effect";
import { BESSEMER_DIRNAME } from "../config/paths.ts";
import {
  countsAsDrift,
  isNotExecutable,
  isSelfHostedShim,
  type DriftFile,
  type InitDiff,
  type InitFile,
  type InitSnapshot,
  type InitValues,
  type InitWrite,
  type StampedDrift,
} from "./snapshot.ts";
import { SHIM } from "./stamp.ts";

// The shim, as every command printed for an adopter to paste spells it (F2).
const SHIM_PATH = `${BESSEMER_DIRNAME}/${SHIM}`;

// The values a written `config.toml` holds, each with where it came from
// (T115) — an adopter reads them before committing the file.
const valuesLine = (values: InitValues): string =>
  (["base", "image", "tool-sha"] as const)
    .map((key) => `${key} = "${values[key].value}" (${values[key].source})`)
    .join(", ");

const fileLine = (file: InitFile): string =>
  file.action === "wrote" && file.values !== undefined
    ? `${file.action}  ${file.path}  ${valuesLine(file.values)}`
    : `${file.action}  ${file.path}`;

export const NEXT_STEPS: ReadonlyArray<string> = [
  "put your own stack's base image in .bessemer/image/Dockerfile",
  "run `.bessemer/bessemer image build`",
  "put the agent credential in .bessemer/.env",
  "run `.bessemer/bessemer doctor`",
  "commit .bessemer/, the shim .bessemer/bessemer included",
];

const renderWrite = (snapshot: InitWrite): string =>
  [
    ...snapshot.files.map(fileLine),
    ...snapshot.warnings.map((warning) => `WARN  ${warning}`),
    "",
    "Next steps:",
    ...NEXT_STEPS.map((step, index) => `  ${index + 1}. ${step}`),
  ].join("\n");

const stateOf = (file: DriftFile): string => {
  if (file._tag === "Presence") return file.present ? "present" : "missing";
  if (file.state === "missing") return "missing";
  const state = `${file.state}, ${file.edited ? "edited" : "pristine"}`;
  return file.notExecutable ? `${state}, not executable` : state;
};

// Why a stamped file stands where it does, in the one-line listing. A
// self-hosted repo is one `init` refuses, so nothing there would write it.
const noteOf = (file: DriftFile, selfHosted: boolean): string => {
  const absent = selfHosted ? "absent; init does not write here" : "init would write it";
  if (isSelfHostedShim(file, selfHosted)) return "absent; this repo has no shim by design";
  if (file._tag === "Presence") return file.present ? "" : absent;
  if (file.state === "missing") return absent;
  if (Option.isSome(file.stampedAs)) {
    return `its stamp names template ${file.stampedAs.value}, not ${file.template}`;
  }
  if (!file.stamped) return `no stamp, read as v0; template v${file.templateVersion}`;
  if (file.state === "behind") {
    return `stamped v${file.stampVersion}; template v${file.templateVersion}`;
  }
  return "";
};

// A behind shim is not refreshed by deleting it, which would delete the
// command that runs `init` (09, amended). The shim names the repo from its own
// directory and `exec`s node, so it runs as well from beside its old name, and
// `init` reads the moved-away shim as absent and writes the new one 0755.
export const SHIM_REFRESH = `mv ${SHIM_PATH} ${SHIM_PATH}.old && ${SHIM_PATH}.old init && rm ${SHIM_PATH}.old`;
export const SHIM_RESTORE = `mv ${SHIM_PATH}.old ${SHIM_PATH}`;

const refreshLines = (file: StampedDrift): ReadonlyArray<string> =>
  file.template === SHIM
    ? [
        `To refresh it: ${SHIM_REFRESH}`,
        `If that init fails partway, put the old shim back: ${SHIM_RESTORE}`,
        "Failing both, run init from a hand clone of bessemer.",
      ]
    : [`To refresh it: rm ${file.path} && ${SHIM_PATH} init`];

const behindSection = (file: StampedDrift, selfHosted: boolean): ReadonlyArray<string> => [
  "",
  `${file.path} is behind. The diff is the current template against your file, so it includes your own edits:`,
  file.diff,
  ...(file.edited
    ? []
    : ["This file is as init wrote it: nothing of yours is lost by taking the template."]),
  ...(selfHosted
    ? [`This repo is not scaffolded: bring it up to date by hand from ${file.templatePath}.`]
    : refreshLines(file)),
];

// A shim without its execute bit cannot run, whatever its stamp says (T127).
const notExecutableSection = (file: StampedDrift): ReadonlyArray<string> => [
  "",
  `${file.path} is not executable, so it cannot run. To fix it: chmod +x ${file.path}`,
];

const renderDiff = (snapshot: InitDiff): string => {
  const width = Math.max(...snapshot.files.map((file) => stateOf(file).length));
  const drifted = snapshot.files.filter((file) => countsAsDrift(file, snapshot.selfHosted)).length;
  return [
    ...snapshot.files.map((file) => {
      const note = noteOf(file, snapshot.selfHosted);
      return `${stateOf(file).padEnd(width)}  ${file.path}${note === "" ? "" : `  (${note})`}`;
    }),
    ...snapshot.files.flatMap((file) =>
      file._tag === "Stamped" && file.state === "behind"
        ? behindSection(file, snapshot.selfHosted)
        : [],
    ),
    ...snapshot.files.flatMap((file) =>
      file._tag === "Stamped" && file.notExecutable ? notExecutableSection(file) : [],
    ),
    "",
    drifted === 0
      ? "No drift."
      : `Drift: ${drifted} file${drifted === 1 ? "" : "s"} missing or behind.`,
    ...snapshot.files.filter(isNotExecutable).map((file) => `Not executable: ${file.path}.`),
  ].join("\n");
};

export const renderInit = (snapshot: InitSnapshot): string =>
  snapshot._tag === "Write" ? renderWrite(snapshot) : renderDiff(snapshot);
