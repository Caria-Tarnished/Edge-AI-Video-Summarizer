import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'

const isDev = !!process.env.VITE_DEV_SERVER_URL

let mainWindow: BrowserWindow | null = null

function getDevConfigPath(): string {
  const repoRoot = String(process.env.EDGE_VIDEO_AGENT_REPO_ROOT || '').trim()
  if (repoRoot) {
    return join(repoRoot, 'artifacts', 'dev_config.json')
  }
  return join(app.getPath('userData'), 'dev_config.json')
}

function readDevConfig(): Record<string, unknown> {
  const p = getDevConfigPath()
  if (!existsSync(p)) {
    return {}
  }
  try {
    const raw = readFileSync(p, { encoding: 'utf-8' })
    const obj = JSON.parse(raw || '{}')
    return obj && typeof obj === 'object' ? (obj as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function writeDevConfig(config: Record<string, unknown>): { path: string; config: Record<string, unknown> } {
  const p = getDevConfigPath()
  try {
    mkdirSync(dirname(p), { recursive: true })
  } catch {
  }
  try {
    writeFileSync(p, JSON.stringify(config || {}, null, 2), { encoding: 'utf-8' })
  } catch {
  }
  return { path: p, config: readDevConfig() }
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 820,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js')
    }
  })

  if (isDev && process.env.VITE_DEV_SERVER_URL) {
    await mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    await mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

ipcMain.handle('dialog:openVideo', async () => {
  const res = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [
      {
        name: 'Video',
        extensions: ['mp4', 'mkv', 'mov', 'avi', 'webm']
      }
    ]
  })
  if (res.canceled || res.filePaths.length === 0) {
    return null
  }
  return res.filePaths[0]
})

ipcMain.handle('dialog:openLlamaExe', async () => {
  const res = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [
      {
        name: 'Executable',
        extensions: ['exe']
      }
    ]
  })
  if (res.canceled || res.filePaths.length === 0) {
    return null
  }
  return res.filePaths[0]
})

ipcMain.handle('dialog:openLlamaModel', async () => {
  const res = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [
      {
        name: 'GGUF',
        extensions: ['gguf']
      }
    ]
  })
  if (res.canceled || res.filePaths.length === 0) {
    return null
  }
  return res.filePaths[0]
})

ipcMain.handle('config:getDevConfig', async () => {
  const p = getDevConfigPath()
  const cfg = readDevConfig()
  return { path: p, config: cfg }
})

ipcMain.handle('config:setDevConfig', async (_evt, config: any) => {
  const payload = config && typeof config === 'object' ? (config as Record<string, unknown>) : {}
  return writeDevConfig(payload)
})

app.whenReady().then(async () => {
  await createWindow()

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
