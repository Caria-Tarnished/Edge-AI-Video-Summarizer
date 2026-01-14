export const API_BASE = (import.meta.env.VITE_BACKEND_BASE_URL || 'http://127.0.0.1:8001').replace(/\/$/, '')

export type VideoItem = {
  id: string
  file_path: string
  file_hash: string
  title: string
  duration: number
  file_size: number
  status: string
  created_at: string
  updated_at: string
}

export type ListVideosResponse = {
  total: number
  items: VideoItem[]
}

export type JobItem = {
  id: string
  video_id: string
  job_type: string
  status: string
  progress: number
  message: string
  params_json?: string | null
  result_json?: string | null
  error_code?: string | null
  error_message?: string | null
  created_at: string
  updated_at: string
  started_at?: string | null
  completed_at?: string | null
}

export type TranscriptSegment = {
  start?: number
  end?: number
  text?: string
  [k: string]: any
}

export type TranscriptResponse = {
  video_id: string
  segments: TranscriptSegment[]
}

export type VideoIndexStatus = {
  video_id: string
  status: string
  progress?: number
  message?: string
  embed_model?: string | null
  embed_dim?: number | null
  chunk_params_json?: string | null
  transcript_hash?: string | null
  current_transcript_hash?: string | null
  chunk_count?: number
  indexed_count?: number
  error_code?: string | null
  error_message?: string | null
  created_at?: string
  updated_at?: string
  is_stale?: boolean
  [k: string]: any
}

export type VideoSummaryStatus = {
  video_id: string
  status: string
  progress?: number
  message?: string
  transcript_hash?: string | null
  current_transcript_hash?: string | null
  params_json?: string | null
  segment_summaries?: any
  summary_markdown?: string | null
  outline_json?: string | null
  error_code?: string | null
  error_message?: string | null
  created_at?: string
  updated_at?: string
  is_stale?: boolean
  [k: string]: any
}

export type OutlineResponse = {
  video_id: string
  status: string
  progress: number
  message: string
  outline: any
}

export type KeyframesIndexStatus = {
  video_id: string
  status: string
  progress?: number
  message?: string
  frame_count?: number
  params_json?: string | null
  error_code?: string | null
  error_message?: string | null
  created_at?: string
  updated_at?: string
  [k: string]: any
}

export type KeyframeItem = {
  id: string
  video_id: string
  timestamp_ms: number
  image_relpath?: string
  method?: string
  width?: number | null
  height?: number | null
  score?: number | null
  metadata_json?: string | null
  created_at?: string
  image_url?: string
  [k: string]: any
}

export type ListKeyframesResponse = {
  total: number
  items: KeyframeItem[]
}

export type AlignedKeyframeItem = {
  id: string
  timestamp_ms: number
  image_url: string
  score?: number | null
  [k: string]: any
}

export type AlignedKeyframesSection = {
  title?: string | null
  start_time?: number
  end_time?: number
  keyframes: AlignedKeyframeItem[]
  [k: string]: any
}

export type AlignedKeyframesResponse = {
  video_id: string
  items: AlignedKeyframesSection[]
}

export type ChatCitationItem = {
  chunk_id?: string
  score?: number
  start_time?: number | null
  end_time?: number | null
  text?: string
  metadata?: any
  [k: string]: any
}

export type ChatResult = {
  status: number
  detail: string
  job_id: string | null
  video_id: string
  answer?: string
  citations?: ChatCitationItem[]
  raw: any
}

export type CreateVideoJobResult = {
  status: number
  detail: string
  job_id: string | null
  video_id: string
  raw: any
}

export type RuntimeProfileResponse = {
  preferences: Record<string, unknown>
  effective: Record<string, unknown>
}

export type LlmPreferencesResponse = {
  preferences: {
    provider?: string
    model?: string | null
    temperature?: number
    max_tokens?: number
    output_language?: string
  }
}

export type LlmProvidersResponse = {
  providers: string[]
}

export type LlmLocalStatusResponse = {
  provider: string
  base_url: string
  default_model: string
  ok: boolean
  models?: string[]
  error?: string
}

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: {
      'Content-Type': 'application/json'
    },
    ...init
  })
  const text = await res.text()
  const data = text ? (JSON.parse(text) as unknown) : null
  if (!res.ok) {
    const detail = (data as any)?.detail || res.statusText
    throw new Error(`${res.status} ${detail}`)
  }
  return data as T
}

async function fetchJsonWithStatus<T>(path: string, init?: RequestInit): Promise<{ status: number; data: T }> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: {
      'Content-Type': 'application/json'
    },
    ...init
  })
  const text = await res.text()
  const data = text ? (JSON.parse(text) as unknown) : null
  if (!res.ok) {
    const detail = (data as any)?.detail || res.statusText
    throw new Error(`${res.status} ${detail}`)
  }
  return { status: res.status, data: data as T }
}

function toQuery(params: Record<string, string | number | boolean | null | undefined>): string {
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined) continue
    sp.set(k, String(v))
  }
  const s = sp.toString()
  return s ? `?${s}` : ''
}

export const api = {
  getRuntimeProfile: () => fetchJson<RuntimeProfileResponse>('/runtime/profile'),
  setRuntimeProfile: (payload: Record<string, unknown>) =>
    fetchJson<RuntimeProfileResponse>('/runtime/profile', {
      method: 'PUT',
      body: JSON.stringify(payload)
    }),

  getDefaultLlmPreferences: () => fetchJson<LlmPreferencesResponse>('/llm/preferences/default'),
  setDefaultLlmPreferences: (payload: LlmPreferencesResponse['preferences']) =>
    fetchJson<LlmPreferencesResponse>('/llm/preferences/default', {
      method: 'PUT',
      body: JSON.stringify(payload)
    }),
  listLlmProviders: () => fetchJson<LlmProvidersResponse>('/llm/providers'),
  getLocalLlmStatus: () => fetchJson<LlmLocalStatusResponse>('/llm/local/status'),

  listVideos: (params?: { status?: string; limit?: number; offset?: number }) =>
    fetchJson<ListVideosResponse>(
      `/videos${toQuery({
        status: params?.status || null,
        limit: params?.limit ?? 50,
        offset: params?.offset ?? 0
      })}`
    ),
  importVideo: (file_path: string) =>
    fetchJson<VideoItem>('/videos/import', {
      method: 'POST',
      body: JSON.stringify({ file_path })
    }),
  getVideo: (video_id: string) => fetchJson<VideoItem>(`/videos/${encodeURIComponent(video_id)}`),
  getTranscript: (video_id: string, params?: { limit?: number }) =>
    fetchJson<TranscriptResponse>(
      `/videos/${encodeURIComponent(video_id)}/transcript${toQuery({
        limit: typeof params?.limit === 'number' ? params?.limit : null
      })}`
    ),
  getVideoIndex: (video_id: string) => fetchJson<VideoIndexStatus>(`/videos/${encodeURIComponent(video_id)}/index`),
  getVideoSummary: (video_id: string) => fetchJson<VideoSummaryStatus>(`/videos/${encodeURIComponent(video_id)}/summary`),
  getVideoOutline: (video_id: string) => fetchJson<OutlineResponse>(`/videos/${encodeURIComponent(video_id)}/outline`),
  getKeyframesIndex: (video_id: string) =>
    fetchJson<KeyframesIndexStatus>(`/videos/${encodeURIComponent(video_id)}/keyframes/index`),
  listKeyframes: (video_id: string, params?: { method?: string; limit?: number; offset?: number }) =>
    fetchJson<ListKeyframesResponse>(
      `/videos/${encodeURIComponent(video_id)}/keyframes${toQuery({
        method: params?.method || null,
        limit: params?.limit ?? 50,
        offset: params?.offset ?? 0
      })}`
    ),
  getAlignedKeyframes: (
    video_id: string,
    params?: {
      method?: 'interval' | 'scene'
      per_section?: number
      min_gap_seconds?: number
      fallback?: 'none' | 'nearest'
    }
  ) =>
    fetchJson<AlignedKeyframesResponse>(
      `/videos/${encodeURIComponent(video_id)}/keyframes/aligned${toQuery({
        method: params?.method || 'interval',
        per_section: params?.per_section ?? 2,
        min_gap_seconds: params?.min_gap_seconds ?? 2,
        fallback: params?.fallback || 'none'
      })}`
    ),
  createTranscribeJob: (payload: {
    video_id: string
    segment_seconds?: number
    overlap_seconds?: number
    from_scratch?: boolean
  }) =>
    fetchJson<JobItem>('/jobs/transcribe', {
      method: 'POST',
      body: JSON.stringify(payload)
    }),
  getJob: (job_id: string) => fetchJson<JobItem>(`/jobs/${encodeURIComponent(job_id)}`),
  createIndexJob: async (video_id: string, payload: { from_scratch: boolean }) => {
    const res = await fetchJsonWithStatus<any>(`/videos/${encodeURIComponent(video_id)}/index`, {
      method: 'POST',
      body: JSON.stringify(payload)
    })
    const obj = res.data as any
    return {
      status: res.status,
      detail: String(obj?.detail || ''),
      job_id: obj?.job_id ? String(obj.job_id) : null,
      video_id: obj?.video_id ? String(obj.video_id) : String(video_id),
      raw: obj
    } satisfies CreateVideoJobResult
  },
  createSummarizeJob: async (video_id: string, payload: { from_scratch: boolean }) => {
    const res = await fetchJsonWithStatus<any>(`/videos/${encodeURIComponent(video_id)}/summarize`, {
      method: 'POST',
      body: JSON.stringify(payload)
    })
    const obj = res.data as any
    return {
      status: res.status,
      detail: String(obj?.detail || ''),
      job_id: obj?.job_id ? String(obj.job_id) : null,
      video_id: obj?.video_id ? String(obj.video_id) : String(video_id),
      raw: obj
    } satisfies CreateVideoJobResult
  },
  createKeyframesJob: async (
    video_id: string,
    payload: {
      from_scratch: boolean
      mode: 'interval' | 'scene'
      interval_seconds?: number
      scene_threshold?: number
      min_gap_seconds?: number
      max_frames?: number
      target_width?: number
    }
  ) => {
    const res = await fetchJsonWithStatus<any>(`/videos/${encodeURIComponent(video_id)}/keyframes`, {
      method: 'POST',
      body: JSON.stringify(payload)
    })
    const obj = res.data as any
    return {
      status: res.status,
      detail: String(obj?.detail || ''),
      job_id: obj?.job_id ? String(obj.job_id) : null,
      video_id: obj?.video_id ? String(obj.video_id) : String(video_id),
      raw: obj
    } satisfies CreateVideoJobResult
  },

  chat: async (payload: {
    video_id: string
    query: string
    top_k?: number
    stream?: boolean
    confirm_send?: boolean
  }) => {
    const res = await fetchJsonWithStatus<any>('/chat', {
      method: 'POST',
      body: JSON.stringify({
        video_id: payload.video_id,
        query: payload.query,
        top_k: typeof payload.top_k === 'number' ? payload.top_k : 5,
        stream: Boolean(payload.stream),
        confirm_send: Boolean(payload.confirm_send)
      })
    })
    const obj = res.data as any
    return {
      status: res.status,
      detail: String(obj?.detail || obj?.mode || ''),
      job_id: obj?.job_id ? String(obj.job_id) : null,
      video_id: obj?.video_id ? String(obj.video_id) : String(payload.video_id),
      answer: obj?.answer ? String(obj.answer) : undefined,
      citations: Array.isArray(obj?.citations) ? (obj.citations as ChatCitationItem[]) : undefined,
      raw: obj
    } satisfies ChatResult
  }
}
