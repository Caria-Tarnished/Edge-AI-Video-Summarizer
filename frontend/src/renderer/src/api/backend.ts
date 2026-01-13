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
  }
}
