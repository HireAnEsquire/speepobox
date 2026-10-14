# This repo's agent image: the sandbox every agent pass runs in. Built by
# `speepobox image build`, which supplies AGENT_UID/GID and stamps the input
# labels `doctor` checks — always build through it. This file is yours to edit.

# Replace this with your own stack's image — the one your tests and tooling
# already run on. The agent works in whatever this image provides.
ARG BASE_IMAGE=debian:bookworm-slim

FROM ${BASE_IMAGE}

# git, because the agent and its hooks need the real CLI; curl and CA
# certificates, because the agent CLI's installer below needs them.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      git \
    && rm -rf /var/lib/apt/lists/*

# Setup that needs root, such as starting a database: one script baked into
# this image, and sudo scoped to exactly the command line that runs it. The
# section "Setup that needs root" in speepobox's README walks through it. To
# take it, write the script beside this file, list it in `inputs`, and
# uncomment the block below. Left commented, there is no sudo in the image.
# RUN apt-get update && apt-get install -y --no-install-recommends sudo \
#     && rm -rf /var/lib/apt/lists/*
# COPY root-setup.sh /usr/local/libexec/speepobox/root-setup.sh
# RUN echo "agent ALL=(ALL) NOPASSWD: /usr/bin/bash /usr/local/libexec/speepobox/root-setup.sh" \
#       > /etc/sudoers.d/agent \
#     && chmod 0440 /etc/sudoers.d/agent

# The uid/gid must match the host user that owns the bind-mounted checkout:
# macOS Docker Desktop masks a mismatch and Linux does not.
ARG AGENT_UID=1000
ARG AGENT_GID=1000
RUN groupadd -o -g $AGENT_GID agent \
    && useradd -o -u $AGENT_UID -g $AGENT_GID -m -d /home/agent -s /bin/bash agent

USER ${AGENT_UID}:${AGENT_GID}
WORKDIR /home/agent

# The agent CLI, pinned to an exact version and installed with the native
# installer, so the image needs no node. It lands in ~/.local/bin, which goes
# on PATH here because `docker exec` reads the image's PATH, never a login
# shell's. pipefail makes a failed download fail the build. Bump the
# version deliberately and rebuild.
ARG CLAUDE_CODE_VERSION=2.1.282
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
RUN curl -fsSL https://claude.ai/install.sh | bash -s "$CLAUDE_CODE_VERSION"
ENV PATH="/home/agent/.local/bin:$PATH"

# The model the agent passes run on. Unset, they run on the CLI's default
# model. Set ANTHROPIC_MODEL in one of two places: in the file config.toml's
# `sandbox-env-file` names, which needs no rebuild; or by uncommenting the
# line below with the model id you want and rebuilding through
# `speepobox image build`. Set in both, the env file wins.
# ENV ANTHROPIC_MODEL=<model id>

# The dispatcher overrides the workdir to /workspace and keeps the container
# alive to `docker exec` into.
ENTRYPOINT ["sleep", "infinity"]
