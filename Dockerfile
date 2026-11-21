FROM node:24-trixie-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:24-trixie-slim

# Toolchains the agents commonly need. Python comes with venv and uv, so agents can create
# environments and install further Python versions without root (uv python install 3.13).
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git gh tzdata ca-certificates curl ripgrep jq unzip xz-utils less procps openssh-client sudo \
      build-essential python3 python3-venv python3-pip \
 # A virtual display with software OpenGL, for agents that render or screenshot what they build
 # (game engines, browsers).
 && apt-get install -y --no-install-recommends \
      xvfb xauth libgl1 libgl1-mesa-dri libglx-mesa0 libegl1 libx11-6 libxext6 libxrandr2 libxi6 \
      libxcursor1 libxinerama1 libxkbcommon0 libasound2t64 libpulse0 libdbus-1-3 \
      libfontconfig1 libfreetype6 fonts-dejavu-core fonts-noto-color-emoji \
 && rm -rf /var/lib/apt/lists/* \
 && curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh \
 && npm install -g @anthropic-ai/claude-code @openai/codex opencode-ai

# The container is the sandbox: agents may install system packages with "sudo apt-get install".
RUN echo "node ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/node \
 && mkdir -p /data /repos \
 && chown node:node /data /repos

WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
COPY --chown=node:node server ./server
COPY --chown=node:node scripts ./scripts

# The agent CLIs refuse to run unattended as root.
USER node
ENV HOST=0.0.0.0 PORT=8790 AGENTDECK_DATA=/data NODE_ENV=production TZ=Europe/Berlin
EXPOSE 8790
CMD ["node", "server/main.ts"]
