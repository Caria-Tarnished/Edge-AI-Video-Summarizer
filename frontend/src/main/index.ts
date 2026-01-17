import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { autoUpdater } from "electron-updater";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import * as os from "node:os";
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

type DataDirConfig = {
  data_dir?: string;
};

function getDataDirConfigPath(): string {
  return join(app.getPath("userData"), "data_dir.json");
}

function readDataDirConfig(): DataDirConfig {
  const p = getDataDirConfigPath();
  if (!existsSync(p)) {
    return {};
  }
  try {
    const raw = readFileSync(p, { encoding: "utf-8" });
    const obj = JSON.parse(raw || "{}");
    return obj && typeof obj === "object" ? (obj as DataDirConfig) : {};
  } catch {
    return {};
  }
}

function writeDataDirConfig(config: DataDirConfig): DataDirConfig {
  const p = getDataDirConfigPath();
  try {
    mkdirSync(dirname(p), { recursive: true });
  } catch {}
  try {
    writeFileSync(p, JSON.stringify(config || {}, null, 2), {
      encoding: "utf-8",
    });
  } catch {}
  return readDataDirConfig();
}

function getDefaultPackagedDataDir(): string {
  return join(app.getPath("userData"), "edge-video-agent-data");
}

function isDirEmpty(p: string): boolean {
  try {
    if (!existsSync(p)) return true;
    const st = statSync(p);
    if (!st.isDirectory()) return true;
    const items = readdirSync(p);
    return items.length === 0;
  } catch {
    return true;
  }
}

function copyDirRecursive(src: string, dst: string): void {
  const st = statSync(src);
  if (!st.isDirectory()) {
    throw new Error("source is not a directory");
  }
  mkdirSync(dst, { recursive: true });
  const ents = readdirSync(src, { withFileTypes: true });
  for (const ent of ents) {
    const sp = join(src, ent.name);
    const dp = join(dst, ent.name);
    if (ent.isDirectory()) {
      copyDirRecursive(sp, dp);
      continue;
    }
    if (ent.isFile()) {
      mkdirSync(dirname(dp), { recursive: true });
      copyFileSync(sp, dp);
      continue;
    }
  }
}

function resolvePreferredDataDir(): string {
  const env = String(process.env.EDGE_VIDEO_AGENT_DATA_DIR || "").trim();
  if (env) return env;
  const cfg = readDataDirConfig();
  const fromCfg = String(cfg.data_dir || "").trim();
  if (fromCfg) return fromCfg;
  if (app.isPackaged) return getDefaultPackagedDataDir();
  return join(os.homedir(), ".edge-video-agent");
}

function psQuote(s: string): string {
  const v = String(s || "");
  return `'${v.replaceAll("'", "''")}'`;
}

async function runPowerShell(command: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "powershell",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
      {
        windowsHide: true,
      }
    );
    let stderr = "";
    child.stderr.on("data", (buf) => {
      stderr += String(buf || "");
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(stderr || `PowerShell failed: ${code}`));
      }
    });
  });
}

async function ensureDataDirSelectedAndMigrated(): Promise<void> {
  if (!app.isPackaged) {
    return;
  }

  const env = String(process.env.EDGE_VIDEO_AGENT_DATA_DIR || "").trim();
  if (env) {
    return;
  }

  const cfg = readDataDirConfig();
  const cfgDir = String(cfg.data_dir || "").trim();
  if (cfgDir) {
    process.env.EDGE_VIDEO_AGENT_DATA_DIR = cfgDir;
    try {
      mkdirSync(cfgDir, { recursive: true });
    } catch {}
    return;
  }

  const newDir = getDefaultPackagedDataDir();
  const oldDir = join(os.homedir(), ".edge-video-agent");

  const oldExists = existsSync(oldDir) && !isDirEmpty(oldDir);
  const newEmpty = isDirEmpty(newDir);
  if (oldExists && newEmpty) {
    const res = await dialog.showMessageBox({
      type: "question",
      buttons: [
        "\u590d\u5236\u8fc1\u79fb\uff08\u63a8\u8350\uff09",
        "\u7ee7\u7eed\u4f7f\u7528\u65e7\u76ee\u5f55",
      ],
      defaultId: 0,
      cancelId: 1,
      message: "\u68c0\u6d4b\u5230\u65e7\u7248\u6570\u636e\u76ee\u5f55\uff0c\u662f\u5426\u8fc1\u79fb\u5230\u65b0\u7684\u5b89\u88c5\u5b89\u5168\u76ee\u5f55\uff1f",
      detail:
        `\u65e7\u76ee\u5f55\uff1a${oldDir}\n\n\u65b0\u76ee\u5f55\uff1a${newDir}\n\n\u63a8\u8350\u9009\u62e9\u201c\u590d\u5236\u8fc1\u79fb\u201d\uff0c\u5b8c\u6210\u540e\u4f1a\u518d\u8be2\u95ee\u662f\u5426\u5220\u9664\u65e7\u76ee\u5f55\u4ee5\u91ca\u653e\u7a7a\u95f4\u3002`,
    });

    if (res.response === 0) {
      try {
        mkdirSync(newDir, { recursive: true });
        copyDirRecursive(oldDir, newDir);
        process.env.EDGE_VIDEO_AGENT_DATA_DIR = newDir;
        writeDataDirConfig({ data_dir: newDir });

        const del = await dialog.showMessageBox({
          type: "question",
          buttons: ["\u4e0d\u5220\u9664", "\u5220\u9664\u65e7\u76ee\u5f55"],
          defaultId: 0,
          cancelId: 0,
          message:
            "\u5df2\u6210\u529f\u590d\u5236\u8fc1\u79fb\u6570\u636e\u3002\u662f\u5426\u5220\u9664\u65e7\u76ee\u5f55\u4ee5\u91ca\u653e\u7a7a\u95f4\uff1f",
          detail: `\u65e7\u76ee\u5f55\uff1a${oldDir}`,
        });
        if (del.response === 1) {
          try {
            rmSync(oldDir, { recursive: true, force: true });
          } catch {}
        }
        return;
      } catch (e: any) {
        const msg = e && e.message ? String(e.message) : String(e);
        await dialog.showMessageBox({
          type: "error",
          message: "\u8fc1\u79fb\u5931\u8d25\uff0c\u5c06\u4f7f\u7528\u65e7\u76ee\u5f55\u8fd0\u884c\u3002",
          detail: msg,
        });
        process.env.EDGE_VIDEO_AGENT_DATA_DIR = oldDir;
        writeDataDirConfig({ data_dir: oldDir });
        return;
      }
    }

    process.env.EDGE_VIDEO_AGENT_DATA_DIR = oldDir;
    writeDataDirConfig({ data_dir: oldDir });
    return;
  }

  process.env.EDGE_VIDEO_AGENT_DATA_DIR = newDir;
  try {
    mkdirSync(newDir, { recursive: true });
  } catch {}
  writeDataDirConfig({ data_dir: newDir });
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

type UpdateCheckOk = {
  ok: true;
  current_version: string;
  latest_version: string;
  update_available: boolean;
  release_url: string;
  release_tag: string;
  prerelease: boolean;
  published_at: string;
  assets: Array<{ name: string; url: string }>;
};

type UpdateCheckErr = {
  ok: false;
  error: string;
};

type UpdateCheckResult = UpdateCheckOk | UpdateCheckErr;

type UpdaterStatus =
  | "disabled"
  | "idle"
  | "checking"
  | "update_available"
  | "no_update"
  | "downloading"
  | "downloaded"
  | "error";

type UpdaterState = {
  supported: boolean;
  status: UpdaterStatus;
  current_version: string;
  available_version?: string;
  release_url?: string;
  downloaded?: boolean;
  progress?: {
    percent?: number;
    transferred?: number;
    total?: number;
    bytes_per_second?: number;
  };
  error?: string;
  last_checked_at?: string;
};

let _updaterState: UpdaterState = {
  supported: false,
  status: "disabled",
  current_version: String(app.getVersion() || ""),
};

function getUpdateRepo(): string {
  return String(
    process.env.EDGE_VIDEO_AGENT_UPDATE_REPO ||
      "Caria-Tarnished/Edge-AI-Video-Summarizer"
  ).trim();
}

function buildReleaseUrlFromVersion(v: string): string {
  const repo = getUpdateRepo();
  const ver = String(v || "").trim();
  if (!repo || !ver) return "";
  const tag = ver.startsWith("v") || ver.startsWith("V") ? ver : `v${ver}`;
  return `https://github.com/${repo}/releases/tag/${tag}`;
}

function emitUpdaterState(): void {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("updater:event", { type: "state", state: _updaterState });
    }
  } catch {}
}

function initAutoUpdater(): void {
  const disabled = String(process.env.EDGE_VIDEO_AGENT_DISABLE_AUTO_UPDATE || "").trim();
  const supported = app.isPackaged && !(disabled === "1" || disabled.toLowerCase() === "true");

  _updaterState = {
    supported,
    status: supported ? "idle" : "disabled",
    current_version: String(app.getVersion() || ""),
  };

  if (!supported) {
    emitUpdaterState();
    return;
  }

  autoUpdater.autoDownload = false;
  autoUpdater.allowPrerelease = String(app.getVersion() || "").includes("-");

  autoUpdater.on("checking-for-update", () => {
    _updaterState = {
      ..._updaterState,
      status: "checking",
      error: undefined,
      last_checked_at: new Date().toISOString(),
    };
    emitUpdaterState();
  });

  autoUpdater.on("update-available", (info: any) => {
    const next = String(info?.version || "").trim();
    _updaterState = {
      ..._updaterState,
      status: "update_available",
      available_version: next || _updaterState.available_version,
      release_url: next ? buildReleaseUrlFromVersion(next) : _updaterState.release_url,
      downloaded: false,
      progress: undefined,
      error: undefined,
    };
    emitUpdaterState();
  });

  autoUpdater.on("update-not-available", () => {
    _updaterState = {
      ..._updaterState,
      status: "no_update",
      available_version: undefined,
      release_url: undefined,
      downloaded: false,
      progress: undefined,
      error: undefined,
      last_checked_at: new Date().toISOString(),
    };
    emitUpdaterState();
  });

  autoUpdater.on("download-progress", (p: any) => {
    _updaterState = {
      ..._updaterState,
      status: "downloading",
      progress: {
        percent: typeof p?.percent === "number" ? p.percent : undefined,
        transferred: typeof p?.transferred === "number" ? p.transferred : undefined,
        total: typeof p?.total === "number" ? p.total : undefined,
        bytes_per_second:
          typeof p?.bytesPerSecond === "number" ? p.bytesPerSecond : undefined,
      },
      error: undefined,
    };
    emitUpdaterState();
  });

  autoUpdater.on("update-downloaded", (info: any) => {
    const next = String(info?.version || "").trim();
    _updaterState = {
      ..._updaterState,
      status: "downloaded",
      available_version: next || _updaterState.available_version,
      release_url: (next ? buildReleaseUrlFromVersion(next) : "") || _updaterState.release_url,
      downloaded: true,
      error: undefined,
    };
    emitUpdaterState();
  });

  autoUpdater.on("error", (e: any) => {
    const msg = e && e.message ? String(e.message) : String(e);
    _updaterState = {
      ..._updaterState,
      status: "error",
      error: msg,
    };
    emitUpdaterState();
  });

  emitUpdaterState();
}

type SemVer = {
  major: number;
  minor: number;
  patch: number;
  preTag?: string;
  preNum?: number;
};

function normalizeTagVersion(tag: string): string {
  const t = String(tag || "").trim();
  return t.startsWith("v") || t.startsWith("V") ? t.slice(1) : t;
}

function parseSemVer(v: string): SemVer | null {
  const s = String(v || "").trim();
  const m = s.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!m) return null;
  const major = parseInt(m[1] || "0", 10);
  const minor = parseInt(m[2] || "0", 10);
  const patch = parseInt(m[3] || "0", 10);
  const pre = String(m[4] || "").trim();
  if (!pre) return { major, minor, patch };
  const parts = pre.split(".");
  const preTag = String(parts[0] || "").trim();
  const preNumRaw = String(parts[1] || "").trim();
  const preNum = preNumRaw && /^\d+$/.test(preNumRaw) ? parseInt(preNumRaw, 10) : undefined;
  return { major, minor, patch, preTag, preNum };
}

function preTagRank(tag: string): number {
  const t = String(tag || "").toLowerCase();
  if (t === "alpha") return 0;
  if (t === "beta") return 1;
  if (t === "rc") return 2;
  return 3;
}

function compareSemVer(a: SemVer, b: SemVer): number {
  if (a.major !== b.major) return a.major > b.major ? 1 : -1;
  if (a.minor !== b.minor) return a.minor > b.minor ? 1 : -1;
  if (a.patch !== b.patch) return a.patch > b.patch ? 1 : -1;

  const ap = !!a.preTag;
  const bp = !!b.preTag;
  if (!ap && !bp) return 0;
  if (!ap && bp) return 1;
  if (ap && !bp) return -1;

  const ar = preTagRank(String(a.preTag || ""));
  const br = preTagRank(String(b.preTag || ""));
  if (ar !== br) return ar > br ? 1 : -1;

  const an = typeof a.preNum === "number" ? a.preNum : -1;
  const bn = typeof b.preNum === "number" ? b.preNum : -1;
  if (an !== bn) return an > bn ? 1 : -1;

  return 0;
}

function httpGetJson(urlStr: string, timeoutMs: number): Promise<any> {
  return new Promise((resolve, reject) => {
    try {
      const url = new URL(urlStr);
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
          path: `${url.pathname || "/"}${url.search || ""}`,
          timeout: timeoutMs,
          headers: {
            "User-Agent": "edge-video-agent",
            Accept: "application/vnd.github+json",
          },
        },
        (res) => {
          let body = "";
          res.setEncoding("utf-8");
          res.on("data", (chunk) => {
            body += String(chunk || "");
          });
          res.on("end", () => {
            try {
              const code = res.statusCode || 0;
              if (code < 200 || code >= 300) {
                reject(new Error(`HTTP_${code}`));
                return;
              }
              resolve(JSON.parse(body || "{}"));
            } catch (e) {
              reject(e);
            }
          });
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

async function checkForUpdatesManual(): Promise<UpdateCheckResult> {
  const repo = String(
    process.env.EDGE_VIDEO_AGENT_UPDATE_REPO ||
      "Caria-Tarnished/Edge-AI-Video-Summarizer"
  ).trim();
  const current = String(app.getVersion() || "").trim();
  if (!repo || !current) {
    return { ok: false, error: "MISSING_REPO_OR_VERSION" };
  }

  const currentIsPre = current.includes("-");
  try {
    let rel: any = null;
    if (currentIsPre) {
      const list = await httpGetJson(
        `https://api.github.com/repos/${repo}/releases?per_page=30`,
        12000
      );
      const arr = Array.isArray(list) ? list : [];
      rel =
        arr.find((r) => r && typeof r === "object" && (r as any).prerelease) ||
        arr.find((r) => r && typeof r === "object" && !(r as any).prerelease) ||
        null;
    } else {
      rel = await httpGetJson(
        `https://api.github.com/repos/${repo}/releases/latest`,
        12000
      );
    }

    if (!rel || typeof rel !== "object") {
      return { ok: false, error: "NO_RELEASE" };
    }

    const tag = String((rel as any).tag_name || "").trim();
    const latestVersion = normalizeTagVersion(tag);
    const releaseUrl = String((rel as any).html_url || "").trim();
    const publishedAt = String((rel as any).published_at || "").trim();
    const prerelease = Boolean((rel as any).prerelease);

    if (!latestVersion || !releaseUrl) {
      return { ok: false, error: "BAD_RELEASE_METADATA" };
    }

    const curSv = parseSemVer(current);
    const latSv = parseSemVer(latestVersion);
    const updateAvailable =
      curSv && latSv ? compareSemVer(latSv, curSv) > 0 : latestVersion !== current;

    const assetsRaw = Array.isArray((rel as any).assets)
      ? ((rel as any).assets as any[])
      : [];
    const assets = assetsRaw
      .map((a) => {
        const name = String(a?.name || "").trim();
        const url = String(a?.browser_download_url || "").trim();
        if (!name || !url) return null;
        return { name, url };
      })
      .filter(Boolean) as Array<{ name: string; url: string }>;

    return {
      ok: true,
      current_version: current,
      latest_version: latestVersion,
      update_available: updateAvailable,
      release_url: releaseUrl,
      release_tag: tag,
      prerelease,
      published_at: publishedAt,
      assets,
    };
  } catch (e: any) {
    return { ok: false, error: e && e.message ? String(e.message) : String(e) };
  }
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
  await ensureDataDirSelectedAndMigrated();
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

ipcMain.handle("app:getVersion", async () => {
  return {
    version: String(app.getVersion() || ""),
    is_packaged: Boolean(app.isPackaged),
  };
});

ipcMain.handle("app:checkUpdates", async () => {
  return await checkForUpdatesManual();
});

ipcMain.handle("app:openExternal", async (_evt, url: any) => {
  const u = String(url || "").trim();
  if (!u) {
    return { ok: false, error: "EMPTY_URL" };
  }
  try {
    await shell.openExternal(u);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e && e.message ? String(e.message) : String(e) };
  }
});

ipcMain.handle("updater:getState", async () => {
  return _updaterState;
});

ipcMain.handle("updater:check", async () => {
  if (!_updaterState.supported) {
    return { ok: false, error: "NOT_SUPPORTED", state: _updaterState };
  }
  try {
    const res = await autoUpdater.checkForUpdates();
    return { ok: true, result: res, state: _updaterState };
  } catch (e: any) {
    const msg = e && e.message ? String(e.message) : String(e);
    _updaterState = { ..._updaterState, status: "error", error: msg };
    emitUpdaterState();
    return { ok: false, error: msg, state: _updaterState };
  }
});

ipcMain.handle("updater:download", async () => {
  if (!_updaterState.supported) {
    return { ok: false, error: "NOT_SUPPORTED", state: _updaterState };
  }
  try {
    await autoUpdater.downloadUpdate();
    return { ok: true, state: _updaterState };
  } catch (e: any) {
    const msg = e && e.message ? String(e.message) : String(e);
    _updaterState = { ..._updaterState, status: "error", error: msg };
    emitUpdaterState();
    return { ok: false, error: msg, state: _updaterState };
  }
});

ipcMain.handle("updater:install", async () => {
  if (!_updaterState.supported) {
    return { ok: false, error: "NOT_SUPPORTED", state: _updaterState };
  }
  try {
    setTimeout(() => {
      try {
        autoUpdater.quitAndInstall(true, true);
      } catch {}
    }, 50);
    return { ok: true };
  } catch (e: any) {
    const msg = e && e.message ? String(e.message) : String(e);
    _updaterState = { ..._updaterState, status: "error", error: msg };
    emitUpdaterState();
    return { ok: false, error: msg, state: _updaterState };
  }
});

ipcMain.handle("data:exportZip", async () => {
  const dataDir = resolvePreferredDataDir() || getDefaultPackagedDataDir();
  try {
    mkdirSync(dataDir, { recursive: true });
  } catch {}

  const res = await dialog.showSaveDialog({
    title: "\u5bfc\u51fa\u6570\u636e\u5907\u4efd\uff08zip\uff09",
    defaultPath: join(app.getPath("downloads"), "edge-video-agent-data.zip"),
    filters: [{ name: "Zip", extensions: ["zip"] }],
  });

  if (res.canceled || !res.filePath) {
    return { ok: false, cancelled: true };
  }

  const zipPath = String(res.filePath || "");
  try {
    const cmd = `Compress-Archive -Path ${psQuote(
      dataDir
    )} -DestinationPath ${psQuote(zipPath)} -Force`;
    await runPowerShell(cmd);
    return { ok: true, path: zipPath, data_dir: dataDir };
  } catch (e: any) {
    const msg = e && e.message ? String(e.message) : String(e);
    return { ok: false, error: msg, data_dir: dataDir };
  }
});

ipcMain.handle("data:restoreZip", async () => {
  const dataDir = resolvePreferredDataDir() || getDefaultPackagedDataDir();
  try {
    mkdirSync(dataDir, { recursive: true });
  } catch {}

  const pick = await dialog.showOpenDialog({
    title: "\u9009\u62e9\u5907\u4efd\u6587\u4ef6\uff08zip\uff09",
    properties: ["openFile"],
    filters: [{ name: "Zip", extensions: ["zip"] }],
  });
  if (pick.canceled || pick.filePaths.length === 0) {
    return { ok: false, cancelled: true };
  }

  const zipPath = String(pick.filePaths[0] || "");
  const ok = await dialog.showMessageBox({
    type: "warning",
    buttons: ["\u53d6\u6d88", "\u7ee7\u7eed\u6062\u590d"],
    defaultId: 0,
    cancelId: 0,
    message: "\u6062\u590d\u5907\u4efd\u5c06\u8986\u76d6\u5f53\u524d\u6570\u636e\u3002\u662f\u5426\u7ee7\u7eed\uff1f",
    detail: `zip\uff1a${zipPath}\n\n\u76ee\u6807\u6570\u636e\u76ee\u5f55\uff1a${dataDir}`,
  });
  if (ok.response !== 1) {
    return { ok: false, cancelled: true };
  }

  try {
    const restoreTmp = `${dataDir}.restore-${Date.now()}`;
    try {
      rmSync(restoreTmp, { recursive: true, force: true });
    } catch {}
    mkdirSync(restoreTmp, { recursive: true });

    const cmd = `Expand-Archive -Path ${psQuote(
      zipPath
    )} -DestinationPath ${psQuote(restoreTmp)} -Force`;
    await runPowerShell(cmd);

    let root = restoreTmp;
    try {
      const ents = readdirSync(restoreTmp, { withFileTypes: true });
      if (ents.length === 1 && ents[0].isDirectory()) {
        root = join(restoreTmp, ents[0].name);
      }
    } catch {}

    const bak = `${dataDir}.backup-${Date.now()}`;
    if (!isDirEmpty(dataDir)) {
      try {
        renameSync(dataDir, bak);
      } catch (e: any) {
        const msg = e && e.message ? String(e.message) : String(e);
        try {
          rmSync(restoreTmp, { recursive: true, force: true });
        } catch {}
        throw new Error(`BACKUP_FAILED:${msg}`);
      }
    } else {
      try {
        rmSync(dataDir, { recursive: true, force: true });
      } catch {}
    }

    try {
      renameSync(root, dataDir);
    } finally {
      try {
        rmSync(restoreTmp, { recursive: true, force: true });
      } catch {}
    }

    try {
      if (_backendProc) {
        _backendProc.kill();
        _backendProc = null;
      }
    } catch {}

    await ensureBackendStarted();
    try {
      mainWindow?.webContents.reload();
    } catch {}
    return { ok: true, path: zipPath, data_dir: dataDir };
  } catch (e: any) {
    const msg = e && e.message ? String(e.message) : String(e);
    return { ok: false, error: msg, path: zipPath, data_dir: dataDir };
  }
});

app.whenReady().then(async () => {
  await createWindow();
  initAutoUpdater();

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

app.on("before-quit", () => {
  try {
    if (_backendProc) {
      _backendProc.kill();
      _backendProc = null;
    }
  } catch {}
});
