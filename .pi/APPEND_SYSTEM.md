# ark-key-pool · 项目硬约束

身份与角色见本仓库根 `AGENTS.md`；团队通用规则见全局 `~/.pi/agent/AGENTS.md`，此处不重述。

## 这是什么

给 pi 的火山方舟 Agent Plan 做多 Key 池的扩展：一个账号的 Key 额度用完或被拒，请求自动落到下一个账号。实现是单文件 `ark-key-pool.ts`，`./install.sh` 把它复制到 `~/.pi/agent/extensions/`，配置在仓库外的 `~/.pi/agent/ark-agent-plan-keys.json`（`0600`）。

## 扩展代码的红线

1. **pi 只要有一个扩展解析失败就整体退出**——一个字符写坏的不是「这个小功能坏了」，而是所有会话起不来。改完 `ark-key-pool.ts` 必须跑语法检查，通过才算改完：

   ```bash
   node ~/.pi/agent/patch/ts-syntax-check/check.mjs
   ```

   最常见成因是模板字符串里未转义的反引号（内部反引号要写 `\``）。
身份与角色见本仓库根 `AGENTS.md`；团队通用规则见全局 `~/.pi/agent/AGENTS.md`，此处不重述。

## 验证方式

```bash
bash verify/run-tests.sh    # 本地 mock server 跑 Key 池场景，零真实额度消耗
```

改冷却、轮换、错误分类逻辑**必须**先跑它并把结果看完整；`verify/work/` 是产物、已在 `.gitignore` 内。涉及真实 provider 的行为只能在装好后的 pi 会话里验证，别拿真 Key 反复打。

## 不许破坏的既有行为

1. **少于两把 Key（或缺配置）时扩展完全不介入**，行为与没装扩展一致。
2. **冷却粒度**：`401` / `403` 与限流（`AccountRateLimitExceeded`）按**整把 Key**；额度耗尽（`AccountQuotaExceeded`）按**「Key + 模型」**，并按次数翻倍（起步 `quotaSeconds`，不超过响应里的 `reset at` 与 `maxSeconds`）。
3. **任何一次成功都清掉该 Key 的冷却与翻倍计数**。
4. **pick 永不返回空**：健康 Key 优先，全在冷却时挑最早解冻的复用——避免回落到 `auth.json` 里那把已经失败的 Key。
5. **只在有池内 Key 可用时覆盖 header**；错误信息里保留池子现状（`主账号=quota 23h58m` 这类），别抹掉。

## 敏感信息处理（硬性）

- 仓库里**只放** `ark-agent-plan-keys.json.example`（占位符）。
- 真实 Key 只存在于本机 `~/.pi/agent/ark-agent-plan-keys.json`（`0600`、已被 `.gitignore` 忽略）。
- 任何情况下不把真实 Key 写进仓库文件、提交信息、PR 正文、测试输出或报错日志；测试一律用 `sk-pool-1` 这类假值。
- 状态文件只存 Key 的 SHA-256 前缀，这条设计不要改成存明文。

## 发布渠道

GitHub Release，**不带产物**（扩展是源码单文件，靠 `install.sh` 复制部署）。版本号单一权威是 `VERSION`，双语 README 徽章、CHANGELOG 条目必须与它一致。
