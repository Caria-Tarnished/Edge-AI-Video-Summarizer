import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { API_BASE, api, type JobItem } from '../api/backend'

type UiLang = 'zh' | 'en'

type Props = {
  uiLang?: UiLang
  onOpenVideo?: (videoId: string) => void
}

function fmtPct(p: number | null | undefined): string {
  const v = typeof p === 'number' && Number.isFinite(p) ? p : 0
  const pct = Math.max(0, Math.min(100, Math.round(v * 100)))
  return `${pct}%`
}

function isActiveJobStatus(s: string | null | undefined): boolean {
  const v = String(s || '')
  return v === 'pending' || v === 'running'
}

function isTerminalJobStatus(s: string | null | undefined): boolean {
  const v = String(s || '')
  return v === 'completed' || v === 'failed' || v === 'cancelled'
}

export default function TaskCenterPage({ uiLang = 'zh', onOpenVideo }: Props) {
  const [items, setItems] = useState<JobItem[]>([])
  const [total, setTotal] = useState<number>(0)
  const [busy, setBusy] = useState<boolean>(false)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)

  const [statusFilter, setStatusFilter] = useState<string>('')
  const [jobTypeFilter, setJobTypeFilter] = useState<string>('')
  const [videoIdFilter, setVideoIdFilter] = useState<string>('')
  const [autoRefresh, setAutoRefresh] = useState<boolean>(true)

  const [limit, setLimit] = useState<number>(50)
  const [offset, setOffset] = useState<number>(0)

  const [selectedJobId, setSelectedJobId] = useState<string | null>(null)
  const [selectedJob, setSelectedJob] = useState<JobItem | null>(null)

  const [sseState, setSseState] = useState<'idle' | 'connecting' | 'open' | 'error' | 'closed'>('idle')
  const [sseError, setSseError] = useState<string | null>(null)
  const esRef = useRef<EventSource | null>(null)

  const title = useMemo(() => {
    return uiLang === 'en' ? 'Task Center' : '任务中心'
  }, [uiLang])

  const load = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await api.listJobs({
        status: statusFilter ? statusFilter : undefined,
        video_id: videoIdFilter ? videoIdFilter : undefined,
        job_type: jobTypeFilter ? jobTypeFilter : undefined,
        limit,
        offset
      })
      setItems(Array.isArray(res.items) ? res.items : [])
      setTotal(typeof res.total === 'number' ? res.total : 0)

      if (selectedJobId) {
        const hit = (res.items || []).find((x) => String((x as any).id || '') === String(selectedJobId)) as any
        if (hit) setSelectedJob(hit as JobItem)
      }
    } catch (e: any) {
      const msg = e && e.message ? String(e.message) : String(e)
      setError(msg)
    } finally {
      setBusy(false)
    }
  }, [jobTypeFilter, limit, offset, selectedJobId, statusFilter, videoIdFilter])

  useEffect(() => {
    setOffset(0)
  }, [statusFilter, jobTypeFilter, videoIdFilter])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!autoRefresh) return
    const id = window.setInterval(() => {
      void load()
    }, 1200)
    return () => {
      window.clearInterval(id)
    }
  }, [autoRefresh, load])

  const page = useMemo(() => {
    return Math.floor(offset / Math.max(1, limit)) + 1
  }, [limit, offset])

  const totalPages = useMemo(() => {
    const l = Math.max(1, limit)
    return Math.max(1, Math.ceil(Math.max(0, total) / l))
  }, [limit, total])

  useEffect(() => {
    if (!selectedJobId) {
      setSelectedJob(null)
      setSseState('idle')
      setSseError(null)
      try {
        esRef.current?.close()
      } catch {
      }
      esRef.current = null
      return
    }

    let closed = false
    let es: EventSource | null = null

    setSseState('connecting')
    setSseError(null)

    try {
      const url = `${API_BASE}/jobs/${encodeURIComponent(selectedJobId)}/events`
      es = new EventSource(url)
      esRef.current = es

      es.onopen = () => {
        if (closed) return
        setSseState('open')
      }

      es.onerror = () => {
        if (closed) return
        setSseState('connecting')
      }

      const onJob = (evt: MessageEvent) => {
        if (closed) return
        try {
          const payload = JSON.parse(String(evt.data || ''))
          const j = payload && payload.job ? (payload.job as JobItem) : null
          if (j) {
            setSelectedJob(j)
            setItems((prev) => prev.map((it) => (String(it.id) === String(j.id) ? j : it)))
            if (isTerminalJobStatus(j.status)) {
              try {
                es?.close()
              } catch {
              }
              setSseState('closed')
            }
          }
        } catch {
        }
      }

      const onErr = (evt: MessageEvent) => {
        if (closed) return
        try {
          const payload = JSON.parse(String(evt.data || ''))
          const detail = payload && payload.detail ? String(payload.detail) : 'SSE_ERROR'
          setSseError(detail)
        } catch {
          setSseError('SSE_ERROR')
        }
      }

      es.addEventListener('job', onJob as any)
      es.addEventListener('error', onErr as any)
    } catch (e: any) {
      const msg = e && e.message ? String(e.message) : String(e)
      setSseError(msg)
      setSseState('error')
    }

    return () => {
      closed = true
      try {
        es?.close()
      } catch {
      }
      es = null
      esRef.current = null
    }
  }, [selectedJobId])

  const onCancel = useCallback(
    async (job: JobItem) => {
      setInfo(null)
      setError(null)
      const ok = window.confirm(uiLang === 'en' ? 'Cancel this job?' : '取消该任务？')
      if (!ok) return

      setBusy(true)
      try {
        await api.cancelJob(String(job.id))
        setInfo(uiLang === 'en' ? 'Cancelled' : '已取消')
        await load()
      } catch (e: any) {
        const msg = e && e.message ? String(e.message) : String(e)
        setError(msg)
      } finally {
        setBusy(false)
      }
    },
    [load, uiLang]
  )

  const onDelete = useCallback(
    async (job: JobItem) => {
      setInfo(null)
      setError(null)

      const status = String(job.status || '')
      if (!isTerminalJobStatus(status)) {
        setInfo(
          uiLang === 'en'
            ? 'Job is active. Please cancel it first.'
            : '\u4efb\u52a1\u6b63\u5728\u8fdb\u884c\u4e2d\uff0c\u8bf7\u5148\u53d6\u6d88\u8be5\u4efb\u52a1\u3002'
        )
        return
      }

      const ok = window.confirm(
        uiLang === 'en'
          ? 'Delete this job record?'
          : '\u5220\u9664\u8be5\u4efb\u52a1\u8bb0\u5f55\uff1f'
      )
      if (!ok) return

      setBusy(true)
      try {
        await api.deleteJob(String(job.id))
        setInfo(uiLang === 'en' ? 'Deleted' : '\u5df2\u5220\u9664')
        if (String(selectedJobId || '') === String(job.id)) {
          setSelectedJobId(null)
          setSelectedJob(null)
        }
        await load()
      } catch (e: any) {
        const msg = e && e.message ? String(e.message) : String(e)
        setError(msg)
      } finally {
        setBusy(false)
      }
    },
    [load, selectedJobId, uiLang]
  )

  const onCancelActiveVisible = useCallback(async () => {
    const actives = items.filter((j) => isActiveJobStatus(j.status))
    if (actives.length === 0) {
      setInfo(uiLang === 'en' ? 'No active jobs on this page' : '当前页没有进行中的任务')
      return
    }

    setInfo(null)
    setError(null)
    const ok = window.confirm(
      uiLang === 'en'
        ? `Cancel all active jobs on this page? (${actives.length})`
        : `取消当前页所有进行中的任务？（${actives.length} 个）`
    )
    if (!ok) return

    setBusy(true)
    try {
      for (const j of actives) {
        try {
          await api.cancelJob(String(j.id))
        } catch {
        }
      }
      setInfo(uiLang === 'en' ? 'Cancelled active jobs' : '已取消当前页进行中的任务')
      await load()
    } catch (e: any) {
      const msg = e && e.message ? String(e.message) : String(e)
      setError(msg)
    } finally {
      setBusy(false)
    }
  }, [items, load, uiLang])

  const onRetry = useCallback(
    async (job: JobItem) => {
      setInfo(null)
      setError(null)

      const ok = window.confirm(uiLang === 'en' ? 'Retry this job?' : '重试该任务？')
      if (!ok) return

      const fromScratch = window.confirm(
        uiLang === 'en'
          ? 'Retry from scratch? (Default: Cancel = keep existing data)'
          : '是否从头重试（from_scratch）？（默认点取消=保留已有数据）'
      )

      setBusy(true)
      try {
        await api.retryJob(String(job.id), { from_scratch: fromScratch })
        setInfo(uiLang === 'en' ? 'Retried' : '已重试')
        await load()
      } catch (e: any) {
        const msg = e && e.message ? String(e.message) : String(e)
        setError(msg)
      } finally {
        setBusy(false)
      }
    },
    [load, uiLang]
  )

  return (
    <div className="stack">
      <div className="card">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <h2 style={{ margin: 0 }}>{title}</h2>
          <div className="row" style={{ marginTop: 0 }}>
            <button className="btn" onClick={load} disabled={busy}>
              {uiLang === 'en' ? 'Refresh' : '刷新'}
            </button>
            <button className="btn" onClick={onCancelActiveVisible} disabled={busy}>
              {uiLang === 'en' ? 'Cancel active (page)' : '取消进行中（本页）'}
            </button>
            <label className="row" style={{ marginTop: 0 }}>
              <input
                type="checkbox"
                checked={autoRefresh}
                onChange={(e) => setAutoRefresh(Boolean(e.target.checked))}
              />
              <span className="muted">{uiLang === 'en' ? 'Auto refresh' : '自动刷新'}</span>
            </label>
          </div>
        </div>

        <div className="grid">
          <label className="field">
            <div className="label">status</div>
            <select className="input" value={statusFilter} onChange={(e) => setStatusFilter(String(e.target.value || ''))}>
              <option value="">{uiLang === 'en' ? 'all' : '全部'}</option>
              <option value="pending">pending</option>
              <option value="running">running</option>
              <option value="completed">completed</option>
              <option value="failed">failed</option>
              <option value="cancelled">cancelled</option>
            </select>
          </label>

          <label className="field">
            <div className="label">job_type</div>
            <input
              className="input"
              value={jobTypeFilter}
              onChange={(e) => setJobTypeFilter(String(e.target.value || ''))}
              placeholder={uiLang === 'en' ? 'e.g. transcribe/index/summarize' : '例如 transcribe/index/summarize'}
            />
          </label>

          <label className="field">
            <div className="label">video_id</div>
            <input
              className="input"
              value={videoIdFilter}
              onChange={(e) => setVideoIdFilter(String(e.target.value || '').trim())}
              placeholder={uiLang === 'en' ? 'Filter by video_id' : '按 video_id 筛选'}
            />
          </label>

          <label className="field">
            <div className="label">page_size</div>
            <select
              className="input"
              value={String(limit)}
              onChange={(e) => {
                const v = parseInt(String(e.target.value || '50'), 10)
                const next = Number.isFinite(v) ? Math.max(10, Math.min(200, v)) : 50
                setLimit(next)
                setOffset(0)
              }}
            >
              <option value="20">20</option>
              <option value="50">50</option>
              <option value="100">100</option>
              <option value="200">200</option>
            </select>
          </label>
        </div>

        <div className="row">
          <button
            className="btn"
            onClick={() => setOffset((o) => Math.max(0, o - limit))}
            disabled={busy || offset <= 0}
          >
            {uiLang === 'en' ? 'Prev' : '上一页'}
          </button>
          <div className="muted">
            {uiLang === 'en' ? `Page ${page} / ${totalPages}` : `第 ${page} / ${totalPages} 页`}
          </div>
          <button
            className="btn"
            onClick={() => setOffset((o) => o + limit)}
            disabled={busy || offset + items.length >= total}
          >
            {uiLang === 'en' ? 'Next' : '下一页'}
          </button>
        </div>

        <div className="muted" style={{ marginTop: 8 }}>
          {uiLang === 'en' ? `Total: ${total} | Loaded: ${items.length}` : `总数：${total} | 当前加载：${items.length}`}
        </div>

        {error ? <div className="alert alert-error">{error}</div> : null}
        {info ? <div className="alert alert-info">{info}</div> : null}
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>{uiLang === 'en' ? 'Jobs' : '任务列表'}</h3>
        {items.length === 0 ? (
          <div className="muted">{uiLang === 'en' ? 'No jobs.' : '暂无任务。'}</div>
        ) : (
          <div>
            {items.map((j) => {
              const active = isActiveJobStatus(j.status)
              const terminal = isTerminalJobStatus(j.status)
              const selected = String(selectedJobId || '') === String(j.id)
              return (
                <div
                  key={j.id}
                  className="subcard"
                  style={{
                    cursor: 'pointer',
                    borderColor: selected ? 'rgba(99, 102, 241, 0.55)' : undefined,
                    background: selected ? 'rgba(99, 102, 241, 0.10)' : undefined
                  }}
                  onClick={() => setSelectedJobId(String(j.id))}
                >
                  <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 }}>
                    <div style={{ fontWeight: 700, minWidth: 0, flex: 1 }}>
                      {String(j.job_type)}
                      <span className="muted" style={{ marginLeft: 8 }}>
                        {String(j.video_id)}
                      </span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <div className={String(j.status) === 'completed' ? 'v ok' : String(j.status) === 'failed' ? 'v bad' : 'v'}>
                        {String(j.status)}
                      </div>
                      <div className="muted">{fmtPct(j.progress)}</div>
                      {onOpenVideo ? (
                        <button
                          className="btn"
                          onClick={(e) => {
                            e.stopPropagation()
                            onOpenVideo(String(j.video_id))
                          }}
                          disabled={busy}
                        >
                          {uiLang === 'en' ? 'Open video' : '打开视频'}
                        </button>
                      ) : null}
                      {active ? (
                        <button className="btn" onClick={(e) => {
                          e.stopPropagation()
                          void onCancel(j)
                        }} disabled={busy}>
                          {uiLang === 'en' ? 'Cancel' : '取消'}
                        </button>
                      ) : (
                        <button className="btn" onClick={(e) => {
                          e.stopPropagation()
                          void onRetry(j)
                        }} disabled={busy}>
                          {uiLang === 'en' ? 'Retry' : '重试'}
                        </button>
                      )}

                      <button
                        className="btn"
                        onClick={(e) => {
                          e.stopPropagation()
                          void onDelete(j)
                        }}
                        disabled={busy || !terminal}
                        title={
                          terminal
                            ? uiLang === 'en'
                              ? 'Delete'
                              : '\u5220\u9664'
                            : uiLang === 'en'
                              ? 'Cancel it first'
                              : '\u8bf7\u5148\u53d6\u6d88'
                        }
                      >
                        {uiLang === 'en' ? 'Delete' : '\u5220\u9664'}
                      </button>
                    </div>
                  </div>
                  <div className="muted" style={{ marginTop: 6 }}>
                    {String(j.message || '')}
                  </div>
                  <div className="muted" style={{ marginTop: 6 }}>
                    created_at: {String(j.created_at || '')} | updated_at: {String(j.updated_at || '')}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>{uiLang === 'en' ? 'Selected job' : '任务详情'}</h3>
        {!selectedJob ? (
          <div className="muted">{uiLang === 'en' ? 'Click a job to view details.' : '点击任务查看详情。'}</div>
        ) : (
          <div>
            <div className="muted" style={{ marginBottom: 8 }}>
              SSE: {sseState}
              {sseError ? ` | ${sseError}` : ''}
            </div>
            <div className="kv">
              <div className="k">id</div>
              <div className="v">{String(selectedJob.id)}</div>
            </div>
            <div className="kv">
              <div className="k">video_id</div>
              <div className="v">{String(selectedJob.video_id)}</div>
            </div>
            {onOpenVideo ? (
              <div className="row">
                <button
                  className="btn"
                  onClick={() => onOpenVideo(String(selectedJob.video_id))}
                  disabled={busy}
                >
                  {uiLang === 'en' ? 'Open video' : '打开视频'}
                </button>
              </div>
            ) : null}
            <div className="kv">
              <div className="k">job_type</div>
              <div className="v">{String(selectedJob.job_type)}</div>
            </div>
            <div className="kv">
              <div className="k">status</div>
              <div className={String(selectedJob.status) === 'completed' ? 'v ok' : String(selectedJob.status) === 'failed' ? 'v bad' : 'v'}>
                {String(selectedJob.status)}
              </div>
            </div>
            <div className="kv">
              <div className="k">progress</div>
              <div className="v">{fmtPct(selectedJob.progress)}</div>
            </div>
            <div className="kv">
              <div className="k">updated_at</div>
              <div className="v">{String(selectedJob.updated_at || '')}</div>
            </div>
            {selectedJob.error_code ? (
              <div className="kv">
                <div className="k">error_code</div>
                <div className="v bad">{String(selectedJob.error_code)}</div>
              </div>
            ) : null}
            {selectedJob.error_message ? (
              <div className="kv">
                <div className="k">error_message</div>
                <div className="v bad">{String(selectedJob.error_message)}</div>
              </div>
            ) : null}

            {selectedJob.params_json ? (
              <pre className="pre">{String(selectedJob.params_json)}</pre>
            ) : null}
            {selectedJob.result_json ? (
              <pre className="pre">{String(selectedJob.result_json)}</pre>
            ) : null}

            {!isTerminalJobStatus(selectedJob.status) ? (
              <div className="row">
                <button className="btn" onClick={() => void onCancel(selectedJob)} disabled={busy}>
                  {uiLang === 'en' ? 'Cancel' : '取消'}
                </button>
              </div>
            ) : (
              <div className="row">
                <button className="btn" onClick={() => void onRetry(selectedJob)} disabled={busy}>
                  {uiLang === 'en' ? 'Retry' : '重试'}
                </button>

                <button className="btn" onClick={() => void onDelete(selectedJob)} disabled={busy}>
                  {uiLang === 'en' ? 'Delete' : '\u5220\u9664'}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
