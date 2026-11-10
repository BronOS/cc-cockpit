// The web shell's entry (design-web.md §2): the Electron shell's React tree, with `window.cockpit`
// from the socket bridge (bridge.ts) instead of the preload. Differences from ../main.tsx:
// - first the sign-in step (sign-in.ts: an access link in the URL, then "is this browser signed
//   in"), then the project picker (picker.tsx) when no `?project=` names one;
// - no window chrome: title bar, drag regions, full screen, see-through, update notice
//   (shell-kind.ts, marked below before anything renders);
// - zone sizes and collapsed zones are this browser's own (zones/view-geometry.ts);
// - nothing is drawn until main answers `ready` (the bridge rejects calls before that);
// - no chime: notifications and their sound stay on the host (design §6.1);
// - after a reconnect (a fresh `ready`, a new view), theme and prefs are read again and the shell is
//   mounted afresh, so whatever changed while away is drawn from main's current state, not patched
//   from missed events (no resume in v1, design §3);
// - while away, a "host unreachable" notice sits over the last state, which stays visible but
//   whose calls fail until the socket is back.
import { StrictMode, useEffect, useState, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import type { WebAccessMode } from '../../shared/types'
import { SESSION_PATH, WS_PATH } from '../../shared/web-protocol'
import { App } from '../App'
import { setPrefs, startPrefs } from '../prefs/prefs-store'
import { markWebShell, setOwnView } from '../shell-kind'
import { startTheme } from '../theme/apply-theme'
import { applyTheme } from '../theme/theme-store'
import { loadTerminalFont } from '../tabs/terminal-font'
import { createWebBridge, socketUrl, type BridgeStatus, type SocketLike, type WebBridge } from './bridge'
import { setPagePaths } from './page-paths'
import { WebPicker } from './picker'
import { linkTokenOf, signIn, signedOutText } from './sign-in'
import '../assets/fonts/fonts.css'
import '../styles.css'
import './web.css'

document.documentElement.dataset.platform = navigator.platform.toLowerCase().includes('mac') ? 'darwin' : 'other'
// Before anything renders: TabsPane, App and the zones read it when they mount.
markWebShell(document.documentElement)

/**
 * The project this page shows, from `?project=<id>`. Only a request: main binds the view to the
 * window that has that project open now and refuses (close 4404) when none does. None: the
 * picker (picker.tsx), whose rows link here.
 */
const project = new URLSearchParams(location.search).get('project') ?? ''

/** The browser's fetch, bound (an unbound `fetch` throws "Illegal invocation" in some browsers). */
const browserFetch = (input: string, init?: RequestInit): Promise<Response> => fetch(input, init)

/** Back to the project list: the picker, a fresh page (and a fresh sign-in check). */
function PickerLink(): React.JSX.Element {
  return (
    <a className="web-state-link" href="/">
      Open the project list
    </a>
  )
}

function SignedOut({ mode, error }: { mode: WebAccessMode; error?: string }): React.JSX.Element {
  return (
    <main className="web-state" role="alert">
      <div className="web-state-box">
        {error !== undefined && <p>The link did not work: {error}.</p>}
        <p>{signedOutText(mode)}</p>
      </div>
    </main>
  )
}

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
    // Before the shell mounts: "typed last on <device>" is hidden for this view's own typing.
    setOwnView(status.view)
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
        <div className="web-state-box">
          <p>{status.reason}</p>
          <PickerLink />
        </div>
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

function startShell(reactRoot: ReturnType<typeof createRoot>): void {
  const bridge = createWebBridge({
    url: socketUrl(location, WS_PATH),
    project,
    // The DOM WebSocket's handler types name its own event classes; the bridge reads `data`,
    // `code` and `reason` only.
    createSocket: (url) => new WebSocket(url) as unknown as SocketLike,
    // Plugin files and inline overlays: the shell maps main's cc-plugin:// URLs through these.
    onPagePaths: setPagePaths,
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
  reactRoot.render(
    <StrictMode>
      <WebRoot bridge={bridge} />
    </StrictMode>
  )
}

const root = document.getElementById('root')
if (!root) throw new Error('missing #root element in index.html')
const reactRoot = createRoot(root)
reactRoot.render(<main className="web-state">Connecting...</main>)

// An access link opened over this page (pasted into the address bar of the signed-out page) only
// changes the fragment: the browser does not load the page again, so the sign-in above would never
// see it. Load it again; the fresh page reads the token (and clears it) like any first visit.
window.addEventListener('hashchange', () => {
  if (linkTokenOf(location.hash) !== undefined) location.reload()
})

void signIn({
  location,
  replaceUrl: (url) => history.replaceState(null, '', url),
  fetch: browserFetch,
  userAgent: navigator.userAgent
}).then((state) => {
  if (state.state === 'unreachable') {
    reactRoot.render(
      <main className="web-state" role="alert">
        <div className="web-state-box">
          <p>Host unreachable: {state.error}.</p>
          <button type="button" onClick={() => location.reload()}>
            Retry
          </button>
        </div>
      </main>
    )
  } else if (state.state === 'signed-out') {
    reactRoot.render(<SignedOut mode={state.mode} {...(state.error !== undefined ? { error: state.error } : {})} />)
  } else if (project === '') {
    // The device went away while the picker was up: a fresh page asks again and says why.
    reactRoot.render(<WebPicker fetch={browserFetch} onSignedOut={() => location.reload()} />)
  } else {
    startShell(reactRoot)
  }
})
