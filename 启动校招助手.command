#!/bin/bash
set -euo pipefail
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$PROJECT_DIR"
if ! command -v node >/dev/null 2>&1; then
  echo "请先安装 Node.js 22.13 或更新的 22.x，或 Node.js 24.x。"
  exit 1
fi
exec node scripts/launch.mjs
