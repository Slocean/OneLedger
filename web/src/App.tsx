import { useEffect, useState } from "react";
import {
  api,
  getToken,
  setToken,
  type Collect,
  type Inbox,
  type KeyRow,
  type Memory,
  type Redaction,
  type SyncReport,
} from "./api";

type Tab = "overview" | "memories" | "collect" | "sync" | "keys" | "settings";

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
            ["collect", "收集"],
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
      {tab === "collect" ? <CollectPanel /> : null}
      {tab === "sync" ? <SyncPanel /> : null}
      {tab === "keys" ? <KeysPanel /> : null}
      {tab === "settings" ? <SettingsPanel /> : null}
    </div>
  );
}

function Overview() {
  const [status, setStatus] = useState<Awaited<ReturnType<typeof api.status>> | null>(null);
  useEffect(() => {
    void api.status().then(setStatus);
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
      </div>
    </div>
  );
}

function Memories() {
  const [items, setItems] = useState<Memory[]>([]);
  useEffect(() => {
    void api.memories().then((data) => setItems(data.memories));
  }, []);
  return (
    <div className="list">
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

function CollectPanel() {
  const [inbox, setInbox] = useState<Inbox[]>([]);
  const [redactions, setRedactions] = useState<Redaction[]>([]);
  const [results, setResults] = useState<Collect[]>([]);
  const [busy, setBusy] = useState(false);
  const refresh = () => {
    void api.inbox().then((data) => setInbox(data.inbox));
    void api.audit().then((data) => setRedactions(data.redactions));
  };
  useEffect(refresh, []);
  return (
    <div className="list">
      <div className="row">
        <button
          className="primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const data = await api.collect();
              setResults(data.results);
              refresh();
            } finally {
              setBusy(false);
            }
          }}
        >
          立即收集本机 Agent 记忆
        </button>
      </div>
      {results.map((item) => (
        <p key={item.source}>
          {item.source}：扫描 {item.scannedFiles}，入库 {item.ingested}，跳过 {item.skipped}，脱敏{" "}
          {item.redacted}
        </p>
      ))}
      <h3>隔离区（只记类型，不记原文）</h3>
      {redactions.map((item) => (
        <p key={`${item.at}-${item.hit_type}`}>
          {item.at} · {item.source} · {item.hit_type}
        </p>
      ))}
      <h3>收件箱</h3>
      {inbox.map((item) => (
        <div className="item" key={item.id}>
          <h4>{item.title}</h4>
          <p>
            {item.sensitivity} · {item.source}
          </p>
        </div>
      ))}
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
      {issued ? <div className="banner">只显示一次：{issued}</div> : null}
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
  });
  const [saved, setSaved] = useState("");
  useEffect(() => {
    void api.config().then((config) => {
      const storage = config.storage as { driver: string; sqlitePath: string; postgresUrl: string };
      const sync = config.sync as { role: string; remoteUrl: string; nodeKey: string };
      const collect = config.collect as { cursor: boolean; claude: boolean };
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
          collect: { cursor: form.cursor, claude: form.claude },
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
      <label>
        <input
          type="checkbox"
          checked={form.cursor}
          onChange={(event) => setForm({ ...form, cursor: event.target.checked })}
        />
        收集 Cursor Agent Store
      </label>
      <label>
        <input
          type="checkbox"
          checked={form.claude}
          onChange={(event) => setForm({ ...form, claude: event.target.checked })}
        />
        收集 Claude Code memory
      </label>
      <button className="primary" type="submit">
        保存
      </button>
      {saved ? <p className="ok">{saved}</p> : null}
    </form>
  );
}
