// `status` (SPEC §7): one screen — what's running and who owns it, what just
// finished, where the PRs are. No docker state changes, no writes, no git
// commands. Reading the lock directory is a filesystem read, as the ledger's is.
//
// It is one of the three commands intercepted before flag parsing and before
// any preflight (03 §1.1), because it must work when the thing it inspects is
// broken. Each half therefore degrades on its own and the command never fails:
// daemon down still renders the ledger, an unreadable ledger still renders the
// containers, and neither available renders empty and says so — exit 0 in all
// three cases.
//
// It calls the subprocess chokepoint directly and does not go through
// `Sandbox`. Not merely because `Sandbox` does not exist until T3: `status`
// has to work when the world it inspects is broken, so it stays on the
// chokepoint after T3 too.
import { FileSystem } from "@effect/platform";
import type { CommandExecutor } from "@effect/platform/CommandExecutor";
import { Clock, Effect, Either, Option } from "effect";
import { BessemerConfig } from "../config/config.ts";
import { lockPathFor } from "../dispatch/plan.ts";
import { exec } from "../internal/exec.ts";
import { Ledger } from "../ledger/ledger.ts";
import { parsePid } from "../lock/liveness.ts";
import { ownershipFilterArgs } from "../ownership/labels.ts";
import { classify, type LockOnDisk, slugOfContainer } from "../reconcile/wreckage.ts";
import { Reporter } from "../reporter.ts";
import type { ContainerHalf, ContainerOwner, LedgerHalf, RunningContainer } from "./snapshot.ts";

export const DEFAULT_LIMIT = 10;

// `NAME<TAB>STATUS` rows from `docker ps`. Pure, and deliberately unfiltered:
// ownership was already decided by the label filter on the query itself, and
// re-checking the name here is the retired prefix sweep wearing a hat.
export type ContainerRow = Omit<RunningContainer, "owner">;

export const parseContainerRows = (stdout: string): ReadonlyArray<ContainerRow> =>
  stdout
    .split("\n")
    .filter((row) => row.trim() !== "")
    .map((row) => {
      const tab = row.indexOf("\t");
      return tab === -1
        ? { name: row.trim(), uptime: "" }
        : { name: row.slice(0, tab).trim(), uptime: row.slice(tab + 1).trim() };
    });

// Who owns a running container, asked of the reconciler's `classify` rather
// than of a predicate here (T138): `liveness.ts` is the one place the question
// is decided and `classify` is where it meets the lock and the container, so a
// second spelling — even a correct one — is the drift both exist to prevent.
// The sandbox is running because `docker ps` lists nothing else, and the
// checkout is absent because both branches that can apply return before
// `classify` reads it.
export const ownerOf = (
  container: ContainerRow,
  lock: Option.Option<LockOnDisk>,
): ContainerOwner => {
  const verdict = classify({
    slug: slugOfContainer(container.name),
    lock,
    // `classify` reads neither the id nor anything but `running` and the name.
    sandbox: Option.some({ id: "", name: container.name, running: true }),
    checkout: Option.none(),
  });
  if (verdict._tag === "Reclaimable") {
    return { _tag: "OwnerGone" };
  }
  // `Live` with a lock is a pid `classify` just proved alive; `Live` without
  // one is the running container no lock names. `Kept` needs a container that
  // is not running, so it cannot arise here, and it has no lock either.
  return Option.match(
    Option.flatMap(lock, (found) => found.owner),
    {
      onNone: () => ({ _tag: "NoLock" }) as const,
      onSome: (pid) => ({ _tag: "OwnedBy", pid }) as const,
    },
  );
};

// The slug's lock, read as the reconciler's `lockAt` reads it. Absent and
// unreadable alike are `None` — `status` never fails over a lock.
const lockFor = (
  runtimeRoot: string,
  container: ContainerRow,
): Effect.Effect<Option.Option<LockOnDisk>, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const file = lockPathFor(runtimeRoot, slugOfContainer(container.name));
    return yield* fs.readFileString(file).pipe(
      Effect.map((contents) => Option.some<LockOnDisk>({ path: file, owner: parsePid(contents) })),
      Effect.orElseSucceed(() => Option.none<LockOnDisk>()),
    );
  });

const containerHalf = (
  repoRoot: string,
): Effect.Effect<ContainerHalf, never, CommandExecutor | BessemerConfig | FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const result = yield* Effect.either(
      exec("docker", "ps", ...ownershipFilterArgs(repoRoot), "--format", "{{.Names}}\t{{.Status}}"),
    );
    if (Either.isLeft(result)) {
      return { _tag: "ContainersUnavailable", detail: "docker CLI not found" } as const;
    }
    if (result.right.exitCode !== 0) {
      return {
        _tag: "ContainersUnavailable",
        detail: "docker unavailable (daemon down?)",
      } as const;
    }
    const config = yield* BessemerConfig;
    const running = yield* Effect.forEach(parseContainerRows(result.right.stdout), (container) =>
      Effect.map(lockFor(config.runtimeRoot, container), (lock) => ({
        ...container,
        owner: ownerOf(container, lock),
      })),
    );
    return { _tag: "Containers", running } as const;
  });

const ledgerHalf = (limit: number): Effect.Effect<LedgerHalf, never, Ledger> =>
  Effect.gen(function* () {
    const ledger = yield* Ledger;
    // A ledger that cannot be read is a typed error the caller degrades on,
    // never a defect (AGENTS.md's outcome-row test). Undecodable individual
    // lines never reach here — the ledger skips them with a warning.
    const recent = yield* Effect.either(ledger.recent(limit));
    return Either.isLeft(recent)
      ? ({
          _tag: "LedgerUnavailable",
          detail: `ledger unavailable: ${recent.left.detail}`,
        } as const)
      : ({ _tag: "Runs", recent: recent.right } as const);
  });

export interface StatusOptions {
  // Resolved at the composition root: the label the container half filters on
  // must be the one T3 stamps, and `status` runs no git to find it.
  readonly repoRoot: string;
  readonly limit?: number;
}

export const status = (
  options: StatusOptions,
): Effect.Effect<
  void,
  never,
  Ledger | Reporter | CommandExecutor | BessemerConfig | FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const reporter = yield* Reporter;
    const limit = options.limit ?? DEFAULT_LIMIT;
    const containers = yield* containerHalf(options.repoRoot);
    const ledger = yield* ledgerHalf(limit);
    const renderedAt = yield* Clock.currentTimeMillis;
    yield* reporter.emit({
      _tag: "StatusReported",
      snapshot: { containers, ledger, limit, renderedAt },
    });
  });
