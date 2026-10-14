# ROLE

Write the pull-request description for the work on this branch. The
dispatcher's message below names the branch and the diff boundary the work is
read against; describe every commit after that boundary (`git log
<boundary>..HEAD`, `git diff <boundary>..HEAD`).

If the dispatcher's message includes a `--- Dispatcher feedback ---` block,
that is dispatcher-authorized guidance the implementation followed — where it
drove a specific choice visible in the diff, mention it in the Overview or
Changes section so a reviewer does not mistake it for a spec deviation.

# STRUCTURE (in this order)

1. **Overview** — a short paragraph: what the task was and why, from the spec.
2. **Changes** — brief bullets describing the **behaviour**: what someone using
   or operating this code can now do or see differently. Do not inventory the
   diff (no file lists, no "refactored X"); mention internals only where a
   reviewer needs them to follow the behaviour.
3. **Verification** — report the gate, do not re-run it. The implement and
   review passes already ran the spec's Verify commands on this branch; say
   what they ran and what they reported, reading that off the branch's commit
   messages and the task. Running the suite again is the most expensive
   thing this pass can do, and it tells a reviewer nothing that CI does not
   already report on the PR itself. Then give the steps a reviewer
   follows to confirm it themselves. Anchor every command to the directory it
   runs in, and state the expected result of each step. The reviewer's host is
   not this container: expect bash 3.2 and a BSD userland where you have bash 5
   and GNU coreutils, and no network at all. A command that worked for you is
   not thereby runnable there, and a step whose expected output that host
   cannot produce reads as a defect in the change rather than a bad step. Check
   each one against it, and where a path only runs in the container, give the
   `docker run` that reaches it instead of a bare command the host will refuse.
   Write every path from the repo root: a relative traversal you counted in
   `/workspace` lands somewhere else on a host whose repo sits at a different
   depth, and one whose `/tmp` is a symlink resolves a `..` chain differently
   again. The string looks identical in both places, so this is the failure a
   reviewer cannot see coming.
4. **Unverified** — anything a criterion asked for that could not be checked
   here (host-only commands, absent tools, network). Omit the section entirely
   when there is nothing in it; never present an unrun check as a passing one.

# FORMAT

Wrap the description in `<pr-description>` and `</pr-description>`, each on a
line of its own, **in your final message** — that message is the only one the
dispatcher reads, so a block written in any earlier one is thrown away.
**Everything between those two lines lands verbatim in the PR body,
and everything outside them is discarded** — so if you want to think out loud,
say what you are about to do, or sign off at the end, do it outside the block,
where it costs nothing.

Inside the block: begin directly with the first section, and write no title
line — the title is set separately — and no enclosing code fence.

If you write no block at all, the PR opens with a placeholder body instead of
your description.
