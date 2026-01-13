export const API_BASE = (import.meta.env.VITE_BACKEND_BASE_URL || 'http://127.0.0.1:8001').replace(/\/$/, '')

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
  getLocalLlmStatus: () => fetchJson<LlmLocalStatusResponse>('/llm/local/status')
}
