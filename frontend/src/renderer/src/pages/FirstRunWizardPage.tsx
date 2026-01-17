import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, DiagnosticsResponse } from '../api/backend'
import { LoadingState } from '../ui/States'

type UiLang = 'zh' | 'en'

type Props = {
  uiLang: UiLang
  onDone: () => void
}

function formatBytes(n?: number): string {
  const v = typeof n === 'number' ? n : 0
  if (!v || v < 0) return '0'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let x = v
  let i = 0
  while (x >= 1024 && i < units.length - 1) {
    x /= 1024
    i += 1
  }
  return `${x.toFixed(i === 0 ? 0 : 2)} ${units[i]}`
}

export default function FirstRunWizardPage({ uiLang, onDone }: Props) {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [diag, setDiag] = useState<DiagnosticsResponse | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const steps = useMemo(
    () => ['welcome', 'deps', 'asr', 'llm', 'finish'] as const,
    []
  )
  const [stepIndex, setStepIndex] = useState<number>(0)

  const t = useCallback(
    (
      key:
        | 'title'
        | 'refresh'
        | 'skip'
        | 'subtitle'
        | 'back'
        | 'next'
        | 'finish'
        | 'copy'
        | 'copied'
        | 'step_welcome'
        | 'step_deps'
        | 'step_asr'
        | 'step_llm'
        | 'step_finish'
        | 'welcome_title'
        | 'welcome_body'
        | 'deps_title'
        | 'deps_body'
        | 'asr_title'
        | 'asr_body'
        | 'llm_title'
        | 'llm_body'
        | 'finish_title'
        | 'finish_body'
        | 'ffmpeg'
        | 'disk'
        | 'asr'
        | 'llm'
        | 'hf_cache'
        | 'missing_required'
        | 'optional_missing'
        | 'download_python'
    ) => {
      if (uiLang === 'en') {
        if (key === 'title') return 'First-run wizard'
        if (key === 'subtitle')
          return 'Run a quick self-check for ffmpeg / models / llama-server before using the app.'
        if (key === 'refresh') return 'Refresh'
        if (key === 'skip') return 'Skip (do not show again)'
        if (key === 'back') return 'Back'
        if (key === 'next') return 'Next'
        if (key === 'finish') return 'Finish'
        if (key === 'copy') return 'Copy'
        if (key === 'copied') return 'Copied'
        if (key === 'step_welcome') return 'Welcome'
        if (key === 'step_deps') return 'Dependencies'
        if (key === 'step_asr') return 'ASR'
        if (key === 'step_llm') return 'Local LLM'
        if (key === 'step_finish') return 'Done'
        if (key === 'welcome_title') return 'Welcome'
        if (key === 'welcome_body')
          return 'This wizard helps you verify required components and provides copyable hints.'
        if (key === 'deps_title') return 'Dependencies'
        if (key === 'deps_body')
          return 'ffmpeg is required. Disk space affects model downloads and caching.'
        if (key === 'asr_title') return 'ASR (Whisper)'
        if (key === 'asr_body')
          return 'ASR requires model.bin and config.json. Some tokenizer files are optional.'
        if (key === 'llm_title') return 'Local LLM (llama-server)'
        if (key === 'llm_body')
          return 'Optional: start llama-server if you want local summarization.'
        if (key === 'finish_title') return 'All set'
        if (key === 'finish_body')
          return 'You can open Settings later to adjust models and runtime preferences.'
        if (key === 'ffmpeg') return 'ffmpeg'
        if (key === 'disk') return 'Disk'
        if (key === 'asr') return 'ASR (Whisper)'
        if (key === 'llm') return 'Local LLM (llama-server)'
        if (key === 'hf_cache') return 'Hugging Face cache'
        if (key === 'missing_required') return 'Missing required files (model not usable)'
        if (key === 'optional_missing') return 'Optional missing files (usually non-blocking)'
        if (key === 'download_python') return 'Download via Python'
      }
      if (key === 'title') return '\u9996\u6b21\u4f7f\u7528\u5411\u5bfc'
      if (key === 'subtitle')
        return '\u7528\u4e0d\u5230 1 \u5206\u949f\uff0c\u5b8c\u6210\u4e00\u6b21\u81ea\u68c0\uff0c\u5e76\u83b7\u53d6\u53ef\u590d\u5236\u7684\u6392\u969c\u4fe1\u606f\u3002'
      if (key === 'refresh') return '\u5237\u65b0'
      if (key === 'skip') return '\u8df3\u8fc7\uff08\u4e0d\u518d\u63d0\u9192\uff09'
      if (key === 'back') return '\u4e0a\u4e00\u6b65'
      if (key === 'next') return '\u4e0b\u4e00\u6b65'
      if (key === 'finish') return '\u5b8c\u6210\u5e76\u8fdb\u5165\u5de5\u4f5c\u533a'
      if (key === 'copy') return '\u590d\u5236'
      if (key === 'copied') return '\u5df2\u590d\u5236'
      if (key === 'step_welcome') return '\u6b22\u8fce'
      if (key === 'step_deps') return '\u57fa\u7840\u4f9d\u8d56'
      if (key === 'step_asr') return 'ASR \u6a21\u578b'
      if (key === 'step_llm') return '\u672c\u5730 LLM'
      if (key === 'step_finish') return '\u5b8c\u6210'
      if (key === 'welcome_title') return '\u6b22\u8fce\u4f7f\u7528 Edge Video Agent'
      if (key === 'welcome_body')
        return '\u8fd9\u4e2a\u5411\u5bfc\u5c06\u5e2e\u4f60\u68c0\u67e5\u5fc5\u8981\u7684\u8fd0\u884c\u73af\u5883\uff0c\u5e76\u7ed9\u51fa\u53ef\u4e00\u952e\u590d\u5236\u7684\u6392\u969c\u63d0\u793a\u3002'
      if (key === 'deps_title') return '\u68c0\u67e5\u57fa\u7840\u4f9d\u8d56'
      if (key === 'deps_body')
        return 'ffmpeg \u662f\u5f3a\u4f9d\u8d56\uff1b\u78c1\u76d8\u7a7a\u95f4\u4f1a\u76f4\u63a5\u5f71\u54cd\u6a21\u578b\u4e0b\u8f7d\u4e0e\u7f13\u5b58\u3002'
      if (key === 'asr_title') return '\u68c0\u67e5 ASR\uff08Whisper\uff09\u6a21\u578b'
      if (key === 'asr_body')
        return '\u8fd0\u884c ASR \u9700\u8981 model.bin + config.json\uff1btokenizer \u7b49\u6587\u4ef6\u591a\u6570\u662f\u53ef\u9009\u7684\uff0c\u4e0d\u5e94\u963b\u585e\u4f7f\u7528\u3002'
      if (key === 'llm_title') return '\u68c0\u67e5\u672c\u5730 LLM\uff08llama-server\uff09'
      if (key === 'llm_body')
        return '\u5982\u679c\u4f60\u60f3\u7528\u672c\u5730\u5927\u6a21\u578b\u6765\u603b\u7ed3\u89c6\u9891\uff0c\u8bf7\u542f\u52a8 llama-server\uff1b\u5426\u5219\u4e5f\u53ef\u7a0d\u540e\u518d\u914d\u7f6e\u3002'
      if (key === 'finish_title') return '\u5b8c\u6210\uff0c\u51c6\u5907\u5c31\u7eea'
      if (key === 'finish_body')
        return '\u540e\u7eed\u4f60\u53ef\u4ee5\u5728 Settings \u4e2d\u8c03\u6574\u6a21\u578b\u4e0e\u8fd0\u884c\u65f6\u53c2\u6570\u3002'
      if (key === 'ffmpeg') return 'ffmpeg'
      if (key === 'disk') return '\u78c1\u76d8'
      if (key === 'asr') return 'ASR\uff08Whisper\uff09'
      if (key === 'llm') return '\u672c\u5730 LLM\uff08llama-server\uff09'
      if (key === 'hf_cache') return 'Hugging Face \u7f13\u5b58'
      if (key === 'missing_required') return '\u7f3a\u5931\u5fc5\u9700\u6587\u4ef6\uff08\u6a21\u578b\u4e0d\u53ef\u7528\uff09'
      if (key === 'optional_missing') return '\u53ef\u9009\u7f3a\u5931\u6587\u4ef6\uff08\u901a\u5e38\u4e0d\u5f71\u54cd\u4f7f\u7528\uff09'
      if (key === 'download_python') return '\u4f7f\u7528 Python \u4e0b\u8f7d'
      return key
    },
    [uiLang]
  )

  const copyText = useCallback(
    async (text: string) => {
      try {
        await navigator.clipboard.writeText(text)
        setInfo(t('copied'))
      } catch {
        setInfo(null)
        // Fallback: do nothing
      }
    },
    [t]
  )

  const refresh = useCallback(async () => {
    setError(null)
    setInfo(null)
    setBusy('refresh')
    try {
      const d = await api.getDiagnostics()
      setDiag(d)
    } catch (e: any) {
      setError(String(e?.message || e))
    } finally {
      setBusy(null)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const asrMissingRequired = useMemo(() => {
    const arr = (diag as any)?.asr?.local?.missing_required_files
    return Array.isArray(arr) ? (arr as string[]) : []
  }, [diag])

  const asrMissingOptional = useMemo(() => {
    const arr = (diag as any)?.asr?.local?.missing_optional_files
    return Array.isArray(arr) ? (arr as string[]) : []
  }, [diag])

  const asrRepoId = String((diag as any)?.asr?.repo_id || '')

  const asrDownloadCmd = useMemo(() => {
    const repo = asrRepoId || 'Systran/faster-whisper-large-v3'
    return `python -c "from huggingface_hub import snapshot_download; snapshot_download(repo_id='${repo}')"`
  }, [asrRepoId])

  const ffmpegOk = useMemo(() => {
    return !!diag?.ffmpeg?.ok
  }, [diag])

  const llmOk = useMemo(() => {
    return !!(diag as any)?.llm_local?.ok
  }, [diag])

  const canGoBack = stepIndex > 0
  const canGoNext = stepIndex < steps.length - 1
  const stepKey = steps[Math.max(0, Math.min(stepIndex, steps.length - 1))]

  const hasCriticalIssues = useMemo(() => {
    return (!ffmpegOk && diag !== null) || asrMissingRequired.length > 0
  }, [asrMissingRequired.length, diag, ffmpegOk])

  const confirmProceedIfNeeded = useCallback(
    (targetIndex: number, action: 'next' | 'jump' | 'finish') => {
      if (action === 'finish') {
        if (!hasCriticalIssues) {
          onDone()
          return
        }

        const msg =
          uiLang === 'en'
            ? 'Critical dependencies are not ready (ffmpeg missing or ASR required model files missing). Continuing may cause features to fail. Continue anyway?'
            : '\u68c0\u6d4b\u5230\u5173\u952e\u4f9d\u8d56\u672a\u5c31\u7eea\uff08ffmpeg \u7f3a\u5931\u6216 ASR \u5fc5\u9700\u6a21\u578b\u6587\u4ef6\u7f3a\u5931\uff09\u3002\u7ee7\u7eed\u8fdb\u5165\u4e0b\u4e00\u6b65\u53ef\u80fd\u5bfc\u81f4\u90e8\u5206\u529f\u80fd\u65e0\u6cd5\u4f7f\u7528\u3002\u4ecd\u7136\u8981\u7ee7\u7eed\u5417\uff1f'
        if (window.confirm(msg)) {
          onDone()
        }
        return
      }

      const clamped = Math.max(0, Math.min(targetIndex, steps.length - 1))
      if (clamped <= stepIndex) {
        setStepIndex(clamped)
        return
      }
      if (!hasCriticalIssues) {
        setStepIndex(clamped)
        return
      }

      const msg =
        uiLang === 'en'
          ? 'Critical dependencies are not ready (ffmpeg missing or ASR required model files missing). Continuing may cause features to fail. Continue anyway?'
          : '\u68c0\u6d4b\u5230\u5173\u952e\u4f9d\u8d56\u672a\u5c31\u7eea\uff08ffmpeg \u7f3a\u5931\u6216 ASR \u5fc5\u9700\u6a21\u578b\u6587\u4ef6\u7f3a\u5931\uff09\u3002\u7ee7\u7eed\u8fdb\u5165\u4e0b\u4e00\u6b65\u53ef\u80fd\u5bfc\u81f4\u90e8\u5206\u529f\u80fd\u65e0\u6cd5\u4f7f\u7528\u3002\u4ecd\u7136\u8981\u7ee7\u7eed\u5417\uff1f'
      if (window.confirm(msg)) {
        setStepIndex(clamped)
      }
    },
    [hasCriticalIssues, onDone, stepIndex, steps.length, uiLang]
  )

  return (
    <div className="stack">
      <div className="card">
        <h2>{t('title')}</h2>
        <div className="muted">{t('subtitle')}</div>
        {error ? <div className="alert alert-error">{error}</div> : null}
        {info ? <div className="alert alert-info">{info}</div> : null}
        <div className="row">
          <button className="btn" onClick={refresh} disabled={!!busy}>
            {t('refresh')}
          </button>
          <button className="btn" onClick={onDone} disabled={!!busy}>
            {t('skip')}
          </button>
        </div>

        <div className="wizard-stepper" aria-label="wizard-stepper">
          {steps.map((k, idx) => {
            const active = idx === stepIndex
            const done = idx < stepIndex
            const labelKey =
              k === 'welcome'
                ? 'step_welcome'
                : k === 'deps'
                  ? 'step_deps'
                  : k === 'asr'
                    ? 'step_asr'
                    : k === 'llm'
                      ? 'step_llm'
                      : 'step_finish'
            return (
              <div key={k} className="wizard-stepper-item">
                <button
                  className="wizard-stepper-btn"
                  onClick={() => void confirmProceedIfNeeded(idx, 'jump')}
                  disabled={!!busy}
                  title={t(labelKey)}
                  aria-label={t(labelKey)}
                >
                  <div
                    className={
                      'wizard-stepper-dot' +
                      (active ? ' active' : '') +
                      (done ? ' done' : '')
                    }
                  >
                    {done ? '\u2713' : String(idx + 1)}
                  </div>
                  <div
                    className={
                      'wizard-stepper-label' + (active ? ' active' : '')
                    }
                  >
                    {t(labelKey)}
                  </div>
                </button>
                {idx < steps.length - 1 ? (
                  <div
                    className={
                      'wizard-stepper-line' +
                      (idx < stepIndex ? ' done' : '')
                    }
                  />
                ) : null}
              </div>
            )
          })}
        </div>
      </div>

      <div className="card">
        <h3>
          {stepKey === 'welcome'
            ? t('welcome_title')
            : stepKey === 'deps'
              ? t('deps_title')
              : stepKey === 'asr'
                ? t('asr_title')
                : stepKey === 'llm'
                  ? t('llm_title')
                  : t('finish_title')}
        </h3>
        <div className="muted">
          {stepKey === 'welcome'
            ? t('welcome_body')
            : stepKey === 'deps'
              ? t('deps_body')
              : stepKey === 'asr'
                ? t('asr_body')
                : stepKey === 'llm'
                  ? t('llm_body')
                  : t('finish_body')}
        </div>

        {!diag ? (
          <div style={{ marginTop: 8 }}>
            <LoadingState
              compact
              description={
                uiLang === 'en'
                  ? 'Loading diagnostics...'
                  : '\u6b63\u5728\u83b7\u53d6\u81ea\u68c0\u4fe1\u606f...'
              }
            />
          </div>
        ) : stepKey === 'welcome' ? (
          <div className="subcard" style={{ marginTop: 8 }}>
            <div className="kv">
              <div className="k">ffmpeg</div>
              <div className={ffmpegOk ? 'v ok' : 'v bad'}>{String(ffmpegOk)}</div>
            </div>
            <div className="kv">
              <div className="k">ASR</div>
              <div className={asrMissingRequired.length ? 'v bad' : 'v ok'}>
                {String(asrMissingRequired.length === 0)}
              </div>
            </div>
            <div className="kv">
              <div className="k">llama-server</div>
              <div className={llmOk ? 'v ok' : 'v bad'}>{String(llmOk)}</div>
            </div>
          </div>
        ) : stepKey === 'deps' ? (
          <>
            <div className="subcard" style={{ marginTop: 8 }}>
              <div className="label">{t('ffmpeg')}</div>
              <div className="kv">
                <div className="k">ok</div>
                <div className={diag.ffmpeg?.ok ? 'v ok' : 'v bad'}>
                  {String(!!diag.ffmpeg?.ok)}
                </div>
              </div>
              {diag.ffmpeg?.ffmpeg ? (
                <div className="muted" style={{ wordBreak: 'break-all' }}>
                  ffmpeg: {String(diag.ffmpeg.ffmpeg)}
                </div>
              ) : null}
              {diag.ffmpeg?.error ? (
                <div className="alert alert-error compact">{String(diag.ffmpeg.error)}</div>
              ) : null}
              {!diag.ffmpeg?.ok ? (
                <div className="muted" style={{ marginTop: 6 }}>
                  {uiLang === 'en'
                    ? 'Please install ffmpeg and ensure ffmpeg.exe is available in PATH.'
                    : '\u8bf7\u786e\u4fdd\u5df2\u5b89\u88c5 ffmpeg\uff0c\u5e76\u4fdd\u8bc1 ffmpeg.exe \u53ef\u5728 PATH \u4e2d\u627e\u5230\u3002'}
                </div>
              ) : null}
            </div>

            <div className="subcard" style={{ marginTop: 8 }}>
              <div className="label">{t('disk')}</div>
              <div className="kv">
                <div className="k">data_dir</div>
                <div className="v" style={{ wordBreak: 'break-all' }}>
                  {String(diag.backend?.data_dir || '')}
                </div>
              </div>
              <div className="kv">
                <div className="k">free</div>
                <div className="v">{formatBytes((diag.backend as any)?.disk?.free)}</div>
              </div>
              {(diag.backend as any)?.disk?.error ? (
                <div className="alert alert-error compact">{String((diag.backend as any).disk.error)}</div>
              ) : null}
            </div>
          </>
        ) : stepKey === 'asr' ? (
          <>
            <div className="muted" style={{ marginTop: 8 }}>
              {String((diag as any)?.asr?.model || '')} | local:{' '}
              {String(!!(diag as any)?.asr?.local?.ok)}
            </div>

            {asrMissingRequired.length ? (
              <div className="alert alert-error compact" style={{ marginTop: 8 }}>
                {t('missing_required')}
                <pre className="pre" style={{ marginTop: 8 }}>
                  {asrMissingRequired.join('\n')}
                </pre>
              </div>
            ) : (
              <div className="alert alert-info compact" style={{ marginTop: 8 }}>
                {uiLang === 'en'
                  ? 'Required files are present (model should be usable).'
                  : '\u5fc5\u9700\u6587\u4ef6\u5df2\u5c31\u7eea\uff08\u6a21\u578b\u5e94\u53ef\u7528\uff09\u3002'}
              </div>
            )}

            {asrMissingOptional.length ? (
              <details style={{ marginTop: 8 }}>
                <summary className="muted">{t('optional_missing')}</summary>
                <pre className="pre">{asrMissingOptional.join('\n')}</pre>
              </details>
            ) : null}

            <div className="subcard" style={{ marginTop: 8 }}>
              <div className="label">repo</div>
              <div className="muted" style={{ wordBreak: 'break-all' }}>
                {String((diag as any)?.asr?.download?.repo_url || '')}
              </div>
            </div>

            {asrMissingRequired.length ? (
              <div className="subcard" style={{ marginTop: 8 }}>
                <div className="label">{t('download_python')}</div>
                <pre className="pre">{asrDownloadCmd}</pre>
                <div className="row">
                  <button
                    className="btn"
                    onClick={() => void copyText(asrDownloadCmd)}
                    disabled={!!busy}
                  >
                    {t('copy')}
                  </button>
                </div>
                {diag.hints?.move_hf_cache_powershell ? (
                  <details style={{ marginTop: 8 }}>
                    <summary className="muted">{t('hf_cache')}</summary>
                    <pre className="pre">
                      {String(diag.hints.move_hf_cache_powershell)}
                    </pre>
                    <div className="row">
                      <button
                        className="btn"
                        onClick={() =>
                          void copyText(
                            String(diag.hints?.move_hf_cache_powershell || '')
                          )
                        }
                        disabled={!!busy}
                      >
                        {t('copy')}
                      </button>
                    </div>
                  </details>
                ) : null}
              </div>
            ) : null}
          </>
        ) : stepKey === 'llm' ? (
          <>
            <div className="kv" style={{ marginTop: 8 }}>
              <div className="k">ok</div>
              <div className={llmOk ? 'v ok' : 'v bad'}>{String(llmOk)}</div>
            </div>
            <div className="kv">
              <div className="k">base_url</div>
              <div className="v" style={{ wordBreak: 'break-all' }}>
                {String((diag as any)?.llm_local?.base_url || '')}
              </div>
            </div>
            {(diag as any)?.llm_local?.error ? (
              <div className="alert alert-error compact">{String((diag as any).llm_local.error)}</div>
            ) : null}
            {!llmOk ? (
              <div className="muted" style={{ marginTop: 6 }}>
                {uiLang === 'en'
                  ? 'Start llama-server first, then click Refresh.'
                  : '\u8bf7\u5148\u542f\u52a8 llama-server\uff0c\u7136\u540e\u70b9\u51fb\u201c\u5237\u65b0\u201d\u91cd\u8bd5\u3002'}
              </div>
            ) : null}
          </>
        ) : (
          <>
            <div className="subcard" style={{ marginTop: 8 }}>
              <div className="kv">
                <div className="k">ffmpeg</div>
                <div className={ffmpegOk ? 'v ok' : 'v bad'}>{String(ffmpegOk)}</div>
              </div>
              <div className="kv">
                <div className="k">ASR</div>
                <div className={asrMissingRequired.length ? 'v bad' : 'v ok'}>
                  {String(asrMissingRequired.length === 0)}
                </div>
              </div>
              <div className="kv">
                <div className="k">llama-server</div>
                <div className={llmOk ? 'v ok' : 'v bad'}>{String(llmOk)}</div>
              </div>
            </div>
            <div className="muted" style={{ marginTop: 8 }}>
              {uiLang === 'en'
                ? 'You can always re-open Settings > Diagnostics later.'
                : '\u4f60\u4e5f\u53ef\u4ee5\u968f\u65f6\u8fdb\u5165 Settings \u67e5\u770b\u66f4\u8be6\u7ec6\u7684\u81ea\u68c0\u4fe1\u606f\u3002'}
            </div>
          </>
        )}
      </div>

      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <button
            className="btn"
            onClick={() => setStepIndex((i) => Math.max(0, i - 1))}
            disabled={!canGoBack || !!busy}
          >
            {t('back')}
          </button>

          {stepKey === 'finish' ? (
            <button
              className="btn primary"
              onClick={() => void confirmProceedIfNeeded(stepIndex, 'finish')}
              disabled={!!busy}
            >
              {t('finish')}
            </button>
          ) : (
            <button
              className="btn primary"
              onClick={() => void confirmProceedIfNeeded(stepIndex + 1, 'next')}
              disabled={!canGoNext || !!busy}
            >
              {t('next')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
