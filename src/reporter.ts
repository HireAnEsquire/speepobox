import { Context, type Duration, type Effect, type Option } from "effect";
import type { AgentPassReason } from "./agent/agent-cli.ts";
import type { PromptRoot } from "./agent/prompt-source.ts";
import type { PassUsage } from "./agent/stream.ts";
import type { ReviewRound, ReviewVerdict } from "./agent/verdict.ts";
import type { DispatchPlan } from "./dispatch/plan.ts";
import type { GcSnapshot } from "./gc/snapshot.ts";
import type { InitSnapshot } from "./init/snapshot.ts";
import type { PullRequest } from "./ledger/record.ts";
import type { StatusSnapshot } from "./status/snapshot.ts";
import type { UpgradeSnapshot } from "./upgrade/snapshot.ts";

export type ProbeStatus = "ok" | "warn" | "fail";

// The resources the run's `Scope` holds, in acquisition order (SPEC §4), and
// the order the release assertions read in reverse.
export type RunResource = "lock" | "checkout" | "sandbox";

// Which agent pass an event belongs to. All three are here now: the PR
// description joined the other two with its caller (T12), the way every other
// seam in this package grew.
export type AgentPass = "implement" | "review" | "describe-pr";

// Structured in-flight events are the source of progress (05 §4); renderers —
// the console, later a log file — subscribe. T1 carried the one event doctor
// needs; T2 adds the two `status` needs; dispatch events arrive with the
// dispatch core.
export type ReporterEvent =
  | {
      readonly _tag: "ProbeChecked";
      readonly probe: string;
      readonly status: ProbeStatus;
      readonly detail: string;
    }
  // Something degraded but nothing failed — a skipped ledger line, a
  // finalizer that swallowed its own error.
  | { readonly _tag: "Warned"; readonly detail: string }
  // The `status` screen as a value; the renderer is the subscriber.
  | { readonly _tag: "StatusReported"; readonly snapshot: StatusSnapshot }
  // The `gc` listing as a value (T99), rendered as `status`'s is. Not a step
  // notification: gc is not a run.
  | { readonly _tag: "GcReported"; readonly snapshot: GcSnapshot }
  // What `init` wrote and kept (T114), rendered as `gc`'s listing is, with
  // the next steps under it. Not a step notification: init is not a run.
  | { readonly _tag: "InitReported"; readonly snapshot: InitSnapshot }
  // Where `upgrade` moved the pin, or that it stayed (T128), rendered as
  // `init`'s report is. Not a step notification: upgrade is not a run.
  | { readonly _tag: "UpgradeReported"; readonly snapshot: UpgradeSnapshot }
  // What a dispatch resolved to before it acquired anything. Emitted once,
  // by the one derivation, so T15's `--dry-run` prints this rather than
  // re-deriving a second answer (05 Q20).
  | { readonly _tag: "PlanResolved"; readonly plan: DispatchPlan }
  // A resource of the run's `Scope` crossing its boundary, emitted by the
  // resource itself. This is what the ordering invariant — lock before
  // checkout, released in reverse — is asserted off (SPEC §11): the test
  // `Reporter` appends the events to a `Ref`, so the assertion is a plain
  // value comparison rather than a mock's call log.
  | { readonly _tag: "ResourceAcquired"; readonly resource: RunResource }
  // Only ever emitted when the resource really let go: a checkout kept
  // because its commits did not make it home warns instead (matrix row 18).
  | { readonly _tag: "ResourceReleased"; readonly resource: RunResource }
  // The host branch moved to the base under `--hard-reset` (T101), emitted by
  // the checkout's acquire once the compare-and-set went through. The log is
  // the reset's audit trail, so it carries **both** discarded tips as full
  // SHAs: the local one the branch was moved from, and origin's when origin
  // had the branch — the leased push discards that one, and this line is the
  // only place it is recorded. Not a step notification (AGENTS.md): it happens
  // while the dispatch command is still on screen.
  | {
      readonly _tag: "BranchReset";
      readonly branch: string;
      readonly from: string;
      readonly originTip: Option.Option<string>;
      readonly to: string;
      readonly discarding: number;
    }
  // The assembled prompt, **verbatim**, before the pass it belongs to runs
  // (`run.sh:1144-1149`). Self-authored and secret-free — the credential is
  // forwarded by name and never interpolated — so nothing here is redacted,
  // and "what exactly was this agent told" is answerable from the log alone.
  // **And which root the template came from** (T14): a client who dropped an
  // override into their runtime root reads this line to see it take, and reads
  // it again to see the package default come back when they remove it. It is a
  // field beside the text rather than a line inside it — the prompt is
  // verbatim, and a provenance note in those bytes is a note the agent reads as
  // an instruction.
  // **And which issue the pass was for** (T75), on the arm where a pass is for
  // one: a feature run assembles three prompts per issue, and a log line that
  // says which template root it came from but not which issue it was for leaves
  // "what exactly was this agent told, and about what" half-answered. The id
  // rather than the file or the boundary, which are already verbatim in the
  // prompt this event carries. `None` on a spec run and an inline one.
  | {
      readonly _tag: "PromptAssembled";
      readonly pass: AgentPass;
      readonly prompt: string;
      readonly root: PromptRoot;
      readonly issue: Option.Option<string>;
    }
  // One line of a pass's **narration**, as it arrives. Progress is the event
  // stream (05), so this is how a pass narrates: a `process.stdout.write`
  // inside the pass typechecks and would bypass the run log, which is the file
  // someone reads afterwards.
  //
  // **Structured, not a line of text** (ticket 20, T51): what the CLI prints
  // is JSONL, and `agent/stream.ts` folds it into the two things a pass says
  // while it works — its prose, one event per line, and the tools it uses,
  // with bash's 160-char brief. Each renderer owns its prefix from that shape
  // rather than re-deriving one out of prose, and **narration is never the
  // answer**: what a verdict or a PR body is read from is the result event's
  // text, which no event carries.
  | {
      readonly _tag: "AgentOutput";
      readonly pass: AgentPass;
      readonly kind: "text";
      readonly text: string;
    }
  | {
      readonly _tag: "AgentOutput";
      readonly pass: AgentPass;
      readonly kind: "tool-use";
      readonly tool: string;
      readonly brief: string;
    }
  // One line of what the setup hook printed (T90), as it arrives on stdout and
  // all at once from stderr when it exits — the `Sandbox.exec` halves a pass
  // uses. Its own event rather than an `AgentOutput`, so every renderer marks
  // it as the hook's: `npm ci` stalling on a registry is not the agent
  // talking. Never a step notification (AGENTS.md).
  | {
      readonly _tag: "SetupOutput";
      readonly stream: "stdout" | "stderr";
      readonly line: string;
    }
  // One line of what `docker build` printed while `bessemer image build` ran
  // (T111), as it arrives, from either stream — BuildKit narrates on stderr.
  // Emitted by the command's `onOutput`, never by the `Sandbox` layer. Its
  // own event rather than a `SetupOutput`: no run is in progress, and a
  // build is not a hook. Never a step notification (AGENTS.md).
  | { readonly _tag: "ImageBuildOutput"; readonly line: string }
  // The hook exited zero, and how long it took: the one line that tells a
  // dispatcher watching the console the run has moved from setup to the first
  // pass. Not a step notification — bash's "setup complete" is the one
  // AGENTS.md drops by name.
  | { readonly _tag: "SetupFinished"; readonly elapsed: Duration.Duration }
  // The other end (T90), and T55's `PassFailed` for the setup step: the typed
  // `SandboxError` renders on stderr at exit, after the log's bracket has
  // closed, so without this a failed hook's log stopped at the releases and
  // never said why. `detail` is the error's own string — the command, the
  // exit code, and the hook's stderr, or the limit it ran past. Not a step
  // notification: the failure ends the run and the terminal one says so.
  | {
      readonly _tag: "SetupFailed";
      readonly detail: string;
      readonly elapsed: Duration.Duration;
    }
  // The two things bash's watch loop says while a pass runs (T52,
  // `run.sh:1470-1506`), and the two the port had no analogue for. Both carry
  // the budget beside the elapsed, because "how long has this been going" is
  // only an answer next to "out of how long".
  //
  // The heartbeat, every two minutes and for **any** pass: narration alone is
  // not one — a single ten-minute test run narrates nothing — and a console
  // with no timestamps otherwise shows a pass and then silence. Never a step
  // notification (AGENTS.md): nothing ended.
  | {
      readonly _tag: "PassStillRunning";
      readonly pass: AgentPass;
      readonly elapsed: Duration.Duration;
      readonly budget: Duration.Duration;
    }
  // And the sizing signal, once, a third of the way into an implement pass
  // that has not written anything yet (`run.sh:1493`). It is an advisory and
  // not a failure: the agent that reads longest is often the one about to
  // write the most, and the rest of the budget still buys committed work.
  // Which narration lines count as a write is `agent/pass-watch.ts`'s answer,
  // and a review round is exempt there — a round that finds nothing wrong
  // writes nothing, and that is the good case.
  | {
      readonly _tag: "NoWritesYet";
      readonly pass: AgentPass;
      readonly elapsed: Duration.Duration;
      readonly budget: Duration.Duration;
    }
  // A pass's child exited and did not fail — the bracket that closes what
  // `PromptAssembled` opened. Emitted for **both** passes rather than only the
  // one anybody notifies about: an event named for the pass that fires for one
  // pass is an event whose name is a lie, and which renderer cares about which
  // pass is that renderer's question. A pass that failed or ran out of its
  // budget emits `PassFailed` below instead — one terminal event either way,
  // never both, so "did the pass work" has a single answer in the stream.
  //
  // **It carries what the pass cost** (T55): `elapsed` from just before the
  // exec started, and the `result` event's own usage, which is bash's
  // `claude $ usage` line that the port had dropped. The figures are the
  // CLI's, taken through the one fold (`agent/stream.ts`), so the ledger row
  // T53 writes stays derivable from the event stream (05).
  //
  // **And which issue the pass was for** (T76), like `PromptAssembled` above
  // and for its reason: a feature run's passes are for different issues, so a
  // finish line that does not say which one closes a bracket a reader cannot
  // match to the prompt that opened it. `None` on a spec run and an inline
  // one.
  | {
      readonly _tag: "AgentPassFinished";
      readonly pass: AgentPass;
      readonly issue: Option.Option<string>;
      readonly elapsed: Duration.Duration;
      readonly usage: PassUsage;
    }
  // The other end, and the one ticket 20 found missing underneath the
  // silence: **a killed run's log did not say it was killed.** The typed
  // `AgentPassFailed` renders on stderr at exit, after the log's bracket has
  // closed, so the file a failed run leaves behind ended mid-narration with no
  // word of how. `detail` is the error's own string rather than a second
  // wording, so the log and the exit line say the same thing.
  //
  // `usage` is some only when the stream carried a `result` event, which is
  // the error-result case alone: bash reports the cost of a failed pass on the
  // same grounds, because that is the expensive failure worth seeing. A kill,
  // a lost sandbox, and a stream that ended without a result have no usage to
  // report and say none rather than zeros, which would read as a pass that
  // cost nothing.
  //
  // It names the issue beside the pass for the reason the event above does
  // (T76), and here it is what tells a reader *which* issue a feature run
  // stopped on without going to the ledger for it.
  | {
      readonly _tag: "PassFailed";
      readonly pass: AgentPass;
      readonly issue: Option.Option<string>;
      readonly reason: AgentPassReason;
      readonly detail: string;
      readonly elapsed: Duration.Duration;
      readonly usage: Option.Option<PassUsage>;
    }
  // What a review round decided, as the loop read it out of that round's own
  // output (T10). It is an event and not a return value quietly kept: the
  // ledger row's `outcome` is this verdict, and the record stays derivable
  // from the event stream (05). bash says the same line per round
  // (`run.sh:1365`).
  //
  // **And which issue the round was about** (T76): a feature run's rounds are
  // about different issues and each one's verdict is that issue's outcome, so
  // a verdict with no issue on it is a line a reader cannot attribute
  // (`run.sh:1847`). `None` on a spec run and an inline one, whose verdict is
  // the run's.
  | {
      readonly _tag: "ReviewVerdictReached";
      readonly issue: Option.Option<string>;
      readonly round: ReviewRound;
      readonly verdict: ReviewVerdict;
    }
  // The land's answer, in the two counts bash says at the same point
  // (`run.sh:1546`): what this run added past the tip it started from, and
  // what the branch holds past the diff boundary. Emitted after the push, so
  // it is the run saying the commits are home rather than that it tried.
  //
  // **Both counts are what the push carried** (T90): T77's status commit is
  // made after they were first taken, so it is counted in beside the agent's
  // commits, and `statusCommit` says it is one of them rather than leaving a
  // reader to wonder why the count is one more than the agent made.
  | {
      readonly _tag: "CommitsPushed";
      readonly thisRun: number;
      readonly sinceBoundary: number;
      readonly statusCommit: boolean;
    }
  // T77's status commit, made (T90): the one commit on the branch the
  // dispatcher's own identity authored, so the log names it rather than
  // leaving it to a count. Its failure is a `Warned` and never this. Not a
  // step notification: the land is the end of the run said early (AGENTS.md).
  | {
      readonly _tag: "StatusCommitted";
      readonly stems: ReadonlyArray<string>;
      readonly branch: string;
    }
  // The other half of the same step, and deliberately its own sentence rather
  // than the one above with zeros in it: a branch with nothing past the
  // boundary is not pushed, is not a failure, and must read as neither
  // (`run.sh:1589-1592`).
  | { readonly _tag: "NothingToLand" }
  // A hard reset pushed with nothing to land (T105): emitted only by the
  // land's empty arm under `--hard-reset`, after `NothingToLand`, when origin
  // had the branch somewhere other than the base. It is the run log's record
  // that origin's `originTip` was overwritten by the leased push. Not a step
  // notification (AGENTS.md): it lands seconds before the terminal one.
  | { readonly _tag: "ResetPushed"; readonly branch: string; readonly originTip: string }
  // What a rehearsal would have done, said by the service that would have
  // done it (T15). A recording layer keeps its reads real and answers a
  // mutation with this instead of performing it, so `--dry-run`'s "intended
  // mutations" are the event stream rather than a second block printed by a
  // second code path — the shape 05 Q20 rejects. It is the one event a real
  // dispatch never emits, and the only difference between the two streams.
  //
  // **Not a step notification** (AGENTS.md): nobody is woken by a run that is
  // not running.
  | { readonly _tag: "MutationRecorded"; readonly detail: string }
  // The run's last answer (T12): where the work is now readable, and whether
  // this dispatch opened that PR or updated the one an earlier run left. It
  // carries the whole `PullRequest` because the ledger row records the number
  // beside the URL and the record stays derivable from the event stream (05)
  // — a URL alone here would make the row's number a second derivation.
  | {
      readonly _tag: "PullRequestReady";
      readonly pr: PullRequest;
      readonly action: "created" | "updated";
    };

export interface ReporterShape {
  readonly emit: (event: ReporterEvent) => Effect.Effect<void>;
}

export class Reporter extends Context.Tag("Reporter")<Reporter, ReporterShape>() {}
