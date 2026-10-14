// `src/agent/pass-watch.ts` (T52): what a watching tick decides, at plain
// values. No tag, no layer, and no forked sleep — the fiber in `agent-cli.ts`
// is a loop over these two functions precisely so the answers are assertable
// without one (row 9 of `test/agent-cli.test.ts` records why a `TestClock`
// version of that assertion is a race whose green side is a test that never
// ran).
import { describe, expect, it } from "@effect/vitest";
import { Duration } from "effect";
import { dueAt, isWrite, WATCH_TICK } from "../src/agent/pass-watch.ts";
import type { AgentPass } from "../src/reporter.ts";

const toolUse = (tool: string, brief: string) => ({ kind: "tool-use", tool, brief }) as const;

// The budget a dispatch actually runs with, so the third the warning waits for
// is a real number: five minutes of fifteen.
const BUDGET = Duration.minutes(15);

const at = (
  seconds: number,
  over: { readonly pass?: AgentPass; readonly wrote?: boolean; readonly warned?: boolean } = {},
) =>
  dueAt({
    pass: over.pass ?? "implement",
    elapsed: Duration.seconds(seconds),
    budget: BUDGET,
    wrote: over.wrote ?? false,
    warned: over.warned ?? false,
  });

describe("what counts as a write", () => {
  // The three tools whose name is the answer.
  it("counts the writing tools", () => {
    expect(isWrite(toolUse("Write", "src/agent/pass-watch.ts"))).toBe(true);
    expect(isWrite(toolUse("Edit", "src/run-log.ts"))).toBe(true);
    expect(isWrite(toolUse("NotebookEdit", "analysis.ipynb"))).toBe(true);
  });

  // And the shell that writes without ever emitting one of those names: bash
  // watched only the tool names first and warned at an agent that was
  // committing steadily.
  it("counts a Bash whose command writes", () => {
    expect(isWrite(toolUse("Bash", "sed -i s/a/b/ f"))).toBe(true);
    expect(isWrite(toolUse("Bash", "tee out"))).toBe(true);
    expect(isWrite(toolUse("Bash", "cat > f"))).toBe(true);
    expect(isWrite(toolUse("Bash", "git apply p.diff"))).toBe(true);
    expect(isWrite(toolUse("Bash", "git commit -m x"))).toBe(true);
    expect(isWrite(toolUse("Bash", "patch -p1 < d"))).toBe(true);
  });

  // A write in any command position, not only the first: a separator starts a
  // new command, and what runs after it writes exactly as much as what ran
  // before it (T64).
  it("counts a write that is not the first command on the line", () => {
    expect(isWrite(toolUse("Bash", "cd sub && git commit -m x"))).toBe(true);
    expect(isWrite(toolUse("Bash", "foo | tee out.txt"))).toBe(true);
  });

  // A read is a read, whichever shape it arrives in. The prose case is the one
  // that would make an agent talking about `git commit` look like an agent
  // running it — which is why this is a typed check over the event rather than
  // a regex over a rendered line.
  it("counts nothing else", () => {
    expect(isWrite(toolUse("Bash", "ls src"))).toBe(false);
    expect(isWrite(toolUse("Read", "/spec.md"))).toBe(false);
    expect(isWrite({ kind: "text", text: "next I will git commit the module" })).toBe(false);
  });

  // **The pass narrating a write is the pass that has not done one** — it ran
  // `echo` — and it is the pass the advisory exists to catch, so a listed
  // command mentioned inside an argument is not a match, quoted or not (T64).
  it("does not count a listed command a Bash only mentions", () => {
    expect(isWrite(toolUse("Bash", 'echo "next I will git commit"'))).toBe(false);
    expect(isWrite(toolUse("Bash", "echo git commit later"))).toBe(false);
  });

  // A `Bash` with nothing to match against: no command position, no command.
  it("counts a Bash with an empty brief as a read", () => {
    expect(isWrite(toolUse("Bash", ""))).toBe(false);
  });
});

describe("what one tick is due", () => {
  it("ticks every 30 seconds", () => {
    expect(WATCH_TICK).toEqual(Duration.seconds(30));
  });

  // Most ticks say nothing at all: the heartbeat is every fourth one, and the
  // warning is one tick in the whole pass.
  it("is neither on an ordinary tick", () => {
    expect(at(30)).toEqual({ stillRunning: false, noWritesYet: false });
    expect(at(90)).toEqual({ stillRunning: false, noWritesYet: false });
    expect(at(150)).toEqual({ stillRunning: false, noWritesYet: false });
  });

  // `run.sh:1505`: every two minutes, so a console with no timestamps shows
  // time passing.
  it("asks for a heartbeat at every two-minute multiple", () => {
    expect(at(120)).toEqual({ stillRunning: true, noWritesYet: false });
    expect(at(240)).toEqual({ stillRunning: true, noWritesYet: false });
    // A real clock reading is never the round number bash's own counter was,
    // so the tick that crossed two minutes is the one that carries the line.
    expect(at(120.037)).toEqual({ stillRunning: true, noWritesYet: false });
  });

  // A third of fifteen minutes, and it is the same tick's business as the
  // heartbeat's — 300s is not a two-minute multiple, so this one is the
  // warning alone.
  it("asks for the sizing warning once, at a third of the budget", () => {
    expect(at(300)).toEqual({ stillRunning: false, noWritesYet: true });
    // Said once (`warned=1` in bash): the advisory is about the ticket, and a
    // ticket does not get larger while the pass runs.
    expect(at(300, { warned: true })).toEqual({ stillRunning: false, noWritesYet: false });
  });

  // The pass has written, so there is nothing to warn about — whatever else it
  // spent its budget on.
  it("stays quiet once the pass has written something", () => {
    expect(at(300, { wrote: true })).toEqual({ stillRunning: false, noWritesYet: false });
  });

  // **A review round that finds nothing wrong writes nothing, and that is the
  // good case** — so the sizing signal is the implement pass's alone, as it is
  // in bash's `watch_writes` arm. The heartbeat is not: every pass is long
  // enough to need the run to say it is alive.
  it("never warns a review or a description pass", () => {
    expect(at(300, { pass: "review" })).toEqual({ stillRunning: false, noWritesYet: false });
    expect(at(300, { pass: "describe-pr" })).toEqual({ stillRunning: false, noWritesYet: false });
    expect(at(240, { pass: "review" })).toEqual({ stillRunning: true, noWritesYet: false });
  });
});
