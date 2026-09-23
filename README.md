# OneLedger

自托管的 Agent 记忆总账：本机收集、安全扫描、蒸馏队列、MCP 供给其他 Code Agent 调用，并可与远端节点同步。版本 `0.4.9`。桌面壳 **只使用 Tauri**，禁止 Electron。

服务器地址和存储后端不写死，在管理界面里配置。默认本机 SQLite；中心节点可改接 Postgres。

## 要求

- Node.js 22+
- Rust（Tauri）

默认只在本机跑。数据在 `~/.oneledger`（可用 `ONELEDGER_HOME` 改）。

## 启动

```bash
npm install
npm run check
npm run dev
```

`npm run dev` 打开 **Tauri 窗口**。发版：`npm run pack`（`OneLedger-Setup.exe` / `OneLedger-Portable.exe`）。

无窗口 API（仅服务，不是管理台入口）：`npm run start` 或 `npm run dev:server`。

## 给其他 Agent 用的 MCP

本机 stdio：

```json
{
  "mcpServers": {
    "oneledger": {
      "command": "npx",
      "args": ["tsx", "src/index.ts", "mcp"],
      "env": {
        "ONELEDGER_HOME": "C:/Users/you/.oneledger"
      }
    }
  }
}
```

HTTP：管理台签发 Agent 密钥后，`url` 为 `http://127.0.0.1:7443/mcp`，`Authorization: Bearer ol_...`。

工具：`memory.search` / `memory.remember` / `memory.forget` / `memory.list` / `memory.get`。覆盖已有作用域时先读取 `rev`，再在 `memory.remember` 中传入 `expectedRev`；版本不一致会返回 `conflict`。完整识别的凭据只以脱敏占位符写入；无法安全脱敏的材料会拒收，原始 secret 不进入可检索记忆，也不会同步到远端。

## 运行模式

| 角色 | 含义 |
|---|---|
| `local` | 只在本机记账 |
| `leaf` | 本机 SQLite + 定时与远端中心同步 |
| `hub` | 作为同步中心（建议 Postgres） |

命令：`oneledger serve` · `oneledger mcp` · `oneledger collect` · `oneledger version`

## 版本与热更新

- 程序版本：`package.json` / `APP_VERSION`
- 图标源：[`brand/oneledger.svg`](brand/oneledger.svg)；窗口、exe、安装包、向导页都从这份 SVG 生成
- 通道文件：[`app_update.json`](app_update.json)（累计 `history`）
- 检查更新：顶栏或「服务器与存储 → 关于与更新」
- **便携版**：下载 `OneLedger-Portable.exe`，校验固定仓库域名与 `.sha256` 后替换正在运行的 exe 并重启
- **安装版**：下载 `OneLedger-Setup.exe`，同样校验后退出并打开安装程序覆盖安装
- 两套互不混用。数据在 `~/.oneledger`，热更新不碰用户数据。不要求代码签名证书
- 配置 schema：`config.schemaVersion`；数据 schema 启动时迁移；同步协议：`X-OneLedger-Protocol`

发版前把新说明插到 `app_update.json` 的 `history` 最前面，再打 `v*` tag。Release 正文用当前这条的 `title` / `body`。

## 安全边界

- 入库扫描密钥、连接串、高熵串；出库不再返回 secret
- 管理台 token 与 Agent MCP key 分离
- 蒸馏默认规则摘要；若配置了兼容 OpenAI 的接口，只发送已脱敏文本

## 本机凭据空间

Tauri 管理台的「凭据空间」可保存需要保留原值的敏感文本。Windows DPAPI 以当前登录用户保护原值，用户无需再管理第二把密钥。每次保存、替换、查看和删除都需要在原生窗口明确确认；查看结果在管理台显示 15 秒。

凭据空间只通过 Tauri 命令访问，不开放 HTTP 或 Agent MCP 接口。原值不进入记忆、inbox、FTS 搜索、蒸馏、普通导出和节点同步。Agent 仍只能使用既有五个记忆工具。名称和仓库名属于未加密的目录信息，不能填入原值。

DPAPI 密文通常只能由保存时的 Windows 用户在原电脑解锁。当前版本尚无跨电脑恢复功能，不能把单份数据库文件当作凭据备份。
