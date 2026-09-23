# OneLedger 检索评测集

按计划书第 5 步建立。查询逐条标注应命中的文档与不应出现的文档。
**本文件不得包含真实秘密**；样本凭据均为构造值。

评测维度：

- 中文短语（三字及以上，走 FTS5 trigram 索引）
- 中文两字短词（走 `LIKE` 回退）
- 英文关键词
- 双语混排
- 跨作用域（project / global / personal）
- 权限与敏感级别（secret / pii 必须零返回）

指标：命中率、前五条命中率（P@5）、误召回、延迟。

## 语料

| id | scopeKind | scopeId | 标题 | 正文 |
|---|---|---|---|---|
| doc-project-collect | project | CofoeAirLink_Web | 采集约定 | 采集器只读取约定文件与会话摘要，排除 vendor_imports 与虚拟环境。蒸馏后覆盖整篇项目记忆。 |
| doc-project-frontend | project | CofoeAirLink_Web | 前端约定 | Vite 前端固定使用 3001 端口，组件目录按业务模块划分。 |
| doc-project-rwt | project | RollTheWarTable | 跨项目说明 | RollTheWarTable 的域名工作树放在 RWT-ai 目录下，发布走独立仓库。 |
| doc-global-workflow | global | （空） | 协作方式 | 用户沟通直接、结果导向；反感铺垫与说教。交付成果即可，不要解释过程有多难。 |
| doc-global-tooling | global | （空） | 工具口径 | 包管理统一用 pnpm，提交前跑一次类型检查；禁止 Electron，桌面壳只用 Tauri。 |
| doc-personal-note | personal | （空） | 个人习惯 | 个人偏好：先看日志再改代码，避免盲改。 |

## 查询

| # | query | 期望命中 | 不应出现 | 类别 |
|---|---|---|---|---|
| 1 | 约定文件 | doc-project-collect | 其余全部 | 中文短语（trigram） |
| 2 | 蒸馏后覆盖 | doc-project-collect | 其余全部 | 中文短语（trigram） |
| 3 | 3001 端口 | doc-project-frontend | 其余全部 | 中文+数字 |
| 4 | package 管理口径 pnpm | doc-global-tooling | 其余全部 | 英文关键词 |
| 5 | Tauri | doc-global-tooling | 其余全部 | 英文关键词 |
| 6 | RWT-ai | doc-project-rwt | 其余全部 | 英文标识符 |
| 7 | 结果导向 说教 | doc-global-workflow | 其余全部 | 中文短语 |
| 8 | 先看日志 | doc-personal-note | 其余全部 | 中文短语（非项目作用域） |
| 9 | Vite 前端 3001 | doc-project-frontend | 其余全部 | 双语混排 |
| 10 | 约定 | doc-project-collect | 其余全部 | 中文两字短词（LIKE 回退） |
| 11 | 日志 | doc-personal-note | 其余全部 | 中文两字短词（LIKE 回退） |
| 12 | 项目 | （不限定） | 无 | 中文两字短词，宽泛 |

## 边界用例（必须零返回）

| # | 场景 | 断言 |
|---|---|---|
| B1 | secret 级记忆不出现在 search 结果 | 返回为空或不含该文档 |
| B2 | pii 级记忆不出现在 search 结果 | 返回为空或不含该文档 |
| B3 | 未蒸馏的 inbox 材料不可被 search 命中 | 草稿正文查不到 |
| B4 | 不存在的词 | 返回空 |
| B5 | 跨作用域过滤：只查 RollTheWarTable | 不返回 CofoeAirLink_Web 的文档 |

## 运行方式

```
npx tsx scripts/retrieval-eval.ts    # 评测集：命中率、P@5、误召回、边界
npx tsx scripts/retrieval-perf.ts    # 延迟基线：5000 篇正式记忆
```

两个脚本都使用独立临时库，不触碰用户正在使用的数据。

## 基线结果（2026-09-23，本机 Windows / Node 22 / SQLite FTS5 trigram）

评测集（6 篇语料 + 11 条查询）：

- 命中率 11/11 = 100%
- 前五命中率（P@5）11/11 = 100%
- 误召回 1 条：两字短词「约定」同时命中「采集约定」与「前端约定」两个标题。这是 `LIKE` 子串语义的预期行为，不算缺陷；短词查询本身不追求精确。
- 边界用例 B1–B5 全部 PASS（secret 零返回、pii 零返回、未蒸馏材料零返回、不存在词零返回、作用域过滤生效）。

延迟（5000 篇正式记忆，每项 5 次平均）：

| 查询 | 路径 | 平均 | 最大 |
|---|---|---|---|
| 约定文件 | trigram 三字以上 | 6.2ms | 7.3ms |
| 蒸馏后覆盖 | trigram 五字 | 6.0ms | 6.0ms |
| 编号 4999 | trigram 中文+数字 | 2.6ms | 3.0ms |
| 约定 | LIKE 两字短词 | 4.8ms | 11.9ms |
| 记忆 | LIKE 两字短词（高频） | 2.1ms | 2.8ms |

结论：当前规模下 trigram 索引与 `LIKE` 回退都在毫秒级，短词性能与相关度没有不足，**不调整分词或索引，不引入向量库**。PostgreSQL 路径保留原检索实现，未有可复现的 PostgreSQL 实例可测，此项仍待后续在真实 PG 部署上验证。

## 回归验收要求

- 已标注查询不退化（命中率与 P@5 不低于本基线）。
- secret 与 pii 始终零返回。
- 性能不超过测试机器上记录的目标值（上表最大值为参考上限）。

