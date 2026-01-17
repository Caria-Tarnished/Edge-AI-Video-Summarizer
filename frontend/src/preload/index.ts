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
  }
})

export type ElectronAPI = {
  openVideoFile: () => Promise<string | null>
  getAppVersion: () => Promise<{ version: string; is_packaged: boolean } | null>
  checkUpdates: () => Promise<any>
  openExternal: (url: string) => Promise<any>
  exportDataZip: () => Promise<any>
  restoreDataZip: () => Promise<any>
  pickLlamaServerExe: () => Promise<string | null>
  pickLlamaModel: () => Promise<string | null>
  getDevConfig: () => Promise<{ path: string; config: Record<string, unknown> }>
  setDevConfig: (config: Record<string, unknown>) => Promise<{ path: string; config: Record<string, unknown> }>
}
