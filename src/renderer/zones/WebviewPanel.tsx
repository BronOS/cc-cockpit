import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import type { PanelInfo } from '../../shared/ipc'
import { PlacementReporter } from './placement-reporter'
import { layersUp, onLayersChange } from './shell-layers'
import { isServerView, isWebShell } from '../shell-kind'
import { WebviewCanvasPanel } from '../web/webview-canvas'
import { useWebviewPage, WebviewLoadError, WebviewToolbar } from './webview-toolbar'

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
  // A server's browser view draws the page main renders off-screen and streams to it
  // (design-web-browser.md §3, web/webview-canvas.tsx). Main decides from its own flag; this is the
  // `ready` hint, and a wrong one only gets refused calls.
  if (isServerView()) return <WebviewCanvasPanel info={props.info} />
  // On the desktop the page is a native view on the host's window: a browser view of it has nothing
  // to show it with (design-web.md §6.1), and must not report a placement for it either.
  if (isWebShell()) {
    return (
      <div className="panel-body webview-panel" data-panel-body={props.info.panelKey}>
        <p className="desktop-only-note" role="status">
          {props.info.title}: available on the desktop.
        </p>
      </div>
    )
  }
  return <NativeWebviewPanel info={props.info} />
}

function NativeWebviewPanel(props: { info: PanelInfo }): React.JSX.Element {
  const { panelKey, title, error } = props.info
  const page = useWebviewPage(panelKey)
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

  const hasPage = page.url !== ''
  return (
    <div className="panel-body webview-panel" data-panel-body={panelKey}>
      {error && (
        <p className="plugin-panel-error" role="status" title={error}>
          ⚠ {error}
        </p>
      )}
      <WebviewToolbar panelKey={panelKey} title={title} page={page} />
      {/* Above the placeholder, so the view is laid out below it. */}
      <WebviewLoadError page={page} />
      <div ref={el} className="webview-placeholder" data-webview={panelKey}>
        {!hasPage && <p className="panel-placeholder">{title} shows nothing yet</p>}
      </div>
    </div>
  )
}
