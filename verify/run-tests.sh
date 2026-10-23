#!/bin/bash
# ark-key-pool 验证脚本：本地 mock 跑四个 Key 池场景，零真实额度消耗。
#
# 用法：bash verify/run-tests.sh
# 产物：verify/work/（mock 请求日志、池状态、池日志，已进 .gitignore）
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$ROOT/verify/work"
PORT="${MOCK_PORT:-8796}"
CFG="$WORK/keys.json"
STATE="$WORK/state.json"
POOL_LOG="$WORK/pool.log"
MOCK_LOG="$WORK/mock.log"

mkdir -p "$WORK"

cat > "$CFG" <<'EOF'
{
  "provider": "probe-ark",
  "keys": [
    { "name": "key-A", "key": "sk-pool-1" },
    { "name": "key-B", "key": "sk-pool-2" }
  ],
  "cooldown": { "authSeconds": 600, "rateLimitSeconds": 60, "quotaSeconds": 1800 }
}
EOF

run_case() {
	local name="$1" scenario="$2"
	echo "==================== $name ($scenario) ===================="
	rm -f "$STATE" "$POOL_LOG" "$MOCK_LOG"
	MOCK_LOG="$MOCK_LOG" MOCK_PORT="$PORT" MOCK_SCENARIO="$scenario" \
		node --experimental-strip-types "$ROOT/verify/mock-server.ts" > "$WORK/mock.out" 2>&1 &
	local mock_pid=$!
	sleep 1
	ARK_KEY_POOL_CONFIG="$CFG" ARK_KEY_POOL_STATE="$STATE" ARK_KEY_POOL_LOG="$POOL_LOG" \
	ARK_KEY_POOL_PROVIDER=probe-ark \
	timeout 90 pi --no-extensions -e "$ROOT/verify/probe-provider.ts" -e "$ROOT/ark-key-pool.ts" \
		--no-session --no-tools -p "hi" --model probe-ark/probe-model 2>&1 | tail -3
	echo "--- mock 收到的请求序列 ---"
	awk '{print $3, $4}' "$MOCK_LOG" 2>/dev/null
	echo "--- 池日志 ---"
	cat "$POOL_LOG" 2>/dev/null
	echo
	curl -s "http://127.0.0.1:$PORT/__shutdown" >/dev/null 2>&1
	sleep 0.3
	: "$mock_pid"
}

run_case "场景1 正常（用主 Key）" "sk-pool-1:ok,sk-pool-2:ok"
run_case "场景2 额度耗尽（key-A 429 → key-B ok）" "sk-pool-1:429,sk-pool-2:ok"
run_case "场景3 Key 失效（key-A 401 → key-B ok）" "sk-pool-1:401,sk-pool-2:ok"
run_case "场景4 两个都耗尽" "sk-pool-1:429,sk-pool-2:429"
