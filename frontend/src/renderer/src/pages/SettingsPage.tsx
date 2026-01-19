import { useCallback, useEffect, useMemo, useState } from "react";
import type { ChangeEvent } from "react";
import {
  api,
  AsrModelStatusResponse,
  DiagnosticsResponse,
  LlmLocalStatusResponse,
  RuntimeProfileResponse,
} from "../api/backend";

type UiLang = "zh" | "en";

type Props = {
  uiLang?: UiLang;
};

type RuntimeDraft = {
  profile?: string;
  asr_concurrency?: number;
  llm_concurrency?: number;
  heavy_concurrency?: number;
  llm_timeout_seconds?: number;
  asr_model?: string;
  asr_device?: string;
  asr_compute_type?: string;
};

type LlmDraft = {
  provider?: string;
  model?: string | null;
  temperature?: number;
  max_tokens?: number;
  output_language?: string;
};

type DevConfigDraft = {
  llama_server_exe?: string;
  llama_model_path?: string;
  llama_model_slot?: string;
  llama_model_q4_path?: string;
  llama_model_q5_path?: string;
  llama_model_small_path?: string;
  llama_port?: number;
  local_llm_base_url?: string;
  backend_base_url?: string;
};

type LlamaState = {
  status?: string;
  pid?: number | null;
  started_at?: string | null;
  stopped_at?: string | null;
  last_exit_code?: number | null;
  last_signal?: string | null;
  error?: string | null;
};

type LlamaLogs = {
  stdout?: string[];
  stderr?: string[];
};

type DepsTask = {
  id: string;
  kind: string;
  status: string;
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

type DepsState = {
  tasks?: DepsTask[];
  default_dirs?: { data_dir: string; llama_server: string; gguf_models: string };
};

function toNumberOrUndefined(v: string): number | undefined {
  const s = (v ?? "").trim();
  if (!s) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

function formatBytes(n?: number): string {
  const v = typeof n === "number" && Number.isFinite(n) ? n : 0;
  if (!v || v < 0) return "0";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let x = v;
  let i = 0;
  while (x >= 1024 && i < units.length - 1) {
    x /= 1024;
    i += 1;
  }
  return `${x.toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

export default function SettingsPage({ uiLang = "zh" }: Props) {
  const [runtime, setRuntime] = useState<RuntimeProfileResponse | null>(null);
  const [runtimeDraft, setRuntimeDraft] = useState<RuntimeDraft>({});
  const [llmDraft, setLlmDraft] = useState<LlmDraft>({});
  const [providers, setProviders] = useState<string[]>([]);
  const [localStatus, setLocalStatus] = useState<LlmLocalStatusResponse | null>(
    null
  );

  const [asrStatus, setAsrStatus] = useState<AsrModelStatusResponse | null>(null);
  const [diagnostics, setDiagnostics] = useState<DiagnosticsResponse | null>(null);

  const [devConfigPath, setDevConfigPath] = useState<string | null>(null);
  const [devConfigDraft, setDevConfigDraft] = useState<DevConfigDraft>({});

  const [llamaState, setLlamaState] = useState<LlamaState | null>(null);
  const [llamaLogs, setLlamaLogs] = useState<LlamaLogs | null>(null);

  const [depsState, setDepsState] = useState<DepsState | null>(null);
  const [depsLlamaDir, setDepsLlamaDir] = useState<string>("");
  const [depsGgufDir, setDepsGgufDir] = useState<string>("");

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const [appVersion, setAppVersion] = useState<
    { version: string; is_packaged: boolean } | null
  >(null);
  const [updateCheck, setUpdateCheck] = useState<any>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [updateInfo, setUpdateInfo] = useState<string | null>(null);

  const [updaterState, setUpdaterState] = useState<any>(null);

  const openFirstRunWizard = useCallback(
    (resetCompletedFlag: boolean) => {
      try {
        localStorage.setItem("route_override", "wizard");
        if (resetCompletedFlag) {
          localStorage.setItem("first_run_wizard_completed", "0");
        }
      } catch {
      }
      window.location.reload();
    },
    []
  );

  const copyText = useCallback(
    async (text: string, okMsg: string) => {
      try {
        await navigator.clipboard.writeText(text);
        setInfo(okMsg);
      } catch {
        window.prompt(uiLang === "en" ? "Copy the text:" : "复制以下内容：", text);
      }
    },
    [uiLang]
  );

  const exportDataZip = useCallback(async () => {
    if (!window.electronAPI?.exportDataZip) {
      setError(
        uiLang === "en"
          ? "Not running in Electron; cannot export data."
          : "\u5f53\u524d\u4e0d\u662f Electron \u73af\u5883\uff0c\u65e0\u6cd5\u5bfc\u51fa\u6570\u636e\u3002"
      );
      return;
    }
    setError(null);
    setInfo(null);
    setBusy(uiLang === "en" ? "Exporting..." : "\u6b63\u5728\u5bfc\u51fa..."
    );
    try {
      const res: any = await window.electronAPI.exportDataZip();
      if (res && res.cancelled) {
        setInfo(uiLang === "en" ? "Cancelled" : "\u5df2\u53d6\u6d88");
        return;
      }
      if (res && res.ok) {
        setInfo(
          uiLang === "en"
            ? `Exported: ${String(res.path || "")}`
            : `\u5df2\u5bfc\u51fa\uff1a${String(res.path || "")}`
        );
        return;
      }
      setError(String(res?.error || "EXPORT_FAILED"));
    } catch (e: any) {
      setError(e && e.message ? String(e.message) : String(e));
    } finally {
      setBusy(null);
    }
  }, [uiLang]);

  const updaterCheck = useCallback(async () => {
    setUpdateError(null);
    setUpdateInfo(null);
    if (!window.electronAPI?.updaterCheck) {
      setUpdateError("UPDATER_API_MISSING");
      return;
    }
    setBusy("updater_check");
    try {
      const res = await window.electronAPI.updaterCheck();
      if (res && res.state) setUpdaterState(res.state);
      if (res && res.ok) {
        setUpdateInfo(
          uiLang === "en" ? "Checked." : "\u5df2\u68c0\u67e5\u66f4\u65b0\u3002"
        );
      } else {
        setUpdateError(String(res?.error || "CHECK_FAILED"));
      }
    } catch (e: any) {
      setUpdateError(e && e.message ? String(e.message) : String(e));
    } finally {
      setBusy(null);
    }
  }, [uiLang]);

  const updaterDownload = useCallback(async () => {
    setUpdateError(null);
    setUpdateInfo(null);
    if (!window.electronAPI?.updaterDownload) {
      setUpdateError("UPDATER_API_MISSING");
      return;
    }
    setBusy("updater_download");
    try {
      const res = await window.electronAPI.updaterDownload();
      if (res && res.state) setUpdaterState(res.state);
      if (res && res.ok) {
        setUpdateInfo(
          uiLang === "en"
            ? "Downloading..."
            : "\u5f00\u59cb\u4e0b\u8f7d..."
        );
      } else {
        setUpdateError(String(res?.error || "DOWNLOAD_FAILED"));
      }
    } catch (e: any) {
      setUpdateError(e && e.message ? String(e.message) : String(e));
    } finally {
      setBusy(null);
    }
  }, [uiLang]);

  const updaterUpdateNow = useCallback(async () => {
    setUpdateError(null);
    setUpdateInfo(null);
    if (!window.electronAPI?.updaterDownload || !window.electronAPI?.updaterInstall) {
      setUpdateError("UPDATER_API_MISSING");
      return;
    }
    setBusy("updater_update_now");
    try {
      const dl = await window.electronAPI.updaterDownload();
      if (dl && dl.state) setUpdaterState(dl.state);
      if (!dl || !dl.ok) {
        setUpdateError(String(dl?.error || "DOWNLOAD_FAILED"));
        return;
      }

      const ins = await window.electronAPI.updaterInstall();
      if (ins && ins.ok) {
        setUpdateInfo(
          uiLang === "en"
            ? "Installing update..."
            : "\u6b63\u5728\u5b89\u88c5\u66f4\u65b0\uff0c\u7a0b\u5e8f\u5373\u5c06\u91cd\u542f..."
        );
      } else {
        setUpdateError(String(ins?.error || "INSTALL_FAILED"));
      }
    } catch (e: any) {
      setUpdateError(e && e.message ? String(e.message) : String(e));
    } finally {
      setBusy(null);
    }
  }, [uiLang]);

  const updaterInstall = useCallback(async () => {
    setUpdateError(null);
    setUpdateInfo(null);
    if (!window.electronAPI?.updaterInstall) {
      setUpdateError("UPDATER_API_MISSING");
      return;
    }
    setBusy("updater_install");
    try {
      const res = await window.electronAPI.updaterInstall();
      if (res && res.ok) {
        setUpdateInfo(
          uiLang === "en"
            ? "Installing update..."
            : "\u6b63\u5728\u5b89\u88c5\u66f4\u65b0\uff0c\u7a0b\u5e8f\u5373\u5c06\u91cd\u542f..."
        );
      } else {
        setUpdateError(String(res?.error || "INSTALL_FAILED"));
      }
    } catch (e: any) {
      setUpdateError(e && e.message ? String(e.message) : String(e));
    } finally {
      setBusy(null);
    }
  }, [uiLang]);

  const restoreDataZip = useCallback(async () => {
    if (!window.electronAPI?.restoreDataZip) {
      setError(
        uiLang === "en"
          ? "Not running in Electron; cannot restore data."
          : "\u5f53\u524d\u4e0d\u662f Electron \u73af\u5883\uff0c\u65e0\u6cd5\u6062\u590d\u6570\u636e\u3002"
      );
      return;
    }
    setError(null);
    setInfo(null);
    setBusy(uiLang === "en" ? "Restoring..." : "\u6b63\u5728\u6062\u590d..."
    );
    try {
      const res: any = await window.electronAPI.restoreDataZip();
      if (res && res.cancelled) {
        setInfo(uiLang === "en" ? "Cancelled" : "\u5df2\u53d6\u6d88");
        return;
      }
      if (res && res.ok) {
        setInfo(
          uiLang === "en"
            ? `Restored: ${String(res.path || "")}`
            : `\u5df2\u6062\u590d\uff1a${String(res.path || "")}`
        );
        return;
      }
      setError(String(res?.error || "RESTORE_FAILED"));
    } catch (e: any) {
      setError(e && e.message ? String(e.message) : String(e));
    } finally {
      setBusy(null);
    }
  }, [uiLang]);

  const t = useCallback(
    (
      key:
        | "settings"
        | "backend_hint"
        | "refresh_all"
        | "runtime_profile"
        | "save_runtime"
        | "default_llm"
        | "save_default_llm"
        | "output_language"
        | "local_status"
        | "refresh_status"
        | "local_launch_config"
        | "save_local_launch"
        | "pick_file"
        | "not_electron"
        | "no_status_yet"
        | "asr_model_status"
        | "refresh_asr_status"
        | "asr_large_v3"
        | "diagnostics"
        | "refresh_diagnostics"
    ) => {
      if (uiLang === "en") {
        if (key === "settings") return "Settings";
        if (key === "backend_hint")
          return "Backend: please start backend first (default http://127.0.0.1:8001)";
        if (key === "refresh_all") return "Refresh";
        if (key === "runtime_profile") return "Runtime Profile";
        if (key === "save_runtime") return "Save runtime profile";
        if (key === "default_llm") return "Default LLM Preferences";
        if (key === "save_default_llm") return "Save default LLM preferences";
        if (key === "output_language") return "Output language";
        if (key === "local_status") return "Local llama-server status";
        if (key === "refresh_status") return "Refresh status";
        if (key === "local_launch_config")
          return "Local llama-server launch config";
        if (key === "save_local_launch") return "Save local launch config";
        if (key === "pick_file") return "Pick file";
        if (key === "not_electron")
          return "Not running in Electron (or preload disabled); cannot save launch config.";
        if (key === "no_status_yet")
          return 'Status not loaded (click "Refresh status")';
        if (key === "asr_model_status") return "ASR model status";
        if (key === "refresh_asr_status") return "Refresh ASR status";
        if (key === "asr_large_v3") return "large-v3";
        if (key === "diagnostics") return "Diagnostics";
        if (key === "refresh_diagnostics") return "Refresh diagnostics";
      }
      if (key === "settings") return "\u8bbe\u7f6e";
      if (key === "backend_hint")
        return "\u540e\u7aef\uff1a\u8bf7\u5148\u542f\u52a8 backend\uff08\u9ed8\u8ba4 http://127.0.0.1:8001\uff09";
      if (key === "refresh_all") return "\u5237\u65b0\u5168\u90e8";
      if (key === "runtime_profile")
        return "\u8fd0\u884c\u65f6\u914d\u7f6e\uff08Runtime Profile\uff09";
      if (key === "save_runtime")
        return "\u4fdd\u5b58\u8fd0\u884c\u65f6\u914d\u7f6e";
      if (key === "default_llm") return "\u9ed8\u8ba4 LLM \u504f\u597d";
      if (key === "save_default_llm")
        return "\u4fdd\u5b58\u9ed8\u8ba4 LLM \u504f\u597d";
      if (key === "output_language") return "\u8f93\u51fa\u8bed\u8a00";
      if (key === "local_status")
        return "\u672c\u5730 llama-server \u72b6\u6001";
      if (key === "refresh_status") return "\u5237\u65b0\u72b6\u6001";
      if (key === "local_launch_config")
        return "\u672c\u5730 llama-server \u542f\u52a8\u914d\u7f6e";
      if (key === "save_local_launch")
        return "\u4fdd\u5b58\u672c\u5730\u542f\u52a8\u914d\u7f6e";
      if (key === "pick_file") return "\u9009\u62e9\u6587\u4ef6";
      if (key === "not_electron")
        return "\u5f53\u524d\u4e0d\u662f Electron \u73af\u5883\uff08\u6216 preload \u672a\u542f\u7528\uff09\uff0c\u6b64\u5904\u65e0\u6cd5\u4fdd\u5b58\u542f\u52a8\u914d\u7f6e\u3002";
      if (key === "asr_model_status") return "ASR \u6a21\u578b\u72b6\u6001";
      if (key === "refresh_asr_status") return "\u5237\u65b0 ASR \u72b6\u6001";
      if (key === "asr_large_v3") return "large-v3";
      if (key === "diagnostics") return "\u81ea\u68c0 / \u6392\u969c";
      if (key === "refresh_diagnostics")
        return "\u5237\u65b0\u81ea\u68c0\u4fe1\u606f";
      return "\u5c1a\u672a\u83b7\u53d6\u72b6\u6001\uff08\u70b9\u51fb\u201c\u5237\u65b0\u72b6\u6001\u201d\uff09";
    },
    [uiLang]
  );

  const loadAll = useCallback(async () => {
    setError(null);
    setInfo(null);
    setBusy("loading");
    try {
      const [rt, llm, prov, status, asr, diag, devCfg, ver, llama, deps] = await Promise.all([
        api.getRuntimeProfile(),
        api.getDefaultLlmPreferences(),
        api.listLlmProviders(),
        api.getLocalLlmStatus().catch(() => null),
        api.getAsrModelStatus().catch(() => null),
        api.getDiagnostics().catch(() => null),
        window.electronAPI?.getDevConfig
          ? window.electronAPI.getDevConfig().catch(() => null)
          : Promise.resolve(null),
        window.electronAPI?.getAppVersion
          ? window.electronAPI.getAppVersion().catch(() => null)
          : Promise.resolve(null),
        window.electronAPI?.llamaGetState
          ? window.electronAPI.llamaGetState().catch(() => null)
          : Promise.resolve(null),
        window.electronAPI?.depsGetState
          ? window.electronAPI.depsGetState().catch(() => null)
          : Promise.resolve(null),
      ]);

      setRuntime(rt);
      setAppVersion(ver);
      const rawProfile = String((rt.preferences as any)?.profile ?? "balanced");
      const normalizedProfile =
        rawProfile === "gpu" ? "gpu_recommended" : rawProfile;
      setRuntimeDraft({
        profile: normalizedProfile,
        asr_concurrency: (rt.preferences as any)?.asr_concurrency,
        llm_concurrency: (rt.preferences as any)?.llm_concurrency,
        heavy_concurrency: (rt.preferences as any)?.heavy_concurrency,
        llm_timeout_seconds: (rt.preferences as any)?.llm_timeout_seconds,
        asr_model: String((rt.preferences as any)?.asr_model ?? ""),
        asr_device: (rt.preferences as any)?.asr_device,
        asr_compute_type: (rt.preferences as any)?.asr_compute_type,
      });

      setLlmDraft({
        provider: llm.preferences?.provider ?? "fake",
        model: llm.preferences?.model ?? null,
        temperature: llm.preferences?.temperature ?? 0.2,
        max_tokens: llm.preferences?.max_tokens ?? 512,
        output_language: llm.preferences?.output_language ?? "zh",
      });

      setProviders(prov.providers || []);
      if (status) {
        setLocalStatus(status);
      }

      if (asr && typeof asr === "object") {
        setAsrStatus(asr as AsrModelStatusResponse);
      }

      if (diag && typeof diag === "object") {
        setDiagnostics(diag as DiagnosticsResponse);
      }

      if (devCfg && typeof devCfg === "object") {
        const p = String((devCfg as any).path || "").trim();
        const cfg = ((devCfg as any).config || {}) as Record<string, unknown>;
        setDevConfigPath(p || null);
        setDevConfigDraft({
          llama_server_exe: String(cfg.llama_server_exe || ""),
          llama_model_path: String(cfg.llama_model_path || ""),
          llama_model_slot: String(cfg.llama_model_slot || ""),
          llama_model_q4_path: String(cfg.llama_model_q4_path || ""),
          llama_model_q5_path: String(cfg.llama_model_q5_path || ""),
          llama_model_small_path: String(cfg.llama_model_small_path || ""),
          llama_port:
            typeof cfg.llama_port === "number"
              ? (cfg.llama_port as number)
              : undefined,
          local_llm_base_url: String(cfg.local_llm_base_url || ""),
          backend_base_url: String(cfg.backend_base_url || ""),
        });
      }

      if (llama && typeof llama === "object") {
        const st = (llama as any).state;
        const logs = (llama as any).logs;
        if (st && typeof st === "object") {
          setLlamaState(st as LlamaState);
        }
        if (logs && typeof logs === "object") {
          setLlamaLogs(logs as LlamaLogs);
        }
      }

      if (deps && typeof deps === "object") {
        setDepsState(deps as DepsState);
      }
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setBusy(null);
    }
  }, []);

  useEffect(() => {
    if (!window.electronAPI?.onLlamaEvent) {
      return;
    }
    const off = window.electronAPI.onLlamaEvent((payload: any) => {
      const type = String(payload?.type || "");
      if (type === "state" && payload?.state) {
        setLlamaState(payload.state as LlamaState);
      }
      if (type === "logs" && payload?.logs) {
        setLlamaLogs(payload.logs as LlamaLogs);
      }
    });
    return () => {
      try {
        off();
      } catch {}
    };
  }, []);

  useEffect(() => {
    if (!window.electronAPI?.onDepsEvent) {
      return;
    }
    const off = window.electronAPI.onDepsEvent((payload: any) => {
      if (payload?.state) {
        setDepsState(payload.state as DepsState);
      }
    });
    return () => {
      try {
        off();
      } catch {}
    };
  }, []);

  const pickDir = useCallback(async (): Promise<string | null> => {
    if (!window.electronAPI?.openDirectory) {
      return null;
    }
    try {
      return await window.electronAPI.openDirectory();
    } catch {
      return null;
    }
  }, []);

  const depsDownloadLlamaServer = useCallback(
    async (flavor: "cpu" | "cuda") => {
      if (!window.electronAPI?.depsDownloadLlamaServer) {
        setError(uiLang === "en" ? "Not running in Electron." : "当前不是 Electron 环境。"
        );
        return;
      }
      setError(null);
      setInfo(null);
      setBusy(`deps_llama_${flavor}`);
      try {
        const res: any = await window.electronAPI.depsDownloadLlamaServer({
          flavor,
          destDir: depsLlamaDir || undefined,
        });
        if (res?.state) setDepsState(res.state as DepsState);
        if (res?.ok) {
          setInfo(
            uiLang === "en" ? "Started download." : "已开始下载。"
          );
        } else {
          setError(String(res?.error || "DOWNLOAD_FAILED"));
        }
      } catch (e: any) {
        setError(String(e?.message || e));
      } finally {
        setBusy(null);
      }
    },
    [depsLlamaDir, uiLang]
  );

  const depsDownloadGgufPreset = useCallback(
    async (slot: "q4" | "q5" | "small") => {
      if (!window.electronAPI?.depsDownloadGgufPreset) {
        setError(uiLang === "en" ? "Not running in Electron." : "当前不是 Electron 环境。"
        );
        return;
      }
      const repoId =
        slot === "small"
          ? "Qwen/Qwen2.5-3B-Instruct-GGUF"
          : "Qwen/Qwen2.5-7B-Instruct-GGUF";
      setError(null);
      setInfo(null);
      setBusy(`deps_gguf_${slot}`);
      try {
        const res: any = await window.electronAPI.depsDownloadGgufPreset({
          slot,
          repoId,
          destDir: depsGgufDir || undefined,
        });
        if (res?.state) setDepsState(res.state as DepsState);
        if (res?.ok) {
          setInfo(uiLang === "en" ? "Started download." : "已开始下载。"
          );
        } else {
          setError(String(res?.error || "DOWNLOAD_FAILED"));
        }
      } catch (e: any) {
        setError(String(e?.message || e));
      } finally {
        setBusy(null);
      }
    },
    [depsGgufDir, uiLang]
  );

  const depsCancel = useCallback(async (taskId: string) => {
    if (!window.electronAPI?.depsCancel) {
      return;
    }
    setError(null);
    setInfo(null);
    setBusy("deps_cancel");
    try {
      const res: any = await window.electronAPI.depsCancel(taskId);
      if (!res?.ok) {
        setError(String(res?.error || "CANCEL_FAILED"));
      }
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setBusy(null);
    }
  }, []);

  const refreshLlama = useCallback(async () => {
    if (!window.electronAPI?.llamaGetState) {
      setError(uiLang === "en" ? "Not running in Electron." : "\u5f53\u524d\u4e0d\u662f Electron \u73af\u5883\u3002");
      return;
    }
    setError(null);
    setInfo(null);
    setBusy("refreshing_llama");
    try {
      const res: any = await window.electronAPI.llamaGetState();
      if (res?.state) setLlamaState(res.state as LlamaState);
      if (res?.logs) setLlamaLogs(res.logs as LlamaLogs);
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setBusy(null);
    }
  }, [uiLang]);

  const llamaStart = useCallback(async () => {
    if (!window.electronAPI?.llamaStart) {
      setError(uiLang === "en" ? "Not running in Electron." : "\u5f53\u524d\u4e0d\u662f Electron \u73af\u5883\u3002");
      return;
    }
    setError(null);
    setInfo(null);
    setBusy("llama_start");
    try {
      const res: any = await window.electronAPI.llamaStart();
      if (res?.state) setLlamaState(res.state as LlamaState);
      if (res?.logs) setLlamaLogs(res.logs as LlamaLogs);
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setBusy(null);
    }
  }, [uiLang]);

  const llamaStop = useCallback(async () => {
    if (!window.electronAPI?.llamaStop) {
      setError(uiLang === "en" ? "Not running in Electron." : "\u5f53\u524d\u4e0d\u662f Electron \u73af\u5883\u3002");
      return;
    }
    setError(null);
    setInfo(null);
    setBusy("llama_stop");
    try {
      const res: any = await window.electronAPI.llamaStop();
      if (res?.state) setLlamaState(res.state as LlamaState);
      if (res?.logs) setLlamaLogs(res.logs as LlamaLogs);
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setBusy(null);
    }
  }, [uiLang]);

  const llamaRestart = useCallback(async () => {
    if (!window.electronAPI?.llamaRestart) {
      setError(uiLang === "en" ? "Not running in Electron." : "\u5f53\u524d\u4e0d\u662f Electron \u73af\u5883\u3002");
      return;
    }
    setError(null);
    setInfo(null);
    setBusy("llama_restart");
    try {
      const res: any = await window.electronAPI.llamaRestart();
      if (res?.state) setLlamaState(res.state as LlamaState);
      if (res?.logs) setLlamaLogs(res.logs as LlamaLogs);
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setBusy(null);
    }
  }, [uiLang]);

  const llamaClearLogs = useCallback(async () => {
    if (!window.electronAPI?.llamaClearLogs) {
      return;
    }
    setError(null);
    setInfo(null);
    setBusy("llama_clear_logs");
    try {
      await window.electronAPI.llamaClearLogs();
      await refreshLlama();
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setBusy(null);
    }
  }, [refreshLlama]);

  const checkUpdates = useCallback(async () => {
    setUpdateError(null);
    setUpdateInfo(null);

    if (!window.electronAPI?.checkUpdates) {
      setUpdateError(
        uiLang === "en"
          ? "Not running in Electron."
          : "\u5f53\u524d\u4e0d\u662f Electron \u73af\u5883\u3002"
      );
      return;
    }

    setBusy("checking_updates");
    try {
      const ver = window.electronAPI?.getAppVersion
        ? await window.electronAPI.getAppVersion().catch(() => null)
        : null;
      setAppVersion(ver);

      const res = await window.electronAPI.checkUpdates();
      setUpdateCheck(res);

      if (res && res.ok) {
        if (res.update_available) {
          setUpdateInfo(
            uiLang === "en"
              ? `Update available: ${String(res.latest_version || "")}`
              : `\u53d1\u73b0\u65b0\u7248\u672c\uff1a${String(res.latest_version || "")}`
          );
        } else {
          setUpdateInfo(
            uiLang === "en" ? "Up to date." : "\u5df2\u662f\u6700\u65b0\u7248\u3002"
          );
        }
      } else {
        setUpdateError(String(res?.error || "CHECK_FAILED"));
      }
    } catch (e: any) {
      setUpdateError(e && e.message ? String(e.message) : String(e));
    } finally {
      setBusy(null);
    }
  }, [uiLang]);

  const openUpdateRelease = useCallback(async () => {
    const url = String(updaterState?.release_url || updateCheck?.release_url || "").trim();
    if (!url) return;
    try {
      if (window.electronAPI?.openExternal) {
        await window.electronAPI.openExternal(url);
        return;
      }
    } catch {}
    try {
      window.open(url, "_blank");
    } catch {}
  }, [updateCheck, updaterState]);

  const refreshDiagnostics = useCallback(async () => {
    setError(null);
    setInfo(null);
    setBusy("refreshing_diagnostics");
    try {
      const d = await api.getDiagnostics();
      setDiagnostics(d);
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setBusy(null);
    }
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  useEffect(() => {
    let disposed = false;
    const load = async () => {
      try {
        if (!window.electronAPI?.updaterGetState) return;
        const st = await window.electronAPI.updaterGetState();
        if (!disposed) setUpdaterState(st);
      } catch {}
    };
    void load();

    const off = window.electronAPI?.onUpdaterEvent
      ? window.electronAPI.onUpdaterEvent((payload: any) => {
          try {
            if (payload?.type === "state") {
              setUpdaterState(payload.state);
            }
          } catch {}
        })
      : null;

    return () => {
      disposed = true;
      try {
        off && off();
      } catch {}
    };
  }, []);

  const saveRuntime = useCallback(async () => {
    setError(null);
    setInfo(null);
    setBusy("saving_runtime");
    try {
      const payload: Record<string, unknown> = {
        profile: runtimeDraft.profile,
        asr_concurrency: runtimeDraft.asr_concurrency,
        llm_concurrency: runtimeDraft.llm_concurrency,
        heavy_concurrency: runtimeDraft.heavy_concurrency,
        llm_timeout_seconds: runtimeDraft.llm_timeout_seconds,
        asr_model: String(runtimeDraft.asr_model ?? "").trim() || undefined,
        asr_device: runtimeDraft.asr_device,
        asr_compute_type: runtimeDraft.asr_compute_type,
      };
      const res = await api.setRuntimeProfile(payload);
      setRuntime(res);
      setInfo(
        uiLang === "en"
          ? "Runtime profile saved"
          : "\u8fd0\u884c\u65f6\u914d\u7f6e\u5df2\u4fdd\u5b58"
      );
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setBusy(null);
    }
  }, [runtimeDraft]);

  const saveLlm = useCallback(async () => {
    setError(null);
    setInfo(null);
    setBusy("saving_llm");
    try {
      const payload = {
        provider: String(llmDraft.provider || "").trim(),
        model: llmDraft.model ?? null,
        temperature: Number(llmDraft.temperature ?? 0.2),
        max_tokens: Number(llmDraft.max_tokens ?? 512),
        output_language: String(llmDraft.output_language || "zh")
          .trim()
          .toLowerCase(),
      };
      await api.setDefaultLlmPreferences(payload);
      setInfo(
        uiLang === "en"
          ? "Default LLM preferences saved"
          : "\u9ed8\u8ba4 LLM \u504f\u597d\u5df2\u4fdd\u5b58"
      );
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setBusy(null);
    }
  }, [llmDraft]);

  const refreshLocalStatus = useCallback(async () => {
    setError(null);
    setInfo(null);
    setBusy("refreshing_status");
    try {
      const res = await api.getLocalLlmStatus();
      setLocalStatus(res);
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setBusy(null);
    }
  }, []);

  const refreshAsrStatus = useCallback(async () => {
    setError(null);
    setInfo(null);
    setBusy("refreshing_asr");
    try {
      const res = await api.getAsrModelStatus();
      setAsrStatus(res);
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setBusy(null);
    }
  }, []);

  const saveDevConfig = useCallback(async () => {
    if (!window.electronAPI?.setDevConfig) {
      setError(
        "\u5f53\u524d\u4e0d\u662f Electron \u73af\u5883\uff0c\u65e0\u6cd5\u4fdd\u5b58\u672c\u5730\u542f\u52a8\u914d\u7f6e"
      );
      return;
    }
    setError(null);
    setInfo(null);
    setBusy("saving_dev_config");
    try {
      let prev: Record<string, unknown> = {};
      try {
        if (window.electronAPI?.getDevConfig) {
          const cur = await window.electronAPI.getDevConfig();
          prev = ((cur as any)?.config || {}) as Record<string, unknown>;
        }
      } catch {
        prev = {};
      }

      const port = devConfigDraft.llama_port;
      const baseUrlRaw = String(devConfigDraft.local_llm_base_url || "").trim();
      const baseUrl =
        baseUrlRaw ||
        (typeof port === "number" && Number.isFinite(port)
          ? `http://127.0.0.1:${port}/v1`
          : "");

      const partial: Record<string, unknown> = {
        llama_server_exe: String(devConfigDraft.llama_server_exe || "").trim(),
        llama_model_path: String(devConfigDraft.llama_model_path || "").trim(),
        llama_model_slot: String(devConfigDraft.llama_model_slot || "").trim(),
        llama_model_q4_path: String(devConfigDraft.llama_model_q4_path || "").trim(),
        llama_model_q5_path: String(devConfigDraft.llama_model_q5_path || "").trim(),
        llama_model_small_path: String(devConfigDraft.llama_model_small_path || "").trim(),
        llama_port:
          typeof port === "number" && Number.isFinite(port) ? port : undefined,
        local_llm_base_url: baseUrl,
        backend_base_url: String(devConfigDraft.backend_base_url || "").trim(),
      };

      const payload: Record<string, unknown> = {
        ...prev,
        ...partial,
      };

      const res = await window.electronAPI.setDevConfig(payload);
      setDevConfigPath(String((res as any).path || "") || null);

      const cfg = ((res as any).config || {}) as Record<string, unknown>;
      setDevConfigDraft({
        llama_server_exe: String(cfg.llama_server_exe || ""),
        llama_model_path: String(cfg.llama_model_path || ""),
        llama_model_slot: String(cfg.llama_model_slot || ""),
        llama_model_q4_path: String(cfg.llama_model_q4_path || ""),
        llama_model_q5_path: String(cfg.llama_model_q5_path || ""),
        llama_model_small_path: String(cfg.llama_model_small_path || ""),
        llama_port:
          typeof cfg.llama_port === "number"
            ? (cfg.llama_port as number)
            : undefined,
        local_llm_base_url: String(cfg.local_llm_base_url || ""),
        backend_base_url: String(cfg.backend_base_url || ""),
      });

      setInfo(
        uiLang === "en"
          ? "Local launch config saved (restart app to apply)"
          : "\u672c\u5730\u542f\u52a8\u914d\u7f6e\u5df2\u4fdd\u5b58\uff08\u9700\u91cd\u542f\u5e94\u7528\u751f\u6548\uff09"
      );
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setBusy(null);
    }
  }, [devConfigDraft]);

  const pickPresetModel = useCallback(
    async (slot: "q4" | "q5" | "small") => {
      if (!window.electronAPI?.pickLlamaModel) {
        return;
      }
      const p = await window.electronAPI.pickLlamaModel();
      if (!p) return;
      if (slot === "q4") {
        setDevConfigDraft((d) => ({ ...d, llama_model_q4_path: p }));
        return;
      }
      if (slot === "q5") {
        setDevConfigDraft((d) => ({ ...d, llama_model_q5_path: p }));
        return;
      }
      setDevConfigDraft((d) => ({ ...d, llama_model_small_path: p }));
    },
    []
  );

  const applyPresetModelAndRestart = useCallback(async () => {
    if (!window.electronAPI?.setDevConfig) {
      setError(uiLang === "en" ? "Not running in Electron." : "\u5f53\u524d\u4e0d\u662f Electron \u73af\u5883\u3002");
      return;
    }
    if (!window.electronAPI?.llamaRestart) {
      setError(uiLang === "en" ? "llama-server control not available." : "llama-server \u63a7\u5236\u4e0d\u53ef\u7528\uff08\u8bf7\u786e\u8ba4\u5df2\u5b89\u88c5\u7248\u672c\u4e14 preload \u6b63\u5e38\uff09\u3002");
      return;
    }

    const slot = String(devConfigDraft.llama_model_slot || "q4").trim() as any;
    const q4 = String(devConfigDraft.llama_model_q4_path || "").trim();
    const q5 = String(devConfigDraft.llama_model_q5_path || "").trim();
    const small = String(devConfigDraft.llama_model_small_path || "").trim();

    let nextModelPath = "";
    if (slot === "q4") nextModelPath = q4;
    else if (slot === "q5") nextModelPath = q5;
    else if (slot === "small") nextModelPath = small;
    else nextModelPath = String(devConfigDraft.llama_model_path || "").trim();

    if (!nextModelPath) {
      setError(uiLang === "en" ? "Model path is empty." : "\u6a21\u578b\u8def\u5f84\u4e3a\u7a7a\u3002");
      return;
    }

    setError(null);
    setInfo(null);
    setBusy("llama_hot_swap");
    try {
      let prev: Record<string, unknown> = {};
      try {
        if (window.electronAPI?.getDevConfig) {
          const cur = await window.electronAPI.getDevConfig();
          prev = ((cur as any)?.config || {}) as Record<string, unknown>;
          setDevConfigPath(String((cur as any)?.path || "") || null);
        }
      } catch {
        prev = {};
      }

      const port = devConfigDraft.llama_port;
      const baseUrlRaw = String(devConfigDraft.local_llm_base_url || "").trim();
      const baseUrl =
        baseUrlRaw ||
        (typeof port === "number" && Number.isFinite(port)
          ? `http://127.0.0.1:${port}/v1`
          : "");

      const nextCfg: Record<string, unknown> = {
        ...prev,
        llama_server_exe: String(devConfigDraft.llama_server_exe || "").trim(),
        llama_model_path: nextModelPath,
        llama_model_slot: String(slot || "").trim(),
        llama_model_q4_path: q4,
        llama_model_q5_path: q5,
        llama_model_small_path: small,
        llama_port:
          typeof port === "number" && Number.isFinite(port) ? port : undefined,
        local_llm_base_url: baseUrl,
        backend_base_url: String(devConfigDraft.backend_base_url || "").trim(),
      };

      const res = await window.electronAPI.setDevConfig(nextCfg);
      const cfg = ((res as any).config || {}) as Record<string, unknown>;
      setDevConfigDraft({
        llama_server_exe: String(cfg.llama_server_exe || ""),
        llama_model_path: String(cfg.llama_model_path || ""),
        llama_model_slot: String(cfg.llama_model_slot || ""),
        llama_model_q4_path: String(cfg.llama_model_q4_path || ""),
        llama_model_q5_path: String(cfg.llama_model_q5_path || ""),
        llama_model_small_path: String(cfg.llama_model_small_path || ""),
        llama_port:
          typeof cfg.llama_port === "number"
            ? (cfg.llama_port as number)
            : undefined,
        local_llm_base_url: String(cfg.local_llm_base_url || ""),
        backend_base_url: String(cfg.backend_base_url || ""),
      });

      const rr: any = await window.electronAPI.llamaRestart();
      if (rr?.state) setLlamaState(rr.state as LlamaState);
      if (rr?.logs) setLlamaLogs(rr.logs as LlamaLogs);

      try {
        const ls = await api.getLocalLlmStatus();
        setLocalStatus(ls);
      } catch {}

      setInfo(uiLang === "en" ? "Model switched and llama-server restarted" : "\u6a21\u578b\u5df2\u5207\u6362\uff0cllama-server \u5df2\u91cd\u542f");
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setBusy(null);
    }
  }, [devConfigDraft, uiLang]);

  const pickLlamaExe = useCallback(async () => {
    if (!window.electronAPI?.pickLlamaServerExe) {
      return;
    }
    const p = await window.electronAPI.pickLlamaServerExe();
    if (p) {
      setDevConfigDraft((d) => ({ ...d, llama_server_exe: p }));
    }
  }, []);

  const pickLlamaModel = useCallback(async () => {
    if (!window.electronAPI?.pickLlamaModel) {
      return;
    }
    const p = await window.electronAPI.pickLlamaModel();
    if (p) {
      setDevConfigDraft((d) => ({ ...d, llama_model_path: p }));
    }
  }, []);

  const effective = useMemo(() => {
    return runtime?.effective ?? null;
  }, [runtime]);

  const onRuntimeProfileChange = useCallback(
    (e: ChangeEvent<HTMLSelectElement>) => {
      setRuntimeDraft((d) => ({ ...d, profile: e.target.value }));
    },
    []
  );

  return (
    <div className="stack">
      <div className="card">
        <h2>{t("settings")}</h2>
        <div className="muted">{t("backend_hint")}</div>
        {error ? <div className="alert alert-error">{error}</div> : null}
        {info ? <div className="alert alert-info">{info}</div> : null}
        <div className="row">
          <button className="btn" onClick={loadAll} disabled={!!busy}>
            {t("refresh_all")}
          </button>
        </div>

      </div>

      <div className="card">
        <h3>{uiLang === "en" ? "llama-server (in-app control)" : "llama-server \uff08\u5e94\u7528\u5185\u63a7\u5236\uff09"}</h3>

        {window.electronAPI?.llamaGetState ? (
          <>
            <div className="row">
              <button className="btn" onClick={refreshLlama} disabled={!!busy}>
                {uiLang === "en" ? "Refresh" : "\u5237\u65b0"}
              </button>
              <button className="btn primary" onClick={llamaStart} disabled={!!busy}>
                {uiLang === "en" ? "Start" : "\u542f\u52a8"}
              </button>
              <button className="btn" onClick={llamaStop} disabled={!!busy}>
                {uiLang === "en" ? "Stop" : "\u505c\u6b62"}
              </button>
              <button className="btn" onClick={llamaRestart} disabled={!!busy}>
                {uiLang === "en" ? "Restart" : "\u91cd\u542f"}
              </button>
              <button className="btn" onClick={llamaClearLogs} disabled={!!busy}>
                {uiLang === "en" ? "Clear logs" : "\u6e05\u7a7a\u65e5\u5fd7"}
              </button>
            </div>

            <div className="subcard" style={{ marginTop: 8 }}>
              <div className="kv">
                <div className="k">status</div>
                <div className="v">{String(llamaState?.status || "-")}</div>
              </div>
              <div className="kv">
                <div className="k">pid</div>
                <div className="v">{String(llamaState?.pid ?? "-")}</div>
              </div>
              <div className="kv">
                <div className="k">exit_code</div>
                <div className="v">{String(llamaState?.last_exit_code ?? "-")}</div>
              </div>
              {llamaState?.error ? (
                <div className="alert alert-error compact">{String(llamaState.error)}</div>
              ) : null}
            </div>

            {llamaLogs?.stdout?.length ? (
              <div className="subcard" style={{ marginTop: 8 }}>
                <div className="label">stdout</div>
                <pre className="pre">{String((llamaLogs.stdout || []).join("\n"))}</pre>
              </div>
            ) : null}

            {llamaLogs?.stderr?.length ? (
              <div className="subcard" style={{ marginTop: 8 }}>
                <div className="label">stderr</div>
                <pre className="pre">{String((llamaLogs.stderr || []).join("\n"))}</pre>
              </div>
            ) : null}
          </>
        ) : (
          <div className="muted">
            {uiLang === "en"
              ? "Auto control is available only in Electron packaged/dev app with preload enabled."
              : "\u81ea\u52a8\u63a7\u5236\u4ec5\u5728 Electron \u73af\u5883\uff08\u4e14 preload \u6b63\u5e38\u542f\u7528\uff09\u4e0b\u53ef\u7528\u3002"}
          </div>
        )}
      </div>

      <div className="card">
        <h3>{uiLang === "en" ? "Updates" : "\u66f4\u65b0"}</h3>

        {updaterState?.supported ? (
          <>
            <div className="row">
              <button className="btn" onClick={updaterCheck} disabled={!!busy}>
                {uiLang === "en" ? "Check" : "\u68c0\u67e5"}
              </button>
              {String(updaterState?.status || "") === "update_available" ? (
                <button className="btn primary" onClick={updaterUpdateNow} disabled={!!busy}>
                  {uiLang === "en" ? "Update now" : "\u4e00\u952e\u66f4\u65b0"}
                </button>
              ) : null}
              {String(updaterState?.status || "") === "downloaded" ? (
                <button className="btn primary" onClick={updaterInstall} disabled={!!busy}>
                  {uiLang === "en" ? "Install & Restart" : "\u5b89\u88c5\u5e76\u91cd\u542f"}
                </button>
              ) : null}
              {updaterState?.release_url ? (
                <button className="btn" onClick={openUpdateRelease} disabled={!!busy}>
                  {uiLang === "en" ? "Open release" : "\u6253\u5f00\u53d1\u5e03\u9875"}
                </button>
              ) : null}
            </div>

            <div className="kv" style={{ marginTop: 8 }}>
              <div className="k">current</div>
              <div className="v">{String(updaterState?.current_version || appVersion?.version || "-")}</div>
            </div>
            <div className="kv">
              <div className="k">status</div>
              <div className="v">{String(updaterState?.status || "-")}</div>
            </div>
            <div className="kv">
              <div className="k">available</div>
              <div className="v">{String(updaterState?.available_version || "-")}</div>
            </div>

            {String(updaterState?.status || "") === "downloading" ? (
              <div className="muted" style={{ marginTop: 8 }}>
                {uiLang === "en"
                  ? `Downloading: ${Number(updaterState?.progress?.percent || 0).toFixed(1)}%`
                  : `\u6b63\u5728\u4e0b\u8f7d\uff1a${Number(updaterState?.progress?.percent || 0).toFixed(1)}%`}
              </div>
            ) : null}

            {updaterState?.error ? (
              <div className="alert alert-error compact">{String(updaterState.error)}</div>
            ) : null}
          </>
        ) : (
          <>
            <div className="muted" style={{ marginBottom: 8 }}>
              {uiLang === "en"
                ? "Auto update is available only in the installed (packaged) app."
                : "\u81ea\u52a8\u66f4\u65b0\u4ec5\u652f\u6301\u5b89\u88c5\u7248\uff08packaged\uff09\u3002"}
            </div>
            <div className="row">
              <button className="btn" onClick={checkUpdates} disabled={!!busy}>
                {uiLang === "en" ? "Check updates" : "\u68c0\u67e5\u66f4\u65b0"}
              </button>
              {updateCheck?.ok && updateCheck?.release_url ? (
                <button className="btn" onClick={openUpdateRelease} disabled={!!busy}>
                  {uiLang === "en" ? "Open release" : "\u6253\u5f00\u53d1\u5e03\u9875"}
                </button>
              ) : null}
            </div>

            <div className="kv" style={{ marginTop: 8 }}>
              <div className="k">current</div>
              <div className="v">{String(appVersion?.version || "-")}</div>
            </div>
            <div className="kv">
              <div className="k">latest</div>
              <div className="v">{String(updateCheck?.ok ? updateCheck?.latest_version || "-" : "-")}</div>
            </div>

            {busy === "checking_updates" ? (
              <div className="muted" style={{ marginTop: 8 }}>
                {uiLang === "en" ? "Checking..." : "\u6b63\u5728\u68c0\u67e5..."}
              </div>
            ) : null}
          </>
        )}
        {updateError ? <div className="alert alert-error compact">{updateError}</div> : null}
        {updateInfo ? <div className="alert alert-info compact">{updateInfo}</div> : null}
      </div>

      <div className="card">
        <h3>{t("runtime_profile")}</h3>
        <div className="grid">
          <label className="field">
            <div className="label">profile</div>
            <select
              className="input"
              value={runtimeDraft.profile ?? "balanced"}
              onChange={onRuntimeProfileChange}
            >
              <option value="cpu">cpu</option>
              <option value="balanced">balanced</option>
              <option value="gpu_recommended">gpu_recommended</option>
            </select>
          </label>

          {runtimeDraft.profile === "gpu_recommended" ? (
            <div className="field">
              <div className="label">hint</div>
              <div className="muted">
                {uiLang === "en"
                  ? "Recommended ASR model: large-v3 (hint only; not auto-applied; will be validated for download availability later)"
                  : "\u63a8\u8350 ASR \u6a21\u578b\uff1alarge-v3\uff08\u4ec5\u63d0\u793a\uff0c\u4e0d\u81ea\u52a8\u5207\u6362\uff1b\u540e\u7eed\u4f1a\u9a8c\u8bc1\u662f\u5426\u53ef\u6b63\u5e38\u4e0b\u8f7d\uff09"}
              </div>
            </div>
          ) : null}

          <label className="field">
            <div className="label">asr_concurrency</div>
            <input
              className="input"
              value={runtimeDraft.asr_concurrency ?? ""}
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                setRuntimeDraft((d) => ({
                  ...d,
                  asr_concurrency: toNumberOrUndefined(e.target.value),
                }))
              }
              inputMode="numeric"
            />
          </label>

          <label className="field">
            <div className="label">asr_model</div>
            <input
              className="input"
              value={runtimeDraft.asr_model ?? ""}
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                setRuntimeDraft((d) => ({ ...d, asr_model: e.target.value }))
              }
              placeholder="small / medium / large-v3"
            />
          </label>

          <label className="field">
            <div className="label">llm_concurrency</div>
            <input
              className="input"
              value={runtimeDraft.llm_concurrency ?? ""}
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                setRuntimeDraft((d) => ({
                  ...d,
                  llm_concurrency: toNumberOrUndefined(e.target.value),
                }))
              }
              inputMode="numeric"
            />
          </label>

          <label className="field">
            <div className="label">heavy_concurrency</div>
            <input
              className="input"
              value={runtimeDraft.heavy_concurrency ?? ""}
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                setRuntimeDraft((d) => ({
                  ...d,
                  heavy_concurrency: toNumberOrUndefined(e.target.value),
                }))
              }
              inputMode="numeric"
            />
          </label>

          <label className="field">
            <div className="label">llm_timeout_seconds</div>
            <input
              className="input"
              value={runtimeDraft.llm_timeout_seconds ?? ""}
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                setRuntimeDraft((d) => ({
                  ...d,
                  llm_timeout_seconds: toNumberOrUndefined(e.target.value),
                }))
              }
              inputMode="numeric"
            />
          </label>

          <label className="field">
            <div className="label">asr_device</div>
            <input
              className="input"
              value={runtimeDraft.asr_device ?? ""}
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                setRuntimeDraft((d) => ({ ...d, asr_device: e.target.value }))
              }
              placeholder="auto / cpu / cuda"
            />
          </label>

          <label className="field">
            <div className="label">asr_compute_type</div>
            <input
              className="input"
              value={runtimeDraft.asr_compute_type ?? ""}
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                setRuntimeDraft((d) => ({
                  ...d,
                  asr_compute_type: e.target.value,
                }))
              }
              placeholder="int8 / float16"
            />
          </label>
        </div>

        <div className="row">
          <button
            className="btn primary"
            onClick={saveRuntime}
            disabled={!!busy}
          >
            {t("save_runtime")}
          </button>
        </div>

        {effective ? (
          <div className="subcard">
            <div className="label">effective</div>
            <pre className="pre">{JSON.stringify(effective, null, 2)}</pre>
          </div>
        ) : null}

        <div className="subcard">
          <div
            style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}
          >
            <div className="label">{t("asr_model_status")}</div>
            <button className="btn" onClick={refreshAsrStatus} disabled={!!busy}>
              {t("refresh_asr_status")}
            </button>
          </div>
          <div className="muted" style={{ marginTop: 8 }}>
            {String(asrStatus?.model || t("asr_large_v3"))} | local: {asrStatus?.local?.ok ? "OK" : "NOT_FOUND"} | download: {asrStatus?.download?.ok ? "OK" : "ERROR"}
          </div>
          {asrStatus ? (
            <div style={{ marginTop: 8 }}>
              {asrStatus?.huggingface_hub?.version ? (
                <div className="muted">huggingface_hub: {String(asrStatus.huggingface_hub.version)}</div>
              ) : null}

              {asrStatus?.local?.error ? (
                <div className="alert alert-error compact">{String(asrStatus.local.error)}</div>
              ) : null}

              {asrStatus?.download?.ok ? null : asrStatus?.download?.error ? (
                <div className="alert alert-error compact">{String(asrStatus.download.error)}</div>
              ) : null}

              {Array.isArray((asrStatus as any)?.local?.missing_required_files) &&
              (asrStatus as any).local.missing_required_files.length ? (
                <div className="alert alert-error compact" style={{ marginTop: 8 }}>
                  {uiLang === "en"
                    ? "Missing required files (model not usable)."
                    : "\u7f3a\u5931\u5fc5\u9700\u6587\u4ef6\uff08\u6a21\u578b\u4e0d\u53ef\u7528\uff09\u3002"}
                  <pre className="pre" style={{ marginTop: 8 }}>
                    {String(
                      (((asrStatus as any).local.missing_required_files as any[]) || []).join(
                        "\n"
                      )
                    )}
                  </pre>
                </div>
              ) : (
                <div className="alert alert-info compact" style={{ marginTop: 8 }}>
                  {uiLang === "en"
                    ? "Required files are present (model should be usable)."
                    : "\u5fc5\u9700\u6587\u4ef6\u5df2\u5c31\u7eea\uff08\u6a21\u578b\u5e94\u53ef\u7528\uff09\u3002"}
                </div>
              )}

              {Array.isArray((asrStatus as any)?.local?.missing_optional_files) &&
              (asrStatus as any).local.missing_optional_files.length ? (
                <details style={{ marginTop: 8 }}>
                  <summary className="muted">
                    {uiLang === "en"
                      ? "Optional missing files (usually non-blocking)"
                      : "\u53ef\u9009\u7f3a\u5931\u6587\u4ef6\uff08\u901a\u5e38\u4e0d\u5f71\u54cd\u4f7f\u7528\uff09"}
                  </summary>
                  <pre className="pre">
                    {String(
                      (((asrStatus as any).local.missing_optional_files as any[]) || []).join(
                        "\n"
                      )
                    )}
                  </pre>
                </details>
              ) : null}

              <div className="grid" style={{ marginTop: 8 }}>
                <div className="field">
                  <div className="label">repo</div>
                  <div className="muted" style={{ wordBreak: "break-all" }}>
                    {String(
                      asrStatus?.download?.repo_url ||
                        `https://huggingface.co/${String(asrStatus.repo_id || "")}`
                    )}
                  </div>
                  <div className="row">
                    <button
                      className="btn"
                      onClick={() => {
                        const url = String(
                          asrStatus?.download?.repo_url ||
                            `https://huggingface.co/${String(asrStatus.repo_id || "")}`
                        );
                        window.open(url, "_blank");
                      }}
                      disabled={!!busy}
                    >
                      {uiLang === "en" ? "Open" : "\u6253\u5f00"}
                    </button>
                    <button
                      className="btn"
                      onClick={() => {
                        const url = String(
                          asrStatus?.download?.repo_url ||
                            `https://huggingface.co/${String(asrStatus.repo_id || "")}`
                        );
                        void copyText(url, uiLang === "en" ? "Copied" : "\u5df2\u590d\u5236");
                      }}
                      disabled={!!busy}
                    >
                      {uiLang === "en" ? "Copy" : "\u590d\u5236"}
                    </button>
                  </div>
                </div>

                <div className="field">
                  <div className="label">download_url</div>
                  <div className="muted" style={{ wordBreak: "break-all" }}>
                    {String(asrStatus?.download?.url || "")}
                  </div>
                  <div className="row">
                    <button
                      className="btn"
                      onClick={() => {
                        const url = String(asrStatus?.download?.url || "");
                        if (url) window.open(url, "_blank");
                      }}
                      disabled={!!busy || !asrStatus?.download?.url}
                    >
                      {uiLang === "en" ? "Open" : "\u6253\u5f00"}
                    </button>
                    <button
                      className="btn"
                      onClick={() => {
                        const url = String(asrStatus?.download?.url || "");
                        if (!url) return;
                        void copyText(url, uiLang === "en" ? "Copied" : "\u5df2\u590d\u5236");
                      }}
                      disabled={!!busy || !asrStatus?.download?.url}
                    >
                      {uiLang === "en" ? "Copy" : "\u590d\u5236"}
                    </button>
                  </div>
                </div>
              </div>

              {Array.isArray((asrStatus as any)?.local?.missing_required_files) &&
              (asrStatus as any).local.missing_required_files.length ? (
                <div className="subcard" style={{ marginTop: 8 }}>
                  <div className="label">
                    {uiLang === "en" ? "Download via Python" : "\u4f7f\u7528 Python \u4e0b\u8f7d"}
                  </div>
                  <pre className="pre">
                    {`python -c "from huggingface_hub import snapshot_download; snapshot_download(repo_id='${String(
                      asrStatus.repo_id || "Systran/faster-whisper-large-v3"
                    )}')"`}
                  </pre>
                  <div className="row">
                    <button
                      className="btn"
                      onClick={() => {
                        const cmd = `python -c "from huggingface_hub import snapshot_download; snapshot_download(repo_id='${String(
                          asrStatus.repo_id || "Systran/faster-whisper-large-v3"
                        )}')"`;
                        void copyText(cmd, uiLang === "en" ? "Copied" : "\u5df2\u590d\u5236");
                      }}
                      disabled={!!busy}
                    >
                      {uiLang === "en" ? "Copy command" : "\u590d\u5236\u547d\u4ee4"}
                    </button>
                  </div>
                  <div className="muted" style={{ marginTop: 6 }}>
                    {uiLang === "en"
                      ? "This downloads into the Hugging Face cache."
                      : "\u8be5\u547d\u4ee4\u4f1a\u4e0b\u8f7d\u5230 Hugging Face \u7f13\u5b58\u76ee\u5f55\u3002"}
                  </div>
                </div>
              ) : null}

              {(asrStatus as any)?.local?.model_bin || (asrStatus as any)?.local?.config_json ? (
                <div className="subcard" style={{ marginTop: 8 }}>
                  <div className="label">{uiLang === "en" ? "Local cache" : "本地缓存"}</div>
                  {(asrStatus as any)?.local?.model_bin ? (
                    <div className="muted" style={{ wordBreak: "break-all" }}>
                      model.bin: {String((asrStatus as any).local.model_bin)}
                    </div>
                  ) : null}
                  {(asrStatus as any)?.local?.config_json ? (
                    <div className="muted" style={{ wordBreak: "break-all" }}>
                      config.json: {String((asrStatus as any).local.config_json)}
                    </div>
                  ) : null}
                </div>
              ) : null}

              <details style={{ marginTop: 8 }}>
                <summary className="muted">{uiLang === "en" ? "Raw status JSON" : "原始状态 JSON"}</summary>
                <pre className="pre">{JSON.stringify(asrStatus, null, 2)}</pre>
              </details>
            </div>
          ) : (
            <div className="muted" style={{ marginTop: 8 }}>
              {uiLang === "en" ? "ASR status not loaded" : "\u5c1a\u672a\u83b7\u53d6 ASR \u72b6\u6001"}
            </div>
          )}
        </div>
      </div>

      <div className="card">
        <h3>{t("default_llm")}</h3>
        <div className="grid">
          <label className="field">
            <div className="label">provider</div>
            <select
              className="input"
              value={llmDraft.provider ?? "fake"}
              onChange={(e: ChangeEvent<HTMLSelectElement>) =>
                setLlmDraft((d) => ({ ...d, provider: e.target.value }))
              }
            >
              {providers.length ? (
                providers.map((p: string) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))
              ) : (
                <option value={llmDraft.provider ?? "fake"}>
                  {llmDraft.provider ?? "fake"}
                </option>
              )}
            </select>
          </label>

          <label className="field">
            <div className="label">model</div>
            <input
              className="input"
              value={llmDraft.model ?? ""}
              onChange={(e: ChangeEvent<HTMLInputElement>) => {
                const v = String(e.target.value || "").trim();
                setLlmDraft((d) => ({ ...d, model: v ? v : null }));
              }}
              placeholder="e.g. Qwen2.5-7B-Instruct"
            />
          </label>

          {localStatus?.models?.length ? (
            <label className="field">
              <div className="label">model (from local server)</div>
              <select
                className="input"
                value={llmDraft.model ?? ""}
                onChange={(e: ChangeEvent<HTMLSelectElement>) => {
                  const v = String(e.target.value || "").trim();
                  setLlmDraft((d) => ({ ...d, model: v ? v : null }));
                }}
              >
                <option value="">{uiLang === "en" ? "(use default)" : "\u4f7f\u7528\u9ed8\u8ba4"}</option>
                {(localStatus.models || []).map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          <label className="field">
            <div className="label">temperature</div>
            <input
              className="input"
              value={llmDraft.temperature ?? ""}
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                setLlmDraft((d) => ({
                  ...d,
                  temperature: toNumberOrUndefined(e.target.value),
                }))
              }
            />
          </label>

          <label className="field">
            <div className="label">max_tokens</div>
            <input
              className="input"
              value={llmDraft.max_tokens ?? ""}
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                setLlmDraft((d) => ({
                  ...d,
                  max_tokens: toNumberOrUndefined(e.target.value),
                }))
              }
              inputMode="numeric"
            />
          </label>

          <label className="field">
            <div className="label">{t("output_language")}</div>
            <select
              className="input"
              value={llmDraft.output_language ?? "zh"}
              onChange={(e: ChangeEvent<HTMLSelectElement>) =>
                setLlmDraft((d) => ({ ...d, output_language: e.target.value }))
              }
            >
              <option value="zh">
                {uiLang === "en" ? "Chinese" : "\u4e2d\u6587"}
              </option>
              <option value="en">
                {uiLang === "en" ? "English" : "\u82f1\u6587"}
              </option>
              <option value="auto">
                {uiLang === "en" ? "Auto" : "\u81ea\u52a8"}
              </option>
            </select>
          </label>
        </div>

        <div className="row">
          <button className="btn primary" onClick={saveLlm} disabled={!!busy}>
            {t("save_default_llm")}
          </button>
        </div>
      </div>

      <div className="card">
        <h3>{t("local_status")}</h3>
        <div className="row">
          <button
            className="btn"
            onClick={refreshLocalStatus}
            disabled={!!busy}
          >
            {t("refresh_status")}
          </button>
        </div>

        {localStatus ? (
          <div className="subcard">
            <div className="kv">
              <div className="k">ok</div>
              <div className={localStatus.ok ? "v ok" : "v bad"}>
                {String(localStatus.ok)}
              </div>
            </div>
            <div className="kv">
              <div className="k">base_url</div>
              <div className="v">{localStatus.base_url}</div>
            </div>
            <div className="kv">
              <div className="k">default_model</div>
              <div className="v">{localStatus.default_model}</div>
            </div>
            {localStatus.error ? (
              <div className="alert alert-error compact">{localStatus.error}</div>
            ) : null}
            {localStatus.models?.length ? (
              <div className="subcard">
                <div className="label">models</div>
                <pre className="pre">
                  {JSON.stringify(localStatus.models, null, 2)}
                </pre>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="muted">{t("no_status_yet")}</div>
        )}
      </div>

      <div className="card">
        <h3>
          {uiLang === "en"
            ? "Dependencies auto-download"
            : "\u4f9d\u8d56\u81ea\u52a8\u4e0b\u8f7d"}
        </h3>
        <div className="muted">
          {uiLang === "en"
            ? "Download llama-server and preset GGUF models, with progress and cancel."
            : "\u4e00\u952e\u4e0b\u8f7d llama-server \u4e0e\u9884\u7f6e GGUF \u6a21\u578b\uff0c\u5e76\u663e\u793a\u8fdb\u5ea6\uff0c\u53ef\u53d6\u6d88\u3002"}
        </div>

        {!depsLlamaDir && depsState?.default_dirs?.llama_server ? (
          <div className="muted" style={{ marginTop: 6, wordBreak: "break-all" }}>
            {uiLang === "en" ? "Default llama-server dir: " : "默认 llama-server 目录:"}
            <code>{depsState.default_dirs.llama_server}</code>
          </div>
        ) : null}

        {!depsGgufDir && depsState?.default_dirs?.gguf_models ? (
          <div className="muted" style={{ marginTop: 6, wordBreak: "break-all" }}>
            {uiLang === "en" ? "Default GGUF dir: " : "默认 GGUF 目录:"}
            <code>{depsState.default_dirs.gguf_models}</code>
          </div>
        ) : null}

        <div className="grid" style={{ marginTop: 8 }}>
          <label className="field">
            <div className="label">
              {uiLang === "en" ? "llama-server install dir" : "llama-server \u5b89\u88c5\u76ee\u5f55"}
            </div>
            <input
              className="input"
              value={depsLlamaDir}
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                setDepsLlamaDir(e.target.value)
              }
              placeholder={uiLang === "en" ? "(optional)" : "（可选）"}
            />
          </label>
          <div className="field">
            <div className="label">{t("pick_file")}</div>
            <button
              className="btn"
              onClick={async () => {
                const p = await pickDir();
                if (p) setDepsLlamaDir(p);
              }}
              disabled={!!busy}
            >
              {uiLang === "en" ? "Pick dir" : "选择目录"}
            </button>
          </div>

          <label className="field">
            <div className="label">
              {uiLang === "en" ? "GGUF download dir" : "GGUF 下载目录"}
            </div>
            <input
              className="input"
              value={depsGgufDir}
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                setDepsGgufDir(e.target.value)
              }
              placeholder={uiLang === "en" ? "(optional)" : "（可选）"}
            />
          </label>
          <div className="field">
            <div className="label">{t("pick_file")}</div>
            <button
              className="btn"
              onClick={async () => {
                const p = await pickDir();
                if (p) setDepsGgufDir(p);
              }}
              disabled={!!busy}
            >
              {uiLang === "en" ? "Pick dir" : "选择目录"}
            </button>
          </div>
        </div>

        <div className="row" style={{ marginTop: 8, flexWrap: "wrap" }}>
          <button
            className="btn"
            onClick={() => void depsDownloadLlamaServer("cpu")}
            disabled={!!busy}
          >
            {uiLang === "en" ? "Download llama-server (CPU)" : "下载 llama-server（CPU）"}
          </button>
          <button
            className="btn"
            onClick={() => void depsDownloadLlamaServer("cuda")}
            disabled={!!busy}
          >
            {uiLang === "en" ? "Download llama-server (CUDA)" : "下载 llama-server（CUDA）"}
          </button>
        </div>

        <div className="row" style={{ marginTop: 8, flexWrap: "wrap" }}>
          <button
            className="btn"
            onClick={() => void depsDownloadGgufPreset("q4")}
            disabled={!!busy}
          >
            {uiLang === "en" ? "Download preset GGUF (Q4)" : "下载预置 GGUF（Q4）"}
          </button>
          <button
            className="btn"
            onClick={() => void depsDownloadGgufPreset("q5")}
            disabled={!!busy}
          >
            {uiLang === "en" ? "Download preset GGUF (Q5)" : "下载预置 GGUF（Q5）"}
          </button>
          <button
            className="btn"
            onClick={() => void depsDownloadGgufPreset("small")}
            disabled={!!busy}
          >
            {uiLang === "en" ? "Download preset GGUF (Small)" : "下载预置 GGUF（小模型）"}
          </button>
        </div>

        {depsState?.tasks?.length ? (
          <div className="subcard" style={{ marginTop: 8 }}>
            <div className="label">
              {uiLang === "en" ? "Download tasks" : "下载任务"}
            </div>
            {(depsState.tasks || []).slice().reverse().slice(0, 6).map((t) => {
              const transferred = typeof t.transferred === "number" ? t.transferred : 0;
              const total = typeof t.total === "number" ? t.total : undefined;
              const pct =
                typeof t.percent === "number"
                  ? Math.max(0, Math.min(100, t.percent))
                  : total && total > 0
                    ? Math.max(0, Math.min(100, (transferred / total) * 100))
                    : undefined;
              const canCancel =
                String(t.status || "") === "downloading" ||
                String(t.status || "") === "extracting";
              return (
                <div key={t.id} className="subcard" style={{ marginTop: 8 }}>
                  <div className="kv">
                    <div className="k">{t.label || t.kind}</div>
                    <div className="v">{String(t.status || "")}</div>
                  </div>
                  <div className="kv">
                    <div className="k">progress</div>
                    <div className="v">
                      {pct !== undefined ? `${pct.toFixed(1)}%` : "-"} | {formatBytes(transferred)}
                      {total ? ` / ${formatBytes(total)}` : ""}
                      {typeof t.bytes_per_second === "number"
                        ? ` | ${formatBytes(t.bytes_per_second)}/s`
                        : ""}
                    </div>
                  </div>
                  {t.dest_path ? (
                    <div className="muted" style={{ wordBreak: "break-all" }}>
                      {String(t.dest_path)}
                    </div>
                  ) : null}
                  {t.error ? (
                    <div className="alert alert-error compact">{String(t.error)}</div>
                  ) : null}
                  {canCancel ? (
                    <div className="row">
                      <button
                        className="btn"
                        onClick={() => void depsCancel(t.id)}
                        disabled={!!busy}
                      >
                        {uiLang === "en" ? "Cancel" : "取消"}
                      </button>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="muted" style={{ marginTop: 8 }}>
            {uiLang === "en" ? "No tasks yet." : "暂无任务。"}
          </div>
        )}
      </div>

      <div className="card">
        <h3>{t("local_launch_config")}</h3>
        <div className="muted">
          {
            "\u8be5\u914d\u7f6e\u7528\u4e8e\u4e00\u952e\u542f\u52a8\uff08\u5199\u5165 artifacts/dev_config.json\uff09\uff1b\u968f\u540e\u6267\u884c "
          }
          <code>start_dev.cmd -StartLlama</code>
          {" \u4f1a\u81ea\u52a8\u8bfb\u53d6\u3002"}
        </div>
        {devConfigPath ? (
          <div className="muted">
            {"\u914d\u7f6e\u6587\u4ef6\uff1a"}
            {devConfigPath}
          </div>
        ) : null}

        {window.electronAPI?.setDevConfig ? (
          <>
            <div className="grid">
              <label className="field">
                <div className="label">llama_server_exe</div>
                <input
                  className="input"
                  value={devConfigDraft.llama_server_exe ?? ""}
                  onChange={(e: ChangeEvent<HTMLInputElement>) =>
                    setDevConfigDraft((d) => ({
                      ...d,
                      llama_server_exe: e.target.value,
                    }))
                  }
                  placeholder="e.g. F:\\LLAMA\\bin\\llama-server.exe"
                />
              </label>

              <div className="field">
                <div className="label">{"\u9009\u62e9 llama-server.exe"}</div>
                <button
                  className="btn"
                  onClick={pickLlamaExe}
                  disabled={!!busy}
                >
                  {t("pick_file")}
                </button>
              </div>

              <div className="field" style={{ gridColumn: "1 / -1" }}>
                <div className="label">
                  {uiLang === "en"
                    ? "Quick switch local LLM weights"
                    : "\u5feb\u901f\u5207\u6362\u672c\u5730 LLM \u6a21\u578b\uff08GGUF\uff09"}
                </div>
                <div className="muted">
                  {uiLang === "en"
                    ? "Select a preset, save config and restart llama-server."
                    : "\u9009\u62e9\u4e00\u4e2a\u9884\u7f6e\u9879\uff0c\u4fdd\u5b58\u914d\u7f6e\u5e76\u91cd\u542f llama-server\u3002"}
                </div>
                <div className="row" style={{ marginTop: 6 }}>
                  <select
                    className="input"
                    value={String(devConfigDraft.llama_model_slot || "q4")}
                    onChange={(e: ChangeEvent<HTMLSelectElement>) =>
                      setDevConfigDraft((d) => ({
                        ...d,
                        llama_model_slot: e.target.value,
                      }))
                    }
                    disabled={!!busy}
                  >
                    <option value="q4">Qwen2.5-7B-Instruct Q4_K_M</option>
                    <option value="q5">Qwen2.5-7B-Instruct Q5_K_M</option>
                    <option value="small">
                      {uiLang === "en" ? "Smaller model" : "\u66f4\u5c0f\u6a21\u578b"}
                    </option>
                    <option value="custom">
                      {uiLang === "en" ? "Custom (llama_model_path)" : "\u81ea\u5b9a\u4e49\uff08llama_model_path\uff09"}
                    </option>
                  </select>
                  <button
                    className="btn primary"
                    onClick={applyPresetModelAndRestart}
                    disabled={!!busy}
                  >
                    {uiLang === "en"
                      ? "Apply & Restart"
                      : "\u5e94\u7528\u5e76\u91cd\u542f"}
                  </button>
                </div>

                <div className="grid" style={{ marginTop: 8 }}>
                  <label className="field">
                    <div className="label">Q4_K_M path</div>
                    <input
                      className="input"
                      value={devConfigDraft.llama_model_q4_path ?? ""}
                      onChange={(e: ChangeEvent<HTMLInputElement>) =>
                        setDevConfigDraft((d) => ({
                          ...d,
                          llama_model_q4_path: e.target.value,
                        }))
                      }
                      placeholder="e.g. F:\\LLAMA\\models\\...\\Q4_K_M.gguf"
                    />
                  </label>
                  <div className="field">
                    <div className="label">{uiLang === "en" ? "Pick" : "\u9009\u62e9"}</div>
                    <button
                      className="btn"
                      onClick={() => void pickPresetModel("q4")}
                      disabled={!!busy}
                    >
                      {t("pick_file")}
                    </button>
                  </div>

                  <label className="field">
                    <div className="label">Q5_K_M path</div>
                    <input
                      className="input"
                      value={devConfigDraft.llama_model_q5_path ?? ""}
                      onChange={(e: ChangeEvent<HTMLInputElement>) =>
                        setDevConfigDraft((d) => ({
                          ...d,
                          llama_model_q5_path: e.target.value,
                        }))
                      }
                      placeholder="e.g. F:\\LLAMA\\models\\...\\Q5_K_M.gguf"
                    />
                  </label>
                  <div className="field">
                    <div className="label">{uiLang === "en" ? "Pick" : "\u9009\u62e9"}</div>
                    <button
                      className="btn"
                      onClick={() => void pickPresetModel("q5")}
                      disabled={!!busy}
                    >
                      {t("pick_file")}
                    </button>
                  </div>

                  <label className="field">
                    <div className="label">{uiLang === "en" ? "Small model path" : "\u5c0f\u6a21\u578b\u8def\u5f84"}</div>
                    <input
                      className="input"
                      value={devConfigDraft.llama_model_small_path ?? ""}
                      onChange={(e: ChangeEvent<HTMLInputElement>) =>
                        setDevConfigDraft((d) => ({
                          ...d,
                          llama_model_small_path: e.target.value,
                        }))
                      }
                      placeholder="e.g. F:\\LLAMA\\models\\...\\small.gguf"
                    />
                  </label>
                  <div className="field">
                    <div className="label">{uiLang === "en" ? "Pick" : "\u9009\u62e9"}</div>
                    <button
                      className="btn"
                      onClick={() => void pickPresetModel("small")}
                      disabled={!!busy}
                    >
                      {t("pick_file")}
                    </button>
                  </div>
                </div>
              </div>

              <label className="field">
                <div className="label">llama_model_path</div>
                <input
                  className="input"
                  value={devConfigDraft.llama_model_path ?? ""}
                  onChange={(e: ChangeEvent<HTMLInputElement>) =>
                    setDevConfigDraft((d) => ({
                      ...d,
                      llama_model_path: e.target.value,
                    }))
                  }
                  placeholder="e.g. F:\\LLAMA\\models\\...\\xxx.gguf"
                />
              </label>

              <div className="field">
                <div className="label">{"\u9009\u62e9 GGUF \u6a21\u578b"}</div>
                <button
                  className="btn"
                  onClick={pickLlamaModel}
                  disabled={!!busy}
                >
                  {t("pick_file")}
                </button>
              </div>

              <label className="field">
                <div className="label">llama_port</div>
                <input
                  className="input"
                  value={devConfigDraft.llama_port ?? ""}
                  onChange={(e: ChangeEvent<HTMLInputElement>) =>
                    setDevConfigDraft((d) => ({
                      ...d,
                      llama_port: toNumberOrUndefined(e.target.value),
                    }))
                  }
                  inputMode="numeric"
                  placeholder="8080"
                />
              </label>

              <label className="field">
                <div className="label">local_llm_base_url</div>
                <input
                  className="input"
                  value={devConfigDraft.local_llm_base_url ?? ""}
                  onChange={(e: ChangeEvent<HTMLInputElement>) =>
                    setDevConfigDraft((d) => ({
                      ...d,
                      local_llm_base_url: e.target.value,
                    }))
                  }
                  placeholder="http://127.0.0.1:8080/v1"
                />
              </label>

              <label className="field">
                <div className="label">backend_base_url</div>
                <input
                  className="input"
                  value={devConfigDraft.backend_base_url ?? ""}
                  onChange={(e: ChangeEvent<HTMLInputElement>) =>
                    setDevConfigDraft((d) => ({
                      ...d,
                      backend_base_url: e.target.value,
                    }))
                  }
                  placeholder="http://127.0.0.1:8001"
                />
              </label>
            </div>

            <div className="row">
              <button
                className="btn primary"
                onClick={saveDevConfig}
                disabled={!!busy}
              >
                {t("save_local_launch")}
              </button>
            </div>
          </>
        ) : (
          <div className="muted">{t("not_electron")}</div>
        )}
      </div>

      <div className="card">
        <h3>{t("diagnostics")}</h3>
        <div className="row">
          <button className="btn" onClick={refreshDiagnostics} disabled={!!busy}>
            {t("refresh_diagnostics")}
          </button>
          {window.edgeVideoAgent?.isPackaged && window.electronAPI?.exportDataZip ? (
            <button className="btn" onClick={() => void exportDataZip()} disabled={!!busy}>
              {uiLang === "en" ? "Export data (zip)" : "\u5bfc\u51fa\u6570\u636e\uff08zip\uff09"}
            </button>
          ) : null}
          {window.edgeVideoAgent?.isPackaged && window.electronAPI?.restoreDataZip ? (
            <button className="btn" onClick={() => void restoreDataZip()} disabled={!!busy}>
              {uiLang === "en" ? "Restore data (zip)" : "\u6062\u590d\u6570\u636e\uff08zip\uff09"}
            </button>
          ) : null}
          <button
            className="btn"
            onClick={() => openFirstRunWizard(false)}
            disabled={!!busy}
            title={
              uiLang === "en"
                ? "Open the first-run wizard"
                : "\u91cd\u65b0\u6253\u5f00\u9996\u6b21\u8fd0\u884c\u5411\u5bfc"
            }
          >
            {uiLang === "en" ? "Open Wizard" : "\u6253\u5f00\u5411\u5bfc"}
          </button>
          <button
            className="btn"
            onClick={() => openFirstRunWizard(true)}
            disabled={!!busy}
            title={
              uiLang === "en"
                ? "Reset wizard completion flag and open"
                : "\u91cd\u7f6e\u5411\u5bfc\u5b8c\u6210\u72b6\u6001\u5e76\u6253\u5f00"
            }
          >
            {uiLang === "en"
              ? "Reset + Open"
              : "\u91cd\u7f6e\u5e76\u6253\u5f00"}
          </button>
        </div>

        {diagnostics ? (
          <div className="subcard" style={{ marginTop: 8 }}>
            <div className="kv">
              <div className="k">data_dir</div>
              <div className="v" style={{ wordBreak: "break-all" }}>{String(diagnostics.backend?.data_dir || "")}</div>
            </div>
            <div className="kv">
              <div className="k">disk_free</div>
              <div className="v">{String((diagnostics.backend as any)?.disk?.free ?? "")}</div>
            </div>
            <div className="kv">
              <div className="k">ffmpeg</div>
              <div className={(diagnostics.ffmpeg?.ok ? "v ok" : "v bad")}>{String(!!diagnostics.ffmpeg?.ok)}</div>
            </div>
            {diagnostics.ffmpeg?.ffmpeg ? (
              <div className="muted" style={{ wordBreak: "break-all" }}>
                ffmpeg: {String(diagnostics.ffmpeg.ffmpeg)}
              </div>
            ) : null}

            {(() => {
              const cc = (diagnostics as any)?.runtime?.concurrency;
              if (!cc) return null;

              const asr = (cc?.limiters?.asr || {}) as any;
              const llm = (cc?.limiters?.llm || {}) as any;
              const heavy = (cc?.limiters?.heavy || {}) as any;
              const to = (cc?.timeouts || {}) as any;

              const asrMax = Number(asr.max ?? 0);
              const llmMax = Number(llm.max ?? 0);
              const heavyMax = Number(heavy.max ?? 0);

              const asrIn = Number(asr.in_use ?? 0);
              const llmIn = Number(llm.in_use ?? 0);
              const heavyIn = Number(heavy.in_use ?? 0);

              const cls = (inUse: number, max: number) => {
                if (max <= 0) return "v";
                return inUse >= max ? "v bad" : "v ok";
              };

              return (
                <div className="subcard" style={{ marginTop: 8 }}>
                  <div className="label">
                    {uiLang === "en" ? "Concurrency" : "\u5e76\u53d1\u5360\u7528"}
                  </div>

                  <div className="kv">
                    <div className="k">asr</div>
                    <div className={cls(asrIn, asrMax)}>
                      {String(asrIn)}/{String(asrMax)}
                      {typeof to.asr === "number" ? ` (timeout ${to.asr}s)` : ""}
                    </div>
                  </div>

                  <div className="kv">
                    <div className="k">llm</div>
                    <div className={cls(llmIn, llmMax)}>
                      {String(llmIn)}/{String(llmMax)}
                      {typeof to.llm === "number" ? ` (timeout ${to.llm}s)` : ""}
                    </div>
                  </div>

                  <div className="kv">
                    <div className="k">heavy</div>
                    <div className={cls(heavyIn, heavyMax)}>
                      {String(heavyIn)}/{String(heavyMax)}
                      {typeof to.heavy === "number" ? ` (timeout ${to.heavy}s)` : ""}
                    </div>
                  </div>

                  <div className="muted" style={{ marginTop: 6 }}>
                    {uiLang === "en"
                      ? "Saturated (= max) means new tasks will wait or timeout."
                      : "\u5f53\u5360\u7528\u8fbe\u5230 max \u65f6\uff0c\u65b0\u4efb\u52a1\u4f1a\u7b49\u5f85\u6216\u8d85\u65f6\u3002"}
                  </div>
                </div>
              );
            })()}

            <div className="subcard" style={{ marginTop: 8 }}>
              <div className="label">HF cache</div>
              <div className="muted" style={{ wordBreak: "break-all" }}>
                HF_HOME: {String((diagnostics.huggingface as any)?.HF_HOME || "")}
              </div>
              <div className="muted" style={{ wordBreak: "break-all" }}>
                HF_HUB_CACHE: {String((diagnostics.huggingface as any)?.HF_HUB_CACHE || "")}
              </div>
              {diagnostics.hints?.move_hf_cache_powershell ? (
                <>
                  <div className="muted" style={{ marginTop: 6 }}>
                    {uiLang === "en"
                      ? "Tip: set HF cache to a larger drive (restart app after setting)"
                      : "\u5efa\u8bae\u5c06 HF \u7f13\u5b58\u6307\u5411\u5927\u5bb9\u91cf\u78c1\u76d8\uff08\u8bbe\u7f6e\u540e\u9700\u91cd\u542f\u5e94\u7528\u751f\u6548\uff09"}
                  </div>
                  <pre className="pre" style={{ marginTop: 6 }}>
                    {String(diagnostics.hints.move_hf_cache_powershell)}
                  </pre>
                  <div className="row">
                    <button
                      className="btn"
                      onClick={() =>
                        void copyText(
                          String(diagnostics.hints?.move_hf_cache_powershell || ""),
                          uiLang === "en" ? "Copied" : "\u5df2\u590d\u5236"
                        )
                      }
                      disabled={!!busy}
                    >
                      {uiLang === "en" ? "Copy" : "\u590d\u5236"}
                    </button>
                  </div>
                </>
              ) : null}
            </div>
          </div>
        ) : (
          <div className="muted" style={{ marginTop: 8 }}>
            {uiLang === "en"
              ? "Diagnostics not loaded"
              : "\u5c1a\u672a\u83b7\u53d6\u81ea\u68c0\u4fe1\u606f"}
          </div>
        )}
      </div>
    </div>
  );
}
