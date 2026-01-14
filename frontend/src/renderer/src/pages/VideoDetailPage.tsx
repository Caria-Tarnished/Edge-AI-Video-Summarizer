import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  API_BASE,
  api,
  type ChatCitationItem,
  type CreateVideoJobResult,
  type JobItem,
  type KeyframeItem,
  type KeyframesIndexStatus,
  type OutlineResponse,
  type TranscriptSegment,
  type VideoIndexStatus,
  type VideoItem,
  type VideoSummaryStatus
} from '../api/backend'

type Props = {
  videoId: string
  onBack: () => void
}

export default function VideoDetailPage({ videoId, onBack }: Props) {
  const [video, setVideo] = useState<VideoItem | null>(null)
  const [busy, setBusy] = useState<boolean>(false)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)

  const videoElRef = useRef<HTMLVideoElement | null>(null)
  const pendingSeekRef = useRef<{ seconds: number; play: boolean } | null>(null)
  const [activeTranscriptIndex, setActiveTranscriptIndex] = useState<number>(-1)
  const activeTranscriptIndexRef = useRef<number>(-1)
  const activeTranscriptElRef = useRef<HTMLDivElement | null>(null)

  const [lastTranscribeJob, setLastTranscribeJob] = useState<JobItem | null>(null)
  const [transcribeJobId, setTranscribeJobId] = useState<string | null>(null)
  const [transcribeJob, setTranscribeJob] = useState<JobItem | null>(null)
  const [transcribeSseState, setTranscribeSseState] = useState<'idle' | 'connecting' | 'open' | 'error' | 'closed'>(
    'idle'
  )
  const [transcribeSseError, setTranscribeSseError] = useState<string | null>(null)

  const [asrSegmentSeconds, setAsrSegmentSeconds] = useState<string>('')
  const [asrOverlapSeconds, setAsrOverlapSeconds] = useState<string>('')
  const [asrFromScratch, setAsrFromScratch] = useState<boolean>(false)

  const [transcriptLimit, setTranscriptLimit] = useState<number>(30)
  const [transcriptBusy, setTranscriptBusy] = useState<boolean>(false)
  const [transcriptError, setTranscriptError] = useState<string | null>(null)
  const [transcriptSegments, setTranscriptSegments] = useState<TranscriptSegment[]>([])
  const [autoTranscriptLoadedForJobId, setAutoTranscriptLoadedForJobId] = useState<string | null>(null)

  const [lastIndexJob, setLastIndexJob] = useState<CreateVideoJobResult | null>(null)
  const [lastSummarizeJob, setLastSummarizeJob] = useState<CreateVideoJobResult | null>(null)
  const [lastKeyframesJob, setLastKeyframesJob] = useState<CreateVideoJobResult | null>(null)

  const [indexJobId, setIndexJobId] = useState<string | null>(null)
  const [indexJob, setIndexJob] = useState<JobItem | null>(null)
  const [indexSseState, setIndexSseState] = useState<'idle' | 'connecting' | 'open' | 'error' | 'closed'>('idle')
  const [indexSseError, setIndexSseError] = useState<string | null>(null)
  const [indexStatusBusy, setIndexStatusBusy] = useState<boolean>(false)
  const [indexStatusError, setIndexStatusError] = useState<string | null>(null)
  const [indexStatus, setIndexStatus] = useState<VideoIndexStatus | null>(null)
  const [autoIndexLoadedForJobId, setAutoIndexLoadedForJobId] = useState<string | null>(null)

  const [summaryJobId, setSummaryJobId] = useState<string | null>(null)
  const [summaryJob, setSummaryJob] = useState<JobItem | null>(null)
  const [summarySseState, setSummarySseState] = useState<'idle' | 'connecting' | 'open' | 'error' | 'closed'>('idle')
  const [summarySseError, setSummarySseError] = useState<string | null>(null)
  const [summaryBusy, setSummaryBusy] = useState<boolean>(false)
  const [summaryError, setSummaryError] = useState<string | null>(null)
  const [summaryStatus, setSummaryStatus] = useState<VideoSummaryStatus | null>(null)
  const [summaryShowFull, setSummaryShowFull] = useState<boolean>(false)
  const [outlineBusy, setOutlineBusy] = useState<boolean>(false)
  const [outlineError, setOutlineError] = useState<string | null>(null)
  const [outlineRes, setOutlineRes] = useState<OutlineResponse | null>(null)
  const [outlineShow, setOutlineShow] = useState<boolean>(false)
  const [autoSummaryLoadedForJobId, setAutoSummaryLoadedForJobId] = useState<string | null>(null)

  const [alignedKeyframesBusy, setAlignedKeyframesBusy] = useState<boolean>(false)
  const [alignedKeyframesError, setAlignedKeyframesError] = useState<string | null>(null)
  const [alignedKeyframesItems, setAlignedKeyframesItems] = useState<any[]>([])

  const [keyframesJobId, setKeyframesJobId] = useState<string | null>(null)
  const [keyframesJob, setKeyframesJob] = useState<JobItem | null>(null)
  const [keyframesSseState, setKeyframesSseState] = useState<'idle' | 'connecting' | 'open' | 'error' | 'closed'>('idle')
  const [keyframesSseError, setKeyframesSseError] = useState<string | null>(null)
  const [keyframesIndexBusy, setKeyframesIndexBusy] = useState<boolean>(false)
  const [keyframesIndexError, setKeyframesIndexError] = useState<string | null>(null)
  const [keyframesIndex, setKeyframesIndex] = useState<KeyframesIndexStatus | null>(null)
  const [keyframesListBusy, setKeyframesListBusy] = useState<boolean>(false)
  const [keyframesListError, setKeyframesListError] = useState<string | null>(null)
  const [keyframesItems, setKeyframesItems] = useState<KeyframeItem[]>([])
  const [keyframesLimit, setKeyframesLimit] = useState<number>(24)
  const [keyframesMethod, setKeyframesMethod] = useState<'interval' | 'scene' | 'all'>('interval')
  const [autoKeyframesLoadedForJobId, setAutoKeyframesLoadedForJobId] = useState<string | null>(null)

  const [chatQuery, setChatQuery] = useState<string>('')
  const [chatTopK, setChatTopK] = useState<number>(5)
  const [chatBusy, setChatBusy] = useState<boolean>(false)
  const [chatError, setChatError] = useState<string | null>(null)
  const [chatDetail, setChatDetail] = useState<string | null>(null)
  const [chatAnswer, setChatAnswer] = useState<string>('')
  const [chatCitations, setChatCitations] = useState<ChatCitationItem[]>([])
  const [chatConfirmSend, setChatConfirmSend] = useState<boolean>(false)
  const [chatNeedsConfirm, setChatNeedsConfirm] = useState<boolean>(false)
  const [chatWaitingIndex, setChatWaitingIndex] = useState<boolean>(false)

  const chatAbortRef = useRef<AbortController | null>(null)
  const chatPendingAfterIndexRef = useRef<{ query: string; top_k: number; confirm_send: boolean } | null>(null)

  const indexStatusInFlightRef = useRef<boolean>(false)
  const summaryInFlightRef = useRef<boolean>(false)
  const outlineInFlightRef = useRef<boolean>(false)
  const keyframesIndexInFlightRef = useRef<boolean>(false)
  const keyframesListInFlightRef = useRef<boolean>(false)
  const alignedKeyframesInFlightRef = useRef<boolean>(false)

  const isTerminalJobStatus = useCallback((status: string | null | undefined): boolean => {
    const s = String(status || '')
    return s === 'completed' || s === 'failed' || s === 'cancelled'
  }, [])

  const parseOptionalInt = useCallback((s: string): number | undefined => {
    const raw = String(s || '').trim()
    if (!raw) return undefined
    const n = parseInt(raw, 10)
    return Number.isFinite(n) ? n : undefined
  }, [])

  const fmtTime = useCallback((seconds: number | null | undefined): string => {
    const v = typeof seconds === 'number' && Number.isFinite(seconds) ? seconds : 0
    const s = Math.max(0, Math.floor(v))
    const hh = Math.floor(s / 3600)
    const mm = Math.floor((s % 3600) / 60)
    const ss = s % 60
    if (hh > 0) return `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
    return `${mm}:${String(ss).padStart(2, '0')}`
  }, [])

  const fmtPct = useCallback((p: number | null | undefined): string => {
    const v = typeof p === 'number' && Number.isFinite(p) ? p : 0
    const pct = Math.max(0, Math.min(100, Math.round(v * 100)))
    return `${pct}%`
  }, [])

  const fmtScore = useCallback((s: number | null | undefined): string => {
    const v = typeof s === 'number' && Number.isFinite(s) ? s : 0
    const pct = Math.max(0, Math.min(100, Math.round(v * 100)))
    return `${pct}%`
  }, [])

  const videoFileUrl = useMemo(() => {
    return `${API_BASE}/videos/${encodeURIComponent(videoId)}/file`
  }, [videoId])

  const loadAlignedKeyframes = useCallback(
    async (opts?: { force?: boolean }) => {
      if (alignedKeyframesInFlightRef.current) return
      alignedKeyframesInFlightRef.current = true
      setAlignedKeyframesBusy(true)
      setAlignedKeyframesError(null)
      try {
        const method = keyframesMethod === 'scene' ? 'scene' : 'interval'
        const fallback = method === 'scene' ? 'nearest' : 'none'
        const res = await api.getAlignedKeyframes(videoId, {
          method,
          per_section: 2,
          min_gap_seconds: 2,
          fallback
        })
        setAlignedKeyframesItems(Array.isArray((res as any).items) ? ((res as any).items as any[]) : [])
      } catch (e: any) {
        const msg = e && e.message ? String(e.message) : String(e)
        setAlignedKeyframesError(msg)
        setAlignedKeyframesItems([])
      } finally {
        setAlignedKeyframesBusy(false)
        alignedKeyframesInFlightRef.current = false
      }
    },
    [keyframesMethod, videoId]
  )

  const subtitlesVttUrl = useMemo(() => {
    return `${API_BASE}/videos/${encodeURIComponent(videoId)}/subtitles/vtt`
  }, [videoId])

  useEffect(() => {
    return () => {
      if (chatAbortRef.current) {
        try {
          chatAbortRef.current.abort()
        } catch {
        }
      }
      chatAbortRef.current = null
      chatPendingAfterIndexRef.current = null
    }
  }, [])

  const seekToSeconds = useCallback((seconds: number, opts?: { play?: boolean }) => {
    const el = videoElRef.current
    if (!el) return

    const s = typeof seconds === 'number' && Number.isFinite(seconds) ? seconds : 0
    const t = Math.max(0, s)
    const play = opts?.play !== false

    if (el.readyState >= 1) {
      try {
        el.currentTime = t
      } catch {
      }
      if (play) {
        void el.play().catch(() => {})
      }
      return
    }

    pendingSeekRef.current = { seconds: t, play }
    try {
      el.currentTime = t
    } catch {
    }
  }, [])

  const onVideoLoadedMetadata = useCallback(() => {
    const el = videoElRef.current
    if (!el) return
    const pending = pendingSeekRef.current
    if (!pending) return

    pendingSeekRef.current = null
    try {
      el.currentTime = pending.seconds
    } catch {
    }
    if (pending.play) {
      void el.play().catch(() => {})
    }
  }, [])

  const doChat = useCallback(
    async (q: string, opts?: { topK?: number; confirmSend?: boolean; fromRetry?: boolean }) => {
      const query = String(q || '').trim()
      if (!query) return

      const topK = typeof opts?.topK === 'number' ? opts?.topK : chatTopK
      const confirmSend = typeof opts?.confirmSend === 'boolean' ? opts?.confirmSend : chatConfirmSend

      if (!opts?.fromRetry) {
        chatPendingAfterIndexRef.current = null
      }

      if (chatAbortRef.current) {
        try {
          chatAbortRef.current.abort()
        } catch {
        }
      }

      const ac = new AbortController()
      chatAbortRef.current = ac

      setChatBusy(true)
      setChatError(null)
      setChatDetail(null)
      setChatAnswer('')
      setChatCitations([])
      setChatNeedsConfirm(false)
      setChatWaitingIndex(false)

      try {
        const res = await fetch(`${API_BASE}/chat`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'text/event-stream'
          },
          body: JSON.stringify({
            video_id: videoId,
            query,
            top_k: topK,
            stream: true,
            confirm_send: confirmSend
          }),
          signal: ac.signal
        })

        const ct = String(res.headers.get('content-type') || '')
        const isEventStream = ct.includes('text/event-stream')
        if (!res.ok) {
          const txt = await res.text().catch(() => '')
          let detail = res.statusText
          try {
            const obj = txt ? JSON.parse(txt) : null
            detail = String((obj as any)?.detail || detail)
          } catch {
          }
          if (String(detail) === 'CONFIRM_SEND_REQUIRED') {
            setChatNeedsConfirm(true)
          }
          throw new Error(`${res.status} ${detail}`)
        }

        if (!isEventStream || !res.body) {
          const txt = await res.text().catch(() => '')
          const obj = txt ? (JSON.parse(txt) as any) : null
          const detail = obj?.detail ? String(obj.detail) : null
          setChatDetail(detail)
          setChatAnswer(obj?.answer ? String(obj.answer) : '')
          setChatCitations(Array.isArray(obj?.citations) ? (obj.citations as ChatCitationItem[]) : [])

          if (res.status === 202) {
            const jobId = obj?.job_id ? String(obj.job_id) : ''
            if (jobId) {
              setIndexJobId(jobId)
              setIndexJob(null)
              setAutoIndexLoadedForJobId(null)
              setChatWaitingIndex(true)
              chatPendingAfterIndexRef.current = {
                query,
                top_k: topK,
                confirm_send: confirmSend
              }
            }
          }
          return
        }

        const reader = res.body.getReader()
        const decoder = new TextDecoder('utf-8')
        let buf = ''
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })

          while (true) {
            const sepIdx = buf.indexOf('\n\n')
            if (sepIdx < 0) break
            const raw = buf.slice(0, sepIdx)
            buf = buf.slice(sepIdx + 2)

            const lines = raw.split('\n')
            let ev = 'message'
            const dataLines: string[] = []
            for (const line of lines) {
              const s = String(line || '')
              if (s.startsWith('event:')) {
                ev = s.slice('event:'.length).trim() || 'message'
                continue
              }
              if (s.startsWith('data:')) {
                dataLines.push(s.slice('data:'.length).trimStart())
                continue
              }
            }

            const dataRaw = dataLines.join('\n').trim()
            if (!dataRaw) continue
            let payload: any = null
            try {
              payload = JSON.parse(dataRaw)
            } catch {
              payload = { raw: dataRaw }
            }

            if (ev === 'token') {
              const delta = payload?.delta ? String(payload.delta) : ''
              if (delta) setChatAnswer((prev) => prev + delta)
              continue
            }

            if (ev === 'done') {
              setChatDetail(payload?.mode ? String(payload.mode) : null)
              if (payload?.answer) setChatAnswer(String(payload.answer))
              setChatCitations(Array.isArray(payload?.citations) ? (payload.citations as ChatCitationItem[]) : [])
              return
            }

            if (ev === 'error') {
              const detail = payload?.detail ? String(payload.detail) : 'UNKNOWN_ERROR'
              if (detail === 'CONFIRM_SEND_REQUIRED') {
                setChatNeedsConfirm(true)
              }
              throw new Error(detail)
            }
          }
        }
      } catch (e: any) {
        const msg = e && e.name === 'AbortError' ? null : e && e.message ? String(e.message) : String(e)
        if (msg) setChatError(msg)
      } finally {
        if (chatAbortRef.current === ac) {
          chatAbortRef.current = null
        }
        setChatBusy(false)
      }
    },
    [API_BASE, chatConfirmSend, chatTopK, videoId]
  )

  const sendChat = useCallback(() => {
    const q = String(chatQuery || '').trim()
    if (!q) return
    void doChat(q)
  }, [chatQuery, doChat])

  const cancelChat = useCallback(() => {
    if (chatAbortRef.current) {
      try {
        chatAbortRef.current.abort()
      } catch {
      }
    }
    chatPendingAfterIndexRef.current = null
    setChatWaitingIndex(false)
  }, [])

  useEffect(() => {
    const pending = chatPendingAfterIndexRef.current
    if (!pending) return
    if (!indexJob) return

    const st = String((indexJob as any).status || '')
    if (st === 'completed') {
      chatPendingAfterIndexRef.current = null
      setChatWaitingIndex(false)
      void doChat(pending.query, { topK: pending.top_k, confirmSend: pending.confirm_send, fromRetry: true })
      return
    }
    if (st === 'failed' || st === 'cancelled') {
      chatPendingAfterIndexRef.current = null
      setChatWaitingIndex(false)
      setChatError('INDEX_FAILED')
    }
  }, [doChat, indexJob])

  useEffect(() => {
    if (!outlineShow) return
    void loadAlignedKeyframes({ force: true })
  }, [keyframesMethod, loadAlignedKeyframes, outlineShow])

  useEffect(() => {
    if (!outlineShow) return
    if (!summaryJobId) return
    if (!summaryJob) return
    if (String(summaryJob.status) !== 'completed') return
    void loadAlignedKeyframes({ force: true })
  }, [loadAlignedKeyframes, outlineShow, summaryJob, summaryJobId])

  useEffect(() => {
    if (!outlineShow) return
    if (!keyframesJobId) return
    if (!keyframesJob) return
    if (String(keyframesJob.status) !== 'completed') return
    void loadAlignedKeyframes({ force: true })
  }, [keyframesJob, keyframesJobId, loadAlignedKeyframes, outlineShow])

  useEffect(() => {
    activeTranscriptIndexRef.current = -1
    setActiveTranscriptIndex(-1)
  }, [videoId, transcriptSegments])

  useEffect(() => {
    const el = videoElRef.current
    if (!el) return

    const onTimeUpdate = () => {
      if (!transcriptSegments.length) return
      const t = typeof el.currentTime === 'number' && Number.isFinite(el.currentTime) ? el.currentTime : 0

      let idx = -1
      for (let i = 0; i < transcriptSegments.length; i++) {
        const seg: any = transcriptSegments[i]
        const start = typeof seg?.start === 'number' ? seg.start : Number(seg?.start || 0)
        const endRaw = typeof seg?.end === 'number' ? seg.end : Number(seg?.end || 0)
        const end = endRaw > start ? endRaw : start + 0.001
        if (t >= start && t < end) {
          idx = i
          break
        }
      }

      if (idx !== activeTranscriptIndexRef.current) {
        activeTranscriptIndexRef.current = idx
        setActiveTranscriptIndex(idx)
      }
    }

    el.addEventListener('timeupdate', onTimeUpdate)
    return () => {
      el.removeEventListener('timeupdate', onTimeUpdate)
    }
  }, [transcriptSegments])

  useEffect(() => {
    const el = activeTranscriptElRef.current
    if (!el) return
    try {
      el.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    } catch {
    }
  }, [activeTranscriptIndex])

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

    setTranscriptBusy(false)
    setTranscriptError(null)
    setTranscriptSegments([])
    setAutoTranscriptLoadedForJobId(null)

    setLastIndexJob(null)
    setIndexJobId(null)
    setIndexJob(null)
    setIndexSseState('idle')
    setIndexSseError(null)
    setIndexStatusBusy(false)
    setIndexStatusError(null)
    setIndexStatus(null)
    setAutoIndexLoadedForJobId(null)

    setLastSummarizeJob(null)
    setSummaryJobId(null)
    setSummaryJob(null)
    setSummarySseState('idle')
    setSummarySseError(null)
    setSummaryBusy(false)
    setSummaryError(null)
    setSummaryStatus(null)
    setSummaryShowFull(false)
    setOutlineBusy(false)
    setOutlineError(null)
    setOutlineRes(null)
    setOutlineShow(false)
    setAlignedKeyframesBusy(false)
    setAlignedKeyframesError(null)
    setAlignedKeyframesItems([])
    setAutoSummaryLoadedForJobId(null)

    setLastKeyframesJob(null)
    setKeyframesJobId(null)
    setKeyframesJob(null)
    setKeyframesSseState('idle')
    setKeyframesSseError(null)
    setKeyframesIndexBusy(false)
    setKeyframesIndexError(null)
    setKeyframesIndex(null)
    setKeyframesListBusy(false)
    setKeyframesListError(null)
    setKeyframesItems([])
    setAutoKeyframesLoadedForJobId(null)
  }, [videoId])

  const loadIndexStatus = useCallback(
    async (opts?: { force?: boolean }) => {
      if (indexStatusInFlightRef.current) return
      indexStatusInFlightRef.current = true
      setIndexStatusBusy(true)
      setIndexStatusError(null)
      try {
        const res = await api.getVideoIndex(videoId)
        setIndexStatus(res)
      } catch (e: any) {
        const msg = e && e.message ? String(e.message) : String(e)
        setIndexStatusError(msg)
        setIndexStatus(null)
      } finally {
        setIndexStatusBusy(false)
        indexStatusInFlightRef.current = false
      }
    },
    [videoId]
  )

  const loadSummary = useCallback(
    async (opts?: { force?: boolean }) => {
      if (summaryInFlightRef.current) return
      summaryInFlightRef.current = true
      setSummaryBusy(true)
      setSummaryError(null)
      try {
        const res = await api.getVideoSummary(videoId)
        setSummaryStatus(res)
      } catch (e: any) {
        const msg = e && e.message ? String(e.message) : String(e)
        setSummaryError(msg)
        setSummaryStatus(null)
      } finally {
        setSummaryBusy(false)
        summaryInFlightRef.current = false
      }
    },
    [videoId]
  )

  const loadOutline = useCallback(
    async (opts?: { force?: boolean }) => {
      if (outlineInFlightRef.current) return
      outlineInFlightRef.current = true
      setOutlineBusy(true)
      setOutlineError(null)
      try {
        const res = await api.getVideoOutline(videoId)
        setOutlineRes(res)
      } catch (e: any) {
        const msg = e && e.message ? String(e.message) : String(e)
        setOutlineError(msg)
        setOutlineRes(null)
      } finally {
        setOutlineBusy(false)
        outlineInFlightRef.current = false
      }
    },
    [videoId]
  )

  const loadKeyframesIndex = useCallback(
    async (opts?: { force?: boolean }) => {
      if (keyframesIndexInFlightRef.current) return
      keyframesIndexInFlightRef.current = true
      setKeyframesIndexBusy(true)
      setKeyframesIndexError(null)
      try {
        const res = await api.getKeyframesIndex(videoId)
        setKeyframesIndex(res)
      } catch (e: any) {
        const msg = e && e.message ? String(e.message) : String(e)
        setKeyframesIndexError(msg)
        setKeyframesIndex(null)
      } finally {
        setKeyframesIndexBusy(false)
        keyframesIndexInFlightRef.current = false
      }
    },
    [videoId]
  )

  const loadKeyframesList = useCallback(
    async (opts?: { force?: boolean }) => {
      if (keyframesListInFlightRef.current) return
      keyframesListInFlightRef.current = true
      setKeyframesListBusy(true)
      setKeyframesListError(null)
      try {
        const m = keyframesMethod === 'all' ? undefined : keyframesMethod
        const res = await api.listKeyframes(videoId, { method: m, limit: keyframesLimit, offset: 0 })
        setKeyframesItems(Array.isArray(res.items) ? res.items : [])
      } catch (e: any) {
        const msg = e && e.message ? String(e.message) : String(e)
        setKeyframesListError(msg)
        setKeyframesItems([])
      } finally {
        setKeyframesListBusy(false)
        keyframesListInFlightRef.current = false
      }
    },
    [keyframesLimit, keyframesMethod, videoId]
  )

  useEffect(() => {
    void loadIndexStatus({ force: true })
  }, [loadIndexStatus])

  useEffect(() => {
    void loadSummary({ force: true })
  }, [loadSummary])

  useEffect(() => {
    void loadKeyframesIndex({ force: true })
  }, [loadKeyframesIndex])

  useEffect(() => {
    void loadKeyframesList({ force: true })
  }, [loadKeyframesList])

  const loadTranscriptPreview = useCallback(
    async (opts?: { force?: boolean }) => {
      if (!opts?.force && transcriptBusy) return
      setTranscriptBusy(true)
      setTranscriptError(null)
      try {
        const res = await api.getTranscript(videoId, { limit: transcriptLimit })
        const segs = Array.isArray(res.segments) ? res.segments : []
        setTranscriptSegments(segs)
      } catch (e: any) {
        const msg = e && e.message ? String(e.message) : String(e)
        setTranscriptError(msg)
        setTranscriptSegments([])
      } finally {
        setTranscriptBusy(false)
      }
    },
    [transcriptBusy, transcriptLimit, videoId]
  )

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

  useEffect(() => {
    if (!transcribeJobId) return
    if (!transcribeJob) return
    if (String(transcribeJob.status) !== 'completed') return
    if (autoTranscriptLoadedForJobId === transcribeJobId) return

    setAutoTranscriptLoadedForJobId(transcribeJobId)
    void loadTranscriptPreview({ force: true })
  }, [autoTranscriptLoadedForJobId, loadTranscriptPreview, transcribeJob, transcribeJobId])

  useEffect(() => {
    if (!indexJobId) {
      setIndexSseState('idle')
      setIndexSseError(null)
      return
    }

    let closed = false
    let es: EventSource | null = null

    setIndexSseState('connecting')
    setIndexSseError(null)

    api
      .getJob(indexJobId)
      .then((j) => {
        if (closed) return
        setIndexJob(j)
        if (isTerminalJobStatus(j.status)) {
          setIndexSseState('closed')
        }
      })
      .catch((e: any) => {
        if (closed) return
        const msg = e && e.message ? String(e.message) : String(e)
        setIndexSseError(msg)
      })

    try {
      const url = `${API_BASE}/jobs/${encodeURIComponent(indexJobId)}/events`
      es = new EventSource(url)

      es.onopen = () => {
        if (closed) return
        setIndexSseState('open')
      }

      es.onerror = () => {
        if (closed) return
        setIndexSseState('connecting')
      }

      const onJob = (evt: MessageEvent) => {
        if (closed) return
        try {
          const payload = JSON.parse(String(evt.data || ''))
          const j = payload && payload.job ? (payload.job as JobItem) : null
          if (j) {
            setIndexJob(j)
            if (isTerminalJobStatus(j.status)) {
              try {
                es?.close()
              } catch {
              }
              setIndexSseState('closed')
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
          setIndexSseError(detail)
        } catch {
          setIndexSseError('SSE_ERROR')
        }
      }

      es.addEventListener('job', onJob as any)
      es.addEventListener('error', onErr as any)
    } catch (e: any) {
      const msg = e && e.message ? String(e.message) : String(e)
      setIndexSseError(msg)
      setIndexSseState('error')
    }

    return () => {
      closed = true
      try {
        es?.close()
      } catch {
      }
      es = null
    }
  }, [isTerminalJobStatus, indexJobId])

  useEffect(() => {
    if (!indexJobId) return
    if (!indexJob) return
    if (String(indexJob.status) !== 'completed') return
    if (autoIndexLoadedForJobId === indexJobId) return

    setAutoIndexLoadedForJobId(indexJobId)
    void loadIndexStatus({ force: true })
  }, [autoIndexLoadedForJobId, indexJob, indexJobId, loadIndexStatus])

  useEffect(() => {
    if (!summaryJobId) {
      setSummarySseState('idle')
      setSummarySseError(null)
      return
    }

    let closed = false
    let es: EventSource | null = null

    setSummarySseState('connecting')
    setSummarySseError(null)

    api
      .getJob(summaryJobId)
      .then((j) => {
        if (closed) return
        setSummaryJob(j)
        if (isTerminalJobStatus(j.status)) {
          setSummarySseState('closed')
        }
      })
      .catch((e: any) => {
        if (closed) return
        const msg = e && e.message ? String(e.message) : String(e)
        setSummarySseError(msg)
      })

    try {
      const url = `${API_BASE}/jobs/${encodeURIComponent(summaryJobId)}/events`
      es = new EventSource(url)

      es.onopen = () => {
        if (closed) return
        setSummarySseState('open')
      }

      es.onerror = () => {
        if (closed) return
        setSummarySseState('connecting')
      }

      const onJob = (evt: MessageEvent) => {
        if (closed) return
        try {
          const payload = JSON.parse(String(evt.data || ''))
          const j = payload && payload.job ? (payload.job as JobItem) : null
          if (j) {
            setSummaryJob(j)
            if (isTerminalJobStatus(j.status)) {
              try {
                es?.close()
              } catch {
              }
              setSummarySseState('closed')
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
          setSummarySseError(detail)
        } catch {
          setSummarySseError('SSE_ERROR')
        }
      }

      es.addEventListener('job', onJob as any)
      es.addEventListener('error', onErr as any)
    } catch (e: any) {
      const msg = e && e.message ? String(e.message) : String(e)
      setSummarySseError(msg)
      setSummarySseState('error')
    }

    return () => {
      closed = true
      try {
        es?.close()
      } catch {
      }
      es = null
    }
  }, [isTerminalJobStatus, summaryJobId])

  useEffect(() => {
    if (!summaryJobId) return
    if (!summaryJob) return
    if (String(summaryJob.status) !== 'completed') return
    if (autoSummaryLoadedForJobId === summaryJobId) return

    setAutoSummaryLoadedForJobId(summaryJobId)
    void loadSummary({ force: true })
    void loadOutline({ force: true })
  }, [autoSummaryLoadedForJobId, loadOutline, loadSummary, summaryJob, summaryJobId])

  useEffect(() => {
    if (!keyframesJobId) {
      setKeyframesSseState('idle')
      setKeyframesSseError(null)
      return
    }

    let closed = false
    let es: EventSource | null = null

    setKeyframesSseState('connecting')
    setKeyframesSseError(null)

    api
      .getJob(keyframesJobId)
      .then((j) => {
        if (closed) return
        setKeyframesJob(j)
        if (isTerminalJobStatus(j.status)) {
          setKeyframesSseState('closed')
        }
      })
      .catch((e: any) => {
        if (closed) return
        const msg = e && e.message ? String(e.message) : String(e)
        setKeyframesSseError(msg)
      })

    try {
      const url = `${API_BASE}/jobs/${encodeURIComponent(keyframesJobId)}/events`
      es = new EventSource(url)

      es.onopen = () => {
        if (closed) return
        setKeyframesSseState('open')
      }

      es.onerror = () => {
        if (closed) return
        setKeyframesSseState('connecting')
      }

      const onJob = (evt: MessageEvent) => {
        if (closed) return
        try {
          const payload = JSON.parse(String(evt.data || ''))
          const j = payload && payload.job ? (payload.job as JobItem) : null
          if (j) {
            setKeyframesJob(j)
            if (isTerminalJobStatus(j.status)) {
              try {
                es?.close()
              } catch {
              }
              setKeyframesSseState('closed')
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
          setKeyframesSseError(detail)
        } catch {
          setKeyframesSseError('SSE_ERROR')
        }
      }

      es.addEventListener('job', onJob as any)
      es.addEventListener('error', onErr as any)
    } catch (e: any) {
      const msg = e && e.message ? String(e.message) : String(e)
      setKeyframesSseError(msg)
      setKeyframesSseState('error')
    }

    return () => {
      closed = true
      try {
        es?.close()
      } catch {
      }
      es = null
    }
  }, [isTerminalJobStatus, keyframesJobId])

  useEffect(() => {
    if (!keyframesJobId) return
    if (!keyframesJob) return
    if (String(keyframesJob.status) !== 'completed') return
    if (autoKeyframesLoadedForJobId === keyframesJobId) return

    setAutoKeyframesLoadedForJobId(keyframesJobId)
    void loadKeyframesIndex({ force: true })
    void loadKeyframesList({ force: true })
  }, [autoKeyframesLoadedForJobId, keyframesJob, keyframesJobId, loadKeyframesIndex, loadKeyframesList])

  const startTranscribe = useCallback(async () => {
    setBusy(true)
    setError(null)
    setInfo(null)
    setTranscriptError(null)
    setTranscriptSegments([])
    setAutoTranscriptLoadedForJobId(null)
    try {
      const segmentSeconds = parseOptionalInt(asrSegmentSeconds)
      const overlapSeconds = parseOptionalInt(asrOverlapSeconds)

      const payload: {
        video_id: string
        segment_seconds?: number
        overlap_seconds?: number
        from_scratch?: boolean
      } = {
        video_id: videoId
      }
      if (typeof segmentSeconds === 'number') payload.segment_seconds = segmentSeconds
      if (typeof overlapSeconds === 'number') payload.overlap_seconds = overlapSeconds
      if (asrFromScratch) payload.from_scratch = true

      const job = await api.createTranscribeJob(payload)
      setLastTranscribeJob(job)
      setTranscribeJobId(job.id)
      setTranscribeJob(job)
      setTranscribeSseError(null)
      setInfo(`Started transcribe job: ${job.id}`)
    } catch (e: any) {
      const msg = e && e.message ? String(e.message) : String(e)
      setError(msg)
    } finally {
      setBusy(false)
    }
  }, [api, asrFromScratch, asrOverlapSeconds, asrSegmentSeconds, parseOptionalInt, videoId])

  const startJob = useCallback(
    async (kind: 'transcribe' | 'index' | 'summarize' | 'keyframes') => {
      setBusy(true)
      setError(null)
      setInfo(null)
      try {
        if (kind === 'transcribe') {
          await startTranscribe()
        } else if (kind === 'index') {
          const r = await api.createIndexJob(videoId, { from_scratch: false })
          setLastIndexJob(r)
          if (r.status === 202 && r.job_id) {
            setIndexJobId(r.job_id)
            setIndexJob(null)
            setAutoIndexLoadedForJobId(null)
            setInfo(`Started ${kind} job: ${r.job_id}`)
          } else {
            setInfo(`Index: ${r.detail || 'OK'}`)
            void loadIndexStatus({ force: true })
          }
        } else if (kind === 'summarize') {
          const r = await api.createSummarizeJob(videoId, { from_scratch: false })
          setLastSummarizeJob(r)
          if (r.status === 202 && r.job_id) {
            setSummaryJobId(r.job_id)
            setSummaryJob(null)
            setAutoSummaryLoadedForJobId(null)
            setInfo(`Started ${kind} job: ${r.job_id}`)
          } else {
            setInfo(`Summarize: ${r.detail || 'OK'}`)
            void loadSummary({ force: true })
          }
        } else {
          const mode = keyframesMethod === 'scene' ? 'scene' : 'interval'
          const r = await api.createKeyframesJob(videoId, { from_scratch: false, mode })
          setLastKeyframesJob(r)
          if (r.status === 202 && r.job_id) {
            setKeyframesJobId(r.job_id)
            setKeyframesJob(null)
            setAutoKeyframesLoadedForJobId(null)
            setInfo(`Started ${kind} job: ${r.job_id}`)
          } else {
            setInfo(`Keyframes: ${r.detail || 'OK'}`)
            void loadKeyframesIndex({ force: true })
            void loadKeyframesList({ force: true })
          }
        }
      } catch (e: any) {
        const msg = e && e.message ? String(e.message) : String(e)
        setError(msg)
      } finally {
        setBusy(false)
      }
    },
    [keyframesMethod, loadIndexStatus, loadKeyframesIndex, loadKeyframesList, loadSummary, startTranscribe, videoId]
  )

  const headerTitle = useMemo(() => {
    if (video?.title) return String(video.title)
    return videoId
  }, [video?.title, videoId])

  const transcribeProgressText = useMemo(() => {
    if (!transcribeJob) return '-'
    return fmtPct(typeof transcribeJob.progress === 'number' ? transcribeJob.progress : 0)
  }, [transcribeJob])

  const indexProgressText = useMemo(() => {
    if (!indexJob) return '-'
    return fmtPct(typeof indexJob.progress === 'number' ? indexJob.progress : 0)
  }, [fmtPct, indexJob])

  const summaryProgressText = useMemo(() => {
    if (!summaryJob) return '-'
    return fmtPct(typeof summaryJob.progress === 'number' ? summaryJob.progress : 0)
  }, [fmtPct, summaryJob])

  const keyframesProgressText = useMemo(() => {
    if (!keyframesJob) return '-'
    return fmtPct(typeof keyframesJob.progress === 'number' ? keyframesJob.progress : 0)
  }, [fmtPct, keyframesJob])

  const hasAnyAlignedKeyframes = useMemo(() => {
    if (!Array.isArray(alignedKeyframesItems)) return false
    return alignedKeyframesItems.some((it: any) => Array.isArray(it?.keyframes) && it.keyframes.length > 0)
  }, [alignedKeyframesItems])

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
        <h3 style={{ margin: 0 }}>{'\u64ad\u653e\u5668'}</h3>
        <div className="subcard" style={{ padding: 12 }}>
          <video
            key={videoId}
            ref={videoElRef}
            src={videoFileUrl}
            controls
            preload="metadata"
            onLoadedMetadata={onVideoLoadedMetadata}
            style={{ width: '100%', maxHeight: 520, background: 'rgba(0,0,0,0.35)', borderRadius: 8 }}
          >
            <track
              kind="subtitles"
              src={subtitlesVttUrl}
              srcLang="zh"
              label={'\u4e2d\u6587'}
              default
            />
          </video>
          <div className="muted" style={{ marginTop: 8 }}>
            {'\u652f\u6301\u70b9\u51fb\u8f6c\u5199\u6bb5\u843d\u6216\u5173\u952e\u5e27\u8df3\u8f6c\u5230\u5bf9\u5e94\u65f6\u95f4\u6233\u3002'}
          </div>
        </div>
      </div>

      <div className="card">
        <h3 style={{ margin: 0 }}>{'\u64cd\u4f5c'}</h3>
        <div className="subcard">
          <div style={{ fontWeight: 700, marginBottom: 8 }}>{'\u8f6c\u5199\u53c2\u6570'}</div>
          <div className="kv">
            <div className="k">segment_seconds</div>
            <div className="v">
              <input
                value={asrSegmentSeconds}
                onChange={(e) => setAsrSegmentSeconds(e.target.value)}
                placeholder="(default)"
                style={{ width: 140 }}
                disabled={busy}
              />
            </div>
          </div>
          <div className="kv">
            <div className="k">overlap_seconds</div>
            <div className="v">
              <input
                value={asrOverlapSeconds}
                onChange={(e) => setAsrOverlapSeconds(e.target.value)}
                placeholder="(default)"
                style={{ width: 140 }}
                disabled={busy}
              />
            </div>
          </div>
          <div className="kv">
            <div className="k">from_scratch</div>
            <div className="v">
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                <input
                  type="checkbox"
                  checked={asrFromScratch}
                  onChange={(e) => setAsrFromScratch(e.target.checked)}
                  disabled={busy}
                />
                <span className="muted">{'\u4ece\u5934\u8f6c\u5199'}</span>
              </label>
            </div>
          </div>

          <div className="row" style={{ marginTop: 10 }}>
            <button className="btn primary" onClick={startTranscribe} disabled={busy}>
              {'\u542f\u52a8\u8f6c\u5199'}
            </button>
          </div>
          <div className="muted" style={{ marginTop: 8 }}>
            {'\u7559\u7a7a\u8868\u793a\u4f7f\u7528\u540e\u7aef\u9ed8\u8ba4\u503c\u3002'}
          </div>
        </div>

        <div className="row">
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
          <div className="muted">{'\u5df2\u652f\u6301\u7d22\u5f15/\u6458\u8981/\u5173\u952e\u5e27\u7684\u8fdb\u5ea6\u8ba2\u9605\uff08SSE\uff09\u548c\u7ed3\u679c\u9884\u89c8\u3002'}</div>
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
            <div className="muted">job: {indexJobId || (lastIndexJob ? lastIndexJob.job_id || '-' : '-')}</div>
            <div className="muted">status: {indexJob ? String(indexJob.status) : '-'}</div>
            <div className="muted">progress: {indexProgressText}</div>
            <div className="muted">message: {indexJob ? String(indexJob.message || '') : '-'}</div>
            <div className="muted">sse: {indexSseState}</div>
            {indexSseError ? <div className="muted">error: {indexSseError}</div> : null}
          </div>
          <div className="subcard">
            <div style={{ fontWeight: 700 }}>{'\u6458\u8981'}</div>
            <div className="muted">job: {summaryJobId || (lastSummarizeJob ? lastSummarizeJob.job_id || '-' : '-')}</div>
            <div className="muted">status: {summaryJob ? String(summaryJob.status) : '-'}</div>
            <div className="muted">progress: {summaryProgressText}</div>
            <div className="muted">message: {summaryJob ? String(summaryJob.message || '') : '-'}</div>
            <div className="muted">sse: {summarySseState}</div>
            {summarySseError ? <div className="muted">error: {summarySseError}</div> : null}
          </div>
          <div className="subcard">
            <div style={{ fontWeight: 700 }}>{'\u5173\u952e\u5e27'}</div>
            <div className="muted">job: {keyframesJobId || (lastKeyframesJob ? lastKeyframesJob.job_id || '-' : '-')}</div>
            <div className="muted">status: {keyframesJob ? String(keyframesJob.status) : '-'}</div>
            <div className="muted">progress: {keyframesProgressText}</div>
            <div className="muted">message: {keyframesJob ? String(keyframesJob.message || '') : '-'}</div>
            <div className="muted">sse: {keyframesSseState}</div>
            {keyframesSseError ? <div className="muted">error: {keyframesSseError}</div> : null}
          </div>
        </div>
      </div>

      <div className="card">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <h3 style={{ margin: 0 }}>{'\u7d22\u5f15\u7ed3\u679c\u9884\u89c8'}</h3>
          <div className="row" style={{ marginTop: 0 }}>
            <button className="btn" onClick={() => loadIndexStatus({ force: true })} disabled={busy || indexStatusBusy}>
              {'\u5237\u65b0\u9884\u89c8'}
            </button>
          </div>
        </div>

        {indexStatusError ? <div className="alert alert-error">{indexStatusError}</div> : null}
        {indexStatusBusy ? <div className="muted">{'\u6b63\u5728\u52a0\u8f7d...'} </div> : null}

        {!indexStatusBusy && !indexStatus ? <div className="muted">{'-'} </div> : null}

        {indexStatus ? (
          <div className="subcard">
            <div className="kv">
              <div className="k">status</div>
              <div className="v">{String(indexStatus.status || '')}</div>
            </div>
            <div className="kv">
              <div className="k">progress</div>
              <div className="v">{fmtPct(typeof indexStatus.progress === 'number' ? indexStatus.progress : 0)}</div>
            </div>
            <div className="kv">
              <div className="k">message</div>
              <div className="v" style={{ wordBreak: 'break-word' }}>{String(indexStatus.message || '')}</div>
            </div>
            <div className="kv">
              <div className="k">chunk_count</div>
              <div className="v">{String(indexStatus.chunk_count ?? '')}</div>
            </div>
            <div className="kv">
              <div className="k">indexed_count</div>
              <div className="v">{String(indexStatus.indexed_count ?? '')}</div>
            </div>
            <div className="kv">
              <div className="k">is_stale</div>
              <div className="v">{String(Boolean(indexStatus.is_stale))}</div>
            </div>
            {indexStatus.error_code || indexStatus.error_message ? (
              <div className="muted" style={{ marginTop: 8 }}>
                error: {String(indexStatus.error_code || '')} {String(indexStatus.error_message || '')}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="card">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <h3 style={{ margin: 0 }}>{'\u0041\u0049 \u52a9\u624b'}</h3>
          <div className="row" style={{ marginTop: 0 }}>
            <div className="muted">top_k</div>
            <input
              value={String(chatTopK)}
              onChange={(e) => {
                const n = parseInt(e.target.value || '0', 10)
                const v = Number.isFinite(n) ? n : 5
                setChatTopK(Math.max(1, Math.min(20, v)))
              }}
              style={{ width: 80 }}
              disabled={busy || chatBusy}
            />
            <button className="btn primary" onClick={sendChat} disabled={busy || chatBusy || !String(chatQuery || '').trim()}>
              {chatBusy ? '\u6b63\u5728\u751f\u6210...' : '\u53d1\u9001'}
            </button>
            <button className="btn" onClick={cancelChat} disabled={busy || !chatBusy}>
              {'\u53d6\u6d88'}
            </button>
          </div>
        </div>

        {chatError ? <div className="alert alert-error">{chatError}</div> : null}
        {chatDetail ? <div className="alert alert-info">{chatDetail}</div> : null}
        {chatWaitingIndex ? <div className="alert alert-info">{'\u6b63\u5728\u7b49\u5f85\u7d22\u5f15\u5b8c\u6210\uff0c\u5b8c\u6210\u540e\u5c06\u81ea\u52a8\u91cd\u8bd5...'} </div> : null}

        <div className="subcard">
          <div className="muted" style={{ marginBottom: 6 }}>
            {'\u8bf7\u8f93\u5165\u4f60\u7684\u95ee\u9898\uff0c\u5982\uff1a\u8fd9\u4e2a\u89c6\u9891\u7684\u4e3b\u8981\u7ed3\u8bba\u662f\u4ec0\u4e48\uff1f'}
          </div>
          {chatNeedsConfirm ? (
            <div className="alert alert-info">{'\u9700\u8981\u786e\u8ba4\u5411\u5916\u90e8\u6a21\u578b\u63d0\u4ea4\u8bf7\u6c42\u3002\u8bf7\u52fe\u9009\u786e\u8ba4\u540e\u518d\u53d1\u9001\u3002'}</div>
          ) : null}
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <input
              type="checkbox"
              checked={chatConfirmSend}
              onChange={(e) => setChatConfirmSend(e.target.checked)}
              disabled={busy || chatBusy}
            />
            <span className="muted">{'\u786e\u8ba4\u53d1\u9001\uff08confirm_send\uff09'}</span>
          </label>
          <textarea
            value={chatQuery}
            onChange={(e) => setChatQuery(e.target.value)}
            rows={4}
            style={{ width: '100%', resize: 'vertical' }}
            disabled={busy || chatBusy}
          />
        </div>

        {chatAnswer ? (
          <div className="subcard">
            <div style={{ fontWeight: 700, marginBottom: 6 }}>{'\u56de\u7b54'}</div>
            <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{chatAnswer}</div>
          </div>
        ) : null}

        {chatCitations.length ? (
          <div className="subcard">
            <div style={{ fontWeight: 700, marginBottom: 6 }}>{'\u5f15\u7528'}</div>
            <div style={{ display: 'grid', gap: 10 }}>
              {chatCitations.slice(0, 8).map((c, idx) => {
                const start = typeof (c as any).start_time === 'number' ? (c as any).start_time : Number((c as any).start_time || 0)
                const end = typeof (c as any).end_time === 'number' ? (c as any).end_time : Number((c as any).end_time || 0)
                const score = typeof (c as any).score === 'number' ? (c as any).score : Number((c as any).score || 0)
                const text = String((c as any).text || '')
                return (
                  <div
                    key={idx}
                    onClick={() => seekToSeconds(start, { play: true })}
                    style={{
                      border: '1px solid rgba(255,255,255,0.06)',
                      borderRadius: 8,
                      padding: 10,
                      cursor: 'pointer'
                    }}
                  >
                    <div className="muted" style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                      <div>
                        {fmtTime(start)}{end > 0 ? ` - ${fmtTime(end)}` : ''}
                      </div>
                      <div>{'score '} {fmtScore(score)}</div>
                    </div>
                    <div style={{ marginTop: 6, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{text.slice(0, 360)}</div>
                  </div>
                )
              })}
            </div>
          </div>
        ) : null}
      </div>

      <div className="card">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <h3 style={{ margin: 0 }}>{'\u6458\u8981\u7ed3\u679c\u9884\u89c8'}</h3>
          <div className="row" style={{ marginTop: 0 }}>
            <button className="btn" onClick={() => loadSummary({ force: true })} disabled={busy || summaryBusy}>
              {'\u5237\u65b0\u9884\u89c8'}
            </button>
            <button
              className="btn"
              onClick={() => {
                const next = !outlineShow
                setOutlineShow(next)
                if (next) {
                  void loadOutline({ force: true })
                  void loadAlignedKeyframes({ force: true })
                }
              }}
              disabled={busy}
            >
              {outlineShow ? '\u9690\u85cf\u5927\u7eb2' : '\u663e\u793a\u5927\u7eb2'}
            </button>
          </div>
        </div>

        {summaryError ? <div className="alert alert-error">{summaryError}</div> : null}
        {summaryBusy ? <div className="muted">{'\u6b63\u5728\u52a0\u8f7d...'} </div> : null}

        {summaryStatus ? (
          <div className="subcard">
            <div className="kv">
              <div className="k">status</div>
              <div className="v">{String(summaryStatus.status || '')}</div>
            </div>
            <div className="kv">
              <div className="k">progress</div>
              <div className="v">{fmtPct(typeof summaryStatus.progress === 'number' ? summaryStatus.progress : 0)}</div>
            </div>
            <div className="kv">
              <div className="k">message</div>
              <div className="v" style={{ wordBreak: 'break-word' }}>{String(summaryStatus.message || '')}</div>
            </div>
            <div className="kv">
              <div className="k">is_stale</div>
              <div className="v">{String(Boolean(summaryStatus.is_stale))}</div>
            </div>
            {summaryStatus.error_code || summaryStatus.error_message ? (
              <div className="muted" style={{ marginTop: 8 }}>
                error: {String(summaryStatus.error_code || '')} {String(summaryStatus.error_message || '')}
              </div>
            ) : null}
          </div>
        ) : null}

        {summaryStatus && String(summaryStatus.status || '') === 'completed' ? (
          <div className="subcard">
            <div className="row" style={{ marginTop: 0, justifyContent: 'space-between' }}>
              <div style={{ fontWeight: 700 }}>{'markdown'}</div>
              <button className="btn" onClick={() => setSummaryShowFull((v) => !v)} disabled={busy}>
                {summaryShowFull ? '\u6536\u8d77' : '\u5c55\u5f00'}
              </button>
            </div>
            <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 320, overflow: 'auto' }}>
              {summaryShowFull
                ? String((summaryStatus as any).summary_markdown || '')
                : String((summaryStatus as any).summary_markdown || '').slice(0, 4000)}
            </div>
          </div>
        ) : null}

        {outlineShow ? (
          <div className="subcard">
            <div style={{ fontWeight: 700, marginBottom: 8 }}>{'\u5927\u7eb2'}</div>
            {outlineError ? <div className="alert alert-error">{outlineError}</div> : null}
            {outlineBusy ? <div className="muted">{'\u6b63\u5728\u52a0\u8f7d...'} </div> : null}
            {alignedKeyframesError ? <div className="alert alert-error">{alignedKeyframesError}</div> : null}
            {alignedKeyframesBusy ? <div className="muted">{'\u6b63\u5728\u52a0\u8f7d\u5173\u952e\u5e27...'} </div> : null}

            {String(outlineError || '').includes('SUMMARY_NOT_FOUND') ? (
              <div className="subcard">
                <div className="muted">{'\u672a\u627e\u5230\u6458\u8981\uff0c\u8bf7\u5148\u751f\u6210\u6458\u8981\u540e\u518d\u67e5\u770b\u5927\u7eb2\u3002'}</div>
                <div className="row" style={{ marginTop: 10 }}>
                  <button className="btn primary" onClick={() => startJob('summarize')} disabled={busy}>
                    {'\u751f\u6210\u6458\u8981'}
                  </button>
                </div>
              </div>
            ) : null}

            {String(alignedKeyframesError || '').includes('SUMMARY_NOT_FOUND') ? (
              <div className="subcard">
                <div className="muted">{'\u5bf9\u9f50\u5173\u952e\u5e27\u9700\u8981\u5927\u7eb2\u3002\u8bf7\u5148\u751f\u6210\u6458\u8981\u3002'}</div>
              </div>
            ) : null}

            {String(alignedKeyframesError || '').includes('UNSUPPORTED_KEYFRAMES_METHOD') ? (
              <div className="subcard">
                <div className="muted">{'\u5f53\u524d\u65b9\u5f0f\u4e0d\u652f\u6301\u5bf9\u9f50\u3002\u8bf7\u9009\u62e9 interval \u6216 scene \u7c7b\u578b\u7684\u5173\u952e\u5e27\u3002'}</div>
              </div>
            ) : null}

            {!alignedKeyframesBusy && !alignedKeyframesError && outlineRes && !hasAnyAlignedKeyframes ? (
              <div className="subcard">
                <div className="muted">{'\u672a\u627e\u5230\u5bf9\u9f50\u5173\u952e\u5e27\uff0c\u8bf7\u5148\u751f\u6210\u5173\u952e\u5e27\uff08\u6216\u8005\u5207\u6362\u540e\u91cd\u8bd5\uff09\u3002'}</div>
                <div className="row" style={{ marginTop: 10 }}>
                  <button className="btn" onClick={() => startJob('keyframes')} disabled={busy}>
                    {'\u751f\u6210\u5173\u952e\u5e27'}
                  </button>
                </div>
              </div>
            ) : null}

            {!outlineBusy && outlineRes ? (
              <div style={{ maxHeight: 320, overflow: 'auto' }}>
                {Array.isArray((outlineRes as any).outline) ? (
                  ((outlineRes as any).outline as any[]).map((it: any, idx: number) => {
                    const title = String(it?.title || `#${idx + 1}`)
                    const start = typeof it?.start_time === 'number' ? it.start_time : Number(it?.start_time || 0)
                    const end = typeof it?.end_time === 'number' ? it.end_time : Number(it?.end_time || 0)
                    const bullets = Array.isArray(it?.bullets) ? (it.bullets as any[]) : []
                    const aligned = Array.isArray(alignedKeyframesItems) ? (alignedKeyframesItems[idx] as any) : null
                    const kfs = Array.isArray(aligned?.keyframes) ? (aligned.keyframes as any[]) : []
                    return (
                      <div
                        key={idx}
                        onClick={() => seekToSeconds(start, { play: true })}
                        style={{
                          padding: 10,
                          border: '1px solid rgba(255,255,255,0.06)',
                          borderRadius: 8,
                          marginBottom: 10,
                          cursor: 'pointer'
                        }}
                      >
                        <div style={{ fontWeight: 700, marginBottom: 4 }}>{title}</div>
                        <div className="muted" style={{ marginBottom: bullets.length ? 6 : 0 }}>
                          {fmtTime(start)}{end > 0 ? ` - ${fmtTime(end)}` : ''}
                        </div>
                        {bullets.length ? (
                          <div style={{ marginLeft: 14 }}>
                            {bullets.slice(0, 12).map((b, j) => (
                              <div key={j} style={{ marginTop: 4, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                                {'- '}
                                {String(b || '')}
                              </div>
                            ))}
                          </div>
                        ) : null}

                        {kfs.length ? (
                          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
                            {kfs.slice(0, 3).map((kf: any) => {
                              const img = kf?.image_url ? `${API_BASE}${String(kf.image_url)}` : ''
                              const tsMs = typeof kf?.timestamp_ms === 'number' ? kf.timestamp_ms : Number(kf?.timestamp_ms || 0)
                              const sec = tsMs / 1000
                              return (
                                <div key={String(kf?.id || tsMs)}>
                                  {img ? (
                                    <img
                                      src={img}
                                      onClick={(e) => {
                                        e.stopPropagation()
                                        seekToSeconds(sec, { play: true })
                                      }}
                                      style={{ width: 120, height: 72, objectFit: 'cover', borderRadius: 6, display: 'block' }}
                                    />
                                  ) : null}
                                  <div className="muted" style={{ marginTop: 4, fontSize: 12 }}>
                                    {fmtTime(sec)}
                                  </div>
                                </div>
                              )
                            })}
                          </div>
                        ) : null}
                      </div>
                    )
                  })
                ) : (
                  <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 260, overflow: 'auto' }}>
                    {JSON.stringify((outlineRes as any).outline, null, 2)}
                  </pre>
                )}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="card">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <h3 style={{ margin: 0 }}>{'\u5173\u952e\u5e27\u9884\u89c8'}</h3>
          <div className="row" style={{ marginTop: 0 }}>
            <div className="muted">method</div>
            <select value={keyframesMethod} onChange={(e) => setKeyframesMethod(e.target.value as any)} disabled={busy}>
              <option value="interval">{'interval'}</option>
              <option value="scene">{'scene'}</option>
              <option value="all">{'all'}</option>
            </select>
            <div className="muted">limit</div>
            <input
              value={String(keyframesLimit)}
              onChange={(e) => {
                const n = parseInt(e.target.value || '0', 10)
                setKeyframesLimit(Number.isFinite(n) && n > 0 ? n : 24)
              }}
              style={{ width: 80 }}
              disabled={busy}
            />
            <button
              className="btn"
              onClick={() => {
                void loadKeyframesIndex({ force: true })
                void loadKeyframesList({ force: true })
              }}
              disabled={busy || keyframesIndexBusy || keyframesListBusy}
            >
              {'\u5237\u65b0\u9884\u89c8'}
            </button>
          </div>
        </div>

        {keyframesIndexError ? <div className="alert alert-error">{keyframesIndexError}</div> : null}
        {keyframesListError ? <div className="alert alert-error">{keyframesListError}</div> : null}

        {keyframesIndexBusy ? <div className="muted">{'\u6b63\u5728\u52a0\u8f7d...'} </div> : null}

        {keyframesIndex ? (
          <div className="subcard">
            <div className="kv">
              <div className="k">status</div>
              <div className="v">{String(keyframesIndex.status || '')}</div>
            </div>
            <div className="kv">
              <div className="k">progress</div>
              <div className="v">{fmtPct(typeof keyframesIndex.progress === 'number' ? keyframesIndex.progress : 0)}</div>
            </div>
            <div className="kv">
              <div className="k">frame_count</div>
              <div className="v">{String((keyframesIndex as any).frame_count ?? '')}</div>
            </div>
            <div className="kv">
              <div className="k">message</div>
              <div className="v" style={{ wordBreak: 'break-word' }}>{String(keyframesIndex.message || '')}</div>
            </div>
          </div>
        ) : null}

        {keyframesListBusy ? <div className="muted">{'\u6b63\u5728\u52a0\u8f7d...'} </div> : null}

        {!keyframesListBusy && keyframesItems.length === 0 ? <div className="muted">{'\u6682\u65e0\u9884\u89c8\u3002'} </div> : null}

        {keyframesItems.length > 0 ? (
          <div
            className="subcard"
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
              gap: 12,
              maxHeight: 420,
              overflow: 'auto'
            }}
          >
            {keyframesItems.map((it) => {
              const img = (it as any).image_url ? `${API_BASE}${String((it as any).image_url)}` : ''
              const ts = typeof it.timestamp_ms === 'number' ? it.timestamp_ms : Number((it as any).timestamp_ms || 0)
              const seconds = ts / 1000
              return (
                <div
                  key={String(it.id)}
                  onClick={() => seekToSeconds(seconds, { play: true })}
                  style={{
                    border: '1px solid rgba(255,255,255,0.06)',
                    borderRadius: 8,
                    padding: 8,
                    cursor: 'pointer'
                  }}
                >
                  <div className="muted" style={{ marginBottom: 6 }}>
                    {fmtTime(seconds)}
                  </div>
                  {img ? (
                    <img
                      src={img}
                      style={{ width: '100%', height: 120, objectFit: 'cover', borderRadius: 6, display: 'block' }}
                    />
                  ) : (
                    <div className="muted">{'(no image_url)'} </div>
                  )}
                </div>
              )
            })}
          </div>
        ) : null}
      </div>

      <div className="card">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <h3 style={{ margin: 0 }}>{'\u8f6c\u5199\u7ed3\u679c\u9884\u89c8'}</h3>
          <div className="row" style={{ marginTop: 0 }}>
            <div className="muted">limit</div>
            <input
              value={String(transcriptLimit)}
              onChange={(e) => {
                const n = parseInt(e.target.value || '0', 10)
                setTranscriptLimit(Number.isFinite(n) && n > 0 ? n : 30)
              }}
              style={{ width: 80 }}
              disabled={busy}
            />
            <button className="btn" onClick={() => loadTranscriptPreview({ force: true })} disabled={busy || transcriptBusy}>
              {'\u5237\u65b0\u9884\u89c8'}
            </button>
          </div>
        </div>

        {transcriptError ? <div className="alert alert-error">{transcriptError}</div> : null}

        {transcriptBusy ? <div className="muted">{'\u6b63\u5728\u52a0\u8f7d...'} </div> : null}

        {!transcriptBusy && transcriptSegments.length === 0 ? (
          <div className="muted">{'\u6682\u65e0\u9884\u89c8\u3002\u53ef\u5728\u8f6c\u5199\u5b8c\u6210\u540e\u81ea\u52a8\u51fa\u73b0\uff0c\u6216\u70b9\u51fb\u300c\u5237\u65b0\u9884\u89c8\u300d\u3002'}</div>
        ) : null}

        {transcriptSegments.length > 0 ? (
          <div className="subcard" style={{ maxHeight: 320, overflow: 'auto' }}>
            {transcriptSegments.map((seg, idx) => {
              const start = typeof (seg as any).start === 'number' ? (seg as any).start : Number((seg as any).start || 0)
              const end = typeof (seg as any).end === 'number' ? (seg as any).end : Number((seg as any).end || 0)
              const text = String((seg as any).text || (seg as any).content || '')
              const isActive = idx === activeTranscriptIndex
              return (
                <div
                  key={idx}
                  onClick={() => seekToSeconds(start, { play: true })}
                  ref={isActive ? activeTranscriptElRef : undefined}
                  style={{
                    padding: '8px 0',
                    borderBottom: '1px solid rgba(255,255,255,0.06)',
                    cursor: 'pointer',
                    background: isActive ? 'rgba(59, 130, 246, 0.14)' : 'transparent',
                    borderLeft: isActive ? '3px solid rgba(59, 130, 246, 0.9)' : '3px solid transparent',
                    paddingLeft: isActive ? 10 : 0
                  }}
                >
                  <div className="muted" style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace' }}>
                    [{fmtTime(start)} - {fmtTime(end)}]
                  </div>
                  <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{text}</div>
                </div>
              )
            })}
          </div>
        ) : null}
      </div>
    </div>
  )
}
