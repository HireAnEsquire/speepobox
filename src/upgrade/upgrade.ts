// `upgrade` (SPEC §7, P6 F13 and F15): moves the served repo's pin to the
// newest release, or with `--to vN` to a named one, rollbacks included. It
// rewrites one line and commits nothing, then hands the scaffold refresh to
// the release it pinned (T149, `refresh.ts`).
//
// Intercepted in `bin.ts` beside `init`, before any config decode: the pin is
// read by T121's grammar, never through `SpeepoboxConfig` (T120). Everything is
// read before anything is written, and the only write is the `tool-sha` line —
// every refusal leaves the file as it was.
//
// The releases are asked of the package's own repo — `packageRepoRoot`, from
// `bin.ts` — whose `origin` is the release URL under the shim (T122). The
// decision is by tag number, never ancestry: that repo is a depth-1 clone.
import { join } from "node:path";
import type { CommandExecutor } from "@effect/platform/CommandExecutor";
import { FileSystem } from "@effect/platform";
import { Array as Arr, Effect, Either, Option } from "effect";
import { SPEEPOBOX_DIRNAME } from "../config/paths.ts";
import {
  latestRelease,
  moveDecision,
  readRemoteReleases,
  type Release,
  releaseAt,
} from "../git/releases.ts";
import { pinIn, pinLineIn, PinRefusal, renderPinRefusal, withPin } from "../pin/pin.ts";
import { Reporter } from "../reporter.ts";
import { parseUpgradeArgv, UpgradeRefused } from "./argv.ts";
import { refresh } from "./refresh.ts";
import { shownPin } from "./render.ts";
import type { PinnedBefore, UpgradeSnapshot } from "./snapshot.ts";

export interface UpgradeOptions {
  // Resolved at the composition root: the served repo whose pin moves.
  readonly repoRoot: string;
  // The words after `upgrade`.
  readonly argv: ReadonlyArray<string>;
  // Decided once in `bin.ts` and passed down (19 §4): this repo has no pin.
  readonly selfHosted: boolean;
  // The repo the package lives in, whose `origin` the releases are read off.
  readonly packageRepoRoot: string;
}

const CONFIG = `${SPEEPOBOX_DIRNAME}/config.toml`;

const NOTHING_WRITTEN = "nothing was written";

const refuse = (detail: string): UpgradeRefused =>
  new UpgradeRefused({ detail: `${detail} — ${NOTHING_WRITTEN}` });

// Plain `upgrade` has nowhere to go from a pin no release names, whether it
// is a full SHA off a hand clone or a value the shim could not fetch (F6,
// amended).
const untagged = (value: string): UpgradeRefused =>
  refuse(`pin ${shownPin(value)} is no release; \`upgrade --to vN\` pins one explicitly`);

const noRelease = (): UpgradeRefused =>
  refuse("origin has no release (no vN tag) to pin; nothing to upgrade to");

// The file as bytes, decoded without dropping a byte-order mark, so the write
// back changes the one line and nothing else.
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
const encoder = new TextEncoder();

// `upgrade` answers nothing: a refusal is its failure, and the rest is the
// event the renderer prints.
export const upgrade = (
  options: UpgradeOptions,
): Effect.Effect<void, UpgradeRefused, Reporter | FileSystem.FileSystem | CommandExecutor> =>
  Effect.gen(function* () {
    const parsed = parseUpgradeArgv(options.argv);
    if (Either.isLeft(parsed)) {
      return yield* parsed.left;
    }
    // Before reading anything (F13, F8): the checked-out branch chooses this
    // repo's dispatcher.
    if (options.selfHosted) {
      return yield* refuse(
        `upgrade refused: ${options.repoRoot} is the repo speepobox itself lives in — its checked-out branch chooses the dispatcher, and there is no pin`,
      );
    }

    const fs = yield* FileSystem.FileSystem;
    const at = join(options.repoRoot, SPEEPOBOX_DIRNAME, "config.toml");
    // An absent file has no tool-sha line, and is told so in the grammar's
    // own sentence.
    const text = yield* fs.readFile(at).pipe(
      Effect.map((bytes) => decoder.decode(bytes)),
      Effect.catchAll((error) =>
        error._tag === "SystemError" && error.reason === "NotFound"
          ? refuse(renderPinRefusal(PinRefusal.NoLine()))
          : refuse(`upgrade could not read ${CONFIG}: ${error.message}`),
      ),
    );

    // Both forms need one line the grammar matches; `--to` needs no more.
    const line = pinLineIn(text);
    if (Either.isLeft(line)) {
      return yield* refuse(renderPinRefusal(line.left));
    }
    const { index, value } = line.right;
    // Plain `upgrade` needs a pin it can look up: an empty or short one is no
    // release, and refuses as an untagged one does — before the network.
    if (Option.isNone(parsed.right.to)) {
      const pin = pinIn(text);
      if (Either.isLeft(pin)) {
        return yield* untagged(value);
      }
    }

    // F15: a remote that fails or hangs refuses quoting git.
    const releases = yield* readRemoteReleases(options.packageRepoRoot).pipe(
      Effect.mapError((error) =>
        refuse(`upgrade could not read the releases from the package's origin: ${error.detail}`),
      ),
    );

    const decided = yield* decide(releases, value, parsed.right.to);
    const reporter = yield* Reporter;
    if (decided._tag === "Pinned") {
      yield* fs
        .writeFile(at, encoder.encode(withPin(text, index, decided.to.commit)))
        .pipe(
          Effect.mapError((error) => refuse(`upgrade could not write ${CONFIG}: ${error.message}`)),
        );
    }
    // T149: then the new release refreshes the scaffold. Its failure is
    // upgrade's, after the report — the pin is never moved back.
    const refreshed = yield* refresh(options.repoRoot, decided);
    yield* reporter.emit({
      _tag: "UpgradeReported",
      snapshot: decided,
      refresh: refreshed.outcome,
    });
    if (Option.isSome(refreshed.error)) {
      return yield* refreshed.error.value;
    }
  });

const pinnedBefore = (releases: ReadonlyArray<Release>, value: string): PinnedBefore =>
  Option.match(releaseAt(releases, value), {
    onNone: () => ({ _tag: "NoRelease", value }),
    onSome: (release) => ({ _tag: "Release", release }),
  });

// F13, by tag number: plain moves up to the newest or says the pin is
// current; `--to` takes any release in the list, lower ones included.
const decide = (
  releases: ReadonlyArray<Release>,
  value: string,
  to: Option.Option<string>,
): Effect.Effect<UpgradeSnapshot, UpgradeRefused> => {
  const latest = latestRelease(releases);
  if (Option.isNone(latest)) {
    return Effect.fail(noRelease());
  }
  if (Option.isSome(to)) {
    return Option.match(
      Arr.findFirst(releases, (release) => release.tag === to.value),
      {
        onNone: () =>
          Effect.fail(refuse(`${to.value} is not a release; the latest is ${latest.value.tag}`)),
        onSome: (release): Effect.Effect<UpgradeSnapshot, UpgradeRefused> =>
          Effect.succeed(
            release.commit === value
              ? { _tag: "Unchanged", release, explicit: true }
              : { _tag: "Pinned", to: release, was: pinnedBefore(releases, value) },
          ),
      },
    );
  }
  const move = moveDecision(releases, value);
  switch (move._tag) {
    case "Untagged":
      return Effect.fail(untagged(value));
    case "Current":
      return Effect.succeed({ _tag: "Unchanged", release: move.release, explicit: false });
    case "Move":
      return Effect.succeed({
        _tag: "Pinned",
        to: move.to,
        was: { _tag: "Release", release: move.from },
      });
  }
};
