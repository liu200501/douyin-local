#!/bin/bash
# fpk 打包的 POSIX 入口，逻辑都在 build-fpk.mjs 里（跨平台，唯一实现）。
# 之所以薄成一层：Windows 上没有 bash 里的 chmod/dirname 等工具，打包逻辑只维护一份更省事。
#
# 用法：
#   ./tools/build-fpk.sh              # 占位符没替换就报错退出
#   ./tools/build-fpk.sh --keep-going # 占位符只警告
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if command -v node >/dev/null 2>&1; then
  exec node "$ROOT/tools/build-fpk.mjs" "$@"
fi

# 没有 node 的兜底：直接用系统 fnpack（飞牛设备上常见）
APP_DIR="$ROOT/fnos/douyin-local"
cd "$APP_DIR"
chmod +x cmd/* 2>/dev/null || true
fnpack build
echo "==> 产物：$APP_DIR/douyin-local.fpk"
