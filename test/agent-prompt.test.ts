// The pass prompts — implement (T9), review (T10), and the PR description
// (T12): a package file plus a pure interpolation function each (SPEC §8),
// where the second is the first's function plus one line and the third is the
// one that shares neither. Pure and tagless, so this file needs no layer — the
// assertions are about the text an agent is handed and about where the default
// lives, which is the half T14's precedence chain has to keep working.
import { describe, expect, it } from "@effect/vitest";
import { readFileSync } from "node:fs";
import { Option } from "effect";
import { packageRoot } from "../src/config/paths.ts";
import {
  DESCRIBE_PR_PROMPT,
  describePrPromptFor,
  FEEDBACK_CLOSE,
  FEEDBACK_OPEN,
  IMPLEMENT_PROMPT,
  implementPromptFor,
  inlineTaskReviewCriteria,
  NO_SPEC_MOUNTED,
  packagePromptPath,
  type PassRun,
  PR_CONTEXT_CLOSE,
  PR_CONTEXT_OPEN,
  PROJECT_CONTEXT_HEADING,
  PROMPTS_DIRNAME,
  promptPathIn,
  renderDescribePrPrompt,
  renderImplementPrompt,
  renderReviewPrompt,
  REVIEW_PROMPT,
  reviewPromptFor,
  TASK_CLOSE,
  TASK_OPEN,
  withDispatcherFeedback,
  withProjectContext,
} from "../src/agent/prompt.ts";
import { featureDispatch, specDispatch } from "../src/dispatch/plan.ts";
import { fileNameOf } from "../src/issues/issue.ts";
import { FEATURE_ISSUES_TARGET } from "../src/sandbox/spec.ts";
import { fakeIssue } from "./support/issue-store-fake.ts";
import type { RunIdentity } from "../src/ledger/record.ts";
import { DESCRIPTION_CLOSE, DESCRIPTION_OPEN } from "../src/agent/description.ts";
import { APPROVED_MARKER, FIXED_MARKER } from "../src/agent/verdict.ts";

// The spec run, whole: the two facts every message names, the task the passes
// are for, and what the run *is*. The last is what the resuming sentence is
// keyed off — never the arm (T66) — so it is on every fixture here rather than
// on the ones that happen to need it.
const SPEC_PATH = "/repo/tasks/T9.md";

const RUN = {
  branch: "speepobox-t9",
  mergeBaseSha: "2222222222222222222222222222222222222222",
  ...specDispatch(SPEC_PATH),
  // No issue: a spec run's passes are for the spec, and which issue a pass is
  // for is the feature arm's fact alone (T75). Every message below is assembled
  // over this, so "the spec arm is byte-unchanged" is asserted by the whole
  // suite rather than by one case.
  current: Option.none(),
} satisfies PassRun;

// The same run, resumed: the identity a `--resume` of that branch carries
// forward (T16), and the only difference between the two fixtures.
const RESUMED: RunIdentity = {
  _tag: "FeedbackResume",
  resumed: { _tag: "OneOff", spec: SPEC_PATH },
  resumedRunId: Option.some("speepobox-t9-1786000000000"),
};

describe("the implement prompt", () => {
  // The package-root arm of T14's chain, spelled once: a name resolves under
  // `<root>/prompts`, so the client arm is the same expression against the
  // runtime root and the two cannot drift.
  it("resolves a prompt name under the package's own prompts directory", () => {
    expect(packagePromptPath(IMPLEMENT_PROMPT)).toBe(
      `${packageRoot}/${PROMPTS_DIRNAME}/${IMPLEMENT_PROMPT}.md`,
    );
    expect(promptPathIn("/runtime", IMPLEMENT_PROMPT)).toBe(
      `/runtime/${PROMPTS_DIRNAME}/${IMPLEMENT_PROMPT}.md`,
    );
  });

  // The default really is a file, and it is the one the path names — a prompt
  // the package itself is missing is our own invariant breaking, so the run
  // dies on it rather than degrading.
  it("ships the implement default as a file at that path", () => {
    const template = readFileSync(packagePromptPath(IMPLEMENT_PROMPT), "utf8");
    // What the template is *for*, now that where the spec is has moved into the
    // dispatcher's message (T37): the shipped prose says how to work, and the
    // generated message says what this run's facts are. The scope clause has to
    // survive that move with a referent that is true on both arms — the message
    // *plus what it points at*, which is the spec on a spec run and the text
    // itself on an inline one.
    expect(template).toContain(
      "Your task is the dispatcher's message below together with whatever it",
    );
    expect(template).toContain("exactly what the task describes, nothing beyond it");
    // Checkpointing is what makes a single-shot pass affordable (05 Q16R):
    // a failed pass keeps whatever it committed, so the default has to ask
    // for commits as the work goes.
    expect(template).toContain("Checkpoint your work");
    // The package's own defaults, not hae's: nothing here names the repo the
    // port was carried out of (SPEC §12's expected-divergence list).
    expect(template).not.toContain("hae");
  });

  it("appends the dispatcher's message: the spec's path, the branch, the boundary", () => {
    const assembled = renderImplementPrompt("# TASK\n\nRead the spec.\n", RUN);
    expect(assembled).toBe(
      [
        "# TASK",
        "",
        "Read the spec.",
        // The sentence that used to open `implement.md` — same imperative,
        // same file, generated now that whether it is mounted is a fact only
        // the dispatcher has (T37).
        "Your task spec is the file /spec.md, mounted read-only — read it first.",
        `You are on branch ${RUN.branch}. The task's diff boundary (its merge-base with the PR base) is commit ${RUN.mergeBaseSha}.`,
      ].join("\n"),
    );
  });

  // Trailing newlines in the template are the file's formatting, not blank
  // lines in the prompt: the message follows the template's last line whatever
  // the editor left behind it.
  it("keeps the message one line below the template, however the file ends", () => {
    const message = renderImplementPrompt("body", RUN).split("\n").slice(1);
    expect(renderImplementPrompt("body\n\n\n", RUN).split("\n").slice(1)).toEqual(message);
  });

  // Interpolation stays pure and it stays *only* the message: the spec is
  // mounted read-only at /spec.md and the agent reads it there, so nothing a
  // spec contains is ever assembled into the text a pass is handed.
  it("interpolates nothing but the branch and the boundary", () => {
    const assembled = renderImplementPrompt("$(rm -rf /) `whoami`", {
      ...RUN,
      branch: "topic/$(id)",
      mergeBaseSha: "`hostname`",
    });
    expect(assembled).toContain("$(rm -rf /) `whoami`");
    expect(assembled).toContain("You are on branch topic/$(id).");
    expect(assembled).toContain("commit `hostname`.");
  });
});

// The review prompt (T10): the same two halves, and the same three facts an
// implementer is told — which spec, which branch, which boundary — with the
// spec named in the round's own register since T37. What it adds is the round
// note, because rounds share no memory.
describe("the review prompt", () => {
  it("ships the review default as a file under the package's prompts directory", () => {
    expect(packagePromptPath(REVIEW_PROMPT)).toBe(
      `${packageRoot}/${PROMPTS_DIRNAME}/${REVIEW_PROMPT}.md`,
    );
    const template = readFileSync(packagePromptPath(REVIEW_PROMPT), "utf8");
    // The markers the loop reads its verdict back out of: a default that stops
    // asking for one turns every round into `needs-work`.
    expect(template).toContain(APPROVED_MARKER);
    expect(template).toContain(FIXED_MARKER);
    expect(template).toContain("<verdict>needs-work</verdict>");
    // And what to do with the section T17 appends: on a spec run the feedback
    // arrives *beside* a spec the same template says to be faithful to, so a
    // round with no framing for it can read the dispatcher's own instructions
    // as work beyond the spec and revert them.
    expect(template).toContain(FEEDBACK_OPEN);
    expect(template).toContain("dispatcher-authorized");
    expect(template).not.toContain("hae");
  });

  // The branch and the boundary are the implement message's, spelled once; the
  // spec sentence is the round's own. It moved out of `review.md` with T37 —
  // the template said "the spec is `/spec.md` (mounted read-only)" and the
  // message says what a reviewer does with it, which the implement pass's
  // "read it first" never did.
  it("names the spec as the fidelity standard, then the branch, boundary, and round", () => {
    const assembled = renderReviewPrompt("# ROLE\n\nReview it.\n", RUN, { index: 1, of: 3 });
    expect(assembled).toBe(
      [
        "# ROLE",
        "",
        "Review it.",
        "The spec the work was implemented from is the file /spec.md, mounted read-only — it is the standard you judge fidelity against.",
        `You are on branch ${RUN.branch}. The task's diff boundary (its merge-base with the PR base) is commit ${RUN.mergeBaseSha}.`,
        "This is review round 1 of 3.",
      ].join("\n"),
    );
    // Not the implement pass's register: a reviewer told to read the spec first
    // is being told to implement it.
    expect(assembled).not.toContain("read it first");
  });

  // The last round has nothing behind it, so the note stops being bookkeeping
  // and becomes the instruction that keeps a fix from going unreviewed
  // (`run.sh:563-570`).
  it("tells the final round that nothing it commits will be re-reviewed", () => {
    const last = renderReviewPrompt("body", RUN, { index: 3, of: 3 });
    expect(last).toContain("This is review round 3 of 3.");
    expect(last).toContain("It is the LAST round");
    expect(last).toContain("needs-work");
    expect(renderReviewPrompt("body", RUN, { index: 2, of: 3 })).not.toContain("LAST round");
  });

  // A budget of one is one round, and that round is the last one — the case
  // the ticket's own cap rehearsal dispatches with.
  it("treats a single-round budget as the last round", () => {
    expect(renderReviewPrompt("body", RUN, { index: 1, of: 1 })).toContain("It is the LAST round");
  });
});

// The description prompt (T12): the same two halves again, and the one pass
// whose dispatcher's message is its own — it is not implementing or reviewing
// a spec, it is describing a range of commits.
describe("the PR description prompt", () => {
  it("ships the describe-pr default as a file under the package's prompts directory", () => {
    expect(packagePromptPath(DESCRIBE_PR_PROMPT)).toBe(
      `${packageRoot}/${PROMPTS_DIRNAME}/${DESCRIBE_PR_PROMPT}.md`,
    );
    const template = readFileSync(packagePromptPath(DESCRIBE_PR_PROMPT), "utf8");
    // The default has to name the markers the extraction reads
    // (`src/agent/description.ts`), and has to say what falls outside them —
    // the prompt asking for no preamble is what already failed, so what earns
    // its place here is telling the agent where narration may legally go.
    expect(template).toContain(DESCRIPTION_OPEN);
    expect(template).toContain(DESCRIPTION_CLOSE);
    expect(template).toContain("lands verbatim in the PR body");
    expect(template).toContain("outside them is discarded");
    // The same section, and what this pass owes it: a body that describes a
    // feedback-driven choice as an unexplained deviation is the one T17 makes
    // reachable on every steered run.
    expect(template).toContain(FEEDBACK_OPEN);
    expect(template).toContain("dispatcher-authorized");
    expect(template).not.toContain("hae");
  });

  it("asks for the work on this branch, past this run's diff boundary", () => {
    const assembled = renderDescribePrPrompt("# ROLE\n\nDescribe it.\n", RUN);
    expect(assembled).toBe(
      [
        "# ROLE",
        "",
        "Describe it.",
        // `describe-pr.md`'s own sentence, generated since T37 — the pass reads
        // the spec as background, and it is the *dispatcher* that knows whether
        // there is one to read.
        "The spec the work was implemented from is the file /spec.md, mounted read-only — background for the overview, not an instruction to carry out.",
        `Describe the work on branch ${RUN.branch}: every commit after ${RUN.mergeBaseSha}.`,
      ].join("\n"),
    );
  });

  // Not the implement pass's message: a description pass told to "read the
  // spec first" and "you are on branch X" is being told to implement.
  it("carries neither of the implement message's two lines", () => {
    const assembled = renderDescribePrPrompt("body", RUN);
    expect(assembled).not.toContain("read it first");
    expect(assembled).not.toContain("You are on branch");
  });
});

// The project-context fragment (T14): the second extension point, and the
// narrow one. It is appended as its own section rather than patched into the
// template — no placeholder, no slot, nothing in a prompt file to keep in step
// with a schema, which is the mini-templating-language 05 Q9 refused.
describe("the project-context fragment", () => {
  const TEMPLATE = "# TASK\n\nImplement the spec.\n";

  it("appends the fragment under its own heading, one blank line below", () => {
    expect(
      withProjectContext(TEMPLATE, Option.some("Run `npm run verify` from the repo root.")),
    ).toBe(
      [
        "# TASK",
        "",
        "Implement the spec.",
        "",
        PROJECT_CONTEXT_HEADING,
        "",
        "Run `npm run verify` from the repo root.",
      ].join("\n"),
    );
  });

  // Absence is the ordinary case, not a degraded one: a client with nothing to
  // say about their project gets the template it would have had before this
  // existed, byte for byte.
  it("leaves the template alone when there is no fragment", () => {
    expect(withProjectContext(TEMPLATE, Option.none())).toBe(TEMPLATE.trimEnd());
  });

  // It appends to whichever template won, so the two extension points compose:
  // a client who replaced the whole file still gets their own fragment under
  // it, rather than having to paste the fragment into the replacement.
  it("interpolates into a replaced template exactly as into the default", () => {
    const replaced = withProjectContext("# TASK\n\nThe client's own.\n", Option.some("PHP 8.3."));
    expect(replaced).toContain("The client's own.");
    expect(replaced).toContain(`${PROJECT_CONTEXT_HEADING}\n\nPHP 8.3.`);
  });

  // The dispatcher's message still follows the last line of what the template
  // assembly produced — the fragment is part of the template half, not a third
  // thing between the message's two lines.
  it("sits above the dispatcher's message, which stays last", () => {
    const assembled = renderImplementPrompt(
      withProjectContext(TEMPLATE, Option.some("Use the `env/` virtualenv.")),
      RUN,
    );
    expect(assembled.indexOf(PROJECT_CONTEXT_HEADING)).toBeLessThan(
      assembled.indexOf("Your task spec is the file /spec.md"),
    );
    expect(assembled.split("\n").at(-1)).toContain(RUN.mergeBaseSha);
  });
});

// The dispatcher's `--feedback` (T17): extra instructions appended to all three
// prompts, whichever arm the task is on. The text is never interpreted on the
// way: it rides the stdin prompt pipe (T9), so what these functions assemble is
// what the agent reads, byte for byte.
describe("dispatcher feedback in a prompt", () => {
  // Everything a shell would eat, in one string: the property the whole seam
  // rests on is that none of it is a shell's business, here or on the pipe.
  const HOSTILE = "fix `git log`; use $(pwd) and \"quotes\" and 'quotes' — $HOME too";

  it("appends the feedback between its markers, verbatim", () => {
    expect(withDispatcherFeedback("body", Option.some(HOSTILE))).toBe(
      ["body", "", FEEDBACK_OPEN, HOSTILE, FEEDBACK_CLOSE].join("\n"),
    );
  });

  it("leaves the prompt alone when the dispatch carried no feedback", () => {
    expect(withDispatcherFeedback("body", Option.none())).toBe("body");
  });

  it("reaches all three prompts, under the run's own dispatcher message", () => {
    const run = { ...RUN, task: { ...RUN.task, feedback: Option.some(HOSTILE) } } satisfies PassRun;
    const implement = implementPromptFor("# TASK", run, Option.none());
    const review = reviewPromptFor("# ROLE", run, { index: 1, of: 3 });
    const description = describePrPromptFor("# ROLE", run);
    for (const prompt of [implement, review, description]) {
      expect(prompt).toContain(`${FEEDBACK_OPEN}\n${HOSTILE}\n${FEEDBACK_CLOSE}`);
    }
    // Appended, so each prompt is still the one T9, T10, and T12 assemble with
    // the section under it rather than a rewrite of it.
    expect(implement).toContain(renderImplementPrompt("# TASK", RUN));
    expect(review).toContain(renderReviewPrompt("# ROLE", RUN, { index: 1, of: 3 }));
    expect(description).toContain(renderDescribePrPrompt("# ROLE", RUN));
  });

  it("assembles the ordinary prompts unchanged when there is no feedback", () => {
    expect(implementPromptFor("# TASK", RUN, Option.none())).toBe(
      renderImplementPrompt("# TASK", RUN),
    );
    expect(reviewPromptFor("# ROLE", RUN, { index: 2, of: 3 })).toBe(
      renderReviewPrompt("# ROLE", RUN, { index: 2, of: 3 }),
    );
    expect(describePrPromptFor("# ROLE", RUN)).toBe(renderDescribePrPrompt("# ROLE", RUN));
  });
});

// **Resuming is a fact of the identity, not of the arm** (T66, 22 §5). The
// sentence is true of every `FeedbackResume` and false of every one-off,
// whichever arm the task is on — so a spec resume carries it, which until this
// ticket nothing did, and a fresh dispatch of the same task does not.
describe("the resuming sentence", () => {
  const resumed = { ...RUN, identity: RESUMED } satisfies PassRun;
  const inlineResumed = {
    ...RUN,
    task: { _tag: "Inline", text: "fix the release note", feedback: Option.none() },
    identity: RESUMED,
  } satisfies PassRun;

  it("tells a resuming implement pass to read the branch before it adds to it", () => {
    for (const run of [resumed, inlineResumed]) {
      const prompt = implementPromptFor("# TASK", run, Option.none());
      expect(prompt).toContain(`This run resumes branch ${RUN.branch}`);
      expect(prompt).toContain(`git log ${RUN.mergeBaseSha}..HEAD`);
      expect(prompt).toContain(`git diff ${RUN.mergeBaseSha}..HEAD`);
    }
  });

  // The fresh dispatch of the same task says nothing about resuming: there is
  // nothing on the branch this pass did not put there.
  it("says nothing about resuming on a one-off, on either arm", () => {
    const inline = { ...inlineResumed, identity: RUN.identity } satisfies PassRun;
    for (const run of [RUN, inline]) {
      expect(implementPromptFor("# TASK", run, Option.none())).not.toContain("resumes branch");
    }
  });

  // The implement pass alone: a reviewer and a description pass already read
  // the whole range past the boundary, which is what their own messages say.
  it("reaches the implement pass and neither of the other two", () => {
    for (const run of [resumed, inlineResumed]) {
      expect(reviewPromptFor("# ROLE", run, { index: 1, of: 2 })).not.toContain("resumes branch");
      expect(describePrPromptFor("# ROLE", run)).not.toContain("resumes branch");
    }
  });

  // The section the PR context lands in is the spec arm's too, now that the
  // framing is the identity's: the body is what the human read before they
  // wrote the feedback (22 §5).
  it("carries the PR context under a spec resume's own message", () => {
    const pr = { title: "[speepobox] speepobox-t9", body: "## Overview\n\nWhat the last run did." };
    const prompt = implementPromptFor("# TASK", resumed, Option.some(pr));
    expect(prompt).toContain(PR_CONTEXT_OPEN);
    expect(prompt).toContain(`Title: ${pr.title}`);
    expect(prompt).toContain(pr.body);
    expect(prompt).toContain(PR_CONTEXT_CLOSE);
    // Still the spec run's message, with the section under it.
    expect(prompt).toContain(renderImplementPrompt("# TASK", resumed));
  });
});

// The run whose task was stated inline (T66, reached today by a resume whose
// recorded spec is gone — chart row 6): nothing is mounted at `/spec.md`, and
// the text the dispatcher typed is what the pass was dispatched to do.
describe("the prompts for a task stated inline", () => {
  const TEXT = "the retry loop swallows the last error — surface it and test it";
  const run = {
    ...RUN,
    task: { _tag: "Inline", text: TEXT, feedback: Option.none() },
    identity: RESUMED,
  } satisfies PassRun;
  const PR_CONTEXT = {
    title: "[speepobox] speepobox-t9",
    body: "## Overview\n\nWhat the last run said it did.",
  };

  // The section is what carries the text now: until T66 the review and
  // description passes saw it only because it was the run's *feedback*, and
  // after the collapse it is not.
  it("carries the task in its own section on all three messages", () => {
    const section = `${TASK_OPEN}\n${TEXT}\n${TASK_CLOSE}`;
    expect(implementPromptFor("# TASK", run, Option.none())).toContain(section);
    expect(reviewPromptFor("# ROLE", run, { index: 1, of: 2 })).toContain(section);
    expect(describePrPromptFor("# ROLE", run)).toContain(section);
  });

  it("tells the implement pass which branch and which boundary, as a spec run is told", () => {
    const prompt = implementPromptFor("# TASK", run, Option.none());
    expect(prompt).toContain(
      `You are on branch ${RUN.branch}. The task's diff boundary (its merge-base with the PR base) is commit ${RUN.mergeBaseSha}.`,
    );
  });

  // The shouted heading T17 opened this arm's implement message with is gone,
  // and nothing generated replaces it: the arm is named for what the task is,
  // and the framing for what the run is (T66). Asserted as the absence of any
  // shouting at all, because the heading was the only thing here that shouted.
  it("frames the run by what it is, with no heading shouting above the task", () => {
    for (const prompt of [
      implementPromptFor("# TASK", run, Option.some(PR_CONTEXT)),
      reviewPromptFor("# ROLE", run, { index: 1, of: 2 }),
      describePrPromptFor("# ROLE", run),
    ]) {
      expect(prompt).not.toContain("FEEDBACK");
    }
  });

  // The one prompt that does not send the pass to `/spec.md`: there is no
  // spec, so the run mounts nothing there. Under a template that names no file
  // either, the path does not appear at all — the backstop has nothing above it
  // to retract and so does not fire.
  it("never tells the pass to read a spec that is not in the container", () => {
    const prompt = implementPromptFor("# TASK", run, Option.none());
    expect(prompt).not.toContain("/spec.md");
  });

  it("quotes the PR's current title and body when the forge answered", () => {
    const prompt = implementPromptFor("# TASK", run, Option.some(PR_CONTEXT));
    expect(prompt).toContain(PR_CONTEXT_OPEN);
    expect(prompt).toContain(`Title: ${PR_CONTEXT.title}`);
    expect(prompt).toContain(PR_CONTEXT.body);
    expect(prompt).toContain(PR_CONTEXT_CLOSE);
    // Context, and last: the task is above it, so a PR body full of headings
    // cannot read as the instruction the pass was given.
    expect(prompt.indexOf(TASK_OPEN)).toBeLessThan(prompt.indexOf(PR_CONTEXT_OPEN));
  });

  // Best-effort: a view that failed is a prompt without the section, never a
  // prompt with an apology in it.
  it("degrades to the same prompt without the section when the forge could not answer", () => {
    const prompt = implementPromptFor("# TASK", run, Option.none());
    expect(prompt).not.toContain(PR_CONTEXT_OPEN);
    expect(implementPromptFor("# TASK", run, Option.some(PR_CONTEXT))).toContain(prompt);
  });

  // The dispatcher's feedback is still its own section, and still the
  // dispatcher's: on this arm the text above it is the task, and what a
  // `--feedback` on top of it says is extra instructions, exactly as on a spec
  // run (`feedbackIn` answers `feedback`, never `text`).
  it("keeps a feedback of its own in the feedback section, under the task", () => {
    const steered = {
      ...run,
      task: { _tag: "Inline", text: TEXT, feedback: Option.some("use the existing helper") },
    } satisfies PassRun;
    for (const prompt of [
      implementPromptFor("# TASK", steered, Option.none()),
      reviewPromptFor("# ROLE", steered, { index: 1, of: 2 }),
      describePrPromptFor("# ROLE", steered),
    ]) {
      expect(prompt).toContain(`${FEEDBACK_OPEN}\nuse the existing helper\n${FEEDBACK_CLOSE}`);
      expect(prompt.indexOf(TASK_OPEN)).toBeLessThan(prompt.indexOf(FEEDBACK_OPEN));
    }
  });

  // The review's criteria are swapped, and the task travels with them: the
  // round is asked whether the task was addressed, not whether a spec was.
  it("swaps the review criteria for the round, and carries the task under them", () => {
    const prompt = reviewPromptFor("# ROLE", run, { index: 1, of: 2 });
    expect(prompt).toContain(inlineTaskReviewCriteria("# ROLE"));
    expect(prompt).toContain("not spec fidelity");
    // Still a review round with its budget: the swap is a criterion, not a
    // different pass.
    expect(prompt).toContain("This is review round 1 of 2.");
    expect(reviewPromptFor("# ROLE", RUN, { index: 1, of: 2 })).not.toContain(
      inlineTaskReviewCriteria("# ROLE"),
    );
  });

  // The same line the implement pass's message drops, and for the same reason:
  // nothing is mounted at `/spec.md`, so a round told to read it first goes
  // after a file that is not in the container.
  it("never sends the review round to a spec that is not in the container", () => {
    const prompt = reviewPromptFor("# ROLE", run, { index: 1, of: 2 });
    expect(prompt).not.toContain("/spec.md");
    // What the round still gets: which branch, which boundary, and where it
    // stands. The swap is a criterion, not a smaller prompt.
    expect(prompt).toContain(`You are on branch ${RUN.branch}`);
    expect(prompt).toContain(RUN.mergeBaseSha);
    expect(prompt).toContain("This is review round 1 of 2.");
  });

  it("gives the description pass what the run was dispatched to do", () => {
    const prompt = describePrPromptFor("# ROLE", run);
    expect(prompt).toContain(`${TASK_OPEN}\n${TEXT}\n${TASK_CLOSE}`);
    expect(prompt).toContain(`Describe the work on branch ${RUN.branch}`);
  });

  // The third pass, asked what the other two are asked. Neither its generated
  // message nor the default template names `/spec.md` since T37 — which is
  // exactly why this was the arm where the correction went missing: nothing at
  // the call site looked wrong without it. The backstop still rides here, for
  // whichever client template won, and stays silent when none did.
  it("never sends the description pass to a spec that is not in the container", () => {
    expect(describePrPromptFor("# ROLE", run)).not.toContain("/spec.md");
  });
});

// **Whether a spec is mounted is a dispatcher fact, not template prose** (T37).
// All three shipped templates used to open by asserting the mount, and on a run
// whose task is stated inline all three were false — so the generated message had to
// retract each one, at three sites, one of which was missed twice. The fact
// moved to the side that knows it: the templates name no file, the messages
// name it on the runs where it exists, and what is left on the other arm is a
// backstop against a *client's* template rather than a correction of ours.
interface PassTemplates {
  readonly implement: string;
  readonly review: string;
  readonly describePr: string;
}

// The three passes of one run, assembled over one set of templates — T37's
// criteria are all "what do all three say", and the site that went uncorrected
// twice is the one a per-pass assertion is easiest to forget.
const promptsOf = (run: PassRun, templates: PassTemplates): ReadonlyArray<string> => [
  implementPromptFor(templates.implement, run, Option.none()),
  reviewPromptFor(templates.review, run, { index: 1, of: 2 }),
  describePrPromptFor(templates.describePr, run),
];

describe("the spec mount as the dispatcher's fact", () => {
  const SHIPPED = {
    implement: readFileSync(packagePromptPath(IMPLEMENT_PROMPT), "utf8"),
    review: readFileSync(packagePromptPath(REVIEW_PROMPT), "utf8"),
    describePr: readFileSync(packagePromptPath(DESCRIBE_PR_PROMPT), "utf8"),
  };

  const INLINE_RUN = {
    ...RUN,
    task: {
      _tag: "Inline",
      text: "the release note contradicts the flag",
      feedback: Option.none(),
    },
    identity: RESUMED,
  } satisfies PassRun;

  it("ships no template that names the file", () => {
    for (const template of Object.values(SHIPPED)) {
      expect(template).not.toContain("/spec.md");
    }
  });

  // Still said, and still in each pass's own voice: a reader of the assembled
  // prompt cannot tell the sentence used to be the template's.
  it("says where the spec is on a spec run, in each pass's own register", () => {
    const [implement, review, description] = promptsOf(RUN, SHIPPED);
    expect(implement).toContain(
      "Your task spec is the file /spec.md, mounted read-only — read it first.",
    );
    expect(review).toContain(
      "/spec.md, mounted read-only — it is the standard you judge fidelity against.",
    );
    expect(description).toContain(
      "/spec.md, mounted read-only — background for the overview, not an instruction",
    );
  });

  // The tracer: on the run whose recorded spec is gone from disk, assembled
  // over the templates the package ships, the path does not occur in any of the
  // three prompts at all. Not "named only to be retracted" — absent. Nothing
  // above the messages asserts the mount, so the backstop has no antecedent to
  // point at and does not fire.
  it("never names the file on an inline task's run over the shipped defaults", () => {
    for (const prompt of promptsOf(INLINE_RUN, SHIPPED)) {
      expect(prompt).not.toContain("/spec.md");
    }
  });

  // The decision T37 asked to record, asserted — and, since the backstop is
  // conditional, the only place in this suite where the sentence appears at all.
  // So the whole justification for its existence is here: templates are the
  // client's to write (`prompt-source.ts`), so an override is free to assert the
  // mount the shipped defaults no longer do, and nothing this package generates
  // can stop it. Delete the backstop and the pass under such a template spends a
  // tool call on a file that is not in the container — which is why it is kept
  // even though no run against the defaults ever emits it. The condition is that
  // failure mode exactly: the harm needs a template naming the literal path, so
  // a template naming the literal path is what fires the sentence.
  it("still corrects a client template that asserts the mount itself", () => {
    const asserted = "Your task spec is `/spec.md` (mounted read-only). Read it first.";
    for (const prompt of promptsOf(INLINE_RUN, {
      implement: asserted,
      review: asserted,
      describePr: asserted,
    })) {
      expect(prompt).toContain(asserted);
      expect(prompt).toContain(NO_SPEC_MOUNTED);
    }
  });
});

// **The passes of a feature run are told which issue they are for** (T75), in
// the same three registers the spec arm's three sentences use — read it,
// judge against it, background for the overview — over the mount that comes
// from inside the checkout (`sandbox/spec.ts`). bash pointed a `/spec.md`
// symlink at each issue in turn and left its templates asserting the mount;
// here the fact is the dispatcher's, as T37 left it.
describe("the prompts of a feature run", () => {
  const ISSUES = [fakeIssue("T70"), fakeIssue("T71")];
  const FIRST = ISSUES[0] ?? fakeIssue("T70");
  const FOLDER = "docs/wayfinder/effect-agentbox";
  // The commit the branch stood at when this issue's implement pass began
  // (T76 reads it in the container). On the first issue of a fresh run it *is*
  // the merge-base; from the second onward it is a later commit.
  const LATER_BOUNDARY = "3333333333333333333333333333333333333333";

  const feature = (boundary: string, issue = FIRST) =>
    ({
      ...RUN,
      ...featureDispatch(FOLDER, { request: { _tag: "All" }, issues: ISSUES }),
      current: Option.some({ issue, boundary }),
    }) satisfies PassRun;

  const FROM_THE_MERGE_BASE = feature(RUN.mergeBaseSha);
  const AFTER_AN_EARLIER_ISSUE = feature(LATER_BOUNDARY);

  const ISSUE_FILE = `${FEATURE_ISSUES_TARGET}/${fileNameOf(FIRST)}`;

  it("sends the implement pass to this issue's file, under the branch and boundary", () => {
    expect(implementPromptFor("# TASK", FROM_THE_MERGE_BASE, Option.none())).toBe(
      [
        "# TASK",
        `You are on branch ${RUN.branch}. The task's diff boundary (its merge-base with the PR base) is commit ${RUN.mergeBaseSha}.`,
        `Your task is the issue file ${ISSUE_FILE}, mounted read-only — read it first.`,
      ].join("\n"),
    );
    // The stem is what names the file, so the sentence points at the file the
    // folder really holds rather than at an id nothing is called.
    expect(ISSUE_FILE).toBe("/feature-issues/T70-a-thing-to-do.md");
  });

  // bash's build-on sentence (`run.sh:1772-1775`), and **keyed off the
  // boundary rather than the identity**: it is true from the second issue of a
  // fresh run onward, which no identity says anything about.
  it("says to build on what is already there once the boundary has moved", () => {
    const later = implementPromptFor("# TASK", AFTER_AN_EARLIER_ISSUE, Option.none());
    expect(later).toContain(
      `The branch already carries commits from earlier issues or runs of this feature — read them (git log ${RUN.mergeBaseSha}..HEAD) and build on them; do not redo or undo them.`,
    );
    // The first issue of a fresh run stands at the boundary, so there is
    // nothing on the branch to build on and nothing is said about any.
    expect(implementPromptFor("# TASK", FROM_THE_MERGE_BASE, Option.none())).not.toContain(
      "build on them",
    );
    // Said once the pass knows what it is for, so the two sentences read in
    // the order a pass acts on them: this issue, then what is under it.
    expect(later.indexOf(ISSUE_FILE)).toBeLessThan(later.indexOf("build on them"));
  });

  // The two are different facts about one branch and a run can carry both: the
  // resuming sentence is the identity's (T66) and the build-on sentence is the
  // boundary's.
  it("carries the resuming sentence beside them on a resumed feature run", () => {
    const resumed = { ...AFTER_AN_EARLIER_ISSUE, identity: RESUMED } satisfies PassRun;
    const prompt = implementPromptFor("# TASK", resumed, Option.none());
    expect(prompt).toContain(`This run resumes branch ${RUN.branch}`);
    expect(prompt).toContain(`Your task is the issue file ${ISSUE_FILE}`);
    expect(prompt).toContain("build on them");
    // And the fresh dispatch of the same issue says nothing about resuming,
    // whatever its boundary is.
    expect(implementPromptFor("# TASK", AFTER_AN_EARLIER_ISSUE, Option.none())).not.toContain(
      "resumes branch",
    );
  });

  // The round is scoped to **this issue's** commits (`run.sh:1806`): the branch
  // carries the issues before it too, and a round asked about the whole range
  // would report on work an earlier round already approved.
  it("scopes the review round to this issue, its title, and its own boundary", () => {
    expect(reviewPromptFor("# ROLE", AFTER_AN_EARLIER_ISSUE, { index: 1, of: 3 })).toBe(
      [
        "# ROLE",
        `Review the work on branch ${RUN.branch} for issue ${FIRST.title} — every commit after ${LATER_BOUNDARY}.`,
        "This is review round 1 of 3.",
        `The issue the work was implemented from is the file ${ISSUE_FILE}, mounted read-only — it is the standard you judge fidelity against.`,
      ].join("\n"),
    );
    // Not the implement pass's register: a reviewer told to read the issue
    // first is being told to implement it.
    expect(reviewPromptFor("# ROLE", AFTER_AN_EARLIER_ISSUE, { index: 1, of: 3 })).not.toContain(
      "read it first",
    );
    // And the budget is still the round's own, on the last round too.
    expect(reviewPromptFor("# ROLE", FROM_THE_MERGE_BASE, { index: 3, of: 3 })).toContain(
      "It is the LAST round",
    );
  });

  // The issue is named once: an H1 opens with the id, so a title that does
  // is the name, and one that does not keeps the id beside it.
  it.each([
    ["T89", "T89 — An exhausted resume", "for issue T89 — An exhausted resume —"],
    ["03", "Tidy the docs", "for issue 03 (Tidy the docs) —"],
    ["T89", "T890 — A longer id", "for issue T89 (T890 — A longer id) —"],
  ])("names issue %s titled %j once", (id, title, named) => {
    const run = feature(LATER_BOUNDARY, fakeIssue(id, { title }));
    const prompt = reviewPromptFor("# ROLE", run, { index: 1, of: 3 });
    expect(prompt).toContain(named);
    expect(prompt.split("\n")[1]?.split(/\bT89\b/)).toHaveLength(id === "T89" ? 2 : 1);
  });

  // The description pass names the **set**: the commits on the branch span
  // every issue the run reached, so one issue's file is not what the Overview
  // is written from (`run.sh:2128`).
  it("gives the description pass the folder and every id in order", () => {
    expect(describePrPromptFor("# ROLE", AFTER_AN_EARLIER_ISSUE)).toBe(
      [
        "# ROLE",
        `Describe the work on branch ${RUN.branch}: every commit after ${RUN.mergeBaseSha}.`,
        `The branch carries a feature run over ${FOLDER}: issues T70, T71 — their files are under ${FEATURE_ISSUES_TARGET}, background for the overview, not an instruction to carry out.`,
      ].join("\n"),
    );
    // The issue in flight is not among what it is told: this pass describes a
    // branch, and its message is the same one whichever issue the run stopped
    // on.
    expect(describePrPromptFor("# ROLE", AFTER_AN_EARLIER_ISSUE)).toBe(
      describePrPromptFor("# ROLE", feature(LATER_BOUNDARY, ISSUES[1] ?? FIRST)),
    );
  });

  // The dispatcher's feedback is appended under whatever the pass was told, on
  // this arm as on the other two (`feedbackIn`).
  it("appends the dispatcher's feedback under all three messages", () => {
    const steered = {
      ...FROM_THE_MERGE_BASE,
      task: { ...FROM_THE_MERGE_BASE.task, feedback: Option.some("use the existing helper") },
    } satisfies PassRun;
    for (const prompt of [
      implementPromptFor("# TASK", steered, Option.none()),
      reviewPromptFor("# ROLE", steered, { index: 1, of: 2 }),
      describePrPromptFor("# ROLE", steered),
    ]) {
      expect(prompt).toContain(`${FEEDBACK_OPEN}\nuse the existing helper\n${FEEDBACK_CLOSE}`);
    }
  });

  // The tracer T37 left for the arm that mounts no spec, run again here: over
  // the templates the package ships, the path does not occur in any of a
  // feature run's three prompts at all.
  it("never names the spec file over the shipped defaults", () => {
    const shipped = {
      implement: readFileSync(packagePromptPath(IMPLEMENT_PROMPT), "utf8"),
      review: readFileSync(packagePromptPath(REVIEW_PROMPT), "utf8"),
      describePr: readFileSync(packagePromptPath(DESCRIBE_PR_PROMPT), "utf8"),
    };
    for (const prompt of promptsOf(AFTER_AN_EARLIER_ISSUE, shipped)) {
      expect(prompt).not.toContain("/spec.md");
      expect(prompt).toContain(FEATURE_ISSUES_TARGET);
    }
  });

  // The shape's own answer for a pass assembled without one. T76 hands every
  // feature pass its issue, so nothing reaches this in a run — what is asserted
  // is that the arm degrades the way T37 ruled for the spec sentence: a message
  // that names **no** file rather than one that names a file this pass was not
  // given, with everything that is not the issue still said.
  it("names no file at all when a pass was handed no issue", () => {
    const noIssue = { ...FROM_THE_MERGE_BASE, current: Option.none() } satisfies PassRun;
    const implement = implementPromptFor("# TASK", noIssue, Option.none());
    const review = reviewPromptFor("# ROLE", noIssue, { index: 1, of: 2 });
    for (const prompt of [implement, review, describePrPromptFor("# ROLE", noIssue)]) {
      expect(prompt).not.toContain("/spec.md");
      expect(prompt).not.toContain(fileNameOf(FIRST));
    }
    // Both are still told where they are and what range they are reading.
    for (const prompt of [implement, review]) {
      expect(prompt).toContain(`You are on branch ${RUN.branch}`);
      expect(prompt).toContain(RUN.mergeBaseSha);
    }
    expect(review).toContain("This is review round 1 of 2.");
  });

  // And the backstop, for the client template that asserts a mount this run
  // does not have: it fires on all three messages here for the reason it fires
  // on an inline task's three (`prompt-source.ts` — templates are the client's
  // to write).
  it("still corrects a client template that asserts the spec mount", () => {
    const asserted = "Your task spec is `/spec.md` (mounted read-only). Read it first.";
    for (const prompt of promptsOf(FROM_THE_MERGE_BASE, {
      implement: asserted,
      review: asserted,
      describePr: asserted,
    })) {
      expect(prompt).toContain(asserted);
      expect(prompt).toContain(NO_SPEC_MOUNTED);
    }
  });
});
