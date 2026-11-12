// A webview panel in a server's browser view (design-web-browser.md §3, plan
// 20261111-streamed-webviews.md Task 6): main renders the page off-screen and streams JPEG frames
// over this view's socket (the bridge's `onWebviewFrame`); this draws the newest one on a canvas,
// letterboxed when another view owns the page's size, reports the panel's area and visibility
// (`webviews.place`, which makes this view a viewer: no report, no frames), offers "Fit to this
// screen" (`webviews.fit`), and shows the desktop's toolbar (webview-toolbar.tsx).
//
// The math and the report throttle are DOM-free in webview-stream.ts (unit tested).

import { useEffect, useRef, useState } from 'react'
import type { PanelInfo } from '../../shared/ipc'
import { useWebviewPage, WebviewLoadError, WebviewToolbar } from '../zones/webview-toolbar'
import { FrameDecoder, letterbox, PlaceReporter, sizeDiffers, webviewFrameSource, type DecodedFrame } from './webview-stream'

export function WebviewCanvasPanel(props: { info: PanelInfo }): React.JSX.Element {
  const { panelKey, title, error } = props.info
  const page = useWebviewPage(panelKey)
  const hasPage = page.url !== ''
  // A page shown before and none now: its view went (a crash, the plugin stopped). Not on mount.
  const [hadPage, setHadPage] = useState(false)
  const [fit, setFit] = useState(false)
  const [drawn, setDrawn] = useState(false)
  const area = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)

  // Derived during render (React's pattern for state that follows a prop), not in an effect.
  if (hasPage && !hadPage) setHadPage(true)

  // Placement reports: on mount, every resize of the area, and the page's visibility; visible:
  // false on unmount (main stops this view's frames).
  useEffect(() => {
    const node = area.current
    if (!node) return
    const reporter = new PlaceReporter(
      (r) => {
        window.cockpit.invoke('webviews.place', { panelKey, ...r }).catch(() => {})
      },
      { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) }
    )
    const measure = (): void => {
      const r = node.getBoundingClientRect()
      reporter.update(r.width, r.height, document.hidden)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    document.addEventListener('visibilitychange', measure)
    return () => {
      observer.disconnect()
      document.removeEventListener('visibilitychange', measure)
      reporter.dispose()
    }
  }, [panelKey])

  // Frames: decoded latest-only, drawn on the next animation frame (several decoded within one
  // frame draw once), and again when the area resizes (the letterbox moves).
  useEffect(() => {
    const node = canvas.current
    const box = area.current
    const source = webviewFrameSource()
    if (!node || !box || !source) return
    let current: DecodedFrame<ImageBitmap> | undefined
    let raf: number | undefined
    let fitShown = false
    const draw = (): void => {
      raf = undefined
      const ctx = node.getContext('2d')
      if (!ctx) return
      const rect = box.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      const w = Math.max(1, Math.round(rect.width * dpr))
      const h = Math.max(1, Math.round(rect.height * dpr))
      if (node.width !== w) node.width = w
      if (node.height !== h) node.height = h
      ctx.clearRect(0, 0, w, h)
      if (!current) return
      const lb = letterbox(rect.width, rect.height, current.frame)
      if (lb.width <= 0) return
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(current.bitmap, lb.x * dpr, lb.y * dpr, lb.width * dpr, lb.height * dpr)
      const differs = sizeDiffers(rect.width, rect.height, current.frame)
      if (differs !== fitShown) {
        fitShown = differs
        setFit(differs)
      }
    }
    const schedule = (): void => {
      if (raf === undefined) raf = requestAnimationFrame(draw)
    }
    const decoder = new FrameDecoder<ImageBitmap>(
      (jpeg) => createImageBitmap(new Blob([jpeg as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' })),
      (bitmap) => bitmap.close(),
      (decoded) => {
        current?.bitmap.close()
        current = decoded
        schedule()
        setDrawn(true)
      }
    )
    const off = source(panelKey, (frame) => decoder.push(frame))
    const observer = new ResizeObserver(schedule)
    observer.observe(box)
    return () => {
      off()
      observer.disconnect()
      decoder.dispose()
      if (raf !== undefined) cancelAnimationFrame(raf)
      current?.bitmap.close()
      current = undefined
    }
  }, [panelKey])

  const fitButton = fit && hasPage && (
    <button
      type="button"
      className="webview-fit"
      title="Give the page this screen's size"
      onClick={() => {
        window.cockpit.invoke('webviews.fit', { panelKey }).catch(() => {})
      }}
    >
      Fit to this screen
    </button>
  )

  return (
    <div className="panel-body webview-panel webview-stream" data-panel-body={panelKey}>
      {error && (
        <p className="plugin-panel-error" role="status" title={error}>
          ⚠ {error}
        </p>
      )}
      <WebviewToolbar panelKey={panelKey} title={title} page={page} extra={fitButton} />
      <WebviewLoadError page={page} />
      <div ref={area} className="webview-canvas-area" data-webview={panelKey}>
        {/* No page (never one, or its view went): the last frame must not stay up as if it were live. */}
        <canvas
          ref={canvas}
          className="webview-canvas"
          hidden={!hasPage}
          data-drawn={drawn && hasPage ? 'true' : 'false'}
          aria-label={`${title} page`}
        />
        {!hasPage && (
          <p className="panel-placeholder webview-canvas-note" role="status">
            {hadPage ? `${title}: the page is gone` : `${title} shows nothing yet`}
          </p>
        )}
      </div>
    </div>
  )
}
