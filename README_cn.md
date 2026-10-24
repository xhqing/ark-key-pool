<div align="center">
  <img src="assets/logo.svg" alt="ark-key-pool" width="640">

  [![License: MIT](https://img.shields.io/badge/License-MIT-yellow)](LICENSE.md)
  [![Version](https://img.shields.io/badge/Version-0.1.1-blue)](CHANGELOG.md)
  [![Type](https://img.shields.io/badge/Type-pi%20extension-6E56CF)](#)

  [English](README.md)
</div>

# ark-key-pool

> 给 [pi](https://pi.dev) 里的火山方舟 Agent Plan 做多 Key 自动切换——一个账号的 Key 额度用完或被拒，请求自动落到下一个账号继续跑。

一个 pi 扩展，把「单凭证 provider」变成 Key 池：每次请求用第一个健康的 Key，失败就给该 Key 写冷却（跨进程共享），pi 自己的重试机制会把请求带到下一个账号上。

## 为什么需要

pi 的凭证模型是**一个 provider 一份凭证**（`auth.json` 里一条 Key），核心机制里没有 Key 轮换，也没有故障切换。火山方舟 Agent Plan 的两种情况：

- `429 AccountQuotaExceeded`：5 小时 / 每周额度用完；
- `401`：Key 失效或被吊销。

pi 会用同一个 Key 重试三次然后放弃。有两个账号时，一条 Key 挂了另一条只能在旁边干看着。

## 安装

```bash
./install.sh
```

脚本会把 `ark-key-pool.ts` 部署到 `~/.pi/agent/extensions/`；如果还没有配置文件，会复制模板到 `~/.pi/agent/ark-agent-plan-keys.json` 并设为 `0600` 权限。装完在 pi 里执行 `/reload`（或新开会话）生效。

## 配置

```json
{
  "provider": "volcengine-agent-plan",
  "keys": [
    { "name": "主账号", "key": "sk-..." },
    { "name": "备用账号", "key": "sk-..." }
  ],
  "cooldown": {
    "authSeconds": 600,
    "rateLimitSeconds": 60,
    "quotaSeconds": 1800,
    "maxSeconds": 86400
  },
  "retryAuthErrors": true
}
```

- **至少要两个 Key**；只有一个 Key（或没有配置文件）时，扩展完全不介入，行为与原来一致。
- Key 按配置顺序使用：主 Key 冷却时才落到备用，冷却到期自动回切。
- `quotaSeconds` 是额度冷却的**起步时长**（默认 30 分钟）：同一把 Key 在同一个模型上反复报额度耗尽时，每次都翻倍（30 分钟 → 1 小时 → 2 小时……），同时不超过响应里的 `reset at` 时间，也不超过 `maxSeconds`（默认 1 天）。这样做是因为实测同一把 Key 报「weekly usage quota exceeded」后十分钟内又能正常请求，一次就停用一整天会把整个池子拖死；真有额度用完的情况，几次翻倍后自然落到天数级。
- `retryAuthErrors: false` 关闭 401/403 的错误改写；Key 失效就只会在下一次请求时才切换。

`auth.json`（或环境变量 `ARK_AGENT_PLAN_API_KEY`）里仍要保留**一条** Agent Plan Key——pi 在扩展的 header 钩子之前会先校验 provider 凭证。池里的 Key 会在每次请求时覆盖它，两者重复也没关系。

> 配置文件里是真实凭证：权限 `0600`、放在仓库之外，永远不要提交。

## 冷却粒度

| 错误 | 冷却范围 | 原因 |
|---|---|---|
| `401` / `403`（Key 失效） | 整把 Key | Key 本身不能用了，所有模型都跳过 |
| `429 AccountRateLimitExceeded`（限流） | 整把 Key | 限流按账号算，跟模型无关 |
| `429 AccountQuotaExceeded`（额度耗尽） | **该 Key 的该模型** | 实测额度是按模型算的：同一把 Key 的某个模型额度用完，跑别的模型照样正常，所以不能整把停用 |

任何一次请求成功，都会顺手清掉这把 Key 当前的（可能多余的）冷却和翻倍计数。

## 工作原理

| 钩子 | 做什么 |
|---|---|
| `before_provider_headers` | 从池里挑一把 Key 覆盖 `Authorization`（健康 Key 优先；全在冷却时挑最早解冻的，**绝不静默回落到 `auth.json` 里那把**） |
| `message_end` | 识别 401/403/429，给「本次请求实际用到的那把 Key」写冷却（落盘、跨进程共享）；成功则清掉该 Key 的冷却 |
| `before_agent_start` | 清空本轮「已尝试」记录 |

自动切换靠两个机制：

1. **额度耗尽**本身返回可重试错误（`429`），pi 重试时会重新进入 `before_provider_headers`，此时自然选中下一把 Key。
2. **认证失败**（`401`/`403`）pi 本来不重试。扩展把 `errorMessage` 改写成可重试形态（前缀加 `429`），让 pi 的重试带着下一把 Key 继续跑。

池里一把可用的 Key 都没有时，扩展会把现状写进错误信息（形如 `429 rate limit (ark-key-pool: key "备用账号" no healthy key left — 主账号=quota 23h58m，备用账号=rate 45s): …`），不必再翻日志猜到底是哪把 Key 卡住了。

## 命令

```
/ark-key-pool          # 查看各 Key 状态（整把冷却 / 各模型的额度冷却与次数）
/ark-key-pool reset    # 清除全部冷却
```

## 状态与日志

- 状态：`~/.pi/agent/state/ark-key-pool.json`——只存 Key 的 SHA-256 前缀，不落明文。
- 日志：`~/.pi/agent/state/ark-key-pool.log`——超过 1MB 截断，保留最后 2000 行。

冷却状态落在磁盘上，所以多个 pi 进程共用同一个池时，一个进程判死的 Key 其他进程也会跳过。

## 已知边界

- **只对 `volcengine-agent-plan` 生效**，不影响其他 provider。
- **不改模型可见性**：模型列表按 `auth.json` 里那条 Key 的套餐档位展示。用备用 Key 调它没有的模型会得到 401/403 并触发冷却，属预期行为。
- **依赖错误文本匹配**：pi 判断「可重试」靠错误消息里的关键词（`429` 等），这是 pi 的内部约定，pi 大版本升级后建议回归验证一次。
- **额度判定按模型记录**：响应里没有模型归属信息，扩展用的是「本次请求的模型」。同一个账号的额度如果是跨模型共享的，某个模型的额度冷却不能代表整把 Key 的状态（这里按模型记，宁可多试一次，也不整把停用）。
- 冷却按 Key 哈希记录，换 Key 内容后旧条目会残留（无害）。

## 自己验证

```bash
bash verify/run-tests.sh
```

对本地 mock 跑五个场景（正常、额度耗尽、Key 失效、两个都耗尽、额度冷却只影响出问题的模型），不消耗任何真实额度。

## 许可证与署名

Copyright (c) 2026 All Contributors。基于 [MIT License](LICENSE.md) 发布。

署名：使用或引用本项目时，请保留版权声明并注明来源：[ark-key-pool](https://github.com/xhqing/ark-key-pool)。
