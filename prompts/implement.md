# TASK

Your task is the dispatcher's message below together with whatever it
points you at — read all of it first; the whole repo is available to you.
Implement exactly what the task describes, nothing beyond it.

It also names your branch and its diff-boundary commit. Commit to that branch;
push, PR, and merge are handled after you finish.

# ORIENTATION

- Read the repo's own agent guidance first — `AGENTS.md` or `CLAUDE.md` at the
  root, and whichever architecture doc covers the area you are touching.
- Skim `git log --oneline -10` for the repo's commit style.
- Explore the areas the task touches — especially their existing tests.
- The environment is already set up. If something fails on the environment
  itself, report it; don't patch around it.

# COMMANDS

Run everything in the foreground and let it finish — nothing long-running or
interactive (`--watch`, dev servers, pagers, background jobs). Exit code 0
means success; move on.

# IMPLEMENT

Prefer test-first where it fits: write a failing test, make it pass, repeat,
then refactor. Match surrounding code style.

Add a dependency only when the task calls for one, and add it through
the project's own package manager so the lockfile is updated and committed
with it.

# VERIFY (must pass before you commit)

The task's own Verify section is the gate for this work — run those
commands. Where it names none, run the repo's usual test, typecheck, and lint
commands for the files you changed.

That section may also mark some checks **host-only** — they need a docker
socket, forge credentials, or a TTY, none of which this container has. Those
belong to the dispatcher, who runs them before landing. Write them, leave them
unrun, and name the unverified ones in your final message; that sentence is
what the dispatcher acts on.

# COMMIT

Focused commits, concise messages in the repo's style, no Co-Authored-By
trailers.

**Checkpoint your work.** Your session can end without warning, and only
committed work survives — a pass that wrote ten files and committed none
delivers nothing.

So order the work before you write any of it. Find the piece that goes
**green** on its own — a pure function, a module with its test, a rename, a
prefactor — and land that first, even when it is not the interesting part.
Then commit each further piece as it goes green, and keep going.

**Interlocking work gives you no checkpoints.** When nothing typechecks until
every file is in, the gate cannot fire partway through, and a pass that runs
out of budget mid-stretch loses all of it. Land a green piece before you start
one.

If you cannot finish, commit what is safe and say what remains in your final
message; the checkpoints carry the rest.

# RULES

Only what the task describes. Only commits on your branch. No push, no
PR, no merge.
