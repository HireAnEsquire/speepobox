// The prompts an agent pass is given (SPEC §8): a **package default file**
// plus a **pure interpolation function**. Both halves are deliberate.
//
// The file lives at `<root>/prompts/<name>.md` — under the clone-run model a
// prompt is just a file in the cloned tree, so there is no bundling problem
// (01). Which roots exist and which one wins is `PromptSource`'s (T14);
// `promptPathIn` is the one derivation both of its arms use, so the client
// root and the package root cannot resolve a name two different ways.
//
// Interpolation stays a pure function (SPEC §8), here and after T14: no tag,
// no `FileSystem`, no clock. What the caller reads off disk is the template;
// what this returns is the assembled prompt, which is also the text logged
// verbatim before the pass.
import { join } from "node:path";
import { Option } from "effect";
import { packageRoot } from "../config/paths.ts";
import { feedbackIn, isResume, type Task } from "../dispatch/plan.ts";
import { fileNameOf, type Issue, titleNamesIssue } from "../issues/issue.ts";
import type { RunIdentity } from "../ledger/record.ts";
import { FEATURE_ISSUES_TARGET, SPEC_TARGET } from "../sandbox/spec.ts";
import type { ReviewRound } from "./verdict.ts";

// Where a root's prompts live. A directory rather than a constant per file:
// `PromptSource` resolves `<root>/prompts/<name>.md` against two roots, and a
// name is what it resolves.
export const PROMPTS_DIRNAME = "prompts";

export const IMPLEMENT_PROMPT = "implement";
export const REVIEW_PROMPT = "review";
export const DESCRIBE_PR_PROMPT = "describe-pr";

// A name under a root, and the whole of the layout both arms of the precedence
// chain share (T14). The client arm is this expression against the served
// repo's bessemer directory (T59); the package arm is the same expression
// against the package root.
export const promptPathIn = (root: string, name: string): string =>
  join(root, PROMPTS_DIRNAME, `${name}.md`);

export const packagePromptPath = (name: string): string => promptPathIn(packageRoot, name);

// The client's fragment: one file, resolved through the same chain as the
// three above (`prompt-source.ts`) and named separately from them because it
// is not a pass's prompt — it is what a client says about *their project*
// once, for every pass.
export const PROJECT_CONTEXT_PROMPT = "project-context";

// What the fragment arrives under in the assembled prompt. A heading in the
// defaults' own register (`# TASK`, `# ROLE`, `# VERIFY`), because the agent
// reads one document and a fragment dropped in without one reads as the
// template's last paragraph continuing.
export const PROJECT_CONTEXT_HEADING = "# PROJECT CONTEXT";

/**
 * The fragment, interpolated into whichever template won — **appended as its
 * own section, never patched into the template's middle**. That is the whole
 * difference between this and the mini-templating-language 05 Q9 rejected: no
 * placeholder syntax, no named slots, nothing in a prompt file to keep in step
 * with a schema. It composes with the other extension point rather than
 * competing with it — a client who replaced `implement.md` outright still gets
 * their `project-context.md`, because this appends to the template that won
 * rather than to the package's.
 *
 * Absent is `Option.none` and produces the template unchanged: a client with
 * nothing to say about their project is the ordinary case, not a degraded one.
 * `trimEnd`/`trim` for the reason the dispatcher's message trims — the section
 * sits one blank line below the template however either file happens to end.
 */
export const withProjectContext = (template: string, fragment: Option.Option<string>): string =>
  Option.match(fragment, {
    onNone: () => template.trimEnd(),
    onSome: (context) =>
      [template.trimEnd(), "", PROJECT_CONTEXT_HEADING, "", context.trim()].join("\n"),
  });

// --- where the spec is, on the runs where there is one (T37) ----------------

// **Whether a spec is mounted is a dispatcher fact, not template prose.** All
// three package defaults used to open by asserting the mount, and on a run
// whose task is stated inline all three were false: there is no spec, so
// `specMount` mounts nothing (`sandbox/spec.ts`) and the generated message
// underneath had to retract the template's own sentence. A *run* condition
// that changes between two dispatches on the same branch belongs to the side
// that knows it — the same principle `image-build-command` settled
// from the other direction (T34): the package ships no fact it cannot know.
//
// So the templates say nothing about the file and the three messages below name
// it, each in its own pass's register: the implement pass is told to read it,
// the review round that it is the standard fidelity is judged against, the
// description pass that it is background for the overview. `SPEC_TARGET` rather
// than a literal per sentence, so the path a pass is sent to and the path the
// mount uses cannot drift.
const SPEC_TO_READ = `Your task spec is the file ${SPEC_TARGET}, mounted read-only — read it first.`;
const SPEC_AS_FIDELITY_STANDARD = `The spec the work was implemented from is the file ${SPEC_TARGET}, mounted read-only — it is the standard you judge fidelity against.`;
const SPEC_AS_BACKGROUND = `The spec the work was implemented from is the file ${SPEC_TARGET}, mounted read-only — background for the overview, not an instruction to carry out.`;

// --- which issue a feature pass is for (T75) --------------------------------

// The issue this pass is for, and the commit the branch stood at when its
// implement pass began (`run.sh:1766`). The pair travels together because the
// two messages that read it read both: the file a pass is sent to is the
// issue's, and the range a round judges starts at the boundary — which is the
// merge-base on the first issue of a fresh run and a later commit on every one
// after it.
export interface CurrentIssue {
  readonly issue: Issue;
  readonly boundary: string;
}

// Where an issue's file is inside the container: the mount T75 binds from
// inside the checkout, plus the file name derived from the issue's own stem
// (`issues/issue.ts`). `FEATURE_ISSUES_TARGET` rather than a literal per
// sentence, for the reason `SPEC_TARGET` is: the path a pass is sent to and the
// path the mount uses cannot drift.
const issueFile = (issue: Issue): string => `${FEATURE_ISSUES_TARGET}/${fileNameOf(issue)}`;

// The three sentences the spec's three have, in each pass's own register — the
// implement pass is told to read the file, the review round that it is the
// standard fidelity is judged against, and the description pass is told about
// the whole set rather than about any one issue (below).
const issueToRead = (issue: Issue): string =>
  `Your task is the issue file ${issueFile(issue)}, mounted read-only — read it first.`;

const issueAsFidelityStandard = (issue: Issue): string =>
  `The issue the work was implemented from is the file ${issueFile(issue)}, mounted read-only — it is the standard you judge fidelity against.`;

// The dispatcher's message, appended to the default prompt as bash assembles it
// (`run.sh:1414-1416`): which file the spec is, which branch the work belongs
// to, and the diff boundary the branch is read against. The spec itself is
// never interpolated — it is mounted at `SPEC_TARGET` and the agent reads it
// there, which is why a spec full of backticks is not this function's problem.
//
// `trimEnd` because bash's `$(cat …)` drops the file's trailing newlines and
// the lines below are joined with exactly one: a template that gained a blank
// line at the end must not move the message away from it.
export const renderImplementPrompt = (
  template: string,
  run: {
    readonly branch: string;
    readonly mergeBaseSha: string;
    readonly identity: RunIdentity;
  },
): string =>
  [template.trimEnd(), SPEC_TO_READ, ...resumingLines(run), branchAndBoundary(run)].join("\n");

// The one sentence a resuming run's implement message carries — on **both**
// arms, because it is true of every `FeedbackResume` and false of every one-off
// whichever arm the task is on (T66, 22 §5). Until this ticket only the text
// arm's prompt said it, and it said so because T17 built that arm for a resume;
// a spec resume needed the sentence just as much and never got it.
//
// What it is for: the branch already holds work, and this pass adds to it. A
// pass that starts from the spec alone re-does the round before it, so the
// reading is named as the first thing it does and spelled as the two commands
// that do it.
const resumingNote = (run: { readonly branch: string; readonly mergeBaseSha: string }): string =>
  `This run resumes branch ${run.branch}: the branch already holds work, so read it against the diff boundary first — git log ${run.mergeBaseSha}..HEAD / git diff ${run.mergeBaseSha}..HEAD — before you add to it.`;

// The sentence, on the runs that are resumes and on no others. A boolean read
// off the identity, never off the arm (`dispatch/plan.ts`) — and read here
// rather than at the seam, so the three prompt functions stay pure over what
// they are handed.
const resumingLines = (run: {
  readonly branch: string;
  readonly mergeBaseSha: string;
  readonly identity: RunIdentity;
}): ReadonlyArray<string> => (isResume(run.identity) ? [resumingNote(run)] : []);

// The two facts every pass but the description one is told, spelled once: an
// inline task's review round needs them exactly as a spec run's does, and it is
// that arm's *spec* sentence that has to go, not this line.
const branchAndBoundary = (run: {
  readonly branch: string;
  readonly mergeBaseSha: string;
}): string =>
  `You are on branch ${run.branch}. The task's diff boundary (its merge-base with the PR base) is commit ${run.mergeBaseSha}.`;

// The review prompt is the same file-plus-message assembly, over the review
// default. A reviewer is told the same three facts an implementer is — which
// spec, which branch, which boundary — and the branch and the boundary are
// `branchAndBoundary`'s single spelling, so the two messages cannot drift on
// them. The spec sentence is the round's own (T37): a reviewer is not here to
// read the spec and implement it, it is here to judge a diff against it.
//
// The extra line is bash's `round_note` (`run.sh:563-570`), and it is not
// decoration: rounds share no memory, so a reviewer that is not told the
// budget cannot spend it — on the last round it would commit a fix nothing
// will ever re-review. Tell it where it stands, and on the final round push it
// toward reporting.
export const renderReviewPrompt = (
  template: string,
  run: { readonly branch: string; readonly mergeBaseSha: string },
  round: ReviewRound,
): string =>
  [template.trimEnd(), SPEC_AS_FIDELITY_STANDARD, branchAndBoundary(run), roundNote(round)].join(
    "\n",
  );

// Bash's `round_note` itself, spelled once for the same reason the two facts
// above are: both review arms spend the same budget, and a round told nothing
// about where it stands is the failure this line exists to stop.
const roundNote = (round: ReviewRound): string =>
  `This is review round ${round.index} of ${round.of}.${
    round.index >= round.of
      ? " It is the LAST round — nothing you commit now will be re-reviewed. Prefer naming a problem precisely under `needs-work` to fixing it, unless the fix is small and you verify it in this round."
      : ""
  }`;

// The description pass's message (T12), and the one place the three passes
// stop sharing a shape: this one is not told to implement or to review, so it
// gets neither `branchAndBoundary` nor the imperative spec line. What it needs
// is bash's single sentence (`run.sh:1684`) — which branch, and which commits
// are this work's — because the diff after the boundary *is* the subject, and
// the spec named as what it is here: background for the overview.
export const renderDescribePrPrompt = (
  template: string,
  run: { readonly branch: string; readonly mergeBaseSha: string },
): string => [template.trimEnd(), SPEC_AS_BACKGROUND, describeTheWork(run)].join("\n");

// The one sentence both description arms share, spelled once for the reason the
// two facts above are: an inline task's run describes its branch exactly as a
// spec run does, and it is the *spec* line that arm drops, not this one.
const describeTheWork = (run: { readonly branch: string; readonly mergeBaseSha: string }): string =>
  `Describe the work on branch ${run.branch}: every commit after ${run.mergeBaseSha}.`;

// --- the dispatcher's feedback (T17) ----------------------------------------

// The markers a feedback section arrives between — the `Dispatcher feedback`
// block bash appends to each pass prompt. They are markers rather than a
// heading because the text between them is the dispatcher's, verbatim: it
// rides the stdin prompt pipe, so quotes, backticks, and `$(…)` reach the
// agent literally, and a fenced section is what keeps arbitrary markdown from
// reading as the template's own prose.
export const FEEDBACK_OPEN = "--- Dispatcher feedback ---";
export const FEEDBACK_CLOSE = "--- end dispatcher feedback ---";
// The markers the task itself arrives between when it was stated inline —
// T17's feedback-as-the-order heading, renamed for what the text is (T66): not
// extra instructions beside a spec, but the whole of what the pass was
// dispatched to do. Markers for the reason the feedback's are, and its own
// close marker beside them, so a task ending in a heading cannot read as
// swallowing the sections under it.
export const TASK_OPEN = "--- The task (stated inline) ---";
export const TASK_CLOSE = "--- end task ---";

// The task, in its own section on all three messages (T66). On this arm the
// text *is* what the run is for, and it no longer arrives as the dispatcher's
// feedback — so this section is what carries it to the review round and the
// description pass, which used to see it only because `feedbackIn` handed it
// over.
const taskSection = (text: string): ReadonlyArray<string> => ["", TASK_OPEN, text, TASK_CLOSE];

// Extra dispatcher instructions, appended to whichever prompt was assembled
// (SPEC §7). Absent is the ordinary case and produces the prompt unchanged —
// the same shape `withProjectContext` has, and for the same reason: what is
// appended is additive, and nothing in a template has to be kept in step with
// it.
export const withDispatcherFeedback = (prompt: string, feedback: Option.Option<string>): string =>
  Option.match(feedback, {
    onNone: () => prompt,
    onSome: (text) => [prompt, "", FEEDBACK_OPEN, text, FEEDBACK_CLOSE].join("\n"),
  });

// What the PR the run is iterating on says today: its title and its body, and
// deliberately **not its review comments** (run.sh's `gh pr view` fetch, which
// asks for `--json title,body` and says why in its own comment). Reviewer-
// authored text driving an unattended agent is a prompt-injection channel; the
// human reads the comments and folds what matters into `--feedback` themselves.
export interface PrContext {
  readonly title: string;
  readonly body: string;
}

export const PR_CONTEXT_OPEN = "--- Current PR title/body (context only) ---";
export const PR_CONTEXT_CLOSE = "--- end PR context ---";

// Appended last, under the task and under the feedback: it is context for what
// the pass was told, so a PR body full of headings cannot read as the
// instruction the pass was given.
const withPrContext = (prompt: string, pr: Option.Option<PrContext>): string =>
  [prompt, ...prContextLines(pr)].join("\n");

const prContextLines = (pr: Option.Option<PrContext>): ReadonlyArray<string> =>
  Option.match(pr, {
    onNone: () => [],
    onSome: (context) => [
      "",
      PR_CONTEXT_OPEN,
      `Title: ${context.title}`,
      "",
      context.body,
      PR_CONTEXT_CLOSE,
    ],
  });

// That the file is not there, said in one sentence and reused by the three arms
// that need it — each of them emitting it only under a template that asserts the
// mount (`specMountBackstop`).
//
// **The decision T37 asked for: it stays, as a backstop, and only as one.** No
// shipped template names the file any more and no message on this arm does
// either, so against the package defaults this sentence never fires and an
// inline task's prompts contain no mention of the path at all. Firing it there
// unconditionally was the ticket's own tracer failing on its own default path:
// it would be the only sentence in the whole prompt naming the file, and
// "disregard any instruction above to read one" would name an antecedent that
// does not exist. It is kept because the templates are the *client's* to write
// (`prompt-source.ts`): an overridden `implement.md` is free to open with "your
// task spec is /spec.md, read it first" and nothing generated can stop it. That
// override is the whole of what this sentence answers, and it is the only thing
// standing between one and a pass sent after a file that is not in the
// container. Worded for where it lands — under a message that said nothing about
// a spec, so it reads as this run's fact plus what to do with the text above it,
// rather than as a correction of a sentence this package wrote.
export const NO_SPEC_MOUNTED = `No spec is mounted on this run, so there is nothing at ${SPEC_TARGET} to read — disregard any instruction above to read one.`;

// The backstop, emitted only where there is something above it to retract.
// Whether the prompt names the file is a fact the assembler can *check* rather
// than assume — all three inline arms already hold the template that won — so
// it checks. The substring test is the failure mode itself: the harm being
// prevented is a pass spending a tool call on the literal path, and only a
// template naming the literal path can cause that.
const specMountBackstop = (template: string): ReadonlyArray<string> =>
  template.includes(SPEC_TARGET) ? [NO_SPEC_MOUNTED] : [];

// The implement message on the arm whose task is text (T66, the successor of
// the prompt T17 wrote for that arm): nothing is mounted at `SPEC_TARGET`, so
// `SPEC_TO_READ` would send the pass after a file that is not in the container
// and the task rides in its own section instead. Everything else this pass is
// told is what the spec arm is told — the resuming sentence when the identity
// says so, the branch, the boundary — because none of that was ever a fact
// about which arm the task is on. The backstop rides where the spec sentence
// would have been.
const renderInlineImplementPrompt = (template: string, run: PassRun, text: string): string =>
  [
    template.trimEnd(),
    ...resumingLines(run),
    ...specMountBackstop(template),
    branchAndBoundary(run),
    ...taskSection(text),
  ].join("\n");

// The review round's swapped criteria (run.sh's `FEEDBACK_ONLY` arm of the
// review-round prompt, re-worded by T66 for the arm that replaced it): a run
// whose task is text has no spec to be faithful to, so the question the round
// answers is whether the task was addressed and nothing broke. It is appended
// to the round's own prompt rather than replacing it — the default template's
// other axes (correctness, consistency, tests) are exactly as relevant.
//
// It carries the backstop for the reason the implement message does, and on the
// same condition: neither what this package generates nor what it ships sends
// the round after the file, but whichever template won is a client's and free
// to — so the round is told the file is absent only when something above it said
// otherwise. A function of the template, as the other two arms already are.
export const inlineTaskReviewCriteria = (template: string): string =>
  [
    "This run's task was stated inline rather than in a spec file: judge the diff against the task below, not spec fidelity — the criteria are that the task was addressed and nothing is broken (tests pass, lint clean, no regressions).",
    ...specMountBackstop(template),
  ].join(" ");

// --- the three messages of a feature pass (T75) -----------------------------

// The implement message on the arm that runs one issue at a time. It is the
// inline arm's shape with the issue in place of the task section: nothing is
// mounted at `SPEC_TARGET` on this arm either, so the backstop rides where the
// spec sentence would have been, and what the pass is sent to is the file under
// the mount `issuesMount` binds (`sandbox/spec.ts`).
//
// bash re-pointed a `/spec.md` symlink at each issue with a root `docker exec`
// (`run.sh:1764`) so that its three templates' "the spec is /spec.md" stayed
// true; T37 retired that assertion, so the message names the issue and nothing
// runs as root in the container.
const renderFeatureImplementPrompt = (template: string, run: PassRun): string =>
  [
    template.trimEnd(),
    ...resumingLines(run),
    ...specMountBackstop(template),
    branchAndBoundary(run),
    ...issueLines(run),
  ].join("\n");

// What the pass is for, and — on every issue but the first of a fresh run —
// what is already on the branch under it.
//
// **The build-on sentence is keyed off the boundary, never off the identity**:
// it is true from the second issue of a fresh run onward, where the resuming
// sentence above is a fact of the identity and stays one (T66, AGENTS.md). The
// two say different things to the same pass — one is *this branch holds work
// from a run before this one*, the other is *this branch holds work from the
// issues before this one* — and a run can carry both.
const issueLines = (run: PassRun): ReadonlyArray<string> =>
  Option.match(run.current, {
    onNone: () => [],
    onSome: (current) => [
      issueToRead(current.issue),
      ...(current.boundary === run.mergeBaseSha ? [] : [buildOnWhatIsThere(run)]),
    ],
  });

// bash's sentence (`run.sh:1772-1775`), spelled against the merge-base because
// that is the whole range of what earlier issues and earlier runs left: the
// issue's own boundary is where *this* issue's commits begin, and what the pass
// is being sent to read is everything before them.
const buildOnWhatIsThere = (run: PassRun): string =>
  `The branch already carries commits from earlier issues or runs of this feature — read them (git log ${run.mergeBaseSha}..HEAD) and build on them; do not redo or undo them.`;

// The review round's message on that arm (`run.sh:1806`). The round is scoped
// to **this issue's** commits rather than to the run's: the branch carries the
// issues before it too, and a round asked about the whole range would report on
// work another round already approved. So the boundary here is the
// `CurrentIssue`'s and not the merge-base, which is why this arm spells its own
// sentence instead of taking `branchAndBoundary`.
const renderFeatureReviewPrompt = (template: string, run: PassRun, round: ReviewRound): string =>
  [
    template.trimEnd(),
    ...Option.match(run.current, {
      onNone: () => [branchAndBoundary(run)],
      onSome: (current) => [reviewOfIssue(run, current)],
    }),
    roundNote(round),
    ...Option.toArray(Option.map(run.current, (current) => issueAsFidelityStandard(current.issue))),
    ...specMountBackstop(template),
  ].join("\n");

// The issue named once: its title alone where the title already opens with
// the id (`issues/issue.ts`), and the id with the title beside it where not.
const issueNamed = (issue: Issue): string =>
  titleNamesIssue(issue) ? issue.title : `${issue.id} (${issue.title})`;

const reviewOfIssue = (run: PassRun, current: CurrentIssue): string =>
  `Review the work on branch ${run.branch} for issue ${issueNamed(current.issue)} — every commit after ${current.boundary}.`;

// The description pass's message, and the one of the three that names no
// current issue: what it describes is the branch, whose commits span every
// issue the run reached (`run.sh:2128`). So it names the **set** — the folder
// and the ids in T69's order — and points at the mount rather than at a file,
// as background for the overview and never as an instruction.
//
// The checklist of what each issue came to is T79's, appended by the dispatcher
// below this pass's answer and never asked of the agent.
const renderFeatureDescribePrPrompt = (
  template: string,
  run: PassRun,
  task: Extract<Task, { readonly _tag: "Feature" }>,
): string =>
  [
    template.trimEnd(),
    describeTheWork(run),
    featureSetAsBackground(task),
    ...specMountBackstop(template),
  ].join("\n");

const featureSetAsBackground = (task: Extract<Task, { readonly _tag: "Feature" }>): string =>
  `The branch carries a feature run over ${task.folder}: issues ${task.selection.issues.map((issue) => issue.id).join(", ")} — their files are under ${FEATURE_ISSUES_TARGET}, background for the overview, not an instruction to carry out.`;

// What the three assemblies below read off the plan: the two facts every
// dispatcher's message names, what this run's passes are for, and what the run
// *is*. It is a structural subset of `DispatchPlan` rather than the plan
// itself, so these stay the pure functions SPEC §8 asks for and a case can hand
// them a literal.
export interface PassRun {
  readonly branch: string;
  readonly mergeBaseSha: string;
  readonly task: Task;
  // Why the identity is here and not a `resuming: boolean` beside the task: a
  // boolean derived at the seam would be a second place deciding what a resume
  // is, and the answer is already on the plan. What these functions must never
  // do is read it off the **arm** — a resume is a resume on a spec task as much
  // as on an inline one (T66, AGENTS.md).
  readonly identity: RunIdentity;
  // Which issue this *pass* is for, on the arm that runs one issue at a time
  // (T75). It is a pass's fact rather than a run's — a feature run's passes are
  // for different issues, and the boundary moves under them — which is why it
  // is not on the `DispatchPlan` beside the task: the loop that walks the
  // selection is what knows it (T76), and it hands it in beside the plan.
  //
  // `None` on a spec run and on an inline one, where there is no issue to name.
  // On a feature run it is always some; a message assembled without it names no
  // file at all rather than naming the wrong one, which is the same ruling T37
  // made for the spec sentence from the other side.
  readonly current: Option.Option<CurrentIssue>;
}

// The three assembled dispatcher's messages, one per pass, each picking its
// arm off the run's task (`plan.ts`) and appending the dispatcher's feedback
// under it. They live here with the renderers they compose, so the layer that
// runs a pass reads a template and calls one function (`agent/agent-cli.ts`)
// rather than deciding what an inline task's run is told.
//
// The sections land in one order on all three arms, because a reader of any of
// these prompts is reading the same document: what the run is and where it is,
// then what the pass is for, then the dispatcher's feedback on it, then the PR
// the run is iterating on as context under all of them.
export const implementPromptFor = (
  template: string,
  run: PassRun,
  // What the forge could be asked about the branch's PR, best-effort: a view
  // that failed degrades the prompt and never the run (`dispatch/feedback.ts`).
  // It arrives `None` on every fresh dispatch, because a fresh dispatch never
  // asks — the body would describe work this run supersedes (22 §5).
  pr: Option.Option<PrContext>,
): string =>
  withPrContext(withDispatcherFeedback(implementMessage(template, run), feedbackIn(run.task)), pr);

// A `switch` over the arms rather than the ternary pair the two of them were,
// so a fourth task arm is a compile error here rather than a prompt that
// silently sends its pass after a spec (`Task` is a closed union, `plan.ts`).
const implementMessage = (template: string, run: PassRun): string => {
  switch (run.task._tag) {
    case "Spec":
      return renderImplementPrompt(template, run);
    case "Inline":
      return renderInlineImplementPrompt(template, run, run.task.text);
    case "Feature":
      return renderFeatureImplementPrompt(template, run);
  }
};

export const reviewPromptFor = (template: string, run: PassRun, round: ReviewRound): string =>
  withDispatcherFeedback(reviewMessage(template, run, round), feedbackIn(run.task));

const reviewMessage = (template: string, run: PassRun, round: ReviewRound): string => {
  switch (run.task._tag) {
    case "Spec":
      return renderReviewPrompt(template, run, round);
    case "Inline":
      // The round's own message minus its spec sentence, dropped for the
      // reason the implement arm drops its own: nothing is mounted at
      // `SPEC_TARGET`, so a round pointed at the fidelity standard is
      // pointed at a file that is not in the container. The branch, the
      // boundary, and the budget it keeps — only the spec sentence goes, the
      // swapped criteria land under it, and the task itself follows them.
      return [
        template.trimEnd(),
        branchAndBoundary(run),
        roundNote(round),
        inlineTaskReviewCriteria(template),
        ...taskSection(run.task.text),
      ].join("\n");
    case "Feature":
      return renderFeatureReviewPrompt(template, run, round);
  }
};

// The description pass takes the feedback from T17: what it describes is the
// diff either way, and a run that was steered gets a body written by a pass
// that knows what it was steered toward — bash's PR-description prompt appends
// the same section. It takes the task for the same reason: what the branch was
// for is the Overview's first sentence, and on this arm the text is the only
// place it is written down.
//
// And the same drop the other two make: `SPEC_AS_BACKGROUND` goes, and the
// backstop stands in for it only under a template that asserted the mount
// itself. This is the arm the correction went missing on when the sentence
// lived in the template (T17 round 2 patched the implement and review arms;
// this one landed after the ticket did) — the description pass is the only one
// whose generated message never named the file, so nothing looked wrong at the
// call site. It is why T37 moved the fact rather than adding a third
// correction: a pattern that has to be remembered at every site is forgotten at
// the site where it is least visible. Bash keeps the assertion in its templates
// and corrects only the feature-mode case (`pr-prompt.md`); this package
// diverges deliberately, SPEC §12.
export const describePrPromptFor = (template: string, run: PassRun): string =>
  withDispatcherFeedback(describePrMessage(template, run), feedbackIn(run.task));

const describePrMessage = (template: string, run: PassRun): string => {
  switch (run.task._tag) {
    case "Spec":
      return renderDescribePrPrompt(template, run);
    case "Inline":
      return [
        template.trimEnd(),
        describeTheWork(run),
        ...specMountBackstop(template),
        ...taskSection(run.task.text),
      ].join("\n");
    case "Feature":
      return renderFeatureDescribePrPrompt(template, run, run.task);
  }
};
