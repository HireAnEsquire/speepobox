import { describe, expect, it } from "@effect/vitest";
import { FileSystem } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { Effect, Either, Redacted, Ref } from "effect";
import { CREDENTIAL_NAMES } from "../src/agent/credential.ts";
import {
  exec,
  execFed,
  execInteractive,
  execStreamed,
  execUnder,
  execWith,
  GIT_INDEX_FILE,
} from "../src/internal/exec.ts";

// The name a real dispatch forwards most often — the resolver's first choice.
// Which of the two it is does not matter here: what this file is about is that
// a value we hold reaches one child and no other.
const [AGENT_CREDENTIAL = ""] = CREDENTIAL_NAMES;

// The value handed over, spelled once so a case can assert where it did *not*
// arrive — this process's own environment, and the next child's.
const CANARY = "not-a-real-token";

// And the one variable this package gives a child rather than forwarding
// (T77), as a path under a runtime root would look.
const SCRATCH_INDEX = "/runtime/bessemer-t77.index";

// A child that reads its stdin to EOF before answering. Every streamed case
// below uses one: the half of `execStreamed` under test is the pipe, and a
// child that never reads it would prove nothing about what arrived.
const readsStdinThen = (answer: string): string =>
  `process.stdin.resume(); process.stdin.on("end", () => { ${answer} })`;

// The streamed cases collect their child's lines into a `Ref` — the shape a
// real caller has, where each line is an effect (a `Reporter` event) rather
// than a string appended to a buffer.
const lines = Ref.make<ReadonlyArray<string>>([]);
const into =
  (seen: Ref.Ref<ReadonlyArray<string>>) =>
  (line: string): Effect.Effect<void> =>
    Ref.update(seen, (current) => [...current, line]);

describe("the subprocess chokepoint", () => {
  it.effect("extendEnv: false — the parent environment does not leak into children", () =>
    Effect.gen(function* () {
      process.env["BESSEMER_LEAK_CANARY"] = "leaked";
      try {
        const result = yield* exec("node", "-p", 'process.env.BESSEMER_LEAK_CANARY ?? "ABSENT"');
        expect(result.exitCode).toBe(0);
        expect(result.stdout.trim()).toBe("ABSENT");
      } finally {
        delete process.env["BESSEMER_LEAK_CANARY"];
      }
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.effect("the allowlist still reaches children (PATH resolved the binary)", () =>
    Effect.gen(function* () {
      const result = yield* exec("node", "-p", 'process.env.PATH === undefined ? "NO-PATH" : "ok"');
      expect(result.stdout.trim()).toBe("ok");
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  // The credential's path, and the whole of it since T23: the value is
  // resolved at the composition root and handed to *this* child's environment,
  // so it arrives whether the host exported it or wrote it in `.env` — which
  // an allowlist entry could never say, since nothing loads that file into
  // this process.
  it.effect("a secret reaches the child that was given one, through its environment", () =>
    Effect.gen(function* () {
      const result = yield* execWith(
        [{ name: AGENT_CREDENTIAL, value: Redacted.make(CANARY) }],
        "node",
        "-p",
        `process.env[${JSON.stringify(AGENT_CREDENTIAL)}] ?? "ABSENT"`,
      );
      expect(result.stdout.trim()).toBe(CANARY);
      // And nowhere else: the value went into an environment, so this process
      // still does not carry it and neither does the next child. The canary
      // rather than absence, because a host that exported its own token under
      // this name is one the tool supports — and one that runs this suite.
      expect(process.env[AGENT_CREDENTIAL]).not.toBe(CANARY);
      const next = yield* exec(
        "node",
        "-p",
        `process.env[${JSON.stringify(AGENT_CREDENTIAL)}] ?? "ABSENT"`,
      );
      expect(next.stdout.trim()).toBe("ABSENT");
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  // The other half of the same ruling: the process-env allowlist carries no
  // credential at all. It forwards variables we did not read, and a second
  // mechanism reaching the same child is one more place a secret can be
  // spilled — a token exported in the shell reaches the container because the
  // resolver read it and handed it over, never because it was inherited.
  it.effect("the process-env allowlist forwards no credential of its own", () =>
    Effect.gen(function* () {
      const previous = process.env[AGENT_CREDENTIAL];
      process.env[AGENT_CREDENTIAL] = "inherited-token";
      try {
        const result = yield* exec(
          "node",
          "-p",
          `process.env[${JSON.stringify(AGENT_CREDENTIAL)}] ?? "ABSENT"`,
        );
        expect(result.stdout.trim()).toBe("ABSENT");
      } finally {
        if (previous === undefined) {
          delete process.env[AGENT_CREDENTIAL];
        } else {
          process.env[AGENT_CREDENTIAL] = previous;
        }
      }
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  // The same path for a value that is not a secret (T77): the scratch index
  // the status commit's tree is built in is one variable, given to one child,
  // and never read back out of `process.env` — a dispatcher who exported a
  // `GIT_INDEX_FILE` of their own is not what any git of ours reads.
  it.effect("a given variable reaches that child, and no child beside it", () =>
    Effect.gen(function* () {
      const previous = process.env[GIT_INDEX_FILE];
      process.env[GIT_INDEX_FILE] = "/the/dispatchers/own.index";
      try {
        const result = yield* execUnder(
          { name: GIT_INDEX_FILE, value: SCRATCH_INDEX },
          "node",
          "-p",
          `process.env[${JSON.stringify(GIT_INDEX_FILE)}] ?? "ABSENT"`,
        );
        expect(result.stdout.trim()).toBe(SCRATCH_INDEX);
        // The next child gets neither ours nor the one the shell exported:
        // this variable is on no allowlist, so nothing inherits it.
        const next = yield* exec(
          "node",
          "-p",
          `process.env[${JSON.stringify(GIT_INDEX_FILE)}] ?? "ABSENT"`,
        );
        expect(next.stdout.trim()).toBe("ABSENT");
      } finally {
        if (previous === undefined) {
          delete process.env[GIT_INDEX_FILE];
        } else {
          process.env[GIT_INDEX_FILE] = previous;
        }
      }
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  // Names the child's own runtime writes into its environment after it starts,
  // which nothing here passed it. `node` links CoreFoundation on macOS, and CF
  // sets `__CF_USER_TEXT_ENCODING` during its init — so a child spawned with an
  // env of exactly PATH and HOME still reports three names, and an equality
  // assertion reads the third as a leak.
  //
  // Subtracted **by name, never by pattern**: this assertion exists so that an
  // unexpected name fails it, and a pattern broad enough to cover a family of
  // them would defeat the check it sits inside. A new one belongs on this list
  // only once it is shown to be self-written rather than forwarded — the probe
  // is one line, spawning `node` with a hand-built `env` and reading back
  // `Object.keys(process.env)`.
  //
  // The container this suite is authored in has no CoreFoundation, which is how
  // the assertion below was written green and failed on the first macOS host to
  // run it — the same host-dependence T23's review pass fixed in the other
  // direction.
  const SELF_INJECTED: ReadonlyArray<string> = ["__CF_USER_TEXT_ENCODING"];

  // **The whole allowlist, asked of a child** (T35): `PATH` so a binary
  // resolves, `HOME` so docker, gh, and git find their own config, and the
  // four T84 added — the three git's own editor chain reads, and the terminal
  // type the editor itself reads — and nothing else, so a variable this
  // process happens to hold reaches no child by inheritance. Read off what a
  // child actually got rather than off the constant: the list is only a
  // security property in the environment it produces.
  //
  // Every name is exported here rather than assumed, because a forward is only
  // visible when the parent has the variable: a host with no `EDITOR` would
  // otherwise make this assertion pass by the absence it is about.
  it.effect("forwards exactly the allowlist to a child, and nothing else", () =>
    Effect.gen(function* () {
      const exported: Readonly<Record<string, string>> = {
        BESSEMER_LEAK_CANARY: "leaked",
        GIT_EDITOR: "ed",
        VISUAL: "ed",
        EDITOR: "ed",
        TERM: "xterm-256color",
      };
      const previous = Object.fromEntries(
        Object.keys(exported).map((name) => [name, process.env[name]]),
      );
      Object.assign(process.env, exported);
      try {
        const result = yield* exec("node", "-p", 'Object.keys(process.env).sort().join(",")');
        const forwarded = result.stdout
          .trim()
          .split(",")
          .filter((name) => !SELF_INJECTED.includes(name));
        expect(forwarded.join(",")).toBe("EDITOR,GIT_EDITOR,HOME,PATH,TERM,VISUAL");
      } finally {
        for (const [name, value] of Object.entries(previous)) {
          if (value === undefined) {
            delete process.env[name];
          } else {
            process.env[name] = value;
          }
        }
      }
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.effect("a nonzero exit is a result, not a failure", () =>
    Effect.gen(function* () {
      const result = yield* exec("node", "-e", "process.exit(3)");
      expect(result.exitCode).toBe(3);
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.effect("stderr is captured separately from stdout", () =>
    Effect.gen(function* () {
      const result = yield* exec(
        "node",
        "-e",
        'process.stdout.write("out"); process.stderr.write("err")',
      );
      expect(result.stdout).toBe("out");
      expect(result.stderr).toBe("err");
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.effect("a missing binary fails with a typed ExecError", () =>
    Effect.gen(function* () {
      const outcome = yield* Effect.either(exec("bessemer-no-such-binary-xyz"));
      expect(Either.isLeft(outcome)).toBe(true);
      if (Either.isLeft(outcome)) {
        expect(outcome.left._tag).toBe("ExecError");
        expect(outcome.left.command).toBe("bessemer-no-such-binary-xyz");
      }
    }).pipe(Effect.provide(NodeContext.layer)),
  );
});

// The streamed half of the chokepoint (T9's agent pass). It is asked the same
// questions as `exec` above, against real children, because it is a *second*
// implementation of the same env discipline and the same nonzero-is-a-result
// rule — and because the seam its callers are tested through is a fake
// executor, which can answer what was handed to it and nothing about what a
// child actually inherited or received.
describe("the streamed chokepoint", () => {
  it.effect("extendEnv: false holds for the child that is talked to as well", () =>
    Effect.gen(function* () {
      const seen = yield* lines;
      process.env["BESSEMER_LEAK_CANARY"] = "leaked";
      try {
        const outcome = yield* execStreamed(
          { stdin: "", onLine: into(seen) },
          "node",
          "-e",
          readsStdinThen('process.stdout.write(process.env.BESSEMER_LEAK_CANARY ?? "ABSENT");'),
        );
        expect(outcome.exitCode).toBe(0);
        expect(yield* Ref.get(seen)).toEqual(["ABSENT"]);
      } finally {
        delete process.env["BESSEMER_LEAK_CANARY"];
      }
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  // **The property the whole agent seam rests on**, asked of a real child: the
  // text goes down the pipe and no word of it is ever argv, so `$(…)`,
  // backticks, and quotes arrive as themselves. The pipe is also closed for
  // us — the child's `end` fires — which is what lets a CLI reading stdin
  // answer at all rather than hanging until the pass timeout.
  it.effect("feeds stdin verbatim and delivers the child's output one line at a time", () =>
    Effect.gen(function* () {
      const seen = yield* lines;
      const prompt = "$(rm -rf /) `whoami`\n\"quoted\" 'single' $HOME";
      const outcome = yield* execStreamed(
        { stdin: prompt, onLine: into(seen) },
        "node",
        "-e",
        "process.stdin.pipe(process.stdout)",
      );

      expect(outcome.exitCode).toBe(0);
      expect(yield* Ref.get(seen)).toEqual(prompt.split("\n"));
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.effect("a nonzero exit is a result here too, with stderr beside it", () =>
    Effect.gen(function* () {
      const seen = yield* lines;
      const outcome = yield* execStreamed(
        { stdin: "", onLine: into(seen) },
        "node",
        "-e",
        readsStdinThen('process.stderr.write("err"); process.exit(3);'),
      );

      expect(outcome.exitCode).toBe(3);
      expect(outcome.stderr).toBe("err");
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  // `docker build`'s shape (T111): its progress is on stderr, so the caller
  // asks for those lines as they arrive — and still gets them back whole, for
  // the failure a nonzero build carries.
  it.effect("hands stderr over line by line when asked, and still collects it", () =>
    Effect.gen(function* () {
      const out = yield* lines;
      const err = yield* lines;
      const outcome = yield* execStreamed(
        { stdin: "", onLine: into(out), onErrLine: into(err) },
        "node",
        "-e",
        readsStdinThen('process.stderr.write("step 1\\nstep 2\\n"); process.exit(1);'),
      );

      expect(outcome.exitCode).toBe(1);
      expect(yield* Ref.get(err)).toEqual(["step 1", "step 2"]);
      expect(yield* Ref.get(out)).toEqual([]);
      expect(outcome.stderr).toBe("step 1\nstep 2");
    }).pipe(Effect.provide(NodeContext.layer)),
  );
});

// The third shape (T71), against a real child for the reasons the two above
// are: what a fake executor can say about bytes is what a test handed it.
describe("the fed chokepoint", () => {
  it.effect("extendEnv: false holds for the fed child too", () =>
    Effect.gen(function* () {
      process.env["BESSEMER_LEAK_CANARY"] = "leaked";
      try {
        const result = yield* execFed(
          "",
          "node",
          "-e",
          readsStdinThen('process.stdout.write(process.env.BESSEMER_LEAK_CANARY ?? "ABSENT");'),
        );
        expect(result.exitCode).toBe(0);
        expect(new TextDecoder().decode(result.stdout)).toBe("ABSENT");
      } finally {
        delete process.env["BESSEMER_LEAK_CANARY"];
      }
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  // **The bytes, not the characters.** The child echoes what it was fed, and
  // the answer is asserted as the byte length the reader frames on: decoded to
  // a string an em dash would be one, and the caller counting it as one is the
  // parse that reads every later object at the wrong offset.
  it.effect("feeds stdin verbatim and answers the child's output as bytes", () =>
    Effect.gen(function* () {
      const fed = "T71 — the read\n";
      const result = yield* execFed(fed, "node", "-e", "process.stdin.pipe(process.stdout)");

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBeInstanceOf(Uint8Array);
      expect(result.stdout.length).toBe(new TextEncoder().encode(fed).length);
      expect(result.stdout.length).not.toBe(fed.length);
      expect(new TextDecoder().decode(result.stdout)).toBe(fed);
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.effect("a nonzero exit is a result here too, with stderr beside it", () =>
    Effect.gen(function* () {
      const result = yield* execFed(
        "",
        "node",
        "-e",
        readsStdinThen('process.stderr.write("err"); process.exit(3);'),
      );

      expect(result.exitCode).toBe(3);
      expect(result.stderr).toBe("err");
    }).pipe(Effect.provide(NodeContext.layer)),
  );
});

// The inherited half (T84): the one child this package spawns that writes to
// the dispatcher's screen rather than to a pipe we read. Asked against real
// children for the reason the streamed half is — the environment discipline
// and the nonzero-is-a-result rule are implemented a fourth time here, and a
// fake executor can only say what it was handed.
//
// What it cannot assert from inside a test suite is the terminal itself:
// vitest's own stdio is what an inherited child gets here, so the cases below
// are about the *contract* — the exit code comes back, the env is still the
// allowlist, and a missing binary is still an `ExecError`. The editor on a
// real desk is the ticket's host-only check.
describe("the interactive chokepoint", () => {
  it.scoped("runs the child to completion and answers its exit code", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const file = `${dir}/edited`;
      // An editor is a child that leaves its answer in the file it was handed,
      // which is exactly what this one does.
      const exit = yield* execInteractive(
        "node",
        "-e",
        'require("node:fs").writeFileSync(process.argv[1], "use the smaller diff\\n")',
        file,
      );

      expect(exit).toBe(0);
      expect(yield* fs.readFileString(file)).toBe("use the smaller diff\n");
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  // The editor the dispatcher quit without saving: a result here, and the
  // caller's typed refusal one layer up (`prompt/editor.ts`).
  it.effect("a nonzero exit is a result here too, not a failure", () =>
    Effect.gen(function* () {
      expect(yield* execInteractive("node", "-e", "process.exit(3)")).toBe(3);
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  // The env discipline holds on the entry that hands the terminal over: an
  // inherited stdio is not an inherited environment, and this is the spawn
  // where the two are easiest to confuse.
  it.scoped("extendEnv: false holds for the inherited child as well", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const file = `${dir}/env`;
      process.env["BESSEMER_LEAK_CANARY"] = "leaked";
      try {
        yield* execInteractive(
          "node",
          "-e",
          'require("node:fs").writeFileSync(process.argv[1], process.env.BESSEMER_LEAK_CANARY ?? "ABSENT")',
          file,
        );
        expect(yield* fs.readFileString(file)).toBe("ABSENT");
      } finally {
        delete process.env["BESSEMER_LEAK_CANARY"];
      }
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.effect("a missing editor binary fails with a typed ExecError", () =>
    Effect.gen(function* () {
      const outcome = yield* Effect.either(execInteractive("bessemer-no-such-editor-xyz"));
      expect(Either.isLeft(outcome)).toBe(true);
      if (Either.isLeft(outcome)) {
        expect(outcome.left._tag).toBe("ExecError");
      }
    }).pipe(Effect.provide(NodeContext.layer)),
  );
});
