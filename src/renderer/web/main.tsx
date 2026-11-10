// The web shell's entry (design-web.md §2): the Electron shell's React tree, with `window.cockpit`
// from the socket bridge (bridge.ts) instead of the preload. Differences from ../main.tsx:
// - nothing is drawn until main answers `ready` (the bridge rejects calls before that);
// - no chime: notifications and their sound stay on the host (design §6.1);
// - after a reconnect (a fresh `ready`, a new view), theme and prefs are read again and the shell is
//   mounted afresh, so whatever changed while away is drawn from main's current state, not patched
//   from missed events (no resume in v1, design §3);
// - while away, a "host unreachable" notice sits over the last state, which stays visible but
//   whose calls fail until the socket is back.
import { StrictMode, useEffect, useState, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { SESSION_PATH, WS_PATH } from '../../shared/web-protocol'
import { App } from '../App'
import { setPrefs, startPrefs } from '../prefs/prefs-store'
import { startTheme } from '../theme/apply-theme'
import { applyTheme } from '../theme/theme-store'
import { loadTerminalFont } from '../tabs/terminal-font'
import { createWebBridge, socketUrl, type BridgeStatus, type SocketLike, type WebBridge } from './bridge'
import '../assets/fonts/fonts.css'
import '../styles.css'
import './web.css'

document.documentElement.dataset.platform = navigator.platform.toLowerCase().includes('mac') ? 'darwin' : 'other'

/**
 * The project this page shows, from `?project=<id>`. Only a request: main binds the view to the
 * window that has that project open now and refuses (close 4404) when none does. The project
 * picker that links here comes with the sign-in page (plan Task 8).
 */
const project = new URLSearchParams(location.search).get('project') ?? ''

/** Re-read what the page applies itself; its listeners survive the reconnect, its missed pushes do not. */
async function resync(): Promise<void> {
  await Promise.all([
    window.cockpit.invoke('theme.get').then((theme) => applyTheme(theme, document.documentElement)),
    window.cockpit.invoke('prefs.get').then(async (prefs) => {
      await loadTerminalFont(prefs.terminalFont)
      setPrefs(prefs)
    })
  ])
}

function Unreachable({ status, bridge }: { status: BridgeStatus & { state: 'away' }; bridge: WebBridge }): React.JSX.Element {
  // Ticks once a second so the countdown moves; the bridge itself owns the retry timer.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  const secs = Math.max(0, Math.ceil((status.retryAt - now) / 1000))
  return (
    <div className="web-unreachable" role="alert">
      <span>Host unreachable. {secs > 0 ? `Retrying in ${secs}s.` : 'Retrying...'}</span>
      <button type="button" onClick={() => bridge.retryNow()}>
        Retry now
      </button>
    </div>
  )
}

function WebRoot({ bridge }: { bridge: WebBridge }): React.JSX.Element {
  const status = useSyncExternalStore(bridge.onStatus, bridge.status)
  // The `ready` generation whose state the shell was mounted with (0: not yet).
  const [shown, setShown] = useState(0)

  useEffect(() => {
    if (status.state !== 'ready') return
    const generation = status.generation
    let live = true
    // The first ready subscribes and reads (startTheme/startPrefs); a later one only reads again.
    const load = generation === 1 ? Promise.all([startTheme(), startPrefs()]) : resync()
    // A failure (main refused) must not leave a blank page: render anyway, as ../main.tsx does.
    load
      .catch((err: unknown) => console.warn('web shell: start-up read failed', err))
      .finally(() => {
        if (live) setShown(generation)
      })
    return () => {
      live = false
    }
  }, [status])

  if (status.state === 'gone') {
    return (
      <main className="web-state" role="alert">
        {status.reason}
      </main>
    )
  }
  return (
    <>
      {shown > 0 && <App key={shown} />}
      {shown === 0 && status.state !== 'away' && <main className="web-state">Connecting...</main>}
      {status.state === 'away' && <Unreachable status={status} bridge={bridge} />}
    </>
  )
}

const root = document.getElementById('root')
if (!root) throw new Error('missing #root element in index.html')

if (project === '') {
  createRoot(root).render(<main className="web-state">No project chosen.</main>)
} else {
  const bridge = createWebBridge({
    url: socketUrl(location, WS_PATH),
    project,
    // The DOM WebSocket's handler types name its own event classes; the bridge reads `data`,
    // `code` and `reason` only.
    createSocket: (url) => new WebSocket(url) as unknown as SocketLike,
    // Only a definite "device: null" counts as signed out; a failed request means the host is away.
    checkSession: async () => {
      const res = await fetch(SESSION_PATH, { credentials: 'same-origin', cache: 'no-store' })
      if (!res.ok) return true
      const body = (await res.json()) as { device?: unknown }
      return body.device !== null
    }
  })
  window.cockpit = bridge.api
  window.addEventListener('pagehide', () => bridge.close())
  // Closing the socket on pagehide makes the page eligible for the back/forward cache; a page
  // restored from it has a closed bridge that still says `ready`. Start over from a fresh load.
  window.addEventListener('pageshow', (ev) => {
    if (ev.persisted) location.reload()
  })
  createRoot(root).render(
    <StrictMode>
      <WebRoot bridge={bridge} />
    </StrictMode>
  )
}
