FROM node:20-bookworm-slim

# poppler-utils gives the LLM CLIs a way to read the manual PDFs
# (pdftotext + the poppler renderer used by Claude Code's Read tool).
# chromium lets the find_manual job save a module's product page as a PDF
# when no manual PDF can be found (headless render in services/pdf.js).
# ffmpeg samples still frames out of attached YouTube videos so the model
# can look at them (jobs download_video, services/videos.js).
# sudo lets the unprivileged server drop to the `agent` uid for CLI runs.
RUN apt-get update \
    && apt-get install -y --no-install-recommends poppler-utils ca-certificates chromium ffmpeg sudo \
    && rm -rf /var/lib/apt/lists/*

# yt-dlp downloads attached YouTube videos (jobs download_video). The
# standalone release binary rather than Debian's package: yt-dlp has to move
# as fast as YouTube changes, and a year-old copy simply stops downloading.
ADD https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux /usr/local/bin/yt-dlp
RUN chmod 0755 /usr/local/bin/yt-dlp

# The LLM provider CLIs the server shells out to (configurable in the admin
# UI). Each run is pointed at the job owner's own credentials via environment
# variables (services/llmAccounts.js) — no login lives in the image or the
# host.
RUN npm install -g @anthropic-ai/claude-code @openai/codex

# The sandbox user the agent CLIs run as (services/sandbox.js). It owns none of
# the server's secrets, so a prompt-injected agent that tries to read them is
# stopped by the file system, not just by the CLI's own sandbox flag:
#   - `agent` (uid via useradd) has no login and no access to /data/keys.
#   - `llmjail` (gid 2000) is shared by `node` and `agent`; it is how a document
#     jail and a per-user credential dir are handed across the uid boundary.
#   - sudoers lets `node` run `/usr/bin/env` (the agent entrypoint) as `agent`
#     without a password, and nothing else.
RUN groupadd -g 2000 llmjail \
    && useradd -r -M -s /usr/sbin/nologin -g llmjail agent \
    && usermod -aG llmjail node \
    && printf 'node ALL=(agent) NOPASSWD: /usr/bin/env\n' > /etc/sudoers.d/llm-agent \
    && chmod 0440 /etc/sudoers.d/llm-agent

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY scripts ./scripts
COPY migrations ./migrations

# Every data directory has to exist in the image, not just be a mount point
# invented at run time: docker copies a named volume's ownership from the
# directory it is mounted over, so a path that is missing here is created
# root-owned and nothing the `node` user does can write to it (the panel,
# export and capture jobs failing with EACCES).
#
# Ownership is deliberate, not uniform: /data/keys (the master encryption key)
# and the app source stay node-only so the `agent` sandbox uid cannot read
# them, while /data/llm is group-shared with `llmjail` and setgid so a per-user
# credential dir the agent needs can be handed across the uid boundary. The
# other data dirs are touched only by the server (the agent reads staged copies
# in a jail, never the originals), so they stay node-only.
RUN mkdir -p /data/manuals /data/exports /data/captures /data/panels /data/videos /data/llm /data/keys \
    && chown -R node:node /data /app \
    && chmod 700 /data/keys \
    && chown node:llmjail /data/llm \
    && chmod 2770 /data/llm
USER node

ENV NODE_ENV=production
ENV MANUALS_DIR=/data/manuals
# Enable the separate-uid sandbox for agent CLI runs (services/sandbox.js).
ENV LLM_SANDBOX_USER=agent
ENV LLM_SANDBOX_GID=2000
EXPOSE 3000
CMD ["node", "src/index.js"]
