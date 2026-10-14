// `upgrade` (T128) against a real temporary served repo and a real temporary
// package repo whose `origin` is a local bare repo carrying the tags — no
// network. Only the `Reporter` is a fake: it collects the events so the
// report is asserted as a value; the renderer is asserted as a pure function.
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { FileSystem } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { Cause, Effect, Either, Exit, Layer, Option, Ref } from "effect";
import { renderFailure } from "../src/dispatch/render.ts";
import type { Release } from "../src/git/releases.ts";
import { exec } from "../src/internal/exec.ts";
import { Reporter, type ReporterEvent } from "../src/reporter.ts";
import { parseUpgradeArgv, UPGRADE_USAGE, UpgradeRefused } from "../src/upgrade/argv.ts";
import { INIT_DIFF_COMMAND, renderUpgrade } from "../src/upgrade/render.ts";
import type { UpgradeSnapshot } from "../src/upgrade/snapshot.ts";
import { upgrade } from "../src/upgrade/upgrade.ts";

const HAND = ["-c", "user.email=t@example.com", "-c", "user.name=Test"];

const git = (...args: ReadonlyArray<string>) =>
  exec("git", ...HAND, ...args).pipe(
    Effect.flatMap((result) =>
      result.exitCode === 0
        ? Effect.succeed(result.stdout.trim())
        : Effect.dieMessage(`git ${args.join(" ")}: ${result.stderr}`),
    ),
  );

// A package repo: an upstream with one commit per entry, each carrying the
// tags listed, a bare clone of it as `origin`, and a clone of that, which is
// `packageRepoRoot`. Answers the commit each entry made.
const packageRepo = (root: string, commits: ReadonlyArray<ReadonlyArray<string>>) =>
  Effect.gen(function* () {
    const upstream = join(root, "upstream");
    yield* git("init", "-q", "-b", "main", upstream);
    const shas: Array<string> = [];
    for (const [at, tags] of commits.entries()) {
      yield* git("-C", upstream, "commit", "-q", "--allow-empty", "-m", `c${at}`);
      shas.push(yield* git("-C", upstream, "rev-parse", "HEAD"));
      for (const tag of tags) {
        yield* git("-C", upstream, "tag", "-a", "-m", tag, tag);
      }
    }
    const bare = join(root, "origin.git");
    yield* git("clone", "-q", "--bare", upstream, bare);
    const clone = join(root, "package");
    yield* git("clone", "-q", bare, clone);
    return { packageRepoRoot: clone, shas };
  });

// A served repo with `config.toml` committed, so `git status` afterwards says
// exactly what upgrade changed. The file has CRLF lines and no trailing
// newline unless told otherwise, so "every other byte" is not vacuous.
const servedRepo = (root: string, config: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const repoRoot = join(root, "served");
    yield* git("init", "-q", "-b", "main", repoRoot);
    yield* fs.makeDirectory(join(repoRoot, ".bessemer"), { recursive: true });
    yield* fs.writeFileString(join(repoRoot, ".bessemer/config.toml"), config);
    yield* git("-C", repoRoot, "add", ".");
    yield* git("-C", repoRoot, "commit", "-q", "-m", "scaffold");
    return repoRoot;
  });

const configWith = (pinLine: string): string =>
  `﻿base = "origin/main"\r\n${pinLine}\nimage = "acme"\r\n# tool-sha = "nope"`;

const configIn = (repoRoot: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) =>
    Effect.map(fs.readFile(join(repoRoot, ".bessemer/config.toml")), (bytes) =>
      new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes),
    ),
  );

const run = (options: {
  readonly repoRoot: string;
  readonly packageRepoRoot: string;
  readonly argv?: ReadonlyArray<string>;
  readonly selfHosted?: boolean;
}) =>
  Effect.gen(function* () {
    const events = yield* Ref.make<ReadonlyArray<ReporterEvent>>([]);
    const exit = yield* upgrade({
      repoRoot: options.repoRoot,
      packageRepoRoot: options.packageRepoRoot,
      argv: options.argv ?? [],
      selfHosted: options.selfHosted ?? false,
    }).pipe(
      Effect.provide(
        Layer.succeed(Reporter, {
          emit: (event) => Ref.update(events, (current) => [...current, event]),
        }),
      ),
      Effect.exit,
    );
    return { exit, events: yield* Ref.get(events) };
  });

const reported = (events: ReadonlyArray<ReporterEvent>): UpgradeSnapshot => {
  const event = events.find((e) => e._tag === "UpgradeReported");
  if (event?._tag !== "UpgradeReported") {
    throw new Error("no UpgradeReported event");
  }
  return event.snapshot;
};

const refusalOf = (exit: Exit.Exit<void, UpgradeRefused>): string =>
  Exit.match(exit, {
    onSuccess: () => {
      throw new Error("expected a refusal");
    },
    onFailure: (cause) => Option.getOrThrow(Cause.failureOption(cause)).detail,
  });

const scratch = Effect.flatMap(FileSystem.FileSystem, (fs) => fs.makeTempDirectoryScoped());

const provideReal = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(NodeContext.layer));

// One fixture per case: the releases upstream and the pin line the served
// repo starts from, which may name a commit of the package repo by index.
const fixture = (
  commits: ReadonlyArray<ReadonlyArray<string>>,
  pinLine: (shas: ReadonlyArray<string>) => string,
) =>
  Effect.gen(function* () {
    const root = yield* scratch;
    const pkg = yield* packageRepo(root, commits);
    const before = configWith(pinLine(pkg.shas));
    const repoRoot = yield* servedRepo(root, before);
    return { root, repoRoot, before, ...pkg };
  }).pipe(Effect.orDie);

const pinOf = (sha: string) => `tool-sha = "${sha}"`;

const UNTAGGED = "0123456789abcdef0123456789abcdef01234567";

// What `git status` says changed in the served repo: nothing but the config,
// and nothing committed.
const statusOf = (repoRoot: string) => git("-C", repoRoot, "status", "--porcelain");

describe("parseUpgradeArgv", () => {
  it("reads nothing as plain upgrade", () => {
    expect(parseUpgradeArgv([])).toEqual(Either.right({ to: Option.none() }));
  });

  it("reads --to vN", () => {
    expect(parseUpgradeArgv(["--to", "v3"])).toEqual(Either.right({ to: Option.some("v3") }));
  });

  it.each([
    [["--dry-run"], "unknown upgrade flag: --dry-run"],
    [["v2"], "unknown upgrade flag: v2"],
    [["--to"], "--to needs a value"],
    [["--to", "v1", "--to", "v2"], "--to given twice"],
    [["--to", "1"], "--to 1 is not a release name: a release is v and a number, as v3"],
    [["--to", "v01"], "--to v01 is not a release name: a release is v and a number, as v3"],
  ])("refuses %j with the usage line", (argv, detail) => {
    expect(parseUpgradeArgv(argv)).toEqual(
      Either.left(new UpgradeRefused({ detail: `${detail} (usage: ${UPGRADE_USAGE})` })),
    );
  });
});

const release = (tag: string, commit: string): Release => ({
  tag,
  number: Number(tag.slice(1)),
  commit,
});

describe("renderUpgrade", () => {
  const A = "a".repeat(40);
  const B = "b".repeat(40);

  it("names both ends of a move, then the drift check to run", () => {
    expect(
      renderUpgrade({
        _tag: "Pinned",
        to: release("v2", B),
        was: { _tag: "Release", release: release("v1", A) },
      }),
    ).toBe(
      [
        "pinned v2 (bbbbbbb), was v1 (aaaaaaa)",
        "",
        "Next: run this to see which scaffold files the new release's templates change:",
        `  ${INIT_DIFF_COMMAND}`,
        "Nothing was committed: commit .bessemer/config.toml when you are ready.",
      ].join("\n"),
    );
  });

  it("names a pin no release names by its short SHA, or as empty", () => {
    const line = (value: string) =>
      renderUpgrade({
        _tag: "Pinned",
        to: release("v1", B),
        was: { _tag: "NoRelease", value },
      }).split("\n")[0];
    expect(line(A)).toBe("pinned v1 (bbbbbbb), was aaaaaaa (no release)");
    expect(line("")).toBe('pinned v1 (bbbbbbb), was "" (no release)');
  });

  it("says a current pin is current", () => {
    expect(renderUpgrade({ _tag: "Unchanged", release: release("v2", B), explicit: false })).toBe(
      "pinned v2 (bbbbbbb), the latest release: the pin is current — nothing was written",
    );
    expect(renderUpgrade({ _tag: "Unchanged", release: release("v2", B), explicit: true })).toBe(
      "already pinned v2 (bbbbbbb) — nothing was written",
    );
  });
});

describe("upgrade", () => {
  it.scoped("moves a pin at v1 to v2, rewriting that line alone", () =>
    provideReal(
      Effect.gen(function* () {
        const f = yield* fixture([["v1"], ["v2"]], (shas) => pinOf(shas[0]!));
        const { exit, events } = yield* run(f);
        expect(Exit.isSuccess(exit)).toBe(true);
        expect(yield* configIn(f.repoRoot)).toBe(configWith(pinOf(f.shas[1]!)));
        const snapshot = reported(events);
        expect(snapshot).toEqual({
          _tag: "Pinned",
          to: release("v2", f.shas[1]!),
          was: { _tag: "Release", release: release("v1", f.shas[0]!) },
        });
        const rendered = renderUpgrade(snapshot);
        expect(rendered).toContain(
          `pinned v2 (${f.shas[1]!.slice(0, 7)}), was v1 (${f.shas[0]!.slice(0, 7)})`,
        );
        expect(rendered).toContain(INIT_DIFF_COMMAND);
        // Nothing committed: the config is the one change, and it is unstaged.
        expect(yield* statusOf(f.repoRoot)).toBe("M .bessemer/config.toml");
        expect(yield* git("-C", f.repoRoot, "rev-list", "--count", "HEAD")).toBe("1");
      }),
    ),
  );

  it.scoped("says a pin at the latest release is current and writes nothing", () =>
    provideReal(
      Effect.gen(function* () {
        const f = yield* fixture([["v1"], ["v2"]], (shas) => pinOf(shas[1]!));
        const { exit, events } = yield* run(f);
        expect(Exit.isSuccess(exit)).toBe(true);
        expect(reported(events)).toEqual({
          _tag: "Unchanged",
          release: release("v2", f.shas[1]!),
          explicit: false,
        });
        expect(yield* configIn(f.repoRoot)).toBe(f.before);
        expect(yield* statusOf(f.repoRoot)).toBe("");
      }),
    ),
  );

  it.scoped("reads a pin on a commit tagged v2 and v3 as v3", () =>
    provideReal(
      Effect.gen(function* () {
        const f = yield* fixture([["v1"], ["v2", "v3"]], (shas) => pinOf(shas[1]!));
        const { events } = yield* run(f);
        expect(reported(events)).toEqual({
          _tag: "Unchanged",
          release: release("v3", f.shas[1]!),
          explicit: false,
        });
      }),
    ),
  );

  it.scoped.each([
    { name: "an untagged full pin", pinLine: pinOf(UNTAGGED), shown: "0123456" },
    { name: "an empty pin", pinLine: 'tool-sha = ""', shown: '""' },
    { name: "a short pin", pinLine: 'tool-sha = "abc1234"', shown: "abc1234" },
  ])("refuses $name on plain upgrade, naming --to vN", ({ pinLine, shown }) =>
    provideReal(
      Effect.gen(function* () {
        const f = yield* fixture([["v1"], ["v2"]], () => pinLine);
        const { exit, events } = yield* run(f);
        expect(refusalOf(exit)).toBe(
          `pin ${shown} is no release; \`upgrade --to vN\` pins one explicitly — nothing was written`,
        );
        expect(events).toEqual([]);
        expect(yield* configIn(f.repoRoot)).toBe(f.before);
      }),
    ),
  );

  it.scoped("rolls back with --to v1 from v2", () =>
    provideReal(
      Effect.gen(function* () {
        const f = yield* fixture([["v1"], ["v2"]], (shas) => pinOf(shas[1]!));
        const { exit, events } = yield* run({ ...f, argv: ["--to", "v1"] });
        expect(Exit.isSuccess(exit)).toBe(true);
        expect(yield* configIn(f.repoRoot)).toBe(configWith(pinOf(f.shas[0]!)));
        expect(reported(events)).toMatchObject({ _tag: "Pinned", to: { tag: "v1" } });
      }),
    ),
  );

  it.scoped.each([
    { name: "an empty line", pinLine: 'tool-sha = ""', value: "" },
    { name: "a short line", pinLine: 'tool-sha  =  "abc1234"', value: "abc1234" },
  ])("rewrites $name with --to v1", ({ pinLine, value }) =>
    provideReal(
      Effect.gen(function* () {
        const f = yield* fixture([["v1"], ["v2"]], () => pinLine);
        const { events } = yield* run({ ...f, argv: ["--to", "v1"] });
        expect(yield* configIn(f.repoRoot)).toBe(configWith(pinOf(f.shas[0]!)));
        expect(reported(events)).toEqual({
          _tag: "Pinned",
          to: release("v1", f.shas[0]!),
          was: { _tag: "NoRelease", value },
        });
      }),
    ),
  );

  it.scoped("says so and writes nothing when --to names the commit already pinned", () =>
    provideReal(
      Effect.gen(function* () {
        const f = yield* fixture([["v1"], ["v2"]], (shas) => pinOf(shas[0]!));
        const { events } = yield* run({ ...f, argv: ["--to", "v1"] });
        expect(reported(events)).toEqual({
          _tag: "Unchanged",
          release: release("v1", f.shas[0]!),
          explicit: true,
        });
        expect(yield* configIn(f.repoRoot)).toBe(f.before);
      }),
    ),
  );

  it.scoped("refuses --to a release that is not upstream, naming the latest", () =>
    provideReal(
      Effect.gen(function* () {
        const f = yield* fixture([["v1"], ["v2"]], (shas) => pinOf(shas[0]!));
        const { exit } = yield* run({ ...f, argv: ["--to", "v9"] });
        expect(refusalOf(exit)).toBe("v9 is not a release; the latest is v2 — nothing was written");
        expect(yield* configIn(f.repoRoot)).toBe(f.before);
      }),
    ),
  );

  it.scoped("refuses --to 1 before the network", () =>
    provideReal(
      Effect.gen(function* () {
        const f = yield* fixture([["v1"]], (shas) => pinOf(shas[0]!));
        // An origin that would fail if asked: the refusal is the argv's.
        const { exit } = yield* run({
          ...f,
          packageRepoRoot: join(f.root, "nowhere"),
          argv: ["--to", "1"],
        });
        expect(refusalOf(exit)).toContain("--to 1 is not a release name");
      }),
    ),
  );

  it.scoped("refuses when origin carries no release at all", () =>
    provideReal(
      Effect.gen(function* () {
        const f = yield* fixture([["bessemer-port-source"]], (shas) => pinOf(shas[0]!));
        const { exit } = yield* run(f);
        expect(refusalOf(exit)).toBe(
          "origin has no release (no vN tag) to pin; nothing to upgrade to — nothing was written",
        );
      }),
    ),
  );

  describe.each([
    ["no line", 'image-sha = "x"', "no tool-sha line in .bessemer/config.toml"],
    ["a malformed line", "tool-sha = 'abc'", "line 2 of .bessemer/config.toml is a tool-sha line"],
    [
      "a duplicated line",
      `${pinOf(UNTAGGED)}\n${pinOf(UNTAGGED)}`,
      "2 tool-sha lines in .bessemer/config.toml (line 2, line 3)",
    ],
  ])("on %s", (_, pinLine, sentence) => {
    it.scoped.each([{ argv: [] }, { argv: ["--to", "v1"] }])(
      "refuses $argv with the grammar's sentence",
      ({ argv }) =>
        provideReal(
          Effect.gen(function* () {
            const f = yield* fixture([["v1"]], () => pinLine);
            const { exit, events } = yield* run({ ...f, argv });
            expect(refusalOf(exit)).toContain(sentence);
            expect(events).toEqual([]);
            expect(yield* configIn(f.repoRoot)).toBe(f.before);
          }),
        ),
    );
  });

  it.scoped("refuses quoting git when origin is unreachable, writing nothing", () =>
    provideReal(
      Effect.gen(function* () {
        const f = yield* fixture([["v1"], ["v2"]], (shas) => pinOf(shas[0]!));
        const nowhere = join(f.root, "nowhere.git");
        yield* git("-C", f.packageRepoRoot, "remote", "set-url", "origin", nowhere);
        const { exit } = yield* run(f);
        expect(refusalOf(exit)).toBe(
          `upgrade could not read the releases from the package's origin: fatal: '${nowhere}' does not appear to be a git repository — nothing was written`,
        );
        expect(yield* configIn(f.repoRoot)).toBe(f.before);
      }),
    ),
  );

  it.scoped("refuses self-hosted before reading anything", () =>
    provideReal(
      Effect.gen(function* () {
        const root = yield* scratch;
        // Neither repo exists: anything read would fail differently.
        const repoRoot = join(root, "absent");
        const { exit } = yield* run({
          repoRoot,
          packageRepoRoot: repoRoot,
          selfHosted: true,
        });
        expect(refusalOf(exit)).toBe(
          `upgrade refused: ${repoRoot} is the repo bessemer itself lives in — its checked-out branch chooses the dispatcher, and there is no pin — nothing was written`,
        );
      }),
    ),
  );

  it("renders a refusal as one line", () => {
    expect(renderFailure(new UpgradeRefused({ detail: "pin x is no release" }))).toEqual(
      Option.some("!! pin x is no release"),
    );
  });
});
