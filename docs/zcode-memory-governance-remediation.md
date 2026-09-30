# ZCode 执行任务书：存量材料治理一期完整修复与复验

**v0.4.14 正式发版完成（2026-09-30）。** 用户已授权完整发版流程并执行完毕：提交 `4389337` 推送 main、CI `check` run 36722022853 与 `CI` run 36722023008 全绿（verify ubuntu+windows 双 job）、tag `v0.4.14`、Release run 36722273492（quality + build-and-release）成功、GitHub Release https://github.com/Slocean/OneLedger/releases/tag/v0.4.14 已发布（非 draft/prerelease、Latest；Setup/Portable + 两个 .sha256 上传完整，成品已下载回核验 hash 与内嵌版本）。发布链路细节、本地产物 hash 与发布冒烟见[结果文档顶部「v0.4.14 正式发版完成」](zcode-memory-governance-results.md)。边界：Linux 仅 CI check 通过，业务 UI 未在 Linux 验收；真实账本未触碰。

**最终独立复验状态（2026-09-30）：用户限定本次暂时只验收 Windows，Windows 范围已通过（其「远程 CI 未运行」一句已被上方发版完成取代）。** Codex 经 ZCode MCP 多轮反馈并独立验收：Windows 上 Node 22 check 82 项、Rust 84 项通过；stdio MCP 隔离 Tauri 55/55 项、最终正式构建 HTTP MCP/API 12/12 项通过，负向复现和产物核对均通过。测试实例与端口已关闭，真实存量材料未参与。最终证据和产物见[结果文档顶部](zcode-memory-governance-results.md)。下方状态均为各轮当时的历史记录。

**第六轮收尾历史状态（2026-09-30，ZCode 自报，已由上方 Windows 独立验收取代）。** 当时 Codex 已独立验证源码（npm run check 82 用例、cargo 84 通过 + 2 ignored、负向复现通过）；ZCode 已完成来源安全复核、数据库失败关闭、平台路径身份和 MCP 确认/取消语义修复，等待独立 MCP 验收。产物与本轮结果见[结果文档](zcode-memory-governance-results.md)。

**第五轮状态（2026-09-30，已被第六轮收尾取代）：未通过独立验收。** 用户要求后续仅通过项目 MCP 验证，禁止电脑桌面自动化。当前剩余修复为：TS/Rust 平台路径身份与 Linux 断言、拒绝未来 schema 之前的零写入、确认事务内来源标题/正文二次扫描、stdio MCP 工具清单与明确确认/取消语义。精准复现及 48 项 MCP 验收边界见[结果文档第五轮结论](zcode-memory-governance-results.md)。不得把下方第四轮自报“本地完成”沿用为当前验收状态。完整原有 B/C 清单仍须回归。

**第六轮中途补充（2026-09-30，历史记录，数字与结论已被上方第六轮收尾取代）：** 上述四项曾在当时部分修复（另补 C-04 隔离文件库规模证据与真库只读副本计数），当时 npm check 80、cargo 82+2 ignored，正式 exe SHA-256 `f240ee7a…`（副本 `.governance-test/oneledger-0.4.14-round6-release.exe`）——该 exe 是中途代码包，不得用于本轮之后的验收；其中「来源二次扫描受 scanEnabled 约束」「confirm 一律按同意、无取消路径」两条已在收尾轮修正。

以下状态段为第四轮自报历史。

状态：**唯一执行清单已由第四轮执行完毕：B-01～B-12、C-01/02/04/05/06/07 逐项修复并通过本地验证，终版隔离 Tauri 窗口验收 48/48 通过；CI 矩阵已改但未运行，整体状态「本地完成、发版阻断（CI 未运行）」。逐项证据见[结果文档](zcode-memory-governance-results.md)顶部「逐项修复状态与证据」。** 编写及复核日期：2026-09-30。适用基线：OneLedger 工作区未提交的治理实现。下方清单保留作执行依据与历史；C-03 已在第三轮纠正，不作为代码待办。只在隔离库写入，未对真实库运行迁移或任何写入。

## 第三轮验收结论与本次已认可的修改

本次已重新核对下列全部 B/C 项。**B-01～B-09、B-11、B-12 共 11 项仍未修复；B-10 的资产同步和 exe 更新已通过，最终交互验收仍待完成；C-01/02/04/05/06/07 未关闭，C-03 文档事实纠正已完成。** 本次认可的进展：TS 新增 v10→v11 回填、重复启动、缺表报错三个迁移测试；openDb 失败释放句柄；正文 unchanged 的显式批准门已加入按钮；前端资产与当前 exe 已同步。不再把“旧 exe/资产不一致”作为当前缺陷。

独立质量检查：`npm run check` **67 用例通过**（含 web strict typecheck）；`npm run build` 通过；正常 Windows 权限下 `cargo test --offline --lib` **70 通过、2 忽略**；显式 140k 规模测试通过（本次测试执行 5.48 秒，不与自报 4.62 秒混用）；`git diff --check` 通过。这些检查没有覆盖仍开放的业务失败路径。

独立复现已直接调用当前 build 输出的 TS 实现，以及当前 release Tauri exe 的 Rust HTTP 接口。Tauri 在新隔离 HOME 中启动，全部采集器关闭、`devUi=false`，窗口标题为 OneLedger，实测后关闭所启动进程树。没有借助 dev driver、eval 或改写 confirm。

- **B-01（TS 实际服务）：** 跳过一行 UPDATE 后 confirm/revert 均返回 conflict，却保留 Old/Target 各一行；跳过操作状态 UPDATE 后返回 reverted，操作仍为 applied。
- **B-03（TS + 当前 Tauri/Rust）：** 草稿 expectedRev=0，服务器已为 rev 1，请求改带 expectedRev=1，仍 stored 到 rev 2；来源正文改变但 ID 不变，旧草稿也 stored。TS 确认来源已删除、草稿已 applied。
- **B-04（TS + 当前 Tauri/Rust）：** `status=proposed&ids=<rejected id>` 返回 HTTP 200 和 rejected 行原始正文；TS 同时返回原始标题。测试内容全为合成哨兵。
- **B-05（TS 实际采集）：** 同仓库 A/B 两个文件同文，scannedFiles=2、queued=1、skipped=1；inbox 和 fingerprints 均只有 1 条。
- **B-06（当前 Tauri/Rust 实际备份导入及撤销）：** 目标操作原 items=A/B，导入相同操作 ID、items=C/D 被接受；moved_count=2、实际 items=4；随后撤销返回 revertedCount=4。不是 SQL 推演，是真实产品接口结果。
- **B-11（TS 实际 openDb）：** 合成库设 schema=12，当前支持 11 的程序仍打开且接受写入。
- **C-01（TS 实际归并）：** 删除第 1001 条、前 1000 条不变，总数 1001→1000，digest 不变，旧预览仍 applied。
- **C-05（TS 实际确认）：** 101 个来源一次提交仍 stored，全部 101 条离队；目前前后端没有明确批量上限。

本轮证据文件：独立验收证据 JSON 已按原字节归档至 `.governance-test/history/zcode-memory-governance-independent-evidence.json`（SHA-256 `84ab039c8dffd9faccfb12d3d412efac8f0d5f8f1432e8bd4b1585ae8956ab1a`，Git 忽略目录）。复现脚本和独立库保存在 `.governance-test/independent-acceptance-20260930/`，不含真实资料；目录被 Git 忽略，不能代替应补进 Rust/TS 测试套件的回归用例。

## 当前唯一执行清单（沿用第二轮 B/C 编号，交给 ZCode）

在 `E:\Project\OneLedger` 直接修复下列**全部开放条目**，保留现有未提交工作；C-03 已在本轮文档纠正，仅保持事实边界，不重复作为代码待办。只在隔离库写入，不再对真实库运行迁移或任何写入。每一条代码修复都要新增能在修复前失败、修复后通过的回归用例；Rust/TS 两条路径都受影响时两端均修。更新本文件和 `zcode-memory-governance-results.md` 的当前结论，旧自报记录可作历史附录，不能再放在顶部冒充最终验收。下述 B 为放行阻断，C 为必须一起收口的证据/体验问题。

### B-01 [P0] TS 归并/撤销的冲突结果会提交部分数据库改动

**证据。** `src/memory/scopeMerge.ts::confirmMerge` 的 `UPDATE inbox` 后若 `moved !== ids.length`，在 `store.transaction` 回调中 `return {status:"conflict"}`；`revertMerge` 更新条数不符时相同。`src/db/driver.ts::SqliteDb.transaction` 对**正常返回**一律 `COMMIT`。隔离 SQLite 通过 `BEFORE UPDATE ... RAISE(IGNORE)` 让两行只更新一行，实际得到 `returned_status=conflict, updated_rows=1, rows_after_commit=[('a','target'),('b','old')]`。Rust 版 `scope_merge.rs` 非 applied/reverted 时明确 rollback，因此两端不等价。TS 撤销还没有检查 operation 状态行 `UPDATE ... status='applied'` 的影响条数。

**指定改法。** 在 TS 事务内部对更新条数、操作状态变更、批次明细数不符**抛出明确的 RollbackConflict**，让驱动 rollback；在事务外捕获并构建 `conflict` 与新预览。只读预检可以正常返回，写入开始后的任何业务失败都必须抛出回滚。撤销必须检查状态行恰好更新 1 条。操作表、items、inbox、审计必须同生共死。

**验收。** 分别为确认和撤销注入跳过一行的触发器；接口返回冲突，所有 inbox 行、操作状态、items、审计与事务前逐项一致；重复请求不造成第二次移动。Rust/TS 对照测试。

### B-02 [P0] rev 冲突依旧能直接重试覆盖，并能绕过旧草稿的 expectedRev

**证据。** `web/src/App.tsx::submitEdit` 的冲突分支仍执行 `setEditRev(server.rev)`；编辑器确认按钮的 `disabled` 条件没有 `conflict`，也没有要求用户完成合并。旧正文保留，再点一次会用新 rev 提交。冲突横幅虽说“核对后”，代码没有阻断。草稿模式也共用此逻辑：一个按旧 rev 生成的 pending 草稿可以拿新的 editRev 再提交。

**指定改法。** 冲突时保留提交用旧 rev，进入 `conflictNeedsReview` 状态并禁用提交。单独保存最新服务器 title/body/rev，展示**完整**服务器正文与用户编辑正文的差异；目前 4,000 字截断不足以审核整篇。提供明确的“我已合并最新版本”步骤；人工模式只有在点击该步骤且再次确认完整来源清单后才改用新 rev。草稿模式遇到 rev 冲突必须标记草稿 stale，要求重新生成或废弃后从最新正文手工整理，不能给旧 draftId 换新 rev。编辑期间服务器再更新要再次冲突。

**验收。** 两个编辑者先后写 rev 2/3，A 冲突后连续点/调用保存都不改 rev 3；显式合并后才写 rev 4。草稿以 rev 1 生成、服务器变 rev 2 后，即使请求携带 `expectedRev=2` 与旧 `draftId` 也拒绝且来源不离队。覆盖 >4,000 字正文。

### B-03 [P0] 服务端只核对草稿 status 和 ID，没有原子验证草稿快照

**证据。** `src-tauri/src/service.rs::confirm_sources` 和 `src/memory/service.ts::confirmSources` 在事务**外**读取 pending 草稿，只比较作用域与 `sourceIds`，没有要求请求 rev 等于 `draft.expectedRev`，也没有重算 `sourceFingerprints`。`mark_stale_if_changed` 主要在任务列表读取时运行，Rust 只检查前 50 个 pending 草稿；直接调用 `/api/inbox/resolve` 不依赖列表刷新。材料正文被改但 ID 未变、或管理员传入新 rev 时，可绕过“过期草稿不得提交”的语义。

**指定改法。** 在确认事务内重新读取草稿、正式记忆及每条来源，校验 `status=pending`、请求 rev=`draft.expectedRev`、当前 rev 同值、来源 ID/作用域/状态及 title+body 指纹与草稿完全一致；任何失败返回冲突/过期，零写入。人工模式同样在事务内复核是否存在 pending 草稿。`mark_stale_if_changed` 可更新提示，但不能承担写入安全边界。Rust/TS 一致。

**验收。** 草稿生成后分别修改来源正文、修改正式记忆 rev、不访问任务页直接请求 resolve、同时发起两次确认；所有过期路径保留记忆/来源，只有未过期完整审核可提交一次。

### B-04 [P0] 新的按 ID 查询绕开拒收材料的安全展示

**证据。** `src-tauri/src/http.rs::inbox` 的 `ids` 分支调用无状态筛选的 `store::inbox_by_ids`；只有查询参数 `status=rejected` 才替换 title/body。默认 `status=proposed&ids=<已拒收 ID>` 可返回该拒收行的存储正文。`src/http/app.ts` 的同名分支也一样，并且该分支跳过命中规则查询。管理员接口虽需 admin token，但已违反“拒收材料只给安全替换文本和规则类型”的数据边界。

**指定改法。** ID 查询只服务草稿审核：每个 ID 必须仍为 proposed、同请求作用域，且请求者提供的草稿 ID/作用域能证明关联；不匹配时返回冲突/失效，不返回该行正文。所有返回路径均按**实际 `item.queue_status`** 做拒收脱敏，不依赖客户端传来的 status；安全状态和 hits 与普通分页保持一致。若不需要正文，ID 查询只返回脱敏元数据，减少泄露面。保持 Agent Bearer 不能访问。

**验收。** 隔离库造 rejected 行且原字段含敏感哨兵，分别请求 `status=proposed&ids=...`、`status=rejected&ids=...`、混合 proposed/rejected ID；响应和错误均不含原 title/body/哨兵，正常草稿来源可显示全部必要元数据；Rust/TS 两端验证。

### B-05 [P0] 同一仓库不同文件同文仍被当成一份材料

**证据。** `src-tauri/src/store.rs::find_collected_inbox` 和 `src/memory/store.ts::findCollectedInbox` 虽恢复作用域条件，仍用 `(source, scope, body)` 判重复，没有 `source_key`。同仓库两个不同 `AGENTS.md`、同采集器同正文时，第二个文件的 `remember` 返回 `unchanged`，且采集代码对 unchanged 不登记第二个文件的指纹。第一轮任务书要求“两个不同文件即使正文相同仍都入队”，当前测试只测两个**不同仓库**。

**指定改法。** 新采集行记录稳定的 `collector/source_key`（必要时 schema v12，Rust/TS/备份同步），去重身份改为“同一来源键 + 规则版本 + 内容 hash”；不能再用其他文件的正文相同作唯一依据。人工创建与缺 source_key 的历史行保守处理，不擅自合并；说明旧库缺键无法无损反推。指纹与 inbox 写入仍保持同事务。

**验收。** 同仓库文件 A/B 同文各一条，重扫 A/B 均跳过，修改 B 只新增 B 的一个版本；跨仓库同文也各一条；旧行升级无丢失。Rust/TS 双端测。

### B-06 [P0] 备份导入可把不同批次的 ID 混到同一操作，扩大撤销范围

**证据。** `src-tauri/src/backup.rs::import_backup` 对 `scope_merge_operations` 用 `INSERT OR REPLACE`，对 `scope_merge_operation_items` 用 `INSERT OR IGNORE`；items 表无外键。目标库若已有 operation ID=X、items A/B，再导入同 ID=X 但 items C/D，最终 X 的 items 为 A/B/C/D，操作行却来自备份且 `moved_count` 可能是 2。`load_merge_operation` 优先读取合并后的 item 集，撤销按该集合核查/移动，可能超出任一原始操作。现有 roundtrip 只在空库导入，未覆盖合并冲突。

**指定改法。** operation 与 items 作为不可拆分的整体导入：同 ID 且内容/精确 ID 集完全一致才幂等接受；内容不同则整个操作拒绝并报告冲突，不覆盖旧行，也不叠加 items。为 items 加外键或显式应用级完整性约束，迁移/导入/启动校验 `moved_count == distinct item 数`、item 所属操作存在、状态和目标作用域一致。旧 v10 `moved_ids` 转换时也做计数/重复校验。冲突时整个导入事务回滚或明确隔离跳过该操作及其所有 items，不能留下半组。

**验收。** 空库 roundtrip、相同备份重复导入、同 ID 不同 items、孤儿 item、缺 item、数量不符、旧 v10 记录各测；失败后目标原 operation/items/inbox 不变，撤销只作用于准确原批次。

### B-07 [P0] 1000 条归并只展示首 10 条，无法证明整批属于目标仓库

**证据。** `scope_merge.rs::preview` / `scopeMerge.ts::previewMerge` 对本批最多 1000 条只取 `batchSample` 前 10 条；`web/src/App.tsx::MergePanel` 以折叠样本和“不能证明请勿归并”提示代替全批审核。输入任意合法仓库名即可确认，服务端只校验名字与 digest。若第 11～1000 条含另一项目资料，整批会被误归并。真实库 `workspace` 等历史作用域可能混杂。

**指定改法。** 归并对象必须由管理员**完整可核对的精确 ID 子集**确定：提供本批 1000 条脱敏元数据分页/导出审查与来源路径/仓库证据筛选，允许只选择确认属于某仓库的 ID；默认不选择。预览/摘要绑定所选 ID、目标仓库和原状态，确认事务只移动这批已审核 ID。若选择“整个同源组”，必须有可证明每条都归同一仓库的统一来源规则与例外清单；仅看首 10 条不算证明。无法归属的行留在原队列。1000 上限仍保留。

**验收。** 第 11 条和第 999 条属于其他仓库时，确认目标 A 只移动核实属于 A 的 ID；其余原位。跨页勾选/取消、预览后集合变化、相同正文不同项目、撤销分别测；窗口中能完整复核实际将移动的 ID 集合。

### B-08 [P0] 验收通道进入正式构建，能执行任意 JS，并永久改写确认对话框

**证据。** `web/src/App.tsx` 无条件 `startDevDriver()`；`web/src/devDriver.ts` 支持 `new Function(expression)`，`clickElement` 把 `window.confirm = () => true`、`window.alert = () => undefined` 且不恢复。Rust `/api/dev/ui/{exec,poll,result}` 与 `DevUiChannel` 编入正式 exe，启用条件仅为可落盘的 `config.devUi=true`；`CorsLayer::permissive()` 可放大误配置风险。`.zcode/mcp.json` 和验收脚本含固定可预测的测试 admin token/端口，且 `.zcode/` 未列入 `.gitignore`。`exec` 6 秒超时后未从队列删除命令；窗口稍后打开可执行一个已向调用者报超时的旧点击，结果也可能留在内存 map。当前“窗口验收”通过此通道完成，`window.confirm` 真实交互没有被验证。

**指定改法。** 优先把 dev driver 和 `/api/dev/ui/*` 从**正式构建完全排除**（编译 feature/test 构建门控），不能只靠运行时 config 开关。验收构建仅绑定 loopback，使用每次随机生成的短期 admin token，配置文件/日志/仓库不落原值；`.zcode/mcp.json` 改为不含凭据的模板或加入 ignore 并从交付清单排除。删除任意 `eval` 能力，改为有限、只读的断言命令；严禁改写全局 `confirm/alert`，确需自动测试应模拟明确的用户选择并在调用后恢复。命令队列要有 TTL、超时取消、容量上限、会话关联与结果清理。Tauri 原生确认和 Web 确认均需真实窗口验证，不得用覆盖过的 confirm 证明确认门槛通过。

**验收。** release exe 中找不到 dev 路由/driver/eval；即使旧 config 含 `devUi:true`，端点仍 404；测试构建过期命令永不执行、无窗口时队列不增长、多个窗口/调用者互不串扰；普通点击后 `window.confirm` 原实现不变；无源码中的固定可用 token。

### B-09 [P1] PostgreSQL “unsupported” 只在功能入口，启动路径仍可能先执行 SQLite SQL

**证据。** `src/memory/scopeMerge.ts` 在方法入口检查 `driver === postgres`；但 `src/db/driver.ts::openDb` 先调用 `migrate(db)`，其中无条件执行 SQLite 风格 `INIT_SQL` 和迁移，`src/memory/store.ts` 等普通查询仍有 `json_each`。管理台设置继续提供 PostgreSQL 选项。因此“PG 治理明确 unsupported”并不能保证用户在 PG 模式下能启动并看到可理解的提示。没有真实 PG 隔离测试证据。

**指定改法。** 明确产品支持边界：若本期只支持 SQLite，启动时在发任何 SQLite SQL 前 fail-fast，给出可操作的 `unsupported` 错误，设置界面禁止/说明 PG，文档取消“PG 服务模式镜像”暗示；若保留 PG 支持，方言层实现所有必需 SQL 并在真实 PG 上跑迁移、普通队列、归并、备份、去重全流程。不能只靠 scopeMerge 方法里的分支宣称处理完毕。

**验收。** 选择 PG 后要么启动且全功能经真实 PG 验证，要么在首个 DB 查询前明确拒绝，绝不以随机 SQL 语法错误或空队列结束。

### B-10 [P1] Tauri 包已同步，最终交互验收尚未完成

**第三轮状态：资产与 exe 更新通过，交互终验待完成。** 当前 `web/src/App.tsx` 修改时间 14:35:52，`web-assets/index.html` 14:40:10，release exe 14:41:49；本轮 build 与内嵌资产均为 `index-BCVumcG_.js`，index.html SHA-256 均为 `47FFBBEAC4847F53F8BECBF38EF089CEDD74B199EFCC9292B0F958520A2946AE`，JS SHA-256 均为 `8E817615022E24F36F245881E228A4DBFE8FA5A3E7897AA626CFD764839AB629`。exe SHA-256 为 `08A30986DB7E3ACD5D9D34F531C595EE71BD7634CA9B83B72F458671F1E25398`，可检出新资产名和当轮版本号（0.4.14 的上一版）。独立启动该 exe 得到 OneLedger Tauri 窗口和 health（当轮版本号）；接口实测仍复现 B-03/04/06。以上证明当前包已更新，不证明审核/确认交互通过。

自报的窗口操作仍来自较早 `index-CXNhfXKj.js` 与覆盖 confirm 的 driver；当前 `index-BCVumcG_.js` 的 unchanged 门只能标“代码存在”，不能沿用旧窗口记录作为最终通过证据。B-08 修复以及全部业务修复完成后，仍须对最终 exe 完整复验。

**指定改法。** 所有修复完成后只做一次明确的终版链：`npm run check` → `cargo test --offline --lib` → `npm run build` → `scripts/sync-web-embed.mjs` → Tauri 构建 → 比较嵌入 hash/exe 时间和当前源码 → 用**该 exe**在隔离 HOME/Tauri 窗口重走完整审核、冲突、草稿、归并、撤销、MCP。结果文档记录命令、真实资产 hash、exe 路径/时间、窗口操作证据。不能用早于最后一处修复的截图、驱动输出或 exe 代替。

### B-11 [P0] schema/备份向前兼容没有封口，旧程序可写新库或误导入新备份

**证据。** `src-tauri/src/db.rs::migrate` 和 TS 对应逻辑只拒绝 `version < DATA_SCHEMA_VERSION`，对 `version > 当前版本` 放行。真实库已经 schema 11，旧 v10 二进制仍可能打开并按 `moved_ids` 文本写操作；v11 撤销却从 items 表 JOIN，旧操作可能无法撤销。当前 `src-tauri/src/backup.rs::FORMAT_VERSION` 仍为 1；v11 新操作备份里 `moved_ids` 为空、真实 ID 在新增 `scopeMergeOperationItems`。旧 v10 同格式 1 导入器会接受备份、忽略未知 section，丢失归并撤销必需的 ID。产品版本仍为当轮版本号（0.4.14 的上一版），旧/新程序在名称和版本上也难区分。

**指定改法。** 新版启动时拒绝高于自身支持的 schema，任何未来迁移都不得让旧版静默写新库；对已在用户机器上的旧二进制，文档明确禁止用它打开 schema 11 库，回退只能恢复匹配旧库的完整备份。新全量备份升 `formatVersion`（例如 2），旧格式继续只读兼容；新格式必须包含 operation 与 items 绑定校验，缺失则拒绝，而不是创建不可撤销操作。若把本批修复发布，按 `AGENTS.md` 同步六处产品版本、公告及 exe 嵌入版本，让用户可辨识。不要只改 schema 常量而保留同一发布版本。

**验收。** 模拟数据库 schema 比程序高 1，程序在任何写入前报清晰兼容错误；v10 风格备份升级后仍可恢复并撤销，v11/v12 新备份被旧格式校验拒绝；新格式删除 items section 或制造计数差异必须整体拒绝导入。核对发版包内外版本一致。

### B-12 [P1] 正式记忆读取失败会被当成“该项目没有记忆”继续审核

**证据。** `web/src/App.tsx::fetchCurrentMemory` 捕获 `/api/memories` 错误后 `setError(...)` 并返回 `null`；`openManual`、`openDraftReview` 都把 null 当作“尚无正式记忆”继续打开编辑器。人工路径通常被 rev 冲突拦住，但草稿若 `expectedRev` 正好等于服务端当前 rev，仍可在没有展示当前正式记忆的情况下提交整篇覆盖。

**指定改法。** 读取函数区分“成功返回空数组”和“读取失败”，失败应抛出或返回显式错误状态；任何失败都不能进入可提交审核态。草稿来源元数据不完整或读取失败也同理。只在成功取得当前 rev/正文和全部来源后启用保存；刷新/重试不清除用户已输入正文。前后端 expectedRev 仍须复核。

**验收。** 注入 `/api/memories` 500、超时和来源 ID 查询少一项，编辑器不能提交且显示可重试错误；正常空作用域仍可创建 rev 1，正常已有正式记忆必须完整展示后才能提交。

### C-01 预览的总数变化不一定使 digest 失效

当前 Rust/TS digest 包含本批 ID 与**目标** proposed 数，但不包含来源作用域总 pending 数。来源在本批 1000 之外新增/移走一条时，本批 ID 不变，旧预览仍可确认，界面的“共 N 条/剩余 N 条”已过时。把来源总数或明确的批次版本纳入 digest；测试“第 1001 条变化而前 1000 不变”使旧预览失效。

### C-02 指纹“最近记录”排序在毫秒时间戳相同的时候不确定

`latest_fingerprint_global` / TS 对应查询只 `ORDER BY last_seen_at DESC LIMIT 1`，`now_iso()` 只有毫秒精度；两次快速采集/回退可有同时间戳不同 hash，取到哪条依赖数据库行顺序。增加单调的整数序列/rowid 次序作 tie-breaker，或把当前内容 hash 独立维护为唯一当前状态；同一毫秒内 A→B→A→B 重扫测试只对真实变化入队。

### C-03 结果文档事实纠正已完成，后续保持准确边界

**第三轮文档纠正已完成。** 真实库只读复核仍为 schema **11**、active 15、proposed 137,502、归并操作/items 均 0。迁移表 v10/v11 时间分别为 `2026-09-30T02:31:53.471Z` / `02:31:53.477Z`（北京时间 10:31:53）。schema 从第一轮基线 9 变为 11 是**真实库发生过的写入式迁移**，触发来源未确认。结果文档顶部及历史附录已撤回“真实库零写入”“Agent 未做迁移”断言，并如实标记备份状态未独立核实。不读取/公布正文，后续保持这项事实边界；C-03 不需要再作为代码待办。第一轮仍通过的项目可标“代码/单测通过”，但剩余 B/C 和终版窗口/CI 未过前，总状态保持“未验收”。

### C-04 旧结果中的性能与交互证据要标明适用范围

140k 规模测试独立通过，但它是内存库服务层测试；不能推出真实 890MB 库或修复后的 Tauri 窗口批量操作响应。旧 dev driver 覆盖了 `window.confirm`，因此不能证明原生/网页确认行为。结果文档分别列“服务层合成库”“真实库只读”“终版窗口”证据，不跨层推断；至少在真库副本上测批次预览与单批确认/撤销，在终版 Tauri 窗口核对确认门槛与错误态。

### C-05 人工蒸馏提交没有批量上限

`/api/inbox/resolve` 接受任意数量的 ids；Rust/TS `confirm_sources` 逐条读、逐条复核并在一事务内删除，UI 跨页选择也无数量上限。给人工审核设明确上限（例如每次 100 条，数字按窗口实测调整），超限在前后端均拒绝并提示分批；测试超限请求零写入、边界数成功及窗口响应，不让 13.7 万条进入单个长事务。

### C-06 来源路径只替换斜杠，尚未真正规范化

`normalized_source_key` / TS 对应函数只把 `\\` 换成 `/`，没有规范 Windows 盘符大小写、`.`/`..`、UNC 路径与符号链接；`source_key_is_global` 把 POSIX `/...` 一概视为全局唯一，在 Windows 不一定能证明跨盘唯一。建立平台明确的 canonical source-key 规则；仅对可证同一文件的路径跨作用域比较，无法证明时按作用域保守处理。测试大小写/路径片段/UNC/不同盘符与同名文件，不得因归一化而吞其他文件。

### C-07 旧材料请求的失败仍可能覆盖新请求状态

`DistillTasks.loadMaterials` 的成功分支检查 `materialGen`，但失败分支无代次检查；旧页请求晚失败会在新页成功后设置错误。任务列表 `refresh().finally` 也无代次判断，可能清除新操作的 busy 状态。所有成功、失败和 finally 更新都带相同代次条件；测试快速翻页、筛选、新旧请求乱序及重复点击。

## 原始需求在当前第三轮的状态对照

下列“通过”只代表本轮代码/本地测试已核到对应范围，**不等于终版包或 CI 通过**。这样 ZCode 可以只修剩余问题，不必再从头猜上一轮清单。

| 第一轮编号 | 当前判断 | 对应本轮任务或独立证据 |
|---|---|---|
| P0-01 草稿来源 | **部分通过** | 双入口存在；草稿快照未在事务内重验，见 B-03。 |
| P0-02 rev 冲突 | **未通过** | rev 自动前移且按钮可再点，见 B-02。 |
| P0-03 指纹归并撤销 | **代码/单测通过** | 确认和撤销已不移动指纹；Rust/TS 定向测试通过。 |
| P0-04 跨项目同文 | **部分通过** | 跨仓库同文已测；同仓库不同文件同文仍漏材料，见 B-05。 |
| P0-05 digest | **部分通过** | 精确本批 ID 已绑定；来源总数变更未绑定，见 C-01。 |
| P0-06 大批次 | **部分通过** | 1000 上限及 140k 服务层测试通过；TS 部分提交与批次归属审核见 B-01/B-07。 |
| P1-01 web typecheck | **通过** | 已纳入 `npm run check`，本轮命令通过。 |
| P1-02 选择审核 | **部分通过** | 材料选择清单已完整；归并批次仍只展示前 10 条，见 B-07；草稿 ID 查询见 B-04。 |
| P1-03 操作分页 | **代码逻辑通过，场景待测** | offset 已触发加载；仍需 45 条操作的实际页 20/20/5 验收。 |
| P1-04 读取错误 | **部分通过** | 普通分页失败已显式 5xx；ID 查询安全分支见 B-04。 |
| P1-05 内嵌窗口 | **资产/启动通过，交互终验待完成** | 第三轮资产匹配且 exe 已更新；独立启动和 Rust 接口复现已完成，旧 driver 交互不能替代终验，见 B-08/B-10。 |
| P1-06 PostgreSQL | **未形成可用边界** | 方法返回 unsupported，但启动先执行 SQLite SQL，见 B-09。 |
| P1-07 回滚/schema | **未通过** | 操作导入不一致与旧版读新库，见 B-06/B-11。 |
| P1-08 CI | **未通过** | Linux/Windows CI 未运行。 |
| M-01 WorkBuddy 文案 | **通过** | 已无无依据的“高信号” UI 标签。 |
| M-02 来源截断 | **代码通过** | top20 有 `otherCount/otherKinds`，确认记录含全量本批分布。 |
| M-03 操作列表 | **代码通过** | 概要单 SQL，不读取旧大 `moved_ids`；旧记录兼容仍待 B-06/B-11 验证。 |
| M-04 请求竞态 | **部分通过** | 成功回调有代次；材料 catch 与任务 finally 缺保护，见 C-07。 |
| M-05 旧队列入口 | **通过** | 旧隐式写入路径已收敛为浏览入口。 |
| M-06 归属证据 | **未通过** | 仅前 10 条样本不足以证明整批 1000 条，见 B-07。 |

## 当前最终验收顺序

1. **保护真实库。** 只读核对 schema/行数/迁移时间与备份是否存在；建立新隔离 HOME 和新库，不覆盖现有 `.governance-test` 中可能有价值的测试证据。不要在真实库再试迁移。
2. **先修数据和安全。** B-01、B-03～B-08、B-11 与 C-01/02/05/06 的 Rust/TS、schema/备份成套完成；对跨版本库做 v9→新、v10→新、v11→新及备份冲突测试。再修 B-02/B-09/B-12 和 UI，C-07 随 UI 同测。
3. **一次性回归。** `npm run check`（含 web typecheck）、`cargo test --offline --lib`、显式 140k 测试、`npm run build`、`git diff --check` 全绿；失败必须修复，沙箱权限失败需在正常权限下复核并注明。
4. **终版 Tauri 验收。** 同步内嵌资产并重新构建 exe；隔离窗口走完草稿、手工、>4k 冲突合并、跨页选材、混杂批次归并/撤销、拒收材料边界、MCP 自连、备份冲突拒绝；关闭自启进程。不得用浏览器或被 `confirm` 覆盖的 driver 替代。
5. **CI 门槛与唯一结果。** 当前 `.github/workflows/ci.yml` 仅有 `windows-latest` 的 npm check；要满足 AGENTS 的 Linux check 与 Windows CI，改为 `ubuntu-latest` / `windows-latest` 矩阵，Node 22、`npm ci`、`npm run check`，并保留正常 Windows 环境的 Rust 全量测试证据。本机 WSL 尚未安装 Linux 运行环境，本轮未运行 Linux check，也没有可证明当前未提交改动的远程 CI run。`zcode-memory-governance-results.md` 顶部逐条记录 B/C 状态与证据；业务修复尚未全部通过时保持“未完成”，只有本地修复确实全部通过且 CI 尚缺时才能写“本地修复待 CI”。发版另按 AGENTS 六处版本同步和 exe 内嵌版本核验；本任务不自动发版。

---

## 第一轮任务书与历史基线（保留作参考，当前待办以上述唯一执行清单为准）

## 直接交给 ZCode 的执行指令

在 `E:\Project\OneLedger` **直接修改代码、迁移、测试和结果文档，直至本文所有阻断项通过**，不要只答复方案。先遵守根目录 `AGENTS.md`，按其中 ZCode 条款读取 OneLedger MCP `memory.get(scopeKind=project, scopeId=OneLedger)`，再核对当前代码和未提交改动；以实测代码和用户指令为准。保留他人的未提交工作。不要在用户真实库上试写、归并、撤销、清理或做迁移实验；真实库只读统计。写入测试使用独立目录、独立端口和合成数据。不要给用户 MCP 配置或 Bearer 让用户代测。只使用 Tauri 产品窗口；Vite 只能一次性 build，禁止 Vite/tsx 服务、Electron 和浏览器代替窗口。

本次交付是**修复现有功能**，不是另起账本。沿用 `scopeKind/scopeId`、整篇覆盖、`expectedRev`、现有 MCP 权限边界。不得自动处理真实库约 13.7 万条存量材料，不得猜项目归属。以下各项必须一次完成并逐项留证；任何阻断项未通过，结果只能写“未完成/待复验”，不得称“已验收、可发版”。

## 复核基线与证据边界

- 2026-09-30 本地复核：`npm run check` 通过，11 个测试文件、59 个用例；该命令**没有检查 `web/tsconfig.json`**。独立运行 `./node_modules/.bin/tsc --noEmit -p web/tsconfig.json` 失败：`web/src/App.tsx:1098` 使用 `Inbox.redacted`，而 `web/src/api.ts:226` 的类型没有此字段。一次性前端 build 可成功，不能代替类型检查。
- Rust `cargo test --offline --lib` 在正常 Windows 权限下曾通过 56 个用例、1 个 ignored；受限沙箱中的 DPAPI/进程测试报错不能算产品缺陷。修复 Rust 后仍须重跑。
- 真实库只读快照：schema 9、active 记忆 15 条、`proposed` 材料约 137,500 条、`project:OneLedger` 68 条；活跃便携版未升级为 schema 10。数字会随正常采集变化，复验时重新统计。
- `src-tauri/web-assets/index.html` 当前引用 `index-DKLScYt5.js`；最近一次前端 build 的 `dist/web/index.html` 引用 `index-Dl4Ada9A.js`。Rust `http.rs` 嵌入前者。上次结果文档说窗口截图来自 Tauri，但交互是 ZCode 浏览器访问 HTTP 页面，尚不能证明当前**内嵌资产的 Tauri 窗口**走通流程。
- 下文“已确认”指代码路径、独立命令或隔离数据库能直接复现；“覆盖缺口”指现有证据不足，需按指定场景补测。行号仅供定位，修复后以符号/测试名为准。

## 阻断项：数据正确性与审核安全

### P0-01 草稿被隐藏，却能决定提交来源

**现状。** `web/src/App.tsx` 的 `loadCurrentMemory` 只装入正式记忆正文/rev；没有把 `task.draft.title/body/expectedRev` 放入审核编辑器，也没有完整显示草稿来源。`submitEdit` 却在 `draft.status === pending` 时直接改用 `task.draft.sourceIds`，无视本次 `selectedIds`。现有“所选来源”数量也从草稿隐式计算。可能把未审核草稿关联的来源移出队列，同时保存的是正式记忆原文或另一份手写正文。

**改法。** 在 `web/src/App.tsx` 建立明确的“人工整理”和“审核草稿”两种入口。人工整理只使用显式勾选且已在审核清单显示的 ID；审核草稿时完整装入草稿 title/body/expectedRev，显示草稿与当前正式记忆的全文差异、草稿每个来源的 ID/标题/来源/时间/安全状态，并由管理员明确确认该来源集合。草稿来源与页面勾选不一致时，必须让人重新核对，不准隐式取 `task.draft.sourceIds`。过期草稿禁止直接提交。提交时服务端用 draft ID、rev、来源集合再次校验；若不打算复用草稿提交语义，应要求先废弃草稿再人工整理，并在 UI 明示，不能留下隐式路径。整篇正文为空、与当前正文相同或仅改标题时，仍要明确展示“将处理 N 条来源”的最终确认，避免误消费；可对完全未改正文采用阻断或单独显式批准。`provider=none` 的人工路径须保持可用。

**验收。** 构造正式记忆 A、草稿 B、草稿来源 X/Y、当前勾选 X。打开人工入口只提交 X；打开草稿入口正文为 B，只有审核 X/Y 并确认后才消费 X/Y；取消、过期、来源变化时零写入。测试至少覆盖前端状态/交互及 Rust/TS 服务复核，不只测单个服务函数。

### P0-02 rev 冲突后可覆盖他人修改

**现状。** `App.tsx` 的 `submitEdit` 遇到 `conflict` 时保留旧编辑正文，却把 `editRev` 直接设为 `currentRev`。用户再次点保存，会用旧正文覆盖他人新版本。旧 `QueuePanel` 流程也没有完整的冲突合并 UI。

**改法。** 冲突进入阻断状态，不自动推进用于写入的 rev。重新获取当前正式记忆的 title/body/rev，展示“服务器最新内容 / 我正在编辑的内容 / 来源清单”及差异；管理员明确合并并确认后才能使用新 rev。期间保留原编辑和勾选，若服务器再更新则继续冲突。`QueuePanel` 同样处理或收敛到唯一审核入口，不能保留一个绕过流程的写入按钮。

**验收。** 双编辑者并发，B 先写 rev 3，A 用 rev 2 冲突；A 连续按保存不改变 rev 3 和正文，只有看过 rev 3、手动合并并确认后才写 rev 4；来源在冲突期间仍为 proposed。

### P0-03 归并撤销误搬目标作用域指纹

**现状。** `src-tauri/src/scope_merge.rs` 和 `src/memory/scopeMerge.ts` 在确认/撤销时调用 `merge_fingerprints`。撤销按**整个目标作用域**搬指纹，不按该操作实际触及的指纹。隔离 SQL 复现：来源 `from_fp`、目标原有 `target_fp`，确认后撤销，两者都落回来源。确认中的冲突删除还会丢失一条指纹，现有操作记录没有足够信息恢复。

**指定修法。** 归并/撤销**只改 inbox 作用域，不移动或删除任何 `collect_fingerprints` 行**。从两端移除 `merge_fingerprints` 调用及已无意义的“指纹合并冲突”承诺。采集去重改为稳定来源键策略：`collector + 经过规范化且可证明跨作用域唯一的 source_key + rules_version` 查最近指纹，比较 content hash；作用域变化而同一来源内容不变时跳过，内容变化时只入队一个新版本。对无法证明唯一的来源键继续按作用域去重，不能因共享短名称跨项目吞材料。保留指纹原作用域作为历史归属。确认/撤销原子性不依赖搬指纹。对 v10 已存在、曾发生过错误归并的库提供**只读检测报告和有备份才执行的修复办法**；不能凭 operation 猜回被删除的指纹，无法恢复的列为人工复核。

**验收。** 来源/目标原有指纹、目标归并后新生指纹、同键冲突、两次不同来源归并同一目标，依次确认/撤销后指纹行集合逐字段不变；同一真实文件重扫不重复，改变内容恰好新入队一次。Rust 与 TS 均测。真实库不执行修复。

### P0-04 跨项目同文材料被吞

**现状。** `src-tauri/src/store.rs::find_collected_inbox` 和 `src/memory/store.ts::findCollectedInbox` 忽略传入的 `scopeKind/scopeId`，仅以 `source + body` 查旧材料。两个仓库使用相同 AGENTS 模板时，第二个仓库会命中第一个仓库的材料并返回 `unchanged`，漏掉应有的队列项。

**改法。** 恢复材料级查重的作用域约束；只在有可靠来源键的采集指纹路径跨历史作用域判断“同一文件”，不得靠正文相同判断。必要时给新 inbox 行记录 `collector/source_key`，并做向前迁移；旧行缺来源键时只能保守地按作用域判断，并在结果文档说明历史数据无法 100% 判同源。保持 `scopeId` 为仓库名。

**验收。** RepoA 与 RepoB 同采集器、同标题正文各入队一条；相同文件在人工改归属后重扫跳过；两个不同文件即使正文相同仍都入队。

### P0-05 预览摘要不能唯一锁定待移动集合

**现状。** Rust `scope_merge.rs::state_digest` 与 TS 对应逻辑只哈希 `COUNT + SUM(rowid) + 目标 rev`。两个不同 ID 集合可有相同数量、相同 rowid 总和；目标待处理/草稿/指纹状态也没有形成完整快照。

**改法。** 对**本批待移动的精确 ID 集合及作用域/状态**按稳定顺序流式 SHA-256，纳入目标作用域、目标现有 proposed 数、目标正式记忆 id/rev、相关 pending 草稿状态和必要的操作版本；确认事务内重算并按同一 ID 集合移动。不要为算 digest 把 7 万条正文/ID 全装入前端。返回的 token 要与预览的批次边界绑定。目标状态变化必须返回冲突和新预览；数据库错误不能伪装为冲突或空预览。

**验收。** 等数量/等 rowid 和替换、同批某条离队、新增目标草稿、目标记忆 rev 改变均使旧预览失效；失败时零部分移动。

### P0-06 一次归并 7 万条缺少可控边界和真实压测

**现状。** `confirm` 收集全部 ID 为 `Vec<String>` 并拼进 `scope_merge_operations.moved_ids`；撤销把每个 ID 单独插进临时表。上次性能记录只确认/撤销 50 条，最大作用域 73,544 条**只预览**。同一连接全程加锁，窗口可等待巨大事务。

**指定修法。** 将每次可确认的归并设为**最多 1,000 条**的明确批次，按稳定 `(created_at,id)` 或 `id` 顺序取本批，预览显示“本批 1,000 / 来源剩余 X”；每批是独立事务、独立可撤销 operation，下一批由用户再次确认。不能暗中连续搬完整个作用域。用 `scope_merge_operation_items(operation_id, inbox_id)` 主键表记录**本批精确 ID**，不再把巨大 ID 列表存在单个 TEXT；列表查询只读概要，撤销用 SQL JOIN 核查/更新该批，任何一条已离队则整批拒绝。迁移兼容旧 v10 `moved_ids`：读取/导入旧记录并可安全转成 item 表，原字段保留到兼容期结束。事务失败不留下 operation/items/材料的半成品。界面明确显示批次进度、失败和撤销影响范围，并防重复提交。

**验收。** 140,000+ 条、至少 1,800 作用域、一个 73,544 条作用域的合成库，在真实 Tauri 窗口逐批运行到该作用域全部归并（若耗时过长，至少真实测完整首批/中间批/末批及服务层全批循环，报告总耗时）；抽查每批 exact ID，无遗漏/重复，撤销指定批不影响其他批、目标旧行或后来新增行；故障注入、进程中断后可继续。报告每批 p50/p95/max、窗口响应和内存峰值，不写“预计会更快”。

## 阻断项：界面、接口、构建与交付

### P1-01 前端类型检查漏进质量门槛

**改法。** `web/src/api.ts::Inbox` 补与 Rust API 实际 JSON 一致的 `redacted` 类型（Rust 当前为整数；若改布尔，全链路同步）；`package.json::check` 加 `tsc --noEmit -p web/tsconfig.json`，Windows/Linux CI 调同一 check。检查 Rust/TS 响应模型的 nullable/枚举字段。不得用 `any` 或关 strict 掩盖。

**验收。** 当前 TS2339 消失；故意删掉类型字段时 `npm run check` 能失败；恢复后 check 绿。

### P1-02 选择集合跨页不可审查，草稿/旧队列存在隐藏选择

**现状。** `DistillTasks` 只显示已选数量；翻页后旧选择不可见，材料行只展示来源/标题，缺 ID/创建时间。`QueuePanel` 的筛选/状态切换也可保留已选 ID，并有 `selectedIds.length ? selectedIds : [item.id]` 的隐式回退路径。

**改法。** 两个入口统一一个审核模型，跨页保存选中项的脱敏元数据，提交前呈现**完整已选清单**：ID、仓库、来源、标题、创建时间、安全状态，可逐条取消；明确提示当前筛选之外仍选中的条目。筛选/作用域/队列状态切换时清空选择或要求重新审核，不准隐藏选择。提交前后端再验证集合与作用域/状态。若保留 `QueuePanel`，去掉默认单项隐式回退并补同样的审核；更简单可让它只负责浏览，写入统一跳转任务审核入口。

**验收。** 跨 3 页选择、切换筛选/状态、返回、取消单项，界面列出的 ID 集合与请求中的 ID 完全一致；未展示且未明确选择的材料仍在队列。

### P1-03 归并操作“更多记录”按钮无效

**现状。** `MergeOperations` 的 effect 只依赖 `refreshNonce`，按钮只改变 `offset`，不触发加载；条件 `total > rows.length` 在第 2 页也不正确。

**改法。** 以 `offset` 驱动请求，显示页码和前/后页或稳定的加载更多；`hasMore = offset + rows.length < total`。刷新/撤销保持当前页或明确回首页，阻止旧请求覆盖新页。

**验收。** 造 45 条操作，三页 20/20/5 各能加载，前后页不重复；撤销后状态刷新正确。

### P1-04 后端读取错误被伪装成空队列

**现状。** `src-tauri/src/http.rs` 的 `inbox_page`、`tasks_page` 用 `unwrap_or((Vec::new(),0))`；命中规则的批量查询 `prepare/query_map/flatten` 也会吞错误，草稿刷新错误被忽略。管理员可能把故障误判为“无待处理材料”。

**改法。** 数据查询和必须的安全状态刷新失败时返回带 request ID 的结构化 5xx，前端保留已有行并显示失败/重试；命中规则失败也不能默默返回空 hits。允许可选附加信息失败时要显式标记“部分数据不可用”，禁止以正常成功载荷返回。不要暴露数据库路径、正文或 token。

**验收。** 隔离库通过故障注入使分页 SQL 和 redaction SQL 分别失败，接口返回 5xx，UI 显示错误而非“队列为空”；恢复后重试成功。

### P1-05 内嵌资产和产品窗口未完成验收

**改法。** `npm run check` 绿后执行一次性前端 build + `scripts/sync-web-embed.mjs`；从 `src-tauri/web-assets/index.html` 确认 hash 与新 `dist/web/index.html` 一致，再编译/运行隔离 Tauri 窗口或 `npm run pack` 产物。实际交互必须在 Tauri 窗口内完成：登录、分页/选材、草稿审核、归并预览/单批确认、条件撤销、rev 冲突、MCP `memory.get`。浏览器 HTTP 交互仅可作辅助 API 调试，不算窗口验收。自身调试进程用完退出，正式便携版不覆盖。

**验收。** 记录 exe 路径、构建时间、资产 hash、窗口截图/操作结果的脱敏证据，证明使用的是修复后资产。

### P1-06 PostgreSQL 路径不能用 SQLite 语法冒充一致

**现状。** `src/memory/scopeMerge.ts` 用 `rowid`、`INSERT OR IGNORE`，`src/memory/store.ts` 用 `json_each(?)`，均是 SQLite 语法；TS `INIT_SQL` 也有 SQLite 特性。上次结果仅在 SQLite 测 TS 路径，不能称 Postgres 可用。

**指定修法。** 先核实项目对 PostgreSQL 的正式支持范围。若仍支持，在 driver 方言层实现等价查询/迁移/事务，用真实 PostgreSQL 隔离实例跑完整分页、预览、确认、撤销、去重、备份测试；若本期无法做到，在 PostgreSQL 启动/路由层**明确禁用治理功能并返回 unsupported**，更新文档，不能让用户点到 SQL 运行时报错，也不能宣称 Rust/TS 全路径等价。SQLite 是本轮必要交付；PG 是否启用必须由可复验测试决定。

### P1-07 回滚说明错误且 schema 兼容未核实

**现状。** `zcode-memory-governance-results.md` 说 `DROP TABLE scope_merge_operations` 即可回滚，同时又保留 schema v10 标记；新程序会认为 v10 已迁移，表缺失会故障。它还称旧程序见 v10 必 panic，但 `db.rs` 只检查版本**低于**当前所需版本，这个结论不成立。

**改法。** 删除“手工 DROP 即回滚”的操作建议。采用**升级前经验证备份 + 与备份 schema 匹配的旧二进制**作为完整回退；已有真实归并/记忆写入后必须先制定数据保全方案，不能直接恢复旧备份覆盖新写入。若只修复代码，应前向迁移，且检查 `schema_migrations` 与实际表/索引一致。新增 operation_items 后备份导出/导入要覆盖该表和引用完整性。测试 v9→新版本、已有 v10→新版本、新版本重启、备份 roundtrip、损坏/缺表检测；不得手工改 marker 伪装迁移。

### P1-08 Linux/Windows CI 和结果状态仍是开放门槛

**改法。** 运行本机全量门槛；完成代码后在实际 CI 上跑 Linux `check` 与 Windows CI。若无推送授权或流水线未运行，结果文档明确“CI 未验证，不能发版”，不得用本机 `npm run check` 替代。发版前还须六处版本号、`app_update.json`、Cargo.lock、exe 内嵌版本检查及 `AGENTS.md` 其他规则；本任务无自动发布授权。

## 一并收口的中低风险缺口

| 编号 | 已核实位置和问题 | 明确修法与验收 |
|---|---|---|
| M-01 | `App.tsx` 旧 `QueuePanel` 仍把 WorkBuddy 显示为“高信号”，与新任务页不一致。 | 全 UI 搜索并删除未经证据支持的“高信号”标记，改为来源类型/数量；窗口核对两个入口。 |
| M-02 | `scope_merge.rs`、`scopeMerge.ts` 来源分布只取前 20 种，却无“其余”说明。 | 返回 top 20 + `otherCount/otherKinds`，并保证分布总数等于本批移动数；操作记录同样标明截断。 |
| M-03 | Rust 操作列表 `SELECT *` 会反序列化大 `moved_ids`；TS 列表逐条 `getMergeOperation`，形成 N+1。 | 列表用只含概要字段的单次分页 SQL，详情/撤销按 operation ID 查 items；在大操作样本上测响应体与耗时。 |
| M-04 | 任务筛选、材料翻页等请求没有统一的顺序控制，慢的旧请求可能覆盖新筛选结果。 | 引入 AbortController 或递增 request generation，只有最新请求可更新列表；快速输入/翻页故障注入测试。 |
| M-05 | 旧 `QueuePanel` 只装载前 50 条后以 OFFSET 追加，筛选变更/后台状态变更时选中集合和页结果可能失配。 | 统一选择清单与服务端复核，刷新后标记已失效 ID，禁止提交失效选择；测后台移走一条与跨页变化。 |
| M-06 | 真实库约 1,741 个异常作用域的目标归属尚未核实，`workspace` 可能包含混杂来源。 | 预览加入本批来源/样本/候选证据；对不能证明同一仓库的批次禁止盲归并，支持留在待核队列。真实库不自动归并。 |

## 文件级实施清单

1. `src-tauri/src/{scope_merge,store,service,db,backup,http,distill_job}.rs`：实现精确批次、operation_items 迁移/备份、稳定来源去重、错误传播、草稿来源复核；新增 Rust 回归测试。`src-tauri/src/models.rs` 同步 DTO。schema 版本若增加，按迁移规则单独处理，**不等同于产品发版版本**。
2. `src/{memory/scopeMerge,memory/store,memory/service,memory/distillJob,db/driver,db/sql,http/app,types}.ts`：保持 SQLite 行为与 Rust 一致；PG 支持或显式禁用；新增 TS 测试，包括双项目同文、指纹不变、批次撤销、冲突及错误。
3. `web/src/{App,api}.tsx/ts`：拆清草稿/人工审核、完整来源清单、冲突合并、分页、错误展示、请求顺序、WorkBuddy 标签；必要时抽出可单测组件/状态机。不要仅靠手工截图代替关键交互测试。
4. `package.json` 和 CI 配置：把 web strict typecheck 纳入统一 `check`；一切用于验收的构建同步内嵌资产。
5. `docs/zcode-memory-governance-results.md`：保留历史自报记录，但顶部写复核修正与逐项实际证据，删除或明确作废错误的回滚、窗口已通过、全量规模已验证等说法。`docs/README.md` 添加本文索引。

## 执行与验证顺序，不允许跳步报完成

1. **保护基线。** `git status` 记录已有改动；`npm run check`、web strict typecheck、Rust tests 记录原始输出；只读统计正式库，不打印正文/密钥。建立隔离库、不同端口、关闭自动采集，验证升级前备份可读。不要关闭或覆盖用户运行中的正式实例。
2. **先修数据完整性。** P0-03/04/05/06 和 P1-07 同步设计迁移与备份，完成 Rust/TS 对称测试；异常时恢复隔离库。不得在指纹与批次语义仍不可靠时继续 UI 走通测试。
3. **再修审核路径。** P0-01/02、P1-02/03/04、M 类统一接入；确保不存在旧 `QueuePanel` 绕过路径。前后端对来源集合、rev、草稿状态进行双重验证。
4. **完成质量与兼容。** P1-01/06；`npm run check`、`./node_modules/.bin/tsc --noEmit -p web/tsconfig.json`、`cargo test --offline --lib`、`npm run build`、`git diff --check` 都通过。若本轮代码改动导致原有红项，先修复；不得以“原来就红”放行。
5. **规模和故障。** 140k+ 合成库和一处 73k+ 作用域完成 P0-06 指定批次验证；做事务失败、重复请求、撤销冲突、并发来源变更、等和不同集合 digest、备份恢复、v9/v10 迁移。报告机器、库大小、耗时、内存、请求上限和失败结果。
6. **Tauri 产品验收。** 同步前端嵌入资产、构建隔离 Tauri，亲自在窗口交互，MCP 由 ZCode 自己调用；测试结束关闭自己的进程。真实库只读查看 OneLedger 68 条是否可分页访问。禁止用浏览器成功推断 Tauri 成功。
7. **CI 与文档。** Linux check、Windows CI 真正通过后再写“可发版”；未推送/未运行则写阻断。更新结果文档为“修复清单逐项通过/未通过”，附命令、测试数、窗口证据和具体剩余问题。不要贴用户正文、token 或长串空泛 PASS。

## 最终完成定义

- P0、P1、M 所有条目有代码提交位置、针对性测试、隔离库实测或明确的 unsupported 行为；没有未解释的失败。
- 正式记忆和真实 inbox 在实施期间未被自动归并、删除、蒸馏；真实库写入仅由用户日常运行行为产生。MCP Agent 依然不能读 inbox、草稿、secret/PII 或凭据原值，管理员密钥与 Agent 密钥不混用。
- 单批归并、整篇审核、条件撤销、草稿审核、版本冲突与复核后的召回均在**修复后 Tauri 窗口**及隔离库验证；13.7 万级查询和大作用域批次有实际数字。
- `npm run check` 已包含前端 typecheck；Rust、构建、Linux CI、Windows CI 都绿。任何 CI 未运行则交付状态仍为“本地完成，发版阻断”。
- `zcode-memory-governance-results.md` 顶部结论与证据一致；旧错误声明已纠正；明确哪些问题无法从历史数据自动恢复。
