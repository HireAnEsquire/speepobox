// What a sandbox *is*, in our vocabulary (SPEC §2): an image reference, the
// workspace, read-only mounts, an env allowlist, the env file a served repo
// may declare, resource limits, and capabilities. Never a `docker run` flag
// bag — the renderer at the bottom is the only place in the package that
// speaks docker's argv, and it is a plain function with no tag because it is
// pure.
//
// **Two invariants are unrepresentable rather than checked** (SPEC §9):
//
//   1. **No published ports.** There is no ports field here — not a flag to
//      misuse, not an escape hatch. Bash grew a post-start `docker port` check
//      that fails closed (`run.sh:1344-1347`); that is a check a future edit
//      can bypass, and this is a shape a future edit cannot express. A
//      `@ts-expect-error` pin in `test/sandbox-spec.test.ts` turns adding one
//      into a hard error.
//   2. **No userinfo crossing the boundary.** The workspace is a `RepoUrl`,
//      the branded parse T5 introduced, and not a string — so a location still
//      carrying a credential cannot be typed into a container. It is the one
//      value of this spec that came from outside the tool, which is why it is
//      the one that is branded.
//
// The read-only mounts carry the same style in the small: there is no mode
// flag on `SandboxMount`, so the workspace is the only writable thing in a
// container by shape rather than by review.
import { basename, join } from "node:path";
import { type Effect, Option } from "effect";
import type { AgentCredential } from "../agent/credential.ts";
import type { BessemerConfigShape } from "../config/config.ts";
import { resolveSandboxEnvFile, resolveSetupHookPath } from "../config/paths.ts";
import type { DispatchPlan } from "../dispatch/plan.ts";
import type { RepoUrl } from "../git/repo-url.ts";
import { issuesPathFor } from "../issues/issue-store.ts";
import { ownershipLabels } from "../ownership/labels.ts";

// The checkout, read-write, and the working directory (`run.sh:1327`).
export const WORKSPACE_TARGET = "/workspace";
// The task spec, read-only, at the path each pass's generated message names on
// a run that has one. Since T37 no shipped template names it: where the spec
// is, is the dispatcher's fact (`agent/prompt.ts`).
export const SPEC_TARGET = "/spec.md";
// The feature run's issue set, read-only, at the path each pass's generated
// message names on that arm (T75) — the directory bash mounts under the same
// name (`run.sh:1668`), minus the `/spec.md` symlink it re-pointed at each
// issue in turn. No shipped template names this one either: which issue a pass
// is for is the dispatcher's fact, exactly as which spec is (`agent/prompt.ts`).
export const FEATURE_ISSUES_TARGET = "/feature-issues";
// Where an orchestrator-owned file lands inside the container, as bash mounts
// its setup script (`run.sh:1328`). A directory of single files, never the
// host directory holding them: that one holds `.env` and other runs' state.
export const SETUP_HOOK_DIR = "/bessemer";

// The workspace, trusted by every git in the container. Docker Desktop reports
// a bind mount's own directory as root-owned while the files under it keep
// the agent's uid, so git refuses `/workspace` as "dubious ownership" — the
// feature loop's boundary read (`dispatch/feature.ts`) died on it, and every
// agent pass had been working around it by hand. The trust grants the agent
// nothing it lacks: it already writes the clone's `.git/config`, and the check
// exists for a repo another user owns.
//
// Set here rather than in the image because the image is each adopter's to
// build, and a line every adopter has to know to add is a line most will not.
// The `GIT_CONFIG_*` triple is git's command scope — protected, as `-c` is and
// a repo's own config is not — so git honours `safe.directory` from it, and
// every `docker exec` inherits it. Constants, never a host read: the value is
// the mount target above, and nothing here is a secret.
export const WORKSPACE_TRUST: ReadonlyArray<SandboxEnvVar> = [
  { name: "GIT_CONFIG_COUNT", value: "1" },
  { name: "GIT_CONFIG_KEY_0", value: "safe.directory" },
  { name: "GIT_CONFIG_VALUE_0", value: WORKSPACE_TARGET },
];

// A single host file or directory, mounted read-only. No mode: see above.
export interface SandboxMount {
  readonly source: string;
  readonly target: string;
}

// One entry of the env allowlist. It grows **one variable at a time, each with
// a note naming which child reads it** (AGENTS.md, `internal/exec.ts`) — the
// same discipline the chokepoint's own allowlist follows, for the same reason:
// the default inheritance is how a parent's credentials reach an agent.
export interface SandboxEnvVar {
  readonly name: string;
  // Absent means **forwarded by name**: `docker run -e NAME` takes the value
  // from the docker CLI's own environment, which is the chokepoint's allowlist
  // and nowhere else. That is the only shape a secret may cross in — a value
  // here becomes a word of argv, and argv is readable by every process on the
  // host and echoed by every command log we keep (T9's agent credential).
  readonly value?: string;
}

export interface SandboxLimits {
  readonly pids: number;
  readonly memory: string;
}

export interface SandboxSpec {
  // Human readability only — ownership is declared by label and never
  // inferred from a name (`ownership/labels.ts`, design rule 3).
  readonly name: string;
  readonly image: string;
  // The host fact the `bessemer.repo` label hashes. It rides on the spec
  // rather than being resolved here: it is resolved once at the composition
  // root and passed down (AGENTS.md), and a re-derivation here would make the
  // label depend on where the process happened to start.
  readonly repoRoot: string;
  readonly workspace: RepoUrl;
  readonly mounts: ReadonlyArray<SandboxMount>;
  readonly env: ReadonlyArray<SandboxEnvVar>;
  // The file docker reads the rest of the container's environment out of, when
  // the served repo declares one (T61) — `docker run --env-file <path>`. Its
  // own field beside `env` above, which stays bessemer's one-variable-at-a-time
  // allowlist: that list is what this process forwards by name, and this is
  // what the repo itself chose to hand its own containers.
  //
  // **Bessemer never opens the file; docker reads it.** That is *why* its
  // values cannot reach argv, a log, the ledger, or an event — this path may
  // appear in any of them, the contents never, because nothing under `src/`
  // reads them. Absent means the repo declared none; an outside or missing
  // value never reaches here at all, because the guard refused it (19 §5).
  readonly envFile: Option.Option<string>;
  // The agent credential, and the one field here whose **value** this process
  // holds (T23). It rides on the spec rather than being read where the
  // container starts, like the repo root above it: host facts are resolved
  // once at the composition root and passed down (AGENTS.md), and this one is
  // resolved by `agent/credential.ts` — the same answer `doctor`'s probe 3
  // reports, so a green row means this dispatch can authenticate.
  //
  // Its two halves travel apart, deliberately. The **name** crosses into the
  // container as the `env` entry derived from it — `docker run -e NAME`, no
  // value — and the **value** goes to the `docker` child's own environment,
  // which is where docker then reads it from (`sandbox.ts`). It is required
  // rather than optional because a dispatch with no credential is refused at
  // the guard, so a spec that could be built without one would be a container
  // started for a run that cannot log in.
  readonly credential: AgentCredential;
  readonly limits: SandboxLimits;
  // Added back after ALL are dropped, and config-declared (SPEC §6): the
  // sandbox has none of its own.
  readonly capabilities: ReadonlyArray<string>;
}

// The setup hook as a mount, or nothing at all when the config names no
// script (T7). One function answers both halves the run needs — where the
// script is on this host, and where it will be inside the container — so the
// step that runs it addresses the same path the container was given rather
// than a second derivation of it.
//
// The basename is kept: a host's image may scope a sudoers entry to the
// script's exact path (bash's oracle image did, for `run.sh:1361`'s one sudo call), and a
// fixed in-container name would rename the file out from under it.
export const setupHookMount = (repoRoot: string, setupHook: string): Option.Option<SandboxMount> =>
  resolveSetupHookPath(repoRoot, setupHook).pipe(
    Option.map((source) => ({ source, target: `${SETUP_HOOK_DIR}/${basename(source)}` })),
  );

// The env file the served repo declared, or nothing at all (T61). The *inside*
// arm only: the other two are refusals, and `sandboxEnvFileFound` has already
// made them before a spec is derived — the same split `setupHookMount` and
// `setupHookFound` draw between where a declared file is and whether it is
// there.
export const envFileFor = (repoRoot: string, sandboxEnvFile: string): Option.Option<string> => {
  const declared = resolveSandboxEnvFile(repoRoot, sandboxEnvFile);
  return declared._tag === "Inside" ? Option.some(declared.path) : Option.none();
};

// The spec file, mounted read-only at `SPEC_TARGET` — and **nothing at all on a
// run whose task is stated inline, and nothing on a feature run either** (T66,
// carrying T17's ruling onto the arm that replaced it, and bash's own mount
// block, which mounts nothing in that case): there is no spec, and a bind
// mount whose host path does not exist is a directory docker invents there,
// root-owned, inside the client's own repo. It is T7's ruling from the other
// side: a missing file is answered before a container starts, never by one.
// The path is read off the arm that has one, which is the whole reason it
// rides there (`dispatch/plan.ts`). The prompts agree, from the side that
// knows: since T37 no shipped template names the path, and each pass's
// generated message names it exactly on the arm where this function returns a
// mount (`agent/prompt.ts`).
//
// The feature arm's issues are mounted by `issuesMount` below and by nothing
// here (T73): they come from **inside the checkout** rather than off the host
// (SPEC §7's mount-source ruling, 15), because an issue is read *and* written,
// so the gate and the agent must read the same tree.
export const specMount = (plan: DispatchPlan): Option.Option<SandboxMount> =>
  plan.task._tag === "Spec"
    ? Option.some({ source: plan.task.path, target: SPEC_TARGET })
    : Option.none();

// The issue set a feature run's passes read, mounted at `FEATURE_ISSUES_TARGET`
// — and nothing at all on the two arms that have none, which is `specMount`'s
// shape from the other side (T75).
//
// **The source is inside the checkout**: the clone of the tip the gate read the
// set at (T73), so the selection the dispatcher made and the files the agent
// reads are one tree, where a host path would be whatever branch the dev left
// checked out (15 §"Which tree the agent reads"). `issuesPathFor` is the one
// spelling of where a folder's issues are (`issues/issue-store.ts`), so the
// directory the gate listed at the ref and the directory the container binds
// cannot drift.
//
// **Read-only**, like every mount that is not the workspace — `SandboxMount`
// has no other mode to give one. That is this ticket's ruling and not an
// inherited default: a run's status write happens at land, in the served repo
// (T77), so bash's mid-run stamp into its own materialized copy
// (`run.sh:1866`) is dropped. Nothing in a pass reads a neighbour's status, and
// a mount the agent could write would be a second author of the file 14 gives
// one author.
export const issuesMount = (plan: DispatchPlan): Option.Option<SandboxMount> =>
  plan.task._tag === "Feature"
    ? Option.some({
        source: join(plan.checkoutPath, issuesPathFor(plan.task.folder)),
        target: FEATURE_ISSUES_TARGET,
      })
    : Option.none();

// The spec a dispatch runs, derived once from the plan and the config the way
// every other per-run value is (`plan.ts`). Pure: the branded workspace
// arrives already decoded, so this module needs neither `Schema` nor an error
// channel, and the decode stays at the one call site that has a location to
// offer.
export const sandboxSpecFor = (fields: {
  readonly plan: DispatchPlan;
  readonly repoRoot: string;
  readonly workspace: RepoUrl;
  readonly config: BessemerConfigShape;
  readonly credential: AgentCredential;
}): SandboxSpec => ({
  name: fields.plan.containerId,
  image: fields.config.image,
  repoRoot: fields.repoRoot,
  workspace: fields.workspace,
  // What this run's passes are for — the spec file the agent reads (T9) on the
  // arm that has one, the issue set on the arm that has one (T75), and neither
  // on the arm that has neither — plus the setup hook when the config declares
  // one. The two task mounts are the two arms of one question, so a plan
  // carries at most one of them however long this list gets. All read-only,
  // because `SandboxMount` has no mode and the workspace is the only writable
  // thing in a container by shape.
  mounts: [
    ...Option.toArray(specMount(fields.plan)),
    ...Option.toArray(issuesMount(fields.plan)),
    ...Option.toArray(setupHookMount(fields.repoRoot, fields.config.setupHook)),
  ],
  // The credential carries no value: the agent CLI inside the container reads
  // it, and docker forwards it from its own environment (T9). The name is the
  // resolver's answer rather than a constant (T23) — the variable the CLI will
  // look for is the one it was found under — and it is derived from
  // `credential` below so the two can never name different variables. The
  // workspace trust beside it is git's, for every git in the container.
  // Everything else a container needs is the image's business.
  env: [{ name: fields.credential.name }, ...WORKSPACE_TRUST],
  // And the file the repo itself declared, whose contents this process never
  // sees: docker opens it, we name it (T61).
  envFile: envFileFor(fields.repoRoot, fields.config.sandboxEnvFile),
  credential: fields.credential,
  limits: { pids: fields.config.pidsLimit, memory: fields.config.memory },
  capabilities: fields.config.capAdd,
});

// The spec as `docker run` argv. Ownership comes from `ownership/labels.ts`
// and is never spelled out again here: creation and query read from one list
// so they agree by construction rather than by review (design rule 3).
//
// `--cap-drop ALL` is unconditional and comes first, so a declared cap-add is
// always an addition to none (Anthropic's hardening baseline, ADR 0005).
export const renderRunArgs = (spec: SandboxSpec): ReadonlyArray<string> => [
  "run",
  "-d",
  "--name",
  spec.name,
  ...ownershipLabels(spec.repoRoot).flatMap((label) => ["--label", label]),
  "--cap-drop",
  "ALL",
  ...spec.capabilities.flatMap((capability) => ["--cap-add", capability]),
  "--pids-limit",
  String(spec.limits.pids),
  "--memory",
  spec.limits.memory,
  "-v",
  `${spec.workspace}:${WORKSPACE_TARGET}`,
  "-w",
  WORKSPACE_TARGET,
  ...spec.mounts.flatMap((mount) => ["-v", `${mount.source}:${mount.target}:ro`]),
  // Before the `-e` entries (T61). docker resolves `-e` last whatever order the
  // argv is in, so this reads the way the environment is actually layered: the
  // repo's declared file first, this tool's one name-only forward on top.
  ...Option.toArray(spec.envFile).flatMap((path) => ["--env-file", path]),
  ...spec.env.flatMap((variable) => [
    "-e",
    variable.value === undefined ? variable.name : `${variable.name}=${variable.value}`,
  ]),
  spec.image,
];

// What building an agent image is, in our vocabulary (T111): the tag it gets,
// the directory docker is handed, the Dockerfile in it, and the build args and
// labels it carries — never a `docker build` flag bag, for the reason
// `SandboxSpec` is not one. `renderBuildArgs` below is its one docker speaker.
//
// Build args and labels are records whose insertion order is the argv order,
// so a rendering is a pure function of the spec, word for word.
export interface SandboxBuildSpec {
  readonly tag: string;
  // The build context, whole: every file in it is sent to the daemon, which is
  // why the caller names `.bessemer/image` and never the repo root, whose
  // `checkouts/` holds the clones of other runs.
  readonly context: string;
  readonly dockerfile: string;
  readonly buildArgs: Readonly<Record<string, string>>;
  readonly labels: Readonly<Record<string, string>>;
  // Each line docker prints while it builds, as it arrives — the shape
  // `SandboxExecOptions.onOutput` has, and for its reason: progress is a
  // `Reporter` event (05), emitted by the caller, so the layer never captures
  // a reporter of its own.
  readonly onOutput: (line: string) => Effect.Effect<void>;
}

// The build spec as `docker build` argv, the context last as docker wants it.
export const renderBuildArgs = (spec: SandboxBuildSpec): ReadonlyArray<string> => [
  "build",
  "--file",
  spec.dockerfile,
  "--tag",
  spec.tag,
  ...Object.entries(spec.buildArgs).flatMap(([name, value]) => ["--build-arg", `${name}=${value}`]),
  ...Object.entries(spec.labels).flatMap(([name, value]) => ["--label", `${name}=${value}`]),
  spec.context,
];
