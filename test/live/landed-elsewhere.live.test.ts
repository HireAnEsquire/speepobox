// The scan's host-only check (T72's fourth acceptance line): **the scan over
// this repository's own refs and this folder completes in under two seconds.**
//
// It is here rather than in `verify` for the tier's own admission rule read at
// its widest — a fake could pass while the real thing disagrees. The real
// thing this one asks is a repository with a host's ref count in it: the
// container that writes this package holds a clone with a handful of refs and
// an issue folder it just wrote, so a timing assertion there would be a report
// on the container rather than on the dispatching host, which is the shape
// AGENTS.md's host-reads rule exists to refuse. 14 measured 0.62s over 339
// refs × 8 issues; the budget below is that with room, and what it defends is
// the design and not the machine — two git processes whatever the ref count,
// where a read per ref is one spawn per branch a dev ever pushed.
//
// It needs no dockerd, and it is the one case in this tier that does not:
// `verify:live` is the host-only script, and a second script for one case
// would be a second thing a dispatcher has to remember to run.
import { expect } from "@effect/vitest";
import { NodeContext } from "@effect/platform-node";
import { Duration, Effect, Layer } from "effect";
import { packageRoot } from "../../src/config/paths.ts";
import { Git, GitLive } from "../../src/git/git.ts";
import { IssueStore, IssueStoreLive } from "../../src/issues/issue-store.ts";
import { itLive } from "./live.ts";

// This package's own queue, read as a dispatch of this repo reads it (T40).
const FOLDER = "docs/wayfinder/effect-agentbox";

// 14's measurement with room for a slower host and a bigger folder: this one
// carries an order of magnitude more issues than the eight it was taken over.
const BUDGET = Duration.seconds(2);

itLive.scoped("scans this repository's own refs inside the budget", () =>
  Effect.gen(function* () {
    const git = yield* Git;
    const store = yield* IssueStore;
    const tip = yield* git.revParse({ repo: packageRoot, rev: "HEAD^{commit}" });

    // The fixture is the host's: however many refs this clone has, and
    // whatever the folder holds at the tip.
    const refs = yield* git.forEachRef({ repo: packageRoot });
    const issues = yield* store.issues({ repo: packageRoot, ref: tip, folder: FOLDER });
    expect(issues.length).toBeGreaterThan(0);

    const [elapsed] = yield* Effect.timed(
      store.landedElsewhere({ repo: packageRoot, folder: FOLDER, issues, tip }),
    );

    // The budget is over the scan alone — the set read above is T71's cost and
    // is paid by the dispatch whether or not this check runs.
    expect(Duration.lessThan(elapsed, BUDGET)).toBe(true);
    // And it really was a scan: a run against a repository with one ref would
    // meet any budget and say nothing.
    expect(refs.length).toBeGreaterThan(1);
  }).pipe(
    Effect.provide(Layer.provideMerge(Layer.merge(IssueStoreLive, GitLive), NodeContext.layer)),
  ),
);
