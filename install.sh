#!/usr/bin/env bash
# ark-key-pool 安装脚本
#   1) 部署 pi 扩展到 ~/.pi/agent/extensions/ark-key-pool.ts
#   2) 若无配置，复制模板到 ~/.pi/agent/ark-agent-plan-keys.json（0600）
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="${PI_AGENT_DIR:-$HOME/.pi/agent}"
EXT_DIR="$AGENT_DIR/extensions"
CONFIG="$AGENT_DIR/ark-agent-plan-keys.json"
TEMPLATE="$ROOT/ark-agent-plan-keys.json.example"

echo "==> 部署 pi 扩展"
mkdir -p "$EXT_DIR"
cp "$ROOT/ark-key-pool.ts" "$EXT_DIR/ark-key-pool.ts"
echo "    已部署：$EXT_DIR/ark-key-pool.ts（新会话或 pi 里 /reload 后生效）"

echo "==> 配置模板"
if [ -f "$CONFIG" ]; then
	echo "    已存在，保留不动：$CONFIG"
else
	cp "$TEMPLATE" "$CONFIG"
	chmod 600 "$CONFIG"
	echo "    已创建：$CONFIG（0600）"
	echo "    请填入两个账号的真实 Key 后执行 /reload。"
fi

echo
echo "完成。检查状态：pi 里执行 /ark-key-pool"
