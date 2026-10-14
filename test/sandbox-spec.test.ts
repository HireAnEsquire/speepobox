// The sandbox spec type, the derivation that produces one, and the renderer
// that turns it into `docker run` argv. All three are pure (SPEC §2), so this
// file needs no fake at all — what it asserts is the shape a container is
// asked for, which is the half a live dockerd cannot see.
//
// It also carries the ports **shape pin** (design rule 2): the one test whose
// failure means a design rule broke rather than a behaviour did.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { DateTime, Effect, Option, Schema } from "effect";
import { defaultConfig, defaultConfigFor } from "../src/config/config.ts";
import { packageRoot } from "../src/config/paths.ts";
import { featureDispatch, planFor, specDispatch, type Task } from "../src/dispatch/plan.ts";
import { RepoUrl } from "../src/git/repo-url.ts";
import { MANAGED_LABEL, ownershipLabels, REPO_LABEL, repoScope } from "../src/ownership/labels.ts";
import { ALTERNATE_CREDENTIAL, CREDENTIAL_CANARY, TEST_CREDENTIAL } from "./support/credential.ts";
import {
  envFileFor,
  FEATURE_ISSUES_TARGET,
  issuesMount,
  renderBuildArgs,
  renderRunArgs,
  type SandboxMount,
  type SandboxSpec,
  sandboxSpecFor,
  specMount,
  SETUP_HOOK_DIR,
  setupHookMount,
  SPEC_TARGET,
  WORKSPACE_TARGET,
} from "../src/sandbox/spec.ts";
import { fakeIssue } from "./support/issue-store-fake.ts";
import { PLAN_TIP } from "./support/plan.ts";

const REPO_ROOT = "/srv/hae";
const CHECKOUT = "/srv/bessemer/checkouts/bessemer-t6";

const workspace = Schema.decodeSync(RepoUrl)(CHECKOUT);

const spec = (overrides: Partial<SandboxSpec> = {}): SandboxSpec => ({
  name: "bessemer-bessemer-t6",
  image: "hae-agentbox",
  repoRoot: REPO_ROOT,
  workspace,
  mounts: [{ source: "/srv/hae/tasks/T6.md", target: SPEC_TARGET }],
  env: [],
  envFile: Option.none(),
  credential: TEST_CREDENTIAL,
  limits: { pids: 2048, memory: "8g" },
  capabilities: [],
  ...overrides,
});

// Every value the argv gives a flag, in order — the assertions below are about
// which values reached docker under which flag, not about where in one long
// array they landed.
const valuesOf = (args: ReadonlyArray<string>, flag: string): ReadonlyArray<string> =>
  args.flatMap((arg, index) => (arg === flag ? [args[index + 1] ?? ""] : []));

// The workspace trust every container carries (`WORKSPACE_TRUST`), spelled out
// here rather than imported so a change to it is a change to this pin: git's
// command-scope `safe.directory` for the mount, as three valued entries. None
// of it is a host read or a secret.
const TRUST_ENV = [
  { name: "GIT_CONFIG_COUNT", value: "1" },
  { name: "GIT_CONFIG_KEY_0", value: "safe.directory" },
  { name: "GIT_CONFIG_VALUE_0", value: "/workspace" },
];
const TRUST_ARGS = TRUST_ENV.map((variable) => `${variable.name}=${variable.value}`);

describe("the sandbox spec", () => {
  // Design rule 3's unit half (the live half is T8's filter selectivity): the
  // renderer attaches both labels to *every* container, whatever else the spec
  // asks for, and it takes them from the module `status` queries with.
  it("attaches both ownership labels to every container, through the labels module", () => {
    const specs = [
      spec(),
      spec({ capabilities: ["CHOWN"], env: [{ name: "TZ", value: "UTC" }], mounts: [] }),
      spec({ repoRoot: "/somewhere/else" }),
    ];
    for (const rendered of specs) {
      expect(valuesOf(renderRunArgs(rendered), "--label")).toEqual(
        ownershipLabels(rendered.repoRoot),
      );
    }
    // And what those two labels actually are, so a renderer that attached two
    // of something else would not pass: managed, plus the hash of this repo
    // root — the scope `status`'s filter asks for.
    expect(valuesOf(renderRunArgs(spec()), "--label")).toEqual([
      `${MANAGED_LABEL}=true`,
      `${REPO_LABEL}=${repoScope(REPO_ROOT)}`,
    ]);
  });

  it("drops every capability, and adds back only the ones config declared", () => {
    const none = renderRunArgs(spec());
    expect(valuesOf(none, "--cap-drop")).toEqual(["ALL"]);
    expect(valuesOf(none, "--cap-add")).toEqual([]);

    const declared = renderRunArgs(spec({ capabilities: ["CHOWN", "SETUID"] }));
    expect(valuesOf(declared, "--cap-drop")).toEqual(["ALL"]);
    expect(valuesOf(declared, "--cap-add")).toEqual(["CHOWN", "SETUID"]);
    // The drop precedes the adds, so a declared cap is always an addition to
    // none rather than a survivor of everything.
    expect(declared.indexOf("--cap-drop")).toBeLessThan(declared.indexOf("--cap-add"));
  });

  it("mounts the workspace read-write and everything else read-only", () => {
    const args = renderRunArgs(spec());
    expect(valuesOf(args, "-v")).toEqual([
      `${CHECKOUT}:${WORKSPACE_TARGET}`,
      `/srv/hae/tasks/T6.md:${SPEC_TARGET}:ro`,
    ]);
    expect(valuesOf(args, "-w")).toEqual([WORKSPACE_TARGET]);
  });

  it("renders the resource limits and the env allowlist, and ends at the image", () => {
    const args = renderRunArgs(
      spec({
        limits: { pids: 512, memory: "2g" },
        env: [{ name: "COREPACK_HOME", value: "/yarn-cache/corepack" }],
      }),
    );
    expect(valuesOf(args, "--pids-limit")).toEqual(["512"]);
    expect(valuesOf(args, "--memory")).toEqual(["2g"]);
    expect(valuesOf(args, "-e")).toEqual(["COREPACK_HOME=/yarn-cache/corepack"]);
    // And the shape a secret crosses in: the **name alone**, so docker takes
    // the value from *its own* environment — which since T23 is the value this
    // process resolved and handed the `docker` child (`sandbox.ts`), not one it
    // inherited. The token is never a word of argv: never in a command log,
    // never in another process's `ps`.
    expect(valuesOf(renderRunArgs(spec({ env: [{ name: TEST_CREDENTIAL.name }] })), "-e")).toEqual([
      TEST_CREDENTIAL.name,
    ]);
    // The image is the last word, as `docker run` requires: nothing this
    // renderer emits can be read as the container's command.
    expect(args.at(-1)).toBe("hae-agentbox");
    expect(valuesOf(args, "--name")).toEqual(["bessemer-bessemer-t6"]);
  });

  // **What a container holds, and nothing more** (T35). Writing a value into
  // the clone is the moment to assert the rest of the posture is unchanged, as
  // tests rather than as prose: the gap that ticket closed opened silently,
  // with everything still green.
  it("mounts the workspace read-write, the declared files read-only, and nothing of the host's", () => {
    const args = renderRunArgs(
      spec({
        mounts: [
          { source: "/srv/hae/tasks/T6.md", target: SPEC_TARGET },
          { source: "/srv/hae/.agentbox/setup-db.sh", target: `${SETUP_HOOK_DIR}/setup-db.sh` },
        ],
      }),
    );

    // Three mounts and the list is exhaustive: the run's own checkout, the
    // spec it was dispatched with, and the config-declared setup hook. No host
    // repo, no `~/.ssh`, no `~/.gitconfig`, no docker socket — the commit
    // identity a clone carries is written *into the clone* (T35) precisely so
    // none of those has to cross.
    const mounted = valuesOf(args, "-v");
    expect(mounted).toEqual([
      `${CHECKOUT}:${WORKSPACE_TARGET}`,
      `/srv/hae/tasks/T6.md:${SPEC_TARGET}:ro`,
      `/srv/hae/.agentbox/setup-db.sh:${SETUP_HOOK_DIR}/setup-db.sh:ro`,
    ]);
    // Read-write is the workspace alone, and it is the run's own checkout
    // rather than any path the dispatching host works in.
    expect(mounted.filter((mount) => !mount.endsWith(":ro"))).toEqual([
      `${CHECKOUT}:${WORKSPACE_TARGET}`,
    ]);
    const sources = mounted.map((mount) => mount.split(":")[0] ?? "");
    expect(sources).toEqual([CHECKOUT, "/srv/hae/tasks/T6.md", "/srv/hae/.agentbox/setup-db.sh"]);
    // Named one by one as well, because these are the paths whose absence is
    // the property: a mount list that grew any of them would still be a list
    // of three under a different derivation.
    for (const host of [REPO_ROOT, `${REPO_ROOT}/.git`, "/var/run/docker.sock"]) {
      expect(sources).not.toContain(host);
    }
    expect(args.join(" ")).not.toContain(".ssh");
    expect(args.join(" ")).not.toContain(".gitconfig");
  });

  // The mode is not a field, so read-only is a shape (T35). A green line below
  // means `SandboxMount` grew one — restore the shape rather than deleting the
  // pin (design rule 2).
  it("has no mode on a mount, so nothing but the workspace can be written", () => {
    const writable: SandboxMount = {
      source: "/home/dev/.gitconfig",
      target: "/root/.gitconfig",
      // @ts-expect-error — there is no mode on `SandboxMount`, and there must
      // never be one: the renderer has exactly one mode to give a mount.
      mode: "rw",
    };
    expect(valuesOf(renderRunArgs(spec({ mounts: [writable] })), "-v")).toEqual([
      `${CHECKOUT}:${WORKSPACE_TARGET}`,
      `${writable.source}:${writable.target}:ro`,
    ]);
  });

  // **The shape pin** (design rule 2, SPEC §9 invariant 1). A red line below
  // means the sandbox spec grew a ports field and the invariant stopped being
  // unrepresentable — restore the shape rather than deleting the pin, which is
  // the whole point of making the edit delete a test that names the rule.
  it("has no ports field at all, so no container can publish one", () => {
    const published: SandboxSpec = {
      ...spec(),
      // @ts-expect-error — there is no ports field on `SandboxSpec`, and there
      // must never be one: task containers publish no ports (ADR 0004/0005).
      ports: [{ host: 8000, container: 8000 }],
    };
    // The runtime half is deliberately thin — the assertion that matters is
    // the compile-time one above. This one says the renderer has no way to
    // spell a published port either, whatever it is handed.
    const args = renderRunArgs(published);
    expect(args.includes("-p")).toBe(false);
    expect(args.includes("--publish")).toBe(false);
  });
});

describe("the spec a dispatch derives", () => {
  const SPEC_PATH = "/srv/hae/tasks/T6.md";
  const plan = planFor({
    ...specDispatch(SPEC_PATH),
    branch: "bessemer-t6",
    baseRef: "origin/master",
    baseSha: "1111111111111111111111111111111111111111",
    mergeBaseSha: "2222222222222222222222222222222222222222",
    tipSha: PLAN_TIP,
    runtimeRoot: "/srv/bessemer",
    startedAt: DateTime.unsafeMake("2026-01-01T00:00:00.000Z"),
  });

  it("takes its image, limits, and capabilities from the config, and its names from the plan", () => {
    const derived = sandboxSpecFor({
      plan,
      repoRoot: REPO_ROOT,
      workspace,
      config: { ...defaultConfigFor(REPO_ROOT), image: "hae-agentbox", capAdd: ["KILL"] },
      credential: TEST_CREDENTIAL,
    });

    expect(derived).toEqual({
      name: plan.containerId,
      image: "hae-agentbox",
      repoRoot: REPO_ROOT,
      workspace,
      mounts: [{ source: SPEC_PATH, target: SPEC_TARGET }],
      // One entry, and it carries no value: the agent CLI inside the container
      // reads the credential and docker forwards it from its own environment
      // (T9). The name is the resolver's answer rather than a constant (T23),
      // derived from the credential beside it so the two cannot name different
      // variables. Beside it, git's workspace trust, which every git in the
      // container reads. The allowlist gains nothing else — every variable on
      // it names a child that reads it.
      env: [{ name: TEST_CREDENTIAL.name }, ...TRUST_ENV],
      // And no env file: this repo's config declares none, which is the whole
      // of "no --env-file in the argv" (T61).
      envFile: Option.none(),
      credential: TEST_CREDENTIAL,
      limits: { pids: defaultConfig.pidsLimit, memory: defaultConfig.memory },
      capabilities: ["KILL"],
    });
  });

  // The env file a served repo declares (T61): its own field beside `env`,
  // filled from the resolver's *inside* arm, and rendered as one `--env-file`
  // before the allowlist docker resolves last.
  it("renders the declared env file as --env-file, ahead of the env allowlist", () => {
    const derived = sandboxSpecFor({
      plan,
      repoRoot: REPO_ROOT,
      workspace,
      config: { ...defaultConfigFor(REPO_ROOT), sandboxEnvFile: ".bessemer/env.sandbox" },
      credential: TEST_CREDENTIAL,
    });
    expect(derived.envFile).toEqual(Option.some(`${REPO_ROOT}/.bessemer/env.sandbox`));
    // The allowlist is untouched by it: the credential's name, and the trust.
    expect(derived.env).toEqual([{ name: TEST_CREDENTIAL.name }, ...TRUST_ENV]);

    const args = renderRunArgs(derived);
    expect(valuesOf(args, "--env-file")).toEqual([`${REPO_ROOT}/.bessemer/env.sandbox`]);
    expect(args.indexOf("--env-file")).toBeLessThan(args.indexOf("-e"));
    // A path, and only a path — this process never opened the file, so there
    // is nothing of its contents to render (19 §5).
    expect(valuesOf(args, "--env-file").some((value) => value.includes("="))).toBe(false);
  });

  // The whole argv, spelled out, for a config that declares no env file: the
  // key's absence has to leave every other word exactly where it was, and a
  // renderer that emitted an empty `--env-file` would land here rather than in
  // a dispatcher's failed run.
  it("renders argv unchanged, word for word, when the config declares no env file", () => {
    const derived = sandboxSpecFor({
      plan,
      repoRoot: REPO_ROOT,
      workspace,
      config: { ...defaultConfigFor(REPO_ROOT), image: "hae-agentbox" },
      credential: TEST_CREDENTIAL,
    });
    expect(derived.envFile).toEqual(Option.none());
    expect(renderRunArgs(derived)).toEqual([
      "run",
      "-d",
      "--name",
      plan.containerId,
      "--label",
      `${MANAGED_LABEL}=true`,
      "--label",
      `${REPO_LABEL}=${repoScope(REPO_ROOT)}`,
      "--cap-drop",
      "ALL",
      "--pids-limit",
      String(defaultConfig.pidsLimit),
      "--memory",
      defaultConfig.memory,
      "-v",
      `${CHECKOUT}:${WORKSPACE_TARGET}`,
      "-w",
      WORKSPACE_TARGET,
      "-v",
      `${SPEC_PATH}:${SPEC_TARGET}:ro`,
      "-e",
      TEST_CREDENTIAL.name,
      ...TRUST_ARGS.flatMap((variable) => ["-e", variable]),
      "hae-agentbox",
    ]);
  });

  // The two arms the guard refuses never reach a container: the derivation
  // resolves the *inside* arm and nothing else, so a value that slipped past
  // would be a spec with no env file rather than one pointing out of the repo.
  it("derives an env file only from a value inside the served repo", () => {
    expect(envFileFor(REPO_ROOT, ".bessemer/env.sandbox")).toEqual(
      Option.some(`${REPO_ROOT}/.bessemer/env.sandbox`),
    );
    expect(defaultConfig.sandboxEnvFile).toBe("");
    for (const refused of ["", "   ", "/etc/secrets/.env", "../.env", "a/../../.env"]) {
      expect(envFileFor(REPO_ROOT, refused)).toEqual(Option.none());
    }
  });

  // The environment a container gets, in full (T35): the agent credential,
  // forwarded **by name** — `docker run -e NAME`, no value, with the value
  // reaching docker's own child environment instead (`sandbox.ts`) — and git's
  // workspace trust, whose values are constants. Everything else the image
  // supplies for itself.
  it("gives the container the credential by name, and the workspace trust by value", () => {
    const derived = sandboxSpecFor({
      plan,
      repoRoot: REPO_ROOT,
      workspace,
      config: defaultConfigFor(REPO_ROOT),
      credential: TEST_CREDENTIAL,
    });

    expect(derived.env).toEqual([{ name: TEST_CREDENTIAL.name }, ...TRUST_ENV]);
    // Absent, not empty: a value here would become a word of argv, which is
    // readable by every process on the host. The trust's values are the only
    // ones, and they are constants.
    expect(derived.env[0]?.value).toBeUndefined();
    const rendered = valuesOf(renderRunArgs(derived), "-e");
    expect(rendered).toEqual([TEST_CREDENTIAL.name, ...TRUST_ARGS]);
    expect(rendered.filter((variable) => variable.includes("="))).toEqual(TRUST_ARGS);
  });

  // The trap T23 §3 names, asserted rather than intended: the value is in this
  // process's hands now, and the renderer must still put only the *name* in
  // argv. `Redacted` is what makes the wrong shape harmless as well as wrong —
  // a renderer that interpolated the value would emit `<redacted>`.
  it("never renders the credential's value, under any flag", () => {
    const derived = sandboxSpecFor({
      plan,
      repoRoot: REPO_ROOT,
      workspace,
      config: defaultConfigFor(REPO_ROOT),
      credential: TEST_CREDENTIAL,
    });
    const args = renderRunArgs(derived);
    expect(valuesOf(args, "-e")).toEqual([TEST_CREDENTIAL.name, ...TRUST_ARGS]);
    expect(args.join(" ")).not.toContain(CREDENTIAL_CANARY);
  });

  // The second accepted name, on the *run's* side (T23): the resolver answers
  // with the name it found, and both halves of the spec are derived from that
  // answer rather than from a constant. A host whose credential is an
  // `ANTHROPIC_API_KEY` — which probe 3 has promised works since T1 — would
  // otherwise get a container told to read a variable nothing set, which is
  // §1's second row and the half a fixture on the first name cannot see.
  it("forwards whichever of the two names the credential was found under", () => {
    const derived = sandboxSpecFor({
      plan,
      repoRoot: REPO_ROOT,
      workspace,
      config: defaultConfigFor(REPO_ROOT),
      credential: ALTERNATE_CREDENTIAL,
    });
    expect(ALTERNATE_CREDENTIAL.name).not.toBe(TEST_CREDENTIAL.name);
    expect(derived.env).toEqual([{ name: ALTERNATE_CREDENTIAL.name }, ...TRUST_ENV]);
    expect(valuesOf(renderRunArgs(derived), "-e")).toEqual([
      ALTERNATE_CREDENTIAL.name,
      ...TRUST_ARGS,
    ]);
    // And the value the `docker` child is handed is the same one, so the two
    // cannot name different variables (`sandbox.ts` passes this field).
    expect(derived.credential).toBe(ALTERNATE_CREDENTIAL);
  });

  // The setup hook (T7), which is config-declared and generic: nothing about
  // it names hae, and the *absence* of a declared script is a spec with one
  // mount rather than a mount pointing nowhere.
  it("mounts the declared setup hook read-only, resolved against the repo root", () => {
    const declared = sandboxSpecFor({
      plan,
      repoRoot: REPO_ROOT,
      workspace,
      config: { ...defaultConfigFor(REPO_ROOT), setupHook: ".agentbox/setup-db.sh" },
      credential: TEST_CREDENTIAL,
    });
    expect(declared.mounts).toEqual([
      { source: SPEC_PATH, target: SPEC_TARGET },
      { source: `${REPO_ROOT}/.agentbox/setup-db.sh`, target: `${SETUP_HOOK_DIR}/setup-db.sh` },
    ]);
    // Read-only, like every mount that is not the workspace — the renderer
    // has no other mode to give one.
    expect(valuesOf(renderRunArgs(declared), "-v")).toEqual([
      `${CHECKOUT}:${WORKSPACE_TARGET}`,
      `${SPEC_PATH}:${SPEC_TARGET}:ro`,
      `${REPO_ROOT}/.agentbox/setup-db.sh:${SETUP_HOOK_DIR}/setup-db.sh:ro`,
    ]);
  });

  // The run whose task was stated inline (T17, on the arm T66 moved it to):
  // there is no spec, so there is nothing to mount at `/spec.md` — and a bind
  // whose host path is missing is a directory docker invents there, root-owned,
  // inside the client's own repo. Its prompts never name the file either
  // (`agent/prompt.ts`).
  it("mounts no spec at all when the task was stated inline", () => {
    const inlineTask = sandboxSpecFor({
      plan: {
        ...plan,
        task: { _tag: "Inline", text: "fix the release note", feedback: Option.none() },
      },
      repoRoot: REPO_ROOT,
      workspace,
      config: { ...defaultConfigFor(REPO_ROOT), setupHook: ".agentbox/setup-db.sh" },
      credential: TEST_CREDENTIAL,
    });
    // The hook still mounts: what the arm drops is the spec and only the spec.
    expect(inlineTask.mounts).toEqual([
      { source: `${REPO_ROOT}/.agentbox/setup-db.sh`, target: `${SETUP_HOOK_DIR}/setup-db.sh` },
    ]);
    expect(renderRunArgs(inlineTask).join(" ")).not.toContain(SPEC_TARGET);
    // And the ordinary run is unchanged, so this is the arm's own behaviour.
    expect(specMount(plan)).toEqual(Option.some({ source: SPEC_PATH, target: SPEC_TARGET }));
  });

  // The feature arm's own mount (T75): the issues come from **inside the
  // checkout** rather than off the host, because an issue is read and written
  // and the gate and the agent must read one tree (15). So the source is the
  // clone of the tip the set was read at, under the folder the dispatcher
  // named, and nothing of the host's is bound for it.
  const featureRun = {
    ...plan,
    ...featureDispatch("tasks/f", { request: { _tag: "All" }, issues: [fakeIssue("T70")] }),
  };

  it("mounts the issue set from inside the checkout, and no spec, on a feature run", () => {
    expect(specMount(featureRun)).toEqual(Option.none());
    expect(issuesMount(featureRun)).toEqual(
      Option.some({ source: `${CHECKOUT}/tasks/f/issues`, target: FEATURE_ISSUES_TARGET }),
    );
    const derived = sandboxSpecFor({
      plan: featureRun,
      repoRoot: REPO_ROOT,
      workspace,
      config: defaultConfigFor(REPO_ROOT),
      credential: TEST_CREDENTIAL,
    });
    // Exactly one task mount, and it is that one: a feature plan carries no
    // spec path at all, so nothing here can land at `/spec.md`.
    expect(derived.mounts).toEqual([
      { source: `${CHECKOUT}/tasks/f/issues`, target: FEATURE_ISSUES_TARGET },
    ]);
    // Read-only, like every mount that is not the workspace: the status a run
    // writes is written at land, in the served repo (T77), never by a pass.
    expect(valuesOf(renderRunArgs(derived), "-v")).toEqual([
      `${CHECKOUT}:${WORKSPACE_TARGET}`,
      `${CHECKOUT}/tasks/f/issues:${FEATURE_ISSUES_TARGET}:ro`,
    ]);
    expect(renderRunArgs(derived).join(" ")).not.toContain(SPEC_TARGET);
    // Nothing of the host's: the folder the dispatcher typed is repo-relative,
    // and the tree it is resolved against is the checkout and never the repo.
    expect(renderRunArgs(derived).join(" ")).not.toContain(`${REPO_ROOT}/tasks/f`);
  });

  // **The shape pin** for the arm above (design rule 2): what lands at
  // `/spec.md` is whatever `task.path` names, and the feature arm has no such
  // field — so a feature run mounting a spec is not a behaviour to assert
  // against but a shape to keep unspellable. A green line below means the arm
  // grew a path; restore the shape rather than deleting the pin, which is the
  // whole point of making the edit delete a test that names the rule.
  it("has no spec path on a feature task, so no feature run can mount one", () => {
    const withAPath: Extract<Task, { readonly _tag: "Feature" }> = {
      _tag: "Feature",
      folder: "tasks/f",
      selection: { request: { _tag: "All" }, issues: [fakeIssue("T70")] },
      feedback: Option.none(),
      // @ts-expect-error — the feature arm carries a folder and a selection,
      // and there must never be a `path` on it: a feature run reads its issues
      // out of the checkout, and the tree they are in is not a work order's
      // host file (15).
      path: "/srv/hae/tasks/T70.md",
    };
    // The runtime half is deliberately thin — the assertion that matters is the
    // compile-time one above. This one says the derivation has no way to reach
    // a spec on this arm whatever the task carries.
    expect(specMount({ ...featureRun, task: withAPath })).toEqual(Option.none());
  });

  // And the arm that has neither mounts neither: the inline run's assertion
  // above says no spec, and this one says the issues mount is the feature
  // arm's alone.
  it("mounts no issue set on a spec or an inline run", () => {
    expect(issuesMount(plan)).toEqual(Option.none());
    expect(
      issuesMount({
        ...plan,
        task: { _tag: "Inline", text: "fix the release note", feedback: Option.none() },
      }),
    ).toEqual(Option.none());
  });

  it("takes an absolute setup hook as-is, and keeps the script's own name", () => {
    expect(setupHookMount(REPO_ROOT, "/opt/hooks/bring-up.sh")).toEqual(
      Option.some({
        source: "/opt/hooks/bring-up.sh",
        target: `${SETUP_HOOK_DIR}/bring-up.sh`,
      }),
    );
  });

  it("has no setup hook mount, and no hook at all, when the config names none", () => {
    expect(defaultConfig.setupHook).toBe("");
    expect(setupHookMount(REPO_ROOT, "")).toEqual(Option.none());
    // Whitespace is a key someone emptied, not a script called " ".
    expect(setupHookMount(REPO_ROOT, "   ")).toEqual(Option.none());
    expect(
      sandboxSpecFor({
        plan,
        repoRoot: REPO_ROOT,
        workspace,
        config: defaultConfigFor(REPO_ROOT),
        credential: TEST_CREDENTIAL,
      }).mounts,
    ).toEqual([{ source: SPEC_PATH, target: SPEC_TARGET }]);
  });

  // Caps drop to none by default: the committed config declares no cap-add,
  // so a host that never edited it runs with nothing added back.
  it("adds no capability when the config declares none", () => {
    expect(defaultConfig.capAdd).toEqual([]);
    expect(
      sandboxSpecFor({
        plan,
        repoRoot: REPO_ROOT,
        workspace,
        config: defaultConfigFor(REPO_ROOT),
        credential: TEST_CREDENTIAL,
      }).capabilities,
    ).toEqual([]);
  });
});

// **Bessemer never opens the file; docker reads it** (T61, 19 §5). Reading
// source is the only way to assert an absence, and the absence is the whole
// guarantee: a `readFile` of this path would typecheck, pass every case above,
// and put about 250 of a repo's settings one interpolation away from argv, a
// log, the ledger, or an event. `signal-matrix.test.ts` asserts its own
// absence the same way and for the same reason.
const SOURCE_ROOT = join(packageRoot, "src");

const sourceFiles = (dir: string): ReadonlyArray<string> =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(full) : entry.name.endsWith(".ts") ? [full] : [];
  });

// Comments name the guarantee at its sites — that is how it is documented —
// so only code counts, as `scripts/check-bans.ts` does it.
const codeOf = (file: string): string =>
  readFileSync(file, "utf8")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");

describe("the env file's contents", () => {
  it("is named in src by the five modules that carry the path, and read by none of them", () => {
    const naming = sourceFiles(SOURCE_ROOT)
      .map((file) => ({ file: relative(packageRoot, file), code: codeOf(file) }))
      .filter((source) => /envfile|sandbox-env-file/i.test(source.code));

    // Not a vacuous pass: the path is carried by the resolver, the key, the
    // guard, the spec, and the dispatch that calls the guard. A scan that
    // matched nothing would be an absence nobody asserted.
    expect(naming.map((source) => source.file).toSorted()).toEqual([
      join("src", "config", "config.ts"),
      join("src", "config", "paths.ts"),
      join("src", "dispatch", "dispatch.ts"),
      join("src", "dispatch", "guards.ts"),
      join("src", "sandbox", "spec.ts"),
    ]);

    // And every one of them names the file without opening it. The guard's
    // existence check is a `stat`, which is the one syscall this path gets.
    for (const source of naming) {
      expect(source.code).not.toMatch(/read\w*file\w*|createReadStream/i);
    }
  });
});

// `docker build`'s argv (T111), asserted word for word as `run`'s is: the
// build spec is our vocabulary, and this renderer is the one place it becomes
// docker's.
describe("the build spec", () => {
  it("renders the Dockerfile, the tag, the build args, the labels, and ends at the context", () => {
    expect(
      renderBuildArgs({
        tag: "hae-agentbox",
        context: "/srv/hae/.bessemer/image",
        dockerfile: "/srv/hae/.bessemer/image/Dockerfile",
        buildArgs: { AGENT_UID: "501", AGENT_GID: "20" },
        labels: {
          "bessemer.inputs": ".bessemer/image/Dockerfile,package.json",
          "bessemer.inputs.digest": "abc123",
        },
        onOutput: () => Effect.void,
      }),
    ).toEqual([
      "build",
      "--file",
      "/srv/hae/.bessemer/image/Dockerfile",
      "--tag",
      "hae-agentbox",
      "--build-arg",
      "AGENT_UID=501",
      "--build-arg",
      "AGENT_GID=20",
      "--label",
      "bessemer.inputs=.bessemer/image/Dockerfile,package.json",
      "--label",
      "bessemer.inputs.digest=abc123",
      "/srv/hae/.bessemer/image",
    ]);
  });
});
