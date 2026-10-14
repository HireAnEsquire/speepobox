#!/usr/bin/env bash
# This repo's setup hook (T7): the one thing that has to happen inside the
# container before the agent pass. .speepobox/config.toml declares it as
# `setup-hook`; the dispatcher mounts it read-only at /speepobox/setup-hook.sh
# and runs it with `bash <path>` (src/dispatch/setup-hook.ts).
#
# At the repo root rather than in .speepobox/image/ because it is run-time, never
# build-time: it is not in the image, which is why it is correctly absent from
# .speepobox/image/inputs. Inside .speepobox/image/ it would raise a standing "why
# isn't this an input?" for every reader. A directory earns its keep at the
# second script.
#
# `node_modules/` is gitignored, so the agent's checkout is a clone without it,
# and every ticket here ends on `npm run verify`. The image cannot carry the
# modules instead: the checkout is bind-mounted at /workspace, which masks
# whatever the image put underneath.
#
# It runs as the `agent` user into a directory that user already owns, so it
# needs no capability — the container keeps `--cap-drop ALL` with nothing added
# back.
#
# Cost, stated rather than solved: every run pays a cold `npm ci` over the
# network. The shared-cache mount that would fix it has no shape in this package
# (`SandboxMount` has no mode field) and belongs to 19.
set -euo pipefail

# The checkout's mount target (src/sandbox/spec.ts, WORKSPACE_TARGET), spelled
# out rather than taken from the working directory: this script is addressed by
# absolute path and should not depend on where it was invoked from.
WORKSPACE="/workspace"

cd "$WORKSPACE"

# `npm ci`, not `npm install`: a hook that quietly resolved a different tree
# than the lockfile would make the verify gate report on something other than
# what landed.
npm ci
