# syntax=docker/dockerfile:1.7
# Search Typeahead API + dashboard. Node 25 runs the TypeScript sources natively and ships a
# built-in SQLite (node:sqlite), so there is NO native build/compile step or toolchain needed.

# ---- deps: install production dependencies only ----
FROM node:25-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev

# ---- runtime: minimal image with deps + app code ----
FROM node:25-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY web ./web

# data/ (dataset CSV + SQLite DB) is provided at runtime via a volume, not baked into the image.
RUN mkdir -p /app/data && chown -R node:node /app
USER node

EXPOSE 3000

# Healthcheck uses Node's built-in fetch (no curl needed in the slim image).
HEALTHCHECK --interval=10s --timeout=3s --retries=5 --start-period=5s \
  CMD node -e "fetch('http://localhost:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Graceful shutdown (SIGTERM) is handled in server.ts: flush the batch buffer, then exit.
CMD ["node", "src/server.ts"]
