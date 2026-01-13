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
        <h2>库</h2>
        <div className="muted">下一步将实现视频库与视频详情页。</div>
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
            设置
          </button>
          <button
            className={route === 'library' ? 'tab active' : 'tab'}
            onClick={() => setRoute('library')}
          >
            库
          </button>
        </div>
      </div>
      <div className="content">{content}</div>
    </div>
  )
}
