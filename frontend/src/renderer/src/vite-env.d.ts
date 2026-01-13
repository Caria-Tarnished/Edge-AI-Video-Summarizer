/// <reference types="vite/client" />

declare global {
  interface Window {
    electronAPI?: {
      openVideoFile: () => Promise<string | null>
      pickLlamaServerExe: () => Promise<string | null>
      pickLlamaModel: () => Promise<string | null>
      getDevConfig: () => Promise<{ path: string; config: Record<string, unknown> }>
      setDevConfig: (config: Record<string, unknown>) => Promise<{ path: string; config: Record<string, unknown> }>
    }
  }
}

export {}
