# OneLedger Agent 硬规则（必须遵守）

这些是命令，不是建议。违反即做错。

## 桌面壳：只许 Tauri

- **禁止 Electron。** 禁止安装、启动、调试、打包、文档推荐 Electron / electron-builder / `desktop/main.mjs`。
- **禁止** `npx electron`、`npm run desktop`（旧 Electron 脚本已删除）、任何 `electron.exe`。
- 本地开发和发版窗口 **只能是 Tauri**：`npm run dev`（`tauri dev`）或 `npm run pack` / `tauri:build`。
- 管理台必须是 **Tauri 窗口**，不是让用户去浏览器打开网页。
- 需要起本机程序时：起 Tauri。不要起纯网页服务然后甩 `http://127.0.0.1:7443/` 当交付。

## 自己干完，禁止把用户当 Agent

- 需要测 MCP：Agent **自己连、自己签发、自己调用**。禁止把 MCP JSON / Bearer 丢给用户让他自己去配、去连。
- 禁止用「你去打开这个地址」「把这段配进 Cursor」代替你自己操作。
- 禁止甩一长串自测 PASS 报告当交付；做完用产品窗口验证。

## 账本与采集

- **禁止推倒重写。** 已有 `scopeKind`（global / project / personal）+ `scopeId` 覆盖语义，不要新开一套账本。
- `scopeId` 必须是 **仓库名**（如 `CofoeAirLink_Web`），禁止用文件相对路径当项目 id。
- 采集只收约定文件 / 会话摘要 / `.workbuddy/memory`；排除 `vendor_imports`、`site-packages`、`modify_backup`、虚拟环境、插件缓存、Blender 资源。
- Agent MCP：search / remember / forget / list / get。禁止让 Agent 读 inbox / secret。已有 list/search 权限的密钥自动拥有 get。
- 管理台密钥与 Agent 密钥分离，禁止混用。

## 命令对照

| 要做的 | 禁止的 |
|---|---|
| `npm run dev` → Tauri 窗口 | Electron、浏览器当壳 |
| `npm run pack` → Tauri exe | electron-builder / pack-desktop |
| Agent 自己调 MCP | 让用户去连 MCP |
