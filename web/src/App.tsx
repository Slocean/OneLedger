import { useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  getToken,
  keyApi,
  setToken,
  vaultApi,
  type AgentRow,
  type CollectStatus,
  type DistillTask,
  type Inbox,
  type KeyRow,
  type Memory,
  type ScopeMergeOperationRow,
  type ScopeMergePreview,
  type SyncReport,
  type TrustedMcpSourceRow,
  type UpdateInfo,
  type VaultItem,
} from "./api";

// B-08：dev 验收 driver 只在 ONELEDGER_DEV_DRIVER=1 的构建里存在；
// 正式构建该常量为 false，整段代码（含动态导入）会被编译期消除。
declare const __ONELEDGER_DEV_DRIVER__: boolean;
if (__ONELEDGER_DEV_DRIVER__) {
  void import("./devDriver").then((m) => m.startDevDriver());
}

function queueGroupKey(item: Inbox): string {
  if (item.scopeKind === "project" && item.scopeId?.trim()) return item.scopeId.trim();
  if (item.scopeKind === "personal") return "个人";
  if (item.scopeKind === "global") return "全局";
  if (item.scopeId?.trim()) return item.scopeId.trim();
  return "未归属";
}

function groupInbox(items: Inbox[]): Array<{ key: string; items: Inbox[] }> {
  const map = new Map<string, Inbox[]>();
  for (const item of items) {
    const key = queueGroupKey(item);
    const list = map.get(key) ?? [];
    list.push(item);
    map.set(key, list);
  }
  const tail = new Set(["未归属", "个人", "全局"]);
  return [...map.entries()]
    .sort((a, b) => Number(b[1].some((item) => item.source.toLowerCase().includes("workbuddy"))) - Number(a[1].some((item) => item.source.toLowerCase().includes("workbuddy")))
      || Number(tail.has(a[0])) - Number(tail.has(b[0])) || a[0].localeCompare(b[0], "zh"))
    .map(([key, grouped]) => ({ key, items: grouped.sort((a, b) =>
      Number(b.source.toLowerCase().includes("workbuddy")) - Number(a.source.toLowerCase().includes("workbuddy"))
      || b.createdAt.localeCompare(a.createdAt)) }));
}

const NOTICE_KEY = "oneledger.noticeAck";

type Tab = "memories" | "queue" | "vault" | "settings";

function flavorLabel(flavor?: string) {
  if (flavor === "setup") return "安装版";
  if (flavor === "portable") return "便携版";
  if (flavor === "service") return "服务模式";
  return "检测中";
}

function sourceLabel(source?: string) {
  if (!source) return "";
  if (source.includes("raw.githubusercontent.com")) return "GitHub";
  if (source.includes("github.com/") && source.includes("/raw/")) return "GitHub";
  if (source.includes("jsdelivr")) return "jsDelivr";
  if (source.includes("gitmirror")) return "gitmirror";
  if (source === "unreachable" || source === "none") return "未拉到通道";
  if (source === "embedded" || source === "local") return "程序内置";
  return source;
}

function UpdateBox({
  info,
  open,
  checking,
  installing,
  onOpenChange,
  onRefresh,
  onInstall,
}: {
  info: UpdateInfo | null;
  open?: boolean;
  checking?: boolean;
  installing?: boolean;
  onOpenChange?: (open: boolean) => void;
  onRefresh: () => Promise<void>;
  onInstall: () => Promise<void>;
}) {
  const [openHistory, setOpenHistory] = useState(false);
  return (
    <details
      className="advanced"
      open={open}
      onToggle={(event) => onOpenChange?.(event.currentTarget.open)}
    >
      <summary>关于与更新</summary>
      <p className="muted">
        当前 {info?.current ?? "…"}
        {info?.latest ? ` · 通道 ${info.latest}` : ""} · {flavorLabel(info?.flavor)}
        {info?.source ? ` · 来源 ${sourceLabel(info.source)}` : ""}
      </p>
      <p>{info?.message || info?.error || "尚未检查"}</p>
      {info?.can_hot_update ? (
        <p className="muted">
          {info.flavor === "setup"
            ? "安装版：一点即下载、校验，退出后打开安装程序覆盖安装。数据目录不动。"
            : "便携版：一点即下载、校验、替换 exe 并重启。数据目录不动。"}
        </p>
      ) : info?.flavor === "service" ? (
        <p className="muted">服务模式不能热替换。有新版本请到 Releases 下载安装包或便携包。</p>
      ) : info?.flavor ? (
        <p className="muted">当前这个 exe 不能热替换（调试构建或文件名不含 OneLedger）。</p>
      ) : (
        <p className="muted">尚未完成检查。</p>
      )}
      {info?.release_notes ? <pre className="notes">{info.release_notes}</pre> : null}
      <div className="row">
        <button type="button" disabled={checking || installing} onClick={() => void onRefresh()}>
          {checking ? "检查中…" : "检查更新"}
        </button>
        {info?.html_url ? (
          <a className="link-btn" href={info.html_url} target="_blank" rel="noreferrer">
            打开 Release
          </a>
        ) : null}
        {info?.can_hot_update && info.update ? (
          <button className="primary" type="button" disabled={Boolean(installing)} onClick={() => void onInstall()}>
            {installing
              ? "正在更新…"
              : info.flavor === "setup"
                ? `一键安装 ${info.latest}`
                : `一键更新 ${info.latest}`}
          </button>
        ) : null}
        <button type="button" onClick={() => setOpenHistory((open) => !open)}>
          更新公告
        </button>
      </div>
      {openHistory
        ? (info?.history ?? []).map((item) => (
            <article className="item" key={`${item.version}-${item.title}`}>
              <h3>{item.title}</h3>
              <pre className="notes">{item.body || item.notice}</pre>
            </article>
          ))
        : null}
    </details>
  );
}

export function App() {
  const [token, setTokenState] = useState(getToken());
  const [ready, setReady] = useState(false);
  const [tab, setTab] = useState<Tab>("memories");
  const [error, setError] = useState("");
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [installBusy, setInstallBusy] = useState(false);
  const [updateError, setUpdateError] = useState("");
  const [aboutOpen, setAboutOpen] = useState(false);
  const [aboutRevealNonce, setAboutRevealNonce] = useState(0);
  const [notice, setNotice] = useState("");
  const [collect, setCollect] = useState<CollectStatus | null>(null);
  const [collectEpoch, setCollectEpoch] = useState(0);
  const loadUpdates = async (opts?: { reveal?: boolean }) => {
    setUpdateBusy(true);
    setUpdateError("");
    try {
      const data = await api.updates();
      setUpdateInfo(data);
      if (data.ok === false || data.error) {
        setUpdateError(data.error || data.message || "检查更新失败");
      }
      if (data.update && data.notice && localStorage.getItem(NOTICE_KEY) !== data.notice) {
        setNotice(data.notice);
      }
      if (opts?.reveal) {
        setTab("settings");
        setAboutOpen(true);
        setAboutRevealNonce((nonce) => nonce + 1);
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      setUpdateError(/abort/i.test(text) ? "检查更新超时" : text);
    } finally {
      setUpdateBusy(false);
    }
  };
  const installUpdate = async () => {
    setInstallBusy(true);
    setUpdateError("");
    try {
      const result = await api.installUpdate();
      if (result.ok === false || result.error) {
        setUpdateError(result.error || result.message || "更新失败");
        return;
      }
      setUpdateError("");
    } catch (error) {
      setUpdateError(error instanceof Error ? error.message : String(error));
    } finally {
      setInstallBusy(false);
    }
  };

  useEffect(() => {
    if (!token) return;
    api
      .status()
      .then((data) => {
        setReady(true);
        setCollect(data.collect ?? { running: Boolean(data.collecting) });
      })
      .catch(() => setReady(false));
  }, [token]);
  useEffect(() => {
    if (!ready) return;
    void loadUpdates().catch(() => undefined);
  }, [ready]);
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    let wasRunning = Boolean(collect?.running);
    const tick = async () => {
      try {
        const data = await api.status();
        if (cancelled) return;
        const next = data.collect ?? { running: Boolean(data.collecting) };
        if (wasRunning && !next.running) setCollectEpoch((value) => value + 1);
        wasRunning = next.running;
        setCollect(next);
      } catch {
        /* keep last known status */
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), 1000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [ready]);

  if (!ready) {
    if (getToken()) {
      return (
        <div className="app">
          <div className="chrome">
            <header className="masthead">
              <div className="brand">
                <img className="brand-mark" src="/favicon.svg" alt="" />
                <div>
                  <h1>ONELEDGER</h1>
                  <p>共享记忆总账 · MCP · 本地与远端</p>
                </div>
              </div>
            </header>
          </div>
          <main className="stage">
            <CollectBanner collect={{ running: true, message: "正在启动…" }} />
          </main>
        </div>
      );
    }
    return (
      <div className="gate">
        <img className="brand-mark gate-mark" src="/favicon.svg" alt="" />
        <h1>OneLedger</h1>
        <p className="muted">输入本机 config.json 里的 adminToken，管理台与 Agent MCP 密钥是分开的。</p>
        <input
          value={token}
          onChange={(event) => setTokenState(event.target.value)}
          placeholder="admin token"
        />
        <button
          onClick={() => {
            setToken(token.trim());
            setTokenState(token.trim());
            setReady(false);
            api
              .status()
              .then((data) => {
                setReady(true);
                setCollect(data.collect ?? { running: Boolean(data.collecting) });
              })
              .catch((err: Error) => setError(err.message));
          }}
        >
          进入账本
        </button>
        {error ? <p className="error">{error}</p> : null}
      </div>
    );
  }

  return (
    <div className="app">
      <div className="chrome">
        <header className="masthead">
          <div className="brand">
            <img className="brand-mark" src="/favicon.svg" alt="" />
            <div>
              <h1>ONELEDGER</h1>
              <p>共享记忆总账 · MCP · 本地与远端</p>
            </div>
          </div>
          <button
            type="button"
            className={updateInfo?.can_hot_update && updateInfo.update ? "primary" : undefined}
            disabled={updateBusy || installBusy}
            onClick={() => {
              if (updateInfo?.can_hot_update && updateInfo.update) {
                void installUpdate();
                return;
              }
              void loadUpdates({ reveal: true });
            }}
          >
            {installBusy
              ? "正在更新…"
              : updateBusy
                ? "检查中…"
                : updateInfo?.can_hot_update && updateInfo.update
                  ? `一键更新 ${updateInfo.latest}`
                  : updateInfo?.update
                    ? `更新 ${updateInfo.latest}`
                    : updateError
                      ? "检查失败"
                      : updateInfo
                        ? "已是最新"
                        : "检查更新"}
          </button>
        </header>
        <nav className="tabs">
          {(
            [
              ["memories", "记忆"],
              ["queue", "蒸馏队列"],
              ["vault", "凭据空间"],
              ["settings", "设置"],
            ] as const
          ).map(([id, label]) => (
            <button key={id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
        </nav>
        {updateError ? <p className="error">{updateError}</p> : null}
        {updateInfo?.update && !updateError ? (
          <p className="banner">
            发现 {updateInfo.latest}。
            {updateInfo.can_hot_update ? "点顶栏「一键更新」即可。" : "打开「设置 → 关于与更新」查看。"}
          </p>
        ) : null}
        {collect?.running ? <CollectBanner collect={collect} /> : null}
      </div>
      <main className="stage">
        {tab === "memories" ? <Memories refreshKey={collectEpoch} /> : null}
        {tab === "queue" ? <QueueView refreshKey={collectEpoch} /> : null}
        {tab === "vault" ? <VaultPanel /> : null}
        {tab === "settings" ? (
          <SettingsPanel
            updateInfo={updateInfo}
            updateBusy={updateBusy}
            installBusy={installBusy}
            aboutOpen={aboutOpen}
            aboutRevealNonce={aboutRevealNonce}
            collectEpoch={collectEpoch}
            collecting={Boolean(collect?.running)}
            onAboutOpenChange={setAboutOpen}
            onRefreshUpdates={() => loadUpdates({ reveal: true })}
            onInstallUpdate={installUpdate}
          />
        ) : null}
      </main>
      {notice ? (
        <div className="modal">
          <div className="panel">
            <h3>更新通知</h3>
            <p>{notice}</p>
            <button
              className="primary"
              type="button"
              onClick={() => {
                localStorage.setItem(NOTICE_KEY, notice);
                setNotice("");
              }}
            >
              我知道了
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function CollectBanner({ collect }: { collect: CollectStatus }) {
  return (
    <p className="banner collect-banner">
      <span className="spinner" aria-hidden />
      <span>{collect.message || "正在扫描本地记忆…"}</span>
    </p>
  );
}

function Loading({ label = "加载中…" }: { label?: string }) {
  return (
    <p className="loading muted" role="status">
      <span className="spinner" aria-hidden />
      <span>{label}</span>
    </p>
  );
}

function downloadText(filename: string, text: string, type: string) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function memoriesToMarkdown(items: Memory[]): string {
  return items
    .map((item) => [`# ${item.title}`, "", `来源 ${item.source} · ${item.scopeKind} · ${item.sensitivity}`, "", item.body, ""].join("\n"))
    .join("\n---\n\n");
}

type MemoryKind = "global" | "project" | "personal";

const KIND_TABS: Array<{ id: MemoryKind; label: string }> = [
  { id: "global", label: "全局" },
  { id: "project", label: "项目" },
  { id: "personal", label: "个人" },
];

function kindItems(items: Memory[], kind: MemoryKind): Memory[] {
  return items.filter((item) => item.scopeKind === kind);
}

function Memories({ refreshKey = 0 }: { refreshKey?: number }) {
  const [items, setItems] = useState<Memory[]>([]);
  const [kind, setKind] = useState<MemoryKind>("global");
  const [scopeId, setScopeId] = useState("");
  const [draft, setDraft] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState("");
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const backupInputRef = useRef<HTMLInputElement>(null);
  const grouped = useMemo(() => kindItems(items, kind), [items, kind]);
  const selected = grouped.find((item) => (item.scopeId ?? "") === scopeId) ?? grouped[0];
  const refresh = () =>
    void api
      .memories()
      .then((data) => {
        setItems(data.memories);
      })
      .finally(() => setLoaded(true));
  useEffect(() => {
    void refresh();
  }, [refreshKey]);
  useEffect(() => {
    if (!grouped.some((item) => (item.scopeId ?? "") === scopeId)) {
      setScopeId(grouped[0]?.scopeId ?? "");
    }
  }, [kind, grouped, scopeId]);
  useEffect(() => {
    setDraft(selected?.body ?? "");
  }, [selected?.id, selected?.updatedAt]);
  const exportFile = async (format: "json" | "md") => {
    setBusy(format);
    try {
      const pack = await api.exportMemories();
      const stamp = pack.exportedAt.slice(0, 10);
      if (format === "json") {
        downloadText(`oneledger-memories-${stamp}.json`, `${JSON.stringify(pack, null, 2)}\n`, "application/json");
      } else {
        const markdown = `# OneLedger 记忆导出\n\n导出时间 ${pack.exportedAt} · ${pack.count} 条\n\n---\n\n${memoriesToMarkdown(pack.memories)}`;
        downloadText(`oneledger-memories-${stamp}.md`, markdown, "text/markdown");
      }
      setNote(`已导出 ${pack.count} 条记忆。`);
    } catch (error) {
      setNote(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy("");
    }
  };
  const exportBackup = async () => {
    setBusy("backup");
    try {
      const filename = await api.backupExport();
      setNote(`已导出全部数据：${filename}`);
    } catch (error) {
      setNote(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy("");
    }
  };
  const importBackup = async (file: File) => {
    setBusy("import");
    try {
      const parsed = JSON.parse(await file.text()) as unknown;
      const result = await api.backupImport(parsed);
      const applied = Object.entries(result.applied ?? {})
        .map(([key, count]) => `${key} ${count}`)
        .join("，");
      const skipped = Object.entries(result.skipped ?? {})
        .map(([key, count]) => `${key} 跳过 ${count}`)
        .join("，");
      setNote(`导入完成：${applied || "无变更"}${skipped ? `（${skipped}）` : ""}。`);
      refresh();
    } catch (error) {
      setNote(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy("");
    }
  };
  const emptyHint =
    kind === "project"
      ? "还没有项目记忆。Agent 蒸馏时用 memory.remember，带上 scopeKind=project、仓库名 scopeId，以及分类标题 title。"
      : kind === "personal"
        ? "还没有个人记忆。保存会写入个人这一份；同一作用域再写会覆盖。"
        : "还没有全局记忆。默认写在这一页；同一作用域再写会覆盖。";
  return (
    <div className="list">
      <div className="row row-split memory-kind-bar">
        <nav className="tabs" aria-label="记忆分类">
          {KIND_TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={kind === tab.id ? "active" : ""}
              onClick={() => setKind(tab.id)}
            >
              {tab.label}
              <span className="muted"> {kindItems(items, tab.id).length}</span>
            </button>
          ))}
        </nav>
        <div className="row">
          <button disabled={Boolean(busy)} onClick={() => void exportBackup()}>
            {busy === "backup" ? "导出中…" : "导出全部数据"}
          </button>
          <button disabled={Boolean(busy)} onClick={() => backupInputRef.current?.click()}>
            {busy === "import" ? "导入中…" : "导入备份"}
          </button>
          <input
            ref={backupInputRef}
            type="file"
            accept="application/json,.json"
            style={{ display: "none" }}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void importBackup(file);
            }}
          />
          <button disabled={Boolean(busy)} onClick={() => void exportFile("md")}>
            {busy === "md" ? "导出中…" : "导出 Markdown"}
          </button>
        </div>
      </div>
      {!loaded ? (
        <Loading />
      ) : (
        <>
      {grouped.length > 1 ? (
        <nav className="tabs subtabs" aria-label="蒸馏标题">
          {grouped.map((item) => (
            <button
              key={item.id}
              type="button"
              className={(item.scopeId ?? "") === (selected?.scopeId ?? "") ? "active" : ""}
              onClick={() => setScopeId(item.scopeId ?? "")}
            >
              {item.title}
            </button>
          ))}
        </nav>
      ) : null}
      <form
        className="form"
        onSubmit={async (event) => {
          event.preventDefault();
          if (!draft.trim() || saving) return;
          setSaving(true);
          try {
          const result = await api.remember(draft.trim(), {
            title: selected?.title,
            scopeKind: kind,
            scopeId: selected?.scopeId ?? scopeId,
            expectedRev: selected?.rev ?? 0,
          });
          const hitSummary = result.hits?.length
            ? ` 命中：${result.hits.map((hit) => `${hit.type}${hit.field ? `（${hit.field === "title" ? "标题" : "正文"}` : ""}${hit.line ? `第 ${hit.line} 行` : ""}${hit.field ? "）" : ""}`).join("、")}。`
            : "";
          setNote(
            result.status === "conflict" ? `记忆已被其他写入更新到 rev ${result.currentRev}，请核对后再保存。`
              : result.status === "rejected" ? `敏感内容被拒收，未进入记忆。${hitSummary}`
              : result.status === "queued" ? `材料已进入待蒸馏队列。${hitSummary}`
              : result.status === "error" ? "写入失败，请重试。"
              : result.status === "unchanged" ? "内容没有变化。"
              : `已保存。${hitSummary}`,
          );
          if (result.status === "stored" || result.status === "unchanged") refresh();
          } catch (cause) {
            setNote(cause instanceof Error ? cause.message : String(cause));
          } finally {
            setSaving(false);
          }
        }}
      >
        <label>
          {selected ? selected.title : KIND_TABS.find((tab) => tab.id === kind)?.label}
          <span className="muted"> · 同一分类覆盖，不新增条目。标题由 Agent 蒸馏时的 title 决定。</span>
          <textarea rows={14} value={draft} onChange={(event) => setDraft(event.target.value)} />
        </label>
        {selected ? (
          <p className="muted">
            {selected.scopeKind}
            {selected.scopeId ? ` · ${selected.scopeId}` : ""} · rev {selected.rev} · {selected.source}
          </p>
        ) : null}
        <button className="primary" type="submit" disabled={saving}>
          {saving ? "保存中…" : "保存"}
        </button>
        {note ? <p className="ok">{note}</p> : null}
      </form>
      {!selected ? <p className="muted">{emptyHint}</p> : null}
        </>
      )}
    </div>
  );
}

function ageLabel(iso?: string): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "刚刚";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时`;
  return `${Math.floor(hours / 24)} 天`;
}

function draftStatusLabel(status: string): string {
  if (status === "pending") return "待审核";
  if (status === "stale") return "已过期，需重审";
  if (status === "failed") return "生成失败";
  if (status === "discarded") return "已废弃";
  if (status === "applied") return "已审核应用";
  return status;
}

function scopeKey(task: { scopeKind: string; scopeId: string }): string {
  return `${task.scopeKind}\u0000${task.scopeId}`;
}

function scopeDisplayName(task: { scopeKind: string; scopeId: string }): string {
  return task.scopeKind === "project" && task.scopeId ? task.scopeId : task.scopeKind === "personal" ? "个人" : "全局";
}

/** 归并操作记录 + 撤销（P1-03：offset 驱动分页，请求代次防旧响应覆盖新页）。 */
function MergeOperations({ refreshNonce, onReverted }: { refreshNonce: number; onReverted?: () => void }) {
  const PAGE_SIZE = 20;
  const [rows, setRows] = useState<ScopeMergeOperationRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [busyId, setBusyId] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const requestGen = useRef(0);
  const load = (nextOffset: number) => {
    const gen = ++requestGen.current;
    setError("");
    api
      .mergeOperations(nextOffset)
      .then((data) => {
        if (gen !== requestGen.current) return; // 只有最新请求可更新列表（M-04）
        setRows(data.operations);
        setTotal(data.total);
        setOffset(nextOffset);
      })
      .catch((cause) => {
        if (gen !== requestGen.current) return;
        setError(`读取归并记录失败：${cause instanceof Error ? cause.message : String(cause)}`);
      });
  };
  useEffect(() => {
    load(offset);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshNonce]);
  if (!rows) return <Loading label="读取归并记录…" />;
  const hasMore = offset + rows.length < total;
  return (
    <div className="list">
      <h3>归并操作记录</h3>
      {error ? <p className="error">{error}</p> : null}
      {note ? <p className="ok">{note}</p> : null}
      {!rows.length ? <p className="muted">还没有归并操作。</p> : null}
      {rows.map((row) => (
        <article className="item" key={row.id}>
          <h3>
            {row.fromScopeId} → {row.toScopeId}
            <span className="muted"> · 移动 {row.movedCount} 条 · {row.status === "reverted" ? "已撤销" : "已生效"}</span>
          </h3>
          <p className="muted">
            {row.createdAt}
            {row.revertedAt ? ` · 撤销于 ${row.revertedAt}` : ""}
            {Object.keys(row.sourceBreakdown || {}).length
              ? ` · 来源 ${Object.entries(row.sourceBreakdown).map(([source, count]) => `${source} ${count}`).join("、")}`
              : ""}
          </p>
          {row.status === "applied" ? (
            <button
              type="button"
              disabled={Boolean(busyId)}
              onClick={async () => {
                if (!window.confirm(`撤销归并会把这 ${row.movedCount} 条材料移回「${row.fromScopeId}」，仅限仍处于待处理状态的记录。继续？`)) return;
                setBusyId(row.id);
                setNote("");
                try {
                  const result = await api.mergeRevert(row.id);
                  if (result.status === "reverted") {
                    setNote(`已撤销：${result.reverted} 条材料移回原作用域。`);
                    onReverted?.();
                  } else if (result.status === "already-reverted") setNote("该操作已撤销过。");
                  else setNote(`撤销未执行：${result.error ?? result.status}`);
                  load(offset);
                } catch (cause) {
                  setNote(`撤销失败：${cause instanceof Error ? cause.message : String(cause)}`);
                } finally {
                  setBusyId("");
                }
              }}
            >
              {busyId === row.id ? "撤销中…" : "撤销这次归并"}
            </button>
          ) : null}
        </article>
      ))}
      {total > PAGE_SIZE ? (
        <div className="row">
          <button type="button" disabled={offset === 0} onClick={() => load(Math.max(0, offset - PAGE_SIZE))}>
            上一页
          </button>
          <span className="muted">
            第 {Math.floor(offset / PAGE_SIZE) + 1} 页 · 共 {total} 条
          </span>
          <button type="button" disabled={!hasMore} onClick={() => load(offset + PAGE_SIZE)}>
            下一页
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** 单个作用域的归并预览与确认（B-07 全批勾选 + P0-06 批次 + M-02 分布截断）。
 *  本批全部条目（≤1000）以脱敏元数据分页展示，默认全不勾选；确认只提交显式勾选的 ID 子集。
 *  成功后通过 onApplied 把结果交给上层提示（面板本身会关闭，局部提示会随之消失）。 */
function MergePanel({ task, onApplied }: { task: DistillTask; onApplied: (result: { moved: number; toScopeId: string; remaining: number }) => void }) {
  const MERGE_PAGE_SIZE = 50;
  const [target, setTarget] = useState("");
  const [preview, setPreview] = useState<ScopeMergePreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [sourceFilter, setSourceFilter] = useState("");
  const [pageOffset, setPageOffset] = useState(0);
  const runPreview = async () => {
    setBusy(true);
    setNote("");
    setPreview(null);
    setPicked(new Set());
    setPageOffset(0);
    setSourceFilter("");
    try {
      const data = await api.mergePreview(task.scopeId, target.trim());
      if (data.status === "ok") setPreview(data);
      else setNote(data.error ?? "预览失败");
    } catch (cause) {
      setNote(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const confirm = async () => {
    if (!preview?.digest) return;
    const ids = [...picked];
    if (!ids.length) {
      setNote("默认不选择：请先勾选经核对属于该仓库的条目，再确认归并。");
      return;
    }
    setBusy(true);
    try {
      const result = await api.mergeConfirm(task.scopeId, target.trim(), preview.digest, ids);
      if (result.status === "applied") {
        const remaining = typeof result.remaining === "number" ? result.remaining : 0;
        setPreview(null);
        setPicked(new Set());
        onApplied({ moved: result.moved ?? 0, toScopeId: result.toScopeId ?? target.trim(), remaining });
      } else if (result.status === "conflict") {
        setNote(`作用域状态已变化：${result.error ?? "请重新预览"}`);
        setPreview(null);
        setPicked(new Set());
      } else if (result.status === "unsupported") {
        setNote(result.error ?? "当前存储不支持归并功能");
      } else {
        setNote(result.error ?? `未归并：${result.status}`);
      }
    } catch (cause) {
      setNote(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const items = preview?.batchItems ?? [];
  const filtered = sourceFilter.trim() ? items.filter((item) => item.source.toLowerCase().includes(sourceFilter.trim().toLowerCase())) : items;
  const pageItems = filtered.slice(pageOffset, pageOffset + MERGE_PAGE_SIZE);
  return (
    <div className="form">
      <p className="muted">
        「{task.scopeId}」看起来是路径而不是仓库名（{task.pending} 条待处理材料）。输入确切的仓库名，先预览再确认；
        软件不会按路径末段自动猜项目。只有待蒸馏材料会移动，正式记忆、拒收记录与凭据不受影响；
        每批最多 {preview?.batchLimit ?? 1000} 条，归并/撤销不会移动采集指纹。
      </p>
      <label>
        目标仓库名
        <input
          value={target}
          onChange={(event) => setTarget(event.target.value)}
          placeholder="例如：OneLedger"
          disabled={busy}
        />
      </label>
      <div className="row">
        <button type="button" disabled={busy || !target.trim()} onClick={() => void runPreview()}>
          {busy ? "处理中…" : "预览归并"}
        </button>
        {preview ? (
          <button className="primary" type="button" disabled={busy || picked.size === 0} onClick={() => void confirm()}>
            {busy ? "归并中…" : `确认归并勾选的 ${picked.size} 条`}
          </button>
        ) : null}
      </div>
      {note ? <p className={note.startsWith("本批已归并") || note.startsWith("已归并") ? "ok" : "error"}>{note}</p> : null}
      {preview ? (
        <div>
          <p>
            将审核 <b>本批 {preview.batch}</b> 条（共 {preview.pending} 条，本批之后来源还剩 {preview.remaining} 条）；
            目标「{preview.toScopeId}」现有待处理 {preview.toPending} 条
            {preview.toMemory ? `、正式记忆 rev ${preview.toMemory.rev}` : "、尚无正式记忆"}。
            默认全部不勾选，确认只移动你显式勾选并核对过的条目。
          </p>
          {preview.sourceBreakdown?.length ? (
            <p className="muted">
              来源分布（前 20 种）：{preview.sourceBreakdown.map((item) => `${item.source} ${item.count}`).join("、")}
              {preview.otherCount ? `；其余 ${preview.otherKinds ?? 0} 种共 ${preview.otherCount} 条` : ""}
            </p>
          ) : null}
          {preview.blocked?.length ? (
            <ul className="error">{preview.blocked.map((reason) => <li key={reason}>{reason}</li>)}</ul>
          ) : null}
          <div className="row">
            <label>
              按来源筛选
              <input
                value={sourceFilter}
                onChange={(event) => { setSourceFilter(event.target.value); setPageOffset(0); }}
                placeholder="来源包含…（用于核对仓库证据）"
              />
            </label>
            <button type="button" disabled={picked.size === filtered.length} onClick={() => setPicked(new Set(filtered.map((item) => item.id)))}>
              全选当前筛选结果（{filtered.length}）
            </button>
            <button type="button" disabled={picked.size === 0} onClick={() => setPicked(new Set())}>
              清空勾选
            </button>
          </div>
          <table className="sample-table">
            <thead>
              <tr>
                <th>勾选</th>
                <th>ID</th>
                <th>标题</th>
                <th>来源</th>
                <th>创建时间</th>
                <th>安全状态</th>
              </tr>
            </thead>
            <tbody>
              {pageItems.map((item) => (
                <tr key={item.id}>
                  <td>
                    <input
                      type="checkbox"
                      checked={picked.has(item.id)}
                      onChange={() => {
                        setPicked((current) => {
                          const next = new Set(current);
                          if (next.has(item.id)) next.delete(item.id);
                          else next.add(item.id);
                          return next;
                        });
                      }}
                      aria-label={`勾选 ${item.title}`}
                    />
                  </td>
                  <td className="mono">{item.id}</td>
                  <td>{item.title}</td>
                  <td>{item.source}</td>
                  <td className="mono">{item.createdAt}</td>
                  <td>{item.sensitivity}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {filtered.length > MERGE_PAGE_SIZE || pageOffset > 0 ? (
            <div className="row">
              <button type="button" disabled={pageOffset === 0} onClick={() => setPageOffset(Math.max(0, pageOffset - MERGE_PAGE_SIZE))}>
                上一页
              </button>
              <span className="muted">
                第 {Math.floor(pageOffset / MERGE_PAGE_SIZE) + 1} 页 · 本页 {pageItems.length} 条 / 筛选后 {filtered.length} 条
              </span>
              <button type="button" disabled={pageOffset + MERGE_PAGE_SIZE >= filtered.length} onClick={() => setPageOffset(pageOffset + MERGE_PAGE_SIZE)}>
                下一页
              </button>
            </div>
          ) : null}
          <p className="muted">
            确认前请再次核对目标仓库名与已勾选的 {picked.size} 条 ID；无法证明属于同一仓库的条目留在队列即可，
            不勾选就不会移动。归并后可按操作记录撤销（仅限仍待处理的材料）。
          </p>
        </div>
      ) : null}
    </div>
  );
}

/** 已选来源元数据：跨页保留，提交前完整呈现（P1-02）。 */
interface SelectedSource {
  id: string;
  title: string;
  source: string;
  createdAt: string;
  sensitivity: string;
}

const TASK_PAGE_SIZE = 30;
const MATERIAL_PAGE_SIZE = 20;

/** 完整已选清单：ID、仓库、来源、标题、创建时间、安全状态，可逐条取消。 */
function SelectionReview({
  items,
  fixed,
  onCancel,
}: {
  items: SelectedSource[];
  fixed?: boolean;
  onCancel?: (id: string) => void;
}) {
  if (!items.length) return null;
  return (
    <details className="selection-review" open>
      <summary>将处理 {items.length} 条来源（提交前请逐条核对）</summary>
      <table className="sample-table">
        <thead>
          <tr>
            <th>ID</th>
            <th>标题</th>
            <th>来源</th>
            <th>创建时间</th>
            <th>安全状态</th>
            {fixed ? null : <th />}
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id}>
              <td className="mono">{item.id}</td>
              <td>{item.title}</td>
              <td>{item.source}</td>
              <td className="mono">{item.createdAt}</td>
              <td>{item.sensitivity === "public" ? "公开" : item.sensitivity}</td>
              {fixed ? null : (
                <td>
                  <button type="button" onClick={() => onCancel?.(item.id)}>
                    取消
                  </button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

function toSelectedSource(item: Inbox): SelectedSource {
  return {
    id: item.id,
    title: item.title,
    source: item.source,
    createdAt: item.createdAt,
    sensitivity: item.sensitivity,
  };
}

function DistillTasks({ refreshKey = 0, onHandled }: { refreshKey?: number; onHandled?: () => void }) {
  const [tasks, setTasks] = useState<DistillTask[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [page, setPage] = useState(0);
  const [filter, setFilter] = useState("");
  const [abnormalOnly, setAbnormalOnly] = useState(false);
  const [provider, setProvider] = useState("none");
  const [model, setModel] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [openKey, setOpenKey] = useState("");
  // abnormal 作用域展开时的面板选择："review"=材料审核（P1-02 统一入口），默认/空=归属修正
  const [openPanel, setOpenPanel] = useState<"" | "review" | "merge">("");
  const [materials, setMaterials] = useState<Inbox[]>([]);
  const [materialTotal, setMaterialTotal] = useState(0);
  const [materialPage, setMaterialPage] = useState(0);
  const [materialLoading, setMaterialLoading] = useState(false);
  const materialGen = useRef(0);
  // P1-02：勾选保存完整元数据，跨页保留；切换作用域/筛选即清空
  const [selected, setSelected] = useState<SelectedSource[]>([]);
  // P0-01：编辑入口二选一——manual 只用显式勾选，draft 完整装入草稿与来源集合
  const [editing, setEditing] = useState<"" | "manual" | "draft">("");
  const [editTitle, setEditTitle] = useState("");
  const [editBody, setEditBody] = useState("");
  const [editRev, setEditRev] = useState(0);
  const [editLoaded, setEditLoaded] = useState("");
  const [draftSources, setDraftSources] = useState<SelectedSource[]>([]);
  const [currentMemory, setCurrentMemory] = useState<{ title: string; body: string; rev: number } | null>(null);
  // P0-02：rev 冲突阻断状态——不自动推进 rev，需管理员核对合并后显式确认
  const [conflict, setConflict] = useState<{ serverTitle: string; serverBody: string; serverRev: number } | null>(null);
  // B-02：冲突期间提交按钮禁用；「我已合并服务器最新内容」确认后进入二次确认（手工模式）
  const [mergeConfirmed, setMergeConfirmed] = useState(false);
  // B-12：当前正式记忆读取失败——非空时禁止提交，只允许重试
  const [memoryLoadError, setMemoryLoadError] = useState("");
  // P0-01：整篇正文与当前正式记忆完全相同时，消费来源需要单独显式批准
  const [confirmUnchanged, setConfirmUnchanged] = useState(false);
  const [saving, setSaving] = useState(false);
  const [mergeNonce, setMergeNonce] = useState(0);
  const [showMerges, setShowMerges] = useState(false);
  const [report, setReport] = useState<{ note: string; operations: Array<Record<string, unknown>> } | null>(null);

  const taskGen = useRef(0);
  const refresh = (nextPage = page, nextFilter = filter, nextAbnormal = abnormalOnly) => {
    const gen = ++taskGen.current;
    api
      .distillTasks({ query: nextFilter, abnormal: nextAbnormal, offset: nextPage * TASK_PAGE_SIZE })
      .then((data) => {
        if (gen !== taskGen.current) return; // 慢的旧请求不得覆盖新筛选（M-04）
        setTasks(data.tasks);
        setTotal(data.total);
        setHasMore(data.hasMore);
        setProvider(data.provider);
        setModel(data.model);
        setError("");
      })
      .catch((cause) => {
        if (gen !== taskGen.current) return;
        setError(`加载任务失败：${cause instanceof Error ? cause.message : String(cause)}`);
      })
      .finally(() => {
        // C-07：旧请求的 finally 不得清除新操作的 busy 状态
        if (gen === taskGen.current) setBusy("");
      });
  };
  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey, page, filter, abnormalOnly]);

  const openTask = tasks.find((task) => scopeKey(task) === openKey);

  const loadMaterials = (task: DistillTask, nextPage = 0) => {
    const gen = ++materialGen.current;
    setMaterialLoading(true);
    return api
      .inbox("proposed", { scopeKind: task.scopeKind, scopeId: task.scopeId, limit: MATERIAL_PAGE_SIZE, offset: nextPage * MATERIAL_PAGE_SIZE })
      .then((data) => {
        if (gen !== materialGen.current) return; // 翻页竞态防护（M-04）
        setMaterials(data.inbox);
        setMaterialTotal(data.total);
        setMaterialPage(nextPage);
      })
      .catch((cause) => {
        // C-07：失败分支同样要带代次检查——旧页请求晚失败不得覆盖新页的错误状态
        if (gen !== materialGen.current) return;
        setError(`加载材料失败：${cause instanceof Error ? cause.message : String(cause)}`);
      })
      .finally(() => {
        if (gen === materialGen.current) setMaterialLoading(false);
      });
  };

  /** B-12：区分「成功但为空」与「读取失败」——失败时编辑器不能进入可提交状态。 */
  const fetchCurrentMemory = async (
    task: DistillTask,
  ): Promise<{ ok: true; memory: { title: string; body: string; rev: number } | null } | { ok: false; message: string }> => {
    try {
      const { memories } = await api.memories({ scopeKind: task.scopeKind, scopeId: task.scopeId });
      const current = memories[0];
      return { ok: true, memory: current ? { title: current.title, body: current.body, rev: current.rev ?? 0 } : null };
    } catch (cause) {
      return { ok: false, message: cause instanceof Error ? cause.message : String(cause) };
    }
  };

  const resetEditor = () => {
    setEditing("");
    setEditLoaded("");
    setDraftSources([]);
    setCurrentMemory(null);
    setConflict(null);
    setConfirmUnchanged(false);
    setMemoryLoadError("");
  };

  const openEditor = async (task: DistillTask) => {
    setOpenKey(scopeKey(task));
    setNote("");
    setError("");
    setSelected([]);
    resetEditor();
    await loadMaterials(task, 0);
  };

  const openManual = async (task: DistillTask) => {
    // 保留已勾选：手工入口处理的就是用户显式勾选的集合（跨页保留，P1-02）
    resetEditor();
    const result = await fetchCurrentMemory(task);
    if (!result.ok) {
      // B-12：读取失败不得当作「尚无记忆」继续进入可提交审核态
      setCurrentMemory(null);
      setMemoryLoadError(result.message);
      setEditLoaded("载入当前正式记忆失败：在成功取得当前 rev 与正文前无法提交。可点击「重试读取」恢复。");
      setEditing("manual");
      return;
    }
    const current = result.memory;
    setCurrentMemory(current);
    setEditTitle(current?.title ?? "");
    setEditBody(current?.body ?? "");
    setEditRev(current?.rev ?? 0);
    setEditLoaded(current ? `已载入当前正式记忆（rev ${current.rev}）。只处理你显式勾选的材料。` : "该项目还没有正式记忆，保存后创建 rev 1。");
    setEditing("manual");
  };

  /** B-12：重试读取当前正式记忆；不清除用户已输入的正文。 */
  const retryLoadMemory = async (task: DistillTask) => {
    const result = await fetchCurrentMemory(task);
    if (!result.ok) {
      setMemoryLoadError(result.message);
      return;
    }
    setMemoryLoadError("");
    setCurrentMemory(result.memory);
    if (result.memory) {
      setEditTitle((prev) => (prev.trim() ? prev : result.memory!.title));
      setEditBody((prev) => (prev.trim() ? prev : result.memory!.body));
      setEditRev(result.memory.rev);
      setEditLoaded(`已载入当前正式记忆（rev ${result.memory.rev}）。只处理你显式勾选的材料。`);
    } else {
      setEditRev(0);
      setEditLoaded("该项目还没有正式记忆，保存后创建 rev 1。");
    }
  };

  /** 草稿审核（P0-01）：完整装入草稿 title/body/expectedRev 与草稿来源元数据，正文差异同屏展示。 */
  const openDraftReview = async (task: DistillTask) => {
    const draft = task.draft;
    if (!draft || draft.status !== "pending") {
      setNote("草稿已过期或已处理，不能直接提交；请重新生成或手工整理。");
      return;
    }
    resetEditor();
    try {
      const data = await api.inbox("proposed", { ids: draft.sourceIds, draftId: draft.id });
      const rows = data.inbox.map(toSelectedSource);
      setDraftSources(rows);
      const result = await fetchCurrentMemory(task);
      if (!result.ok) {
        setCurrentMemory(null);
        setMemoryLoadError(result.message);
        setEditLoaded(`已载入待审草稿（expectedRev ${draft.expectedRev}）与草稿来源 ${rows.length} 条。载入当前正式记忆失败：在成功取得当前 rev 与正文前无法提交。`);
        setEditing("draft");
        return;
      }
      const current = result.memory;
      setCurrentMemory(current);
      setEditTitle(draft.title);
      setEditBody(draft.body);
      setEditRev(draft.expectedRev);
      setEditLoaded(
        `已载入待审草稿（expectedRev ${draft.expectedRev}）与草稿来源 ${rows.length} 条。` +
          (current ? `当前正式记忆为 rev ${current.rev}。` : "该项目还没有正式记忆。"),
      );
      setEditing("draft");
    } catch (cause) {
      setError(`载入草稿来源失败：${cause instanceof Error ? cause.message : String(cause)}`);
    }
  };

  const toggleSelected = (item: Inbox) => {
    setSelected((items) =>
      items.some((row) => row.id === item.id)
        ? items.filter((row) => row.id !== item.id)
        : [...items, toSelectedSource(item)],
    );
  };

  const afterResolved = (task: DistillTask, ids: number) => {
    setEditing("");
    setOpenKey("");
    setSelected([]);
    setEditBody("");
    setEditRev(0);
    resetEditor();
    setNote(`${scopeDisplayName(task)} 已写入正式记忆，处理了 ${ids} 条来源。`);
    refresh();
    onHandled?.();
  };

  /** 提交（P0-01/B-02）：draft 模式带 draftId 与草稿来源集合；conflict 进入阻断合并，
   *  绝不自动推进 rev——rev 只能在「我已合并服务器最新内容」显式步骤中更新（且仅限手工模式）。 */
  const submitEdit = async (task: DistillTask, mode: "manual" | "draft") => {
    const ids = mode === "draft" ? draftSources.map((item) => item.id) : selected.map((item) => item.id);
    if (!ids.length) {
      setNote(mode === "manual" ? "请先勾选本次要处理的材料；未勾选的材料不会离开队列。" : "草稿来源为空，请先废弃草稿并重新整理。");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const result = await api.resolveInbox(ids, editBody.trim(), editTitle.trim(), editRev, mode === "draft" ? { draftId: task.draft?.id } : undefined);
      if (result.status === "stored" || result.status === "unchanged") {
        afterResolved(task, ids.length);
      } else if (result.status === "conflict") {
        // B-02：冲突进入阻断状态。重新获取服务器最新内容；绝不把本端 rev 推进到 currentRev。
        const server = await fetchCurrentMemory(task);
        if (server.ok && server.memory) {
          setConflict({ serverTitle: server.memory.title, serverBody: server.memory.body, serverRev: server.memory.rev });
        } else if (!server.ok) {
          setConflict(null);
          setError(`冲突后读取服务器最新内容失败：${server.message}。再次提交仍会冲突，请稍后重试。`);
          setSaving(false);
          refresh();
          return;
        } else {
          // 服务器记忆已消失（如被删除）：以 rev 0 为准阻断
          setConflict({ serverTitle: "", serverBody: "", serverRev: 0 });
        }
        setMergeConfirmed(false);
        setNote(
          mode === "draft"
            ? "草稿提交时正式记忆已被他人更新：草稿已标记过期，不能给旧草稿换新 rev。请废弃草稿后重新生成，或从最新正文手工整理。"
            : "正式记忆已被其他人更新：请核对服务器最新内容，手动合并后通过「我已合并服务器最新内容」确认；在你确认前不会写入。",
        );
        refresh();
      } else if (result.status === "rejected") {
        setNote(`敏感内容被拒收，未写入。${result.hits?.length ? ` 命中：${result.hits.map((hit) => hit.type).join("、")}` : ""}`);
      } else {
        setNote(`写入未成功：${result.error ?? result.status}。编辑内容与勾选保留。`);
      }
    } catch (cause) {
      setError(`写入失败：${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setSaving(false);
    }
  };

  /** B-02：手工模式专用——管理员声明已合并服务器最新版本，二次确认后携带新 rev 提交。 */
  const applyMergedRevision = () => {
    if (!conflict) return;
    setEditRev(conflict.serverRev);
    setConflict(null);
    setMergeConfirmed(false);
    setNote(`已采用服务器 rev ${conflict.serverRev}：请再次核对完整来源清单后提交。`);
  };

  const generateDraft = async (task: DistillTask) => {
    if (!selected.length) {
      setNote("生成草稿前请先勾选材料（一次最多 12 条）；未勾选时不会向模型发送任何内容。");
      return;
    }
    setBusy(`draft:${scopeKey(task)}`);
    setNote("");
    try {
      const result = await api.distillDraft(task.scopeKind, task.scopeId, selected.map((item) => item.id));
      if (result.status === "pending") setNote(`草稿已基于你勾选的 ${selected.length} 条材料生成，请通过「审核草稿」入口核对后再写入。`);
      else if (result.status === "failed") setNote(`草稿生成失败：${result.error ?? ""}`);
      else setNote(`未生成草稿：${result.error ?? result.status}`);
      refresh();
    } catch (cause) {
      setError(`生成草稿失败：${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setBusy("");
    }
  };

  const loadReport = async () => {
    try {
      const data = await api.fingerprintReport();
      setReport({ note: data.note, operations: data.operations });
    } catch (cause) {
      setError(`读取指纹检测报告失败：${cause instanceof Error ? cause.message : String(cause)}`);
    }
  };

  if (tasks.length === 0 && total === 0 && !filter && !abnormalOnly) {
    return <p className="muted">没有待蒸馏任务。采集到新材料后会自动出现在这里。</p>;
  }
  const activeSources = editing === "draft" ? draftSources : selected;
  return (
    <div className="list">
      <p className="muted">
        共 {total} 个作用域。模型提供方：
        <b>{provider === "none" ? " 未配置（手工整理正文）" : ` ${provider}${model ? ` · ${model}` : ""}`}</b>
      </p>
      {note ? <p className={note.includes("已写入") || note.includes("已归并") || note.startsWith("本批已归并") ? "ok" : "error"}>{note}</p> : null}
      {error ? <p className="error" role="alert">{error}</p> : null}
      <div className="row">
        <label>
          筛选作用域
          <input value={filter} onChange={(event) => { setPage(0); setFilter(event.target.value); setOpenKey(""); setSelected([]); resetEditor(); }} placeholder="输入仓库名片段" />
        </label>
        <button type="button" className={abnormalOnly ? "active" : ""} onClick={() => { setPage(0); setAbnormalOnly((value) => !value); setOpenKey(""); setSelected([]); resetEditor(); }}>
          {abnormalOnly ? "✓ 只看归属待修正" : "只看归属待修正"}
        </button>
        <button type="button" onClick={() => setShowMerges((value) => !value)}>
          {showMerges ? "收起归并记录" : "归并操作记录"}
        </button>
        <button type="button" onClick={() => void loadReport()}>
          指纹检测报告
        </button>
      </div>
      {showMerges ? (
        <MergeOperations
          refreshNonce={mergeNonce}
          onReverted={() => {
            setMergeNonce((value) => value + 1);
            refresh();
          }}
        />
      ) : null}
      {report ? (
        <details className="advanced">
          <summary>v10 归并指纹核查报告（只读，{report.operations.length} 条操作记录）</summary>
          <p className="muted">{report.note}</p>
          {report.operations.length ? (
            <table className="sample-table">
              <thead>
                <tr>
                  <th>操作</th>
                  <th>来源作用域</th>
                  <th>目标作用域</th>
                  <th>移动</th>
                  <th>状态</th>
                  <th>现指纹（来源/目标）</th>
                </tr>
              </thead>
              <tbody>
                {report.operations.map((op) => (
                  <tr key={String(op.operationId)}>
                    <td className="mono">{String(op.operationId)}</td>
                    <td>{String(op.fromScope)}</td>
                    <td>{String(op.toScope)}</td>
                    <td>{String(op.movedCount)}</td>
                    <td>{String(op.status)}</td>
                    <td>
                      {String(op.fingerprintsNowInFromScope)} / {String(op.fingerprintsNowInToScope)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="muted">没有归并操作记录，无需核查。</p>
          )}
        </details>
      ) : null}
      {tasks.map((task) => {
        const open = openKey === scopeKey(task);
        const draft = task.draft;
        const isAbnormal = task.abnormal;
        return (
          <article className={`item queue-item${open ? " is-open" : ""}`} key={scopeKey(task)}>
            <h3>
              {scopeDisplayName(task)}
              {isAbnormal ? <span className="error"> · 归属待修正</span> : null}
              <span className="muted">
                {" "}· 待处理 {task.pending} 条 · 最旧等待 {ageLabel(task.oldestWaitingAt)}
                {task.workbuddy ? ` · WorkBuddy 来源 ${task.workbuddy} 条` : ""}
              </span>
            </h3>
            {draft ? (
              <p className="muted">
                草稿 {draftStatusLabel(draft.status)} · 生成于 {draft.updatedAt} · 尝试 {draft.attempts} 次 · 覆盖来源 {draft.sourceIds.length} 条
                {draft.staleReason ? ` · ${draft.staleReason}` : ""}
                {draft.error ? ` · ${draft.error}` : ""}
              </p>
            ) : (
              <p className="muted">尚无草稿。{provider === "none" ? "可直接手工整理整篇摘要。" : "勾选材料后可生成模型草稿。"}</p>
            )}
            <div className="row">
              <button
                type="button"
                className={open ? "active" : ""}
                disabled={Boolean(busy)}
                onClick={() => {
                  if (open) {
                    setOpenKey("");
                    setOpenPanel("");
                    return;
                  }
                  setBusy(`open:${scopeKey(task)}`);
                  setOpenPanel("review");
                  void openEditor(task)
                    .catch((cause) => setError(`打开失败：${cause instanceof Error ? cause.message : String(cause)}`))
                    .finally(() => setBusy(""));
                }}
              >
                {busy === `open:${scopeKey(task)}` ? "打开中…" : open ? "收起" : "审核 / 整理"}
              </button>
              {isAbnormal ? (
                <button type="button" onClick={() => { setOpenKey(open && openPanel === "merge" ? "" : scopeKey(task)); setOpenPanel("merge"); setEditing(""); resetEditor(); }}>
                  修正归属
                </button>
              ) : null}
              {draft && draft.status !== "discarded" ? (
                <button
                  type="button"
                  disabled={Boolean(busy)}
                  onClick={async () => {
                    setBusy(`discard:${draft.id}`);
                    try {
                      await api.discardDraft(draft.id);
                      setNote("草稿已废弃，来源材料保持待处理。");
                      resetEditor();
                      refresh();
                    } catch (cause) {
                      setError(`废弃失败：${cause instanceof Error ? cause.message : String(cause)}`);
                    } finally {
                      setBusy("");
                    }
                  }}
                >
                  {busy === `discard:${draft.id}` ? "废弃中…" : "废弃草稿"}
                </button>
              ) : null}
            </div>
            {open && openTask ? (
              isAbnormal && !editing && openPanel !== "review" ? (
                <MergePanel
                  task={openTask}
                  onApplied={(mergeResult) => {
                    setMergeNonce((value) => value + 1);
                    setOpenKey("");
                    setNote(
                      mergeResult.remaining > 0
                        ? `本批已归并 ${mergeResult.moved} 条材料到「${mergeResult.toScopeId}」，来源作用域还剩 ${mergeResult.remaining} 条；请再次预览并确认下一批。`
                        : `已归并 ${mergeResult.moved} 条材料到「${mergeResult.toScopeId}」。可在操作记录中撤销（材料未被处理时）。`,
                    );
                    refresh();
                    onHandled?.();
                  }}
                />
              ) : (
                <div className="form">
                  {materialLoading ? (
                    <Loading label="加载材料…" />
                  ) : (
                    <>
                      <p className="muted">
                        本作用域共 {materialTotal} 条待处理材料，当前显示第 {materialPage * MATERIAL_PAGE_SIZE + 1}–
                        {materialPage * MATERIAL_PAGE_SIZE + materials.length} 条。默认全部不勾选；只有勾选的材料会被处理。
                        单次提交最多 100 条（C-05），更多请分批。
                      </p>
                      <ul>
                        {materials.map((item) => (
                          <li key={item.id}>
                            <label className="check">
                              <input
                                type="checkbox"
                                checked={selected.some((row) => row.id === item.id)}
                                onChange={() => toggleSelected(item)}
                              />
                              <span>
                                {item.source} · {item.title}
                                {item.redacted ? " · 已脱敏" : ""}
                                {item.sensitivity && item.sensitivity !== "public" ? ` · ${item.sensitivity}` : ""}
                                <span className="mono muted"> · {item.id} · {item.createdAt}</span>
                              </span>
                            </label>
                            <details>
                              <summary className="muted">预览</summary>
                              <pre className="notes">{item.body.length > 2000 ? `${item.body.slice(0, 2000)}…（已截断）` : item.body}</pre>
                            </details>
                          </li>
                        ))}
                      </ul>
                      {materialTotal > MATERIAL_PAGE_SIZE || materialPage > 0 ? (
                        <div className="row">
                          <button type="button" disabled={materialPage === 0 || materialLoading} onClick={() => void loadMaterials(task, materialPage - 1)}>
                            上一页
                          </button>
                          <span className="muted">第 {materialPage + 1} 页</span>
                          <button
                            type="button"
                            disabled={(materialPage + 1) * MATERIAL_PAGE_SIZE >= materialTotal || materialLoading}
                            onClick={() => void loadMaterials(task, materialPage + 1)}
                          >
                            下一页
                          </button>
                        </div>
                      ) : null}
                    </>
                  )}
                  {/* 筛选之外仍选中的条目必须可见（P1-02）：勾选清单跨页保留并完整呈现 */}
                  {editing === "" && selected.length ? (
                    <SelectionReview items={selected} onCancel={(id) => setSelected((items) => items.filter((row) => row.id !== id))} />
                  ) : null}
                  {draft?.status === "stale" ? <p className="error">草稿已过期：{draft.staleReason}。过期草稿禁止直接提交；请重新勾选并生成或手工整理。</p> : null}
                  {provider !== "none" && !editing ? (
                    <div className="row">
                      <button type="button" disabled={Boolean(busy) || !selected.length} onClick={() => void generateDraft(task)}>
                        {busy === `draft:${scopeKey(task)}` ? "生成中…" : `基于勾选 ${selected.length} 条生成草稿`}
                      </button>
                      <span className="muted">草稿仍需通过审核入口确认后才写入。</span>
                    </div>
                  ) : null}
                  {editing !== "" ? (
                    <>
                      <p className="muted">{editLoaded}</p>
                      {editing === "draft" ? (
                        <SelectionReview items={draftSources} fixed />
                      ) : (
                        <SelectionReview items={selected} onCancel={(id) => setSelected((items) => items.filter((row) => row.id !== id))} />
                      )}
                      {currentMemory ? (
                        <details>
                          <summary className="muted">与当前正式记忆（rev {currentMemory.rev}）对照（完整正文）</summary>
                          <p className="muted">标题：{currentMemory.title}</p>
                          {/* B-02：审核需要完整正文，不再截断 */}
                          <pre className="notes">{currentMemory.body}</pre>
                        </details>
                      ) : null}
                      {conflict ? (
                        <div className="banner error" role="alert">
                          <p>
                            版本冲突：服务器最新为 rev {conflict.serverRev}
                            {conflict.serverTitle ? `（${conflict.serverTitle}）` : ""}。你正在编辑的内容保留在下方编辑框；
                            在你核对并合并前提交按钮保持禁用，不会写入任何内容。
                          </p>
                          <details open>
                            <summary>服务器最新正文（rev {conflict.serverRev}，完整展示）</summary>
                            <pre className="notes">{conflict.serverBody}</pre>
                          </details>
                          {editing === "draft" ? (
                            <p>
                              草稿不能换新 rev 提交：请废弃该草稿后重新生成，或取消编辑改用「手工整理」从服务器最新正文出发。
                            </p>
                          ) : mergeConfirmed ? (
                            <div className="row">
                              <button type="button" className="primary" onClick={applyMergedRevision}>
                                二次确认：以服务器 rev {conflict.serverRev} 为准提交（{activeSources.length} 条来源）
                              </button>
                            </div>
                          ) : (
                            <div className="row">
                              <button type="button" onClick={() => setMergeConfirmed(true)}>
                                我已合并服务器最新内容（rev {conflict.serverRev}）
                              </button>
                              <button type="button" onClick={() => { setEditTitle(conflict.serverTitle); setEditBody(conflict.serverBody); setMergeConfirmed(true); }}>
                                以服务器版本为底稿重新编辑
                              </button>
                            </div>
                          )}
                        </div>
                      ) : null}
                      {memoryLoadError ? (
                        <div className="banner error" role="alert">
                          <p>B-12：读取当前正式记忆失败：{memoryLoadError}。未取得当前 rev 与正文前不能提交。</p>
                          <button type="button" onClick={() => void retryLoadMemory(task)}>重试读取</button>
                        </div>
                      ) : null}
                      <label>
                        标题
                        <input value={editTitle} onChange={(event) => setEditTitle(event.target.value)} />
                      </label>
                      <label>
                        {editing === "draft" ? "草稿正文（可修订）" : "蒸馏后的整篇正文"}
                        <textarea rows={12} value={editBody} onChange={(event) => setEditBody(event.target.value)} />
                      </label>
                      <p className="muted">
                        最终确认：将处理 <b>{activeSources.length}</b> 条来源；
                        写入是整篇覆盖，只移除这些来源，未选材料留在队列。
                      </p>
                      {currentMemory != null && editBody.trim() !== "" && editBody.trim() === currentMemory.body.trim() ? (
                        <label className="check">
                          <input
                            type="checkbox"
                            checked={confirmUnchanged}
                            onChange={(event) => setConfirmUnchanged(event.target.checked)}
                          />
                          <span>
                            正文与当前正式记忆（rev {currentMemory.rev}）相同：写入不会改变记忆内容，但所选来源仍会被消费。
                            确认仍要处理。
                          </span>
                        </label>
                      ) : null}
                      <div className="row">
                        <button
                          className="primary"
                          disabled={
                            saving ||
                            !editBody.trim() ||
                            !(activeSources.length > 0) ||
                            conflict != null || // B-02：冲突未走完显式合并步骤前禁止提交
                            memoryLoadError !== "" || // B-12：正式记忆读取失败时禁止提交
                            (currentMemory != null && editBody.trim() !== "" && editBody.trim() === currentMemory.body.trim() && !confirmUnchanged)
                          }
                          onClick={() => void submitEdit(task, editing === "draft" ? "draft" : "manual")}
                        >
                          {saving ? "写入中…" : editing === "draft" ? "确认草稿并写入所选来源" : "确认写入所选来源"}
                        </button>
                        <button
                          type="button"
                          disabled={saving}
                          onClick={() => {
                            resetEditor();
                            setNote(editing === "draft" ? "已退出草稿审核，未写入。" : "已取消编辑，未写入。");
                          }}
                        >
                          取消编辑
                        </button>
                      </div>
                    </>
                  ) : (
                    <div className="row">
                      <button type="button" onClick={() => void openManual(task)}>
                        手工整理（载入当前整篇记忆，只处理显式勾选）
                      </button>
                      {draft && draft.status === "pending" ? (
                        <button type="button" className="primary" onClick={() => void openDraftReview(task)}>
                          审核草稿（载入草稿正文与来源 {draft.sourceIds.length} 条）
                        </button>
                      ) : null}
                    </div>
                  )}
                </div>
              )
            ) : null}
          </article>
        );
      })}
      {(hasMore || page > 0) ? (
        <div className="row">
          <button type="button" disabled={page === 0 || Boolean(busy)} onClick={() => setPage((value) => Math.max(0, value - 1))}>
            上一页
          </button>
          <span className="muted">第 {page + 1} 页</span>
          <button type="button" disabled={!hasMore || Boolean(busy)} onClick={() => setPage((value) => value + 1)}>
            下一页
          </button>
        </div>
      ) : null}
      {total === 0 && (filter || abnormalOnly) ? <p className="muted">没有匹配的作用域。</p> : null}
    </div>
  );
}

function QueueView({ refreshKey = 0 }: { refreshKey?: number }) {
  const [view, setView] = useState<"tasks" | "materials">("tasks");
  const [epoch, setEpoch] = useState(0);
  return (
    <div className="list">
      <nav className="tabs subtabs" aria-label="蒸馏视图">
        <button type="button" className={view === "tasks" ? "active" : ""} onClick={() => setView("tasks")}>
          待蒸馏任务
        </button>
        <button type="button" className={view === "materials" ? "active" : ""} onClick={() => setView("materials")}>
          材料明细
        </button>
      </nav>
      {view === "tasks" ? (
        <DistillTasks refreshKey={refreshKey + epoch} onHandled={() => setEpoch((value) => value + 1)} />
      ) : (
        <QueuePanel refreshKey={refreshKey + epoch} />
      )}
    </div>
  );
}

/** 材料明细：只负责浏览、拒收与自定义入队；蒸馏写入统一在「待蒸馏任务」审核入口完成（M-05）。 */
function QueuePanel({ refreshKey = 0 }: { refreshKey?: number }) {
  const [inbox, setInbox] = useState<Inbox[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState(0);
  const [queueStatus, setQueueStatus] = useState<"proposed" | "rejected">("proposed");
  const [scopeFilter, setScopeFilter] = useState("");
  const [sourceFilter, setSourceFilter] = useState("");
  const [openId, setOpenId] = useState<string>("");
  const [adding, setAdding] = useState(false);
  const [customTitle, setCustomTitle] = useState("");
  const [customBody, setCustomBody] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const listGen = useRef(0);
  const refresh = (nextOffset = 0, append = false) => {
    const gen = ++listGen.current;
    api
      .inbox(queueStatus, { scopeId: scopeFilter.trim(), source: sourceFilter.trim(), limit: 50, offset: nextOffset })
      .then((data) => {
        if (gen !== listGen.current) return;
        setInbox((items) => (append ? [...items, ...data.inbox.filter((item) => !items.some((old) => old.id === item.id))] : data.inbox));
        setHasMore(data.hasMore);
        setTotal(data.total);
        setError("");
      })
      .catch((cause) => {
        if (gen !== listGen.current) return;
        setError(`读取队列失败：${cause instanceof Error ? cause.message : String(cause)}`);
      })
      .finally(() => {
        if (gen === listGen.current) {
          setLoaded(true);
          setLoadingMore(false);
        }
      });
  };
  useEffect(() => {
    refresh(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey, queueStatus, scopeFilter, sourceFilter]);
  const groups = groupInbox(inbox);
  return (
    <div className="list">
      <p className="muted">{queueStatus === "proposed"
        ? `按仓库名收拢显示，共 ${total} 条匹配的待蒸馏材料（每次最多取 50 条）。整篇蒸馏写入请在「待蒸馏任务」的审核入口完成；这里只浏览与拒收。`
        : `这里显示已拒收材料的来源与命中规则（共 ${total} 条）。正文不展示；可清理 90 天前的记录。`}</p>
      <div className="row">
        <button type="button" className={queueStatus === "proposed" ? "active" : ""} onClick={() => setQueueStatus("proposed")}>待蒸馏</button>
        <button type="button" className={queueStatus === "rejected" ? "active" : ""} onClick={() => setQueueStatus("rejected")}>已拒收</button>
        <label>
          仓库名
          <input value={scopeFilter} onChange={(event) => setScopeFilter(event.target.value)} placeholder="精确作用域名，如 OneLedger" />
        </label>
        <label>
          来源
          <input value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value)} placeholder="如 cursor / workbuddy" />
        </label>
      </div>
      {error ? <p className="error" role="alert">{error}</p> : null}
      {queueStatus === "rejected" ? <button type="button" disabled={busyId === "prune"} onClick={async () => {
        if (!window.confirm("清理 90 天前的拒收记录，并将过期脱敏事件汇总归档？")) return;
        setBusyId("prune");
        try {
          const result = await api.pruneHistory();
          setNote(`已清理 ${result.removedRejected} 条拒收记录，归档 ${result.archivedEvents} 条脱敏事件。`);
          refresh(0);
        } catch (cause) {
          setError(`清理失败：${cause instanceof Error ? cause.message : String(cause)}`);
        } finally {
          setBusyId("");
        }
      }}>{busyId === "prune" ? "清理中…" : "清理 90 天前记录"}</button> : null}
      {queueStatus === "proposed" ? <div className="row">
        <button type="button" onClick={() => setAdding((open) => !open)}>
          添加自定义
        </button>
      </div> : null}
      {adding ? (
        <form
          className="form"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!customBody.trim()) return;
            setBusyId("add");
            try {
              await api.queueCustom(customBody.trim(), customTitle.trim() || undefined);
              setCustomTitle("");
              setCustomBody("");
              setAdding(false);
              setNote("已加入队列。");
              refresh(0);
            } catch (cause) {
              setError(`加入失败：${cause instanceof Error ? cause.message : String(cause)}`);
            } finally {
              setBusyId("");
            }
          }}
        >
          <label>
            标题（可留空）
            <input value={customTitle} onChange={(event) => setCustomTitle(event.target.value)} />
          </label>
          <label>
            自定义原文
            <textarea rows={6} value={customBody} onChange={(event) => setCustomBody(event.target.value)} />
          </label>
          <button className="primary" type="submit" disabled={busyId === "add"}>
            {busyId === "add" ? "加入中…" : "加入队列"}
          </button>
        </form>
      ) : null}
      {note ? <p className="ok">{note}</p> : null}
      {!loaded ? <Loading /> : (<>
      {inbox.length === 0 && !adding && !error ? <p className="muted">{queueStatus === "rejected" ? "暂无拒收记录。" : "队列是空的。"}</p> : null}
      {groups.map((group) => (
        <details className="queue-group" key={group.key} open={groups.length <= 3}>
          <summary>
            {group.key}
            <span className="muted"> · {group.items.length} 条</span>
          </summary>
          {group.items.map((item) => {
            const open = openId === item.id;
            const preview = item.body.replace(/\s+/g, " ").trim();
            return (
              <article
                className={`item queue-item${open ? " is-open" : ""}`}
                key={item.id}
                onClick={() => setOpenId(open ? "" : item.id)}
              >
                <h3>{item.title}</h3>
                <p>
                  {item.source}
                  {item.scopeId ? ` · ${item.scopeId}` : ""}
                  {item.sensitivity && item.sensitivity !== "public" ? ` · ${item.sensitivity}` : ""}
                  {item.hits?.length ? ` · 命中 ${item.hits.join("、")}` : ""}
                </p>
                {open ? (
                  <>
                    <p>{item.body}</p>
                    <p className="mono muted">{item.id} · {item.createdAt}</p>
                    <div className="row" onClick={(event) => event.stopPropagation()}>
                      {queueStatus === "proposed" ? <button
                        disabled={Boolean(busyId)}
                        onClick={async () => {
                          setBusyId(`reject:${item.id}`);
                          try {
                            await api.reject(item.id);
                            setOpenId("");
                            refresh(0);
                          } catch (cause) {
                            setError(`丢弃失败：${cause instanceof Error ? cause.message : String(cause)}`);
                          } finally {
                            setBusyId("");
                          }
                        }}
                      >
                        {busyId === `reject:${item.id}` ? "丢弃中…" : "丢弃"}
                      </button> : null}
                    </div>
                  </>
                ) : (
                  <p className="preview">{preview.length > 72 ? `${preview.slice(0, 72)}…` : preview || "（无正文）"}</p>
                )}
              </article>
            );
          })}
        </details>
      ))}
      {hasMore ? <button type="button" disabled={loadingMore} onClick={() => {
        setLoadingMore(true);
        refresh(inbox.length, true);
      }}>{loadingMore ? "加载中…" : `加载更多材料（已显示 ${inbox.length}/${total}）`}</button> : null}
      </>)}
    </div>
  );
}
function AgentsPanel({ refreshKey = 0, collecting = false }: { refreshKey?: number; collecting?: boolean }) {
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [name, setName] = useState("");
  const [rootPath, setRootPath] = useState("");
  const [busy, setBusy] = useState<string>("");
  const [note, setNote] = useState("");
  const [loaded, setLoaded] = useState(false);
  const refresh = () =>
    void api
      .agents()
      .then((data) => setAgents(data.agents))
      .finally(() => setLoaded(true));
  useEffect(() => {
    void refresh();
  }, [refreshKey]);

  if (!loaded) {
    return (
      <div className="list">
        <Loading />
      </div>
    );
  }

  return (
    <div className="list">
      <p className="muted">内置 Agent 只能开关和改路径，不能删除。自定义目录可以增删。定时收集只跑已启用的。</p>
      <div className="row">
        <button
          className="primary"
          disabled={Boolean(busy) || collecting}
          onClick={async () => {
            setBusy("all");
            try {
              await api.collect();
              setNote("已收集全部已启用 Agent。");
              refresh();
            } finally {
              setBusy("");
            }
          }}
        >
          {busy === "all" ? "收集中…" : "收集全部已启用"}
        </button>
      </div>
      {note ? <p className="ok">{note}</p> : null}
      <div className="agent-grid">
      {agents.map((agent) => (
        <article className="item" key={agent.id}>
          <h3>
            {agent.name}{" "}
            <span className="muted">
              {agent.kind}
              {agent.builtin ? " · 内置" : " · 自定义"}
            </span>
          </h3>
          <p className={agent.pathExists ? "ok" : "error"}>
            {agent.pathExists ? "路径存在" : "路径不存在"} · {agent.rootPath || "（未设置）"}
          </p>
          <p>
            上次扫描 {agent.lastScannedAt ?? "尚未"} · 文件 {agent.lastScannedFiles} · 入库 {agent.lastIngested} · 排队{" "}
            {agent.lastQueued} · 脱敏 {agent.lastRedacted}
          </p>
          {agent.lastError ? <p className="error">{agent.lastError}</p> : null}
          <label>
            扫描路径
            <input
              value={agent.rootPath}
              onChange={(event) =>
                setAgents((current) =>
                  current.map((item) => (item.id === agent.id ? { ...item, rootPath: event.target.value } : item)),
                )
              }
              onBlur={() => void api.updateAgent(agent.id, { rootPath: agent.rootPath }).then(refresh)}
            />
          </label>
          <div className="row">
            <button
              onClick={async () => {
                await api.updateAgent(agent.id, { enabled: !agent.enabled });
                refresh();
              }}
            >
              {agent.enabled ? "已启用" : "已停用"}
            </button>
            <button
              className="primary"
              disabled={busy === agent.id || collecting}
              onClick={async () => {
                setBusy(agent.id);
                try {
                  await api.collectAgent(agent.id);
                  refresh();
                } finally {
                  setBusy("");
                }
              }}
            >
              {busy === agent.id ? "收集中…" : "只收这个"}
            </button>
            {agent.builtin ? null : (
              <button
                onClick={async () => {
                  await api.deleteAgent(agent.id);
                  refresh();
                }}
              >
                删除
              </button>
            )}
          </div>
        </article>
      ))}
      </div>
      <form
        className="form"
        onSubmit={async (event) => {
          event.preventDefault();
          if (!name.trim() || !rootPath.trim()) return;
          await api.createAgent(name.trim(), rootPath.trim());
          setName("");
          setRootPath("");
          refresh();
        }}
      >
        <h3>添加自定义 Agent 目录</h3>
        <label>
          名称
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如 Windsurf 规则" />
        </label>
        <label>
          路径
          <input value={rootPath} onChange={(event) => setRootPath(event.target.value)} placeholder="E:\Project" />
        </label>
        <button className="primary" type="submit">
          添加
        </button>
      </form>
    </div>
  );
}

function SyncPanel() {
  const [report, setReport] = useState<SyncReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <div className="panel">
      <p className="muted">叶子节点会把记忆推到远端中心，并拉回更新。secret 级条目不会上同步线。</p>
      <div className="row">
        <button
          className="primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError("");
            try {
              setReport(await api.sync());
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : String(cause));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "同步中…" : "立即同步"}
        </button>
      </div>
      {error ? <p className="error">{error}</p> : null}
      {report ? (
        <p className={report.error ? "error" : "ok"}>
          {report.skipped
            ? "当前是仅本地模式，未配置远端。"
            : `拉取 ${report.pulled}，推送 ${report.pushed}${report.error ? `，错误 ${report.error}` : ""}`}
        </p>
      ) : null}
    </div>
  );
}

function mcpEndpoint(bind: unknown, port: unknown) {
  const host = String(bind ?? "127.0.0.1") === "0.0.0.0" ? "127.0.0.1" : String(bind ?? "127.0.0.1");
  return `http://${host}:${Number(port ?? 7443)}/mcp`;
}

function mcpClientSnippet(url: string, token: string) {
  return `{
  "mcpServers": {
    "oneledger": {
      "url": "${url}",
      "headers": {
        "Authorization": "Bearer ${token}"
      }
    }
  }
}`;
}

function KeysPanel() {
  const [keys, setKeys] = useState<KeyRow[]>([]);
  const [trusted, setTrusted] = useState<TrustedMcpSourceRow[] | null>(null);
  const [revealed, setRevealed] = useState<{ id: string; token: string } | null>(null);
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");
  const [mcpUrl, setMcpUrl] = useState("http://127.0.0.1:7443/mcp");
  const [loaded, setLoaded] = useState(false);
  const refresh = () =>
    void api
      .keys()
      .then((data) => setKeys(data.keys))
      .finally(() => setLoaded(true));
  const refreshTrusted = () => {
    void keyApi
      .trustedSources()
      .then(setTrusted)
      .catch(() => setTrusted(null));
  };
  useEffect(() => void refresh(), []);
  useEffect(() => refreshTrusted(), []);
  useEffect(() => {
    if (!revealed) return;
    const timer = window.setTimeout(() => setRevealed(null), 15_000);
    return () => window.clearTimeout(timer);
  }, [revealed]);
  useEffect(() => {
    void api.config().then((config) => setMcpUrl(mcpEndpoint(config.bind, config.port)));
  }, []);
  if (!loaded) {
    return (
      <div className="list">
        <Loading />
      </div>
    );
  }
  return (
    <div className="list">
      <div className="panel list">
        <h3>MCP 使用说明</h3>
        <p className="muted">
          管理台登录用 adminToken，Agent 连账本用这里签发的密钥，两套不能混用。OneLedger 的 Tauri 桌面窗口需在本机运行，Agent 才能连上。
        </p>
        <p>
          1. 点下方「签发一把 Agent 密钥」。新密钥可在此 Tauri 窗口再次查看，每次查看都要原生确认。旧密钥若只存有哈希，会继续有效，但无法恢复原值。
        </p>
        <p>
          2. 把配置写进 Agent 的 MCP 设置。Cursor 用用户级 ~/.cursor/mcp.json 或项目 .cursor/mcp.json；Claude Code
          等同样认 mcpServers。改完后重启该 Agent。
        </p>
        <pre>{mcpClientSnippet(mcpUrl, "ol_你刚签发的密钥")}</pre>
        <p>
          3. 每把密钥在本次启动首次连接时会弹窗确认；同意时勾选「记住此设备」，以后这台电脑上该密钥从同一地址连接就不再询问（可在下方「记住的连接」撤销）。
          确认后可用这些工具：memory.search 按问题检索正文；memory.list 只列标题；memory.remember
          写入一整段蒸馏后的记忆（同一作用域覆盖，不要一条条堆）；memory.forget 按 id 删掉。secret
          级内容不会被检索，也不会同步到远端。
        </p>
        <p>凭据空间另有 vault.list、vault.put、vault.organize、vault.delete：Agent 可查看目录并提出整理操作；写入、移动或删除都须在桌面窗口逐次确认，MCP 不返回已保存的原值。</p>
        <p className="muted">
          地址来自当前监听配置。若改过端口，以「设置 → 服务器与存储」里保存的为准。本说明是 HTTP MCP；源码目录下也可用
          oneledger mcp 走 stdio，但桌面版日常用上面这段。
        </p>
      </div>
      <button
        className="primary"
        disabled={Boolean(busyId)}
        onClick={async () => {
          setError("");
          setBusyId("create");
          try {
            const created = await api.createKey(`agent-${keys.length + 1}`);
            setRevealed({ id: created.id, token: created.token });
            refresh();
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
          } finally {
            setBusyId("");
          }
        }}
      >
        签发一把 Agent 密钥
      </button>
      {error ? <div className="banner error">{error}</div> : null}
      {keys.map((key) => (
        <div className="item" key={key.id}>
          <h4>{key.name}</h4>
          <p>
            {key.tokenPrefix}… · {key.tools}
          </p>
          {key.recoverable ? (
            <button type="button" disabled={Boolean(busyId)} onClick={async () => {
              setError("");
              setRevealed(null);
              setBusyId(key.id);
              try {
                const token = await keyApi.reveal(key.id);
                setRevealed({ id: key.id, token });
              } catch (cause) {
                setError(cause instanceof Error ? cause.message : String(cause));
              } finally {
                setBusyId("");
              }
            }}>查看完整密钥</button>
          ) : <p className="muted">旧密钥仅存哈希，无法查看原值；当前连接仍有效。</p>}
          {revealed?.id === key.id ? (
            <div className="banner">
              完整密钥（15 秒后隐藏）：{revealed.token}
              <pre>{mcpClientSnippet(mcpUrl, revealed.token)}</pre>
            </div>
          ) : null}
        </div>
      ))}
      {trusted ? (
        <div className="panel list">
          <h3>记住的连接</h3>
          <p className="muted">
            确认连接时勾选过「记住此设备」的密钥与来源地址，存在本机，重启 OneLedger 也有效。撤销后，该密钥下次连接会重新弹窗确认。
          </p>
          {trusted.length === 0 ? <p className="muted">暂无记住的连接。</p> : null}
          {trusted.map((row) => (
            <div className="item" key={`${row.keyId}:${row.source}`}>
              <h4>{row.keyName || "已删除的密钥"}</h4>
              <p>{row.source}</p>
              <button
                type="button"
                disabled={Boolean(busyId)}
                onClick={async () => {
                  setError("");
                  setBusyId(`trust:${row.keyId}:${row.source}`);
                  try {
                    await keyApi.forgetSource(row.keyId, row.source);
                    refreshTrusted();
                  } catch (cause) {
                    setError(cause instanceof Error ? cause.message : String(cause));
                  } finally {
                    setBusyId("");
                  }
                }}
              >
                撤销记忆
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function VaultPanel() {
  const [items, setItems] = useState<VaultItem[]>([]);
  const [editing, setEditing] = useState<VaultItem | null>(null);
  const [label, setLabel] = useState("");
  const [scopeKind, setScopeKind] = useState<VaultItem["scopeKind"]>("personal");
  const [scopeId, setScopeId] = useState("");
  const [value, setValue] = useState("");
  const [showInput, setShowInput] = useState(false);
  const [revealed, setRevealed] = useState<{ id: string; value: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    vaultApi
      .list()
      .then(setItems)
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setLoaded(true));
  }, []);
  useEffect(() => {
    if (!revealed) return;
    const timer = window.setTimeout(() => setRevealed(null), 15_000);
    return () => window.clearTimeout(timer);
  }, [revealed]);

  const resetForm = () => {
    setEditing(null);
    setLabel("");
    setScopeKind("personal");
    setScopeId("");
    setValue("");
    setShowInput(false);
  };
  const report = (cause: unknown) => {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (message !== "操作已取消") setError(message);
  };
  const refresh = async () => setItems(await vaultApi.list());
  const save = async () => {
    setError("");
    setRevealed(null);
    setBusy(true);
    try {
      await vaultApi.put({
        id: editing?.id,
        label: label.trim(),
        scopeKind,
        scopeId: scopeKind === "project" ? scopeId.trim() : "",
        value,
        expectedUpdatedAt: editing?.updatedAt,
      });
      resetForm();
      await refresh();
    } catch (cause) {
      report(cause);
    } finally {
      setBusy(false);
    }
  };
  const organize = async () => {
    if (!editing) return;
    setError("");
    setRevealed(null);
    setBusy(true);
    try {
      await vaultApi.organize({
        id: editing.id,
        label: label.trim(),
        scopeKind,
        scopeId: scopeKind === "project" ? scopeId.trim() : "",
        expectedUpdatedAt: editing.updatedAt,
      });
      resetForm();
      await refresh();
    } catch (cause) {
      report(cause);
    } finally {
      setBusy(false);
    }
  };
  const reveal = async (id: string) => {
    setError("");
    setRevealed(null);
    setBusy(true);
    try {
      const secret = await vaultApi.reveal(id);
      setRevealed({ id, value: secret });
    } catch (cause) {
      report(cause);
    } finally {
      setBusy(false);
    }
  };
  const remove = async (id: string) => {
    setError("");
    setRevealed(null);
    setBusy(true);
    try {
      await vaultApi.delete(id);
      if (editing?.id === id) resetForm();
      await refresh();
    } catch (cause) {
      report(cause);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="list">
      <div className="panel list">
        <h2>本机凭据空间</h2>
        <p className="muted">
          原值由当前 Windows 用户的系统保护机制加密保存在本机。MCP 密钥只用于连接 Agent；
          Agent 可列出目录并请求写入、整理或删除，但不能通过 MCP 读取已保存的原值。每次修改都须在本机确认。
        </p>
        <p className="muted">凭据不会进入记忆检索、蒸馏、同步或普通导出。复制数据库到另一台机器后，这些原值无法直接解锁。</p>
      </div>

      <div className="panel list">
        <h3>{editing ? "编辑凭据" : "新增凭据"}</h3>
        <label>
          名称（不含原值）
          <input value={label} maxLength={80} autoComplete="off" onChange={(event) => setLabel(event.target.value)} placeholder="例如：生产 API" />
        </label>
        <label>
          作用域
          <select value={scopeKind} onChange={(event) => {
            const next = event.target.value as VaultItem["scopeKind"];
            setScopeKind(next);
            if (next !== "project") setScopeId("");
          }}>
            <option value="personal">个人</option>
            <option value="project">项目</option>
            <option value="global">全局</option>
          </select>
        </label>
        {scopeKind === "project" ? (
          <label>
            仓库名
            <input value={scopeId} maxLength={120} autoComplete="off" onChange={(event) => setScopeId(event.target.value)} placeholder="例如：CofoeAirLink_Web" />
          </label>
        ) : null}
        <label>
          原值
          <textarea
            className={showInput ? "vault-value" : "vault-value vault-value-hidden"}
            value={value}
            rows={3}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setValue(event.target.value)}
            placeholder={editing ? "输入替换后的原值" : "输入 API key、密码或其他敏感值"}
          />
        </label>
        <div className="row">
          <button type="button" onClick={() => setShowInput((visible) => !visible)}>{showInput ? "隐藏输入" : "显示输入"}</button>
          <button className="primary" type="button" disabled={busy || !label.trim() || !value} onClick={() => void save()}>
            {editing ? "确认替换" : "确认保存"}
          </button>
          {editing ? (
            <>
              <button type="button" disabled={busy || !label.trim() || (label.trim() === editing.label && scopeKind === editing.scopeKind && (scopeKind === "project" ? scopeId.trim() : "") === editing.scopeId)} onClick={() => void organize()}>只整理目录</button>
              <button type="button" onClick={resetForm}>取消编辑</button>
            </>
          ) : null}
        </div>
      </div>

      {error ? <p className="error" role="alert">{error}</p> : null}
      {!loaded ? (
        <Loading />
      ) : items.length === 0 ? (
        <p className="muted">还没有保存的凭据。</p>
      ) : null}
      {loaded ? items.map((item) => (
        <div className="item list" key={item.id}>
          <div>
            <h3>{item.label}</h3>
            <p className="muted">
              {item.scopeKind === "project" ? `项目 · ${item.scopeId}` : item.scopeKind === "global" ? "全局" : "个人"}
              {" · "}更新于 {item.updatedAt}
            </p>
          </div>
          <div className="row">
            <button type="button" disabled={busy} onClick={() => void reveal(item.id)}>查看原值 15 秒</button>
            <button type="button" disabled={busy} onClick={() => {
              setRevealed(null);
              setEditing(item);
              setLabel(item.label);
              setScopeKind(item.scopeKind);
              setScopeId(item.scopeId);
              setValue("");
              setShowInput(false);
            }}>编辑</button>
            <button type="button" disabled={busy} onClick={() => void remove(item.id)}>删除</button>
          </div>
          {revealed?.id === item.id ? (
            <pre className="vault-revealed" aria-label={`${item.label} 的原值`}>{revealed.value}</pre>
          ) : null}
        </div>
      )) : null}
    </div>
  );
}

type SettingsSection = "collect" | "mcp" | "sync" | "server" | "about";

const SETTINGS_SECTIONS: Array<[SettingsSection, string]> = [
  ["server", "服务器与存储"],
  ["collect", "采集与 Agent"],
  ["mcp", "MCP 密钥"],
  ["sync", "同步"],
  ["about", "关于与更新"],
];

function SettingsPanel({
  updateInfo,
  updateBusy,
  installBusy,
  aboutOpen,
  aboutRevealNonce,
  collectEpoch,
  collecting,
  onAboutOpenChange,
  onRefreshUpdates,
  onInstallUpdate,
}: {
  updateInfo: UpdateInfo | null;
  updateBusy: boolean;
  installBusy: boolean;
  aboutOpen: boolean;
  aboutRevealNonce: number;
  collectEpoch: number;
  collecting: boolean;
  onAboutOpenChange: (open: boolean) => void;
  onRefreshUpdates: () => Promise<void>;
  onInstallUpdate: () => Promise<void>;
}) {
  const [section, setSection] = useState<SettingsSection>("server");
  const [form, setForm] = useState({
    bind: "127.0.0.1",
    port: 7443,
    driver: "sqlite",
    sqlitePath: "",
    postgresUrl: "",
    role: "local",
    remoteUrl: "",
    nodeKey: "",
    cursor: true,
    claude: true,
    projects: true,
    extraRoots: "",
    codex: true,
    continue: true,
    zcode: true,
    workbuddy: true,
    qoder: true,
    updateUrl: "",
  });
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<{ section: SettingsSection; text: string; failed?: boolean } | null>(null);
  useEffect(() => {
    void api
      .config()
      .then((config) => {
        const storage = config.storage as { driver: string; sqlitePath: string; postgresUrl: string };
        const sync = config.sync as { role: string; remoteUrl: string; nodeKey: string };
        const collect = config.collect as {
          cursor: boolean;
          claude: boolean;
          projects: boolean;
          extraRoots: string[];
          codex: boolean;
          continue: boolean;
          zcode?: boolean;
          workbuddy?: boolean;
          qoder?: boolean;
        };
        setForm({
          bind: String(config.bind),
          port: Number(config.port),
          driver: storage.driver,
          sqlitePath: storage.sqlitePath,
          postgresUrl: storage.postgresUrl,
          role: sync.role,
          remoteUrl: sync.remoteUrl,
          nodeKey: sync.nodeKey,
          cursor: collect.cursor,
          claude: collect.claude,
          projects: collect.projects,
          extraRoots: (collect.extraRoots ?? []).join("\n"),
          codex: collect.codex,
          continue: collect.continue,
          zcode: collect.zcode ?? true,
          workbuddy: collect.workbuddy ?? true,
          qoder: collect.qoder ?? true,
          updateUrl: String(config.updateUrl ?? ""),
        });
      })
      .finally(() => setLoaded(true));
  }, []);
  useEffect(() => {
    if (aboutRevealNonce > 0) setSection("about");
  }, [aboutRevealNonce]);

  const save = async (from: SettingsSection) => {
    setSaving(true);
    try {
      await api.saveConfig({
        bind: form.bind,
        port: form.port,
        storage: {
          driver: form.driver,
          sqlitePath: form.sqlitePath,
          postgresUrl: form.postgresUrl,
        },
        sync: {
          role: form.role,
          remoteUrl: form.remoteUrl,
          nodeKey: form.nodeKey,
        },
        collect: {
          cursor: form.cursor,
          claude: form.claude,
          projects: form.projects,
          extraRoots: form.extraRoots
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean),
          codex: form.codex,
          continue: form.continue,
          zcode: form.zcode,
          workbuddy: form.workbuddy,
          qoder: form.qoder,
        },
        updateUrl: form.updateUrl,
      });
      setSaved({ section: from, text: "已写入本机配置。改了监听地址或存储驱动时，请重启 oneledger serve。" });
    } catch (cause) {
      setSaved({ section: from, failed: true, text: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setSaving(false);
    }
  };

  const savedNote = (from: SettingsSection) =>
    saved && saved.section === from ? (
      <p className={saved.failed ? "error" : "ok"}>{saved.text}</p>
    ) : null;

  return (
    <div className="list">
      <nav className="tabs subtabs" aria-label="设置分区">
        {SETTINGS_SECTIONS.map(([id, label]) => (
          <button key={id} type="button" className={section === id ? "active" : ""} onClick={() => setSection(id)}>
            {label}
          </button>
        ))}
      </nav>
      {section === "server" ? (
        loaded ? (
          <form
            className="form"
            onSubmit={(event) => {
              event.preventDefault();
              void save("server");
            }}
          >
            <label>
              监听地址
              <input value={form.bind} onChange={(event) => setForm({ ...form, bind: event.target.value })} />
            </label>
            <label>
              端口
              <input
                type="number"
                value={form.port}
                onChange={(event) => setForm({ ...form, port: Number(event.target.value) })}
              />
            </label>
            <label>
              存储
              <select value={form.driver} onChange={(event) => setForm({ ...form, driver: event.target.value })}>
                <option value="sqlite">本机 SQLite</option>
                {/* B-09：本期只支持 SQLite。PG 在启动前即明确拒绝（避免撞 SQLite 方言报错），
                    这里保留禁用项向用户说明边界，而不是让用户切过去之后随机失败。 */}
                <option value="postgres" disabled>
                  Postgres（本期未支持）
                </option>
              </select>
            </label>
            {form.driver === "postgres" ? (
              <p className="error">当前产品边界：仅支持本机 SQLite。PostgreSQL 支持尚未交付，请改回「本机 SQLite」。</p>
            ) : null}
            <label>
              SQLite 路径
              <input value={form.sqlitePath} onChange={(event) => setForm({ ...form, sqlitePath: event.target.value })} />
            </label>
            <label>
              Postgres URL
              <input
                value={form.postgresUrl}
                onChange={(event) => setForm({ ...form, postgresUrl: event.target.value })}
                placeholder="postgres://user:pass@host:5432/oneledger"
              />
            </label>
            <button className="primary" type="submit" disabled={saving}>
              {saving ? "保存中…" : "保存"}
            </button>
            {savedNote("server")}
          </form>
        ) : (
          <Loading />
        )
      ) : null}
      {section === "collect" ? (
        <>
          <AgentsPanel refreshKey={collectEpoch} collecting={collecting} />
          {loaded ? (
            <form
              className="form"
              onSubmit={(event) => {
                event.preventDefault();
                void save("collect");
              }}
            >
              <h3>采集来源</h3>
              <div className="check-grid">
                <label className="check">
                  <input
                    type="checkbox"
                    checked={form.cursor}
                    onChange={(event) => setForm({ ...form, cursor: event.target.checked })}
                  />
                  收集 Cursor Agent Store
                </label>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={form.claude}
                    onChange={(event) => setForm({ ...form, claude: event.target.checked })}
                  />
                  收集 Claude Code memory
                </label>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={form.codex}
                    onChange={(event) => setForm({ ...form, codex: event.target.checked })}
                  />
                  收集 Codex ~/.codex
                </label>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={form.continue}
                    onChange={(event) => setForm({ ...form, continue: event.target.checked })}
                  />
                  收集 Continue ~/.continue
                </label>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={form.zcode}
                    onChange={(event) => setForm({ ...form, zcode: event.target.checked })}
                  />
                  收集 ZCode ~/.zcode
                </label>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={form.workbuddy}
                    onChange={(event) => setForm({ ...form, workbuddy: event.target.checked })}
                  />
                  收集 WorkBuddy ~/.workbuddy
                </label>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={form.qoder}
                    onChange={(event) => setForm({ ...form, qoder: event.target.checked })}
                  />
                  收集 Qoder ~/.qoder
                </label>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={form.projects}
                    onChange={(event) => setForm({ ...form, projects: event.target.checked })}
                  />
                  收集项目约定（AGENTS.md / CLAUDE.md / .cursor/rules）
                </label>
              </div>
              <label>
                扫描根目录（每行一个；留空则扫当前工作目录）
                <textarea
                  rows={3}
                  value={form.extraRoots}
                  onChange={(event) => setForm({ ...form, extraRoots: event.target.value })}
                  placeholder="E:\Project"
                />
              </label>
              <button className="primary" type="submit" disabled={saving}>
                {saving ? "保存中…" : "保存"}
              </button>
              {savedNote("collect")}
            </form>
          ) : (
            <Loading />
          )}
        </>
      ) : null}
      {section === "mcp" ? <KeysPanel /> : null}
      {section === "sync" ? (
        <>
          <SyncPanel />
          {loaded ? (
            <form
              className="form"
              onSubmit={(event) => {
                event.preventDefault();
                void save("sync");
              }}
            >
              <h3>同步配置</h3>
              <label>
                同步角色
                <select value={form.role} onChange={(event) => setForm({ ...form, role: event.target.value })}>
                  <option value="local">仅本地</option>
                  <option value="leaf">叶子（连远端）</option>
                  <option value="hub">中心</option>
                </select>
              </label>
              <label>
                远端中心 URL
                <input value={form.remoteUrl} onChange={(event) => setForm({ ...form, remoteUrl: event.target.value })} />
              </label>
              <label>
                节点密钥
                <input value={form.nodeKey} onChange={(event) => setForm({ ...form, nodeKey: event.target.value })} />
              </label>
              <button className="primary" type="submit" disabled={saving}>
                {saving ? "保存中…" : "保存"}
              </button>
              {savedNote("sync")}
            </form>
          ) : (
            <Loading />
          )}
        </>
      ) : null}
      {section === "about" ? (
        <div className="list">
          <UpdateBox
            info={updateInfo}
            checking={updateBusy}
            installing={installBusy}
            open={aboutOpen}
            onOpenChange={onAboutOpenChange}
            onRefresh={onRefreshUpdates}
            onInstall={onInstallUpdate}
          />
          {loaded ? (
            <form
              className="form"
              onSubmit={(event) => {
                event.preventDefault();
                void save("about");
              }}
            >
              <label>
                版本检查 URL（latest.json，可留空）
                <input value={form.updateUrl} onChange={(event) => setForm({ ...form, updateUrl: event.target.value })} />
              </label>
              <button className="primary" type="submit" disabled={saving}>
                {saving ? "保存中…" : "保存"}
              </button>
              {savedNote("about")}
            </form>
          ) : (
            <Loading />
          )}
        </div>
      ) : null}
    </div>
  );
}
