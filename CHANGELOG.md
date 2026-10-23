# Changelog

## [0.1.0] - 2026-10-22

### 新增

- 首次发布：`ark-key-pool`——pi 的火山方舟 Agent Plan 多 Key 自动切换扩展。
- 能力：Key 池按顺序使用；401/403/429 自动写冷却（落盘、跨进程共享）；额度耗尽走 pi 原生重试自动换 Key；401/403 通过改写 `errorMessage` 变成可重试、同样自动换 Key；冷却时间优先按响应里的 `reset at` 解析，上限 1 天；`/ark-key-pool` 查看状态、`/ark-key-pool reset` 清除冷却。
- 配套：`install.sh` 一键部署与配置模板；`verify/` 下本地 mock 与四个场景验证脚本（零真实额度消耗）；中英双语 README。
- 验证：本地 mock 四场景全过（正常 / 额度耗尽 / Key 失效 / 两个都耗尽），另验证跨进程冷却共享与冷却到期自动恢复。
