# ark-key-pool

> assistant-agent（Kit）名下的子项目 · 本项目规则本体

给 pi 的火山方舟 Agent Plan 做多 Key 池的扩展：一个账号的 Key 额度用完或被拒，请求自动落到下一个账号。单文件 `ark-key-pool.ts`，`./install.sh` 装进 `~/.pi/agent/extensions/`。

## 归谁负责

本项目由 **Kit**（assistant-agent）负责维护。改动范围跨出本项目时，先向 Kit 说明，不自行扩张改动面。

## 你的角色

本项目主工作区 main 分支的会话是 **subLeader**（管本项目：local main 只做 ff 同步、从 main 建删任务 worktree、派 Worker、合并 PR、发版、回收 Worker）；worktree 里的会话是 **Worker**：只做当前 worktree 里的这一件事，干完向 subLeader（Kit 的 agentLeader）汇报——改了什么、验证结果、PR 号、遗留问题。

- **Worker 不碰 local main、不建 / 删 worktree**——建删 worktree、ff 同步 local main 由 subLeader（本项目主工作区 main 会话）负责，Kit 的 agentLeader 可代管。
- 上下文不够时向 Kit 问，不要凭猜测改代码。
- 本项目的硬约束与验证要求写在 `.pi/APPEND_SYSTEM.md`（会话启动时自动加载），动代码前先看一遍。

## 项目规则在哪

| 内容 | 位置 |
|---|---|
| 本项目硬约束、验证要求、易踩的坑 | `.pi/APPEND_SYSTEM.md`（自动加载） |
| 开发 / 构建 / 发版全流程 | `DEVELOPMENT.md`、`README.md` / `README_cn.md` |
| 待办 | `TODO.md`（已处理进 `TODO-archive.md`） |
| 改动记录 | `CHANGELOG.md` |
| 团队通用规则（git 流程、敏感信息、agentLeader / subLeader / Worker 分工等） | 全局 `~/.pi/agent/AGENTS.md` |
