import { useMemo, useState } from 'react'
import LibraryPage from './pages/LibraryPage'
import SettingsPage from './pages/SettingsPage'
import VideoDetailPage from './pages/VideoDetailPage'

type Route = 'settings' | 'library'

export default function App() {
  const [route, setRoute] = useState<Route>('settings')
  const [selectedVideoId, setSelectedVideoId] = useState<string | null>(null)

  const content = useMemo(() => {
    if (route === 'settings') {
      return <SettingsPage />
    }
    if (selectedVideoId) {
      return <VideoDetailPage videoId={selectedVideoId} onBack={() => setSelectedVideoId(null)} />
    }
    return <LibraryPage onOpenVideo={(id) => setSelectedVideoId(id)} />
  }, [route, selectedVideoId])

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
            onClick={() => {
              setRoute('library')
              setSelectedVideoId(null)
            }}
          >
            {'\u5e93'}
          </button>
        </div>
      </div>
      <div className="content">{content}</div>
    </div>
  )
}
