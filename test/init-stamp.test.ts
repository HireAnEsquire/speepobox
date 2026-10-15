// The templates and their stamps (T113). The stamp module is pure and asserted
// as values; the templates are read off disk from the package, because what
// ships is the subject. The tracked-issues pin runs a real `git check-ignore`
// against the rendered `.gitignore` in a throwaway repo: whether a path is
// ignored is git's answer, and a pattern read by eye is the thing that fails.
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { FileSystem } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { Effect, Either, Option } from "effect";
import { findRepoRoot, packageRoot } from "../src/config/paths.ts";
import {
  bodyDigest,
  CONFIG_PLACEHOLDERS,
  readStamp,
  SHIM,
  STAMPED_TEMPLATES,
  type StampedTemplate,
  stamp,
  substitute,
  TEMPLATE_VERSIONS,
  type TemplateName,
} from "../src/init/stamp.ts";
import { exec } from "../src/internal/exec.ts";

const templates = join(packageRoot, "templates");

const readTemplate = (name: TemplateName) =>
  FileSystem.FileSystem.pipe(Effect.flatMap((fs) => fs.readFileString(join(templates, name))));

const stamped = (name: TemplateName) =>
  readTemplate(name).pipe(Effect.map((text) => stamp(name, TEMPLATE_VERSIONS[name], text)));

describe("the templates", () => {
  it.effect("ship all five, and none of them carries a stamp", () =>
    Effect.gen(function* () {
      for (const name of Object.keys(TEMPLATE_VERSIONS) as ReadonlyArray<TemplateName>) {
        const text = yield* readTemplate(name);
        expect(text.length).toBeGreaterThan(0);
        expect(readStamp(text)).toEqual(Option.none());
      }
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.effect("stamp and read back, from the one version table, pristine until edited", () =>
    Effect.gen(function* () {
      for (const name of STAMPED_TEMPLATES) {
        const text = yield* stamped(name);
        const read = Option.getOrThrow(readStamp(text));
        expect(read).toEqual({
          name,
          version: TEMPLATE_VERSIONS[name],
          digest: bodyDigest(yield* readTemplate(name)),
        });
        expect(bodyDigest(text)).toBe(read.digest);
        expect(bodyDigest(`${text}# an adopter's line\n`)).not.toBe(read.digest);
      }
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.effect("the Dockerfile declares what it must", () =>
    Effect.gen(function* () {
      const text = yield* readTemplate("image/Dockerfile");
      expect(text).toContain("ARG BASE_IMAGE=debian:bookworm-slim");
      expect(text).toContain("ARG CLAUDE_CODE_VERSION=2.1.282");
      expect(text).toContain(
        'curl -fsSL https://claude.ai/install.sh | bash -s "$CLAUDE_CODE_VERSION"',
      );
      expect(text).toContain('ENV PATH="/home/agent/.local/bin:$PATH"');
      expect(text).toContain("ARG AGENT_UID");
      expect(text).toContain("ARG AGENT_GID");
      expect(text).toContain('ENTRYPOINT ["sleep", "infinity"]');
      // The model is the adopter's to choose: named, commented, never set.
      expect(text).toMatch(/^# ENV ANTHROPIC_MODEL=<model id>$/m);
      expect(text).not.toMatch(/^ENV ANTHROPIC_MODEL/m);
      expect(text).not.toMatch(/^\s+sudo\b/m);
      // Root setup is a pattern the README describes, offered commented out:
      // the template builds as if it were not there (T136).
      expect(text).toContain('"Setup that needs root" in speepobox\'s README');
      expect(text).toMatch(/^# COPY root-setup\.sh /m);
      expect(text).not.toMatch(/^[^#].*sudo/m);
      expect(text).not.toMatch(/hae/i);
    }).pipe(Effect.provide(NodeContext.layer)),
  );
});

// The line a stamp landed on.
const stampAt = (text: string) => text.split("\n").findIndex((l) => l.startsWith("# speepobox-"));

describe("stamp", () => {
  it("goes on line 1 of a file with nothing that must stay first", () => {
    const text = stamp("image/inputs", 3, "# a comment\npath\n");
    expect(stampAt(text)).toBe(0);
    expect(readStamp(text)).toEqual(
      Option.some({ name: "image/inputs", version: 3, digest: bodyDigest("# a comment\npath\n") }),
    );
  });

  it("keeps a Dockerfile parser directive first, and the stamp after it", () => {
    const body = "# syntax=docker/dockerfile:1\n# escape=`\nFROM debian\n";
    const text = stamp("image/Dockerfile", 1, body);
    expect(text.split("\n")[0]).toBe("# syntax=docker/dockerfile:1");
    expect(stampAt(text)).toBe(2);
    expect(bodyDigest(text)).toBe(bodyDigest(body));
  });

  it("keeps a shebang on line 1", () => {
    const text = stamp("x", 1, "#!/bin/sh\necho hi\n");
    expect(text.split("\n")[0]).toBe("#!/bin/sh");
    expect(stampAt(text)).toBe(1);
  });

  it("removing its line gives back the text exactly, even without a final newline", () => {
    for (const body of ["", "a", "a\n", "# syntax=x", "#!/bin/sh"]) {
      const text = stamp("x", 1, body);
      expect(
        text
          .split("\n")
          .filter((l) => !l.startsWith("# speepobox-"))
          .join("\n"),
      ).toBe(body);
      expect(bodyDigest(text)).toBe(Option.getOrThrow(readStamp(text)).digest);
    }
  });

  it("is found on any line, and absent is none", () => {
    const text = stamp("x", 2, "a\n");
    expect(Option.isSome(readStamp(`one\ntwo\n${text}`))).toBe(true);
    expect(readStamp("no stamp here\n")).toEqual(Option.none());
    expect(readStamp("  # speepobox-template: x v1 sha256:0123456789ab\n")).toEqual(Option.none());
  });
});

describe("substitute", () => {
  const values = { image: "acme-speepobox", base: "origin/main", "tool-sha": "abc123" } as const;

  it.effect("fills every placeholder in the config template and leaves no {{", () =>
    Effect.gen(function* () {
      const text = yield* readTemplate("config.toml");
      for (const name of CONFIG_PLACEHOLDERS) expect(text).toContain(`{{${name}}}`);
      const out = Either.getOrThrow(substitute(text, values));
      expect(out).not.toContain("{{");
      expect(out).toContain('image = "acme-speepobox"');
      expect(out).toContain('base = "origin/main"');
      expect(out).toContain('tool-sha = "abc123"');
      expect(out).toContain('tasks-dir = ".speepobox/tasks"');
      expect(out).toContain('image-build-command = ".speepobox/speepobox image build"');
      for (const key of ["setup-hook", "sandbox-env-file", "cap-add"]) {
        expect(out).toMatch(new RegExp(`^# ${key} = `, "m"));
        expect(out).not.toMatch(new RegExp(`^${key} = `, "m"));
      }
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.effect("fails on any value missing", () =>
    Effect.gen(function* () {
      const text = yield* readTemplate("config.toml");
      for (const name of CONFIG_PLACEHOLDERS) {
        const { [name]: _, ...rest } = values;
        expect(Either.isLeft(substitute(text, rest))).toBe(true);
      }
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it("fails on an unknown placeholder, and on an unpaired brace", () => {
    expect(Either.isLeft(substitute('x = "{{nope}}"\n', values))).toBe(true);
    expect(Either.isLeft(substitute('x = "{{ image }}"\n', values))).toBe(true);
    expect(Either.isLeft(substitute('x = "{{image"\n', values))).toBe(true);
  });
});

// The tracked-issues pin (E8, MAP 2026-08-20): the rendered `.gitignore` must
// never ignore the tasks dir or `env.sandbox`, and must ignore the runtime
// state and the editor's session directories.
describe("the rendered .gitignore", () => {
  it.effect("ignores by name and leaves the tasks dir tracked, by real git check-ignore", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const repo = yield* fs.makeTempDirectoryScoped();
      yield* exec("git", "init", "-q", repo);
      yield* fs.makeDirectory(join(repo, ".speepobox"));
      yield* fs.writeFileString(
        join(repo, ".speepobox", ".gitignore"),
        yield* stamped(".gitignore"),
      );
      const ignored = (path: string) =>
        exec("git", "-C", repo, "check-ignore", "-q", "--no-index", path).pipe(
          Effect.map((result) => result.exitCode === 0),
        );
      for (const path of [
        ".speepobox/tasks/some-feature/issues/T1-x.md",
        ".speepobox/tasks/spec.md",
        ".speepobox/env.sandbox",
        // Runtime state is anchored to the top level (T119): an issue folder
        // holding a file of the same name is still tracked.
        ".speepobox/tasks/f/logs/x.md",
        ".speepobox/tasks/f/locks/x.md",
        ".speepobox/tasks/f/checkouts/x.md",
        ".speepobox/tasks/f/runs.jsonl",
        ".speepobox/tasks/f/config.local.toml",
      ]) {
        expect([path, yield* ignored(path)]).toEqual([path, false]);
      }
      for (const path of [
        ".speepobox/feedback-edit-123-abc/f.txt",
        ".speepobox/.env",
        ".speepobox/logs/x.log",
        ".speepobox/locks/x",
        ".speepobox/checkouts/x/y",
        ".speepobox/runs.jsonl",
        ".speepobox/config.local.toml",
        // The credential is unanchored on purpose: never committed from anywhere.
        ".speepobox/tasks/f/.env",
        // A refresh killed before its rename (T147), at the top level and under image/.
        ".speepobox/speepobox.refresh",
        ".speepobox/image/Dockerfile.refresh",
      ]) {
        expect([path, yield* ignored(path)]).toEqual([path, true]);
      }
    }).pipe(Effect.scoped, Effect.provide(NodeContext.layer)),
  );
});

// This repo's own scaffold, stamped by hand (T112): each file carries the
// *template's* stamp, so `init --diff` reads it as current, and the Dockerfile
// and `.gitignore` are edited — never pristine, which `--diff` would call safe
// to replace, losing the node base.
const pin = (text: string) => /^ARG CLAUDE_CODE_VERSION=(\S+)$/m.exec(text)?.[1];
const entries = (text: string) =>
  text.split("\n").filter((line) => line.trim() !== "" && !line.startsWith("#"));

describe("this repo's hand-stamped scaffold", () => {
  const speepobox = join(findRepoRoot(packageRoot), ".speepobox");
  const ownFile = (name: StampedTemplate) =>
    FileSystem.FileSystem.pipe(Effect.flatMap((fs) => fs.readFileString(join(speepobox, name))));

  it.effect("carries the template's name, current version, and digest on every file", () =>
    Effect.gen(function* () {
      // This repo runs `node src/bin.ts`, not a shim (E12), so it carries none.
      for (const name of STAMPED_TEMPLATES.filter((template) => template !== SHIM)) {
        const text = yield* ownFile(name);
        expect([name, readStamp(text)]).toEqual([
          name,
          Option.some({
            name,
            version: TEMPLATE_VERSIONS[name],
            digest: bodyDigest(yield* readTemplate(name)),
          }),
        ]);
      }
      for (const name of [".gitignore", "image/Dockerfile"] as const) {
        const text = yield* ownFile(name);
        expect([name, bodyDigest(text)]).not.toEqual([
          name,
          Option.getOrThrow(readStamp(text)).digest,
        ]);
      }
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.effect("pins the template's CLI version, keeps the node base, and ignores what it does", () =>
    Effect.gen(function* () {
      const dockerfile = yield* ownFile("image/Dockerfile");
      expect(pin(dockerfile)).toBeDefined();
      expect(pin(dockerfile)).toBe(pin(yield* readTemplate("image/Dockerfile")));
      expect(dockerfile).toContain("ARG NODE_IMAGE=node:");

      const own = entries(yield* ownFile(".gitignore"));
      for (const entry of entries(yield* readTemplate(".gitignore"))) {
        expect(own).toContain(entry);
      }
    }).pipe(Effect.provide(NodeContext.layer)),
  );
});
