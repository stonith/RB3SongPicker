FROM node:24.20.0-bookworm-slim AS dependencies

WORKDIR /app
COPY package.json package-lock.json ./

# sqlite3 may fall back to a native build when a prebuilt binary is unavailable.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
RUN npm ci --omit=dev

FROM node:24.20.0-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    STATE_DIR=/data

COPY --from=dependencies /app/node_modules ./node_modules
COPY --chown=node:node . ./
RUN mkdir -p /data && chown node:node /data

USER node
EXPOSE 3000

CMD ["node", "server.js"]
