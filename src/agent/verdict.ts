// What a review round decided, and the token a ledger row records for it.
// Pure and tagless, like the prompt's interpolation half: the verdict is read
// out of text a pass printed, so a fake buys nothing here either.
//
// The marker is bash's, verbatim (`run.sh:1349-1372`): the reviewer ends its
// final message with one `<verdict>…</verdict>` tag and the loop reads that
// tag back out of the pass's output. Anything else — a pass that says nothing,
// a pass that argues with itself — is `needs-work`, which is the answer that
// keeps a human in the loop.
//
// How the tag is *chosen* out of the output is where this port knowingly
// departs from bash (T24, recorded in `AGENTS.md`): the verdict is the **last**
// marker, not any marker. bash greps the whole captured output for approval
// first, so a reviewer that quotes a tag in its prose — the reviewer describing
// a review loop, which is every reviewer in this sequence — is read as having
// written it. Precedence between the three tokens disappears with it: the
// prompt asks for exactly one tag at the end, so the last one is the one the
// round meant.

export type ReviewVerdict = "approved" | "fixed" | "needs-work";

// Which round of how many. The pair travels together because the reviewer is
// told both (`prompt.ts`) and the loop stops on both: rounds share no memory,
// so a reviewer that is not told the budget cannot spend it.
export interface ReviewRound {
  readonly index: number;
  readonly of: number;
}

const markerFor = (verdict: string): string => `<verdict>${verdict}</verdict>`;

export const APPROVED_MARKER = markerFor("approved");
export const FIXED_MARKER = markerFor("fixed");

// Every well-formed tag in the output, in the order they were printed. The
// body cannot contain `<`, so an unclosed tag earlier in the prose cannot
// swallow the one that ends the message. The scan is over the whole output
// rather than its last line: `execStreamed` collects lines and nothing
// promises the tag sits alone on one.
const VERDICT_TAG = /<verdict>([^<]*)<\/verdict>/g;

export const reviewVerdictIn = (output: string): ReviewVerdict => {
  let last: string | undefined;
  for (const match of output.matchAll(VERDICT_TAG)) {
    last = match[1];
  }
  // A token we do not know is `needs-work` and does not fall through to an
  // earlier valid marker: a reviewer that ended on a word this port has no
  // meaning for has not approved anything. `fixed` loops exactly like
  // `needs-work` and differs only at the cap, where it says one round's
  // commits went unreviewed rather than that problems remain
  // (`run.sh:1358-1362`).
  if (last === "approved") {
    return "approved";
  }
  return last === "fixed" ? "fixed" : "needs-work";
};

// The `outcome` token for the verdict a run ended on. `fixed` only survives
// the loop at the cap — an earlier one is re-reviewed and replaced by whatever
// the next round says — so the rename happens here rather than in the loop,
// which never has to ask which round it is on.
//
// `outcome` is an **open string** on the record (`ledger/record.ts`): these are
// the three tokens this port writes today, and a reader that meets a fourth
// renders it rather than dropping the row.
export const CAPPED_UNREVIEWED_FIX = "capped-unreviewed-fix";

export const outcomeFor = (verdict: ReviewVerdict): string =>
  verdict === "fixed" ? CAPPED_UNREVIEWED_FIX : verdict;
