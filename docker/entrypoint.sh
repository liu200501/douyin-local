#!/bin/sh
set -e

echo "[douyin-local] starting, PORT=${PORT:-6688} DATA_DIR=${DATA_DIR:-/data} VIDEO_DIRS=${VIDEO_DIRS:-/media/videos}"

mkdir -p "${DATA_DIR:-/data}" "${CACHE_DIR:-/data/cache}" "${CACHE_DIR:-/data/cache}/poster" "${CACHE_DIR:-/data/cache}/remux"

if ! command -v ffprobe >/dev/null 2>&1; then
  echo "[douyin-local] WARNING: ffprobe not found, indexing will be skipped"
fi

if [ -d /dev/dri ]; then
  echo "[douyin-local] /dev/dri detected, hardware acceleration candidates available"
else
  echo "[douyin-local] /dev/dri not mounted, running CPU only (fine for repacking)"
fi

# Warn about video roots that were never mounted: a very common compose mistake.
IFS=',;|'
for dir in ${VIDEO_DIRS:-/media/videos}; do
  if [ -n "$dir" ] && [ ! -d "$dir" ]; then
    echo "[douyin-local] WARNING: video directory '$dir' does not exist inside the container"
  fi
done
unset IFS

exec "$@"
