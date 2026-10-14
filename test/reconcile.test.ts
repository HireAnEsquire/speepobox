// The reconciler (SPEC §4, matrix row 17's reclaim half). Its liveness logic
// and its classification are plain functions with no tag, so the whole of
// "what may be reclaimed" is asserted here as values — the live tier owns only
// the label filter's selectivity (SPEC §11, case 4).
import { describe, expect, it } from "@effect/vitest";
import { FileSystem } from "@effect/platform";
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { Effect, Layer, Option, Ref } from "effect";
import { BessemerConfig, defaultConfig } from "../src/config/config.ts";
import { checkoutPathFor, LOCKS_DIRNAME, lockPathFor } from "../src/dispatch/plan.ts";
import { Ledger } from "../src/ledger/ledger.ts";
import { GitLive } from "../src/git/git.ts";
import { RunLock, RunLockLive } from "../src/lock/run-lock.ts";
import { evictorMarkerFor } from "../src/lock/witness.ts";
import { reconcile, scanWreckage } from "../src/reconcile/reconcile.ts";
import {
  branchInHead,
  classify,
  describeWreckage,
  dockerRows,
  isDebris,
  isEvictionWitness,
  keptCheckoutNotice,
  parseOwnedSandboxes,
  type RunWreckage,
  slugOfContainer,
  unmovedCheckoutNotice,
} from "../src/reconcile/wreckage.ts";
import { Reporter, type ReporterEvent } from "../src/reporter.ts";
import { SandboxLive } from "../src/sandbox/sandbox.ts";
import { type ScriptedResult, scriptedExecutor } from "./support/exec-fake.ts";

// Above Linux's pid_max, so `kill -0` can only answer "no such process" — the
// same dead pid `run-lock.test.ts` uses, for the same reason.
const DEAD_PID = 2147483647;

// An attempt number this process's own eviction counter cannot reach, so a
// marker a case places for the *live* pid — the only pid a test can prove
// alive — never lands on the path a real eviction is about to write.
const HELD_ATTEMPT = 100_000;

const wreck = (fields: Partial<RunWreckage> = {}): RunWreckage => ({
  slug: "bessemer-t8",
  lock: Option.none(),
  sandbox: Option.none(),
  checkout: Option.none(),
  ...fields,
});

const lock = (owner: Option.Option<number>) =>
  Option.some({ path: "/runtime/locks/bessemer-t8.pid", owner });

const container = (running: boolean) =>
  Option.some({ id: "d15c0ffee1d", name: "bessemer-bessemer-t8", running });

// The branch defaults to the one a `bessemer-t8` run would be on, because the
// notice's commands name it; the cases that assert the branchless form pass
// `Option.none()` explicitly.
const kept = (branch: Option.Option<string> = Option.some("bessemer-t8")) =>
  Option.some({ path: "/runtime/checkouts/bessemer-t8", branch });

describe("reading docker's stdout", () => {
  // §3b: one parse, trimming *before* it filters. The asymmetry it closes is a
  // query that tests a trimmed id and then uses the untrimmed one — it passes
  // its own filter and addresses a container by a string with a newline in it.
  it("trims every row before dropping the empty ones", () => {
    expect(dockerRows("a\n  b  \n\n   \nc\n")).toEqual(["a", "b", "c"]);
    expect(dockerRows("")).toEqual([]);
    expect(dockerRows("\n \n")).toEqual([]);
  });

  // The id every removal is addressed by comes out of here trimmed, because
  // the rows were trimmed before they were filtered — never the other way
  // round, which is how a query tests one value and uses another (§3b).
  it("reads id, name, and state, and carries no untrimmed id out", () => {
    expect(
      parseOwnedSandboxes(
        "  d15c0ffee1d\tbessemer-t8\trunning  \n0ddba11\tbessemer-t7\texited\n\n   \n",
      ),
    ).toEqual([
      { id: "d15c0ffee1d", name: "bessemer-t8", running: true },
      { id: "0ddba11", name: "bessemer-t7", running: false },
    ]);
  });

  // Split the safe way round: only the states that certainly mean stopped are
  // listed, so a word a future daemon invents is reported rather than deleted.
  it("counts created and dead as stopped, and anything unrecognized as running", () => {
    const states = parseOwnedSandboxes(
      ["a\tone\tcreated", "b\ttwo\tdead", "c\tthree\tpaused", "d\tfour\twhat-is-this"].join("\n"),
    );
    expect(states.map((sandbox) => sandbox.running)).toEqual([false, false, true, true]);
  });

  it("keys a container to its run by name, and never to its ownership", () => {
    expect(slugOfContainer("bessemer-bessemer-t8")).toBe("bessemer-t8");
    // Labelled ours under a name we did not derive: still ours to account for.
    expect(slugOfContainer("someone-elses-name")).toBe("someone-elses-name");
  });
});

describe("classifying one run's wreckage", () => {
  // Condition 2, and the case the whole ticket is written around: the lock
  // records a dispatch that is gone. The container is *still running* —
  // dockerd owns it and its entrypoint is `sleep infinity`, so nothing but
  // this reclaim will ever remove it (matrix row 17's `kill -9`).
  it("reclaims a run whose lock records a pid that is not alive", () => {
    expect(
      classify(
        wreck({
          lock: lock(Option.some(DEAD_PID)),
          sandbox: container(true),
          checkout: kept(),
        }),
      ),
    ).toEqual({ _tag: "Reclaimable" });
  });

  it("leaves a run whose lock records a live pid alone, and says which pid", () => {
    const verdict = classify(
      wreck({ lock: lock(Option.some(process.pid)), sandbox: container(true) }),
    );
    expect(verdict._tag).toBe("Live");
    expect(verdict._tag === "Live" && verdict.detail).toContain(`pid ${process.pid}`);
  });

  // An owner nobody can name reads as a pid that is gone (`liveness.ts`) —
  // and `claim.ts` means a lock is never published empty in the first place,
  // so a file that is is debris from something that never finished writing.
  it("reclaims a lock nobody can read an owner out of", () => {
    expect(classify(wreck({ lock: lock(Option.none()) }))).toEqual({ _tag: "Reclaimable" });
  });

  // Condition 3, and the only place it decides anything: no lock names this
  // container, so the dispatcher that started it may be one this process
  // cannot see — a second runtime root, or hae's bash `run.sh` on the same host.
  it("leaves a running container that no lock names alone", () => {
    const verdict = classify(wreck({ sandbox: container(true) }));
    expect(verdict._tag).toBe("Live");
    expect(verdict._tag === "Live" && verdict.detail).toContain("no lock names an owner");
  });

  it("reclaims a stopped container that no lock names", () => {
    expect(classify(wreck({ sandbox: container(false) }))).toEqual({ _tag: "Reclaimable" });
  });

  // Inverted from "reclaims a checkout left on its own", and the whole of this
  // ticket: the lock is the first resource a run takes and the last it
  // releases, so a run killed at any point leaves a lock beside its checkout.
  // A checkout with none is proof the release ran — and the release keeps a
  // directory only when the fetch-back would not fast-forward, which means the
  // run's commits are in there and that clone is the only copy of them.
  it("keeps a checkout with no lock beside it — the release ran and left it deliberately", () => {
    const verdict = classify(wreck({ checkout: kept() }));
    expect(verdict._tag).toBe("Kept");
    expect(verdict._tag === "Kept" && verdict.detail).toContain("could not be moved back");
  });

  // The notice, not the verdict: two states produce a kept copy and nothing on
  // disk tells them apart, so what it owes the reader is the command that
  // answers which — named against the branch the copy is actually on, never
  // against the slug, which `slugFor` has already flattened.
  it("hands over a recovery keyed to the branch the copy is on", () => {
    const notice = keptCheckoutNotice("feature-foo", {
      path: "/runtime/checkouts/feature-foo",
      branch: Option.some("feature/foo"),
    });
    expect(notice).toContain(
      "git fetch /runtime/checkouts/feature-foo refs/heads/feature/foo:refs/heads/feature/foo-from-run",
    );
    expect(notice).toContain("git log --oneline feature/foo..feature/foo-from-run");
    expect(notice).toContain("rm -rf /runtime/checkouts/feature-foo");
    // What a lone checkout means now that the release tries a second
    // destination (T29): not "the fetch would not fast-forward", but "neither
    // destination would take them, or the removal failed".
    expect(notice).toContain("onto a branch of\nthe run's own");
    expect(notice).toContain("neither of those would take the commits");
    expect(notice).toContain("could not be removed");
    // The slug is how the run is named, never how the ref is spelled.
    expect(notice).not.toContain("refs/heads/feature-foo:");
  });

  // A detached HEAD, or one this pass could not read: there is no ref to fetch
  // by name, so the commands ask the copy what it is on instead rather than
  // printing a branch that does not exist.
  it("falls back to a branchless recovery when HEAD names no branch", () => {
    const notice = keptCheckoutNotice("bessemer-t8", {
      path: "/runtime/checkouts/bessemer-t8",
      branch: Option.none(),
    });
    expect(notice).toContain("git fetch /runtime/checkouts/bessemer-t8 HEAD");
    expect(notice).toContain("git branch --contains FETCH_HEAD");
    expect(notice).not.toContain("refs/heads/");
  });

  // The reclaim's own notice (T38), which is about a different copy for a
  // different reason: this run was killed, so its release never moved
  // anything, and the sentence says what the read found rather than asserting
  // where the commits are. Same recovery underneath — what a reader does about
  // it does not depend on why it is there.
  it("says what the read found when it will not authorize a reclaim's removal", () => {
    const notice = unmovedCheckoutNotice(
      "bessemer-t8",
      { path: "/runtime/checkouts/bessemer-t8", branch: Option.some("bessemer-t8") },
      "'bessemer-t8' here does not hold abc1234, the commit that copy is on",
    );
    expect(notice).toContain("**not** removed");
    expect(notice).toContain("does not hold abc1234");
    // The recovery is the shared one, keyed to the branch the copy is on.
    expect(notice).toContain(
      "git fetch /runtime/checkouts/bessemer-t8 refs/heads/bessemer-t8:refs/heads/bessemer-t8-from-run",
    );
    expect(notice).toContain("rm -rf /runtime/checkouts/bessemer-t8");
    // And it claims nothing about where the commits are: that is the sentence
    // this ticket deleted.
    expect(notice).not.toContain("already home");
  });

  // `ref: refs/heads/<branch>` is what a clone on a branch writes; a detached
  // HEAD holds a bare SHA, which names no ref the fetch could use.
  it("reads a branch out of HEAD, and nothing out of a detached one", () => {
    expect(branchInHead("ref: refs/heads/feature/foo\n")).toEqual(Option.some("feature/foo"));
    expect(branchInHead("ref: refs/heads/bessemer-t8")).toEqual(Option.some("bessemer-t8"));
    expect(branchInHead("9fceb02d0ae598e95dc970b74767f19372d61af8\n")).toEqual(Option.none());
    expect(branchInHead("")).toEqual(Option.none());
  });

  // Whatever the container state: a stopped container is not evidence about a
  // directory the run chose to keep, and a running one was already refusing.
  it("keeps a lone checkout whatever dockerd still holds for it", () => {
    const directory = kept();
    expect(classify(wreck({ checkout: directory, sandbox: container(false) }))._tag).toBe("Kept");
    expect(classify(wreck({ checkout: directory, sandbox: container(true) }))._tag).toBe("Live");
  });

  // The narrowing stops at the lock: a checkout that still has one is the
  // `kill -9` wreck, and it is classified exactly as it was before.
  it("still reclaims a checkout whose lock records a pid that is not alive", () => {
    expect(
      classify(
        wreck({
          lock: lock(Option.some(DEAD_PID)),
          checkout: kept(),
        }),
      ),
    ).toEqual({ _tag: "Reclaimable" });
  });

  // §3c, as a shape rather than as a case: there is nowhere in this input to
  // put a ledger row, so "a wreck carrying an `Interrupted` row" and one
  // carrying no row are the *same value* and cannot be classified apart. A row
  // exists iff `RunLock` was acquired (SPEC §11) — not "and the run finished",
  // and the interrupted-mid-teardown run that writes its row and then keeps
  // all three resources is the common case, not a corner.
  it("classifies off the three conditions alone, with no ledger to consult", () => {
    const interrupted = wreck({
      lock: lock(Option.some(DEAD_PID)),
      sandbox: container(true),
      checkout: kept(),
    });
    expect(classify(interrupted)).toEqual(classify({ ...interrupted, slug: "no-row-at-all" }));
  });

  it("names what it found, in the order a run releases", () => {
    expect(
      describeWreckage(
        wreck({
          lock: lock(Option.some(DEAD_PID)),
          sandbox: container(false),
          checkout: kept(),
        }),
      ),
    ).toBe(
      "container 'bessemer-bessemer-t8', checkout /runtime/checkouts/bessemer-t8, lock /runtime/locks/bessemer-t8.pid",
    );
  });
});

describe("stranded eviction witnesses", () => {
  it("reads a witness by its shape, and takes nothing else for one", () => {
    expect(isEvictionWitness("bessemer-t8.pid.4321.evicting")).toBe(true);
    expect(isEvictionWitness("bessemer-t8.pid.unowned.evicting")).toBe(true);
    expect(isEvictionWitness("bessemer-t8.pid")).toBe(false);
    expect(isEvictionWitness("bessemer-t8.4321.claim")).toBe(false);
    expect(isEvictionWitness("bessemer-t8.pid.4321.evicting.99.1.evictor")).toBe(false);
    expect(isEvictionWitness(".evicting")).toBe(false);
  });

  // The rule, in the one sentence that covers both halves (T26): a witness
  // whose evictor is not alive is debris. No evictor at all is the killed
  // evictor of a `kill -9` mid-eviction — including T8's case, where the lock
  // had already gone before the evictor did.
  it("is debris when no live dispatch is evicting under it", () => {
    expect(isDebris({ path: "/locks/t8.pid.1.evicting", evictors: [] })).toBe(true);
    expect(isDebris({ path: "/locks/t8.pid.1.evicting", evictors: [DEAD_PID] })).toBe(true);
  });

  // The case that would hand one corpse to two dispatches: the evictor is
  // inside the bracket right now, and the witness is the whole of what keeps
  // the second dispatch out of it.
  it("leaves a witness a live evictor is standing behind alone", () => {
    expect(isDebris({ path: "/locks/t8.pid.1.evicting", evictors: [process.pid] })).toBe(false);
    // A dispatch that lost the link and was killed before it took its own
    // name back, lying beside the one that won: still an eviction in flight.
    expect(isDebris({ path: "/locks/t8.pid.1.evicting", evictors: [DEAD_PID, process.pid] })).toBe(
      false,
    );
  });
});

// The reconciler itself, over a real lock directory and a real checkout tree:
// "our fake removed it" is not "the wreckage is gone", and the whole point of
// this pass is the world it leaves behind. Only dockerd is scripted — the live
// tier owns the one question a fake cannot answer (SPEC §11, case 4).
const SLUG = "bessemer-t8";
const CONTAINER_ID = "d15c0ffee1d";

// How every command `Git` spawns opens (T27): the directory it runs in, and
// the repository it runs against.
const inRepo = (repo: string): string => `git -C ${repo} --git-dir=${repo}/.git`;

// What the branch resolves to inside a dead run's copy — the commit the
// removal's authorization is about (T38). A value of the copy's, never the
// repo's: the whole question is whether this repository holds it.
const COPY_TIP = "6666666666666666666666666666666666666666";

const dockerHolding = (state: string): Record<string, ScriptedResult> => ({
  "docker ps": { exit: 0, stdout: `  ${CONTAINER_ID}\tbessemer-${SLUG}\t${state}  \n\n` },
  "docker rm": { exit: 0 },
});

const dockerHoldingNothing: Record<string, ScriptedResult> = {
  "docker ps": { exit: 0, stdout: "\n" },
  "docker rm": { exit: 0 },
};

const world = (
  script: Record<string, ScriptedResult>,
  // What this repository answers when asked whether its branch holds the
  // commit a dead run's copy is on (T38) — git's own exit code, 0 for
  // contained and 1 for not. It is the only thing that authorizes the reclaim
  // to remove a checkout, so it is a parameter of the world rather than a
  // detail of one case.
  containment: ScriptedResult = { exit: 0 },
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const runtimeRoot = yield* fs.makeTempDirectoryScoped();
    const repoRoot = yield* fs.makeTempDirectoryScoped();
    const events = yield* Ref.make<ReadonlyArray<ReporterEvent>>([]);
    const commands = yield* Ref.make<ReadonlyArray<string>>([]);

    // The real `RunLock`, the real `Sandbox`, and the real `Git`, wired as
    // `appLiveFor` wires them: the lock the reclaim takes is the one acquisition
    // would have taken, through T20's claim and T21's witness, and the read
    // that authorizes a removal is the one the salvage makes — a fake would
    // prove nothing about either.
    const layer = Layer.provideMerge(
      Layer.mergeAll(SandboxLive, RunLockLive, GitLive),
      Layer.mergeAll(
        NodeFileSystem.layer,
        NodePath.layer,
        scriptedExecutor(
          {
            ...script,
            [`${inRepo(checkoutPathFor(runtimeRoot, SLUG))} rev-parse --verify refs/heads/${SLUG}`]:
              {
                exit: 0,
                stdout: `${COPY_TIP}\n`,
              },
            [`${inRepo(repoRoot)} merge-base --is-ancestor`]: containment,
          },
          commands,
        ),
        Layer.succeed(BessemerConfig, { ...defaultConfig, runtimeRoot }),
        Layer.succeed(Reporter, {
          emit: (event) => Ref.update(events, (current) => [...current, event]),
        }),
        // §3c, as a service that dies if it is ever consulted: a row exists
        // iff `RunLock` was acquired, never "and the run reached its end", so
        // a run interrupted mid-teardown has an `Interrupted` row *and* all
        // three resources still on this host. Every case below is a wreck of
        // exactly that shape, and none of them may look one up.
        Layer.succeed(Ledger, {
          append: () => Effect.die("the reconciler writes nothing to the ledger"),
          recent: () => Effect.die("the reconciler never reads the ledger"),
          lastBaseForBranch: () => Effect.die("the reconciler never reads the ledger"),
          resolveResume: () => Effect.die("the reconciler never reads the ledger"),
          newestBranchForIssue: () => Effect.die("the reconciler never reads the ledger"),
        }),
      ),
    );

    return { runtimeRoot, repoRoot, events, commands, layer };
  });

const locksDirOf = (runtimeRoot: string) => `${runtimeRoot}/${LOCKS_DIRNAME}`;

const leaveLock = (runtimeRoot: string, slug: string, pid: number) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(locksDirOf(runtimeRoot), { recursive: true });
    yield* fs.writeFileString(lockPathFor(runtimeRoot, slug), `${pid}\n`);
  });

const leaveCheckout = (runtimeRoot: string, slug: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const checkout = checkoutPathFor(runtimeRoot, slug);
    yield* fs.makeDirectory(`${checkout}/.git`, { recursive: true });
    yield* fs.writeFileString(`${checkout}/.git/HEAD`, "ref: refs/heads/bessemer-t8\n");
  });

const warnings = (events: ReadonlyArray<ReporterEvent>): ReadonlyArray<string> =>
  events.flatMap((event) => (event._tag === "Warned" ? [event.detail] : []));

const said = (events: ReadonlyArray<ReporterEvent>, fragment: string): boolean =>
  warnings(events).some((detail) => detail.includes(fragment));

describe("the reconciler on a dispatch preflight", () => {
  // The tracer: a dispatch was `kill -9`'d with its container up, so the lock
  // records a pid that is gone and dockerd is still holding the container its
  // `sleep infinity` entrypoint keeps alive. All three resources go, and the
  // pass says what it did (matrix row 17's reclaim half).
  it.scoped("reclaims a hard-killed run's container, checkout, and lock", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const scratch = yield* world(dockerHolding("running"));
      yield* leaveLock(scratch.runtimeRoot, SLUG, DEAD_PID);
      yield* leaveCheckout(scratch.runtimeRoot, SLUG);

      yield* reconcile(scratch.repoRoot).pipe(Effect.provide(scratch.layer));

      expect(yield* fs.exists(lockPathFor(scratch.runtimeRoot, SLUG))).toBe(false);
      expect(yield* fs.exists(checkoutPathFor(scratch.runtimeRoot, SLUG))).toBe(false);
      // The id came out of docker's stdout trimmed, so the removal addresses
      // the container rather than a string with whitespace around it (§3b).
      expect(yield* Ref.get(scratch.commands)).toContain(`docker rm -fv ${CONTAINER_ID}`);
      // And the lock it took to do all that left with it: nothing of this
      // preflight is still held.
      expect(yield* fs.readDirectory(locksDirOf(scratch.runtimeRoot))).toEqual([]);

      const events = yield* Ref.get(scratch.events);
      expect(said(events, `reclaiming the wreckage of '${SLUG}'`)).toBe(true);
      expect(said(events, `reclaimed the container 'bessemer-${SLUG}'`)).toBe(true);
      expect(said(events, "reclaimed the checkout at")).toBe(true);
      expect(said(events, `pid ${DEAD_PID} is not alive`)).toBe(true);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // The read that authorizes that removal (T38), in the argv two repositories
  // apart: the tip in the copy the commits are in, the ancestry in the repo
  // whose branch has to hold them. A pass that asked either of them in the
  // other repository would answer about the wrong commits.
  it.scoped("reads the copy's tip and this repo's ancestry before it removes anything", () =>
    Effect.gen(function* () {
      const scratch = yield* world(dockerHolding("running"));
      yield* leaveLock(scratch.runtimeRoot, SLUG, DEAD_PID);
      yield* leaveCheckout(scratch.runtimeRoot, SLUG);

      yield* reconcile(scratch.repoRoot).pipe(Effect.provide(scratch.layer));

      expect(
        (yield* Ref.get(scratch.commands)).filter((command) => command.startsWith("git ")),
      ).toEqual([
        `${inRepo(checkoutPathFor(scratch.runtimeRoot, SLUG))} rev-parse --verify refs/heads/${SLUG}`,
        `${inRepo(scratch.repoRoot)} merge-base --is-ancestor ${COPY_TIP} refs/heads/${SLUG}`,
      ]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // And the answer that keeps it. A run this pass can prove dead is exactly a
  // run whose release never ran, so its copy may hold the only version of its
  // work — the reclaim takes the container and the lock, and leaves the
  // directory standing with the commands that say what is in it.
  it.scoped("reclaims the rest but keeps a checkout this repo does not hold the commits of", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const scratch = yield* world(dockerHolding("running"), { exit: 1 });
      yield* leaveLock(scratch.runtimeRoot, SLUG, DEAD_PID);
      yield* leaveCheckout(scratch.runtimeRoot, SLUG);

      yield* reconcile(scratch.repoRoot).pipe(Effect.provide(scratch.layer));

      // The directory is untouched; the container and the lock are gone.
      expect(yield* fs.exists(`${checkoutPathFor(scratch.runtimeRoot, SLUG)}/.git/HEAD`)).toBe(
        true,
      );
      expect(yield* Ref.get(scratch.commands)).toContain(`docker rm -fv ${CONTAINER_ID}`);
      expect(yield* fs.readDirectory(locksDirOf(scratch.runtimeRoot))).toEqual([]);

      const events = yield* Ref.get(scratch.events);
      expect(said(events, "was **not** removed")).toBe(true);
      expect(said(events, `does not hold ${COPY_TIP}`)).toBe(true);
      expect(said(events, `rm -rf ${checkoutPathFor(scratch.runtimeRoot, SLUG)}`)).toBe(true);
      // Nothing anywhere in this pass says the commits are home.
      expect(said(events, "already home")).toBe(false);
      expect(said(events, "reclaimed the checkout at")).toBe(false);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // The same refusal from the other direction: a copy whose HEAD names no
  // branch is a copy with no ref to ask this repository about, so there is no
  // read that could authorize the removal and the directory stays.
  it.scoped("keeps a dead run's checkout whose HEAD names no branch", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const scratch = yield* world(dockerHoldingNothing);
      yield* leaveLock(scratch.runtimeRoot, SLUG, DEAD_PID);
      const checkout = checkoutPathFor(scratch.runtimeRoot, SLUG);
      yield* fs.makeDirectory(`${checkout}/.git`, { recursive: true });
      yield* fs.writeFileString(`${checkout}/.git/HEAD`, `${COPY_TIP}\n`);

      yield* reconcile(scratch.repoRoot).pipe(Effect.provide(scratch.layer));

      expect(yield* fs.exists(`${checkout}/.git/HEAD`)).toBe(true);
      // It asked git nothing at all: there was no ref to ask about.
      expect(
        (yield* Ref.get(scratch.commands)).filter((command) => command.startsWith("git ")),
      ).toEqual([]);
      expect(said(yield* Ref.get(scratch.events), "its HEAD names no branch")).toBe(true);
      expect(said(yield* Ref.get(scratch.events), "git branch --contains FETCH_HEAD")).toBe(true);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // The other half, and the one that matters more: a live run's resources are
  // reported and **never touched**. Silently deleting a possibly-live run is
  // how you kill a colleague's dispatch.
  it.scoped("reports a live run's three resources and leaves every one alone", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const scratch = yield* world(dockerHolding("running"));
      // This test process is unarguably alive, and it is what the lock names.
      yield* leaveLock(scratch.runtimeRoot, SLUG, process.pid);
      yield* leaveCheckout(scratch.runtimeRoot, SLUG);

      yield* reconcile(scratch.repoRoot).pipe(Effect.provide(scratch.layer));

      expect(yield* fs.readFileString(lockPathFor(scratch.runtimeRoot, SLUG))).toBe(
        `${process.pid}\n`,
      );
      expect(yield* fs.exists(`${checkoutPathFor(scratch.runtimeRoot, SLUG)}/.git/HEAD`)).toBe(
        true,
      );
      for (const command of yield* Ref.get(scratch.commands)) {
        expect(command).not.toMatch(/^docker rm\b/);
      }
      const events = yield* Ref.get(scratch.events);
      expect(said(events, `'${SLUG}' is a live run`)).toBe(true);
      expect(said(events, `pid ${process.pid} still holds its lock`)).toBe(true);
      expect(said(events, "left untouched")).toBe(true);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // The narrowing this ticket is: the run released — which is why there is no
  // lock and no container — and kept its checkout because the fetch-back would
  // not fast-forward, so that clone holds the only copy of its commits. The
  // pass names the directory, says it took nothing, and leaves it for `gc`.
  it.scoped("reports a checkout its run kept, and removes nothing of it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const scratch = yield* world(dockerHoldingNothing);
      yield* leaveCheckout(scratch.runtimeRoot, SLUG);

      yield* reconcile(scratch.repoRoot).pipe(Effect.provide(scratch.layer));

      expect(yield* fs.exists(`${checkoutPathFor(scratch.runtimeRoot, SLUG)}/.git/HEAD`)).toBe(
        true,
      );
      const events = yield* Ref.get(scratch.events);
      expect(said(events, `'${SLUG}' kept its own copy of the repository`)).toBe(true);
      expect(said(events, `The copy is at ${checkoutPathFor(scratch.runtimeRoot, SLUG)}`)).toBe(
        true,
      );
      expect(said(events, "nothing was removed")).toBe(true);
      // The branch came out of the copy's own `.git/HEAD`, which is the only
      // place it exists — the slug the pass scanned by cannot carry it back.
      expect(said(events, "refs/heads/bessemer-t8:refs/heads/bessemer-t8-from-run")).toBe(true);
      // And it took no lock to say so: reporting is not reclaiming, so the
      // acquisition that a reclaim goes through never happened — the locks
      // directory it would have created is not even there.
      expect(yield* fs.exists(locksDirOf(scratch.runtimeRoot))).toBe(false);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // The same directory beside a container dockerd stopped: the checkout is
  // still the run's kept work, and a stopped container is no evidence about it.
  it.scoped("keeps a lone checkout even when dockerd still holds a stopped container", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const scratch = yield* world(dockerHolding("exited"));
      yield* leaveCheckout(scratch.runtimeRoot, SLUG);

      yield* reconcile(scratch.repoRoot).pipe(Effect.provide(scratch.layer));

      expect(yield* fs.exists(checkoutPathFor(scratch.runtimeRoot, SLUG))).toBe(true);
      for (const command of yield* Ref.get(scratch.commands)) {
        expect(command).not.toMatch(/^docker rm\b/);
      }
      expect(said(yield* Ref.get(scratch.events), "nothing was removed")).toBe(true);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // Condition 3, doing the only work only it can do: no lock names this
  // container, so the dispatcher that started it may be one this process
  // cannot see — a second runtime root, or hae's bash `run.sh` on the same host.
  it.scoped("leaves a running container that no lock names alone", () =>
    Effect.gen(function* () {
      const scratch = yield* world(dockerHolding("running"));

      yield* reconcile(scratch.repoRoot).pipe(Effect.provide(scratch.layer));

      for (const command of yield* Ref.get(scratch.commands)) {
        expect(command).not.toMatch(/^docker rm\b/);
      }
      expect(said(yield* Ref.get(scratch.events), "no lock names an owner")).toBe(true);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped("reclaims a stopped container that no lock names", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const scratch = yield* world(dockerHolding("exited"));

      yield* reconcile(scratch.repoRoot).pipe(Effect.provide(scratch.layer));

      expect(yield* Ref.get(scratch.commands)).toContain(`docker rm -fv ${CONTAINER_ID}`);
      // The reclaim held this slug's lock while it worked, and gave it back.
      expect(yield* fs.readDirectory(locksDirOf(scratch.runtimeRoot))).toEqual([]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // A daemon that will not answer means condition 3 has no answer, so nothing
  // is provably dead on this pass. It degrades and reports rather than failing
  // the dispatch it precedes: the check that *can* refuse one is T3's.
  it.scoped("reclaims nothing when dockerd cannot be asked what it holds", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const scratch = yield* world({ "docker ps": { exit: 1, stderr: "daemon not responding" } });
      yield* leaveLock(scratch.runtimeRoot, SLUG, DEAD_PID);
      yield* leaveCheckout(scratch.runtimeRoot, SLUG);

      yield* reconcile(scratch.repoRoot).pipe(Effect.provide(scratch.layer));

      expect(yield* fs.exists(lockPathFor(scratch.runtimeRoot, SLUG))).toBe(true);
      expect(yield* fs.exists(checkoutPathFor(scratch.runtimeRoot, SLUG))).toBe(true);
      expect(said(yield* Ref.get(scratch.events), "could not ask dockerd")).toBe(true);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped("says nothing at all about a host with no wreckage on it", () =>
    Effect.gen(function* () {
      const scratch = yield* world(dockerHoldingNothing);

      yield* reconcile(scratch.repoRoot).pipe(Effect.provide(scratch.layer));

      expect(yield* Ref.get(scratch.events)).toEqual([]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // §3a: the one piece of wreckage T20's claim and T21's witness leave rather
  // than clear. Nobody is evicting under it — no live dispatch names itself
  // beside it — and a lock directory that accumulates these is one where
  // eviction eventually wedges.
  it.scoped("sweeps an eviction witness a killed evictor stranded", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const scratch = yield* world(dockerHoldingNothing);
      const stranded = `${lockPathFor(scratch.runtimeRoot, SLUG)}.${DEAD_PID}.evicting`;
      yield* fs.makeDirectory(locksDirOf(scratch.runtimeRoot), { recursive: true });
      yield* fs.writeFileString(stranded, `${DEAD_PID}\n`);

      yield* reconcile(scratch.repoRoot).pipe(Effect.provide(scratch.layer));

      expect(yield* fs.readDirectory(locksDirOf(scratch.runtimeRoot))).toEqual([]);
      expect(said(yield* Ref.get(scratch.events), "swept a stranded eviction witness")).toBe(true);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // T26's tracer: a dispatch killed in the instant between taking the witness
  // and removing the lock it names. Every later acquisition on this slug
  // collides on that same witness and reports a colleague's eviction, and the
  // pass that exists to clear wreckage is stopped by it too — its reclaim goes
  // through the very acquisition that collides. So the sweep runs before the
  // reclaim, and one preflight clears the whole of it.
  it.scoped("clears a slug wedged by a witness stranded beside its lock", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const scratch = yield* world(dockerHoldingNothing);
      const lockFile = lockPathFor(scratch.runtimeRoot, SLUG);
      yield* leaveLock(scratch.runtimeRoot, SLUG, DEAD_PID);
      yield* fs.link(lockFile, `${lockFile}.${DEAD_PID}.evicting`);

      yield* reconcile(scratch.repoRoot).pipe(Effect.provide(scratch.layer));

      const events = yield* Ref.get(scratch.events);
      expect(said(events, "swept a stranded eviction witness")).toBe(true);
      expect(said(events, `reclaiming the wreckage of '${SLUG}'`)).toBe(true);
      expect(yield* fs.readDirectory(locksDirOf(scratch.runtimeRoot))).toEqual([]);

      // And the next dispatch of that branch runs: the corpse is gone, so this
      // acquisition claims a free path rather than reclaiming anything.
      const claim = yield* Effect.scoped(
        RunLock.pipe(Effect.flatMap((runLock) => runLock.acquire(SLUG))),
      ).pipe(Effect.provide(scratch.layer));
      expect(claim.reclaimed).toBe(false);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // The other direction, and the case that would hand one corpse to two
  // dispatches: a dispatch is inside the eviction right now, and says so with
  // its own name beside the witness. Sweeping that witness would break T21's
  // serialization for whichever dispatch is holding it, which is the whole of
  // what keeps the second one out — so the corpse is left the way any other
  // lost eviction is, by reporting that it was not this preflight's to take.
  it.scoped("leaves a witness a live evictor is standing behind, and its corpse", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const scratch = yield* world(dockerHoldingNothing);
      const lockFile = lockPathFor(scratch.runtimeRoot, SLUG);
      const witness = `${lockFile}.${DEAD_PID}.evicting`;
      yield* leaveLock(scratch.runtimeRoot, SLUG, DEAD_PID);
      yield* fs.link(lockFile, witness);
      // This test process, which is unarguably alive, at an attempt number no
      // eviction of this run's own will land on.
      yield* fs.writeFileString(evictorMarkerFor(witness, process.pid, HELD_ATTEMPT), "");

      yield* reconcile(scratch.repoRoot).pipe(Effect.provide(scratch.layer));

      expect((yield* fs.readDirectory(locksDirOf(scratch.runtimeRoot))).toSorted()).toEqual(
        [
          `${SLUG}.pid`,
          `${SLUG}.pid.${DEAD_PID}.evicting`,
          `${SLUG}.pid.${DEAD_PID}.evicting.${process.pid}.${HELD_ATTEMPT}.evictor`,
        ].toSorted(),
      );
      // The corpse is that eviction's to remove, not this pass's.
      expect(yield* fs.readFileString(lockFile)).toBe(`${DEAD_PID}\n`);
      expect(said(yield* Ref.get(scratch.events), "not this preflight's to take")).toBe(true);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // The names themselves are swept on the pass that first sees them dead: a
  // marker nobody removes is a live evictor again the day its pid is recycled,
  // and one whose eviction never got as far as the link is the same wreck one
  // syscall earlier. Neither is a notice — a dispatcher can act on a wedged
  // slug, not on this.
  it.scoped("sweeps the name a killed eviction left, and leaves a live one's", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const scratch = yield* world(dockerHoldingNothing);
      const witness = `${lockPathFor(scratch.runtimeRoot, SLUG)}.${DEAD_PID}.evicting`;
      yield* fs.makeDirectory(locksDirOf(scratch.runtimeRoot), { recursive: true });
      yield* fs.writeFileString(evictorMarkerFor(witness, DEAD_PID, 1), "");
      // Written, and the link it precedes not taken yet: this eviction is
      // between its two syscalls, and neither name of it may be touched.
      yield* fs.writeFileString(evictorMarkerFor(witness, process.pid, HELD_ATTEMPT), "");

      yield* reconcile(scratch.repoRoot).pipe(Effect.provide(scratch.layer));

      expect(yield* fs.readDirectory(locksDirOf(scratch.runtimeRoot))).toEqual([
        `${SLUG}.pid.${DEAD_PID}.evicting.${process.pid}.${HELD_ATTEMPT}.evictor`,
      ]);
      expect(yield* Ref.get(scratch.events)).toEqual([]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // A `.claim` file is an attempt in flight, not a lock and not a witness:
  // reading it as either would key wreckage off a name no run ever had.
  it.scoped("reads neither a claim in flight nor a witness as a lock", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const scratch = yield* world(dockerHoldingNothing);
      yield* fs.makeDirectory(locksDirOf(scratch.runtimeRoot), { recursive: true });
      yield* fs.writeFileString(
        `${lockPathFor(scratch.runtimeRoot, SLUG)}.${DEAD_PID}.1.claim`,
        `${DEAD_PID}\n`,
      );

      yield* reconcile(scratch.repoRoot).pipe(Effect.provide(scratch.layer));

      expect(yield* Ref.get(scratch.events)).toEqual([]);
      expect(yield* fs.readDirectory(locksDirOf(scratch.runtimeRoot))).toEqual([
        `${SLUG}.pid.${DEAD_PID}.1.claim`,
      ]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
});

describe("the reconciler's scan", () => {
  // T97: what the preflight acts on, gathered as a value for `gc` to list —
  // the same wreckage those cases reclaim and keep, and the witness they
  // sweep, with nothing on the host touched to find it.
  it.scoped("returns the wreckage the preflight acts on, and removes nothing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const scratch = yield* world(dockerHolding("running"));
      const lockFile = lockPathFor(scratch.runtimeRoot, SLUG);
      const witness = `${lockFile}.${DEAD_PID}.evicting`;
      const marker = evictorMarkerFor(witness, DEAD_PID, 1);
      yield* leaveLock(scratch.runtimeRoot, SLUG, DEAD_PID);
      yield* leaveCheckout(scratch.runtimeRoot, SLUG);
      yield* leaveCheckout(scratch.runtimeRoot, "bessemer-t7");
      yield* fs.link(lockFile, witness);
      yield* fs.writeFileString(marker, "");
      const before = (yield* fs.readDirectory(locksDirOf(scratch.runtimeRoot))).toSorted();

      const scan = yield* scanWreckage(scratch.repoRoot).pipe(Effect.provide(scratch.layer));

      expect(scan.wreckage).toEqual([
        {
          slug: "bessemer-t7",
          lock: Option.none(),
          sandbox: Option.none(),
          checkout: Option.some({
            path: checkoutPathFor(scratch.runtimeRoot, "bessemer-t7"),
            branch: Option.some("bessemer-t8"),
          }),
        },
        {
          slug: SLUG,
          lock: Option.some({ path: lockFile, owner: Option.some(DEAD_PID) }),
          sandbox: Option.some({ id: CONTAINER_ID, name: `bessemer-${SLUG}`, running: true }),
          checkout: Option.some({
            path: checkoutPathFor(scratch.runtimeRoot, SLUG),
            branch: Option.some(SLUG),
          }),
        },
      ]);
      expect(scan.wreckage.map((found) => classify(found)._tag)).toEqual(["Kept", "Reclaimable"]);
      expect(scan.stranded).toEqual([{ path: witness, evictors: [DEAD_PID] }]);
      expect(scan.deadMarkers).toEqual([{ path: marker, evictor: DEAD_PID }]);
      expect(Option.map(scan.containers, (held) => held.length)).toEqual(Option.some(1));

      // Nothing written: the lock directory as it was, the lock still naming
      // its owner, both checkouts standing, and the one subprocess the
      // daemon's question — no removal, no lock taken, no git asked.
      expect((yield* fs.readDirectory(locksDirOf(scratch.runtimeRoot))).toSorted()).toEqual(before);
      expect(yield* fs.readFileString(lockFile)).toBe(`${DEAD_PID}\n`);
      expect(yield* fs.exists(checkoutPathFor(scratch.runtimeRoot, SLUG))).toBe(true);
      expect(yield* fs.exists(checkoutPathFor(scratch.runtimeRoot, "bessemer-t7"))).toBe(true);
      expect(
        (yield* Ref.get(scratch.commands)).map((command) => command.split(" ", 2).join(" ")),
      ).toEqual(["docker ps"]);
      expect(yield* Ref.get(scratch.events)).toEqual([]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // A daemon that will not answer stays `None` in the value rather than
  // becoming an empty list, and the rest of the host is still read.
  it.scoped("keeps dockerd's silence apart from an empty answer", () =>
    Effect.gen(function* () {
      const scratch = yield* world({ "docker ps": { exit: 1, stderr: "daemon not responding" } });
      yield* leaveLock(scratch.runtimeRoot, SLUG, DEAD_PID);

      const scan = yield* scanWreckage(scratch.repoRoot).pipe(Effect.provide(scratch.layer));

      expect(Option.isNone(scan.containers)).toBe(true);
      expect(scan.wreckage.map((found) => found.slug)).toEqual([SLUG]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
});
