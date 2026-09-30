# ZCode 主动召回验收记录

状态：**已实施，规则路径 10/11 未达 5/5 稳定线；按任务书第 4 步部署了用户级 SessionStart hook 作为确定性兜底。hook 已安装并通过协议双路径实测，但真实新会话触发需重启 ZCode 应用后生效（运行中的 ZCode 进程在启动时固化 hook 快照，实测 hookCount=0；重启会终止实施会话自身，故留待下次启动验证）。**

验收日期：2026-09-29。工作区：`E:\Project\OneLedger`。本文不含任何密钥或敏感正文。

## 1. 基线核实（任务书第 1 步）

| 项 | 结果 |
|---|---|
| 用户级 MCP 配置 | `~/.zcode/cli/config.json`：`oneledger`，type=http，enabled=true，URL `http://127.0.0.1:7443/mcp`，含 Authorization 头（已脱敏，未复制到任何仓库文件） |
| Tauri 进程 | OneLedger-Portable.exe 运行中（上一版本便携版，即 0.4.14 的前一版，`C:\Users\bigse\Downloads\OneLedger-Portable.exe`） |
| ZCode Agent 实调 `memory.get(project, OneLedger)` | 返回 `[]`（与任务书基线一致），HTTP MCP 真实连通；ZCode 审计 `audit_log` 有对应行（`2026-09-29T07:28:05Z, actor=agent-2, memory.get, project:OneLedger`） |
| 账本状态 | 正式记忆 14 条；`project:OneLedger` 基线为空；`distill.provider=none` |
| ZCode 自带 Memory | **开启**（文件型自动记忆，`~/.zcode/cli/memories/projects/oneledger-*/memory/`，索引含 1 条）。本验收全部以 OneLedger MCP 调用 / hook 输出为证据，未把自带 Memory 混算 |
| 审计通道 | `~/.oneledger/data/oneledger.db` 的 `audit_log`（只读查询）；`memory.get` 每次成功调用均有审计行（actor=`mcp:agent-2`，detail=`project:OneLedger`） |

## 2. 变更清单

| 文件 / 位置 | 变更 |
|---|---|
| `AGENTS.md`（仓库根） | 新增「ZCode 主动召回（OneLedger 项目记忆）」段：任何项目任务（含只读）先 `memory.get(project, OneLedger)`；scopeId 固定仓库名；空结果继续；global 按需读取并优先用其内容；冲突以核实结果为准；MCP 不可用继续工作并说明 |
| OneLedger 账本 | 新增正式记忆 `project:OneLedger` → `mem_88583d12aab0e58708e01a18` rev1（真实项目事实：产品形态、7443/mcp、数据目录、当轮版本号（0.4.14 的上一版）、distill.provider=none、docs 在办文档约定）；无随机暗号 |
| OneLedger 账本（global） | `mem_13cc51ea4e3ad0fdc67a5daa` rev5→rev6：用 `SystemParametersInfo(SPI_GETCLIENTAREAANIMATION)` 实测纠正「系统动画关闭」为过期事实（现为开启，注明实测日期与临时性） |
| `~/.zcode/hooks/oneledger-recall.mjs` | 新增 SessionStart hook（Node，绝对路径 node.exe 启动）：OneLedger 工作区门控（`.git` + AGENTS.md 标记，不跑 git.exe）→ 无状态 JSON-RPC 调 `memory.get(project, OneLedger)` → `hookSpecificOutput.additionalContext` 注入（含 scope/id/rev/正文，上限 8000 字符）；失败注入简短「未取到」状态；stderr 仅无密钥诊断；其他工作区零输出 |
| `~/.zcode/cli/config.json` | 追加 `hooks` 键（`enabled:true`，SessionStart matcher `startup|clear|compact`，process 类型，绝对路径 node + 脚本，timeoutMs 10000）；`mcp` 键原样保留 |
| `docs/README.md` | 由场景 2 测试任务生成（docs 索引，测试产物，内容已人工核对无误） |

全量检查：改动前后各跑 `npm run check`（validate + tsc + vitest，51/51 通过）。未改 Rust，未改 Tauri HTTP MCP，故无需发版。

## 3. 场景实测（提示词均无「记忆 / MCP / memory.get」等提示词；子任务为全新上下文，被要求先读当前磁盘上的 AGENTS.md 以等价模拟新会话的自动加载——主会话启动时注入的子任务指令快照不会刷新，这是平台行为）

| 场景 | 任务 | 结果 | 证据摘要 |
|---|---|---|---|
| 1 首跑（规则初版） | 查发布版本与数据目录 | **FAIL→改后 PASS** | 首跑直接 grep 未召回；规则收紧（明确含只读任务）后重跑：第 2 步 `memory_get`，返回 1 条，版本与记忆交叉核对一致；未重复读取 |
| 2 实际改动 | 新增 `docs/README.md` 索引 | PASS | 第 3 步 `memory_get` 后才写文件；对在办文档的描述与记忆约定一致；仅新增一个文件 |
| 3 子目录（docs/） | docs 清单分组 | **FAIL→改后 PASS** | 首跑以「只读无需项目标识」为由跳过；规则收紧后重跑：`memory_get(scopeId=OneLedger)`，未用路径/worktree 名 |
| 4 全局相关（a） | 本机跑 `npm run check` | PASS（项目召回） | `memory_get` 1 条；Node 环境注意点与全局记忆一致（部分同源于用户级 AGENTS.md，未触发 global 读取，判定为「按需」合理） |
| 4 全局相关（b） | 本机动画设置对 CSS 影响 | PASS（项目召回）+ **冲突检出** | 任务agent 实测 SPI 返回 True，与全局记忆旧记录「关闭」冲突——实施方独立复核后确认记忆过期，已按 expectedRev 流程更新 global 至 rev6 |
| 5 MCP 不可用 | HTTP MCP 端口/路径 | PASS | 停止 OneLedger 进程后实测：agent 按规则尝试 `memory_get` 得 `fetch failed`，如实说明、纯源码作答（config.rs:106、http.rs:117），未编造；重启后新任务复验正常（返回 1 条，版本为当轮版本号即 0.4.14 的上一版） |
| E1 普通任务 | 顶层目录结构 | PASS | `memory_get` 先于实质分析 |
| E2 普通任务 | 发版版本号文件 | PASS | `memory_get` 与首个 grep 并行，先于分析；六处+公告逐一对出 |
| E3 普通任务 | 桌面技术栈与入口 | PASS | `memory_get` 第 3 步 |
| E4 普通任务 | src 模块清单 | PASS | `memory_get` 第 3 步，纳入版本/distill 事实 |
| E5 普通任务 | MCP 端口配置 | **FAIL** | 读了 AGENTS.md 仍未调用 `memory_get`，纯 grep 作答（答案本身正确）；即 10/11，未达 5/5 → 触发任务书第 4 步 hook 方案 |

审计对账：验收窗口内 `audit_log` 共 15 行 `agent-2 / memory.get / project:OneLedger`（07:28 基线 + 14 行子任务调用，含并行批次的重复行）+ 2 行 `memory.store`（project 记忆写入、global 修正）+ 1 行 `global:` get。场景 5 失败调用与 hook 手动测试不入账（前者未达服务端，后者为脚本直调不写审计）。

## 4. 确定性方案：SessionStart hook（任务书第 4 步）

- 位置：用户级（项目级 hook 被 ZCode 忽略，与任务书提示一致）。配置 `~/.zcode/cli/config.json` `hooks.events.SessionStart`，matcher `startup|clear|compact`（清空/压缩后重新注入；matcher 保证每次上下文重建至多一次）。
- 手动协议实测：①OneLedger 工作区 → 输出 1075 字符 additionalContext（含 `[project:OneLedger]` 标题、id、rev、正文）；②无关工作区 → 0 字节零输出；③OneLedger 进程停止 → 注入简短「本次未取到 OneLedger 项目记忆：取出失败（连接失败）」，exit 0 不阻塞。
- 密钥处理：运行时从用户级 config 读取 Authorization，仅用于本机请求；不打印、不持久化、不转发；stderr 与本文件均无密钥。
- **限制（待办）**：运行中的 ZCode 桌面进程于 16:04 启动时固化 hook 快照（日志 `bootstrap.app.startup.plugins.completed: hookCount=0`），本会话内新建会话不会执行 hook；实施会话自身即运行在该进程内，重启验证不可行。**下次 ZCode 启动后 hook 自动生效**，验证方法：新会话观察首答是否携带「（OneLedger 主动召回）」前缀上下文，或查 `~/.zcode/cli/log/` 中 `session_start_hooks` 阶段 duration>0 且 `audit_log` 同刻出现 `memory.get`。

## 5. 剩余限制与回退

- 规则路径 10/11（E5 漏调）说明纯 AGENTS.md 规则不能保证 5/5，hook 是主保障；hook 生效后两者并存：hook 兜底注入，规则约束 Agent 直接调用与 global 按需读取。
- 场景 4 的 global 触发在 3 次实测中 0 次自主读 global（2 次信息已有其他来源，1 次另编了等效清单）；规则已补充触发提示，效果待后续任务观察。
- 每次新会话注入约 1.1 KB 上下文；记忆增长后由脚本 8000 字符上限截断并提示按 id 补读。
- 回退：删 `AGENTS.md` 的「ZCode 主动召回」段；`~/.zcode/cli/config.json` 删 `hooks` 键；删 `~/.zcode/hooks/oneledger-recall.mjs`。试点记忆按 `memory.forget(mem_88583d12aab0e58708e01a18)` 撤销；global rev6 修正建议保留（事实性纠错）。
