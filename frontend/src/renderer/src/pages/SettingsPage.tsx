import { useCallback, useEffect, useMemo, useState } from "react";
import type { ChangeEvent } from "react";
import {
  api,
  AsrModelStatusResponse,
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
  llm_timeout_seconds?: number;
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
  llama_port?: number;
  local_llm_base_url?: string;
  backend_base_url?: string;
};

function toNumberOrUndefined(v: string): number | undefined {
  const s = (v ?? "").trim();
  if (!s) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
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

  const [devConfigPath, setDevConfigPath] = useState<string | null>(null);
  const [devConfigDraft, setDevConfigDraft] = useState<DevConfigDraft>({});

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

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
      return "\u5c1a\u672a\u83b7\u53d6\u72b6\u6001\uff08\u70b9\u51fb\u201c\u5237\u65b0\u72b6\u6001\u201d\uff09";
    },
    [uiLang]
  );

  const loadAll = useCallback(async () => {
    setError(null);
    setInfo(null);
    setBusy("loading");
    try {
      const [rt, llm, prov, status, asr, devCfg] = await Promise.all([
        api.getRuntimeProfile(),
        api.getDefaultLlmPreferences(),
        api.listLlmProviders(),
        api.getLocalLlmStatus().catch(() => null),
        api.getAsrModelStatus().catch(() => null),
        window.electronAPI?.getDevConfig
          ? window.electronAPI.getDevConfig().catch(() => null)
          : Promise.resolve(null),
      ]);

      setRuntime(rt);
      const rawProfile = String((rt.preferences as any)?.profile ?? "balanced");
      const normalizedProfile =
        rawProfile === "gpu" ? "gpu_recommended" : rawProfile;
      setRuntimeDraft({
        profile: normalizedProfile,
        asr_concurrency: (rt.preferences as any)?.asr_concurrency,
        llm_concurrency: (rt.preferences as any)?.llm_concurrency,
        llm_timeout_seconds: (rt.preferences as any)?.llm_timeout_seconds,
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

      if (devCfg && typeof devCfg === "object") {
        const p = String((devCfg as any).path || "");
        const cfg = ((devCfg as any).config || {}) as Record<string, unknown>;
        setDevConfigPath(p || null);
        setDevConfigDraft({
          llama_server_exe: String(cfg.llama_server_exe || ""),
          llama_model_path: String(cfg.llama_model_path || ""),
          llama_port:
            typeof cfg.llama_port === "number"
              ? (cfg.llama_port as number)
              : undefined,
          local_llm_base_url: String(cfg.local_llm_base_url || ""),
          backend_base_url: String(cfg.backend_base_url || ""),
        });
      }
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setBusy(null);
    }
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const saveRuntime = useCallback(async () => {
    setError(null);
    setInfo(null);
    setBusy("saving_runtime");
    try {
      const payload: Record<string, unknown> = {
        profile: runtimeDraft.profile,
        asr_concurrency: runtimeDraft.asr_concurrency,
        llm_concurrency: runtimeDraft.llm_concurrency,
        llm_timeout_seconds: runtimeDraft.llm_timeout_seconds,
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
      const port = devConfigDraft.llama_port;
      const baseUrlRaw = String(devConfigDraft.local_llm_base_url || "").trim();
      const baseUrl =
        baseUrlRaw ||
        (typeof port === "number" && Number.isFinite(port)
          ? `http://127.0.0.1:${port}/v1`
          : "");

      const payload: Record<string, unknown> = {
        llama_server_exe: String(devConfigDraft.llama_server_exe || "").trim(),
        llama_model_path: String(devConfigDraft.llama_model_path || "").trim(),
        llama_port:
          typeof port === "number" && Number.isFinite(port) ? port : undefined,
        local_llm_base_url: baseUrl,
        backend_base_url: String(devConfigDraft.backend_base_url || "").trim(),
      };

      const res = await window.electronAPI.setDevConfig(payload);
      setDevConfigPath(String((res as any).path || "") || null);

      const cfg = ((res as any).config || {}) as Record<string, unknown>;
      setDevConfigDraft({
        llama_server_exe: String(cfg.llama_server_exe || ""),
        llama_model_path: String(cfg.llama_model_path || ""),
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
            {t("asr_large_v3")} | local: {asrStatus?.local?.ok ? "OK" : "NOT_FOUND"} | download: {asrStatus?.download?.ok ? "OK" : "ERROR"}
          </div>
          {asrStatus ? (
            <div style={{ marginTop: 8 }}>
              {asrStatus?.huggingface_hub?.version ? (
                <div className="muted">huggingface_hub: {String(asrStatus.huggingface_hub.version)}</div>
              ) : null}

              {asrStatus?.local?.error ? (
                <div className="alert alert-error">{String(asrStatus.local.error)}</div>
              ) : null}

              {asrStatus?.download?.ok ? null : asrStatus?.download?.error ? (
                <div className="alert alert-error">{String(asrStatus.download.error)}</div>
              ) : null}

              {Array.isArray((asrStatus as any)?.local?.missing_files) && (asrStatus as any).local.missing_files.length ? (
                <div className="subcard" style={{ marginTop: 8 }}>
                  <div className="label">{uiLang === "en" ? "Missing files" : "缺失文件"}</div>
                  <pre className="pre">{String(((asrStatus as any).local.missing_files as any[]).join("\n"))}</pre>
                </div>
              ) : null}

              <div className="grid" style={{ marginTop: 8 }}>
                <div className="field">
                  <div className="label">repo</div>
                  <div className="muted" style={{ wordBreak: "break-all" }}>
                    {String(asrStatus?.download?.repo_url || `https://huggingface.co/${String(asrStatus.repo_id || "")}`)}
                  </div>
                  <div className="row">
                    <button
                      className="btn"
                      onClick={() => {
                        const url = String(
                          asrStatus?.download?.repo_url || `https://huggingface.co/${String(asrStatus.repo_id || "")}`
                        );
                        window.open(url, "_blank");
                      }}
                      disabled={!!busy}
                    >
                      {uiLang === "en" ? "Open" : "打开"}
                    </button>
                    <button
                      className="btn"
                      onClick={() => {
                        const url = String(
                          asrStatus?.download?.repo_url || `https://huggingface.co/${String(asrStatus.repo_id || "")}`
                        );
                        void copyText(url, uiLang === "en" ? "Copied" : "已复制");
                      }}
                      disabled={!!busy}
                    >
                      {uiLang === "en" ? "Copy" : "复制"}
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
                      {uiLang === "en" ? "Open" : "打开"}
                    </button>
                    <button
                      className="btn"
                      onClick={() => {
                        const url = String(asrStatus?.download?.url || "");
                        if (!url) return;
                        void copyText(url, uiLang === "en" ? "Copied" : "已复制");
                      }}
                      disabled={!!busy || !asrStatus?.download?.url}
                    >
                      {uiLang === "en" ? "Copy" : "复制"}
                    </button>
                  </div>
                </div>
              </div>

              <div className="subcard" style={{ marginTop: 8 }}>
                <div className="label">{uiLang === "en" ? "Download via Python" : "使用 Python 下载"}</div>
                <pre className="pre">
                  {`python -c "from huggingface_hub import snapshot_download; snapshot_download(repo_id='${String(asrStatus.repo_id || "Systran/faster-whisper-large-v3")}')"`}
                </pre>
                <div className="row">
                  <button
                    className="btn"
                    onClick={() => {
                      const cmd = `python -c "from huggingface_hub import snapshot_download; snapshot_download(repo_id='${String(
                        asrStatus.repo_id || "Systran/faster-whisper-large-v3"
                      )}')"`;
                      void copyText(cmd, uiLang === "en" ? "Copied" : "已复制");
                    }}
                    disabled={!!busy}
                  >
                    {uiLang === "en" ? "Copy command" : "复制命令"}
                  </button>
                </div>
                <div className="muted" style={{ marginTop: 6 }}>
                  {uiLang === "en"
                    ? "This downloads into the Hugging Face cache. If download is ERROR, check network/proxy or try from browser."
                    : "该命令会下载到 Hugging Face 缓存目录；如 download=ERROR，通常是网络/代理问题，可先用浏览器打开链接验证。"}
                </div>
              </div>

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
              <div className="alert alert-error">{localStatus.error}</div>
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
    </div>
  );
}
