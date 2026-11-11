import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { PanelInfo, WebviewPageInfo } from '../../shared/ipc'
import { PlacementReporter } from './placement-reporter'
import { layersUp, onLayersChange } from './shell-layers'
import { isServerView, isWebShell } from '../shell-kind'
import { BackGlyph, ExternalGlyph, ForwardGlyph, ReloadGlyph } from '../window-icons'

const NO_PAGE: WebviewPageInfo = { url: '', title: '' }

/** Only an http(s) page goes to the system browser (main checks again: `app.openExternal`). */
function isWebUrl(url: string): boolean {
  return /^https?:\/\//i.test(url)
}

/**
 * The URL with its scheme and its path dimmed, so the host (the part that says where the page is)
 * reads first. Text only, and its text content is the URL unchanged (the toolbar's specs read it).
 * Anything that is not `scheme://host…` is shown as it is.
 */
function UrlParts(props: { url: string }): React.JSX.Element {
  const m = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*)(.*)$/is.exec(props.url)
  if (!m) return <>{props.url}</>
  return (
    <>
      <span className="webview-url-dim">{m[1]}</span>
      {m[2]}
      <span className="webview-url-dim">{m[3]}</span>
    </>
  )
}

function step(panelKey: string, which: 'back' | 'forward' | 'reload'): void {
  window.cockpit.invoke('webviews.step', { panelKey, step: which }).catch(() => {})
}

/**
 * A `"kind": "webview"` panel (plan B Task 8): a toolbar and a placeholder. The page itself is a
 * native view main owns and lays over the placeholder (webview-manager.ts); this only reports
 * where the placeholder is and whether the view may show, and draws the toolbar from what main
 * says the view shows.
 *
 * The view may show only while the placeholder is mounted with an area, nothing in the shell
 * covers it (a shell layer is up: shell-layers.ts), and it is not under an inert subtree (the
 * zones go inert under settings, an overlay or the close dialog). Unmounting (the panel closed or
 * hidden, its zone collapsed, the plugin stopped) hides it at once.
 *
 * When it is measured: on every render (a layout change re-renders the zones, and a panel above
 * this one resizing moves it without resizing it, which a ResizeObserver on the placeholder alone
 * would miss), on a resize of the placeholder or of the page, and when a shell layer comes or goes
 * (a splitter drag ending is such a layer going, so the view comes back where the drag left it).
 */
export function WebviewPanel(props: { info: PanelInfo }): React.JSX.Element {
  // The page is a native view on the host's window: a browser view has nothing to show it with
  // (design-web.md §6.1), and must not report a placement for it either. A server has no desktop to
  // send the person to, and main makes no view there at all (§9.9): the text says so (a UI hint).
  if (isWebShell()) {
    return (
      <div className="panel-body webview-panel" data-panel-body={props.info.panelKey}>
        <p className="desktop-only-note" role="status">
          {props.info.title}: {isServerView() ? 'not available in server mode.' : 'available on the desktop.'}
        </p>
      </div>
    )
  }
  return <NativeWebviewPanel info={props.info} />
}

function NativeWebviewPanel(props: { info: PanelInfo }): React.JSX.Element {
  const { panelKey, title, error } = props.info
  const [page, setPage] = useState<WebviewPageInfo>(NO_PAGE)
  const el = useRef<HTMLDivElement>(null)
  // Made by the mount effect, not in state: StrictMode's mount / unmount / mount would otherwise
  // leave a reporter its first cleanup disposed.
  const reporter = useRef<PlacementReporter | undefined>(undefined)
  // Reads refs only, so one function serves every render and listener.
  const measure = useCallback((): void => {
    const node = el.current
    if (!node || !reporter.current) return
    const r = node.getBoundingClientRect()
    const visible = !layersUp() && node.closest('[inert]') === null && r.width > 0 && r.height > 0
    reporter.current.update({ x: r.left, y: r.top, width: r.width, height: r.height, visible })
  }, [])

  // Every render: see above. A layout effect, so the report leaves before the browser paints.
  useLayoutEffect(() => {
    measure()
  })

  useEffect(() => {
    const own = new PlacementReporter(
      (p) => {
        window.cockpit.invoke('webviews.placement', { panelKey, ...p }).catch(() => {})
      },
      (fn) => {
        const id = requestAnimationFrame(fn)
        return () => cancelAnimationFrame(id)
      }
    )
    reporter.current = own
    const node = el.current
    const remeasure = measure
    remeasure()
    const observer = new ResizeObserver(remeasure)
    if (node) observer.observe(node)
    // The page resizing (the window) can move the placeholder without resizing it.
    observer.observe(document.documentElement)
    window.addEventListener('resize', remeasure)
    const offLayers = onLayersChange(remeasure)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', remeasure)
      offLayers()
      own.dispose()
      if (reporter.current === own) reporter.current = undefined
    }
  }, [panelKey, measure])

  useEffect(() => {
    let live = true
    // Subscribe before asking, so a page committed between the two is not lost; the event is
    // newer than the answer, so the answer is dropped once one arrived.
    let sawEvent = false
    const off = window.cockpit.on('webviews.navigated', (p) => {
      if (p.panelKey !== panelKey) return
      sawEvent = true
      setPage({ url: p.url, title: p.title, ...(typeof p.error === 'string' && p.error !== '' ? { error: p.error } : {}) })
    })
    window.cockpit
      .invoke('webviews.current', { panelKey })
      .then((p) => {
        if (live && !sawEvent) setPage(p)
      })
      .catch(() => {})
    return () => {
      live = false
      off()
    }
  }, [panelKey])

  const hasPage = page.url !== ''
  return (
    <div className="panel-body webview-panel" data-panel-body={panelKey}>
      {error && (
        <p className="plugin-panel-error" role="status" title={error}>
          ⚠ {error}
        </p>
      )}
      <div className="webview-toolbar" role="toolbar" aria-label={`${title} navigation`}>
        <button type="button" className="icon-button sm" aria-label="Back" title="Back" disabled={!hasPage} onClick={() => step(panelKey, 'back')}>
          <BackGlyph size={15} />
        </button>
        <button type="button" className="icon-button sm" aria-label="Forward" title="Forward" disabled={!hasPage} onClick={() => step(panelKey, 'forward')}>
          <ForwardGlyph size={15} />
        </button>
        <button type="button" className="icon-button sm" aria-label="Reload" title="Reload" disabled={!hasPage} onClick={() => step(panelKey, 'reload')}>
          <ReloadGlyph size={15} />
        </button>
        <span className="webview-url" title={page.title ? `${page.title}\n${page.url}` : page.url} data-url={page.url}>
          {hasPage ? <UrlParts url={page.url} /> : 'No page'}
        </span>
        <button
          type="button"
          aria-label="Open in system browser"
          title="Open in system browser"
          disabled={!isWebUrl(page.url)}
          className="icon-button sm"
          onClick={() => {
            window.cockpit.invoke('app.openExternal', { url: page.url }).catch(() => {})
          }}
        >
          <ExternalGlyph size={15} />
        </button>
      </div>
      {/* A failed load leaves an empty page at its URL (Electron has no error page): say why here.
          Reload (enabled: the URL is the page's) tries again. Above the placeholder, so the view
          is laid out below it. */}
      {page.error !== undefined && (
        <p className="plugin-panel-error webview-load-error" role="status" title={page.error}>
          Could not load the page: {page.error}
        </p>
      )}
      <div ref={el} className="webview-placeholder" data-webview={panelKey}>
        {!hasPage && <p className="panel-placeholder">{title} shows nothing yet</p>}
      </div>
    </div>
  )
}
