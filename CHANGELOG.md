# Changelog

### 新增（CI 门禁：validate 检查 + main 分支 strict 保护）

- **为什么改**：用户 2026-11-03 立规「新建仓库一律必须 strict 模式的 PR CI」，并要求 28 个不合规的存量仓库统一执行最新标准。本项目此前在 PR 上没有门禁——改动合进 main 全靠人工把关，PR 可以拿旧 main 上通过的检查直接合并，回归防护存在缺口。本次补齐团队要求的「三件套」：PR 上真实跑的 CI 检查 + 挂成 required status check + `required_status_checks.strict = true`。
- **改了什么**（2026-11-03）：新增 `.github/workflows/validate.yml`（PR 与 main push 触发，检查名 `validate`）与 `.github/scripts/validate.py`（仓库卫生检查：必备文件存在、敏感文件未被跟踪、被跟踪文件不超过 10 MB、README 相对链接有效、Python / Shell 语法检查）；main 分支保护补挂 required check `validate` 并设 `strict=true`。
- **边界**：检查只做确定性、低误报的项目（required check 一旦误报就会卡住正常 PR，所以宁可少查）；不改动仓库任何原有内容。

## [未发布]

### 新增（子项目专属规则文件 `.pi/APPEND_SYSTEM.md`）

- **为什么改**：用户 2026-11-07 定下全局 Leader / Worker 分工——子项目的具体活由「以子项目根目录 / 子项目 worktree 为工作目录」的 Worker 会话干，而 pi 只加载 cwd 那一层的 `.pi/`（不向上继承）。子项目专属的硬规则没有别的地方可放：写进 Agent 项目的 `AGENTS.md` 既不会被 Worker 加载，也会污染其它兄弟子项目。
- **改了什么**：新增 `.pi/APPEND_SYSTEM.md`（45 行），只写本项目特有的硬约束——扩展代码的语法红线（pi 一个扩展解析失败就整体退出，改完必须跑 `ts-syntax-check`）、只用 `install.sh` 部署（不 `npm link`）、验证方式（`verify/run-tests.sh` 的 mock 场景）、不许破坏的五个既有行为（少于两把 Key 不介入、冷却粒度、成功清冷却、pick 永不返回空、仅在有可用 Key 时覆盖 header）、敏感信息的处理红线（仓库只有 `.example`、真实 Key 只在本机 0600 配置里）、发布不带产物。全局规则与 Kit 身份仍来自仓库根 `AGENTS.md` 软链接，文件里不重述、不覆盖。
- **影响**：纯新增规则文件，不改扩展源码、安装脚本与 CI；不涉版本号（文档类改动不发版）。

### 变更（`.pi` 由软链接改为真实目录 + 资源引用：全局规矩 2026-10-30 修订）

- **为什么改**：2026-10-30 用户修订了子项目的智能体专属文件规则。旧形态把 `.pi` 整个挂成指向负责 Agent 的软链接，「共享」与「独占」被压在同一个符号上：子项目要放自己的配置时无处安放，硬写进 `.pi` 等于直接写进 Kit 的 Agent 项目——会瞬间影响全部兄弟子项目、并进 Agent 仓库的 git 历史。新规则分层：身份层（`AGENTS.md`）继续保持软链接一致（pi 的上下文文件没有 include 机制，超集只能靠复制、复制必然漂移）；能力层（`.pi/`）改在子项目里建真实目录，用 `settings.json` 以**路径引用** Agent 项目的资源目录，本地专属内容放自己的目录。
- **改了什么**：删除 `.pi` 软链接（原指向 `../ExecutiveAssistantAgent/.pi`），改为真实目录加 `.pi/settings.json`：`extensions` / `skills` / `prompts` / `themes` 四组各指向 `~/Developer/ExecutiveAssistantAgent/.pi/` 下对应目录，并附带本地同名目录。`AGENTS.md` 软链接保持不变。本项仅涉及开发环境配置，**不影响扩展行为与发布产物**，不涉版本号。
- **验证**：据 pi 官方文档（`settings.md`「Resources」、`skills.md` / `extensions.md`）；同批在 `xhqing` 子项目实跑 `pi --approve -p`，技能与项目级扩展均从 Agent 项目加载成功。
- **规则出处**：全局 `~/.pi/agent/docs/agents-registry.md`「智能体专属文件归属与子项目映射（2026-10-30 修订）」节。

## [0.1.1] - 2026-10-24

### 修复

- **冷却记错对象**：原实现用「上一次 pick 的 Key」给错误安排冷却，一旦某次请求没插池里的 Key（见下条），错误就会被算到另一把 Key 头上——日志里出现过连续多次 `cool 备用账号` 却没有任何 pick 的诡异记录。现在每次请求都记录「实际插进 header 的那把 Key + 模型」，冷却只认它；没插过池里的 Key 就跳过不记。触发原因：2026-10-24 排查用户遇到的一串 429。
- **池子试完一圈后静默回落到 `auth.json` 里那把 Key**：`pickKey` 在「全部 Key 都试过」时返回 `undefined`，header 不做覆盖，pi 就用 `auth.json` 的凭证——而那正是池里已经失败的那把，于是同一把死 Key 被反复打，用户只看到一串一模一样的 429（本地 mock 场景 4 已复现，请求序列里出现 `sk-auth-json-fallback`）。现在永不返回空：健康 Key 优先，全在冷却时挑最早解冻的，全试过时挑最早解冻的复用，并在日志里区分 `pick` / `pick#cooling` / `pick#reuse`。
- **额度耗尽的冷却范围过宽**：原来一次 `429 AccountQuotaExceeded` 就把整把 Key 停用最多 24 小时。实测同一把 Key 的额度是按模型算的（同一时刻 `doubao-seed-2.0-mini` 报额度耗尽、`deepseek-v4.1-flash` / `glm-5.3-flash` 正常返回），且报「weekly usage quota exceeded」后十分钟内又能正常请求——一次误报就停用一整天，等于把整个池子拖死。现在额度冷却按「Key + 模型」记录，并按次数翻倍（`quotaSeconds` 起步 30 分钟，逐次翻倍，不超过响应里的 `reset at` 与 `maxSeconds`）。
- **去重把不同 Key 的同样报错吞掉**：原来只比对错误文本，同一份错误文本换了一把 Key 也会被当成「同一次错误」跳过冷却（本地 mock 场景 4 里 key-B 因此没被冷却）。现在指纹带上 Key 哈希与模型。
- **冷却期内的退路重试不再累加翻倍**：同一轮里把仍处于冷却中的 Key 当退路重试，只续期、不增加「事故次数」，避免一次报错在几秒内被翻倍到几小时。

### 新增

- 池子里没有可用 Key 时，错误信息末尾会带上池子现状（形如 `no healthy key left — 主账号=quota 23h58m，备用账号=rate 45s`），不用翻日志就能看出是哪把 Key 卡住了。
- 任何一次请求成功都会清掉该 Key 当前的（可能多余的）冷却与翻倍计数——被误判的 Key 立刻恢复可用。
- `/ark-key-pool` 现在会分列「整把冷却」与「各模型的额度冷却 + 已翻倍次数」。

### 变更

- `quotaSeconds` 的语义从「解析不到重置时间时的兜底值」改为「额度冷却的起步时长」；中英双语 README 同步更新。
- `verify/run-tests.sh` 扩到五个场景（新增「额度冷却只影响出问题的模型」），mock 支持按模型限定故障、每次报错带唯一 Request id；探测 provider 增加第二个模型。

## [0.1.0] - 2026-10-22

### 新增

- 首次发布：`ark-key-pool`——pi 的火山方舟 Agent Plan 多 Key 自动切换扩展。
- 能力：Key 池按顺序使用；401/403/429 自动写冷却（落盘、跨进程共享）；额度耗尽走 pi 原生重试自动换 Key；401/403 通过改写 `errorMessage` 变成可重试、同样自动换 Key；冷却时间优先按响应里的 `reset at` 解析，上限 1 天；`/ark-key-pool` 查看状态、`/ark-key-pool reset` 清除冷却。
- 配套：`install.sh` 一键部署与配置模板；`verify/` 下本地 mock 与四个场景验证脚本（零真实额度消耗）；中英双语 README。
- 验证：本地 mock 四场景全过（正常 / 额度耗尽 / Key 失效 / 两个都耗尽），另验证跨进程冷却共享与冷却到期自动恢复。
