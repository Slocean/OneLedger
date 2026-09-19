import { useEffect, useState } from "react";
import {
  api,
  getToken,
  setToken,
  type AgentRow,
  type Inbox,
  type KeyRow,
  type Memory,
  type SyncReport,
} from "./api";

type Tab = "overview" | "memories" | "queue" | "agents" | "sync" | "keys" | "settings";

export function App() {
  const [token, setTokenState] = useState(getToken());
  const [ready, setReady] = useState(false);
  const [tab, setTab] = useState<Tab>("overview");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!token) return;
    api
      .status()
      .then(() => setReady(true))
      .catch(() => setReady(false));
  }, [token]);

  if (!ready) {
    return (
      <div className="gate">
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
              .then(() => setReady(true))
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
      <header className="masthead">
        <h1>ONELEDGER</h1>
        <p>共享记忆总账 · MCP · 本地与远端</p>
      </header>
      <nav className="tabs">
        {(
          [
            ["overview", "总览"],
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
      {tab === "overview" ? <Overview /> : null}
      {tab === "memories" ? <Memories /> : null}
      {tab === "queue" ? <QueuePanel /> : null}
      {tab === "agents" ? <AgentsPanel /> : null}
      {tab === "sync" ? <SyncPanel /> : null}
      {tab === "keys" ? <KeysPanel /> : null}
      {tab === "settings" ? <SettingsPanel /> : null}
    </div>
  );
}

function Overview() {
  const [status, setStatus] = useState<Awaited<ReturnType<typeof api.status>> | null>(null);
  const [update, setUpdate] = useState("");
  useEffect(() => {
    void api.status().then(setStatus);
    void api.updates().then((data) => {
      setUpdate(data.update ? `有新版本 ${data.latest}` : `当前 ${data.current}`);
    });
  }, []);
  if (!status) return <p className="muted">读取中…</p>;
  return (
    <div className="grid">
      <div className="card">
        <span>正式记忆</span>
        <strong>{status.counts.active}</strong>
      </div>
      <div className="card">
        <span>收件箱</span>
        <strong>{status.counts.inbox}</strong>
      </div>
      <div className="card">
        <span>已作废</span>
        <strong>{status.counts.forgotten}</strong>
      </div>
      <div className="panel">
        <p>版本 {status.version}</p>
        <p>角色 {status.role}</p>
        <p>存储 {status.storage}</p>
        <p>监听 {status.bind}</p>
        <p>{update}</p>
      </div>
    </div>
  );
}

function Memories() {
  const [items, setItems] = useState<Memory[]>([]);
  const [draft, setDraft] = useState("");
  const [promote, setPromote] = useState(false);
  const [note, setNote] = useState("");
  const refresh = () => void api.memories().then((data) => setItems(data.memories));
  useEffect(() => {
    void refresh();
  }, []);
  return (
    <div className="list">
      <form
        className="form"
        onSubmit={async (event) => {
          event.preventDefault();
          if (!draft.trim()) return;
          const result = await api.remember(draft.trim(), undefined, promote);
          setDraft("");
          setNote(
            result.redacted
              ? "已拦截敏感内容，原文没有进检索库。"
              : result.queued
                ? "已进蒸馏队列，等待复核。"
                : "已写入总账。",
          );
          refresh();
        }}
      >
        <label>
          手写一条记忆
          <textarea rows={4} value={draft} onChange={(event) => setDraft(event.target.value)} />
        </label>
        <label className="check">
          <input type="checkbox" checked={promote} onChange={(event) => setPromote(event.target.checked)} />
          管理员直接晋升（跳过队列）
        </label>
        <button className="primary" type="submit">
          入账
        </button>
        {note ? <p className="ok">{note}</p> : null}
      </form>
      {items.length === 0 ? <p className="muted">还没有正式记忆。</p> : null}
      {items.map((item) => (
        <article className="item" key={item.id}>
          <h3>{item.title}</h3>
          <p>
            {item.scopeKind} · {item.source} · {item.sensitivity}
          </p>
          <p>{item.body}</p>
        </article>
      ))}
    </div>
  );
}

function QueuePanel() {
  const [inbox, setInbox] = useState<Inbox[]>([]);
  const refresh = () => void api.inbox().then((data) => setInbox(data.inbox));
  useEffect(() => {
    void refresh();
  }, []);
  return (
    <div className="list">
      <p className="muted">项目约定可自动晋升。MCP / 全局笔记默认进队列。有冲突时晋升会作废旧条。</p>
      {inbox.length === 0 ? <p className="muted">队列是空的。</p> : null}
      {inbox.map((item) => (
        <article className="item" key={item.id}>
          <h3>{item.title}</h3>
          <p>
            {item.source} · 冲突 {item.conflictIds.length}
          </p>
          <p>{item.body}</p>
          <div className="row">
            <button
              className="primary"
              onClick={async () => {
                await api.promote(item.id, item.conflictIds);
                refresh();
              }}
            >
              晋升{item.conflictIds.length ? "并取代冲突" : ""}
            </button>
            <button
              onClick={async () => {
                await api.reject(item.id);
                refresh();
              }}
            >
              驳回
            </button>
          </div>
        </article>
      ))}
    </div>
  );
}

function AgentsPanel() {
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [name, setName] = useState("");
  const [rootPath, setRootPath] = useState("");
  const [busy, setBusy] = useState<string>("");
  const [note, setNote] = useState("");
  const refresh = () => void api.agents().then((data) => setAgents(data.agents));
  useEffect(() => {
    void refresh();
  }, []);

  return (
    <div className="list">
      <p className="muted">内置 Agent 只能开关和改路径，不能删除。自定义目录可以增删。定时收集只跑已启用的。</p>
      <div className="row">
        <button
          className="primary"
          disabled={Boolean(busy)}
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
              disabled={busy === agent.id}
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
      <p className="muted">叶子节点会把正式记忆推到远端中心，并拉回更新。secret 级条目不会上同步线。</p>
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

function KeysPanel() {
  const [keys, setKeys] = useState<KeyRow[]>([]);
  const [issued, setIssued] = useState("");
  const refresh = () => void api.keys().then((data) => setKeys(data.keys));
  useEffect(() => void refresh(), []);
  return (
    <div className="list">
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
          <pre>{`{
  "mcpServers": {
    "oneledger": {
      "url": "http://127.0.0.1:7443/mcp",
      "headers": { "Authorization": "Bearer ${issued}" }
    }
  }
}`}</pre>
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

function SettingsPanel() {
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
          checked={form.projects}
          onChange={(event) => setForm({ ...form, projects: event.target.checked })}
        />
        收集项目约定（AGENTS.md / CLAUDE.md / .cursor/rules）
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
      <button className="primary" type="submit">
        保存
      </button>
      {saved ? <p className="ok">{saved}</p> : null}
    </form>
  );
}
