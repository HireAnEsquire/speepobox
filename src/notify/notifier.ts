// `Notifier` (SPEC §2): one method, over the host's desktop notification
// binary and through the subprocess chokepoint. It is the smallest tag in the
// port and earns one for exactly the reason SPEC §2 gives — trivially
// fakeable, so notification mechanics stay out of the dispatch core rather
// than becoming three lines of `osascript` inside the step that ends a run.
//
// Named for its role, not its vendor (AGENTS.md), and **no provider
// abstraction is built behind it** (05 Q22): the one binary it knows about is
// named once, below. A second host's notifier is a second implementation of
// this tag when a second host exists, not a strategy object today.
//
// **The binary is probed, not assumed.** bash asks `command -v osascript` and
// skips silently on a host without it (`run.sh:1117`); this package cannot ask
// that question the same way — `command -v` is a shell builtin and the
// chokepoint spawns argv with no shell (`runInShell` is grep-banned) — so the
// probe *is* the spawn: a binary that is not there fails to start, which the
// chokepoint already reports as its own kind of failure (`ExecError` is
// reserved for a child that never ran). That arrives here as a `NotifyError`
// the call site warns about and discards, which is the one thing an absent
// notifier is allowed to cost.
//
// **Title and body are argv, never script text** (`run.sh:1118-1120`): the
// AppleScript reads them out of `argv`, so a branch name or a stop reason
// carrying quotes cannot break out of a string literal — the same property the
// prompt pipe and the PR body rest on, one layer down.
import { CommandExecutor } from "@effect/platform";
import { Context, Data, Effect, Layer } from "effect";
import { exec } from "../internal/exec.ts";

// A notification that did not go out (SPEC §3). It is typed rather than a
// defect by the outcome-row test read from the other end: a notification
// nobody received does not give the *run* an outcome, so it never reaches the
// run's error channel at all — the call site catches it, warns through
// `Reporter`, and discards it (matrix row 21).
export class NotifyError extends Data.TaggedError("NotifyError")<{
  readonly detail: string;
}> {}

// What crosses the seam: the two strings bash passes as `argv` (`run.sh:1114`).
export interface Notification {
  readonly title: string;
  readonly body: string;
}

export interface NotifierShape {
  readonly notify: (notification: Notification) => Effect.Effect<void, NotifyError>;
}

export class Notifier extends Context.Tag("Notifier")<Notifier, NotifierShape>() {}

// The host binary, and the whole of what this package knows about it — as
// `gh` is for the forge.
const NOTIFIER_BINARY = "osascript";

// bash's script, verbatim (`run.sh:1118-1120`), and the reason it reads its
// two values out of `argv` rather than out of its own text is in the header.
const DISPLAY_NOTIFICATION = `on run argv
  display notification (item 2 of argv) with title (item 1 of argv)
end run`;

export const NotifierLive: Layer.Layer<Notifier, never, CommandExecutor.CommandExecutor> =
  Layer.effect(
    Notifier,
    Effect.gen(function* () {
      // Captured here rather than left in the method's requirements, exactly
      // as `ForgeLive` and `GitLive` capture it: a tag whose method asks for a
      // service leaks a mechanism through a domain seam.
      const executor = yield* CommandExecutor.CommandExecutor;

      return {
        notify: ({ title, body }) =>
          exec(NOTIFIER_BINARY, "-e", DISPLAY_NOTIFICATION, title, body).pipe(
            // The absent-binary arm, and the only one a host that simply is
            // not a mac ever takes.
            Effect.mapError(
              () =>
                new NotifyError({
                  detail: `${NOTIFIER_BINARY} not found — this host sends no desktop notifications`,
                }),
            ),
            Effect.flatMap((result) =>
              result.exitCode === 0
                ? Effect.void
                : Effect.fail(
                    new NotifyError({
                      detail:
                        result.stderr.trim() === ""
                          ? `${NOTIFIER_BINARY} exited ${result.exitCode}`
                          : `${NOTIFIER_BINARY} exited ${result.exitCode}: ${result.stderr.trim()}`,
                    }),
                  ),
            ),
            Effect.provideService(CommandExecutor.CommandExecutor, executor),
          ),
      };
    }),
  );
