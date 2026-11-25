# ark-key-pool

> assistant-agent（Kit）名下的子项目 · 本项目规则本体

给 pi 的火山方舟 Agent Plan 做多 Key 池的扩展：一个账号的 Key 额度用完或被拒，请求自动落到下一个账号。单文件 `ark-key-pool.ts`，`./install.sh` 装进 `~/.pi/agent/extensions/`。

## 归谁负责

本项目由 **Kit**（assistant-agent）负责维护。改动范围跨出本项目时，先向 Kit 说明，不自行扩张改动面。

## 你的角色

角色由「cwd 所在项目 + 当前是否停在 main」决定（2026-11-25 全局口径，详见 `~/.pi/agent/AGENTS.md`「Leader / Worker 的定义」与 `~/.pi/agent/docs/agents-registry.md` 第 5 条）：

- **subLeader**：本项目主工作区停在 main 时——只管本项目自身：local main 只做 `git fetch` + `git merge --ff-only`；任务从自身 main 拷出 worktree 后派给 Worker；按全局工作流合并本项目 PR、发本项目的版、回收自己的 Worker。对上游 assistant-agent 与兄弟子项目只读。
- **Worker**：本项目的非 main 分支 worktree 里（主工作区被切到非 main 时同样算）——只干当前 worktree 里的这一件事：读代码、改代码、跑测试，走 `/add` → `/commit` → push 自己的分支并开 PR；干完向派它的 Leader 汇报（改了什么、验证结果、PR 号、遗留问题）。不碰 local main、不建删 worktree、不合并 PR、不发版。
- 上下文不够时向 Kit 问，不要凭猜测改代码。
- 本项目的硬约束与验证要求写在 `.pi/APPEND_SYSTEM.md`（会话启动时自动加载），动代码前先看一遍。

## 项目规则在哪

| 内容 | 位置 |
|---|---|
| 本项目硬约束、验证要求、易踩的坑 | `.pi/APPEND_SYSTEM.md`（自动加载） |
| 开发 / 构建 / 发版全流程 | `DEVELOPMENT.md`、`README.md` / `README_cn.md` |
| 待办 | `TODO.md`（已处理进 `TODO-archive.md`） |
| 改动记录 | `CHANGELOG.md` |
| 团队通用规则（git 流程、敏感信息、Leader / Worker 分工等） | 全局 `~/.pi/agent/AGENTS.md` |
