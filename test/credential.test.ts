// The one resolver both readers use (T23): `doctor`'s probe 3 and the dispatch
// that hands the value to the `docker` child. Its whole subject is *where* a
// credential may come from and *which name* carried it, so every case here is
// a `.env` fixture, an injected environment, or neither — and none of them
// touches `process.env`, which the resolver must never read around or write.
import { describe, expect, it } from "@effect/vitest";
import { FileSystem, Path } from "@effect/platform";
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { ConfigProvider, Effect, Layer, Option, Redacted, type Scope } from "effect";
import {
  type AgentCredential,
  CREDENTIAL_NAMES,
  resolveCredential,
} from "../src/agent/credential.ts";
import { bessemerDir } from "../src/config/paths.ts";

const [OAUTH_TOKEN = "", API_KEY = ""] = CREDENTIAL_NAMES;

const platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);

// A scratch root, optionally holding a `.env` — the file `doctor` tells a host
// to write, beside `config.toml`.
const rootHolding = (
  dotEnv?: string,
): Effect.Effect<string, never, FileSystem.FileSystem | Path.Path | Scope.Scope> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped();
    if (dotEnv !== undefined) {
      yield* fs.writeFileString(path.join(root, ".env"), dotEnv);
    }
    return root;
  }).pipe(Effect.orDie);

const environment = (entries: Record<string, string>): ConfigProvider.ConfigProvider =>
  ConfigProvider.fromMap(new Map(Object.entries(entries)));

// What the assertions below are about: the name that was found, and the value
// under it — unwrapped here, at the one place a test is allowed to look.
const found = (credential: Option.Option<AgentCredential>): readonly [string, string] => {
  expect(Option.isSome(credential)).toBe(true);
  if (Option.isNone(credential)) {
    throw new Error("expected a credential");
  }
  return [credential.value.name, Redacted.value(credential.value.value)];
};

// Where the answer came from — the other half of what a row may say about a
// credential, and the only other thing the resolver knows about it.
const sourceOf = (credential: Option.Option<AgentCredential>): string => {
  expect(Option.isSome(credential)).toBe(true);
  if (Option.isNone(credential)) {
    throw new Error("expected a credential");
  }
  return credential.value.source;
};

describe("the credential resolver", () => {
  it.scoped(
    "finds a credential that is only in <root>/.env — the case doctor tells hosts to make",
    () =>
      Effect.gen(function* () {
        const root = yield* rootHolding(`${OAUTH_TOKEN}=from-the-file\n`);
        const credential = yield* resolveCredential(root, environment({}));
        expect(found(credential)).toEqual([OAUTH_TOKEN, "from-the-file"]);
      }).pipe(Effect.provide(platform)),
  );

  it.scoped("finds a credential that is only in the process environment", () =>
    Effect.gen(function* () {
      const root = yield* rootHolding();
      const credential = yield* resolveCredential(
        root,
        environment({ [OAUTH_TOKEN]: "from-the-shell" }),
      );
      expect(found(credential)).toEqual([OAUTH_TOKEN, "from-the-shell"]);
    }).pipe(Effect.provide(platform)),
  );

  // The precedence probe 3 already had, kept: the file beside `config.toml`
  // wins, because that is the advice the tool gives.
  it.scoped(".env wins over the inherited environment, under the same name", () =>
    Effect.gen(function* () {
      const root = yield* rootHolding(`${OAUTH_TOKEN}=from-the-file\n`);
      const credential = yield* resolveCredential(
        root,
        environment({ [OAUTH_TOKEN]: "from-the-shell" }),
      );
      expect(found(credential)).toEqual([OAUTH_TOKEN, "from-the-file"]);
    }).pipe(Effect.provide(platform)),
  );

  // Both names are honoured, and the resolver answers with the one it found —
  // the container is handed the variable the agent CLI will look for, never a
  // canonical name it will not.
  it.scoped("accepts ANTHROPIC_API_KEY and names it as the one that was found", () =>
    Effect.gen(function* () {
      const root = yield* rootHolding(`${API_KEY}=an-api-key\n`);
      const credential = yield* resolveCredential(root, environment({}));
      expect(found(credential)).toEqual([API_KEY, "an-api-key"]);
    }).pipe(Effect.provide(platform)),
  );

  // Name precedence is the outer loop and the two sources the inner one, so an
  // exported OAuth token beats an API key in the file — which is exactly what
  // probe 3 answered before there was a resolver, and what the merged provider
  // answered before the sources were asked one at a time (T58).
  it.scoped("tries CLAUDE_CODE_OAUTH_TOKEN before ANTHROPIC_API_KEY, across both sources", () =>
    Effect.gen(function* () {
      const root = yield* rootHolding(`${API_KEY}=an-api-key\n`);
      const credential = yield* resolveCredential(
        root,
        environment({ [OAUTH_TOKEN]: "an-oauth-token" }),
      );
      expect(found(credential)).toEqual([OAUTH_TOKEN, "an-oauth-token"]);
    }).pipe(Effect.provide(platform)),
  );

  // The answer carries *where* it came from (T58), so probe 3's row and the
  // roots row can name the place without naming the value. Each name is asked
  // of the two providers in turn, which is how the resolver knows.
  it.scoped("names the file as its source when the file carried the credential", () =>
    Effect.gen(function* () {
      const root = yield* rootHolding(`${OAUTH_TOKEN}=from-the-file\n`);
      const credential = yield* resolveCredential(
        root,
        environment({ [OAUTH_TOKEN]: "from-the-shell" }),
      );
      expect(sourceOf(credential)).toBe("file");
    }).pipe(Effect.provide(platform)),
  );

  it.scoped("names the environment as its source when the environment carried it", () =>
    Effect.gen(function* () {
      const root = yield* rootHolding(`${API_KEY}=an-api-key\n`);
      const credential = yield* resolveCredential(
        root,
        environment({ [OAUTH_TOKEN]: "an-oauth-token" }),
      );
      expect(sourceOf(credential)).toBe("environment");
    }).pipe(Effect.provide(platform)),
  );

  // The root the readers hand this resolver is the served repo's bessemer
  // directory (T58), so the file it finds is the one beside `config.toml` and
  // not the served repo's own top-level `.env` — that file belongs to the
  // application, and in any repo that is not hae it means something else.
  it.scoped("reads <repoRoot>/.bessemer/.env and not the repo's own top-level .env", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoRoot = yield* fs.makeTempDirectoryScoped();
      yield* fs.makeDirectory(bessemerDir(repoRoot));
      yield* fs.writeFileString(
        path.join(bessemerDir(repoRoot), ".env"),
        `${OAUTH_TOKEN}=from-the-bessemer-directory\n`,
      );
      yield* fs.writeFileString(path.join(repoRoot, ".env"), `${OAUTH_TOKEN}=from-the-repo\n`);
      const credential = yield* resolveCredential(bessemerDir(repoRoot), environment({}));
      expect(found(credential)).toEqual([OAUTH_TOKEN, "from-the-bessemer-directory"]);
    }).pipe(Effect.provide(platform)),
  );

  // The other half of that root, and the half the test above cannot show: with
  // nothing in the bessemer directory, a token in the repo's own top-level
  // `.env` is not found *at all* — not merely outranked. The resolver is never
  // handed the repo root and never walks up to it, so the file the application
  // owns is invisible here.
  it.scoped("answers None for a token that is only in the repo's own top-level .env", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoRoot = yield* fs.makeTempDirectoryScoped();
      yield* fs.makeDirectory(bessemerDir(repoRoot));
      yield* fs.writeFileString(path.join(repoRoot, ".env"), `${OAUTH_TOKEN}=from-the-repo\n`);
      const credential = yield* resolveCredential(bessemerDir(repoRoot), environment({}));
      expect(credential).toEqual(Option.none());
    }).pipe(Effect.provide(platform)),
  );

  it.scoped("answers None when there is no credential anywhere", () =>
    Effect.gen(function* () {
      const root = yield* rootHolding();
      expect(yield* resolveCredential(root, environment({}))).toEqual(Option.none());
    }).pipe(Effect.provide(platform)),
  );

  // A variable someone emptied is not a credential: it would pass every check
  // here and fail inside the container, which is the failure this ticket
  // exists to move to the door.
  it.scoped("reads a declared-but-empty variable as no credential at all", () =>
    Effect.gen(function* () {
      const root = yield* rootHolding(`${OAUTH_TOKEN}=\n`);
      expect(yield* resolveCredential(root, environment({}))).toEqual(Option.none());
      const fallback = yield* resolveCredential(
        root,
        environment({ [API_KEY]: "still-a-credential" }),
      );
      expect(found(fallback)).toEqual([API_KEY, "still-a-credential"]);
    }).pipe(Effect.provide(platform)),
  );

  // And an emptied variable is still that *name's* answer: the file beat the
  // environment under it, so what is asked next is the next name — which is
  // what the merged provider did before the two sources were asked one at a
  // time (T58). Without it, restructuring the loop would quietly promote a
  // token the file was written to suppress.
  it.scoped("an emptied variable in the file still shadows the same name in the environment", () =>
    Effect.gen(function* () {
      const root = yield* rootHolding(`${OAUTH_TOKEN}=\n`);
      const shadowed = yield* resolveCredential(
        root,
        environment({ [OAUTH_TOKEN]: "from-the-shell" }),
      );
      expect(shadowed).toEqual(Option.none());
    }).pipe(Effect.provide(platform)),
  );

  // The read-only slice degrades rather than dies (AGENTS.md): `doctor` runs
  // this on every invocation, so a root that is not a directory at all — the
  // shape an unreadable `.env` takes here — is an empty provider and never a
  // defect.
  it.scoped("degrades to the environment when .env cannot be read", () =>
    Effect.gen(function* () {
      const credential = yield* resolveCredential(
        "/nowhere/bessemer",
        environment({ [OAUTH_TOKEN]: "from-the-shell" }),
      );
      expect(found(credential)).toEqual([OAUTH_TOKEN, "from-the-shell"]);
    }).pipe(Effect.provide(platform)),
  );

  // The value crosses the package as a `Redacted`, so the shapes that spill a
  // secret — a template, a `JSON.stringify`, a thrown error's message — print
  // a placeholder instead. `Redacted.value` is the deliberate unwrap, and the
  // chokepoint is the only caller that writes what it returns anywhere — the
  // resolver's own call reads a length and keeps nothing.
  it.scoped("hands the value back redacted, so interpolating it spells nothing", () =>
    Effect.gen(function* () {
      const root = yield* rootHolding(`${OAUTH_TOKEN}=super-secret-token\n`);
      const credential = yield* resolveCredential(root, environment({}));
      expect(Option.isSome(credential)).toBe(true);
      if (Option.isSome(credential)) {
        expect(`${credential.value.value}`).not.toContain("super-secret-token");
        expect(JSON.stringify(credential.value)).not.toContain("super-secret-token");
        expect(Redacted.value(credential.value.value)).toBe("super-secret-token");
      }
    }).pipe(Effect.provide(platform)),
  );
});
