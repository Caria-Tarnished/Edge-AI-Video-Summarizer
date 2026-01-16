import { useCallback, useEffect, useMemo, useState } from 'react'
import LibraryPage from './pages/LibraryPage'
import FirstRunWizardPage from './pages/FirstRunWizardPage'
import SettingsPage from './pages/SettingsPage'
import TaskCenterPage from './pages/TaskCenterPage'
import VideoDetailPage from './pages/VideoDetailPage'

type Route = 'wizard' | 'settings' | 'library' | 'tasks'

type UiLang = 'zh' | 'en'

type UiTheme = 'dark' | 'light'

function loadUiLang(): UiLang {
  try {
    const v = String(localStorage.getItem('ui_lang') || '').trim().toLowerCase()
    if (v === 'en') return 'en'
  } catch {
    // ignore
  }
  return 'zh'
}

function loadUiTheme(): UiTheme {
  try {
    const v = String(localStorage.getItem('ui_theme') || '').trim().toLowerCase()
    if (v === 'light') return 'light'
    if (v === 'dark') return 'dark'
  } catch {
    // ignore
  }
  return 'dark'
}

export default function App() {
  const [route, setRoute] = useState<Route>('library')
  const [selectedVideoId, setSelectedVideoId] = useState<string | null>(null)
  const [uiLang, setUiLang] = useState<UiLang>(() => loadUiLang())
  const [uiTheme, setUiTheme] = useState<UiTheme>(() => loadUiTheme())

  useEffect(() => {
    try {
      document.documentElement.dataset.theme = uiTheme
    } catch {
      // ignore
    }
    try {
      localStorage.setItem('ui_theme', uiTheme)
    } catch {
      // ignore
    }
  }, [uiTheme])

  useEffect(() => {
    try {
      const override = String(localStorage.getItem('route_override') || '')
        .trim()
        .toLowerCase()
      if (override === 'wizard') {
        try {
          localStorage.removeItem('route_override')
        } catch {
        }
        setRoute('wizard')
        return
      }

      const done = String(
        localStorage.getItem('first_run_wizard_completed') || ''
      )
        .trim()
        .toLowerCase()
      if (!done || done === '0' || done === 'false' || done === 'no') {
        setRoute('wizard')
      }
    } catch {
      setRoute('wizard')
    }
  }, [])

  const setUiLangAndPersist = useCallback((next: UiLang) => {
    setUiLang(next)
    try {
      localStorage.setItem('ui_lang', next)
    } catch {
      // ignore
    }
  }, [])

  const toggleUiTheme = useCallback(() => {
    setUiTheme((cur) => (cur === 'dark' ? 'light' : 'dark'))
  }, [])

  const t = useCallback(
    (key: 'settings' | 'workspace' | 'tasks') => {
      if (uiLang === 'en') {
        if (key === 'settings') return 'Settings'
        if (key === 'workspace') return 'Workspace'
        if (key === 'tasks') return 'Tasks'
      }
      if (key === 'settings') return '\u8bbe\u7f6e'
      if (key === 'tasks') return '\u4efb\u52a1'
      return '\u5de5\u4f5c\u533a'
    },
    [uiLang]
  )

  const content = useMemo(() => {
    if (route === 'wizard') {
      return (
        <FirstRunWizardPage
          uiLang={uiLang}
          onDone={() => {
            try {
              localStorage.setItem('first_run_wizard_completed', '1')
            } catch {
              // ignore
            }
            setRoute('library')
            setSelectedVideoId(null)
          }}
        />
      )
    }
    if (route === 'settings') {
      return <SettingsPage uiLang={uiLang} />
    }
    if (route === 'tasks') {
      return (
        <TaskCenterPage
          uiLang={uiLang}
          onOpenVideo={(id) => {
            setRoute('library')
            setSelectedVideoId(id)
          }}
        />
      )
    }
    if (selectedVideoId) {
      return <VideoDetailPage videoId={selectedVideoId} onBack={() => setSelectedVideoId(null)} />
    }
    return <LibraryPage uiLang={uiLang} onOpenVideo={(id) => setSelectedVideoId(id)} />
  }, [route, selectedVideoId, uiLang])

  return (
    <div className="app">
      <div className="topbar">
        <div className="brand">Edge Video Agent</div>
        <div className="tabs">
          <button
            className={route === 'library' ? 'tab active' : 'tab'}
            onClick={() => {
              setRoute('library')
              setSelectedVideoId(null)
            }}
          >
            {t('workspace')}
          </button>

          <button
            className={route === 'tasks' ? 'tab active' : 'tab'}
            onClick={() => {
              setRoute('tasks')
              setSelectedVideoId(null)
            }}
            title={t('tasks')}
            aria-label={t('tasks')}
          >
            {t('tasks')}
          </button>

          <button
            className={uiLang === 'zh' ? 'tab active' : 'tab'}
            onClick={() => setUiLangAndPersist(uiLang === 'zh' ? 'en' : 'zh')}
            title={uiLang === 'zh' ? '\u5207\u6362\u8bed\u8a00' : 'Switch language'}
          >
            {uiLang === 'zh' ? 'ZH' : 'EN'}
          </button>

          <button
            className="tab"
            onClick={toggleUiTheme}
            title={
              uiLang === 'en'
                ? uiTheme === 'dark'
                  ? 'Switch to light theme'
                  : 'Switch to dark theme'
                : uiTheme === 'dark'
                  ? '\u5207\u6362\u5230\u4eae\u8272\u4e3b\u9898'
                  : '\u5207\u6362\u5230\u6697\u8272\u4e3b\u9898'
            }
            aria-label={
              uiLang === 'en'
                ? uiTheme === 'dark'
                  ? 'Switch to light theme'
                  : 'Switch to dark theme'
                : uiTheme === 'dark'
                  ? '\u5207\u6362\u5230\u4eae\u8272\u4e3b\u9898'
                  : '\u5207\u6362\u5230\u6697\u8272\u4e3b\u9898'
            }
          >
            {uiTheme === 'dark' ? '\u2600' : '\u263e'}
          </button>

          <button
            className={route === 'settings' ? 'tab active' : 'tab'}
            onClick={() => setRoute('settings')}
            title={t('settings')}
            aria-label={t('settings')}
          >
            {'\u2699'}
          </button>
        </div>
      </div>
      <div className="content">{content}</div>
    </div>
  )
}
