# ZCode 存量材料治理一期：修复与复验结果

## Codex 最终独立复验（2026-09-30，Windows 验收，当前有效结论）

**按用户最新要求，本次暂时只验收 Windows；Windows 范围验收通过，已复现的缺陷修复完成。** 本轮按用户指示，经 ZCode MCP 反复交回失败条件、修复、再独立验收。后续验证只通过项目 MCP 和隔离测试执行，未再使用电脑桌面自动化。

- 全量本地门槛：Node 22.23.2 的 `npm run check` **82 项通过**；正常 Windows 权限下 `cargo test --offline --lib` **84 项通过、2 项默认 ignored**。此前已独立显式运行其中的 140,207 条规模用例并通过（8.03 秒）；本轮后续未改 scope_merge 逻辑。`git diff --check` 通过。
- 失败条件重新复现后已全部关闭：POSIX 根路径及 Linux 字面反斜杠保持正确身份；未来 schema 和缺列的 schema_migrations 被拒绝时文件 hash/journal 不变且句柄释放；扫描关闭时来源安全复核仍不能绕过，拒绝后来源、正式记忆和审计不变。
- 验收构建经 **stdio MCP initialize → tools/list → tools/call 完成 55/55 项**：草稿审核、rev 冲突、逐项勾选归并、默认取消、显式取消、显式同意撤销、超限零写入、敏感查询边界、备份冲突及 HTTP MCP 召回均通过。取消后操作状态仍 applied、来源仍在目标作用域；同意后精确回移。独立合成 DOM 测试另核对 confirm/alert 原函数引用确实恢复。
- 最终正式构建经原生 HTTP MCP/API **12/12 项**隔离复验：版本、合成来源确认、Agent 密钥、精确的记忆正文与 rev、密钥目录不返回完整 Bearer 均通过。无 devui feature 的 exe 不含开发路由和 driver，正式 MCP 清单也无开发工具。注意未知路径走已有 SPA fallback（200 HTML），不能把它写成已实测 404；其响应不提供开发命令 JSON。

独立证据：[MCP 窗口业务验收](E:/Project/OneLedger/.governance-test/independent-mcp-acceptance-evidence.json)、[正式构建 MCP](E:/Project/OneLedger/.governance-test/formal-mcp-acceptance-evidence.json)、[失败条件复验](E:/Project/OneLedger/.governance-test/independent-round5-recheck-evidence.json)、[对话框函数恢复](E:/Project/OneLedger/.governance-test/driver-confirm-evidence.json)、[版本和内嵌资产](E:/Project/OneLedger/.governance-test/artifact-check-evidence.json)。

可复验的最终产物：[验收 exe](E:/Project/OneLedger/.governance-test/round6-devui.exe)，SHA-256 `95fb4415cbc8d293cfc3c0ad357abc080db1d5efd9bec8d2024a7e87dccb7143`；[正式候选 exe](E:/Project/OneLedger/.governance-test/round6-final-release.exe)，SHA-256 `9ecd9e7e817a8710f89ea849365f08b7da7870301c99e41ff644944c445d98d3`。六处产品版本均为 0.4.14；正式前端输出与内嵌副本逐字节一致，exe 包含同一 HTML/JS。旧 exe、旧 NSIS 安装包及中途构建不属于本次最终验收产物。

本轮均使用随机隔离 HOME、合成材料、随机密钥，全部采集关闭；测试端口 17449/17451 已释放，自己启动的测试进程已关闭。连接信任在隔离 fixture 中预置，因此本轮没有对原生系统连接确认弹窗做视觉验收，也未处理真实存量材料。

**验收范围：Windows 本机的全量检查、Tauri MCP 业务与正式产物已验收通过。** Linux 暂不在本次范围；远程 CI 尚未运行，作为后续验证事项保留，不阻断本次 Windows 本机验收。未提交、未推送、未打 tag、未发布；本次没有发版请求。下方各轮是历史记录，其中“当前”“待验收”等词均指记录当时，不能覆盖本节结论。

## 第六轮收尾（2026-09-30，ZCode 自报历史，已由上方独立复验取代）

**当时结论：ZCode 修复完成，待 Codex 独立复验。** Codex 已独立验证最新源码：`npm run check`（Node 22）**82 用例通过**、正常 Windows 权限下 `cargo test --offline --lib` **84 通过、2 ignored**；`.governance-test/independent-round5-recheck-evidence.json` 全部负向复现通过；driver-confirm-check 默认取消/显式取消/显式同意与 confirm/alert 原函数引用恢复全绿。本轮 ZCode 修复四项与回归：

1. **确认事务内来源安全二次复核去开关门控**：`src/memory/service.ts` `confirmSources` 与 `src-tauri/src/service.rs` `confirm_sources` 事务内对每条 fresh 来源标题/正文的重扫描不再受 `security.scanEnabled`/`scan_enabled` 门控，与 `secondPassHits` 的无条件最终安全门一致——扫描开关只省掉入队替换劳动，不能豁免确认时的安全复核。**纠正第五轮 `sourceScanfalse` 旧结论**（scanEnabled=false 时合成 private-key 来源 stored、来源被删除、审计被改）：已由本修复封死。回归：Rust `confirm_sources_rescans_sources_even_when_scanning_is_disabled`、TS `rescans unsafe source titles and bodies in the confirm transaction even with scanning disabled`——true/false 开关、title/body 字段、混合安全/不安全来源，全事务零写入（来源保留、无正式记忆、无 resolve/store 审计）。
2. **openDb 失败关闭释放句柄**：`src/db/driver.ts` 把 schema 检查、PRAGMA、迁移全部纳入单一失败关闭 try/catch（任何一步抛错先释放句柄再传播）；`src-tauri/src/db.rs` `open_db` 在 `?` 传播时由 Drop 释放连接。**纠正第五轮 `malformed` 旧结论**（schema_migrations 缺 version 列抛 "no such column: version"、句柄未释放）：已修复。回归：TS `releases the handle and performs zero writes when schema_migrations lacks a version column`、Rust `malformed_schema_migrations_rejection_releases_the_handle_and_performs_zero_writes`——拒绝前零写入（文件 hash、journal=delete、数据原样）且句柄以重命名验证释放。
3. **反斜杠仅 Windows 作分隔符**：`src/memory/service.ts` `classifySourcePath` 与 `src-tauri/src/service.rs` `classify_source_path` 只在 win32/windows_like 折叠反斜杠；Linux 文件名可含字面反斜杠，`/home/a\b.md` 与 `/home/a/b.md` 不再判同、不再吞真实不同文件。两端显式平台断言覆盖绝对与相对反斜杠名不碰撞（C-06 测试扩展：TS `canonical source keys classify path kinds…`、Rust `canonical_source_key_is_platform_conservative`），盘符/UNC 平台语义保持。
4. **stdio MCP 工具清单与确认/取消语义**：`scripts/dev-mcp.mjs` 工具清单无任何 eval，`dev_ui_click` 显式声明 `confirm:boolean`（缺省 false=取消，仅 true=同意）；`scripts/acceptance-ui.mjs` 删除 eval 入口（新增 clickConfirm）；`web/src/devDriver.ts` 点击期间 confirm/alert 仅在单次同步点击内模拟「用户选择」并在 finally 恢复原实现，`read` 返回 `dialogPristine`/`nativeDialogsPresent` 固定断言代替 eval；新增 `scripts/acceptance-confirm-cancel.mjs`（取消归并撤销不执行、同意才精确回移、普通点击原函数保持）与 `scripts/dev-mcp-selftest.mjs` 清单断言。通道仍只在 devui feature + dev driver 构建编译，正式包不含。**纠正第五轮 MCP 一致性旧结论**（工具仍声明 dev_eval、48 项里的撤销经临时模拟同意）：同意必须显式 confirm:true，缺省一律取消；`read` 的 `dialogPristine` 提供固定断言。

规模测试复用第五轮已独立过的 140k 用例（新 scope 逻辑未改，未重复）；真实库未触碰，只读计数本轮未做（按用户指示）。

产物（待 Codex 用实际 stdio MCP 跑 55 项隔离 Tauri 验收，脚本 `.governance-test/independent-mcp-acceptance.mjs` 已由 Codex 准备；本轮未启动业务验收实例、未做 UI 自动化）：

- **验收 exe**（前端 `ONELEDGER_DEV_DRIVER=1`、Rust `--features devui`）：`E:\Project\OneLedger\.governance-test\round6-devui.exe`，SHA-256 `95fb4415cbc8d293cfc3c0ad357abc080db1d5efd9bec8d2024a7e87dccb7143`；内嵌 devui 资产 `index-G3_Y4hNL.js` + `devDriver-IuGi8DmS.js`，版本 0.4.14。
- **正式产物**（无 feature、无 dev driver）：`E:\Project\OneLedger\.governance-test\round6-final-release.exe`，SHA-256 `9ecd9e7e817a8710f89ea849365f08b7da7870301c99e41ff644944c445d98d3`；内嵌正式资产 `index-j_X-1YtX.js`；核验记录：`grep -aoc` → `/api/dev/ui`=0、`devDriver`=0、`dev_ui_poll`=0、`waitText`=0、`dialogPristine`=0、`0.4.14`=4、`index-j_X-1YtX`=3（devui 验收 exe 同法核验 `/api/dev/ui`=2，通道在包内属预期）。中途曾构建过内嵌 devui 资产的错误副本（SHA-256 `56bd8a02…`，vite 静默空操作所致），已被本副本取代。

CI 未运行（无推送授权）仍是发版阻断；本轮不提交、不推送、不打 tag、不发布。构建注意：本轮发现 `npx vite build` 在管道/无 TTY 下可能静默空操作（exit 0、产物不动），重建前端须核实产物 hash/文件名变化，不能只看命令成功。

## 第五轮 Codex 独立验收（2026-09-30，已被第六轮收尾取代）

**尚未验收完成。** 独立 `npm run check` 77 用例通过；正常 Windows 权限下 Rust 80 通过、2 ignored。通过 stdio MCP（initialize → tools/list → tools/call）重新执行隔离 Tauri 验收，48 项通过。用户已明确要求后续仅用项目 MCP，不使用电脑桌面自动化。以下实际复现的缺口仍需 ZCode 修复，不能把 CI 未运行称为唯一阻断：

- 来源路径：实际编译的 TS 函数在注入 Linux platform 的语义复现中丢失 POSIX 根斜杠，绝对路径被判为非全局；现有平台断言也与实现矛盾。这是函数模拟，**不是实际 Linux CI**。Rust 的非 Windows UNC 前缀处理亦需同步复核。
- 新 schema 拒绝：合成 schema 13 文件库被 TS 拒绝打开前，DELETE 已变 WAL，文件 hash 已改变。Rust 同样把可写 PRAGMA 放在版本检查前；需两端测试拒绝前零写入及句柄释放。
- 来源二次扫描：合成 public 来源含假私钥块，提交干净审核正文仍返回 stored，并删除该来源。确认事务须逐条重新检查来源标题/正文，任一失败则正式记忆、全部来源和审计均不变。
- MCP 一致性：stdio 工具仍声明 `dev_eval`，当前窗口驱动已删除 eval。需统一工具清单，并提供明确的确认/取消语义；当前 48 项里的撤销通过临时模拟同意，不能推出真实系统确认对话框已验收。

隔离原始证据与复现：`.governance-test/independent-round5-evidence.json`、`independent-round5.mjs`；MCP 原始证据：`.governance-test/independent-mcp-acceptance-evidence.json`，48 项、0 失败，端口 17449，采集全关；测试进程已关闭。正式库未参与本轮验证。修复已通过 ZCode MCP 派发，但默认执行通道无有效输出；CLI 咨询 10 分钟超时。正在核实可工作的桥接通道，尚无本轮代码修改可验收。

## 第六轮 ZCode 修复（2026-09-30，回应上方第五轮逐项；待 Codex 复核）

用户授权本轮在新会话续接修复。以下逐项回应第五轮复现的缺口；每项均可在隔离库重跑 `independent-round5.mjs` 方法复核。**整体状态仍为未验收；发版阻断=独立复核未完成 + 终版真实窗口确认/取消验收未完成 + CI 未运行 + Linux check 无环境（本机无 WSL 发行版、无 Docker）。**

1. **来源路径跨平台语义（已修复，待复核）**。TS `src/memory/service.ts` 与 Rust `src-tauri/src/service.rs` 统一为五类形态分类：盘符绝对 / 盘符相对 / UNC / POSIX 绝对 / 相对，各自身份互不吞并；全局唯一仅认 Windows 盘符绝对与非 Windows 的 POSIX 绝对（单根）。Linux 上 `/home/user/AGENTS.md` 的 canonical **保留根斜杠**且 `sourceKeyIsGlobal=true`；`C:/work/...` 在 Linux 上是相对路径（false，大小写不折叠）；UNC 保留 `//` 前缀、两端均 false、不与 `/server/...` 合并；`..` 越根与 3 个以上前导斜杠返回 null 退回原值。两个函数带显式平台参数（缺省运行时平台），测试不再依赖宿主平台。TS 测试 `canonical source keys classify path kinds per platform and stay conservative (C-06)` 与 Rust `canonical_source_key_is_platform_conservative`（`_for(path, windows_like)` 双平台断言）覆盖上述全部语义，修复前失败、修复后通过。
2. **新 schema 拒绝前零写入（已修复，待复核）**。TS `src/db/driver.ts` 与 Rust `src-tauri/src/db.rs` 的 schema 版本只读检查提前到一切可写 PRAGMA（含 `journal_mode=WAL`）与 DDL 之前。TS `rejecting a newer-schema database performs zero writes (hash, journal mode, data, handle)` 与 Rust `future_schema_rejection_performs_zero_writes_and_releases_the_handle` 用真实文件库（schema 13、journal=DELETE、含哨兵行）验证：拒绝后文件字节逐位不变、journal 仍为 delete、行数据原样、句柄已释放（Windows 重命名验证）。
3. **来源二次扫描（已修复，待复核）**。`confirmSources`/`confirm_sources` 在确认事务内对每条 fresh 来源的标题与正文重新安全扫描（受 `security.scanEnabled` 约束，与该函数其余扫描一致）；任一命中整批 rejected，正式记忆、全部来源、审计零改动；错误只报命中类型与数量，不回显正文。TS `re-scans every fresh source title and body in the confirm transaction and rejects unsafe content` 与 Rust `confirm_sources_rescans_source_content_inside_the_transaction` 覆盖：篡改 public（私钥块）、PII（email）、混合批次、legacy/导入干净行（source_key 空）可正常确认、被拒行保持队列原状。
4. **MCP 工具清单一致性（已修复，待复核）**。`scripts/dev-mcp.mjs` 删除 `dev_eval` 声明与转发（B-08 后窗口驱动只有 click/fill/read/waitText，无任意 JS 能力）；`dev_ui_click` 描述写明确认/取消语义：点击期间原生 confirm 一律按「同意」、alert 静默，仅限本次同步调用并立即恢复原实现；**该工具没有取消路径，取消分支与真实系统确认对话框必须由人在真实窗口验证，不得作为确认门槛证据**。自测：`node scripts/dev-mcp-selftest.mjs` 的 initialize → tools/list 返回 `dev_ui_click, dev_ui_fill, dev_ui_read, dev_ui_wait_text, dev_health`（后续步骤需隔离实例，本机未启动属预期）。
5. **C-04 证据补充（部分完成，窗口终验保留给 Codex）**。本轮新增，不修改 confirm/alert：
   - 隔离合成文件库规模（`c04-file-scale.mjs` → `c04-file-scale-evidence.json`）：真实文件库 140,144 条 proposed（含 73,544 条单作用域）；1000 条批次预览 p50=22ms/max=28ms，显式勾选 1000 条确认 p50=896ms/p95=1395ms/max=1555ms，撤销精确回移一批 120ms；50 行分页 p50=158ms。
   - 真库只读副本（`c04-real-copy.mjs` → `c04-real-copy-evidence.json`）：仅用允许的本地方式（只读连接 `VACUUM INTO`，9.6s）取一致副本，quick_check ok；只输出计数：868MB、schema 12、proposed 137,502 / rejected 48,846、active 15、归并操作 0/0、指纹 122。**未读取/输出任何 title/body/凭据，未对真库或副本写入。** 副本在 `.governance-test/c04-real-copy/`，仅供只读复核，用后可删。
   - **边界保持**：真实确认/取消与批次预览确认/撤销的完整窗口验收由 Codex 在正式无 feature 包上承担；本轮已备好正式 exe 与可重建的合成 fixture（`c04-fixture/`）。完成前 C-04 不标完成。

### 第六轮验证与产物

- `npm run check`：**80 用例通过**（较第四轮 +3：来源二次扫描、未来 schema 零写入、损坏库句柄释放）；`cargo test --offline --lib`：**82 通过 + 2 ignored**（+2）；显式 `-- --ignored scope_merge_scale`（内存库 140,207 条）通过（本次 10.03s）；`git diff --check` 通过。另含第五轮记录的残余缺口修复：openDb 的 schema 检查本身抛异常（库损坏）时也先释放句柄再抛（TS 测试 `releases the handle when the schema check itself fails…`；Rust 侧 RAII 天然释放）。该修复只涉及 TS 服务路径，不进入 Tauri exe，exe 产物不受影响。
- 正式包（无 feature、无 devui，`npm run tauri:build`）：exe SHA-256 `f240ee7a5d2d5fad23e3cd8ae2d6c164ee2358e592041342e27ba387a751e791`（2026-09-30 19:51，副本 `.governance-test/oneledger-0.4.14-round6-release.exe`）。`grep -aoc "0\.4\.14"`=4；`/api/dev/ui`、`dev_ui_poll`、`waitText`、固定 token、`devDriver` 均 0 处；内嵌 index.html SHA-256 与 `dist/web` 一致（`be197a17…`）。**第四轮留存的 `oneledger-0.4.14-release.exe` 是旧代码包，不得用于本轮之后的验收。** NSIS：`src-tauri/target/release/bundle/nsis/OneLedger_0.4.14_x64-setup.exe`。
- 版本仍 0.4.14；未提交、未推送、未打 tag、未发版。`scripts/dev-mcp.mjs` 不入包，exe 验证不因其后改而失效。

以下第四轮内容是 ZCode 自报历史，不能取代上述第五轮独立结论。

复核日期：2026-09-30（第四轮：任务书唯一清单逐项修复与本地验收）。任务书：[完整修复与复验任务书](zcode-memory-governance-remediation.md)。**本段为第四轮历史自报，以本文顶部最终独立复验为准。**

状态：**任务书唯一清单的 B-01～B-12 与 C-01/02/04/05/06/07 已在本轮逐项修复并通过本地验证；终版隔离 Tauri 窗口验收 48/48 通过；全量本地门槛绿。CI 矩阵已改但尚未运行（无推送授权），故整体状态为「本地完成、发版阻断（CI 未运行）」，不能打 tag 或发布。**

## 逐项修复状态与证据

| 项 | 状态 | 证据 |
|---|---|---|
| B-01 TS 事务回滚 | **已修复** | `scopeMerge.ts` 新增 `RollbackConflict`：UPDATE 条数不符、撤销状态行更新数≠1 一律抛异常让驱动回滚，事务外还原载荷。TS 测试 `confirm rolls back completely…`/`revert rolls back when the status row…` 用触发器注入跳行，验证 inbox/操作/items/审计零残留、重试不二次移动；Rust 侧原本即 rollback，新增镜像断言 |
| B-02 冲突覆盖 | **已修复** | `App.tsx` 冲突不再 `setEditRev(server.rev)`；提交按钮在 `conflict` 存在时禁用；冲突横幅完整展示服务器正文（去掉 4,000 字截断）；「我已合并服务器最新内容」+「二次确认」两步后才改用新 rev（仅手工模式）；草稿冲突在服务端标记 stale（`mark_draft_stale`），不给旧 draftId 换 rev。窗口实测：连续点保存不推进 rev、零写入、显式合并后 rev 3 写入 |
| B-03 草稿快照 | **已修复** | `confirm_sources`（Rust+TS）在确认事务内重读草稿：status=pending、作用域、来源集合、请求 rev=草稿 expectedRev、当前 rev 同值、逐条 title+body 指纹与 `source_fingerprints` 一致；缺快照的草稿拒绝。Rust/TS 测试覆盖正文篡改、rev 变化、绕过任务页直接 resolve、重复确认四场景 |
| B-04 ID 查询绕过脱敏 | **已修复** | Rust/TS 的 `ids` 分支强制要求 `draftId`：草稿须 pending、每个 ID 在草稿来源清单内、材料作用域与草稿一致，否则 4xx 不返回正文；脱敏按**实际 queue_status** 判定，不信任客户端 status。窗口+接口实测四类请求均 4xx 且无哨兵；rejected 分页行仍为 `[REDACTED:rejected]` |
| B-05 同仓库同文吞材料 | **已修复** | schema v12：`inbox.source_key`（Rust/TS/备份同步）；`find_collected_inbox` 查重身份加 source_key；新采集行记录 canonical 来源键。Rust/TS 测试：同仓库 A/B 同文各入队、重扫全跳过、改 B 恰好新增 B 一个版本；旧行（键空串）保守互认 |
| B-06 备份导入混批 | **已修复** | `backup.rs` operation+items 整体导入：同 ID 内容与 item 集完全一致才幂等跳过，内容不同整个导入拒绝；v1 旧备份按 moved_ids 回填并校验计数；导入后跑 `verify_merge_operation_integrity`。测试：同 ID 不同 items 拒绝且目标原样、缺明细/计数不符/孤儿明细拒绝、重复导入幂等、v10 风格备份回填可撤销。窗口+接口实测伪造导入 400 且原操作未覆盖 |
| B-07 归并仅前 10 条样本 | **已修复** | 预览返回 `batchItems`（本批 ≤1000 条全量脱敏元数据）；确认必须携带显式勾选的精确 ID 子集（非空、无重复、⊆digest 绑定批次），只移动勾选的 ID；UI 分页（每页 50）+按来源筛选+默认不勾选+不勾选不能确认。Rust/TS 测试：子集归并其余原位、撤销只回勾选条目 |
| B-08 验收通道入正式构建 | **已修复** | Rust `/api/dev/ui/*` + `DevUiChannel` 移入 `devui` cargo feature（默认关）；正式 release exe 经 `grep -a` 验证 0 处 dev 路由/driver 字符串；前端 driver 仅在 `ONELEDGER_DEV_DRIVER=1` 构建编入（vite define + 动态导入编译期消除）；删除 `eval` 能力；confirm/alert 仅在单次同步点击内模拟并立即恢复；命令队列 32 上限 + 10s TTL + exec 超时撤销 + 结果 30s TTL；移除 `CorsLayer::permissive()`；`.zcode/mcp.json` 入 gitignore（模板 `.zcode/mcp.json.example` 入库），验收脚本 token 改为每次随机生成、经 env/隔离文件传递 |
| B-09 PG 假支持 | **已修复** | TS `openDb` 在连接/发任何 SQL 前对 postgres 驱动抛出明确 unsupported；设置界面 PG 选项禁用并说明。测试验证 fail-fast |
| B-10 包同步与终验 | **已完成（本轮）** | 见下方「终版链与窗口验收」 |
| B-11 schema/备份向前兼容 | **已修复** | Rust `open_db` 在 INIT_SQL 前查 `schema_migrations`，version > 12 立即拒绝；TS 同；migrate 内双向检查。备份 `FORMAT_VERSION=2`（旧程序按其 `formatVersion > 1` 检查自动拒绝），v1 备份只读兼容导入。测试：schema 13 库打开即拒且零写入；发版版本号按 AGENTS 同步六处至 0.4.14（全仓 grep 复核通过） |
| B-12 读取失败当空记忆 | **已修复** | `fetchCurrentMemory` 区分成功（含空作用域）与失败；失败时编辑器打开但不可提交、显示「重试读取」，重试不清除用户已输入正文；只有成功取得 rev/正文后启用保存。窗口+单测覆盖 |
| C-01 digest 未含来源总数 | **已修复** | digest v3 加入 `fromPending`（来源作用域总 pending）；Rust/TS 测试：本批外新增/移走一条均使旧预览失效 |
| C-02 指纹排序并列 | **已修复** | v12 给 `collect_fingerprints` 加 `touched_seq`（sync_meta fp_seq 单调序号），latest 查询 `ORDER BY touched_seq DESC, rowid DESC`；Rust/TS 测试同毫秒并列时最近触碰者胜出 |
| C-03 文档事实纠正 | **已完成（第三轮）** | 保持事实边界，本轮继续遵守（真实库只读、不公布正文） |
| C-04 证据分层 | **本轮已按层标注** | 本文分别记录：服务层合成库测试（Rust/TS 单测、140k 规模）、隔离 Tauri 窗口终验（48 项，`final-acceptance-evidence.json`）、真实库边界（本轮未触碰真实库，第三轮只读数字仍为最新边界）；不再跨层推断 |
| C-05 无批量上限 | **已修复** | `confirm_sources` 上限 100（Rust+TS 常量+提示），窗口实测 101 条零写入、错误含「100」；UI 提示分批 |
| C-06 路径未规范化 | **已修复** | `canonical_source_key`（Rust+TS）：统一分隔符、盘符小写、消解 `.`/`..`（越根拒绝）；Windows 上 POSIX 绝对路径与 UNC 不视为全局唯一；除盘符外不折叠大小写（保守不吞文件）。Rust/TS 单测覆盖盘符大小写、点段、UNC、不同盘符、大小写不吞 |
| C-07 旧请求覆盖新状态 | **已修复** | `loadMaterials` 失败分支与 `refresh` finally 均带请求代次检查（TS `DistillTasks`）；与 M-04 的成功分支保护合成完整 |

## 全量本地门槛（2026-09-30 第四轮终态）

- `npm run check`（validate-release + server tsc + web strict tsc + vitest）：**通过，77 用例**（较上轮新增 10：B-01 回滚×2、B-07、C-01、B-03 四场景、B-05、C-05、C-06、B-11/B-09）。
- `cargo test --offline --lib`：**通过，80 用例 + 2 ignored**；`--features devui` 下 **82 用例**（含 dev 队列容量/取消测试）。
- 显式 `-- --ignored scope_merge_scale`（140,207 条、74 批）：**通过，总循环 5.77s，p50=73ms / p95=121ms / max=127ms**，list20 <1ms（debug 构建、内存库；规模语义与第三轮一致，仅批次子集语义更新）。
- `npm run build`：通过；`git diff --check`：通过（仅 CRLF 提示）。
- 六处版本号 0.4.14 同步（package.json / package-lock.json / tauri.conf.json / Cargo.toml+Cargo.lock / src/types.ts / util.rs）；`app_update.json` 顶部已加 0.4.14 公告（validate-release 校验通过）；全仓 grep 旧版本号仅存于历史证据与公告历史。

## 终版链与窗口验收（B-10）

1. **正式产物（发布候选）**：`npm run build` → `sync-web-embed.mjs` → `tauri build --no-bundle`（无 feature）。exe SHA-256 `a8b047530c0fe9d91afce7d15553494621f34eaf1fd8242588355aa32ecd07a7`；内嵌 0.4.14 与当前资产 `index-j_X-1YtX.js`（index.html SHA-256 `be197a17…` 与 `dist/web` 一致）；`grep -a` 验证 0 处 `/api/dev/ui`、`dev_ui_poll`、`waitText`、固定 token。副本留存 `.governance-test/oneledger-0.4.14-release.exe`。
2. **验收产物**：同一源码，前端 `ONELEDGER_DEV_DRIVER=1`、Rust `--features devui` 构建——仅差编译期门控的验收通道，用于驱动窗口交互。
3. **隔离窗口验收（48/48 通过，0 失败）**：新隔离 HOME（`.governance-test/final-home`）、端口 17444、采集全关、随机 admin token；驱动脚本 `.governance-test/final-acceptance.mjs`，证据 `.governance-test/final-acceptance-evidence.json`。覆盖：登录态、草稿审核（载入/写入 rev 1/applied）、rev 冲突全链（服务端推进 rev 2 → 冲突横幅+提交禁用+完整服务器正文+零离队 → 我已合并 → 二次确认 → rev 3 写入 → 来源清空）、归并批次（预览全批清单/默认不勾选/不勾选禁用/勾选 1 条确认/movedCount=1/撤销精确回移）、B-04 四类按 ID 请求无哨兵+rejected 分页脱敏、C-05 101 条零写入、MCP initialize 0.4.14 + memory.get 读到合并后 rev 3、备份 formatVersion 2 + 同 ID 不同 items 导入 400 且原操作未覆盖。验收结束进程树已关闭（复检 0 个 oneledger.exe）。
4. **边界声明**：窗口交互经 dev driver 执行 DOM 级命令；driver 已无 eval、不再永久改写 confirm/alert（仅单次同步点击内模拟同意并恢复）。撤销流程中的原生 confirm 即在该语义下通过。

## 真实库与 CI 的准确边界

- 本轮**未触碰真实库**（无迁移实验、无写入）；第三轮只读统计（schema 11→发布后 12、active 15、proposed 137,502、operations 0/0）仍为最新真实库快照。真实库升级到 schema 12 由用户日常启动新版本自然发生。
- CI：`.github/workflows/ci.yml` 已改为 `ubuntu-latest`/`windows-latest` 矩阵（Node 22、`npm ci`、`npm run check`）。**尚未推送、无 CI run**——Linux check 未在本机运行（无 WSL 环境）。这是当前唯一发版阻断项。
- 发版前仍须：推送并等 CI 绿、按 AGENTS 完成发版流程（tag、Release、exe 内嵌版本核验）。

## 本轮无法从历史数据自动恢复的事项

（同第三轮结论，保持不变：v10 期间被搬移/删除的指纹无法凭操作记录恢复；`/api/scopes/merge/fingerprint-report` 提供只读核查线索；真实库归并操作为 0，无需修复。）

---

以下是第三轮独立验收与更早的自报记录，保留作历史；与本节冲突时以本节为准。

# 历史记录（第三轮独立验收，已被第四轮取代）

状态：**验收未通过。上轮 B-01～B-09、B-11、B-12 共 11 项仍未修复；B-10 包体更新通过、交互终验待完成；C-01/02/04/05/06/07 未关闭，C-03 文档事实纠正已完成。不能称“本地完成”或“窗口终验通过”，不能发版。** 全部指定改法、文件和测试场景在任务书的“当前唯一执行清单”。本轮沿用原编号，没有追加一套零散任务。

## 本次已认可的进展和质量检查

- `npm run check`：**67 用例通过**，含 server/web typecheck；新增 TS 迁移用例 3 个（v10→v11 回填、重复启动幂等、缺表报错）。openDb 迁移失败释放句柄的改动已核到。
- `cargo test --offline --lib`：正常 Windows 权限下 **70 通过、2 ignored**；显式 `-- --ignored scope_merge_scale` **1 通过**，本次执行 5.48 秒（合成内存库服务层测试）。Rust 尚有 8 条编译警告，不影响本次测试结果。
- `npm run build` 与 `git diff --check`：通过。正文 unchanged 的显式批准勾选及按钮禁用条件已存在；其当前资产窗口交互尚未独立终验。
- **B-10 的旧包问题已修正：** App 14:35:52、web-assets 14:40:10、exe 14:41:49；当前 build 与内嵌资产均为 `index-BCVumcG_.js`，index.html 与 JS 各自 SHA-256 一致。exe SHA-256 为 `08A30986DB7E3ACD5D9D34F531C595EE71BD7634CA9B83B72F458671F1E25398`，包含该资产名及当轮版本号（0.4.14 的上一版）。上一轮的旧时间/hash 不再作为当前缺陷。

## 当前实现的独立失败复现

TS 复现直接调用本轮 `npm run build` 的输出。Rust 复现启动 `src-tauri/target/release/oneledger.exe`，新隔离 HOME、合成数据、随机测试 token、独立端口，**全部采集器关闭、devUi=false**。取得 OneLedger Tauri 窗口（handle=658438）和 health oneledger（当轮版本号，0.4.14 的上一版）后调用接口；结束关闭本次 PID=33144 的进程树。未使用 dev driver/eval，未覆盖 confirm，未访问真实资料或真实凭据。

- **B-01 未修复（TS）：** confirm/revert 注入跳过一行的触发器，均返回 conflict，但 Old/Target 各一行的部分修改已提交；跳过操作状态 UPDATE 时返回 reverted，数据库操作仍 applied。
- **B-02 未修复（UI 代码）：** 冲突仍 `setEditRev(server.rev)`，submitEdit 没有冲突锁，提交按钮也没有 conflict 条件；旧正文可再次用新 rev 提交。新 unchanged 门不能阻止正文不同的冲突覆盖。
- **B-03 未修复（TS 与 Tauri/Rust 实际接口）：** draft.expectedRev=0、当前记忆 rev=1，请求改带 expectedRev=1，仍 stored 到 rev 2；来源正文改变但 ID 不变，旧草稿仍 stored。TS 还确认来源被删除、草稿 applied。事务外的状态/ID 检查没有守住草稿快照。
- **B-04 未修复（TS 与 Tauri/Rust 实际接口）：** `status=proposed&ids=<rejected id>` 返回 HTTP 200 和拒收材料原始正文；TS 同时返回原始标题。
- **B-05 未修复（TS 实际采集）：** 同仓库不同路径 A/B 同文，2 个文件仅入队 1 条、登记 1 条指纹；第二条 skipped。仍按 source/scope/body 去重。
- **B-06 未修复（Tauri/Rust 实际导入及撤销）：** 同 operation ID 的原 items A/B 与导入 C/D 合并成 4 条，moved_count 仍为 2；导入成功，实际撤销 **4 条**，扩大了任一批次的范围。
- **B-07 未修复（Rust/TS/UI 代码）：** 归并 1000 条仍仅提供前 10 条样本，没有完整精确 ID 子集审核/选择。
- **B-08 未修复（源码及 release exe）：** driver 无条件进入前端，含任意 JS 执行及永久 confirm/alert 改写；Rust 路由以运行时 config 开关启用、6 秒超时不撤销排队命令。当前 exe 中仍检出 `/api/dev/ui/exec`。固定测试 token 仍在验收配置/脚本；未将通道编译排除。
- **B-09 未修复（TS 启动/UI 代码）：** PG 选择仍可用，openDb 先 migrate 并执行 SQLite 风格 SQL；方法入口 unsupported 不构成完整支持边界。
- **B-11 未修复（TS 实际打开库 + Rust/TS 代码）：** schema=12 的合成库被支持 11 的程序打开且接受写入。备份 formatVersion 仍 1，没有封住旧格式对新 items 的兼容丢失。
- **B-12 未修复（UI 代码）：** 当前正式记忆读取失败仍返回 null；审核编辑器继续按“尚无记忆”打开。
- **C-01 未修复（TS 实际归并）：** 第 1001 条被删除、前 1000 条不变，总数变化但 digest 不变，旧预览仍 applied。
- **C-02/C-06/C-07 未修复（代码）：** 最新指纹排序没有同毫秒 tie-breaker；路径仅替换斜杠；材料 catch 与任务 finally 仍缺请求代次保护。
- **C-03 文档纠正通过，C-04 证据仍缺：** 本文已更正真实库迁移来源说法，并撤回历史中无法证明的零写入断言。真库副本性能、最终资产未经改写的确认交互、完整终验尚缺；旧自报的文件库时延/内存数字和旧资产窗口记录不能推导这些通过。
- **C-05 未修复（TS 实际确认 + Rust/TS/UI 代码）：** 101 条来源一次请求全部消费；没有明确上限与超限零写入门槛。

原始安全观测：独立验收证据 JSON 已按原字节归档至 `.governance-test/history/zcode-memory-governance-independent-evidence.json`（SHA-256 `84ab039c8dffd9faccfb12d3d412efac8f0d5f8f1432e8bd4b1585ae8956ab1a`，Git 忽略目录，保留真实历史证据）。本地复现脚本：`.governance-test/independent-acceptance-20260930/audit.mjs`、`native-audit.mjs`；目录被 Git 忽略。后续修复须把这些失败条件转成正式回归测试，不能把“复现了失败”写成“功能验收通过”。

## 真实库与 CI 的准确边界

本次真实库只用 SQLite `mode=ro` 查计数和迁移标记：schema **11**、active **15**、proposed **137,502**、operations/items **0/0**。v10/v11 迁移标记分别为 `2026-09-30T02:31:53.471Z` / `02:31:53.477Z`，北京时间 10:31:53。发生过迁移写入，**触发来源未确认**；不能推断“此前 Agent 未写入”。备份状态未独立核实，不声明已有可用备份。

当前工作流仅 Windows npm check，没有 Linux job；本机 WSL 尚未安装 Linux 运行环境，本轮未运行 Linux check。当前未提交改动也没有独立确认的 Linux/Windows CI run。具体 workflow 改法和放行顺序已写入任务书。业务缺陷、最终窗口和 CI 均有开放项，故整体状态保持未验收。

---

以下是修复轮及补验的自报记录，保留作历史。表内“已修复/通过”仅说明当时的报告，**不是第三轮当前验收状态**，与上方独立结果冲突时以上方为准。

## 修复轮自报速览（历史，已被独立复核取代）

| 项 | 状态 | 证据 |
|---|---|---|
| P0-01 草稿隐式来源 | 已修复 | 双入口（手工/审核草稿）；`confirm_sources` 服务端校验 draftId 与来源集合，pending 草稿阻断手工路径；Rust `manual_resolve_is_blocked_while_pending_draft_exists`、`stale_draft_cannot_be_submitted_via_draft_id`；TS distillJob 测试带 `draftId` 提交；正文与当前正式记忆完全相同时需单独勾选显式批准才能提交（unchanged 门）；**Tauri 窗口内**完成草稿审核→写入 rev 1、草稿标记 applied，以及 unchanged 门禁用→批准→提交全过程 |
| P0-02 rev 冲突覆盖 | 已修复 | 冲突进入阻断态：展示服务器最新正文、保留编辑与勾选、不自动推进 rev；窗口内实测：服务端推进 rev 2 后提交 → 冲突横幅+服务器正文+零写入（25 条来源全保留）→「以服务器版本为底稿」合并 → rev 3 写入、来源 25→24 |
| P0-03 撤销误搬指纹 | 已修复 | `merge_fingerprints` 从 confirm/revert 双端删除；归并/撤销只改 inbox 作用域；Rust/TS 测试逐字段比对指纹集合（同键副本、新生指纹、两次归并）不变；重扫静默、内容变化恰好一次入队；新增只读 `fingerprint_damage_report`（API `/api/scopes/merge/fingerprint-report` + 窗口入口） |
| P0-04 跨项目同文被吞 | 已修复 | `find_collected_inbox` 恢复作用域约束；跨作用域判同只走稳定来源键（规范化绝对路径）+ content hash；相对名按作用域去重。测试：`identical_body_in_two_repos_queues_in_both`、`relative_source_keys_stay_scope_scoped`、`backslash_and_slash_paths_share_fingerprint` |
| P0-05 digest 弱绑定 | 已修复 | digest v2 = 本批精确 ID 有序流式 SHA-256 + 目标 pending/记忆 id/rev/待审草稿；等数量替换集合、单条离队、目标 rev 变化、新增草稿均使旧预览失效（Rust/TS 测试）；确认事务内按同一 ID 集合移动 |
| P0-06 巨量归并无边界 | 已修复 | `MERGE_BATCH_LIMIT=1000`，按 `(created_at,id)` 取批；`scope_merge_operation_items` 主键表存精确 ID（schema v11，v10 `moved_ids` 只读回填兼容）；撤销用 SQL JOIN 整批核验。规模测试（140,207 条、1,800 作用域、73,544 条大作用域）：74 批全循环 4.62s，每批 **p50=59ms / p95=104ms / max=108ms**（debug 构建、内存库），进程峰值内存 **98.2 MB**（外部 200ms 采样），exact ID 无遗漏无重复，撤销中间批只影响该批，中断后重新预览可继续；文件库（隔离实例）每批 preview+confirm **26-39ms**；**Tauri 窗口内**完成 1000 条批次预览（本批 1000/剩余 2000）→ 确认 → operation+1000 items 精确落库 |
| P1-01 前端 typecheck 缺失 | 已修复 | `Inbox.redacted?: number` 补齐；`package.json::check` 加入 `tsc --noEmit -p web/tsconfig.json`；负向验证：故意删除该类型字段后 check 报 TS2339 失败、恢复后转绿；当前 `npm run check` 绿（67 用例）且 web strict typecheck 为其中一环 |
| P1-02 选择不可审查 | 已修复 | 勾选保存完整元数据（ID/标题/来源/创建时间/安全状态）跨页保留；提交前 SelectionReview 完整清单可逐条取消；材料行显示 ID+时间；窗口实测跨 **3 页**各勾 1 条 → 清单 3 行 → 取消 1 项 → 提交，服务端恰好消费清单所列 ID（in_acc119 出队、in_acc004 等未展示材料留在队列）；abnormal 作用域也可经「审核 / 整理」进入统一审核面板（openPanel 区分） |
| P1-03 归并记录分页失效 | 已修复 | offset 驱动 + 请求代次防旧响应覆盖；`hasMore = offset + rows.length < total`；窗口实测 46 条操作三页 **20/20/6** 各页加载、页间无重复、下一页在末页禁用；在页 2 撤销真实操作成功且列表保持当前页、状态刷新为「已撤销」；Rust 规模测试另证 74 条操作分页与 `list20` 耗时 <1ms |
| P1-04 错误伪装空队列 | 已修复 | 分页/命中规则/草稿过期刷新失败返回带 requestId 的结构化 5xx；窗口故障注入两轮：命中规则 SQL（drop `redaction_events`）与**分页 SQL**（drop `inbox.sensitivity` 列）分别实测，均显示「读取队列失败…requestId:req_…」且不出现「队列是空的」，恢复后重试各返回 50 行 |
| P1-05 内嵌资产/窗口验收 | 已完成 | 前端 build + `sync-web-embed.mjs` 后 hash 一致且 exe 内嵌（终版 `index-BCVumcG_.js`，含 unchanged 门，grep 3 处命中；当轮版本号嵌入（0.4.14 的上一版）；窗口验收轮为 `index-CXNhfXKj.js`）；全部关键交互（审核、归并、撤销、冲突、MCP）在 **Tauri 窗口 WebView 内**通过内置 dev driver（见下）真实执行，非浏览器 |
| P1-06 PG 冒充一致 | 已处置 | TS `scopeMerge.ts` 全部入口在 `driver === "postgres"` 时返回 `{status:"unsupported"}`；SQLite 是本轮交付路径；未宣称 PG 等价 |
| P1-07 回滚说明错误 | 已修正 | 本节删除「DROP 即回滚」；采用升级前验证备份+匹配二进制回退；Rust 侧 v9→v11、v10→v11、重复迁移、缺表检测（`verify_required_tables`）与 TS 侧 v10→v11 回填、重启幂等、缺表检测（`verifyRequiredTables`，openDb 失败时释放句柄）测试均通过；备份导出/导入覆盖 `scopeMergeOperationItems` 并验证引用完整 |
| P1-08 CI | 未运行 | 无推送授权；Linux check 与 Windows CI 未执行 → **不能发版** |
| M-01 高信号标记 | 已删除 | UI 无「高信号」文本；WorkBuddy 只如实计数 |
| M-02 分布截断无说明 | 已修复 | top20 + `otherCount/otherKinds`；确认记录存全量分布（总和=本批移动数，Rust 单测与规模测试逐批断言） |
| M-03 列表 N+1/大字段 | 已修复 | 列表单次分页 SQL 只读概要字段（Rust `list_merge_operation_summaries` / TS 同构）；新操作不再写 `moved_ids` 大文本；74 条操作样本上 20 条/页耗时 <1ms |
| M-04 竞态覆盖 | 已修复 | 任务/材料/归并记录列表全部带请求代次，仅最新请求可更新 |
| M-05 QueuePanel 隐式写入 | 已收敛 | 材料明细只浏览/拒收/自定义入队；写入统一走任务审核入口，`selectedIds.length ? selectedIds : [item.id]` 回退已删除 |
| M-06 归属证据 | 已修复 | 预览含本批样本（前 10 条 ID/标题/来源/时间/安全状态）并在窗口展示；不能证明同一仓库时不归并（人工核对提示） |

## 本轮新增：开发 MCP（应用内置，不再操控桌面）

按用户要求，验收不再使用桌面鼠标键盘操控（Nexuz）。OneLedger 内置了开发验收通道：

- **WebView 内 dev driver**（`web/src/devDriver.ts`）：仅当实例 `config.json` 的 `devUi: true` 时工作（默认关闭，真实实例零影响）。轮询 `/api/dev/ui/poll` 领取 DOM 级命令（click/fill/read/waitText/eval），在 **Tauri 窗口内**执行并回传；所有端点要求 admin token。
- **Rust 命令通道**（`src-tauri/src/http.rs` `DevUiChannel`）：`/api/dev/ui/{poll,result,exec}`，exec 同步等待结果（6s 超时）。
- **开发 MCP server**（`scripts/dev-mcp.mjs`，stdio 零依赖）：工具 `dev_ui_click / dev_ui_fill / dev_ui_read / dev_ui_wait_text / dev_eval / dev_health`；项目级配置 `.zcode/mcp.json`（指向隔离实例 17443，node 绝对路径启动，符合全局资源落盘规则）。stdio 端到端自测 `scripts/dev-mcp-selftest.mjs` 全通。
- 验收辅助脚本：`scripts/acceptance-setup.mjs`（隔离 HOME/配置/数据注入）、`scripts/acceptance-ui.mjs`（CLI 驱动）、`scripts/acceptance-mcp.mjs`（Agent 密钥直连 MCP memory.get）、`scripts/acceptance-real-db-readonly.mjs`（真实库只读统计）。

## Tauri 窗口验收记录（隔离实例，端口 17443，ONELEDGER_HOME 隔离）

- exe：`src-tauri/target/release/oneledger.exe`（`tauri build --no-bundle`，2026-09-30 构建；终版内嵌 `index-BCVumcG_.js`，含当轮版本号即 0.4.14 的上一版）。隔离库种子：27 条材料（25 条 skills\system\plugin、1 条 bad\path、1 条 ConflictScope）+ 1 条 pending 草稿。
- **草稿审核（P0-01）**：审核面板双入口可见 →「审核草稿」装入草稿正文/expectedRev/来源清单表格（ID/标题/来源/时间/安全状态）→ 确认写入 → 窗口提示已写入；服务端 rev 1、草稿 `applied`。过期草稿显示过期原因且无审核入口（服务端亦拒绝）。
- **归并批次与撤销（P0-06）**：bad\path「修正归属」→ 目标 `AcceptTarget` → 预览显示「本批 1 条（共 1 条，剩余 0）」「来源分布（前 20 种）」「本批样本」→ 确认 → 服务端 `scope_merge_operation_items` 精确记录、`moved_ids` 空 →「归并操作记录」→ 撤销 →「已撤销：1 条材料移回原作用域」，服务端材料回 bad\path、operation `reverted`。
- **rev 冲突（P0-02）**：窗口内勾选并「手工整理」（载入 rev 1）→ 编辑期间服务端推进 rev 2 → 提交 → 冲突横幅「版本冲突：服务器最新为 rev 2…」+ 服务器正文展示 + 零写入（来源 25 条全在、记忆仍 rev 2）→「以服务器版本为底稿重新编辑」→ 合并提交 → rev 3、来源 25→24。
- **跨页选择（P1-02）**：25 条材料跨 2 页各勾 1 条 → SelectionReview 完整清单 2 行（含第二页条目）。
- **故障注入（P1-04）**：drop `redaction_events` → 窗口显示「读取队列失败…requestId:req_10d8…」而非空队列 → 重建表后重试恢复。
- **MCP（ZCode 亲自调用）**：签发 Agent 密钥 + trusted_mcp_sources 预置（等价窗口「记住此设备」）→ `initialize` 返回 oneledger（当轮版本号，0.4.14 的上一版）→ `memory.get(project, skills\system\plugin)` 返回 rev 3 合并正文；`memory.get(ConflictScope)` 返回草稿审核写入的记忆。
- **第二轮补验（同隔离实例）**：跨 3 页选择+取消单项+unchanged 门（提交按钮在正文未改时禁用，显式批准后提交，服务端恰好消费清单所列 ID）；46 条操作三页分页（20/20/6、无重复、末页禁用）与页 2 撤销；分页 SQL 故障注入与恢复；batch\scope 3000 条窗口内按批归并（预览「本批 1000/剩余 2000」→ 确认 → operation+items 精确落库），文件库每批 26-39ms。
- 验收结束已停止全部自启调试进程；正式便携版未被覆盖。

## 真实库只读统计（2026-09-30 修复轮复测，只读未写入）

| 指标 | 修复任务书基线（09-30 早） | 本轮复测 |
|---|---|---|
| schema 版本 | 9 | **11**（见下方说明） |
| active 记忆 | 15 | 15 |
| proposed 材料 | ~137,500 | 137,502 |
| project:OneLedger | 68 | 68（分页访问验证通过，首页 20 条正常返回） |
| 作用域总数 | — | 1,780 |
| 归并操作 / items | — | 0 / 0（真实库未做过任何归并） |

**schema 9→11 说明（第三轮纠正自报）**：真实库已从第一轮基线 9 升到 11，迁移表显示 v10/v11 于北京时间 2026-09-30 10:31:53 写入。**触发来源未确认**；旧文中“Agent 未对真实库执行过迁移或写入”没有独立证据，撤回该断言。当前归并操作数为 0，未发现历史归并记录；这只能说明无需按现有操作记录修复归并，不能证明真实库历史零写入。禁止用旧二进制继续写 schema 11 库；回退须恢复与旧版本匹配的完整备份。备份兼容问题见 B-06/B-11。

## 质量门槛（2026-09-30 修复轮终态）

- `npm run check`：**通过**（validate-release + TS server tsc + web strict tsc + vitest 67 用例，含新增 TS 迁移测试 3 个）。
- `cargo test --offline --lib`：**通过**（70 用例 + 2 ignored，其中 ignored 为 TLS 外网用例与 140k 规模压测；规模压测已显式运行并通过，数字见上表）。
- `git diff --check`：无空白错误（仅 CRLF 提示）。
- `npm run build`（tsc + vite）：通过；`sync-web-embed.mjs` 后 `src-tauri/web-assets/index.html` 与 `dist/web/index.html` hash 一致。
- **CI：未运行**（自报）。Linux `check` 与 Windows CI 未验证；第三轮业务缺陷仍开放，旧“本地完成”结论撤回，状态为**未完成、发版阻断**。发版前还须按 AGENTS.md 完成六处版本号、`app_update.json` 公告、Cargo.lock、exe 内嵌版本核验。

## 本轮无法从历史数据自动恢复的事项

- 若任何库在 v10 期间执行过归并并被撤销，被删除/搬移的指纹无法凭操作记录恢复（现版本已不再搬移指纹）；`/api/scopes/merge/fingerprint-report` 提供只读核查线索（受影响作用域当时与现在的指纹计数），修复必须人工核对且有备份在先。当前真实库归并操作为 0，无需修复。

---

以下为初次实施记录（2026-09-30 早间），保留作历史；其中与上节冲突的结论一律以上节为准。

## 2026-09-30 独立复核修正

- `npm run check` 通过 59 个用例，但未纳入前端 strict typecheck；独立执行 `./node_modules/.bin/tsc --noEmit -p web/tsconfig.json` 失败，`Inbox.redacted` 类型缺失。因此当前质量门槛不通过。
- 审核草稿的正文没有装入编辑器，pending 草稿的来源 ID 却会覆盖管理员当前勾选；rev 冲突后 UI 自动使用新 rev，存在再次点击时覆盖他人更新的风险。两项均须修复后重新验收。
- 归并撤销按整个目标作用域迁移指纹，可能误搬目标原有指纹；采集材料去重仅按来源和正文跨项目匹配，可能吞掉其他仓库同文材料。旧测试未覆盖这些场景。
- 最大 73,544 条作用域仅做过预览；实际确认/撤销性能记录只覆盖 50 条。当前代码把所有 ID 放进单条操作记录，未证明巨大归并可安全运行。
- 当前 Rust 内嵌 `web-assets` 与最近一次 `dist/web` build 的 hash 不同；上次交互通过 ZCode 浏览器进行，Tauri 窗口只有截图，因此真实产品窗口交互尚未完成验收。
- 原文“手工 DROP 表/索引即可回滚”不成立：schema v10 标记会保留，后续新版本可能因缺表故障。`db.rs` 也没有“旧程序遇 v10 必 panic”的检查。正确回退需升级前可用备份与匹配二进制，或前向修复；已有业务写入时必须先保全新数据。原文相关说法作废。
- Linux check 与 Windows CI 尚未运行；当前不能宣称可发版。其他已发现缺口及逐项改法见修复任务书。

## 软件里实际新增了什么（初次实施记录，待复验）

1. **蒸馏队列服务端分页与筛选**（`/api/distill/tasks`）：新增 `query`（作用域子串）、`abnormal=1`（只看归属待修正）、`limit/offset` 参数，SQL 内聚合与计数，返回本页 + `total/hasMore`；任务条目不再内嵌样本材料，不再把 WorkBuddy 来源称为「高信号」（改为如实计数 `workbuddy`）。1,780 个作用域只传本页 30 个。
2. **材料明细分页与筛选**（`/api/inbox`）：新增 `scopeKind/scopeId/source/limit(≤100)/offset` 服务端过滤，稳定排序 `created_at DESC, id DESC`，返回 `total`；拒收材料仍只给替换文本与规则类型。
3. **作用域归并**（管理员专用，新文件 Rust `scope_merge.rs` / TS `memory/scopeMerge.ts`）：
   - `POST /api/scopes/merge/preview`：只读预览——待移动数量与来源分布、目标现状（待处理数、正式记忆 id/rev）、待审草稿阻断、采集指纹合并说明、`digest` 状态摘要。不自动猜测仓库名，目标必须人工输入。
   - `POST /api/scopes/merge/confirm`：单事务内重校验 digest、目标为仓库名（无 `/ \ : . ..`）、来源≠目标、全部材料仍处预期作用域与 `proposed` 状态；任一不满足整体回滚并返回冲突+新预览。只移动 `proposed` 材料；正式记忆、拒收材料、凭据不动。操作写入新表 `scope_merge_operations` 并写审计。
   - `POST /api/scopes/merge/revert`：只撤销该操作实际移动过、仍处于目标作用域 `proposed` 状态的材料；任一条已离开则整体拒绝；重复撤销幂等返回。
   - 采集指纹同事务合并（唯一键冲突保留 `last_seen_at` 较新一条），归并后重扫同一文件不重复入队。
   - `GET /api/scopes/merge/operations`：操作记录分页列表（管理台提供查看与撤销入口）。
4. **显式选择蒸馏**：`generate_draft`（Rust+TS）改为必须传入管理员勾选的 `sourceIds`（空=拒绝、>12=拒绝、逐条复核作用域与 `proposed` 状态）；`confirm_sources` 事务内复核补上「同作用域」校验（归并移动材料后旧选择不会被误提交）。
5. **采集事务修复**：Rust `remember` 拆出事务内实现 `remember_tx`，`ingest_collected` 每文件一个事务，材料入队/写入与指纹登记同生共死；指纹失败整体回滚并计入 `CollectResult.errors`（不再 `let _ =` 吞错）。TS 侧 `remember`/`ingestCollected` 同样事务化。材料级去重 `find_collected_inbox` 改为同采集器跨作用域匹配（防归并后重扫重复入队）。
6. **管理台交互**（`web/src/App.tsx`，蒸馏队列内）：
   - 「只看归属待修正」筛选、作用域筛选框、分页；
   - 异常作用域的「修正归属」面板：输入仓库名 → 预览（移动数、目标现状、来源分布、指纹、草稿阻断）→ 确认；「归并操作记录」列表 + 撤销（撤销后自动刷新任务列表）；
   - 审核面板：材料按页加载（每页 20 条，默认全部不勾选、跨页勾选保持、已选数量可见），编辑器载入当前正式记忆整篇与 rev，提交仅处理勾选来源；冲突时保留编辑正文与勾选并提示新 rev；
   - 「生成草稿」必须先勾选材料。
7. **性能修复**（规模测试中发现）：`/api/inbox` 的命中规则查询由每行一次改为 `json_each` 批量（消除 N+1）；新增索引 `inbox_proposed_scope(queue_status, scope_kind, scope_id, created_at)`、`redaction_events_inbox(inbox_id)`（`db.rs` migrate 末尾幂等创建 + `db/sql.ts` INIT_SQL），真库副本上材料明细页 2,465ms → 120ms。

## Schema 迁移与回滚

- `DATA_SCHEMA_VERSION` 9 → 10（`src-tauri/src/util.rs`；TS 侧 `DATA_SCHEMA_VERSION` 保持 7 为其最低要求，scope_merge 表在 `INIT_SQL` 幂等创建）。
- 迁移 v10：新建 `scope_merge_operations(id, from_scope_kind, from_scope_id, to_scope_kind, to_scope_id, moved_ids, moved_count, source_breakdown, status, created_at, reverted_at)` + `scope_merge_ops_status` 索引；`inbox_proposed_scope` 与 `redaction_events_inbox` 两个性能索引在 migrate 末尾幂等创建（对已升级到 v10 的库同样生效）。
- 全量备份覆盖新表（`backup.rs` 导出/导入 `scopeMergeOperations` section）。
- 回滚方式（复核修正）：不得只 `DROP` 新表/索引，因为 schema 版本标记不会随之回退。未发生新业务写入时，使用升级前验证可读的完整备份和对应旧二进制回退；已有新写入时先制定数据保全及前向修复方案。须测试 v9、已有 v10 到修复版的升级与备份恢复。
- 备份导入按 id 合并，`INSERT OR REPLACE` 语义与既有表一致。

## 基线与最终统计（真实库，只读）

| 指标 | 实施前（09-29 快照） | 实施后核查（09-30） |
|---|---|---|
| proposed 材料 | 137,493 | 137,497（+4 为用户正式实例自身采集增量） |
| scopeId 含 `\` 的行 | 62,268 | 62,268（未变） |
| project 作用域总数 | 1,779 | 1,780（+1 同上） |
| 归属待修正作用域 | 1,741 | 1,741（未变） |
| OneLedger 项目待处理 | 68 | 68（未变） |
| 正式记忆 active | 15 | 15（未变） |
| 草稿 / 指纹 | 0 / 105 | 0 / 105（未变） |

**第三轮纠正首次自报：** 当时“实施过程对真实库零写入”的断言没有独立依据，已撤回；当前可证事实及迁移时间见本文顶部。历史建议从 workspace/plugins 批量归并也撤回：当前整批归属审核仍不满足 B-07，不能据规模和作用域名称建议处理真实材料。所有写入验收继续只在隔离库进行。

## 初次实施自报的验收场景结果（发现阻断缺口，全部待复验）

| 场景 | 结果 | 证据 |
|---|---|---|
| 归属待修正筛选与标记 | 通过 | 蒸馏队列红色「归属待修正」标记；`abnormal=1` 只返回异常 project 作用域（真库副本 1,741 个） |
| 归并预览 → 确认 → 审计 | 通过 | 隔离库 `skills\system\demo` → `Demo`：移动 4 条、来源分布、目标 rev、操作记录生成；`scope.merge` 审计写入 |
| 条件撤销 | 通过 | UI 撤销确认弹窗 → 4 条移回原作用域、记录翻转「已撤销」、重复撤销幂等；Rust/TS 单测覆盖「任一条已蒸馏则整体拒绝」 |
| digest 冲突 | 通过 | 预览后状态变化再确认 → `conflict` + 新预览，无部分移动（单测覆盖） |
| 草稿阻断 | 通过 | 来源/目标存在 pending 草稿时预览与确认均阻断（单测覆盖） |
| 错误目标拒绝 | 通过 | 空串、`a\b`、`E:\x`、`.`、`..`、与来源相同均拒绝（单测覆盖） |
| 勾选式蒸馏写入 | 通过 | Target 6 条勾选 3 条 → rev 1→2 恰好推进一次、仅 3 条出队、3 条保留；编辑器载入整篇+rev |
| MCP `memory.get` 验证 | 通过 | Agent Bearer 自连 MCP，读到 rev 2 新正文（id `mem_8c2fc52d32cf56c6b75dc39d`） |
| rev 冲突保留现场 | 通过 | UI 持 rev 2、他人推进 rev 3 后提交 → 冲突提示，编辑正文与勾选保留，rev 与材料未变 |
| provider=none 人工路径 | 通过 | 未配置模型时完整走「勾选 → 手工整理 → 原子确认」（单测+窗口实测） |
| 指纹失败不产生孤儿材料 | 通过 | 注入 `collect_fingerprints` 失败触发器 → 事务回滚、无 inbox 残留、恢复后重扫正常入队一次（单测） |
| 归并后重扫不重复入队 | 通过 | 指纹合并后重扫 skipped=1、queued=0（Rust+TS 单测） |
| Agent 权限边界 | 通过 | 无 token 401；Agent Bearer 访问管理台新接口 401；Agent MCP 搜不到未蒸馏材料正文 |
| 备份覆盖新表 | 通过 | `backup.rs` 单测扩展 roundtrip；`scopeMergeOperations` 进出备份 |

## 初次实施使用的窗口与浏览器验证方式（不满足最终窗口验收）

- 隔离测试实例：`ONELEDGER_HOME=E:\Project\OneLedger\.governance-test\home`、端口 7444（正式实例 7443 未受影响）、采集全关，`tauri dev` 的 Tauri 窗口（debug 构建）。
- 窗口截图确认：管理台加载与登录、蒸馏队列、「归属待修正」标记、归并确认弹窗（MCP 首连 Tauri 原生确认，勾选「记住此设备」）。
- 交互细节使用了 ZCode 内置浏览器驱动 HTTP 页面；这只能证明浏览器路径可操作，不能证明内嵌资产的 Tauri 窗口已完成交互。修复后须重新同步内嵌资产，并在隔离 Tauri 窗口完成全部交互。

## 性能数字（测试机：Windows 11，AMD Ryzen 平台，NVMe，debug 构建）

合成大库：165,684 条 inbox、1,847 个作用域、最大单作用域 73,544 条、路径型 60 个、重名仓库、盘符型作用域。

| 请求（16.5 万行库） | 加索引前 | 加索引后 |
|---|---|---|
| `/api/distill/tasks` 页1 | 311ms | 177ms（热） |
| tasks `abnormal=1` | 155ms | 91ms |
| tasks `query=repo-0100` | 124ms | 50ms |
| `/api/inbox` 全局页1 | 151ms | 149ms |
| `/api/inbox` 深分页 offset=100000 | 650ms | 705ms（OFFSET 语义需扫过前 10 万行，每页仍 <1s） |
| `/api/inbox` 超大作用域页1（7.3 万条） | 176ms | 169ms |
| 归并预览 | 232ms | 14ms |
| 归并确认（50 条，事务含指纹） | 356ms | 116ms |
| 归并撤销（50 条） | 155ms | 55ms |

真库副本（890MB，137k proposed + 44.7 万脱敏事件，挂到隔离实例）：OneLedger 68 条全量分页（50+18 无重复）冷 2,561ms → 修复后 120ms（热 78ms）；tasks 全量列表冷 875ms / 热 588ms（debug 构建；release 打包会更低）。管理台每次请求只传一页（30 作用域 / 50 材料 / 20 明细），窗口无卡顿；73,544 条作用域的面板只渲染本页 20 条。

## 初次检查与测试（修复后须重跑）

- `npm run check`（validate-release + tsc + vitest）：**通过**（11 个测试文件、59 个用例；含新增 scopeMerge 8 个用例、distillJob 显式选择 4 个用例）。
- `cargo test --offline --lib`：**通过**（56 个用例；含 scope_merge 7 个、采集事务/指纹回滚 2 个、分页 2 个）。
- 前端独立 typecheck 当前失败，Linux CI 与 Windows CI 尚未运行。修复后需将前端 typecheck 纳入 `npm run check`，再按 `AGENTS.md` 完成全量门槛；当前状态不可发版。

## 改动文件

- Rust：`src-tauri/src/{db,store,scope_merge(新),service,distill_job,http,backup,models,util}.rs`、`lib.rs`（模块注册）
- TS：`src/db/{sql,driver}.ts`、`src/memory/{store,service,distillJob,scopeMerge(新)}.ts` 及同名测试、`src/http/app.ts`、`src/types.ts`
- 前端：`web/src/{App.tsx,api.ts}`
- 文档：本文件、任务书（未改）

## 剩余风险

1. `/api/inbox` 深分页（offset 数万）在 SQLite OFFSET 语义下仍是线性扫描（<1s/页）；若未来需要更快可改游标（`created_at+id` 键集分页），本期未做。
2. debug 构建的性能数字偏保守，release 打包后应更低；正式打包版本未在本期构建（避免覆盖用户正在使用的版本）。
3. TS 服务模式（postgres 驱动）路径只做了单测级验证，未在真实 Postgres 上跑归并流程（用户环境为 SQLite）。
4. 真实库 1,741 个待修正作用域的归并目标仍需用户逐个人工确认；软件不提供任何自动映射。
5. `tauri dev` 调试实例在 890MB 副本上首次启动时若触发索引重建会长时间满载单核（debug 构建慢）；索引已在迁移/启动幂等建立后消失，正式用户升级时（44.7 万行索引一次性建立，release 构建）预计数十秒内完成且只发生一次。
