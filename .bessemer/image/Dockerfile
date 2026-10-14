# bessemer-template: image/Dockerfile v3 sha256:c67338b251dc
# The agent image for this repo, built by `node src/bin.ts image build` (which
# supplies AGENT_UID/GID and stamps the T30 input labels — always build through
# it).
#
# Not `.agentbox/Dockerfile`, which was hae's, carried in as the parity oracle
# until T137 deleted it, and never built here. That one is FROM the served app's compose-built image; this
# repo has no compose, so this starts from the node image directly.

# Node >= 26 is what lets bessemer's TS run under plain node type stripping,
# which is how it is executed — the package has no build step.
ARG NODE_IMAGE=node:26-bookworm-slim

FROM ${NODE_IMAGE}

# git, because the agent and its hooks need the real CLI; curl and CA
# certificates, because the agent CLI's installer below needs them — the slim
# base ships none of the three. Deliberately absent: no postgres, no python,
# and no sudo — nothing in this repo's run needs root, so `cap-add` stays unset
# in config.toml and the container runs under `--cap-drop ALL` with nothing
# added back. A step that needs root earns both lines together.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      git \
    && rm -rf /var/lib/apt/lists/*

# The uid/gid must match the host user that owns the bind-mounted checkout:
# macOS Docker Desktop masks a mismatch and Linux does not.
ARG AGENT_UID=1000
ARG AGENT_GID=1000
RUN groupadd -o -g $AGENT_GID agent \
    && useradd -o -u $AGENT_UID -g $AGENT_GID -m -d /home/agent -s /bin/bash agent

USER ${AGENT_UID}:${AGENT_GID}

# The agent CLI, pinned: the version and the install line are the package's
# Dockerfile template's (templates/image/Dockerfile, T113), so this image and a
# freshly scaffolded one run the same CLI. The version is in this file's text,
# so a bump is an input change the staleness check sees — the hole the
# unpinned `npm install -g` used to leave. It
# lands in ~/.local/bin, which goes on PATH below because `docker exec` reads
# the image's PATH, never a login shell's. pipefail makes a failed download
# fail the build. Bump it with the template's, and rebuild.
ARG CLAUDE_CODE_VERSION=2.1.282
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
RUN curl -fsSL https://claude.ai/install.sh | bash -s "$CLAUDE_CODE_VERSION"

ENV PATH="/home/agent/.local/bin:$PATH"

# The model every agent pass runs on. The dispatcher forwards only the
# credential into the container (sandbox/spec.ts), so without this the CLI
# falls back to the subscription's default. Swap the comment to change it;
# rebuild through `node src/bin.ts image build` either way.
ENV ANTHROPIC_MODEL=claude-opus-5
# ENV ANTHROPIC_MODEL=claude-fable-5-1

# The package's dependencies are deliberately not baked in. `node_modules/` is
# gitignored so the checkout arrives without it, and baking it here would not
# reach anyway: the checkout is bind-mounted at /workspace, which masks whatever
# the image put underneath. They arrive through setup-hook.sh instead.
WORKDIR /home/agent
# The dispatcher overrides the workdir to /workspace and keeps the container
# alive to `docker exec` into.
ENTRYPOINT ["sleep", "infinity"]
