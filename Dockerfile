FROM node:24-trixie-slim AS dependencies

WORKDIR /app
COPY package.json package-lock.json ./

# Trixie ships glibc 2.42, new enough for the prebuilt sqlite3 binaries (they need GLIBC >= 2.38),
# so no apt-get toolchain or --build-from-source fallback is needed.
RUN npm ci --omit=dev

FROM node:24-trixie-slim

ARG APP_VERSION=development
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    STATE_DIR=/data \
    APP_VERSION=${APP_VERSION}

COPY --from=dependencies /app/node_modules ./node_modules
COPY --chown=node:node . ./
RUN mkdir -p /data && chown node:node /data

USER node
# 21070/udp is the RB3Enhanced event listener; it is separate from the web UI's TCP port
# and from the console's own HTTP port, which happens to use the same number.
EXPOSE 3000 21070/udp

CMD ["node", "server.js"]
