#!/bin/bash
set -euo pipefail
if [ "$(uname -s)" != "Darwin" ]; then
  echo "登录自启动目前仅支持 macOS。"
  exit 1
fi

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="$(command -v node)"
PLIST_PATH="$HOME/Library/LaunchAgents/com.local.campus-recruitment-assistant.plist"

cd "$PROJECT_DIR"
npm run build
node scripts/write-launch-agent.mjs "$PLIST_PATH" "$NODE_BIN" "$PROJECT_DIR"

launchctl bootout "gui/$(id -u)/com.local.campus-recruitment-assistant" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH"
node scripts/open-local.mjs
echo "校招进度助手已设置为登录时自动启动。"
