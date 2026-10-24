#!/bin/bash
# ark-key-pool 验证脚本：本地 mock 跑 Key 池场景，零真实额度消耗。
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

MOCK_PID=""

start_mock() {
	MOCK_LOG="$MOCK_LOG" MOCK_PORT="$PORT" MOCK_SCENARIO="$1" \
		node --experimental-strip-types "$ROOT/verify/mock-server.ts" > "$WORK/mock.out" 2>&1 &
	MOCK_PID=$!
	sleep 1
}

stop_mock() {
	curl -s "http://127.0.0.1:$PORT/__shutdown" >/dev/null 2>&1
	wait "$MOCK_PID" 2>/dev/null
	MOCK_PID=""
	sleep 0.3
}

run_pi() {
	local model="$1"
	ARK_KEY_POOL_CONFIG="$CFG" ARK_KEY_POOL_STATE="$STATE" ARK_KEY_POOL_LOG="$POOL_LOG" \
	ARK_KEY_POOL_PROVIDER=probe-ark \
	timeout 90 pi --no-extensions -e "$ROOT/verify/probe-provider.ts" -e "$ROOT/ark-key-pool.ts" \
		--no-session --no-tools -p "hi" --model "probe-ark/$model" 2>&1 | tail -3
}

show() {
	echo "--- mock 收到的请求序列 ---"
	awk '{print $4, $5, $6}' "$MOCK_LOG" 2>/dev/null
	echo "--- 池日志 ---"
	cat "$POOL_LOG" 2>/dev/null
	echo
}

run_case() {
	local name="$1" scenario="$2"
	echo "==================== $name ($scenario) ===================="
	rm -f "$STATE" "$POOL_LOG" "$MOCK_LOG"
	start_mock "$scenario"
	run_pi "probe-model"
	show
	stop_mock
}

run_case "场景1 正常（用主 Key）" "sk-pool-1:ok,sk-pool-2:ok"
run_case "场景2 额度耗尽（key-A 429 → key-B ok）" "sk-pool-1:429,sk-pool-2:ok"
run_case "场景3 Key 失效（key-A 401 → key-B ok）" "sk-pool-1:401,sk-pool-2:ok"
run_case "场景4 两个都耗尽（不得回落到 auth.json）" "sk-pool-1:429,sk-pool-2:429"

echo "==================== 场景5 额度冷却只影响出问题的模型 ===================="
rm -f "$STATE" "$POOL_LOG" "$MOCK_LOG"
start_mock "sk-pool-1:429@probe-model,sk-pool-2:429@probe-model"
echo "--- 第一次：probe-model 上两把 Key 都额度耗尽 ---"
run_pi "probe-model"
stop_mock
echo "--- 第二次：换成 probe-model-2，两把 Key 都正常 ---"
start_mock "sk-pool-1:ok,sk-pool-2:ok"
run_pi "probe-model-2"
show
stop_mock
echo "--- 状态文件（应看到 models 下只有 probe-model）---"
cat "$STATE" 2>/dev/null
echo
