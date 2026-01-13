import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import * as http from 'node:http'
import * as https from 'node:https'
import { dirname, join } from 'path'

const rawDevServerUrl = String(process.env.VITE_DEV_SERVER_URL || process.env.ELECTRON_RENDERER_URL || '').trim()

let mainWindow: BrowserWindow | null = null

function resolvePreloadPath(): string | null {
  const candidates: string[] = []

  candidates.push(join(__dirname, '../preload/index.js'))

  const appPath = String(app.getAppPath() || '').trim()
  if (appPath) {
    candidates.push(join(appPath, 'out/preload/index.js'))
    candidates.push(join(appPath, 'dist/preload/index.js'))
  }

  const cwd = String(process.cwd() || '').trim()
  if (cwd) {
    candidates.push(join(cwd, 'out/preload/index.js'))
    candidates.push(join(cwd, 'dist/preload/index.js'))
  }

  for (const p of candidates) {
    try {
      if (p && existsSync(p)) return p
    } catch {
    }
  }
  return null
}

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

function normalizeDevUrl(u: string): string {
  const s = String(u || '').trim()
  if (!s) return s
  return s.replace('http://localhost:', 'http://127.0.0.1:').replace('https://localhost:', 'https://127.0.0.1:')
}

function escapeHtml(s: string): string {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function probeUrl(u: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      const url = new URL(u)
      const mod = url.protocol === 'https:' ? https : http
      const port = url.port ? parseInt(url.port, 10) : url.protocol === 'https:' ? 443 : 80
      const req = mod.request(
        {
          method: 'GET',
          host: url.hostname,
          port,
          path: url.pathname || '/',
          timeout: timeoutMs
        },
        (res) => {
          res.resume()
          resolve()
        }
      )
      req.on('error', reject)
      req.on('timeout', () => req.destroy(new Error('timeout')))
      req.end()
    } catch (e) {
      reject(e)
    }
  })
}

async function waitForUrl(u: string, timeoutMs: number): Promise<void> {
  const start = Date.now()
  while (true) {
    try {
      await probeUrl(u, 1200)
      return
    } catch {
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Dev server not reachable: ${u}`)
    }
    await new Promise((r) => setTimeout(r, 200))
  }
}

async function createWindow(): Promise<void> {
  const preloadPath = resolvePreloadPath()
  console.log('[main] preload:', preloadPath || '(not found)')

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 820,
    webPreferences: {
      preload: preloadPath || join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      webSecurity: app.isPackaged
    }
  })

  mainWindow.webContents.on('preload-error', (_event, path, error) => {
    console.error('[main] preload-error:', path, error)
  })

  mainWindow.webContents.on('did-finish-load', () => {
    void mainWindow?.webContents
      .executeJavaScript('typeof window.electronAPI')
      .then((v) => console.log('[main] window.electronAPI:', v))
      .catch((e) => console.error('[main] window.electronAPI probe failed:', e))
  })

  if (!preloadPath) {
    try {
      await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        message: 'Preload script not found',
        detail:
          'The Electron preload script could not be located. This will disable file dialogs (window.electronAPI is missing).\n\nTry restarting the dev server or re-running the frontend build/dev command.'
      })
    } catch {
    }
  }

  if (!app.isPackaged) {
    const u = normalizeDevUrl(rawDevServerUrl) || 'http://127.0.0.1:5173/'
    try {
      await waitForUrl(u, 15000)
      await mainWindow.loadURL(u)
      mainWindow.webContents.openDevTools({ mode: 'detach' })
      return
    } catch (e: any) {
      const msg = e && e.message ? String(e.message) : String(e)
      await mainWindow.loadURL(
        'data:text/html;charset=utf-8,' +
          encodeURIComponent(
            `<html><body style="font-family: ui-sans-serif, system-ui; padding: 24px;">
              <h2>Dev server not reachable</h2>
              <div><b>URL:</b> ${escapeHtml(u)}</div>
              <pre style="white-space: pre-wrap;">${escapeHtml(msg)}</pre>
              <div>Make sure the renderer dev server is running.</div>
            </body></html>`
          )
      )
      return
    }
  } else {
    const rendererHtml = join(__dirname, '../renderer/index.html')
    if (!existsSync(rendererHtml)) {
      await mainWindow.loadURL('http://127.0.0.1:5173/')
    } else {
      await mainWindow.loadFile(rendererHtml)
    }
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
