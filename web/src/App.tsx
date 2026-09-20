import { useEffect, useMemo, useState } from "react";
import {
  api,
  getToken,
  setToken,
  type AgentRow,
  type CollectStatus,
  type Inbox,
  type KeyRow,
  type Memory,
  type SyncReport,
  type UpdateInfo,
} from "./api";

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
    .sort((a, b) => Number(tail.has(a[0])) - Number(tail.has(b[0])) || a[0].localeCompare(b[0], "zh"))
    .map(([key, grouped]) => ({ key, items: grouped }));
}

const NOTICE_KEY = "oneledger.noticeAck";

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
              ["agents", "Agent"],
              ["sync", "同步"],
              ["keys", "MCP 密钥"],
              ["settings", "服务器与存储"],
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
            {updateInfo.can_hot_update ? "点顶栏「一键更新」即可。" : "打开「服务器与存储 → 关于与更新」查看。"}
          </p>
        ) : null}
        {collect?.running ? <CollectBanner collect={collect} /> : null}
      </div>
      <main className="stage">
        {tab === "memories" ? <Memories refreshKey={collectEpoch} /> : null}
        {tab === "queue" ? <QueuePanel refreshKey={collectEpoch} /> : null}
        {tab === "agents" ? <AgentsPanel refreshKey={collectEpoch} collecting={Boolean(collect?.running)} /> : null}
        {tab === "sync" ? <SyncPanel /> : null}
        {tab === "keys" ? <KeysPanel /> : null}
        {tab === "settings" ? (
          <SettingsPanel
            updateInfo={updateInfo}
            updateBusy={updateBusy}
            installBusy={installBusy}
            aboutOpen={aboutOpen}
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
  const [busy, setBusy] = useState(false);
  const grouped = useMemo(() => kindItems(items, kind), [items, kind]);
  const selected = grouped.find((item) => (item.scopeId ?? "") === scopeId) ?? grouped[0];
  const refresh = () =>
    void api.memories().then((data) => {
      setItems(data.memories);
    });
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
    setBusy(true);
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
      setBusy(false);
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
          <button disabled={busy} onClick={() => void exportFile("json")}>
            导出 JSON
          </button>
          <button disabled={busy} onClick={() => void exportFile("md")}>
            导出 Markdown
          </button>
        </div>
      </div>
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
          if (!draft.trim()) return;
          const result = await api.remember(draft.trim(), {
            title: selected?.title,
            scopeKind: kind,
            scopeId: selected?.scopeId ?? scopeId,
          });
          setNote(
            result.redacted
              ? "已拦截敏感内容，原文没有进检索库。"
              : result.queued
                ? "未写入正式记忆。"
                : "已保存。",
          );
          refresh();
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
        <button className="primary" type="submit">
          保存
        </button>
        {note ? <p className="ok">{note}</p> : null}
      </form>
      {!selected ? <p className="muted">{emptyHint}</p> : null}
    </div>
  );
}

function QueuePanel({ refreshKey = 0 }: { refreshKey?: number }) {
  const [inbox, setInbox] = useState<Inbox[]>([]);
  const [openId, setOpenId] = useState<string>("");
  const [adding, setAdding] = useState(false);
  const [customTitle, setCustomTitle] = useState("");
  const [customBody, setCustomBody] = useState("");
  const [note, setNote] = useState("");
  const refresh = () => void api.inbox().then((data) => setInbox(data.inbox));
  useEffect(() => {
    void refresh();
  }, [refreshKey]);
  const groups = groupInbox(inbox);
  return (
    <div className="list">
      <p className="muted">
        这里只放待蒸馏的原文，按仓库名收拢。Agent 读完后用 memory.remember 写入「记忆」。本程序不摘要。
      </p>
      <div className="row">
        <button type="button" onClick={() => setAdding((open) => !open)}>
          添加自定义
        </button>
      </div>
      {adding ? (
        <form
          className="form"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!customBody.trim()) return;
            await api.queueCustom(customBody.trim(), customTitle.trim() || undefined);
            setCustomTitle("");
            setCustomBody("");
            setAdding(false);
            setNote("已加入队列。");
            refresh();
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
          <button className="primary" type="submit">
            加入队列
          </button>
        </form>
      ) : null}
      {note ? <p className="ok">{note}</p> : null}
      {inbox.length === 0 && !adding ? <p className="muted">队列是空的。</p> : null}
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
                </p>
                {open ? (
                  <>
                    <p>{item.body}</p>
                    <p className="muted">{item.createdAt}</p>
                    <div className="row" onClick={(event) => event.stopPropagation()}>
                      <button
                        onClick={async () => {
                          await api.reject(item.id);
                          setOpenId("");
                          refresh();
                        }}
                      >
                        丢弃
                      </button>
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
    </div>
  );
}

function AgentsPanel({ refreshKey = 0, collecting = false }: { refreshKey?: number; collecting?: boolean }) {
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [name, setName] = useState("");
  const [rootPath, setRootPath] = useState("");
  const [busy, setBusy] = useState<string>("");
  const [note, setNote] = useState("");
  const refresh = () => void api.agents().then((data) => setAgents(data.agents));
  useEffect(() => {
    void refresh();
  }, [refreshKey]);

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
          收集全部已启用
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
              只收这个
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
  return (
    <div className="panel">
      <p className="muted">叶子节点会把记忆推到远端中心，并拉回更新。secret 级条目不会上同步线。</p>
      <button
        className="primary"
        onClick={async () => setReport(await api.sync())}
      >
        立即同步
      </button>
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
  const [issued, setIssued] = useState("");
  const [mcpUrl, setMcpUrl] = useState("http://127.0.0.1:7443/mcp");
  const refresh = () => void api.keys().then((data) => setKeys(data.keys));
  useEffect(() => void refresh(), []);
  useEffect(() => {
    void api.config().then((config) => setMcpUrl(mcpEndpoint(config.bind, config.port)));
  }, []);
  return (
    <div className="list">
      <div className="panel list">
        <h3>MCP 使用说明</h3>
        <p className="muted">
          管理台登录用 adminToken，Agent 连账本用这里签发的密钥，两套不能混用。OneLedger 需要先在本机跑着（桌面版或
          oneledger serve），Agent 才能连上。
        </p>
        <p>
          1. 点下方「签发一把 Agent 密钥」，完整 token 只出现一次，请立刻复制。之后列表里只剩前缀。
        </p>
        <p>
          2. 把配置写进 Agent 的 MCP 设置。Cursor 用用户级 ~/.cursor/mcp.json 或项目 .cursor/mcp.json；Claude Code
          等同样认 mcpServers。改完后重启该 Agent。
        </p>
        <pre>{mcpClientSnippet(mcpUrl, "ol_你刚签发的密钥")}</pre>
        <p>
          3. 连上后可用这些工具：memory.search 按问题检索正文；memory.list 只列标题；memory.remember
          写入一整段蒸馏后的记忆（同一作用域覆盖，不要一条条堆）；memory.forget 按 id 删掉。secret
          级内容不会被检索，也不会同步到远端。
        </p>
        <p className="muted">
          地址来自当前监听配置。若改过端口，以「服务器与存储」里保存的为准。本说明是 HTTP MCP；源码目录下也可用
          oneledger mcp 走 stdio，但桌面版日常用上面这段。
        </p>
      </div>
      <button
        className="primary"
        onClick={async () => {
          const created = await api.createKey(`agent-${keys.length + 1}`);
          setIssued(created.token);
          refresh();
        }}
      >
        签发一把 Agent 密钥
      </button>
      {issued ? (
        <div className="banner">
          只显示一次：{issued}
          <pre>{mcpClientSnippet(mcpUrl, issued)}</pre>
        </div>
      ) : null}
      {keys.map((key) => (
        <div className="item" key={key.id}>
          <h4>{key.name}</h4>
          <p>
            {key.tokenPrefix}… · {key.tools}
          </p>
        </div>
      ))}
    </div>
  );
}

function SettingsPanel({
  updateInfo,
  updateBusy,
  installBusy,
  aboutOpen,
  onAboutOpenChange,
  onRefreshUpdates,
  onInstallUpdate,
}: {
  updateInfo: UpdateInfo | null;
  updateBusy: boolean;
  installBusy: boolean;
  aboutOpen: boolean;
  onAboutOpenChange: (open: boolean) => void;
  onRefreshUpdates: () => Promise<void>;
  onInstallUpdate: () => Promise<void>;
}) {
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
  const [saved, setSaved] = useState("");
  useEffect(() => {
    void api.config().then((config) => {
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
    });
  }, []);

  return (
    <form
      className="form"
      onSubmit={async (event) => {
        event.preventDefault();
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
        setSaved("已写入本机配置。改了监听地址或存储驱动时，请重启 oneledger serve。");
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
          <option value="postgres">Postgres</option>
        </select>
      </label>
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
      <details className="advanced">
        <summary>高级：同步、扫描根目录、版本检查</summary>
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
        <label>
          扫描根目录（每行一个；留空则扫当前工作目录）
          <textarea
            rows={3}
            value={form.extraRoots}
            onChange={(event) => setForm({ ...form, extraRoots: event.target.value })}
            placeholder="E:\Project"
          />
        </label>
        <label>
          版本检查 URL（latest.json，可留空）
          <input value={form.updateUrl} onChange={(event) => setForm({ ...form, updateUrl: event.target.value })} />
        </label>
      </details>
      <UpdateBox
        info={updateInfo}
        checking={updateBusy}
        installing={installBusy}
        open={aboutOpen}
        onOpenChange={onAboutOpenChange}
        onRefresh={onRefreshUpdates}
        onInstall={onInstallUpdate}
      />
      <button className="primary" type="submit">
        保存
      </button>
      {saved ? <p className="ok">{saved}</p> : null}
    </form>
  );
}
