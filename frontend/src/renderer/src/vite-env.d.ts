/// <reference types="vite/client" />

declare global {
  interface Window {
    edgeVideoAgent?: {
      backendBaseUrl?: string
      isPackaged?: boolean
      [k: string]: any
    }
    electronAPI?: {
      openVideoFile: () => Promise<string | null>
      getAppVersion: () => Promise<{ version: string; is_packaged: boolean } | null>
      checkUpdates: () => Promise<any>
      openExternal: (url: string) => Promise<any>
      updaterGetState: () => Promise<any>
      updaterCheck: () => Promise<any>
      updaterDownload: () => Promise<any>
      updaterInstall: () => Promise<any>
      onUpdaterEvent: (callback: (payload: any) => void) => () => void
      exportDataZip: () => Promise<any>
      restoreDataZip: () => Promise<any>
      pickLlamaServerExe: () => Promise<string | null>
      pickLlamaModel: () => Promise<string | null>
      getDevConfig: () => Promise<{ path: string; config: Record<string, unknown> }>
      setDevConfig: (config: Record<string, unknown>) => Promise<{ path: string; config: Record<string, unknown> }>

      llamaGetState?: () => Promise<any>
      llamaGetLogs?: () => Promise<any>
      llamaClearLogs?: () => Promise<any>
      llamaStart?: () => Promise<any>
      llamaStop?: () => Promise<any>
      llamaRestart?: () => Promise<any>
      onLlamaEvent?: (callback: (payload: any) => void) => () => void
    }
  }
}

export {}
