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

桌面版 HTTP MCP 继续使用现有 Agent 密钥。每把密钥从同一来源地址首次连接时，Tauri 原生窗口会要求用户确认，确认时可勾选「记住此设备」——勾选后这台电脑上该密钥从同一地址连接不再询问，记录保存在本机 SQLite，可随时在管理台 MCP 密钥页的「记住的连接」里撤销；未勾选则维持原行为，重启 OneLedger 后重新确认。拒绝则本次请求不会进入 MCP 工具。新签发的密钥除哈希外，还会以 Windows DPAPI 加密保存在本机，可在 Tauri 管理台逐次确认后再次查看完整值。升级前仅存哈希的旧密钥保持可用，但无法从哈希恢复原值；若首次默认密钥仍保存在本机 `FIRST_MCP_KEY.txt`，启动时会将其加密补存，不改变密钥本身。

工具：`memory.search` / `memory.remember` / `memory.forget` / `memory.list` / `memory.get` / `memory.export` / `memory.import`。覆盖已有作用域时先读取 `rev`，再在 `memory.remember` 中传入 `expectedRev`；版本不一致会返回 `conflict`。完整识别的凭据只以脱敏占位符写入；无法安全脱敏的材料会拒收，原始 secret 不进入可检索记忆，也不会同步到远端。`memory.export` 导出一份 `oneledger-backup` JSON（同一格式，桌面控制台导出的是全量备份，MCP 导出为可共享的记忆子集：不含 secret/pii 记忆、收件箱、凭据密文与密钥材料）；`memory.import` 把这份文件按 id 合并回账本（记忆仅当文件 rev 更新时覆盖），每次导入都要在 Tauri 窗口原生确认。管理台「记忆」页的「导出全部数据 / 导入备份」使用同一个备份文件，覆盖数据库全部内容（含收件箱、凭据密文、Agent 密钥、审计等；config.json 设置不在备份内）。

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

Tauri 管理台的「凭据空间」可保存需要保留原值的敏感文本。Windows DPAPI 以当前登录用户保护原值，用户无需再管理第二把密钥。每次保存、替换、整理、查看和删除都需要在原生窗口明确确认；查看结果在管理台显示 15 秒。

人与 Agent 可以协作整理凭据：Tauri 管理台可保存、替换、改名、移动、查看和删除；桌面版 HTTP MCP 提供 `vault.list`（仅目录元数据）、`vault.put`（新增或替换）、`vault.organize`（只改名称或作用域，保留密文）和 `vault.delete`。现有 Agent 密钥沿用记忆工具的读写权限，不需要再签发第二把密钥；每次 Agent 写入、整理或删除都须在 Tauri 窗口原生确认。MCP 没有查看已保存原值的工具。Agent 提交原值时，该原值会经过 Agent 的上下文与工具调用，请只提交已授权它处理的内容。

原值不进入记忆、inbox、FTS 搜索、蒸馏、普通导出和节点同步。名称和仓库名属于未加密的目录信息，不能填入原值。凭据协作工具只在桌面版 HTTP MCP 上提供，独立的 stdio MCP 仍只提供记忆工具。

DPAPI 密文通常只能由保存时的 Windows 用户在原电脑解锁。当前版本尚无跨电脑恢复功能，不能把单份数据库文件当作凭据备份。
