import { contextBridge, ipcRenderer } from 'electron'

const backendBaseUrl = String(process.env.EDGE_VIDEO_AGENT_BACKEND_BASE_URL || '').trim()
const isPackaged = String(process.env.EDGE_VIDEO_AGENT_IS_PACKAGED || '').trim() === '1'

contextBridge.exposeInMainWorld('edgeVideoAgent', {
  backendBaseUrl,
  isPackaged
})

contextBridge.exposeInMainWorld('electronAPI', {
  openVideoFile: async (): Promise<string | null> => {
    return await ipcRenderer.invoke('dialog:openVideo')
  },
  openDirectory: async (): Promise<string | null> => {
    return await ipcRenderer.invoke('dialog:openDirectory')
  },
  getAppVersion: async (): Promise<{ version: string; is_packaged: boolean } | null> => {
    try {
      return await ipcRenderer.invoke('app:getVersion')
    } catch {
      return null
    }
  },
  checkUpdates: async (): Promise<any> => {
    return await ipcRenderer.invoke('app:checkUpdates')
  },
  openExternal: async (url: string): Promise<any> => {
    return await ipcRenderer.invoke('app:openExternal', url)
  },
  updaterGetState: async (): Promise<any> => {
    return await ipcRenderer.invoke('updater:getState')
  },
  updaterCheck: async (): Promise<any> => {
    return await ipcRenderer.invoke('updater:check')
  },
  updaterDownload: async (): Promise<any> => {
    return await ipcRenderer.invoke('updater:download')
  },
  updaterInstall: async (): Promise<any> => {
    return await ipcRenderer.invoke('updater:install')
  },
  onUpdaterEvent: (callback: (payload: any) => void): (() => void) => {
    const handler = (_evt: any, payload: any) => {
      try {
        callback(payload)
      } catch {}
    }
    ipcRenderer.on('updater:event', handler)
    return () => {
      try {
        ipcRenderer.removeListener('updater:event', handler)
      } catch {}
    }
  },
  exportDataZip: async (): Promise<any> => {
    return await ipcRenderer.invoke('data:exportZip')
  },
  restoreDataZip: async (): Promise<any> => {
    return await ipcRenderer.invoke('data:restoreZip')
  },
  pickLlamaServerExe: async (): Promise<string | null> => {
    return await ipcRenderer.invoke('dialog:openLlamaExe')
  },
  pickLlamaModel: async (): Promise<string | null> => {
    return await ipcRenderer.invoke('dialog:openLlamaModel')
  },
  getDevConfig: async (): Promise<{ path: string; config: Record<string, unknown> }> => {
    return await ipcRenderer.invoke('config:getDevConfig')
  },
  setDevConfig: async (
    config: Record<string, unknown>
  ): Promise<{ path: string; config: Record<string, unknown> }> => {
    return await ipcRenderer.invoke('config:setDevConfig', config)
  },

  depsGetState: async (): Promise<any> => {
    return await ipcRenderer.invoke('deps:getState')
  },
  depsDownloadLlamaServer: async (args: any): Promise<any> => {
    return await ipcRenderer.invoke('deps:downloadLlamaServer', args)
  },
  depsDownloadGgufPreset: async (args: any): Promise<any> => {
    return await ipcRenderer.invoke('deps:downloadGgufPreset', args)
  },
  depsCancel: async (taskId: string): Promise<any> => {
    return await ipcRenderer.invoke('deps:cancel', taskId)
  },
  onDepsEvent: (callback: (payload: any) => void): (() => void) => {
    const handler = (_evt: any, payload: any) => {
      try {
        callback(payload)
      } catch {}
    }
    ipcRenderer.on('deps:event', handler)
    return () => {
      try {
        ipcRenderer.removeListener('deps:event', handler)
      } catch {}
    }
  },

  llamaGetState: async (): Promise<any> => {
    return await ipcRenderer.invoke('llama:getState')
  },
  llamaGetLogs: async (): Promise<any> => {
    return await ipcRenderer.invoke('llama:getLogs')
  },
  llamaClearLogs: async (): Promise<any> => {
    return await ipcRenderer.invoke('llama:clearLogs')
  },
  llamaStart: async (): Promise<any> => {
    return await ipcRenderer.invoke('llama:start')
  },
  llamaStop: async (): Promise<any> => {
    return await ipcRenderer.invoke('llama:stop')
  },
  llamaRestart: async (): Promise<any> => {
    return await ipcRenderer.invoke('llama:restart')
  },
  onLlamaEvent: (callback: (payload: any) => void): (() => void) => {
    const handler = (_evt: any, payload: any) => {
      try {
        callback(payload)
      } catch {}
    }
    ipcRenderer.on('llama:event', handler)
    return () => {
      try {
        ipcRenderer.removeListener('llama:event', handler)
      } catch {}
    }
  }
})

export type ElectronAPI = {
  openVideoFile: () => Promise<string | null>
  openDirectory: () => Promise<string | null>
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

  depsGetState: () => Promise<any>
  depsDownloadLlamaServer: (args: any) => Promise<any>
  depsDownloadGgufPreset: (args: any) => Promise<any>
  depsCancel: (taskId: string) => Promise<any>
  onDepsEvent: (callback: (payload: any) => void) => () => void

  llamaGetState: () => Promise<any>
  llamaGetLogs: () => Promise<any>
  llamaClearLogs: () => Promise<any>
  llamaStart: () => Promise<any>
  llamaStop: () => Promise<any>
  llamaRestart: () => Promise<any>
  onLlamaEvent: (callback: (payload: any) => void) => () => void
}
