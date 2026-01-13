import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('electronAPI', {
  openVideoFile: async (): Promise<string | null> => {
    return await ipcRenderer.invoke('dialog:openVideo')
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
  pickLlamaServerExe: () => Promise<string | null>
  pickLlamaModel: () => Promise<string | null>
  getDevConfig: () => Promise<{ path: string; config: Record<string, unknown> }>
  setDevConfig: (config: Record<string, unknown>) => Promise<{ path: string; config: Record<string, unknown> }>
}
