// A fake `Notifier` — the reason the tag exists (SPEC §2), and the only way
// "the notifier was invoked zero times" is an assertion at all. Every
// notification that crossed the seam lands in `sent`, in order, so a verbosity
// is a value comparison rather than a count of subprocesses.
//
// Most files below take it with no options: their subject is the lock, the
// checkout, or the land, and a run now tells somebody how it went whatever
// they are asserting. `test/notify.test.ts` is where what it said is the
// assertion, and where the real layer runs against the scripted executor for
// the half this cannot answer — which argv `osascript` was spawned with, and
// what an absent binary does.
import { Effect, Layer, Ref } from "effect";
import { type Notification, Notifier, NotifyError } from "../../src/notify/notifier.ts";

export interface FakeNotifierOptions {
  // Every notification that crossed the seam, for the file that asserts on
  // them.
  readonly sent?: Ref.Ref<ReadonlyArray<Notification>>;
  // The `NotifyError` detail every send fails with, when it is scripted to
  // fail: matrix row 21, where the failure is the subject.
  readonly fails?: string;
}

export const fakeNotifier = (options: FakeNotifierOptions = {}): Layer.Layer<Notifier> =>
  Layer.succeed(Notifier, {
    notify: (notification) =>
      Effect.suspend(() =>
        options.sent === undefined
          ? Effect.void
          : Ref.update(options.sent, (current) => [...current, notification]),
      ).pipe(
        Effect.zipRight(
          options.fails === undefined
            ? Effect.void
            : Effect.fail(new NotifyError({ detail: options.fails })),
        ),
      ),
  });
