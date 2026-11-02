#!/bin/bash
set -euo pipefail
if [ "$(uname -s)" != "Darwin" ]; then
  echo "登录自启动目前仅支持 macOS。"
  exit 1
fi

PLIST_PATH="$HOME/Library/LaunchAgents/com.local.campus-recruitment-assistant.plist"
launchctl bootout "gui/$(id -u)/com.local.campus-recruitment-assistant" 2>/dev/null || true
if [ -f "$PLIST_PATH" ]; then
  mkdir -p "$HOME/.Trash"
  mv "$PLIST_PATH" "$HOME/.Trash/com.local.campus-recruitment-assistant-$(date +%Y%m%d%H%M%S).plist"
fi
echo "已停止自动启动。数据库和钥匙串凭据未删除。"
