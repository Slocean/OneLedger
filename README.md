# OneLedger

自托管的 Agent 记忆总账：本机收集、安全扫描、蒸馏队列、MCP 供给其他 Code Agent 调用，并可与远端节点同步。版本 `0.2.0`。

服务器地址和存储后端不写死，在管理界面里配置。默认本机 SQLite；中心节点可改接 Postgres。

## 要求

- Node.js 22+

默认只在本机跑，不依赖任何远程代码托管。数据在 `~/.oneledger`（可用 `ONELEDGER_HOME` 改）。

## 启动

```bash
npm install
npm run check
npm run build
npm run desktop
npm run pack
```

浏览器打开 `http://127.0.0.1:7443/`，用 `~/.oneledger/config.json` 里的 `adminToken` 登录管理台（Windows 上通常是 `C:\Users\<you>\.oneledger\config.json`）。数据目录可用 `ONELEDGER_HOME` 覆盖。

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

远端 / 本机 HTTP：管理台签发一把 Agent 密钥后：

```json
{
  "mcpServers": {
    "oneledger": {
      "url": "http://127.0.0.1:7443/mcp",
      "headers": {
        "Authorization": "Bearer ol_..."
      }
    }
  }
}
```

工具：`memory.search` / `memory.remember` / `memory.forget` / `memory.list`。secret 级内容不会进入可检索记忆，也不会同步到远端。

## 运行模式

| 角色 | 含义 |
|---|---|
| `local` | 只在本机记账 |
| `leaf` | 本机 SQLite + 定时与远端中心同步 |
| `hub` | 作为同步中心（建议 Postgres） |

命令：`oneledger serve` · `oneledger mcp` · `oneledger collect` · `oneledger version`

## 版本

- 程序版本：`package.json` / `APP_VERSION`
- 配置 schema：`config.schemaVersion`
- 数据 schema：启动时迁移
- 同步协议：`X-OneLedger-Protocol`

## 安全边界

- 入库扫描密钥、连接串、高熵串；出库不再返回 secret
- 管理台 token 与 Agent MCP key 分离
- 蒸馏默认规则摘要；若配置了兼容 OpenAI 的接口，只发送已脱敏文本
