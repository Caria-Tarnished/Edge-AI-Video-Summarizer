import { useCallback, useEffect, useMemo, useState } from 'react'
import { API_BASE, api, type CreateVideoJobResult, type JobItem, type VideoItem } from '../api/backend'

type Props = {
  videoId: string
  onBack: () => void
}

export default function VideoDetailPage({ videoId, onBack }: Props) {
  const [video, setVideo] = useState<VideoItem | null>(null)
  const [busy, setBusy] = useState<boolean>(false)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)

  const [lastTranscribeJob, setLastTranscribeJob] = useState<JobItem | null>(null)
  const [transcribeJobId, setTranscribeJobId] = useState<string | null>(null)
  const [transcribeJob, setTranscribeJob] = useState<JobItem | null>(null)
  const [transcribeSseState, setTranscribeSseState] = useState<'idle' | 'connecting' | 'open' | 'error' | 'closed'>(
    'idle'
  )
  const [transcribeSseError, setTranscribeSseError] = useState<string | null>(null)

  const [lastIndexJob, setLastIndexJob] = useState<CreateVideoJobResult | null>(null)
  const [lastSummarizeJob, setLastSummarizeJob] = useState<CreateVideoJobResult | null>(null)
  const [lastKeyframesJob, setLastKeyframesJob] = useState<CreateVideoJobResult | null>(null)

  const isTerminalJobStatus = useCallback((status: string | null | undefined): boolean => {
    const s = String(status || '')
    return s === 'completed' || s === 'failed' || s === 'cancelled'
  }, [])

  const load = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const v = await api.getVideo(videoId)
      setVideo(v)
    } catch (e: any) {
      const msg = e && e.message ? String(e.message) : String(e)
      setError(msg)
    } finally {
      setBusy(false)
    }
  }, [videoId])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    setLastTranscribeJob(null)
    setTranscribeJobId(null)
    setTranscribeJob(null)
    setTranscribeSseState('idle')
    setTranscribeSseError(null)
  }, [videoId])

  useEffect(() => {
    if (!transcribeJobId) {
      setTranscribeSseState('idle')
      setTranscribeSseError(null)
      return
    }

    let closed = false
    let es: EventSource | null = null

    setTranscribeSseState('connecting')
    setTranscribeSseError(null)

    api
      .getJob(transcribeJobId)
      .then((j) => {
        if (closed) return
        setTranscribeJob(j)
        if (isTerminalJobStatus(j.status)) {
          setTranscribeSseState('closed')
        }
      })
      .catch((e: any) => {
        if (closed) return
        const msg = e && e.message ? String(e.message) : String(e)
        setTranscribeSseError(msg)
      })

    try {
      const url = `${API_BASE}/jobs/${encodeURIComponent(transcribeJobId)}/events`
      es = new EventSource(url)

      es.onopen = () => {
        if (closed) return
        setTranscribeSseState('open')
      }

      es.onerror = () => {
        if (closed) return
        setTranscribeSseState('connecting')
      }

      const onJob = (evt: MessageEvent) => {
        if (closed) return
        try {
          const payload = JSON.parse(String(evt.data || ''))
          const j = payload && payload.job ? (payload.job as JobItem) : null
          if (j) {
            setTranscribeJob(j)
            if (isTerminalJobStatus(j.status)) {
              try {
                es?.close()
              } catch {
              }
              setTranscribeSseState('closed')
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
          setTranscribeSseError(detail)
        } catch {
          setTranscribeSseError('SSE_ERROR')
        }
      }

      es.addEventListener('job', onJob as any)
      es.addEventListener('error', onErr as any)
    } catch (e: any) {
      const msg = e && e.message ? String(e.message) : String(e)
      setTranscribeSseError(msg)
      setTranscribeSseState('error')
    }

    return () => {
      closed = true
      try {
        es?.close()
      } catch {
      }
      es = null
    }
  }, [isTerminalJobStatus, transcribeJobId])

  const startJob = useCallback(
    async (kind: 'transcribe' | 'index' | 'summarize' | 'keyframes') => {
      setBusy(true)
      setError(null)
      setInfo(null)
      try {
        if (kind === 'transcribe') {
          const job = await api.createTranscribeJob({ video_id: videoId })
          setLastTranscribeJob(job)
          setTranscribeJobId(job.id)
          setTranscribeJob(job)
          setTranscribeSseError(null)
          setInfo(`Started ${kind} job: ${job.id}`)
        } else if (kind === 'index') {
          const r = await api.createIndexJob(videoId, { from_scratch: false })
          setLastIndexJob(r)
          if (r.status === 202 && r.job_id) {
            setInfo(`Started ${kind} job: ${r.job_id}`)
          } else {
            setInfo(`Index: ${r.detail || 'OK'}`)
          }
        } else if (kind === 'summarize') {
          const r = await api.createSummarizeJob(videoId, { from_scratch: false })
          setLastSummarizeJob(r)
          if (r.status === 202 && r.job_id) {
            setInfo(`Started ${kind} job: ${r.job_id}`)
          } else {
            setInfo(`Summarize: ${r.detail || 'OK'}`)
          }
        } else {
          const r = await api.createKeyframesJob(videoId, { from_scratch: false, mode: 'interval' })
          setLastKeyframesJob(r)
          if (r.status === 202 && r.job_id) {
            setInfo(`Started ${kind} job: ${r.job_id}`)
          } else {
            setInfo(`Keyframes: ${r.detail || 'OK'}`)
          }
        }
      } catch (e: any) {
        const msg = e && e.message ? String(e.message) : String(e)
        setError(msg)
      } finally {
        setBusy(false)
      }
    },
    [videoId]
  )

  const headerTitle = useMemo(() => {
    if (video?.title) return String(video.title)
    return videoId
  }, [video?.title, videoId])

  const transcribeProgressText = useMemo(() => {
    if (!transcribeJob) return '-'
    const p = typeof transcribeJob.progress === 'number' ? transcribeJob.progress : 0
    const pct = Math.max(0, Math.min(100, Math.round(p * 100)))
    return `${pct}%`
  }, [transcribeJob])

  return (
    <div className="stack">
      <div className="card">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div>
            <div className="muted">{'\u89c6\u9891\u8be6\u60c5'}</div>
            <h2 style={{ margin: '6px 0 0' }}>{headerTitle}</h2>
          </div>
          <div className="row" style={{ marginTop: 0 }}>
            <button className="btn" onClick={onBack} disabled={busy}>
              {'\u8fd4\u56de'}
            </button>
            <button className="btn" onClick={load} disabled={busy}>
              {'\u5237\u65b0'}
            </button>
          </div>
        </div>

        {error ? <div className="alert alert-error">{error}</div> : null}
        {info ? <div className="alert alert-info">{info}</div> : null}

        {video ? (
          <>
            <div className="kv">
              <div className="k">id</div>
              <div className="v">{String(video.id)}</div>
            </div>
            <div className="kv">
              <div className="k">status</div>
              <div className="v">{String(video.status)}</div>
            </div>
            <div className="kv">
              <div className="k">file_path</div>
              <div className="v" style={{ wordBreak: 'break-all' }}>
                {String(video.file_path)}
              </div>
            </div>
          </>
        ) : (
          <div className="muted">{'\u6b63\u5728\u52a0\u8f7d...'} </div>
        )}
      </div>

      <div className="card">
        <h3 style={{ margin: 0 }}>{'\u64cd\u4f5c'}</h3>
        <div className="row">
          <button className="btn primary" onClick={() => startJob('transcribe')} disabled={busy}>
            {'\u8f6c\u5199'}
          </button>
          <button className="btn" onClick={() => startJob('index')} disabled={busy}>
            {'\u7d22\u5f15'}
          </button>
          <button className="btn" onClick={() => startJob('summarize')} disabled={busy}>
            {'\u6458\u8981'}
          </button>
          <button className="btn" onClick={() => startJob('keyframes')} disabled={busy}>
            {'\u5173\u952e\u5e27'}
          </button>
        </div>

        <div className="subcard">
          <div className="muted">{'\u8fd9\u91cc\u5148\u505a\u9aa8\u67b6\uff0c\u4e0b\u4e00\u6b65\u4f1a\u52a0\u5165\u4efb\u52a1\u8fdb\u5ea6\uff08SSE/WS\uff09\u3001\u7ed3\u679c\u9884\u89c8\u548c\u53c2\u6570\u8c03\u6574\u3002'}</div>
        </div>

        <div className="grid">
          <div className="subcard">
            <div style={{ fontWeight: 700 }}>{'\u8f6c\u5199'}</div>
            <div className="muted">job: {transcribeJobId || (lastTranscribeJob ? lastTranscribeJob.id : '-')}</div>
            <div className="muted">status: {transcribeJob ? String(transcribeJob.status) : '-'}</div>
            <div className="muted">progress: {transcribeProgressText}</div>
            <div className="muted">message: {transcribeJob ? String(transcribeJob.message || '') : '-'}</div>
            <div className="muted">sse: {transcribeSseState}</div>
            {transcribeSseError ? <div className="muted">error: {transcribeSseError}</div> : null}
          </div>
          <div className="subcard">
            <div style={{ fontWeight: 700 }}>{'\u7d22\u5f15'}</div>
            <div className="muted">job: {lastIndexJob ? lastIndexJob.job_id || '-' : '-'}</div>
            <div className="muted">status: {lastIndexJob ? `${lastIndexJob.status} ${lastIndexJob.detail || ''}` : '-'}</div>
          </div>
          <div className="subcard">
            <div style={{ fontWeight: 700 }}>{'\u6458\u8981'}</div>
            <div className="muted">job: {lastSummarizeJob ? lastSummarizeJob.job_id || '-' : '-'}</div>
            <div className="muted">status: {lastSummarizeJob ? `${lastSummarizeJob.status} ${lastSummarizeJob.detail || ''}` : '-'}</div>
          </div>
          <div className="subcard">
            <div style={{ fontWeight: 700 }}>{'\u5173\u952e\u5e27'}</div>
            <div className="muted">job: {lastKeyframesJob ? lastKeyframesJob.job_id || '-' : '-'}</div>
            <div className="muted">status: {lastKeyframesJob ? `${lastKeyframesJob.status} ${lastKeyframesJob.detail || ''}` : '-'}</div>
          </div>
        </div>
      </div>
    </div>
  )
}
