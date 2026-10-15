// `--detach`'s three clocks (T153), apart from `detach.ts` so the renderer can
// name one without importing the module that composes the wait.
import { Duration } from "effect";

// Before the lock the child only reads git, fetches, and checks docker, so a
// child that has neither locked nor exited by now is hung on the network or
// the daemon.
export const START_TIMEOUT = Duration.seconds(120);
// How long the parent waits for a child it sent SIGINT to. It holds nothing
// before the lock, and a child that took it as the signal was sent tears down
// as an interrupted run does.
export const STOP_GRACE = Duration.seconds(30);
export const POLL_INTERVAL = Duration.millis(200);
