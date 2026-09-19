import { app, BrowserWindow } from "electron";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const childProcesses = [];

function oneledgerHome() {
  return process.env.ONELEDGER_HOME?.trim() || join(homedir(), ".oneledger");
}

function serverRoot() {
  if (app.isPackaged) return join(process.resourcesPath, "app-server");
  return join(here, "..");
}

function nodeBinary() {
  if (app.isPackaged) return join(process.resourcesPath, "runtime", "node.exe");
  return process.env.npm_node_execpath || "node";
}

async function health(port) {
  const response = await fetch(`http://127.0.0.1:${port}/api/health`);
  if (!response.ok) throw new Error(String(response.status));
}

async function ensureServer(port) {
  try {
    await health(port);
    return;
  } catch {
    /* start our own */
  }
  const root = serverRoot();
  const entry = join(root, "dist", "index.js");
  const child = spawn(nodeBinary(), [entry, "serve"], {
    cwd: root,
    env: { ...process.env, ONELEDGER_HOME: oneledgerHome() },
    stdio: "ignore",
    windowsHide: true,
  });
  childProcesses.push(child);
  for (let i = 0; i < 40; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    try {
      await health(port);
      return;
    } catch {
      /* retry */
    }
  }
  throw new Error("OneLedger 服务没有在 10 秒内起来。");
}

function readConfig() {
  const path = join(oneledgerHome(), "config.json");
  if (!existsSync(path)) return { adminToken: "", port: 7443 };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return { adminToken: parsed.adminToken ?? "", port: Number(parsed.port) || 7443 };
  } catch {
    return { adminToken: "", port: 7443 };
  }
}

async function createWindow() {
  const { adminToken, port } = readConfig();
  await ensureServer(port);
  const latest = readConfig();
  const win = new BrowserWindow({
    width: 1180,
    height: 820,
    title: "OneLedger",
    backgroundColor: "#14110d",
    autoHideMenuBar: true,
    webPreferences: { sandbox: true },
  });
  await win.loadURL(`http://127.0.0.1:${latest.port || port}/`);
  const token = latest.adminToken || adminToken;
  if (token) {
    await win.webContents.executeJavaScript(
      `localStorage.setItem("oneledger.adminToken", ${JSON.stringify(token)}); location.reload();`,
    );
  }
}

app.whenReady().then(() => createWindow());
app.on("window-all-closed", () => {
  for (const child of childProcesses) child.kill();
  app.quit();
});
