// Where the agent's credential comes from — asked once, for the whole tool
// (T23). Two readers ask it: `doctor`'s probe 3, which reports whether a
// dispatch could authenticate, and the dispatch itself, which hands the value
// to the `docker` child so the agent CLI inside the container can. Before this
// module they each decided for themselves — the probe read `<root>/.env` first
// and accepted either name, the run read `process.env` for one of them, and
// **nothing loaded the file** — so a host that put the token exactly where
// `doctor` said to got a green row and an agent that could not log in, three
// held resources and a container start later.
//
// A module and not a tag, for the chokepoint's reason (`internal/exec.ts`): a
// tag here would recreate the `Shell.exec` anti-pattern. It reads the host, so
// it is called from the composition root and reaches commands as a parameter
// (AGENTS.md).
//
// The root both readers hand it is `<repoRoot>/.speepobox/.env` — the served
// repo's speepobox directory, beside the `config.toml` the advice below names
// (T58, 19 §3). Three places are deliberately *not* read. Not the package: the
// clone-run shim re-clones its cache on every repin, and one cache serves
// every repo the operator dispatches for, so a token there would be lost on a
// repin and shared across repos until it was. Not the served repo's own
// top-level `.env`: that file belongs to the application, and in any repo that
// is not hae it means something else entirely. Not any user-level file: the
// token belongs to a person, and a person who exports
// `CLAUDE_CODE_OAUTH_TOKEN` in their shell profile already has the user-level
// answer — it is the second provider below.
import type { FileSystem } from "@effect/platform";
import { Path, PlatformConfigProvider } from "@effect/platform";
import { Config, ConfigProvider, Effect, Option, Redacted } from "effect";

// The two names the agent CLI answers to, in the order they are tried — the
// order probe 3 has always tried them in. `ANTHROPIC_API_KEY` stays accepted
// because the probe has promised since T1 that it works: dropping it silently
// would break a host that took that promise at its word. The resolver answers
// with the name it *found*, so the container is handed the variable the CLI
// will actually look for rather than a canonical one it will not.
export const CREDENTIAL_NAMES: ReadonlyArray<string> = [
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
];

// The one piece of advice a host with no credential gets, wherever it meets
// the refusal: probe 3's row and the dispatch guard say the same sentence,
// because there is now one answer behind both of them.
export const CREDENTIAL_ADVICE =
  "no LLM API credential — run `claude setup-token`, put the token in CLAUDE_CODE_OAUTH_TOKEN in .env beside config.toml";

// The file that advice names, spelled once: the resolver joins it to the root
// it is handed, and probe 3's row names the same path back.
export const CREDENTIAL_FILENAME = ".env";

// What the resolver answers with: which name carried the credential, the
// value under it, and which of the two places it came from. `Redacted` rather
// than a string, and it stays redacted all the way to the spawn — a value
// interpolated into a command, an event, or a log renders as `<redacted>`. Two
// `Redacted.value` calls exist in the package and no more: the emptiness check
// below, which looks at a length and keeps nothing, and `internal/exec.ts`
// building one child's environment, which is the only place the token is
// written out at all.
//
// `source` exists so a row can say where the answer came from without saying
// what it is: probe 3 names the file or the environment, and T62's roots row
// prints the same field. It is the place and never the value — the path may
// appear, the token never does.
export type CredentialSource = "file" | "environment";

export interface AgentCredential {
  readonly name: string;
  readonly value: Redacted.Redacted<string>;
  readonly source: CredentialSource;
}

// `<root>/.env` first — the root being the served repo's speepobox directory,
// which is the caller's answer and not this module's — then the process
// environment: the precedence probe 3 already had, kept because it is the
// advice the tool gives and hosts follow it. Each name is asked of the two
// providers **in turn** rather than of one merged provider, so the resolver
// knows which one answered; the order is the one the merged provider gave, per
// name, so a `CLAUDE_CODE_OAUTH_TOKEN` exported in the shell still beats an
// `ANTHROPIC_API_KEY` sitting in the file, exactly as before.
//
// `process.env` is never written: sourcing the file into this process would
// hand the token to every child this package spawns, which is what
// `extendEnv: false` and the one-variable-at-a-time allowlist exist to prevent.
// An unreadable or absent `.env` is an empty provider and never a failure —
// the read-only slice degrades rather than dies (AGENTS.md), so `doctor` keeps
// rendering its rows on a host whose file cannot be opened.
export const resolveCredential = (
  root: string,
  env: ConfigProvider.ConfigProvider = ConfigProvider.fromEnv(),
): Effect.Effect<Option.Option<AgentCredential>, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const dotEnv = yield* PlatformConfigProvider.fromDotEnv(
      path.join(root, CREDENTIAL_FILENAME),
    ).pipe(Effect.orElseSucceed(() => ConfigProvider.fromMap(new Map())));
    const providers = [
      { source: "file", provider: dotEnv },
      { source: "environment", provider: env },
    ] as const;
    for (const name of CREDENTIAL_NAMES) {
      for (const { source, provider } of providers) {
        const found = yield* Config.option(Config.redacted(name)).pipe(
          Effect.withConfigProvider(provider),
          Effect.orElseSucceed(() => Option.none<Redacted.Redacted<string>>()),
        );
        if (Option.isNone(found)) {
          continue;
        }
        // A declared-but-empty variable is a host that unset it, not a
        // credential: `CLAUDE_CODE_OAUTH_TOKEN=` in a file would otherwise pass
        // every check here and fail inside the container. It is still this
        // name's *answer*, so what is asked next is the next name and not the
        // environment — the file beat the environment under this name, which is
        // what the merged provider did and what "unchanged" means here.
        if (Redacted.value(found.value).length > 0) {
          return Option.some<AgentCredential>({ name, value: found.value, source });
        }
        break;
      }
    }
    return Option.none<AgentCredential>();
  });
