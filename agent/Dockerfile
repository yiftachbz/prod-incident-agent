# Build from the repository root, not from agent/:
#   docker build -f agent/Dockerfile -t prod-incident-agent .
#
# This is required because the agent needs the full repo at /repo for
# code analysis and patching (app/server/src/index.js), while the agent
# service itself lives in agent/. Both must be inside the same build context.

FROM node:22-slim

# ── System tools ────────────────────────────────────────────────────────────
# git + gh  : required for RCA diff capture and openPR branch push.
# docker CLI: required for deploySandbox (builds and runs the ephemeral
#             app-server container).  The Docker *daemon* is NOT installed here;
#             mount the host socket at runtime:
#               -v /var/run/docker.sock:/var/run/docker.sock
RUN apt-get update && apt-get install -y --no-install-recommends \
      git curl ca-certificates gnupg docker.io \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
         | gpg --dearmor -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] \
         https://cli.github.com/packages stable main" \
         > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# ── Agent service (lives in agent/) ────────────────────────────────────────
WORKDIR /app
COPY agent/package.json ./
RUN npm install --omit=dev

COPY agent/src/ ./src/

# ── Full repo at /repo for code analysis and patching ──────────────────────
# The agent reads app/server/src/index.js, applies fixes, runs git diff,
# and pushes a fix branch — all relative to REPO_ROOT=/repo.
# .git is included so git commands work inside the container.
COPY . /repo/

RUN if [ ! -d /repo/.git ]; then \
      cd /repo && git init && git add -A && git commit -m "init"; \
    fi

ENV REPO_ROOT=/repo
ENV PORT=8001
# Internal port the app server listens on inside its sandbox container.
# Must match SERVER_PORT in app/server/Dockerfile (default 3001).
ENV SANDBOX_PORT=3001

EXPOSE 8001

CMD ["node", "src/index.js"]
