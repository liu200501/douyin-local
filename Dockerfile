# syntax=docker/dockerfile:1.7

# ---------------------------------------------------------------- web assets
FROM node:22-alpine AS web-builder
WORKDIR /build/web
COPY web/package.json web/package-lock.json* ./
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund
COPY web/ ./
RUN npm run build

# ------------------------------------------------------------- server modules
FROM node:22-bookworm-slim AS server-builder
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /build/server
COPY server/package.json server/package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund

# ------------------------------------------------------------------- runtime
FROM node:22-bookworm-slim AS runtime

LABEL org.opencontainers.image.title="douyin-local" \
      org.opencontainers.image.description="Self-hosted short-video player: vertical full-screen feed + desktop cover wall, backed by your own video folders." \
      org.opencontainers.image.source="https://github.com/Gaoyubao0917/douyin-local" \
      org.opencontainers.image.licenses="MIT"

# ffmpeg/ffprobe are required for indexing, cover frames and container repacking.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Hardware decode drivers are optional: the default pipeline only repacks streams
# (ffmpeg -c copy), which needs no GPU. Installed on a best-effort basis so the
# image still builds when the non-free repository is unavailable.
RUN (apt-get update \
     && apt-get install -y --no-install-recommends intel-media-va-driver intel-media-va-driver-non-free i965-va-driver \
     && rm -rf /var/lib/apt/lists/*) || echo "VA-API drivers unavailable, CPU fallback only"

WORKDIR /app

COPY --from=server-builder /build/server/node_modules ./server/node_modules
COPY server/package.json ./server/package.json
COPY server/src ./server/src
COPY --from=web-builder /build/web/dist ./web
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh \
 && mkdir -p /data/cache /media/videos /app/logs

ENV NODE_ENV=production \
    PORT=6688 \
    HOST=0.0.0.0 \
    DATA_DIR=/data \
    CACHE_DIR=/data/cache \
    VIDEO_DIRS=/media/videos \
    WEB_DIR=/app/web \
    JOB_CONCURRENCY=2 \
    FFMPEG_THREADS=1 \
    HWACCEL=auto \
    SCAN_ON_START=true \
    LOG_LEVEL=info \
    TZ=Asia/Shanghai

EXPOSE 6688

VOLUME ["/data", "/media/videos"]

HEALTHCHECK --interval=30s --timeout=6s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||6688)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["node", "server/src/index.js"]
