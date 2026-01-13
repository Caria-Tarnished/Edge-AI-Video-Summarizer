import { useMemo, useState } from 'react'
import SettingsPage from './pages/SettingsPage'

type Route = 'settings' | 'library'

export default function App() {
  const [route, setRoute] = useState<Route>('settings')

  const content = useMemo(() => {
    if (route === 'settings') {
      return <SettingsPage />
    }
    return (
      <div className="card">
        <h2>{'\u5e93'}</h2>
        <div className="muted">{'\u4e0b\u4e00\u6b65\u5c06\u5b9e\u73b0\u89c6\u9891\u5e93\u4e0e\u89c6\u9891\u8be6\u60c5\u9875\u3002'}</div>
      </div>
    )
  }, [route])

  return (
    <div className="app">
      <div className="topbar">
        <div className="brand">Edge Video Agent</div>
        <div className="tabs">
          <button
            className={route === 'settings' ? 'tab active' : 'tab'}
            onClick={() => setRoute('settings')}
          >
            {'\u8bbe\u7f6e'}
          </button>
          <button
            className={route === 'library' ? 'tab active' : 'tab'}
            onClick={() => setRoute('library')}
          >
            {'\u5e93'}
          </button>
        </div>
      </div>
      <div className="content">{content}</div>
    </div>
  )
}
