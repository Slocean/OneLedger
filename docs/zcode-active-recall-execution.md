# ZCode 执行任务书：让 OneLedger 记忆在新任务中主动召回

状态：已实施（2026-09-29）。规则路径 10/11 未达 5/5，已按第 4 步部署用户级 SessionStart hook；hook 需 ZCode 重启后生效并做真实会话复验。验收记录见 `docs/zcode-active-recall-results.md`。

## 给 ZCode Agent 的任务

请在上述工作区**执行并验收**本任务书，交付代码或配置改动、验收记录和实际结果。先检查现有实现和配置，复用已经启用的 OneLedger MCP；自行完成连接、工具调用和测试，不把 MCP JSON、Bearer 密钥或手工测试步骤交给用户。用户只需处理 OneLedger Tauri 窗口按设计要求弹出的原生连接确认。不要把“已写计划”或“工具可手动调用”报告成主动召回完成。

严格遵守根目录 `AGENTS.md`：桌面管理台只用 Tauri；不用 Electron、Vite/tsx serve、浏览器网页壳；项目 `scopeId` 是仓库名，不运行 `git.exe` 猜名字；改完跑 `npm run check`，Rust 改动再跑 `cargo test --offline --lib`。发版前执行项目规定的版本、打包和 CI 检查。

## 本次范围与完成定义

目标是在 ZCode 以 OneLedger 为当前工作区开启**新项目任务**时，Agent 在开始项目分析或修改前取得 `memory.get({"scopeKind":"project","scopeId":"OneLedger"})` 的正式记忆。返回空数组时继续工作；相关的全局记忆按需读取。同一任务不重复读取同一版本，记忆与当前代码冲突时以核实后的代码和用户指令为准，并指出冲突。

至少 5 个不提示“用记忆”的全新 ZCode 项目任务都要发生正确召回，且有内容的场景能证明记忆影响了正确决策。自动加载 ZCode 自带 Memory、浏览 inbox、读取数据库原文或仅在任务说明中提及记忆，都不算 OneLedger 主动召回。

本次保留现有 `global / project / personal` 与整篇覆盖语义。历史积压治理、自动蒸馏和其他客户端接入以后实施。

## 已核实的基线

- 本机运行的 OneLedger Tauri 便携版为上一版本（0.4.14 的前一版）。账本有 14 条正式记忆、137,490 条待蒸馏材料；`distill.provider=none`。待蒸馏材料不对 Agent 召回。
- ZCode 用户级 `~/.zcode/cli/config.json` 已有启用的 `oneledger` **HTTP** MCP，目标是 `127.0.0.1` 的 `/mcp`，已有 Authorization 头。不要重复创建同名服务，也不要把现有密钥写到仓库或验收记录。
- `project:OneLedger` 在基线时无正式记忆。实施时先重读当前状态；不要据此假设以后仍为空，也不要覆盖新写入的内容。
- [ZCode MCP 文档](https://zcode.z.ai/en/docs/mcp-services)列明用户级配置路径、HTTP 连接与同名服务优先级。[ZCode Agent 文档](https://zcode.z.ai/en/docs/agents/)说明 ZCode 会在任务开始读取当前工作区根目录的 `AGENTS.md`；它不会逐级合并子目录的指令文件。
- ZCode 自带的 [Memory](https://zcode.z.ai/en/docs/memory) 是另一套按项目自动积累的记忆，是否启用需记录，但不能用它的召回代替本任务的 OneLedger MCP 验收。

## 执行顺序

### 1. 先证明现有连接可用

1. 按 `AGENTS.md` 做改动前检查，读取 ZCode 的 OneLedger MCP 配置时只输出服务名、类型、启用状态、URL 主机和路径；不要输出 Authorization 值。
2. 保持 Tauri 窗口运行。在 **ZCode Agent 本身**确认 `oneledger` 工具可见，调用 `memory.get`，传入 `scopeKind=project`、`scopeId=OneLedger`。记录返回状态、条数、耗时和工具调用证据；不要把记忆正文复制到诊断日志。
3. 若连接失败，先区分：Tauri 未运行、HTTP MCP 不兼容、密钥无效、工具未启用、原生连接确认未完成。由实施 Agent 修复可修复项并重试一次。不要用普通 HTTP POST 成功代替 ZCode MCP 真正连通的证据。

### 2. 增加最小的 ZCode 项目规则

在仓库根目录 `AGENTS.md` 的现有硬规则之后加入一个短小的 ZCode 专用段落，内容包含以下行为：

> 当执行环境是 ZCode 且当前工作区为 OneLedger，开始项目任务时先用 OneLedger MCP 的 `memory.get` 读取 `scopeKind=project`、`scopeId=OneLedger`。项目名固定为仓库名；不要用当前目录、worktree 名或文件路径作 `scopeId`。空结果继续任务；需要跨项目偏好时再读取 `global`。同一任务已取得相同版本时不重复读取。MCP 不可用时继续可独立完成的工作，并在结果中简短说明未取到记忆。不要把 inbox、草稿或 ZCode 自带 Memory 当作 OneLedger 正式记忆。

不要把这段规则放进子目录 `AGENTS.md`，也不要修改用户级 `~/.zcode/AGENTS.md` 来代替项目规则。ZCode 配置或规则改动后启动**新任务**验证，旧任务不能作为新配置生效的证据。

### 3. 用新任务验证行为

由实施 Agent 建立并检查以下场景。测试提示不出现“OneLedger 记忆”“MCP”“memory.get”等提示词：

1. 普通项目问题：在实质分析前调用 `memory.get(project, OneLedger)`，空结果也能继续。
2. 实际改动任务：在修改文件前调用相同工具；同一任务后续步骤不反复读取。
3. worktree 或子目录任务：`scopeId` 仍为 `OneLedger`，不用 `git.exe`、路径或 worktree 名作项目 ID。
4. 与已有全局正式记忆有关的任务：先做项目召回，再按需读取 `global`；在答复或改动中正确使用相关内容。当前有 1 条全局正式记忆，实施时需复核是否仍可用于安全、有效的测试。
5. MCP 暂时不可用：不编造记忆，任务尽可能继续，并准确说明限制；恢复连接后在新任务重新验证。

每项保存 ZCode 工具调用记录与 OneLedger 审计的对应证据：任务标识、调用时点、参数、返回条数、内容是否被正确使用、耗时、失败原因。审计能证明 `memory.get` 被调用；答复和改动才能证明内容被使用。验收记录保存为 `docs/zcode-active-recall-results.md`，只写 ID、rev、计数和必要短摘要，不写密钥或敏感正文。

如果现有全局记忆不适合内容使用测试，使用隔离账本和测试工作区准备无敏感信息的样本。不要把随机暗号写进用户正在使用的正式账本，也不要为测试直接改用户数据库。

### 4. 达不到稳定召回时的确定性方案

若 `AGENTS.md` 规则在 5 个全新项目任务中不能达到 5/5，继续完成本任务，不以“模型偶尔忘记调用”收尾。采用 ZCode 支持的 `SessionStart` hook 在新会话开始时读取 OneLedger 的正式项目记忆，并通过 `additionalContext` 注入模型。参考 [ZCode Hooks 文档](https://zcode.z.ai/en/docs/hooks) 的事件和输出协议。

实施约束：

- 当前 ZCode **不执行项目级 hook**。hook 放在用户级配置或受信任的本地插件中；不要把 `<workspace>/.zcode/config.json` 里的 hook 误当成生效配置。实施 Agent 自行安装、启用和测试，不让用户手工复制配置。
- hook 仅在工作区确认为 OneLedger 时工作；使用仓库根目录和 `.git` 存在性核对，不启动 `git.exe`。其他工作区无输出。`scopeId` 明确传 `OneLedger`。
- hook 通过已运行的 Tauri HTTP MCP 调用 `memory.get`，只接收服务端已经过滤的正式记忆；不得直读 SQLite/inbox。读取 ZCode 用户配置中的现有凭据时，不打印、不持久化、不转发原始 Bearer。stdout 只输出 ZCode hook 协议 JSON，诊断写不含秘密的 stderr。
- 注入内容设长度上限，保留作用域、ID、rev 与正文；连接超时或失败时不阻塞整个任务，向模型注入简短的“本次未取到 OneLedger 记忆”状态。启动、清空、压缩上下文后的行为分别测试，避免同一会话重复注入。
- 一个一次性 hook 进程可以使用 Node 执行脚本；它不是桌面管理台或常驻 `serve` 进程。用完确认没有遗留调试进程。

hook 实施后重新跑第 3 步全部场景。记录使用的是“Agent 调用 MCP”还是“hook 读取 MCP 并注入”；两者都要给出 ZCode 实际使用记忆的证据。

## 验收门槛与交付

- 五类场景通过，另做 5 个新的普通项目任务：每个新任务均在项目工作前取得 `project:OneLedger`，没有路径型或错误项目 `scopeId`。空结果、无关记忆和连接故障不会造成虚构内容。
- 记录 ZCode 自带 Memory 的开启状态；即使开启，也要以 OneLedger MCP 调用或 hook 输出为证据，不混算。
- 现有 Agent 权限边界保持：不暴露 inbox、蒸馏草稿、secret/pii 和已保存凭据原值；项目仓库及验收文件不含 Bearer。
- 改动前、改动后、启动前、提交前按 `AGENTS.md` 做全量检查。至少 `npm run check`；改 Rust 再跑 `cargo test --offline --lib`。若改 Tauri HTTP MCP，用打包的 Tauri 窗口做真实 ZCode 连接与调用，Linux `check` 和 Windows `CI` 通过后才发版。
- 交付：改动文件、`docs/zcode-active-recall-results.md`、实际调用证据摘要、任何剩余限制。若需要发版，六处版本号、`app_update.json` 公告、exe 内版本验证都按 `AGENTS.md` 执行。

## 回退

若只是项目规则试点，回退新增的 ZCode 段落即可。若用了用户级 hook，先停用对应 hook，再移除脚本或插件；不删除其他 ZCode MCP 服务，不修改现有 OneLedger 正式记忆。保留无密钥的验收记录，说明未达标的具体场景。
