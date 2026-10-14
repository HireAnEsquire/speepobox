// A fake `Forge` for the step that drives it: what the PR step asks the forge
// and in which order, and which body reached it. The real layer's argv is
// `test/forge.test.ts`'s subject, against the scripted executor — here the
// assertion is the decision (view, then edit *or* create) and the value that
// crossed the seam, which a rendered `gh` command line would only spell out
// again.
//
// It is the one seam with no local oracle (SPEC §2), so this fake is also the
// only way the failure paths are reachable at all in the fake tier.
import { Effect, Layer, Option, Ref } from "effect";
import { Forge, ForgeError, prNumberIn, type ViewedPr } from "../../src/forge/forge.ts";
import type { PullRequest } from "../../src/ledger/record.ts";

export const PR_URL = "https://github.com/acme/hae/pull/101";
export const PR_NUMBER = 101;

export const openPullRequest: PullRequest = {
  number: prNumberIn(PR_URL),
  url: PR_URL,
};

// What the branch's open PR says today, which is what a resuming run quotes
// into its implement prompt (T17).
export const PR_TITLE = "[speepobox] speepobox-t17";
export const PR_BODY = "## Overview\n\nWhat the run before this one said it did.";

export const viewedPullRequest: ViewedPr = {
  pr: openPullRequest,
  title: PR_TITLE,
  body: PR_BODY,
};

export type ForgeCall =
  | { readonly _tag: "View"; readonly branch: string }
  | {
      readonly _tag: "Create";
      readonly branch: string;
      readonly base: string;
      readonly title: string;
      readonly body: string;
    }
  | { readonly _tag: "Edit"; readonly branch: string; readonly body: string };

export interface FakeForgeOptions {
  // The branch's open PR, if it has one — with what it says today, since one
  // view answers both. Absent is the first-run case: nothing to edit, so the
  // step creates.
  readonly existing?: ViewedPr;
  // The `ForgeError` detail each call fails with, when it is scripted to fail.
  // A refused create is matrix row 15; a refused edit is the same row from the
  // re-dispatch direction.
  readonly viewFails?: string;
  readonly createFails?: string;
  readonly editFails?: string;
}

// `calls` is optional because the run now asks the forge one question before
// the push as well as after it (T17's best-effort view): the worlds whose
// subject is the lock's row or the checkout's release need a `Forge` in the
// layer without collecting a call nobody asserts on.
export const fakeForge = (
  calls?: Ref.Ref<ReadonlyArray<ForgeCall>>,
  options: FakeForgeOptions = {},
): Layer.Layer<Forge> => {
  const record = (call: ForgeCall): Effect.Effect<void> =>
    calls === undefined ? Effect.void : Ref.update(calls, (current) => [...current, call]);
  return Layer.succeed(Forge, {
    // `repo` (T39) crosses the seam on every call, exactly as the real layer
    // requires, but this fake's own subject is the decision and the value —
    // which repo it names is `forge.test.ts`'s argv assertion, over the real
    // layer — so it is accepted and not recorded.
    prView: ({ branch }) =>
      record({ _tag: "View", branch }).pipe(
        Effect.zipRight(
          options.viewFails === undefined
            ? Effect.succeed(Option.fromNullable(options.existing))
            : Effect.fail(new ForgeError({ detail: options.viewFails })),
        ),
      ),
    prCreate: ({ branch, base, title, body }) =>
      record({ _tag: "Create", branch, base, title, body }).pipe(
        Effect.zipRight(
          options.createFails === undefined
            ? Effect.succeed(openPullRequest)
            : Effect.fail(new ForgeError({ detail: options.createFails })),
        ),
      ),
    prEdit: ({ branch, body }) =>
      record({ _tag: "Edit", branch, body }).pipe(
        Effect.zipRight(
          options.editFails === undefined
            ? Effect.void
            : Effect.fail(new ForgeError({ detail: options.editFails })),
        ),
      ),
  });
};
