import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ChangeEvent } from 'react'
import { api, LlmLocalStatusResponse, RuntimeProfileResponse } from '../api/backend'

type RuntimeDraft = {
  profile?: string
  asr_concurrency?: number
  llm_concurrency?: number
  llm_timeout_seconds?: number
  asr_device?: string
  asr_compute_type?: string
}

type LlmDraft = {
  provider?: string
  model?: string | null
  temperature?: number
  max_tokens?: number
}

type DevConfigDraft = {
  llama_server_exe?: string
  llama_model_path?: string
  llama_port?: number
  local_llm_base_url?: string
}

function toNumberOrUndefined(v: string): number | undefined {
  const s = (v ?? '').trim()
  if (!s) return undefined
  const n = Number(s)
  return Number.isFinite(n) ? n : undefined
}

export default function SettingsPage() {
  const [runtime, setRuntime] = useState<RuntimeProfileResponse | null>(null)
  const [runtimeDraft, setRuntimeDraft] = useState<RuntimeDraft>({})
  const [llmDraft, setLlmDraft] = useState<LlmDraft>({})
  const [providers, setProviders] = useState<string[]>([])
  const [localStatus, setLocalStatus] = useState<LlmLocalStatusResponse | null>(null)

  const [devConfigPath, setDevConfigPath] = useState<string | null>(null)
  const [devConfigDraft, setDevConfigDraft] = useState<DevConfigDraft>({})

  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)

  const loadAll = useCallback(async () => {
    setError(null)
    setInfo(null)
    setBusy('loading')
    try {
      const [rt, llm, prov, status, devCfg] = await Promise.all([
        api.getRuntimeProfile(),
        api.getDefaultLlmPreferences(),
        api.listLlmProviders(),
        api.getLocalLlmStatus().catch(() => null),
        window.electronAPI?.getDevConfig ? window.electronAPI.getDevConfig().catch(() => null) : Promise.resolve(null)
      ])

      setRuntime(rt)
      setRuntimeDraft({
        profile: String((rt.preferences as any)?.profile ?? 'balanced'),
        asr_concurrency: (rt.preferences as any)?.asr_concurrency,
        llm_concurrency: (rt.preferences as any)?.llm_concurrency,
        llm_timeout_seconds: (rt.preferences as any)?.llm_timeout_seconds,
        asr_device: (rt.preferences as any)?.asr_device,
        asr_compute_type: (rt.preferences as any)?.asr_compute_type
      })

      setLlmDraft({
        provider: llm.preferences?.provider ?? 'fake',
        model: llm.preferences?.model ?? null,
        temperature: llm.preferences?.temperature ?? 0.2,
        max_tokens: llm.preferences?.max_tokens ?? 512
      })

      setProviders(prov.providers || [])
      if (status) {
        setLocalStatus(status)
      }

      if (devCfg && typeof devCfg === 'object') {
        const p = String((devCfg as any).path || '')
        const cfg = ((devCfg as any).config || {}) as Record<string, unknown>
        setDevConfigPath(p || null)
        setDevConfigDraft({
          llama_server_exe: String(cfg.llama_server_exe || ''),
          llama_model_path: String(cfg.llama_model_path || ''),
          llama_port: typeof cfg.llama_port === 'number' ? (cfg.llama_port as number) : undefined,
          local_llm_base_url: String(cfg.local_llm_base_url || '')
        })
      }
    } catch (e: any) {
      setError(String(e?.message || e))
    } finally {
      setBusy(null)
    }
  }, [])

  useEffect(() => {
    void loadAll()
  }, [loadAll])

  const saveRuntime = useCallback(async () => {
    setError(null)
    setInfo(null)
    setBusy('saving_runtime')
    try {
      const payload: Record<string, unknown> = {
        profile: runtimeDraft.profile,
        asr_concurrency: runtimeDraft.asr_concurrency,
        llm_concurrency: runtimeDraft.llm_concurrency,
        llm_timeout_seconds: runtimeDraft.llm_timeout_seconds,
        asr_device: runtimeDraft.asr_device,
        asr_compute_type: runtimeDraft.asr_compute_type
      }
      const res = await api.setRuntimeProfile(payload)
      setRuntime(res)
      setInfo('\u8fd0\u884c\u65f6\u914d\u7f6e\u5df2\u4fdd\u5b58')
    } catch (e: any) {
      setError(String(e?.message || e))
    } finally {
      setBusy(null)
    }
  }, [runtimeDraft])

  const saveLlm = useCallback(async () => {
    setError(null)
    setInfo(null)
    setBusy('saving_llm')
    try {
      const payload = {
        provider: String(llmDraft.provider || '').trim(),
        model: llmDraft.model ?? null,
        temperature: Number(llmDraft.temperature ?? 0.2),
        max_tokens: Number(llmDraft.max_tokens ?? 512)
      }
      await api.setDefaultLlmPreferences(payload)
      setInfo('\u9ed8\u8ba4 LLM \u504f\u597d\u5df2\u4fdd\u5b58')
    } catch (e: any) {
      setError(String(e?.message || e))
    } finally {
      setBusy(null)
    }
  }, [llmDraft])

  const refreshLocalStatus = useCallback(async () => {
    setError(null)
    setInfo(null)
    setBusy('refreshing_status')
    try {
      const res = await api.getLocalLlmStatus()
      setLocalStatus(res)
    } catch (e: any) {
      setError(String(e?.message || e))
    } finally {
      setBusy(null)
    }
  }, [])

  const saveDevConfig = useCallback(async () => {
    if (!window.electronAPI?.setDevConfig) {
      setError('\u5f53\u524d\u4e0d\u662f Electron \u73af\u5883\uff0c\u65e0\u6cd5\u4fdd\u5b58\u672c\u5730\u542f\u52a8\u914d\u7f6e')
      return
    }
    setError(null)
    setInfo(null)
    setBusy('saving_dev_config')
    try {
      const port = devConfigDraft.llama_port
      const baseUrlRaw = String(devConfigDraft.local_llm_base_url || '').trim()
      const baseUrl =
        baseUrlRaw || (typeof port === 'number' && Number.isFinite(port) ? `http://127.0.0.1:${port}/v1` : '')

      const payload: Record<string, unknown> = {
        llama_server_exe: String(devConfigDraft.llama_server_exe || '').trim(),
        llama_model_path: String(devConfigDraft.llama_model_path || '').trim(),
        llama_port: typeof port === 'number' && Number.isFinite(port) ? port : undefined,
        local_llm_base_url: baseUrl
      }

      const res = await window.electronAPI.setDevConfig(payload)
      setDevConfigPath(String((res as any).path || '') || null)

      const cfg = ((res as any).config || {}) as Record<string, unknown>
      setDevConfigDraft({
        llama_server_exe: String(cfg.llama_server_exe || ''),
        llama_model_path: String(cfg.llama_model_path || ''),
        llama_port: typeof cfg.llama_port === 'number' ? (cfg.llama_port as number) : undefined,
        local_llm_base_url: String(cfg.local_llm_base_url || '')
      })

      setInfo('\u672c\u5730 llama-server \u542f\u52a8\u914d\u7f6e\u5df2\u4fdd\u5b58')
    } catch (e: any) {
      setError(String(e?.message || e))
    } finally {
      setBusy(null)
    }
  }, [devConfigDraft])

  const pickLlamaExe = useCallback(async () => {
    if (!window.electronAPI?.pickLlamaServerExe) {
      return
    }
    const p = await window.electronAPI.pickLlamaServerExe()
    if (p) {
      setDevConfigDraft((d) => ({ ...d, llama_server_exe: p }))
    }
  }, [])

  const pickLlamaModel = useCallback(async () => {
    if (!window.electronAPI?.pickLlamaModel) {
      return
    }
    const p = await window.electronAPI.pickLlamaModel()
    if (p) {
      setDevConfigDraft((d) => ({ ...d, llama_model_path: p }))
    }
  }, [])

  const effective = useMemo(() => {
    return runtime?.effective ?? null
  }, [runtime])

  const onRuntimeProfileChange = useCallback(
    (e: ChangeEvent<HTMLSelectElement>) => {
      setRuntimeDraft((d) => ({ ...d, profile: e.target.value }))
    },
    []
  )

  return (
    <div className="stack">
      <div className="card">
        <h2>{'\u8bbe\u7f6e'}</h2>
        <div className="muted">{'\u540e\u7aef\uff1a\u8bf7\u5148\u542f\u52a8 backend\uff08\u9ed8\u8ba4 http://127.0.0.1:8001\uff09'}</div>
        {error ? <div className="alert alert-error">{error}</div> : null}
        {info ? <div className="alert alert-info">{info}</div> : null}
        <div className="row">
          <button className="btn" onClick={loadAll} disabled={!!busy}>
            {'\u5237\u65b0\u5168\u90e8'}
          </button>
        </div>
      </div>

      <div className="card">
        <h3>{'\u8fd0\u884c\u65f6\u914d\u7f6e\uff08Runtime Profile\uff09'}</h3>
        <div className="grid">
          <label className="field">
            <div className="label">profile</div>
            <select
              className="input"
              value={runtimeDraft.profile ?? 'balanced'}
              onChange={onRuntimeProfileChange}
            >
              <option value="balanced">balanced</option>
              <option value="cpu">cpu</option>
              <option value="gpu">gpu</option>
            </select>
          </label>

          <label className="field">
            <div className="label">asr_concurrency</div>
            <input
              className="input"
              value={runtimeDraft.asr_concurrency ?? ''}
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                setRuntimeDraft((d) => ({
                  ...d,
                  asr_concurrency: toNumberOrUndefined(e.target.value)
                }))
              }
              inputMode="numeric"
            />
          </label>

          <label className="field">
            <div className="label">llm_concurrency</div>
            <input
              className="input"
              value={runtimeDraft.llm_concurrency ?? ''}
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                setRuntimeDraft((d) => ({
                  ...d,
                  llm_concurrency: toNumberOrUndefined(e.target.value)
                }))
              }
              inputMode="numeric"
            />
          </label>

          <label className="field">
            <div className="label">llm_timeout_seconds</div>
            <input
              className="input"
              value={runtimeDraft.llm_timeout_seconds ?? ''}
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                setRuntimeDraft((d) => ({
                  ...d,
                  llm_timeout_seconds: toNumberOrUndefined(e.target.value)
                }))
              }
              inputMode="numeric"
            />
          </label>

          <label className="field">
            <div className="label">asr_device</div>
            <input
              className="input"
              value={runtimeDraft.asr_device ?? ''}
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
              value={runtimeDraft.asr_compute_type ?? ''}
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                setRuntimeDraft((d) => ({ ...d, asr_compute_type: e.target.value }))
              }
              placeholder="int8 / float16"
            />
          </label>
        </div>

        <div className="row">
          <button className="btn primary" onClick={saveRuntime} disabled={!!busy}>
            {'\u4fdd\u5b58\u8fd0\u884c\u65f6\u914d\u7f6e'}
          </button>
        </div>

        {effective ? (
          <div className="subcard">
            <div className="label">effective</div>
            <pre className="pre">{JSON.stringify(effective, null, 2)}</pre>
          </div>
        ) : null}
      </div>

      <div className="card">
        <h3>{'\u9ed8\u8ba4 LLM \u504f\u597d'}</h3>
        <div className="grid">
          <label className="field">
            <div className="label">provider</div>
            <select
              className="input"
              value={llmDraft.provider ?? 'fake'}
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
                <option value={llmDraft.provider ?? 'fake'}>{llmDraft.provider ?? 'fake'}</option>
              )}
            </select>
          </label>

          <label className="field">
            <div className="label">model</div>
            <input
              className="input"
              value={llmDraft.model ?? ''}
              onChange={(e: ChangeEvent<HTMLInputElement>) => {
                const v = String(e.target.value || '').trim()
                setLlmDraft((d) => ({ ...d, model: v ? v : null }))
              }}
              placeholder="e.g. Qwen2.5-7B-Instruct"
            />
          </label>

          <label className="field">
            <div className="label">temperature</div>
            <input
              className="input"
              value={llmDraft.temperature ?? ''}
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                setLlmDraft((d) => ({
                  ...d,
                  temperature: toNumberOrUndefined(e.target.value)
                }))
              }
            />
          </label>

          <label className="field">
            <div className="label">max_tokens</div>
            <input
              className="input"
              value={llmDraft.max_tokens ?? ''}
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                setLlmDraft((d) => ({
                  ...d,
                  max_tokens: toNumberOrUndefined(e.target.value)
                }))
              }
              inputMode="numeric"
            />
          </label>
        </div>

        <div className="row">
          <button className="btn primary" onClick={saveLlm} disabled={!!busy}>
            {'\u4fdd\u5b58\u9ed8\u8ba4 LLM \u504f\u597d'}
          </button>
        </div>
      </div>

      <div className="card">
        <h3>{'\u672c\u5730 llama-server \u72b6\u6001'}</h3>
        <div className="row">
          <button className="btn" onClick={refreshLocalStatus} disabled={!!busy}>
            {'\u5237\u65b0\u72b6\u6001'}
          </button>
        </div>

        {localStatus ? (
          <div className="subcard">
            <div className="kv">
              <div className="k">ok</div>
              <div className={localStatus.ok ? 'v ok' : 'v bad'}>{String(localStatus.ok)}</div>
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
                <pre className="pre">{JSON.stringify(localStatus.models, null, 2)}</pre>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="muted">{'\u5c1a\u672a\u83b7\u53d6\u72b6\u6001\uff08\u70b9\u51fb\u201c\u5237\u65b0\u72b6\u6001\u201d\uff09'}</div>
        )}
      </div>

      <div className="card">
        <h3>{'\u672c\u5730 llama-server \u542f\u52a8\u914d\u7f6e'}</h3>
        <div className="muted">
          {'\u8be5\u914d\u7f6e\u7528\u4e8e\u4e00\u952e\u542f\u52a8\uff08\u5199\u5165 artifacts/dev_config.json\uff09\uff1b\u968f\u540e\u6267\u884c '}<code>start_dev.cmd -StartLlama</code>{' \u4f1a\u81ea\u52a8\u8bfb\u53d6\u3002'}
        </div>
        {devConfigPath ? <div className="muted">{'\u914d\u7f6e\u6587\u4ef6\uff1a'}{devConfigPath}</div> : null}

        {window.electronAPI?.setDevConfig ? (
          <>
            <div className="grid">
              <label className="field">
                <div className="label">llama_server_exe</div>
                <input
                  className="input"
                  value={devConfigDraft.llama_server_exe ?? ''}
                  onChange={(e: ChangeEvent<HTMLInputElement>) =>
                    setDevConfigDraft((d) => ({ ...d, llama_server_exe: e.target.value }))
                  }
                  placeholder="e.g. F:\\LLAMA\\bin\\llama-server.exe"
                />
              </label>

              <div className="field">
                <div className="label">{'\u9009\u62e9 llama-server.exe'}</div>
                <button className="btn" onClick={pickLlamaExe} disabled={!!busy}>
                  {'\u9009\u62e9\u6587\u4ef6'}
                </button>
              </div>

              <label className="field">
                <div className="label">llama_model_path</div>
                <input
                  className="input"
                  value={devConfigDraft.llama_model_path ?? ''}
                  onChange={(e: ChangeEvent<HTMLInputElement>) =>
                    setDevConfigDraft((d) => ({ ...d, llama_model_path: e.target.value }))
                  }
                  placeholder="e.g. F:\\LLAMA\\models\\...\\xxx.gguf"
                />
              </label>

              <div className="field">
                <div className="label">{'\u9009\u62e9 GGUF \u6a21\u578b'}</div>
                <button className="btn" onClick={pickLlamaModel} disabled={!!busy}>
                  {'\u9009\u62e9\u6587\u4ef6'}
                </button>
              </div>

              <label className="field">
                <div className="label">llama_port</div>
                <input
                  className="input"
                  value={devConfigDraft.llama_port ?? ''}
                  onChange={(e: ChangeEvent<HTMLInputElement>) =>
                    setDevConfigDraft((d) => ({ ...d, llama_port: toNumberOrUndefined(e.target.value) }))
                  }
                  inputMode="numeric"
                  placeholder="8080"
                />
              </label>

              <label className="field">
                <div className="label">local_llm_base_url</div>
                <input
                  className="input"
                  value={devConfigDraft.local_llm_base_url ?? ''}
                  onChange={(e: ChangeEvent<HTMLInputElement>) =>
                    setDevConfigDraft((d) => ({ ...d, local_llm_base_url: e.target.value }))
                  }
                  placeholder="http://127.0.0.1:8080/v1"
                />
              </label>
            </div>

            <div className="row">
              <button className="btn primary" onClick={saveDevConfig} disabled={!!busy}>
                {'\u4fdd\u5b58\u672c\u5730\u542f\u52a8\u914d\u7f6e'}
              </button>
            </div>
          </>
        ) : (
          <div className="muted">{'\u5f53\u524d\u4e0d\u662f Electron \u73af\u5883\uff08\u6216 preload \u672a\u542f\u7528\uff09\uff0c\u6b64\u5904\u65e0\u6cd5\u4fdd\u5b58\u542f\u52a8\u914d\u7f6e\u3002'}</div>
        )}
      </div>
    </div>
  )
}
