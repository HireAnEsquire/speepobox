// The setup step (SPEC §4, matrix row 7): the run's first work inside the
// container it just started, and the last thing that happens before the agent
// pass T9 adds. It is not a resource — nothing is acquired here and nothing is
// released — which is why it is a step in the scope rather than a bracket
// beside the other three.
//
// **Generic and config-declared**: the config names a host script, the sandbox
// spec mounts it read-only, and this runs it through `Sandbox.exec`. Nothing
// hae-specific reaches the package — `.agentbox/setup-db.sh` is what one host
// happens to declare, and a run whose config names none has no setup step at
// all rather than a skipped one.
//
// Its failure is a typed `SandboxError` (the outcome-row test: the run started,
// so it owes a row) and the caller stages it at `setup`, releasing sandbox,
// checkout, and lock in reverse on the way out.
//
// **And it says what it did** (T90): every line the hook prints is a
// `SetupOutput`, its finish carries how long it took, and its failure is a
// `SetupFailed` emitted before the scope releases — so the run log's last word
// before the releases is the reason, not silence. It has a budget too,
// `setup-timeout`, which is the pass budget's shape: the caller's timeout.
import { Clock, Duration, Effect, Option } from "effect";
import { SpeepoboxConfig } from "../config/config.ts";
import { Reporter } from "../reporter.ts";
import { Sandbox, SandboxError, type SandboxHandle } from "../sandbox/sandbox.ts";
import { setupHookMount } from "../sandbox/spec.ts";

// `bash <script>` rather than the script itself: the mount is read-only and
// carries whatever mode the host file had, so a hook without its execute bit
// would fail for a reason that has nothing to do with what it does. bash names
// the interpreter the same way (`run.sh:1361`).
const SETUP_HOOK_INTERPRETER = "bash";

// What a hook that ran past its budget fails with: the limit and the key that
// sets it, since raising the key is one of the two things a dispatcher can do
// about it and the other — a slow registry — is not this package's to name.
const timedOut = (seconds: number): SandboxError =>
  new SandboxError({
    detail: `the setup hook ran past its ${seconds}s budget and was killed — raise setup-timeout if it needs longer`,
    sandboxGone: false,
  });

// Stderr arrives whole, once the hook exits; the log wants it a line at a
// time, like stdout. The trailing newline every well-behaved tool ends on is
// not a blank line the hook said.
const linesOf = (said: string): ReadonlyArray<string> =>
  said === "" ? [] : said.replace(/\n$/, "").split("\n");

// `repoRoot` is the host fact the hook's own path is anchored to, arriving as
// a parameter for the reason every host read does (AGENTS.md).
export const runSetupHook = (
  handle: SandboxHandle,
  repoRoot: string,
): Effect.Effect<void, SandboxError, Sandbox | SpeepoboxConfig | Reporter> =>
  Effect.gen(function* () {
    const config = yield* SpeepoboxConfig;
    const sandbox = yield* Sandbox;
    const reporter = yield* Reporter;
    // The same derivation the mount came from, so the command names the path
    // the container was actually given. `onNone` is the absent hook, and it is
    // the run proceeding rather than a failure of any kind.
    return yield* Option.match(setupHookMount(repoRoot, config.setupHook), {
      onNone: () => Effect.void,
      onSome: (hook) =>
        Effect.gen(function* () {
          const startedAt = yield* Clock.currentTimeMillis;
          const elapsed = Effect.map(Clock.currentTimeMillis, (now) =>
            Duration.millis(now - startedAt),
          );
          yield* sandbox
            .exec(handle, [SETUP_HOOK_INTERPRETER, hook.target], {
              onOutput: (line) => reporter.emit({ _tag: "SetupOutput", stream: "stdout", line }),
              onStderr: (said) =>
                Effect.forEach(
                  linesOf(said),
                  (line) => reporter.emit({ _tag: "SetupOutput", stream: "stderr", line }),
                  { discard: true },
                ),
            })
            .pipe(
              // The budget, from the tag (05 Q7), as the caller's timeout and
              // never a `timeout` wrapped around the script in the container
              // (AGENTS.md, *the pass budget is the caller's timeout*): the
              // interrupt closes the exec's own scope, which kills the docker
              // child, wherever the hang is.
              Effect.timeoutFail({
                duration: Duration.seconds(config.setupTimeoutSeconds),
                onTimeout: () => timedOut(config.setupTimeoutSeconds),
              }),
              // Outside the timeout, so the kill is reported as well as the
              // nonzero exit, and before the error propagates, so it lands
              // inside the run log's bracket.
              Effect.tapError((error) =>
                Effect.flatMap(elapsed, (at) =>
                  reporter.emit({ _tag: "SetupFailed", detail: error.detail, elapsed: at }),
                ),
              ),
            );
          yield* reporter.emit({ _tag: "SetupFinished", elapsed: yield* elapsed });
        }),
    });
  });
