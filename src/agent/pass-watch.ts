// What a pass's watch decides, as pure values (T52, ticket 20's ruling step 4
// of 6). Bash runs a `while kill -0` loop beside every pass (`run.sh:1470`)
// and says two things from it that have no port analogue: a heartbeat every
// two minutes, so a console with no timestamps shows time passing, and one
// advisory if an implement pass is still reading a third of the way into its
// budget. Narration alone is not the heartbeat — a single ten-minute test run
// narrates nothing.
//
// **The timing is the pure function and the fiber is a thin loop over it.**
// Nothing in the fake tier asserts timing through a forked sleep:
// `test/agent-cli.test.ts` row 9 already records why a `TestClock` version of
// that is a race whose green side is a test that never ran, and `exec-fake.ts`
// cannot make a scripted exec take test time. So what is asserted is this
// file, at plain values, and the loop over it is three reads and two emits.
import { Duration } from "effect";
import type { AgentPass } from "../reporter.ts";
import type { NarrationLine } from "./stream.ts";

// Bash's three numbers, kept as constants rather than config: they are the
// resolution of an advisory, not something a dispatcher tunes per run. The one
// number that *is* theirs — the pass budget — is what the warning is measured
// against.
export const WATCH_TICK: Duration.Duration = Duration.seconds(30);
const HEARTBEAT_EVERY = Duration.seconds(120);
const WARN_AT_FRACTION_OF_BUDGET = 3;

// The tools whose name is already the answer.
const WRITING_TOOLS: ReadonlyArray<string> = ["Write", "Edit", "NotebookEdit"];

// And the other half of "has written something": an agent that edits with a
// heredoc, `sed -i`, or `git apply` never emits one of the names above, and
// watching only those warned at an agent that was committing steadily. Each
// listed command writes unambiguously — a bare `>` is not among them precisely
// because `> /dev/null` is not a write — and over-matching only costs an
// advisory that stays quiet, which is the cheaper mistake of the two
// (`run.sh:1484-1490`).
const WRITING_COMMANDS: ReadonlyArray<string> = [
  "cat >",
  "tee ",
  "sed -i",
  "git apply",
  "git commit",
  "patch ",
];

// Where one command ends and the next begins, near enough: the four
// separators that open a command position. A quoted separator inside an
// argument splits wrongly, and that is accepted — this is an advisory's input
// and not a security boundary, so reading the common shapes right is the whole
// goal (T64).
//
// **The newline is not on this list and cannot be**: `briefFor` collapses
// `\s+` to one space before the event is ever built (`stream.ts:97`), so a
// `git add -A` and a `git commit -m x` on two lines reach here as one line
// whose only command head is `git add`, and read as a read. That is the
// commonest shape this misses, and it is the expensive direction of the two —
// the ruling above prices a spurious advisory above a silent one — but the
// separator is gone before `isWrite` runs, so recovering it means reading the
// raw input rather than the brief. Left as it is: the cost is capped at one
// advisory per pass by the `warned` flag.
const COMMAND_SEPARATORS = /&&|\|\||;|\|/;

// Whether a narration line is a write, by bash's rule. **A typed check over
// `tool` and `brief`**, not a regex over a rendered line: bash matched its own
// console format (`run.sh:1493`) because the log was the only record it had,
// and this package has the event — `brief` is the tool's `command` for a
// `Bash`, which is what that alternation was reading.
//
// **A listed command counts where it is run, not where it is spelled**: a pass
// narrating `echo "next I will git commit"` ran `echo`, and an agent saying
// what it is about to do is exactly the agent that has not done it — the pass
// the advisory exists for. So each segment is matched at its head rather than
// anywhere in the line. That keeps every write the list already caught,
// wherever on the line it runs (T64); the over-matching ruling above still
// decides what is *on* the list, and still decides anything ambiguous.
export const isWrite = (line: NarrationLine): boolean =>
  line.kind === "tool-use" &&
  (WRITING_TOOLS.includes(line.tool) ||
    (line.tool === "Bash" &&
      line.brief
        .split(COMMAND_SEPARATORS)
        .some((segment) =>
          WRITING_COMMANDS.some((command) => segment.trimStart().startsWith(command)),
        )));

export interface WatchTick {
  readonly pass: AgentPass;
  readonly elapsed: Duration.Duration;
  readonly budget: Duration.Duration;
  readonly wrote: boolean;
  readonly warned: boolean;
}

export interface WatchDue {
  readonly stillRunning: boolean;
  readonly noWritesYet: boolean;
}

// What one tick emits. Both answers are read off the tick rather than kept
// here: the loop owns the two `Ref`s, and this function owns the arithmetic.
export const dueAt = (tick: WatchTick): WatchDue => {
  // Bash counted its own sleeps (`hb=$((hb + 30))`) and so had an exact
  // multiple to take a modulo of. A clock read after a real sleep is
  // 120_037ms, which is a multiple of nothing, so the reading goes back onto
  // the tick grid first — otherwise the heartbeat is due at a moment that
  // never arrives.
  const tickMillis = Duration.toMillis(WATCH_TICK);
  const onTheGrid = Math.floor(Duration.toMillis(tick.elapsed) / tickMillis) * tickMillis;
  return {
    // Any pass: the line says the run is alive, and every pass is long enough
    // to need it said.
    stillRunning: onTheGrid > 0 && onTheGrid % Duration.toMillis(HEARTBEAT_EVERY) === 0,
    // The implement pass alone, once. A review round and a description pass
    // never warn: a round that finds nothing wrong writes nothing, and that is
    // the good case — so "you have read for a third of your budget" says
    // something about the ticket only when the pass was there to write code.
    noWritesYet:
      tick.pass === "implement" &&
      !tick.wrote &&
      !tick.warned &&
      Duration.toMillis(tick.elapsed) >=
        Duration.toMillis(tick.budget) / WARN_AT_FRACTION_OF_BUDGET,
  };
};
