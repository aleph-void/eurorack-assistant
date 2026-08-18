FROM node:20-bookworm-slim

# poppler-utils gives the LLM CLIs a way to read the manual PDFs
# (pdftotext + the poppler renderer used by Claude Code's Read tool).
# chromium lets the find_manual job save a module's product page as a PDF
# when no manual PDF can be found (headless render in services/pdf.js).
RUN apt-get update \
    && apt-get install -y --no-install-recommends poppler-utils ca-certificates chromium \
    && rm -rf /var/lib/apt/lists/*

# The LLM provider CLIs the server shells out to (configurable in the admin
# UI). Each run is pointed at the job owner's own credentials via environment
# variables (services/llmAccounts.js) — no login lives in the image or the
# host.
RUN npm install -g @anthropic-ai/claude-code @openai/codex

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
RUN mkdir -p /data/manuals /data/exports /data/captures /data/panels /data/llm /data/keys \
    && chown -R node:node /data /app
USER node

ENV NODE_ENV=production
ENV MANUALS_DIR=/data/manuals
EXPOSE 3000
CMD ["node", "src/index.js"]
