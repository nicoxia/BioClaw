#!/bin/bash
# BioClaw 启动脚本（支持 Telegram + Web）
set -e

cd "$(dirname "$0")"

# 检查 Docker
if ! docker info >/dev/null 2>&1; then
  echo "⚠️  Docker 未运行，尝试启动 OrbStack..."
  open -a OrbStack
  sleep 5
fi

# 确保 Node 20
export PATH="$HOME/.n/bin:$PATH"
echo "Node: $(node -v)"

# 读取 .env 中的 TELEGRAM_BOT_TOKEN
if grep -q "TELEGRAM_BOT_TOKEN=.*[^_]$" .env 2>/dev/null; then
  echo "✅ Telegram bot token 已配置"
  export $(grep "TELEGRAM_BOT_TOKEN" .env | xargs)
else
  echo "⚠️  未检测到 TELEGRAM_BOT_TOKEN，仅 Web 模式"
fi

# 启动
echo "🚀 启动 BioClaw..."
npx tsx src/index.ts
