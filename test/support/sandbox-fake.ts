// A fake `Sandbox` for the files whose subject is something else — the lock's
// row, the checkout's derived release — where a real `SandboxLive` over a
// scripted docker would only add argv nobody is asserting. It keeps the two
// halves that the rest of the scope can see: the spec it was handed, and the
// acquired/released pair on the ambient `Reporter`.
//
// `test/sandbox.test.ts` is where the real layer runs against a scripted
// docker, and `test/live/` is where it runs against a real daemon.
import { Effect, Layer, Ref } from "effect";
import { Reporter } from "../../src/reporter.ts";
import { Sandbox, SandboxError } from "../../src/sandbox/sandbox.ts";
import type { SandboxSpec } from "../../src/sandbox/spec.ts";

export interface FakeSandboxOptions {
  // The `SandboxError` detail each half fails with, when it is scripted to
  // fail at all: a daemon that refuses the start, and a removal that does not
  // take (matrix rows 6 and 19).
  readonly startFails?: string;
  readonly removeFails?: string;
  // What a command that reads answers with, one line per exec that asked for
  // output, in the order they ran (T76): the feature loop's boundary read is
  // the one such command, so a case scripts the SHA the branch stands at as
  // each issue begins. A loop that asks more times than this scripts gets the
  // last one again, and an unscripted fake answers nothing at all — which is
  // the rehearsal's case, and the plan's tip stands in for it (`feature.ts`).
  readonly answers?: ReadonlyArray<string>;
  // Every command an exec ran, in order: what makes "the boundary was read in
  // the container" an assertion about a value rather than about the absence of
  // a `Git` call beside it.
  readonly execs?: Ref.Ref<ReadonlyArray<ReadonlyArray<string>>>;
}

export const fakeSandbox = (
  started: Ref.Ref<ReadonlyArray<SandboxSpec>>,
  options: FakeSandboxOptions = {},
): Layer.Layer<Sandbox> =>
  Layer.effect(
    Sandbox,
    // The scripted answers are consumed in order, so the layer holds the one
    // piece of state a `Layer.succeed` could not: how many have been read.
    Effect.map(Ref.make(0), (asked) => ({
      run: (spec) =>
        Effect.gen(function* () {
          const reporter = yield* Reporter;
          return yield* Effect.acquireRelease(
            Ref.update(started, (current) => [...current, spec]).pipe(
              Effect.zipRight(
                options.startFails === undefined
                  ? Effect.succeed({ name: spec.name, id: spec.name })
                  : new SandboxError({ detail: options.startFails, sandboxGone: false }),
              ),
              Effect.tap(() => reporter.emit({ _tag: "ResourceAcquired", resource: "sandbox" })),
            ),
            () =>
              options.removeFails === undefined
                ? reporter.emit({ _tag: "ResourceReleased", resource: "sandbox" })
                : // Reported and swallowed, as the real one does: released is
                  // only ever emitted when the container really went.
                  reporter.emit({ _tag: "Warned", detail: options.removeFails }),
          );
        }),
      remove: () => Effect.void,
      // No case that reaches this fake builds an image; `image build`'s own
      // cases fake the tag themselves, because the spec is their assertion.
      build: () => Effect.void,
      // The setup hook reaches this too, and its output is logged rather than
      // read (T90): the hook's own cases run the real layer against a scripted
      // docker (`test/sandbox.test.ts`), where the argv is the assertion.
      exec: (_handle, command, execOptions) =>
        Effect.suspend(() =>
          options.execs === undefined
            ? Effect.void
            : Ref.update(options.execs, (seen) => [...seen, command]),
        ).pipe(
          Effect.zipRight(
            // Only a command that reads consumes an answer — the boundary and
            // a pass, which are handed stdin. The setup hook runs through here
            // too, with sinks for its output and nothing to read (T90).
            execOptions?.stdin === undefined
              ? Effect.void
              : Ref.getAndUpdate(asked, (count) => count + 1).pipe(
                  Effect.flatMap((count) => {
                    const answers = options.answers ?? [];
                    const answer = answers[Math.min(count, answers.length - 1)];
                    return answer === undefined ? Effect.void : execOptions.onOutput(answer);
                  }),
                ),
          ),
        ),
    })),
  );
