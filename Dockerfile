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
      # iptables: the egress allowlist of a project (docker/agentdeck-sandbox egress, needs NET_ADMIN).
      iptables \
      build-essential python3 python3-venv python3-pip \
 # A virtual display with software OpenGL, for agents that render or screenshot what they build
 # (game engines, browsers).
 && apt-get install -y --no-install-recommends \
      xvfb xauth libgl1 libgl1-mesa-dri libglx-mesa0 libegl1 libx11-6 libxext6 libxrandr2 libxi6 \
      libxcursor1 libxinerama1 libxkbcommon0 libasound2t64 libpulse0 libdbus-1-3 \
      libfontconfig1 libfreetype6 fonts-dejavu-core fonts-noto-color-emoji \
 && rm -rf /var/lib/apt/lists/* \
 # The system libraries of Playwright's Chromium, for projects that screenshot their web UI.
 # The browser itself comes from the project (PLAYWRIGHT_BROWSERS_PATH), in the version it pins.
 && npx -y playwright@1.65.0 install-deps chromium \
 && rm -rf /var/lib/apt/lists/* /root/.npm \
 && curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh \
  && npm install -g @anthropic-ai/claude-code @openai/codex opencode-ai

# Versioned, checksum-verified RTK with system hooks (no project-wide trust bypass).
ARG TARGETARCH
RUN case "${TARGETARCH:-$(dpkg --print-architecture)}" in \
      amd64) asset=rtk-x86_64-unknown-linux-musl; sum=70fee7b4a548c43dde94c77e2335550981b0bc2fb013691d8c8109b5bd0eda37 ;; \
      arm64) asset=rtk-aarch64-unknown-linux-musl; sum=f91a06e94e5fad7dfa87946c811a4bcbc500e6da119fd47033f2a8940bf64f93 ;; \
      *) echo "Unsupported RTK architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac \
 && curl --fail --show-error --silent --location "https://github.com/rtk-ai/rtk/releases/download/v1.2.0/$asset.tar.gz" -o /tmp/rtk.tar.gz \
 && echo "$sum  /tmp/rtk.tar.gz" | sha256sum -c - \
 && tar -xzf /tmp/rtk.tar.gz -C /usr/local/bin rtk \
 && rm /tmp/rtk.tar.gz
COPY docker/rtk-claude.json /etc/claude-code/managed-settings.json
COPY docker/rtk-codex.json /etc/codex/hooks.json

# Agents run as a Linux user of their project (ad-<key>), see server/sandbox.ts. The server
# (node) may start processes as those users and run the sandbox helper as root, nothing else.
# System packages for agents go through "agentdeck install" and the helper.
COPY docker/agentdeck-sandbox /usr/local/sbin/agentdeck-sandbox
COPY docker/sudoers /etc/sudoers.d/agentdeck
RUN chmod 0755 /usr/local/sbin/agentdeck-sandbox \
 && chmod 0440 /etc/sudoers.d/agentdeck \
 && visudo -c \
 && groupadd --system agentdeck-projects \
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
ENV HOST=0.0.0.0 PORT=8790 AGENTDECK_DATA=/data AGENTDECK_SANDBOX=1 NODE_ENV=production TZ=Europe/Berlin
EXPOSE 8790
CMD ["node", "server/main.ts"]
