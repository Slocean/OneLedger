# OneLedger Agent 硬规则（必须遵守）

这些是命令，不是建议。违反即做错。

## 桌面壳：只许 Tauri

- **禁止 Electron。** 禁止安装、启动、调试、打包、文档推荐 Electron / electron-builder / `desktop/main.mjs`。
- **禁止** `npx electron`、`npm run desktop`（旧 Electron 脚本已删除）、任何 `electron.exe`。
- 本地开发和发版窗口 **只能是 Tauri**：`npm run pack` / `tauri:build` 打出的 exe，或 `tauri dev` 的 **Tauri 窗口**。
- 管理台必须是 **Tauri 窗口**，不是让用户去浏览器打开网页。
- 需要起本机程序时：起 Tauri。不要起纯网页服务然后甩 `http://127.0.0.1:7443/` 当交付。

## 禁止 Vite / tsx 当壳（违反即错）

- **禁止**把 Vite、tsx、Node serve 当桌面壳或管理台。
- **禁止**起或留下这些进程：`vite`、`vite --config …`、`npm run dev:server`、`tsx src/index.ts serve`、`npx tsx … serve`。
- **禁止**让用户去打开 vite / tsx 文件、配置或进程。用户机器上不准挂着 OneLedger 的 Vite / tsx。
- `npm run dev` 里的 Vite **只许一次性 `vite build`**，打完前端必须结束。禁止起 Vite 开发服务器，禁止验证完不关。
- 本机验证优先用打好的 `OneLedger.exe` / Portable / Setup。自己起的调试进程，用完必须杀掉。
- **禁止**为了采集 / 认仓库名在用户机器上启动 `git.exe` 或弹出命令窗口。只认目录里的 `.git`。

## 自己干完，禁止把用户当 Agent

- 需要测 MCP：Agent **自己连、自己签发、自己调用**。禁止把 MCP JSON / Bearer 丢给用户让他自己去配、去连。
- 禁止用「你去打开这个地址」「把这段配进 Cursor」代替你自己操作。
- 禁止甩一长串自测 PASS 报告当交付；做完用产品窗口验证。

## 每次必须全量检查（违反即错）

- 动手前、改完、启动前、提交前、发版前，**必须全量检查**：所有相关功能，所有已知错误，不准只改嘴上说的那一点。
- 至少跑：`npm run check`（validate + tsc + vitest）。Rust 改了还要 `cargo test --offline --lib`。失败必须先修，**不准推、不准打 tag、不准说修好了**。
- Linux 的 `check` 和 Windows 的 `CI` 都要过。红的检查不准当没看见。
- 禁止只改一处就发版。项目里已经红的测试、打包失败、弹窗、闪屏，本次必须处理。

## 发版必升全部版本号（违反即错）

升版本时**六处必须全部同步**，漏一处即返工：

1. `package.json` 的 `version`
2. `src-tauri/tauri.conf.json` 的 `version`
3. `src-tauri/Cargo.toml` 的 `version`（跑 `cargo update -p oneledger --offline` 刷 Cargo.lock）
4. `package-lock.json`（`npm install --package-lock-only`）
5. `src/types.ts` 的 `export const APP_VERSION`（TS 硬编码，检查更新与 HTTP status 用它）
6. `src-tauri/src/util.rs` 的 `pub const APP_VERSION: &str`（Rust 检查更新的本地版本比对、旧进程检测都靠它）

另外：`app_update.json` 顶部必须新增本版公告条目（validate-release.mjs 会校验它与 package.json 一致）。

- 改完必须 `grep -rn "旧版本号"` 全仓库复核，只允许 `app_update.json` 历史条目里出现旧版本号。
- 打完包必须验证 exe 里嵌的是新版本号（如 `grep -aoc "0\.4\.10" src-tauri/target/release/oneledger.exe`），不准只看打包成功就交。
- 已推出的 tag 若发现版本号漏改：修复提交后把 tag 移到修复提交强推（`git tag -f` + `git push -f`，前提是 GitHub Release 还没发）。

## 账本与采集

- **禁止推倒重写。** 已有 `scopeKind`（global / project / personal）+ `scopeId` 覆盖语义，不要新开一套账本。
- `scopeId` 必须是 **仓库名**（如 `CofoeAirLink_Web`），禁止用文件相对路径当项目 id。
- 采集只收约定文件 / 会话摘要 / `.workbuddy/memory`；排除 `vendor_imports`、`site-packages`、`modify_backup`、虚拟环境、插件缓存、Blender 资源。
- Agent MCP：记忆工具 search / remember / forget / list / get / export / import；桌面版 HTTP MCP 另有凭据目录 list 与需 Tauri 原生逐次确认的 put / organize / delete。memory.export 只导出可共享的记忆子集（不含 secret/pii 记忆、收件箱、凭据密文与密钥材料）；memory.import 需 Tauri 原生确认后按 id 合并（记忆仅当文件 rev 更新时覆盖）。独立的 stdio MCP 只提供记忆读写工具，不含 export/import。Agent 禁止读取 inbox 或已保存的凭据原值；凭据 MCP 不提供 reveal。已有 list/search 权限的密钥自动拥有 get、export 与凭据目录 list；remember 权限对应凭据写入整理与备份导入；forget 权限对应凭据删除。
- 桌面版 HTTP MCP 保留 Agent Bearer 密钥，并在每把密钥从同一来源地址首次连接时要求 Tauri 原生确认；确认弹窗带「记住此设备」勾选框，勾选后该密钥与地址组合持久化进 SQLite（trusted_mcp_sources），连接不再询问，MCP 密钥页必须提供撤销入口。记住只豁免连接确认；vault.put / vault.organize / vault.delete 的逐次确认不得被豁免。新签发密钥可在 Tauri 窗口确认后再次查看；旧哈希密钥仍可连接，但无法恢复原值。完整密钥不得经管理台 HTTP 查询接口返回。
- 管理台密钥与 Agent 密钥分离，禁止混用。

## 命令对照

| 要做的 | 禁止的 |
|---|---|
| `npm run pack` / 已打包 exe → Tauri 窗口 | Electron、浏览器当壳 |
| Vite 只做一次性 `build`，立刻结束 | `vite` 开发服务器、`tsx serve`、挂着不关 |
| Agent 自己调 MCP | 让用户去连 MCP、去开 vite/tsx |
| 改完全量 `npm run check`，红了先修 | 只改一点就推、不看失败检查 |

## ZCode 主动召回（OneLedger 项目记忆）

- 当执行环境是 ZCode 且当前工作区为 OneLedger，**任何项目任务（包括只读分析、问答、列清单）开始时**，先在做实质分析或修改之前用 OneLedger MCP 的 `memory.get` 读取 `scopeKind=project`、`scopeId=OneLedger`。不准以「本次只读、不涉及写入」为由跳过。
- 项目名固定为仓库名；不要用当前目录、worktree 名或文件路径作 `scopeId`。
- 返回空数组时继续任务；任务涉及本机环境、跨项目工具链、部署面板通道或用户工作偏好时，再读取一次 `global`（`memory.get` 只传 `scopeKind=global`），并优先使用其内容而不是凭空另编。同一任务已取得相同版本时不重复读取。记忆与当前核实结果冲突时，以核实后的代码、实测结果和用户指令为准，并指出冲突。
- MCP 不可用时继续可独立完成的工作，并在结果中简短说明未取到记忆。不要把 inbox、草稿或 ZCode 自带 Memory 当作 OneLedger 正式记忆。
