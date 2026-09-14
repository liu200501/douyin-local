#!/usr/bin/env sh
# douyin-local 本机启动（Linux / macOS，不需要 Docker）
set -e
cd "$(dirname "$0")"
exec node tools/dev.mjs "$@"
