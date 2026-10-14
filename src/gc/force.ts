// `gc --force` (SPEC §7, T100): what the listing said it would do, one slug at
// a time, under that slug's own lock.
//
// **Every slug is locked, then read again, then classified again.** The scan
// the listing was drawn from is a snapshot; the lock proves no live dispatch
// of ours owns the slug from here on, and the re-read under it catches what
// the lock cannot — a container that started running since the scan with no
// lock naming it, which may be another dispatcher's (SPEC §4). Acquiring goes
// through `RunLock.acquire`, as the reconciler's reclaim does, so a dead
// owner's file is evicted by T20's claim and T21's witness and never by a
// second arrangement of the two.
//
// **This is the one place a human clears another slug's checkout** — the
// reconciler reports every kept copy and touches none (T25, T28). It does so
// through the one salvage (`dispatch/checkout.ts`, narrowed by T98), and a
// directory goes only on `WentHome` or `Rescued`: the salvage asks the
// containment question after every fetch, so the removal is authorized by a
// read (T38). There is no fetch in this module.
//
// **The leftovers the listing marked dead are removed after their witness is
// asked again** (T109): a claim or an editor directory by the pid in its name,
// right before the removal, and an index by holding its slug's lock — inside
// the slug's own scope when the slug is in the loop, in a scope of its own
// when it is not. An index is never removed outside that lock. A pid-less
// editor directory has no witness to ask and holds the dispatcher's text, so
// it is a human's `rm -rf`.
//
// Logs are never touched: nothing here names `logs/`.
import { FileSystem, Path } from "@effect/platform";
import type { CommandExecutor } from "@effect/platform/CommandExecutor";
import { Effect, Option } from "effect";
import { BessemerConfig } from "../config/config.ts";
import { salvage } from "../dispatch/checkout.ts";
import { statusIndexPathFor } from "../dispatch/plan.ts";
import type { Git } from "../git/git.ts";
import { isProcessAlive } from "../lock/liveness.ts";
import { type LockClaim, RunLock } from "../lock/run-lock.ts";
import { editorDirPid } from "../prompt/editor.ts";
import { scanWreckage, sweepWitnesses, type WreckageScan } from "../reconcile/reconcile.ts";
import {
  type CheckoutOnDisk,
  classify,
  describeWreckage,
  type RunWreckage,
} from "../reconcile/wreckage.ts";
import { Reporter } from "../reporter.ts";
import { Sandbox } from "../sandbox/sandbox.ts";
import { parseClaimName } from "./names.ts";
import {
  checkoutRemovalFailed,
  detachedCheckoutNotice,
  keptSalvageNotice,
  leftoverAliveLine,
  leftoverRemovalFailed,
  removedLeftoverLine,
  rescuedLine,
  skipLine,
  unwitnessedEditorNotice,
  wentHomeLine,
} from "./notices.ts";
import type { GcLeftover, GcLeftoverKind } from "./snapshot.ts";

// How many removals failed: the one thing that sets gc's nonzero exit (§5,
// bash's `GC_FAILED`). A skip is gc working, and counts nothing.
type Failures = number;

export const reclaimAll = (
  repoRoot: string,
  scan: WreckageScan,
  leftovers: ReadonlyArray<GcLeftover>,
): Effect.Effect<
  Failures,
  never,
  | Sandbox
  | RunLock
  | Git
  | BessemerConfig
  | Reporter
  | CommandExecutor
  | FileSystem.FileSystem
  | Path.Path
> =>
  Effect.gen(function* () {
    const reporter = yield* Reporter;
    const fs = yield* FileSystem.FileSystem;
    const sandbox = yield* Sandbox;
    const runLock = yield* RunLock;
    const config = yield* BessemerConfig;
    const path = yield* Path.Path;

    const report = (detail: string): Effect.Effect<void> =>
      reporter.emit({ _tag: "Warned", detail });

    const removeSandbox = (found: RunWreckage): Effect.Effect<Failures> =>
      Option.match(found.sandbox, {
        onNone: () => Effect.succeed(0),
        onSome: (container) =>
          sandbox.remove({ name: container.name, id: container.id }).pipe(
            Effect.matchEffect({
              onSuccess: () =>
                report(`reclaimed the container '${container.name}'`).pipe(Effect.as(0)),
              onFailure: (error) =>
                report(`${error.detail} — it is still on this host, and still labelled ours`).pipe(
                  Effect.as(1),
                ),
            }),
          ),
      });

    // Only ever called once the leftover's witness was asked again.
    const removeLeftover = (kind: GcLeftoverKind, file: string): Effect.Effect<Failures> =>
      fs.remove(file, { recursive: kind === "editor", force: true }).pipe(
        Effect.matchEffect({
          onSuccess: () => report(removedLeftoverLine(kind, file)).pipe(Effect.as(0)),
          onFailure: (error) =>
            report(leftoverRemovalFailed(file, error.message)).pipe(Effect.as(1)),
        }),
      );

    // Only ever called under the slug's lock, which is the index's witness:
    // it is written under that lock and nowhere else (`land.ts`).
    const removeIndex = (slug: string): Effect.Effect<Failures> => {
      const index = statusIndexPathFor(config.runtimeRoot, slug);
      return fs.exists(index).pipe(
        Effect.matchEffect({
          onSuccess: (exists) => (exists ? removeLeftover("index", index) : Effect.succeed(0)),
          onFailure: (error) =>
            report(leftoverRemovalFailed(index, error.message)).pipe(Effect.as(1)),
        }),
      );
    };

    // A claim or an editor directory: the pid in its name, asked again right
    // before the removal. The listing's `dead` is a snapshot.
    const removeWitnessed = (leftover: GcLeftover): Effect.Effect<Failures> => {
      const name = path.basename(leftover.path);
      const pid =
        leftover.kind === "claim"
          ? Option.map(parseClaimName(name), (claim) => claim.pid)
          : editorDirPid(name);
      if (leftover.state === "unwitnessed" || Option.isNone(pid)) {
        return report(unwitnessedEditorNotice(leftover.path)).pipe(Effect.as(0));
      }
      return isProcessAlive(pid.value)
        ? report(leftoverAliveLine(leftover.path, pid.value)).pipe(Effect.as(0))
        : removeLeftover(leftover.kind, leftover.path);
    };

    // Only ever called once the salvage has said where the commits are.
    const removeCopy = (
      checkout: CheckoutOnDisk,
      landed: string,
      done: string,
    ): Effect.Effect<Failures> =>
      fs.remove(checkout.path, { recursive: true, force: true }).pipe(
        Effect.matchEffect({
          onSuccess: () => report(done).pipe(Effect.as(0)),
          onFailure: (error) =>
            report(checkoutRemovalFailed(checkout.path, landed, error.message)).pipe(Effect.as(1)),
        }),
      );

    // §3: the branch comes off the copy's `.git/HEAD` as the scan read it.
    // The salvage itself never recreates a branch (T107).
    const salvageCheckout = (found: RunWreckage): Effect.Effect<Failures, never, Git> =>
      Option.match(found.checkout, {
        onNone: () => Effect.succeed(0),
        onSome: (checkout) =>
          Option.match(checkout.branch, {
            onNone: () => report(detachedCheckoutNotice(found.slug, checkout)).pipe(Effect.as(0)),
            onSome: (branch) =>
              Effect.gen(function* () {
                const salvaged = yield* salvage({ branch, checkoutPath: checkout.path }, repoRoot);
                switch (salvaged._tag) {
                  case "WentHome":
                    return yield* removeCopy(checkout, branch, wentHomeLine(found.slug, branch));
                  case "Rescued":
                    return yield* removeCopy(
                      checkout,
                      salvaged.onto,
                      rescuedLine(found.slug, branch, salvaged.onto, salvaged.because),
                    );
                  case "Kept":
                    yield* report(keptSalvageNotice(found.slug, checkout, branch, salvaged.why));
                    return 0;
                }
              }),
          }),
      });

    // Under the lock: read the slug again and classify it again. The lock on
    // disk is now ours, so it is not what the verdict is asked about — what
    // stands in for it is what acquisition found: a dead owner's lock it
    // evicted, or none.
    const underLock = (
      slug: string,
      claim: LockClaim,
    ): Effect.Effect<
      Failures,
      never,
      Git | BessemerConfig | Reporter | CommandExecutor | FileSystem.FileSystem | Path.Path
    > =>
      Effect.gen(function* () {
        const again = yield* scanWreckage(repoRoot);
        if (Option.isNone(again.containers)) {
          yield* report(
            skipLine(slug, "dockerd stopped answering, so its liveness cannot be re-verified"),
          );
          return 0;
        }
        const fresh: RunWreckage = {
          slug,
          sandbox: Option.none(),
          checkout: Option.none(),
          ...again.wreckage.find((found) => found.slug === slug),
          lock: claim.reclaimed
            ? Option.some({ path: claim.path, owner: Option.none() })
            : Option.none(),
        };
        const verdict = classify(fresh);
        if (verdict._tag === "Live") {
          yield* report(skipLine(slug, verdict.detail));
          return 0;
        }
        yield* report(`reclaiming '${slug}': ${describeWreckage(fresh)}`);
        // Release order: the sandbox, then the checkout, then the lock, which
        // leaves with the scope.
        const sandboxFailures = yield* removeSandbox(fresh);
        const checkoutFailures = yield* salvageCheckout(fresh);
        // Before the lock leaves: the index is removed under it.
        const indexFailures = yield* removeIndex(slug);
        return sandboxFailures + checkoutFailures + indexFailures;
      });

    // Where the reconciler runs it: once, before anything tries to evict.
    yield* sweepWitnesses(scan);

    const failures = yield* Effect.forEach(scan.wreckage, (found) => {
      const verdict = classify(found);
      if (verdict._tag === "Live") {
        return report(skipLine(found.slug, verdict.detail)).pipe(Effect.as(0));
      }
      return Effect.scoped(
        runLock.acquire(found.slug).pipe(Effect.flatMap((claim) => underLock(found.slug, claim))),
      ).pipe(
        Effect.catchAll((error) => report(skipLine(found.slug, error.detail)).pipe(Effect.as(0))),
      );
    });

    // An index whose slug the loop did not visit: a run that released
    // normally after `markLanded`'s own removal failed. Its own lock, in its
    // own scope, and a lock it cannot take skips it loudly.
    const inLoop = new Set(scan.wreckage.map((found) => found.slug));
    const indexFailures = yield* Effect.forEach(
      leftovers.flatMap((leftover) =>
        leftover.kind === "index"
          ? Option.toArray(Option.filter(leftover.slug, (slug) => !inLoop.has(slug)))
          : [],
      ),
      (slug) =>
        Effect.scoped(runLock.acquire(slug).pipe(Effect.flatMap(() => removeIndex(slug)))).pipe(
          Effect.catchAll((error) => report(skipLine(slug, error.detail)).pipe(Effect.as(0))),
        ),
    );

    const leftoverFailures = yield* Effect.forEach(
      leftovers.filter((leftover) => leftover.kind !== "index"),
      removeWitnessed,
    );

    return [...failures, ...indexFailures, ...leftoverFailures].reduce(
      (total, count) => total + count,
      0,
    );
  });
