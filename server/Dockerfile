FROM node:20-bookworm-slim

# poppler-utils gives the LLM CLIs a way to read the manual PDFs
# (pdftotext + the poppler renderer used by Claude Code's Read tool).
RUN apt-get update \
    && apt-get install -y --no-install-recommends poppler-utils ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# The LLM provider CLIs the server shells out to (configurable in the admin
# UI). Their subscription logins are mounted from the host at runtime.
RUN npm install -g @anthropic-ai/claude-code @openai/codex

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY scripts ./scripts
COPY migrations ./migrations

RUN mkdir -p /data/manuals && chown -R node:node /data /app
USER node

ENV NODE_ENV=production
ENV MANUALS_DIR=/data/manuals
EXPOSE 3000
CMD ["node", "src/index.js"]
