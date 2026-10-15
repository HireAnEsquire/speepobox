// The refresh after the pin (T149): the release that ships the templates
// applies them. `upgrade` runs the *old* release's code, which knows neither
// the new templates nor the new stamps, so once the pin has moved it runs the
// repo's own shim as a child — `.speepobox/speepobox init --refresh` — and the
// shim reads the new pin, so the new release refreshes.
//
// Not on a rollback: scaffold files are not rolled back. And not without a
// shim that can run: the pin has moved either way, and the report says what
// to run. A child that fails is `upgrade`'s failure, after the report — the
// pin is never moved back.
import { join } from "node:path";
import type { CommandExecutor } from "@effect/platform/CommandExecutor";
import { FileSystem } from "@effect/platform";
import { Effect, Option } from "effect";
import { SPEEPOBOX_DIRNAME } from "../config/paths.ts";
import { KEPT_BEHIND_EDITED, REFRESH } from "../init/render.ts";
import { SHIM } from "../init/stamp.ts";
import { exec } from "../internal/exec.ts";
import { UpgradeRefused } from "./argv.ts";
import { pinnedRelease, UPGRADE_COMMAND } from "./render.ts";
import type { RefreshOutcome, UpgradeSnapshot } from "./snapshot.ts";

// The two files whose change means the image is stale, as the scaffold names
// them.
const IMAGE_INPUTS: ReadonlyArray<string> = ["image/Dockerfile", "image/inputs"];

// A pin that was no release counts as moving up.
export const isRollback = (snapshot: UpgradeSnapshot): boolean =>
  snapshot._tag === "Pinned" &&
  snapshot.was._tag === "Release" &&
  snapshot.to.number < snapshot.was.release.number;

// Whether the shim is there and carries an execute bit — the question the
// kernel would answer at the spawn, asked first so the answer is a sentence.
const shimState = (
  fs: FileSystem.FileSystem,
  path: string,
): Effect.Effect<Option.Option<"absent" | "not executable">> =>
  fs.stat(path).pipe(
    Effect.map((info) =>
      info.type === "File" && (info.mode & 0o111) !== 0
        ? Option.none()
        : Option.some<"absent" | "not executable">("not executable"),
    ),
    Effect.orElseSucceed(() => Option.some<"absent" | "not executable">("absent")),
  );

// Each image input's bytes, or none where it cannot be read: "changed" is the
// bytes before the child against the bytes after it, never its output.
const imageBytes = (
  fs: FileSystem.FileSystem,
  speepoboxDir: string,
): Effect.Effect<ReadonlyArray<Option.Option<Uint8Array>>> =>
  Effect.forEach(IMAGE_INPUTS, (file) => Effect.option(fs.readFile(join(speepoboxDir, file))));

const sameBytes = (a: Option.Option<Uint8Array>, b: Option.Option<Uint8Array>): boolean =>
  Option.isNone(a) || Option.isNone(b)
    ? Option.isNone(a) && Option.isNone(b)
    : a.value.length === b.value.length && a.value.every((byte, at) => byte === b.value[at]);

const keptEdited = (output: string): boolean =>
  output.split("\n").some((line) => line.startsWith("kept ") && line.endsWith(KEPT_BEHIND_EDITED));

// The failure, said plainly: the pin stands, here is what the child said, and
// here is how to try again.
const failed = (snapshot: UpgradeSnapshot, why: string): UpgradeRefused => {
  const release = pinnedRelease(snapshot).tag;
  const pin =
    snapshot._tag === "Pinned"
      ? `the pin moved to ${release} and stays there`
      : `the pin is ${release}, unchanged`;
  return new UpgradeRefused({
    detail: `${pin}, but the scaffold refresh failed: ${why} — retry with \`${UPGRADE_COMMAND}\` or \`${REFRESH}\``,
  });
};

// Answers the outcome for the report and, where the child failed, the error
// `upgrade` fails with once the report is out.
export const refresh = (
  repoRoot: string,
  snapshot: UpgradeSnapshot,
): Effect.Effect<
  { readonly outcome: RefreshOutcome; readonly error: Option.Option<UpgradeRefused> },
  never,
  FileSystem.FileSystem | CommandExecutor
> =>
  Effect.gen(function* () {
    if (isRollback(snapshot)) {
      return { outcome: { _tag: "RolledBack" }, error: Option.none() };
    }
    const fs = yield* FileSystem.FileSystem;
    const speepoboxDir = join(repoRoot, SPEEPOBOX_DIRNAME);
    const shim = join(speepoboxDir, SHIM);
    const cannotRun = yield* shimState(fs, shim);
    if (Option.isSome(cannotRun)) {
      return { outcome: { _tag: "NoShim", reason: cannotRun.value }, error: Option.none() };
    }

    const before = yield* imageBytes(fs, speepoboxDir);
    const ran = yield* Effect.either(exec(shim, "init", "--refresh"));
    if (ran._tag === "Left") {
      return {
        outcome: { _tag: "Failed", output: "" },
        error: Option.some(failed(snapshot, `${shim} could not be started: ${ran.left.detail}`)),
      };
    }
    const { exitCode, stdout, stderr } = ran.right;
    if (exitCode !== 0) {
      const said = stderr.trim();
      return {
        outcome: { _tag: "Failed", output: stdout },
        error: Option.some(
          failed(
            snapshot,
            `\`${REFRESH}\` exited ${exitCode}${said === "" ? " and said nothing on stderr" : `: ${said}`}`,
          ),
        ),
      };
    }
    const after = yield* imageBytes(fs, speepoboxDir);
    const imageChanged = before.some((bytes, at) => !sameBytes(bytes, after[at]!));
    return {
      outcome: { _tag: "Refreshed", output: stdout, keptEdited: keptEdited(stdout), imageChanged },
      error: Option.none(),
    };
  });
