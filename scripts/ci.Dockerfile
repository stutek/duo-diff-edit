# The Linux of GitHub's ubuntu-latest runner, for scripts/ci-local.py: Ubuntu 24.04, Node.js of the major in ci.yml,
# Claude Code of the version ci.yml pins, Xvfb and the libraries Visual Studio Code needs, an unprivileged user "runner".
ARG NODE=22
FROM node:${NODE}-bookworm-slim AS node
FROM ubuntu:24.04
RUN apt-get update -q && DEBIAN_FRONTEND=noninteractive apt-get install -yq python3 git xvfb xauth curl ca-certificates \
      libnss3 libatk1.0-0t64 libatk-bridge2.0-0t64 libgtk-3-0t64 libgbm1 libasound2t64 libxkbfile1 libsecret-1-0 \
      libxss1 libxshmfence1 \
 && rm -rf /var/lib/apt/lists/*
COPY --from=node /usr/local/bin/node /usr/local/bin/
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm
ARG CLAUDE_CODE
RUN npm install --global "@anthropic-ai/claude-code@${CLAUDE_CODE}"
RUN useradd -m runner
USER runner
WORKDIR /home/runner
