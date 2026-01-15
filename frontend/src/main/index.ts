import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import { dirname, join } from "path";

const rawDevServerUrl = String(
  process.env.VITE_DEV_SERVER_URL || process.env.ELECTRON_RENDERER_URL || ""
).trim();

let mainWindow: BrowserWindow | null = null;

let _backendProc: ChildProcessWithoutNullStreams | null = null;

let _runtimeBackendBaseUrl: string | null = null;

function findFreePort(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    try {
      const srv = net.createServer();
      srv.unref();
      srv.on("error", reject);
      srv.listen(0, host, () => {
        const addr = srv.address();
        srv.close(() => {
          if (
            addr &&
            typeof addr === "object" &&
            typeof addr.port === "number"
          ) {
            resolve(addr.port);
          } else {
            reject(new Error("failed to resolve free port"));
          }
        });
      });
    } catch (e) {
      reject(e);
    }
  });
}

async function ensureBackendEnv(): Promise<void> {
  process.env.EDGE_VIDEO_AGENT_IS_PACKAGED = app.isPackaged ? "1" : "0";

  if (_runtimeBackendBaseUrl) {
    process.env.EDGE_VIDEO_AGENT_BACKEND_BASE_URL = _runtimeBackendBaseUrl;
    return;
  }

  const env = String(
    process.env.EDGE_VIDEO_AGENT_BACKEND_BASE_URL || ""
  ).trim();
  if (env) {
    _runtimeBackendBaseUrl = env.replace(/\/$/, "");
    process.env.EDGE_VIDEO_AGENT_BACKEND_BASE_URL = _runtimeBackendBaseUrl;
    return;
  }

  const cfg = readDevConfig();
  const fromCfg = String((cfg as any).backend_base_url || "").trim();
  if (fromCfg) {
    _runtimeBackendBaseUrl = fromCfg.replace(/\/$/, "");
    process.env.EDGE_VIDEO_AGENT_BACKEND_BASE_URL = _runtimeBackendBaseUrl;
    return;
  }

  if (app.isPackaged) {
    const host = "127.0.0.1";
    const port = await findFreePort(host);
    process.env.EDGE_VIDEO_AGENT_BACKEND_PORT = String(port);
    _runtimeBackendBaseUrl = `http://${host}:${port}`;
    process.env.EDGE_VIDEO_AGENT_BACKEND_BASE_URL = _runtimeBackendBaseUrl;
    return;
  }

  _runtimeBackendBaseUrl = "http://127.0.0.1:8001";
  process.env.EDGE_VIDEO_AGENT_BACKEND_BASE_URL = _runtimeBackendBaseUrl;
}

function getRepoRootGuess(): string {
  const env = String(process.env.EDGE_VIDEO_AGENT_REPO_ROOT || "").trim();
  if (env) return env;
  const cwd = String(process.cwd() || "").trim();
  if (!cwd) return cwd;

  let cur = cwd;
  for (let i = 0; i < 6; i++) {
    try {
      const hasBackend = existsSync(join(cur, "backend"));
      const hasFrontend = existsSync(join(cur, "frontend"));
      if (hasBackend && hasFrontend) {
        return cur;
      }
    } catch {}
    const up = dirname(cur);
    if (!up || up === cur) break;
    cur = up;
  }

  return cwd;
}

function resolveBackendPythonExe(): { pythonExe: string; backendDir: string } {
  const repoRoot = getRepoRootGuess();
  const backendDir = join(repoRoot, "backend");
  const venvPython = join(backendDir, ".venv", "Scripts", "python.exe");
  if (existsSync(venvPython)) {
    return { pythonExe: venvPython, backendDir };
  }
  return { pythonExe: "python", backendDir };
}

function resolveBackendExe(): { exePath: string; cwd: string } | null {
  const candidates: { exePath: string; cwd: string }[] = [];

  // Packaged: expected to be shipped under resources/backend/...
  try {
    const rp = String((process as any).resourcesPath || "").trim();
    if (rp) {
      const a = join(rp, "backend", "edge-video-agent-backend", "edge-video-agent-backend.exe");
      candidates.push({ exePath: a, cwd: dirname(a) });
    }
  } catch {}

  // Dev: use locally built PyInstaller onedir output.
  const repoRoot = getRepoRootGuess();
  if (repoRoot) {
    const staged = join(
      repoRoot,
      "frontend",
      "resources",
      "backend",
      "edge-video-agent-backend",
      "edge-video-agent-backend.exe"
    );
    candidates.push({ exePath: staged, cwd: dirname(staged) });
    const p = join(
      repoRoot,
      "artifacts",
      "pyinstaller_backend",
      "dist",
      "edge-video-agent-backend",
      "edge-video-agent-backend.exe"
    );
    candidates.push({ exePath: p, cwd: dirname(p) });
  }

  for (const c of candidates) {
    try {
      if (c.exePath && existsSync(c.exePath)) {
        return c;
      }
    } catch {}
  }
  return null;
}

function probeHealthOk(u: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      const url = new URL(u);
      const mod = url.protocol === "https:" ? https : http;
      const port = url.port
        ? parseInt(url.port, 10)
        : url.protocol === "https:"
        ? 443
        : 80;
      const req = mod.request(
        {
          method: "GET",
          host: url.hostname,
          port,
          path: url.pathname || "/",
          timeout: timeoutMs,
        },
        (res) => {
          res.resume();
          if (res.statusCode === 200) {
            resolve();
          } else {
            reject(new Error(`HTTP_${res.statusCode || 0}`));
          }
        }
      );
      req.on("error", reject);
      req.on("timeout", () => req.destroy(new Error("timeout")));
      req.end();
    } catch (e) {
      reject(e);
    }
  });
}

async function waitForHealth(u: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (true) {
    try {
      await probeHealthOk(u, 1200);
      return;
    } catch {}
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Backend not reachable: ${u}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

function shouldAutoStartBackend(): boolean {
  const flag = String(
    process.env.EDGE_VIDEO_AGENT_AUTO_START_BACKEND || ""
  ).trim();
  if (flag) {
    return (
      flag === "1" ||
      flag.toLowerCase() === "true" ||
      flag.toLowerCase() === "yes"
    );
  }
  return app.isPackaged;
}

async function ensureBackendStarted(): Promise<void> {
  const base = String(process.env.EDGE_VIDEO_AGENT_BACKEND_BASE_URL || "")
    .trim()
    .replace(/\/$/, "");
  if (!base) return;
  const healthUrl = `${base}/health`;

  try {
    await probeHealthOk(healthUrl, 1200);
    return;
  } catch {}

  if (!shouldAutoStartBackend()) {
    return;
  }

  if (_backendProc) {
    await waitForHealth(healthUrl, 15000);
    return;
  }

  let parsedPort = "";
  try {
    const u = new URL(base);
    parsedPort = String(u.port || "");
  } catch {
    parsedPort = "";
  }

  const port = String(
    process.env.EDGE_VIDEO_AGENT_BACKEND_PORT ||
      process.env.EDGE_VIDEO_AGENT_PORT ||
      process.env.PORT ||
      parsedPort ||
      ""
  ).trim();

  const env = {
    ...process.env,
    EDGE_VIDEO_AGENT_DISABLE_WORKER: String(
      process.env.EDGE_VIDEO_AGENT_DISABLE_WORKER || ""
    ),
    EDGE_VIDEO_AGENT_HOST: String(
      process.env.EDGE_VIDEO_AGENT_HOST || "127.0.0.1"
    ),
    EDGE_VIDEO_AGENT_BACKEND_PORT: port,
    PORT: port,
  } as NodeJS.ProcessEnv;

  const exe = resolveBackendExe();
  if (exe) {
    console.log(
      "[main] starting backend exe:",
      exe.exePath,
      "cwd=",
      exe.cwd,
      "port=",
      env.EDGE_VIDEO_AGENT_BACKEND_PORT
    );
    _backendProc = spawn(exe.exePath, [], {
      cwd: exe.cwd,
      env,
      windowsHide: true,
    });
  } else {
    const { pythonExe, backendDir } = resolveBackendPythonExe();
    console.log(
      "[main] starting backend py:",
      pythonExe,
      "cwd=",
      backendDir,
      "port=",
      env.EDGE_VIDEO_AGENT_BACKEND_PORT
    );
    _backendProc = spawn(pythonExe, ["-m", "app.main"], {
      cwd: backendDir,
      env,
      windowsHide: true,
    });
  }

  _backendProc.stdout.on("data", (buf) =>
    console.log("[backend]", String(buf))
  );
  _backendProc.stderr.on("data", (buf) =>
    console.error("[backend]", String(buf))
  );
  _backendProc.on("exit", (code, sig) => {
    console.error("[main] backend exited:", code, sig);
    _backendProc = null;
  });

  await waitForHealth(healthUrl, 20000);
}

function resolvePreloadPath(): string | null {
  const candidates: string[] = [];

  candidates.push(join(__dirname, "../preload/index.js"));

  const appPath = String(app.getAppPath() || "").trim();
  if (appPath) {
    candidates.push(join(appPath, "out/preload/index.js"));
    candidates.push(join(appPath, "dist/preload/index.js"));
  }

  const cwd = String(process.cwd() || "").trim();
  if (cwd) {
    candidates.push(join(cwd, "out/preload/index.js"));
    candidates.push(join(cwd, "dist/preload/index.js"));
  }

  for (const p of candidates) {
    try {
      if (p && existsSync(p)) return p;
    } catch {}
  }
  return null;
}

function getDevConfigPath(): string {
  const repoRoot = String(process.env.EDGE_VIDEO_AGENT_REPO_ROOT || "").trim();
  if (repoRoot) {
    return join(repoRoot, "artifacts", "dev_config.json");
  }
  return join(app.getPath("userData"), "dev_config.json");
}

function readDevConfig(): Record<string, unknown> {
  const p = getDevConfigPath();
  if (!existsSync(p)) {
    return {};
  }
  try {
    const raw = readFileSync(p, { encoding: "utf-8" });
    const obj = JSON.parse(raw || "{}");
    return obj && typeof obj === "object"
      ? (obj as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function writeDevConfig(config: Record<string, unknown>): {
  path: string;
  config: Record<string, unknown>;
} {
  const p = getDevConfigPath();
  try {
    mkdirSync(dirname(p), { recursive: true });
  } catch {}
  try {
    writeFileSync(p, JSON.stringify(config || {}, null, 2), {
      encoding: "utf-8",
    });
  } catch {}
  return { path: p, config: readDevConfig() };
}

function normalizeDevUrl(u: string): string {
  const s = String(u || "").trim();
  if (!s) return s;
  return s
    .replace("http://localhost:", "http://127.0.0.1:")
    .replace("https://localhost:", "https://127.0.0.1:");
}

function escapeHtml(s: string): string {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function probeUrl(u: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      const url = new URL(u);
      const mod = url.protocol === "https:" ? https : http;
      const port = url.port
        ? parseInt(url.port, 10)
        : url.protocol === "https:"
        ? 443
        : 80;
      const req = mod.request(
        {
          method: "GET",
          host: url.hostname,
          port,
          path: url.pathname || "/",
          timeout: timeoutMs,
        },
        (res) => {
          res.resume();
          resolve();
        }
      );
      req.on("error", reject);
      req.on("timeout", () => req.destroy(new Error("timeout")));
      req.end();
    } catch (e) {
      reject(e);
    }
  });
}

async function waitForUrl(u: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (true) {
    try {
      await probeUrl(u, 1200);
      return;
    } catch {}
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Dev server not reachable: ${u}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function createWindow(): Promise<void> {
  await ensureBackendEnv();
  await ensureBackendStarted();

  const preloadPath = resolvePreloadPath();
  console.log("[main] preload:", preloadPath || "(not found)");
  console.log("[main] backend:", process.env.EDGE_VIDEO_AGENT_BACKEND_BASE_URL);

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 820,
    webPreferences: {
      preload: preloadPath || join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      webSecurity: app.isPackaged,
    },
  });

  mainWindow.webContents.on("preload-error", (_event, path, error) => {
    console.error("[main] preload-error:", path, error);
  });

  mainWindow.webContents.on("did-finish-load", () => {
    void mainWindow?.webContents
      .executeJavaScript("typeof window.electronAPI")
      .then((v) => console.log("[main] window.electronAPI:", v))
      .catch((e) =>
        console.error("[main] window.electronAPI probe failed:", e)
      );
  });

  if (!preloadPath) {
    try {
      await dialog.showMessageBox(mainWindow, {
        type: "warning",
        message: "Preload script not found",
        detail:
          "The Electron preload script could not be located. This will disable file dialogs (window.electronAPI is missing).\n\nTry restarting the dev server or re-running the frontend build/dev command.",
      });
    } catch {}
  }

  if (!app.isPackaged) {
    const u = normalizeDevUrl(rawDevServerUrl) || "http://127.0.0.1:5173/";
    try {
      await waitForUrl(u, 15000);
      await mainWindow.loadURL(u);
      mainWindow.webContents.openDevTools({ mode: "detach" });
      return;
    } catch (e: any) {
      const msg = e && e.message ? String(e.message) : String(e);
      await mainWindow.loadURL(
        "data:text/html;charset=utf-8," +
          encodeURIComponent(
            `<html><body style="font-family: ui-sans-serif, system-ui; padding: 24px;">
              <h2>Dev server not reachable</h2>
              <div><b>URL:</b> ${escapeHtml(u)}</div>
              <pre style="white-space: pre-wrap;">${escapeHtml(msg)}</pre>
              <div>Make sure the renderer dev server is running.</div>
            </body></html>`
          )
      );
      return;
    }
  } else {
    const rendererHtml = join(__dirname, "../renderer/index.html");
    if (!existsSync(rendererHtml)) {
      await mainWindow.loadURL("http://127.0.0.1:5173/");
    } else {
      await mainWindow.loadFile(rendererHtml);
    }
  }
}

ipcMain.handle("dialog:openVideo", async () => {
  const res = await dialog.showOpenDialog({
    properties: ["openFile"],
    filters: [
      {
        name: "Video",
        extensions: ["mp4", "mkv", "mov", "avi", "webm"],
      },
    ],
  });
  if (res.canceled || res.filePaths.length === 0) {
    return null;
  }
  return res.filePaths[0];
});

ipcMain.handle("dialog:openLlamaExe", async () => {
  const res = await dialog.showOpenDialog({
    properties: ["openFile"],
    filters: [
      {
        name: "Executable",
        extensions: ["exe"],
      },
    ],
  });
  if (res.canceled || res.filePaths.length === 0) {
    return null;
  }
  return res.filePaths[0];
});

ipcMain.handle("dialog:openLlamaModel", async () => {
  const res = await dialog.showOpenDialog({
    properties: ["openFile"],
    filters: [
      {
        name: "GGUF",
        extensions: ["gguf"],
      },
    ],
  });
  if (res.canceled || res.filePaths.length === 0) {
    return null;
  }
  return res.filePaths[0];
});

ipcMain.handle("config:getDevConfig", async () => {
  const p = getDevConfigPath();
  const cfg = readDevConfig();
  return { path: p, config: cfg };
});

ipcMain.handle("config:setDevConfig", async (_evt, config: any) => {
  const payload =
    config && typeof config === "object"
      ? (config as Record<string, unknown>)
      : {};
  return writeDevConfig(payload);
});

app.whenReady().then(async () => {
  await createWindow();

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    try {
      if (_backendProc) {
        _backendProc.kill();
        _backendProc = null;
      }
    } catch {}
    app.quit();
  }
});
