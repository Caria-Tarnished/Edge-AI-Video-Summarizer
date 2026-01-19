import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { autoUpdater } from "electron-updater";
import {
  copyFileSync,
  createReadStream,
  createWriteStream,
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
import * as crypto from "node:crypto";
import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import * as os from "node:os";
import { dirname, join } from "path";

const rawDevServerUrl = String(
  process.env.VITE_DEV_SERVER_URL || process.env.ELECTRON_RENDERER_URL || "",
).trim();

let mainWindow: BrowserWindow | null = null;

let _backendProc: ChildProcessWithoutNullStreams | null = null;

let _runtimeBackendBaseUrl: string | null = null;

let _llamaProc: ChildProcessWithoutNullStreams | null = null;

type LlamaServerStatus =
  | "stopped"
  | "starting"
  | "running"
  | "stopping"
  | "exited"
  | "error";

type LlamaServerState = {
  status: LlamaServerStatus;
  pid?: number | null;
  started_at?: string | null;
  stopped_at?: string | null;
  last_exit_code?: number | null;
  last_signal?: string | null;
  error?: string | null;
};

let _llamaState: LlamaServerState = {
  status: "stopped",
};

const _llamaStdoutTail: string[] = [];
const _llamaStderrTail: string[] = [];
let _llamaStdoutBuf = "";
let _llamaStderrBuf = "";
const _LLAMA_LOG_MAX_LINES = 400;

function emitLlamaEvent(type: string, payload: any): void {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("llama:event", { type, ...payload });
    }
  } catch {}
}

function setLlamaState(next: Partial<LlamaServerState>): void {
  _llamaState = {
    ..._llamaState,
    ...next,
  };
  emitLlamaEvent("state", { state: _llamaState });
}

function pushLogLine(arr: string[], line: string): void {
  const s = String(line || "").replace(/\r?\n$/, "");
  if (!s) return;
  arr.push(s);
  while (arr.length > _LLAMA_LOG_MAX_LINES) {
    arr.shift();
  }
}

async function downloadGgufPreset(opts: {
  taskId: string;
  slot: "q4" | "q5" | "small";
  repoId: string;
  filename?: string;
  destDir?: string;
}): Promise<{ ok: boolean; model_path?: string; error?: string }> {
  const taskId = String(opts.taskId || "").trim();
  const slot = opts.slot;
  const repoId = String(opts.repoId || "").trim();
  const dataDir = resolvePreferredDataDir() || getDefaultPackagedDataDir();
  const destDir =
    String(opts.destDir || "").trim() || join(dataDir, "models", "llm");

  if (!taskId) return { ok: false, error: "TASK_ID_REQUIRED" };
  if (!repoId) return { ok: false, error: "REPO_ID_REQUIRED" };

  setDepsTask(taskId, {
    kind: "gguf_model",
    status: "downloading",
    label: `gguf (${repoId})`,
    started_at: new Date().toISOString(),
    error: undefined,
    finished_at: undefined,
    transferred: 0,
    total: undefined,
    bytes_per_second: undefined,
    percent: undefined,
  });

  const inferFallbackFilename = (): string => {
    const r = repoId.toLowerCase();
    if (r.includes("qwen2.5-7b") && slot === "q4") {
      return "Qwen2.5-7B-Instruct-Q4_K_M.gguf";
    }
    if (r.includes("qwen2.5-7b") && slot === "q5") {
      return "Qwen2.5-7B-Instruct-Q5_K_M.gguf";
    }
    if (r.includes("qwen2.5-3b") && slot === "small") {
      return "Qwen2.5-3B-Instruct-Q4_K_M.gguf";
    }
    if (slot === "q5") return "model-q5.gguf";
    return "model-q4.gguf";
  };

  const pickFromList = (names: string[]): string | null => {
    const ggufs = names
      .map((n) => String(n || "").trim())
      .filter(Boolean)
      .filter((n) => n.toLowerCase().endsWith(".gguf"));

    const pickMatch = (re: RegExp) =>
      ggufs.find((n) => re.test(n)) || null;

    if (slot === "q4" || slot === "small") {
      return (
        pickMatch(/q4[_-]?k[_-]?m/i) ||
        pickMatch(/q4/i) ||
        ggufs[0] ||
        null
      );
    }
    return pickMatch(/q5[_-]?k[_-]?m/i) || pickMatch(/q5/i) || ggufs[0] || null;
  };

  const httpGetJsonAny = (urlStr: string, timeoutMs: number): Promise<any> => {
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
              Accept: "application/json",
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
          },
        );
        req.on("error", reject);
        req.on("timeout", () => req.destroy(new Error("timeout")));
        req.end();
      } catch (e) {
        reject(e);
      }
    });
  };

  try {
    let filename = String(opts.filename || "").trim();
    if (!filename) {
      try {
        const modelInfo = await httpGetJsonAny(
          `https://huggingface.co/api/models/${encodeURIComponent(repoId)}`,
          12000,
        );
        const sibs = Array.isArray(modelInfo?.siblings)
          ? (modelInfo.siblings as any[])
          : [];
        const names = sibs
          .map((s) => String(s?.rfilename || s?.path || s?.name || "").trim())
          .filter(Boolean);
        const picked = pickFromList(names);
        if (picked) filename = picked;
      } catch {}
    }

    if (!filename) {
      filename = inferFallbackFilename();
    }

    const destRoot = join(destDir, repoId.replaceAll("/", "__"));
    const outPath = join(destRoot, filename);
    const url = `https://huggingface.co/${repoId}/resolve/main/${encodeURIComponent(
      filename,
    )}?download=true`;

    setDepsTask(taskId, {
      url,
      meta: {
        repo_id: repoId,
        filename,
        slot,
        install_dir: destRoot,
      },
    });

    const tmpRoot = join(app.getPath("temp"), "edge-video-agent-deps");
    const tmpPath = join(tmpRoot, `gguf_${taskId}.gguf`);
    try {
      mkdirSync(tmpRoot, { recursive: true });
    } catch {}

    await httpDownloadToFile({
      url,
      destPath: tmpPath,
      onProgress: (p) => {
        setDepsTask(taskId, {
          status: "downloading",
          transferred: p.transferred,
          total: p.total,
          bytes_per_second: p.bytes_per_second,
          percent: p.percent,
        });
      },
      registerCancel: (cancel) => {
        _depsCancel[taskId] = cancel;
      },
      timeoutMs: 60000,
    });

    try {
      mkdirSync(dirname(outPath), { recursive: true });
    } catch {}

    try {
      try {
        rmSync(outPath, { force: true });
      } catch {}
      renameSync(tmpPath, outPath);
    } catch {
      copyFileSync(tmpPath, outPath);
      try {
        rmSync(tmpPath, { force: true });
      } catch {}
    }

    try {
      const cfg = readDevConfig();
      const patch: any = { ...(cfg || {}) };
      if (slot === "q4") patch.llama_model_q4_path = outPath;
      else if (slot === "q5") patch.llama_model_q5_path = outPath;
      else patch.llama_model_small_path = outPath;
      writeDevConfig(patch);
    } catch {}

    setDepsTask(taskId, {
      status: "done",
      finished_at: new Date().toISOString(),
      dest_path: outPath,
      transferred: undefined,
      total: undefined,
      bytes_per_second: undefined,
      percent: undefined,
    });
    return { ok: true, model_path: outPath };
  } catch (e: any) {
    const msg = e && e.message ? String(e.message) : String(e);
    setDepsTask(taskId, {
      status: msg === "CANCELLED" ? "cancelled" : "error",
      finished_at: new Date().toISOString(),
      error: msg,
    });
    return { ok: false, error: msg };
  } finally {
    try {
      delete _depsCancel[taskId];
    } catch {}
  }
}

function drainLogBuffer(buf: string, arr: string[]): { buf: string } {
  let b = buf;
  while (true) {
    const idx = b.indexOf("\n");
    if (idx < 0) break;
    const line = b.slice(0, idx);
    b = b.slice(idx + 1);
    pushLogLine(arr, line);
  }
  return { buf: b };
}

function clearLlamaLogs(): void {
  _llamaStdoutTail.splice(0, _llamaStdoutTail.length);
  _llamaStderrTail.splice(0, _llamaStderrTail.length);
  _llamaStdoutBuf = "";
  _llamaStderrBuf = "";
}

function getLlamaLogs(): { stdout: string[]; stderr: string[] } {
  return {
    stdout: [..._llamaStdoutTail],
    stderr: [..._llamaStderrTail],
  };
}

function getLlamaConfigFromDevConfig(): {
  llama_server_exe: string;
  llama_model_path: string;
  llama_port: number;
  local_llm_base_url: string;
  ctx_size: number;
  threads: number;
  gpu_layers: number;
} {
  const cfg = readDevConfig();
  const exe = String((cfg as any).llama_server_exe || "").trim();
  const model = String((cfg as any).llama_model_path || "").trim();
  const portRaw = (cfg as any).llama_port;
  const baseUrlRaw = String((cfg as any).local_llm_base_url || "").trim();

  const ctxSizeRaw = (cfg as any).llama_ctx_size;
  const threadsRaw = (cfg as any).llama_threads;
  const gpuLayersRaw = (cfg as any).llama_gpu_layers;

  let port = 8080;
  if (typeof portRaw === "number" && Number.isFinite(portRaw)) {
    port = Number(portRaw);
  } else {
    try {
      const u = new URL(baseUrlRaw || "http://127.0.0.1:8080/v1");
      const p = Number(u.port || 0);
      if (p > 0) port = p;
    } catch {}
  }

  const baseUrl = baseUrlRaw || `http://127.0.0.1:${port}/v1`;

  const ctxSize =
    typeof ctxSizeRaw === "number" && Number.isFinite(ctxSizeRaw)
      ? Math.max(256, Math.floor(ctxSizeRaw))
      : 4096;
  const threads =
    typeof threadsRaw === "number" && Number.isFinite(threadsRaw)
      ? Math.max(0, Math.floor(threadsRaw))
      : 0;
  const gpuLayers =
    typeof gpuLayersRaw === "number" && Number.isFinite(gpuLayersRaw)
      ? Math.max(-1, Math.floor(gpuLayersRaw))
      : -1;

  return {
    llama_server_exe: exe,
    llama_model_path: model,
    llama_port: port,
    local_llm_base_url: baseUrl,
    ctx_size: ctxSize,
    threads,
    gpu_layers: gpuLayers,
  };
}

function probeHttpOk(u: string, timeoutMs: number): Promise<void> {
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
        },
      );
      req.on("error", reject);
      req.on("timeout", () => req.destroy(new Error("timeout")));
      req.end();
    } catch (e) {
      reject(e);
    }
  });
}

async function waitForLlamaReady(
  baseUrl: string,
  timeoutMs: number,
): Promise<void> {
  const start = Date.now();
  const base = String(baseUrl || "")
    .trim()
    .replace(/\/$/, "");
  const u = `${base}/models`;
  while (true) {
    try {
      await probeHttpOk(u, 1200);
      return;
    } catch {}
    if (Date.now() - start > timeoutMs) {
      throw new Error(`llama-server not reachable: ${u}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function startLlamaServer(): Promise<LlamaServerState> {
  if (_llamaProc) {
    return _llamaState;
  }

  clearLlamaLogs();
  const cfg = getLlamaConfigFromDevConfig();
  const exe = cfg.llama_server_exe;
  const model = cfg.llama_model_path;
  const port = cfg.llama_port;
  const baseUrl = cfg.local_llm_base_url;

  if (!exe) {
    setLlamaState({ status: "error", error: "LLAMA_SERVER_EXE_EMPTY" });
    return _llamaState;
  }
  if (!existsSync(exe)) {
    setLlamaState({
      status: "error",
      error: `LLAMA_SERVER_EXE_NOT_FOUND:${exe}`,
    });
    return _llamaState;
  }
  if (!model) {
    setLlamaState({ status: "error", error: "LLAMA_MODEL_PATH_EMPTY" });
    return _llamaState;
  }
  if (!existsSync(model)) {
    setLlamaState({ status: "error", error: `LLAMA_MODEL_NOT_FOUND:${model}` });
    return _llamaState;
  }

  const argsList: string[] = [
    "--host",
    "127.0.0.1",
    "--port",
    String(port || 8080),
    "-m",
    model,
    "-c",
    String(cfg.ctx_size || 4096),
  ];
  if (cfg.threads > 0) {
    argsList.push("-t", String(cfg.threads));
  }
  if (cfg.gpu_layers >= 0) {
    argsList.push("-ngl", String(cfg.gpu_layers));
  }

  setLlamaState({
    status: "starting",
    pid: null,
    started_at: new Date().toISOString(),
    stopped_at: null,
    last_exit_code: null,
    last_signal: null,
    error: null,
  });

  try {
    _llamaProc = spawn(exe, argsList, {
      windowsHide: true,
    });
  } catch (e: any) {
    _llamaProc = null;
    setLlamaState({ status: "error", error: String(e?.message || e) });
    return _llamaState;
  }

  try {
    setLlamaState({ pid: _llamaProc.pid });
  } catch {}

  _llamaProc.stdout.on("data", (buf) => {
    _llamaStdoutBuf += String(buf || "");
    const r = drainLogBuffer(_llamaStdoutBuf, _llamaStdoutTail);
    _llamaStdoutBuf = r.buf;
    emitLlamaEvent("logs", { logs: getLlamaLogs() });
  });
  _llamaProc.stderr.on("data", (buf) => {
    _llamaStderrBuf += String(buf || "");
    const r = drainLogBuffer(_llamaStderrBuf, _llamaStderrTail);
    _llamaStderrBuf = r.buf;
    emitLlamaEvent("logs", { logs: getLlamaLogs() });
  });
  _llamaProc.on("exit", (code, sig) => {
    const exitCode = typeof code === "number" ? code : null;
    const signal = sig ? String(sig) : null;
    _llamaProc = null;
    setLlamaState({
      status: "exited",
      pid: null,
      stopped_at: new Date().toISOString(),
      last_exit_code: exitCode,
      last_signal: signal,
    });
  });

  try {
    await waitForLlamaReady(baseUrl, 60000);
    setLlamaState({ status: "running" });
  } catch (e: any) {
    setLlamaState({ status: "error", error: String(e?.message || e) });
    try {
      if (_llamaProc) {
        _llamaProc.kill();
      }
    } catch {}
  }

  return _llamaState;
}

async function stopLlamaServer(): Promise<LlamaServerState> {
  if (!_llamaProc) {
    setLlamaState({ status: "stopped", pid: null });
    return _llamaState;
  }

  setLlamaState({ status: "stopping" });

  try {
    _llamaProc.kill();
  } catch {}

  const start = Date.now();
  while (_llamaProc && Date.now() - start < 8000) {
    await new Promise((r) => setTimeout(r, 200));
  }

  if (_llamaProc) {
    try {
      _llamaProc.kill();
    } catch {}
  }

  if (!_llamaProc) {
    setLlamaState({
      status: "stopped",
      pid: null,
      stopped_at: new Date().toISOString(),
    });
  }
  return _llamaState;
}

async function restartLlamaServer(): Promise<LlamaServerState> {
  await stopLlamaServer();
  return await startLlamaServer();
}

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
    process.env.EDGE_VIDEO_AGENT_BACKEND_BASE_URL || "",
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

function applyCacheEnvFromDataDir(dataDir: string): void {
  const dd = String(dataDir || "").trim();
  if (!dd) return;
  process.env.EDGE_VIDEO_AGENT_DATA_DIR = dd;
  process.env.HF_HOME = join(dd, "hf");
  process.env.HF_HUB_CACHE = join(dd, "hf", "hub");
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function runPowerShell(command: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "powershell",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
      {
        windowsHide: true,
      },
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

async function runTaskKill(pid: number): Promise<void> {
  if (!pid || pid <= 0) return;
  if (process.platform !== "win32") return;
  await new Promise<void>((resolve) => {
    try {
      const child = spawn("taskkill.exe", ["/PID", String(pid), "/F", "/T"], {
        windowsHide: true,
      });
      child.on("error", () => resolve());
      child.on("exit", () => resolve());
    } catch {
      resolve();
    }
  });
}

async function stopBackendForQuit(): Promise<void> {
  if (!_backendProc) return;
  const pid = _backendProc.pid || 0;
  try {
    _backendProc.kill();
  } catch {}
  const start = Date.now();
  while (_backendProc && Date.now() - start < 8000) {
    await sleep(200);
  }
  if (_backendProc) {
    try {
      await runTaskKill(pid);
    } catch {}
    const start2 = Date.now();
    while (_backendProc && Date.now() - start2 < 8000) {
      await sleep(200);
    }
  }
  if (_backendProc) {
    try {
      _backendProc.kill();
    } catch {}
    _backendProc = null;
  }
}

async function stopLlamaForQuit(): Promise<void> {
  const pid = _llamaProc?.pid;
  await stopLlamaServer();
  if (_llamaProc && pid) {
    try {
      await runTaskKill(pid);
    } catch {}
    const start = Date.now();
    while (_llamaProc && Date.now() - start < 8000) {
      await sleep(200);
    }
  }
  if (_llamaProc) {
    try {
      _llamaProc.kill();
    } catch {}
    _llamaProc = null;
  }
}

async function prepareForUpdateInstall(): Promise<void> {
  try {
    await stopLlamaForQuit();
  } catch {}
  try {
    await stopBackendForQuit();
  } catch {}
  await sleep(300);
}

type DepsTaskKind = "llama_server" | "gguf_model";

type DepsTaskStatus =
  | "idle"
  | "downloading"
  | "extracting"
  | "done"
  | "cancelled"
  | "error";

type DepsTask = {
  id: string;
  kind: DepsTaskKind;
  status: DepsTaskStatus;
  label?: string;
  url?: string;
  transferred?: number;
  total?: number;
  bytes_per_second?: number;
  percent?: number;
  started_at?: string;
  finished_at?: string;
  dest_path?: string;
  error?: string;
  meta?: Record<string, unknown>;
};

let _depsTasks: Record<string, DepsTask> = {};
let _depsCancel: Record<string, (() => void) | undefined> = {};

function emitDepsEvent(type: string, payload: any): void {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("deps:event", { type, ...payload });
    }
  } catch {}
}

function getDepsState(): {
  tasks: DepsTask[];
  default_dirs: { data_dir: string; llama_server: string; gguf_models: string };
} {
  const dataDir = resolvePreferredDataDir() || getDefaultPackagedDataDir();
  return {
    tasks: Object.values(_depsTasks),
    default_dirs: {
      data_dir: dataDir,
      llama_server: join(dataDir, "deps", "llama.cpp"),
      gguf_models: join(dataDir, "models", "llm"),
    },
  };
}

function setDepsTask(id: string, patch: Partial<DepsTask>): DepsTask {
  const prev = _depsTasks[id];
  const kind = (patch.kind || prev?.kind) as DepsTaskKind | undefined;
  const status = (patch.status || prev?.status || "idle") as DepsTaskStatus;
  if (!kind) {
    throw new Error("TASK_KIND_REQUIRED");
  }
  const next: DepsTask = {
    ...prev,
    ...patch,
    id,
    kind,
    status,
  };
  _depsTasks = {
    ..._depsTasks,
    [id]: next,
  };
  emitDepsEvent("task", { task: next, state: getDepsState() });
  return next;
}

function sha256File(
  path: string,
  chunkSize: number = 1024 * 1024,
): Promise<string> {
  return new Promise((resolve, reject) => {
    try {
      const h = crypto.createHash("sha256");
      const s = createReadStream(path, { highWaterMark: chunkSize });
      s.on("data", (buf) => h.update(buf));
      s.on("error", reject);
      s.on("end", () => resolve(h.digest("hex")));
    } catch (e) {
      reject(e);
    }
  });
}

function safeEncodePathSegment(pathLike: string): string {
  return encodeURIComponent(String(pathLike || "").trim()).replace(
    /%2F/gi,
    "/",
  );
}

function findFileRecursive(root: string, targetName: string): string | null {
  const want = String(targetName || "").toLowerCase();
  if (!want) return null;
  try {
    const ents = readdirSync(root, { withFileTypes: true });
    for (const ent of ents) {
      const p = join(root, ent.name);
      if (ent.isFile() && String(ent.name || "").toLowerCase() === want) {
        return p;
      }
      if (ent.isDirectory()) {
        const hit = findFileRecursive(p, targetName);
        if (hit) return hit;
      }
    }
  } catch {}
  return null;
}

function httpDownloadToFile(opts: {
  url: string;
  destPath: string;
  headers?: Record<string, string>;
  onProgress?: (p: {
    transferred: number;
    total?: number;
    bytes_per_second?: number;
    percent?: number;
  }) => void;
  registerCancel?: (cancel: () => void) => void;
  timeoutMs?: number;
}): Promise<{ path: string }> {
  const url0 = String(opts.url || "").trim();
  const dest = String(opts.destPath || "").trim();
  const timeoutMs = typeof opts.timeoutMs === "number" ? opts.timeoutMs : 20000;
  if (!url0) return Promise.reject(new Error("EMPTY_URL"));
  if (!dest) return Promise.reject(new Error("EMPTY_DEST"));

  const part = dest + ".part";
  try {
    mkdirSync(dirname(dest), { recursive: true });
  } catch {}

  const doReq = (
    urlStr: string,
    redirectsLeft: number,
  ): Promise<{ path: string }> => {
    return new Promise((resolve, reject) => {
      let req: http.ClientRequest | null = null;
      let done = false;
      let transferred = 0;
      let total: number | undefined = undefined;
      const startedAt = Date.now();
      let lastTickAt = startedAt;
      let lastTickBytes = 0;

      const finish = (err?: any) => {
        if (done) return;
        done = true;
        if (err) {
          try {
            rmSync(part, { force: true });
          } catch {}
          reject(err);
        } else {
          resolve({ path: dest });
        }
      };

      const cancel = () => {
        try {
          finish(new Error("CANCELLED"));
        } catch {}
        try {
          req?.destroy(new Error("CANCELLED"));
        } catch {}
      };
      try {
        opts.registerCancel?.(cancel);
      } catch {}

      try {
        const url = new URL(urlStr);
        const mod = url.protocol === "https:" ? https : http;
        const port = url.port
          ? parseInt(url.port, 10)
          : url.protocol === "https:"
            ? 443
            : 80;

        req = mod.request(
          {
            method: "GET",
            host: url.hostname,
            port,
            path: `${url.pathname || "/"}${url.search || ""}`,
            timeout: timeoutMs,
            headers: {
              "User-Agent": "edge-video-agent",
              ...(opts.headers || {}),
            },
          },
          (res) => {
            const code = res.statusCode || 0;
            if (code >= 300 && code < 400 && res.headers.location) {
              if (redirectsLeft <= 0) {
                res.resume();
                finish(new Error("TOO_MANY_REDIRECTS"));
                return;
              }
              const nextUrl = new URL(res.headers.location, urlStr).toString();
              res.resume();
              doReq(nextUrl, redirectsLeft - 1)
                .then(resolve)
                .catch(reject);
              return;
            }
            if (code < 200 || code >= 300) {
              res.resume();
              finish(new Error(`HTTP_${code}`));
              return;
            }

            const len = parseInt(
              String(res.headers["content-length"] || "0"),
              10,
            );
            if (Number.isFinite(len) && len > 0) total = len;

            let file: ReturnType<typeof createWriteStream> | null = null;
            try {
              file = createWriteStream(part);
            } catch (e) {
              res.resume();
              finish(e);
              return;
            }

            file.on("error", (e) => {
              try {
                res.destroy();
              } catch {}
              finish(e);
            });

            res.on("data", (chunk) => {
              transferred += (chunk as any)?.length
                ? Number((chunk as any).length)
                : 0;

              const now = Date.now();
              const dt = Math.max(1, now - lastTickAt);
              const dBytes = transferred - lastTickBytes;
              if (dt >= 500) {
                lastTickAt = now;
                lastTickBytes = transferred;
                const bps = Math.max(0, Math.floor((dBytes * 1000) / dt));
                const percent = total
                  ? Math.max(0, Math.min(100, (transferred / total) * 100))
                  : undefined;
                try {
                  opts.onProgress?.({
                    transferred,
                    total,
                    bytes_per_second: bps,
                    percent,
                  });
                } catch {}
              }
            });

            res.on("error", (e) => finish(e));

            res.pipe(file);
            file.on("finish", () => {
              try {
                file?.close();
              } catch {}
              try {
                try {
                  rmSync(dest, { force: true });
                } catch {}
                renameSync(part, dest);
              } catch (e) {
                finish(e);
                return;
              }
              const elapsedMs = Math.max(1, Date.now() - startedAt);
              const bps = Math.max(
                0,
                Math.floor((transferred * 1000) / elapsedMs),
              );
              const percent = total
                ? Math.max(0, Math.min(100, (transferred / total) * 100))
                : undefined;
              try {
                opts.onProgress?.({
                  transferred,
                  total,
                  bytes_per_second: bps,
                  percent,
                });
              } catch {}
              finish();
            });
          },
        );
        req.on("error", (e) => finish(e));
        req.on("timeout", () => {
          try {
            req?.destroy(new Error("timeout"));
          } catch {}
        });
        req.end();
      } catch (e) {
        finish(e);
      }
    });
  };

  return doReq(url0, 5);
}

function pickLlamaCppAsset(
  assets: any[],
  flavor: "cpu" | "cuda",
): { name: string; url: string } | null {
  const arr = Array.isArray(assets) ? assets : [];
  const norm = (s: any) => String(s || "").toLowerCase();

  const candidates = arr
    .map((a) => {
      const name = String(a?.name || "").trim();
      const url = String(a?.browser_download_url || "").trim();
      if (!name || !url) return null;
      return { name, url, n: norm(name) };
    })
    .filter(Boolean) as Array<{ name: string; url: string; n: string }>;

  const isWinZipX64 = (n: string) =>
    n.includes("win") && n.includes("x64") && n.endsWith(".zip");
  const isCudartOnly = (n: string) =>
    n.startsWith("cudart-") || n.includes("cudart-llama");
  const isCuda = (n: string) => n.includes("cuda") || n.includes("cublas");
  const isCpu = (n: string) =>
    !isCuda(n) && !n.includes("rocm") && !n.includes("hip");
  const isLlamaBinaryZip = (n: string) =>
    n.includes("llama") && n.includes("bin") && !isCudartOnly(n);

  const filtered = candidates.filter((c) => isWinZipX64(c.n));
  if (flavor === "cpu") {
    return (
      filtered.find((c) => isLlamaBinaryZip(c.n) && isCpu(c.n)) ||
      filtered.find((c) => isLlamaBinaryZip(c.n)) ||
      filtered.find((c) => !isCudartOnly(c.n) && isCpu(c.n)) ||
      candidates.find((c) => isWinZipX64(c.n) && !isCudartOnly(c.n)) ||
      candidates.find((c) => c.n.endsWith(".zip") && !isCudartOnly(c.n)) ||
      null
    );
  }
  return (
    filtered.find((c) => isLlamaBinaryZip(c.n) && isCuda(c.n)) ||
    candidates.find(
      (c) => isLlamaBinaryZip(c.n) && isCuda(c.n) && c.n.endsWith(".zip"),
    ) ||
    candidates.find(
      (c) => isWinZipX64(c.n) && isCuda(c.n) && !isCudartOnly(c.n),
    ) ||
    candidates.find(
      (c) => c.n.endsWith(".zip") && isCuda(c.n) && !isCudartOnly(c.n),
    ) ||
    candidates.find((c) => isWinZipX64(c.n) && !isCudartOnly(c.n)) ||
    candidates.find((c) => c.n.endsWith(".zip") && !isCudartOnly(c.n)) ||
    null
  );
}

async function downloadAndInstallLlamaServer(opts: {
  taskId: string;
  flavor: "cpu" | "cuda";
  destDir?: string;
}): Promise<{ ok: boolean; exe_path?: string; error?: string }> {
  const taskId = String(opts.taskId || "").trim();
  const dataDir = resolvePreferredDataDir() || getDefaultPackagedDataDir();
  const destDir =
    String(opts.destDir || "").trim() || join(dataDir, "deps", "llama.cpp");
  const flavor = opts.flavor;
  setDepsTask(taskId, {
    kind: "llama_server",
    status: "downloading",
    label: `llama-server (${flavor})`,
    started_at: new Date().toISOString(),
    error: undefined,
    finished_at: undefined,
  });

  try {
    const rel = await httpGetJson(
      "https://api.github.com/repos/ggml-org/llama.cpp/releases/latest",
      20000,
    );
    const tag = String(rel?.tag_name || "").trim();
    const assets = Array.isArray(rel?.assets) ? (rel.assets as any[]) : [];
    const pick = pickLlamaCppAsset(assets, flavor);
    if (!pick) {
      throw new Error("NO_RELEASE_ASSET");
    }

    setDepsTask(taskId, {
      url: pick.url,
      meta: {
        release_tag: tag,
        asset_name: pick.name,
      },
    });

    const tmpRoot = join(app.getPath("temp"), "edge-video-agent-deps");
    const zipPath = join(tmpRoot, `llama_cpp_${tag}_${flavor}.zip`);
    const extractDir = join(tmpRoot, `llama_cpp_extract_${taskId}`);

    setDepsTask(taskId, {
      meta: {
        ...((_depsTasks[taskId]?.meta || {}) as Record<string, unknown>),
        tmp_root: tmpRoot,
        zip_path: zipPath,
        extract_dir: extractDir,
        install_dir: destDir,
      },
    });
    try {
      mkdirSync(tmpRoot, { recursive: true });
    } catch {}
    try {
      rmSync(extractDir, { recursive: true, force: true });
    } catch {}
    try {
      mkdirSync(extractDir, { recursive: true });
    } catch {}

    await httpDownloadToFile({
      url: pick.url,
      destPath: zipPath,
      onProgress: (p) => {
        setDepsTask(taskId, {
          status: "downloading",
          transferred: p.transferred,
          total: p.total,
          bytes_per_second: p.bytes_per_second,
          percent: p.percent,
        });
      },
      registerCancel: (cancel) => {
        _depsCancel[taskId] = cancel;
      },
      timeoutMs: 30000,
    });

    setDepsTask(taskId, { status: "extracting" });
    const cmd = `Expand-Archive -Path ${psQuote(zipPath)} -DestinationPath ${psQuote(
      extractDir,
    )} -Force`;
    await runPowerShell(cmd);

    const exeFound = findFileRecursive(extractDir, "llama-server.exe");
    if (!exeFound) {
      setDepsTask(taskId, { dest_path: extractDir });
      throw new Error("LLAMA_SERVER_EXE_NOT_FOUND_IN_ZIP");
    }

    const targetExe = join(destDir, tag, "llama-server.exe");
    try {
      mkdirSync(dirname(targetExe), { recursive: true });
    } catch {}
    copyFileSync(exeFound, targetExe);

    const cfg = readDevConfig();
    const merged = {
      ...(cfg || {}),
      llama_server_exe: targetExe,
    } as Record<string, unknown>;
    writeDevConfig(merged);

    try {
      rmSync(extractDir, { recursive: true, force: true });
    } catch {}
    try {
      rmSync(zipPath, { force: true });
    } catch {}

    setDepsTask(taskId, {
      status: "done",
      finished_at: new Date().toISOString(),
      dest_path: targetExe,
      transferred: undefined,
      total: undefined,
      bytes_per_second: undefined,
      percent: undefined,
    });
    return { ok: true, exe_path: targetExe };
  } catch (e: any) {
    const msg = e && e.message ? String(e.message) : String(e);
    setDepsTask(taskId, {
      status: msg === "CANCELLED" ? "cancelled" : "error",
      finished_at: new Date().toISOString(),
      error: msg,
    });
    return { ok: false, error: msg };
  } finally {
    try {
      delete _depsCancel[taskId];
    } catch {}
  }
}

async function ensureDataDirSelectedAndMigrated(): Promise<void> {
  if (!app.isPackaged) {
    return;
  }

  const env = String(process.env.EDGE_VIDEO_AGENT_DATA_DIR || "").trim();
  if (env) {
    applyCacheEnvFromDataDir(env);
    try {
      mkdirSync(env, { recursive: true });
    } catch {}
    return;
  }

  const cfg = readDataDirConfig();
  const cfgDir = String(cfg.data_dir || "").trim();
  if (cfgDir) {
    applyCacheEnvFromDataDir(cfgDir);
    try {
      mkdirSync(cfgDir, { recursive: true });
    } catch {}
    return;
  }

  const newDir = getDefaultPackagedDataDir();
  const oldDir = join(os.homedir(), ".edge-video-agent");

  const oldExists = existsSync(oldDir) && !isDirEmpty(oldDir);
  const newEmpty = isDirEmpty(newDir);

  let selectedDir: string | null = null;
  let migratedFromOld = false;

  if (oldExists && newEmpty) {
    const res = await dialog.showMessageBox({
      type: "question",
      buttons: [
        "\u590d\u5236\u8fc1\u79fb\u65e7\u76ee\u5f55\uff08\u63a8\u8350\uff09",
        "\u7ee7\u7eed\u4f7f\u7528\u65e7\u76ee\u5f55",
        "\u9009\u62e9\u5176\u4ed6\u76ee\u5f55...",
        "\u9000\u51fa",
      ],
      defaultId: 0,
      cancelId: 3,
      message:
        "\u8bf7\u9009\u62e9\u7f13\u5b58\u4e0e\u6570\u636e\u76ee\u5f55\uff08\u9996\u6b21\u542f\u52a8\u5fc5\u9009\uff09",
      detail: `\u9ed8\u8ba4\uff1a${newDir}\n\n\u68c0\u6d4b\u5230\u65e7\u7248\u76ee\u5f55\uff1a${oldDir}`,
    });

    if (res.response === 0) {
      selectedDir = newDir;
      try {
        mkdirSync(newDir, { recursive: true });
        copyDirRecursive(oldDir, newDir);
        migratedFromOld = true;
      } catch (e: any) {
        const msg = e && e.message ? String(e.message) : String(e);
        await dialog.showMessageBox({
          type: "error",
          message:
            "\u8fc1\u79fb\u5931\u8d25\uff0c\u5c06\u4f7f\u7528\u65e7\u76ee\u5f55\u8fd0\u884c\u3002",
          detail: msg,
        });
        selectedDir = oldDir;
        migratedFromOld = false;
      }
    } else if (res.response === 1) {
      selectedDir = oldDir;
    } else if (res.response === 2) {
      const pick = await dialog.showOpenDialog({
        title: "\u9009\u62e9\u6570\u636e\u76ee\u5f55",
        properties: ["openDirectory"],
      });
      if (!pick.canceled && pick.filePaths.length > 0) {
        selectedDir = String(pick.filePaths[0] || "").trim();
      }
    }
  }

  while (!selectedDir) {
    const res = await dialog.showMessageBox({
      type: "question",
      buttons: [
        "\u4f7f\u7528\u9ed8\u8ba4\u76ee\u5f55\uff08C \u76d8\uff09",
        "\u9009\u62e9\u5176\u4ed6\u76ee\u5f55...",
        "\u9000\u51fa",
      ],
      defaultId: 0,
      cancelId: 2,
      message:
        "\u8bf7\u9009\u62e9\u7f13\u5b58\u4e0e\u6570\u636e\u76ee\u5f55\uff08\u9996\u6b21\u542f\u52a8\u5fc5\u9009\uff09",
      detail: `\u9ed8\u8ba4\uff1a${newDir}\n\n\u8be5\u76ee\u5f55\u5c06\u7528\u4e8e\u6570\u636e\u5e93\u3001\u7d22\u5f15\u3001\u6a21\u578b\u7f13\u5b58\u7b49\uff0c\u53ef\u80fd\u5360\u7528\u8f83\u5927\u7a7a\u95f4\u3002`,
    });

    if (res.response === 0) {
      selectedDir = newDir;
      break;
    }

    if (res.response === 1) {
      const pick = await dialog.showOpenDialog({
        title: "\u9009\u62e9\u6570\u636e\u76ee\u5f55",
        properties: ["openDirectory"],
      });
      if (!pick.canceled && pick.filePaths.length > 0) {
        selectedDir = String(pick.filePaths[0] || "").trim();
        break;
      }
      continue;
    }

    try {
      app.quit();
    } catch {}
    throw new Error("DATA_DIR_REQUIRED");
  }

  try {
    mkdirSync(selectedDir, { recursive: true });
  } catch {}

  if (oldExists && selectedDir !== oldDir && !migratedFromOld) {
    try {
      const targetEmpty = isDirEmpty(selectedDir);
      if (targetEmpty) {
        const mig = await dialog.showMessageBox({
          type: "question",
          buttons: [
            "\u590d\u5236\u65e7\u6570\u636e\u5230\u6b64\u76ee\u5f55",
            "\u4e0d\u590d\u5236",
          ],
          defaultId: 0,
          cancelId: 1,
          message:
            "\u68c0\u6d4b\u5230\u65e7\u7248\u6570\u636e\uff0c\u662f\u5426\u590d\u5236\u5230\u65b0\u76ee\u5f55\uff1f",
          detail: `\u65e7\u76ee\u5f55\uff1a${oldDir}\n\n\u76ee\u6807\u76ee\u5f55\uff1a${selectedDir}`,
        });
        if (mig.response === 0) {
          copyDirRecursive(oldDir, selectedDir);
          migratedFromOld = true;
        }
      }
    } catch {}
  }

  applyCacheEnvFromDataDir(selectedDir);
  writeDataDirConfig({ data_dir: selectedDir });

  if (migratedFromOld) {
    try {
      const del = await dialog.showMessageBox({
        type: "question",
        buttons: ["\u4e0d\u5220\u9664", "\u5220\u9664\u65e7\u76ee\u5f55"],
        defaultId: 0,
        cancelId: 0,
        message:
          "\u5df2\u590d\u5236\u8fc1\u79fb\u65e7\u6570\u636e\u3002\u662f\u5426\u5220\u9664\u65e7\u76ee\u5f55\u4ee5\u91ca\u653e\u7a7a\u95f4\uff1f",
        detail: `\u65e7\u76ee\u5f55\uff1a${oldDir}`,
      });
      if (del.response === 1) {
        try {
          rmSync(oldDir, { recursive: true, force: true });
        } catch {}
      }
    } catch {}
  }
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
      const a = join(
        rp,
        "backend",
        "edge-video-agent-backend",
        "edge-video-agent-backend.exe",
      );
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
      "edge-video-agent-backend.exe",
    );
    candidates.push({ exePath: staged, cwd: dirname(staged) });
    const p = join(
      repoRoot,
      "artifacts",
      "pyinstaller_backend",
      "dist",
      "edge-video-agent-backend",
      "edge-video-agent-backend.exe",
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
        },
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
    process.env.EDGE_VIDEO_AGENT_AUTO_START_BACKEND || "",
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
      "",
  ).trim();

  const env = {
    ...process.env,
    EDGE_VIDEO_AGENT_DISABLE_WORKER: String(
      process.env.EDGE_VIDEO_AGENT_DISABLE_WORKER || "",
    ),
    EDGE_VIDEO_AGENT_HOST: String(
      process.env.EDGE_VIDEO_AGENT_HOST || "127.0.0.1",
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
      env.EDGE_VIDEO_AGENT_BACKEND_PORT,
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
      env.EDGE_VIDEO_AGENT_BACKEND_PORT,
    );
    _backendProc = spawn(pythonExe, ["-m", "app.main"], {
      cwd: backendDir,
      env,
      windowsHide: true,
    });
  }

  _backendProc.stdout.on("data", (buf) =>
    console.log("[backend]", String(buf)),
  );
  _backendProc.stderr.on("data", (buf) =>
    console.error("[backend]", String(buf)),
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
      "Caria-Tarnished/Edge-AI-Video-Summarizer",
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
      mainWindow.webContents.send("updater:event", {
        type: "state",
        state: _updaterState,
      });
    }
  } catch {}
}

function initAutoUpdater(): void {
  const disabled = String(
    process.env.EDGE_VIDEO_AGENT_DISABLE_AUTO_UPDATE || "",
  ).trim();
  const supported =
    app.isPackaged && !(disabled === "1" || disabled.toLowerCase() === "true");

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
      release_url: next
        ? buildReleaseUrlFromVersion(next)
        : _updaterState.release_url,
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
        transferred:
          typeof p?.transferred === "number" ? p.transferred : undefined,
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
      release_url:
        (next ? buildReleaseUrlFromVersion(next) : "") ||
        _updaterState.release_url,
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
  const preNum =
    preNumRaw && /^\d+$/.test(preNumRaw) ? parseInt(preNumRaw, 10) : undefined;
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
        },
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
      "Caria-Tarnished/Edge-AI-Video-Summarizer",
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
        12000,
      );
      const arr = Array.isArray(list) ? list : [];
      rel =
        arr.find((r) => r && typeof r === "object" && (r as any).prerelease) ||
        arr.find((r) => r && typeof r === "object" && !(r as any).prerelease) ||
        null;
    } else {
      rel = await httpGetJson(
        `https://api.github.com/repos/${repo}/releases/latest`,
        12000,
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
      curSv && latSv
        ? compareSemVer(latSv, curSv) > 0
        : latestVersion !== current;

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
        },
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
  try {
    await ensureDataDirSelectedAndMigrated();
  } catch {
    try {
      app.quit();
    } catch {}
    return;
  }
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
        console.error("[main] window.electronAPI probe failed:", e),
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
            </body></html>`,
          ),
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

ipcMain.handle("dialog:openDirectory", async () => {
  const res = await dialog.showOpenDialog({
    properties: ["openDirectory"],
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

ipcMain.handle("deps:getState", async () => {
  return getDepsState();
});

ipcMain.handle("deps:cancel", async (_evt, taskId: any) => {
  const id = String(taskId || "").trim();
  const fn = _depsCancel[id];
  if (!id || !fn) {
    return { ok: false, error: "NO_SUCH_TASK" };
  }
  try {
    fn();
  } catch {}
  return { ok: true };
});

ipcMain.handle(
  "deps:downloadLlamaServer",
  async (_evt, args: { flavor?: any; destDir?: any } | null) => {
    const id = `llama_${Date.now()}`;
    const flavor =
      String(args?.flavor || "cpu").toLowerCase() === "cuda" ? "cuda" : "cpu";
    const destDir = String(args?.destDir || "").trim() || undefined;
    void downloadAndInstallLlamaServer({
      taskId: id,
      flavor,
      destDir,
    }).catch(() => {});
    return { ok: true, task_id: id, state: getDepsState() };
  },
);

ipcMain.handle(
  "deps:downloadGgufPreset",
  async (
    _evt,
    args: {
      slot?: any;
      repoId?: any;
      filename?: any;
      destDir?: any;
    } | null,
  ) => {
    const id = `gguf_${Date.now()}`;
    const slotRaw = String(args?.slot || "q4").toLowerCase();
    const slot = slotRaw === "q5" ? "q5" : slotRaw === "small" ? "small" : "q4";
    const repoId = String(args?.repoId || "").trim();
    const filename = String(args?.filename || "").trim() || undefined;
    const destDir = String(args?.destDir || "").trim() || undefined;
    void downloadGgufPreset({
      taskId: id,
      slot,
      repoId,
      filename,
      destDir,
    }).catch(() => {
    });
    return { ok: true, task_id: id, state: getDepsState() };
  },
);

ipcMain.handle("llama:getState", async () => {
  return {
    state: _llamaState,
    logs: getLlamaLogs(),
  };
});

ipcMain.handle("llama:getLogs", async () => {
  return {
    logs: getLlamaLogs(),
  };
});

ipcMain.handle("llama:clearLogs", async () => {
  clearLlamaLogs();
  emitLlamaEvent("logs", { logs: getLlamaLogs() });
  return { ok: true };
});

ipcMain.handle("llama:start", async () => {
  const state = await startLlamaServer();
  return { state, logs: getLlamaLogs() };
});

ipcMain.handle("llama:stop", async () => {
  const state = await stopLlamaServer();
  return { state, logs: getLlamaLogs() };
});

ipcMain.handle("llama:restart", async () => {
  const state = await restartLlamaServer();
  return { state, logs: getLlamaLogs() };
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
    await prepareForUpdateInstall();
    setTimeout(() => {
      try {
        autoUpdater.quitAndInstall(true, true);
      } catch {}
    }, 200);
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
      dataDir,
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
    message:
      "\u6062\u590d\u5907\u4efd\u5c06\u8986\u76d6\u5f53\u524d\u6570\u636e\u3002\u662f\u5426\u7ee7\u7eed\uff1f",
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
      zipPath,
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
    try {
      if (_llamaProc) {
        _llamaProc.kill();
        _llamaProc = null;
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
  try {
    if (_llamaProc) {
      _llamaProc.kill();
      _llamaProc = null;
    }
  } catch {}
});
