// A webview panel's toolbar and the page it shows, shared by the desktop panel (a native view laid
// over a placeholder, WebviewPanel.tsx) and a server's browser view (the streamed canvas,
// web/webview-canvas.tsx; design-web-browser.md §3.5): back, forward, reload, the URL and title,
// the system-browser button and the load-error line. The channels are the same in both; main
// decides who may use them (`adapted`: a remote view only in server mode).

import { useEffect, useState } from 'react'
import type { WebviewPageInfo } from '../../shared/ipc'
import { BackGlyph, ExternalGlyph, ForwardGlyph, ReloadGlyph } from '../window-icons'

export const NO_PAGE: WebviewPageInfo = { url: '', title: '' }

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
 * What the panel's view shows, from `webviews.current` and then `webviews.navigated`. Subscribed
 * before asking, so a page committed between the two is not lost; the event is newer than the
 * answer, so the answer is dropped once one arrived.
 */
export function useWebviewPage(panelKey: string): WebviewPageInfo {
  const [page, setPage] = useState<WebviewPageInfo>(NO_PAGE)
  useEffect(() => {
    let live = true
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
  return page
}

/** The toolbar row; `extra` goes after the system-browser button (the canvas's "Fit to this screen"). */
export function WebviewToolbar(props: { panelKey: string; title: string; page: WebviewPageInfo; extra?: React.ReactNode }): React.JSX.Element {
  const { panelKey, title, page } = props
  const hasPage = page.url !== ''
  return (
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
      {props.extra}
    </div>
  )
}

/**
 * A failed load leaves an empty page at its URL (Electron has no error page): say why. Reload
 * (enabled: the URL is the page's) tries again.
 */
export function WebviewLoadError(props: { page: WebviewPageInfo }): React.JSX.Element | null {
  if (props.page.error === undefined) return null
  return (
    <p className="plugin-panel-error webview-load-error" role="status" title={props.page.error}>
      Could not load the page: {props.page.error}
    </p>
  )
}
